/**
 * Supervisor stress tests.
 *
 * Verifies supervisor restart behavior under high load and concurrent failures.
 * Tests all supervisor strategies (one_for_one, one_for_all, rest_for_one,
 * simple_one_for_one) with various failure patterns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Supervisor,
  GenServer,
  type SupervisorRef,
  type GenServerRef,
  type GenServerBehavior,
} from '../../src/index.js';

import {
  waitFor,
  waitForAllRestarted,
  waitForChildRestarted,
  createTestSupervisor,
  createTestBehavior,
  generateLoad,
  captureChildState,
  compareChildStates,
  delay,
  cleanupTest,
  resetTestState,
  type TestSupervisorConfig,
} from './test-helpers.js';

import {
  crashChildById,
  crashMultipleByIds,
  crashRandom,
  crashAll,
  crashSequential,
  crashBurst,
} from './crash-simulator.js';

import {
  MetricsCollector,
  SimpleRestartTracker,
  MetricsAssertions,
} from './metrics-collector.js';

/**
 * Default configuration for stress tests.
 * Uses high restart limits to allow testing intensive failure scenarios.
 */
const STRESS_TEST_DEFAULTS = {
  restartIntensity: { maxRestarts: 200, withinMs: 10000 },
  childCount: 10,
  maxRestartTimeMs: 2000,
} as const;

/**
 * Verifies all children are running and have valid refs.
 */
function assertAllChildrenRunning(ref: SupervisorRef, expectedCount: number): void {
  const children = Supervisor.getChildren(ref);
  expect(children.length).toBe(expectedCount);
  for (const child of children) {
    expect(GenServer.isRunning(child.ref)).toBe(true);
  }
}

/**
 * Gets a map of child IDs to their current GenServerRef IDs.
 */
function getChildRefIds(ref: SupervisorRef): Map<string, string> {
  const result = new Map<string, string>();
  for (const child of Supervisor.getChildren(ref)) {
    result.set(child.id, child.ref.id);
  }
  return result;
}

