# Remote Calls

In the previous chapter, you learned how to form a cluster — nodes that discover each other and detect failures. Now it's time to make those nodes actually *work together*. Remote calls let processes on different nodes communicate transparently, as if they were on the same machine.

## What You'll Learn

- Register behaviors for remote spawning using `BehaviorRegistry`
- Spawn GenServers on remote nodes with `RemoteSpawn` and `GenServer.startRemote()`
- Make calls and casts to remote processes with transparent routing
- Discover processes cluster-wide using `GlobalRegistry`
- Handle remote errors and timeouts gracefully
- Build a distributed counter system from scratch

## The Challenge of Distributed Communication

When your application spans multiple machines, communication becomes more complex:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     LOCAL vs DISTRIBUTED COMMUNICATION                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  LOCAL (Single Node)               │  DISTRIBUTED (Multi-Node)              │
│  ──────────────────────────        │  ──────────────────────────────────    │
│                                    │                                        │
│  ┌─────────┐       ┌─────────┐     │  ┌─────────┐   network   ┌─────────┐  │
│  │ Process │──────►│ Process │     │  │ Process │─────?─────►│ Process │  │
│  │    A    │  msg  │    B    │     │  │    A    │             │    B    │  │
│  └─────────┘       └─────────┘     │  └─────────┘             └─────────┘  │
│                                    │   Node 1                  Node 2      │
│  - Direct function call            │                                        │
│  - Shared memory                   │  Challenges:                           │
│  - No serialization needed         │  - How to find Process B?              │
│  - Instant, reliable               │  - How to serialize messages?          │
│                                    │  - What if network fails?              │
│                                    │  - What about timeouts?                │
│                                    │                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

noex solves these challenges with **transparent routing** — your code looks the same whether calling local or remote processes.

## How Remote Calls Work

Before diving into the API, let's understand the architecture:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         REMOTE CALL FLOW                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  NODE 1 (caller)                         NODE 2 (callee)                    │
│  ────────────────                        ────────────────                   │
│                                                                             │
│  ┌──────────────┐                        ┌──────────────┐                   │
│  │   Caller     │                        │   Counter    │                   │
│  │  GenServer   │                        │  GenServer   │                   │
│  └──────┬───────┘                        └──────▲───────┘                   │
│         │                                       │                           │
│         │ GenServer.call(remoteRef, msg)        │ handleCall(msg, state)    │
│         ▼                                       │                           │
│  ┌──────────────┐                        ┌──────┴───────┐                   │
│  │  RemoteCall  │                        │  RemoteCall  │                   │
│  │   (send)     │                        │  (receive)   │                   │
│  └──────┬───────┘                        └──────▲───────┘                   │
│         │                                       │                           │
│         │ serialize + sign (HMAC)               │ deserialize + verify      │
│         ▼                                       │                           │
│  ┌──────────────┐                        ┌──────┴───────┐                   │
│  │  Transport   │═════════════════════════  Transport   │                   │
│  │    (TCP)     │      TCP connection     │   (TCP)     │                   │
│  └──────────────┘                        └──────────────┘                   │
│                                                                             │
│  Timeline:                                                                  │
│  1. Caller invokes GenServer.call(remoteRef, { type: 'get' })               │
│  2. noex detects remoteRef.nodeId !== local node                            │
│  3. Message serialized and sent via TCP to Node 2                           │
│  4. Node 2 deserializes and calls Counter.handleCall()                      │
│  5. Reply serialized and sent back via TCP                                  │
│  6. Caller receives reply (or times out)                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Behavior Registry

Before you can spawn a GenServer on a remote node, the remote node must know *how* to create it. This is where `BehaviorRegistry` comes in.

### Why Pre-Registration?

When Node A tells Node B to "spawn a counter", Node B needs:
- The `init()` function
- The `handleCall()` function
- The `handleCast()` function
- Any other behavior options

Since functions can't be serialized over the network, both nodes must have the behavior registered under the same name.

```typescript
import { BehaviorRegistry, GenServerBehavior } from '@hamicek/noex';

// Define the behavior
interface CounterState {
  count: number;
}

type CounterCall = { type: 'get' } | { type: 'increment' };
type CounterCast = { type: 'reset' };

const counterBehavior: GenServerBehavior<CounterState, CounterCall, CounterCast, number> = {
  init: () => ({ count: 0 }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.count, state];
      case 'increment':
        const newState = { count: state.count + 1 };
        return [newState.count, newState];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'reset':
        return { count: 0 };
    }
  },
};

// Register on ALL nodes before remote spawning
BehaviorRegistry.register('counter', counterBehavior);
```

### Registration Rules

1. **Same name, same behavior**: All nodes must register the exact same behavior under the same name
2. **Register before spawning**: Registration must happen before any remote spawn attempts
3. **Register at startup**: Best practice is to register behaviors during application initialization

```typescript
// app-startup.ts - Run this on every node
import { BehaviorRegistry } from '@hamicek/noex';
import { counterBehavior } from './behaviors/counter';
import { userBehavior } from './behaviors/user';
import { sessionBehavior } from './behaviors/session';

export function registerBehaviors(): void {
  BehaviorRegistry.register('counter', counterBehavior);
  BehaviorRegistry.register('user', userBehavior);
  BehaviorRegistry.register('session', sessionBehavior);
}
```

