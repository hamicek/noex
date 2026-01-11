/**
 * Cluster state management for the Svelte dashboard.
 *
 * Provides reactive access to cluster-wide state with:
 * - Cluster availability status tracking
 * - Per-node snapshot data
 * - Aggregated cluster statistics
 * - Node health monitoring
 *
 * @module stores/cluster
 */

import type {
  ClusterObserverSnapshot,
  NodeObserverSnapshot,
  ClusterAggregatedStats,
  NodeObserverStatus,
} from 'noex';
import { connection } from './connection.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Cluster status information.
 */
export interface ClusterStatus {
  readonly available: boolean;
  readonly nodeId?: string;
}

/**
 * Empty cluster snapshot used as initial state.
 * Cast required because NodeId is a branded type in noex.
 */
const EMPTY_CLUSTER_SNAPSHOT = {
  timestamp: 0,
  localNodeId: '' as ClusterObserverSnapshot['localNodeId'],
  nodes: [] as ClusterObserverSnapshot['nodes'],
  aggregated: {
    totalProcessCount: 0,
    totalServerCount: 0,
    totalSupervisorCount: 0,
    totalMessages: 0,
    totalRestarts: 0,
    connectedNodeCount: 0,
    totalNodeCount: 0,
  },
} satisfies ClusterObserverSnapshot;

/**
 * Empty cluster status used as initial state.
 */
const EMPTY_STATUS: ClusterStatus = {
  available: false,
  nodeId: undefined,
};

// =============================================================================
// Cluster Store Implementation
// =============================================================================

/**
 * Creates a cluster state store with reactive state.
 *
 * @example
 * ```typescript
 * const cluster = createClusterStore();
 *
 * // Check availability
 * if (cluster.isAvailable) {
 *   console.log('Connected nodes:', cluster.connectedNodes.length);
 * }
 *
 * // Get node snapshot
 * const nodeSnapshot = cluster.getNodeSnapshot('node1@localhost:4369');
 * ```
 */
