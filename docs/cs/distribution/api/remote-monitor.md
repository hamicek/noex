# RemoteMonitor API Reference

Objekt `RemoteMonitor` umožňuje monitorování vzdálených GenServer procesů napříč uzly clusteru. Když monitorovaný proces skončí, monitorující proces obdrží `process_down` lifecycle event.

## Import

```typescript
import { RemoteMonitor } from 'noex/distribution';
```

## Přehled

RemoteMonitor následuje Erlang monitor sémantiku:
- Monitory jsou jednosměrné (monitorující proces je notifikován, není ovlivněn)
- Vícero monitorů na stejný proces jsou nezávislé
- Pokud monitorovaný proces neexistuje, `noproc` down event je odeslán okamžitě
- Odpojení uzlu spouští `noconnection` down eventy pro všechny monitorované procesy na tom uzlu

---

## Typy

### MonitorRef

Reference na vytvořený monitor.

```typescript
interface MonitorRef {
  readonly monitorId: MonitorId;
  readonly monitoredRef: SerializedRef;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `monitorId` | `MonitorId` | Unikátní identifikátor tohoto monitoru |
| `monitoredRef` | `SerializedRef` | Reference na monitorovaný proces |

### ProcessDownReason

Důvod proč monitorovaný proces spadl.

```typescript
type ProcessDownReason =
  | { readonly type: 'normal' }
  | { readonly type: 'shutdown' }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'noproc' }
  | { readonly type: 'noconnection' };
