# Remote Messaging

Remote messaging enables transparent communication between GenServer instances across cluster nodes. The `RemoteCall` module provides `call()` and `cast()` operations that mirror the local GenServer API, automatically handling serialization, routing, and timeout management.

## Overview

Remote messaging in noex follows the Erlang model where process communication is location-transparent. Whether a GenServer runs locally or on a remote node, the calling code remains identical:

```typescript
import { RemoteCall } from 'noex/distribution';

// Synchronous call - waits for response
const result = await RemoteCall.call(ref, { type: 'get_status' });

// Asynchronous cast - fire-and-forget
RemoteCall.cast(ref, { type: 'increment' });
```

Key characteristics:

- **Location transparency**: Same API for local and remote processes
- **Automatic serialization**: Messages are transparently serialized/deserialized
- **Timeout handling**: Built-in timeout management for calls
- **Failure isolation**: Network errors don't crash the caller

## RemoteCall.call()

Synchronous remote calls send a message and wait for a response. The operation blocks until the remote GenServer processes the message and returns a reply.

### Basic Usage

```typescript
import { RemoteCall, type SerializedRef } from 'noex/distribution';

// ref contains target GenServer's id and nodeId
const ref: SerializedRef = {
  id: 'counter-1',
  nodeId: 'worker@192.168.1.10:4369',
};

// Make a typed call
interface CounterMsg { type: 'get' | 'increment' }
interface CounterReply { value: number }

const reply = await RemoteCall.call<CounterReply>(ref, { type: 'get' });
console.log(`Counter value: ${reply.value}`);
```

### Timeout Configuration

By default, calls use the heartbeat interval as timeout (5 seconds). For operations that may take longer, specify an explicit timeout:

```typescript
// Long-running operation with 30-second timeout
const result = await RemoteCall.call(ref, { type: 'heavy_computation' }, {
  timeout: 30000,
});
```

### Flow Diagram

```
┌──────────┐     ┌───────────┐     ┌───────────┐     ┌──────────┐
│  Caller  │     │  Node A   │     │  Node B   │     │ GenServer│
└────┬─────┘     └─────┬─────┘     └─────┬─────┘     └────┬─────┘
     │                 │                 │                 │
     │ call(ref, msg)  │                 │                 │
     │────────────────►│                 │                 │
     │                 │   CallMessage   │                 │
     │                 │────────────────►│                 │
     │                 │                 │  handleCall()   │
     │                 │                 │────────────────►│
     │                 │                 │                 │
     │                 │                 │     reply       │
     │                 │                 │◄────────────────│
     │                 │ CallReplyMessage│                 │
     │                 │◄────────────────│                 │
     │  Promise<Reply> │                 │                 │
     │◄────────────────│                 │                 │
     │                 │                 │                 │
```

### Error Handling

Remote calls can fail in several ways:

```typescript
import {
  RemoteCall,
  NodeNotReachableError,
  RemoteCallTimeoutError,
  RemoteServerNotRunningError,
} from 'noex/distribution';

try {
  const result = await RemoteCall.call(ref, { type: 'get' }, {
    timeout: 5000,
  });
} catch (error) {
  if (error instanceof NodeNotReachableError) {
    // Target node is disconnected from cluster
    console.error(`Node ${error.nodeId} is unreachable`);
  } else if (error instanceof RemoteCallTimeoutError) {
    // Call timed out - server may be overloaded or stuck
    console.error(
      `Call to ${error.serverId} timed out after ${error.timeoutMs}ms`
    );
  } else if (error instanceof RemoteServerNotRunningError) {
    // Target GenServer doesn't exist or has stopped
    console.error(
      `Server ${error.serverId} not running on ${error.nodeId}`
    );
  }
}
```

## RemoteCall.cast()

Asynchronous casts send a message without waiting for a response. The operation returns immediately, and delivery is best-effort.

### Basic Usage

```typescript
import { RemoteCall } from 'noex/distribution';

// Fire-and-forget message
RemoteCall.cast(ref, { type: 'log', message: 'User action completed' });

// No await needed - returns void
```

### Cast Semantics

Casts have different semantics than calls:

| Aspect | call() | cast() |
|--------|--------|--------|
| Return value | Promise with reply | void |
| Blocking | Yes, waits for response | No |
| Delivery guarantee | Acknowledged | Best-effort |
| Node down behavior | Throws error | Silently dropped |
| Timeout | Configurable | N/A |

### When to Use Cast

Use `cast()` when:

- Response is not needed (logging, metrics, notifications)
- Latency is critical and acknowledgment can be skipped
- Message loss is acceptable

```typescript
// Good use case: Broadcasting notifications
function notifyAllUsers(users: SerializedRef[], message: string): void {
  for (const user of users) {
    RemoteCall.cast(user, { type: 'notification', message });
  }
}

// Good use case: Metrics collection
RemoteCall.cast(metricsCollector, {
  type: 'record',
  metric: 'api_request',
  value: responseTime,
});
```

