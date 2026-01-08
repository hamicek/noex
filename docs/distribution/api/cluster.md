# Cluster API Reference

The `Cluster` singleton manages cluster lifecycle and provides the foundation for distributed communication between nodes in a P2P network.

## Import

```typescript
import { Cluster } from 'noex/distribution';
```

## Types

### ClusterConfig

Configuration for starting a cluster node.

```typescript
interface ClusterConfig {
  readonly nodeName: string;
  readonly host?: string;
  readonly port?: number;
  readonly seeds?: readonly string[];
  readonly clusterSecret?: string;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatMissThreshold?: number;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `nodeName` | `string` | required | Human-readable name for this node (e.g., `app1` in `app1@host:port`) |
| `host` | `string` | `'0.0.0.0'` | Host address to listen on |
| `port` | `number` | `4369` | TCP port for cluster communication |
| `seeds` | `readonly string[]` | `[]` | Seed nodes for initial discovery (format: `name@host:port`) |
| `clusterSecret` | `string` | - | Shared secret for HMAC-based message authentication |
| `heartbeatIntervalMs` | `number` | `5000` | Interval between heartbeat broadcasts |
| `heartbeatMissThreshold` | `number` | `3` | Missed heartbeats before marking node as down |
| `reconnectBaseDelayMs` | `number` | `1000` | Initial reconnection delay |
| `reconnectMaxDelayMs` | `number` | `30000` | Maximum reconnection delay |

### NodeId

Branded string type representing a unique node identifier in the format `name@host:port`.

```typescript
type NodeId = string & { readonly __brand: 'NodeId' };
```

The `NodeId` namespace provides utilities for working with node identifiers:

```typescript
// Parse from string
const nodeId = NodeId.parse('app1@192.168.1.1:4369');

// Create from components
const nodeId = NodeId.create('app1', '192.168.1.1', 4369);

