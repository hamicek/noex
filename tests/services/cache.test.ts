/**
 * Comprehensive tests for Cache service.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Cache, type CacheRef, GenServer, _resetAccessCounter } from '../../src/index.js';

describe('Cache', () => {
  let cache: CacheRef;

  beforeEach(async () => {
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
    _resetAccessCounter();
    cache = await Cache.start();
  });

  afterEach(async () => {
    if (Cache.isRunning(cache)) {
      await Cache.stop(cache);
    }
    GenServer._clearLifecycleHandlers();
  });

  describe('start()', () => {
    it('starts a Cache instance', async () => {
      expect(cache).toBeDefined();
      expect(Cache.isRunning(cache)).toBe(true);
    });

    it('starts with zero entries', async () => {
      const size = await Cache.size(cache);
      expect(size).toBe(0);
    });

    it('starts with empty keys list', async () => {
      const keys = await Cache.keys(cache);
      expect(keys).toEqual([]);
    });

    it('supports named instances', async () => {
      const namedCache = await Cache.start({ name: 'my-cache' });
      expect(Cache.isRunning(namedCache)).toBe(true);
      await Cache.stop(namedCache);
    });

    it('supports maxSize configuration', async () => {
      const limitedCache = await Cache.start({ maxSize: 5 });
      const stats = await Cache.stats(limitedCache);
      expect(stats.maxSize).toBe(5);
      await Cache.stop(limitedCache);
    });

    it('supports defaultTtlMs configuration', async () => {
      const ttlCache = await Cache.start({ defaultTtlMs: 1000 });
      expect(Cache.isRunning(ttlCache)).toBe(true);
      await Cache.stop(ttlCache);
    });
  });

  describe('set() and get()', () => {
    it('stores and retrieves a value', async () => {
      await Cache.set(cache, 'key1', 'value1');
      const value = await Cache.get(cache, 'key1');
      expect(value).toBe('value1');
    });

    it('returns undefined for non-existent key', async () => {
      const value = await Cache.get(cache, 'nonexistent');
      expect(value).toBeUndefined();
    });

    it('stores various data types', async () => {
      await Cache.set(cache, 'string', 'hello');
      await Cache.set(cache, 'number', 42);
      await Cache.set(cache, 'boolean', true);
      await Cache.set(cache, 'null', null);
      await Cache.set(cache, 'object', { a: 1, b: 2 });
      await Cache.set(cache, 'array', [1, 2, 3]);

      expect(await Cache.get(cache, 'string')).toBe('hello');
      expect(await Cache.get(cache, 'number')).toBe(42);
      expect(await Cache.get(cache, 'boolean')).toBe(true);
      expect(await Cache.get(cache, 'null')).toBe(null);
      expect(await Cache.get(cache, 'object')).toEqual({ a: 1, b: 2 });
      expect(await Cache.get(cache, 'array')).toEqual([1, 2, 3]);
    });

    it('overwrites existing values', async () => {
      await Cache.set(cache, 'key', 'first');
      await Cache.set(cache, 'key', 'second');
      expect(await Cache.get(cache, 'key')).toBe('second');
      expect(await Cache.size(cache)).toBe(1);
    });

    it('supports typed get', async () => {
      interface User {
        id: string;
        name: string;
      }

      const user: User = { id: '123', name: 'John' };
      await Cache.set(cache, 'user', user);

      const retrieved = await Cache.get<User>(cache, 'user');
      expect(retrieved?.id).toBe('123');
      expect(retrieved?.name).toBe('John');
    });
  });

  describe('TTL (Time-To-Live)', () => {
    it('respects explicit TTL', async () => {
      vi.useFakeTimers();

      await Cache.set(cache, 'expiring', 'value', { ttlMs: 100 });
      expect(await Cache.get(cache, 'expiring')).toBe('value');

      vi.advanceTimersByTime(50);
      expect(await Cache.get(cache, 'expiring')).toBe('value');

      vi.advanceTimersByTime(60);
      expect(await Cache.get(cache, 'expiring')).toBeUndefined();

      vi.useRealTimers();
    });

    it('respects default TTL', async () => {
      vi.useFakeTimers();

      const ttlCache = await Cache.start({ defaultTtlMs: 100 });
      await Cache.set(ttlCache, 'key', 'value');

      expect(await Cache.get(ttlCache, 'key')).toBe('value');

      vi.advanceTimersByTime(110);
      expect(await Cache.get(ttlCache, 'key')).toBeUndefined();

      await Cache.stop(ttlCache);
      vi.useRealTimers();
    });

    it('null TTL means no expiration', async () => {
      vi.useFakeTimers();

      await Cache.set(cache, 'permanent', 'value', { ttlMs: null });

      vi.advanceTimersByTime(1000000);
      expect(await Cache.get(cache, 'permanent')).toBe('value');

      vi.useRealTimers();
    });

    it('explicit TTL overrides default TTL', async () => {
      vi.useFakeTimers();

      const ttlCache = await Cache.start({ defaultTtlMs: 100 });
      await Cache.set(ttlCache, 'key', 'value', { ttlMs: 500 });

      vi.advanceTimersByTime(150);
      expect(await Cache.get(ttlCache, 'key')).toBe('value');

      vi.advanceTimersByTime(400);
      expect(await Cache.get(ttlCache, 'key')).toBeUndefined();

      await Cache.stop(ttlCache);
      vi.useRealTimers();
    });

    it('explicit null TTL overrides default TTL', async () => {
      vi.useFakeTimers();

      const ttlCache = await Cache.start({ defaultTtlMs: 100 });
      await Cache.set(ttlCache, 'key', 'value', { ttlMs: null });

      vi.advanceTimersByTime(1000);
      expect(await Cache.get(ttlCache, 'key')).toBe('value');

      await Cache.stop(ttlCache);
      vi.useRealTimers();
    });

    it('expired entries are removed on access', async () => {
      vi.useFakeTimers();

      await Cache.set(cache, 'key', 'value', { ttlMs: 100 });
      expect(await Cache.size(cache)).toBe(1);

      vi.advanceTimersByTime(110);
      await Cache.get(cache, 'key');
      expect(await Cache.size(cache)).toBe(0);

      vi.useRealTimers();
    });
  });

  describe('LRU eviction', () => {
    it('evicts least recently used when max size exceeded', async () => {
      const limitedCache = await Cache.start({ maxSize: 3 });

      await Cache.set(limitedCache, 'a', 1);
      await Cache.set(limitedCache, 'b', 2);
      await Cache.set(limitedCache, 'c', 3);

      // Access 'a' to make it recently used
      await Cache.get(limitedCache, 'a');

      // Add 'd', should evict 'b' (least recently used)
      await Cache.set(limitedCache, 'd', 4);

      expect(await Cache.size(limitedCache)).toBe(3);
      expect(await Cache.get(limitedCache, 'a')).toBe(1);
      expect(await Cache.get(limitedCache, 'b')).toBeUndefined();
      expect(await Cache.get(limitedCache, 'c')).toBe(3);
      expect(await Cache.get(limitedCache, 'd')).toBe(4);

      await Cache.stop(limitedCache);
    });

    it('evicts expired entries before LRU entries', async () => {
      vi.useFakeTimers();

      const limitedCache = await Cache.start({ maxSize: 3 });

      await Cache.set(limitedCache, 'a', 1, { ttlMs: 50 });
      await Cache.set(limitedCache, 'b', 2);
      await Cache.set(limitedCache, 'c', 3);

      vi.advanceTimersByTime(60);

      // Add 'd', should evict expired 'a' first
      await Cache.set(limitedCache, 'd', 4);

      expect(await Cache.size(limitedCache)).toBe(3);
      expect(await Cache.get(limitedCache, 'a')).toBeUndefined();
      expect(await Cache.get(limitedCache, 'b')).toBe(2);
      expect(await Cache.get(limitedCache, 'c')).toBe(3);
      expect(await Cache.get(limitedCache, 'd')).toBe(4);

      await Cache.stop(limitedCache);
      vi.useRealTimers();
    });

    it('handles update of existing key without eviction', async () => {
      const limitedCache = await Cache.start({ maxSize: 2 });

      await Cache.set(limitedCache, 'a', 1);
      await Cache.set(limitedCache, 'b', 2);
      await Cache.set(limitedCache, 'a', 10); // Update, not new

      expect(await Cache.size(limitedCache)).toBe(2);
      expect(await Cache.get(limitedCache, 'a')).toBe(10);
      expect(await Cache.get(limitedCache, 'b')).toBe(2);

      await Cache.stop(limitedCache);
    });
  });

  describe('has()', () => {
    it('returns true for existing key', async () => {
      await Cache.set(cache, 'key', 'value');
      expect(await Cache.has(cache, 'key')).toBe(true);
    });

    it('returns false for non-existent key', async () => {
      expect(await Cache.has(cache, 'nonexistent')).toBe(false);
    });

    it('returns false for expired key', async () => {
      vi.useFakeTimers();

      await Cache.set(cache, 'key', 'value', { ttlMs: 100 });
      vi.advanceTimersByTime(110);

      expect(await Cache.has(cache, 'key')).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('delete()', () => {
    it('deletes existing key', async () => {
      await Cache.set(cache, 'key', 'value');
      const deleted = await Cache.delete(cache, 'key');

      expect(deleted).toBe(true);
      expect(await Cache.has(cache, 'key')).toBe(false);
    });

    it('returns false for non-existent key', async () => {
      const deleted = await Cache.delete(cache, 'nonexistent');
      expect(deleted).toBe(false);
    });

    it('actually removes the entry', async () => {
      await Cache.set(cache, 'key', 'value');
      expect(await Cache.size(cache)).toBe(1);

      await Cache.delete(cache, 'key');
      expect(await Cache.size(cache)).toBe(0);
    });
  });

  describe('clear()', () => {
    it('removes all entries', async () => {
      await Cache.set(cache, 'a', 1);
      await Cache.set(cache, 'b', 2);
      await Cache.set(cache, 'c', 3);

      expect(await Cache.size(cache)).toBe(3);

      await Cache.clear(cache);

      expect(await Cache.size(cache)).toBe(0);
      expect(await Cache.keys(cache)).toEqual([]);
    });

    it('resets statistics', async () => {
      await Cache.set(cache, 'key', 'value');
      await Cache.get(cache, 'key'); // hit
      await Cache.get(cache, 'miss'); // miss

      let stats = await Cache.stats(cache);
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);

      await Cache.clear(cache);

      stats = await Cache.stats(cache);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe('size()', () => {
    it('returns correct count', async () => {
      expect(await Cache.size(cache)).toBe(0);

      await Cache.set(cache, 'a', 1);
      expect(await Cache.size(cache)).toBe(1);

      await Cache.set(cache, 'b', 2);
      expect(await Cache.size(cache)).toBe(2);

      await Cache.delete(cache, 'a');
      expect(await Cache.size(cache)).toBe(1);
    });

    it('excludes expired entries', async () => {
      vi.useFakeTimers();

      await Cache.set(cache, 'a', 1, { ttlMs: 50 });
      await Cache.set(cache, 'b', 2, { ttlMs: 150 });
      await Cache.set(cache, 'c', 3);

      expect(await Cache.size(cache)).toBe(3);

      vi.advanceTimersByTime(100);
      expect(await Cache.size(cache)).toBe(2);

      vi.advanceTimersByTime(100);
      expect(await Cache.size(cache)).toBe(1);

      vi.useRealTimers();
    });
  });

  describe('keys()', () => {
    it('returns all keys', async () => {
      await Cache.set(cache, 'a', 1);
      await Cache.set(cache, 'b', 2);
      await Cache.set(cache, 'c', 3);

      const keys = await Cache.keys(cache);
      expect(keys).toHaveLength(3);
      expect(keys).toContain('a');
      expect(keys).toContain('b');
      expect(keys).toContain('c');
    });

    it('excludes expired entries', async () => {
      vi.useFakeTimers();

      await Cache.set(cache, 'expired', 1, { ttlMs: 50 });
      await Cache.set(cache, 'valid', 2);

      vi.advanceTimersByTime(100);

      const keys = await Cache.keys(cache);
      expect(keys).toEqual(['valid']);

      vi.useRealTimers();
    });
  });

  describe('stats()', () => {
    it('returns correct statistics', async () => {
      const limitedCache = await Cache.start({ maxSize: 100 });

      await Cache.set(limitedCache, 'key', 'value');
      await Cache.get(limitedCache, 'key'); // hit
      await Cache.get(limitedCache, 'miss1'); // miss
      await Cache.get(limitedCache, 'miss2'); // miss

      const stats = await Cache.stats(limitedCache);

      expect(stats.size).toBe(1);
      expect(stats.maxSize).toBe(100);
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(2);
      expect(stats.hitRate).toBeCloseTo(1 / 3);

      await Cache.stop(limitedCache);
    });

    it('handles zero total requests', async () => {
      const stats = await Cache.stats(cache);
      expect(stats.hitRate).toBe(0);
    });

    it('handles 100% hit rate', async () => {
      await Cache.set(cache, 'key', 'value');
      await Cache.get(cache, 'key');
      await Cache.get(cache, 'key');

      const stats = await Cache.stats(cache);
      expect(stats.hitRate).toBe(1);
    });
  });

  describe('getOrSet()', () => {
    it('returns cached value if exists', async () => {
      await Cache.set(cache, 'key', 'cached');

      const factory = vi.fn().mockResolvedValue('computed');
      const value = await Cache.getOrSet(cache, 'key', factory);

      expect(value).toBe('cached');
      expect(factory).not.toHaveBeenCalled();
    });

    it('calls factory and caches if not exists', async () => {
      const factory = vi.fn().mockResolvedValue('computed');
      const value = await Cache.getOrSet(cache, 'key', factory);

      expect(value).toBe('computed');
      expect(factory).toHaveBeenCalledTimes(1);
      expect(await Cache.get(cache, 'key')).toBe('computed');
    });

    it('supports sync factory', async () => {
      const value = await Cache.getOrSet(cache, 'key', () => 'sync-value');
      expect(value).toBe('sync-value');
    });

    it('supports async factory', async () => {
      const value = await Cache.getOrSet(cache, 'key', async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 'async-value';
      });
      expect(value).toBe('async-value');
    });

    it('respects TTL option', async () => {
      vi.useFakeTimers();

      await Cache.getOrSet(cache, 'key', () => 'value', { ttlMs: 100 });
      expect(await Cache.get(cache, 'key')).toBe('value');

      vi.advanceTimersByTime(110);
      expect(await Cache.get(cache, 'key')).toBeUndefined();

      vi.useRealTimers();
    });

    it('calls factory again after expiration', async () => {
      vi.useFakeTimers();

      const factory = vi.fn().mockReturnValue('value');
      await Cache.getOrSet(cache, 'key', factory, { ttlMs: 100 });
      expect(factory).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(110);
      await Cache.getOrSet(cache, 'key', factory, { ttlMs: 100 });
      expect(factory).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  describe('prune()', () => {
    it('removes expired entries', async () => {
      vi.useFakeTimers();

      await Cache.set(cache, 'a', 1, { ttlMs: 50 });
      await Cache.set(cache, 'b', 2, { ttlMs: 50 });
      await Cache.set(cache, 'c', 3);

      vi.advanceTimersByTime(100);

      // Prune is async cast, need to sync
      Cache.prune(cache);
      await Cache.stats(cache); // sync point

      expect(await Cache.size(cache)).toBe(1);
      expect(await Cache.keys(cache)).toEqual(['c']);

      vi.useRealTimers();
    });
  });

  describe('stop()', () => {
    it('stops the Cache', async () => {
      expect(Cache.isRunning(cache)).toBe(true);
      await Cache.stop(cache);
      expect(Cache.isRunning(cache)).toBe(false);
    });

    it('is idempotent', async () => {
      await Cache.stop(cache);
      await expect(Cache.stop(cache)).resolves.toBeUndefined();
    });
  });

  describe('integration scenarios', () => {
    it('handles high volume of operations', async () => {
      for (let i = 0; i < 100; i++) {
        await Cache.set(cache, `key${i}`, i);
      }

      expect(await Cache.size(cache)).toBe(100);

      for (let i = 0; i < 100; i++) {
        expect(await Cache.get(cache, `key${i}`)).toBe(i);
      }

      const stats = await Cache.stats(cache);
      expect(stats.hits).toBe(100);
      expect(stats.misses).toBe(0);
    });

    it('supports multiple independent caches', async () => {
      const cache2 = await Cache.start();

      await Cache.set(cache, 'key', 'cache1');
      await Cache.set(cache2, 'key', 'cache2');

      expect(await Cache.get(cache, 'key')).toBe('cache1');
      expect(await Cache.get(cache2, 'key')).toBe('cache2');

      await Cache.stop(cache2);
    });

    it('LRU eviction maintains correct order under heavy access', async () => {
      const limitedCache = await Cache.start({ maxSize: 3 });

      await Cache.set(limitedCache, 'a', 1);
      await Cache.set(limitedCache, 'b', 2);
      await Cache.set(limitedCache, 'c', 3);

      // Access pattern: a, c, a, b, a
      await Cache.get(limitedCache, 'a');
      await Cache.get(limitedCache, 'c');
      await Cache.get(limitedCache, 'a');
      await Cache.get(limitedCache, 'b');
      await Cache.get(limitedCache, 'a');

      // Now order is: c (oldest), b, a (newest)
      // Adding 'd' should evict 'c'
      await Cache.set(limitedCache, 'd', 4);

      expect(await Cache.has(limitedCache, 'a')).toBe(true);
      expect(await Cache.has(limitedCache, 'b')).toBe(true);
      expect(await Cache.has(limitedCache, 'c')).toBe(false);
      expect(await Cache.has(limitedCache, 'd')).toBe(true);

      await Cache.stop(limitedCache);
    });

    it('handles concurrent operations correctly', async () => {
      const operations = [];

      for (let i = 0; i < 50; i++) {
        operations.push(Cache.set(cache, `key${i}`, i));
      }

      await Promise.all(operations);

      expect(await Cache.size(cache)).toBe(50);

      const getOperations = [];
      for (let i = 0; i < 50; i++) {
        getOperations.push(Cache.get(cache, `key${i}`));
      }

      const values = await Promise.all(getOperations);
      values.forEach((v, i) => expect(v).toBe(i));
    });
  });
});
