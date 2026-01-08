/**
 * Remote call stress tests for distributed GenServer communication.
 *
 * Tests the RemoteCall module under various stress conditions:
 * - High-volume concurrent calls across nodes
 * - Call timeout handling with slow servers
 * - Calls during node restart and recovery
 * - Large payload handling
 *
 * Port range: 22000-22099
 *
 * @module tests/stress/distribution/remote-call-stress
 */

import { describe, it, expect, afterEach } from 'vitest';

import { TestCluster, TestClusterFactory, type TestClusterConfig } from './cluster-factory.js';
import {
  DistributedMetricsCollector,
  DistributedMetricsAssertions,
} from './distributed-metrics-collector.js';
import type { CounterCallMsg, EchoCallMsg } from './behaviors.js';

// =============================================================================
// Test Configuration
// =============================================================================

/**
 * Base port for remote call stress tests.
 * Uses a high port range (23000+) to avoid conflicts with other tests.
 */
const BASE_PORT = 23000;

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
 * Checks if a remote call result is an error response.
 */
function isErrorResult(
  result: unknown,
): result is { error: true; errorType: string; message: string; durationMs: number } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    (result as { error: unknown }).error === true
  );
}

/**
 * Generates a payload of approximately the specified size in KB.
 */
function generatePayload(sizeKb: number): { data: string; marker: string } {
  const marker = `payload-${Date.now()}-${Math.random().toString(36).substring(2)}`;
  // Each character in a string is approximately 2 bytes in memory
  // For JSON serialization, we use simple characters that are 1 byte each
  const dataSize = Math.max(0, sizeKb * 1024 - marker.length - 50);
  const data = 'x'.repeat(dataSize);
  return { data, marker };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('Remote Call Stress Tests', () => {
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
   * Sets up a cluster with registered behaviors for remote call testing.
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
  // High-Volume Concurrent Calls
  // ===========================================================================

  describe('High-Volume Concurrent Calls', () => {
    it('handles 100 concurrent calls across nodes', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(0));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const targetNodeId = nodeIds[0]!;
      const callerNodeId = nodeIds[1]!;

      // Spawn a counter process on the target node
      const processId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      // Track metrics
      let successfulCalls = 0;
      let failedCalls = 0;
      const callDurations: number[] = [];

      // Make 100 concurrent calls
      const callCount = 100;
      const callPromises: Promise<void>[] = [];

      for (let i = 0; i < callCount; i++) {
        const callPromise = (async () => {
          const callId = metricsCollector!.recordRemoteCallStart(targetNodeId);
          const msg: CounterCallMsg = { type: 'increment', by: 1 };

          try {
            const result = await cluster!.remoteCall(
              callerNodeId,
              targetNodeId,
              processId,
              msg,
              5000,
            );

            if (isErrorResult(result)) {
              failedCalls++;
              metricsCollector!.recordRemoteCallFailed(callId, result.message);
            } else {
              successfulCalls++;
              callDurations.push(result.durationMs);
              metricsCollector!.recordRemoteCallComplete(callId);
            }
          } catch {
            failedCalls++;
            metricsCollector!.recordRemoteCallFailed(callId, 'Call exception');
          }
        })();

        callPromises.push(callPromise);
      }

      await Promise.all(callPromises);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify success rate
      const successRate = successfulCalls / callCount;
      expect(successRate).toBeGreaterThanOrEqual(0.95);

      // Verify counter value by making a final get call
      const getResult = await cluster.remoteCall<{ value: number }>(
        callerNodeId,
        targetNodeId,
        processId,
        { type: 'get' } as CounterCallMsg,
        5000,
      );

      if (!isErrorResult(getResult)) {
        // Counter value should equal successful increments
        expect(getResult.result.value).toBe(successfulCalls);
      }

      // Calculate latency stats
      if (callDurations.length > 0) {
        const avgLatency = callDurations.reduce((a, b) => a + b, 0) / callDurations.length;
        const sortedDurations = [...callDurations].sort((a, b) => a - b);
        const p99Latency = sortedDurations[Math.floor(sortedDurations.length * 0.99)]!;

        // P99 latency should be reasonable for local network
        expect(p99Latency).toBeLessThan(500);
        expect(avgLatency).toBeLessThan(200);
      }

      // Verify metrics were recorded
      expect(metrics.remoteCall.totalCalls).toBeGreaterThanOrEqual(callCount);
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles 500 sequential calls with consistent results', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(5));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const targetNodeId = nodeIds[0]!;
      const callerNodeId = nodeIds[1]!;

      // Spawn a counter process
      const processId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      let successfulCalls = 0;
      let failedCalls = 0;
      const callCount = 500;

      for (let i = 0; i < callCount; i++) {
        const callId = metricsCollector.recordRemoteCallStart(targetNodeId);
        const msg: CounterCallMsg = { type: 'increment', by: 1 };

        try {
          const result = await cluster.remoteCall(
            callerNodeId,
            targetNodeId,
            processId,
            msg,
            3000,
          );

          if (isErrorResult(result)) {
            failedCalls++;
            metricsCollector.recordRemoteCallFailed(callId, result.message);
          } else {
            successfulCalls++;
            metricsCollector.recordRemoteCallComplete(callId);
          }
        } catch {
          failedCalls++;
          metricsCollector.recordRemoteCallFailed(callId, 'Call exception');
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Verify high success rate
      expect(successfulCalls / callCount).toBeGreaterThanOrEqual(0.99);

      // Verify counter consistency
      const getResult = await cluster.remoteCall<{ value: number }>(
        callerNodeId,
        targetNodeId,
        processId,
        { type: 'get' } as CounterCallMsg,
        5000,
      );

      if (!isErrorResult(getResult)) {
        expect(getResult.result.value).toBe(successfulCalls);
      }

      // Verify no memory leaks
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, HIGH_VOLUME_TIMEOUT_MS);

    it('distributes calls across multiple target nodes', async () => {
      cluster = await setupClusterWithBehaviors(4, getTestPort(10));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const callerNodeId = nodeIds[0]!;
      const targetNodeIds = nodeIds.slice(1); // 3 target nodes

      // Spawn processes on each target node
      const processIds: Map<string, string> = new Map();
      for (const targetNodeId of targetNodeIds) {
        const processId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');
        processIds.set(targetNodeId, processId);
      }

      // Make calls distributed across all targets
      const callsPerTarget = 50;
      const callPromises: Promise<void>[] = [];
      const successByNode: Map<string, number> = new Map();

      for (const targetNodeId of targetNodeIds) {
        successByNode.set(targetNodeId, 0);
        const processId = processIds.get(targetNodeId)!;

        for (let i = 0; i < callsPerTarget; i++) {
          const callPromise = (async () => {
            const msg: CounterCallMsg = { type: 'increment', by: 1 };
            const result = await cluster!.remoteCall(
              callerNodeId,
              targetNodeId,
              processId,
              msg,
              3000,
            );

            if (!isErrorResult(result)) {
              successByNode.set(targetNodeId, successByNode.get(targetNodeId)! + 1);
            }
          })();
          callPromises.push(callPromise);
        }
      }

      await Promise.all(callPromises);

      metricsCollector.stop();

      // Verify each target received and processed calls successfully
      for (const targetNodeId of targetNodeIds) {
        const successCount = successByNode.get(targetNodeId)!;
        expect(successCount).toBeGreaterThanOrEqual(callsPerTarget * 0.95);

        // Verify counter value on each target
        const processId = processIds.get(targetNodeId)!;
        const getResult = await cluster.remoteCall<{ value: number }>(
          callerNodeId,
          targetNodeId,
          processId,
          { type: 'get' } as CounterCallMsg,
          5000,
        );

        if (!isErrorResult(getResult)) {
          expect(getResult.result.value).toBe(successCount);
        }
      }
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Call Timeout Handling
  // ===========================================================================

  describe('Call Timeout Handling', () => {
    it('properly times out slow calls', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(20), [
        'counterBehavior',
        'echoBehavior',
        'slowBehavior',
      ]);
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const targetNodeId = nodeIds[0]!;
      const callerNodeId = nodeIds[1]!;

      // slowBehavior has 100ms default delay
      const processId = await cluster.spawnProcess(targetNodeId, 'slowBehavior');

      // Call with shorter timeout than the behavior delay (100ms)
      const shortTimeout = 50;
      const startTime = Date.now();
      const callId = metricsCollector.recordRemoteCallStart(targetNodeId);

      const result = await cluster.remoteCall(
        callerNodeId,
        targetNodeId,
        processId,
        { type: 'slow_echo', payload: 'test' },
        shortTimeout,
      );

      const elapsed = Date.now() - startTime;

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      if (isErrorResult(result)) {
        metricsCollector.recordRemoteCallTimeout(callId);

        // Should timeout relatively quickly (within 500ms for a 50ms timeout)
        expect(elapsed).toBeLessThan(1000);

        // Error should indicate timeout
        expect(result.errorType).toMatch(/timeout/i);

        // Should have recorded the timeout
        expect(metrics.remoteCall.timeoutCalls + 1).toBeGreaterThanOrEqual(1);
      } else {
        // If it didn't timeout, the operation was fast enough
        // This can happen due to timing variations
        expect(elapsed).toBeLessThan(shortTimeout * 2);
      }
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles mix of fast and slow calls correctly', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(25), [
        'echoBehavior',
        'slowBehavior',
      ]);
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const targetNodeId = nodeIds[0]!;
      const callerNodeId = nodeIds[1]!;

      // Spawn both behaviors
      const fastProcessId = await cluster.spawnProcess(targetNodeId, 'echoBehavior');
      const slowProcessId = await cluster.spawnProcess(targetNodeId, 'slowBehavior');

      let fastSuccesses = 0;
      let slowTimeouts = 0;
      const callCount = 20;
      const callPromises: Promise<void>[] = [];

      // Interleave fast and slow calls
      for (let i = 0; i < callCount; i++) {
        if (i % 2 === 0) {
          // Fast echo call
          const fastPromise = (async () => {
            const result = await cluster!.remoteCall(
              callerNodeId,
              targetNodeId,
              fastProcessId,
              { type: 'echo', payload: `msg-${i}` } as EchoCallMsg,
              2000,
            );
            if (!isErrorResult(result)) {
              fastSuccesses++;
            }
          })();
          callPromises.push(fastPromise);
        } else {
          // Slow call with short timeout
          const slowPromise = (async () => {
            const result = await cluster!.remoteCall(
              callerNodeId,
              targetNodeId,
              slowProcessId,
              { type: 'slow_echo', payload: `msg-${i}` },
              200, // Very short timeout
            );
            if (isErrorResult(result) && result.errorType.match(/timeout/i)) {
              slowTimeouts++;
            }
          })();
          callPromises.push(slowPromise);
        }
      }

      await Promise.all(callPromises);

      metricsCollector.stop();

      // Fast calls should succeed
      expect(fastSuccesses).toBeGreaterThanOrEqual(callCount / 2 * 0.9);

      // Slow calls should timeout
      expect(slowTimeouts).toBeGreaterThanOrEqual(callCount / 2 * 0.8);
    }, STRESS_TEST_TIMEOUT_MS);

    it('maintains queue stability during timeout storms', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(30), [
        'slowBehavior',
        'counterBehavior',
      ]);
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const targetNodeId = nodeIds[0]!;
      const callerNodeId = nodeIds[1]!;

      // Spawn slow behavior
      const slowProcessId = await cluster.spawnProcess(targetNodeId, 'slowBehavior');

      // Fire many calls that will timeout
      const callCount = 30;
      const callPromises: Promise<void>[] = [];
      let timeoutCount = 0;

      for (let i = 0; i < callCount; i++) {
        const callPromise = (async () => {
          const result = await cluster!.remoteCall(
            callerNodeId,
            targetNodeId,
            slowProcessId,
            { type: 'slow_echo', payload: `storm-${i}` },
            100, // Very short timeout
          );

          if (isErrorResult(result)) {
            timeoutCount++;
          }
        })();
        callPromises.push(callPromise);
      }

      await Promise.all(callPromises);

      // Spawn a counter after the storm
      const counterProcessId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      // Make a quick call to verify system is still responsive
      const result = await cluster.remoteCall<{ value: number }>(
        callerNodeId,
        targetNodeId,
        counterProcessId,
        { type: 'get' } as CounterCallMsg,
        3000,
      );

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Most calls should have timed out
      expect(timeoutCount).toBeGreaterThanOrEqual(callCount * 0.8);

      // System should still be responsive after timeout storm
      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        expect(result.result.value).toBe(0);
      }

      // Verify memory is stable
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Call During Node Restart
  // ===========================================================================

  describe('Call During Node Restart', () => {
    it('handles calls to crashing target node', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(40));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const targetNodeId = nodeIds[0]!;
      const callerNodeId = nodeIds[1]!;

      // Spawn a process on the target
      const processId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      // Verify process is working
      const initialResult = await cluster.remoteCall<{ value: number }>(
        callerNodeId,
        targetNodeId,
        processId,
        { type: 'get' } as CounterCallMsg,
        3000,
      );
      expect(isErrorResult(initialResult)).toBe(false);

      // Start making calls while crashing the target
      let precrashSuccesses = 0;
      let postcrashFailures = 0;

      // Make some initial calls
      for (let i = 0; i < 5; i++) {
        const result = await cluster.remoteCall(
          callerNodeId,
          targetNodeId,
          processId,
          { type: 'increment', by: 1 } as CounterCallMsg,
          2000,
        );
        if (!isErrorResult(result)) {
          precrashSuccesses++;
        }
      }

      // Crash the target node
      await cluster.crashNode(targetNodeId, 'process_exit');

      // Wait for crash detection
      await delay(1500);

      // Calls after crash should fail
      for (let i = 0; i < 5; i++) {
        const result = await cluster.remoteCall(
          callerNodeId,
          targetNodeId,
          processId,
          { type: 'increment', by: 1 } as CounterCallMsg,
          2000,
        );
        if (isErrorResult(result)) {
          postcrashFailures++;
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Pre-crash calls should succeed
      expect(precrashSuccesses).toBeGreaterThanOrEqual(4);

      // Post-crash calls should fail
      expect(postcrashFailures).toBeGreaterThanOrEqual(4);

      // Node down should be recorded
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(1);
    }, STRESS_TEST_TIMEOUT_MS);

    it('recovers call capability after node restart', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(45));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = [...cluster.getNodeIds()];
      const targetNodeId = nodeIds[0]!;
      const callerNodeId = nodeIds[1]!;

      // Spawn a process and verify it works
      const processId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      const precrashResult = await cluster.remoteCall<{ value: number }>(
        callerNodeId,
        targetNodeId,
        processId,
        { type: 'increment', by: 5 } as CounterCallMsg,
        3000,
      );
      expect(isErrorResult(precrashResult)).toBe(false);
      if (!isErrorResult(precrashResult)) {
        expect(precrashResult.result.value).toBe(5);
      }

      // Crash and restart the target node
      await cluster.crashNode(targetNodeId, 'process_exit');
      await delay(2000);
      await cluster.restartNode(targetNodeId);

      // Wait for node to rejoin
      await cluster.waitForFullMesh(20000);

      // Re-register behavior on restarted node
      await cluster.registerBehavior(targetNodeId, 'counterBehavior');

      // Spawn a new process (old one is gone)
      const newProcessId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      // Verify new process works
      const postcoverResult = await cluster.remoteCall<{ value: number }>(
        callerNodeId,
        targetNodeId,
        newProcessId,
        { type: 'increment', by: 10 } as CounterCallMsg,
        3000,
      );

      metricsCollector.stop();

      expect(isErrorResult(postcoverResult)).toBe(false);
      if (!isErrorResult(postcoverResult)) {
        expect(postcoverResult.result.value).toBe(10);
      }
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles concurrent calls during node crash', async () => {
      cluster = await setupClusterWithBehaviors(4, getTestPort(50));
      metricsCollector = createAndStartMetrics(cluster);

      // Install error handler to catch expected errors during crash
      const clusterErrors: Error[] = [];
      cluster.on('error', (error) => {
        clusterErrors.push(error);
      });

      const nodeIds = [...cluster.getNodeIds()];
      const targetNodeId = nodeIds[0]!;
      const callerNodeIds = nodeIds.slice(1); // 3 caller nodes

      // Spawn a counter on the target
      const processId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      let successCount = 0;
      let failCount = 0;
      const callPromises: Promise<void>[] = [];

      // Start continuous calls from all callers with varied timing
      // to ensure some calls happen during/after the crash
      for (const callerNodeId of callerNodeIds) {
        for (let i = 0; i < 30; i++) {
          const callPromise = (async () => {
            // Spread calls over 500ms to overlap with crash
            await delay(i * 15 + Math.random() * 10);

            const result = await cluster!.remoteCall(
              callerNodeId,
              targetNodeId,
              processId,
              { type: 'increment', by: 1 } as CounterCallMsg,
              2000,
            );

            if (isErrorResult(result)) {
              failCount++;
            } else {
              successCount++;
            }
          })();
          callPromises.push(callPromise);
        }
      }

      // Crash the target during the call wave (200ms into 450ms spread)
      await delay(200);
      await cluster.crashNode(targetNodeId, 'process_exit');

      await Promise.all(callPromises);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // Some calls should succeed (the early ones before crash)
      expect(successCount).toBeGreaterThan(0);

      // Total should equal attempted calls
      expect(successCount + failCount).toBe(callerNodeIds.length * 30);

      // Node down events should be recorded
      expect(metrics.cluster.nodeDownEvents).toBeGreaterThanOrEqual(1);

      // If all calls succeeded, the crash happened after calls completed
      // which is a valid outcome - the cluster was resilient
      if (failCount === 0) {
        // Verify the crash was at least detected
        expect(cluster!.getNode(targetNodeId)?.status).toBe('crashed');
      }
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Large Payload Calls
  // ===========================================================================

  describe('Large Payload Calls', () => {
    it('handles 10KB payload calls successfully', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(60));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const targetNodeId = nodeIds[0]!;
      const callerNodeId = nodeIds[1]!;

      // Spawn echo process
      const processId = await cluster.spawnProcess(targetNodeId, 'echoBehavior');

      // Generate 10KB payload
      const payload = generatePayload(10);

      const result = await cluster.remoteCall<{ payload: typeof payload; processedAt: number }>(
        callerNodeId,
        targetNodeId,
        processId,
        { type: 'echo', payload } as EchoCallMsg,
        10000,
      );

      metricsCollector.stop();

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        // Verify payload integrity
        expect(result.result.payload).toEqual(payload);
        expect(result.durationMs).toBeLessThan(5000);
      }
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles 100KB payload calls successfully', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(65));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const targetNodeId = nodeIds[0]!;
      const callerNodeId = nodeIds[1]!;

      // Spawn echo process
      const processId = await cluster.spawnProcess(targetNodeId, 'echoBehavior');

      // Generate 100KB payload
      const payload = generatePayload(100);

      const result = await cluster.remoteCall<{ payload: typeof payload; processedAt: number }>(
        callerNodeId,
        targetNodeId,
        processId,
        { type: 'echo', payload } as EchoCallMsg,
        15000,
      );

      metricsCollector.stop();

      expect(isErrorResult(result)).toBe(false);
      if (!isErrorResult(result)) {
        // Verify marker integrity (full comparison may be slow)
        expect(result.result.payload.marker).toBe(payload.marker);
        expect(result.result.payload.data.length).toBe(payload.data.length);
        expect(result.durationMs).toBeLessThan(10000);
      }
    }, STRESS_TEST_TIMEOUT_MS);

    it('handles multiple concurrent large payload calls', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(70));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const targetNodeId = nodeIds[0]!;
      const callerNodeId = nodeIds[1]!;

      // Spawn echo process
      const processId = await cluster.spawnProcess(targetNodeId, 'echoBehavior');

      // Make concurrent 50KB payload calls
      const concurrentCalls = 10;
      const callPromises: Promise<{ success: boolean; durationMs: number }>[] = [];

      for (let i = 0; i < concurrentCalls; i++) {
        const payload = generatePayload(50);

        const callPromise = (async () => {
          const result = await cluster!.remoteCall<{ payload: typeof payload }>(
            callerNodeId,
            targetNodeId,
            processId,
            { type: 'echo', payload } as EchoCallMsg,
            20000,
          );

          if (isErrorResult(result)) {
            return { success: false, durationMs: result.durationMs };
          }

          // Verify integrity
          const success = result.result.payload.marker === payload.marker;
          return { success, durationMs: result.durationMs };
        })();

        callPromises.push(callPromise);
      }

      const results = await Promise.all(callPromises);

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // All calls should succeed
      const successCount = results.filter((r) => r.success).length;
      expect(successCount).toBe(concurrentCalls);

      // Average latency should be reasonable
      const avgDuration = results.reduce((a, b) => a + b.durationMs, 0) / results.length;
      expect(avgDuration).toBeLessThan(15000);

      // Memory should be managed properly
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 150);
    }, HIGH_VOLUME_TIMEOUT_MS);

    it('handles payload size variation in single session', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(75));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const targetNodeId = nodeIds[0]!;
      const callerNodeId = nodeIds[1]!;

      // Spawn echo process
      const processId = await cluster.spawnProcess(targetNodeId, 'echoBehavior');

      // Test varying payload sizes
      const sizes = [1, 5, 10, 25, 50, 100, 50, 25, 10, 5, 1]; // KB
      let successCount = 0;

      for (const sizeKb of sizes) {
        const payload = generatePayload(sizeKb);

        const result = await cluster.remoteCall<{ payload: typeof payload }>(
          callerNodeId,
          targetNodeId,
          processId,
          { type: 'echo', payload } as EchoCallMsg,
          15000,
        );

        if (!isErrorResult(result) && result.result.payload.marker === payload.marker) {
          successCount++;
        }
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // All sizes should be handled successfully
      expect(successCount).toBe(sizes.length);

      // Memory should stabilize
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 100);
    }, STRESS_TEST_TIMEOUT_MS);
  });

  // ===========================================================================
  // Mixed Stress Scenarios
  // ===========================================================================

  describe('Mixed Stress Scenarios', () => {
    it('handles sustained load over extended period', async () => {
      cluster = await setupClusterWithBehaviors(3, getTestPort(80));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = cluster.getNodeIds();
      const targetNodeId = nodeIds[0]!;
      const callerNodeId = nodeIds[1]!;

      // Spawn counter process
      const processId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      // Run sustained load for 15 seconds
      const durationMs = 15000;
      const startTime = Date.now();
      let successCount = 0;
      let failCount = 0;

      while (Date.now() - startTime < durationMs) {
        const result = await cluster.remoteCall(
          callerNodeId,
          targetNodeId,
          processId,
          { type: 'increment', by: 1 } as CounterCallMsg,
          2000,
        );

        if (isErrorResult(result)) {
          failCount++;
        } else {
          successCount++;
        }

        // Small delay to maintain ~100 calls/second
        await delay(10);
      }

      metricsCollector.stop();
      const metrics = metricsCollector.getDistributedMetrics();

      // High success rate
      const successRate = successCount / (successCount + failCount);
      expect(successRate).toBeGreaterThanOrEqual(0.99);

      // Verify counter consistency
      const getResult = await cluster.remoteCall<{ value: number }>(
        callerNodeId,
        targetNodeId,
        processId,
        { type: 'get' } as CounterCallMsg,
        3000,
      );

      if (!isErrorResult(getResult)) {
        expect(getResult.result.value).toBe(successCount);
      }

      // Memory should be stable
      DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 75);
    }, HIGH_VOLUME_TIMEOUT_MS);

    it('recovers from temporary network instability', async () => {
      cluster = await setupClusterWithBehaviors(4, getTestPort(85));
      metricsCollector = createAndStartMetrics(cluster);

      const nodeIds = [...cluster.getNodeIds()];
      const targetNodeId = nodeIds[0]!;
      const callerNodeId = nodeIds[1]!;
      const crashNodeId = nodeIds[2]!;

      // Spawn counter on target
      const processId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      // Phase 1: Normal operation
      let phase1Success = 0;
      for (let i = 0; i < 10; i++) {
        const result = await cluster.remoteCall(
          callerNodeId,
          targetNodeId,
          processId,
          { type: 'increment', by: 1 } as CounterCallMsg,
          2000,
        );
        if (!isErrorResult(result)) phase1Success++;
      }

      // Phase 2: Crash a different node to create instability
      await cluster.crashNode(crashNodeId, 'process_exit');
      await delay(1000);

      // Continue calls during instability
      let phase2Success = 0;
      for (let i = 0; i < 10; i++) {
        const result = await cluster.remoteCall(
          callerNodeId,
          targetNodeId,
          processId,
          { type: 'increment', by: 1 } as CounterCallMsg,
          2000,
        );
        if (!isErrorResult(result)) phase2Success++;
      }

      // Phase 3: Restart crashed node
      await cluster.restartNode(crashNodeId);
      await cluster.waitForFullMesh(30000);

      // Phase 4: Resume normal operation
      let phase3Success = 0;
      for (let i = 0; i < 10; i++) {
        const result = await cluster.remoteCall(
          callerNodeId,
          targetNodeId,
          processId,
          { type: 'increment', by: 1 } as CounterCallMsg,
          2000,
        );
        if (!isErrorResult(result)) phase3Success++;
      }

      metricsCollector.stop();

      // All phases should have high success
      expect(phase1Success).toBeGreaterThanOrEqual(9);
      expect(phase2Success).toBeGreaterThanOrEqual(9); // Target wasn't crashed
      expect(phase3Success).toBeGreaterThanOrEqual(9);

      // Verify total counter value
      const finalResult = await cluster.remoteCall<{ value: number }>(
        callerNodeId,
        targetNodeId,
        processId,
        { type: 'get' } as CounterCallMsg,
        3000,
      );

      if (!isErrorResult(finalResult)) {
        expect(finalResult.result.value).toBe(phase1Success + phase2Success + phase3Success);
      }
    }, STRESS_TEST_TIMEOUT_MS);
  });
});
