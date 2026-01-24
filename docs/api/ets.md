# ETS API Reference

The `Ets` factory and `EtsTable` class provide an in-memory key-value store inspired by Erlang ETS. Unlike Registry, ETS is not bound to processes — it stores arbitrary typed data with configurable key semantics and optional persistence.

## Import

```typescript
import { Ets, EtsTable } from 'noex';
import type {
  EtsTableType,
  EtsOptions,
  EtsPersistenceConfig,
  EtsEntry,
  EtsPredicate,
  EtsMatchResult,
  EtsInfo,
} from 'noex';
import { EtsKeyNotFoundError, EtsCounterTypeError } from 'noex';
```

---

## Ets (Factory Facade)

The `Ets` object provides a clean namespace for creating typed ETS tables.

### new()

Creates a new ETS table instance.

```typescript
Ets.new<K, V>(options?: EtsOptions<K, V>): EtsTable<K, V>
```

**Parameters:**
- `options` - Optional table configuration
  - `name` - Human-readable name (auto-generated if omitted)
  - `type` - Table type: `'set'` | `'ordered_set'` | `'bag'` | `'duplicate_bag'` (default: `'set'`)
  - `keyComparator` - Custom comparator for `ordered_set` tables
  - `persistence` - Persistence configuration

**Returns:** A new `EtsTable<K, V>` instance (must call `start()` before use)

**Example:**
```typescript
const users = Ets.new<string, { name: string; age: number }>({
  name: 'users',
  type: 'set',
});
await users.start();
```

---

## EtsTable

The main table class providing CRUD, pattern matching, counter, and navigation operations.

### Table Types

| Type | Keys | Values | Use Case |
|------|------|--------|----------|
| `set` | Unique | One per key | General key-value store |
| `ordered_set` | Unique, sorted | One per key | Sorted data, range queries |
| `bag` | Duplicate | Unique per {key,value} | Tags, categories |
| `duplicate_bag` | Duplicate | All duplicates | Event logs, time series |

---

## Lifecycle

### start()

Initializes the table. Must be called before any operations. Restores persisted state if persistence is configured.

```typescript
async start(): Promise<void>
```

**Notes:**
- Idempotent — calling `start()` multiple times has no effect
- If persistence is configured with `restoreOnStart: true`, entries are loaded from storage

**Example:**
```typescript
const table = Ets.new<string, number>({ name: 'counters' });
await table.start();
```

---

### close()

Shuts down the table. After `close()`, no further operations are allowed. Flushes pending persistence if configured.

```typescript
async close(): Promise<void>
```

**Notes:**
- Idempotent — calling `close()` multiple times has no effect
- If persistence is configured with `persistOnShutdown: true`, state is flushed to storage

**Example:**
```typescript
await table.close();
// table.insert(...) will now throw
```

---

## CRUD Operations

### insert()

Inserts a key-value pair into the table.

```typescript
insert(key: K, value: V): void
```

**Behavior by table type:**
- `set` / `ordered_set`: Overwrites existing value for the key
- `bag`: Adds the entry only if this exact {key, value} pair doesn't exist
- `duplicate_bag`: Always adds the entry (duplicates allowed)

**Example:**
```typescript
table.insert('user:1', { name: 'Alice', age: 30 });
table.insert('user:1', { name: 'Alice Updated', age: 31 }); // overwrites in set
```

---

### insertMany()

Bulk inserts multiple key-value pairs.

```typescript
insertMany(entries: ReadonlyArray<readonly [K, V]>): void
```

**Example:**
```typescript
table.insertMany([
  ['key1', 'value1'],
  ['key2', 'value2'],
  ['key3', 'value3'],
]);
```

---

### lookup()

Looks up the value(s) for a key.

```typescript
lookup(key: K): V | V[] | undefined
```

**Returns by table type:**
- `set` / `ordered_set`: `V | undefined`
- `bag` / `duplicate_bag`: `V[]` (empty array if key not found)

**Example:**
```typescript
// set table
const user = table.lookup('user:1'); // { name: 'Alice', age: 30 } | undefined

// bag table
const tags = bagTable.lookup('post:1'); // ['typescript', 'ets']
```

---

### delete()

Deletes all entries for a key.

