# Registry

Registry provides named process lookup for GenServers and Supervisors. It enables loose coupling between components by allowing services to be discovered by well-known names rather than passing references explicitly.

## Overview

The Registry offers:
- **Named registration** - Associate processes with string names
- **Global namespace** - Single lookup point for the entire application
- **Automatic cleanup** - Registrations are removed when processes terminate
- **Type-safe lookups** - Preserve TypeScript types through lookups

```typescript
import { Registry, GenServer } from 'noex';

// Start and register a service
const counter = await GenServer.start(counterBehavior);
Registry.register('counter', counter);

// Look it up from anywhere in your application
const ref = Registry.lookup<number, 'get', 'inc', number>('counter');
const value = await GenServer.call(ref, 'get');
```

## Registering Processes

### Basic Registration

```typescript
const ref = await GenServer.start(behavior);
Registry.register('my-service', ref);
```

### Registration at Start Time

A common pattern is to register immediately after starting:

```typescript
async function startNamedService(name: string) {
  const ref = await GenServer.start(serviceBehavior);
  Registry.register(name, ref);
  return ref;
}

await startNamedService('user-cache');
await startNamedService('session-store');
```

### Unique Names

Each name can only be registered once. Attempting to register a duplicate throws an error:

```typescript
import { AlreadyRegisteredError } from 'noex';

Registry.register('counter', ref1);

try {
  Registry.register('counter', ref2);  // Throws!
} catch (error) {
  if (error instanceof AlreadyRegisteredError) {
    console.error(`Name '${error.registeredName}' is already taken`);
  }
}
```

## Looking Up Processes

### lookup() - Throwing Variant

Use `lookup()` when you expect the process to exist:

```typescript
import { NotRegisteredError } from 'noex';

try {
  const counter = Registry.lookup('counter');
  await GenServer.call(counter, 'get');
} catch (error) {
  if (error instanceof NotRegisteredError) {
    console.error(`Process '${error.processName}' not found`);
  }
}
```

### whereis() - Non-Throwing Variant

Use `whereis()` for optional lookups:

```typescript
const counter = Registry.whereis('counter');
if (counter) {
  await GenServer.call(counter, 'get');
} else {
  console.log('Counter not available');
}
```

### Type-Safe Lookups

Preserve type information with type parameters:

```typescript
// Define your types
type CounterState = number;
type CounterCall = 'get' | { type: 'add'; n: number };
type CounterCast = 'increment' | 'reset';
type CounterReply = number;

// Typed lookup
const counter = Registry.lookup<
  CounterState,
  CounterCall,
  CounterCast,
  CounterReply
>('counter');

// Now fully typed
const value = await GenServer.call(counter, 'get');  // Returns number
GenServer.cast(counter, 'increment');                 // Type-checked
```

## Automatic Cleanup

Registrations are automatically removed when processes terminate:

```typescript
const ref = await GenServer.start(behavior);
Registry.register('temp-service', ref);

console.log(Registry.isRegistered('temp-service'));  // true

await GenServer.stop(ref);

console.log(Registry.isRegistered('temp-service'));  // false
Registry.lookup('temp-service');  // Throws NotRegisteredError
```

This prevents stale references and memory leaks.

## Manual Unregistration

Remove a registration without stopping the process:

```typescript
Registry.unregister('old-name');

// The process continues running, but the name is freed
Registry.register('new-name', sameRef);
```

Unregistering is idempotent - unregistering a non-existent name does nothing:

```typescript
Registry.unregister('does-not-exist');  // No error
```

## Querying the Registry

### Check Registration

```typescript
if (Registry.isRegistered('cache')) {
  // Safe to lookup
  const cache = Registry.lookup('cache');
}
```

### List All Names

```typescript
const names = Registry.getNames();
console.log('Registered services:', names);
// ['user-cache', 'session-store', 'metrics-collector']
```

### Count Registrations

```typescript
const count = Registry.count();
console.log(`${count} services registered`);
```

## Common Patterns

### Service Discovery

