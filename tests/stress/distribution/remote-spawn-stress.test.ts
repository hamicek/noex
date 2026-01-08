/**
 * Remote spawn stress tests for distributed GenServer instantiation.
 *
 * Tests the RemoteSpawn module under various stress conditions:
 * - Rapid sequential spawns across nodes
 * - Concurrent spawn requests
 * - Spawning with failing init handlers
 * - Spawning during node failures
 *
 * Port range: 24000-24099
 *
 * @module tests/stress/distribution/remote-spawn-stress
 */

import { describe, it, expect, afterEach } from 'vitest';

import { TestCluster, TestClusterFactory, type TestClusterConfig } from './cluster-factory.js';
import {
  DistributedMetricsCollector,
  DistributedMetricsAssertions,
} from './distributed-metrics-collector.js';
import type { CounterCallMsg } from './behaviors.js';

// =============================================================================
// Test Configuration
// =============================================================================

/**
 * Base port for remote spawn stress tests.
 * Uses port range 24000+ to avoid conflicts with other tests.
 */
const BASE_PORT = 24000;

/**
 * Default timeout for cluster operations.
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Extended timeout for stress tests.
 */
const STRESS_TEST_TIMEOUT_MS = 120000;

/**
 * Long timeout for high-volume tests.
 */
const HIGH_VOLUME_TIMEOUT_MS = 180000;

/**
 * Heartbeat configuration optimized for stress testing.
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
 * Checks if a remote spawn result is an error response.
 */
function isSpawnError(
  result: unknown,
): result is { error: true; errorType: string; message: string; durationMs: number } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    (result as { error: unknown }).error === true
  );
}

// =============================================================================
// Test Suite
// =============================================================================

