# ClusterObserver API Reference

The `ClusterObserver` module provides cluster-wide process monitoring for distributed noex applications. While the standard `Observer` monitors only local processes synchronously, `ClusterObserver` aggregates statistics from all nodes in the cluster asynchronously.

## Import

```typescript
import { ClusterObserver } from 'noex/distribution';
// Or from main package
import { ClusterObserver } from 'noex';
```

## Prerequisites

ClusterObserver requires an active cluster connection:

```typescript
import { Cluster, ClusterObserver } from 'noex/distribution';

await Cluster.start({
  nodeName: 'app1',
  port: 4369,
  seeds: ['app2@192.168.1.2:4369'],
});

// Now ClusterObserver is available
const snapshot = await ClusterObserver.getClusterSnapshot();
```

## Types

### ClusterObserverSnapshot

Complete snapshot of the cluster state.

```typescript
interface ClusterObserverSnapshot {
  /** Timestamp when the snapshot was taken */
  readonly timestamp: number;
  /** Local node identifier */
  readonly localNodeId: NodeId;
  /** Snapshots from all nodes in the cluster */
  readonly nodes: readonly NodeObserverSnapshot[];
  /** Aggregated statistics across all nodes */
  readonly aggregated: ClusterAggregatedStats;
}
```

### NodeObserverSnapshot

Snapshot from a single node.

```typescript
interface NodeObserverSnapshot {
  /** Node identifier */
  readonly nodeId: NodeId;
  /** Node's current status */
  readonly status: NodeObserverStatus;
  /** Observer snapshot (null if node is not reachable) */
  readonly snapshot: ObserverSnapshot | null;
  /** Timestamp of last successful update */
  readonly lastUpdate: number;
  /** Error message if status is 'error' or 'timeout' */
  readonly error?: string;
}
```

### NodeObserverStatus

Status of a node in the cluster snapshot.

```typescript
type NodeObserverStatus = 'connected' | 'disconnected' | 'error' | 'timeout';
```

| Status | Description |
|--------|-------------|
| `'connected'` | Node responded successfully |
| `'disconnected'` | Node is known but not reachable |
| `'error'` | Query failed with an error |
| `'timeout'` | Query timed out |

### ClusterAggregatedStats

Aggregated statistics across all connected nodes.

```typescript
interface ClusterAggregatedStats {
  /** Total number of processes across all nodes */
  readonly totalProcessCount: number;
  /** Total number of GenServers across all nodes */
  readonly totalServerCount: number;
  /** Total number of Supervisors across all nodes */
  readonly totalSupervisorCount: number;
  /** Total messages processed across all nodes */
  readonly totalMessages: number;
  /** Total restarts across all nodes */
  readonly totalRestarts: number;
  /** Number of nodes that responded successfully */
  readonly connectedNodeCount: number;
  /** Total number of nodes in the cluster */
  readonly totalNodeCount: number;
}
```

### ClusterObserverEvent

Events emitted by ClusterObserver.

```typescript
type ClusterObserverEvent =
  | { type: 'cluster_snapshot_update'; snapshot: ClusterObserverSnapshot }
  | { type: 'node_snapshot_update'; nodeId: NodeId; snapshot: ObserverSnapshot }
  | { type: 'node_error'; nodeId: NodeId; error: string }
  | { type: 'node_timeout'; nodeId: NodeId };
```

### ClusterObserverEventHandler

Handler function for ClusterObserver events.

```typescript
type ClusterObserverEventHandler = (event: ClusterObserverEvent) => void;
```

### ClusterSnapshotOptions

Options for `getClusterSnapshot()`.

```typescript
interface ClusterSnapshotOptions {
  /** Whether to use cached data if available (default: true) */
  readonly useCache?: boolean;
  /** Timeout for remote queries in milliseconds (default: 5000) */
  readonly timeout?: number;
}
```

---

## Methods

### getClusterSnapshot()

Returns an aggregated snapshot from all nodes in the cluster.

```typescript
async getClusterSnapshot(options?: ClusterSnapshotOptions): Promise<ClusterObserverSnapshot>
```

