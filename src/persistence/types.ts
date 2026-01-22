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

// --- Event Log Types ---

/**
 * A single entry in an append-only event log stream.
 *
 * Events are immutable once appended. The `seq` field provides
 * total ordering within a stream.
 */
export interface EventEntry<T = unknown> {
  /** Monotonically increasing sequence number within the stream */
  readonly seq: number;
  /** Unix timestamp (ms) when the event was created */
  readonly timestamp: number;
  /** Event type identifier for filtering and routing */
  readonly type: string;
  /** Event payload data */
  readonly payload: T;
  /** Optional metadata for tracing, correlation, etc. */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Options for reading events from a stream.
 */
export interface ReadOptions {
  /** Start reading from this sequence number (inclusive) */
  readonly fromSeq?: number;
  /** Stop reading at this sequence number (inclusive) */
  readonly toSeq?: number;
  /** Maximum number of events to return */
  readonly limit?: number;
  /** Filter events by type(s) */
  readonly types?: readonly string[];
}

/**
 * Interface for append-only event log storage backends.
 *
 * Event logs provide ordered, immutable event streams identified by streamId.
 * Each stream maintains its own monotonically increasing sequence counter.
 */
export interface EventLogAdapter {
  /**
   * Appends events to a stream. Sequence numbers are assigned by the adapter.
   * @param streamId - Unique identifier for the event stream
   * @param events - Events to append (seq fields are ignored; adapter assigns them)
   * @returns The sequence number of the last appended event
   */
  append(streamId: string, events: readonly EventEntry[]): Promise<number>;

  /**
   * Reads events from a stream with optional filtering.
   * @param streamId - Unique identifier for the event stream
   * @param options - Read options (fromSeq, toSeq, limit, types filter)
   * @returns Ordered array of matching events
   */
  read(streamId: string, options?: ReadOptions): Promise<readonly EventEntry[]>;

  /**
   * Reads all events after a given sequence number.
   * Convenience method equivalent to `read(streamId, { fromSeq: afterSeq + 1 })`.
   * @param streamId - Unique identifier for the event stream
   * @param afterSeq - Return events with seq > afterSeq
   */
  readAfter(streamId: string, afterSeq: number): Promise<readonly EventEntry[]>;

  /**
   * Returns the last sequence number in a stream, or 0 if empty.
   * @param streamId - Unique identifier for the event stream
   */
  getLastSeq(streamId: string): Promise<number>;

  /**
   * Removes events with seq < beforeSeq (for compaction/retention).
   * @param streamId - Unique identifier for the event stream
   * @param beforeSeq - Remove all events with seq strictly less than this value
   * @returns Number of events removed
   */
  truncateBefore(streamId: string, beforeSeq: number): Promise<number>;

  /**
   * Lists all stream IDs, optionally filtered by prefix.
   * @param prefix - Optional prefix to filter stream IDs
   */
  listStreams(prefix?: string): Promise<readonly string[]>;

  /**
   * Optional cleanup when adapter is no longer needed.
   */
  close?(): Promise<void>;
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
