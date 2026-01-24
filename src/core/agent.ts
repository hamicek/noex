/**
 * Agent - A simplified state container built on GenServer.
 *
 * Provides a minimal API for managing shared state without the
 * complexity of defining a full GenServerBehavior. Wraps GenServer
 * internally, so Agents work seamlessly under Supervisors with
 * persistence, lifecycle events, and all other GenServer features.
 *
 * @example
 * ```typescript
 * const counter = await Agent.start(() => 0);
 * await Agent.update(counter, n => n + 1);
 * const value = await Agent.get(counter, n => n); // 1
 * await Agent.stop(counter);
 * ```
 */

import { GenServer } from './gen-server.js';
import type { GenServerRef, StartOptions } from './types.js';

/**
 * Internal call message types for Agent's GenServer.
 */
type AgentCallMsg<T> =
  | { readonly type: 'get'; readonly fn: (state: T) => unknown }
  | { readonly type: 'update'; readonly fn: (state: T) => T }
  | { readonly type: 'get_and_update'; readonly fn: (state: T) => readonly [unknown, T] };

/**
 * Internal cast message type for Agent's GenServer.
 */
type AgentCastMsg<T> = {
  readonly type: 'cast_update';
  readonly fn: (state: T) => T;
};

/**
 * A reference to a running Agent instance.
 */
export type AgentRef<T> = GenServerRef<T, AgentCallMsg<T>, AgentCastMsg<T>, unknown>;

/**
 * Options for Agent.start().
 * Passes through to GenServer.start() options.
 */
export interface AgentOptions<T> {
  readonly name?: string;
  readonly persistence?: StartOptions<T>['persistence'];
}

/**
 * Agent facade providing a functional API over GenServer.
 */
export const Agent = {
  /**
   * Starts a new Agent with the given initial state factory.
   *
   * @param initializer - Function that returns the initial state
   * @param options - Optional start options (name, persistence)
   * @returns Reference to the started Agent
   */
  async start<T>(
    initializer: () => T | Promise<T>,
    options: AgentOptions<T> = {},
  ): Promise<AgentRef<T>> {
    const startOptions: StartOptions<T> = {
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.persistence !== undefined ? { persistence: options.persistence } : {}),
    };

    return GenServer.start<T, AgentCallMsg<T>, AgentCastMsg<T>, unknown>(
      {
        init: initializer,
        handleCall(msg, state) {
          switch (msg.type) {
            case 'get':
              return [msg.fn(state), state];
            case 'update': {
              const newState = msg.fn(state);
              return [undefined, newState];
            }
            case 'get_and_update': {
              const [result, newState] = msg.fn(state);
              return [result, newState];
            }
          }
        },
        handleCast(msg, state) {
          return msg.fn(state);
        },
      },
      startOptions,
    );
  },

  /**
   * Retrieves a value derived from the Agent's state.
   *
   * @param ref - Reference to the Agent
   * @param fn - Function that extracts a value from the state
   * @returns The value returned by fn
   */
  async get<T, R>(ref: AgentRef<T>, fn: (state: T) => R): Promise<R> {
    return GenServer.call(ref, { type: 'get', fn }) as Promise<R>;
  },

  /**
   * Updates the Agent's state using the given function.
   *
   * @param ref - Reference to the Agent
   * @param fn - Function that transforms the current state into the new state
   */
  async update<T>(ref: AgentRef<T>, fn: (state: T) => T): Promise<void> {
    await GenServer.call(ref, { type: 'update', fn });
  },

  /**
   * Updates the Agent's state asynchronously (fire-and-forget).
   * Does not wait for the update to be processed.
   *
   * @param ref - Reference to the Agent
   * @param fn - Function that transforms the current state into the new state
   */
  castUpdate<T>(ref: AgentRef<T>, fn: (state: T) => T): void {
    GenServer.cast(ref, { type: 'cast_update', fn });
  },

  /**
   * Atomically retrieves a value and updates the state.
   * The function returns a tuple of [returnValue, newState].
   *
   * @param ref - Reference to the Agent
   * @param fn - Function that returns [valueToReturn, newState]
   * @returns The first element of the tuple returned by fn
   */
  async getAndUpdate<T, R>(
    ref: AgentRef<T>,
    fn: (state: T) => readonly [R, T],
  ): Promise<R> {
    return GenServer.call(ref, { type: 'get_and_update', fn }) as Promise<R>;
  },

  /**
   * Stops the Agent gracefully.
   *
   * @param ref - Reference to the Agent to stop
   */
  async stop<T>(ref: AgentRef<T>): Promise<void> {
    await GenServer.stop(ref);
  },
} as const;
