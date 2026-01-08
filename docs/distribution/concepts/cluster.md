# Cluster

The Cluster module is the foundation of noex distribution. It manages node lifecycle, peer discovery, membership tracking, and failure detection through a decentralized P2P architecture.

## Overview

A noex cluster is a group of Node.js processes that can communicate transparently. The Cluster module provides:

- **Seed-based discovery**: Join existing clusters via known seed nodes
- **Gossip protocol**: Automatic discovery of new nodes through membership sharing
- **Heartbeat monitoring**: Detect node failures through periodic health checks
- **Event notifications**: React to topology changes in real-time

```typescript
import { Cluster } from 'noex/distribution';

// Start a cluster node
await Cluster.start({
  nodeName: 'worker1',
  port: 4369,
  seeds: ['coordinator@192.168.1.1:4369'],
});

// React to cluster events
Cluster.onNodeUp((node) => console.log(`${node.id} joined`));
Cluster.onNodeDown((nodeId, reason) => console.log(`${nodeId} left: ${reason}`));

// Query cluster state
const nodes = Cluster.getConnectedNodes();
const localId = Cluster.getLocalNodeId();

// Graceful shutdown
await Cluster.stop();
```

## Cluster Formation

### Seed-Based Discovery

Nodes join the cluster by connecting to one or more seed nodes. Seeds are simply nodes that are already running and can introduce newcomers to the cluster.

```
                    ┌─────────────────┐
                    │   Seed Node A   │
                    │ (already running)│
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
        ┌──────────┐   ┌──────────┐   ┌──────────┐
        │  Node B  │   │  Node C  │   │  Node D  │
        │ (joining)│   │ (joining)│   │ (joining)│
        └──────────┘   └──────────┘   └──────────┘
```

**First node** (no seeds needed):
```typescript
await Cluster.start({
  nodeName: 'seed1',
  port: 4369,
  // No seeds - this is the first node
});
```

**Subsequent nodes** (connect via seeds):
```typescript
await Cluster.start({
  nodeName: 'worker1',
  port: 4370,
  seeds: ['seed1@192.168.1.1:4369'],
});
```

**Multiple seeds** (for redundancy):
```typescript
await Cluster.start({
  nodeName: 'worker2',
  port: 4371,
  seeds: [
    'seed1@192.168.1.1:4369',
    'seed2@192.168.1.2:4369',
  ],
});
```

### Gossip Protocol

Once connected, nodes share membership information through heartbeats. This enables automatic discovery without needing to list all nodes as seeds:

```
Time T0: Node A starts (seed)
         Known: [A]

Time T1: Node B joins via A
         A knows: [A, B]
         B knows: [A, B]

Time T2: Node C joins via B
         B's heartbeat tells C about A
         A knows: [A, B, C]
         B knows: [A, B, C]
         C knows: [A, B, C]
```

Each heartbeat contains `knownNodes` - the sender's view of cluster membership. Recipients connect to any unknown nodes they discover.

## Node Identification

Every node has a unique identifier in the format `name@host:port`:

```typescript
import { NodeId } from 'noex/distribution';

// The local node's ID
const localId = Cluster.getLocalNodeId();
// e.g., "worker1@192.168.1.10:4369"

// Parse a NodeId string
const nodeId = NodeId.parse('worker1@192.168.1.10:4369');

// Create programmatically
const nodeId = NodeId.create('worker1', '192.168.1.10', 4369);

// Validate format
if (NodeId.isValid('worker1@192.168.1.10:4369')) {
  // Valid NodeId
}

// Extract components
const components = NodeId.components('worker1@192.168.1.10:4369');
// { name: 'worker1', host: '192.168.1.10', port: 4369 }
```

### NodeId Rules

| Component | Requirements |
|-----------|-------------|
| `name` | Starts with letter, contains alphanumeric/underscore/hyphen, max 64 chars |
| `host` | Valid IPv4, IPv6 address, or hostname |
| `port` | Integer between 1 and 65535 |

Examples:
- `app1@localhost:4369` - Valid
- `worker-pool-1@192.168.1.100:5000` - Valid
- `1invalid@host:4369` - Invalid (name starts with number)
- `app@host` - Invalid (missing port)

## Membership Tracking

### Node Information

Each node in the cluster is represented by `NodeInfo`:

```typescript
interface NodeInfo {
  id: NodeId;           // Unique identifier
  host: string;         // Host address
  port: number;         // TCP port
  status: NodeStatus;   // 'connecting' | 'connected' | 'disconnected'
  processCount: number; // GenServers on this node
  lastHeartbeatAt: number; // Unix timestamp
  uptimeMs: number;     // Node's reported uptime
}
```

Query membership:

```typescript
// All known nodes (including disconnected)
const allNodes = Cluster.getNodes();

// Only connected nodes
const connected = Cluster.getConnectedNodes();

// Specific node info
const node = Cluster.getNode(nodeId);
if (node?.status === 'connected') {
  console.log(`Node ${node.id} has ${node.processCount} processes`);
}

// Check connection status
if (Cluster.isNodeConnected(nodeId)) {
  // Safe to send messages
}

// Count connected nodes
const count = Cluster.getConnectedNodeCount();
```

### Node Status Transitions

```
                    ┌─────────────────┐
    New connection  │   connecting    │
    ───────────────►│                 │
                    └────────┬────────┘
                             │ Heartbeat received
                             ▼
                    ┌─────────────────┐
                    │    connected    │◄──────────────────┐
                    │                 │                    │
                    └────────┬────────┘     Heartbeat     │
                             │              received       │
           Connection lost   │                            │
           or heartbeat      │                            │
           timeout           ▼                            │
                    ┌─────────────────┐                   │
                    │  disconnected   │───────────────────┘
                    │                 │  Reconnection +
                    └─────────────────┘  heartbeat
```

## Failure Detection

### Heartbeat Mechanism

Nodes exchange heartbeat messages at regular intervals. Missing heartbeats trigger failure detection:

```typescript
await Cluster.start({
  nodeName: 'app1',
  port: 4369,
  heartbeatIntervalMs: 5000,    // Send heartbeat every 5 seconds
  heartbeatMissThreshold: 3,   // Mark down after 3 missed heartbeats
});
```

**Failure detection timing**: `heartbeatIntervalMs * heartbeatMissThreshold`

With defaults (5000ms interval, 3 misses), a node is marked down after 15 seconds of silence.

### Heartbeat Message

Each heartbeat carries:

```typescript
interface HeartbeatMessage {
  type: 'heartbeat';
  nodeInfo: NodeInfo;        // Sender's current info
  knownNodes: NodeId[];      // Membership for gossip
}
```

### Failure Reasons

When a node goes down, the reason is provided:

```typescript
Cluster.onNodeDown((nodeId, reason) => {
  switch (reason) {
    case 'heartbeat_timeout':
      // Node stopped responding to heartbeats
      break;
    case 'connection_closed':
      // TCP connection was closed
      break;
    case 'connection_refused':
      // Could not establish connection
      break;
    case 'graceful_shutdown':
      // Node called Cluster.stop()
      break;
  }
});
```

## Cluster Events

### nodeUp

Fired when a node joins the cluster:

```typescript
const unsubscribe = Cluster.onNodeUp((node) => {
  console.log(`New node: ${node.id}`);
  console.log(`  Host: ${node.host}:${node.port}`);
  console.log(`  Status: ${node.status}`);
});

// Later: stop listening
unsubscribe();
```

### nodeDown

Fired when a node leaves or becomes unreachable:

```typescript
Cluster.onNodeDown((nodeId, reason) => {
  console.log(`Lost node: ${nodeId}`);
  console.log(`  Reason: ${reason}`);

  // Clean up resources associated with this node
  invalidateCacheForNode(nodeId);
});
```

### statusChange

Fired when the local node's cluster status changes:

```typescript
Cluster.onStatusChange((status) => {
  // status: 'starting' | 'running' | 'stopping' | 'stopped'
  console.log(`Cluster status: ${status}`);
});
```

## Configuration Reference

```typescript
interface ClusterConfig {
  /**
   * Human-readable name for this node.
   * Used as prefix in NodeId: `name@host:port`
   */
  nodeName: string;

  /**
   * Host address to bind to.
   * @default '0.0.0.0'
   */
  host?: string;

  /**
   * TCP port for cluster communication.
   * @default 4369
   */
  port?: number;

  /**
   * Seed nodes for cluster discovery.
   * Format: 'name@host:port'
   */
  seeds?: string[];

  /**
   * Shared secret for HMAC authentication.
   * All nodes must use the same secret.
   */
  clusterSecret?: string;

  /**
   * Interval between heartbeat broadcasts.
   * @default 5000 (5 seconds)
   */
  heartbeatIntervalMs?: number;

  /**
   * Missed heartbeats before marking node down.
   * @default 3
   */
  heartbeatMissThreshold?: number;

  /**
   * Initial reconnection delay (exponential backoff).
   * @default 1000 (1 second)
   */
  reconnectBaseDelayMs?: number;

  /**
   * Maximum reconnection delay.
   * @default 30000 (30 seconds)
   */
  reconnectMaxDelayMs?: number;
}
```

## Security

### Cluster Secret

Enable HMAC authentication to prevent unauthorized nodes:

```typescript
await Cluster.start({
  nodeName: 'secure-node',
  port: 4369,
  clusterSecret: process.env.CLUSTER_SECRET,
});
```

When `clusterSecret` is set:
- All messages are signed with HMAC-SHA256
- Unsigned or incorrectly signed messages are rejected
- All nodes in the cluster must use the same secret

### Network Recommendations

For production deployments:

1. **Private network**: Run cluster on isolated VLAN or VPC
2. **Firewall rules**: Restrict cluster port to known IPs
3. **TLS termination**: Use reverse proxy for external traffic
4. **Rotate secrets**: Change `clusterSecret` periodically

## Lifecycle

### Starting

```typescript
// Basic start
await Cluster.start({ nodeName: 'app1', port: 4369 });

// With seeds
await Cluster.start({
  nodeName: 'app1',
  port: 4369,
  seeds: ['seed@192.168.1.1:4369'],
});

// Check status
if (Cluster.getStatus() === 'running') {
  // Cluster is ready
}
```

### Stopping

```typescript
// Graceful shutdown
await Cluster.stop();
// - Broadcasts node_down to peers
// - Closes all connections
// - Cleans up resources
```

The stop is graceful: other nodes receive `graceful_shutdown` reason instead of detecting timeout.

### Status

```typescript
const status = Cluster.getStatus();
// 'starting' - Initialization in progress
// 'running'  - Fully operational
// 'stopping' - Shutdown in progress
// 'stopped'  - Not running
```

## Error Handling

### Startup Errors

```typescript
import { InvalidClusterConfigError } from 'noex/distribution';

try {
  await Cluster.start({
    nodeName: '123invalid', // Invalid: starts with number
    port: 4369,
  });
} catch (error) {
  if (error instanceof InvalidClusterConfigError) {
    console.error(`Config error: ${error.reason}`);
  }
}
```

### Cluster Not Started

```typescript
import { ClusterNotStartedError } from 'noex/distribution';

try {
  const nodes = Cluster.getNodes(); // Before start()
} catch (error) {
  if (error instanceof ClusterNotStartedError) {
    console.error('Call Cluster.start() first');
  }
}
```

## Complete Example

```typescript
import { Cluster, BehaviorRegistry } from 'noex/distribution';
import { workerBehavior } from './behaviors';

async function startNode(): Promise<void> {
  // 1. Register behaviors before starting cluster
  BehaviorRegistry.register('worker', workerBehavior);

  // 2. Parse configuration from environment
  const config = {
    nodeName: process.env.NODE_NAME || 'worker',
    port: parseInt(process.env.CLUSTER_PORT || '4369', 10),
    seeds: process.env.CLUSTER_SEEDS?.split(',') || [],
    clusterSecret: process.env.CLUSTER_SECRET,
  };

  // 3. Set up event handlers
  Cluster.onNodeUp((node) => {
    console.log(`[CLUSTER] Node joined: ${node.id}`);
  });

  Cluster.onNodeDown((nodeId, reason) => {
    console.log(`[CLUSTER] Node left: ${nodeId} (${reason})`);
  });

  Cluster.onStatusChange((status) => {
    console.log(`[CLUSTER] Status: ${status}`);
  });

  // 4. Start the cluster
  console.log(`Starting node: ${config.nodeName}@*:${config.port}`);
  await Cluster.start(config);

  console.log(`Node ID: ${Cluster.getLocalNodeId()}`);
  console.log(`Connected nodes: ${Cluster.getConnectedNodeCount()}`);

  // 5. Graceful shutdown on SIGTERM
  process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    await Cluster.stop();
    process.exit(0);
  });
}

startNode().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});
```

## Patterns

### Bootstrap Node

A dedicated first node that other nodes join:

```typescript
// bootstrap.ts - Run first
await Cluster.start({
  nodeName: 'bootstrap',
  host: '0.0.0.0',
  port: 4369,
});

// Wait for other nodes to join
Cluster.onNodeUp((node) => {
  console.log(`Cluster member: ${node.id}`);
});
```

### Dynamic Seed Discovery

Discover seeds from external service:

```typescript
async function getSeeds(): Promise<string[]> {
  // Query service registry, DNS, or config server
  const response = await fetch('http://config-server/cluster/seeds');
  return response.json();
}

const seeds = await getSeeds();
await Cluster.start({ nodeName: 'app', port: 4369, seeds });
```

### Health Check Endpoint

Expose cluster status for load balancers:

```typescript
import { createServer } from 'http';

createServer((req, res) => {
  if (req.url === '/health') {
    const status = Cluster.getStatus();
    const statusCode = status === 'running' ? 200 : 503;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status,
      nodeId: status === 'running' ? Cluster.getLocalNodeId() : null,
      connectedNodes: status === 'running' ? Cluster.getConnectedNodeCount() : 0,
    }));
  }
}).listen(8080);
```

## Related

- [Overview](./overview.md) - Distribution architecture
- [Remote Messaging](./remote-messaging.md) - Cross-node communication
- [Cluster Formation Guide](../guides/cluster-formation.md) - Step-by-step setup
- [Cluster API Reference](../api/cluster.md) - Complete API

---

*[Czech version](../../cs/distribution/concepts/cluster.md)*
