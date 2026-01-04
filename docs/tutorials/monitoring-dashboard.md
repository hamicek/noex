# Tutorial: Building a Monitoring Dashboard

In this tutorial, you'll add real-time monitoring to a noex application. You'll learn how to:
- Use the Observer for system introspection
- Display process statistics in real-time
- Set up alerts for critical conditions
- Build a TUI dashboard with blessed
- Create a web-based monitoring endpoint

## Prerequisites

- Node.js 18+
- A running noex application (we'll use a simple example)
- Basic TypeScript knowledge

## Project Setup

Create a new project:

```bash
mkdir monitoring-dashboard
cd monitoring-dashboard
npm init -y
npm install noex blessed blessed-contrib
npm install -D typescript tsx @types/node
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

## Architecture Overview

```
                    [Application]
                         |
                    [Observer]
                    /    |    \
              [Stats] [Tree] [Events]
                         |
              +----------+----------+
              |          |          |
          [TUI]    [Web API]   [Alerts]
```

The Observer provides real-time data about:
- Running GenServers and their message counts
- Supervisors and restart statistics
- Process hierarchy tree
- Memory usage
- Lifecycle events

---

## Step 1: Sample Application

First, create a sample application to monitor. Create `src/app.ts`:

```typescript
import {
  GenServer,
  Supervisor,
  type GenServerBehavior,
  type GenServerRef,
  type SupervisorRef,
} from 'noex';

// Counter GenServer
interface CounterState {
  count: number;
}

type CounterCall = { type: 'get' } | { type: 'increment' };
type CounterCast = { type: 'reset' };
type CounterReply = number;

const counterBehavior: GenServerBehavior<CounterState, CounterCall, CounterCast, CounterReply> = {
  init: () => ({ count: 0 }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.count, state];
      case 'increment':
        return [state.count + 1, { count: state.count + 1 }];
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'reset') {
      return { count: 0 };
    }
    return state;
  },
};

// Worker that processes tasks
interface WorkerState {
  processed: number;
  name: string;
}

type WorkerCall = { type: 'get_stats' };
type WorkerCast = { type: 'process'; task: string };
type WorkerReply = { name: string; processed: number };

function createWorkerBehavior(name: string): GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerReply> {
  return {
    init: () => ({ processed: 0, name }),

    handleCall: (msg, state) => {
      if (msg.type === 'get_stats') {
        return [{ name: state.name, processed: state.processed }, state];
      }
      return [{ name: state.name, processed: state.processed }, state];
    },

    handleCast: (msg, state) => {
      if (msg.type === 'process') {
        // Simulate work
        return { ...state, processed: state.processed + 1 };
      }
      return state;
    },
  };
}

export interface AppRefs {
  supervisor: SupervisorRef;
  counter: GenServerRef<CounterState, CounterCall, CounterCast, CounterReply>;
  workers: GenServerRef<WorkerState, WorkerCall, WorkerCast, WorkerReply>[];
}

/**
 * Start the sample application
 */
export async function startApp(): Promise<AppRefs> {
  // Start counter
  const counter = await GenServer.start(counterBehavior, { name: 'counter' });

  // Start workers under a supervisor
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'worker-1', start: () => GenServer.start(createWorkerBehavior('worker-1'), { name: 'worker-1' }) },
      { id: 'worker-2', start: () => GenServer.start(createWorkerBehavior('worker-2'), { name: 'worker-2' }) },
      { id: 'worker-3', start: () => GenServer.start(createWorkerBehavior('worker-3'), { name: 'worker-3' }) },
    ],
    restartIntensity: { maxRestarts: 5, withinMs: 60000 },
  });

  const children = Supervisor.getChildren(supervisor);
  const workers = children.map(c => c.ref as GenServerRef<WorkerState, WorkerCall, WorkerCast, WorkerReply>);

  return { supervisor, counter, workers };
}

/**
 * Generate activity for monitoring
 */
