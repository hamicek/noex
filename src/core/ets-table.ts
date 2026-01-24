/**
 * ETS Table — in-memory key-value store inspired by Erlang ETS.
 *
 * Supports four table types (set, ordered_set, bag, duplicate_bag)
 * with pattern matching, counter operations, and ordered navigation.
 * Unlike Registry, ETS is not bound to processes — it stores arbitrary typed data.
 */

import type {
  EtsTableType,
  EtsOptions,
  EtsEntry,
  EtsPredicate,
  EtsMatchResult,
  EtsInfo,
} from './ets-types.js';
import { EtsPersistenceHandler } from './ets-persistence.js';
import type { EtsStateSnapshot } from './ets-persistence.js';
import { globToRegExp } from './glob-utils.js';

// =============================================================================
// Error Classes
// =============================================================================

/**
 * Thrown when attempting ordered_set navigation on a non-existent key.
 */
export class EtsKeyNotFoundError extends Error {
  override readonly name = 'EtsKeyNotFoundError' as const;

  constructor(
    readonly tableName: string,
    readonly key: unknown,
  ) {
    super(`Key '${String(key)}' not found in ETS table '${tableName}'.`);
  }
}

/**
 * Thrown when attempting updateCounter on a non-numeric value.
 */
export class EtsCounterTypeError extends Error {
  override readonly name = 'EtsCounterTypeError' as const;

  constructor(
    readonly tableName: string,
    readonly key: unknown,
  ) {
    super(
      `Cannot use updateCounter on key '${String(key)}' in ETS table '${tableName}': value is not a number.`,
    );
  }
}

// =============================================================================
// Instance Counter
// =============================================================================

let instanceCounter = 0;

/**
 * Reset the instance counter. Test-only utility.
 * @internal
 */
export function _resetEtsInstanceCounter(): void {
  instanceCounter = 0;
}

// =============================================================================
// Binary Search Helpers (for ordered_set)
// =============================================================================

/**
 * Find the insertion index for a key in a sorted array using binary search.
 * Returns the index where the key should be inserted to maintain sort order.
 * If the key already exists, returns its index.
 */
function binarySearchIndex<K, V>(
  entries: readonly EtsEntry<K, V>[],
  key: K,
  comparator: (a: K, b: K) => number,
): { index: number; found: boolean } {
  let low = 0;
  let high = entries.length - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const cmp = comparator(key, entries[mid]!.key);

    if (cmp === 0) {
      return { index: mid, found: true };
    } else if (cmp < 0) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return { index: low, found: false };
}

// =============================================================================
// Default Comparator
// =============================================================================

function defaultComparator<K>(a: K, b: K): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// =============================================================================
// EtsTable
// =============================================================================

/**
 * In-memory key-value table with configurable storage semantics.
 *
 * @typeParam K - Key type
 * @typeParam V - Value type
 */
export class EtsTable<K, V> {
  readonly name: string;
  readonly type: EtsTableType;

  private readonly keyComparator: (a: K, b: K) => number;
  private readonly persistenceHandler: EtsPersistenceHandler<K, V> | null;
  private started = false;
  private closed = false;

  // Storage for 'set' type
  private readonly setStore = new Map<K, EtsEntry<K, V>>();

  // Storage for 'ordered_set' type
  private orderedStore: EtsEntry<K, V>[] = [];

  // Storage for 'bag' and 'duplicate_bag' types
  private readonly bagStore = new Map<K, EtsEntry<K, V>[]>();

  constructor(options?: EtsOptions<K, V>) {
    this.type = options?.type ?? 'set';
    this.name = options?.name ?? `ets-${++instanceCounter}`;
    this.keyComparator = options?.keyComparator ?? defaultComparator;
    this.persistenceHandler = options?.persistence
      ? new EtsPersistenceHandler<K, V>(this.name, options.persistence)
      : null;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Initialize the table. Must be called before any operations.
   * Restores persisted state if persistence is configured.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (this.persistenceHandler) {
      const restored = await this.persistenceHandler.restore();
      if (restored) {
        this.loadEntries(restored.entries);
      }
    }
  }

  /**
   * Shut down the table. After close(), no further operations are allowed.
   * Flushes pending persistence if configured.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.persistenceHandler) {
      await this.persistenceHandler.persistNow(this.createSnapshot());
    }
  }

  // ===========================================================================
  // CRUD Operations
  // ===========================================================================

  /**
   * Insert a key-value pair into the table.
   *
   * - `set` / `ordered_set`: Overwrites existing value for the key.
   * - `bag`: Adds the entry only if this exact {key, value} pair doesn't exist.
   * - `duplicate_bag`: Always adds the entry (duplicates allowed).
   */
  insert(key: K, value: V): void {
    this.assertOpen();

    const entry: EtsEntry<K, V> = {
      key,
      value,
      insertedAt: Date.now(),
    };

    switch (this.type) {
      case 'set':
        this.setStore.set(key, entry);
        break;

      case 'ordered_set':
        this.insertOrdered(key, entry);
        break;

      case 'bag':
        this.insertBag(key, entry, true);
        break;

      case 'duplicate_bag':
        this.insertBag(key, entry, false);
        break;
    }

    this.notifyPersistence();
  }

