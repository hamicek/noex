/**
 * Monitor handler for processing monitor-related messages on the receiving side.
 *
 * Handles incoming monitor requests from remote nodes that want to monitor
 * local processes, and manages the lifecycle notifications when monitored
 * processes terminate.
 *
 * @module distribution/monitor/monitor-handler
 */

import type {
  MonitorId,
  NodeId,
  MonitorRequestMessage,
  MonitorAckMessage,
  DemonitorRequestMessage,
  ProcessDownMessage,
  ProcessDownReason,
  SerializedRef,
} from '../types.js';
import { MonitorRegistry, type IncomingMonitor } from './monitor-registry.js';
import { GenServer } from '../../core/gen-server.js';
import type { LifecycleEvent, TerminateReason } from '../../core/types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Function type for sending messages back to remote nodes.
 */
export type SendFunction = (
  nodeId: NodeId,
  message: MonitorAckMessage | ProcessDownMessage,
) => Promise<void>;

/**
 * Function type for checking if a local process exists.
 */
export type ProcessExistsFunction = (serverId: string) => boolean;

/**
 * Configuration for the MonitorHandler.
 */
export interface MonitorHandlerConfig {
  /** Function to send messages to remote nodes */
  readonly send: SendFunction;

  /** Function to check if a local process exists */
  readonly processExists: ProcessExistsFunction;

  /** The local node ID */
  readonly localNodeId: NodeId;
}

/**
 * Statistics about the monitor handler.
 */
export interface MonitorHandlerStats {
  /** Number of incoming monitors currently active */
  readonly activeIncomingMonitors: number;

  /** Total monitor requests processed */
  readonly totalMonitorRequests: number;

  /** Total successful monitor setups */
  readonly successfulMonitors: number;

  /** Total monitor requests for non-existent processes */
  readonly noprocResponses: number;

  /** Total demonitor requests processed */
  readonly totalDemonitorRequests: number;

  /** Total process_down notifications sent */
  readonly totalProcessDownSent: number;
}

// =============================================================================
// MonitorHandler Implementation
// =============================================================================

/**
 * Handles monitor-related messages on the receiving (monitored) side.
 *
 * Responsibilities:
 * - Processing monitor_request messages from remote nodes
 * - Validating that the target process exists
 * - Tracking incoming monitors in the registry
 * - Sending process_down notifications when monitored processes terminate
 * - Processing demonitor_request messages
 *
 * @example
 * ```typescript
 * const handler = new MonitorHandler({
 *   send: async (nodeId, msg) => transport.send(nodeId, msg),
 *   processExists: (id) => GenServer.isRunning({ id }),
 *   localNodeId: Cluster.getLocalNodeId(),
 * });
 *
 * // Called when cluster receives a monitor_request
 * await handler.handleMonitorRequest(message, fromNodeId);
 *
 * // Called when cluster receives a demonitor_request
 * handler.handleDemonitorRequest(message);
 * ```
 */
export class MonitorHandler {
  private readonly registry: MonitorRegistry;
  private readonly config: MonitorHandlerConfig;
  private lifecycleUnsubscribe: (() => void) | null = null;

  // Statistics
  private totalMonitorRequests = 0;
  private successfulMonitors = 0;
  private noprocResponses = 0;
  private totalDemonitorRequests = 0;
  private totalProcessDownSent = 0;

  constructor(config: MonitorHandlerConfig) {
    this.config = config;
    this.registry = new MonitorRegistry();
  }

  /**
   * Starts the monitor handler and subscribes to lifecycle events.
   *
   * Must be called before handling any monitor messages.
   */
  start(): void {
    if (this.lifecycleUnsubscribe !== null) {
      return; // Already started
    }

    this.lifecycleUnsubscribe = GenServer.onLifecycleEvent((event) => {
      this.handleLifecycleEvent(event);
    });
  }

  /**
   * Stops the monitor handler and cleans up resources.
   */
  stop(): void {
    if (this.lifecycleUnsubscribe !== null) {
      this.lifecycleUnsubscribe();
      this.lifecycleUnsubscribe = null;
    }
    this.registry.clear();
  }

