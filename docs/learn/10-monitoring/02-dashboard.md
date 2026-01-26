# Dashboard

In the previous chapter, you learned how to use Observer for programmatic process introspection. Now let's explore **Dashboard** — the built-in TUI (Terminal User Interface) for visual monitoring of your noex applications.

## What You'll Learn

- Start a local TUI dashboard for real-time monitoring
- Configure layouts and themes for different use cases
- Use keyboard shortcuts for efficient navigation
- Set up remote dashboard server for production monitoring
- Connect to remote dashboards from any machine
- Switch between local and cluster view modes

## TUI Dashboard Overview

The Dashboard provides an interactive terminal interface built on `blessed` and `blessed-contrib`. It displays:

- **Process Tree**: Hierarchical view of your supervision structure
- **Stats Table**: Real-time statistics for all GenServers
- **Memory Gauge**: Visual Node.js heap usage indicator
- **Event Log**: Live stream of process lifecycle events

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DASHBOARD LAYOUT (Full)                            │
├────────────────────────────────┬────────────────────────────────────────────┤
│                                │                                            │
│     PROCESS TREE               │           STATS TABLE                      │
│                                │                                            │
│  [SUP] app_supervisor          │  ID          Status  Queue  Messages  Up   │
│    ├─ [GEN] database           │  database    running     0     15234  5m   │
│    ├─ [GEN] cache              │  cache       running     3      8921  5m   │
│    └─ [SUP] workers            │  worker_1    running    12      3456  2m   │
│        ├─ [GEN] worker_1       │  worker_2    running     8      3201  5m   │
│        └─ [GEN] worker_2       │  logger      running     0     52341  5m   │
│                                │                                            │
├────────────────────────────────┼────────────────────────────────────────────┤
│                                │                                            │
│     MEMORY GAUGE               │           EVENT LOG                        │
│                                │                                            │
│  ████████████░░░░░  45%        │  12:00:01 GenServer started: worker_1      │
│  Heap: 45MB / 100MB            │  12:00:00 Supervisor started: workers      │
│                                │  11:59:58 GenServer stopped: worker_1      │
│                                │                                            │
├────────────────────────────────┴────────────────────────────────────────────┤
│ [q]uit [r]efresh [?]help [1-3]layout [c]luster | [1:Full] | Processes: 6    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Starting the Local Dashboard

The Dashboard class provides direct monitoring of processes in the same Node.js process:

```typescript
import { Dashboard } from 'noex/dashboard';

// Create dashboard with default settings
const dashboard = new Dashboard();

// Start the TUI
dashboard.start();

// Dashboard takes over the terminal until stopped
// Press 'q' or Escape to quit
```

### Dashboard Configuration

Customize the dashboard behavior with configuration options:

```typescript
import { Dashboard } from 'noex/dashboard';

const dashboard = new Dashboard({
  // Polling interval for stats updates (milliseconds)
  refreshInterval: 500,  // default: 500

  // Maximum events to keep in the event log
  maxEventLogSize: 100,  // default: 100

  // Color theme
  theme: 'dark',         // 'dark' | 'light', default: 'dark'

  // Initial layout mode
  layout: 'full',        // 'full' | 'compact' | 'minimal', default: 'full'
});

dashboard.start();
```

### Programmatic Control

Control the dashboard programmatically:

```typescript
const dashboard = new Dashboard();
dashboard.start();

// Check if running
console.log(dashboard.isRunning());  // true

// Force immediate refresh
dashboard.refresh();

// Switch layout at runtime
dashboard.switchLayout('compact');

// Get current layout
console.log(dashboard.getLayout());  // 'compact'

// Switch view mode (local vs cluster)
dashboard.switchViewMode('cluster');

// Stop the dashboard
dashboard.stop();
```

## Layout Modes

The Dashboard supports three layout modes to fit different terminal sizes and use cases:

### Full Layout

Shows all widgets — ideal for large terminals:

```typescript
dashboard.switchLayout('full');
// Or press '1' in the dashboard
```

**Widgets shown:**
- Process Tree (left)
- Stats Table (right)
- Memory Gauge (bottom-left)
- Event Log (bottom-right)
- Status Bar (bottom)

### Compact Layout

Essential widgets only — good for medium terminals:

```typescript
dashboard.switchLayout('compact');
// Or press '2' in the dashboard
```

**Widgets shown:**
- Process Tree (left)
- Stats Table (right)
- Status Bar (bottom)

### Minimal Layout

Stats table only — for small terminals or embedded displays:

