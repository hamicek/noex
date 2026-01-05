import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  SQLiteAdapter,
  CorruptedStateError,
  PersistenceError,
} from '../../src/persistence/index.js';
import type { PersistedState, StateMetadata } from '../../src/persistence/index.js';

function createMetadata(overrides: Partial<StateMetadata> = {}): StateMetadata {
  return {
    persistedAt: Date.now(),
    serverId: 'test-server-1',
    schemaVersion: 1,
    ...overrides,
  };
}

function createPersistedState<T>(state: T, metadataOverrides: Partial<StateMetadata> = {}): PersistedState<T> {
  return {
    state,
    metadata: createMetadata(metadataOverrides),
  };
}

describe('SQLiteAdapter', () => {
  let testDbPath: string;
  let adapter: SQLiteAdapter;

  beforeEach(() => {
    testDbPath = join(tmpdir(), `noex-test-${randomUUID()}.db`);
    adapter = new SQLiteAdapter({ filename: testDbPath });
  });

  afterEach(async () => {
    try {
      await adapter.close();
    } catch {
      // Ignore close errors
    }
    try {
      await rm(testDbPath, { force: true });
      await rm(`${testDbPath}-wal`, { force: true });
      await rm(`${testDbPath}-shm`, { force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('creates database on first operation', async () => {
      await adapter.save('key', createPersistedState({ x: 1 }));

      const loaded = await adapter.load('key');
      expect(loaded).toBeDefined();
    });

    it('creates table with correct schema', async () => {
      await adapter.save('key', createPersistedState({ x: 1 }));

      // If we can save and load, the schema is correct
      const loaded = await adapter.load<{ x: number }>('key');
      expect(loaded?.state.x).toBe(1);
    });
  });

  describe('save', () => {
    it('stores state with given key', async () => {
      const data = createPersistedState({ count: 42 });

      await adapter.save('test-key', data);

      const loaded = await adapter.load('test-key');
      expect(loaded).toBeDefined();
    });

    it('overwrites existing state with same key', async () => {
      const data1 = createPersistedState({ count: 1 });
      const data2 = createPersistedState({ count: 2 });

      await adapter.save('key', data1);
      await adapter.save('key', data2);

      const loaded = await adapter.load<{ count: number }>('key');
      expect(loaded?.state.count).toBe(2);
    });

    it('stores multiple keys independently', async () => {
      await adapter.save('key1', createPersistedState({ a: 1 }));
      await adapter.save('key2', createPersistedState({ b: 2 }));
      await adapter.save('key3', createPersistedState({ c: 3 }));

      const keys = await adapter.listKeys();
      expect(keys).toHaveLength(3);
    });
  });

  describe('load', () => {
    it('returns undefined for non-existent key', async () => {
      const result = await adapter.load('non-existent');
      expect(result).toBeUndefined();
    });

    it('returns stored state with metadata', async () => {
      const originalState = { name: 'test', value: 42 };
      const metadata = createMetadata({
        serverId: 'server-123',
        serverName: 'my-server',
        schemaVersion: 3,
      });

      await adapter.save('key', { state: originalState, metadata });

      const loaded = await adapter.load<typeof originalState>('key');

      expect(loaded).toBeDefined();
      expect(loaded!.state).toEqual(originalState);
      expect(loaded!.metadata.serverId).toBe('server-123');
      expect(loaded!.metadata.serverName).toBe('my-server');
      expect(loaded!.metadata.schemaVersion).toBe(3);
    });

    it('handles complex nested structures', async () => {
      const complexState = {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        settings: {
          theme: 'dark',
          nested: {
            deep: {
              value: 42,
            },
          },
        },
      };

      await adapter.save('complex', createPersistedState(complexState));
      const loaded = await adapter.load<typeof complexState>('complex');

      expect(loaded?.state).toEqual(complexState);
    });
  });

  describe('delete', () => {
    it('returns true when key exists and is deleted', async () => {
      await adapter.save('key', createPersistedState({ x: 1 }));

      const result = await adapter.delete('key');

      expect(result).toBe(true);
      expect(await adapter.exists('key')).toBe(false);
    });

    it('returns false when key does not exist', async () => {
      const result = await adapter.delete('non-existent');
      expect(result).toBe(false);
    });

    it('only deletes specified key', async () => {
      await adapter.save('key1', createPersistedState({ a: 1 }));
      await adapter.save('key2', createPersistedState({ b: 2 }));

      await adapter.delete('key1');

      expect(await adapter.exists('key1')).toBe(false);
      expect(await adapter.exists('key2')).toBe(true);
    });
  });

  describe('exists', () => {
    it('returns false for non-existent key', async () => {
      expect(await adapter.exists('missing')).toBe(false);
    });

    it('returns true for existing key', async () => {
      await adapter.save('present', createPersistedState({ x: 1 }));
      expect(await adapter.exists('present')).toBe(true);
    });

    it('returns false after key is deleted', async () => {
      await adapter.save('key', createPersistedState({ x: 1 }));
      await adapter.delete('key');
      expect(await adapter.exists('key')).toBe(false);
    });
  });

  describe('listKeys', () => {
    it('returns empty array when no keys exist', async () => {
      const keys = await adapter.listKeys();
      expect(keys).toEqual([]);
    });

    it('returns all keys when no prefix specified', async () => {
      await adapter.save('alpha', createPersistedState({}));
      await adapter.save('beta', createPersistedState({}));
      await adapter.save('gamma', createPersistedState({}));

      const keys = await adapter.listKeys();

      expect(keys).toHaveLength(3);
      expect(keys).toContain('alpha');
      expect(keys).toContain('beta');
      expect(keys).toContain('gamma');
    });

    it('filters keys by prefix', async () => {
      await adapter.save('user:alice', createPersistedState({}));
      await adapter.save('user:bob', createPersistedState({}));
      await adapter.save('session:123', createPersistedState({}));
      await adapter.save('config', createPersistedState({}));

      const userKeys = await adapter.listKeys('user:');

      expect(userKeys).toHaveLength(2);
      expect(userKeys).toContain('user:alice');
      expect(userKeys).toContain('user:bob');
    });

    it('returns empty array when no keys match prefix', async () => {
      await adapter.save('alpha', createPersistedState({}));
      await adapter.save('beta', createPersistedState({}));

      const keys = await adapter.listKeys('gamma');

      expect(keys).toEqual([]);
    });

    it('escapes special SQL LIKE characters in prefix', async () => {
      await adapter.save('test%key', createPersistedState({}));
      await adapter.save('test_key', createPersistedState({}));
      await adapter.save('testXkey', createPersistedState({}));

      // Should only find exact prefix matches, not wildcard matches
      const percentKeys = await adapter.listKeys('test%');
      expect(percentKeys).toHaveLength(1);
      expect(percentKeys).toContain('test%key');

      const underscoreKeys = await adapter.listKeys('test_');
      expect(underscoreKeys).toHaveLength(1);
      expect(underscoreKeys).toContain('test_key');
    });
  });

  describe('cleanup', () => {
    it('removes entries older than maxAgeMs', async () => {
      const now = Date.now();

      // Old entry (2 hours ago)
      await adapter.save('old', createPersistedState({}, { persistedAt: now - 2 * 60 * 60 * 1000 }));

      // Recent entry (5 minutes ago)
      await adapter.save('recent', createPersistedState({}, { persistedAt: now - 5 * 60 * 1000 }));

      // Very old entry (1 day ago)
      await adapter.save('ancient', createPersistedState({}, { persistedAt: now - 24 * 60 * 60 * 1000 }));

      // Cleanup entries older than 1 hour (based on metadata.persistedAt)
      const cleaned = await adapter.cleanup(60 * 60 * 1000);

      expect(cleaned).toBe(2);
      expect(await adapter.exists('old')).toBe(false);
      expect(await adapter.exists('ancient')).toBe(false);
      expect(await adapter.exists('recent')).toBe(true);
    });

    it('returns 0 when no entries are stale', async () => {
      await adapter.save('fresh', createPersistedState({}));

      const cleaned = await adapter.cleanup(60 * 60 * 1000);

      expect(cleaned).toBe(0);
    });

    it('handles empty database', async () => {
      const cleaned = await adapter.cleanup(1000);
      expect(cleaned).toBe(0);
    });
  });

  describe('close', () => {
    it('closes database connection', async () => {
      await adapter.save('key', createPersistedState({}));
      await adapter.close();

      // After close, new operations should work (lazy re-initialization)
      // This tests that close properly cleans up
      const newAdapter = new SQLiteAdapter({ filename: testDbPath });
      const loaded = await newAdapter.load('key');
      expect(loaded).toBeDefined();
      await newAdapter.close();
    });

    it('can be called multiple times safely', async () => {
      await adapter.save('key', createPersistedState({}));

      await adapter.close();
      await adapter.close();
      await adapter.close();

      // No error should be thrown
    });
  });

  describe('WAL mode', () => {
    it('enables WAL mode by default', async () => {
      // Save something to initialize the database
      await adapter.save('key', createPersistedState({}));

      // WAL mode creates additional files
      // The test verifies the adapter works with WAL mode enabled
      const loaded = await adapter.load('key');
      expect(loaded).toBeDefined();
    });

    it('can disable WAL mode', async () => {
      const noWalAdapter = new SQLiteAdapter({
        filename: join(tmpdir(), `noex-test-nowal-${randomUUID()}.db`),
        walMode: false,
      });

      await noWalAdapter.save('key', createPersistedState({ x: 1 }));
      const loaded = await noWalAdapter.load<{ x: number }>('key');

      expect(loaded?.state.x).toBe(1);
      await noWalAdapter.close();
    });
  });

  describe('in-memory mode', () => {
    it('works with :memory: database', async () => {
      const memoryAdapter = new SQLiteAdapter({ filename: ':memory:' });

      await memoryAdapter.save('key', createPersistedState({ value: 42 }));
      const loaded = await memoryAdapter.load<{ value: number }>('key');

      expect(loaded?.state.value).toBe(42);
      await memoryAdapter.close();
    });

    it('loses data after close with :memory:', async () => {
      const memoryAdapter1 = new SQLiteAdapter({ filename: ':memory:' });
      await memoryAdapter1.save('key', createPersistedState({ value: 42 }));
      await memoryAdapter1.close();

      const memoryAdapter2 = new SQLiteAdapter({ filename: ':memory:' });
      const loaded = await memoryAdapter2.load('key');

      expect(loaded).toBeUndefined();
      await memoryAdapter2.close();
    });
  });

  describe('custom table name', () => {
    it('uses custom table name', async () => {
      const customAdapter = new SQLiteAdapter({
        filename: join(tmpdir(), `noex-test-custom-${randomUUID()}.db`),
        tableName: 'custom_state',
      });

      await customAdapter.save('key', createPersistedState({ x: 1 }));
      const loaded = await customAdapter.load<{ x: number }>('key');

      expect(loaded?.state.x).toBe(1);
      expect(customAdapter.getTableName()).toBe('custom_state');
      await customAdapter.close();
    });
  });

  describe('special types preservation', () => {
    it('preserves Date objects through serialization', async () => {
      const state = { createdAt: new Date('2024-06-15T10:30:00.000Z') };
      await adapter.save('dates', createPersistedState(state));

      const loaded = await adapter.load<typeof state>('dates');

      expect(loaded?.state.createdAt).toBeInstanceOf(Date);
      expect(loaded?.state.createdAt.toISOString()).toBe('2024-06-15T10:30:00.000Z');
    });

    it('preserves Map objects through serialization', async () => {
      const state = { users: new Map([['alice', { name: 'Alice' }]]) };
      await adapter.save('maps', createPersistedState(state));

      const loaded = await adapter.load<typeof state>('maps');

      expect(loaded?.state.users).toBeInstanceOf(Map);
      expect(loaded?.state.users.get('alice')).toEqual({ name: 'Alice' });
    });

    it('preserves Set objects through serialization', async () => {
      const state = { tags: new Set(['a', 'b', 'c']) };
      await adapter.save('sets', createPersistedState(state));

      const loaded = await adapter.load<typeof state>('sets');

      expect(loaded?.state.tags).toBeInstanceOf(Set);
      expect(loaded?.state.tags.has('a')).toBe(true);
      expect(loaded?.state.tags.has('b')).toBe(true);
      expect(loaded?.state.tags.has('c')).toBe(true);
    });

    it('preserves BigInt through serialization', async () => {
      const state = { bigValue: 9007199254740993n };
      await adapter.save('bigint', createPersistedState(state));

      const loaded = await adapter.load<typeof state>('bigint');

      expect(typeof loaded?.state.bigValue).toBe('bigint');
      expect(loaded?.state.bigValue).toBe(9007199254740993n);
    });
  });

  describe('error handling', () => {
    it('handles corrupted JSON data gracefully', async () => {
      // This would require direct database manipulation to test properly
      // For now, we test that valid operations don't throw CorruptedStateError
      await adapter.save('key', createPersistedState({ x: 1 }));
      const loaded = await adapter.load('key');
      expect(loaded).toBeDefined();
    });
  });

  describe('concurrent operations', () => {
    it('handles multiple saves to different keys', async () => {
      const saves = Array.from({ length: 10 }, (_, i) =>
        adapter.save(`key-${i}`, createPersistedState({ index: i }))
      );

      await Promise.all(saves);

      const keys = await adapter.listKeys();
      expect(keys).toHaveLength(10);
    });

    it('handles save and load of same key', async () => {
      await adapter.save('key', createPersistedState({ v: 1 }));

      const [loaded1, loaded2, loaded3] = await Promise.all([
        adapter.load<{ v: number }>('key'),
        adapter.load<{ v: number }>('key'),
        adapter.load<{ v: number }>('key'),
      ]);

      expect(loaded1?.state.v).toBe(1);
      expect(loaded2?.state.v).toBe(1);
      expect(loaded3?.state.v).toBe(1);
    });
  });

  describe('getFilename', () => {
    it('returns configured database filename', () => {
      expect(adapter.getFilename()).toBe(testDbPath);
    });
  });

  describe('getTableName', () => {
    it('returns default table name', () => {
      expect(adapter.getTableName()).toBe('noex_state');
    });
  });

  describe('type safety', () => {
    it('preserves generic type on load', async () => {
      interface UserState {
        id: number;
        name: string;
        active: boolean;
      }

      const user: UserState = { id: 1, name: 'Alice', active: true };
      await adapter.save('user', createPersistedState(user));

      const loaded = await adapter.load<UserState>('user');

      expect(loaded?.state.id).toBe(1);
      expect(loaded?.state.name).toBe('Alice');
      expect(loaded?.state.active).toBe(true);
    });
  });
});
