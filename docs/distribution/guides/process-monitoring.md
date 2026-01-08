# Process Monitoring Guide

This guide covers monitoring remote processes across cluster nodes using `RemoteMonitor`. Learn how to detect process failures, handle node disconnections, and build fault-tolerant systems.

## Overview

Process monitoring enables reactive fault tolerance:
- Detect when remote processes terminate
- React to node failures affecting monitored processes
- Clean up resources and trigger recovery actions

```
┌────────────────────┐                 ┌────────────────────┐
│      Node A        │                 │      Node B        │
│  ┌──────────────┐  │   monitor_req   │  ┌──────────────┐  │
│  │   Watcher    │──┼────────────────►│  │   Worker     │  │
│  │  (monitors)  │  │                 │  │  (monitored) │  │
│  └──────┬───────┘  │   monitor_ack   │  └──────────────┘  │
│         │         │◄────────────────┼                    │
│         │          │                 │                    │
│         │          │   process_down  │    (crashes!)      │
│         ▼          │◄────────────────┼────────────────────│
│  "Worker crashed"  │                 │                    │
└────────────────────┘                 └────────────────────┘
```

---

## Basic Monitoring

### Setting Up a Monitor

```typescript
import { GenServer, type GenServerRef, type LifecycleEvent } from 'noex';
import { RemoteMonitor } from 'noex/distribution';

// The process that will watch others
const watcherRef = await GenServer.start(watcherBehavior);

// A reference to a remote process
const remoteWorkerRef: GenServerRef = {
  id: 'worker-123',
  nodeId: 'worker-node@192.168.1.20:4369',
} as GenServerRef;

// Establish the monitor
const monitorRef = await RemoteMonitor.monitor(watcherRef, remoteWorkerRef);

console.log(`Monitoring process ${remoteWorkerRef.id}`);
console.log(`Monitor ID: ${monitorRef.monitorId}`);
```

### Receiving process_down Events

When a monitored process terminates, the monitoring process receives a lifecycle event:

```typescript
// Subscribe to lifecycle events
GenServer.onLifecycleEvent((event: LifecycleEvent) => {
  if (event.type === 'process_down') {
    console.log(`Process ${event.monitoredRef.id} went down`);
    console.log(`Node: ${event.monitoredRef.nodeId}`);
    console.log(`Reason: ${event.reason.type}`);
    console.log(`Monitor ID: ${event.monitorId}`);
  }
});
```

### Stopping a Monitor

```typescript
// Stop monitoring when no longer needed
await RemoteMonitor.demonitor(monitorRef);
```

---

## Process Down Reasons

When a monitored process goes down, the `reason` field indicates why:

| Reason Type | Description |
|-------------|-------------|
| `normal` | Process terminated normally (clean shutdown) |
| `shutdown` | Supervisor initiated shutdown |
| `killed` | Process was forcibly killed |
| `timeout` | Process timed out during operation |
| `exception` | Process crashed with an exception |
| `noproc` | Process didn't exist when monitor was set |
| `noconnection` | Lost connection to the node |

```typescript
GenServer.onLifecycleEvent((event) => {
  if (event.type !== 'process_down') return;

  switch (event.reason.type) {
    case 'normal':
    case 'shutdown':
      console.log('Clean termination');
      break;

    case 'noconnection':
      console.log('Node went down');
      scheduleReconnect(event.monitoredRef.nodeId);
      break;

    case 'exception':
      console.log('Process crashed');
      spawnReplacement(event.monitoredRef);
      break;

    case 'noproc':
      console.log('Process was already dead');
      break;

    default:
      console.log(`Unexpected termination: ${event.reason.type}`);
  }
});
```

---

## Monitoring Patterns

### Single Process Watcher

Monitor a critical process and restart it on failure:

```typescript
import { GenServer, type GenServerBehavior, type LifecycleEvent } from 'noex';
import { RemoteMonitor, RemoteSpawn, GlobalRegistry } from 'noex/distribution';

interface WatcherState {
  targetName: string;
  targetBehavior: string;
  monitorRef: MonitorRef | null;
}

type WatcherCast =
  | { type: 'process_down_detected'; reason: unknown };

const watcherBehavior: GenServerBehavior<WatcherState, never, WatcherCast, never> = {
  init: () => ({
    targetName: 'critical-service',
    targetBehavior: 'critical',
    monitorRef: null,
  }),

  handleCast: async (msg, state) => {
    if (msg.type === 'process_down_detected') {
      console.log('Critical service down, restarting...');

      // Find a suitable node
      const nodes = Cluster.getConnectedNodes();
      if (nodes.length === 0) {
        console.error('No nodes available for restart');
        return state;
      }

      // Spawn replacement
      const result = await RemoteSpawn.spawn(state.targetBehavior, nodes[0].id, {
        name: state.targetName,
        registration: 'global',
      });

      console.log(`Restarted on ${result.nodeId}`);
    }

    return state;
  },
};
```

### Multi-Process Pool Monitor

Monitor a pool of workers and maintain minimum capacity:

```typescript
interface PoolMonitorState {
  workers: Map<string, { ref: SerializedRef; monitorRef: MonitorRef }>;
  minWorkers: number;
  behaviorName: string;
}

type PoolMonitorCall =
  | { type: 'get_worker_count' };

type PoolMonitorCast =
  | { type: 'worker_down'; workerId: string };

const poolMonitorBehavior: GenServerBehavior<
  PoolMonitorState,
  PoolMonitorCall,
  PoolMonitorCast,
  number
> = {
  init: () => ({
    workers: new Map(),
    minWorkers: 5,
    behaviorName: 'worker',
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get_worker_count':
        return [state.workers.size, state];
    }
  },

  handleCast: async (msg, state) => {
    if (msg.type === 'worker_down') {
      // Remove the dead worker
      const newWorkers = new Map(state.workers);
      newWorkers.delete(msg.workerId);

      // Check if we need replacements
      if (newWorkers.size < state.minWorkers) {
        const needed = state.minWorkers - newWorkers.size;
        console.log(`Pool below minimum, spawning ${needed} workers`);
        // Note: actual spawning should be done outside handleCast
        // to avoid blocking. Use a separate process or timer.
      }

      return { ...state, workers: newWorkers };
    }

    return state;
  },
};
```

---

## Handling Node Failures

When a node disconnects, all monitors to processes on that node receive `noconnection`:

```typescript
import { Cluster, RemoteMonitor } from 'noex/distribution';

// Track monitors by node for bulk handling
const monitorsByNode = new Map<string, Set<MonitorRef>>();

async function monitorProcess(
  watcherRef: GenServerRef,
  targetRef: GenServerRef,
): Promise<MonitorRef> {
  const monitorRef = await RemoteMonitor.monitor(watcherRef, targetRef);

  // Track by node
  const nodeId = targetRef.nodeId as string;
  if (!monitorsByNode.has(nodeId)) {
    monitorsByNode.set(nodeId, new Set());
  }
  monitorsByNode.get(nodeId)!.add(monitorRef);

  return monitorRef;
}

// Handle node failures at cluster level too
Cluster.onNodeDown((nodeId, reason) => {
  console.log(`Node ${nodeId} down: ${reason}`);

  // Clean up our tracking (monitors will receive noconnection automatically)
  const monitors = monitorsByNode.get(nodeId);
  if (monitors) {
    console.log(`Lost ${monitors.size} monitors to ${nodeId}`);
    monitorsByNode.delete(nodeId);
  }

  // Application-specific recovery
  handleNodeFailure(nodeId);
});
```

---

## Complete Example: Monitored Counter

A counter that is monitored across nodes:

```typescript
// shared/types.ts
export type CounterCallMsg =
  | { type: 'get' }
  | { type: 'get_info' };

export type CounterCastMsg =
  | { type: 'increment'; by?: number }
  | { type: 'decrement'; by?: number };

export type CounterCallReply =
  | { value: number }
  | { value: number; name: string; lastUpdated: string };

export interface WatcherEvent {
  type: 'counter_down';
  name: string;
  nodeId: string;
  reason: string;
}
```

