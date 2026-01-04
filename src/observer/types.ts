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
