# Cache

In the previous chapter, you learned to broadcast events with EventBus. Now let's look at another common need: **caching expensive computations or external API calls**. noex provides a built-in Cache service that combines LRU eviction, TTL expiration, and hit/miss statistics — all built on the familiar GenServer foundation.

## What You'll Learn

- How Cache provides thread-safe caching with automatic memory management
- Configure LRU (Least Recently Used) eviction to limit memory usage
- Use TTL (Time-To-Live) to automatically expire stale data
- Leverage atomic `getOrSet` to avoid cache stampedes
- Monitor cache performance with built-in statistics

## Why Use Cache?

Caching improves performance by storing the results of expensive operations:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       WITHOUT CACHE VS WITH CACHE                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  WITHOUT CACHE:                           WITH CACHE:                       │
│                                                                             │
│  Request 1 ──► Database ──► 200ms         Request 1 ──► Database ──► 200ms │
│  Request 2 ──► Database ──► 200ms         Request 2 ──► Cache ──────► 1ms  │
│  Request 3 ──► Database ──► 200ms         Request 3 ──► Cache ──────► 1ms  │
│  Request 4 ──► Database ──► 200ms         Request 4 ──► Cache ──────► 1ms  │
│  ─────────────────────────────            ─────────────────────────────     │
│  Total: 800ms                             Total: 203ms                      │
│                                                                             │
│  Every request hits the slow source       First request populates cache,   │
│                                           subsequent requests are instant   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Use Cache when:**
- Database queries are slow or expensive
- External API calls have rate limits or latency
- Computations are CPU-intensive but results rarely change
- The same data is requested frequently

**Don't use Cache when:**
- Data must always be fresh (real-time stock prices)
- Each request needs unique data (user-specific calculations)
- Memory is extremely limited

## Starting a Cache

Cache is a GenServer under the hood. Each cache instance is independent:

```typescript
import { Cache } from '@hamicek/noex';

// Start with default settings (no size limit, no TTL)
const cache = await Cache.start();

// Start with configuration
const configuredCache = await Cache.start({
  maxSize: 1000,        // Maximum entries before LRU eviction
  defaultTtlMs: 60000,  // Default TTL: 1 minute
  name: 'api-cache',    // Optional: register in the process registry
});

// Check if running
console.log(Cache.isRunning(cache)); // true

// Clean up when done
await Cache.stop(cache);
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxSize` | `number` | `Infinity` | Maximum entries before LRU eviction kicks in |
| `defaultTtlMs` | `number \| null` | `null` | Default TTL for entries (null = no expiration) |
| `name` | `string` | — | Optional name for registry registration |

## Basic Operations

### Set and Get

```typescript
const cache = await Cache.start();

// Store a value
await Cache.set(cache, 'user:123', { name: 'Alice', email: 'alice@example.com' });

// Retrieve a value
const user = await Cache.get(cache, 'user:123');
console.log(user); // { name: 'Alice', email: 'alice@example.com' }

// Non-existent key returns undefined
const missing = await Cache.get(cache, 'user:999');
console.log(missing); // undefined
```

### Type-Safe Access

Use TypeScript generics for typed values:

```typescript
interface User {
  id: string;
  name: string;
  email: string;
}

// Type is inferred from the value
await Cache.set(cache, 'user:123', { id: '123', name: 'Alice', email: 'alice@example.com' });

// Explicitly type the return value
const user = await Cache.get<User>(cache, 'user:123');
if (user) {
  console.log(user.name); // TypeScript knows this is a string
}
```

### Check, Delete, Clear

```typescript
// Check if key exists (and isn't expired)
const exists = await Cache.has(cache, 'user:123');
console.log(exists); // true

// Delete a specific key
const deleted = await Cache.delete(cache, 'user:123');
console.log(deleted); // true (was deleted), false (didn't exist)

// Clear all entries and reset statistics
await Cache.clear(cache);
```

### List Keys and Size

```typescript
await Cache.set(cache, 'a', 1);
await Cache.set(cache, 'b', 2);
await Cache.set(cache, 'c', 3);

// Get number of entries (excludes expired)
const count = await Cache.size(cache);
console.log(count); // 3

// Get all keys (excludes expired)
const keys = await Cache.keys(cache);
console.log(keys); // ['a', 'b', 'c']
```

## TTL (Time-To-Live)

TTL automatically expires entries after a specified duration:

```typescript
const cache = await Cache.start();

// Set with explicit TTL (5 seconds)
await Cache.set(cache, 'session:abc', { userId: '123' }, { ttlMs: 5000 });

// Value exists immediately
console.log(await Cache.get(cache, 'session:abc')); // { userId: '123' }

// After 5 seconds, value expires
await new Promise(r => setTimeout(r, 5100));
console.log(await Cache.get(cache, 'session:abc')); // undefined
```

### Default TTL vs Explicit TTL

```typescript
// Cache with 1-minute default TTL
const cache = await Cache.start({ defaultTtlMs: 60000 });

// Uses default TTL (1 minute)
await Cache.set(cache, 'key1', 'value1');

// Override with explicit TTL (10 seconds)
await Cache.set(cache, 'key2', 'value2', { ttlMs: 10000 });

// Override with no expiration (null)
await Cache.set(cache, 'key3', 'value3', { ttlMs: null });
```

### TTL Decision Guide

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TTL CONFIGURATION GUIDE                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Data Type              │ Recommended TTL     │ Reasoning                   │
│  ───────────────────────┼─────────────────────┼───────────────────────────  │
│  User session           │ 30 min - 24 hours   │ Security + UX balance       │
│  API response           │ 1 - 5 minutes       │ API updates frequently      │
│  Database query         │ 5 - 60 seconds      │ Data consistency            │
│  Static config          │ null (no expiry)    │ Rarely changes              │
│  Feature flags          │ 30 - 300 seconds    │ Allow quick rollback        │
│  Rate limit counters    │ Window size         │ Match rate limit window     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## LRU Eviction

When `maxSize` is set, Cache automatically evicts the **Least Recently Used** entries to make room for new ones:

```typescript
const cache = await Cache.start({ maxSize: 3 });

await Cache.set(cache, 'a', 1);  // Cache: [a]
await Cache.set(cache, 'b', 2);  // Cache: [a, b]
await Cache.set(cache, 'c', 3);  // Cache: [a, b, c] - full

// Access 'a' to make it recently used
await Cache.get(cache, 'a');     // Cache: [b, c, a] - 'a' is now newest

// Add 'd' - must evict something
await Cache.set(cache, 'd', 4);  // Cache: [c, a, d] - 'b' evicted (least recent)

console.log(await Cache.get(cache, 'a')); // 1 - still exists
console.log(await Cache.get(cache, 'b')); // undefined - evicted
console.log(await Cache.get(cache, 'c')); // 3 - still exists
console.log(await Cache.get(cache, 'd')); // 4 - just added
```

### How LRU Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            LRU EVICTION PROCESS                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  maxSize = 3                                                                │
│                                                                             │
│  Step 1: set('a', 1)                                                        │
│  ┌───┐                                                                      │
│  │ a │  ◄── newest                                                          │
│  └───┘                                                                      │
│                                                                             │
│  Step 2: set('b', 2)                                                        │
│  ┌───┬───┐                                                                  │
│  │ a │ b │  ◄── newest                                                      │
│  └───┴───┘                                                                  │
│                                                                             │
│  Step 3: set('c', 3)                                                        │
│  ┌───┬───┬───┐                                                              │
│  │ a │ b │ c │  ◄── newest (cache full)                                     │
│  └───┴───┴───┘                                                              │
│    ▲                                                                        │
│    └── oldest (will be evicted next)                                        │
│                                                                             │
│  Step 4: get('a')  ──► 'a' moves to newest position                         │
│  ┌───┬───┬───┐                                                              │
│  │ b │ c │ a │  ◄── 'a' now newest                                          │
│  └───┴───┴───┘                                                              │
│    ▲                                                                        │
│    └── 'b' now oldest                                                       │
│                                                                             │
│  Step 5: set('d', 4)  ──► evict 'b', add 'd'                                │
│  ┌───┬───┬───┐                                                              │
│  │ c │ a │ d │  ◄── newest                                                  │
│  └───┴───┴───┘                                                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Eviction Priority: Expired First

When evicting, Cache removes **expired entries first**, then falls back to LRU:

```typescript
const cache = await Cache.start({ maxSize: 3 });

// Entry 'a' will expire in 100ms
await Cache.set(cache, 'a', 1, { ttlMs: 100 });
await Cache.set(cache, 'b', 2);
await Cache.set(cache, 'c', 3);

// Wait for 'a' to expire
await new Promise(r => setTimeout(r, 150));

// Add 'd' - Cache evicts expired 'a' first, not LRU 'b'
await Cache.set(cache, 'd', 4);

console.log(await Cache.get(cache, 'a')); // undefined - expired
console.log(await Cache.get(cache, 'b')); // 2 - still exists!
console.log(await Cache.get(cache, 'c')); // 3
console.log(await Cache.get(cache, 'd')); // 4
```

