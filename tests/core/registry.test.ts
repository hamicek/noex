/**
 * Comprehensive tests for Registry implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  GenServer,
  Registry,
  type GenServerBehavior,
  type GenServerRef,
  NotRegisteredError,
  AlreadyRegisteredError,
} from '../../src/index.js';

/**
 * Creates a simple counter behavior for testing.
 */
function createCounterBehavior(): GenServerBehavior<
  number,
  'get',
  'inc',
  number
> {
  return {
    init: () => 0,
    handleCall: (msg, state) => {
      if (msg === 'get') {
        return [state, state];
      }
      throw new Error(`Unknown call: ${msg}`);
    },
    handleCast: (msg, state) => {
      if (msg === 'inc') {
        return state + 1;
      }
      return state;
    },
  };
}

describe('Registry', () => {
  beforeEach(() => {
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
    Registry._clearLifecycleHandler();
    Registry._clear();
  });

  afterEach(async () => {
    // Stop any remaining servers
    const names = Registry.getNames();
    for (const name of names) {
      const ref = Registry.whereis(name);
      if (ref && GenServer.isRunning(ref)) {
        await GenServer.stop(ref);
      }
    }
    Registry._clearLifecycleHandler();
    Registry._clear();
    GenServer._clearLifecycleHandlers();
  });

  describe('register()', () => {
    it('registers a GenServer under a name', async () => {
      const ref = await GenServer.start(createCounterBehavior());

      Registry.register('counter', ref);

      expect(Registry.isRegistered('counter')).toBe(true);
      await GenServer.stop(ref);
    });

    it('throws AlreadyRegisteredError for duplicate names', async () => {
      const ref1 = await GenServer.start(createCounterBehavior());
      const ref2 = await GenServer.start(createCounterBehavior());

      Registry.register('counter', ref1);

      expect(() => Registry.register('counter', ref2)).toThrow(
        AlreadyRegisteredError,
      );
      expect(() => Registry.register('counter', ref2)).toThrow(
        "Name 'counter' is already registered",
      );

      await Promise.all([GenServer.stop(ref1), GenServer.stop(ref2)]);
    });

    it('allows same ref to be registered under different names', async () => {
      const ref = await GenServer.start(createCounterBehavior());

      Registry.register('name1', ref);
      Registry.register('name2', ref);

      expect(Registry.lookup('name1').id).toBe(ref.id);
      expect(Registry.lookup('name2').id).toBe(ref.id);

      await GenServer.stop(ref);
    });
  });

  describe('lookup()', () => {
    it('returns the registered reference', async () => {
      const ref = await GenServer.start(createCounterBehavior());
      Registry.register('counter', ref);

      const lookedUp = Registry.lookup<number, 'get', 'inc', number>('counter');

      expect(lookedUp.id).toBe(ref.id);
      await GenServer.stop(ref);
    });

    it('throws NotRegisteredError for unknown names', () => {
      expect(() => Registry.lookup('unknown')).toThrow(NotRegisteredError);
      expect(() => Registry.lookup('unknown')).toThrow(
        "No process registered under name 'unknown'",
      );
    });

    it('allows using the returned ref for GenServer operations', async () => {
      const ref = await GenServer.start(createCounterBehavior());
      Registry.register('counter', ref);

      const lookedUp = Registry.lookup<number, 'get', 'inc', number>('counter');

      GenServer.cast(lookedUp, 'inc');
      GenServer.cast(lookedUp, 'inc');

      await new Promise((r) => setTimeout(r, 50));

      const value = await GenServer.call(lookedUp, 'get');
      expect(value).toBe(2);

      await GenServer.stop(ref);
    });
  });

  describe('whereis()', () => {
    it('returns the registered reference', async () => {
      const ref = await GenServer.start(createCounterBehavior());
      Registry.register('counter', ref);

      const found = Registry.whereis('counter');

      expect(found).toBeDefined();
      expect(found!.id).toBe(ref.id);

      await GenServer.stop(ref);
    });

    it('returns undefined for unknown names', () => {
      const result = Registry.whereis('unknown');
      expect(result).toBeUndefined();
    });

    it('is useful for conditional access patterns', async () => {
      const counter = Registry.whereis('counter');
      expect(counter).toBeUndefined();

      const ref = await GenServer.start(createCounterBehavior());
      Registry.register('counter', ref);

      const counterNow = Registry.whereis('counter');
      expect(counterNow).toBeDefined();

      await GenServer.stop(ref);
    });
  });

  describe('unregister()', () => {
    it('removes the name mapping', async () => {
      const ref = await GenServer.start(createCounterBehavior());
      Registry.register('counter', ref);

      Registry.unregister('counter');

      expect(Registry.isRegistered('counter')).toBe(false);
      expect(Registry.whereis('counter')).toBeUndefined();

      await GenServer.stop(ref);
    });

    it('is idempotent - unregistering unknown name does not throw', () => {
      expect(() => Registry.unregister('unknown')).not.toThrow();
      expect(() => Registry.unregister('unknown')).not.toThrow();
    });

    it('does not stop the process', async () => {
      const ref = await GenServer.start(createCounterBehavior());
      Registry.register('counter', ref);

      Registry.unregister('counter');

      expect(GenServer.isRunning(ref)).toBe(true);

      // Process should still be usable directly
      const value = await GenServer.call(ref, 'get');
      expect(value).toBe(0);

      await GenServer.stop(ref);
    });

    it('allows re-registration after unregister', async () => {
      const ref1 = await GenServer.start(createCounterBehavior());
      const ref2 = await GenServer.start(createCounterBehavior());

      Registry.register('counter', ref1);
      Registry.unregister('counter');
      Registry.register('counter', ref2);

      expect(Registry.lookup('counter').id).toBe(ref2.id);

      await Promise.all([GenServer.stop(ref1), GenServer.stop(ref2)]);
    });
  });

  describe('isRegistered()', () => {
    it('returns true for registered names', async () => {
      const ref = await GenServer.start(createCounterBehavior());
      Registry.register('counter', ref);

      expect(Registry.isRegistered('counter')).toBe(true);

      await GenServer.stop(ref);
    });

    it('returns false for unregistered names', () => {
      expect(Registry.isRegistered('unknown')).toBe(false);
    });

    it('returns false after unregister', async () => {
      const ref = await GenServer.start(createCounterBehavior());
      Registry.register('counter', ref);

      Registry.unregister('counter');

      expect(Registry.isRegistered('counter')).toBe(false);

      await GenServer.stop(ref);
    });
  });

  describe('getNames()', () => {
    it('returns empty array when nothing is registered', () => {
      expect(Registry.getNames()).toEqual([]);
    });

    it('returns all registered names', async () => {
      const ref1 = await GenServer.start(createCounterBehavior());
      const ref2 = await GenServer.start(createCounterBehavior());
      const ref3 = await GenServer.start(createCounterBehavior());

      Registry.register('counter1', ref1);
      Registry.register('counter2', ref2);
      Registry.register('counter3', ref3);

      const names = Registry.getNames();
      expect(names).toHaveLength(3);
      expect(names).toContain('counter1');
      expect(names).toContain('counter2');
      expect(names).toContain('counter3');

      await Promise.all([
        GenServer.stop(ref1),
        GenServer.stop(ref2),
        GenServer.stop(ref3),
      ]);
    });

    it('reflects changes after registration/unregistration', async () => {
      const ref = await GenServer.start(createCounterBehavior());

      expect(Registry.getNames()).toHaveLength(0);

      Registry.register('counter', ref);
      expect(Registry.getNames()).toHaveLength(1);

      Registry.unregister('counter');
      expect(Registry.getNames()).toHaveLength(0);

      await GenServer.stop(ref);
    });
  });

  describe('count()', () => {
    it('returns 0 when nothing is registered', () => {
      expect(Registry.count()).toBe(0);
    });

    it('returns correct count', async () => {
      const ref1 = await GenServer.start(createCounterBehavior());
      const ref2 = await GenServer.start(createCounterBehavior());

      expect(Registry.count()).toBe(0);

      Registry.register('c1', ref1);
      expect(Registry.count()).toBe(1);

      Registry.register('c2', ref2);
      expect(Registry.count()).toBe(2);

      Registry.unregister('c1');
      expect(Registry.count()).toBe(1);

      await Promise.all([GenServer.stop(ref1), GenServer.stop(ref2)]);
    });
  });

  describe('automatic cleanup on termination', () => {
    it('unregisters when GenServer is stopped', async () => {
      const ref = await GenServer.start(createCounterBehavior());
      Registry.register('counter', ref);

      expect(Registry.isRegistered('counter')).toBe(true);

      await GenServer.stop(ref);

      // Wait a tick for lifecycle event to propagate
      await new Promise((r) => setTimeout(r, 10));

      expect(Registry.isRegistered('counter')).toBe(false);
    });

    it('unregisters when GenServer is force terminated', async () => {
      const ref = await GenServer.start(createCounterBehavior());
      Registry.register('counter', ref);

      GenServer._forceTerminate(ref, 'shutdown');

      // Wait a tick for lifecycle event to propagate
      await new Promise((r) => setTimeout(r, 10));

      expect(Registry.isRegistered('counter')).toBe(false);
    });

    it('handles multiple terminations correctly', async () => {
      const ref1 = await GenServer.start(createCounterBehavior());
      const ref2 = await GenServer.start(createCounterBehavior());
      const ref3 = await GenServer.start(createCounterBehavior());

      Registry.register('c1', ref1);
      Registry.register('c2', ref2);
      Registry.register('c3', ref3);

      expect(Registry.count()).toBe(3);

      await GenServer.stop(ref1);
      await new Promise((r) => setTimeout(r, 10));

      expect(Registry.isRegistered('c1')).toBe(false);
      expect(Registry.isRegistered('c2')).toBe(true);
      expect(Registry.isRegistered('c3')).toBe(true);
      expect(Registry.count()).toBe(2);

      await GenServer.stop(ref2);
      await GenServer.stop(ref3);

      await new Promise((r) => setTimeout(r, 10));

      expect(Registry.count()).toBe(0);
    });

    it('only cleans up the name associated with the terminated ref', async () => {
      const ref1 = await GenServer.start(createCounterBehavior());
      const ref2 = await GenServer.start(createCounterBehavior());

      // Same ref under two names is a special case
      Registry.register('name1', ref1);
      Registry.register('name2', ref2);

      await GenServer.stop(ref1);
      await new Promise((r) => setTimeout(r, 10));

      // Only name1 should be cleaned up
      expect(Registry.isRegistered('name1')).toBe(false);
      expect(Registry.isRegistered('name2')).toBe(true);

      await GenServer.stop(ref2);
    });
  });

  describe('type safety', () => {
    it('preserves type parameters through lookup', async () => {
      type CounterState = number;
      type CounterCall = 'get' | { add: number };
      type CounterCast = 'inc' | 'dec';
      type CounterReply = number;

      const behavior: GenServerBehavior<
        CounterState,
        CounterCall,
        CounterCast,
        CounterReply
      > = {
        init: () => 0,
        handleCall: (msg, state) => {
          if (msg === 'get') return [state, state];
          if (typeof msg === 'object' && 'add' in msg)
            return [state + msg.add, state + msg.add];
          throw new Error('Unknown call');
        },
        handleCast: (msg, state) => {
          if (msg === 'inc') return state + 1;
          if (msg === 'dec') return state - 1;
          return state;
        },
      };

      const ref = await GenServer.start(behavior);
      Registry.register('typed-counter', ref);

      // Type parameters should be preserved
      const typed = Registry.lookup<
        CounterState,
        CounterCall,
        CounterCast,
        CounterReply
      >('typed-counter');

      // These should compile and work correctly
      const val = await GenServer.call(typed, 'get');
      expect(val).toBe(0);

      GenServer.cast(typed, 'inc');
      await new Promise((r) => setTimeout(r, 20));

      const val2 = await GenServer.call(typed, 'get');
      expect(val2).toBe(1);

      await GenServer.stop(ref);
    });
  });

  describe('edge cases', () => {
    it('handles empty string as name', async () => {
      const ref = await GenServer.start(createCounterBehavior());

      Registry.register('', ref);

      expect(Registry.isRegistered('')).toBe(true);
      expect(Registry.lookup('').id).toBe(ref.id);

      await GenServer.stop(ref);
    });

    it('handles special characters in names', async () => {
      const ref = await GenServer.start(createCounterBehavior());
      const specialName = 'service:v1.0/instance#1';

      Registry.register(specialName, ref);

      expect(Registry.isRegistered(specialName)).toBe(true);
      expect(Registry.lookup(specialName).id).toBe(ref.id);

      await GenServer.stop(ref);
    });

    it('handles unicode names', async () => {
      const ref = await GenServer.start(createCounterBehavior());
      const unicodeName = 'サービス-服务-сервис';

      Registry.register(unicodeName, ref);

      expect(Registry.isRegistered(unicodeName)).toBe(true);
      expect(Registry.lookup(unicodeName).id).toBe(ref.id);

      await GenServer.stop(ref);
    });

    it('handles very long names', async () => {
      const ref = await GenServer.start(createCounterBehavior());
      const longName = 'a'.repeat(10000);

      Registry.register(longName, ref);

      expect(Registry.isRegistered(longName)).toBe(true);
      expect(Registry.lookup(longName).id).toBe(ref.id);

      await GenServer.stop(ref);
    });

    it('maintains consistency under rapid registration/unregistration', async () => {
      const ref = await GenServer.start(createCounterBehavior());

      for (let i = 0; i < 100; i++) {
        Registry.register('counter', ref);
        expect(Registry.isRegistered('counter')).toBe(true);
        Registry.unregister('counter');
        expect(Registry.isRegistered('counter')).toBe(false);
      }

      await GenServer.stop(ref);
    });
  });
});
