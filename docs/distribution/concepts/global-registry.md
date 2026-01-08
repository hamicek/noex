# Global Registry

The GlobalRegistry provides cluster-wide process naming, allowing any node to register and look up GenServer instances by name across the entire cluster. It implements automatic synchronization on node join and conflict resolution for concurrent registrations.

## Overview

In distributed systems, locating specific processes across multiple nodes is a common challenge. GlobalRegistry solves this by maintaining a synchronized name-to-process mapping across all cluster nodes:

```typescript
import { GlobalRegistry, Cluster } from 'noex/distribution';

// Register a process globally (from any node)
await GlobalRegistry.register('coordinator', {
  id: serverRef.id,
  nodeId: Cluster.getLocalNodeId(),
});

// Look up from any node in the cluster
const ref = GlobalRegistry.whereis('coordinator');
if (ref) {
  await RemoteCall.call(ref, { type: 'get_status' });
}
```

Key characteristics:

- **Cluster-wide uniqueness**: Each name can only be registered once across all nodes
- **Automatic synchronization**: New nodes receive existing registrations via gossip
- **Conflict resolution**: Deterministic resolution when concurrent registrations occur
- **Automatic cleanup**: Registrations are removed when owning nodes go down

## Registration

### Basic Registration

Register a process with a globally unique name:

```typescript
import { GenServer } from 'noex';
import { GlobalRegistry, Cluster, type SerializedRef } from 'noex/distribution';

// Start a local GenServer
const ref = await GenServer.start(coordinatorBehavior);

// Create serialized reference for the registry
const serializedRef: SerializedRef = {
  id: ref.id,
  nodeId: Cluster.getLocalNodeId(),
};

// Register globally
await GlobalRegistry.register('coordinator', serializedRef);
```

### Registration with RemoteSpawn

When spawning processes remotely, register them immediately:

```typescript
import { RemoteSpawn, GlobalRegistry } from 'noex/distribution';

// Spawn on a specific node
const result = await RemoteSpawn.spawn('worker', targetNodeId);

// Register globally
await GlobalRegistry.register('primary-worker', {
  id: result.serverId,
  nodeId: result.nodeId,
});
```

### Registration Errors

Attempting to register an already-taken name throws an error:

```typescript
import { GlobalRegistry, GlobalNameConflictError } from 'noex/distribution';

try {
  await GlobalRegistry.register('coordinator', ref);
} catch (error) {
  if (error instanceof GlobalNameConflictError) {
    console.error(
      `Name '${error.registryName}' already registered on ${error.existingNodeId}`
    );
  }
}
```

## Lookup

### whereis() - Safe Lookup

Returns `undefined` if the name is not registered:

```typescript
const ref = GlobalRegistry.whereis('coordinator');
if (ref) {
  // Process found - use it
  await RemoteCall.call(ref, { type: 'ping' });
} else {
  // Not registered - handle gracefully
  console.log('Coordinator not available');
}
```

### lookup() - Throwing Lookup

Throws an error if the name is not found:

```typescript
import { GlobalRegistry, GlobalNameNotFoundError } from 'noex/distribution';

try {
  const ref = GlobalRegistry.lookup('coordinator');
  // ref is guaranteed to exist here
  await RemoteCall.call(ref, { type: 'get_status' });
} catch (error) {
  if (error instanceof GlobalNameNotFoundError) {
    console.error(`Name '${error.registryName}' not found`);
  }
}
```

### Check Registration

Check if a name is registered without retrieving the reference:

```typescript
if (GlobalRegistry.isRegistered('coordinator')) {
  // Name is in use
}
```

### List All Names

Get all registered names:

```typescript
const names = GlobalRegistry.getNames();
console.log('Registered processes:', names);
// ['coordinator', 'primary-worker', 'metrics-collector']
```

## Unregistration

### Explicit Unregistration

Remove a registration when the process is no longer needed:

```typescript
// Only the owning node can unregister
await GlobalRegistry.unregister('coordinator');
```

### Automatic Cleanup

Registrations are automatically removed when:

1. **Node goes down**: All registrations from the disconnected node are removed
2. **Process crashes**: If using DistributedSupervisor with global registration
3. **Explicit unregister()**: Called by the owning node

```typescript
// Other nodes automatically see the removal
Cluster.onNodeDown((nodeId, reason) => {
  // All registrations from nodeId are already cleaned up
  const ref = GlobalRegistry.whereis('coordinator');
  // ref is undefined if coordinator was on the downed node
});
```

## Synchronization

### How Sync Works

GlobalRegistry uses a gossip-based synchronization protocol:

```
Node A (existing)                    Node B (joining)
      │                                    │
      │◄─────────── Connection ────────────│
      │                                    │
      │───────── RegistrySyncMessage ─────►│
      │     (all registrations from A)     │
      │                                    │
      │◄──────── RegistrySyncMessage ──────│
      │     (all registrations from B)     │
      │                                    │
      ▼                                    ▼
   [Both have merged registry state]
```

