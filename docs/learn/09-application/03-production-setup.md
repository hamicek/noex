# Production Setup

In the previous chapters, you learned how to structure applications and handle signals for graceful shutdown. Now let's explore the final piece: **production setup** — configuring your noex applications for real-world deployment with proper environment handling, logging, and health checks.

## What You'll Learn

- Configure applications with environment variables and type-safe config
- Implement structured logging using lifecycle events and patterns
- Build health check endpoints using Observer introspection
- Set up production-ready monitoring and alerting

## Environment Configuration

Production applications need to adapt to different environments (development, staging, production) without code changes. noex provides type-safe configuration through the Application behavior.

### Type-Safe Configuration

The `Application.create<Config>()` generic parameter ensures your configuration is validated at compile time:

```typescript
import { Application, Supervisor } from '@hamicek/noex';

// Define configuration schema
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
    console.log(`Starting server on ${config.host}:${config.port}`);
    console.log(`Database: ${config.database.url}`);
    console.log(`Caching: ${config.features.caching ? 'enabled' : 'disabled'}`);

    return Supervisor.start({
      strategy: 'one_for_one',
      children: [
        // Use config values for child initialization
        { id: 'http', start: () => HttpServer.start(config.port, config.host) },
        { id: 'db', start: () => DbPool.start(config.database) },
      ],
    });
  },
});
```

### Loading Configuration from Environment

Create a configuration loader that reads from environment variables with sensible defaults:

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

// Start with loaded config
const app = await Application.start(MyApp, {
  name: 'my-app',
  config: loadConfig(),
  handleSignals: true,
});
```

### Configuration Validation

Validate configuration at startup to fail fast on misconfiguration:

```typescript
class ConfigurationError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Invalid configuration: ${field} — ${reason}`);
    this.name = 'ConfigurationError';
  }
}

function validateConfig(config: AppConfig): void {
  // Port validation
  if (config.port < 1 || config.port > 65535) {
    throw new ConfigurationError('port', `must be between 1 and 65535, got ${config.port}`);
  }

  // Database URL validation
  if (!config.database.url.startsWith('postgresql://')) {
    throw new ConfigurationError('database.url', 'must be a valid PostgreSQL URL');
  }

  // Pool size validation
  if (config.database.poolSize < 1 || config.database.poolSize > 100) {
    throw new ConfigurationError('database.poolSize', `must be between 1 and 100, got ${config.database.poolSize}`);
  }
}

function loadConfig(): AppConfig {
  const config: AppConfig = {
    // ... load from environment
  };

  validateConfig(config);
  return config;
}
```

### Environment-Specific Overrides

Structure configuration for different environments:

```typescript
type Environment = 'development' | 'staging' | 'production';

function getEnvironment(): Environment {
  const env = process.env.NODE_ENV || 'development';
  if (env !== 'development' && env !== 'staging' && env !== 'production') {
    throw new ConfigurationError('NODE_ENV', `must be development, staging, or production, got ${env}`);
  }
  return env;
}

function loadConfig(): AppConfig {
  const env = getEnvironment();

  // Base configuration
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

  // Environment-specific overrides
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
│                    CONFIGURATION LOADING FLOW                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Environment Variables        Base Config         Environment Overrides     │
│  ┌─────────────────────┐     ┌─────────────┐     ┌───────────────────┐     │
│  │ PORT=8080           │     │ port: 3000  │     │ development:      │     │
│  │ NODE_ENV=production │ ──► │ host: 0.0.0 │ ──► │   poolSize: 5     │     │
│  │ DATABASE_URL=...    │     │ poolSize: 10│     │ production:       │     │
│  └─────────────────────┘     └─────────────┘     │   poolSize: 50    │     │
│                                                   └───────────────────┘     │
│                                      │                      │               │
│                                      ▼                      ▼               │
│                              ┌─────────────────────────────────────┐        │
│                              │         MERGED CONFIG               │        │
│                              │  ┌───────────────────────────────┐  │        │
│                              │  │ port: 8080 (from env)         │  │        │
│                              │  │ host: 0.0.0.0 (default)       │  │        │
│                              │  │ poolSize: 50 (prod override)  │  │        │
│                              │  │ database.url: ... (from env)  │  │        │
│                              │  └───────────────────────────────┘  │        │
│                              └─────────────────────────────────────┘        │
│                                              │                              │
│                                              ▼                              │
│                              ┌─────────────────────────────────────┐        │
│                              │          VALIDATION                 │        │
│                              │  • Port range (1-65535)             │        │
│                              │  • URL format                       │        │
│                              │  • Pool size limits                 │        │
│                              │  • Required fields present          │        │
│                              └─────────────────────────────────────┘        │
│                                              │                              │
│                              ┌───────────────┴───────────────┐              │
│                              ▼                               ▼              │
│                        ┌──────────┐                  ┌────────────┐         │
│                        │  VALID   │                  │  INVALID   │         │
│                        │  Start   │                  │  Throw     │         │
│                        │  app     │                  │  Error     │         │
│                        └──────────┘                  └────────────┘         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Logging

Production systems need structured, consistent logging for debugging and monitoring. While noex doesn't include a built-in logger, it provides powerful primitives for building one.

### Lifecycle Event Logging

Use `Application.onLifecycleEvent()` to capture application state transitions:

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

// Usage
const unsubscribe = setupLifecycleLogging();

// Later, if needed
unsubscribe();
```