### Checking Registration

```typescript
// Check if behavior is registered
const behavior = BehaviorRegistry.get('counter');
if (behavior) {
  console.log('Counter behavior is registered');
}

// Get registration statistics
const stats = BehaviorRegistry.getStats();
console.log(`Registered behaviors: ${stats.registeredBehaviors}`);
```

## Remote Spawn

Once behaviors are registered, you can spawn GenServers on remote nodes.

### Using GenServer.startRemote() (Recommended)

The simplest way to spawn on a remote node:

```typescript
import { GenServer, Cluster } from '@hamicek/noex';

// Ensure cluster is running
await Cluster.start({
  nodeName: 'app1',
  port: 4369,
  seeds: ['app2@192.168.1.2:4370'],
});

// Spawn a counter on a remote node
const remoteRef = await GenServer.startRemote<CounterState, CounterCall, CounterCast, number>(
  'counter',  // Behavior name (must be registered on target node)
  {
    targetNode: 'app2@192.168.1.2:4370',  // Where to spawn
    name: 'remote-counter',               // Optional: register with this name
    registration: 'global',               // 'local' | 'global' | 'none'
    spawnTimeout: 15000,                  // Timeout for spawn operation
  }
);

console.log(`Spawned on node: ${remoteRef.nodeId}`);
```

### RemoteStartOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `targetNode` | `string` | required | Target node in `name@host:port` format |
| `name` | `string` | `undefined` | Register the process with this name |
| `registration` | `'local' \| 'global' \| 'none'` | `'none'` | Where to register the name |
| `spawnTimeout` | `number` | `10000` | Timeout for spawn operation (ms) |
| `initTimeout` | `number` | `5000` | Timeout for `init()` callback (ms) |

### Registration Modes

```typescript
// No registration - access only via ref
const ref1 = await GenServer.startRemote('counter', {
  targetNode: 'app2@192.168.1.2:4370',
  registration: 'none',  // Default
});

// Local registration - accessible only on the target node
const ref2 = await GenServer.startRemote('counter', {
  targetNode: 'app2@192.168.1.2:4370',
  name: 'local-counter',
  registration: 'local',  // Registered in Registry on app2 only
});

// Global registration - accessible from any node in the cluster
const ref3 = await GenServer.startRemote('counter', {
  targetNode: 'app2@192.168.1.2:4370',
  name: 'shared-counter',
  registration: 'global',  // Registered in GlobalRegistry, visible everywhere
});
```

### Low-Level API: RemoteSpawn

For more control, use `RemoteSpawn` directly:

```typescript
import { RemoteSpawn, NodeId } from '@hamicek/noex/distribution';

const result = await RemoteSpawn.spawn(
  'counter',                                    // Behavior name
  NodeId.parse('app2@192.168.1.2:4370'),        // Target node
  {
    name: 'my-counter',
    registration: 'global',
    timeout: 10000,
  }
);

// Result contains spawned server info
const ref = {
  id: result.serverId,
  nodeId: result.nodeId,
};
```

## Remote Calls and Casts

The beauty of noex distribution is **transparent routing** — you call remote processes the same way as local ones.

### Transparent Routing

```typescript
import { GenServer } from '@hamicek/noex';

// This works the same whether ref is local or remote!
const value = await GenServer.call(ref, { type: 'get' });
GenServer.cast(ref, { type: 'reset' });
```

noex automatically:
1. Checks if `ref.nodeId` matches the local node
2. If remote, serializes the message
3. Sends via TCP to the target node
4. Deserializes the reply (for calls)
5. Returns the result

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TRANSPARENT ROUTING                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                  GenServer.call(ref, msg)                                   │
│                           │                                                 │
│                           ▼                                                 │
│                  ┌────────────────┐                                         │
│                  │ Is ref.nodeId  │                                         │
│                  │ === local node?│                                         │
│                  └────────┬───────┘                                         │
│                    │             │                                          │
│               YES  │             │  NO                                      │
│                    ▼             ▼                                          │
│           ┌──────────────┐  ┌──────────────┐                                │
│           │  Local Call  │  │ Remote Call  │                                │
│           │              │  │              │                                │
│           │ - Queue msg  │  │ - Serialize  │                                │
│           │ - Run handler│  │ - TCP send   │                                │
│           │ - Return     │  │ - Wait reply │                                │
│           └──────────────┘  └──────────────┘                                │
│                    │             │                                          │
│                    └──────┬──────┘                                          │
│                           ▼                                                 │
│                      Same API!                                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Call Options

```typescript
// Set timeout for remote call (default: 5000ms)
const value = await GenServer.call(remoteRef, { type: 'get' }, {
  timeout: 10000,  // 10 seconds
});

// Cast is fire-and-forget, no options needed
GenServer.cast(remoteRef, { type: 'reset' });
```

### Error Handling

Remote calls can fail for network-related reasons:

```typescript
import {
  GenServer,
  NodeNotReachableError,
  RemoteCallTimeoutError,
  RemoteServerNotRunningError,
} from '@hamicek/noex';

try {
  const value = await GenServer.call(remoteRef, { type: 'get' });
} catch (error) {
  if (error instanceof NodeNotReachableError) {
    // Target node is not connected
    console.error(`Node ${error.nodeId} is not reachable`);
  } else if (error instanceof RemoteCallTimeoutError) {
    // Call timed out (network slow or server overloaded)
    console.error(`Call to ${error.ref.id} timed out after ${error.timeout}ms`);
  } else if (error instanceof RemoteServerNotRunningError) {
    // GenServer not running on target node
    console.error(`Server ${error.ref.id} is not running on ${error.ref.nodeId}`);
  }
}
```

