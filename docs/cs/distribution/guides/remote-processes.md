# Vzdálené procesy

Tento návod pokrývá spouštění a správu procesů na vzdálených uzlech pomocí `RemoteSpawn` a `BehaviorRegistry`.

## Jak funguje RemoteSpawn

Protože JavaScript funkce nelze serializovat, RemoteSpawn používá jiný přístup:

1. **Behaviour registrace** - Behaviour musí být registrované na všech uzlech
2. **Jmenný spawn** - Spawn požadavek obsahuje pouze jméno behaviour
3. **Lokální vytvoření** - Cílový uzel vytvoří proces z registrovaného behaviour

```
┌─────────────────────┐                    ┌─────────────────────┐
│       Node A        │                    │       Node B        │
│                     │  spawn("worker")   │                     │
│  RemoteSpawn.spawn ─┼───────────────────►│  BehaviorRegistry   │
│                     │                    │  .get("worker")     │
│                     │                    │         │           │
│                     │  SpawnResult       │         ▼           │
│                    ◄┼────────────────────┤  GenServer.start()  │
│                     │                    │         │           │
│                     │                    │    ┌────▼────┐      │
│                     │                    │    │ Worker  │      │
│                     │                    │    └─────────┘      │
└─────────────────────┘                    └─────────────────────┘
```

## BehaviorRegistry

### Registrace behaviour

**Důležité:** Behaviour musí být registrované na VŠECH uzlech kde mohou být spawnovány!

```typescript
import { BehaviorRegistry } from 'noex/distribution';

// shared/behaviors.ts - importujte na každém uzlu
const workerBehavior = {
  init: () => ({ processed: 0 }),
  handleCall: (msg: 'status', state) => [state.processed, state],
  handleCast: (msg: 'work', state) => ({ processed: state.processed + 1 }),
};

BehaviorRegistry.register('worker', workerBehavior);
```

### Sdílená definice

Doporučený vzor pro konzistenci:

```typescript
// shared/behaviors.ts
import type { GenServerBehavior } from 'noex';

export const BEHAVIOR_NAMES = {
  WORKER: 'worker',
  CACHE: 'cache',
  COORDINATOR: 'coordinator',
} as const;

export const workerBehavior: GenServerBehavior<...> = { ... };
export const cacheBehavior: GenServerBehavior<...> = { ... };
export const coordinatorBehavior: GenServerBehavior<...> = { ... };

export function registerAllBehaviors(): void {
  BehaviorRegistry.register(BEHAVIOR_NAMES.WORKER, workerBehavior);
  BehaviorRegistry.register(BEHAVIOR_NAMES.CACHE, cacheBehavior);
  BehaviorRegistry.register(BEHAVIOR_NAMES.COORDINATOR, coordinatorBehavior);
}

// main.ts (na každém uzlu)
import { registerAllBehaviors } from './shared/behaviors.js';

registerAllBehaviors();
await Cluster.start(config);
```

## Základní spawn

### Jednoduchý spawn

```typescript
import { RemoteSpawn } from 'noex/distribution';

const result = await RemoteSpawn.spawn('worker', targetNodeId);

console.log(`Spawned: ${result.serverId} na ${result.nodeId}`);

// Vytvoření reference pro komunikaci
const ref: SerializedRef = {
  id: result.serverId,
  nodeId: result.nodeId,
};

// Použití
RemoteCall.cast(ref, 'work');
```

### Spawn s registrací

```typescript
// Lokální registrace (viditelná pouze na cílovém uzlu)
const result = await RemoteSpawn.spawn('worker', targetNodeId, {
  name: 'my-worker',
  registration: 'local',
});

// Globální registrace (viditelná v celém clusteru)
const result = await RemoteSpawn.spawn('worker', targetNodeId, {
  name: 'global-worker',
  registration: 'global',
});

// Po global registraci můžeme najít kdekoli
const ref = GlobalRegistry.whereis('global-worker');
```

### Spawn s timeoutem

