/**
 * Integration tests for GenServer persistence.
 *
 * Tests the complete persistence lifecycle including:
 * - State restoration on start
 * - Periodic snapshots
 * - Persist on shutdown
 * - Manual checkpoints
 * - Schema migration
 * - Error handling
 * - Lifecycle events
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GenServer,
  Registry,
  MemoryAdapter,
  type GenServerBehavior,
  type GenServerRef,
  type LifecycleEvent,
  type StateMetadata,
  type PersistenceConfig,
  ServerNotRunningError,
} from '../../src/index.js';

interface CounterState {
  count: number;
  lastUpdated?: number;
}

type CounterCallMsg = 'get' | { type: 'set'; value: number };
type CounterCastMsg = 'inc' | 'dec' | 'reset';
type CounterCallReply = CounterState | number;

function createCounterBehavior(
  options: {
    onStateRestore?: (state: CounterState, metadata: StateMetadata) => CounterState;
    beforePersist?: (state: CounterState) => CounterState | undefined;
  } = {}
): GenServerBehavior<CounterState, CounterCallMsg, CounterCastMsg, CounterCallReply> {
  return {
    init: () => ({ count: 0 }),
    handleCall: (msg, state) => {
      if (msg === 'get') {
        return [state, state];
      }
      if (typeof msg === 'object' && msg.type === 'set') {
        const newState = { count: msg.value, lastUpdated: Date.now() };
        return [newState, newState];
      }
      throw new Error(`Unknown call message: ${JSON.stringify(msg)}`);
    },
    handleCast: (msg, state) => {
      switch (msg) {
        case 'inc':
          return { ...state, count: state.count + 1, lastUpdated: Date.now() };
        case 'dec':
          return { ...state, count: state.count - 1, lastUpdated: Date.now() };
        case 'reset':
          return { count: 0, lastUpdated: Date.now() };
        default:
          return state;
      }
    },
    onStateRestore: options.onStateRestore,
    beforePersist: options.beforePersist,
  };
}

describe('GenServer Persistence Integration', () => {
  let adapter: MemoryAdapter;
  let events: LifecycleEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    adapter = new MemoryAdapter();
    events = [];
    Registry._clearLifecycleHandler();
    Registry._clear();
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
    unsubscribe = GenServer.onLifecycleEvent((event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    unsubscribe();
    Registry._clearLifecycleHandler();
    Registry._clear();
    GenServer._clearLifecycleHandlers();
  });

  describe('State Restoration on Start', () => {
    it('restores state from persistence when restoreOnStart is true', async () => {
      // Pre-populate adapter with saved state
      await adapter.save('counter', {
        state: { count: 42 },
        metadata: {
          persistedAt: Date.now(),
          serverId: 'old-server',
          schemaVersion: 1,
        },
      });

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter,
          restoreOnStart: true,
        },
      });

      const state = await GenServer.call(ref, 'get');
      expect(state).toEqual({ count: 42 });

      // Check lifecycle event
      const restoredEvent = events.find((e) => e.type === 'state_restored');
      expect(restoredEvent).toBeDefined();
      expect(restoredEvent?.type).toBe('state_restored');
      if (restoredEvent?.type === 'state_restored') {
        expect(restoredEvent.metadata.schemaVersion).toBe(1);
      }

      await GenServer.stop(ref);
    });

    it('uses init state when no persisted state exists', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'new-counter',
        persistence: {
          adapter,
          restoreOnStart: true,
        },
      });

      const state = await GenServer.call(ref, 'get');
      expect(state).toEqual({ count: 0 });

      // Should not emit state_restored event
      const restoredEvent = events.find((e) => e.type === 'state_restored');
      expect(restoredEvent).toBeUndefined();

      await GenServer.stop(ref);
    });

    it('uses init state when restoreOnStart is false', async () => {
      // Pre-populate adapter
      await adapter.save('counter', {
        state: { count: 100 },
        metadata: {
          persistedAt: Date.now(),
          serverId: 'old-server',
          schemaVersion: 1,
        },
      });

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter,
          restoreOnStart: false,
        },
      });

      const state = await GenServer.call(ref, 'get');
      expect(state).toEqual({ count: 0 });

      await GenServer.stop(ref);
    });

    it('applies onStateRestore hook when restoring', async () => {
      await adapter.save('counter', {
        state: { count: 10 },
        metadata: {
          persistedAt: Date.now(),
          serverId: 'old-server',
          schemaVersion: 1,
        },
      });

      const behavior = createCounterBehavior({
        onStateRestore: (state, metadata) => {
          // Double the count on restore
          return { ...state, count: state.count * 2 };
        },
      });

      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter,
          restoreOnStart: true,
        },
      });

      const state = await GenServer.call(ref, 'get');
      expect(state).toEqual({ count: 20 });

      await GenServer.stop(ref);
    });

    it('uses custom persistence key over server name', async () => {
      await adapter.save('custom-key', {
        state: { count: 99 },
        metadata: {
          persistedAt: Date.now(),
          serverId: 'old-server',
          schemaVersion: 1,
        },
      });

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter,
          key: 'custom-key',
          restoreOnStart: true,
        },
      });

      const state = await GenServer.call(ref, 'get');
      expect(state).toEqual({ count: 99 });

      await GenServer.stop(ref);
    });
  });

  describe('Persist on Shutdown', () => {
    it('persists state on graceful shutdown by default', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: { adapter },
      });

      // Modify state
      GenServer.cast(ref, 'inc');
      GenServer.cast(ref, 'inc');
      GenServer.cast(ref, 'inc');

      // Wait for casts to be processed
      await new Promise((r) => setTimeout(r, 50));

      await GenServer.stop(ref);

      // Verify state was persisted
      const persisted = await adapter.load('counter');
      expect(persisted).toBeDefined();
      expect(persisted?.state).toEqual({ count: 3, lastUpdated: expect.any(Number) });
    });

    it('does not persist on shutdown when persistOnShutdown is false', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter,
          persistOnShutdown: false,
        },
      });

      GenServer.cast(ref, 'inc');
      await new Promise((r) => setTimeout(r, 50));

      await GenServer.stop(ref);

      // Should not have persisted
      const persisted = await adapter.load('counter');
      expect(persisted).toBeUndefined();
    });

    it('applies beforePersist hook on shutdown', async () => {
      const behavior = createCounterBehavior({
        beforePersist: (state) => {
          // Clear lastUpdated before persisting
          return { count: state.count };
        },
      });

      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: { adapter },
      });

      GenServer.cast(ref, 'inc');
      await new Promise((r) => setTimeout(r, 50));

      await GenServer.stop(ref);

      const persisted = await adapter.load('counter');
      expect(persisted?.state).toEqual({ count: 1 });
      expect((persisted?.state as CounterState).lastUpdated).toBeUndefined();
    });
  });

  describe('Manual Checkpoint', () => {
    it('creates checkpoint via GenServer.checkpoint()', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter,
          persistOnShutdown: false, // Disable to verify checkpoint works
        },
      });

      GenServer.cast(ref, 'inc');
      GenServer.cast(ref, 'inc');
      await new Promise((r) => setTimeout(r, 50));

      await GenServer.checkpoint(ref);

      const persisted = await adapter.load('counter');
      expect(persisted?.state).toEqual({ count: 2, lastUpdated: expect.any(Number) });

      // Check lifecycle event
      const persistedEvent = events.find((e) => e.type === 'state_persisted');
      expect(persistedEvent).toBeDefined();

      await GenServer.stop(ref);
    });

    it('throws when checkpointing server without persistence', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);

      await expect(GenServer.checkpoint(ref)).rejects.toThrow(
        'Persistence not configured'
      );

      await GenServer.stop(ref);
    });

    it('throws ServerNotRunningError for stopped server', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        persistence: { adapter },
      });

      await GenServer.stop(ref);

      await expect(GenServer.checkpoint(ref)).rejects.toThrow(ServerNotRunningError);
    });
  });

  describe('getLastCheckpointMeta', () => {
    it('returns metadata of last checkpoint', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: { adapter },
      });

      GenServer.cast(ref, 'inc');
      await new Promise((r) => setTimeout(r, 50));

      await GenServer.checkpoint(ref);

      const meta = await GenServer.getLastCheckpointMeta(ref);
      expect(meta).toBeDefined();
      expect(meta?.serverId).toMatch(/^genserver_/);
      expect(meta?.serverName).toBe('counter');
      expect(meta?.schemaVersion).toBe(1);
      expect(meta?.persistedAt).toBeLessThanOrEqual(Date.now());

      await GenServer.stop(ref);
    });

    it('returns undefined when no checkpoint exists', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'new-counter',
        persistence: { adapter },
      });

      const meta = await GenServer.getLastCheckpointMeta(ref);
      expect(meta).toBeUndefined();

      await GenServer.stop(ref);
    });

    it('throws when server has no persistence', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior);

      await expect(GenServer.getLastCheckpointMeta(ref)).rejects.toThrow(
        'Persistence not configured'
      );

      await GenServer.stop(ref);
    });
  });

  describe('clearPersistedState', () => {
    it('deletes persisted state', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: { adapter },
      });

      await GenServer.checkpoint(ref);
      expect(await adapter.exists('counter')).toBe(true);

      const deleted = await GenServer.clearPersistedState(ref);
      expect(deleted).toBe(true);
      expect(await adapter.exists('counter')).toBe(false);

      await GenServer.stop(ref);
    });

    it('returns false when no state to clear', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'new-counter',
        persistence: { adapter },
      });

      const deleted = await GenServer.clearPersistedState(ref);
      expect(deleted).toBe(false);

      await GenServer.stop(ref);
    });
  });

  describe('Periodic Snapshots', () => {
    it('creates periodic snapshots at configured interval', async () => {
      vi.useFakeTimers();

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter,
          snapshotIntervalMs: 100,
          persistOnShutdown: false,
        },
      });

      // Modify state
      GenServer.cast(ref, 'inc');

      // Process cast
      await vi.advanceTimersByTimeAsync(10);

      // Advance to first snapshot
      await vi.advanceTimersByTimeAsync(100);

      let persisted = await adapter.load('counter');
      expect(persisted?.state).toEqual({ count: 1, lastUpdated: expect.any(Number) });

      // Modify again
      GenServer.cast(ref, 'inc');
      await vi.advanceTimersByTimeAsync(10);

      // Advance to second snapshot
      await vi.advanceTimersByTimeAsync(100);

      persisted = await adapter.load('counter');
      expect(persisted?.state).toEqual({ count: 2, lastUpdated: expect.any(Number) });

      await GenServer.stop(ref);
      vi.useRealTimers();
    });

    it('does not start timer when snapshotIntervalMs is 0', async () => {
      vi.useFakeTimers();

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter,
          snapshotIntervalMs: 0,
          persistOnShutdown: false,
        },
      });

      GenServer.cast(ref, 'inc');
      await vi.advanceTimersByTimeAsync(1000);

      const persisted = await adapter.load('counter');
      expect(persisted).toBeUndefined();

      await GenServer.stop(ref);
      vi.useRealTimers();
    });
  });

  describe('Schema Migration', () => {
    it('migrates state from older schema version', async () => {
      // Save with old schema
      await adapter.save('counter', {
        state: { value: 50 }, // Old schema used 'value' instead of 'count'
        metadata: {
          persistedAt: Date.now(),
          serverId: 'old-server',
          schemaVersion: 1,
        },
      });

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter,
          schemaVersion: 2,
          migrate: (oldState: unknown, oldVersion: number) => {
            if (oldVersion === 1) {
              const old = oldState as { value: number };
              return { count: old.value };
            }
            return oldState as CounterState;
          },
          restoreOnStart: true,
        },
      });

      const state = await GenServer.call(ref, 'get');
      expect(state).toEqual({ count: 50 });

      await GenServer.stop(ref);
    });
  });

  describe('Error Handling', () => {
    it('emits persistence_error event on restore failure', async () => {
      const failingAdapter = {
        ...adapter,
        load: async () => {
          throw new Error('Storage unavailable');
        },
      };

      const onError = vi.fn();
      const behavior = createCounterBehavior();

      // Should not throw - continues with init state
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter: failingAdapter,
          restoreOnStart: true,
          onError,
        },
      });

      // Check onError was called
      expect(onError).toHaveBeenCalled();

      // Check lifecycle event
      const errorEvent = events.find((e) => e.type === 'persistence_error');
      expect(errorEvent).toBeDefined();

      // Server should still work with init state
      const state = await GenServer.call(ref, 'get');
      expect(state).toEqual({ count: 0 });

      await GenServer.stop(ref);
    });

    it('emits persistence_error on checkpoint failure', async () => {
      const failingAdapter = {
        ...adapter,
        save: async () => {
          throw new Error('Write failed');
        },
        // Need getMetadata to work for the test setup
        load: adapter.load.bind(adapter),
        exists: adapter.exists.bind(adapter),
        delete: adapter.delete.bind(adapter),
        listKeys: adapter.listKeys.bind(adapter),
      };

      const onError = vi.fn();
      const behavior = createCounterBehavior();

      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter: failingAdapter,
          persistOnShutdown: false,
          onError,
        },
      });

      await expect(GenServer.checkpoint(ref)).rejects.toThrow('Write failed');
      expect(onError).toHaveBeenCalled();

      const errorEvent = events.find((e) => e.type === 'persistence_error');
      expect(errorEvent).toBeDefined();

      await GenServer.stop(ref);
    });

    it('skips persistence when beforePersist returns undefined', async () => {
      const behavior = createCounterBehavior({
        beforePersist: () => undefined, // Always skip
      });

      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter,
          persistOnShutdown: false, // Disable auto-persist
        },
      });

      GenServer.cast(ref, 'inc');
      await new Promise((r) => setTimeout(r, 50));

      // Manual checkpoint should fail/skip
      await expect(GenServer.checkpoint(ref)).rejects.toThrow(
        'beforePersist returned undefined'
      );

      const persisted = await adapter.load('counter');
      expect(persisted).toBeUndefined();

      await GenServer.stop(ref);
    });
  });

  describe('Lifecycle Events', () => {
    it('emits started event after state restoration', async () => {
      await adapter.save('counter', {
        state: { count: 5 },
        metadata: {
          persistedAt: Date.now(),
          serverId: 'old',
          schemaVersion: 1,
        },
      });

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: { adapter, restoreOnStart: true },
      });

      const eventTypes = events.map((e) => e.type);

      // state_restored should come before started
      const restoredIdx = eventTypes.indexOf('state_restored');
      const startedIdx = eventTypes.indexOf('started');

      expect(restoredIdx).toBeLessThan(startedIdx);

      await GenServer.stop(ref);
    });
  });

  describe('Server ID as Fallback Key', () => {
    it('uses server ID when no name or key provided', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        persistence: { adapter },
      });

      GenServer.cast(ref, 'inc');
      await new Promise((r) => setTimeout(r, 50));

      await GenServer.checkpoint(ref);

      // Key should be the server ID
      const keys = await adapter.listKeys();
      expect(keys.length).toBe(1);
      expect(keys[0]).toBe(ref.id);

      await GenServer.stop(ref);
    });
  });

  describe('Cleanup on Terminate', () => {
    it('deletes persisted data when cleanupOnTerminate is true', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter,
          cleanupOnTerminate: true,
        },
      });

      GenServer.cast(ref, 'inc');
      await new Promise((r) => setTimeout(r, 50));

      // Create a checkpoint to ensure data exists
      await GenServer.checkpoint(ref);
      expect(await adapter.exists('counter')).toBe(true);

      // Stop should delete the data
      await GenServer.stop(ref);

      expect(await adapter.exists('counter')).toBe(false);
    });

    it('retains persisted data when cleanupOnTerminate is false (default)', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter,
          cleanupOnTerminate: false,
        },
      });

      GenServer.cast(ref, 'inc');
      await new Promise((r) => setTimeout(r, 50));

      await GenServer.stop(ref);

      // Data should still exist
      expect(await adapter.exists('counter')).toBe(true);
      const persisted = await adapter.load('counter');
      expect(persisted?.state).toEqual({ count: 1, lastUpdated: expect.any(Number) });
    });

    it('retains persisted data when cleanupOnTerminate is not specified', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: { adapter },
      });

      GenServer.cast(ref, 'inc');
      await new Promise((r) => setTimeout(r, 50));

      await GenServer.stop(ref);

      // Data should still exist (default behavior)
      expect(await adapter.exists('counter')).toBe(true);
    });

    it('cleans up data on force terminate when cleanupOnTerminate is true', async () => {
      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter,
          cleanupOnTerminate: true,
        },
      });

      GenServer.cast(ref, 'inc');
      await new Promise((r) => setTimeout(r, 50));

      await GenServer.checkpoint(ref);
      expect(await adapter.exists('counter')).toBe(true);

      // Force terminate
      GenServer._forceTerminate(ref, 'shutdown');

      // Wait for async cleanup to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(await adapter.exists('counter')).toBe(false);
    });
  });

  describe('Adapter Close', () => {
    it('calls adapter.close() on graceful shutdown', async () => {
      const closeSpy = vi.fn().mockResolvedValue(undefined);
      const adapterWithClose = {
        ...adapter,
        close: closeSpy,
      };

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter: adapterWithClose,
          persistOnShutdown: false,
        },
      });

      await GenServer.stop(ref);

      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('calls adapter.close() on force terminate', async () => {
      const closeSpy = vi.fn().mockResolvedValue(undefined);
      const adapterWithClose = {
        ...adapter,
        close: closeSpy,
      };

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter: adapterWithClose,
          persistOnShutdown: false,
        },
      });

      GenServer._forceTerminate(ref, 'shutdown');

      // Wait for async close to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('handles adapters without close() method gracefully', async () => {
      const adapterWithoutClose: typeof adapter = {
        save: adapter.save.bind(adapter),
        load: adapter.load.bind(adapter),
        delete: adapter.delete.bind(adapter),
        exists: adapter.exists.bind(adapter),
        listKeys: adapter.listKeys.bind(adapter),
        // No close method
      };

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter: adapterWithoutClose,
        },
      });

      GenServer.cast(ref, 'inc');
      await new Promise((r) => setTimeout(r, 50));

      // Should not throw
      await expect(GenServer.stop(ref)).resolves.toBeUndefined();
    });

    it('ignores close errors during shutdown', async () => {
      const closeSpy = vi.fn().mockRejectedValue(new Error('Close failed'));
      const adapterWithClose = {
        ...adapter,
        close: closeSpy,
      };

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter: adapterWithClose,
          persistOnShutdown: false,
        },
      });

      // Should not throw despite close error
      await expect(GenServer.stop(ref)).resolves.toBeUndefined();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Periodic Cleanup', () => {
    it('performs periodic cleanup at configured interval', async () => {
      vi.useFakeTimers();

      const cleanupSpy = vi.fn().mockResolvedValue(0);
      const adapterWithCleanup = {
        ...adapter,
        cleanup: cleanupSpy,
      };

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter: adapterWithCleanup,
          cleanupIntervalMs: 100,
          maxStateAgeMs: 5000,
          persistOnShutdown: false,
        },
      });

      // No cleanup yet
      expect(cleanupSpy).not.toHaveBeenCalled();

      // Advance to first cleanup
      await vi.advanceTimersByTimeAsync(100);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledWith(5000);

      // Advance to second cleanup
      await vi.advanceTimersByTimeAsync(100);
      expect(cleanupSpy).toHaveBeenCalledTimes(2);

      await GenServer.stop(ref);
      vi.useRealTimers();
    });

    it('does not start cleanup timer when cleanupIntervalMs is not set', async () => {
      vi.useFakeTimers();

      const cleanupSpy = vi.fn().mockResolvedValue(0);
      const adapterWithCleanup = {
        ...adapter,
        cleanup: cleanupSpy,
      };

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter: adapterWithCleanup,
          maxStateAgeMs: 5000, // maxStateAgeMs set but no cleanupIntervalMs
          persistOnShutdown: false,
        },
      });

      await vi.advanceTimersByTimeAsync(10000);

      expect(cleanupSpy).not.toHaveBeenCalled();

      await GenServer.stop(ref);
      vi.useRealTimers();
    });

    it('does not start cleanup timer when maxStateAgeMs is not set', async () => {
      vi.useFakeTimers();

      const cleanupSpy = vi.fn().mockResolvedValue(0);
      const adapterWithCleanup = {
        ...adapter,
        cleanup: cleanupSpy,
      };

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter: adapterWithCleanup,
          cleanupIntervalMs: 100, // cleanupIntervalMs set but no maxStateAgeMs
          persistOnShutdown: false,
        },
      });

      await vi.advanceTimersByTimeAsync(10000);

      expect(cleanupSpy).not.toHaveBeenCalled();

      await GenServer.stop(ref);
      vi.useRealTimers();
    });

    it('stops cleanup timer on graceful shutdown', async () => {
      vi.useFakeTimers();

      const cleanupSpy = vi.fn().mockResolvedValue(0);
      const adapterWithCleanup = {
        ...adapter,
        cleanup: cleanupSpy,
      };

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter: adapterWithCleanup,
          cleanupIntervalMs: 100,
          maxStateAgeMs: 5000,
          persistOnShutdown: false,
        },
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);

      await GenServer.stop(ref);

      // Advance time - no more cleanups should occur
      await vi.advanceTimersByTimeAsync(500);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('stops cleanup timer on force terminate', async () => {
      vi.useFakeTimers();

      const cleanupSpy = vi.fn().mockResolvedValue(0);
      const adapterWithCleanup = {
        ...adapter,
        cleanup: cleanupSpy,
      };

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter: adapterWithCleanup,
          cleanupIntervalMs: 100,
          maxStateAgeMs: 5000,
          persistOnShutdown: false,
        },
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);

      GenServer._forceTerminate(ref, 'shutdown');

      // Advance time - no more cleanups should occur
      await vi.advanceTimersByTimeAsync(500);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('handles adapters without cleanup() method gracefully', async () => {
      vi.useFakeTimers();

      const adapterWithoutCleanup: typeof adapter = {
        save: adapter.save.bind(adapter),
        load: adapter.load.bind(adapter),
        delete: adapter.delete.bind(adapter),
        exists: adapter.exists.bind(adapter),
        listKeys: adapter.listKeys.bind(adapter),
        // No cleanup method
      };

      const behavior = createCounterBehavior();
      const ref = await GenServer.start(behavior, {
        name: 'counter',
        persistence: {
          adapter: adapterWithoutCleanup,
          cleanupIntervalMs: 100,
          maxStateAgeMs: 5000,
        },
      });

      // Advancing time should not throw
      await vi.advanceTimersByTimeAsync(500);

      await GenServer.stop(ref);
      vi.useRealTimers();
    });
  });
});
