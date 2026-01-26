# Zpracování signálů

V předchozí kapitole jste se naučili strukturovat aplikace pomocí Application behavior. Nyní se ponoříme hlouběji do **zpracování signálů** — mechanismu, který umožňuje graceful shutdown v produkčních prostředích.

## Co se naučíte

- Pochopit Unix signály (SIGINT, SIGTERM) a kdy se odesílají
- Nakonfigurovat automatické zpracování signálů v noex aplikacích
- Implementovat správné cleanup sekvence během shutdownu
- Zpracovat edge cases jako timeout a nucené ukončení
- Budovat odolné aplikace pro container orchestraci

## Porozumění Unix signálům

Unix signály jsou asynchronní notifikace odesílané procesům. Dva signály jsou kritické pro graceful shutdown:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SIGNÁLY PRO SHUTDOWN                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  SIGINT (2)                           SIGTERM (15)                          │
│  ┌─────────────────────┐              ┌─────────────────────┐               │
│  │ "Interrupt Signal"  │              │ "Terminate Signal"  │               │
│  │                     │              │                     │               │
│  │ Spouští:            │              │ Spouští:            │               │
│  │ • Ctrl+C v terminálu│              │ • kill <pid>        │               │
│  │ • IDE stop tlačítko │              │ • Docker stop       │               │
│  │                     │              │ • Kubernetes pod    │               │
│  │ Záměr:              │              │   termination       │               │
│  │ Uživatel chce       │              │ • systemctl stop    │               │
│  │ zastavit proces     │              │                     │               │
│  └─────────────────────┘              │ Záměr:              │               │
│                                       │ Systém požaduje     │               │
│  SIGKILL (9)                          │ graceful shutdown   │               │
│  ┌─────────────────────┐              └─────────────────────┘               │
│  │ "Kill Signal"       │                                                    │
│  │                     │              SIGINT i SIGTERM umožňují              │
│  │ Spouští:            │              procesu provést cleanup.               │
│  │ • kill -9 <pid>     │                                                    │
│  │ • OOM killer        │              SIGKILL nelze zachytit a               │
│  │                     │              ukončí okamžitě.                       │
│  │ Záměr:              │                                                    │
│  │ Vynutit okamžité    │                                                    │
│  │ ukončení            │                                                    │
│  │ (nelze zachytit!)   │                                                    │
│  └─────────────────────┘                                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Klíčový poznatek:** SIGINT a SIGTERM dávají vaší aplikaci šanci na graceful shutdown. SIGKILL ne — je to "nukleární možnost", která ukončí okamžitě.

## Automatické zpracování signálů

Ve výchozím nastavení noex aplikace automaticky zpracovávají SIGINT a SIGTERM:

```typescript
import { Application, Supervisor } from '@hamicek/noex';

const MyApp = Application.create({
  async start() {
    return Supervisor.start({
      strategy: 'one_for_one',
      children: [
        { id: 'worker', start: () => Worker.start() },
      ],
    });
  },
});

// handleSignals je výchozí true
const app = await Application.start(MyApp, {
  name: 'my-app',
  config: undefined,
});

// Nyní stisknutí Ctrl+C nebo odeslání SIGTERM:
// 1. Spustí Application.stop(app, 'signal')
// 2. Provede úplnou shutdown sekvenci
// 3. Čistě ukončí
```

### Co se stane když přijde signál

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SEKVENCE ZPRACOVÁNÍ SIGNÁLU                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Přijat SIGINT/SIGTERM                                                      │
│         │                                                                   │
│         ▼                                                                   │
│  ┌──────────────────┐                                                       │
│  │ Signal Handler   │  Registrován Application.start()                      │
│  │ (v noex)         │  když handleSignals: true                             │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           │  Volá Application.stop(ref, 'signal')                           │
│           ▼                                                                 │
│  ┌──────────────────────────────────────────────────────────────────┐       │
│  │                     STOP SEKVENCE                                │       │
│  │                                                                  │       │
│  │  1. Status → 'stopping'                                          │       │
│  │  2. Emit 'stopping' lifecycle event                              │       │
│  │  3. Volání prepStop() callbacku                                  │       │
│  │     • Zastavit přijímání nových spojení                          │       │
│  │     • Vyprázdnit fronty požadavků                                │       │
│  │     • Notifikovat load balancery                                 │       │
│  │  4. Zastavení supervisor stromu (všechny děti)                   │       │
│  │     • Volá se GenServer.terminate() každého                      │       │
│  │     • Vnořené supervisory zastaví své děti                       │       │
│  │  5. Volání stop() callbacku                                      │       │
│  │     • Flush logů a metrik                                        │       │
│  │     • Uzavření externích spojení                                 │       │
│  │  6. Odstranění signal handlerů                                   │       │
│  │  7. Emit 'stopped' lifecycle event                               │       │
│  │  8. Status → 'stopped'                                           │       │
│  │                                                                  │       │
│  └──────────────────────────────────────────────────────────────────┘       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Důvody zastavení