```

| Typ | Popis |
|-----|-------|
| `normal` | Proces skončil gracefully přes `stop()` |
| `shutdown` | Proces byl zastaven supervisorem |
| `error` | Proces spadl s výjimkou |
| `noproc` | Proces neexistoval když byl monitor nastaven |
| `noconnection` | Uzel hostující proces se stal nedostupným |

### RemoteMonitorOptions

Volby pro nastavení vzdáleného monitoru.

```typescript
interface RemoteMonitorOptions {
  readonly timeout?: number;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| `timeout` | `number` | `10000` | Timeout pro nastavení monitoru v milisekundách |

### RemoteMonitorStats

Statistiky o vzdálených monitor operacích.

```typescript
interface RemoteMonitorStats {
  readonly initialized: boolean;
  readonly pendingCount: number;
  readonly activeOutgoingCount: number;
  readonly totalInitiated: number;
  readonly totalEstablished: number;
  readonly totalTimedOut: number;
  readonly totalDemonitored: number;
  readonly totalProcessDownReceived: number;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `initialized` | `boolean` | Zda je modul inicializován |
| `pendingCount` | `number` | Čekající monitor požadavky |
| `activeOutgoingCount` | `number` | Aktivní odchozí monitory |
| `totalInitiated` | `number` | Celkem iniciovaných monitor požadavků |
| `totalEstablished` | `number` | Celkem úspěšně nastavených monitorů |
| `totalTimedOut` | `number` | Celkem monitorů které vypršely |
| `totalDemonitored` | `number` | Celkem monitorů odstraněných přes demonitor |
| `totalProcessDownReceived` | `number` | Celkem přijatých process_down eventů |

---

## Metody

### monitor()

Vytvoří monitor na vzdálený proces.

```typescript
async monitor(
  monitoringRef: GenServerRef,
  monitoredRef: GenServerRef,
  options?: RemoteMonitorOptions,
): Promise<MonitorRef>
```

**Parametry:**
- `monitoringRef` - Reference na lokální proces který bude přijímat notifikace
- `monitoredRef` - Reference na vzdálený proces k monitorování
- `options` - Volby monitoru

**Vrací:** Promise s MonitorRef

**Vyhodí:**
- `ClusterNotStartedError` - Pokud cluster neběží
- `NodeNotReachableError` - Pokud cílový uzel není připojen
- `RemoteMonitorTimeoutError` - Pokud nastavení monitoru vypršelo

Když monitorovaný proces skončí, monitorující proces obdrží `process_down` lifecycle event přes `GenServer.onLifecycleEvent()`.

**Příklad:**
```typescript
const monitorRef = await RemoteMonitor.monitor(localRef, remoteRef);
console.log(`Monitoruji ${monitorRef.monitoredRef.id}`);
```

---

### demonitor()

Odstraní monitor.

```typescript
async demonitor(monitorRef: MonitorRef): Promise<void>
```

**Parametry:**
- `monitorRef` - Reference na monitor k odstranění

Odešle demonitor požadavek na vzdálený uzel a odstraní monitor z lokálního registru. Pokud monitor neexistuje nebo byl již odstraněn, operace je no-op.

**Příklad:**
```typescript
await RemoteMonitor.demonitor(monitorRef);
```

---

### getStats()

Vrátí statistiky o vzdálených monitor operacích.

```typescript
getStats(): RemoteMonitorStats
```

**Příklad:**
```typescript
const stats = RemoteMonitor.getStats();
console.log(`Aktivních monitorů: ${stats.activeOutgoingCount}`);
console.log(`Celkem nastavených: ${stats.totalEstablished}`);
console.log(`Process down eventů: ${stats.totalProcessDownReceived}`);
```

---

## Chybové třídy

### RemoteMonitorTimeoutError

```typescript
class RemoteMonitorTimeoutError extends Error {
  readonly name = 'RemoteMonitorTimeoutError';
  readonly monitoredRef: SerializedRef;
  readonly timeoutMs: number;
}
```

Vyhodí se když nastavení vzdáleného monitoru vypršelo.

---

## Příjem Process Down Eventů

Process down notifikace jsou doručovány přes GenServer lifecycle event systém:

```typescript
import { GenServer } from 'noex';

// Přihlášení k lifecycle events
const unsubscribe = GenServer.onLifecycleEvent((event) => {
  if (event.type === 'process_down') {
    console.log(`Proces ${event.monitoredRef.id} spadl`);
    console.log(`Důvod: ${event.reason.type}`);

    if (event.reason.type === 'error') {
      console.log(`Chyba: ${event.reason.message}`);
    }
  }
});
```

---

## Kompletní příklad

```typescript
import { GenServer } from 'noex';
import {
  Cluster,
  RemoteMonitor,
  GlobalRegistry,
  RemoteMonitorTimeoutError,
} from 'noex/distribution';

// Watcher behaviour který monitoruje vzdálené procesy
const watcherBehavior = {
  init: () => ({ monitored: new Map<string, MonitorRef>() }),
  handleCall: (msg: { type: 'watch'; name: string }, state) => [null, state],
  handleCast: (_msg: never, state) => state,
};

async function main() {
  await Cluster.start({
    nodeName: 'watcher',
    port: 4369,
    seeds: ['worker@192.168.1.10:4369'],
  });

  // Start lokálního watcheru
  const watcherRef = await GenServer.start(watcherBehavior);

  // Sledování process_down eventů
  GenServer.onLifecycleEvent((event) => {
    if (event.type === 'process_down') {
      console.log(`\nProcess down notifikace:`);
      console.log(`  Proces: ${event.monitoredRef.id}@${event.monitoredRef.nodeId}`);
      console.log(`  Důvod: ${event.reason.type}`);

      if (event.reason.type === 'error') {
        console.log(`  Chyba: ${event.reason.message}`);
      }

      // Logika obnovy
      handleProcessDown(event.monitoredRef);
    }
  });

  // Čekání na připojení clusteru
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Nalezení a monitorování vzdálených procesů
  const monitors: MonitorRef[] = [];

  for (const name of GlobalRegistry.getNames()) {
    const remoteRef = GlobalRegistry.lookup(name);

    // Monitoruj pouze vzdálené procesy
    if (remoteRef.nodeId !== Cluster.getLocalNodeId()) {
      try {
        const monitorRef = await RemoteMonitor.monitor(
          watcherRef,
          remoteRef as unknown as GenServerRef,
          { timeout: 5000 },
        );
        monitors.push(monitorRef);
        console.log(`Monitoruji ${name} (${remoteRef.id})`);
      } catch (error) {
        if (error instanceof RemoteMonitorTimeoutError) {
          console.log(`Timeout monitorování ${name}`);
        } else {
          throw error;
        }
      }
    }
  }

  console.log(`\nMonitoruji ${monitors.length} vzdálených procesů`);

  // Periodický výpis statistik
  setInterval(() => {
    const stats = RemoteMonitor.getStats();
    console.log(`\nMonitor statistiky:`);
    console.log(`  Aktivních: ${stats.activeOutgoingCount}`);
    console.log(`  Down eventů: ${stats.totalProcessDownReceived}`);
  }, 10000);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    // Odstranění všech monitorů
    for (const monitor of monitors) {
      await RemoteMonitor.demonitor(monitor);
    }

    await Cluster.stop();
    process.exit(0);
  });
}

