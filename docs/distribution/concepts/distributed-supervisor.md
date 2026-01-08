# Distributed Supervisor

DistributedSupervisor extends noex's supervision model across cluster nodes, providing automatic failover when nodes go down. It spawns and manages child processes on multiple nodes using the BehaviorRegistry, with configurable node selection strategies and all standard supervisor restart semantics.

## Overview

While regular Supervisors manage processes on a single node, DistributedSupervisor coordinates processes across the entire cluster:

```typescript
import { DistributedSupervisor, BehaviorRegistry, Cluster } from 'noex/distribution';

// 1. Register behaviors on ALL nodes before cluster starts
BehaviorRegistry.register('worker', workerBehavior);

// 2. Start the cluster
await Cluster.start({ nodeName: 'main', port: 4369 });

// 3. Start distributed supervisor
const supRef = await DistributedSupervisor.start({
  strategy: 'one_for_one',
  nodeSelector: 'round_robin',
  children: [
    { id: 'worker-1', behavior: 'worker', restart: 'permanent' },
    { id: 'worker-2', behavior: 'worker', restart: 'permanent' },
    { id: 'worker-3', behavior: 'worker', restart: 'permanent' },
  ],
});

// 4. Children are distributed across cluster nodes
// 5. If a node goes down, affected children automatically restart on other nodes
```

Key capabilities:

- **Cross-node spawning**: Start children on any node using registered behaviors
- **Automatic failover**: Children migrate to healthy nodes when their host goes down
- **Node selection strategies**: Control child placement with built-in or custom selectors
- **Full restart semantics**: All four supervisor strategies supported
- **Lifecycle events**: Monitor supervisor and child state changes

## BehaviorRegistry

Before using DistributedSupervisor, behaviors must be registered on all nodes. BehaviorRegistry maps names to GenServerBehavior implementations for remote spawning:

```typescript
import { BehaviorRegistry } from 'noex/distribution';
import type { GenServerBehavior } from 'noex';

// Define behavior
const workerBehavior: GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerReply> = {
  init: () => ({ tasks: [], status: 'idle' }),
  handleCall: (msg, state) => { /* ... */ },
  handleCast: (msg, state) => { /* ... */ },
};

// Register BEFORE Cluster.start()
BehaviorRegistry.register('worker', workerBehavior);
BehaviorRegistry.register('coordinator', coordinatorBehavior);
BehaviorRegistry.register('metrics-collector', metricsCollectorBehavior);

// Now safe to start cluster and supervisor
await Cluster.start({ nodeName: 'app', port: 4369 });
```

### Registration Timing

```
┌─────────────────────────────────────────────────────────────────┐
│ Node Startup Sequence                                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. BehaviorRegistry.register()  ◄── Must be first              │
│           │                                                      │
│           ▼                                                      │
│  2. Cluster.start()              ◄── Connects to cluster        │
│           │                                                      │
│           ▼                                                      │
│  3. DistributedSupervisor.start() ◄── Can now spawn children    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Checking Registration

```typescript
// Check if behavior exists
if (BehaviorRegistry.has('worker')) {
  // Behavior is registered
}

// Get registered behavior
const behavior = BehaviorRegistry.get('worker');

// List all registered behaviors
const names = BehaviorRegistry.getNames();
// ['worker', 'coordinator', 'metrics-collector']
```

## Child Specification

### DistributedChildSpec

```typescript
interface DistributedChildSpec {
  /** Unique identifier within supervisor */
  id: string;

  /** Registered behavior name */
  behavior: string;

  /** Arguments passed to init() */
  args?: readonly unknown[];

  /** Restart strategy: 'permanent' | 'transient' | 'temporary' */
  restart?: ChildRestartStrategy;

  /** Node selection: strategy name, specific node, or custom function */
  nodeSelector?: NodeSelector;

  /** Graceful shutdown timeout in ms */
  shutdownTimeout?: number;

