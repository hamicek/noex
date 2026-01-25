# Registry

When you start a GenServer, you get back a reference (ref) that you need to communicate with it. But what if another part of your application needs to talk to that server? Passing references around can become tedious and creates tight coupling.

**Registry** solves this by providing named process lookup. Instead of passing references, you register processes under well-known names and look them up when needed.

In this chapter, you'll learn why naming matters, how to register and look up processes, and when to use unique vs duplicate key modes.

## What You'll Learn

- Why naming processes matters for decoupling
- Using `Registry.register()` and `Registry.lookup()`
- The difference between `lookup()` and `whereis()`
- Unique vs duplicate key modes
- Automatic cleanup when processes terminate
- Creating isolated registry instances

## Why Name Processes?

Consider an application with multiple services:

```typescript
// Without Registry - tight coupling
async function main() {
  const logger = await GenServer.start(loggerBehavior);
  const cache = await GenServer.start(cacheBehavior);
  const userService = await GenServer.start(userServiceBehavior);

  // Every component needs explicit references
  await processRequest(logger, cache, userService);
  await handleWebhook(logger, cache);
  await runBackgroundJob(logger, userService);
}

// References must be passed everywhere
async function processRequest(
  logger: GenServerRef,
  cache: GenServerRef,
  userService: GenServerRef,
) {
  // ...
}
```

This becomes unwieldy as your application grows. Every function needs to know about every service it might need.

With Registry, services can be looked up by name:

```typescript
// With Registry - loose coupling
async function main() {
  const logger = await GenServer.start(loggerBehavior);
  Registry.register('logger', logger);

  const cache = await GenServer.start(cacheBehavior);
  Registry.register('cache', cache);

  const userService = await GenServer.start(userServiceBehavior);
  Registry.register('users', userService);

  // Components look up what they need
  await processRequest();
  await handleWebhook();
  await runBackgroundJob();
}

async function processRequest() {
  const logger = Registry.lookup('logger');
  const cache = Registry.lookup('cache');
  const users = Registry.lookup('users');
  // ...
}
```

### Benefits of Named Processes

1. **Decoupling**: Components don't need to know how services are created or where they come from
2. **Testability**: Easily swap implementations by registering mocks under the same name
3. **Discoverability**: Well-known names document your service architecture
4. **Hot swapping**: Replace a service by unregistering the old one and registering a new one

## Registering Processes

Use `Registry.register()` to associate a name with a process reference:

```typescript
import { GenServer, Registry, type GenServerBehavior } from '@hamicek/noex';

interface CounterState {
  value: number;
}

type CallMsg = { type: 'get' } | { type: 'increment' };
type CastMsg = never;
type Reply = number;

const counterBehavior: GenServerBehavior<CounterState, CallMsg, CastMsg, Reply> = {
  init() {
    return { value: 0 };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.value, state];
      case 'increment':
        const newValue = state.value + 1;
        return [newValue, { value: newValue }];
    }
  },

  handleCast(_msg, state) {
    return state;
  },
};

async function main() {
  // Start the server
  const ref = await GenServer.start(counterBehavior);

  // Register it under a name
  Registry.register('counter', ref);

  console.log('Counter registered');

  // ... use it elsewhere
}
```

### Registration Rules

1. **Names must be unique**: Registering a name that's already taken throws `AlreadyRegisteredError`
2. **One registration per process**: A process can only be registered under one name in the default registry
3. **Automatic cleanup**: When a process terminates, its registration is automatically removed

```typescript
import { AlreadyRegisteredError } from '@hamicek/noex';

const server1 = await GenServer.start(behavior);
Registry.register('myService', server1);

const server2 = await GenServer.start(behavior);

try {
  Registry.register('myService', server2); // Throws!
} catch (error) {
  if (error instanceof AlreadyRegisteredError) {
    console.log(`Name '${error.name}' is already taken`);
  }
}
```

## Looking Up Processes

