/**
 * RegistryInstance — application-level registry with unique/duplicate key modes.
 *
 * Provides an Elixir-like Registry abstraction supporting:
 * - Unique keys (one entry per key, default)
 * - Duplicate keys (multiple entries per key, pub/sub pattern)
 * - Metadata on entries
 * - Pattern matching / select
 * - Dispatch to entries in duplicate mode
 * - Automatic cleanup on process termination
 */

import type { GenServerRef } from './types.js';
import type {
  RegisterableRef,
  RegistryOptions,
  RegistryKeyMode,
  RegistryEntry,
  RegistryPredicate,
  RegistryMatch,
  DispatchFn,
} from './registry-types.js';
import { GenServer } from './gen-server.js';
import { globToRegExp } from './glob-utils.js';

// =============================================================================
// Error Classes
// =============================================================================

/**
 * Error thrown when `lookup()` is called on a duplicate-mode registry.
 * Use `lookupAll()` instead.
 */
export class DuplicateKeyLookupError extends Error {
  override readonly name = 'DuplicateKeyLookupError' as const;

  constructor(readonly registryName: string, readonly key: string) {
    super(
      `Cannot use lookup() on duplicate-key registry '${registryName}' for key '${key}'. Use lookupAll() instead.`,
    );
  }
}

/**
 * Error thrown when `dispatch()` is called on a unique-mode registry.
 * Dispatch is only supported in duplicate-key mode.
 */
export class DispatchNotSupportedError extends Error {
  override readonly name = 'DispatchNotSupportedError' as const;

  constructor(readonly registryName: string) {
    super(
      `dispatch() is not supported on unique-key registry '${registryName}'. Use a duplicate-key registry instead.`,
    );
  }
}

/**
 * Error thrown when the same ref is registered under the same key
 * in duplicate mode (duplicate entries are not allowed).
 */
export class DuplicateRegistrationError extends Error {
  override readonly name = 'DuplicateRegistrationError' as const;

  constructor(
    readonly registryName: string,
    readonly key: string,
    readonly refId: string,
  ) {
    super(
      `Ref '${refId}' is already registered under key '${key}' in registry '${registryName}'.`,
    );
  }
}

// =============================================================================
// RegistryInstance
// =============================================================================

let instanceCounter = 0;

/**
 * An application-level registry instance supporting unique or duplicate key modes.
 *
 * Each instance maintains its own isolated namespace of key→entry mappings,
 * with automatic cleanup when registered processes terminate.
 *
 * @typeParam Meta - Type of metadata attached to each entry
 *
 * @example Unique mode (default)
 * ```typescript
 * const registry = new RegistryInstance<{ role: string }>({ name: 'services' });
 * await registry.start();
 *
 * registry.register('auth', authRef, { role: 'authentication' });
 * const entry = registry.lookup('auth');
 * ```
 *
 * @example Duplicate mode (pub/sub)
 * ```typescript
 * const topics = new RegistryInstance({ name: 'topics', keys: 'duplicate' });
 * await topics.start();
 *
 * topics.register('user:created', handlerA);
 * topics.register('user:created', handlerB);
 * topics.dispatch('user:created', eventPayload);
 * ```
 */
export class RegistryInstance<Meta = unknown> {
  readonly name: string;
  readonly keyMode: RegistryKeyMode;

  private readonly uniqueEntries = new Map<string, RegistryEntry<Meta>>();
  private readonly uniqueRefToKey = new Map<string, string>();

  private readonly duplicateEntries = new Map<string, RegistryEntry<Meta>[]>();
  private readonly duplicateRefToKeys = new Map<string, Set<string>>();

  private lifecycleUnsubscribe: (() => void) | null = null;
  private started = false;

  constructor(options?: RegistryOptions) {
    this.name = options?.name ?? `registry-${++instanceCounter}`;
    this.keyMode = options?.keys ?? 'unique';
  }

  /**
   * Starts the registry instance.
   * Sets up the lifecycle event handler for automatic cleanup.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.lifecycleUnsubscribe = GenServer.onLifecycleEvent((event) => {
      if (event.type === 'terminated') {
        this.handleProcessTerminated(event.ref.id);
      }
    });

    this.started = true;
  }

  /**
   * Closes the registry instance.
   * Removes the lifecycle handler and clears all entries.
   */
  async close(): Promise<void> {
    if (!this.started) {
      return;
    }

    if (this.lifecycleUnsubscribe !== null) {
      this.lifecycleUnsubscribe();
      this.lifecycleUnsubscribe = null;
    }

    this.uniqueEntries.clear();
    this.uniqueRefToKey.clear();
    this.duplicateEntries.clear();
    this.duplicateRefToKeys.clear();

    this.started = false;
  }

