# Observer API Reference

Modul `Observer` poskytuje celozystémovou introspekci pro noex procesy. Umožňuje real-time monitoring, sběr statistik a vizualizaci stromů procesů - podobně jako nástroj Observer v Elixiru.

## Import

```typescript
import { Observer } from 'noex';
// Nebo import ze submodulu
import { Observer } from 'noex/observer';
```

## Typy

### ObserverSnapshot

Kompletní snímek stavu systému v daném okamžiku.

```typescript
interface ObserverSnapshot {
  /** Časové razítko pořízení snímku */
  readonly timestamp: number;
  /** Statistiky všech běžících GenServerů */
  readonly servers: readonly GenServerStats[];
  /** Statistiky všech běžících Supervisorů */
  readonly supervisors: readonly SupervisorStats[];
  /** Hierarchický strom procesů */
  readonly tree: readonly ProcessTreeNode[];
  /** Celkový počet běžících procesů */
  readonly processCount: number;
  /** Celkový počet zpracovaných zpráv napříč všemi servery */
  readonly totalMessages: number;
  /** Celkový počet restartů napříč všemi supervisory */
  readonly totalRestarts: number;
  /** Globální statistiky paměti */
  readonly memoryStats: MemoryStats;
}
```

### GenServerStats

Statistiky pro jednotlivý GenServer.

```typescript
interface GenServerStats {
  readonly id: string;
  readonly name?: string;
  readonly status: 'running' | 'stopped';
  readonly messageCount: number;
  readonly startedAt: number;
  readonly lastMessageAt?: number;
}
```

### SupervisorStats

Statistiky pro jednotlivý Supervisor.

```typescript
interface SupervisorStats {
  readonly id: string;
  readonly name?: string;
  readonly childCount: number;
  readonly totalRestarts: number;
  readonly strategy: 'one_for_one' | 'one_for_all' | 'rest_for_one';
}
```

### ProcessTreeNode

Uzel v hierarchickém stromu procesů.

```typescript
interface ProcessTreeNode {
  readonly id: string;
  readonly name?: string;
  readonly type: 'genserver' | 'supervisor';
  readonly stats: GenServerStats | SupervisorStats;
  readonly children: readonly ProcessTreeNode[];
}
```

### MemoryStats

Statistiky paměti Node.js procesu.

```typescript
interface MemoryStats {
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
  readonly rss: number;
}
```

### ObserverEvent

Události emitované Observerem.

```typescript
type ObserverEvent =
  | { type: 'server_started'; stats: GenServerStats }
  | { type: 'server_stopped'; id: string; reason: TerminateReason }
  | { type: 'supervisor_started'; stats: SupervisorStats }
  | { type: 'supervisor_stopped'; id: string }
  | { type: 'stats_update'; servers: readonly GenServerStats[]; supervisors: readonly SupervisorStats[] };
```

### ObserverEventHandler

Handler funkce pro události Observeru.

```typescript
type ObserverEventHandler = (event: ObserverEvent) => void;
```

---

## Metody

### getSnapshot()

Vrací kompletní snímek stavu systému.

```typescript
getSnapshot(): ObserverSnapshot
```

**Vrací:** Kompletní systémový snímek se všemi procesy, statistikami a stromem

**Příklad:**
```typescript
const snapshot = Observer.getSnapshot();

console.log(`Časové razítko: ${new Date(snapshot.timestamp).toISOString()}`);
console.log(`Procesy: ${snapshot.processCount}`);
console.log(`Celkem zpráv: ${snapshot.totalMessages}`);
console.log(`Celkem restartů: ${snapshot.totalRestarts}`);
console.log(`Paměť: ${(snapshot.memoryStats.heapUsed / 1024 / 1024).toFixed(2)} MB`);
```

---

### getServerStats()

Vrací statistiky všech běžících GenServerů.

```typescript
getServerStats(): readonly GenServerStats[]
```

**Vrací:** Pole statistik GenServerů

**Příklad:**
```typescript
const servers = Observer.getServerStats();

for (const server of servers) {
  console.log(`${server.name || server.id}: ${server.messageCount} zpráv`);
}
```

---

### getSupervisorStats()

Vrací statistiky všech běžících Supervisorů.

```typescript
getSupervisorStats(): readonly SupervisorStats[]
```