### Call vs Cast for Remote

| Aspect | `call()` | `cast()` |
|--------|----------|----------|
| Returns | Reply value | void |
| Blocking | Yes (waits for reply) | No (fire-and-forget) |
| Timeout | Yes | No |
| Guaranteed delivery | Yes (or error) | No (best effort) |
| Use when | You need the result | You don't need confirmation |

```typescript
// Call: Get current count (need the value)
const count = await GenServer.call(ref, { type: 'get' });

// Cast: Increment (don't need confirmation)
GenServer.cast(ref, { type: 'increment' });
```

## Global Registry

While you can store refs manually, `GlobalRegistry` provides cluster-wide process discovery — any node can find a process by name.

### Registering Globally

```typescript
import { GlobalRegistry } from '@hamicek/noex/distribution';

// Spawn a process
const ref = await GenServer.startRemote('counter', {
  targetNode: 'app2@192.168.1.2:4370',
});

// Register it globally
await GlobalRegistry.register('main-counter', ref);

// Now any node can find it
const foundRef = GlobalRegistry.lookup('main-counter');
```

### Lookup Methods

```typescript
// lookup() - throws if not found
try {
  const ref = GlobalRegistry.lookup('main-counter');
  await GenServer.call(ref, { type: 'get' });
} catch (error) {
  if (error instanceof GlobalNameNotFoundError) {
    console.error('Counter not registered');
  }
}

// whereis() - returns undefined if not found (safer)
const ref = GlobalRegistry.whereis('main-counter');
if (ref) {
  await GenServer.call(ref, { type: 'get' });
}

// isRegistered() - check without getting ref
if (GlobalRegistry.isRegistered('main-counter')) {
  // ...
}
```

### Listing Registrations

```typescript
// Get all registered names
const names = GlobalRegistry.getNames();
console.log(`Registered: ${names.join(', ')}`);

// Count registrations
const count = GlobalRegistry.count();
console.log(`Total: ${count} global processes`);

// Get entries for a specific node
const nodeId = NodeId.parse('app2@192.168.1.2:4370');
const entries = GlobalRegistry.getEntriesForNode(nodeId);
for (const entry of entries) {
  console.log(`  ${entry.name} -> ${entry.ref.id}`);
}
```

### Unregistering

```typescript
// Remove from global registry
await GlobalRegistry.unregister('main-counter');
```

### Global Registry Events

```typescript
// Monitor registrations
GlobalRegistry.on('registered', (name, ref) => {
  console.log(`Registered: ${name} -> ${ref.id}@${ref.nodeId}`);
});

GlobalRegistry.on('unregistered', (name, ref) => {
  console.log(`Unregistered: ${name}`);
});

// Handle conflicts (same name registered on multiple nodes)
GlobalRegistry.on('conflictResolved', (name, winner, loser) => {
  console.log(`Conflict for ${name}: ${winner.id} won over ${loser.id}`);
});

// Sync events (when nodes share their registrations)
GlobalRegistry.on('synced', (fromNodeId, entriesCount) => {
  console.log(`Synced ${entriesCount} entries from ${fromNodeId}`);
});
```

### Conflict Resolution

When two nodes try to register the same name simultaneously, noex resolves conflicts using:

1. **Registration timestamp**: Earlier registration wins
2. **Priority**: Higher priority wins (if timestamps equal)
3. **Node ID**: Lexicographic comparison as tiebreaker

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       GLOBAL REGISTRY CONFLICT                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Node 1                              Node 2                                 │
│  ──────                              ──────                                 │
│                                                                             │
│  register('counter', refA)           register('counter', refB)              │
│  timestamp: 1000                     timestamp: 1005                        │
│         │                                   │                               │
│         └─────────────┬─────────────────────┘                               │
│                       ▼                                                     │
│             ┌────────────────────┐                                          │
│             │ Conflict detected! │                                          │
│             │                    │                                          │
│             │ refA: ts=1000      │                                          │
│             │ refB: ts=1005      │                                          │
│             │                    │                                          │
│             │ Winner: refA       │  (earlier timestamp)                     │
│             └────────────────────┘                                          │
│                       │                                                     │
│                       ▼                                                     │
│         'conflictResolved' event emitted                                    │
│         refA is kept, refB is rejected                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Automatic Registration on Spawn

The most convenient pattern is to register during spawn:

```typescript
// All-in-one: spawn + global registration
const ref = await GenServer.startRemote('counter', {
  targetNode: 'app2@192.168.1.2:4370',
  name: 'shared-counter',
  registration: 'global',  // Automatically registers in GlobalRegistry
});

// From any node in the cluster:
const foundRef = GlobalRegistry.lookup('shared-counter');
const value = await GenServer.call(foundRef, { type: 'get' });
```

## Practical Example: Distributed Counter Service

Let's build a complete distributed counter service that spans multiple nodes:

```typescript
// counter-service.ts
import {
  GenServer,
  GenServerBehavior,
  BehaviorRegistry,
  Cluster,
  Application,
  Supervisor,
} from '@hamicek/noex';
import { GlobalRegistry, NodeId } from '@hamicek/noex/distribution';

// ============================================================================
// Types
// ============================================================================

interface CounterState {
  count: number;
  lastUpdatedBy: string | null;
  history: Array<{ value: number; timestamp: number }>;
}

type CounterCall =
  | { type: 'get' }
  | { type: 'getHistory' }
  | { type: 'increment'; by?: number; actor: string }
  | { type: 'decrement'; by?: number; actor: string };

type CounterCast =
  | { type: 'reset'; actor: string };

interface CounterReply {
  count: number;
  lastUpdatedBy: string | null;
}

// ============================================================================
// Behavior Definition
// ============================================================================

const counterBehavior: GenServerBehavior<
  CounterState,
  CounterCall,
  CounterCast,
  CounterReply | CounterState['history']
> = {
  init: () => ({
    count: 0,
    lastUpdatedBy: null,
    history: [{ value: 0, timestamp: Date.now() }],
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [
          { count: state.count, lastUpdatedBy: state.lastUpdatedBy },
          state,
        ];

      case 'getHistory':
        return [state.history, state];

      case 'increment': {
        const delta = msg.by ?? 1;
        const newCount = state.count + delta;
        const newState: CounterState = {
          count: newCount,
          lastUpdatedBy: msg.actor,
          history: [
            ...state.history.slice(-99),  // Keep last 100 entries
            { value: newCount, timestamp: Date.now() },
          ],
        };
        return [{ count: newCount, lastUpdatedBy: msg.actor }, newState];
      }

      case 'decrement': {
        const delta = msg.by ?? 1;
        const newCount = state.count - delta;
        const newState: CounterState = {
          count: newCount,
          lastUpdatedBy: msg.actor,
          history: [
            ...state.history.slice(-99),
            { value: newCount, timestamp: Date.now() },
          ],
        };
        return [{ count: newCount, lastUpdatedBy: msg.actor }, newState];
      }
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'reset':
        return {
          count: 0,
          lastUpdatedBy: msg.actor,
          history: [{ value: 0, timestamp: Date.now() }],
        };
    }
  },
};

// ============================================================================
// Application Setup
// ============================================================================

export class CounterServiceApp {
  private localRef: GenServerRef<CounterState, CounterCall, CounterCast, CounterReply> | null = null;

  async start(config: {
    nodeName: string;
    port: number;
    seeds: string[];
    isPrimary: boolean;
  }): Promise<void> {
    // 1. Register behaviors (must be done on ALL nodes)
    BehaviorRegistry.register('distributed-counter', counterBehavior);

    // 2. Start cluster
    await Cluster.start({
      nodeName: config.nodeName,
      port: config.port,
      seeds: config.seeds,
      heartbeatIntervalMs: 3000,
      heartbeatMissThreshold: 2,
    });

    console.log(`Cluster started as ${Cluster.getLocalNodeId()}`);

    // 3. Set up event handlers
    Cluster.onNodeUp((node) => {
      console.log(`Node joined: ${node.id}`);
    });

    Cluster.onNodeDown((nodeId, reason) => {
      console.log(`Node left: ${nodeId} (${reason})`);
      // Could trigger failover logic here
    });

    GlobalRegistry.on('registered', (name, ref) => {
      console.log(`Global registration: ${name} -> ${ref.nodeId}`);
    });

    // 4. If primary, spawn the shared counter
    if (config.isPrimary) {
      await this.spawnPrimaryCounter();
    }
  }

  private async spawnPrimaryCounter(): Promise<void> {
    console.log('Spawning primary counter...');

    // Start locally on this node
    this.localRef = await GenServer.start(counterBehavior, {
      name: 'primary-counter',
    });

    // Register globally so all nodes can find it
    await GlobalRegistry.register('shared-counter', this.localRef);
    console.log('Primary counter registered globally');
  }

  async getCounter(): Promise<GenServerRef<CounterState, CounterCall, CounterCast, CounterReply> | null> {
    // Try local ref first
    if (this.localRef) {
      return this.localRef;
    }

    // Otherwise, look up in global registry
    return GlobalRegistry.whereis('shared-counter') ?? null;
  }

  async getValue(): Promise<CounterReply | null> {
    const ref = await this.getCounter();
    if (!ref) {
      return null;
    }

    try {
      return await GenServer.call(ref, { type: 'get' });
    } catch (error) {
      console.error('Failed to get counter value:', error);
      return null;
    }
  }

  async increment(actor: string, by: number = 1): Promise<CounterReply | null> {
    const ref = await this.getCounter();
    if (!ref) {
      return null;
    }

    try {
      return await GenServer.call(ref, { type: 'increment', by, actor });
    } catch (error) {
      console.error('Failed to increment:', error);
      return null;
    }
  }

  async decrement(actor: string, by: number = 1): Promise<CounterReply | null> {
    const ref = await this.getCounter();
    if (!ref) {
      return null;
    }

    try {
      return await GenServer.call(ref, { type: 'decrement', by, actor });
    } catch (error) {
      console.error('Failed to decrement:', error);
      return null;
    }
  }

  reset(actor: string): void {
    const ref = this.getCounter();
    if (ref) {
      GenServer.cast(ref as any, { type: 'reset', actor });
    }
  }

  async stop(): Promise<void> {
    if (this.localRef) {
      await GlobalRegistry.unregister('shared-counter');
      await GenServer.stop(this.localRef);
    }
    await Cluster.stop();
  }
}

// ============================================================================
// Usage Example
// ============================================================================

async function runPrimaryNode(): Promise<void> {
  const app = new CounterServiceApp();

  await app.start({
    nodeName: 'primary',
    port: 4369,
    seeds: [],
    isPrimary: true,
  });

  // Increment every second to show activity
  setInterval(async () => {
    const result = await app.increment('primary-node');
    if (result) {
      console.log(`Counter: ${result.count} (by ${result.lastUpdatedBy})`);
    }
  }, 1000);

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await app.stop();
    process.exit(0);
  });
}

async function runSecondaryNode(seedHost: string): Promise<void> {
  const app = new CounterServiceApp();

  await app.start({
    nodeName: 'secondary',
    port: 4370,
    seeds: [`primary@${seedHost}:4369`],
    isPrimary: false,
  });

  // Wait for global registry to sync
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Read and increment every 2 seconds
  setInterval(async () => {
    const value = await app.getValue();
    if (value) {
      console.log(`Read counter: ${value.count}`);
    }

    const result = await app.increment('secondary-node', 5);
    if (result) {
      console.log(`After increment: ${result.count}`);
    }
  }, 2000);

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await app.stop();
    process.exit(0);
  });
}

// Run with: npx tsx counter-service.ts primary
// Or:       npx tsx counter-service.ts secondary localhost
const mode = process.argv[2];
if (mode === 'primary') {
  runPrimaryNode().catch(console.error);
} else if (mode === 'secondary') {
  const seedHost = process.argv[3] || 'localhost';
  runSecondaryNode(seedHost).catch(console.error);
}
```

