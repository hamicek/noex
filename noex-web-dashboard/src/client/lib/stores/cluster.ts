/**
 * Cluster state management for the Svelte dashboard.
 *
 * @module stores/cluster
 */

import { writable, derived, get } from 'svelte/store';
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

export interface ClusterStatus {
  readonly available: boolean;
  readonly nodeId?: string;
}

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

const EMPTY_STATUS: ClusterStatus = {
  available: false,
  nodeId: undefined,
};

// =============================================================================
// Cluster Store Implementation
// =============================================================================

function createClusterStore() {
  const status = writable<ClusterStatus>(EMPTY_STATUS);
  const snapshot = writable<ClusterObserverSnapshot>(EMPTY_CLUSTER_SNAPSHOT);
  const lastUpdateAt = writable<number>(0);

  // Derived stores
  const isAvailable = derived(status, ($s) => $s.available);
  const localNodeId = derived([status, snapshot], ([$s, $snap]) => $s.nodeId ?? $snap.localNodeId);
  const nodes = derived(snapshot, ($snap) => $snap.nodes);
  const nodeCount = derived(snapshot, ($snap) => $snap.nodes.length);
  const connectedNodes = derived(snapshot, ($snap) => $snap.nodes.filter((n) => n.status === 'connected'));
  const disconnectedNodes = derived(snapshot, ($snap) => $snap.nodes.filter((n) => n.status === 'disconnected'));
  const aggregated = derived(snapshot, ($snap) => $snap.aggregated);
  const totalProcessCount = derived(snapshot, ($snap) => $snap.aggregated.totalProcessCount);
  const totalServerCount = derived(snapshot, ($snap) => $snap.aggregated.totalServerCount);
  const connectedNodeCount = derived(snapshot, ($snap) => $snap.aggregated.connectedNodeCount);
  const hasData = derived(snapshot, ($snap) => $snap.timestamp > 0);
  const hasNodes = derived(snapshot, ($snap) => $snap.nodes.length > 0);
  const healthyNodePercent = derived(snapshot, ($snap) =>
    $snap.aggregated.totalNodeCount > 0
      ? ($snap.aggregated.connectedNodeCount / $snap.aggregated.totalNodeCount) * 100
      : 0
  );

  // Subscribe to cluster messages
  connection.onMessage('cluster_status', (payload) => {
    status.set({ available: payload.available, nodeId: payload.nodeId });
  });

  connection.onMessage('cluster_snapshot', (payload) => {
    snapshot.set(payload);
    lastUpdateAt.set(Date.now());
  });

  function getNodeSnapshot(nodeId: string): NodeObserverSnapshot | undefined {
    return get(snapshot).nodes.find((n) => n.nodeId === nodeId);
  }

  function isNodeConnected(nodeId: string): boolean {
    const node = getNodeSnapshot(nodeId);
    return node?.status === 'connected';
  }

  function refresh(): boolean {
    return connection.requestClusterSnapshot();
  }

  function refreshStatus(): boolean {
    return connection.requestClusterStatus();
  }

  function clear(): void {
    status.set(EMPTY_STATUS);
    snapshot.set(EMPTY_CLUSTER_SNAPSHOT);
    lastUpdateAt.set(0);
  }

  return {
    status,
    isAvailable,
    localNodeId,
    snapshot,
    lastUpdateAt,
    hasData,
    hasNodes,
    nodes,
    nodeCount,
    connectedNodes,
    disconnectedNodes,
    aggregated,
    totalProcessCount,
    totalServerCount,
    connectedNodeCount,
    healthyNodePercent,
    getNodeSnapshot,
    isNodeConnected,
    refresh,
    refreshStatus,
    clear,
  };
}

export const cluster = createClusterStore();
export { createClusterStore };
export type { ClusterObserverSnapshot, NodeObserverSnapshot, ClusterAggregatedStats, NodeObserverStatus };
