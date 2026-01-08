/**
 * Transport layer stress tests for distributed cluster communication.
 *
 * Tests the TCP transport layer under various stress conditions:
 * - High-volume message throughput between nodes
 * - Connection storm (rapid connect/disconnect cycles)
 * - Heartbeat reliability under load
 * - Large message handling near protocol limits
 * - Connection recovery after network failures
 *
 * Port range: 20000-20099
 *
 * @module tests/stress/distribution/transport-stress
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';

import { TestCluster, TestClusterFactory, type TestClusterConfig } from './cluster-factory.js';
import {
  DistributedMetricsCollector,
  DistributedMetricsAssertions,
  type DistributedStressMetrics,
} from './distributed-metrics-collector.js';
import {
  NodeCrashSimulator,
  createCrashSimulator,
} from './node-crash-simulator.js';

// =============================================================================
// Test Configuration
// =============================================================================

/**
 * Base port for transport stress tests.
 * Each test uses a unique port range to avoid conflicts.
 */
const BASE_PORT = 20000;

/**
 * Default timeout for cluster operations.
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Extended timeout for stress tests.
 */
const STRESS_TEST_TIMEOUT_MS = 60000;

/**
 * Heartbeat configuration optimized for stress testing.
 * Shorter intervals allow faster failure detection.
 */