```typescript
try {
  const result = await RemoteSpawn.spawn('worker', targetNodeId, {
    timeout: 5000,  // 5 sekund
  });
} catch (error) {
  if (error instanceof RemoteSpawnTimeoutError) {
    console.log(`Spawn timeout po ${error.timeoutMs}ms`);
  }
}
```

## Výběr uzlu

### Round-robin distribuce

```typescript
async function spawnWorkerPool(count: number): Promise<SpawnResult[]> {
  const nodes = Cluster.getConnectedNodes();
  const results: SpawnResult[] = [];

  for (let i = 0; i < count; i++) {
    const node = nodes[i % nodes.length]!;
    const result = await RemoteSpawn.spawn('worker', node.id);
    results.push(result);
  }

  return results;
}
```

### Least-loaded výběr

```typescript
function getLeastLoadedNode(): NodeInfo {
  const nodes = Cluster.getConnectedNodes();

  return nodes.reduce((min, node) =>
    node.processCount < min.processCount ? node : min
  );
}

const targetNode = getLeastLoadedNode();
const result = await RemoteSpawn.spawn('worker', targetNode.id);
```

### Afinitní spawn

```typescript
// Spawn na konkrétním uzlu (např. pro data locality)
const dataNode = findNodeWithData(dataKey);
const result = await RemoteSpawn.spawn('processor', dataNode.id);
```

## Chybové stavy

### BehaviorNotFoundError

Behaviour není registrované na cílovém uzlu:

```typescript
try {
  await RemoteSpawn.spawn('unknown-behavior', targetNodeId);
} catch (error) {
  if (error instanceof BehaviorNotFoundError) {
    console.log(`Behaviour "${error.behaviorName}" neexistuje`);
    // Zkontrolujte, že behaviour je registrované na cílovém uzlu
  }
}
```

### RemoteSpawnTimeoutError

Spawn překročil timeout:

```typescript
try {
  await RemoteSpawn.spawn('worker', targetNodeId, { timeout: 1000 });
} catch (error) {
  if (error instanceof RemoteSpawnTimeoutError) {
    console.log(`Timeout: ${error.behaviorName} na ${error.nodeId}`);
  }
}
```

### RemoteSpawnInitError

init() funkce selhala:

```typescript
try {
  await RemoteSpawn.spawn('worker', targetNodeId);
} catch (error) {
  if (error instanceof RemoteSpawnInitError) {
    console.log(`Init selhal: ${error.reason}`);
  }
}
```

### RemoteSpawnRegistrationError

Registrace pod jménem selhala (jméno už existuje):

```typescript
try {
  await RemoteSpawn.spawn('worker', targetNodeId, {
    name: 'existing-name',
    registration: 'global',
  });
} catch (error) {
  if (error instanceof RemoteSpawnRegistrationError) {
    console.log(`Jméno "${error.registeredName}" už existuje`);
  }
}
```

## Vzory použití

### Worker pool

```typescript
interface WorkerPool {
  workers: Map<string, SerializedRef>;
  roundRobinIndex: number;
}

async function createWorkerPool(size: number): Promise<WorkerPool> {
  const workers = new Map<string, SerializedRef>();
  const nodes = Cluster.getConnectedNodes();

  for (let i = 0; i < size; i++) {
    const node = nodes[i % nodes.length]!;
    const result = await RemoteSpawn.spawn('worker', node.id, {
      name: `worker-${i}`,
      registration: 'global',
    });

    workers.set(result.serverId, {
      id: result.serverId,
      nodeId: result.nodeId,
    });
  }

  return { workers, roundRobinIndex: 0 };
}

function getNextWorker(pool: WorkerPool): SerializedRef {
  const refs = Array.from(pool.workers.values());
  const ref = refs[pool.roundRobinIndex % refs.length]!;
  pool.roundRobinIndex++;
  return ref;
}
```

### Spawn s retry