### Process Lifecycle Logging via Observer

Use the Observer module to log process-level events:

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

### Structured Logger Service

For more control, create a dedicated logger GenServer:

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
      // Check log level
      if (LOG_LEVELS[msg.entry.level] < LOG_LEVELS[state.minLevel]) {
        return state;
      }

      const entry: LogEntry = {
        ...msg.entry,
        timestamp: Date.now(),
      };

      const newBuffer = [...state.buffer, entry];

      // Flush if buffer is full
      if (newBuffer.length >= state.maxBufferSize) {
        flushBuffer(newBuffer);
        return { ...state, buffer: [] };
      }

      return { ...state, buffer: newBuffer };
    }
    return state;
  },

  terminate: (reason, state) => {
    // Flush remaining logs on shutdown
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

// Helper functions for logging
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

### Logging Best Practices

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         LOGGING BEST PRACTICES                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ✓ DO                                    ✗ DON'T                            │
│  ─────────────────────────────────────   ─────────────────────────────────  │
│                                                                             │
│  • Use structured JSON format            • Log sensitive data (passwords,   │
│  • Include timestamps (ISO 8601)           API keys, tokens)                │
│  • Add correlation IDs for tracing       • Log at debug level in prod      │
│  • Log at appropriate levels             • Use console.log directly in     │
│  • Buffer logs for batch writing           GenServers (use logger service) │
│  • Flush logs on graceful shutdown       • Ignore log rotation             │
│  • Use log levels consistently           • Log stack traces for warnings   │
│                                                                             │
│  LOG LEVEL GUIDELINES                                                       │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  DEBUG  → Development-only details, variable values, flow tracing          │
│  INFO   → Normal operations, startup/shutdown, significant events          │
│  WARN   → Recoverable issues, retries, deprecations, high latency          │
│  ERROR  → Failures requiring attention, unhandled errors, crashes          │
│                                                                             │
│  PRODUCTION LOG LEVEL RECOMMENDATION                                        │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  Development: debug     (all logs)                                          │
│  Staging:     info      (info + warn + error)                               │
│  Production:  warn      (warn + error only)                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Health Checks

Health checks enable load balancers, orchestrators, and monitoring systems to determine if your application is functioning correctly. noex's Observer module provides the data you need.

### Basic Health Endpoint

Create a simple health check endpoint:

```typescript
import { Observer } from '@hamicek/noex';

// Using Express-style handler (adapt to your framework)
app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});
```

### Comprehensive Health Check

Use Observer to include detailed system state:

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

  // Calculate health status
  const heapUsedMB = Math.round(memoryStats.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(memoryStats.heapTotal / 1024 / 1024);
  const heapUsagePercent = (memoryStats.heapUsed / memoryStats.heapTotal) * 100;

  // Determine individual check statuses
  const processStatus = snapshot.processCount > 0 ? 'ok' : 'critical';
  const memoryStatus = heapUsagePercent < 80 ? 'ok' : heapUsagePercent < 95 ? 'warning' : 'critical';
  const restartStatus = snapshot.totalRestarts < 10 ? 'ok' : snapshot.totalRestarts < 50 ? 'warning' : 'critical';

  // Overall status
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

  // HTTP status code based on health
  const httpStatus = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;
  res.status(httpStatus).json(response);
});
```

### Kubernetes Probes

Kubernetes uses three types of probes. Implement them for robust container orchestration:

```typescript
import { Observer, Application } from '@hamicek/noex';

