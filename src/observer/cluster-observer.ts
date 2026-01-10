/**
 * ClusterObserver - Distributed process monitoring across cluster nodes.
 *
 * Provides cluster-wide process introspection by aggregating snapshots
 * from all nodes in the cluster. While the standard Observer monitors
 * only local processes, ClusterObserver queries remote nodes via the
 * Observer Service and combines the results.
 *
 * @module observer/cluster-observer
 */

import type { NodeId } from '../distribution/types.js';
import { Cluster } from '../distribution/cluster/cluster.js';
import { RemoteCall } from '../distribution/remote/remote-call.js';
import { Observer } from './observer.js';
import { OBSERVER_SERVICE_NAME } from './observer-service.js';
import type {
  ObserverSnapshot,
  ObserverServiceCallMessage,
  ObserverServiceCallReply,
  ClusterObserverSnapshot,
  NodeObserverSnapshot,
  ClusterAggregatedStats,
  ClusterObserverEvent,
  ClusterObserverEventHandler,
  ClusterSnapshotOptions,
} from './types.js';

// =============================================================================
// Constants
// =============================================================================

/** Default timeout for remote observer queries in milliseconds */
const DEFAULT_TIMEOUT_MS = 5000;

/** Default cache TTL in milliseconds */
const DEFAULT_CACHE_TTL_MS = 2000;

// =============================================================================
// Types
// =============================================================================

/**
 * Internal cache structure for cluster snapshots.
 */
interface CachedClusterSnapshot {
  readonly snapshot: ClusterObserverSnapshot;
  readonly timestamp: number;
}

// =============================================================================
// ClusterObserver Implementation
// =============================================================================

/**
 * ClusterObserver implementation class.
 *
 * This is a singleton that maintains cache and subscriber state
 * for cluster-wide observer queries.
 */
class ClusterObserverImpl {
  /** Cached cluster snapshot */
  private cache: CachedClusterSnapshot | null = null;

  /** Set of event subscribers */
  private readonly subscribers = new Set<ClusterObserverEventHandler>();

  /** Polling timer reference */
  private pollingTimer: ReturnType<typeof setInterval> | null = null;

  /** Number of active polling subscribers */
  private pollingSubscriberCount = 0;

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Retrieves an aggregated snapshot from all nodes in the cluster.
   *
   * Queries each connected node's Observer Service in parallel and
   * aggregates the results. Uses caching to reduce network traffic.
   *
   * @param options - Snapshot options
   * @returns Promise resolving to cluster snapshot
   * @throws {Error} If cluster is not running
   *
   * @example
   * ```typescript
   * const snapshot = await ClusterObserver.getClusterSnapshot();
   *
   * console.log(`Cluster has ${snapshot.aggregated.totalProcessCount} processes`);
   * console.log(`Across ${snapshot.aggregated.connectedNodeCount} nodes`);
   *
   * for (const node of snapshot.nodes) {
   *   if (node.status === 'connected' && node.snapshot) {
   *     console.log(`${node.nodeId}: ${node.snapshot.processCount} processes`);
   *   }
   * }
   * ```
   */
  async getClusterSnapshot(options?: ClusterSnapshotOptions): Promise<ClusterObserverSnapshot> {
    const { useCache = true, timeout = DEFAULT_TIMEOUT_MS } = options ?? {};

    // Return cached data if valid and caching is enabled
    if (useCache && this.isCacheValid()) {
      return this.cache!.snapshot;
    }

    // Verify cluster is running
    if (Cluster.getStatus() !== 'running') {
      throw new Error('Cluster is not running. Call Cluster.start() first.');
    }

    const localNodeId = Cluster.getLocalNodeId();
    const connectedNodes = Cluster.getConnectedNodes();

    // Get local snapshot synchronously
    const localSnapshot = Observer.getSnapshot();
    const nodeSnapshots: NodeObserverSnapshot[] = [
      {
        nodeId: localNodeId,
        status: 'connected',
        snapshot: localSnapshot,
        lastUpdate: Date.now(),
      },
    ];

    // Query remote nodes in parallel
    const remotePromises = connectedNodes.map((node) =>
      this.fetchNodeSnapshot(node.id, timeout),
    );

    const remoteResults = await Promise.allSettled(remotePromises);

    // Collect results
    for (const result of remoteResults) {
      if (result.status === 'fulfilled') {
        nodeSnapshots.push(result.value);
      }
      // Rejected promises indicate internal errors, not node errors
      // Node errors are captured in the fulfilled NodeObserverSnapshot
    }

    // Aggregate statistics
    const aggregated = this.aggregateStats(nodeSnapshots);

    const clusterSnapshot: ClusterObserverSnapshot = {
      timestamp: Date.now(),
      localNodeId,
      nodes: nodeSnapshots,
      aggregated,
    };

    // Update cache
    this.cache = {
      snapshot: clusterSnapshot,
      timestamp: Date.now(),
    };

    return clusterSnapshot;
  }

