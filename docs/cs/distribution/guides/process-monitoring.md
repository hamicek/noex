# Monitorování procesů

Tento návod pokrývá sledování vzdálených procesů pomocí `RemoteMonitor`. Naučíte se detekovat pády procesů, reagovat na odpojení uzlů a budovat fault-tolerant systémy.

## Přehled

Monitorování procesů umožňuje reaktivní fault tolerance:

- Detekce ukončení vzdálených procesů
- Reakce na pády uzlů
- Čištění zdrojů a spouštění obnovy

```
┌────────────────────┐                 ┌────────────────────┐
│      Node A        │                 │      Node B        │
│  ┌──────────────┐  │   monitor_req   │  ┌──────────────┐  │
│  │   Watcher    │──┼────────────────►│  │   Worker     │  │
│  │ (monitoruje) │  │                 │  │ (sledovaný)  │  │
│  └──────┬───────┘  │   monitor_ack   │  └──────────────┘  │
│         │          │◄────────────────┼                    │
│         │          │                 │                    │
│         │          │   process_down  │    (spadne!)       │
│         ▼          │◄────────────────┼────────────────────│
│  "Worker spadl"    │                 │                    │
└────────────────────┘                 └────────────────────┘
```

## Základní monitorování

### Nastavení monitoru

```typescript
import { GenServer, type GenServerRef } from 'noex';
import { RemoteMonitor } from 'noex/distribution';

// Proces který bude sledovat ostatní
const watcherRef = await GenServer.start(watcherBehavior);

// Reference na vzdálený proces
const remoteWorkerRef: GenServerRef = {
  id: 'worker-123',
  nodeId: 'worker-node@192.168.1.20:4369',
} as GenServerRef;

// Vytvoření monitoru
const monitorRef = await RemoteMonitor.monitor(watcherRef, remoteWorkerRef);

console.log(`Monitoruji proces ${remoteWorkerRef.id}`);
console.log(`Monitor ID: ${monitorRef.monitorId}`);
```

### Příjem process_down událostí

Když sledovaný proces skončí, monitorující proces obdrží lifecycle event:

```typescript
// Přihlášení k lifecycle events
GenServer.onLifecycleEvent((event) => {
  if (event.type === 'process_down') {
    console.log(`Proces ${event.monitoredRef.id} spadl`);
    console.log(`Uzel: ${event.monitoredRef.nodeId}`);
    console.log(`Důvod: ${event.reason.type}`);
    console.log(`Monitor ID: ${event.monitorId}`);
  }
});
```

### Zastavení monitoru

```typescript
// Zastavení monitorování když už není potřeba
await RemoteMonitor.demonitor(monitorRef);
```

## Důvody pádu procesu

| Typ důvodu | Popis |
|------------|-------|
| `normal` | Proces skončil normálně (čistý shutdown) |
| `shutdown` | Supervisor inicioval shutdown |
| `error` | Proces spadl s výjimkou |
| `noproc` | Proces neexistoval když byl monitor nastaven |
| `noconnection` | Ztráta spojení s uzlem |

### Zpracování důvodů

```typescript
GenServer.onLifecycleEvent((event) => {
  if (event.type !== 'process_down') return;

  switch (event.reason.type) {
    case 'normal':
    case 'shutdown':
      console.log('Čisté ukončení');
      break;

    case 'noconnection':
      console.log('Uzel spadl');
      scheduleReconnect(event.monitoredRef.nodeId);
      break;

    case 'error':
      console.log(`Proces spadl: ${event.reason.message}`);
      spawnReplacement(event.monitoredRef);
      break;

    case 'noproc':
      console.log('Proces už byl mrtvý');
      break;
  }
});
```

## Vzory monitorování

### Single Process Watcher

Sledování kritického procesu a restart při selhání:

```typescript
import { RemoteMonitor, RemoteSpawn, Cluster } from 'noex/distribution';

interface WatcherState {
  targetName: string;
  targetBehavior: string;
  monitorRef: MonitorRef | null;
}

async function watchCriticalService(
  watcherRef: GenServerRef,
  serviceName: string,
  behaviorName: string,
): Promise<void> {
  // Najdi službu
  const serviceRef = GlobalRegistry.whereis(serviceName);
  if (!serviceRef) {
    console.log(`Služba ${serviceName} nenalezena, spawnuji...`);
    await spawnService(behaviorName, serviceName);
    return;
  }

  // Nastav monitor
  const monitorRef = await RemoteMonitor.monitor(
    watcherRef,
    serviceRef as unknown as GenServerRef,
  );

  console.log(`Sleduji ${serviceName}`);
}

async function spawnService(behaviorName: string, name: string): Promise<void> {
  const nodes = Cluster.getConnectedNodes();
  if (nodes.length === 0) {
    throw new Error('Žádné dostupné uzly');
  }

  await RemoteSpawn.spawn(behaviorName, nodes[0]!.id, {
    name,
    registration: 'global',
  });
}
```

### Multi-Process Pool Monitor

Sledování poolu workerů a udržování minimální kapacity:

```typescript
interface PoolState {
  workers: Map<string, { ref: SerializedRef; monitorRef: MonitorRef }>;
  minWorkers: number;
  behaviorName: string;
}

async function maintainPool(
  watcherRef: GenServerRef,
  state: PoolState,
): Promise<void> {
  // Přidej workery pokud jich je málo
  while (state.workers.size < state.minWorkers) {
    const worker = await spawnAndMonitor(watcherRef, state.behaviorName);
    state.workers.set(worker.ref.id, worker);
  }
}

async function spawnAndMonitor(
  watcherRef: GenServerRef,
  behaviorName: string,
): Promise<{ ref: SerializedRef; monitorRef: MonitorRef }> {
  const nodes = Cluster.getConnectedNodes();
  const targetNode = getLeastLoadedNode(nodes);

  const result = await RemoteSpawn.spawn(behaviorName, targetNode.id);
  const ref: SerializedRef = { id: result.serverId, nodeId: result.nodeId };

  const monitorRef = await RemoteMonitor.monitor(
    watcherRef,
    ref as unknown as GenServerRef,
  );

  return { ref, monitorRef };
}

function getLeastLoadedNode(nodes: NodeInfo[]): NodeInfo {
  return nodes.reduce((min, n) =>
    n.processCount < min.processCount ? n : min
  );
}
```

## Zpracování pádů uzlů

Když se uzel odpojí, všechny monitory na procesy na tom uzlu obdrží `noconnection`:

```typescript
// Sleduj monitory podle uzlu pro hromadné zpracování
const monitorsByNode = new Map<string, Set<MonitorRef>>();

async function monitorProcess(
  watcherRef: GenServerRef,
  targetRef: SerializedRef,
): Promise<MonitorRef> {
  const monitorRef = await RemoteMonitor.monitor(
    watcherRef,
    targetRef as unknown as GenServerRef,
  );

  // Sleduj podle uzlu
  const nodeId = targetRef.nodeId as string;
  if (!monitorsByNode.has(nodeId)) {
    monitorsByNode.set(nodeId, new Set());
  }
  monitorsByNode.get(nodeId)!.add(monitorRef);

  return monitorRef;
}

// Zpracování pádu uzlu na úrovni clusteru
Cluster.onNodeDown((nodeId, reason) => {
  console.log(`Uzel ${nodeId} spadl: ${reason}`);

  const monitors = monitorsByNode.get(nodeId);
  if (monitors) {
    console.log(`Ztraceno ${monitors.size} monitorů na ${nodeId}`);
    monitorsByNode.delete(nodeId);
  }

  // Aplikační logika pro obnovu
  handleNodeFailure(nodeId);
});
```

## Kompletní příklad