**Parameters:**
- `options.useCache` - Whether to use cached data (default: `true`)
- `options.timeout` - Remote query timeout in ms (default: `5000`)

**Returns:** Promise resolving to cluster snapshot

**Throws:**
- `Error` - If cluster is not running

**Example:**
```typescript
const snapshot = await ClusterObserver.getClusterSnapshot();

console.log(`Cluster has ${snapshot.aggregated.totalProcessCount} processes`);
console.log(`Across ${snapshot.aggregated.connectedNodeCount} nodes`);

for (const node of snapshot.nodes) {
  if (node.status === 'connected' && node.snapshot) {
    console.log(`${node.nodeId}: ${node.snapshot.processCount} processes`);
  }
}
```

---

### getNodeSnapshot()

Returns a snapshot from a specific remote node.

```typescript
async getNodeSnapshot(nodeId: NodeId, timeout?: number): Promise<ObserverSnapshot>
```

**Parameters:**
- `nodeId` - Target node identifier
- `timeout` - Query timeout in ms (default: `5000`)

**Returns:** Promise resolving to the node's observer snapshot

**Throws:**
- `Error` - If cluster is not running
- `Error` - If node is not reachable
- `Error` - If query fails

**Example:**
```typescript
const remoteSnapshot = await ClusterObserver.getNodeSnapshot(
  'app2@192.168.1.2:4369' as NodeId
);

console.log(`Remote node has ${remoteSnapshot.processCount} processes`);
```

---

### startPolling()

Starts periodic polling for cluster-wide snapshots.

```typescript
startPolling(intervalMs: number, handler: ClusterObserverEventHandler): () => void
```

**Parameters:**
- `intervalMs` - Polling interval in milliseconds
- `handler` - Event handler for snapshot updates

**Returns:** Unsubscribe function

**Notes:**
- Multiple calls with different handlers share the same polling timer
- The timer stops when all handlers have unsubscribed
- Emits an initial snapshot immediately

**Example:**
```typescript
const stopPolling = ClusterObserver.startPolling(5000, (event) => {
  if (event.type === 'cluster_snapshot_update') {
    updateDashboard(event.snapshot);
  } else if (event.type === 'node_timeout') {
    console.warn(`Node ${event.nodeId} is not responding`);
  }
});

// Later: stop polling
stopPolling();
```

---

### subscribe()

Subscribes to cluster observer events without starting polling.

```typescript
subscribe(handler: ClusterObserverEventHandler): () => void
```

**Parameters:**
- `handler` - Event handler

**Returns:** Unsubscribe function

**Notes:**
- Events are emitted during polling started by `startPolling()`
- Allows multiple listeners without starting additional timers

**Example:**
```typescript
const unsubscribe = ClusterObserver.subscribe((event) => {
  if (event.type === 'node_error') {
    console.error(`Node ${event.nodeId} error: ${event.error}`);
  }
});

// Later
unsubscribe();
```

---

### invalidateCache()

Forces the next `getClusterSnapshot()` to fetch fresh data.

```typescript
invalidateCache(): void
```

**Example:**
```typescript
// Force fresh data on next query
ClusterObserver.invalidateCache();

// This will fetch fresh data
const snapshot = await ClusterObserver.getClusterSnapshot();
```

---

### getCacheStatus()

Returns the current cache status for debugging.

```typescript
getCacheStatus(): { readonly timestamp: number; readonly age: number } | null
```

**Returns:** Cache information or `null` if no cache exists

**Example:**
```typescript
const status = ClusterObserver.getCacheStatus();
if (status) {
  console.log(`Cache age: ${status.age}ms`);
}
```

---

## Complete Example

