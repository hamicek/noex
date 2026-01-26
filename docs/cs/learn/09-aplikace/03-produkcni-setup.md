# Produkční setup

V předchozích kapitolách jste se naučili strukturovat aplikace a zpracovávat signály pro graceful shutdown. Nyní prozkoumáme finální díl: **produkční setup** — konfiguraci vašich noex aplikací pro nasazení v reálném světě se správným zpracováním prostředí, logováním a health checks.

## Co se naučíte

- Konfigurovat aplikace s environment variables a type-safe configem
- Implementovat strukturované logování pomocí lifecycle eventů a vzorů
- Vytvářet health check endpointy pomocí Observer introspekce
- Nastavit produkční monitoring a alerting

## Konfigurace prostředí

Produkční aplikace se potřebují přizpůsobit různým prostředím (development, staging, production) bez změn kódu. noex poskytuje type-safe konfiguraci přes Application behavior.

### Type-safe konfigurace

Generický parametr `Application.create<Config>()` zajišťuje validaci konfigurace při kompilaci:

```typescript
import { Application, Supervisor } from '@hamicek/noex';

// Definice konfiguračního schématu
interface AppConfig {
  readonly port: number;
  readonly host: string;
  readonly database: {
    readonly url: string;
    readonly poolSize: number;
  };
  readonly features: {
    readonly caching: boolean;
    readonly rateLimit: boolean;
  };
}

const MyApp = Application.create<AppConfig>({
  async start(config) {
    console.log(`Spouštím server na ${config.host}:${config.port}`);
    console.log(`Databáze: ${config.database.url}`);
    console.log(`Caching: ${config.features.caching ? 'zapnuto' : 'vypnuto'}`);

    return Supervisor.start({
      strategy: 'one_for_one',
      children: [
        // Použití hodnot configu pro inicializaci dětí
        { id: 'http', start: () => HttpServer.start(config.port, config.host) },
        { id: 'db', start: () => DbPool.start(config.database) },
      ],
    });
  },
});
```

### Načítání konfigurace z prostředí

Vytvořte configuration loader, který čte z environment variables s rozumnými výchozími hodnotami:

```typescript
function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    database: {
      url: process.env.DATABASE_URL || 'postgresql://localhost:5432/app',
      poolSize: parseInt(process.env.DB_POOL_SIZE || '10', 10),
    },
    features: {
      caching: process.env.FEATURE_CACHING !== 'false',
      rateLimit: process.env.FEATURE_RATE_LIMIT === 'true',
    },
  };
}

// Start s načtenou konfigurací
const app = await Application.start(MyApp, {
  name: 'my-app',
  config: loadConfig(),
  handleSignals: true,
});
```

### Validace konfigurace

Validujte konfiguraci při startu pro rychlé selhání při špatné konfiguraci:

```typescript
class ConfigurationError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Neplatná konfigurace: ${field} — ${reason}`);
    this.name = 'ConfigurationError';
  }
}

function validateConfig(config: AppConfig): void {
  // Validace portu
  if (config.port < 1 || config.port > 65535) {
    throw new ConfigurationError('port', `musí být mezi 1 a 65535, dostal ${config.port}`);
  }

  // Validace databázové URL
  if (!config.database.url.startsWith('postgresql://')) {
    throw new ConfigurationError('database.url', 'musí být validní PostgreSQL URL');
  }

  // Validace velikosti poolu
  if (config.database.poolSize < 1 || config.database.poolSize > 100) {
    throw new ConfigurationError('database.poolSize', `musí být mezi 1 a 100, dostal ${config.database.poolSize}`);
  }
}

function loadConfig(): AppConfig {
  const config: AppConfig = {
    // ... načtení z prostředí
  };

  validateConfig(config);
  return config;
}
```

### Přepisy specifické pro prostředí

Strukturujte konfiguraci pro různá prostředí:

```typescript
type Environment = 'development' | 'staging' | 'production';

