/**
 * Comprehensive tests for GenStateMachine implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GenServer } from '../../src/core/gen-server.js';
import { GenStateMachine } from '../../src/core/gen-state-machine.js';
import type {
  StateMachineBehavior,
  StateMachineRef,
  StateTransitionResult,
  TimeoutEvent,
  DeferredReply,
} from '../../src/core/gen-state-machine-types.js';

describe('GenStateMachine', () => {
  beforeEach(() => {
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
    GenServer._clearTimers();
    GenStateMachine._reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('start() and basic operations', () => {
    it('starts with initial state and data', async () => {
      type State = 'idle' | 'running';
      type Event = { type: 'start' };
      type Data = { count: number };

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({ state: 'idle', data: { count: 0 } }),
        states: {
          idle: {
            handleEvent: () => ({ type: 'keep_state_and_data' }),
          },
          running: {
            handleEvent: () => ({ type: 'keep_state_and_data' }),
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);
      expect(GenStateMachine.isRunning(ref)).toBe(true);

      const state = await GenStateMachine.getState(ref);
      expect(state).toBe('idle');

      const data = await GenStateMachine.getData(ref);
      expect(data).toEqual({ count: 0 });

      await GenStateMachine.stop(ref);
      expect(GenStateMachine.isRunning(ref)).toBe(false);
    });

    it('supports named registration', async () => {
      type State = 'idle';
      type Event = never;
      type Data = null;

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({ state: 'idle', data: null }),
        states: {
          idle: {
            handleEvent: () => ({ type: 'keep_state_and_data' }),
          },
        },
      };

      const ref = await GenStateMachine.start(behavior, { name: 'test-fsm' });
      expect(GenStateMachine.isRunning(ref)).toBe(true);
      await GenStateMachine.stop(ref);
    });
  });

  describe('call() - state transitions', () => {
    it('transitions between states', async () => {
      type State = 'idle' | 'running' | 'paused';
      type Event = { type: 'start' } | { type: 'pause' } | { type: 'resume' } | { type: 'stop' };
      type Data = { count: number };

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({ state: 'idle', data: { count: 0 } }),
        states: {
          idle: {
            handleEvent(event, data) {
              if (event.type === 'start') {
                return { type: 'transition', nextState: 'running', data };
              }
              return { type: 'keep_state_and_data' };
            },
          },
          running: {
            handleEvent(event, data) {
              if (event.type === 'pause') {
                return { type: 'transition', nextState: 'paused', data };
              }
              if (event.type === 'stop') {
                return { type: 'transition', nextState: 'idle', data };
              }
              return { type: 'keep_state_and_data' };
            },
          },
          paused: {
            handleEvent(event, data) {
              if (event.type === 'resume') {
                return { type: 'transition', nextState: 'running', data };
              }
              if (event.type === 'stop') {
                return { type: 'transition', nextState: 'idle', data };
              }
              return { type: 'keep_state_and_data' };
            },
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);

      expect(await GenStateMachine.call(ref, { type: 'start' })).toBe('running');
      expect(await GenStateMachine.getState(ref)).toBe('running');

      expect(await GenStateMachine.call(ref, { type: 'pause' })).toBe('paused');
      expect(await GenStateMachine.getState(ref)).toBe('paused');

      expect(await GenStateMachine.call(ref, { type: 'resume' })).toBe('running');
      expect(await GenStateMachine.getState(ref)).toBe('running');

      expect(await GenStateMachine.call(ref, { type: 'stop' })).toBe('idle');
      expect(await GenStateMachine.getState(ref)).toBe('idle');

      await GenStateMachine.stop(ref);
    });

    it('updates data during transitions', async () => {
      type State = 'counting';
      type Event = { type: 'increment' } | { type: 'decrement' };
      type Data = { value: number };

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({ state: 'counting', data: { value: 0 } }),
        states: {
          counting: {
            handleEvent(event, data) {
              if (event.type === 'increment') {
                return { type: 'keep_state', data: { value: data.value + 1 } };
              }
              if (event.type === 'decrement') {
                return { type: 'keep_state', data: { value: data.value - 1 } };
              }
              return { type: 'keep_state_and_data' };
            },
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);

      await GenStateMachine.call(ref, { type: 'increment' });
      expect(await GenStateMachine.getData(ref)).toEqual({ value: 1 });

      await GenStateMachine.call(ref, { type: 'increment' });
      await GenStateMachine.call(ref, { type: 'increment' });
      expect(await GenStateMachine.getData(ref)).toEqual({ value: 3 });

      await GenStateMachine.call(ref, { type: 'decrement' });
      expect(await GenStateMachine.getData(ref)).toEqual({ value: 2 });

      await GenStateMachine.stop(ref);
    });
  });

  describe('cast() - fire and forget', () => {
    it('processes cast events asynchronously', async () => {
      type State = 'active';
      type Event = { type: 'tick' };
      type Data = { ticks: number };

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({ state: 'active', data: { ticks: 0 } }),
        states: {
          active: {
            handleEvent(event, data) {
              if (event.type === 'tick') {
                return { type: 'keep_state', data: { ticks: data.ticks + 1 } };
              }
              return { type: 'keep_state_and_data' };
            },
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);

      GenStateMachine.cast(ref, { type: 'tick' });
      GenStateMachine.cast(ref, { type: 'tick' });
      GenStateMachine.cast(ref, { type: 'tick' });

      // Wait for casts to be processed
      await new Promise((r) => setTimeout(r, 50));

      expect(await GenStateMachine.getData(ref)).toEqual({ ticks: 3 });

      await GenStateMachine.stop(ref);
    });
  });

  describe('onEnter/onExit callbacks', () => {
    it('calls onEnter when entering a state', async () => {
      type State = 'a' | 'b';
      type Event = { type: 'go' };
      type Data = { log: string[] };

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({ state: 'a', data: { log: [] } }),
        states: {
          a: {
            handleEvent(event, data) {
              if (event.type === 'go') {
                return { type: 'transition', nextState: 'b', data };
              }
              return { type: 'keep_state_and_data' };
            },
          },
          b: {
            onEnter(data, previousState) {
              data.log.push(`entered b from ${previousState}`);
            },
            handleEvent() {
              return { type: 'keep_state_and_data' };
            },
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);
      await GenStateMachine.call(ref, { type: 'go' });

      const data = await GenStateMachine.getData(ref);
      expect(data.log).toContain('entered b from a');

      await GenStateMachine.stop(ref);
    });

    it('calls onExit when leaving a state', async () => {
      type State = 'a' | 'b';
      type Event = { type: 'go' };
      type Data = { log: string[] };

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({ state: 'a', data: { log: [] } }),
        states: {
          a: {
            onExit(data, nextState) {
              data.log.push(`exiting a to ${nextState}`);
            },
            handleEvent(event, data) {
              if (event.type === 'go') {
                return { type: 'transition', nextState: 'b', data };
              }
              return { type: 'keep_state_and_data' };
            },
          },
          b: {
            handleEvent() {
              return { type: 'keep_state_and_data' };
            },
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);
      await GenStateMachine.call(ref, { type: 'go' });

      const data = await GenStateMachine.getData(ref);
      expect(data.log).toContain('exiting a to b');

      await GenStateMachine.stop(ref);
    });
  });

  describe('postpone', () => {
    it('postpones events and replays them on state change', async () => {
      type State = 'waiting' | 'ready';
      type Event = { type: 'process'; value: number } | { type: 'activate' };
      type Data = { processed: number[] };

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({ state: 'waiting', data: { processed: [] } }),
        states: {
          waiting: {
            handleEvent(event, data) {
              if (event.type === 'activate') {
                return { type: 'transition', nextState: 'ready', data };
              }
              if (event.type === 'process') {
                return { type: 'postpone' };
              }
              return { type: 'keep_state_and_data' };
            },
          },
          ready: {
            handleEvent(event, data) {
              if (event.type === 'process') {
                return {
                  type: 'keep_state',
                  data: { processed: [...data.processed, event.value] },
                };
              }
              return { type: 'keep_state_and_data' };
            },
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);

      // Send process events while in 'waiting' state - they will be postponed
      GenStateMachine.cast(ref, { type: 'process', value: 1 });
      GenStateMachine.cast(ref, { type: 'process', value: 2 });
      GenStateMachine.cast(ref, { type: 'process', value: 3 });

      await new Promise((r) => setTimeout(r, 20));

      // Nothing processed yet
      expect(await GenStateMachine.getData(ref)).toEqual({ processed: [] });

      // Activate - this should trigger replay of postponed events
      await GenStateMachine.call(ref, { type: 'activate' });

      const data = await GenStateMachine.getData(ref);
      expect(data.processed).toEqual([1, 2, 3]);

      await GenStateMachine.stop(ref);
    });
  });

  describe('state_timeout', () => {
    it('fires state timeout after specified time', async () => {
      vi.useFakeTimers();

      type State = 'idle' | 'active';
      type Event = { type: 'activate' };
      type Data = { timedOut: boolean };

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({ state: 'idle', data: { timedOut: false } }),
        states: {
          idle: {
            handleEvent(event, data) {
              if (event.type === 'activate') {
                return {
                  type: 'transition',
                  nextState: 'active',
                  data,
                  actions: [{ type: 'state_timeout', time: 100 }],
                };
              }
              return { type: 'keep_state_and_data' };
            },
          },
          active: {
            handleEvent(event, data) {
              if ((event as TimeoutEvent).type === 'timeout') {
                return { type: 'transition', nextState: 'idle', data: { timedOut: true } };
              }
              return { type: 'keep_state_and_data' };
            },
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);
      await GenStateMachine.call(ref, { type: 'activate' });

      expect(await GenStateMachine.getState(ref)).toBe('active');
      expect((await GenStateMachine.getData(ref)).timedOut).toBe(false);

      // Advance time
      await vi.advanceTimersByTimeAsync(150);

      expect(await GenStateMachine.getState(ref)).toBe('idle');
      expect((await GenStateMachine.getData(ref)).timedOut).toBe(true);

      await GenStateMachine.stop(ref);
    });

    it('cancels state timeout on state transition', async () => {
      vi.useFakeTimers();

      type State = 'a' | 'b';
      type Event = { type: 'go' };
      type Data = { timeouts: number };

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({
          state: 'a',
          data: { timeouts: 0 },
          actions: [{ type: 'state_timeout', time: 100 }],
        }),
        states: {
          a: {
            handleEvent(event, data) {
              if (event.type === 'go') {
                return { type: 'transition', nextState: 'b', data };
              }
              if ((event as TimeoutEvent).type === 'timeout') {
                return { type: 'keep_state', data: { timeouts: data.timeouts + 1 } };
              }
              return { type: 'keep_state_and_data' };
            },
          },
          b: {
            handleEvent(event, data) {
              if ((event as TimeoutEvent).type === 'timeout') {
                return { type: 'keep_state', data: { timeouts: data.timeouts + 1 } };
              }
              return { type: 'keep_state_and_data' };
            },
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);

      // Transition before timeout fires
      await vi.advanceTimersByTimeAsync(50);
      await GenStateMachine.call(ref, { type: 'go' });

      // Let the original timeout time pass
      await vi.advanceTimersByTimeAsync(100);

      // Timeout should not have fired because we transitioned
      expect((await GenStateMachine.getData(ref)).timeouts).toBe(0);

      await GenStateMachine.stop(ref);
    });
  });

  describe('event_timeout', () => {
    it('fires event timeout when no events received', async () => {
      vi.useFakeTimers();

      type State = 'waiting';
      type Event = { type: 'ping' };
      type Data = { idleCount: number };

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({
          state: 'waiting',
          data: { idleCount: 0 },
          actions: [{ type: 'event_timeout', time: 100 }],
        }),
        states: {
          waiting: {
            handleEvent(event, data) {
              if ((event as TimeoutEvent).type === 'timeout') {
                return {
                  type: 'keep_state',
                  data: { idleCount: data.idleCount + 1 },
                  actions: [{ type: 'event_timeout', time: 100 }],
                };
              }
              // Any other event resets the timeout
              return {
                type: 'keep_state_and_data',
                actions: [{ type: 'event_timeout', time: 100 }],
              };
            },
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);

      // Let timeout fire
      await vi.advanceTimersByTimeAsync(150);
      expect((await GenStateMachine.getData(ref)).idleCount).toBe(1);

      // Send an event to reset timeout
      await GenStateMachine.call(ref, { type: 'ping' });

      // Timeout should not fire yet
      await vi.advanceTimersByTimeAsync(50);
      expect((await GenStateMachine.getData(ref)).idleCount).toBe(1);

      // Now let it fire
      await vi.advanceTimersByTimeAsync(100);
      expect((await GenStateMachine.getData(ref)).idleCount).toBe(2);

      await GenStateMachine.stop(ref);
    });
  });

  describe('generic_timeout', () => {
    it('supports named generic timeouts', async () => {
      vi.useFakeTimers();

      type State = 'active';
      type Event = { type: 'start_timer'; name: string; time: number };
      type Data = { firedTimers: string[] };

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({ state: 'active', data: { firedTimers: [] } }),
        states: {
          active: {
            handleEvent(event, data) {
              if (event.type === 'start_timer') {
                return {
                  type: 'keep_state_and_data',
                  actions: [{ type: 'generic_timeout', name: event.name, time: event.time }],
                };
              }
              if ((event as TimeoutEvent).type === 'timeout') {
                const te = event as TimeoutEvent;
                if (te.timeoutType === 'generic_timeout' && te.name) {
                  return {
                    type: 'keep_state',
                    data: { firedTimers: [...data.firedTimers, te.name] },
                  };
                }
              }
              return { type: 'keep_state_and_data' };
            },
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);

      await GenStateMachine.call(ref, { type: 'start_timer', name: 'timer_a', time: 100 });
      await GenStateMachine.call(ref, { type: 'start_timer', name: 'timer_b', time: 200 });

      await vi.advanceTimersByTimeAsync(150);
      expect((await GenStateMachine.getData(ref)).firedTimers).toEqual(['timer_a']);

      await vi.advanceTimersByTimeAsync(100);
      expect((await GenStateMachine.getData(ref)).firedTimers).toEqual(['timer_a', 'timer_b']);

      await GenStateMachine.stop(ref);
    });

    it('survives state transitions', async () => {
      vi.useFakeTimers();

      type State = 'a' | 'b';
      type Event = { type: 'go' };
      type Data = { fired: boolean };

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({
          state: 'a',
          data: { fired: false },
          actions: [{ type: 'generic_timeout', name: 'persistent', time: 100 }],
        }),
        states: {
          a: {
            handleEvent(event, data) {
              if (event.type === 'go') {
                return { type: 'transition', nextState: 'b', data };
              }
              return { type: 'keep_state_and_data' };
            },
          },
          b: {
            handleEvent(event, data) {
              if ((event as TimeoutEvent).type === 'timeout') {
                return { type: 'keep_state', data: { fired: true } };
              }
              return { type: 'keep_state_and_data' };
            },
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);

      // Transition before timeout
      await vi.advanceTimersByTimeAsync(50);
      await GenStateMachine.call(ref, { type: 'go' });
      expect(await GenStateMachine.getState(ref)).toBe('b');

      // Timeout should still fire in state b
      await vi.advanceTimersByTimeAsync(100);
      expect((await GenStateMachine.getData(ref)).fired).toBe(true);

      await GenStateMachine.stop(ref);
    });
  });

  describe('next_event action', () => {
    it('processes next_event immediately', async () => {
      type State = 'start' | 'middle' | 'end';
      type Event = { type: 'begin' } | { type: 'continue' } | { type: 'finish' };
      type Data = { path: string[] };

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({ state: 'start', data: { path: [] } }),
        states: {
          start: {
            handleEvent(event, data) {
              if (event.type === 'begin') {
                return {
                  type: 'transition',
                  nextState: 'middle',
                  data: { path: [...data.path, 'start'] },
                  actions: [{ type: 'next_event', event: { type: 'continue' } }],
                };
              }
              return { type: 'keep_state_and_data' };
            },
          },
          middle: {
            handleEvent(event, data) {
              if (event.type === 'continue') {
                return {
                  type: 'transition',
                  nextState: 'end',
                  data: { path: [...data.path, 'middle'] },
                  actions: [{ type: 'next_event', event: { type: 'finish' } }],
                };
              }
              return { type: 'keep_state_and_data' };
            },
          },
          end: {
            handleEvent(event, data) {
              if (event.type === 'finish') {
                return {
                  type: 'keep_state',
                  data: { path: [...data.path, 'end'] },
                };
              }
              return { type: 'keep_state_and_data' };
            },
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);

      // Single call should trigger chain of next_event
      await GenStateMachine.call(ref, { type: 'begin' });

      expect(await GenStateMachine.getState(ref)).toBe('end');
      expect((await GenStateMachine.getData(ref)).path).toEqual(['start', 'middle', 'end']);

      await GenStateMachine.stop(ref);
    });
  });

  describe('callWithReply()', () => {
    it('returns custom reply value', async () => {
      type State = 'active';
      type Event = { type: 'query'; n: number };
      type Data = null;

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({ state: 'active', data: null }),
        states: {
          active: {
            handleEvent(event, _data, from) {
              if (event.type === 'query' && from) {
                return {
                  type: 'keep_state_and_data',
                  actions: [{ type: 'reply', to: from, value: event.n * 2 }],
                };
              }
              return { type: 'keep_state_and_data' };
            },
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);

      const result = await GenStateMachine.callWithReply<number, State, Event, Data>(
        ref,
        { type: 'query', n: 21 },
      );
      expect(result).toBe(42);

      await GenStateMachine.stop(ref);
    });

    it('times out if no reply action', async () => {
      type State = 'active';
      type Event = { type: 'no_reply' };
      type Data = null;

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({ state: 'active', data: null }),
        states: {
          active: {
            handleEvent() {
              // No reply action!
              return { type: 'keep_state_and_data' };
            },
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);

      await expect(
        GenStateMachine.callWithReply<void, State, Event, Data>(ref, { type: 'no_reply' }, 100),
      ).rejects.toThrow('callWithReply timed out after 100ms');

      await GenStateMachine.stop(ref);
    });
  });

  describe('terminate callback', () => {
    it('calls terminate on stop', async () => {
      type State = 'active';
      type Event = never;
      type Data = { terminated: boolean };

      let terminatedWith: { reason: string; state: State; data: Data } | null = null;

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({ state: 'active', data: { terminated: false } }),
        states: {
          active: {
            handleEvent() {
              return { type: 'keep_state_and_data' };
            },
          },
        },
        terminate(reason, state, data) {
          terminatedWith = { reason: String(reason), state, data };
        },
      };

      const ref = await GenStateMachine.start(behavior);
      await GenStateMachine.stop(ref);

      expect(terminatedWith).not.toBeNull();
      expect(terminatedWith!.reason).toBe('normal');
      expect(terminatedWith!.state).toBe('active');
    });
  });

  describe('timeout event payload', () => {
    it('passes event payload through timeout', async () => {
      vi.useFakeTimers();

      type State = 'waiting';
      type Event = { type: 'start' };
      type Data = { receivedPayload: unknown };

      const behavior: StateMachineBehavior<State, Event, Data> = {
        init: () => ({ state: 'waiting', data: { receivedPayload: null } }),
        states: {
          waiting: {
            handleEvent(event, data) {
              if (event.type === 'start') {
                return {
                  type: 'keep_state_and_data',
                  actions: [{ type: 'state_timeout', time: 100, event: { custom: 'payload' } }],
                };
              }
              if ((event as TimeoutEvent).type === 'timeout') {
                return {
                  type: 'keep_state',
                  data: { receivedPayload: (event as TimeoutEvent).event },
                };
              }
              return { type: 'keep_state_and_data' };
            },
          },
        },
      };

      const ref = await GenStateMachine.start(behavior);
      await GenStateMachine.call(ref, { type: 'start' });

      await vi.advanceTimersByTimeAsync(150);

      const data = await GenStateMachine.getData(ref);
      expect(data.receivedPayload).toEqual({ custom: 'payload' });

      await GenStateMachine.stop(ref);
    });
  });
});
