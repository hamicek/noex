# Process Lifecycle

Understanding the lifecycle of GenServers and Supervisors is essential for building robust applications. This document covers the states, transitions, and hooks available during a process's lifetime.

## GenServer Lifecycle

A GenServer goes through four distinct states:

```
                    ┌─────────────────┐
                    │   start()       │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │  initializing   │ ← init() called
                    └────────┬────────┘
                             │ success
                             ▼
                    ┌─────────────────┐
                    │    running      │ ← processing messages
                    └────────┬────────┘
                             │ stop() or crash
                             ▼
                    ┌─────────────────┐
                    │   stopping      │ ← terminate() called
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │    stopped      │
                    └─────────────────┘
```

### State: Initializing

When `GenServer.start()` is called:

1. A unique ID is generated
2. The `init()` callback is invoked
3. The server waits for initialization to complete

```typescript
const behavior = {
  init: async () => {
    // This runs during 'initializing' state
    const config = await loadConfig();
    const connection = await connectToDatabase();
    return { config, connection };
  },
  // ...
};

const ref = await GenServer.start(behavior);
// Server is now 'running'
```

#### Init Timeout

Initialization has a configurable timeout (default: 5 seconds):

```typescript
await GenServer.start(behavior, { initTimeout: 10000 });
```

If `init()` doesn't complete in time, an `InitializationError` is thrown.

#### Init Failure

If `init()` throws, the server never enters 'running' state:

```typescript
const behavior = {
  init: () => {
    throw new Error('Failed to initialize');
  },
  // ...
};

try {
  await GenServer.start(behavior);
} catch (error) {
  // InitializationError with cause
}
```

### State: Running

Once initialized, the server enters the 'running' state and begins processing messages:

- Messages are queued and processed sequentially
- `handleCall()` processes synchronous requests
- `handleCast()` processes asynchronous messages
- State is maintained between messages

```typescript
// Server is running - can receive messages
await GenServer.call(ref, { type: 'get' });
GenServer.cast(ref, { type: 'update', data: 'value' });
```

#### Message Queue

Messages are processed one at a time, in order:

```
Queue: [call:get] → [cast:update] → [call:save]
                ↓
        Process 'get', respond
                ↓
        Process 'update'
                ↓
        Process 'save', respond
```

### State: Stopping

When `GenServer.stop()` is called or a supervised restart occurs:

1. Status changes to 'stopping'
2. New messages are rejected
3. Pending messages complete processing
4. `terminate()` callback is invoked

```typescript
const behavior = {
  // ...
  terminate: async (reason, state) => {
    // Cleanup during 'stopping' state
    await state.connection.close();
    console.log(`Terminated: ${reason}`);
  },
};

await GenServer.stop(ref, 'normal');
```

#### Terminate Reasons

The `terminate()` callback receives a reason:

| Reason | Meaning |
|--------|---------|
| `'normal'` | Graceful shutdown via `stop()` |
| `'shutdown'` | Supervisor-initiated shutdown |
| `{ error: Error }` | Crashed due to exception |

```typescript
terminate: (reason, state) => {
  if (reason === 'normal') {
    console.log('Clean shutdown');
  } else if (reason === 'shutdown') {
    console.log('Supervisor stopped us');
  } else {
    console.error('Crashed:', reason.error);
  }
}
```

### State: Stopped

The final state. The server:
- No longer processes messages
- Is removed from the internal registry
- Cannot be restarted (a new server must be started)

```typescript
await GenServer.stop(ref);

GenServer.isRunning(ref);  // false

try {
  await GenServer.call(ref, 'get');
} catch (error) {
  // ServerNotRunningError
}
```

## Supervisor Lifecycle

Supervisors have a simpler lifecycle focused on managing children:

```
                    ┌─────────────────┐
                    │   start()       │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │    running      │ ← managing children
                    └────────┬────────┘
                             │ stop()
                             ▼
                    ┌─────────────────┐
                    │   stopped       │
                    └─────────────────┘
```

### Starting a Supervisor

When `Supervisor.start()` is called:

1. Supervisor instance is created
2. Children are started in order
3. Each child is monitored for crashes

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'first', start: () => GenServer.start(behavior1) },
    { id: 'second', start: () => GenServer.start(behavior2) },
  ],
});
```

If any child fails to start:
1. Already-started children are stopped (reverse order)
2. Supervisor startup fails with the error

### Supervisor Running

While running, the supervisor:
- Monitors all children for crashes
- Restarts crashed children based on strategy
- Tracks restart counts and intensity
- Allows dynamic child management

### Stopping a Supervisor

When `Supervisor.stop()` is called:

1. Children are stopped in reverse order (last started = first stopped)
2. Each child gets graceful shutdown with timeout
3. Supervisor is removed from registry

```typescript
await Supervisor.stop(supervisor);
// All children are now stopped
```

## Lifecycle Events

Both GenServers and Supervisors emit lifecycle events:

### GenServer Events

```typescript
const unsubscribe = GenServer.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Server ${event.ref.id} started`);
      break;
    case 'crashed':
      console.log(`Server ${event.ref.id} crashed:`, event.error);
      break;
    case 'terminated':
      console.log(`Server ${event.ref.id} terminated:`, event.reason);
      break;
  }
});

// Later: stop listening
unsubscribe();
```

