# Clustering Basics

In previous chapters, you learned how to build robust applications on a single machine with GenServers, Supervisors, and monitoring. Now it's time to scale beyond a single process — **noex clustering** enables your processes to communicate across multiple machines, forming a distributed system with automatic node discovery and failure detection.

## What You'll Learn

- Understand the difference between noex clustering and Node.js cluster module
- Create and validate node identities using the NodeId format
- Configure seed-based cluster discovery
- Understand the heartbeat mechanism for failure detection
- Handle node lifecycle events (up/down)
- Secure cluster communication with shared secrets
- Build a multi-node application from scratch

## What is noex Clustering?

Before diving in, let's clarify what noex clustering is — and what it isn't.

**Node.js cluster module:**
- Master-worker pattern within a single process
- Workers share the same codebase and port
- Limited to one machine
- Designed for CPU utilization

**noex clustering:**
- Peer-to-peer, full-mesh network topology
- Each node is independent and equal
- Spans multiple machines across networks
- Designed for fault tolerance and distribution
- Inspired by Erlang/OTP distribution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     NODE.JS CLUSTER vs NOEX CLUSTER                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Node.js cluster module          │  noex Cluster                           │
│  ─────────────────────────────   │  ───────────────────────────────────    │
│                                  │                                          │
│      ┌────────────┐              │      ┌────────┐     ┌────────┐          │
│      │   Master   │              │      │ Node A │◄───►│ Node B │          │
│      └─────┬──────┘              │      └────┬───┘     └───┬────┘          │
│       ┌────┼────┐                │           │             │               │
│       ▼    ▼    ▼                │           └──────┬──────┘               │
│    ┌───┐ ┌───┐ ┌───┐             │                  ▼                      │
│    │ W │ │ W │ │ W │             │             ┌────────┐                  │
│    └───┘ └───┘ └───┘             │             │ Node C │                  │
│    Workers (same machine)        │             └────────┘                  │
│                                  │      Full mesh (any network)            │
│                                  │                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

In a noex cluster, processes on any node can communicate with processes on any other node transparently. The cluster handles:

- **Discovery**: Finding other nodes automatically
- **Heartbeats**: Detecting when nodes fail
- **Reconnection**: Automatic recovery from network issues
- **Routing**: Delivering messages to the correct node

## Node Identity (NodeId)

Every node in a cluster needs a unique identity. noex uses a format inspired by Erlang: `name@host:port`.

```typescript
import { Cluster, NodeId } from '@hamicek/noex/distribution';

// NodeId format: name@host:port
// Examples:
//   app1@192.168.1.10:4369
//   worker-1@localhost:4370
//   api-server@api.example.com:4369
//   cluster-node@[::1]:4369  (IPv6)
```

### NodeId Validation Rules

The NodeId has strict validation rules to ensure consistency across the cluster:

| Component | Rules |
|-----------|-------|
| **name** | Start with letter, alphanumeric/underscore/hyphen only, max 64 chars |
| **host** | Valid IPv4, IPv6 (in brackets), or hostname |
| **port** | Integer between 1 and 65535 |

```typescript
// Valid NodeIds
NodeId.isValid('app1@192.168.1.1:4369');      // true
NodeId.isValid('worker-1@localhost:4370');    // true
NodeId.isValid('node_2@[::1]:4369');          // true (IPv6)

// Invalid NodeIds
NodeId.isValid('1app@host:4369');             // false - name starts with number
NodeId.isValid('app@host:99999');             // false - port out of range
NodeId.isValid('');                           // false - empty string
```

### Working with NodeIds

The `NodeId` utility module provides functions for parsing and manipulating node identities:

```typescript
import { NodeId } from '@hamicek/noex/distribution';

// Create a NodeId
const nodeId = NodeId.create('app1', '192.168.1.10', 4369);
// Result: 'app1@192.168.1.10:4369'

// Parse an existing NodeId string
const parsed = NodeId.parse('worker-1@localhost:4370');
// Returns the branded NodeId type

// Safe parsing (returns undefined instead of throwing)
const maybeNodeId = NodeId.tryParse(userInput);
if (maybeNodeId) {
  console.log('Valid NodeId:', maybeNodeId);
}

// Extract components
const name = NodeId.getName(nodeId);      // 'app1'
const host = NodeId.getHost(nodeId);      // '192.168.1.10'
const port = NodeId.getPort(nodeId);      // 4369

// Get all components at once
const { name, host, port } = NodeId.components(nodeId);

// Compare NodeIds
if (NodeId.equals(nodeId1, nodeId2)) {
  console.log('Same node');
}
```

