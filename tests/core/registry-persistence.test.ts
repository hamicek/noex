/**
 * Tests for registry persistence helpers:
 * - serializeRegistryState / deserializeRegistryState
 * - RegistryPersistenceHandler (debounced persist, restore, shutdown)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  serializeRegistryState,
  deserializeRegistryState,
  RegistryPersistenceHandler,
  type RegistryStateSnapshot,
  type RefResolver,
} from '../../src/core/registry-persistence.js';
import type { RegisterableRef, PersistedRegistryState } from '../../src/core/registry-types.js';
import type { PersistedState } from '../../src/persistence/types.js';
import { MemoryAdapter } from '../../src/persistence/adapters/memory-adapter.js';

// =============================================================================
// Helpers
// =============================================================================

function createRef(id: string): RegisterableRef {
  return { id, type: 'genserver' } as RegisterableRef;
}

function createSnapshot(
  overrides: Partial<RegistryStateSnapshot> = {},
): RegistryStateSnapshot {
  return {
    name: overrides.name ?? 'test-registry',
    keyMode: overrides.keyMode ?? 'unique',
    entries: overrides.entries ?? [],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// serializeRegistryState
// =============================================================================

describe('serializeRegistryState', () => {
  it('serializes empty state', () => {
    const snapshot = createSnapshot();
    const result = serializeRegistryState(snapshot);

    expect(result.registryName).toBe('test-registry');
    expect(result.keyMode).toBe('unique');
    expect(result.entries).toEqual([]);
    expect(result.persistedAt).toBeGreaterThan(0);
  });

  it('serializes entries with refs converted to IDs', () => {
    const refA = createRef('ref-a');
    const refB = createRef('ref-b');

    const snapshot = createSnapshot({
      name: 'services',
      keyMode: 'unique',
      entries: [
        { key: 'auth', entry: { ref: refA, metadata: { role: 'auth' }, registeredAt: 1000 } },
        { key: 'cache', entry: { ref: refB, metadata: { role: 'cache' }, registeredAt: 2000 } },
      ],
    });

    const result = serializeRegistryState(snapshot);

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({
      key: 'auth',
      refId: 'ref-a',
      metadata: { role: 'auth' },
      registeredAt: 1000,
    });
    expect(result.entries[1]).toEqual({
      key: 'cache',
      refId: 'ref-b',
      metadata: { role: 'cache' },
      registeredAt: 2000,
    });
  });

  it('serializes duplicate-mode entries with same key', () => {
    const refA = createRef('ref-a');
    const refB = createRef('ref-b');

    const snapshot = createSnapshot({
      keyMode: 'duplicate',
      entries: [
        { key: 'events:user', entry: { ref: refA, metadata: undefined, registeredAt: 100 } },
        { key: 'events:user', entry: { ref: refB, metadata: undefined, registeredAt: 200 } },
      ],
    });

    const result = serializeRegistryState(snapshot);

    expect(result.keyMode).toBe('duplicate');
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.key).toBe('events:user');
    expect(result.entries[1]!.key).toBe('events:user');
    expect(result.entries[0]!.refId).toBe('ref-a');
    expect(result.entries[1]!.refId).toBe('ref-b');
  });

  it('preserves null/undefined metadata', () => {
    const snapshot = createSnapshot({
      entries: [
        { key: 'k', entry: { ref: createRef('r'), metadata: null, registeredAt: 0 } },
      ],
    });

    const result = serializeRegistryState(snapshot);
    expect(result.entries[0]!.metadata).toBeNull();
  });

  it('sets persistedAt to current time', () => {
    const before = Date.now();
    const result = serializeRegistryState(createSnapshot());
    const after = Date.now();

    expect(result.persistedAt).toBeGreaterThanOrEqual(before);
    expect(result.persistedAt).toBeLessThanOrEqual(after);
  });
});

// =============================================================================
// deserializeRegistryState
// =============================================================================

describe('deserializeRegistryState', () => {
  it('deserializes empty state', () => {
    const persisted: PersistedRegistryState = {
      registryName: 'test',
      keyMode: 'unique',
      entries: [],
      persistedAt: 1000,
    };

    const resolver: RefResolver = () => undefined;
    const result = deserializeRegistryState(persisted, resolver);

    expect(result.registryName).toBe('test');
    expect(result.keyMode).toBe('unique');
    expect(result.entries).toEqual([]);
    expect(result.skippedCount).toBe(0);
  });

  it('resolves live refs', () => {
    const refA = createRef('ref-a');
    const refB = createRef('ref-b');

    const persisted: PersistedRegistryState = {
      registryName: 'services',
      keyMode: 'unique',
      entries: [
        { key: 'auth', refId: 'ref-a', metadata: { role: 'auth' }, registeredAt: 1000 },
        { key: 'cache', refId: 'ref-b', metadata: { role: 'cache' }, registeredAt: 2000 },
      ],
      persistedAt: 3000,
    };

    const resolver: RefResolver = (id) => {
      if (id === 'ref-a') return refA;
      if (id === 'ref-b') return refB;
      return undefined;
    };

    const result = deserializeRegistryState(persisted, resolver);

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({
      key: 'auth',
      entry: { ref: refA, metadata: { role: 'auth' }, registeredAt: 1000 },
    });
    expect(result.entries[1]).toEqual({
      key: 'cache',
      entry: { ref: refB, metadata: { role: 'cache' }, registeredAt: 2000 },
    });
    expect(result.skippedCount).toBe(0);
  });

  it('skips dead refs', () => {
    const refA = createRef('ref-a');

    const persisted: PersistedRegistryState = {
      registryName: 'test',
      keyMode: 'unique',
      entries: [
        { key: 'alive', refId: 'ref-a', metadata: null, registeredAt: 100 },
        { key: 'dead1', refId: 'ref-dead-1', metadata: null, registeredAt: 200 },
        { key: 'dead2', refId: 'ref-dead-2', metadata: null, registeredAt: 300 },
      ],
      persistedAt: 500,
    };

    const resolver: RefResolver = (id) => (id === 'ref-a' ? refA : undefined);
    const result = deserializeRegistryState(persisted, resolver);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.key).toBe('alive');
    expect(result.skippedCount).toBe(2);
  });

  it('skips all entries when all refs are dead', () => {
    const persisted: PersistedRegistryState = {
      registryName: 'test',
      keyMode: 'duplicate',
      entries: [
        { key: 'k1', refId: 'dead-1', metadata: null, registeredAt: 100 },
        { key: 'k2', refId: 'dead-2', metadata: null, registeredAt: 200 },
      ],
      persistedAt: 500,
    };

    const resolver: RefResolver = () => undefined;
    const result = deserializeRegistryState(persisted, resolver);

    expect(result.entries).toHaveLength(0);
    expect(result.skippedCount).toBe(2);
  });

  it('preserves original registeredAt timestamps', () => {
    const ref = createRef('ref-1');

    const persisted: PersistedRegistryState = {
      registryName: 'test',
      keyMode: 'unique',
      entries: [
        { key: 'k', refId: 'ref-1', metadata: null, registeredAt: 42 },
      ],
      persistedAt: 1000,
    };

    const resolver: RefResolver = (id) => (id === 'ref-1' ? ref : undefined);
    const result = deserializeRegistryState(persisted, resolver);

    expect(result.entries[0]!.entry.registeredAt).toBe(42);
  });

  it('handles duplicate mode with multiple entries per key', () => {
    const refA = createRef('ref-a');
    const refC = createRef('ref-c');

    const persisted: PersistedRegistryState = {
      registryName: 'topics',
      keyMode: 'duplicate',
      entries: [
        { key: 'user:created', refId: 'ref-a', metadata: { handler: 1 }, registeredAt: 100 },
        { key: 'user:created', refId: 'ref-b', metadata: { handler: 2 }, registeredAt: 200 },
        { key: 'user:created', refId: 'ref-c', metadata: { handler: 3 }, registeredAt: 300 },
      ],
      persistedAt: 500,
    };

    const resolver: RefResolver = (id) => {
      if (id === 'ref-a') return refA;
      if (id === 'ref-c') return refC;
      return undefined;
    };

    const result = deserializeRegistryState(persisted, resolver);

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.entry.ref).toBe(refA);
    expect(result.entries[1]!.entry.ref).toBe(refC);
    expect(result.skippedCount).toBe(1);
  });
});

// =============================================================================
// RegistryPersistenceHandler
// =============================================================================

describe('RegistryPersistenceHandler', () => {
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
      const handler = new RegistryPersistenceHandler('test', { adapter });
      const resolver: RefResolver = () => undefined;

      const result = await handler.restore(resolver);
      expect(result).toBeUndefined();
    });

    it('returns undefined when restoreOnStart is false', async () => {
      const persistedState: PersistedState<PersistedRegistryState> = {
        state: {
          registryName: 'test',
          keyMode: 'unique',
          entries: [{ key: 'k', refId: 'r', metadata: null, registeredAt: 100 }],
          persistedAt: 500,
        },
        metadata: { persistedAt: 500, serverId: 'registry:test', schemaVersion: 1 },
      };
      await adapter.save('test', persistedState);

      const handler = new RegistryPersistenceHandler('test', {
        adapter,
        restoreOnStart: false,
      });
      const resolver: RefResolver = () => createRef('r');

      const result = await handler.restore(resolver);
      expect(result).toBeUndefined();
    });

    it('restores persisted entries with live refs', async () => {
      const refA = createRef('ref-a');
      const persistedState: PersistedState<PersistedRegistryState> = {
        state: {
          registryName: 'test',
          keyMode: 'unique',
          entries: [
            { key: 'service-a', refId: 'ref-a', metadata: { port: 8080 }, registeredAt: 1000 },
          ],
          persistedAt: 2000,
        },
        metadata: { persistedAt: 2000, serverId: 'registry:test', schemaVersion: 1 },
      };
      await adapter.save('test', persistedState);

      const handler = new RegistryPersistenceHandler('test', { adapter });
      const resolver: RefResolver = (id) => (id === 'ref-a' ? refA : undefined);

      const result = await handler.restore(resolver);

      expect(result).toBeDefined();
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0]!.key).toBe('service-a');
      expect(result!.entries[0]!.entry.ref).toBe(refA);
      expect(result!.entries[0]!.entry.metadata).toEqual({ port: 8080 });
    });

    it('uses custom storage key', async () => {
      const persistedState: PersistedState<PersistedRegistryState> = {
        state: {
          registryName: 'test',
          keyMode: 'unique',
          entries: [{ key: 'k', refId: 'r', metadata: null, registeredAt: 0 }],
          persistedAt: 100,
        },
        metadata: { persistedAt: 100, serverId: 'registry:test', schemaVersion: 1 },
      };
      await adapter.save('custom-key', persistedState);

      const handler = new RegistryPersistenceHandler('test', {
        adapter,
        key: 'custom-key',
      });
      const resolver: RefResolver = (id) => (id === 'r' ? createRef('r') : undefined);

      const result = await handler.restore(resolver);
      expect(result).toBeDefined();
      expect(result!.entries).toHaveLength(1);
    });

    it('calls onError and returns undefined on adapter failure', async () => {
      const errors: Error[] = [];
      const failingAdapter: MemoryAdapter = Object.create(adapter);
      failingAdapter.load = () => Promise.reject(new Error('disk failure'));

      const handler = new RegistryPersistenceHandler('test', {
        adapter: failingAdapter,
        onError: (err) => errors.push(err),
      });

      const result = await handler.restore(() => undefined);

      expect(result).toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe('disk failure');
    });
  });

  describe('schedulePersist / debounce', () => {
    it('persists after debounce interval', async () => {
      const handler = new RegistryPersistenceHandler('test', {
        adapter,
        debounceMs: 50,
      });

      const snapshot = createSnapshot({
        name: 'test',
        entries: [
          { key: 'k', entry: { ref: createRef('r'), metadata: null, registeredAt: 100 } },
        ],
      });

      handler.schedulePersist(snapshot);
      expect(adapter.size).toBe(0);

      await vi.advanceTimersByTimeAsync(50);

      expect(adapter.size).toBe(1);
      const saved = await adapter.load<PersistedRegistryState>('test');
      expect(saved).toBeDefined();
      expect(saved!.state.entries).toHaveLength(1);
      expect(saved!.state.entries[0]!.refId).toBe('r');
    });

    it('batches multiple rapid changes', async () => {
      const saveSpy = vi.spyOn(adapter, 'save');

      const handler = new RegistryPersistenceHandler('test', {
        adapter,
        debounceMs: 100,
      });

      handler.schedulePersist(createSnapshot({
        name: 'test',
        entries: [{ key: 'k1', entry: { ref: createRef('r1'), metadata: null, registeredAt: 1 } }],
      }));

      await vi.advanceTimersByTimeAsync(30);

      handler.schedulePersist(createSnapshot({
        name: 'test',
        entries: [
          { key: 'k1', entry: { ref: createRef('r1'), metadata: null, registeredAt: 1 } },
          { key: 'k2', entry: { ref: createRef('r2'), metadata: null, registeredAt: 2 } },
        ],
      }));

      await vi.advanceTimersByTimeAsync(30);

      handler.schedulePersist(createSnapshot({
        name: 'test',
        entries: [
          { key: 'k1', entry: { ref: createRef('r1'), metadata: null, registeredAt: 1 } },
          { key: 'k2', entry: { ref: createRef('r2'), metadata: null, registeredAt: 2 } },
          { key: 'k3', entry: { ref: createRef('r3'), metadata: null, registeredAt: 3 } },
        ],
      }));

      // Not yet persisted (debounce resets)
      expect(saveSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);

      // Only one save with the final state
      expect(saveSpy).toHaveBeenCalledTimes(1);
      const saved = await adapter.load<PersistedRegistryState>('test');
      expect(saved!.state.entries).toHaveLength(3);
    });

    it('does nothing when persistOnChange is false', async () => {
      const handler = new RegistryPersistenceHandler('test', {
        adapter,
        persistOnChange: false,
        debounceMs: 10,
      });

      handler.schedulePersist(createSnapshot({
        entries: [{ key: 'k', entry: { ref: createRef('r'), metadata: null, registeredAt: 0 } }],
      }));

      await vi.advanceTimersByTimeAsync(100);
      expect(adapter.size).toBe(0);
    });

    it('uses default debounceMs of 100', async () => {
      const handler = new RegistryPersistenceHandler('test', { adapter });

      handler.schedulePersist(createSnapshot({
        entries: [{ key: 'k', entry: { ref: createRef('r'), metadata: null, registeredAt: 0 } }],
      }));

      await vi.advanceTimersByTimeAsync(99);
      expect(adapter.size).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(adapter.size).toBe(1);
    });
  });

  describe('flush', () => {
    it('immediately writes pending state', async () => {
      const handler = new RegistryPersistenceHandler('test', {
        adapter,
        debounceMs: 1000,
      });

      handler.schedulePersist(createSnapshot({
        name: 'test',
        entries: [{ key: 'k', entry: { ref: createRef('r'), metadata: 'data', registeredAt: 50 } }],
      }));

      await handler.flush();

      expect(adapter.size).toBe(1);
      const saved = await adapter.load<PersistedRegistryState>('test');
      expect(saved!.state.entries[0]!.metadata).toBe('data');
    });

    it('does nothing when no pending changes', async () => {
      const saveSpy = vi.spyOn(adapter, 'save');
      const handler = new RegistryPersistenceHandler('test', { adapter });

      await handler.flush();
      expect(saveSpy).not.toHaveBeenCalled();
    });

    it('cancels pending debounce timer', async () => {
      const saveSpy = vi.spyOn(adapter, 'save');
      const handler = new RegistryPersistenceHandler('test', {
        adapter,
        debounceMs: 100,
      });

      handler.schedulePersist(createSnapshot({
        entries: [{ key: 'k', entry: { ref: createRef('r'), metadata: null, registeredAt: 0 } }],
      }));

      await handler.flush();
      expect(saveSpy).toHaveBeenCalledTimes(1);

      // Timer should be cancelled — no extra save after debounce period
      await vi.advanceTimersByTimeAsync(200);
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    it('calls onError on adapter failure', async () => {
      const errors: Error[] = [];
      const handler = new RegistryPersistenceHandler('test', {
        adapter,
        onError: (err) => errors.push(err),
      });

      vi.spyOn(adapter, 'save').mockRejectedValueOnce(new Error('write failed'));

      handler.schedulePersist(createSnapshot({
        entries: [{ key: 'k', entry: { ref: createRef('r'), metadata: null, registeredAt: 0 } }],
      }));

      await handler.flush();

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe('write failed');
    });
  });

  describe('shutdown', () => {
    it('flushes pending state when persistOnShutdown is true', async () => {
      const handler = new RegistryPersistenceHandler('test', {
        adapter,
        debounceMs: 5000,
        persistOnShutdown: true,
      });

      handler.schedulePersist(createSnapshot({
        entries: [{ key: 'k', entry: { ref: createRef('r'), metadata: null, registeredAt: 0 } }],
      }));

      await handler.shutdown();

      expect(adapter.size).toBe(1);
    });

    it('discards pending state when persistOnShutdown is false', async () => {
      const handler = new RegistryPersistenceHandler('test', {
        adapter,
        debounceMs: 5000,
        persistOnShutdown: false,
      });

      handler.schedulePersist(createSnapshot({
        entries: [{ key: 'k', entry: { ref: createRef('r'), metadata: null, registeredAt: 0 } }],
      }));

      await handler.shutdown();

      expect(adapter.size).toBe(0);
    });

    it('cleans up timer when no pending snapshot and persistOnShutdown is false', async () => {
      const handler = new RegistryPersistenceHandler('test', {
        adapter,
        debounceMs: 5000,
        persistOnShutdown: false,
      });

      handler.schedulePersist(createSnapshot({
        entries: [{ key: 'k', entry: { ref: createRef('r'), metadata: null, registeredAt: 0 } }],
      }));

      await handler.shutdown();
      expect(handler.hasPendingChanges()).toBe(false);
    });

    it('is idempotent when no pending changes', async () => {
      const handler = new RegistryPersistenceHandler('test', { adapter });
      await handler.shutdown();
      expect(adapter.size).toBe(0);
    });
  });

  describe('persistNow', () => {
    it('persists immediately without debounce', async () => {
      const handler = new RegistryPersistenceHandler('test', {
        adapter,
        debounceMs: 5000,
      });

      await handler.persistNow(createSnapshot({
        name: 'test',
        entries: [{ key: 'k', entry: { ref: createRef('r'), metadata: 42, registeredAt: 100 } }],
      }));

      expect(adapter.size).toBe(1);
      const saved = await adapter.load<PersistedRegistryState>('test');
      expect(saved!.state.entries[0]!.metadata).toBe(42);
    });
  });

  describe('hasPendingChanges', () => {
    it('returns false initially', () => {
      const handler = new RegistryPersistenceHandler('test', { adapter });
      expect(handler.hasPendingChanges()).toBe(false);
    });

    it('returns true after schedulePersist', () => {
      const handler = new RegistryPersistenceHandler('test', { adapter });
      handler.schedulePersist(createSnapshot({
        entries: [{ key: 'k', entry: { ref: createRef('r'), metadata: null, registeredAt: 0 } }],
      }));
      expect(handler.hasPendingChanges()).toBe(true);
    });

    it('returns false after flush', async () => {
      const handler = new RegistryPersistenceHandler('test', { adapter });
      handler.schedulePersist(createSnapshot({
        entries: [{ key: 'k', entry: { ref: createRef('r'), metadata: null, registeredAt: 0 } }],
      }));
      await handler.flush();
      expect(handler.hasPendingChanges()).toBe(false);
    });
  });

  describe('PersistedState metadata', () => {
    it('sets correct metadata in saved state', async () => {
      const handler = new RegistryPersistenceHandler('my-registry', {
        adapter,
        debounceMs: 10,
      });

      handler.schedulePersist(createSnapshot({
        name: 'my-registry',
        entries: [{ key: 'k', entry: { ref: createRef('r'), metadata: null, registeredAt: 0 } }],
      }));

      await vi.advanceTimersByTimeAsync(10);

      const saved = await adapter.load<PersistedRegistryState>('my-registry');
      expect(saved).toBeDefined();
      expect(saved!.metadata.serverId).toBe('registry:my-registry');
      expect(saved!.metadata.serverName).toBe('my-registry');
      expect(saved!.metadata.schemaVersion).toBe(1);
      expect(saved!.metadata.persistedAt).toBeGreaterThan(0);
    });
  });

  describe('storage key resolution', () => {
    it('uses registry name as default key', async () => {
      const handler = new RegistryPersistenceHandler('my-reg', { adapter });

      await handler.persistNow(createSnapshot({
        name: 'my-reg',
        entries: [],
      }));

      expect(await adapter.exists('my-reg')).toBe(true);
    });

    it('uses custom key when provided', async () => {
      const handler = new RegistryPersistenceHandler('my-reg', {
        adapter,
        key: 'custom-storage-key',
      });

      await handler.persistNow(createSnapshot({ entries: [] }));

      expect(await adapter.exists('custom-storage-key')).toBe(true);
      expect(await adapter.exists('my-reg')).toBe(false);
    });
  });

  describe('error handling', () => {
    it('does not throw when onError is not configured', async () => {
      const handler = new RegistryPersistenceHandler('test', { adapter });

      vi.spyOn(adapter, 'save').mockRejectedValueOnce(new Error('fail'));

      // Should not throw
      await handler.persistNow(createSnapshot({ entries: [] }));
    });

    it('wraps non-Error values into Error', async () => {
      const errors: Error[] = [];
      const handler = new RegistryPersistenceHandler('test', {
        adapter,
        onError: (err) => errors.push(err),
      });

      vi.spyOn(adapter, 'save').mockRejectedValueOnce('string-error');

      await handler.persistNow(createSnapshot({ entries: [] }));

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe('string-error');
    });
  });
});
