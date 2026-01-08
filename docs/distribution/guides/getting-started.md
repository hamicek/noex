# Getting Started with Distribution

This guide walks you through building your first distributed noex application: a simple key-value store that runs across two nodes.

## Prerequisites

- Node.js 18+ installed
- noex installed (`npm install noex`)
- Basic understanding of [GenServer](../../concepts/genserver.md)

## What You'll Build

A distributed key-value store where:
- Two nodes form a cluster
- Either node can create, read, and update keys
- Data is accessible from both nodes via GlobalRegistry

```
┌─────────────────┐           ┌─────────────────┐
│     Node A      │◄─────────►│     Node B      │
│   (port 4369)   │           │   (port 4370)   │
├─────────────────┤           ├─────────────────┤
│  KV Store "db"  │           │  (can access    │
│  (registered    │           │   "db" via      │
│   globally)     │           │   GlobalRegistry)│
└─────────────────┘           └─────────────────┘
```

---

## Step 1: Project Setup

Create a new directory and initialize the project:

```bash
mkdir distributed-kv
cd distributed-kv
npm init -y
npm install noex typescript tsx @types/node
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist"
  }
}
```

---

## Step 2: Define the KV Store Behavior

Create `shared/kv-store.ts`:

```typescript
import { type GenServerBehavior, type GenServerRef } from 'noex';

// State: simple key-value map
interface KVState {
  data: Map<string, unknown>;
  name: string;
}

// Synchronous messages (wait for response)
type KVCallMsg =
  | { type: 'get'; key: string }
  | { type: 'has'; key: string }
  | { type: 'keys' }
  | { type: 'size' };

// Asynchronous messages (fire-and-forget)
type KVCastMsg =
  | { type: 'set'; key: string; value: unknown }
  | { type: 'delete'; key: string }
  | { type: 'clear' };

// Reply types
type KVReply = unknown | boolean | string[] | number;

// Reference type for external use
export type KVStoreRef = GenServerRef<KVState, KVCallMsg, KVCastMsg, KVReply>;

// Behavior factory - allows customizing the store name
export function createKVBehavior(name: string): GenServerBehavior<
  KVState,
  KVCallMsg,
  KVCastMsg,
  KVReply
> {
  return {
    init: () => ({
      data: new Map(),
      name,
    }),

    handleCall: (msg, state) => {
      switch (msg.type) {
        case 'get':
          return [state.data.get(msg.key), state];

        case 'has':
          return [state.data.has(msg.key), state];

        case 'keys':
          return [Array.from(state.data.keys()), state];

        case 'size':
          return [state.data.size, state];
      }
    },

    handleCast: (msg, state) => {
      switch (msg.type) {
        case 'set': {
          const newData = new Map(state.data);
          newData.set(msg.key, msg.value);
          return { ...state, data: newData };
        }

        case 'delete': {
          const newData = new Map(state.data);
          newData.delete(msg.key);
          return { ...state, data: newData };
        }

        case 'clear':
          return { ...state, data: new Map() };
      }
    },

    terminate: (reason, state) => {
      console.log(`KV store "${state.name}" terminated: ${reason}`);
    },
  };
}

// Behavior instance for BehaviorRegistry (uses default name)
export const kvBehavior = createKVBehavior('default');
```

---

## Step 3: Create the Node Entry Point

Create `node.ts`:

```typescript
import { GenServer } from 'noex';
import {
  Cluster,
  BehaviorRegistry,
  GlobalRegistry,
  RemoteCall,
  type NodeInfo,
  type NodeDownReason,
  type SerializedRef,
} from 'noex/distribution';
import { createKVBehavior, kvBehavior } from './shared/kv-store.js';

// Parse command-line arguments
interface Args {
  name: string;
  port: number;
  seeds: string[];
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let name = '';
  let port = 4369;
  const seeds: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--name':
      case '-n':
        name = args[++i] ?? '';
        break;
      case '--port':
      case '-p':
        port = parseInt(args[++i] ?? '4369', 10);
        break;
      case '--seed':
      case '-s':
        seeds.push(args[++i] ?? '');
        break;
    }
  }

  if (!name) {
    console.error('Usage: npx tsx node.ts --name <name> --port <port> [--seed <node@host:port>]');
    process.exit(1);
  }

  return { name, port, seeds: seeds.filter(Boolean) };
}

const config = parseArgs();

async function main(): Promise<void> {
  console.log('='.repeat(50));
  console.log('  Distributed Key-Value Store');
  console.log('='.repeat(50));
  console.log();

  // 1. Register behaviors BEFORE starting the cluster
  //    This allows other nodes to spawn this behavior remotely
  BehaviorRegistry.register('kv-store', kvBehavior);

  // 2. Start the cluster
  console.log(`Starting node: ${config.name}@127.0.0.1:${config.port}`);

  await Cluster.start({
    nodeName: config.name,
    port: config.port,
    seeds: config.seeds,
  });

  console.log(`Node ID: ${Cluster.getLocalNodeId()}`);

  // 3. Set up cluster event handlers
  Cluster.onNodeUp((node: NodeInfo) => {
    console.log(`[CLUSTER] Node joined: ${node.id}`);
  });

  Cluster.onNodeDown((nodeId: string, reason: NodeDownReason) => {
    console.log(`[CLUSTER] Node left: ${nodeId} (${reason})`);
  });

  // 4. Create a local KV store and register it globally
  //    Only the first node creates the store; others access it remotely
  const globalName = 'kv:main';

  if (!GlobalRegistry.isRegistered(globalName)) {
    console.log('Creating KV store...');

    const behavior = createKVBehavior('main');
    const ref = await GenServer.start(behavior);

    // Register globally so other nodes can find it
    await GlobalRegistry.register(globalName, {
      id: ref.id,
      nodeId: Cluster.getLocalNodeId(),
    });

    console.log('KV store created and registered globally.');
  } else {
    console.log('KV store already exists in cluster.');
  }

  // 5. Demo: interact with the KV store
  await demonstrateKVStore(globalName);

  // 6. Keep running
  console.log('\nNode is running. Press Ctrl+C to exit.');
}

async function demonstrateKVStore(globalName: string): Promise<void> {
  // Small delay to ensure GlobalRegistry sync
  await new Promise((resolve) => setTimeout(resolve, 500));

  const kvRef = GlobalRegistry.whereis(globalName);
  if (!kvRef) {
    console.log('KV store not found in registry.');
    return;
  }

  console.log(`\nKV store location: ${kvRef.nodeId}`);
  console.log('Demonstrating operations...\n');

  // Set some values
  const nodeId = Cluster.getLocalNodeId();
  const nodeName = nodeId.split('@')[0];

  RemoteCall.cast(kvRef, { type: 'set', key: `greeting-${nodeName}`, value: `Hello from ${nodeName}!` });
  RemoteCall.cast(kvRef, { type: 'set', key: `timestamp-${nodeName}`, value: new Date().toISOString() });

  // Small delay for cast to process
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Read values
  const keys = await RemoteCall.call<string[]>(kvRef, { type: 'keys' });
  console.log('Keys in store:', keys);

  const size = await RemoteCall.call<number>(kvRef, { type: 'size' });
  console.log(`Total entries: ${size}`);

  // Read our greeting
  const greeting = await RemoteCall.call<string>(kvRef, { type: 'get', key: `greeting-${nodeName}` });
  console.log(`Our greeting: ${greeting}`);
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log('\nShutting down...');
  await Cluster.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
```

---

## Step 4: Run the Cluster

Open **two terminal windows**.

**Terminal 1** - Start the first node:

```bash
npx tsx node.ts --name nodeA --port 4369
```

Output:
```
==================================================
  Distributed Key-Value Store
==================================================

Starting node: nodeA@127.0.0.1:4369
Node ID: nodeA@127.0.0.1:4369
Creating KV store...
KV store created and registered globally.

KV store location: nodeA@127.0.0.1:4369
Demonstrating operations...

Keys in store: [ 'greeting-nodeA', 'timestamp-nodeA' ]
Total entries: 2
Our greeting: Hello from nodeA!

Node is running. Press Ctrl+C to exit.
```

**Terminal 2** - Start the second node (connecting to the first):

```bash
npx tsx node.ts --name nodeB --port 4370 --seed nodeA@127.0.0.1:4369
```

