# What is ETS?

You've learned how GenServer provides isolated state with message-passing semantics. But sometimes you need something simpler: a **fast, in-memory key-value store** that doesn't require the overhead of process communication. That's where ETS comes in.

ETS (Erlang Term Storage) is one of Erlang's most powerful built-in features — and noex brings this concept to TypeScript. It gives you concurrent-safe, typed key-value tables with four different storage modes.

## What You'll Learn

- What ETS is and how it differs from GenServer
- When to use ETS vs GenServer vs external databases
- Basic ETS operations (insert, lookup, delete)
- The four table types and their use cases

## From Erlang to TypeScript

In Erlang/OTP, ETS tables are battle-tested components used in production systems for decades. They provide:

- **In-process memory** — No network latency, no serialization
- **Constant-time lookups** — O(1) for most operations
- **Concurrent access** — Multiple processes can read simultaneously
- **Pattern matching** — Query data with expressive filters

noex's ETS implementation preserves these characteristics while adding TypeScript's type safety:

```typescript
import { Ets } from '@hamicek/noex';

// Create a typed ETS table
const users = Ets.new<string, { name: string; age: number }>({
  name: 'users',
  type: 'set',
});

await users.start();

// Insert with type checking
users.insert('u1', { name: 'Alice', age: 30 });
users.insert('u2', { name: 'Bob', age: 25 });

// Lookup returns properly typed value
const alice = users.lookup('u1');
// TypeScript knows: alice is { name: string; age: number } | undefined

console.log(alice?.name); // 'Alice'

await users.close();
```

## ETS vs GenServer

Both ETS and GenServer manage state, but they serve different purposes:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ETS vs GENSERVER                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  GENSERVER:                        ETS:                                     │
│  ┌───────────────────────┐         ┌───────────────────────┐               │
│  │      Process          │         │       Table           │               │
│  │   ┌─────────────┐     │         │   ┌─────────────┐     │               │
│  │   │    State    │     │         │   │  Key-Value  │     │               │
│  │   └─────────────┘     │         │   │   Entries   │     │               │
│  │   ┌─────────────┐     │         │   └─────────────┘     │               │
│  │   │   Mailbox   │     │         │                       │               │
│  │   └─────────────┘     │         │   Direct access       │               │
│  │   ┌─────────────┐     │         │   No message passing  │               │
│  │   │   Behavior  │     │         │   No callbacks        │               │
│  │   └─────────────┘     │         │                       │               │
│  └───────────────────────┘         └───────────────────────┘               │
│                                                                             │
│  Messages → Process → State        Direct Read/Write to Table               │
│  Sequential processing             Concurrent access                        │
│  Complex state logic               Simple key-value storage                 │
│  Supervision integration           No supervision                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### When to Use ETS

Use ETS when you need:

1. **Fast lookups** — Cache data for quick retrieval
2. **Shared data** — Multiple parts of your app read the same data
3. **Simple structure** — Key-value pairs without complex logic
4. **No process overhead** — Direct access without message passing

```typescript
// Good ETS use case: Session cache
const sessions = Ets.new<string, { userId: string; expiresAt: number }>({
  name: 'sessions',
  type: 'set',
});

// Fast lookup in request handler
function getSession(sessionId: string) {
  const session = sessions.lookup(sessionId);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}
```

### When to Use GenServer

Use GenServer when you need:

1. **Complex state logic** — Business rules, validations, computations
2. **Sequential processing** — Operations that must happen in order
3. **Supervision** — Automatic restart on failure
4. **Message-based communication** — Request/response patterns

```typescript
// Good GenServer use case: Order processing
const orderBehavior: GenServerBehavior<OrderState, OrderCall, OrderCast, OrderReply> = {
  init: () => ({ orders: new Map(), processingQueue: [] }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'submit': {
        // Complex validation logic
        if (!validateOrder(msg.order)) {
          return [state, { ok: false, error: 'invalid_order' }];
        }
        // State transition with business rules
        const newState = processSubmission(state, msg.order);
        return [newState, { ok: true, orderId: msg.order.id }];
      }
      // ... more complex handlers
    }
  },

  handleCast: (msg, state) => {
    // Background processing logic
    return processQueue(state);
  },
};
```

