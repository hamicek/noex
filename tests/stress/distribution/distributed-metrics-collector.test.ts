/**
 * Tests for distributed-metrics-collector.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DistributedMetricsCollector,
  DistributedMetricsAssertions,
  createDistributedMetricsCollector,
  type DistributedStressMetrics,
} from './distributed-metrics-collector.js';

describe('DistributedMetricsCollector', () => {
  let collector: DistributedMetricsCollector;

  beforeEach(() => {
    collector = new DistributedMetricsCollector({
      memorySnapshotIntervalMs: 0, // Disable automatic snapshots for tests
    });
  });

  afterEach(() => {
    collector.stop();
  });

  describe('lifecycle', () => {
    it('starts and stops correctly', async () => {
      collector.start();
      const metrics = collector.getDistributedMetrics();
      expect(metrics.startTime).toBeGreaterThan(0);

      // Small delay to ensure endTime > startTime
      await new Promise((r) => setTimeout(r, 5));

      collector.stop();
      const finalMetrics = collector.getDistributedMetrics();
      expect(finalMetrics.endTime).toBeGreaterThanOrEqual(finalMetrics.startTime);
      expect(finalMetrics.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('prevents multiple starts', () => {
      collector.start();
      const firstStartTime = collector.getDistributedMetrics().startTime;

      collector.start(); // Should be ignored
      const secondStartTime = collector.getDistributedMetrics().startTime;

      expect(firstStartTime).toBe(secondStartTime);
    });

    it('resets all metrics', () => {
      collector.start();

      // Record some metrics
      collector.recordNodeUp('node1');
      collector.recordMessageSent();
      const callId = collector.recordRemoteCallStart('node1');
      collector.recordRemoteCallComplete(callId);

      collector.reset();

      const metrics = collector.getDistributedMetrics();
      expect(metrics.cluster.nodeUpEvents).toBe(0);
      expect(metrics.transport.messagesSent).toBe(0);
      expect(metrics.remoteCall.totalCalls).toBe(0);
    });
  });

  describe('cluster metrics', () => {
    beforeEach(() => {
      collector.start();
    });

    it('tracks node_up events', () => {
      collector.recordNodeUp('node1@127.0.0.1:4000');
      collector.recordNodeUp('node2@127.0.0.1:4001');

      const metrics = collector.getDistributedMetrics();
      expect(metrics.cluster.nodeUpEvents).toBe(2);
    });

    it('tracks node_down events', () => {
      collector.recordNodeDown('node1@127.0.0.1:4000', 'disconnect');
      collector.recordNodeDown('node2@127.0.0.1:4001', 'timeout');

      const metrics = collector.getDistributedMetrics();
      expect(metrics.cluster.nodeDownEvents).toBe(2);
    });

    it('tracks reconnections', async () => {
      // Node goes down
      collector.recordNodeDown('node1@127.0.0.1:4000', 'disconnect');

      // Wait a bit
      await new Promise((r) => setTimeout(r, 50));

      // Node comes back up
      collector.recordNodeUp('node1@127.0.0.1:4000');

      const metrics = collector.getDistributedMetrics();
      expect(metrics.cluster.reconnections).toBe(1);
      expect(metrics.cluster.avgReconnectionTimeMs).toBeGreaterThan(0);
    });

    it('calculates reconnection statistics correctly', async () => {
      // Simulate multiple reconnections with different times
      collector.recordNodeDown('node1', 'test');
      await new Promise((r) => setTimeout(r, 20));
      collector.recordNodeUp('node1');

      collector.recordNodeDown('node2', 'test');
      await new Promise((r) => setTimeout(r, 40));
      collector.recordNodeUp('node2');

      collector.recordNodeDown('node3', 'test');
      await new Promise((r) => setTimeout(r, 30));
      collector.recordNodeUp('node3');

      const metrics = collector.getDistributedMetrics();
      expect(metrics.cluster.reconnections).toBe(3);
      expect(metrics.cluster.reconnectionTimes).toHaveLength(3);
      expect(metrics.cluster.minReconnectionTimeMs).toBeGreaterThan(0);
      expect(metrics.cluster.maxReconnectionTimeMs).toBeGreaterThanOrEqual(
        metrics.cluster.minReconnectionTimeMs
      );
    });
  });

  describe('transport metrics', () => {
    beforeEach(() => {
      collector.start();
    });

    it('tracks messages sent', () => {
      collector.recordMessageSent('node1');
      collector.recordMessageSent('node2');
      collector.recordMessageSent('node1');

      const metrics = collector.getDistributedMetrics();
      expect(metrics.transport.messagesSent).toBe(3);
    });

    it('tracks messages received with latency', () => {
      collector.recordMessageReceived(10, 'node1');
      collector.recordMessageReceived(20, 'node2');
      collector.recordMessageReceived(15, 'node1');

      const metrics = collector.getDistributedMetrics();
      expect(metrics.transport.messagesReceived).toBe(3);
      expect(metrics.transport.avgLatencyMs).toBe(15);
      expect(metrics.transport.minLatencyMs).toBe(10);
      expect(metrics.transport.maxLatencyMs).toBe(20);
    });

    it('tracks dropped messages', () => {
      collector.recordMessageDropped('node1', 'connection lost');
      collector.recordMessageDropped('node2');

      const metrics = collector.getDistributedMetrics();
      expect(metrics.transport.messagesDropped).toBe(2);
    });

    it('calculates delivery rate correctly', () => {
      collector.recordMessageSent();
      collector.recordMessageSent();
      collector.recordMessageSent();
      collector.recordMessageSent();
      collector.recordMessageReceived(10);
      collector.recordMessageReceived(10);
      collector.recordMessageReceived(10);
      collector.recordMessageDropped();

      const metrics = collector.getDistributedMetrics();
      expect(metrics.transport.deliveryRate).toBe(0.75); // 3/4
    });

    it('handles batch recording', () => {
      collector.recordTransportBatch(100, 95, 5, [10, 20, 30, 40, 50]);

      const metrics = collector.getDistributedMetrics();
      expect(metrics.transport.messagesSent).toBe(100);
      expect(metrics.transport.messagesReceived).toBe(95);
      expect(metrics.transport.messagesDropped).toBe(5);
      expect(metrics.transport.latencies).toHaveLength(5);
    });

    it('calculates percentiles correctly', () => {
      // Record 100 latencies from 1 to 100
      for (let i = 1; i <= 100; i++) {
        collector.recordMessageReceived(i);
      }

      const metrics = collector.getDistributedMetrics();
      expect(metrics.transport.p95LatencyMs).toBe(95);
      expect(metrics.transport.p99LatencyMs).toBe(99);
    });
  });

  describe('remote call metrics', () => {
    beforeEach(() => {
      collector.start();
    });

    it('tracks remote call lifecycle', () => {
      const callId = collector.recordRemoteCallStart('node1');
      expect(callId).toMatch(/^call_/);

      collector.recordRemoteCallComplete(callId);

      const metrics = collector.getDistributedMetrics();
      expect(metrics.remoteCall.totalCalls).toBe(1);
      expect(metrics.remoteCall.successfulCalls).toBe(1);
      expect(metrics.remoteCall.successRate).toBe(1);
    });

    it('tracks timeouts', async () => {
      const callId = collector.recordRemoteCallStart('node1');

      await new Promise((r) => setTimeout(r, 20));

      collector.recordRemoteCallTimeout(callId);

      const metrics = collector.getDistributedMetrics();
      expect(metrics.remoteCall.totalCalls).toBe(1);
      expect(metrics.remoteCall.timeoutCalls).toBe(1);
      expect(metrics.remoteCall.successRate).toBe(0);
    });

    it('tracks failed calls', () => {
      const callId = collector.recordRemoteCallStart('node1');
      collector.recordRemoteCallFailed(callId, 'Connection refused');

      const metrics = collector.getDistributedMetrics();
      expect(metrics.remoteCall.failedCalls).toBe(1);
      expect(metrics.remoteCall.successRate).toBe(0);
    });

    it('tracks pending queue peak', () => {
      // Start multiple calls without completing them
      const ids = [
        collector.recordRemoteCallStart('node1'),
        collector.recordRemoteCallStart('node2'),
        collector.recordRemoteCallStart('node3'),
      ];

      const peakBefore = collector.getDistributedMetrics().remoteCall.pendingQueuePeak;

      // Complete one
      collector.recordRemoteCallComplete(ids[0]!);

      // Start two more
      collector.recordRemoteCallStart('node1');
      collector.recordRemoteCallStart('node2');

      const metrics = collector.getDistributedMetrics();
      expect(metrics.remoteCall.pendingQueuePeak).toBeGreaterThanOrEqual(peakBefore);
    });

    it('calculates call duration statistics', async () => {
      const call1 = collector.recordRemoteCallStart('node1');
      await new Promise((r) => setTimeout(r, 10));
      collector.recordRemoteCallComplete(call1);

      const call2 = collector.recordRemoteCallStart('node2');
      await new Promise((r) => setTimeout(r, 20));
      collector.recordRemoteCallComplete(call2);

      const metrics = collector.getDistributedMetrics();
      expect(metrics.remoteCall.callDurations).toHaveLength(2);
      expect(metrics.remoteCall.avgCallDurationMs).toBeGreaterThan(0);
    });
  });

  describe('remote spawn metrics', () => {
    beforeEach(() => {
      collector.start();
    });

    it('tracks spawn lifecycle', async () => {
      const spawnId = collector.recordRemoteSpawnStart('node1');
      expect(spawnId).toMatch(/^spawn_/);

      await new Promise((r) => setTimeout(r, 10));
      collector.recordRemoteSpawnComplete(spawnId, 'process_123');

      const metrics = collector.getDistributedMetrics();
      expect(metrics.remoteSpawn.totalSpawns).toBe(1);
      expect(metrics.remoteSpawn.successfulSpawns).toBe(1);
      expect(metrics.remoteSpawn.avgSpawnTimeMs).toBeGreaterThan(0);
    });

    it('tracks failed spawns', () => {
      const spawnId = collector.recordRemoteSpawnStart('node1');
      collector.recordRemoteSpawnFailed(spawnId, 'Init failed');

      const metrics = collector.getDistributedMetrics();
      expect(metrics.remoteSpawn.failedSpawns).toBe(1);
      expect(metrics.remoteSpawn.successRate).toBe(0);
    });

    it('calculates spawn time statistics', async () => {
      for (let i = 0; i < 5; i++) {
        const id = collector.recordRemoteSpawnStart(`node${i}`);
        await new Promise((r) => setTimeout(r, 5 + i * 5));
        collector.recordRemoteSpawnComplete(id);
      }

      const metrics = collector.getDistributedMetrics();
      expect(metrics.remoteSpawn.spawnTimes).toHaveLength(5);
      expect(metrics.remoteSpawn.minSpawnTimeMs).toBeGreaterThan(0);
      expect(metrics.remoteSpawn.maxSpawnTimeMs).toBeGreaterThan(
        metrics.remoteSpawn.minSpawnTimeMs
      );
    });
  });

  describe('registry metrics', () => {
    beforeEach(() => {
      collector.start();
    });

    it('tracks registrations', () => {
      collector.recordRegistration('service1', true, 'node1');
      collector.recordRegistration('service2', true, 'node2');
      collector.recordRegistration('service3', false, 'node1');

      const metrics = collector.getDistributedMetrics();
      expect(metrics.registry.totalRegistrations).toBe(3);
      expect(metrics.registry.successfulRegistrations).toBe(2);
      expect(metrics.registry.successRate).toBeCloseTo(0.667, 2);
    });

    it('tracks conflicts', () => {
      collector.recordRegistryConflict('service1', 'node1', 'node2');
      collector.recordRegistryConflict('service2', 'node2', 'node3');

      const metrics = collector.getDistributedMetrics();
      expect(metrics.registry.conflictsResolved).toBe(2);
    });

    it('tracks sync operations', () => {
      collector.recordRegistrySync(50, 'node1');
      collector.recordRegistrySync(30, 'node2');
      collector.recordRegistrySync(40, 'node3');

      const metrics = collector.getDistributedMetrics();
      expect(metrics.registry.syncOperations).toBe(3);
      expect(metrics.registry.avgSyncDurationMs).toBe(40);
    });
  });

  describe('supervisor metrics', () => {
    beforeEach(() => {
      collector.start();
    });

    it('tracks migrations', () => {
      collector.recordMigration('child1', 'node1', 'node2', 100);
      collector.recordMigration('child2', 'node2', 'node3', 150);

      const metrics = collector.getDistributedMetrics();
      expect(metrics.supervisor.migrations).toBe(2);
      expect(metrics.supervisor.avgMigrationTimeMs).toBe(125);
    });

    it('tracks failovers', () => {
      collector.recordFailover('sup1', 'node1', 200);
      collector.recordFailover('sup2', 'node2', 300);

      const metrics = collector.getDistributedMetrics();
      expect(metrics.supervisor.failovers).toBe(2);
      expect(metrics.supervisor.avgFailoverTimeMs).toBe(250);
    });

    it('tracks restarts by node', () => {
      collector.recordSupervisorRestart('node1', 'child1');
      collector.recordSupervisorRestart('node1', 'child2');
      collector.recordSupervisorRestart('node2', 'child3');
      collector.recordSupervisorRestart('node1', 'child4');

      const metrics = collector.getDistributedMetrics();
      expect(metrics.supervisor.restartsByNode['node1']).toBe(3);
      expect(metrics.supervisor.restartsByNode['node2']).toBe(1);
      expect(metrics.supervisor.totalRestarts).toBe(4);
    });
  });

  describe('memory tracking', () => {
    it('takes manual memory snapshots', () => {
      collector.start();

      collector.takeMemorySnapshot();
      collector.takeMemorySnapshot();
      collector.takeMemorySnapshot();

      const metrics = collector.getDistributedMetrics();
      // At least start + 3 manual (stop might add one more)
      expect(metrics.memory.snapshots.length).toBeGreaterThanOrEqual(3);
    });

    it('calculates memory growth', () => {
      collector.start();

      // Force some memory allocation
      const _buffer = new Array(10000).fill('x');

      collector.takeMemorySnapshot();
      collector.stop();

      const metrics = collector.getDistributedMetrics();
      expect(metrics.memory.initial.heapUsed).toBeGreaterThan(0);
      expect(metrics.memory.final.heapUsed).toBeGreaterThan(0);
    });
  });

  describe('custom metrics', () => {
    beforeEach(() => {
      collector.start();
    });

    it('stores custom metrics', () => {
      collector.setCustomMetric('testKey', 'testValue');
      collector.setCustomMetric('numberKey', 42);
      collector.setCustomMetric('objectKey', { nested: true });

      const metrics = collector.getDistributedMetrics();
      expect(metrics.custom['testKey']).toBe('testValue');
      expect(metrics.custom['numberKey']).toBe(42);
      expect(metrics.custom['objectKey']).toEqual({ nested: true });
    });

    it('records custom timeline events', () => {
      collector.addCustomEvent('test_event', { foo: 'bar' });
      collector.addCustomEvent('another_event');

      const metrics = collector.getDistributedMetrics();
      const customEvents = metrics.distributedTimeline.filter((e) => e.type === 'custom');
      expect(customEvents).toHaveLength(2);
      expect(customEvents[0]?.data?.['name']).toBe('test_event');
    });
  });

  describe('timeline', () => {
    beforeEach(() => {
      collector.start();
    });

    it('records events in chronological order', async () => {
      collector.recordNodeUp('node1');
      await new Promise((r) => setTimeout(r, 10));
      collector.recordMessageSent();
      await new Promise((r) => setTimeout(r, 10));
      collector.recordNodeDown('node2', 'test');

      const metrics = collector.getDistributedMetrics();
      const timeline = metrics.distributedTimeline;

      expect(timeline.length).toBeGreaterThanOrEqual(3);

      // Verify chronological order
      for (let i = 1; i < timeline.length; i++) {
        expect(timeline[i]!.timestamp).toBeGreaterThanOrEqual(timeline[i - 1]!.timestamp);
      }
    });

    it('includes elapsed time in events', async () => {
      await new Promise((r) => setTimeout(r, 50));
      collector.recordMessageSent();

      const metrics = collector.getDistributedMetrics();
      const messageEvent = metrics.distributedTimeline.find((e) => e.type === 'message_sent');

      expect(messageEvent).toBeDefined();
      expect(messageEvent!.elapsedMs).toBeGreaterThanOrEqual(50);
    });
  });

  describe('getSummary', () => {
    it('returns formatted summary string', () => {
      collector.start();

      collector.recordNodeUp('node1');
      collector.recordMessageSent();
      collector.recordMessageReceived(10);
      const callId = collector.recordRemoteCallStart('node1');
      collector.recordRemoteCallComplete(callId);

      collector.stop();

      const summary = collector.getSummary();

      expect(summary).toContain('Distributed Stress Test Metrics');
      expect(summary).toContain('Duration:');
      expect(summary).toContain('Cluster:');
      expect(summary).toContain('Transport:');
      expect(summary).toContain('Remote Calls:');
      expect(summary).toContain('Memory:');
    });
  });
});

describe('DistributedMetricsAssertions', () => {
  function createMetrics(overrides: Partial<DistributedStressMetrics> = {}): DistributedStressMetrics {
    const baseMetrics: DistributedStressMetrics = {
      startTime: Date.now() - 1000,
      endTime: Date.now(),
      durationMs: 1000,
      restarts: {
        totalRestarts: 0,
        successfulRestarts: 0,
        failedRestarts: 0,
        successRate: 1,
        avgRestartTimeMs: 0,
        minRestartTimeMs: 0,
        maxRestartTimeMs: 0,
        p50RestartTimeMs: 0,
        p95RestartTimeMs: 0,
        p99RestartTimeMs: 0,
        restartTimes: [],
      },
      messages: {
        messagesSent: 100,
        messagesProcessed: 100,
        messagesFailed: 0,
        throughputPerSec: 100,
        avgLatencyMs: 10,
        minLatencyMs: 5,
        maxLatencyMs: 50,
        p95LatencyMs: 40,
        p99LatencyMs: 45,
      },
      memory: {
        initial: { timestamp: 0, elapsedMs: 0, heapUsed: 1000, heapTotal: 2000, external: 0, rss: 3000 },
        final: { timestamp: 1000, elapsedMs: 1000, heapUsed: 1100, heapTotal: 2000, external: 0, rss: 3000 },
        peakHeapUsed: 1200,
        heapGrowthBytes: 100,
        heapGrowthPercent: 10,
        snapshots: [],
      },
      timeline: [],
      custom: {},
      cluster: {
        nodeUpEvents: 3,
        nodeDownEvents: 1,
        reconnections: 1,
        avgReconnectionTimeMs: 100,
        minReconnectionTimeMs: 100,
        maxReconnectionTimeMs: 100,
        p95ReconnectionTimeMs: 100,
        reconnectionTimes: [100],
      },
      transport: {
        messagesSent: 100,
        messagesReceived: 99,
        messagesDropped: 1,
        deliveryRate: 0.99,
        avgLatencyMs: 10,
        minLatencyMs: 5,
        maxLatencyMs: 50,
        p95LatencyMs: 40,
        p99LatencyMs: 45,
        latencies: [],
      },
      remoteCall: {
        totalCalls: 100,
        successfulCalls: 98,
        timeoutCalls: 1,
        failedCalls: 1,
        successRate: 0.98,
        pendingQueuePeak: 10,
        avgCallDurationMs: 20,
        p95CallDurationMs: 50,
        p99CallDurationMs: 80,
        callDurations: [],
      },
      remoteSpawn: {
        totalSpawns: 50,
        successfulSpawns: 49,
        failedSpawns: 1,
        successRate: 0.98,
        avgSpawnTimeMs: 30,
        minSpawnTimeMs: 10,
        maxSpawnTimeMs: 100,
        p95SpawnTimeMs: 80,
        spawnTimes: [],
      },
      registry: {
        totalRegistrations: 20,
        successfulRegistrations: 20,
        conflictsResolved: 2,
        syncOperations: 5,
        avgSyncDurationMs: 50,
        successRate: 1,
      },
      supervisor: {
        migrations: 3,
        failovers: 1,
        restartsByNode: { 'node1': 2, 'node2': 1 },
        totalRestarts: 3,
        avgMigrationTimeMs: 100,
        avgFailoverTimeMs: 200,
      },
      distributedTimeline: [],
    };

    return { ...baseMetrics, ...overrides };
  }

  describe('assertDeliveryRate', () => {
    it('passes when delivery rate meets threshold', () => {
      const metrics = createMetrics({ transport: { ...createMetrics().transport, deliveryRate: 0.99 } });
      expect(() => DistributedMetricsAssertions.assertDeliveryRate(metrics, 0.95)).not.toThrow();
    });

    it('fails when delivery rate below threshold', () => {
      const metrics = createMetrics({ transport: { ...createMetrics().transport, deliveryRate: 0.90 } });
      expect(() => DistributedMetricsAssertions.assertDeliveryRate(metrics, 0.95)).toThrow(/Delivery rate/);
    });
  });

  describe('assertRemoteCallSuccessRate', () => {
    it('passes when success rate meets threshold', () => {
      const metrics = createMetrics({ remoteCall: { ...createMetrics().remoteCall, successRate: 0.99 } });
      expect(() => DistributedMetricsAssertions.assertRemoteCallSuccessRate(metrics, 0.95)).not.toThrow();
    });

    it('fails when success rate below threshold', () => {
      const metrics = createMetrics({ remoteCall: { ...createMetrics().remoteCall, successRate: 0.90 } });
      expect(() => DistributedMetricsAssertions.assertRemoteCallSuccessRate(metrics, 0.95)).toThrow(/Remote call success rate/);
    });
  });

  describe('assertRemoteSpawnSuccessRate', () => {
    it('passes when success rate meets threshold', () => {
      const metrics = createMetrics({ remoteSpawn: { ...createMetrics().remoteSpawn, successRate: 0.99 } });
      expect(() => DistributedMetricsAssertions.assertRemoteSpawnSuccessRate(metrics, 0.95)).not.toThrow();
    });

    it('fails when success rate below threshold', () => {
      const metrics = createMetrics({ remoteSpawn: { ...createMetrics().remoteSpawn, successRate: 0.90 } });
      expect(() => DistributedMetricsAssertions.assertRemoteSpawnSuccessRate(metrics, 0.95)).toThrow(/Remote spawn success rate/);
    });
  });

  describe('assertLatencyP99Below', () => {
    it('passes when P99 latency below threshold', () => {
      const metrics = createMetrics({ transport: { ...createMetrics().transport, p99LatencyMs: 45 } });
      expect(() => DistributedMetricsAssertions.assertLatencyP99Below(metrics, 100)).not.toThrow();
    });

    it('fails when P99 latency exceeds threshold', () => {
      const metrics = createMetrics({ transport: { ...createMetrics().transport, p99LatencyMs: 150 } });
      expect(() => DistributedMetricsAssertions.assertLatencyP99Below(metrics, 100)).toThrow(/P99 latency/);
    });
  });

  describe('assertReconnectionTimeBelow', () => {
    it('passes when reconnection time below threshold', () => {
      const metrics = createMetrics({ cluster: { ...createMetrics().cluster, avgReconnectionTimeMs: 500 } });
      expect(() => DistributedMetricsAssertions.assertReconnectionTimeBelow(metrics, 1000)).not.toThrow();
    });

    it('fails when reconnection time exceeds threshold', () => {
      const metrics = createMetrics({ cluster: { ...createMetrics().cluster, avgReconnectionTimeMs: 1500 } });
      expect(() => DistributedMetricsAssertions.assertReconnectionTimeBelow(metrics, 1000)).toThrow(/reconnection time/);
    });
  });

  describe('assertMemoryGrowthBelow', () => {
    it('passes when memory growth below threshold', () => {
      const metrics = createMetrics({ memory: { ...createMetrics().memory, heapGrowthPercent: 30 } });
      expect(() => DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 50)).not.toThrow();
    });

    it('fails when memory growth exceeds threshold', () => {
      const metrics = createMetrics({ memory: { ...createMetrics().memory, heapGrowthPercent: 60 } });
      expect(() => DistributedMetricsAssertions.assertMemoryGrowthBelow(metrics, 50)).toThrow(/Memory growth/);
    });
  });

  describe('assertNoMessageDrops', () => {
    it('passes when no drops', () => {
      const metrics = createMetrics({ transport: { ...createMetrics().transport, messagesDropped: 0 } });
      expect(() => DistributedMetricsAssertions.assertNoMessageDrops(metrics)).not.toThrow();
    });

    it('fails when drops occurred', () => {
      const metrics = createMetrics({ transport: { ...createMetrics().transport, messagesDropped: 5 } });
      expect(() => DistributedMetricsAssertions.assertNoMessageDrops(metrics)).toThrow(/5 messages were dropped/);
    });
  });

  describe('assertNoCallTimeouts', () => {
    it('passes when no timeouts', () => {
      const metrics = createMetrics({ remoteCall: { ...createMetrics().remoteCall, timeoutCalls: 0 } });
      expect(() => DistributedMetricsAssertions.assertNoCallTimeouts(metrics)).not.toThrow();
    });

    it('fails when timeouts occurred', () => {
      const metrics = createMetrics({ remoteCall: { ...createMetrics().remoteCall, timeoutCalls: 3 } });
      expect(() => DistributedMetricsAssertions.assertNoCallTimeouts(metrics)).toThrow(/3 remote calls timed out/);
    });
  });
});

describe('createDistributedMetricsCollector', () => {
  it('creates a new collector instance', () => {
    const collector = createDistributedMetricsCollector();
    expect(collector).toBeInstanceOf(DistributedMetricsCollector);
  });

  it('accepts configuration', () => {
    const collector = createDistributedMetricsCollector({
      memorySnapshotIntervalMs: 500,
    });

    expect(collector).toBeInstanceOf(DistributedMetricsCollector);
  });
});
