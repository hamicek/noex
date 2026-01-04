# Příručka pro nasazení do produkce

Tato příručka popisuje best practices pro nasazení noex aplikací do produkčního prostředí, včetně monitoringu, zpracování chyb, graceful shutdown a škálování.

## Přehled

Produkčně připravené noex aplikace potřebují:
- **Správné zpracování chyb** a strategie obnovy
- **Monitoring** s Observer a AlertManager
- **Graceful shutdown** handling
- **Logování** pro ladění a audit
- **Správu zdrojů** pro prevenci memory leaků

---

## Struktura aplikace

### Doporučené nastavení

```typescript
import {
  Supervisor,
  GenServer,
  Registry,
  Observer,
  AlertManager,
} from 'noex';

async function startApplication() {
  // 1. Konfigurace alertingu
  AlertManager.configure({
    enabled: true,
    sensitivityMultiplier: 2.5,
    minSamples: 50,
    cooldownMs: 30000,
  });

  // 2. Přihlášení k alertům
  AlertManager.subscribe(handleAlert);

  // 3. Spuštění Observer pollingu
  const stopPolling = Observer.startPolling(5000, handleStatsUpdate);

  // 4. Sestavení supervision stromu
  const app = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 5, withinMs: 60000 },
    children: [
      { id: 'core', start: startCoreSupervisor },
      { id: 'workers', start: startWorkerSupervisor },
      { id: 'api', start: startApiSupervisor },
    ],
  });

  // 5. Registrace shutdown handlerů
  setupShutdownHandlers(app, stopPolling);

  return app;
}
```

### Design supervision stromu

