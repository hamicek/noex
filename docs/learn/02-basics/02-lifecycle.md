# Process Lifecycle

Every GenServer goes through a well-defined lifecycle from birth to death. Understanding this lifecycle is essential for building robust applications that handle failures gracefully and clean up resources properly.

In this chapter, you'll learn about the states a GenServer transitions through, how to perform cleanup when a process terminates, and patterns for graceful shutdown.

## What You'll Learn

- The four states a GenServer goes through
- How to use the `terminate()` callback for cleanup
- The difference between graceful and forced termination
- Handling different termination reasons
- Patterns for resource cleanup

## Lifecycle States

A GenServer transitions through four distinct states during its lifetime:

```
┌──────────────┐      ┌─────────┐      ┌──────────┐      ┌─────────┐
│ initializing │ ──── │ running │ ──── │ stopping │ ──── │ stopped │
└──────────────┘      └─────────┘      └──────────┘      └─────────┘
       │                   │                 │
   init() runs         Messages are      terminate()
   State created       processed         runs
```

### initializing

When you call `GenServer.start()`, the server enters the `initializing` state. During this phase:

- The `init()` callback executes
- Initial state is created
- If `init()` throws or times out, the server fails to start
- No messages can be processed yet

```typescript
const ref = await GenServer.start({
  init() {
    console.log('Server is initializing...');
    return { count: 0 }; // Initial state
  },
  // ...
});
// At this point, initialization is complete and server is running
```

### running

Once `init()` completes successfully, the server transitions to `running`. In this state:

- Messages are processed from the queue
- `handleCall()` and `handleCast()` callbacks execute
- The server responds to all requests

This is where your server spends most of its lifetime.

### stopping

When `GenServer.stop()` is called, the server enters the `stopping` state:

- New messages are rejected with `ServerNotRunningError`
- The `terminate()` callback executes (if defined)
- Cleanup operations run

### stopped

The final state. The server:

- Is removed from the registry
- Cannot process any more messages
- Has released all resources

## The terminate() Callback

The `terminate()` callback is your opportunity to perform cleanup when a process ends. It receives the termination reason and the final state.

```typescript
import { GenServer, type GenServerBehavior, type TerminateReason } from '@hamicek/noex';

interface ConnectionState {
  socket: WebSocket | null;
  reconnectAttempts: number;
}

const connectionBehavior: GenServerBehavior<
  ConnectionState,
  { type: 'send'; data: string },
  { type: 'reconnect' },
  boolean
> = {
  init() {
    const socket = new WebSocket('wss://api.example.com');
    return { socket, reconnectAttempts: 0 };
  },

  handleCall(msg, state) {
    if (msg.type === 'send' && state.socket) {
      state.socket.send(msg.data);
      return [true, state];
    }
    return [false, state];
  },

  handleCast(msg, state) {
    return state;
  },

  // Cleanup when the server stops
  terminate(reason: TerminateReason, state: ConnectionState) {
    console.log('Server terminating:', reason);

    // Close the WebSocket connection
    if (state.socket) {
      state.socket.close(1000, 'Server shutting down');
    }

    console.log('Cleanup complete');
  },
};
```

### Async Cleanup

The `terminate()` callback can be asynchronous, allowing you to wait for cleanup operations:

```typescript
terminate: async (reason, state) => {
  // Wait for pending operations to complete
  await state.pendingWrite;

  // Flush buffers
  await state.fileHandle.flush();

  // Close file handle
  await state.fileHandle.close();

  console.log('File safely closed');
},
```

### Termination Reasons

The `reason` parameter tells you why the server is stopping:

```typescript
type TerminateReason =
  | 'normal'              // Normal, expected shutdown
  | 'shutdown'            // System-wide shutdown
  | { error: Error };     // Abnormal termination due to error
```

Handle different reasons appropriately:

```typescript
terminate(reason, state) {
  if (reason === 'normal') {
    console.log('Clean shutdown requested');
  } else if (reason === 'shutdown') {
    console.log('System is shutting down');
  } else {
    console.error('Terminated due to error:', reason.error.message);
    // Maybe log to error tracking service
  }

  // Cleanup code runs for all reasons
  state.connection?.close();
},
```

## Graceful vs Forced Termination

noex provides two ways to stop a GenServer:

### Graceful Shutdown

`GenServer.stop()` performs a graceful shutdown:

```typescript
// Normal shutdown
await GenServer.stop(ref);

// Shutdown with specific reason
await GenServer.stop(ref, 'shutdown');

// Shutdown due to error
await GenServer.stop(ref, { error: new Error('Configuration invalid') });
```

During graceful shutdown:

1. The server stops accepting new messages
2. Currently processing message completes
3. `terminate()` callback runs
4. Server is removed from registry

### Forced Termination

Supervisors use forced termination (`_forceTerminate`) when they need to stop a process immediately:

- Pending messages in the queue are rejected with `ServerNotRunningError`
- `terminate()` callback still runs (best-effort, errors ignored)
- Used when a supervisor needs to restart a failing child