function getEnvironment(): Environment {
  const env = process.env.NODE_ENV || 'development';
  if (env !== 'development' && env !== 'staging' && env !== 'production') {
    throw new ConfigurationError('NODE_ENV', `musí být development, staging, nebo production, dostal ${env}`);
  }
  return env;
}

function loadConfig(): AppConfig {
  const env = getEnvironment();

  // Základní konfigurace
  const base: AppConfig = {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    database: {
      url: process.env.DATABASE_URL || '',
      poolSize: 10,
    },
    features: {
      caching: true,
      rateLimit: true,
    },
  };

  // Přepisy specifické pro prostředí
  const overrides: Record<Environment, Partial<AppConfig>> = {
    development: {
      database: { ...base.database, url: 'postgresql://localhost:5432/app_dev', poolSize: 5 },
      features: { caching: false, rateLimit: false },
    },
    staging: {
      database: { ...base.database, poolSize: 20 },
    },
    production: {
      database: { ...base.database, poolSize: 50 },
    },
  };

  return {
    ...base,
    ...overrides[env],
    database: { ...base.database, ...overrides[env].database },
    features: { ...base.features, ...overrides[env].features },
  };
}
```

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    FLOW NAČÍTÁNÍ KONFIGURACE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Environment Variables        Základní Config      Environment Přepisy      │
│  ┌─────────────────────┐     ┌─────────────┐     ┌───────────────────┐     │
│  │ PORT=8080           │     │ port: 3000  │     │ development:      │     │
│  │ NODE_ENV=production │ ──► │ host: 0.0.0 │ ──► │   poolSize: 5     │     │
│  │ DATABASE_URL=...    │     │ poolSize: 10│     │ production:       │     │
│  └─────────────────────┘     └─────────────┘     │   poolSize: 50    │     │
│                                                   └───────────────────┘     │
│                                      │                      │               │
│                                      ▼                      ▼               │
│                              ┌─────────────────────────────────────┐        │
│                              │         SLOUČENÁ KONFIGURACE        │        │
│                              │  ┌───────────────────────────────┐  │        │
│                              │  │ port: 8080 (z env)            │  │        │
│                              │  │ host: 0.0.0.0 (výchozí)       │  │        │
│                              │  │ poolSize: 50 (prod přepis)    │  │        │
│                              │  │ database.url: ... (z env)     │  │        │
│                              │  └───────────────────────────────┘  │        │
│                              └─────────────────────────────────────┘        │
│                                              │                              │
│                                              ▼                              │
│                              ┌─────────────────────────────────────┐        │
│                              │          VALIDACE                   │        │
│                              │  • Rozsah portu (1-65535)           │        │
│                              │  • Formát URL                       │        │
│                              │  • Limity velikosti poolu           │        │
│                              │  • Přítomnost povinných polí        │        │
│                              └─────────────────────────────────────┘        │
│                                              │                              │
│                              ┌───────────────┴───────────────┐              │
│                              ▼                               ▼              │
│                        ┌──────────┐                  ┌────────────┐         │
│                        │  VALIDNÍ │                  │  NEVALIDNÍ │         │
│                        │  Spustit │                  │  Vyhodit   │         │
│                        │  app     │                  │  Error     │         │
│                        └──────────┘                  └────────────┘         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Logování

Produkční systémy potřebují strukturované, konzistentní logování pro debugging a monitoring. Zatímco noex neobsahuje vestavěný logger, poskytuje silné primitivy pro jeho vytvoření.

### Logování lifecycle eventů

Použijte `Application.onLifecycleEvent()` pro zachycení přechodů stavů aplikace:

```typescript
import {
  Application,
  type ApplicationLifecycleEvent,
} from '@hamicek/noex';