## Serialization

Messages crossing node boundaries are serialized using JSON with type preservation for common JavaScript types.

### Supported Types

| Type | Serialization |
|------|---------------|
| `null`, `undefined` | Preserved with type markers |
| `boolean`, `number`, `string` | Native JSON |
| `Date` | ISO string with type marker |
| `Error` | Name, message, stack preserved |
| `Array`, `Object` | Recursive serialization |
| `Map`, `Set` | Converted to entries/values array |
| `RegExp` | Source and flags preserved |
| `BigInt` | String representation with type marker |

### Unsupported Types

| Type | Reason |
|------|--------|
| Functions | Cannot be serialized |
| Class instances | Lose prototype chain |
| Symbols | Not serializable |
| Circular references | Would cause infinite recursion |
| WeakMap, WeakSet | Cannot enumerate entries |

### Serialization Examples

```typescript
// Supported - works correctly
await RemoteCall.call(ref, {
  type: 'update',
  timestamp: new Date(),           // Preserved as Date
  data: new Map([['key', 'value']]), // Preserved as Map
  pattern: /\d+/g,                 // Preserved as RegExp
  count: BigInt(9007199254740993), // Preserved as BigInt
});

// Unsupported - will fail or lose data
await RemoteCall.call(ref, {
  callback: () => console.log('done'), // Error: functions cannot be serialized
  instance: new MyClass(),              // Loses prototype, becomes plain object
});
```

### Custom Serialization

For complex types, serialize explicitly:

```typescript
// Before sending
const message = {
  type: 'update',
  user: {
    id: user.id,
    name: user.name,
    // Don't include methods or internal state
  },
};

await RemoteCall.call(ref, message);
```

## SerializedRef

The `SerializedRef` type represents a GenServer reference that can be sent across the network.

### Structure

```typescript
interface SerializedRef {
  /** Unique GenServer instance ID */
  readonly id: string;

  /** Node where the GenServer is running */
  readonly nodeId: NodeId;
}
```

### Creating SerializedRef

References are typically obtained from:

1. **RemoteSpawn result**: When spawning a remote process
2. **GlobalRegistry lookup**: When finding a named process
3. **Manual construction**: When you know the server ID and node

```typescript
import { GenServer } from 'noex';
import { Cluster, GlobalRegistry, RemoteSpawn } from 'noex/distribution';

// From RemoteSpawn
const spawnResult = await RemoteSpawn.spawn('worker', targetNodeId);
const ref = spawnResult.ref;

// From GlobalRegistry
const ref = GlobalRegistry.whereis('coordinator');

// Manual construction (when you know the IDs)
const ref: SerializedRef = {
  id: serverId,
  nodeId: 'worker@192.168.1.10:4369',
};
```

### Local vs Remote Detection

Check if a reference points to the local node:

```typescript
import { Cluster } from 'noex/distribution';

function isLocalRef(ref: SerializedRef): boolean {
  return ref.nodeId === Cluster.getLocalNodeId();
}

// Smart routing based on location
function smartCall<T>(ref: SerializedRef, msg: unknown): Promise<T> {
  if (isLocalRef(ref)) {
    const localRef = GenServer._getRefById(ref.id);
    if (localRef) {
      return GenServer.call(localRef, msg);
    }
  }
  return RemoteCall.call(ref, msg);
}
```

## Wire Protocol

Understanding the wire protocol helps with debugging and monitoring.

### Message Types

```typescript
// Synchronous call request
interface CallMessage {
  type: 'call';
  callId: string;      // Unique correlation ID
  ref: SerializedRef;  // Target server
  msg: unknown;        // Serialized payload
  timeoutMs: number;   // Timeout for this call
  sentAt: number;      // Unix timestamp
}

// Successful call reply
interface CallReplyMessage {
  type: 'call_reply';
  callId: string;      // Matching correlation ID
  result: unknown;     // Serialized reply
}

// Error reply
interface CallErrorMessage {
  type: 'call_error';
  callId: string;      // Matching correlation ID
  errorType: 'server_not_running' | 'call_timeout' | 'unknown_error';
  message: string;     // Human-readable error
}

// Fire-and-forget cast
interface CastMessage {
  type: 'cast';
  ref: SerializedRef;  // Target server
  msg: unknown;        // Serialized payload
}
```

### Message Envelope

All messages are wrapped in an envelope for routing and authentication:

```typescript
interface MessageEnvelope {
  version: 1;           // Protocol version
  from: NodeId;         // Sender node
  timestamp: number;    // Unix timestamp
  signature?: string;   // HMAC-SHA256 when clusterSecret is set
  payload: ClusterMessage;
}
```

### Framing

Messages use length-prefix framing for reliable TCP transmission:

```
┌────────────┬───────────────────────────────────────┐
│  4 bytes   │          N bytes                      │
│  (length)  │          (JSON payload)               │
└────────────┴───────────────────────────────────────┘
```

