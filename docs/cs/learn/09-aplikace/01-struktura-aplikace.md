# Struktura aplikace

V předchozí kapitole jste se naučili o TimerService pro trvanlivé plánování. Nyní je čas dát vše dohromady do **produkční aplikace**. noex poskytuje Application behavior, který standardizuje správu životního cyklu, zpracování signálů a graceful shutdown.

## Co se naučíte

- Strukturovat noex aplikace pomocí Application behavior
- Konfigurovat vstupní body aplikace s typovanou konfigurací
- Implementovat graceful startup a shutdown sekvence
- Monitorovat události životního cyklu aplikace
- Spravovat více aplikací v jednom procesu

## Proč Application behavior?

Při budování produkčních služeb potřebujete více než jen GenServery a Supervisory. Potřebujete:

- **Konzistentní startup** — Inicializace závislostí ve správném pořadí
- **Zpracování signálů** — Reakce na SIGINT/SIGTERM pro container orchestraci
- **Graceful shutdown** — Vyprázdnění spojení, dokončení rozpracovaných požadavků, uložení stavu
- **Viditelnost životního cyklu** — Vědět kdy aplikace startovala, skončila a proč

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ŽIVOTNÍ CYKLUS APLIKACE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────┐    Application.start()    ┌──────────┐                         │
│  │ STOPPED │ ────────────────────────► │ STARTING │                         │
│  └─────────┘                           └────┬─────┘                         │
│       ▲                                     │                               │
│       │                                     │ start() callback dokončen     │
│       │                                     ▼                               │
│       │                              ┌───────────┐                          │
│       │                              │  RUNNING  │◄──────────┐              │
│       │                              └─────┬─────┘           │              │
│       │                                    │                 │              │
│       │    ┌───────────────────────────────┼─────────────────┘              │
│       │    │                               │                                │
│       │    │  SIGINT/SIGTERM    Application.stop()                          │
│       │    │       │                       │                                │
│       │    │       ▼                       ▼                                │
│       │    │  ┌──────────────────────────────┐                              │
│       │    │  │          STOPPING            │                              │
│       │    │  │  ┌────────────────────────┐  │                              │
│       │    │  │  │ 1. prepStop() callback │  │                              │
│       │    │  │  │ 2. Stop supervisor tree│  │                              │
│       │    │  │  │ 3. stop() callback     │  │                              │
│       │    │  │  └────────────────────────┘  │                              │
│       │    │  └──────────────┬───────────────┘                              │
│       │    │                 │                                              │
│       └────┴─────────────────┘                                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Application behavior zapouzdřuje tento pattern životního cyklu, takže se můžete soustředit na business logiku.

## Definice aplikace

Použijte `Application.create()` pro definici typovaného application behavior:

```typescript
import { Application, Supervisor, GenServer } from '@hamicek/noex';

// Konfigurační typ pro aplikaci
interface AppConfig {
  port: number;
  dbUrl: string;
  maxConnections: number;
}

// Vytvoření application behavior
const MyApp = Application.create<AppConfig>({
  // Volá se při Application.start()
  async start(config) {
    console.log(`Spouštím aplikaci na portu ${config.port}...`);

    // Start top-level supervisoru
    const supervisor = await Supervisor.start({
      strategy: 'one_for_one',
      children: [
        {
          id: 'database',
          start: () => DatabasePool.start(config.dbUrl, config.maxConnections),
        },
        {
          id: 'http-server',
          start: () => HttpServer.start(config.port),
        },
        {
          id: 'background-jobs',
          start: () => JobProcessor.start(),
        },
      ],
    });

    console.log('Aplikace úspěšně spuštěna');
    return supervisor;  // Vrátí referenci na supervisor
  },

  // Volitelné: Volá se před zastavením (příprava na shutdown)
  async prepStop(supervisorRef) {
    console.log('Připravuji se na zastavení...');
    // Zastavit přijímání nových spojení
    // Vyprázdnit fronty požadavků
    // Notifikovat load balancery
  },

  // Volitelné: Volá se po zastavení supervisor stromu
  async stop(supervisorRef) {
    console.log('Aplikace zastavena');
    // Finální cleanup: flush logů, uzavření metrics spojení atd.
  },
});
```

### ApplicationBehavior rozhraní

```typescript
interface ApplicationBehavior<Config = void, State = SupervisorRef> {
  // Povinné: Start aplikace
  start(config: Config): State | Promise<State>;

  // Volitelné: Příprava na shutdown (před zastavením supervisoru)
  prepStop?(state: State): void | Promise<void>;

  // Volitelné: Finální cleanup (po zastavení supervisoru)
  stop?(state: State): void | Promise<void>;
}
```

