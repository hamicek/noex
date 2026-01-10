# ClusterObserver API Reference

Modul `ClusterObserver` poskytuje cluster-wide monitoring procesů pro distribuované noex aplikace. Zatímco standardní `Observer` monitoruje pouze lokální procesy synchronně, `ClusterObserver` agreguje statistiky ze všech uzlů v clusteru asynchronně.

## Import

```typescript
import { ClusterObserver } from 'noex/distribution';
// Nebo z hlavního balíčku
import { ClusterObserver } from 'noex';
```

## Předpoklady

ClusterObserver vyžaduje aktivní připojení ke clusteru:

```typescript
import { Cluster, ClusterObserver } from 'noex/distribution';

await Cluster.start({
  nodeName: 'app1',
  port: 4369,
  seeds: ['app2@192.168.1.2:4369'],
});

// Nyní je ClusterObserver dostupný
const snapshot = await ClusterObserver.getClusterSnapshot();
```

## Typy

### ClusterObserverSnapshot

Kompletní snímek stavu clusteru.

```typescript
interface ClusterObserverSnapshot {
  /** Časové razítko pořízení snímku */
  readonly timestamp: number;
  /** Identifikátor lokálního uzlu */
  readonly localNodeId: NodeId;
  /** Snímky ze všech uzlů v clusteru */
  readonly nodes: readonly NodeObserverSnapshot[];
  /** Agregované statistiky napříč všemi uzly */
  readonly aggregated: ClusterAggregatedStats;
}
```

### NodeObserverSnapshot

Snímek z jednotlivého uzlu.

```typescript
interface NodeObserverSnapshot {
  /** Identifikátor uzlu */
  readonly nodeId: NodeId;
  /** Aktuální stav uzlu */
  readonly status: NodeObserverStatus;
  /** Observer snímek (null pokud uzel není dostupný) */
  readonly snapshot: ObserverSnapshot | null;
  /** Časové razítko poslední úspěšné aktualizace */
  readonly lastUpdate: number;
  /** Chybová zpráva pokud je status 'error' nebo 'timeout' */
  readonly error?: string;
}
```

### NodeObserverStatus

Stav uzlu ve snímku clusteru.

```typescript
type NodeObserverStatus = 'connected' | 'disconnected' | 'error' | 'timeout';
```

| Status | Popis |
|--------|-------|
| `'connected'` | Uzel úspěšně odpověděl |
| `'disconnected'` | Uzel je znám, ale není dostupný |
| `'error'` | Dotaz selhal s chybou |
| `'timeout'` | Dotaz vypršel |

### ClusterAggregatedStats

Agregované statistiky napříč všemi připojenými uzly.

```typescript
interface ClusterAggregatedStats {
  /** Celkový počet procesů napříč všemi uzly */
  readonly totalProcessCount: number;
  /** Celkový počet GenServerů napříč všemi uzly */
  readonly totalServerCount: number;
  /** Celkový počet Supervisorů napříč všemi uzly */
  readonly totalSupervisorCount: number;
  /** Celkový počet zpracovaných zpráv napříč všemi uzly */
  readonly totalMessages: number;
  /** Celkový počet restartů napříč všemi uzly */
  readonly totalRestarts: number;
  /** Počet uzlů, které úspěšně odpověděly */
  readonly connectedNodeCount: number;
  /** Celkový počet uzlů v clusteru */
  readonly totalNodeCount: number;
}
```

### ClusterObserverEvent

Události emitované ClusterObserverem.

```typescript
type ClusterObserverEvent =
  | { type: 'cluster_snapshot_update'; snapshot: ClusterObserverSnapshot }
  | { type: 'node_snapshot_update'; nodeId: NodeId; snapshot: ObserverSnapshot }
  | { type: 'node_error'; nodeId: NodeId; error: string }
  | { type: 'node_timeout'; nodeId: NodeId };
```

### ClusterObserverEventHandler

Handler funkce pro události ClusterObserveru.

```typescript
type ClusterObserverEventHandler = (event: ClusterObserverEvent) => void;
```

### ClusterSnapshotOptions

Možnosti pro `getClusterSnapshot()`.

```typescript
interface ClusterSnapshotOptions {
  /** Zda použít cachovaná data pokud jsou dostupná (výchozí: true) */
  readonly useCache?: boolean;
  /** Timeout pro vzdálené dotazy v milisekundách (výchozí: 5000) */
  readonly timeout?: number;
}
```

---

## Metody

### getClusterSnapshot()

Vrací agregovaný snímek ze všech uzlů v clusteru.

