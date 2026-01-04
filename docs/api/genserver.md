# GenServer API Reference

The `GenServer` object provides methods for starting, communicating with, and stopping GenServer instances.

## Import

```typescript
import { GenServer } from 'noex';
```

## Types

### GenServerRef

Opaque reference to a running GenServer instance.

```typescript
interface GenServerRef<
  State = unknown,
  CallMsg = unknown,
  CastMsg = unknown,
  CallReply = unknown,
> {
  readonly id: string;
}
```

### GenServerBehavior

Interface that defines GenServer callbacks.

```typescript
interface GenServerBehavior<State, CallMsg, CastMsg, CallReply> {
  init(): State | Promise<State>;
  handleCall(msg: CallMsg, state: State): CallResult<CallReply, State> | Promise<CallResult<CallReply, State>>;
  handleCast(msg: CastMsg, state: State): State | Promise<State>;
  terminate?(reason: TerminateReason, state: State): void | Promise<void>;
}
```

### CallResult

Return type for `handleCall`.

```typescript
type CallResult<Reply, State> = readonly [Reply, State];
```

### TerminateReason

Reason passed to `terminate` callback.

```typescript
type TerminateReason = 'normal' | 'shutdown' | { readonly error: Error };
```

### StartOptions

Options for `GenServer.start()`.

```typescript
interface StartOptions {
  readonly name?: string;
  readonly initTimeout?: number;  // default: 5000
}
```

### CallOptions

Options for `GenServer.call()`.

```typescript
interface CallOptions {
  readonly timeout?: number;  // default: 5000
}
```

---

## Methods

### start()

Starts a new GenServer with the given behavior.

```typescript
async start<State, CallMsg, CastMsg, CallReply>(
  behavior: GenServerBehavior<State, CallMsg, CastMsg, CallReply>,
  options?: StartOptions,
): Promise<GenServerRef<State, CallMsg, CastMsg, CallReply>>
```

**Parameters:**
- `behavior` - Object implementing GenServerBehavior callbacks
- `options` - Optional start configuration
  - `name` - Register the server under this name in Registry (auto-cleanup on stop)
  - `initTimeout` - Maximum time for `init()` to complete (default: 5000ms)

**Returns:** Promise resolving to a GenServerRef

**Throws:**
- `InitializationError` - If `init()` fails or times out
- `AlreadyRegisteredError` - If `options.name` is already registered

**Example:**
```typescript
const behavior: GenServerBehavior<number, 'get', 'inc', number> = {
  init: () => 0,
  handleCall: (msg, state) => [state, state],
  handleCast: (msg, state) => state + 1,
};

const ref = await GenServer.start(behavior);

// With name registration (can be looked up via Registry.lookup('counter'))
const ref = await GenServer.start(behavior, {
  name: 'counter',
  initTimeout: 10000,
});
```

---

### call()

Sends a synchronous message and waits for a reply.

```typescript
async call<State, CallMsg, CastMsg, CallReply>(
  ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
  msg: CallMsg,
  options?: CallOptions,
): Promise<CallReply>
```

**Parameters:**
- `ref` - Reference to the target server
- `msg` - The message to send
- `options` - Optional call configuration
  - `timeout` - Maximum time to wait for reply (default: 5000ms)

**Returns:** Promise resolving to the reply from `handleCall`

**Throws:**
- `CallTimeoutError` - If no response within timeout
- `ServerNotRunningError` - If server is not running
- Any error thrown by `handleCall`

**Example:**
```typescript
// Basic call
const value = await GenServer.call(counter, 'get');

// With timeout
const value = await GenServer.call(counter, 'get', { timeout: 10000 });

// Typed message
const result = await GenServer.call(cache, { type: 'get', key: 'user:1' });
```

---

### cast()

Sends an asynchronous message without waiting for a reply.

```typescript
cast<State, CallMsg, CastMsg, CallReply>(
  ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
  msg: CastMsg,
): void
```

**Parameters:**
- `ref` - Reference to the target server
- `msg` - The message to send

**Returns:** void (fire-and-forget)

**Throws:**
- `ServerNotRunningError` - If server is not running

**Example:**
```typescript
// Fire and forget
GenServer.cast(counter, 'increment');

// Typed message
GenServer.cast(logger, { type: 'log', level: 'info', message: 'Hello' });
```

---

### stop()

Gracefully stops the server.

```typescript
async stop<State, CallMsg, CastMsg, CallReply>(
  ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
  reason?: TerminateReason,
): Promise<void>
```

**Parameters:**
- `ref` - Reference to the server to stop
- `reason` - Reason for stopping (default: `'normal'`)

**Returns:** Promise that resolves when server is stopped

**Example:**
```typescript
// Normal shutdown
await GenServer.stop(counter);

// With reason
await GenServer.stop(counter, 'shutdown');
await GenServer.stop(counter, { error: new Error('Fatal') });
```

---

### isRunning()

Checks if a server is currently running.

```typescript
isRunning<State, CallMsg, CastMsg, CallReply>(
  ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
): boolean
```

**Parameters:**
- `ref` - Reference to check

**Returns:** `true` if the server is running

**Example:**
```typescript
if (GenServer.isRunning(counter)) {
  await GenServer.call(counter, 'get');
}
```

---

### onLifecycleEvent()

