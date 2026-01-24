/**
 * GenStateMachine - Finite State Machine built on GenServer.
 *
 * Provides explicit state management with:
 * - State-specific event handlers
 * - State/event/generic timeouts
 * - Event postponing across state transitions
 * - Deferred replies for async response patterns
 *
 * @example
 * ```typescript
 * type State = 'idle' | 'running';
 * type Event = { type: 'start' } | { type: 'stop' };
 * type Data = { count: number };
 *
 * const behavior: StateMachineBehavior<State, Event, Data> = {
 *   init: () => ({ state: 'idle', data: { count: 0 } }),
 *   states: {
 *     idle: {
 *       handleEvent(event, data) {
 *         if (event.type === 'start') {
 *           return { type: 'transition', nextState: 'running', data };
 *         }
 *         return { type: 'keep_state_and_data' };
 *       },
 *     },
 *     running: {
 *       handleEvent(event, data) {
 *         if (event.type === 'stop') {
 *           return { type: 'transition', nextState: 'idle', data };
 *         }
 *         return { type: 'keep_state_and_data' };
 *       },
 *     },
 *   },
 * };
 *
 * const ref = await GenStateMachine.start(behavior);
 * await GenStateMachine.call(ref, { type: 'start' }); // returns 'running'
 * await GenStateMachine.stop(ref);
 * ```
 */

import { GenServer } from './gen-server.js';
import type { GenServerRef, TerminateReason, TimerRef } from './types.js';
import type {
  StateMachineBehavior,
  StateMachineOptions,
  StateMachineRef,
  StateTransitionResult,
  StateMachineAction,
  TimeoutEvent,
  DeferredReply,
} from './gen-state-machine-types.js';

/**
 * Internal call message types.
 */
type CallMsg<E> =
  | { readonly kind: 'event'; readonly event: E }
  | { readonly kind: 'get_state' }
  | { readonly kind: 'get_data' };

/**
 * Internal cast message types.
 */
type CastMsg<E> =
  | { readonly kind: 'event'; readonly event: E; readonly replyId?: string }
  | { readonly kind: 'timeout_fired'; readonly timeoutType: 'state_timeout' | 'event_timeout' | 'generic_timeout'; readonly name?: string; readonly event?: unknown; readonly timerId: string }
  | { readonly kind: 'init_complete' };

/**
 * Pending reply tracking for callWithReply.
 */
interface PendingReply {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  machineId: string;
}

/**
 * Module-level pending replies map for callWithReply.
 */
const pendingRepliesMap = new Map<string, PendingReply>();

/**
 * Postponed event entry.
 */
interface PostponedEntry<E> {
  readonly event: E | TimeoutEvent;
  readonly replyId: string | undefined;
}

/**
 * Internal state maintained by the GenServer.
 */
interface InternalState<S extends string, E, D> {
  currentState: S;
  data: D;
  postponed: PostponedEntry<E>[];
  stateTimerRef: TimerRef | undefined;
  eventTimerRef: TimerRef | undefined;
  genericTimerRefs: Map<string, TimerRef>;
  initActions: readonly StateMachineAction<S>[] | undefined;
}

let timerIdCounter = 0;
function generateTimerId(): string {
  return `gsm_timer_${++timerIdCounter}_${Date.now().toString(36)}`;
}

let replyIdCounter = 0;
function generateReplyId(): string {
  return `gsm_reply_${++replyIdCounter}_${Date.now().toString(36)}`;
}

/**
 * Creates internal behavior wrapper for GenServer.
 */