export function startActivityGenerator(refs: AppRefs): () => void {
  const interval = setInterval(() => {
    // Increment counter
    GenServer.call(refs.counter, { type: 'increment' });

    // Send tasks to workers
    for (const worker of refs.workers) {
      GenServer.cast(worker, { type: 'process', task: `task_${Date.now()}` });
    }
  }, 500);

  return () => clearInterval(interval);
}
```

---

## Step 2: Observer Integration

Create `src/monitoring.ts`:

```typescript
import { Observer, type ObserverSnapshot, type ObserverEvent } from 'noex';

/**
 * Print a formatted snapshot to console
 */
export function printSnapshot(snapshot: ObserverSnapshot): void {
  console.clear();
  console.log('\x1b[36m' + '='.repeat(60) + '\x1b[0m');
  console.log('\x1b[36m  NOEX OBSERVER\x1b[0m');
  console.log('\x1b[36m' + '='.repeat(60) + '\x1b[0m');

  // Summary
  console.log(`
  Processes: ${snapshot.processCount}
  Total Messages: ${snapshot.totalMessages}
  Total Restarts: ${snapshot.totalRestarts}
  Heap Used: ${(snapshot.memoryStats.heapUsed / 1024 / 1024).toFixed(2)} MB
  `);

  // GenServers table
  console.log('\x1b[33m  GenServers:\x1b[0m');
  console.log('  ' + '-'.repeat(56));

  for (const server of snapshot.servers) {
    const status = server.status === 'running' ? '\x1b[32m●\x1b[0m' : '\x1b[31m●\x1b[0m';
    const name = (server.name || server.id).substring(0, 20).padEnd(20);
    const msgs = server.messageCount.toString().padStart(6);
    console.log(`  ${status} ${name} | messages: ${msgs}`);
  }

  // Supervisors
  console.log('\n\x1b[33m  Supervisors:\x1b[0m');
  console.log('  ' + '-'.repeat(56));

  for (const sup of snapshot.supervisors) {
    const name = (sup.name || sup.id).substring(0, 20).padEnd(20);
    console.log(`  ${name} | children: ${sup.childCount} | restarts: ${sup.totalRestarts} | ${sup.strategy}`);
  }

  console.log('\n\x1b[36m' + '='.repeat(60) + '\x1b[0m');
  console.log('  Press Ctrl+C to exit');
}

/**
 * Print process tree
 */
export function printProcessTree(): void {
  const tree = Observer.getProcessTree();

  console.log('\n\x1b[35m  Process Tree:\x1b[0m');

  function printNode(
    node: typeof tree[0],
    prefix: string = '',
    isLast: boolean = true
  ): void {
    const connector = isLast ? '└── ' : '├── ';
    const icon = node.type === 'supervisor' ? '\x1b[33m[SUP]\x1b[0m' : '\x1b[32m[GEN]\x1b[0m';
    const name = node.name || node.id;

    console.log(`  ${prefix}${connector}${icon} ${name}`);

    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    node.children.forEach((child, index) => {
      printNode(child, childPrefix, index === node.children.length - 1);
    });
  }

  tree.forEach((node, index) => {
    printNode(node, '', index === tree.length - 1);
  });
}

/**
 * Start live monitoring with polling
 */
export function startLiveMonitoring(intervalMs: number = 1000): () => void {
  const stopPolling = Observer.startPolling(intervalMs, (event) => {
    if (event.type === 'stats_update') {
      const snapshot = Observer.getSnapshot();
      printSnapshot(snapshot);
    }
  });

  // Also subscribe to lifecycle events
  const unsubscribe = Observer.subscribe((event) => {
    logEvent(event);
  });

  return () => {
    stopPolling();
    unsubscribe();
  };
}

/**
 * Log lifecycle events
 */
