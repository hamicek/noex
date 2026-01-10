/**
 * Integration tests for ClusterObserver with real multi-node clusters.
 *
 * These tests verify ClusterObserver behavior in realistic scenarios:
 * - Cluster-wide snapshot aggregation across multiple nodes
 * - Remote node snapshot fetching
 * - Handling of node failures during snapshot collection
 * - Cache behavior in multi-node environment
 *
 * Port range: 29000-29099
 *
 * @module tests/integration/cluster-observer
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  TestCluster,
  TestClusterFactory,
  type TestClusterConfig,
  type ClusterObserverSnapshotIPC,
  type ObserverSnapshotIPC,
} from '../stress/distribution/cluster-factory.js';

// =============================================================================
// Test Configuration
// =============================================================================

/** Base port for cluster observer integration tests */
const BASE_PORT = 29000;

/** Default timeout for cluster operations */
const DEFAULT_TIMEOUT_MS = 30000;

/** Heartbeat configuration for faster failure detection in tests */
const TEST_HEARTBEAT_CONFIG = {
  heartbeatIntervalMs: 300,
  heartbeatMissThreshold: 3,
} as const;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Creates a promise that resolves after specified milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for a condition to become true with timeout.
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await condition();
    if (result) return;
    await delay(intervalMs);
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

/**
 * Generates a unique port offset for a test.
 */
let portOffset = 0;
function getTestPort(): number {
  return BASE_PORT + (portOffset++ * 10);
}

/**
 * Creates cluster configuration with test-optimized settings.
 */
