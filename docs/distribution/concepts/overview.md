# Distribution Overview

noex distribution enables building fault-tolerant, horizontally scalable applications by connecting multiple Node.js processes into a cohesive cluster. Inspired by Erlang/OTP's distribution model, it provides location-transparent messaging between GenServer instances across network boundaries.

## Design Principles

### 1. Location Transparency

Processes communicate without knowing whether the target is local or remote. The same `RemoteCall.call()` API works regardless of process location:

```typescript
// Works identically for local and remote processes
const result = await RemoteCall.call(processRef, { type: 'get_status' });
```

The system handles connection management, serialization, and routing automatically.

### 2. Peer-to-Peer Architecture

Unlike master-slave architectures, noex uses a fully decentralized P2P model:

```
    ┌──────────┐
    │  Node A  │◄────────────────┐
    └────┬─────┘                 │
         │                       │
         ▼                       ▼
    ┌──────────┐           ┌──────────┐
    │  Node B  │◄─────────►│  Node C  │
    └──────────┘           └──────────┘
```

- **No single point of failure**: Any node can join or leave without coordinator
- **Gossip-based discovery**: Nodes share membership information automatically
- **Symmetric connections**: All nodes are equal participants

### 3. Explicit Failure Handling

Distribution embraces the reality of network partitions and node failures:

```typescript
// Cluster events notify you of topology changes
Cluster.onNodeDown((nodeId, reason) => {
  // Handle: 'heartbeat_timeout', 'connection_closed', 'graceful_shutdown'
  console.log(`Node ${nodeId} went down: ${reason}`);
});

// RemoteMonitor tracks specific processes
const { unsubscribe } = await RemoteMonitor.monitor(remoteRef, (ref, reason) => {
  // Process crashed or node disconnected
  handleProcessDown(ref, reason);
});
```

### 4. Erlang-Compatible Semantics

noex distribution follows Erlang/OTP conventions where practical:

| Erlang | noex | Notes |
|--------|------|-------|
| `node()` | `Cluster.getLocalNodeId()` | Returns `name@host:port` |
| `nodes()` | `Cluster.getNodes()` | List of connected nodes |
| `rpc:call/4` | `RemoteCall.call()` | Synchronous remote call |
| `gen_server:cast/2` | `RemoteCall.cast()` | Asynchronous message |
| `global:register_name/2` | `GlobalRegistry.register()` | Cluster-wide naming |
| `erlang:monitor/2` | `RemoteMonitor.monitor()` | Process monitoring |
| `spawn/4` on remote node | `RemoteSpawn.spawn()` | Remote process creation |

## Architecture Layers

### Layer 1: Transport

The foundation layer handles TCP connections and wire protocol:

```
┌─────────────────────────────────────────────────────┐
│                    Transport                         │
├─────────────────────────────────────────────────────┤
│  • TCP socket management                             │
│  • Connection pooling and reconnection               │
│  • Message serialization (MessagePack)               │
│  • HMAC authentication (when clusterSecret set)      │
│  • Length-prefixed framing                           │
└─────────────────────────────────────────────────────┘
```

Key characteristics:
- Persistent connections between nodes
- Automatic reconnection with exponential backoff
- Optional HMAC-SHA256 message signing

### Layer 2: Cluster + Membership

Builds on Transport to provide cluster abstraction:

```
┌─────────────────────────────────────────────────────┐
│               Cluster + Membership                   │
├─────────────────────────────────────────────────────┤
│  • Seed-based node discovery                         │
│  • Heartbeat broadcasting                            │
│  • Failure detection (heartbeat timeout)             │
│  • Gossip protocol for membership                    │
│  • Node up/down events                               │
└─────────────────────────────────────────────────────┘
```

The cluster forms through seed nodes:

```typescript
// Node A (first node, no seeds needed)
await Cluster.start({ nodeName: 'nodeA', port: 4369 });

// Node B (joins via Node A)
await Cluster.start({
  nodeName: 'nodeB',
  port: 4370,
  seeds: ['nodeA@192.168.1.1:4369'],
});

// Node C (joins via Node B, discovers Node A through gossip)
await Cluster.start({
  nodeName: 'nodeC',
  port: 4371,
  seeds: ['nodeB@192.168.1.2:4370'],
});
```