```typescript
dashboard.switchLayout('minimal');
// Or press '3' in the dashboard
```

**Widgets shown:**
- Stats Table (full width)
- Status Bar (bottom)

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `q`, `Escape`, `Ctrl+C` | Quit dashboard |
| `r` | Refresh data immediately |
| `?`, `h` | Show help dialog |
| `Tab` | Focus next widget |
| `Shift+Tab` | Focus previous widget |
| `Enter` | Show process detail modal |
| `Arrow keys` | Navigate within focused widget |
| `1` | Switch to full layout |
| `2` | Switch to compact layout |
| `3` | Switch to minimal layout |
| `c` | Toggle local/cluster view |

## Color Themes

Two built-in themes optimize for different terminal backgrounds:

**Dark Theme (default):**
```typescript
const dashboard = new Dashboard({ theme: 'dark' });
```

- Cyan primary accents
- White text on black background
- Good for dark terminal themes

**Light Theme:**
```typescript
const dashboard = new Dashboard({ theme: 'light' });
```

- Blue primary accents
- Black text on white background
- Good for light terminal themes

## Remote Dashboard Architecture

For production environments, you typically run your application on a server and want to monitor it from your local machine. noex provides a client-server architecture for remote monitoring:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      REMOTE DASHBOARD ARCHITECTURE                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────┐      TCP      ┌──────────────────────────┐ │
│  │      Production Server      │    :9876      │     Your Workstation     │ │
│  │                             │◄─────────────►│                          │ │
│  │  ┌───────────────────────┐  │               │  ┌────────────────────┐  │ │
│  │  │   Your Application    │  │               │  │  DashboardClient   │  │ │
│  │  │                       │  │               │  │  (TUI Rendering)   │  │ │
│  │  │  GenServers           │  │   Snapshot    │  │                    │  │ │
│  │  │  Supervisors          │──┼───Updates────►│  │  Process Tree      │  │ │
│  │  │  ...                  │  │               │  │  Stats Table       │  │ │
│  │  └───────────────────────┘  │   Lifecycle   │  │  Event Log         │  │ │
│  │           │                 │◄───Events─────│  │  Memory Gauge      │  │ │
│  │           ▼                 │               │  └────────────────────┘  │ │
│  │  ┌───────────────────────┐  │               │                          │ │
│  │  │   DashboardServer     │  │               │                          │ │
│  │  │   (GenServer)         │  │               │  $ noex-dashboard        │ │
│  │  │                       │  │               │    --host 192.168.1.100  │ │
│  │  │  - TCP Server         │  │               │    --port 9876           │ │
│  │  │  - Observer polling   │  │               │                          │ │
│  │  │  - Event streaming    │  │               │                          │ │
│  │  └───────────────────────┘  │               │                          │ │
│  │                             │               │                          │ │
│  └─────────────────────────────┘               └──────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Setting Up the Dashboard Server

On your production server, embed the DashboardServer in your application:

```typescript
import { Application, DashboardServer } from '@hamicek/noex';

// Start your application
const app = await Application.start({
  name: 'my_app',
  behavior: MyAppBehavior,
  config: { /* ... */ },
});

// Start the dashboard server
const dashboardRef = await DashboardServer.start({
  port: 9876,           // TCP port to listen on
  host: '0.0.0.0',      // Bind to all interfaces (or '127.0.0.1' for local only)
  pollingIntervalMs: 500, // How often to poll Observer
});

console.log('Dashboard server listening on port 9876');

// Query server status
const status = await DashboardServer.getStatus(dashboardRef);
console.log(`Clients connected: ${status.clientCount}`);
console.log(`Uptime: ${status.uptime}ms`);

// Get client count
const clientCount = await DashboardServer.getClientCount(dashboardRef);
console.log(`${clientCount} dashboard clients connected`);

// Stop when shutting down
process.on('SIGTERM', async () => {
  await DashboardServer.stop(dashboardRef);
  await Application.stop(app);
});
```

**DashboardServer features:**

- Runs as a GenServer alongside your application
- Polls Observer for statistics updates
- Subscribes to lifecycle events
- Broadcasts updates to all connected clients
- Handles multiple concurrent client connections
- Uses length-prefixed TCP protocol for reliable messaging

## Connecting with DashboardClient

From your workstation, connect to the remote server:

```typescript
import { DashboardClient } from 'noex/dashboard/client';

const client = new DashboardClient({
  // Connection settings
  host: '192.168.1.100',
  port: 9876,

  // Reconnection settings
  autoReconnect: true,            // Enable auto-reconnect
  reconnectDelayMs: 1000,         // Initial delay
  maxReconnectDelayMs: 30000,     // Max delay (30s)
  reconnectBackoffMultiplier: 1.5, // Exponential backoff

  // Connection timeout
  connectionTimeoutMs: 5000,      // 5 second timeout

  // TUI settings (same as local Dashboard)
  theme: 'dark',
  layout: 'full',
  maxEventLogSize: 100,
});

// Start the client (connects and renders TUI)
await client.start();
```

**Connection features:**

- Automatic reconnection with exponential backoff
- Connection timeout handling
- Clean disconnect on quit
- Same TUI experience as local dashboard
- Cluster view support (if server has cluster enabled)

## Using the CLI Tool

The easiest way to connect to a remote dashboard is the `noex-dashboard` CLI:

```bash
# Install dependencies for TUI
npm install blessed blessed-contrib

# Connect to localhost on default port
noex-dashboard

# Connect to remote server
noex-dashboard --host 192.168.1.100 --port 9876

# Use compact layout with light theme
noex-dashboard -l compact -t light

# Disable auto-reconnect
noex-dashboard --no-reconnect
```

**CLI options:**

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--host` | `-H` | `127.0.0.1` | Server host address |
| `--port` | `-p` | `9876` | Server TCP port |
| `--theme` | `-t` | `dark` | Color theme: `dark`, `light` |
| `--layout` | `-l` | `full` | Layout: `full`, `compact`, `minimal` |
| `--no-reconnect` | | `false` | Disable automatic reconnection |
| `--help` | `-h` | | Show help message |
| `--version` | `-v` | | Show version number |

## Cluster View Mode

When running a distributed noex cluster, the Dashboard can show processes across all nodes:

```typescript
// In your application (with cluster enabled)
import { Cluster, DashboardServer } from '@hamicek/noex';

// Start the cluster
await Cluster.start({
  nodeId: 'node_1',
  seedNodes: ['node_2:5555', 'node_3:5555'],
  // ...
});

// Start dashboard server
await DashboardServer.start({ port: 9876 });
```

**In the dashboard client:**

Press `c` to toggle between local and cluster view modes.

**Cluster view shows:**
- All nodes in the cluster
- Process counts per node
- Aggregated statistics
- Connection status for each node

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CLUSTER VIEW                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CLUSTER TREE                     │   STATS (Aggregated)                    │
│                                   │                                         │
│  ● node_1 (local)                 │   Total Processes: 18                   │
│    ├─ [SUP] app_supervisor        │   Total Messages:  52341                │
│    │   ├─ [GEN] database          │   Total Restarts:  3                    │
│    │   └─ [GEN] cache             │                                         │
│    └─ [GEN] logger                │   Node Status:                          │
│                                   │   ● node_1: 6 processes (connected)     │
│  ● node_2                         │   ● node_2: 6 processes (connected)     │
│    ├─ [SUP] app_supervisor        │   ○ node_3: 6 processes (connecting)    │
│    │   ├─ [GEN] database          │                                         │
│    │   └─ [GEN] cache             │                                         │
│    └─ [GEN] logger                │                                         │
│                                   │                                         │
│  ○ node_3 (connecting...)         │                                         │
│                                   │                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Practical Example: Production Monitoring Setup

Here's a complete production setup with DashboardServer integration:

```typescript
import {
  Application,
  DashboardServer,
  Observer,
  type ApplicationBehavior,
} from '@hamicek/noex';

interface AppConfig {
  port: number;
  dashboardPort: number;
  dashboardHost: string;
}

const ProductionApp: ApplicationBehavior<AppConfig> = {
  async start(config) {
    // Start your main application supervisor
    const mainSupervisor = await Supervisor.start({
      strategy: 'one_for_one',
      children: [
        { id: 'database', start: () => DatabasePool.start(config) },
        { id: 'cache', start: () => CacheService.start() },
        { id: 'api', start: () => ApiServer.start(config.port) },
      ],
    });

    // Start dashboard server for remote monitoring
    const dashboardServer = await DashboardServer.start({
      port: config.dashboardPort,
      host: config.dashboardHost,
      pollingIntervalMs: 500,
    });

    // Log when clients connect (via Observer events)
    const unsubscribe = Observer.subscribe((event) => {
      if (event.type === 'server_started' && event.stats.id.includes('dashboard')) {
        console.log('Dashboard server ready for connections');
      }
    });

    return { mainSupervisor, dashboardServer, unsubscribe };
  },

  async prepStop({ dashboardServer }) {
    // Stop accepting new dashboard connections
    await DashboardServer.stop(dashboardServer);
  },

  async stop({ mainSupervisor, unsubscribe }) {
    unsubscribe();
    await Supervisor.stop(mainSupervisor);
  },
};

