# RemoteSpawn API Reference

Objekt `RemoteSpawn` umožňuje spouštění GenServer instancí na vzdálených uzlech clusteru. Protože JavaScript funkce nelze serializovat, behaviour musí být předregistrované pomocí `BehaviorRegistry` na všech uzlech.

## Import

```typescript
import { RemoteSpawn, BehaviorRegistry } from 'noex/distribution';
```

---

## BehaviorRegistry

Registr pro GenServer behaviour dostupné pro vzdálené spouštění.

### Metody

#### register()

Registruje behaviour pod daným jménem.

```typescript
register<State, CallMsg, CastMsg, CallReply>(
  name: string,
  behavior: GenServerBehavior<State, CallMsg, CastMsg, CallReply>,
): void
```

**Parametry:**
- `name` - Unikátní jméno pro behaviour
- `behavior` - Implementace GenServer behaviour

**Vyhodí:**
- `Error` - Pokud behaviour s tímto jménem již existuje
- `Error` - Pokud behaviour je neplatné (chybí povinné funkce)

**Příklad:**
```typescript
const counterBehavior = {
  init: () => 0,
  handleCall: (msg: 'get' | 'inc', state: number) => {
    if (msg === 'get') return [state, state];
    return [state + 1, state + 1];
  },
  handleCast: (_msg: never, state: number) => state,
};

BehaviorRegistry.register('counter', counterBehavior);
```

---

#### get()

Získá behaviour podle jména.

```typescript
get<State, CallMsg, CastMsg, CallReply>(
  name: string,
): GenServerBehavior<State, CallMsg, CastMsg, CallReply> | undefined
```

**Parametry:**
- `name` - Jméno behaviour k získání

**Vrací:** Behaviour pokud nalezeno, jinak undefined

**Příklad:**
```typescript
const behavior = BehaviorRegistry.get('counter');
if (behavior) {
  const ref = await GenServer.start(behavior);
}
```

---

#### has()

Zkontroluje zda je behaviour registrované.

```typescript
has(name: string): boolean
```

**Vrací:** `true` pokud je behaviour registrované

---

#### unregister()

Odebere behaviour z registru.

```typescript
unregister(name: string): boolean
```

**Vrací:** `true` pokud bylo behaviour nalezeno a odebráno

**Varování:** Odebrání behaviour během čekajících vzdálených spawnů může způsobit selhání.

---

#### getNames()

Vrátí jména všech registrovaných behaviour.

```typescript
getNames(): readonly string[]
```

---

#### getStats()

Vrátí statistiky o registru.

```typescript
getStats(): BehaviorRegistryStats
```

```typescript
interface BehaviorRegistryStats {
  readonly count: number;
  readonly names: readonly string[];
}
```

---

## RemoteSpawn

### Typy

#### SpawnResult

Výsledek úspěšného vzdáleného spawnu.

