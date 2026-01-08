/**
 * Type definitions for distributed supervision in noex.
 *
 * This module defines types for DistributedSupervisor - a supervisor capable
 * of spawning and managing child processes across multiple cluster nodes,
 * with automatic failover when nodes go down.
 *
 * @module distribution/supervisor/types
 */

import type { NodeId } from '../node-id.js';
import type { NodeInfo } from '../types.js';
import type { GenServerRef, ChildRestartStrategy, RestartIntensity, SupervisorStrategy, MonitorRef } from '../../core/types.js';

// =============================================================================
// Node Selection
// =============================================================================

/**
 * Built-in node selection strategies for placing child processes.
 *
 * - `'local_first'`: Prefer the local node, fallback to connected nodes (default)
 * - `'round_robin'`: Rotate through available nodes in sequence
 * - `'least_loaded'`: Select the node with the lowest process count
 * - `'random'`: Random selection from available nodes
 */
export type NodeSelectorType = 'local_first' | 'round_robin' | 'least_loaded' | 'random';

/**
 * Custom node selection function.
 *
 * Called when selecting a node for spawning or restarting a child process.
 * Receives the list of currently available nodes and the child identifier.
 *
 * @param nodes - Array of connected nodes with their current state
 * @param childId - Identifier of the child being placed
 * @returns The selected node identifier
 *
 * @example
 * ```typescript
 * // Custom selector that prefers nodes with specific naming pattern
 * const workerNodeSelector: NodeSelectorFn = (nodes, childId) => {
 *   const workerNodes = nodes.filter(n => n.id.startsWith('worker'));
 *   if (workerNodes.length === 0) {
 *     throw new NoAvailableNodeError(childId);
 *   }
 *   return workerNodes[0]!.id;
 * };
 * ```
 */
export type NodeSelectorFn = (nodes: readonly NodeInfo[], childId: string) => NodeId;

/**
 * Node selector configuration for distributed child placement.
 *
 * Can be one of:
 * - A built-in strategy name (`'local_first'`, `'round_robin'`, etc.)
 * - A specific node identifier (`{ node: NodeId }`)
 * - A custom selector function
 *
 * @example
 * ```typescript
 * // Built-in strategy
 * const selector1: NodeSelector = 'round_robin';
 *
 * // Specific node
 * const selector2: NodeSelector = { node: NodeId.parse('worker@host:4369') };
 *
 * // Custom function
 * const selector3: NodeSelector = (nodes) => nodes[0]!.id;
 * ```
 */
export type NodeSelector =
  | NodeSelectorType
  | { readonly node: NodeId }
  | NodeSelectorFn;

// =============================================================================
// Child Specification
// =============================================================================

/**
 * Specification for a child process in a distributed supervisor.
 *
 * Unlike regular `ChildSpec`, this uses a behavior name (registered in
 * `BehaviorRegistry`) instead of a start function, enabling remote spawning.
 *
 * @example
 * ```typescript
 * const workerSpec: DistributedChildSpec = {
 *   id: 'worker-1',
 *   behavior: 'worker',
 *   args: [{ poolSize: 10 }],
 *   restart: 'permanent',
 *   nodeSelector: 'least_loaded',
 *   shutdownTimeout: 10000,
 * };
 * ```
 */
export interface DistributedChildSpec {
  /**
   * Unique identifier for this child within the supervisor.
   * Used for lookup, termination, and restart operations.
   */
  readonly id: string;

  /**
   * Name of the behavior registered in `BehaviorRegistry`.
   *
   * The behavior must be registered on all nodes where the child
   * might be spawned before the supervisor starts.
   *
   * @see BehaviorRegistry.register
   */
  readonly behavior: string;

  /**
   * Arguments passed to the behavior's init function.
   *
   * Must be serializable for network transmission.
   * Will be spread as arguments to `BehaviorRegistry.spawn()`.
   */
  readonly args?: readonly unknown[];

  /**
   * Restart strategy for this child.
   *
   * - `'permanent'`: Always restart (default)
   * - `'transient'`: Restart only on abnormal exit
   * - `'temporary'`: Never restart
   *
   * @default 'permanent'
   */
  readonly restart?: ChildRestartStrategy;

  /**
   * Node selection strategy for this child.
   *
   * Determines where the child is spawned initially and after
   * node failures. If not specified, uses the supervisor's default.
   */
  readonly nodeSelector?: NodeSelector;

  /**
   * Time in milliseconds to wait for graceful shutdown.
   *
   * After this timeout, the child is forcefully terminated.
   *
   * @default 5000
   */
  readonly shutdownTimeout?: number;