function createGenServerBehavior<S extends string, E, D>(
  behavior: StateMachineBehavior<S, E, D>,
  selfRefHolder: { ref?: GenServerRef<InternalState<S, E, D>, CallMsg<E>, CastMsg<E>, unknown> },
  machineId: string,
) {
  /**
   * Processes a single event through the state machine.
   * Returns updated internal state.
   */
  function processEvent(
    internalState: InternalState<S, E, D>,
    event: E | TimeoutEvent,
    replyId?: string,
  ): InternalState<S, E, D> {
    const { currentState, data } = internalState;
    const handler = behavior.states[currentState];

    // Build DeferredReply if this is a callWithReply
    const from: DeferredReply | undefined = replyId ? { _id: replyId } : undefined;

    // Call the handler
    const result = handler.handleEvent(event, data, from);

    return applyResult(internalState, result, event, replyId);
  }

  /**
   * Applies a StateTransitionResult to internal state.
   */
  function applyResult(
    internalState: InternalState<S, E, D>,
    result: StateTransitionResult<S, D>,
    event: E | TimeoutEvent,
    replyId?: string,
  ): InternalState<S, E, D> {
    let newState = { ...internalState };

    switch (result.type) {
      case 'transition': {
        const prevState = newState.currentState;
        const nextState = result.nextState;

        // Cancel state timeout on transition
        if (newState.stateTimerRef && selfRefHolder.ref) {
          GenServer.cancelTimer(newState.stateTimerRef);
          newState.stateTimerRef = undefined;
        }

        // Call onExit if defined
        const prevHandler = behavior.states[prevState];
        if (prevHandler.onExit) {
          prevHandler.onExit(newState.data, nextState);
        }

        // Update state and data
        newState.currentState = nextState;
        newState.data = result.data;

        // Call onEnter if defined
        const nextHandler = behavior.states[nextState];
        if (nextHandler.onEnter) {
          nextHandler.onEnter(newState.data, prevState);
        }

        // Process actions
        if (result.actions) {
          newState = processActions(newState, result.actions);
        }

        // Replay postponed events if state changed
        if (prevState !== nextState && newState.postponed.length > 0) {
          newState = replayPostponed(newState);
        }

        break;
      }

      case 'keep_state': {
        newState.data = result.data;
        if (result.actions) {
          newState = processActions(newState, result.actions);
        }
        break;
      }

      case 'keep_state_and_data': {
        if (result.actions) {
          newState = processActions(newState, result.actions);
        }
        break;
      }

      case 'postpone': {
        newState.postponed = [...newState.postponed, { event, replyId }];
        break;
      }

      case 'stop': {
        // Will be handled by the caller
        newState.data = result.data;
        break;
      }
    }

    return newState;
  }

  /**
   * Processes actions emitted by a handler.
   */
  function processActions(
    internalState: InternalState<S, E, D>,
    actions: readonly StateMachineAction<S>[],
  ): InternalState<S, E, D> {
    let newState = { ...internalState };

    for (const action of actions) {
      switch (action.type) {
        case 'state_timeout': {
          // Cancel existing state timeout
          if (newState.stateTimerRef && selfRefHolder.ref) {
            GenServer.cancelTimer(newState.stateTimerRef);
          }
          // Set new state timeout
          if (selfRefHolder.ref) {
            const timerId = generateTimerId();
            newState.stateTimerRef = GenServer.sendAfter(selfRefHolder.ref, {
              kind: 'timeout_fired',
              timeoutType: 'state_timeout',
              event: action.event,
              timerId,
            }, action.time);
          }
          break;
        }

        case 'event_timeout': {
          // Cancel existing event timeout
          if (newState.eventTimerRef && selfRefHolder.ref) {
            GenServer.cancelTimer(newState.eventTimerRef);
          }
          // Set new event timeout
          if (selfRefHolder.ref) {
            const timerId = generateTimerId();
            newState.eventTimerRef = GenServer.sendAfter(selfRefHolder.ref, {
              kind: 'timeout_fired',
              timeoutType: 'event_timeout',
              event: action.event,
              timerId,
            }, action.time);
          }
          break;
        }

        case 'generic_timeout': {
          // Cancel existing generic timeout with same name
          const existing = newState.genericTimerRefs.get(action.name);
          if (existing && selfRefHolder.ref) {
            GenServer.cancelTimer(existing);
          }
          // Set new generic timeout
          if (selfRefHolder.ref) {
            const timerId = generateTimerId();
            const timerRef = GenServer.sendAfter(selfRefHolder.ref, {
              kind: 'timeout_fired',
              timeoutType: 'generic_timeout',
              name: action.name,
              event: action.event,
              timerId,
            }, action.time);
            newState.genericTimerRefs = new Map(newState.genericTimerRefs);
            newState.genericTimerRefs.set(action.name, timerRef);
          }
          break;
        }

        case 'next_event': {
          // Process the next event immediately (recursive)
          newState = processEvent(newState, action.event as E | TimeoutEvent);
          break;
        }

        case 'reply': {
          // Resolve pending reply from module-level map
          const pending = pendingRepliesMap.get(action.to._id);
          if (pending) {
            clearTimeout(pending.timeoutHandle);
            pending.resolve(action.value);
            pendingRepliesMap.delete(action.to._id);
          }
          break;
        }
      }
    }

    return newState;
  }

  /**
   * Replays postponed events after a state transition.
   */
  function replayPostponed(internalState: InternalState<S, E, D>): InternalState<S, E, D> {
    const postponed = internalState.postponed;
    let newState = { ...internalState, postponed: [] as PostponedEntry<E>[] };

    for (const entry of postponed) {
      newState = processEvent(newState, entry.event, entry.replyId);
    }

    return newState;
  }

  return {
    init(): InternalState<S, E, D> {
      const initResult = behavior.init();
      return {
        currentState: initResult.state,
        data: initResult.data,
        postponed: [],
        stateTimerRef: undefined,
        eventTimerRef: undefined,
        genericTimerRefs: new Map(),
        initActions: initResult.actions && initResult.actions.length > 0 ? initResult.actions : undefined,
      };
    },

    handleCall(
      msg: CallMsg<E>,
      state: InternalState<S, E, D>,
    ): readonly [unknown, InternalState<S, E, D>] {
      // Process deferred init actions on first message if ref is now available
      if (state.initActions && selfRefHolder.ref) {
        state = processActions(state, state.initActions);
        state = { ...state, initActions: undefined };
      }

      switch (msg.kind) {
        case 'event': {
          // Cancel event timeout on any event
          if (state.eventTimerRef && selfRefHolder.ref) {
            GenServer.cancelTimer(state.eventTimerRef);
            state = { ...state, eventTimerRef: undefined };
          }

          const newState = processEvent(state, msg.event);
          return [newState.currentState, newState];
        }

        case 'get_state': {
          return [state.currentState, state];
        }

        case 'get_data': {
          return [state.data, state];
        }
      }
    },

    handleCast(
      msg: CastMsg<E>,
      state: InternalState<S, E, D>,
    ): InternalState<S, E, D> {
      // Process deferred init actions on first message if ref is now available
      if (state.initActions && selfRefHolder.ref) {
        state = processActions(state, state.initActions);
        state = { ...state, initActions: undefined };
      }

      switch (msg.kind) {
        case 'event': {
          // Cancel event timeout on any event
          if (state.eventTimerRef && selfRefHolder.ref) {
            GenServer.cancelTimer(state.eventTimerRef);
            state = { ...state, eventTimerRef: undefined };
          }

          return processEvent(state, msg.event, msg.replyId);
        }

        case 'timeout_fired': {
          // Build timeout event
          const timeoutEvent: TimeoutEvent = {
            type: 'timeout',
            timeoutType: msg.timeoutType,
            name: msg.name,
            event: msg.event,
          };

          // Clear the timer reference based on type
          let newState = state;
          if (msg.timeoutType === 'state_timeout') {
            newState = { ...state, stateTimerRef: undefined };
          } else if (msg.timeoutType === 'event_timeout') {
            newState = { ...state, eventTimerRef: undefined };
          } else if (msg.timeoutType === 'generic_timeout' && msg.name) {
            const newRefs = new Map(state.genericTimerRefs);
            newRefs.delete(msg.name);
            newState = { ...state, genericTimerRefs: newRefs };
          }

          return processEvent(newState, timeoutEvent);
        }

        case 'init_complete': {
          // Just return state - init actions already processed above
          return state;
        }
      }
    },

    terminate(reason: TerminateReason, state: InternalState<S, E, D>): void {
      // Cancel all timers
      if (state.stateTimerRef && selfRefHolder.ref) {
        GenServer.cancelTimer(state.stateTimerRef);
      }
      if (state.eventTimerRef && selfRefHolder.ref) {
        GenServer.cancelTimer(state.eventTimerRef);
      }
      for (const timerRef of state.genericTimerRefs.values()) {
        if (selfRefHolder.ref) {
          GenServer.cancelTimer(timerRef);
        }
      }

      // Reject all pending replies for this machine
      for (const [replyId, pending] of pendingRepliesMap) {
        if (pending.machineId === machineId) {
          clearTimeout(pending.timeoutHandle);
          pending.reject(new Error('State machine stopped'));
          pendingRepliesMap.delete(replyId);
        }
      }

      // Call user-defined terminate
      if (behavior.terminate) {
        behavior.terminate(reason, state.currentState, state.data);
      }
    },
  };
}