### Supervisor Events

```typescript
const unsubscribe = Supervisor.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Supervisor ${event.ref.id} started`);
      break;
    case 'restarted':
      console.log(`Child restarted, attempt #${event.attempt}`);
      break;
    case 'terminated':
      console.log(`Terminated:`, event.reason);
      break;
  }
});
```

## Graceful Shutdown

### GenServer Shutdown

For clean shutdown, implement the `terminate()` callback:

```typescript
const behavior = {
  init: () => ({
    connections: new Map(),
    buffer: [],
    timer: setInterval(flush, 1000),
  }),

  // ... handleCall, handleCast ...

  terminate: async (reason, state) => {
    // 1. Stop timers
    clearInterval(state.timer);

    // 2. Flush pending data
    if (state.buffer.length > 0) {
      await flushToDatabase(state.buffer);
    }

    // 3. Close connections
    for (const conn of state.connections.values()) {
      await conn.close();
    }

    console.log('Cleanup complete');
  },
};
```

### Supervisor Shutdown Order

Children stop in reverse order to respect dependencies:

```typescript
const supervisor = await Supervisor.start({
  children: [
    { id: 'database', start: ... },   // Started 1st, stopped last
    { id: 'cache', start: ... },      // Started 2nd, stopped 2nd
    { id: 'api', start: ... },        // Started 3rd, stopped first
  ],
});

await Supervisor.stop(supervisor);
// Order: api → cache → database
```

### Shutdown Timeout

Each child has a shutdown timeout:

```typescript
{
  id: 'slow-service',
  start: () => GenServer.start(behavior),
  shutdownTimeout: 30000,  // 30 seconds to clean up
}
```

If a child doesn't stop within the timeout, it's force-terminated.

## Force Termination

In some cases, processes are forcefully terminated:

1. **Shutdown timeout exceeded** - Child doesn't stop gracefully in time
2. **Supervisor restart** - When strategy requires stopping running children
3. **Max restarts exceeded** - Supervisor gives up on failing children

Force termination:
- Skips remaining queue processing
- Rejects all pending calls with `ServerNotRunningError`
- Calls `terminate()` as best-effort (errors ignored)

## Process Health

### Checking if Running

```typescript
// GenServer
if (GenServer.isRunning(ref)) {
  await GenServer.call(ref, msg);
}

// Supervisor
if (Supervisor.isRunning(supervisorRef)) {
  await Supervisor.startChild(supervisorRef, spec);
}
```

### Getting Statistics

```typescript
import { Observer } from 'noex';

// Start observing
Observer.start({ interval: 1000 });

// Get server stats
const stats = Observer.getServerStats(ref.id);
console.log(`Uptime: ${stats.uptimeMs}ms`);
console.log(`Messages processed: ${stats.messageCount}`);
console.log(`Queue size: ${stats.queueSize}`);
```

## Lifecycle Best Practices

### 1. Keep init() Fast

```typescript
// Good: Fast synchronous init
init: () => ({ data: new Map(), ready: false })

// Then load data asynchronously via cast
// GenServer.cast(ref, 'load-data');

// Avoid: Slow blocking init
init: async () => {
  const data = await fetchFromSlowAPI();  // Might timeout
  return { data };
}
```

### 2. Always Implement terminate()

```typescript
// Good: Clean up resources
terminate: async (reason, state) => {
  await state.db?.close();
  clearInterval(state.timer);
}

// Avoid: Leaving resources open
// (no terminate callback)
```

### 3. Handle All Terminate Reasons

```typescript
terminate: (reason, state) => {
  const isGraceful = reason === 'normal' || reason === 'shutdown';

  if (isGraceful) {
    // Can take time to flush data
    return flushData(state.buffer);
  } else {
    // Crash - just log, cleanup may be unsafe
    console.error('Crashed:', reason.error);
  }
}
```

### 4. Use Lifecycle Events for Monitoring

```typescript
// Set up monitoring once at startup
GenServer.onLifecycleEvent((event) => {
  metrics.record('process_lifecycle', {
    type: event.type,
    processId: event.ref.id,
    timestamp: Date.now(),
  });
});
```

## Related

- [GenServer](./genserver.md) - GenServer fundamentals
- [Supervisor](./supervisor.md) - Supervision and fault tolerance
- [Error Handling](./error-handling.md) - What happens when things go wrong
- [Debugging](../guides/debugging.md) - Tools for inspecting running processes
