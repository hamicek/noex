/**
 * Type definitions for Task module.
 *
 * Task provides supervised async operations with concurrency control,
 * built on top of GenServer and Supervisor primitives.
 */

import type { GenServerRef, SupervisorRef } from './types.js';

/**
 * Internal state of a Task GenServer.
 */
export type TaskState<T> =
  | { readonly status: 'pending'; readonly fn: () => T | Promise<T> }
  | { readonly status: 'running'; readonly fn: () => T | Promise<T> }
  | { readonly status: 'completed'; readonly result: T }
  | { readonly status: 'failed'; readonly error: Error };

/**
 * Internal call message for Task GenServer.
 */
export type TaskCallMsg = { readonly type: 'get_result' };

/**
 * Internal cast message for Task GenServer.
 */
export type TaskCastMsg = { readonly type: 'execute' };

/**
 * A reference to a running Task instance.
 * Tasks are GenServers internally.
 */
export type TaskRef<T> = GenServerRef<TaskState<T>, TaskCallMsg, TaskCastMsg, T>;

/**
 * A reference to a Task Supervisor.
 */
export type TaskSupervisorRef = SupervisorRef;

/**
 * Options for starting a Task Supervisor.
 */
export interface TaskSupervisorOptions {
  /**
   * Optional name for registry registration.
   */
  readonly name?: string;
}

/**
 * Options for Task.await().
 */
export interface TaskAwaitOptions {
  /**
   * Timeout in milliseconds for waiting on the result.
   * If not specified, uses the default call timeout (5000ms).
   */
  readonly timeout?: number;
}

/**
 * Options for Task.Supervisor.asyncStream().
 */
export interface AsyncStreamOptions {
  /**
   * Maximum number of concurrent tasks.
   * @default Infinity (no limit)
   */
  readonly concurrency?: number;

  /**
   * Timeout in milliseconds for each individual task.
   * @default undefined (no timeout)
   */
  readonly timeout?: number;

  /**
   * Whether to return results in the same order as input functions.
   * If false, results are returned in completion order.
   * @default true
   */
  readonly ordered?: boolean;

  /**
   * Whether to continue processing remaining tasks when one fails.
   * If true, failed tasks will have their error captured in StreamResult.
   * If false, processing stops at the first failure.
   * @default false
   */
  readonly onErrorContinue?: boolean;
}

/**
 * Result of a single task in asyncStream when onErrorContinue is true.
 */
export type StreamResult<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'error'; readonly error: Error };

/**
 * Error thrown when a Task times out.
 */
export class TaskTimeoutError extends Error {
  override readonly name = 'TaskTimeoutError' as const;

  constructor(readonly timeoutMs: number) {
    super(`Task timed out after ${timeoutMs}ms`);
  }
}

/**
 * Error thrown when a Task fails during execution.
 */
export class TaskExecutionError extends Error {
  override readonly name = 'TaskExecutionError' as const;
  override readonly cause: Error;

  constructor(cause: Error) {
    super(`Task execution failed: ${cause.message}`);
    this.cause = cause;
  }
}
