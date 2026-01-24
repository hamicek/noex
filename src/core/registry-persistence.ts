/**
 * Registry persistence helpers — serialization, deserialization, and
 * a debounced persistence handler for RegistryInstance.
 *
 * The handler wraps a StorageAdapter directly (rather than PersistenceManager)
 * because registry persistence is change-driven with debouncing, not periodic
 * snapshot-based like GenServer persistence.
 */

import type { StorageAdapter, PersistedState } from '../persistence/types.js';
import type {
  RegisterableRef,
  RegistryKeyMode,
  RegistryEntry,
  RegistryPersistenceConfig,
  SerializedRegistryEntry,
  PersistedRegistryState,
} from './registry-types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Resolves a reference ID back to a live RegisterableRef.
 * Returns undefined if the ref is no longer alive (process terminated).
 */
export type RefResolver = (refId: string) => RegisterableRef | undefined;

/**
 * Internal representation of registry entries for serialization.
 * Passed by RegistryInstance to avoid exposing internal data structures.
 */
export interface RegistryStateSnapshot {
  readonly name: string;
  readonly keyMode: RegistryKeyMode;
  readonly entries: ReadonlyArray<{ key: string; entry: RegistryEntry }>;
}

/**
 * Result of deserializing persisted registry state.
 * Contains entries grouped by key, ready to be loaded into a RegistryInstance.
 */
export interface DeserializedRegistryState {
  readonly registryName: string;
  readonly keyMode: RegistryKeyMode;
  readonly entries: Array<{ key: string; entry: RegistryEntry }>;
  readonly skippedCount: number;
}

// =============================================================================
// Serialization
// =============================================================================

/**
 * Serializes registry state into a persistence-friendly format.
 *
 * Converts live RegisterableRef objects into their string IDs,
 * since refs are runtime objects that cannot be directly serialized.
 */
export function serializeRegistryState(
  snapshot: RegistryStateSnapshot,
): PersistedRegistryState {
  const serializedEntries: SerializedRegistryEntry[] = snapshot.entries.map(
    ({ key, entry }) => ({
      key,
      refId: entry.ref.id,
      metadata: entry.metadata,
      registeredAt: entry.registeredAt,
    }),
  );

  return {
    registryName: snapshot.name,
    keyMode: snapshot.keyMode,
    entries: serializedEntries,
    persistedAt: Date.now(),
  };
}

/**
 * Deserializes persisted registry state back into live entries.
 *
 * Uses the provided refResolver to look up live refs by ID.
 * Entries referencing dead (terminated) processes are skipped.
 *
 * @param persisted - The persisted state to restore
 * @param refResolver - Function to resolve ref IDs to live refs
 * @returns Deserialized state with live entries and count of skipped dead refs
 */
export function deserializeRegistryState(
  persisted: PersistedRegistryState,
  refResolver: RefResolver,
): DeserializedRegistryState {
  const entries: Array<{ key: string; entry: RegistryEntry }> = [];
  let skippedCount = 0;

  for (const serialized of persisted.entries) {
    const ref = refResolver(serialized.refId);
    if (ref === undefined) {
      skippedCount++;
      continue;
    }

    entries.push({
      key: serialized.key,
      entry: {
        ref,
        metadata: serialized.metadata,
        registeredAt: serialized.registeredAt,
      },
    });
  }

  return {
    registryName: persisted.registryName,
    keyMode: persisted.keyMode,
    entries,
    skippedCount,
  };
}

// =============================================================================
// Persistence Handler
// =============================================================================

/**
 * Manages debounced persistence for a RegistryInstance.
 *
 * Responsibilities:
 * - Debounces rapid changes into a single write operation
 * - Provides restore-from-storage on start
 * - Flushes pending changes on shutdown
 * - Reports errors via the configured onError callback (non-fatal)
 */
export class RegistryPersistenceHandler {
  private readonly adapter: StorageAdapter;
  private readonly storageKey: string;
  private readonly debounceMs: number;
  private readonly persistOnChange: boolean;
  private readonly persistOnShutdown: boolean;
  private readonly restoreOnStart: boolean;
  private readonly onError: ((error: Error) => void) | undefined;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSnapshot: RegistryStateSnapshot | null = null;

  constructor(registryName: string, config: RegistryPersistenceConfig) {
    this.adapter = config.adapter;
    this.storageKey = config.key ?? registryName;
    this.debounceMs = config.debounceMs ?? 100;
    this.persistOnChange = config.persistOnChange ?? true;
    this.persistOnShutdown = config.persistOnShutdown ?? true;
    this.restoreOnStart = config.restoreOnStart ?? true;
    this.onError = config.onError;
  }

  /**
   * Restores registry state from storage.
   * Returns undefined if restoreOnStart is disabled or no persisted state exists.
   */
  async restore(refResolver: RefResolver): Promise<DeserializedRegistryState | undefined> {
    if (!this.restoreOnStart) {
      return undefined;
    }

    try {
      const persisted = await this.adapter.load<PersistedRegistryState>(this.storageKey);
      if (persisted === undefined) {
        return undefined;
      }

      return deserializeRegistryState(persisted.state, refResolver);
    } catch (error) {
      this.handleError(error);
      return undefined;
    }
  }

  /**
   * Schedules a debounced persist of the current registry state.
   * Multiple rapid calls within the debounce window are batched.
   */
  schedulePersist(snapshot: RegistryStateSnapshot): void {
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
      const serialized = serializeRegistryState(snapshot);
      const persistedState: PersistedState<PersistedRegistryState> = {
        state: serialized,
        metadata: {
          persistedAt: serialized.persistedAt,
          serverId: `registry:${snapshot.name}`,
          serverName: snapshot.name,
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
  async persistNow(snapshot: RegistryStateSnapshot): Promise<void> {
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
