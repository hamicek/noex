# Observer API Reference

The `Observer` module provides system-wide introspection for noex processes. It enables real-time monitoring, statistics collection, and process tree visualization - similar to Elixir's Observer tool.

## Import

```typescript
import { Observer } from 'noex';
// Or import from submodule
import { Observer } from 'noex/observer';
```

## Types

### ObserverSnapshot

Complete snapshot of the system state at a point in time.

```typescript
interface ObserverSnapshot {
  /** Timestamp when the snapshot was taken */
  readonly timestamp: number;
  /** Statistics for all running GenServers */
  readonly servers: readonly GenServerStats[];
  /** Statistics for all running Supervisors */
  readonly supervisors: readonly SupervisorStats[];
  /** Hierarchical process tree */
  readonly tree: readonly ProcessTreeNode[];
  /** Total number of running processes */
  readonly processCount: number;
  /** Total messages processed across all servers */
  readonly totalMessages: number;
  /** Total restarts across all supervisors */
  readonly totalRestarts: number;
  /** Global memory statistics */
  readonly memoryStats: MemoryStats;
}
```

### GenServerStats

Statistics for a single GenServer.

```typescript
interface GenServerStats {
  readonly id: string;
  readonly name?: string;
  readonly status: 'running' | 'stopped';
  readonly messageCount: number;
  readonly startedAt: number;
  readonly lastMessageAt?: number;
}
```

### SupervisorStats

Statistics for a single Supervisor.

```typescript
interface SupervisorStats {
  readonly id: string;
  readonly name?: string;
  readonly childCount: number;
  readonly totalRestarts: number;
  readonly strategy: 'one_for_one' | 'one_for_all' | 'rest_for_one';
}
```

### ProcessTreeNode

Node in the process hierarchy tree.

```typescript
interface ProcessTreeNode {
  readonly id: string;
  readonly name?: string;
  readonly type: 'genserver' | 'supervisor';
  readonly stats: GenServerStats | SupervisorStats;
  readonly children: readonly ProcessTreeNode[];
}
```

### MemoryStats

Node.js process memory statistics.

```typescript
interface MemoryStats {
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
  readonly rss: number;
}
```

### ObserverEvent

Events emitted by the Observer.

```typescript
type ObserverEvent =
  | { type: 'server_started'; stats: GenServerStats }
  | { type: 'server_stopped'; id: string; reason: TerminateReason }
  | { type: 'supervisor_started'; stats: SupervisorStats }
  | { type: 'supervisor_stopped'; id: string }
  | { type: 'stats_update'; servers: readonly GenServerStats[]; supervisors: readonly SupervisorStats[] };
```

### ObserverEventHandler

Handler function for Observer events.

```typescript
type ObserverEventHandler = (event: ObserverEvent) => void;
```

---

## Methods

### getSnapshot()

Returns a complete snapshot of the system state.

```typescript
getSnapshot(): ObserverSnapshot
```

**Returns:** Complete system snapshot with all processes, statistics, and tree

**Example:**
```typescript
const snapshot = Observer.getSnapshot();

console.log(`Timestamp: ${new Date(snapshot.timestamp).toISOString()}`);
console.log(`Processes: ${snapshot.processCount}`);
console.log(`Total messages: ${snapshot.totalMessages}`);
console.log(`Total restarts: ${snapshot.totalRestarts}`);
console.log(`Memory: ${(snapshot.memoryStats.heapUsed / 1024 / 1024).toFixed(2)} MB`);
```

---

### getServerStats()

Returns statistics for all running GenServers.

```typescript
getServerStats(): readonly GenServerStats[]
```

**Returns:** Array of GenServer statistics

**Example:**
```typescript
const servers = Observer.getServerStats();

for (const server of servers) {
  console.log(`${server.name || server.id}: ${server.messageCount} messages`);
}
```

---

### getSupervisorStats()

Returns statistics for all running Supervisors.

