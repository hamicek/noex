# DistributedSupervisor API Reference

Objekt `DistributedSupervisor` spravuje child procesy napříč uzly clusteru s automatickým failover při pádu uzlů. Kombinuje supervizní vzory Erlang/OTP s možnostmi distribuovaného spouštění.

## Import

```typescript
import { DistributedSupervisor, BehaviorRegistry } from 'noex/distribution';
```

## Přehled

DistributedSupervisor poskytuje:
- Vzdálené spouštění child procesů přes BehaviorRegistry
- Automatický failover při pádu uzlů
- Vícero restart strategií (`one_for_one`, `one_for_all`, `rest_for_one`, `simple_one_for_one`)
- Cluster-wide koordinace child procesů přes GlobalRegistry
- Monitorování procesů přes RemoteMonitor

---

## Typy

### DistributedSupervisorRef

Opaque reference na běžící distribuovaný supervisor.

```typescript
interface DistributedSupervisorRef {
  readonly id: string;
  readonly nodeId: NodeId;
}
```

### DistributedSupervisorOptions

Konfigurační volby pro spuštění distribuovaného supervisoru.

```typescript
interface DistributedSupervisorOptions {
  readonly strategy?: SupervisorStrategy;
  readonly nodeSelector?: NodeSelector;
  readonly children?: readonly DistributedChildSpec[];
  readonly childTemplate?: DistributedChildTemplate;
  readonly restartIntensity?: RestartIntensity;
  readonly autoShutdown?: DistributedAutoShutdown;
  readonly name?: string;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| `strategy` | `SupervisorStrategy` | `'one_for_one'` | Restart strategie |
| `nodeSelector` | `NodeSelector` | `'local_first'` | Výchozí strategie výběru uzlu |
| `children` | `DistributedChildSpec[]` | `[]` | Počáteční specifikace child procesů |
| `childTemplate` | `DistributedChildTemplate` | - | Šablona pro dynamické children (povinné pro `simple_one_for_one`) |
| `restartIntensity` | `RestartIntensity` | `{maxRestarts: 3, withinMs: 5000}` | Omezení restartů |
| `autoShutdown` | `DistributedAutoShutdown` | `'never'` | Chování auto-shutdown |
| `name` | `string` | - | Volitelné jméno pro global registry |

### DistributedChildSpec

Specifikace child procesu.

```typescript
interface DistributedChildSpec {
  readonly id: string;
  readonly behavior: string;
  readonly args?: readonly unknown[];
  readonly restart?: ChildRestartStrategy;
  readonly nodeSelector?: NodeSelector;
  readonly shutdownTimeout?: number;
  readonly significant?: boolean;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| `id` | `string` | povinné | Unikátní identifikátor child procesu |
| `behavior` | `string` | povinné | Jméno behaviour v BehaviorRegistry |
| `args` | `unknown[]` | `[]` | Argumenty předané init funkci |
| `restart` | `ChildRestartStrategy` | `'permanent'` | Kdy restartovat child |
| `nodeSelector` | `NodeSelector` | - | Strategie výběru uzlu (použije default supervisoru pokud nenastaveno) |
| `shutdownTimeout` | `number` | `5000` | Milisekundy pro graceful shutdown |
| `significant` | `boolean` | `false` | Označuje child jako significant pro `autoShutdown` |

### NodeSelector

Strategie výběru uzlu pro umístění child procesu.

```typescript
type NodeSelector =
  | NodeSelectorType
  | { readonly node: NodeId }
  | NodeSelectorFn;

type NodeSelectorType = 'local_first' | 'round_robin' | 'least_loaded' | 'random';

type NodeSelectorFn = (nodes: readonly NodeInfo[], childId: string) => NodeId;
```

| Strategie | Chování |
|-----------|---------|
| `'local_first'` | Preferuje lokální uzel, fallback na připojené (výchozí) |
| `'round_robin'` | Rotuje přes dostupné uzly v sekvenci |
| `'least_loaded'` | Vybere uzel s nejnižším počtem procesů |
| `'random'` | Náhodný výběr z dostupných uzlů |
| `{ node: NodeId }` | Spawn na konkrétním uzlu |
| `NodeSelectorFn` | Custom výběrová funkce |

### DistributedAutoShutdown

Chování auto-shutdown při ukončení children.

```typescript
type DistributedAutoShutdown = 'never' | 'any_significant' | 'all_significant';
```

| Hodnota | Chování |
|---------|---------|
| `'never'` | Supervisor běží i po ukončení všech children (výchozí) |
| `'any_significant'` | Supervisor se ukončí při ukončení jakéhokoliv significant child |
| `'all_significant'` | Supervisor se ukončí až po ukončení všech significant children |

### DistributedChildInfo

Informace o běžícím child procesu.

```typescript
interface DistributedChildInfo {
  readonly id: string;
  readonly ref: GenServerRef;
  readonly spec: DistributedChildSpec;
  readonly nodeId: NodeId;
  readonly restartCount: number;
  readonly startedAt: number;
}
```

### DistributedSupervisorStats

Runtime statistiky supervisoru.

```typescript
interface DistributedSupervisorStats {
  readonly id: string;
  readonly strategy: SupervisorStrategy;
  readonly childCount: number;
  readonly childrenByNode: ReadonlyMap<NodeId, number>;
  readonly totalRestarts: number;
  readonly nodeFailureRestarts: number;
  readonly startedAt: number;
  readonly uptimeMs: number;
}
```

### DistributedSupervisorEvent

Lifecycle eventy pro distribuovanou supervizi.

```typescript
type DistributedSupervisorEvent =
  | { type: 'supervisor_started'; ref: DistributedSupervisorRef }
  | { type: 'supervisor_stopped'; ref: DistributedSupervisorRef; reason: string }
  | { type: 'child_started'; supervisorId: string; childId: string; nodeId: NodeId }
  | { type: 'child_stopped'; supervisorId: string; childId: string; reason: string }
  | { type: 'child_restarted'; supervisorId: string; childId: string; nodeId: NodeId; attempt: number }
  | { type: 'child_migrated'; supervisorId: string; childId: string; fromNode: NodeId; toNode: NodeId }
  | { type: 'node_failure_detected'; supervisorId: string; nodeId: NodeId; affectedChildren: string[] };
```

---

## Metody

### start()

Spustí nový DistributedSupervisor s danými volbami.

```typescript
async start(options?: DistributedSupervisorOptions): Promise<DistributedSupervisorRef>
```

**Parametry:**
- `options` - Konfigurace supervisoru

**Vrací:** Promise s DistributedSupervisorRef

**Vyhodí:**
- `DistributedMissingChildTemplateError` - Pokud `simple_one_for_one` bez `childTemplate`
- `DistributedInvalidSimpleOneForOneError` - Pokud `simple_one_for_one` se statickými children
- `DistributedBehaviorNotFoundError` - Pokud child behaviour není registrované

**Příklad:**
```typescript
const supRef = await DistributedSupervisor.start({
  strategy: 'one_for_one',
  nodeSelector: 'round_robin',
  children: [
    { id: 'worker1', behavior: 'worker', restart: 'permanent' },
    { id: 'worker2', behavior: 'worker', restart: 'permanent' },
  ],
  restartIntensity: { maxRestarts: 5, withinMs: 60000 },
});
```

---

### stop()

Gracefully zastaví supervisor a všechny jeho children.

```typescript
async stop(ref: DistributedSupervisorRef, reason?: 'normal' | 'shutdown'): Promise<void>
```

**Parametry:**
- `ref` - Reference na supervisor k zastavení
- `reason` - Důvod zastavení (výchozí: `'normal'`)

Children jsou zastaveny v opačném pořadí (poslední spuštěný = první zastavený).

---

### startChild()

Dynamicky spustí nový child pod supervisorem.

**Pro regular supervisory:**

```typescript
async startChild(
  ref: DistributedSupervisorRef,
  spec: DistributedChildSpec,
): Promise<GenServerRef>
```

**Pro `simple_one_for_one` supervisory:**

```typescript
async startChild(
  ref: DistributedSupervisorRef,
  args: readonly unknown[],
): Promise<GenServerRef>
```

**Parametry:**
- `ref` - Reference na supervisor
- `spec` nebo `args` - Specifikace child nebo pole argumentů

**Vrací:** Promise s GenServerRef child procesu

**Vyhodí:**
- `DistributedDuplicateChildError` - Pokud child se stejným ID už existuje
- `DistributedSupervisorError` - Pokud supervisor nenalezen

**Příklad (regular):**
```typescript
const childRef = await DistributedSupervisor.startChild(supRef, {
  id: 'worker-3',
  behavior: 'worker',
  restart: 'permanent',
  nodeSelector: 'least_loaded',
});
```

**Příklad (simple_one_for_one):**
```typescript
const supRef = await DistributedSupervisor.start({
  strategy: 'simple_one_for_one',
  childTemplate: { behavior: 'worker', restart: 'transient' },
});

const child1 = await DistributedSupervisor.startChild(supRef, [{ taskId: 1 }]);
const child2 = await DistributedSupervisor.startChild(supRef, [{ taskId: 2 }]);
```

---

### terminateChild()

Ukončí konkrétní child.

```typescript
async terminateChild(ref: DistributedSupervisorRef, childId: string): Promise<void>
```

**Parametry:**
- `ref` - Reference na supervisor
- `childId` - ID child k ukončení

**Vyhodí:**
- `DistributedChildNotFoundError` - Pokud child nenalezen

---

### restartChild()

Manuálně restartuje konkrétní child.

```typescript
async restartChild(ref: DistributedSupervisorRef, childId: string): Promise<GenServerRef>
```

**Parametry:**
- `ref` - Reference na supervisor
- `childId` - ID child k restartu

**Vrací:** Promise s novou GenServerRef child procesu

Child může být restartován na jiném uzlu podle nodeSelector.

---

### getChildren()

Vrátí informace o všech children.

```typescript
getChildren(ref: DistributedSupervisorRef): readonly DistributedChildInfo[]
```

**Příklad:**
```typescript
const children = DistributedSupervisor.getChildren(supRef);
for (const child of children) {
  console.log(`${child.id} na ${child.nodeId}: ${child.restartCount} restartů`);
}
```

---

### getChild()

Vrátí informace o konkrétním child.

```typescript
getChild(ref: DistributedSupervisorRef, childId: string): DistributedChildInfo | undefined
```

---

### countChildren()

Vrátí počet children.

```typescript
countChildren(ref: DistributedSupervisorRef): number
```

---

### isRunning()

Zkontroluje zda supervisor aktuálně běží.

```typescript
isRunning(ref: DistributedSupervisorRef): boolean
```

---

### getStats()

Vrátí statistiky supervisoru.

```typescript
getStats(ref: DistributedSupervisorRef): DistributedSupervisorStats
```

**Příklad:**
```typescript
const stats = DistributedSupervisor.getStats(supRef);
console.log(`Children: ${stats.childCount}`);
console.log(`Restartů: ${stats.totalRestarts}`);
console.log(`Pádů uzlů: ${stats.nodeFailureRestarts}`);
console.log(`Uptime: ${stats.uptimeMs}ms`);

for (const [nodeId, count] of stats.childrenByNode) {
  console.log(`  ${nodeId}: ${count} children`);
}
```

---

### onLifecycleEvent()

Registruje handler pro lifecycle eventy.

```typescript
onLifecycleEvent(handler: DistributedSupervisorEventHandler): () => void
```

**Parametry:**
- `handler` - Funkce volaná pro každý lifecycle event

**Vrací:** Funkce pro odhlášení

**Příklad:**
```typescript
const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'supervisor_started':
      console.log(`Supervisor spuštěn: ${event.ref.id}`);
      break;
    case 'child_started':
      console.log(`Child ${event.childId} spuštěn na ${event.nodeId}`);
      break;
    case 'child_migrated':
      console.log(`Child ${event.childId} migrován: ${event.fromNode} -> ${event.toNode}`);
      break;
    case 'node_failure_detected':
      console.log(`Pád uzlu ${event.nodeId}, dotčené: ${event.affectedChildren.join(', ')}`);
      break;
  }
});

// Později
unsubscribe();
```

---

## Chybové třídy

### DistributedDuplicateChildError

```typescript
class DistributedDuplicateChildError extends Error {
  readonly name = 'DistributedDuplicateChildError';
  readonly supervisorId: string;
  readonly childId: string;
}
```

### DistributedChildNotFoundError

```typescript
class DistributedChildNotFoundError extends Error {
  readonly name = 'DistributedChildNotFoundError';
  readonly supervisorId: string;
  readonly childId: string;
}
```

### DistributedMaxRestartsExceededError

```typescript
class DistributedMaxRestartsExceededError extends Error {
  readonly name = 'DistributedMaxRestartsExceededError';
  readonly supervisorId: string;
  readonly maxRestarts: number;
  readonly withinMs: number;
}
```

### NoAvailableNodeError

```typescript
class NoAvailableNodeError extends Error {
  readonly name = 'NoAvailableNodeError';
  readonly childId: string;
  readonly selector?: NodeSelector;
}
```

---

## Konstanty

### DISTRIBUTED_SUPERVISOR_DEFAULTS

```typescript
const DISTRIBUTED_SUPERVISOR_DEFAULTS = {
  NODE_SELECTOR: 'local_first',
  STRATEGY: 'one_for_one',
  MAX_RESTARTS: 3,
  RESTART_WITHIN_MS: 5000,
  SHUTDOWN_TIMEOUT: 5000,
  AUTO_SHUTDOWN: 'never',
  SPAWN_TIMEOUT: 10000,
  CHILD_CHECK_INTERVAL: 50,
} as const;
```

---

## Kompletní příklad

```typescript
import { Cluster, DistributedSupervisor, BehaviorRegistry } from 'noex/distribution';
import type { GenServerBehavior } from 'noex';

// Worker behaviour
const workerBehavior: GenServerBehavior<{ processed: number }, 'status', 'work', number> = {
  init: () => ({ processed: 0 }),
  handleCall: (msg, state) => [state.processed, state],
  handleCast: (msg, state) => ({ processed: state.processed + 1 }),
  terminate: (reason, state) => {
    console.log(`Worker ukončen po ${state.processed} úkolech`);
  },
};

async function main() {
  // 1. Registrace behaviour na VŠECH uzlech
  BehaviorRegistry.register('worker', workerBehavior);

  // 2. Start clusteru
  await Cluster.start({
    nodeName: 'supervisor-node',
    port: 4369,
    seeds: ['worker1@192.168.1.10:4369', 'worker2@192.168.1.11:4369'],
  });

  // Čekání na uzly
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // 3. Sledování lifecycle eventů
  DistributedSupervisor.onLifecycleEvent((event) => {
    console.log(`[Event] ${event.type}:`, JSON.stringify(event));
  });

  // 4. Start supervisoru s distribuovanými children
  const supRef = await DistributedSupervisor.start({
    strategy: 'one_for_one',
    nodeSelector: 'round_robin',
    children: [
      { id: 'worker-1', behavior: 'worker', restart: 'permanent' },
      { id: 'worker-2', behavior: 'worker', restart: 'permanent' },
      { id: 'worker-3', behavior: 'worker', restart: 'permanent' },
    ],
    restartIntensity: { maxRestarts: 10, withinMs: 60000 },
  });

  console.log(`\nSpuštěn supervisor ${supRef.id}`);

  // 5. Kontrola distribuce children
  const stats = DistributedSupervisor.getStats(supRef);
  console.log(`\nDistribuce children:`);
  for (const [nodeId, count] of stats.childrenByNode) {
    console.log(`  ${nodeId}: ${count} children`);
  }

  // 6. Dynamické přidání dalších workerů
  await DistributedSupervisor.startChild(supRef, {
    id: 'worker-4',
    behavior: 'worker',
    nodeSelector: 'least_loaded',
  });

  // 7. Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nUkončuji...');

    const finalStats = DistributedSupervisor.getStats(supRef);
    console.log(`Celkem restartů: ${finalStats.totalRestarts}`);
    console.log(`Restartů kvůli pádu uzlu: ${finalStats.nodeFailureRestarts}`);

    await DistributedSupervisor.stop(supRef);
    await Cluster.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Best practices

### 1. Registrujte behaviour jako první

```typescript
// behaviors.ts
export function registerBehaviors(): void {
  BehaviorRegistry.register('worker', workerBehavior);
  BehaviorRegistry.register('cache', cacheBehavior);
}

// main.ts
registerBehaviors();
await Cluster.start(config);
const supRef = await DistributedSupervisor.start(options);
```

### 2. Vyberte správnou strategii

| Use case | Strategie | Důvod |
|----------|-----------|-------|
| Nezávislé služby | `one_for_one` | Izolované selhání |
| Úzce provázané | `one_for_all` | Musí restartovat společně |
| Pipeline | `rest_for_one` | Downstream závisí na upstream |
| Worker pool | `simple_one_for_one` | Homogenní, dynamické |

### 3. Monitorujte lifecycle eventy

```typescript
DistributedSupervisor.onLifecycleEvent((event) => {
  metrics.emit('distributed_supervisor_event', {
    type: event.type,
    timestamp: Date.now(),
    ...event,
  });

  if (event.type === 'node_failure_detected') {
    alerting.send(`Pád uzlu ${event.nodeId}`);
  }
});
```

---

## Související

- [Distribuovaná supervize koncepty](../concepts/distributed-supervisor.md) - Pochopení distribuované supervize
- [RemoteSpawn API](./remote-spawn.md) - Vzdálené spouštění procesů
- [RemoteMonitor API](./remote-monitor.md) - Monitorování procesů
- [Typy Reference](./types.md) - Všechny distribuční typy

---

*[English version](../../../distribution/api/distributed-supervisor.md)*
