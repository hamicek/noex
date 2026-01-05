/**
 * Tests for stress test utilities.
 *
 * Verifies that test helpers, crash simulators, and metrics collectors
 * work correctly before using them in actual stress tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Supervisor,
  GenServer,
  type GenServerRef,
} from '../../src/index.js';

import {
  waitFor,
  waitForChildRestarted,
  waitForAllRestarted,
  createTestSupervisor,
  createTestBehavior,
  generateLoad,
  captureChildState,
  compareChildStates,
  delay,
  cleanupTest,
  resetTestState,
  type TestSupervisorResult,
} from './test-helpers.js';

import {
  crashChild,
  crashChildById,
  crashMultiple,
  crashMultipleByIds,
  crashRandom,
  scheduleCrashes,
  crashBurst,
  crashAll,
  crashSequential,
} from './crash-simulator.js';

import {
  MetricsCollector,
  SimpleRestartTracker,
  MetricsAssertions,
} from './metrics-collector.js';

describe('Stress Test Utilities', () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(async () => {
    await Supervisor._clearAll();
    Supervisor._clearLifecycleHandlers();
    GenServer._clearLifecycleHandlers();
  });

  describe('test-helpers', () => {
    describe('waitFor', () => {
      it('resolves when condition becomes true', async () => {
        let value = false;
        setTimeout(() => { value = true; }, 50);

        const result = await waitFor(() => value);

        expect(result.success).toBe(true);
        expect(result.elapsedMs).toBeGreaterThanOrEqual(40);
        expect(result.elapsedMs).toBeLessThan(200);
      });

      it('throws on timeout', async () => {
        await expect(
          waitFor(() => false, { timeoutMs: 50, message: 'Test timeout' }),
        ).rejects.toThrow('Test timeout');
      });

      it('supports async conditions', async () => {
        let value = false;
        setTimeout(() => { value = true; }, 50);

        const result = await waitFor(async () => {
          await delay(5);
          return value;
        });

        expect(result.success).toBe(true);
      });
    });

    describe('createTestSupervisor', () => {
      it('creates supervisor with specified number of children', async () => {
        const { ref, childRefs, childIds } = await createTestSupervisor({
          childCount: 5,
        });

        expect(Supervisor.countChildren(ref)).toBe(5);
        expect(childRefs.size).toBe(5);
        expect(childIds.length).toBe(5);

        await cleanupTest(ref);
      });

      it('uses custom strategy', async () => {
        const { ref } = await createTestSupervisor({
          childCount: 3,
          strategy: 'one_for_all',
        });

        const stats = Supervisor._getStats(ref);
        expect(stats?.strategy).toBe('one_for_all');

        await cleanupTest(ref);
      });

      it('uses custom child ID prefix', async () => {
        const { childIds } = await createTestSupervisor({
          childCount: 3,
          childIdPrefix: 'worker',
        });

        expect(childIds[0]).toBe('worker_0');
        expect(childIds[1]).toBe('worker_1');
        expect(childIds[2]).toBe('worker_2');
      });

      it('creates functional children', async () => {
        const { ref, childRefs } = await createTestSupervisor({
          childCount: 2,
        });

        const firstChild = Array.from(childRefs.values())[0]!;

        // Test that child can receive messages
        GenServer.cast(firstChild, { type: 'inc' });
        GenServer.cast(firstChild, { type: 'inc' });

        const value = await GenServer.call(firstChild, { type: 'get' });
        expect(value).toBe(2);

        await cleanupTest(ref);
      });
    });

    describe('generateLoad', () => {
      it('generates cast messages', async () => {
        const { ref, childRefs } = await createTestSupervisor({
          childCount: 3,
        });

        const result = await generateLoad(Array.from(childRefs.values()), {
          messagesPerSecond: 100,
          durationMs: 200,
          messageType: 'cast',
        });

        expect(result.messagesSent).toBeGreaterThan(10);
        expect(result.successfulMessages).toBeGreaterThan(10);
        expect(result.actualMps).toBeGreaterThan(50);

        await cleanupTest(ref);
      });

      it('generates call messages with latency tracking', async () => {
        const { ref, childRefs } = await createTestSupervisor({
          childCount: 2,
        });

        const result = await generateLoad(Array.from(childRefs.values()), {
          messagesPerSecond: 20,
          durationMs: 500,
          messageType: 'call',
        });

        expect(result.messagesSent).toBeGreaterThan(3);
        expect(result.successfulMessages).toBeGreaterThan(0);
        // Latency is only tracked for successful calls
        if (result.successfulMessages > 0) {
          expect(result.avgLatencyMs).toBeGreaterThanOrEqual(0);
        }

        await cleanupTest(ref);
      });
    });

    describe('captureChildState and compareChildStates', () => {
      it('captures and compares child states', async () => {
        const { ref } = await createTestSupervisor({
          childCount: 3,
        });

        const before = captureChildState(ref);
        expect(before.size).toBe(3);

        // Crash one child
        crashChildById(ref, 'child_1');

        await waitFor(() => {
          const current = captureChildState(ref);
          return current.get('child_1') !== before.get('child_1');
        });

        const after = captureChildState(ref);
        const comparison = compareChildStates(before, after);

        expect(comparison.unchanged).toContain('child_0');
        expect(comparison.unchanged).toContain('child_2');
        expect(comparison.changed).toContain('child_1');
        expect(comparison.added).toHaveLength(0);
        expect(comparison.removed).toHaveLength(0);

        await cleanupTest(ref);
      });
    });

    describe('waitForChildRestarted', () => {
      it('waits for specific child to restart', async () => {
        const { ref, childRefs } = await createTestSupervisor({
          childCount: 2,
        });

        const originalRefId = childRefs.get('child_0')!.id;
        crashChildById(ref, 'child_0');

        const restartTime = await waitForChildRestarted(
          ref,
          'child_0',
          originalRefId,
        );

        expect(restartTime).toBeGreaterThan(0);
        expect(restartTime).toBeLessThan(2000);

        const newChild = Supervisor.getChild(ref, 'child_0');
        expect(newChild?.ref.id).not.toBe(originalRefId);

        await cleanupTest(ref);
      });
    });

    describe('waitForAllRestarted', () => {
      it('waits for all specified children to restart', async () => {
        const { ref, childRefs } = await createTestSupervisor({
          childCount: 3,
          strategy: 'one_for_all',
        });

        // Crash one child - all should restart due to one_for_all
        crashChildById(ref, 'child_1');

        const restartTimes = await waitForAllRestarted(ref, childRefs);

        expect(restartTimes.size).toBe(3);
        for (const time of restartTimes.values()) {
          expect(time).toBeGreaterThan(0);
          expect(time).toBeLessThan(2000);
        }

        await cleanupTest(ref);
      });
    });
  });

  describe('crash-simulator', () => {
    describe('crashChild', () => {
      it('crashes a GenServer by reference', async () => {
        const { ref, childRefs } = await createTestSupervisor({
          childCount: 1,
        });

        const childRef = childRefs.get('child_0')!;
        const event = crashChild(childRef, 'Test crash');

        expect(event.refId).toBe(childRef.id);
        expect(event.error.message).toBe('Test crash');
        expect(GenServer.isRunning(childRef)).toBe(false);

        await cleanupTest(ref);
      });
    });

    describe('crashChildById', () => {
      it('crashes child by ID within supervisor', async () => {
        const { ref } = await createTestSupervisor({
          childCount: 2,
        });

        const result = crashChildById(ref, 'child_0', 'ID crash');

        expect(result.success).toBe(true);
        expect(result.childId).toBe('child_0');

        await cleanupTest(ref);
      });

      it('returns failure for non-existent child', async () => {
        const { ref } = await createTestSupervisor({
          childCount: 1,
        });

        const result = crashChildById(ref, 'nonexistent');

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();

        await cleanupTest(ref);
      });
    });

    describe('crashMultiple', () => {
      it('crashes multiple GenServers simultaneously', async () => {
        const { ref, childRefs } = await createTestSupervisor({
          childCount: 3,
        });

        const refs = Array.from(childRefs.values());
        const events = crashMultiple(refs.slice(0, 2));

        expect(events).toHaveLength(2);

        // Verify both are crashed
        expect(GenServer.isRunning(refs[0]!)).toBe(false);
        expect(GenServer.isRunning(refs[1]!)).toBe(false);

        await cleanupTest(ref);
      });
    });

    describe('crashRandom', () => {
      it('crashes random selection of children', async () => {
        const { ref } = await createTestSupervisor({
          childCount: 10,
        });

        const results = crashRandom(ref, { count: 3 });

        expect(results).toHaveLength(3);
        expect(results.every(r => r.success)).toBe(true);

        // All crashed children should be different
        const crashedIds = new Set(results.map(r => r.childId));
        expect(crashedIds.size).toBe(3);

        await cleanupTest(ref);
      });

      it('handles count larger than available children', async () => {
        const { ref } = await createTestSupervisor({
          childCount: 2,
        });

        const results = crashRandom(ref, { count: 5 });

        expect(results).toHaveLength(2);

        await cleanupTest(ref);
      });
    });

    describe('scheduleCrashes', () => {
      it('executes crashes at scheduled times', async () => {
        const { ref } = await createTestSupervisor({
          childCount: 3,
        });

        const schedule = [
          { childId: 'child_0', delayMs: 50 },
          { childId: 'child_1', delayMs: 100 },
          { childId: 'child_2', delayMs: 150 },
        ];

        const result = await scheduleCrashes(ref, schedule);

        expect(result.results).toHaveLength(3);
        expect(result.results.every(r => r.success)).toBe(true);
        expect(result.durationMs).toBeGreaterThanOrEqual(100);
        expect(result.durationMs).toBeLessThan(500);

        await cleanupTest(ref);
      });
    });

    describe('crashBurst', () => {
      it('executes crash bursts at intervals', async () => {
        const { ref } = await createTestSupervisor({
          childCount: 10,
          restartIntensity: { maxRestarts: 50, withinMs: 5000 },
        });

        const result = await crashBurst(ref, {
          countPerBurst: 2,
          burstCount: 3,
          intervalMs: 50,
        });

        expect(result.bursts).toHaveLength(3);
        expect(result.totalCrashes).toBeLessThanOrEqual(6);
        expect(result.durationMs).toBeGreaterThanOrEqual(100);

        await cleanupTest(ref);
      });
    });

    describe('crashAll', () => {
      it('crashes all children', async () => {
        const { ref, childRefs } = await createTestSupervisor({
          childCount: 5,
        });

        const results = crashAll(ref);

        expect(results).toHaveLength(5);
        expect(results.every(r => r.success)).toBe(true);

        // All original refs should be crashed
        for (const childRef of childRefs.values()) {
          expect(GenServer.isRunning(childRef)).toBe(false);
        }

        await cleanupTest(ref);
      });
    });

    describe('crashSequential', () => {
      it('crashes children in sequence with delays', async () => {
        const { ref } = await createTestSupervisor({
          childCount: 3,
        });

        const startTime = Date.now();
        const results = await crashSequential(
          ref,
          ['child_0', 'child_1', 'child_2'],
          30,
        );

        const duration = Date.now() - startTime;

        expect(results).toHaveLength(3);
        expect(results.every(r => r.success)).toBe(true);
        expect(duration).toBeGreaterThanOrEqual(50);

        await cleanupTest(ref);
      });
    });
  });

  describe('metrics-collector', () => {
    describe('MetricsCollector', () => {
      it('collects restart metrics', async () => {
        const { ref, childRefs } = await createTestSupervisor({
          childCount: 3,
        });

        const collector = new MetricsCollector();
        collector.start();

        // Crash and wait for restart
        const childRef = childRefs.get('child_0')!;
        const originalRefId = childRef.id;

        collector.recordCrash('child_0', originalRefId);
        crashChild(childRef);

        await waitForChildRestarted(ref, 'child_0', originalRefId);

        const newChild = Supervisor.getChild(ref, 'child_0');
        collector.recordRestartComplete(originalRefId, newChild!.ref.id);

        collector.stop();
        const metrics = collector.getMetrics();

        expect(metrics.restarts.totalRestarts).toBe(1);
        expect(metrics.restarts.successfulRestarts).toBe(1);
        expect(metrics.restarts.successRate).toBe(1);
        expect(metrics.restarts.avgRestartTimeMs).toBeGreaterThan(0);

        await cleanupTest(ref);
      });

      it('collects memory metrics', async () => {
        const collector = new MetricsCollector({
          memorySnapshotIntervalMs: 50,
        });

        collector.start();
        await delay(150);
        collector.stop();

        const metrics = collector.getMetrics();

        expect(metrics.memory.snapshots.length).toBeGreaterThanOrEqual(2);
        expect(metrics.memory.initial.heapUsed).toBeGreaterThan(0);
        expect(metrics.memory.final.heapUsed).toBeGreaterThan(0);
      });

      it('tracks message metrics', () => {
        const collector = new MetricsCollector();
        collector.start();

        collector.recordMessageSent();
        collector.recordMessageSent();
        collector.recordMessageProcessed(10);
        collector.recordMessageProcessed(20);
        collector.recordMessageFailed();

        collector.stop();
        const metrics = collector.getMetrics();

        expect(metrics.messages.messagesSent).toBe(2);
        expect(metrics.messages.messagesProcessed).toBe(2);
        expect(metrics.messages.messagesFailed).toBe(1);
        expect(metrics.messages.avgLatencyMs).toBe(15);
      });

      it('provides timeline of events', async () => {
        const collector = new MetricsCollector();
        collector.start();

        collector.recordCrash('child_0', 'ref_1');
        collector.addCustomEvent('test_event', { value: 42 });

        collector.stop();
        const metrics = collector.getMetrics();

        const crashEvents = metrics.timeline.filter(e => e.type === 'crash');
        const customEvents = metrics.timeline.filter(e => e.type === 'custom');

        expect(crashEvents).toHaveLength(1);
        expect(crashEvents[0]?.childId).toBe('child_0');
        expect(customEvents).toHaveLength(1);
      });

      it('generates summary report', async () => {
        const collector = new MetricsCollector();
        collector.start();
        await delay(50);
        collector.stop();

        const summary = collector.getSummary();

        expect(summary).toContain('Stress Test Metrics');
        expect(summary).toContain('Duration:');
        expect(summary).toContain('Restarts:');
        expect(summary).toContain('Memory:');
      });
    });

    describe('SimpleRestartTracker', () => {
      it('tracks restart times', async () => {
        const tracker = new SimpleRestartTracker();

        tracker.recordCrash('ref_1');
        await delay(50);
        const time1 = tracker.recordRestart('ref_1');

        tracker.recordCrash('ref_2');
        await delay(30);
        const time2 = tracker.recordRestart('ref_2');

        expect(time1).toBeGreaterThanOrEqual(40);
        expect(time2).toBeGreaterThanOrEqual(20);
        expect(tracker.getRestartTimes()).toHaveLength(2);
        expect(tracker.getAverageRestartTime()).toBeGreaterThan(0);
        expect(tracker.getMaxRestartTime()).toBeGreaterThanOrEqual(time1);
      });
    });

    describe('MetricsAssertions', () => {
      it('assertAllRestartsWithin passes for fast restarts', () => {
        const metrics = {
          restarts: {
            restartTimes: [10, 20, 30],
          },
        } as any;

        expect(() => {
          MetricsAssertions.assertAllRestartsWithin(metrics, 50);
        }).not.toThrow();
      });

      it('assertAllRestartsWithin fails for slow restarts', () => {
        const metrics = {
          restarts: {
            restartTimes: [10, 20, 100],
          },
        } as any;

        expect(() => {
          MetricsAssertions.assertAllRestartsWithin(metrics, 50);
        }).toThrow('exceeded 50ms');
      });

      it('assertRestartSuccessRate validates threshold', () => {
        const metrics = {
          restarts: {
            successRate: 0.8,
          },
        } as any;

        expect(() => {
          MetricsAssertions.assertRestartSuccessRate(metrics, 0.75);
        }).not.toThrow();

        expect(() => {
          MetricsAssertions.assertRestartSuccessRate(metrics, 0.9);
        }).toThrow('below threshold');
      });

      it('assertMemoryGrowthBelow validates threshold', () => {
        const metrics = {
          memory: {
            heapGrowthPercent: 25,
          },
        } as any;

        expect(() => {
          MetricsAssertions.assertMemoryGrowthBelow(metrics, 50);
        }).not.toThrow();

        expect(() => {
          MetricsAssertions.assertMemoryGrowthBelow(metrics, 20);
        }).toThrow('exceeds threshold');
      });
    });
  });
});
