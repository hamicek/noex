/**
 * Remote monitor implementation for distributed process monitoring.
 *
 * Enables monitoring of remote GenServer processes across cluster nodes.
 * When a monitored process terminates, the monitoring process receives
 * a process_down lifecycle event with the termination reason.
 *
 * Follows Erlang monitor semantics:
 * - Monitors are one-way (monitoring process is notified, not affected)
 * - Multiple monitors to the same process are independent
 * - If the monitored process doesn't exist, a 'noproc' down event is sent immediately
 *
 * @module distribution/monitor/remote-monitor
 */

import type {
  MonitorId,
  NodeId,
  MonitorRequestMessage,
  MonitorAckMessage,
  ProcessDownMessage,
  DemonitorRequestMessage,
  SerializedRef,
} from '../types.js';
import { NodeNotReachableError, ClusterNotStartedError } from '../types.js';
import type { MonitorRef, GenServerRef } from '../../core/types.js';
import { generateMonitorId } from '../serialization.js';
import { Cluster } from '../cluster/cluster.js';
import { MonitorRegistry, type OutgoingMonitor } from './monitor-registry.js';
import { GenServer } from '../../core/gen-server.js';

// =============================================================================
// Constants
// =============================================================================

/**
 * Default timeout for monitor setup in milliseconds.
 */
const DEFAULT_MONITOR_TIMEOUT_MS = 10_000;

// =============================================================================
// Types
// =============================================================================

/**
 * State of a pending monitor request.
 */
type PendingMonitorState = 'pending' | 'resolved' | 'rejected' | 'timeout';

/**
 * Information about a pending monitor request.
 */
interface PendingMonitor {
  /** Unique monitor identifier */
  readonly monitorId: MonitorId;

  /** Reference to the local process doing the monitoring */
  readonly monitoringRef: SerializedRef;

  /** Reference to the remote process being monitored */
  readonly monitoredRef: SerializedRef;

  /** Promise resolve function */
  readonly resolve: (value: MonitorRef) => void;

  /** Promise reject function */
  readonly reject: (error: Error) => void;

  /** Timeout handle */
  readonly timeoutHandle: ReturnType<typeof setTimeout>;

  /** Timeout duration in milliseconds */
  readonly timeoutMs: number;

  /** Timestamp when monitor was initiated */
  readonly createdAt: number;

  /** Current state of the monitor request */
  state: PendingMonitorState;
}

/**
 * Options for remote monitor setup.
 */
export interface RemoteMonitorOptions {
  /** Timeout in milliseconds for monitor setup */
  readonly timeout?: number;
}

/**
 * Statistics about remote monitor operations.
 */
export interface RemoteMonitorStats {
  /** Whether the module is initialized */
  readonly initialized: boolean;

  /** Number of pending monitor requests */
  readonly pendingCount: number;

  /** Number of active outgoing monitors */
  readonly activeOutgoingCount: number;

  /** Total monitor requests initiated */
  readonly totalInitiated: number;

  /** Total monitors successfully established */
  readonly totalEstablished: number;

  /** Total monitors that timed out during setup */
  readonly totalTimedOut: number;

  /** Total monitors removed via demonitor */
  readonly totalDemonitored: number;

  /** Total process_down events received */
  readonly totalProcessDownReceived: number;
}

/**
 * Error thrown when remote monitor setup times out.
 */
export class RemoteMonitorTimeoutError extends Error {
  override readonly name = 'RemoteMonitorTimeoutError' as const;

  constructor(
    readonly monitoredRef: SerializedRef,
    readonly timeoutMs: number,
  ) {
    super(
      `Remote monitor of '${monitoredRef.id}' on node '${monitoredRef.nodeId}' timed out after ${timeoutMs}ms`,
    );
  }
}

// =============================================================================
// State
// =============================================================================

/** Pending monitor requests awaiting acknowledgement */
const pendingMonitors = new Map<MonitorId, PendingMonitor>();