// Start the application
const app = await Application.start({
  name: 'production_app',
  behavior: ProductionApp,
  config: {
    port: 3000,
    dashboardPort: 9876,
    dashboardHost: '0.0.0.0',
  },
  handleSignals: true,
  stopTimeout: 30000,
});

console.log('Application started');
console.log('Dashboard available at :9876');
console.log('Connect with: noex-dashboard --host <server-ip> --port 9876');
```

**Deployment notes:**

1. **Firewall**: Open port 9876 (or your chosen port) for dashboard connections
2. **Security**: Consider binding to `127.0.0.1` and using SSH tunneling for production
3. **Multiple clients**: DashboardServer supports multiple concurrent connections
4. **Graceful shutdown**: Stop DashboardServer before stopping the main application

## Security Considerations

The Dashboard uses a plain TCP protocol without authentication. For production:

**Option 1: SSH Tunneling (Recommended)**

```bash
# On your workstation, create an SSH tunnel
ssh -L 9876:localhost:9876 user@production-server

# Then connect to localhost
noex-dashboard --host 127.0.0.1 --port 9876
```

**Option 2: Bind to Localhost Only**

```typescript
// Only allow local connections
await DashboardServer.start({
  host: '127.0.0.1',  // Bind to localhost only
  port: 9876,
});
```

**Option 3: VPN/Private Network**

Deploy dashboard server only on internal networks accessible via VPN.

## Exercise: Custom Dashboard Integration

Build a monitoring setup that integrates the dashboard with custom health checks.

**Requirements:**

1. Start DashboardServer with your application
2. Create a HealthMonitor GenServer that:
   - Polls Observer every 5 seconds
   - Tracks message throughput rate
   - Generates alerts when queue depth exceeds threshold
3. Log when dashboard clients connect/disconnect
4. Expose a health endpoint that includes dashboard status

**Starter code:**

```typescript
import {
  GenServer,
  Supervisor,
  Observer,
  DashboardServer,
  type GenServerBehavior,
  type SupervisorStrategy,
} from '@hamicek/noex';

interface HealthMonitorState {
  lastMessageCount: number;
  lastCheckTime: number;
  throughputRate: number;
  alerts: string[];
  dashboardClientCount: number;
}

type HealthCall =
  | { type: 'getHealth' }
  | { type: 'getAlerts' };

type HealthCast =
  | { type: 'checkHealth' }
  | { type: 'dashboardClientConnected' }
  | { type: 'dashboardClientDisconnected' };

type HealthReply =
  | { healthy: boolean; throughput: number; dashboardClients: number }
  | { alerts: string[] };

const HealthMonitorBehavior: GenServerBehavior<
  HealthMonitorState,
  HealthCall,
  HealthCast,
  HealthReply
> = {
  init: () => ({
    // TODO: Initialize state
  }),

  handleCall: (msg, state) => {
    // TODO: Handle getHealth and getAlerts calls
  },

  handleCast: (msg, state) => {
    // TODO: Handle health checks and dashboard client tracking
  },
};

async function main() {
  // TODO: Start supervisor with HealthMonitor
  // TODO: Start DashboardServer
  // TODO: Set up periodic health checks
  // TODO: Track dashboard connections
}

main().catch(console.error);
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
import {
  GenServer,
  Supervisor,
  Observer,
  DashboardServer,
  type GenServerBehavior,
  type GenServerRef,
  type ObserverEvent,
} from '@hamicek/noex';

// ============================================================================
// HealthMonitor GenServer
// ============================================================================

interface HealthMonitorState {
  lastMessageCount: number;
  lastCheckTime: number;
  throughputRate: number;
  alerts: string[];
  dashboardClientCount: number;
}

type HealthCall =
  | { type: 'getHealth' }
  | { type: 'getAlerts' };

type HealthCast =
  | { type: 'checkHealth' }
  | { type: 'dashboardClientConnected' }
  | { type: 'dashboardClientDisconnected' }
  | { type: 'clearAlerts' };

type HealthReply =
  | { healthy: boolean; throughput: number; dashboardClients: number; processCount: number }
  | { alerts: string[] };