| Callback | Kdy se volá | Typické použití |
|----------|-------------|-----------------|
| `start` | Při `Application.start()` | Inicializace supervisor stromu, připojení k databázím |
| `prepStop` | Na začátku shutdownu | Zastavení přijímání požadavků, vyprázdnění front |
| `stop` | Po zastavení supervisoru | Flush logů, uzavření metrics, finální cleanup |

## Spuštění aplikace

Použijte `Application.start()` s options pro spuštění aplikace:

```typescript
import { Application } from '@hamicek/noex';

async function main() {
  // Spuštění aplikace
  const app = await Application.start(MyApp, {
    name: 'my-api-server',           // Unikátní název pro vyhledávání
    config: {                         // Předáno do start() callbacku
      port: 3000,
      dbUrl: 'postgres://localhost/mydb',
      maxConnections: 10,
    },
    handleSignals: true,              // Auto-zpracování SIGINT/SIGTERM (výchozí: true)
    startTimeout: 30000,              // Max čas pro dokončení start() (výchozí: 30s)
    stopTimeout: 30000,               // Max čas pro stop sekvenci (výchozí: 30s)
  });

  console.log(`Aplikace '${app.name}' běží`);

  // Reference na aplikaci lze použít pro:
  // - Kontrolu stavu
  // - Ruční zastavení
  // - Přístup k supervisoru
}

main().catch(console.error);
```

### Reference start options

| Option | Typ | Výchozí | Popis |
|--------|-----|---------|-------|
| `name` | `string` | — | Povinné. Unikátní identifikátor aplikace |
| `config` | `Config` | — | Konfigurace předaná do `start()` callbacku |
| `handleSignals` | `boolean` | `true` | Auto-registrace SIGINT/SIGTERM handlerů |
| `startTimeout` | `number` | `30000` | Maximum ms pro dokončení `start()` |
| `stopTimeout` | `number` | `30000` | Maximum ms pro dokončení stop sekvence |

### Chyby při startu

```typescript
import {
  Application,
  ApplicationStartError,
  ApplicationAlreadyRunningError,
} from '@hamicek/noex';

try {
  await Application.start(MyApp, { name: 'my-app', config });
} catch (error) {
  if (error instanceof ApplicationAlreadyRunningError) {
    console.error(`Aplikace '${error.applicationName}' již běží`);
  } else if (error instanceof ApplicationStartError) {
    console.error(`Selhání při startu: ${error.message}`);
    console.error(`Příčina: ${error.cause?.message}`);
  }
}
```

## Zastavení aplikace

Aplikace lze zastavit manuálně nebo pomocí signálů:

```typescript
import { Application } from '@hamicek/noex';

// Manuální zastavení
await Application.stop(app, 'normal');

// Stop sekvence je:
// 1. Nastavení stavu na 'stopping'
// 2. Emit 'stopping' lifecycle eventu
// 3. Volání prepStop() callbacku (pokud je definován)
// 4. Zastavení supervisor stromu (pokud je state SupervisorRef)
// 5. Volání stop() callbacku (pokud je definován)
// 6. Odstranění signal handlerů
// 7. Emit 'stopped' lifecycle eventu
```

### Důvody zastavení

```typescript
type ApplicationStopReason =
  | 'normal'           // Graceful manuální zastavení
  | 'signal'           // Přijat SIGINT nebo SIGTERM
  | { error: Error };  // Zastavení kvůli chybě
```

### Stop timeout

Pokud stop sekvence trvá déle než `stopTimeout`, vyhodí se chyba:

```typescript
import { ApplicationStopTimeoutError } from '@hamicek/noex';

try {
  await Application.stop(app);
} catch (error) {
  if (error instanceof ApplicationStopTimeoutError) {
    console.error(`Stop timeout po ${error.timeoutMs}ms`);
    // Možná bude nutné násilně ukončit proces
    process.exit(1);
  }
}
```

## Stav aplikace a dotazy

Dotazování stavu aplikace za běhu:

```typescript
import { Application } from '@hamicek/noex';

// Kontrola zda běží
if (Application.isRunning(app)) {
  console.log('Aplikace je zdravá');
}

// Získání aktuálního stavu
const status = Application.getStatus(app);
// 'stopped' | 'starting' | 'running' | 'stopping'

// Získání reference na supervisor (pokud je state SupervisorRef)
const supervisor = Application.getSupervisor(app);
if (supervisor) {
  // Inspekce supervisor stromu
  const children = Supervisor.children(supervisor);
  console.log(`Běží ${children.length} služeb`);
}

// Získání informací o aplikaci
const info = Application.getInfo(app);
if (info) {
  console.log(`Název: ${info.name}`);
  console.log(`Stav: ${info.status}`);
  console.log(`Spuštěno: ${new Date(info.startedAt).toISOString()}`);
  console.log(`Uptime: ${info.uptimeMs}ms`);
}
```

## Vyhledání aplikace

Vyhledání aplikací podle názvu:

```typescript
import { Application } from '@hamicek/noex';

// Najít aplikaci podle názvu
const app = Application.lookup('my-api-server');
if (app) {
  console.log(`Nalezena aplikace, stav: ${Application.getStatus(app)}`);
} else {
  console.log('Aplikace nenalezena');
}

// Seznam všech běžících aplikací
const allApps = Application.getAllRunning();
console.log(`Běžící aplikace: ${allApps.map(a => a.name).join(', ')}`);

// Zastavení všech aplikací (LIFO pořadí - poslední spuštěná, první zastavená)
await Application.stopAll('normal');
```

## Lifecycle eventy

Monitorování životního cyklu aplikace pro logování, metriky nebo alerting:

```typescript
import { Application, type ApplicationLifecycleEvent } from '@hamicek/noex';

// Registrace lifecycle handleru
const unsubscribe = Application.onLifecycleEvent((event: ApplicationLifecycleEvent) => {
  const timestamp = new Date(event.timestamp).toISOString();

  switch (event.type) {
    case 'starting':
      console.log(`[${timestamp}] Aplikace '${event.name}' startuje...`);
      break;

    case 'started':
      console.log(`[${timestamp}] Aplikace '${event.ref.name}' spuštěna`);
      // Odeslat "application up" metriku
      break;

    case 'stopping':
      console.log(`[${timestamp}] Aplikace '${event.ref.name}' se zastavuje (${formatReason(event.reason)})`);
      break;

    case 'stopped':
      console.log(`[${timestamp}] Aplikace '${event.name}' zastavena (${formatReason(event.reason)})`);
      // Odeslat "application down" metriku
      break;

    case 'start_failed':
      console.error(`[${timestamp}] Aplikace '${event.name}' selhala při startu: ${event.error.message}`);
      // Odeslat alert
      break;
  }
});

function formatReason(reason: ApplicationStopReason): string {
  if (reason === 'normal') return 'graceful';
  if (reason === 'signal') return 'přijat signál';
  return `chyba: ${reason.error.message}`;
}

// Později: odhlášení když už není potřeba
unsubscribe();
```

### Typy lifecycle eventů

| Event | Payload | Kdy |
|-------|---------|-----|
| `starting` | `{ name, timestamp }` | Volán `start()` |
| `started` | `{ ref, timestamp }` | `start()` úspěšně dokončen |
| `stopping` | `{ ref, reason, timestamp }` | Začíná stop sekvence |
| `stopped` | `{ name, reason, timestamp }` | Stop sekvence dokončena |
| `start_failed` | `{ name, error, timestamp }` | `start()` vyhodil chybu nebo timeout |

## Kompletní příklad: API Server

Zde je produkční struktura API serveru:

```typescript
import {
  Application,
  Supervisor,
  GenServer,
  Cache,
  RateLimiter,
  type SupervisorRef,
  type GenServerRef,
  type ApplicationRef,
} from '@hamicek/noex';

// Konfigurace aplikace
interface ApiServerConfig {
  port: number;
  env: 'development' | 'staging' | 'production';
  database: {
    url: string;
    poolSize: number;
  };
  redis: {
    url: string;
  };
  rateLimit: {
    maxRequests: number;
    windowMs: number;
  };
}

// Vytvoření application behavior
const ApiServer = Application.create<ApiServerConfig>({
  async start(config) {
    console.log(`[ApiServer] Spouštím v ${config.env} režimu...`);

    // Validace konfigurace
    if (!config.database.url) {
      throw new Error('Database URL je povinná');
    }

    // Start hlavního supervisor stromu
    const supervisor = await Supervisor.start({
      strategy: 'one_for_one',
      maxRestarts: 5,
      withinMs: 60000,
      children: [
        // Základní infrastruktura
        {
          id: 'cache',
          start: async () => Cache.start({
            maxSize: 1000,
            ttlMs: 300000,  // 5 minut
            name: 'api-cache',
          }),
        },
        {
          id: 'rate-limiter',
          start: async () => RateLimiter.start({
            maxRequests: config.rateLimit.maxRequests,
            windowMs: config.rateLimit.windowMs,
            name: 'api-rate-limiter',
          }),
        },

        // Aplikační služby (vnořený supervisor)
        {
          id: 'services',
          start: async () => Supervisor.start({
            strategy: 'rest_for_one',  // Služby závisí na sobě
            children: [
              {
                id: 'database-pool',
                start: () => createDatabasePool(config.database),
              },
              {
                id: 'user-service',
                start: () => UserService.start(),
              },
              {
                id: 'order-service',
                start: () => OrderService.start(),
              },
            ],
          }),
        },

        // HTTP server (startuje poslední)
        {
          id: 'http',
          start: async () => createHttpServer(config.port),
        },
      ],
    });

    console.log(`[ApiServer] Spuštěn na portu ${config.port}`);
    return supervisor;
  },

  async prepStop(supervisor) {
    console.log('[ApiServer] Připravuji se na shutdown...');

    // Zastavit přijímání nových HTTP spojení
    const httpRef = Supervisor.getChild(supervisor, 'http');
    if (httpRef) {
      await GenServer.call(httpRef, { type: 'stopAccepting' });
    }

    // Počkat na dokončení rozpracovaných požadavků (max 10 sekund)
    await drainRequests(10000);

    console.log('[ApiServer] Připraven na shutdown');
  },

  async stop(supervisor) {
    console.log('[ApiServer] Provádím finální cleanup...');

    // Flush čekajících metrik
    await flushMetrics();

    // Log finálního stavu
    console.log('[ApiServer] Shutdown dokončen');
  },
});

// Helper funkce (implementační detaily)
async function createDatabasePool(config: { url: string; poolSize: number }) {
  // ... inicializace database poolu
  return GenServer.start({ /* ... */ });
}

async function createHttpServer(port: number) {
  // ... inicializace HTTP serveru
  return GenServer.start({ /* ... */ });
}

async function drainRequests(timeoutMs: number): Promise<void> {
  // ... čekání na rozpracované požadavky
}

async function flushMetrics(): Promise<void> {
  // ... flush čekajících metrik
}

// Vstupní bod aplikace
async function main() {
  // Registrace lifecycle monitoringu
  Application.onLifecycleEvent((event) => {
    if (event.type === 'start_failed') {
      console.error('FATAL: Aplikace selhala při startu', event.error);
      process.exit(1);
    }
  });

  // Načtení konfigurace z prostředí
  const config: ApiServerConfig = {
    port: parseInt(process.env.PORT || '3000', 10),
    env: (process.env.NODE_ENV || 'development') as ApiServerConfig['env'],
    database: {
      url: process.env.DATABASE_URL || 'postgres://localhost/api',
      poolSize: parseInt(process.env.DB_POOL_SIZE || '10', 10),
    },
    redis: {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    },
    rateLimit: {
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || '60000', 10),
    },
  };

  // Spuštění aplikace
  const app = await Application.start(ApiServer, {
    name: 'api-server',
    config,
    handleSignals: true,
    startTimeout: 60000,   // 1 minuta na start (databázová spojení atd.)
    stopTimeout: 30000,    // 30 sekund na graceful stop
  });

  console.log(`API Server běží (PID: ${process.pid})`);
  console.log(`  Prostředí: ${config.env}`);
  console.log(`  Port: ${config.port}`);
  console.log(`  Pro zastavení stiskněte Ctrl+C`);
}

main().catch((error) => {
  console.error('Selhání při startu aplikace:', error);
  process.exit(1);
});
```

## Více aplikací

Spuštění více aplikací v jednom procesu:

```typescript
import { Application } from '@hamicek/noex';

async function main() {
  // Spuštění více aplikací
  const apiApp = await Application.start(ApiServer, {
    name: 'api-server',
    config: { port: 3000 },
  });

  const adminApp = await Application.start(AdminServer, {
    name: 'admin-server',
    config: { port: 3001 },
  });

  const workerApp = await Application.start(BackgroundWorker, {
    name: 'worker',
    config: { concurrency: 5 },
  });

  console.log('Všechny aplikace spuštěny');

  // Seznam běžících aplikací
  const running = Application.getAllRunning();
  console.log(`Běží: ${running.map(a => a.name).join(', ')}`);
  // Výstup: Běží: api-server, admin-server, worker

  // Zastavení jedné aplikace
  await Application.stop(adminApp);

  // Zastavení všech zbývajících (LIFO pořadí)
  await Application.stopAll('normal');
}
```

