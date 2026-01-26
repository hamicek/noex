# Techniky ladění

V předchozích kapitolách jste se naučili inspektovat procesy pomocí Observeru, vizualizovat stav systému pomocí Dashboardu a detekovat anomálie pomocí AlertManageru. Nyní je čas prozkoumat **praktické techniky ladění** — strategie a nástroje, které použijete když se v noex aplikacích něco pokazí.

## Co se naučíte

- Používat lifecycle události pro pochopení chování procesů
- Trasovat tok zpráv mezi procesy
- Inspektovat stav procesů a diagnostikovat problémy
- Ladit běžné problémy systematickými přístupy
- Vytvářet vlastní ladicí nástroje pro vaše aplikace

## Lifecycle události pro ladění

Každá významná událost v noex procesu emituje lifecycle událost. Tyto události jsou váš primární ladicí nástroj — říkají vám přesně co se děje uvnitř vašeho systému.

### Přihlášení k odběru lifecycle událostí

```typescript
import { GenServer, Supervisor } from '@hamicek/noex';

// Přihlásit se k GenServer událostem
const unsubGenServer = GenServer.onLifecycleEvent((event) => {
  const timestamp = new Date().toISOString();

  switch (event.type) {
    case 'started':
      console.log(`[${timestamp}] SPUŠTĚN: ${event.ref.id}`);
      break;

    case 'crashed':
      console.error(`[${timestamp}] ZHAVAROVAL: ${event.ref.id}`);
      console.error(`  Chyba: ${event.error.message}`);
      console.error(`  Stack: ${event.error.stack}`);
      break;

    case 'restarted':
      console.log(`[${timestamp}] RESTARTOVÁN: ${event.ref.id}`);
      console.log(`  Pokus: ${event.attempt}`);
      break;

    case 'terminated':
      console.log(`[${timestamp}] UKONČEN: ${event.ref.id}`);
      console.log(`  Důvod: ${JSON.stringify(event.reason)}`);
      break;

    case 'state_restored':
      console.log(`[${timestamp}] STAV OBNOVEN: ${event.ref.id}`);
      console.log(`  Verze schématu: ${event.metadata.schemaVersion}`);
      console.log(`  Uloženo v: ${new Date(event.metadata.persistedAt).toISOString()}`);
      break;

    case 'state_persisted':
      console.log(`[${timestamp}] STAV ULOŽEN: ${event.ref.id}`);
      break;

    case 'persistence_error':
      console.error(`[${timestamp}] CHYBA PERSISTENCE: ${event.ref.id}`);
      console.error(`  Chyba: ${event.error.message}`);
      break;

    case 'process_down':
      console.log(`[${timestamp}] PROCES DOWN: monitorován ${event.ref.id}`);
      console.log(`  Mrtvý proces: ${event.monitoredRef.id}`);
      console.log(`  Důvod: ${event.reason.type}`);
      break;
  }
});

// Přihlásit se k Supervisor událostem
const unsubSupervisor = Supervisor.onLifecycleEvent((event) => {
  const timestamp = new Date().toISOString();

  switch (event.type) {
    case 'started':
      console.log(`[${timestamp}] SUPERVISOR SPUŠTĚN: ${event.ref.id}`);
      break;

    case 'terminated':
      console.log(`[${timestamp}] SUPERVISOR UKONČEN: ${event.ref.id}`);
      break;
  }
});

// Úklid až budete hotovi
unsubGenServer();
unsubSupervisor();
```

### Reference typů událostí

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TYPY LIFECYCLE UDÁLOSTÍ                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  LIFECYCLE PROCESU                                                          │
│  ─────────────────────────────────────────────────────────────────────────  │
│  started           Proces inicializován a běží                              │
│  crashed           Proces vyhodil neošetřenou chybu                         │
│  restarted         Proces restartován supervisorem                          │
│  terminated        Proces zastaven (normal, shutdown, nebo error)           │
│                                                                             │
│  PERSISTENCE                                                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│  state_persisted   Snímek stavu uložen do úložiště                          │
│  state_restored    Stav obnoven z úložiště                                  │
│  persistence_error Nepodařilo se uložit nebo obnovit stav                   │
│                                                                             │
│  MONITORING                                                                 │
│  ─────────────────────────────────────────────────────────────────────────  │
│  process_down      Monitorovaný proces byl ukončen                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Vytvoření Debug Loggeru

Zde je znovupoužitelný debug logger který zachytává všechny lifecycle události:

```typescript
import {
  GenServer,
  Supervisor,
  type LifecycleEvent,
} from '@hamicek/noex';

interface DebugLogEntry {
  timestamp: number;
  event: LifecycleEvent;
  source: 'genserver' | 'supervisor';
}

class DebugLogger {
  private logs: DebugLogEntry[] = [];
  private maxEntries: number;
  private unsubGenServer: (() => void) | null = null;
  private unsubSupervisor: (() => void) | null = null;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 10000;
  }

  start(): void {
    this.unsubGenServer = GenServer.onLifecycleEvent((event) => {
      this.record(event, 'genserver');
    });

    this.unsubSupervisor = Supervisor.onLifecycleEvent((event) => {
      this.record(event, 'supervisor');
    });

    console.log('[DebugLogger] Zahájeno zachytávání lifecycle událostí');
  }

  stop(): void {
    this.unsubGenServer?.();
    this.unsubSupervisor?.();
    this.unsubGenServer = null;
    this.unsubSupervisor = null;
    console.log('[DebugLogger] Ukončeno zachytávání lifecycle událostí');
  }

  private record(event: LifecycleEvent, source: 'genserver' | 'supervisor'): void {
    const entry: DebugLogEntry = {
      timestamp: Date.now(),
      event,
      source,
    };

    this.logs.push(entry);

    // Oříznout pokud překračuje max
    if (this.logs.length > this.maxEntries) {
      this.logs = this.logs.slice(-this.maxEntries);
    }

    // Vytisknout do konzole
    this.printEvent(entry);
  }

  private printEvent(entry: DebugLogEntry): void {
    const time = new Date(entry.timestamp).toISOString();
    const { event } = entry;

    let details = '';
    if (event.type === 'crashed') {
      details = ` - ${event.error.message}`;
    } else if (event.type === 'restarted') {
      details = ` - pokus #${event.attempt}`;
    } else if (event.type === 'terminated') {
      details = ` - ${event.reason.type}`;
    }

    const ref = 'ref' in event ? event.ref : null;
    const id = ref?.id ?? 'unknown';

    console.log(`[${time}] ${event.type.toUpperCase()} ${id}${details}`);
  }

  // Dotazovací metody
  getAll(): readonly DebugLogEntry[] {
    return this.logs;
  }

  getForProcess(processId: string): DebugLogEntry[] {
    return this.logs.filter((entry) => {
      const ref = 'ref' in entry.event ? entry.event.ref : null;
      return ref?.id === processId;
    });
  }

  getCrashes(): DebugLogEntry[] {
    return this.logs.filter((entry) => entry.event.type === 'crashed');
  }

  getRestarts(): DebugLogEntry[] {
    return this.logs.filter((entry) => entry.event.type === 'restarted');
  }

  getSince(timestamp: number): DebugLogEntry[] {
    return this.logs.filter((entry) => entry.timestamp >= timestamp);
  }

  clear(): void {
    this.logs = [];
  }

  // Analytické metody
  getRestartRate(windowMs: number = 60000): number {
    const cutoff = Date.now() - windowMs;
    const restarts = this.logs.filter(
      (entry) => entry.event.type === 'restarted' && entry.timestamp >= cutoff
    );
    return restarts.length / (windowMs / 1000); // restarty za sekundu
  }

  getMostUnstableProcesses(limit: number = 5): { processId: string; restarts: number }[] {
    const restartCounts = new Map<string, number>();

    for (const entry of this.logs) {
      if (entry.event.type === 'restarted') {
        const id = entry.event.ref.id;
        restartCounts.set(id, (restartCounts.get(id) ?? 0) + 1);
      }
    }

    return Array.from(restartCounts.entries())
      .map(([processId, restarts]) => ({ processId, restarts }))
      .sort((a, b) => b.restarts - a.restarts)
      .slice(0, limit);
  }
}