```typescript
import { GenServer, type GenServerRef, type LifecycleEvent } from 'noex';
import {
  Cluster,
  RemoteMonitor,
  GlobalRegistry,
  RemoteSpawn,
} from 'noex/distribution';

// State
interface AppState {
  watcherRef: GenServerRef | null;
  monitors: Map<string, MonitorRef>;
}

const state: AppState = {
  watcherRef: null,
  monitors: new Map(),
};

async function main(): Promise<void> {
  // Registrace behaviour
  BehaviorRegistry.register('counter', counterBehavior);

  // Start clusteru
  await Cluster.start({
    nodeName: 'watcher-node',
    port: 4369,
    seeds: process.env.SEEDS?.split(',') || [],
  });

  // Vytvoř watcher proces
  const watcherBehavior = {
    init: () => ({}),
    handleCall: () => [null, {}],
    handleCast: () => ({}),
  };
  state.watcherRef = await GenServer.start(watcherBehavior);

  // Nastav lifecycle handler
  GenServer.onLifecycleEvent(handleLifecycleEvent);

  // Čekej na uzly
  await waitForNodes();

  // Najdi a sleduj všechny vzdálené countery
  await monitorAllCounters();

  console.log('Watcher běží. Ctrl+C pro ukončení.');
}

function handleLifecycleEvent(event: LifecycleEvent): void {
  if (event.type !== 'process_down') return;

  // Najdi který counter to byl
  for (const [name, monitorRef] of state.monitors) {
    if (monitorRef.monitorId === event.monitorId) {
      console.log(`\nCounter "${name}" spadl!`);
      console.log(`  Uzel: ${event.monitoredRef.nodeId}`);
      console.log(`  Důvod: ${event.reason.type}`);

      // Vyčisti
      state.monitors.delete(name);

      // Pokus o restart
      if (event.reason.type !== 'normal') {
        restartCounter(name);
      }
      break;
    }
  }
}

async function monitorAllCounters(): Promise<void> {
  if (!state.watcherRef) return;

  for (const name of GlobalRegistry.getNames()) {
    if (!name.startsWith('counter:')) continue;

    const ref = GlobalRegistry.lookup(name);
    if (ref.nodeId === Cluster.getLocalNodeId()) continue; // Nemonitoruj lokální

    try {
      const monitorRef = await RemoteMonitor.monitor(
        state.watcherRef,
        ref as unknown as GenServerRef,
      );
      state.monitors.set(name, monitorRef);
      console.log(`Monitoruji ${name} na ${ref.nodeId}`);
    } catch (error) {
      console.log(`Nelze monitorovat ${name}:`, error);
    }
  }
}

async function restartCounter(name: string): Promise<void> {
  const nodes = Cluster.getConnectedNodes();
  if (nodes.length === 0) {
    console.log('Žádné uzly pro restart');
    return;
  }

  try {
    await RemoteSpawn.spawn('counter', nodes[0]!.id, {
      name,
      registration: 'global',
    });
    console.log(`Restartován ${name} na ${nodes[0]!.id}`);

    // Znovu nastav monitor
    const ref = GlobalRegistry.lookup(name);
    const monitorRef = await RemoteMonitor.monitor(
      state.watcherRef!,
      ref as unknown as GenServerRef,
    );
    state.monitors.set(name, monitorRef);
  } catch (error) {
    console.log(`Restart ${name} selhal:`, error);
  }
}

async function waitForNodes(): Promise<void> {
  while (Cluster.getConnectedNodeCount() === 0) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nUkončuji...');

  for (const monitorRef of state.monitors.values()) {
    await RemoteMonitor.demonitor(monitorRef);
  }

  await Cluster.stop();
  process.exit(0);
});

main().catch(console.error);
```

## Best practices

### 1. Vždy čistěte monitory

```typescript
// Před zastavením procesu
for (const monitorRef of monitors.values()) {
  await RemoteMonitor.demonitor(monitorRef);
}
monitors.clear();
```

### 2. Ošetřete noproc okamžitě

```typescript
try {
  const monitorRef = await RemoteMonitor.monitor(watcher, target);
} catch (error) {
  // Monitor setup selhal - proces možná neexistuje
  console.log('Monitor nelze nastavit:', error);
  handleMissingProcess(target);
}
```