const HealthMonitorBehavior: GenServerBehavior<
  HealthMonitorState,
  HealthCall,
  HealthCast,
  HealthReply
> = {
  init: () => ({
    lastMessageCount: 0,
    lastCheckTime: Date.now(),
    throughputRate: 0,
    alerts: [],
    dashboardClientCount: 0,
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'getHealth': {
        const snapshot = Observer.getSnapshot();
        const highQueueProcesses = snapshot.servers.filter(s => s.queueSize > 50);
        const healthy = highQueueProcesses.length === 0 && state.alerts.length < 5;

        return [
          {
            healthy,
            throughput: Math.round(state.throughputRate * 10) / 10,
            dashboardClients: state.dashboardClientCount,
            processCount: snapshot.processCount,
          },
          state,
        ];
      }

      case 'getAlerts':
        return [{ alerts: [...state.alerts] }, state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'checkHealth': {
        const snapshot = Observer.getSnapshot();
        const now = Date.now();
        const elapsed = (now - state.lastCheckTime) / 1000;

        // Calculate throughput
        const throughput = elapsed > 0
          ? (snapshot.totalMessages - state.lastMessageCount) / elapsed
          : 0;

        // Check for high queue depth
        const newAlerts: string[] = [];
        for (const server of snapshot.servers) {
          if (server.queueSize > 100) {
            newAlerts.push(
              `CRITICAL: ${server.id} queue depth ${server.queueSize}`
            );
          } else if (server.queueSize > 50) {
            newAlerts.push(
              `WARNING: ${server.id} queue depth ${server.queueSize}`
            );
          }
        }

        // Check memory
        const heapPercent = (snapshot.memoryStats.heapUsed / snapshot.memoryStats.heapTotal) * 100;
        if (heapPercent > 90) {
          newAlerts.push(`CRITICAL: Heap usage at ${Math.round(heapPercent)}%`);
        }

        return {
          ...state,
          lastMessageCount: snapshot.totalMessages,
          lastCheckTime: now,
          throughputRate: throughput,
          alerts: [...state.alerts, ...newAlerts].slice(-20),
        };
      }

      case 'dashboardClientConnected':
        console.log(`Dashboard client connected (total: ${state.dashboardClientCount + 1})`);
        return { ...state, dashboardClientCount: state.dashboardClientCount + 1 };

      case 'dashboardClientDisconnected':
        console.log(`Dashboard client disconnected (total: ${state.dashboardClientCount - 1})`);
        return { ...state, dashboardClientCount: Math.max(0, state.dashboardClientCount - 1) };

      case 'clearAlerts':
        return { ...state, alerts: [] };
    }
  },
};

// ============================================================================
// Main Application
// ============================================================================

async function main() {
  // Start the health monitor
  const healthMonitor = await GenServer.start(HealthMonitorBehavior, {
    name: 'health_monitor',
  });

  // Start some example workers to monitor
  const workerSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      {
        id: 'worker_1',
        start: () => GenServer.start({
          init: () => ({ count: 0 }),
          handleCall: () => [null, { count: 0 }],
          handleCast: (_, s) => ({ count: s.count + 1 }),
        }),
      },
      {
        id: 'worker_2',
        start: () => GenServer.start({
          init: () => ({ count: 0 }),
          handleCall: () => [null, { count: 0 }],
          handleCast: (_, s) => ({ count: s.count + 1 }),
        }),
      },
    ],
  });

  // Start the dashboard server
  const dashboardServer = await DashboardServer.start({
    port: 9876,
    host: '127.0.0.1',
    pollingIntervalMs: 500,
  });

  console.log('Dashboard server started on port 9876');
  console.log('Connect with: noex-dashboard --port 9876');

  // Set up periodic health checks (every 5 seconds)
  const healthCheckInterval = setInterval(() => {
    GenServer.cast(healthMonitor, { type: 'checkHealth' });
  }, 5000);

  // Initial health check
  GenServer.cast(healthMonitor, { type: 'checkHealth' });

  // Track dashboard client connections
  let lastClientCount = 0;
  const clientCheckInterval = setInterval(async () => {
    const clientCount = await DashboardServer.getClientCount(dashboardServer);

    if (clientCount > lastClientCount) {
      // New client(s) connected
      for (let i = 0; i < clientCount - lastClientCount; i++) {
        GenServer.cast(healthMonitor, { type: 'dashboardClientConnected' });
      }
    } else if (clientCount < lastClientCount) {
      // Client(s) disconnected
      for (let i = 0; i < lastClientCount - clientCount; i++) {
        GenServer.cast(healthMonitor, { type: 'dashboardClientDisconnected' });
      }
    }

    lastClientCount = clientCount;
  }, 1000);

  // Expose health endpoint (simple HTTP for demonstration)
  const http = await import('node:http');
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      const health = await GenServer.call(healthMonitor, { type: 'getHealth' }) as {
        healthy: boolean;
        throughput: number;
        dashboardClients: number;
        processCount: number;
      };

      const dashboardStatus = await DashboardServer.getStatus(dashboardServer);

      res.writeHead(health.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: health.healthy ? 'healthy' : 'degraded',
        processCount: health.processCount,
        throughput: `${health.throughput}/s`,
        dashboard: {
          port: dashboardStatus.port,
          clients: health.dashboardClients,
          uptime: `${Math.round(dashboardStatus.uptime / 1000)}s`,
        },
      }, null, 2));
    } else if (req.url === '/alerts') {
      const alerts = await GenServer.call(healthMonitor, { type: 'getAlerts' }) as {
        alerts: string[];
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ alerts: alerts.alerts }, null, 2));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(3000, () => {
    console.log('Health endpoint available at http://localhost:3000/health');
    console.log('Alerts endpoint available at http://localhost:3000/alerts');
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');

    clearInterval(healthCheckInterval);
    clearInterval(clientCheckInterval);

    server.close();
    await DashboardServer.stop(dashboardServer);
    await Supervisor.stop(workerSupervisor);
    await GenServer.stop(healthMonitor);

    console.log('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);
```

**Running the example:**

```bash
# Terminal 1: Start the application
npx ts-node example.ts

# Terminal 2: Connect dashboard
noex-dashboard --port 9876

# Terminal 3: Check health endpoints
curl http://localhost:3000/health
curl http://localhost:3000/alerts
```

**Sample /health output:**

```json
{
  "status": "healthy",
  "processCount": 5,
  "throughput": "45.2/s",
  "dashboard": {
    "port": 9876,
    "clients": 1,
    "uptime": "120s"
  }
}
```

</details>

## Summary

**Key takeaways:**

- **Dashboard** provides a real-time TUI for visual process monitoring
- **Three layouts** (full/compact/minimal) fit different terminal sizes
- **DashboardServer** enables remote monitoring over TCP
- **DashboardClient** or `noex-dashboard` CLI connects to remote servers
- **Cluster view** shows processes across all cluster nodes
- **Keyboard shortcuts** enable efficient navigation

**Dashboard architecture:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DASHBOARD COMPONENTS                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  LOCAL MONITORING                                                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Dashboard              → TUI class for same-process monitoring             │
│    .start()             → Begin rendering                                   │
│    .stop()              → Stop and cleanup                                  │
│    .refresh()           → Force immediate update                            │
│    .switchLayout()      → Change layout mode                                │
│    .switchViewMode()    → Toggle local/cluster view                         │
│                                                                             │
│  REMOTE MONITORING                                                          │
│  ─────────────────────────────────────────────────────────────────────────  │
│  DashboardServer        → GenServer that exposes data over TCP              │
│    .start(config)       → Start TCP server                                  │
│    .stop(ref)           → Stop server                                       │
│    .getStatus(ref)      → Query server status                               │
│    .getClientCount(ref) → Number of connected clients                       │
│                                                                             │
│  DashboardClient        → Remote TUI client                                 │
│    .start()             → Connect and render                                │
│    .stop()              → Disconnect and cleanup                            │
│                                                                             │
│  CLI TOOL                                                                   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  noex-dashboard         → Command-line remote dashboard client              │
│    --host, --port       → Connection settings                               │
│    --theme, --layout    → TUI appearance                                    │
│    --no-reconnect       → Disable auto-reconnection                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**When to use each component:**

| Scenario | Component |
|----------|-----------|
| Development debugging | `Dashboard` (local) |
| Production server monitoring | `DashboardServer` + `noex-dashboard` |
| Embedded monitoring UI | `Dashboard` with `minimal` layout |
| Custom monitoring integration | `Observer` API directly |
| Distributed cluster monitoring | `DashboardServer` + cluster view |

**Remember:**

> The Dashboard is your visual window into a running noex application. Use the local Dashboard during development to watch process interactions in real-time. In production, embed DashboardServer and connect remotely with `noex-dashboard` or SSH tunneling for secure access.

---

Next: [AlertManager](./03-alertmanager.md)