```typescript
interface SpawnResult {
  readonly serverId: string;
  readonly nodeId: NodeId;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `serverId` | `string` | ID spawnovaného GenServeru |
| `nodeId` | `NodeId` | Uzel kde GenServer běží |

#### RemoteSpawnOptions

Volby pro vzdálený spawn.

```typescript
interface RemoteSpawnOptions {
  readonly name?: string;
  readonly initTimeout?: number;
  readonly registration?: 'local' | 'global' | 'none';
  readonly timeout?: number;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| `name` | `string` | - | Volitelné jméno pro registraci |
| `initTimeout` | `number` | - | Timeout pro init() volání |
| `registration` | `string` | `'none'` | Strategie registrace na cílovém uzlu |
| `timeout` | `number` | `10000` | Timeout pro celou spawn operaci |

#### RemoteSpawnStats

Statistiky o vzdálených spawn operacích.

```typescript
interface RemoteSpawnStats {
  readonly initialized: boolean;
  readonly pendingCount: number;
  readonly totalInitiated: number;
  readonly totalResolved: number;
  readonly totalRejected: number;
  readonly totalTimedOut: number;
}
```

---

### Metody

#### spawn()

Spawnuje GenServer na vzdáleném uzlu.

```typescript
async spawn(
  behaviorName: string,
  targetNodeId: NodeId,
  options?: RemoteSpawnOptions,
): Promise<SpawnResult>
```

**Parametry:**
- `behaviorName` - Jméno registrovaného behaviour
- `targetNodeId` - Cílový uzel pro spawn
- `options` - Volby spawnu

**Vrací:** Promise s výsledkem spawnu obsahujícím serverId a nodeId

**Vyhodí:**
- `ClusterNotStartedError` - Pokud cluster neběží
- `NodeNotReachableError` - Pokud cílový uzel není připojen
- `BehaviorNotFoundError` - Pokud behaviour není registrované na cíli
- `RemoteSpawnTimeoutError` - Pokud spawn vypršel
- `RemoteSpawnInitError` - Pokud inicializace selhala
- `RemoteSpawnRegistrationError` - Pokud registrace selhala

**Příklad:**
```typescript
const result = await RemoteSpawn.spawn('counter', targetNodeId, {
  name: 'my-counter',
  registration: 'global',
  timeout: 5000,
});

console.log(`Spawnováno ${result.serverId} na ${result.nodeId}`);
```

---

#### getStats()

Vrátí statistiky o vzdálených spawn operacích.

```typescript
getStats(): RemoteSpawnStats
```

---

## Chybové třídy

### BehaviorNotFoundError

```typescript
class BehaviorNotFoundError extends Error {
  readonly name = 'BehaviorNotFoundError';
  readonly behaviorName: string;
}
```

Vyhodí se když behaviour není registrované v BehaviorRegistry.

### RemoteSpawnTimeoutError

```typescript
class RemoteSpawnTimeoutError extends Error {
  readonly name = 'RemoteSpawnTimeoutError';
  readonly behaviorName: string;
  readonly nodeId: NodeId;
  readonly timeoutMs: number;
}
```

Vyhodí se když vzdálený spawn požadavek vypršel.

### RemoteSpawnInitError

```typescript
class RemoteSpawnInitError extends Error {
  readonly name = 'RemoteSpawnInitError';
  readonly behaviorName: string;
  readonly nodeId: NodeId;
  readonly reason: string;
}
```

Vyhodí se když inicializace selhala na vzdáleném uzlu.

### RemoteSpawnRegistrationError

```typescript
class RemoteSpawnRegistrationError extends Error {
  readonly name = 'RemoteSpawnRegistrationError';
  readonly behaviorName: string;
  readonly nodeId: NodeId;
  readonly registeredName: string;
}
```

Vyhodí se když registrace selhala kvůli konfliktu jmen.

---

## Kompletní příklad

```typescript
import { Cluster, RemoteSpawn, BehaviorRegistry, NodeId } from 'noex/distribution';
import type { GenServerBehavior } from 'noex';

// Definice behaviour typu
interface WorkerState {
  taskCount: number;
}

type WorkerCall = { type: 'status' };
type WorkerCast = { type: 'process'; data: unknown };
type WorkerReply = { taskCount: number };

const workerBehavior: GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerReply> = {
  init: () => ({ taskCount: 0 }),

  handleCall: (msg, state) => {
    if (msg.type === 'status') {
      return [{ taskCount: state.taskCount }, state];
    }
    return [{ taskCount: state.taskCount }, state];
  },

  handleCast: (msg, state) => {
    if (msg.type === 'process') {
      console.log(`Zpracovávám: ${JSON.stringify(msg.data)}`);
      return { taskCount: state.taskCount + 1 };
    }
    return state;
  },
};

async function main() {
  // KROK 1: Registrace behaviour na VŠECH uzlech
  BehaviorRegistry.register('worker', workerBehavior);

  // KROK 2: Start clusteru
  await Cluster.start({
    nodeName: 'coordinator',
    port: 4369,
    seeds: ['worker1@192.168.1.10:4369', 'worker2@192.168.1.11:4369'],
  });

  // Čekání na připojení uzlů
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // KROK 3: Spawn workerů na vzdálených uzlech
  const workers: SpawnResult[] = [];

  for (const node of Cluster.getConnectedNodes()) {
    try {
      const result = await RemoteSpawn.spawn('worker', node.id, {
        registration: 'global',
        timeout: 5000,
      });
      workers.push(result);
      console.log(`Spawnován worker na ${node.id}`);
    } catch (error) {
      if (error instanceof BehaviorNotFoundError) {
        console.error(`Behaviour není registrované na ${node.id}`);
      } else if (error instanceof RemoteSpawnTimeoutError) {
        console.error(`Spawn timeout na ${error.nodeId}`);
      } else {
        throw error;
      }
    }
  }

  console.log(`\nSpawnováno ${workers.length} workerů v clusteru`);

  // KROK 4: Použití spawnovaných workerů
  for (const worker of workers) {
    const ref = { id: worker.serverId, nodeId: worker.nodeId };
    RemoteCall.cast(ref, { type: 'process', data: { task: 'example' } });
  }

  // Statistiky
  const stats = RemoteSpawn.getStats();
  console.log(`\nRemoteSpawn statistiky:`);
  console.log(`  Celkem spawnů: ${stats.totalInitiated}`);
  console.log(`  Úspěšných: ${stats.totalResolved}`);
  console.log(`  Selhalo: ${stats.totalRejected}`);

  await Cluster.stop();
}

main().catch(console.error);
```

---

## Best practices

### 1. Vždy registrujte na všech uzlech

Behaviour musí být registrované na každém uzlu kde mohou být spawnované:

```typescript
// Tento kód by měl běžet na každém uzlu při startu
BehaviorRegistry.register('counter', counterBehavior);
BehaviorRegistry.register('cache', cacheBehavior);
BehaviorRegistry.register('worker', workerBehavior);
```

### 2. Používejte konzistentní jména

Zajistěte konzistentní jména behaviour napříč uzly:

```typescript
// behaviors.ts - sdílený modul
export const BEHAVIORS = {
  COUNTER: 'counter',
  CACHE: 'cache',
  WORKER: 'worker',
} as const;

// node.ts
BehaviorRegistry.register(BEHAVIORS.COUNTER, counterBehavior);
```

### 3. Ošetřujte selhání spawnu

```typescript
async function spawnWithRetry(
  behaviorName: string,
  nodeId: NodeId,
  maxRetries = 3,
): Promise<SpawnResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await RemoteSpawn.spawn(behaviorName, nodeId);
    } catch (error) {
      if (attempt === maxRetries) throw error;

      if (error instanceof RemoteSpawnTimeoutError) {
        console.log(`Spawn timeout, retry (${attempt}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      } else {
        throw error; // Neopakovat ne-timeout chyby
      }
    }
  }
  throw new Error('Unreachable');
}
```

---

## Související

- [Vzdálené procesy návod](../guides/remote-processes.md) - Použití RemoteSpawn
- [RemoteCall API](./remote-call.md) - Volání vzdálených procesů
- [DistributedSupervisor API](./distributed-supervisor.md) - Správa vzdálených children
- [Typy Reference](./types.md) - Všechny distribuční typy

---

*[English version](../../../distribution/api/remote-spawn.md)*