## Cvičení: Notifikační mikroslužba

Vytvořte notifikační mikroslužbu s následujícími požadavky:

1. **Konfigurace:** Email provider credentials, SMS gateway URL, rate limity
2. **Služby:**
   - EmailSender GenServer — Odesílání emailů přes SMTP
   - SmsSender GenServer — Odesílání SMS přes HTTP gateway
   - NotificationRouter GenServer — Směrování notifikací na příslušný odesílatel
3. **Graceful shutdown:** Vyprázdnění čekajících notifikací před zastavením
4. **Lifecycle logování:** Logování všech událostí aplikace s časovými značkami

**Výchozí kód:**

```typescript
import {
  Application,
  Supervisor,
  GenServer,
  type SupervisorRef,
} from '@hamicek/noex';

interface NotificationConfig {
  email: {
    host: string;
    port: number;
    user: string;
    password: string;
  };
  sms: {
    gatewayUrl: string;
    apiKey: string;
  };
  rateLimit: {
    emailsPerMinute: number;
    smsPerMinute: number;
  };
}

// TODO: Definovat NotificationService application behavior
const NotificationService = Application.create<NotificationConfig>({
  async start(config) {
    // TODO: Start supervisor stromu s:
    //   - email-sender GenServer
    //   - sms-sender GenServer
    //   - notification-router GenServer
    throw new Error('Není implementováno');
  },

  async prepStop(supervisor) {
    // TODO: Vyprázdnit čekající notifikace
  },

  async stop(supervisor) {
    // TODO: Logovat finální statistiky
  },
});

async function main() {
  // TODO: Nastavit lifecycle logování
  // TODO: Spustit aplikaci s konfigurací z prostředí
  // TODO: Správně zpracovat chyby při startu
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
  type SupervisorRef,
  type GenServerRef,
  type GenServerBehavior,
  type ApplicationLifecycleEvent,
  type ApplicationStopReason,
} from '@hamicek/noex';

// Konfigurace
interface NotificationConfig {
  email: {
    host: string;
    port: number;
    user: string;
    password: string;
  };
  sms: {
    gatewayUrl: string;
    apiKey: string;
  };
  rateLimit: {
    emailsPerMinute: number;
    smsPerMinute: number;
  };
}

// Typy notifikací
interface EmailNotification {
  type: 'email';
  to: string;
  subject: string;
  body: string;
}

interface SmsNotification {
  type: 'sms';
  to: string;
  message: string;
}

type Notification = EmailNotification | SmsNotification;

// EmailSender
interface EmailSenderState {
  sentCount: number;
  queue: EmailNotification[];
  draining: boolean;
}

type EmailSenderCall = { type: 'getStats' } | { type: 'drain' };
type EmailSenderCast = { type: 'send'; notification: EmailNotification };
type EmailSenderReply = { sent: number; queued: number } | { drained: number };

function createEmailSenderBehavior(
  config: NotificationConfig['email'],
): GenServerBehavior<EmailSenderState, EmailSenderCall, EmailSenderCast, EmailSenderReply> {
  return {
    init: () => ({ sentCount: 0, queue: [], draining: false }),

    handleCall: async (msg, state) => {
      switch (msg.type) {
        case 'getStats':
          return [{ sent: state.sentCount, queued: state.queue.length }, state];

        case 'drain': {
          // Zpracovat všechny čekající emaily
          let drained = 0;
          for (const email of state.queue) {
            console.log(`[EmailSender] Vyprazdňuji: ${email.to} - ${email.subject}`);
            // Simulace odeslání
            await new Promise(r => setTimeout(r, 100));
            drained++;
          }
          return [{ drained }, { ...state, queue: [], draining: true }];
        }
      }
    },

    handleCast: async (msg, state) => {
      if (msg.type === 'send') {
        if (state.draining) {
          console.log(`[EmailSender] Odmítnuto (vyprazdňování): ${msg.notification.to}`);
          return state;
        }

        console.log(`[EmailSender] Odesílám na ${msg.notification.to}: ${msg.notification.subject}`);
        // Simulace odeslání (v produkci použijte nodemailer nebo podobné)
        await new Promise(r => setTimeout(r, 50));

        return {
          ...state,
          sentCount: state.sentCount + 1,
        };
      }
      return state;
    },
  };
}

// SmsSender
interface SmsSenderState {
  sentCount: number;
  queue: SmsNotification[];
  draining: boolean;
}

type SmsSenderCall = { type: 'getStats' } | { type: 'drain' };
type SmsSenderCast = { type: 'send'; notification: SmsNotification };
type SmsSenderReply = { sent: number; queued: number } | { drained: number };

function createSmsSenderBehavior(
  config: NotificationConfig['sms'],
): GenServerBehavior<SmsSenderState, SmsSenderCall, SmsSenderCast, SmsSenderReply> {
  return {
    init: () => ({ sentCount: 0, queue: [], draining: false }),

    handleCall: async (msg, state) => {
      switch (msg.type) {
        case 'getStats':
          return [{ sent: state.sentCount, queued: state.queue.length }, state];

        case 'drain': {
          let drained = 0;
          for (const sms of state.queue) {
            console.log(`[SmsSender] Vyprazdňuji: ${sms.to}`);
            await new Promise(r => setTimeout(r, 50));
            drained++;
          }
          return [{ drained }, { ...state, queue: [], draining: true }];
        }
      }
    },

    handleCast: async (msg, state) => {
      if (msg.type === 'send') {
        if (state.draining) {
          console.log(`[SmsSender] Odmítnuto (vyprazdňování): ${msg.notification.to}`);
          return state;
        }

        console.log(`[SmsSender] Odesílám na ${msg.notification.to}: ${msg.notification.message.slice(0, 30)}...`);
        await new Promise(r => setTimeout(r, 30));

        return {
          ...state,
          sentCount: state.sentCount + 1,
        };
      }
      return state;
    },
  };
}

// NotificationRouter
interface RouterState {
  emailSender: GenServerRef<EmailSenderState, EmailSenderCall, EmailSenderCast, EmailSenderReply>;
  smsSender: GenServerRef<SmsSenderState, SmsSenderCall, SmsSenderCast, SmsSenderReply>;
  routedCount: number;
}

type RouterCall = { type: 'getStats' };
type RouterCast = { type: 'route'; notification: Notification };
type RouterReply = { routed: number };

function createRouterBehavior(
  emailSender: GenServerRef<EmailSenderState, EmailSenderCall, EmailSenderCast, EmailSenderReply>,
  smsSender: GenServerRef<SmsSenderState, SmsSenderCall, SmsSenderCast, SmsSenderReply>,
): GenServerBehavior<RouterState, RouterCall, RouterCast, RouterReply> {
  return {
    init: () => ({ emailSender, smsSender, routedCount: 0 }),

    handleCall: (msg, state) => {
      if (msg.type === 'getStats') {
        return [{ routed: state.routedCount }, state];
      }
      return [{ routed: 0 }, state];
    },

    handleCast: (msg, state) => {
      if (msg.type === 'route') {
        const notification = msg.notification;

        if (notification.type === 'email') {
          GenServer.cast(state.emailSender, { type: 'send', notification });
        } else if (notification.type === 'sms') {
          GenServer.cast(state.smsSender, { type: 'send', notification });
        }

        return { ...state, routedCount: state.routedCount + 1 };
      }
      return state;
    },
  };
}

// Application behavior
const NotificationService = Application.create<NotificationConfig>({
  async start(config) {
    console.log('[NotificationService] Spouštím...');

    // Vytvořit sendery nejdříve (budou předány routeru)
    const emailSender = await GenServer.start(
      createEmailSenderBehavior(config.email),
      { name: 'email-sender' },
    );

    const smsSender = await GenServer.start(
      createSmsSenderBehavior(config.sms),
      { name: 'sms-sender' },
    );

    const router = await GenServer.start(
      createRouterBehavior(emailSender, smsSender),
      { name: 'notification-router' },
    );

    // Vytvořit supervisor pro správu všech procesů
    const supervisor = await Supervisor.start({
      strategy: 'one_for_all',  // Pokud jeden selže, restartovat všechny (jsou propojené)
      maxRestarts: 3,
      withinMs: 60000,
      children: [
        { id: 'email-sender', start: () => Promise.resolve(emailSender) },
        { id: 'sms-sender', start: () => Promise.resolve(smsSender) },
        { id: 'router', start: () => Promise.resolve(router) },
      ],
    });

    console.log('[NotificationService] Úspěšně spuštěn');
    console.log(`  Email: ${config.email.host}:${config.email.port}`);
    console.log(`  SMS Gateway: ${config.sms.gatewayUrl}`);

    return supervisor;
  },

  async prepStop(supervisor) {
    console.log('[NotificationService] Připravuji se na shutdown...');

    // Získat reference na sendery
    const emailSender = Supervisor.getChild(supervisor, 'email-sender');
    const smsSender = Supervisor.getChild(supervisor, 'sms-sender');

    // Vyprázdnit obě fronty paralelně
    const results = await Promise.all([
      emailSender ? GenServer.call(emailSender, { type: 'drain' }) : { drained: 0 },
      smsSender ? GenServer.call(smsSender, { type: 'drain' }) : { drained: 0 },
    ]);

    console.log(`[NotificationService] Vyprázdněno ${(results[0] as { drained: number }).drained} emailů, ${(results[1] as { drained: number }).drained} SMS`);
  },

  async stop(supervisor) {
    // Získat finální statistiky
    const emailSender = Supervisor.getChild(supervisor, 'email-sender');
    const smsSender = Supervisor.getChild(supervisor, 'sms-sender');
    const router = Supervisor.getChild(supervisor, 'router');

    const [emailStats, smsStats, routerStats] = await Promise.all([
      emailSender ? GenServer.call(emailSender, { type: 'getStats' }) : { sent: 0, queued: 0 },
      smsSender ? GenServer.call(smsSender, { type: 'getStats' }) : { sent: 0, queued: 0 },
      router ? GenServer.call(router, { type: 'getStats' }) : { routed: 0 },
    ]);

    console.log('[NotificationService] Finální statistiky:');
    console.log(`  Odesláno emailů: ${(emailStats as { sent: number }).sent}`);
    console.log(`  Odesláno SMS: ${(smsStats as { sent: number }).sent}`);
    console.log(`  Celkem směrováno: ${(routerStats as { routed: number }).routed}`);
    console.log('[NotificationService] Shutdown dokončen');
  },
});

// Formátování lifecycle eventů
function formatReason(reason: ApplicationStopReason): string {
  if (reason === 'normal') return 'graceful shutdown';
  if (reason === 'signal') return 'přijat signál';
  return `chyba: ${reason.error.message}`;
}

// Hlavní vstupní bod
async function main() {
  // Nastavit lifecycle logování
  Application.onLifecycleEvent((event: ApplicationLifecycleEvent) => {
    const time = new Date(event.timestamp).toISOString();

    switch (event.type) {
      case 'starting':
        console.log(`[${time}] LIFECYCLE: Aplikace '${event.name}' startuje`);
        break;
      case 'started':
        console.log(`[${time}] LIFECYCLE: Aplikace '${event.ref.name}' spuštěna`);
        break;
      case 'stopping':
        console.log(`[${time}] LIFECYCLE: Aplikace '${event.ref.name}' se zastavuje (${formatReason(event.reason)})`);
        break;
      case 'stopped':
        console.log(`[${time}] LIFECYCLE: Aplikace '${event.name}' zastavena (${formatReason(event.reason)})`);
        break;
      case 'start_failed':
        console.error(`[${time}] LIFECYCLE: Aplikace '${event.name}' SELHALA: ${event.error.message}`);
        break;
    }
  });

  // Načíst konfiguraci z prostředí
  const config: NotificationConfig = {
    email: {
      host: process.env.SMTP_HOST || 'smtp.example.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      user: process.env.SMTP_USER || 'notifications@example.com',
      password: process.env.SMTP_PASS || 'secret',
    },
    sms: {
      gatewayUrl: process.env.SMS_GATEWAY_URL || 'https://sms.example.com/api',
      apiKey: process.env.SMS_API_KEY || 'test-key',
    },
    rateLimit: {
      emailsPerMinute: parseInt(process.env.EMAIL_RATE_LIMIT || '60', 10),
      smsPerMinute: parseInt(process.env.SMS_RATE_LIMIT || '30', 10),
    },
  };

  try {
    const app = await Application.start(NotificationService, {
      name: 'notification-service',
      config,
      handleSignals: true,
      startTimeout: 10000,
      stopTimeout: 30000,
    });

    console.log(`\nNotification Service běží (PID: ${process.pid})`);
    console.log('Pro zastavení stiskněte Ctrl+C\n');

    // Simulovat několik notifikací pro testování
    const router = Application.getSupervisor(app);
    if (router) {
      const routerRef = Supervisor.getChild(router, 'router');
      if (routerRef) {
        // Odeslat testovací notifikace
        GenServer.cast(routerRef, {
          type: 'route',
          notification: { type: 'email', to: 'user@example.com', subject: 'Vítejte!', body: 'Děkujeme za registraci.' },
        });
        GenServer.cast(routerRef, {
          type: 'route',
          notification: { type: 'sms', to: '+420123456789', message: 'Váš ověřovací kód je 123456' },
        });
        GenServer.cast(routerRef, {
          type: 'route',
          notification: { type: 'email', to: 'admin@example.com', subject: 'Denní report', body: 'Zde je váš report...' },
        });
      }
    }

    // Běžet dokud nepřijde signál
    await new Promise(() => {});  // Čekat navždy (signal handler nás zastaví)

  } catch (error) {
    console.error('Selhání při startu NotificationService:', error);
    process.exit(1);
  }
}

main();
```