Lifecycle eventy obsahují `reason`, který indikuje proč byla aplikace zastavena:

```typescript
import {
  Application,
  type ApplicationLifecycleEvent,
  type ApplicationStopReason,
} from '@hamicek/noex';

Application.onLifecycleEvent((event) => {
  if (event.type === 'stopping' || event.type === 'stopped') {
    console.log(`Důvod zastavení: ${formatReason(event.reason)}`);
  }
});

function formatReason(reason: ApplicationStopReason): string {
  switch (reason) {
    case 'normal':
      // Manuální volání Application.stop(ref)
      return 'vyžádán graceful shutdown';
    case 'signal':
      // Přijat SIGINT nebo SIGTERM
      return 'přijat signál (SIGINT/SIGTERM)';
    default:
      // { error: Error } - shutdown kvůli chybě
      return `chyba: ${reason.error.message}`;
  }
}
```

## Cleanup sekvence

Callbacky `prepStop` a `stop` vám dávají kontrolu nad shutdown procesem:

```typescript
const ApiServer = Application.create<ApiConfig>({
  async start(config) {
    // Start vaší aplikace
    return Supervisor.start({ /* ... */ });
  },

  // Volá se PŘED zastavením supervisor stromu
  async prepStop(supervisor) {
    console.log('[prepStop] Spouštím graceful shutdown...');

    // 1. Zastavit přijímání nových požadavků
    const httpServer = Supervisor.getChild(supervisor, 'http');
    if (httpServer) {
      await GenServer.call(httpServer, { type: 'stopAccepting' });
      console.log('[prepStop] Zastaveno přijímání nových spojení');
    }

    // 2. Počkat na dokončení rozpracovaných požadavků
    await waitForInflightRequests(5000);
    console.log('[prepStop] Všechny rozpracované požadavky dokončeny');

    // 3. Notifikovat load balancer (volitelné)
    await notifyLoadBalancer('draining');
    console.log('[prepStop] Load balancer notifikován');
  },

  // Volá se PO zastavení supervisor stromu
  async stop(supervisor) {
    console.log('[stop] Provádím finální cleanup...');

    // 1. Flush bufferovaných dat
    await flushMetrics();
    await flushLogs();

    // 2. Uzavření externích spojení
    await closeExternalConnections();

    console.log('[stop] Cleanup dokončen');
  },
});
```

### prepStop vs stop: Kdy použít který

| Callback | Kdy se volá | Použití |
|----------|-------------|---------|
| `prepStop` | Před zastavením supervisoru | Vyprázdnění front, zastavení přijímání požadavků, notifikace externích služeb |
| `stop` | Po zastavení supervisoru | Finální cleanup, flush logů, uzavření persistentních spojení |

```
Časová osa:
                    ┌── prepStop ──┐ ┌─ Supervisor se zastavuje ─┐ ┌─── stop ───┐
Signál ────────────►│ Vyprázdnění  │►│ GenServery se zastavují   │►│ Finální    │► Konec
přijat              │ Stop vstupy  │ │ terminate() se volá       │ │ flush      │
                    └──────────────┘ └───────────────────────────┘ └────────────┘
```

## Stop timeout

Celá stop sekvence musí být dokončena během `stopTimeout` (výchozí: 30 sekund):

```typescript
const app = await Application.start(MyApp, {
  name: 'my-app',
  config,
  stopTimeout: 60000,  // 60 sekund pro komplexní cleanup
});

// Pokud stop trvá déle než stopTimeout:
try {
  await Application.stop(app);
} catch (error) {
  if (error instanceof ApplicationStopTimeoutError) {
    console.error(`Stop timeout po ${error.timeoutMs}ms`);
    // V tomto bodě může být nutné násilně zabít proces
    process.exit(1);
  }
}
```

**Poznámka k container orchestraci:** Kubernetes posílá SIGTERM, čeká `terminationGracePeriodSeconds` (výchozí: 30s), pak posílá SIGKILL. Nastavte váš `stopTimeout` nižší než toto pro zajištění čistého ukončení:

```typescript
// Kubernetes terminationGracePeriodSeconds: 60
const app = await Application.start(MyApp, {
  name: 'my-app',
  config,
  stopTimeout: 55000,  // 55 sekund — nechává 5s rezervu před SIGKILL
});
```

## Vypnutí automatického zpracování signálů

V některých případech můžete chtít zpracovávat signály sami:

```typescript
// Vypnout automatické zpracování signálů
const app = await Application.start(MyApp, {
  name: 'my-app',
  config,
  handleSignals: false,  // Budeme zpracovávat signály manuálně
});

// Vlastní zpracování signálů
let shuttingDown = false;

async function handleShutdown(signal: string) {
  if (shuttingDown) {
    console.log('Již se zastavuji, ignoruji signál');
    return;
  }
  shuttingDown = true;

  console.log(`Přijat ${signal}, zahajuji shutdown...`);

  try {
    // Vlastní pre-shutdown logika
    await notifyCluster('node-leaving');

    // Nyní zastavit aplikaci
    await Application.stop(app, 'signal');

    console.log('Shutdown dokončen');
    process.exit(0);
  } catch (error) {
    console.error('Shutdown selhal:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
```