function handleProcessDown(ref: SerializedRef): void {
  console.log(`Zpracovávám pád procesu ${ref.id}`);
  // Implementace logiky obnovy:
  // - Pokus o reconnect ke službě
  // - Failover na zálohu
  // - Alerting operátorů
}

main().catch(console.error);
```

---

## Automatické čištění

### Při odpojení uzlu

Když se uzel odpojí, všechny monitory na procesy na tom uzlu jsou automaticky:
1. Odstraněny z lokálního registru
2. Spustí `process_down` eventy s důvodem `noconnection`

```typescript
Cluster.onNodeDown((nodeId, reason) => {
  console.log(`Uzel ${nodeId} spadl - všechny monitory spustí noconnection`);
});
```

### Při ukončení monitorujícího procesu

Když monitorující proces skončí:
1. Všechny jeho odchozí monitory jsou odstraněny z registru
2. Demonitor požadavky jsou odeslány na vzdálené uzly (best effort)

---

## Best practices

### 1. Používejte monitory pro detekci selhání

```typescript
async function watchDependencies(localRef: GenServerRef): Promise<void> {
  const dependencies = ['database', 'cache', 'queue'];

  for (const name of dependencies) {
    const ref = GlobalRegistry.whereis(name);
    if (ref) {
      await RemoteMonitor.monitor(localRef, ref as unknown as GenServerRef);
    }
  }
}
```

### 2. Ošetřujte všechny down důvody

```typescript
GenServer.onLifecycleEvent((event) => {
  if (event.type === 'process_down') {
    switch (event.reason.type) {
      case 'normal':
        console.log('Proces skončil gracefully');
        break;
      case 'shutdown':
        console.log('Proces byl zastaven');
        break;
      case 'error':
        console.log(`Proces spadl: ${event.reason.message}`);
        triggerAlert(event.monitoredRef, event.reason.message);
        break;
      case 'noproc':
        console.log('Proces neexistoval');
        break;
      case 'noconnection':
        console.log('Ztráta spojení s uzlem');
        initiateFailover(event.monitoredRef);
        break;
    }
  }
});
```

### 3. Kombinujte s DistributedSupervisor

Pro automatický failover použijte `DistributedSupervisor` který interně používá `RemoteMonitor`:

```typescript
const supRef = await DistributedSupervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'worker', behavior: 'worker' },
  ],
});
```

---

## Související

- [Monitorování procesů návod](../guides/process-monitoring.md) - Použití RemoteMonitor
- [DistributedSupervisor API](./distributed-supervisor.md) - Automatický failover
- [Cluster API](./cluster.md) - Události uzlů
- [Typy Reference](./types.md) - Všechny distribuční typy

---

*[English version](../../../distribution/api/remote-monitor.md)*
