# Distribuovaná supervize

`DistributedSupervisor` rozšiřuje lokální supervizi o možnost správy procesů napříč uzly clusteru s automatickým failover při pádu uzlů.

## Architektura

### Rozložení procesů

DistributedSupervisor distribuuje child procesy napříč dostupnými uzly:

```
┌─────────────────────────────────────────────────────────────────┐
│                  DistributedSupervisor                           │
│                      (Node A)                                   │
│                                                                 │
│  ┌───────────┐    ┌───────────┐    ┌───────────┐              │
│  │  Node A   │    │  Node B   │    │  Node C   │              │
│  │           │    │           │    │           │              │
│  │ ┌───────┐ │    │ ┌───────┐ │    │ ┌───────┐ │              │
│  │ │Worker1│ │    │ │Worker2│ │    │ │Worker3│ │              │
│  │ └───────┘ │    │ └───────┘ │    │ └───────┘ │              │
│  └───────────┘    └───────────┘    └───────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

### Automatický failover

Při pádu uzlu jsou procesy automaticky přesunuty:

```
Před pádem:                    Po pádu Node B:

Node A    Node B    Node C     Node A    Node C
┌─────┐  ┌─────┐  ┌─────┐     ┌─────┐  ┌─────┐
│  W1 │  │  W2 │  │  W3 │     │  W1 │  │  W3 │
└─────┘  └──╳──┘  └─────┘     │  W2 │  └─────┘
                  ▲           └─────┘
                  │               ▲
                  │               │
                  └───────────────┘
                    migrace W2
```

## Node Selectors

Strategie pro výběr uzlu kde se proces spustí:

### local_first

Preferuje lokální uzel, fallback na vzdálené:

```typescript
await DistributedSupervisor.start({
  nodeSelector: 'local_first',
  children: [
    { id: 'worker', behavior: 'worker' },
  ],
});
```

### round_robin

Rotuje přes dostupné uzly:

```typescript
await DistributedSupervisor.start({
  nodeSelector: 'round_robin',
  children: [
    { id: 'worker-1', behavior: 'worker' },
    { id: 'worker-2', behavior: 'worker' },
    { id: 'worker-3', behavior: 'worker' },
  ],
});
// Worker-1 na Node A, Worker-2 na Node B, Worker-3 na Node C, ...
```

### least_loaded

Vybírá uzel s nejmenším počtem procesů:

```typescript
await DistributedSupervisor.start({
  nodeSelector: 'least_loaded',
  children: [...],
});
```

### random

Náhodný výběr z dostupných uzlů:

```typescript
await DistributedSupervisor.start({
  nodeSelector: 'random',
  children: [...],
});
```

### Konkrétní uzel

Spawn na specifickém uzlu:

```typescript
await DistributedSupervisor.start({
  children: [
    {
      id: 'coordinator',
      behavior: 'coordinator',
      nodeSelector: { node: NodeId.parse('coordinator@host:4369') },
    },
  ],
});
```

### Custom selector

Vlastní logika výběru:

```typescript
const geoSelector: NodeSelectorFn = (nodes, childId) => {
  const region = childId.split('-')[0]; // "eu-worker-1" → "eu"
  const regionalNode = nodes.find((n) => n.id.startsWith(region));
  return regionalNode?.id ?? nodes[0]!.id;
};