```typescript
delete(key: K): boolean
```

**Returns:** `true` if any entries were removed

**Example:**
```typescript
const removed = table.delete('user:1'); // true
```

---

### deleteObject()

Deletes a specific {key, value} pair. Uses strict equality (`===`) for value comparison.

```typescript
deleteObject(key: K, value: V): boolean
```

**Returns:** `true` if the entry was removed

**Notes:**
- For `bag`/`duplicate_bag`: removes only the matching entry, leaving others for the same key
- For `set`/`ordered_set`: behaves like `delete(key)` if the value matches

**Example:**
```typescript
// bag table with multiple values per key
bagTable.insert('tags', 'typescript');
bagTable.insert('tags', 'ets');
bagTable.deleteObject('tags', 'typescript'); // removes only 'typescript'
```

---

### member()

Checks if a key exists in the table.

```typescript
member(key: K): boolean
```

**Example:**
```typescript
if (table.member('user:1')) {
  // key exists
}
```

---

### size()

Returns the total number of entries. For bags, counts all entries across all keys.

```typescript
size(): number
```

---

### toArray()

Returns all entries as `[key, value]` tuples. For `ordered_set`, entries are in sorted order.

```typescript
toArray(): [K, V][]
```

---

### keys()

Returns all keys. For `ordered_set`, keys are in sorted order.

```typescript
keys(): K[]
```

---

### clear()

Removes all entries from the table.

```typescript
clear(): void
```

---

## Query & Pattern Matching

### select()

Filters entries by a predicate function.

```typescript
select(predicate: EtsPredicate<K, V>): EtsMatchResult<K, V>[]
```

**Parameters:**
- `predicate` - Function `(key: K, value: V) => boolean`

**Returns:** Array of `{ key, value }` for matching entries

**Example:**
```typescript
const adults = users.select((key, user) => user.age >= 18);
```

---

### match()

Matches entries by a glob pattern on keys, with optional value predicate.

```typescript
match(keyPattern: string, valuePredicate?: EtsPredicate<K, V>): EtsMatchResult<K, V>[]
```

**Glob syntax:**
- `*` matches any characters except `/`
- `**` matches any characters including `/`
- `?` matches a single character

**Example:**
```typescript
// All user entries
const userEntries = table.match('user:*');

// Users with age > 25
const filtered = table.match('user:*', (key, user) => user.age > 25);
```

---

### reduce()

Folds over all entries in the table.

```typescript
reduce<A>(fn: (accumulator: A, key: K, value: V) => A, initial: A): A
```

**Example:**
```typescript
const totalAge = users.reduce((sum, key, user) => sum + user.age, 0);
```

---

## Counter Operations

### updateCounter()

Atomically increments/decrements a numeric counter. Only valid for `set`/`ordered_set` tables.

```typescript
updateCounter(key: K, increment: number): number
```

**Returns:** The new counter value

**Notes:**
- If the key doesn't exist, initializes it to `increment`
- Only works on tables with numeric values

**Throws:**
- `EtsCounterTypeError` - If the existing value is not a number, or if called on a bag/duplicate_bag table

**Example:**
```typescript
const counters = Ets.new<string, number>({ name: 'counters' });
await counters.start();

counters.updateCounter('page_views', 1);  // 1
counters.updateCounter('page_views', 1);  // 2
counters.updateCounter('page_views', -1); // 1
```

---

## Ordered Set Navigation

These methods are only meaningful for `ordered_set` tables. For other types, `first()`/`last()` return an arbitrary entry.

### first()

Returns the first (smallest key) entry.

```typescript
first(): EtsMatchResult<K, V> | undefined
```

---

### last()

Returns the last (largest key) entry.

```typescript
last(): EtsMatchResult<K, V> | undefined
```

---

### next()

Returns the entry immediately after the given key.

```typescript
next(key: K): EtsMatchResult<K, V> | undefined
```

**Throws:**
- `EtsKeyNotFoundError` - If the key does not exist

---

### prev()

Returns the entry immediately before the given key.

```typescript
prev(key: K): EtsMatchResult<K, V> | undefined
```

**Throws:**
- `EtsKeyNotFoundError` - If the key does not exist