**Vrací:** Pole statistik Supervisorů

**Příklad:**
```typescript
const supervisors = Observer.getSupervisorStats();

for (const sup of supervisors) {
  console.log(`${sup.name || sup.id}: ${sup.childCount} potomků, ${sup.totalRestarts} restartů`);
}
```

---

### getProcessTree()

Vrací kompletní hierarchii stromu procesů.

```typescript
getProcessTree(): readonly ProcessTreeNode[]
```

**Vrací:** Pole kořenových uzlů stromu procesů

**Příklad:**
```typescript
function printTree(nodes: readonly ProcessTreeNode[], indent = 0) {
  for (const node of nodes) {
    const prefix = '  '.repeat(indent);
    const name = node.name || node.id;
    console.log(`${prefix}${node.type}: ${name}`);
    printTree(node.children, indent + 1);
  }
}

const tree = Observer.getProcessTree();
printTree(tree);
```

---

### getMemoryStats()

Vrací aktuální statistiky paměti procesu.

```typescript
getMemoryStats(): MemoryStats
```

**Vrací:** Aktuální statistiky paměti

**Příklad:**
```typescript
const memory = Observer.getMemoryStats();

console.log(`Heap: ${(memory.heapUsed / 1024 / 1024).toFixed(2)} MB`);
console.log(`RSS: ${(memory.rss / 1024 / 1024).toFixed(2)} MB`);
```

---

### getProcessCount()

Vrací počet všech běžících procesů.

```typescript
getProcessCount(): number
```

**Vrací:** Celkový počet GenServerů a Supervisorů

**Příklad:**
```typescript
console.log(`Běžících procesů: ${Observer.getProcessCount()}`);
```

---

### subscribe()

Přihlásí odběr real-time událostí Observeru.

```typescript
subscribe(handler: ObserverEventHandler): () => void
```

**Parametry:**
- `handler` - Funkce volaná pro každou událost

**Vrací:** Funkci pro odhlášení odběru

**Příklad:**
```typescript
const unsubscribe = Observer.subscribe((event) => {
  switch (event.type) {
    case 'server_started':
      console.log(`Server spuštěn: ${event.stats.name || event.stats.id}`);
      break;
    case 'server_stopped':
      console.log(`Server zastaven: ${event.id} (${event.reason})`);
      break;
    case 'supervisor_started':
      console.log(`Supervisor spuštěn: ${event.stats.name || event.stats.id}`);
      break;
    case 'supervisor_stopped':
      console.log(`Supervisor zastaven: ${event.id}`);
      break;
  }
});

// Později: ukončení naslouchání
unsubscribe();
```

---

### startPolling()

Spustí periodické dotazování na aktualizace statistik.

```typescript
startPolling(intervalMs: number, handler: ObserverEventHandler): () => void
```

**Parametry:**
- `intervalMs` - Interval dotazování v milisekundách
- `handler` - Funkce volaná při každé aktualizaci statistik

**Vrací:** Funkci pro zastavení dotazování

**Příklad:**
```typescript
const stopPolling = Observer.startPolling(1000, (event) => {
  if (event.type === 'stats_update') {
    console.log(`Serverů: ${event.servers.length}`);
    console.log(`Supervisorů: ${event.supervisors.length}`);
  }
});

// Později: zastavení dotazování
stopPolling();
```

---

### stopProcess()

Zastaví proces podle jeho ID.

```typescript
async stopProcess(
  id: string,
  reason?: string,
): Promise<{ success: boolean; error?: string }>
```

**Parametry:**
- `id` - ID procesu k zastavení
- `reason` - Volitelný důvod zastavení

**Vrací:** Objekt se statusem úspěchu a volitelnou chybovou zprávou

**Příklad:**
```typescript
const result = await Observer.stopProcess('genserver_1_abc123', 'Manuální ukončení');

if (result.success) {
  console.log('Proces úspěšně zastaven');
} else {
  console.error('Selhalo zastavení:', result.error);
}
```

---

### prepareExportData()

Připraví data pro export ve standardizovaném formátu.

```typescript
prepareExportData(): ExportData
```

**Vrací:** Strukturu exportních dat s aktuálním snímkem

