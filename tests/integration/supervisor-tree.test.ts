/**
 * Integration tests for supervisor trees.
 *
 * These tests verify the correct behavior of hierarchical supervisor structures,
 * including nested supervisors, registry integration, and complex failure scenarios.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  GenServer,
  Supervisor,
  Registry,
  EventBus,
  Cache,
  RateLimiter,
  type GenServerRef,
  type GenServerBehavior,
  type ChildSpec,
  type LifecycleEvent,
} from '../../src/index.js';

/**
 * Helper to wait for a condition with timeout.
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 2000,
  intervalMs: number = 20,
): Promise<void> {
  const start = Date.now();
  while (true) {
    const result = await Promise.resolve(condition());
    if (result) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Creates a counter behavior for testing.
 */
function createCounterBehavior(): GenServerBehavior<number, 'get', 'inc' | 'dec', number> {
  return {
    init: () => 0,
    handleCall: (_, state) => [state, state],
    handleCast: (msg, state) => (msg === 'inc' ? state + 1 : state - 1),
  };
}

/**
 * Creates a stateful accumulator that tracks operations.
 */
function createAccumulatorBehavior(
  id: string,
  log: string[],
): GenServerBehavior<number[], { type: 'get' } | { type: 'sum' }, { type: 'add'; value: number }, number[] | number> {
  return {
    init: () => {
      log.push(`${id}:init`);
      return [];
    },
    handleCall: (msg, state) => {
      if (msg.type === 'get') return [state, state];
      if (msg.type === 'sum') return [state.reduce((a, b) => a + b, 0), state];
      return [state, state];
    },
    handleCast: (msg, state) => {
      if (msg.type === 'add') {
        log.push(`${id}:add:${msg.value}`);
        return [...state, msg.value];
      }
      return state;
    },
    terminate: (reason) => {
      log.push(`${id}:terminate:${typeof reason === 'string' ? reason : 'error'}`);
    },
  };
}

/**
 * Simulates a child crash.
 */
function crashChild(ref: GenServerRef): void {
  GenServer._forceTerminate(ref, { error: new Error('Simulated crash') });
}