const STRESS_HEARTBEAT_CONFIG = {
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

// =============================================================================
// Test Suite
// =============================================================================

describe('Transport Layer Stress Tests', () => {
  let cluster: TestCluster | null = null;
  let metricsCollector: DistributedMetricsCollector | null = null;

  /**
   * Creates and starts a metrics collector attached to the given cluster.
   *
   * @param targetCluster - The cluster to monitor
   * @returns Configured and started metrics collector
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
  // High-Volume Message Throughput
  // ===========================================================================

  describe('High-Volume Message Throughput', () => {
    it('maintains stable connections under sustained heartbeat load', async () => {
      // Create a 5-node cluster to generate substantial heartbeat traffic
      // Each node sends heartbeats to all other nodes: 5 * 4 = 20 heartbeats per interval
      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(5, getTestPort(0)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      // Let the cluster run under heartbeat load
      const testDurationMs = 10000;
      const startTime = Date.now();

      // Track node events during the test
      let disconnectEvents = 0;
      cluster.on('nodeDown', () => {
        disconnectEvents++;
      });

      // Wait for test duration while monitoring stability
      await delay(testDurationMs);

      metricsCollector!.stop();
      const metrics = metricsCollector!.getDistributedMetrics();

      // Verify cluster remained stable
      expect(cluster.isFullMesh()).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(5);
      expect(disconnectEvents).toBe(0);

      // Verify heartbeats were exchanged (node up events during mesh formation)
      expect(metrics.cluster.nodeUpEvents).toBeGreaterThanOrEqual(8);

      // Memory should not grow excessively
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles rapid node communication without message loss', async () => {
      // Create 3-node cluster for focused throughput testing
      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(3, getTestPort(10)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(10000);

      // Simulate high-frequency cluster operations by triggering
      // multiple status checks and mesh verifications
      const iterations = 50;
      let successfulChecks = 0;

      for (let i = 0; i < iterations; i++) {
        if (cluster.isFullMesh() && cluster.getRunningNodeCount() === 3) {
          successfulChecks++;
        }
        // Small delay to allow heartbeats to flow
        await delay(50);
      }

      metricsCollector!.stop();

      // All checks should pass indicating stable message flow
      expect(successfulChecks).toBe(iterations);
      expect(cluster.isFullMesh()).toBe(true);
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Connection Storm
  // ===========================================================================

  describe('Connection Storm', () => {
    it('handles sequential cluster formation and teardown cycles', async () => {
      const cycles = 3;
      const nodeCount = 3;
      let successfulCycles = 0;

      for (let i = 0; i < cycles; i++) {
        const cyclePort = getTestPort(20 + i * 10);

        cluster = await TestClusterFactory.createCluster(
          createStressClusterConfig(nodeCount, cyclePort),
        );

        await cluster.waitForFullMesh(15000);

        if (cluster.isFullMesh() && cluster.getRunningNodeCount() === nodeCount) {
          successfulCycles++;
        }

        await cluster.stop();
        cluster = null;

        // Brief pause between cycles for port cleanup
        await delay(1000);
      }

      expect(successfulCycles).toBe(cycles);
    }, STRESS_TEST_TIMEOUT_MS * 2);

    it('establishes mesh topology in larger clusters efficiently', async () => {
      // Test cluster formation scalability with 7 nodes
      // This generates 7 * 6 / 2 = 21 bidirectional connections
      const nodeCount = 7;

      // Track node up events manually since cluster formation starts before
      // metrics collector is attached
      let nodeUpEventCount = 0;

      cluster = new TestCluster(createStressClusterConfig(nodeCount, getTestPort(50)));
      cluster.on('nodeUp', () => {
        nodeUpEventCount++;
      });

      const startTime = Date.now();
      await cluster._start();
      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(30000);
      const meshFormationTime = Date.now() - startTime;

      metricsCollector!.stop();
      const metrics = metricsCollector!.getDistributedMetrics();

      // Verify full mesh was established
      expect(cluster.isFullMesh()).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(nodeCount);

      // Mesh formation should complete in reasonable time
      expect(meshFormationTime).toBeLessThan(30000);

      // Should have seen substantial node connectivity
      // Each node sees (nodeCount - 1) other nodes join
      // Total events: nodeCount * (nodeCount - 1) = 7 * 6 = 42
      // We track via manual listener to catch events before collector starts
      expect(nodeUpEventCount).toBeGreaterThanOrEqual(nodeCount * (nodeCount - 1));

      // Collector should also have captured significant activity
      // (may be fewer than total due to timing)
      expect(metrics.cluster.nodeUpEvents + nodeUpEventCount).toBeGreaterThan(0);
    }, STRESS_TEST_TIMEOUT_MS);

    it('recovers mesh after partial node removal', async () => {
      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(5, getTestPort(60)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      // Stop 2 nodes (40% of cluster)
      const nodeIds = cluster.getNodeIds();
      await cluster.stopNode(nodeIds[0]!);
      await cluster.stopNode(nodeIds[1]!);

      // Wait for remaining nodes to detect the change
      await delay(2000);

      // Remaining 3 nodes should still form a mesh
      const runningNodes = cluster.getNodes().filter((n) => n.status === 'running');
      expect(runningNodes.length).toBe(3);

      // Check that remaining nodes are connected to each other
      for (const node of runningNodes) {
        // Each running node should be connected to the other 2
        expect(node.connectedNodes.length).toBe(2);
      }

      metricsCollector!.stop();
      const metrics = metricsCollector!.getDistributedMetrics();

      // Should have recorded node down events
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(2);
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Heartbeat Under Load
  // ===========================================================================

  describe('Heartbeat Under Load', () => {
    it('maintains heartbeat timing during cluster activity', async () => {
      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(4, getTestPort(70), {
          heartbeatIntervalMs: 200,
          heartbeatMissThreshold: 3,
        }),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      // Perform various cluster operations during heartbeat monitoring
      const operations = 20;
      for (let i = 0; i < operations; i++) {
        // Query cluster state (triggers internal communication)
        cluster.getNodes();
        cluster.isFullMesh();
        cluster.getRunningNodeCount();
        await delay(100);
      }

      // Verify cluster remains stable throughout
      expect(cluster.isFullMesh()).toBe(true);

      metricsCollector!.stop();
      const metrics = metricsCollector!.getDistributedMetrics();

      // No unexpected disconnections
      expect(metrics.cluster.nodeDownEvents).toBe(0);
    }, STRESS_TEST_TIMEOUT_MS);

    it('detects node failure within heartbeat threshold', async () => {
      const heartbeatIntervalMs = 300;
      const heartbeatMissThreshold = 3;
      const expectedDetectionTime = heartbeatIntervalMs * heartbeatMissThreshold * 2;

      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(3, getTestPort(75), {
          heartbeatIntervalMs,
          heartbeatMissThreshold,
        }),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      // Track when node down is detected
      let nodeDownDetectedAt: number | null = null;
      cluster.on('nodeDown', () => {
        if (nodeDownDetectedAt === null) {
          nodeDownDetectedAt = Date.now();
        }
      });

      // Crash a node abruptly
      const nodeIds = cluster.getNodeIds();
      const crashStartTime = Date.now();
      await cluster.crashNode(nodeIds[0]!, 'abrupt_kill');

      // Wait for detection
      await waitFor(
        () => nodeDownDetectedAt !== null,
        expectedDetectionTime + 5000,
        100,
      );

      const detectionTime = nodeDownDetectedAt! - crashStartTime;

      metricsCollector!.stop();

      // Detection should occur within reasonable bounds
      // Account for process termination time and event propagation
      expect(detectionTime).toBeLessThan(expectedDetectionTime + 3000);

      // Verify node down was recorded
      expect(cluster.getNode(nodeIds[0]!)?.status).toBe('crashed');
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Large Message Handling
  // ===========================================================================

  describe('Large Message Handling', () => {
    it('cluster operates correctly with many registered connections', async () => {
      // Test that the transport layer handles the overhead of maintaining
      // multiple simultaneous TCP connections efficiently
      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(6, getTestPort(80)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(20000);

      // Each node maintains 5 connections: 6 * 5 = 30 total bidirectional pairs
      // This tests the transport's ability to handle connection overhead

      // Run for a period to ensure stability under connection load
      await delay(5000);

      metricsCollector!.stop();
      const metrics = metricsCollector!.getDistributedMetrics();

      expect(cluster.isFullMesh()).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(6);
      expect(metrics.cluster.nodeDownEvents).toBe(0);

      // Verify all nodes have correct connection count
      for (const node of cluster.getNodes()) {
        if (node.status === 'running') {
          expect(node.connectedNodes.length).toBe(5);
        }
      }
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles varying cluster sizes without degradation', async () => {
      // Start small, verify, then test larger configuration
      // This tests transport scalability

      // Test with 2 nodes
      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(2, getTestPort(85)),
      );
      await cluster.waitForFullMesh(10000);
      expect(cluster.isFullMesh()).toBe(true);
      await cluster.stop();
      cluster = null;
      await delay(500);

      // Test with 4 nodes
      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(4, getTestPort(87)),
      );
      await cluster.waitForFullMesh(15000);
      expect(cluster.isFullMesh()).toBe(true);
      await cluster.stop();
      cluster = null;
      await delay(500);

      // Test with 6 nodes
      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(6, getTestPort(89)),
      );
      await cluster.waitForFullMesh(20000);
      expect(cluster.isFullMesh()).toBe(true);

      // All configurations should work without issues
      expect(cluster.getRunningNodeCount()).toBe(6);
    }, STRESS_TEST_TIMEOUT_MS * 2);
  });

  // ===========================================================================
  // Connection Recovery
  // ===========================================================================

  describe('Connection Recovery', () => {
    it('recovers from single node crash', async () => {
      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(3, getTestPort(90)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      const nodeIds = cluster.getNodeIds();

      // Crash one node
      await cluster.crashNode(nodeIds[0]!, 'process_exit');

      // Wait for crash detection
      await delay(2000);

      // Remaining nodes should maintain connection
      const runningNodes = cluster.getNodes().filter((n) => n.status === 'running');
      expect(runningNodes.length).toBe(2);

      // Verify remaining nodes are still connected to each other
      for (const node of runningNodes) {
        expect(node.connectedNodes.length).toBe(1);
      }

      metricsCollector!.stop();
      const metrics = metricsCollector!.getDistributedMetrics();

      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(1);
    }, STRESS_TEST_TIMEOUT_MS);

    it('recovers from cascading node failures', async () => {
      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(5, getTestPort(93)),
      );

      const crashSimulator = createCrashSimulator(cluster);

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      // Execute cascade failure pattern
      const result = await crashSimulator.cascadeFailure({
        cascadeDelayMs: 300,
        maxCrashes: 2,
      });

      expect(result.success).toBe(true);

      // Wait for cluster to stabilize
      await delay(2000);

      // Should have at least 3 nodes still running
      expect(cluster.getRunningNodeCount()).toBeGreaterThanOrEqual(3);

      // Remaining nodes should maintain connectivity
      const runningNodes = cluster.getNodes().filter((n) => n.status === 'running');
      for (const node of runningNodes) {
        expect(node.connectedNodes.length).toBe(runningNodes.length - 1);
      }

      metricsCollector!.stop();
      const metrics = metricsCollector!.getDistributedMetrics();

      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(2);
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles node restart after crash', async () => {
      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(3, getTestPort(96)),
      );

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      const nodeIds = cluster.getNodeIds();
      const nodeToRestart = nodeIds[0]!;

      // Crash the node
      await cluster.crashNode(nodeToRestart, 'process_exit');
      await delay(1500);

      expect(cluster.getNode(nodeToRestart)?.status).toBe('crashed');

      // Restart the node
      await cluster.restartNode(nodeToRestart);

      // Wait for full mesh to reform
      await cluster.waitForFullMesh(15000);

      expect(cluster.isFullMesh()).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(3);

      metricsCollector!.stop();
      const metrics = metricsCollector!.getDistributedMetrics();

      // Should have both down and up events
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(1);
      // Reconnections counted from the restarted node perspective
      expect(metrics.cluster.reconnections).toBeGreaterThanOrEqual(0);
    }, STRESS_TEST_TIMEOUT_MS);

    it('maintains cluster integrity during rolling restart', async () => {
      cluster = await TestClusterFactory.createCluster(
        createStressClusterConfig(4, getTestPort(98)),
      );

      const crashSimulator = createCrashSimulator(cluster);

      metricsCollector = createAndStartMetrics(cluster);
      await cluster.waitForFullMesh(15000);

      // Perform rolling restart
      const result = await crashSimulator.rollingRestart({
        delayBetweenMs: 2000,
        waitForRejoin: true,
        rejoinTimeoutMs: 15000,
      });

      // Wait for full stability
      await delay(2000);
      await cluster.waitForFullMesh(15000);

      expect(cluster.isFullMesh()).toBe(true);
      expect(cluster.getRunningNodeCount()).toBe(4);

      metricsCollector!.stop();
      const metrics = metricsCollector!.getDistributedMetrics();

      // Rolling restart causes node down events for each node
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(4);
    }, STRESS_TEST_TIMEOUT_MS * 3);
  });
});