## Basic Operations

ETS provides a straightforward API for key-value operations:

### Insert and Lookup

```typescript
const cache = Ets.new<string, number>({ name: 'cache', type: 'set' });
await cache.start();

// Insert a value
cache.insert('counter', 42);

// Lookup returns the value or undefined
const value = cache.lookup('counter'); // 42
const missing = cache.lookup('nonexistent'); // undefined

// Check if key exists
const exists = cache.member('counter'); // true
```

### Delete

```typescript
// Delete by key
const deleted = cache.delete('counter'); // true if existed

// Delete specific key-value pair (useful for bag types)
cache.insert('key', 'value1');
cache.deleteObject('key', 'value1'); // Only deletes if value matches
```

### Bulk Operations

```typescript
// Insert multiple entries
cache.insertMany([
  ['a', 1],
  ['b', 2],
  ['c', 3],
]);

// Get all entries
const entries = cache.toArray(); // [['a', 1], ['b', 2], ['c', 3]]

// Get all keys
const keys = cache.keys(); // ['a', 'b', 'c']

// Get table size
const size = cache.size(); // 3

// Clear all entries
cache.clear();
```

### Query and Filter

```typescript
const users = Ets.new<string, { name: string; role: string }>({
  name: 'users',
  type: 'set',
});
await users.start();

users.insertMany([
  ['u1', { name: 'Alice', role: 'admin' }],
  ['u2', { name: 'Bob', role: 'user' }],
  ['u3', { name: 'Charlie', role: 'admin' }],
]);

// Filter with predicate
const admins = users.select((key, value) => value.role === 'admin');
// [{ key: 'u1', value: { name: 'Alice', role: 'admin' } },
//  { key: 'u3', value: { name: 'Charlie', role: 'admin' } }]

// Match keys with glob patterns
users.insert('admin:root', { name: 'Root', role: 'superadmin' });
const adminKeys = users.match('admin:*');
// [{ key: 'admin:root', value: { name: 'Root', role: 'superadmin' } }]

// Reduce over all entries
const count = users.reduce((acc, key, value) => acc + 1, 0); // 4
```

### Counter Operations

For numeric values, ETS provides atomic counter updates:

```typescript
const counters = Ets.new<string, number>({ name: 'counters', type: 'set' });
await counters.start();

// Initialize or increment atomically
counters.updateCounter('page_views', 1);  // 1 (initialized)
counters.updateCounter('page_views', 1);  // 2
counters.updateCounter('page_views', 10); // 12

// Decrement
counters.updateCounter('balance', -50); // -50 (initialized to negative)
```

## Decision Guide: ETS vs GenServer vs Database

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CHOOSING THE RIGHT STORAGE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────┐                                    │
│  │  Do you need data to survive        │                                    │
│  │  application restart?               │                                    │
│  └─────────────────┬───────────────────┘                                    │
│                    │                                                        │
│          ┌────────┴────────┐                                               │
│          ▼                 ▼                                                │
│         YES                NO                                               │
│          │                  │                                               │
│          ▼                  ▼                                               │
│    ┌────────────┐    ┌─────────────────────────────────────┐               │
│    │  Database  │    │  Is there complex state logic?      │               │
│    │  or ETS    │    └─────────────────┬───────────────────┘               │
│    │  with      │                      │                                    │
│    │persistence │          ┌──────────┴──────────┐                          │
│    └────────────┘          ▼                     ▼                          │
│                           YES                    NO                         │
│                            │                      │                         │
│                            ▼                      ▼                         │
│                      ┌──────────┐          ┌──────────┐                     │
│                      │GenServer │          │   ETS    │                     │
│                      └──────────┘          └──────────┘                     │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  QUICK REFERENCE:                                                           │
│                                                                             │
│  Use ETS for:                                                               │
│    • Caches (session, API response, computed values)                        │
│    • Lookup tables (configuration, feature flags)                           │
│    • Counters and metrics                                                   │
│    • Temporary storage during processing                                    │
│                                                                             │
│  Use GenServer for:                                                         │
│    • Domain entities with behavior (User, Order, Game)                      │
│    • Workflow state machines                                                │
│    • Rate limiters with complex rules                                       │
│    • Anything needing supervision                                           │
│                                                                             │
│  Use Database for:                                                          │
│    • Permanent business data                                                │
│    • Data shared across application instances                               │
│    • Audit trails and compliance                                            │
│    • Data that must survive crashes                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Table Lifecycle