  /**
   * Registers a reference under a key with optional metadata.
   *
   * In unique mode: throws AlreadyRegisteredError if key is already taken.
   * In duplicate mode: throws DuplicateRegistrationError if the same ref
   * is already registered under the same key.
   *
   * @param key - The key to register under
   * @param ref - The process reference to register
   * @param metadata - Optional metadata to attach to the entry
   */
  register(key: string, ref: RegisterableRef, metadata?: Meta): void {
    const entry: RegistryEntry<Meta> = {
      ref,
      metadata: (metadata ?? undefined) as Meta,
      registeredAt: Date.now(),
    };

    if (this.keyMode === 'unique') {
      if (this.uniqueEntries.has(key)) {
        throw new AlreadyRegisteredKeyError(this.name, key);
      }
      this.uniqueEntries.set(key, entry);
      this.uniqueRefToKey.set(ref.id, key);
    } else {
      const existing = this.duplicateEntries.get(key);
      if (existing !== undefined) {
        if (existing.some((e) => e.ref.id === ref.id)) {
          throw new DuplicateRegistrationError(this.name, key, ref.id);
        }
        existing.push(entry);
      } else {
        this.duplicateEntries.set(key, [entry]);
      }

      let keys = this.duplicateRefToKeys.get(ref.id);
      if (keys === undefined) {
        keys = new Set();
        this.duplicateRefToKeys.set(ref.id, keys);
      }
      keys.add(key);
    }
  }

  /**
   * Unregisters all entries under a given key.
   *
   * In unique mode: removes the single entry for the key.
   * In duplicate mode: removes all entries for the key.
   *
   * Idempotent — does nothing if the key is not registered.
   */
  unregister(key: string): void {
    if (this.keyMode === 'unique') {
      const entry = this.uniqueEntries.get(key);
      if (entry !== undefined) {
        this.uniqueRefToKey.delete(entry.ref.id);
        this.uniqueEntries.delete(key);
      }
    } else {
      const entries = this.duplicateEntries.get(key);
      if (entries !== undefined) {
        for (const entry of entries) {
          const keys = this.duplicateRefToKeys.get(entry.ref.id);
          if (keys !== undefined) {
            keys.delete(key);
            if (keys.size === 0) {
              this.duplicateRefToKeys.delete(entry.ref.id);
            }
          }
        }
        this.duplicateEntries.delete(key);
      }
    }
  }

  /**
   * Unregisters a specific ref from a key (duplicate mode).
   * In unique mode, unregisters the key if the ref matches.
   *
   * Idempotent — does nothing if the ref is not registered under the key.
   */
  unregisterMatch(key: string, ref: RegisterableRef): void {
    if (this.keyMode === 'unique') {
      const entry = this.uniqueEntries.get(key);
      if (entry !== undefined && entry.ref.id === ref.id) {
        this.uniqueRefToKey.delete(ref.id);
        this.uniqueEntries.delete(key);
      }
    } else {
      const entries = this.duplicateEntries.get(key);
      if (entries === undefined) {
        return;
      }

      const idx = entries.findIndex((e) => e.ref.id === ref.id);
      if (idx === -1) {
        return;
      }

      entries.splice(idx, 1);

      if (entries.length === 0) {
        this.duplicateEntries.delete(key);
      }

      const keys = this.duplicateRefToKeys.get(ref.id);
      if (keys !== undefined) {
        keys.delete(key);
        if (keys.size === 0) {
          this.duplicateRefToKeys.delete(ref.id);
        }
      }
    }
  }

  /**
   * Looks up the single entry for a key (unique mode only).
   *
   * @throws {DuplicateKeyLookupError} If called on a duplicate-mode registry
   * @throws {KeyNotFoundError} If the key is not registered
   */
  lookup(key: string): RegistryEntry<Meta> {
    if (this.keyMode === 'duplicate') {
      throw new DuplicateKeyLookupError(this.name, key);
    }

    const entry = this.uniqueEntries.get(key);
    if (entry === undefined) {
      throw new KeyNotFoundError(this.name, key);
    }
    return entry;
  }

