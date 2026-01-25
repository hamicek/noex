# Observer

In previous chapters, you learned how to build production applications with configuration, logging, and health checks. Now it's time to explore **Observer** — the built-in module for process introspection that gives you real-time visibility into your noex application's internal state.

## What You'll Learn

- Query runtime statistics for all GenServers and Supervisors
- Build complete process tree hierarchies
- Subscribe to real-time lifecycle events
- Poll for periodic statistics updates
- Export data for external monitoring systems
- Stop processes programmatically for administrative tasks

## Process Introspection

Observer provides a unified API for inspecting the runtime state of all noex processes. Think of it as a window into your application's internals — you can see every running process, its statistics, message throughput, and memory usage.

### System Snapshot

The `getSnapshot()` method returns a complete point-in-time view of your system:

```typescript
import { Observer } from '@hamicek/noex';

const snapshot = Observer.getSnapshot();

console.log(`Timestamp: ${new Date(snapshot.timestamp).toISOString()}`);
console.log(`Total processes: ${snapshot.processCount}`);
console.log(`GenServers: ${snapshot.servers.length}`);
console.log(`Supervisors: ${snapshot.supervisors.length}`);
console.log(`Total messages processed: ${snapshot.totalMessages}`);
console.log(`Total restarts: ${snapshot.totalRestarts}`);
```

The snapshot includes:

| Property | Type | Description |
|----------|------|-------------|
| `timestamp` | `number` | Unix timestamp when snapshot was taken |
| `servers` | `GenServerStats[]` | Statistics for all GenServers |
| `supervisors` | `SupervisorStats[]` | Statistics for all Supervisors |
| `tree` | `ProcessTreeNode[]` | Hierarchical process tree |
| `processCount` | `number` | Total running processes |
| `totalMessages` | `number` | Sum of all messages processed |
| `totalRestarts` | `number` | Sum of all supervisor restarts |
| `memoryStats` | `MemoryStats` | Node.js memory statistics |

### GenServer Statistics

Each GenServer exposes detailed runtime statistics:

```typescript
const servers = Observer.getServerStats();

for (const server of servers) {
  console.log(`Server: ${server.id}`);
  console.log(`  Status: ${server.status}`);
  console.log(`  Queue size: ${server.queueSize}`);
  console.log(`  Messages processed: ${server.messageCount}`);
  console.log(`  Uptime: ${Math.round(server.uptimeMs / 1000)}s`);
  console.log(`  Started at: ${new Date(server.startedAt).toISOString()}`);

  if (server.stateMemoryBytes) {
    console.log(`  State memory: ${Math.round(server.stateMemoryBytes / 1024)}KB`);
  }
}
```

**GenServerStats fields:**

```typescript
interface GenServerStats {
  readonly id: string;              // Unique identifier
  readonly status: ServerStatus;    // 'running' | 'stopping' | 'stopped'
  readonly queueSize: number;       // Messages waiting in queue
  readonly messageCount: number;    // Total messages processed
  readonly startedAt: number;       // Unix timestamp
  readonly uptimeMs: number;        // Time since start
  readonly stateMemoryBytes?: number; // Estimated state memory
}
```

### Supervisor Statistics

Supervisors expose their restart strategy and child management data:

```typescript
const supervisors = Observer.getSupervisorStats();

for (const sup of supervisors) {
  console.log(`Supervisor: ${sup.id}`);
  console.log(`  Strategy: ${sup.strategy}`);
  console.log(`  Children: ${sup.childCount}`);
  console.log(`  Total restarts: ${sup.totalRestarts}`);
  console.log(`  Uptime: ${Math.round(sup.uptimeMs / 1000)}s`);
}
```

**SupervisorStats fields:**

```typescript
interface SupervisorStats {
  readonly id: string;                 // Unique identifier
  readonly strategy: SupervisorStrategy; // 'one_for_one' | 'one_for_all' | 'rest_for_one'
  readonly childCount: number;         // Number of managed children
  readonly totalRestarts: number;      // Total child restarts
  readonly startedAt: number;          // Unix timestamp
  readonly uptimeMs: number;           // Time since start
}
```

### Process Tree

