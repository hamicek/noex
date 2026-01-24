# Registry

Registry provides named process lookup for GenServers and Supervisors. It enables loose coupling between components by allowing services to be discovered by well-known names rather than passing references explicitly.

## Overview

The Registry system offers:
- **Global Registry** - Simple name-to-process mapping for the entire application
- **Registry Instances** - Isolated registries with custom key modes and metadata
- **Unique keys** - One entry per key (default, service discovery)
- **Duplicate keys** - Multiple entries per key (pub/sub, event routing)
- **Metadata** - Attach typed data to each registration
- **Pattern matching** - Query entries by glob patterns or predicates
- **Dispatch** - Send messages to all entries under a key
- **Automatic cleanup** - Entries are removed when processes terminate
- **Persistence** - Optionally persist registry state across restarts

```typescript
import { Registry, RegistryInstance } from 'noex';

// Global registry (simple, unique keys)
const counter = await GenServer.start(counterBehavior);
Registry.register('counter', counter);
const ref = Registry.lookup('counter');

// Custom registry instance (typed metadata, duplicate keys)
const topics = Registry.create({ name: 'topics', keys: 'duplicate' });
await topics.start();
topics.register('user:created', handlerA);
topics.register('user:created', handlerB);
topics.dispatch('user:created', { userId: '123' });
```

## Global Registry vs Registry Instances

### Global Registry

The `Registry` object is a facade over an internal default `RegistryInstance` in unique mode. It provides the simplest API for common service discovery:

```typescript
// Automatic registration at start time
const ref = await GenServer.start(behavior, { name: 'auth' });

// Lookup from anywhere
const auth = Registry.lookup('auth');
await GenServer.call(auth, { type: 'validate', token });
```

### Registry Instances

For more advanced use cases, create isolated instances with `Registry.create()`:

```typescript
const services = Registry.create<{ version: string }>({
  name: 'services',
  keys: 'unique',
});
await services.start();

services.register('auth', authRef, { version: '2.1' });
services.register('cache', cacheRef, { version: '1.0' });

// Completely isolated from the global Registry
Registry.isRegistered('auth'); // false (not in global)
services.isRegistered('auth'); // true
```

Instances are independent — closing one does not affect others.

## Key Modes

### Unique Mode (Default)

Each key maps to exactly one entry. Attempting to register a duplicate key throws an error:

```typescript
const registry = Registry.create({ name: 'services', keys: 'unique' });
await registry.start();

registry.register('db', dbRef);
registry.register('db', anotherRef); // throws AlreadyRegisteredKeyError
```

Use unique mode for:
- Service discovery (one authoritative instance per name)
- Singleton processes
- Named workers

### Duplicate Mode

Each key can map to multiple entries, enabling pub/sub patterns:

```typescript
const events = Registry.create({ name: 'events', keys: 'duplicate' });
await events.start();

// Multiple handlers for the same event
events.register('order:placed', emailHandler);
events.register('order:placed', inventoryHandler);
events.register('order:placed', analyticsHandler);

// Broadcast to all handlers
events.dispatch('order:placed', orderData);
```

Use duplicate mode for:
- Event routing
- Pub/sub messaging
- Fan-out patterns
- Topic subscriptions

## Metadata

Attach typed metadata to each registration for richer querying:

```typescript
interface ServiceMeta {
  version: string;
  priority: number;
  healthy: boolean;
}

const services = Registry.create<ServiceMeta>({
  name: 'services',
  keys: 'unique',
});
await services.start();

services.register('auth', authRef, {
  version: '2.1',
  priority: 10,
  healthy: true,
});

// Read metadata
const meta = services.getMetadata('auth');
// { version: '2.1', priority: 10, healthy: true }

// Update metadata
services.updateMetadata('auth', (m) => ({ ...m, healthy: false }));
```

## Pattern Matching

### select()

Filter entries using arbitrary predicates:

```typescript
// Find all high-priority services
const critical = services.select(
  (key, entry) => entry.metadata.priority >= 8,
);

// Find entries by key prefix
const userServices = services.select(
  (key) => key.startsWith('user:'),
);
```

### match()

Match entries using glob-like patterns on keys:

```typescript
// * matches any characters except /
const userHandlers = events.match('user:*');
// Matches: 'user:created', 'user:deleted'
// Skips: 'order:placed'

// ** matches any characters including /
const allNested = registry.match('app/**');
// Matches: 'app/auth', 'app/cache/redis'

// ? matches a single character
const versions = registry.match('v?');
// Matches: 'v1', 'v2'
// Skips: 'v10'

// With value predicate
const activeAuth = services.match('auth:*', (e) => e.metadata.healthy);
```

## Dispatch

In duplicate mode, dispatch messages to all entries under a key:

```typescript
const topics = Registry.create({ name: 'topics', keys: 'duplicate' });
await topics.start();

topics.register('events', workerA);
topics.register('events', workerB);
topics.register('events', workerC);

// Default: GenServer.cast to each entry
topics.dispatch('events', { type: 'process', data });

// Custom dispatch function
topics.dispatch('events', payload, (entries, msg) => {
  // Round-robin: pick one entry
  const idx = Math.floor(Math.random() * entries.length);
  GenServer.cast(entries[idx].ref, msg);
});
```

## GenServer Integration

Use the `registry` option in `GenServer.start()` to register in a custom registry:

```typescript
const services = Registry.create({ name: 'app-services' });
await services.start();

// Register in custom registry instead of global
const ref = await GenServer.start(behavior, {
  name: 'auth',
  registry: services,
});

// Registered in services, NOT in global Registry
services.isRegistered('auth'); // true
Registry.isRegistered('auth'); // false
```

With duplicate mode, multiple servers can share the same name:

```typescript
const workers = Registry.create({ name: 'workers', keys: 'duplicate' });
await workers.start();

// Start multiple workers under the same key
const w1 = await GenServer.start(workerBehavior, { name: 'pool', registry: workers });
const w2 = await GenServer.start(workerBehavior, { name: 'pool', registry: workers });

workers.countForKey('pool'); // 2
workers.dispatch('pool', job); // broadcasts to both
```

## Automatic Cleanup

Entries are automatically removed when the registered process terminates:

```typescript
const registry = Registry.create({ name: 'test' });
await registry.start();

const ref = await GenServer.start(behavior);
registry.register('ephemeral', ref);
registry.isRegistered('ephemeral'); // true

await GenServer.stop(ref);
// After lifecycle event propagates:
registry.isRegistered('ephemeral'); // false
```

This works across multiple registries — if a process is registered in several instances, all registrations are cleaned up on termination.

## Persistence

Registry instances can persist their state across restarts using a `StorageAdapter`:

```typescript
import { FileAdapter } from 'noex';

const registry = Registry.create<{ role: string }>({
  name: 'services',
  keys: 'unique',
  persistence: {
    adapter: new FileAdapter({ directory: './data' }),
    restoreOnStart: true,
    persistOnChange: true,
    debounceMs: 200,
    persistOnShutdown: true,
    onError: (err) => console.error('Registry persist failed:', err),
  },
});

await registry.start(); // Restores entries from storage (dead refs are skipped)

registry.register('auth', authRef, { role: 'authentication' });
// State is persisted after 200ms debounce

await registry.close(); // Final flush to storage
```

**Key behaviors:**
- Changes are debounced to avoid excessive writes
- Dead refs are skipped during restore
- Persistence errors are non-fatal (registry continues in-memory)

## Common Patterns

### Service Discovery with Metadata

```typescript
interface ServiceInfo {
  version: string;
  port: number;
  healthEndpoint: string;
}

const services = Registry.create<ServiceInfo>({ name: 'services' });
await services.start();

services.register('api-gateway', gatewayRef, {
  version: '3.2.0',
  port: 8080,
  healthEndpoint: '/health',
});

// Find all v3.x services
const v3Services = services.select(
  (_, entry) => entry.metadata.version.startsWith('3.'),
);
```

### Event Bus with Topics

```typescript
const bus = Registry.create({ name: 'event-bus', keys: 'duplicate' });
await bus.start();

// Subscribe handlers to topics
bus.register('order:*', orderLogger);
bus.register('order:placed', inventoryUpdater);
bus.register('order:placed', emailNotifier);

// Dispatch to a specific topic
bus.dispatch('order:placed', { orderId: '456', items: [...] });
```

### Health Monitoring

```typescript
const monitored = Registry.create<{ healthy: boolean; lastCheck: number }>({
  name: 'monitored',
});
await monitored.start();

// Periodic health check
setInterval(() => {
  const unhealthy = monitored.select(
    (_, entry) => !entry.metadata.healthy,
  );
  if (unhealthy.length > 0) {
    console.warn('Unhealthy services:', unhealthy.map((m) => m.key));
  }
}, 10000);
```

## Comparison with Elixir

| noex | Elixir |
|------|--------|
| `Registry.register(name, ref)` | `{:via, Registry, name}` in start |
| `Registry.lookup(name)` | `GenServer.call({:via, Registry, name}, msg)` |
| `Registry.create({ keys: 'duplicate' })` | `Registry.start_link(keys: :duplicate)` |
| `registry.select(predicate)` | `Registry.select(registry, spec)` |
| `registry.match(pattern)` | `Registry.match(registry, key, pattern)` |
| `registry.dispatch(key, msg)` | `Registry.dispatch(registry, key, fn)` |

## Related

- [API Reference: Registry](../api/registry.md) - Complete API documentation
- [GenServer](./genserver.md) - Processes that can be registered
- [Supervisor](./supervisor.md) - Supervising registered processes
