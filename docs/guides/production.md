# Production Deployment Guide

This guide covers best practices for deploying noex applications to production environments, including monitoring, error handling, graceful shutdown, and scaling considerations.

## Overview

Production-ready noex applications need:
- **Proper error handling** and recovery strategies
- **Monitoring** with Observer and AlertManager
- **Graceful shutdown** handling
- **Logging** for debugging and auditing
- **Resource management** to prevent memory leaks

---

## Application Structure

### Recommended Setup

```typescript
import {
  Supervisor,
  GenServer,
  Registry,
  Observer,
  AlertManager,
} from 'noex';

async function startApplication() {
  // 1. Configure alerting
  AlertManager.configure({
    enabled: true,
    sensitivityMultiplier: 2.5,
    minSamples: 50,
    cooldownMs: 30000,
  });

  // 2. Subscribe to alerts
  AlertManager.subscribe(handleAlert);

  // 3. Start Observer polling
  const stopPolling = Observer.startPolling(5000, handleStatsUpdate);

  // 4. Build supervision tree
  const app = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 5, withinMs: 60000 },
    children: [
      { id: 'core', start: startCoreSupervisor },
      { id: 'workers', start: startWorkerSupervisor },
      { id: 'api', start: startApiSupervisor },
    ],
  });

  // 5. Register shutdown handlers
  setupShutdownHandlers(app, stopPolling);

  return app;
}
```

### Supervision Tree Design

```typescript
// Core services that must always run
async function startCoreSupervisor() {
  return Supervisor.start({
    strategy: 'rest_for_one',
    children: [
      { id: 'config', start: () => startConfigServer() },
      { id: 'database', start: () => startDatabasePool() },
      { id: 'cache', start: () => startCacheServer() },
    ],
  });
}

// Worker processes that can fail independently
async function startWorkerSupervisor() {
  return Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 20, withinMs: 60000 },
    children: [
      { id: 'email-worker', start: () => startEmailWorker() },
      { id: 'pdf-worker', start: () => startPdfWorker() },
      { id: 'notification-worker', start: () => startNotificationWorker() },
    ],
  });
}
```

---

## Graceful Shutdown

### Signal Handling

```typescript
function setupShutdownHandlers(
  app: SupervisorRef,
  stopPolling: () => void,
) {
  let isShuttingDown = false;

  async function shutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\nReceived ${signal}, starting graceful shutdown...`);

    // 1. Stop accepting new work
    stopPolling();

    // 2. Give time for in-flight requests
    console.log('Waiting for in-flight requests...');
    await new Promise((r) => setTimeout(r, 5000));

    // 3. Stop supervision tree (stops children in reverse order)
    console.log('Stopping services...');
    await Supervisor.stop(app, 'shutdown');

    console.log('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    // Don't shutdown for unhandled rejections, just log
  });
}
```

### Shutdown Timeouts

Configure appropriate shutdown timeouts for each service:

```typescript
const children = [
  {
    id: 'database',
    start: () => startDatabasePool(),
    shutdownTimeout: 30000,  // 30s to close connections
  },
  {
    id: 'cache',
    start: () => startCacheServer(),
    shutdownTimeout: 5000,   // 5s to flush data
  },
  {
    id: 'api',
    start: () => startApiServer(),
    shutdownTimeout: 10000,  // 10s to finish requests
  },
];
```

---

## Monitoring

### Observer Integration

```typescript
import { Observer, AlertManager } from 'noex';

function setupMonitoring() {
  // Subscribe to lifecycle events
  Observer.subscribe((event) => {
    switch (event.type) {
      case 'server_started':
        logger.info(`Process started: ${event.stats.name || event.stats.id}`);
        break;
      case 'server_stopped':
        logger.info(`Process stopped: ${event.id} (${event.reason})`);
        break;
    }
  });

  // Start polling for stats
  Observer.startPolling(5000, (event) => {
    if (event.type === 'stats_update') {
      // Send metrics to external monitoring
      sendMetrics({
        processCount: event.servers.length + event.supervisors.length,
        totalMessages: event.servers.reduce((sum, s) => sum + s.messageCount, 0),
        totalRestarts: event.supervisors.reduce((sum, s) => sum + s.totalRestarts, 0),
      });
    }
  });
}
```

### AlertManager Configuration

```typescript
// Configure alerts for production
AlertManager.configure({
  enabled: true,
  sensitivityMultiplier: 2.5,  // Less sensitive to reduce noise
  minSamples: 100,             // Wait for baseline
  cooldownMs: 60000,           // 1 minute between alerts
});