The process tree shows the supervision hierarchy — which supervisors manage which processes:

```typescript
const tree = Observer.getProcessTree();

function printTree(nodes: readonly ProcessTreeNode[], indent = 0): void {
  const prefix = '  '.repeat(indent);

  for (const node of nodes) {
    const type = node.type === 'supervisor' ? '[SUP]' : '[GEN]';
    const name = node.name ?? node.id;
    console.log(`${prefix}${type} ${name}`);

    if (node.type === 'supervisor') {
      const stats = node.stats as SupervisorStats;
      console.log(`${prefix}  Strategy: ${stats.strategy}, Restarts: ${stats.totalRestarts}`);
    } else {
      const stats = node.stats as GenServerStats;
      console.log(`${prefix}  Queue: ${stats.queueSize}, Messages: ${stats.messageCount}`);
    }

    if (node.children) {
      printTree(node.children, indent + 1);
    }
  }
}

printTree(tree);
```

Example output:

```
[SUP] app_supervisor
  Strategy: rest_for_one, Restarts: 2
  [GEN] database_pool
    Queue: 0, Messages: 15234
  [GEN] cache_service
    Queue: 3, Messages: 8921
  [SUP] worker_supervisor
    Strategy: one_for_one, Restarts: 5
    [GEN] worker_1
      Queue: 12, Messages: 3456
    [GEN] worker_2
      Queue: 8, Messages: 3201
[GEN] logger
  Queue: 0, Messages: 52341
```

**ProcessTreeNode structure:**

```typescript
interface ProcessTreeNode {
  readonly type: 'genserver' | 'supervisor';
  readonly id: string;
  readonly name?: string;              // Registry name if registered
  readonly stats: GenServerStats | SupervisorStats;
  readonly children?: readonly ProcessTreeNode[]; // Only for supervisors
}
```

### Memory Statistics

Observer provides Node.js memory metrics:

```typescript
const memory = Observer.getMemoryStats();

console.log(`Heap used: ${Math.round(memory.heapUsed / 1024 / 1024)}MB`);
console.log(`Heap total: ${Math.round(memory.heapTotal / 1024 / 1024)}MB`);
console.log(`RSS: ${Math.round(memory.rss / 1024 / 1024)}MB`);
console.log(`External: ${Math.round(memory.external / 1024 / 1024)}MB`);
```

**MemoryStats fields:**

```typescript
interface MemoryStats {
  readonly heapUsed: number;   // V8 heap in use (bytes)
  readonly heapTotal: number;  // Total V8 heap allocated (bytes)
  readonly external: number;   // C++ objects bound to JS (bytes)
  readonly rss: number;        // Resident Set Size (bytes)
  readonly timestamp: number;  // When stats were collected
}
```

### Quick Process Count

For lightweight checks, use `getProcessCount()`:

```typescript
const count = Observer.getProcessCount();
console.log(`${count} processes running`);
```

## Real-time Statistics with Polling

For dashboards and monitoring, you often need periodic updates. Observer provides `startPolling()` for this:

```typescript
import { Observer } from '@hamicek/noex';

// Start polling every second
const stopPolling = Observer.startPolling(1000, (event) => {
  if (event.type === 'stats_update') {
    const totalMessages = event.servers.reduce((sum, s) => sum + s.messageCount, 0);
    const totalQueue = event.servers.reduce((sum, s) => sum + s.queueSize, 0);

    console.log(`[${new Date().toISOString()}]`);
    console.log(`  Servers: ${event.servers.length}`);
    console.log(`  Supervisors: ${event.supervisors.length}`);
    console.log(`  Messages: ${totalMessages}`);
    console.log(`  Queue depth: ${totalQueue}`);
  }
});

// Later: stop polling
stopPolling();
```

**Polling behavior:**