### lookup() - Throws on Missing

`Registry.lookup()` returns the registered reference or throws if not found:

```typescript
import { Registry, GenServer, NotRegisteredError } from '@hamicek/noex';

try {
  const counter = Registry.lookup('counter');
  const value = await GenServer.call(counter, { type: 'get' });
  console.log('Counter value:', value);
} catch (error) {
  if (error instanceof NotRegisteredError) {
    console.log(`Service '${error.processName}' is not available`);
  }
}
```

Use `lookup()` when the service **must exist** - if it's missing, that's a bug that should fail loudly.

### whereis() - Returns undefined

`Registry.whereis()` returns the reference or `undefined` if not found:

```typescript
const counter = Registry.whereis('counter');

if (counter) {
  const value = await GenServer.call(counter, { type: 'get' });
  console.log('Counter value:', value);
} else {
  console.log('Counter not available, using fallback');
  // Handle gracefully
}
```

Use `whereis()` when the service is **optional** - your code can handle its absence.

### Type Parameters

Both methods accept type parameters for proper typing:

```typescript
// Fully typed lookup
const counter = Registry.lookup<CounterState, CallMsg, CastMsg, Reply>('counter');

// Now TypeScript knows the types
const value = await GenServer.call(counter, { type: 'get' }); // Reply type
```

## Checking and Listing Registrations

```typescript
// Check if a name is registered
if (Registry.isRegistered('counter')) {
  console.log('Counter is available');
}

// Get all registered names
const names = Registry.getNames();
console.log('Registered services:', names);
// ['counter', 'logger', 'cache']

// Get the count of registrations
console.log(`${Registry.count()} services registered`);
```

## Unregistering Processes

You can manually unregister a process:

```typescript
// Remove the registration (process keeps running)
Registry.unregister('counter');

// Now the name is available for re-registration
const newCounter = await GenServer.start(counterBehavior);
Registry.register('counter', newCounter);
```

### Automatic Cleanup

When a process terminates, its registration is automatically removed:

```typescript
const server = await GenServer.start(behavior);
Registry.register('myService', server);

console.log(Registry.isRegistered('myService')); // true

await GenServer.stop(server);

console.log(Registry.isRegistered('myService')); // false (auto-cleaned)
```

This prevents stale references from accumulating and ensures lookups never return dead processes.

## Unique vs Duplicate Keys

The default global Registry uses **unique** key mode - each name maps to exactly one process. But when you create custom registry instances, you can choose **duplicate** key mode for pub/sub patterns.

### Unique Mode (Default)

One entry per key. Registration fails if the key is already taken.

```typescript
const services = Registry.create<{ version: string }>({
  name: 'services',
  keys: 'unique', // default
});
await services.start();

services.register('auth', authRef, { version: '2.0' });
services.register('auth', anotherRef); // Throws AlreadyRegisteredKeyError!

const entry = services.lookup('auth');
console.log(entry.ref, entry.metadata.version);
```

### Duplicate Mode (Pub/Sub)

Multiple entries per key. Useful for event subscriptions:

```typescript
const topics = Registry.create({
  name: 'topics',
  keys: 'duplicate',
});
await topics.start();

// Multiple handlers for the same event
topics.register('user:created', emailHandler);
topics.register('user:created', analyticsHandler);
topics.register('user:created', welcomeHandler);

// Dispatch to all handlers
topics.dispatch('user:created', { userId: 123, email: 'user@example.com' });
```

### dispatch() - Broadcasting Messages

In duplicate mode, `dispatch()` sends a message to all entries under a key:

```typescript
// Default behavior: GenServer.cast to each entry
topics.dispatch('order:placed', orderData);

// Custom dispatch function for more control
topics.dispatch('order:placed', orderData, (entries, message) => {
  // Round-robin, weighted routing, etc.
  const selected = entries[Math.floor(Math.random() * entries.length)];
  GenServer.cast(selected.ref, message);
});
```

