# RemoteLink API Reference

The `RemoteLink` object enables bidirectional process linking across cluster nodes. When a linked process terminates abnormally, the exit signal propagates to the remote peer — either force-terminating it or delivering an `ExitSignal` info message if `trapExit` is enabled.

## Import

```typescript
import { RemoteLink } from 'noex/distribution';
```

## Overview

RemoteLink follows Erlang link semantics:
- Links are bidirectional (both processes are affected by each other's termination)
- Abnormal termination propagates to the linked peer
- Normal exits (`'normal'`) silently remove the link without propagation
- If the peer has `trapExit: true`, it receives an `ExitSignal` via `handleInfo` instead of being terminated
- Node disconnection triggers `noconnection` exit signals for all linked processes on that node

### Difference from Monitors

| | Monitor | Link |
|--|---------|------|
| Direction | One-way | Bidirectional |
| On crash | Notification (event) | Termination (propagation) |
| Trap exits | N/A | Enabled — receives info message instead of termination |

---

## Types

### LinkRef

Reference to an established link.

```typescript
interface LinkRef {
  readonly linkId: string;
  readonly ref1: SerializedRef;
  readonly ref2: SerializedRef;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `linkId` | `string` | Unique identifier for this link |
| `ref1` | `SerializedRef` | Reference to the first linked process |
| `ref2` | `SerializedRef` | Reference to the second linked process |

### RemoteLinkOptions

Options for remote link setup.

```typescript
interface RemoteLinkOptions {
  readonly timeout?: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeout` | `number` | `10000` | Timeout for link setup in milliseconds |

### RemoteLinkStats

Statistics about remote link operations.

```typescript
interface RemoteLinkStats {
  readonly initialized: boolean;
  readonly pendingCount: number;
  readonly activeLinkCount: number;
  readonly totalInitiated: number;
  readonly totalEstablished: number;
  readonly totalTimedOut: number;
  readonly totalUnlinked: number;
  readonly totalExitSignalsReceived: number;
  readonly totalExitSignalsSent: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `initialized` | `boolean` | Whether the module is initialized |
| `pendingCount` | `number` | Pending link requests awaiting acknowledgement |
| `activeLinkCount` | `number` | Active remote links |
| `totalInitiated` | `number` | Total link requests initiated |
| `totalEstablished` | `number` | Total links successfully established |
| `totalTimedOut` | `number` | Total links that timed out during setup |
| `totalUnlinked` | `number` | Total links removed via unlink |
| `totalExitSignalsReceived` | `number` | Total exit signals received from remote nodes |
| `totalExitSignalsSent` | `number` | Total exit signals sent to remote nodes |

### ExitSignal

Exit signal delivered to a process with `trapExit` enabled.

```typescript
interface ExitSignal {
  readonly type: 'EXIT';
  readonly from: SerializedRef;
  readonly reason: ProcessDownReason;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'EXIT'` | Discriminator for info message type |
| `from` | `SerializedRef` | Reference to the linked process that terminated |
| `reason` | `ProcessDownReason` | Reason for the termination |

---

## Methods

### link()

Establishes a bidirectional link between a local and a remote process.

```typescript
async link(
  localRef: GenServerRef,
  remoteRef: GenServerRef,
  options?: RemoteLinkOptions,
): Promise<LinkRef>
```

**Parameters:**
- `localRef` - Reference to the local process
- `remoteRef` - Reference to the remote process (must have `nodeId`)
- `options` - Link options

**Returns:** Promise resolving to a LinkRef

**Throws:**
- `ClusterNotStartedError` - If cluster is not running
- `NodeNotReachableError` - If target node is not connected
- `RemoteLinkTimeoutError` - If link setup times out

**Example:**
```typescript
const linkRef = await RemoteLink.link(localRef, remoteRef);
console.log(`Linked ${linkRef.ref1.id} <-> ${linkRef.ref2.id}`);
```

---

### unlink()

Removes a remote link.

```typescript
async unlink(linkRef: LinkRef): Promise<void>
```

**Parameters:**
- `linkRef` - Reference to the link to remove

Sends an unlink request to the remote node and removes the link from the local registry. If the link doesn't exist or was already removed, this is a no-op.

**Example:**
```typescript
await RemoteLink.unlink(linkRef);
```

---

### getStats()

Returns statistics about remote link operations.

```typescript
getStats(): RemoteLinkStats
```

**Example:**
```typescript
const stats = RemoteLink.getStats();
console.log(`Active links: ${stats.activeLinkCount}`);
console.log(`Exit signals received: ${stats.totalExitSignalsReceived}`);
console.log(`Exit signals sent: ${stats.totalExitSignalsSent}`);
```

---

## Error Classes

### RemoteLinkTimeoutError

```typescript
class RemoteLinkTimeoutError extends Error {
  readonly name = 'RemoteLinkTimeoutError';
  readonly remoteRef: SerializedRef;
  readonly timeoutMs: number;
}
```

Thrown when remote link setup times out.

---

## Protocol

The remote link protocol uses a request/acknowledge handshake:

```
Node A                          Node B
  |                               |
  |-- link_request (linkId) ----->|  Verify target process exists
  |<-- link_ack (success) --------|  Both sides register active link
  |                               |
  |  ... process on B crashes ... |
  |                               |
  |<-- exit_signal (reason) ------|  Propagate exit signal
  |                               |
  |  Local process:               |
  |  - trapExit=true -> handleInfo(ExitSignal)
  |  - trapExit=false -> force terminate
```

---

## Exit Signal Propagation

When a linked process terminates:

### Abnormal Exit (crash, shutdown)

The exit signal is sent to the remote peer:

```typescript
// Process A on Node 1 linked to Process B on Node 2
// Process B crashes -> exit signal sent to Node 1

// If Process A has trapExit: false (default):
//   -> Process A is force-terminated

// If Process A has trapExit: true:
//   -> Process A receives ExitSignal via handleInfo
const behavior = {
  init: () => ({ linkedProcesses: [] }),
  handleCast: (_msg, state) => state,
  handleInfo: (info: ExitSignal, state) => {
    if (info.type === 'EXIT') {
      console.log(`Linked process ${info.from.id} terminated: ${info.reason.type}`);
      // Handle gracefully - remove from tracked processes, trigger recovery, etc.
    }
    return state;
  },
};

const ref = await GenServer.start(behavior, { trapExit: true });
```

### Normal Exit

Normal exits do NOT propagate. The link is silently removed on both sides:

```typescript
// Process B stops normally -> link removed, Process A unaffected
await GenServer.stop(processB);
// Process A continues running normally
```

---

## Automatic Cleanup

### On Node Disconnect

When a node disconnects, all links to processes on that node:
1. Are removed from the local registry
2. Trigger `noconnection` exit signals to local linked processes

```typescript
// If Node 2 goes down, all local processes linked to Node 2 processes
// receive a { type: 'noconnection' } exit signal
```

### On Local Process Termination

When a local linked process terminates:
1. Exit signal is sent to the remote peer (for abnormal exits)
2. Link is removed from the registry
3. Remote side is notified via `exit_signal` or `unlink_request` message

---

## Complete Example

```typescript
import { GenServer, type ExitSignal } from 'noex';
import { Cluster, RemoteLink, RemoteSpawn, BehaviorRegistry } from 'noex/distribution';

// Worker behavior
const workerBehavior = {
  init: () => ({ tasks: 0 }),
  handleCall: (msg: 'get_tasks', state: { tasks: number }) => {
    return [state.tasks, state] as const;
  },
  handleCast: (msg: { type: 'do_task' }, state: { tasks: number }) => {
    return { tasks: state.tasks + 1 };
  },
};

// Supervisor-like behavior that links to workers
const coordinatorBehavior = {
  init: () => ({ workers: new Map<string, LinkRef>() }),

  handleCast: (_msg: never, state) => state,

  // Receive exit signals from linked workers
  handleInfo: (info: ExitSignal, state: { workers: Map<string, any> }) => {
    if (info.type === 'EXIT') {
      console.log(`Worker ${info.from.id} crashed: ${info.reason.type}`);

      // Remove from tracked workers
      const newWorkers = new Map(state.workers);
      for (const [name, linkRef] of newWorkers) {
        if (linkRef.ref2.id === info.from.id) {
          newWorkers.delete(name);
          break;
        }
      }

      // Could spawn replacement here
      return { workers: newWorkers };
    }
    return state;
  },
};

async function main() {
  BehaviorRegistry.register('worker', workerBehavior);

  await Cluster.start({
    nodeName: 'coordinator',
    port: 4369,
    seeds: ['worker-node@192.168.1.10:4369'],
  });

  // Start coordinator with trapExit enabled
  const coordinator = await GenServer.start(coordinatorBehavior, {
    trapExit: true,
  });

  // Wait for cluster connection
  Cluster.onNodeUp(async (node) => {
    console.log(`Node ${node.id} connected`);

    // Spawn a worker on the remote node
    const result = await RemoteSpawn.spawn('worker', node.id);
    const workerRef = { id: result.ref.id, nodeId: node.id } as any;

    // Link coordinator to the remote worker
    const linkRef = await RemoteLink.link(coordinator, workerRef);
    console.log(`Linked to worker ${workerRef.id} on ${node.id}`);

    // If the worker crashes, coordinator will receive ExitSignal
    // If the coordinator crashes, worker will be terminated
  });

  // Monitor link statistics
  setInterval(() => {
    const stats = RemoteLink.getStats();
    if (stats.activeLinkCount > 0) {
      console.log(`Active links: ${stats.activeLinkCount}`);
      console.log(`Exit signals: sent=${stats.totalExitSignalsSent}, received=${stats.totalExitSignalsReceived}`);
    }
  }, 10000);
}

main().catch(console.error);
```

---

## Best Practices

### Use trapExit for Graceful Handling

```typescript
// Enable trapExit to handle linked process failures gracefully
const ref = await GenServer.start(behavior, { trapExit: true });

// Without trapExit, your process will be terminated when any linked process crashes
```

### Prefer Links for Dependent Processes

Use links when processes are tightly coupled and should fail together:

```typescript
// Good: Worker depends on its connection handler
await RemoteLink.link(worker, connectionHandler);

// If connection handler crashes, worker should also stop
```

### Use Monitors for Independent Observation

Use monitors when you only need to observe without mutual dependency:

```typescript
// Good: Dashboard observes workers but shouldn't crash with them
await RemoteMonitor.monitor(dashboard, worker);
```

### Handle All Exit Reasons

```typescript
handleInfo: (info: ExitSignal, state) => {
  if (info.type === 'EXIT') {
    switch (info.reason.type) {
      case 'error':
        console.log(`Linked process crashed: ${info.reason.message}`);
        return spawnReplacement(state);

      case 'shutdown':
        console.log('Linked process shut down by supervisor');
        return removeFromState(info.from, state);

      case 'noconnection':
        console.log('Lost connection to linked process node');
        return handlePartition(info.from, state);

      case 'normal':
        // Should not happen (normal exits don't propagate)
        return state;

      default:
        return state;
    }
  }
  return state;
},
```

---

## Related

- [Process Monitoring Guide](../guides/process-monitoring.md) - Monitoring vs Linking
- [RemoteMonitor API](./remote-monitor.md) - One-way process monitoring
- [Cluster API](./cluster.md) - Node events
- [Types Reference](./types.md) - All distribution types