/**
 * GenStateMachine facade providing a functional API.
 */
export const GenStateMachine = {
  /**
   * Starts a new GenStateMachine with the given behavior.
   *
   * @param behavior - The state machine behavior definition
   * @param options - Optional start options (name, persistence)
   * @returns Reference to the started state machine
   */
  async start<S extends string, E, D>(
    behavior: StateMachineBehavior<S, E, D>,
    options: StateMachineOptions<D> = {},
  ): Promise<StateMachineRef<S, E, D>> {
    const selfRefHolder: { ref?: GenServerRef<InternalState<S, E, D>, CallMsg<E>, CastMsg<E>, unknown> } = {};
    const machineId = `gsm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const genServerBehavior = createGenServerBehavior(behavior, selfRefHolder, machineId);

    const startOptions = options.name !== undefined ? { name: options.name } : {};
    const ref = await GenServer.start(genServerBehavior, startOptions);

    // Store self-reference for timer operations
    selfRefHolder.ref = ref;

    // Send init_complete to trigger processing of any init actions (like timeouts)
    GenServer.cast(ref, { kind: 'init_complete' });

    return {
      _type: 'StateMachineRef',
      id: ref.id,
    } as StateMachineRef<S, E, D>;
  },

  /**
   * Sends an event and waits for processing.
   * Returns the current state after the event is processed.
   *
   * @param ref - Reference to the state machine
   * @param event - The event to send
   * @param timeout - Optional timeout in milliseconds (default: 5000)
   * @returns The current state after processing
   */
  async call<S extends string, E, D>(
    ref: StateMachineRef<S, E, D>,
    event: E,
    timeout?: number,
  ): Promise<S> {
    const genServerRef = { id: ref.id } as GenServerRef<
      InternalState<S, E, D>,
      CallMsg<E>,
      CastMsg<E>,
      S
    >;
    const callOptions = timeout !== undefined ? { timeout } : {};
    return GenServer.call(genServerRef, { kind: 'event', event }, callOptions);
  },

  /**
   * Sends an event and waits for a custom reply via the reply action.
   * The handler must emit a { type: 'reply', to: from, value } action.
   *
   * @param ref - Reference to the state machine
   * @param event - The event to send
   * @param timeout - Optional timeout in milliseconds (default: 5000)
   * @returns The value from the reply action
   */
  async callWithReply<R, S extends string, E, D>(
    ref: StateMachineRef<S, E, D>,
    event: E,
    timeout: number = 5000,
  ): Promise<R> {
    const replyId = generateReplyId();
    const genServerRef = { id: ref.id } as GenServerRef<
      InternalState<S, E, D>,
      CallMsg<E>,
      CastMsg<E>,
      unknown
    >;

    return new Promise<R>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        pendingRepliesMap.delete(replyId);
        reject(new Error(`callWithReply timed out after ${timeout}ms`));
      }, timeout);

      pendingRepliesMap.set(replyId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timeoutHandle,
        machineId: ref.id,
      });

      // Send event as cast with replyId
      GenServer.cast(genServerRef, { kind: 'event', event, replyId });
    });
  },

  /**
   * Sends an event without waiting for processing (fire-and-forget).
   *
   * @param ref - Reference to the state machine
   * @param event - The event to send
   */
  cast<S extends string, E, D>(ref: StateMachineRef<S, E, D>, event: E): void {
    const genServerRef = { id: ref.id } as GenServerRef<
      InternalState<S, E, D>,
      CallMsg<E>,
      CastMsg<E>,
      unknown
    >;
    GenServer.cast(genServerRef, { kind: 'event', event });
  },

  /**
   * Returns the current state of the state machine.
   *
   * @param ref - Reference to the state machine
   * @returns The current state
   */
  async getState<S extends string, E, D>(ref: StateMachineRef<S, E, D>): Promise<S> {
    const genServerRef = { id: ref.id } as GenServerRef<
      InternalState<S, E, D>,
      CallMsg<E>,
      CastMsg<E>,
      S
    >;
    return GenServer.call(genServerRef, { kind: 'get_state' });
  },

  /**
   * Returns the current data of the state machine.
   *
   * @param ref - Reference to the state machine
   * @returns The current data
   */
  async getData<S extends string, E, D>(ref: StateMachineRef<S, E, D>): Promise<D> {
    const genServerRef = { id: ref.id } as GenServerRef<
      InternalState<S, E, D>,
      CallMsg<E>,
      CastMsg<E>,
      D
    >;
    return GenServer.call(genServerRef, { kind: 'get_data' });
  },

  /**
   * Gracefully stops the state machine.
   *
   * @param ref - Reference to the state machine
   * @param reason - Reason for stopping (default: 'normal')
   */
  async stop<S extends string, E, D>(
    ref: StateMachineRef<S, E, D>,
    reason: TerminateReason = 'normal',
  ): Promise<void> {
    const genServerRef = { id: ref.id } as GenServerRef<
      InternalState<S, E, D>,
      CallMsg<E>,
      CastMsg<E>,
      unknown
    >;
    await GenServer.stop(genServerRef, reason);
  },

  /**
   * Checks if the state machine is currently running.
   *
   * @param ref - Reference to check
   * @returns true if running
   */
  isRunning<S extends string, E, D>(ref: StateMachineRef<S, E, D>): boolean {
    const genServerRef = { id: ref.id } as GenServerRef<
      InternalState<S, E, D>,
      CallMsg<E>,
      CastMsg<E>,
      unknown
    >;
    return GenServer.isRunning(genServerRef);
  },

  /**
   * Internal: clears all pending replies and resets counters.
   * Useful for testing.
   *
   * @internal
   */
  _reset(): void {
    for (const pending of pendingRepliesMap.values()) {
      clearTimeout(pending.timeoutHandle);
    }
    pendingRepliesMap.clear();
    timerIdCounter = 0;
    replyIdCounter = 0;
  },
} as const;
