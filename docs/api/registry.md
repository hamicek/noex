# Registry API Reference

The `Registry` object provides named process lookup, allowing processes to be discovered by well-known names.

## Import

```typescript
import { Registry } from 'noex';
```

## Methods

### register()

Registers a process under a given name.

```typescript
register<State = unknown, CallMsg = unknown, CastMsg = unknown, CallReply = unknown>(
  name: string,
  ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
): void
```

**Parameters:**
- `name` - The name to register under
- `ref` - The process reference to register

**Returns:** void

**Throws:**
- `AlreadyRegisteredError` - If the name is already registered

**Notes:**
- Registration is automatically removed when the process terminates
- Each name can only be registered once

**Example:**
```typescript
const ref = await GenServer.start(behavior);
Registry.register('my-service', ref);

// Attempting to register again throws
try {
  Registry.register('my-service', anotherRef);
} catch (error) {
  // AlreadyRegisteredError
}
```

---

### lookup()

Looks up a process by name. Throws if not found.

```typescript
lookup<State = unknown, CallMsg = unknown, CastMsg = unknown, CallReply = unknown>(
  name: string,
): GenServerRef<State, CallMsg, CastMsg, CallReply>
```

**Parameters:**
- `name` - The name to look up

**Returns:** The registered GenServerRef

**Throws:**
- `NotRegisteredError` - If no process is registered under the name

**Example:**
```typescript
// Basic lookup
const ref = Registry.lookup('my-service');

// Typed lookup
const counter = Registry.lookup<number, 'get', 'inc', number>('counter');
const value = await GenServer.call(counter, 'get');
```

---

### whereis()

Looks up a process by name. Returns undefined if not found.

```typescript
whereis<State = unknown, CallMsg = unknown, CastMsg = unknown, CallReply = unknown>(
  name: string,
): GenServerRef<State, CallMsg, CastMsg, CallReply> | undefined
```

**Parameters:**
- `name` - The name to look up

**Returns:** The registered GenServerRef, or undefined if not found

**Example:**
```typescript
const counter = Registry.whereis('counter');
if (counter) {
  await GenServer.call(counter, 'get');
} else {
  console.log('Counter not available');
}
```

---

### unregister()

Unregisters a process by name.

```typescript
unregister(name: string): void
```

**Parameters:**
- `name` - The name to unregister

**Returns:** void

**Notes:**
- Idempotent - unregistering a non-existent name does nothing
- The process continues running, only the name mapping is removed

**Example:**
```typescript
Registry.unregister('old-service');
// Name is now available for re-registration
Registry.register('old-service', newRef);
```

---

### isRegistered()

Checks if a name is currently registered.

```typescript
isRegistered(name: string): boolean
```

**Parameters:**
- `name` - The name to check

**Returns:** `true` if the name is registered

**Example:**
```typescript
if (Registry.isRegistered('counter')) {
  const counter = Registry.lookup('counter');
  // Safe to use
}
```

---

### getNames()

Returns all currently registered names.

```typescript
getNames(): readonly string[]
```

**Returns:** Array of registered names

**Example:**
```typescript
const names = Registry.getNames();
console.log('Registered services:', names);
// ['cache', 'auth', 'metrics']
```

---

### count()

Returns the count of registered processes.

```typescript
count(): number
```

**Returns:** Number of registered processes

**Example:**
```typescript
console.log(`${Registry.count()} services registered`);
```

---

## Error Classes

### NotRegisteredError

```typescript
class NotRegisteredError extends Error {
  readonly name = 'NotRegisteredError';
  readonly processName: string;
}
```

### AlreadyRegisteredError

```typescript
class AlreadyRegisteredError extends Error {
  readonly name = 'AlreadyRegisteredError';
  readonly registeredName: string;
}
```

---

## Complete Example

```typescript
import { Registry, GenServer, type GenServerBehavior } from 'noex';

// Define service names
const SERVICES = {
  CACHE: 'cache',
  AUTH: 'auth',
  METRICS: 'metrics',
} as const;

// Cache service behavior
const cacheBehavior: GenServerBehavior<
  Map<string, unknown>,
  { type: 'get'; key: string },
  { type: 'set'; key: string; value: unknown },
  unknown
> = {
  init: () => new Map(),
  handleCall: (msg, state) => [state.get(msg.key), state],
  handleCast: (msg, state) => {
    state.set(msg.key, msg.value);
    return state;
  },
};

// Start and register service
async function startCacheService() {
  const ref = await GenServer.start(cacheBehavior);
  Registry.register(SERVICES.CACHE, ref);
  return ref;
}

// Use service from anywhere
async function cacheGet(key: string): Promise<unknown> {
  const cache = Registry.lookup<
    Map<string, unknown>,
    { type: 'get'; key: string },
    { type: 'set'; key: string; value: unknown },
    unknown
  >(SERVICES.CACHE);

  return GenServer.call(cache, { type: 'get', key });
}

function cacheSet(key: string, value: unknown): void {
  const cache = Registry.whereis(SERVICES.CACHE);
  if (cache) {
    GenServer.cast(cache, { type: 'set', key, value });
  }
}

// Health check
function getServiceStatus(): Record<string, boolean> {
  return {
    cache: Registry.isRegistered(SERVICES.CACHE),
    auth: Registry.isRegistered(SERVICES.AUTH),
    metrics: Registry.isRegistered(SERVICES.METRICS),
  };
}

// Usage
async function main() {
  await startCacheService();

  cacheSet('user:1', { name: 'Alice' });
  const user = await cacheGet('user:1');
  console.log(user);

  console.log('Services:', getServiceStatus());
  console.log('All names:', Registry.getNames());
}
```

## Related

- [Registry Concepts](../concepts/registry.md) - Understanding Registry
- [GenServer API](./genserver.md) - Process API
- [Errors Reference](./errors.md) - All error classes
