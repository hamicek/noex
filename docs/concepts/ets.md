# ETS (Erlang Term Storage)

ETS provides an in-memory key-value store inspired by Erlang's ETS module. Unlike Registry, which maps names to process references, ETS stores arbitrary typed data without any process binding. It supports multiple table types with different key/value semantics, pattern matching, atomic counters, and optional persistence.

## Overview

The ETS system offers:
- **Four table types** - set, ordered_set, bag, duplicate_bag
- **Typed storage** - Full generic `<K, V>` type safety
- **Pattern matching** - Glob patterns on keys, predicate filtering
- **Counter operations** - Atomic increment/decrement on numeric values
- **Ordered navigation** - first/last/next/prev traversal for ordered_set
- **Optional persistence** - Debounced writes via StorageAdapter with restore on start
- **Lightweight lifecycle** - Simple start/close without process overhead

```typescript
import { Ets } from 'noex';

// Create and start a typed table
const users = Ets.new<string, { name: string; age: number }>({
  name: 'users',
  type: 'set',
});
await users.start();

// CRUD operations
users.insert('u1', { name: 'Alice', age: 30 });
users.insert('u2', { name: 'Bob', age: 25 });

const alice = users.lookup('u1');         // { name: 'Alice', age: 30 }
const adults = users.select((_, u) => u.age >= 18);
const total = users.reduce((sum, _, u) => sum + u.age, 0);

await users.close();
```

## Table Types

ETS supports four table types, each with different key and value semantics:

### set (default)

Each key maps to exactly one value. Inserting with an existing key overwrites the previous value.

```typescript
const cache = Ets.new<string, Response>({ type: 'set' });
await cache.start();

cache.insert('api:/users', response1);
cache.insert('api:/users', response2); // overwrites response1
cache.lookup('api:/users');            // response2
```

**Internal structure:** `Map<K, V>` — O(1) insert, lookup, delete.

### ordered_set

Like `set`, but keys are maintained in sorted order. Supports navigation with `first()`, `last()`, `next()`, `prev()`.

```typescript
const leaderboard = Ets.new<number, string>({
  type: 'ordered_set',
});
await leaderboard.start();

leaderboard.insert(250, 'Alice');
leaderboard.insert(100, 'Bob');
leaderboard.insert(180, 'Charlie');

leaderboard.keys();    // [100, 180, 250] — sorted
leaderboard.first();   // { key: 100, value: 'Bob' }
leaderboard.last();    // { key: 250, value: 'Alice' }
leaderboard.next(100); // { key: 180, value: 'Charlie' }
```

**Internal structure:** Sorted array with binary search — O(log n) lookup, O(n) insert/delete.

**Custom comparator:**
```typescript
const byDate = Ets.new<Date, string>({
  type: 'ordered_set',
  keyComparator: (a, b) => a.getTime() - b.getTime(),
});
```

### bag

Duplicate keys are allowed, but each {key, value} pair must be unique. Useful for tagging and categorization.

```typescript
const tags = Ets.new<string, string>({ type: 'bag' });
await tags.start();

tags.insert('post:1', 'typescript');
tags.insert('post:1', 'ets');
tags.insert('post:1', 'typescript'); // ignored — duplicate {key, value}

tags.lookup('post:1'); // ['typescript', 'ets']
tags.deleteObject('post:1', 'ets'); // removes only 'ets'
```

**Internal structure:** `Map<K, V[]>` with equality checking on insert.

### duplicate_bag

Like `bag`, but allows fully duplicate {key, value} pairs. Useful for event logs or time-series data.

```typescript
const events = Ets.new<string, { ts: number; data: string }>({
  type: 'duplicate_bag',
});
await events.start();

events.insert('clicks', { ts: 1000, data: 'btn-a' });
events.insert('clicks', { ts: 1000, data: 'btn-a' }); // allowed — duplicates OK

events.lookup('clicks'); // both entries returned
```

**Internal structure:** `Map<K, V[]>` without deduplication.

## Pattern Matching

### select()

Filters entries using a predicate function:

```typescript
const expensive = products.select((_, p) => p.price > 100);
const active = users.select((_, u) => u.lastSeen > Date.now() - 3600000);
```

### match()

Glob-based key matching with optional value predicate:

```typescript
// All user keys
const allUsers = table.match('user:*');

// Users in a specific region with age filter
const filtered = table.match('user:eu:*', (_, u) => u.age >= 18);
```

Glob syntax:
- `*` — any characters except `/`
- `**` — any characters including `/`
- `?` — single character

### reduce()

Fold over all entries:

```typescript
const stats = metrics.reduce(
  (acc, key, value) => ({
    total: acc.total + value,
    count: acc.count + 1,
  }),
  { total: 0, count: 0 },
);
```

## Counter Operations

For `set`/`ordered_set` tables with numeric values, `updateCounter()` provides atomic increment/decrement:

```typescript
const counters = Ets.new<string, number>({ name: 'app-counters' });
await counters.start();

counters.updateCounter('requests', 1);   // 1
counters.updateCounter('requests', 1);   // 2
counters.updateCounter('errors', 1);     // 1
counters.updateCounter('requests', -1);  // 1

// Non-existent keys are initialized to the increment value
counters.updateCounter('new-metric', 5); // 5
```