await DistributedSupervisor.start({
  nodeSelector: geoSelector,
  children: [
    { id: 'eu-worker-1', behavior: 'worker' },
    { id: 'us-worker-1', behavior: 'worker' },
  ],
});
```

## Restart strategie

Stejné jako lokální Supervisor, ale s distribuovaným kontextem:

### one_for_one

Restartuje pouze spadlý proces:

```typescript
await DistributedSupervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'worker-1', behavior: 'worker' },
    { id: 'worker-2', behavior: 'worker' },
  ],
});
// Pád worker-1 → restartuje pouze worker-1
```

### one_for_all

Restartuje všechny procesy při pádu jednoho:

```typescript
await DistributedSupervisor.start({
  strategy: 'one_for_all',
  children: [
    { id: 'coordinator', behavior: 'coordinator' },
    { id: 'worker-1', behavior: 'worker' },
    { id: 'worker-2', behavior: 'worker' },
  ],
});
// Pád worker-1 → restartuje všechny
```

### rest_for_one

Restartuje spadlý proces a všechny po něm:

```typescript
await DistributedSupervisor.start({
  strategy: 'rest_for_one',
  children: [
    { id: 'producer', behavior: 'producer' },
    { id: 'processor', behavior: 'processor' },
    { id: 'consumer', behavior: 'consumer' },
  ],
});
// Pád processor → restartuje processor a consumer
```

### simple_one_for_one

Dynamické procesy ze šablony:

```typescript
const supRef = await DistributedSupervisor.start({
  strategy: 'simple_one_for_one',
  childTemplate: {
    behavior: 'worker',
    restart: 'transient',
  },
});

// Dynamické přidávání
const child1 = await DistributedSupervisor.startChild(supRef, [{ taskId: 1 }]);
const child2 = await DistributedSupervisor.startChild(supRef, [{ taskId: 2 }]);
```

## Child specifikace

### DistributedChildSpec

```typescript
interface DistributedChildSpec {
  id: string;                    // Unikátní ID
  behavior: string;              // Jméno behaviour v BehaviorRegistry
  args?: unknown[];              // Argumenty pro init()
  restart?: ChildRestartStrategy; // 'permanent' | 'transient' | 'temporary'
  nodeSelector?: NodeSelector;   // Výběr uzlu (přepíše default)
  shutdownTimeout?: number;      // Timeout pro graceful shutdown
  significant?: boolean;         // Pro autoShutdown
}
```

### Restart strategie child procesů

| Strategie | Kdy restartovat |
|-----------|-----------------|
| `permanent` | Vždy (výchozí) |
| `transient` | Pouze při neočekávaném ukončení |
| `temporary` | Nikdy |

## Životní cyklus události

### Sledování událostí

```typescript
DistributedSupervisor.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'supervisor_started':
      console.log(`Supervisor spuštěn: ${event.ref.id}`);
      break;

    case 'child_started':
      console.log(`Child ${event.childId} spuštěn na ${event.nodeId}`);
      break;

    case 'child_stopped':
      console.log(`Child ${event.childId} zastaven: ${event.reason}`);
      break;

    case 'child_restarted':
      console.log(`Child ${event.childId} restartován (pokus ${event.attempt})`);
      break;

    case 'child_migrated':
      console.log(`Child ${event.childId}: ${event.fromNode} → ${event.toNode}`);
      break;

    case 'node_failure_detected':
      console.log(`Pád uzlu ${event.nodeId}`);
      console.log(`Dotčené procesy: ${event.affectedChildren.join(', ')}`);
      break;

    case 'supervisor_stopped':
      console.log(`Supervisor zastaven: ${event.reason}`);
      break;
  }
});
```

## Restart intensity

Omezení počtu restartů v časovém okně:

```typescript
await DistributedSupervisor.start({
  restartIntensity: {
    maxRestarts: 5,      // Max 5 restartů
    withinMs: 60000,     // V okně 60 sekund
  },
  children: [...],
});
```

Při překročení limitu supervisor spadne s `DistributedMaxRestartsExceededError`.

## Auto-shutdown

Automatické ukončení supervisoru:

### never (výchozí)

Supervisor běží i po ukončení všech child procesů:

```typescript
await DistributedSupervisor.start({
  autoShutdown: 'never',
  children: [...],
});
```

### any_significant

Ukončí se při ukončení jakéhokoliv "significant" child procesu:

```typescript
await DistributedSupervisor.start({
  autoShutdown: 'any_significant',
  children: [
    { id: 'critical', behavior: 'critical', significant: true },
    { id: 'helper', behavior: 'helper' },
  ],
});
// Pád 'critical' → ukončí supervisor
```

### all_significant

Ukončí se až po ukončení všech "significant" child procesů:

```typescript
await DistributedSupervisor.start({
  autoShutdown: 'all_significant',
  children: [
    { id: 'worker-1', behavior: 'worker', significant: true },
    { id: 'worker-2', behavior: 'worker', significant: true },
    { id: 'logger', behavior: 'logger' },
  ],
});
// Ukončí se až po pádu worker-1 I worker-2
```

## Dynamická správa

### Přidání child procesu

```typescript
// Pro regular supervisor
const childRef = await DistributedSupervisor.startChild(supRef, {
  id: 'new-worker',
  behavior: 'worker',
  nodeSelector: 'least_loaded',
});

