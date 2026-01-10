/**
 * Worker GenServer behavior for cluster observer example.
 *
 * A simple stateful worker that processes work items and tracks statistics.
 * Used to generate observable activity across cluster nodes.
 *
 * @module examples/cluster-observer/shared/worker
 */

import type { GenServerBehavior } from 'noex';

// =============================================================================
// Types
// =============================================================================

/**
 * Worker internal state.
 */
export interface WorkerState {
  readonly name: string;
  readonly processedCount: number;
  readonly lastProcessedAt: number | null;
}

/**
 * Synchronous call messages.
 */
export type WorkerCallMsg = { readonly type: 'get_stats' };

/**
 * Asynchronous cast messages.
 */
export type WorkerCastMsg =
  | { readonly type: 'work' }
  | { readonly type: 'reset' };

/**
 * Response to get_stats call.
 */
export interface WorkerStats {
  readonly name: string;
  readonly processed: number;
  readonly lastProcessedAt: number | null;
}

// =============================================================================
// Behavior Factory
// =============================================================================

/**
 * Creates a worker GenServer behavior with the specified name.
 *
 * @param name - Display name for this worker
 * @returns GenServerBehavior for a worker process
 *
 * @example
 * ```typescript
 * const ref = await GenServer.start(createWorkerBehavior('Worker 1'));
 *
 * // Process some work
 * GenServer.cast(ref, { type: 'work' });
 *
 * // Get statistics
 * const stats = await GenServer.call(ref, { type: 'get_stats' });
 * console.log(`${stats.name} processed ${stats.processed} items`);
 * ```
 */
export function createWorkerBehavior(
  name: string,
): GenServerBehavior<WorkerState, WorkerCallMsg, WorkerCastMsg, WorkerStats> {
  return {
    init: (): WorkerState => ({
      name,
      processedCount: 0,
      lastProcessedAt: null,
    }),

    handleCall: (msg, state) => {
      switch (msg.type) {
        case 'get_stats':
          return [
            {
              name: state.name,
              processed: state.processedCount,
              lastProcessedAt: state.lastProcessedAt,
            },
            state,
          ];
      }
    },

    handleCast: (msg, state) => {
      switch (msg.type) {
        case 'work':
          return {
            ...state,
            processedCount: state.processedCount + 1,
            lastProcessedAt: Date.now(),
          };

        case 'reset':
          return {
            ...state,
            processedCount: 0,
            lastProcessedAt: null,
          };
      }
    },
  };
}