function createTestClusterConfig(
  nodeCount: number,
  basePort: number,
  overrides: Partial<TestClusterConfig> = {},
): TestClusterConfig {
  return {
    nodeCount,
    basePort,
    ...TEST_HEARTBEAT_CONFIG,
    ...overrides,
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('ClusterObserver Integration Tests', () => {
  let cluster: TestCluster | null = null;

  beforeEach(() => {
    portOffset++;
  });

  afterEach(async () => {
    if (cluster) {
      await cluster.stop();
      cluster = null;
    }
    // Allow sockets to fully close
    await delay(500);
  }, DEFAULT_TIMEOUT_MS);

  // ===========================================================================
  // Multi-Node Snapshot Aggregation
  // ===========================================================================

  describe('Multi-Node Snapshot Aggregation', () => {
    it('aggregates snapshots from all nodes in a 3-node cluster', async () => {
      const nodeCount = 3;
      cluster = await TestClusterFactory.createCluster(
        createTestClusterConfig(nodeCount, getTestPort()),
      );

      await cluster.waitForFullMesh(15000);

      // Get cluster snapshot from the first node
      const nodeIds = cluster.getNodeIds();
      const snapshot = await cluster.getClusterObserverSnapshot(nodeIds[0]!);

      // Verify structure
      expect(snapshot).toBeDefined();
      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.localNodeId).toBe(nodeIds[0]);
      expect(snapshot.nodes).toHaveLength(nodeCount);

      // Verify aggregated statistics
      expect(snapshot.aggregated.totalNodeCount).toBe(nodeCount);
      expect(snapshot.aggregated.connectedNodeCount).toBe(nodeCount);

      // Each node should be connected
      for (const node of snapshot.nodes) {
        expect(node.status).toBe('connected');
        expect(node.snapshot).toBeDefined();
        expect(node.snapshot!.processCount).toBeGreaterThanOrEqual(0);
      }
    }, DEFAULT_TIMEOUT_MS);

    it('includes process counts from all nodes', async () => {
      const nodeCount = 3;
      cluster = await TestClusterFactory.createCluster(
        createTestClusterConfig(nodeCount, getTestPort()),
      );

      await cluster.waitForFullMesh(15000);

      const nodeIds = cluster.getNodeIds();
      const snapshot = await cluster.getClusterObserverSnapshot(nodeIds[0]!);

      // Total process count should be sum of all nodes
      let expectedTotal = 0;
      for (const node of snapshot.nodes) {
        if (node.snapshot) {
          expectedTotal += node.snapshot.processCount;
        }
      }

      expect(snapshot.aggregated.totalProcessCount).toBe(expectedTotal);
    }, DEFAULT_TIMEOUT_MS);

    it('each node sees consistent cluster view', async () => {
      const nodeCount = 3;
      cluster = await TestClusterFactory.createCluster(
        createTestClusterConfig(nodeCount, getTestPort()),
      );

      await cluster.waitForFullMesh(15000);
      await delay(1000); // Allow for stabilization

      const nodeIds = cluster.getNodeIds();

      // Get snapshot from each node
      const snapshots: ClusterObserverSnapshotIPC[] = [];
      for (const nodeId of nodeIds) {
        const snapshot = await cluster.getClusterObserverSnapshot(
          nodeId,
          { useCache: false },
        );
        snapshots.push(snapshot);
      }

      // All snapshots should see the same number of nodes
      for (const snapshot of snapshots) {
        expect(snapshot.aggregated.totalNodeCount).toBe(nodeCount);
        expect(snapshot.aggregated.connectedNodeCount).toBe(nodeCount);
      }

      // All snapshots should have same node IDs (though in potentially different order)
      const firstNodeIds = snapshots[0]!.nodes.map((n) => n.nodeId).sort();
      for (const snapshot of snapshots) {
        const nodeIdsInSnapshot = snapshot.nodes.map((n) => n.nodeId).sort();
        expect(nodeIdsInSnapshot).toEqual(firstNodeIds);
      }
    }, DEFAULT_TIMEOUT_MS);
  });

  // ===========================================================================
  // Remote Node Snapshot Fetching
  // ===========================================================================

  describe('Remote Node Snapshot Fetching', () => {
    it('fetches snapshot from a remote node', async () => {
      cluster = await TestClusterFactory.createCluster(
        createTestClusterConfig(2, getTestPort()),
      );

      await cluster.waitForFullMesh(15000);

      const nodeIds = cluster.getNodeIds();
      const fromNode = nodeIds[0]!;
      const targetNode = nodeIds[1]!;

      // Fetch remote node snapshot
      const snapshot = await cluster.getRemoteNodeSnapshot(fromNode, targetNode);

      expect(snapshot).toBeDefined();
      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.processCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(snapshot.servers)).toBe(true);
      expect(Array.isArray(snapshot.supervisors)).toBe(true);
    }, DEFAULT_TIMEOUT_MS);

    it('fetches local snapshot when querying self', async () => {
      cluster = await TestClusterFactory.createCluster(
        createTestClusterConfig(2, getTestPort()),
      );

      await cluster.waitForFullMesh(15000);

      const nodeIds = cluster.getNodeIds();
      const nodeId = nodeIds[0]!;

      // Fetch snapshot of self through remote API
      const remoteSnapshot = await cluster.getRemoteNodeSnapshot(nodeId, nodeId);
      const localSnapshot = await cluster.getLocalObserverSnapshot(nodeId);

      // Both should have similar structure
      expect(remoteSnapshot.processCount).toBe(localSnapshot.processCount);
      expect(remoteSnapshot.servers.length).toBe(localSnapshot.servers.length);
    }, DEFAULT_TIMEOUT_MS);

    it('includes memory statistics in remote snapshot', async () => {
      cluster = await TestClusterFactory.createCluster(
        createTestClusterConfig(2, getTestPort()),
      );

      await cluster.waitForFullMesh(15000);

      const nodeIds = cluster.getNodeIds();
      const snapshot = await cluster.getRemoteNodeSnapshot(nodeIds[0]!, nodeIds[1]!);

      expect(snapshot.memoryStats).toBeDefined();
      expect(snapshot.memoryStats.heapUsed).toBeGreaterThan(0);
      expect(snapshot.memoryStats.heapTotal).toBeGreaterThan(0);
      expect(snapshot.memoryStats.rss).toBeGreaterThan(0);
    }, DEFAULT_TIMEOUT_MS);
  });

  // ===========================================================================
  // Node Failure Handling
  // ===========================================================================

  describe('Node Failure Handling', () => {
    it('handles node crash during snapshot collection gracefully', async () => {
      const nodeCount = 3;
      cluster = await TestClusterFactory.createCluster(
        createTestClusterConfig(nodeCount, getTestPort()),
      );

      await cluster.waitForFullMesh(15000);

      const nodeIds = [...cluster.getNodeIds()];
      const queryNode = nodeIds[0]!;
      const crashNode = nodeIds[2]!;

      // Crash one node
      await cluster.crashNode(crashNode, 'process_exit');

      // Wait for crash detection
      await delay(2000);

      // Snapshot should still work, returning results from surviving nodes
      // Note: totalNodeCount reflects visible nodes (local + connected),
      // not the original cluster size - crashed nodes are no longer visible
      const snapshot = await cluster.getClusterObserverSnapshot(
        queryNode,
        { useCache: false },
        15000,
      );

      expect(snapshot).toBeDefined();
      // After crash, we see only the surviving nodes (local + 1 connected)
      expect(snapshot.aggregated.totalNodeCount).toBe(nodeCount - 1);
      expect(snapshot.aggregated.connectedNodeCount).toBe(nodeCount - 1);

      // All visible nodes should be connected (crashed node is not visible)
      for (const node of snapshot.nodes) {
        expect(node.status).toBe('connected');
        expect(node.nodeId).not.toBe(crashNode);
      }
    }, DEFAULT_TIMEOUT_MS);

    it('partial results are returned when some nodes fail', async () => {
      const nodeCount = 4;
      cluster = await TestClusterFactory.createCluster(
        createTestClusterConfig(nodeCount, getTestPort()),
      );

      await cluster.waitForFullMesh(20000);

      const nodeIds = [...cluster.getNodeIds()];
      const queryNode = nodeIds[0]!;

      // Crash 2 out of 4 nodes
      await cluster.crashNode(nodeIds[2]!, 'process_exit');
      await cluster.crashNode(nodeIds[3]!, 'process_exit');

      // Wait for crash detection
      await delay(2000);

      const snapshot = await cluster.getClusterObserverSnapshot(
        queryNode,
        { useCache: false },
        15000,
      );

      // Should still get results from surviving nodes
      expect(snapshot.aggregated.connectedNodeCount).toBe(2);

      const connectedNodes = snapshot.nodes.filter((n) => n.status === 'connected');
      expect(connectedNodes.length).toBe(2);

      // Connected nodes should have valid snapshots
      for (const node of connectedNodes) {
        expect(node.snapshot).toBeDefined();
        expect(node.snapshot!.processCount).toBeGreaterThanOrEqual(0);
      }
    }, DEFAULT_TIMEOUT_MS);

    it('remote snapshot fetch fails gracefully for crashed node', async () => {
      cluster = await TestClusterFactory.createCluster(
        createTestClusterConfig(2, getTestPort()),
      );

      await cluster.waitForFullMesh(15000);

      const nodeIds = [...cluster.getNodeIds()];
      const queryNode = nodeIds[0]!;
      const crashNode = nodeIds[1]!;

      // Crash target node
      await cluster.crashNode(crashNode, 'process_exit');

      // Wait for crash detection
      await delay(2000);

      // Attempting to fetch snapshot from crashed node should fail
      await expect(
        cluster.getRemoteNodeSnapshot(queryNode, crashNode, 3000),
      ).rejects.toThrow();
    }, DEFAULT_TIMEOUT_MS);
  });

  // ===========================================================================
  // Node Addition/Removal
  // ===========================================================================

  describe('Node Recovery', () => {
    it('snapshot reflects recovered node after restart', async () => {
      const nodeCount = 3;
      cluster = await TestClusterFactory.createCluster(
        createTestClusterConfig(nodeCount, getTestPort()),
      );

      await cluster.waitForFullMesh(15000);

      const nodeIds = [...cluster.getNodeIds()];
      const queryNode = nodeIds[0]!;
      const restartNode = nodeIds[2]!;

      // Crash and restart one node
      await cluster.crashNode(restartNode, 'process_exit');
      await delay(1500);

      await cluster.restartNode(restartNode);

      // Wait for node to rejoin
      await waitFor(
        () => cluster!.getNode(restartNode)?.status === 'running',
        15000,
        300,
      );

      // Wait for mesh to reform
      await cluster.waitForFullMesh(20000);

      // Snapshot should now include recovered node
      const snapshot = await cluster.getClusterObserverSnapshot(
        queryNode,
        { useCache: false },
        15000,
      );

      expect(snapshot.aggregated.totalNodeCount).toBe(nodeCount);
      expect(snapshot.aggregated.connectedNodeCount).toBe(nodeCount);

      // All nodes should be connected
      for (const node of snapshot.nodes) {
        expect(node.status).toBe('connected');
      }
    }, 60000);
  });

  // ===========================================================================
  // Local Snapshot
  // ===========================================================================

  describe('Local Snapshot', () => {
    it('returns local observer snapshot synchronously', async () => {
      cluster = await TestClusterFactory.createCluster(
        createTestClusterConfig(2, getTestPort()),
      );

      await cluster.waitForFullMesh(15000);

      const nodeIds = cluster.getNodeIds();
      const snapshot = await cluster.getLocalObserverSnapshot(nodeIds[0]!);

      expect(snapshot).toBeDefined();
      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.processCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(snapshot.servers)).toBe(true);
      expect(Array.isArray(snapshot.supervisors)).toBe(true);
      expect(snapshot.memoryStats).toBeDefined();
    }, DEFAULT_TIMEOUT_MS);

    it('local snapshot has correct structure', async () => {
      cluster = await TestClusterFactory.createCluster(
        createTestClusterConfig(1, getTestPort()),
      );

      const nodeIds = cluster.getNodeIds();
      const snapshot = await cluster.getLocalObserverSnapshot(nodeIds[0]!);

      // Verify all required fields
      expect(typeof snapshot.timestamp).toBe('number');
      expect(typeof snapshot.processCount).toBe('number');
      expect(typeof snapshot.totalMessages).toBe('number');
      expect(typeof snapshot.totalRestarts).toBe('number');

      // Verify memory stats structure
      expect(typeof snapshot.memoryStats.heapUsed).toBe('number');
      expect(typeof snapshot.memoryStats.heapTotal).toBe('number');
      expect(typeof snapshot.memoryStats.rss).toBe('number');
      expect(typeof snapshot.memoryStats.external).toBe('number');
    }, DEFAULT_TIMEOUT_MS);
  });

  // ===========================================================================
  // Snapshot Consistency
  // ===========================================================================

  describe('Snapshot Consistency', () => {
    it('aggregated stats match sum of individual nodes', async () => {
      const nodeCount = 3;
      cluster = await TestClusterFactory.createCluster(
        createTestClusterConfig(nodeCount, getTestPort()),
      );

      await cluster.waitForFullMesh(15000);

      const nodeIds = cluster.getNodeIds();
      const snapshot = await cluster.getClusterObserverSnapshot(nodeIds[0]!);

      // Calculate expected totals from individual nodes
      let expectedProcessCount = 0;
      let expectedServerCount = 0;
      let expectedSupervisorCount = 0;
      let expectedMessages = 0;
      let expectedRestarts = 0;

      for (const node of snapshot.nodes) {
        if (node.status === 'connected' && node.snapshot) {
          expectedProcessCount += node.snapshot.processCount;
          expectedServerCount += node.snapshot.servers.length;
          expectedSupervisorCount += node.snapshot.supervisors.length;
          expectedMessages += node.snapshot.totalMessages;
          expectedRestarts += node.snapshot.totalRestarts;
        }
      }

      expect(snapshot.aggregated.totalProcessCount).toBe(expectedProcessCount);
      expect(snapshot.aggregated.totalServerCount).toBe(expectedServerCount);
      expect(snapshot.aggregated.totalSupervisorCount).toBe(expectedSupervisorCount);
      expect(snapshot.aggregated.totalMessages).toBe(expectedMessages);
      expect(snapshot.aggregated.totalRestarts).toBe(expectedRestarts);
    }, DEFAULT_TIMEOUT_MS);
  });
});