1. Immediately emits the first update on start
2. Emits `stats_update` events at the specified interval
3. Automatically triggers alert checks via AlertManager
4. Returns a function to stop polling

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           POLLING TIMELINE                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  startPolling(1000, handler)                                                │
│         │                                                                   │
│         ▼                                                                   │
│  ┌──────────────┐  1s   ┌──────────────┐  1s   ┌──────────────┐            │
│  │ stats_update │ ────► │ stats_update │ ────► │ stats_update │ ──► ...   │
│  │  (immediate) │       │              │       │              │            │
│  └──────────────┘       └──────────────┘       └──────────────┘            │
│         │                      │                      │                     │
│         ▼                      ▼                      ▼                     │
│  ┌──────────────┐       ┌──────────────┐       ┌──────────────┐            │
│  │ AlertManager │       │ AlertManager │       │ AlertManager │            │
│  │   .check()   │       │   .check()   │       │   .check()   │            │
│  └──────────────┘       └──────────────┘       └──────────────┘            │
│                                                                             │
│  stopPolling()                                                              │
│         │                                                                   │
│         ▼                                                                   │
│  ┌──────────────┐                                                          │
│  │   (stopped)  │                                                          │
│  └──────────────┘                                                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Event Streaming

For real-time notifications about process lifecycle changes, use `subscribe()`:

```typescript
import { Observer, type ObserverEvent } from '@hamicek/noex';

const unsubscribe = Observer.subscribe((event: ObserverEvent) => {
  switch (event.type) {
    case 'server_started':
      console.log(`GenServer started: ${event.stats.id}`);
      break;

    case 'server_stopped':
      console.log(`GenServer stopped: ${event.id}, reason: ${event.reason}`);
      break;

    case 'supervisor_started':
      console.log(`Supervisor started: ${event.stats.id}`);
      console.log(`  Strategy: ${event.stats.strategy}`);
      break;

    case 'supervisor_stopped':
      console.log(`Supervisor stopped: ${event.id}`);
      break;

    case 'stats_update':
      // Emitted by startPolling()
      console.log(`Stats update: ${event.servers.length} servers`);
      break;
  }
});

// Later: unsubscribe
unsubscribe();
```

**ObserverEvent types:**

```typescript
type ObserverEvent =
  | { type: 'server_started'; stats: GenServerStats }
  | { type: 'server_stopped'; id: string; reason: TerminateReason }
  | { type: 'supervisor_started'; stats: SupervisorStats }
  | { type: 'supervisor_stopped'; id: string }
  | { type: 'stats_update'; servers: readonly GenServerStats[]; supervisors: readonly SupervisorStats[] };
```

### Combining Subscribe with Polling

You can use both subscription and polling together:

```typescript
// Subscribe for immediate lifecycle events
const unsubscribe = Observer.subscribe((event) => {
  if (event.type === 'server_started') {
    console.log(`New server: ${event.stats.id}`);
  }
  if (event.type === 'server_stopped') {
    console.log(`Server stopped: ${event.id}`);
  }
});

// Poll for periodic aggregated stats
const stopPolling = Observer.startPolling(5000, (event) => {
  if (event.type === 'stats_update') {
    // Update dashboard metrics
  }
});

// Cleanup
function cleanup() {
  unsubscribe();
  stopPolling();
}
```

## Stopping Processes

Observer can stop processes programmatically — useful for admin interfaces or automated remediation:

```typescript
const result = await Observer.stopProcess('genserver_1_abc123', 'Manual shutdown');

if (result.success) {
  console.log('Process stopped successfully');
} else {
  console.error(`Failed to stop process: ${result.error}`);
}
```

The method:

1. Looks up the process by ID (GenServer or Supervisor)
2. Initiates graceful shutdown
3. For Supervisors, stops all child processes first
4. Returns success/failure status with optional error message

## Exporting Data

For integration with external monitoring systems, Observer can prepare data for export:

```typescript
import { Observer, exportToJson, exportToCsv } from '@hamicek/noex/observer';

// Prepare export data
const exportData = Observer.prepareExportData();

// Export as JSON
const jsonString = exportToJson(exportData);
fs.writeFileSync('snapshot.json', jsonString);

// Export as CSV (returns multiple CSVs for different data types)
const csvExport = exportToCsv(exportData);
fs.writeFileSync('servers.csv', csvExport.servers);
fs.writeFileSync('supervisors.csv', csvExport.supervisors);
```

## Practical Example: Monitoring Service

Here's a complete monitoring service that combines Observer features:

```typescript
import {
  GenServer,
  Observer,
  type GenServerBehavior,
  type GenServerRef,
  type ObserverEvent,
} from '@hamicek/noex';

interface MonitorState {
  lastSnapshot: ReturnType<typeof Observer.getSnapshot> | null;
  messageRatePerSecond: number;
  lastMessageCount: number;
  lastCheckTime: number;
  alerts: string[];
}

type MonitorCall =
  | { type: 'getStatus' }
  | { type: 'getAlerts' }
  | { type: 'clearAlerts' };

type MonitorCast =
  | { type: 'checkHealth' };

type MonitorReply =
  | { status: 'healthy' | 'degraded' | 'critical'; details: Record<string, unknown> }
  | { alerts: string[] }
  | { cleared: number };

const MonitorBehavior: GenServerBehavior<MonitorState, MonitorCall, MonitorCast, MonitorReply> = {
  init: () => ({
    lastSnapshot: null,
    messageRatePerSecond: 0,
    lastMessageCount: 0,
    lastCheckTime: Date.now(),
    alerts: [],
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'getStatus': {
        const snapshot = Observer.getSnapshot();
        const memory = snapshot.memoryStats;
        const heapPercent = (memory.heapUsed / memory.heapTotal) * 100;

        // Determine health status
        let status: 'healthy' | 'degraded' | 'critical' = 'healthy';

        if (heapPercent > 90 || snapshot.totalRestarts > 50) {
          status = 'critical';
        } else if (heapPercent > 75 || snapshot.totalRestarts > 20) {
          status = 'degraded';
        }

        return [
          {
            status,
            details: {
              processCount: snapshot.processCount,
              totalMessages: snapshot.totalMessages,
              totalRestarts: snapshot.totalRestarts,
              messageRatePerSecond: state.messageRatePerSecond,
              heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
              heapPercent: Math.round(heapPercent),
              alertCount: state.alerts.length,
            },
          },
          { ...state, lastSnapshot: snapshot },
        ];
      }

      case 'getAlerts':
        return [{ alerts: state.alerts }, state];

      case 'clearAlerts': {
        const count = state.alerts.length;
        return [{ cleared: count }, { ...state, alerts: [] }];
      }
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'checkHealth') {
      const snapshot = Observer.getSnapshot();
      const now = Date.now();
      const elapsed = (now - state.lastCheckTime) / 1000;

      // Calculate message rate
      const messageRate = elapsed > 0
        ? (snapshot.totalMessages - state.lastMessageCount) / elapsed
        : 0;

      // Check for issues and generate alerts
      const newAlerts: string[] = [];

      // Check queue depths
      for (const server of snapshot.servers) {
        if (server.queueSize > 100) {
          newAlerts.push(
            `High queue depth on ${server.id}: ${server.queueSize} messages`
          );
        }
      }

      // Check memory
      const heapPercent = (snapshot.memoryStats.heapUsed / snapshot.memoryStats.heapTotal) * 100;
      if (heapPercent > 85) {
        newAlerts.push(`High memory usage: ${Math.round(heapPercent)}%`);
      }

      // Check restart rate
      if (state.lastSnapshot && snapshot.totalRestarts - state.lastSnapshot.totalRestarts > 5) {
        newAlerts.push(
          `High restart rate: ${snapshot.totalRestarts - state.lastSnapshot.totalRestarts} restarts in check interval`
        );
      }

      return {
        ...state,
        lastSnapshot: snapshot,
        messageRatePerSecond: messageRate,
        lastMessageCount: snapshot.totalMessages,
        lastCheckTime: now,
        alerts: [...state.alerts, ...newAlerts].slice(-100), // Keep last 100 alerts
      };
    }

    return state;
  },
};

// Usage
async function startMonitoring(): Promise<{
  monitor: GenServerRef;
  stopPolling: () => void;
  unsubscribe: () => void;
}> {
  const monitor = await GenServer.start(MonitorBehavior, { name: 'monitor' });

  // Periodic health checks
  const stopPolling = Observer.startPolling(5000, () => {
    GenServer.cast(monitor, { type: 'checkHealth' });
  });

  // Log lifecycle events
  const unsubscribe = Observer.subscribe((event) => {
    if (event.type === 'server_stopped') {
      console.log(`[Monitor] Server stopped: ${event.id}, reason: ${event.reason}`);
    }
  });

  return { monitor, stopPolling, unsubscribe };
}

// Query the monitor
async function getSystemStatus(monitor: GenServerRef) {
  const status = await GenServer.call(monitor, { type: 'getStatus' });

  console.log(`System status: ${status.status}`);
  console.log(`  Processes: ${status.details.processCount}`);
  console.log(`  Message rate: ${status.details.messageRatePerSecond}/s`);
  console.log(`  Heap: ${status.details.heapUsedMB}MB (${status.details.heapPercent}%)`);
  console.log(`  Active alerts: ${status.details.alertCount}`);

  return status;
}
```