  /**
   * Retrieves an observer snapshot from a specific remote node.
   *
   * @param nodeId - Target node identifier
   * @param timeout - Query timeout in milliseconds
   * @returns Promise resolving to the node's observer snapshot
   * @throws {Error} If cluster is not running
   * @throws {Error} If node is not reachable
   * @throws {Error} If query fails
   *
   * @example
   * ```typescript
   * const remoteSnapshot = await ClusterObserver.getNodeSnapshot(
   *   'app2@192.168.1.2:4369' as NodeId
   * );
   * console.log(`Remote node has ${remoteSnapshot.processCount} processes`);
   * ```
   */
  async getNodeSnapshot(nodeId: NodeId, timeout = DEFAULT_TIMEOUT_MS): Promise<ObserverSnapshot> {
    // Verify cluster is running
    if (Cluster.getStatus() !== 'running') {
      throw new Error('Cluster is not running. Call Cluster.start() first.');
    }

    const localNodeId = Cluster.getLocalNodeId();

    // If querying local node, return local snapshot directly
    if (nodeId === localNodeId) {
      return Observer.getSnapshot();
    }

    // Query remote node via Observer Service
    const reply = await RemoteCall.call<ObserverServiceCallReply>(
      {
        id: OBSERVER_SERVICE_NAME,
        nodeId,
      },
      { type: 'get_snapshot' } satisfies ObserverServiceCallMessage,
      { timeout },
    );

    if (reply.type === 'error') {
      throw new Error(`Observer service error: ${reply.message}`);
    }

    if (reply.type !== 'snapshot') {
      throw new Error(`Unexpected reply type: ${reply.type}`);
    }

    return reply.data;
  }