### lookupAll() - Getting All Entries

In duplicate mode, use `lookupAll()` instead of `lookup()`:

```typescript
const handlers = topics.lookupAll('user:created');
console.log(`${handlers.length} handlers registered for user:created`);

for (const entry of handlers) {
  console.log(`Handler: ${entry.ref.id}`);
}
```

## Pattern Matching

Custom registry instances support glob-style pattern matching:

```typescript
const registry = Registry.create<{ role: string }>({
  name: 'workers',
  keys: 'unique',
});
await registry.start();

registry.register('worker:us-east:1', workerA, { role: 'processor' });
registry.register('worker:us-east:2', workerB, { role: 'processor' });
registry.register('worker:eu-west:1', workerC, { role: 'processor' });
registry.register('manager:us-east', managerA, { role: 'coordinator' });

// Match all US East workers
const usEastWorkers = registry.match('worker:us-east:*');
console.log(`Found ${usEastWorkers.length} US East workers`);

// Match all workers globally
const allWorkers = registry.match('worker:**');

// Match with value predicate
const processors = registry.match('*', (entry) => entry.metadata.role === 'processor');
```

Pattern syntax:
- `*` matches any characters except `:`
- `**` matches any characters including `:`
- `?` matches a single character

## Complete Example

Here's a practical example showing Registry used in a multi-service application:

```typescript
// services.ts
import { GenServer, Registry, type GenServerBehavior } from '@hamicek/noex';

// Logger Service
interface LoggerState {
  logs: string[];
}

type LoggerCall = { type: 'getLogs' };
type LoggerCast = { type: 'log'; level: string; message: string };
type LoggerReply = string[];

const loggerBehavior: GenServerBehavior<LoggerState, LoggerCall, LoggerCast, LoggerReply> = {
  init() {
    return { logs: [] };
  },

  handleCall(msg, state) {
    if (msg.type === 'getLogs') {
      return [state.logs, state];
    }
    return [[], state];
  },

  handleCast(msg, state) {
    if (msg.type === 'log') {
      const entry = `[${msg.level.toUpperCase()}] ${new Date().toISOString()}: ${msg.message}`;
      console.log(entry);
      return { logs: [...state.logs, entry] };
    }
    return state;
  },
};

// Counter Service
interface CounterState {
  value: number;
}

type CounterCall = { type: 'get' } | { type: 'incrementBy'; n: number };
type CounterCast = { type: 'increment' } | { type: 'decrement' };
type CounterReply = number;

const counterBehavior: GenServerBehavior<CounterState, CounterCall, CounterCast, CounterReply> = {
  init() {
    // Log initialization via Registry lookup
    const logger = Registry.whereis('logger');
    if (logger) {
      GenServer.cast(logger, { type: 'log', level: 'info', message: 'Counter initialized' });
    }
    return { value: 0 };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.value, state];
      case 'incrementBy':
        const newValue = state.value + msg.n;
        return [newValue, { value: newValue }];
    }
  },

  handleCast(msg, state) {
    const logger = Registry.whereis('logger');

    switch (msg.type) {
      case 'increment': {
        const newValue = state.value + 1;
        if (logger) {
          GenServer.cast(logger, {
            type: 'log',
            level: 'debug',
            message: `Counter incremented to ${newValue}`,
          });
        }
        return { value: newValue };
      }
      case 'decrement': {
        const newValue = state.value - 1;
        if (logger) {
          GenServer.cast(logger, {
            type: 'log',
            level: 'debug',
            message: `Counter decremented to ${newValue}`,
          });
        }
        return { value: newValue };
      }
    }
  },
};

async function main() {
  // Start and register logger first (other services depend on it)
  const logger = await GenServer.start(loggerBehavior);
  Registry.register('logger', logger);

  // Start and register counter (uses logger in init)
  const counter = await GenServer.start(counterBehavior);
  Registry.register('counter', counter);

  // Now any part of the app can use these services
  await simulateRequests();

  // Check logs
  const loggerRef = Registry.lookup<LoggerState, LoggerCall, LoggerCast, LoggerReply>('logger');
  const logs = await GenServer.call(loggerRef, { type: 'getLogs' });
  console.log('\n--- All Logs ---');
  logs.forEach((log) => console.log(log));

  // Cleanup
  await GenServer.stop(counter);
  await GenServer.stop(logger);
}

async function simulateRequests() {
  // This function doesn't need any references passed to it
  // It looks up services by name

  const counter = Registry.lookup<CounterState, CounterCall, CounterCast, CounterReply>('counter');
  const logger = Registry.lookup<LoggerState, LoggerCall, LoggerCast, LoggerReply>('logger');

  GenServer.cast(logger, { type: 'log', level: 'info', message: 'Starting request simulation' });

  // Perform some operations
  GenServer.cast(counter, { type: 'increment' });
  GenServer.cast(counter, { type: 'increment' });
  GenServer.cast(counter, { type: 'increment' });

  // Wait for casts to process
  await new Promise((r) => setTimeout(r, 50));

  const value = await GenServer.call(counter, { type: 'get' });
  GenServer.cast(logger, {
    type: 'log',
    level: 'info',
    message: `Request simulation complete. Counter: ${value}`,
  });

  // Wait for final log
  await new Promise((r) => setTimeout(r, 10));
}

main();
```

