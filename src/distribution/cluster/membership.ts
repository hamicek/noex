/**
 * Cluster membership management.
 *
 * Tracks the state of all nodes in the cluster, handles heartbeat-based
 * failure detection, and manages node lifecycle events.
 *
 * @module distribution/cluster/membership
 */

import { EventEmitter } from 'node:events';

import type {
  NodeId,
  NodeInfo,
  NodeStatus,
  NodeDownReason,
  NodeUpHandler,
  NodeDownHandler,
} from '../types.js';
import { CLUSTER_DEFAULTS } from '../types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for membership tracking.
 */
export interface MembershipConfig {
  /** Local node identifier */
  readonly localNodeId: NodeId;

  /** Heartbeat interval in milliseconds */
  readonly heartbeatIntervalMs?: number;

  /** Number of missed heartbeats before marking node as down */
  readonly heartbeatMissThreshold?: number;
}

/**
 * Events emitted by Membership.
 */
export interface MembershipEvents {
  /** Emitted when a node joins the cluster */
  nodeUp: [node: NodeInfo];

  /** Emitted when a node leaves the cluster */
  nodeDown: [nodeId: NodeId, reason: NodeDownReason];

  /** Emitted when a node's info is updated */
  nodeUpdated: [node: NodeInfo];
}

/**
 * Internal node state with timing information.
 */
interface NodeState {
  /** Current node information */
  info: NodeInfo;

  /** Timestamp of last received heartbeat */
  lastHeartbeatReceivedAt: number;

  /** Timer for failure detection */
  failureTimer: ReturnType<typeof setTimeout> | null;
}

// =============================================================================
// Membership Class
// =============================================================================

/**
 * Manages cluster membership and node state tracking.
 *
 * Responsibilities:
 * - Track all known nodes and their current status
 * - Detect node failures via heartbeat timeout
 * - Emit events for membership changes
 *
 * @example
 * ```typescript
 * const membership = new Membership({
 *   localNodeId: NodeId.parse('app1@192.168.1.1:4369'),
 * });
 *
 * membership.on('nodeUp', (node) => {
 *   console.log(`Node joined: ${node.id}`);
 * });
 *
 * membership.on('nodeDown', (nodeId, reason) => {
 *   console.log(`Node left: ${nodeId}, reason: ${reason}`);
 * });
 *
 * // Update node on heartbeat received
 * membership.updateNode(nodeInfo);
 *
 * // Check if node is alive
 * if (membership.isNodeAlive(nodeId)) {
 *   // ...
 * }
 * ```
 */
export class Membership extends EventEmitter<MembershipEvents> {
  private readonly nodes = new Map<NodeId, NodeState>();
  private readonly config: Required<MembershipConfig>;

  constructor(config: MembershipConfig) {
    super();

    this.config = {
      localNodeId: config.localNodeId,
      heartbeatIntervalMs:
        config.heartbeatIntervalMs ?? CLUSTER_DEFAULTS.HEARTBEAT_INTERVAL_MS,
      heartbeatMissThreshold:
        config.heartbeatMissThreshold ?? CLUSTER_DEFAULTS.HEARTBEAT_MISS_THRESHOLD,
    };
  }

  /**
   * Returns the local node identifier.
   */
  getLocalNodeId(): NodeId {
    return this.config.localNodeId;
  }

  /**
   * Returns information about all known nodes.
   *
   * @returns Array of node information objects
   */
  getNodes(): readonly NodeInfo[] {
    return Array.from(this.nodes.values()).map((state) => state.info);
  }

  /**
   * Returns information about connected nodes only.
   *
   * @returns Array of connected node information objects
   */
  getConnectedNodes(): readonly NodeInfo[] {
    return Array.from(this.nodes.values())
      .filter((state) => state.info.status === 'connected')
      .map((state) => state.info);
  }