## Exercise: Process Dashboard

Build a terminal-based dashboard that displays real-time process information.

**Requirements:**

1. Display process tree with live statistics
2. Show message throughput rate (messages/second)
3. Highlight processes with high queue depth (> 50)
4. Track and display restart events
5. Refresh every 2 seconds

**Starter code:**

```typescript
import {
  Observer,
  GenServer,
  Supervisor,
  type ProcessTreeNode,
  type GenServerStats,
  type SupervisorStats,
  type ObserverEvent,
} from '@hamicek/noex';

interface DashboardState {
  previousTotalMessages: number;
  messageRate: number;
  recentRestarts: Array<{ time: number; processId: string }>;
}

// TODO: Initialize dashboard state
let state: DashboardState = {
  // ...
};

// TODO: Implement tree rendering function
function renderTree(nodes: readonly ProcessTreeNode[], indent: number): void {
  // Print each node with statistics
  // Highlight high queue depth
}

// TODO: Implement dashboard update function
function updateDashboard(event: ObserverEvent): void {
  // Clear console
  // Calculate message rate
  // Render header
  // Render process tree
  // Render recent restarts
}

// TODO: Subscribe to lifecycle events for restart tracking
const unsubscribe = Observer.subscribe((event) => {
  // Track restarts
});

// TODO: Start polling for periodic updates
const stopPolling = Observer.startPolling(2000, updateDashboard);

// TODO: Handle cleanup on exit
process.on('SIGINT', () => {
  unsubscribe();
  stopPolling();
  process.exit(0);
});
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
import {
  Observer,
  GenServer,
  Supervisor,
  type ProcessTreeNode,
  type GenServerStats,
  type SupervisorStats,
  type ObserverEvent,
} from '@hamicek/noex';

// ANSI escape codes for colors
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

interface DashboardState {
  previousTotalMessages: number;
  previousTimestamp: number;
  messageRate: number;
  recentRestarts: Array<{ time: number; processId: string; reason?: string }>;
}

let state: DashboardState = {
  previousTotalMessages: 0,
  previousTimestamp: Date.now(),
  messageRate: 0,
  recentRestarts: [],
};

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

function renderTree(nodes: readonly ProcessTreeNode[], indent = 0): void {
  const prefix = '  '.repeat(indent);
  const connector = indent > 0 ? '├─ ' : '';

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const linePrefix = indent > 0 ? (isLast ? '└─ ' : '├─ ') : '';

    if (node.type === 'supervisor') {
      const stats = node.stats as SupervisorStats;
      const name = node.name ?? node.id.slice(0, 20);
      const restartColor = stats.totalRestarts > 10 ? RED : stats.totalRestarts > 0 ? YELLOW : GREEN;

      console.log(
        `${prefix}${linePrefix}${BLUE}[SUP]${RESET} ${BOLD}${name}${RESET} ` +
        `${DIM}strategy:${RESET}${stats.strategy} ` +
        `${DIM}children:${RESET}${stats.childCount} ` +
        `${DIM}restarts:${RESET}${restartColor}${stats.totalRestarts}${RESET} ` +
        `${DIM}uptime:${RESET}${formatUptime(stats.uptimeMs)}`
      );

      if (node.children && node.children.length > 0) {
        renderTree(node.children, indent + 1);
      }
    } else {
      const stats = node.stats as GenServerStats;
      const name = node.name ?? node.id.slice(0, 20);
      const queueColor = stats.queueSize > 100 ? RED : stats.queueSize > 50 ? YELLOW : GREEN;
      const highlight = stats.queueSize > 50 ? BOLD : '';

      console.log(
        `${prefix}${linePrefix}${CYAN}[GEN]${RESET} ${highlight}${name}${RESET} ` +
        `${DIM}queue:${RESET}${queueColor}${stats.queueSize}${RESET} ` +
        `${DIM}msgs:${RESET}${stats.messageCount} ` +
        `${DIM}uptime:${RESET}${formatUptime(stats.uptimeMs)}` +
        (stats.stateMemoryBytes ? ` ${DIM}mem:${RESET}${formatBytes(stats.stateMemoryBytes)}` : '')
      );
    }
  }
}

function updateDashboard(event: ObserverEvent): void {
  if (event.type !== 'stats_update') return;

  // Clear console
  console.clear();

  const snapshot = Observer.getSnapshot();
  const now = Date.now();

  // Calculate message rate
  const elapsed = (now - state.previousTimestamp) / 1000;
  if (elapsed > 0) {
    state.messageRate = (snapshot.totalMessages - state.previousTotalMessages) / elapsed;
  }
  state.previousTotalMessages = snapshot.totalMessages;
  state.previousTimestamp = now;

  // Header
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}                    NOEX PROCESS DASHBOARD                      ${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log();

  // Summary stats
  const memory = snapshot.memoryStats;
  const heapPercent = Math.round((memory.heapUsed / memory.heapTotal) * 100);
  const heapColor = heapPercent > 80 ? RED : heapPercent > 60 ? YELLOW : GREEN;

  console.log(`${BOLD}System Overview${RESET}`);
  console.log(`  Processes:    ${snapshot.processCount} (${snapshot.servers.length} GenServers, ${snapshot.supervisors.length} Supervisors)`);
  console.log(`  Messages:     ${snapshot.totalMessages} total (${GREEN}${state.messageRate.toFixed(1)}/s${RESET})`);
  console.log(`  Restarts:     ${snapshot.totalRestarts > 0 ? YELLOW : GREEN}${snapshot.totalRestarts}${RESET}`);
  console.log(`  Heap:         ${heapColor}${formatBytes(memory.heapUsed)}${RESET} / ${formatBytes(memory.heapTotal)} (${heapPercent}%)`);
  console.log(`  RSS:          ${formatBytes(memory.rss)}`);
  console.log();

  // Process tree
  console.log(`${BOLD}Process Tree${RESET}`);
  if (snapshot.tree.length === 0) {
    console.log(`  ${DIM}(no processes)${RESET}`);
  } else {
    renderTree(snapshot.tree);
  }
  console.log();

  // High queue warnings
  const highQueueProcesses = snapshot.servers.filter(s => s.queueSize > 50);
  if (highQueueProcesses.length > 0) {
    console.log(`${BOLD}${YELLOW}⚠ High Queue Depth${RESET}`);
    for (const server of highQueueProcesses) {
      const color = server.queueSize > 100 ? RED : YELLOW;
      console.log(`  ${color}${server.id}: ${server.queueSize} messages${RESET}`);
    }
    console.log();
  }

  // Recent restarts
  if (state.recentRestarts.length > 0) {
    console.log(`${BOLD}Recent Restarts${RESET}`);
    const recentEvents = state.recentRestarts.slice(-5);
    for (const restart of recentEvents) {
      const ago = Math.round((now - restart.time) / 1000);
      console.log(`  ${YELLOW}${restart.processId}${RESET} - ${ago}s ago${restart.reason ? ` (${restart.reason})` : ''}`);
    }
    console.log();
  }

  // Footer
  console.log(`${DIM}Last updated: ${new Date(snapshot.timestamp).toISOString()} | Press Ctrl+C to exit${RESET}`);
}

// Subscribe to lifecycle events for restart tracking
const unsubscribe = Observer.subscribe((event) => {
  if (event.type === 'server_stopped') {
    // Track potential restarts (servers that stop abnormally may restart)
    const reason = typeof event.reason === 'string' ? event.reason : 'error';
    if (reason !== 'normal' && reason !== 'shutdown') {
      state.recentRestarts.push({
        time: Date.now(),
        processId: event.id,
        reason,
      });
      // Keep only last 20 restarts
      state.recentRestarts = state.recentRestarts.slice(-20);
    }
  }
});

// Start polling for periodic updates
const stopPolling = Observer.startPolling(2000, updateDashboard);

// Handle cleanup on exit
process.on('SIGINT', () => {
  console.log('\nShutting down dashboard...');
  unsubscribe();
  stopPolling();
  process.exit(0);
});

console.log('Starting dashboard... (Ctrl+C to exit)');
```