### Choosing maxSize

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MAXSIZE GUIDELINES                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Entry Size        │ Suggested maxSize  │ Approximate Memory                │
│  ──────────────────┼────────────────────┼───────────────────────────────    │
│  Small (~100 B)    │ 10,000 - 100,000   │ 1-10 MB                           │
│  Medium (~1 KB)    │ 1,000 - 10,000     │ 1-10 MB                           │
│  Large (~10 KB)    │ 100 - 1,000        │ 1-10 MB                           │
│  Huge (~100 KB)    │ 10 - 100           │ 1-10 MB                           │
│                                                                             │
│  Rule of thumb: estimate (entry_size * maxSize) to stay within memory       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Atomic getOrSet

The `getOrSet` operation atomically checks for a cached value and computes it if missing — avoiding the "cache stampede" problem:

```typescript
const cache = await Cache.start({ defaultTtlMs: 60000 });

// Expensive database query
async function fetchUser(id: string) {
  console.log(`Fetching user ${id} from database...`);
  // Simulate slow database
  await new Promise(r => setTimeout(r, 200));
  return { id, name: 'Alice', email: 'alice@example.com' };
}

// First call: computes and caches
const user1 = await Cache.getOrSet(cache, 'user:123', () => fetchUser('123'));
// Output: "Fetching user 123 from database..."

// Second call: returns cached value (factory not called)
const user2 = await Cache.getOrSet(cache, 'user:123', () => fetchUser('123'));
// No output - cache hit!

console.log(user1 === user2); // true - same cached reference
```

### Custom TTL for getOrSet

```typescript
// Cache API responses for 30 seconds
const response = await Cache.getOrSet(
  cache,
  `api:weather:${city}`,
  async () => {
    const res = await fetch(`https://api.weather.com/${city}`);
    return res.json();
  },
  { ttlMs: 30000 }
);
```

### Avoiding Cache Stampede

Without atomic getOrSet, concurrent requests can all miss the cache simultaneously:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CACHE STAMPEDE PROBLEM                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  WITHOUT getOrSet (cache stampede):                                         │
│                                                                             │
│  Request 1 ──► has('key')? NO ──► compute() ──► set('key') ─┐              │
│  Request 2 ──► has('key')? NO ──► compute() ──► set('key') ─┤ All hit DB!  │
│  Request 3 ──► has('key')? NO ──► compute() ──► set('key') ─┘              │
│                                                                             │
│  WITH getOrSet (protected):                                                 │
│                                                                             │
│  Request 1 ──► getOrSet('key', compute) ──► compute() ──┐                  │
│  Request 2 ──► getOrSet('key', compute) ──► cache hit! ─┤ Only 1 DB call   │
│  Request 3 ──► getOrSet('key', compute) ──► cache hit! ─┘                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Cache Statistics

Monitor cache performance with built-in statistics:

```typescript
const cache = await Cache.start({ maxSize: 1000 });

// Some operations
await Cache.set(cache, 'a', 1);
await Cache.set(cache, 'b', 2);
await Cache.get(cache, 'a');     // hit
await Cache.get(cache, 'a');     // hit
await Cache.get(cache, 'c');     // miss
await Cache.get(cache, 'd');     // miss