### Sync Events

Subscribe to synchronization events:

```typescript
GlobalRegistry.on('synced', (fromNodeId, entriesCount) => {
  console.log(`Synced ${entriesCount} entries from ${fromNodeId}`);
});

GlobalRegistry.on('registered', (name, ref) => {
  console.log(`New registration: ${name} -> ${ref.id}@${ref.nodeId}`);
});

GlobalRegistry.on('unregistered', (name, ref) => {
  console.log(`Removed: ${name}`);
});
```

## Conflict Resolution

When two nodes attempt to register the same name simultaneously, GlobalRegistry resolves the conflict deterministically:

### Resolution Rules

1. **Earlier timestamp wins**: The registration that happened first is kept
2. **Node priority as tiebreaker**: If timestamps are identical, a deterministic hash of node IDs breaks the tie

```
Timeline:
─────────────────────────────────────────────────────►
         t1                    t2
         │                     │
    Node A registers      Node B registers
    "leader" at t1        "leader" at t2
         │                     │
         ▼                     ▼
   [Node A wins - earlier timestamp]
```

### Conflict Events

Monitor conflict resolutions:

```typescript
GlobalRegistry.on('conflictResolved', (name, winner, loser) => {
  console.log(`Conflict on '${name}':`);
  console.log(`  Winner: ${winner.id}@${winner.nodeId}`);
  console.log(`  Loser: ${loser.id}@${loser.nodeId}`);
});
```

### Avoiding Conflicts

Best practices to minimize conflicts:

```typescript
// 1. Check before registering
if (!GlobalRegistry.isRegistered('leader')) {
  try {
    await GlobalRegistry.register('leader', ref);
  } catch (error) {
    if (error instanceof GlobalNameConflictError) {
      // Another node registered first - use theirs
      const existing = GlobalRegistry.whereis('leader');
    }
  }
}

// 2. Use unique prefixes for node-specific registrations
const nodeName = Cluster.getLocalNodeId().split('@')[0];
await GlobalRegistry.register(`worker-${nodeName}`, ref);

// 3. Use DistributedSupervisor for automatic singleton management
await DistributedSupervisor.start({
  children: [{
    id: 'leader',
    behavior: 'leader',
    // DistributedSupervisor handles registration
  }],
});
```

## Statistics

Monitor registry state and health:

```typescript
const stats = GlobalRegistry.getStats();

console.log(`Total registrations: ${stats.totalRegistrations}`);
console.log(`Local (this node): ${stats.localRegistrations}`);
console.log(`Remote (other nodes): ${stats.remoteRegistrations}`);
console.log(`Sync operations: ${stats.syncOperations}`);
console.log(`Conflicts resolved: ${stats.conflictsResolved}`);
```

### Stats Interface

```typescript
interface GlobalRegistryStats {
  /** Total number of global registrations */
  totalRegistrations: number;

  /** Registrations owned by this node */
  localRegistrations: number;

  /** Registrations owned by other nodes */
  remoteRegistrations: number;

  /** Number of sync operations completed */
  syncOperations: number;

  /** Number of conflicts resolved */
  conflictsResolved: number;
}
```

## Patterns

### Singleton Process

Ensure only one instance of a process exists cluster-wide:

```typescript
async function startSingletonCoordinator(): Promise<SerializedRef> {
  // Check if already exists
  const existing = GlobalRegistry.whereis('coordinator');
  if (existing) {
    return existing;
  }

  // Start and register
  const ref = await GenServer.start(coordinatorBehavior);
  const serialized: SerializedRef = {
    id: ref.id,
    nodeId: Cluster.getLocalNodeId(),
  };

  try {
    await GlobalRegistry.register('coordinator', serialized);
    return serialized;
  } catch (error) {
    if (error instanceof GlobalNameConflictError) {
      // Lost the race - stop our instance, use existing
      await GenServer.stop(ref);
      return GlobalRegistry.whereis('coordinator')!;
    }
    throw error;
  }
}
```

### Leader Election

Simple leader election using GlobalRegistry:

```typescript
async function electLeader(): Promise<{ isLeader: boolean; leaderRef: SerializedRef }> {
  const localRef: SerializedRef = {
    id: candidateRef.id,
    nodeId: Cluster.getLocalNodeId(),
  };

  try {
    await GlobalRegistry.register('cluster-leader', localRef);
    console.log('I am the leader');
    return { isLeader: true, leaderRef: localRef };
  } catch (error) {
    if (error instanceof GlobalNameConflictError) {
      const leader = GlobalRegistry.whereis('cluster-leader')!;
      console.log(`Leader is on ${leader.nodeId}`);
      return { isLeader: false, leaderRef: leader };
    }
    throw error;
  }
}

// Re-elect when leader node goes down
Cluster.onNodeDown((nodeId) => {
  const leader = GlobalRegistry.whereis('cluster-leader');
  if (!leader) {
    // Leader was on downed node - trigger new election
    electLeader();
  }
});
```

