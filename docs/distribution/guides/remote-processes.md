# Remote Processes Guide

This guide covers spawning and managing GenServer processes on remote nodes using `RemoteSpawn`, `BehaviorRegistry`, and `RemoteCall`.

## Overview

In a distributed noex cluster, you can:
- **Spawn processes** on specific nodes using `RemoteSpawn`
- **Register behaviors** for remote spawning using `BehaviorRegistry`
- **Communicate** with remote processes using `RemoteCall`
- **Register names** cluster-wide using `GlobalRegistry`

```
┌─────────────────────────────────────────────────────────────────┐
│                         Node A                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  BehaviorRegistry                                        │    │
│  │  ├── 'worker' → workerBehavior                          │    │
│  │  └── 'cache' → cacheBehavior                            │    │
│  └─────────────────────────────────────────────────────────┘    │
│                           │                                      │
│                  RemoteSpawn.spawn('worker', nodeB)             │
│                           │                                      │
└───────────────────────────┼──────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Node B                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  BehaviorRegistry                                        │    │
│  │  ├── 'worker' → workerBehavior  ◄── Used to spawn      │    │
│  │  └── 'cache' → cacheBehavior                            │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌──────────────────┐                                           │
│  │  Worker Process  │ ◄── New process created here             │
│  │  (from behavior) │                                           │
│  └──────────────────┘                                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## BehaviorRegistry

### Why Behaviors Must Be Registered

JavaScript functions cannot be serialized and sent over the network. Instead, noex uses a behavior registry:

1. Each node registers behaviors by name before the cluster starts
2. Remote spawn requests specify the behavior name
3. The target node looks up the behavior and creates the process

```typescript
import { BehaviorRegistry } from 'noex/distribution';
import { workerBehavior, cacheBehavior } from './behaviors.js';

// Register on EVERY node before Cluster.start()
BehaviorRegistry.register('worker', workerBehavior);
BehaviorRegistry.register('cache', cacheBehavior);

await Cluster.start({ nodeName: 'app1', port: 4369 });
```

### Registration Timing

Register behaviors **before** `Cluster.start()` to ensure they're available when other nodes connect:

```typescript
// Good: Register first
BehaviorRegistry.register('worker', workerBehavior);
await Cluster.start({ ... });

// Risky: Register after start
await Cluster.start({ ... });
BehaviorRegistry.register('worker', workerBehavior); // May miss early spawn requests
```

### Behavior Factory Pattern

For behaviors that need configuration, use a factory:

```typescript
// behaviors.ts
export function createWorkerBehavior(config: WorkerConfig): GenServerBehavior<...> {
  return {
    init: () => ({
      tasks: [],
      config,  // Configuration baked in
    }),
    // ...
  };
}

// Default behavior for BehaviorRegistry (uses default config)
export const workerBehavior = createWorkerBehavior({
  maxConcurrency: 10,
  timeoutMs: 30000,
});
```

### Listing Registered Behaviors

```typescript
const names = BehaviorRegistry.getNames();
console.log('Registered behaviors:', names);
// ['worker', 'cache', ...]

const isRegistered = BehaviorRegistry.has('worker');
```

---

## RemoteSpawn

### Basic Spawning

Spawn a process on a specific node:

```typescript
import { RemoteSpawn, Cluster } from 'noex/distribution';

// Get connected nodes
const nodes = Cluster.getConnectedNodes();
const targetNode = nodes[0];

// Spawn on that node
const result = await RemoteSpawn.spawn('worker', targetNode.id);

console.log(`Server ID: ${result.serverId}`);
console.log(`Node ID: ${result.nodeId}`);
```

### Spawn Options

```typescript
interface RemoteSpawnOptions {
  /** Process name for local registration */
  name?: string;

  /** Registration type: 'local', 'global', or 'none' */
  registration?: 'local' | 'global' | 'none';

  /** Timeout for init() callback (default: varies) */
  initTimeout?: number;

  /** Timeout for entire spawn operation (default: 10000ms) */
  timeout?: number;
}
```

### Local Registration

Register the process locally on the target node:

```typescript
const result = await RemoteSpawn.spawn('worker', targetNode.id, {
  name: 'worker-1',
  registration: 'local',
});

// Process is named 'worker-1' on targetNode only
// Other nodes cannot find it by name
```

### Global Registration

Register the process cluster-wide:

```typescript
const result = await RemoteSpawn.spawn('cache', targetNode.id, {
  name: 'cache:primary',
  registration: 'global',
});

// Any node can find it:
const ref = GlobalRegistry.whereis('cache:primary');
```

### No Registration

Spawn without any name registration:

```typescript
const result = await RemoteSpawn.spawn('worker', targetNode.id, {
  registration: 'none',
});

// Process is anonymous - only accessible via returned ref
const ref = {
  id: result.serverId,
  nodeId: result.nodeId,
};
```

---

## Communicating with Remote Processes

### RemoteCall.call()

Synchronous request-response:

```typescript
import { RemoteCall } from 'noex/distribution';

const ref = {
  id: result.serverId,
  nodeId: result.nodeId,
};