Run with:

```bash
npx tsx services.ts
```

Expected output:

```
[INFO] 2024-01-15T10:30:00.000Z: Counter initialized
[INFO] 2024-01-15T10:30:00.001Z: Starting request simulation
[DEBUG] 2024-01-15T10:30:00.002Z: Counter incremented to 1
[DEBUG] 2024-01-15T10:30:00.003Z: Counter incremented to 2
[DEBUG] 2024-01-15T10:30:00.004Z: Counter incremented to 3
[INFO] 2024-01-15T10:30:00.055Z: Request simulation complete. Counter: 3

--- All Logs ---
[INFO] 2024-01-15T10:30:00.000Z: Counter initialized
[INFO] 2024-01-15T10:30:00.001Z: Starting request simulation
[DEBUG] 2024-01-15T10:30:00.002Z: Counter incremented to 1
[DEBUG] 2024-01-15T10:30:00.003Z: Counter incremented to 2
[DEBUG] 2024-01-15T10:30:00.004Z: Counter incremented to 3
[INFO] 2024-01-15T10:30:00.055Z: Request simulation complete. Counter: 3
```

## Exercise

Create a **KeyValueStore** GenServer that:

1. Supports `get(key)` and `set(key, value)` as calls
2. Supports `delete(key)` as a cast
3. Is registered under the name `'kv-store'`
4. Create a helper module with functions `kvGet`, `kvSet`, `kvDelete` that look up the store via Registry

Test that:
- The helper functions work without passing references
- Values can be stored and retrieved
- Automatic cleanup happens when the server stops

**Hints:**
- Use a `Map<string, unknown>` for storage
- `kvGet` should return `undefined` for missing keys
- The helpers should throw `NotRegisteredError` if the store isn't running

<details>
<summary>Solution</summary>