const stats = await Cache.stats(cache);
console.log(stats);
// {
//   size: 2,           // Current number of entries
//   maxSize: 1000,     // Maximum allowed entries
//   hits: 2,           // Successful cache reads
//   misses: 2,         // Cache misses
//   hitRate: 0.5       // hits / (hits + misses)
// }
```

### Using Statistics for Monitoring

```typescript
// Periodic monitoring
setInterval(async () => {
  const stats = await Cache.stats(cache);

  // Alert on low hit rate
  if (stats.hitRate < 0.7 && stats.hits + stats.misses > 100) {
    console.warn(`Low cache hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
  }

  // Alert on high utilization
  const utilization = stats.size / stats.maxSize;
  if (utilization > 0.9) {
    console.warn(`Cache nearly full: ${(utilization * 100).toFixed(1)}%`);
  }

  console.log(`Cache: ${stats.size}/${stats.maxSize} entries, ${(stats.hitRate * 100).toFixed(1)}% hit rate`);
}, 60000);
```

### Interpreting Hit Rate

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           HIT RATE INTERPRETATION                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Hit Rate  │ Status    │ Likely Cause & Action                              │
│  ──────────┼───────────┼────────────────────────────────────────────────    │
│  > 90%     │ Excellent │ Cache is working optimally                         │
│  70-90%    │ Good      │ Normal for mixed workloads                         │
│  50-70%    │ Fair      │ Consider increasing maxSize or TTL                 │
│  < 50%     │ Poor      │ Cache too small, TTL too short, or wrong data      │
│                                                                             │
│  Note: Early in application lifetime, hit rate will be low (cold cache)     │
│        Wait for steady state before making tuning decisions                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Background Pruning

The `prune()` method removes expired entries without waiting for eviction:

```typescript
// Fire-and-forget cleanup
Cache.prune(cache);

// Useful for periodic maintenance
setInterval(() => {
  Cache.prune(cache);
}, 60000); // Clean up every minute
```

This is a `cast` operation (non-blocking) — the cache continues serving requests while pruning.

## Practical Example: API Response Cache

Here's a production-ready API caching layer:

```typescript
import { Cache, type CacheRef } from '@hamicek/noex';

interface ApiCacheConfig {
  maxSize: number;
  defaultTtlMs: number;
  name?: string;
}

interface FetchOptions {
  ttlMs?: number;
  force?: boolean;  // Bypass cache
}

function createApiCache(config: ApiCacheConfig) {
  let cache: CacheRef;
  let requestCount = 0;
  let cacheHits = 0;

  return {
    async start() {
      cache = await Cache.start(config);

      // Periodic cleanup
      setInterval(() => Cache.prune(cache), 60000);
    },

    async fetch<T>(url: string, options: FetchOptions = {}): Promise<T> {
      requestCount++;

      // Bypass cache if forced
      if (options.force) {
        const data = await this.doFetch<T>(url);
        await Cache.set(cache, url, data, { ttlMs: options.ttlMs });
        return data;
      }

      // Use getOrSet for automatic caching
      const cached = await Cache.get<T>(cache, url);
      if (cached !== undefined) {
        cacheHits++;
        return cached;
      }

      const data = await this.doFetch<T>(url);
      await Cache.set(cache, url, data, { ttlMs: options.ttlMs });
      return data;
    },

    async doFetch<T>(url: string): Promise<T> {
      console.log(`[API] Fetching: ${url}`);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response.json() as Promise<T>;
    },

    async invalidate(urlPattern: string) {
      const keys = await Cache.keys(cache);
      for (const key of keys) {
        if (key.includes(urlPattern)) {
          await Cache.delete(cache, key);
        }
      }
    },

    async getMetrics() {
      const stats = await Cache.stats(cache);
      return {
        ...stats,
        totalRequests: requestCount,
        applicationHitRate: requestCount > 0 ? cacheHits / requestCount : 0,
      };
    },

    async stop() {
      await Cache.stop(cache);
    },
  };
}

// Usage
async function main() {
  const apiCache = createApiCache({
    maxSize: 500,
    defaultTtlMs: 30000,  // 30 seconds default
    name: 'api-cache',
  });

  await apiCache.start();

  interface User {
    id: number;
    name: string;
    email: string;
  }

  // First request - fetches from API
  const user1 = await apiCache.fetch<User>(
    'https://jsonplaceholder.typicode.com/users/1'
  );
  console.log('User:', user1.name);

  // Second request - cache hit
  const user2 = await apiCache.fetch<User>(
    'https://jsonplaceholder.typicode.com/users/1'
  );
  console.log('User (cached):', user2.name);

  // Force refresh
  const user3 = await apiCache.fetch<User>(
    'https://jsonplaceholder.typicode.com/users/1',
    { force: true }
  );
  console.log('User (refreshed):', user3.name);

  // Check metrics
  const metrics = await apiCache.getMetrics();
  console.log('Metrics:', metrics);

  await apiCache.stop();
}

main();
```

## Cache vs Other Storage

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     CACHE VS ETS VS DATABASE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Feature          │ Cache          │ ETS             │ Database             │
│  ─────────────────┼────────────────┼─────────────────┼──────────────────    │
│  Access pattern   │ key-value      │ key-value/query │ complex queries      │
│  TTL support      │ built-in       │ manual          │ manual               │
│  LRU eviction     │ built-in       │ manual          │ N/A                  │
│  Hit/miss stats   │ built-in       │ manual          │ N/A                  │
│  Thread safety    │ GenServer      │ built-in        │ external             │
│  Persistence      │ none           │ none            │ durable              │
│  Memory limit     │ maxSize        │ unlimited       │ disk-based           │
│                                                                             │
│  Best for:                                                                  │
│  - Cache: temporary data with automatic expiration                          │
│  - ETS: fast lookup tables, counters, indexes                               │
│  - Database: permanent data, complex queries, transactions                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Exercise: Multi-Tier Cache

Build a two-tier cache system where:
1. L1 cache is small and fast (maxSize: 100, TTL: 10s)
2. L2 cache is larger and slower (maxSize: 1000, TTL: 60s)
3. On L1 miss, check L2 before hitting the data source
4. Track hit rates for both levels

**Starter code:**

```typescript
import { Cache, type CacheRef } from '@hamicek/noex';

interface TieredCacheStats {
  l1Hits: number;
  l2Hits: number;
  misses: number;
  l1HitRate: number;
  l2HitRate: number;
  totalHitRate: number;
}

function createTieredCache() {
  let l1: CacheRef;
  let l2: CacheRef;
  let l1Hits = 0;
  let l2Hits = 0;
  let misses = 0;

  return {
    async start() {
      // TODO: Start L1 cache (small, short TTL)
      // TODO: Start L2 cache (larger, longer TTL)
    },

    async get<T>(key: string): Promise<T | undefined> {
      // TODO: Check L1 first
      // TODO: On L1 miss, check L2
      // TODO: On L2 hit, promote to L1
      // TODO: Track hit statistics
      return undefined;
    },

    async set<T>(key: string, value: T): Promise<void> {
      // TODO: Write to both caches
    },

    async getOrSet<T>(key: string, factory: () => Promise<T>): Promise<T> {
      // TODO: Implement with proper tier checking
      return {} as T;
    },

    getStats(): TieredCacheStats {
      // TODO: Calculate and return statistics
      return {
        l1Hits,
        l2Hits,
        misses,
        l1HitRate: 0,
        l2HitRate: 0,
        totalHitRate: 0,
      };
    },

    async stop() {
      // TODO: Stop both caches
    },
  };
}
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
import { Cache, type CacheRef } from '@hamicek/noex';

interface TieredCacheStats {
  l1Hits: number;
  l2Hits: number;
  misses: number;
  l1HitRate: number;
  l2HitRate: number;
  totalHitRate: number;
}

function createTieredCache() {
  let l1: CacheRef;
  let l2: CacheRef;
  let l1Hits = 0;
  let l2Hits = 0;
  let misses = 0;

  return {
    async start() {
      // L1: Small, fast, short-lived
      l1 = await Cache.start({
        maxSize: 100,
        defaultTtlMs: 10000,  // 10 seconds
        name: 'l1-cache',
      });

      // L2: Larger, slower, longer-lived
      l2 = await Cache.start({
        maxSize: 1000,
        defaultTtlMs: 60000,  // 60 seconds
        name: 'l2-cache',
      });
    },

    async get<T>(key: string): Promise<T | undefined> {
      // Check L1 first
      const l1Value = await Cache.get<T>(l1, key);
      if (l1Value !== undefined) {
        l1Hits++;
        return l1Value;
      }

      // L1 miss - check L2
      const l2Value = await Cache.get<T>(l2, key);
      if (l2Value !== undefined) {
        l2Hits++;
        // Promote to L1 for faster future access
        await Cache.set(l1, key, l2Value);
        return l2Value;
      }

      // Both missed
      misses++;
      return undefined;
    },

    async set<T>(key: string, value: T): Promise<void> {
      // Write to both caches
      await Promise.all([
        Cache.set(l1, key, value),
        Cache.set(l2, key, value),
      ]);
    },

    async getOrSet<T>(key: string, factory: () => Promise<T>): Promise<T> {
      // Check L1
      const l1Value = await Cache.get<T>(l1, key);
      if (l1Value !== undefined) {
        l1Hits++;
        return l1Value;
      }

      // Check L2
      const l2Value = await Cache.get<T>(l2, key);
      if (l2Value !== undefined) {
        l2Hits++;
        // Promote to L1
        await Cache.set(l1, key, l2Value);
        return l2Value;
      }

      // Both missed - compute value
      misses++;
      const value = await factory();

      // Store in both caches
      await Promise.all([
        Cache.set(l1, key, value),
        Cache.set(l2, key, value),
      ]);

      return value;
    },

    getStats(): TieredCacheStats {
      const total = l1Hits + l2Hits + misses;
      return {
        l1Hits,
        l2Hits,
        misses,
        l1HitRate: total > 0 ? l1Hits / total : 0,
        l2HitRate: total > 0 ? l2Hits / total : 0,
        totalHitRate: total > 0 ? (l1Hits + l2Hits) / total : 0,
      };
    },

    async stop() {
      await Promise.all([
        Cache.stop(l1),
        Cache.stop(l2),
      ]);
    },
  };
}

// Test the tiered cache
async function main() {
  const cache = createTieredCache();
  await cache.start();

  // Simulate database fetch
  async function fetchFromDb(id: string) {
    console.log(`[DB] Fetching ${id}...`);
    await new Promise(r => setTimeout(r, 100));
    return { id, data: `Data for ${id}` };
  }

  // First request - both caches miss, hits database
  console.log('Request 1:');
  const data1 = await cache.getOrSet('item:1', () => fetchFromDb('item:1'));
  console.log('Result:', data1);
  console.log('Stats:', cache.getStats());

  // Second request - L1 hit
  console.log('\nRequest 2 (same key):');
  const data2 = await cache.getOrSet('item:1', () => fetchFromDb('item:1'));
  console.log('Result:', data2);
  console.log('Stats:', cache.getStats());

  // Wait for L1 to expire (10 seconds)
  console.log('\nWaiting for L1 expiration...');
  await new Promise(r => setTimeout(r, 11000));

  // Third request - L1 miss, L2 hit (promotes to L1)
  console.log('\nRequest 3 (after L1 expiry):');
  const data3 = await cache.getOrSet('item:1', () => fetchFromDb('item:1'));
  console.log('Result:', data3);
  console.log('Stats:', cache.getStats());

  // Fourth request - L1 hit again (was promoted)
  console.log('\nRequest 4:');
  const data4 = await cache.getOrSet('item:1', () => fetchFromDb('item:1'));
  console.log('Result:', data4);
  console.log('Stats:', cache.getStats());

  await cache.stop();
}

main();
```

**Design decisions:**

1. **L1 promotion** — When L2 hits, we copy the value to L1 for faster future access
2. **Parallel writes** — `set()` writes to both caches concurrently
3. **Independent TTLs** — L1 expires faster, keeping hot data while L2 serves as backup
4. **Separate statistics** — Track hits at each level for tuning

**Output:**
```
Request 1:
[DB] Fetching item:1...
Result: { id: 'item:1', data: 'Data for item:1' }
Stats: { l1Hits: 0, l2Hits: 0, misses: 1, l1HitRate: 0, l2HitRate: 0, totalHitRate: 0 }

Request 2 (same key):
Result: { id: 'item:1', data: 'Data for item:1' }
Stats: { l1Hits: 1, l2Hits: 0, misses: 1, l1HitRate: 0.5, l2HitRate: 0, totalHitRate: 0.5 }

Waiting for L1 expiration...

Request 3 (after L1 expiry):
Result: { id: 'item:1', data: 'Data for item:1' }
Stats: { l1Hits: 1, l2Hits: 1, misses: 1, l1HitRate: 0.33, l2HitRate: 0.33, totalHitRate: 0.67 }

Request 4:
Result: { id: 'item:1', data: 'Data for item:1' }
Stats: { l1Hits: 2, l2Hits: 1, misses: 1, l1HitRate: 0.5, l2HitRate: 0.25, totalHitRate: 0.75 }
```

</details>

## Summary

**Key takeaways:**

- **Cache provides in-memory caching** — Built on GenServer for thread-safe operations
- **LRU eviction** — Automatically removes least recently used entries when `maxSize` is reached
- **TTL expiration** — Entries automatically expire after their time-to-live
- **Atomic getOrSet** — Prevents cache stampedes by computing missing values atomically
- **Built-in statistics** — Monitor hit rate and cache utilization

**Configuration guidelines:**

| Scenario | maxSize | defaultTtlMs | Notes |
|----------|---------|--------------|-------|
| API responses | 500-1000 | 30,000-60,000 | Balance freshness vs performance |
| User sessions | 1000-10000 | 1,800,000 | 30 min TTL typical |
| Database queries | 100-500 | 5,000-30,000 | Keep TTL short for consistency |
| Static data | 100-500 | null | No expiration for config/constants |

**Remember:**

> A cache with 0% hit rate is just overhead. Monitor statistics and tune `maxSize`/`TTL` based on your access patterns. Start with conservative settings and increase based on actual usage.

---

Next: [RateLimiter](./03-ratelimiter.md)