### Kdy vypnout automatické zpracování

| Scénář | Proč vypnout |
|--------|--------------|
| Koordinace clusteru | Potřeba notifikovat ostatní uzly před zastavením |
| Vlastní logování | Chtít logovat přesný přijatý signál |
| Vícero aplikací v procesu | Potřeba koordinovat pořadí shutdownu |
| Testování | Potřeba přesně kontrolovat timing shutdownu |

## Vzory graceful shutdown

### Vzor HTTP Server

Zastavit přijímání nových spojení, pak vyprázdnit existující:

```typescript
interface HttpServerState {
  server: http.Server;
  activeConnections: Set<http.ServerResponse>;
}

const HttpServer: GenServerBehavior<HttpServerState, HttpCall, HttpCast, HttpReply> = {
  init: () => {
    const server = http.createServer((req, res) => {
      state.activeConnections.add(res);
      res.on('close', () => state.activeConnections.delete(res));
      // Zpracovat požadavek...
    });
    return { server, activeConnections: new Set() };
  },

  handleCall: (msg, state) => {
    if (msg.type === 'stopAccepting') {
      // Zastavit přijímání nových spojení
      state.server.close();
      return [{ stopped: true }, state];
    }

    if (msg.type === 'getActiveCount') {
      return [{ count: state.activeConnections.size }, state];
    }

    return [null, state];
  },

  terminate: async (reason, state) => {
    // Násilně uzavřít všechna zbývající spojení
    for (const res of state.activeConnections) {
      res.end();
    }
    state.server.close();
  },
};
```

### Vzor Background Worker

Dokončit aktuální úlohu, odmítnout nové:

```typescript
interface WorkerState {
  currentJob: Job | null;
  accepting: boolean;
}

const BackgroundWorker: GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerReply> = {
  init: () => ({ currentJob: null, accepting: true }),

  handleCast: async (msg, state) => {
    if (msg.type === 'process' && state.accepting) {
      // Zpracovat úlohu
      const result = await processJob(msg.job);
      return { ...state, currentJob: null };
    }
    return state;
  },

  handleCall: (msg, state) => {
    if (msg.type === 'drain') {
      // Zastavit přijímání nových úloh
      return [{ draining: true }, { ...state, accepting: false }];
    }

    if (msg.type === 'getStatus') {
      return [{
        processing: state.currentJob !== null,
        accepting: state.accepting,
      }, state];
    }

    return [null, state];
  },

  terminate: async (reason, state) => {
    if (state.currentJob) {
      // Nechat aktuální úlohu dokončit (nebo implementovat timeout)
      console.log('Čekám na dokončení aktuální úlohy...');
    }
  },
};
```

### Vzor WebSocket

Notifikovat připojené klienty před odpojením:

```typescript
interface WebSocketServerState {
  clients: Map<string, WebSocket>;
}

const WebSocketServer: GenServerBehavior<WebSocketServerState, WsCall, WsCast, WsReply> = {
  init: () => ({ clients: new Map() }),

  handleCall: (msg, state) => {
    if (msg.type === 'prepareShutdown') {
      // Notifikovat všechny klienty
      for (const [id, ws] of state.clients) {
        ws.send(JSON.stringify({
          type: 'server_shutdown',
          message: 'Server se vypíná, prosím připojte se znovu',
          reconnectAfterMs: 5000,
        }));
      }
      return [{ notified: state.clients.size }, state];
    }

    return [null, state];
  },

  terminate: async (reason, state) => {
    // Uzavřít všechna spojení se správným close kódem
    for (const [id, ws] of state.clients) {
      ws.close(1001, 'Server se vypíná');  // 1001 = Going Away
    }
  },
};
```

## Kompletní příklad: Produkční API Server

Zde je produkční API server s komprehensivním zpracováním signálů:

```typescript
import {
  Application,
  Supervisor,
  GenServer,
  type SupervisorRef,
  type ApplicationLifecycleEvent,
} from '@hamicek/noex';
import * as http from 'http';

interface ServerConfig {
  port: number;
  shutdownTimeoutMs: number;
}

interface ServerState {
  supervisor: SupervisorRef;
  requestCount: number;
  activeRequests: number;
}

// Sledování metrik
let metrics = {
  totalRequests: 0,
  shutdownRequestsCompleted: 0,
};

const ProductionServer = Application.create<ServerConfig>({
  async start(config) {
    console.log(`[Server] Spouštím na portu ${config.port}...`);

    const supervisor = await Supervisor.start({
      strategy: 'rest_for_one',
      children: [
        {
          id: 'metrics',
          start: () => MetricsCollector.start(),
        },
        {
          id: 'http',
          start: () => HttpHandler.start(config.port),
        },
      ],
    });

    console.log(`[Server] Připraven přijímat spojení`);
    return supervisor;
  },

  async prepStop(supervisor) {
    console.log('[Server] Připravuji se na shutdown...');
    const startTime = Date.now();

    // 1. Získat HTTP handler a zastavit přijímání
    const httpHandler = Supervisor.getChild(supervisor, 'http');
    if (httpHandler) {
      const result = await GenServer.call(httpHandler, { type: 'stopAccepting' });
      console.log(`[Server] Zastaveno přijímání nových spojení`);

      // 2. Čekat na rozpracované požadavky (s timeoutem)
      const maxWait = 10000;  // 10 sekund max
      let waited = 0;
      while (waited < maxWait) {
        const status = await GenServer.call(httpHandler, { type: 'getStatus' });
        if ((status as { activeRequests: number }).activeRequests === 0) {
          break;
        }
        console.log(`[Server] Čekám na ${(status as { activeRequests: number }).activeRequests} aktivních požadavků...`);
        await new Promise(r => setTimeout(r, 1000));
        waited += 1000;
      }

      metrics.shutdownRequestsCompleted =
        (await GenServer.call(httpHandler, { type: 'getStatus' }) as { completed: number }).completed;
    }

    console.log(`[Server] prepStop dokončen za ${Date.now() - startTime}ms`);
  },

  async stop(supervisor) {
    console.log('[Server] Finální cleanup...');

    // Flush metrik před ukončením
    const metricsCollector = Supervisor.getChild(supervisor, 'metrics');
    if (metricsCollector) {
      await GenServer.call(metricsCollector, { type: 'flush' });
    }

    console.log('[Server] Statistiky shutdownu:');
    console.log(`  Celkem zpracovaných požadavků: ${metrics.totalRequests}`);
    console.log(`  Požadavků dokončených během shutdownu: ${metrics.shutdownRequestsCompleted}`);
    console.log('[Server] Sbohem!');
  },
});

// Vstupní bod aplikace
async function main() {
  // Registrace lifecycle observeru pro logování
  const unsubscribe = Application.onLifecycleEvent((event: ApplicationLifecycleEvent) => {
    const time = new Date(event.timestamp).toISOString();

    switch (event.type) {
      case 'starting':
        console.log(`[${time}] 🚀 Spouštím aplikaci '${event.name}'`);
        break;
      case 'started':
        console.log(`[${time}] ✅ Aplikace '${event.ref.name}' spuštěna`);
        break;
      case 'stopping':
        const reason = event.reason === 'signal' ? 'přijat signál' :
                      event.reason === 'normal' ? 'graceful stop' :
                      `chyba: ${event.reason.error.message}`;
        console.log(`[${time}] 🛑 Zastavuji aplikaci '${event.ref.name}' (${reason})`);
        break;
      case 'stopped':
        console.log(`[${time}] ⭕ Aplikace '${event.name}' zastavena`);
        break;
      case 'start_failed':
        console.error(`[${time}] ❌ Aplikace '${event.name}' selhala při startu: ${event.error.message}`);
        break;
    }
  });

  const config: ServerConfig = {
    port: parseInt(process.env.PORT || '3000', 10),
    shutdownTimeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT || '30000', 10),
  };

  try {
    const app = await Application.start(ProductionServer, {
      name: 'production-api',
      config,
      handleSignals: true,
      stopTimeout: config.shutdownTimeoutMs,
    });

    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║  Production API Server                                        ║');
    console.log(`║  Port: ${config.port.toString().padEnd(55)}║`);
    console.log(`║  PID: ${process.pid.toString().padEnd(56)}║`);
    console.log('║                                                               ║');
    console.log('║  Pro graceful shutdown stiskněte Ctrl+C                       ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('');

  } catch (error) {
    console.error('Selhání při startu serveru:', error);
    process.exit(1);
  }
}

main();
```

**Ukázkový výstup při stisknutí Ctrl+C:**

```
[2024-01-25T12:00:00.000Z] 🚀 Spouštím aplikaci 'production-api'
[Server] Spouštím na portu 3000...
[Server] Připraven přijímat spojení
[2024-01-25T12:00:00.100Z] ✅ Aplikace 'production-api' spuštěna

╔═══════════════════════════════════════════════════════════════╗
║  Production API Server                                        ║
║  Port: 3000                                                   ║
║  PID: 12345                                                   ║
║                                                               ║
║  Pro graceful shutdown stiskněte Ctrl+C                       ║
╚═══════════════════════════════════════════════════════════════╝

^C
[2024-01-25T12:05:30.000Z] 🛑 Zastavuji aplikaci 'production-api' (přijat signál)
[Server] Připravuji se na shutdown...
[Server] Zastaveno přijímání nových spojení
[Server] Čekám na 3 aktivních požadavků...
[Server] Čekám na 1 aktivních požadavků...
[Server] prepStop dokončen za 2150ms
[Server] Finální cleanup...
[Server] Statistiky shutdownu:
  Celkem zpracovaných požadavků: 1547
  Požadavků dokončených během shutdownu: 3
[Server] Sbohem!
[2024-01-25T12:05:32.200Z] ⭕ Aplikace 'production-api' zastavena
```

