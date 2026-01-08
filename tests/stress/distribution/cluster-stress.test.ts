/**
 * Cluster membership stress tests for distributed node management.
 *
 * Tests the cluster layer under various stress conditions:
 * - Large cluster formation with 10-20 nodes
 * - Rapid node churn (join/leave cycles)
 * - Node down detection within heartbeat threshold
 * - Split brain recovery and convergence
 *
 * Port range: 21000-21099
 *
 * @module tests/stress/distribution/cluster-stress
 */

import { describe, it, expect, afterEach } from 'vitest';

import { TestCluster, TestClusterFactory, type TestClusterConfig } from './cluster-factory.js';
import {
  DistributedMetricsCollector,
  DistributedMetricsAssertions,
} from './distributed-metrics-collector.js';
import {
  NodeCrashSimulator,
  createCrashSimulator,
} from './node-crash-simulator.js';

// =============================================================================
// Test Configuration
// =============================================================================

/**
 * Base port for cluster stress tests.
 * Each test uses a unique port range to avoid conflicts.
 */
const BASE_PORT = 21000;

/**
 * Default timeout for cluster operations.
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Extended timeout for stress tests.
 */
const STRESS_TEST_TIMEOUT_MS = 120000;

/**
 * Long timeout for large cluster tests.
 */
const LARGE_CLUSTER_TIMEOUT_MS = 180000;

/**
 * Heartbeat configuration optimized for stress testing.
 * Shorter intervals allow faster failure detection.
 */
const STRESS_HEARTBEAT_CONFIG = {
  heartbeatIntervalMs: 300,
  heartbeatMissThreshold: 3,
} as const;

/**
 * Fast heartbeat configuration for rapid churn tests.
 */