function setupLifecycleLogging(): () => void {
  return Application.onLifecycleEvent((event: ApplicationLifecycleEvent) => {
    const timestamp = new Date(event.timestamp).toISOString();

    switch (event.type) {
      case 'starting':
        console.log(JSON.stringify({
          level: 'info',
          timestamp,
          event: 'app_starting',
          app: event.name,
        }));
        break;

      case 'started':
        console.log(JSON.stringify({
          level: 'info',
          timestamp,
          event: 'app_started',
          app: event.ref.name,
        }));
        break;

      case 'stopping':
        const reason = event.reason === 'signal' ? 'signal' :
                      event.reason === 'normal' ? 'normal' :
                      `error:${event.reason.error.message}`;
        console.log(JSON.stringify({
          level: 'warn',
          timestamp,
          event: 'app_stopping',
          app: event.ref.name,
          reason,
        }));
        break;

      case 'stopped':
        console.log(JSON.stringify({
          level: 'info',
          timestamp,
          event: 'app_stopped',
          app: event.name,
        }));
        break;

      case 'start_failed':
        console.log(JSON.stringify({
          level: 'error',
          timestamp,
          event: 'app_start_failed',
          app: event.name,
          error: event.error.message,
          stack: event.error.stack,
        }));
        break;
    }
  });
}

// Použití
const unsubscribe = setupLifecycleLogging();

// Později, pokud potřeba
unsubscribe();
```

### Logování životního cyklu procesů přes Observer

Použijte modul Observer pro logování událostí na úrovni procesů:

```typescript
import { Observer } from '@hamicek/noex';

function setupProcessLogging(): () => void {
  return Observer.subscribe((event) => {
    const timestamp = new Date().toISOString();

    switch (event.type) {
      case 'server_started':
        console.log(JSON.stringify({
          level: 'info',
          timestamp,
          event: 'process_started',
          processId: event.id,
          name: event.name,
          processType: 'genserver',
        }));
        break;

      case 'server_stopped':
        console.log(JSON.stringify({
          level: 'info',
          timestamp,
          event: 'process_stopped',
          processId: event.id,
          name: event.name,
          reason: event.reason,
        }));
        break;

      case 'supervisor_child_restarted':
        console.log(JSON.stringify({
          level: 'warn',
          timestamp,
          event: 'process_restarted',
          supervisorId: event.supervisorId,
          childId: event.childId,
          restartCount: event.restartCount,
        }));
        break;

      case 'supervisor_max_restarts':
        console.log(JSON.stringify({
          level: 'error',
          timestamp,
          event: 'max_restarts_exceeded',
          supervisorId: event.supervisorId,
          childId: event.childId,
        }));
        break;
    }
  });
}
```

### Strukturovaná služba loggeru

Pro větší kontrolu vytvořte dedikovaný logger GenServer:

```typescript
import { GenServer, type GenServerBehavior } from '@hamicek/noex';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  timestamp: number;
}

interface LoggerState {
  buffer: LogEntry[];
  minLevel: LogLevel;
  flushIntervalMs: number;
  maxBufferSize: number;
}

type LoggerCall =
  | { type: 'flush' }
  | { type: 'getStats' }
  | { type: 'setLevel'; level: LogLevel };

type LoggerCast =
  | { type: 'log'; entry: Omit<LogEntry, 'timestamp'> };

