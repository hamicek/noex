/**
 * Type definitions for the distributed counter example.
 *
 * Demonstrates proper TypeScript typing for GenServer behaviors
 * with remote process monitoring in a distributed cluster.
 */

import type { MonitorId, SerializedRef, ProcessDownReason } from 'noex/distribution';

// =============================================================================
// Counter Types
// =============================================================================

/**
 * State of a counter process.
 */
export interface CounterState {
  /** Counter name */
  readonly name: string;

  /** Current value */
  readonly value: number;

  /** Timestamp of last update */
  readonly lastUpdated: number;
}

/**
 * Call messages for Counter.
 */
export type CounterCallMsg =
  | { readonly type: 'get' }
  | { readonly type: 'get_info' };

/**
 * Cast messages for Counter.
 */
export type CounterCastMsg =
  | { readonly type: 'increment'; readonly by?: number }
  | { readonly type: 'decrement'; readonly by?: number }
  | { readonly type: 'set'; readonly value: number };

/**
 * Reply types for Counter calls.
 */
export type CounterCallReply =
  | { readonly value: number }
  | { readonly name: string; readonly value: number; readonly lastUpdated: number };

// =============================================================================
// Counter Watcher Types
// =============================================================================

/**
 * Information about a monitored counter.
 */
export interface WatchedCounter {
  /** Counter name */
  readonly name: string;

  /** Reference to the counter process */
  readonly counterRef: SerializedRef;

  /** Monitor ID for this counter */
  readonly monitorId: MonitorId;

  /** When monitoring started */
  readonly watchedAt: number;

  /** Last known value */
  lastKnownValue: number | null;
}

/**
 * State of the counter watcher process.
 */
export interface CounterWatcherState {
  /** Watched counters by name */
  readonly watched: ReadonlyMap<string, WatchedCounter>;

  /** Callback for watcher events */
  readonly onEvent: ((event: WatcherEvent) => void) | null;
}

/**
 * Events emitted by the counter watcher.
 */
export type WatcherEvent =
  | { readonly type: 'watch_started'; readonly name: string; readonly nodeId: string }
  | { readonly type: 'watch_stopped'; readonly name: string }
  | { readonly type: 'counter_down'; readonly name: string; readonly nodeId: string; readonly reason: ProcessDownReason };

/**
 * Call messages for CounterWatcher.
 */
export type CounterWatcherCallMsg =
  | { readonly type: 'watch'; readonly name: string; readonly counterRef: SerializedRef }
  | { readonly type: 'unwatch'; readonly name: string }
  | { readonly type: 'get_watched' }
  | { readonly type: 'set_event_handler'; readonly handler: (event: WatcherEvent) => void };

/**
 * Cast messages for CounterWatcher.
 */
export type CounterWatcherCastMsg =
  | { readonly type: 'counter_down'; readonly name: string; readonly reason: ProcessDownReason }
  | { readonly type: 'value_updated'; readonly name: string; readonly value: number };

/**
 * Reply types for CounterWatcher calls.
 */
export type CounterWatcherCallReply =
  | { readonly ok: true; readonly monitorId?: MonitorId }
  | { readonly ok: false; readonly error: string }
  | { readonly watched: ReadonlyArray<{ name: string; nodeId: string; lastKnownValue: number | null }> };

// =============================================================================
// Constants
// =============================================================================

/**
 * Behavior names for remote spawning.
 */
export const BEHAVIOR_NAMES = {
  COUNTER: 'distributed-counter:counter',
  COUNTER_WATCHER: 'distributed-counter:watcher',
} as const;
