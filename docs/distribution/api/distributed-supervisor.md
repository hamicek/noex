# DistributedSupervisor API Reference

The `DistributedSupervisor` object manages child processes across cluster nodes with automatic failover when nodes go down. It combines the supervision patterns of Erlang/OTP with distributed spawning capabilities.

## Import

```typescript
import { DistributedSupervisor, BehaviorRegistry } from 'noex/distribution';
```

## Overview

DistributedSupervisor provides:
- Remote child spawning via BehaviorRegistry
- Automatic failover when nodes go down
- Multiple restart strategies (`one_for_one`, `one_for_all`, `rest_for_one`, `simple_one_for_one`)
- Cluster-wide child coordination via GlobalRegistry
- Process monitoring via RemoteMonitor

---

## Types

### DistributedSupervisorRef

Opaque reference to a running distributed supervisor.

```typescript
interface DistributedSupervisorRef {
  readonly id: string;
  readonly nodeId: NodeId;
}
```

### DistributedSupervisorOptions

Configuration options for starting a distributed supervisor.

```typescript
interface DistributedSupervisorOptions {
  readonly strategy?: SupervisorStrategy;
  readonly nodeSelector?: NodeSelector;
  readonly children?: readonly DistributedChildSpec[];
  readonly childTemplate?: DistributedChildTemplate;
  readonly restartIntensity?: RestartIntensity;
  readonly autoShutdown?: DistributedAutoShutdown;
  readonly name?: string;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strategy` | `SupervisorStrategy` | `'one_for_one'` | Restart strategy |
| `nodeSelector` | `NodeSelector` | `'local_first'` | Default node selection strategy |
| `children` | `DistributedChildSpec[]` | `[]` | Initial child specifications |
| `childTemplate` | `DistributedChildTemplate` | - | Template for dynamic children (required for `simple_one_for_one`) |
| `restartIntensity` | `RestartIntensity` | `{maxRestarts: 3, withinMs: 5000}` | Restart limiting |
| `autoShutdown` | `DistributedAutoShutdown` | `'never'` | Auto-shutdown behavior |
| `name` | `string` | - | Optional name for global registry |

### DistributedChildSpec

Specification for a child process.

```typescript
interface DistributedChildSpec {
  readonly id: string;
  readonly behavior: string;
  readonly args?: readonly unknown[];
  readonly restart?: ChildRestartStrategy;
  readonly nodeSelector?: NodeSelector;
  readonly shutdownTimeout?: number;
  readonly significant?: boolean;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` | required | Unique identifier for this child |
| `behavior` | `string` | required | Name of the behavior in BehaviorRegistry |
| `args` | `unknown[]` | `[]` | Arguments passed to behavior's init function |
| `restart` | `ChildRestartStrategy` | `'permanent'` | When to restart this child |
| `nodeSelector` | `NodeSelector` | - | Node selection strategy (uses supervisor default if not set) |
| `shutdownTimeout` | `number` | `5000` | Milliseconds to wait for graceful shutdown |
| `significant` | `boolean` | `false` | Marks child as significant for `autoShutdown` |

### DistributedChildTemplate

Template for dynamic child creation in `simple_one_for_one` supervisors.

```typescript
interface DistributedChildTemplate {
  readonly behavior: string;
  readonly restart?: ChildRestartStrategy;
  readonly nodeSelector?: NodeSelector;
  readonly shutdownTimeout?: number;
  readonly significant?: boolean;
}
```

### NodeSelector

Node selection strategy for child placement.

```typescript
type NodeSelector =
  | NodeSelectorType
  | { readonly node: NodeId }
  | NodeSelectorFn;

type NodeSelectorType = 'local_first' | 'round_robin' | 'least_loaded' | 'random';

type NodeSelectorFn = (nodes: readonly NodeInfo[], childId: string) => NodeId;
```

| Strategy | Behavior |
|----------|----------|
| `'local_first'` | Prefer the local node, fallback to connected nodes (default) |
| `'round_robin'` | Rotate through available nodes in sequence |
| `'least_loaded'` | Select the node with the lowest process count |
| `'random'` | Random selection from available nodes |
| `{ node: NodeId }` | Spawn on a specific node |
| `NodeSelectorFn` | Custom selection function |