Registers a handler for lifecycle events.

```typescript
onLifecycleEvent(handler: LifecycleHandler): () => void
```

**Parameters:**
- `handler` - Function called for each lifecycle event

**Returns:** Unsubscribe function

**LifecycleEvent types:**
```typescript
type LifecycleEvent =
  | { type: 'started'; ref: GenServerRef }
  | { type: 'crashed'; ref: GenServerRef; error: Error }
  | { type: 'terminated'; ref: GenServerRef; reason: TerminateReason };
```

**Example:**
```typescript
const unsubscribe = GenServer.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Started: ${event.ref.id}`);
      break;
    case 'crashed':
      console.error(`Crashed: ${event.ref.id}`, event.error);
      break;
    case 'terminated':
      console.log(`Terminated: ${event.ref.id}`, event.reason);
      break;
  }
});

// Later: stop listening
unsubscribe();
```

---

## Behavior Callbacks

### init()

Called once when the server starts to initialize state.

```typescript
init(): State | Promise<State>
```

**Returns:** Initial state (sync or async)

**Throws:** Any error prevents server from starting

**Example:**
```typescript
// Synchronous
init: () => ({ count: 0, items: [] })

// Asynchronous
init: async () => {
  const data = await loadFromDatabase();
  return { data, ready: true };
}
```

---

### handleCall()

Handles synchronous call messages.

```typescript
handleCall(
  msg: CallMsg,
  state: State,
): CallResult<CallReply, State> | Promise<CallResult<CallReply, State>>
```

**Parameters:**
- `msg` - The call message
- `state` - Current server state

**Returns:** Tuple of `[reply, newState]`

**Example:**
```typescript
handleCall: (msg, state) => {
  switch (msg.type) {
    case 'get':
      return [state.value, state];
    case 'getAndIncrement':
      return [state.value, { ...state, value: state.value + 1 }];
    default:
      return [null, state];
  }
}
```

---

### handleCast()

Handles asynchronous cast messages.

```typescript
handleCast(msg: CastMsg, state: State): State | Promise<State>
```

**Parameters:**
- `msg` - The cast message
- `state` - Current server state

**Returns:** New state

**Example:**
```typescript
handleCast: (msg, state) => {
  switch (msg.type) {
    case 'increment':
      return { ...state, count: state.count + 1 };
    case 'reset':
      return { ...state, count: 0 };
    default:
      return state;
  }
}
```

---

### terminate()

Called during graceful shutdown for cleanup. Optional.

```typescript
terminate?(reason: TerminateReason, state: State): void | Promise<void>
```

**Parameters:**
- `reason` - Why the server is terminating
- `state` - Final server state

**Example:**
```typescript
terminate: async (reason, state) => {
  console.log(`Shutting down: ${reason}`);
  await state.connection?.close();
  clearInterval(state.timer);
}
```

---

## Error Classes

### CallTimeoutError

```typescript
class CallTimeoutError extends Error {
  readonly name = 'CallTimeoutError';
  readonly serverId: string;
  readonly timeoutMs: number;
}
```

### ServerNotRunningError

```typescript
class ServerNotRunningError extends Error {
  readonly name = 'ServerNotRunningError';
  readonly serverId: string;
}
```

### InitializationError

```typescript
class InitializationError extends Error {
  readonly name = 'InitializationError';
  readonly serverId: string;
  readonly cause: Error;
}
```

---

## Complete Example

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

// Define types
interface CounterState {
  value: number;
  history: number[];
}

type CounterCall =
  | { type: 'get' }
  | { type: 'getHistory' };

type CounterCast =
  | { type: 'increment'; by?: number }
  | { type: 'decrement'; by?: number }
  | { type: 'reset' };

type CounterReply = number | number[];

// Define behavior
const counterBehavior: GenServerBehavior<
  CounterState,
  CounterCall,
  CounterCast,
  CounterReply
> = {
  init: () => ({
    value: 0,
    history: [],
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.value, state];
      case 'getHistory':
        return [state.history, state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'increment': {
        const by = msg.by ?? 1;
        return {
          value: state.value + by,
          history: [...state.history, state.value + by],
        };
      }
      case 'decrement': {
        const by = msg.by ?? 1;
        return {
          value: state.value - by,
          history: [...state.history, state.value - by],
        };
      }
      case 'reset':
        return { value: 0, history: [] };
    }
  },

  terminate: (reason, state) => {
    console.log(`Counter terminated with value ${state.value}`);
  },
};

// Usage
async function main() {
  const counter = await GenServer.start(counterBehavior);

  GenServer.cast(counter, { type: 'increment' });
  GenServer.cast(counter, { type: 'increment', by: 5 });
  GenServer.cast(counter, { type: 'decrement', by: 2 });

  const value = await GenServer.call(counter, { type: 'get' });
  console.log('Value:', value);  // 4

  const history = await GenServer.call(counter, { type: 'getHistory' });
  console.log('History:', history);  // [1, 6, 4]

  await GenServer.stop(counter);
}
```

## Related

- [GenServer Concepts](../concepts/genserver.md) - Understanding GenServer
- [Supervisor API](./supervisor.md) - Fault tolerance
- [Registry API](./registry.md) - Named process lookup
- [Types Reference](./types.md) - All type definitions
- [Errors Reference](./errors.md) - All error classes
