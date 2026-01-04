# Cache Service

Using the built-in Cache service for key-value storage with TTL support.

## Overview

This example shows:
- Using the built-in Cache service
- Setting values with TTL
- Eviction policies
- Statistics tracking

## Complete Code

```typescript
import { Cache, type CacheRef } from 'noex';

async function main() {
  // Start a cache with configuration
  const cache: CacheRef = await Cache.start({
    maxSize: 1000,           // Maximum entries
    defaultTtl: 60_000,      // Default TTL: 60 seconds
    evictionPolicy: 'lru',   // Least Recently Used eviction
  });

  // Basic operations
  await Cache.set(cache, 'user:1', { name: 'Alice', age: 30 });
  await Cache.set(cache, 'user:2', { name: 'Bob', age: 25 });

  // Get values
  const user1 = await Cache.get(cache, 'user:1');
  console.log('User 1:', user1); // { name: 'Alice', age: 30 }

  // Check existence
  const exists = await Cache.has(cache, 'user:1');
  console.log('Exists:', exists); // true

  // Set with custom TTL (5 seconds)
  await Cache.set(cache, 'temp:session', 'abc123', { ttl: 5_000 });

  // Get or set pattern
  const value = await Cache.getOrSet(cache, 'computed:key', async () => {
    console.log('Computing value...');
    return 'computed-result';
  });
  console.log('Value:', value); // computed-result

  // Second call uses cached value (no "Computing..." message)
  const cachedValue = await Cache.getOrSet(cache, 'computed:key', async () => {
    console.log('Computing value...');
    return 'different-result';
  });
  console.log('Cached:', cachedValue); // computed-result

  // Get statistics
  const stats = await Cache.getStats(cache);
  console.log('Cache stats:', stats);
  // { size: 4, hits: 1, misses: 1, evictions: 0 }

  // Delete entries
  await Cache.delete(cache, 'user:2');
  console.log('User 2 after delete:', await Cache.get(cache, 'user:2')); // null

  // Clear all entries
  await Cache.clear(cache);
  const statsAfterClear = await Cache.getStats(cache);
  console.log('Size after clear:', statsAfterClear.size); // 0

  // Stop the cache
  await Cache.stop(cache);
}

main().catch(console.error);
```

## Output

```
User 1: { name: 'Alice', age: 30 }
Exists: true
Computing value...
Value: computed-result
Cached: computed-result
Cache stats: { size: 4, hits: 1, misses: 1, evictions: 0 }
User 2 after delete: null
Size after clear: 0
```

## Custom Cache Implementation

For specialized caching needs, you can implement your own cache GenServer:

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

interface CacheState {
  data: Map<string, { value: unknown; expiresAt: number }>;
}

type CacheCall =
  | { type: 'get'; key: string }
  | { type: 'has'; key: string };

type CacheCast =
  | { type: 'set'; key: string; value: unknown; ttl?: number }
  | { type: 'delete'; key: string }
  | { type: 'cleanup' };

const customCacheBehavior: GenServerBehavior<CacheState, CacheCall, CacheCast, unknown> = {
  init: () => ({ data: new Map() }),

  handleCall: (msg, state) => {
    const now = Date.now();
    switch (msg.type) {
      case 'get': {
        const entry = state.data.get(msg.key);
        if (!entry || entry.expiresAt < now) {
          state.data.delete(msg.key);
          return [null, state];
        }
        return [entry.value, state];
      }
      case 'has': {
        const entry = state.data.get(msg.key);
        return [entry !== undefined && entry.expiresAt > now, state];
      }
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'set': {
        const ttl = msg.ttl ?? 60_000;
        state.data.set(msg.key, {
          value: msg.value,
          expiresAt: Date.now() + ttl,
        });
        return state;
      }
      case 'delete': {
        state.data.delete(msg.key);
        return state;
      }
      case 'cleanup': {
        const now = Date.now();
        for (const [key, entry] of state.data) {
          if (entry.expiresAt < now) {
            state.data.delete(key);
          }
        }
        return state;
      }
    }
  },
};
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxSize` | number | 1000 | Maximum number of entries |
| `defaultTtl` | number | 0 | Default TTL in ms (0 = no expiry) |
| `evictionPolicy` | 'lru' \| 'lfu' | 'lru' | Eviction strategy when full |

## Best Practices

1. **Use namespaced keys**: Prefix keys with a namespace to avoid collisions
   ```typescript
   await Cache.set(cache, 'users:123', userData);
   await Cache.set(cache, 'sessions:abc', sessionData);
   ```

2. **Set appropriate TTLs**: Match TTL to data freshness requirements
   ```typescript
   // Frequently changing data - short TTL
   await Cache.set(cache, 'prices:btc', price, { ttl: 5_000 });

   // Stable data - longer TTL
   await Cache.set(cache, 'config:features', features, { ttl: 3600_000 });
   ```

3. **Use getOrSet for compute-heavy operations**:
   ```typescript
   const result = await Cache.getOrSet(cache, key, async () => {
     return await expensiveComputation();
   });
   ```

## Related

- [Cache API](../api/cache.md) - Complete API reference
- [GenServer Concept](../concepts/genserver.md) - Understanding GenServers
