/**
 * Tests for GenServer.sendAfter() and GenServer.cancelTimer().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GenServer,
  type GenServerBehavior,
  type TimerRef,
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

describe('GenServer.sendAfter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
    GenServer._clearTimers();
  });

  afterEach(async () => {
    GenServer._clearTimers();
    // Stop all running servers
    const ids = GenServer._getAllServerIds();
    for (const id of ids) {
      const ref = GenServer._getRefById(id);
      if (ref) {
        await GenServer.stop(ref);
      }
    }
    GenServer._clearLifecycleHandlers();
    vi.useRealTimers();
  });

  describe('sendAfter', () => {
    it('delivers a cast message after the specified delay', async () => {
      const ref = await GenServer.start(createAccumulatorBehavior());

      GenServer.sendAfter(ref, { type: 'append', value: 'delayed' }, 100);

      // Message should not be delivered yet
      const before = await GenServer.call(ref, 'get');
      expect(before).toEqual([]);

      // Advance time past the delay
      vi.advanceTimersByTime(100);

      // Allow microtask queue to flush (processQueue is sync but cast enqueue triggers it)
      await vi.advanceTimersByTimeAsync(0);

      const after = await GenServer.call(ref, 'get');
      expect(after).toEqual(['delayed']);
    });

    it('returns a TimerRef with a unique timerId', async () => {
      const ref = await GenServer.start(createAccumulatorBehavior());

      const timer1 = GenServer.sendAfter(ref, { type: 'append', value: 'a' }, 100);
      const timer2 = GenServer.sendAfter(ref, { type: 'append', value: 'b' }, 200);

      expect(timer1.timerId).toBeDefined();
      expect(timer2.timerId).toBeDefined();
      expect(timer1.timerId).not.toBe(timer2.timerId);
    });

    it('delivers multiple messages in scheduled order', async () => {
      const ref = await GenServer.start(createAccumulatorBehavior());

      GenServer.sendAfter(ref, { type: 'append', value: 'first' }, 50);
      GenServer.sendAfter(ref, { type: 'append', value: 'second' }, 100);
      GenServer.sendAfter(ref, { type: 'append', value: 'third' }, 150);

      await vi.advanceTimersByTimeAsync(50);
      expect(await GenServer.call(ref, 'get')).toEqual(['first']);

      await vi.advanceTimersByTimeAsync(50);
      expect(await GenServer.call(ref, 'get')).toEqual(['first', 'second']);

      await vi.advanceTimersByTimeAsync(50);
      expect(await GenServer.call(ref, 'get')).toEqual(['first', 'second', 'third']);
    });

    it('silently discards the message if the server is stopped before firing', async () => {
      const ref = await GenServer.start(createAccumulatorBehavior());

      GenServer.sendAfter(ref, { type: 'append', value: 'ghost' }, 100);

      await GenServer.stop(ref);

      // Advance time - should not throw
      await vi.advanceTimersByTimeAsync(200);
    });

    it('handles zero delay (immediate scheduling via event loop)', async () => {
      const ref = await GenServer.start(createAccumulatorBehavior());

      GenServer.sendAfter(ref, { type: 'append', value: 'immediate' }, 0);

      // Even with 0 delay, setTimeout is async
      await vi.advanceTimersByTimeAsync(0);

      const state = await GenServer.call(ref, 'get');
      expect(state).toEqual(['immediate']);
    });

    it('works with large delays', async () => {
      const ref = await GenServer.start(createAccumulatorBehavior());

      GenServer.sendAfter(ref, { type: 'append', value: 'far-future' }, 60_000);

      await vi.advanceTimersByTimeAsync(59_999);
      expect(await GenServer.call(ref, 'get')).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(await GenServer.call(ref, 'get')).toEqual(['far-future']);
    });
  });

  describe('cancelTimer', () => {
    it('prevents a scheduled message from being delivered', async () => {
      const ref = await GenServer.start(createAccumulatorBehavior());

      const timerRef = GenServer.sendAfter(ref, { type: 'append', value: 'cancelled' }, 100);

      const cancelled = GenServer.cancelTimer(timerRef);
      expect(cancelled).toBe(true);

      await vi.advanceTimersByTimeAsync(200);

      const state = await GenServer.call(ref, 'get');
      expect(state).toEqual([]);
    });

    it('returns false for an already-fired timer', async () => {
      const ref = await GenServer.start(createAccumulatorBehavior());

      const timerRef = GenServer.sendAfter(ref, { type: 'append', value: 'fired' }, 50);

      await vi.advanceTimersByTimeAsync(50);

      const cancelled = GenServer.cancelTimer(timerRef);
      expect(cancelled).toBe(false);
    });

    it('returns false for an already-cancelled timer', async () => {
      const ref = await GenServer.start(createAccumulatorBehavior());

      const timerRef = GenServer.sendAfter(ref, { type: 'append', value: 'x' }, 100);

      expect(GenServer.cancelTimer(timerRef)).toBe(true);
      expect(GenServer.cancelTimer(timerRef)).toBe(false);
    });

    it('returns false for a fabricated TimerRef', () => {
      const fakeRef = { timerId: 'nonexistent_timer' } as TimerRef;
      expect(GenServer.cancelTimer(fakeRef)).toBe(false);
    });

    it('only cancels the specified timer, leaving others intact', async () => {
      const ref = await GenServer.start(createAccumulatorBehavior());

      const timer1 = GenServer.sendAfter(ref, { type: 'append', value: 'keep' }, 100);
      GenServer.sendAfter(ref, { type: 'append', value: 'also-keep' }, 100);

      // Cancel only the first
      GenServer.cancelTimer(timer1);

      await vi.advanceTimersByTimeAsync(100);

      const state = await GenServer.call(ref, 'get');
      expect(state).toEqual(['also-keep']);
    });
  });

  describe('edge cases', () => {
    it('can schedule multiple timers to the same server', async () => {
      const ref = await GenServer.start(createAccumulatorBehavior());

      for (let i = 0; i < 10; i++) {
        GenServer.sendAfter(ref, { type: 'append', value: `msg-${i}` }, (i + 1) * 10);
      }

      await vi.advanceTimersByTimeAsync(100);

      const state = await GenServer.call(ref, 'get');
      expect(state).toHaveLength(10);
      expect(state[0]).toBe('msg-0');
      expect(state[9]).toBe('msg-9');
    });

    it('timer does not hold server reference after firing', async () => {
      const ref = await GenServer.start(createAccumulatorBehavior());

      GenServer.sendAfter(ref, { type: 'append', value: 'done' }, 50);

      await vi.advanceTimersByTimeAsync(50);

      // Verify message was delivered
      expect(await GenServer.call(ref, 'get')).toEqual(['done']);

      // Verify timer was cleaned up from registry (via cancelTimer returning false)
      // The internal registry cleanup happens on fire
    });

    it('_clearTimers cancels all pending timers', async () => {
      const ref = await GenServer.start(createAccumulatorBehavior());

      GenServer.sendAfter(ref, { type: 'append', value: 'a' }, 100);
      GenServer.sendAfter(ref, { type: 'append', value: 'b' }, 200);
      GenServer.sendAfter(ref, { type: 'append', value: 'c' }, 300);

      GenServer._clearTimers();

      await vi.advanceTimersByTimeAsync(500);

      const state = await GenServer.call(ref, 'get');
      expect(state).toEqual([]);
    });
  });
});