## Cvičení: Graceful Worker Pool

Vytvořte worker pool, který zpracovává shutdown gracefully:

**Požadavky:**

1. **WorkerPool GenServer** který spravuje N worker procesů
2. **Workery** zpracovávají úlohy z fronty
3. **Při shutdownu:**
   - Okamžitě zastavit přijímání nových úloh
   - Nechat aktuálně běžící úlohy dokončit (s timeoutem)
   - Reportovat kolik úloh bylo dokončeno vs. opuštěno
4. **Lifecycle logování** pro všechny přechody stavů

**Výchozí kód:**

```typescript
import {
  Application,
  Supervisor,
  GenServer,
  type SupervisorRef,
  type GenServerBehavior,
} from '@hamicek/noex';

interface PoolConfig {
  workerCount: number;
  jobTimeoutMs: number;
  shutdownTimeoutMs: number;
}

interface Job {
  id: string;
  payload: unknown;
}

// TODO: Implementovat WorkerPool GenServer
// - Spravuje frontu čekajících úloh
// - Sleduje které úlohy jsou aktuálně zpracovávány
// - Zpracovává 'submit' cast pro přidání úloh
// - Zpracovává 'drain' call pro zastavení přijímání a čekání na dokončení
// - Zpracovává 'getStats' call pro vrácení počtů fronty/zpracování

// TODO: Implementovat Worker GenServer
// - Zpracovává jednotlivé úlohy
// - Reportuje dokončení zpět do poolu

// TODO: Implementovat WorkerPoolApp Application
// - Startuje supervisor s poolem a workery
// - prepStop: volá drain na pool
// - stop: loguje finální statistiky

async function main() {
  // TODO: Spustit aplikaci
  // TODO: Odeslat testovací úlohy
  // TODO: Stisknout Ctrl+C pro test graceful shutdown
}

main();
```

<details>
<summary><strong>Řešení</strong></summary>