```typescript
getSupervisorStats(): readonly SupervisorStats[]
```

**Returns:** Array of Supervisor statistics

**Example:**
```typescript
const supervisors = Observer.getSupervisorStats();

for (const sup of supervisors) {
  console.log(`${sup.name || sup.id}: ${sup.childCount} children, ${sup.totalRestarts} restarts`);
}
```

---

### getProcessTree()

Returns the complete process tree hierarchy.

```typescript
getProcessTree(): readonly ProcessTreeNode[]
```

**Returns:** Array of root-level process tree nodes

**Example:**
```typescript
function printTree(nodes: readonly ProcessTreeNode[], indent = 0) {
  for (const node of nodes) {
    const prefix = '  '.repeat(indent);
    const name = node.name || node.id;
    console.log(`${prefix}${node.type}: ${name}`);
    printTree(node.children, indent + 1);
  }
}

const tree = Observer.getProcessTree();
printTree(tree);
```

---

### getMemoryStats()

Returns current process memory statistics.

```typescript
getMemoryStats(): MemoryStats
```

**Returns:** Current memory statistics

**Example:**
```typescript
const memory = Observer.getMemoryStats();

console.log(`Heap: ${(memory.heapUsed / 1024 / 1024).toFixed(2)} MB`);
console.log(`RSS: ${(memory.rss / 1024 / 1024).toFixed(2)} MB`);
```

---

### getProcessCount()

Returns the count of all running processes.

```typescript
getProcessCount(): number
```

**Returns:** Total number of GenServers and Supervisors

**Example:**
```typescript
console.log(`Running processes: ${Observer.getProcessCount()}`);
```

---

### subscribe()

Subscribes to real-time Observer events.

```typescript
subscribe(handler: ObserverEventHandler): () => void
```

**Parameters:**
- `handler` - Function called for each event

**Returns:** Unsubscribe function

**Example:**
```typescript
const unsubscribe = Observer.subscribe((event) => {
  switch (event.type) {
    case 'server_started':
      console.log(`Server started: ${event.stats.name || event.stats.id}`);
      break;
    case 'server_stopped':
      console.log(`Server stopped: ${event.id} (${event.reason})`);
      break;
    case 'supervisor_started':
      console.log(`Supervisor started: ${event.stats.name || event.stats.id}`);
      break;
    case 'supervisor_stopped':
      console.log(`Supervisor stopped: ${event.id}`);
      break;
  }
});

// Later: stop listening
unsubscribe();
```

---

### startPolling()

Starts periodic polling for stats updates.

```typescript
startPolling(intervalMs: number, handler: ObserverEventHandler): () => void
```

**Parameters:**
- `intervalMs` - Polling interval in milliseconds
- `handler` - Function called with each stats update

**Returns:** Function to stop polling

**Example:**
```typescript
const stopPolling = Observer.startPolling(1000, (event) => {
  if (event.type === 'stats_update') {
    console.log(`Servers: ${event.servers.length}`);
    console.log(`Supervisors: ${event.supervisors.length}`);
  }
});

// Later: stop polling
stopPolling();
```

---

### stopProcess()

Stops a process by its ID.

```typescript
async stopProcess(
  id: string,
  reason?: string,
): Promise<{ success: boolean; error?: string }>
```

**Parameters:**
- `id` - The process ID to stop
- `reason` - Optional reason for stopping

**Returns:** Object with success status and optional error message

**Example:**
```typescript
const result = await Observer.stopProcess('genserver_1_abc123', 'Manual shutdown');

if (result.success) {
  console.log('Process stopped successfully');
} else {
  console.error('Failed to stop:', result.error);
}
```

---

### prepareExportData()

Prepares data for export in a standardized format.

```typescript
prepareExportData(): ExportData
```

**Returns:** Export data structure with current snapshot

**Example:**
```typescript
import { Observer, exportToJson, exportToCsv } from 'noex/observer';

const data = Observer.prepareExportData();
const json = exportToJson(data);
const csvs = exportToCsv(data);
```

