/**
 * Tests for distributed stress test behaviors.
 *
 * Verifies that all stress test behaviors work correctly in isolation
 * before using them in distributed stress tests.
 *
 * @module tests/stress/distribution/behaviors.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenServer } from '../../../src/core/gen-server.js';
import {
  counterBehavior,
  echoBehavior,
  slowBehavior,
  createSlowBehavior,
  crashAfterNBehavior,
  createCrashAfterNBehavior,
  memoryHogBehavior,
  createMemoryHogBehavior,
  statefulBehavior,
  createStatefulBehavior,
  stressTestBehaviors,
  type CounterCallMsg,
  type CounterCastMsg,
  type CounterCallReply,
  type CounterState,
  type EchoCallMsg,
  type EchoCastMsg,
  type EchoCallReply,
  type EchoState,
  type SlowCallMsg,
  type SlowCastMsg,
  type SlowCallReply,
  type SlowState,
  type CrashAfterNCallMsg,
  type CrashAfterNCastMsg,
  type CrashAfterNCallReply,
  type CrashAfterNState,
  type MemoryHogCallMsg,
  type MemoryHogCastMsg,
  type MemoryHogCallReply,
  type MemoryHogState,
  type StatefulCallMsg,
  type StatefulCastMsg,
  type StatefulCallReply,
  type StatefulState,
} from './behaviors.js';
import type { GenServerRef } from '../../../src/core/types.js';

describe('Stress Test Behaviors', () => {
  // Track refs for cleanup
  const refs: GenServerRef[] = [];

  afterEach(async () => {
    for (const ref of refs) {
      try {
        await GenServer.stop(ref);
      } catch {
        // Ignore errors during cleanup
      }
    }
    refs.length = 0;
  });

  describe('counterBehavior', () => {
    it('should initialize with value 0', async () => {
      const ref = await GenServer.start<CounterState, CounterCallMsg, CounterCastMsg, CounterCallReply>(counterBehavior);
      refs.push(ref);

      const result = await GenServer.call(ref, { type: 'get' });
      expect(result).toEqual({ value: 0 });
    });

    it('should increment value via call', async () => {
      const ref = await GenServer.start<CounterState, CounterCallMsg, CounterCastMsg, CounterCallReply>(counterBehavior);
      refs.push(ref);

      const result = await GenServer.call(ref, { type: 'increment', by: 5 });
      expect(result).toEqual({ value: 5 });

      const check = await GenServer.call(ref, { type: 'get' });
      expect(check).toEqual({ value: 5 });
    });

    it('should decrement value via call', async () => {
      const ref = await GenServer.start<CounterState, CounterCallMsg, CounterCastMsg, CounterCallReply>(counterBehavior);
      refs.push(ref);

      await GenServer.call(ref, { type: 'increment', by: 10 });
      const result = await GenServer.call(ref, { type: 'decrement', by: 3 });
      expect(result).toEqual({ value: 7 });
    });

    it('should increment via cast', async () => {
      const ref = await GenServer.start<CounterState, CounterCallMsg, CounterCastMsg, CounterCallReply>(counterBehavior);
      refs.push(ref);

      GenServer.cast(ref, { type: 'increment', by: 3 });

      // Wait for cast to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      const result = await GenServer.call(ref, { type: 'get' });
      expect(result).toEqual({ value: 3 });
    });

    it('should track operation count in stats', async () => {
      const ref = await GenServer.start<CounterState, CounterCallMsg, CounterCastMsg, CounterCallReply>(counterBehavior);
      refs.push(ref);

      await GenServer.call(ref, { type: 'increment' });
      await GenServer.call(ref, { type: 'decrement' });
      await GenServer.call(ref, { type: 'set', value: 100 });

      const stats = await GenServer.call(ref, { type: 'get_stats' });
      expect(stats).toMatchObject({
        value: 100,
        operationCount: 3,
      });
      expect(stats).toHaveProperty('uptimeMs');
    });

    it('should reset via cast', async () => {
      const ref = await GenServer.start<CounterState, CounterCallMsg, CounterCastMsg, CounterCallReply>(counterBehavior);
      refs.push(ref);

      await GenServer.call(ref, { type: 'increment', by: 50 });
      GenServer.cast(ref, { type: 'reset' });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const result = await GenServer.call(ref, { type: 'get' });
      expect(result).toEqual({ value: 0 });
    });
  });

  describe('echoBehavior', () => {
    it('should echo payload back', async () => {
      const ref = await GenServer.start<EchoState, EchoCallMsg, EchoCastMsg, EchoCallReply>(echoBehavior);
      refs.push(ref);

      const payload = { test: 'data', nested: { value: 123 } };
      const result = await GenServer.call(ref, { type: 'echo', payload });

      expect(result).toMatchObject({ payload });
      expect(result).toHaveProperty('processedAt');
    });

    it('should track message count and bytes', async () => {
      const ref = await GenServer.start<EchoState, EchoCallMsg, EchoCastMsg, EchoCallReply>(echoBehavior);
      refs.push(ref);

      await GenServer.call(ref, { type: 'echo', payload: 'hello' });
      await GenServer.call(ref, { type: 'echo', payload: 'world' });

      const stats = await GenServer.call(ref, { type: 'get_stats' });
      expect(stats).toMatchObject({
        messageCount: 2,
      });
      expect((stats as { totalBytesProcessed: number }).totalBytesProcessed).toBeGreaterThan(0);
    });

    it('should handle ping cast', async () => {
      const ref = await GenServer.start<EchoState, EchoCallMsg, EchoCastMsg, EchoCallReply>(echoBehavior);
      refs.push(ref);

      GenServer.cast(ref, { type: 'ping' });
      GenServer.cast(ref, { type: 'ping' });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const stats = await GenServer.call(ref, { type: 'get_stats' });
      expect((stats as { messageCount: number }).messageCount).toBe(2);
    });
  });

  describe('slowBehavior', () => {
    it('should delay response by configured amount', async () => {
      const behavior = createSlowBehavior(50);
      const ref = await GenServer.start<SlowState, SlowCallMsg, SlowCastMsg, SlowCallReply>(behavior);
      refs.push(ref);

      const startTime = Date.now();
      const result = await GenServer.call(ref, { type: 'slow_echo', payload: 'test' });
      const elapsed = Date.now() - startTime;

      expect(result).toMatchObject({ payload: 'test' });
      expect((result as { actualDelayMs: number }).actualDelayMs).toBeGreaterThanOrEqual(45);
      expect(elapsed).toBeGreaterThanOrEqual(45);
    });

    it('should allow changing delay', async () => {
      const ref = await GenServer.start<SlowState, SlowCallMsg, SlowCastMsg, SlowCallReply>(slowBehavior);
      refs.push(ref);

      await GenServer.call(ref, { type: 'set_delay', delayMs: 10 });

      const startTime = Date.now();
      await GenServer.call(ref, { type: 'slow_echo', payload: 'test' });
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(50);
    });

    it('should track processed count', async () => {
      const behavior = createSlowBehavior(10);
      const ref = await GenServer.start<SlowState, SlowCallMsg, SlowCastMsg, SlowCallReply>(behavior);
      refs.push(ref);

      await GenServer.call(ref, { type: 'slow_echo', payload: 'a' });
      await GenServer.call(ref, { type: 'slow_echo', payload: 'b' });

      const stats = await GenServer.call(ref, { type: 'get_stats' });
      expect(stats).toMatchObject({
        processedCount: 2,
        delayMs: 10,
      });
    });
  });

  describe('crashAfterNBehavior', () => {
    it('should crash after N operations', async () => {
      const behavior = createCrashAfterNBehavior(3);
      const ref = await GenServer.start<CrashAfterNState, CrashAfterNCallMsg, CrashAfterNCastMsg, CrashAfterNCallReply>(behavior);
      refs.push(ref);

      // First two operations should succeed
      const r1 = await GenServer.call(ref, { type: 'operation' });
      expect(r1).toMatchObject({ ok: true, remaining: 2 });

      const r2 = await GenServer.call(ref, { type: 'operation' });
      expect(r2).toMatchObject({ ok: true, remaining: 1 });

      // Third operation should crash
      await expect(
        GenServer.call(ref, { type: 'operation' }),
      ).rejects.toThrow('Intentional crash');
    });

    it('should report remaining operations', async () => {
      const behavior = createCrashAfterNBehavior(5);
      const ref = await GenServer.start<CrashAfterNState, CrashAfterNCallMsg, CrashAfterNCastMsg, CrashAfterNCallReply>(behavior);
      refs.push(ref);

      await GenServer.call(ref, { type: 'operation' });
      await GenServer.call(ref, { type: 'operation' });

      const remaining = await GenServer.call(ref, { type: 'get_remaining' });
      expect(remaining).toMatchObject({
        remaining: 3,
        currentCount: 2,
      });
    });

    it('should allow reset', async () => {
      const behavior = createCrashAfterNBehavior(2);
      const ref = await GenServer.start<CrashAfterNState, CrashAfterNCallMsg, CrashAfterNCastMsg, CrashAfterNCallReply>(behavior);
      refs.push(ref);

      await GenServer.call(ref, { type: 'operation' });

      // Reset with new limit
      await GenServer.call(ref, { type: 'reset', crashAfter: 10 });

      const remaining = await GenServer.call(ref, { type: 'get_remaining' });
      expect(remaining).toMatchObject({
        remaining: 10,
        currentCount: 0,
      });
    });

    it('should count operations via cast toward crash limit', async () => {
      const behavior = createCrashAfterNBehavior(3);
      const ref = await GenServer.start<CrashAfterNState, CrashAfterNCallMsg, CrashAfterNCastMsg, CrashAfterNCallReply>(behavior);
      refs.push(ref);

      // Send two operations via cast
      GenServer.cast(ref, { type: 'operation' });
      GenServer.cast(ref, { type: 'operation' });

      // Wait for casts to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Check remaining - should be 1
      const remaining = await GenServer.call(ref, { type: 'get_remaining' });
      expect(remaining).toMatchObject({
        remaining: 1,
        currentCount: 2,
      });

      // Third operation via call should crash
      await expect(
        GenServer.call(ref, { type: 'operation' }),
      ).rejects.toThrow('Intentional crash');
    });
  });

  describe('memoryHogBehavior', () => {
    it('should create state of specified size', async () => {
      const behavior = createMemoryHogBehavior(100); // 100 KB
      const ref = await GenServer.start<MemoryHogState, MemoryHogCallMsg, MemoryHogCastMsg, MemoryHogCallReply>(behavior);
      refs.push(ref);

      const result = await GenServer.call(ref, { type: 'get_size' });
      expect((result as { sizeKb: number }).sizeKb).toBeCloseTo(100, 0);
      expect((result as { elementCount: number }).elementCount).toBe(100 * 128);
    });

    it('should grow state', async () => {
      const behavior = createMemoryHogBehavior(50);
      const ref = await GenServer.start<MemoryHogState, MemoryHogCallMsg, MemoryHogCastMsg, MemoryHogCallReply>(behavior);
      refs.push(ref);

      const result = await GenServer.call(ref, { type: 'grow', additionalKb: 50 });
      expect(result).toMatchObject({ ok: true, newSizeKb: 100 });

      const size = await GenServer.call(ref, { type: 'get_size' });
      expect((size as { sizeKb: number }).sizeKb).toBeCloseTo(100, 0);
    });

    it('should shrink state', async () => {
      const behavior = createMemoryHogBehavior(100);
      const ref = await GenServer.start<MemoryHogState, MemoryHogCallMsg, MemoryHogCastMsg, MemoryHogCallReply>(behavior);
      refs.push(ref);

      const result = await GenServer.call(ref, { type: 'shrink', targetKb: 25 });
      expect(result).toMatchObject({ ok: true, newSizeKb: 25 });

      const size = await GenServer.call(ref, { type: 'get_size' });
      expect((size as { sizeKb: number }).sizeKb).toBeCloseTo(25, 0);
    });

    it('should reset via cast', async () => {
      const ref = await GenServer.start<MemoryHogState, MemoryHogCallMsg, MemoryHogCastMsg, MemoryHogCallReply>(memoryHogBehavior);
      refs.push(ref);

      GenServer.cast(ref, { type: 'reset' });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const size = await GenServer.call(ref, { type: 'get_size' });
      expect((size as { sizeKb: number }).sizeKb).toBe(0);
    });
  });

  describe('statefulBehavior', () => {
    it('should store and retrieve values', async () => {
      const ref = await GenServer.start<StatefulState, StatefulCallMsg, StatefulCastMsg, StatefulCallReply>(statefulBehavior);
      refs.push(ref);

      await GenServer.call(ref, { type: 'set', key: 'foo', value: { bar: 123 } });

      const result = await GenServer.call(ref, { type: 'get', key: 'foo' });
      expect(result).toEqual({ found: true, value: { bar: 123 } });
    });

    it('should return found: false for missing keys', async () => {
      const ref = await GenServer.start<StatefulState, StatefulCallMsg, StatefulCastMsg, StatefulCallReply>(statefulBehavior);
      refs.push(ref);

      const result = await GenServer.call(ref, { type: 'get', key: 'missing' });
      expect(result).toEqual({ found: false });
    });

    it('should delete keys', async () => {
      const ref = await GenServer.start<StatefulState, StatefulCallMsg, StatefulCastMsg, StatefulCallReply>(statefulBehavior);
      refs.push(ref);

      await GenServer.call(ref, { type: 'set', key: 'test', value: 'data' });
      await GenServer.call(ref, { type: 'delete', key: 'test' });

      const result = await GenServer.call(ref, { type: 'get', key: 'test' });
      expect(result).toEqual({ found: false });
    });

    it('should list keys', async () => {
      const ref = await GenServer.start<StatefulState, StatefulCallMsg, StatefulCastMsg, StatefulCallReply>(statefulBehavior);
      refs.push(ref);

      await GenServer.call(ref, { type: 'set', key: 'a', value: 1 });
      await GenServer.call(ref, { type: 'set', key: 'b', value: 2 });
      await GenServer.call(ref, { type: 'set', key: 'c', value: 3 });

      const result = await GenServer.call(ref, { type: 'list_keys' });
      expect((result as { keys: string[] }).keys.sort()).toEqual(['a', 'b', 'c']);
    });

    it('should maintain operation log', async () => {
      const behavior = createStatefulBehavior(10);
      const ref = await GenServer.start<StatefulState, StatefulCallMsg, StatefulCastMsg, StatefulCallReply>(behavior);
      refs.push(ref);

      await GenServer.call(ref, { type: 'set', key: 'x', value: 1 });
      await GenServer.call(ref, { type: 'get', key: 'x' });
      await GenServer.call(ref, { type: 'delete', key: 'x' });

      const result = await GenServer.call(ref, { type: 'get_log' });
      const log = (result as { log: Array<{ type: string; key?: string }> }).log;

      expect(log).toHaveLength(3);
      expect(log[0].type).toBe('set');
      expect(log[0].key).toBe('x');
      expect(log[1].type).toBe('get');
      expect(log[2].type).toBe('delete');
    });

    it('should limit log size', async () => {
      const behavior = createStatefulBehavior(3);
      const ref = await GenServer.start<StatefulState, StatefulCallMsg, StatefulCastMsg, StatefulCallReply>(behavior);
      refs.push(ref);

      for (let i = 0; i < 10; i++) {
        await GenServer.call(ref, { type: 'set', key: `key${i}`, value: i });
      }

      const result = await GenServer.call(ref, { type: 'get_log' });
      const log = (result as { log: Array<{ type: string }> }).log;

      expect(log).toHaveLength(3);
    });

    it('should clear all data', async () => {
      const ref = await GenServer.start<StatefulState, StatefulCallMsg, StatefulCastMsg, StatefulCallReply>(statefulBehavior);
      refs.push(ref);

      await GenServer.call(ref, { type: 'set', key: 'a', value: 1 });
      await GenServer.call(ref, { type: 'set', key: 'b', value: 2 });
      await GenServer.call(ref, { type: 'clear' });

      const result = await GenServer.call(ref, { type: 'list_keys' });
      expect((result as { keys: string[] }).keys).toEqual([]);
    });
  });

  describe('stressTestBehaviors registry', () => {
    it('should contain all behaviors', () => {
      expect(stressTestBehaviors).toHaveProperty('counter');
      expect(stressTestBehaviors).toHaveProperty('echo');
      expect(stressTestBehaviors).toHaveProperty('slow');
      expect(stressTestBehaviors).toHaveProperty('crashAfterN');
      expect(stressTestBehaviors).toHaveProperty('memoryHog');
      expect(stressTestBehaviors).toHaveProperty('stateful');
    });

    it('should have valid behaviors', () => {
      for (const [name, behavior] of Object.entries(stressTestBehaviors)) {
        expect(behavior).toHaveProperty('init');
        expect(behavior).toHaveProperty('handleCall');
        expect(behavior).toHaveProperty('handleCast');
        expect(typeof behavior.init).toBe('function');
        expect(typeof behavior.handleCall).toBe('function');
        expect(typeof behavior.handleCast).toBe('function');
      }
    });
  });
});