### Layer 3: Remote Communication

Provides transparent cross-node messaging:

```
┌─────────────────────────────────────────────────────┐
│            RemoteCall / RemoteSpawn                  │
├─────────────────────────────────────────────────────┤
│  • RemoteCall.call() - synchronous request/reply     │
│  • RemoteCall.cast() - asynchronous fire-and-forget  │
│  • RemoteSpawn.spawn() - start process on remote     │
│  • BehaviorRegistry - register spawnable behaviors   │
└─────────────────────────────────────────────────────┘
```

Messages are automatically routed:

```typescript
// Register behavior on all nodes
BehaviorRegistry.register('worker', workerBehavior);

// Spawn on specific node
const ref = await RemoteSpawn.spawn('worker', targetNodeId, {
  registration: 'global',
  name: 'primary-worker',
});

// Call works transparently
await RemoteCall.call(ref, { type: 'process', data });
```

### Layer 4: Coordination Services

Higher-level distributed primitives:

```
┌─────────────────────────────────────────────────────┐
│   GlobalRegistry / RemoteMonitor / DistSupervisor   │
├─────────────────────────────────────────────────────┤
│  • GlobalRegistry - cluster-wide process naming      │
│  • RemoteMonitor - cross-node process monitoring     │
│  • DistributedSupervisor - multi-node supervision    │
└─────────────────────────────────────────────────────┘
```

## Node Identification

Nodes are identified by a unique `NodeId` in the format `name@host:port`:

```typescript
import { NodeId } from 'noex/distribution';

// Parse from string
const nodeId = NodeId.parse('worker1@192.168.1.10:4369');

// Create programmatically
const nodeId = NodeId.create('worker1', '192.168.1.10', 4369);

// Extract components
const { name, host, port } = NodeId.parse('worker1@192.168.1.10:4369');
// name: 'worker1', host: '192.168.1.10', port: 4369
```

NodeId rules:
- `name`: Starts with letter, alphanumeric + underscore/hyphen, max 64 chars
- `host`: Valid IPv4, IPv6, or hostname
- `port`: Integer 1-65535

## Message Flow

### Remote Call Flow

```
┌──────────┐        ┌──────────┐        ┌──────────┐
│  Caller  │        │  Node A  │        │  Node B  │
└────┬─────┘        └────┬─────┘        └────┬─────┘
     │                   │                   │
     │ RemoteCall.call() │                   │
     │──────────────────►│                   │
     │                   │   CallMessage     │
     │                   │──────────────────►│
     │                   │                   │
     │                   │                   │ GenServer.call()
     │                   │                   │─────────┐
     │                   │                   │         │
     │                   │                   │◄────────┘
     │                   │  CallReplyMessage │
     │                   │◄──────────────────│
     │   Promise<Reply>  │                   │
     │◄──────────────────│                   │
     │                   │                   │
```

### Remote Spawn Flow

```
┌──────────┐        ┌──────────┐        ┌──────────┐
│ Spawner  │        │  Node A  │        │  Node B  │
└────┬─────┘        └────┬─────┘        └────┬─────┘
     │                   │                   │
     │ RemoteSpawn.spawn │                   │
     │──────────────────►│                   │
     │                   │ SpawnRequest      │
     │                   │──────────────────►│
     │                   │                   │
     │                   │                   │ BehaviorRegistry.get()
     │                   │                   │ GenServer.start()
     │                   │                   │─────────┐
     │                   │                   │         │
     │                   │                   │◄────────┘
     │                   │ SpawnReply        │
     │                   │◄──────────────────│
     │ Promise<SpawnRes> │                   │
     │◄──────────────────│                   │
     │                   │                   │
```

## Serialization

All messages crossing node boundaries are serialized using a safe subset of JavaScript types:

| Supported Types | Notes |
|-----------------|-------|
| `null`, `undefined` | Preserved across serialization |
| `boolean` | `true`, `false` |
| `number` | Including `Infinity`, `-Infinity`, `NaN` |
| `string` | UTF-8 encoded |
| `Array` | Nested structures supported |
| `Object` | Plain objects only (no class instances) |
| `Date` | Serialized as ISO string, deserialized back |
| `Map`, `Set` | Converted to arrays |
| `Buffer`, `Uint8Array` | Binary data preserved |

**Not Supported:**
- Functions (cannot be serialized)
- Class instances (lose prototype)
- Symbols
- BigInt (use string representation)
- Circular references

```typescript
// Works
await RemoteCall.call(ref, {
  type: 'update',
  data: { items: [1, 2, 3], timestamp: new Date() },
});

// Won't work - function cannot be serialized
await RemoteCall.call(ref, {
  callback: () => console.log('done'), // Error!
});
```

## Error Handling

Distribution operations can fail in several ways:

### Connection Errors

```typescript
import { NodeNotReachableError } from 'noex/distribution';

try {
  await RemoteCall.call(ref, message);
} catch (error) {
  if (error instanceof NodeNotReachableError) {
    // Target node is disconnected
    console.log(`Node ${error.nodeId} is not reachable`);
  }
}
```

### Timeout Errors

```typescript
import { RemoteCallTimeoutError } from 'noex/distribution';

try {
  await RemoteCall.call(ref, message, { timeout: 5000 });
} catch (error) {
  if (error instanceof RemoteCallTimeoutError) {
    console.log(`Call to ${error.serverId} timed out after ${error.timeoutMs}ms`);
  }
}
```

### Server Errors

```typescript
import { RemoteServerNotRunningError } from 'noex/distribution';

try {
  await RemoteCall.call(ref, message);
} catch (error) {
  if (error instanceof RemoteServerNotRunningError) {
    console.log(`Server ${error.serverId} on ${error.nodeId} is not running`);
  }
}
```

## Comparison with Erlang/OTP

| Feature | Erlang/OTP | noex |
|---------|------------|------|
| Transport | Custom distribution protocol | TCP + MessagePack |
| Discovery | EPMD (Erlang Port Mapper) | Seed-based + Gossip |
| Authentication | Shared cookie file | HMAC with clusterSecret |
| Message passing | Native BEAM support | Serialization layer |
| Process isolation | BEAM VM processes | Node.js event loop (single-threaded) |
| Hot code reload | Native support | Not supported |
| Node naming | `name@host` | `name@host:port` |

### Key Differences

1. **No EPMD**: noex doesn't require a separate port mapper daemon
2. **Port in NodeId**: Explicit port allows multiple nodes per host
3. **No magic cookie**: Uses explicit `clusterSecret` configuration
4. **JavaScript limitations**: Single-threaded, no process isolation

## Best Practices

### 1. Use Explicit Timeouts

```typescript
// Don't rely on defaults for critical operations
const result = await RemoteCall.call(ref, message, {
  timeout: 10000, // 10 seconds
});
```

### 2. Handle Node Failures

```typescript
// Always subscribe to cluster events
Cluster.onNodeDown((nodeId, reason) => {
  // Clean up state related to that node
  removeNodeFromLoadBalancer(nodeId);
});
```

### 3. Register Behaviors on All Nodes

```typescript
// Before Cluster.start() on every node
BehaviorRegistry.register('worker', workerBehavior);
BehaviorRegistry.register('coordinator', coordinatorBehavior);
```

### 4. Use GlobalRegistry for Singletons

```typescript
// Single leader process across cluster
await GlobalRegistry.register('leader', leaderRef);

// Any node can find it
const leader = GlobalRegistry.whereis('leader');
```

### 5. Prefer Cast for Fire-and-Forget

```typescript
// Don't wait for acknowledgment when not needed
RemoteCall.cast(ref, { type: 'log', message: 'User logged in' });
```

## Related

- [Cluster](./cluster.md) - Detailed cluster formation and membership
- [Remote Messaging](./remote-messaging.md) - RemoteCall/Cast deep dive
- [Global Registry](./global-registry.md) - Cluster-wide naming
- [Getting Started Guide](../guides/getting-started.md) - First distributed app

---

*[Czech version](../../cs/distribution/concepts/overview.md)*
