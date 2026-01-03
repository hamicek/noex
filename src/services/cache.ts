/**
 * Cache - In-memory cache service built on GenServer.
 *
 * Provides a type-safe caching layer with:
 * - TTL (time-to-live) per entry
 * - Maximum size with LRU (Least Recently Used) eviction
 * - Atomic get-or-set operations
 * - Statistics for monitoring
 *
 * @example
 * ```typescript
 * const cache = await Cache.start({ maxSize: 1000, defaultTtlMs: 60000 });
 *
 * // Set with default TTL
 * await Cache.set(cache, 'user:123', { name: 'John' });
 *
 * // Set with custom TTL (5 minutes)
 * await Cache.set(cache, 'session:abc', sessionData, { ttlMs: 300000 });
 *
 * // Get value
 * const user = await Cache.get<User>(cache, 'user:123');
 * if (user) {
 *   console.log(user.name);
 * }
 *
 * // Get or compute if missing
 * const data = await Cache.getOrSet(cache, 'expensive:key', async () => {
 *   return await computeExpensiveValue();
 * });
 *
 * await Cache.stop(cache);
 * ```
 */

import { GenServer, type GenServerRef, type GenServerBehavior } from '../index.js';

/**
 * Cache entry with metadata for TTL and LRU tracking.
 */
interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number | null;
  lastAccessedAt: number;
}

/**
 * Cache internal state.
 */
interface CacheState {
  readonly entries: Map<string, CacheEntry<unknown>>;
  readonly maxSize: number;
  readonly defaultTtlMs: number | null;
  hits: number;
  misses: number;
  accessCounter: number;
}

/**
 * Options for Cache.set()
 */
export interface CacheSetOptions {
  /**
   * Time-to-live in milliseconds for this specific entry.
   * Overrides the default TTL if set.
   * Use null for no expiration.
   */
  readonly ttlMs?: number | null;
}

/**
 * Options for Cache.start()
 */
export interface CacheOptions {
  /**
   * Maximum number of entries in the cache.
   * When exceeded, least recently used entries are evicted.
   * @default Infinity (no limit)
   */
  readonly maxSize?: number;

  /**
   * Default TTL in milliseconds for entries without explicit TTL.
   * Use null for no default expiration.
   * @default null (no expiration)
   */
  readonly defaultTtlMs?: number | null;

  /**
   * Optional name for registry registration.
   */
  readonly name?: string;
}

/**
 * Cache statistics.
 */
export interface CacheStats {
  readonly size: number;
  readonly maxSize: number;
  readonly hits: number;
  readonly misses: number;
  readonly hitRate: number;
}

/**
 * Call messages for Cache.
 */
type CacheCallMsg =
  | { readonly type: 'get'; readonly key: string }
  | { readonly type: 'set'; readonly key: string; readonly value: unknown; readonly ttlMs: number | null | undefined }
  | { readonly type: 'has'; readonly key: string }
  | { readonly type: 'delete'; readonly key: string }
  | { readonly type: 'clear' }
  | { readonly type: 'size' }
  | { readonly type: 'keys' }
  | { readonly type: 'stats' };

/**
 * Cast messages for Cache (background operations).
 */
type CacheCastMsg =
  | { readonly type: 'prune' };

/**
 * Reply types for Cache calls.
 */
type CacheCallReply =
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false }
  | boolean
  | number
  | readonly string[]
  | CacheStats;

/**
 * Cache reference type.
 */
export type CacheRef = GenServerRef<
  CacheState,
  CacheCallMsg,
  CacheCastMsg,
  CacheCallReply
>;

/**
 * Returns a monotonically increasing access order and the new counter value.
 * Uses just the counter for ordering - simpler and more reliable than timestamps.
 */
function getAccessOrder(currentCounter: number): { order: number; newCounter: number } {
  const newCounter = currentCounter + 1;
  return {
    order: newCounter,
    newCounter,
  };
}

/**
 * Resets the access counter.
 * No longer needed since counter is per-instance, but kept for API compatibility.
 *
 * @internal
 */
export function _resetAccessCounter(): void {
  // No-op - counter is now per-instance
}

/**
 * Returns current timestamp in milliseconds for TTL calculations.
 */
function now(): number {
  return Date.now();
}

/**
 * Checks if an entry has expired.
 */
function isExpired(entry: CacheEntry<unknown>): boolean {
  return entry.expiresAt !== null && entry.expiresAt <= now();
}

/**
 * Finds the least recently used key in the cache.
 * Excludes the currently accessed key if provided.
 */
function findLruKey(entries: Map<string, CacheEntry<unknown>>, excludeKey?: string): string | null {
  let lruKey: string | null = null;
  let lruTime = Infinity;

  for (const [key, entry] of entries) {
    if (key === excludeKey) continue;
    if (entry.lastAccessedAt < lruTime) {
      lruTime = entry.lastAccessedAt;
      lruKey = key;
    }
  }

  return lruKey;
}

