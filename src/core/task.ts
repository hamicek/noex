/**
 * Task - Supervised async operations with concurrency control.
 *
 * Provides an Elixir-style Task abstraction built on GenServer and Supervisor:
 * - Standalone async tasks with await/timeout support
 * - Supervised task pools for fault-tolerant concurrent processing
 * - Stream processing with configurable concurrency limits
 *
 * @example
 * ```typescript
 * // Standalone task
 * const ref = await Task.async(async () => fetchData());
 * const result = await Task.await(ref);
 *
 * // Supervised tasks
 * const sup = await Task.Supervisor.start({ name: 'workers' });
 * const ref = await Task.Supervisor.async(sup, async () => heavyWork());
 * const result = await Task.await(ref);
 *
 * // Concurrent stream processing
 * const results = await Task.Supervisor.asyncStream(
 *   sup,
 *   urls.map(url => async () => fetch(url)),
 *   { concurrency: 5 }
 * );
 * ```
 */

import { GenServer } from './gen-server.js';
import { Supervisor } from './supervisor.js';
import type { GenServerBehavior, CallResult } from './types.js';
import {
  type TaskRef,
  type TaskCallMsg,
  type TaskCastMsg,
  type TaskSupervisorRef,
  type TaskSupervisorOptions,
  type TaskAwaitOptions,
  type AsyncStreamOptions,
  type StreamResult,
  TaskTimeoutError,
  TaskExecutionError,
} from './task-types.js';

/**
 * Internal state for task execution tracking.
 */
interface TaskExecutionState<T> {
  result: T | undefined;
  error: Error | undefined;
  completed: boolean;
  started: boolean;
  waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: Error) => void;
  }>;
}

/**
 * Internal: Creates a self-executing task that runs immediately upon creation.
 *
 * Uses a waiter-based approach to avoid unhandled promise rejections.
 * When the task completes (success or failure), all waiting callers
 * are notified through their registered resolve/reject callbacks.
 */
async function createTask<T>(fn: () => T | Promise<T>): Promise<TaskRef<T>> {
  // Shared execution state - captured in closure
  const execState: TaskExecutionState<T> = {
    result: undefined,
    error: undefined,
    completed: false,
    started: false,
    waiters: [],
  };

  const behavior: GenServerBehavior<{ initialized: boolean }, TaskCallMsg, TaskCastMsg, T> = {
    init: () => ({ initialized: true }),

    handleCall(msg, state) {
      if (msg.type === 'get_result') {
        // If already completed, return immediately
        if (execState.completed) {
          if (execState.error) {
            throw new TaskExecutionError(execState.error);
          }
          return [execState.result as T, state];
        }

        // Not yet completed - return a promise that will be resolved
        // when the task completes
        return new Promise<CallResult<T, { initialized: boolean }>>((resolve, reject) => {
          execState.waiters.push({
            resolve: (value: T) => resolve([value, state]),
            reject: (error: Error) => reject(new TaskExecutionError(error)),
          });
        });
      }
      throw new Error(`Unknown call message type`);
    },

    handleCast(msg, state) {
      if (msg.type === 'execute' && !execState.started) {
        execState.started = true;

        // Execute the task asynchronously
        void (async () => {
          try {
            const result = await Promise.resolve(fn());
            execState.result = result;
            execState.completed = true;

            // Notify all waiters of success
            for (const waiter of execState.waiters) {
              waiter.resolve(result);
            }
            execState.waiters.length = 0;
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            execState.error = err;
            execState.completed = true;

            // Notify all waiters of failure
            for (const waiter of execState.waiters) {
              waiter.reject(err);
            }
            execState.waiters.length = 0;
          }
        })();
      }
      return state;
    },
  };

  const ref = await GenServer.start(behavior);

  // Trigger execution immediately
  GenServer.cast(ref, { type: 'execute' });

  return ref as unknown as TaskRef<T>;
}

/**
 * Task facade providing async task management.
 */