## Starting a Cluster

To form a cluster, you start the `Cluster` singleton with configuration:

```typescript
import { Cluster } from '@hamicek/noex/distribution';

await Cluster.start({
  nodeName: 'app1',              // Required: unique name for this node
  host: '0.0.0.0',              // Listen on all interfaces (default)
  port: 4369,                   // Default port (Erlang EPMD port)
  seeds: [],                    // No seeds = first node in cluster
});

console.log(`Cluster started: ${Cluster.getLocalNodeId()}`);
// Output: Cluster started: app1@0.0.0.0:4369
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `nodeName` | `string` | required | Unique name for this node |
| `host` | `string` | `'0.0.0.0'` | Host to bind to |
| `port` | `number` | `4369` | Port to listen on |
| `seeds` | `string[]` | `[]` | Seed nodes to connect to |
| `clusterSecret` | `string` | `undefined` | Shared secret for HMAC authentication |
| `heartbeatIntervalMs` | `number` | `5000` | Heartbeat frequency |
| `heartbeatMissThreshold` | `number` | `3` | Missed heartbeats before node down |

### Cluster Status

The cluster goes through several states during its lifecycle:

```typescript
const status = Cluster.getStatus();
// 'starting' | 'running' | 'stopping' | 'stopped'
```

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CLUSTER LIFECYCLE                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                    Cluster.start()                                          │
│                          │                                                  │
│                          ▼                                                  │
│                    ┌──────────┐                                             │
│                    │ starting │                                             │
│                    └────┬─────┘                                             │
│                         │ TCP listener ready                                │
│                         │ Heartbeat timer started                           │
│                         │ Connect to seeds                                  │
│                         ▼                                                   │
│                    ┌──────────┐                                             │
│                    │ running  │◄─────────────────────┐                      │
│                    └────┬─────┘                      │                      │
│                         │                            │                      │
│        Cluster.stop()   │     (normal operation)    │                      │
│                         ▼                            │                      │
│                    ┌──────────┐                      │                      │
│                    │ stopping │                      │                      │
│                    └────┬─────┘                      │                      │
│                         │ Notify peers (graceful)   │                      │
│                         │ Close connections         │                      │
│                         │ Stop heartbeat timer      │                      │
│                         ▼                            │                      │
│                    ┌──────────┐                      │                      │
│                    │ stopped  │──────────────────────┘                      │
│                    └──────────┘       Cluster.start() again                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Seed Nodes and Discovery

Seed nodes are the entry points for joining an existing cluster. When a new node starts, it connects to its configured seeds, which share their knowledge of other nodes.

### How Discovery Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SEED-BASED DISCOVERY                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. BOOTSTRAP: First node starts without seeds                              │
│     ┌────────┐                                                              │
│     │ Node A │  seeds: []                                                   │
│     └────────┘                                                              │
│                                                                             │
│  2. JOIN: Second node connects to seed                                      │
│     ┌────────┐         ┌────────┐                                           │
│     │ Node A │◄───────►│ Node B │  seeds: ['A@host:port']                   │
│     └────────┘         └────────┘                                           │
│                                                                             │
│  3. GOSSIP: Nodes share membership via heartbeats                           │
│     ┌────────┐         ┌────────┐                                           │
│     │ Node A │◄───────►│ Node B │                                           │
│     └────┬───┘         └───┬────┘                                           │
│          │    heartbeat    │                                                │
│          │  (knownNodes:   │                                                │
│          │   [A, B, C])    │                                                │
│          └────────┬────────┘                                                │
│                   ▼                                                         │
│              ┌────────┐                                                     │
│              │ Node C │  seeds: ['B@host:port']                             │
│              └────────┘                                                     │
│                                                                             │
│  4. FULL MESH: All nodes eventually know all other nodes                    │
│     ┌────────┐         ┌────────┐                                           │
│     │ Node A │◄───────►│ Node B │                                           │
│     └────┬───┘         └───┬────┘                                           │
│          │                 │                                                │
│          └────────┬────────┘                                                │
│                   ▼                                                         │
│              ┌────────┐                                                     │
│              │ Node C │                                                     │
│              └────────┘                                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Configuring Seeds

Seeds are specified as NodeId strings:

```typescript
// Node 1: First node (seed node)
await Cluster.start({
  nodeName: 'seed1',
  port: 4369,
  seeds: [],  // No seeds - this is the first node
});