  /**
   * Handles an incoming monitor_request from a remote node.
   *
   * Validates that the target process exists, registers the incoming monitor,
   * and sends the appropriate acknowledgement. If the process doesn't exist,
   * sends a monitor_ack with success=false followed by a process_down with
   * reason 'noproc'.
   *
   * @param message - The monitor request message
   * @param fromNodeId - The node that sent the request
   */
  async handleMonitorRequest(
    message: MonitorRequestMessage,
    fromNodeId: NodeId,
  ): Promise<void> {
    this.totalMonitorRequests++;

    const { monitorId, monitoringRef, monitoredRef } = message;

    // Validate that the monitored process is on this node
    if (monitoredRef.nodeId !== this.config.localNodeId) {
      // This shouldn't happen - message was misrouted
      await this.sendMonitorAck(fromNodeId, monitorId, false, 'Process is not on this node');
      return;
    }

    // Check if the process exists
    const processExists = this.config.processExists(monitoredRef.id);

    if (!processExists) {
      this.noprocResponses++;

      // Send ack indicating setup succeeded (Erlang semantics: monitor setup always succeeds)
      await this.sendMonitorAck(fromNodeId, monitorId, true);

      // Immediately send process_down with 'noproc' reason
      await this.sendProcessDown(fromNodeId, monitorId, monitoredRef, { type: 'noproc' });
      return;
    }

    // Register the incoming monitor
    const incomingMonitor: IncomingMonitor = {
      monitorId,
      monitoringRef,
      monitoredServerId: monitoredRef.id,
      createdAt: Date.now(),
    };

    const added = this.registry.addIncoming(incomingMonitor);

    if (!added) {
      // Monitor with this ID already exists (duplicate request)
      await this.sendMonitorAck(fromNodeId, monitorId, false, 'Monitor already exists');
      return;
    }

    this.successfulMonitors++;

    // Send successful acknowledgement
    await this.sendMonitorAck(fromNodeId, monitorId, true);
  }

  /**
   * Handles an incoming demonitor_request from a remote node.
   *
   * Removes the monitor from the registry. No acknowledgement is sent
   * (following Erlang semantics).
   *
   * @param message - The demonitor request message
   */
  handleDemonitorRequest(message: DemonitorRequestMessage): void {
    this.totalDemonitorRequests++;
    this.registry.removeIncoming(message.monitorId);
  }

  /**
   * Handles node disconnection by cleaning up monitors from that node.
   *
   * Called by the Cluster when a remote node goes down. Removes all
   * incoming monitors from the disconnected node (no notifications
   * needed since the monitoring node is gone).
   *
   * @param nodeId - The node that disconnected
   * @returns Number of monitors cleaned up
   */
  handleNodeDown(nodeId: NodeId): number {
    const removed = this.registry.removeIncomingByNode(nodeId);
    return removed.length;
  }

  /**
   * Returns statistics about the monitor handler.
   */
  getStats(): MonitorHandlerStats {
    return {
      activeIncomingMonitors: this.registry.incomingCount,
      totalMonitorRequests: this.totalMonitorRequests,
      successfulMonitors: this.successfulMonitors,
      noprocResponses: this.noprocResponses,
      totalDemonitorRequests: this.totalDemonitorRequests,
      totalProcessDownSent: this.totalProcessDownSent,
    };
  }

  /**
   * Returns the internal registry for testing purposes.
   *
   * @internal
   */
  _getRegistry(): MonitorRegistry {
    return this.registry;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Handles lifecycle events from GenServer to detect process termination.
   */
  private handleLifecycleEvent(event: LifecycleEvent): void {
    if (event.type !== 'terminated') {
      return;
    }

    const serverId = event.ref.id;

    // Find all incoming monitors for this server
    const monitors = this.registry.getIncomingByMonitoredServer(serverId);

    if (monitors.length === 0) {
      return;
    }

    // Map TerminateReason to ProcessDownReason
    const reason = this.mapTerminateReason(event.reason);

    // Build the monitored ref
    const monitoredRef: SerializedRef = {
      id: serverId,
      nodeId: this.config.localNodeId,
    };

    // Send process_down to all monitoring nodes and clean up
    for (const monitor of monitors) {
      // Fire and forget - we're terminating anyway
      void this.sendProcessDown(
        monitor.monitoringRef.nodeId,
        monitor.monitorId,
        monitoredRef,
        reason,
      );
    }

    // Remove all monitors for this server
    this.registry.removeIncomingByMonitoredServer(serverId);
  }

  /**
   * Maps GenServer TerminateReason to ProcessDownReason.
   */
  private mapTerminateReason(reason: TerminateReason): ProcessDownReason {
    if (reason === 'normal') {
      return { type: 'normal' };
    }

    if (reason === 'shutdown') {
      return { type: 'shutdown' };
    }

    // reason is { error: Error }
    return {
      type: 'error',
      message: reason.error.message,
    };
  }

  /**
   * Sends a monitor_ack message to the monitoring node.
   */
  private async sendMonitorAck(
    nodeId: NodeId,
    monitorId: MonitorId,
    success: boolean,
    reason?: string,
  ): Promise<void> {
    const ack: MonitorAckMessage = {
      type: 'monitor_ack',
      monitorId,
      success,
      ...(reason !== undefined && { reason }),
    };

    try {
      await this.config.send(nodeId, ack);
    } catch {
      // Best effort - if we can't send the ack, the monitor setup will timeout
    }
  }

  /**
   * Sends a process_down message to the monitoring node.
   */
  private async sendProcessDown(
    nodeId: NodeId,
    monitorId: MonitorId,
    monitoredRef: SerializedRef,
    reason: ProcessDownReason,
  ): Promise<void> {
    const down: ProcessDownMessage = {
      type: 'process_down',
      monitorId,
      monitoredRef,
      reason,
    };

    this.totalProcessDownSent++;

    try {
      await this.config.send(nodeId, down);
    } catch {
      // Best effort - the monitoring node may be down
    }
  }
}