**Klíčová designová rozhodnutí:**

1. **Vrstvená architektura** — Sendery zpracovávají doručení, Router zpracovává směrovací logiku
2. **Vyprázdnění před stopem** — `prepStop` zajistí odeslání všech čekajících notifikací
3. **Statistiky při shutdownu** — `stop` loguje finální počty pro monitoring
4. **Strategie one_for_all** — Sendery a router jsou těsně svázané
5. **Lifecycle logování** — Všechny události logovány s časovými značkami pro debugging

**Ukázkový výstup:**

```
[2024-01-25T10:00:00.000Z] LIFECYCLE: Aplikace 'notification-service' startuje
[NotificationService] Spouštím...
[NotificationService] Úspěšně spuštěn
  Email: smtp.example.com:587
  SMS Gateway: https://sms.example.com/api
[2024-01-25T10:00:00.100Z] LIFECYCLE: Aplikace 'notification-service' spuštěna

Notification Service běží (PID: 12345)
Pro zastavení stiskněte Ctrl+C

[EmailSender] Odesílám na user@example.com: Vítejte!
[SmsSender] Odesílám na +420123456789: Váš ověřovací kód je 1234...
[EmailSender] Odesílám na admin@example.com: Denní report

^C
[2024-01-25T10:00:30.000Z] LIFECYCLE: Aplikace 'notification-service' se zastavuje (přijat signál)
[NotificationService] Připravuji se na shutdown...
[NotificationService] Vyprázdněno 0 emailů, 0 SMS
[NotificationService] Finální statistiky:
  Odesláno emailů: 2
  Odesláno SMS: 1
  Celkem směrováno: 3
[NotificationService] Shutdown dokončen
[2024-01-25T10:00:30.500Z] LIFECYCLE: Aplikace 'notification-service' zastavena (přijat signál)
```

