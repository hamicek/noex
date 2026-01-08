# RemoteMonitor API Reference

The `RemoteMonitor` object enables monitoring of remote GenServer processes across cluster nodes. When a monitored process terminates, the monitoring process receives a `process_down` lifecycle event.

## Import

```typescript
import { RemoteMonitor } from 'noex/distribution';
```

## Overview

RemoteMonitor follows Erlang monitor semantics:
- Monitors are one-way (monitoring process is notified, not affected)
- Multiple monitors to the same process are independent
- If the monitored process doesn't exist, a `noproc` down event is sent immediately
- Node disconnection triggers `noconnection` down events for all monitored processes on that node

---

## Types

### MonitorRef

Reference to an established monitor.

```typescript
interface MonitorRef {
  readonly monitorId: MonitorId;
  readonly monitoredRef: SerializedRef;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `monitorId` | `MonitorId` | Unique identifier for this monitor |
| `monitoredRef` | `SerializedRef` | Reference to the monitored process |

### ProcessDownReason

Reason why a monitored process went down.

```typescript
type ProcessDownReason =
  | { readonly type: 'normal' }
  | { readonly type: 'shutdown' }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'noproc' }
  | { readonly type: 'noconnection' };
```

| Type | Description |
|------|-------------|
| `normal` | Process terminated gracefully via `stop()` |
| `shutdown` | Process was shut down by its supervisor |
| `error` | Process crashed with an exception |
| `noproc` | Process did not exist when monitor was established |
| `noconnection` | Node hosting the process became unreachable |

### RemoteMonitorOptions

Options for remote monitor setup.

```typescript
interface RemoteMonitorOptions {
  readonly timeout?: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeout` | `number` | `10000` | Timeout for monitor setup in milliseconds |

### RemoteMonitorStats

Statistics about remote monitor operations.

```typescript
interface RemoteMonitorStats {
  readonly initialized: boolean;
  readonly pendingCount: number;
  readonly activeOutgoingCount: number;
  readonly totalInitiated: number;
  readonly totalEstablished: number;
  readonly totalTimedOut: number;
  readonly totalDemonitored: number;
  readonly totalProcessDownReceived: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `initialized` | `boolean` | Whether the module is initialized |
| `pendingCount` | `number` | Pending monitor requests awaiting acknowledgement |
| `activeOutgoingCount` | `number` | Active outgoing monitors |
| `totalInitiated` | `number` | Total monitor requests initiated |
| `totalEstablished` | `number` | Total monitors successfully established |
| `totalTimedOut` | `number` | Total monitors that timed out during setup |
| `totalDemonitored` | `number` | Total monitors removed via demonitor |
| `totalProcessDownReceived` | `number` | Total process_down events received |

---

## Methods

### monitor()

Establishes a monitor on a remote process.

```typescript
async monitor(
  monitoringRef: GenServerRef,
  monitoredRef: GenServerRef,
  options?: RemoteMonitorOptions,
): Promise<MonitorRef>
```

**Parameters:**
- `monitoringRef` - Reference to the local process that will receive notifications
- `monitoredRef` - Reference to the remote process to monitor
- `options` - Monitor options

**Returns:** Promise resolving to a MonitorRef

**Throws:**
- `ClusterNotStartedError` - If cluster is not running
- `NodeNotReachableError` - If target node is not connected
- `RemoteMonitorTimeoutError` - If monitor setup times out

When the monitored process terminates, the monitoring process receives a `process_down` lifecycle event via `GenServer.onLifecycleEvent()`.

**Example:**
```typescript
const monitorRef = await RemoteMonitor.monitor(localRef, remoteRef);
console.log(`Monitoring ${monitorRef.monitoredRef.id}`);
```

---

### demonitor()

Removes a monitor.

```typescript
async demonitor(monitorRef: MonitorRef): Promise<void>
```

**Parameters:**
- `monitorRef` - Reference to the monitor to remove

Sends a demonitor request to the remote node and removes the monitor from the local registry. If the monitor doesn't exist or was already removed, this is a no-op.

**Example:**
```typescript
await RemoteMonitor.demonitor(monitorRef);
```

---

### getStats()

Returns statistics about remote monitor operations.

```typescript
getStats(): RemoteMonitorStats
```

**Example:**
```typescript
const stats = RemoteMonitor.getStats();
console.log(`Active monitors: ${stats.activeOutgoingCount}`);
console.log(`Total established: ${stats.totalEstablished}`);
console.log(`Process down events: ${stats.totalProcessDownReceived}`);
```

---

## Error Classes

### RemoteMonitorTimeoutError

```typescript
class RemoteMonitorTimeoutError extends Error {
  readonly name = 'RemoteMonitorTimeoutError';
  readonly monitoredRef: SerializedRef;
  readonly timeoutMs: number;
}
```

Thrown when remote monitor setup times out.

---

## Receiving Process Down Events

Process down notifications are delivered via the GenServer lifecycle event system:

```typescript
import { GenServer } from 'noex';

// Subscribe to lifecycle events
const unsubscribe = GenServer.onLifecycleEvent((event) => {
  if (event.type === 'process_down') {
    console.log(`Process ${event.monitoredRef.id} went down`);
    console.log(`Reason: ${event.reason.type}`);

    if (event.reason.type === 'error') {
      console.log(`Error: ${event.reason.message}`);
    }
  }
});
```

---

## Complete Example

```typescript
import { GenServer } from 'noex';
import {
  Cluster,
  RemoteMonitor,
  GlobalRegistry,
  RemoteMonitorTimeoutError,
} from 'noex/distribution';

// Watcher behavior that monitors remote processes
const watcherBehavior = {
  init: () => ({ monitored: new Map<string, MonitorRef>() }),

  handleCall: (msg: { type: 'watch'; name: string }, state) => {
    // Handled via async operations, return current state
    return [null, state];
  },

  handleCast: (_msg: never, state) => state,
};

async function main() {
  await Cluster.start({
    nodeName: 'watcher',
    port: 4369,
    seeds: ['worker@192.168.1.10:4369'],
  });

  // Start local watcher
  const watcherRef = await GenServer.start(watcherBehavior);

  // Listen for process_down events
  GenServer.onLifecycleEvent((event) => {
    if (event.type === 'process_down') {
      console.log(`\nProcess down notification:`);
      console.log(`  Process: ${event.monitoredRef.id}@${event.monitoredRef.nodeId}`);
      console.log(`  Reason: ${event.reason.type}`);

      if (event.reason.type === 'error') {
        console.log(`  Error: ${event.reason.message}`);
      }

      // Could trigger recovery logic here
      handleProcessDown(event.monitoredRef);
    }
  });

  // Wait for cluster connection
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Find and monitor remote processes
  const monitors: MonitorRef[] = [];

  for (const name of GlobalRegistry.getNames()) {
    const remoteRef = GlobalRegistry.lookup(name);

    // Only monitor remote processes
    if (remoteRef.nodeId !== Cluster.getLocalNodeId()) {
      try {
        const monitorRef = await RemoteMonitor.monitor(
          watcherRef,
          remoteRef as unknown as GenServerRef,
          { timeout: 5000 },
        );
        monitors.push(monitorRef);
        console.log(`Monitoring ${name} (${remoteRef.id})`);
      } catch (error) {
        if (error instanceof RemoteMonitorTimeoutError) {
          console.log(`Timeout monitoring ${name}`);
        } else {
          throw error;
        }
      }
    }
  }

  console.log(`\nMonitoring ${monitors.length} remote processes`);

  // Print statistics periodically
  setInterval(() => {
    const stats = RemoteMonitor.getStats();
    console.log(`\nMonitor stats:`);
    console.log(`  Active: ${stats.activeOutgoingCount}`);
    console.log(`  Down events: ${stats.totalProcessDownReceived}`);
  }, 10000);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    // Remove all monitors
    for (const monitor of monitors) {
      await RemoteMonitor.demonitor(monitor);
    }

    await Cluster.stop();
    process.exit(0);
  });
}

function handleProcessDown(ref: SerializedRef): void {
  console.log(`Handling process down for ${ref.id}`);
  // Implement recovery logic:
  // - Retry connecting to the service
  // - Failover to a backup
  // - Alert operators
}

main().catch(console.error);
```

---

## Automatic Cleanup

### On Node Disconnect

When a node disconnects, all monitors to processes on that node are automatically:
1. Removed from the local registry
2. Trigger `process_down` events with reason `noconnection`

```typescript
Cluster.onNodeDown((nodeId, reason) => {
  console.log(`Node ${nodeId} down - all monitors to it will trigger noconnection`);
});
```

### On Monitoring Process Termination

When the monitoring process terminates:
1. All its outgoing monitors are removed from the registry
2. Demonitor requests are sent to remote nodes (best effort)

This follows Erlang semantics where monitors are automatically cleaned up when the monitoring process terminates.

---

## Best Practices

### Use Monitors for Fault Detection

```typescript
// Monitor critical dependencies
async function watchDependencies(localRef: GenServerRef): Promise<void> {
  const dependencies = ['database', 'cache', 'queue'];

  for (const name of dependencies) {
    const ref = GlobalRegistry.whereis(name);
    if (ref) {
      await RemoteMonitor.monitor(localRef, ref as unknown as GenServerRef);
    }
  }
}
```

### Handle All Down Reasons

```typescript
GenServer.onLifecycleEvent((event) => {
  if (event.type === 'process_down') {
    switch (event.reason.type) {
      case 'normal':
        console.log('Process terminated gracefully');
        // No action needed - expected shutdown
        break;

      case 'shutdown':
        console.log('Process was shut down');
        // Supervisor-initiated - may restart automatically
        break;

      case 'error':
        console.log(`Process crashed: ${event.reason.message}`);
        // May need manual intervention or alerting
        triggerAlert(event.monitoredRef, event.reason.message);
        break;

      case 'noproc':
        console.log('Process did not exist');
        // Was already dead when we tried to monitor
        break;

      case 'noconnection':
        console.log('Lost connection to node');
        // Network partition or node crash
        initiateFailover(event.monitoredRef);
        break;
    }
  }
});
```

### Combine with DistributedSupervisor

For automatic failover, use `DistributedSupervisor` which internally uses `RemoteMonitor`:

```typescript
// DistributedSupervisor automatically monitors remote children
// and triggers failover on process_down events
const supRef = await DistributedSupervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'worker', behavior: 'worker' },
  ],
});
```

---

## Related

- [Process Monitoring Guide](../guides/process-monitoring.md) - Using RemoteMonitor
- [DistributedSupervisor API](./distributed-supervisor.md) - Automatic failover
- [Cluster API](./cluster.md) - Node events
- [Types Reference](./types.md) - All distribution types
