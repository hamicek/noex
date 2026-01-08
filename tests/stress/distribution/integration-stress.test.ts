/**
 * Integration stress tests for distributed system.
 *
 * Full-stack tests combining all distributed components under real-world
 * conditions:
 *
 * - Distributed worker pool with task queue and chaos injection
 * - Full cluster under sustained high load
 * - Rolling upgrade simulation with continuous traffic
 *
 * Port range: 28000-28099
 *
 * @module tests/stress/distribution/integration-stress
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  TestClusterFactory,
  type TestCluster,
} from './cluster-factory.js';

// =============================================================================
// Test Configuration
// =============================================================================

const BASE_PORT = 28000;
const CLUSTER_FORMATION_TIMEOUT = 30_000;
const DEFAULT_CALL_TIMEOUT = 10_000;

/**
 * Creates a unique port for a test to avoid conflicts.
 */
let portOffset = 0;
function getNextBasePort(): number {
  const port = BASE_PORT + portOffset;
  portOffset += 15;
  return port;
}

/**
 * Waits for a specific condition with timeout.
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs: number = 100,
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Delay utility.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculates statistics for an array of numbers.
 */
function calculateStats(values: number[]): {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
} {
  if (values.length === 0) {
    return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((acc, v) => acc + v, 0);

  return {
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    avg: sum / values.length,
    p50: sorted[Math.floor(sorted.length * 0.5)]!,
    p95: sorted[Math.floor(sorted.length * 0.95)]!,
    p99: sorted[Math.floor(sorted.length * 0.99)]!,
  };
}

// =============================================================================
// Distributed Worker Pool Tests
// =============================================================================

describe('Integration Stress Tests', () => {
  describe('Distributed Worker Pool', () => {
    let cluster: TestCluster;
    let nodeIds: string[];

    beforeAll(async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 5,
        basePort: getNextBasePort(),
        heartbeatIntervalMs: 300,
        heartbeatMissThreshold: 3,
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Cluster formation timeout')),
          CLUSTER_FORMATION_TIMEOUT,
        );
        cluster.on('fullMesh', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      nodeIds = cluster.getNodeIds() as string[];

      // Register behaviors on all nodes
      for (const nodeId of nodeIds) {
        await cluster.registerBehavior(nodeId, 'counterBehavior');
        await cluster.registerBehavior(nodeId, 'echoBehavior');
        await cluster.registerBehavior(nodeId, 'statefulBehavior');
      }
    }, 90_000);

    afterAll(async () => {
      await cluster?.stop();
    });

    it('handles task distribution across worker pool with chaos', async () => {
      const coordinatorNodeId = nodeIds[0]!;
      const workerNodeIds = nodeIds.slice(1);
      const tasksPerWorker = 20;
      const totalTasks = workerNodeIds.length * tasksPerWorker;

      // Spawn workers on different nodes
      const workers: Array<{ nodeId: string; processId: string }> = [];
      for (const nodeId of workerNodeIds) {
        const processId = await cluster.spawnProcess(nodeId, 'counterBehavior');
        workers.push({ nodeId, processId });
      }

      expect(workers.length).toBe(workerNodeIds.length);

      // Track metrics
      const latencies: number[] = [];
      let successCount = 0;
      let errorCount = 0;

      // Start chaos in background - crash one worker node after 500ms
      const chaosPromise = (async () => {
        await delay(500);
        const nodeToKill = workerNodeIds[Math.floor(workerNodeIds.length / 2)]!;
        try {
          await cluster.crashNode(nodeToKill, 'process_exit');
        } catch {
          // Node may already be down
        }
      })();

      // Distribute tasks round-robin across workers
      const taskPromises: Promise<void>[] = [];
      for (let i = 0; i < totalTasks; i++) {
        const worker = workers[i % workers.length]!;
        const taskPromise = (async () => {
          const startTime = Date.now();
          try {
            const result = await cluster.remoteCall(
              coordinatorNodeId,
              worker.nodeId,
              worker.processId,
              { type: 'increment' },
              DEFAULT_CALL_TIMEOUT,
            );
            if (!('error' in result)) {
              successCount++;
              latencies.push(result.durationMs);
            } else {
              errorCount++;
            }
          } catch {
            errorCount++;
          }
        })();
        taskPromises.push(taskPromise);

        // Small stagger to simulate realistic load
        if (i % 10 === 0) {
          await delay(10);
        }
      }

      // Wait for chaos and all tasks
      await Promise.all([chaosPromise, ...taskPromises]);

      // Calculate success rate
      const successRate = successCount / totalTasks;
      const stats = calculateStats(latencies);

      console.log('Distributed Worker Pool Results:');
      console.log(`  Total tasks: ${totalTasks}`);
      console.log(`  Successful: ${successCount} (${(successRate * 100).toFixed(1)}%)`);
      console.log(`  Errors: ${errorCount} (includes tasks to crashed node)`);
      console.log(`  Latency: min=${stats.min}ms, avg=${stats.avg.toFixed(1)}ms, p99=${stats.p99}ms`);

      // With chaos, we expect some failures but majority should succeed
      // Workers not on crashed node should handle their tasks
      expect(successRate).toBeGreaterThan(0.5); // At least 50% success with chaos
      expect(stats.p99).toBeLessThan(5000); // P99 latency under 5s
    }, 120_000);

    it('maintains consistency under concurrent writes', async () => {
      const coordinatorNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;
      const concurrentWriters = 10;
      const writesPerWriter = 50;

      // Spawn a stateful process for concurrent access
      const processId = await cluster.spawnProcess(targetNodeId, 'statefulBehavior');

      // Each writer sets unique keys
      const writePromises: Promise<void>[] = [];
      const expectedKeys = new Set<string>();

      for (let writer = 0; writer < concurrentWriters; writer++) {
        for (let i = 0; i < writesPerWriter; i++) {
          const key = `writer-${writer}-key-${i}`;
          expectedKeys.add(key);

          const promise = (async () => {
            try {
              await cluster.remoteCall(
                coordinatorNodeId,
                targetNodeId,
                processId,
                { type: 'set', key, value: { writer, index: i, timestamp: Date.now() } },
                DEFAULT_CALL_TIMEOUT,
              );
            } catch {
              // Some failures expected
            }
          })();
          writePromises.push(promise);
        }
      }

      await Promise.all(writePromises);

      // Verify keys
      const listResult = await cluster.remoteCall<{ keys: string[] }>(
        coordinatorNodeId,
        targetNodeId,
        processId,
        { type: 'list_keys' },
        DEFAULT_CALL_TIMEOUT,
      );

      if ('error' in listResult) {
        throw new Error(`Failed to list keys: ${listResult.message}`);
      }

      const actualKeys = new Set(listResult.result.keys);

      console.log('Concurrent Writes Consistency:');
      console.log(`  Expected keys: ${expectedKeys.size}`);
      console.log(`  Actual keys: ${actualKeys.size}`);
      console.log(`  Success rate: ${((actualKeys.size / expectedKeys.size) * 100).toFixed(1)}%`);

      // With concurrent writes, we should have most keys
      expect(actualKeys.size).toBeGreaterThan(expectedKeys.size * 0.9);
    }, 60_000);
  });

  // ===========================================================================
  // Full Cluster Under Load
  // ===========================================================================

  describe('Full Cluster Under Load', () => {
    let cluster: TestCluster;
    let nodeIds: string[];

    beforeAll(async () => {
      // Create larger cluster for load testing
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 6,
        basePort: getNextBasePort(),
        heartbeatIntervalMs: 400,
        heartbeatMissThreshold: 3,
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Cluster formation timeout')),
          CLUSTER_FORMATION_TIMEOUT,
        );
        cluster.on('fullMesh', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      nodeIds = cluster.getNodeIds() as string[];

      // Register behaviors on all nodes
      for (const nodeId of nodeIds) {
        await cluster.registerBehavior(nodeId, 'counterBehavior');
        await cluster.registerBehavior(nodeId, 'echoBehavior');
      }
    }, 120_000);

    afterAll(async () => {
      await cluster?.stop();
    });

    it('handles sustained load across multiple nodes', async () => {
      const processesPerNode = 10;
      const callsPerProcess = 30;
      const loadDurationMs = 15_000;

      // Spawn processes on each node
      const processes: Array<{ nodeId: string; processId: string }> = [];
      for (const nodeId of nodeIds) {
        for (let i = 0; i < processesPerNode; i++) {
          try {
            const processId = await cluster.spawnProcess(nodeId, 'counterBehavior');
            processes.push({ nodeId, processId });
          } catch {
            // Continue if some spawns fail
          }
        }
      }

      console.log(`Spawned ${processes.length} processes across ${nodeIds.length} nodes`);

      // Track metrics
      const latencies: number[] = [];
      let successCount = 0;
      let errorCount = 0;
      let totalCalls = 0;

      const startTime = Date.now();
      const callPromises: Promise<void>[] = [];

      // Generate sustained load
      while (Date.now() - startTime < loadDurationMs && processes.length > 0) {
        // Pick random source and target
        const sourceIdx = Math.floor(Math.random() * nodeIds.length);
        const targetProcess = processes[Math.floor(Math.random() * processes.length)]!;
        const sourceNodeId = nodeIds[sourceIdx]!;

        const callPromise = (async () => {
          totalCalls++;
          try {
            const result = await cluster.remoteCall(
              sourceNodeId,
              targetProcess.nodeId,
              targetProcess.processId,
              { type: 'increment' },
              5000,
            );
            if (!('error' in result)) {
              successCount++;
              latencies.push(result.durationMs);
            } else {
              errorCount++;
            }
          } catch {
            errorCount++;
          }
        })();

        callPromises.push(callPromise);

        // Control rate - aim for ~100 calls/second
        await delay(10);
      }

      // Wait for all in-flight calls to complete
      await Promise.all(callPromises);

      const duration = Date.now() - startTime;
      const throughput = (successCount / duration) * 1000;
      const successRate = successCount / totalCalls;
      const stats = calculateStats(latencies);

      console.log('Full Cluster Load Results:');
      console.log(`  Duration: ${duration}ms`);
      console.log(`  Total calls: ${totalCalls}`);
      console.log(`  Successful: ${successCount} (${(successRate * 100).toFixed(1)}%)`);
      console.log(`  Errors: ${errorCount}`);
      console.log(`  Throughput: ${throughput.toFixed(1)} calls/sec`);
      console.log(`  Latency: min=${stats.min}ms, avg=${stats.avg.toFixed(1)}ms, p95=${stats.p95}ms, p99=${stats.p99}ms`);

      // Expectations for high load scenario
      // Under sustained concurrent load, some timeouts/failures are expected
      expect(successRate).toBeGreaterThan(0.8);
      expect(stats.p99).toBeLessThan(5000);
    }, 120_000);

    it('survives burst traffic patterns', async () => {
      const burstSize = 50;
      const burstCount = 5;
      const pauseBetweenBursts = 500;

      // Spawn target processes
      const targets: Array<{ nodeId: string; processId: string }> = [];
      for (let i = 0; i < 3; i++) {
        const nodeId = nodeIds[i % nodeIds.length]!;
        const processId = await cluster.spawnProcess(nodeId, 'echoBehavior');
        targets.push({ nodeId, processId });
      }

      const latencies: number[] = [];
      let successCount = 0;
      let errorCount = 0;

      for (let burst = 0; burst < burstCount; burst++) {
        const burstPromises: Promise<void>[] = [];

        // Fire burst of concurrent calls
        for (let i = 0; i < burstSize; i++) {
          const sourceNodeId = nodeIds[Math.floor(Math.random() * nodeIds.length)]!;
          const target = targets[Math.floor(Math.random() * targets.length)]!;

          const promise = (async () => {
            try {
              const result = await cluster.remoteCall(
                sourceNodeId,
                target.nodeId,
                target.processId,
                { type: 'echo', payload: { burst, index: i } },
                5000,
              );
              if (!('error' in result)) {
                successCount++;
                latencies.push(result.durationMs);
              } else {
                errorCount++;
              }
            } catch {
              errorCount++;
            }
          })();
          burstPromises.push(promise);
        }

        // Wait for burst to complete
        await Promise.all(burstPromises);

        // Pause between bursts
        if (burst < burstCount - 1) {
          await delay(pauseBetweenBursts);
        }
      }

      const totalCalls = burstCount * burstSize;
      const successRate = successCount / totalCalls;
      const stats = calculateStats(latencies);

      console.log('Burst Traffic Results:');
      console.log(`  Bursts: ${burstCount} x ${burstSize} = ${totalCalls} calls`);
      console.log(`  Successful: ${successCount} (${(successRate * 100).toFixed(1)}%)`);
      console.log(`  Latency: min=${stats.min}ms, avg=${stats.avg.toFixed(1)}ms, p99=${stats.p99}ms`);

      // Burst traffic causes contention; accept some failures
      expect(successRate).toBeGreaterThan(0.75);
      expect(stats.p99).toBeLessThan(5000);
    }, 60_000);
  });

  // ===========================================================================
  // Rolling Upgrade Simulation
  // ===========================================================================

  describe('Rolling Upgrade Simulation', () => {
    let cluster: TestCluster;
    let nodeIds: string[];

    beforeAll(async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 5,
        basePort: getNextBasePort(),
        heartbeatIntervalMs: 300,
        heartbeatMissThreshold: 3,
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Cluster formation timeout')),
          CLUSTER_FORMATION_TIMEOUT,
        );
        cluster.on('fullMesh', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      nodeIds = cluster.getNodeIds() as string[];

      for (const nodeId of nodeIds) {
        await cluster.registerBehavior(nodeId, 'counterBehavior');
        await cluster.registerBehavior(nodeId, 'echoBehavior');
      }
    }, 90_000);

    afterAll(async () => {
      await cluster?.stop();
    });

    it('maintains availability during rolling restart of non-primary nodes', async () => {
      // Keep first two nodes as stable (coordinator and target)
      const coordinatorNodeId = nodeIds[0]!;
      const stableTargetNodeId = nodeIds[1]!;
      const restartableNodes = nodeIds.slice(2);

      // Spawn processes on stable target node
      const stableProcesses: string[] = [];
      for (let i = 0; i < 3; i++) {
        const processId = await cluster.spawnProcess(stableTargetNodeId, 'counterBehavior');
        stableProcesses.push(processId);
      }

      // Track continuous traffic metrics
      const latencies: number[] = [];
      let successCount = 0;
      let errorCount = 0;
      let isRunning = true;

      // Background traffic generator - calls from coordinator to stable target
      const trafficPromise = (async () => {
        while (isRunning) {
          const process = stableProcesses[Math.floor(Math.random() * stableProcesses.length)]!;
          try {
            const result = await cluster.remoteCall(
              coordinatorNodeId,
              stableTargetNodeId,
              process,
              { type: 'get' },
              3000,
            );
            if (!('error' in result)) {
              successCount++;
              latencies.push(result.durationMs);
            } else {
              errorCount++;
            }
          } catch {
            errorCount++;
          }
          await delay(50);
        }
      })();

      // Simulate rolling restart of non-stable nodes
      for (const nodeId of restartableNodes) {
        console.log(`Restarting node: ${nodeId}`);

        // Graceful stop
        try {
          await cluster.crashNode(nodeId, 'graceful_shutdown');
        } catch {
          // May already be stopping
        }

        // Wait for cluster to detect node down
        await delay(1500);

        // In a real scenario, we would restart the node here
        // For this test, we just verify the cluster continues to function

        // Brief pause between restarts
        await delay(500);
      }

      // Let traffic continue briefly after restarts
      await delay(2000);
      isRunning = false;

      // Wait for traffic generator to complete
      await trafficPromise;

      const totalCalls = successCount + errorCount;
      const successRate = totalCalls > 0 ? successCount / totalCalls : 0;
      const stats = calculateStats(latencies);

      console.log('Rolling Restart Results (cross-node calls to stable target):');
      console.log(`  Total calls: ${totalCalls}`);
      console.log(`  Successful: ${successCount} (${(successRate * 100).toFixed(1)}%)`);
      console.log(`  Errors: ${errorCount}`);
      console.log(`  Latency: avg=${stats.avg.toFixed(1)}ms, p99=${stats.p99}ms`);

      // Cross-node calls between stable nodes should have high success rate
      // Some failures expected during cluster reconfiguration
      expect(successRate).toBeGreaterThan(0.8);
    }, 120_000);

    it('detects and reports node departures during rolling restart', async () => {
      // Create a fresh cluster for this test to avoid interference
      const freshCluster = await TestClusterFactory.createCluster({
        nodeCount: 4,
        basePort: getNextBasePort(),
        heartbeatIntervalMs: 250,
        heartbeatMissThreshold: 2,
      });

      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Cluster formation timeout')),
            CLUSTER_FORMATION_TIMEOUT,
          );
          freshCluster.on('fullMesh', () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        const freshNodeIds = freshCluster.getNodeIds() as string[];
        const coordinatorNodeId = freshNodeIds[0]!;
        const restartableNodeId = freshNodeIds[1]!;

        // Track node down events
        const nodeDownEvents: Array<{ nodeId: string; reason: string }> = [];
        freshCluster.on('nodeDown', (nodeId, reason) => {
          nodeDownEvents.push({ nodeId, reason });
        });

        // Crash the restartable node
        await freshCluster.crashNode(restartableNodeId, 'process_exit');

        // Wait for detection
        const detected = await waitFor(
          () => nodeDownEvents.some((e) => e.nodeId === restartableNodeId),
          5000,
        );

        console.log('Node Departure Detection:');
        console.log(`  Crashed node: ${restartableNodeId}`);
        console.log(`  Detected: ${detected}`);
        console.log(`  Events: ${nodeDownEvents.length}`);

        expect(detected).toBe(true);

        // Verify remaining nodes are still connected
        const remainingNodes = freshCluster.getNodes().filter((n) => n.status === 'running');
        expect(remainingNodes.length).toBe(freshNodeIds.length - 1);
      } finally {
        await freshCluster.stop();
      }
    }, 60_000);
  });

  // ===========================================================================
  // Cross-Component Integration
  // ===========================================================================

  describe('Cross-Component Integration', () => {
    let cluster: TestCluster;
    let nodeIds: string[];

    beforeAll(async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 4,
        basePort: getNextBasePort(),
        heartbeatIntervalMs: 300,
        heartbeatMissThreshold: 3,
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Cluster formation timeout')),
          CLUSTER_FORMATION_TIMEOUT,
        );
        cluster.on('fullMesh', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      nodeIds = cluster.getNodeIds() as string[];

      for (const nodeId of nodeIds) {
        await cluster.registerBehavior(nodeId, 'counterBehavior');
        await cluster.registerBehavior(nodeId, 'echoBehavior');
        await cluster.registerBehavior(nodeId, 'statefulBehavior');
      }
    }, 90_000);

    afterAll(async () => {
      await cluster?.stop();
    });

    it('combines remote spawn, call, and global registry operations', async () => {
      const coordinatorNodeId = nodeIds[0]!;
      const targetNodeId = nodeIds[1]!;
      const operationCount = 20;

      const results = {
        spawns: { success: 0, error: 0 },
        calls: { success: 0, error: 0 },
        registrations: { success: 0, error: 0 },
        lookups: { success: 0, error: 0 },
      };

      // Perform interleaved operations
      for (let i = 0; i < operationCount; i++) {
        // Remote spawn
        const spawnResult = await cluster.remoteSpawn(
          coordinatorNodeId,
          targetNodeId,
          'counterBehavior',
          { name: `integrated-worker-${i}`, registration: 'global' },
          10_000,
        );

        if ('error' in spawnResult) {
          results.spawns.error++;
          continue;
        }
        results.spawns.success++;

        // Remote call to spawned process
        const callResult = await cluster.remoteCall(
          coordinatorNodeId,
          targetNodeId,
          spawnResult.serverId,
          { type: 'increment', by: i },
          5000,
        );

        if ('error' in callResult) {
          results.calls.error++;
        } else {
          results.calls.success++;
        }

        // Lookup via global registry from different node
        const lookupNodeId = nodeIds[2]!;
        const lookupResult = await cluster.globalWhereis(
          lookupNodeId,
          `integrated-worker-${i}`,
          5000,
        );

        if (lookupResult.ref !== null) {
          results.lookups.success++;
        } else {
          results.lookups.error++;
        }
      }

      console.log('Cross-Component Integration Results:');
      console.log(`  Spawns: ${results.spawns.success}/${operationCount} successful`);
      console.log(`  Calls: ${results.calls.success}/${results.spawns.success} successful`);
      console.log(`  Lookups: ${results.lookups.success}/${results.spawns.success} successful`);

      // Expect high success rates for integrated operations
      expect(results.spawns.success).toBeGreaterThan(operationCount * 0.8);
      expect(results.calls.success).toBeGreaterThan(results.spawns.success * 0.9);
      expect(results.lookups.success).toBeGreaterThan(results.spawns.success * 0.8);
    }, 120_000);

    it('handles concurrent operations from multiple nodes', async () => {
      const targetNodeId = nodeIds[0]!;
      const callerNodes = nodeIds.slice(1);
      const operationsPerNode = 30;

      // Spawn a shared target process
      const targetProcessId = await cluster.spawnProcess(targetNodeId, 'counterBehavior');

      const latencies: number[] = [];
      let successCount = 0;
      let errorCount = 0;

      // Each node sends concurrent operations
      const nodePromises = callerNodes.map(async (callerNodeId) => {
        const ops: Promise<void>[] = [];
        for (let i = 0; i < operationsPerNode; i++) {
          const op = (async () => {
            try {
              const result = await cluster.remoteCall(
                callerNodeId,
                targetNodeId,
                targetProcessId,
                { type: 'increment' },
                5000,
              );
              if (!('error' in result)) {
                successCount++;
                latencies.push(result.durationMs);
              } else {
                errorCount++;
              }
            } catch {
              errorCount++;
            }
          })();
          ops.push(op);
        }
        await Promise.all(ops);
      });

      await Promise.all(nodePromises);

      // Verify final counter value
      const finalResult = await cluster.remoteCall<{ value: number }>(
        callerNodes[0]!,
        targetNodeId,
        targetProcessId,
        { type: 'get' },
        5000,
      );

      const totalOperations = callerNodes.length * operationsPerNode;
      const successRate = successCount / totalOperations;
      const stats = calculateStats(latencies);

      console.log('Concurrent Multi-Node Operations:');
      console.log(`  Nodes: ${callerNodes.length}`);
      console.log(`  Operations per node: ${operationsPerNode}`);
      console.log(`  Total: ${totalOperations}`);
      console.log(`  Successful: ${successCount} (${(successRate * 100).toFixed(1)}%)`);
      console.log(`  Latency: avg=${stats.avg.toFixed(1)}ms, p99=${stats.p99}ms`);
      if (!('error' in finalResult)) {
        console.log(`  Final counter value: ${finalResult.result.value}`);
      }

      expect(successRate).toBeGreaterThan(0.9);

      // Final counter should reflect successful increments
      if (!('error' in finalResult)) {
        expect(finalResult.result.value).toBe(successCount);
      }
    }, 60_000);
  });
});