  /**
   * Bulk insert multiple key-value pairs.
   */
  insertMany(entries: ReadonlyArray<readonly [K, V]>): void {
    for (const [key, value] of entries) {
      this.insert(key, value);
    }
  }

  /**
   * Look up the value(s) for a key.
   *
   * - `set` / `ordered_set`: Returns `V | undefined`.
   * - `bag` / `duplicate_bag`: Returns `V[]` (empty array if key not found).
   */
  lookup(key: K): V | V[] | undefined {
    this.assertOpen();

    switch (this.type) {
      case 'set':
        return this.setStore.get(key)?.value;

      case 'ordered_set': {
        const { index, found } = binarySearchIndex(
          this.orderedStore,
          key,
          this.keyComparator,
        );
        return found ? this.orderedStore[index]!.value : undefined;
      }

      case 'bag':
      case 'duplicate_bag': {
        const entries = this.bagStore.get(key);
        return entries ? entries.map((e) => e.value) : [];
      }
    }
  }

  /**
   * Delete all entries for a key.
   * Returns `true` if any entries were removed.
   */
  delete(key: K): boolean {
    this.assertOpen();

    switch (this.type) {
      case 'set': {
        const deleted = this.setStore.delete(key);
        if (deleted) this.notifyPersistence();
        return deleted;
      }

      case 'ordered_set': {
        const { index, found } = binarySearchIndex(
          this.orderedStore,
          key,
          this.keyComparator,
        );
        if (found) {
          this.orderedStore.splice(index, 1);
          this.notifyPersistence();
          return true;
        }
        return false;
      }

      case 'bag':
      case 'duplicate_bag': {
        const deleted = this.bagStore.delete(key);
        if (deleted) this.notifyPersistence();
        return deleted;
      }
    }
  }

  /**
   * Delete a specific {key, value} pair. Only meaningful for bag/duplicate_bag.
   * For set/ordered_set, behaves like `delete(key)` if the value matches.
   *
   * Uses strict equality (`===`) for value comparison.
   * Returns `true` if the entry was removed.
   */
  deleteObject(key: K, value: V): boolean {
    this.assertOpen();

    switch (this.type) {
      case 'set': {
        const entry = this.setStore.get(key);
        if (entry && entry.value === value) {
          this.setStore.delete(key);
          this.notifyPersistence();
          return true;
        }
        return false;
      }

      case 'ordered_set': {
        const { index, found } = binarySearchIndex(
          this.orderedStore,
          key,
          this.keyComparator,
        );
        if (found && this.orderedStore[index]!.value === value) {
          this.orderedStore.splice(index, 1);
          this.notifyPersistence();
          return true;
        }
        return false;
      }

      case 'bag':
      case 'duplicate_bag': {
        const entries = this.bagStore.get(key);
        if (!entries) return false;

        const idx = entries.findIndex((e) => e.value === value);
        if (idx === -1) return false;

        entries.splice(idx, 1);
        if (entries.length === 0) {
          this.bagStore.delete(key);
        }
        this.notifyPersistence();
        return true;
      }
    }
  }

  /**
   * Check if a key exists in the table.
   */
  member(key: K): boolean {
    this.assertOpen();

    switch (this.type) {
      case 'set':
        return this.setStore.has(key);

      case 'ordered_set': {
        const { found } = binarySearchIndex(
          this.orderedStore,
          key,
          this.keyComparator,
        );
        return found;
      }

      case 'bag':
      case 'duplicate_bag':
        return this.bagStore.has(key);
    }
  }

  /**
   * Return the total number of entries in the table.
   * For bags, counts all entries across all keys.
   */
  size(): number {
    this.assertOpen();

    switch (this.type) {
      case 'set':
        return this.setStore.size;

      case 'ordered_set':
        return this.orderedStore.length;

      case 'bag':
      case 'duplicate_bag': {
        let count = 0;
        for (const entries of this.bagStore.values()) {
          count += entries.length;
        }
        return count;
      }
    }
  }