```typescript
import {
  GenServer,
  Registry,
  NotRegisteredError,
  type GenServerBehavior,
} from '@hamicek/noex';

// Types
interface KVState {
  data: Map<string, unknown>;
}

type KVCallMsg =
  | { type: 'get'; key: string }
  | { type: 'set'; key: string; value: unknown }
  | { type: 'keys' };

type KVCastMsg = { type: 'delete'; key: string };

type KVReply = unknown | string[];

// Behavior
const kvStoreBehavior: GenServerBehavior<KVState, KVCallMsg, KVCastMsg, KVReply> = {
  init() {
    return { data: new Map() };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.data.get(msg.key), state];

      case 'set': {
        const newData = new Map(state.data);
        newData.set(msg.key, msg.value);
        return [msg.value, { data: newData }];
      }

      case 'keys':
        return [Array.from(state.data.keys()), state];
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'delete') {
      const newData = new Map(state.data);
      newData.delete(msg.key);
      return { data: newData };
    }
    return state;
  },
};

// Helper module
const KV_STORE_NAME = 'kv-store';

function getStore() {
  return Registry.lookup<KVState, KVCallMsg, KVCastMsg, KVReply>(KV_STORE_NAME);
}

export async function kvGet<T = unknown>(key: string): Promise<T | undefined> {
  const store = getStore();
  return (await GenServer.call(store, { type: 'get', key })) as T | undefined;
}

export async function kvSet<T>(key: string, value: T): Promise<T> {
  const store = getStore();
  return (await GenServer.call(store, { type: 'set', key, value })) as T;
}

export function kvDelete(key: string): void {
  const store = getStore();
  GenServer.cast(store, { type: 'delete', key });
}

export async function kvKeys(): Promise<string[]> {
  const store = getStore();
  return (await GenServer.call(store, { type: 'keys' })) as string[];
}

// Test
async function main() {
  // Start and register the store
  const storeRef = await GenServer.start(kvStoreBehavior);
  Registry.register(KV_STORE_NAME, storeRef);
  console.log('KV Store started and registered');

  // Test the helper functions (no references needed!)
  await kvSet('user:1', { name: 'Alice', age: 30 });
  await kvSet('user:2', { name: 'Bob', age: 25 });
  await kvSet('config:theme', 'dark');

  console.log('\nStored values:');
  console.log('user:1 =', await kvGet('user:1'));
  console.log('user:2 =', await kvGet('user:2'));
  console.log('config:theme =', await kvGet('config:theme'));
  console.log('missing =', await kvGet('missing'));

  console.log('\nAll keys:', await kvKeys());

  // Test delete
  kvDelete('user:2');
  await new Promise((r) => setTimeout(r, 10));
  console.log('\nAfter deleting user:2:');
  console.log('user:2 =', await kvGet('user:2'));
  console.log('All keys:', await kvKeys());

  // Test automatic cleanup
  console.log('\nStopping store...');
  await GenServer.stop(storeRef);
  console.log('Store registered:', Registry.isRegistered(KV_STORE_NAME)); // false

  // This should throw NotRegisteredError
  try {
    await kvGet('user:1');
  } catch (error) {
    if (error instanceof NotRegisteredError) {
      console.log(`\nExpected error: Store '${error.processName}' is not registered`);
    }
  }
}

main();
```

Expected output:

```
KV Store started and registered

Stored values:
user:1 = { name: 'Alice', age: 30 }
user:2 = { name: 'Bob', age: 25 }
config:theme = dark
missing = undefined

All keys: [ 'user:1', 'user:2', 'config:theme' ]

After deleting user:2:
user:2 = undefined
All keys: [ 'user:1', 'config:theme' ]

Stopping store...
Store registered: false

Expected error: Store 'kv-store' is not registered
```

</details>

## Summary

- **Registry** provides named process lookup, decoupling components from explicit references
- Use `Registry.register(name, ref)` to associate a name with a process
- Use `Registry.lookup(name)` when the service must exist (throws on missing)
- Use `Registry.whereis(name)` when the service is optional (returns undefined)
- **Unique mode** (default): Each name maps to exactly one process
- **Duplicate mode**: Multiple entries per key, useful for pub/sub with `dispatch()`
- Registrations are **automatically cleaned up** when processes terminate
- Create isolated registries with `Registry.create()` for custom configurations
- Pattern matching with `match()` supports glob-style patterns (`*`, `**`, `?`)

Named processes are a fundamental building block for larger applications. They enable loose coupling, making your code more modular and testable.

---

Next: [Why Supervisor?](../03-supervision/01-why-supervisor.md)