- Length: 32-bit unsigned big-endian integer
- Maximum message size: 16 MB

## Statistics

Monitor remote call performance with built-in statistics:

```typescript
import { RemoteCall } from 'noex/distribution';

const stats = RemoteCall.getStats();
console.log(`Pending calls: ${stats.pendingCalls}`);
console.log(`Total calls: ${stats.totalCalls}`);
console.log(`Resolved: ${stats.totalResolved}`);
console.log(`Rejected: ${stats.totalRejected}`);
console.log(`Timed out: ${stats.totalTimedOut}`);
console.log(`Casts sent: ${stats.totalCasts}`);
```

### Stats Interface

```typescript
interface RemoteCallStats {
  /** Number of currently pending calls */
  pendingCalls: number;

  /** Total calls initiated since start */
  totalCalls: number;

  /** Calls that received successful replies */
  totalResolved: number;

  /** Calls that failed with errors */
  totalRejected: number;

  /** Calls that exceeded timeout */
  totalTimedOut: number;

  /** Total casts sent */
  totalCasts: number;
}
```

## Best Practices

### 1. Always Use Explicit Timeouts for Critical Operations

```typescript
// Default timeout may be too short for complex operations
const result = await RemoteCall.call(ref, msg, {
  timeout: 10000, // 10 seconds
});
```

### 2. Handle All Error Cases

```typescript
async function safeRemoteCall<T>(
  ref: SerializedRef,
  msg: unknown,
): Promise<T | null> {
  try {
    return await RemoteCall.call<T>(ref, msg, { timeout: 5000 });
  } catch (error) {
    if (error instanceof NodeNotReachableError) {
      // Node disconnected - may need to find alternative
      return null;
    }
    if (error instanceof RemoteServerNotRunningError) {
      // Server crashed - may need to respawn
      return null;
    }
    if (error instanceof RemoteCallTimeoutError) {
      // Server overloaded - consider backoff
      return null;
    }
    throw error; // Unexpected error
  }
}
```

### 3. Use Cast for Non-Critical Messages

```typescript
// Logging - no need to wait
RemoteCall.cast(logger, { type: 'log', level: 'info', message: 'Action completed' });

// Metrics - loss acceptable
RemoteCall.cast(metrics, { type: 'increment', counter: 'requests' });

// Notifications - best effort
RemoteCall.cast(user, { type: 'notify', message: 'New message received' });
```

### 4. Keep Messages Serializable

```typescript
// Good: Plain data
const message = {
  type: 'update',
  userId: user.id,
  changes: { name: 'New Name' },
};

// Bad: Functions, class instances
const message = {
  type: 'update',
  user: user,              // May contain methods
  callback: handleResult,  // Cannot serialize
};
```

### 5. Monitor Pending Calls

```typescript
// Alert if too many pending calls (potential memory leak or deadlock)
setInterval(() => {
  const stats = RemoteCall.getStats();
  if (stats.pendingCalls > 1000) {
    console.warn(`High pending call count: ${stats.pendingCalls}`);
  }
}, 10000);
```

### 6. Use Smart Routing for Mixed Clusters

```typescript
import { GenServer } from 'noex';
import { Cluster, RemoteCall, type SerializedRef } from 'noex/distribution';

/**
 * Routes calls optimally based on process location.
 * Uses local GenServer.call for local processes (faster, no serialization).
 * Uses RemoteCall.call for remote processes.
 */
async function smartCall<T>(ref: SerializedRef, msg: unknown): Promise<T> {
  const localNodeId = Cluster.getLocalNodeId();

  if (ref.nodeId === localNodeId) {
    const localRef = GenServer._getRefById(ref.id);
    if (localRef) {
      return GenServer.call(localRef, msg);
    }
  }

  return RemoteCall.call(ref, msg);
}

/**
 * Casts to a process using the optimal path.
 */
function smartCast(ref: SerializedRef, msg: unknown): void {
  const localNodeId = Cluster.getLocalNodeId();

  if (ref.nodeId === localNodeId) {
    const localRef = GenServer._getRefById(ref.id);
    if (localRef) {
      GenServer.cast(localRef, msg);
      return;
    }
  }

  RemoteCall.cast(ref, msg);
}
```

## Comparison with Local GenServer

| Feature | GenServer.call/cast | RemoteCall.call/cast |
|---------|--------------------|--------------------|
| Target | GenServerRef | SerializedRef |
| Network | No | Yes (TCP) |
| Serialization | None | JSON with type markers |
| Default timeout | 5000ms | 5000ms (heartbeat interval) |
| Failure modes | Server errors | + Network errors |
| Performance | ~microseconds | ~milliseconds |

## Related

- [Overview](./overview.md) - Distribution architecture
- [Cluster](./cluster.md) - Node discovery and membership
- [Global Registry](./global-registry.md) - Cluster-wide naming
- [RemoteCall API Reference](../api/remote-call.md) - Complete API

---

*[Czech version](../../cs/distribution/concepts/remote-messaging.md)*
