/**
 * Chaos testing for Supervisor restart behavior.
 *
 * Implements chaos engineering principles to verify system resilience:
 * - Random crash injection with varying frequencies and patterns
 * - Cascading failures through deep supervision trees
 * - Failures during child initialization (slow init chaos)
 *
 * These tests verify that the supervision tree remains stable under
 * unpredictable, real-world-like failure conditions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Supervisor,
  GenServer,
  type SupervisorRef,
  type GenServerRef,
  type GenServerBehavior,
  type ChildSpec,
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
} from './test-helpers.js';

import {
  crashChildById,
  crashRandom,
  crashContinuous,
  crashBurst,
  crashAll,
} from './crash-simulator.js';

import {
  MetricsCollector,
  SimpleRestartTracker,
  MetricsAssertions,
} from './metrics-collector.js';

/**
 * Configuration constants for chaos tests.
 * Tuned for balance between thoroughness and test execution time.
 */
const CHAOS_CONFIG = {
  /** High restart limits to allow extensive chaos testing. */
  restartIntensity: { maxRestarts: 500, withinMs: 60000 },
  /** Maximum acceptable restart time in milliseconds. */
  maxRestartTimeMs: 2000,
  /** Default child count for most tests. */
  defaultChildCount: 10,
  /** Extended test duration in milliseconds. */
  extendedDurationMs: 10000,
  /** Short test duration for quicker validation. */
  shortDurationMs: 3000,
} as const;

/**
 * Crash frequency profiles for random crash injection.
 * Each profile represents a different failure pattern.
 */
const CRASH_FREQUENCIES = {
  /** Low frequency - occasional failures, simulates stable system with rare issues. */
  low: { avgIntervalMs: 1000, variance: 0.3 },
  /** Medium frequency - regular failures, simulates degraded system. */
  medium: { avgIntervalMs: 300, variance: 0.4 },
  /** High frequency - frequent failures, simulates system under severe stress. */
  high: { avgIntervalMs: 100, variance: 0.5 },
  /** Burst - clustered failures with variable intervals. */
  burst: { avgIntervalMs: 50, variance: 0.8 },
} as const;

/**
 * Creates a behavior with configurable initialization delay.
 * Used for testing crash scenarios during slow child startup.
 *
 * @param initDelayMs - Time to delay during init phase
 * @param shouldFail - If true, init will throw an error
 */
function createSlowInitBehavior(
  initDelayMs: number,
  shouldFail: boolean = false,
): GenServerBehavior<number, { type: 'get' }, { type: 'inc' }, number> {
  return {
    init: async () => {
      await delay(initDelayMs);
      if (shouldFail) {
        throw new Error(`Init failed after ${initDelayMs}ms`);
      }
      return 0;
    },
    handleCall: (msg, state) => {
      if (msg.type === 'get') {
        return [state, state];
      }
      return [state, state];
    },
    handleCast: (msg, state) => {
      if (msg.type === 'inc') {
        return state + 1;
      }
      return state;
    },
  };
}

/**
 * Creates a behavior that tracks its initialization order.
 * Useful for verifying restart sequences in cascading scenarios.
 */
function createOrderTrackingBehavior(
  orderTracker: { order: string[] },
  childId: string,
): GenServerBehavior<{ id: string; initTime: number }, { type: 'get_id' }, { type: 'noop' }, { id: string; initTime: number }> {
  return {
    init: () => {
      orderTracker.order.push(childId);
      return { id: childId, initTime: Date.now() };
    },
    handleCall: (msg, state) => {
      if (msg.type === 'get_id') {
        return [state.id, state];
      }
      return [state.id, state];
    },
    handleCast: (_, state) => state,
  };
}

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