// Handle alerts
AlertManager.subscribe((event) => {
  if (event.type === 'alert_triggered') {
    const { alert } = event;

    // Log alert
    logger.warn('Alert triggered', {
      type: alert.type,
      processId: alert.processId,
      processName: alert.processName,
      threshold: alert.threshold,
      currentValue: alert.currentValue,
    });

    // Send to external alerting system
    sendToSlack({
      channel: '#alerts',
      text: `*Alert*: ${alert.message}`,
      attachments: [{
        color: 'danger',
        fields: [
          { title: 'Process', value: alert.processName || alert.processId },
          { title: 'Value', value: `${alert.currentValue} (threshold: ${alert.threshold.toFixed(2)})` },
        ],
      }],
    });

    // Send to PagerDuty for critical alerts
    if (alert.type === 'high_queue_size' && alert.currentValue > 1000) {
      triggerPagerDuty({
        severity: 'critical',
        summary: alert.message,
        source: alert.processId,
      });
    }
  }
});
```

### Health Checks

```typescript
import { Observer } from 'noex';
import { createServer } from 'http';

function startHealthServer(port: number) {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      const snapshot = Observer.getSnapshot();
      const alerts = Observer.getActiveAlerts();

      const healthy = alerts.length === 0 && snapshot.processCount > 0;

      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: healthy ? 'healthy' : 'unhealthy',
        processCount: snapshot.processCount,
        activeAlerts: alerts.length,
        uptime: process.uptime(),
        memory: snapshot.memoryStats,
      }));
    } else if (req.url === '/ready') {
      // Check if all required services are running
      const requiredServices = ['config', 'database', 'cache'];
      const registeredServices = Registry.getNames();
      const allReady = requiredServices.every((s) => registeredServices.includes(s));

      res.writeHead(allReady ? 200 : 503);
      res.end(allReady ? 'OK' : 'NOT READY');
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(port, () => {
    console.log(`Health server listening on port ${port}`);
  });

  return server;
}
```

---

## Logging

### Structured Logging

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Log lifecycle events
Observer.subscribe((event) => {
  switch (event.type) {
    case 'server_started':
      logger.info({ event: 'process_started', ...event.stats });
      break;
    case 'server_stopped':
      logger.info({ event: 'process_stopped', id: event.id, reason: event.reason });
      break;
  }
});

// Log alerts
AlertManager.subscribe((event) => {
  if (event.type === 'alert_triggered') {
    logger.warn({ event: 'alert_triggered', alert: event.alert });
  } else {
    logger.info({ event: 'alert_resolved', processId: event.processId });
  }
});
```

### Request Logging in Services

```typescript
const apiServerBehavior: GenServerBehavior<ApiState, ApiCall, ApiCast, ApiReply> = {
  handleCall: async (msg, state) => {
    const requestId = generateRequestId();
    const startTime = Date.now();

    state.logger.info({
      requestId,
      type: msg.type,
      event: 'request_started',
    });

    try {
      const result = await processRequest(msg, state);

      state.logger.info({
        requestId,
        type: msg.type,
        event: 'request_completed',
        durationMs: Date.now() - startTime,
      });

      return [result, state];
    } catch (error) {
      state.logger.error({
        requestId,
        type: msg.type,
        event: 'request_failed',
        error: error.message,
        durationMs: Date.now() - startTime,
      });

      throw error;
    }
  },
};
```

---

## Error Handling

### Let It Crash Philosophy

noex embraces the "let it crash" philosophy. Design services to restart cleanly:

```typescript
const robustServiceBehavior = {
  // State can be rebuilt on restart
  init: async () => {
    const config = await loadConfig();
    const cache = await rebuildCache();
    return { config, cache, metrics: { requests: 0, errors: 0 } };
  },

  handleCall: (msg, state) => {
    // Don't try to recover from errors - let the supervisor restart
    // This ensures we're always in a clean state
    const result = processMessage(msg, state);
    return [result, { ...state, metrics: { ...state.metrics, requests: state.metrics.requests + 1 } }];
  },

  // Clean up resources on shutdown
  terminate: async (reason, state) => {
    await flushMetrics(state.metrics);
    await closeConnections();
    logger.info('Service terminated', { reason });
  },
};
```

### Error Boundaries

For errors that shouldn't crash the service:

```typescript
handleCall: (msg, state) => {
  switch (msg.type) {
    case 'process_item':
      try {
        const result = processItem(msg.item);
        return [{ success: true, result }, state];
      } catch (error) {
        // Log but don't crash for expected errors
        logger.warn('Failed to process item', { itemId: msg.item.id, error: error.message });
        return [{ success: false, error: error.message }, state];
      }

    case 'critical_operation':
      // Let unexpected errors crash the service
      return [performCriticalOperation(msg), state];
  }
},
```

