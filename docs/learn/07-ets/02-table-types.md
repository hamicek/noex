# Table Types

ETS provides four distinct table types, each designed for different data organization needs. Choosing the right type is crucial for both correctness and performance. In this chapter, you'll learn when and how to use each type.

## What You'll Learn

- The four ETS table types and their semantics
- How keys and values are stored in each type
- When to use each type for optimal results
- Navigation operations exclusive to `ordered_set`

## Quick Reference

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ETS TABLE TYPES                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  TYPE            KEYS       VALUES PER KEY    DUPLICATES    ORDERING        │
│  ─────────────   ────────   ──────────────    ──────────    ────────        │
│  set             unique     one               no            unordered       │
│  ordered_set     unique     one               no            sorted          │
│  bag             allowed    multiple          unique only   unordered       │
│  duplicate_bag   allowed    multiple          allowed       unordered       │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  LOOKUP BEHAVIOR:                                                           │
│  • set / ordered_set:  lookup(key) → V | undefined                          │
│  • bag / duplicate_bag: lookup(key) → V[] (empty array if not found)        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## set — The Default

The `set` type is the simplest and most commonly used. Each key maps to exactly one value, and inserting with an existing key overwrites the previous value.

**Characteristics:**
- Unique keys (like JavaScript `Map`)
- O(1) lookup, insert, and delete
- Insertion order is not preserved

```typescript
import { Ets } from '@hamicek/noex';

// Create a set table (default type)
const users = Ets.new<string, { name: string; email: string }>({
  name: 'users',
  type: 'set', // optional, 'set' is the default
});

await users.start();

// Insert entries
users.insert('u1', { name: 'Alice', email: 'alice@example.com' });
users.insert('u2', { name: 'Bob', email: 'bob@example.com' });

// Lookup returns single value or undefined
const alice = users.lookup('u1');
// { name: 'Alice', email: 'alice@example.com' }

const missing = users.lookup('u99');
// undefined

// Overwrite existing key
users.insert('u1', { name: 'Alice Smith', email: 'alice.smith@example.com' });
console.log(users.lookup('u1')?.name); // 'Alice Smith'

// Size reflects unique keys
console.log(users.size()); // 2
```

### When to Use `set`

- **Key-value caches** — Session data, API responses, configuration
- **Entity storage** — Users, products, orders indexed by ID
- **Lookup tables** — Any 1:1 mapping where you need fast access by key
- **Default choice** — When in doubt, start with `set`

```typescript
// Example: Session cache
interface Session {
  userId: string;
  createdAt: number;
  expiresAt: number;
  data: Record<string, unknown>;
}

const sessions = Ets.new<string, Session>({
  name: 'sessions',
  type: 'set',
});

// Store session by token
sessions.insert(sessionToken, {
  userId: 'u123',
  createdAt: Date.now(),
  expiresAt: Date.now() + 3600000, // 1 hour
  data: { preferences: { theme: 'dark' } },
});

// Fast lookup on every request
const session = sessions.lookup(sessionToken);
```

## ordered_set — Sorted Keys

The `ordered_set` type maintains keys in sorted order, enabling efficient range queries and sequential navigation. Like `set`, each key maps to one value.

**Characteristics:**
- Unique keys in sorted order
- O(log n) lookup, insert, and delete (binary search)
- Supports `first()`, `last()`, `next(key)`, `prev(key)` navigation
- Custom comparator support for non-default ordering

```typescript
import { Ets } from '@hamicek/noex';

// String keys are sorted lexicographically by default
const leaderboard = Ets.new<string, number>({
  name: 'leaderboard',
  type: 'ordered_set',
});

await leaderboard.start();

// Insert in any order
leaderboard.insert('charlie', 85);
leaderboard.insert('alice', 95);
leaderboard.insert('bob', 90);

// toArray() and keys() return sorted results
console.log(leaderboard.keys());
// ['alice', 'bob', 'charlie']

console.log(leaderboard.toArray());
// [['alice', 95], ['bob', 90], ['charlie', 85]]
```

### Navigation Operations

`ordered_set` provides unique navigation methods for traversing entries in order:

```typescript
// Navigation methods (ordered_set only)
const scores = Ets.new<string, number>({
  name: 'scores',
  type: 'ordered_set',
});

scores.insertMany([
  ['d', 4],
  ['b', 2],
  ['e', 5],
  ['a', 1],
  ['c', 3],
]);

// Get first and last entries
console.log(scores.first()); // { key: 'a', value: 1 }
console.log(scores.last());  // { key: 'e', value: 5 }

// Navigate from a key
console.log(scores.next('b')); // { key: 'c', value: 3 }
console.log(scores.prev('d')); // { key: 'c', value: 3 }

// Edge cases
console.log(scores.next('e')); // undefined (no next after last)
console.log(scores.prev('a')); // undefined (no prev before first)

// Throws EtsKeyNotFoundError for non-existent keys
try {
  scores.next('missing');
} catch (err) {
  console.log(err.message);
  // "Key 'missing' not found in ETS table 'scores'."
}
```

### Custom Comparator

For numeric keys or custom sorting logic, provide a `keyComparator`:

```typescript
// Numeric keys with natural ordering
const timestamps = Ets.new<number, string>({
  name: 'events',
  type: 'ordered_set',
  keyComparator: (a, b) => a - b,
});

timestamps.insert(1706000000000, 'Event A');
timestamps.insert(1705000000000, 'Event B');
timestamps.insert(1707000000000, 'Event C');

// Keys are now sorted numerically
console.log(timestamps.keys());
// [1705000000000, 1706000000000, 1707000000000]

// Get earliest event
console.log(timestamps.first());
// { key: 1705000000000, value: 'Event B' }
```

### When to Use `ordered_set`

- **Time-series data** — Events sorted by timestamp
- **Leaderboards** — Scores that need ranking
- **Range queries** — Finding entries within a range
- **Iteration in order** — When you need to process entries sequentially
- **Priority queues** — Items sorted by priority

```typescript
// Example: Rate limit sliding window
const requestTimes = Ets.new<number, string>({
  name: 'rate-limit-window',
  type: 'ordered_set',
  keyComparator: (a, b) => a - b,
});

// Record request timestamps
function recordRequest(userId: string): void {
  requestTimes.insert(Date.now(), userId);
}

// Count requests in last minute
function countRecentRequests(): number {
  const oneMinuteAgo = Date.now() - 60000;
  return requestTimes.select((timestamp) => timestamp > oneMinuteAgo).length;
}

// Clean old entries (navigate from first until recent)
function cleanOldEntries(): void {
  const oneMinuteAgo = Date.now() - 60000;
  let entry = requestTimes.first();

  while (entry && entry.key < oneMinuteAgo) {
    requestTimes.delete(entry.key);
    entry = requestTimes.first();
  }
}
```

## bag — Multiple Values, No Duplicates

The `bag` type allows multiple values per key, but ensures each `{key, value}` pair is unique. Think of it as a `Map<K, Set<V>>`.

**Characteristics:**
- Duplicate keys allowed
- Each `{key, value}` pair is unique (adding same pair twice is a no-op)
- `lookup()` returns `V[]` array
- Useful for one-to-many relationships

```typescript
import { Ets } from '@hamicek/noex';

// Track user roles (users can have multiple roles)
const userRoles = Ets.new<string, string>({
  name: 'user-roles',
  type: 'bag',
});

await userRoles.start();

// Assign roles to users
userRoles.insert('alice', 'admin');
userRoles.insert('alice', 'editor');
userRoles.insert('bob', 'viewer');

// lookup() returns array of values
console.log(userRoles.lookup('alice'));
// ['admin', 'editor']

console.log(userRoles.lookup('bob'));
// ['viewer']

console.log(userRoles.lookup('missing'));
// [] (empty array for missing key)

// Duplicate pair is ignored
userRoles.insert('alice', 'admin'); // no-op, already exists
console.log(userRoles.lookup('alice'));
// ['admin', 'editor'] (no duplicate 'admin')

// Different value for same key is added
userRoles.insert('alice', 'moderator');
console.log(userRoles.lookup('alice'));
// ['admin', 'editor', 'moderator']
```

### Deletion in Bags

```typescript
// delete(key) removes all values for the key
userRoles.delete('alice');
console.log(userRoles.lookup('alice')); // []

// deleteObject(key, value) removes only that specific pair
userRoles.insert('bob', 'editor');
userRoles.insert('bob', 'viewer');
console.log(userRoles.lookup('bob')); // ['viewer', 'editor']

userRoles.deleteObject('bob', 'viewer');
console.log(userRoles.lookup('bob')); // ['editor']

// Removing last value removes the key
userRoles.deleteObject('bob', 'editor');
console.log(userRoles.member('bob')); // false
```