  /**
   * Starts periodic polling for cluster-wide snapshots.
   *
   * Fetches fresh cluster snapshots at the specified interval and
   * emits 'cluster_snapshot_update' events to the provided handler.
   *
   * Multiple calls with different handlers share the same polling timer.
   * The timer stops when all handlers have unsubscribed.
   *
   * @param intervalMs - Polling interval in milliseconds
   * @param handler - Event handler for snapshot updates
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const stopPolling = ClusterObserver.startPolling(5000, (event) => {
   *   if (event.type === 'cluster_snapshot_update') {
   *     updateDashboard(event.snapshot);
   *   }
   * });
   *
   * // Later: stop polling
   * stopPolling();
   * ```
   */
  startPolling(intervalMs: number, handler: ClusterObserverEventHandler): () => void {
    this.subscribers.add(handler);
    this.pollingSubscriberCount++;

    // Start polling if this is the first subscriber
    if (this.pollingTimer === null) {
      this.pollingTimer = setInterval(() => {
        this.pollCluster();
      }, intervalMs);

      // Emit initial snapshot immediately
      this.pollCluster();
    }

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(handler);
      this.pollingSubscriberCount--;

      // Stop polling if no more subscribers
      if (this.pollingSubscriberCount === 0 && this.pollingTimer !== null) {
        clearInterval(this.pollingTimer);
        this.pollingTimer = null;
      }
    };
  }

  /**
   * Subscribes to cluster observer events without starting polling.
   *
   * Events are emitted during polling started by startPolling().
   * This allows multiple listeners without starting additional timers.
   *
   * @param handler - Event handler
   * @returns Unsubscribe function
   */
  subscribe(handler: ClusterObserverEventHandler): () => void {
    this.subscribers.add(handler);

    return () => {
      this.subscribers.delete(handler);
    };
  }

  /**
   * Invalidates the cached cluster snapshot.
   *
   * The next call to getClusterSnapshot() will fetch fresh data
   * even if useCache is true.
   */
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Returns the current cache status.
   *
   * Useful for debugging and testing.
   *
   * @returns Cache information or null if no cache
   */
  getCacheStatus(): { readonly timestamp: number; readonly age: number } | null {
    if (this.cache === null) {
      return null;
    }

    return {
      timestamp: this.cache.timestamp,
      age: Date.now() - this.cache.timestamp,
    };
  }

  /**
   * Resets the ClusterObserver state.
   *
   * Stops polling, clears cache, and removes all subscribers.
   * Primarily used for testing.
   *
   * @internal
   */
  _reset(): void {
    if (this.pollingTimer !== null) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.cache = null;
    this.subscribers.clear();
    this.pollingSubscriberCount = 0;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Checks if the cache is valid.
   */
  private isCacheValid(): boolean {
    if (this.cache === null) {
      return false;
    }
    return Date.now() - this.cache.timestamp < DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Fetches snapshot from a remote node, handling errors gracefully.
   */
  private async fetchNodeSnapshot(
    nodeId: NodeId,
    timeout: number,
  ): Promise<NodeObserverSnapshot> {
    const startTime = Date.now();

    try {
      const snapshot = await this.getNodeSnapshot(nodeId, timeout);

      return {
        nodeId,
        status: 'connected',
        snapshot,
        lastUpdate: Date.now(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMessage.toLowerCase().includes('timeout');

      // Emit error event
      if (isTimeout) {
        this.emit({ type: 'node_timeout', nodeId });
      } else {
        this.emit({ type: 'node_error', nodeId, error: errorMessage });
      }

      return {
        nodeId,
        status: isTimeout ? 'timeout' : 'error',
        snapshot: null,
        lastUpdate: Date.now(),
        error: errorMessage,
      };
    }
  }

  /**
   * Aggregates statistics from node snapshots.
   */
  private aggregateStats(nodeSnapshots: readonly NodeObserverSnapshot[]): ClusterAggregatedStats {
    let totalProcessCount = 0;
    let totalServerCount = 0;
    let totalSupervisorCount = 0;
    let totalMessages = 0;
    let totalRestarts = 0;
    let connectedNodeCount = 0;

    for (const node of nodeSnapshots) {
      if (node.status === 'connected' && node.snapshot !== null) {
        totalProcessCount += node.snapshot.processCount;
        totalServerCount += node.snapshot.servers.length;
        totalSupervisorCount += node.snapshot.supervisors.length;
        totalMessages += node.snapshot.totalMessages;
        totalRestarts += node.snapshot.totalRestarts;
        connectedNodeCount++;
      }
    }

    return {
      totalProcessCount,
      totalServerCount,
      totalSupervisorCount,
      totalMessages,
      totalRestarts,
      connectedNodeCount,
      totalNodeCount: nodeSnapshots.length,
    };
  }

  /**
   * Performs a single poll cycle.
   */
  private pollCluster(): void {
    this.getClusterSnapshot({ useCache: false })
      .then((snapshot) => {
        this.emit({ type: 'cluster_snapshot_update', snapshot });
      })
      .catch(() => {
        // Polling errors are logged but don't stop polling
        // Individual node errors are already emitted via emit()
      });
  }

  /**
   * Emits an event to all subscribers.
   */
  private emit(event: ClusterObserverEvent): void {
    for (const handler of this.subscribers) {
      try {
        handler(event);
      } catch {
        // Handler errors should not affect other handlers
      }
    }
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

/**
 * Global ClusterObserver singleton instance.
 *
 * Provides cluster-wide process monitoring across all nodes.
 *
 * @example
 * ```typescript
 * import { Observer } from 'noex';
 * import { ClusterObserver, Cluster } from 'noex/distribution';
 *
 * // Local monitoring (synchronous)
 * const localSnapshot = Observer.getSnapshot();
 *
 * // Cluster-wide monitoring (asynchronous)
 * if (Cluster.getStatus() === 'running') {
 *   const clusterSnapshot = await ClusterObserver.getClusterSnapshot();
 *   console.log(`Cluster: ${clusterSnapshot.aggregated.totalProcessCount} processes`);
 * }
 * ```
 */
export const ClusterObserver = new ClusterObserverImpl();