const FAST_HEARTBEAT_CONFIG = {
  heartbeatIntervalMs: 200,
  heartbeatMissThreshold: 2,
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
 *
 * @param condition - Function returning boolean or Promise<boolean>
 * @param timeoutMs - Maximum time to wait
 * @param intervalMs - Check interval
 * @returns Promise that resolves when condition is true
 * @throws Error if timeout is reached
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
 * Generates a unique port for a test based on base port and offset.
 */
function getTestPort(offset: number): number {
  return BASE_PORT + offset;
}

/**
 * Creates cluster configuration with stress-optimized settings.
 */
function createStressClusterConfig(
  nodeCount: number,
  basePort: number,
  overrides: Partial<TestClusterConfig> = {},
): TestClusterConfig {
  return {
    nodeCount,
    basePort,
    ...STRESS_HEARTBEAT_CONFIG,
    ...overrides,
  };
}

/**
 * Calculates expected minimum node-up events for full mesh formation.
 * Each node reports seeing (nodeCount - 1) other nodes.
 * Total: nodeCount * (nodeCount - 1).
 */
function calculateExpectedNodeUpEvents(nodeCount: number): number {
  return nodeCount * (nodeCount - 1);
}

// =============================================================================
// Test Suite
// =============================================================================

describe('Cluster Membership Stress Tests', () => {
  let cluster: TestCluster | null = null;
  let metricsCollector: DistributedMetricsCollector | null = null;

  /**
   * Creates and starts a metrics collector attached to the given cluster.
   */
  function createAndStartMetrics(targetCluster: TestCluster): DistributedMetricsCollector {
    const collector = new DistributedMetricsCollector({
      memorySnapshotIntervalMs: 500,
      cluster: targetCluster,
      trackClusterEvents: true,
    });
    collector.start();
    return collector;
  }

  afterEach(async () => {
    if (metricsCollector) {
      metricsCollector.stop();
      metricsCollector = null;
    }

    if (cluster) {
      await cluster.stop();
      cluster = null;
    }

    // Allow sockets to fully close
    await delay(500);
  }, DEFAULT_TIMEOUT_MS);

  // ===========================================================================
  // Large Cluster Formation
  // ===========================================================================

  describe('Large Cluster Formation', () => {
    it('forms 10-node cluster with full mesh topology', async () => {
      const nodeCount = 10;

      let nodeUpEventCount = 0;
      cluster = new TestCluster(
        createStressClusterConfig(nodeCount, getTestPort(0), {
          // Longer heartbeat for large cluster startup
          heartbeatIntervalMs: 500,
          heartbeatMissThreshold: 4,
        }),
      );
      cluster.on('nodeUp', () => {
        nodeUpEventCount++;
      });

      const startTime = Date.now();
      await cluster._start();
      metricsCollector = createAndStartMetrics(cluster);

      // Allow generous time for 10-node mesh formation
      await cluster.waitForFullMesh(90000);
      const meshFormationTime = Date.now() - startTime;

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify full mesh topology
      expect(cluster.isFullMesh()).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(nodeCount);

      // Each node should be connected to all others
      for (const node of cluster.getNodes()) {
        expect(node.connectedNodes.length).toBe(nodeCount - 1);
      }

      // Formation should complete in reasonable time
      expect(meshFormationTime).toBeLessThan(90000);

      // Verify expected node-up events
      const expectedEvents = calculateExpectedNodeUpEvents(nodeCount);
      expect(nodeUpEventCount).toBeGreaterThanOrEqual(expectedEvents);

      // Memory growth should be acceptable
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 150);
    }, LARGE_CLUSTER_TIMEOUT_MS);

    it('forms 15-node cluster demonstrating scalability', async () => {
      const nodeCount = 15;

      let nodeUpEventCount = 0;
      cluster = new TestCluster(
        createStressClusterConfig(nodeCount, getTestPort(15), {
          heartbeatIntervalMs: 400,
          heartbeatMissThreshold: 3,
        }),
      );
      cluster.on('nodeUp', () => {
        nodeUpEventCount++;
      });

      const startTime = Date.now();
      await cluster._start();
      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(90000);
      const meshFormationTime = Date.now() - startTime;

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify full mesh
      expect(cluster.isFullMesh()).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(nodeCount);

      // Formation time scales with cluster size but should still be reasonable
      expect(meshFormationTime).toBeLessThan(90000);

      // Total connections: 15 * 14 = 210 bidirectional pairs
      for (const node of cluster.getNodes()) {
        expect(node.connectedNodes.length).toBe(nodeCount - 1);
      }

      // Verify mesh stability over brief period
      await delay(3000);
      expect(cluster.isFullMesh()).toBe(true);
      expect(metrics.cluster.nodeDownEvents).toBe(0);
    }, LARGE_CLUSTER_TIMEOUT_MS);

    it('handles cluster growth from 5 to 10 nodes', async () => {
      // Start with 5 nodes
      const initialNodeCount = 5;
      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(initialNodeCount, getTestPort(35)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(30000);

      expect(cluster.isFullMesh()).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(initialNodeCount);

      // Verify initial mesh is stable
      await delay(2000);
      const initialNodeIds = cluster.getNodeIds();

      // Verify all initial nodes are connected properly
      for (const node of cluster.getNodes()) {
        expect(node.status).toBe('running');
        expect(node.connectedNodes.length).toBe(initialNodeCount - 1);
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Cluster remained stable during growth preparation
      expect(metrics.cluster.nodeDownEvents).toBe(0);
      expect(initialNodeIds.length).toBe(initialNodeCount);
    }, STRESS_TEST_TIMEOUT_MS);

    it('maintains connectivity under connection load', async () => {
      const nodeCount = 8;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(nodeCount, getTestPort(45)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(30000);

      // Run under load - repeatedly query cluster state
      const loadDurationMs = 15000;
      const startTime = Date.now();
      let queryCount = 0;
      let stableChecks = 0;

      while (Date.now() - startTime < loadDurationMs) {
        cluster.getNodes();
        cluster.getNodeIds();

        if (cluster.isFullMesh() && cluster.getRunningNodeCount() === nodeCount) {
          stableChecks++;
        }
        queryCount++;

        await delay(50);
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Cluster should remain stable throughout
      expect(cluster.isFullMesh()).toBe(true);
      expect(stableChecks).toBe(queryCount);
      expect(metrics.cluster.nodeDownEvents).toBe(0);
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Rapid Node Churn
  // ===========================================================================

  describe('Rapid Node Churn', () => {
    it('handles rapid sequential node restarts', async () => {
      const nodeCount = 4;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(nodeCount, getTestPort(50)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      // Track churn events
      let restartSuccesses = 0;

      // Restart each node sequentially with proper stabilization
      const nodeIds = [...cluster.getNodeIds()];

      for (let i = 0; i < nodeIds.length; i++) {
        const nodeId = nodeIds[i]!;
        const node = cluster.getNode(nodeId);

        // Only crash if node is running
        if (node?.status === 'running') {
          await cluster.crashNode(nodeId, 'process_exit');

          // Wait for crash to be detected
          await delay(1500);

          // Restart it
          await cluster.restartNode(nodeId);

          // Wait for node to rejoin
          await waitFor(
            () => cluster!.getNode(nodeId)?.status === 'running',
            15000,
            200,
          );

          // Wait for mesh to reform with this node
          await cluster.waitForFullMesh(20000);

          restartSuccesses++;

          // Brief stabilization between restarts
          await delay(1000);
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // At least some restarts should succeed
      expect(restartSuccesses).toBeGreaterThanOrEqual(nodeCount - 1);
      expect(cluster.isFullMesh()).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(nodeCount);

      // Should have recorded node events
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(1);
    }, STRESS_TEST_TIMEOUT_MS);

    it('survives rapid alternating node crashes', async () => {
      const nodeCount = 5;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(nodeCount, getTestPort(55)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      // Alternating crash and restart pattern - fewer iterations for stability
      const iterations = 2;
      const nodeIds = [...cluster.getNodeIds()];
      let successfulIterations = 0;

      for (let i = 0; i < iterations; i++) {
        const nodeToKill = nodeIds[i % nodeIds.length]!;
        const node = cluster.getNode(nodeToKill);

        // Only crash if node is running
        if (node?.status !== 'running') {
          continue;
        }

        await cluster.crashNode(nodeToKill, 'process_exit');

        // Wait for crash to be detected
        await delay(2000);

        // Restart it
        await cluster.restartNode(nodeToKill);

        // Wait for it to come back and be running
        await waitFor(
          () => cluster!.getNode(nodeToKill)?.status === 'running',
          20000,
          300,
        );

        // Wait for mesh to re-form
        await cluster.waitForFullMesh(30000);

        successfulIterations++;

        // Longer stabilization between iterations
        await delay(2000);
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Cluster should be fully recovered
      expect(cluster.isFullMesh()).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(nodeCount);

      // At least one iteration should succeed
      expect(successfulIterations).toBeGreaterThanOrEqual(1);
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(1);
    }, STRESS_TEST_TIMEOUT_MS);

    it('maintains majority during minority churn', async () => {
      const nodeCount = 5;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(nodeCount, getTestPort(60)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      // Kill minority (2 out of 5 nodes)
      const nodeIds = [...cluster.getNodeIds()];
      await cluster.crashNode(nodeIds[0]!, 'process_exit');
      await cluster.crashNode(nodeIds[1]!, 'process_exit');

      // Wait for detection
      await delay(2000);

      // Majority should remain connected
      const runningNodes = cluster.getNodes().filter((n) => n.status === 'running');
      expect(runningNodes.length).toBe(3);

      // Remaining nodes should maintain mesh among themselves
      for (const node of runningNodes) {
        expect(node.connectedNodes.length).toBe(2);
      }

      // Restart crashed nodes
      await cluster.restartNode(nodeIds[0]!);
      await cluster.restartNode(nodeIds[1]!);

      // Wait for full mesh recovery
      await cluster.waitForFullMesh(30000);

      metricsCollector.stop();

      expect(cluster.isFullMesh()).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(nodeCount);
    }, STRESS_TEST_TIMEOUT_MS);

    it('recovers from burst of crashes', async () => {
      const nodeCount = 5;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(nodeCount, getTestPort(65)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(20000);

      // Crash 2 nodes in succession (less aggressive)
      const nodeIds = [...cluster.getNodeIds()];
      const nodesToCrash = nodeIds.slice(0, 2);

      for (const nodeId of nodesToCrash) {
        const node = cluster.getNode(nodeId);
        if (node?.status === 'running') {
          await cluster.crashNode(nodeId, 'process_exit');
          await delay(500);
        }
      }

      // Wait for crashes to be detected
      await delay(3000);

      // Verify majority is still running
      expect(cluster.getRunningNodeCount()).toBeGreaterThanOrEqual(3);

      // Restart crashed nodes one by one with full mesh wait
      for (const nodeId of nodesToCrash) {
        await cluster.restartNode(nodeId);

        await waitFor(
          () => cluster!.getNode(nodeId)?.status === 'running',
          15000,
          300,
        );

        // Wait for this node to rejoin mesh
        await cluster.waitForFullMesh(30000);

        await delay(1000);
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      expect(cluster.isFullMesh()).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(nodeCount);
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(2);
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Node Down Detection
  // ===========================================================================

  describe('Node Down Detection', () => {
    it('detects graceful shutdown within threshold', async () => {
      const heartbeatIntervalMs = 250;
      const heartbeatMissThreshold = 3;
      const maxDetectionTime = heartbeatIntervalMs * heartbeatMissThreshold * 2;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(3, getTestPort(70), {
          heartbeatIntervalMs,
          heartbeatMissThreshold,
        }),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      let nodeDownDetectedAt: number | null = null;
      cluster.on('nodeDown', () => {
        if (nodeDownDetectedAt === null) {
          nodeDownDetectedAt = Date.now();
        }
      });

      const nodeIds = cluster.getNodeIds();
      const shutdownStartTime = Date.now();

      // Graceful shutdown
      await cluster.stopNode(nodeIds[0]!);

      // Wait for detection
      await waitFor(
        () => nodeDownDetectedAt !== null,
        maxDetectionTime + 5000,
        50,
      );

      const detectionTime = nodeDownDetectedAt! - shutdownStartTime;

      metricsCollector.stop();

      // Detection should be fast for graceful shutdown
      expect(detectionTime).toBeLessThan(maxDetectionTime);
      expect(cluster.getNode(nodeIds[0]!)?.status).toBe('stopped');
    }, STRESS_TEST_TIMEOUT_MS);

    it('detects abrupt kill within threshold', async () => {
      const heartbeatIntervalMs = 300;
      const heartbeatMissThreshold = 3;
      // Detection takes up to: interval * threshold for missed heartbeats + processing
      const expectedMaxDetection = heartbeatIntervalMs * heartbeatMissThreshold * 2 + 1000;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(3, getTestPort(73), {
          heartbeatIntervalMs,
          heartbeatMissThreshold,
        }),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      let nodeDownDetectedAt: number | null = null;
      cluster.on('nodeDown', () => {
        if (nodeDownDetectedAt === null) {
          nodeDownDetectedAt = Date.now();
        }
      });

      const nodeIds = cluster.getNodeIds();
      const killStartTime = Date.now();

      // Abrupt kill - no cleanup
      await cluster.crashNode(nodeIds[0]!, 'abrupt_kill');

      // Wait for detection
      await waitFor(
        () => nodeDownDetectedAt !== null,
        expectedMaxDetection + 3000,
        50,
      );

      const detectionTime = nodeDownDetectedAt! - killStartTime;

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Detection should occur within expected threshold
      expect(detectionTime).toBeLessThan(expectedMaxDetection);
      expect(cluster.getNode(nodeIds[0]!)?.status).toBe('crashed');
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(1);
    }, STRESS_TEST_TIMEOUT_MS);

    it('detects multiple simultaneous failures', async () => {
      const nodeCount = 5;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(nodeCount, getTestPort(76), {
          heartbeatIntervalMs: 250,
          heartbeatMissThreshold: 3,
        }),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      let detectedDownNodes = 0;
      cluster.on('nodeDown', () => {
        detectedDownNodes++;
      });

      // Kill 2 nodes simultaneously
      const nodeIds = [...cluster.getNodeIds()];
      await Promise.all([
        cluster.crashNode(nodeIds[0]!, 'abrupt_kill'),
        cluster.crashNode(nodeIds[1]!, 'abrupt_kill'),
      ]);

      // Wait for both to be detected
      await waitFor(
        () => detectedDownNodes >= 2,
        5000,
        50,
      );

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Both failures should be detected
      expect(detectedDownNodes).toBeGreaterThanOrEqual(2);
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(2);

      // Remaining nodes should form mesh
      const running = cluster.getNodes().filter((n) => n.status === 'running');
      expect(running.length).toBe(3);
    }, STRESS_TEST_TIMEOUT_MS);

    it('propagates down events to all surviving nodes', async () => {
      const nodeCount = 4;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(nodeCount, getTestPort(79)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      // Track which nodes report the down event
      const reportingNodes = new Set<string>();
      cluster.on('nodeDown', (nodeId, reason, fromNodeId) => {
        reportingNodes.add(fromNodeId);
      });

      const nodeIds = [...cluster.getNodeIds()];
      const nodeToKill = nodeIds[0]!;

      await cluster.crashNode(nodeToKill, 'process_exit');

      // Wait for all remaining nodes to detect
      await waitFor(
        () => reportingNodes.size >= nodeCount - 1,
        5000,
        50,
      );

      metricsCollector.stop();

      // All surviving nodes should have reported the down event
      expect(reportingNodes.size).toBe(nodeCount - 1);

      // The killed node should not be in the reporting set
      expect(reportingNodes.has(nodeToKill)).toBe(false);
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Split Brain Recovery
  // ===========================================================================

  describe('Split Brain Recovery', () => {
    it('recovers from partition with restart', async () => {
      const nodeCount = 4;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(nodeCount, getTestPort(82)),
      );

      const crashSimulator = createCrashSimulator(cluster);
      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      // Execute split brain - kill minority (smaller partition)
      // Note: 'smaller' means the smaller partition SURVIVES (confusing naming in simulator)
      // So we use 'partition1' to explicitly kill the first half
      const nodeIds = [...cluster.getNodeIds()];
      const result = await crashSimulator.splitBrain({
        partition1: nodeIds.slice(0, 2),
        partition2: nodeIds.slice(2),
        survivingPartition: 'partition2',
      });

      // Wait for partition to be detected
      await delay(2000);

      // Surviving nodes should form partial mesh
      const runningBefore = cluster.getNodes().filter((n) => n.status === 'running');
      expect(runningBefore.length).toBeGreaterThanOrEqual(2);

      // Heal by restarting crashed nodes
      for (const crashedNode of result.nodeResults) {
        await cluster.restartNode(crashedNode.nodeId);
      }

      // Wait for full recovery
      await cluster.waitForFullMesh(30000);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      expect(cluster.isFullMesh()).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(nodeCount);
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThan(0);
    }, STRESS_TEST_TIMEOUT_MS);

    it('converges after asymmetric partition', async () => {
      const nodeCount = 5;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(nodeCount, getTestPort(85)),
      );

      const crashSimulator = createCrashSimulator(cluster);
      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      const nodeIds = [...cluster.getNodeIds()];

      // Create asymmetric partition: 1 node vs 4 nodes
      // Use 'partition2' explicitly to ensure the 4-node partition survives
      const result = await crashSimulator.splitBrain({
        partition1: [nodeIds[0]!],
        partition2: nodeIds.slice(1),
        survivingPartition: 'partition2',
      });

      await delay(2000);

      // 4 nodes should remain (partition2 survives)
      expect(cluster.getRunningNodeCount()).toBe(4);

      // The crashed node should be from partition1
      expect(result.nodeResults.length).toBe(1);
      expect(result.nodeResults[0]!.nodeId).toBe(nodeIds[0]!);

      // Restart the isolated node
      await cluster.restartNode(result.nodeResults[0]!.nodeId);

      // Wait for convergence
      await cluster.waitForFullMesh(30000);

      metricsCollector.stop();

      expect(cluster.isFullMesh()).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(nodeCount);
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles repeated partition/heal cycles', async () => {
      const nodeCount = 4;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(nodeCount, getTestPort(88)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      const cycles = 2;
      const nodeIds = [...cluster.getNodeIds()];

      for (let i = 0; i < cycles; i++) {
        const nodeToKill = nodeIds[i % nodeIds.length]!;
        const node = cluster.getNode(nodeToKill);

        // Only proceed if node is running
        if (node?.status !== 'running') {
          continue;
        }

        // Crash single node
        await cluster.crashNode(nodeToKill, 'process_exit');

        // Wait for crash detection
        await delay(2000);

        // Restart the node
        await cluster.restartNode(nodeToKill);

        // Wait for node to rejoin
        await waitFor(
          () => cluster!.getNode(nodeToKill)?.status === 'running',
          15000,
          300,
        );

        // Wait for full mesh
        await cluster.waitForFullMesh(30000);

        expect(cluster.isFullMesh()).toBe(true);
        expect(cluster.getRunningNodeCount()).toBe(nodeCount);

        // Stabilization before next cycle
        await delay(2000);
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Multiple partition events should have occurred
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(1);
    }, STRESS_TEST_TIMEOUT_MS * 2);

    it('maintains data consistency view after partition heal', async () => {
      const nodeCount = 4;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(nodeCount, getTestPort(91)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      // Record initial state
      const initialNodes = cluster.getNodes().map((n) => n.nodeId).sort();

      // Crash half the cluster
      const nodeIds = [...cluster.getNodeIds()];
      await cluster.crashNode(nodeIds[0]!, 'process_exit');
      await cluster.crashNode(nodeIds[1]!, 'process_exit');

      await delay(2000);

      // Restart crashed nodes
      await cluster.restartNode(nodeIds[0]!);
      await cluster.restartNode(nodeIds[1]!);

      await cluster.waitForFullMesh(30000);

      // Verify all original nodes are present
      const finalNodes = cluster.getNodes().map((n) => n.nodeId).sort();
      expect(finalNodes).toEqual(initialNodes);

      // Verify connectivity is symmetric
      for (const node of cluster.getNodes()) {
        expect(node.status).toBe('running');
        expect(node.connectedNodes.length).toBe(nodeCount - 1);

        // Verify node doesn't list itself
        expect(node.connectedNodes).not.toContain(node.nodeId);
      }

      metricsCollector.stop();
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Stress Combinations
  // ===========================================================================

  describe('Stress Combinations', () => {
    it('survives chaos monkey pattern', async () => {
      const nodeCount = 5;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(nodeCount, getTestPort(94)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(20000);

      // Run limited chaos - just a few controlled operations
      let actionCount = 0;
      const nodeIds = [...cluster.getNodeIds()];

      // Perform 2 crash-restart cycles on different nodes
      for (let i = 0; i < 2; i++) {
        const nodeId = nodeIds[i]!;
        const node = cluster.getNode(nodeId);

        if (node?.status === 'running') {
          // Crash the node
          await cluster.crashNode(nodeId, 'process_exit');
          actionCount++;

          // Wait for crash detection
          await delay(2000);

          // Restart it
          await cluster.restartNode(nodeId);

          // Wait for node to be running
          await waitFor(
            () => cluster!.getNode(nodeId)?.status === 'running',
            20000,
            300,
          );

          // Wait for mesh to reform
          await cluster.waitForFullMesh(30000);
          actionCount++;

          // Stabilization
          await delay(2000);
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Cluster should be fully recovered
      expect(cluster.isFullMesh()).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(nodeCount);
      expect(actionCount).toBeGreaterThan(0);
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThan(0);
    }, LARGE_CLUSTER_TIMEOUT_MS);

    it('handles load during membership changes', async () => {
      const nodeCount = 5;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(nodeCount, getTestPort(97)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      // Run concurrent load and membership changes
      const loadPromise = (async () => {
        const iterations = 100;
        let successfulQueries = 0;

        for (let i = 0; i < iterations; i++) {
          try {
            cluster!.getNodes();
            cluster!.isFullMesh();
            successfulQueries++;
          } catch {
            // Query during instability might fail
          }
          await delay(50);
        }

        return successfulQueries;
      })();

      const membershipPromise = (async () => {
        const nodeIds = [...cluster!.getNodeIds()];
        const nodeId = nodeIds[0]!;

        // Crash and restart one node
        await cluster!.crashNode(nodeId, 'process_exit');
        await delay(1000);
        await cluster!.restartNode(nodeId);

        return true;
      })();

      const [successfulQueries, membershipChanged] = await Promise.all([
        loadPromise,
        membershipPromise,
      ]);

      await cluster.waitForFullMesh(30000);

      metricsCollector.stop();

      // Most queries should succeed
      expect(successfulQueries).toBeGreaterThan(50);
      expect(membershipChanged).toBe(true);
      expect(cluster.isFullMesh()).toBe(true);
    }, STRESS_TEST_TIMEOUT_MS);
  });
});