// Node 2: Joins via seed1
await Cluster.start({
  nodeName: 'worker1',
  port: 4370,
  seeds: ['seed1@192.168.1.10:4369'],
});

// Node 3: Can join via any existing node
await Cluster.start({
  nodeName: 'worker2',
  port: 4371,
  seeds: ['worker1@192.168.1.11:4370'],  // Doesn't need to know seed1
});
```

### Seed Node Best Practices

1. **Multiple seeds for redundancy**: If one seed is down, new nodes can join via others
2. **Seeds don't need to be special**: Any node can be a seed
3. **Not all nodes need seeds**: Gossip protocol discovers nodes automatically
4. **Seeds are only for initial connection**: Once connected, nodes discover others via heartbeats

```typescript
// Production configuration with multiple seeds
await Cluster.start({
  nodeName: 'api-server-3',
  port: 4369,
  seeds: [
    'api-server-1@10.0.1.10:4369',
    'api-server-2@10.0.1.11:4369',
  ],
});
```

## Heartbeat Mechanism

Heartbeats are the pulse of the cluster — periodic messages that prove a node is alive and share membership information.

### How Heartbeats Work

```typescript
interface HeartbeatMessage {
  type: 'heartbeat';
  nodeInfo: NodeInfo;      // Sender's current state
  knownNodes: NodeId[];    // Gossip: list of nodes we know about
}
```

Each heartbeat carries:
- **nodeInfo**: The sender's current status (id, host, port, process count, uptime)
- **knownNodes**: All nodes the sender knows about (gossip protocol)

### Failure Detection

The cluster detects node failures through heartbeat timeouts:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         HEARTBEAT FAILURE DETECTION                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  heartbeatIntervalMs = 5000ms (default)                                     │
│  heartbeatMissThreshold = 3 (default)                                       │
│  failureTimeout = 5000 × 3 = 15000ms                                        │
│                                                                             │
│  Node A sending heartbeats to Node B:                                       │
│                                                                             │
│  Time:   0s        5s        10s       15s       20s                        │
│          │         │         │         │         │                          │
│          ▼         ▼         ▼         ▼         ▼                          │
│         [HB]─────►[HB]─────►[HB]─────►[HB]─────►[HB]                        │
│                                                                             │
│  Scenario 1: Normal operation                                               │
│  Node B receives heartbeats → resets timeout → Node A is "connected"        │
│                                                                             │
│  Scenario 2: Node A crashes at 7s                                           │
│                                                                             │
│  Time:   0s        5s        10s       15s       20s       22s              │
│          │         │         │         │         │         │                │
│          ▼         ▼         ▼         ▼         ▼         ▼                │
│         [HB]─────►[HB]       ✗         ✗         ✗      [TIMEOUT]           │
│                    │         │         │         │         │                │
│                    │         │ miss 1  │ miss 2  │ miss 3  │                │
│                    └─────────┴─────────┴─────────┴─────────┘                │
│                                                                             │
│  After 3 missed heartbeats (15s from last HB):                              │
│  → NodeDown event emitted with reason 'heartbeat_timeout'                   │
│  → Node A marked as 'disconnected'                                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Configuring Heartbeat Timing

Adjust heartbeat settings based on your network and requirements:

```typescript
// Fast failure detection (for low-latency networks)
await Cluster.start({
  nodeName: 'realtime-node',
  port: 4369,
  heartbeatIntervalMs: 1000,     // 1 second
  heartbeatMissThreshold: 2,     // Down after 2 seconds
});

// Tolerant to network issues (for unreliable networks)
await Cluster.start({
  nodeName: 'remote-node',
  port: 4369,
  heartbeatIntervalMs: 10000,    // 10 seconds
  heartbeatMissThreshold: 5,     // Down after 50 seconds
});
```

| Setting | Low Latency | Balanced (Default) | High Tolerance |
|---------|-------------|-------------------|----------------|
| `heartbeatIntervalMs` | 1000 | 5000 | 10000 |
| `heartbeatMissThreshold` | 2 | 3 | 5 |
| Failure detection | 2s | 15s | 50s |
| Network overhead | Higher | Medium | Lower |

## Node Lifecycle Events

The cluster emits events when nodes join or leave:

```typescript
import { Cluster, type NodeInfo, type NodeId, type NodeDownReason } from '@hamicek/noex/distribution';