  /**
   * Non-throwing lookup. Returns the entry or undefined.
   * Works in both unique and duplicate mode (returns first entry in duplicate mode).
   */
  whereis(key: string): RegistryEntry<Meta> | undefined {
    if (this.keyMode === 'unique') {
      return this.uniqueEntries.get(key);
    }

    const entries = this.duplicateEntries.get(key);
    return entries !== undefined && entries.length > 0 ? entries[0] : undefined;
  }

  /**
   * Returns all entries for a key (primarily for duplicate mode).
   * In unique mode, returns a single-element array or empty array.
   */
  lookupAll(key: string): ReadonlyArray<RegistryEntry<Meta>> {
    if (this.keyMode === 'unique') {
      const entry = this.uniqueEntries.get(key);
      return entry !== undefined ? [entry] : [];
    }
    return this.duplicateEntries.get(key) ?? [];
  }

  /**
   * Filters all entries using a predicate function.
   * Iterates over every entry in the registry.
   */
  select(predicate: RegistryPredicate<Meta>): RegistryMatch<Meta>[] {
    const results: RegistryMatch<Meta>[] = [];

    if (this.keyMode === 'unique') {
      for (const [key, entry] of this.uniqueEntries) {
        if (predicate(key, entry)) {
          results.push({ key, ref: entry.ref, metadata: entry.metadata });
        }
      }
    } else {
      for (const [key, entries] of this.duplicateEntries) {
        for (const entry of entries) {
          if (predicate(key, entry)) {
            results.push({ key, ref: entry.ref, metadata: entry.metadata });
          }
        }
      }
    }

    return results;
  }

  /**
   * Matches entries by a glob-like key pattern with optional value predicate.
   *
   * Pattern syntax:
   * - `*` matches any characters except `/`
   * - `**` matches any characters including `/`
   * - `?` matches a single character
   *
   * @param keyPattern - Glob pattern to match against keys
   * @param valuePredicate - Optional additional filter on matched entries
   */
  match(
    keyPattern: string,
    valuePredicate?: (entry: RegistryEntry<Meta>) => boolean,
  ): RegistryMatch<Meta>[] {
    const regex = globToRegExp(keyPattern);
    const results: RegistryMatch<Meta>[] = [];

    if (this.keyMode === 'unique') {
      for (const [key, entry] of this.uniqueEntries) {
        if (regex.test(key) && (valuePredicate === undefined || valuePredicate(entry))) {
          results.push({ key, ref: entry.ref, metadata: entry.metadata });
        }
      }
    } else {
      for (const [key, entries] of this.duplicateEntries) {
        if (regex.test(key)) {
          for (const entry of entries) {
            if (valuePredicate === undefined || valuePredicate(entry)) {
              results.push({ key, ref: entry.ref, metadata: entry.metadata });
            }
          }
        }
      }
    }

    return results;
  }

  /**
   * Dispatches a message to all entries under a key (duplicate mode only).
   *
   * If a custom dispatch function is provided, it receives all entries and the message.
   * Otherwise, the default behavior sends the message via `GenServer.cast` to each entry.
   *
   * @throws {DispatchNotSupportedError} If called on a unique-mode registry
   */
  dispatch(key: string, message: unknown, dispatchFn?: DispatchFn<Meta>): void {
    if (this.keyMode === 'unique') {
      throw new DispatchNotSupportedError(this.name);
    }

    const entries = this.duplicateEntries.get(key);
    if (entries === undefined || entries.length === 0) {
      return;
    }

    if (dispatchFn !== undefined) {
      dispatchFn(entries, message);
    } else {
      for (const entry of entries) {
        GenServer.cast(entry.ref as GenServerRef, message);
      }
    }
  }

  /**
   * Returns the metadata for an entry.
   * In duplicate mode, returns metadata of the first entry.
   */
  getMetadata(key: string): Meta | undefined {
    if (this.keyMode === 'unique') {
      return this.uniqueEntries.get(key)?.metadata;
    }

    const entries = this.duplicateEntries.get(key);
    return entries !== undefined && entries.length > 0
      ? entries[0]!.metadata
      : undefined;
  }

