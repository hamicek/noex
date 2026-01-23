# RemoteLink API Reference

Objekt `RemoteLink` umožňuje obousměrné linkování procesů napříč uzly clusteru. Když linkovaný proces abnormálně terminuje, exit signál se propaguje na vzdálený peer — buď ho ukončí, nebo doručí `ExitSignal` info zprávu pokud má `trapExit` povoleno.

## Import

```typescript
import { RemoteLink } from 'noex/distribution';
```

## Přehled

RemoteLink následuje Erlang link sémantiku:
- Linky jsou obousměrné (oba procesy jsou ovlivněny terminací toho druhého)
- Abnormální terminace se propaguje na linkovaný peer
- Normální exit (`'normal'`) tiše odstraní link bez propagace
- Pokud má peer `trapExit: true`, dostane `ExitSignal` přes `handleInfo` místo terminace
- Odpojení uzlu spustí `noconnection` exit signály pro všechny linkované procesy na daném uzlu

### Rozdíl od monitorů

| | Monitor | Link |
|--|---------|------|
| Směr | Jednosměrný | Obousměrný |
| Při pádu | Notifikace (event) | Terminace (propagace) |
| Trap exits | N/A | Lze zapnout - dostane info zprávu místo terminace |

---

## Typy

### LinkRef

Reference na vytvořený link.