Output:
```
==================================================
  Distributed Key-Value Store
==================================================

Starting node: nodeB@127.0.0.1:4370
Node ID: nodeB@127.0.0.1:4370
[CLUSTER] Node joined: nodeA@127.0.0.1:4369
KV store already exists in cluster.

KV store location: nodeA@127.0.0.1:4369
Demonstrating operations...

Keys in store: [ 'greeting-nodeA', 'timestamp-nodeA', 'greeting-nodeB', 'timestamp-nodeB' ]
Total entries: 4
Our greeting: Hello from nodeB!

Node is running. Press Ctrl+C to exit.
```

Notice how:
- Node B discovered Node A through the seed
- Node B found the existing KV store via GlobalRegistry
- Both nodes can read and write to the same store
- The store physically lives on Node A, but Node B accesses it transparently

---

## Step 5: Test Fault Tolerance

Press `Ctrl+C` in Terminal 1 to stop Node A.

Terminal 2 will show:
```
[CLUSTER] Node left: nodeA@127.0.0.1:4369 (graceful_shutdown)
```

The KV store is now unavailable because it lived on Node A. In a production application, you would use:
- **DistributedSupervisor** to automatically restart the store on another node
- **RemoteMonitor** to detect process failures
- Data replication for high availability

---

## Understanding the Code

### BehaviorRegistry

```typescript
BehaviorRegistry.register('kv-store', kvBehavior);
```

Registers a behavior so other nodes can spawn it remotely using `RemoteSpawn.spawn('kv-store', targetNodeId)`.

### Cluster.start()

```typescript
await Cluster.start({
  nodeName: config.name,
  port: config.port,
  seeds: config.seeds,
});
```

Starts the cluster layer:
- Opens a TCP listener on the specified port
- Connects to seed nodes for discovery
- Begins heartbeat broadcasting

### GlobalRegistry

```typescript
// Register a process globally
await GlobalRegistry.register('kv:main', { id: ref.id, nodeId });

// Find a process anywhere in the cluster
const ref = GlobalRegistry.whereis('kv:main');
```

Provides cluster-wide process naming. Names are automatically synchronized across all nodes.

### RemoteCall

```typescript
// Synchronous call (waits for response)
const result = await RemoteCall.call(ref, message);

// Asynchronous cast (fire-and-forget)
RemoteCall.cast(ref, message);
```

Works identically for local and remote processes. The system handles routing and serialization automatically.

---

## Next Steps

Now that you have a basic distributed application running:

1. **[Cluster Formation Guide](./cluster-formation.md)** - Learn about seed discovery, security, and network configuration

2. **[Remote Processes Guide](./remote-processes.md)** - Spawn and manage processes on specific nodes

3. **[Process Monitoring Guide](./process-monitoring.md)** - Detect and handle process failures

4. **[Production Deployment](./production-deployment.md)** - Docker, Kubernetes, and production best practices

## Complete Examples

For more comprehensive examples, see:

- [distributed-chat](../../../examples/distributed-chat/) - Multi-room chat with GlobalRegistry
- [distributed-counter](../../../examples/distributed-counter/) - Fault tolerance with RemoteMonitor
- [distributed-worker-pool](../../../examples/distributed-worker-pool/) - Load balancing with DistributedSupervisor

---

## Common Issues

### "Cluster not started"

Ensure `Cluster.start()` completes before using distribution features:

```typescript
await Cluster.start({ ... });
// Now safe to use GlobalRegistry, RemoteCall, etc.
```

### "Node not reachable"

Check that:
- The target node is running
- Firewall allows the cluster port
- The seed address is correct (including port)

### "Behavior not found"

Register behaviors before `Cluster.start()` or before any remote spawn attempts:

```typescript
BehaviorRegistry.register('my-behavior', myBehavior);
await Cluster.start({ ... });
```

---

## Related

- [Distribution Overview](../concepts/overview.md) - Architecture and design principles
- [Cluster Concepts](../concepts/cluster.md) - Node discovery and membership
- [Remote Messaging](../concepts/remote-messaging.md) - Cross-node communication

---

*[Czech version](../../cs/distribution/guides/getting-started.md)*
