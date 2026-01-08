# RemoteSpawn API Reference

The `RemoteSpawn` object enables spawning GenServer instances on remote cluster nodes. Since JavaScript functions cannot be serialized, behaviors must be pre-registered using `BehaviorRegistry` on all nodes.

## Import

```typescript
import { RemoteSpawn, BehaviorRegistry } from 'noex/distribution';
```

---

## BehaviorRegistry

Registry for GenServer behaviors available for remote spawning.

### Methods

#### register()

Registers a behavior under a given name.

```typescript
register<State, CallMsg, CastMsg, CallReply>(
  name: string,
  behavior: GenServerBehavior<State, CallMsg, CastMsg, CallReply>,
): void
```

**Parameters:**
- `name` - Unique name for the behavior
- `behavior` - The GenServer behavior implementation

**Throws:**
- `Error` - If a behavior with this name is already registered
- `Error` - If behavior is invalid (missing required functions)

**Example:**
```typescript
const counterBehavior = {
  init: () => 0,
  handleCall: (msg: 'get' | 'inc', state: number) => {
    if (msg === 'get') return [state, state];
    return [state + 1, state + 1];
  },
  handleCast: (_msg: never, state: number) => state,
};

BehaviorRegistry.register('counter', counterBehavior);
```

---

#### get()

Retrieves a behavior by name.

```typescript
get<State, CallMsg, CastMsg, CallReply>(
  name: string,
): GenServerBehavior<State, CallMsg, CastMsg, CallReply> | undefined
```

**Parameters:**
- `name` - Name of the behavior to retrieve

**Returns:** The behavior if found, undefined otherwise

**Example:**
```typescript
const behavior = BehaviorRegistry.get('counter');
if (behavior) {
  const ref = await GenServer.start(behavior);
}
```

---

#### has()

Checks if a behavior is registered.

```typescript
has(name: string): boolean
```

**Returns:** `true` if a behavior is registered with this name

---

#### unregister()

Removes a behavior from the registry.

```typescript
unregister(name: string): boolean
```

**Returns:** `true` if the behavior was found and removed

**Warning:** Removing a behavior while remote spawns are pending can cause spawn failures.

---

#### getNames()

Returns the names of all registered behaviors.

```typescript
getNames(): readonly string[]
```

---

#### getStats()

Returns statistics about the registry.

```typescript
getStats(): BehaviorRegistryStats
```

```typescript
interface BehaviorRegistryStats {
  readonly count: number;
  readonly names: readonly string[];
}
```

---

## RemoteSpawn

### Types

#### SpawnResult

Result of a successful remote spawn.