Run in two terminals:

```bash
# Terminal 1: Start primary node
npx tsx counter-service.ts primary

# Terminal 2: Start secondary node
npx tsx counter-service.ts secondary localhost
```

Expected output:

```
# Terminal 1 (primary)
Cluster started as primary@0.0.0.0:4369
Spawning primary counter...
Primary counter registered globally
Counter: 1 (by primary-node)
Counter: 2 (by primary-node)
Node joined: secondary@0.0.0.0:4370
Counter: 3 (by primary-node)
Counter: 9 (by secondary-node)   # Secondary incremented by 5
Counter: 10 (by primary-node)

# Terminal 2 (secondary)
Cluster started as secondary@0.0.0.0:4370
Node joined: primary@0.0.0.0:4369
Global registration: shared-counter -> primary@0.0.0.0:4369
Read counter: 3
After increment: 8
Read counter: 10
After increment: 15
```

## Error Handling Best Practices

### Graceful Degradation

```typescript
async function safeRemoteCall<T>(
  ref: GenServerRef<any, any, any, T>,
  msg: unknown,
  fallback: T,
): Promise<T> {
  try {
    return await GenServer.call(ref, msg, { timeout: 5000 });
  } catch (error) {
    if (error instanceof NodeNotReachableError) {
      console.warn(`Node ${error.nodeId} unreachable, using fallback`);
      return fallback;
    }
    if (error instanceof RemoteCallTimeoutError) {
      console.warn('Remote call timed out, using fallback');
      return fallback;
    }
    throw error;  // Re-throw unexpected errors
  }
}

// Usage
const count = await safeRemoteCall(counterRef, { type: 'get' }, { count: 0 });
```

### Retry with Backoff

```typescript
async function retryRemoteCall<T>(
  ref: GenServerRef<any, any, any, T>,
  msg: unknown,
  maxRetries: number = 3,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await GenServer.call(ref, msg, { timeout: 5000 });
    } catch (error) {
      lastError = error as Error;

      if (error instanceof RemoteServerNotRunningError) {
        throw error;  // Don't retry - server is definitely down
      }

      // Exponential backoff: 100ms, 200ms, 400ms, ...
      const delay = 100 * Math.pow(2, attempt);
      console.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
```

### Circuit Breaker Pattern

```typescript
class RemoteCallCircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private readonly threshold: number = 5,
    private readonly resetTimeMs: number = 30000,
  ) {}

  async call<T>(
    ref: GenServerRef<any, any, any, T>,
    msg: unknown,
  ): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetTimeMs) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    try {
      const result = await GenServer.call(ref, msg, { timeout: 5000 });
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'open';
      console.warn('Circuit breaker opened');
    }
  }
}
```

## Exercise: Distributed Task Queue

Build a distributed task queue where:
1. A coordinator node accepts tasks and distributes them to worker nodes
2. Workers register themselves globally when they come online
3. The coordinator load-balances tasks across available workers
4. Failed tasks are automatically reassigned

**Requirements:**

1. Create a `TaskCoordinator` that tracks pending tasks and worker availability
2. Create a `TaskWorker` that processes tasks and reports completion
3. Use `GlobalRegistry` for worker discovery
4. Handle worker failures gracefully (reassign tasks)
5. Track task completion statistics

**Starter code:**