// Node joined the cluster
const unsubUp = Cluster.onNodeUp((node: NodeInfo) => {
  console.log(`Node joined: ${node.id}`);
  console.log(`  Host: ${node.host}:${node.port}`);
  console.log(`  Processes: ${node.processCount}`);
  console.log(`  Uptime: ${node.uptimeMs}ms`);
});

// Node left the cluster
const unsubDown = Cluster.onNodeDown((nodeId: NodeId, reason: NodeDownReason) => {
  console.log(`Node left: ${nodeId}`);
  console.log(`  Reason: ${reason}`);

  switch (reason) {
    case 'heartbeat_timeout':
      console.log('  Node stopped responding (crash or network issue)');
      break;
    case 'connection_closed':
      console.log('  TCP connection was closed');
      break;
    case 'connection_refused':
      console.log('  Could not connect to node');
      break;
    case 'graceful_shutdown':
      console.log('  Node shut down gracefully');
      break;
  }
});

// Cluster status changed
const unsubStatus = Cluster.onStatusChange((status) => {
  console.log(`Cluster status: ${status}`);
});

// Clean up when done
unsubUp();
unsubDown();
unsubStatus();
```

### NodeDownReason Types

| Reason | Description | Typical Cause |
|--------|-------------|---------------|
| `heartbeat_timeout` | No heartbeat for N×interval | Process crash, network partition |
| `connection_closed` | TCP connection terminated | Graceful shutdown in progress |
| `connection_refused` | Cannot establish connection | Node not started, firewall |
| `graceful_shutdown` | Node called Cluster.stop() | Planned shutdown |

## Querying Cluster State

Query the current state of the cluster at any time:

```typescript
// Get local node info
const localId = Cluster.getLocalNodeId();
const localInfo = Cluster.getLocalNodeInfo();

console.log(`Local node: ${localId}`);
console.log(`  Status: ${localInfo.status}`);
console.log(`  Uptime: ${localInfo.uptimeMs}ms`);

// Get all known nodes (including disconnected)
const allNodes = Cluster.getNodes();
console.log(`Known nodes: ${allNodes.length}`);

// Get only connected nodes
const connectedNodes = Cluster.getConnectedNodes();
console.log(`Connected nodes: ${connectedNodes.length}`);

// Check specific node
const nodeId = NodeId.parse('worker1@192.168.1.11:4370');
if (Cluster.isNodeConnected(nodeId)) {
  const nodeInfo = Cluster.getNode(nodeId);
  console.log(`Worker1 processes: ${nodeInfo?.processCount}`);
}

// Quick count
const count = Cluster.getConnectedNodeCount();
console.log(`${count} nodes online`);

// Uptime of local cluster
const uptime = Cluster.getUptimeMs();
console.log(`Cluster running for ${uptime}ms`);
```

### NodeInfo Structure

```typescript
interface NodeInfo {
  readonly id: NodeId;           // Node identifier
  readonly host: string;         // Host address
  readonly port: number;         // Port number
  readonly status: 'connecting' | 'connected' | 'disconnected';
  readonly processCount: number; // Number of processes on node
  readonly lastHeartbeatAt: number;  // Unix timestamp of last heartbeat
  readonly uptimeMs: number;     // Node's reported uptime
}
```

## Cluster Security

By default, cluster communication is unencrypted and unauthenticated. For production, you should:

### 1. Use a Cluster Secret

The `clusterSecret` option enables HMAC-SHA256 authentication on all messages:

```typescript
// All nodes must use the same secret
await Cluster.start({
  nodeName: 'secure-node',
  port: 4369,
  clusterSecret: process.env.CLUSTER_SECRET,  // e.g., 'my-super-secret-key'
});
```

When enabled:
- All messages are signed with HMAC-SHA256
- Messages with invalid signatures are rejected
- Nodes without the secret cannot join

### 2. Network Isolation

Recommended network security practices:

```typescript
// Bind to private interface only
await Cluster.start({
  nodeName: 'internal-node',
  host: '10.0.0.5',  // Private IP, not 0.0.0.0
  port: 4369,
  clusterSecret: process.env.CLUSTER_SECRET,
});
```

- **Private VLAN**: Run cluster traffic on isolated network
- **Firewall**: Only allow port 4369 from known cluster IPs
- **VPN**: Use VPN for cross-datacenter communication

### Security Configuration Example

```typescript
import { Cluster } from '@hamicek/noex/distribution';

