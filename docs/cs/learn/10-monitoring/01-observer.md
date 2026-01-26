# Observer

V předchozích kapitolách jste se naučili vytvářet produkční aplikace s konfigurací, logováním a health checky. Nyní je čas prozkoumat **Observer** — vestavěný modul pro introspekci procesů, který vám dává real-time viditelnost do vnitřního stavu vaší noex aplikace.

## Co se naučíte

- Dotazovat se na runtime statistiky všech GenServerů a Supervisorů
- Vytvářet kompletní hierarchie stromů procesů
- Přihlásit se k odběru real-time lifecycle událostí
- Pollovat pro pravidelné aktualizace statistik
- Exportovat data pro externí monitorovací systémy
- Zastavovat procesy programaticky pro administrativní úlohy

## Introspekce procesů

Observer poskytuje jednotné API pro inspekci runtime stavu všech noex procesů. Představte si ho jako okno do vnitřku vaší aplikace — můžete vidět každý běžící proces, jeho statistiky, propustnost zpráv a využití paměti.

### Systémový snímek

Metoda `getSnapshot()` vrací kompletní pohled na váš systém v daném časovém okamžiku:

```typescript
import { Observer } from '@hamicek/noex';

const snapshot = Observer.getSnapshot();

console.log(`Časové razítko: ${new Date(snapshot.timestamp).toISOString()}`);
console.log(`Celkem procesů: ${snapshot.processCount}`);
console.log(`GenServerů: ${snapshot.servers.length}`);
console.log(`Supervisorů: ${snapshot.supervisors.length}`);
console.log(`Celkem zpracovaných zpráv: ${snapshot.totalMessages}`);
console.log(`Celkem restartů: ${snapshot.totalRestarts}`);
```

Snímek obsahuje:

| Vlastnost | Typ | Popis |
|----------|------|-------|
| `timestamp` | `number` | Unix timestamp kdy byl snímek pořízen |
| `servers` | `GenServerStats[]` | Statistiky všech GenServerů |
| `supervisors` | `SupervisorStats[]` | Statistiky všech Supervisorů |
| `tree` | `ProcessTreeNode[]` | Hierarchický strom procesů |
| `processCount` | `number` | Celkový počet běžících procesů |
| `totalMessages` | `number` | Součet všech zpracovaných zpráv |
| `totalRestarts` | `number` | Součet všech restartů supervisorů |
| `memoryStats` | `MemoryStats` | Statistiky paměti Node.js |

### Statistiky GenServeru

Každý GenServer vystavuje detailní runtime statistiky:

```typescript
const servers = Observer.getServerStats();

for (const server of servers) {
  console.log(`Server: ${server.id}`);
  console.log(`  Stav: ${server.status}`);
  console.log(`  Velikost fronty: ${server.queueSize}`);
  console.log(`  Zpracované zprávy: ${server.messageCount}`);
  console.log(`  Doba běhu: ${Math.round(server.uptimeMs / 1000)}s`);
  console.log(`  Spuštěn v: ${new Date(server.startedAt).toISOString()}`);

  if (server.stateMemoryBytes) {
    console.log(`  Paměť stavu: ${Math.round(server.stateMemoryBytes / 1024)}KB`);
  }
}
```

**Pole GenServerStats:**

```typescript
interface GenServerStats {
  readonly id: string;              // Unikátní identifikátor
  readonly status: ServerStatus;    // 'running' | 'stopping' | 'stopped'
  readonly queueSize: number;       // Zprávy čekající ve frontě
  readonly messageCount: number;    // Celkem zpracovaných zpráv
  readonly startedAt: number;       // Unix timestamp
  readonly uptimeMs: number;        // Čas od spuštění
  readonly stateMemoryBytes?: number; // Odhadovaná paměť stavu
}
```

### Statistiky Supervisoru

Supervisory vystavují svou restart strategii a data správy dětí:

```typescript
const supervisors = Observer.getSupervisorStats();

for (const sup of supervisors) {
  console.log(`Supervisor: ${sup.id}`);
  console.log(`  Strategie: ${sup.strategy}`);
  console.log(`  Děti: ${sup.childCount}`);
  console.log(`  Celkem restartů: ${sup.totalRestarts}`);
  console.log(`  Doba běhu: ${Math.round(sup.uptimeMs / 1000)}s`);
}
```

**Pole SupervisorStats:**

```typescript
interface SupervisorStats {
  readonly id: string;                 // Unikátní identifikátor
  readonly strategy: SupervisorStrategy; // 'one_for_one' | 'one_for_all' | 'rest_for_one'
  readonly childCount: number;         // Počet spravovaných dětí
  readonly totalRestarts: number;      // Celkový počet restartů dětí
  readonly startedAt: number;          // Unix timestamp
  readonly uptimeMs: number;           // Čas od spuštění
}
```

### Strom procesů

Strom procesů zobrazuje hierarchii supervize — které supervisory spravují které procesy:

```typescript
const tree = Observer.getProcessTree();

function printTree(nodes: readonly ProcessTreeNode[], indent = 0): void {
  const prefix = '  '.repeat(indent);

  for (const node of nodes) {
    const type = node.type === 'supervisor' ? '[SUP]' : '[GEN]';
    const name = node.name ?? node.id;
    console.log(`${prefix}${type} ${name}`);

    if (node.type === 'supervisor') {
      const stats = node.stats as SupervisorStats;
      console.log(`${prefix}  Strategie: ${stats.strategy}, Restarty: ${stats.totalRestarts}`);
    } else {
      const stats = node.stats as GenServerStats;
      console.log(`${prefix}  Fronta: ${stats.queueSize}, Zprávy: ${stats.messageCount}`);
    }

    if (node.children) {
      printTree(node.children, indent + 1);
    }
  }
}

printTree(tree);
```

Příklad výstupu:

```
[SUP] app_supervisor
  Strategie: rest_for_one, Restarty: 2
  [GEN] database_pool
    Fronta: 0, Zprávy: 15234
  [GEN] cache_service
    Fronta: 3, Zprávy: 8921
  [SUP] worker_supervisor
    Strategie: one_for_one, Restarty: 5
    [GEN] worker_1
      Fronta: 12, Zprávy: 3456
    [GEN] worker_2
      Fronta: 8, Zprávy: 3201
[GEN] logger
  Fronta: 0, Zprávy: 52341
```

**Struktura ProcessTreeNode:**

```typescript
interface ProcessTreeNode {
  readonly type: 'genserver' | 'supervisor';
  readonly id: string;
  readonly name?: string;              // Název v Registry pokud je registrován
  readonly stats: GenServerStats | SupervisorStats;
  readonly children?: readonly ProcessTreeNode[]; // Pouze pro supervisory
}
```

### Statistiky paměti

Observer poskytuje metriky paměti Node.js:

```typescript
const memory = Observer.getMemoryStats();

console.log(`Heap použitý: ${Math.round(memory.heapUsed / 1024 / 1024)}MB`);
console.log(`Heap celkem: ${Math.round(memory.heapTotal / 1024 / 1024)}MB`);
console.log(`RSS: ${Math.round(memory.rss / 1024 / 1024)}MB`);
console.log(`Externí: ${Math.round(memory.external / 1024 / 1024)}MB`);
```

**Pole MemoryStats:**

```typescript
interface MemoryStats {
  readonly heapUsed: number;   // V8 heap v použití (bajty)
  readonly heapTotal: number;  // Celkový alokovaný V8 heap (bajty)
  readonly external: number;   // C++ objekty navázané na JS (bajty)
  readonly rss: number;        // Resident Set Size (bajty)
  readonly timestamp: number;  // Kdy byly statistiky pořízeny
}
```

### Rychlý počet procesů

Pro lehké kontroly použijte `getProcessCount()`:

```typescript
const count = Observer.getProcessCount();
console.log(`${count} procesů běží`);
```

## Real-time statistiky s pollováním

