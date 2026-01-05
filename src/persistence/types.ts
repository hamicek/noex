/**
 * Persistence types for GenServer state persistence.
 *
 * This module provides type definitions for the pluggable persistence system,
 * including storage adapters, serialization, and configuration interfaces.
 */

/**
 * Unique identifier for persisted state entries.
 */
export type PersistenceKey = string;

/**
 * Metadata stored alongside the persisted state.
 */
export interface StateMetadata {
  /** Unix timestamp (ms) when the state was persisted */
  readonly persistedAt: number;
  /** Unique identifier of the GenServer instance */
  readonly serverId: string;
  /** Optional registered name of the GenServer */
  readonly serverName?: string;
  /** Schema version for migration support */
  readonly schemaVersion: number;
  /** Optional checksum for integrity verification */
  readonly checksum?: string;
}

/**
 * Container for persisted state with its metadata.
 */
export interface PersistedState<T> {
  /** The actual state data */
  readonly state: T;
  /** Metadata about the persistence operation */
  readonly metadata: StateMetadata;
}

/**
 * Discriminated union representing the result of a state load operation.
 */
export type LoadResult<T> =
  | { readonly success: true; readonly data: PersistedState<T> }
  | { readonly success: false; readonly error: Error };

/**
 * Interface for pluggable storage backends.
 *
 * Implementations must handle serialization/deserialization internally
 * or delegate to the provided serializer.
 */
export interface StorageAdapter {
  /**
   * Persists state data under the given key.
   * @param key - Unique identifier for the state
   * @param data - State and metadata to persist
   */
  save(key: PersistenceKey, data: PersistedState<unknown>): Promise<void>;

  /**
   * Loads persisted state by key.
   * @param key - Unique identifier for the state
   * @returns The persisted state or undefined if not found
   */
  load<T>(key: PersistenceKey): Promise<PersistedState<T> | undefined>;

  /**
   * Deletes persisted state by key.
   * @param key - Unique identifier for the state
   * @returns true if state was deleted, false if not found
   */
  delete(key: PersistenceKey): Promise<boolean>;

  /**
   * Checks if state exists for the given key.
   * @param key - Unique identifier for the state
   */
  exists(key: PersistenceKey): Promise<boolean>;

  /**
   * Lists all keys, optionally filtered by prefix.
   * @param prefix - Optional prefix to filter keys
   */
  listKeys(prefix?: string): Promise<readonly PersistenceKey[]>;

  /**
   * Optional cleanup of stale entries.
   * @param maxAgeMs - Maximum age in milliseconds
   * @returns Number of entries cleaned up
   */
  cleanup?(maxAgeMs: number): Promise<number>;

  /**
   * Optional cleanup when adapter is no longer needed.
   */
  close?(): Promise<void>;
}

/**
 * Interface for state serialization/deserialization.
 */
export interface StateSerializer {
  /**
   * Serializes a value to a string representation.
   * @param value - Value to serialize
   */
  serialize(value: unknown): string;

  /**
   * Deserializes a string back to the original value.
   * @param data - Serialized string representation
   */
  deserialize<T>(data: string): T;
}

/**
 * Configuration for GenServer state persistence.
 */
export interface PersistenceConfig<State> {
  /** Storage adapter to use for persistence */
  readonly adapter: StorageAdapter;

  /**
   * Custom persistence key. Defaults to server name or ID.
   */
  readonly key?: PersistenceKey;

  /**
   * Interval in milliseconds for automatic snapshots.
   * Set to undefined or 0 to disable periodic snapshots.
   */
  readonly snapshotIntervalMs?: number;

  /**
   * Whether to persist state on graceful shutdown.
   * @default true
   */
  readonly persistOnShutdown?: boolean;

  /**
   * Whether to restore state on server start.
   * @default true
   */
  readonly restoreOnStart?: boolean;

  /**
   * Maximum age in milliseconds for restored state.
   * State older than this will be discarded.
   */
  readonly maxStateAgeMs?: number;

  /**
   * Whether to delete persisted state on server termination.
   * When true, all persisted data for this server will be removed on shutdown.
   * @default false
   */
  readonly cleanupOnTerminate?: boolean;

  /**
   * Interval in milliseconds for automatic cleanup of stale entries.
   * Requires maxStateAgeMs to be set. When configured, periodically removes
   * entries older than maxStateAgeMs from storage.
   */
  readonly cleanupIntervalMs?: number;

  /**
   * Schema version for migration support.
   * @default 1
   */
  readonly schemaVersion?: number;

  /**
   * Migration function for upgrading state from older schema versions.
   * @param oldState - State from previous version
   * @param oldVersion - Previous schema version number
   * @returns Migrated state compatible with current version
   */
  readonly migrate?: (oldState: unknown, oldVersion: number) => State;

  /**
   * Custom serialization function.
   * Use when state contains types that need special handling.
   * @param state - State to transform before persistence
   */
  readonly serialize?: (state: State) => unknown;

  /**
   * Custom deserialization function.
   * Inverse of serialize.
   * @param data - Raw data from storage
   */
  readonly deserialize?: (data: unknown) => State;

  /**
   * Error handler for persistence failures.
   * Called when save/load operations fail.
   * @param error - The error that occurred
   */
  readonly onError?: (error: Error) => void;
}