```typescript
import {
  GenServer,
  GenServerBehavior,
  BehaviorRegistry,
  Cluster,
} from '@hamicek/noex';
import { GlobalRegistry, NodeId } from '@hamicek/noex/distribution';

// ============================================================================
// Types
// ============================================================================

interface Task {
  id: string;
  payload: string;
  createdAt: number;
  assignedTo?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

// TODO: Define CoordinatorState
interface CoordinatorState {
  tasks: Map<string, Task>;
  workers: string[];  // Global registry names
  nextTaskId: number;
}

// TODO: Define WorkerState
interface WorkerState {
  name: string;
  currentTask: Task | null;
  completedCount: number;
}

// TODO: Define message types

// ============================================================================
// Coordinator Behavior
// ============================================================================

// TODO: Implement coordinator behavior
// - handleCall: submit, getStatus, getStats
// - handleCast: workerReady, taskCompleted, taskFailed
// - Distribute tasks to available workers

// ============================================================================
// Worker Behavior
// ============================================================================

// TODO: Implement worker behavior
// - Register globally on init
// - Process tasks (simulate with delay)
// - Report completion/failure to coordinator

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const mode = process.argv[2];
  // TODO: Start coordinator or worker based on mode
}

main().catch(console.error);
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
import {
  GenServer,
  GenServerBehavior,
  GenServerRef,
  BehaviorRegistry,
  Cluster,
} from '@hamicek/noex';
import { GlobalRegistry, NodeId } from '@hamicek/noex/distribution';

// ============================================================================
// Types
// ============================================================================

interface Task {
  id: string;
  payload: string;
  createdAt: number;
  assignedTo?: string;
  assignedAt?: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: string;
  error?: string;
}

interface CoordinatorState {
  tasks: Map<string, Task>;
  workers: Set<string>;
  nextTaskId: number;
  stats: {
    submitted: number;
    completed: number;
    failed: number;
  };
}

interface WorkerState {
  name: string;
  coordinatorRef: GenServerRef<any, any, any, any> | null;
  currentTask: Task | null;
  completedCount: number;
  failedCount: number;
}

// Coordinator messages
type CoordinatorCall =
  | { type: 'submit'; payload: string }
  | { type: 'getStatus'; taskId: string }
  | { type: 'getStats' }
  | { type: 'getWorkers' };

type CoordinatorCast =
  | { type: 'workerReady'; workerName: string }
  | { type: 'workerGone'; workerName: string }
  | { type: 'taskCompleted'; taskId: string; result: string; workerName: string }
  | { type: 'taskFailed'; taskId: string; error: string; workerName: string };

// Worker messages
type WorkerCall =
  | { type: 'getStatus' };

type WorkerCast =
  | { type: 'assignTask'; task: Task; coordinatorNodeId: string }
  | { type: 'shutdown' };

// ============================================================================
// Coordinator Behavior
// ============================================================================

const coordinatorBehavior: GenServerBehavior<
  CoordinatorState,
  CoordinatorCall,
  CoordinatorCast,
  any
> = {
  init: () => ({
    tasks: new Map(),
    workers: new Set(),
    nextTaskId: 1,
    stats: { submitted: 0, completed: 0, failed: 0 },
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'submit': {
        const taskId = `task-${state.nextTaskId}`;
        const task: Task = {
          id: taskId,
          payload: msg.payload,
          createdAt: Date.now(),
          status: 'pending',
        };

        const newTasks = new Map(state.tasks);
        newTasks.set(taskId, task);

        const newState: CoordinatorState = {
          ...state,
          tasks: newTasks,
          nextTaskId: state.nextTaskId + 1,
          stats: { ...state.stats, submitted: state.stats.submitted + 1 },
        };

        // Try to assign immediately
        scheduleTaskDistribution();

        return [{ taskId, status: 'pending' }, newState];
      }

      case 'getStatus': {
        const task = state.tasks.get(msg.taskId);
        return [task ?? null, state];
      }

      case 'getStats': {
        return [{
          ...state.stats,
          pending: Array.from(state.tasks.values()).filter(t => t.status === 'pending').length,
          processing: Array.from(state.tasks.values()).filter(t => t.status === 'processing').length,
          workerCount: state.workers.size,
        }, state];
      }

      case 'getWorkers': {
        return [Array.from(state.workers), state];
      }
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'workerReady': {
        const newWorkers = new Set(state.workers);
        newWorkers.add(msg.workerName);
        console.log(`[Coordinator] Worker ready: ${msg.workerName}`);

        // Try to distribute pending tasks
        scheduleTaskDistribution();

        return { ...state, workers: newWorkers };
      }

      case 'workerGone': {
        const newWorkers = new Set(state.workers);
        newWorkers.delete(msg.workerName);
        console.log(`[Coordinator] Worker gone: ${msg.workerName}`);

        // Reassign tasks from this worker
        const newTasks = new Map(state.tasks);
        for (const [id, task] of newTasks) {
          if (task.assignedTo === msg.workerName && task.status === 'processing') {
            newTasks.set(id, { ...task, status: 'pending', assignedTo: undefined });
            console.log(`[Coordinator] Reassigning task ${id}`);
          }
        }

        scheduleTaskDistribution();
        return { ...state, workers: newWorkers, tasks: newTasks };
      }

      case 'taskCompleted': {
        const task = state.tasks.get(msg.taskId);
        if (!task) return state;

        const newTasks = new Map(state.tasks);
        newTasks.set(msg.taskId, {
          ...task,
          status: 'completed',
          result: msg.result,
        });

        console.log(`[Coordinator] Task ${msg.taskId} completed by ${msg.workerName}`);

        return {
          ...state,
          tasks: newTasks,
          stats: { ...state.stats, completed: state.stats.completed + 1 },
        };
      }

      case 'taskFailed': {
        const task = state.tasks.get(msg.taskId);
        if (!task) return state;

        const newTasks = new Map(state.tasks);
        // Mark as pending for retry
        newTasks.set(msg.taskId, {
          ...task,
          status: 'pending',
          assignedTo: undefined,
          error: msg.error,
        });

        console.log(`[Coordinator] Task ${msg.taskId} failed, will retry`);
        scheduleTaskDistribution();

        return {
          ...state,
          tasks: newTasks,
          stats: { ...state.stats, failed: state.stats.failed + 1 },
        };
      }
    }
  },
};

// Global coordinator ref for distribution
let coordinatorRef: GenServerRef<CoordinatorState, CoordinatorCall, CoordinatorCast, any> | null = null;

function scheduleTaskDistribution(): void {
  // Defer to avoid recursion
  setTimeout(() => distributeTask().catch(console.error), 10);
}

async function distributeTask(): Promise<void> {
  if (!coordinatorRef) return;

  const workers = await GenServer.call(coordinatorRef, { type: 'getWorkers' }) as string[];
  if (workers.length === 0) return;

  const stats = await GenServer.call(coordinatorRef, { type: 'getStats' }) as any;
  if (stats.pending === 0) return;

  // Find a pending task
  // In a real implementation, we'd track which workers are busy
  const workerName = workers[Math.floor(Math.random() * workers.length)];
  const workerRef = GlobalRegistry.whereis(workerName);
  if (!workerRef) return;

  // This is simplified - real impl would select specific task
  console.log(`[Coordinator] Would assign to ${workerName}`);
}

// ============================================================================
// Worker Behavior
// ============================================================================

const workerBehavior: GenServerBehavior<WorkerState, WorkerCall, WorkerCast, any> = {
  init: (args) => {
    const state: WorkerState = {
      name: args?.name ?? `worker-${Date.now()}`,
      coordinatorRef: null,
      currentTask: null,
      completedCount: 0,
      failedCount: 0,
    };

    // Register globally
    setTimeout(async () => {
      const ref = GlobalRegistry.whereis('task-coordinator');
      if (ref) {
        GenServer.cast(ref as any, { type: 'workerReady', workerName: state.name });
      }
    }, 100);

    return state;
  },

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'getStatus':
        return [{
          name: state.name,
          busy: state.currentTask !== null,
          completedCount: state.completedCount,
          failedCount: state.failedCount,
        }, state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'assignTask': {
        console.log(`[${state.name}] Received task: ${msg.task.id}`);

        // Simulate processing
        setTimeout(async () => {
          const success = Math.random() > 0.2;  // 80% success rate

          const coordRef = GlobalRegistry.whereis('task-coordinator');
          if (!coordRef) return;

          if (success) {
            GenServer.cast(coordRef as any, {
              type: 'taskCompleted',
              taskId: msg.task.id,
              result: `Processed: ${msg.task.payload}`,
              workerName: state.name,
            });
          } else {
            GenServer.cast(coordRef as any, {
              type: 'taskFailed',
              taskId: msg.task.id,
              error: 'Random failure',
              workerName: state.name,
            });
          }
        }, 1000 + Math.random() * 2000);

        return {
          ...state,
          currentTask: msg.task,
        };
      }

      case 'shutdown':
        return state;  // Would trigger terminate
    }
  },

  terminate: async (_reason, state) => {
    // Notify coordinator we're leaving
    const ref = GlobalRegistry.whereis('task-coordinator');
    if (ref) {
      GenServer.cast(ref as any, { type: 'workerGone', workerName: state.name });
    }
    await GlobalRegistry.unregister(state.name);
  },
};

// ============================================================================
// Main
// ============================================================================

async function startCoordinator(): Promise<void> {
  BehaviorRegistry.register('task-coordinator', coordinatorBehavior);
  BehaviorRegistry.register('task-worker', workerBehavior);

  await Cluster.start({
    nodeName: 'coordinator',
    port: 4369,
    seeds: [],
  });

  console.log('Coordinator starting...');

  coordinatorRef = await GenServer.start(coordinatorBehavior);
  await GlobalRegistry.register('task-coordinator', coordinatorRef);

  console.log('Task Coordinator ready');

  // Listen for node events
  Cluster.onNodeDown((nodeId, reason) => {
    console.log(`Node left: ${nodeId} (${reason})`);
    // Workers will be cleaned up via GlobalRegistry sync
  });

  // Submit test tasks
  setInterval(async () => {
    if (!coordinatorRef) return;
    const result = await GenServer.call(coordinatorRef, {
      type: 'submit',
      payload: `Task at ${Date.now()}`,
    });
    console.log(`Submitted: ${result.taskId}`);
  }, 3000);

  // Print stats
  setInterval(async () => {
    if (!coordinatorRef) return;
    const stats = await GenServer.call(coordinatorRef, { type: 'getStats' });
    console.log(`Stats: ${JSON.stringify(stats)}`);
  }, 5000);

  process.on('SIGINT', async () => {
    console.log('\nShutting down coordinator...');
    await GlobalRegistry.unregister('task-coordinator');
    await Cluster.stop();
    process.exit(0);
  });
}

async function startWorker(name: string, seedHost: string): Promise<void> {
  BehaviorRegistry.register('task-coordinator', coordinatorBehavior);
  BehaviorRegistry.register('task-worker', workerBehavior);

  await Cluster.start({
    nodeName: name,
    port: 4370 + Math.floor(Math.random() * 100),
    seeds: [`coordinator@${seedHost}:4369`],
  });

  console.log(`Worker ${name} starting...`);

  // Wait for cluster sync
  await new Promise(resolve => setTimeout(resolve, 1000));

  const workerRef = await GenServer.start(workerBehavior, { name });
  await GlobalRegistry.register(name, workerRef);

  // Notify coordinator
  const coordRef = GlobalRegistry.whereis('task-coordinator');
  if (coordRef) {
    GenServer.cast(coordRef as any, { type: 'workerReady', workerName: name });
    console.log(`Worker ${name} registered with coordinator`);
  }

  // Print status
  setInterval(async () => {
    const status = await GenServer.call(workerRef, { type: 'getStatus' });
    console.log(`[${name}] Status: completed=${status.completedCount}, failed=${status.failedCount}`);
  }, 10000);

  process.on('SIGINT', async () => {
    console.log(`\nShutting down worker ${name}...`);
    await GlobalRegistry.unregister(name);
    await Cluster.stop();
    process.exit(0);
  });
}

// Parse args and run
const mode = process.argv[2];
if (mode === 'coordinator') {
  startCoordinator().catch(console.error);
} else if (mode === 'worker') {
  const name = process.argv[3] || `worker-${Date.now()}`;
  const seedHost = process.argv[4] || 'localhost';
  startWorker(name, seedHost).catch(console.error);
} else {
  console.log('Usage:');
  console.log('  npx tsx task-queue.ts coordinator');
  console.log('  npx tsx task-queue.ts worker <name> [seed-host]');
}
```

