# GlobalRegistry API Reference

Singleton `GlobalRegistry` poskytuje cluster-wide registraci jmen pro procesy, umožňující vyhledání GenServer referencí napříč všemi uzly.

## Import

```typescript
import { GlobalRegistry } from 'noex/distribution';
```

## Přehled

GlobalRegistry poskytuje:
- Unikátní globální jména napříč všemi uzly
- Automatickou synchronizaci při připojení uzlu
- Řešení konfliktů pomocí timestamp + node priority
- Automatické čištění při pádu uzlu

---

## Typy

### GlobalRegistryStats

Statistiky o globálním registru.

```typescript
interface GlobalRegistryStats {
  readonly totalRegistrations: number;
  readonly localRegistrations: number;
  readonly remoteRegistrations: number;
  readonly syncOperations: number;
  readonly conflictsResolved: number;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `totalRegistrations` | `number` | Celkový počet globálních registrací |
| `localRegistrations` | `number` | Registrace vlastněné tímto uzlem |
| `remoteRegistrations` | `number` | Registrace vlastněné jinými uzly |
| `syncOperations` | `number` | Počet dokončených sync operací |
| `conflictsResolved` | `number` | Počet vyřešených konfliktů |

---

## Metody

### register()

Registruje proces globálně napříč clusterem.

```typescript
async register(name: string, ref: SerializedRef): Promise<void>
```

**Parametry:**
- `name` - Unikátní jméno pro registraci
- `ref` - Serializovaná reference na proces

**Vyhodí:**
- `GlobalNameConflictError` - Pokud jméno je již registrované jiným uzlem

Registrace je broadcastována všem připojeným uzlům. Pokud jméno již existuje, konflikt je vyřešen pomocí timestampu a priority uzlu - dřívější registrace vyhrává.

**Příklad:**
```typescript
import { GenServer } from 'noex';
import { Cluster, GlobalRegistry } from 'noex/distribution';

const ref = await GenServer.start(counterBehavior);

await GlobalRegistry.register('main-counter', {
  id: ref.id,
  nodeId: Cluster.getLocalNodeId(),
});
```

---

### unregister()

Odregistruje globálně registrovaný proces.

```typescript
async unregister(name: string): Promise<void>
```

**Parametry:**
- `name` - Jméno registrace k odebrání

Pouze vlastnící uzel může odregistrovat proces. Pokud jméno není registrované nebo je vlastněné jiným uzlem, operace je no-op.

**Příklad:**
```typescript
await GlobalRegistry.unregister('main-counter');
```

---

### lookup()

Vyhledá globálně registrovaný proces.

```typescript
lookup(name: string): SerializedRef
```

**Parametry:**
- `name` - Jméno k vyhledání

**Vrací:** Serializovanou referenci

**Vyhodí:**
- `GlobalNameNotFoundError` - Pokud jméno není registrované

**Příklad:**
```typescript
try {
  const ref = GlobalRegistry.lookup('main-counter');
  await RemoteCall.call(ref, { type: 'get' });
} catch (error) {
  if (error instanceof GlobalNameNotFoundError) {
    console.log('Služba není registrována');
  }
}
```

---

### whereis()

Vyhledá globálně registrovaný proces, vrátí undefined pokud nenalezen.

```typescript
whereis(name: string): SerializedRef | undefined
```

**Parametry:**
- `name` - Jméno k vyhledání

**Vrací:** Serializovanou referenci pokud nalezena, jinak undefined

Toto je bezpečnější alternativa k `lookup()` když si nejste jisti zda jméno existuje.

**Příklad:**
```typescript
const ref = GlobalRegistry.whereis('main-counter');
if (ref) {
  const result = await RemoteCall.call(ref, { type: 'get' });
} else {
  console.log('Counter není registrován');
}
```

---

### isRegistered()

Zkontroluje zda je jméno globálně registrované.

```typescript
isRegistered(name: string): boolean
```

**Parametry:**
- `name` - Jméno ke kontrole

**Vrací:** `true` pokud je jméno registrované

**Příklad:**
```typescript
if (!GlobalRegistry.isRegistered('main-counter')) {
  await GlobalRegistry.register('main-counter', ref);
}
```

---

### getNames()

Vrátí všechna registrovaná jména.

```typescript
getNames(): readonly string[]
```

**Vrací:** Pole všech registrovaných jmen

**Příklad:**
```typescript
const names = GlobalRegistry.getNames();
console.log(`Registrované služby: ${names.join(', ')}`);
```

---

### count()

Vrátí počet globálních registrací.

```typescript
count(): number
```

**Vrací:** Celkový počet registrací

---

### getStats()

Vrátí statistiky o globálním registru.

```typescript
getStats(): GlobalRegistryStats
```

**Příklad:**
```typescript
const stats = GlobalRegistry.getStats();
console.log(`Celkem: ${stats.totalRegistrations}`);
console.log(`Lokálních: ${stats.localRegistrations}`);
console.log(`Vzdálených: ${stats.remoteRegistrations}`);
console.log(`Synchronizací: ${stats.syncOperations}`);
console.log(`Konfliktů: ${stats.conflictsResolved}`);
```

---

## Chybové třídy

### GlobalNameConflictError

```typescript
class GlobalNameConflictError extends Error {
  readonly name = 'GlobalNameConflictError';
  readonly registryName: string;
  readonly existingNodeId: NodeId;
}
```

Vyhodí se při pokusu o registraci jména které již existuje.

### GlobalNameNotFoundError

```typescript
class GlobalNameNotFoundError extends Error {
  readonly name = 'GlobalNameNotFoundError';
  readonly registryName: string;
}
```

Vyhodí se při vyhledání jména které není registrované.

---

## Kompletní příklad

```typescript
import { GenServer } from 'noex';
import {
  Cluster,
  GlobalRegistry,
  RemoteCall,
  GlobalNameConflictError,
  GlobalNameNotFoundError,
} from 'noex/distribution';