### DistributedAutoShutdown

Auto-shutdown behavior when children terminate.

```typescript
type DistributedAutoShutdown = 'never' | 'any_significant' | 'all_significant';
```

| Value | Behavior |
|-------|----------|
| `'never'` | Supervisor continues running even after all children terminate (default) |
| `'any_significant'` | Supervisor shuts down when any significant child terminates |
| `'all_significant'` | Supervisor shuts down when all significant children have terminated |

### DistributedChildInfo

Information about a running child.

```typescript
interface DistributedChildInfo {
  readonly id: string;
  readonly ref: GenServerRef;
  readonly spec: DistributedChildSpec;
  readonly nodeId: NodeId;
  readonly restartCount: number;
  readonly startedAt: number;
}
```

### DistributedSupervisorStats

Runtime statistics for a supervisor.

```typescript
interface DistributedSupervisorStats {
  readonly id: string;
  readonly strategy: SupervisorStrategy;
  readonly childCount: number;
  readonly childrenByNode: ReadonlyMap<NodeId, number>;
  readonly totalRestarts: number;
  readonly nodeFailureRestarts: number;
  readonly startedAt: number;
  readonly uptimeMs: number;
}
```

### DistributedSupervisorEvent

Lifecycle events for distributed supervision.

```typescript
type DistributedSupervisorEvent =
  | { type: 'supervisor_started'; ref: DistributedSupervisorRef }
  | { type: 'supervisor_stopped'; ref: DistributedSupervisorRef; reason: string }
  | { type: 'child_started'; supervisorId: string; childId: string; nodeId: NodeId }
  | { type: 'child_stopped'; supervisorId: string; childId: string; reason: string }
  | { type: 'child_restarted'; supervisorId: string; childId: string; nodeId: NodeId; attempt: number }
  | { type: 'child_migrated'; supervisorId: string; childId: string; fromNode: NodeId; toNode: NodeId }
  | { type: 'node_failure_detected'; supervisorId: string; nodeId: NodeId; affectedChildren: string[] };
```

---

## Methods

### start()

Starts a new DistributedSupervisor with the given options.

```typescript
async start(options?: DistributedSupervisorOptions): Promise<DistributedSupervisorRef>
```

**Parameters:**
- `options` - Supervisor configuration

**Returns:** Promise resolving to a DistributedSupervisorRef

**Throws:**
- `DistributedMissingChildTemplateError` - If `simple_one_for_one` without `childTemplate`
- `DistributedInvalidSimpleOneForOneError` - If `simple_one_for_one` with static children
- `DistributedBehaviorNotFoundError` - If a child behavior is not registered

**Example:**
```typescript
const supRef = await DistributedSupervisor.start({
  strategy: 'one_for_one',
  nodeSelector: 'round_robin',
  children: [
    { id: 'worker1', behavior: 'worker', restart: 'permanent' },
    { id: 'worker2', behavior: 'worker', restart: 'permanent' },
  ],
  restartIntensity: { maxRestarts: 5, withinMs: 60000 },
});
```

---

### stop()

Gracefully stops the supervisor and all its children.

```typescript
async stop(ref: DistributedSupervisorRef, reason?: 'normal' | 'shutdown'): Promise<void>
```

**Parameters:**
- `ref` - Reference to the supervisor to stop
- `reason` - Reason for stopping (default: `'normal'`)

Children are stopped in reverse order (last started = first stopped).

**Example:**
```typescript
await DistributedSupervisor.stop(supRef);
await DistributedSupervisor.stop(supRef, 'shutdown');
```

---

### startChild()

Dynamically starts a new child under the supervisor.

**For regular supervisors:**

```typescript
async startChild(
  ref: DistributedSupervisorRef,
  spec: DistributedChildSpec,
): Promise<GenServerRef>
```

**For `simple_one_for_one` supervisors:**

```typescript
async startChild(
  ref: DistributedSupervisorRef,
  args: readonly unknown[],
): Promise<GenServerRef>
```

