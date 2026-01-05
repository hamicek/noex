/**
 * PersistenceManager - high-level facade for state persistence operations.
 *
 * Encapsulates storage adapter, serialization, schema migration, and state
 * validation into a single cohesive interface. This is the primary API for
 * GenServer persistence integration.
 */

import type {
  PersistenceConfig,
  PersistenceKey,
  PersistedState,
  StateMetadata,
  LoadResult,
} from './types.js';
import {
  MigrationError,
  StaleStateError,
  StateNotFoundError,
  StorageError,
} from './errors.js';

/**
 * Options for save operations.
 */
export interface SaveOptions {
  /** Unique identifier of the GenServer instance */
  readonly serverId: string;
  /** Optional registered name of the GenServer */
  readonly serverName?: string | undefined;
  /** Optional checksum for integrity verification */
  readonly checksum?: string | undefined;
}

/**
 * Result of a successful load operation with full type safety.
 */
export interface LoadSuccess<T> {
  readonly success: true;
  readonly state: T;
  readonly metadata: StateMetadata;
}

/**
 * Result of a failed load operation.
 */
export interface LoadFailure {
  readonly success: false;
  readonly error: Error;
}

/**
 * Discriminated union for load operation results.
 */
export type ManagerLoadResult<T> = LoadSuccess<T> | LoadFailure;

/**
 * PersistenceManager provides a high-level interface for state persistence.
 *
 * It handles:
 * - State serialization and deserialization (custom or default)
 * - Schema versioning and migration
 * - State age validation
 * - Metadata generation and management
 * - Error handling with optional callbacks
 *
 * @example
 * ```typescript
 * const manager = new PersistenceManager({
 *   adapter: new FileAdapter({ directory: './data' }),
 *   key: 'my-server',
 *   schemaVersion: 2,
 *   migrate: (oldState, oldVersion) => {
 *     if (oldVersion === 1) {
 *       return { ...oldState, newField: 'default' };
 *     }
 *     return oldState;
 *   },
 * });
 *
 * await manager.save({ count: 42 }, { serverId: 'server-1' });
 * const result = await manager.load<{ count: number }>();
 * if (result.success) {
 *   console.log(result.state.count);
 * }
 * ```
 *
 * @typeParam State - The type of state being persisted
 */
export class PersistenceManager<State = unknown> {
  private readonly config: PersistenceConfig<State>;
  private readonly key: PersistenceKey;
  private readonly schemaVersion: number;

  constructor(config: PersistenceConfig<State>) {
    this.config = config;
    this.key = config.key ?? '';
    this.schemaVersion = config.schemaVersion ?? 1;

    if (!config.adapter) {
      throw new Error('PersistenceManager requires a storage adapter');
    }
  }

  /**
   * Returns the persistence key used for storage operations.
   */
  getKey(): PersistenceKey {
    return this.key;
  }

  /**
   * Updates the persistence key.
   * Returns a new manager instance with the updated key.
   *
   * This is useful when the key is not known at construction time
   * (e.g., when it depends on the server ID or name).
   */
  withKey(key: PersistenceKey): PersistenceManager<State> {
    return new PersistenceManager({
      ...this.config,
      key,
    });
  }

  /**
   * Persists the current state with metadata.
   *
   * Applies custom serialization if configured, generates metadata,
   * and delegates to the storage adapter.
   *
   * @param state - The state to persist
   * @param options - Server identification for metadata
   * @throws {StorageError} If the save operation fails
   */
  async save(state: State, options: SaveOptions): Promise<void> {
    try {
      const serializedState = this.config.serialize
        ? this.config.serialize(state)
        : state;

      const metadata: StateMetadata = {
        persistedAt: Date.now(),
        serverId: options.serverId,
        schemaVersion: this.schemaVersion,
        ...(options.serverName !== undefined && { serverName: options.serverName }),
        ...(options.checksum !== undefined && { checksum: options.checksum }),
      };

      const persistedState: PersistedState<unknown> = {
        state: serializedState,
        metadata,
      };

      await this.config.adapter.save(this.key, persistedState);
    } catch (error) {
      const wrappedError =
        error instanceof StorageError
          ? error
          : new StorageError(
              'save',
              error instanceof Error ? error.message : String(error),
              error instanceof Error ? error : undefined
            );

      this.config.onError?.(wrappedError);
      throw wrappedError;
    }
  }