---

## Resource Management

### Memory Management

```typescript
// Monitor memory usage
Observer.startPolling(10000, (event) => {
  if (event.type === 'stats_update') {
    const memory = Observer.getMemoryStats();
    const heapUsedMB = memory.heapUsed / 1024 / 1024;

    if (heapUsedMB > 500) {
      logger.warn('High memory usage', { heapUsedMB });
    }

    // Export metrics
    metrics.gauge('nodejs_heap_used_bytes', memory.heapUsed);
    metrics.gauge('nodejs_heap_total_bytes', memory.heapTotal);
  }
});
```

### Preventing Memory Leaks

```typescript
const cacheBehavior = {
  init: () => ({
    cache: new Map<string, CacheEntry>(),
    maxSize: 10000,
  }),

  handleCast: (msg, state) => {
    if (msg.type === 'set') {
      // Prevent unbounded growth
      if (state.cache.size >= state.maxSize) {
        // Remove oldest entries
        const keysToRemove = Array.from(state.cache.keys()).slice(0, 1000);
        keysToRemove.forEach((k) => state.cache.delete(k));
      }

      state.cache.set(msg.key, {
        value: msg.value,
        expiresAt: Date.now() + msg.ttl,
      });
    }

    return state;
  },
};
```

### Connection Pooling

```typescript
const databasePoolBehavior = {
  init: async () => ({
    pool: await createPool({
      min: 5,
      max: 20,
      idleTimeoutMillis: 30000,
    }),
    metrics: { acquired: 0, released: 0, errors: 0 },
  }),

  handleCall: async (msg, state) => {
    if (msg.type === 'query') {
      const client = await state.pool.acquire();
      try {
        const result = await client.query(msg.sql, msg.params);
        state.metrics.acquired++;
        return [result, state];
      } finally {
        state.pool.release(client);
        state.metrics.released++;
      }
    }
  },

  terminate: async (_reason, state) => {
    await state.pool.end();
    logger.info('Database pool closed', state.metrics);
  },
};
```

---

## Configuration Management

### Environment-Based Config

```typescript
interface AppConfig {
  env: 'development' | 'staging' | 'production';
  logLevel: string;
  database: {
    host: string;
    port: number;
    maxConnections: number;
  };
  supervisor: {
    maxRestarts: number;
    restartWindow: number;
  };
}

function loadConfig(): AppConfig {
  const env = process.env.NODE_ENV || 'development';

  const baseConfig = {
    env,
    logLevel: process.env.LOG_LEVEL || 'info',
    database: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS || '10', 10),
    },
    supervisor: {
      maxRestarts: parseInt(process.env.MAX_RESTARTS || '5', 10),
      restartWindow: parseInt(process.env.RESTART_WINDOW || '60000', 10),
    },
  };

  // Production overrides
  if (env === 'production') {
    return {
      ...baseConfig,
      supervisor: {
        maxRestarts: 10,
        restartWindow: 300000, // 5 minutes
      },
    };
  }

  return baseConfig as AppConfig;
}
```

---

## Deployment Checklist

### Pre-Deployment

- [ ] All tests passing
- [ ] Logging configured with appropriate levels
- [ ] Health check endpoints implemented
- [ ] Graceful shutdown handlers in place
- [ ] AlertManager configured
- [ ] Environment variables documented

### Monitoring Setup

- [ ] Observer polling enabled
- [ ] Metrics exported to monitoring system
- [ ] Alert handlers connected to notification channels
- [ ] Dashboard accessible (if using Dashboard/DashboardServer)

### Infrastructure

- [ ] Container health checks configured
- [ ] Resource limits set (memory, CPU)
- [ ] Horizontal scaling configured (if needed)
- [ ] Load balancer health checks pointing to `/health`

### Post-Deployment

- [ ] Verify health endpoints responding
- [ ] Check process tree in Observer
- [ ] Confirm alerts are firing (test alert)
- [ ] Monitor memory usage for first hour

---

## Related

- [Debugging Guide](./debugging.md) - Troubleshooting with Observer and Dashboard
- [Observer API](../api/observer.md) - Monitoring API reference
- [AlertManager API](../api/alert-manager.md) - Alerting configuration
- [Supervision Trees Guide](./supervision-trees.md) - Designing fault-tolerant trees
- [Distributed Deployment](../distribution/guides/production-deployment.md) - Docker, Kubernetes, multi-node deployment
