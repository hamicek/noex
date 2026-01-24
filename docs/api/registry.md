# Registry API Reference

The `Registry` object provides named process lookup, allowing processes to be discovered by well-known names. It also serves as a factory for creating isolated `RegistryInstance` instances with custom configuration.

## Import

```typescript
import { Registry, RegistryInstance } from 'noex';
import type {
  RegistryOptions,
  RegistryKeyMode,
  RegistryEntry,
  RegistryMatch,
  RegistryPredicate,
  DispatchFn,
} from 'noex';
```

---

## Registry (Global Facade)

The static `Registry` object delegates to an internal default `RegistryInstance` in unique mode. It provides a simple global namespace for process registration.

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

**Throws:**
- `AlreadyRegisteredError` - If the name is already registered

**Notes:**
- Registration is automatically removed when the process terminates
- Each name can only be registered once

**Example:**
```typescript
const ref = await GenServer.start(behavior);
Registry.register('my-service', ref);
```

---

### lookup()

Looks up a process by name. Throws if not found.

```typescript
lookup<State = unknown, CallMsg = unknown, CastMsg = unknown, CallReply = unknown>(
  name: string,
): GenServerRef<State, CallMsg, CastMsg, CallReply>
```

**Throws:**
- `NotRegisteredError` - If no process is registered under the name

**Example:**
```typescript
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

**Example:**
```typescript
const counter = Registry.whereis('counter');
if (counter) {
  await GenServer.call(counter, 'get');
}
```

---

### unregister()

Unregisters a process by name. Idempotent.

```typescript
unregister(name: string): void
```

---

### isRegistered()

Checks if a name is currently registered.

```typescript
isRegistered(name: string): boolean
```

---

### getNames()

Returns all currently registered names.

```typescript
getNames(): readonly string[]
```

---

### count()

Returns the count of registered processes.

```typescript
count(): number
```

---

### create()

Creates a new isolated `RegistryInstance` with custom configuration.

```typescript
create<Meta = unknown>(options?: RegistryOptions): RegistryInstance<Meta>
```

**Type Parameters:**
- `Meta` - Type of metadata attached to each entry

**Parameters:**
- `options` - Registry configuration (name, key mode, persistence)

**Returns:** A new `RegistryInstance` that must be started with `await instance.start()`

**Example:**
```typescript
const services = Registry.create<{ version: string }>({
  name: 'services',
  keys: 'unique',
});
await services.start();
services.register('auth', authRef, { version: '2.0' });

// Duplicate mode (pub/sub)
const topics = Registry.create({ name: 'topics', keys: 'duplicate' });
await topics.start();
topics.register('user:created', handlerA);
topics.register('user:created', handlerB);
topics.dispatch('user:created', payload);
```

---

## RegistryInstance

`RegistryInstance` is the core registry class supporting unique or duplicate key modes, metadata, pattern matching, and dispatch.

### Constructor

```typescript
new RegistryInstance<Meta = unknown>(options?: RegistryOptions)
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | auto-generated | Human-readable name |
| `keys` | `'unique' \| 'duplicate'` | `'unique'` | Key mode |
| `persistence` | `RegistryPersistenceConfig` | — | Optional persistence |

---

### start()

Initializes the registry and sets up lifecycle handlers for automatic cleanup.

```typescript
async start(): Promise<void>
```

Idempotent — calling on an already-started instance does nothing.

---

### close()

Shuts down the registry, removes lifecycle handlers, and clears all entries.

```typescript
async close(): Promise<void>
```

Idempotent — safe to call on a stopped instance.

---

### register()

Registers a reference under a key with optional metadata.

```typescript
register(key: string, ref: RegisterableRef, metadata?: Meta): void
```

**Unique mode:** Throws `AlreadyRegisteredKeyError` if key is already taken.
**Duplicate mode:** Throws `DuplicateRegistrationError` if the same ref is already registered under the same key.

---

### unregister()

Removes all entries for a key. Idempotent.

```typescript
unregister(key: string): void
```

---

### unregisterMatch()

Removes a specific ref from a key. In duplicate mode, only the matching entry is removed.

```typescript
unregisterMatch(key: string, ref: RegisterableRef): void
```

---

### lookup()

Returns the entry for a key (unique mode only).

```typescript
lookup(key: string): RegistryEntry<Meta>
```

**Throws:**
- `DuplicateKeyLookupError` - If called on a duplicate-mode registry
- `KeyNotFoundError` - If the key is not registered

---

### whereis()

Non-throwing lookup. Returns the entry or undefined.

```typescript
whereis(key: string): RegistryEntry<Meta> | undefined
```

In duplicate mode, returns the first entry.

---

### lookupAll()

Returns all entries for a key. Works in both modes.

```typescript
lookupAll(key: string): ReadonlyArray<RegistryEntry<Meta>>
```

---

### select()

Filters all entries using a predicate function.

```typescript
select(predicate: RegistryPredicate<Meta>): RegistryMatch<Meta>[]
```

**Example:**
```typescript
const workers = registry.select(
  (key, entry) => entry.metadata.type === 'worker',
);
```

---

### match()