  /**
   * Loads and restores persisted state.
   *
   * Handles:
   * - State age validation (if maxStateAgeMs is configured)
   * - Schema migration (if state version differs from current)
   * - Custom deserialization (if configured)
   *
   * @returns LoadResult with either the restored state or an error
   */
  async load(): Promise<ManagerLoadResult<State>> {
    try {
      const persisted = await this.config.adapter.load<unknown>(this.key);

      if (persisted === undefined) {
        return {
          success: false,
          error: new StateNotFoundError(this.key),
        };
      }

      // Validate state age if configured
      if (this.config.maxStateAgeMs !== undefined) {
        const age = Date.now() - persisted.metadata.persistedAt;
        if (age > this.config.maxStateAgeMs) {
          const error = new StaleStateError(
            this.key,
            age,
            this.config.maxStateAgeMs
          );
          this.config.onError?.(error);
          return { success: false, error };
        }
      }

      let state = persisted.state;

      // Apply schema migration if needed
      const persistedVersion = persisted.metadata.schemaVersion;
      if (persistedVersion !== this.schemaVersion) {
        if (this.config.migrate) {
          try {
            state = this.config.migrate(state, persistedVersion);
          } catch (error) {
            const migrationError = new MigrationError(
              persistedVersion,
              this.schemaVersion,
              error instanceof Error ? error : undefined
            );
            this.config.onError?.(migrationError);
            return { success: false, error: migrationError };
          }
        }
        // If no migrate function and versions differ, we proceed with the state as-is
        // The caller can handle version differences through the metadata
      }

      // Apply custom deserialization if configured
      const deserializedState = this.config.deserialize
        ? this.config.deserialize(state)
        : (state as State);

      return {
        success: true,
        state: deserializedState,
        metadata: persisted.metadata,
      };
    } catch (error) {
      const wrappedError =
        error instanceof Error
          ? error
          : new StorageError('load', String(error));

      this.config.onError?.(wrappedError);
      return { success: false, error: wrappedError };
    }
  }

  /**
   * Deletes persisted state for this key.
   *
   * @returns true if state was deleted, false if not found
   * @throws {StorageError} If the delete operation fails
   */
  async delete(): Promise<boolean> {
    try {
      return await this.config.adapter.delete(this.key);
    } catch (error) {
      const wrappedError =
        error instanceof StorageError
          ? error
          : new StorageError(
              'delete',
              error instanceof Error ? error.message : String(error),
              error instanceof Error ? error : undefined
            );

      this.config.onError?.(wrappedError);
      throw wrappedError;
    }
  }

  /**
   * Retrieves only the metadata without loading the full state.
   *
   * Useful for checking state age or version without deserializing
   * potentially large state objects.
   *
   * @returns Metadata if state exists, undefined otherwise
   * @throws {StorageError} If the load operation fails
   */
  async getMetadata(): Promise<StateMetadata | undefined> {
    try {
      const persisted = await this.config.adapter.load<unknown>(this.key);
      return persisted?.metadata;
    } catch (error) {
      const wrappedError =
        error instanceof StorageError
          ? error
          : new StorageError(
              'load',
              error instanceof Error ? error.message : String(error),
              error instanceof Error ? error : undefined
            );

      this.config.onError?.(wrappedError);
      throw wrappedError;
    }
  }

  /**
   * Checks if persisted state exists for this key.
   *
   * @returns true if state exists, false otherwise
   */
  async exists(): Promise<boolean> {
    try {
      return await this.config.adapter.exists(this.key);
    } catch (error) {
      const wrappedError =
        error instanceof StorageError
          ? error
          : new StorageError(
              'exists',
              error instanceof Error ? error.message : String(error),
              error instanceof Error ? error : undefined
            );

      this.config.onError?.(wrappedError);
      throw wrappedError;
    }
  }

  /**
   * Returns the underlying storage adapter.
   *
   * Useful for advanced operations like cleanup or direct adapter access.
   */
  getAdapter(): PersistenceConfig<State>['adapter'] {
    return this.config.adapter;
  }

  /**
   * Returns the current schema version.
   */
  getSchemaVersion(): number {
    return this.schemaVersion;
  }

  /**
   * Closes the underlying storage adapter.
   *
   * Should be called when the manager is no longer needed to release
   * any resources held by the adapter (database connections, file handles, etc.).
   *
   * This is a no-op if the adapter does not implement the optional close() method.
   */
  async close(): Promise<void> {
    if (this.config.adapter.close) {
      try {
        await this.config.adapter.close();
      } catch (error) {
        const wrappedError =
          error instanceof StorageError
            ? error
            : new StorageError(
                'close',
                error instanceof Error ? error.message : String(error),
                error instanceof Error ? error : undefined
              );

        this.config.onError?.(wrappedError);
        throw wrappedError;
      }
    }
  }

  /**
   * Removes stale entries from storage that exceed the specified age.
   *
   * Uses the adapter's cleanup() method if available. Falls back to the
   * configured maxStateAgeMs if no explicit age is provided.
   *
   * @param maxAgeMs - Maximum age in milliseconds. Entries older than this will be removed.
   *                   Defaults to config.maxStateAgeMs if not specified.
   * @returns Number of entries removed, or 0 if cleanup is not supported or no age configured.
   */
  async cleanup(maxAgeMs?: number): Promise<number> {
    const effectiveMaxAge = maxAgeMs ?? this.config.maxStateAgeMs;

    if (!this.config.adapter.cleanup || effectiveMaxAge === undefined) {
      return 0;
    }

    try {
      return await this.config.adapter.cleanup(effectiveMaxAge);
    } catch (error) {
      const wrappedError =
        error instanceof StorageError
          ? error
          : new StorageError(
              'cleanup',
              error instanceof Error ? error.message : String(error),
              error instanceof Error ? error : undefined
            );

      this.config.onError?.(wrappedError);
      throw wrappedError;
    }
  }
}