describe('Supervisor Stress Tests', () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(async () => {
    await Supervisor._clearAll();
    Supervisor._clearLifecycleHandlers();
    GenServer._clearLifecycleHandlers();
  });

  describe('Concurrent Crash Storm', () => {
    describe('one_for_one strategy', () => {
      it('restarts all crashed children while siblings remain unchanged', async () => {
        const { ref, childRefs, childIds } = await createTestSupervisor({
          childCount: STRESS_TEST_DEFAULTS.childCount,
          strategy: 'one_for_one',
          restartIntensity: STRESS_TEST_DEFAULTS.restartIntensity,
        });

        const tracker = new SimpleRestartTracker();
        const stateBefore = captureChildState(ref);

        // Crash half of the children simultaneously
        const crashedIds = childIds.slice(0, 5);
        const unchangedIds = childIds.slice(5);

        for (const id of crashedIds) {
          tracker.recordCrash(childRefs.get(id)!.id);
        }

        crashMultipleByIds(ref, crashedIds, 'Concurrent crash storm');

        // Wait for all crashed children to restart
        const crashedRefs = new Map<string, GenServerRef>();
        for (const id of crashedIds) {
          crashedRefs.set(id, childRefs.get(id)!);
        }

        await waitForAllRestarted(ref, crashedRefs, {
          timeoutMs: STRESS_TEST_DEFAULTS.maxRestartTimeMs,
        });

        const stateAfter = captureChildState(ref);
        const comparison = compareChildStates(stateBefore, stateAfter);

        // Verify only crashed children changed
        expect(comparison.changed.sort()).toEqual(crashedIds.sort());
        expect(comparison.unchanged.sort()).toEqual(unchangedIds.sort());
        expect(comparison.added).toHaveLength(0);
        expect(comparison.removed).toHaveLength(0);

        // All children should be running
        assertAllChildrenRunning(ref, STRESS_TEST_DEFAULTS.childCount);

        await cleanupTest(ref);
      });

      it('handles 100% concurrent crash of all children', async () => {
        const { ref, childRefs, childIds } = await createTestSupervisor({
          childCount: STRESS_TEST_DEFAULTS.childCount,
          strategy: 'one_for_one',
          restartIntensity: STRESS_TEST_DEFAULTS.restartIntensity,
        });

        const metrics = new MetricsCollector();
        metrics.start();

        // Record crash times for all children
        for (const [id, childRef] of childRefs) {
          metrics.recordCrash(id, childRef.id);
        }

        // Crash all children at once
        crashAll(ref, '100% crash storm');

        // Wait for all to restart
        await waitForAllRestarted(ref, childRefs, {
          timeoutMs: STRESS_TEST_DEFAULTS.maxRestartTimeMs,
        });

        // Record restart completions
        for (const [id, originalRef] of childRefs) {
          const newChild = Supervisor.getChild(ref, id);
          if (newChild) {
            metrics.recordRestartComplete(originalRef.id, newChild.ref.id);
          }
        }

        metrics.stop();
        const report = metrics.getMetrics();

        // All children should have restarted successfully
        expect(report.restarts.successfulRestarts).toBe(STRESS_TEST_DEFAULTS.childCount);
        assertAllChildrenRunning(ref, STRESS_TEST_DEFAULTS.childCount);

        // All children should have new refs
        for (const id of childIds) {
          const originalRefId = childRefs.get(id)!.id;
          const currentChild = Supervisor.getChild(ref, id);
          expect(currentChild?.ref.id).not.toBe(originalRefId);
        }

        await cleanupTest(ref);
      });
    });

    describe('one_for_all strategy', () => {
      it('restarts all children when one crashes', async () => {
        const { ref, childRefs, childIds } = await createTestSupervisor({
          childCount: STRESS_TEST_DEFAULTS.childCount,
          strategy: 'one_for_all',
          restartIntensity: STRESS_TEST_DEFAULTS.restartIntensity,
        });

        const stateBefore = captureChildState(ref);

        // Crash just one child
        crashChildById(ref, 'child_3', 'Trigger one_for_all');

        // Wait for ALL children to restart (one_for_all behavior)
        await waitForAllRestarted(ref, childRefs, {
          timeoutMs: STRESS_TEST_DEFAULTS.maxRestartTimeMs,
        });

        const stateAfter = captureChildState(ref);
        const comparison = compareChildStates(stateBefore, stateAfter);

        // All children should have new refs
        expect(comparison.changed.length).toBe(STRESS_TEST_DEFAULTS.childCount);
        expect(comparison.unchanged).toHaveLength(0);

        assertAllChildrenRunning(ref, STRESS_TEST_DEFAULTS.childCount);

        await cleanupTest(ref);
      });

      it('handles rapid concurrent crashes with all children restarting', async () => {
        const { ref, childRefs, childIds } = await createTestSupervisor({
          childCount: 8,
          strategy: 'one_for_all',
          restartIntensity: { maxRestarts: 50, withinMs: 10000 },
        });

        // Crash multiple children simultaneously
        crashMultipleByIds(ref, ['child_0', 'child_4', 'child_7']);

        // Wait for all to restart
        await waitForAllRestarted(ref, childRefs, {
          timeoutMs: STRESS_TEST_DEFAULTS.maxRestartTimeMs,
        });

        // All 8 children should have new refs
        const stateAfter = captureChildState(ref);
        for (const [id, originalRefId] of captureChildState(ref)) {
          // stateAfter will have new refs for all
        }

        for (const [id, originalRef] of childRefs) {
          const currentChild = Supervisor.getChild(ref, id);
          expect(currentChild?.ref.id).not.toBe(originalRef.id);
        }

        assertAllChildrenRunning(ref, 8);

        await cleanupTest(ref);
      });
    });

    describe('rest_for_one strategy', () => {
      it('restarts crashed child and all subsequent children', async () => {
        const { ref, childRefs, childIds } = await createTestSupervisor({
          childCount: STRESS_TEST_DEFAULTS.childCount,
          strategy: 'rest_for_one',
          restartIntensity: STRESS_TEST_DEFAULTS.restartIntensity,
        });

        const stateBefore = captureChildState(ref);

        // Crash child_3 - should restart child_3 through child_9
        crashChildById(ref, 'child_3', 'Trigger rest_for_one');

        // Children after crashed one should restart
        const shouldRestart = childIds.slice(3); // child_3 onwards
        const shouldRemain = childIds.slice(0, 3); // child_0, child_1, child_2

        const refsToWatch = new Map<string, GenServerRef>();
        for (const id of shouldRestart) {
          refsToWatch.set(id, childRefs.get(id)!);
        }

        await waitForAllRestarted(ref, refsToWatch, {
          timeoutMs: STRESS_TEST_DEFAULTS.maxRestartTimeMs,
        });

        const stateAfter = captureChildState(ref);
        const comparison = compareChildStates(stateBefore, stateAfter);

        // Verify correct children changed
        expect(comparison.changed.sort()).toEqual(shouldRestart.sort());
        expect(comparison.unchanged.sort()).toEqual(shouldRemain.sort());

        assertAllChildrenRunning(ref, STRESS_TEST_DEFAULTS.childCount);

        await cleanupTest(ref);
      });

      it('handles crash of first child causing full restart', async () => {
        const { ref, childRefs, childIds } = await createTestSupervisor({
          childCount: 5,
          strategy: 'rest_for_one',
          restartIntensity: STRESS_TEST_DEFAULTS.restartIntensity,
        });

        // Crash first child - all should restart
        crashChildById(ref, 'child_0');

        await waitForAllRestarted(ref, childRefs, {
          timeoutMs: STRESS_TEST_DEFAULTS.maxRestartTimeMs,
        });

        // All should have new refs
        for (const [id, originalRef] of childRefs) {
          const currentChild = Supervisor.getChild(ref, id);
          expect(currentChild?.ref.id).not.toBe(originalRef.id);
        }

        assertAllChildrenRunning(ref, 5);

        await cleanupTest(ref);
      });

      it('handles crash of last child with minimal impact', async () => {
        const { ref, childRefs, childIds } = await createTestSupervisor({
          childCount: 5,
          strategy: 'rest_for_one',
          restartIntensity: STRESS_TEST_DEFAULTS.restartIntensity,
        });

        const stateBefore = captureChildState(ref);
        const lastChild = childIds[childIds.length - 1]!;

        // Crash last child - only it should restart
        crashChildById(ref, lastChild);

        await waitForChildRestarted(ref, lastChild, childRefs.get(lastChild)!.id, {
          timeoutMs: STRESS_TEST_DEFAULTS.maxRestartTimeMs,
        });

        const stateAfter = captureChildState(ref);
        const comparison = compareChildStates(stateBefore, stateAfter);

        // Only last child should have changed
        expect(comparison.changed).toEqual([lastChild]);
        expect(comparison.unchanged.length).toBe(4);

        assertAllChildrenRunning(ref, 5);

        await cleanupTest(ref);
      });
    });

    describe('simple_one_for_one strategy', () => {
      it('dynamically adds and crashes children under load', async () => {
        const behavior = createTestBehavior();

        const ref = await Supervisor.start({
          strategy: 'simple_one_for_one',
          restartIntensity: STRESS_TEST_DEFAULTS.restartIntensity,
          childTemplate: {
            start: () => GenServer.start(behavior),
          },
        });

        // Dynamically spawn children
        const childRefs: GenServerRef[] = [];
        for (let i = 0; i < 10; i++) {
          const childRef = await Supervisor.startChild(ref, []);
          childRefs.push(childRef);
        }

        expect(Supervisor.countChildren(ref)).toBe(10);

        // Get current state
        const children = Supervisor.getChildren(ref);
        const originalRefs = new Map<string, GenServerRef>();
        for (const child of children) {
          originalRefs.set(child.id, child.ref);
        }

        // Crash half of the children
        const childrenTocrash = children.slice(0, 5);
        for (const child of childrenTocrash) {
          GenServer._forceTerminate(child.ref, { error: new Error('Stress test') });
        }

        // Wait for all to restart
        const refsToWatch = new Map<string, GenServerRef>();
        for (const child of childrenTocrash) {
          refsToWatch.set(child.id, child.ref);
        }

        await waitForAllRestarted(ref, refsToWatch, {
          timeoutMs: STRESS_TEST_DEFAULTS.maxRestartTimeMs,
        });

        // All should still exist with new refs for crashed ones
        expect(Supervisor.countChildren(ref)).toBe(10);

        await cleanupTest(ref);
      });

      it('handles continuous spawn and crash cycles', async () => {
        const behavior = createTestBehavior();

        const ref = await Supervisor.start({
          strategy: 'simple_one_for_one',
          restartIntensity: { maxRestarts: 100, withinMs: 10000 },
          childTemplate: {
            start: () => GenServer.start(behavior),
          },
        });

        // Run multiple spawn-crash cycles
        for (let cycle = 0; cycle < 3; cycle++) {
          // Spawn 5 children
          for (let i = 0; i < 5; i++) {
            await Supervisor.startChild(ref, []);
          }

          const children = Supervisor.getChildren(ref);
          const currentCount = children.length;

          // Crash 2 random children
          const toCrash = children.slice(0, 2);
          const refsToWatch = new Map<string, GenServerRef>();
          for (const child of toCrash) {
            refsToWatch.set(child.id, child.ref);
            GenServer._forceTerminate(child.ref, { error: new Error('Cycle crash') });
          }

          await waitForAllRestarted(ref, refsToWatch, {
            timeoutMs: STRESS_TEST_DEFAULTS.maxRestartTimeMs,
          });

          // Count should remain the same
          expect(Supervisor.countChildren(ref)).toBe(currentCount);
        }

        // Final count should be 15 (5 per cycle * 3 cycles)
        expect(Supervisor.countChildren(ref)).toBe(15);

        await cleanupTest(ref);
      });
    });
  });

  describe('Rapid Sequential Crashes', () => {
    it('handles rapid sequential crashes within intensity window', async () => {
      const maxRestarts = 20;
      const { ref, childIds } = await createTestSupervisor({
        childCount: STRESS_TEST_DEFAULTS.childCount,
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts, withinMs: 10000 },
      });

      const tracker = new SimpleRestartTracker();

      // Perform rapid sequential crashes (less than max limit)
      for (let i = 0; i < maxRestarts - 5; i++) {
        const childId = childIds[i % childIds.length]!;
        const child = Supervisor.getChild(ref, childId);
        if (child) {
          tracker.recordCrash(child.ref.id);
          crashChildById(ref, childId, `Sequential crash ${i}`);

          // Small delay to allow restart
          await delay(50);

          // Wait for restart before next crash
          await waitFor(() => {
            const current = Supervisor.getChild(ref, childId);
            return current !== undefined && current.ref.id !== child.ref.id;
          }, { timeoutMs: 1000 });
        }
      }

      // Supervisor should still be running
      expect(Supervisor.isRunning(ref)).toBe(true);
      assertAllChildrenRunning(ref, STRESS_TEST_DEFAULTS.childCount);

      await cleanupTest(ref);
    });

    it('respects restart intensity limit', async () => {
      const maxRestarts = 5;
      const { ref, childIds } = await createTestSupervisor({
        childCount: 3,
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts, withinMs: 5000 },
      });

      let crashCount = 0;

      // Set up a promise to catch the MaxRestartsExceededError
      const errorPromise = new Promise<void>((resolve) => {
        const originalHandler = process.listeners('unhandledRejection')[0];
        const handler = (error: unknown) => {
          if (error instanceof Error && error.message.includes('exceeded max restarts')) {
            resolve();
          }
        };
        process.once('unhandledRejection', handler);
        // Clean up after timeout
        setTimeout(() => {
          process.removeListener('unhandledRejection', handler);
        }, 3000);
      });

      // Crash repeatedly until we exceed the limit
      for (let i = 0; i < maxRestarts + 3; i++) {
        const childId = childIds[i % childIds.length]!;
        const child = Supervisor.getChild(ref, childId);

        if (!child || !Supervisor.isRunning(ref)) break;

        crashChildById(ref, childId);
        crashCount++;

        // Wait a bit for restart or error
        await delay(100);

        // Check if supervisor is still running
        if (!Supervisor.isRunning(ref)) {
          break;
        }
      }

      // Wait for the supervisor to stop or error to be thrown
      await Promise.race([
        errorPromise,
        delay(500),
      ]);

      // The supervisor should have stopped due to intensity limit
      expect(crashCount).toBeGreaterThanOrEqual(maxRestarts);
      // Supervisor should no longer be running
      expect(Supervisor.isRunning(ref)).toBe(false);

      // Cleanup is safe even if supervisor is stopped
      await cleanupTest(ref);
    });
  });

  describe('Message Processing Under Crashes', () => {
    it('maintains message processing during periodic crashes', async () => {
      const { ref, childRefs, childIds } = await createTestSupervisor({
        childCount: 8,
        strategy: 'one_for_one',
        restartIntensity: STRESS_TEST_DEFAULTS.restartIntensity,
      });

      const metrics = new MetricsCollector();
      metrics.start();

      let totalSent = 0;
      let totalSuccessful = 0;
      let crashCount = 0;

      // Run load and crashes concurrently
      const loadDuration = 1500;
      const crashIntervalMs = 300;
      const startTime = Date.now();

      // Crash scheduler
      const crashPromise = (async () => {
        while (Date.now() - startTime < loadDuration) {
          if (Supervisor.isRunning(ref)) {
            const randomChild = childIds[Math.floor(Math.random() * childIds.length)]!;
            crashChildById(ref, randomChild, 'Crash during load');
            crashCount++;
          }
          await delay(crashIntervalMs);
        }
      })();

      // Message sending - get fresh refs each time
      const messagePromise = (async () => {
        while (Date.now() - startTime < loadDuration) {
          const children = Supervisor.getChildren(ref);
          for (const child of children) {
            if (GenServer.isRunning(child.ref)) {
              try {
                GenServer.cast(child.ref, { type: 'inc' });
                totalSent++;
                totalSuccessful++;
              } catch {
                totalSent++;
              }
            }
          }
          await delay(20);
        }
      })();

      await Promise.all([crashPromise, messagePromise]);

      // Wait for any pending restarts
      await delay(500);

      metrics.stop();

      // Should have processed messages and had crashes
      expect(totalSent).toBeGreaterThan(20);
      expect(crashCount).toBeGreaterThan(0);

      // Supervisor should still be running with all children
      expect(Supervisor.isRunning(ref)).toBe(true);
      assertAllChildrenRunning(ref, 8);

      await cleanupTest(ref);
    });

    it('handles high-frequency calls during crash storm', async () => {
      const { ref, childRefs, childIds } = await createTestSupervisor({
        childCount: 8,
        strategy: 'one_for_one',
        restartIntensity: STRESS_TEST_DEFAULTS.restartIntensity,
      });

      let successfulCalls = 0;
      let failedCalls = 0;

      // Start concurrent crash burst
      const crashPromise = crashBurst(ref, {
        countPerBurst: 2,
        burstCount: 5,
        intervalMs: 100,
      });

      // Simultaneously send many calls
      const callPromises: Promise<void>[] = [];
      for (let i = 0; i < 50; i++) {
        const childId = childIds[i % childIds.length]!;
        const child = Supervisor.getChild(ref, childId);

        if (child && GenServer.isRunning(child.ref)) {
          callPromises.push(
            GenServer.call(child.ref, { type: 'get' }, { timeout: 500 })
              .then(() => { successfulCalls++; })
              .catch(() => { failedCalls++; }),
          );
        } else {
          failedCalls++;
        }

        await delay(20);
      }

      // Wait for everything to complete
      await Promise.allSettled(callPromises);
      await crashPromise;
      await delay(500);

      // Should have some successful calls even during crashes
      expect(successfulCalls).toBeGreaterThan(10);
      expect(Supervisor.isRunning(ref)).toBe(true);

      await cleanupTest(ref);
    });
  });

  describe('Strategy-Specific Isolation Tests', () => {
    it('one_for_one isolates restarts to crashed child only', async () => {
      const { ref, childRefs } = await createTestSupervisor({
        childCount: 5,
        strategy: 'one_for_one',
        restartIntensity: STRESS_TEST_DEFAULTS.restartIntensity,
      });

      // Set state on all children
      for (const childRef of childRefs.values()) {
        GenServer.cast(childRef, { type: 'inc' });
        GenServer.cast(childRef, { type: 'inc' });
      }

      // Verify initial state
      for (const childRef of childRefs.values()) {
        const value = await GenServer.call(childRef, { type: 'get' });
        expect(value).toBe(2);
      }

      // Crash one child
      const crashedId = 'child_2';
      const originalRef = childRefs.get(crashedId)!;
      crashChildById(ref, crashedId);

      await waitForChildRestarted(ref, crashedId, originalRef.id);

      // Crashed child should have reset state
      const newChild = Supervisor.getChild(ref, crashedId);
      const newValue = await GenServer.call(newChild!.ref, { type: 'get' });
      expect(newValue).toBe(0); // Reset after restart

      // Other children should retain their state
      for (const [id, childRef] of childRefs) {
        if (id !== crashedId) {
          const value = await GenServer.call(childRef, { type: 'get' });
          expect(value).toBe(2); // State preserved
        }
      }

      await cleanupTest(ref);
    });

    it('one_for_all resets all children state on any crash', async () => {
      const { ref, childRefs, childIds } = await createTestSupervisor({
        childCount: 5,
        strategy: 'one_for_all',
        restartIntensity: STRESS_TEST_DEFAULTS.restartIntensity,
      });

      // Set state on all children
      for (const childRef of childRefs.values()) {
        GenServer.cast(childRef, { type: 'inc' });
        GenServer.cast(childRef, { type: 'inc' });
        GenServer.cast(childRef, { type: 'inc' });
      }

      // Verify initial state
      for (const childRef of childRefs.values()) {
        const value = await GenServer.call(childRef, { type: 'get' });
        expect(value).toBe(3);
      }

      // Crash one child
      crashChildById(ref, 'child_2');

      await waitForAllRestarted(ref, childRefs);

      // ALL children should have reset state
      for (const id of childIds) {
        const child = Supervisor.getChild(ref, id);
        const value = await GenServer.call(child!.ref, { type: 'get' });
        expect(value).toBe(0); // All reset
      }

      await cleanupTest(ref);
    });

    it('rest_for_one preserves state of earlier children', async () => {
      const { ref, childRefs, childIds } = await createTestSupervisor({
        childCount: 5,
        strategy: 'rest_for_one',
        restartIntensity: STRESS_TEST_DEFAULTS.restartIntensity,
      });

      // Set incrementing state on children
      for (let i = 0; i < childIds.length; i++) {
        const childRef = childRefs.get(childIds[i]!)!;
        for (let j = 0; j <= i; j++) {
          GenServer.cast(childRef, { type: 'inc' });
        }
      }

      // Verify: child_0=1, child_1=2, child_2=3, child_3=4, child_4=5
      for (let i = 0; i < childIds.length; i++) {
        const value = await GenServer.call(childRefs.get(childIds[i]!)!, { type: 'get' });
        expect(value).toBe(i + 1);
      }

      // Crash child_2 - should reset child_2, child_3, child_4
      const refsToWatch = new Map<string, GenServerRef>();
      for (let i = 2; i < childIds.length; i++) {
        refsToWatch.set(childIds[i]!, childRefs.get(childIds[i]!)!);
      }

      crashChildById(ref, 'child_2');
      await waitForAllRestarted(ref, refsToWatch);

      // child_0 and child_1 should retain state
      const child0 = Supervisor.getChild(ref, 'child_0');
      const child1 = Supervisor.getChild(ref, 'child_1');
      expect(await GenServer.call(child0!.ref, { type: 'get' })).toBe(1);
      expect(await GenServer.call(child1!.ref, { type: 'get' })).toBe(2);

      // child_2, child_3, child_4 should be reset
      for (let i = 2; i < childIds.length; i++) {
        const child = Supervisor.getChild(ref, childIds[i]!);
        const value = await GenServer.call(child!.ref, { type: 'get' });
        expect(value).toBe(0); // Reset
      }

      await cleanupTest(ref);
    });
  });

  describe('Stress Metrics Validation', () => {
    it('collects accurate restart metrics during crash storm', async () => {
      const { ref, childRefs, childIds } = await createTestSupervisor({
        childCount: 10,
        strategy: 'one_for_one',
        restartIntensity: STRESS_TEST_DEFAULTS.restartIntensity,
      });

      const metrics = new MetricsCollector();
      metrics.start();

      // Perform 20 crashes
      for (let i = 0; i < 20; i++) {
        const childId = childIds[i % childIds.length]!;
        const child = Supervisor.getChild(ref, childId);
        if (child) {
          const originalRefId = child.ref.id;
          metrics.recordCrash(childId, originalRefId);

          crashChildById(ref, childId);

          await waitForChildRestarted(ref, childId, originalRefId);

          const newChild = Supervisor.getChild(ref, childId);
          if (newChild) {
            metrics.recordRestartComplete(originalRefId, newChild.ref.id);
          }
        }
      }

      metrics.stop();
      const report = metrics.getMetrics();

      // Validate metrics
      expect(report.restarts.totalRestarts).toBe(20);
      expect(report.restarts.successfulRestarts).toBe(20);
      expect(report.restarts.successRate).toBe(1);
      expect(report.restarts.avgRestartTimeMs).toBeGreaterThan(0);
      expect(report.restarts.p95RestartTimeMs).toBeGreaterThan(0);

      // All restarts should be within reasonable time
      MetricsAssertions.assertAllRestartsWithin(report, STRESS_TEST_DEFAULTS.maxRestartTimeMs);

      await cleanupTest(ref);
    });

    it('validates memory stability during extended stress', async () => {
      const { ref, childIds } = await createTestSupervisor({
        childCount: 10,
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts: 100, withinMs: 30000 },
      });

      const metrics = new MetricsCollector({
        memorySnapshotIntervalMs: 200,
      });
      metrics.start();

      // Run extended stress test
      for (let cycle = 0; cycle < 5; cycle++) {
        // Crash and restart several children
        for (let i = 0; i < 5; i++) {
          const childId = childIds[i]!;
          const child = Supervisor.getChild(ref, childId);
          if (child) {
            const originalRefId = child.ref.id;
            crashChildById(ref, childId);
            await waitForChildRestarted(ref, childId, originalRefId);
          }
        }

        // Generate some load
        const children = Supervisor.getChildren(ref);
        const activeRefs = children.map((c) => c.ref);
        await generateLoad(activeRefs, {
          messagesPerSecond: 100,
          durationMs: 200,
        });
      }

      metrics.stop();
      const report = metrics.getMetrics();

      // Memory growth should be reasonable (< 50%)
      MetricsAssertions.assertMemoryGrowthBelow(report, 50);

      await cleanupTest(ref);
    });
  });
});