function logEvent(event: ObserverEvent): void {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);

  switch (event.type) {
    case 'server_started':
      console.log(`[${timestamp}] \x1b[32m+\x1b[0m Server started: ${event.stats.name || event.stats.id}`);
      break;
    case 'server_stopped':
      console.log(`[${timestamp}] \x1b[31m-\x1b[0m Server stopped: ${event.id} (${event.reason})`);
      break;
    case 'supervisor_started':
      console.log(`[${timestamp}] \x1b[32m+\x1b[0m Supervisor started: ${event.stats.name || event.stats.id}`);
      break;
    case 'supervisor_stopped':
      console.log(`[${timestamp}] \x1b[31m-\x1b[0m Supervisor stopped: ${event.id}`);
      break;
  }
}
```

---

## Step 3: Alert Configuration

Create `src/alerts.ts`:

```typescript
import { Observer, AlertManager, type Alert } from 'noex';

/**
 * Configure system alerts
 */
export function setupAlerts(): () => void {
  // Configure alert thresholds
  AlertManager.configure({
    messageRateThreshold: 100,      // Alert if > 100 msgs/sec
    restartRateThreshold: 3,        // Alert if > 3 restarts/min
    memoryThresholdPercent: 80,     // Alert if heap > 80%
    queueSizeThreshold: 50,         // Alert if queue > 50 messages
  });

  // Subscribe to alert events
  const unsubscribe = Observer.subscribeToAlerts((event) => {
    if (event.type === 'alert_triggered') {
      handleAlert(event.alert);
    } else if (event.type === 'alert_resolved') {
      console.log(`\x1b[32m[RESOLVED]\x1b[0m Alert resolved for ${event.processId}`);
    }
  });

  return unsubscribe;
}

/**
 * Handle triggered alerts
 */
function handleAlert(alert: Alert): void {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);

  switch (alert.type) {
    case 'high_message_rate':
      console.log(`\x1b[31m[ALERT ${timestamp}]\x1b[0m High message rate on ${alert.processId}: ${alert.currentValue}/sec (threshold: ${alert.threshold})`);
      break;

    case 'high_restart_rate':
      console.log(`\x1b[31m[ALERT ${timestamp}]\x1b[0m High restart rate on ${alert.processId}: ${alert.currentValue} restarts (threshold: ${alert.threshold})`);
      break;

    case 'high_memory':
      console.log(`\x1b[31m[ALERT ${timestamp}]\x1b[0m High memory usage: ${alert.currentValue}% (threshold: ${alert.threshold}%)`);
      break;

    case 'queue_overflow':
      console.log(`\x1b[31m[ALERT ${timestamp}]\x1b[0m Queue overflow on ${alert.processId}: ${alert.currentValue} messages (threshold: ${alert.threshold})`);
      break;
  }
}

/**
 * Get all active alerts
 */
export function getActiveAlerts(): readonly Alert[] {
  return Observer.getActiveAlerts();
}
```

---

## Step 4: Built-in TUI Dashboard

The simplest way to monitor is using the built-in Dashboard. Create `src/dashboard-example.ts`:

```typescript
import { Dashboard } from 'noex/dashboard';
import { startApp, startActivityGenerator } from './app.js';

