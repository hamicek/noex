# GlobalRegistry API Reference

The `GlobalRegistry` singleton provides cluster-wide name registration for processes, enabling lookup of GenServer references across all nodes.

## Import

```typescript
import { GlobalRegistry } from 'noex/distribution';
```

## Overview

GlobalRegistry provides:
- Unique global names across all nodes
- Automatic synchronization on node join
- Conflict resolution via timestamp + node priority
- Automatic cleanup on node down

---

## Types

### GlobalRegistryEvents

Events emitted by GlobalRegistry.

```typescript
interface GlobalRegistryEvents {
  registered: [name: string, ref: SerializedRef];
  unregistered: [name: string, ref: SerializedRef];
  conflictResolved: [name: string, winner: SerializedRef, loser: SerializedRef];
  synced: [fromNodeId: NodeId, entriesCount: number];
}
```

| Event | Description |
|-------|-------------|
| `registered` | Emitted when a global registration is added |
| `unregistered` | Emitted when a global registration is removed |
| `conflictResolved` | Emitted when a registration conflict is resolved |
| `synced` | Emitted when registry sync completes |

### GlobalRegistryStats

Statistics about the global registry.

```typescript
interface GlobalRegistryStats {
  readonly totalRegistrations: number;
  readonly localRegistrations: number;
  readonly remoteRegistrations: number;
  readonly syncOperations: number;
  readonly conflictsResolved: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `totalRegistrations` | `number` | Total number of global registrations |
| `localRegistrations` | `number` | Registrations owned by this node |
| `remoteRegistrations` | `number` | Registrations owned by other nodes |
| `syncOperations` | `number` | Number of sync operations completed |
| `conflictsResolved` | `number` | Number of conflicts resolved |

---

## Methods

### register()

Registers a process globally across the cluster.

```typescript
async register(name: string, ref: SerializedRef): Promise<void>
```

**Parameters:**
- `name` - Unique name for the registration
- `ref` - Serialized reference to the process

**Throws:**
- `GlobalNameConflictError` - If name is already registered by another node

The registration is broadcast to all connected nodes. If the name is already registered, the conflict is resolved using timestamp and node priority - earlier registration wins.

**Example:**
```typescript
import { GenServer } from 'noex';
import { Cluster, GlobalRegistry } from 'noex/distribution';

const ref = await GenServer.start(counterBehavior);

await GlobalRegistry.register('main-counter', {
  id: ref.id,
  nodeId: Cluster.getLocalNodeId(),
});
```

---

### unregister()

Unregisters a globally registered process.

```typescript
async unregister(name: string): Promise<void>
```

**Parameters:**
- `name` - Name of the registration to remove

Only the owning node can unregister a process. If the name is not registered or owned by another node, this is a no-op.

**Example:**
```typescript
await GlobalRegistry.unregister('main-counter');
```

---

### lookup()

Looks up a globally registered process.

```typescript
lookup(name: string): SerializedRef
```

**Parameters:**
- `name` - Name to look up

**Returns:** The serialized reference

**Throws:**
- `GlobalNameNotFoundError` - If name is not registered

**Example:**
```typescript
try {
  const ref = GlobalRegistry.lookup('main-counter');
  const result = await RemoteCall.call(ref, { type: 'get' });
} catch (error) {
  if (error instanceof GlobalNameNotFoundError) {
    console.log('Counter not registered');
  }
}
```

---

### whereis()

Looks up a globally registered process, returning undefined if not found.

```typescript
whereis(name: string): SerializedRef | undefined
```

**Parameters:**
- `name` - Name to look up

**Returns:** The serialized reference if found, undefined otherwise

This is a safer alternative to `lookup()` when you're not sure if the name exists.

**Example:**
```typescript
const ref = GlobalRegistry.whereis('main-counter');
if (ref) {
  const result = await RemoteCall.call(ref, { type: 'get' });
} else {
  console.log('Counter not registered');
}
```

---

### isRegistered()

Checks if a name is globally registered.

```typescript
isRegistered(name: string): boolean
```

**Parameters:**
- `name` - Name to check

**Returns:** `true` if the name is registered

**Example:**
```typescript
if (!GlobalRegistry.isRegistered('main-counter')) {
  await GlobalRegistry.register('main-counter', ref);
}
```

---

### getNames()

Returns all registered names.

```typescript
getNames(): readonly string[]
```

**Returns:** Array of all registered names

**Example:**
```typescript
const names = GlobalRegistry.getNames();
console.log(`Registered services: ${names.join(', ')}`);
```

---

### count()

Returns the number of global registrations.

```typescript
count(): number
```

**Returns:** Total number of registrations

---

### getStats()

Returns statistics about the global registry.

```typescript
getStats(): GlobalRegistryStats
```

**Example:**
```typescript
const stats = GlobalRegistry.getStats();
console.log(`Total: ${stats.totalRegistrations}`);
console.log(`Local: ${stats.localRegistrations}`);
console.log(`Remote: ${stats.remoteRegistrations}`);
console.log(`Syncs: ${stats.syncOperations}`);
console.log(`Conflicts: ${stats.conflictsResolved}`);
```

---

## Error Classes

### GlobalNameConflictError

```typescript
class GlobalNameConflictError extends Error {
  readonly name = 'GlobalNameConflictError';
  readonly registryName: string;
  readonly existingNodeId: NodeId;
}
```

Thrown when attempting to register a name that is already in use.

### GlobalNameNotFoundError

```typescript
class GlobalNameNotFoundError extends Error {
  readonly name = 'GlobalNameNotFoundError';
  readonly registryName: string;
}
```

Thrown when looking up a name that is not registered.

---

## Complete Example

```typescript
import { GenServer } from 'noex';
import {
  Cluster,
  GlobalRegistry,
  RemoteCall,
  GlobalNameConflictError,
  GlobalNameNotFoundError,
} from 'noex/distribution';