You typically don't call `_forceTerminate` directly - let supervisors handle it.

## Lifecycle Events

You can observe lifecycle events for monitoring and debugging:

```typescript
const unsubscribe = GenServer.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Server ${event.ref.id} started`);
      break;
    case 'terminated':
      console.log(`Server ${event.ref.id} terminated:`, event.reason);
      break;
    case 'crashed':
      console.error(`Server ${event.ref.id} crashed:`, event.error);
      break;
  }
});

// Later, stop listening
unsubscribe();
```

This is useful for:

- Logging and monitoring
- Metrics collection
- Debugging startup/shutdown issues

## Complete Example

Here's a complete example demonstrating lifecycle management:

```typescript
// lifecycle-demo.ts
import { GenServer, type GenServerBehavior, type TerminateReason } from '@hamicek/noex';

interface DatabaseState {
  connections: number;
  queries: string[];
}

type CallMsg =
  | { type: 'query'; sql: string }
  | { type: 'getStats' };

type CastMsg = { type: 'log' };

type Reply = string[] | { connections: number; totalQueries: number };

const databaseBehavior: GenServerBehavior<DatabaseState, CallMsg, CastMsg, Reply> = {
  // 1. INITIALIZATION
  init() {
    console.log('[init] Connecting to database...');
    // Simulate connection setup
    return {
      connections: 5, // Connection pool
      queries: [],
    };
  },

  // 2. MESSAGE HANDLING (running state)
  handleCall(msg, state) {
    switch (msg.type) {
      case 'query': {
        console.log(`[handleCall] Executing: ${msg.sql}`);
        const newState = {
          ...state,
          queries: [...state.queries, msg.sql],
        };
        return [[msg.sql], newState]; // Return "results"
      }
      case 'getStats':
        return [
          { connections: state.connections, totalQueries: state.queries.length },
          state,
        ];
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'log') {
      console.log(`[handleCast] Total queries executed: ${state.queries.length}`);
    }
    return state;
  },

  // 3. CLEANUP (stopping state)
  terminate(reason: TerminateReason, state: DatabaseState) {
    console.log('[terminate] Shutting down database connection...');
    console.log(`[terminate] Reason: ${formatReason(reason)}`);
    console.log(`[terminate] Executed ${state.queries.length} queries during lifetime`);

    // Close all connections in the pool
    for (let i = 0; i < state.connections; i++) {
      console.log(`[terminate] Closing connection ${i + 1}/${state.connections}`);
    }

    console.log('[terminate] All connections closed');
  },
};

function formatReason(reason: TerminateReason): string {
  if (reason === 'normal') return 'normal shutdown';
  if (reason === 'shutdown') return 'system shutdown';
  return `error: ${reason.error.message}`;
}

async function main() {
  // Register lifecycle observer
  GenServer.onLifecycleEvent((event) => {
    console.log(`[lifecycle] ${event.type.toUpperCase()}`);
  });

  console.log('=== Starting server ===');
  const db = await GenServer.start(databaseBehavior);

  console.log('\n=== Running queries ===');
  await GenServer.call(db, { type: 'query', sql: 'SELECT * FROM users' });
  await GenServer.call(db, { type: 'query', sql: 'SELECT * FROM orders' });
  GenServer.cast(db, { type: 'log' });

  // Wait for cast to process
  await new Promise((r) => setTimeout(r, 10));

  const stats = await GenServer.call(db, { type: 'getStats' });
  console.log('\n=== Stats ===');
  console.log(stats);

  console.log('\n=== Stopping server ===');
  await GenServer.stop(db, 'shutdown');

  console.log('\n=== Server stopped ===');
}

main().catch(console.error);
```

Run with:

```bash
npx tsx lifecycle-demo.ts
```

Expected output:

```
=== Starting server ===
[init] Connecting to database...
[lifecycle] STARTED

=== Running queries ===
[handleCall] Executing: SELECT * FROM users
[handleCall] Executing: SELECT * FROM orders
[handleCast] Total queries executed: 2

=== Stats ===
{ connections: 5, totalQueries: 2 }

=== Stopping server ===
[terminate] Shutting down database connection...
[terminate] Reason: system shutdown
[terminate] Executed 2 queries during lifetime
[terminate] Closing connection 1/5
[terminate] Closing connection 2/5
[terminate] Closing connection 3/5
[terminate] Closing connection 4/5
[terminate] Closing connection 5/5
[terminate] All connections closed
[lifecycle] TERMINATED