// Liveness probe — is the application running?
// If this fails, Kubernetes restarts the container
app.get('/health/live', async (req, res) => {
  // Simple check: if we can respond, we're alive
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Readiness probe — can the application accept traffic?
// If this fails, Kubernetes removes the pod from service endpoints
app.get('/health/ready', async (req, res) => {
  const snapshot = Observer.getSnapshot();

  // Check if critical services are running
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
      reason: 'critical services not running',
    });
  }
});

// Startup probe — has the application started?
// Useful for slow-starting applications
let startupComplete = false;

app.get('/health/startup', async (req, res) => {
  if (startupComplete) {
    res.json({ status: 'started', timestamp: new Date().toISOString() });
  } else {
    res.status(503).json({ status: 'starting', timestamp: new Date().toISOString() });
  }
});

// Mark startup complete after Application starts
Application.onLifecycleEvent((event) => {
  if (event.type === 'started' && event.ref.name === 'my-app') {
    startupComplete = true;
  }
});
```

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       KUBERNETES PROBES OVERVIEW                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐         │
│  │  STARTUP PROBE  │    │ READINESS PROBE │    │  LIVENESS PROBE │         │
│  │  /health/startup│    │  /health/ready  │    │  /health/live   │         │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘         │
│           │                      │                      │                   │
│           ▼                      ▼                      ▼                   │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐         │
│  │ "Is app fully   │    │ "Can app handle │    │ "Is app process │         │
│  │  initialized?"  │    │  traffic now?"  │    │  still running?"│         │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘         │
│                                                                             │
│  FAILURE ACTIONS:                                                           │
│  ─────────────────                                                          │
│  Startup:   Kill container, let it restart (startup taking too long)        │
│  Readiness: Remove from Service endpoints (temporary overload)              │
│  Liveness:  Kill container, let it restart (application stuck)              │
│                                                                             │
│  KUBERNETES CONFIGURATION EXAMPLE:                                          │
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

### Dependency Health Checks

Check the health of external dependencies:

```typescript
interface DependencyCheck {
  name: string;
  check: () => Promise<boolean>;
  required: boolean;  // If true, failure makes app unhealthy
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
    required: false,  // Cache is optional
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

## Putting It All Together

Here's a complete production-ready setup:

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

// Configuration
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

