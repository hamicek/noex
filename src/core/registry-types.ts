/**
 * Type definitions for RegistryInstance — application-level registries.
 *
 * Defines configuration, entry, and query types for both unique and duplicate
 * key modes, along with persistence serialization structures.
 */

import type { GenServerRef, SupervisorRef } from './types.js';
import type { StorageAdapter } from '../persistence/types.js';

// =============================================================================
// Core Types
// =============================================================================

/**
 * Union type for references that can be registered in a RegistryInstance.
 */
export type RegisterableRef = GenServerRef | SupervisorRef;

/**
 * Key mode determines how many entries can exist under a single key.
 *
 * - `'unique'`: Each key maps to exactly one entry. Re-registration throws.
 * - `'duplicate'`: Each key can map to multiple entries (pub/sub pattern).
 */
export type RegistryKeyMode = 'unique' | 'duplicate';

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration for creating a RegistryInstance.
 */
export interface RegistryOptions {
  /**
   * Human-readable name for debugging and persistence identification.
   * If persistence is configured, this is used as the default storage key.
   */
  readonly name?: string;

  /**
   * Key mode for this registry.
   * @default 'unique'
   */
  readonly keys?: RegistryKeyMode;

  /**
   * Optional persistence configuration for durable registry state.
   * When configured, the registry can survive process restarts.
   */
  readonly persistence?: RegistryPersistenceConfig;
}

/**
 * Persistence configuration specific to RegistryInstance.
 *
 * Uses the existing StorageAdapter interface for pluggable backends.
 * Unlike GenServer persistence (which snapshots state periodically),
 * registry persistence is change-driven with debouncing.
 */
export interface RegistryPersistenceConfig {
  /** Storage adapter for persisting registry state */
  readonly adapter: StorageAdapter;

  /**
   * Custom storage key. Defaults to the registry name.
   * Useful when running multiple registries with the same adapter.
   */
  readonly key?: string;

  /**
   * Whether to restore entries from storage when the registry starts.
   * Entries referencing dead processes will be skipped during restore.
   * @default true
   */
  readonly restoreOnStart?: boolean;

  /**
   * Whether to persist state on every registration change.
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
   * Persistence errors are non-fatal — the registry continues to operate
   * in-memory even if storage fails.
   */
  readonly onError?: (error: Error) => void;
}

// =============================================================================
// Registry Entries
// =============================================================================

/**
 * A single entry in the registry, associating a ref with optional metadata.
 *
 * @typeParam Meta - Type of the metadata attached to this entry.
 *                   Defaults to `unknown` for untyped usage.
 */
export interface RegistryEntry<Meta = unknown> {
  /** The registered process reference */
  readonly ref: RegisterableRef;

  /** Arbitrary metadata associated with this registration */
  readonly metadata: Meta;

  /** Unix timestamp (ms) when this entry was registered */
  readonly registeredAt: number;
}

// =============================================================================
// Query & Pattern Matching
// =============================================================================

/**
 * Predicate function for filtering registry entries via `select()`.
 *
 * @typeParam Meta - Metadata type of the entries being filtered
 * @param key - The registration key
 * @param entry - The registry entry to evaluate
 * @returns `true` to include the entry in results
 */
export type RegistryPredicate<Meta = unknown> = (
  key: string,
  entry: RegistryEntry<Meta>,
) => boolean;

/**
 * Result item from pattern matching or select operations.
 *
 * @typeParam Meta - Metadata type of the matched entry
 */
export interface RegistryMatch<Meta = unknown> {
  /** The key under which the entry is registered */
  readonly key: string;

  /** The registered process reference */
  readonly ref: RegisterableRef;

  /** Metadata associated with this registration */
  readonly metadata: Meta;
}

// =============================================================================
// Dispatch
// =============================================================================

/**
 * Dispatch function invoked with all entries matching a key in duplicate mode.
 *
 * Enables custom routing logic (round-robin, broadcast, weighted, etc.)
 * over the set of registered entries.
 *
 * @typeParam Meta - Metadata type of the entries
 * @param entries - All entries registered under the dispatched key
 * @param message - The message being dispatched
 */
export type DispatchFn<Meta = unknown> = (
  entries: ReadonlyArray<RegistryEntry<Meta>>,
  message: unknown,
) => void;

// =============================================================================
// Persistence Serialization
// =============================================================================

/**
 * Serialized form of a single registry entry for persistence.
 *
 * References are stored by ID since GenServerRef/SupervisorRef
 * are runtime objects that cannot be directly serialized.
 */
export interface SerializedRegistryEntry {
  /** The registration key */
  readonly key: string;

  /** ID of the registered process reference */
  readonly refId: string;

  /** Serialized metadata (must be JSON-safe) */
  readonly metadata: unknown;

  /** Unix timestamp (ms) when this entry was originally registered */
  readonly registeredAt: number;
}

/**
 * Complete persisted state of a RegistryInstance.
 *
 * This structure is what gets written to and read from
 * the StorageAdapter during persistence operations.
 */
export interface PersistedRegistryState {
  /** Name of the registry that produced this state */
  readonly registryName: string;

  /** Key mode at the time of persistence */
  readonly keyMode: RegistryKeyMode;

  /** All serialized entries */
  readonly entries: readonly SerializedRegistryEntry[];

  /** Unix timestamp (ms) when this snapshot was persisted */
  readonly persistedAt: number;
}