type LoggerReply =
  | { flushed: number }
  | { bufferSize: number; minLevel: LogLevel }
  | { level: LogLevel };

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LoggerBehavior: GenServerBehavior<LoggerState, LoggerCall, LoggerCast, LoggerReply> = {
  init: () => ({
    buffer: [],
    minLevel: (process.env.LOG_LEVEL as LogLevel) || 'info',
    flushIntervalMs: 1000,
    maxBufferSize: 100,
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'flush': {
        flushBuffer(state.buffer);
        return [{ flushed: state.buffer.length }, { ...state, buffer: [] }];
      }

      case 'getStats':
        return [{ bufferSize: state.buffer.length, minLevel: state.minLevel }, state];

      case 'setLevel':
        return [{ level: msg.level }, { ...state, minLevel: msg.level }];
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'log') {
      // Kontrola log úrovně
      if (LOG_LEVELS[msg.entry.level] < LOG_LEVELS[state.minLevel]) {
        return state;
      }

      const entry: LogEntry = {
        ...msg.entry,
        timestamp: Date.now(),
      };

      const newBuffer = [...state.buffer, entry];

      // Flush pokud je buffer plný
      if (newBuffer.length >= state.maxBufferSize) {
        flushBuffer(newBuffer);
        return { ...state, buffer: [] };
      }

      return { ...state, buffer: newBuffer };
    }
    return state;
  },

  terminate: (reason, state) => {
    // Flush zbývajících logů při shutdownu
    if (state.buffer.length > 0) {
      flushBuffer(state.buffer);
    }
  },
};

function flushBuffer(entries: LogEntry[]): void {
  for (const entry of entries) {
    const output = JSON.stringify({
      level: entry.level,
      timestamp: new Date(entry.timestamp).toISOString(),
      message: entry.message,
      ...entry.context,
    });
    console.log(output);
  }
}

// Helper funkce pro logování
export const Logger = {
  async start() {
    return GenServer.start(LoggerBehavior, { name: 'logger' });
  },

  debug(ref: GenServerRef, message: string, context?: Record<string, unknown>) {
    GenServer.cast(ref, { type: 'log', entry: { level: 'debug', message, context } });
  },

  info(ref: GenServerRef, message: string, context?: Record<string, unknown>) {
    GenServer.cast(ref, { type: 'log', entry: { level: 'info', message, context } });
  },

  warn(ref: GenServerRef, message: string, context?: Record<string, unknown>) {
    GenServer.cast(ref, { type: 'log', entry: { level: 'warn', message, context } });
  },

  error(ref: GenServerRef, message: string, context?: Record<string, unknown>) {
    GenServer.cast(ref, { type: 'log', entry: { level: 'error', message, context } });
  },

  async flush(ref: GenServerRef) {
    return GenServer.call(ref, { type: 'flush' });
  },
};
```

### Best practices logování

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BEST PRACTICES LOGOVÁNÍ                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ✓ DOPORUČENO                              ✗ NEDOPORUČENO                   │
│  ─────────────────────────────────────   ─────────────────────────────────  │
│                                                                             │
│  • Používat strukturovaný JSON formát      • Logovat citlivá data (hesla,   │
│  • Zahrnout časové značky (ISO 8601)         API klíče, tokeny)             │
│  • Přidat correlation IDs pro tracing      • Logovat na debug úrovni v prod │
│  • Logovat na odpovídajících úrovních      • Používat console.log přímo v   │
│  • Bufferovat logy pro batch zápis           GenServerech (použít službu)   │
│  • Flush logů při graceful shutdown        • Ignorovat rotaci logů          │
│  • Konzistentně používat log úrovně        • Logovat stack traces pro warn  │
│                                                                             │
│  GUIDELINES PRO LOG ÚROVNĚ                                                  │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  DEBUG  → Detaily pouze pro vývoj, hodnoty proměnných, tracing flow         │
│  INFO   → Normální operace, startup/shutdown, významné události             │
│  WARN   → Zotavitelné problémy, retrye, deprecations, vysoká latence        │
│  ERROR  → Selhání vyžadující pozornost, neošetřené chyby, crashe            │
│                                                                             │
│  DOPORUČENÍ LOG ÚROVNÍ PRO PRODUKCI                                         │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  Development: debug     (všechny logy)                                      │
│  Staging:     info      (info + warn + error)                               │
│  Production:  warn      (pouze warn + error)                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Health checks

Health checks umožňují load balancerům, orchestrátorům a monitorovacím systémům určit, zda vaše aplikace správně funguje. Modul Observer v noex poskytuje data, která potřebujete.

### Základní health endpoint

Vytvořte jednoduchý health check endpoint:

```typescript
import { Observer } from '@hamicek/noex';

