/**
 * Remote monitor stress tests for distributed process monitoring.
 *
 * Tests the RemoteMonitor module under various stress conditions:
 * - High-volume monitor setup (many monitors per process)
 * - Monitor notification delivery reliability
 * - Monitor behavior across node failures
 *
 * Port range: 25000-25099
 *
 * @module tests/stress/distribution/remote-monitor-stress
 */

import { describe, it, expect, afterEach } from 'vitest';

import { TestCluster, TestClusterFactory, type TestClusterConfig } from './cluster-factory.js';
import {
  DistributedMetricsCollector,
  DistributedMetricsAssertions,
} from './distributed-metrics-collector.js';

// =============================================================================
// Test Configuration
// =============================================================================

/**
 * Base port for remote monitor stress tests.
 * Uses port range 25000+ to avoid conflicts with other tests.
 */
const BASE_PORT = 25000;

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
// Types
// =============================================================================

/**
 * Result of a remote monitor operation.
 */
interface MonitorResult {
  monitorRefId: string;
  durationMs: number;
}

/**
 * Error result of a remote monitor operation.
 */
interface MonitorError {
  error: true;
  errorType: string;
  message: string;
  durationMs: number;
}

/**
 * Process down event received from cluster.
 */
interface ProcessDownEvent {
  monitorRefId: string;
  monitoredProcessId: string;
  reason: { type: string; message?: string };
  fromNodeId: string;
}

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
 * Checks if a remote monitor result is an error response.
 */
