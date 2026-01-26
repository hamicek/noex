# Distributed Supervisor

In previous chapters, you learned how to form clusters and make remote calls. Now it's time to combine these capabilities with supervision — **DistributedSupervisor** extends noex's fault-tolerance model across the entire cluster, automatically migrating processes to healthy nodes when failures occur.

## What You'll Learn

- Understand the difference between local and distributed supervision
- Register behaviors for remote spawning using `BehaviorRegistry`
- Configure node selection strategies for child placement
- Use all four supervisor restart strategies in a distributed context
- Handle automatic failover when nodes go down
- Monitor distributed supervision with lifecycle events
- Build a fault-tolerant distributed worker pool

## Why Distributed Supervision?

A regular Supervisor manages processes on a single machine. If that machine fails, all supervised processes are lost. DistributedSupervisor solves this by distributing children across cluster nodes and automatically restarting them elsewhere when a node goes down.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                  LOCAL vs DISTRIBUTED SUPERVISION                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  LOCAL SUPERVISOR                    DISTRIBUTED SUPERVISOR                 │
│  ────────────────────                ────────────────────────               │
│                                                                             │
│    ┌─────────────────────┐           ┌─────────────────────────────────┐   │
│    │      Node A         │           │          Cluster                │   │
│    │  ┌──────────────┐   │           │  ┌────────┐  ┌────────┐        │   │
│    │  │  Supervisor  │   │           │  │ Node A │  │ Node B │        │   │
│    │  └──────┬───────┘   │           │  │ [Sup]  │  │  [w2]  │        │   │
│    │         │           │           │  │  [w1]  │  │  [w3]  │        │   │
│    │    ┌────┼────┐      │           │  └────────┘  └────────┘        │   │
│    │    ▼    ▼    ▼      │           │       │          │             │   │
│    │  ┌──┐ ┌──┐ ┌──┐     │           │       └────┬─────┘             │   │
│    │  │w1│ │w2│ │w3│     │           │            │                   │   │
│    │  └──┘ └──┘ └──┘     │           │       ┌────────┐               │   │
│    └─────────────────────┘           │       │ Node C │               │   │
│                                      │       │  [w4]  │               │   │
│    If Node A fails:                  │       └────────┘               │   │
│    → ALL workers lost!               │                                │   │
│                                      │  If Node B fails:              │   │
│                                      │  → w2, w3 restart on A or C    │   │
│                                      └─────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key capabilities:**

- **Cross-node spawning**: Start children on any node in the cluster
- **Automatic failover**: Children migrate to healthy nodes when their host goes down
- **Node selection**: Control where children run with built-in or custom strategies
- **Full restart semantics**: All four supervisor strategies work across nodes
- **Lifecycle events**: Monitor child migrations and node failures

## BehaviorRegistry: The Foundation

Before a DistributedSupervisor can spawn a child on a remote node, that node must know *how* to create it. Since functions can't be serialized over the network, behaviors must be pre-registered on all nodes using `BehaviorRegistry`.

### Why Pre-Registration?

When the supervisor on Node A tells Node B to "spawn a worker", Node B needs the complete behavior:
- The `init()` function
- The `handleCall()` function
- The `handleCast()` function
- Any other behavior options

Both nodes must have identical behaviors registered under the same name.

```typescript
import { BehaviorRegistry, type GenServerBehavior } from '@hamicek/noex';

// Define your behavior
interface WorkerState {
  taskCount: number;
  status: 'idle' | 'busy';
}

type WorkerCall = { type: 'get_status' } | { type: 'get_count' };
type WorkerCast = { type: 'process'; data: unknown };
type WorkerReply = WorkerState | number;

const workerBehavior: GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerReply> = {
  init: () => ({ taskCount: 0, status: 'idle' }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get_status':
        return [state, state];
      case 'get_count':
        return [state.taskCount, state];
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'process') {
      return { taskCount: state.taskCount + 1, status: 'idle' };
    }
    return state;
  },
};

// Register on ALL nodes before starting the cluster
BehaviorRegistry.register('worker', workerBehavior);
```

### Registration Timing

The order of operations is critical:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         NODE STARTUP SEQUENCE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. BehaviorRegistry.register()  ◄── Must happen first                      │
│           │                          (before any async operations)          │
│           ▼                                                                 │
│  2. Cluster.start()              ◄── Connects to other nodes                │
│           │                                                                 │
│           ▼                                                                 │
│  3. DistributedSupervisor.start() ◄── Can now spawn children anywhere       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Checking Registration

```typescript
// Check if behavior exists
if (BehaviorRegistry.has('worker')) {
  console.log('Worker behavior is registered');
}

// Get registered behavior (for inspection)
const behavior = BehaviorRegistry.get('worker');

// List all registered behavior names
const names = BehaviorRegistry.getNames();
console.log('Registered behaviors:', names);
// ['worker', 'coordinator', 'cache']
```

## Starting a Distributed Supervisor

Once behaviors are registered and the cluster is running, you can start a DistributedSupervisor:

```typescript
import { Cluster, DistributedSupervisor, BehaviorRegistry } from '@hamicek/noex/distribution';

// 1. Register behaviors (on ALL nodes)
BehaviorRegistry.register('worker', workerBehavior);

// 2. Start cluster
await Cluster.start({
  nodeName: 'supervisor-node',
  port: 4369,
  seeds: ['worker-node@192.168.1.10:4370'],
});

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

console.log('Distributed supervisor started:', supRef.id);
```

### Configuration Options

```typescript
interface DistributedSupervisorOptions {
  // Restart strategy (default: 'one_for_one')
  strategy?: 'one_for_one' | 'one_for_all' | 'rest_for_one' | 'simple_one_for_one';

  // Default node selection for children (default: 'local_first')
  nodeSelector?: NodeSelector;

  // Initial children (not allowed with simple_one_for_one)
  children?: DistributedChildSpec[];

  // Template for dynamic children (required for simple_one_for_one)
  childTemplate?: DistributedChildTemplate;

  // Restart intensity limits (default: { maxRestarts: 3, withinMs: 5000 })
  restartIntensity?: { maxRestarts: number; withinMs: number };

  // Auto-shutdown behavior (default: 'never')
  autoShutdown?: 'never' | 'any_significant' | 'all_significant';

  // Optional global registry name
  name?: string;
}
```

## Child Specification