Pro dashboardy a monitoring často potřebujete periodické aktualizace. Observer pro to poskytuje `startPolling()`:

```typescript
import { Observer } from '@hamicek/noex';

// Začít pollovat každou sekundu
const stopPolling = Observer.startPolling(1000, (event) => {
  if (event.type === 'stats_update') {
    const totalMessages = event.servers.reduce((sum, s) => sum + s.messageCount, 0);
    const totalQueue = event.servers.reduce((sum, s) => sum + s.queueSize, 0);

    console.log(`[${new Date().toISOString()}]`);
    console.log(`  Servery: ${event.servers.length}`);
    console.log(`  Supervisory: ${event.supervisors.length}`);
    console.log(`  Zprávy: ${totalMessages}`);
    console.log(`  Hloubka fronty: ${totalQueue}`);
  }
});

// Později: zastavit pollování
stopPolling();
```

**Chování pollování:**

1. Okamžitě vyšle první aktualizaci při spuštění
2. Vyšle `stats_update` události ve specifikovaném intervalu
3. Automaticky spustí kontroly alertů přes AlertManager
4. Vrací funkci pro zastavení pollování

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ČASOVÁ OSA POLLOVÁNÍ                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  startPolling(1000, handler)                                                │
│         │                                                                   │
│         ▼                                                                   │
│  ┌──────────────┐  1s   ┌──────────────┐  1s   ┌──────────────┐            │
│  │ stats_update │ ────► │ stats_update │ ────► │ stats_update │ ──► ...   │
│  │  (okamžitě)  │       │              │       │              │            │
│  └──────────────┘       └──────────────┘       └──────────────┘            │
│         │                      │                      │                     │
│         ▼                      ▼                      ▼                     │
│  ┌──────────────┐       ┌──────────────┐       ┌──────────────┐            │
│  │ AlertManager │       │ AlertManager │       │ AlertManager │            │
│  │   .check()   │       │   .check()   │       │   .check()   │            │
│  └──────────────┘       └──────────────┘       └──────────────┘            │
│                                                                             │
│  stopPolling()                                                              │
│         │                                                                   │
│         ▼                                                                   │
│  ┌──────────────┐                                                          │
│  │  (zastaveno) │                                                          │
│  └──────────────┘                                                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Streaming událostí

Pro real-time notifikace o změnách lifecycle procesů použijte `subscribe()`:

```typescript
import { Observer, type ObserverEvent } from '@hamicek/noex';

const unsubscribe = Observer.subscribe((event: ObserverEvent) => {
  switch (event.type) {
    case 'server_started':
      console.log(`GenServer spuštěn: ${event.stats.id}`);
      break;

    case 'server_stopped':
      console.log(`GenServer zastaven: ${event.id}, důvod: ${event.reason}`);
      break;

    case 'supervisor_started':
      console.log(`Supervisor spuštěn: ${event.stats.id}`);
      console.log(`  Strategie: ${event.stats.strategy}`);
      break;

    case 'supervisor_stopped':
      console.log(`Supervisor zastaven: ${event.id}`);
      break;

    case 'stats_update':
      // Vysláno pomocí startPolling()
      console.log(`Aktualizace statistik: ${event.servers.length} serverů`);
      break;
  }
});

// Později: odhlásit odběr
unsubscribe();
```

**Typy ObserverEvent:**

```typescript
type ObserverEvent =
  | { type: 'server_started'; stats: GenServerStats }
  | { type: 'server_stopped'; id: string; reason: TerminateReason }
  | { type: 'supervisor_started'; stats: SupervisorStats }
  | { type: 'supervisor_stopped'; id: string }
  | { type: 'stats_update'; servers: readonly GenServerStats[]; supervisors: readonly SupervisorStats[] };
```

### Kombinace Subscribe s Pollováním

Můžete používat odběr i pollování společně:

```typescript
// Odběr pro okamžité lifecycle události
const unsubscribe = Observer.subscribe((event) => {
  if (event.type === 'server_started') {
    console.log(`Nový server: ${event.stats.id}`);
  }
  if (event.type === 'server_stopped') {
    console.log(`Server zastaven: ${event.id}`);
  }
});

// Pollování pro periodické agregované statistiky
const stopPolling = Observer.startPolling(5000, (event) => {
  if (event.type === 'stats_update') {
    // Aktualizovat metriky dashboardu
  }
});

// Úklid
function cleanup() {
  unsubscribe();
  stopPolling();
}
```

## Zastavování procesů

Observer může zastavit procesy programaticky — užitečné pro admin rozhraní nebo automatickou nápravu:

```typescript
const result = await Observer.stopProcess('genserver_1_abc123', 'Manuální vypnutí');

if (result.success) {
  console.log('Proces úspěšně zastaven');
} else {
  console.error(`Nepodařilo se zastavit proces: ${result.error}`);
}
```

Metoda:

1. Vyhledá proces podle ID (GenServer nebo Supervisor)
2. Zahájí graceful shutdown
3. Pro Supervisory nejprve zastaví všechny podřízené procesy
4. Vrací úspěch/neúspěch s volitelnou chybovou zprávou

## Export dat

Pro integraci s externími monitorovacími systémy může Observer připravit data pro export:

```typescript
import { Observer, exportToJson, exportToCsv } from '@hamicek/noex/observer';

// Připravit exportní data
const exportData = Observer.prepareExportData();

// Export jako JSON
const jsonString = exportToJson(exportData);
fs.writeFileSync('snapshot.json', jsonString);

// Export jako CSV (vrací více CSV pro různé typy dat)
const csvExport = exportToCsv(exportData);
fs.writeFileSync('servers.csv', csvExport.servers);
fs.writeFileSync('supervisors.csv', csvExport.supervisors);
```

## Praktický příklad: Monitorovací služba

Zde je kompletní monitorovací služba kombinující funkce Observeru:

```typescript
import {
  GenServer,
  Observer,
  type GenServerBehavior,
  type GenServerRef,
  type ObserverEvent,
} from '@hamicek/noex';

interface MonitorState {
  lastSnapshot: ReturnType<typeof Observer.getSnapshot> | null;
  messageRatePerSecond: number;
  lastMessageCount: number;
  lastCheckTime: number;
  alerts: string[];
}

type MonitorCall =
  | { type: 'getStatus' }
  | { type: 'getAlerts' }
  | { type: 'clearAlerts' };

type MonitorCast =
  | { type: 'checkHealth' };

type MonitorReply =
  | { status: 'healthy' | 'degraded' | 'critical'; details: Record<string, unknown> }
  | { alerts: string[] }
  | { cleared: number };

const MonitorBehavior: GenServerBehavior<MonitorState, MonitorCall, MonitorCast, MonitorReply> = {
  init: () => ({
    lastSnapshot: null,
    messageRatePerSecond: 0,
    lastMessageCount: 0,
    lastCheckTime: Date.now(),
    alerts: [],
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'getStatus': {
        const snapshot = Observer.getSnapshot();
        const memory = snapshot.memoryStats;
        const heapPercent = (memory.heapUsed / memory.heapTotal) * 100;

        // Určit stav zdraví
        let status: 'healthy' | 'degraded' | 'critical' = 'healthy';

        if (heapPercent > 90 || snapshot.totalRestarts > 50) {
          status = 'critical';
        } else if (heapPercent > 75 || snapshot.totalRestarts > 20) {
          status = 'degraded';
        }

        return [
          {
            status,
            details: {
              processCount: snapshot.processCount,
              totalMessages: snapshot.totalMessages,
              totalRestarts: snapshot.totalRestarts,
              messageRatePerSecond: state.messageRatePerSecond,
              heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
              heapPercent: Math.round(heapPercent),
              alertCount: state.alerts.length,
            },
          },
          { ...state, lastSnapshot: snapshot },
        ];
      }

      case 'getAlerts':
        return [{ alerts: state.alerts }, state];

      case 'clearAlerts': {
        const count = state.alerts.length;
        return [{ cleared: count }, { ...state, alerts: [] }];
      }
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'checkHealth') {
      const snapshot = Observer.getSnapshot();
      const now = Date.now();
      const elapsed = (now - state.lastCheckTime) / 1000;

      // Vypočítat rychlost zpráv
      const messageRate = elapsed > 0
        ? (snapshot.totalMessages - state.lastMessageCount) / elapsed
        : 0;

      // Zkontrolovat problémy a generovat alerty
      const newAlerts: string[] = [];

      // Kontrola hloubek front
      for (const server of snapshot.servers) {
        if (server.queueSize > 100) {
          newAlerts.push(
            `Vysoká hloubka fronty na ${server.id}: ${server.queueSize} zpráv`
          );
        }
      }

      // Kontrola paměti
      const heapPercent = (snapshot.memoryStats.heapUsed / snapshot.memoryStats.heapTotal) * 100;
      if (heapPercent > 85) {
        newAlerts.push(`Vysoké využití paměti: ${Math.round(heapPercent)}%`);
      }

      // Kontrola míry restartů
      if (state.lastSnapshot && snapshot.totalRestarts - state.lastSnapshot.totalRestarts > 5) {
        newAlerts.push(
          `Vysoká míra restartů: ${snapshot.totalRestarts - state.lastSnapshot.totalRestarts} restartů v kontrolním intervalu`
        );
      }

      return {
        ...state,
        lastSnapshot: snapshot,
        messageRatePerSecond: messageRate,
        lastMessageCount: snapshot.totalMessages,
        lastCheckTime: now,
        alerts: [...state.alerts, ...newAlerts].slice(-100), // Ponechat posledních 100 alertů
      };
    }

    return state;
  },
};

// Použití
async function startMonitoring(): Promise<{
  monitor: GenServerRef;
  stopPolling: () => void;
  unsubscribe: () => void;
}> {
  const monitor = await GenServer.start(MonitorBehavior, { name: 'monitor' });

  // Periodické zdravotní kontroly
  const stopPolling = Observer.startPolling(5000, () => {
    GenServer.cast(monitor, { type: 'checkHealth' });
  });

  // Logovat lifecycle události
  const unsubscribe = Observer.subscribe((event) => {
    if (event.type === 'server_stopped') {
      console.log(`[Monitor] Server zastaven: ${event.id}, důvod: ${event.reason}`);
    }
  });

  return { monitor, stopPolling, unsubscribe };
}

// Dotaz na monitor
async function getSystemStatus(monitor: GenServerRef) {
  const status = await GenServer.call(monitor, { type: 'getStatus' });

  console.log(`Stav systému: ${status.status}`);
  console.log(`  Procesy: ${status.details.processCount}`);
  console.log(`  Rychlost zpráv: ${status.details.messageRatePerSecond}/s`);
  console.log(`  Heap: ${status.details.heapUsedMB}MB (${status.details.heapPercent}%)`);
  console.log(`  Aktivní alerty: ${status.details.alertCount}`);

  return status;
}
```

## Cvičení: Dashboard procesů

Vytvořte terminálový dashboard, který zobrazuje real-time informace o procesech.

**Požadavky:**

1. Zobrazit strom procesů s živými statistikami
2. Ukázat propustnost zpráv (zprávy/sekundu)
3. Zvýraznit procesy s vysokou hloubkou fronty (> 50)
4. Sledovat a zobrazovat restart události
5. Obnovovat každé 2 sekundy

**Startovací kód:**

