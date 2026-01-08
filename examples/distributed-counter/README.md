# Distributed Counter Example

Interactive counter application demonstrating noex fault tolerance features.

## Features Demonstrated

- **Cluster Formation**: Seed-based P2P cluster discovery
- **Remote Spawn**: Creating processes on remote nodes
- **Remote Call/Cast**: Cross-node message passing
- **Remote Monitor**: Watching remote processes for failures
- **Global Registry**: Cluster-wide process lookup
- **Node Lifecycle**: Handling node join/leave and process_down events

## Quick Start

```bash
# Install dependencies
npm install

# Terminal 1 - Start first node
npm run node1

# Terminal 2 - Start second node (connects to first)
npm run node2

# Terminal 3 (optional) - Start third node
npm run node3
```

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help message |
| `/create <name>` | Create a counter on local node |
| `/create <name> on <node>` | Create a counter on a specific node |
| `/inc <name> [amount]` | Increment counter (default: 1) |
| `/dec <name> [amount]` | Decrement counter (default: 1) |
| `/get <name>` | Get counter value and info |
| `/watch <name>` | Start monitoring a counter |
| `/unwatch <name>` | Stop monitoring a counter |
| `/counters` | List all counters across the cluster |
| `/nodes` | List connected nodes |
| `/quit` | Disconnect and exit |

## Demo: Fault Tolerance

This example demonstrates how to monitor remote processes and react to their failures.

### Scenario: Node Failure Detection

**Terminal 1 (node1):**
```
> /create my-counter on node2
Creating counter "my-counter" on node2@127.0.0.1:4370...
Counter "my-counter" created on node2@127.0.0.1:4370 with value 0.

> /watch my-counter
Now watching counter "my-counter" on node2@127.0.0.1:4370

> /inc my-counter 10
Counter "my-counter" incremented by 10. New value: 10

# Now kill node2 with Ctrl+C in Terminal 2

Counter "my-counter" on node2@127.0.0.1:4370 went DOWN! Reason: noconnection
Node left: node2@127.0.0.1:4370 (disconnect)
```

**Terminal 2 (node2):**
```
Node joined: node1@127.0.0.1:4369

# Press Ctrl+C to simulate node failure
^C
Shutting down...
```

### What Happens

1. A counter is created on node2
2. Node1 establishes a monitor on the remote counter using `RemoteMonitor.monitor()`
3. When node2 is killed, node1 receives a `process_down` lifecycle event
4. The watcher behavior reacts to the failure and notifies the user

## Architecture

```
+-----------------------------------------------------------+
|                         Cluster                            |
+---------------------------+-------------------------------+
|         Node 1            |           Node 2               |
+---------------------------+-------------------------------+
|  CounterWatcher           |   Counter: my-counter         |
|    (monitors counters)    |     (GlobalRegistry)          |
|                           |                                |
|  RemoteMonitor.monitor()  |                                |
|        |                  |                                |
|        +-----monitor----->|                                |
|        |<---process_down--|  (when node2 fails)           |
+---------------------------+-------------------------------+
```

## Key API Usage

### Remote Process Monitoring

```typescript
import { RemoteMonitor, GenServer } from 'noex/distribution';

// Monitor a remote process
const monitorRef = await RemoteMonitor.monitor(
  localWatcherRef,
  remoteCounterRef,
);

// Listen for process_down events
GenServer.onLifecycleEvent((event) => {
  if (event.type === 'process_down') {
    console.log(`Process ${event.monitoredRef.id} went down`);
    console.log(`Reason: ${event.reason.type}`);
    // reason.type can be: 'normal', 'shutdown', 'killed', 'noproc', 'noconnection'
  }
});

// Stop monitoring
await RemoteMonitor.demonitor(monitorRef);
```

### Remote Spawn with Global Registration

```typescript
import { RemoteSpawn, GlobalRegistry } from 'noex/distribution';

// Spawn a counter on a remote node
const result = await RemoteSpawn.spawn('distributed-counter:counter', targetNodeId, {
  name: 'counter:my-counter',
  registration: 'global',  // Register in GlobalRegistry
});

// Look up the counter from any node
const counterRef = GlobalRegistry.whereis('counter:my-counter');
```

### Cross-Node Communication

```typescript
import { RemoteCall } from 'noex/distribution';

// Synchronous call to remote counter
const result = await RemoteCall.call(counterRef, { type: 'get' });

// Asynchronous cast to remote counter
RemoteCall.cast(counterRef, { type: 'increment', by: 5 });
```

## Process Down Reasons

When a monitored process terminates, the `process_down` event includes a reason:

| Reason | Description |
|--------|-------------|
| `normal` | Process terminated normally |
| `shutdown` | Process was shut down gracefully |
| `killed` | Process was forcefully terminated |
| `noproc` | Process didn't exist when monitor was set up |
| `noconnection` | Node hosting the process disconnected |