**Příklad:**
```typescript
import { Observer, exportToJson, exportToCsv } from 'noex/observer';

const data = Observer.prepareExportData();
const json = exportToJson(data);
const csvs = exportToCsv(data);
```

---

### subscribeToAlerts()

Přihlásí odběr událostí alertů z AlertManageru.

```typescript
subscribeToAlerts(handler: AlertEventHandler): () => void
```

**Parametry:**
- `handler` - Funkce volaná pro každou událost alertu

**Vrací:** Funkci pro odhlášení odběru

**Příklad:**
```typescript
const unsubscribe = Observer.subscribeToAlerts((event) => {
  if (event.type === 'alert_triggered') {
    console.log(`Alert: ${event.alert.message}`);
    console.log(`Proces: ${event.alert.processId}`);
    console.log(`Hodnota: ${event.alert.currentValue} (práh: ${event.alert.threshold})`);
  } else if (event.type === 'alert_resolved') {
    console.log(`Alert vyřešen pro ${event.processId}`);
  }
});
```

---

### getActiveAlerts()

Vrací všechny aktuálně aktivní alerty.

```typescript
getActiveAlerts(): readonly Alert[]
```

**Vrací:** Pole aktivních alertů

**Příklad:**
```typescript
const alerts = Observer.getActiveAlerts();

for (const alert of alerts) {
  console.log(`[${alert.type}] ${alert.message}`);
}
```

---

## Kompletní příklad

```typescript
import { Observer, GenServer, Supervisor } from 'noex';

async function main() {
  // Spuštění nějakých procesů
  const counter = await GenServer.start({
    init: () => 0,
    handleCall: (msg, state) => [state, state],
    handleCast: (msg, state) => state + 1,
  }, { name: 'counter' });

  // Odběr událostí životního cyklu
  const unsubscribe = Observer.subscribe((event) => {
    console.log(`Událost: ${event.type}`);
  });

  // Získání systémového snímku
  const snapshot = Observer.getSnapshot();
  console.log('\n=== Systémový snímek ===');
  console.log(`Procesy: ${snapshot.processCount}`);
  console.log(`Celkem zpráv: ${snapshot.totalMessages}`);
  console.log(`Paměť: ${(snapshot.memoryStats.heapUsed / 1024 / 1024).toFixed(2)} MB`);

  // Výpis stromu procesů
  console.log('\n=== Strom procesů ===');
  for (const node of snapshot.tree) {
    const name = node.name || node.id;
    console.log(`- ${node.type}: ${name}`);
  }

  // Spuštění dotazování na aktualizace
  const stopPolling = Observer.startPolling(5000, (event) => {
    if (event.type === 'stats_update') {
      const snapshot = Observer.getSnapshot();
      console.log(`\n[Poll] ${snapshot.processCount} procesů, ${snapshot.totalMessages} zpráv`);
    }
  });

  // Generování aktivity
  for (let i = 0; i < 10; i++) {
    GenServer.cast(counter, 'inc');
  }

  // Chvíli počkat
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Finální statistiky
  const finalStats = Observer.getServerStats();
  console.log('\n=== Finální statistiky ===');
  for (const server of finalStats) {
    console.log(`${server.name}: ${server.messageCount} zpráv`);
  }

  // Úklid
  stopPolling();
  unsubscribe();
  await GenServer.stop(counter);
}

main().catch(console.error);
```

---

## Integrace s dashboardem

Observer je navržen pro napájení monitorovacích dashboardů:

```typescript
import { Observer } from 'noex';
import { Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';

// Vytvoření WebSocket serveru pro real-time aktualizace
const wss = new WebSocketServer({ port: 8080 });

// Broadcast aktualizací všem připojeným klientům
Observer.startPolling(1000, (event) => {
  if (event.type === 'stats_update') {
    const snapshot = Observer.getSnapshot();
    const data = JSON.stringify({
      type: 'snapshot',
      data: snapshot,
    });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }
});

// Předávání událostí životního cyklu
Observer.subscribe((event) => {
  const data = JSON.stringify({
    type: 'event',
    data: event,
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
});
```

---

## Související

- [AlertManager API](./alert-manager.md) - Konfigurace alertů
- [Dashboard API](./dashboard.md) - Web dashboard
- [GenServer API](./genserver.md) - Implementace procesů
- [Supervisor API](./supervisor.md) - Supervize procesů