### When to Use `bag`

- **Tagging systems** — Items with multiple unique tags
- **Role assignments** — Users with multiple distinct roles
- **Category mappings** — Products in multiple categories
- **Graph edges** — Node connections where each edge is unique

```typescript
// Example: Product tags
interface Product {
  id: string;
  name: string;
}

const productTags = Ets.new<string, string>({
  name: 'product-tags',
  type: 'bag',
});

// Tag products
productTags.insert('laptop-001', 'electronics');
productTags.insert('laptop-001', 'computers');
productTags.insert('laptop-001', 'sale');

// Find all tags for a product
const tags = productTags.lookup('laptop-001');
// ['electronics', 'computers', 'sale']

// Find all products with a specific tag
const saleItems = productTags.select(
  (_productId, tag) => tag === 'sale'
);
```

## duplicate_bag — Full Duplicates Allowed

The `duplicate_bag` type is the most permissive — it allows multiple identical `{key, value}` pairs. Think of it as a `Map<K, V[]>` where the array can contain duplicates.

**Characteristics:**
- Duplicate keys allowed
- Duplicate `{key, value}` pairs allowed
- `lookup()` returns `V[]` array with possible duplicates
- Useful for event logs, counters, and audit trails

```typescript
import { Ets } from '@hamicek/noex';

// Track all click events (same event can occur multiple times)
const clickEvents = Ets.new<string, number>({
  name: 'clicks',
  type: 'duplicate_bag',
});

await clickEvents.start();

// Record clicks (same button, same timestamp possible)
clickEvents.insert('buy-button', Date.now());
clickEvents.insert('buy-button', Date.now());
clickEvents.insert('buy-button', Date.now());

// All entries are preserved
console.log(clickEvents.lookup('buy-button').length); // 3

// size() counts all entries
console.log(clickEvents.size()); // 3
```

### Deletion in Duplicate Bags

```typescript
const events = Ets.new<string, string>({
  name: 'events',
  type: 'duplicate_bag',
});

// Add duplicate events
events.insert('page:home', 'view');
events.insert('page:home', 'view');
events.insert('page:home', 'scroll');
events.insert('page:home', 'view');

console.log(events.lookup('page:home'));
// ['view', 'view', 'scroll', 'view']

// deleteObject removes only the FIRST matching entry
events.deleteObject('page:home', 'view');
console.log(events.lookup('page:home'));
// ['view', 'scroll', 'view'] (only one 'view' removed)

// delete(key) removes ALL entries for the key
events.delete('page:home');
console.log(events.size()); // 0
```

### When to Use `duplicate_bag`

- **Event logging** — Recording every occurrence of an event
- **Audit trails** — Tracking all actions including repeated ones
- **Time series** — Multiple data points at the same timestamp
- **Message queues** — Where duplicate messages are valid

```typescript
// Example: User activity log
interface ActivityEvent {
  action: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

const activityLog = Ets.new<string, ActivityEvent>({
  name: 'activity-log',
  type: 'duplicate_bag',
});

// Log all user activities (including duplicates)
function logActivity(userId: string, action: string, metadata?: Record<string, unknown>): void {
  activityLog.insert(userId, {
    action,
    timestamp: Date.now(),
    metadata,
  });
}

// User can perform same action multiple times
logActivity('u1', 'page_view', { page: '/home' });
logActivity('u1', 'page_view', { page: '/home' }); // duplicate is valid
logActivity('u1', 'click', { button: 'signup' });
logActivity('u1', 'page_view', { page: '/home' });

// Get full activity history
const userActivity = activityLog.lookup('u1');
console.log(userActivity.length); // 4 (all events preserved)

// Count specific actions
const pageViews = userActivity.filter(e => e.action === 'page_view').length;
console.log(pageViews); // 3
```

## Comparison: bag vs duplicate_bag

The key difference is how they handle repeated `{key, value}` pairs:

```typescript
// bag: unique pairs only
const bag = Ets.new<string, string>({ name: 'bag', type: 'bag' });
bag.insert('k', 'v');
bag.insert('k', 'v'); // ignored — pair exists
bag.insert('k', 'v'); // ignored — pair exists
console.log(bag.lookup('k')); // ['v'] — only one entry

// duplicate_bag: all pairs stored
const dupBag = Ets.new<string, string>({ name: 'dupbag', type: 'duplicate_bag' });
dupBag.insert('k', 'v');
dupBag.insert('k', 'v'); // stored
dupBag.insert('k', 'v'); // stored
console.log(dupBag.lookup('k')); // ['v', 'v', 'v'] — three entries
```