// Použití Express-style handleru (přizpůsobte svému frameworku)
app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});
```

### Komprehensivní health check

Použijte Observer pro zahrnutí detailního stavu systému:

```typescript
import { Observer } from '@hamicek/noex';

interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  checks: {
    processes: { status: string; count: number };
    memory: { status: string; heapUsedMB: number; heapTotalMB: number };
    restarts: { status: string; total: number; recent: number };
  };
}

app.get('/health', async (req, res) => {
  const snapshot = Observer.getSnapshot();
  const memoryStats = Observer.getMemoryStats();

  // Výpočet health stavu
  const heapUsedMB = Math.round(memoryStats.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(memoryStats.heapTotal / 1024 / 1024);
  const heapUsagePercent = (memoryStats.heapUsed / memoryStats.heapTotal) * 100;

  // Určení stavů jednotlivých kontrol
  const processStatus = snapshot.processCount > 0 ? 'ok' : 'critical';
  const memoryStatus = heapUsagePercent < 80 ? 'ok' : heapUsagePercent < 95 ? 'warning' : 'critical';
  const restartStatus = snapshot.totalRestarts < 10 ? 'ok' : snapshot.totalRestarts < 50 ? 'warning' : 'critical';

  // Celkový stav
  const hasWarning = [processStatus, memoryStatus, restartStatus].includes('warning');
  const hasCritical = [processStatus, memoryStatus, restartStatus].includes('critical');

  const status = hasCritical ? 'unhealthy' : hasWarning ? 'degraded' : 'healthy';

  const response: HealthCheckResponse = {
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      processes: { status: processStatus, count: snapshot.processCount },
      memory: { status: memoryStatus, heapUsedMB, heapTotalMB },
      restarts: { status: restartStatus, total: snapshot.totalRestarts, recent: snapshot.totalRestarts },
    },
  };

  // HTTP status kód podle zdraví
  const httpStatus = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;
  res.status(httpStatus).json(response);
});
```

### Kubernetes probes

Kubernetes používá tři typy sond. Implementujte je pro robustní container orchestraci:

```typescript
import { Observer, Application } from '@hamicek/noex';

// Liveness probe — běží aplikace?
// Pokud selže, Kubernetes restartuje kontejner
app.get('/health/live', async (req, res) => {
  // Jednoduchá kontrola: pokud můžeme odpovědět, žijeme
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Readiness probe — může aplikace přijímat traffic?
// Pokud selže, Kubernetes odstraní pod z service endpointů
app.get('/health/ready', async (req, res) => {
  const snapshot = Observer.getSnapshot();

  // Kontrola zda běží kritické služby
  const isReady =
    snapshot.processCount > 0 &&
    Application.isRunning(appRef);

  if (isReady) {
    res.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      processCount: snapshot.processCount,
    });
  } else {
    res.status(503).json({
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      reason: 'kritické služby neběží',
    });
  }
});

// Startup probe — startovala aplikace?
// Užitečné pro pomalu startující aplikace
let startupComplete = false;

app.get('/health/startup', async (req, res) => {
  if (startupComplete) {
    res.json({ status: 'started', timestamp: new Date().toISOString() });
  } else {
    res.status(503).json({ status: 'starting', timestamp: new Date().toISOString() });
  }
});

