# Cache API Reference

The `Cache` service provides an in-memory caching layer with TTL (time-to-live) and LRU (Least Recently Used) eviction. Built on GenServer for thread-safe operations.

## Import

```typescript
import { Cache } from 'noex';
```

## Types

### CacheRef

Opaque reference to a running Cache instance.

```typescript
type CacheRef = GenServerRef<CacheState, CacheCallMsg, CacheCastMsg, CacheCallReply>;
```

### CacheOptions

Options for `Cache.start()`.

```typescript
interface CacheOptions {
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
```

### CacheSetOptions

Options for `Cache.set()`.

```typescript
interface CacheSetOptions {
  /**
   * Time-to-live in milliseconds for this specific entry.
   * Overrides the default TTL if set.
   * Use null for no expiration.
   */
  readonly ttlMs?: number | null;
}
```

### CacheStats

Cache statistics returned by `Cache.stats()`.

```typescript
interface CacheStats {
  readonly size: number;      // Current number of entries
  readonly maxSize: number;   // Maximum allowed entries
  readonly hits: number;      // Number of cache hits
  readonly misses: number;    // Number of cache misses
  readonly hitRate: number;   // hits / (hits + misses), 0-1
}
```

---

## Methods

### start()

Starts a new Cache instance.

```typescript
async start(options?: CacheOptions): Promise<CacheRef>
```

**Parameters:**
- `options` - Optional cache configuration
  - `maxSize` - Maximum entries before LRU eviction (default: Infinity)
  - `defaultTtlMs` - Default TTL for entries (default: null, no expiration)
  - `name` - Register under this name in Registry

**Returns:** Promise resolving to a CacheRef

**Example:**
```typescript
// Basic cache with no limits
const cache = await Cache.start();

// Cache with size limit and default TTL
const cache = await Cache.start({
  maxSize: 1000,
  defaultTtlMs: 60000, // 1 minute
});

// Named cache for registry lookup
const cache = await Cache.start({ name: 'user-cache' });
```

---

### get()

Gets a value from the cache.

```typescript
async get<T>(ref: CacheRef, key: string): Promise<T | undefined>
```

**Parameters:**
- `ref` - Cache reference
- `key` - Cache key

**Returns:** The cached value or `undefined` if not found/expired

**Example:**
```typescript
const user = await Cache.get<User>(cache, 'user:123');
if (user) {
  console.log(user.name);
}
```

---

### set()

Sets a value in the cache.

```typescript
async set<T>(
  ref: CacheRef,
  key: string,
  value: T,
  options?: CacheSetOptions,
): Promise<void>
```

**Parameters:**
- `ref` - Cache reference
- `key` - Cache key
- `value` - Value to cache
- `options` - Optional set configuration
  - `ttlMs` - TTL override for this entry

**Example:**
```typescript
// Set with default TTL
await Cache.set(cache, 'user:123', { name: 'John' });

// Set with custom TTL (5 minutes)
await Cache.set(cache, 'session:abc', sessionData, { ttlMs: 300000 });

// Set with no expiration (overrides default TTL)
await Cache.set(cache, 'config', configData, { ttlMs: null });
```

---

### getOrSet()

Gets a value from the cache, or sets it using a factory function if not found.

```typescript
async getOrSet<T>(
  ref: CacheRef,
  key: string,
  factory: () => T | Promise<T>,
  options?: CacheSetOptions,
): Promise<T>
```

**Parameters:**
- `ref` - Cache reference
- `key` - Cache key
- `factory` - Function to compute the value if not cached
- `options` - Optional set configuration

**Returns:** The cached or newly computed value

**Example:**
```typescript
const user = await Cache.getOrSet(cache, `user:${id}`, async () => {
  return await fetchUserFromDatabase(id);
});

// With custom TTL
const config = await Cache.getOrSet(
  cache,
  'app-config',
  () => loadConfig(),
  { ttlMs: 3600000 }, // 1 hour
);
```

---

### has()

Checks if a key exists in the cache (and is not expired).

```typescript
async has(ref: CacheRef, key: string): Promise<boolean>
```

**Parameters:**
- `ref` - Cache reference
- `key` - Cache key

