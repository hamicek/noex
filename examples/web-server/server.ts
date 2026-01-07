/**
 * noex + Fastify + WebSocket Example
 *
 * Demonstrates how to combine noex patterns with a web server:
 * - Supervisor manages all services
 * - GenServer per WebSocket connection
 * - EventBus for real-time broadcasting
 * - Registry for connection lookup
 * - Cache for session data
 *
 * Architecture:
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │                 Root Supervisor                      │
 *   │  ┌───────────┐  ┌───────────┐  ┌───────────┐       │
 *   │  │ EventBus  │  │   Cache   │  │  Metrics  │       │
 *   │  └───────────┘  └───────────┘  └───────────┘       │
 *   │                                                     │
 *   │  ┌─────────────────────────────────────────────┐   │
 *   │  │        Connection Pool (dynamic)             │   │
 *   │  │   ┌────┐ ┌────┐ ┌────┐ ┌────┐              │   │
 *   │  │   │WS 1│ │WS 2│ │WS 3│ │... │              │   │
 *   │  │   └────┘ └────┘ └────┘ └────┘              │   │
 *   │  └─────────────────────────────────────────────┘   │
 *   └─────────────────────────────────────────────────────┘
 */

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  GenServer,
  Supervisor,
  Registry,
  EventBus,
  Cache,
  Observer,
  AlertManager,
  DashboardServer,
  exportToJson,
  exportToCsv,
  type GenServerRef,
  type SupervisorRef,
  type DashboardServerRef,
} from 'noex';

import {
  startConnection,
  setEventBus,
  type ConnectionRef,
} from './connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Metrics GenServer - tracks server statistics
// ============================================================

interface MetricsState {
  totalConnections: number;
  activeConnections: number;
  totalMessages: number;
  startedAt: Date;
}

type MetricsCallMsg = { type: 'get_stats' };
type MetricsCastMsg =
  | { type: 'connection_opened' }
  | { type: 'connection_closed' }
  | { type: 'message_received' };

const metricsBehavior = {
  init: (): MetricsState => ({
    totalConnections: 0,
    activeConnections: 0,
    totalMessages: 0,
    startedAt: new Date(),
  }),

  handleCall: (msg: MetricsCallMsg, state: MetricsState) => {
    if (msg.type === 'get_stats') {
      return [{
        ...state,
        uptimeMs: Date.now() - state.startedAt.getTime(),
      }, state] as const;
    }
    return [null, state] as const;
  },

  handleCast: (msg: MetricsCastMsg, state: MetricsState): MetricsState => {
    switch (msg.type) {
      case 'connection_opened':
        return {
          ...state,
          totalConnections: state.totalConnections + 1,
          activeConnections: state.activeConnections + 1,
        };
      case 'connection_closed':
        return {
          ...state,
          activeConnections: Math.max(0, state.activeConnections - 1),
        };
      case 'message_received':
        return {
          ...state,
          totalMessages: state.totalMessages + 1,
        };
      default:
        return state;
    }
  },
};

// ============================================================
// Connection Manager - tracks all active connections
// ============================================================

const connections = new Map<string, ConnectionRef>();

function addConnection(id: string, ref: ConnectionRef): void {
  connections.set(id, ref);
}

function removeConnection(id: string): void {
  connections.delete(id);
}

function getConnectionCount(): number {
  return connections.size;
}

function broadcastToAll(payload: unknown): void {
  for (const ref of connections.values()) {
    GenServer.cast(ref, { type: 'send', payload });
  }
}

// ============================================================
// Main Application
// ============================================================

