/**
 * Observer snapshot state management for the Svelte dashboard.
 *
 * Provides reactive access to the current system state snapshot with:
 * - Full snapshot data with derived accessors
 * - Automatic updates from WebSocket connection
 * - Process lookup utilities
 * - Memory statistics tracking
 *
 * @module stores/snapshot
 */

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

/**
 * Empty snapshot used as initial state.
 */
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

/**
 * Process lookup result with combined metadata.
 */
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

/**
 * Creates an observer snapshot store with reactive state.
 *
 * @example
 * ```typescript
 * const snapshot = createSnapshotStore();
 *
 * // Access reactive state
 * console.log(snapshot.processCount);
 * console.log(snapshot.servers);
 *
 * // Find a process
 * const process = snapshot.findProcess('my-server-id');
 * ```
 */
function createSnapshotStore() {
  // ---------------------------------------------------------------------------
  // Reactive State (Svelte 5 runes)
  // ---------------------------------------------------------------------------

  let current = $state<ObserverSnapshot>(EMPTY_SNAPSHOT);
  let lastUpdateAt = $state<number>(0);

  // Derived state for convenient access
  const servers = $derived(current.servers);
  const supervisors = $derived(current.supervisors);
  const tree = $derived(current.tree);
  const processCount = $derived(current.processCount);
  const totalMessages = $derived(current.totalMessages);
  const totalRestarts = $derived(current.totalRestarts);
  const memoryStats = $derived(current.memoryStats);
  const timestamp = $derived(current.timestamp);

  // Computed statistics
  const serverCount = $derived(current.servers.length);
  const supervisorCount = $derived(current.supervisors.length);

  // Memory usage as percentage
  const heapUsagePercent = $derived(
    current.memoryStats.heapTotal > 0
      ? (current.memoryStats.heapUsed / current.memoryStats.heapTotal) * 100
      : 0,
  );

  // Has any data
  const hasData = $derived(current.timestamp > 0);

  // Age of the snapshot in milliseconds
  const age = $derived(
    lastUpdateAt > 0 ? Date.now() - lastUpdateAt : 0,
  );

  // ---------------------------------------------------------------------------
  // Internal Index for Fast Lookups
  // ---------------------------------------------------------------------------

  // Build lookup indices on every update
  const serverIndex = $derived(
    new Map(current.servers.map((s) => [s.id, s])),
  );

  const supervisorIndex = $derived(
    new Map(current.supervisors.map((s) => [s.id, s])),
  );

  // Build flattened tree index for node lookups
  const treeNodeIndex = $derived(() => {
    const index = new Map<string, ProcessTreeNode>();

    function traverse(nodes: readonly ProcessTreeNode[]): void {
      for (const node of nodes) {
        index.set(node.id, node);
        if (node.children) {
          traverse(node.children);
        }
      }
    }

    traverse(current.tree);
    return index;
  });

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  function handleSnapshot(payload: ObserverSnapshot): void {
    current = payload;
    lastUpdateAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // WebSocket Integration
  // ---------------------------------------------------------------------------

  // Subscribe to snapshot messages from WebSocket
  connection.onMessage('snapshot', handleSnapshot);

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Finds a GenServer by ID.
   *
   * @param id - GenServer ID
   * @returns GenServer stats or undefined
   */
  function findServer(id: string): GenServerStats | undefined {
    return serverIndex.get(id);
  }

  /**
   * Finds a Supervisor by ID.
   *
   * @param id - Supervisor ID
   * @returns Supervisor stats or undefined
   */
  function findSupervisor(id: string): SupervisorStats | undefined {
    return supervisorIndex.get(id);
  }

  /**
   * Finds a process tree node by ID.
   *
   * @param id - Process ID
   * @returns Tree node or undefined
   */
  function findTreeNode(id: string): ProcessTreeNode | undefined {
    return treeNodeIndex().get(id);
  }

  /**
   * Finds any process (server or supervisor) by ID.
   * Returns combined process information.
   *
   * @param id - Process ID
   * @returns Process info or undefined
   */
  function findProcess(id: string): ProcessInfo | undefined {
    const server = findServer(id);
    if (server) {
      return {
        id: server.id,
        type: 'genserver',
        stats: server,
        treeNode: findTreeNode(id),
      };
    }

    const supervisor = findSupervisor(id);
    if (supervisor) {
      return {
        id: supervisor.id,
        type: 'supervisor',
        stats: supervisor,
        treeNode: findTreeNode(id),
      };
    }

    return undefined;
  }

  /**
   * Filters servers by status.
   *
   * @param status - Status to filter by
   * @returns Array of matching servers
   */
  function filterServersByStatus(status: GenServerStats['status']): readonly GenServerStats[] {
    return current.servers.filter((s) => s.status === status);
  }

  /**
   * Gets servers sorted by a specific metric.
   *
   * @param metric - Metric to sort by
   * @param order - Sort order
   * @returns Sorted array of servers
   */
  function sortServersBy(
    metric: 'queueSize' | 'messageCount' | 'uptimeMs' | 'stateMemoryBytes',
    order: 'asc' | 'desc' = 'desc',
  ): readonly GenServerStats[] {
    return [...current.servers].sort((a, b) => {
      const aVal = a[metric] ?? 0;
      const bVal = b[metric] ?? 0;
      return order === 'desc' ? bVal - aVal : aVal - bVal;
    });
  }

  /**
   * Gets servers with non-zero queue size (potentially busy).
   */
  function getBusyServers(): readonly GenServerStats[] {
    return current.servers.filter((s) => s.queueSize > 0);
  }

  /**
   * Gets the top N servers by message count.
   *
   * @param n - Number of servers to return
   */
  function getTopServersByMessages(n: number): readonly GenServerStats[] {
    return sortServersBy('messageCount', 'desc').slice(0, n);
  }

  /**
   * Calculates the total state memory across all servers.
   */
  function getTotalStateMemory(): number {
    return current.servers.reduce(
      (sum, s) => sum + (s.stateMemoryBytes ?? 0),
      0,
    );
  }

  /**
   * Manually updates the snapshot.
   * Primarily for testing or external data sources.
   *
   * @param snapshot - New snapshot data
   */
  function update(snapshot: ObserverSnapshot): void {
    current = snapshot;
    lastUpdateAt = Date.now();
  }

  /**
   * Requests a snapshot refresh from the server.
   */
  function refresh(): boolean {
    return connection.requestSnapshot();
  }

  /**
   * Clears the current snapshot data.
   */
  function clear(): void {
    current = EMPTY_SNAPSHOT;
    lastUpdateAt = 0;
  }

  // ---------------------------------------------------------------------------
  // Store Object
  // ---------------------------------------------------------------------------

  return {
    // Raw snapshot access
    get current() { return current; },
    get lastUpdateAt() { return lastUpdateAt; },

    // Derived accessors
    get servers() { return servers; },
    get supervisors() { return supervisors; },
    get tree() { return tree; },
    get processCount() { return processCount; },
    get totalMessages() { return totalMessages; },
    get totalRestarts() { return totalRestarts; },
    get memoryStats() { return memoryStats; },
    get timestamp() { return timestamp; },

    // Computed statistics
    get serverCount() { return serverCount; },
    get supervisorCount() { return supervisorCount; },
    get heapUsagePercent() { return heapUsagePercent; },
    get hasData() { return hasData; },
    get age() { return age; },

    // Lookup methods
    findServer,
    findSupervisor,
    findTreeNode,
    findProcess,

    // Query methods
    filterServersByStatus,
    sortServersBy,
    getBusyServers,
    getTopServersByMessages,
    getTotalStateMemory,

    // Mutation methods
    update,
    refresh,
    clear,
  };
}

// =============================================================================
// Singleton Export
// =============================================================================

/**
 * Global snapshot store instance.
 *
 * Provides reactive access to the current system state snapshot.
 * Automatically updates when snapshot messages are received.
 */
export const snapshot = createSnapshotStore();

// Export factory for testing
export { createSnapshotStore };

// Re-export types for convenience
export type { ObserverSnapshot, GenServerStats, SupervisorStats, ProcessTreeNode, MemoryStats };