**Decision guide:**

| Scenario | Use |
|----------|-----|
| User has roles admin, editor, admin | `bag` → stores [admin, editor] |
| Log shows click, click, click events | `duplicate_bag` → stores all three |
| Product has tags A, B, A | `bag` → stores [A, B] |
| Counter increments +1, +1, +1 | `duplicate_bag` → stores all |

## Size and Counting

For `bag` and `duplicate_bag`, `size()` counts **all entries**, not unique keys:

```typescript
const bag = Ets.new<string, number>({ name: 'test', type: 'bag' });

bag.insert('a', 1);
bag.insert('a', 2);
bag.insert('a', 3);
bag.insert('b', 10);

console.log(bag.size()); // 4 (total entries)
console.log(bag.keys().length); // 2 (unique keys: 'a', 'b')
```

## Counter Operations and Table Types

`updateCounter()` only works with `set` and `ordered_set`:

```typescript
// ✅ Works with set/ordered_set
const counters = Ets.new<string, number>({ name: 'counters', type: 'set' });
counters.updateCounter('hits', 1);  // 1
counters.updateCounter('hits', 1);  // 2
counters.updateCounter('hits', 10); // 12

// ❌ Throws EtsCounterTypeError for bag types
const bagCounters = Ets.new<string, number>({ name: 'bag', type: 'bag' });
bagCounters.updateCounter('hits', 1); // Error!
```

If you need multiple counters per key, use a `bag` with manual aggregation:

```typescript
const multiCounters = Ets.new<string, number>({ name: 'multi', type: 'bag' });

// Add increments as separate entries
multiCounters.insert('metric', 1);
multiCounters.insert('metric', 5);
multiCounters.insert('metric', 3);

// Sum to get total
const total = multiCounters.lookup('metric').reduce((sum, val) => sum + val, 0);
console.log(total); // 9
```