```typescript
interface SpawnResult {
  readonly serverId: string;
  readonly nodeId: NodeId;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `serverId` | `string` | ID of the spawned GenServer |
| `nodeId` | `NodeId` | Node where the GenServer is running |

#### RemoteSpawnOptions

Options for remote spawn operations.

```typescript
interface RemoteSpawnOptions {
  readonly name?: string;
  readonly initTimeout?: number;
  readonly registration?: 'local' | 'global' | 'none';
  readonly timeout?: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | - | Optional name for registry registration |
| `initTimeout` | `number` | - | Timeout for init() call |
| `registration` | `string` | `'none'` | Registration strategy on target node |
| `timeout` | `number` | `10000` | Timeout for entire spawn operation |

#### RemoteSpawnStats

Statistics about remote spawn operations.

```typescript
interface RemoteSpawnStats {
  readonly initialized: boolean;
  readonly pendingCount: number;
  readonly totalInitiated: number;
  readonly totalResolved: number;
  readonly totalRejected: number;
  readonly totalTimedOut: number;
}
```

---

### Methods

#### spawn()

Spawns a GenServer on a remote node.

```typescript
async spawn(
  behaviorName: string,
  targetNodeId: NodeId,
  options?: RemoteSpawnOptions,
): Promise<SpawnResult>
```

**Parameters:**
- `behaviorName` - Name of the registered behavior
- `targetNodeId` - Target node to spawn on
- `options` - Spawn options

**Returns:** Promise resolving to spawn result with serverId and nodeId

**Throws:**
- `ClusterNotStartedError` - If cluster is not running
- `NodeNotReachableError` - If target node is not connected
- `BehaviorNotFoundError` - If behavior is not registered on target
- `RemoteSpawnTimeoutError` - If spawn times out
- `RemoteSpawnInitError` - If initialization fails
- `RemoteSpawnRegistrationError` - If registration fails

**Example:**
```typescript
const result = await RemoteSpawn.spawn('counter', targetNodeId, {
  name: 'my-counter',
  registration: 'global',
  timeout: 5000,
});

console.log(`Spawned ${result.serverId} on ${result.nodeId}`);
```

---

#### getStats()

Returns statistics about remote spawn operations.

```typescript
getStats(): RemoteSpawnStats
```

---

## Error Classes

### BehaviorNotFoundError

```typescript
class BehaviorNotFoundError extends Error {
  readonly name = 'BehaviorNotFoundError';
  readonly behaviorName: string;
}
```

Thrown when a behavior is not registered in BehaviorRegistry.

### RemoteSpawnTimeoutError

```typescript
class RemoteSpawnTimeoutError extends Error {
  readonly name = 'RemoteSpawnTimeoutError';
  readonly behaviorName: string;
  readonly nodeId: NodeId;
  readonly timeoutMs: number;
}
```

Thrown when a remote spawn request times out.

### RemoteSpawnInitError

```typescript
class RemoteSpawnInitError extends Error {
  readonly name = 'RemoteSpawnInitError';
  readonly behaviorName: string;
  readonly nodeId: NodeId;
  readonly reason: string;
}
```

Thrown when initialization fails on the remote node.

### RemoteSpawnRegistrationError

```typescript
class RemoteSpawnRegistrationError extends Error {
  readonly name = 'RemoteSpawnRegistrationError';
  readonly behaviorName: string;
  readonly nodeId: NodeId;
  readonly registeredName: string;
}
```

Thrown when registration fails due to name conflict.

---

## Complete Example

```typescript
import { Cluster, RemoteSpawn, BehaviorRegistry, NodeId } from 'noex/distribution';
import type { GenServerBehavior } from 'noex';

// Define behavior type
interface WorkerState {
  taskCount: number;
}

type WorkerCall = { type: 'status' };
type WorkerCast = { type: 'process'; data: unknown };
type WorkerReply = { taskCount: number };

const workerBehavior: GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerReply> = {
  init: () => ({ taskCount: 0 }),

  handleCall: (msg, state) => {
    if (msg.type === 'status') {
      return [{ taskCount: state.taskCount }, state];
    }
    return [{ taskCount: state.taskCount }, state];
  },

  handleCast: (msg, state) => {
    if (msg.type === 'process') {
      console.log(`Processing: ${JSON.stringify(msg.data)}`);
      return { taskCount: state.taskCount + 1 };
    }
    return state;
  },
};

async function main() {
  // STEP 1: Register behavior on ALL nodes (this code runs on each node)
  BehaviorRegistry.register('worker', workerBehavior);

  // STEP 2: Start cluster
  await Cluster.start({
    nodeName: 'coordinator',
    port: 4369,
    seeds: ['worker1@192.168.1.10:4369', 'worker2@192.168.1.11:4369'],
  });

  // Wait for nodes to connect
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // STEP 3: Spawn workers on remote nodes
  const workers: SpawnResult[] = [];

  for (const node of Cluster.getConnectedNodes()) {
    try {
      const result = await RemoteSpawn.spawn('worker', node.id, {
        registration: 'global',
        timeout: 5000,
      });
      workers.push(result);
      console.log(`Spawned worker on ${node.id}`);
    } catch (error) {
      if (error instanceof BehaviorNotFoundError) {
        console.error(`Behavior not registered on ${node.id}`);
      } else if (error instanceof RemoteSpawnTimeoutError) {
        console.error(`Spawn timeout on ${error.nodeId}`);
      } else {
        throw error;
      }
    }
  }

  console.log(`\nSpawned ${workers.length} workers across the cluster`);

  // STEP 4: Use the spawned workers
  for (const worker of workers) {
    const ref = { id: worker.serverId, nodeId: worker.nodeId };
    RemoteCall.cast(ref, { type: 'process', data: { task: 'example' } });
  }

  // Print statistics
  const stats = RemoteSpawn.getStats();
  console.log(`\nRemoteSpawn stats:`);
  console.log(`  Total spawns: ${stats.totalInitiated}`);
  console.log(`  Successful: ${stats.totalResolved}`);
  console.log(`  Failed: ${stats.totalRejected}`);

  await Cluster.stop();
}

main().catch(console.error);
```

---

## Best Practices

### Always Register on All Nodes

Behaviors must be registered on every node where they might be spawned:

```typescript
// This code should run on every node at startup
BehaviorRegistry.register('counter', counterBehavior);
BehaviorRegistry.register('cache', cacheBehavior);
BehaviorRegistry.register('worker', workerBehavior);
```

### Use Consistent Behavior Names

Ensure behavior names are consistent across all nodes:

```typescript
// behaviors.ts - shared module
export const BEHAVIORS = {
  COUNTER: 'counter',
  CACHE: 'cache',
  WORKER: 'worker',
} as const;

// node.ts
BehaviorRegistry.register(BEHAVIORS.COUNTER, counterBehavior);
```

### Handle Spawn Failures

Always handle potential spawn failures:

```typescript
async function spawnWithRetry(
  behaviorName: string,
  nodeId: NodeId,
  maxRetries = 3,
): Promise<SpawnResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await RemoteSpawn.spawn(behaviorName, nodeId);
    } catch (error) {
      if (attempt === maxRetries) throw error;

      if (error instanceof RemoteSpawnTimeoutError) {
        console.log(`Spawn timeout, retrying (${attempt}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      } else {
        throw error; // Don't retry non-timeout errors
      }
    }
  }
  throw new Error('Unreachable');
}
```

### Clean Up on Shutdown

Unregister behaviors if needed (though typically behaviors persist for the node's lifetime):

```typescript
process.on('SIGINT', async () => {
  // Behaviors are typically not unregistered, but if needed:
  // BehaviorRegistry.unregister('worker');
  await Cluster.stop();
  process.exit(0);
});
```

---

## Related

- [Remote Processes Guide](../guides/remote-processes.md) - Using RemoteSpawn
- [RemoteCall API](./remote-call.md) - Calling remote processes
- [DistributedSupervisor API](./distributed-supervisor.md) - Managing remote children
- [Types Reference](./types.md) - All distribution types
