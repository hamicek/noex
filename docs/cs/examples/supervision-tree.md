# Supervision Tree

Vícevrstvá aplikace s vnořenými supervisory pro izolaci chyb.

## Přehled

Tento příklad ukazuje:
- Hierarchii vnořených supervisorů
- Izolaci služeb s různými restart strategiemi
- Obnovu po selhání
- Supervizi na úrovni aplikace

## Architektura

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

## Kompletní kód

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
// Core služby
// ============================================================

// Config služba - uchovává konfiguraci aplikace
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

// Logger služba - centralizované logování
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
// Aplikační služby
// ============================================================

// Queue služba - fronta úloh se závislostí na Cache
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
// Web služby
// ============================================================

// HTTP Server (simulovaný)
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
    console.log('HTTP Server spuštěn na portu 7201');
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
    console.log('HTTP Server zastaven');
  },
};

// WebSocket Server (simulovaný)
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
    console.log('WebSocket Server spuštěn na portu 7202');
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
    console.log('WebSocket Server zastaven');
  },
};

// ============================================================
// Nastavení supervisorů
// ============================================================

async function startApplication(): Promise<SupervisorRef> {
  // Core Supervisor - config a logger (zřídka padají)
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

  // Services Supervisor - cache a queue (mohou padat společně)
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

  // Web Supervisor - HTTP a WebSocket
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

  // Spuštění vnořených supervisorů
  const coreSup = await Supervisor.start({
    strategy: 'one_for_one', // Nezávislé služby
    children: coreChildren,
  });

  const servicesSup = await Supervisor.start({
    strategy: 'rest_for_one', // Queue závisí na Cache
    children: servicesChildren,
  });

  const webSup = await Supervisor.start({
    strategy: 'one_for_one', // Nezávislé servery
    children: webChildren,
  });

  // Application Supervisor - nejvyšší úroveň
  const appSupervisor = await Supervisor.start({
    strategy: 'one_for_all', // Při selhání jednoho subsystému restartuj všechny
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
  console.log('Spouštím aplikaci...\n');

  const app = await startApplication();

  console.log('\nAplikace úspěšně spuštěna!');
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

  // Simulace aktivity
  console.log('\nSimuluji aktivitu...');

  // Nech to chvíli běžet
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Elegantní ukončení
  console.log('\nUkončuji...');
  await Supervisor.stop(app);
  console.log('Aplikace zastavena');
}

main().catch(console.error);
```

## Výstup

```
Spouštím aplikaci...

HTTP Server spuštěn na portu 7201
WebSocket Server spuštěn na portu 7202

Aplikace úspěšně spuštěna!
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

Simuluji aktivitu...

Ukončuji...
HTTP Server zastaven
WebSocket Server zastaven
Aplikace zastavena
```

## Volba strategie

### one_for_one
Restartuje pouze spadlé dítě. Použijte pro nezávislé služby.

```typescript
// Config a Logger jsou nezávislé
strategy: 'one_for_one'
```

### rest_for_one
Restartuje spadlé dítě a všechny děti spuštěné po něm. Použijte pro služby se závislostmi.

```typescript
// Queue závisí na Cache - pokud Cache spadne, restartuj i Queue
strategy: 'rest_for_one'
children: [
  { id: 'cache', ... },  // Spuštěno první
  { id: 'queue', ... },  // Závisí na cache
]
```

### one_for_all
Restartuje všechny děti, pokud jakékoli spadne. Použijte pro těsně svázané subsystémy.

```typescript
// Všechny subsystémy by měly restartovat společně
strategy: 'one_for_all'
```

## Best practices

1. **Izolujte domény selhání**: Seskupte související služby pod stejný supervisor
2. **Používejte vhodné strategie**: Slaďte restart strategii se závislostmi služeb
3. **Nastavte limity restartů**: Zabraňte nekonečným smyčkám restartů
4. **Elegantní degradace**: Ošetřete dočasnou nedostupnost služeb

## Související

- [Koncept Supervisor](../concepts/supervisor.md) - Vzory supervize
- [Průvodce Supervision Trees](../guides/supervision-trees.md) - Pokyny k návrhu
- [E-commerce tutoriál](../tutorials/ecommerce-backend.md) - Kompletní tutoriál