async function main() {
  // Start the application
  const refs = await startApp();
  const stopActivity = startActivityGenerator(refs);

  // Create and start dashboard
  const dashboard = new Dashboard({
    refreshInterval: 500,
    theme: 'dark',
    layout: 'full',
  });

  dashboard.start();

  // Handle shutdown
  process.on('SIGINT', async () => {
    stopActivity();
    dashboard.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

Run with:

```bash
npx tsx src/dashboard-example.ts
```

### Dashboard Controls

| Key | Action |
|-----|--------|
| `q` / `Escape` | Quit |
| `r` | Refresh |
| `1` / `2` / `3` | Switch layouts |
| `Tab` | Focus next widget |
| `Enter` | Show process details |
| `?` / `h` | Help |

---

## Step 5: Web-Based Monitoring

For remote monitoring, create a web endpoint. Create `src/web-monitor.ts`:

```typescript
import express from 'express';
import { Observer } from 'noex';
import { startApp, startActivityGenerator } from './app.js';
import { setupAlerts, getActiveAlerts } from './alerts.js';

async function main() {
  const port = parseInt(process.env.PORT || '8080', 10);

  // Start the application
  const refs = await startApp();
  const stopActivity = startActivityGenerator(refs);
  const stopAlerts = setupAlerts();

  // Create Express app
  const app = express();

  // JSON API endpoints
  app.get('/api/snapshot', (_req, res) => {
    const snapshot = Observer.getSnapshot();
    res.json(snapshot);
  });

  app.get('/api/servers', (_req, res) => {
    const servers = Observer.getServerStats();
    res.json(servers);
  });

  app.get('/api/supervisors', (_req, res) => {
    const supervisors = Observer.getSupervisorStats();
    res.json(supervisors);
  });

  app.get('/api/tree', (_req, res) => {
    const tree = Observer.getProcessTree();
    res.json(tree);
  });

  app.get('/api/memory', (_req, res) => {
    const memory = Observer.getMemoryStats();
    res.json(memory);
  });

  app.get('/api/alerts', (_req, res) => {
    const alerts = getActiveAlerts();
    res.json(alerts);
  });

  // Simple HTML dashboard
  app.get('/', (_req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>noex Monitor</title>
  <style>
    body { font-family: monospace; background: #1a1a2e; color: #eee; padding: 20px; }
    h1 { color: #e94560; }
    .stats { display: flex; gap: 20px; margin: 20px 0; }
    .stat { background: #16213e; padding: 15px; border-radius: 8px; }
    .stat h3 { margin: 0 0 10px; color: #0f3460; }
    .stat .value { font-size: 24px; color: #e94560; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
    th { background: #16213e; color: #e94560; }
    .running { color: #4caf50; }
    .stopped { color: #f44336; }
  </style>
</head>
<body>
  <h1>noex Monitor</h1>
  <div class="stats">
    <div class="stat">
      <h3>Processes</h3>
      <div class="value" id="processes">-</div>
    </div>
    <div class="stat">
      <h3>Messages</h3>
      <div class="value" id="messages">-</div>
    </div>
    <div class="stat">
      <h3>Restarts</h3>
      <div class="value" id="restarts">-</div>
    </div>
    <div class="stat">
      <h3>Memory</h3>
      <div class="value" id="memory">-</div>
    </div>
  </div>

  <h2>GenServers</h2>
  <table id="servers">
    <thead>
      <tr>
        <th>Status</th>
        <th>Name</th>
        <th>Messages</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

  <h2>Supervisors</h2>
  <table id="supervisors">
    <thead>
      <tr>
        <th>Name</th>
        <th>Strategy</th>
        <th>Children</th>
        <th>Restarts</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

  <script>
    async function refresh() {
      const res = await fetch('/api/snapshot');
      const data = await res.json();

      document.getElementById('processes').textContent = data.processCount;
      document.getElementById('messages').textContent = data.totalMessages;
      document.getElementById('restarts').textContent = data.totalRestarts;
      document.getElementById('memory').textContent =
        (data.memoryStats.heapUsed / 1024 / 1024).toFixed(1) + ' MB';

      // Update servers table
      const serversBody = document.querySelector('#servers tbody');
      serversBody.innerHTML = data.servers.map(s => \`
        <tr>
          <td class="\${s.status}">\${s.status === 'running' ? '●' : '○'}</td>
          <td>\${s.name || s.id}</td>
          <td>\${s.messageCount}</td>
        </tr>
      \`).join('');

      // Update supervisors table
      const supervisorsBody = document.querySelector('#supervisors tbody');
      supervisorsBody.innerHTML = data.supervisors.map(s => \`
        <tr>
          <td>\${s.name || s.id}</td>
          <td>\${s.strategy}</td>
          <td>\${s.childCount}</td>
          <td>\${s.totalRestarts}</td>
        </tr>
      \`).join('');
    }

    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>
    `);
  });

  // Start server
  const server = app.listen(port, () => {
    console.log(`Monitor running at http://localhost:${port}`);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    stopActivity();
    stopAlerts();
    server.close();
    process.exit(0);
  });
}