// Použití
const debugLogger = new DebugLogger({ maxEntries: 5000 });
debugLogger.start();

// Později: analyzovat pády
const crashes = debugLogger.getCrashes();
console.log(`Celkem pádů: ${crashes.length}`);

for (const crash of crashes.slice(-5)) {
  const event = crash.event as { type: 'crashed'; ref: { id: string }; error: Error };
  console.log(`  ${event.ref.id}: ${event.error.message}`);
}

// Najít nestabilní procesy
const unstable = debugLogger.getMostUnstableProcesses();
console.log('Nejnestabilnější procesy:');
for (const { processId, restarts } of unstable) {
  console.log(`  ${processId}: ${restarts} restartů`);
}
```

## Trasování zpráv

Pochopení toku zpráv mezi procesy je klíčové pro ladění. noex poskytuje několik přístupů pro trasování zpráv.

### Použití statistik Observeru

Každý GenServer sleduje statistiky zpráv na které se můžete dotazovat:

```typescript
import { Observer } from '@hamicek/noex';

// Získat statistiky pro všechny servery
const snapshot = Observer.getSnapshot();

for (const server of snapshot.servers) {
  console.log(`Proces: ${server.id}`);
  console.log(`  Stav: ${server.status}`);
  console.log(`  Velikost fronty: ${server.queueSize}`);
  console.log(`  Zpracované zprávy: ${server.messageCount}`);
  console.log(`  Doba běhu: ${Math.round(server.uptimeMs / 1000)}s`);
  console.log(`  Propustnost: ${(server.messageCount / (server.uptimeMs / 1000)).toFixed(2)} zpráv/s`);
}
```

### Vytvoření Message Traceru

Můžete obalit GenServer volání pro trasování toku zpráv:

```typescript
import { GenServer, type GenServerRef } from '@hamicek/noex';

interface TraceEntry {
  timestamp: number;
  direction: 'call' | 'cast' | 'reply';
  from?: string;
  to: string;
  message: unknown;
  duration?: number;
}

class MessageTracer {
  private traces: TraceEntry[] = [];
  private enabled: boolean = false;

  enable(): void {
    this.enabled = true;
    console.log('[Tracer] Trasování zpráv povoleno');
  }

  disable(): void {
    this.enabled = false;
    console.log('[Tracer] Trasování zpráv zakázáno');
  }

  // Trasované call - obaluje GenServer.call
  async call<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
    msg: CallMsg,
    options?: { timeout?: number; from?: string }
  ): Promise<CallReply> {
    if (!this.enabled) {
      return GenServer.call(ref, msg, options);
    }

    const start = Date.now();
    const fromId = options?.from ?? 'external';

    this.record({
      timestamp: start,
      direction: 'call',
      from: fromId,
      to: ref.id,
      message: msg,
    });

    try {
      const result = await GenServer.call(ref, msg, options);

      this.record({
        timestamp: Date.now(),
        direction: 'reply',
        from: ref.id,
        to: fromId,
        message: result,
        duration: Date.now() - start,
      });

      return result;
    } catch (error) {
      this.record({
        timestamp: Date.now(),
        direction: 'reply',
        from: ref.id,
        to: fromId,
        message: { error: error instanceof Error ? error.message : String(error) },
        duration: Date.now() - start,
      });
      throw error;
    }
  }

  // Trasované cast - obaluje GenServer.cast
  cast<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
    msg: CastMsg,
    options?: { from?: string }
  ): void {
    if (this.enabled) {
      this.record({
        timestamp: Date.now(),
        direction: 'cast',
        from: options?.from ?? 'external',
        to: ref.id,
        message: msg,
      });
    }

    GenServer.cast(ref, msg);
  }

  private record(entry: TraceEntry): void {
    this.traces.push(entry);
    this.printTrace(entry);
  }

  private printTrace(entry: TraceEntry): void {
    const time = new Date(entry.timestamp).toISOString().slice(11, 23);
    const arrow = entry.direction === 'reply' ? '<--' : '-->';
    const from = entry.from ?? '?';
    const duration = entry.duration ? ` (${entry.duration}ms)` : '';

    const msgStr = typeof entry.message === 'object'
      ? JSON.stringify(entry.message)
      : String(entry.message);
    const truncated = msgStr.length > 80 ? msgStr.slice(0, 77) + '...' : msgStr;

    console.log(`[${time}] ${entry.direction.toUpperCase()} ${from} ${arrow} ${entry.to}${duration}`);
    console.log(`         ${truncated}`);
  }

  getTraces(): readonly TraceEntry[] {
    return this.traces;
  }

  getTracesFor(processId: string): TraceEntry[] {
    return this.traces.filter(
      (t) => t.from === processId || t.to === processId
    );
  }

  clear(): void {
    this.traces = [];
  }
}

// Použití
const tracer = new MessageTracer();
tracer.enable();

// Použít tracer místo přímých GenServer volání
const result = await tracer.call(myServer, { type: 'get_status' }, { from: 'main' });
tracer.cast(myServer, { type: 'increment' }, { from: 'main' });
```

### Použití EventBusu pro systémové trasování

Pro trasování zpráv na úrovni aplikace použijte EventBus s wildcard odběrem:

```typescript
import { EventBus } from '@hamicek/noex';

const bus = await EventBus.start({ name: 'message_bus' });