**Running the solution:**

```bash
# Terminal 1: Start coordinator
npx tsx task-queue.ts coordinator

# Terminal 2: Start worker 1
npx tsx task-queue.ts worker worker-1 localhost

# Terminal 3: Start worker 2
npx tsx task-queue.ts worker worker-2 localhost
```

</details>

## Summary

**Key takeaways:**

- **BehaviorRegistry** must register behaviors on ALL nodes before remote spawning
- **GenServer.startRemote()** spawns processes on any node in the cluster
- **Transparent routing** makes local and remote calls look identical
- **GlobalRegistry** provides cluster-wide process discovery by name
- Remote calls can fail — handle `NodeNotReachableError`, `RemoteCallTimeoutError`, `RemoteServerNotRunningError`

**Remote Calls API at a glance:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       REMOTE CALLS API OVERVIEW                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BEHAVIOR REGISTRY (pre-register behaviors)                                 │
│  ─────────────────────────────────────────────────────────────────────────  │
│  BehaviorRegistry.register(name, behavior)  → Register for remote spawn     │
│  BehaviorRegistry.get(name)                 → Get registered behavior       │
│                                                                             │
│  REMOTE SPAWN                                                               │
│  ─────────────────────────────────────────────────────────────────────────  │
│  GenServer.startRemote(behaviorName, opts)  → Spawn on target node          │
│    opts.targetNode       - Target node (required)                           │
│    opts.name             - Process name                                     │
│    opts.registration     - 'local' | 'global' | 'none'                      │
│    opts.spawnTimeout     - Spawn timeout (ms)                               │
│                                                                             │
│  TRANSPARENT ROUTING (same API for local/remote)                            │
│  ─────────────────────────────────────────────────────────────────────────  │
│  GenServer.call(ref, msg, opts)    → Synchronous call (returns reply)       │
│  GenServer.cast(ref, msg)          → Asynchronous cast (fire-and-forget)    │
│                                                                             │
│  GLOBAL REGISTRY (cluster-wide discovery)                                   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  GlobalRegistry.register(name, ref)     → Register globally                 │
│  GlobalRegistry.unregister(name)        → Remove registration               │
│  GlobalRegistry.lookup(name)            → Get ref (throws if not found)     │
│  GlobalRegistry.whereis(name)           → Get ref (undefined if not found)  │
│  GlobalRegistry.isRegistered(name)      → Check if registered               │
│  GlobalRegistry.getNames()              → List all names                    │
│  GlobalRegistry.count()                 → Count registrations               │
│                                                                             │
│  ERROR HANDLING                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  NodeNotReachableError        → Target node not connected                   │
│  RemoteCallTimeoutError       → Call timed out                              │
│  RemoteServerNotRunningError  → GenServer not running on target             │
│  GlobalNameNotFoundError      → Name not in GlobalRegistry                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Registration modes comparison:**

| Mode | Scope | Use case |
|------|-------|----------|
| `'none'` | Only via ref | Temporary processes, internal services |
| `'local'` | Same node only | Node-specific singleton services |
| `'global'` | Entire cluster | Shared services, distributed coordination |

**Remember:**

> Remote calls in noex are designed to be transparent — write your code once, and it works whether processes are local or across the network. Use GlobalRegistry to build discoverable services, and always handle network errors gracefully.

---

Next: [Distributed Supervisor](./03-distributed-supervisor.md)