```typescript
import {
  Observer,
  GenServer,
  Supervisor,
  type ProcessTreeNode,
  type GenServerStats,
  type SupervisorStats,
  type ObserverEvent,
} from '@hamicek/noex';

interface DashboardState {
  previousTotalMessages: number;
  messageRate: number;
  recentRestarts: Array<{ time: number; processId: string }>;
}

// TODO: Inicializovat stav dashboardu
let state: DashboardState = {
  // ...
};

// TODO: Implementovat funkci vykreslování stromu
function renderTree(nodes: readonly ProcessTreeNode[], indent: number): void {
  // Vytisknout každý uzel se statistikami
  // Zvýraznit vysokou hloubku fronty
}

// TODO: Implementovat funkci aktualizace dashboardu
function updateDashboard(event: ObserverEvent): void {
  // Vyčistit konzoli
  // Vypočítat rychlost zpráv
  // Vykreslit hlavičku
  // Vykreslit strom procesů
  // Vykreslit poslední restarty
}

// TODO: Přihlásit se k lifecycle událostem pro sledování restartů
const unsubscribe = Observer.subscribe((event) => {
  // Sledovat restarty
});

// TODO: Začít pollovat pro periodické aktualizace
const stopPolling = Observer.startPolling(2000, updateDashboard);

// TODO: Zpracovat úklid při ukončení
process.on('SIGINT', () => {
  unsubscribe();
  stopPolling();
  process.exit(0);
});
```

<details>
<summary><strong>Řešení</strong></summary>

