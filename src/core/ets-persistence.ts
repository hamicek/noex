/**
 * ETS persistence helpers — serialization, deserialization, and
 * a debounced persistence handler for EtsTable.
 *
 * Simpler than registry persistence: ETS stores plain data (not process refs),
 * so serialization is a direct mapping of key/value/insertedAt tuples.
 */

import type { StorageAdapter, PersistedState } from '../persistence/types.js';
import type {
  EtsTableType,
  EtsPersistenceConfig,
  EtsEntry,
  SerializedEtsEntry,
  PersistedEtsState,
} from './ets-types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Snapshot of ETS table state, provided by EtsTable for persistence.
 * Decouples the handler from internal storage structures.
 */
export interface EtsStateSnapshot<K, V> {
  readonly tableName: string;
  readonly tableType: EtsTableType;
  readonly entries: ReadonlyArray<EtsEntry<K, V>>;
}

/**
 * Result of deserializing persisted ETS state.
 * Contains entries ready to be loaded back into an EtsTable.
 */
export interface DeserializedEtsState<K, V> {
  readonly tableName: string;
  readonly tableType: EtsTableType;
  readonly entries: ReadonlyArray<EtsEntry<K, V>>;
}

// =============================================================================
// Serialization
// =============================================================================

/**
 * Serializes ETS table state into a persistence-friendly format.
 *
 * Since ETS stores plain data (unlike Registry which stores process refs),
 * serialization is a straightforward mapping of entries.
 */
export function serializeEtsState<K, V>(
  snapshot: EtsStateSnapshot<K, V>,
): PersistedEtsState<K, V> {
  const serializedEntries: SerializedEtsEntry<K, V>[] = snapshot.entries.map(
    (entry) => ({
      key: entry.key,
      value: entry.value,
      insertedAt: entry.insertedAt,
    }),
  );

  return {
    tableName: snapshot.tableName,
    tableType: snapshot.tableType,
    entries: serializedEntries,
    persistedAt: Date.now(),
  };
}

/**
 * Deserializes persisted ETS state back into table entries.
 *
 * No ref resolution needed — entries are directly usable.
 */
export function deserializeEtsState<K, V>(
  persisted: PersistedEtsState<K, V>,
): DeserializedEtsState<K, V> {
  const entries: EtsEntry<K, V>[] = persisted.entries.map((serialized) => ({
    key: serialized.key,
    value: serialized.value,
    insertedAt: serialized.insertedAt,
  }));

  return {
    tableName: persisted.tableName,
    tableType: persisted.tableType,
    entries,
  };
}

// =============================================================================
// Persistence Handler
// =============================================================================

/**
 * Manages debounced persistence for an EtsTable.
 *
 * Responsibilities:
 * - Debounces rapid changes into a single write operation
 * - Provides restore-from-storage on start
 * - Flushes pending changes on shutdown
 * - Reports errors via the configured onError callback (non-fatal)
 */
export class EtsPersistenceHandler<K, V> {
  private readonly adapter: StorageAdapter;
  private readonly storageKey: string;
  private readonly debounceMs: number;
  private readonly persistOnChange: boolean;
  private readonly persistOnShutdown: boolean;
  private readonly restoreOnStart: boolean;
  private readonly onError: ((error: Error) => void) | undefined;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSnapshot: EtsStateSnapshot<K, V> | null = null;

  constructor(tableName: string, config: EtsPersistenceConfig) {
    this.adapter = config.adapter;
    this.storageKey = config.key ?? tableName;
    this.debounceMs = config.debounceMs ?? 100;
    this.persistOnChange = config.persistOnChange ?? true;
    this.persistOnShutdown = config.persistOnShutdown ?? true;
    this.restoreOnStart = config.restoreOnStart ?? true;
    this.onError = config.onError;
  }

  /**
   * Restores table state from storage.
   * Returns undefined if restoreOnStart is disabled or no persisted state exists.
   */
  async restore(): Promise<DeserializedEtsState<K, V> | undefined> {
    if (!this.restoreOnStart) {
      return undefined;
    }

    try {
      const persisted = await this.adapter.load<PersistedEtsState<K, V>>(this.storageKey);
      if (persisted === undefined) {
        return undefined;
      }

      return deserializeEtsState(persisted.state);
    } catch (error) {
      this.handleError(error);
      return undefined;
    }
  }

  /**
   * Schedules a debounced persist of the current table state.
   * Multiple rapid calls within the debounce window are batched.
   */
  schedulePersist(snapshot: EtsStateSnapshot<K, V>): void {
    if (!this.persistOnChange) {
      return;
    }

    this.pendingSnapshot = snapshot;

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /**
   * Flushes any pending state to storage immediately.
   * Called on shutdown or when immediate persistence is needed.
   */
  async flush(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.pendingSnapshot === null) {
      return;
    }

    const snapshot = this.pendingSnapshot;
    this.pendingSnapshot = null;

    try {
      const serialized = serializeEtsState(snapshot);
      const persistedState: PersistedState<PersistedEtsState<K, V>> = {
        state: serialized,
        metadata: {
          persistedAt: serialized.persistedAt,
          serverId: `ets:${snapshot.tableName}`,
          serverName: snapshot.tableName,
          schemaVersion: 1,
        },
      };

      await this.adapter.save(this.storageKey, persistedState);
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Shuts down the handler, flushing pending state if configured.
   */
  async shutdown(): Promise<void> {
    if (this.persistOnShutdown && this.pendingSnapshot !== null) {
      await this.flush();
    } else if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.pendingSnapshot = null;
    }
  }

  /**
   * Explicitly persists the given snapshot immediately, bypassing debounce.
   * Used for shutdown persist when the caller provides the final state.
   */
  async persistNow(snapshot: EtsStateSnapshot<K, V>): Promise<void> {
    this.pendingSnapshot = snapshot;
    await this.flush();
  }

  /**
   * Returns whether there are pending changes waiting to be flushed.
   */
  hasPendingChanges(): boolean {
    return this.pendingSnapshot !== null || this.debounceTimer !== null;
  }

  private handleError(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    if (this.onError !== undefined) {
      this.onError(err);
    }
  }
}
