/**
 * Comprehensive tests for Observer module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GenServer,
  Supervisor,
  Registry,
  Observer,
  type GenServerBehavior,
  type ObserverEvent,
} from '../../src/index.js';

function createCounterBehavior(): GenServerBehavior<number, 'get', 'inc', number> {
  return {
    init: () => 0,
    handleCall: (msg, state) => {
      if (msg === 'get') return [state, state];
      throw new Error('Unknown message');
    },
    handleCast: (msg, state) => {
      if (msg === 'inc') return state + 1;
      return state;
    },
  };
}

/**
 * Simulates a child crash by force-terminating the server.
 */
function crashChild(ref: import('../../src/index.js').GenServerRef): void {
  GenServer._forceTerminate(ref, { error: new Error('Simulated crash') });
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

describe('Observer', () => {
  beforeEach(() => {
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
    Supervisor._clearLifecycleHandlers();
    Supervisor._resetIdCounter();
    Registry._clearLifecycleHandler();
    Registry._clear();
    Observer._reset();
  });

  afterEach(async () => {
    Observer._reset();
    await Supervisor._clearAll();
    GenServer._clearLifecycleHandlers();
    Registry._clearLifecycleHandler();
    Registry._clear();
  });

  describe('getSnapshot()', () => {
    it('returns empty snapshot when no processes are running', () => {
      const snapshot = Observer.getSnapshot();

      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.servers).toEqual([]);
      expect(snapshot.supervisors).toEqual([]);
      expect(snapshot.tree).toEqual([]);
      expect(snapshot.processCount).toBe(0);
      expect(snapshot.totalMessages).toBe(0);
      expect(snapshot.totalRestarts).toBe(0);
    });

    it('includes running GenServers in snapshot', async () => {
      const ref = await GenServer.start(createCounterBehavior());

      const snapshot = Observer.getSnapshot();

      expect(snapshot.servers).toHaveLength(1);
      expect(snapshot.servers[0]!.id).toBe(ref.id);
      expect(snapshot.servers[0]!.status).toBe('running');
      expect(snapshot.processCount).toBe(1);

      await GenServer.stop(ref);
    });

    it('includes running Supervisors in snapshot', async () => {
      const supRef = await Supervisor.start({ strategy: 'one_for_one' });

      const snapshot = Observer.getSnapshot();

      expect(snapshot.supervisors).toHaveLength(1);
      expect(snapshot.supervisors[0]!.id).toBe(supRef.id);
      expect(snapshot.supervisors[0]!.strategy).toBe('one_for_one');

      await Supervisor.stop(supRef);
    });

    it('tracks message count correctly', async () => {
      const ref = await GenServer.start(createCounterBehavior());

      await GenServer.call(ref, 'get');
      await GenServer.call(ref, 'get');
      GenServer.cast(ref, 'inc');

      // Wait for cast to be processed
      await new Promise((r) => setTimeout(r, 50));

      const snapshot = Observer.getSnapshot();
      expect(snapshot.totalMessages).toBe(3);

      await GenServer.stop(ref);
    });

    it('tracks total restarts across supervisors', async () => {
      const supRef = await Supervisor.start({
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts: 10, withinMs: 5000 },
        children: [
          { id: 'worker', start: () => GenServer.start(createCounterBehavior()) },
        ],
      });

      // Force crash the child
      const child = Supervisor.getChild(supRef, 'worker')!;
      const childRefBefore = child.ref;
      crashChild(child.ref);

      // Wait for restart
      await waitFor(() => {
        const current = Supervisor.getChild(supRef, 'worker');
        return current?.ref.id !== childRefBefore.id;
      }, 2000);

      const snapshot = Observer.getSnapshot();
      expect(snapshot.totalRestarts).toBeGreaterThanOrEqual(1);

      await Supervisor.stop(supRef);
    });
  });

  describe('getServerStats()', () => {
    it('returns stats for all running servers', async () => {
      const ref1 = await GenServer.start(createCounterBehavior());
      const ref2 = await GenServer.start(createCounterBehavior());

      const stats = Observer.getServerStats();

      expect(stats).toHaveLength(2);
      expect(stats.some((s) => s.id === ref1.id)).toBe(true);
      expect(stats.some((s) => s.id === ref2.id)).toBe(true);

      await GenServer.stop(ref1);
      await GenServer.stop(ref2);
    });

    it('includes uptime calculation', async () => {
      const ref = await GenServer.start(createCounterBehavior());

      await new Promise((r) => setTimeout(r, 100));

      const stats = Observer.getServerStats();
      expect(stats[0]!.uptimeMs).toBeGreaterThanOrEqual(100);

      await GenServer.stop(ref);
    });
  });

  describe('getSupervisorStats()', () => {
    it('returns stats for all running supervisors', async () => {
      const sup1 = await Supervisor.start({ strategy: 'one_for_one' });
      const sup2 = await Supervisor.start({ strategy: 'one_for_all' });

      const stats = Observer.getSupervisorStats();

      expect(stats).toHaveLength(2);
      expect(stats.some((s) => s.strategy === 'one_for_one')).toBe(true);
      expect(stats.some((s) => s.strategy === 'one_for_all')).toBe(true);

      await Supervisor.stop(sup1);
      await Supervisor.stop(sup2);
    });

    it('includes child count', async () => {
      const supRef = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'child1', start: () => GenServer.start(createCounterBehavior()) },
          { id: 'child2', start: () => GenServer.start(createCounterBehavior()) },
        ],
      });

      const stats = Observer.getSupervisorStats();
      expect(stats[0]!.childCount).toBe(2);

      await Supervisor.stop(supRef);
    });
  });

  describe('getProcessTree()', () => {
    it('returns empty tree when no processes exist', () => {
      const tree = Observer.getProcessTree();
      expect(tree).toEqual([]);
    });

    it('includes standalone servers at root level', async () => {
      const ref = await GenServer.start(createCounterBehavior());

      const tree = Observer.getProcessTree();

      expect(tree).toHaveLength(1);
      expect(tree[0]!.type).toBe('genserver');
      expect(tree[0]!.id).toBe(ref.id);

      await GenServer.stop(ref);
    });

    it('includes supervisors with children', async () => {
      const supRef = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'counter', start: () => GenServer.start(createCounterBehavior()) },
        ],
      });

      const tree = Observer.getProcessTree();

      expect(tree).toHaveLength(1);
      expect(tree[0]!.type).toBe('supervisor');
      expect(tree[0]!.children).toHaveLength(1);
      expect(tree[0]!.children![0]!.type).toBe('genserver');
      expect(tree[0]!.children![0]!.name).toBe('counter');

      await Supervisor.stop(supRef);
    });

    it('includes registry names when available', async () => {
      const ref = await GenServer.start(createCounterBehavior());
      Registry.register('my-counter', ref);

      const tree = Observer.getProcessTree();

      expect(tree[0]!.name).toBe('my-counter');

      await GenServer.stop(ref);
    });

    it('handles mixed standalone and supervised servers', async () => {
      const standaloneRef = await GenServer.start(createCounterBehavior());
      const supRef = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'supervised', start: () => GenServer.start(createCounterBehavior()) },
        ],
      });

      const tree = Observer.getProcessTree();

      // Should have supervisor and standalone
      expect(tree).toHaveLength(2);
      expect(tree.some((n) => n.type === 'supervisor')).toBe(true);
      expect(tree.some((n) => n.type === 'genserver')).toBe(true);

      await GenServer.stop(standaloneRef);
      await Supervisor.stop(supRef);
    });
  });

  describe('subscribe()', () => {
    it('receives server_started events', async () => {
      const events: ObserverEvent[] = [];
      const unsubscribe = Observer.subscribe((e) => events.push(e));

      const ref = await GenServer.start(createCounterBehavior());

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('server_started');
      if (events[0]!.type === 'server_started') {
        expect(events[0]!.stats.id).toBe(ref.id);
      }

      unsubscribe();
      await GenServer.stop(ref);
    });

    it('receives server_stopped events', async () => {
      const ref = await GenServer.start(createCounterBehavior());

      const events: ObserverEvent[] = [];
      const unsubscribe = Observer.subscribe((e) => events.push(e));

      await GenServer.stop(ref);

      expect(events.some((e) => e.type === 'server_stopped')).toBe(true);
      unsubscribe();
    });

    it('receives supervisor_started events', async () => {
      const events: ObserverEvent[] = [];
      const unsubscribe = Observer.subscribe((e) => events.push(e));

      const supRef = await Supervisor.start({ strategy: 'one_for_one' });

      expect(events.some((e) => e.type === 'supervisor_started')).toBe(true);

      unsubscribe();
      await Supervisor.stop(supRef);
    });

    it('unsubscribe stops receiving events', async () => {
      const events: ObserverEvent[] = [];
      const unsubscribe = Observer.subscribe((e) => events.push(e));

      const ref1 = await GenServer.start(createCounterBehavior());
      expect(events).toHaveLength(1);

      unsubscribe();

      const ref2 = await GenServer.start(createCounterBehavior());
      expect(events).toHaveLength(1); // No new events

      await GenServer.stop(ref1);
      await GenServer.stop(ref2);
    });
  });

  describe('startPolling()', () => {
    it('emits immediate stats_update on start', async () => {
      const events: ObserverEvent[] = [];
      const stopPolling = Observer.startPolling(1000, (e) => events.push(e));

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('stats_update');

      stopPolling();
    });

    it('emits periodic stats updates', async () => {
      const events: ObserverEvent[] = [];
      const stopPolling = Observer.startPolling(50, (e) => events.push(e));

      await new Promise((r) => setTimeout(r, 130));

      stopPolling();

      // Should have initial + at least 2 more updates
      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(events.every((e) => e.type === 'stats_update')).toBe(true);
    });

    it('stops polling when stop function is called', async () => {
      const events: ObserverEvent[] = [];
      const stopPolling = Observer.startPolling(50, (e) => events.push(e));

      await new Promise((r) => setTimeout(r, 60));
      stopPolling();

      const countAfterStop = events.length;
      await new Promise((r) => setTimeout(r, 100));

      expect(events.length).toBe(countAfterStop);
    });

    it('includes current stats in update', async () => {
      const ref = await GenServer.start(createCounterBehavior());

      const events: ObserverEvent[] = [];
      const stopPolling = Observer.startPolling(1000, (e) => events.push(e));

      const event = events[0];
      expect(event!.type).toBe('stats_update');
      if (event!.type === 'stats_update') {
        expect(event!.servers).toHaveLength(1);
        expect(event!.servers[0]!.id).toBe(ref.id);
      }

      stopPolling();
      await GenServer.stop(ref);
    });
  });

  describe('getProcessCount()', () => {
    it('returns zero when no processes running', () => {
      expect(Observer.getProcessCount()).toBe(0);
    });

    it('counts both servers and supervisors', async () => {
      const ref = await GenServer.start(createCounterBehavior());
      const supRef = await Supervisor.start({ strategy: 'one_for_one' });

      expect(Observer.getProcessCount()).toBe(2);

      await GenServer.stop(ref);
      await Supervisor.stop(supRef);
    });
  });

  describe('getMemoryStats()', () => {
    it('returns valid memory statistics', () => {
      const stats = Observer.getMemoryStats();

      expect(stats.heapUsed).toBeGreaterThan(0);
      expect(stats.heapTotal).toBeGreaterThan(0);
      expect(stats.rss).toBeGreaterThan(0);
      expect(stats.timestamp).toBeGreaterThan(0);
    });
  });

  describe('stopProcess()', () => {
    it('stops a GenServer by ID', async () => {
      const ref = await GenServer.start(createCounterBehavior());

      expect(GenServer.isRunning(ref)).toBe(true);

      const result = await Observer.stopProcess(ref.id);

      expect(result.success).toBe(true);
      expect(GenServer.isRunning(ref)).toBe(false);
    });

    it('stops a Supervisor by ID', async () => {
      const supRef = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'worker', start: () => GenServer.start(createCounterBehavior()) },
        ],
      });

      expect(Supervisor.isRunning(supRef)).toBe(true);

      const result = await Observer.stopProcess(supRef.id);

      expect(result.success).toBe(true);
      expect(Supervisor.isRunning(supRef)).toBe(false);
    });

    it('returns error for non-existent process', async () => {
      const result = await Observer.stopProcess('nonexistent_id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('stops supervisor and all children', async () => {
      const supRef = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'worker1', start: () => GenServer.start(createCounterBehavior()) },
          { id: 'worker2', start: () => GenServer.start(createCounterBehavior()) },
        ],
      });

      const child1 = Supervisor.getChild(supRef, 'worker1')!;
      const child2 = Supervisor.getChild(supRef, 'worker2')!;

      expect(GenServer.isRunning(child1.ref)).toBe(true);
      expect(GenServer.isRunning(child2.ref)).toBe(true);

      const result = await Observer.stopProcess(supRef.id);

      expect(result.success).toBe(true);
      expect(GenServer.isRunning(child1.ref)).toBe(false);
      expect(GenServer.isRunning(child2.ref)).toBe(false);
    });

    it('uses shutdown as terminate reason', async () => {
      let terminateReason: string | undefined;
      const behaviorWithTerminate: GenServerBehavior<number, 'get', 'inc', number> = {
        init: () => 0,
        handleCall: (msg, state) => [state, state],
        handleCast: (msg, state) => state,
        terminate: (reason) => {
          terminateReason = reason as string;
        },
      };

      const ref = await GenServer.start(behaviorWithTerminate);

      await Observer.stopProcess(ref.id, 'Manual shutdown from UI');

      expect(terminateReason).toBe('shutdown');
    });
  });

  describe('memory tracking in snapshot', () => {
    it('includes memoryStats in snapshot', () => {
      const snapshot = Observer.getSnapshot();

      expect(snapshot.memoryStats).toBeDefined();
      expect(snapshot.memoryStats.heapUsed).toBeGreaterThan(0);
      expect(snapshot.memoryStats.heapTotal).toBeGreaterThan(0);
      expect(snapshot.memoryStats.rss).toBeGreaterThan(0);
      expect(snapshot.memoryStats.timestamp).toBeGreaterThan(0);
    });

    it('includes stateMemoryBytes in server stats', async () => {
      const ref = await GenServer.start(createCounterBehavior());

      const snapshot = Observer.getSnapshot();

      expect(snapshot.servers).toHaveLength(1);
      expect(snapshot.servers[0]!.stateMemoryBytes).toBeDefined();
      expect(snapshot.servers[0]!.stateMemoryBytes).toBeGreaterThan(0);

      await GenServer.stop(ref);
    });

    it('tracks state memory growth', async () => {
      // Behavior with growing state
      interface State {
        items: string[];
      }
      const growingBehavior: GenServerBehavior<State, 'get', 'add', number> = {
        init: () => ({ items: [] }),
        handleCall: (msg, state) => {
          if (msg === 'get') return [state.items.length, state];
          throw new Error('Unknown');
        },
        handleCast: (msg, state) => {
          if (msg === 'add') {
            return { items: [...state.items, 'x'.repeat(1000)] };
          }
          return state;
        },
      };

      const ref = await GenServer.start(growingBehavior);

      const beforeSnapshot = Observer.getSnapshot();
      const beforeMemory = beforeSnapshot.servers[0]!.stateMemoryBytes!;

      // Add items to grow state
      for (let i = 0; i < 10; i++) {
        GenServer.cast(ref, 'add');
      }
      await new Promise((r) => setTimeout(r, 50));

      const afterSnapshot = Observer.getSnapshot();
      const afterMemory = afterSnapshot.servers[0]!.stateMemoryBytes!;

      expect(afterMemory).toBeGreaterThan(beforeMemory);

      await GenServer.stop(ref);
    });
  });
});