main().catch(console.error);
```

Run with:

```bash
npx tsx src/web-monitor.ts
```

Open `http://localhost:8080` in your browser to see the dashboard.

---

## Step 6: Console-Based Live Monitor

For a simple console monitor, create `src/console-monitor.ts`:

```typescript
import { Observer } from 'noex';
import { startApp, startActivityGenerator } from './app.js';
import { printSnapshot, printProcessTree } from './monitoring.js';
import { setupAlerts } from './alerts.js';

async function main() {
  // Start the application
  const refs = await startApp();
  const stopActivity = startActivityGenerator(refs);
  const stopAlerts = setupAlerts();

  console.log('Starting live monitoring...\n');

  // Print initial tree
  printProcessTree();

  // Start live monitoring
  const stopMonitoring = Observer.startPolling(1000, () => {
    const snapshot = Observer.getSnapshot();
    printSnapshot(snapshot);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    stopActivity();
    stopAlerts();
    stopMonitoring();
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Step 7: Remote TUI Dashboard

For connecting to a remote noex application, use the DashboardServer:

In your application (`src/app-with-dashboard-server.ts`):

```typescript
import { DashboardServer } from 'noex';
import { startApp, startActivityGenerator } from './app.js';

async function main() {
  // Start the application
  const refs = await startApp();
  const stopActivity = startActivityGenerator(refs);

  // Start Dashboard Server
  const dashboardServer = await DashboardServer.start({
    port: 9876,
  });

  console.log('Application running with DashboardServer on port 9876');
  console.log('Connect from another terminal with: npx noex-dashboard --port 9876');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    stopActivity();
    await DashboardServer.stop(dashboardServer);
    process.exit(0);
  });
}

main().catch(console.error);
```

From another terminal, connect:

```bash
npx noex-dashboard --port 9876
```

---

## Step 8: Export Data

Export monitoring data for external tools. Create `src/export.ts`:

```typescript
import { Observer, exportToJson, exportToCsv } from 'noex/observer';
import { writeFileSync } from 'fs';

/**
 * Export current state to JSON
 */
export function exportJsonSnapshot(filename: string): void {
  const data = Observer.prepareExportData();
  const json = exportToJson(data);
  writeFileSync(filename, json);
  console.log(`Exported JSON to ${filename}`);
}

/**
 * Export current state to CSV files
 */
export function exportCsvSnapshot(prefix: string): void {
  const data = Observer.prepareExportData();
  const csvs = exportToCsv(data);

  writeFileSync(`${prefix}_servers.csv`, csvs.servers);
  writeFileSync(`${prefix}_supervisors.csv`, csvs.supervisors);

  console.log(`Exported CSV files with prefix ${prefix}`);
}

// Usage:
// exportJsonSnapshot('snapshot.json');
// exportCsvSnapshot('monitoring');
```

---

## Package.json Scripts

Add to your `package.json`:

```json
{
  "type": "module",
  "scripts": {
    "start": "tsx src/app.ts",
    "dashboard": "tsx src/dashboard-example.ts",
    "web-monitor": "tsx src/web-monitor.ts",
    "console-monitor": "tsx src/console-monitor.ts"
  }
}
```

---

## Best Practices

1. **Polling Interval**: Use 500-1000ms for dashboards, longer for logging
2. **Memory**: Monitor heap usage to detect leaks
3. **Restarts**: Watch restart rates to catch failing services
4. **Alerts**: Set sensible thresholds based on your application
5. **Export**: Periodically export data for historical analysis

---

## Next Steps

- [Observer API](../api/observer.md) - Complete Observer reference
- [Dashboard API](../api/dashboard.md) - TUI dashboard options
- [DashboardServer API](../api/dashboard-server.md) - Remote monitoring
- [AlertManager API](../api/alert-manager.md) - Alert configuration
