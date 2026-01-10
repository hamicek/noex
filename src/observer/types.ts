/**
 * Observer-specific types for system introspection and monitoring.
 *
 * These types extend the core types with aggregated views and
 * snapshot capabilities for the Observer module.
 */

import type {
  GenServerStats,
  SupervisorStats,
  ProcessTreeNode,
  MemoryStats,
} from '../core/types.js';

/**
 * Complete snapshot of the system state at a point in time.
 * Provides a consistent view of all running processes.
 */
export interface ObserverSnapshot {
  /** Timestamp when the snapshot was taken */
  readonly timestamp: number;
  /** Statistics for all running GenServers */
  readonly servers: readonly GenServerStats[];
  /** Statistics for all running Supervisors */
  readonly supervisors: readonly SupervisorStats[];
  /** Hierarchical process tree */
  readonly tree: readonly ProcessTreeNode[];
  /** Total number of running processes */
  readonly processCount: number;
  /** Total messages processed across all servers */
  readonly totalMessages: number;
  /** Total restarts across all supervisors */
  readonly totalRestarts: number;
  /** Global memory statistics */
  readonly memoryStats: MemoryStats;
}

/**
 * Handler for Observer events.
 */
export type ObserverEventHandler = (
  event: import('../core/types.js').ObserverEvent,
) => void;

/**
 * Configuration for Observer polling.
 */
export interface PollingConfig {
  /** Interval in milliseconds between stat updates */
  readonly intervalMs: number;
  /** Handler called with each stats update */
  readonly handler: ObserverEventHandler;
}

// =============================================================================
// Alert Types
// =============================================================================

/**
 * Types of alerts that can be triggered by the AlertManager.
 */
export type AlertType = 'high_queue_size' | 'high_memory';

/**
 * Configuration for the AlertManager.
 *
 * The AlertManager uses statistical analysis to determine dynamic thresholds
 * for alerts. Thresholds are calculated as: mean + (sensitivityMultiplier * stddev)
 */
export interface AlertConfig {
  /** Whether alerting is enabled */
  readonly enabled: boolean;
  /**
   * Multiplier for standard deviation in threshold calculation.
   * Higher values = less sensitive (fewer alerts).
   * @default 2.0
   */
  readonly sensitivityMultiplier: number;
  /**
   * Minimum number of samples required before alerts can fire.
   * Prevents false positives during system warmup.
   * @default 30
   */
  readonly minSamples: number;
  /**
   * Cooldown period in milliseconds between alerts for the same process.
   * Prevents alert spam.
   * @default 10000
   */
  readonly cooldownMs: number;
}

/**
 * An active alert indicating a process has exceeded its dynamic threshold.
 */
export interface Alert {
  /** Unique identifier for this alert instance */
  readonly id: string;
  /** Type of condition that triggered the alert */
  readonly type: AlertType;
  /** ID of the process that triggered the alert */
  readonly processId: string;
  /** Optional registered name of the process */
  readonly processName?: string;
  /** The threshold that was exceeded */
  readonly threshold: number;
  /** The current value that exceeded the threshold */
  readonly currentValue: number;
  /** Unix timestamp when the alert was triggered */
  readonly timestamp: number;
  /** Human-readable description of the alert */
  readonly message: string;
}

/**
 * Events emitted by the AlertManager.
 * Discriminated union for type-safe event handling.
 */
export type AlertEvent =
  | { readonly type: 'alert_triggered'; readonly alert: Alert }
  | { readonly type: 'alert_resolved'; readonly alertId: string; readonly processId: string };

/**
 * Handler for AlertManager events.
 */
export type AlertEventHandler = (event: AlertEvent) => void;

// =============================================================================
// Observer Service Types (for remote queries)
// =============================================================================

/**
 * Message types for querying the Observer Service remotely.
 *
 * The Observer Service is a GenServer that runs on each cluster node,
 * exposing the local Observer's data for remote access. This enables
 * the ClusterObserver to aggregate snapshots from all nodes.
 */
export type ObserverServiceCallMessage =
  | { readonly type: 'get_snapshot' }
  | { readonly type: 'get_server_stats' }
  | { readonly type: 'get_supervisor_stats' }
  | { readonly type: 'get_process_tree' }
  | { readonly type: 'get_process_count' };

/**
 * Reply types from the Observer Service.
 *
 * Each reply includes the type discriminator and the corresponding data.
 * Error replies are returned when the Observer is not available.
 */
export type ObserverServiceCallReply =
  | { readonly type: 'snapshot'; readonly data: ObserverSnapshot }
  | { readonly type: 'server_stats'; readonly data: readonly import('../core/types.js').GenServerStats[] }
  | { readonly type: 'supervisor_stats'; readonly data: readonly import('../core/types.js').SupervisorStats[] }
  | { readonly type: 'process_tree'; readonly data: readonly import('../core/types.js').ProcessTreeNode[] }
  | { readonly type: 'process_count'; readonly data: number }
  | { readonly type: 'error'; readonly message: string };