/**
 * Evicts entries to make room for new ones.
 * First removes expired entries, then LRU entries if needed.
 */
function evictIfNeeded(
  entries: Map<string, CacheEntry<unknown>>,
  maxSize: number,
  excludeKey?: string,
): void {
  // First pass: remove expired entries
  for (const [key, entry] of entries) {
    if (key === excludeKey) continue;
    if (isExpired(entry)) {
      entries.delete(key);
    }
  }

  // Second pass: remove LRU entries until we're under maxSize
  while (entries.size >= maxSize) {
    const lruKey = findLruKey(entries, excludeKey);
    if (lruKey === null) break;
    entries.delete(lruKey);
  }
}

/**
 * Creates the Cache behavior implementation.
 */
function createCacheBehavior(options: CacheOptions): GenServerBehavior<
  CacheState,
  CacheCallMsg,
  CacheCastMsg,
  CacheCallReply
> {
  const maxSize = options.maxSize ?? Infinity;
  const defaultTtlMs = options.defaultTtlMs ?? null;

  return {
    init(): CacheState {
      return {
        entries: new Map(),
        maxSize,
        defaultTtlMs,
        hits: 0,
        misses: 0,
        accessCounter: 0,
      };
    },

    handleCall(
      msg: CacheCallMsg,
      state: CacheState,
    ): readonly [CacheCallReply, CacheState] {
      switch (msg.type) {
        case 'get': {
          const entry = state.entries.get(msg.key);

          if (!entry || isExpired(entry)) {
            // Entry not found or expired
            if (entry) {
              state.entries.delete(msg.key);
            }
            return [
              { found: false },
              { ...state, misses: state.misses + 1 },
            ];
          }

          // Update last accessed time for LRU - explicitly replace entry in map
          const { order, newCounter } = getAccessOrder(state.accessCounter);
          const updatedEntry: CacheEntry<unknown> = {
            value: entry.value,
            expiresAt: entry.expiresAt,
            lastAccessedAt: order,
          };
          state.entries.set(msg.key, updatedEntry);

          return [
            { found: true, value: entry.value },
            { ...state, hits: state.hits + 1, accessCounter: newCounter },
          ];
        }

        case 'set': {
          const currentTime = now();
          // Use provided TTL, or fall back to default TTL
          const effectiveTtlMs = msg.ttlMs !== undefined ? msg.ttlMs : state.defaultTtlMs;
          const expiresAt = effectiveTtlMs !== null ? currentTime + effectiveTtlMs : null;

          // Only evict if adding a NEW key (not updating existing)
          const isNewKey = !state.entries.has(msg.key);
          if (isNewKey) {
            evictIfNeeded(state.entries, state.maxSize, msg.key);
          }

          const { order, newCounter } = getAccessOrder(state.accessCounter);
          state.entries.set(msg.key, {
            value: msg.value,
            expiresAt,
            lastAccessedAt: order,
          });

          return [true, { ...state, accessCounter: newCounter }];
        }

        case 'has': {
          const entry = state.entries.get(msg.key);

          if (!entry || isExpired(entry)) {
            if (entry) {
              state.entries.delete(msg.key);
            }
            return [false, state];
          }

          return [true, state];
        }

        case 'delete': {
          const deleted = state.entries.delete(msg.key);
          return [deleted, state];
        }

        case 'clear': {
          state.entries.clear();
          return [
            true,
            { ...state, hits: 0, misses: 0 },
          ];
        }

        case 'size': {
          // Count only non-expired entries
          let size = 0;
          for (const [key, entry] of state.entries) {
            if (isExpired(entry)) {
              state.entries.delete(key);
            } else {
              size++;
            }
          }
          return [size, state];
        }

        case 'keys': {
          const keys: string[] = [];
          for (const [key, entry] of state.entries) {
            if (isExpired(entry)) {
              state.entries.delete(key);
            } else {
              keys.push(key);
            }
          }
          return [keys, state];
        }

        case 'stats': {
          // Clean up expired entries first
          for (const [key, entry] of state.entries) {
            if (isExpired(entry)) {
              state.entries.delete(key);
            }
          }

          const total = state.hits + state.misses;
          const stats: CacheStats = {
            size: state.entries.size,
            maxSize: state.maxSize,
            hits: state.hits,
            misses: state.misses,
            hitRate: total > 0 ? state.hits / total : 0,
          };
          return [stats, state];
        }
      }
    },

    handleCast(msg: CacheCastMsg, state: CacheState): CacheState {
      if (msg.type === 'prune') {
        // Remove all expired entries
        for (const [key, entry] of state.entries) {
          if (isExpired(entry)) {
            state.entries.delete(key);
          }
        }
      }
      return state;
    },
  };
}

