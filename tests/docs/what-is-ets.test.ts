/**
 * Tests for the What is ETS documentation examples.
 * Verifies that all code examples from docs/learn/07-ets/01-what-is-ets.md work correctly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Ets, EtsTable } from '../../src/index.js';

describe('What is ETS Documentation Examples', () => {
  const tables: EtsTable<unknown, unknown>[] = [];

  afterEach(async () => {
    for (const table of tables) {
      await table.close();
    }
    tables.length = 0;
  });

  describe('Basic Usage Example', () => {
    it('should create a typed ETS table and perform basic operations', async () => {
      const users = Ets.new<string, { name: string; age: number }>({
        name: 'users',
        type: 'set',
      });
      tables.push(users as unknown as EtsTable<unknown, unknown>);

      await users.start();

      // Insert with type checking
      users.insert('u1', { name: 'Alice', age: 30 });
      users.insert('u2', { name: 'Bob', age: 25 });

      // Lookup returns properly typed value
      const alice = users.lookup('u1');
      expect(alice).toEqual({ name: 'Alice', age: 30 });
      expect(alice?.name).toBe('Alice');
    });
  });

  describe('Session Cache Example', () => {
    it('should work as a session cache with TTL check', async () => {
      const sessions = Ets.new<string, { userId: string; expiresAt: number }>({
        name: 'sessions',
        type: 'set',
      });
      tables.push(sessions as unknown as EtsTable<unknown, unknown>);

      await sessions.start();

      // Helper function from docs
      function getSession(sessionId: string) {
        const session = sessions.lookup(sessionId);
        if (!session) return null;
        if (session.expiresAt < Date.now()) {
          sessions.delete(sessionId);
          return null;
        }
        return session;
      }

      // Insert a valid session
      const futureTime = Date.now() + 60000; // 1 minute from now
      sessions.insert('session-123', { userId: 'user-1', expiresAt: futureTime });

      // Should return valid session
      const validSession = getSession('session-123');
      expect(validSession).toEqual({ userId: 'user-1', expiresAt: futureTime });

      // Insert an expired session
      const pastTime = Date.now() - 1000; // 1 second ago
      sessions.insert('session-expired', { userId: 'user-2', expiresAt: pastTime });

      // Should return null for expired session
      const expiredSession = getSession('session-expired');
      expect(expiredSession).toBeNull();

      // Expired session should be deleted
      expect(sessions.member('session-expired')).toBe(false);

      // Non-existent session should return null
      expect(getSession('nonexistent')).toBeNull();
    });
  });

  describe('Insert and Lookup Operations', () => {
    it('should handle basic insert and lookup', async () => {
      const cache = Ets.new<string, number>({ name: 'cache', type: 'set' });
      tables.push(cache as unknown as EtsTable<unknown, unknown>);

      await cache.start();

      // Insert a value
      cache.insert('counter', 42);

      // Lookup returns the value or undefined
      const value = cache.lookup('counter');
      expect(value).toBe(42);

      const missing = cache.lookup('nonexistent');
      expect(missing).toBeUndefined();

      // Check if key exists
      const exists = cache.member('counter');
      expect(exists).toBe(true);
    });
  });

  describe('Delete Operations', () => {
    it('should delete by key and by key-value pair', async () => {
      const cache = Ets.new<string, string>({ name: 'delete-cache', type: 'set' });
      tables.push(cache as unknown as EtsTable<unknown, unknown>);

      await cache.start();

      // Delete by key
      cache.insert('counter', 'value');
      const deleted = cache.delete('counter');
      expect(deleted).toBe(true);
      expect(cache.lookup('counter')).toBeUndefined();

      // Delete specific key-value pair
      cache.insert('key', 'value1');
      const deletedObject = cache.deleteObject('key', 'value1');
      expect(deletedObject).toBe(true);

      // deleteObject with wrong value should not delete
      cache.insert('key2', 'value2');
      const notDeleted = cache.deleteObject('key2', 'wrong-value');
      expect(notDeleted).toBe(false);
      expect(cache.member('key2')).toBe(true);
    });
  });

  describe('Bulk Operations', () => {
    it('should handle bulk insert and retrieval', async () => {
      const cache = Ets.new<string, number>({ name: 'bulk-cache', type: 'set' });
      tables.push(cache as unknown as EtsTable<unknown, unknown>);

      await cache.start();

      // Insert multiple entries
      cache.insertMany([
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]);

      // Get all entries
      const entries = cache.toArray();
      expect(entries).toHaveLength(3);
      expect(entries).toContainEqual(['a', 1]);
      expect(entries).toContainEqual(['b', 2]);
      expect(entries).toContainEqual(['c', 3]);

      // Get all keys
      const keys = cache.keys();
      expect(keys).toHaveLength(3);
      expect(keys).toContain('a');
      expect(keys).toContain('b');
      expect(keys).toContain('c');

      // Get table size
      const size = cache.size();
      expect(size).toBe(3);

      // Clear all entries
      cache.clear();
      expect(cache.size()).toBe(0);
    });
  });

  describe('Query and Filter Operations', () => {
    it('should filter entries with select()', async () => {
      const users = Ets.new<string, { name: string; role: string }>({
        name: 'users-filter',
        type: 'set',
      });
      tables.push(users as unknown as EtsTable<unknown, unknown>);

      await users.start();

      users.insertMany([
        ['u1', { name: 'Alice', role: 'admin' }],
        ['u2', { name: 'Bob', role: 'user' }],
        ['u3', { name: 'Charlie', role: 'admin' }],
      ]);

      // Filter with predicate
      const admins = users.select((key, value) => value.role === 'admin');
      expect(admins).toHaveLength(2);
      expect(admins.map((r) => r.key)).toContain('u1');
      expect(admins.map((r) => r.key)).toContain('u3');
    });

    it('should match keys with glob patterns', async () => {
      const users = Ets.new<string, { name: string; role: string }>({
        name: 'users-match',
        type: 'set',
      });
      tables.push(users as unknown as EtsTable<unknown, unknown>);

      await users.start();

      users.insert('user:1', { name: 'Alice', role: 'user' });
      users.insert('user:2', { name: 'Bob', role: 'user' });
      users.insert('admin:root', { name: 'Root', role: 'superadmin' });

      const adminKeys = users.match('admin:*');
      expect(adminKeys).toHaveLength(1);
      expect(adminKeys[0]!.key).toBe('admin:root');
    });

    it('should reduce over all entries', async () => {
      const users = Ets.new<string, { name: string; role: string }>({
        name: 'users-reduce',
        type: 'set',
      });
      tables.push(users as unknown as EtsTable<unknown, unknown>);

      await users.start();

      users.insertMany([
        ['u1', { name: 'Alice', role: 'admin' }],
        ['u2', { name: 'Bob', role: 'user' }],
        ['u3', { name: 'Charlie', role: 'admin' }],
      ]);

      // Reduce over all entries
      const count = users.reduce((acc, key, value) => acc + 1, 0);
      expect(count).toBe(3);
    });
  });

  describe('Counter Operations', () => {
    it('should handle atomic counter updates', async () => {
      const counters = Ets.new<string, number>({ name: 'counters', type: 'set' });
      tables.push(counters as unknown as EtsTable<unknown, unknown>);

      await counters.start();

      // Initialize or increment atomically
      const first = counters.updateCounter('page_views', 1);
      expect(first).toBe(1);

      const second = counters.updateCounter('page_views', 1);
      expect(second).toBe(2);

      const third = counters.updateCounter('page_views', 10);
      expect(third).toBe(12);

      // Decrement
      const negative = counters.updateCounter('balance', -50);
      expect(negative).toBe(-50);
    });
  });

  describe('Table Lifecycle', () => {
    it('should follow start/use/close lifecycle', async () => {
      // 1. Create the table
      const table = Ets.new<string, number>({ name: 'lifecycle-table', type: 'set' });
      tables.push(table as unknown as EtsTable<unknown, unknown>);

      // 2. Start (required if using persistence, optional otherwise)
      await table.start();

      // 3. Use the table
      table.insert('key', 123);
      const value = table.lookup('key');
      expect(value).toBe(123);

      // 4. Close when done
      await table.close();

      // After close, operations throw an error
      expect(() => table.insert('key', 456)).toThrow("ETS table 'lifecycle-table' is closed.");
    });
  });

  describe('Table Information', () => {
    it('should return runtime metadata', async () => {
      const table = Ets.new<string, number>({
        name: 'metrics',
        type: 'ordered_set',
      });
      tables.push(table as unknown as EtsTable<unknown, unknown>);

      await table.start();

      table.insertMany([
        ['cpu', 45],
        ['memory', 78],
        ['disk', 23],
      ]);

      const info = table.info();
      expect(info).toEqual({
        name: 'metrics',
        type: 'ordered_set',
        size: 3,
      });
    });
  });

  describe('API Response Cache Example', () => {
    interface CachedResponse {
      data: unknown;
      cachedAt: number;
      ttlMs: number;
    }

    it('should implement a full API response cache', async () => {
      const responseCache = Ets.new<string, CachedResponse>({
        name: 'api-response-cache',
        type: 'set',
      });
      tables.push(responseCache as unknown as EtsTable<unknown, unknown>);

      await responseCache.start();

      // Cache a response
      function cacheResponse(url: string, data: unknown, ttlMs = 60000) {
        responseCache.insert(url, {
          data,
          cachedAt: Date.now(),
          ttlMs,
        });
      }

      // Get cached response (with TTL check)
      function getCachedResponse(url: string): unknown | null {
        const cached = responseCache.lookup(url);

        if (!cached) {
          return null;
        }

        // Check if expired
        if (Date.now() > cached.cachedAt + cached.ttlMs) {
          responseCache.delete(url);
          return null;
        }

        return cached.data;
      }

      // Clean up expired entries
      function cleanExpiredEntries() {
        const now = Date.now();
        const expired = responseCache.select(
          (key, value) => now > value.cachedAt + value.ttlMs
        );

        for (const entry of expired) {
          responseCache.delete(entry.key);
        }

        return expired.length;
      }

      // Test caching
      const testData = [{ id: 1, name: 'Alice' }];
      cacheResponse('/api/users', testData, 60000);

      const data = getCachedResponse('/api/users');
      expect(data).toEqual(testData);

      // Test expired entry cleanup
      cacheResponse('/api/old', { old: true }, 0); // Already expired (0ms TTL)

      // Wait a tick for time to pass
      await new Promise((resolve) => setTimeout(resolve, 1));

      const cleaned = cleanExpiredEntries();
      expect(cleaned).toBe(1);
      expect(getCachedResponse('/api/old')).toBeNull();

      // Valid cache should still exist
      expect(getCachedResponse('/api/users')).toEqual(testData);
    });
  });
});