### 3. Používejte vhodné timeouty

```typescript
// Rychlá lokální síť
const monitorRef = await RemoteMonitor.monitor(watcher, target, {
  timeout: 5000,
});

// Pomalá nebo nespolehlivá síť
const monitorRef = await RemoteMonitor.monitor(watcher, target, {
  timeout: 30000,
});
```

### 4. Kombinujte s cluster events

```typescript
// Monitoruj jednotlivé procesy
const monitorRef = await RemoteMonitor.monitor(watcher, worker);

// Také reaguj na pády uzlů
Cluster.onNodeDown((nodeId, reason) => {
  // Hromadné čištění pro všechny procesy na tom uzlu
  cleanupNodeResources(nodeId);
});
```

### 5. Vyhněte se monitor storms

```typescript
// Špatně: jeden watcher monitoruje tisíce procesů
for (const worker of workers) {
  await RemoteMonitor.monitor(singleWatcher, worker);
}

// Lépe: rozložte monitorování
const watchersPerNode = 3;
const assignedWatcher = watchers[workerIndex % watchersPerNode];
await RemoteMonitor.monitor(assignedWatcher, worker);
```

## Statistiky

```typescript
const stats = RemoteMonitor.getStats();

console.log(`Inicializováno: ${stats.initialized}`);
console.log(`Čekající: ${stats.pendingCount}`);
console.log(`Aktivní: ${stats.activeOutgoingCount}`);
console.log(`Celkem nastaveno: ${stats.totalEstablished}`);
console.log(`Process down events: ${stats.totalProcessDownReceived}`);
```

## Linkování procesů

Zatímco monitory poskytují jednosměrné pozorování, **linky** poskytují obousměrnou propagaci selhání. Když linkovaný proces crashne, peer je také terminován (pokud netrapuje exity).

### Monitory vs Linky

| | Monitor | Link |
|--|---------|------|
| Směr | Jednosměrný | Obousměrný |
| Při pádu | Notifikace (lifecycle event) | Terminace (nebo ExitSignal s trapExit) |
| Použití | Nezávislé pozorování | Provázané procesy, které by měly selhat společně |

### Nastavení vzdáleného linku

```typescript
import { RemoteLink } from 'noex/distribution';

// Link lokálního procesu ke vzdálenému
const linkRef = await RemoteLink.link(localRef, remoteRef);

// Pokud jeden proces crashne, druhý je ovlivněn
```

### Zpracování exit signálů s trapExit

```typescript
import { GenServer, type ExitSignal } from 'noex';

const behavior = {
  init: () => ({ linkedWorkers: [] as string[] }),
  handleCast: (_msg: never, state) => state,
  handleInfo: (info: ExitSignal, state: { linkedWorkers: string[] }) => {
    if (info.type === 'EXIT') {
      console.log(`Linkovaný proces ${info.from.id} terminoval: ${info.reason.type}`);
      return {
        linkedWorkers: state.linkedWorkers.filter(id => id !== info.from.id),
      };
    }
    return state;
  },
};

// Start s trapExit - dostane signály místo terminace
const ref = await GenServer.start(behavior, { trapExit: true });
await RemoteLink.link(ref, remoteWorkerRef);
```

### Kdy použít linky vs monitory

- **Linky** - těsně provázané procesy (worker a jeho connection handler)
- **Monitory** - nezávislé pozorování (dashboard sledující služby)

Viz [RemoteLink API](../api/remote-link.md) pro kompletní referenci.

---

## Související

- [RemoteMonitor API Reference](../api/remote-monitor.md) - Kompletní API monitorů
- [RemoteLink API Reference](../api/remote-link.md) - Kompletní API linků
- [Vzdálené procesy](./remote-processes.md) - Spawn a správa procesů
- [Distribuovaná supervize](../concepts/distributed-supervisor.md) - Automatická supervize

---

*[English version](../../../distribution/guides/process-monitoring.md)*