function createClusterStore() {
  // ---------------------------------------------------------------------------
  // Reactive State (Svelte 5 runes)
  // ---------------------------------------------------------------------------

  let status = $state<ClusterStatus>(EMPTY_STATUS);
  let snapshot = $state<ClusterObserverSnapshot>(EMPTY_CLUSTER_SNAPSHOT);
  let lastUpdateAt = $state<number>(0);

  // Derived state for cluster status
  const isAvailable = $derived(status.available);
  const localNodeId = $derived(status.nodeId ?? snapshot.localNodeId);

  // Derived state for nodes
  const nodes = $derived(snapshot.nodes);
  const nodeCount = $derived(snapshot.nodes.length);

  // Filter nodes by status
  const connectedNodes = $derived(
    snapshot.nodes.filter((n) => n.status === 'connected'),
  );
  const disconnectedNodes = $derived(
    snapshot.nodes.filter((n) => n.status === 'disconnected'),
  );
  const errorNodes = $derived(
    snapshot.nodes.filter((n) => n.status === 'error' || n.status === 'timeout'),
  );

  // Aggregated statistics
  const aggregated = $derived(snapshot.aggregated);
  const totalProcessCount = $derived(snapshot.aggregated.totalProcessCount);
  const totalServerCount = $derived(snapshot.aggregated.totalServerCount);
  const totalSupervisorCount = $derived(snapshot.aggregated.totalSupervisorCount);
  const connectedNodeCount = $derived(snapshot.aggregated.connectedNodeCount);

  // Health metrics
  const healthyNodePercent = $derived(
    snapshot.aggregated.totalNodeCount > 0
      ? (snapshot.aggregated.connectedNodeCount / snapshot.aggregated.totalNodeCount) * 100
      : 0,
  );

  const hasData = $derived(snapshot.timestamp > 0);
  const hasNodes = $derived(snapshot.nodes.length > 0);

  // ---------------------------------------------------------------------------
  // Internal Index for Fast Lookups
  // ---------------------------------------------------------------------------

  const nodeIndex = $derived(
    new Map(snapshot.nodes.map((n) => [n.nodeId, n])),
  );

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  function handleClusterStatus(payload: { available: boolean; nodeId?: string }): void {
    status = {
      available: payload.available,
      nodeId: payload.nodeId,
    };
  }

  function handleClusterSnapshot(payload: ClusterObserverSnapshot): void {
    snapshot = payload;
    lastUpdateAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // WebSocket Integration
  // ---------------------------------------------------------------------------

  // Subscribe to cluster messages from WebSocket
  connection.onMessage('cluster_status', handleClusterStatus);
  connection.onMessage('cluster_snapshot', handleClusterSnapshot);

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Gets a node snapshot by node ID.
   *
   * @param nodeId - Node ID to look up (string format: name@host:port)
   * @returns Node snapshot or undefined
   */
  function getNodeSnapshot(nodeId: string): NodeObserverSnapshot | undefined {
    // Cast required because NodeId is a branded type
    return nodeIndex.get(nodeId as NodeObserverSnapshot['nodeId']);
  }

  /**
   * Checks if a node is connected.
   *
   * @param nodeId - Node ID to check (string format: name@host:port)
   * @returns Whether the node is connected
   */
  function isNodeConnected(nodeId: string): boolean {
    const node = getNodeSnapshot(nodeId);
    return node?.status === 'connected';
  }

  /**
   * Gets all nodes with a specific status.
   *
   * @param nodeStatus - Status to filter by
   * @returns Nodes with matching status
   */
  function filterNodesByStatus(nodeStatus: NodeObserverStatus): readonly NodeObserverSnapshot[] {
    return snapshot.nodes.filter((n) => n.status === nodeStatus);
  }

  /**
   * Gets nodes sorted by their last update time.
   *
   * @param order - Sort order
   * @returns Sorted nodes
   */
  function sortNodesByLastUpdate(order: 'asc' | 'desc' = 'desc'): readonly NodeObserverSnapshot[] {
    return [...snapshot.nodes].sort((a, b) =>
      order === 'desc' ? b.lastUpdate - a.lastUpdate : a.lastUpdate - b.lastUpdate,
    );
  }

  /**
   * Gets nodes sorted by their process count.
   *
   * @param order - Sort order
   * @returns Sorted nodes (only connected nodes with snapshots)
   */
  function sortNodesByProcessCount(order: 'asc' | 'desc' = 'desc'): readonly NodeObserverSnapshot[] {
    return connectedNodes
      .filter((n) => n.snapshot !== null)
      .sort((a, b) => {
        const aCount = a.snapshot?.processCount ?? 0;
        const bCount = b.snapshot?.processCount ?? 0;
        return order === 'desc' ? bCount - aCount : aCount - bCount;
      });
  }

  /**
   * Gets the node with the most processes.
   *
   * @returns Node with most processes or undefined
   */
  function getBusiestNode(): NodeObserverSnapshot | undefined {
    return sortNodesByProcessCount('desc')[0];
  }

  /**
   * Gets the total message count across all nodes.
   */
  function getTotalMessages(): number {
    return snapshot.aggregated.totalMessages;
  }

  /**
   * Gets the total restart count across all nodes.
   */
  function getTotalRestarts(): number {
    return snapshot.aggregated.totalRestarts;
  }

  /**
   * Calculates the average process count per connected node.
   */
  function getAverageProcessCount(): number {
    if (snapshot.aggregated.connectedNodeCount === 0) {
      return 0;
    }
    return snapshot.aggregated.totalProcessCount / snapshot.aggregated.connectedNodeCount;
  }

  /**
   * Requests a cluster status update from the server.
   */
  function refreshStatus(): boolean {
    return connection.requestClusterStatus();
  }

  /**
   * Requests a cluster snapshot from the server.
   */
  function refresh(): boolean {
    return connection.requestClusterSnapshot();
  }

  /**
   * Manually updates the cluster snapshot.
   * Primarily for testing or external data sources.
   *
   * @param newSnapshot - New cluster snapshot
   */
  function update(newSnapshot: ClusterObserverSnapshot): void {
    snapshot = newSnapshot;
    lastUpdateAt = Date.now();
  }

  /**
   * Manually updates the cluster status.
   * Primarily for testing or external data sources.
   *
   * @param newStatus - New cluster status
   */
  function updateStatus(newStatus: ClusterStatus): void {
    status = newStatus;
  }

  /**
   * Clears all cluster data.
   */
  function clear(): void {
    status = EMPTY_STATUS;
    snapshot = EMPTY_CLUSTER_SNAPSHOT;
    lastUpdateAt = 0;
  }

  // ---------------------------------------------------------------------------
  // Store Object
  // ---------------------------------------------------------------------------

  return {
    // Status
    get status() { return status; },
    get isAvailable() { return isAvailable; },
    get localNodeId() { return localNodeId; },

    // Snapshot access
    get snapshot() { return snapshot; },
    get lastUpdateAt() { return lastUpdateAt; },
    get hasData() { return hasData; },
    get hasNodes() { return hasNodes; },

    // Node access
    get nodes() { return nodes; },
    get nodeCount() { return nodeCount; },
    get connectedNodes() { return connectedNodes; },
    get disconnectedNodes() { return disconnectedNodes; },
    get errorNodes() { return errorNodes; },

    // Aggregated stats
    get aggregated() { return aggregated; },
    get totalProcessCount() { return totalProcessCount; },
    get totalServerCount() { return totalServerCount; },
    get totalSupervisorCount() { return totalSupervisorCount; },
    get connectedNodeCount() { return connectedNodeCount; },
    get healthyNodePercent() { return healthyNodePercent; },

    // Lookup methods
    getNodeSnapshot,
    isNodeConnected,
    filterNodesByStatus,

    // Query methods
    sortNodesByLastUpdate,
    sortNodesByProcessCount,
    getBusiestNode,
    getTotalMessages,
    getTotalRestarts,
    getAverageProcessCount,

    // Mutation methods
    refreshStatus,
    refresh,
    update,
    updateStatus,
    clear,
  };
}

// =============================================================================
// Singleton Export
// =============================================================================

/**
 * Global cluster store instance.
 *
 * Provides reactive access to cluster-wide state.
 * Automatically updates when cluster messages are received.
 */
export const cluster = createClusterStore();

// Export factory for testing
export { createClusterStore };

// Re-export types for convenience
export type { ClusterObserverSnapshot, NodeObserverSnapshot, ClusterAggregatedStats, NodeObserverStatus };