Unlike regular `ChildSpec` which uses a start function, `DistributedChildSpec` uses a behavior name (registered in `BehaviorRegistry`):

```typescript
interface DistributedChildSpec {
  // Unique identifier within this supervisor
  id: string;

  // Name of the registered behavior
  behavior: string;

  // Arguments passed to init() (must be serializable)
  args?: readonly unknown[];

  // Restart strategy: 'permanent' | 'transient' | 'temporary'
  restart?: ChildRestartStrategy;

  // Node selection strategy for this child
  nodeSelector?: NodeSelector;

  // Graceful shutdown timeout in ms (default: 5000)
  shutdownTimeout?: number;

  // Marks as significant for auto_shutdown
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

  // Worker pinned to specific node
  {
    id: 'storage-worker',
    behavior: 'storage',
    nodeSelector: { node: 'storage@192.168.1.50:4369' as NodeId },
  },

  // Transient worker - only restart on crash, not normal exit
  {
    id: 'task-worker',
    behavior: 'task-processor',
    restart: 'transient',
    nodeSelector: 'round_robin',
  },

  // Critical worker - supervisor shuts down if this terminates
  {
    id: 'coordinator',
    behavior: 'coordinator',
    restart: 'permanent',
    significant: true,
    shutdownTimeout: 30000,
  },
];
```

## Node Selection Strategies

DistributedSupervisor provides multiple strategies for choosing where to spawn children.

### Built-in Strategies

| Strategy | Description |
|----------|-------------|
| `'local_first'` | Prefer local node, fallback to connected nodes (default) |
| `'round_robin'` | Rotate through available nodes in sequence |
| `'least_loaded'` | Select the node with the lowest process count |
| `'random'` | Random selection from available nodes |

```typescript
// Supervisor-level default applies to all children
const supRef = await DistributedSupervisor.start({
  nodeSelector: 'round_robin',  // Default for all children
  children: [
    { id: 'w1', behavior: 'worker' },  // Uses round_robin
    { id: 'w2', behavior: 'worker' },  // Uses round_robin
    { id: 'w3', behavior: 'worker', nodeSelector: 'local_first' },  // Override
  ],
});
```

### Specific Node

Pin a child to a specific node:

```typescript
{
  id: 'cache',
  behavior: 'cache',
  nodeSelector: { node: 'cache-node@192.168.1.50:4369' as NodeId },
}
```

**Warning**: If the specific node is down, the child cannot start or be restarted there. Consider using a custom selector with fallback logic.

### Custom Selector Function

Implement custom placement logic:

```typescript
import type { NodeSelectorFn, NodeInfo } from '@hamicek/noex/distribution';

// Prefer nodes with "worker" in their name
const workerNodeSelector: NodeSelectorFn = (nodes, childId) => {
  const workerNodes = nodes.filter(n => n.id.includes('worker'));

  if (workerNodes.length === 0) {
    // Fallback to any available node
    if (nodes.length === 0) {
      throw new Error(`No nodes available for ${childId}`);
    }
    return nodes[0].id;
  }

  // Among worker nodes, select least loaded
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

### Node Selection Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         NODE SELECTION FLOW                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                  Child needs to be spawned/restarted                        │
│                              │                                              │
│                              ▼                                              │
│                  ┌───────────────────────┐                                  │
│                  │ Has child-level       │                                  │
│                  │ nodeSelector?         │                                  │
│                  └───────────┬───────────┘                                  │
│                    │                   │                                    │
│               YES  │                   │  NO                                │
│                    ▼                   ▼                                    │
│           ┌──────────────┐   ┌──────────────────┐                           │
│           │ Use child's  │   │ Use supervisor's │                           │
│           │ selector     │   │ default selector │                           │
│           └──────┬───────┘   └────────┬─────────┘                           │
│                  │                    │                                     │
│                  └─────────┬──────────┘                                     │
│                            ▼                                                │
│                  ┌───────────────────────┐                                  │
│                  │ Get available nodes   │                                  │
│                  │ (exclude failed node  │                                  │
│                  │  during failover)     │                                  │
│                  └───────────┬───────────┘                                  │
│                              ▼                                              │
│                  ┌───────────────────────┐                                  │
│                  │ Apply selection       │                                  │
│                  │ strategy              │                                  │
│                  └───────────┬───────────┘                                  │
│                              ▼                                              │
│                       Selected NodeId                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Restart Strategies

DistributedSupervisor supports all four standard supervisor strategies, applied across the cluster.

### one_for_one (Default)

Only the failed child is restarted. The simplest and most common strategy.

```
                 Node A           Node B           Node C
                ┌─────┐          ┌─────┐          ┌─────┐
Before:         │ w1  │          │ w2  │          │ w3  │
                └─────┘          └─────┘          └─────┘
                    │                X                │
                    │            (crash)              │
                    ▼                ▼                ▼
                ┌─────┐          ┌─────┐          ┌─────┐
After:          │ w1  │          │ w2' │          │ w3  │
                └─────┘          └─────┘          └─────┘
                                 (restarted, possibly
                                  on a different node)
```

### one_for_all

All children restart when one fails. Use when children have tight dependencies.

```
                 Node A           Node B           Node C
                ┌─────┐          ┌─────┐          ┌─────┐
Before:         │ w1  │          │ w2  │          │ w3  │
                └─────┘          └─────┘          └─────┘
                    │                X                │
                    │            (crash)              │
                    ▼                ▼                ▼
                ┌─────┐          ┌─────┐          ┌─────┐
After:          │ w1' │          │ w2' │          │ w3' │
                └─────┘          └─────┘          └─────┘
                (all three restarted, node assignment
                 may change based on selector)
```

### rest_for_one

The failed child and all children started after it restart. Use for sequential dependencies.

```
                Start order: w1 → w2 → w3

                 Node A           Node B           Node C
                ┌─────┐          ┌─────┐          ┌─────┐
Before:         │ w1  │          │ w2  │          │ w3  │
                └─────┘          └─────┘          └─────┘
                    │                X                │
                    │            (crash)              │
                    ▼                ▼                ▼
                ┌─────┐          ┌─────┐          ┌─────┐
After:          │ w1  │          │ w2' │          │ w3' │
                └─────┘          └─────┘          └─────┘
                (unchanged)      (w2 and w3 restarted)
