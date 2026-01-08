# Vzdálené zasílání zpráv

Vzdálené zasílání zpráv umožňuje transparentní komunikaci mezi GenServery na různých uzlech clusteru. Modul `RemoteCall` poskytuje stejné call/cast API jako lokální GenServer.

## Architektura

### Tok zpráv

```
┌────────────────────┐                      ┌────────────────────┐
│      Node A        │                      │      Node B        │
│  ┌──────────────┐  │                      │  ┌──────────────┐  │
│  │   Klient     │  │   1. call(ref, msg)  │  │    Server    │  │
│  │  GenServer   │──┼─────────────────────►│  │   GenServer  │  │
│  └──────────────┘  │                      │  └──────────────┘  │
│         │          │                      │         │          │
│         │          │   2. handleCall      │         │          │
│         │          │      zpracování      │         │          │
│         │          │                      │         │          │
│         ▼          │   3. reply           │         │          │
│  ┌──────────────┐  │◄─────────────────────┤─────────┘          │
│  │   Výsledek   │  │                      │                    │
│  └──────────────┘  │                      │                    │
└────────────────────┘                      └────────────────────┘
```

### Serializace

Zprávy jsou serializovány pro přenos po síti. Podporované typy:

| Typ | Podpora |
|-----|---------|
| `string`, `number`, `boolean` | Plná |
| `null`, `undefined` | Plná |
| Pole a objekty | Plná |
| `Date` | Plná |
| `Map`, `Set` | Plná |
| `Buffer`, `Uint8Array` | Plná |
| Funkce | Ne |
| Class instance | Ne (bez custom serializace) |
| `Symbol` | Ne |
| `WeakMap`, `WeakSet` | Ne |
| Cyklické reference | Ne |

## RemoteCall

### call()

Synchronní volání se čekáním na odpověď:

```typescript
import { RemoteCall } from 'noex/distribution';

const result = await RemoteCall.call<ResponseType>(
  ref,           // SerializedRef cílového serveru
  message,       // Zpráva k odeslání
  { timeout: 5000 },  // Volitelné options
);
```

**Vlastnosti:**
- Blokující - čeká na odpověď
- Podporuje timeout
- Při chybě vyhodí výjimku

### cast()

Asynchronní "fire-and-forget" zpráva:

```typescript
RemoteCall.cast(ref, message);
```

**Vlastnosti:**
- Neblokující
- Žádná odpověď
- Tiché selhání při nedostupnosti

### Kdy použít call vs cast

| Scénář | Doporučení |
|--------|------------|
| Potřebuji výsledek | `call()` |
| Notifikace/události | `cast()` |
| Logování | `cast()` |
| Kritické operace | `call()` |
| Vysoká propustnost | `cast()` (pokud možno) |

## SerializedRef

Reference na vzdálený proces:

```typescript
interface SerializedRef {
  readonly id: string;        // ID GenServeru
  readonly nodeId: NodeId;    // ID uzlu
}
```

### Získání reference

```typescript
// Z GlobalRegistry
const ref = GlobalRegistry.whereis('my-service');

// Z RemoteSpawn výsledku
const result = await RemoteSpawn.spawn('behavior', nodeId);
const ref: SerializedRef = {
  id: result.serverId,
  nodeId: result.nodeId,
};

// Manuální vytvoření (pokud znáte ID)
const ref: SerializedRef = {
  id: 'known-server-id',
  nodeId: NodeId.parse('node@host:port'),
};
```

## Chybové stavy

### NodeNotReachableError

Uzel není připojený:

```typescript
try {
  await RemoteCall.call(ref, message);
} catch (error) {
  if (error instanceof NodeNotReachableError) {
    console.log(`Uzel ${error.nodeId} není dostupný`);
    // Možná akce: zkusit jiný uzel, fallback, alert
  }
}
```

### RemoteCallTimeoutError

Volání překročilo timeout:

```typescript
try {
  await RemoteCall.call(ref, message, { timeout: 1000 });
} catch (error) {
  if (error instanceof RemoteCallTimeoutError) {
    console.log(`Timeout po ${error.timeoutMs}ms`);
    console.log(`Server: ${error.serverId}`);
    console.log(`Uzel: ${error.nodeId}`);
  }
}
```

### RemoteServerNotRunningError

GenServer na cílovém uzlu neexistuje:

```typescript
try {
  await RemoteCall.call(ref, message);
} catch (error) {
  if (error instanceof RemoteServerNotRunningError) {
    console.log(`Server ${error.serverId} neběží na ${error.nodeId}`);
  }
}
```