```typescript
import {
  Observer,
  GenServer,
  Supervisor,
  type ProcessTreeNode,
  type GenServerStats,
  type SupervisorStats,
  type ObserverEvent,
} from '@hamicek/noex';

// ANSI escape kódy pro barvy
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

interface DashboardState {
  previousTotalMessages: number;
  previousTimestamp: number;
  messageRate: number;
  recentRestarts: Array<{ time: number; processId: string; reason?: string }>;
}

let state: DashboardState = {
  previousTotalMessages: 0,
  previousTimestamp: Date.now(),
  messageRate: 0,
  recentRestarts: [],
};

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

function renderTree(nodes: readonly ProcessTreeNode[], indent = 0): void {
  const prefix = '  '.repeat(indent);

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const linePrefix = indent > 0 ? (isLast ? '└─ ' : '├─ ') : '';

    if (node.type === 'supervisor') {
      const stats = node.stats as SupervisorStats;
      const name = node.name ?? node.id.slice(0, 20);
      const restartColor = stats.totalRestarts > 10 ? RED : stats.totalRestarts > 0 ? YELLOW : GREEN;

      console.log(
        `${prefix}${linePrefix}${BLUE}[SUP]${RESET} ${BOLD}${name}${RESET} ` +
        `${DIM}strategie:${RESET}${stats.strategy} ` +
        `${DIM}děti:${RESET}${stats.childCount} ` +
        `${DIM}restarty:${RESET}${restartColor}${stats.totalRestarts}${RESET} ` +
        `${DIM}běží:${RESET}${formatUptime(stats.uptimeMs)}`
      );

      if (node.children && node.children.length > 0) {
        renderTree(node.children, indent + 1);
      }
    } else {
      const stats = node.stats as GenServerStats;
      const name = node.name ?? node.id.slice(0, 20);
      const queueColor = stats.queueSize > 100 ? RED : stats.queueSize > 50 ? YELLOW : GREEN;
      const highlight = stats.queueSize > 50 ? BOLD : '';

      console.log(
        `${prefix}${linePrefix}${CYAN}[GEN]${RESET} ${highlight}${name}${RESET} ` +
        `${DIM}fronta:${RESET}${queueColor}${stats.queueSize}${RESET} ` +
        `${DIM}zprávy:${RESET}${stats.messageCount} ` +
        `${DIM}běží:${RESET}${formatUptime(stats.uptimeMs)}` +
        (stats.stateMemoryBytes ? ` ${DIM}paměť:${RESET}${formatBytes(stats.stateMemoryBytes)}` : '')
      );
    }
  }
}

function updateDashboard(event: ObserverEvent): void {
  if (event.type !== 'stats_update') return;

  // Vyčistit konzoli
  console.clear();

  const snapshot = Observer.getSnapshot();
  const now = Date.now();

  // Vypočítat rychlost zpráv
  const elapsed = (now - state.previousTimestamp) / 1000;
  if (elapsed > 0) {
    state.messageRate = (snapshot.totalMessages - state.previousTotalMessages) / elapsed;
  }
  state.previousTotalMessages = snapshot.totalMessages;
  state.previousTimestamp = now;

  // Hlavička
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}                    NOEX DASHBOARD PROCESŮ                      ${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log();

  // Souhrn statistik
  const memory = snapshot.memoryStats;
  const heapPercent = Math.round((memory.heapUsed / memory.heapTotal) * 100);
  const heapColor = heapPercent > 80 ? RED : heapPercent > 60 ? YELLOW : GREEN;

  console.log(`${BOLD}Přehled systému${RESET}`);
  console.log(`  Procesy:      ${snapshot.processCount} (${snapshot.servers.length} GenServerů, ${snapshot.supervisors.length} Supervisorů)`);
  console.log(`  Zprávy:       ${snapshot.totalMessages} celkem (${GREEN}${state.messageRate.toFixed(1)}/s${RESET})`);
  console.log(`  Restarty:     ${snapshot.totalRestarts > 0 ? YELLOW : GREEN}${snapshot.totalRestarts}${RESET}`);
  console.log(`  Heap:         ${heapColor}${formatBytes(memory.heapUsed)}${RESET} / ${formatBytes(memory.heapTotal)} (${heapPercent}%)`);
  console.log(`  RSS:          ${formatBytes(memory.rss)}`);
  console.log();

  // Strom procesů
  console.log(`${BOLD}Strom procesů${RESET}`);
  if (snapshot.tree.length === 0) {
    console.log(`  ${DIM}(žádné procesy)${RESET}`);
  } else {
    renderTree(snapshot.tree);
  }
  console.log();

  // Varování vysoké fronty
  const highQueueProcesses = snapshot.servers.filter(s => s.queueSize > 50);
  if (highQueueProcesses.length > 0) {
    console.log(`${BOLD}${YELLOW}⚠ Vysoká hloubka fronty${RESET}`);
    for (const server of highQueueProcesses) {
      const color = server.queueSize > 100 ? RED : YELLOW;
      console.log(`  ${color}${server.id}: ${server.queueSize} zpráv${RESET}`);
    }
    console.log();
  }

  // Poslední restarty
  if (state.recentRestarts.length > 0) {
    console.log(`${BOLD}Poslední restarty${RESET}`);
    const recentEvents = state.recentRestarts.slice(-5);
    for (const restart of recentEvents) {
      const ago = Math.round((now - restart.time) / 1000);
      console.log(`  ${YELLOW}${restart.processId}${RESET} - před ${ago}s${restart.reason ? ` (${restart.reason})` : ''}`);
    }
    console.log();
  }

  // Patička
  console.log(`${DIM}Poslední aktualizace: ${new Date(snapshot.timestamp).toISOString()} | Stiskněte Ctrl+C pro ukončení${RESET}`);
}

// Přihlásit se k lifecycle událostem pro sledování restartů
const unsubscribe = Observer.subscribe((event) => {
  if (event.type === 'server_stopped') {
    // Sledovat potenciální restarty (servery zastavené abnormálně se mohou restartovat)
    const reason = typeof event.reason === 'string' ? event.reason : 'error';
    if (reason !== 'normal' && reason !== 'shutdown') {
      state.recentRestarts.push({
        time: Date.now(),
        processId: event.id,
        reason,
      });
      // Ponechat pouze posledních 20 restartů
      state.recentRestarts = state.recentRestarts.slice(-20);
    }
  }
});

// Začít pollovat pro periodické aktualizace
const stopPolling = Observer.startPolling(2000, updateDashboard);

// Zpracovat úklid při ukončení
process.on('SIGINT', () => {
  console.log('\nUkončování dashboardu...');
  unsubscribe();
  stopPolling();
  process.exit(0);
});

console.log('Spouštění dashboardu... (Ctrl+C pro ukončení)');
```

**Příklad výstupu:**

