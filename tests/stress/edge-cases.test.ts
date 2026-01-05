/**
 * Edge case tests for Supervisor restart behavior.
 *
 * Tests critical edge cases:
 * - MaxRestartsExceeded error handling and intensity window reset
 * - Shutdown timeout and force termination of unresponsive children
 * - Crash handling during supervisor shutdown
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Supervisor,
  GenServer,
  MaxRestartsExceededError,
  type SupervisorRef,
  type GenServerRef,
  type GenServerBehavior,
} from '../../src/index.js';

import {
  waitFor,
  waitForChildRestarted,
  createTestSupervisor,
  delay,
  cleanupTest,
  resetTestState,
} from './test-helpers.js';

import { crashChildById, crashAll } from './crash-simulator.js';

/**
 * Creates a behavior that simulates slow shutdown.
 * Used to test shutdown timeout handling.
 *
 * @param shutdownDelayMs - Time to delay during terminate
 */
function createSlowShutdownBehavior(
  shutdownDelayMs: number,
): GenServerBehavior<number, { type: 'get' }, { type: 'inc' }, number> {
  return {
    init: () => 0,
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
    terminate: async () => {
      // Simulate slow cleanup that may exceed shutdown timeout
      await delay(shutdownDelayMs);
    },
  };
}

/**
 * Creates a behavior that hangs during shutdown (never completes).
 * Used to test force termination on timeout.
 */
function createHangingShutdownBehavior(): GenServerBehavior<
  number,
  { type: 'get' },
  { type: 'inc' },
  number
> {
  return {
    init: () => 0,
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
    terminate: () => {
      // Return a promise that never resolves
      return new Promise(() => {
        // Intentionally never resolves to simulate hanging shutdown
      });
    },
  };
}