Matches entries by glob-like key pattern with optional value predicate.

```typescript
match(
  keyPattern: string,
  valuePredicate?: (entry: RegistryEntry<Meta>) => boolean,
): RegistryMatch<Meta>[]
```

**Pattern syntax:**
- `*` matches any characters except `/`
- `**` matches any characters including `/`
- `?` matches a single character

**Example:**
```typescript
const userServices = registry.match('user:*');
const active = registry.match('svc:*', (e) => e.metadata.active);
```

---

### dispatch()

Dispatches a message to all entries under a key (duplicate mode only).

```typescript
dispatch(key: string, message: unknown, dispatchFn?: DispatchFn<Meta>): void
```

**Default behavior:** Sends the message via `GenServer.cast` to each entry.
**Custom dispatch:** Provide a `dispatchFn` for custom routing (round-robin, filtering, etc.).

**Throws:**
- `DispatchNotSupportedError` - If called on a unique-mode registry

**Example:**
```typescript
// Default broadcast
topics.dispatch('user:created', { userId: '123' });

// Custom dispatch
topics.dispatch('events', payload, (entries, msg) => {
  for (const entry of entries) {
    if (entry.metadata.priority > 5) {
      GenServer.cast(entry.ref, msg);
    }
  }
});
```

---

### getMetadata()

Returns metadata for a key. In duplicate mode, returns the first entry's metadata.

```typescript
getMetadata(key: string): Meta | undefined
```

---

### updateMetadata()

Updates metadata using an updater function. In duplicate mode, updates all entries.

```typescript
updateMetadata(key: string, updater: (meta: Meta) => Meta): boolean
```

Returns `true` if any entries were updated.

---

### isRegistered()

```typescript
isRegistered(key: string): boolean
```

---

### getKeys()

```typescript
getKeys(): readonly string[]
```

---

### count()

Returns total number of entries across all keys.

```typescript
count(): number
```

---

### countForKey()

Returns the number of entries for a specific key.

```typescript
countForKey(key: string): number
```

---

## Types

### RegistryOptions

```typescript
interface RegistryOptions {
  readonly name?: string;
  readonly keys?: RegistryKeyMode;
  readonly persistence?: RegistryPersistenceConfig;
}
```

### RegistryKeyMode

```typescript
type RegistryKeyMode = 'unique' | 'duplicate';
```

### RegistryEntry\<Meta\>

```typescript
interface RegistryEntry<Meta = unknown> {
  readonly ref: RegisterableRef;
  readonly metadata: Meta;
  readonly registeredAt: number;
}
```

### RegistryMatch\<Meta\>

```typescript
interface RegistryMatch<Meta = unknown> {
  readonly key: string;
  readonly ref: RegisterableRef;
  readonly metadata: Meta;
}
```

### RegistryPredicate\<Meta\>

```typescript
type RegistryPredicate<Meta> = (
  key: string,
  entry: RegistryEntry<Meta>,
) => boolean;
```

### DispatchFn\<Meta\>

```typescript
type DispatchFn<Meta> = (
  entries: ReadonlyArray<RegistryEntry<Meta>>,
  message: unknown,
) => void;
```

### RegistryPersistenceConfig

```typescript
interface RegistryPersistenceConfig {
  readonly adapter: StorageAdapter;
  readonly key?: string;
  readonly restoreOnStart?: boolean;    // default: true
  readonly persistOnChange?: boolean;   // default: true
  readonly debounceMs?: number;         // default: 100
  readonly persistOnShutdown?: boolean; // default: true
  readonly onError?: (error: Error) => void;
}
```

---

## Error Classes

### AlreadyRegisteredKeyError

Thrown when a key is already registered in unique mode.

```typescript
class AlreadyRegisteredKeyError extends Error {
  readonly name = 'AlreadyRegisteredKeyError';
  readonly registryName: string;
  readonly key: string;
}
```

### KeyNotFoundError

Thrown when `lookup()` fails because the key is not found.

```typescript
class KeyNotFoundError extends Error {
  readonly name = 'KeyNotFoundError';
  readonly registryName: string;
  readonly key: string;
}
```

### DuplicateKeyLookupError

Thrown when `lookup()` is called on a duplicate-mode registry.

```typescript
class DuplicateKeyLookupError extends Error {
  readonly name = 'DuplicateKeyLookupError';
  readonly registryName: string;
  readonly key: string;
}
```

### DispatchNotSupportedError

Thrown when `dispatch()` is called on a unique-mode registry.

```typescript
class DispatchNotSupportedError extends Error {
  readonly name = 'DispatchNotSupportedError';
  readonly registryName: string;
}
```

### DuplicateRegistrationError

Thrown when the same ref is registered under the same key in duplicate mode.

```typescript
class DuplicateRegistrationError extends Error {
  readonly name = 'DuplicateRegistrationError';
  readonly registryName: string;
  readonly key: string;
  readonly refId: string;
}
```

---

## Related

- [Registry Concepts](../concepts/registry.md) - Instance vs global, key modes, patterns
- [GenServer API](./genserver.md) - Process API
- [Errors Reference](./errors.md) - All error classes