  /** Marks child as significant for auto_shutdown */
  significant?: boolean;
}
```

### Example Specifications

```typescript
const children: DistributedChildSpec[] = [
  // Basic worker - uses supervisor defaults
  {
    id: 'basic-worker',
    behavior: 'worker',
  },

  // Worker with init arguments
  {
    id: 'configured-worker',
    behavior: 'worker',
    args: [{ poolSize: 10, timeout: 5000 }],
  },

  // Worker on specific node
  {
    id: 'pinned-worker',
    behavior: 'worker',
    nodeSelector: { node: 'storage@192.168.1.10:4369' },
  },

  // Transient worker - only restart on crash
  {
    id: 'task-worker',
    behavior: 'task-processor',
    restart: 'transient',
    nodeSelector: 'round_robin',
  },

  // Critical worker - supervisor shuts down if this terminates
  {
    id: 'critical-worker',
    behavior: 'coordinator',
    significant: true,
    shutdownTimeout: 30000,
  },
];
```

## Node Selection

DistributedSupervisor supports multiple strategies for choosing which node hosts each child.

### Built-in Strategies

| Strategy | Description |
|----------|-------------|
| `'local_first'` | Prefer local node, fallback to connected nodes (default) |
| `'round_robin'` | Rotate through available nodes in sequence |
| `'least_loaded'` | Select node with lowest process count |
| `'random'` | Random selection from available nodes |

```typescript
// Supervisor-level default
await DistributedSupervisor.start({
  nodeSelector: 'round_robin', // Applied to all children without explicit selector
  children: [
    { id: 'w1', behavior: 'worker' }, // Uses round_robin
    { id: 'w2', behavior: 'worker' }, // Uses round_robin
    { id: 'w3', behavior: 'worker', nodeSelector: 'local_first' }, // Override
  ],
});
```

### Specific Node

Pin a child to a specific node:

```typescript
{
  id: 'cache',
  behavior: 'cache',
  nodeSelector: { node: 'cache-node@192.168.1.50:4369' },
}
```

### Custom Selector

Implement custom placement logic:

```typescript
import type { NodeSelectorFn, NodeInfo } from 'noex/distribution';

// Prefer nodes with specific naming pattern
const workerNodeSelector: NodeSelectorFn = (nodes, childId) => {
  const workerNodes = nodes.filter(n => n.id.startsWith('worker'));

  if (workerNodes.length === 0) {
    // Fallback to any available node
    if (nodes.length === 0) {
      throw new Error(`No nodes available for ${childId}`);
    }
    return nodes[0].id;
  }

  // Least loaded among worker nodes
  const sorted = [...workerNodes].sort((a, b) => a.processCount - b.processCount);
  return sorted[0].id;
};

// Use in spec
{
  id: 'compute-worker',
  behavior: 'worker',
  nodeSelector: workerNodeSelector,
}
```

## Restart Strategies

DistributedSupervisor supports all standard supervisor strategies:

### one_for_one (Default)

Only the failed child is restarted:

```
                 ┌─────┐  ┌─────┐  ┌─────┐
Before:          │  A  │  │  B  │  │  C  │
                 └─────┘  └─────┘  └─────┘
                     │        X        │
                     │    (crash)      │
                     ▼                 ▼
                 ┌─────┐  ┌─────┐  ┌─────┐
After:           │  A  │  │ B'  │  │  C  │
                 └─────┘  └─────┘  └─────┘
                          (new instance)
```

### one_for_all

All children restart when one fails:

```
                 ┌─────┐  ┌─────┐  ┌─────┐
Before:          │  A  │  │  B  │  │  C  │
                 └─────┘  └─────┘  └─────┘
                     │        X        │
                     │    (crash)      │
                     ▼        ▼        ▼
                 ┌─────┐  ┌─────┐  ┌─────┐