```typescript
import { Observer } from 'noex';
import { Cluster, ClusterObserver } from 'noex/distribution';

async function monitorCluster() {
  // Start cluster
  await Cluster.start({
    nodeName: 'monitor',
    port: 4369,
    seeds: ['app1@192.168.1.1:4369', 'app2@192.168.1.2:4369'],
  });

  // Local monitoring (synchronous)
  const localSnapshot = Observer.getSnapshot();
  console.log(`Local: ${localSnapshot.processCount} processes`);

  // Cluster-wide monitoring (asynchronous)
  const clusterSnapshot = await ClusterObserver.getClusterSnapshot();
  console.log(`Cluster: ${clusterSnapshot.aggregated.totalProcessCount} processes`);

  // Per-node breakdown
  for (const node of clusterSnapshot.nodes) {
    const isLocal = node.nodeId === clusterSnapshot.localNodeId;
    const marker = isLocal ? ' (local)' : '';

    if (node.status === 'connected' && node.snapshot) {
      console.log(`${node.nodeId}${marker}:`);
      console.log(`  Processes: ${node.snapshot.processCount}`);
      console.log(`  Messages: ${node.snapshot.totalMessages}`);
      console.log(`  Memory: ${(node.snapshot.memoryStats.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    } else {
      console.log(`${node.nodeId}${marker}: ${node.status}`);
      if (node.error) {
        console.log(`  Error: ${node.error}`);
      }
    }
  }

  // Start polling for updates
  const stopPolling = ClusterObserver.startPolling(5000, (event) => {
    if (event.type === 'cluster_snapshot_update') {
      const { aggregated } = event.snapshot;
      console.log(`[Update] ${aggregated.totalProcessCount} processes on ${aggregated.connectedNodeCount} nodes`);
    }
  });

  // Cleanup on shutdown
  process.on('SIGINT', async () => {
    stopPolling();
    await Cluster.stop();
  });
}

monitorCluster().catch(console.error);
```

---

## Caching Behavior

ClusterObserver caches snapshots for 2 seconds by default to reduce network traffic. You can control caching:

```typescript
// Use cache (default)
const cached = await ClusterObserver.getClusterSnapshot();

// Force fresh data
const fresh = await ClusterObserver.getClusterSnapshot({ useCache: false });

// Invalidate cache manually
ClusterObserver.invalidateCache();
```

---

## Error Handling

When a node is unreachable, its status reflects the issue:

```typescript
const snapshot = await ClusterObserver.getClusterSnapshot();

for (const node of snapshot.nodes) {
  switch (node.status) {
    case 'connected':
      // Node responded successfully
      console.log(`${node.nodeId}: ${node.snapshot?.processCount} processes`);
      break;
    case 'timeout':
      console.warn(`Node ${node.nodeId} timed out`);
      break;
    case 'error':
      console.error(`Node ${node.nodeId} error: ${node.error}`);
      break;
    case 'disconnected':
      console.warn(`Node ${node.nodeId} disconnected`);
      break;
  }
}
```

---

## Best Practices

### Polling Intervals

Choose polling intervals based on your monitoring needs:

```typescript
// Dashboard updates (frequent)
ClusterObserver.startPolling(2000, handler);

// Health checks (moderate)
ClusterObserver.startPolling(10000, handler);

// Resource-constrained environments (infrequent)
ClusterObserver.startPolling(30000, handler);
```

### Timeout Configuration

Adjust timeouts based on network conditions:

```typescript
// Local network (fast)
const snapshot = await ClusterObserver.getClusterSnapshot({ timeout: 2000 });

// Cross-datacenter (slower)
const snapshot = await ClusterObserver.getClusterSnapshot({ timeout: 10000 });
```

### Handling Partial Results

Cluster snapshots may contain partial results if some nodes are unreachable. Design your code to handle this gracefully:

```typescript
const snapshot = await ClusterObserver.getClusterSnapshot();
const { aggregated } = snapshot;

if (aggregated.connectedNodeCount < aggregated.totalNodeCount) {
  console.warn(
    `Only ${aggregated.connectedNodeCount}/${aggregated.totalNodeCount} nodes responded`
  );
}
```

---

## Related

- [Observer API](../../api/observer.md) - Local process monitoring
- [Cluster API](./cluster.md) - Cluster management
- [Distribution Overview](../concepts/overview.md) - Architecture