// Pro simple_one_for_one
const childRef = await DistributedSupervisor.startChild(supRef, [args]);
```

### Ukončení child procesu

```typescript
await DistributedSupervisor.terminateChild(supRef, 'worker-1');
```

### Ruční restart

```typescript
const newRef = await DistributedSupervisor.restartChild(supRef, 'worker-1');
// Může být na jiném uzlu podle nodeSelector
```

## Statistiky

```typescript
const stats = DistributedSupervisor.getStats(supRef);

console.log(`ID: ${stats.id}`);
console.log(`Strategie: ${stats.strategy}`);
console.log(`Počet procesů: ${stats.childCount}`);
console.log(`Celkem restartů: ${stats.totalRestarts}`);
console.log(`Restartů kvůli pádu uzlu: ${stats.nodeFailureRestarts}`);
console.log(`Uptime: ${stats.uptimeMs}ms`);

// Rozložení po uzlech
for (const [nodeId, count] of stats.childrenByNode) {
  console.log(`  ${nodeId}: ${count} procesů`);
}
```

## Kompletní příklad

```typescript
import { Cluster, DistributedSupervisor, BehaviorRegistry } from 'noex/distribution';

// 1. Registrace behaviour
const workerBehavior = {
  init: () => ({ processed: 0 }),
  handleCall: (msg: 'status', state) => [state.processed, state],
  handleCast: (msg: 'work', state) => ({ processed: state.processed + 1 }),
};

BehaviorRegistry.register('worker', workerBehavior);

// 2. Start clusteru
await Cluster.start({
  nodeName: 'supervisor',
  seeds: ['worker1@host:4369', 'worker2@host:4369'],
});

// 3. Sledování událostí
DistributedSupervisor.onLifecycleEvent((event) => {
  console.log(`[${event.type}]`, JSON.stringify(event));
});

// 4. Start supervisoru
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

// 5. Přidání dalšího workeru
await DistributedSupervisor.startChild(supRef, {
  id: 'worker-4',
  behavior: 'worker',
  nodeSelector: 'least_loaded',
});

// 6. Graceful shutdown
process.on('SIGINT', async () => {
  const stats = DistributedSupervisor.getStats(supRef);
  console.log(`Celkem restartů: ${stats.totalRestarts}`);

  await DistributedSupervisor.stop(supRef);
  await Cluster.stop();
  process.exit(0);
});
```

## Best practices

### 1. Registrujte behaviour na všech uzlech

```typescript
// behaviors.ts - importujte na každém uzlu
export function registerBehaviors(): void {
  BehaviorRegistry.register('worker', workerBehavior);
  BehaviorRegistry.register('cache', cacheBehavior);
}

// main.ts
registerBehaviors();
await Cluster.start(config);
```

### 2. Vyberte správnou strategii

| Use case | Strategie | Důvod |
|----------|-----------|-------|
| Nezávislé služby | `one_for_one` | Izolované selhání |
| Úzce provázané | `one_for_all` | Musí restartovat společně |
| Pipeline | `rest_for_one` | Downstream závisí na upstream |
| Worker pool | `simple_one_for_one` | Homogenní, dynamické |

### 3. Monitorujte události

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

## Související

- [DistributedSupervisor API](../api/distributed-supervisor.md) - Kompletní API
- [RemoteSpawn](../api/remote-spawn.md) - Vzdálené spouštění procesů
- [RemoteMonitor](../api/remote-monitor.md) - Monitorování procesů

---

*[English version](../../../distribution/concepts/distributed-supervisor.md)*