```typescript
interface LinkRef {
  readonly linkId: string;
  readonly ref1: SerializedRef;
  readonly ref2: SerializedRef;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `linkId` | `string` | Unikátní identifikátor linku |
| `ref1` | `SerializedRef` | Reference na první linkovaný proces |
| `ref2` | `SerializedRef` | Reference na druhý linkovaný proces |

### RemoteLinkOptions

Volby pro nastavení vzdáleného linku.

```typescript
interface RemoteLinkOptions {
  readonly timeout?: number;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| `timeout` | `number` | `10000` | Timeout pro nastavení linku v ms |

### RemoteLinkStats

Statistiky operací vzdáleného linkování.

```typescript
interface RemoteLinkStats {
  readonly initialized: boolean;
  readonly pendingCount: number;
  readonly activeLinkCount: number;
  readonly totalInitiated: number;
  readonly totalEstablished: number;
  readonly totalTimedOut: number;
  readonly totalUnlinked: number;
  readonly totalExitSignalsReceived: number;
  readonly totalExitSignalsSent: number;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `initialized` | `boolean` | Zda je modul inicializován |
| `pendingCount` | `number` | Čekající požadavky na link |
| `activeLinkCount` | `number` | Aktivní vzdálené linky |
| `totalInitiated` | `number` | Celkem iniciovaných požadavků |
| `totalEstablished` | `number` | Celkem úspěšně navázaných linků |
| `totalTimedOut` | `number` | Celkem linků, které timeouted |
| `totalUnlinked` | `number` | Celkem odstraněných linků přes unlink |
| `totalExitSignalsReceived` | `number` | Celkem přijatých exit signálů |
| `totalExitSignalsSent` | `number` | Celkem odeslaných exit signálů |

### ExitSignal

Exit signál doručený procesu s `trapExit` povoleným.

```typescript
interface ExitSignal {
  readonly type: 'EXIT';
  readonly from: SerializedRef;
  readonly reason: ProcessDownReason;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `type` | `'EXIT'` | Diskriminátor typu info zprávy |
| `from` | `SerializedRef` | Reference na linkovaný proces, který terminoval |
| `reason` | `ProcessDownReason` | Důvod terminace |

---

## Metody

### link()

Vytvoří obousměrný link mezi lokálním a vzdáleným procesem.

```typescript
async link(
  localRef: GenServerRef,
  remoteRef: GenServerRef,
  options?: RemoteLinkOptions,
): Promise<LinkRef>
```

**Parametry:**
- `localRef` - Reference na lokální proces
- `remoteRef` - Reference na vzdálený proces (musí mít `nodeId`)
- `options` - Volby linku

**Vrací:** Promise resolvující na LinkRef

**Vyhazuje:**
- `ClusterNotStartedError` - Cluster neběží
- `NodeNotReachableError` - Cílový uzel není připojený
- `RemoteLinkTimeoutError` - Nastavení linku timeouted

**Příklad:**
```typescript
const linkRef = await RemoteLink.link(localRef, remoteRef);
console.log(`Linked ${linkRef.ref1.id} <-> ${linkRef.ref2.id}`);
```

---

### unlink()

Odstraní vzdálený link.

```typescript
async unlink(linkRef: LinkRef): Promise<void>
```

**Parametry:**
- `linkRef` - Reference na link k odstranění

Odešle unlink požadavek na vzdálený uzel a odstraní link z lokálního registru. Pokud link neexistuje nebo byl již odstraněn, operace je no-op.

**Příklad:**
```typescript
await RemoteLink.unlink(linkRef);
```

---

### getStats()

Vrátí statistiky operací vzdáleného linkování.

```typescript
getStats(): RemoteLinkStats
```

**Příklad:**
```typescript
const stats = RemoteLink.getStats();
console.log(`Aktivní linky: ${stats.activeLinkCount}`);
console.log(`Exit signály přijaté: ${stats.totalExitSignalsReceived}`);
console.log(`Exit signály odeslané: ${stats.totalExitSignalsSent}`);
```

---

## Chybové třídy

### RemoteLinkTimeoutError

```typescript
class RemoteLinkTimeoutError extends Error {
  readonly name = 'RemoteLinkTimeoutError';
  readonly remoteRef: SerializedRef;
  readonly timeoutMs: number;
}
```

Vyhozena když nastavení vzdáleného linku timeouted.

---

## Protokol

Protokol vzdáleného linkování používá request/acknowledge handshake:

```
Node A                          Node B
  |                               |
  |-- link_request (linkId) ----->|  Ověří že cílový proces existuje
  |<-- link_ack (success) --------|  Obě strany registrují aktivní link
  |                               |
  |  ... proces na B crashne ...  |
  |                               |
  |<-- exit_signal (reason) ------|  Propagace exit signálu
  |                               |
  |  Lokální proces:              |
  |  - trapExit=true -> handleInfo(ExitSignal)
  |  - trapExit=false -> force terminate
```

---

## Propagace exit signálů

### Abnormální exit (crash, shutdown)

Exit signál se pošle na vzdálený peer:

```typescript
// Pokud Process A má trapExit: false (výchozí):
//   -> Process A je terminován

// Pokud Process A má trapExit: true:
//   -> Process A dostane ExitSignal přes handleInfo
const behavior = {
  init: () => ({ linkedProcesses: [] }),
  handleCast: (_msg, state) => state,
  handleInfo: (info: ExitSignal, state) => {
    if (info.type === 'EXIT') {
      console.log(`Linkovaný proces ${info.from.id} terminoval: ${info.reason.type}`);
    }
    return state;
  },
};

const ref = await GenServer.start(behavior, { trapExit: true });
```

### Normální exit

Normální exit se NEPROPAGUJE. Link je tiše odstraněn na obou stranách.

---

## Automatické čištění

### Při odpojení uzlu

Když se uzel odpojí, všechny linky na procesy na daném uzlu:
1. Jsou odstraněny z lokálního registru
2. Spustí `noconnection` exit signály na lokálních linkovaných procesech

### Při terminaci lokálního procesu

Když lokální linkovaný proces terminuje:
1. Exit signál je odeslán na vzdálený peer (pro abnormální exit)
2. Link je odstraněn z registru

---

## Kompletní příklad

```typescript
import { GenServer, type ExitSignal } from 'noex';
import { Cluster, RemoteLink, RemoteSpawn, BehaviorRegistry } from 'noex/distribution';

// Koordinátor, který linkuje ke vzdáleným workerům
const coordinatorBehavior = {
  init: () => ({ workers: new Map<string, LinkRef>() }),
  handleCast: (_msg: never, state) => state,
  handleInfo: (info: ExitSignal, state: { workers: Map<string, any> }) => {
    if (info.type === 'EXIT') {
      console.log(`Worker ${info.from.id} spadl: ${info.reason.type}`);
      // Odstranit z tracked workerů, případně spawn náhrady
    }
    return state;
  },
};

// Start s trapExit
const coordinator = await GenServer.start(coordinatorBehavior, { trapExit: true });

// Linkování ke vzdálenému procesu
const linkRef = await RemoteLink.link(coordinator, remoteWorkerRef);
// Pokud worker crashne -> koordinátor dostane ExitSignal
// Pokud koordinátor crashne -> worker je terminován
```

---

## Best Practices

- **Používejte trapExit** pro graceful zpracování pádu linkovaných procesů
- **Preferujte linky** pro těsně provázané procesy (worker + jeho connection handler)
- **Preferujte monitory** pro nezávislé pozorování (dashboard sledující služby)

---

## Související

- [Monitorování procesů](../guides/process-monitoring.md) - Monitoring vs Linking
- [RemoteMonitor API](./remote-monitor.md) - Jednosměrné monitorování procesů
- [Cluster API](./cluster.md) - Události uzlů
- [Typy Reference](./types.md) - Všechny distribuční typy

---

*[English version](../../../distribution/api/remote-link.md)*