## Type Selection Flowchart

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   CHOOSING AN ETS TABLE TYPE                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────┐                            │
│  │  Do you need multiple values per key?       │                            │
│  └──────────────────────┬──────────────────────┘                            │
│                         │                                                   │
│            ┌────────────┴────────────┐                                      │
│            ▼                         ▼                                      │
│           NO                        YES                                     │
│            │                         │                                      │
│            ▼                         ▼                                      │
│  ┌─────────────────────┐   ┌─────────────────────────────────┐              │
│  │ Need sorted keys?   │   │ Can same {key,value} repeat?    │              │
│  └──────────┬──────────┘   └──────────────┬──────────────────┘              │
│             │                             │                                 │
│      ┌──────┴──────┐               ┌──────┴──────┐                          │
│      ▼             ▼               ▼             ▼                          │
│     NO            YES             NO            YES                         │
│      │             │               │             │                          │
│      ▼             ▼               ▼             ▼                          │
│  ┌───────┐   ┌────────────┐   ┌───────┐   ┌──────────────┐                  │
│  │  set  │   │ ordered_set│   │  bag  │   │ duplicate_bag│                  │
│  └───────┘   └────────────┘   └───────┘   └──────────────┘                  │
│                                                                             │
│  EXAMPLES:                                                                  │
│  • User by ID           → set                                               │
│  • Events by timestamp  → ordered_set                                       │
│  • User roles           → bag (user can't have same role twice)             │
│  • Click events         → duplicate_bag (same click can repeat)             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Exercise: Multi-Tenant Permission System

Build a permission system that tracks which users have access to which resources. Users can have multiple permissions per resource, but each unique permission should only be stored once.

**Requirements:**
1. Track `{userId, resourceId} → permissions[]`
2. Each permission for a user-resource pair should be unique
3. Support checking if user has specific permission on resource
4. Support listing all permissions for a user across all resources
5. Support revoking specific permissions

**Starter code:**

```typescript
import { Ets } from '@hamicek/noex';

type Permission = 'read' | 'write' | 'delete' | 'admin';

// Choose the right table type!
const permissions = Ets.new<string, Permission>({
  name: 'permissions',
  type: '???', // Which type?
});

await permissions.start();

// Helper to create composite key
function makeKey(userId: string, resourceId: string): string {
  return `${userId}:${resourceId}`;
}

// Grant permission
function grant(userId: string, resourceId: string, permission: Permission): void {
  // TODO
}

// Revoke permission
function revoke(userId: string, resourceId: string, permission: Permission): boolean {
  // TODO
}

// Check if user has permission
function hasPermission(userId: string, resourceId: string, permission: Permission): boolean {
  // TODO
}

// Get all permissions for user on resource
function getPermissions(userId: string, resourceId: string): Permission[] {
  // TODO
}

// Get all user's permissions across all resources
function getAllUserPermissions(userId: string): Array<{ resourceId: string; permission: Permission }> {
  // TODO
}
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
import { Ets } from '@hamicek/noex';

type Permission = 'read' | 'write' | 'delete' | 'admin';

// Use 'bag' — multiple permissions per key, but each permission unique
const permissions = Ets.new<string, Permission>({
  name: 'permissions',
  type: 'bag',
});

await permissions.start();

function makeKey(userId: string, resourceId: string): string {
  return `${userId}:${resourceId}`;
}

function grant(userId: string, resourceId: string, permission: Permission): void {
  const key = makeKey(userId, resourceId);
  permissions.insert(key, permission);
  // bag type ensures same permission won't be added twice
}

function revoke(userId: string, resourceId: string, permission: Permission): boolean {
  const key = makeKey(userId, resourceId);
  return permissions.deleteObject(key, permission);
}

function hasPermission(userId: string, resourceId: string, permission: Permission): boolean {
  const key = makeKey(userId, resourceId);
  const perms = permissions.lookup(key) as Permission[];
  return perms.includes(permission);
}

function getPermissions(userId: string, resourceId: string): Permission[] {
  const key = makeKey(userId, resourceId);
  return permissions.lookup(key) as Permission[];
}

function getAllUserPermissions(userId: string): Array<{ resourceId: string; permission: Permission }> {
  // Match all keys starting with userId:
  const matches = permissions.match(`${userId}:*`);

  return matches.map(({ key, value }) => {
    const resourceId = (key as string).split(':')[1]!;
    return { resourceId, permission: value };
  });
}

// Test the system
grant('alice', 'doc-1', 'read');
grant('alice', 'doc-1', 'write');
grant('alice', 'doc-1', 'read'); // no-op, already exists
grant('alice', 'doc-2', 'read');
grant('bob', 'doc-1', 'read');

console.log(hasPermission('alice', 'doc-1', 'read'));  // true
console.log(hasPermission('alice', 'doc-1', 'delete')); // false

console.log(getPermissions('alice', 'doc-1'));
// ['read', 'write']

console.log(getAllUserPermissions('alice'));
// [
//   { resourceId: 'doc-1', permission: 'read' },
//   { resourceId: 'doc-1', permission: 'write' },
//   { resourceId: 'doc-2', permission: 'read' }
// ]

revoke('alice', 'doc-1', 'write');
console.log(getPermissions('alice', 'doc-1'));
// ['read']

await permissions.close();
```

**Why `bag`?**
- Multiple permissions per user-resource pair ✓
- Each permission should be unique (no duplicate "read" grants) ✓
- `duplicate_bag` would allow granting "read" multiple times
- `set`/`ordered_set` would only allow one permission per key

</details>

## Summary

**Key takeaways:**

- **`set`** — Default choice. Unique keys, one value each. Use for caches, entity storage, lookup tables.
- **`ordered_set`** — Like `set` but keys are sorted. Enables navigation (`first`, `last`, `next`, `prev`). Use for time-series, leaderboards, range queries.
- **`bag`** — Multiple values per key, but each `{key, value}` pair is unique. Use for roles, tags, categories.
- **`duplicate_bag`** — Multiple values per key, duplicates allowed. Use for event logs, audit trails, counters.

**Quick decision:**

| Question | Answer → Type |
|----------|---------------|
| Simple key-value cache? | `set` |
| Need sorted iteration? | `ordered_set` |
| Multiple unique values per key? | `bag` |
| Need to record every occurrence? | `duplicate_bag` |

**Remember:**

> `lookup()` behavior changes by type: `set`/`ordered_set` return `V | undefined`, while `bag`/`duplicate_bag` return `V[]`.

---

Next: [Practical Usage](./03-practical-usage.md)