```typescript
async function spawnWithRetry(
  behaviorName: string,
  maxRetries = 3,
): Promise<SpawnResult> {
  const nodes = Cluster.getConnectedNodes();
  let lastError: Error;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Zkus jiný uzel při každém pokusu
    const node = nodes[attempt % nodes.length]!;

    try {
      return await RemoteSpawn.spawn(behaviorName, node.id, {
        timeout: 5000,
      });
    } catch (error) {
      lastError = error as Error;

      if (error instanceof BehaviorNotFoundError) {
        // Tato chyba se neopraví retry
        throw error;
      }

      // Exponenciální backoff
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }

  throw lastError!;
}
```

### Graceful replacement

```typescript
async function replaceWorker(
  oldRef: SerializedRef,
  behaviorName: string,
): Promise<SerializedRef> {
  // 1. Spawn nový worker
  const nodes = Cluster.getConnectedNodes();
  const targetNode = nodes.find((n) => n.id !== oldRef.nodeId) ?? nodes[0]!;

  const result = await RemoteSpawn.spawn(behaviorName, targetNode.id);
  const newRef: SerializedRef = {
    id: result.serverId,
    nodeId: result.nodeId,
  };

  // 2. Gracefully zastav starý (pokud ještě běží)
  try {
    await RemoteCall.call(oldRef, { type: 'shutdown' }, { timeout: 5000 });
  } catch {
    // Ignoruj chyby - worker už možná neběží
  }

  return newRef;
}
```

## Statistiky

```typescript
const stats = RemoteSpawn.getStats();

console.log(`Inicializováno: ${stats.initialized}`);
console.log(`Čekající: ${stats.pendingCount}`);
console.log(`Celkem spuštěno: ${stats.totalInitiated}`);
console.log(`Úspěšných: ${stats.totalResolved}`);
console.log(`Selhalo: ${stats.totalRejected}`);
console.log(`Timeout: ${stats.totalTimedOut}`);

// Success rate
if (stats.totalInitiated > 0) {
  const rate = (stats.totalResolved / stats.totalInitiated * 100).toFixed(1);
  console.log(`Úspěšnost: ${rate}%`);
}
```

## Best practices

### 1. Vždy registrujte na všech uzlech

```typescript
// startup.ts - voláno na každém uzlu
export function startup(): void {
  // Registrace PŘED cluster.start()
  BehaviorRegistry.register('worker', workerBehavior);
  BehaviorRegistry.register('cache', cacheBehavior);
}
```

### 2. Používejte konzistentní jména

```typescript
// constants.ts
export const BEHAVIORS = {
  WORKER: 'worker',
  CACHE: 'cache',
} as const;

// Všude používejte konstanty
BehaviorRegistry.register(BEHAVIORS.WORKER, workerBehavior);
await RemoteSpawn.spawn(BEHAVIORS.WORKER, nodeId);
```

### 3. Ošetřujte všechny chyby

```typescript
async function safeSpawn(behavior: string, nodeId: NodeId): Promise<SpawnResult | null> {
  try {
    return await RemoteSpawn.spawn(behavior, nodeId);
  } catch (error) {
    if (error instanceof BehaviorNotFoundError) {
      console.error(`Behaviour "${behavior}" není registrované na ${nodeId}`);
    } else if (error instanceof RemoteSpawnTimeoutError) {
      console.error(`Spawn timeout na ${nodeId}`);
    } else if (error instanceof NodeNotReachableError) {
      console.error(`Uzel ${nodeId} není dostupný`);
    } else {
      console.error(`Neočekávaná chyba:`, error);
    }
    return null;
  }
}
```

### 4. Preferujte globální registraci pro služby

```typescript
// Pro služby které potřebují být nalezeny odjinud
await RemoteSpawn.spawn('cache', nodeId, {
  name: 'cache-service',
  registration: 'global',
});

// Pak kdekoli v clusteru
const cache = GlobalRegistry.whereis('cache-service');
```

## Související

- [RemoteSpawn API Reference](../api/remote-spawn.md) - Kompletní API
- [BehaviorRegistry API](../api/remote-spawn.md#behaviorregistry) - Registry API
- [DistributedSupervisor](../concepts/distributed-supervisor.md) - Automatická správa

---

*[English version](../../../distribution/guides/remote-processes.md)*
