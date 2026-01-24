/**
 * Type definitions for GenStateMachine.
 *
 * GenStateMachine is an explicit finite state machine built on GenServer,
 * supporting state/event/generic timeouts, postpone, and deferred replies.
 */

import type { TerminateReason, StartOptions } from './types.js';

/**
 * Initialization result specifying the initial FSM state and data.
 */
export interface StateMachineInit<S extends string, D> {
  readonly state: S;
  readonly data: D;
  readonly actions?: readonly StateMachineAction<S>[];
}

/**
 * Result of handling an event in a state handler.
 * Determines the transition behavior of the state machine.
 */
export type StateTransitionResult<S extends string, D> =
  | { readonly type: 'transition'; readonly nextState: S; readonly data: D; readonly actions?: readonly StateMachineAction<S>[] }
  | { readonly type: 'keep_state'; readonly data: D; readonly actions?: readonly StateMachineAction<S>[] }
  | { readonly type: 'keep_state_and_data'; readonly actions?: readonly StateMachineAction<S>[] }
  | { readonly type: 'postpone' }
  | { readonly type: 'stop'; readonly reason: TerminateReason; readonly data: D };

/**
 * Actions that can be emitted by event handlers.
 * Processed after a transition result is applied.
 */
export type StateMachineAction<S extends string> =
  | { readonly type: 'state_timeout'; readonly time: number; readonly event?: unknown }
  | { readonly type: 'event_timeout'; readonly time: number; readonly event?: unknown }
  | { readonly type: 'generic_timeout'; readonly name: string; readonly time: number; readonly event?: unknown }
  | { readonly type: 'next_event'; readonly event: unknown }
  | { readonly type: 'reply'; readonly to: DeferredReply; readonly value: unknown };

/**
 * Timeout event delivered to the current state handler when a timer fires.
 */
export interface TimeoutEvent {
  readonly type: 'timeout';
  readonly timeoutType: 'state_timeout' | 'event_timeout' | 'generic_timeout';
  readonly name: string | undefined;
  readonly event: unknown;
}

/**
 * Opaque handle for deferred replies in callWithReply.
 * The handler must use a `reply` action to respond.
 */
export interface DeferredReply {
  readonly _id: string;
}

/**
 * Handler for a single FSM state.
 * Each state in the machine has its own handler instance.
 */
export interface StateHandler<S extends string, E, D> {
  handleEvent(event: E | TimeoutEvent, data: D, from?: DeferredReply): StateTransitionResult<S, D>;
  onEnter?(data: D, previousState: S): void;
  onExit?(data: D, nextState: S): void;
}

/**
 * Complete behavior definition for a GenStateMachine.
 *
 * @typeParam S - String union of all possible FSM states
 * @typeParam E - Union of all possible event types
 * @typeParam D - Type of the state machine's data (mutable context)
 */
export interface StateMachineBehavior<S extends string, E, D> {
  init(): StateMachineInit<S, D>;
  states: { readonly [K in S]: StateHandler<S, E, D> };
  terminate?(reason: TerminateReason, state: S, data: D): void;
}

/**
 * Options for GenStateMachine.start().
 */
export interface StateMachineOptions<D = unknown> {
  readonly name?: string;
  readonly persistence?: StartOptions<D>['persistence'];
}

/**
 * Reference to a running GenStateMachine instance.
 */
export interface StateMachineRef<S extends string = string, E = unknown, D = unknown> {
  readonly _type: 'StateMachineRef';
  readonly id: string;
  readonly _phantom?: {
    readonly state: S;
    readonly event: E;
    readonly data: D;
  };
}