**Parameters:**
- `ref` - Reference to the supervisor
- `spec` or `args` - Child specification or arguments array

**Returns:** Promise resolving to the child's GenServerRef

**Throws:**
- `DistributedDuplicateChildError` - If child with same ID already exists
- `DistributedSupervisorError` - If supervisor not found
- `DistributedInvalidSimpleOneForOneError` - If wrong argument type for strategy

**Example (regular):**
```typescript
const childRef = await DistributedSupervisor.startChild(supRef, {
  id: 'worker-3',
  behavior: 'worker',
  restart: 'permanent',
  nodeSelector: 'least_loaded',
});
```

**Example (simple_one_for_one):**
```typescript
const supRef = await DistributedSupervisor.start({
  strategy: 'simple_one_for_one',
  childTemplate: { behavior: 'worker', restart: 'transient' },
});

const child1 = await DistributedSupervisor.startChild(supRef, [{ taskId: 1 }]);
const child2 = await DistributedSupervisor.startChild(supRef, [{ taskId: 2 }]);
```

---

### terminateChild()

Terminates a specific child.

```typescript
async terminateChild(ref: DistributedSupervisorRef, childId: string): Promise<void>
```

**Parameters:**
- `ref` - Reference to the supervisor
- `childId` - ID of the child to terminate

**Throws:**
- `DistributedChildNotFoundError` - If child not found
- `DistributedSupervisorError` - If supervisor not found

**Example:**
```typescript
await DistributedSupervisor.terminateChild(supRef, 'worker-1');
```

---

### restartChild()

Manually restarts a specific child.

```typescript
async restartChild(ref: DistributedSupervisorRef, childId: string): Promise<GenServerRef>
```

**Parameters:**
- `ref` - Reference to the supervisor
- `childId` - ID of the child to restart

**Returns:** Promise resolving to the new child GenServerRef

**Throws:**
- `DistributedChildNotFoundError` - If child not found
- `DistributedSupervisorError` - If supervisor not found

The child may be restarted on a different node depending on the node selector.

**Example:**
```typescript
const newRef = await DistributedSupervisor.restartChild(supRef, 'cache');
```

---

### getChildren()

Returns information about all children.

```typescript
getChildren(ref: DistributedSupervisorRef): readonly DistributedChildInfo[]
```

**Example:**
```typescript
const children = DistributedSupervisor.getChildren(supRef);
for (const child of children) {
  console.log(`${child.id} on ${child.nodeId}: ${child.restartCount} restarts`);
}
```

---

### getChild()

Returns information about a specific child.

```typescript
getChild(ref: DistributedSupervisorRef, childId: string): DistributedChildInfo | undefined
```

**Example:**
```typescript
const child = DistributedSupervisor.getChild(supRef, 'worker-1');
if (child) {
  console.log(`Worker on ${child.nodeId}, started at ${child.startedAt}`);
}
```

---

### countChildren()

Returns the number of children.

```typescript
countChildren(ref: DistributedSupervisorRef): number
```

---

### isRunning()

Checks if a supervisor is currently running.

```typescript
isRunning(ref: DistributedSupervisorRef): boolean
```

---

### getStats()

Returns statistics for the supervisor.

```typescript
getStats(ref: DistributedSupervisorRef): DistributedSupervisorStats
```

**Example:**
```typescript
const stats = DistributedSupervisor.getStats(supRef);
console.log(`Children: ${stats.childCount}`);
console.log(`Restarts: ${stats.totalRestarts}`);
console.log(`Node failures: ${stats.nodeFailureRestarts}`);
console.log(`Uptime: ${stats.uptimeMs}ms`);

for (const [nodeId, count] of stats.childrenByNode) {
  console.log(`  ${nodeId}: ${count} children`);
}
```

---

### onLifecycleEvent()

Registers a handler for lifecycle events.

```typescript
onLifecycleEvent(handler: DistributedSupervisorEventHandler): () => void
```

**Parameters:**
- `handler` - Function called for each lifecycle event

**Returns:** Unsubscribe function

