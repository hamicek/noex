# Supervision Tree

Multi-tier application with nested supervisors for fault isolation.

## Overview

This example shows:
- Nested supervisor hierarchy
- Service isolation with different restart strategies
- Recovery from failures
- Application-level supervision

## Architecture

```
                       ┌─────────────────┐
                       │   Application   │
                       │   Supervisor    │
                       │  (one_for_all)  │
                       └────────┬────────┘
                                │
            ┌───────────────────┼───────────────────┐
            │                   │                   │
   ┌────────▼────────┐ ┌───────▼────────┐ ┌───────▼────────┐
   │     Core        │ │    Services    │ │     Web        │
   │   Supervisor    │ │   Supervisor   │ │   Supervisor   │
   │ (one_for_one)   │ │ (rest_for_one) │ │ (one_for_one)  │
   └────────┬────────┘ └───────┬────────┘ └───────┬────────┘
            │                  │                   │
     ┌──────┴──────┐    ┌──────┴──────┐     ┌─────┴─────┐
     │             │    │             │     │           │
 ┌───▼───┐   ┌─────▼┐ ┌─▼───┐   ┌─────▼┐ ┌──▼──┐   ┌────▼───┐
 │Config │   │Logger│ │Cache│   │Queue │ │HTTP │   │WebSocket│
 └───────┘   └──────┘ └─────┘   └──────┘ └─────┘   └────────┘
```

## Complete Code

```typescript
import {
  GenServer,
  Supervisor,
  EventBus,
  Cache,
  type GenServerBehavior,
  type GenServerRef,
  type ChildSpec,
  type SupervisorRef,
} from 'noex';

// ============================================================
// Core Services
// ============================================================

// Config Service - holds application configuration
interface ConfigState {
  values: Map<string, unknown>;
}

const configBehavior: GenServerBehavior<
  ConfigState,
  { type: 'get'; key: string } | { type: 'get_all' },
  { type: 'set'; key: string; value: unknown },
  unknown
> = {
  init: () => ({
    values: new Map([
      ['app.name', 'MyApp'],
      ['app.version', '1.0.0'],
      ['db.host', 'localhost'],
      ['db.port', 5432],
    ]),
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.values.get(msg.key), state];
      case 'get_all':
        return [Object.fromEntries(state.values), state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'set':
        state.values.set(msg.key, msg.value);
        return state;
    }
  },
};

// Logger Service - centralized logging
interface LoggerState {
  logs: Array<{ level: string; message: string; timestamp: Date }>;
}

const loggerBehavior: GenServerBehavior<
  LoggerState,
  { type: 'get_logs'; limit?: number },
  { type: 'log'; level: string; message: string },
  unknown
> = {
  init: () => ({ logs: [] }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get_logs':
        const limit = msg.limit ?? 100;
        return [state.logs.slice(-limit), state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'log':
        const entry = {
          level: msg.level,
          message: msg.message,
          timestamp: new Date(),
        };
        console.log(`[${entry.level.toUpperCase()}] ${entry.message}`);
        return { logs: [...state.logs.slice(-999), entry] };
    }
  },
};

// ============================================================
// Application Services
// ============================================================

// Queue Service - job queue with dependencies on Cache
interface QueueState {
  jobs: Array<{ id: string; data: unknown; status: string }>;
  nextId: number;
}

const queueBehavior: GenServerBehavior<
  QueueState,
  { type: 'get_pending' } | { type: 'get_job'; id: string },
  { type: 'enqueue'; data: unknown } | { type: 'complete'; id: string },
  unknown
> = {
  init: () => ({ jobs: [], nextId: 1 }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get_pending':
        return [state.jobs.filter(j => j.status === 'pending'), state];
      case 'get_job':
        return [state.jobs.find(j => j.id === msg.id), state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'enqueue':
        const job = {
          id: `job-${state.nextId}`,
          data: msg.data,
          status: 'pending',
        };
        return {
          jobs: [...state.jobs, job],
          nextId: state.nextId + 1,
        };
      case 'complete':
        return {
          ...state,
          jobs: state.jobs.map(j =>
            j.id === msg.id ? { ...j, status: 'completed' } : j
          ),
        };
    }
  },
};

// ============================================================
// Web Services
// ============================================================

// HTTP Server (simulated)
interface HttpState {
  requests: number;
  port: number;
}

const httpBehavior: GenServerBehavior<
  HttpState,
  { type: 'stats' },
  { type: 'request' },
  unknown
> = {
  init: () => {
    console.log('HTTP Server started on port 7201');
    return { requests: 0, port: 7201 };
  },

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'stats':
        return [{ requests: state.requests, port: state.port }, state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'request':
        return { ...state, requests: state.requests + 1 };
    }
  },

  terminate: () => {
    console.log('HTTP Server stopped');
  },
};

// WebSocket Server (simulated)
interface WsState {
  connections: number;
}

const wsBehavior: GenServerBehavior<
  WsState,
  { type: 'stats' },
  { type: 'connect' } | { type: 'disconnect' },
  unknown
> = {
  init: () => {
    console.log('WebSocket Server started on port 7202');
    return { connections: 0 };
  },

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'stats':
        return [{ connections: state.connections }, state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'connect':
        return { connections: state.connections + 1 };
      case 'disconnect':
        return { connections: Math.max(0, state.connections - 1) };
    }
  },

  terminate: () => {
    console.log('WebSocket Server stopped');
  },
};

// ============================================================
// Supervisor Setup
// ============================================================

async function startApplication(): Promise<SupervisorRef> {
  // Core Supervisor - config and logger (rarely crash)
  const coreChildren: ChildSpec[] = [
    {
      id: 'config',
      start: () => GenServer.start(configBehavior),
      restart: 'permanent',
    },
    {
      id: 'logger',
      start: () => GenServer.start(loggerBehavior),
      restart: 'permanent',
    },
  ];

  // Services Supervisor - cache and queue (may crash together)
  const servicesChildren: ChildSpec[] = [
    {
      id: 'cache',
      start: () => Cache.start({ maxSize: 1000, defaultTtl: 60_000 }),
      restart: 'permanent',
    },
    {
      id: 'queue',
      start: () => GenServer.start(queueBehavior),
      restart: 'permanent',
    },
  ];

  // Web Supervisor - HTTP and WebSocket
  const webChildren: ChildSpec[] = [
    {
      id: 'http',
      start: () => GenServer.start(httpBehavior),
      restart: 'permanent',
    },
    {
      id: 'websocket',
      start: () => GenServer.start(wsBehavior),
      restart: 'permanent',
    },
  ];

  // Start nested supervisors
  const coreSup = await Supervisor.start({
    strategy: 'one_for_one', // Independent services
    children: coreChildren,
  });

  const servicesSup = await Supervisor.start({
    strategy: 'rest_for_one', // Queue depends on Cache
    children: servicesChildren,
  });

  const webSup = await Supervisor.start({
    strategy: 'one_for_one', // Independent servers
    children: webChildren,
  });

  // Application Supervisor - top level
  const appSupervisor = await Supervisor.start({
    strategy: 'one_for_all', // If one subsystem fails, restart all
    restartIntensity: { maxRestarts: 3, withinMs: 60_000 },
    children: [
      {
        id: 'core',
        start: async () => coreSup,
        restart: 'permanent',
      },
      {
        id: 'services',
        start: async () => servicesSup,
        restart: 'permanent',
      },
      {
        id: 'web',
        start: async () => webSup,
        restart: 'permanent',
      },
    ],
  });

  return appSupervisor;
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('Starting application...\n');

  const app = await startApplication();

  console.log('\nApplication started successfully!');
  console.log('Supervision tree:');
  console.log('  Application (one_for_all)');
  console.log('    ├── Core (one_for_one)');
  console.log('    │   ├── config');
  console.log('    │   └── logger');
  console.log('    ├── Services (rest_for_one)');
  console.log('    │   ├── cache');
  console.log('    │   └── queue');
  console.log('    └── Web (one_for_one)');
  console.log('        ├── http');
  console.log('        └── websocket');

  // Simulate some activity
  console.log('\nSimulating activity...');

  // Let it run for a bit
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Graceful shutdown
  console.log('\nShutting down...');
  await Supervisor.stop(app);
  console.log('Application stopped');
}

main().catch(console.error);
```