---

### subscribeToAlerts()

Subscribes to alert events from the AlertManager.

```typescript
subscribeToAlerts(handler: AlertEventHandler): () => void
```

**Parameters:**
- `handler` - Function called for each alert event

**Returns:** Unsubscribe function

**Example:**
```typescript
const unsubscribe = Observer.subscribeToAlerts((event) => {
  if (event.type === 'alert_triggered') {
    console.log(`Alert: ${event.alert.message}`);
    console.log(`Process: ${event.alert.processId}`);
    console.log(`Value: ${event.alert.currentValue} (threshold: ${event.alert.threshold})`);
  } else if (event.type === 'alert_resolved') {
    console.log(`Alert resolved for ${event.processId}`);
  }
});
```

---

### getActiveAlerts()

Returns all currently active alerts.

```typescript
getActiveAlerts(): readonly Alert[]
```

**Returns:** Array of active alerts

**Example:**
```typescript
const alerts = Observer.getActiveAlerts();

for (const alert of alerts) {
  console.log(`[${alert.type}] ${alert.message}`);
}
```

---

## Complete Example

```typescript
import { Observer, GenServer, Supervisor } from 'noex';

async function main() {
  // Start some processes
  const counter = await GenServer.start({
    init: () => 0,
    handleCall: (msg, state) => [state, state],
    handleCast: (msg, state) => state + 1,
  }, { name: 'counter' });

  // Subscribe to lifecycle events
  const unsubscribe = Observer.subscribe((event) => {
    console.log(`Event: ${event.type}`);
  });

  // Get system snapshot
  const snapshot = Observer.getSnapshot();
  console.log('\n=== System Snapshot ===');
  console.log(`Processes: ${snapshot.processCount}`);
  console.log(`Total messages: ${snapshot.totalMessages}`);
  console.log(`Memory: ${(snapshot.memoryStats.heapUsed / 1024 / 1024).toFixed(2)} MB`);

  // Print process tree
  console.log('\n=== Process Tree ===');
  for (const node of snapshot.tree) {
    const name = node.name || node.id;
    console.log(`- ${node.type}: ${name}`);
  }

  // Start polling for updates
  const stopPolling = Observer.startPolling(5000, (event) => {
    if (event.type === 'stats_update') {
      const snapshot = Observer.getSnapshot();
      console.log(`\n[Poll] ${snapshot.processCount} processes, ${snapshot.totalMessages} messages`);
    }
  });

  // Generate some activity
  for (let i = 0; i < 10; i++) {
    GenServer.cast(counter, 'inc');
  }

  // Wait a bit
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Final stats
  const finalStats = Observer.getServerStats();
  console.log('\n=== Final Stats ===');
  for (const server of finalStats) {
    console.log(`${server.name}: ${server.messageCount} messages`);
  }

  // Cleanup
  stopPolling();
  unsubscribe();
  await GenServer.stop(counter);
}

main().catch(console.error);
```

---

## Dashboard Integration

The Observer is designed to power monitoring dashboards:

```typescript
import { Observer } from 'noex';
import { Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';

// Create WebSocket server for real-time updates
const wss = new WebSocketServer({ port: 8080 });

// Broadcast updates to all connected clients
Observer.startPolling(1000, (event) => {
  if (event.type === 'stats_update') {
    const snapshot = Observer.getSnapshot();
    const data = JSON.stringify({
      type: 'snapshot',
      data: snapshot,
    });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }
});

// Forward lifecycle events
Observer.subscribe((event) => {
  const data = JSON.stringify({
    type: 'event',
    data: event,
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
});
```

---

## Related

- [AlertManager API](./alert-manager.md) - Alert configuration
- [Dashboard API](./dashboard.md) - Web dashboard
- [GenServer API](./genserver.md) - Process implementation
- [Supervisor API](./supervisor.md) - Process supervision