## Vzory použití

### Request-Response

Základní vzor pro synchronní operace:

```typescript
async function getRemoteCounter(ref: SerializedRef): Promise<number> {
  try {
    return await RemoteCall.call<number>(ref, { type: 'get' });
  } catch (error) {
    if (error instanceof NodeNotReachableError) {
      throw new Error('Služba nedostupná');
    }
    throw error;
  }
}
```

### Fire-and-Forget s potvrzením

Pro důležité operace kde nechcete blokovat:

```typescript
// Odešli zprávu
RemoteCall.cast(ref, { type: 'process', data });

// Později ověř stav
const status = await RemoteCall.call<Status>(ref, { type: 'status' });
```

### Broadcast

Odeslání zprávy více serverům:

```typescript
async function broadcastToAll(
  refs: SerializedRef[],
  message: unknown,
): Promise<void> {
  // Paralelní cast - rychlé, bez čekání
  for (const ref of refs) {
    RemoteCall.cast(ref, message);
  }
}

async function callAll<T>(
  refs: SerializedRef[],
  message: unknown,
): Promise<Map<string, T | Error>> {
  const results = new Map<string, T | Error>();

  await Promise.all(
    refs.map(async (ref) => {
      try {
        const result = await RemoteCall.call<T>(ref, message);
        results.set(ref.id, result);
      } catch (error) {
        results.set(ref.id, error as Error);
      }
    }),
  );

  return results;
}
```

### Retry s exponenciálním backoff

```typescript
async function callWithRetry<T>(
  ref: SerializedRef,
  message: unknown,
  maxRetries = 3,
): Promise<T> {
  let lastError: Error;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await RemoteCall.call<T>(ref, message);
    } catch (error) {
      lastError = error as Error;

      if (error instanceof RemoteServerNotRunningError) {
        // Server neexistuje - retry nepomůže
        throw error;
      }

      if (attempt < maxRetries) {
        // Exponenciální backoff
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError!;
}
```

## Statistiky

```typescript
const stats = RemoteCall.getStats();

console.log(`Čekající volání: ${stats.pendingCalls}`);
console.log(`Celkem volání: ${stats.totalCalls}`);
console.log(`Úspěšných: ${stats.totalResolved}`);
console.log(`Odmítnutých: ${stats.totalRejected}`);
console.log(`Timeout: ${stats.totalTimedOut}`);
console.log(`Celkem castů: ${stats.totalCasts}`);

// Výpočet success rate
const successRate = stats.totalResolved / stats.totalCalls * 100;
console.log(`Úspěšnost: ${successRate.toFixed(1)}%`);
```

## Best practices

### 1. Vždy nastavujte rozumné timeouty

```typescript
// Pro rychlé operace
await RemoteCall.call(ref, { type: 'get' }, { timeout: 1000 });

// Pro dlouhé operace
await RemoteCall.call(ref, { type: 'compute', data }, { timeout: 30000 });
```

### 2. Preferujte cast pro fire-and-forget

```typescript
// Dobře: použití cast pro logování
RemoteCall.cast(loggerRef, { type: 'log', message: 'Event occurred' });

// Zbytečné: čekání na odpověď pro logování
await RemoteCall.call(loggerRef, { type: 'log', message: 'Event occurred' });
```

### 3. Ošetřujte všechny typy chyb

```typescript
async function safeCall<T>(ref: SerializedRef, msg: unknown): Promise<T | null> {
  try {
    return await RemoteCall.call<T>(ref, msg);
  } catch (error) {
    if (error instanceof NodeNotReachableError) {
      metrics.increment('remote_call.node_unreachable');
      return null;
    }
    if (error instanceof RemoteCallTimeoutError) {
      metrics.increment('remote_call.timeout');
      return null;
    }
    if (error instanceof RemoteServerNotRunningError) {
      metrics.increment('remote_call.server_not_running');
      return null;
    }
    throw error;
  }
}
```

### 4. Používejte GlobalRegistry pro služby

```typescript
// Místo předávání raw referencí
const cacheRef = GlobalRegistry.whereis('cache-service');
if (cacheRef) {
  const value = await RemoteCall.call(cacheRef, { type: 'get', key });
}
```

## Související

- [RemoteCall API Reference](../api/remote-call.md) - Kompletní API
- [GlobalRegistry](./global-registry.md) - Vyhledávání služeb
- [Vzdálené procesy (návod)](../guides/remote-processes.md) - Praktický návod

---

*[English version](../../../distribution/concepts/remote-messaging.md)*