// Counter behaviour
const counterBehavior = {
  init: () => 0,
  handleCall: (msg: 'get' | 'inc', state: number) => {
    if (msg === 'get') return [state, state];
    return [state + 1, state + 1];
  },
  handleCast: (_msg: never, state: number) => state,
};

async function main() {
  await Cluster.start({
    nodeName: 'node1',
    port: 4369,
    seeds: ['node2@192.168.1.2:4369'],
  });

  // Start lokálního counteru
  const counterRef = await GenServer.start(counterBehavior);

  // Globální registrace
  try {
    await GlobalRegistry.register('counter', {
      id: counterRef.id,
      nodeId: Cluster.getLocalNodeId(),
    });
    console.log('Counter registrován globálně');
  } catch (error) {
    if (error instanceof GlobalNameConflictError) {
      console.log(`Counter již registrován na ${error.existingNodeId}`);
    } else {
      throw error;
    }
  }

  // Čekání na další uzly
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Seznam všech registrací
  console.log('\nGlobální registrace:');
  for (const name of GlobalRegistry.getNames()) {
    const ref = GlobalRegistry.lookup(name);
    console.log(`  ${name} -> ${ref.id}@${ref.nodeId}`);
  }

  // Použití registrované služby
  const cacheRef = GlobalRegistry.whereis('cache');
  if (cacheRef) {
    const value = await RemoteCall.call(cacheRef, { type: 'get', key: 'user:1' });
    console.log(`Cache hodnota: ${value}`);
  }

  // Statistiky
  const stats = GlobalRegistry.getStats();
  console.log(`\nStatistiky registru:`);
  console.log(`  Celkem registrací: ${stats.totalRegistrations}`);
  console.log(`  Lokálních: ${stats.localRegistrations}`);
  console.log(`  Vzdálených: ${stats.remoteRegistrations}`);

  // Čištění při shutdownu
  process.on('SIGINT', async () => {
    await GlobalRegistry.unregister('counter');
    await Cluster.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Řešení konfliktů

Když dva uzly pokusí registrovat stejné jméno současně:

1. **Timestamp vyhrává**: Dřívější registrace (nižší `registeredAt`) vyhrává
2. **Priority tiebreaker**: Při shodném timestampu rozhoduje nižší priorita uzlu (deterministický hash NodeId)

Prohrávající registrace je automaticky odstraněna na konfliktním uzlu.

```typescript
// Sledování řešení konfliktů
GlobalRegistry.on('conflictResolved', (name, winner, loser) => {
  console.log(`Konflikt pro '${name}':`);
  console.log(`  Vítěz: ${winner.id}@${winner.nodeId}`);
  console.log(`  Poražený: ${loser.id}@${loser.nodeId}`);
});
```

---

## Automatické čištění

GlobalRegistry automaticky čistí registrace když:

1. **Uzel spadne**: Všechny registrace z toho uzlu jsou odstraněny
2. **Proces skončí**: Je nutné manuální odregistrování (není automatické)

---

## Best practices

### 1. Používejte popisná jména

```typescript
// Dobře: popisné, s namespace
await GlobalRegistry.register('service:counter:main', ref);
await GlobalRegistry.register('worker:pool:images', ref);

// Špatně: generická, náchylná ke kolizi
await GlobalRegistry.register('counter', ref);
await GlobalRegistry.register('worker', ref);
```

### 2. Preferujte whereis() před lookup()

```typescript
// Dobře: graceful handling
const ref = GlobalRegistry.whereis('optional-service');
if (ref) {
  await RemoteCall.call(ref, message);
}

// Horší: exception-based flow
try {
  const ref = GlobalRegistry.lookup('optional-service');
  await RemoteCall.call(ref, message);
} catch (e) {
  // Handle missing
}
```

### 3. Čistěte při shutdownu

```typescript
const registeredNames: string[] = [];

async function registerService(name: string, ref: SerializedRef): Promise<void> {
  await GlobalRegistry.register(name, ref);
  registeredNames.push(name);
}

async function shutdown(): Promise<void> {
  for (const name of registeredNames) {
    await GlobalRegistry.unregister(name);
  }
  await Cluster.stop();
}
```

---

## Související

- [GlobalRegistry koncepty](../concepts/global-registry.md) - Pochopení cluster-wide pojmenování
- [RemoteCall API](./remote-call.md) - Volání registrovaných procesů
- [Cluster API](./cluster.md) - Životní cyklus clusteru
- [Typy Reference](./types.md) - Všechny distribuční typy

---

*[English version](../../../distribution/api/global-registry.md)*
