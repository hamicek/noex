/**
 * In-memory storage adapter for testing and development.
 *
 * This adapter stores state in memory and does not persist across process restarts.
 * Useful for unit testing, development, and scenarios where persistence is not needed.
 */

import type { PersistenceKey, PersistedState, StorageAdapter } from '../types.js';
import { StorageError } from '../errors.js';

/**
 * Configuration options for MemoryAdapter.
 */
export interface MemoryAdapterOptions {
  /**
   * Initial data to populate the adapter with.
   * Useful for testing with pre-populated state.
   */
  readonly initialData?: ReadonlyMap<PersistenceKey, PersistedState<unknown>>;
}

/**
 * In-memory implementation of StorageAdapter.
 *
 * Provides a simple, fast storage backend that keeps all data in memory.
 * Data is lost when the process exits or when the adapter is garbage collected.
 *
 * @example
 * ```typescript
 * const adapter = new MemoryAdapter();
 *
 * await adapter.save('my-key', {
 *   state: { count: 42 },
 *   metadata: { persistedAt: Date.now(), serverId: 'server-1', schemaVersion: 1 }
 * });
 *
 * const data = await adapter.load('my-key');
 * console.log(data?.state); // { count: 42 }
 * ```
 */
export class MemoryAdapter implements StorageAdapter {
  private readonly storage: Map<PersistenceKey, PersistedState<unknown>>;

  constructor(options: MemoryAdapterOptions = {}) {
    this.storage = options.initialData
      ? new Map(options.initialData)
      : new Map();
  }

  async save(key: PersistenceKey, data: PersistedState<unknown>): Promise<void> {
    try {
      // Deep clone to prevent external mutations from affecting stored data
      const cloned = structuredClone(data);
      this.storage.set(key, cloned);
    } catch (error) {
      throw new StorageError(
        'save',
        `Failed to save state for key: ${key}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async load<T>(key: PersistenceKey): Promise<PersistedState<T> | undefined> {
    try {
      const data = this.storage.get(key);
      if (data === undefined) {
        return undefined;
      }
      // Deep clone to prevent external mutations from affecting stored data
      return structuredClone(data) as PersistedState<T>;
    } catch (error) {
      throw new StorageError(
        'load',
        `Failed to load state for key: ${key}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async delete(key: PersistenceKey): Promise<boolean> {
    return this.storage.delete(key);
  }

  async exists(key: PersistenceKey): Promise<boolean> {
    return this.storage.has(key);
  }

  async listKeys(prefix?: string): Promise<readonly PersistenceKey[]> {
    const keys = Array.from(this.storage.keys());
    if (prefix === undefined) {
      return keys;
    }
    return keys.filter((key) => key.startsWith(prefix));
  }

  async cleanup(maxAgeMs: number): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, data] of this.storage) {
      const age = now - data.metadata.persistedAt;
      if (age > maxAgeMs) {
        this.storage.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  async close(): Promise<void> {
    // No-op for in-memory storage - nothing to close
    // Data persists until adapter is garbage collected or explicitly cleared
  }

  /**
   * Returns the current number of stored entries.
   * Useful for testing and debugging.
   */
  get size(): number {
    return this.storage.size;
  }

  /**
   * Clears all stored data.
   * Useful for resetting state between tests.
   */
  clear(): void {
    this.storage.clear();
  }
}