### Service Discovery

Register multiple instances of a service:

```typescript
// Each node registers its worker with unique name
const nodeId = Cluster.getLocalNodeId();
const nodeName = nodeId.split('@')[0];

await GlobalRegistry.register(`worker-${nodeName}`, workerRef);

// Find all workers across cluster
function findAllWorkers(): SerializedRef[] {
  return GlobalRegistry.getNames()
    .filter(name => name.startsWith('worker-'))
    .map(name => GlobalRegistry.whereis(name)!)
    .filter(Boolean);
}

// Load balance across workers
function getRandomWorker(): SerializedRef | undefined {
  const workers = findAllWorkers();
  if (workers.length === 0) return undefined;
  return workers[Math.floor(Math.random() * workers.length)];
}
```

### Process Groups

Manage groups of related processes:

```typescript
// Registry for process groups (stored in GenServer state)
interface ProcessGroup {
  name: string;
  members: SerializedRef[];
}

// Register in group
async function joinGroup(groupName: string, ref: SerializedRef): Promise<void> {
  const registryName = `group:${groupName}:${ref.id}`;
  await GlobalRegistry.register(registryName, ref);
}

// Find group members
function getGroupMembers(groupName: string): SerializedRef[] {
  const prefix = `group:${groupName}:`;
  return GlobalRegistry.getNames()
    .filter(name => name.startsWith(prefix))
    .map(name => GlobalRegistry.whereis(name)!)
    .filter(Boolean);
}

// Broadcast to group
async function broadcastToGroup(
  groupName: string,
  message: unknown,
): Promise<void> {
  const members = getGroupMembers(groupName);
  for (const member of members) {
    RemoteCall.cast(member, message);
  }
}
```

## Best Practices

### 1. Use Meaningful Names

```typescript
// Good: Descriptive, unique names
await GlobalRegistry.register('payment-processor', ref);
await GlobalRegistry.register('user-session-manager', ref);
await GlobalRegistry.register('metrics-aggregator-primary', ref);

// Bad: Generic names that may conflict
await GlobalRegistry.register('worker', ref);
await GlobalRegistry.register('server', ref);
```

### 2. Handle Registration Failures

```typescript
async function safeRegister(
  name: string,
  ref: SerializedRef,
): Promise<boolean> {
  try {
    await GlobalRegistry.register(name, ref);
    return true;
  } catch (error) {
    if (error instanceof GlobalNameConflictError) {
      // Expected - another node registered first
      return false;
    }
    throw error; // Unexpected error
  }
}
```

### 3. Use whereis() for Optional Lookups

```typescript
// Good: Safe lookup with null check
const coordinator = GlobalRegistry.whereis('coordinator');
if (coordinator) {
  await RemoteCall.call(coordinator, message);
}

// Avoid: Throwing lookup when process might not exist
try {
  const coordinator = GlobalRegistry.lookup('coordinator');
} catch {
  // Don't use exceptions for control flow
}
```

### 4. Clean Up Before Node Shutdown

```typescript
// Graceful shutdown
process.on('SIGTERM', async () => {
  // Unregister local processes
  for (const name of GlobalRegistry.getNames()) {
    const ref = GlobalRegistry.whereis(name);
    if (ref && ref.nodeId === Cluster.getLocalNodeId()) {
      await GlobalRegistry.unregister(name);
    }
  }

  await Cluster.stop();
  process.exit(0);
});
```

### 5. Monitor Registry Health

```typescript
setInterval(() => {
  const stats = GlobalRegistry.getStats();

  // Alert on high conflict rate
  if (stats.conflictsResolved > 10) {
    console.warn('High registry conflict rate - check naming strategy');
  }

  // Monitor registration counts
  console.log(`Registry: ${stats.localRegistrations} local, ${stats.remoteRegistrations} remote`);
}, 30000);
```

## Comparison with Erlang :global

| Feature | Erlang :global | noex GlobalRegistry |
|---------|---------------|---------------------|
| Naming | Atom-based | String-based |
| Registration | `global:register_name/2` | `GlobalRegistry.register()` |
| Lookup | `global:whereis_name/1` | `GlobalRegistry.whereis()` |
| Conflict resolution | Random, re-registration | Timestamp + priority |
| Sync protocol | Full cluster lock | Gossip-based |
| Performance | Slower (global lock) | Faster (eventual consistency) |

## Related

- [Overview](./overview.md) - Distribution architecture
- [Remote Messaging](./remote-messaging.md) - Using registered processes
- [Distributed Supervisor](./distributed-supervisor.md) - Automatic registration
- [GlobalRegistry API Reference](../api/global-registry.md) - Complete API

---

*[Czech version](../../cs/distribution/concepts/global-registry.md)*