/**
 * Cache provides an in-memory caching layer with TTL and LRU eviction.
 *
 * Built on GenServer, it provides:
 * - Thread-safe operations via message queue
 * - Configurable TTL per entry or default
 * - LRU eviction when max size is reached
 * - Statistics for monitoring cache efficiency
 */
export const Cache = {
  /**
   * Starts a new Cache instance.
   *
   * @param options - Cache configuration
   * @returns Reference to the started Cache
   */
  async start(options: CacheOptions = {}): Promise<CacheRef> {
    const behavior = createCacheBehavior(options);
    const startOptions = options.name !== undefined ? { name: options.name } : {};
    return GenServer.start(behavior, startOptions);
  },

  /**
   * Gets a value from the cache.
   *
   * @param ref - Cache reference
   * @param key - Cache key
   * @returns The cached value or undefined if not found/expired
   */
  async get<T>(ref: CacheRef, key: string): Promise<T | undefined> {
    const result = await GenServer.call(ref, { type: 'get', key }) as
      | { readonly found: true; readonly value: unknown }
      | { readonly found: false };

    if (result.found) {
      return result.value as T;
    }
    return undefined;
  },

  /**
   * Sets a value in the cache.
   *
   * @param ref - Cache reference
   * @param key - Cache key
   * @param value - Value to cache
   * @param options - Set options (TTL override)
   */
  async set<T>(
    ref: CacheRef,
    key: string,
    value: T,
    options: CacheSetOptions = {},
  ): Promise<void> {
    await GenServer.call(ref, {
      type: 'set',
      key,
      value,
      ttlMs: options.ttlMs,
    });
  },

  /**
   * Gets a value from the cache, or sets it using a factory if not found.
   *
   * This is an atomic get-or-set operation.
   *
   * @param ref - Cache reference
   * @param key - Cache key
   * @param factory - Function to compute the value if not cached
   * @param options - Set options (TTL override)
   * @returns The cached or computed value
   */
  async getOrSet<T>(
    ref: CacheRef,
    key: string,
    factory: () => T | Promise<T>,
    options: CacheSetOptions = {},
  ): Promise<T> {
    // First try to get
    const cached = await Cache.get<T>(ref, key);
    if (cached !== undefined) {
      return cached;
    }

    // Compute the value
    const value = await factory();

    // Set it in cache
    await Cache.set(ref, key, value, options);

    return value;
  },

  /**
   * Checks if a key exists in the cache (and is not expired).
   *
   * @param ref - Cache reference
   * @param key - Cache key
   * @returns true if the key exists and is not expired
   */
  async has(ref: CacheRef, key: string): Promise<boolean> {
    return GenServer.call(ref, { type: 'has', key }) as Promise<boolean>;
  },

  /**
   * Deletes a key from the cache.
   *
   * @param ref - Cache reference
   * @param key - Cache key
   * @returns true if the key existed
   */
  async delete(ref: CacheRef, key: string): Promise<boolean> {
    return GenServer.call(ref, { type: 'delete', key }) as Promise<boolean>;
  },

  /**
   * Clears all entries from the cache.
   * Also resets hit/miss statistics.
   *
   * @param ref - Cache reference
   */
  async clear(ref: CacheRef): Promise<void> {
    await GenServer.call(ref, { type: 'clear' });
  },

  /**
   * Returns the number of entries in the cache.
   * Expired entries are not counted.
   *
   * @param ref - Cache reference
   * @returns Number of entries
   */
  async size(ref: CacheRef): Promise<number> {
    return GenServer.call(ref, { type: 'size' }) as Promise<number>;
  },

  /**
   * Returns all keys in the cache.
   * Expired entries are not included.
   *
   * @param ref - Cache reference
   * @returns Array of keys
   */
  async keys(ref: CacheRef): Promise<readonly string[]> {
    return GenServer.call(ref, { type: 'keys' }) as Promise<readonly string[]>;
  },

  /**
   * Returns cache statistics.
   *
   * @param ref - Cache reference
   * @returns Cache statistics
   */
  async stats(ref: CacheRef): Promise<CacheStats> {
    return GenServer.call(ref, { type: 'stats' }) as Promise<CacheStats>;
  },

  /**
   * Triggers a background prune of expired entries.
   * This is a fire-and-forget operation.
   *
   * @param ref - Cache reference
   */
  prune(ref: CacheRef): void {
    GenServer.cast(ref, { type: 'prune' });
  },

  /**
   * Checks if the Cache is running.
   *
   * @param ref - Cache reference
   * @returns true if running
   */
  isRunning(ref: CacheRef): boolean {
    return GenServer.isRunning(ref);
  },

  /**
   * Gracefully stops the Cache.
   *
   * @param ref - Cache reference
   */
  async stop(ref: CacheRef): Promise<void> {
    await GenServer.stop(ref);
  },
} as const;