After:           │ A'  │  │ B'  │  │ C'  │
                 └─────┘  └─────┘  └─────┘
                 (all new instances)
```

### rest_for_one

The failed child and all children started after it restart:

```
                 ┌─────┐  ┌─────┐  ┌─────┐
Before:          │  A  │  │  B  │  │  C  │
                 └─────┘  └─────┘  └─────┘
                     │        X        │
                     │    (crash)      │
                     ▼        ▼        ▼
                 ┌─────┐  ┌─────┐  ┌─────┐
After:           │  A  │  │ B'  │  │ C'  │
                 └─────┘  └─────┘  └─────┘
                           (B and C restart)
```

### simple_one_for_one

Dynamic child creation from a template:

```typescript
const supRef = await DistributedSupervisor.start({
  strategy: 'simple_one_for_one',
  childTemplate: {
    behavior: 'worker',
    restart: 'transient',
    nodeSelector: 'round_robin',
  },
});

// Start children dynamically with arguments
const ref1 = await DistributedSupervisor.startChild(supRef, [{ task: 'images' }]);
const ref2 = await DistributedSupervisor.startChild(supRef, [{ task: 'videos' }]);
const ref3 = await DistributedSupervisor.startChild(supRef, [{ task: 'audio' }]);
```

## Automatic Failover

When a node goes down, DistributedSupervisor automatically restarts affected children on healthy nodes:

```
┌────────────────────────────────────────────────────────────────────┐
│ Failover Flow                                                      │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ┌──────────┐         ┌──────────┐         ┌──────────┐          │
│   │  Node A  │         │  Node B  │         │  Node C  │          │
│   │ (sup)    │         │ [w1][w2] │         │   [w3]   │          │
│   └────┬─────┘         └────┬─────┘         └────┬─────┘          │
│        │                    │                    │                 │
│        │               NODE DOWN!                │                 │
│        │                    X                    │                 │
│        │                                         │                 │
│        │◄──────── Cluster.onNodeDown ───────────│                 │
│        │                                         │                 │
│        │    NodeSelector(excludes B)             │                 │
│        │─────────────────────────────────────────►                 │
│        │                                         │                 │
│   ┌────┴─────┐                             ┌────┴─────┐           │
│   │  Node A  │                             │  Node C  │           │
│   │ (sup)    │                             │[w3][w1][w2]          │
│   └──────────┘                             └──────────┘           │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Failover Behavior

1. **Detection**: Cluster heartbeat timeout triggers `nodeDown` event
2. **Identification**: Supervisor identifies children on the failed node
3. **Selection**: NodeSelector chooses new target (excludes failed node)
4. **Restart**: Children are spawned on the new node
5. **Update**: Internal registry updated with new locations

### Restart Intensity

Prevents infinite restart loops with configurable limits:

```typescript
await DistributedSupervisor.start({
  children: [/* ... */],
  restartIntensity: {
    maxRestarts: 5,      // Maximum restarts allowed
    withinMs: 60000,     // Within this time window
  },
});
```

If exceeded, the supervisor itself shuts down and throws `DistributedMaxRestartsExceededError`.

## Lifecycle Events

Monitor supervisor and child state changes:

```typescript
const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'supervisor_started':
      console.log(`Supervisor started: ${event.ref.id}`);
      break;

    case 'supervisor_stopped':
      console.log(`Supervisor stopped: ${event.ref.id} (${event.reason})`);
      break;

    case 'child_started':
      console.log(`Child ${event.childId} started on ${event.nodeId}`);
      break;

    case 'child_stopped':
      console.log(`Child ${event.childId} stopped: ${event.reason}`);
      break;

    case 'child_restarted':
      console.log(`Child ${event.childId} restarted on ${event.nodeId} (attempt ${event.attempt})`);
      break;

    case 'child_migrated':
      console.log(`Child ${event.childId} migrated: ${event.fromNode} -> ${event.toNode}`);
      break;

    case 'node_failure_detected':
      console.log(`Node ${event.nodeId} failed, affected: ${event.affectedChildren.join(', ')}`);
      break;
  }
});

// Later: stop listening
unsubscribe();
```