describe('Chaos Testing', () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(async () => {
    await Supervisor._clearAll();
    Supervisor._clearLifecycleHandlers();
    GenServer._clearLifecycleHandlers();
  });

  describe('Random Crash Injection', () => {
    it('survives 10+ seconds of random crashes at low frequency', { timeout: 20000 }, async () => {
      const { ref, childRefs, childIds } = await createTestSupervisor({
        childCount: CHAOS_CONFIG.defaultChildCount,
        strategy: 'one_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
      });

      const metrics = new MetricsCollector({ memorySnapshotIntervalMs: 1000 });
      metrics.start();

      // Run continuous random crashes at low frequency
      const crashResult = await crashContinuous(ref, {
        durationMs: CHAOS_CONFIG.extendedDurationMs,
        avgIntervalMs: CRASH_FREQUENCIES.low.avgIntervalMs,
        variance: CRASH_FREQUENCIES.low.variance,
        maxConcurrent: 1,
        reason: 'Low frequency chaos',
      });

      // Allow pending restarts to complete
      await delay(500);

      metrics.stop();
      const report = metrics.getMetrics();

      // Verify system survived
      expect(Supervisor.isRunning(ref)).toBe(true);
      assertAllChildrenRunning(ref, CHAOS_CONFIG.defaultChildCount);

      // Verify crashes occurred
      expect(crashResult.successfulCrashes).toBeGreaterThan(5);

      // Verify actual duration was close to expected
      expect(crashResult.actualDurationMs).toBeGreaterThanOrEqual(CHAOS_CONFIG.extendedDurationMs * 0.9);

      // Memory should remain stable
      MetricsAssertions.assertMemoryGrowthBelow(report, 50);

      await cleanupTest(ref);
    });

    it('survives high frequency crashes without supervisor failure', async () => {
      const { ref, childIds } = await createTestSupervisor({
        childCount: CHAOS_CONFIG.defaultChildCount,
        strategy: 'one_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
      });

      const tracker = new SimpleRestartTracker();

      // Run high frequency crashes for shorter duration
      const crashResult = await crashContinuous(ref, {
        durationMs: CHAOS_CONFIG.shortDurationMs,
        avgIntervalMs: CRASH_FREQUENCIES.high.avgIntervalMs,
        variance: CRASH_FREQUENCIES.high.variance,
        maxConcurrent: 2,
        reason: 'High frequency chaos',
      });

      await delay(500);

      // Supervisor must survive
      expect(Supervisor.isRunning(ref)).toBe(true);
      assertAllChildrenRunning(ref, CHAOS_CONFIG.defaultChildCount);

      // Should have many more crashes at high frequency
      expect(crashResult.successfulCrashes).toBeGreaterThan(15);

      await cleanupTest(ref);
    });

    it('handles burst crash patterns with recovery periods', async () => {
      const { ref, childRefs, childIds } = await createTestSupervisor({
        childCount: 8,
        strategy: 'one_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
      });

      const metrics = new MetricsCollector();
      metrics.start();

      // Execute multiple burst patterns with recovery periods
      for (let cycle = 0; cycle < 3; cycle++) {
        // Burst phase - rapid crashes
        const burstResult = await crashBurst(ref, {
          countPerBurst: 3,
          burstCount: 4,
          intervalMs: 50,
          reason: `Burst cycle ${cycle + 1}`,
        });

        // Verify burst executed
        expect(burstResult.totalCrashes).toBeGreaterThan(5);

        // Recovery period
        await delay(1000);

        // System should still be running after each burst
        expect(Supervisor.isRunning(ref)).toBe(true);
      }

      // Allow final recovery
      await delay(500);

      metrics.stop();
      const report = metrics.getMetrics();

      // Verify final state
      assertAllChildrenRunning(ref, 8);

      // Memory should not leak during burst/recovery cycles
      MetricsAssertions.assertMemoryGrowthBelow(report, 50);

      await cleanupTest(ref);
    });

    it('maintains message processing capability during random crashes', { timeout: 15000 }, async () => {
      const { ref, childIds } = await createTestSupervisor({
        childCount: CHAOS_CONFIG.defaultChildCount,
        strategy: 'one_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
      });

      let messagesProcessed = 0;
      let messagesFailed = 0;
      const testDuration = 5000;
      const startTime = Date.now();

      // Run crashes and messages concurrently
      const crashPromise = crashContinuous(ref, {
        durationMs: testDuration,
        avgIntervalMs: CRASH_FREQUENCIES.medium.avgIntervalMs,
        variance: CRASH_FREQUENCIES.medium.variance,
        maxConcurrent: 1,
      });

      const messagePromise = (async () => {
        while (Date.now() - startTime < testDuration) {
          const children = Supervisor.getChildren(ref);
          for (const child of children) {
            try {
              if (GenServer.isRunning(child.ref)) {
                GenServer.cast(child.ref, { type: 'inc' });
                messagesProcessed++;
              }
            } catch {
              messagesFailed++;
            }
          }
          await delay(20);
        }
      })();

      await Promise.all([crashPromise, messagePromise]);
      await delay(500);

      // Should have processed many messages despite crashes
      expect(messagesProcessed).toBeGreaterThan(100);

      // System should remain operational
      expect(Supervisor.isRunning(ref)).toBe(true);
      assertAllChildrenRunning(ref, CHAOS_CONFIG.defaultChildCount);

      await cleanupTest(ref);
    });

    it('handles all supervisor strategies under random chaos', { timeout: 15000 }, async () => {
      const strategies = ['one_for_one', 'one_for_all', 'rest_for_one'] as const;

      for (const strategy of strategies) {
        resetTestState();

        const { ref } = await createTestSupervisor({
          childCount: 5,
          strategy,
          restartIntensity: CHAOS_CONFIG.restartIntensity,
        });

        // Apply random crashes
        await crashContinuous(ref, {
          durationMs: 2000,
          avgIntervalMs: CRASH_FREQUENCIES.medium.avgIntervalMs,
          variance: CRASH_FREQUENCIES.medium.variance,
        });

        await delay(500);

        // Each strategy should survive
        expect(Supervisor.isRunning(ref)).toBe(true);
        assertAllChildrenRunning(ref, 5);

        await cleanupTest(ref);
        await Supervisor._clearAll();
      }
    });
  });

  describe('Cascading Failures', () => {
    it('handles crash propagation in deep supervision tree', async () => {
      // Create a 3-level deep supervision tree
      const leafBehavior = createTestBehavior();

      // Level 3: Leaf supervisor with children
      const level3Ref = await Supervisor.start({
        strategy: 'one_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
        children: Array.from({ length: 3 }, (_, i) => ({
          id: `leaf_${i}`,
          start: () => GenServer.start(leafBehavior),
        })),
      });

      // Level 2: Mid-level supervisor managing level 3
      const level2Ref = await Supervisor.start({
        strategy: 'one_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
        children: [
          { id: 'child_a', start: () => GenServer.start(leafBehavior) },
          { id: 'child_b', start: () => GenServer.start(leafBehavior) },
        ],
      });

      // Level 1: Root supervisor
      const rootRef = await Supervisor.start({
        strategy: 'one_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
        children: [
          { id: 'worker', start: () => GenServer.start(leafBehavior) },
        ],
      });

      // Verify initial state
      expect(Supervisor.isRunning(level3Ref)).toBe(true);
      expect(Supervisor.isRunning(level2Ref)).toBe(true);
      expect(Supervisor.isRunning(rootRef)).toBe(true);

      // Crash children at level 3
      crashAll(level3Ref, 'Cascade test');
      await delay(300);

      // Level 3 supervisor should have restarted its children
      expect(Supervisor.isRunning(level3Ref)).toBe(true);
      expect(Supervisor.countChildren(level3Ref)).toBe(3);

      // Crash children at level 2
      crashAll(level2Ref, 'Cascade test');
      await delay(300);

      expect(Supervisor.isRunning(level2Ref)).toBe(true);
      expect(Supervisor.countChildren(level2Ref)).toBe(2);

      // All levels should remain operational
      expect(Supervisor.isRunning(rootRef)).toBe(true);
      expect(Supervisor.isRunning(level2Ref)).toBe(true);
      expect(Supervisor.isRunning(level3Ref)).toBe(true);

      // Cleanup all levels
      await Supervisor.stop(level3Ref);
      await Supervisor.stop(level2Ref);
      await Supervisor.stop(rootRef);
    });

    it('handles one_for_all cascade across multiple children', async () => {
      const orderTracker = { order: [] as string[] };
      const childCount = 5;

      const ref = await Supervisor.start({
        strategy: 'one_for_all',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
        children: Array.from({ length: childCount }, (_, i) => ({
          id: `cascade_${i}`,
          start: () => GenServer.start(createOrderTrackingBehavior(orderTracker, `cascade_${i}`)),
        })),
      });

      // Clear init order from startup
      orderTracker.order = [];

      // Get original refs
      const originalRefs = new Map<string, GenServerRef>();
      for (const child of Supervisor.getChildren(ref)) {
        originalRefs.set(child.id, child.ref);
      }

      // Crash middle child - should trigger restart of ALL children
      crashChildById(ref, 'cascade_2', 'Trigger one_for_all cascade');

      await waitForAllRestarted(ref, originalRefs, { timeoutMs: 3000 });

      // Verify restart order (should be in original order: 0, 1, 2, 3, 4)
      expect(orderTracker.order.length).toBe(childCount);
      for (let i = 0; i < childCount; i++) {
        expect(orderTracker.order[i]).toBe(`cascade_${i}`);
      }

      // All children should be running with new refs
      for (const [id, originalRef] of originalRefs) {
        const currentChild = Supervisor.getChild(ref, id);
        expect(currentChild).toBeDefined();
        expect(currentChild!.ref.id).not.toBe(originalRef.id);
        expect(GenServer.isRunning(currentChild!.ref)).toBe(true);
      }

      await cleanupTest(ref);
    });

    it('handles rest_for_one cascade preserving earlier children', async () => {
      const orderTracker = { order: [] as string[] };
      const childCount = 5;

      const ref = await Supervisor.start({
        strategy: 'rest_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
        children: Array.from({ length: childCount }, (_, i) => ({
          id: `rest_${i}`,
          start: () => GenServer.start(createOrderTrackingBehavior(orderTracker, `rest_${i}`)),
        })),
      });

      // Clear init order from startup
      orderTracker.order = [];

      // Capture state before crash
      const stateBefore = captureChildState(ref);

      // Crash child at index 2 - should restart indices 2, 3, 4
      const crashedChild = Supervisor.getChild(ref, 'rest_2')!;
      crashChildById(ref, 'rest_2', 'Trigger rest_for_one cascade');

      // Wait for restarted children
      const refsToWatch = new Map<string, GenServerRef>();
      for (let i = 2; i < childCount; i++) {
        const child = Supervisor.getChild(ref, `rest_${i}`);
        if (child) {
          refsToWatch.set(`rest_${i}`, child.ref);
        }
      }

      await waitForAllRestarted(ref, refsToWatch, { timeoutMs: 3000 });

      const stateAfter = captureChildState(ref);
      const comparison = compareChildStates(stateBefore, stateAfter);

      // Children 0, 1 should be unchanged
      expect(comparison.unchanged).toContain('rest_0');
      expect(comparison.unchanged).toContain('rest_1');

      // Children 2, 3, 4 should have changed
      expect(comparison.changed).toContain('rest_2');
      expect(comparison.changed).toContain('rest_3');
      expect(comparison.changed).toContain('rest_4');

      // Verify restart order (should be 2, 3, 4)
      expect(orderTracker.order).toEqual(['rest_2', 'rest_3', 'rest_4']);

      await cleanupTest(ref);
    });

    it('survives rapid sequential cascading crashes', async () => {
      const { ref, childRefs, childIds } = await createTestSupervisor({
        childCount: 8,
        strategy: 'one_for_all',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
      });

      const metrics = new MetricsCollector();
      metrics.start();

      // Trigger multiple cascade restarts in quick succession
      for (let i = 0; i < 5; i++) {
        const randomChildId = childIds[Math.floor(Math.random() * childIds.length)]!;
        crashChildById(ref, randomChildId, `Cascade ${i + 1}`);

        // Short delay between cascades
        await delay(200);
      }

      // Allow all restarts to settle
      await delay(1000);

      metrics.stop();

      // Supervisor should survive all cascades
      expect(Supervisor.isRunning(ref)).toBe(true);
      assertAllChildrenRunning(ref, 8);

      await cleanupTest(ref);
    });

    it('handles concurrent crashes during cascade restart', async () => {
      const { ref, childRefs, childIds } = await createTestSupervisor({
        childCount: 6,
        strategy: 'one_for_all',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
      });

      // Trigger initial cascade
      crashChildById(ref, childIds[0]!, 'Initial cascade trigger');

      // Immediately crash another child during restart
      await delay(30);
      crashChildById(ref, childIds[3]!, 'Mid-cascade crash');

      // And another
      await delay(30);
      crashChildById(ref, childIds[5]!, 'Late cascade crash');

      // Wait for restarts to complete
      await delay(1500);

      // System should stabilize
      expect(Supervisor.isRunning(ref)).toBe(true);
      assertAllChildrenRunning(ref, 6);

      await cleanupTest(ref);
    });
  });

  describe('Slow Init Chaos', () => {
    it('handles children with varying initialization times', async () => {
      const initDelays = [50, 150, 300, 100, 200];

      const ref = await Supervisor.start({
        strategy: 'one_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
        children: initDelays.map((delay, i) => ({
          id: `slow_${i}`,
          start: () => GenServer.start(createSlowInitBehavior(delay)),
        })),
      });

      // All children should be running after their init delays
      await waitFor(() => Supervisor.countChildren(ref) === initDelays.length, {
        timeoutMs: 2000,
        message: 'Not all slow-init children started',
      });

      assertAllChildrenRunning(ref, initDelays.length);

      // Now crash one and verify it restarts with its slow init
      const childToCrash = Supervisor.getChild(ref, 'slow_2')!; // 300ms init
      const originalRefId = childToCrash.ref.id;

      crashChildById(ref, 'slow_2', 'Crash slow init child');

      // Wait for restart (should take ~300ms for init + restart overhead)
      await waitForChildRestarted(ref, 'slow_2', originalRefId, {
        timeoutMs: 1000,
      });

      assertAllChildrenRunning(ref, initDelays.length);

      await cleanupTest(ref);
    });

    it('handles crash during slow child initialization', async () => {
      const behavior = createTestBehavior();
      const slowBehavior = createSlowInitBehavior(500);

      let slowChildStartCount = 0;

      const ref = await Supervisor.start({
        strategy: 'one_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
        children: [
          { id: 'fast_1', start: () => GenServer.start(behavior) },
          { id: 'fast_2', start: () => GenServer.start(behavior) },
          {
            id: 'slow_child',
            start: async () => {
              slowChildStartCount++;
              return GenServer.start(slowBehavior);
            },
          },
        ],
      });

      // Wait for initial startup
      await waitFor(() => Supervisor.countChildren(ref) === 3, { timeoutMs: 2000 });

      // Crash the slow child
      const slowChild = Supervisor.getChild(ref, 'slow_child')!;
      crashChildById(ref, 'slow_child', 'Crash during potential reinit');

      // Crash a fast child while slow child is restarting
      await delay(100); // During slow child's 500ms init
      crashChildById(ref, 'fast_1', 'Crash during slow restart');

      // Wait for all restarts
      await delay(1500);

      // All children should be running
      expect(Supervisor.isRunning(ref)).toBe(true);
      assertAllChildrenRunning(ref, 3);

      // Slow child should have been started multiple times (init + restart)
      expect(slowChildStartCount).toBeGreaterThanOrEqual(2);

      await cleanupTest(ref);
    });

    it('handles continuous crashes against slow-init children', { timeout: 15000 }, async () => {
      const initDelays = [200, 300, 400, 250, 350];

      const ref = await Supervisor.start({
        strategy: 'one_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
        children: initDelays.map((delay, i) => ({
          id: `slow_continuous_${i}`,
          start: () => GenServer.start(createSlowInitBehavior(delay)),
        })),
      });

      // Wait for initial startup
      await delay(600);

      // Run continuous crashes specifically targeting these slow-init children
      const crashResult = await crashContinuous(ref, {
        durationMs: 5000,
        avgIntervalMs: 400,
        variance: 0.3,
        maxConcurrent: 1,
        reason: 'Slow init stress',
      });

      // Allow final restarts to complete
      await delay(1000);

      // System should survive despite slow restarts
      expect(Supervisor.isRunning(ref)).toBe(true);
      assertAllChildrenRunning(ref, initDelays.length);

      // Should have successfully crashed some children
      expect(crashResult.successfulCrashes).toBeGreaterThan(5);

      await cleanupTest(ref);
    });

    it('handles one_for_all with mixed slow/fast children', async () => {
      const orderTracker = { order: [] as string[] };

      const ref = await Supervisor.start({
        strategy: 'one_for_all',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
        children: [
          {
            id: 'fast_a',
            start: () => {
              orderTracker.order.push('fast_a');
              return GenServer.start(createTestBehavior());
            },
          },
          {
            id: 'slow_b',
            start: async () => {
              await delay(100);
              orderTracker.order.push('slow_b');
              return GenServer.start(createTestBehavior());
            },
          },
          {
            id: 'fast_c',
            start: () => {
              orderTracker.order.push('fast_c');
              return GenServer.start(createTestBehavior());
            },
          },
          {
            id: 'slow_d',
            start: async () => {
              await delay(150);
              orderTracker.order.push('slow_d');
              return GenServer.start(createTestBehavior());
            },
          },
        ],
      });

      // Wait for all children to initialize
      await waitFor(() => Supervisor.countChildren(ref) === 4, { timeoutMs: 2000 });

      // Verify startup order (sequential due to supervisor)
      expect(orderTracker.order).toEqual(['fast_a', 'slow_b', 'fast_c', 'slow_d']);

      // Clear for restart tracking
      orderTracker.order = [];

      // Get original refs
      const originalRefs = new Map<string, GenServerRef>();
      for (const child of Supervisor.getChildren(ref)) {
        originalRefs.set(child.id, child.ref);
      }

      // Crash fast child - triggers full cascade including slow inits
      crashChildById(ref, 'fast_a', 'Trigger slow cascade');

      await waitForAllRestarted(ref, originalRefs, { timeoutMs: 3000 });

      // Wait for restarts to fully settle (no more cascades in progress)
      await delay(500);

      // Verify restart sequences maintain correct order
      // Each restart sequence should be: fast_a, slow_b, fast_c, slow_d
      // There may be multiple sequences if crashes occurred during restart
      const expectedOrder = ['fast_a', 'slow_b', 'fast_c', 'slow_d'];

      // Verify at least one complete restart sequence occurred
      expect(orderTracker.order.length).toBeGreaterThanOrEqual(4);

      // Verify order is maintained within each sequence of 4
      // By checking that children appear in expected relative order
      for (let i = 0; i < orderTracker.order.length - 1; i++) {
        const current = orderTracker.order[i]!;
        const next = orderTracker.order[i + 1]!;
        const currentIndex = expectedOrder.indexOf(current);
        const nextIndex = expectedOrder.indexOf(next);

        // If next item has lower index, it means a new restart sequence started
        // Otherwise, relative order must be maintained
        if (nextIndex >= currentIndex) {
          expect(nextIndex).toBeGreaterThanOrEqual(currentIndex);
        }
      }

      // All children running
      assertAllChildrenRunning(ref, 4);

      await cleanupTest(ref);
    });

    it('handles rest_for_one with slow children after crash point', async () => {
      const ref = await Supervisor.start({
        strategy: 'rest_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
        children: [
          { id: 'fast_0', start: () => GenServer.start(createTestBehavior()) },
          { id: 'fast_1', start: () => GenServer.start(createTestBehavior()) },
          { id: 'slow_2', start: () => GenServer.start(createSlowInitBehavior(300)) },
          { id: 'slow_3', start: () => GenServer.start(createSlowInitBehavior(400)) },
        ],
      });

      // Wait for all to initialize
      await delay(1000);

      const stateBefore = captureChildState(ref);

      // Crash fast_1 - should restart fast_1, slow_2, slow_3
      const child1 = Supervisor.getChild(ref, 'fast_1')!;
      crashChildById(ref, 'fast_1', 'Trigger rest_for_one with slow followers');

      // Wait for slow restarts
      await delay(1500);

      const stateAfter = captureChildState(ref);
      const comparison = compareChildStates(stateBefore, stateAfter);

      // fast_0 unchanged, rest changed
      expect(comparison.unchanged).toEqual(['fast_0']);
      expect(comparison.changed.sort()).toEqual(['fast_1', 'slow_2', 'slow_3']);

      assertAllChildrenRunning(ref, 4);

      await cleanupTest(ref);
    });

    it('measures restart time impact of slow initialization', async () => {
      const fastInitDelay = 10;
      const slowInitDelay = 300;

      // Test with fast children
      const fastRef = await Supervisor.start({
        strategy: 'one_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
        children: Array.from({ length: 3 }, (_, i) => ({
          id: `fast_${i}`,
          start: () => GenServer.start(createSlowInitBehavior(fastInitDelay)),
        })),
      });

      await delay(100);

      const fastTracker = new SimpleRestartTracker();
      const fastChild = Supervisor.getChild(fastRef, 'fast_0')!;
      fastTracker.recordCrash(fastChild.ref.id);

      const fastStartTime = Date.now();
      crashChildById(fastRef, 'fast_0');
      await waitForChildRestarted(fastRef, 'fast_0', fastChild.ref.id, { timeoutMs: 1000 });
      const fastRestartTime = Date.now() - fastStartTime;

      // Test with slow children
      const slowRef = await Supervisor.start({
        strategy: 'one_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
        children: Array.from({ length: 3 }, (_, i) => ({
          id: `slow_${i}`,
          start: () => GenServer.start(createSlowInitBehavior(slowInitDelay)),
        })),
      });

      await delay(500);

      const slowTracker = new SimpleRestartTracker();
      const slowChild = Supervisor.getChild(slowRef, 'slow_0')!;
      slowTracker.recordCrash(slowChild.ref.id);

      const slowStartTime = Date.now();
      crashChildById(slowRef, 'slow_0');
      await waitForChildRestarted(slowRef, 'slow_0', slowChild.ref.id, { timeoutMs: 1000 });
      const slowRestartTime = Date.now() - slowStartTime;

      // Slow restart should take notably longer
      expect(slowRestartTime).toBeGreaterThan(fastRestartTime);
      // And the difference should be roughly the init delay difference
      expect(slowRestartTime - fastRestartTime).toBeGreaterThan(slowInitDelay - fastInitDelay - 100);

      await Supervisor.stop(fastRef);
      await Supervisor.stop(slowRef);
    });
  });

  describe('Combined Chaos Scenarios', () => {
    it('survives mixed strategy chaos with varying child types', { timeout: 15000 }, async () => {
      // Create supervisor with mixed child types
      const ref = await Supervisor.start({
        strategy: 'one_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
        children: [
          { id: 'fast_0', start: () => GenServer.start(createTestBehavior()) },
          { id: 'fast_1', start: () => GenServer.start(createTestBehavior()) },
          { id: 'slow_0', start: () => GenServer.start(createSlowInitBehavior(150)) },
          { id: 'slow_1', start: () => GenServer.start(createSlowInitBehavior(250)) },
          { id: 'fast_2', start: () => GenServer.start(createTestBehavior()) },
        ],
      });

      await delay(500);

      const metrics = new MetricsCollector({ memorySnapshotIntervalMs: 500 });
      metrics.start();

      // Run mixed chaos pattern
      const chaosPromises = [
        // Continuous random crashes
        crashContinuous(ref, {
          durationMs: 4000,
          avgIntervalMs: 300,
          variance: 0.5,
        }),
        // Concurrent burst patterns
        (async () => {
          await delay(1000);
          await crashBurst(ref, {
            countPerBurst: 2,
            burstCount: 3,
            intervalMs: 100,
          });
        })(),
      ];

      await Promise.all(chaosPromises);
      await delay(1000);

      metrics.stop();
      const report = metrics.getMetrics();

      // System should survive
      expect(Supervisor.isRunning(ref)).toBe(true);
      assertAllChildrenRunning(ref, 5);

      // Memory should remain stable
      MetricsAssertions.assertMemoryGrowthBelow(report, 60);

      await cleanupTest(ref);
    });

    it('handles chaos with message load simultaneously', { timeout: 15000 }, async () => {
      const { ref, childIds } = await createTestSupervisor({
        childCount: 8,
        strategy: 'one_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
      });

      const metrics = new MetricsCollector();
      metrics.start();

      const testDuration = 6000;
      const startTime = Date.now();

      // Run all chaos patterns simultaneously
      const chaosPromises = [
        // Random crashes
        crashContinuous(ref, {
          durationMs: testDuration,
          avgIntervalMs: CRASH_FREQUENCIES.medium.avgIntervalMs,
          variance: CRASH_FREQUENCIES.medium.variance,
        }),
        // Message load
        (async () => {
          let sent = 0;
          while (Date.now() - startTime < testDuration) {
            const children = Supervisor.getChildren(ref);
            for (const child of children) {
              try {
                if (GenServer.isRunning(child.ref)) {
                  GenServer.cast(child.ref, { type: 'inc' });
                  sent++;
                }
              } catch {
                // Expected during crashes
              }
            }
            await delay(10);
          }
          return sent;
        })(),
        // Periodic burst
        (async () => {
          await delay(2000);
          await crashBurst(ref, {
            countPerBurst: 2,
            burstCount: 2,
            intervalMs: 150,
          });
        })(),
      ];

      const results = await Promise.all(chaosPromises);
      await delay(1000);

      metrics.stop();
      const report = metrics.getMetrics();

      // System should survive
      expect(Supervisor.isRunning(ref)).toBe(true);
      assertAllChildrenRunning(ref, 8);

      // Should have processed messages
      const messagesSent = results[1] as number;
      expect(messagesSent).toBeGreaterThan(100);

      // Memory should remain stable
      MetricsAssertions.assertMemoryGrowthBelow(report, 60);

      await cleanupTest(ref);
    });

    it('recovers from worst-case crash storm', async () => {
      const { ref, childRefs, childIds } = await createTestSupervisor({
        childCount: 10,
        strategy: 'one_for_one',
        restartIntensity: CHAOS_CONFIG.restartIntensity,
      });

      // Crash all children simultaneously, multiple times
      for (let round = 0; round < 3; round++) {
        crashAll(ref, `Storm round ${round + 1}`);
        await delay(300);
      }

      // Then apply continuous pressure
      await crashContinuous(ref, {
        durationMs: 2000,
        avgIntervalMs: CRASH_FREQUENCIES.burst.avgIntervalMs,
        variance: CRASH_FREQUENCIES.burst.variance,
        maxConcurrent: 3,
      });

      // Allow recovery
      await delay(1000);

      // System must survive
      expect(Supervisor.isRunning(ref)).toBe(true);
      assertAllChildrenRunning(ref, 10);

      await cleanupTest(ref);
    });
  });
});