// Wait for response
const response = await RemoteCall.call(ref, { type: 'get_status' });
console.log('Status:', response);

// With custom timeout
const data = await RemoteCall.call(ref, { type: 'get_data' }, {
  timeout: 30000,  // 30 seconds
});
```

### RemoteCall.cast()

Asynchronous fire-and-forget:

```typescript
// Don't wait for response
RemoteCall.cast(ref, { type: 'log', message: 'Task started' });

// Good for:
// - Logging/telemetry
// - Notifications
// - Non-critical updates
```

### Smart Call/Cast Helper

Handle both local and remote processes uniformly:

```typescript
import { GenServer } from 'noex';
import { Cluster, RemoteCall, type SerializedRef } from 'noex/distribution';

function isLocalRef(ref: SerializedRef): boolean {
  return ref.nodeId === Cluster.getLocalNodeId();
}

async function smartCall<T>(ref: SerializedRef, msg: unknown): Promise<T> {
  if (isLocalRef(ref)) {
    // Local process - use GenServer directly (faster)
    const localRef = GenServer._getRefById(ref.id);
    if (!localRef) {
      throw new Error(`Process ${ref.id} not found`);
    }
    return GenServer.call(localRef, msg) as Promise<T>;
  }
  // Remote process - use RemoteCall
  return RemoteCall.call<T>(ref, msg);
}

function smartCast(ref: SerializedRef, msg: unknown): void {
  if (isLocalRef(ref)) {
    const localRef = GenServer._getRefById(ref.id);
    if (localRef) {
      GenServer.cast(localRef, msg);
    }
  } else {
    RemoteCall.cast(ref, msg);
  }
}
```

---

## Load Balancing Strategies

### Round-Robin

Distribute work evenly across nodes:

```typescript
class RoundRobinSpawner {
  private index = 0;

  async spawn(behaviorName: string): Promise<SpawnResult> {
    const nodes = Cluster.getConnectedNodes();
    if (nodes.length === 0) {
      throw new Error('No nodes available');
    }

    const node = nodes[this.index % nodes.length];
    this.index++;

    return RemoteSpawn.spawn(behaviorName, node.id);
  }
}
```

### Least Loaded

Spawn on the node with fewest processes:

```typescript
function getLeastLoadedNode(): NodeId {
  const nodes = Cluster.getConnectedNodes();
  if (nodes.length === 0) {
    throw new Error('No nodes available');
  }

  let minNode = nodes[0];
  for (const node of nodes) {
    if (node.processCount < minNode.processCount) {
      minNode = node;
    }
  }

  return minNode.id;
}

async function spawnOnLeastLoaded(behaviorName: string): Promise<SpawnResult> {
  const targetNode = getLeastLoadedNode();
  return RemoteSpawn.spawn(behaviorName, targetNode);
}
```

### Locality-Aware

Prefer local spawning, fall back to remote:

```typescript
async function spawnPreferLocal(behaviorName: string): Promise<SpawnResult> {
  const localId = Cluster.getLocalNodeId();

  // Try local first
  try {
    return await RemoteSpawn.spawn(behaviorName, localId);
  } catch (error) {
    // Local failed, try remote
    const remoteNodes = Cluster.getConnectedNodes()
      .filter((n) => n.id !== localId);

    if (remoteNodes.length === 0) {
      throw error;
    }

    return RemoteSpawn.spawn(behaviorName, remoteNodes[0].id);
  }
}
```

---

## Error Handling

### Spawn Errors

```typescript
import {
  NodeNotReachableError,
  BehaviorNotFoundError,
  RemoteSpawnTimeoutError,
  RemoteSpawnInitError,
  RemoteSpawnRegistrationError,
} from 'noex/distribution';

try {
  const result = await RemoteSpawn.spawn('worker', targetNode);
} catch (error) {
  if (error instanceof NodeNotReachableError) {
    console.log(`Node ${error.nodeId} is not connected`);
  } else if (error instanceof BehaviorNotFoundError) {
    console.log(`Behavior '${error.behaviorName}' not registered on target`);
  } else if (error instanceof RemoteSpawnTimeoutError) {
    console.log('Spawn timed out');
  } else if (error instanceof RemoteSpawnInitError) {
    console.log(`Init failed: ${error.message}`);
  } else if (error instanceof RemoteSpawnRegistrationError) {
    console.log(`Registration failed: ${error.message}`);
  }
}
```

### Call Errors

```typescript
import {
  RemoteCallTimeoutError,
  RemoteServerNotRunningError,
  NodeNotReachableError,
} from 'noex/distribution';

try {
  const result = await RemoteCall.call(ref, message);
} catch (error) {
  if (error instanceof RemoteCallTimeoutError) {
    console.log(`Call timed out after ${error.timeoutMs}ms`);
  } else if (error instanceof RemoteServerNotRunningError) {
    console.log(`Server ${error.serverId} is not running`);
  } else if (error instanceof NodeNotReachableError) {
    console.log(`Node ${error.nodeId} disconnected`);
  }
}
```

---

## Complete Example: Worker Pool

A simple worker pool that distributes tasks across nodes:

```typescript
// shared/worker.ts
import { type GenServerBehavior } from 'noex';