  /**
   * Returns the node identifiers of all known nodes.
   *
   * @returns Array of node identifiers
   */
  getNodeIds(): readonly NodeId[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Returns information about a specific node.
   *
   * @param nodeId - Node identifier to look up
   * @returns Node information or undefined if not found
   */
  getNode(nodeId: NodeId): NodeInfo | undefined {
    return this.nodes.get(nodeId)?.info;
  }

  /**
   * Checks if a node is known to the membership.
   *
   * @param nodeId - Node identifier to check
   * @returns true if the node is known
   */
  hasNode(nodeId: NodeId): boolean {
    return this.nodes.has(nodeId);
  }

  /**
   * Checks if a node is currently connected.
   *
   * @param nodeId - Node identifier to check
   * @returns true if the node is connected
   */
  isNodeConnected(nodeId: NodeId): boolean {
    const state = this.nodes.get(nodeId);
    return state?.info.status === 'connected';
  }

  /**
   * Updates node information from a received heartbeat.
   *
   * If the node is new, emits 'nodeUp' event.
   * If the node status changed, emits 'nodeUpdated' event.
   * Resets the failure detection timer.
   *
   * @param nodeInfo - Updated node information
   */
  updateNode(nodeInfo: NodeInfo): void {
    // Don't track self
    if (nodeInfo.id === this.config.localNodeId) {
      return;
    }

    const existing = this.nodes.get(nodeInfo.id);
    const now = Date.now();

    if (!existing) {
      // New node joining
      const state: NodeState = {
        info: { ...nodeInfo, status: 'connected' },
        lastHeartbeatReceivedAt: now,
        failureTimer: null,
      };

      this.nodes.set(nodeInfo.id, state);
      this.scheduleFailureDetection(nodeInfo.id);
      this.emit('nodeUp', state.info);
    } else {
      // Update existing node
      const previousStatus = existing.info.status;
      existing.info = { ...nodeInfo, status: 'connected' };
      existing.lastHeartbeatReceivedAt = now;

      this.resetFailureDetection(nodeInfo.id);

      if (previousStatus !== 'connected') {
        this.emit('nodeUp', existing.info);
      } else {
        this.emit('nodeUpdated', existing.info);
      }
    }
  }

  /**
   * Marks a node as disconnected with the given reason.
   *
   * Clears failure detection timer and emits 'nodeDown' event.
   *
   * @param nodeId - Node identifier
   * @param reason - Reason for disconnection
   */
  markNodeDown(nodeId: NodeId, reason: NodeDownReason): void {
    const state = this.nodes.get(nodeId);
    if (!state) {
      return;
    }

    if (state.info.status === 'disconnected') {
      return;
    }

    // Clear failure timer
    if (state.failureTimer) {
      clearTimeout(state.failureTimer);
      state.failureTimer = null;
    }

    // Update status
    state.info = { ...state.info, status: 'disconnected' };

    this.emit('nodeDown', nodeId, reason);
  }

  /**
   * Removes a node from membership tracking.
   *
   * @param nodeId - Node identifier to remove
   * @returns true if the node was removed
   */
  removeNode(nodeId: NodeId): boolean {
    const state = this.nodes.get(nodeId);
    if (!state) {
      return false;
    }

    // Clear failure timer
    if (state.failureTimer) {
      clearTimeout(state.failureTimer);
    }

    // Emit nodeDown if node was connected
    if (state.info.status === 'connected') {
      this.emit('nodeDown', nodeId, 'graceful_shutdown');
    }

    return this.nodes.delete(nodeId);
  }

  /**
   * Removes all nodes and clears all timers.
   */
  clear(): void {
    for (const state of this.nodes.values()) {
      if (state.failureTimer) {
        clearTimeout(state.failureTimer);
      }
    }
    this.nodes.clear();
  }

  /**
   * Returns the number of known nodes.
   */
  get size(): number {
    return this.nodes.size;
  }

  /**
   * Returns the number of connected nodes.
   */
  get connectedCount(): number {
    return Array.from(this.nodes.values()).filter(
      (state) => state.info.status === 'connected',
    ).length;
  }

  /**
   * Calculates the failure detection timeout.
   *
   * Based on heartbeat interval and miss threshold.
   */
  private getFailureTimeoutMs(): number {
    return this.config.heartbeatIntervalMs * this.config.heartbeatMissThreshold;
  }

  /**
   * Schedules failure detection for a node.
   *
   * @param nodeId - Node identifier
   */
  private scheduleFailureDetection(nodeId: NodeId): void {
    const state = this.nodes.get(nodeId);
    if (!state) {
      return;
    }

    state.failureTimer = setTimeout(() => {
      this.handleFailureTimeout(nodeId);
    }, this.getFailureTimeoutMs());
  }

  /**
   * Resets the failure detection timer for a node.
   *
   * @param nodeId - Node identifier
   */
  private resetFailureDetection(nodeId: NodeId): void {
    const state = this.nodes.get(nodeId);
    if (!state) {
      return;
    }

    if (state.failureTimer) {
      clearTimeout(state.failureTimer);
    }

    this.scheduleFailureDetection(nodeId);
  }

  /**
   * Handles failure detection timeout.
   *
   * @param nodeId - Node identifier that timed out
   */
  private handleFailureTimeout(nodeId: NodeId): void {
    const state = this.nodes.get(nodeId);
    if (!state) {
      return;
    }

    // Only mark as down if still connected
    if (state.info.status === 'connected') {
      this.markNodeDown(nodeId, 'heartbeat_timeout');
    }
  }
}