```typescript
async getClusterSnapshot(options?: ClusterSnapshotOptions): Promise<ClusterObserverSnapshot>
```

**Parametry:**
- `options.useCache` - Zda použít cachovaná data (výchozí: `true`)
- `options.timeout` - Timeout vzdáleného dotazu v ms (výchozí: `5000`)

**Vrací:** Promise resolvující na snímek clusteru

**Vyhazuje:**
- `Error` - Pokud cluster neběží

**Příklad:**
```typescript
const snapshot = await ClusterObserver.getClusterSnapshot();

console.log(`Cluster má ${snapshot.aggregated.totalProcessCount} procesů`);
console.log(`Na ${snapshot.aggregated.connectedNodeCount} uzlech`);

for (const node of snapshot.nodes) {
  if (node.status === 'connected' && node.snapshot) {
    console.log(`${node.nodeId}: ${node.snapshot.processCount} procesů`);
  }
}
```

---

### getNodeSnapshot()

Vrací snímek z konkrétního vzdáleného uzlu.

```typescript
async getNodeSnapshot(nodeId: NodeId, timeout?: number): Promise<ObserverSnapshot>
```

**Parametry:**
- `nodeId` - Identifikátor cílového uzlu
- `timeout` - Timeout dotazu v ms (výchozí: `5000`)

**Vrací:** Promise resolvující na observer snímek uzlu

**Vyhazuje:**
- `Error` - Pokud cluster neběží
- `Error` - Pokud uzel není dostupný
- `Error` - Pokud dotaz selže

**Příklad:**
```typescript
const remoteSnapshot = await ClusterObserver.getNodeSnapshot(
  'app2@192.168.1.2:4369' as NodeId
);

console.log(`Vzdálený uzel má ${remoteSnapshot.processCount} procesů`);
```

---

### startPolling()

Spustí periodické dotazování na cluster-wide snímky.

```typescript
startPolling(intervalMs: number, handler: ClusterObserverEventHandler): () => void
```

**Parametry:**
- `intervalMs` - Interval dotazování v milisekundách
- `handler` - Event handler pro aktualizace snímků

**Vrací:** Funkci pro odhlášení

**Poznámky:**
- Více volání s různými handlery sdílí stejný polling timer
- Timer se zastaví když všechny handlery odhlásí odběr
- Emituje počáteční snímek okamžitě

**Příklad:**
```typescript
const stopPolling = ClusterObserver.startPolling(5000, (event) => {
  if (event.type === 'cluster_snapshot_update') {
    updateDashboard(event.snapshot);
  } else if (event.type === 'node_timeout') {
    console.warn(`Uzel ${event.nodeId} neodpovídá`);
  }
});

// Později: zastavení dotazování
stopPolling();
```

---

### subscribe()

Přihlásí odběr událostí cluster observeru bez spuštění pollingu.

```typescript
subscribe(handler: ClusterObserverEventHandler): () => void
```

**Parametry:**
- `handler` - Event handler

**Vrací:** Funkci pro odhlášení

**Poznámky:**
- Události jsou emitovány během pollingu spuštěného `startPolling()`
- Umožňuje více posluchačů bez spuštění dalších timerů

**Příklad:**
```typescript
const unsubscribe = ClusterObserver.subscribe((event) => {
  if (event.type === 'node_error') {
    console.error(`Chyba uzlu ${event.nodeId}: ${event.error}`);
  }
});

// Později
unsubscribe();
```

---

### invalidateCache()

Vynutí získání čerstvých dat při dalším volání `getClusterSnapshot()`.

```typescript
invalidateCache(): void
```

**Příklad:**
```typescript
// Vynutit čerstvá data při dalším dotazu
ClusterObserver.invalidateCache();

// Toto získá čerstvá data
const snapshot = await ClusterObserver.getClusterSnapshot();
```

---

### getCacheStatus()

Vrací aktuální stav cache pro ladění.

```typescript
getCacheStatus(): { readonly timestamp: number; readonly age: number } | null
```

**Vrací:** Informace o cache nebo `null` pokud cache neexistuje

**Příklad:**
```typescript
const status = ClusterObserver.getCacheStatus();
if (status) {
  console.log(`Stáří cache: ${status.age}ms`);
}
```

---

## Kompletní příklad