export const Task = {
  /**
   * Creates and starts a new async task.
   * The task begins execution immediately.
   *
   * @param fn - The async function to execute
   * @returns Reference to the running task
   *
   * @example
   * ```typescript
   * const task = await Task.async(async () => {
   *   const response = await fetch('https://api.example.com/data');
   *   return response.json();
   * });
   * const data = await Task.await(task);
   * ```
   */
  async async<T>(fn: () => T | Promise<T>): Promise<TaskRef<T>> {
    return createTask(fn);
  },

  /**
   * Waits for a task to complete and returns its result.
   *
   * @param ref - Reference to the task
   * @param options - Await options (timeout)
   * @returns The task result
   * @throws {TaskExecutionError} If the task failed
   * @throws {TaskTimeoutError} If the task times out
   *
   * @example
   * ```typescript
   * const result = await Task.await(task, { timeout: 5000 });
   * ```
   */
  async await<T>(ref: TaskRef<T>, options: TaskAwaitOptions = {}): Promise<T> {
    const timeout = options.timeout;

    if (timeout !== undefined) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new TaskTimeoutError(timeout)), timeout);
      });

      return Promise.race([
        GenServer.call(ref, { type: 'get_result' }, { timeout }) as Promise<T>,
        timeoutPromise,
      ]);
    }

    return GenServer.call(ref, { type: 'get_result' }) as Promise<T>;
  },

  /**
   * Yields the result of a completed task without blocking.
   * Returns undefined if the task is still running.
   *
   * @param ref - Reference to the task
   * @returns The task result or undefined if not yet complete
   *
   * @example
   * ```typescript
   * const result = await Task.yield(task);
   * if (result !== undefined) {
   *   console.log('Task completed:', result);
   * }
   * ```
   */
  async yield<T>(ref: TaskRef<T>): Promise<T | undefined> {
    try {
      // Use a very short timeout to check if result is available
      return await GenServer.call(ref, { type: 'get_result' }, { timeout: 10 }) as T;
    } catch {
      // Task not yet complete or timed out
      return undefined;
    }
  },

  /**
   * Shuts down a task. If the task is still running, it will be terminated.
   *
   * @param ref - Reference to the task to shutdown
   */
  async shutdown<T>(ref: TaskRef<T>): Promise<void> {
    await GenServer.stop(ref);
  },

  /**
   * Task.Supervisor provides supervised task execution with fault tolerance.
   */
  Supervisor: {
    /**
     * Starts a new Task Supervisor.
     *
     * @param options - Supervisor options
     * @returns Reference to the started supervisor
     *
     * @example
     * ```typescript
     * const sup = await Task.Supervisor.start({ name: 'workers' });
     * ```
     */
    async start(options: TaskSupervisorOptions = {}): Promise<TaskSupervisorRef> {
      return Supervisor.start({
        strategy: 'simple_one_for_one',
        childTemplate: {
          start: async (...args: unknown[]) => {
            // First argument is the function to execute
            const fn = args[0] as () => unknown;
            return createTask(fn) as Promise<TaskRef<unknown>> as unknown as ReturnType<typeof GenServer.start>;
          },
          restart: 'temporary', // Tasks don't restart on failure
        },
        ...(options.name !== undefined ? { name: options.name } : {}),
      });
    },

    /**
     * Starts a new async task under the supervisor.
     *
     * @param sup - Reference to the supervisor
     * @param fn - The async function to execute
     * @returns Reference to the started task
     *
     * @example
     * ```typescript
     * const task = await Task.Supervisor.async(sup, async () => heavyWork());
     * ```
     */
    async async<T>(sup: TaskSupervisorRef, fn: () => T | Promise<T>): Promise<TaskRef<T>> {
      const ref = await Supervisor.startChild(sup, [fn]);
      return ref as unknown as TaskRef<T>;
    },

    /**
     * Executes multiple async functions concurrently with controlled parallelism.
     *
     * @param sup - Reference to the supervisor
     * @param fns - Array of async functions to execute
     * @param options - Stream options (concurrency, timeout, ordered)
     * @returns Array of results (in order if ordered=true)
     *
     * @example
     * ```typescript
     * const results = await Task.Supervisor.asyncStream(
     *   sup,
     *   urls.map(url => async () => fetch(url).then(r => r.json())),
     *   { concurrency: 5 }
     * );
     * ```
     */
    async asyncStream<T>(
      sup: TaskSupervisorRef,
      fns: ReadonlyArray<() => T | Promise<T>>,
      options: AsyncStreamOptions = {},
    ): Promise<T[]> {
      const {
        concurrency = Infinity,
        timeout,
        ordered = true,
        onErrorContinue = false,
      } = options;

      if (fns.length === 0) {
        return [];
      }

      const results: (T | Error)[] = new Array(fns.length);
      const pending = new Set<number>();
      let nextIndex = 0;
      let completedCount = 0;
      let firstError: Error | undefined;

      return new Promise((resolve, reject) => {
        const startNext = async () => {
          // Check if we should stop
          if (!onErrorContinue && firstError) {
            return;
          }

          // Check if all tasks are started
          if (nextIndex >= fns.length) {
            return;
          }

          // Check concurrency limit
          if (pending.size >= concurrency) {
            return;
          }

          const index = nextIndex++;
          pending.add(index);

          try {
            const task = await this.async(sup, fns[index]!);
            const awaitOptions: TaskAwaitOptions = timeout !== undefined ? { timeout } : {};
            const result = await Task.await(task, awaitOptions);
            results[index] = result;
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            if (onErrorContinue) {
              results[index] = err;
            } else {
              firstError = err;
              pending.delete(index);
              reject(err);
              return;
            }
          }

          pending.delete(index);
          completedCount++;

          // Check if all done
          if (completedCount === fns.length) {
            if (onErrorContinue) {
              // Filter errors and return StreamResult format
              resolve(results as T[]);
            } else {
              resolve(results as T[]);
            }
            return;
          }

          // Start more tasks
          void startNext();
        };

        // Start initial batch
        const initialBatch = Math.min(concurrency, fns.length);
        for (let i = 0; i < initialBatch; i++) {
          void startNext();
        }
      });
    },

    /**
     * Executes multiple async functions concurrently and returns StreamResult for each.
     * This variant captures errors per-task instead of failing fast.
     *
     * @param sup - Reference to the supervisor
     * @param fns - Array of async functions to execute
     * @param options - Stream options (concurrency, timeout, ordered)
     * @returns Array of StreamResult (ok/error) for each function
     *
     * @example
     * ```typescript
     * const results = await Task.Supervisor.asyncStreamSettled(
     *   sup,
     *   urls.map(url => async () => fetch(url).then(r => r.json())),
     *   { concurrency: 5 }
     * );
     * results.forEach((r, i) => {
     *   if (r.status === 'ok') console.log(`URL ${i}: ${r.value}`);
     *   else console.log(`URL ${i} failed: ${r.error.message}`);
     * });
     * ```
     */
    async asyncStreamSettled<T>(
      sup: TaskSupervisorRef,
      fns: ReadonlyArray<() => T | Promise<T>>,
      options: Omit<AsyncStreamOptions, 'onErrorContinue'> = {},
    ): Promise<StreamResult<T>[]> {
      const {
        concurrency = Infinity,
        timeout,
        ordered = true,
      } = options;

      if (fns.length === 0) {
        return [];
      }

      const results: StreamResult<T>[] = new Array(fns.length);
      const pending = new Set<number>();
      let nextIndex = 0;
      let completedCount = 0;

      return new Promise((resolve) => {
        const startNext = async () => {
          // Check if all tasks are started
          if (nextIndex >= fns.length) {
            return;
          }

          // Check concurrency limit
          if (pending.size >= concurrency) {
            return;
          }

          const index = nextIndex++;
          pending.add(index);

          try {
            const task = await this.async(sup, fns[index]!);
            const awaitOptions: TaskAwaitOptions = timeout !== undefined ? { timeout } : {};
            const result = await Task.await(task, awaitOptions);
            results[index] = { status: 'ok', value: result };
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            results[index] = { status: 'error', error: err };
          }

          pending.delete(index);
          completedCount++;

          // Check if all done
          if (completedCount === fns.length) {
            resolve(results);
            return;
          }

          // Start more tasks
          void startNext();
        };

        // Start initial batch
        const initialBatch = Math.min(concurrency, fns.length);
        for (let i = 0; i < initialBatch; i++) {
          void startNext();
        }
      });
    },

    /**
     * Stops all tasks under the supervisor.
     *
     * @param sup - Reference to the supervisor
     */
    async stop(sup: TaskSupervisorRef): Promise<void> {
      await Supervisor.stop(sup);
    },
  },
} as const;
