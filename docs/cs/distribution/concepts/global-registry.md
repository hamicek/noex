# Globální registr

`GlobalRegistry` poskytuje cluster-wide pojmenování procesů. Procesy mohou být registrovány pod globálním jménem a vyhledány z kteréhokoliv uzlu v clusteru.

## Architektura

### Distribuované úložiště

GlobalRegistry udržuje konzistentní pohled na registrované procesy napříč všemi uzly:

```
┌─────────────────────────────────────────────────────────────────┐
│                        GlobalRegistry                            │
│                                                                 │
│  ┌─────────────────────┐  ┌─────────────────────┐              │
│  │       Node A        │  │       Node B        │              │
│  │ ┌─────────────────┐ │  │ ┌─────────────────┐ │              │
│  │ │ "counter" → A   │ │  │ │ "counter" → A   │ │              │
│  │ │ "cache"   → B   │◄┼──┼►│ "cache"   → B   │ │              │
│  │ │ "logger"  → A   │ │  │ │ "logger"  → A   │ │              │
│  │ └─────────────────┘ │  │ └─────────────────┘ │              │
│  └─────────────────────┘  └─────────────────────┘              │
│           sync                    sync                         │
└─────────────────────────────────────────────────────────────────┘
```

### Synchronizace

Při připojení nového uzlu dojde k synchronizaci:

1. Nový uzel se připojí k clusteru
2. Ostatní uzly sdílejí své registrace
3. Konflikty jsou řešeny pomocí timestamp + node priority
4. Po synchronizaci mají všechny uzly stejná data

## Základní operace

### register()

Registrace procesu pod globálním jménem:

```typescript
import { GenServer } from 'noex';
import { Cluster, GlobalRegistry } from 'noex/distribution';

const ref = await GenServer.start(counterBehavior);

await GlobalRegistry.register('main-counter', {
  id: ref.id,
  nodeId: Cluster.getLocalNodeId(),
});
```

### lookup() a whereis()

Vyhledání registrovaného procesu:

```typescript
// lookup() - vyhodí výjimku pokud neexistuje
try {
  const ref = GlobalRegistry.lookup('main-counter');
  await RemoteCall.call(ref, { type: 'get' });
} catch (error) {
  if (error instanceof GlobalNameNotFoundError) {
    console.log('Služba není registrována');
  }
}

// whereis() - vrátí undefined pokud neexistuje
const ref = GlobalRegistry.whereis('main-counter');
if (ref) {
  await RemoteCall.call(ref, { type: 'get' });
} else {
  console.log('Služba není dostupná');
}
```

### unregister()

Odregistrování procesu:

```typescript
await GlobalRegistry.unregister('main-counter');
```

**Poznámka:** Pouze vlastnící uzel může odregistrovat proces.

### isRegistered()

Kontrola existence registrace:

```typescript
if (!GlobalRegistry.isRegistered('main-counter')) {
  await GlobalRegistry.register('main-counter', ref);
}
```

### getNames()

Seznam všech registrovaných jmen:

```typescript
const names = GlobalRegistry.getNames();
console.log('Registrované služby:', names.join(', '));
```

## Řešení konfliktů

Při současné registraci stejného jména z více uzlů:

### Pravidla priority

1. **Timestamp vyhrává** - Dřívější registrace (nižší `registeredAt`) má prioritu
2. **Tiebreaker** - Při shodném timestampu rozhoduje priorita uzlu (hash NodeId)

```
Uzel A: register("service", ref_a) @ T=100
Uzel B: register("service", ref_b) @ T=100
                                      │
                                      ▼
                        Timestamp shodný → použij node priority
                                      │
                                      ▼
                        hash("nodeA") < hash("nodeB")
                                      │
                                      ▼
                              ref_a vyhrává
```

### Sledování konfliktů

```typescript
GlobalRegistry.on('conflictResolved', (name, winner, loser) => {
  console.log(`Konflikt pro '${name}':`);
  console.log(`  Vítěz: ${winner.id}@${winner.nodeId}`);
  console.log(`  Poražený: ${loser.id}@${loser.nodeId}`);
});
```

