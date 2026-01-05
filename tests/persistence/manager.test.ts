import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PersistenceManager,
  MemoryAdapter,
  StateNotFoundError,
  StaleStateError,
  MigrationError,
  StorageError,
} from '../../src/persistence/index.js';
import type { PersistenceConfig, StorageAdapter, PersistedState } from '../../src/persistence/index.js';

describe('PersistenceManager', () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  describe('constructor', () => {
    it('throws when adapter is missing', () => {
      expect(() => {
        new PersistenceManager({} as PersistenceConfig<unknown>);
      }).toThrow('PersistenceManager requires a storage adapter');
    });

    it('creates manager with minimal config', () => {
      const manager = new PersistenceManager({ adapter });
      expect(manager).toBeInstanceOf(PersistenceManager);
    });

    it('uses default schema version of 1', () => {
      const manager = new PersistenceManager({ adapter });
      expect(manager.getSchemaVersion()).toBe(1);
    });

    it('uses custom schema version', () => {
      const manager = new PersistenceManager({ adapter, schemaVersion: 5 });
      expect(manager.getSchemaVersion()).toBe(5);
    });
  });

  describe('getKey / withKey', () => {
    it('returns empty string when no key configured', () => {
      const manager = new PersistenceManager({ adapter });
      expect(manager.getKey()).toBe('');
    });

    it('returns configured key', () => {
      const manager = new PersistenceManager({ adapter, key: 'my-key' });
      expect(manager.getKey()).toBe('my-key');
    });

    it('withKey returns new manager with updated key', () => {
      const manager = new PersistenceManager({ adapter, key: 'old-key' });
      const newManager = manager.withKey('new-key');

      expect(manager.getKey()).toBe('old-key');
      expect(newManager.getKey()).toBe('new-key');
    });

    it('withKey preserves other config options', () => {
      const manager = new PersistenceManager({
        adapter,
        key: 'old-key',
        schemaVersion: 5,
        maxStateAgeMs: 10000,
      });
      const newManager = manager.withKey('new-key');

      expect(newManager.getSchemaVersion()).toBe(5);
    });
  });

  describe('save', () => {
    it('persists state with metadata', async () => {
      const manager = new PersistenceManager({ adapter, key: 'test' });

      await manager.save({ count: 42 }, { serverId: 'server-1' });

      const stored = await adapter.load<{ count: number }>('test');
      expect(stored).toBeDefined();
      expect(stored!.state).toEqual({ count: 42 });
      expect(stored!.metadata.serverId).toBe('server-1');
      expect(stored!.metadata.schemaVersion).toBe(1);
    });

    it('includes optional serverName in metadata', async () => {
      const manager = new PersistenceManager({ adapter, key: 'test' });

      await manager.save(
        { value: 1 },
        { serverId: 'server-1', serverName: 'my-server' }
      );

      const stored = await adapter.load<unknown>('test');
      expect(stored!.metadata.serverName).toBe('my-server');
    });

    it('includes optional checksum in metadata', async () => {
      const manager = new PersistenceManager({ adapter, key: 'test' });

      await manager.save(
        { value: 1 },
        { serverId: 'server-1', checksum: 'abc123' }
      );

      const stored = await adapter.load<unknown>('test');
      expect(stored!.metadata.checksum).toBe('abc123');
    });

    it('uses custom schema version in metadata', async () => {
      const manager = new PersistenceManager({
        adapter,
        key: 'test',
        schemaVersion: 3,
      });

      await manager.save({ v: 3 }, { serverId: 'server-1' });

      const stored = await adapter.load<unknown>('test');
      expect(stored!.metadata.schemaVersion).toBe(3);
    });

    it('applies custom serialize function', async () => {
      const manager = new PersistenceManager({
        adapter,
        key: 'test',
        serialize: (state: { date: Date }) => ({
          date: state.date.toISOString(),
        }),
      });

      const date = new Date('2024-01-15T12:00:00Z');
      await manager.save({ date }, { serverId: 'server-1' });

      const stored = await adapter.load<{ date: string }>('test');
      expect(stored!.state.date).toBe('2024-01-15T12:00:00.000Z');
    });

    it('sets persistedAt timestamp', async () => {
      const manager = new PersistenceManager({ adapter, key: 'test' });
      const before = Date.now();

      await manager.save({ x: 1 }, { serverId: 'server-1' });

      const after = Date.now();
      const stored = await adapter.load<unknown>('test');
      expect(stored!.metadata.persistedAt).toBeGreaterThanOrEqual(before);
      expect(stored!.metadata.persistedAt).toBeLessThanOrEqual(after);
    });

    it('calls onError callback on failure', async () => {
      const onError = vi.fn();
      const failingAdapter: StorageAdapter = {
        ...adapter,
        save: vi.fn().mockRejectedValue(new Error('Save failed')),
      };

      const manager = new PersistenceManager({
        adapter: failingAdapter,
        key: 'test',
        onError,
      });

      await expect(
        manager.save({ x: 1 }, { serverId: 'server-1' })
      ).rejects.toThrow(StorageError);

      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0]).toBeInstanceOf(StorageError);
    });
  });

  describe('load', () => {
    it('returns failure when state not found', async () => {
      const manager = new PersistenceManager({ adapter, key: 'missing' });

      const result = await manager.load<unknown>();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(StateNotFoundError);
      }
    });

    it('returns success with state and metadata', async () => {
      const manager = new PersistenceManager({ adapter, key: 'test' });
      await manager.save({ count: 42 }, { serverId: 'server-1' });

      const result = await manager.load<{ count: number }>();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.state.count).toBe(42);
        expect(result.metadata.serverId).toBe('server-1');
      }
    });

    it('applies custom deserialize function', async () => {
      const manager = new PersistenceManager({
        adapter,
        key: 'test',
        serialize: (state: { date: Date }) => ({
          date: state.date.toISOString(),
        }),
        deserialize: (data: unknown) => ({
          date: new Date((data as { date: string }).date),
        }),
      });

      const date = new Date('2024-01-15T12:00:00Z');
      await manager.save({ date }, { serverId: 'server-1' });

      const result = await manager.load<{ date: Date }>();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.state.date).toBeInstanceOf(Date);
        expect(result.state.date.toISOString()).toBe('2024-01-15T12:00:00.000Z');
      }
    });
  });

  describe('load - state age validation', () => {
    it('accepts state within max age', async () => {
      const manager = new PersistenceManager({
        adapter,
        key: 'test',
        maxStateAgeMs: 60000, // 1 minute
      });
      await manager.save({ x: 1 }, { serverId: 'server-1' });

      const result = await manager.load<{ x: number }>();

      expect(result.success).toBe(true);
    });

    it('rejects state exceeding max age', async () => {
      const manager = new PersistenceManager({
        adapter,
        key: 'test',
        maxStateAgeMs: 1000, // 1 second
      });

      // Manually insert old state
      await adapter.save('test', {
        state: { x: 1 },
        metadata: {
          persistedAt: Date.now() - 5000, // 5 seconds ago
          serverId: 'server-1',
          schemaVersion: 1,
        },
      });

      const result = await manager.load<{ x: number }>();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(StaleStateError);
        const staleError = result.error as StaleStateError;
        expect(staleError.key).toBe('test');
        expect(staleError.ageMs).toBeGreaterThan(1000);
        expect(staleError.maxAgeMs).toBe(1000);
      }
    });

    it('calls onError for stale state', async () => {
      const onError = vi.fn();
      const manager = new PersistenceManager({
        adapter,
        key: 'test',
        maxStateAgeMs: 1000,
        onError,
      });

      await adapter.save('test', {
        state: {},
        metadata: {
          persistedAt: Date.now() - 5000,
          serverId: 'server-1',
          schemaVersion: 1,
        },
      });

      await manager.load<unknown>();

      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0]).toBeInstanceOf(StaleStateError);
    });
  });

  describe('load - schema migration', () => {
    it('migrates state from older version', async () => {
      interface StateV1 {
        name: string;
      }
      interface StateV2 {
        name: string;
        email: string;
      }

      const manager = new PersistenceManager<StateV2>({
        adapter,
        key: 'test',
        schemaVersion: 2,
        migrate: (oldState, oldVersion) => {
          if (oldVersion === 1) {
            return {
              ...(oldState as StateV1),
              email: 'default@example.com',
            };
          }
          return oldState as StateV2;
        },
      });

      // Insert v1 state
      await adapter.save('test', {
        state: { name: 'Alice' },
        metadata: {
          persistedAt: Date.now(),
          serverId: 'server-1',
          schemaVersion: 1,
        },
      });

      const result = await manager.load();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.state.name).toBe('Alice');
        expect(result.state.email).toBe('default@example.com');
      }
    });

    it('handles migration errors', async () => {
      const manager = new PersistenceManager({
        adapter,
        key: 'test',
        schemaVersion: 2,
        migrate: () => {
          throw new Error('Migration failed');
        },
      });

      await adapter.save('test', {
        state: { x: 1 },
        metadata: {
          persistedAt: Date.now(),
          serverId: 'server-1',
          schemaVersion: 1,
        },
      });

      const result = await manager.load<unknown>();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(MigrationError);
        const migError = result.error as MigrationError;
        expect(migError.fromVersion).toBe(1);
        expect(migError.toVersion).toBe(2);
      }
    });

    it('calls onError for migration failures', async () => {
      const onError = vi.fn();
      const manager = new PersistenceManager({
        adapter,
        key: 'test',
        schemaVersion: 2,
        migrate: () => {
          throw new Error('Migration failed');
        },
        onError,
      });

      await adapter.save('test', {
        state: {},
        metadata: {
          persistedAt: Date.now(),
          serverId: 'server-1',
          schemaVersion: 1,
        },
      });

      await manager.load<unknown>();

      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0]).toBeInstanceOf(MigrationError);
    });

    it('skips migration when versions match', async () => {
      const migrate = vi.fn();
      const manager = new PersistenceManager({
        adapter,
        key: 'test',
        schemaVersion: 2,
        migrate,
      });

      await adapter.save('test', {
        state: { x: 1 },
        metadata: {
          persistedAt: Date.now(),
          serverId: 'server-1',
          schemaVersion: 2,
        },
      });

      await manager.load<unknown>();

      expect(migrate).not.toHaveBeenCalled();
    });

    it('proceeds without migration function when versions differ', async () => {
      const manager = new PersistenceManager({
        adapter,
        key: 'test',
        schemaVersion: 2,
        // No migrate function
      });

      await adapter.save('test', {
        state: { x: 1 },
        metadata: {
          persistedAt: Date.now(),
          serverId: 'server-1',
          schemaVersion: 1,
        },
      });

      const result = await manager.load<{ x: number }>();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.state.x).toBe(1);
      }
    });
  });

  describe('delete', () => {
    it('returns true when state is deleted', async () => {
      const manager = new PersistenceManager({ adapter, key: 'test' });
      await manager.save({ x: 1 }, { serverId: 'server-1' });

      const result = await manager.delete();

      expect(result).toBe(true);
      expect(await adapter.exists('test')).toBe(false);
    });

    it('returns false when state does not exist', async () => {
      const manager = new PersistenceManager({ adapter, key: 'missing' });

      const result = await manager.delete();

      expect(result).toBe(false);
    });

    it('calls onError callback on failure', async () => {
      const onError = vi.fn();
      const failingAdapter: StorageAdapter = {
        ...adapter,
        delete: vi.fn().mockRejectedValue(new Error('Delete failed')),
      };

      const manager = new PersistenceManager({
        adapter: failingAdapter,
        key: 'test',
        onError,
      });

      await expect(manager.delete()).rejects.toThrow(StorageError);
      expect(onError).toHaveBeenCalledOnce();
    });
  });

  describe('getMetadata', () => {
    it('returns undefined when state does not exist', async () => {
      const manager = new PersistenceManager({ adapter, key: 'missing' });

      const metadata = await manager.getMetadata();

      expect(metadata).toBeUndefined();
    });

    it('returns metadata without loading full state', async () => {
      const manager = new PersistenceManager({ adapter, key: 'test' });
      await manager.save(
        { largeData: 'x'.repeat(10000) },
        { serverId: 'server-1', serverName: 'my-server' }
      );

      const metadata = await manager.getMetadata();

      expect(metadata).toBeDefined();
      expect(metadata!.serverId).toBe('server-1');
      expect(metadata!.serverName).toBe('my-server');
      expect(metadata!.schemaVersion).toBe(1);
    });

    it('calls onError callback on failure', async () => {
      const onError = vi.fn();
      const failingAdapter: StorageAdapter = {
        ...adapter,
        load: vi.fn().mockRejectedValue(new Error('Load failed')),
      };

      const manager = new PersistenceManager({
        adapter: failingAdapter,
        key: 'test',
        onError,
      });

      await expect(manager.getMetadata()).rejects.toThrow(StorageError);
      expect(onError).toHaveBeenCalledOnce();
    });
  });

  describe('exists', () => {
    it('returns false when state does not exist', async () => {
      const manager = new PersistenceManager({ adapter, key: 'missing' });

      expect(await manager.exists()).toBe(false);
    });

    it('returns true when state exists', async () => {
      const manager = new PersistenceManager({ adapter, key: 'test' });
      await manager.save({ x: 1 }, { serverId: 'server-1' });

      expect(await manager.exists()).toBe(true);
    });

    it('calls onError callback on failure', async () => {
      const onError = vi.fn();
      const failingAdapter: StorageAdapter = {
        ...adapter,
        exists: vi.fn().mockRejectedValue(new Error('Exists failed')),
      };

      const manager = new PersistenceManager({
        adapter: failingAdapter,
        key: 'test',
        onError,
      });

      await expect(manager.exists()).rejects.toThrow(StorageError);
      expect(onError).toHaveBeenCalledOnce();
    });
  });

  describe('getAdapter', () => {
    it('returns the underlying adapter', () => {
      const manager = new PersistenceManager({ adapter, key: 'test' });

      expect(manager.getAdapter()).toBe(adapter);
    });
  });

  describe('integration scenarios', () => {
    it('handles full lifecycle: save, load, delete', async () => {
      interface AppState {
        users: string[];
        settings: { theme: string };
      }

      const manager = new PersistenceManager<AppState>({
        adapter,
        key: 'app-state',
        schemaVersion: 1,
      });

      // Initial state does not exist
      expect(await manager.exists()).toBe(false);

      // Save state
      const state: AppState = {
        users: ['Alice', 'Bob'],
        settings: { theme: 'dark' },
      };
      await manager.save(state, {
        serverId: 'app-1',
        serverName: 'main-app',
      });

      // State now exists
      expect(await manager.exists()).toBe(true);

      // Load and verify
      const result = await manager.load();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.state.users).toEqual(['Alice', 'Bob']);
        expect(result.state.settings.theme).toBe('dark');
        expect(result.metadata.serverName).toBe('main-app');
      }

      // Delete
      const deleted = await manager.delete();
      expect(deleted).toBe(true);
      expect(await manager.exists()).toBe(false);
    });

    it('handles multi-version migration chain', async () => {
      interface StateV1 {
        count: number;
      }
      interface StateV2 {
        count: number;
        label: string;
      }
      interface StateV3 {
        count: number;
        label: string;
        tags: string[];
      }

      const manager = new PersistenceManager<StateV3>({
        adapter,
        key: 'test',
        schemaVersion: 3,
        migrate: (oldState, oldVersion) => {
          let state = oldState as StateV1 | StateV2 | StateV3;

          if (oldVersion < 2) {
            state = { ...(state as StateV1), label: 'default' };
          }
          if (oldVersion < 3) {
            state = { ...(state as StateV2), tags: [] };
          }

          return state as StateV3;
        },
      });

      // Insert v1 state
      await adapter.save('test', {
        state: { count: 10 },
        metadata: {
          persistedAt: Date.now(),
          serverId: 'server-1',
          schemaVersion: 1,
        },
      });

      const result = await manager.load();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.state.count).toBe(10);
        expect(result.state.label).toBe('default');
        expect(result.state.tags).toEqual([]);
      }
    });

    it('properly isolates managers with different keys', async () => {
      const manager1 = new PersistenceManager({
        adapter,
        key: 'key-1',
      });
      const manager2 = new PersistenceManager({
        adapter,
        key: 'key-2',
      });

      await manager1.save({ value: 'first' }, { serverId: 's1' });
      await manager2.save({ value: 'second' }, { serverId: 's2' });

      const result1 = await manager1.load<{ value: string }>();
      const result2 = await manager2.load<{ value: string }>();

      expect(result1.success && result1.state.value).toBe('first');
      expect(result2.success && result2.state.value).toBe('second');
    });
  });

  describe('close', () => {
    it('calls adapter close when available', async () => {
      const closeFn = vi.fn().mockResolvedValue(undefined);
      const adapterWithClose: StorageAdapter = {
        ...adapter,
        close: closeFn,
      };

      const manager = new PersistenceManager({
        adapter: adapterWithClose,
        key: 'test',
      });

      await manager.close();

      expect(closeFn).toHaveBeenCalledOnce();
    });

    it('is no-op when adapter has no close method', async () => {
      const manager = new PersistenceManager({ adapter, key: 'test' });

      // Should not throw
      await expect(manager.close()).resolves.toBeUndefined();
    });

    it('wraps adapter errors in StorageError', async () => {
      const adapterWithClose: StorageAdapter = {
        ...adapter,
        close: vi.fn().mockRejectedValue(new Error('Connection lost')),
      };

      const manager = new PersistenceManager({
        adapter: adapterWithClose,
        key: 'test',
      });

      await expect(manager.close()).rejects.toThrow(StorageError);
      await expect(manager.close()).rejects.toThrow('Connection lost');
    });

    it('calls onError callback on failure', async () => {
      const onError = vi.fn();
      const adapterWithClose: StorageAdapter = {
        ...adapter,
        close: vi.fn().mockRejectedValue(new Error('Close failed')),
      };

      const manager = new PersistenceManager({
        adapter: adapterWithClose,
        key: 'test',
        onError,
      });

      await expect(manager.close()).rejects.toThrow(StorageError);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0]).toBeInstanceOf(StorageError);
    });

    it('preserves StorageError from adapter', async () => {
      const storageError = new StorageError('close', 'Custom storage error');
      const adapterWithClose: StorageAdapter = {
        ...adapter,
        close: vi.fn().mockRejectedValue(storageError),
      };

      const manager = new PersistenceManager({
        adapter: adapterWithClose,
        key: 'test',
      });

      await expect(manager.close()).rejects.toBe(storageError);
    });
  });

  describe('cleanup', () => {
    it('calls adapter cleanup with explicit maxAgeMs', async () => {
      const cleanupFn = vi.fn().mockResolvedValue(5);
      const adapterWithCleanup: StorageAdapter = {
        ...adapter,
        cleanup: cleanupFn,
      };

      const manager = new PersistenceManager({
        adapter: adapterWithCleanup,
        key: 'test',
      });

      const result = await manager.cleanup(60000);

      expect(cleanupFn).toHaveBeenCalledWith(60000);
      expect(result).toBe(5);
    });

    it('uses config maxStateAgeMs when no explicit value provided', async () => {
      const cleanupFn = vi.fn().mockResolvedValue(3);
      const adapterWithCleanup: StorageAdapter = {
        ...adapter,
        cleanup: cleanupFn,
      };

      const manager = new PersistenceManager({
        adapter: adapterWithCleanup,
        key: 'test',
        maxStateAgeMs: 30000,
      });

      const result = await manager.cleanup();

      expect(cleanupFn).toHaveBeenCalledWith(30000);
      expect(result).toBe(3);
    });

    it('returns 0 when adapter has no cleanup method', async () => {
      const manager = new PersistenceManager({
        adapter,
        key: 'test',
        maxStateAgeMs: 60000,
      });

      const result = await manager.cleanup();

      expect(result).toBe(0);
    });

    it('returns 0 when no maxAgeMs available', async () => {
      const cleanupFn = vi.fn();
      const adapterWithCleanup: StorageAdapter = {
        ...adapter,
        cleanup: cleanupFn,
      };

      const manager = new PersistenceManager({
        adapter: adapterWithCleanup,
        key: 'test',
        // No maxStateAgeMs configured
      });

      const result = await manager.cleanup();

      expect(result).toBe(0);
      expect(cleanupFn).not.toHaveBeenCalled();
    });

    it('prefers explicit maxAgeMs over config', async () => {
      const cleanupFn = vi.fn().mockResolvedValue(2);
      const adapterWithCleanup: StorageAdapter = {
        ...adapter,
        cleanup: cleanupFn,
      };

      const manager = new PersistenceManager({
        adapter: adapterWithCleanup,
        key: 'test',
        maxStateAgeMs: 30000,
      });

      await manager.cleanup(90000);

      expect(cleanupFn).toHaveBeenCalledWith(90000);
    });

    it('wraps adapter errors in StorageError', async () => {
      const adapterWithCleanup: StorageAdapter = {
        ...adapter,
        cleanup: vi.fn().mockRejectedValue(new Error('Cleanup failed')),
      };

      const manager = new PersistenceManager({
        adapter: adapterWithCleanup,
        key: 'test',
        maxStateAgeMs: 60000,
      });

      await expect(manager.cleanup()).rejects.toThrow(StorageError);
      await expect(manager.cleanup()).rejects.toThrow('Cleanup failed');
    });

    it('calls onError callback on failure', async () => {
      const onError = vi.fn();
      const adapterWithCleanup: StorageAdapter = {
        ...adapter,
        cleanup: vi.fn().mockRejectedValue(new Error('Cleanup error')),
      };

      const manager = new PersistenceManager({
        adapter: adapterWithCleanup,
        key: 'test',
        maxStateAgeMs: 60000,
        onError,
      });

      await expect(manager.cleanup()).rejects.toThrow(StorageError);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0]).toBeInstanceOf(StorageError);
    });

    it('preserves StorageError from adapter', async () => {
      const storageError = new StorageError('cleanup', 'Custom cleanup error');
      const adapterWithCleanup: StorageAdapter = {
        ...adapter,
        cleanup: vi.fn().mockRejectedValue(storageError),
      };

      const manager = new PersistenceManager({
        adapter: adapterWithCleanup,
        key: 'test',
        maxStateAgeMs: 60000,
      });

      await expect(manager.cleanup()).rejects.toBe(storageError);
    });
  });
});
