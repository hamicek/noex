/**
 * Type definitions for ETS (Erlang Term Storage) — in-memory key-value store.
 *
 * Defines table types, configuration, entry structures, query predicates,
 * and persistence serialization for typed key-value tables.
 * Unlike Registry, ETS is not bound to processes — it stores arbitrary typed data.
 */

import type { StorageAdapter } from '../persistence/types.js';

// =============================================================================
// Core Types
// =============================================================================

/**
 * Table type determines how keys and values are organized.
 *
 * - `'set'`: Unique keys, one value per key. Uses `Map<K, V>`.
 * - `'ordered_set'`: Unique keys, sorted by comparator. Supports navigation.
 * - `'bag'`: Duplicate keys allowed, but each {key, value} pair is unique.
 * - `'duplicate_bag'`: Duplicate keys allowed, duplicate values allowed.
 */
export type EtsTableType = 'set' | 'ordered_set' | 'bag' | 'duplicate_bag';

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration for creating an ETS table.
 *
 * @typeParam K - Type of table keys
 * @typeParam V - Type of table values
 */
export interface EtsOptions<K, V> {
  /**
   * Human-readable name for debugging and persistence identification.
   * Auto-generated if not provided.
   */
  readonly name?: string;

  /**
   * Table type determining key/value organization.
   * @default 'set'
   */
  readonly type?: EtsTableType;

  /**
   * Custom key comparator for `ordered_set` tables.
   * Must return negative if `a < b`, zero if `a === b`, positive if `a > b`.
   * Defaults to `<` / `>` comparison for strings and numbers.
   *
   * Ignored for non-ordered table types.
   */
  readonly keyComparator?: (a: K, b: K) => number;

  /**
   * Optional persistence configuration for durable table state.
   * When configured, the table can survive process restarts.
   */
  readonly persistence?: EtsPersistenceConfig;
}

/**
 * Persistence configuration for ETS tables.
 *
 * Uses the existing StorageAdapter interface for pluggable backends.
 * Persistence is change-driven with debouncing, identical to registry persistence.
 */
export interface EtsPersistenceConfig {
  /** Storage adapter for persisting table state */
  readonly adapter: StorageAdapter;

  /**
   * Custom storage key. Defaults to the table name.
   * Useful when running multiple tables with the same adapter.
   */
  readonly key?: string;

  /**
   * Whether to restore entries from storage when the table starts.
   * @default true
   */
  readonly restoreOnStart?: boolean;

  /**
   * Whether to persist state on every mutation.
   * Changes are debounced by `debounceMs` to avoid excessive writes.
   * @default true
   */
  readonly persistOnChange?: boolean;

  /**
   * Debounce interval in milliseconds for change-driven persistence.
   * Multiple rapid changes within this window are batched into one write.
   * @default 100
   */
  readonly debounceMs?: number;

  /**
   * Whether to flush pending changes to storage on shutdown.
   * @default true
   */
  readonly persistOnShutdown?: boolean;

  /**
   * Error handler for persistence failures.
   * Persistence errors are non-fatal — the table continues to operate
   * in-memory even if storage fails.
   */
  readonly onError?: (error: Error) => void;
}

// =============================================================================
// Table Entries
// =============================================================================

/**
 * A single entry in the ETS table.
 *
 * @typeParam K - Type of the entry key
 * @typeParam V - Type of the entry value
 */
export interface EtsEntry<K, V> {
  /** The entry key */
  readonly key: K;

  /** The entry value */
  readonly value: V;

  /** Unix timestamp (ms) when this entry was inserted */
  readonly insertedAt: number;
}

// =============================================================================
// Query & Pattern Matching
// =============================================================================

/**
 * Predicate function for filtering table entries via `select()`.
 *
 * @typeParam K - Key type of the entries being filtered
 * @typeParam V - Value type of the entries being filtered
 * @param key - The entry key
 * @param value - The entry value
 * @returns `true` to include the entry in results
 */
export type EtsPredicate<K, V> = (key: K, value: V) => boolean;

/**
 * Result item from pattern matching or select operations.
 *
 * @typeParam K - Key type of the matched entry
 * @typeParam V - Value type of the matched entry
 */
export interface EtsMatchResult<K, V> {
  /** The entry key */
  readonly key: K;

  /** The entry value */
  readonly value: V;
}

// =============================================================================
// Table Info
// =============================================================================

/**
 * Runtime information about an ETS table.
 * Returned by `EtsTable.info()`.
 */
export interface EtsInfo {
  /** Table name */
  readonly name: string;

  /** Table type */
  readonly type: EtsTableType;

  /** Current number of entries */
  readonly size: number;
}

// =============================================================================
// Persistence Serialization
// =============================================================================

/**
 * Serialized form of a single ETS entry for persistence.
 *
 * Keys and values are stored directly since ETS holds plain data
 * (unlike Registry which holds process references).
 *
 * @typeParam K - Key type
 * @typeParam V - Value type
 */
export interface SerializedEtsEntry<K, V> {
  /** The entry key */
  readonly key: K;

  /** The entry value */
  readonly value: V;

  /** Unix timestamp (ms) when this entry was inserted */
  readonly insertedAt: number;
}

/**
 * Complete persisted state of an ETS table.
 *
 * This structure is what gets written to and read from
 * the StorageAdapter during persistence operations.
 *
 * @typeParam K - Key type
 * @typeParam V - Value type
 */
export interface PersistedEtsState<K, V> {
  /** Name of the table that produced this state */
  readonly tableName: string;

  /** Table type at the time of persistence */
  readonly tableType: EtsTableType;

  /** All serialized entries */
  readonly entries: readonly SerializedEtsEntry<K, V>[];

  /** Unix timestamp (ms) when this snapshot was persisted */
  readonly persistedAt: number;
}