// Označit startup jako dokončený po startu Application
Application.onLifecycleEvent((event) => {
  if (event.type === 'started' && event.ref.name === 'my-app') {
    startupComplete = true;
  }
});
```

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       PŘEHLED KUBERNETES PROBES                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐         │
│  │  STARTUP PROBE  │    │ READINESS PROBE │    │  LIVENESS PROBE │         │
│  │  /health/startup│    │  /health/ready  │    │  /health/live   │         │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘         │
│           │                      │                      │                   │
│           ▼                      ▼                      ▼                   │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐         │
│  │ "Je app plně    │    │ "Může app       │    │ "Běží ještě     │         │
│  │  inicializovaná?"│    │  zpracovat      │    │  proces app?"   │         │
│  │                 │    │  traffic?"      │    │                 │         │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘         │
│                                                                             │
│  AKCE PŘI SELHÁNÍ:                                                          │
│  ─────────────────                                                          │
│  Startup:   Zabít kontejner, nechat restartovat (startup trvá příliš)       │
│  Readiness: Odstranit ze Service endpointů (dočasné přetížení)              │
│  Liveness:  Zabít kontejner, nechat restartovat (aplikace se zasekla)       │
│                                                                             │
│  PŘÍKLAD KUBERNETES KONFIGURACE:                                            │
│  ─────────────────────────────────                                          │
│                                                                             │
│  spec:                                                                      │
│    containers:                                                              │
│    - name: my-app                                                           │
│      startupProbe:                                                          │
│        httpGet:                                                             │
│          path: /health/startup                                              │
│          port: 3000                                                         │
│        failureThreshold: 30         # 30 × 10s = 5 min max startup          │
│        periodSeconds: 10                                                    │
│      readinessProbe:                                                        │
│        httpGet:                                                             │
│          path: /health/ready                                                │
│          port: 3000                                                         │
│        periodSeconds: 5                                                     │
│        failureThreshold: 3                                                  │
│      livenessProbe:                                                         │
│        httpGet:                                                             │
│          path: /health/live                                                 │
│          port: 3000                                                         │
│        periodSeconds: 10                                                    │
│        failureThreshold: 3                                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Health checks závislostí

Kontrola zdraví externích závislostí:

```typescript
interface DependencyCheck {
  name: string;
  check: () => Promise<boolean>;
  required: boolean;  // Pokud true, selhání dělá app unhealthy
}