  /**
   * Return all entries as an array of [key, value] tuples.
   * For ordered_set, entries are in sorted order.
   */
  toArray(): [K, V][] {
    this.assertOpen();

    switch (this.type) {
      case 'set':
        return Array.from(this.setStore.values(), (e) => [e.key, e.value]);

      case 'ordered_set':
        return this.orderedStore.map((e) => [e.key, e.value]);

      case 'bag':
      case 'duplicate_bag': {
        const result: [K, V][] = [];
        for (const entries of this.bagStore.values()) {
          for (const e of entries) {
            result.push([e.key, e.value]);
          }
        }
        return result;
      }
    }
  }

  /**
   * Return all keys in the table.
   * For ordered_set, keys are in sorted order.
   */
  keys(): K[] {
    this.assertOpen();

    switch (this.type) {
      case 'set':
        return Array.from(this.setStore.keys());

      case 'ordered_set':
        return this.orderedStore.map((e) => e.key);

      case 'bag':
      case 'duplicate_bag':
        return Array.from(this.bagStore.keys());
    }
  }

  /**
   * Remove all entries from the table.
   */
  clear(): void {
    this.assertOpen();

    switch (this.type) {
      case 'set':
        this.setStore.clear();
        break;

      case 'ordered_set':
        this.orderedStore = [];
        break;

      case 'bag':
      case 'duplicate_bag':
        this.bagStore.clear();
        break;
    }

    this.notifyPersistence();
  }

  // ===========================================================================
  // Query & Pattern Matching
  // ===========================================================================

  /**
   * Filter entries by a predicate function.
   * Returns matching entries as {key, value} pairs.
   */
  select(predicate: EtsPredicate<K, V>): EtsMatchResult<K, V>[] {
    this.assertOpen();

    const results: EtsMatchResult<K, V>[] = [];

    for (const entry of this.iterateEntries()) {
      if (predicate(entry.key, entry.value)) {
        results.push({ key: entry.key, value: entry.value });
      }
    }

    return results;
  }

  /**
   * Match entries by a glob pattern on string keys, with optional value predicate.
   * Only works when keys are strings — non-string keys are converted via String().
   *
   * Glob syntax:
   * - `*` matches any characters except `/`
   * - `**` matches any characters including `/`
   * - `?` matches a single character
   */
  match(keyPattern: string, valuePredicate?: EtsPredicate<K, V>): EtsMatchResult<K, V>[] {
    this.assertOpen();

    const regex = globToRegExp(keyPattern);
    const results: EtsMatchResult<K, V>[] = [];

    for (const entry of this.iterateEntries()) {
      const keyStr = String(entry.key);
      if (regex.test(keyStr)) {
        if (!valuePredicate || valuePredicate(entry.key, entry.value)) {
          results.push({ key: entry.key, value: entry.value });
        }
      }
    }

    return results;
  }

  /**
   * Reduce (fold) over all entries in the table.
   */
  reduce<A>(fn: (accumulator: A, key: K, value: V) => A, initial: A): A {
    this.assertOpen();

    let acc = initial;
    for (const entry of this.iterateEntries()) {
      acc = fn(acc, entry.key, entry.value);
    }
    return acc;
  }

  // ===========================================================================
  // Counter Operations
  // ===========================================================================

  /**
   * Atomically increment/decrement a numeric counter.
   * Only valid for set/ordered_set tables with numeric values.
   *
   * If the key doesn't exist, initializes it to `increment`.
   * @throws {EtsCounterTypeError} If the existing value is not a number.
   */
  updateCounter(key: K, increment: number): number {
    this.assertOpen();

    if (this.type === 'bag' || this.type === 'duplicate_bag') {
      throw new EtsCounterTypeError(this.name, key);
    }

    const currentValue = this.lookupRawValue(key);

    if (currentValue === undefined) {
      this.insert(key, increment as unknown as V);
      return increment;
    }

    if (typeof currentValue !== 'number') {
      throw new EtsCounterTypeError(this.name, key);
    }

    const newValue = currentValue + increment;
    this.insert(key, newValue as unknown as V);
    return newValue;
  }

  // ===========================================================================
  // Ordered Set Navigation
  // ===========================================================================

  /**
   * Return the first entry in an ordered_set table.
   * Returns `undefined` if the table is empty.
   * Only meaningful for ordered_set — for other types, returns an arbitrary entry.
   */
  first(): EtsMatchResult<K, V> | undefined {
    this.assertOpen();

    switch (this.type) {
      case 'ordered_set': {
        const entry = this.orderedStore[0];
        return entry ? { key: entry.key, value: entry.value } : undefined;
      }

      case 'set': {
        const iter = this.setStore.values().next();
        if (iter.done) return undefined;
        return { key: iter.value.key, value: iter.value.value };
      }

      case 'bag':
      case 'duplicate_bag': {
        const iter = this.bagStore.values().next();
        if (iter.done) return undefined;
        const entries = iter.value;
        const entry = entries[0];
        return entry ? { key: entry.key, value: entry.value } : undefined;
      }
    }
  }