```typescript
import {
  Application,
  Supervisor,
  GenServer,
  Registry,
  type SupervisorRef,
  type GenServerRef,
  type GenServerBehavior,
  type ApplicationLifecycleEvent,
} from '@hamicek/noex';

interface PoolConfig {
  workerCount: number;
  jobTimeoutMs: number;
  shutdownTimeoutMs: number;
}

interface Job {
  id: string;
  payload: unknown;
  submittedAt: number;
}

// Pool state
interface PoolState {
  queue: Job[];
  processing: Map<string, { job: Job; workerId: string; startedAt: number }>;
  workers: Map<string, GenServerRef>;
  accepting: boolean;
  completedCount: number;
  abandonedCount: number;
}

type PoolCall =
  | { type: 'getStats' }
  | { type: 'drain'; timeoutMs: number }
  | { type: 'jobCompleted'; jobId: string; workerId: string }
  | { type: 'jobFailed'; jobId: string; workerId: string; error: string };

type PoolCast =
  | { type: 'submit'; job: Job }
  | { type: 'registerWorker'; workerId: string; ref: GenServerRef };

type PoolReply =
  | { queued: number; processing: number; completed: number; abandoned: number; accepting: boolean }
  | { drained: boolean; completed: number; abandoned: number };

function createPoolBehavior(
  config: PoolConfig,
): GenServerBehavior<PoolState, PoolCall, PoolCast, PoolReply> {
  const assignJobToWorker = (state: PoolState): PoolState => {
    if (state.queue.length === 0) return state;

    // Najít dostupného workera
    for (const [workerId, ref] of state.workers) {
      const isProcessing = Array.from(state.processing.values())
        .some(p => p.workerId === workerId);

      if (!isProcessing) {
        const job = state.queue[0];
        const newQueue = state.queue.slice(1);

        // Odeslat úlohu workerovi
        GenServer.cast(ref, { type: 'process', job });

        const newProcessing = new Map(state.processing);
        newProcessing.set(job.id, {
          job,
          workerId,
          startedAt: Date.now(),
        });

        console.log(`[Pool] Přiřazena úloha ${job.id} workerovi ${workerId}`);

        return {
          ...state,
          queue: newQueue,
          processing: newProcessing,
        };
      }
    }
    return state;
  };

  return {
    init: () => ({
      queue: [],
      processing: new Map(),
      workers: new Map(),
      accepting: true,
      completedCount: 0,
      abandonedCount: 0,
    }),

    handleCall: async (msg, state) => {
      switch (msg.type) {
        case 'getStats':
          return [{
            queued: state.queue.length,
            processing: state.processing.size,
            completed: state.completedCount,
            abandoned: state.abandonedCount,
            accepting: state.accepting,
          }, state];

        case 'drain': {
          console.log('[Pool] Vyžádáno vyprázdnění, zastavuji přijímání');
          let newState = { ...state, accepting: false };

          // Čekat na dokončení zpracovávaných úloh (s timeoutem)
          const startTime = Date.now();
          while (newState.processing.size > 0 && Date.now() - startTime < msg.timeoutMs) {
            console.log(`[Pool] Čekám na dokončení ${newState.processing.size} úloh...`);
            await new Promise(r => setTimeout(r, 500));
          }

          // Označit zbývající jako opuštěné
          const abandoned = newState.processing.size;
          if (abandoned > 0) {
            console.log(`[Pool] Timeout: opouštím ${abandoned} úloh`);
            newState = {
              ...newState,
              abandonedCount: newState.abandonedCount + abandoned,
              processing: new Map(),
            };
          }

          // Také opustit čekající úlohy
          const queuedAbandoned = newState.queue.length;
          if (queuedAbandoned > 0) {
            console.log(`[Pool] Opouštím ${queuedAbandoned} čekajících úloh`);
            newState = {
              ...newState,
              abandonedCount: newState.abandonedCount + queuedAbandoned,
              queue: [],
            };
          }

          return [{
            drained: true,
            completed: newState.completedCount,
            abandoned: newState.abandonedCount,
          }, newState];
        }

        case 'jobCompleted': {
          console.log(`[Pool] Úloha ${msg.jobId} dokončena workerem ${msg.workerId}`);
          const newProcessing = new Map(state.processing);
          newProcessing.delete(msg.jobId);

          let newState = {
            ...state,
            processing: newProcessing,
            completedCount: state.completedCount + 1,
          };

          // Zkusit přiřadit další úlohu
          if (newState.accepting) {
            newState = assignJobToWorker(newState);
          }

          return [{
            queued: newState.queue.length,
            processing: newState.processing.size,
            completed: newState.completedCount,
            abandoned: newState.abandonedCount,
            accepting: newState.accepting,
          }, newState];
        }

        case 'jobFailed': {
          console.log(`[Pool] Úloha ${msg.jobId} selhala na ${msg.workerId}: ${msg.error}`);
          const newProcessing = new Map(state.processing);
          newProcessing.delete(msg.jobId);

          // Počítat jako opuštěnou (mohli bychom také retry)
          return [{
            queued: state.queue.length,
            processing: newProcessing.size,
            completed: state.completedCount,
            abandoned: state.abandonedCount + 1,
            accepting: state.accepting,
          }, {
            ...state,
            processing: newProcessing,
            abandonedCount: state.abandonedCount + 1,
          }];
        }
      }
    },

    handleCast: (msg, state) => {
      switch (msg.type) {
        case 'submit': {
          if (!state.accepting) {
            console.log(`[Pool] Odmítnuta úloha ${msg.job.id} (nepřijímá)`);
            return state;
          }

          console.log(`[Pool] Přijata úloha ${msg.job.id}`);
          const newState = {
            ...state,
            queue: [...state.queue, msg.job],
          };

          // Zkusit okamžitě přiřadit
          return assignJobToWorker(newState);
        }

        case 'registerWorker': {
          console.log(`[Pool] Worker ${msg.workerId} registrován`);
          const newWorkers = new Map(state.workers);
          newWorkers.set(msg.workerId, msg.ref);

          // Zkusit přiřadit úlohu novému workerovi
          return assignJobToWorker({ ...state, workers: newWorkers });
        }
      }
      return state;
    },
  };
}

// Worker behavior
interface WorkerState {
  id: string;
  pool: GenServerRef;
  currentJob: Job | null;
}

type WorkerCall = { type: 'getStatus' };
type WorkerCast = { type: 'process'; job: Job };
type WorkerReply = { busy: boolean; currentJobId: string | null };

function createWorkerBehavior(
  id: string,
  pool: GenServerRef,
  jobTimeoutMs: number,
): GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerReply> {
  return {
    init: () => {
      // Registrovat u poolu
      GenServer.cast(pool, { type: 'registerWorker', workerId: id, ref: GenServer.self!() });
      return { id, pool, currentJob: null };
    },

    handleCall: (msg, state) => {
      if (msg.type === 'getStatus') {
        return [{
          busy: state.currentJob !== null,
          currentJobId: state.currentJob?.id ?? null,
        }, state];
      }
      return [{ busy: false, currentJobId: null }, state];
    },

    handleCast: async (msg, state) => {
      if (msg.type === 'process') {
        const { job } = msg;
        console.log(`[Worker ${state.id}] Zpracovávám úlohu ${job.id}`);

        try {
          // Simulace práce (náhodná délka)
          const duration = 500 + Math.random() * 2000;
          await new Promise(r => setTimeout(r, duration));

          // Reportovat dokončení
          await GenServer.call(state.pool, {
            type: 'jobCompleted',
            jobId: job.id,
            workerId: state.id,
          });

          console.log(`[Worker ${state.id}] Dokončena úloha ${job.id}`);
        } catch (error) {
          await GenServer.call(state.pool, {
            type: 'jobFailed',
            jobId: job.id,
            workerId: state.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        return { ...state, currentJob: null };
      }
      return state;
    },

    terminate: (reason, state) => {
      if (state.currentJob) {
        console.log(`[Worker ${state.id}] Ukončen s úlohou ${state.currentJob.id} v průběhu`);
      }
    },
  };
}

// Application behavior
const WorkerPoolApp = Application.create<PoolConfig>({
  async start(config) {
    console.log(`[App] Spouštím worker pool s ${config.workerCount} workery`);

    // Vytvořit pool nejdříve
    const pool = await GenServer.start(
      createPoolBehavior(config),
      { name: 'job-pool' },
    );

    // Vytvořit workery
    const workerRefs: GenServerRef[] = [];
    for (let i = 0; i < config.workerCount; i++) {
      const workerId = `worker-${i + 1}`;
      const worker = await GenServer.start(
        createWorkerBehavior(workerId, pool, config.jobTimeoutMs),
        { name: workerId },
      );
      workerRefs.push(worker);
    }

    // Vytvořit supervisor pro správu poolu a workerů
    const supervisor = await Supervisor.start({
      strategy: 'one_for_all',
      children: [
        { id: 'pool', start: () => Promise.resolve(pool) },
        ...workerRefs.map((ref, i) => ({
          id: `worker-${i + 1}`,
          start: () => Promise.resolve(ref),
        })),
      ],
    });

    console.log(`[App] Worker pool spuštěn`);
    return supervisor;
  },

  async prepStop(supervisor) {
    console.log('[App] Zahajuji graceful shutdown...');

    const pool = Supervisor.getChild(supervisor, 'pool');
    if (pool) {
      const result = await GenServer.call(pool, {
        type: 'drain',
        timeoutMs: 10000,
      }) as { drained: boolean; completed: number; abandoned: number };

      console.log('[App] Pool vyprázdněn:');
      console.log(`  Dokončeno: ${result.completed}`);
      console.log(`  Opuštěno: ${result.abandoned}`);
    }
  },

  async stop(supervisor) {
    console.log('[App] Finální statistiky:');

    const pool = Supervisor.getChild(supervisor, 'pool');
    if (pool) {
      const stats = await GenServer.call(pool, { type: 'getStats' }) as {
        completed: number;
        abandoned: number;
      };

      console.log(`  Celkem dokončeno: ${stats.completed}`);
      console.log(`  Celkem opuštěno: ${stats.abandoned}`);
    }

    console.log('[App] Shutdown dokončen');
  },
});

// Hlavní vstupní bod
async function main() {
  // Lifecycle logování
  Application.onLifecycleEvent((event: ApplicationLifecycleEvent) => {
    const time = new Date(event.timestamp).toISOString();

    switch (event.type) {
      case 'starting':
        console.log(`[${time}] LIFECYCLE: Spouštím '${event.name}'`);
        break;
      case 'started':
        console.log(`[${time}] LIFECYCLE: Spuštěno '${event.ref.name}'`);
        break;
      case 'stopping':
        const reason = event.reason === 'signal' ? 'signál' :
                      event.reason === 'normal' ? 'normální' :
                      `chyba: ${event.reason.error.message}`;
        console.log(`[${time}] LIFECYCLE: Zastavuji '${event.ref.name}' (${reason})`);
        break;
      case 'stopped':
        console.log(`[${time}] LIFECYCLE: Zastaveno '${event.name}'`);
        break;
      case 'start_failed':
        console.error(`[${time}] LIFECYCLE: Selhalo '${event.name}': ${event.error.message}`);
        break;
    }
  });

  const config: PoolConfig = {
    workerCount: 3,
    jobTimeoutMs: 5000,
    shutdownTimeoutMs: 15000,
  };

  try {
    const app = await Application.start(WorkerPoolApp, {
      name: 'worker-pool',
      config,
      handleSignals: true,
      stopTimeout: config.shutdownTimeoutMs,
    });

    // Odeslat testovací úlohy
    const pool = Application.getSupervisor(app);
    if (pool) {
      const poolRef = Supervisor.getChild(pool, 'pool');
      if (poolRef) {
        console.log('\n[Test] Odesílám 10 testovacích úloh...\n');

        for (let i = 1; i <= 10; i++) {
          GenServer.cast(poolRef, {
            type: 'submit',
            job: { id: `job-${i}`, payload: { task: i }, submittedAt: Date.now() },
          });
          await new Promise(r => setTimeout(r, 200));  // Rozložit odeslání
        }

        console.log('\n[Test] Všechny úlohy odeslány. Stiskněte Ctrl+C pro test graceful shutdown.\n');
      }
    }

    // Běžet dál
    await new Promise(() => {});

  } catch (error) {
    console.error('Selhání při startu worker poolu:', error);
    process.exit(1);
  }
}

main();
```