const dependencies: DependencyCheck[] = [
  {
    name: 'database',
    check: async () => {
      const db = Registry.lookup('database');
      if (!db) return false;
      const result = await GenServer.call(db, { type: 'ping' }, 5000);
      return result.ok === true;
    },
    required: true,
  },
  {
    name: 'cache',
    check: async () => {
      const cache = Registry.lookup('cache');
      if (!cache) return false;
      const result = await GenServer.call(cache, { type: 'ping' }, 2000);
      return result.ok === true;
    },
    required: false,  // Cache je volitelná
  },
  {
    name: 'external-api',
    check: async () => {
      try {
        const response = await fetch('https://api.example.com/health', {
          signal: AbortSignal.timeout(3000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    required: false,
  },
];

app.get('/health/detailed', async (req, res) => {
  const results = await Promise.all(
    dependencies.map(async (dep) => {
      try {
        const healthy = await dep.check();
        return { name: dep.name, status: healthy ? 'ok' : 'failed', required: dep.required };
      } catch (error) {
        return {
          name: dep.name,
          status: 'error',
          required: dep.required,
          error: error instanceof Error ? error.message : 'unknown',
        };
      }
    }),
  );

  const requiredFailed = results.some((r) => r.required && r.status !== 'ok');
  const anyFailed = results.some((r) => r.status !== 'ok');

  const status = requiredFailed ? 'unhealthy' : anyFailed ? 'degraded' : 'healthy';

  res.status(status === 'unhealthy' ? 503 : 200).json({
    status,
    timestamp: new Date().toISOString(),
    dependencies: results,
  });
});
```

## Kompletní příklad

Zde je kompletní produkční setup:

```typescript
import {
  Application,
  Supervisor,
  GenServer,
  Observer,
  Registry,
  type SupervisorRef,
  type GenServerRef,
  type ApplicationLifecycleEvent,
} from '@hamicek/noex';
import Fastify from 'fastify';

// Konfigurace
interface ProductionConfig {
  readonly port: number;
  readonly host: string;
  readonly metricsPort: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly shutdownTimeoutMs: number;
}

function loadConfig(): ProductionConfig {
  const config: ProductionConfig = {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    metricsPort: parseInt(process.env.METRICS_PORT || '9090', 10),
    logLevel: (process.env.LOG_LEVEL as ProductionConfig['logLevel']) || 'info',
    shutdownTimeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT || '30000', 10),
  };

  // Validace
  if (config.port < 1 || config.port > 65535) {
    throw new Error(`Neplatný PORT: ${config.port}`);
  }

  return config;
}

// Strukturované logování
function log(level: string, message: string, context?: Record<string, unknown>) {
  console.log(JSON.stringify({
    level,
    timestamp: new Date().toISOString(),
    message,
    ...context,
  }));
}

// Application behavior
const ProductionApp = Application.create<ProductionConfig>({
  async start(config) {
    log('info', 'Spouštím produkční aplikaci', { port: config.port });

    // Start základních služeb
    const supervisor = await Supervisor.start({
      strategy: 'rest_for_one',
      children: [
        { id: 'logger', start: () => LoggerService.start(config.logLevel) },
        { id: 'metrics', start: () => MetricsService.start() },
        { id: 'api', start: () => ApiService.start(config.port, config.host) },
      ],
    });

    log('info', 'Aplikace úspěšně spuštěna', {
      processCount: Observer.getSnapshot().processCount,
    });

    return supervisor;
  },

  async prepStop(supervisor) {
    log('info', 'Připravuji se na shutdown');

    // Zastavit přijímání nových požadavků
    const api = Supervisor.getChild(supervisor, 'api');
    if (api) {
      await GenServer.call(api, { type: 'drain' });
      log('info', 'API vyprázdněno');
    }
  },

  async stop(supervisor) {
    // Flush logů
    const logger = Supervisor.getChild(supervisor, 'logger');
    if (logger) {
      await GenServer.call(logger, { type: 'flush' });
    }

    log('info', 'Shutdown dokončen');
  },
});

// Health check server (oddělený od hlavního API)
async function startHealthServer(config: ProductionConfig, appRef: ApplicationRef) {
  const healthApp = Fastify();

  healthApp.get('/health/live', async () => ({
    status: 'alive',
    timestamp: new Date().toISOString(),
  }));

  healthApp.get('/health/ready', async (request, reply) => {
    const snapshot = Observer.getSnapshot();
    const isReady = Application.isRunning(appRef) && snapshot.processCount > 0;

    if (!isReady) {
      reply.status(503);
    }

    return {
      status: isReady ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      processCount: snapshot.processCount,
    };
  });

  healthApp.get('/health', async () => {
    const snapshot = Observer.getSnapshot();
    const memory = Observer.getMemoryStats();

    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      processes: snapshot.processCount,
      memory: {
        heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(memory.heapTotal / 1024 / 1024),
        rssMB: Math.round(memory.rss / 1024 / 1024),
      },
      restarts: snapshot.totalRestarts,
    };
  });

  await healthApp.listen({ port: config.metricsPort, host: '0.0.0.0' });
  log('info', 'Health server spuštěn', { port: config.metricsPort });

  return healthApp;
}

// Hlavní vstupní bod
async function main() {
  const config = loadConfig();

  // Setup lifecycle logování
  Application.onLifecycleEvent((event: ApplicationLifecycleEvent) => {
    switch (event.type) {
      case 'starting':
        log('info', 'Aplikace startuje', { name: event.name });
        break;
      case 'started':
        log('info', 'Aplikace spuštěna', { name: event.ref.name });
        break;
      case 'stopping':
        log('info', 'Aplikace se zastavuje', {
          name: event.ref.name,
          reason: event.reason === 'signal' ? 'signal' :
                  event.reason === 'normal' ? 'normal' :
                  `error:${event.reason.error.message}`,
        });
        break;
      case 'stopped':
        log('info', 'Aplikace zastavena', { name: event.name });
        break;
      case 'start_failed':
        log('error', 'Aplikace selhala při startu', {
          name: event.name,
          error: event.error.message,
        });
        break;
    }
  });

  // Setup logování procesů
  Observer.subscribe((event) => {
    if (event.type === 'supervisor_child_restarted') {
      log('warn', 'Proces restartován', {
        supervisorId: event.supervisorId,
        childId: event.childId,
        restartCount: event.restartCount,
      });
    }
  });

  try {
    // Start aplikace
    const appRef = await Application.start(ProductionApp, {
      name: 'production-api',
      config,
      handleSignals: true,
      stopTimeout: config.shutdownTimeoutMs,
    });

    // Start health check serveru
    const healthServer = await startHealthServer(config, appRef);

    log('info', 'Produkční server připraven', {
      pid: process.pid,
      port: config.port,
      metricsPort: config.metricsPort,
      nodeEnv: process.env.NODE_ENV,
    });

  } catch (error) {
    log('error', 'Selhání při startu aplikace', {
      error: error instanceof Error ? error.message : 'unknown',
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

main();
```

## Shrnutí

**Klíčové poznatky:**

- **Type-safe konfigurace** brání runtime chybám ze špatné konfigurace
- **Environment variables** umožňují flexibilitu nasazení bez změn kódu
- **Validace konfigurace** selže rychle při startu, ne v produkci
- **Strukturované JSON logování** umožňuje agregaci a analýzu logů
- **Lifecycle eventy** poskytují náhled do přechodů stavů aplikace
- **Health checks** umožňují load balancerům a orchestrátorům řídit traffic

**Produkční checklist:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CHECKLIST PRODUKČNÍ PŘIPRAVENOSTI                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  KONFIGURACE                                                                │
│  ☐ Všechny config hodnoty mají rozumné výchozí hodnoty                      │
│  ☐ Validace selže rychle při startu                                         │
│  ☐ Citlivé hodnoty přichází z prostředí (ne hardcoded)                      │
│  ☐ Různá prostředí mají odpovídající přepisy                                │
│                                                                             │
│  LOGOVÁNÍ                                                                   │
│  ☐ JSON formát pro agregaci logů                                            │
│  ☐ Odpovídající log úrovně (warn/error v prod)                              │
│  ☐ Žádná citlivá data v logách                                              │
│  ☐ Lifecycle eventy logovány                                                │
│  ☐ Logy flushovány při shutdownu                                            │
│                                                                             │
│  HEALTH CHECKS                                                              │
│  ☐ /health/live endpoint (liveness)                                         │
│  ☐ /health/ready endpoint (readiness)                                       │
│  ☐ /health/startup endpoint (pokud pomalý startup)                          │
│  ☐ Detailní /health pro debugging                                           │
│  ☐ Health port oddělený od API portu                                        │
│                                                                             │
│  GRACEFUL SHUTDOWN                                                          │
│  ☐ Signal handlery nakonfigurovány                                          │
│  ☐ Vyprázdnění požadavků implementováno                                     │
│  ☐ Timeout < Kubernetes terminationGracePeriodSeconds                       │
│  ☐ Finální metriky/logy flushovány                                          │
│                                                                             │
│  MONITORING                                                                 │
│  ☐ Observer eventy přihlášeny                                               │
│  ☐ Restart alerty nakonfigurovány                                           │
│  ☐ Využití paměti sledováno                                                 │
│  ☐ Počet procesů monitorován                                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Pamatujte:**

> Produkce není prostředí — je to způsob myšlení. Každá aplikace by měla být napsána jako by zpracovávala reálný provoz, reálná selhání a reálné operátory snažící se pochopit co se pokazilo ve 3 ráno. Konfigurace, logování a health checks nejsou dodatečné náležitosti — jsou základní požadavky.

---

Další: [Observer](../../learn/10-monitoring/01-observer.md)
