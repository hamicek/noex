# RemoteCall API Reference

The `RemoteCall` object provides transparent message passing between GenServer instances across cluster nodes. It handles serialization, timeout management, and error handling for cross-node communication.

## Import

```typescript
import { RemoteCall } from 'noex/distribution';
```

## Types

### SerializedRef

Serializable representation of a GenServerRef for network transmission.

```typescript
interface SerializedRef {
  readonly id: string;
  readonly nodeId: NodeId;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | GenServer instance identifier |
| `nodeId` | `NodeId` | Node where the GenServer is running |

### RemoteCallOptions

Options for remote call operations.

```typescript
interface RemoteCallOptions {
  readonly timeout?: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeout` | `number` | `5000` | Timeout in milliseconds |

### RemoteCallStats

Statistics about remote call operations.

```typescript
interface RemoteCallStats {
  readonly pendingCalls: number;
  readonly totalCalls: number;
  readonly totalResolved: number;
  readonly totalRejected: number;
  readonly totalTimedOut: number;
  readonly totalCasts: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `pendingCalls` | `number` | Number of calls awaiting response |
| `totalCalls` | `number` | Total calls initiated |
| `totalResolved` | `number` | Total calls that resolved successfully |
| `totalRejected` | `number` | Total calls that were rejected with error |
| `totalTimedOut` | `number` | Total calls that timed out |
| `totalCasts` | `number` | Total casts sent |

---

## Methods

### call()

Sends a synchronous call to a remote GenServer and awaits the response.

```typescript
async call<CallReply>(
  ref: SerializedRef,
  msg: unknown,
  options?: RemoteCallOptions,
): Promise<CallReply>
```

**Parameters:**
- `ref` - Serialized reference to the target GenServer
- `msg` - Message to send (must be serializable)
- `options` - Call options

**Returns:** Promise resolving to the call reply

**Throws:**
- `ClusterNotStartedError` - If cluster is not running
- `NodeNotReachableError` - If target node is not connected
- `RemoteCallTimeoutError` - If call times out
- `RemoteServerNotRunningError` - If target server is not running

**Example:**
```typescript
const ref: SerializedRef = {
  id: 'counter-1',
  nodeId: NodeId.parse('worker@192.168.1.10:4369'),
};

try {
  const count = await RemoteCall.call<number>(ref, { type: 'get' });
  console.log(`Current count: ${count}`);
} catch (error) {
  if (error instanceof RemoteCallTimeoutError) {
    console.log('Call timed out');
  }
}
```

**With timeout:**
```typescript
const result = await RemoteCall.call(ref, message, { timeout: 10000 });
```

---

### cast()

Sends an asynchronous cast (fire-and-forget) to a remote GenServer.

```typescript
cast(ref: SerializedRef, msg: unknown): void
```

**Parameters:**
- `ref` - Serialized reference to the target GenServer
- `msg` - Message to send (must be serializable)

The cast is silently dropped if:
- Cluster is not running
- Target node is not connected

**Example:**
```typescript
const ref: SerializedRef = {
  id: 'counter-1',
  nodeId: NodeId.parse('worker@192.168.1.10:4369'),
};

// Fire and forget
RemoteCall.cast(ref, { type: 'increment' });
```

---

### getStats()

Returns statistics about remote call operations.

```typescript
getStats(): RemoteCallStats
```

**Returns:** Statistics object

**Example:**
```typescript
const stats = RemoteCall.getStats();
console.log(`Pending: ${stats.pendingCalls}`);
console.log(`Success rate: ${stats.totalResolved / stats.totalCalls * 100}%`);
```

---

## Error Classes

### RemoteCallTimeoutError

```typescript
class RemoteCallTimeoutError extends Error {
  readonly name = 'RemoteCallTimeoutError';
  readonly serverId: string;
  readonly nodeId: NodeId;
  readonly timeoutMs: number;
}
```

Thrown when a remote call does not receive a response within the timeout period.

### RemoteServerNotRunningError

```typescript
class RemoteServerNotRunningError extends Error {
  readonly name = 'RemoteServerNotRunningError';
  readonly serverId: string;
  readonly nodeId: NodeId;
}
```

Thrown when the target GenServer is not running on the remote node.

### NodeNotReachableError

```typescript
class NodeNotReachableError extends Error {
  readonly name = 'NodeNotReachableError';
  readonly nodeId: NodeId;
}
```

Thrown when the target node is not connected.

---

## Complete Example

```typescript
import { Cluster, RemoteCall, GlobalRegistry, NodeId } from 'noex/distribution';
import type { SerializedRef } from 'noex/distribution';

// Counter message types
type CounterCall = { type: 'get' } | { type: 'increment' };
type CounterReply = number;

async function main() {
  await Cluster.start({
    nodeName: 'client',
    seeds: ['server@192.168.1.10:4369'],
  });

  // Wait for connection
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Get the counter reference from global registry
  const counterRef = GlobalRegistry.whereis('main-counter');
  if (!counterRef) {
    console.log('Counter not registered');
    return;
  }

  // Make remote calls
  try {
    // Get current value
    const count = await RemoteCall.call<CounterReply>(
      counterRef,
      { type: 'get' },
      { timeout: 5000 },
    );
    console.log(`Initial count: ${count}`);

    // Increment (using cast for fire-and-forget)
    RemoteCall.cast(counterRef, { type: 'increment' });
    RemoteCall.cast(counterRef, { type: 'increment' });
    RemoteCall.cast(counterRef, { type: 'increment' });

    // Small delay for casts to process
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Get new value
    const newCount = await RemoteCall.call<CounterReply>(
      counterRef,
      { type: 'get' },
    );
    console.log(`New count: ${newCount}`);

  } catch (error) {
    if (error instanceof RemoteCallTimeoutError) {
      console.error(`Timeout calling ${error.serverId} on ${error.nodeId}`);
    } else if (error instanceof RemoteServerNotRunningError) {
      console.error(`Server ${error.serverId} not running on ${error.nodeId}`);
    } else if (error instanceof NodeNotReachableError) {
      console.error(`Node ${error.nodeId} not reachable`);
    } else {
      throw error;
    }
  }

  // Print statistics
  const stats = RemoteCall.getStats();
  console.log(`\nRemote call stats:`);
  console.log(`  Total calls: ${stats.totalCalls}`);
  console.log(`  Resolved: ${stats.totalResolved}`);
  console.log(`  Total casts: ${stats.totalCasts}`);

  await Cluster.stop();
}

main().catch(console.error);
```

---

## Usage with GenServer

When working with GenServer, you can convert a GenServerRef to SerializedRef:

```typescript
import { GenServer } from 'noex';
import { Cluster, RemoteCall } from 'noex/distribution';

// Local GenServer
const ref = await GenServer.start(counterBehavior);

// Convert to SerializedRef for remote access
const serializedRef: SerializedRef = {
  id: ref.id,
  nodeId: Cluster.getLocalNodeId(),
};

// Now other nodes can call this server
// (assuming they have access to the serializedRef via GlobalRegistry or other means)
```

---

## Serialization

Messages sent via `RemoteCall.call()` and `RemoteCall.cast()` must be serializable:

**Supported types:**
- Primitives: `string`, `number`, `boolean`, `null`, `undefined`
- Arrays and plain objects
- `Date` objects
- `Map` and `Set`
- `Buffer` and `Uint8Array`

**Not supported:**
- Functions
- Class instances (unless they implement custom serialization)
- Symbols
- `WeakMap` and `WeakSet`
- Circular references

---

## Best Practices

### Timeout Configuration

Set timeouts based on expected operation duration:

```typescript
// Quick lookup
const value = await RemoteCall.call(ref, { type: 'get' }, { timeout: 1000 });

// Long-running computation
const result = await RemoteCall.call(ref, { type: 'compute', data }, { timeout: 30000 });
```

### Error Handling

Always handle potential errors in production code:

```typescript
async function safeRemoteCall<T>(ref: SerializedRef, msg: unknown): Promise<T | null> {
  try {
    return await RemoteCall.call<T>(ref, msg);
  } catch (error) {
    if (error instanceof NodeNotReachableError) {
      // Node is down, maybe trigger failover
      return null;
    }
    if (error instanceof RemoteCallTimeoutError) {
      // Slow response, maybe retry
      return null;
    }
    throw error; // Unexpected error
  }
}
```

### Prefer Cast for Fire-and-Forget

Use `cast()` when you don't need a response:

```typescript
// Good: fire-and-forget for event notifications
RemoteCall.cast(loggerRef, { type: 'log', message: 'User logged in' });

// Avoid: waiting for acknowledgement you don't need
await RemoteCall.call(loggerRef, { type: 'log', message: 'User logged in' });
```

---

## Related

- [Remote Messaging Concepts](../concepts/remote-messaging.md) - Understanding remote communication
- [Cluster API](./cluster.md) - Cluster lifecycle management
- [GlobalRegistry API](./global-registry.md) - Cluster-wide naming
- [Types Reference](./types.md) - All distribution types