describe('Supervisor Tree Integration', () => {
  beforeEach(() => {
    Supervisor._clearLifecycleHandlers();
    Supervisor._resetIdCounter();
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
    Registry._clearLifecycleHandler();
    Registry._clear();
  });

  afterEach(() => {
    Supervisor._clearLifecycleHandlers();
    GenServer._clearLifecycleHandlers();
    Registry._clearLifecycleHandler();
    Registry._clear();
  });

  describe('Nested Supervisors', () => {
    it('creates a two-level supervisor hierarchy', async () => {
      const log: string[] = [];

      // Create a GenServer that wraps a Supervisor for proper cleanup
      function createSupervisorWrapper(children: ChildSpec[]): GenServerBehavior<{ supervisorId: string | null }, 'getId', never, string | null> {
        let supervisorRef: { id: string } | null = null;

        return {
          init: async () => {
            log.push('child-supervisor:start');
            const ref = await Supervisor.start({
              strategy: 'one_for_one',
              children,
            });
            supervisorRef = ref;
            return { supervisorId: ref.id };
          },
          handleCall: (_, state) => [state.supervisorId, state],
          handleCast: (_, state) => state,
          terminate: async () => {
            if (supervisorRef) {
              await Supervisor.stop(supervisorRef as any);
            }
          },
        };
      }

      const rootSupervisor = await Supervisor.start({
        strategy: 'one_for_all',
        children: [
          {
            id: 'child-supervisor',
            start: () =>
              GenServer.start(
                createSupervisorWrapper([
                  {
                    id: 'worker1',
                    start: async () => {
                      log.push('worker1:start');
                      return GenServer.start(createCounterBehavior());
                    },
                  },
                  {
                    id: 'worker2',
                    start: async () => {
                      log.push('worker2:start');
                      return GenServer.start(createCounterBehavior());
                    },
                  },
                ]),
              ),
          },
        ],
      });

      expect(log).toContain('child-supervisor:start');
      expect(log).toContain('worker1:start');
      expect(log).toContain('worker2:start');
      expect(Supervisor.countChildren(rootSupervisor)).toBe(1);

      await Supervisor.stop(rootSupervisor);
    });

    it('properly shuts down nested hierarchy with terminate callbacks', async () => {
      const shutdownOrder: string[] = [];

      const createTrackedWorker = (id: string): ChildSpec => ({
        id,
        start: () =>
          GenServer.start({
            init: () => null,
            handleCall: (_, state) => [state, state],
            handleCast: (_, state) => state,
            terminate: () => {
              shutdownOrder.push(id);
            },
          }),
      });

      // Create independent supervisors and track their lifecycle
      const rootSupervisor = await Supervisor.start({
        children: [
          createTrackedWorker('worker-a'),
          createTrackedWorker('worker-b'),
          createTrackedWorker('worker-c'),
        ],
      });

      await Supervisor.stop(rootSupervisor);

      // Workers should be shut down in reverse order
      expect(shutdownOrder).toEqual(['worker-c', 'worker-b', 'worker-a']);
    });

    it('nested supervisor wrapper properly cleans up children', async () => {
      const shutdownOrder: string[] = [];
      let innerSupervisorRef: { id: string } | null = null;

      const createTrackedWorker = (id: string): ChildSpec => ({
        id,
        start: () =>
          GenServer.start({
            init: () => null,
            handleCall: (_, state) => [state, state],
            handleCast: (_, state) => state,
            terminate: () => {
              shutdownOrder.push(id);
            },
          }),
      });

      const rootSupervisor = await Supervisor.start({
        children: [
          {
            id: 'supervisor-wrapper',
            start: () =>
              GenServer.start({
                init: async () => {
                  const ref = await Supervisor.start({
                    children: [
                      createTrackedWorker('inner-worker1'),
                      createTrackedWorker('inner-worker2'),
                    ],
                  });
                  innerSupervisorRef = ref;
                  return { ref };
                },
                handleCall: (_, state) => [null, state],
                handleCast: (_, state) => state,
                terminate: async () => {
                  shutdownOrder.push('supervisor-wrapper');
                  if (innerSupervisorRef) {
                    await Supervisor.stop(innerSupervisorRef as any);
                  }
                },
              }),
          },
        ],
      });

      await Supervisor.stop(rootSupervisor);

      // Inner workers should be cleaned up via the wrapper's terminate
      expect(shutdownOrder).toContain('supervisor-wrapper');
      expect(shutdownOrder).toContain('inner-worker1');
      expect(shutdownOrder).toContain('inner-worker2');
    });
  });

  describe('Registry Integration', () => {
    it('registered servers are accessible via Registry', async () => {
      const supervisor = await Supervisor.start({
        children: [
          {
            id: 'registered-counter',
            start: async () => {
              const ref = await GenServer.start(createCounterBehavior());
              Registry.register('counter', ref);
              return ref;
            },
          },
        ],
      });

      expect(Registry.isRegistered('counter')).toBe(true);

      const counter = Registry.lookup<number, 'get', 'inc' | 'dec', number>('counter');
      GenServer.cast(counter, 'inc');
      GenServer.cast(counter, 'inc');

      await waitFor(async () => {
        const value = await GenServer.call(counter, 'get');
        return value === 2;
      });

      const value = await GenServer.call(counter, 'get');
      expect(value).toBe(2);

      await Supervisor.stop(supervisor);
    });

    it('automatically unregisters servers on supervisor stop', async () => {
      const supervisor = await Supervisor.start({
        children: [
          {
            id: 'auto-unregister',
            start: async () => {
              const ref = await GenServer.start(createCounterBehavior());
              Registry.register('auto-service', ref);
              return ref;
            },
          },
        ],
      });

      expect(Registry.isRegistered('auto-service')).toBe(true);

      await Supervisor.stop(supervisor);

      expect(Registry.isRegistered('auto-service')).toBe(false);
    });

    it('maintains registry after child restart', async () => {
      let startCount = 0;

      const supervisor = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          {
            id: 'restartable',
            restart: 'permanent',
            start: async () => {
              startCount++;
              const ref = await GenServer.start(createCounterBehavior());
              // Re-register on restart
              if (Registry.isRegistered('restartable-service')) {
                Registry.unregister('restartable-service');
              }
              Registry.register('restartable-service', ref);
              return ref;
            },
          },
        ],
      });

      const originalRef = Registry.lookup('restartable-service');
      crashChild(originalRef);

      await waitFor(() => startCount >= 2);

      expect(Registry.isRegistered('restartable-service')).toBe(true);
      const newRef = Registry.lookup('restartable-service');
      expect(newRef.id).not.toBe(originalRef.id);

      await Supervisor.stop(supervisor);
    });
  });

  describe('Complex Error Recovery', () => {
    it('one_for_one strategy isolates failures', async () => {
      const restartCounts = { worker1: 0, worker2: 0, worker3: 0 };

      const createTrackedWorker = (id: keyof typeof restartCounts): ChildSpec => ({
        id,
        restart: 'permanent',
        start: async () => {
          restartCounts[id]++;
          return GenServer.start(createCounterBehavior());
        },
      });

      const supervisor = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          createTrackedWorker('worker1'),
          createTrackedWorker('worker2'),
          createTrackedWorker('worker3'),
        ],
      });

      const worker2 = Supervisor.getChild(supervisor, 'worker2')!.ref;
      crashChild(worker2);

      await waitFor(() => restartCounts.worker2 >= 2);

      // Only worker2 should have been restarted
      expect(restartCounts.worker1).toBe(1);
      expect(restartCounts.worker2).toBe(2);
      expect(restartCounts.worker3).toBe(1);

      await Supervisor.stop(supervisor);
    });

    it('one_for_all strategy restarts all on single failure', async () => {
      const restartCounts = { worker1: 0, worker2: 0, worker3: 0 };

      const createTrackedWorker = (id: keyof typeof restartCounts): ChildSpec => ({
        id,
        restart: 'permanent',
        start: async () => {
          restartCounts[id]++;
          return GenServer.start(createCounterBehavior());
        },
      });

      const supervisor = await Supervisor.start({
        strategy: 'one_for_all',
        children: [
          createTrackedWorker('worker1'),
          createTrackedWorker('worker2'),
          createTrackedWorker('worker3'),
        ],
      });

      const worker2 = Supervisor.getChild(supervisor, 'worker2')!.ref;
      crashChild(worker2);

      await waitFor(() => restartCounts.worker1 >= 2 && restartCounts.worker2 >= 2 && restartCounts.worker3 >= 2);

      // All workers should have been restarted
      expect(restartCounts.worker1).toBe(2);
      expect(restartCounts.worker2).toBe(2);
      expect(restartCounts.worker3).toBe(2);

      await Supervisor.stop(supervisor);
    });

    it('rest_for_one strategy restarts crashed and subsequent children', async () => {
      const restartCounts = { worker1: 0, worker2: 0, worker3: 0, worker4: 0 };

      const createTrackedWorker = (id: keyof typeof restartCounts): ChildSpec => ({
        id,
        restart: 'permanent',
        start: async () => {
          restartCounts[id]++;
          return GenServer.start(createCounterBehavior());
        },
      });

      const supervisor = await Supervisor.start({
        strategy: 'rest_for_one',
        children: [
          createTrackedWorker('worker1'),
          createTrackedWorker('worker2'),
          createTrackedWorker('worker3'),
          createTrackedWorker('worker4'),
        ],
      });

      const worker2 = Supervisor.getChild(supervisor, 'worker2')!.ref;
      crashChild(worker2);

      await waitFor(() => restartCounts.worker2 >= 2 && restartCounts.worker3 >= 2 && restartCounts.worker4 >= 2);

      // worker1 should NOT be restarted, worker2-4 should be
      expect(restartCounts.worker1).toBe(1);
      expect(restartCounts.worker2).toBe(2);
      expect(restartCounts.worker3).toBe(2);
      expect(restartCounts.worker4).toBe(2);

      await Supervisor.stop(supervisor);
    });

    it('temporary children are not restarted', async () => {
      let startCount = 0;

      const supervisor = await Supervisor.start({
        children: [
          {
            id: 'temporary-worker',
            restart: 'temporary',
            start: async () => {
              startCount++;
              return GenServer.start(createCounterBehavior());
            },
          },
        ],
      });

      expect(Supervisor.countChildren(supervisor)).toBe(1);

      const worker = Supervisor.getChild(supervisor, 'temporary-worker')!.ref;
      crashChild(worker);

      await waitFor(() => Supervisor.getChild(supervisor, 'temporary-worker') === undefined);

      expect(startCount).toBe(1);
      expect(Supervisor.countChildren(supervisor)).toBe(0);

      await Supervisor.stop(supervisor);
    });
  });

  describe('Real-World Service Composition', () => {
    it('coordinates EventBus, Cache, and RateLimiter under supervision', async () => {
      const events: string[] = [];

      const supervisor = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          {
            id: 'event-bus',
            start: async () => {
              const ref = await EventBus.start();
              Registry.register('events', ref);
              return ref as unknown as GenServerRef;
            },
          },
          {
            id: 'cache',
            start: async () => {
              const ref = await Cache.start({ maxSize: 100, defaultTtlMs: 60000 });
              Registry.register('cache', ref);
              return ref as unknown as GenServerRef;
            },
          },
          {
            id: 'rate-limiter',
            start: async () => {
              const ref = await RateLimiter.start({ maxRequests: 10, windowMs: 1000 });
              Registry.register('rate-limiter', ref);
              return ref as unknown as GenServerRef;
            },
          },
        ],
      });

      // All services should be registered
      expect(Registry.isRegistered('events')).toBe(true);
      expect(Registry.isRegistered('cache')).toBe(true);
      expect(Registry.isRegistered('rate-limiter')).toBe(true);

      // Use the services together
      const eventBus = Registry.lookup('events');
      const cache = Registry.lookup('cache');
      const rateLimiter = Registry.lookup('rate-limiter');

      // Subscribe to events
      await EventBus.subscribe(eventBus, 'cache.*', (topic, data) => {
        events.push(`${topic}:${JSON.stringify(data)}`);
      });

      // Set cache value and publish event
      await Cache.set(cache, 'user:1', { name: 'Alice' });
      EventBus.publish(eventBus, 'cache.set', { key: 'user:1' });

      // Check rate limiting
      const result = await RateLimiter.check(rateLimiter, 'api-key-1');
      expect(result.allowed).toBe(true);

      // Allow events to propagate
      await new Promise((r) => setTimeout(r, 50));

      expect(events.some((e) => e.includes('cache.set'))).toBe(true);

      await Supervisor.stop(supervisor);
    });

    it('handles coordinated state across services', async () => {
      const log: string[] = [];

      const supervisor = await Supervisor.start({
        strategy: 'one_for_all',
        children: [
          {
            id: 'accumulator1',
            start: async () => {
              const ref = await GenServer.start(createAccumulatorBehavior('acc1', log));
              Registry.register('accumulator1', ref);
              return ref;
            },
          },
          {
            id: 'accumulator2',
            start: async () => {
              const ref = await GenServer.start(createAccumulatorBehavior('acc2', log));
              Registry.register('accumulator2', ref);
              return ref;
            },
          },
        ],
      });

      const acc1 = Registry.lookup('accumulator1');
      const acc2 = Registry.lookup('accumulator2');

      GenServer.cast(acc1, { type: 'add', value: 10 });
      GenServer.cast(acc2, { type: 'add', value: 20 });

      await waitFor(async () => {
        const sum1 = (await GenServer.call(acc1, { type: 'sum' })) as number;
        const sum2 = (await GenServer.call(acc2, { type: 'sum' })) as number;
        return sum1 === 10 && sum2 === 20;
      });

      expect(log).toContain('acc1:add:10');
      expect(log).toContain('acc2:add:20');

      await Supervisor.stop(supervisor);

      expect(log).toContain('acc1:terminate:shutdown');
      expect(log).toContain('acc2:terminate:shutdown');
    });
  });

  describe('Lifecycle Events', () => {
    it('emits lifecycle events throughout supervisor tree operations', async () => {
      const genServerEvents: LifecycleEvent[] = [];
      const supervisorEvents: LifecycleEvent[] = [];

      const unsubGenServer = GenServer.onLifecycleEvent((e) => genServerEvents.push(e));
      const unsubSupervisor = Supervisor.onLifecycleEvent((e) => supervisorEvents.push(e));

      const supervisor = await Supervisor.start({
        children: [
          {
            id: 'observed-worker',
            start: () => GenServer.start(createCounterBehavior()),
          },
        ],
      });

      expect(genServerEvents.some((e) => e.type === 'started')).toBe(true);
      expect(supervisorEvents.some((e) => e.type === 'started')).toBe(true);

      await Supervisor.stop(supervisor);

      expect(genServerEvents.some((e) => e.type === 'terminated')).toBe(true);
      expect(supervisorEvents.some((e) => e.type === 'terminated')).toBe(true);

      unsubGenServer();
      unsubSupervisor();
    });
  });

  describe('Concurrent Operations', () => {
    it('handles concurrent calls to multiple supervised children', async () => {
      const supervisor = await Supervisor.start({
        children: Array.from({ length: 5 }, (_, i) => ({
          id: `worker-${i}`,
          start: () => GenServer.start(createCounterBehavior()),
        })),
      });

      const children = Supervisor.getChildren(supervisor);
      expect(children).toHaveLength(5);

      // Perform concurrent operations
      const operations = children.flatMap((child) => [
        (async () => {
          GenServer.cast(child.ref, 'inc');
          GenServer.cast(child.ref, 'inc');
          GenServer.cast(child.ref, 'inc');
        })(),
      ]);

      await Promise.all(operations);

      // Wait for all casts to be processed
      await waitFor(async () => {
        const values = await Promise.all(
          children.map((child) => GenServer.call(child.ref, 'get') as Promise<number>),
        );
        return values.every((v) => v === 3);
      });

      const values = await Promise.all(
        children.map((child) => GenServer.call(child.ref, 'get') as Promise<number>),
      );
      expect(values).toEqual([3, 3, 3, 3, 3]);

      await Supervisor.stop(supervisor);
    });

    it('handles dynamic child addition and removal under load', async () => {
      const supervisor = await Supervisor.start();

      // Add children dynamically
      const refs: GenServerRef[] = [];
      for (let i = 0; i < 10; i++) {
        const ref = await Supervisor.startChild(supervisor, {
          id: `dynamic-${i}`,
          start: () => GenServer.start(createCounterBehavior()),
        });
        refs.push(ref);
      }

      expect(Supervisor.countChildren(supervisor)).toBe(10);

      // Perform operations on all
      for (const ref of refs) {
        GenServer.cast(ref, 'inc');
      }

      // Remove half
      for (let i = 0; i < 5; i++) {
        await Supervisor.terminateChild(supervisor, `dynamic-${i}`);
      }

      expect(Supervisor.countChildren(supervisor)).toBe(5);

      // Remaining should still work
      const remaining = Supervisor.getChildren(supervisor);
      for (const child of remaining) {
        const value = await GenServer.call(child.ref, 'get');
        expect(value).toBe(1);
      }

      await Supervisor.stop(supervisor);
    });
  });

  describe('Restart Intensity Limits', () => {
    it('respects restart intensity across the tree', async () => {
      let startCount = 0;

      const supervisor = await Supervisor.start({
        restartIntensity: { maxRestarts: 3, withinMs: 5000 },
        children: [
          {
            id: 'crasher',
            restart: 'permanent',
            start: async () => {
              startCount++;
              return GenServer.start(createCounterBehavior());
            },
          },
        ],
      });

      expect(startCount).toBe(1);

      // Trigger first crash
      const child1 = Supervisor.getChild(supervisor, 'crasher')!.ref;
      crashChild(child1);

      await waitFor(() => startCount >= 2, 2000);
      expect(startCount).toBe(2);

      // Trigger second crash
      const child2 = Supervisor.getChild(supervisor, 'crasher')!.ref;
      crashChild(child2);

      await waitFor(() => startCount >= 3, 2000);
      expect(startCount).toBe(3);

      // Supervisor should still be running after 2 restarts (within limit of 3)
      expect(Supervisor.isRunning(supervisor)).toBe(true);

      await Supervisor.stop(supervisor);
    });
  });
});