```

### simple_one_for_one

Dynamic child creation from a template. All children are equivalent.

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

// Each child is distributed across the cluster according to the template's selector
```

## Automatic Failover

The most powerful feature of DistributedSupervisor is automatic failover — when a node goes down, affected children are automatically restarted on healthy nodes.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AUTOMATIC FAILOVER FLOW                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  TIME 0: Normal operation                                                   │
│  ─────────────────────────                                                  │
│                                                                             │
│     ┌──────────┐         ┌──────────┐         ┌──────────┐                 │
│     │  Node A  │         │  Node B  │         │  Node C  │                 │
│     │  [Sup]   │         │   [w1]   │         │   [w3]   │                 │
│     │          │         │   [w2]   │         │   [w4]   │                 │
│     └────┬─────┘         └────┬─────┘         └────┬─────┘                 │
│          │                    │                    │                        │
│          └────────────────────┴────────────────────┘                        │
│                     (heartbeats flowing)                                    │
│                                                                             │
│  TIME 1: Node B fails                                                       │
│  ────────────────────                                                       │
│                                                                             │
│     ┌──────────┐              ╳              ┌──────────┐                  │
│     │  Node A  │         │  Node B  │         │  Node C  │                 │
│     │  [Sup]   │         │   DEAD   │         │   [w3]   │                 │
│     │          │         │          │         │   [w4]   │                 │
│     └────┬─────┘         └──────────┘         └────┬─────┘                 │
│          │                                         │                        │
│          │◄──── heartbeat timeout ─────────────────│                        │
│          │      (node_down event)                  │                        │
│                                                                             │
│  TIME 2: Supervisor detects failure and restarts children                   │
│  ─────────────────────────────────────────────────────────                  │
│                                                                             │
│     ┌──────────┐                              ┌──────────┐                  │
│     │  Node A  │   NodeSelector               │  Node C  │                 │
│     │  [Sup]   │─────(excludes B)────────────►│   [w3]   │                 │
│     │   [w1']  │                              │   [w4]   │                 │
│     └──────────┘                              │   [w2']  │                 │
│                                               └──────────┘                  │
│                                                                             │
│  Result: w1 and w2 restarted on healthy nodes (A and C)                    │
│  Supervisor emits 'child_migrated' events for each                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Failover Process

1. **Detection**: Cluster heartbeat timeout triggers `node_down` event
2. **Identification**: Supervisor identifies all children on the failed node
3. **Restart Decision**: Check each child's restart strategy (`permanent`, `transient`, `temporary`)
4. **Node Selection**: NodeSelector chooses new target (failed node is excluded)
5. **Spawn**: Children are spawned on new nodes via BehaviorRegistry
6. **Registry Update**: Internal registry updated with new locations
7. **Events**: `child_migrated` events emitted for monitoring

### Restart Intensity

To prevent infinite restart loops (e.g., a bug that crashes children immediately), configure restart intensity limits:

```typescript
await DistributedSupervisor.start({
  children: [/* ... */],
  restartIntensity: {
    maxRestarts: 5,       // Maximum restarts allowed
    withinMs: 60000,      // Within this time window (1 minute)
  },
});
```

If the limit is exceeded, the supervisor shuts down and throws `DistributedMaxRestartsExceededError`. This is a safety mechanism — investigate the root cause before increasing limits.

## Lifecycle Events

Monitor distributed supervision with lifecycle events:

```typescript
const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'supervisor_started':
      console.log(`[START] Supervisor ${event.ref.id} started`);
      break;

    case 'supervisor_stopped':
      console.log(`[STOP] Supervisor ${event.ref.id} stopped: ${event.reason}`);
      break;

    case 'child_started':
      console.log(`[CHILD] ${event.childId} started on ${event.nodeId}`);
      break;

    case 'child_stopped':
      console.log(`[CHILD] ${event.childId} stopped: ${event.reason}`);
      break;

    case 'child_restarted':
      console.log(`[RESTART] ${event.childId} restarted on ${event.nodeId} (attempt ${event.attempt})`);
      break;

    case 'child_migrated':
      console.log(`[MIGRATE] ${event.childId}: ${event.fromNode} → ${event.toNode}`);
      break;

    case 'node_failure_detected':
      console.log(`[FAILURE] Node ${event.nodeId} down, affected: ${event.affectedChildren.join(', ')}`);
      break;
  }
});

// Later: stop listening
unsubscribe();
```

### Event Types Reference

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    DISTRIBUTED SUPERVISOR EVENTS                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  SUPERVISOR LIFECYCLE                                                       │
│  ─────────────────────                                                      │
│  supervisor_started    → Supervisor started successfully                    │
│  supervisor_stopped    → Supervisor shut down (reason provided)             │
│                                                                             │
│  CHILD LIFECYCLE                                                            │
│  ───────────────────                                                        │
│  child_started         → Child spawned successfully on a node               │
│  child_stopped         → Child terminated (reason: normal/crash/shutdown)   │
│  child_restarted       → Child restarted after crash (attempt count)        │
│                                                                             │
│  DISTRIBUTION EVENTS                                                        │
│  ───────────────────────                                                    │
│  child_migrated        → Child moved from one node to another              │
│  node_failure_detected → Node went down, lists affected children            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Statistics and Queries

### Supervisor Statistics

```typescript
const stats = DistributedSupervisor.getStats(supRef);

console.log(`Supervisor: ${stats.id}`);
console.log(`Strategy: ${stats.strategy}`);
console.log(`Children: ${stats.childCount}`);
console.log(`Total restarts: ${stats.totalRestarts}`);
console.log(`Node failure restarts: ${stats.nodeFailureRestarts}`);
console.log(`Uptime: ${Math.round(stats.uptimeMs / 1000)}s`);

// Children distribution across nodes
console.log('Distribution by node:');
for (const [nodeId, count] of stats.childrenByNode) {
  console.log(`  ${nodeId}: ${count} children`);
}
```

### Querying Children

```typescript
// Get all children
const children = DistributedSupervisor.getChildren(supRef);
for (const child of children) {
  console.log(`${child.id} on ${child.nodeId} (restarts: ${child.restartCount})`);
}

// Get specific child
const worker = DistributedSupervisor.getChild(supRef, 'worker-1');
if (worker) {
  console.log(`Worker-1 running on ${worker.nodeId}`);
  console.log(`Started at: ${new Date(worker.startedAt).toISOString()}`);
}

// Count children
const count = DistributedSupervisor.countChildren(supRef);
console.log(`Managing ${count} children`);

// Check if running
if (DistributedSupervisor.isRunning(supRef)) {
  console.log('Supervisor is active');
}
```

## Dynamic Child Management

### Adding Children

```typescript
// For non-simple_one_for_one supervisors: provide a spec
const newRef = await DistributedSupervisor.startChild(supRef, {
  id: 'worker-4',
  behavior: 'worker',
  args: [{ priority: 'high' }],
  nodeSelector: 'least_loaded',
});

// For simple_one_for_one supervisors: provide arguments array
const taskRef = await DistributedSupervisor.startChild(supRef, [{ task: 'process-images' }]);
```

### Manual Operations

```typescript
// Manually restart a child (useful for deploying new code)
const newRef = await DistributedSupervisor.restartChild(supRef, 'worker-1');

// Terminate a child (removes from supervisor)
await DistributedSupervisor.terminateChild(supRef, 'worker-4');
```

### Graceful Shutdown

```typescript
// Stop supervisor and all children
await DistributedSupervisor.stop(supRef);

// With explicit reason
await DistributedSupervisor.stop(supRef, 'shutdown');
```

Children are stopped in reverse start order (last started = first stopped).

## Auto-Shutdown

Configure supervisor behavior when children terminate:

```typescript
await DistributedSupervisor.start({
  autoShutdown: 'any_significant',
  children: [
    { id: 'main', behavior: 'coordinator', significant: true },
    { id: 'helper', behavior: 'helper', significant: false },
  ],
});
```

| Setting | Behavior |
|---------|----------|
| `'never'` | Supervisor runs until explicitly stopped (default) |
| `'any_significant'` | Shuts down when ANY `significant: true` child terminates |
| `'all_significant'` | Shuts down when ALL significant children have terminated |

## Error Handling

```typescript
import {
  DistributedSupervisor,
  DistributedBehaviorNotFoundError,
  DistributedDuplicateChildError,
  DistributedChildNotFoundError,
  DistributedMaxRestartsExceededError,
  NoAvailableNodeError,
} from '@hamicek/noex/distribution';

try {
  await DistributedSupervisor.startChild(supRef, {
    id: 'worker',
    behavior: 'unregistered-behavior',
  });
} catch (error) {
  if (error instanceof DistributedBehaviorNotFoundError) {
    console.error(`Behavior '${error.behaviorName}' not registered on ${error.nodeId}`);
  } else if (error instanceof DistributedDuplicateChildError) {
    console.error(`Child '${error.childId}' already exists`);
  } else if (error instanceof NoAvailableNodeError) {
    console.error(`No nodes available for child '${error.childId}'`);
  } else if (error instanceof DistributedMaxRestartsExceededError) {
    console.error(`Restart limit exceeded: ${error.maxRestarts} in ${error.withinMs}ms`);
  }
}
```

## Practical Example: Distributed Worker Pool

Let's build a production-ready distributed worker pool that processes tasks across the cluster:

```typescript
// distributed-worker-pool.ts
import {
  GenServer,
  type GenServerBehavior,
  type GenServerRef,
} from '@hamicek/noex';
import {
  Cluster,
  BehaviorRegistry,
  DistributedSupervisor,
  type DistributedSupervisorRef,
  type DistributedChildSpec,
  type NodeId,
} from '@hamicek/noex/distribution';

// ============================================================================
// Worker Behavior
// ============================================================================

interface WorkerState {
  processedCount: number;
  failedCount: number;
  lastTaskAt: number | null;
}

type WorkerCall =
  | { type: 'get_stats' }
  | { type: 'process'; task: Task };

type WorkerCast =
  | { type: 'reset_stats' };

interface Task {
  id: string;
  payload: string;
}

interface TaskResult {
  taskId: string;
  success: boolean;
  result?: string;
  error?: string;
}

const workerBehavior: GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerState | TaskResult> = {
  init: () => ({
    processedCount: 0,
    failedCount: 0,
    lastTaskAt: null,
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get_stats':
        return [state, state];

      case 'process': {
        const task = msg.task;

        // Simulate processing (might fail randomly for demo)
        const shouldFail = Math.random() < 0.1;

        if (shouldFail) {
          const newState: WorkerState = {
            ...state,
            failedCount: state.failedCount + 1,
            lastTaskAt: Date.now(),
          };
          return [{
            taskId: task.id,
            success: false,
            error: 'Random processing failure',
          }, newState];
        }

        const result: TaskResult = {
          taskId: task.id,
          success: true,
          result: `Processed: ${task.payload.toUpperCase()}`,
        };

        const newState: WorkerState = {
          ...state,
          processedCount: state.processedCount + 1,
          lastTaskAt: Date.now(),
        };

        return [result, newState];
      }
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'reset_stats') {
      return {
        processedCount: 0,
        failedCount: 0,
        lastTaskAt: null,
      };
    }
    return state;
  },
};

// ============================================================================
// Worker Pool Manager
// ============================================================================

class DistributedWorkerPool {
  private supRef: DistributedSupervisorRef | null = null;
  private nextWorkerIndex = 0;

  constructor(private readonly workerCount: number) {}

  async start(): Promise<void> {
    // Build worker specs
    const children: DistributedChildSpec[] = [];
    for (let i = 1; i <= this.workerCount; i++) {
      children.push({
        id: `worker-${i}`,
        behavior: 'pool-worker',
        restart: 'permanent',
        nodeSelector: 'round_robin',
      });
    }

    // Start the distributed supervisor
    this.supRef = await DistributedSupervisor.start({
      strategy: 'one_for_one',
      nodeSelector: 'round_robin',
      children,
      restartIntensity: {
        maxRestarts: 10,
        withinMs: 60000,
      },
    });

    console.log(`Worker pool started with ${this.workerCount} workers`);

    // Log distribution
    const stats = DistributedSupervisor.getStats(this.supRef);
    console.log('Worker distribution:');
    for (const [nodeId, count] of stats.childrenByNode) {
      console.log(`  ${nodeId}: ${count} workers`);
    }
  }

  async stop(): Promise<void> {
    if (this.supRef) {
      await DistributedSupervisor.stop(this.supRef);
      this.supRef = null;
    }
  }

  async submitTask(task: Task): Promise<TaskResult> {
    if (!this.supRef) {
      throw new Error('Worker pool not started');
    }

    // Round-robin worker selection
    const children = DistributedSupervisor.getChildren(this.supRef);
    if (children.length === 0) {
      throw new Error('No workers available');
    }

    const worker = children[this.nextWorkerIndex % children.length];
    this.nextWorkerIndex++;

    // Send task to worker
    const result = await GenServer.call(worker.ref, {
      type: 'process',
      task,
    });

    return result as TaskResult;
  }

  async getStats(): Promise<{
    workerCount: number;
    totalProcessed: number;
    totalFailed: number;
    distribution: Map<NodeId, number>;
  }> {
    if (!this.supRef) {
      throw new Error('Worker pool not started');
    }

    const children = DistributedSupervisor.getChildren(this.supRef);
    let totalProcessed = 0;
    let totalFailed = 0;

    for (const child of children) {
      const stats = await GenServer.call(child.ref, { type: 'get_stats' }) as WorkerState;
      totalProcessed += stats.processedCount;
      totalFailed += stats.failedCount;
    }

    const supStats = DistributedSupervisor.getStats(this.supRef);

    return {
      workerCount: children.length,
      totalProcessed,
      totalFailed,
      distribution: new Map(supStats.childrenByNode),
    };
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // Register behaviors first
  BehaviorRegistry.register('pool-worker', workerBehavior);

  // Parse args
  const nodeName = process.argv[2] || 'node1';
  const port = parseInt(process.argv[3] || '4369');
  const seeds = process.argv.slice(4);
  const isCoordinator = nodeName === 'coordinator';

  // Start cluster
  await Cluster.start({
    nodeName,
    port,
    seeds,
    heartbeatIntervalMs: 3000,
    heartbeatMissThreshold: 2,
  });

  console.log(`Node started: ${Cluster.getLocalNodeId()}`);

  // Monitor cluster events
  Cluster.onNodeUp((node) => {
    console.log(`[CLUSTER] Node joined: ${node.id}`);
  });

  Cluster.onNodeDown((nodeId, reason) => {
    console.log(`[CLUSTER] Node left: ${nodeId} (${reason})`);
  });

  if (isCoordinator) {
    // Monitor distributed supervisor events
    DistributedSupervisor.onLifecycleEvent((event) => {
      if (event.type === 'child_migrated') {
        console.log(`[POOL] Worker ${event.childId} migrated: ${event.fromNode} → ${event.toNode}`);
      } else if (event.type === 'node_failure_detected') {
        console.log(`[POOL] Node ${event.nodeId} failed, affected workers: ${event.affectedChildren.join(', ')}`);
      }
    });

    // Wait for other nodes to join
    console.log('Waiting for worker nodes to join...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Start worker pool
    const pool = new DistributedWorkerPool(6);
    await pool.start();

    // Submit tasks periodically
    let taskId = 0;
    const interval = setInterval(async () => {
      try {
        const task: Task = {
          id: `task-${++taskId}`,
          payload: `Data ${Date.now()}`,
        };

        const result = await pool.submitTask(task);
        if (result.success) {
          console.log(`[TASK] ${result.taskId}: ${result.result}`);
        } else {
          console.log(`[TASK] ${result.taskId} failed: ${result.error}`);
        }
      } catch (error) {
        console.error('[TASK] Error:', (error as Error).message);
      }
    }, 1000);

    // Print stats every 10 seconds
    setInterval(async () => {
      try {
        const stats = await pool.getStats();
        console.log('\n--- Pool Stats ---');
        console.log(`Workers: ${stats.workerCount}`);
        console.log(`Processed: ${stats.totalProcessed}, Failed: ${stats.totalFailed}`);
        console.log('Distribution:');
        for (const [nodeId, count] of stats.distribution) {
          console.log(`  ${nodeId}: ${count}`);
        }
        console.log('------------------\n');
      } catch (error) {
        console.error('[STATS] Error:', (error as Error).message);
      }
    }, 10000);

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      clearInterval(interval);
      await pool.stop();
      await Cluster.stop();
      process.exit(0);
    });
  } else {
    // Worker node - just keep alive
    console.log('Worker node ready, waiting for tasks...');

    process.on('SIGINT', async () => {
      console.log('\nShutting down worker node...');
      await Cluster.stop();
      process.exit(0);
    });
  }
}

main().catch(console.error);
```

**Running the example:**

```bash
# Terminal 1: Start coordinator
npx tsx distributed-worker-pool.ts coordinator 4369

# Terminal 2: Start worker node 1
npx tsx distributed-worker-pool.ts worker1 4370 coordinator@localhost:4369

# Terminal 3: Start worker node 2
npx tsx distributed-worker-pool.ts worker2 4371 coordinator@localhost:4369

# Try killing a worker node (Ctrl+C in terminal 2 or 3)
# Watch the workers automatically migrate to healthy nodes!
```

**Expected output:**

```
# Coordinator
Node started: coordinator@0.0.0.0:4369
Waiting for worker nodes to join...
[CLUSTER] Node joined: worker1@0.0.0.0:4370
[CLUSTER] Node joined: worker2@0.0.0.0:4371
Worker pool started with 6 workers
Worker distribution:
  coordinator@0.0.0.0:4369: 2 workers
  worker1@0.0.0.0:4370: 2 workers
  worker2@0.0.0.0:4371: 2 workers
[TASK] task-1: Processed: DATA 1706108400000
[TASK] task-2: Processed: DATA 1706108401000
...

# When worker1 goes down:
[CLUSTER] Node left: worker1@0.0.0.0:4370 (heartbeat_timeout)
[POOL] Node worker1@0.0.0.0:4370 failed, affected workers: worker-2, worker-3
[POOL] Worker worker-2 migrated: worker1@0.0.0.0:4370 → coordinator@0.0.0.0:4369
[POOL] Worker worker-3 migrated: worker1@0.0.0.0:4370 → worker2@0.0.0.0:4371

--- Pool Stats ---
Workers: 6
Processed: 45, Failed: 3
Distribution:
  coordinator@0.0.0.0:4369: 3
  worker2@0.0.0.0:4371: 3
------------------
```

## Exercise: Distributed Task Scheduler

Build a distributed task scheduler with the following requirements:

1. A `SchedulerSupervisor` that manages task executors across the cluster
2. Support for one-time and repeating tasks
3. Task persistence (tasks survive executor restarts)
4. Load-balanced task assignment
5. Task execution monitoring with success/failure tracking

**Requirements:**

1. Create a `task-executor` behavior that processes scheduled tasks
2. Create a `task-scheduler` behavior that coordinates task distribution
3. Use `simple_one_for_one` for dynamic executor spawning
4. Track task completion statistics per node
5. Handle executor failures by reassigning pending tasks

**Starter code:**

```typescript
import {
  GenServer,
  type GenServerBehavior,
  type GenServerRef,
} from '@hamicek/noex';
import {
  Cluster,
  BehaviorRegistry,
  DistributedSupervisor,
  GlobalRegistry,
  type NodeId,
} from '@hamicek/noex/distribution';

// ============================================================================
// Types
// ============================================================================

interface ScheduledTask {
  id: string;
  name: string;
  payload: unknown;
  scheduledAt: number;
  interval?: number;  // For repeating tasks (ms)
  assignedTo?: string;  // Executor ID
  status: 'pending' | 'running' | 'completed' | 'failed';
}

// TODO: Define ExecutorState
interface ExecutorState {
  id: string;
  currentTask: ScheduledTask | null;
  completedCount: number;
  failedCount: number;
}

// TODO: Define SchedulerState
interface SchedulerState {
  tasks: Map<string, ScheduledTask>;
  executors: Map<string, GenServerRef>;
  nextTaskId: number;
}

// TODO: Define message types for executor and scheduler

// ============================================================================
// Executor Behavior
// ============================================================================

// TODO: Implement task executor behavior
// - Process assigned tasks
// - Report completion/failure to scheduler
// - Track statistics

// ============================================================================
// Scheduler Behavior
// ============================================================================

// TODO: Implement task scheduler behavior
// - Schedule new tasks (one-time and repeating)
// - Assign tasks to executors (load balanced)
// - Handle executor registration/deregistration
// - Reassign tasks on executor failure

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const mode = process.argv[2];
  const nodeName = process.argv[3] || 'node1';
  const port = parseInt(process.argv[4] || '4369');
  const seeds = process.argv.slice(5);

  // TODO: Register behaviors

  // TODO: Start cluster

  if (mode === 'scheduler') {
    // TODO: Start scheduler supervisor and coordinator
  } else {
    // TODO: Start executor node with simple_one_for_one supervisor
  }
}

main().catch(console.error);
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
import {
  GenServer,
  type GenServerBehavior,
  type GenServerRef,
} from '@hamicek/noex';
import {
  Cluster,
  BehaviorRegistry,
  DistributedSupervisor,
  GlobalRegistry,
  type DistributedSupervisorRef,
  type NodeId,
} from '@hamicek/noex/distribution';

// ============================================================================
// Types
// ============================================================================

interface ScheduledTask {
  id: string;
  name: string;
  payload: unknown;
  scheduledAt: number;
  interval?: number;
  assignedTo?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  lastError?: string;
  completedAt?: number;
}

interface ExecutorState {
  id: string;
  schedulerRef: GenServerRef | null;
  currentTask: ScheduledTask | null;
  completedCount: number;
  failedCount: number;
}

interface SchedulerState {
  tasks: Map<string, ScheduledTask>;
  executorRefs: Map<string, GenServerRef>;
  nextTaskId: number;
  stats: {
    totalScheduled: number;
    totalCompleted: number;
    totalFailed: number;
  };
}

// Executor messages
type ExecutorCall =
  | { type: 'get_stats' }
  | { type: 'execute'; task: ScheduledTask };

type ExecutorCast =
  | { type: 'set_scheduler'; ref: GenServerRef };

// Scheduler messages
type SchedulerCall =
  | { type: 'schedule'; name: string; payload: unknown; interval?: number }
  | { type: 'get_task'; taskId: string }
  | { type: 'get_stats' }
  | { type: 'list_tasks' };

type SchedulerCast =
  | { type: 'executor_ready'; executorId: string; ref: GenServerRef }
  | { type: 'executor_gone'; executorId: string }
  | { type: 'task_completed'; taskId: string; executorId: string }
  | { type: 'task_failed'; taskId: string; executorId: string; error: string };

// ============================================================================
// Executor Behavior
// ============================================================================

const executorBehavior: GenServerBehavior<ExecutorState, ExecutorCall, ExecutorCast, unknown> = {
  init: (args) => {
    const id = args?.id ?? `executor-${Date.now()}`;
    return {
      id,
      schedulerRef: null,
      currentTask: null,
      completedCount: 0,
      failedCount: 0,
    };
  },

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get_stats':
        return [{
          id: state.id,
          busy: state.currentTask !== null,
          completedCount: state.completedCount,
          failedCount: state.failedCount,
        }, state];

      case 'execute': {
        const task = msg.task;
        console.log(`[${state.id}] Executing task: ${task.name}`);

        // Simulate async execution
        setTimeout(() => {
          const success = Math.random() > 0.15;  // 85% success rate

          if (state.schedulerRef) {
            if (success) {
              GenServer.cast(state.schedulerRef, {
                type: 'task_completed',
                taskId: task.id,
                executorId: state.id,
              });
            } else {
              GenServer.cast(state.schedulerRef, {
                type: 'task_failed',
                taskId: task.id,
                executorId: state.id,
                error: 'Simulated execution failure',
              });
            }
          }
        }, 500 + Math.random() * 1500);

        const newState: ExecutorState = {
          ...state,
          currentTask: task,
        };

        return [{ accepted: true }, newState];
      }
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'set_scheduler') {
      // Notify scheduler we're ready
      GenServer.cast(msg.ref, {
        type: 'executor_ready',
        executorId: state.id,
        ref: { id: state.id } as GenServerRef,  // Simplified for demo
      });

      return {
        ...state,
        schedulerRef: msg.ref,
      };
    }
    return state;
  },

  terminate: async (_reason, state) => {
    // Notify scheduler we're going away
    if (state.schedulerRef) {
      GenServer.cast(state.schedulerRef, {
        type: 'executor_gone',
        executorId: state.id,
      });
    }
  },
};

// ============================================================================
// Scheduler Behavior
// ============================================================================

const schedulerBehavior: GenServerBehavior<SchedulerState, SchedulerCall, SchedulerCast, unknown> = {
  init: () => ({
    tasks: new Map(),
    executorRefs: new Map(),
    nextTaskId: 1,
    stats: {
      totalScheduled: 0,
      totalCompleted: 0,
      totalFailed: 0,
    },
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'schedule': {
        const taskId = `task-${state.nextTaskId}`;
        const task: ScheduledTask = {
          id: taskId,
          name: msg.name,
          payload: msg.payload,
          scheduledAt: Date.now(),
          interval: msg.interval,
          status: 'pending',
        };

        const newTasks = new Map(state.tasks);
        newTasks.set(taskId, task);

        const newState: SchedulerState = {
          ...state,
          tasks: newTasks,
          nextTaskId: state.nextTaskId + 1,
          stats: {
            ...state.stats,
            totalScheduled: state.stats.totalScheduled + 1,
          },
        };

        // Try to assign immediately (deferred)
        setTimeout(() => tryAssignTask(taskId), 10);

        return [{ taskId, status: 'scheduled' }, newState];
      }

      case 'get_task': {
        const task = state.tasks.get(msg.taskId);
        return [task ?? null, state];
      }

      case 'get_stats': {
        return [{
          ...state.stats,
          pendingTasks: Array.from(state.tasks.values()).filter(t => t.status === 'pending').length,
          runningTasks: Array.from(state.tasks.values()).filter(t => t.status === 'running').length,
          executorCount: state.executorRefs.size,
        }, state];
      }

      case 'list_tasks': {
        return [Array.from(state.tasks.values()), state];
      }
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'executor_ready': {
        console.log(`[Scheduler] Executor ready: ${msg.executorId}`);
        const newExecutors = new Map(state.executorRefs);
        newExecutors.set(msg.executorId, msg.ref);

        // Try to assign pending tasks
        setTimeout(tryAssignPendingTasks, 10);

        return { ...state, executorRefs: newExecutors };
      }

      case 'executor_gone': {
        console.log(`[Scheduler] Executor gone: ${msg.executorId}`);
        const newExecutors = new Map(state.executorRefs);
        newExecutors.delete(msg.executorId);

        // Reassign tasks from this executor
        const newTasks = new Map(state.tasks);
        for (const [taskId, task] of newTasks) {
          if (task.assignedTo === msg.executorId && task.status === 'running') {
            newTasks.set(taskId, { ...task, status: 'pending', assignedTo: undefined });
            console.log(`[Scheduler] Reassigning task ${taskId}`);
          }
        }

        setTimeout(tryAssignPendingTasks, 10);

        return { ...state, executorRefs: newExecutors, tasks: newTasks };
      }

      case 'task_completed': {
        console.log(`[Scheduler] Task ${msg.taskId} completed by ${msg.executorId}`);
        const task = state.tasks.get(msg.taskId);
        if (!task) return state;

        const newTasks = new Map(state.tasks);

        if (task.interval) {
          // Repeating task - reschedule
          newTasks.set(msg.taskId, {
            ...task,
            status: 'pending',
            assignedTo: undefined,
            completedAt: Date.now(),
          });
          setTimeout(() => tryAssignTask(msg.taskId), task.interval);
        } else {
          // One-time task - mark completed
          newTasks.set(msg.taskId, {
            ...task,
            status: 'completed',
            completedAt: Date.now(),
          });
        }

        return {
          ...state,
          tasks: newTasks,
          stats: {
            ...state.stats,
            totalCompleted: state.stats.totalCompleted + 1,
          },
        };
      }

      case 'task_failed': {
        console.log(`[Scheduler] Task ${msg.taskId} failed: ${msg.error}`);
        const task = state.tasks.get(msg.taskId);
        if (!task) return state;

        const newTasks = new Map(state.tasks);
        newTasks.set(msg.taskId, {
          ...task,
          status: 'pending',  // Retry
          assignedTo: undefined,
          lastError: msg.error,
        });

        // Retry after delay
        setTimeout(() => tryAssignTask(msg.taskId), 2000);

        return {
          ...state,
          tasks: newTasks,
          stats: {
            ...state.stats,
            totalFailed: state.stats.totalFailed + 1,
          },
        };
      }
    }

    return state;
  },
};

// Global scheduler ref for assignment logic
let schedulerRef: GenServerRef | null = null;
let schedulerState: SchedulerState | null = null;

function tryAssignTask(taskId: string): void {
  // This would be implemented properly with state access in a real system
  tryAssignPendingTasks();
}

function tryAssignPendingTasks(): void {
  // Simplified - in real implementation, would use GenServer.call
  console.log('[Scheduler] Checking for pending tasks to assign...');
}

// ============================================================================
// Supervisor Setup
// ============================================================================

let executorSupRef: DistributedSupervisorRef | null = null;

async function startSchedulerNode(port: number, seeds: string[]): Promise<void> {
  await Cluster.start({
    nodeName: 'scheduler',
    port,
    seeds,
    heartbeatIntervalMs: 3000,
    heartbeatMissThreshold: 2,
  });

  console.log(`Scheduler node started: ${Cluster.getLocalNodeId()}`);

  // Start scheduler GenServer
  schedulerRef = await GenServer.start(schedulerBehavior);
  await GlobalRegistry.register('task-scheduler', schedulerRef);

  console.log('Task Scheduler registered globally');

  // Monitor distributed supervisor events
  DistributedSupervisor.onLifecycleEvent((event) => {
    if (event.type === 'child_migrated') {
      console.log(`[SUPERVISOR] Executor migrated: ${event.fromNode} → ${event.toNode}`);
    }
    if (event.type === 'node_failure_detected') {
      console.log(`[SUPERVISOR] Node failure: ${event.nodeId}, affected: ${event.affectedChildren.join(', ')}`);
    }
  });

  // Schedule some test tasks
  setInterval(async () => {
    if (!schedulerRef) return;
    const result = await GenServer.call(schedulerRef, {
      type: 'schedule',
      name: `test-task-${Date.now()}`,
      payload: { data: Math.random() },
    });
    console.log(`[Scheduler] Scheduled: ${(result as { taskId: string }).taskId}`);
  }, 3000);

  // Print stats periodically
  setInterval(async () => {
    if (!schedulerRef) return;
    const stats = await GenServer.call(schedulerRef, { type: 'get_stats' });
    console.log('\n--- Scheduler Stats ---');
    console.log(JSON.stringify(stats, null, 2));
    console.log('-----------------------\n');
  }, 10000);

  process.on('SIGINT', async () => {
    console.log('\nShutting down scheduler...');
    await GlobalRegistry.unregister('task-scheduler');
    await Cluster.stop();
    process.exit(0);
  });
}

async function startExecutorNode(nodeName: string, port: number, seeds: string[]): Promise<void> {
  await Cluster.start({
    nodeName,
    port,
    seeds,
    heartbeatIntervalMs: 3000,
    heartbeatMissThreshold: 2,
  });

  console.log(`Executor node started: ${Cluster.getLocalNodeId()}`);

  // Wait for cluster to sync
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Start executor supervisor with simple_one_for_one
  executorSupRef = await DistributedSupervisor.start({
    strategy: 'simple_one_for_one',
    childTemplate: {
      behavior: 'task-executor',
      restart: 'transient',
      nodeSelector: 'local_first',
    },
  });

  // Start some executors
  const executorCount = 3;
  for (let i = 1; i <= executorCount; i++) {
    await DistributedSupervisor.startChild(executorSupRef, [{ id: `${nodeName}-executor-${i}` }]);
  }

  console.log(`Started ${executorCount} executors`);

  // Connect executors to scheduler
  const schedulerRefLookup = GlobalRegistry.whereis('task-scheduler');
  if (schedulerRefLookup) {
    const children = DistributedSupervisor.getChildren(executorSupRef);
    for (const child of children) {
      GenServer.cast(child.ref, { type: 'set_scheduler', ref: schedulerRefLookup });
    }
    console.log('Executors connected to scheduler');
  }

  process.on('SIGINT', async () => {
    console.log('\nShutting down executor node...');
    if (executorSupRef) {
      await DistributedSupervisor.stop(executorSupRef);
    }
    await Cluster.stop();
    process.exit(0);
  });
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // Register behaviors
  BehaviorRegistry.register('task-executor', executorBehavior);
  BehaviorRegistry.register('task-scheduler', schedulerBehavior);

  const mode = process.argv[2];
  const port = parseInt(process.argv[3] || '4369');
  const seeds = process.argv.slice(4);

  if (mode === 'scheduler') {
    await startSchedulerNode(port, seeds);
  } else if (mode === 'executor') {
    const nodeName = process.argv[3] || 'executor1';
    const nodePort = parseInt(process.argv[4] || '4370');
    const nodeSeeds = process.argv.slice(5);
    await startExecutorNode(nodeName, nodePort, nodeSeeds);
  } else {
    console.log('Usage:');
    console.log('  npx tsx task-scheduler.ts scheduler [port] [seeds...]');
    console.log('  npx tsx task-scheduler.ts executor <name> [port] [seeds...]');
    console.log('');
    console.log('Example:');
    console.log('  npx tsx task-scheduler.ts scheduler 4369');
    console.log('  npx tsx task-scheduler.ts executor executor1 4370 scheduler@localhost:4369');
    console.log('  npx tsx task-scheduler.ts executor executor2 4371 scheduler@localhost:4369');
  }
}

main().catch(console.error);
```

**Running the solution:**

```bash
# Terminal 1: Start scheduler
npx tsx task-scheduler.ts scheduler 4369

# Terminal 2: Start executor node 1
npx tsx task-scheduler.ts executor executor1 4370 scheduler@localhost:4369

# Terminal 3: Start executor node 2
npx tsx task-scheduler.ts executor executor2 4371 scheduler@localhost:4369
```

</details>

## Summary

**Key takeaways:**

- **DistributedSupervisor** extends supervision across cluster nodes with automatic failover
- **BehaviorRegistry** must register behaviors on ALL nodes before starting
- **Node selection** controls child placement with built-in strategies or custom functions
- **All four restart strategies** work across the cluster
- **Automatic failover** migrates children to healthy nodes when their host goes down
- **Lifecycle events** enable monitoring of migrations and failures
- **Restart intensity** prevents infinite restart loops

**API at a glance:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   DISTRIBUTED SUPERVISOR API OVERVIEW                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BEHAVIOR REGISTRY (pre-registration)                                       │
│  ─────────────────────────────────────────────────────────────────────────  │
│  BehaviorRegistry.register(name, behavior)  → Register for remote spawn     │
│  BehaviorRegistry.has(name)                 → Check if registered           │
│  BehaviorRegistry.get(name)                 → Get registered behavior       │
│  BehaviorRegistry.getNames()                → List all registered names     │
│                                                                             │
│  SUPERVISOR LIFECYCLE                                                       │
│  ─────────────────────────────────────────────────────────────────────────  │
│  DistributedSupervisor.start(options)       → Start supervisor              │
│  DistributedSupervisor.stop(ref, reason?)   → Graceful shutdown             │
│  DistributedSupervisor.isRunning(ref)       → Check if running              │
│                                                                             │
│  CHILD MANAGEMENT                                                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│  DistributedSupervisor.startChild(ref, spec) → Add child dynamically        │
│  DistributedSupervisor.terminateChild(ref, id) → Remove child               │
│  DistributedSupervisor.restartChild(ref, id) → Manual restart               │
│                                                                             │
│  QUERIES                                                                    │
│  ─────────────────────────────────────────────────────────────────────────  │
│  DistributedSupervisor.getChildren(ref)     → List all children             │
│  DistributedSupervisor.getChild(ref, id)    → Get specific child            │
│  DistributedSupervisor.countChildren(ref)   → Count children                │
│  DistributedSupervisor.getStats(ref)        → Supervisor statistics         │
│                                                                             │
│  EVENTS                                                                     │
│  ─────────────────────────────────────────────────────────────────────────  │
│  DistributedSupervisor.onLifecycleEvent(handler) → Subscribe to events      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Node selection strategies:**

| Strategy | Best for |
|----------|----------|
| `'local_first'` | Minimize latency, prefer co-location |
| `'round_robin'` | Even distribution across nodes |
| `'least_loaded'` | CPU-intensive workloads |
| `'random'` | Simple load distribution |
| `{ node: NodeId }` | Pinning to specific hardware |
| Custom function | Complex placement logic |

**Remember:**

> DistributedSupervisor combines the fault-tolerance of supervision with the scalability of distribution. Register behaviors everywhere, let the supervisor handle placement and failover, and your system gains resilience that spans the entire cluster.

---

Next: [Chat Server Project](../12-projects/01-chat-server.md)