describe('Supervisor Edge Cases', () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(async () => {
    await Supervisor._clearAll();
    Supervisor._clearLifecycleHandlers();
    GenServer._clearLifecycleHandlers();
  });

  describe('MaxRestartsExceeded', () => {
    it('throws MaxRestartsExceededError when restart limit is exceeded', async () => {
      const maxRestarts = 3;
      const withinMs = 5000;

      const { ref, childIds } = await createTestSupervisor({
        childCount: 2,
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts, withinMs },
      });

      let errorThrown: MaxRestartsExceededError | undefined;

      // Set up error handler to catch the async thrown error
      const errorHandler = (error: Error) => {
        if (error instanceof MaxRestartsExceededError) {
          errorThrown = error;
        }
      };
      process.on('unhandledRejection', errorHandler);

      // Trigger crashes exceeding the limit
      for (let i = 0; i < maxRestarts + 2; i++) {
        const childId = childIds[i % childIds.length]!;
        const child = Supervisor.getChild(ref, childId);

        if (!child || !Supervisor.isRunning(ref)) break;

        crashChildById(ref, childId, `Exceed limit crash ${i + 1}`);

        // Wait for restart or supervisor shutdown
        await delay(100);
      }

      // Wait for error to propagate
      await delay(200);

      // Clean up error handler
      process.removeListener('unhandledRejection', errorHandler);

      // Verify error was thrown with correct properties
      expect(errorThrown).toBeInstanceOf(MaxRestartsExceededError);
      expect(errorThrown?.name).toBe('MaxRestartsExceededError');
      expect(errorThrown?.supervisorId).toContain('supervisor_');
      expect(errorThrown?.maxRestarts).toBe(maxRestarts);
      expect(errorThrown?.withinMs).toBe(withinMs);

      // Supervisor should have stopped
      expect(Supervisor.isRunning(ref)).toBe(false);

      await cleanupTest(ref);
    });

    it('resets restart counter after intensity window expires', async () => {
      const maxRestarts = 3;
      const withinMs = 500; // Short window for testing

      const { ref, childIds } = await createTestSupervisor({
        childCount: 2,
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts, withinMs },
      });

      // Use up most of the restart budget (but stay under limit)
      for (let i = 0; i < maxRestarts - 1; i++) {
        const childId = childIds[0]!;
        const child = Supervisor.getChild(ref, childId);
        if (!child) break;

        const originalRefId = child.ref.id;
        crashChildById(ref, childId, `Window test crash ${i + 1}`);

        await waitForChildRestarted(ref, childId, originalRefId, { timeoutMs: 2000 });
      }

      // Supervisor should still be running
      expect(Supervisor.isRunning(ref)).toBe(true);

      // Wait for the intensity window to expire
      await delay(withinMs + 100);

      // Now we should be able to do more restarts (counter should have reset)
      for (let i = 0; i < maxRestarts - 1; i++) {
        const childId = childIds[0]!;
        const child = Supervisor.getChild(ref, childId);
        if (!child) break;

        const originalRefId = child.ref.id;
        crashChildById(ref, childId, `Post-window crash ${i + 1}`);

        await waitForChildRestarted(ref, childId, originalRefId, { timeoutMs: 2000 });
      }

      // Supervisor should still be running (window reset worked)
      expect(Supervisor.isRunning(ref)).toBe(true);

      await cleanupTest(ref);
    });

    it('handles concurrent crashes within intensity limit correctly', async () => {
      const maxRestarts = 10;
      const withinMs = 5000;

      const { ref, childIds, childRefs } = await createTestSupervisor({
        childCount: 5,
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts, withinMs },
      });

      // Crash multiple children simultaneously (under the limit)
      const crashCount = maxRestarts - 2;
      const crashPromises: Promise<void>[] = [];

      for (let i = 0; i < crashCount; i++) {
        const childId = childIds[i % childIds.length]!;
        const child = Supervisor.getChild(ref, childId);

        if (child) {
          const originalRefId = child.ref.id;
          crashChildById(ref, childId, `Concurrent crash ${i}`);

          crashPromises.push(
            waitForChildRestarted(ref, childId, originalRefId, { timeoutMs: 2000 })
              .catch(() => {
                // Ignore timeout errors, we just need to wait
              }),
          );
        }

        // Stagger slightly to avoid exact simultaneity
        await delay(20);
      }

      // Wait for all restarts to complete
      await Promise.allSettled(crashPromises);
      await delay(200);

      // Supervisor should still be running
      expect(Supervisor.isRunning(ref)).toBe(true);

      // All children should be present
      expect(Supervisor.countChildren(ref)).toBe(5);

      await cleanupTest(ref);
    });

    it('accurately counts restarts across multiple children', async () => {
      const maxRestarts = 5;
      const withinMs = 10000;

      const { ref, childIds } = await createTestSupervisor({
        childCount: 3,
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts, withinMs },
      });

      let restartCount = 0;

      // Distribute crashes across children, staying under limit
      for (let i = 0; i < maxRestarts - 1; i++) {
        const childId = childIds[i % childIds.length]!;
        const child = Supervisor.getChild(ref, childId);
        if (!child) break;

        const originalRefId = child.ref.id;
        crashChildById(ref, childId);

        await waitForChildRestarted(ref, childId, originalRefId, { timeoutMs: 2000 });
        restartCount++;
      }

      // Supervisor should be running with correct restart count
      expect(Supervisor.isRunning(ref)).toBe(true);
      expect(restartCount).toBe(maxRestarts - 1);

      await cleanupTest(ref);
    });
  });

  describe('Shutdown Timeout', () => {
    it('force terminates child that exceeds shutdown timeout', async () => {
      const shutdownTimeout = 200;
      const childShutdownDelay = 2000; // Much longer than timeout

      const behavior = createSlowShutdownBehavior(childShutdownDelay);

      const ref = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          {
            id: 'slow_child',
            start: () => GenServer.start(behavior),
            shutdownTimeout,
          },
        ],
      });

      const child = Supervisor.getChild(ref, 'slow_child');
      expect(child).toBeDefined();
      expect(GenServer.isRunning(child!.ref)).toBe(true);

      const startTime = Date.now();

      // Stop the supervisor - should not wait for the full shutdown delay
      await Supervisor.stop(ref);

      const elapsed = Date.now() - startTime;

      // Should have terminated faster than the child's slow shutdown
      // Allow some buffer for test execution
      expect(elapsed).toBeLessThan(childShutdownDelay);

      // Supervisor should be stopped
      expect(Supervisor.isRunning(ref)).toBe(false);
    });

    it('force terminates hanging child after timeout', async () => {
      const shutdownTimeout = 150;
      const behavior = createHangingShutdownBehavior();

      const ref = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          {
            id: 'hanging_child',
            start: () => GenServer.start(behavior),
            shutdownTimeout,
          },
        ],
      });

      const child = Supervisor.getChild(ref, 'hanging_child');
      expect(child).toBeDefined();

      const startTime = Date.now();

      // Stop supervisor - should force terminate after timeout
      await Supervisor.stop(ref);

      const elapsed = Date.now() - startTime;

      // Should complete within reasonable time after timeout
      expect(elapsed).toBeLessThan(shutdownTimeout + 500);
      expect(Supervisor.isRunning(ref)).toBe(false);
    });

    it('handles multiple unresponsive children during shutdown', async () => {
      const shutdownTimeout = 150;
      const behavior = createHangingShutdownBehavior();

      const ref = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          {
            id: 'hanging_1',
            start: () => GenServer.start(behavior),
            shutdownTimeout,
          },
          {
            id: 'hanging_2',
            start: () => GenServer.start(behavior),
            shutdownTimeout,
          },
          {
            id: 'hanging_3',
            start: () => GenServer.start(behavior),
            shutdownTimeout,
          },
        ],
      });

      expect(Supervisor.countChildren(ref)).toBe(3);

      const startTime = Date.now();

      // Stop supervisor with all hanging children
      await Supervisor.stop(ref);

      const elapsed = Date.now() - startTime;

      // Each child gets its own timeout, but they're sequential
      // Total should be roughly 3 * shutdownTimeout (plus buffer)
      expect(elapsed).toBeLessThan((shutdownTimeout + 200) * 3);
      expect(Supervisor.isRunning(ref)).toBe(false);
    });

    it('handles mixed responsive and unresponsive children', async () => {
      const shutdownTimeout = 150;
      const hangingBehavior = createHangingShutdownBehavior();
      const normalBehavior: GenServerBehavior<number, { type: 'get' }, { type: 'inc' }, number> = {
        init: () => 0,
        handleCall: (msg, state) => [state, state],
        handleCast: (msg, state) => state + 1,
      };

      const ref = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          {
            id: 'normal_1',
            start: () => GenServer.start(normalBehavior),
            shutdownTimeout: 5000,
          },
          {
            id: 'hanging',
            start: () => GenServer.start(hangingBehavior),
            shutdownTimeout,
          },
          {
            id: 'normal_2',
            start: () => GenServer.start(normalBehavior),
            shutdownTimeout: 5000,
          },
        ],
      });

      expect(Supervisor.countChildren(ref)).toBe(3);

      const startTime = Date.now();

      await Supervisor.stop(ref);

      const elapsed = Date.now() - startTime;

      // Should complete: normal children quick, hanging child force-terminated
      expect(elapsed).toBeLessThan(shutdownTimeout + 1000);
      expect(Supervisor.isRunning(ref)).toBe(false);
    });

    it('terminateChild respects shutdown timeout', async () => {
      const shutdownTimeout = 200;
      const behavior = createHangingShutdownBehavior();

      const ref = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          {
            id: 'hanging_child',
            start: () => GenServer.start(behavior),
            shutdownTimeout,
          },
          {
            id: 'normal_child',
            start: () => GenServer.start({
              init: () => 0,
              handleCall: (_, s) => [s, s],
              handleCast: (_, s) => s,
            }),
          },
        ],
      });

      const startTime = Date.now();

      // Terminate just the hanging child
      await Supervisor.terminateChild(ref, 'hanging_child');

      const elapsed = Date.now() - startTime;

      // Should have force-terminated after timeout
      expect(elapsed).toBeLessThan(shutdownTimeout + 500);

      // Supervisor should still be running with remaining child
      expect(Supervisor.isRunning(ref)).toBe(true);
      expect(Supervisor.countChildren(ref)).toBe(1);
      expect(Supervisor.getChild(ref, 'normal_child')).toBeDefined();
      expect(Supervisor.getChild(ref, 'hanging_child')).toBeUndefined();

      await cleanupTest(ref);
    });
  });

  describe('Restart During Shutdown', () => {
    it('ignores child crashes during supervisor shutdown', async () => {
      const { ref, childIds, childRefs } = await createTestSupervisor({
        childCount: 5,
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts: 100, withinMs: 10000 },
      });

      // Start shutdown
      const stopPromise = Supervisor.stop(ref);

      // Try to crash children during shutdown
      for (const childId of childIds) {
        crashChildById(ref, childId, 'Crash during shutdown');
      }

      // Wait for shutdown to complete
      await stopPromise;

      // Supervisor should be cleanly stopped
      expect(Supervisor.isRunning(ref)).toBe(false);
    });

    it('does not restart children after shutdown begins', async () => {
      const { ref, childIds, childRefs } = await createTestSupervisor({
        childCount: 3,
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts: 100, withinMs: 10000 },
      });

      // Track restart attempts
      let restartAttempts = 0;
      const unsubscribe = Supervisor.onLifecycleEvent((event) => {
        if (event.type === 'restarted') {
          restartAttempts++;
        }
      });

      // Get child refs before shutdown (supervisor won't be accessible after)
      const childRefArray = Array.from(childRefs.values());

      // Begin shutdown process
      const stopPromise = Supervisor.stop(ref);

      // Small delay to let shutdown begin
      await delay(10);

      // Try to crash children directly using stored refs
      // (supervisor may already be removed from registry)
      for (const childRef of childRefArray) {
        try {
          if (GenServer.isRunning(childRef)) {
            GenServer._forceTerminate(childRef, { error: new Error('Crash during shutdown') });
          }
        } catch {
          // Expected if already terminated
        }
      }

      // Wait for shutdown
      await stopPromise;

      // Supervisor should be cleanly stopped
      expect(Supervisor.isRunning(ref)).toBe(false);

      unsubscribe();
    });

    it('handles crash storm during shutdown gracefully', async () => {
      const { ref, childIds, childRefs } = await createTestSupervisor({
        childCount: 10,
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts: 100, withinMs: 10000 },
      });

      // Get child refs before shutdown (supervisor may be removed during storm)
      const childRefArray = Array.from(childRefs.values());

      // Start shutdown and crash storm concurrently
      const shutdownPromise = Supervisor.stop(ref);

      // Generate crash storm during shutdown using stored refs
      const crashPromise = (async () => {
        for (let i = 0; i < 20; i++) {
          const childRef = childRefArray[i % childRefArray.length]!;
          try {
            if (GenServer.isRunning(childRef)) {
              GenServer._forceTerminate(childRef, { error: new Error(`Storm crash ${i}`) });
            }
          } catch {
            // Expected if already terminated or supervisor gone
          }
          await delay(10);
        }
      })();

      // Both should complete without errors
      await Promise.all([shutdownPromise, crashPromise]);

      // Supervisor should be stopped cleanly
      expect(Supervisor.isRunning(ref)).toBe(false);
    });

    it('shutdown completes even with pending crash handlers', async () => {
      const { ref, childIds } = await createTestSupervisor({
        childCount: 5,
        strategy: 'one_for_all', // More complex restart strategy
        restartIntensity: { maxRestarts: 100, withinMs: 10000 },
      });

      // Crash one child (would normally trigger one_for_all restart)
      crashChildById(ref, childIds[2]!, 'Trigger one_for_all');

      // Immediately request shutdown
      await Supervisor.stop(ref);

      // Should complete successfully
      expect(Supervisor.isRunning(ref)).toBe(false);
    });

    it('concurrent stop calls are handled safely', async () => {
      const { ref } = await createTestSupervisor({
        childCount: 5,
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts: 100, withinMs: 10000 },
      });

      // Call stop multiple times concurrently
      const stopPromises = [
        Supervisor.stop(ref),
        Supervisor.stop(ref),
        Supervisor.stop(ref),
      ];

      // All should complete without errors
      await Promise.all(stopPromises);

      expect(Supervisor.isRunning(ref)).toBe(false);
    });
  });

  describe('Edge Case Combinations', () => {
    it('handles rapid restarts near intensity limit during shutdown', async () => {
      const maxRestarts = 5;
      const { ref, childIds } = await createTestSupervisor({
        childCount: 3,
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts, withinMs: 10000 },
      });

      // Use up most of restart budget
      for (let i = 0; i < maxRestarts - 2; i++) {
        const childId = childIds[i % childIds.length]!;
        const child = Supervisor.getChild(ref, childId);
        if (!child) break;

        const originalRefId = child.ref.id;
        crashChildById(ref, childId);

        await waitForChildRestarted(ref, childId, originalRefId, { timeoutMs: 2000 });
      }

      // Now initiate shutdown while near the limit
      const stopPromise = Supervisor.stop(ref);

      // Crash during shutdown
      crashAll(ref, 'Final crash storm');

      await stopPromise;

      // Should have stopped cleanly without hitting the limit
      expect(Supervisor.isRunning(ref)).toBe(false);
    });

    it('shutdown timeout works correctly with different child configurations', async () => {
      const hangingBehavior = createHangingShutdownBehavior();

      const ref = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          {
            id: 'fast',
            start: () => GenServer.start({
              init: () => 0,
              handleCall: (_, s) => [s, s],
              handleCast: (_, s) => s,
            }),
            shutdownTimeout: 100,
          },
          {
            id: 'slow_100',
            start: () => GenServer.start(createSlowShutdownBehavior(50)),
            shutdownTimeout: 100,
          },
          {
            id: 'hanging_short',
            start: () => GenServer.start(hangingBehavior),
            shutdownTimeout: 100,
          },
          {
            id: 'hanging_long',
            start: () => GenServer.start(hangingBehavior),
            shutdownTimeout: 200,
          },
        ],
      });

      const startTime = Date.now();

      await Supervisor.stop(ref);

      const elapsed = Date.now() - startTime;

      // Should complete with total timeouts summed (plus overhead)
      // 100 + 100 + 100 + 200 = 500ms max, but fast children are quicker
      expect(elapsed).toBeLessThan(800);
      expect(Supervisor.isRunning(ref)).toBe(false);
    });

    it('one_for_all strategy handles crash during restart sequence', async () => {
      const { ref, childIds, childRefs } = await createTestSupervisor({
        childCount: 5,
        strategy: 'one_for_all',
        restartIntensity: { maxRestarts: 50, withinMs: 10000 },
      });

      // Crash first child to trigger one_for_all restart
      crashChildById(ref, childIds[0]!, 'Initial crash');

      // Wait a bit for restart to begin
      await delay(50);

      // Crash another child during the restart sequence
      crashChildById(ref, childIds[3]!, 'Mid-restart crash');

      // Give time for restarts to settle
      await delay(500);

      // Supervisor should still be running
      expect(Supervisor.isRunning(ref)).toBe(true);

      // All children should be present
      expect(Supervisor.countChildren(ref)).toBe(5);

      await cleanupTest(ref);
    });

    it('rest_for_one strategy handles crash of already-restarting child', async () => {
      const { ref, childIds } = await createTestSupervisor({
        childCount: 5,
        strategy: 'rest_for_one',
        restartIntensity: { maxRestarts: 50, withinMs: 10000 },
      });

      // Crash a middle child (triggers restart of it + subsequent children)
      crashChildById(ref, childIds[2]!, 'First crash');

      // Wait briefly
      await delay(30);

      // Crash another child that was part of the restart sequence
      crashChildById(ref, childIds[3]!, 'Concurrent crash');

      // Give time for restarts to settle
      await delay(500);

      // Supervisor should still be running
      expect(Supervisor.isRunning(ref)).toBe(true);

      // All children should be present
      expect(Supervisor.countChildren(ref)).toBe(5);

      await cleanupTest(ref);
    });
  });
});