// Counter behavior
const counterBehavior = {
  init: () => 0,
  handleCall: (msg: 'get' | 'inc', state: number) => {
    if (msg === 'get') return [state, state];
    return [state + 1, state + 1];
  },
  handleCast: (_msg: never, state: number) => state,
};

async function main() {
  await Cluster.start({
    nodeName: 'node1',
    port: 4369,
    seeds: ['node2@192.168.1.2:4369'],
  });

  // Start a local counter
  const counterRef = await GenServer.start(counterBehavior);

  // Register it globally
  try {
    await GlobalRegistry.register('counter', {
      id: counterRef.id,
      nodeId: Cluster.getLocalNodeId(),
    });
    console.log('Registered counter globally');
  } catch (error) {
    if (error instanceof GlobalNameConflictError) {
      console.log(`Counter already registered on ${error.existingNodeId}`);
    } else {
      throw error;
    }
  }

  // Wait for other nodes
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // List all global registrations
  console.log('\nGlobal registrations:');
  for (const name of GlobalRegistry.getNames()) {
    const ref = GlobalRegistry.lookup(name);
    console.log(`  ${name} -> ${ref.id}@${ref.nodeId}`);
  }

  // Use a registered service
  const cacheRef = GlobalRegistry.whereis('cache');
  if (cacheRef) {
    const value = await RemoteCall.call(cacheRef, { type: 'get', key: 'user:1' });
    console.log(`Cache value: ${value}`);
  }

  // Print statistics
  const stats = GlobalRegistry.getStats();
  console.log(`\nRegistry stats:`);
  console.log(`  Total registrations: ${stats.totalRegistrations}`);
  console.log(`  Local: ${stats.localRegistrations}`);
  console.log(`  Remote: ${stats.remoteRegistrations}`);

  // Cleanup on shutdown
  process.on('SIGINT', async () => {
    await GlobalRegistry.unregister('counter');
    await Cluster.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Conflict Resolution

When two nodes attempt to register the same name simultaneously:

1. **Timestamp wins**: The earlier registration (lower `registeredAt`) wins
2. **Priority tiebreaker**: If timestamps are equal, lower node priority wins (deterministic hash of node ID)

The losing registration is automatically removed on the conflicting node.

```typescript
// Listen for conflict resolution events
GlobalRegistry.on('conflictResolved', (name, winner, loser) => {
  console.log(`Conflict for '${name}':`);
  console.log(`  Winner: ${winner.id}@${winner.nodeId}`);
  console.log(`  Loser: ${loser.id}@${loser.nodeId}`);
});
```

---

## Automatic Cleanup

GlobalRegistry automatically cleans up registrations when:

1. **Node goes down**: All registrations from that node are removed
2. **Process terminates**: Manual unregister is required (not automatic)

```typescript
// Listen for cleanup on node down
Cluster.onNodeDown((nodeId, reason) => {
  console.log(`Node ${nodeId} down, its registrations will be removed`);
});
```

---

## Best Practices

### Use Descriptive Names

```typescript
// Good: descriptive, namespaced names
await GlobalRegistry.register('service:counter:main', ref);
await GlobalRegistry.register('worker:pool:images', ref);

// Avoid: generic, collision-prone names
await GlobalRegistry.register('counter', ref);
await GlobalRegistry.register('worker', ref);
```

### Check Before Register

```typescript
// Safe registration pattern
async function registerIfNotExists(name: string, ref: SerializedRef): Promise<boolean> {
  if (GlobalRegistry.isRegistered(name)) {
    return false;
  }

  try {
    await GlobalRegistry.register(name, ref);
    return true;
  } catch (error) {
    if (error instanceof GlobalNameConflictError) {
      return false; // Race condition, someone else registered first
    }
    throw error;
  }
}
```

### Use whereis() for Optional Lookups

```typescript
// Good: graceful handling of missing registration
const ref = GlobalRegistry.whereis('optional-service');
if (ref) {
  await RemoteCall.call(ref, message);
}

// Avoid: exception-based flow control
try {
  const ref = GlobalRegistry.lookup('optional-service');
  await RemoteCall.call(ref, message);
} catch (e) {
  // Handle missing service
}
```

### Clean Up on Shutdown

```typescript
const registeredNames: string[] = [];

async function registerService(name: string, ref: SerializedRef): Promise<void> {
  await GlobalRegistry.register(name, ref);
  registeredNames.push(name);
}

async function shutdown(): Promise<void> {
  for (const name of registeredNames) {
    await GlobalRegistry.unregister(name);
  }
  await Cluster.stop();
}
```

---

## Related

- [GlobalRegistry Concepts](../concepts/global-registry.md) - Understanding cluster-wide naming
- [RemoteCall API](./remote-call.md) - Calling registered processes
- [Cluster API](./cluster.md) - Cluster lifecycle
- [Types Reference](./types.md) - All distribution types