  /**
   * Marks this child as significant for auto_shutdown behavior.
   *
   * When true, this child's termination may trigger supervisor shutdown
   * depending on the autoShutdown setting.
   *
   * @default false
   */
  readonly significant?: boolean;
}

/**
 * Template for creating children dynamically in simple_one_for_one supervisors.
 *
 * @example
 * ```typescript
 * const workerTemplate: DistributedChildTemplate = {
 *   behavior: 'worker',
 *   restart: 'transient',
 *   nodeSelector: 'round_robin',
 * };
 *
 * const supRef = await DistributedSupervisor.start({
 *   strategy: 'simple_one_for_one',
 *   childTemplate: workerTemplate,
 * });
 *
 * // Spawn workers with different arguments
 * await DistributedSupervisor.startChild(supRef, [{ task: 'process-images' }]);
 * await DistributedSupervisor.startChild(supRef, [{ task: 'process-videos' }]);
 * ```
 */
export interface DistributedChildTemplate {
  /**
   * Name of the behavior registered in `BehaviorRegistry`.
   */
  readonly behavior: string;

  /**
   * Restart strategy for children created from this template.
   * @default 'permanent'
   */
  readonly restart?: ChildRestartStrategy;

  /**
   * Node selection strategy for children created from this template.
   */
  readonly nodeSelector?: NodeSelector;

  /**
   * Time in milliseconds to wait for graceful shutdown.
   * @default 5000
   */
  readonly shutdownTimeout?: number;

  /**
   * Marks children as significant for auto_shutdown.
   * @default false
   */
  readonly significant?: boolean;
}

// =============================================================================
// Supervisor Configuration
// =============================================================================

/**
 * Auto-shutdown behavior for distributed supervisors.
 *
 * - `'never'`: Supervisor continues running even after all children terminate (default)
 * - `'any_significant'`: Supervisor shuts down when any significant child terminates
 * - `'all_significant'`: Supervisor shuts down when all significant children have terminated
 */
export type DistributedAutoShutdown = 'never' | 'any_significant' | 'all_significant';

/**
 * Configuration options for starting a distributed supervisor.
 *
 * @example
 * ```typescript
 * const options: DistributedSupervisorOptions = {
 *   strategy: 'one_for_one',
 *   nodeSelector: 'round_robin',
 *   children: [
 *     { id: 'cache', behavior: 'cache', nodeSelector: { node: cacheNodeId } },
 *     { id: 'worker', behavior: 'worker', nodeSelector: 'least_loaded' },
 *   ],
 *   restartIntensity: { maxRestarts: 5, withinMs: 60000 },
 * };
 * ```
 */
export interface DistributedSupervisorOptions {
  /**
   * Strategy for handling child failures.
   *
   * - `'one_for_one'`: Restart only the failed child (default)
   * - `'one_for_all'`: Restart all children when one fails
   * - `'rest_for_one'`: Restart the failed child and all after it
   * - `'simple_one_for_one'`: Dynamic children from template
   *
   * @default 'one_for_one'
   */
  readonly strategy?: SupervisorStrategy;

  /**
   * Default node selection strategy for children.
   *
   * Applied to children that don't specify their own selector.
   *
   * @default 'local_first'
   */
  readonly nodeSelector?: NodeSelector;

  /**
   * Initial child specifications.
   *
   * Children are started in order on their selected nodes.
   * Not allowed when strategy is `'simple_one_for_one'`.
   */
  readonly children?: readonly DistributedChildSpec[];

  /**
   * Template for dynamic child creation.
   *
   * Required when strategy is `'simple_one_for_one'`.
   */
  readonly childTemplate?: DistributedChildTemplate;

  /**
   * Restart intensity configuration.
   *
   * Limits the number of restarts within a time window to prevent
   * infinite restart loops.
   *
   * @default { maxRestarts: 3, withinMs: 5000 }
   */
  readonly restartIntensity?: RestartIntensity;

  /**
   * Auto-shutdown behavior when children terminate.
   * @default 'never'
   */
  readonly autoShutdown?: DistributedAutoShutdown;

  /**
   * Optional name for global registry registration.
   *
   * When provided, the supervisor reference is registered globally,
   * allowing cluster-wide lookup via `GlobalRegistry.lookup()`.
   */
  readonly name?: string;
}

// =============================================================================
// Supervisor Reference
// =============================================================================

/**
 * Opaque branded type for distributed supervisor references.
 */
declare const DistributedRefBrand: unique symbol;

/**
 * A reference to a running distributed supervisor instance.
 *
 * This is the primary handle used to interact with a DistributedSupervisor.
 * Unlike regular SupervisorRef, it includes information about distributed state.
 */