```typescript
// Service definitions
const SERVICES = {
  CACHE: 'cache',
  AUTH: 'auth',
  METRICS: 'metrics',
} as const;

// Startup
async function bootstrap() {
  await startAndRegister(SERVICES.CACHE, cacheBehavior);
  await startAndRegister(SERVICES.AUTH, authBehavior);
  await startAndRegister(SERVICES.METRICS, metricsBehavior);
}

// Usage anywhere in the app
function getCache() {
  return Registry.lookup(SERVICES.CACHE);
}
```

### Optional Dependencies

```typescript
async function processRequest(data: Request) {
  // Core processing
  const result = await handleRequest(data);

  // Optional metrics (might not be running)
  const metrics = Registry.whereis('metrics');
  if (metrics) {
    GenServer.cast(metrics, { type: 'record', request: data });
  }

  return result;
}
```

### Graceful Service Replacement

```typescript
async function replaceService(name: string, newBehavior: GenServerBehavior) {
  // Get old reference if exists
  const old = Registry.whereis(name);

  // Start new service
  const newRef = await GenServer.start(newBehavior);

  // Atomic swap: unregister old, register new
  if (old) {
    Registry.unregister(name);
  }
  Registry.register(name, newRef);

  // Stop old service after swap
  if (old) {
    await GenServer.stop(old);
  }

  return newRef;
}
```

### Supervised Registration

Combine with Supervisor for resilient named services:

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    {
      id: 'cache',
      start: async () => {
        const ref = await GenServer.start(cacheBehavior);
        // Re-register on each restart
        if (Registry.isRegistered('cache')) {
          Registry.unregister('cache');
        }
        Registry.register('cache', ref);
        return ref;
      },
    },
  ],
});
```

## Best Practices

### 1. Use Constants for Names

```typescript
// Good: Centralized names
export const PROCESS_NAMES = {
  USER_CACHE: 'user-cache',
  SESSION_STORE: 'session-store',
  RATE_LIMITER: 'rate-limiter',
} as const;

Registry.register(PROCESS_NAMES.USER_CACHE, ref);
Registry.lookup(PROCESS_NAMES.USER_CACHE);

// Avoid: String literals scattered throughout code
Registry.register('user-cache', ref);
Registry.lookup('user-cache');  // Typo risk!
```

### 2. Type Your Lookups

```typescript
// Good: Type-safe reference
type CacheRef = GenServerRef<CacheState, CacheCall, CacheCast, CacheReply>;
const cache = Registry.lookup<CacheState, CacheCall, CacheCast, CacheReply>('cache');

// Avoid: Untyped reference
const cache = Registry.lookup('cache');  // Types are unknown
```

### 3. Handle Missing Services

```typescript
// Good: Graceful handling
const metrics = Registry.whereis('metrics');
if (metrics) {
  GenServer.cast(metrics, event);
}

// Or with error handling
try {
  const required = Registry.lookup('required-service');
} catch (error) {
  // Handle missing required service
  throw new Error('Application misconfigured: missing required-service');
}
```

### 4. Document Service Names

```typescript
/**
 * Well-known service names in the application.
 *
 * - USER_CACHE: Caches user profiles, TTL 5 minutes
 * - SESSION_STORE: Active session storage
 * - RATE_LIMITER: API rate limiting
 */
export const SERVICES = {
  USER_CACHE: 'user-cache',
  SESSION_STORE: 'session-store',
  RATE_LIMITER: 'rate-limiter',
} as const;
```

## Error Types

| Error | Cause |
|-------|-------|
| `AlreadyRegisteredError` | Name is already in use |
| `NotRegisteredError` | No process registered under that name |

## Comparison with Elixir

| noex | Elixir |
|------|--------|
| `Registry.register(name, ref)` | `{:via, Registry, name}` in start |
| `Registry.lookup(name)` | `GenServer.call({:via, Registry, name}, msg)` |
| `Registry.whereis(name)` | `Registry.lookup/2` |
| `Registry.unregister(name)` | Automatic via process linking |

## Related

- [GenServer](./genserver.md) - Processes that can be registered
- [Supervisor](./supervisor.md) - Supervising registered processes
- [API Reference: Registry](../api/registry.md) - Complete API documentation