/** Registry for active outgoing monitors */
const registry = new MonitorRegistry();

/** Whether the remote monitor module is initialized */
let initialized = false;

/** Cleanup function for node down handler */
let nodeDownCleanup: (() => void) | null = null;

// Statistics
let totalInitiated = 0;
let totalEstablished = 0;
let totalTimedOut = 0;
let totalDemonitored = 0;
let totalProcessDownReceived = 0;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initializes the remote monitor module.
 *
 * Sets up event handlers for cluster node failures.
 * Called automatically on first remote monitor if not already initialized.
 */
function ensureInitialized(): void {
  if (initialized) {
    return;
  }

  // Subscribe to cluster node down events
  nodeDownCleanup = Cluster.onNodeDown((nodeId, _reason) => {
    handleNodeDown(nodeId);
  });

  initialized = true;
}

/**
 * Handles a node going down by cleaning up all monitors to that node.
 *
 * @param nodeId - The node that went down
 */
function handleNodeDown(nodeId: NodeId): void {
  // Reject all pending monitors to the downed node
  for (const [monitorId, pending] of pendingMonitors) {
    if (pending.monitoredRef.nodeId === nodeId && pending.state === 'pending') {
      clearTimeout(pending.timeoutHandle);
      pending.state = 'rejected';
      pendingMonitors.delete(monitorId);
      pending.reject(new NodeNotReachableError(nodeId));
    }
  }

  // Remove all active outgoing monitors to the downed node
  // and emit process_down events for each
  const removedMonitors = registry.removeOutgoingByNode(nodeId);

  for (const monitor of removedMonitors) {
    emitProcessDown(
      monitor.monitoringServerId,
      monitor.monitoredRef,
      monitor.monitorId,
      { type: 'noconnection' },
    );
  }
}

/**
 * Handles timeout for a pending monitor request.
 *
 * @param monitorId - Monitor identifier
 */
function handleTimeout(monitorId: MonitorId): void {
  const pending = pendingMonitors.get(monitorId);

  if (!pending || pending.state !== 'pending') {
    return;
  }

  pending.state = 'timeout';
  pendingMonitors.delete(monitorId);
  totalTimedOut++;

  pending.reject(
    new RemoteMonitorTimeoutError(pending.monitoredRef, pending.timeoutMs),
  );
}

/**
 * Emits a process_down lifecycle event to the monitoring GenServer.
 *
 * @param monitoringServerId - ID of the local GenServer doing the monitoring
 * @param monitoredRef - Reference to the process that went down
 * @param monitorId - Monitor identifier
 * @param reason - Reason for the process going down
 */
function emitProcessDown(
  monitoringServerId: string,
  monitoredRef: SerializedRef,
  monitorId: MonitorId,
  reason: ProcessDownMessage['reason'],
): void {
  // Get the local GenServer reference
  const ref = GenServer._getRefById(monitoringServerId);
  if (!ref) {
    // Monitoring process is gone - nothing to notify
    return;
  }

  // Emit the process_down lifecycle event
  GenServer._emitProcessDown(ref, monitoredRef, reason, monitorId);
}

/**
 * Resets the remote monitor module state.
 *
 * @internal Used for testing.
 */
export function _resetRemoteMonitorState(): void {
  // Clear pending monitors
  for (const [, pending] of pendingMonitors) {
    if (pending.state === 'pending') {
      clearTimeout(pending.timeoutHandle);
    }
  }
  pendingMonitors.clear();

  // Clear registry
  registry.clear();

  // Cleanup event handlers
  if (nodeDownCleanup) {
    nodeDownCleanup();
    nodeDownCleanup = null;
  }

  // Reset statistics
  totalInitiated = 0;
  totalEstablished = 0;
  totalTimedOut = 0;
  totalDemonitored = 0;
  totalProcessDownReceived = 0;

  initialized = false;
}