  /**
   * Updates metadata for an entry using an updater function.
   * In unique mode, updates the single entry.
   * In duplicate mode, updates all entries under the key.
   *
   * The updater receives the current metadata and returns the new metadata.
   * Returns true if any entries were updated.
   */
  updateMetadata(key: string, updater: (meta: Meta) => Meta): boolean {
    if (this.keyMode === 'unique') {
      const entry = this.uniqueEntries.get(key);
      if (entry === undefined) {
        return false;
      }
      const updated: RegistryEntry<Meta> = {
        ref: entry.ref,
        metadata: updater(entry.metadata),
        registeredAt: entry.registeredAt,
      };
      this.uniqueEntries.set(key, updated);
      return true;
    }

    const entries = this.duplicateEntries.get(key);
    if (entries === undefined || entries.length === 0) {
      return false;
    }

    for (let i = 0; i < entries.length; i++) {
      const current = entries[i]!;
      entries[i] = {
        ref: current.ref,
        metadata: updater(current.metadata),
        registeredAt: current.registeredAt,
      };
    }
    return true;
  }

  /**
   * Checks if a key has any registrations.
   */
  isRegistered(key: string): boolean {
    if (this.keyMode === 'unique') {
      return this.uniqueEntries.has(key);
    }
    const entries = this.duplicateEntries.get(key);
    return entries !== undefined && entries.length > 0;
  }

  /**
   * Returns all keys that have at least one registration.
   */
  getKeys(): readonly string[] {
    if (this.keyMode === 'unique') {
      return Array.from(this.uniqueEntries.keys());
    }
    return Array.from(this.duplicateEntries.keys());
  }

  /**
   * Returns the total number of entries across all keys.
   */
  count(): number {
    if (this.keyMode === 'unique') {
      return this.uniqueEntries.size;
    }
    let total = 0;
    for (const entries of this.duplicateEntries.values()) {
      total += entries.length;
    }
    return total;
  }

  /**
   * Returns the number of entries for a specific key.
   */
  countForKey(key: string): number {
    if (this.keyMode === 'unique') {
      return this.uniqueEntries.has(key) ? 1 : 0;
    }
    return this.duplicateEntries.get(key)?.length ?? 0;
  }

  /**
   * Returns the key associated with a given ref ID (unique mode only).
   * In duplicate mode, returns the first key found for the ref.
   *
   * @internal Used by Observer for process tree display.
   */
  getKeyByRefId(refId: string): string | undefined {
    if (this.keyMode === 'unique') {
      return this.uniqueRefToKey.get(refId);
    }
    const keys = this.duplicateRefToKeys.get(refId);
    if (keys !== undefined && keys.size > 0) {
      return keys.values().next().value as string;
    }
    return undefined;
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private handleProcessTerminated(refId: string): void {
    if (this.keyMode === 'unique') {
      const key = this.uniqueRefToKey.get(refId);
      if (key !== undefined) {
        this.uniqueEntries.delete(key);
        this.uniqueRefToKey.delete(refId);
      }
    } else {
      const keys = this.duplicateRefToKeys.get(refId);
      if (keys === undefined) {
        return;
      }

      for (const key of keys) {
        const entries = this.duplicateEntries.get(key);
        if (entries !== undefined) {
          const filtered = entries.filter((e) => e.ref.id !== refId);
          if (filtered.length === 0) {
            this.duplicateEntries.delete(key);
          } else {
            this.duplicateEntries.set(key, filtered);
          }
        }
      }

      this.duplicateRefToKeys.delete(refId);
    }
  }
}

// =============================================================================
// Additional Error Classes
// =============================================================================

/**
 * Error thrown when a key is already registered in unique mode.
 */
export class AlreadyRegisteredKeyError extends Error {
  override readonly name = 'AlreadyRegisteredKeyError' as const;

  constructor(
    readonly registryName: string,
    readonly key: string,
  ) {
    super(`Key '${key}' is already registered in registry '${registryName}'.`);
  }
}

/**
 * Error thrown when a lookup fails because the key is not found.
 */
export class KeyNotFoundError extends Error {
  override readonly name = 'KeyNotFoundError' as const;

  constructor(
    readonly registryName: string,
    readonly key: string,
  ) {
    super(`Key '${key}' is not registered in registry '${registryName}'.`);
  }
}

/**
 * Resets the instance counter (for testing).
 * @internal
 */
export function _resetInstanceCounter(): void {
  instanceCounter = 0;
}