**Sample output:**

```
═══════════════════════════════════════════════════════════════
                    NOEX PROCESS DASHBOARD
═══════════════════════════════════════════════════════════════

System Overview
  Processes:    8 (6 GenServers, 2 Supervisors)
  Messages:     15234 total (127.3/s)
  Restarts:     3
  Heap:         45MB / 128MB (35%)
  RSS:          82MB

Process Tree
[SUP] app_supervisor strategy:rest_for_one children:4 restarts:2 uptime:5m 23s
  ├─ [GEN] database_pool queue:0 msgs:5234 uptime:5m 22s mem:2MB
  ├─ [GEN] cache_service queue:3 msgs:3421 uptime:5m 22s mem:512KB
  └─ [SUP] worker_supervisor strategy:one_for_one children:2 restarts:1 uptime:5m 21s
      ├─ [GEN] worker_1 queue:12 msgs:3456 uptime:2m 15s
      └─ [GEN] worker_2 queue:8 msgs:3123 uptime:5m 20s
[GEN] logger queue:0 msgs:0 uptime:5m 23s

⚠ High Queue Depth
  worker_1: 67 messages

Recent Restarts
  worker_1 - 180s ago (error)

Last updated: 2024-01-25T12:00:00.000Z | Press Ctrl+C to exit
```

