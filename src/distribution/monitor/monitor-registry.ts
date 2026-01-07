/**
 * Monitor registry for tracking process monitors across the cluster.
 *
 * Maintains two-way tracking:
 * - Outgoing monitors: This node is monitoring remote processes
 * - Incoming monitors: Remote nodes are monitoring our local processes
 *
 * Provides efficient indexing by serverId and nodeId for fast cleanup
 * operations when processes terminate or nodes disconnect.
 *
 * @module distribution/monitor/monitor-registry
 */

import type { MonitorId, SerializedRef } from '../types.js';
import type { NodeId } from '../node-id.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Represents an outgoing monitor (this node monitors a remote process).
 *
 * Created when GenServer.monitor() is called on a remote process.
 * Removed when the monitored process terminates or demonitor() is called.
 */
export interface OutgoingMonitor {
  /** Unique identifier for this monitor */
  readonly monitorId: MonitorId;

  /** Local server that is doing the monitoring */
  readonly monitoringServerId: string;

  /** Reference to the remote process being monitored */
  readonly monitoredRef: SerializedRef;

  /** Unix timestamp when the monitor was established */
  readonly createdAt: number;
}

/**
 * Represents an incoming monitor (a remote node monitors our local process).
 *
 * Created when we receive a monitor_request from a remote node.
 * Removed when the monitored process terminates or demonitor_request arrives.
 */
export interface IncomingMonitor {
  /** Unique identifier for this monitor */
  readonly monitorId: MonitorId;

  /** Reference to the remote process doing the monitoring */
  readonly monitoringRef: SerializedRef;

  /** Local server being monitored */
  readonly monitoredServerId: string;

  /** Unix timestamp when the monitor was established */
  readonly createdAt: number;
}

/**
 * Statistics about the monitor registry state.
 */
export interface MonitorRegistryStats {
  /** Number of active outgoing monitors */
  readonly outgoingCount: number;

  /** Number of active incoming monitors */
  readonly incomingCount: number;

  /** Total monitors added over lifetime */
  readonly totalAdded: number;

  /** Total monitors removed over lifetime */
  readonly totalRemoved: number;

  /** Number of monitors removed due to node disconnect */
  readonly nodeDisconnectRemovals: number;

  /** Number of monitors removed due to process termination */
  readonly processTerminationRemovals: number;
}

// =============================================================================
// MonitorRegistry Implementation
// =============================================================================

/**
 * Thread-safe registry for tracking process monitors.
 *
 * Maintains bidirectional indexes for efficient queries:
 * - By monitorId: O(1) lookup for specific monitor
 * - By serverId: O(1) lookup for all monitors involving a server
 * - By nodeId: O(1) lookup for all monitors to/from a node
 *
 * @example
 * ```typescript
 * const registry = new MonitorRegistry();
 *
 * // Add an outgoing monitor (we're monitoring a remote process)
 * registry.addOutgoing({
 *   monitorId: generateMonitorId(),
 *   monitoringServerId: 'localServer1',
 *   monitoredRef: { id: 'remoteServer', nodeId: remoteNodeId },
 *   createdAt: Date.now(),
 * });
 *
 * // When the remote node goes down, find and remove all monitors
 * const affected = registry.removeOutgoingByNode(remoteNodeId);
 * for (const monitor of affected) {
 *   emitProcessDown(monitor, 'noconnection');
 * }
 * ```
 */
export class MonitorRegistry {
  // Primary storage
  private readonly outgoing = new Map<MonitorId, OutgoingMonitor>();
  private readonly incoming = new Map<MonitorId, IncomingMonitor>();

  // Secondary indexes for outgoing monitors
  private readonly outgoingByMonitoringServer = new Map<string, Set<MonitorId>>();
  private readonly outgoingByMonitoredServer = new Map<string, Set<MonitorId>>();
  private readonly outgoingByNode = new Map<NodeId, Set<MonitorId>>();

  // Secondary indexes for incoming monitors
  private readonly incomingByMonitoredServer = new Map<string, Set<MonitorId>>();
  private readonly incomingByMonitoringNode = new Map<NodeId, Set<MonitorId>>();

  // Statistics
  private totalAdded = 0;
  private totalRemoved = 0;
  private nodeDisconnectRemovals = 0;
  private processTerminationRemovals = 0;

  // ==========================================================================
  // Outgoing Monitor Operations
  // ==========================================================================

  /**
   * Adds an outgoing monitor (this node monitors a remote process).
   *
   * @param monitor - Outgoing monitor to add
   * @returns true if added, false if monitorId already exists
   */
  addOutgoing(monitor: OutgoingMonitor): boolean {
    if (this.outgoing.has(monitor.monitorId)) {
      return false;
    }

    this.outgoing.set(monitor.monitorId, monitor);
    this.totalAdded++;

    // Index by monitoring server
    this.addToIndex(
      this.outgoingByMonitoringServer,
      monitor.monitoringServerId,
      monitor.monitorId,
    );

    // Index by monitored server
    this.addToIndex(
      this.outgoingByMonitoredServer,
      monitor.monitoredRef.id,
      monitor.monitorId,
    );

    // Index by node
    this.addToIndex(
      this.outgoingByNode,
      monitor.monitoredRef.nodeId,
      monitor.monitorId,
    );

    return true;
  }