```
═══════════════════════════════════════════════════════════════
                    NOEX DASHBOARD PROCESŮ
═══════════════════════════════════════════════════════════════

Přehled systému
  Procesy:      8 (6 GenServerů, 2 Supervisorů)
  Zprávy:       15234 celkem (127.3/s)
  Restarty:     3
  Heap:         45MB / 128MB (35%)
  RSS:          82MB

Strom procesů
[SUP] app_supervisor strategie:rest_for_one děti:4 restarty:2 běží:5m 23s
  ├─ [GEN] database_pool fronta:0 zprávy:5234 běží:5m 22s paměť:2MB
  ├─ [GEN] cache_service fronta:3 zprávy:3421 běží:5m 22s paměť:512KB
  └─ [SUP] worker_supervisor strategie:one_for_one děti:2 restarty:1 běží:5m 21s
      ├─ [GEN] worker_1 fronta:12 zprávy:3456 běží:2m 15s
      └─ [GEN] worker_2 fronta:8 zprávy:3123 běží:5m 20s
[GEN] logger fronta:0 zprávy:0 běží:5m 23s

⚠ Vysoká hloubka fronty
  worker_1: 67 zpráv

Poslední restarty
  worker_1 - před 180s (error)

Poslední aktualizace: 2024-01-25T12:00:00.000Z | Stiskněte Ctrl+C pro ukončení
```

</details>

## Shrnutí

**Klíčové poznatky:**

- **Observer.getSnapshot()** vrací kompletní pohled na systém v daném čase
- **Observer.getServerStats()** a **getSupervisorStats()** poskytují detailní metriky procesů
- **Observer.getProcessTree()** zobrazuje hierarchii supervize
- **Observer.subscribe()** streamuje real-time lifecycle události
- **Observer.startPolling()** poskytuje periodické aktualizace statistik s automatickou kontrolou alertů
- **Observer.stopProcess()** umožňuje programatické řízení procesů

**Přehled Observer API:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PŘEHLED OBSERVER API                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  INTROSPEKCE                                                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│  getSnapshot()        → Kompletní snímek systému                            │
│  getServerStats()     → Statistiky všech GenServerů                         │
│  getSupervisorStats() → Statistiky všech Supervisorů                        │
│  getProcessTree()     → Hierarchický strom procesů                          │
│  getProcessCount()    → Rychlý počet procesů                                │
│  getMemoryStats()     → Metriky paměti Node.js                              │
│                                                                             │
│  REAL-TIME MONITORING                                                       │
│  ─────────────────────────────────────────────────────────────────────────  │
│  subscribe(handler)           → Streamovat lifecycle události               │
│  startPolling(ms, handler)    → Periodické aktualizace statistik            │
│                                                                             │
│  ALERTY (přes AlertManager)                                                 │
│  ─────────────────────────────────────────────────────────────────────────  │
│  subscribeToAlerts(handler)   → Streamovat události alertů                  │
│  getActiveAlerts()            → Aktuální aktivní alerty                     │
│                                                                             │
│  ADMINISTRACE                                                               │
│  ─────────────────────────────────────────────────────────────────────────  │
│  stopProcess(id, reason)      → Gracefully zastavit proces                  │
│  prepareExportData()          → Připravit data pro export                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Kdy použít Observer:**

| Scénář | Metoda |
|--------|--------|
| Health check endpoint | `getSnapshot()` |
| Monitorovací dashboard | `startPolling()` |
| Logovat události procesů | `subscribe()` |
| Debug stromu supervize | `getProcessTree()` |
| Export metrik | `prepareExportData()` |
| Admin UI tlačítko stop | `stopProcess()` |

**Pamatujte:**

> Observer vám dává oči do vaší běžící aplikace. Použijte ho pro vytváření health checků, dashboardů a systémů alertování. Kombinace snímků pro point-in-time dotazy a odběrů pro real-time události pokrývá většinu monitorovacích potřeb.

---

Další: [Dashboard](./02-dashboard.md)