async function main() {
  console.log('Starting noex Web Server Example...\n');

  // 1. Start core services under supervision
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      {
        id: 'event-bus',
        start: async () => {
          const ref = await EventBus.start();
          Registry.register('event-bus', ref);
          setEventBus(ref);
          return ref;
        },
      },
      {
        id: 'cache',
        start: async () => {
          const ref = await Cache.start({ maxSize: 10000, defaultTtlMs: 3600000 });
          Registry.register('cache', ref);
          return ref;
        },
      },
      {
        id: 'metrics',
        start: async () => {
          const ref = await GenServer.start(metricsBehavior);
          Registry.register('metrics', ref);
          return ref;
        },
      },
    ],
  });

  // 1b. Start Dashboard Server for remote TUI connections
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT || '9876', 10);
  let dashboardRef: DashboardServerRef | null = null;

  try {
    dashboardRef = await DashboardServer.start({ port: dashboardPort });
    console.log('Core services started:');
    console.log('  - EventBus (pub/sub messaging)');
    console.log('  - Cache (session storage)');
    console.log('  - Metrics (statistics)');
    console.log(`  - DashboardServer (port ${dashboardPort})\n`);
  } catch (err) {
    console.log('Core services started:');
    console.log('  - EventBus (pub/sub messaging)');
    console.log('  - Cache (session storage)');
    console.log('  - Metrics (statistics)');
    console.log(`  - DashboardServer: FAILED to start on port ${dashboardPort}\n`);
  }

  // 2. Get references to services
  const eventBus = Registry.lookup('event-bus');
  const metrics = Registry.lookup('metrics');

  // 3. Subscribe EventBus to broadcast messages to all connections
  await EventBus.subscribe(eventBus, 'chat.*', (message, topic) => {
    broadcastToAll({ topic, ...message });

    // Track message in metrics
    GenServer.cast(metrics, { type: 'message_received' });
  });

  // 4. Create Fastify server
  const app = Fastify({ logger: false });

  // Register WebSocket plugin
  await app.register(websocket);

  // Serve static files (HTML client)
  await app.register(fastifyStatic, {
    root: join(__dirname, 'public'),
    prefix: '/',
  });

  // 5. HTTP Routes

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // Get server stats
  app.get('/api/stats', async () => {
    const stats = await GenServer.call(metrics, { type: 'get_stats' });
    return {
      ...stats,
      currentConnections: getConnectionCount(),
    };
  });

  // List active connections (for debugging)
  app.get('/api/connections', async () => {
    return {
      count: getConnectionCount(),
      ids: Array.from(connections.keys()),
    };
  });

  // ============================================================
  // Observer Routes - Process introspection API
  // ============================================================

  // Complete system snapshot
  app.get('/observer/snapshot', async () => {
    return Observer.getSnapshot();
  });

  // Process tree hierarchy
  app.get('/observer/tree', async () => {
    return Observer.getProcessTree();
  });

  // GenServer statistics
  app.get('/observer/servers', async () => {
    return Observer.getServerStats();
  });

  // Supervisor statistics
  app.get('/observer/supervisors', async () => {
    return Observer.getSupervisorStats();
  });

  // ============================================================
  // Alert Routes - Alerting API
  // ============================================================

  // Get active alerts
  app.get('/observer/alerts', async () => {
    return AlertManager.getActiveAlerts();
  });

  // Get alert configuration
  app.get('/observer/alerts/config', async () => {
    return AlertManager.getConfig();
  });

  // Update alert configuration
  app.put('/observer/alerts/config', async (request, reply) => {
    const body = request.body as Partial<{
      enabled: boolean;
      sensitivityMultiplier: number;
      minSamples: number;
      cooldownMs: number;
    }>;

    AlertManager.configure(body);
    return AlertManager.getConfig();
  });

  // ============================================================
  // Process Control Routes - Stop processes from UI
  // ============================================================

  // Stop a process by ID
  app.post<{
    Params: { id: string };
    Body: { reason?: string };
  }>('/api/processes/:id/stop', async (request, reply) => {
    const { id } = request.params;
    const { reason } = request.body ?? {};

    const result = await Observer.stopProcess(id, reason);

    if (result.success) {
      return reply.status(200).send({
        success: true,
        message: `Process '${id}' stopped successfully`,
      });
    }

    return reply.status(result.error?.includes('not found') ? 404 : 500).send({
      success: false,
      message: result.error ?? 'Unknown error',
    });
  });

  // ============================================================
  // Export Routes - Data export API
  // ============================================================

  // Export snapshot as JSON
  app.get('/api/export/json', async (_request, reply) => {
    const exportData = Observer.prepareExportData();
    const json = exportToJson(exportData);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `noex-export-${timestamp}.json`;

    return reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(json);
  });

  // Export snapshot as CSV (returns summary CSV by default)
  app.get('/api/export/csv', async (request, reply) => {
    const exportData = Observer.prepareExportData();
    const csvs = exportToCsv(exportData);

    const query = request.query as { type?: string };
    const csvType = query.type ?? 'summary';

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    let csvContent: string;
    let filename: string;

    switch (csvType) {
      case 'servers':
        csvContent = csvs.servers;
        filename = `noex-servers-${timestamp}.csv`;
        break;
      case 'supervisors':
        csvContent = csvs.supervisors;
        filename = `noex-supervisors-${timestamp}.csv`;
        break;
      case 'summary':
      default:
        csvContent = csvs.summary;
        filename = `noex-summary-${timestamp}.csv`;
        break;
    }

    return reply
      .header('Content-Type', 'text/csv')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(csvContent);
  });

  // Export all CSVs as a combined response (for UI to process)
  app.get('/api/export/csv/all', async (_request, reply) => {
    const exportData = Observer.prepareExportData();
    const csvs = exportToCsv(exportData);

    return reply.send({
      summary: csvs.summary,
      servers: csvs.servers,
      supervisors: csvs.supervisors,
    });
  });

  // Observer WebSocket - real-time process monitoring
  app.get('/observer/ws', { websocket: true }, (socket) => {
    console.log('[Observer] WebSocket client connected');

    // Send initial snapshot with active alerts
    socket.send(JSON.stringify({
      type: 'snapshot',
      data: {
        ...Observer.getSnapshot(),
        activeAlerts: AlertManager.getActiveAlerts(),
      },
    }));

    // Subscribe to lifecycle events
    const unsubEvents = Observer.subscribe((event) => {
      socket.send(JSON.stringify({ type: 'event', data: event }));
    });

    // Subscribe to alert events
    const unsubAlerts = AlertManager.subscribe((event) => {
      socket.send(JSON.stringify({ type: 'alert', data: event }));
    });

    // Start polling for stats updates (every second)
    const stopPolling = Observer.startPolling(1000, (event) => {
      socket.send(JSON.stringify({ type: 'event', data: event }));
    });

    socket.on('close', () => {
      console.log('[Observer] WebSocket client disconnected');
      unsubEvents();
      unsubAlerts();
      stopPolling();
    });

    socket.on('error', (error) => {
      console.error('[Observer] WebSocket error:', error.message);
    });
  });

  // 6. WebSocket Route
  app.get('/ws', { websocket: true }, async (socket, request) => {
    const connectionId = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    console.log(`[${connectionId}] WebSocket connected`);

    // Start GenServer for this connection
    const connectionRef = await startConnection(socket);
    addConnection(connectionId, connectionRef);
    Registry.register(connectionId, connectionRef);

    // Track in metrics
    GenServer.cast(metrics, { type: 'connection_opened' });

    // Send welcome message
    GenServer.cast(connectionRef, {
      type: 'send',
      payload: {
        type: 'welcome',
        connectionId,
        message: 'Connected to noex chat server',
        timestamp: new Date().toISOString(),
      },
    });

    // Handle incoming messages
    socket.on('message', (data) => {
      const message = data.toString();
      GenServer.cast(connectionRef, { type: 'ws_message', data: message });
    });

    // Handle disconnection
    socket.on('close', async () => {
      console.log(`[${connectionId}] WebSocket disconnected`);

      // Clean up
      removeConnection(connectionId);
      Registry.unregister(connectionId);
      GenServer.cast(metrics, { type: 'connection_closed' });

      // Stop the connection GenServer
      await GenServer.stop(connectionRef);
    });

    socket.on('error', (error) => {
      console.error(`[${connectionId}] WebSocket error:`, error.message);
    });
  });

  // 7. Start server
  const port = parseInt(process.env.PORT || '7201', 10);
  const host = process.env.HOST || '0.0.0.0';

  await app.listen({ port, host });

  console.log(`Server listening on http://${host}:${port}`);
  console.log(`WebSocket endpoint: ws://${host}:${port}/ws`);
  console.log(`\nOpen http://localhost:${port} in your browser to test the chat.`);

  if (dashboardRef) {
    console.log(`\nRemote TUI Dashboard available. Connect with:`);
    console.log(`  npx noex-dashboard --port ${dashboardPort}`);
  }
  console.log('');

  // 8. Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);

    // Close all connections
    for (const [id, ref] of connections) {
      console.log(`  Closing ${id}...`);
      await GenServer.stop(ref);
    }
    connections.clear();

    // Stop Dashboard Server
    if (dashboardRef) {
      console.log('  Stopping DashboardServer...');
      await DashboardServer.stop(dashboardRef);
    }

    // Stop supervisor (stops all services)
    await Supervisor.stop(supervisor);

    // Close Fastify
    await app.close();

    console.log('Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