  /**
   * Gets an outgoing monitor by its ID.
   *
   * @param monitorId - Monitor identifier
   * @returns Monitor if found, undefined otherwise
   */
  getOutgoing(monitorId: MonitorId): OutgoingMonitor | undefined {
    return this.outgoing.get(monitorId);
  }

  /**
   * Removes an outgoing monitor by its ID.
   *
   * @param monitorId - Monitor identifier
   * @returns Removed monitor if found, undefined otherwise
   */
  removeOutgoing(monitorId: MonitorId): OutgoingMonitor | undefined {
    const monitor = this.outgoing.get(monitorId);
    if (!monitor) {
      return undefined;
    }

    this.outgoing.delete(monitorId);
    this.totalRemoved++;

    // Remove from indexes
    this.removeFromIndex(
      this.outgoingByMonitoringServer,
      monitor.monitoringServerId,
      monitorId,
    );
    this.removeFromIndex(
      this.outgoingByMonitoredServer,
      monitor.monitoredRef.id,
      monitorId,
    );
    this.removeFromIndex(
      this.outgoingByNode,
      monitor.monitoredRef.nodeId,
      monitorId,
    );

    return monitor;
  }

  /**
   * Removes all outgoing monitors to a specific node.
   *
   * Called when a node goes down to emit process_down for all monitored processes.
   *
   * @param nodeId - Node identifier
   * @returns Array of removed monitors
   */
  removeOutgoingByNode(nodeId: NodeId): readonly OutgoingMonitor[] {
    const monitorIds = this.outgoingByNode.get(nodeId);
    if (!monitorIds || monitorIds.size === 0) {
      return [];
    }

    const removed: OutgoingMonitor[] = [];
    for (const monitorId of monitorIds) {
      const monitor = this.removeOutgoing(monitorId);
      if (monitor) {
        removed.push(monitor);
        this.nodeDisconnectRemovals++;
        this.totalRemoved--; // removeOutgoing already incremented
      }
    }

    return removed;
  }

  /**
   * Removes all outgoing monitors where the monitoring server terminates.
   *
   * Called when a local GenServer stops to clean up its monitors.
   *
   * @param serverId - Local server identifier
   * @returns Array of removed monitors
   */
  removeOutgoingByMonitoringServer(serverId: string): readonly OutgoingMonitor[] {
    const monitorIds = this.outgoingByMonitoringServer.get(serverId);
    if (!monitorIds || monitorIds.size === 0) {
      return [];
    }

    const removed: OutgoingMonitor[] = [];
    for (const monitorId of [...monitorIds]) {
      const monitor = this.removeOutgoing(monitorId);
      if (monitor) {
        removed.push(monitor);
        this.processTerminationRemovals++;
        this.totalRemoved--; // removeOutgoing already incremented
      }
    }

    return removed;
  }

  /**
   * Gets all outgoing monitors for a monitoring server.
   *
   * @param serverId - Local server identifier
   * @returns Array of outgoing monitors
   */
  getOutgoingByMonitoringServer(serverId: string): readonly OutgoingMonitor[] {
    const monitorIds = this.outgoingByMonitoringServer.get(serverId);
    if (!monitorIds) {
      return [];
    }

    return [...monitorIds]
      .map(id => this.outgoing.get(id))
      .filter((m): m is OutgoingMonitor => m !== undefined);
  }

  // ==========================================================================
  // Incoming Monitor Operations
  // ==========================================================================

  /**
   * Adds an incoming monitor (remote node monitors our local process).
   *
   * @param monitor - Incoming monitor to add
   * @returns true if added, false if monitorId already exists
   */
  addIncoming(monitor: IncomingMonitor): boolean {
    if (this.incoming.has(monitor.monitorId)) {
      return false;
    }

    this.incoming.set(monitor.monitorId, monitor);
    this.totalAdded++;

    // Index by monitored server
    this.addToIndex(
      this.incomingByMonitoredServer,
      monitor.monitoredServerId,
      monitor.monitorId,
    );

    // Index by monitoring node
    this.addToIndex(
      this.incomingByMonitoringNode,
      monitor.monitoringRef.nodeId,
      monitor.monitorId,
    );

    return true;
  }

  /**
   * Gets an incoming monitor by its ID.
   *
   * @param monitorId - Monitor identifier
   * @returns Monitor if found, undefined otherwise
   */
  getIncoming(monitorId: MonitorId): IncomingMonitor | undefined {
    return this.incoming.get(monitorId);
  }