```typescript
// shared/counter.ts
import { type GenServerBehavior } from 'noex';
import type { CounterCallMsg, CounterCastMsg, CounterCallReply } from './types.js';

interface CounterState {
  name: string;
  value: number;
  lastUpdated: Date;
}

export function createCounterBehavior(
  name: string,
  initialValue = 0,
): GenServerBehavior<CounterState, CounterCallMsg, CounterCastMsg, CounterCallReply> {
  return {
    init: () => ({
      name,
      value: initialValue,
      lastUpdated: new Date(),
    }),

    handleCall: (msg, state) => {
      switch (msg.type) {
        case 'get':
          return [{ value: state.value }, state];

        case 'get_info':
          return [
            {
              value: state.value,
              name: state.name,
              lastUpdated: state.lastUpdated.toISOString(),
            },
            state,
          ];
      }
    },

    handleCast: (msg, state) => {
      switch (msg.type) {
        case 'increment': {
          const by = msg.by ?? 1;
          return {
            ...state,
            value: state.value + by,
            lastUpdated: new Date(),
          };
        }

        case 'decrement': {
          const by = msg.by ?? 1;
          return {
            ...state,
            value: state.value - by,
            lastUpdated: new Date(),
          };
        }
      }
    },

    terminate: (reason, state) => {
      console.log(`Counter "${state.name}" terminated: ${reason}`);
    },
  };
}

export const counterBehavior = createCounterBehavior('default', 0);
```

```typescript
// node.ts
import { GenServer, type GenServerRef, type LifecycleEvent, type MonitorRef } from 'noex';
import {
  Cluster,
  BehaviorRegistry,
  GlobalRegistry,
  RemoteSpawn,
  RemoteCall,
  RemoteMonitor,
} from 'noex/distribution';
import { counterBehavior, createCounterBehavior } from './shared/counter.js';

// State
interface AppState {
  localWatcherRef: GenServerRef | null;
  monitors: Map<string, { counterRef: SerializedRef; monitorRef: MonitorRef }>;
  eventHandler: ((event: WatcherEvent) => void) | null;
}

const state: AppState = {
  localWatcherRef: null,
  monitors: new Map(),
  eventHandler: null,
};

async function main(): Promise<void> {
  // Register behaviors
  BehaviorRegistry.register('counter', counterBehavior);

  // Start cluster
  await Cluster.start({
    nodeName: process.env.NODE_NAME || 'node1',
    port: parseInt(process.env.PORT || '4369', 10),
    seeds: process.env.SEEDS?.split(',') || [],
  });

  // Create a local watcher process (it will receive process_down events)
  const watcherBehavior = {
    init: () => ({}),
    handleCall: () => [null, {}],
    handleCast: () => ({}),
  };
  state.localWatcherRef = await GenServer.start(watcherBehavior);

  // Set up lifecycle event handler
  GenServer.onLifecycleEvent(handleLifecycleEvent);

  console.log('Ready. Commands: create <name>, watch <name>, kill <name>');
}

function handleLifecycleEvent(event: LifecycleEvent): void {
  if (event.type !== 'process_down') return;

  // Find which counter this was
  for (const [name, info] of state.monitors) {
    if (info.monitorRef.monitorId === event.monitorId) {
      console.log(`\nCounter "${name}" went down!`);
      console.log(`  Node: ${event.monitoredRef.nodeId}`);
      console.log(`  Reason: ${event.reason.type}`);

      // Clean up
      state.monitors.delete(name);

      // Notify application
      if (state.eventHandler) {
        state.eventHandler({
          type: 'counter_down',
          name,
          nodeId: event.monitoredRef.nodeId as string,
          reason: event.reason.type,
        });
      }
      break;
    }
  }
}

async function createCounter(name: string, targetNodeId?: string): Promise<void> {
  const globalName = `counter:${name}`;

  if (GlobalRegistry.isRegistered(globalName)) {
    console.log(`Counter "${name}" already exists`);
    return;
  }

  const nodeId = targetNodeId || Cluster.getLocalNodeId();

  if (nodeId === Cluster.getLocalNodeId()) {
    // Create locally
    const behavior = createCounterBehavior(name, 0);
    const ref = await GenServer.start(behavior);
    await GlobalRegistry.register(globalName, {
      id: ref.id,
      nodeId: Cluster.getLocalNodeId(),
    });
  } else {
    // Create remotely
    await RemoteSpawn.spawn('counter', nodeId, {
      name: globalName,
      registration: 'global',
    });
  }

  console.log(`Counter "${name}" created on ${nodeId}`);
}

async function watchCounter(name: string): Promise<void> {
  if (!state.localWatcherRef) {
    console.log('Watcher not initialized');
    return;
  }

  const globalName = `counter:${name}`;
  const counterRef = GlobalRegistry.whereis(globalName);

  if (!counterRef) {
    console.log(`Counter "${name}" not found`);
    return;
  }

  if (state.monitors.has(name)) {
    console.log(`Already watching "${name}"`);
    return;
  }

  // Set up the monitor
  const typedCounterRef = {
    id: counterRef.id,
    nodeId: counterRef.nodeId,
  } as unknown as GenServerRef;

  const monitorRef = await RemoteMonitor.monitor(state.localWatcherRef, typedCounterRef);

  state.monitors.set(name, { counterRef, monitorRef });
  console.log(`Now watching "${name}" on ${counterRef.nodeId}`);
}

async function unwatchCounter(name: string): Promise<void> {
  const info = state.monitors.get(name);
  if (!info) {
    console.log(`Not watching "${name}"`);
    return;
  }

  await RemoteMonitor.demonitor(info.monitorRef);
  state.monitors.delete(name);
  console.log(`Stopped watching "${name}"`);
}

main();
```