## Automatické čištění

### Při pádu uzlu

Když uzel spadne, všechny jeho registrace jsou automaticky odstraněny:

```typescript
Cluster.onNodeDown((nodeId, reason) => {
  console.log(`Uzel ${nodeId} odpojen - jeho registrace budou odstraněny`);
});
```

### Při ukončení procesu

Registrace **nejsou** automaticky odstraněny při ukončení procesu. Je nutné explicitní odregistrování:

```typescript
// V terminate() callback behaviour
terminate: (reason, state) => {
  // Toto se volá při ukončení serveru
  // Registrace musí být odstraněna manuálně
},

// Nebo před stopem
await GlobalRegistry.unregister('my-service');
await GenServer.stop(ref);
```

## Vzory použití

### Service Discovery

```typescript
// Registrace služby při startu
async function startService(name: string, behavior: GenServerBehavior) {
  const ref = await GenServer.start(behavior);

  await GlobalRegistry.register(name, {
    id: ref.id,
    nodeId: Cluster.getLocalNodeId(),
  });

  return ref;
}

// Vyhledání služby
async function findService(name: string): Promise<SerializedRef | null> {
  return GlobalRegistry.whereis(name) ?? null;
}
```

### Leader Election (jednoduchá varianta)

```typescript
async function tryBecomeLeader(): Promise<boolean> {
  const ref = await GenServer.start(leaderBehavior);

  try {
    await GlobalRegistry.register('leader', {
      id: ref.id,
      nodeId: Cluster.getLocalNodeId(),
    });
    console.log('Stal jsem se leaderem');
    return true;
  } catch (error) {
    if (error instanceof GlobalNameConflictError) {
      console.log(`Leader už existuje na ${error.existingNodeId}`);
      await GenServer.stop(ref);
      return false;
    }
    throw error;
  }
}
```

### Namespacing služeb

```typescript
// Použití prefixů pro organizaci
const SERVICE_PREFIXES = {
  WORKER: 'worker:',
  CACHE: 'cache:',
  QUEUE: 'queue:',
} as const;

// Registrace
await GlobalRegistry.register(`${SERVICE_PREFIXES.WORKER}pool-1`, ref);

// Vyhledání všech workerů
const workerNames = GlobalRegistry.getNames()
  .filter((name) => name.startsWith(SERVICE_PREFIXES.WORKER));
```

### Safe Registration

```typescript
async function registerIfNotExists(
  name: string,
  ref: SerializedRef,
): Promise<boolean> {
  if (GlobalRegistry.isRegistered(name)) {
    return false; // Už existuje
  }

  try {
    await GlobalRegistry.register(name, ref);
    return true;
  } catch (error) {
    if (error instanceof GlobalNameConflictError) {
      return false; // Race condition - někdo byl rychlejší
    }
    throw error;
  }
}
```

## Statistiky

```typescript
const stats = GlobalRegistry.getStats();

console.log(`Celkem registrací: ${stats.totalRegistrations}`);
console.log(`Lokálních: ${stats.localRegistrations}`);
console.log(`Vzdálených: ${stats.remoteRegistrations}`);
console.log(`Synchronizací: ${stats.syncOperations}`);
console.log(`Vyřešených konfliktů: ${stats.conflictsResolved}`);
```

## Best practices

### 1. Používejte popisná, jmenná jména

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

### 4. Monitorujte registrace

```typescript
GlobalRegistry.on('registered', (name, ref) => {
  console.log(`Registrováno: ${name} → ${ref.id}@${ref.nodeId}`);
});

GlobalRegistry.on('unregistered', (name, ref) => {
  console.log(`Odregistrováno: ${name}`);
});
```

## Související

- [GlobalRegistry API Reference](../api/global-registry.md) - Kompletní API
- [RemoteCall](./remote-messaging.md) - Volání registrovaných služeb
- [RemoteSpawn](../api/remote-spawn.md) - Spawn s automatickou registrací

---

*[English version](../../../distribution/concepts/global-registry.md)*