export interface DistributedSupervisorRef {
  readonly [DistributedRefBrand]: 'DistributedSupervisorRef';

  /** Unique identifier for this supervisor instance */
  readonly id: string;

  /** Node where the supervisor itself is running */
  readonly nodeId: NodeId;
}

// =============================================================================
// Child Information
// =============================================================================

/**
 * Information about a running child in a distributed supervisor.
 *
 * Extends the basic child info with distribution-specific data.
 */
export interface DistributedChildInfo {
  /** Child identifier */
  readonly id: string;

  /** Reference to the running GenServer */
  readonly ref: GenServerRef;

  /** Child specification used to start this child */
  readonly spec: DistributedChildSpec;

  /** Node where the child is currently running */
  readonly nodeId: NodeId;

  /** Number of times this child has been restarted */
  readonly restartCount: number;

  /** Unix timestamp when the child was last started */
  readonly startedAt: number;
}

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Internal state for tracking a running distributed child.
 *
 * @internal
 */
export interface DistributedRunningChild {
  /** Child identifier */
  readonly id: string;

  /** Child specification */
  readonly spec: DistributedChildSpec;

  /** Current GenServer reference (mutable due to restarts) */
  ref: GenServerRef;

  /** Node where the child is currently running */
  nodeId: NodeId;

  /** Number of restarts */
  restartCount: number;

  /** Timestamps of recent restarts for intensity tracking */
  readonly restartTimestamps: number[];

  /** Unix timestamp when the child was started */
  startedAt: number;

  /** Exit reason from the last termination */
  lastExitReason?: 'normal' | 'shutdown' | { readonly error: Error };

  /** Monitor reference for remote children (for process_down notifications) */
  monitorRef?: MonitorRef;

  /** Unsubscribe function for lifecycle listener */
  lifecycleUnsubscribe?: () => void;
}

// =============================================================================
// Statistics
// =============================================================================

/**
 * Runtime statistics for a distributed supervisor.
 */
export interface DistributedSupervisorStats {
  /** Unique identifier of the supervisor */
  readonly id: string;

  /** Restart strategy in use */
  readonly strategy: SupervisorStrategy;

  /** Total number of children currently managed */
  readonly childCount: number;

  /** Breakdown of children by node */
  readonly childrenByNode: ReadonlyMap<NodeId, number>;

  /** Total number of child restarts performed */
  readonly totalRestarts: number;

  /** Number of node-failure-triggered restarts */
  readonly nodeFailureRestarts: number;

  /** Unix timestamp when the supervisor started */
  readonly startedAt: number;

  /** Time elapsed since start in milliseconds */
  readonly uptimeMs: number;
}

// =============================================================================
// Events
// =============================================================================

/**
 * Lifecycle events specific to distributed supervision.
 */
export type DistributedSupervisorEvent =
  | { readonly type: 'supervisor_started'; readonly ref: DistributedSupervisorRef }
  | { readonly type: 'supervisor_stopped'; readonly ref: DistributedSupervisorRef; readonly reason: string }
  | { readonly type: 'child_started'; readonly supervisorId: string; readonly childId: string; readonly nodeId: NodeId }
  | { readonly type: 'child_stopped'; readonly supervisorId: string; readonly childId: string; readonly reason: string }
  | { readonly type: 'child_restarted'; readonly supervisorId: string; readonly childId: string; readonly nodeId: NodeId; readonly attempt: number }
  | { readonly type: 'child_migrated'; readonly supervisorId: string; readonly childId: string; readonly fromNode: NodeId; readonly toNode: NodeId }
  | { readonly type: 'node_failure_detected'; readonly supervisorId: string; readonly nodeId: NodeId; readonly affectedChildren: readonly string[] };

/**
 * Handler for distributed supervisor lifecycle events.
 */
export type DistributedSupervisorEventHandler = (event: DistributedSupervisorEvent) => void;

// =============================================================================
// Default Values
// =============================================================================

/**
 * Default values for distributed supervisor configuration.
 */
export const DISTRIBUTED_SUPERVISOR_DEFAULTS = {
  /** Default node selector strategy */
  NODE_SELECTOR: 'local_first' as const,

  /** Default supervisor strategy */
  STRATEGY: 'one_for_one' as const,

  /** Default maximum restarts in intensity window */
  MAX_RESTARTS: 3,

  /** Default restart intensity window in milliseconds */
  RESTART_WITHIN_MS: 5000,

  /** Default shutdown timeout in milliseconds */
  SHUTDOWN_TIMEOUT: 5000,

  /** Default auto-shutdown behavior */
  AUTO_SHUTDOWN: 'never' as const,

  /** Timeout for remote spawn operations in milliseconds */
  SPAWN_TIMEOUT: 10000,

  /** Interval for polling child status in milliseconds */
  CHILD_CHECK_INTERVAL: 50,
} as const;

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error thrown when no nodes are available for spawning a child.
 *
 * This can occur when:
 * - The cluster has no connected nodes
 * - All nodes matching a selector are down
 * - A specific node target is unreachable
 */
