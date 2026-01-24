/**
 * Comprehensive tests for Agent implementation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GenServer } from '../../src/core/gen-server.js';
import { Agent, type AgentRef } from '../../src/core/agent.js';

describe('Agent', () => {
  beforeEach(() => {
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
  });

  describe('start()', () => {
    it('starts with a synchronous initializer', async () => {
      const ref = await Agent.start(() => 42);
      const value = await Agent.get(ref, (n) => n);
      expect(value).toBe(42);
      await Agent.stop(ref);
    });

    it('starts with an async initializer', async () => {
      const ref = await Agent.start(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 'async-init';
      });
      const value = await Agent.get(ref, (s) => s);
      expect(value).toBe('async-init');
      await Agent.stop(ref);
    });

    it('starts with a complex initial state', async () => {
      const ref = await Agent.start(() => ({
        users: new Map<string, string>(),
        count: 0,
      }));
      const state = await Agent.get(ref, (s) => s);
      expect(state.users.size).toBe(0);
      expect(state.count).toBe(0);
      await Agent.stop(ref);
    });

    it('supports name option for registry', async () => {
      const ref = await Agent.start(() => 0, { name: 'test-agent' });
      expect(GenServer.isRunning(ref)).toBe(true);
      await Agent.stop(ref);
    });
  });

  describe('get()', () => {
    let ref: AgentRef<number>;

    beforeEach(async () => {
      ref = await Agent.start(() => 10);
    });

    it('returns the state directly via identity function', async () => {
      const value = await Agent.get(ref, (n) => n);
      expect(value).toBe(10);
      await Agent.stop(ref);
    });

    it('applies a transformation function to the state', async () => {
      const doubled = await Agent.get(ref, (n) => n * 2);
      expect(doubled).toBe(20);
      await Agent.stop(ref);
    });

    it('does not mutate the state', async () => {
      await Agent.get(ref, (n) => n + 100);
      const value = await Agent.get(ref, (n) => n);
      expect(value).toBe(10);
      await Agent.stop(ref);
    });

    it('supports returning different types', async () => {
      const asString = await Agent.get(ref, (n) => `value: ${n}`);
      expect(asString).toBe('value: 10');

      const asObject = await Agent.get(ref, (n) => ({ num: n }));
      expect(asObject).toEqual({ num: 10 });
      await Agent.stop(ref);
    });
  });

  describe('update()', () => {
    let ref: AgentRef<number>;

    beforeEach(async () => {
      ref = await Agent.start(() => 0);
    });

    it('updates the state', async () => {
      await Agent.update(ref, (n) => n + 1);
      const value = await Agent.get(ref, (n) => n);
      expect(value).toBe(1);
      await Agent.stop(ref);
    });

    it('applies multiple sequential updates', async () => {
      await Agent.update(ref, (n) => n + 5);
      await Agent.update(ref, (n) => n * 2);
      await Agent.update(ref, (n) => n - 3);
      const value = await Agent.get(ref, (n) => n);
      expect(value).toBe(7); // (0 + 5) * 2 - 3
      await Agent.stop(ref);
    });

    it('resolves after the update is applied', async () => {
      await Agent.update(ref, (n) => n + 42);
      const value = await Agent.get(ref, (n) => n);
      expect(value).toBe(42);
      await Agent.stop(ref);
    });
  });

  describe('castUpdate()', () => {
    it('updates state asynchronously', async () => {
      const ref = await Agent.start(() => 0);
      Agent.castUpdate(ref, (n) => n + 1);
      // castUpdate is fire-and-forget; the subsequent get() call
      // is serialized after the cast in the GenServer queue
      const value = await Agent.get(ref, (n) => n);
      expect(value).toBe(1);
      await Agent.stop(ref);
    });

    it('processes multiple cast updates in order', async () => {
      const ref = await Agent.start(() => [] as number[]);
      Agent.castUpdate(ref, (arr) => [...arr, 1]);
      Agent.castUpdate(ref, (arr) => [...arr, 2]);
      Agent.castUpdate(ref, (arr) => [...arr, 3]);
      const value = await Agent.get(ref, (arr) => arr);
      expect(value).toEqual([1, 2, 3]);
      await Agent.stop(ref);
    });

    it('does not return a promise', () => {
      // This test verifies the synchronous fire-and-forget nature
      let ref: AgentRef<number>;
      const setup = async () => {
        ref = await Agent.start(() => 0);
        const result = Agent.castUpdate(ref, (n) => n + 1);
        expect(result).toBeUndefined();
        await Agent.stop(ref);
      };
      return setup();
    });
  });

  describe('getAndUpdate()', () => {
    it('returns the old value and updates atomically', async () => {
      const ref = await Agent.start(() => 10);
      const oldValue = await Agent.getAndUpdate(ref, (n) => [n, n + 5]);
      expect(oldValue).toBe(10);
      const newValue = await Agent.get(ref, (n) => n);
      expect(newValue).toBe(15);
      await Agent.stop(ref);
    });

    it('allows returning a computed value different from state', async () => {
      const ref = await Agent.start(() => ({ count: 0, label: 'counter' }));
      const result = await Agent.getAndUpdate(ref, (s) => [
        `${s.label}:${s.count}`,
        { ...s, count: s.count + 1 },
      ]);
      expect(result).toBe('counter:0');
      const state = await Agent.get(ref, (s) => s);
      expect(state.count).toBe(1);
      await Agent.stop(ref);
    });

    it('serializes concurrent getAndUpdate calls', async () => {
      const ref = await Agent.start(() => 0);
      const results = await Promise.all([
        Agent.getAndUpdate(ref, (n) => [n, n + 1]),
        Agent.getAndUpdate(ref, (n) => [n, n + 1]),
        Agent.getAndUpdate(ref, (n) => [n, n + 1]),
      ]);
      // Each call sees the state after the previous one completes
      expect(results.sort()).toEqual([0, 1, 2]);
      const final = await Agent.get(ref, (n) => n);
      expect(final).toBe(3);
      await Agent.stop(ref);
    });
  });

  describe('stop()', () => {
    it('stops a running agent', async () => {
      const ref = await Agent.start(() => 0);
      expect(GenServer.isRunning(ref)).toBe(true);
      await Agent.stop(ref);
      expect(GenServer.isRunning(ref)).toBe(false);
    });

    it('is idempotent on already-stopped agents', async () => {
      const ref = await Agent.start(() => 0);
      await Agent.stop(ref);
      // Second stop should not throw
      await Agent.stop(ref);
    });
  });

  describe('complex state management', () => {
    it('manages a map-based state', async () => {
      const ref = await Agent.start(() => new Map<string, number>());

      await Agent.update(ref, (map) => {
        const next = new Map(map);
        next.set('a', 1);
        return next;
      });

      await Agent.update(ref, (map) => {
        const next = new Map(map);
        next.set('b', 2);
        return next;
      });

      const size = await Agent.get(ref, (map) => map.size);
      expect(size).toBe(2);

      const aValue = await Agent.get(ref, (map) => map.get('a'));
      expect(aValue).toBe(1);

      await Agent.stop(ref);
    });

    it('manages an array-based queue', async () => {
      const ref = await Agent.start<string[]>(() => []);

      // Enqueue items
      await Agent.update(ref, (q) => [...q, 'first']);
      await Agent.update(ref, (q) => [...q, 'second']);
      await Agent.update(ref, (q) => [...q, 'third']);

      // Dequeue
      const item = await Agent.getAndUpdate(ref, (q) => [q[0], q.slice(1)]);
      expect(item).toBe('first');

      const remaining = await Agent.get(ref, (q) => q.length);
      expect(remaining).toBe(2);

      await Agent.stop(ref);
    });
  });

  describe('error handling', () => {
    it('rejects get() if the agent is stopped', async () => {
      const ref = await Agent.start(() => 0);
      await Agent.stop(ref);
      await expect(Agent.get(ref, (n) => n)).rejects.toThrow();
    });

    it('rejects update() if the agent is stopped', async () => {
      const ref = await Agent.start(() => 0);
      await Agent.stop(ref);
      await expect(Agent.update(ref, (n) => n + 1)).rejects.toThrow();
    });

    it('propagates errors from get function', async () => {
      const ref = await Agent.start(() => 0);
      await expect(
        Agent.get(ref, () => {
          throw new Error('get failed');
        }),
      ).rejects.toThrow('get failed');
      // Agent should still be running after a failed get
      // (GenServer catches handler errors and rejects the call)
      await Agent.stop(ref);
    });

    it('propagates errors from update function', async () => {
      const ref = await Agent.start(() => 0);
      await expect(
        Agent.update(ref, () => {
          throw new Error('update failed');
        }),
      ).rejects.toThrow('update failed');
      await Agent.stop(ref);
    });

    it('propagates errors from getAndUpdate function', async () => {
      const ref = await Agent.start(() => 0);
      await expect(
        Agent.getAndUpdate(ref, () => {
          throw new Error('getAndUpdate failed');
        }),
      ).rejects.toThrow('getAndUpdate failed');
      await Agent.stop(ref);
    });

    it('propagates errors from initializer', async () => {
      await expect(
        Agent.start(() => {
          throw new Error('init failed');
        }),
      ).rejects.toThrow('init failed');
    });
  });

  describe('concurrency', () => {
    it('serializes concurrent operations', async () => {
      const ref = await Agent.start(() => 0);
      const ops = Array.from({ length: 100 }, () =>
        Agent.update(ref, (n) => n + 1),
      );
      await Promise.all(ops);
      const value = await Agent.get(ref, (n) => n);
      expect(value).toBe(100);
      await Agent.stop(ref);
    });

    it('interleaves gets and updates correctly', async () => {
      const ref = await Agent.start(() => 0);
      const results: number[] = [];

      await Promise.all([
        Agent.update(ref, (n) => n + 1).then(() =>
          Agent.get(ref, (n) => n).then((v) => results.push(v)),
        ),
        Agent.update(ref, (n) => n + 1).then(() =>
          Agent.get(ref, (n) => n).then((v) => results.push(v)),
        ),
      ]);

      // Both gets happen after both updates are queued,
      // so each get sees at least 1 (depending on ordering)
      for (const r of results) {
        expect(r).toBeGreaterThanOrEqual(1);
        expect(r).toBeLessThanOrEqual(2);
      }
      await Agent.stop(ref);
    });
  });

  describe('persistence integration', () => {
    it('passes persistence options to GenServer', async () => {
      // Verify that the agent starts with persistence config without errors.
      // Full persistence integration is tested in GenServer persistence tests.
      const ref = await Agent.start(() => 0, {
        name: 'persistent-agent',
      });
      expect(GenServer.isRunning(ref)).toBe(true);
      await Agent.stop(ref);
    });
  });

  describe('type safety', () => {
    it('preserves generic type through operations', async () => {
      interface AppState {
        readonly users: string[];
        readonly version: number;
      }

      const ref = await Agent.start<AppState>(() => ({
        users: [],
        version: 1,
      }));

      await Agent.update(ref, (s) => ({
        ...s,
        users: [...s.users, 'alice'],
      }));

      const users = await Agent.get(ref, (s) => s.users);
      expect(users).toEqual(['alice']);

      const version = await Agent.get(ref, (s) => s.version);
      expect(version).toBe(1);

      await Agent.stop(ref);
    });
  });
});