  /**
   * Return the last entry in an ordered_set table.
   * Returns `undefined` if the table is empty.
   * Only meaningful for ordered_set — for other types, returns an arbitrary entry.
   */
  last(): EtsMatchResult<K, V> | undefined {
    this.assertOpen();

    switch (this.type) {
      case 'ordered_set': {
        const entry = this.orderedStore[this.orderedStore.length - 1];
        return entry ? { key: entry.key, value: entry.value } : undefined;
      }

      default:
        return this.first();
    }
  }

  /**
   * Return the entry immediately after the given key in an ordered_set.
   * @throws {EtsKeyNotFoundError} If the key does not exist.
   */
  next(key: K): EtsMatchResult<K, V> | undefined {
    this.assertOpen();
    this.assertOrderedSet('next');

    const { index, found } = binarySearchIndex(
      this.orderedStore,
      key,
      this.keyComparator,
    );

    if (!found) {
      throw new EtsKeyNotFoundError(this.name, key);
    }

    const nextEntry = this.orderedStore[index + 1];
    return nextEntry ? { key: nextEntry.key, value: nextEntry.value } : undefined;
  }

  /**
   * Return the entry immediately before the given key in an ordered_set.
   * @throws {EtsKeyNotFoundError} If the key does not exist.
   */
  prev(key: K): EtsMatchResult<K, V> | undefined {
    this.assertOpen();
    this.assertOrderedSet('prev');

    const { index, found } = binarySearchIndex(
      this.orderedStore,
      key,
      this.keyComparator,
    );

    if (!found) {
      throw new EtsKeyNotFoundError(this.name, key);
    }

    if (index === 0) return undefined;
    const prevEntry = this.orderedStore[index - 1];
    return prevEntry ? { key: prevEntry.key, value: prevEntry.value } : undefined;
  }

  // ===========================================================================
  // Info
  // ===========================================================================

  /**
   * Return runtime information about the table.
   */
  info(): EtsInfo {
    return {
      name: this.name,
      type: this.type,
      size: this.size(),
    };
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`ETS table '${this.name}' is closed.`);
    }
  }

  private assertOrderedSet(method: string): void {
    if (this.type !== 'ordered_set') {
      throw new Error(
        `${method}() is only supported on ordered_set tables, but '${this.name}' is of type '${this.type}'.`,
      );
    }
  }

  private insertOrdered(key: K, entry: EtsEntry<K, V>): void {
    const { index, found } = binarySearchIndex(
      this.orderedStore,
      key,
      this.keyComparator,
    );

    if (found) {
      this.orderedStore[index] = entry;
    } else {
      this.orderedStore.splice(index, 0, entry);
    }
  }

  private insertBag(key: K, entry: EtsEntry<K, V>, checkDuplicates: boolean): void {
    const existing = this.bagStore.get(key);

    if (!existing) {
      this.bagStore.set(key, [entry]);
      return;
    }

    if (checkDuplicates) {
      const duplicate = existing.some((e) => e.value === entry.value);
      if (duplicate) return;
    }

    existing.push(entry);
  }

  private lookupRawValue(key: K): V | undefined {
    switch (this.type) {
      case 'set':
        return this.setStore.get(key)?.value;

      case 'ordered_set': {
        const { index, found } = binarySearchIndex(
          this.orderedStore,
          key,
          this.keyComparator,
        );
        return found ? this.orderedStore[index]!.value : undefined;
      }

      default:
        return undefined;
    }
  }

  private *iterateEntries(): IterableIterator<EtsEntry<K, V>> {
    switch (this.type) {
      case 'set':
        yield* this.setStore.values();
        break;

      case 'ordered_set':
        yield* this.orderedStore;
        break;

      case 'bag':
      case 'duplicate_bag':
        for (const entries of this.bagStore.values()) {
          yield* entries;
        }
        break;
    }
  }

  // ===========================================================================
  // Persistence Helpers
  // ===========================================================================

  private createSnapshot(): EtsStateSnapshot<K, V> {
    return {
      tableName: this.name,
      tableType: this.type,
      entries: Array.from(this.iterateEntries()),
    };
  }

  private notifyPersistence(): void {
    if (this.persistenceHandler) {
      this.persistenceHandler.schedulePersist(this.createSnapshot());
    }
  }

  private loadEntries(entries: ReadonlyArray<EtsEntry<K, V>>): void {
    for (const entry of entries) {
      switch (this.type) {
        case 'set':
          this.setStore.set(entry.key, entry);
          break;

        case 'ordered_set':
          this.insertOrdered(entry.key, entry);
          break;

        case 'bag':
          this.insertBag(entry.key, entry, true);
          break;

        case 'duplicate_bag':
          this.insertBag(entry.key, entry, false);
          break;
      }
    }
  }
}
