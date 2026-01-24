/**
 * Tests for ETS persistence helpers:
 * - serializeEtsState / deserializeEtsState
 * - EtsPersistenceHandler (debounced persist, restore, shutdown)
 * - EtsTable integration with persistence
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  serializeEtsState,
  deserializeEtsState,
  EtsPersistenceHandler,
  type EtsStateSnapshot,
} from '../../src/core/ets-persistence.js';
import { EtsTable, _resetEtsInstanceCounter } from '../../src/core/ets-table.js';
import type { PersistedEtsState } from '../../src/core/ets-types.js';
import type { PersistedState } from '../../src/persistence/types.js';
import { MemoryAdapter } from '../../src/persistence/adapters/memory-adapter.js';

// =============================================================================
// Helpers
// =============================================================================

function createSnapshot<K, V>(
  overrides: Partial<EtsStateSnapshot<K, V>> = {},
): EtsStateSnapshot<K, V> {
  return {
    tableName: overrides.tableName ?? 'test-table',
    tableType: overrides.tableType ?? 'set',
    entries: overrides.entries ?? [],
  };
}

// =============================================================================
// serializeEtsState
// =============================================================================

describe('serializeEtsState', () => {
  it('serializes empty state', () => {
    const snapshot = createSnapshot();
    const result = serializeEtsState(snapshot);

    expect(result.tableName).toBe('test-table');
    expect(result.tableType).toBe('set');
    expect(result.entries).toEqual([]);
    expect(result.persistedAt).toBeGreaterThan(0);
  });

  it('serializes entries with key, value, and insertedAt', () => {
    const snapshot = createSnapshot<string, { name: string }>({
      tableName: 'users',
      tableType: 'set',
      entries: [
        { key: 'u1', value: { name: 'Alice' }, insertedAt: 1000 },
        { key: 'u2', value: { name: 'Bob' }, insertedAt: 2000 },
      ],
    });

    const result = serializeEtsState(snapshot);

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({
      key: 'u1',
      value: { name: 'Alice' },
      insertedAt: 1000,
    });
    expect(result.entries[1]).toEqual({
      key: 'u2',
      value: { name: 'Bob' },
      insertedAt: 2000,
    });
  });

  it('preserves numeric keys and values', () => {
    const snapshot = createSnapshot<number, number>({
      tableName: 'counters',
      tableType: 'ordered_set',
      entries: [
        { key: 1, value: 100, insertedAt: 500 },
        { key: 2, value: 200, insertedAt: 600 },
      ],
    });

    const result = serializeEtsState(snapshot);

    expect(result.entries[0]!.key).toBe(1);
    expect(result.entries[0]!.value).toBe(100);
    expect(result.tableType).toBe('ordered_set');
  });

  it('serializes bag-type entries with duplicate keys', () => {
    const snapshot = createSnapshot<string, string>({
      tableName: 'tags',
      tableType: 'bag',
      entries: [
        { key: 'post:1', value: 'js', insertedAt: 100 },
        { key: 'post:1', value: 'ts', insertedAt: 200 },
        { key: 'post:2', value: 'go', insertedAt: 300 },
      ],
    });

    const result = serializeEtsState(snapshot);

    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]!.key).toBe('post:1');
    expect(result.entries[1]!.key).toBe('post:1');
    expect(result.tableType).toBe('bag');
  });

  it('sets persistedAt to current time', () => {
    const before = Date.now();
    const result = serializeEtsState(createSnapshot());
    const after = Date.now();

    expect(result.persistedAt).toBeGreaterThanOrEqual(before);
    expect(result.persistedAt).toBeLessThanOrEqual(after);
  });
});

// =============================================================================
// deserializeEtsState
// =============================================================================

describe('deserializeEtsState', () => {
  it('deserializes empty state', () => {
    const persisted: PersistedEtsState<string, number> = {
      tableName: 'test',
      tableType: 'set',
      entries: [],
      persistedAt: 1000,
    };

    const result = deserializeEtsState(persisted);

    expect(result.tableName).toBe('test');
    expect(result.tableType).toBe('set');
    expect(result.entries).toEqual([]);
  });

  it('deserializes entries preserving all fields', () => {
    const persisted: PersistedEtsState<string, { name: string }> = {
      tableName: 'users',
      tableType: 'set',
      entries: [
        { key: 'u1', value: { name: 'Alice' }, insertedAt: 1000 },
        { key: 'u2', value: { name: 'Bob' }, insertedAt: 2000 },
      ],
      persistedAt: 3000,
    };

    const result = deserializeEtsState(persisted);

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({
      key: 'u1',
      value: { name: 'Alice' },
      insertedAt: 1000,
    });
    expect(result.entries[1]).toEqual({
      key: 'u2',
      value: { name: 'Bob' },
      insertedAt: 2000,
    });
  });

  it('preserves original insertedAt timestamps', () => {
    const persisted: PersistedEtsState<string, string> = {
      tableName: 'test',
      tableType: 'ordered_set',
      entries: [
        { key: 'k', value: 'v', insertedAt: 42 },
      ],
      persistedAt: 9999,
    };

    const result = deserializeEtsState(persisted);

    expect(result.entries[0]!.insertedAt).toBe(42);
  });

  it('preserves tableType from persisted state', () => {
    const persisted: PersistedEtsState<string, string> = {
      tableName: 'bags',
      tableType: 'duplicate_bag',
      entries: [],
      persistedAt: 100,
    };

    const result = deserializeEtsState(persisted);
    expect(result.tableType).toBe('duplicate_bag');
  });
});

// =============================================================================
// EtsPersistenceHandler
// =============================================================================

describe('EtsPersistenceHandler', () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('restore', () => {
    it('returns undefined when no persisted state exists', async () => {
      const handler = new EtsPersistenceHandler<string, number>('test', { adapter });

      const result = await handler.restore();
      expect(result).toBeUndefined();
    });

    it('returns undefined when restoreOnStart is false', async () => {
      const persistedState: PersistedState<PersistedEtsState<string, number>> = {
        state: {
          tableName: 'test',
          tableType: 'set',
          entries: [{ key: 'k', value: 42, insertedAt: 100 }],
          persistedAt: 500,
        },
        metadata: { persistedAt: 500, serverId: 'ets:test', schemaVersion: 1 },
      };
      await adapter.save('test', persistedState);

      const handler = new EtsPersistenceHandler<string, number>('test', {
        adapter,
        restoreOnStart: false,
      });

      const result = await handler.restore();
      expect(result).toBeUndefined();
    });

    it('restores persisted entries', async () => {
      const persistedState: PersistedState<PersistedEtsState<string, { name: string }>> = {
        state: {
          tableName: 'users',
          tableType: 'set',
          entries: [
            { key: 'u1', value: { name: 'Alice' }, insertedAt: 1000 },
            { key: 'u2', value: { name: 'Bob' }, insertedAt: 2000 },
          ],
          persistedAt: 3000,
        },
        metadata: { persistedAt: 3000, serverId: 'ets:users', schemaVersion: 1 },
      };
      await adapter.save('users', persistedState);

      const handler = new EtsPersistenceHandler<string, { name: string }>('users', { adapter });

      const result = await handler.restore();

      expect(result).toBeDefined();
      expect(result!.tableName).toBe('users');
      expect(result!.entries).toHaveLength(2);
      expect(result!.entries[0]!.key).toBe('u1');
      expect(result!.entries[0]!.value).toEqual({ name: 'Alice' });
      expect(result!.entries[1]!.key).toBe('u2');
    });

    it('uses custom storage key', async () => {
      const persistedState: PersistedState<PersistedEtsState<string, number>> = {
        state: {
          tableName: 'test',
          tableType: 'set',
          entries: [{ key: 'k', value: 1, insertedAt: 0 }],
          persistedAt: 100,
        },
        metadata: { persistedAt: 100, serverId: 'ets:test', schemaVersion: 1 },
      };
      await adapter.save('custom-key', persistedState);

      const handler = new EtsPersistenceHandler<string, number>('test', {
        adapter,
        key: 'custom-key',
      });

      const result = await handler.restore();
      expect(result).toBeDefined();
      expect(result!.entries).toHaveLength(1);
    });

    it('calls onError and returns undefined on adapter failure', async () => {
      const errors: Error[] = [];
      const failingAdapter: MemoryAdapter = Object.create(adapter);
      failingAdapter.load = () => Promise.reject(new Error('disk failure'));

      const handler = new EtsPersistenceHandler<string, number>('test', {
        adapter: failingAdapter,
        onError: (err) => errors.push(err),
      });

      const result = await handler.restore();

      expect(result).toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe('disk failure');
    });
  });

  describe('schedulePersist / debounce', () => {
    it('persists after debounce interval', async () => {
      const handler = new EtsPersistenceHandler<string, number>('test', {
        adapter,
        debounceMs: 50,
      });

      const snapshot = createSnapshot<string, number>({
        tableName: 'test',
        entries: [{ key: 'k', value: 42, insertedAt: 100 }],
      });

      handler.schedulePersist(snapshot);
      expect(adapter.size).toBe(0);

      await vi.advanceTimersByTimeAsync(50);

      expect(adapter.size).toBe(1);
      const saved = await adapter.load<PersistedEtsState<string, number>>('test');
      expect(saved).toBeDefined();
      expect(saved!.state.entries).toHaveLength(1);
      expect(saved!.state.entries[0]!.value).toBe(42);
    });

    it('batches multiple rapid changes', async () => {
      const saveSpy = vi.spyOn(adapter, 'save');

      const handler = new EtsPersistenceHandler<string, number>('test', {
        adapter,
        debounceMs: 100,
      });

      handler.schedulePersist(createSnapshot<string, number>({
        tableName: 'test',
        entries: [{ key: 'k1', value: 1, insertedAt: 1 }],
      }));

      await vi.advanceTimersByTimeAsync(30);

      handler.schedulePersist(createSnapshot<string, number>({
        tableName: 'test',
        entries: [
          { key: 'k1', value: 1, insertedAt: 1 },
          { key: 'k2', value: 2, insertedAt: 2 },
        ],
      }));

      await vi.advanceTimersByTimeAsync(30);

      handler.schedulePersist(createSnapshot<string, number>({
        tableName: 'test',
        entries: [
          { key: 'k1', value: 1, insertedAt: 1 },
          { key: 'k2', value: 2, insertedAt: 2 },
          { key: 'k3', value: 3, insertedAt: 3 },
        ],
      }));

      expect(saveSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);

      expect(saveSpy).toHaveBeenCalledTimes(1);
      const saved = await adapter.load<PersistedEtsState<string, number>>('test');
      expect(saved!.state.entries).toHaveLength(3);
    });

    it('does nothing when persistOnChange is false', async () => {
      const handler = new EtsPersistenceHandler<string, number>('test', {
        adapter,
        persistOnChange: false,
        debounceMs: 10,
      });

      handler.schedulePersist(createSnapshot<string, number>({
        entries: [{ key: 'k', value: 1, insertedAt: 0 }],
      }));

      await vi.advanceTimersByTimeAsync(100);
      expect(adapter.size).toBe(0);
    });

    it('uses default debounceMs of 100', async () => {
      const handler = new EtsPersistenceHandler<string, number>('test', { adapter });

      handler.schedulePersist(createSnapshot<string, number>({
        tableName: 'test',
        entries: [{ key: 'k', value: 1, insertedAt: 0 }],
      }));

      await vi.advanceTimersByTimeAsync(99);
      expect(adapter.size).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(adapter.size).toBe(1);
    });
  });

  describe('flush', () => {
    it('immediately writes pending state', async () => {
      const handler = new EtsPersistenceHandler<string, number>('test', {
        adapter,
        debounceMs: 1000,
      });

      handler.schedulePersist(createSnapshot<string, number>({
        tableName: 'test',
        entries: [{ key: 'k', value: 99, insertedAt: 50 }],
      }));

      await handler.flush();

      expect(adapter.size).toBe(1);
      const saved = await adapter.load<PersistedEtsState<string, number>>('test');
      expect(saved!.state.entries[0]!.value).toBe(99);
    });

    it('does nothing when no pending changes', async () => {
      const saveSpy = vi.spyOn(adapter, 'save');
      const handler = new EtsPersistenceHandler<string, number>('test', { adapter });

      await handler.flush();
      expect(saveSpy).not.toHaveBeenCalled();
    });

    it('cancels pending debounce timer', async () => {
      const saveSpy = vi.spyOn(adapter, 'save');
      const handler = new EtsPersistenceHandler<string, number>('test', {
        adapter,
        debounceMs: 100,
      });

      handler.schedulePersist(createSnapshot<string, number>({
        tableName: 'test',
        entries: [{ key: 'k', value: 1, insertedAt: 0 }],
      }));

      await handler.flush();
      expect(saveSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(200);
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    it('calls onError on adapter failure', async () => {
      const errors: Error[] = [];
      const handler = new EtsPersistenceHandler<string, number>('test', {
        adapter,
        onError: (err) => errors.push(err),
      });

      vi.spyOn(adapter, 'save').mockRejectedValueOnce(new Error('write failed'));

      handler.schedulePersist(createSnapshot<string, number>({
        tableName: 'test',
        entries: [{ key: 'k', value: 1, insertedAt: 0 }],
      }));

      await handler.flush();

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe('write failed');
    });
  });

  describe('shutdown', () => {
    it('flushes pending state when persistOnShutdown is true', async () => {
      const handler = new EtsPersistenceHandler<string, number>('test', {
        adapter,
        debounceMs: 5000,
        persistOnShutdown: true,
      });

      handler.schedulePersist(createSnapshot<string, number>({
        tableName: 'test',
        entries: [{ key: 'k', value: 1, insertedAt: 0 }],
      }));

      await handler.shutdown();

      expect(adapter.size).toBe(1);
    });

    it('discards pending state when persistOnShutdown is false', async () => {
      const handler = new EtsPersistenceHandler<string, number>('test', {
        adapter,
        debounceMs: 5000,
        persistOnShutdown: false,
      });

      handler.schedulePersist(createSnapshot<string, number>({
        tableName: 'test',
        entries: [{ key: 'k', value: 1, insertedAt: 0 }],
      }));

      await handler.shutdown();

      expect(adapter.size).toBe(0);
    });

    it('cleans up timer and clears pending state', async () => {
      const handler = new EtsPersistenceHandler<string, number>('test', {
        adapter,
        debounceMs: 5000,
        persistOnShutdown: false,
      });

      handler.schedulePersist(createSnapshot<string, number>({
        tableName: 'test',
        entries: [{ key: 'k', value: 1, insertedAt: 0 }],
      }));

      await handler.shutdown();
      expect(handler.hasPendingChanges()).toBe(false);
    });

    it('is idempotent when no pending changes', async () => {
      const handler = new EtsPersistenceHandler<string, number>('test', { adapter });
      await handler.shutdown();
      expect(adapter.size).toBe(0);
    });
  });

  describe('persistNow', () => {
    it('persists immediately without debounce', async () => {
      const handler = new EtsPersistenceHandler<string, number>('test', {
        adapter,
        debounceMs: 5000,
      });

      await handler.persistNow(createSnapshot<string, number>({
        tableName: 'test',
        entries: [{ key: 'k', value: 77, insertedAt: 100 }],
      }));

      expect(adapter.size).toBe(1);
      const saved = await adapter.load<PersistedEtsState<string, number>>('test');
      expect(saved!.state.entries[0]!.value).toBe(77);
    });
  });

  describe('hasPendingChanges', () => {
    it('returns false initially', () => {
      const handler = new EtsPersistenceHandler<string, number>('test', { adapter });
      expect(handler.hasPendingChanges()).toBe(false);
    });

    it('returns true after schedulePersist', () => {
      const handler = new EtsPersistenceHandler<string, number>('test', { adapter });
      handler.schedulePersist(createSnapshot<string, number>({
        tableName: 'test',
        entries: [{ key: 'k', value: 1, insertedAt: 0 }],
      }));
      expect(handler.hasPendingChanges()).toBe(true);
    });

    it('returns false after flush', async () => {
      const handler = new EtsPersistenceHandler<string, number>('test', { adapter });
      handler.schedulePersist(createSnapshot<string, number>({
        tableName: 'test',
        entries: [{ key: 'k', value: 1, insertedAt: 0 }],
      }));
      await handler.flush();
      expect(handler.hasPendingChanges()).toBe(false);
    });
  });

  describe('PersistedState metadata', () => {
    it('sets correct metadata in saved state', async () => {
      const handler = new EtsPersistenceHandler<string, number>('my-table', {
        adapter,
        debounceMs: 10,
      });

      handler.schedulePersist(createSnapshot<string, number>({
        tableName: 'my-table',
        entries: [{ key: 'k', value: 1, insertedAt: 0 }],
      }));

      await vi.advanceTimersByTimeAsync(10);

      const saved = await adapter.load<PersistedEtsState<string, number>>('my-table');
      expect(saved).toBeDefined();
      expect(saved!.metadata.serverId).toBe('ets:my-table');
      expect(saved!.metadata.serverName).toBe('my-table');
      expect(saved!.metadata.schemaVersion).toBe(1);
      expect(saved!.metadata.persistedAt).toBeGreaterThan(0);
    });
  });

  describe('storage key resolution', () => {
    it('uses table name as default key', async () => {
      const handler = new EtsPersistenceHandler<string, number>('my-table', { adapter });

      await handler.persistNow(createSnapshot<string, number>({
        tableName: 'my-table',
        entries: [],
      }));

      expect(await adapter.exists('my-table')).toBe(true);
    });

    it('uses custom key when provided', async () => {
      const handler = new EtsPersistenceHandler<string, number>('my-table', {
        adapter,
        key: 'custom-storage-key',
      });

      await handler.persistNow(createSnapshot<string, number>({
        tableName: 'my-table',
        entries: [],
      }));

      expect(await adapter.exists('custom-storage-key')).toBe(true);
      expect(await adapter.exists('my-table')).toBe(false);
    });
  });

  describe('error handling', () => {
    it('does not throw when onError is not configured', async () => {
      const handler = new EtsPersistenceHandler<string, number>('test', { adapter });

      vi.spyOn(adapter, 'save').mockRejectedValueOnce(new Error('fail'));

      await handler.persistNow(createSnapshot<string, number>({
        tableName: 'test',
        entries: [],
      }));
    });

    it('wraps non-Error values into Error', async () => {
      const errors: Error[] = [];
      const handler = new EtsPersistenceHandler<string, number>('test', {
        adapter,
        onError: (err) => errors.push(err),
      });

      vi.spyOn(adapter, 'save').mockRejectedValueOnce('string-error');

      await handler.persistNow(createSnapshot<string, number>({
        tableName: 'test',
        entries: [],
      }));

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe('string-error');
    });
  });
});

// =============================================================================
// EtsTable + Persistence Integration
// =============================================================================

describe('EtsTable with persistence', () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
    _resetEtsInstanceCounter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('set table', () => {
    it('restores entries on start', async () => {
      const persistedState: PersistedState<PersistedEtsState<string, number>> = {
        state: {
          tableName: 'counters',
          tableType: 'set',
          entries: [
            { key: 'hits', value: 100, insertedAt: 1000 },
            { key: 'errors', value: 5, insertedAt: 2000 },
          ],
          persistedAt: 3000,
        },
        metadata: { persistedAt: 3000, serverId: 'ets:counters', schemaVersion: 1 },
      };
      await adapter.save('counters', persistedState);

      const table = new EtsTable<string, number>({
        name: 'counters',
        type: 'set',
        persistence: { adapter },
      });
      await table.start();

      expect(table.size()).toBe(2);
      expect(table.lookup('hits')).toBe(100);
      expect(table.lookup('errors')).toBe(5);

      await table.close();
    });

    it('persists state on close', async () => {
      const table = new EtsTable<string, number>({
        name: 'data',
        type: 'set',
        persistence: { adapter },
      });
      await table.start();

      table.insert('a', 1);
      table.insert('b', 2);

      await table.close();

      const saved = await adapter.load<PersistedEtsState<string, number>>('data');
      expect(saved).toBeDefined();
      expect(saved!.state.entries).toHaveLength(2);

      const keys = saved!.state.entries.map((e) => e.key);
      expect(keys).toContain('a');
      expect(keys).toContain('b');
    });

    it('triggers debounced persistence on insert', async () => {
      const table = new EtsTable<string, number>({
        name: 'live',
        type: 'set',
        persistence: { adapter, debounceMs: 50 },
      });
      await table.start();

      table.insert('x', 10);

      expect(adapter.size).toBe(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(adapter.size).toBe(1);

      const saved = await adapter.load<PersistedEtsState<string, number>>('live');
      expect(saved!.state.entries).toHaveLength(1);
      expect(saved!.state.entries[0]!.key).toBe('x');

      await table.close();
    });

    it('triggers persistence on delete', async () => {
      const table = new EtsTable<string, number>({
        name: 'del',
        type: 'set',
        persistence: { adapter, debounceMs: 50 },
      });
      await table.start();

      table.insert('a', 1);
      table.insert('b', 2);
      await vi.advanceTimersByTimeAsync(50);

      table.delete('a');
      await vi.advanceTimersByTimeAsync(50);

      const saved = await adapter.load<PersistedEtsState<string, number>>('del');
      expect(saved!.state.entries).toHaveLength(1);
      expect(saved!.state.entries[0]!.key).toBe('b');

      await table.close();
    });

    it('triggers persistence on clear', async () => {
      const table = new EtsTable<string, number>({
        name: 'clr',
        type: 'set',
        persistence: { adapter, debounceMs: 50 },
      });
      await table.start();

      table.insert('a', 1);
      table.insert('b', 2);
      await vi.advanceTimersByTimeAsync(50);

      table.clear();
      await vi.advanceTimersByTimeAsync(50);

      const saved = await adapter.load<PersistedEtsState<string, number>>('clr');
      expect(saved!.state.entries).toHaveLength(0);

      await table.close();
    });

    it('triggers persistence on updateCounter', async () => {
      const table = new EtsTable<string, number>({
        name: 'ctr',
        type: 'set',
        persistence: { adapter, debounceMs: 50 },
      });
      await table.start();

      table.updateCounter('hits', 1);
      table.updateCounter('hits', 1);
      table.updateCounter('hits', 1);
      await vi.advanceTimersByTimeAsync(50);

      const saved = await adapter.load<PersistedEtsState<string, number>>('ctr');
      expect(saved!.state.entries).toHaveLength(1);
      expect(saved!.state.entries[0]!.value).toBe(3);

      await table.close();
    });
  });

  describe('ordered_set table', () => {
    it('restores entries in sorted order', async () => {
      const persistedState: PersistedState<PersistedEtsState<number, string>> = {
        state: {
          tableName: 'sorted',
          tableType: 'ordered_set',
          entries: [
            { key: 3, value: 'c', insertedAt: 100 },
            { key: 1, value: 'a', insertedAt: 200 },
            { key: 2, value: 'b', insertedAt: 300 },
          ],
          persistedAt: 400,
        },
        metadata: { persistedAt: 400, serverId: 'ets:sorted', schemaVersion: 1 },
      };
      await adapter.save('sorted', persistedState);

      const table = new EtsTable<number, string>({
        name: 'sorted',
        type: 'ordered_set',
        persistence: { adapter },
      });
      await table.start();

      expect(table.size()).toBe(3);
      const keys = table.keys();
      expect(keys).toEqual([1, 2, 3]);

      await table.close();
    });

    it('persists ordered entries on close', async () => {
      const table = new EtsTable<number, string>({
        name: 'ord',
        type: 'ordered_set',
        persistence: { adapter },
      });
      await table.start();

      table.insert(5, 'e');
      table.insert(1, 'a');
      table.insert(3, 'c');

      await table.close();

      const saved = await adapter.load<PersistedEtsState<number, string>>('ord');
      expect(saved!.state.entries).toHaveLength(3);
      expect(saved!.state.entries.map((e) => e.key)).toEqual([1, 3, 5]);
    });
  });

  describe('bag table', () => {
    it('restores bag entries correctly', async () => {
      const persistedState: PersistedState<PersistedEtsState<string, string>> = {
        state: {
          tableName: 'tags',
          tableType: 'bag',
          entries: [
            { key: 'post:1', value: 'js', insertedAt: 100 },
            { key: 'post:1', value: 'ts', insertedAt: 200 },
            { key: 'post:2', value: 'go', insertedAt: 300 },
          ],
          persistedAt: 400,
        },
        metadata: { persistedAt: 400, serverId: 'ets:tags', schemaVersion: 1 },
      };
      await adapter.save('tags', persistedState);

      const table = new EtsTable<string, string>({
        name: 'tags',
        type: 'bag',
        persistence: { adapter },
      });
      await table.start();

      expect(table.size()).toBe(3);
      expect(table.lookup('post:1')).toEqual(['js', 'ts']);
      expect(table.lookup('post:2')).toEqual(['go']);

      await table.close();
    });

    it('triggers persistence on deleteObject', async () => {
      const table = new EtsTable<string, string>({
        name: 'bg',
        type: 'bag',
        persistence: { adapter, debounceMs: 50 },
      });
      await table.start();

      table.insert('k', 'a');
      table.insert('k', 'b');
      table.insert('k', 'c');
      await vi.advanceTimersByTimeAsync(50);

      table.deleteObject('k', 'b');
      await vi.advanceTimersByTimeAsync(50);

      const saved = await adapter.load<PersistedEtsState<string, string>>('bg');
      const values = saved!.state.entries.map((e) => e.value);
      expect(values).toContain('a');
      expect(values).toContain('c');
      expect(values).not.toContain('b');

      await table.close();
    });
  });

  describe('duplicate_bag table', () => {
    it('restores duplicate entries', async () => {
      const persistedState: PersistedState<PersistedEtsState<string, number>> = {
        state: {
          tableName: 'events',
          tableType: 'duplicate_bag',
          entries: [
            { key: 'click', value: 1, insertedAt: 100 },
            { key: 'click', value: 1, insertedAt: 200 },
            { key: 'click', value: 2, insertedAt: 300 },
          ],
          persistedAt: 400,
        },
        metadata: { persistedAt: 400, serverId: 'ets:events', schemaVersion: 1 },
      };
      await adapter.save('events', persistedState);

      const table = new EtsTable<string, number>({
        name: 'events',
        type: 'duplicate_bag',
        persistence: { adapter },
      });
      await table.start();

      expect(table.size()).toBe(3);
      expect(table.lookup('click')).toEqual([1, 1, 2]);

      await table.close();
    });
  });

  describe('full lifecycle', () => {
    it('insert → close → new start → data restored', async () => {
      // First lifecycle
      const table1 = new EtsTable<string, { name: string; age: number }>({
        name: 'users',
        type: 'set',
        persistence: { adapter },
      });
      await table1.start();

      table1.insert('u1', { name: 'Alice', age: 30 });
      table1.insert('u2', { name: 'Bob', age: 25 });

      await table1.close();

      // Second lifecycle — data should be restored
      const table2 = new EtsTable<string, { name: string; age: number }>({
        name: 'users',
        type: 'set',
        persistence: { adapter },
      });
      await table2.start();

      expect(table2.size()).toBe(2);
      expect(table2.lookup('u1')).toEqual({ name: 'Alice', age: 30 });
      expect(table2.lookup('u2')).toEqual({ name: 'Bob', age: 25 });

      await table2.close();
    });

    it('mutations after restore are persisted on next close', async () => {
      // Seed data
      const table1 = new EtsTable<string, number>({
        name: 'state',
        type: 'set',
        persistence: { adapter },
      });
      await table1.start();
      table1.insert('a', 1);
      table1.insert('b', 2);
      await table1.close();

      // Restore and mutate
      const table2 = new EtsTable<string, number>({
        name: 'state',
        type: 'set',
        persistence: { adapter },
      });
      await table2.start();
      table2.delete('a');
      table2.insert('c', 3);
      await table2.close();

      // Verify final state
      const table3 = new EtsTable<string, number>({
        name: 'state',
        type: 'set',
        persistence: { adapter },
      });
      await table3.start();

      expect(table3.member('a')).toBe(false);
      expect(table3.lookup('b')).toBe(2);
      expect(table3.lookup('c')).toBe(3);

      await table3.close();
    });

    it('does not restore when restoreOnStart is false', async () => {
      // Seed data
      const table1 = new EtsTable<string, number>({
        name: 'ephemeral',
        type: 'set',
        persistence: { adapter },
      });
      await table1.start();
      table1.insert('a', 1);
      await table1.close();

      // Start with restoreOnStart: false
      const table2 = new EtsTable<string, number>({
        name: 'ephemeral',
        type: 'set',
        persistence: { adapter, restoreOnStart: false },
      });
      await table2.start();

      expect(table2.size()).toBe(0);

      await table2.close();
    });

    it('works without persistence configured', async () => {
      const table = new EtsTable<string, number>({
        name: 'no-persist',
        type: 'set',
      });
      await table.start();

      table.insert('a', 1);
      expect(table.lookup('a')).toBe(1);

      await table.close();
      expect(adapter.size).toBe(0);
    });
  });

  describe('error resilience', () => {
    it('table continues to operate when persistence fails on start', async () => {
      const errors: Error[] = [];
      const failingAdapter = new MemoryAdapter();
      vi.spyOn(failingAdapter, 'load').mockRejectedValueOnce(new Error('restore failed'));

      const table = new EtsTable<string, number>({
        name: 'resilient',
        type: 'set',
        persistence: {
          adapter: failingAdapter,
          onError: (err) => errors.push(err),
        },
      });
      await table.start();

      // Table should still work
      table.insert('a', 1);
      expect(table.lookup('a')).toBe(1);

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe('restore failed');

      await table.close();
    });

    it('table continues to operate when persistence fails on write', async () => {
      const errors: Error[] = [];
      const table = new EtsTable<string, number>({
        name: 'resilient-write',
        type: 'set',
        persistence: {
          adapter,
          debounceMs: 50,
          onError: (err) => errors.push(err),
        },
      });
      await table.start();

      vi.spyOn(adapter, 'save').mockRejectedValueOnce(new Error('write failed'));

      table.insert('a', 1);
      await vi.advanceTimersByTimeAsync(50);

      // Table data is still intact
      expect(table.lookup('a')).toBe(1);
      expect(errors).toHaveLength(1);

      await table.close();
    });
  });
});