ETS tables have a simple lifecycle:

```typescript
// 1. Create the table
const table = Ets.new<string, number>({ name: 'my-table', type: 'set' });

// 2. Start (required if using persistence, optional otherwise)
await table.start();

// 3. Use the table
table.insert('key', 123);
const value = table.lookup('key');

// 4. Close when done (flushes persistence, prevents further operations)
await table.close();

// After close, operations throw an error
table.insert('key', 456); // Error: ETS table 'my-table' is closed.
```

## Table Information

Get runtime metadata about a table:

```typescript
const table = Ets.new<string, number>({
  name: 'metrics',
  type: 'ordered_set',
});

table.insertMany([
  ['cpu', 45],
  ['memory', 78],
  ['disk', 23],
]);

const info = table.info();
// {
//   name: 'metrics',
//   type: 'ordered_set',
//   size: 3
// }
```

## Example: API Response Cache

Here's a practical example combining several ETS features:

```typescript
import { Ets } from '@hamicek/noex';

interface CachedResponse {
  data: unknown;
  cachedAt: number;
  ttlMs: number;
}

// Create cache table
const responseCache = Ets.new<string, CachedResponse>({
  name: 'api-response-cache',
  type: 'set',
});

await responseCache.start();

// Cache a response
function cacheResponse(url: string, data: unknown, ttlMs = 60000) {
  responseCache.insert(url, {
    data,
    cachedAt: Date.now(),
    ttlMs,
  });
}

// Get cached response (with TTL check)
function getCachedResponse(url: string): unknown | null {
  const cached = responseCache.lookup(url);

  if (!cached) {
    return null;
  }

  // Check if expired
  if (Date.now() > cached.cachedAt + cached.ttlMs) {
    responseCache.delete(url);
    return null;
  }

  return cached.data;
}

// Clean up expired entries
function cleanExpiredEntries() {
  const now = Date.now();
  const expired = responseCache.select(
    (key, value) => now > value.cachedAt + value.ttlMs
  );

  for (const entry of expired) {
    responseCache.delete(entry.key);
  }

  return expired.length;
}

// Usage
cacheResponse('/api/users', [{ id: 1, name: 'Alice' }], 30000);

const data = getCachedResponse('/api/users'); // Returns cached data
// ... 30 seconds later ...
const stale = getCachedResponse('/api/users'); // Returns null (expired)

// Periodic cleanup
setInterval(() => {
  const cleaned = cleanExpiredEntries();
  console.log(`Cleaned ${cleaned} expired cache entries`);
}, 60000);
```

## Summary

**Key takeaways:**

- **ETS is a fast, in-memory key-value store** — Inspired by Erlang's battle-tested ETS tables
- **Direct access, no message passing** — Faster than GenServer for simple lookups
- **Four table types** — `set`, `ordered_set`, `bag`, `duplicate_bag` (covered in next chapter)
- **Rich query API** — Filter with predicates, match with glob patterns, reduce over entries
- **Atomic counters** — `updateCounter()` for safe increment/decrement operations
- **Type-safe** — Full TypeScript generics for keys and values

**When to use ETS:**

| Use Case | Why ETS |
|----------|---------|
| Session cache | Fast lookups, simple key-value |
| Feature flags | Read-heavy, rarely changes |
| Rate limiting buckets | Counter operations |
| Lookup tables | Static data, fast access |
| Temporary storage | Processing buffers |

**Remember:**

> ETS is for **data storage**. GenServer is for **data + behavior**. If your state needs logic beyond CRUD, use GenServer.

---

Next: [Table Types](./02-table-types.md)