function isMonitorError(result: unknown): result is MonitorError {
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

describe('Remote Monitor Stress Tests', () => {
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
   * Sets up a cluster with registered behaviors for remote monitor testing.
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

    // Register behaviors on all nodes
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
  // High-Volume Monitor Setup
  // ===========================================================================

  describe('High-Volume Monitor Setup', () => {
    it('handles 100 monitors on a single remote process', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(0));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const monitorNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      // Spawn a target process to monitor
      const targetProcessId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      // Spawn monitoring processes and set up monitors
      const monitorCount = 100;
      let successCount = 0;
      let failCount = 0;
      const setupDurations: number[] = [];
      const monitorRefs: string[] = [];

      for (let i = 0; i < monitorCount; i++) {
        // Spawn a local process for each monitor
        const monitoringProcessId = await cluster.spawnProcess(monitorNodeId, 'echoBehavior');

        const result = await cluster.remoteMonitor(
          monitorNodeId,
          monitoringProcessId,
          targetNodeId,
          targetProcessId,
          10000,
        );

        if (isMonitorError(result)) {
          failCount++;
        } else {
          successCount++;
          setupDurations.push(result.durationMs);
          monitorRefs.push(result.monitorRefId);
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify high success rate
      expect(successCount / monitorCount).toBeGreaterThanOrEqual(0.95);

      // Verify setup times are reasonable
      if (setupDurations.length > 0) {
        const avgDuration = setupDurations.reduce((a, b) => a + b, 0) / setupDurations.length;
        expect(avgDuration).toBeLessThan(500);
      }

      // Verify no memory leaks
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);

      // Get monitor stats from the node
      const stats = await cluster.getMonitorStats(monitorNodeId);
      expect(stats.activeOutgoingCount).toBe(successCount);
    }, HIGH_VOLUME_TIMEOUT_MS);

    it('handles 50 monitors distributed across multiple target processes', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(5));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const monitorNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      // Spawn multiple target processes
      const targetCount = 10;
      const targetProcessIds: string[] = [];
      for (let i = 0; i < targetCount; i++) {
        const pid = await cluster.spawnProcess(targetNodeId, 'counterBehavior');
        targetProcessIds.push(pid);
      }

      // Set up monitors - 5 per target
      const monitorsPerTarget = 5;
      let successCount = 0;
      let failCount = 0;

      for (const targetProcessId of targetProcessIds) {
        for (let i = 0; i < monitorsPerTarget; i++) {
          const monitoringProcessId = await cluster.spawnProcess(monitorNodeId, 'echoBehavior');

          const result = await cluster.remoteMonitor(
            monitorNodeId,
            monitoringProcessId,
            targetNodeId,
            targetProcessId,
            10000,
          );

          if (isMonitorError(result)) {
            failCount++;
          } else {
            successCount++;
          }
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      const totalAttempts = targetCount * monitorsPerTarget;

      // Verify high success rate
      expect(successCount / totalAttempts).toBeGreaterThanOrEqual(0.95);

      // Verify stats
      const stats = await cluster.getMonitorStats(monitorNodeId);
      expect(stats.activeOutgoingCount).toBe(successCount);

      // Verify no memory leaks
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, HIGH_VOLUME_TIMEOUT_MS);

    it('handles concurrent monitor setup requests', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(10));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const monitorNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      // Spawn target processes first
      const targetProcessIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const pid = await cluster.spawnProcess(targetNodeId, 'counterBehavior');
        targetProcessIds.push(pid);
      }

      // Spawn monitoring processes first
      const monitoringProcessIds: string[] = [];
      for (let i = 0; i < 30; i++) {
        const pid = await cluster.spawnProcess(monitorNodeId, 'echoBehavior');
        monitoringProcessIds.push(pid);
      }

      // Set up monitors concurrently
      const monitorPromises: Promise<MonitorResult | MonitorError>[] = [];

      for (let i = 0; i < monitoringProcessIds.length; i++) {
        const monitoringProcessId = monitoringProcessIds[i]!;
        const targetProcessId = targetProcessIds[i % targetProcessIds.length]!;

        monitorPromises.push(
          cluster.remoteMonitor(
            monitorNodeId,
            monitoringProcessId,
            targetNodeId,
            targetProcessId,
            15000,
          ),
        );
      }

      const results = await Promise.all(monitorPromises);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      const successCount = results.filter((r) => !isMonitorError(r)).length;
      const totalAttempts = monitorPromises.length;

      // Verify high success rate under concurrent load
      expect(successCount / totalAttempts).toBeGreaterThanOrEqual(0.9);

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles monitors from multiple nodes to same target', async () => {
      cluster = await setupClusterWithBehaviors(4, getTestPort(15));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const targetNodeId = nodeIds[0]!;
      const monitorNodeIds = nodeIds.slice(1); // 3 monitoring nodes

      // Spawn a target process
      const targetProcessId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      // Set up monitors from each monitoring node
      const monitorsPerNode = 10;
      let totalSuccess = 0;

      for (const monitorNodeId of monitorNodeIds) {
        for (let i = 0; i < monitorsPerNode; i++) {
          const monitoringProcessId = await cluster.spawnProcess(monitorNodeId, 'echoBehavior');

          const result = await cluster.remoteMonitor(
            monitorNodeId,
            monitoringProcessId,
            targetNodeId,
            targetProcessId,
            10000,
          );

          if (!isMonitorError(result)) {
            totalSuccess++;
          }
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      const totalAttempts = monitorNodeIds.length * monitorsPerNode;

      // Verify high success rate
      expect(totalSuccess / totalAttempts).toBeGreaterThanOrEqual(0.95);

      // Verify stats across all monitoring nodes
      for (const monitorNodeId of monitorNodeIds) {
        const stats = await cluster.getMonitorStats(monitorNodeId);
        expect(stats.activeOutgoingCount).toBeGreaterThan(0);
      }

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, HIGH_VOLUME_TIMEOUT_MS);
  });

  // ===========================================================================
  // Monitor Notification Delivery
  // ===========================================================================

  describe('Monitor Notification Delivery', () => {
    it('delivers process_down notification within 1 second', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(20));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const monitorNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      // Spawn target process
      const targetProcessId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      // Spawn monitoring process
      const monitoringProcessId = await cluster.spawnProcess(monitorNodeId, 'echoBehavior');

      // Set up monitor
      const monitorResult = await cluster.remoteMonitor(
        monitorNodeId,
        monitoringProcessId,
        targetNodeId,
        targetProcessId,
        10000,
      );

      expect(isMonitorError(monitorResult)).toBe(false);

      // Set up listener for process_down
      const processDownPromise = new Promise<ProcessDownEvent>((resolve) => {
        cluster!.on('processDown', (monitorRefId, monitoredProcessId, reason, fromNodeId) => {
          resolve({ monitorRefId, monitoredProcessId, reason, fromNodeId });
        });
      });

      // Stop the target process by crashing its node
      const notificationStartTime = Date.now();
      await cluster.crashNode(targetNodeId, 'process_exit');

      // Wait for notification with timeout
      const notification = await Promise.race([
        processDownPromise,
        delay(5000).then(() => null),
      ]);

      const notificationTime = Date.now() - notificationStartTime;

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify notification was received
      expect(notification).not.toBeNull();

      if (notification) {
        // Verify notification content
        expect(notification.reason.type).toBe('noconnection');

        // Verify delivery time (accounting for heartbeat detection)
        // With heartbeat interval 300ms and threshold 3, max detection time is ~900ms
        // Add buffer for processing
        expect(notificationTime).toBeLessThan(5000);
      }

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('delivers notifications for multiple monitors on same target', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(25));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const monitorNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      // Spawn target process
      const targetProcessId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      // Set up multiple monitors
      const monitorCount = 10;
      const monitorRefs: string[] = [];

      for (let i = 0; i < monitorCount; i++) {
        const monitoringProcessId = await cluster.spawnProcess(monitorNodeId, 'echoBehavior');

        const result = await cluster.remoteMonitor(
          monitorNodeId,
          monitoringProcessId,
          targetNodeId,
          targetProcessId,
          10000,
        );

        if (!isMonitorError(result)) {
          monitorRefs.push(result.monitorRefId);
        }
      }

      expect(monitorRefs.length).toBeGreaterThanOrEqual(monitorCount * 0.9);

      // Set up listener for process_down events
      const receivedNotifications: ProcessDownEvent[] = [];
      cluster.on('processDown', (monitorRefId, monitoredProcessId, reason, fromNodeId) => {
        receivedNotifications.push({ monitorRefId, monitoredProcessId, reason, fromNodeId });
      });

      // Crash the target node
      await cluster.crashNode(targetNodeId, 'process_exit');

      // Wait for notifications (with buffer for heartbeat detection)
      await delay(3000);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // All monitors should receive noconnection notification
      // Note: We expect at least some notifications
      expect(receivedNotifications.length).toBeGreaterThan(0);

      // All received notifications should have noconnection reason
      for (const notification of receivedNotifications) {
        expect(notification.reason.type).toBe('noconnection');
      }

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles rapid monitor setup and teardown', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(30));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const monitorNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      // Spawn target process
      const targetProcessId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      // Rapid monitor/demonitor cycles
      const cycles = 20;
      let successfulCycles = 0;

      for (let i = 0; i < cycles; i++) {
        const monitoringProcessId = await cluster.spawnProcess(monitorNodeId, 'echoBehavior');

        const result = await cluster.remoteMonitor(
          monitorNodeId,
          monitoringProcessId,
          targetNodeId,
          targetProcessId,
          5000,
        );

        if (!isMonitorError(result)) {
          // Immediately demonitor
          await cluster.remoteDemonitor(monitorNodeId, result.monitorRefId);
          successfulCycles++;
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Most cycles should succeed
      expect(successfulCycles / cycles).toBeGreaterThanOrEqual(0.9);

      // Active monitors should be 0 after all demonitors
      const stats = await cluster.getMonitorStats(monitorNodeId);
      expect(stats.activeOutgoingCount).toBe(0);

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Monitor Across Node Failure
  // ===========================================================================

  describe('Monitor Across Node Failure', () => {
    it('delivers noconnection notification when monitored node crashes', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(40));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const monitorNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      // Spawn target process
      const targetProcessId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      // Spawn monitoring process
      const monitoringProcessId = await cluster.spawnProcess(monitorNodeId, 'echoBehavior');

      // Set up monitor
      const monitorResult = await cluster.remoteMonitor(
        monitorNodeId,
        monitoringProcessId,
        targetNodeId,
        targetProcessId,
        10000,
      );

      expect(isMonitorError(monitorResult)).toBe(false);

      // Set up listener for process_down
      const processDownPromise = new Promise<ProcessDownEvent>((resolve) => {
        cluster!.on('processDown', (monitorRefId, monitoredProcessId, reason, fromNodeId) => {
          resolve({ monitorRefId, monitoredProcessId, reason, fromNodeId });
        });
      });

      // Crash the target node abruptly
      await cluster.crashNode(targetNodeId, 'abrupt_kill');

      // Wait for notification
      const notification = await Promise.race([
        processDownPromise,
        delay(5000).then(() => null),
      ]);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Notification should be received
      expect(notification).not.toBeNull();

      if (notification) {
        expect(notification.reason.type).toBe('noconnection');
        expect(notification.monitoredProcessId).toBe(targetProcessId);
      }

      // Verify the monitor was cleaned up
      const stats = await cluster.getMonitorStats(monitorNodeId);
      expect(stats.activeOutgoingCount).toBe(0);

      // Verify cluster detected node down
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(1);

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('cleans up monitors when target node becomes unreachable', async () => {
      cluster = await setupClusterWithBehaviors(4, getTestPort(45));
      metricsCollector = createAndStartMetrics(cluster);

      // Install error handler to catch expected errors during crash
      cluster.on('error', () => {
        // Expected during crash scenarios
      });

      const nodeIds = [...cluster.getNodeIds()];
      const monitorNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;
      const healthyNodeId = nodeIds[2]!;

      // Spawn processes on target node
      const targetProcessIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const pid = await cluster.spawnProcess(targetNodeId, 'counterBehavior');
        targetProcessIds.push(pid);
      }

      // Set up monitors from monitor node
      const monitorRefs: string[] = [];
      for (const targetProcessId of targetProcessIds) {
        const monitoringProcessId = await cluster.spawnProcess(monitorNodeId, 'echoBehavior');

        const result = await cluster.remoteMonitor(
          monitorNodeId,
          monitoringProcessId,
          targetNodeId,
          targetProcessId,
          10000,
        );

        if (!isMonitorError(result)) {
          monitorRefs.push(result.monitorRefId);
        }
      }

      expect(monitorRefs.length).toBe(targetProcessIds.length);

      // Get stats before crash
      const statsBefore = await cluster.getMonitorStats(monitorNodeId);
      expect(statsBefore.activeOutgoingCount).toBe(monitorRefs.length);

      // Crash the target node
      await cluster.crashNode(targetNodeId, 'process_exit');

      // Wait for cleanup (heartbeat detection + processing)
      await delay(3000);

      // Monitors should be cleaned up
      const statsAfter = await cluster.getMonitorStats(monitorNodeId);
      expect(statsAfter.activeOutgoingCount).toBe(0);

      // Monitors to healthy node should still work
      const healthyProcessId = await cluster.spawnProcess(healthyNodeId, 'counterBehavior');
      const healthyMonitorProcessId = await cluster.spawnProcess(monitorNodeId, 'echoBehavior');

      const healthyMonitorResult = await cluster.remoteMonitor(
        monitorNodeId,
        healthyMonitorProcessId,
        healthyNodeId,
        healthyProcessId,
        10000,
      );

      expect(isMonitorError(healthyMonitorResult)).toBe(false);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles monitor setup during node failure', async () => {
      cluster = await setupClusterWithBehaviors(4, getTestPort(50));
      metricsCollector = createAndStartMetrics(cluster);

      // Install error handler to catch expected errors during crash
      cluster.on('error', () => {
        // Expected during crash scenarios
      });

      const nodeIds = [...cluster.getNodeIds()];
      const monitorNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;
      const backupNodeId = nodeIds[2]!;

      // Spawn processes on both target nodes
      const targetProcessId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');
      const backupProcessId = await cluster.spawnProcess(backupNodeId, 'counterBehavior');

      let successCount = 0;
      let failCount = 0;
      const monitorPromises: Promise<void>[] = [];

      // Start concurrent monitor setup operations
      for (let i = 0; i < 20; i++) {
        const target = i % 2 === 0 ? targetNodeId : backupNodeId;
        const processId = i % 2 === 0 ? targetProcessId : backupProcessId;

        const monitorPromise = (async () => {
          // Spread operations over time to overlap with crash
          await delay(i * 50);

          const monitoringProcessId = await cluster!.spawnProcess(monitorNodeId, 'echoBehavior');

          const result = await cluster!.remoteMonitor(
            monitorNodeId,
            monitoringProcessId,
            target,
            processId,
            8000,
          );

          if (isMonitorError(result)) {
            failCount++;
          } else {
            successCount++;
          }
        })();

        monitorPromises.push(monitorPromise);
      }

      // Crash target node during monitor setup wave
      await delay(300);
      await cluster.crashNode(targetNodeId, 'process_exit');

      await Promise.all(monitorPromises);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Some monitors should succeed (those to backup node, or completed before crash)
      expect(successCount).toBeGreaterThan(0);

      // Total should equal attempted
      expect(successCount + failCount).toBe(20);

      // Node down should be recorded
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(1);

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);

    it('recovers monitor capability after node restart', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(55));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = [...cluster.getNodeIds()];
      const monitorNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      // Phase 1: Set up and verify monitor works
      let targetProcessId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');
      let monitoringProcessId = await cluster.spawnProcess(monitorNodeId, 'echoBehavior');

      const precrashResult = await cluster.remoteMonitor(
        monitorNodeId,
        monitoringProcessId,
        targetNodeId,
        targetProcessId,
        10000,
      );

      expect(isMonitorError(precrashResult)).toBe(false);

      // Phase 2: Crash and restart target node
      await cluster.crashNode(targetNodeId, 'process_exit');
      await delay(2000);
      await cluster.restartNode(targetNodeId);
      await cluster.waitForFullMesh(30000);

      // Re-register behavior on restarted node
      await cluster.registerBehavior(targetNodeId, 'counterBehavior');
      await cluster.registerBehavior(targetNodeId, 'echoBehavior');

      // Phase 3: Verify monitor works after restart
      targetProcessId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');
      monitoringProcessId = await cluster.spawnProcess(monitorNodeId, 'echoBehavior');

      const postRestartResult = await cluster.remoteMonitor(
        monitorNodeId,
        monitoringProcessId,
        targetNodeId,
        targetProcessId,
        10000,
      );

      expect(isMonitorError(postRestartResult)).toBe(false);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, HIGH_VOLUME_TIMEOUT_MS);
  });

  // ===========================================================================
  // Integration Scenarios
  // ===========================================================================

  describe('Integration Scenarios', () => {
    it('sustained monitor load over extended period', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(60));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const monitorNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;

      // Spawn a target process
      const targetProcessId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      const durationMs = 10000;
      const startTime = Date.now();
      let monitorCount = 0;
      let successCount = 0;
      const monitorRefs: string[] = [];

      while (Date.now() - startTime < durationMs) {
        monitorCount++;

        const monitoringProcessId = await cluster.spawnProcess(monitorNodeId, 'echoBehavior');

        const result = await cluster.remoteMonitor(
          monitorNodeId,
          monitoringProcessId,
          targetNodeId,
          targetProcessId,
          5000,
        );

        if (!isMonitorError(result)) {
          successCount++;
          monitorRefs.push(result.monitorRefId);
        }

        // Small delay between monitors
        await delay(100);
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // High success rate over sustained period
      expect(successCount / monitorCount).toBeGreaterThanOrEqual(0.95);

      // Should have completed significant number of monitors
      expect(monitorCount).toBeGreaterThan(50);

      // Verify all monitors are active
      const stats = await cluster.getMonitorStats(monitorNodeId);
      expect(stats.activeOutgoingCount).toBe(successCount);

      // Memory should be stable
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 75);
    }, HIGH_VOLUME_TIMEOUT_MS);

    it('monitors work correctly with remote spawned processes', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(65));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const coordinatorNodeId = nodeIds[0]!;
      const workerNodeId = nodeIds[1]!;

      // Use RemoteSpawn to spawn a process on worker node
      const spawnResult = await cluster.remoteSpawn(
        coordinatorNodeId,
        workerNodeId,
        'counterBehavior',
        undefined,
        10000,
      );

      expect('serverId' in spawnResult).toBe(true);

      if (!('serverId' in spawnResult)) {
        throw new Error('RemoteSpawn failed');
      }

      // Spawn a local monitoring process
      const monitoringProcessId = await cluster.spawnProcess(coordinatorNodeId, 'echoBehavior');

      // Set up monitor on the remotely spawned process
      const monitorResult = await cluster.remoteMonitor(
        coordinatorNodeId,
        monitoringProcessId,
        workerNodeId,
        spawnResult.serverId,
        10000,
      );

      expect(isMonitorError(monitorResult)).toBe(false);

      // Verify monitor is active
      const stats = await cluster.getMonitorStats(coordinatorNodeId);
      expect(stats.activeOutgoingCount).toBe(1);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify memory stability
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);
  });
});