  /**
   * Removes an incoming monitor by its ID.
   *
   * @param monitorId - Monitor identifier
   * @returns Removed monitor if found, undefined otherwise
   */
  removeIncoming(monitorId: MonitorId): IncomingMonitor | undefined {
    const monitor = this.incoming.get(monitorId);
    if (!monitor) {
      return undefined;
    }

    this.incoming.delete(monitorId);
    this.totalRemoved++;

    // Remove from indexes
    this.removeFromIndex(
      this.incomingByMonitoredServer,
      monitor.monitoredServerId,
      monitorId,
    );
    this.removeFromIndex(
      this.incomingByMonitoringNode,
      monitor.monitoringRef.nodeId,
      monitorId,
    );

    return monitor;
  }

  /**
   * Removes all incoming monitors from a specific node.
   *
   * Called when a remote node goes down to clean up monitors
   * (no need to send process_down - the monitoring node is gone).
   *
   * @param nodeId - Node identifier
   * @returns Array of removed monitors
   */
  removeIncomingByNode(nodeId: NodeId): readonly IncomingMonitor[] {
    const monitorIds = this.incomingByMonitoringNode.get(nodeId);
    if (!monitorIds || monitorIds.size === 0) {
      return [];
    }

    const removed: IncomingMonitor[] = [];
    for (const monitorId of [...monitorIds]) {
      const monitor = this.removeIncoming(monitorId);
      if (monitor) {
        removed.push(monitor);
        this.nodeDisconnectRemovals++;
        this.totalRemoved--; // removeIncoming already incremented
      }
    }

    return removed;
  }

  /**
   * Gets all incoming monitors for a local server.
   *
   * Called when a local process terminates to send process_down to all monitors.
   *
   * @param serverId - Local server identifier
   * @returns Array of incoming monitors
   */
  getIncomingByMonitoredServer(serverId: string): readonly IncomingMonitor[] {
    const monitorIds = this.incomingByMonitoredServer.get(serverId);
    if (!monitorIds) {
      return [];
    }

    return [...monitorIds]
      .map(id => this.incoming.get(id))
      .filter((m): m is IncomingMonitor => m !== undefined);
  }

  /**
   * Removes all incoming monitors for a local server.
   *
   * Called when a local process terminates after sending process_down.
   *
   * @param serverId - Local server identifier
   * @returns Array of removed monitors
   */
  removeIncomingByMonitoredServer(serverId: string): readonly IncomingMonitor[] {
    const monitorIds = this.incomingByMonitoredServer.get(serverId);
    if (!monitorIds || monitorIds.size === 0) {
      return [];
    }

    const removed: IncomingMonitor[] = [];
    for (const monitorId of [...monitorIds]) {
      const monitor = this.removeIncoming(monitorId);
      if (monitor) {
        removed.push(monitor);
        this.processTerminationRemovals++;
        this.totalRemoved--; // removeIncoming already incremented
      }
    }

    return removed;
  }

  // ==========================================================================
  // Query Operations
  // ==========================================================================

  /**
   * Returns the number of outgoing monitors.
   */
  get outgoingCount(): number {
    return this.outgoing.size;
  }

  /**
   * Returns the number of incoming monitors.
   */
  get incomingCount(): number {
    return this.incoming.size;
  }

  /**
   * Returns the total number of monitors (outgoing + incoming).
   */
  get size(): number {
    return this.outgoing.size + this.incoming.size;
  }

  /**
   * Checks if a monitor exists (outgoing or incoming).
   *
   * @param monitorId - Monitor identifier
   * @returns true if monitor exists
   */
  has(monitorId: MonitorId): boolean {
    return this.outgoing.has(monitorId) || this.incoming.has(monitorId);
  }

  /**
   * Returns statistics about the registry.
   */
  getStats(): MonitorRegistryStats {
    return {
      outgoingCount: this.outgoing.size,
      incomingCount: this.incoming.size,
      totalAdded: this.totalAdded,
      totalRemoved: this.totalRemoved,
      nodeDisconnectRemovals: this.nodeDisconnectRemovals,
      processTerminationRemovals: this.processTerminationRemovals,
    };
  }

  /**
   * Clears all monitors from the registry.
   *
   * Used during shutdown or testing.
   */
  clear(): void {
    this.outgoing.clear();
    this.incoming.clear();
    this.outgoingByMonitoringServer.clear();
    this.outgoingByMonitoredServer.clear();
    this.outgoingByNode.clear();
    this.incomingByMonitoredServer.clear();
    this.incomingByMonitoringNode.clear();
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private addToIndex<K>(
    index: Map<K, Set<MonitorId>>,
    key: K,
    monitorId: MonitorId,
  ): void {
    let set = index.get(key);
    if (!set) {
      set = new Set();
      index.set(key, set);
    }
    set.add(monitorId);
  }

  private removeFromIndex<K>(
    index: Map<K, Set<MonitorId>>,
    key: K,
    monitorId: MonitorId,
  ): void {
    const set = index.get(key);
    if (set) {
      set.delete(monitorId);
      if (set.size === 0) {
        index.delete(key);
      }
    }
  }
}