## Statistics

Get runtime statistics about the supervisor:

```typescript
const stats = DistributedSupervisor.getStats(supRef);

console.log(`Strategy: ${stats.strategy}`);
console.log(`Children: ${stats.childCount}`);
console.log(`Total restarts: ${stats.totalRestarts}`);
console.log(`Node failure restarts: ${stats.nodeFailureRestarts}`);
console.log(`Uptime: ${stats.uptimeMs}ms`);

// Children by node
for (const [nodeId, count] of stats.childrenByNode) {
  console.log(`  ${nodeId}: ${count} children`);
}
```

### Stats Interface

```typescript
interface DistributedSupervisorStats {
  id: string;
  strategy: SupervisorStrategy;
  childCount: number;
  childrenByNode: ReadonlyMap<NodeId, number>;
  totalRestarts: number;
  nodeFailureRestarts: number;
  startedAt: number;
  uptimeMs: number;
}
```

## Child Management

### Query Children

```typescript
// Get all children
const children = DistributedSupervisor.getChildren(supRef);
for (const child of children) {
  console.log(`${child.id} on ${child.nodeId}, restarts: ${child.restartCount}`);
}

// Get specific child
const worker = DistributedSupervisor.getChild(supRef, 'worker-1');
if (worker) {
  console.log(`Worker running on ${worker.nodeId}`);
}

// Count children
const count = DistributedSupervisor.countChildren(supRef);
```

### Dynamic Child Management

```typescript
// Add child dynamically
const newRef = await DistributedSupervisor.startChild(supRef, {
  id: 'worker-4',
  behavior: 'worker',
  nodeSelector: 'least_loaded',
});

// Manually restart child
await DistributedSupervisor.restartChild(supRef, 'worker-1');

// Remove child
await DistributedSupervisor.terminateChild(supRef, 'worker-4');
```

### Shutdown

```typescript
// Graceful shutdown - stops all children in reverse order
await DistributedSupervisor.stop(supRef);

// With reason
await DistributedSupervisor.stop(supRef, 'shutdown');
```

## Auto-Shutdown

Configure supervisor to shut down based on child terminations:

```typescript
await DistributedSupervisor.start({
  autoShutdown: 'any_significant', // or 'all_significant' or 'never'
  children: [
    { id: 'main', behavior: 'main', significant: true },
    { id: 'helper', behavior: 'helper', significant: false },
  ],
});
```

| Setting | Behavior |
|---------|----------|
| `'never'` | Supervisor runs until explicitly stopped (default) |
| `'any_significant'` | Shuts down when any `significant: true` child terminates |
| `'all_significant'` | Shuts down when all significant children have terminated |

## Complete Example