**Returns:** `true` if the key exists and is not expired

**Example:**
```typescript
if (await Cache.has(cache, 'user:123')) {
  console.log('User is cached');
}
```

---

### delete()

Deletes a key from the cache.

```typescript
async delete(ref: CacheRef, key: string): Promise<boolean>
```

**Parameters:**
- `ref` - Cache reference
- `key` - Cache key

**Returns:** `true` if the key existed

**Example:**
```typescript
const wasDeleted = await Cache.delete(cache, 'user:123');
```

---

### clear()

Clears all entries from the cache. Also resets hit/miss statistics.

```typescript
async clear(ref: CacheRef): Promise<void>
```

**Parameters:**
- `ref` - Cache reference

**Example:**
```typescript
await Cache.clear(cache);
```

---

### size()

Returns the number of entries in the cache. Expired entries are not counted.

```typescript
async size(ref: CacheRef): Promise<number>
```

**Parameters:**
- `ref` - Cache reference

**Returns:** Number of entries

**Example:**
```typescript
const count = await Cache.size(cache);
console.log(`Cache has ${count} entries`);
```

---

### keys()

Returns all keys in the cache. Expired entries are not included.

```typescript
async keys(ref: CacheRef): Promise<readonly string[]>
```

**Parameters:**
- `ref` - Cache reference

**Returns:** Array of keys

**Example:**
```typescript
const keys = await Cache.keys(cache);
for (const key of keys) {
  console.log(key);
}
```

---

### stats()

Returns cache statistics.

```typescript
async stats(ref: CacheRef): Promise<CacheStats>
```

**Parameters:**
- `ref` - Cache reference

**Returns:** Cache statistics object

**Example:**
```typescript
const stats = await Cache.stats(cache);
console.log(`Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
console.log(`Size: ${stats.size}/${stats.maxSize}`);
```

---

### prune()

Triggers a background prune of expired entries. This is a fire-and-forget operation.

```typescript
prune(ref: CacheRef): void
```

**Parameters:**
- `ref` - Cache reference

**Example:**
```typescript
// Periodically clean up expired entries
setInterval(() => {
  Cache.prune(cache);
}, 60000);
```

---

### isRunning()

Checks if the Cache is running.

```typescript
isRunning(ref: CacheRef): boolean
```

**Parameters:**
- `ref` - Cache reference

**Returns:** `true` if running

**Example:**
```typescript
if (Cache.isRunning(cache)) {
  await Cache.set(cache, 'key', 'value');
}
```

---

### stop()

Gracefully stops the Cache.

```typescript
async stop(ref: CacheRef): Promise<void>
```

**Parameters:**
- `ref` - Cache reference

**Example:**
```typescript
await Cache.stop(cache);
```

---

## Complete Example

```typescript
import { Cache, type CacheStats } from 'noex';

interface User {
  id: string;
  name: string;
  email: string;
}

async function main() {
  // Create cache with 1000 entry limit and 5-minute default TTL
  const userCache = await Cache.start({
    maxSize: 1000,
    defaultTtlMs: 5 * 60 * 1000,
    name: 'users',
  });

  // Fetch user with caching
  async function getUser(id: string): Promise<User> {
    return Cache.getOrSet(userCache, `user:${id}`, async () => {
      console.log(`Fetching user ${id} from database...`);
      // Simulate database fetch
      return { id, name: 'John Doe', email: 'john@example.com' };
    });
  }

  // First call - cache miss
  const user1 = await getUser('123');
  console.log('User:', user1);

  // Second call - cache hit
  const user2 = await getUser('123');
  console.log('User (cached):', user2);

  // Check statistics
  const stats = await Cache.stats(userCache);
  console.log(`Cache stats: ${stats.hits} hits, ${stats.misses} misses`);
  console.log(`Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);

  // Invalidate user on update
  await Cache.delete(userCache, 'user:123');

  // Cleanup
  await Cache.stop(userCache);
}
```

---

## Related

- [GenServer API](./genserver.md) - Underlying implementation
- [Registry API](./registry.md) - Named process lookup
- [Rate Limiter API](./rate-limiter.md) - Request throttling
