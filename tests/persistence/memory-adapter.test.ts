import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryAdapter, StorageError } from '../../src/persistence/index.js';
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

describe('MemoryAdapter', () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  describe('save', () => {
    it('stores state with given key', async () => {
      const data = createPersistedState({ count: 42 });

      await adapter.save('test-key', data);

      expect(adapter.size).toBe(1);
    });

    it('overwrites existing state with same key', async () => {
      const data1 = createPersistedState({ count: 1 });
      const data2 = createPersistedState({ count: 2 });

      await adapter.save('key', data1);
      await adapter.save('key', data2);

      const loaded = await adapter.load<{ count: number }>('key');
      expect(loaded?.state.count).toBe(2);
      expect(adapter.size).toBe(1);
    });

    it('stores multiple keys independently', async () => {
      await adapter.save('key1', createPersistedState({ a: 1 }));
      await adapter.save('key2', createPersistedState({ b: 2 }));
      await adapter.save('key3', createPersistedState({ c: 3 }));

      expect(adapter.size).toBe(3);
    });

    it('deep clones data to prevent external mutations', async () => {
      const state = { nested: { value: 1 } };
      const data = createPersistedState(state);

      await adapter.save('key', data);

      // Mutate original
      state.nested.value = 999;

      const loaded = await adapter.load<typeof state>('key');
      expect(loaded?.state.nested.value).toBe(1);
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

    it('deep clones data on load to prevent mutations', async () => {
      await adapter.save('key', createPersistedState({ value: 1 }));

      const loaded1 = await adapter.load<{ value: number }>('key');
      loaded1!.state.value = 999;

      const loaded2 = await adapter.load<{ value: number }>('key');
      expect(loaded2!.state.value).toBe(1);
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
      expect(adapter.size).toBe(0);
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

      // Cleanup entries older than 1 hour
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
      expect(adapter.size).toBe(1);
    });

    it('handles empty storage', async () => {
      const cleaned = await adapter.cleanup(1000);
      expect(cleaned).toBe(0);
    });
  });

  describe('close', () => {
    it('clears all stored data', async () => {
      await adapter.save('key1', createPersistedState({}));
      await adapter.save('key2', createPersistedState({}));

      await adapter.close();

      expect(adapter.size).toBe(0);
    });
  });

  describe('size property', () => {
    it('returns 0 for empty adapter', () => {
      expect(adapter.size).toBe(0);
    });

    it('reflects number of stored entries', async () => {
      await adapter.save('a', createPersistedState({}));
      expect(adapter.size).toBe(1);

      await adapter.save('b', createPersistedState({}));
      expect(adapter.size).toBe(2);

      await adapter.delete('a');
      expect(adapter.size).toBe(1);
    });
  });

  describe('clear method', () => {
    it('removes all entries', async () => {
      await adapter.save('a', createPersistedState({}));
      await adapter.save('b', createPersistedState({}));

      adapter.clear();

      expect(adapter.size).toBe(0);
      expect(await adapter.listKeys()).toEqual([]);
    });
  });

  describe('initialData option', () => {
    it('initializes with provided data', async () => {
      const initialData = new Map([
        ['key1', createPersistedState({ x: 1 })],
        ['key2', createPersistedState({ x: 2 })],
      ]);

      const adapterWithData = new MemoryAdapter({ initialData });

      expect(adapterWithData.size).toBe(2);
      expect(await adapterWithData.exists('key1')).toBe(true);
      expect(await adapterWithData.exists('key2')).toBe(true);
    });

    it('allows loading pre-populated data', async () => {
      const state = { count: 42 };
      const initialData = new Map([['counter', createPersistedState(state)]]);

      const adapterWithData = new MemoryAdapter({ initialData });
      const loaded = await adapterWithData.load<typeof state>('counter');

      expect(loaded?.state.count).toBe(42);
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

      // TypeScript should know these properties exist
      expect(loaded?.state.id).toBe(1);
      expect(loaded?.state.name).toBe('Alice');
      expect(loaded?.state.active).toBe(true);
    });
  });
});