  // Validation
  if (config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid PORT: ${config.port}`);
  }

  return config;
}

// Structured logging
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
    log('info', 'Starting production application', { port: config.port });

    // Start core services
    const supervisor = await Supervisor.start({
      strategy: 'rest_for_one',
      children: [
        { id: 'logger', start: () => LoggerService.start(config.logLevel) },
        { id: 'metrics', start: () => MetricsService.start() },
        { id: 'api', start: () => ApiService.start(config.port, config.host) },
      ],
    });

    log('info', 'Application started successfully', {
      processCount: Observer.getSnapshot().processCount,
    });

    return supervisor;
  },

  async prepStop(supervisor) {
    log('info', 'Preparing for shutdown');

    // Stop accepting new requests
    const api = Supervisor.getChild(supervisor, 'api');
    if (api) {
      await GenServer.call(api, { type: 'drain' });
      log('info', 'API drained');
    }
  },

  async stop(supervisor) {
    // Flush logs
    const logger = Supervisor.getChild(supervisor, 'logger');
    if (logger) {
      await GenServer.call(logger, { type: 'flush' });
    }

    log('info', 'Shutdown complete');
  },
});

// Health check server (separate from main API)
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
  log('info', 'Health server started', { port: config.metricsPort });

  return healthApp;
}

// Main entry point
async function main() {
  const config = loadConfig();

  // Setup lifecycle logging
  Application.onLifecycleEvent((event: ApplicationLifecycleEvent) => {
    switch (event.type) {
      case 'starting':
        log('info', 'Application starting', { name: event.name });
        break;
      case 'started':
        log('info', 'Application started', { name: event.ref.name });
        break;
      case 'stopping':
        log('info', 'Application stopping', {
          name: event.ref.name,
          reason: event.reason === 'signal' ? 'signal' :
                  event.reason === 'normal' ? 'normal' :
                  `error:${event.reason.error.message}`,
        });
        break;
      case 'stopped':
        log('info', 'Application stopped', { name: event.name });
        break;
      case 'start_failed':
        log('error', 'Application failed to start', {
          name: event.name,
          error: event.error.message,
        });
        break;
    }
  });

  // Setup process logging
  Observer.subscribe((event) => {
    if (event.type === 'supervisor_child_restarted') {
      log('warn', 'Process restarted', {
        supervisorId: event.supervisorId,
        childId: event.childId,
        restartCount: event.restartCount,
      });
    }
  });

  try {
    // Start application
    const appRef = await Application.start(ProductionApp, {
      name: 'production-api',
      config,
      handleSignals: true,
      stopTimeout: config.shutdownTimeoutMs,
    });

    // Start health check server
    const healthServer = await startHealthServer(config, appRef);

    log('info', 'Production server ready', {
      pid: process.pid,
      port: config.port,
      metricsPort: config.metricsPort,
      nodeEnv: process.env.NODE_ENV,
    });

  } catch (error) {
    log('error', 'Failed to start application', {
      error: error instanceof Error ? error.message : 'unknown',
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

main();
```

## Exercise: Production Microservice

Build a production-ready microservice with all the production features covered:

**Requirements:**

1. **Type-safe configuration** with environment variables and validation
2. **Structured JSON logging** with appropriate log levels
3. **Health endpoints** for Kubernetes (liveness, readiness, detailed health)
4. **Graceful shutdown** with request draining
5. **Metrics collection** via Observer

**Starter code:**

```typescript
import {
  Application,
  Supervisor,
  GenServer,
  Observer,
  type GenServerBehavior,
} from '@hamicek/noex';

// TODO: Define configuration interface
interface ServiceConfig {
  // port, host, logLevel, dependencies...
}

// TODO: Implement configuration loading with validation
function loadConfig(): ServiceConfig {
  // Load from environment, validate, return
}

// TODO: Implement structured logger
function log(level: string, message: string, context?: Record<string, unknown>): void {
  // Output JSON to console
}

// TODO: Implement worker service that processes requests
// - Tracks request count
// - Has a drain mode for shutdown
// - Reports stats

// TODO: Implement Application behavior
// - start: initialize all services
// - prepStop: drain workers
// - stop: flush final metrics

// TODO: Setup health endpoints
// - /health/live
// - /health/ready
// - /health (detailed)

// TODO: Main entry point
// - Load config
// - Setup lifecycle logging
// - Start application
// - Start health server
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
import {
  Application,
  Supervisor,
  GenServer,
  Observer,
  Registry,
  type SupervisorRef,
  type GenServerRef,
  type GenServerBehavior,
  type ApplicationLifecycleEvent,
} from '@hamicek/noex';
import Fastify, { type FastifyInstance } from 'fastify';

// ============================================================================
// Configuration
// ============================================================================

interface ServiceConfig {
  readonly serviceName: string;
  readonly port: number;
  readonly host: string;
  readonly healthPort: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly workerCount: number;
  readonly shutdownTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

class ConfigError extends Error {
  constructor(field: string, reason: string) {
    super(`Configuration error: ${field} - ${reason}`);
    this.name = 'ConfigError';
  }
}

function loadConfig(): ServiceConfig {
  const config: ServiceConfig = {
    serviceName: process.env.SERVICE_NAME || 'microservice',
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    healthPort: parseInt(process.env.HEALTH_PORT || '9090', 10),
    logLevel: (process.env.LOG_LEVEL as ServiceConfig['logLevel']) || 'info',
    workerCount: parseInt(process.env.WORKER_COUNT || '4', 10),
    shutdownTimeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT || '30000', 10),
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT || '30000', 10),
  };

  // Validation
  if (config.port < 1 || config.port > 65535) {
    throw new ConfigError('PORT', `must be 1-65535, got ${config.port}`);
  }
  if (config.healthPort < 1 || config.healthPort > 65535) {
    throw new ConfigError('HEALTH_PORT', `must be 1-65535, got ${config.healthPort}`);
  }
  if (config.port === config.healthPort) {
    throw new ConfigError('HEALTH_PORT', 'must be different from PORT');
  }
  if (config.workerCount < 1 || config.workerCount > 100) {
    throw new ConfigError('WORKER_COUNT', `must be 1-100, got ${config.workerCount}`);
  }
  if (!['debug', 'info', 'warn', 'error'].includes(config.logLevel)) {
    throw new ConfigError('LOG_LEVEL', `must be debug/info/warn/error, got ${config.logLevel}`);
  }

  return config;
}

// ============================================================================
// Logging
// ============================================================================

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLogLevel: ServiceConfig['logLevel'] = 'info';

function log(
  level: ServiceConfig['logLevel'],
  message: string,
  context?: Record<string, unknown>,
): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLogLevel]) {
    return;
  }

  const entry = {
    level,
    timestamp: new Date().toISOString(),
    service: process.env.SERVICE_NAME || 'microservice',
    message,
    ...context,
  };

  console.log(JSON.stringify(entry));
}

// ============================================================================
// Worker Service
// ============================================================================

interface WorkerState {
  id: string;
  requestCount: number;
  activeRequests: number;
  draining: boolean;
}

type WorkerCall =
  | { type: 'process'; payload: unknown }
  | { type: 'getStats' }
  | { type: 'drain' };

type WorkerCast = never;

type WorkerReply =
  | { result: unknown }
  | { requestCount: number; activeRequests: number; draining: boolean }
  | { drained: boolean };

function createWorkerBehavior(id: string): GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerReply> {
  return {
    init: () => {
      log('debug', 'Worker initialized', { workerId: id });
      return { id, requestCount: 0, activeRequests: 0, draining: false };
    },

    handleCall: async (msg, state) => {
      switch (msg.type) {
        case 'process': {
          if (state.draining) {
            throw new Error('Worker is draining');
          }

          const newState = {
            ...state,
            requestCount: state.requestCount + 1,
            activeRequests: state.activeRequests + 1,
          };

          // Simulate work
          await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));

          const result = { processed: true, workerId: state.id };

          return [
            { result },
            { ...newState, activeRequests: newState.activeRequests - 1 },
          ];
        }

        case 'getStats':
          return [
            {
              requestCount: state.requestCount,
              activeRequests: state.activeRequests,
              draining: state.draining,
            },
            state,
          ];

        case 'drain': {
          log('info', 'Worker draining', { workerId: state.id });
          const newState = { ...state, draining: true };

          // Wait for active requests
          while (newState.activeRequests > 0) {
            await new Promise((r) => setTimeout(r, 100));
          }

          log('info', 'Worker drained', { workerId: state.id, totalRequests: state.requestCount });
          return [{ drained: true }, newState];
        }
      }
    },

    terminate: (reason, state) => {
      log('info', 'Worker terminated', {
        workerId: state.id,
        totalRequests: state.requestCount,
        reason: typeof reason === 'string' ? reason : 'error',
      });
    },
  };
}

// ============================================================================
// Request Router Service
// ============================================================================

interface RouterState {
  workers: GenServerRef[];
  currentWorker: number;
  totalRequests: number;
  draining: boolean;
}

type RouterCall =
  | { type: 'route'; payload: unknown }
  | { type: 'getStats' }
  | { type: 'drain' };

type RouterCast = { type: 'registerWorker'; ref: GenServerRef };

type RouterReply =
  | { result: unknown }
  | { totalRequests: number; workerCount: number; draining: boolean }
  | { drained: boolean };

const RouterBehavior: GenServerBehavior<RouterState, RouterCall, RouterCast, RouterReply> = {
  init: () => ({
    workers: [],
    currentWorker: 0,
    totalRequests: 0,
    draining: false,
  }),

  handleCast: (msg, state) => {
    if (msg.type === 'registerWorker') {
      log('debug', 'Worker registered with router', { workerCount: state.workers.length + 1 });
      return { ...state, workers: [...state.workers, msg.ref] };
    }
    return state;
  },

  handleCall: async (msg, state) => {
    switch (msg.type) {
      case 'route': {
        if (state.draining) {
          throw new Error('Service is draining');
        }

        if (state.workers.length === 0) {
          throw new Error('No workers available');
        }

        // Round-robin selection
        const worker = state.workers[state.currentWorker % state.workers.length];
        const nextWorker = (state.currentWorker + 1) % state.workers.length;

        const result = await GenServer.call(worker, { type: 'process', payload: msg.payload });

        return [
          { result },
          { ...state, currentWorker: nextWorker, totalRequests: state.totalRequests + 1 },
        ];
      }

      case 'getStats':
        return [
          {
            totalRequests: state.totalRequests,
            workerCount: state.workers.length,
            draining: state.draining,
          },
          state,
        ];

      case 'drain': {
        log('info', 'Router draining all workers');
        const newState = { ...state, draining: true };

        // Drain all workers
        await Promise.all(
          state.workers.map((w) => GenServer.call(w, { type: 'drain' })),
        );

        log('info', 'All workers drained', { totalRequests: state.totalRequests });
        return [{ drained: true }, newState];
      }
    }
  },
};

// ============================================================================
// Application
// ============================================================================

const MicroserviceApp = Application.create<ServiceConfig>({
  async start(config) {
    log('info', 'Starting microservice', {
      port: config.port,
      workerCount: config.workerCount,
    });

    // Start router
    const router = await GenServer.start(RouterBehavior, { name: 'router' });
    Registry.register('router', router);

    // Start workers and register with router
    const workerRefs: GenServerRef[] = [];
    for (let i = 0; i < config.workerCount; i++) {
      const workerId = `worker-${i + 1}`;
      const worker = await GenServer.start(createWorkerBehavior(workerId), { name: workerId });
      workerRefs.push(worker);
      GenServer.cast(router, { type: 'registerWorker', ref: worker });
    }

    // Create supervisor
    const supervisor = await Supervisor.start({
      strategy: 'one_for_one',
      children: [
        { id: 'router', start: () => Promise.resolve(router) },
        ...workerRefs.map((ref, i) => ({
          id: `worker-${i + 1}`,
          start: () => Promise.resolve(ref),
        })),
      ],
    });

    log('info', 'Microservice started', { processCount: Observer.getSnapshot().processCount });
    return supervisor;
  },

  async prepStop(supervisor) {
    log('info', 'Preparing for shutdown');

    const router = Registry.lookup('router');
    if (router) {
      await GenServer.call(router, { type: 'drain' });
    }

    log('info', 'Shutdown preparation complete');
  },

  async stop() {
    log('info', 'Microservice stopped');
  },
});

// ============================================================================
// HTTP Server
// ============================================================================

async function createApiServer(config: ServiceConfig): Promise<FastifyInstance> {
  const app = Fastify();

  app.post('/api/process', async (request, reply) => {
    const router = Registry.lookup('router');
    if (!router) {
      reply.status(503);
      return { error: 'Service unavailable' };
    }

    try {
      const result = await GenServer.call(
        router,
        { type: 'route', payload: request.body },
        config.requestTimeoutMs,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      if (message.includes('draining')) {
        reply.status(503);
        return { error: 'Service is shutting down' };
      }
      reply.status(500);
      return { error: message };
    }
  });

  app.get('/api/stats', async () => {
    const router = Registry.lookup('router');
    if (!router) {
      return { error: 'Router not available' };
    }
    return GenServer.call(router, { type: 'getStats' });
  });

  await app.listen({ port: config.port, host: config.host });
  log('info', 'API server started', { port: config.port });

  return app;
}

async function createHealthServer(
  config: ServiceConfig,
  appRef: ReturnType<typeof Application.start> extends Promise<infer T> ? T : never,
): Promise<FastifyInstance> {
  const app = Fastify();
  let startupComplete = false;

  // Liveness
  app.get('/health/live', async () => ({
    status: 'alive',
    timestamp: new Date().toISOString(),
  }));

  // Readiness
  app.get('/health/ready', async (request, reply) => {
    const snapshot = Observer.getSnapshot();
    const router = Registry.lookup('router');

    const isReady = startupComplete && snapshot.processCount > 0 && router !== undefined;

    if (!isReady) {
      reply.status(503);
    }

    return {
      status: isReady ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks: {
        startup: startupComplete,
        processes: snapshot.processCount > 0,
        router: router !== undefined,
      },
    };
  });

  // Startup
  app.get('/health/startup', async (request, reply) => {
    if (!startupComplete) {
      reply.status(503);
    }
    return {
      status: startupComplete ? 'started' : 'starting',
      timestamp: new Date().toISOString(),
    };
  });

  // Detailed health
  app.get('/health', async () => {
    const snapshot = Observer.getSnapshot();
    const memory = Observer.getMemoryStats();
    const router = Registry.lookup('router');

    let routerStats = null;
    if (router) {
      routerStats = await GenServer.call(router, { type: 'getStats' });
    }

    const heapPercent = (memory.heapUsed / memory.heapTotal) * 100;
    const memoryStatus = heapPercent < 80 ? 'ok' : heapPercent < 95 ? 'warning' : 'critical';
    const restartStatus = snapshot.totalRestarts < 10 ? 'ok' : snapshot.totalRestarts < 50 ? 'warning' : 'critical';

    const hasCritical = memoryStatus === 'critical' || restartStatus === 'critical';
    const hasWarning = memoryStatus === 'warning' || restartStatus === 'warning';

    return {
      status: hasCritical ? 'unhealthy' : hasWarning ? 'degraded' : 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      service: config.serviceName,
      checks: {
        memory: {
          status: memoryStatus,
          heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(memory.heapTotal / 1024 / 1024),
          heapPercent: Math.round(heapPercent),
        },
        restarts: {
          status: restartStatus,
          total: snapshot.totalRestarts,
        },
        processes: {
          status: 'ok',
          count: snapshot.processCount,
        },
        router: routerStats,
      },
    };
  });

  // Mark startup complete when app starts
  Application.onLifecycleEvent((event) => {
    if (event.type === 'started' && event.ref.name === config.serviceName) {
      startupComplete = true;
      log('info', 'Startup complete');
    }
  });

  await app.listen({ port: config.healthPort, host: '0.0.0.0' });
  log('info', 'Health server started', { port: config.healthPort });

  return app;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Load and validate config
  let config: ServiceConfig;
  try {
    config = loadConfig();
  } catch (error) {
    console.error('Configuration error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Set log level
  currentLogLevel = config.logLevel;

  // Setup lifecycle logging
  Application.onLifecycleEvent((event: ApplicationLifecycleEvent) => {
    switch (event.type) {
      case 'starting':
        log('info', 'Application starting', { name: event.name });
        break;
      case 'started':
        log('info', 'Application started', { name: event.ref.name });
        break;
      case 'stopping':
        log('info', 'Application stopping', {
          name: event.ref.name,
          reason: event.reason === 'signal' ? 'signal' :
                  event.reason === 'normal' ? 'normal' :
                  `error:${event.reason.error.message}`,
        });
        break;
      case 'stopped':
        log('info', 'Application stopped', { name: event.name });
        break;
      case 'start_failed':
        log('error', 'Application failed to start', {
          name: event.name,
          error: event.error.message,
        });
        break;
    }
  });

  // Setup process restart logging
  Observer.subscribe((event) => {
    if (event.type === 'supervisor_child_restarted') {
      log('warn', 'Process restarted', {
        supervisorId: event.supervisorId,
        childId: event.childId,
        restartCount: event.restartCount,
      });
    }
  });

  try {
    // Start application
    const appRef = await Application.start(MicroserviceApp, {
      name: config.serviceName,
      config,
      handleSignals: true,
      stopTimeout: config.shutdownTimeoutMs,
    });

    // Start servers
    const apiServer = await createApiServer(config);
    const healthServer = await createHealthServer(config, appRef);

    log('info', 'Microservice ready', {
      pid: process.pid,
      apiPort: config.port,
      healthPort: config.healthPort,
      workers: config.workerCount,
    });

    // Handle shutdown for HTTP servers
    const originalStop = Application.stop.bind(Application);
    process.on('SIGINT', async () => {
      await apiServer.close();
      await healthServer.close();
    });
    process.on('SIGTERM', async () => {
      await apiServer.close();
      await healthServer.close();
    });

  } catch (error) {
    log('error', 'Failed to start microservice', {
      error: error instanceof Error ? error.message : 'unknown',
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

main();
```

**Sample output:**

```
{"level":"info","timestamp":"2024-01-25T12:00:00.000Z","service":"microservice","message":"Application starting","name":"microservice"}
{"level":"info","timestamp":"2024-01-25T12:00:00.050Z","service":"microservice","message":"Starting microservice","port":3000,"workerCount":4}
{"level":"debug","timestamp":"2024-01-25T12:00:00.051Z","service":"microservice","message":"Worker initialized","workerId":"worker-1"}
{"level":"debug","timestamp":"2024-01-25T12:00:00.052Z","service":"microservice","message":"Worker initialized","workerId":"worker-2"}
{"level":"debug","timestamp":"2024-01-25T12:00:00.053Z","service":"microservice","message":"Worker initialized","workerId":"worker-3"}
{"level":"debug","timestamp":"2024-01-25T12:00:00.054Z","service":"microservice","message":"Worker initialized","workerId":"worker-4"}
{"level":"info","timestamp":"2024-01-25T12:00:00.100Z","service":"microservice","message":"Microservice started","processCount":5}
{"level":"info","timestamp":"2024-01-25T12:00:00.150Z","service":"microservice","message":"API server started","port":3000}
{"level":"info","timestamp":"2024-01-25T12:00:00.200Z","service":"microservice","message":"Health server started","port":9090}
{"level":"info","timestamp":"2024-01-25T12:00:00.201Z","service":"microservice","message":"Application started","name":"microservice"}
{"level":"info","timestamp":"2024-01-25T12:00:00.202Z","service":"microservice","message":"Startup complete"}
{"level":"info","timestamp":"2024-01-25T12:00:00.250Z","service":"microservice","message":"Microservice ready","pid":12345,"apiPort":3000,"healthPort":9090,"workers":4}
```

**Health check response (`GET /health`):**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-25T12:00:30.000Z",
  "uptime": 30.5,
  "service": "microservice",
  "checks": {
    "memory": {
      "status": "ok",
      "heapUsedMB": 45,
      "heapTotalMB": 128,
      "heapPercent": 35
    },
    "restarts": {
      "status": "ok",
      "total": 0
    },
    "processes": {
      "status": "ok",
      "count": 5
    },
    "router": {
      "totalRequests": 1547,
      "workerCount": 4,
      "draining": false
    }
  }
}
```

</details>

## Summary

**Key takeaways:**

- **Type-safe configuration** prevents runtime errors from misconfiguration
- **Environment variables** enable deployment flexibility without code changes
- **Configuration validation** fails fast on startup, not in production
- **Structured JSON logging** enables log aggregation and analysis
- **Lifecycle events** provide insight into application state transitions
- **Health checks** enable load balancers and orchestrators to manage traffic

**Production checklist:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       PRODUCTION READINESS CHECKLIST                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CONFIGURATION                                                              │
│  ☐ All config values have sensible defaults                                 │
│  ☐ Validation fails fast on startup                                         │
│  ☐ Sensitive values come from environment (not hardcoded)                   │
│  ☐ Different environments have appropriate overrides                        │
│                                                                             │
│  LOGGING                                                                    │
│  ☐ JSON format for log aggregation                                          │
│  ☐ Appropriate log levels (warn/error in prod)                              │
│  ☐ No sensitive data in logs                                                │
│  ☐ Lifecycle events logged                                                  │
│  ☐ Logs flushed on shutdown                                                 │
│                                                                             │
│  HEALTH CHECKS                                                              │
│  ☐ /health/live endpoint (liveness)                                         │
│  ☐ /health/ready endpoint (readiness)                                       │
│  ☐ /health/startup endpoint (if slow startup)                               │
│  ☐ Detailed /health for debugging                                           │
│  ☐ Health port separate from API port                                       │
│                                                                             │
│  GRACEFUL SHUTDOWN                                                          │
│  ☐ Signal handlers configured                                               │
│  ☐ Request draining implemented                                             │
│  ☐ Timeout < Kubernetes terminationGracePeriodSeconds                       │
│  ☐ Final metrics/logs flushed                                               │
│                                                                             │
│  MONITORING                                                                 │
│  ☐ Observer events subscribed                                               │
│  ☐ Restart alerts configured                                                │
│  ☐ Memory usage tracked                                                     │
│  ☐ Process count monitored                                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Remember:**

> Production is not an environment — it's a mindset. Every application should be written as if it will handle real traffic, real failures, and real operators trying to understand what went wrong at 3 AM. Configuration, logging, and health checks are not afterthoughts — they're fundamental requirements.

---

Next: [Observer](../10-monitoring/01-observer.md)