// Production security configuration
await Cluster.start({
  nodeName: process.env.NODE_NAME!,
  host: process.env.CLUSTER_HOST || '10.0.0.5',
  port: parseInt(process.env.CLUSTER_PORT || '4369'),
  seeds: process.env.CLUSTER_SEEDS?.split(',') || [],
  clusterSecret: process.env.CLUSTER_SECRET,
  heartbeatIntervalMs: 5000,
  heartbeatMissThreshold: 3,
});

// Verify cluster secret is set in production
if (process.env.NODE_ENV === 'production' && !process.env.CLUSTER_SECRET) {
  console.warn('WARNING: Running in production without CLUSTER_SECRET!');
}
```

## Stopping the Cluster

Graceful shutdown notifies other nodes before disconnecting:

```typescript
// Graceful shutdown
await Cluster.stop();
// Other nodes receive 'graceful_shutdown' reason

// Check if already stopped
if (Cluster.getStatus() !== 'stopped') {
  await Cluster.stop();
}
```

During graceful shutdown:
1. Status changes to `'stopping'`
2. Notifies all connected nodes
3. Closes TCP connections
4. Stops heartbeat timer
5. Status changes to `'stopped'`

## Practical Example: Three-Node Cluster

Let's build a complete example with three nodes that discover each other:

```typescript
// cluster-node.ts
import { Cluster, NodeId, type NodeInfo } from '@hamicek/noex/distribution';

interface NodeConfig {
  name: string;
  port: number;
  seeds: string[];
}

async function startNode(config: NodeConfig): Promise<void> {
  console.log(`Starting node: ${config.name}`);

  // Set up event handlers before starting
  Cluster.onNodeUp((node: NodeInfo) => {
    console.log(`[${config.name}] Node joined: ${node.id}`);
  });

  Cluster.onNodeDown((nodeId, reason) => {
    console.log(`[${config.name}] Node left: ${nodeId} (${reason})`);
  });

  Cluster.onStatusChange((status) => {
    console.log(`[${config.name}] Cluster status: ${status}`);
  });

  // Start the cluster
  await Cluster.start({
    nodeName: config.name,
    port: config.port,
    seeds: config.seeds,
    heartbeatIntervalMs: 2000,  // Fast for demo
    heartbeatMissThreshold: 2,
  });

  console.log(`[${config.name}] Started as ${Cluster.getLocalNodeId()}`);

  // Periodic status report
  setInterval(() => {
    const connected = Cluster.getConnectedNodes();
    console.log(`[${config.name}] Connected to ${connected.length} nodes:`);
    for (const node of connected) {
      console.log(`  - ${node.id} (${node.processCount} processes)`);
    }
  }, 10000);
}

// Parse command line args
const args = process.argv.slice(2);
const name = args[0] || 'node1';
const port = parseInt(args[1] || '4369');
const seeds = args.slice(2);

startNode({ name, port, seeds }).catch(console.error);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await Cluster.stop();
  process.exit(0);
});
```

Run in three terminals:

```bash
# Terminal 1: Seed node
npx tsx cluster-node.ts seed1 4369

# Terminal 2: Joins via seed1
npx tsx cluster-node.ts worker1 4370 seed1@localhost:4369

# Terminal 3: Joins via worker1 (discovers seed1 via gossip)
npx tsx cluster-node.ts worker2 4371 worker1@localhost:4370
```

Expected output sequence:

```
# Terminal 1 (seed1)
Starting node: seed1
[seed1] Cluster status: starting
[seed1] Cluster status: running
[seed1] Started as seed1@0.0.0.0:4369
[seed1] Node joined: worker1@0.0.0.0:4370
[seed1] Node joined: worker2@0.0.0.0:4371
[seed1] Connected to 2 nodes:
  - worker1@0.0.0.0:4370 (0 processes)
  - worker2@0.0.0.0:4371 (0 processes)

