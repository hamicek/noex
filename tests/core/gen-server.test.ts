/**
 * Comprehensive tests for GenServer implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GenServer,
  type GenServerBehavior,
  type GenServerRef,
  type LifecycleEvent,
  CallTimeoutError,
  ServerNotRunningError,
  InitializationError,
} from '../../src/index.js';

// Helper to create a simple counter behavior
function createCounterBehavior(): GenServerBehavior<
  number,
  'get' | { type: 'add'; value: number },
  'inc' | 'dec' | 'reset',
  number
> {
  return {
    init: () => 0,
    handleCall: (msg, state) => {
      if (msg === 'get') {
        return [state, state];
      }
      if (typeof msg === 'object' && msg.type === 'add') {
        const newState = state + msg.value;
        return [newState, newState];
      }
      throw new Error(`Unknown call message: ${JSON.stringify(msg)}`);
    },
    handleCast: (msg, state) => {
      switch (msg) {
        case 'inc':
          return state + 1;
        case 'dec':
          return state - 1;
        case 'reset':
          return 0;
        default:
          return state;
      }
    },
  };
}

describe('GenServer', () => {
  beforeEach(() => {
    // Reset internal state between tests
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
  });

  afterEach(() => {
    GenServer._clearLifecycleHandlers();
  });

  describe('start()', () => {
    it('starts a server with initial state from init()', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);

      expect(ref).toBeDefined();
      expect(ref.id).toMatch(/^genserver_/);
      expect(GenServer.isRunning(ref)).toBe(true);

      await GenServer.stop(ref);
    });

    it('handles async init()', async () => {
      const behavior: GenServerBehavior<string, 'get', never, string> = {
        init: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return 'initialized';
        },
        handleCall: (_, state) => [state, state],
        handleCast: (_, state) => state,
      };

      const ref = await GenServer.start(behavior);
      const result = await GenServer.call(ref, 'get');

      expect(result).toBe('initialized');
      await GenServer.stop(ref);
    });

    it('throws InitializationError when init() fails', async () => {
      const error = new Error('Init failed');
      const behavior: GenServerBehavior<never, never, never, never> = {
        init: () => {
          throw error;
        },
        handleCall: () => {
          throw new Error('Should not be called');
        },
        handleCast: () => {
          throw new Error('Should not be called');
        },
      };

      await expect(GenServer.start(behavior)).rejects.toThrow(InitializationError);

      try {
        await GenServer.start(behavior);
      } catch (e) {
        expect(e).toBeInstanceOf(InitializationError);
        expect((e as InitializationError).cause).toBe(error);
      }
    });

    it('throws InitializationError when init() times out', async () => {
      const behavior: GenServerBehavior<string, never, never, never> = {
        init: async () => {
          await new Promise((r) => setTimeout(r, 1000));
          return 'too late';
        },
        handleCall: () => {
          throw new Error('Should not be called');
        },
        handleCast: () => {
          throw new Error('Should not be called');
        },
      };

      await expect(
        GenServer.start(behavior, { initTimeout: 50 }),
      ).rejects.toThrow(InitializationError);
    });

    it('emits started lifecycle event', async () => {
      const events: LifecycleEvent[] = [];
      GenServer.onLifecycleEvent((e) => events.push(e));

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'started', ref });

      await GenServer.stop(ref);
    });
  });

  describe('call()', () => {
    it('sends a message and receives a reply', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);

      const result = await GenServer.call(ref, 'get');
      expect(result).toBe(0);

      await GenServer.stop(ref);
    });

    it('updates state and returns new value', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);

      const result = await GenServer.call(ref, { type: 'add', value: 5 });
      expect(result).toBe(5);

      const result2 = await GenServer.call(ref, { type: 'add', value: 3 });
      expect(result2).toBe(8);

      await GenServer.stop(ref);
    });

    it('throws CallTimeoutError when call times out', async () => {
      const behavior: GenServerBehavior<null, 'slow', never, string> = {
        init: () => null,
        handleCall: async () => {
          await new Promise((r) => setTimeout(r, 1000));
          return ['done', null];
        },
        handleCast: (_, state) => state,
      };

      const ref = await GenServer.start(behavior);

      await expect(
        GenServer.call(ref, 'slow', { timeout: 50 }),
      ).rejects.toThrow(CallTimeoutError);

      // Wait for the slow handler to complete before stopping
      await new Promise((r) => setTimeout(r, 100));
      await GenServer.stop(ref);
    });

    it('throws ServerNotRunningError when server is stopped', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);
      await GenServer.stop(ref);

      await expect(GenServer.call(ref, 'get')).rejects.toThrow(
        ServerNotRunningError,
      );
    });

    it('propagates errors from handleCall', async () => {
      const behavior: GenServerBehavior<null, 'error', never, never> = {
        init: () => null,
        handleCall: () => {
          throw new Error('Handler error');
        },
        handleCast: (_, state) => state,
      };

      const ref = await GenServer.start(behavior);

      await expect(GenServer.call(ref, 'error')).rejects.toThrow('Handler error');

      await GenServer.stop(ref);
    });

    it('serializes concurrent calls', async () => {
      const order: number[] = [];
      const behavior: GenServerBehavior<number, number, never, number> = {
        init: () => 0,
        handleCall: async (msg, state) => {
          order.push(msg);
          await new Promise((r) => setTimeout(r, 10));
          return [state + msg, state + msg];
        },
        handleCast: (_, state) => state,
      };

      const ref = await GenServer.start(behavior);

      // Fire multiple calls concurrently
      const results = await Promise.all([
        GenServer.call(ref, 1),
        GenServer.call(ref, 2),
        GenServer.call(ref, 3),
      ]);

      // Order should be preserved (FIFO)
      expect(order).toEqual([1, 2, 3]);
      // Results depend on serialized execution: 1, 3, 6
      expect(results).toEqual([1, 3, 6]);

      await GenServer.stop(ref);
    });
  });

  describe('cast()', () => {
    it('sends an async message and updates state', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);

      GenServer.cast(ref, 'inc');
      GenServer.cast(ref, 'inc');
      GenServer.cast(ref, 'inc');

      // Wait for casts to be processed
      await new Promise((r) => setTimeout(r, 50));

      const result = await GenServer.call(ref, 'get');
      expect(result).toBe(3);

      await GenServer.stop(ref);
    });

    it('throws ServerNotRunningError when server is stopped', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);
      await GenServer.stop(ref);

      expect(() => GenServer.cast(ref, 'inc')).toThrow(ServerNotRunningError);
    });

    it('silently ignores errors in handleCast', async () => {
      const behavior: GenServerBehavior<number, 'get', 'error' | 'inc', number> = {
        init: () => 0,
        handleCall: (_, state) => [state, state],
        handleCast: (msg, state) => {
          if (msg === 'error') {
            throw new Error('Cast error');
          }
          return state + 1;
        },
      };

      const ref = await GenServer.start(behavior);

      // Should not throw
      GenServer.cast(ref, 'error');
      GenServer.cast(ref, 'inc');

      await new Promise((r) => setTimeout(r, 50));

      // Server should still be running and state should be updated by 'inc'
      const result = await GenServer.call(ref, 'get');
      expect(result).toBe(1);

      await GenServer.stop(ref);
    });

    it('interleaves with calls in queue order', async () => {
      const order: string[] = [];
      const behavior: GenServerBehavior<null, 'call', 'cast', null> = {
        init: () => null,
        handleCall: async (_, state) => {
          order.push('call');
          await new Promise((r) => setTimeout(r, 5));
          return [null, state];
        },
        handleCast: async (_, state) => {
          order.push('cast');
          await new Promise((r) => setTimeout(r, 5));
          return state;
        },
      };

      const ref = await GenServer.start(behavior);

      const callPromise = GenServer.call(ref, 'call');
      GenServer.cast(ref, 'cast');
      await GenServer.call(ref, 'call');
      await callPromise;

      expect(order).toEqual(['call', 'cast', 'call']);

      await GenServer.stop(ref);
    });
  });

  describe('stop()', () => {
    it('gracefully stops the server', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);

      expect(GenServer.isRunning(ref)).toBe(true);

      await GenServer.stop(ref);

      expect(GenServer.isRunning(ref)).toBe(false);
    });

    it('calls terminate callback with reason and state', async () => {
      const terminateSpy = vi.fn();
      const behavior: GenServerBehavior<number, 'get', 'inc', number> = {
        init: () => 42,
        handleCall: (_, state) => [state, state],
        handleCast: (_, state) => state + 1,
        terminate: terminateSpy,
      };

      const ref = await GenServer.start(behavior);
      GenServer.cast(ref, 'inc');
      await new Promise((r) => setTimeout(r, 20));

      await GenServer.stop(ref, 'shutdown');

      expect(terminateSpy).toHaveBeenCalledTimes(1);
      expect(terminateSpy).toHaveBeenCalledWith('shutdown', 43);
    });

    it('handles async terminate callback', async () => {
      let terminated = false;
      const behavior: GenServerBehavior<null, never, never, never> = {
        init: () => null,
        handleCall: (_, state) => [undefined as never, state],
        handleCast: (_, state) => state,
        terminate: async () => {
          await new Promise((r) => setTimeout(r, 10));
          terminated = true;
        },
      };

      const ref = await GenServer.start(behavior);
      await GenServer.stop(ref);

      expect(terminated).toBe(true);
    });

    it('emits terminated lifecycle event', async () => {
      const events: LifecycleEvent[] = [];
      GenServer.onLifecycleEvent((e) => events.push(e));

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);
      await GenServer.stop(ref, 'shutdown');

      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({
        type: 'terminated',
        ref,
        reason: 'shutdown',
      });
    });

    it('is idempotent - stopping twice does not throw', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);

      await GenServer.stop(ref);
      await expect(GenServer.stop(ref)).resolves.toBeUndefined();
    });

    it('processes pending messages before stopping', async () => {
      let processedCalls = 0;
      const behavior: GenServerBehavior<number, 'get', never, number> = {
        init: () => 0,
        handleCall: async (_, state) => {
          await new Promise((r) => setTimeout(r, 10));
          processedCalls++;
          return [state, state];
        },
        handleCast: (_, state) => state,
      };

      const ref = await GenServer.start(behavior);

      // Queue up some calls
      const call1 = GenServer.call(ref, 'get');
      const call2 = GenServer.call(ref, 'get');

      // All queued calls should complete
      await Promise.all([call1, call2]);
      expect(processedCalls).toBe(2);

      await GenServer.stop(ref);
    });
  });

  describe('isRunning()', () => {
    it('returns true for running server', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);

      expect(GenServer.isRunning(ref)).toBe(true);

      await GenServer.stop(ref);
    });

    it('returns false for stopped server', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);
      await GenServer.stop(ref);

      expect(GenServer.isRunning(ref)).toBe(false);
    });

    it('returns false for non-existent server', () => {
      const fakeRef = { id: 'non_existent' } as GenServerRef;
      expect(GenServer.isRunning(fakeRef)).toBe(false);
    });
  });

  describe('onLifecycleEvent()', () => {
    it('registers handler and receives events', async () => {
      const events: LifecycleEvent[] = [];
      const unsubscribe = GenServer.onLifecycleEvent((e) => events.push(e));

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);
      await GenServer.stop(ref);

      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe('started');
      expect(events[1]?.type).toBe('terminated');

      unsubscribe();
    });

    it('returns unsubscribe function', async () => {
      const events: LifecycleEvent[] = [];
      const unsubscribe = GenServer.onLifecycleEvent((e) => events.push(e));

      const behavior = createCounterBehavior();
      const ref1 = await GenServer.start(behavior);

      unsubscribe();

      const ref2 = await GenServer.start(behavior);

      // Should only have event from first server
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('started');

      await GenServer.stop(ref1);
      await GenServer.stop(ref2);
    });

    it('handles errors in lifecycle handlers gracefully', async () => {
      const goodEvents: LifecycleEvent[] = [];

      GenServer.onLifecycleEvent(() => {
        throw new Error('Handler error');
      });
      GenServer.onLifecycleEvent((e) => goodEvents.push(e));

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);

      // Should still receive event in good handler
      expect(goodEvents).toHaveLength(1);

      await GenServer.stop(ref);
    });
  });

  describe('_forceTerminate()', () => {
    it('immediately terminates the server', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);

      GenServer._forceTerminate(ref, { error: new Error('forced') });

      expect(GenServer.isRunning(ref)).toBe(false);
    });

    it('rejects pending calls in queue', async () => {
      let firstCallStarted = false;
      const behavior: GenServerBehavior<null, 'slow', never, string> = {
        init: () => null,
        handleCall: async () => {
          firstCallStarted = true;
          await new Promise((r) => setTimeout(r, 500));
          return ['done', null];
        },
        handleCast: (_, state) => state,
      };

      const ref = await GenServer.start(behavior);

      // First call will start processing
      const firstCall = GenServer.call(ref, 'slow', { timeout: 5000 });

      // Wait for first call to start
      await vi.waitFor(() => expect(firstCallStarted).toBe(true));

      // Second call goes into queue
      const secondCall = GenServer.call(ref, 'slow', { timeout: 5000 });

      // Force terminate - should reject queued calls
      GenServer._forceTerminate(ref, 'shutdown');

      // First call may complete (already running), but second should be rejected
      await expect(secondCall).rejects.toThrow(ServerNotRunningError);

      // Clean up first call
      try {
        await firstCall;
      } catch {
        // May throw if terminate happened at just the right time
      }
    });
  });

  describe('edge cases', () => {
    it('handles multiple servers independently', async () => {
      const behavior = createCounterBehavior();

      const ref1 = await GenServer.start(behavior);
      const ref2 = await GenServer.start(behavior);

      GenServer.cast(ref1, 'inc');
      GenServer.cast(ref1, 'inc');
      GenServer.cast(ref2, 'inc');

      await new Promise((r) => setTimeout(r, 50));

      const val1 = await GenServer.call(ref1, 'get');
      const val2 = await GenServer.call(ref2, 'get');

      expect(val1).toBe(2);
      expect(val2).toBe(1);

      await Promise.all([GenServer.stop(ref1), GenServer.stop(ref2)]);
    });

    it('handles heavy message load', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);

      // Send 100 increment casts
      for (let i = 0; i < 100; i++) {
        GenServer.cast(ref, 'inc');
      }

      // Wait for all to process
      await new Promise((r) => setTimeout(r, 200));

      const result = await GenServer.call(ref, 'get');
      expect(result).toBe(100);

      await GenServer.stop(ref);
    });

    it('maintains state consistency under concurrent access', async () => {
      const behavior: GenServerBehavior<number, 'get', 'inc', number> = {
        init: () => 0,
        handleCall: (_, state) => [state, state],
        handleCast: async (_, state) => {
          // Simulate some async work
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          return state + 1;
        },
      };

      const ref = await GenServer.start(behavior);

      // Fire many concurrent casts
      for (let i = 0; i < 50; i++) {
        GenServer.cast(ref, 'inc');
      }

      // Wait for all to process
      await new Promise((r) => setTimeout(r, 500));

      const result = await GenServer.call(ref, 'get');
      expect(result).toBe(50);

      await GenServer.stop(ref);
    });
  });

  describe('introspection (Observer support)', () => {
    it('_getStats() returns correct statistics', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);
      const startTime = Date.now();

      // Process some messages
      GenServer.cast(ref, 'inc');
      GenServer.cast(ref, 'inc');
      await new Promise((r) => setTimeout(r, 20));
      await GenServer.call(ref, 'get');

      const stats = GenServer._getStats(ref);

      expect(stats).toBeDefined();
      expect(stats!.id).toBe(ref.id);
      expect(stats!.status).toBe('running');
      expect(stats!.messageCount).toBe(3); // 2 casts + 1 call
      expect(stats!.queueSize).toBe(0);
      expect(stats!.startedAt).toBeGreaterThanOrEqual(startTime - 10);
      expect(stats!.startedAt).toBeLessThanOrEqual(Date.now());
      expect(stats!.uptimeMs).toBeGreaterThan(0);

      await GenServer.stop(ref);
    });

    it('_getStats() returns undefined for stopped server', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);
      await GenServer.stop(ref);

      const stats = GenServer._getStats(ref);
      expect(stats).toBeUndefined();
    });

    it('_getAllStats() returns statistics for all running servers', async () => {
      const behavior = createCounterBehavior();
      const ref1 = await GenServer.start(behavior);
      const ref2 = await GenServer.start(behavior);
      const ref3 = await GenServer.start(behavior);

      GenServer.cast(ref1, 'inc');
      await new Promise((r) => setTimeout(r, 20));

      const allStats = GenServer._getAllStats();

      expect(allStats.length).toBe(3);
      expect(allStats.map((s) => s.id).sort()).toEqual(
        [ref1.id, ref2.id, ref3.id].sort()
      );

      const stats1 = allStats.find((s) => s.id === ref1.id);
      expect(stats1!.messageCount).toBe(1);

      await Promise.all([
        GenServer.stop(ref1),
        GenServer.stop(ref2),
        GenServer.stop(ref3),
      ]);
    });

    it('_getAllStats() returns empty array when no servers running', () => {
      const allStats = GenServer._getAllStats();
      expect(allStats).toEqual([]);
    });

    it('_getAllServerIds() returns all running server IDs', async () => {
      const behavior = createCounterBehavior();
      const ref1 = await GenServer.start(behavior);
      const ref2 = await GenServer.start(behavior);

      const ids = GenServer._getAllServerIds();

      expect(ids.length).toBe(2);
      expect(ids).toContain(ref1.id);
      expect(ids).toContain(ref2.id);

      await GenServer.stop(ref1);

      const idsAfterStop = GenServer._getAllServerIds();
      expect(idsAfterStop.length).toBe(1);
      expect(idsAfterStop).toContain(ref2.id);
      expect(idsAfterStop).not.toContain(ref1.id);

      await GenServer.stop(ref2);
    });

    it('messageCount correctly tracks both calls and casts', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);

      // Initial state
      let stats = GenServer._getStats(ref);
      expect(stats!.messageCount).toBe(0);

      // After casts
      GenServer.cast(ref, 'inc');
      GenServer.cast(ref, 'inc');
      GenServer.cast(ref, 'inc');
      await new Promise((r) => setTimeout(r, 50));

      stats = GenServer._getStats(ref);
      expect(stats!.messageCount).toBe(3);

      // After calls
      await GenServer.call(ref, 'get');
      await GenServer.call(ref, { type: 'add', value: 5 });

      stats = GenServer._getStats(ref);
      expect(stats!.messageCount).toBe(5);

      await GenServer.stop(ref);
    });

    it('queueSize reflects pending messages', async () => {
      const behavior: GenServerBehavior<null, 'slow', 'slow', null> = {
        init: () => null,
        handleCall: async (_, state) => {
          await new Promise((r) => setTimeout(r, 100));
          return [null, state];
        },
        handleCast: async (_, state) => {
          await new Promise((r) => setTimeout(r, 100));
          return state;
        },
      };

      const ref = await GenServer.start(behavior);

      // Start a slow call
      const slowCall = GenServer.call(ref, 'slow', { timeout: 5000 });

      // Queue more messages
      GenServer.cast(ref, 'slow');
      GenServer.cast(ref, 'slow');

      // Wait a bit for the first call to start processing
      await new Promise((r) => setTimeout(r, 10));

      const stats = GenServer._getStats(ref);
      // Queue should have the 2 casts (first call is being processed)
      expect(stats!.queueSize).toBe(2);

      // Clean up
      await slowCall;
      await new Promise((r) => setTimeout(r, 250));
      await GenServer.stop(ref);
    });
  });
});