**Example:**
```typescript
const sorted = Ets.new<number, string>({ name: 'sorted', type: 'ordered_set' });
await sorted.start();

sorted.insert(10, 'ten');
sorted.insert(20, 'twenty');
sorted.insert(30, 'thirty');

sorted.first();    // { key: 10, value: 'ten' }
sorted.last();     // { key: 30, value: 'thirty' }
sorted.next(10);   // { key: 20, value: 'twenty' }
sorted.prev(30);   // { key: 20, value: 'twenty' }
sorted.next(30);   // undefined (no entry after last)
```

---

## Info

### info()

Returns runtime information about the table.

```typescript
info(): EtsInfo
```

**Returns:** `{ name: string; type: EtsTableType; size: number }`

---

## Error Classes

### EtsKeyNotFoundError

Thrown when `next()`/`prev()` is called with a key that doesn't exist in an ordered_set.

**Properties:**
- `name` - `'EtsKeyNotFoundError'`
- `tableName` - Name of the table
- `key` - The missing key

### EtsCounterTypeError

Thrown when `updateCounter()` is called on a non-numeric value or on a bag/duplicate_bag table.

**Properties:**
- `name` - `'EtsCounterTypeError'`
- `tableName` - Name of the table
- `key` - The key that caused the error

---

## Types

### EtsTableType

```typescript
type EtsTableType = 'set' | 'ordered_set' | 'bag' | 'duplicate_bag';
```

### EtsOptions

```typescript
interface EtsOptions<K, V> {
  readonly name?: string;
  readonly type?: EtsTableType;
  readonly keyComparator?: (a: K, b: K) => number;
  readonly persistence?: EtsPersistenceConfig;
}
```

### EtsPersistenceConfig

```typescript
interface EtsPersistenceConfig {
  readonly adapter: StorageAdapter;
  readonly key?: string;
  readonly restoreOnStart?: boolean;     // default: true
  readonly persistOnChange?: boolean;    // default: true
  readonly debounceMs?: number;          // default: 100
  readonly persistOnShutdown?: boolean;  // default: true
  readonly onError?: (error: Error) => void;
}
```

### EtsEntry

```typescript
interface EtsEntry<K, V> {
  readonly key: K;
  readonly value: V;
  readonly insertedAt: number;
}
```

### EtsPredicate

```typescript
type EtsPredicate<K, V> = (key: K, value: V) => boolean;
```

### EtsMatchResult

```typescript
interface EtsMatchResult<K, V> {
  readonly key: K;
  readonly value: V;
}
```

### EtsInfo

```typescript
interface EtsInfo {
  readonly name: string;
  readonly type: EtsTableType;
  readonly size: number;
}
```

---

## Complete Example

```typescript
import { Ets } from 'noex';

interface User {
  name: string;
  age: number;
  role: 'admin' | 'user';
}

async function main() {
  // Create a typed set table
  const users = Ets.new<string, User>({ name: 'users', type: 'set' });
  await users.start();

  // Insert data
  users.insert('u1', { name: 'Alice', age: 30, role: 'admin' });
  users.insert('u2', { name: 'Bob', age: 25, role: 'user' });
  users.insert('u3', { name: 'Charlie', age: 35, role: 'user' });

  // Query
  const admins = users.select((_, user) => user.role === 'admin');
  const totalAge = users.reduce((sum, _, user) => sum + user.age, 0);

  // Counters
  const metrics = Ets.new<string, number>({ name: 'metrics' });
  await metrics.start();
  metrics.updateCounter('requests', 1);
  metrics.updateCounter('requests', 1);

  // Ordered navigation
  const leaderboard = Ets.new<number, string>({
    name: 'scores',
    type: 'ordered_set',
  });
  await leaderboard.start();
  leaderboard.insert(100, 'Alice');
  leaderboard.insert(250, 'Bob');
  leaderboard.insert(180, 'Charlie');

  const top = leaderboard.last(); // { key: 250, value: 'Bob' }

  // Cleanup
  await users.close();
  await metrics.close();
  await leaderboard.close();
}
```

## Related

- [ETS Concepts](../concepts/ets.md) - Table types, use cases, patterns
- [Registry API](./registry.md) - Named process lookup (process-bound)
- [Persistence API](./persistence.md) - StorageAdapter interface