# Terminal 2 (worker1)
Starting node: worker1
[worker1] Cluster status: starting
[worker1] Cluster status: running
[worker1] Started as worker1@0.0.0.0:4370
[worker1] Node joined: seed1@0.0.0.0:4369
[worker1] Node joined: worker2@0.0.0.0:4371

# Terminal 3 (worker2)
Starting node: worker2
[worker2] Cluster status: starting
[worker2] Cluster status: running
[worker2] Started as worker2@0.0.0.0:4371
[worker2] Node joined: worker1@0.0.0.0:4370
[worker2] Node joined: seed1@0.0.0.0:4369  # Discovered via gossip!
```

## Error Handling

The cluster throws specific errors for configuration and runtime issues:

```typescript
import {
  Cluster,
  ClusterNotStartedError,
  InvalidClusterConfigError,
} from '@hamicek/noex/distribution';

// Configuration errors
try {
  await Cluster.start({
    nodeName: '123invalid',  // Invalid: starts with number
    port: 99999,             // Invalid: port out of range
  });
} catch (error) {
  if (error instanceof InvalidClusterConfigError) {
    console.error('Bad config:', error.message);
  }
}

// Runtime errors
try {
  const nodes = Cluster.getNodes();  // Called before start()
} catch (error) {
  if (error instanceof ClusterNotStartedError) {
    console.error('Cluster not started yet');
  }
}

// Safe pattern: check status first
if (Cluster.getStatus() === 'running') {
  const nodes = Cluster.getNodes();
}
```

## Exercise: Cluster Health Monitor

Build a cluster health monitoring system that tracks node availability and reports cluster state.

**Requirements:**

1. Start a cluster node that can join existing clusters
2. Track node join/leave events with timestamps
3. Calculate and display cluster uptime
4. Show node availability history (last 5 events)
5. Report overall cluster health status

**Starter code:**

```typescript
import { Cluster, NodeId, type NodeInfo, type NodeDownReason } from '@hamicek/noex/distribution';

interface NodeEvent {
  timestamp: number;
  nodeId: string;
  event: 'joined' | 'left';
  reason?: NodeDownReason;
}

interface ClusterHealth {
  status: 'healthy' | 'degraded' | 'critical';
  connectedNodes: number;
  totalKnownNodes: number;
  recentEvents: NodeEvent[];
  uptimeMs: number;
}

// TODO: Track events
const eventHistory: NodeEvent[] = [];

// TODO: Subscribe to cluster events
function setupEventTracking(): void {
  // Cluster.onNodeUp(...)
  // Cluster.onNodeDown(...)
}

// TODO: Calculate cluster health
function getClusterHealth(): ClusterHealth {
  // Return health status based on:
  // - Connected vs known nodes ratio
  // - Recent node down events
  // - Cluster uptime
}

// TODO: Display health report
function printHealthReport(): void {
  // Clear console and print formatted report
}

// TODO: Start cluster with command line args
async function main(): Promise<void> {
  const name = process.argv[2] || 'monitor';
  const port = parseInt(process.argv[3] || '4369');
  const seeds = process.argv.slice(4);

  // Start cluster
  // Setup tracking
  // Periodic health reports
}

main().catch(console.error);
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
import { Cluster, NodeId, type NodeInfo, type NodeDownReason } from '@hamicek/noex/distribution';

interface NodeEvent {
  timestamp: number;
  nodeId: string;
  event: 'joined' | 'left';
  reason?: NodeDownReason;
}

interface ClusterHealth {
  status: 'healthy' | 'degraded' | 'critical';
  connectedNodes: number;
  totalKnownNodes: number;
  recentEvents: NodeEvent[];
  uptimeMs: number;
  availabilityPercent: number;
}

// Event history (keep last 100)
const eventHistory: NodeEvent[] = [];
const MAX_EVENTS = 100;

function addEvent(event: NodeEvent): void {
  eventHistory.push(event);
  if (eventHistory.length > MAX_EVENTS) {
    eventHistory.shift();
  }
}

