/**
 * Observer snapshot state management for the Svelte dashboard.
 *
 * @module stores/snapshot
 */

import { writable, derived, get } from 'svelte/store';
import type {
  ObserverSnapshot,
  GenServerStats,
  SupervisorStats,
  ProcessTreeNode,
  MemoryStats,
} from 'noex';
import { connection } from './connection.js';

// =============================================================================
// Types
// =============================================================================

const EMPTY_SNAPSHOT: ObserverSnapshot = {
  timestamp: 0,
  servers: [],
  supervisors: [],
  tree: [],
  processCount: 0,
  totalMessages: 0,
  totalRestarts: 0,
  memoryStats: {
    heapUsed: 0,
    heapTotal: 0,
    external: 0,
    rss: 0,
    timestamp: 0,
  },
};

export interface ProcessInfo {
  readonly id: string;
  readonly name?: string;
  readonly type: 'genserver' | 'supervisor';
  readonly stats: GenServerStats | SupervisorStats;
  readonly treeNode?: ProcessTreeNode;
}

// =============================================================================
// Snapshot Store Implementation
// =============================================================================

function createSnapshotStore() {
  const current = writable<ObserverSnapshot>(EMPTY_SNAPSHOT);
  const lastUpdateAt = writable<number>(0);

  // Derived stores
  const servers = derived(current, ($c) => $c.servers);
  const supervisors = derived(current, ($c) => $c.supervisors);
  const tree = derived(current, ($c) => $c.tree);
  const processCount = derived(current, ($c) => $c.processCount);
  const totalMessages = derived(current, ($c) => $c.totalMessages);
  const totalRestarts = derived(current, ($c) => $c.totalRestarts);
  const memoryStats = derived(current, ($c) => $c.memoryStats);
  const timestamp = derived(current, ($c) => $c.timestamp);
  const serverCount = derived(current, ($c) => $c.servers.length);
  const supervisorCount = derived(current, ($c) => $c.supervisors.length);
  const heapUsagePercent = derived(current, ($c) =>
    $c.memoryStats.heapTotal > 0 ? ($c.memoryStats.heapUsed / $c.memoryStats.heapTotal) * 100 : 0
  );
  const hasData = derived(current, ($c) => $c.timestamp > 0);

  // Subscribe to snapshot messages
  connection.onMessage('snapshot', (payload) => {
    current.set(payload);
    lastUpdateAt.set(Date.now());
  });

  function findServer(id: string): GenServerStats | undefined {
    return get(current).servers.find((s) => s.id === id);
  }

  function findSupervisor(id: string): SupervisorStats | undefined {
    return get(current).supervisors.find((s) => s.id === id);
  }

  function findTreeNode(id: string): ProcessTreeNode | undefined {
    function search(nodes: readonly ProcessTreeNode[]): ProcessTreeNode | undefined {
      for (const node of nodes) {
        if (node.id === id) return node;
        if (node.children) {
          const found = search(node.children);
          if (found) return found;
        }
      }
      return undefined;
    }
    return search(get(current).tree);
  }

  function findProcess(id: string): ProcessInfo | undefined {
    const server = findServer(id);
    if (server) {
      return { id: server.id, type: 'genserver', stats: server, treeNode: findTreeNode(id) };
    }
    const supervisor = findSupervisor(id);
    if (supervisor) {
      return { id: supervisor.id, type: 'supervisor', stats: supervisor, treeNode: findTreeNode(id) };
    }
    return undefined;
  }

  function refresh(): boolean {
    return connection.requestSnapshot();
  }

  function update(snapshot: ObserverSnapshot): void {
    current.set(snapshot);
    lastUpdateAt.set(Date.now());
  }

  function clear(): void {
    current.set(EMPTY_SNAPSHOT);
    lastUpdateAt.set(0);
  }

  return {
    current,
    lastUpdateAt,
    servers,
    supervisors,
    tree,
    processCount,
    totalMessages,
    totalRestarts,
    memoryStats,
    timestamp,
    serverCount,
    supervisorCount,
    heapUsagePercent,
    hasData,
    findServer,
    findSupervisor,
    findTreeNode,
    findProcess,
    refresh,
    update,
    clear,
  };
}

export const snapshot = createSnapshotStore();
export { createSnapshotStore };
export type { ObserverSnapshot, GenServerStats, SupervisorStats, ProcessTreeNode, MemoryStats };