interface WorkerState {
  taskCount: number;
}

type WorkerCall =
  | { type: 'get_stats' };

type WorkerCast =
  | { type: 'process_task'; taskId: string; data: unknown };

type WorkerReply = { taskCount: number };

export const workerBehavior: GenServerBehavior<
  WorkerState,
  WorkerCall,
  WorkerCast,
  WorkerReply
> = {
  init: () => ({
    taskCount: 0,
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get_stats':
        return [{ taskCount: state.taskCount }, state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'process_task': {
        console.log(`Processing task ${msg.taskId}`);
        // Simulate work
        return { ...state, taskCount: state.taskCount + 1 };
      }
    }
  },
};
```

```typescript
// coordinator.ts
import { Cluster, BehaviorRegistry, RemoteSpawn, RemoteCall } from 'noex/distribution';
import { workerBehavior } from './shared/worker.js';

interface WorkerRef {
  id: string;
  nodeId: string;
}

class WorkerPool {
  private workers: WorkerRef[] = [];
  private roundRobin = 0;

  async initialize(workersPerNode: number): Promise<void> {
    const nodes = Cluster.getConnectedNodes();

    for (const node of nodes) {
      for (let i = 0; i < workersPerNode; i++) {
        const result = await RemoteSpawn.spawn('worker', node.id);
        this.workers.push({
          id: result.serverId,
          nodeId: result.nodeId,
        });
      }
    }

    console.log(`Initialized ${this.workers.length} workers`);
  }

  submitTask(taskId: string, data: unknown): void {
    if (this.workers.length === 0) {
      throw new Error('No workers available');
    }

    const worker = this.workers[this.roundRobin % this.workers.length];
    this.roundRobin++;

    RemoteCall.cast(worker, {
      type: 'process_task',
      taskId,
      data,
    });
  }

  async getStats(): Promise<{ taskCount: number }[]> {
    const stats = await Promise.all(
      this.workers.map((worker) =>
        RemoteCall.call<{ taskCount: number }>(worker, { type: 'get_stats' })
      )
    );
    return stats;
  }
}

// Main
async function main(): Promise<void> {
  BehaviorRegistry.register('worker', workerBehavior);

  await Cluster.start({
    nodeName: 'coordinator',
    port: 4369,
    seeds: process.env.SEEDS?.split(',') || [],
  });

  // Wait for nodes to join
  await new Promise((r) => setTimeout(r, 2000));

  const pool = new WorkerPool();
  await pool.initialize(3);  // 3 workers per node

  // Submit tasks
  for (let i = 0; i < 100; i++) {
    pool.submitTask(`task-${i}`, { value: i });
  }

  // Check stats
  const stats = await pool.getStats();
  console.log('Worker stats:', stats);
}

main();
```

---

## Best Practices

### 1. Register All Behaviors on All Nodes

Ensure consistency across the cluster:

```typescript
// behaviors/index.ts - single source of truth
export { workerBehavior } from './worker.js';
export { cacheBehavior } from './cache.js';
export { coordinatorBehavior } from './coordinator.js';

// Every node's startup
import * as behaviors from './behaviors/index.js';

BehaviorRegistry.register('worker', behaviors.workerBehavior);
BehaviorRegistry.register('cache', behaviors.cacheBehavior);
BehaviorRegistry.register('coordinator', behaviors.coordinatorBehavior);

await Cluster.start({ ... });
```

### 2. Use GlobalRegistry for Singletons

When you need exactly one instance cluster-wide:

```typescript
const LEADER_NAME = 'cluster:leader';

if (!GlobalRegistry.isRegistered(LEADER_NAME)) {
  const result = await RemoteSpawn.spawn('leader', localNodeId, {
    name: LEADER_NAME,
    registration: 'global',
  });
  console.log('Became cluster leader');
} else {
  const leader = GlobalRegistry.whereis(LEADER_NAME);
  console.log(`Leader is on ${leader?.nodeId}`);
}
```

### 3. Handle Node Failures

React to nodes going down:

```typescript
Cluster.onNodeDown((nodeId, reason) => {
  // Remove references to processes on that node
  workers = workers.filter((w) => w.nodeId !== nodeId);

  // Possibly spawn replacements
  if (workers.length < minWorkers) {
    spawnMoreWorkers();
  }
});
```

### 4. Use Appropriate Timeouts

Configure timeouts based on your use case:

```typescript
// Fast local operations
await RemoteCall.call(ref, msg, { timeout: 1000 });

// Slow remote operations
await RemoteCall.call(ref, msg, { timeout: 30000 });

// Spawn with custom timeout
await RemoteSpawn.spawn('worker', nodeId, { timeout: 15000 });
```

---

## Related

- [Getting Started](./getting-started.md) - First distributed application
- [Process Monitoring Guide](./process-monitoring.md) - Detect process failures
- [Remote Messaging Concepts](../concepts/remote-messaging.md) - How RemoteCall works
- [RemoteSpawn API](../api/remote-spawn.md) - Complete API reference

---

*[Czech version](../../cs/distribution/guides/remote-processes.md)*