</details>

## Shrnutí

**Klíčové poznatky:**

- **Application behavior** standardizuje správu životního cyklu — `start`, `prepStop`, `stop`
- **Typovaná konfigurace** — Předání configu do `start()` pro dependency injection
- **Automatické zpracování signálů** — SIGINT/SIGTERM spouští graceful shutdown
- **Timeouty** — Jak startup tak shutdown mají konfigurovatelné timeouty
- **Lifecycle eventy** — Monitorování změn stavu aplikace pro logování/metriky

**Reference API:**

| Metoda | Vrací | Popis |
|--------|-------|-------|
| `Application.create(behavior)` | `ApplicationBehavior` | Vytvoření typovaného behavior |
| `Application.start(behavior, options)` | `Promise<ApplicationRef>` | Spuštění aplikace |
| `Application.stop(ref, reason?)` | `Promise<void>` | Zastavení aplikace |
| `Application.getStatus(ref)` | `ApplicationStatus` | Získání aktuálního stavu |
| `Application.getSupervisor(ref)` | `SupervisorRef \| undefined` | Získání supervisoru pokud je state SupervisorRef |
| `Application.getState(ref)` | `State \| undefined` | Získání stavu aplikace |
| `Application.isRunning(ref)` | `boolean` | Kontrola zda běží |
| `Application.lookup(name)` | `ApplicationRef \| undefined` | Vyhledání podle názvu |
| `Application.getAllRunning()` | `ApplicationRef[]` | Seznam všech běžících |
| `Application.stopAll(reason?)` | `Promise<void>` | Zastavení všech (LIFO pořadí) |
| `Application.onLifecycleEvent(handler)` | `() => void` | Přihlášení k eventům |
| `Application.getInfo(ref)` | `{ name, status, startedAt, uptimeMs }` | Informace o aplikaci |

**Pamatujte:**

> Application behavior je vstupní bod pro produkční noex aplikace. Poskytuje strukturu potřebnou pro spolehlivé nasazení: konzistentní startup, graceful shutdown a viditelnost životního cyklu. Vždy používejte Application.create() pro definici aplikace a Application.start() pro její spuštění.

---

Další: [Zpracování signálů](./02-zpracovani-signalu.md)