export class NoAvailableNodeError extends Error {
  override readonly name = 'NoAvailableNodeError' as const;

  constructor(
    readonly childId: string,
    readonly selector?: NodeSelector,
  ) {
    const selectorDesc = selector
      ? typeof selector === 'string'
        ? selector
        : typeof selector === 'function'
          ? 'custom'
          : `node:${selector.node}`
      : 'default';
    super(`No available node for child '${childId}' with selector '${selectorDesc}'`);
  }
}

/**
 * Error thrown when a behavior required for spawning is not registered.
 *
 * The behavior must be registered in BehaviorRegistry on the target node
 * before attempting to spawn a child using it.
 */
export class DistributedBehaviorNotFoundError extends Error {
  override readonly name = 'DistributedBehaviorNotFoundError' as const;

  constructor(
    readonly behaviorName: string,
    readonly nodeId: NodeId,
  ) {
    super(`Behavior '${behaviorName}' is not registered on node '${nodeId}'`);
  }
}

/**
 * Error thrown when attempting to add a child with a duplicate ID.
 */
export class DistributedDuplicateChildError extends Error {
  override readonly name = 'DistributedDuplicateChildError' as const;

  constructor(
    readonly supervisorId: string,
    readonly childId: string,
  ) {
    super(`Child '${childId}' already exists in distributed supervisor '${supervisorId}'`);
  }
}

/**
 * Error thrown when a referenced child does not exist.
 */
export class DistributedChildNotFoundError extends Error {
  override readonly name = 'DistributedChildNotFoundError' as const;

  constructor(
    readonly supervisorId: string,
    readonly childId: string,
  ) {
    super(`Child '${childId}' not found in distributed supervisor '${supervisorId}'`);
  }
}

/**
 * Error thrown when the restart intensity limit is exceeded.
 *
 * This is a safety mechanism to prevent infinite restart loops.
 * When this error is thrown, the supervisor shuts down.
 */
export class DistributedMaxRestartsExceededError extends Error {
  override readonly name = 'DistributedMaxRestartsExceededError' as const;

  constructor(
    readonly supervisorId: string,
    readonly maxRestarts: number,
    readonly withinMs: number,
  ) {
    super(
      `Distributed supervisor '${supervisorId}' exceeded max restarts (${maxRestarts} within ${withinMs}ms)`,
    );
  }
}

/**
 * Error thrown when simple_one_for_one supervisor is misconfigured.
 */
export class DistributedInvalidSimpleOneForOneError extends Error {
  override readonly name = 'DistributedInvalidSimpleOneForOneError' as const;

  constructor(
    readonly supervisorId: string,
    readonly reason: string,
  ) {
    super(`Distributed supervisor '${supervisorId}': invalid simple_one_for_one config - ${reason}`);
  }
}

/**
 * Error thrown when simple_one_for_one supervisor lacks a child template.
 */
export class DistributedMissingChildTemplateError extends Error {
  override readonly name = 'DistributedMissingChildTemplateError' as const;

  constructor(readonly supervisorId: string) {
    super(
      `Distributed supervisor '${supervisorId}': simple_one_for_one strategy requires childTemplate`,
    );
  }
}

/**
 * Error thrown when attempting to claim a child that another supervisor owns.
 *
 * This indicates a split-brain situation where multiple supervisors
 * are trying to manage the same child.
 */
export class DistributedChildClaimError extends Error {
  override readonly name = 'DistributedChildClaimError' as const;

  constructor(
    readonly supervisorId: string,
    readonly childId: string,
    readonly ownerSupervisorId: string,
  ) {
    super(
      `Child '${childId}' is claimed by supervisor '${ownerSupervisorId}', not '${supervisorId}'`,
    );
  }
}

/**
 * Error thrown for general distributed supervisor failures.
 */
export class DistributedSupervisorError extends Error {
  override readonly name = 'DistributedSupervisorError' as const;

  constructor(
    readonly supervisorId: string,
    message: string,
    override readonly cause?: Error,
  ) {
    super(`Distributed supervisor '${supervisorId}': ${message}`);
  }
}
