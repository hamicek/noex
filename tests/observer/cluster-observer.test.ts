/**
 * Comprehensive tests for ClusterObserver module.
 *
 * The ClusterObserver provides cluster-wide process monitoring
 * by aggregating snapshots from all nodes in the cluster.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GenServer,
  Supervisor,
  Registry,
  Observer,
  type GenServerBehavior,
} from '../../src/index.js';
import {
  ClusterObserver,
  startObserverService,
  stopObserverService,
  type ClusterObserverSnapshot,
  type NodeObserverSnapshot,
  type ClusterObserverEvent,
} from '../../src/observer/index.js';
import { Cluster } from '../../src/distribution/cluster/cluster.js';

/**
 * Creates a simple counter behavior for testing.
 */
function createCounterBehavior(): GenServerBehavior<number, 'get', 'inc', number> {
  return {
    init: () => 0,
    handleCall: (msg, state) => {
      if (msg === 'get') return [state, state];
      throw new Error('Unknown message');
    },
    handleCast: (msg, state) => {
      if (msg === 'inc') return state + 1;
      return state;
    },
  };
}

describe('ClusterObserver', () => {
  beforeEach(() => {
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
    Supervisor._clearLifecycleHandlers();
    Supervisor._resetIdCounter();
    Registry._clearLifecycleHandler();
    Registry._clear();
    Observer._reset();
    ClusterObserver._reset();
  });

  afterEach(async () => {
    // Stop observer service if running
    await stopObserverService();

    ClusterObserver._reset();
    Observer._reset();
    await Supervisor._clearAll();
    GenServer._clearLifecycleHandlers();
    Registry._clearLifecycleHandler();
    Registry._clear();
    vi.restoreAllMocks();
  });

  describe('getClusterSnapshot()', () => {
    it('throws error when cluster is not running', async () => {
      await expect(ClusterObserver.getClusterSnapshot()).rejects.toThrow(
        'Cluster is not running',
      );
    });

    it('returns local snapshot when cluster is running without remote nodes', async () => {
      // Create some local processes
      const counterRef = await GenServer.start(createCounterBehavior());

      // Mock cluster as running
      vi.spyOn(Cluster, 'getStatus').mockReturnValue('running');
      vi.spyOn(Cluster, 'getLocalNodeId').mockReturnValue('node1@localhost:4369' as any);
      vi.spyOn(Cluster, 'getConnectedNodes').mockReturnValue([]);

      const snapshot = await ClusterObserver.getClusterSnapshot();

      expect(snapshot).toBeDefined();
      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.localNodeId).toBe('node1@localhost:4369');
      expect(snapshot.nodes).toHaveLength(1);
      expect(snapshot.nodes[0]!.status).toBe('connected');
      expect(snapshot.nodes[0]!.snapshot).toBeDefined();
      expect(snapshot.aggregated.totalNodeCount).toBe(1);
      expect(snapshot.aggregated.connectedNodeCount).toBe(1);
      expect(snapshot.aggregated.totalProcessCount).toBeGreaterThanOrEqual(1);

      await GenServer.stop(counterRef);
    });

    it('uses cache when valid and useCache is true', async () => {
      // Create some processes
      const counterRef = await GenServer.start(createCounterBehavior());

      // Mock cluster as running
      vi.spyOn(Cluster, 'getStatus').mockReturnValue('running');
      vi.spyOn(Cluster, 'getLocalNodeId').mockReturnValue('node1@localhost:4369' as any);
      vi.spyOn(Cluster, 'getConnectedNodes').mockReturnValue([]);

      // First call populates cache
      const snapshot1 = await ClusterObserver.getClusterSnapshot();
      const cacheStatus1 = ClusterObserver.getCacheStatus();

      expect(cacheStatus1).toBeDefined();
      expect(cacheStatus1!.age).toBeLessThan(100);

      // Second call uses cache
      const snapshot2 = await ClusterObserver.getClusterSnapshot({ useCache: true });

      // Should return same timestamp (cached)
      expect(snapshot2.timestamp).toBe(snapshot1.timestamp);

      await GenServer.stop(counterRef);
    });

    it('bypasses cache when useCache is false', async () => {
      // Mock cluster as running
      vi.spyOn(Cluster, 'getStatus').mockReturnValue('running');
      vi.spyOn(Cluster, 'getLocalNodeId').mockReturnValue('node1@localhost:4369' as any);
      vi.spyOn(Cluster, 'getConnectedNodes').mockReturnValue([]);

      // First call populates cache
      const snapshot1 = await ClusterObserver.getClusterSnapshot();

      // Wait a bit
      await new Promise((r) => setTimeout(r, 10));

      // Second call bypasses cache
      const snapshot2 = await ClusterObserver.getClusterSnapshot({ useCache: false });

      // Should have different timestamp
      expect(snapshot2.timestamp).toBeGreaterThan(snapshot1.timestamp);
    });
  });

  describe('getNodeSnapshot()', () => {
    it('throws error when cluster is not running', async () => {
      await expect(
        ClusterObserver.getNodeSnapshot('node1@localhost:4369' as any),
      ).rejects.toThrow('Cluster is not running');
    });

    it('returns local snapshot when querying local node', async () => {
      const counterRef = await GenServer.start(createCounterBehavior());

      // Mock cluster as running
      vi.spyOn(Cluster, 'getStatus').mockReturnValue('running');
      vi.spyOn(Cluster, 'getLocalNodeId').mockReturnValue('node1@localhost:4369' as any);

      const snapshot = await ClusterObserver.getNodeSnapshot('node1@localhost:4369' as any);

      expect(snapshot).toBeDefined();
      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.servers.length).toBeGreaterThanOrEqual(1);

      await GenServer.stop(counterRef);
    });
  });

  describe('invalidateCache()', () => {
    it('clears the cache', async () => {
      // Mock cluster as running
      vi.spyOn(Cluster, 'getStatus').mockReturnValue('running');
      vi.spyOn(Cluster, 'getLocalNodeId').mockReturnValue('node1@localhost:4369' as any);
      vi.spyOn(Cluster, 'getConnectedNodes').mockReturnValue([]);

      // Populate cache
      await ClusterObserver.getClusterSnapshot();
      expect(ClusterObserver.getCacheStatus()).toBeDefined();

      // Invalidate
      ClusterObserver.invalidateCache();

      expect(ClusterObserver.getCacheStatus()).toBeNull();
    });
  });

  describe('getCacheStatus()', () => {
    it('returns null when no cache', () => {
      expect(ClusterObserver.getCacheStatus()).toBeNull();
    });

    it('returns cache info when cache exists', async () => {
      // Mock cluster as running
      vi.spyOn(Cluster, 'getStatus').mockReturnValue('running');
      vi.spyOn(Cluster, 'getLocalNodeId').mockReturnValue('node1@localhost:4369' as any);
      vi.spyOn(Cluster, 'getConnectedNodes').mockReturnValue([]);

      await ClusterObserver.getClusterSnapshot();

      const status = ClusterObserver.getCacheStatus();

      expect(status).toBeDefined();
      expect(status!.timestamp).toBeGreaterThan(0);
      expect(status!.age).toBeGreaterThanOrEqual(0);
    });
  });

  describe('subscribe()', () => {
    it('adds subscriber to the list', () => {
      const handler = vi.fn();

      const unsubscribe = ClusterObserver.subscribe(handler);

      expect(typeof unsubscribe).toBe('function');
    });

    it('returns unsubscribe function that removes handler', () => {
      const handler = vi.fn();

      const unsubscribe = ClusterObserver.subscribe(handler);
      unsubscribe();

      // Handler should not be called after unsubscribe
      // (we can't easily test this without triggering an event)
    });

    it('can have multiple subscribers', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const unsub1 = ClusterObserver.subscribe(handler1);
      const unsub2 = ClusterObserver.subscribe(handler2);

      // Both should return unsubscribe functions
      expect(typeof unsub1).toBe('function');
      expect(typeof unsub2).toBe('function');

      unsub1();
      unsub2();
    });
  });

  describe('startPolling()', () => {
    it('starts polling and returns unsubscribe function', async () => {
      const handler = vi.fn();

      // Mock cluster as running
      vi.spyOn(Cluster, 'getStatus').mockReturnValue('running');
      vi.spyOn(Cluster, 'getLocalNodeId').mockReturnValue('node1@localhost:4369' as any);
      vi.spyOn(Cluster, 'getConnectedNodes').mockReturnValue([]);

      const stopPolling = ClusterObserver.startPolling(100, handler);

      expect(typeof stopPolling).toBe('function');

      // Wait for initial poll
      await new Promise((r) => setTimeout(r, 50));

      // Handler should have been called at least once
      expect(handler).toHaveBeenCalled();

      stopPolling();
    });

    it('emits cluster_snapshot_update events', async () => {
      const handler = vi.fn();

      // Mock cluster as running
      vi.spyOn(Cluster, 'getStatus').mockReturnValue('running');
      vi.spyOn(Cluster, 'getLocalNodeId').mockReturnValue('node1@localhost:4369' as any);
      vi.spyOn(Cluster, 'getConnectedNodes').mockReturnValue([]);

      const stopPolling = ClusterObserver.startPolling(100, handler);

      // Wait for initial poll
      await new Promise((r) => setTimeout(r, 50));

      // Check event type
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'cluster_snapshot_update' }),
      );

      const event = handler.mock.calls[0]![0] as ClusterObserverEvent;
      if (event.type === 'cluster_snapshot_update') {
        expect(event.snapshot).toBeDefined();
        expect(event.snapshot.nodes).toBeDefined();
        expect(event.snapshot.aggregated).toBeDefined();
      }

      stopPolling();
    });

    it('stops polling when unsubscribe is called', async () => {
      const handler = vi.fn();

      // Mock cluster as running
      vi.spyOn(Cluster, 'getStatus').mockReturnValue('running');
      vi.spyOn(Cluster, 'getLocalNodeId').mockReturnValue('node1@localhost:4369' as any);
      vi.spyOn(Cluster, 'getConnectedNodes').mockReturnValue([]);

      const stopPolling = ClusterObserver.startPolling(100, handler);

      // Wait for initial poll
      await new Promise((r) => setTimeout(r, 50));
      const callCountAfterInitial = handler.mock.calls.length;

      stopPolling();

      // Wait longer than poll interval
      await new Promise((r) => setTimeout(r, 150));

      // Should not have been called again
      expect(handler.mock.calls.length).toBe(callCountAfterInitial);
    });

    it('shares polling timer among multiple subscribers', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      // Mock cluster as running
      vi.spyOn(Cluster, 'getStatus').mockReturnValue('running');
      vi.spyOn(Cluster, 'getLocalNodeId').mockReturnValue('node1@localhost:4369' as any);
      vi.spyOn(Cluster, 'getConnectedNodes').mockReturnValue([]);

      const stop1 = ClusterObserver.startPolling(100, handler1);
      const stop2 = ClusterObserver.startPolling(100, handler2);

      // Wait for initial poll
      await new Promise((r) => setTimeout(r, 50));

      // Both handlers should have been called
      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();

      // Stop first - timer should still be running
      stop1();

      // Wait for another poll
      await new Promise((r) => setTimeout(r, 120));

      // Second handler should still receive updates
      expect(handler2.mock.calls.length).toBeGreaterThan(1);

      stop2();
    });
  });

  describe('_reset()', () => {
    it('clears all state', async () => {
      const handler = vi.fn();

      // Mock cluster as running
      vi.spyOn(Cluster, 'getStatus').mockReturnValue('running');
      vi.spyOn(Cluster, 'getLocalNodeId').mockReturnValue('node1@localhost:4369' as any);
      vi.spyOn(Cluster, 'getConnectedNodes').mockReturnValue([]);

      // Set up some state
      await ClusterObserver.getClusterSnapshot();
      ClusterObserver.subscribe(handler);
      const stopPolling = ClusterObserver.startPolling(1000, handler);

      expect(ClusterObserver.getCacheStatus()).toBeDefined();

      // Reset
      ClusterObserver._reset();

      expect(ClusterObserver.getCacheStatus()).toBeNull();
    });
  });

  describe('aggregated statistics', () => {
    it('correctly aggregates stats from local node', async () => {
      // Create several processes
      const counters = await Promise.all([
        GenServer.start(createCounterBehavior()),
        GenServer.start(createCounterBehavior()),
        GenServer.start(createCounterBehavior()),
      ]);

      const supervisor = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'worker', start: () => GenServer.start(createCounterBehavior()) },
        ],
      });

      // Mock cluster as running
      vi.spyOn(Cluster, 'getStatus').mockReturnValue('running');
      vi.spyOn(Cluster, 'getLocalNodeId').mockReturnValue('node1@localhost:4369' as any);
      vi.spyOn(Cluster, 'getConnectedNodes').mockReturnValue([]);

      const snapshot = await ClusterObserver.getClusterSnapshot();

      // Should have 4 servers (3 counters + 1 worker in supervisor) and 1 supervisor
      expect(snapshot.aggregated.totalServerCount).toBeGreaterThanOrEqual(4);
      expect(snapshot.aggregated.totalSupervisorCount).toBe(1);
      expect(snapshot.aggregated.totalProcessCount).toBeGreaterThanOrEqual(5);
      expect(snapshot.aggregated.connectedNodeCount).toBe(1);
      expect(snapshot.aggregated.totalNodeCount).toBe(1);

      // Cleanup
      for (const counter of counters) {
        await GenServer.stop(counter);
      }
      await Supervisor.stop(supervisor);
    });
  });

  describe('error handling', () => {
    it('handles subscriber errors gracefully', async () => {
      const errorHandler = vi.fn(() => {
        throw new Error('Subscriber error');
      });
      const goodHandler = vi.fn();

      // Mock cluster as running
      vi.spyOn(Cluster, 'getStatus').mockReturnValue('running');
      vi.spyOn(Cluster, 'getLocalNodeId').mockReturnValue('node1@localhost:4369' as any);
      vi.spyOn(Cluster, 'getConnectedNodes').mockReturnValue([]);

      const stop1 = ClusterObserver.startPolling(100, errorHandler);
      const stop2 = ClusterObserver.startPolling(100, goodHandler);

      // Wait for initial poll
      await new Promise((r) => setTimeout(r, 50));

      // Both handlers should have been called (error in one shouldn't stop the other)
      expect(errorHandler).toHaveBeenCalled();
      expect(goodHandler).toHaveBeenCalled();

      stop1();
      stop2();
    });
  });

  describe('ClusterObserverSnapshot type', () => {
    it('has correct structure', async () => {
      // Mock cluster as running
      vi.spyOn(Cluster, 'getStatus').mockReturnValue('running');
      vi.spyOn(Cluster, 'getLocalNodeId').mockReturnValue('node1@localhost:4369' as any);
      vi.spyOn(Cluster, 'getConnectedNodes').mockReturnValue([]);

      const snapshot = await ClusterObserver.getClusterSnapshot();

      // Verify structure
      expect(typeof snapshot.timestamp).toBe('number');
      expect(typeof snapshot.localNodeId).toBe('string');
      expect(Array.isArray(snapshot.nodes)).toBe(true);
      expect(typeof snapshot.aggregated).toBe('object');

      // Verify aggregated structure
      const { aggregated } = snapshot;
      expect(typeof aggregated.totalProcessCount).toBe('number');
      expect(typeof aggregated.totalServerCount).toBe('number');
      expect(typeof aggregated.totalSupervisorCount).toBe('number');
      expect(typeof aggregated.totalMessages).toBe('number');
      expect(typeof aggregated.totalRestarts).toBe('number');
      expect(typeof aggregated.connectedNodeCount).toBe('number');
      expect(typeof aggregated.totalNodeCount).toBe('number');
    });
  });

  describe('NodeObserverSnapshot type', () => {
    it('has correct structure for connected node', async () => {
      // Mock cluster as running
      vi.spyOn(Cluster, 'getStatus').mockReturnValue('running');
      vi.spyOn(Cluster, 'getLocalNodeId').mockReturnValue('node1@localhost:4369' as any);
      vi.spyOn(Cluster, 'getConnectedNodes').mockReturnValue([]);

      const snapshot = await ClusterObserver.getClusterSnapshot();

      expect(snapshot.nodes).toHaveLength(1);

      const nodeSnapshot = snapshot.nodes[0]!;
      expect(typeof nodeSnapshot.nodeId).toBe('string');
      expect(nodeSnapshot.status).toBe('connected');
      expect(nodeSnapshot.snapshot).toBeDefined();
      expect(typeof nodeSnapshot.lastUpdate).toBe('number');
      expect(nodeSnapshot.error).toBeUndefined();
    });
  });
});