// =============================================================================
// RemoteMonitor
// =============================================================================

/**
 * Remote monitor operations for distributed process monitoring.
 *
 * @example
 * ```typescript
 * import { RemoteMonitor } from 'noex/distribution';
 *
 * // Monitor a remote process
 * const monitorRef = await RemoteMonitor.monitor(
 *   localServerRef,
 *   remoteServerRef,
 * );
 *
 * // Listen for process_down events
 * GenServer.onLifecycleEvent((event) => {
 *   if (event.type === 'process_down') {
 *     console.log(`Process ${event.monitoredRef.id} went down: ${event.reason.type}`);
 *   }
 * });
 *
 * // Later, stop monitoring
 * await RemoteMonitor.demonitor(monitorRef);
 * ```
 */
export const RemoteMonitor = {
  /**
   * Establishes a monitor on a remote process.
   *
   * When the monitored process terminates, the monitoring process
   * receives a process_down lifecycle event.
   *
   * @param monitoringRef - Reference to the local process that will receive notifications
   * @param monitoredRef - Reference to the remote process to monitor
   * @param options - Monitor options
   * @returns Promise resolving to a MonitorRef
   * @throws {ClusterNotStartedError} If cluster is not running
   * @throws {NodeNotReachableError} If target node is not connected
   * @throws {RemoteMonitorTimeoutError} If monitor setup times out
   */
  async monitor(
    monitoringRef: GenServerRef,
    monitoredRef: GenServerRef,
    options: RemoteMonitorOptions = {},
  ): Promise<MonitorRef> {
    ensureInitialized();

    const transport = Cluster._getTransport();
    const localNodeId = Cluster.getLocalNodeId();
    const timeoutMs = options.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS;

    // Build the serialized refs
    const serializedMonitoringRef: SerializedRef = {
      id: monitoringRef.id,
      nodeId: (monitoringRef.nodeId as NodeId | undefined) ?? localNodeId,
    };

    const targetNodeId = monitoredRef.nodeId as NodeId | undefined;
    if (!targetNodeId) {
      throw new Error('monitoredRef must have a nodeId for remote monitoring');
    }

    const serializedMonitoredRef: SerializedRef = {
      id: monitoredRef.id,
      nodeId: targetNodeId,
    };

    // Check if target node is connected
    if (!transport.isConnectedTo(targetNodeId)) {
      throw new NodeNotReachableError(targetNodeId);
    }

    // Generate unique monitor ID
    const monitorId = generateMonitorId();

    totalInitiated++;

    // Create the pending monitor entry
    const promise = new Promise<MonitorRef>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        handleTimeout(monitorId);
      }, timeoutMs);

      // Don't block process exit
      if (timeoutHandle.unref) {
        timeoutHandle.unref();
      }

      const pending: PendingMonitor = {
        monitorId,
        monitoringRef: serializedMonitoringRef,
        monitoredRef: serializedMonitoredRef,
        resolve,
        reject,
        timeoutHandle,
        timeoutMs,
        createdAt: Date.now(),
        state: 'pending',
      };

      pendingMonitors.set(monitorId, pending);
    });

    // Create monitor request message
    const monitorRequest: MonitorRequestMessage = {
      type: 'monitor_request',
      monitorId,
      monitoringRef: serializedMonitoringRef,
      monitoredRef: serializedMonitoredRef,
    };

    try {
      await transport.send(targetNodeId, monitorRequest);
    } catch (error) {
      // Failed to send - reject the pending monitor
      const pending = pendingMonitors.get(monitorId);
      if (pending && pending.state === 'pending') {
        clearTimeout(pending.timeoutHandle);
        pending.state = 'rejected';
        pendingMonitors.delete(monitorId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }

    // Wait for response
    return promise;
  },

  /**
   * Removes a monitor.
   *
   * Sends a demonitor request to the remote node and removes
   * the monitor from the local registry.
   *
   * @param monitorRef - Reference to the monitor to remove
   * @throws {ClusterNotStartedError} If cluster is not running
   */
  async demonitor(monitorRef: MonitorRef): Promise<void> {
    ensureInitialized();

    const transport = Cluster._getTransport();

    // Remove from local registry
    const monitor = registry.removeOutgoing(monitorRef.monitorId);

    if (!monitor) {
      // Monitor doesn't exist or already removed - nothing to do
      return;
    }

    totalDemonitored++;

    // Build demonitor request message
    const demonitorRequest: DemonitorRequestMessage = {
      type: 'demonitor_request',
      monitorId: monitorRef.monitorId,
    };

    // Send demonitor request (fire-and-forget, best effort)
    try {
      if (transport.isConnectedTo(monitor.monitoredRef.nodeId)) {
        await transport.send(monitor.monitoredRef.nodeId, demonitorRequest);
      }
    } catch {
      // Ignore send failures - the monitor is already removed locally
    }
  },

  /**
   * Handles an incoming monitor_ack message.
   *
   * Called by the Cluster when a monitor_ack message is received.
   *
   * @param message - Monitor acknowledgement message
   * @internal
   */
  _handleMonitorAck(message: MonitorAckMessage): void {
    const pending = pendingMonitors.get(message.monitorId);

    if (!pending || pending.state !== 'pending') {
      return;
    }

    clearTimeout(pending.timeoutHandle);

    if (!message.success) {
      // Monitor setup failed
      pending.state = 'rejected';
      pendingMonitors.delete(message.monitorId);
      pending.reject(new Error(message.reason ?? 'Monitor setup failed'));
      return;
    }

    // Monitor established successfully
    pending.state = 'resolved';
    pendingMonitors.delete(message.monitorId);
    totalEstablished++;

    // Register the outgoing monitor
    const outgoing: OutgoingMonitor = {
      monitorId: message.monitorId,
      monitoringServerId: pending.monitoringRef.id,
      monitoredRef: pending.monitoredRef,
      createdAt: Date.now(),
    };

    registry.addOutgoing(outgoing);

    // Resolve with MonitorRef
    pending.resolve({
      monitorId: message.monitorId,
      monitoredRef: pending.monitoredRef,
    });
  },

  /**
   * Handles an incoming process_down message.
   *
   * Called by the Cluster when a process_down message is received.
   *
   * @param message - Process down message
   * @internal
   */
  _handleProcessDown(message: ProcessDownMessage): void {
    totalProcessDownReceived++;

    // Remove the monitor from registry
    const monitor = registry.removeOutgoing(message.monitorId);

    if (!monitor) {
      // Monitor not found - might have been demonitored already
      return;
    }

    // Emit process_down lifecycle event
    emitProcessDown(
      monitor.monitoringServerId,
      message.monitoredRef,
      message.monitorId,
      message.reason,
    );
  },

  /**
   * Returns statistics about remote monitor operations.
   */
  getStats(): RemoteMonitorStats {
    return {
      initialized,
      pendingCount: pendingMonitors.size,
      activeOutgoingCount: registry.outgoingCount,
      totalInitiated,
      totalEstablished,
      totalTimedOut,
      totalDemonitored,
      totalProcessDownReceived,
    };
  },

  /**
   * Returns the internal registry for testing purposes.
   *
   * @internal
   */
  _getRegistry(): MonitorRegistry {
    return registry;
  },

  /**
   * Clears all pending monitors and active monitors.
   *
   * Called during cluster shutdown.
   *
   * @internal
   */
  _clear(): void {
    // Clear pending monitors
    const error = new ClusterNotStartedError();
    for (const [, pending] of pendingMonitors) {
      if (pending.state === 'pending') {
        clearTimeout(pending.timeoutHandle);
        pending.state = 'rejected';
        pending.reject(error);
      }
    }
    pendingMonitors.clear();

    // Clear registry
    registry.clear();
  },
} as const;
