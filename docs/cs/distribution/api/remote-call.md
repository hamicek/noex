# RemoteCall API Reference

Objekt `RemoteCall` poskytuje transparentní předávání zpráv mezi GenServer instancemi napříč uzly clusteru. Zpracovává serializaci, správu timeoutů a ošetření chyb pro mezinodovou komunikaci.

## Import

```typescript
import { RemoteCall } from 'noex/distribution';
```

## Typy

### SerializedRef

Serializovatelná reprezentace GenServerRef pro síťový přenos.

```typescript
interface SerializedRef {
  readonly id: string;
  readonly nodeId: NodeId;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `id` | `string` | Identifikátor GenServer instance |
| `nodeId` | `NodeId` | Uzel kde GenServer běží |

### RemoteCallOptions

Volby pro vzdálená volání.

```typescript
interface RemoteCallOptions {
  readonly timeout?: number;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| `timeout` | `number` | `5000` | Timeout v milisekundách |

### RemoteCallStats

Statistiky o vzdálených voláních.

```typescript
interface RemoteCallStats {
  readonly pendingCalls: number;
  readonly totalCalls: number;
  readonly totalResolved: number;
  readonly totalRejected: number;
  readonly totalTimedOut: number;
  readonly totalCasts: number;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `pendingCalls` | `number` | Počet volání čekajících na odpověď |
| `totalCalls` | `number` | Celkem iniciovaných volání |
| `totalResolved` | `number` | Celkem úspěšně vyřešených volání |
| `totalRejected` | `number` | Celkem odmítnutých volání s chybou |
| `totalTimedOut` | `number` | Celkem volání která vypršela |
| `totalCasts` | `number` | Celkem odeslaných castů |

---

## Metody

### call()

Odešle synchronní volání vzdálenému GenServeru a čeká na odpověď.

```typescript
async call<CallReply>(
  ref: SerializedRef,
  msg: unknown,
  options?: RemoteCallOptions,
): Promise<CallReply>
```

**Parametry:**
- `ref` - Serializovaná reference na cílový GenServer
- `msg` - Zpráva k odeslání (musí být serializovatelná)
- `options` - Volby volání

**Vrací:** Promise s odpovědí

**Vyhodí:**
- `ClusterNotStartedError` - Pokud cluster neběží
- `NodeNotReachableError` - Pokud cílový uzel není připojen
- `RemoteCallTimeoutError` - Pokud volání vypršelo
- `RemoteServerNotRunningError` - Pokud cílový server neběží

**Příklad:**
```typescript
const ref: SerializedRef = {
  id: 'counter-1',
  nodeId: NodeId.parse('worker@192.168.1.10:4369'),
};

try {
  const count = await RemoteCall.call<number>(ref, { type: 'get' });
  console.log(`Aktuální hodnota: ${count}`);
} catch (error) {
  if (error instanceof RemoteCallTimeoutError) {
    console.log('Volání vypršelo');
  }
}
```

**S timeoutem:**
```typescript
const result = await RemoteCall.call(ref, message, { timeout: 10000 });
```

---

### cast()

Odešle asynchronní cast (fire-and-forget) vzdálenému GenServeru.

```typescript
cast(ref: SerializedRef, msg: unknown): void
```

**Parametry:**
- `ref` - Serializovaná reference na cílový GenServer
- `msg` - Zpráva k odeslání (musí být serializovatelná)

Cast je tiše zahozen pokud:
- Cluster neběží
- Cílový uzel není připojen

**Příklad:**
```typescript
const ref: SerializedRef = {
  id: 'counter-1',
  nodeId: NodeId.parse('worker@192.168.1.10:4369'),
};

// Fire and forget
RemoteCall.cast(ref, { type: 'increment' });
```

---

### getStats()

Vrátí statistiky o vzdálených voláních.

```typescript
getStats(): RemoteCallStats
```

**Vrací:** Objekt se statistikami

**Příklad:**
```typescript
const stats = RemoteCall.getStats();
console.log(`Čekající: ${stats.pendingCalls}`);
console.log(`Úspěšnost: ${stats.totalResolved / stats.totalCalls * 100}%`);
```

---

## Chybové třídy

### RemoteCallTimeoutError

```typescript
class RemoteCallTimeoutError extends Error {
  readonly name = 'RemoteCallTimeoutError';
  readonly serverId: string;
  readonly nodeId: NodeId;
  readonly timeoutMs: number;
}
```

Vyhodí se když vzdálené volání neobdrží odpověď v rámci timeoutu.

### RemoteServerNotRunningError

```typescript
class RemoteServerNotRunningError extends Error {
  readonly name = 'RemoteServerNotRunningError';
  readonly serverId: string;
  readonly nodeId: NodeId;
}
```

Vyhodí se když cílový GenServer neběží na vzdáleném uzlu.

### NodeNotReachableError

```typescript
class NodeNotReachableError extends Error {
  readonly name = 'NodeNotReachableError';
  readonly nodeId: NodeId;
}
```

Vyhodí se když cílový uzel není připojen.

---

## Kompletní příklad

```typescript
import { Cluster, RemoteCall, GlobalRegistry, NodeId } from 'noex/distribution';
import type { SerializedRef } from 'noex/distribution';

// Typy zpráv counteru
type CounterCall = { type: 'get' } | { type: 'increment' };
type CounterReply = number;

async function main() {
  await Cluster.start({
    nodeName: 'client',
    seeds: ['server@192.168.1.10:4369'],
  });

  // Čekání na spojení
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Získání reference z global registry
  const counterRef = GlobalRegistry.whereis('main-counter');
  if (!counterRef) {
    console.log('Counter není registrován');
    return;
  }

  // Vzdálená volání
  try {
    // Získání aktuální hodnoty
    const count = await RemoteCall.call<CounterReply>(
      counterRef,
      { type: 'get' },
      { timeout: 5000 },
    );
    console.log(`Počáteční hodnota: ${count}`);

    // Increment (cast pro fire-and-forget)
    RemoteCall.cast(counterRef, { type: 'increment' });
    RemoteCall.cast(counterRef, { type: 'increment' });
    RemoteCall.cast(counterRef, { type: 'increment' });

    // Malá pauza pro zpracování castů
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Získání nové hodnoty
    const newCount = await RemoteCall.call<CounterReply>(
      counterRef,
      { type: 'get' },
    );
    console.log(`Nová hodnota: ${newCount}`);

  } catch (error) {
    if (error instanceof RemoteCallTimeoutError) {
      console.error(`Timeout volání ${error.serverId} na ${error.nodeId}`);
    } else if (error instanceof RemoteServerNotRunningError) {
      console.error(`Server ${error.serverId} neběží na ${error.nodeId}`);
    } else if (error instanceof NodeNotReachableError) {
      console.error(`Uzel ${error.nodeId} není dostupný`);
    } else {
      throw error;
    }
  }

  // Statistiky
  const stats = RemoteCall.getStats();
  console.log(`\nStatistiky vzdálených volání:`);
  console.log(`  Celkem volání: ${stats.totalCalls}`);
  console.log(`  Úspěšných: ${stats.totalResolved}`);
  console.log(`  Celkem castů: ${stats.totalCasts}`);

  await Cluster.stop();
}

main().catch(console.error);
```

---

## Serializace

Zprávy odesílané přes `RemoteCall.call()` a `RemoteCall.cast()` musí být serializovatelné:

**Podporované typy:**
- Primitiva: `string`, `number`, `boolean`, `null`, `undefined`
- Pole a prosté objekty
- `Date` objekty
- `Map` a `Set`
- `Buffer` a `Uint8Array`

**Nepodporované:**
- Funkce
- Instance tříd (pokud nemají custom serializaci)
- Symboly
- `WeakMap` a `WeakSet`
- Cyklické reference

---

## Best practices

### 1. Konfigurace timeoutů

```typescript
// Rychlý lookup
const value = await RemoteCall.call(ref, { type: 'get' }, { timeout: 1000 });

// Dlouhá operace
const result = await RemoteCall.call(ref, { type: 'compute', data }, { timeout: 30000 });
```

### 2. Ošetření chyb

```typescript
async function safeRemoteCall<T>(ref: SerializedRef, msg: unknown): Promise<T | null> {
  try {
    return await RemoteCall.call<T>(ref, msg);
  } catch (error) {
    if (error instanceof NodeNotReachableError) {
      // Uzel je down, možná trigger failover
      return null;
    }
    if (error instanceof RemoteCallTimeoutError) {
      // Pomalá odpověď, možná retry
      return null;
    }
    throw error; // Neočekávaná chyba
  }
}
```

### 3. Preferujte cast pro fire-and-forget

```typescript
// Dobře: fire-and-forget pro notifikace
RemoteCall.cast(loggerRef, { type: 'log', message: 'User logged in' });

// Zbytečné: čekání na potvrzení které nepotřebujete
await RemoteCall.call(loggerRef, { type: 'log', message: 'User logged in' });
```

---

## Související

- [Vzdálené zasílání zpráv koncepty](../concepts/remote-messaging.md) - Pochopení vzdálené komunikace
- [Cluster API](./cluster.md) - Správa životního cyklu clusteru
- [GlobalRegistry API](./global-registry.md) - Cluster-wide pojmenování
- [Typy Reference](./types.md) - Všechny distribuční typy

---

*[English version](../../../distribution/api/remote-call.md)*