**Ukázkový výstup:**

```
[2024-01-25T12:00:00.000Z] LIFECYCLE: Spouštím 'worker-pool'
[App] Spouštím worker pool s 3 workery
[Pool] Worker worker-1 registrován
[Pool] Worker worker-2 registrován
[Pool] Worker worker-3 registrován
[App] Worker pool spuštěn
[2024-01-25T12:00:00.100Z] LIFECYCLE: Spuštěno 'worker-pool'

[Test] Odesílám 10 testovacích úloh...

[Pool] Přijata úloha job-1
[Pool] Přiřazena úloha job-1 workerovi worker-1
[Worker worker-1] Zpracovávám úlohu job-1
[Pool] Přijata úloha job-2
[Pool] Přiřazena úloha job-2 workerovi worker-2
[Worker worker-2] Zpracovávám úlohu job-2
[Pool] Přijata úloha job-3
[Pool] Přiřazena úloha job-3 workerovi worker-3
[Worker worker-3] Zpracovávám úlohu job-3
[Pool] Přijata úloha job-4
[Pool] Přijata úloha job-5
...

[Test] Všechny úlohy odeslány. Stiskněte Ctrl+C pro test graceful shutdown.

[Worker worker-1] Dokončena úloha job-1
[Pool] Úloha job-1 dokončena workerem worker-1
[Pool] Přiřazena úloha job-4 workerovi worker-1
...

^C
[2024-01-25T12:00:05.000Z] LIFECYCLE: Zastavuji 'worker-pool' (signál)
[App] Zahajuji graceful shutdown...
[Pool] Vyžádáno vyprázdnění, zastavuji přijímání
[Pool] Čekám na dokončení 3 úloh...
[Worker worker-2] Dokončena úloha job-7
[Pool] Úloha job-7 dokončena workerem worker-2
[Pool] Čekám na dokončení 2 úloh...
[Worker worker-1] Dokončena úloha job-8
[Pool] Úloha job-8 dokončena workerem worker-1
[Pool] Čekám na dokončení 1 úloh...
[Worker worker-3] Dokončena úloha job-9
[Pool] Úloha job-9 dokončena workerem worker-3
[Pool] Opouštím 1 čekajících úloh
[App] Pool vyprázdněn:
  Dokončeno: 9
  Opuštěno: 1
[App] Finální statistiky:
  Celkem dokončeno: 9
  Celkem opuštěno: 1
[App] Shutdown dokončen
[2024-01-25T12:00:07.500Z] LIFECYCLE: Zastaveno 'worker-pool'
```