// Přihlásit se k VŠEM zprávám pro trasování
await EventBus.subscribe(bus, '*', (message, topic) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [EventBus] ${topic}:`, message);
});

// Nyní jsou všechna publikování trasována
EventBus.publish(bus, 'user.login', { userId: '123' });
EventBus.publish(bus, 'order.created', { orderId: 'ORD-456' });
```

### Vizualizace toku zpráv

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          DIAGRAM TOKU ZPRÁV                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────┐       call(get_order)        ┌──────────┐                     │
│  │  Klient  │ ─────────────────────────────▶│  Order   │                     │
│  │          │                               │  Server  │                     │
│  │          │◀───────────────────────────── │          │                     │
│  └──────────┘      reply({id, status})     └──────────┘                     │
│       │                                          │                          │
│       │  cast(notify_user)                       │  call(get_user)          │
│       │                                          │                          │
│       ▼                                          ▼                          │
│  ┌──────────┐                              ┌──────────┐                     │
│  │  Notif.  │                              │   User   │                     │
│  │  Služba  │                              │  Server  │                     │
│  └──────────┘                              └──────────┘                     │
│       │                                                                     │
│       │  publish('email.send', {...})                                       │
│       ▼                                                                     │
│  ┌──────────┐                                                               │
│  │ EventBus │───▶ email.* odběratelé                                        │
│  └──────────┘                                                               │
│                                                                             │
│  LEGENDA:                                                                   │
│  ──────▶  call (sync, čeká na odpověď)                                      │
│  - - - ▶  cast (async, fire-and-forget)                                     │
│  ......▶  publish (one-to-many přes EventBus)                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Introspekce procesů

Při ladění často potřebujete nahlédnout dovnitř běžícího procesu. noex poskytuje několik API pro toto.

### Observer snímek

Získejte kompletní pohled na váš systém v daném časovém okamžiku:

```typescript
import { Observer } from '@hamicek/noex';

function printSystemSnapshot(): void {
  const snapshot = Observer.getSnapshot();

  console.log('=== Snímek systému ===');
  console.log(`Časové razítko: ${new Date(snapshot.timestamp).toISOString()}`);
  console.log(`Celkem procesů: ${snapshot.processCount}`);
  console.log(`Celkem zpráv: ${snapshot.totalMessages}`);
  console.log(`Celkem restartů: ${snapshot.totalRestarts}`);
  console.log();

  // Statistiky paměti
  const mem = snapshot.memoryStats;
  const formatMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  console.log('Paměť:');
  console.log(`  Heap: ${formatMB(mem.heapUsed)}MB / ${formatMB(mem.heapTotal)}MB`);
  console.log(`  RSS: ${formatMB(mem.rss)}MB`);
  console.log();

  // GenServery
  console.log('GenServery:');
  for (const server of snapshot.servers) {
    const status = server.status === 'running' ? '[OK]' : `[${server.status.toUpperCase()}]`;
    console.log(`  ${status} ${server.id}`);
    console.log(`      Fronta: ${server.queueSize}, Zprávy: ${server.messageCount}`);
  }
  console.log();

  // Supervisory
  console.log('Supervisory:');
  for (const sup of snapshot.supervisors) {
    console.log(`  ${sup.id}`);
    console.log(`      Děti: ${sup.childCount}, Restarty: ${sup.totalRestarts}`);
  }
}
```

### Vizualizace stromu procesů

Zobrazte hierarchii supervize:

```typescript
import { Observer, type ProcessTreeNode } from '@hamicek/noex';

function printProcessTree(node: ProcessTreeNode, indent: number = 0): void {
  const prefix = '  '.repeat(indent);
  const name = node.name ?? node.id;
  const type = node.type === 'supervisor' ? '[SUP]' : '[GEN]';

  let status = '';
  if (node.type === 'genserver') {
    const stats = node.stats;
    status = ` (fronta: ${stats.queueSize}, zprávy: ${stats.messageCount})`;
  } else {
    const stats = node.stats;
    status = ` (děti: ${stats.childCount}, restarty: ${stats.totalRestarts})`;
  }

  console.log(`${prefix}${type} ${name}${status}`);

  if (node.children) {
    for (const child of node.children) {
      printProcessTree(child, indent + 1);
    }
  }
}

// Vytisknout strom
const tree = Observer.getProcessTree();
console.log('=== Strom procesů ===');
for (const root of tree) {
  printProcessTree(root);
}
```

Příklad výstupu:
```
=== Strom procesů ===
[SUP] application_supervisor (děti: 3, restarty: 0)
  [SUP] database_supervisor (děti: 2, restarty: 1)
    [GEN] connection_pool (fronta: 0, zprávy: 1523)
    [GEN] query_cache (fronta: 2, zprávy: 892)
  [GEN] api_server (fronta: 5, zprávy: 4201)
  [GEN] metrics_collector (fronta: 0, zprávy: 156)
```

### Real-time monitoring procesu

Sledujte konkrétní proces v reálném čase:

```typescript
import { Observer } from '@hamicek/noex';

function watchProcess(processId: string, intervalMs: number = 1000): () => void {
  let lastMessageCount = 0;
  let lastCheck = Date.now();

  const interval = setInterval(() => {
    const servers = Observer.getServerStats();
    const server = servers.find((s) => s.id === processId);

    if (!server) {
      console.log(`Proces ${processId} nenalezen`);
      return;
    }

    const now = Date.now();
    const elapsed = (now - lastCheck) / 1000;
    const messagesDelta = server.messageCount - lastMessageCount;
    const throughput = messagesDelta / elapsed;

    console.clear();
    console.log(`=== Sledování: ${processId} ===`);
    console.log(`Stav: ${server.status}`);
    console.log(`Velikost fronty: ${server.queueSize}`);
    console.log(`Celkem zpráv: ${server.messageCount}`);
    console.log(`Propustnost: ${throughput.toFixed(1)} zpráv/s`);
    console.log(`Doba běhu: ${Math.round(server.uptimeMs / 1000)}s`);

    lastMessageCount = server.messageCount;
    lastCheck = now;
  }, intervalMs);

  return () => clearInterval(interval);
}

// Sledovat proces
const stopWatching = watchProcess('order_processor', 500);

// Přestat sledovat později
setTimeout(() => stopWatching(), 30000);
```

### Nízkoúrovňová introspekční API

Pro pokročilé ladění použijte interní API:

```typescript
import { GenServer, Supervisor } from '@hamicek/noex';

// Získat všechna ID GenServerů
const serverIds = GenServer._getAllServerIds();
console.log('ID GenServerů:', serverIds);

// Získat ref podle ID
const ref = GenServer._getRefById('my_server');
if (ref) {
  const stats = GenServer._getStats(ref);
  console.log('Statistiky:', stats);
}

// Získat ID aktuálního procesu (pouze v message handlerech)
// Užitečné pro korelaci/logování uvnitř handlerů
const behavior = {
  init: () => ({}),
  handleCall: (msg, state) => {
    const currentId = GenServer._getCurrentProcessId();
    console.log(`Zpracovávám zprávu v procesu: ${currentId}`);
    return [null, state];
  },
  handleCast: (msg, state) => state,
};

// Získat počet monitorů
const monitorCount = GenServer._getLocalMonitorCount();
console.log(`Aktivních monitorů: ${monitorCount}`);

// Introspekce Supervisoru
const supervisorIds = Supervisor._getAllSupervisorIds();
console.log('ID Supervisorů:', supervisorIds);

const supRef = Supervisor._getRefById('my_supervisor');
if (supRef) {
  const supStats = Supervisor._getStats(supRef);
  console.log('Statistiky supervisoru:', supStats);
}
```

## Běžné problémy a řešení

### Problém 1: Proces se stále restartuje (Restart Loop)

**Symptomy:**
- Proces se opakovaně restartuje
- Supervisor nakonec vzdá (MaxRestartsExceededError)
- Systém přestává reagovat

**Diagnóza:**

```typescript
import { GenServer, Supervisor } from '@hamicek/noex';

// Sledovat pokusy o restart
const restartHistory: { processId: string; timestamp: number; error?: string }[] = [];

GenServer.onLifecycleEvent((event) => {
  if (event.type === 'crashed') {
    restartHistory.push({
      processId: event.ref.id,
      timestamp: Date.now(),
      error: event.error.message,
    });
  }

  if (event.type === 'restarted') {
    console.log(`Proces ${event.ref.id} restartován (pokus ${event.attempt})`);
  }
});

Supervisor.onLifecycleEvent((event) => {
  if (event.type === 'terminated' && event.reason.type === 'error') {
    console.error('Supervisor ukončen kvůli chybě - zkontrolujte nastavení restart intensity');
  }
});

// Analyzovat vzorce restartů
function analyzeRestarts(processId: string): void {
  const history = restartHistory.filter((h) => h.processId === processId);

  if (history.length === 0) {
    console.log('Žádné restarty zaznamenány');
    return;
  }

  console.log(`Historie restartů pro ${processId}:`);
  for (const entry of history.slice(-10)) {
    const time = new Date(entry.timestamp).toISOString();
    console.log(`  ${time}: ${entry.error ?? 'neznámá chyba'}`);
  }

  // Zkontrolovat vzorce
  const errors = history.map((h) => h.error).filter(Boolean);
  const uniqueErrors = [...new Set(errors)];

  console.log(`\nUnikátní chyby (${uniqueErrors.length}):`);
  for (const error of uniqueErrors) {
    const count = errors.filter((e) => e === error).length;
    console.log(`  [${count}x] ${error}`);
  }
}
```

**Běžné příčiny:**
1. Chyba v `init()` — proces spadne před spuštěním
2. Externí závislost nedostupná — databáze, API, atd.
3. Neplatná konfigurace — chybějící env proměnné, špatné cesty
4. Vyčerpání zdrojů — file handlery, paměť, atd.

**Řešení:**

```typescript
// 1. Validovat konfiguraci před spuštěním
const ConfigValidatorBehavior = {
  init: () => {
    // Validovat že všechna požadovaná konfigurace existuje
    if (!process.env.DATABASE_URL) {
      throw new Error('Vyžadována proměnná prostředí DATABASE_URL');
    }

    // Vrátit počáteční stav pouze pokud validní
    return { configured: true };
  },
  // ...
};

// 2. Použít backoff strategii
const supervisorSpec = {
  strategy: 'one_for_one' as const,
  maxRestarts: 5,
  withinMs: 30000, // Delší okno = větší tolerance
  children: [...],
};

// 3. Přidat health checky před kritickými operacemi
const behavior = {
  init: async () => {
    // Zkontrolovat konektivitu databáze
    const dbAvailable = await checkDatabaseConnection();
    if (!dbAvailable) {
      // Logovat a zkusit znovu místo pádu
      console.warn('Databáze nedostupná, bude opakováno...');
    }
    return { dbAvailable };
  },
  // ...
};
```

### Problém 2: Fronta zpráv roste

**Symptomy:**
- Velikost fronty procesu stále roste
- Doby odezvy se zhoršují
- Nakonec systém přestává reagovat

**Diagnóza:**

```typescript
import { Observer } from '@hamicek/noex';

function findQueueBottlenecks(threshold: number = 10): void {
  const servers = Observer.getServerStats();

  const overloaded = servers.filter((s) => s.queueSize > threshold);

  if (overloaded.length === 0) {
    console.log('Žádná úzká místa front nedetekována');
    return;
  }

  console.log('Přetížené procesy:');
  for (const server of overloaded.sort((a, b) => b.queueSize - a.queueSize)) {
    const throughput = server.messageCount / (server.uptimeMs / 1000);
    console.log(`  ${server.id}:`);
    console.log(`    Fronta: ${server.queueSize}`);
    console.log(`    Propustnost: ${throughput.toFixed(1)} zpráv/s`);
  }
}

// Monitorovat růst fronty v čase
function monitorQueueGrowth(processId: string, intervalMs: number = 5000): () => void {
  const samples: { timestamp: number; queueSize: number }[] = [];

  const interval = setInterval(() => {
    const servers = Observer.getServerStats();
    const server = servers.find((s) => s.id === processId);

    if (server) {
      samples.push({ timestamp: Date.now(), queueSize: server.queueSize });

      // Ponechat posledních 100 vzorků
      if (samples.length > 100) samples.shift();

      // Vypočítat rychlost růstu
      if (samples.length >= 2) {
        const first = samples[0];
        const last = samples[samples.length - 1];
        const elapsed = (last.timestamp - first.timestamp) / 1000;
        const growth = (last.queueSize - first.queueSize) / elapsed;

        if (growth > 0) {
          console.warn(`Fronta roste: ${growth.toFixed(2)} zpráv/s`);
        }
      }
    }
  }, intervalMs);

  return () => clearInterval(interval);
}
```

**Běžné příčiny:**
1. Pomalé message handlery — drahé výpočty, blokující I/O
2. Producent rychlejší než konzument — potřeba rate limiting
3. Downstream služba pomalá — kaskádový backpressure

**Řešení:**

```typescript
// 1. Použít async operace, neblokovat
const behavior = {
  handleCall: async (msg, state) => {
    // ŠPATNĚ: Blokující výpočet
    // const result = expensiveSync();

    // SPRÁVNĚ: Odložit na další tick nebo použít worker
    const result = await computeAsync();
    return [result, state];
  },
  // ...
};

// 2. Implementovat backpressure
const behavior = {
  handleCall: (msg, state) => {
    // Zkontrolovat velikost fronty a odmítnout pokud přetíženo
    const stats = GenServer._getStats(selfRef);
    if (stats && stats.queueSize > 100) {
      return [{ error: 'overloaded', retryAfterMs: 1000 }, state];
    }

    // Zpracovat normálně
    return [processMessage(msg), state];
  },
  // ...
};

// 3. Použít worker pool pro škálování
const workerPool = await Supervisor.start({
  strategy: 'one_for_one',
  maxRestarts: 10,
  withinMs: 60000,
  children: Array.from({ length: 4 }, (_, i) => ({
    id: `worker_${i}`,
    start: () => GenServer.start(workerBehavior),
    restart: 'permanent',
  })),
});
```

### Problém 3: Úniky paměti

**Symptomy:**
- Využití heap stále roste
- GC pauzy se zvyšují
- Nakonec OOM pád

**Diagnóza:**

```typescript
import { Observer } from '@hamicek/noex';

// Sledovat paměť v čase
const memoryHistory: { timestamp: number; heapUsed: number }[] = [];

function trackMemory(): () => void {
  const interval = setInterval(() => {
    const stats = Observer.getMemoryStats();
    memoryHistory.push({
      timestamp: stats.timestamp,
      heapUsed: stats.heapUsed,
    });

    // Ponechat posledních 1000 vzorků
    if (memoryHistory.length > 1000) memoryHistory.shift();
  }, 10000);

  return () => clearInterval(interval);
}

function analyzeMemoryTrend(): void {
  if (memoryHistory.length < 10) {
    console.log('Nedostatek dat');
    return;
  }

  // Jednoduchá lineární regrese
  const n = memoryHistory.length;
  const firstHalf = memoryHistory.slice(0, n / 2);
  const secondHalf = memoryHistory.slice(n / 2);

  const avgFirst = firstHalf.reduce((sum, s) => sum + s.heapUsed, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((sum, s) => sum + s.heapUsed, 0) / secondHalf.length;

  const elapsed = (memoryHistory[n - 1].timestamp - memoryHistory[0].timestamp) / 1000;
  const growth = (avgSecond - avgFirst) / (elapsed / 2);

  const formatMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

  console.log('Analýza paměti:');
  console.log(`  Průměr první poloviny: ${formatMB(avgFirst)}MB`);
  console.log(`  Průměr druhé poloviny: ${formatMB(avgSecond)}MB`);
  console.log(`  Rychlost růstu: ${formatMB(growth)}/s`);

  if (growth > 1024 * 1024) { // > 1MB/s
    console.warn('  VAROVÁNÍ: Detekován významný růst paměti!');
  }
}

// Najít procesy s vysokou pamětí
function findHighMemoryProcesses(): void {
  const servers = Observer.getServerStats();

  const withMemory = servers
    .filter((s) => s.stateMemoryBytes !== undefined)
    .sort((a, b) => (b.stateMemoryBytes ?? 0) - (a.stateMemoryBytes ?? 0));

  console.log('Procesy podle paměti:');
  for (const server of withMemory.slice(0, 10)) {
    const mb = ((server.stateMemoryBytes ?? 0) / 1024 / 1024).toFixed(2);
    console.log(`  ${server.id}: ${mb}MB`);
  }
}
```

**Běžné příčiny:**
1. Neomezený růst stavu — pole/mapy bez čištění
2. Zadržené reference — closures zachytávající velké objekty
3. Úniky event listenerů — přihlášení bez odhlášení

**Řešení:**

```typescript
// 1. Omezit stavové kolekce
interface State {
  recentOrders: Order[];  // Omezené
  orderById: Map<string, Order>;
}

const behavior = {
  handleCast: (msg, state) => {
    if (msg.type === 'add_order') {
      const recentOrders = [...state.recentOrders, msg.order].slice(-1000); // Ponechat posledních 1000
      const orderById = new Map(state.orderById);

      // Odstranit staré záznamy pokud mapa příliš velká
      if (orderById.size > 10000) {
        const toRemove = Array.from(orderById.keys()).slice(0, 1000);
        for (const key of toRemove) {
          orderById.delete(key);
        }
      }

      orderById.set(msg.order.id, msg.order);
      return { ...state, recentOrders, orderById };
    }
    return state;
  },
  // ...
};

// 2. Uklidit v terminate
const behavior = {
  // ...
  terminate: (reason, state) => {
    // Vyčistit všechny intervaly, odběry, atd.
    state.cleanupFn?.();
    return undefined;
  },
};

// 3. Sledovat odběry
let subscriptions: (() => void)[] = [];

function cleanup(): void {
  for (const unsub of subscriptions) {
    unsub();
  }
  subscriptions = [];
}
```

### Problém 4: Deadlock / Timeout

**Symptomy:**
- call() vyprší timeout
- Systém se jeví jako zamrzlý
- Kruhové závislosti

**Diagnóza:**

```typescript
// Povolit podrobné logování timeoutů
import { GenServer } from '@hamicek/noex';

// Obalit volání detailním logováním
async function tracedCall<T>(
  ref: { id: string },
  msg: unknown,
  timeout: number = 5000
): Promise<T> {
  const start = Date.now();
  const callId = Math.random().toString(36).slice(2, 8);

  console.log(`[${callId}] CALL START: ${ref.id}`);
  console.log(`[${callId}] Zpráva: ${JSON.stringify(msg)}`);

  try {
    const result = await GenServer.call(ref as any, msg as any, { timeout });
    const elapsed = Date.now() - start;
    console.log(`[${callId}] CALL ÚSPĚCH: ${elapsed}ms`);
    return result as T;
  } catch (error) {
    const elapsed = Date.now() - start;
    console.error(`[${callId}] CALL SELHÁNÍ: ${elapsed}ms`);
    console.error(`[${callId}] Chyba: ${error instanceof Error ? error.message : error}`);
    throw error;
  }
}
```

**Běžné příčiny:**
1. A volá B, B volá A — kruhová sync závislost
2. Handler trvá příliš dlouho — drahý výpočet
3. Timeout externí služby — kaskáduje do noex timeout

**Řešení:**

```typescript
// 1. Rozbít kruhové závislosti pomocí cast
// Místo: A.call(B, msg), B.call(A, response)
// Použít: A.call(B, msg), B.cast(A, response)

// 2. Použít rozumné timeouty
const result = await GenServer.call(ref, msg, { timeout: 10000 }); // 10s pro pomalé operace

// 3. Přidat zpracování timeoutu v handlerech
const behavior = {
  handleCall: async (msg, state) => {
    try {
      const result = await Promise.race([
        fetchExternalData(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Externí timeout')), 5000)
        ),
      ]);
      return [result, state];
    } catch (error) {
      // Vrátit chybovou odpověď místo pádu
      return [{ error: 'timeout' }, state];
    }
  },
  // ...
};
```

## Rozhodovací vývojový diagram pro ladění

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                  ROZHODOVACÍ VÝVOJOVÝ DIAGRAM PRO LADĚNÍ                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  START: Něco je špatně                                                      │
│         │                                                                   │
│         ▼                                                                   │
│  ┌─────────────────┐                                                        │
│  │ Zkontrolovat    │                                                        │
│  │ lifecycle       │                                                        │
│  │ události        │                                                        │
│  └────────┬────────┘                                                        │
│           │                                                                 │
│     ┌─────┴─────┐                                                           │
│     │           │                                                           │
│     ▼           ▼                                                           │
│  Pády?      Žádné pády                                                      │
│     │           │                                                           │
│     │           ▼                                                           │
│     │    ┌─────────────────┐                                                │
│     │    │  Zkontrolovat   │                                                │
│     │    │  fronty         │                                                │
│     │    │  (Observer)     │                                                │
│     │    └────────┬────────┘                                                │
│     │             │                                                         │
│     │       ┌─────┴─────┐                                                   │
│     │       │           │                                                   │
│     │       ▼           ▼                                                   │
│     │   Rostou?     Normální                                                │
│     │       │           │                                                   │
│     │       │           ▼                                                   │
│     │       │    ┌─────────────────┐                                        │
│     │       │    │  Zkontrolovat   │                                        │
│     │       │    │  paměť          │                                        │
│     │       │    │  (Observer)     │                                        │
│     │       │    └────────┬────────┘                                        │
│     │       │             │                                                 │
│     │       │       ┌─────┴─────┐                                           │
│     │       │       │           │                                           │
│     │       │       ▼           ▼                                           │
│     │       │   Roste?      Normální                                        │
│     │       │       │           │                                           │
│     ▼       ▼       ▼           ▼                                           │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────────┐                                    │
│  │Chyba │ │Back- │ │Únik  │ │Zkontroluj│                                    │
│  │v     │ │press-│ │paměti│ │trasování │                                    │
│  │init/ │ │ure   │ │      │ │zpráv     │                                    │
│  │handler│ │problém│ │      │ │          │                                    │
│  └──────┘ └──────┘ └──────┘ └──────────┘                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Cvičení: Vytvořte Debug Dashboard

Vytvořte GenServer který poskytuje komplexní ladicí informace.

**Požadavky:**

1. Agregovat lifecycle události ze všech procesů
2. Sledovat vzorce restartů a identifikovat nestabilní procesy
3. Monitorovat velikosti front a detekovat úzká místa
4. Poskytnout API pro dotazování ladicích informací
5. Exportovat ladicí reporty

**Startovací kód:**

```typescript
import {
  GenServer,
  Supervisor,
  Observer,
  type GenServerBehavior,
  type LifecycleEvent,
} from '@hamicek/noex';

interface DebugEvent {
  timestamp: number;
  processId: string;
  type: string;
  details: Record<string, unknown>;
}

interface ProcessHealth {
  processId: string;
  status: 'healthy' | 'warning' | 'critical';
  restartCount: number;
  lastError?: string;
  avgQueueSize: number;
  messageRate: number;
}

interface DebugDashboardState {
  events: DebugEvent[];
  processHealth: Map<string, ProcessHealth>;
  queueSamples: Map<string, number[]>;
  messageCounts: Map<string, number>;
  lastSampleTime: number;
}

type DebugDashboardCall =
  | { type: 'getEvents'; limit?: number }
  | { type: 'getProcessHealth'; processId?: string }
  | { type: 'getUnstableProcesses'; restartThreshold?: number }
  | { type: 'getBottlenecks'; queueThreshold?: number }
  | { type: 'exportReport' };

type DebugDashboardCast =
  | { type: 'recordEvent'; event: DebugEvent }
  | { type: 'sampleStats' };

// TODO: Implementovat chování debug dashboardu
const DebugDashboardBehavior: GenServerBehavior<
  DebugDashboardState,
  DebugDashboardCall,
  DebugDashboardCast,
  unknown
> = {
  // ...
};

// TODO: Napojit sběr lifecycle událostí
async function startDebugDashboard() {
  // ...
}
```

<details>
<summary><strong>Řešení</strong></summary>

```typescript
import {
  GenServer,
  Supervisor,
  Observer,
  type GenServerBehavior,
  type GenServerRef,
  type LifecycleEvent,
} from '@hamicek/noex';

interface DebugEvent {
  timestamp: number;
  processId: string;
  type: string;
  details: Record<string, unknown>;
}

interface ProcessHealth {
  processId: string;
  status: 'healthy' | 'warning' | 'critical';
  restartCount: number;
  lastError?: string;
  avgQueueSize: number;
  messageRate: number;
  lastSeen: number;
}

interface DebugDashboardState {
  events: DebugEvent[];
  processHealth: Map<string, ProcessHealth>;
  queueSamples: Map<string, number[]>;
  messageCounts: Map<string, number>;
  lastSampleTime: number;
  maxEvents: number;
  maxSamples: number;
}

type DebugDashboardCall =
  | { type: 'getEvents'; limit?: number; processId?: string }
  | { type: 'getProcessHealth'; processId?: string }
  | { type: 'getUnstableProcesses'; restartThreshold?: number }
  | { type: 'getBottlenecks'; queueThreshold?: number }
  | { type: 'getStats' }
  | { type: 'exportReport' };

type DebugDashboardCast =
  | { type: 'recordLifecycleEvent'; event: LifecycleEvent }
  | { type: 'sampleStats' }
  | { type: 'cleanup' };

type DebugDashboardReply =
  | { events: DebugEvent[] }
  | { health: ProcessHealth[] }
  | { processes: { processId: string; restarts: number }[] }
  | { bottlenecks: { processId: string; avgQueue: number }[] }
  | { stats: { totalEvents: number; activeProcesses: number; totalRestarts: number } }
  | { report: string };

function calculateHealthStatus(health: ProcessHealth): 'healthy' | 'warning' | 'critical' {
  if (health.restartCount > 5 || health.avgQueueSize > 100) {
    return 'critical';
  }
  if (health.restartCount > 2 || health.avgQueueSize > 50) {
    return 'warning';
  }
  return 'healthy';
}

const DebugDashboardBehavior: GenServerBehavior<
  DebugDashboardState,
  DebugDashboardCall,
  DebugDashboardCast,
  DebugDashboardReply
> = {
  init: () => ({
    events: [],
    processHealth: new Map(),
    queueSamples: new Map(),
    messageCounts: new Map(),
    lastSampleTime: Date.now(),
    maxEvents: 10000,
    maxSamples: 100,
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'getEvents': {
        let events = state.events;

        if (msg.processId) {
          events = events.filter((e) => e.processId === msg.processId);
        }

        const limit = msg.limit ?? 100;
        events = events.slice(-limit);

        return [{ events }, state];
      }

      case 'getProcessHealth': {
        if (msg.processId) {
          const health = state.processHealth.get(msg.processId);
          return [{ health: health ? [health] : [] }, state];
        }

        return [{ health: Array.from(state.processHealth.values()) }, state];
      }

      case 'getUnstableProcesses': {
        const threshold = msg.restartThreshold ?? 3;

        const processes = Array.from(state.processHealth.values())
          .filter((h) => h.restartCount >= threshold)
          .sort((a, b) => b.restartCount - a.restartCount)
          .map((h) => ({ processId: h.processId, restarts: h.restartCount }));

        return [{ processes }, state];
      }

      case 'getBottlenecks': {
        const threshold = msg.queueThreshold ?? 10;

        const bottlenecks = Array.from(state.processHealth.values())
          .filter((h) => h.avgQueueSize >= threshold)
          .sort((a, b) => b.avgQueueSize - a.avgQueueSize)
          .map((h) => ({ processId: h.processId, avgQueue: h.avgQueueSize }));

        return [{ bottlenecks }, state];
      }

      case 'getStats': {
        const totalRestarts = Array.from(state.processHealth.values())
          .reduce((sum, h) => sum + h.restartCount, 0);

        return [{
          stats: {
            totalEvents: state.events.length,
            activeProcesses: state.processHealth.size,
            totalRestarts,
          },
        }, state];
      }

      case 'exportReport': {
        const lines: string[] = [];
        const now = new Date().toISOString();

        lines.push('='.repeat(60));
        lines.push(`LADICÍ REPORT - ${now}`);
        lines.push('='.repeat(60));
        lines.push('');

        // Souhrn
        const totalRestarts = Array.from(state.processHealth.values())
          .reduce((sum, h) => sum + h.restartCount, 0);

        lines.push('SOUHRN');
        lines.push('-'.repeat(40));
        lines.push(`Celkem událostí: ${state.events.length}`);
        lines.push(`Aktivních procesů: ${state.processHealth.size}`);
        lines.push(`Celkem restartů: ${totalRestarts}`);
        lines.push('');

        // Kritické procesy
        const critical = Array.from(state.processHealth.values())
          .filter((h) => h.status === 'critical');

        if (critical.length > 0) {
          lines.push('KRITICKÉ PROCESY');
          lines.push('-'.repeat(40));
          for (const h of critical) {
            lines.push(`  ${h.processId}:`);
            lines.push(`    Restarty: ${h.restartCount}`);
            lines.push(`    Prům. fronta: ${h.avgQueueSize.toFixed(1)}`);
            if (h.lastError) {
              lines.push(`    Poslední chyba: ${h.lastError}`);
            }
          }
          lines.push('');
        }

        // Nedávné chyby
        const recentErrors = state.events
          .filter((e) => e.type === 'crashed')
          .slice(-10);

        if (recentErrors.length > 0) {
          lines.push('NEDÁVNÉ CHYBY');
          lines.push('-'.repeat(40));
          for (const e of recentErrors) {
            const time = new Date(e.timestamp).toISOString();
            lines.push(`  [${time}] ${e.processId}`);
            if (e.details.error) {
              lines.push(`    ${e.details.error}`);
            }
          }
          lines.push('');
        }

        // Tabulka zdraví procesů
        lines.push('ZDRAVÍ PROCESŮ');
        lines.push('-'.repeat(40));
        lines.push('ID procesu'.padEnd(30) + 'Stav'.padEnd(10) + 'Restarty'.padEnd(10) + 'Fronta');

        const sorted = Array.from(state.processHealth.values())
          .sort((a, b) => {
            const statusOrder = { critical: 0, warning: 1, healthy: 2 };
            return statusOrder[a.status] - statusOrder[b.status];
          });

        for (const h of sorted) {
          const id = h.processId.slice(0, 28).padEnd(30);
          const status = h.status.toUpperCase().padEnd(10);
          const restarts = String(h.restartCount).padEnd(10);
          const queue = h.avgQueueSize.toFixed(1);
          lines.push(`${id}${status}${restarts}${queue}`);
        }

        return [{ report: lines.join('\n') }, state];
      }
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'recordLifecycleEvent': {
        const { event } = msg;
        const timestamp = Date.now();

        // Extrahovat ID procesu
        let processId = 'unknown';
        if ('ref' in event && event.ref) {
          processId = event.ref.id;
        }

        // Zaznamenat událost
        const debugEvent: DebugEvent = {
          timestamp,
          processId,
          type: event.type,
          details: {},
        };

        // Extrahovat detaily podle typu události
        if (event.type === 'crashed') {
          debugEvent.details.error = event.error.message;
          debugEvent.details.stack = event.error.stack;
        } else if (event.type === 'restarted') {
          debugEvent.details.attempt = event.attempt;
        } else if (event.type === 'terminated') {
          debugEvent.details.reason = event.reason;
        }

        // Aktualizovat seznam událostí
        let events = [...state.events, debugEvent];
        if (events.length > state.maxEvents) {
          events = events.slice(-state.maxEvents);
        }

        // Aktualizovat zdraví procesu
        const processHealth = new Map(state.processHealth);
        let health = processHealth.get(processId) ?? {
          processId,
          status: 'healthy' as const,
          restartCount: 0,
          avgQueueSize: 0,
          messageRate: 0,
          lastSeen: timestamp,
        };

        if (event.type === 'crashed') {
          health = {
            ...health,
            lastError: event.error.message,
            lastSeen: timestamp,
          };
        } else if (event.type === 'restarted') {
          health = {
            ...health,
            restartCount: health.restartCount + 1,
            lastSeen: timestamp,
          };
        }

        health.status = calculateHealthStatus(health);
        processHealth.set(processId, health);

        return { ...state, events, processHealth };
      }

      case 'sampleStats': {
        const servers = Observer.getServerStats();
        const now = Date.now();
        const elapsed = (now - state.lastSampleTime) / 1000;

        const queueSamples = new Map(state.queueSamples);
        const messageCounts = new Map(state.messageCounts);
        const processHealth = new Map(state.processHealth);

        for (const server of servers) {
          // Aktualizovat vzorky front
          const samples = queueSamples.get(server.id) ?? [];
          samples.push(server.queueSize);
          if (samples.length > state.maxSamples) {
            samples.shift();
          }
          queueSamples.set(server.id, samples);

          // Vypočítat průměrnou velikost fronty
          const avgQueue = samples.reduce((a, b) => a + b, 0) / samples.length;

          // Vypočítat rychlost zpráv
          const lastCount = messageCounts.get(server.id) ?? server.messageCount;
          const rate = elapsed > 0 ? (server.messageCount - lastCount) / elapsed : 0;
          messageCounts.set(server.id, server.messageCount);

          // Aktualizovat zdraví
          let health = processHealth.get(server.id) ?? {
            processId: server.id,
            status: 'healthy' as const,
            restartCount: 0,
            avgQueueSize: 0,
            messageRate: 0,
            lastSeen: now,
          };

          health = {
            ...health,
            avgQueueSize: avgQueue,
            messageRate: rate,
            lastSeen: now,
          };

          health.status = calculateHealthStatus(health);
          processHealth.set(server.id, health);
        }

        return {
          ...state,
          queueSamples,
          messageCounts,
          processHealth,
          lastSampleTime: now,
        };
      }

      case 'cleanup': {
        // Odstranit zastaralé procesy (neviděné 5 minut)
        const cutoff = Date.now() - 5 * 60 * 1000;
        const processHealth = new Map(state.processHealth);
        const queueSamples = new Map(state.queueSamples);
        const messageCounts = new Map(state.messageCounts);

        for (const [id, health] of processHealth) {
          if (health.lastSeen < cutoff) {
            processHealth.delete(id);
            queueSamples.delete(id);
            messageCounts.delete(id);
          }
        }

        return { ...state, processHealth, queueSamples, messageCounts };
      }
    }

    return state;
  },
};

async function startDebugDashboard(): Promise<{
  dashboard: GenServerRef;
  stop: () => void;
}> {
  const dashboard = await GenServer.start(DebugDashboardBehavior, {
    name: 'debug_dashboard',
  });

  // Přihlásit se k lifecycle událostem
  const unsubGenServer = GenServer.onLifecycleEvent((event) => {
    GenServer.cast(dashboard, { type: 'recordLifecycleEvent', event });
  });

  const unsubSupervisor = Supervisor.onLifecycleEvent((event) => {
    GenServer.cast(dashboard, { type: 'recordLifecycleEvent', event });
  });

  // Vzorkovat statistiky periodicky
  const sampleInterval = setInterval(() => {
    GenServer.cast(dashboard, { type: 'sampleStats' });
  }, 5000);

  // Čistit zastaralé procesy periodicky
  const cleanupInterval = setInterval(() => {
    GenServer.cast(dashboard, { type: 'cleanup' });
  }, 60000);

  return {
    dashboard,
    stop: () => {
      unsubGenServer();
      unsubSupervisor();
      clearInterval(sampleInterval);
      clearInterval(cleanupInterval);
    },
  };
}

// Demo použití
async function demo() {
  const { dashboard, stop } = await startDebugDashboard();

  // Získat aktuální statistiky
  const statsResult = await GenServer.call(dashboard, { type: 'getStats' });
  if ('stats' in statsResult) {
    console.log('Statistiky dashboardu:');
    console.log(`  Události: ${statsResult.stats.totalEvents}`);
    console.log(`  Procesy: ${statsResult.stats.activeProcesses}`);
    console.log(`  Restarty: ${statsResult.stats.totalRestarts}`);
  }

  // Najít nestabilní procesy
  const unstableResult = await GenServer.call(dashboard, {
    type: 'getUnstableProcesses',
    restartThreshold: 2,
  });
  if ('processes' in unstableResult && unstableResult.processes.length > 0) {
    console.log('\nNestabilní procesy:');
    for (const p of unstableResult.processes) {
      console.log(`  ${p.processId}: ${p.restarts} restartů`);
    }
  }

  // Najít úzká místa
  const bottlenecksResult = await GenServer.call(dashboard, {
    type: 'getBottlenecks',
    queueThreshold: 5,
  });
  if ('bottlenecks' in bottlenecksResult && bottlenecksResult.bottlenecks.length > 0) {
    console.log('\nÚzká místa front:');
    for (const b of bottlenecksResult.bottlenecks) {
      console.log(`  ${b.processId}: prům. fronta ${b.avgQueue.toFixed(1)}`);
    }
  }

  // Exportovat plný report
  const reportResult = await GenServer.call(dashboard, { type: 'exportReport' });
  if ('report' in reportResult) {
    console.log('\n' + reportResult.report);
  }

  // Úklid
  stop();
  await GenServer.stop(dashboard);
}
```

**Klíčové vlastnosti řešení:**

1. **Agregace událostí**: Zachytává všechny lifecycle události s detaily
2. **Sledování zdraví**: Počítá stav zdraví na základě restartů a velikostí front
3. **Monitoring front**: Vzorkuje velikosti front a počítá průměry
4. **Výpočet propustnosti**: Sleduje rychlosti zpráv per proces
5. **Dotazovací API**: Více způsobů jak se dotazovat na ladicí informace
6. **Export reportu**: Lidsky čitelný souhrnný report

</details>

## Shrnutí

**Klíčové poznatky:**

- **Lifecycle události** jsou váš primární ladicí nástroj — říkají vám přesně co se děje
- **Trasování zpráv** pomáhá pochopit komunikační vzorce a úzká místa
- **Introspekce procesů** přes Observer poskytuje real-time viditelnost
- **Běžné problémy** (restart smyčky, růst fronty, úniky paměti, deadlocky) mají systematická řešení
- **Vlastní ladicí nástroje** lze vytvořit pomocí noex primitiv

**Ladicí toolkit na první pohled:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          LADICÍ TOOLKIT                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  LIFECYCLE UDÁLOSTI                                                         │
│  ─────────────────────────────────────────────────────────────────────────  │
│  GenServer.onLifecycleEvent()   Sledovat GenServer události                 │
│  Supervisor.onLifecycleEvent()  Sledovat Supervisor události                │
│                                                                             │
│  OBSERVER                                                                   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Observer.getSnapshot()         Kompletní stav systému                      │
│  Observer.getServerStats()      Statistiky GenServerů                       │
│  Observer.getProcessTree()      Hierarchie supervize                        │
│  Observer.getMemoryStats()      Využití paměti                              │
│                                                                             │
│  NÍZKOÚROVŇOVÁ API                                                          │
│  ─────────────────────────────────────────────────────────────────────────  │
│  GenServer._getStats(ref)       Statistiky pro konkrétní server             │
│  GenServer._getRefById(id)      Lookup podle ID                             │
│  GenServer._getCurrentProcessId() Kontext aktuálního handleru               │
│                                                                             │
│  TRASOVÁNÍ ZPRÁV                                                            │
│  ─────────────────────────────────────────────────────────────────────────  │
│  EventBus s '*' odběrem         Trasovat všechny události                   │
│  Vlastní call/cast wrappery     Trasovat jednotlivé zprávy                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Při ladění:**

| Symptom | Co nejdřív zkontrolovat | Nástroj |
|---------|-------------------------|---------|
| Proces padá | Lifecycle události | `GenServer.onLifecycleEvent()` |
| Systém pomalý | Velikosti front | `Observer.getServerStats()` |
| Vysoká paměť | Statistiky paměti | `Observer.getMemoryStats()` |
| Chyby timeout | Tok zpráv | Message tracer |
| Chybějící zprávy | Strom procesů | `Observer.getProcessTree()` |

**Pamatujte:**

> Nejlepší ladicí nástroj je prevence: používejte supervizi, zpracovávejte chyby elegantně a monitorujte váš systém od prvního dne. Když problémy nastanou, lifecycle události a Observer vám dají viditelnost potřebnou pro rychlou diagnózu a opravu problémů.

---

Další: [Základy clusteringu](../11-distribuce/01-zaklady-clusteringu.md)