=== Server stopped ===
```

## Best Practices

### 1. Always Clean Up External Resources

If your GenServer holds connections, file handles, or other external resources, always clean them up in `terminate()`:

```typescript
terminate(reason, state) {
  state.dbConnection?.end();
  state.redisClient?.quit();
  state.fileStream?.close();
},
```

### 2. Keep terminate() Fast

Avoid long-running operations in `terminate()`. If you need to persist state, use the persistence features (covered in a later chapter) instead of saving in `terminate()`.

### 3. Handle Cleanup Errors Gracefully

Wrap cleanup operations in try-catch to ensure all resources are released:

```typescript
terminate(reason, state) {
  try {
    state.primaryDb?.close();
  } catch (e) {
    console.error('Failed to close primary DB:', e);
  }

  try {
    state.replicaDb?.close();
  } catch (e) {
    console.error('Failed to close replica DB:', e);
  }
},
```

### 4. Don't Start New Operations in terminate()

The `terminate()` callback is for cleanup only. Don't start new work or send messages to other processes from here.

## Exercise

Create a **LoggerServer** that:

1. Opens a "log file" on startup (simulate with an array)
2. Has a `write(message)` cast that adds messages to the log
3. Has a `flush()` call that returns all messages and clears the buffer
4. On termination, prints all unwritten messages with "[UNFLUSHED]" prefix

Test it by writing some messages, flushing once, writing more, then stopping without flushing.

**Hints:**
- State should have `{ buffer: string[], flushed: string[] }`
- Use `terminate()` to handle unflushed messages

<details>
<summary>Solution</summary>

```typescript
import { GenServer, type GenServerBehavior, type TerminateReason } from '@hamicek/noex';

interface LoggerState {
  buffer: string[];
  totalFlushed: number;
}

type LoggerCallMsg = { type: 'flush' };
type LoggerCastMsg = { type: 'write'; message: string };
type LoggerReply = string[];

const loggerBehavior: GenServerBehavior<
  LoggerState,
  LoggerCallMsg,
  LoggerCastMsg,
  LoggerReply
> = {
  init() {
    console.log('[Logger] Initialized');
    return { buffer: [], totalFlushed: 0 };
  },

  handleCall(msg, state) {
    if (msg.type === 'flush') {
      const messages = [...state.buffer];
      console.log(`[Logger] Flushing ${messages.length} messages`);
      return [
        messages,
        { buffer: [], totalFlushed: state.totalFlushed + messages.length },
      ];
    }
    return [[], state];
  },

  handleCast(msg, state) {
    if (msg.type === 'write') {
      return {
        ...state,
        buffer: [...state.buffer, msg.message],
      };
    }
    return state;
  },

  terminate(reason: TerminateReason, state: LoggerState) {
    console.log(`[Logger] Terminating (reason: ${formatReason(reason)})`);
    console.log(`[Logger] Total flushed during lifetime: ${state.totalFlushed}`);

    if (state.buffer.length > 0) {
      console.log(`[Logger] ${state.buffer.length} unflushed messages:`);
      for (const msg of state.buffer) {
        console.log(`[UNFLUSHED] ${msg}`);
      }
    } else {
      console.log('[Logger] All messages were flushed');
    }
  },
};

function formatReason(reason: TerminateReason): string {
  if (reason === 'normal') return 'normal';
  if (reason === 'shutdown') return 'shutdown';
  return `error: ${reason.error.message}`;
}

async function main() {
  const logger = await GenServer.start(loggerBehavior);

  // Write some messages
  GenServer.cast(logger, { type: 'write', message: 'First log entry' });
  GenServer.cast(logger, { type: 'write', message: 'Second log entry' });

  // Wait for casts to process
  await new Promise((r) => setTimeout(r, 10));

  // Flush
  const flushed = await GenServer.call(logger, { type: 'flush' });
  console.log('Flushed messages:', flushed);

  // Write more without flushing
  GenServer.cast(logger, { type: 'write', message: 'Third log entry' });
  GenServer.cast(logger, { type: 'write', message: 'Fourth log entry' });

  await new Promise((r) => setTimeout(r, 10));

  // Stop without flushing - terminate() will show unflushed messages
  console.log('\n--- Stopping logger ---');
  await GenServer.stop(logger);
}

main();
```

Expected output:

```
[Logger] Initialized
Flushed messages: [ 'First log entry', 'Second log entry' ]

--- Stopping logger ---
[Logger] Terminating (reason: normal)
[Logger] Total flushed during lifetime: 2
[Logger] 2 unflushed messages:
[UNFLUSHED] Third log entry
[UNFLUSHED] Fourth log entry
```

</details>

## Summary

- GenServers transition through four states: **initializing** → **running** → **stopping** → **stopped**
- The **`terminate()`** callback is your chance to clean up resources when a process ends
- **Termination reasons** tell you why the process is stopping: `'normal'`, `'shutdown'`, or `{ error: Error }`
- **Graceful shutdown** (`GenServer.stop()`) allows the current message to complete and runs cleanup
- **Lifecycle events** let you observe when servers start and stop
- Always clean up external resources (connections, file handles) in `terminate()`

The lifecycle management in noex follows Erlang/OTP patterns, ensuring predictable behavior even under failure conditions. When combined with supervision (covered in Part 3), you get robust processes that clean up properly and can be restarted automatically.

---

Next: [Call vs Cast](./03-call-vs-cast.md)