**Klíčová designová rozhodnutí:**

1. **Okamžité odmítnutí** — Nové úlohy odmítnuty hned jak začne drain
2. **Dokončení rozpracovaných** — Workery dokončí aktuální úlohu
3. **Zpracování timeoutu** — Úlohy stále zpracovávané po timeoutu jsou označeny jako opuštěné
4. **Úklid fronty** — Čekající úlohy také označeny jako opuštěné
5. **Statistiky** — Kompletní účtování dokončených vs. opuštěných úloh

</details>

## Shrnutí

**Klíčové poznatky:**

- **SIGINT/SIGTERM** jsou graceful shutdown signály — zpracovávejte je správně
- **SIGKILL** nelze zachytit — zajistěte cleanup před jeho příchodem
- **handleSignals: true** (výchozí) automaticky spravuje signal handlery
- **prepStop** běží před zastavením supervisoru — použijte pro vyprázdnění a notifikace
- **stop** běží po zastavení supervisoru — použijte pro finální cleanup
- **stopTimeout** musí být menší než container termination grace period

**Vzory zpracování signálů:**

| Typ aplikace | prepStop akce | stop akce |
|--------------|---------------|-----------|
| HTTP Server | Zastavit přijímání, vyprázdnit spojení | Flush logů |
| Worker Pool | Zastavit přijímání úloh, čekat na dokončení | Reportovat statistiky |
| WebSocket Server | Notifikovat klienty, gracefully uzavřít | Vyčistit stav |
| Database Service | Zastavit zápisy, flush bufferů | Uzavřít spojení |

**Checklist pro container orchestraci:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ☐ Nastavit stopTimeout < terminationGracePeriodSeconds                     │
│  ☐ Implementovat prepStop pro vyprázdnění spojení/požadavků                 │
│  ☐ Zpracovat rozpracovanou práci před zastavením supervisoru                │
│  ☐ Logovat průběh shutdownu pro debugging                                   │
│  ☐ Testovat s `docker stop` a `kubectl delete pod`                          │
│  ☐ Monitorovat SIGKILL (indikuje timeout problémy)                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Pamatujte:**

> Graceful shutdown není volitelný v produkci. Uživatelé nevidí váš vnitřní stav — vidí ztracená spojení a ztracená data. Zpracovávejte signály správně, vyprázdněte práci před zastavením a vždy nechte čas na cleanup před příchodem SIGKILL.

---

Další: [Produkční setup](./03-produkcni-setup.md)
