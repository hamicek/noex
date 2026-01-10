# Cluster Observer Example

This example demonstrates distributed process monitoring across multiple nodes in a noex cluster using the ClusterObserver.

## What This Example Shows

- Starting multiple nodes in a cluster
- Creating local GenServers and Supervisors on each node
- Using `Observer` for local process monitoring (synchronous)
- Using `ClusterObserver` for cluster-wide monitoring (asynchronous)
- Handling node join/leave events
- Periodic polling for real-time cluster statistics

## Running the Example

Open **three terminal windows**.

### Terminal 1 - Start Node A (seed node)

```bash
cd examples/cluster-observer
npm install
npm run start:a
# Or: npx tsx node.ts --name nodeA --port 4369
```

### Terminal 2 - Start Node B

```bash
cd examples/cluster-observer
npm run start:b
# Or: npx tsx node.ts --name nodeB --port 4370 --seed nodeA@127.0.0.1:4369
```

### Terminal 3 - Start Node C

```bash
cd examples/cluster-observer
npm run start:c
# Or: npx tsx node.ts --name nodeC --port 4371 --seed nodeA@127.0.0.1:4369
```

## Expected Output

Each node will display:

1. Local process statistics (immediate)
2. Cluster-wide aggregated statistics (after nodes connect)
3. Per-node breakdown with process counts and memory usage
4. Periodic updates every 5 seconds

Example output after all three nodes are connected:

```
Cluster Overview (2024-01-15T10:30:00.000Z):
  Total nodes: 3
  Connected nodes: 3
  Total processes: 12
  Total servers: 9
  Total supervisors: 3
  Total messages: 90
  Total restarts: 0

Per-node breakdown:
  nodeA@127.0.0.1:4369 (local):
    Status: connected
    Processes: 4
    Messages: 30
    Restarts: 0
    Memory: 45.23 MB
  nodeB@127.0.0.1:4370:
    Status: connected
    Processes: 4
    Messages: 30
    Restarts: 0
    Memory: 42.15 MB
  nodeC@127.0.0.1:4371:
    Status: connected
    Processes: 4
    Messages: 30
    Restarts: 0
    Memory: 43.87 MB
```

## Key Concepts

### Local vs Cluster Observer

```typescript
import { Observer } from 'noex';
import { ClusterObserver } from 'noex/distribution';

// Local snapshot - synchronous, returns only local processes
const localSnapshot = Observer.getSnapshot();

// Cluster snapshot - asynchronous, aggregates from all nodes
const clusterSnapshot = await ClusterObserver.getClusterSnapshot();
```

### Polling for Updates

```typescript
const stopPolling = ClusterObserver.startPolling(5000, (event) => {
  if (event.type === 'cluster_snapshot_update') {
    // Handle cluster-wide update
    console.log(`Total processes: ${event.snapshot.aggregated.totalProcessCount}`);
  }
});

// Later: stop polling
stopPolling();
```

### Node Status

Each node in the cluster snapshot has a status:

| Status | Description |
|--------|-------------|
| `connected` | Node is reachable and responded successfully |
| `disconnected` | Node is in the cluster but not responding |
| `timeout` | Query timed out |
| `error` | Query failed with an error |

### Error Handling

```typescript
const snapshot = await ClusterObserver.getClusterSnapshot();

for (const node of snapshot.nodes) {
  switch (node.status) {
    case 'connected':
      // Process node.snapshot
      break;
    case 'timeout':
      console.warn(`Node ${node.nodeId} timed out`);
      break;
    case 'error':
      console.error(`Node ${node.nodeId} error: ${node.error}`);
      break;
  }
}
```

## Command Line Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--name` | `-n` | Node name (required) | - |
| `--port` | `-p` | Cluster port | 4369 |
| `--seed` | `-s` | Seed node (repeatable) | - |

## Architecture

```
Terminal 1                Terminal 2                Terminal 3
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│     Node A      │      │     Node B      │      │     Node C      │
│  ┌───────────┐  │      │  ┌───────────┐  │      │  ┌───────────┐  │
│  │ Observer  │  │      │  │ Observer  │  │      │  │ Observer  │  │
│  │ Service   │  │◄────►│  │ Service   │  │◄────►│  │ Service   │  │
│  └───────────┘  │      │  └───────────┘  │      │  └───────────┘  │
│  ┌───────────┐  │      │  ┌───────────┐  │      │  ┌───────────┐  │
│  │ Cluster   │  │      │  │ Cluster   │  │      │  │ Cluster   │  │
│  │ Observer  │  │      │  │ Observer  │  │      │  │ Observer  │  │
│  └───────────┘  │      │  └───────────┘  │      │  └───────────┘  │
│  ┌───────────┐  │      │  ┌───────────┐  │      │  ┌───────────┐  │
│  │Supervisor │  │      │  │Supervisor │  │      │  │Supervisor │  │
│  │  Worker 1 │  │      │  │  Worker 1 │  │      │  │  Worker 1 │  │
│  │  Worker 2 │  │      │  │  Worker 2 │  │      │  │  Worker 2 │  │
│  │  Worker 3 │  │      │  │  Worker 3 │  │      │  │  Worker 3 │  │
│  └───────────┘  │      │  └───────────┘  │      │  └───────────┘  │
└─────────────────┘      └─────────────────┘      └─────────────────┘
```

## Related Documentation

- [Observer API](../../docs/api/observer.md) - Local process monitoring
- [ClusterObserver API](../../docs/distribution/api/cluster-observer.md) - Cluster-wide monitoring
- [Distribution Overview](../../docs/distribution/concepts/overview.md) - Clustering architecture