describe('Remote Spawn Stress Tests', () => {
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

  /**
   * Sets up a cluster with registered behaviors for remote spawn testing.
   */
  async function setupClusterWithBehaviors(
    nodeCount: number,
    basePort: number,
    behaviors: string[] = ['counterBehavior', 'echoBehavior'],
  ): Promise<TestCluster> {
    const testCluster = await TestClusterFactory.createCluster(
      createStressClusterConfig(nodeCount, basePort),
    );

    await testCluster.waitForFullMesh(30000);

    // Register behaviors on all nodes (required for RemoteSpawn)
    const nodeIds = testCluster.getNodeIds();
    for (const nodeId of nodeIds) {
      for (const behavior of behaviors) {
        await testCluster.registerBehavior(nodeId, behavior);
      }
    }

    return testCluster;
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
  // Rapid Sequential Spawns
  // ===========================================================================

  describe('Rapid Sequential Spawns', () => {
    it('handles 50 sequential spawns successfully', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(0));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const spawnerNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      const spawnCount = 50;
      let successCount = 0;
      let failCount = 0;
      const spawnDurations: number[] = [];

      for (let i = 0; i < spawnCount; i++) {
        const spawnId = metricsCollector.recordRemoteSpawnStart(targetNodeId);

        const result = await cluster.remoteSpawn(
          spawnerNodeId,
          targetNodeId,
          'counterBehavior',
          undefined,
          10000,
        );

        if (isSpawnError(result)) {
          failCount++;
          metricsCollector.recordRemoteSpawnFailed(spawnId, result.message);
        } else {
          successCount++;
          spawnDurations.push(result.durationMs);
          metricsCollector.recordRemoteSpawnComplete(spawnId, result.serverId);
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify high success rate
      expect(successCount / spawnCount).toBeGreaterThanOrEqual(0.98);

      // Verify spawn times are reasonable
      if (spawnDurations.length > 0) {
        const avgDuration = spawnDurations.reduce((a, b) => a + b, 0) / spawnDurations.length;
        expect(avgDuration).toBeLessThan(500);
      }

      // Verify metrics were recorded
      expect(metrics.remoteSpawn.totalSpawns).toBeGreaterThanOrEqual(spawnCount);

      // Verify no memory leaks
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('maintains spawn rate of ~10 spawns/second', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(5));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const spawnerNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      const targetSpawnsPerSecond = 10;
      const testDurationSeconds = 5;
      const totalSpawns = targetSpawnsPerSecond * testDurationSeconds;
      const delayBetweenSpawns = 1000 / targetSpawnsPerSecond;

      let successCount = 0;
      const startTime = Date.now();

      for (let i = 0; i < totalSpawns; i++) {
        const spawnId = metricsCollector.recordRemoteSpawnStart(targetNodeId);
        const iterationStart = Date.now();

        const result = await cluster.remoteSpawn(
          spawnerNodeId,
          targetNodeId,
          'counterBehavior',
          undefined,
          5000,
        );

        if (!isSpawnError(result)) {
          successCount++;
          metricsCollector.recordRemoteSpawnComplete(spawnId, result.serverId);
        } else {
          metricsCollector.recordRemoteSpawnFailed(spawnId, result.message);
        }

        // Pace the spawns to maintain target rate
        const iterationDuration = Date.now() - iterationStart;
        const remainingDelay = Math.max(0, delayBetweenSpawns - iterationDuration);
        if (remainingDelay > 0) {
          await delay(remainingDelay);
        }
      }

      const totalDuration = Date.now() - startTime;
      const actualRate = successCount / (totalDuration / 1000);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Should maintain at least 80% of target rate
      expect(actualRate).toBeGreaterThanOrEqual(targetSpawnsPerSecond * 0.8);

      // High success rate
      expect(successCount / totalSpawns).toBeGreaterThanOrEqual(0.95);

      // Memory should be stable
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 75);
    }, STRESS_TEST_TIMEOUT_MS);

    it('spawns distributed across multiple target nodes', async () => {
      cluster = await setupClusterWithBehaviors(4, getTestPort(10));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const spawnerNodeId = nodeIds[0]!;
      const targetNodeIds = nodeIds.slice(1); // 3 target nodes

      const spawnsPerTarget = 15;
      const successByNode: Map<string, number> = new Map();

      for (const targetNodeId of targetNodeIds) {
        successByNode.set(targetNodeId, 0);

        for (let i = 0; i < spawnsPerTarget; i++) {
          const spawnId = metricsCollector.recordRemoteSpawnStart(targetNodeId);

          const result = await cluster.remoteSpawn(
            spawnerNodeId,
            targetNodeId,
            'echoBehavior',
            undefined,
            8000,
          );

          if (!isSpawnError(result)) {
            successByNode.set(targetNodeId, successByNode.get(targetNodeId)! + 1);
            metricsCollector.recordRemoteSpawnComplete(spawnId, result.serverId);
          } else {
            metricsCollector.recordRemoteSpawnFailed(spawnId, result.message);
          }
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify each target received spawns successfully
      for (const targetNodeId of targetNodeIds) {
        const successCount = successByNode.get(targetNodeId)!;
        expect(successCount).toBeGreaterThanOrEqual(spawnsPerTarget * 0.9);
      }

      // Verify total spawns
      const totalSuccess = Array.from(successByNode.values()).reduce((a, b) => a + b, 0);
      const totalAttempts = targetNodeIds.length * spawnsPerTarget;
      expect(totalSuccess / totalAttempts).toBeGreaterThanOrEqual(0.95);

      // Memory should be stable
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Concurrent Spawns
  // ===========================================================================

  describe('Concurrent Spawns', () => {
    it('handles 30 concurrent spawn requests', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(20));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const spawnerNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      const concurrentSpawns = 30;
      const spawnPromises: Promise<void>[] = [];
      let successCount = 0;
      let failCount = 0;
      const spawnDurations: number[] = [];

      for (let i = 0; i < concurrentSpawns; i++) {
        const spawnPromise = (async () => {
          const spawnId = metricsCollector!.recordRemoteSpawnStart(targetNodeId);

          const result = await cluster!.remoteSpawn(
            spawnerNodeId,
            targetNodeId,
            'counterBehavior',
            undefined,
            15000,
          );

          if (isSpawnError(result)) {
            failCount++;
            metricsCollector!.recordRemoteSpawnFailed(spawnId, result.message);
          } else {
            successCount++;
            spawnDurations.push(result.durationMs);
            metricsCollector!.recordRemoteSpawnComplete(spawnId, result.serverId);
          }
        })();

        spawnPromises.push(spawnPromise);
      }

      await Promise.all(spawnPromises);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify high success rate under concurrent load
      const successRate = successCount / concurrentSpawns;
      expect(successRate).toBeGreaterThanOrEqual(0.9);

      // Calculate latency stats
      if (spawnDurations.length > 0) {
        const sortedDurations = [...spawnDurations].sort((a, b) => a - b);
        const p95Duration = sortedDurations[Math.floor(sortedDurations.length * 0.95)]!;

        // P95 spawn time should be reasonable even under concurrent load
        expect(p95Duration).toBeLessThan(5000);
      }

      // Verify metrics
      expect(metrics.remoteSpawn.totalSpawns).toBeGreaterThanOrEqual(concurrentSpawns);

      // Memory should be managed properly
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles concurrent spawns from multiple callers', async () => {
      cluster = await setupClusterWithBehaviors(4, getTestPort(25));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const targetNodeId = nodeIds[0]!;
      const callerNodeIds = nodeIds.slice(1); // 3 caller nodes

      const spawnsPerCaller = 15;
      const spawnPromises: Promise<void>[] = [];
      let totalSuccess = 0;
      let totalFail = 0;

      for (const callerNodeId of callerNodeIds) {
        for (let i = 0; i < spawnsPerCaller; i++) {
          const spawnPromise = (async () => {
            const spawnId = metricsCollector!.recordRemoteSpawnStart(targetNodeId);

            const result = await cluster!.remoteSpawn(
              callerNodeId,
              targetNodeId,
              'echoBehavior',
              undefined,
              15000,
            );

            if (isSpawnError(result)) {
              totalFail++;
              metricsCollector!.recordRemoteSpawnFailed(spawnId, result.message);
            } else {
              totalSuccess++;
              metricsCollector!.recordRemoteSpawnComplete(spawnId, result.serverId);
            }
          })();

          spawnPromises.push(spawnPromise);
        }
      }

      await Promise.all(spawnPromises);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      const totalAttempts = callerNodeIds.length * spawnsPerCaller;

      // High success rate with multiple callers
      expect(totalSuccess / totalAttempts).toBeGreaterThanOrEqual(0.9);

      // Verify total equals attempted
      expect(totalSuccess + totalFail).toBe(totalAttempts);

      // Memory should be stable
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('maintains stability during spawn burst', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(30));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const spawnerNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      // Phase 1: Burst of concurrent spawns
      const burstSize = 20;
      let burstSuccess = 0;
      const burstPromises: Promise<void>[] = [];

      for (let i = 0; i < burstSize; i++) {
        const spawnPromise = (async () => {
          const result = await cluster!.remoteSpawn(
            spawnerNodeId,
            targetNodeId,
            'counterBehavior',
            undefined,
            10000,
          );

          if (!isSpawnError(result)) {
            burstSuccess++;
          }
        })();
        burstPromises.push(spawnPromise);
      }

      await Promise.all(burstPromises);

      // Phase 2: Sequential spawns after burst to verify stability
      let postBurstSuccess = 0;
      const postBurstCount = 10;

      for (let i = 0; i < postBurstCount; i++) {
        const result = await cluster.remoteSpawn(
          spawnerNodeId,
          targetNodeId,
          'counterBehavior',
          undefined,
          10000,
        );

        if (!isSpawnError(result)) {
          postBurstSuccess++;
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Burst should have high success rate
      expect(burstSuccess / burstSize).toBeGreaterThanOrEqual(0.85);

      // Post-burst spawns should work normally
      expect(postBurstSuccess / postBurstCount).toBeGreaterThanOrEqual(0.95);

      // System should remain stable
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Spawn with Failing Init
  // ===========================================================================

  describe('Spawn with Failing Init', () => {
    it('properly handles init failure', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(40), [
        'counterBehavior',
        'crashOnInitBehavior',
      ]);
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const spawnerNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      const spawnId = metricsCollector.recordRemoteSpawnStart(targetNodeId);

      const result = await cluster.remoteSpawn(
        spawnerNodeId,
        targetNodeId,
        'crashOnInitBehavior',
        undefined,
        10000,
      );

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Spawn should fail due to init error
      expect(isSpawnError(result)).toBe(true);

      if (isSpawnError(result)) {
        metricsCollector.recordRemoteSpawnFailed(spawnId, result.message);
        // Error should indicate init failure
        expect(result.message.toLowerCase()).toContain('init');
      }

      // Should have recorded the failed spawn
      expect(metrics.remoteSpawn.totalSpawns).toBeGreaterThanOrEqual(1);
    }, STRESS_TEST_TIMEOUT_MS);

    it('recovers after failed init and spawns normally', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(45), [
        'counterBehavior',
        'crashOnInitBehavior',
      ]);
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const spawnerNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      // Phase 1: Try to spawn a crashing behavior
      const crashResult = await cluster.remoteSpawn(
        spawnerNodeId,
        targetNodeId,
        'crashOnInitBehavior',
        undefined,
        10000,
      );

      expect(isSpawnError(crashResult)).toBe(true);

      // Phase 2: Normal spawn should still work
      let successCount = 0;
      const normalSpawnCount = 10;

      for (let i = 0; i < normalSpawnCount; i++) {
        const result = await cluster.remoteSpawn(
          spawnerNodeId,
          targetNodeId,
          'counterBehavior',
          undefined,
          10000,
        );

        if (!isSpawnError(result)) {
          successCount++;
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Normal spawns should succeed after failed init
      expect(successCount / normalSpawnCount).toBeGreaterThanOrEqual(0.95);

      // Memory should be stable
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles mix of successful and failing spawns', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(50), [
        'counterBehavior',
        'echoBehavior',
        'crashOnInitBehavior',
      ]);
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const spawnerNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      const behaviors = ['counterBehavior', 'crashOnInitBehavior', 'echoBehavior'];
      let successCount = 0;
      let expectedFailCount = 0;
      let actualFailCount = 0;

      // Interleave successful and failing spawns
      for (let i = 0; i < 15; i++) {
        const behavior = behaviors[i % behaviors.length]!;
        const shouldFail = behavior === 'crashOnInitBehavior';

        if (shouldFail) {
          expectedFailCount++;
        }

        const result = await cluster.remoteSpawn(
          spawnerNodeId,
          targetNodeId,
          behavior,
          undefined,
          10000,
        );

        if (isSpawnError(result)) {
          actualFailCount++;
        } else {
          successCount++;
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Crashing behaviors should fail
      expect(actualFailCount).toBe(expectedFailCount);

      // Non-crashing behaviors should succeed (15 total - 5 crashOnInit = 10)
      expect(successCount).toBeGreaterThanOrEqual(8); // Allow some tolerance

      // Memory should be stable despite failures
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Spawn During Node Down
  // ===========================================================================

  describe('Spawn During Node Down', () => {
    it('handles spawn to crashed node gracefully', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(60));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const spawnerNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      // Verify spawn works before crash
      const precrashResult = await cluster.remoteSpawn(
        spawnerNodeId,
        targetNodeId,
        'counterBehavior',
        undefined,
        10000,
      );
      expect(isSpawnError(precrashResult)).toBe(false);

      // Crash the target node
      await cluster.crashNode(targetNodeId, 'process_exit');
      await delay(2000);

      // Spawn to crashed node should fail gracefully
      const postcrassResult = await cluster.remoteSpawn(
        spawnerNodeId,
        targetNodeId,
        'counterBehavior',
        undefined,
        5000,
      );

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Spawn to crashed node should return error (not throw)
      expect(isSpawnError(postcrassResult)).toBe(true);

      // Node down should be recorded
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(1);
    }, STRESS_TEST_TIMEOUT_MS);

    it('redirects spawns to healthy nodes after node crash', async () => {
      cluster = await setupClusterWithBehaviors(4, getTestPort(65));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = [...cluster.getNodeIds()];
      const spawnerNodeId = nodeIds[0]!;
      const crashNodeId = nodeIds[1]!;
      const healthyNodeId = nodeIds[2]!;

      // Verify both target nodes work initially
      const result1 = await cluster.remoteSpawn(
        spawnerNodeId,
        crashNodeId,
        'counterBehavior',
        undefined,
        10000,
      );
      expect(isSpawnError(result1)).toBe(false);

      const result2 = await cluster.remoteSpawn(
        spawnerNodeId,
        healthyNodeId,
        'counterBehavior',
        undefined,
        10000,
      );
      expect(isSpawnError(result2)).toBe(false);

      // Crash one node
      await cluster.crashNode(crashNodeId, 'process_exit');
      await delay(2000);

      // Spawns to healthy node should still work
      let healthyNodeSuccess = 0;
      const spawnCount = 10;

      for (let i = 0; i < spawnCount; i++) {
        const result = await cluster.remoteSpawn(
          spawnerNodeId,
          healthyNodeId,
          'counterBehavior',
          undefined,
          10000,
        );

        if (!isSpawnError(result)) {
          healthyNodeSuccess++;
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Spawns to healthy node should succeed
      expect(healthyNodeSuccess / spawnCount).toBeGreaterThanOrEqual(0.9);

      // Node down should be recorded
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(1);

      // Memory should be stable
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles concurrent spawns during node crash', async () => {
      cluster = await setupClusterWithBehaviors(4, getTestPort(70));
      metricsCollector = createAndStartMetrics(cluster);

      // Install error handler to catch expected errors during crash
      cluster.on('error', () => {
        // Expected during crash scenarios
      });

      const nodeIds = [...cluster.getNodeIds()];
      const spawnerNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;
      const backupNodeId = nodeIds[2]!;

      let successCount = 0;
      let failCount = 0;
      const spawnPromises: Promise<void>[] = [];

      // Start concurrent spawns to both target and backup
      for (let i = 0; i < 20; i++) {
        const target = i % 2 === 0 ? targetNodeId : backupNodeId;

        const spawnPromise = (async () => {
          // Spread spawns over time to overlap with crash
          await delay(i * 50);

          const result = await cluster!.remoteSpawn(
            spawnerNodeId,
            target,
            'counterBehavior',
            undefined,
            8000,
          );

          if (isSpawnError(result)) {
            failCount++;
          } else {
            successCount++;
          }
        })();

        spawnPromises.push(spawnPromise);
      }

      // Crash target node during spawn wave
      await delay(300);
      await cluster.crashNode(targetNodeId, 'process_exit');

      await Promise.all(spawnPromises);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Some spawns should succeed (those to backup node, or completed before crash)
      expect(successCount).toBeGreaterThan(0);

      // Total should equal attempted
      expect(successCount + failCount).toBe(20);

      // Node down should be recorded
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(1);
    }, STRESS_TEST_TIMEOUT_MS);

    it('recovers spawn capability after node restart', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(75));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = [...cluster.getNodeIds()];
      const spawnerNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      // Phase 1: Verify spawn works
      const precrashResult = await cluster.remoteSpawn(
        spawnerNodeId,
        targetNodeId,
        'counterBehavior',
        undefined,
        10000,
      );
      expect(isSpawnError(precrashResult)).toBe(false);

      // Phase 2: Crash and restart target
      await cluster.crashNode(targetNodeId, 'process_exit');
      await delay(2000);
      await cluster.restartNode(targetNodeId);
      await cluster.waitForFullMesh(30000);

      // Re-register behavior on restarted node
      await cluster.registerBehavior(targetNodeId, 'counterBehavior');

      // Phase 3: Verify spawn works after restart
      let postRestartSuccess = 0;
      const spawnCount = 10;

      for (let i = 0; i < spawnCount; i++) {
        const result = await cluster.remoteSpawn(
          spawnerNodeId,
          targetNodeId,
          'counterBehavior',
          undefined,
          10000,
        );

        if (!isSpawnError(result)) {
          postRestartSuccess++;
        }
      }

      metricsCollector.stop();

      // Spawns should work after node restart
      expect(postRestartSuccess / spawnCount).toBeGreaterThanOrEqual(0.9);
    }, HIGH_VOLUME_TIMEOUT_MS);
  });

  // ===========================================================================
  // Integration Scenarios
  // ===========================================================================

  describe('Integration Scenarios', () => {
    it('spawn and immediately call the spawned process', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(80));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const spawnerNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      let successCount = 0;
      const iterations = 20;

      for (let i = 0; i < iterations; i++) {
        // Spawn a counter on remote node
        const spawnResult = await cluster.remoteSpawn(
          spawnerNodeId,
          targetNodeId,
          'counterBehavior',
          undefined,
          10000,
        );

        if (isSpawnError(spawnResult)) {
          continue;
        }

        // Immediately call the spawned process
        const callResult = await cluster.remoteCall<{ value: number }>(
          spawnerNodeId,
          targetNodeId,
          spawnResult.serverId,
          { type: 'increment', by: 5 } as CounterCallMsg,
          5000,
        );

        if (
          typeof callResult === 'object' &&
          callResult !== null &&
          'result' in callResult &&
          typeof (callResult as { result: { value: number } }).result === 'object'
        ) {
          const typedResult = callResult as { result: { value: number } };
          if (typedResult.result.value === 5) {
            successCount++;
          }
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Most spawn+call operations should succeed
      expect(successCount / iterations).toBeGreaterThanOrEqual(0.9);

      // Memory should be stable
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('sustained spawn load over extended period', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(85));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const spawnerNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      const durationMs = 15000;
      const startTime = Date.now();
      let spawnCount = 0;
      let successCount = 0;

      while (Date.now() - startTime < durationMs) {
        spawnCount++;

        const result = await cluster.remoteSpawn(
          spawnerNodeId,
          targetNodeId,
          'counterBehavior',
          undefined,
          5000,
        );

        if (!isSpawnError(result)) {
          successCount++;
        }

        // Small delay between spawns
        await delay(100);
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // High success rate over sustained period
      expect(successCount / spawnCount).toBeGreaterThanOrEqual(0.95);

      // Should have completed significant number of spawns
      expect(spawnCount).toBeGreaterThan(100);

      // Memory should be stable
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 75);
    }, HIGH_VOLUME_TIMEOUT_MS);
  });
});