**Example:**
```typescript
const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'supervisor_started':
      console.log(`Supervisor started: ${event.ref.id}`);
      break;
    case 'child_started':
      console.log(`Child ${event.childId} started on ${event.nodeId}`);
      break;
    case 'child_migrated':
      console.log(`Child ${event.childId} migrated: ${event.fromNode} -> ${event.toNode}`);
      break;
    case 'node_failure_detected':
      console.log(`Node ${event.nodeId} failed, affected: ${event.affectedChildren.join(', ')}`);
      break;
  }
});

// Later
unsubscribe();
```

---

## Error Classes

### DistributedDuplicateChildError

```typescript
class DistributedDuplicateChildError extends Error {
  readonly name = 'DistributedDuplicateChildError';
  readonly supervisorId: string;
  readonly childId: string;
}
```

### DistributedChildNotFoundError

```typescript
class DistributedChildNotFoundError extends Error {
  readonly name = 'DistributedChildNotFoundError';
  readonly supervisorId: string;
  readonly childId: string;
}
```

### DistributedMaxRestartsExceededError

```typescript
class DistributedMaxRestartsExceededError extends Error {
  readonly name = 'DistributedMaxRestartsExceededError';
  readonly supervisorId: string;
  readonly maxRestarts: number;
  readonly withinMs: number;
}
```

### DistributedMissingChildTemplateError

```typescript
class DistributedMissingChildTemplateError extends Error {
  readonly name = 'DistributedMissingChildTemplateError';
  readonly supervisorId: string;
}
```

### DistributedInvalidSimpleOneForOneError

```typescript
class DistributedInvalidSimpleOneForOneError extends Error {
  readonly name = 'DistributedInvalidSimpleOneForOneError';
  readonly supervisorId: string;
  readonly reason: string;
}
```

### DistributedBehaviorNotFoundError

```typescript
class DistributedBehaviorNotFoundError extends Error {
  readonly name = 'DistributedBehaviorNotFoundError';
  readonly behaviorName: string;
  readonly nodeId: NodeId;
}
```

### NoAvailableNodeError

```typescript
class NoAvailableNodeError extends Error {
  readonly name = 'NoAvailableNodeError';
  readonly childId: string;
  readonly selector?: NodeSelector;
}
```

### DistributedSupervisorError

```typescript
class DistributedSupervisorError extends Error {
  readonly name = 'DistributedSupervisorError';
  readonly supervisorId: string;
  readonly cause?: Error;
}
```

---

## Constants

### DISTRIBUTED_SUPERVISOR_DEFAULTS

```typescript
const DISTRIBUTED_SUPERVISOR_DEFAULTS = {
  NODE_SELECTOR: 'local_first',
  STRATEGY: 'one_for_one',
  MAX_RESTARTS: 3,
  RESTART_WITHIN_MS: 5000,
  SHUTDOWN_TIMEOUT: 5000,
  AUTO_SHUTDOWN: 'never',
  SPAWN_TIMEOUT: 10000,
  CHILD_CHECK_INTERVAL: 50,
} as const;
```

---

## Complete Example