---

## Best Practices

### 1. Always Clean Up Monitors

Remove monitors when they're no longer needed:

```typescript
// Before stopping your process
for (const [name, info] of monitors) {
  await RemoteMonitor.demonitor(info.monitorRef);
}
monitors.clear();
```

### 2. Handle noproc Immediately

If the process doesn't exist when you try to monitor it:

```typescript
try {
  const monitorRef = await RemoteMonitor.monitor(watcher, target);
} catch (error) {
  // Monitor setup failed - process may not exist
  console.log('Could not establish monitor:', error.message);
  handleMissingProcess(target);
}
```

### 3. Use Appropriate Timeouts

Configure timeouts based on network conditions:

```typescript
// Fast local network
const monitorRef = await RemoteMonitor.monitor(watcher, target, {
  timeout: 5000,
});

// Slow or unreliable network
const monitorRef = await RemoteMonitor.monitor(watcher, target, {
  timeout: 30000,
});
```

### 4. Combine with Cluster Events

Use both monitors and cluster events for comprehensive fault handling:

```typescript
// Monitor individual processes
const monitorRef = await RemoteMonitor.monitor(watcher, worker);

// Also react to node-level failures
Cluster.onNodeDown((nodeId, reason) => {
  // Handle bulk cleanup for all processes on that node
  cleanupNodeResources(nodeId);
});
```

### 5. Avoid Monitor Storms

Don't create too many monitors from a single process:

```typescript
// Bad: One watcher monitors thousands of processes
for (const worker of workers) {
  await RemoteMonitor.monitor(singleWatcher, worker);
}

// Better: Distribute monitoring across multiple watchers
const watchersPerNode = 3;
const assignedWatcher = watchers[workerIndex % watchersPerNode];
await RemoteMonitor.monitor(assignedWatcher, worker);
```

---

## Error Handling

### Monitor Setup Errors

```typescript
import { NodeNotReachableError, RemoteMonitorTimeoutError } from 'noex/distribution';

try {
  const monitorRef = await RemoteMonitor.monitor(watcher, target);
} catch (error) {
  if (error instanceof NodeNotReachableError) {
    console.log(`Cannot reach node: ${error.nodeId}`);
  } else if (error instanceof RemoteMonitorTimeoutError) {
    console.log(`Monitor setup timed out: ${error.timeoutMs}ms`);
  } else {
    console.log(`Monitor failed: ${error.message}`);
  }
}
```

### Statistics

Check monitor statistics for debugging:

```typescript
const stats = RemoteMonitor.getStats();
console.log({
  initialized: stats.initialized,
  pendingMonitors: stats.pendingCount,
  activeMonitors: stats.activeOutgoingCount,
  totalEstablished: stats.totalEstablished,
  totalProcessDowns: stats.totalProcessDownReceived,
});
```

---

## Related

- [Remote Processes Guide](./remote-processes.md) - Spawn and manage remote processes
- [Cluster Formation Guide](./cluster-formation.md) - Node discovery and membership
- [Distributed Supervisor Concepts](../concepts/distributed-supervisor.md) - Automatic supervision
- [RemoteMonitor API](../api/remote-monitor.md) - Complete API reference

---

*[Czech version](../../cs/distribution/guides/process-monitoring.md)*