</details>

## Summary

**Key takeaways:**

- **Observer.getSnapshot()** returns a complete point-in-time system view
- **Observer.getServerStats()** and **getSupervisorStats()** provide detailed process metrics
- **Observer.getProcessTree()** shows the supervision hierarchy
- **Observer.subscribe()** streams real-time lifecycle events
- **Observer.startPolling()** provides periodic stats updates with automatic alert checking
- **Observer.stopProcess()** enables programmatic process control

**Observer API at a glance:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           OBSERVER API OVERVIEW                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  INTROSPECTION                                                              │
│  ─────────────────────────────────────────────────────────────────────────  │
│  getSnapshot()        → Complete system snapshot                            │
│  getServerStats()     → All GenServer statistics                            │
│  getSupervisorStats() → All Supervisor statistics                           │
│  getProcessTree()     → Hierarchical process tree                           │
│  getProcessCount()    → Quick process count                                 │
│  getMemoryStats()     → Node.js memory metrics                              │
│                                                                             │
│  REAL-TIME MONITORING                                                       │
│  ─────────────────────────────────────────────────────────────────────────  │
│  subscribe(handler)           → Stream lifecycle events                     │
│  startPolling(ms, handler)    → Periodic stats updates                      │
│                                                                             │
│  ALERTS (via AlertManager)                                                  │
│  ─────────────────────────────────────────────────────────────────────────  │
│  subscribeToAlerts(handler)   → Stream alert events                         │
│  getActiveAlerts()            → Current active alerts                       │
│                                                                             │
│  ADMINISTRATION                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  stopProcess(id, reason)      → Gracefully stop a process                   │
│  prepareExportData()          → Prepare data for export                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**When to use Observer:**

| Scenario | Method |
|----------|--------|
| Health check endpoint | `getSnapshot()` |
| Monitoring dashboard | `startPolling()` |
| Log process events | `subscribe()` |
| Debug supervision tree | `getProcessTree()` |
| Export metrics | `prepareExportData()` |
| Admin UI stop button | `stopProcess()` |

**Remember:**

> Observer gives you eyes into your running application. Use it to build health checks, dashboards, and alerting systems. The combination of snapshots for point-in-time queries and subscriptions for real-time events covers most monitoring needs.

---

Next: [Dashboard](./02-dashboard.md)