function setupEventTracking(): void {
  Cluster.onNodeUp((node: NodeInfo) => {
    addEvent({
      timestamp: Date.now(),
      nodeId: node.id,
      event: 'joined',
    });
    console.log(`[EVENT] Node joined: ${node.id}`);
  });

  Cluster.onNodeDown((nodeId, reason) => {
    addEvent({
      timestamp: Date.now(),
      nodeId,
      event: 'left',
      reason,
    });
    console.log(`[EVENT] Node left: ${nodeId} (${reason})`);
  });
}

function getClusterHealth(): ClusterHealth {
  const connectedNodes = Cluster.getConnectedNodeCount();
  const allNodes = Cluster.getNodes();
  const totalKnownNodes = allNodes.length;
  const uptimeMs = Cluster.getUptimeMs();

  // Calculate availability (connected / total known)
  const availabilityPercent = totalKnownNodes > 0
    ? Math.round((connectedNodes / totalKnownNodes) * 100)
    : 100;

  // Count recent failures (last 5 minutes)
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  const recentFailures = eventHistory.filter(
    e => e.event === 'left' && e.timestamp > fiveMinutesAgo
  ).length;

  // Determine health status
  let status: 'healthy' | 'degraded' | 'critical';
  if (availabilityPercent >= 80 && recentFailures <= 1) {
    status = 'healthy';
  } else if (availabilityPercent >= 50 && recentFailures <= 3) {
    status = 'degraded';
  } else {
    status = 'critical';
  }

  return {
    status,
    connectedNodes,
    totalKnownNodes,
    recentEvents: eventHistory.slice(-5),
    uptimeMs,
    availabilityPercent,
  };
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function printHealthReport(): void {
  console.clear();

  const health = getClusterHealth();
  const localId = Cluster.getLocalNodeId();

  // Status colors (ANSI)
  const statusColors: Record<string, string> = {
    healthy: '\x1b[32m',   // Green
    degraded: '\x1b[33m',  // Yellow
    critical: '\x1b[31m',  // Red
  };
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';
  const dim = '\x1b[2m';

  console.log(`${bold}═══════════════════════════════════════════════════════════════${reset}`);
  console.log(`${bold}                    CLUSTER HEALTH MONITOR                       ${reset}`);
  console.log(`${bold}═══════════════════════════════════════════════════════════════${reset}`);
  console.log();

  // Local node info
  console.log(`${bold}Local Node${reset}`);
  console.log(`  ID:     ${localId}`);
  console.log(`  Uptime: ${formatUptime(health.uptimeMs)}`);
  console.log();

  // Cluster status
  const statusColor = statusColors[health.status];
  console.log(`${bold}Cluster Status${reset}`);
  console.log(`  Health:       ${statusColor}${health.status.toUpperCase()}${reset}`);
  console.log(`  Availability: ${health.availabilityPercent}%`);
  console.log(`  Connected:    ${health.connectedNodes} / ${health.totalKnownNodes} nodes`);
  console.log();

  // Connected nodes
  const connected = Cluster.getConnectedNodes();
  console.log(`${bold}Connected Nodes${reset}`);
  if (connected.length === 0) {
    console.log(`  ${dim}(none)${reset}`);
  } else {
    for (const node of connected) {
      const uptime = formatUptime(node.uptimeMs);
      console.log(`  - ${node.id}`);
      console.log(`    ${dim}processes: ${node.processCount}, uptime: ${uptime}${reset}`);
    }
  }
  console.log();

  // Recent events
  console.log(`${bold}Recent Events${reset}`);
  if (health.recentEvents.length === 0) {
    console.log(`  ${dim}(no events)${reset}`);
  } else {
    for (const event of health.recentEvents.reverse()) {
      const time = formatTimestamp(event.timestamp);
      const icon = event.event === 'joined' ? '\x1b[32m+\x1b[0m' : '\x1b[31m-\x1b[0m';
      const reason = event.reason ? ` (${event.reason})` : '';
      console.log(`  ${icon} [${time}] ${event.nodeId}${reason}`);
    }
  }
  console.log();

  console.log(`${dim}Last updated: ${new Date().toISOString()} | Press Ctrl+C to exit${reset}`);
}

async function main(): Promise<void> {
  const name = process.argv[2] || 'monitor';
  const port = parseInt(process.argv[3] || '4369');
  const seeds = process.argv.slice(4);

  console.log(`Starting cluster health monitor: ${name}`);
  console.log(`Port: ${port}`);
  console.log(`Seeds: ${seeds.length > 0 ? seeds.join(', ') : '(none)'}`);
  console.log();

  // Setup tracking before starting
  setupEventTracking();

  // Start cluster
  await Cluster.start({
    nodeName: name,
    port,
    seeds,
    heartbeatIntervalMs: 3000,
    heartbeatMissThreshold: 2,
  });

  console.log(`Cluster started as ${Cluster.getLocalNodeId()}`);

  // Initial report after short delay
  setTimeout(printHealthReport, 1000);

  // Periodic health reports
  setInterval(printHealthReport, 5000);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down monitor...');
    await Cluster.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

**Running the solution:**

```bash
# Terminal 1: Start monitor as seed
npx tsx health-monitor.ts monitor1 4369

# Terminal 2: Join the cluster
npx tsx health-monitor.ts monitor2 4370 monitor1@localhost:4369

# Terminal 3: Another node
npx tsx health-monitor.ts monitor3 4371 monitor1@localhost:4369
```

**Sample output:**

```
═══════════════════════════════════════════════════════════════
                    CLUSTER HEALTH MONITOR
═══════════════════════════════════════════════════════════════

Local Node
  ID:     monitor1@0.0.0.0:4369
  Uptime: 2m 15s

Cluster Status
  Health:       HEALTHY
  Availability: 100%
  Connected:    2 / 2 nodes

Connected Nodes
  - monitor2@0.0.0.0:4370
    processes: 0, uptime: 1m 45s
  - monitor3@0.0.0.0:4371
    processes: 0, uptime: 30s

Recent Events
  + [12:00:30] monitor3@0.0.0.0:4371
  + [12:00:00] monitor2@0.0.0.0:4370

Last updated: 2024-01-25T12:02:15.000Z | Press Ctrl+C to exit
```

</details>

## Summary

**Key takeaways:**

- **noex clustering** is peer-to-peer, not master-worker like Node.js cluster
- **NodeId** format is `name@host:port` with strict validation rules
- **Seed nodes** bootstrap cluster discovery; gossip spreads membership
- **Heartbeats** detect node failures (default: 15 seconds timeout)
- **Events** notify you when nodes join (`onNodeUp`) or leave (`onNodeDown`)
- **clusterSecret** enables HMAC authentication for security

**Cluster API at a glance:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLUSTER API OVERVIEW                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  LIFECYCLE                                                                  │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Cluster.start(config)     → Start and join cluster                         │
│  Cluster.stop()            → Graceful shutdown                              │
│  Cluster.getStatus()       → 'starting' | 'running' | 'stopping' | 'stopped'│
│                                                                             │
│  NODE IDENTITY                                                              │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Cluster.getLocalNodeId()      → This node's identifier                     │
│  Cluster.getLocalNodeInfo()    → Full info about this node                  │
│  Cluster.getUptimeMs()         → How long cluster has been running          │
│                                                                             │
│  MEMBERSHIP QUERIES                                                         │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Cluster.getNodes()            → All known nodes (any status)               │
│  Cluster.getConnectedNodes()   → Only connected nodes                       │
│  Cluster.getNode(nodeId)       → Info for specific node                     │
│  Cluster.isNodeConnected(id)   → Check if node is online                    │
│  Cluster.getConnectedNodeCount() → Quick count                              │
│                                                                             │
│  EVENT HANDLERS                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Cluster.onNodeUp(handler)     → Called when node joins                     │
│  Cluster.onNodeDown(handler)   → Called when node leaves                    │
│  Cluster.onStatusChange(handler) → Called on status transitions             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Configuration quick reference:**

| Setting | Default | Description |
|---------|---------|-------------|
| `nodeName` | required | Unique node identifier |
| `host` | `'0.0.0.0'` | Bind address |
| `port` | `4369` | Listen port |
| `seeds` | `[]` | Seed nodes for discovery |
| `clusterSecret` | `undefined` | HMAC authentication secret |
| `heartbeatIntervalMs` | `5000` | Heartbeat frequency |
| `heartbeatMissThreshold` | `3` | Missed heartbeats before down |

**Remember:**

> Clustering is the foundation of distributed noex. Once nodes can discover each other and detect failures, you can build on this to spawn processes remotely, call processes across nodes, and create truly fault-tolerant distributed systems.

---

Next: [Remote Calls](./02-remote-calls.md)
