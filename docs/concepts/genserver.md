# GenServer

GenServer (Generic Server) is the foundational abstraction in noex for building stateful, concurrent services. It provides a process-like model inspired by Elixir/OTP, bringing battle-tested patterns to TypeScript.

## Overview

A GenServer encapsulates:
- **State** - Internal data that persists across messages
- **Message handling** - Serialized processing of incoming requests
- **Lifecycle management** - Initialization, running, and graceful shutdown

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

// Define behavior
const counterBehavior: GenServerBehavior<number, 'get', 'increment', number> = {
  init: () => 0,
  handleCall: (msg, state) => [state, state],      // Returns [reply, newState]
  handleCast: (msg, state) => state + 1,           // Returns newState
};

// Start and use
const counter = await GenServer.start(counterBehavior);
await GenServer.cast(counter, 'increment');
const value = await GenServer.call(counter, 'get');  // 1
await GenServer.stop(counter);
```

## Core Concepts

### Message Serialization

All messages are processed sequentially through an internal queue. This eliminates race conditions and makes state changes predictable:

```
Message Queue: [msg1] → [msg2] → [msg3]
                 ↓
              Process msg1, update state
                 ↓
              Process msg2, update state
                 ↓
              Process msg3, update state
```

Even with concurrent callers, each message is handled one at a time:

```typescript
// These calls are queued and processed sequentially
await Promise.all([
  GenServer.call(counter, 'get'),
  GenServer.cast(counter, 'increment'),
  GenServer.call(counter, 'get'),
]);
```

### Call vs Cast

GenServer supports two message patterns:

| Pattern | Method | Blocking | Returns | Use Case |
|---------|--------|----------|---------|----------|
| **Call** | `GenServer.call()` | Yes | Reply value | Queries, operations requiring confirmation |
| **Cast** | `GenServer.cast()` | No | void | Fire-and-forget updates, notifications |

#### Call - Synchronous Request/Reply

Calls block until the server processes the message and returns a reply:

```typescript
const behavior: GenServerBehavior<Map<string, string>, GetMsg | SetMsg, never, string | void> = {
  init: () => new Map(),
  handleCall: (msg, state) => {
    if (msg.type === 'get') {
      return [state.get(msg.key), state];
    }
    if (msg.type === 'set') {
      state.set(msg.key, msg.value);
      return [undefined, state];
    }
    return [undefined, state];
  },
  handleCast: (_, state) => state,
};

// Caller waits for response
const value = await GenServer.call(server, { type: 'get', key: 'foo' });
```

#### Cast - Asynchronous Fire-and-Forget

Casts return immediately without waiting:

```typescript
const loggerBehavior: GenServerBehavior<string[], never, LogMsg, never> = {
  init: () => [],
  handleCall: (_, state) => [undefined as never, state],
  handleCast: (msg, state) => {
    console.log(msg.message);
    return [...state, msg.message];
  },
};

// Returns immediately, doesn't wait for processing
GenServer.cast(logger, { message: 'User logged in' });
```

### GenServerBehavior Interface

Every GenServer requires a behavior object implementing four callbacks:

```typescript
interface GenServerBehavior<State, CallMsg, CastMsg, CallReply> {
  // Required: Initialize state
  init(): State | Promise<State>;

  // Required: Handle synchronous calls
  handleCall(msg: CallMsg, state: State): CallResult<CallReply, State> | Promise<CallResult<CallReply, State>>;

  // Required: Handle asynchronous casts
  handleCast(msg: CastMsg, state: State): State | Promise<State>;

  // Optional: Cleanup on shutdown
  terminate?(reason: TerminateReason, state: State): void | Promise<void>;
}
```

#### init()

Called once when the server starts. Returns the initial state.

```typescript
init: () => ({
  connections: new Map(),
  startedAt: Date.now(),
})
```

Async initialization is supported:

```typescript
init: async () => {
  const config = await loadConfig();
  return { config, ready: true };
}
```

#### handleCall(msg, state)

Processes synchronous messages. Must return a tuple `[reply, newState]`:

```typescript
handleCall: (msg, state) => {
  switch (msg.type) {
    case 'get_count':
      return [state.count, state];  // Reply with count, state unchanged
    case 'increment':
      const newState = { ...state, count: state.count + 1 };
      return [newState.count, newState];  // Reply with new count
    default:
      return [null, state];
  }
}
```

#### handleCast(msg, state)

Processes asynchronous messages. Returns only the new state:

```typescript
handleCast: (msg, state) => {
  switch (msg.type) {
    case 'log':
      console.log(msg.data);
      return state;  // State unchanged
    case 'reset':
      return { ...state, count: 0 };  // State updated
    default:
      return state;
  }
}
```

#### terminate(reason, state)

Optional cleanup hook called during shutdown:

```typescript
terminate: async (reason, state) => {
  // Close connections
  for (const conn of state.connections.values()) {
    await conn.close();
  }
  // Flush pending data
  await state.buffer.flush();
  console.log(`Server terminated: ${reason}`);
}
```

## Lifecycle

A GenServer goes through these states:

```
[start] → initializing → running → stopping → stopped
              ↓                        ↓
          init() called         terminate() called