```typescript
import { Cluster, DistributedSupervisor, BehaviorRegistry } from 'noex/distribution';
import type { GenServerBehavior } from 'noex';

// Worker behavior
interface WorkerState {
  taskCount: number;
}

const workerBehavior: GenServerBehavior<WorkerState, 'status', 'work', number> = {
  init: () => ({ taskCount: 0 }),
  handleCall: (msg, state) => [state.taskCount, state],
  handleCast: (msg, state) => ({ taskCount: state.taskCount + 1 }),
  terminate: (reason, state) => {
    console.log(`Worker terminated after ${state.taskCount} tasks`);
  },
};

async function main() {
  // 1. Register behaviors on ALL nodes
  BehaviorRegistry.register('worker', workerBehavior);

  // 2. Start cluster
  await Cluster.start({
    nodeName: 'supervisor-node',
    port: 4369,
    seeds: ['worker1@192.168.1.10:4369', 'worker2@192.168.1.11:4369'],
  });

  // Wait for nodes
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // 3. Subscribe to lifecycle events
  DistributedSupervisor.onLifecycleEvent((event) => {
    console.log(`[Event] ${event.type}:`, JSON.stringify(event));
  });

  // 4. Start supervisor with distributed children
  const supRef = await DistributedSupervisor.start({
    strategy: 'one_for_one',
    nodeSelector: 'round_robin',
    children: [
      { id: 'worker-1', behavior: 'worker', restart: 'permanent' },
      { id: 'worker-2', behavior: 'worker', restart: 'permanent' },
      { id: 'worker-3', behavior: 'worker', restart: 'permanent' },
    ],
    restartIntensity: { maxRestarts: 10, withinMs: 60000 },
  });

  console.log(`\nStarted supervisor ${supRef.id}`);

  // 5. Check child distribution
  const stats = DistributedSupervisor.getStats(supRef);
  console.log(`\nChild distribution:`);
  for (const [nodeId, count] of stats.childrenByNode) {
    console.log(`  ${nodeId}: ${count} children`);
  }

  // 6. Add more workers dynamically
  await DistributedSupervisor.startChild(supRef, {
    id: 'worker-4',
    behavior: 'worker',
    nodeSelector: 'least_loaded',
  });

  // 7. Simulate node failure (children will be automatically migrated)
  console.log('\nWaiting for node events (try killing a worker node)...');

  // 8. Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');

    const finalStats = DistributedSupervisor.getStats(supRef);
    console.log(`Total restarts: ${finalStats.totalRestarts}`);
    console.log(`Node failure restarts: ${finalStats.nodeFailureRestarts}`);

    await DistributedSupervisor.stop(supRef);
    await Cluster.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Best Practices

### Register Behaviors First

Always register behaviors before starting the cluster or supervisor:

```typescript
// behaviors.ts
export function registerBehaviors(): void {
  BehaviorRegistry.register('worker', workerBehavior);
  BehaviorRegistry.register('cache', cacheBehavior);
  BehaviorRegistry.register('aggregator', aggregatorBehavior);
}

// main.ts
registerBehaviors();
await Cluster.start(config);
const supRef = await DistributedSupervisor.start(options);
```

### Choose the Right Node Selector

| Use Case | Selector | Reason |
|----------|----------|--------|
| Stateless workers | `'round_robin'` | Even distribution |
| Latency-sensitive | `'local_first'` | Minimize network hops |
| Load balancing | `'least_loaded'` | Balance by process count |
| Affinity required | `{ node: nodeId }` | Specific placement |
| Custom logic | `NodeSelectorFn` | Full control |

```typescript
// Custom selector for geographic affinity
const geoSelector: NodeSelectorFn = (nodes, childId) => {
  const region = childId.split('-')[0]; // e.g., "us-worker-1" -> "us"
  const regionalNode = nodes.find((n) => n.id.startsWith(region));
  return regionalNode?.id ?? nodes[0]!.id;
};

await DistributedSupervisor.start({
  nodeSelector: geoSelector,
  children: [
    { id: 'us-worker-1', behavior: 'worker' },
    { id: 'eu-worker-1', behavior: 'worker' },
  ],
});
```

### Monitor Lifecycle Events

```typescript
DistributedSupervisor.onLifecycleEvent((event) => {
  // Log to your monitoring system
  metrics.emit('distributed_supervisor_event', {
    type: event.type,
    timestamp: Date.now(),
    ...event,
  });

  // Alert on critical events
  if (event.type === 'node_failure_detected') {
    alerting.sendAlert(`Node ${event.nodeId} failed, migrating ${event.affectedChildren.length} children`);
  }
});
```

### Use Appropriate Restart Strategies

| Use Case | Strategy | Reason |
|----------|----------|--------|
| Independent services | `one_for_one` | Failures are isolated |
| Tightly coupled | `one_for_all` | All must restart together |
| Pipeline processing | `rest_for_one` | Downstream depends on upstream |
| Worker pools | `simple_one_for_one` | Homogeneous, dynamic children |

---

## Related

- [Distributed Supervisor Concepts](../concepts/distributed-supervisor.md) - Understanding distributed supervision
- [RemoteSpawn API](./remote-spawn.md) - Remote process spawning
- [RemoteMonitor API](./remote-monitor.md) - Process monitoring
- [Types Reference](./types.md) - All distribution types