```typescript
import { GenServer, type GenServerBehavior } from 'noex';
import {
  Cluster,
  BehaviorRegistry,
  DistributedSupervisor,
  type DistributedChildSpec,
} from 'noex/distribution';

// 1. Define behaviors
interface WorkerState { taskCount: number }
interface WorkerCall { type: 'get_count' }
interface WorkerCast { type: 'process'; data: unknown }
type WorkerReply = number;

const workerBehavior: GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerReply> = {
  init: () => ({ taskCount: 0 }),

  handleCall(msg, state) {
    if (msg.type === 'get_count') {
      return [state.taskCount, state];
    }
    return [0, state];
  },

  handleCast(msg, state) {
    if (msg.type === 'process') {
      // Process the task...
      return { taskCount: state.taskCount + 1 };
    }
    return state;
  },
};

// 2. Register behaviors
BehaviorRegistry.register('worker', workerBehavior);

// 3. Start cluster
await Cluster.start({
  nodeName: 'main',
  port: 4369,
  seeds: process.env.SEEDS?.split(',') || [],
});

// 4. Monitor lifecycle events
DistributedSupervisor.onLifecycleEvent((event) => {
  if (event.type === 'child_migrated') {
    console.log(`[FAILOVER] ${event.childId}: ${event.fromNode} -> ${event.toNode}`);
  }
});

// 5. Start supervisor with distributed workers
const supRef = await DistributedSupervisor.start({
  strategy: 'one_for_one',
  nodeSelector: 'round_robin',
  restartIntensity: { maxRestarts: 10, withinMs: 60000 },

  children: [
    { id: 'worker-1', behavior: 'worker' },
    { id: 'worker-2', behavior: 'worker' },
    { id: 'worker-3', behavior: 'worker' },
  ],
});

// 6. Access children
const children = DistributedSupervisor.getChildren(supRef);
for (const child of children) {
  console.log(`${child.id} running on ${child.nodeId}`);
}

// 7. Graceful shutdown
process.on('SIGTERM', async () => {
  await DistributedSupervisor.stop(supRef);
  await Cluster.stop();
  process.exit(0);
});
```

## Error Handling

```typescript
import {
  DistributedSupervisor,
  DistributedBehaviorNotFoundError,
  DistributedMaxRestartsExceededError,
  DistributedChildNotFoundError,
  NoAvailableNodeError,
} from 'noex/distribution';

try {
  await DistributedSupervisor.startChild(supRef, {
    id: 'worker',
    behavior: 'unregistered-behavior',
  });
} catch (error) {
  if (error instanceof DistributedBehaviorNotFoundError) {
    console.error(`Behavior '${error.behaviorName}' not found on ${error.nodeId}`);
  } else if (error instanceof NoAvailableNodeError) {
    console.error(`No nodes available for child '${error.childId}'`);
  } else if (error instanceof DistributedMaxRestartsExceededError) {
    console.error(`Too many restarts: ${error.maxRestarts} in ${error.withinMs}ms`);
  }
}
```

## Best Practices

### 1. Register Behaviors Early

```typescript
// At module initialization, before any async code
BehaviorRegistry.register('worker', workerBehavior);
BehaviorRegistry.register('coordinator', coordinatorBehavior);

// Then start cluster
await Cluster.start(config);
```

### 2. Use Appropriate Node Selectors

```typescript
// CPU-intensive: spread across nodes
{ nodeSelector: 'round_robin' }

// Stateful: pin to specific node
{ nodeSelector: { node: 'storage@host:4369' } }

// Minimize latency: prefer local
{ nodeSelector: 'local_first' }
```

### 3. Set Reasonable Restart Intensity

```typescript
// Production: more tolerant
{ restartIntensity: { maxRestarts: 10, withinMs: 60000 } }

// Development: fail fast
{ restartIntensity: { maxRestarts: 3, withinMs: 5000 } }
```

### 4. Use Lifecycle Events for Monitoring

```typescript
DistributedSupervisor.onLifecycleEvent((event) => {
  metrics.record('distributed_supervisor_event', {
    type: event.type,
    supervisor: 'supervisorId' in event ? event.supervisorId : event.ref?.id,
  });
});
```

### 5. Handle Graceful Shutdown

```typescript
async function shutdown(): Promise<void> {
  // Stop accepting new work first
  // ...

  // Then stop supervisors
  await DistributedSupervisor.stop(supRef);

  // Finally stop cluster
  await Cluster.stop();
}
```

## Related

- [Overview](./overview.md) - Distribution architecture
- [Cluster](./cluster.md) - Node management and failure detection
- [Remote Messaging](./remote-messaging.md) - Communicating with distributed children
- [Global Registry](./global-registry.md) - Naming distributed processes
- [DistributedSupervisor API Reference](../api/distributed-supervisor.md) - Complete API

---

*[Czech version](../../cs/distribution/concepts/distributed-supervisor.md)*