## Output

```
Starting application...

HTTP Server started on port 7201
WebSocket Server started on port 7202

Application started successfully!
Supervision tree:
  Application (one_for_all)
    ├── Core (one_for_one)
    │   ├── config
    │   └── logger
    ├── Services (rest_for_one)
    │   ├── cache
    │   └── queue
    └── Web (one_for_one)
        ├── http
        └── websocket

Simulating activity...

Shutting down...
HTTP Server stopped
WebSocket Server stopped
Application stopped
```

## Strategy Selection

### one_for_one
Restart only the crashed child. Use for independent services.

```typescript
// Config and Logger are independent
strategy: 'one_for_one'
```

### rest_for_one
Restart the crashed child and all children started after it. Use for services with dependencies.

```typescript
// Queue depends on Cache - if Cache crashes, restart Queue too
strategy: 'rest_for_one'
children: [
  { id: 'cache', ... },  // Started first
  { id: 'queue', ... },  // Depends on cache
]
```

### one_for_all
Restart all children if any crashes. Use for tightly coupled subsystems.

```typescript
// All subsystems should restart together
strategy: 'one_for_all'
```

## Best Practices

1. **Isolate failure domains**: Group related services under the same supervisor
2. **Use appropriate strategies**: Match restart strategy to service dependencies
3. **Set restart limits**: Prevent infinite restart loops
4. **Graceful degradation**: Handle temporary service unavailability

## Related

- [Supervisor Concept](../concepts/supervisor.md) - Supervision patterns
- [Supervision Trees Guide](../guides/supervision-trees.md) - Design guidelines
- [E-commerce Tutorial](../tutorials/ecommerce-backend.md) - Full tutorial
