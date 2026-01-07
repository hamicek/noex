import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BehaviorRegistry } from '../../../src/distribution/remote/behavior-registry.js';
import type { GenServerBehavior } from '../../../src/core/types.js';

describe('BehaviorRegistry', () => {
  // Create test behaviors
  const createCounterBehavior = (): GenServerBehavior<number, 'get' | 'inc', 'inc', number> => ({
    init: () => 0,
    handleCall: (msg, state) => (msg === 'get' ? [state, state] : [state + 1, state + 1]),
    handleCast: (_msg, state) => state + 1,
  });

  const createCacheBehavior = (): GenServerBehavior<
    Map<string, unknown>,
    { type: 'get'; key: string } | { type: 'set'; key: string; value: unknown },
    { type: 'delete'; key: string },
    unknown
  > => ({
    init: () => new Map(),
    handleCall: (msg, state) => {
      if (msg.type === 'get') {
        return [state.get(msg.key), state];
      }
      const newState = new Map(state);
      newState.set(msg.key, msg.value);
      return [undefined, newState];
    },
    handleCast: (msg, state) => {
      const newState = new Map(state);
      newState.delete(msg.key);
      return newState;
    },
  });

  beforeEach(() => {
    BehaviorRegistry._clear();
  });

  afterEach(() => {
    BehaviorRegistry._clear();
  });

  describe('register', () => {
    it('registers a behavior successfully', () => {
      const behavior = createCounterBehavior();

      expect(() => BehaviorRegistry.register('counter', behavior)).not.toThrow();
      expect(BehaviorRegistry.has('counter')).toBe(true);
    });

    it('registers multiple behaviors', () => {
      const counter = createCounterBehavior();
      const cache = createCacheBehavior();

      BehaviorRegistry.register('counter', counter);
      BehaviorRegistry.register('cache', cache);

      expect(BehaviorRegistry.has('counter')).toBe(true);
      expect(BehaviorRegistry.has('cache')).toBe(true);
      expect(BehaviorRegistry.getStats().count).toBe(2);
    });

    it('throws when registering duplicate name', () => {
      const behavior = createCounterBehavior();

      BehaviorRegistry.register('counter', behavior);

      expect(() => BehaviorRegistry.register('counter', behavior)).toThrow(
        "Behavior 'counter' is already registered",
      );
    });

    it('throws when name is empty', () => {
      const behavior = createCounterBehavior();

      expect(() => BehaviorRegistry.register('', behavior)).toThrow(
        'Behavior name must be a non-empty string',
      );
    });

    it('throws when name is not a string', () => {
      const behavior = createCounterBehavior();

      expect(() => BehaviorRegistry.register(null as unknown as string, behavior)).toThrow(
        'Behavior name must be a non-empty string',
      );
      expect(() => BehaviorRegistry.register(123 as unknown as string, behavior)).toThrow(
        'Behavior name must be a non-empty string',
      );
    });

    it('throws when behavior is null or undefined', () => {
      expect(() => BehaviorRegistry.register('test', null as unknown as GenServerBehavior<unknown, unknown, unknown, unknown>)).toThrow(
        'Behavior must be an object',
      );
      expect(() => BehaviorRegistry.register('test', undefined as unknown as GenServerBehavior<unknown, unknown, unknown, unknown>)).toThrow(
        'Behavior must be an object',
      );
    });

    it('throws when behavior lacks init function', () => {
      const invalidBehavior = {
        handleCall: () => [null, null] as const,
        handleCast: () => null,
      };

      expect(() => BehaviorRegistry.register('test', invalidBehavior as unknown as GenServerBehavior<unknown, unknown, unknown, unknown>)).toThrow(
        'Behavior must have an init function',
      );
    });

    it('throws when behavior lacks handleCall function', () => {
      const invalidBehavior = {
        init: () => null,
        handleCast: () => null,
      };

      expect(() => BehaviorRegistry.register('test', invalidBehavior as unknown as GenServerBehavior<unknown, unknown, unknown, unknown>)).toThrow(
        'Behavior must have a handleCall function',
      );
    });

    it('throws when behavior lacks handleCast function', () => {
      const invalidBehavior = {
        init: () => null,
        handleCall: () => [null, null] as const,
      };

      expect(() => BehaviorRegistry.register('test', invalidBehavior as unknown as GenServerBehavior<unknown, unknown, unknown, unknown>)).toThrow(
        'Behavior must have a handleCast function',
      );
    });

    it('accepts behavior with optional terminate function', () => {
      const behavior: GenServerBehavior<number, unknown, unknown, unknown> = {
        init: () => 0,
        handleCall: (_msg, state) => [state, state],
        handleCast: (_msg, state) => state,
        terminate: () => {},
      };

      expect(() => BehaviorRegistry.register('with-terminate', behavior)).not.toThrow();
      expect(BehaviorRegistry.has('with-terminate')).toBe(true);
    });
  });

  describe('get', () => {
    it('returns registered behavior', () => {
      const behavior = createCounterBehavior();
      BehaviorRegistry.register('counter', behavior);

      const retrieved = BehaviorRegistry.get<number, 'get' | 'inc', 'inc', number>('counter');

      expect(retrieved).toBe(behavior);
    });

    it('returns undefined for non-existent behavior', () => {
      const retrieved = BehaviorRegistry.get('nonexistent');

      expect(retrieved).toBeUndefined();
    });

    it('preserves behavior functionality', async () => {
      const behavior = createCounterBehavior();
      BehaviorRegistry.register('counter', behavior);

      const retrieved = BehaviorRegistry.get<number, 'get' | 'inc', 'inc', number>('counter');

      expect(retrieved).toBeDefined();
      expect(retrieved!.init()).toBe(0);
      expect(retrieved!.handleCall('get', 5)).toEqual([5, 5]);
      expect(retrieved!.handleCast('inc', 5)).toBe(6);
    });
  });

  describe('has', () => {
    it('returns true for registered behavior', () => {
      const behavior = createCounterBehavior();
      BehaviorRegistry.register('counter', behavior);

      expect(BehaviorRegistry.has('counter')).toBe(true);
    });

    it('returns false for non-existent behavior', () => {
      expect(BehaviorRegistry.has('nonexistent')).toBe(false);
    });

    it('returns false after unregister', () => {
      const behavior = createCounterBehavior();
      BehaviorRegistry.register('counter', behavior);
      BehaviorRegistry.unregister('counter');

      expect(BehaviorRegistry.has('counter')).toBe(false);
    });
  });

  describe('unregister', () => {
    it('removes registered behavior', () => {
      const behavior = createCounterBehavior();
      BehaviorRegistry.register('counter', behavior);

      const result = BehaviorRegistry.unregister('counter');

      expect(result).toBe(true);
      expect(BehaviorRegistry.has('counter')).toBe(false);
    });

    it('returns false for non-existent behavior', () => {
      const result = BehaviorRegistry.unregister('nonexistent');

      expect(result).toBe(false);
    });

    it('allows re-registration after unregister', () => {
      const behavior1 = createCounterBehavior();
      const behavior2 = createCounterBehavior();

      BehaviorRegistry.register('counter', behavior1);
      BehaviorRegistry.unregister('counter');

      expect(() => BehaviorRegistry.register('counter', behavior2)).not.toThrow();
      expect(BehaviorRegistry.get('counter')).toBe(behavior2);
    });
  });

  describe('getNames', () => {
    it('returns empty array when no behaviors registered', () => {
      const names = BehaviorRegistry.getNames();

      expect(names).toEqual([]);
    });

    it('returns all registered behavior names', () => {
      BehaviorRegistry.register('counter', createCounterBehavior());
      BehaviorRegistry.register('cache', createCacheBehavior());

      const names = BehaviorRegistry.getNames();

      expect(names).toHaveLength(2);
      expect(names).toContain('counter');
      expect(names).toContain('cache');
    });

    it('returns readonly array', () => {
      BehaviorRegistry.register('counter', createCounterBehavior());

      const names = BehaviorRegistry.getNames();

      // TypeScript should prevent mutation, but let's verify runtime behavior
      expect(Object.isFrozen(names)).toBe(false); // Array.from doesn't freeze
      // But it's a copy, so mutations don't affect the registry
      (names as string[]).push('test');
      expect(BehaviorRegistry.getNames()).not.toContain('test');
    });
  });

  describe('getStats', () => {
    it('returns correct count when empty', () => {
      const stats = BehaviorRegistry.getStats();

      expect(stats.count).toBe(0);
      expect(stats.names).toEqual([]);
    });

    it('returns correct count after registrations', () => {
      BehaviorRegistry.register('counter', createCounterBehavior());
      BehaviorRegistry.register('cache', createCacheBehavior());

      const stats = BehaviorRegistry.getStats();

      expect(stats.count).toBe(2);
      expect(stats.names).toHaveLength(2);
      expect(stats.names).toContain('counter');
      expect(stats.names).toContain('cache');
    });

    it('updates after unregister', () => {
      BehaviorRegistry.register('counter', createCounterBehavior());
      BehaviorRegistry.register('cache', createCacheBehavior());
      BehaviorRegistry.unregister('counter');

      const stats = BehaviorRegistry.getStats();

      expect(stats.count).toBe(1);
      expect(stats.names).toEqual(['cache']);
    });
  });

  describe('_clear', () => {
    it('removes all registered behaviors', () => {
      BehaviorRegistry.register('counter', createCounterBehavior());
      BehaviorRegistry.register('cache', createCacheBehavior());

      BehaviorRegistry._clear();

      expect(BehaviorRegistry.getStats().count).toBe(0);
      expect(BehaviorRegistry.has('counter')).toBe(false);
      expect(BehaviorRegistry.has('cache')).toBe(false);
    });

    it('allows new registrations after clear', () => {
      BehaviorRegistry.register('counter', createCounterBehavior());
      BehaviorRegistry._clear();

      expect(() => BehaviorRegistry.register('counter', createCounterBehavior())).not.toThrow();
      expect(BehaviorRegistry.has('counter')).toBe(true);
    });
  });

  describe('type safety', () => {
    it('preserves generic types through register and get', () => {
      interface MyState {
        value: number;
        name: string;
      }
      type MyCallMsg = { type: 'getValue' } | { type: 'getName' };
      type MyCastMsg = { type: 'increment' };
      type MyReply = number | string;

      const behavior: GenServerBehavior<MyState, MyCallMsg, MyCastMsg, MyReply> = {
        init: () => ({ value: 0, name: 'test' }),
        handleCall: (msg, state) => {
          if (msg.type === 'getValue') {
            return [state.value, state];
          }
          return [state.name, state];
        },
        handleCast: (msg, state) => {
          if (msg.type === 'increment') {
            return { ...state, value: state.value + 1 };
          }
          return state;
        },
      };

      BehaviorRegistry.register('typed', behavior);
      const retrieved = BehaviorRegistry.get<MyState, MyCallMsg, MyCastMsg, MyReply>('typed');

      expect(retrieved).toBeDefined();
      // This tests that the behavior works correctly
      const initialState = retrieved!.init();
      expect(initialState).toEqual({ value: 0, name: 'test' });

      const [reply1, state1] = retrieved!.handleCall({ type: 'getValue' }, initialState);
      expect(reply1).toBe(0);

      const [reply2] = retrieved!.handleCall({ type: 'getName' }, state1);
      expect(reply2).toBe('test');
    });
  });

  describe('async behaviors', () => {
    it('supports async init function', async () => {
      const behavior: GenServerBehavior<number, unknown, unknown, unknown> = {
        init: async () => {
          await new Promise(resolve => setTimeout(resolve, 1));
          return 42;
        },
        handleCall: (_msg, state) => [state, state],
        handleCast: (_msg, state) => state,
      };

      BehaviorRegistry.register('async', behavior);
      const retrieved = BehaviorRegistry.get<number, unknown, unknown, unknown>('async');

      const state = await retrieved!.init();
      expect(state).toBe(42);
    });

    it('supports async handleCall function', async () => {
      const behavior: GenServerBehavior<number, 'get', unknown, number> = {
        init: () => 0,
        handleCall: async (_msg, state) => {
          await new Promise(resolve => setTimeout(resolve, 1));
          return [state, state];
        },
        handleCast: (_msg, state) => state,
      };

      BehaviorRegistry.register('async-call', behavior);
      const retrieved = BehaviorRegistry.get<number, 'get', unknown, number>('async-call');

      const [reply, newState] = await retrieved!.handleCall('get', 5);
      expect(reply).toBe(5);
      expect(newState).toBe(5);
    });
  });
});
