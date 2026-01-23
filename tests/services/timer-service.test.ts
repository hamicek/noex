/**
 * Tests for DurableTimerService.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GenServer,
  TimerService,
  MemoryAdapter,
  type GenServerBehavior,
  type TimerServiceRef,
} from '../../src/index.js';

function createAccumulatorBehavior(): GenServerBehavior<
  string[],
  'get',
  { type: 'append'; value: string },
  string[]
> {
  return {
    init: () => [],
    handleCall: (msg, state) => {
      if (msg === 'get') {
        return [state, state];
      }
      throw new Error(`Unknown call: ${JSON.stringify(msg)}`);
    },
    handleCast: (msg, state) => {
      if (msg.type === 'append') {
        return [...state, msg.value];
      }
      return state;
    },
  };
}

describe('TimerService', () => {
  let adapter: MemoryAdapter;
  let serviceRef: TimerServiceRef;

  beforeEach(async () => {
    vi.useFakeTimers();
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
    GenServer._clearTimers();
    TimerService._resetIdCounter();
    adapter = new MemoryAdapter();
  });

  afterEach(async () => {
    if (serviceRef && TimerService.isRunning(serviceRef)) {
      await TimerService.stop(serviceRef);
    }
    const ids = GenServer._getAllServerIds();
    for (const id of ids) {
      const ref = GenServer._getRefById(id);
      if (ref) {
        await GenServer.stop(ref);
      }
    }
    GenServer._clearLifecycleHandlers();
    GenServer._clearTimers();
    vi.useRealTimers();
  });

  describe('lifecycle', () => {
    it('starts and stops the service', async () => {
      serviceRef = await TimerService.start({ adapter });
      expect(TimerService.isRunning(serviceRef)).toBe(true);

      await TimerService.stop(serviceRef);
      expect(TimerService.isRunning(serviceRef)).toBe(false);
    });

    it('starts with a registered name', async () => {
      serviceRef = await TimerService.start({ adapter, name: 'my-timers' });
      expect(TimerService.isRunning(serviceRef)).toBe(true);
    });

    it('accepts custom checkIntervalMs', async () => {
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 500 });
      expect(TimerService.isRunning(serviceRef)).toBe(true);
    });
  });

  describe('schedule', () => {
    it('returns a unique timer ID', async () => {
      serviceRef = await TimerService.start({ adapter });
      const target = await GenServer.start(createAccumulatorBehavior());

      const id1 = await TimerService.schedule(serviceRef, target, { type: 'append', value: 'a' }, 1000);
      const id2 = await TimerService.schedule(serviceRef, target, { type: 'append', value: 'b' }, 2000);

      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
    });

    it('delivers a message after the delay via periodic tick', async () => {
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 100 });
      const target = await GenServer.start(createAccumulatorBehavior());

      await TimerService.schedule(serviceRef, target, { type: 'append', value: 'hello' }, 500);

      // Before timer fires
      await vi.advanceTimersByTimeAsync(400);
      expect(await GenServer.call(target, 'get')).toEqual([]);

      // After timer fires (tick at 500ms checks and delivers)
      await vi.advanceTimersByTimeAsync(200);
      expect(await GenServer.call(target, 'get')).toEqual(['hello']);
    });

    it('delivers multiple timers in sequence', async () => {
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 100 });
      const target = await GenServer.start(createAccumulatorBehavior());

      await TimerService.schedule(serviceRef, target, { type: 'append', value: 'first' }, 200);
      await TimerService.schedule(serviceRef, target, { type: 'append', value: 'second' }, 500);

      await vi.advanceTimersByTimeAsync(300);
      expect(await GenServer.call(target, 'get')).toEqual(['first']);

      await vi.advanceTimersByTimeAsync(300);
      expect(await GenServer.call(target, 'get')).toEqual(['first', 'second']);
    });

    it('silently discards message if target is stopped', async () => {
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 100 });
      const target = await GenServer.start(createAccumulatorBehavior());

      await TimerService.schedule(serviceRef, target, { type: 'append', value: 'ghost' }, 200);
      await GenServer.stop(target);

      // Should not throw
      await vi.advanceTimersByTimeAsync(300);
    });
  });

  describe('cancel', () => {
    it('prevents a scheduled timer from firing', async () => {
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 100 });
      const target = await GenServer.start(createAccumulatorBehavior());

      const timerId = await TimerService.schedule(serviceRef, target, { type: 'append', value: 'cancelled' }, 500);
      const result = await TimerService.cancel(serviceRef, timerId);

      expect(result).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);
      expect(await GenServer.call(target, 'get')).toEqual([]);
    });

    it('returns false for unknown timer ID', async () => {
      serviceRef = await TimerService.start({ adapter });

      const result = await TimerService.cancel(serviceRef, 'nonexistent');
      expect(result).toBe(false);
    });

    it('returns false for already-fired timer', async () => {
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 50 });
      const target = await GenServer.start(createAccumulatorBehavior());

      const timerId = await TimerService.schedule(serviceRef, target, { type: 'append', value: 'done' }, 100);

      await vi.advanceTimersByTimeAsync(200);

      const result = await TimerService.cancel(serviceRef, timerId);
      expect(result).toBe(false);
    });
  });

  describe('repeat timers', () => {
    it('fires repeatedly at the specified interval', async () => {
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 50 });
      const target = await GenServer.start(createAccumulatorBehavior());

      await TimerService.schedule(
        serviceRef, target,
        { type: 'append', value: 'tick' },
        100,
        { repeat: 100 },
      );

      await vi.advanceTimersByTimeAsync(150);
      expect(await GenServer.call(target, 'get')).toEqual(['tick']);

      await vi.advanceTimersByTimeAsync(100);
      expect(await GenServer.call(target, 'get')).toEqual(['tick', 'tick']);

      await vi.advanceTimersByTimeAsync(100);
      expect(await GenServer.call(target, 'get')).toEqual(['tick', 'tick', 'tick']);
    });

    it('can be cancelled to stop repetition', async () => {
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 50 });
      const target = await GenServer.start(createAccumulatorBehavior());

      const timerId = await TimerService.schedule(
        serviceRef, target,
        { type: 'append', value: 'rep' },
        100,
        { repeat: 100 },
      );

      await vi.advanceTimersByTimeAsync(150);
      expect(await GenServer.call(target, 'get')).toEqual(['rep']);

      await TimerService.cancel(serviceRef, timerId);

      await vi.advanceTimersByTimeAsync(500);
      // Should not have received more messages
      expect(await GenServer.call(target, 'get')).toEqual(['rep']);
    });
  });

  describe('get / getAll', () => {
    it('returns a timer entry by ID', async () => {
      serviceRef = await TimerService.start({ adapter });
      const target = await GenServer.start(createAccumulatorBehavior());

      const timerId = await TimerService.schedule(serviceRef, target, { type: 'append', value: 'x' }, 5000);
      const entry = await TimerService.get(serviceRef, timerId);

      expect(entry).toBeDefined();
      expect(entry!.id).toBe(timerId);
      expect(entry!.message).toEqual({ type: 'append', value: 'x' });
      expect(entry!.targetRef.id).toBe(target.id);
    });

    it('returns undefined for unknown timer ID', async () => {
      serviceRef = await TimerService.start({ adapter });

      const entry = await TimerService.get(serviceRef, 'nonexistent');
      expect(entry).toBeUndefined();
    });

    it('returns all pending timers', async () => {
      serviceRef = await TimerService.start({ adapter });
      const target = await GenServer.start(createAccumulatorBehavior());

      await TimerService.schedule(serviceRef, target, { type: 'append', value: 'a' }, 1000);
      await TimerService.schedule(serviceRef, target, { type: 'append', value: 'b' }, 2000);
      await TimerService.schedule(serviceRef, target, { type: 'append', value: 'c' }, 3000);

      const all = await TimerService.getAll(serviceRef);
      expect(all).toHaveLength(3);
    });
  });

  describe('persistence', () => {
    it('persists timer entries to the adapter on schedule', async () => {
      serviceRef = await TimerService.start({ adapter });
      const target = await GenServer.start(createAccumulatorBehavior());

      await TimerService.schedule(serviceRef, target, { type: 'append', value: 'persist-me' }, 5000);

      // Allow async persistence to complete
      await vi.advanceTimersByTimeAsync(0);

      const keys = await adapter.listKeys('durable_timer:');
      expect(keys.length).toBe(1);
    });

    it('removes persisted entry on cancel', async () => {
      serviceRef = await TimerService.start({ adapter });
      const target = await GenServer.start(createAccumulatorBehavior());

      const timerId = await TimerService.schedule(serviceRef, target, { type: 'append', value: 'x' }, 5000);
      await vi.advanceTimersByTimeAsync(0);

      await TimerService.cancel(serviceRef, timerId);
      await vi.advanceTimersByTimeAsync(0);

      const keys = await adapter.listKeys('durable_timer:');
      expect(keys.length).toBe(0);
    });

    it('removes persisted entry when one-shot timer fires', async () => {
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 50 });
      const target = await GenServer.start(createAccumulatorBehavior());

      await TimerService.schedule(serviceRef, target, { type: 'append', value: 'once' }, 100);
      await vi.advanceTimersByTimeAsync(0);

      expect((await adapter.listKeys('durable_timer:')).length).toBe(1);

      await vi.advanceTimersByTimeAsync(200);

      expect((await adapter.listKeys('durable_timer:')).length).toBe(0);
    });

    it('restores timers from adapter on restart', async () => {
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 100 });
      const target = await GenServer.start(createAccumulatorBehavior());

      await TimerService.schedule(serviceRef, target, { type: 'append', value: 'survives' }, 5000);
      await vi.advanceTimersByTimeAsync(0);

      // Stop the service (simulating crash/restart)
      await TimerService.stop(serviceRef);

      // Restart with same adapter - timers should be restored
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 100 });

      const all = await TimerService.getAll(serviceRef);
      expect(all).toHaveLength(1);
      expect(all[0].message).toEqual({ type: 'append', value: 'survives' });
    });

    it('delivers restored timers that have expired during downtime', async () => {
      vi.useRealTimers();
      // Use real timers for this test to get accurate Date.now()
      adapter = new MemoryAdapter();

      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 50 });
      const target = await GenServer.start(createAccumulatorBehavior());

      // Schedule a timer with very short delay
      await TimerService.schedule(serviceRef, target, { type: 'append', value: 'overdue' }, 10);

      // Stop the service
      await TimerService.stop(serviceRef);

      // Wait for the timer to expire
      await new Promise(resolve => setTimeout(resolve, 50));

      // Restart - the timer is now overdue and should fire on first tick
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 20 });

      // Wait for the tick to process
      await new Promise(resolve => setTimeout(resolve, 80));

      const state = await GenServer.call(target, 'get');
      expect(state).toEqual(['overdue']);

      vi.useFakeTimers();
    });

    it('updates persisted entry for repeat timer after each fire', async () => {
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 50 });
      const target = await GenServer.start(createAccumulatorBehavior());

      const timerId = await TimerService.schedule(
        serviceRef, target,
        { type: 'append', value: 'rep' },
        100,
        { repeat: 100 },
      );
      await vi.advanceTimersByTimeAsync(0);

      // Get initial fireAt
      const before = await TimerService.get(serviceRef, timerId);
      const initialFireAt = before!.fireAt;

      // Fire the timer
      await vi.advanceTimersByTimeAsync(150);

      // fireAt should have been updated
      const after = await TimerService.get(serviceRef, timerId);
      expect(after).toBeDefined();
      expect(after!.fireAt).toBeGreaterThan(initialFireAt);
    });
  });

  describe('edge cases', () => {
    it('handles scheduling with zero delay', async () => {
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 50 });
      const target = await GenServer.start(createAccumulatorBehavior());

      await TimerService.schedule(serviceRef, target, { type: 'append', value: 'now' }, 0);

      await vi.advanceTimersByTimeAsync(100);
      expect(await GenServer.call(target, 'get')).toEqual(['now']);
    });

    it('handles many concurrent timers', async () => {
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 50 });
      const target = await GenServer.start(createAccumulatorBehavior());

      for (let i = 0; i < 20; i++) {
        await TimerService.schedule(serviceRef, target, { type: 'append', value: `msg-${i}` }, 100);
      }

      await vi.advanceTimersByTimeAsync(200);

      const state = await GenServer.call(target, 'get');
      expect(state).toHaveLength(20);
    });

    it('stop clears the check interval', async () => {
      serviceRef = await TimerService.start({ adapter, checkIntervalMs: 100 });
      const target = await GenServer.start(createAccumulatorBehavior());

      await TimerService.schedule(serviceRef, target, { type: 'append', value: 'ghost' }, 200);
      await TimerService.stop(serviceRef);

      // Advancing time should not cause issues
      await vi.advanceTimersByTimeAsync(1000);
    });
  });
});