```typescript
import { Observer } from 'noex';
import { Cluster, ClusterObserver } from 'noex/distribution';

async function monitorCluster() {
  // Spuštění clusteru
  await Cluster.start({
    nodeName: 'monitor',
    port: 4369,
    seeds: ['app1@192.168.1.1:4369', 'app2@192.168.1.2:4369'],
  });

  // Lokální monitoring (synchronní)
  const localSnapshot = Observer.getSnapshot();
  console.log(`Lokálně: ${localSnapshot.processCount} procesů`);

  // Cluster-wide monitoring (asynchronní)
  const clusterSnapshot = await ClusterObserver.getClusterSnapshot();
  console.log(`Cluster: ${clusterSnapshot.aggregated.totalProcessCount} procesů`);

  // Rozpad po uzlech
  for (const node of clusterSnapshot.nodes) {
    const isLocal = node.nodeId === clusterSnapshot.localNodeId;
    const marker = isLocal ? ' (lokální)' : '';

    if (node.status === 'connected' && node.snapshot) {
      console.log(`${node.nodeId}${marker}:`);
      console.log(`  Procesy: ${node.snapshot.processCount}`);
      console.log(`  Zprávy: ${node.snapshot.totalMessages}`);
      console.log(`  Paměť: ${(node.snapshot.memoryStats.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    } else {
      console.log(`${node.nodeId}${marker}: ${node.status}`);
      if (node.error) {
        console.log(`  Chyba: ${node.error}`);
      }
    }
  }

  // Spuštění dotazování na aktualizace
  const stopPolling = ClusterObserver.startPolling(5000, (event) => {
    if (event.type === 'cluster_snapshot_update') {
      const { aggregated } = event.snapshot;
      console.log(`[Aktualizace] ${aggregated.totalProcessCount} procesů na ${aggregated.connectedNodeCount} uzlech`);
    }
  });

  // Úklid při vypnutí
  process.on('SIGINT', async () => {
    stopPolling();
    await Cluster.stop();
  });
}

monitorCluster().catch(console.error);
```

---

## Chování cache

ClusterObserver cachuje snímky po dobu 2 sekund ve výchozím nastavení pro snížení síťového provozu. Cache můžete ovládat:

```typescript
// Použít cache (výchozí)
const cached = await ClusterObserver.getClusterSnapshot();

// Vynutit čerstvá data
const fresh = await ClusterObserver.getClusterSnapshot({ useCache: false });

// Ručně invalidovat cache
ClusterObserver.invalidateCache();
```

---

## Ošetření chyb

Když uzel není dostupný, jeho stav odráží problém:

```typescript
const snapshot = await ClusterObserver.getClusterSnapshot();

for (const node of snapshot.nodes) {
  switch (node.status) {
    case 'connected':
      // Uzel úspěšně odpověděl
      console.log(`${node.nodeId}: ${node.snapshot?.processCount} procesů`);
      break;
    case 'timeout':
      console.warn(`Uzel ${node.nodeId} vypršel timeout`);
      break;
    case 'error':
      console.error(`Chyba uzlu ${node.nodeId}: ${node.error}`);
      break;
    case 'disconnected':
      console.warn(`Uzel ${node.nodeId} odpojen`);
      break;
  }
}
```

---

## Osvědčené postupy

### Intervaly dotazování

Zvolte intervaly dotazování podle vašich monitorovacích potřeb:

```typescript
// Aktualizace dashboardu (časté)
ClusterObserver.startPolling(2000, handler);

// Health checky (střední)
ClusterObserver.startPolling(10000, handler);

// Prostředí s omezenými zdroji (řídké)
ClusterObserver.startPolling(30000, handler);
```

### Konfigurace timeoutu

Upravte timeouty podle síťových podmínek:

```typescript
// Lokální síť (rychlá)
const snapshot = await ClusterObserver.getClusterSnapshot({ timeout: 2000 });

// Mezi datacentry (pomalejší)
const snapshot = await ClusterObserver.getClusterSnapshot({ timeout: 10000 });
```

### Zpracování částečných výsledků

Snímky clusteru mohou obsahovat částečné výsledky pokud některé uzly nejsou dostupné. Navrhněte svůj kód tak, aby to zvládal elegantně:

```typescript
const snapshot = await ClusterObserver.getClusterSnapshot();
const { aggregated } = snapshot;

if (aggregated.connectedNodeCount < aggregated.totalNodeCount) {
  console.warn(
    `Pouze ${aggregated.connectedNodeCount}/${aggregated.totalNodeCount} uzlů odpovědělo`
  );
}
```

---

## Související

- [Observer API](../../api/observer.md) - Lokální monitoring procesů
- [Cluster API](./cluster.md) - Správa clusteru
- [Distribution Overview](../concepts/overview.md) - Architektura