## Persistence

ETS tables can optionally persist their state using the same `StorageAdapter` interface as Registry. Persistence is change-driven with configurable debouncing.

```typescript
import { Ets } from 'noex';
import { FileAdapter } from 'noex/persistence';

const table = Ets.new<string, number>({
  name: 'persistent-counters',
  persistence: {
    adapter: new FileAdapter({ dir: './data' }),
    debounceMs: 200,         // batch rapid changes
    restoreOnStart: true,    // load previous state
    persistOnShutdown: true, // flush on close()
    onError: (err) => console.error('Persistence failed:', err),
  },
});

await table.start();  // restores previous state if available
table.updateCounter('hits', 1);
await table.close();  // persists final state
```

**Persistence behavior:**
- `restoreOnStart` — on `start()`, loads entries from storage (default: `true`)
- `persistOnChange` — schedules debounced write after each mutation (default: `true`)
- `debounceMs` — batching window for rapid changes (default: `100`)
- `persistOnShutdown` — flushes state on `close()` (default: `true`)
- Errors are non-fatal — the table continues operating in-memory

## Use Cases

### Caching

```typescript
const cache = Ets.new<string, { data: unknown; expiresAt: number }>({
  name: 'api-cache',
  type: 'set',
});
await cache.start();

cache.insert('/users/1', { data: userData, expiresAt: Date.now() + 60000 });

// Evict expired entries
const expired = cache.select((_, entry) => entry.expiresAt < Date.now());
for (const { key } of expired) cache.delete(key);
```

### Metrics Collection

```typescript
const metrics = Ets.new<string, number>({ name: 'metrics' });
await metrics.start();

metrics.updateCounter('http.requests.total', 1);
metrics.updateCounter('http.requests.errors', 1);
metrics.updateCounter('http.requests.total', 1);

// Query all HTTP metrics
const httpMetrics = metrics.match('http.*');
```

### Sorted Leaderboard

```typescript
const scores = Ets.new<number, { player: string; timestamp: number }>({
  name: 'leaderboard',
  type: 'ordered_set',
});
await scores.start();

scores.insert(1500, { player: 'Alice', timestamp: Date.now() });
scores.insert(2100, { player: 'Bob', timestamp: Date.now() });

const topPlayer = scores.last();  // highest score
const bottomPlayer = scores.first(); // lowest score
```

### Event Tagging

```typescript
const tags = Ets.new<string, string>({ name: 'tags', type: 'bag' });
await tags.start();

tags.insert('post:42', 'javascript');
tags.insert('post:42', 'tutorial');
tags.insert('post:99', 'javascript');

// All posts tagged 'javascript'
const jsPosts = tags.select((_, tag) => tag === 'javascript');
```

## ETS vs Registry

| Feature | ETS | Registry |
|---------|-----|----------|
| Stores | Arbitrary typed data | Process references |
| Bound to processes | No | Yes (auto-cleanup on termination) |
| Key semantics | set, ordered_set, bag, duplicate_bag | unique, duplicate |
| Navigation | first/last/next/prev | No |
| Counter ops | updateCounter | No |
| Pattern matching | Glob + predicate | Glob + predicate |
| Persistence | Optional | Optional |
| Lifecycle | start/close | start/close |

**When to use ETS:** Application state, caches, metrics, configuration, any data not tied to a process lifecycle.

**When to use Registry:** Service discovery, named process lookup, pub/sub dispatch to processes.

## Elixir Comparison

| Elixir ETS | noex ETS |
|------------|----------|
| `:ets.new(:table, [:set])` | `Ets.new({ name: 'table', type: 'set' })` |
| `:ets.insert(tab, {key, val})` | `table.insert(key, val)` |
| `:ets.lookup(tab, key)` | `table.lookup(key)` |
| `:ets.delete(tab, key)` | `table.delete(key)` |
| `:ets.member(tab, key)` | `table.member(key)` |
| `:ets.tab2list(tab)` | `table.toArray()` |
| `:ets.select(tab, matchSpec)` | `table.select(predicate)` |
| `:ets.update_counter(tab, key, inc)` | `table.updateCounter(key, inc)` |
| `:ets.first(tab)` | `table.first()` |
| `:ets.last(tab)` | `table.last()` |
| `:ets.next(tab, key)` | `table.next(key)` |
| `:ets.prev(tab, key)` | `table.prev(key)` |
| `:ets.info(tab)` | `table.info()` |
| DETS (disk-based) | `persistence` option |

**Key differences from Elixir ETS:**
- Type-safe generics (`<K, V>`) instead of tuples
- `lookup()` returns the value directly, not a list of tuples
- `select()` uses predicate functions instead of match specifications
- Persistence is built-in via `StorageAdapter` (replaces DETS use case)
- No ownership model — tables are not tied to a process

## Related

- [ETS API Reference](../api/ets.md) - Complete method reference
- [Registry Concepts](./registry.md) - Process-bound named lookup
- [Elixir Comparison](./elixir-comparison.md) - Full OTP comparison