```typescript
// Základní služby, které musí vždy běžet
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

// Worker procesy, které mohou selhat nezávisle
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

### Zpracování signálů

```typescript
function setupShutdownHandlers(
  app: SupervisorRef,
  stopPolling: () => void,
) {
  let isShuttingDown = false;

  async function shutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\nPřijat ${signal}, spouštím graceful shutdown...`);

    // 1. Zastavení přijímání nové práce
    stopPolling();

    // 2. Čas pro dokončení rozpracovaných požadavků
    console.log('Čekám na dokončení požadavků...');
    await new Promise((r) => setTimeout(r, 5000));

    // 3. Zastavení supervision stromu (zastaví potomky v obráceném pořadí)
    console.log('Zastavuji služby...');
    await Supervisor.stop(app, 'shutdown');

    console.log('Shutdown dokončen');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Zpracování neodchycených chyb
  process.on('uncaughtException', (error) => {
    console.error('Neodchycená výjimka:', error);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Neošetřený rejection:', reason);
    // Pro unhandled rejections neukončujeme, jen logujeme
  });
}
```

### Shutdown timeouty

Nakonfigurujte vhodné shutdown timeouty pro každou službu:

```typescript
const children = [
  {
    id: 'database',
    start: () => startDatabasePool(),
    shutdownTimeout: 30000,  // 30s na uzavření spojení
  },
  {
    id: 'cache',
    start: () => startCacheServer(),
    shutdownTimeout: 5000,   // 5s na flush dat
  },
  {
    id: 'api',
    start: () => startApiServer(),
    shutdownTimeout: 10000,  // 10s na dokončení požadavků
  },
];
```

---

## Monitoring

### Integrace Observer

```typescript
import { Observer, AlertManager } from 'noex';

function setupMonitoring() {
  // Přihlášení k lifecycle událostem
  Observer.subscribe((event) => {
    switch (event.type) {
      case 'server_started':
        logger.info(`Proces spuštěn: ${event.stats.name || event.stats.id}`);
        break;
      case 'server_stopped':
        logger.info(`Proces zastaven: ${event.id} (${event.reason})`);
        break;
    }
  });

  // Spuštění pollingu pro statistiky
  Observer.startPolling(5000, (event) => {
    if (event.type === 'stats_update') {
      // Odeslání metrik do externího monitoringu
      sendMetrics({
        processCount: event.servers.length + event.supervisors.length,
        totalMessages: event.servers.reduce((sum, s) => sum + s.messageCount, 0),
        totalRestarts: event.supervisors.reduce((sum, s) => sum + s.totalRestarts, 0),
      });
    }
  });
}
```

### Konfigurace AlertManager

```typescript
// Konfigurace alertů pro produkci
AlertManager.configure({
  enabled: true,
  sensitivityMultiplier: 2.5,  // Méně citlivé pro redukci šumu
  minSamples: 100,             // Čekání na baseline
  cooldownMs: 60000,           // 1 minuta mezi alerty
});

// Zpracování alertů
AlertManager.subscribe((event) => {
  if (event.type === 'alert_triggered') {
    const { alert } = event;

    // Logování alertu
    logger.warn('Alert spuštěn', {
      type: alert.type,
      processId: alert.processId,
      processName: alert.processName,
      threshold: alert.threshold,
      currentValue: alert.currentValue,
    });

    // Odeslání do externího alertovacího systému
    sendToSlack({
      channel: '#alerts',
      text: `*Alert*: ${alert.message}`,
      attachments: [{
        color: 'danger',
        fields: [
          { title: 'Proces', value: alert.processName || alert.processId },
          { title: 'Hodnota', value: `${alert.currentValue} (práh: ${alert.threshold.toFixed(2)})` },
        ],
      }],
    });

    // Odeslání do PagerDuty pro kritické alerty
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

### Health checky

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
      // Kontrola, zda běží všechny požadované služby
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
    console.log(`Health server naslouchá na portu ${port}`);
  });

  return server;
}
```

---

## Logování

### Strukturované logování

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Logování lifecycle událostí
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

// Logování alertů
AlertManager.subscribe((event) => {
  if (event.type === 'alert_triggered') {
    logger.warn({ event: 'alert_triggered', alert: event.alert });
  } else {
    logger.info({ event: 'alert_resolved', processId: event.processId });
  }
});
```

### Logování požadavků ve službách

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

## Zpracování chyb

### Filosofie "Let It Crash"

noex přijímá filosofii "let it crash". Navrhujte služby tak, aby se čistě restartovaly:

```typescript
const robustServiceBehavior = {
  // Stav lze znovu sestavit při restartu
  init: async () => {
    const config = await loadConfig();
    const cache = await rebuildCache();
    return { config, cache, metrics: { requests: 0, errors: 0 } };
  },

  handleCall: (msg, state) => {
    // Nepokoušejte se zotavit z chyb - nechte supervisor restartovat
    // To zajistí, že jsme vždy v čistém stavu
    const result = processMessage(msg, state);
    return [result, { ...state, metrics: { ...state.metrics, requests: state.metrics.requests + 1 } }];
  },

  // Uvolnění zdrojů při shutdownu
  terminate: async (reason, state) => {
    await flushMetrics(state.metrics);
    await closeConnections();
    logger.info('Služba ukončena', { reason });
  },
};
```

### Error boundaries

Pro chyby, které by neměly shodit službu:

```typescript
handleCall: (msg, state) => {
  switch (msg.type) {
    case 'process_item':
      try {
        const result = processItem(msg.item);
        return [{ success: true, result }, state];
      } catch (error) {
        // Logujeme, ale nepadáme pro očekávané chyby
        logger.warn('Nepodařilo se zpracovat položku', { itemId: msg.item.id, error: error.message });
        return [{ success: false, error: error.message }, state];
      }

    case 'critical_operation':
      // Neočekávané chyby nechají službu spadnout
      return [performCriticalOperation(msg), state];
  }
},
```

---

## Správa zdrojů

### Správa paměti

```typescript
// Monitoring využití paměti
Observer.startPolling(10000, (event) => {
  if (event.type === 'stats_update') {
    const memory = Observer.getMemoryStats();
    const heapUsedMB = memory.heapUsed / 1024 / 1024;

    if (heapUsedMB > 500) {
      logger.warn('Vysoké využití paměti', { heapUsedMB });
    }

    // Export metrik
    metrics.gauge('nodejs_heap_used_bytes', memory.heapUsed);
    metrics.gauge('nodejs_heap_total_bytes', memory.heapTotal);
  }
});
```

### Prevence memory leaků

```typescript
const cacheBehavior = {
  init: () => ({
    cache: new Map<string, CacheEntry>(),
    maxSize: 10000,
  }),

  handleCast: (msg, state) => {
    if (msg.type === 'set') {
      // Prevence neomezeného růstu
      if (state.cache.size >= state.maxSize) {
        // Odstranění nejstarších položek
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

### Connection pooling

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
    logger.info('Databázový pool uzavřen', state.metrics);
  },
};
```

---

## Správa konfigurace

### Konfigurace podle prostředí

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

  // Produkční přepisy
  if (env === 'production') {
    return {
      ...baseConfig,
      supervisor: {
        maxRestarts: 10,
        restartWindow: 300000, // 5 minut
      },
    };
  }

  return baseConfig as AppConfig;
}
```

---

## Checklist pro nasazení

### Před nasazením

- [ ] Všechny testy procházejí
- [ ] Logování nakonfigurováno s odpovídajícími úrovněmi
- [ ] Health check endpointy implementovány
- [ ] Graceful shutdown handlery na místě
- [ ] AlertManager nakonfigurován
- [ ] Environment proměnné zdokumentovány

### Nastavení monitoringu

- [ ] Observer polling povolen
- [ ] Metriky exportovány do monitorovacího systému
- [ ] Alert handlery připojeny k notifikačním kanálům
- [ ] Dashboard přístupný (pokud používáte Dashboard/DashboardServer)

### Infrastruktura

- [ ] Kontejnerové health checky nakonfigurovány
- [ ] Resource limity nastaveny (paměť, CPU)
- [ ] Horizontální škálování nakonfigurováno (pokud potřeba)
- [ ] Load balancer health checky směřují na `/health`

### Po nasazení

- [ ] Ověření odpovědí health endpointů
- [ ] Kontrola stromu procesů v Observer
- [ ] Potvrzení, že alerty fungují (testovací alert)
- [ ] Monitoring využití paměti první hodinu

---

## Související

- [Příručka ladění](./debugging.md) - Řešení problémů s Observer a Dashboard
- [Observer API](../api/observer.md) - Reference monitoring API
- [AlertManager API](../api/alert-manager.md) - Konfigurace alertingu
- [Příručka Supervision Trees](./supervision-trees.md) - Design fault-tolerant stromů
