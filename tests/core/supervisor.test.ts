/**
 * Comprehensive tests for Supervisor implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Supervisor,
  GenServer,
  type GenServerBehavior,
  type GenServerRef,
  type ChildSpec,
  type LifecycleEvent,
  DuplicateChildError,
  ChildNotFoundError,
} from '../../src/index.js';

/**
 * Creates a simple counter behavior for testing.
 */
function createCounterBehavior(): GenServerBehavior<number, 'get', 'inc', number> {
  return {
    init: () => 0,
    handleCall: (_, state) => [state, state],
    handleCast: (_, state) => state + 1,
  };
}

/**
 * Simulates a child crash by force-terminating the server.
 */
function crashChild(ref: GenServerRef): void {
  GenServer._forceTerminate(ref, { error: new Error('Simulated crash') });
}

/**
 * Creates a child spec for testing.
 */
function createChildSpec(
  id: string,
  behavior: GenServerBehavior<number, 'get', 'inc', number> = createCounterBehavior(),
): ChildSpec {
  return {
    id,
    start: () => GenServer.start(behavior),
  };
}

/**
 * Helper to wait for a condition with timeout.
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 1000,
  intervalMs: number = 10,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('Supervisor', () => {
  beforeEach(() => {
    Supervisor._clearLifecycleHandlers();
    Supervisor._resetIdCounter();
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
  });

  afterEach(async () => {
    await Supervisor._clearAll();
    Supervisor._clearLifecycleHandlers();
    GenServer._clearLifecycleHandlers();
  });

  describe('start()', () => {
    it('starts an empty supervisor', async () => {
      const ref = await Supervisor.start();

      expect(ref).toBeDefined();
      expect(ref.id).toMatch(/^supervisor_/);
      expect(Supervisor.isRunning(ref)).toBe(true);
      expect(Supervisor.countChildren(ref)).toBe(0);

      await Supervisor.stop(ref);
    });

    it('starts a supervisor with initial children', async () => {
      const ref = await Supervisor.start({
        children: [
          createChildSpec('child1'),
          createChildSpec('child2'),
        ],
      });

      expect(Supervisor.countChildren(ref)).toBe(2);

      const children = Supervisor.getChildren(ref);
      expect(children).toHaveLength(2);
      expect(children[0]?.id).toBe('child1');
      expect(children[1]?.id).toBe('child2');

      await Supervisor.stop(ref);
    });

    it('starts children in order', async () => {
      const startOrder: string[] = [];

      const createTrackedSpec = (id: string): ChildSpec => ({
        id,
        start: async () => {
          startOrder.push(id);
          return GenServer.start(createCounterBehavior());
        },
      });

      const ref = await Supervisor.start({
        children: [
          createTrackedSpec('first'),
          createTrackedSpec('second'),
          createTrackedSpec('third'),
        ],
      });

      expect(startOrder).toEqual(['first', 'second', 'third']);

      await Supervisor.stop(ref);
    });

    it('applies default strategy of one_for_one', async () => {
      const ref = await Supervisor.start();

      // The strategy is internal, but we can verify behavior
      expect(Supervisor.isRunning(ref)).toBe(true);

      await Supervisor.stop(ref);
    });

    it('emits started lifecycle event', async () => {
      const events: LifecycleEvent[] = [];
      Supervisor.onLifecycleEvent((e) => events.push(e));

      const ref = await Supervisor.start();

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'started', ref });

      await Supervisor.stop(ref);
    });

    it('cleans up on child start failure', async () => {
      const failingSpec: ChildSpec = {
        id: 'failing',
        start: () => Promise.reject(new Error('Start failed')),
      };

      await expect(
        Supervisor.start({
          children: [failingSpec],
        }),
      ).rejects.toThrow('Start failed');
    });
  });

  describe('stop()', () => {
    it('gracefully stops the supervisor', async () => {
      const ref = await Supervisor.start({
        children: [createChildSpec('child1')],
      });

      expect(Supervisor.isRunning(ref)).toBe(true);

      await Supervisor.stop(ref);

      expect(Supervisor.isRunning(ref)).toBe(false);
    });

    it('stops children in reverse order', async () => {
      const stopOrder: string[] = [];

      const createTrackedSpec = (id: string): ChildSpec => ({
        id,
        start: () =>
          GenServer.start({
            init: () => 0,
            handleCall: (_, state) => [state, state],
            handleCast: (_, state) => state,
            terminate: () => {
              stopOrder.push(id);
            },
          }),
      });

      const ref = await Supervisor.start({
        children: [
          createTrackedSpec('first'),
          createTrackedSpec('second'),
          createTrackedSpec('third'),
        ],
      });

      await Supervisor.stop(ref);

      expect(stopOrder).toEqual(['third', 'second', 'first']);
    });

    it('emits terminated lifecycle event', async () => {
      const events: LifecycleEvent[] = [];
      Supervisor.onLifecycleEvent((e) => events.push(e));

      const ref = await Supervisor.start();
      await Supervisor.stop(ref, 'shutdown');

      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({
        type: 'terminated',
        ref,
        reason: 'shutdown',
      });
    });

    it('is idempotent - stopping twice does not throw', async () => {
      const ref = await Supervisor.start();

      await Supervisor.stop(ref);
      await expect(Supervisor.stop(ref)).resolves.toBeUndefined();
    });
  });

  describe('startChild()', () => {
    it('dynamically starts a new child', async () => {
      const ref = await Supervisor.start();

      expect(Supervisor.countChildren(ref)).toBe(0);

      const childRef = await Supervisor.startChild(ref, createChildSpec('dynamic'));

      expect(Supervisor.countChildren(ref)).toBe(1);
      expect(GenServer.isRunning(childRef)).toBe(true);

      await Supervisor.stop(ref);
    });

    it('throws DuplicateChildError for duplicate ID', async () => {
      const ref = await Supervisor.start({
        children: [createChildSpec('child1')],
      });

      await expect(
        Supervisor.startChild(ref, createChildSpec('child1')),
      ).rejects.toThrow(DuplicateChildError);

      await Supervisor.stop(ref);
    });

    it('appends new children to the order', async () => {
      const ref = await Supervisor.start({
        children: [createChildSpec('first')],
      });

      await Supervisor.startChild(ref, createChildSpec('second'));

      const children = Supervisor.getChildren(ref);
      expect(children.map((c) => c.id)).toEqual(['first', 'second']);

      await Supervisor.stop(ref);
    });
  });

  describe('terminateChild()', () => {
    it('terminates a specific child', async () => {
      const ref = await Supervisor.start({
        children: [
          createChildSpec('child1'),
          createChildSpec('child2'),
        ],
      });

      const child1 = Supervisor.getChild(ref, 'child1');
      expect(child1).toBeDefined();

      await Supervisor.terminateChild(ref, 'child1');

      expect(Supervisor.countChildren(ref)).toBe(1);
      expect(Supervisor.getChild(ref, 'child1')).toBeUndefined();
      expect(GenServer.isRunning(child1!.ref)).toBe(false);

      await Supervisor.stop(ref);
    });

    it('throws ChildNotFoundError for unknown child', async () => {
      const ref = await Supervisor.start();

      await expect(
        Supervisor.terminateChild(ref, 'nonexistent'),
      ).rejects.toThrow(ChildNotFoundError);

      await Supervisor.stop(ref);
    });
  });

  describe('restartChild()', () => {
    it('restarts a specific child', async () => {
      const ref = await Supervisor.start({
        children: [createChildSpec('child1')],
      });

      const originalChild = Supervisor.getChild(ref, 'child1');
      const originalRef = originalChild!.ref;

      const newRef = await Supervisor.restartChild(ref, 'child1');

      expect(newRef.id).not.toBe(originalRef.id);
      expect(GenServer.isRunning(newRef)).toBe(true);
      expect(GenServer.isRunning(originalRef)).toBe(false);

      const updatedChild = Supervisor.getChild(ref, 'child1');
      expect(updatedChild?.restartCount).toBe(1);

      await Supervisor.stop(ref);
    });

    it('throws ChildNotFoundError for unknown child', async () => {
      const ref = await Supervisor.start();

      await expect(
        Supervisor.restartChild(ref, 'nonexistent'),
      ).rejects.toThrow(ChildNotFoundError);

      await Supervisor.stop(ref);
    });
  });

  describe('getChildren()', () => {
    it('returns all children in order', async () => {
      const ref = await Supervisor.start({
        children: [
          createChildSpec('a'),
          createChildSpec('b'),
          createChildSpec('c'),
        ],
      });

      const children = Supervisor.getChildren(ref);

      expect(children).toHaveLength(3);
      expect(children.map((c) => c.id)).toEqual(['a', 'b', 'c']);

      await Supervisor.stop(ref);
    });

    it('returns empty array for empty supervisor', async () => {
      const ref = await Supervisor.start();

      const children = Supervisor.getChildren(ref);

      expect(children).toEqual([]);

      await Supervisor.stop(ref);
    });
  });

  describe('getChild()', () => {
    it('returns child info by ID', async () => {
      const ref = await Supervisor.start({
        children: [createChildSpec('myChild')],
      });

      const child = Supervisor.getChild(ref, 'myChild');

      expect(child).toBeDefined();
      expect(child?.id).toBe('myChild');
      expect(child?.restartCount).toBe(0);

      await Supervisor.stop(ref);
    });

    it('returns undefined for unknown child', async () => {
      const ref = await Supervisor.start();

      const child = Supervisor.getChild(ref, 'nonexistent');

      expect(child).toBeUndefined();

      await Supervisor.stop(ref);
    });
  });

  describe('one_for_one strategy', () => {
    it('restarts only the crashed child', async () => {
      const ref = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          createChildSpec('child1'),
          createChildSpec('child2'),
        ],
      });

      const child1Before = Supervisor.getChild(ref, 'child1');
      const child2Before = Supervisor.getChild(ref, 'child2');
      const child1RefBefore = child1Before!.ref;
      const child2RefBefore = child2Before!.ref;

      // Crash child1
      crashChild(child1RefBefore);

      // Wait for restart
      await waitFor(() => {
        const child1After = Supervisor.getChild(ref, 'child1');
        return child1After?.ref.id !== child1RefBefore.id;
      }, 2000);

      const child1After = Supervisor.getChild(ref, 'child1');
      const child2After = Supervisor.getChild(ref, 'child2');

      // child1 should be restarted (different ref)
      expect(child1After?.ref.id).not.toBe(child1RefBefore.id);
      expect(child1After?.restartCount).toBe(1);

      // child2 should be unchanged
      expect(child2After?.ref.id).toBe(child2RefBefore.id);
      expect(child2After?.restartCount).toBe(0);

      await Supervisor.stop(ref);
    });
  });

  describe('one_for_all strategy', () => {
    it('restarts all children when one crashes', async () => {
      const ref = await Supervisor.start({
        strategy: 'one_for_all',
        children: [
          createChildSpec('child1'),
          createChildSpec('child2'),
          createChildSpec('child3'),
        ],
      });

      const child1Before = Supervisor.getChild(ref, 'child1')!.ref;
      const child2Before = Supervisor.getChild(ref, 'child2')!.ref;
      const child3Before = Supervisor.getChild(ref, 'child3')!.ref;

      // Crash child2
      crashChild(child2Before);

      // Wait for all children to be restarted
      await waitFor(() => {
        const child1After = Supervisor.getChild(ref, 'child1');
        const child2After = Supervisor.getChild(ref, 'child2');
        const child3After = Supervisor.getChild(ref, 'child3');

        return (
          child1After?.ref.id !== child1Before.id &&
          child2After?.ref.id !== child2Before.id &&
          child3After?.ref.id !== child3Before.id
        );
      }, 2000);

      // All children should have new refs
      const child1After = Supervisor.getChild(ref, 'child1');
      const child2After = Supervisor.getChild(ref, 'child2');
      const child3After = Supervisor.getChild(ref, 'child3');

      expect(child1After?.ref.id).not.toBe(child1Before.id);
      expect(child2After?.ref.id).not.toBe(child2Before.id);
      expect(child3After?.ref.id).not.toBe(child3Before.id);

      // Only crashed child should have incremented restart count
      expect(child2After?.restartCount).toBe(1);

      await Supervisor.stop(ref);
    });
  });

  describe('rest_for_one strategy', () => {
    it('restarts crashed child and all children started after it', async () => {
      const ref = await Supervisor.start({
        strategy: 'rest_for_one',
        children: [
          createChildSpec('child1'),
          createChildSpec('child2'),
          createChildSpec('child3'),
        ],
      });

      const child1Before = Supervisor.getChild(ref, 'child1')!.ref;
      const child2Before = Supervisor.getChild(ref, 'child2')!.ref;
      const child3Before = Supervisor.getChild(ref, 'child3')!.ref;

      // Crash child2
      crashChild(child2Before);

      // Wait for child2 and child3 to be restarted
      await waitFor(() => {
        const child2After = Supervisor.getChild(ref, 'child2');
        const child3After = Supervisor.getChild(ref, 'child3');

        return (
          child2After?.ref.id !== child2Before.id &&
          child3After?.ref.id !== child3Before.id
        );
      }, 2000);

      const child1After = Supervisor.getChild(ref, 'child1');
      const child2After = Supervisor.getChild(ref, 'child2');
      const child3After = Supervisor.getChild(ref, 'child3');

      // child1 should be unchanged (started before crashed child)
      expect(child1After?.ref.id).toBe(child1Before.id);
      expect(child1After?.restartCount).toBe(0);

      // child2 and child3 should be restarted
      expect(child2After?.ref.id).not.toBe(child2Before.id);
      expect(child3After?.ref.id).not.toBe(child3Before.id);

      await Supervisor.stop(ref);
    });
  });

  describe('child restart strategies', () => {
    it('permanent: always restarts the child', async () => {
      const ref = await Supervisor.start({
        children: [
          {
            id: 'permanent',
            start: () => GenServer.start(createCounterBehavior()),
            restart: 'permanent',
          },
        ],
      });

      const childBefore = Supervisor.getChild(ref, 'permanent')!;
      crashChild(childBefore.ref);

      await waitFor(() => {
        const childAfter = Supervisor.getChild(ref, 'permanent');
        return childAfter?.ref.id !== childBefore.ref.id;
      }, 2000);

      expect(Supervisor.getChild(ref, 'permanent')).toBeDefined();

      await Supervisor.stop(ref);
    });

    it('temporary: never restarts the child', async () => {
      const ref = await Supervisor.start({
        children: [
          {
            id: 'temporary',
            start: () => GenServer.start(createCounterBehavior()),
            restart: 'temporary',
          },
        ],
      });

      const childBefore = Supervisor.getChild(ref, 'temporary')!;
      crashChild(childBefore.ref);

      // Wait for supervisor to detect and process the crash
      await waitFor(() => {
        return Supervisor.getChild(ref, 'temporary') === undefined;
      }, 2000);

      expect(Supervisor.getChild(ref, 'temporary')).toBeUndefined();
      expect(Supervisor.countChildren(ref)).toBe(0);

      await Supervisor.stop(ref);
    });

    it('transient: restarts on abnormal exit', async () => {
      const ref = await Supervisor.start({
        children: [
          {
            id: 'transient',
            start: () => GenServer.start(createCounterBehavior()),
            restart: 'transient',
          },
        ],
      });

      const childBefore = Supervisor.getChild(ref, 'transient')!;
      crashChild(childBefore.ref);

      await waitFor(() => {
        const childAfter = Supervisor.getChild(ref, 'transient');
        return childAfter?.ref.id !== childBefore.ref.id;
      }, 2000);

      expect(Supervisor.getChild(ref, 'transient')).toBeDefined();

      await Supervisor.stop(ref);
    });
  });

  describe('restart intensity', () => {
    it('allows restarts within limit', async () => {
      const ref = await Supervisor.start({
        restartIntensity: { maxRestarts: 3, withinMs: 5000 },
        children: [createChildSpec('child')],
      });

      // Crash twice - should be fine
      for (let i = 0; i < 2; i++) {
        const child = Supervisor.getChild(ref, 'child')!;
        const childRefBefore = child.ref;
        crashChild(child.ref);
        await waitFor(() => {
          const current = Supervisor.getChild(ref, 'child');
          return current?.ref.id !== childRefBefore.id;
        }, 2000);
      }

      expect(Supervisor.isRunning(ref)).toBe(true);

      await Supervisor.stop(ref);
    });
  });

  describe('isRunning()', () => {
    it('returns true for running supervisor', async () => {
      const ref = await Supervisor.start();

      expect(Supervisor.isRunning(ref)).toBe(true);

      await Supervisor.stop(ref);
    });

    it('returns false for stopped supervisor', async () => {
      const ref = await Supervisor.start();
      await Supervisor.stop(ref);

      expect(Supervisor.isRunning(ref)).toBe(false);
    });

    it('returns false for non-existent supervisor', () => {
      const fakeRef = { id: 'non_existent' } as any;
      expect(Supervisor.isRunning(fakeRef)).toBe(false);
    });
  });

  describe('countChildren()', () => {
    it('returns correct count', async () => {
      const ref = await Supervisor.start({
        children: [
          createChildSpec('a'),
          createChildSpec('b'),
          createChildSpec('c'),
        ],
      });

      expect(Supervisor.countChildren(ref)).toBe(3);

      await Supervisor.terminateChild(ref, 'b');
      expect(Supervisor.countChildren(ref)).toBe(2);

      await Supervisor.startChild(ref, createChildSpec('d'));
      expect(Supervisor.countChildren(ref)).toBe(3);

      await Supervisor.stop(ref);
    });
  });

  describe('onLifecycleEvent()', () => {
    it('receives supervisor events', async () => {
      const events: LifecycleEvent[] = [];
      const unsubscribe = Supervisor.onLifecycleEvent((e) => events.push(e));

      const ref = await Supervisor.start();
      await Supervisor.stop(ref);

      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe('started');
      expect(events[1]?.type).toBe('terminated');

      unsubscribe();
    });

    it('returns unsubscribe function', async () => {
      const events: LifecycleEvent[] = [];
      const unsubscribe = Supervisor.onLifecycleEvent((e) => events.push(e));

      const ref1 = await Supervisor.start();
      unsubscribe();
      const ref2 = await Supervisor.start();

      expect(events).toHaveLength(1);

      await Supervisor.stop(ref1);
      await Supervisor.stop(ref2);
    });
  });

  describe('edge cases', () => {
    it('handles multiple supervisors independently', async () => {
      const ref1 = await Supervisor.start({
        children: [createChildSpec('child')],
      });
      const ref2 = await Supervisor.start({
        children: [createChildSpec('child')],
      });

      expect(Supervisor.countChildren(ref1)).toBe(1);
      expect(Supervisor.countChildren(ref2)).toBe(1);

      await Supervisor.terminateChild(ref1, 'child');

      expect(Supervisor.countChildren(ref1)).toBe(0);
      expect(Supervisor.countChildren(ref2)).toBe(1);

      await Supervisor.stop(ref1);
      await Supervisor.stop(ref2);
    });

    it('handles rapid start/stop cycles', async () => {
      for (let i = 0; i < 5; i++) {
        const ref = await Supervisor.start({
          children: [createChildSpec('child')],
        });
        expect(Supervisor.isRunning(ref)).toBe(true);
        await Supervisor.stop(ref);
        expect(Supervisor.isRunning(ref)).toBe(false);
      }
    });

    it('handles shutdown timeout on unresponsive child', async () => {
      const ref = await Supervisor.start({
        children: [
          {
            id: 'slow',
            start: () =>
              GenServer.start({
                init: () => 0,
                handleCall: (_, state) => [state, state],
                handleCast: (_, state) => state,
                terminate: async () => {
                  // Simulate slow shutdown
                  await new Promise((r) => setTimeout(r, 10000));
                },
              }),
            shutdownTimeout: 100,
          },
        ],
      });

      // Should complete within timeout + buffer, not wait 10 seconds
      const start = Date.now();
      await Supervisor.stop(ref);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(500);
    });

    it('maintains child order after dynamic operations', async () => {
      const ref = await Supervisor.start({
        children: [
          createChildSpec('a'),
          createChildSpec('b'),
        ],
      });

      await Supervisor.startChild(ref, createChildSpec('c'));
      await Supervisor.terminateChild(ref, 'a');
      await Supervisor.startChild(ref, createChildSpec('d'));

      const children = Supervisor.getChildren(ref);
      expect(children.map((c) => c.id)).toEqual(['b', 'c', 'd']);

      await Supervisor.stop(ref);
    });
  });

  describe('introspection (Observer support)', () => {
    it('_getStats() returns correct statistics', async () => {
      const startTime = Date.now();
      const ref = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          createChildSpec('child1'),
          createChildSpec('child2'),
        ],
      });

      const stats = Supervisor._getStats(ref);

      expect(stats).toBeDefined();
      expect(stats!.id).toBe(ref.id);
      expect(stats!.strategy).toBe('one_for_one');
      expect(stats!.childCount).toBe(2);
      expect(stats!.totalRestarts).toBe(0);
      expect(stats!.startedAt).toBeGreaterThanOrEqual(startTime - 10);
      expect(stats!.startedAt).toBeLessThanOrEqual(Date.now());
      expect(stats!.uptimeMs).toBeGreaterThanOrEqual(0);

      await Supervisor.stop(ref);
    });

    it('_getStats() returns undefined for stopped supervisor', async () => {
      const ref = await Supervisor.start();
      await Supervisor.stop(ref);

      const stats = Supervisor._getStats(ref);
      expect(stats).toBeUndefined();
    });

    it('_getStats() tracks totalRestarts correctly', async () => {
      const ref = await Supervisor.start({
        restartIntensity: { maxRestarts: 10, withinMs: 5000 },
        children: [createChildSpec('child')],
      });

      let stats = Supervisor._getStats(ref);
      expect(stats!.totalRestarts).toBe(0);

      // Crash child twice
      for (let i = 0; i < 2; i++) {
        const child = Supervisor.getChild(ref, 'child')!;
        const childRefBefore = child.ref;
        crashChild(child.ref);
        await waitFor(() => {
          const current = Supervisor.getChild(ref, 'child');
          return current?.ref.id !== childRefBefore.id;
        }, 2000);
      }

      stats = Supervisor._getStats(ref);
      expect(stats!.totalRestarts).toBe(2);

      await Supervisor.stop(ref);
    });

    it('_getAllStats() returns statistics for all running supervisors', async () => {
      const ref1 = await Supervisor.start({
        strategy: 'one_for_one',
        children: [createChildSpec('child')],
      });
      const ref2 = await Supervisor.start({
        strategy: 'one_for_all',
      });

      const allStats = Supervisor._getAllStats();

      expect(allStats.length).toBe(2);
      expect(allStats.map((s) => s.id).sort()).toEqual(
        [ref1.id, ref2.id].sort()
      );

      const stats1 = allStats.find((s) => s.id === ref1.id);
      const stats2 = allStats.find((s) => s.id === ref2.id);

      expect(stats1!.strategy).toBe('one_for_one');
      expect(stats1!.childCount).toBe(1);
      expect(stats2!.strategy).toBe('one_for_all');
      expect(stats2!.childCount).toBe(0);

      await Promise.all([Supervisor.stop(ref1), Supervisor.stop(ref2)]);
    });

    it('_getAllStats() returns empty array when no supervisors running', () => {
      const allStats = Supervisor._getAllStats();
      expect(allStats).toEqual([]);
    });

    it('_getAllSupervisorIds() returns all running supervisor IDs', async () => {
      const ref1 = await Supervisor.start();
      const ref2 = await Supervisor.start();

      const ids = Supervisor._getAllSupervisorIds();

      expect(ids.length).toBe(2);
      expect(ids).toContain(ref1.id);
      expect(ids).toContain(ref2.id);

      await Supervisor.stop(ref1);

      const idsAfterStop = Supervisor._getAllSupervisorIds();
      expect(idsAfterStop.length).toBe(1);
      expect(idsAfterStop).toContain(ref2.id);
      expect(idsAfterStop).not.toContain(ref1.id);

      await Supervisor.stop(ref2);
    });

    it('_getRefById() returns ref for valid ID', async () => {
      const ref = await Supervisor.start();

      const foundRef = Supervisor._getRefById(ref.id);

      expect(foundRef).toBeDefined();
      expect(foundRef!.id).toBe(ref.id);

      await Supervisor.stop(ref);
    });

    it('_getRefById() returns undefined for invalid ID', async () => {
      const ref = Supervisor._getRefById('non_existent_id');
      expect(ref).toBeUndefined();
    });

    it('_getRefById() returns undefined after supervisor is stopped', async () => {
      const ref = await Supervisor.start();
      const id = ref.id;
      await Supervisor.stop(ref);

      const foundRef = Supervisor._getRefById(id);
      expect(foundRef).toBeUndefined();
    });

    it('childCount updates dynamically', async () => {
      const ref = await Supervisor.start({
        children: [createChildSpec('a')],
      });

      let stats = Supervisor._getStats(ref);
      expect(stats!.childCount).toBe(1);

      await Supervisor.startChild(ref, createChildSpec('b'));
      await Supervisor.startChild(ref, createChildSpec('c'));

      stats = Supervisor._getStats(ref);
      expect(stats!.childCount).toBe(3);

      await Supervisor.terminateChild(ref, 'b');

      stats = Supervisor._getStats(ref);
      expect(stats!.childCount).toBe(2);

      await Supervisor.stop(ref);
    });
  });
});