```

### Starting

```typescript
const ref = await GenServer.start(behavior, {
  name: 'my-server',      // Optional: register in Registry
  initTimeout: 5000,      // Optional: max time for init() (default: 5000ms)
});
```

### Checking Status

```typescript
if (GenServer.isRunning(ref)) {
  // Server is available
}
```

### Stopping

```typescript
// Graceful shutdown - waits for pending messages
await GenServer.stop(ref);

// With custom reason
await GenServer.stop(ref, 'shutdown');
```

## Timeouts

### Call Timeout

Calls have a default timeout of 5 seconds:

```typescript
try {
  // Default 5s timeout
  await GenServer.call(server, msg);

  // Custom timeout
  await GenServer.call(server, msg, { timeout: 10000 });
} catch (error) {
  if (error instanceof CallTimeoutError) {
    console.error('Call timed out');
  }
}
```

### Init Timeout

Server initialization also has a timeout:

```typescript
try {
  await GenServer.start(behavior, { initTimeout: 3000 });
} catch (error) {
  if (error instanceof InitializationError) {
    console.error('Init failed or timed out');
  }
}
```

## Error Handling

### In handleCall

Errors in `handleCall` are propagated to the caller:

```typescript
handleCall: (msg, state) => {
  if (!state.isReady) {
    throw new Error('Server not ready');
  }
  return [state.data, state];
}

// Caller receives the error
try {
  await GenServer.call(server, 'getData');
} catch (error) {
  // "Server not ready"
}
```

### In handleCast

Errors in `handleCast` are silently ignored (no caller to notify). Use lifecycle events for monitoring:

```typescript
GenServer.onLifecycleEvent((event) => {
  if (event.type === 'crashed') {
    console.error(`Server ${event.ref.id} crashed:`, event.error);
  }
});
```

### Server Not Running

Calling a stopped server throws `ServerNotRunningError`:

```typescript
await GenServer.stop(server);

try {
  await GenServer.call(server, msg);
} catch (error) {
  if (error instanceof ServerNotRunningError) {
    console.error('Server is stopped');
  }
}
```

## Type Safety

GenServer leverages TypeScript's type system for message safety:

```typescript
// Define message types
type CallMsg =
  | { type: 'get'; key: string }
  | { type: 'keys' };

type CastMsg =
  | { type: 'set'; key: string; value: string }
  | { type: 'delete'; key: string };

type CallReply = string | undefined | string[];

// State type
interface CacheState {
  data: Map<string, string>;
}

// Fully typed behavior
const behavior: GenServerBehavior<CacheState, CallMsg, CastMsg, CallReply> = {
  init: () => ({ data: new Map() }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.data.get(msg.key), state];
      case 'keys':
        return [Array.from(state.data.keys()), state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'set':
        state.data.set(msg.key, msg.value);
        return state;
      case 'delete':
        state.data.delete(msg.key);
        return state;
    }
  },
};
```

## Lifecycle Events

Monitor GenServer lifecycle with global handlers:

```typescript
const unsubscribe = GenServer.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Server started: ${event.ref.id}`);
      break;
    case 'crashed':
      console.log(`Server crashed: ${event.ref.id}`, event.error);
      break;
    case 'terminated':
      console.log(`Server terminated: ${event.ref.id}, reason: ${event.reason}`);
      break;
  }
});

// Later: stop listening
unsubscribe();
```

## Best Practices

### 1. Keep State Immutable

Prefer creating new state objects over mutation:

```typescript
// Good
handleCast: (msg, state) => ({
  ...state,
  count: state.count + 1,
})

// Avoid (mutation can cause subtle bugs)
handleCast: (msg, state) => {
  state.count++;
  return state;
}
```

### 2. Use Discriminated Unions for Messages

```typescript
type Msg =
  | { type: 'add'; item: string }
  | { type: 'remove'; id: number }
  | { type: 'clear' };

handleCast: (msg, state) => {
  switch (msg.type) {
    case 'add': // TypeScript knows msg has 'item'
    case 'remove': // TypeScript knows msg has 'id'
    case 'clear': // TypeScript knows msg has no extra fields
  }
}
```

### 3. Handle All Message Types

TypeScript's exhaustive checking helps:

```typescript
handleCall: (msg, state) => {
  switch (msg.type) {
    case 'get':
      return [state.value, state];
    case 'set':
      return [undefined, { ...state, value: msg.value }];
    default:
      // TypeScript error if cases are missing
      const _exhaustive: never = msg;
      return [undefined, state];
  }
}
```

### 4. Clean Up Resources

Always implement `terminate` if your server holds resources:

```typescript
terminate: async (reason, state) => {
  await state.dbConnection?.close();
  await state.fileHandle?.close();
  state.timers.forEach(clearInterval);
}
```

## Related

- [Supervisor](./supervisor.md) - Fault tolerance and automatic restarts
- [Registry](./registry.md) - Named process lookup
- [Lifecycle](./lifecycle.md) - Process lifecycle details
- [API Reference: GenServer](../api/genserver.md) - Complete API documentation