// Validate
const isValid = NodeId.isValid('app1@192.168.1.1:4369'); // true
```

### NodeInfo

Information about a node in the cluster.

```typescript
interface NodeInfo {
  readonly id: NodeId;
  readonly host: string;
  readonly port: number;
  readonly status: NodeStatus;
  readonly processCount: number;
  readonly lastHeartbeatAt: number;
  readonly uptimeMs: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `NodeId` | Unique identifier of the node |
| `host` | `string` | Host address of the node |
| `port` | `number` | TCP port of the node |
| `status` | `NodeStatus` | Current connection status |
| `processCount` | `number` | Number of GenServer processes on this node |
| `lastHeartbeatAt` | `number` | Unix timestamp of last successful heartbeat |
| `uptimeMs` | `number` | Node's uptime in milliseconds |

### NodeStatus

Connection status of a node in the cluster.

```typescript
type NodeStatus = 'connecting' | 'connected' | 'disconnected';
```

| Status | Description |
|--------|-------------|
| `'connecting'` | Initial connection attempt in progress |
| `'connected'` | Actively communicating with successful heartbeats |
| `'disconnected'` | Connection lost, attempting reconnection |

### ClusterStatus

Current status of the local node in the cluster.

```typescript
type ClusterStatus = 'starting' | 'running' | 'stopping' | 'stopped';
```

### ClusterEvents

Events emitted by Cluster.

```typescript
interface ClusterEvents {
  nodeUp: [node: NodeInfo];
  nodeDown: [nodeId: NodeId, reason: NodeDownReason];
  statusChange: [status: ClusterStatus];
  error: [error: Error];
}
```

### NodeDownReason

Reasons why a node may be considered down.

```typescript
type NodeDownReason =
  | 'heartbeat_timeout'
  | 'connection_closed'
  | 'connection_refused'
  | 'graceful_shutdown';
```

---

## Methods

### start()

Starts the cluster node.

```typescript
async start(config: ClusterConfig): Promise<void>
```

**Parameters:**
- `config` - Cluster configuration

**Throws:**
- `InvalidClusterConfigError` - If configuration is invalid
- `Error` - If cluster is already running

**Example:**
```typescript
await Cluster.start({
  nodeName: 'app1',
  port: 4369,
  seeds: ['app2@192.168.1.2:4369'],
  clusterSecret: 'my-secure-secret',
});
```

---

### stop()

Gracefully stops the cluster node.

```typescript
async stop(): Promise<void>
```

Broadcasts a node_down message to other nodes, stops heartbeat, disconnects from all nodes, and cleans up resources.

**Example:**
```typescript
await Cluster.stop();
```

---

### getStatus()

Returns the current cluster status.

```typescript
getStatus(): ClusterStatus
```

**Returns:** Current status (`'starting'`, `'running'`, `'stopping'`, or `'stopped'`)

**Example:**
```typescript
if (Cluster.getStatus() === 'running') {
  console.log('Cluster is active');
}
```

---

### getLocalNodeId()

Returns the local node identifier.

```typescript
getLocalNodeId(): NodeId
```

**Returns:** The local node's identifier

**Throws:**
- `ClusterNotStartedError` - If cluster is not running

**Example:**
```typescript
const localId = Cluster.getLocalNodeId();
console.log(`This node: ${localId}`); // e.g., "app1@192.168.1.1:4369"
```

---

### getLocalNodeInfo()

Returns information about the local node.

```typescript
getLocalNodeInfo(): NodeInfo
```

**Returns:** NodeInfo for the local node

**Throws:**
- `ClusterNotStartedError` - If cluster is not running

**Example:**
```typescript
const info = Cluster.getLocalNodeInfo();
console.log(`Uptime: ${info.uptimeMs}ms`);
```

---

### getNodes()

Returns information about all known nodes in the cluster.

```typescript
getNodes(): readonly NodeInfo[]
```

**Returns:** Array of all known nodes (including disconnected ones)

**Throws:**
- `ClusterNotStartedError` - If cluster is not running

**Example:**
```typescript
const nodes = Cluster.getNodes();
for (const node of nodes) {
  console.log(`${node.id}: ${node.status}`);
}
```

---

### getConnectedNodes()

Returns information about connected nodes only.

```typescript
getConnectedNodes(): readonly NodeInfo[]
```

**Returns:** Array of currently connected nodes

**Throws:**
- `ClusterNotStartedError` - If cluster is not running

**Example:**
```typescript
const connected = Cluster.getConnectedNodes();
console.log(`${connected.length} nodes online`);
```

---

### getNodeIds()

Returns the node identifiers of all known nodes.

```typescript
getNodeIds(): readonly NodeId[]
```

**Returns:** Array of all known node identifiers

**Throws:**
- `ClusterNotStartedError` - If cluster is not running

---

### getNode()

Returns information about a specific node.

```typescript
getNode(nodeId: NodeId): NodeInfo | undefined
```

**Parameters:**
- `nodeId` - Node identifier to look up

**Returns:** NodeInfo if found, undefined otherwise

**Throws:**
- `ClusterNotStartedError` - If cluster is not running

**Example:**
```typescript
const node = Cluster.getNode(targetNodeId);
if (node?.status === 'connected') {
  // Node is reachable
}
```

---

### isNodeConnected()

Checks if a node is currently connected.

```typescript
isNodeConnected(nodeId: NodeId): boolean
```

**Parameters:**
- `nodeId` - Node identifier to check

**Returns:** `true` if the node is connected

**Throws:**
- `ClusterNotStartedError` - If cluster is not running

**Example:**
```typescript
if (Cluster.isNodeConnected(targetNodeId)) {
  await RemoteCall.call(remoteRef, message);
}
```

---

### getConnectedNodeCount()

Returns the number of connected nodes.

```typescript
getConnectedNodeCount(): number
```

**Returns:** Number of currently connected nodes

**Throws:**
- `ClusterNotStartedError` - If cluster is not running

---

### getUptimeMs()

Returns the cluster uptime in milliseconds.

```typescript
getUptimeMs(): number
```

**Returns:** Milliseconds since cluster started

**Throws:**
- `ClusterNotStartedError` - If cluster is not running

---

### onNodeUp()

Registers a handler for node join events.

```typescript
onNodeUp(handler: NodeUpHandler): () => void
```

**Parameters:**
- `handler` - Function called when a node joins: `(node: NodeInfo) => void`

**Returns:** Unsubscribe function

**Example:**
```typescript
const unsubscribe = Cluster.onNodeUp((node) => {
  console.log(`Node joined: ${node.id}`);
});

// Later
unsubscribe();
```

---

### onNodeDown()

Registers a handler for node leave events.

```typescript
onNodeDown(handler: NodeDownHandler): () => void
```

**Parameters:**
- `handler` - Function called when a node leaves: `(nodeId: NodeId, reason: NodeDownReason) => void`

**Returns:** Unsubscribe function

**Example:**
```typescript
const unsubscribe = Cluster.onNodeDown((nodeId, reason) => {
  console.log(`Node left: ${nodeId}, reason: ${reason}`);
});
```

---

### onStatusChange()

Registers a handler for cluster status changes.

```typescript
onStatusChange(handler: ClusterStatusHandler): () => void
```

**Parameters:**
- `handler` - Function called on status change: `(status: ClusterStatus) => void`

**Returns:** Unsubscribe function

**Example:**
```typescript
Cluster.onStatusChange((status) => {
  console.log(`Cluster status: ${status}`);
});
```

---

## Error Classes

### ClusterNotStartedError

```typescript
class ClusterNotStartedError extends Error {
  readonly name = 'ClusterNotStartedError';
}
```

Thrown when attempting to use cluster functionality before calling `Cluster.start()`.

### InvalidClusterConfigError

```typescript
class InvalidClusterConfigError extends Error {
  readonly name = 'InvalidClusterConfigError';
  readonly reason: string;
}
```

Thrown when cluster configuration is invalid.

---

## Constants

### CLUSTER_DEFAULTS

Default values for cluster configuration.

```typescript
const CLUSTER_DEFAULTS = {
  HOST: '0.0.0.0',
  PORT: 4369,
  HEARTBEAT_INTERVAL_MS: 5000,
  HEARTBEAT_MISS_THRESHOLD: 3,
  RECONNECT_BASE_DELAY_MS: 1000,
  RECONNECT_MAX_DELAY_MS: 30000,
  PROTOCOL_VERSION: 1,
} as const;
```

---

## Complete Example

```typescript
import { Cluster, RemoteCall, NodeId } from 'noex/distribution';

async function main() {
  // Start the cluster
  await Cluster.start({
    nodeName: 'coordinator',
    port: 4369,
    seeds: ['worker1@192.168.1.10:4369', 'worker2@192.168.1.11:4369'],
    clusterSecret: process.env.CLUSTER_SECRET,
    heartbeatIntervalMs: 3000,
    heartbeatMissThreshold: 2,
  });

  console.log(`Started as ${Cluster.getLocalNodeId()}`);

  // Monitor cluster events
  Cluster.onNodeUp((node) => {
    console.log(`Node joined: ${node.id} (${node.processCount} processes)`);
  });

  Cluster.onNodeDown((nodeId, reason) => {
    console.log(`Node left: ${nodeId} (${reason})`);
  });

  // Wait for connections
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Check cluster state
  const nodes = Cluster.getConnectedNodes();
  console.log(`Connected to ${nodes.length} nodes:`);
  for (const node of nodes) {
    console.log(`  - ${node.id}: uptime ${Math.round(node.uptimeMs / 1000)}s`);
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await Cluster.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Best Practices

### Seed Configuration

- Configure multiple seed nodes for redundancy
- Seeds don't need to be running when the cluster starts
- Nodes discover each other through gossip after initial connection

```typescript
await Cluster.start({
  nodeName: 'app1',
  seeds: [
    'app2@192.168.1.2:4369',
    'app3@192.168.1.3:4369',
    'app4@192.168.1.4:4369',
  ],
});
```

### Security

- Always use `clusterSecret` in production to authenticate messages
- Use the same secret across all nodes in the cluster

```typescript
await Cluster.start({
  nodeName: 'secure-node',
  clusterSecret: process.env.CLUSTER_SECRET, // Same on all nodes
});
```

### Failure Detection Tuning

- Lower `heartbeatIntervalMs` for faster failure detection
- Higher `heartbeatMissThreshold` to reduce false positives

```typescript
// Fast detection (15 seconds to detect failure)
await Cluster.start({
  nodeName: 'fast-detect',
  heartbeatIntervalMs: 5000,
  heartbeatMissThreshold: 3,
});

// Tolerant of network hiccups (45 seconds to detect failure)
await Cluster.start({
  nodeName: 'tolerant',
  heartbeatIntervalMs: 15000,
  heartbeatMissThreshold: 3,
});
```

---

## Related

- [Cluster Concepts](../concepts/cluster.md) - Understanding cluster formation
- [RemoteCall API](./remote-call.md) - Cross-node messaging
- [GlobalRegistry API](./global-registry.md) - Cluster-wide naming
- [Types Reference](./types.md) - All distribution types
