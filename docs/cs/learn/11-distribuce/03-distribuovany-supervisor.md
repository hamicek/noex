# Distribuovaný Supervisor

V předchozích kapitolách jste se naučili, jak vytvářet clustery a provádět vzdálená volání. Nyní je čas zkombinovat tyto schopnosti se supervizí — **DistributedSupervisor** rozšiřuje model fault-tolerance noex napříč celým clusterem, automaticky migruje procesy na zdravé uzly při selhání.

## Co se naučíte

- Pochopit rozdíl mezi lokální a distribuovanou supervizí
- Registrovat behaviory pro vzdálené spouštění pomocí `BehaviorRegistry`
- Konfigurovat strategie výběru uzlů pro umístění dětí
- Použít všechny čtyři restart strategie supervisoru v distribuovaném kontextu
- Zpracovat automatický failover při pádu uzlů
- Monitorovat distribuovanou supervizi pomocí lifecycle eventů
- Sestavit fault-tolerantní distribuovaný worker pool

## Proč distribuovaná supervize?

Běžný Supervisor spravuje procesy na jediném stroji. Pokud tento stroj selže, všechny supervidované procesy jsou ztraceny. DistributedSupervisor to řeší distribucí dětí napříč uzly clusteru a automatickým restartováním jinde, když uzel spadne.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                  LOKÁLNÍ vs DISTRIBUOVANÁ SUPERVIZE                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  LOKÁLNÍ SUPERVISOR                    DISTRIBUOVANÝ SUPERVISOR             │
│  ────────────────────                  ────────────────────────             │
│                                                                             │
│    ┌─────────────────────┐           ┌─────────────────────────────────┐   │
│    │      Uzel A         │           │          Cluster                │   │
│    │  ┌──────────────┐   │           │  ┌────────┐  ┌────────┐        │   │
│    │  │  Supervisor  │   │           │  │ Uzel A │  │ Uzel B │        │   │
│    │  └──────┬───────┘   │           │  │ [Sup]  │  │  [w2]  │        │   │
│    │         │           │           │  │  [w1]  │  │  [w3]  │        │   │
│    │    ┌────┼────┐      │           │  └────────┘  └────────┘        │   │
│    │    ▼    ▼    ▼      │           │       │          │             │   │
│    │  ┌──┐ ┌──┐ ┌──┐     │           │       └────┬─────┘             │   │
│    │  │w1│ │w2│ │w3│     │           │            │                   │   │
│    │  └──┘ └──┘ └──┘     │           │       ┌────────┐               │   │
│    └─────────────────────┘           │       │ Uzel C │               │   │
│                                      │       │  [w4]  │               │   │
│    Pokud Uzel A selže:               │       └────────┘               │   │
│    → VŠICHNI workeri ztraceni!       │                                │   │
│                                      │  Pokud Uzel B selže:           │   │
│                                      │  → w2, w3 se restartují na A nebo C │
│                                      └─────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Klíčové schopnosti:**

- **Spouštění napříč uzly**: Startujte děti na libovolném uzlu v clusteru
- **Automatický failover**: Děti migrují na zdravé uzly, když jejich hostitel spadne
- **Výběr uzlu**: Kontrolujte, kde děti běží, pomocí vestavěných nebo vlastních strategií
- **Plná sémantika restartu**: Všechny čtyři strategie supervisoru fungují napříč uzly
- **Lifecycle eventy**: Monitorujte migrace dětí a selhání uzlů

## BehaviorRegistry: Základ

Než může DistributedSupervisor spustit dítě na vzdáleném uzlu, vzdálený uzel musí vědět, *jak* ho vytvořit. Protože funkce nelze serializovat přes síť, behaviory musí být pre-registrovány na všech uzlech pomocí `BehaviorRegistry`.

### Proč pre-registrace?

Když supervisor na Uzlu A řekne Uzlu B "spusť workera", Uzel B potřebuje kompletní behavior:
- Funkci `init()`
- Funkci `handleCall()`
- Funkci `handleCast()`
- Jakékoliv další behavior options

Oba uzly musí mít identické behaviory registrované pod stejným názvem.

```typescript
import { BehaviorRegistry, type GenServerBehavior } from '@hamicek/noex';

// Definice behavioru
interface WorkerState {
  taskCount: number;
  status: 'idle' | 'busy';
}

type WorkerCall = { type: 'get_status' } | { type: 'get_count' };
type WorkerCast = { type: 'process'; data: unknown };
type WorkerReply = WorkerState | number;

const workerBehavior: GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerReply> = {
  init: () => ({ taskCount: 0, status: 'idle' }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get_status':
        return [state, state];
      case 'get_count':
        return [state.taskCount, state];
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'process') {
      return { taskCount: state.taskCount + 1, status: 'idle' };
    }
    return state;
  },
};

// Registrovat na VŠECH uzlech před spuštěním clusteru
BehaviorRegistry.register('worker', workerBehavior);
```

### Časování registrace

Pořadí operací je kritické:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SEKVENCE STARTU UZLU                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. BehaviorRegistry.register()  ◄── Musí proběhnout první                  │
│           │                          (před jakýmikoliv async operacemi)     │
│           ▼                                                                 │
│  2. Cluster.start()              ◄── Připojí se k ostatním uzlům            │
│           │                                                                 │
│           ▼                                                                 │
│  3. DistributedSupervisor.start() ◄── Nyní může spouštět děti kdekoliv      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Kontrola registrace

```typescript
// Zkontrolovat, zda behavior existuje
if (BehaviorRegistry.has('worker')) {
  console.log('Worker behavior je registrován');
}

// Získat registrovaný behavior (pro inspekci)
const behavior = BehaviorRegistry.get('worker');

// Vypsat všechna registrovaná jména behaviorů
const names = BehaviorRegistry.getNames();
console.log('Registrované behaviory:', names);
// ['worker', 'coordinator', 'cache']
```

## Spuštění distribuovaného supervisoru

Jakmile jsou behaviory registrovány a cluster běží, můžete spustit DistributedSupervisor:

```typescript
import { Cluster, DistributedSupervisor, BehaviorRegistry } from '@hamicek/noex/distribution';

// 1. Registrovat behaviory (na VŠECH uzlech)
BehaviorRegistry.register('worker', workerBehavior);

// 2. Spustit cluster
await Cluster.start({
  nodeName: 'supervisor-node',
  port: 4369,
  seeds: ['worker-node@192.168.1.10:4370'],
});

// 3. Spustit distribuovaný supervisor
const supRef = await DistributedSupervisor.start({
  strategy: 'one_for_one',
  nodeSelector: 'round_robin',
  children: [
    { id: 'worker-1', behavior: 'worker', restart: 'permanent' },
    { id: 'worker-2', behavior: 'worker', restart: 'permanent' },
    { id: 'worker-3', behavior: 'worker', restart: 'permanent' },
  ],
});

console.log('Distribuovaný supervisor spuštěn:', supRef.id);
```

### Konfigurační možnosti

```typescript
interface DistributedSupervisorOptions {
  // Restart strategie (výchozí: 'one_for_one')
  strategy?: 'one_for_one' | 'one_for_all' | 'rest_for_one' | 'simple_one_for_one';

  // Výchozí výběr uzlu pro děti (výchozí: 'local_first')
  nodeSelector?: NodeSelector;

  // Počáteční děti (není povoleno s simple_one_for_one)
  children?: DistributedChildSpec[];

  // Šablona pro dynamické děti (povinné pro simple_one_for_one)
  childTemplate?: DistributedChildTemplate;

  // Limity intenzity restartů (výchozí: { maxRestarts: 3, withinMs: 5000 })
  restartIntensity?: { maxRestarts: number; withinMs: number };

  // Chování auto-shutdown (výchozí: 'never')
  autoShutdown?: 'never' | 'any_significant' | 'all_significant';

  // Volitelný název v global registry
  name?: string;
}
```

## Specifikace dítěte

Na rozdíl od běžné `ChildSpec`, která používá start funkci, `DistributedChildSpec` používá název behavioru (registrovaný v `BehaviorRegistry`):

```typescript
interface DistributedChildSpec {
  // Unikátní identifikátor v rámci tohoto supervisoru
  id: string;

  // Název registrovaného behavioru
  behavior: string;

  // Argumenty předané do init() (musí být serializovatelné)
  args?: readonly unknown[];

  // Restart strategie: 'permanent' | 'transient' | 'temporary'
  restart?: ChildRestartStrategy;

  // Strategie výběru uzlu pro toto dítě
  nodeSelector?: NodeSelector;

  // Timeout pro graceful shutdown v ms (výchozí: 5000)
  shutdownTimeout?: number;

  // Označí jako significant pro auto_shutdown
  significant?: boolean;
}
```

### Příklady specifikací

```typescript
const children: DistributedChildSpec[] = [
  // Základní worker - použije výchozí hodnoty supervisoru
  {
    id: 'basic-worker',
    behavior: 'worker',
  },

  // Worker s init argumenty
  {
    id: 'configured-worker',
    behavior: 'worker',
    args: [{ poolSize: 10, timeout: 5000 }],
  },

  // Worker připnutý ke konkrétnímu uzlu
  {
    id: 'storage-worker',
    behavior: 'storage',
    nodeSelector: { node: 'storage@192.168.1.50:4369' as NodeId },
  },

  // Transient worker - restartovat pouze při pádu, ne při normálním ukončení
  {
    id: 'task-worker',
    behavior: 'task-processor',
    restart: 'transient',
    nodeSelector: 'round_robin',
  },

  // Kritický worker - supervisor se vypne, pokud toto dítě skončí
  {
    id: 'coordinator',
    behavior: 'coordinator',
    restart: 'permanent',
    significant: true,
    shutdownTimeout: 30000,
  },
];
```

## Strategie výběru uzlu

DistributedSupervisor poskytuje několik strategií pro výběr, kde spustit děti.

### Vestavěné strategie

| Strategie | Popis |
|-----------|-------|
| `'local_first'` | Preferuje lokální uzel, fallback na připojené uzly (výchozí) |
| `'round_robin'` | Rotuje přes dostupné uzly v sekvenci |
| `'least_loaded'` | Vybírá uzel s nejnižším počtem procesů |
| `'random'` | Náhodný výběr z dostupných uzlů |

```typescript
// Výchozí na úrovni supervisoru se aplikuje na všechny děti
const supRef = await DistributedSupervisor.start({
  nodeSelector: 'round_robin',  // Výchozí pro všechny děti
  children: [
    { id: 'w1', behavior: 'worker' },  // Použije round_robin
    { id: 'w2', behavior: 'worker' },  // Použije round_robin
    { id: 'w3', behavior: 'worker', nodeSelector: 'local_first' },  // Override
  ],
});
```

### Konkrétní uzel

Připnutí dítěte ke konkrétnímu uzlu:

```typescript
{
  id: 'cache',
  behavior: 'cache',
  nodeSelector: { node: 'cache-node@192.168.1.50:4369' as NodeId },
}
```

**Varování**: Pokud je konkrétní uzel down, dítě nemůže být spuštěno nebo restartováno tam. Zvažte použití vlastního selektoru s fallback logikou.

### Vlastní selektor funkce

Implementujte vlastní logiku umístění:

```typescript
import type { NodeSelectorFn, NodeInfo } from '@hamicek/noex/distribution';

// Preferovat uzly s "worker" v názvu
const workerNodeSelector: NodeSelectorFn = (nodes, childId) => {
  const workerNodes = nodes.filter(n => n.id.includes('worker'));

  if (workerNodes.length === 0) {
    // Fallback na libovolný dostupný uzel
    if (nodes.length === 0) {
      throw new Error(`Žádné uzly dostupné pro ${childId}`);
    }
    return nodes[0].id;
  }

  // Mezi worker uzly vybrat nejméně zatížený
  const sorted = [...workerNodes].sort((a, b) => a.processCount - b.processCount);
  return sorted[0].id;
};

// Použití ve spec
{
  id: 'compute-worker',
  behavior: 'worker',
  nodeSelector: workerNodeSelector,
}
```

### Tok výběru uzlu

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TOK VÝBĚRU UZLU                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                  Dítě potřebuje být spuštěno/restartováno                   │
│                              │                                              │
│                              ▼                                              │
│                  ┌───────────────────────┐                                  │
│                  │ Má dítě vlastní       │                                  │
│                  │ nodeSelector?         │                                  │
│                  └───────────┬───────────┘                                  │
│                    │                   │                                    │
│               ANO  │                   │  NE                                │
│                    ▼                   ▼                                    │
│           ┌──────────────┐   ┌──────────────────┐                           │
│           │ Použij dětský│   │ Použij výchozí   │                           │
│           │ selektor     │   │ selektor sup.    │                           │
│           └──────┬───────┘   └────────┬─────────┘                           │
│                  │                    │                                     │
│                  └─────────┬──────────┘                                     │
│                            ▼                                                │
│                  ┌───────────────────────┐                                  │
│                  │ Získej dostupné uzly  │                                  │
│                  │ (vyloučit selhané při │                                  │
│                  │  failoveru)           │                                  │
│                  └───────────┬───────────┘                                  │
│                              ▼                                              │
│                  ┌───────────────────────┐                                  │
│                  │ Aplikuj výběrovou     │                                  │
│                  │ strategii             │                                  │
│                  └───────────┬───────────┘                                  │
│                              ▼                                              │
│                       Vybraný NodeId                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Restart strategie

DistributedSupervisor podporuje všechny čtyři standardní strategie supervisoru, aplikované napříč clusterem.

### one_for_one (výchozí)

Pouze selhané dítě je restartováno. Nejjednodušší a nejběžnější strategie.

```
                 Uzel A           Uzel B           Uzel C
                ┌─────┐          ┌─────┐          ┌─────┐
Před:           │ w1  │          │ w2  │          │ w3  │
                └─────┘          └─────┘          └─────┘
                    │                X                │
                    │            (pád)                │
                    ▼                ▼                ▼
                ┌─────┐          ┌─────┐          ┌─────┐
Po:             │ w1  │          │ w2' │          │ w3  │
                └─────┘          └─────┘          └─────┘
                                 (restartován, možná
                                  na jiném uzlu)
```

### one_for_all

Všechny děti se restartují, když jedno selže. Použijte, když mají děti těsné závislosti.

```
                 Uzel A           Uzel B           Uzel C
                ┌─────┐          ┌─────┐          ┌─────┐
Před:           │ w1  │          │ w2  │          │ w3  │
                └─────┘          └─────┘          └─────┘
                    │                X                │
                    │            (pád)                │
                    ▼                ▼                ▼
                ┌─────┐          ┌─────┐          ┌─────┐
Po:             │ w1' │          │ w2' │          │ w3' │
                └─────┘          └─────┘          └─────┘
                (všechny tři restartovány, přiřazení uzlu
                 se může změnit na základě selektoru)
```

### rest_for_one

Selhané dítě a všechny děti spuštěné po něm se restartují. Použijte pro sekvenční závislosti.

```
                Pořadí startu: w1 → w2 → w3

                 Uzel A           Uzel B           Uzel C
                ┌─────┐          ┌─────┐          ┌─────┐
Před:           │ w1  │          │ w2  │          │ w3  │
                └─────┘          └─────┘          └─────┘
                    │                X                │
                    │            (pád)                │
                    ▼                ▼                ▼
                ┌─────┐          ┌─────┐          ┌─────┐
Po:             │ w1  │          │ w2' │          │ w3' │
                └─────┘          └─────┘          └─────┘
                (beze změny)     (w2 a w3 restartovány)
```

### simple_one_for_one

Dynamické vytváření dětí ze šablony. Všechny děti jsou ekvivalentní.

```typescript
const supRef = await DistributedSupervisor.start({
  strategy: 'simple_one_for_one',
  childTemplate: {
    behavior: 'worker',
    restart: 'transient',
    nodeSelector: 'round_robin',
  },
});

// Spustit děti dynamicky s argumenty
const ref1 = await DistributedSupervisor.startChild(supRef, [{ task: 'images' }]);
const ref2 = await DistributedSupervisor.startChild(supRef, [{ task: 'videos' }]);
const ref3 = await DistributedSupervisor.startChild(supRef, [{ task: 'audio' }]);

// Každé dítě je distribuováno napříč clusterem podle selektoru šablony
```

## Automatický failover

Nejsilnější funkce DistributedSupervisoru je automatický failover — když uzel spadne, postižené děti jsou automaticky restartovány na zdravých uzlech.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TOK AUTOMATICKÉHO FAILOVERU                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ČAS 0: Normální provoz                                                     │
│  ─────────────────────────                                                  │
│                                                                             │
│     ┌──────────┐         ┌──────────┐         ┌──────────┐                 │
│     │  Uzel A  │         │  Uzel B  │         │  Uzel C  │                 │
│     │  [Sup]   │         │   [w1]   │         │   [w3]   │                 │
│     │          │         │   [w2]   │         │   [w4]   │                 │
│     └────┬─────┘         └────┬─────┘         └────┬─────┘                 │
│          │                    │                    │                        │
│          └────────────────────┴────────────────────┘                        │
│                     (heartbeaty tečou)                                      │
│                                                                             │
│  ČAS 1: Uzel B selže                                                        │
│  ────────────────────                                                       │
│                                                                             │
│     ┌──────────┐              ╳              ┌──────────┐                  │
│     │  Uzel A  │         │  Uzel B  │         │  Uzel C  │                 │
│     │  [Sup]   │         │  MRTVÝ   │         │   [w3]   │                 │
│     │          │         │          │         │   [w4]   │                 │
│     └────┬─────┘         └──────────┘         └────┬─────┘                 │
│          │                                         │                        │
│          │◄──── heartbeat timeout ─────────────────│                        │
│          │      (node_down event)                  │                        │
│                                                                             │
│  ČAS 2: Supervisor detekuje selhání a restartuje děti                       │
│  ─────────────────────────────────────────────────────────                  │
│                                                                             │
│     ┌──────────┐                              ┌──────────┐                  │
│     │  Uzel A  │   NodeSelector               │  Uzel C  │                 │
│     │  [Sup]   │─────(vyloučí B)─────────────►│   [w3]   │                 │
│     │   [w1']  │                              │   [w4]   │                 │
│     └──────────┘                              │   [w2']  │                 │
│                                               └──────────┘                  │
│                                                                             │
│  Výsledek: w1 a w2 restartovány na zdravých uzlech (A a C)                 │
│  Supervisor vysílá 'child_migrated' eventy pro každé                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Proces failoveru

1. **Detekce**: Cluster heartbeat timeout spustí `node_down` event
2. **Identifikace**: Supervisor identifikuje všechny děti na selhaném uzlu
3. **Rozhodnutí o restartu**: Kontrola restart strategie každého dítěte (`permanent`, `transient`, `temporary`)
4. **Výběr uzlu**: NodeSelector vybere nový cíl (selhavý uzel je vyloučen)
5. **Spawn**: Děti jsou spuštěny na nových uzlech přes BehaviorRegistry
6. **Aktualizace registry**: Interní registry aktualizována s novými lokacemi
7. **Eventy**: `child_migrated` eventy vyslány pro monitoring

### Intenzita restartů

Pro prevenci nekonečných restart smyček (např. bug, který způsobuje okamžitý pád dětí), konfigurujte limity intenzity restartů:

```typescript
await DistributedSupervisor.start({
  children: [/* ... */],
  restartIntensity: {
    maxRestarts: 5,       // Maximální počet povolených restartů
    withinMs: 60000,      // V tomto časovém okně (1 minuta)
  },
});
```

Pokud je limit překročen, supervisor se vypne a vyhodí `DistributedMaxRestartsExceededError`. Toto je bezpečnostní mechanismus — prozkoumejte příčinu před zvýšením limitů.

## Lifecycle eventy

Monitorujte distribuovanou supervizi pomocí lifecycle eventů:

```typescript
const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'supervisor_started':
      console.log(`[START] Supervisor ${event.ref.id} spuštěn`);
      break;

    case 'supervisor_stopped':
      console.log(`[STOP] Supervisor ${event.ref.id} zastaven: ${event.reason}`);
      break;

    case 'child_started':
      console.log(`[CHILD] ${event.childId} spuštěn na ${event.nodeId}`);
      break;

    case 'child_stopped':
      console.log(`[CHILD] ${event.childId} zastaven: ${event.reason}`);
      break;

    case 'child_restarted':
      console.log(`[RESTART] ${event.childId} restartován na ${event.nodeId} (pokus ${event.attempt})`);
      break;

    case 'child_migrated':
      console.log(`[MIGRATE] ${event.childId}: ${event.fromNode} → ${event.toNode}`);
      break;

    case 'node_failure_detected':
      console.log(`[FAILURE] Uzel ${event.nodeId} down, postižené: ${event.affectedChildren.join(', ')}`);
      break;
  }
});

// Později: zastavit naslouchání
unsubscribe();
```

### Reference typů eventů

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    EVENTY DISTRIBUOVANÉHO SUPERVISORU                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ŽIVOTNÍ CYKLUS SUPERVISORU                                                 │
│  ─────────────────────────────                                              │
│  supervisor_started    → Supervisor úspěšně spuštěn                         │
│  supervisor_stopped    → Supervisor ukončen (důvod uveden)                  │
│                                                                             │
│  ŽIVOTNÍ CYKLUS DĚTÍ                                                        │
│  ─────────────────────────                                                  │
│  child_started         → Dítě úspěšně spuštěno na uzlu                      │
│  child_stopped         → Dítě ukončeno (důvod: normal/crash/shutdown)       │
│  child_restarted       → Dítě restartováno po pádu (počet pokusů)           │
│                                                                             │
│  DISTRIBUČNÍ EVENTY                                                         │
│  ─────────────────────────                                                  │
│  child_migrated        → Dítě přesunuto z jednoho uzlu na jiný              │
│  node_failure_detected → Uzel spadl, seznam postižených dětí                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Statistiky a dotazy

### Statistiky supervisoru

```typescript
const stats = DistributedSupervisor.getStats(supRef);

console.log(`Supervisor: ${stats.id}`);
console.log(`Strategie: ${stats.strategy}`);
console.log(`Děti: ${stats.childCount}`);
console.log(`Celkem restartů: ${stats.totalRestarts}`);
console.log(`Restarty kvůli selhání uzlu: ${stats.nodeFailureRestarts}`);
console.log(`Uptime: ${Math.round(stats.uptimeMs / 1000)}s`);

// Distribuce dětí napříč uzly
console.log('Distribuce podle uzlu:');
for (const [nodeId, count] of stats.childrenByNode) {
  console.log(`  ${nodeId}: ${count} dětí`);
}
```

### Dotazování dětí

```typescript
// Získat všechny děti
const children = DistributedSupervisor.getChildren(supRef);
for (const child of children) {
  console.log(`${child.id} na ${child.nodeId} (restartů: ${child.restartCount})`);
}

// Získat konkrétní dítě
const worker = DistributedSupervisor.getChild(supRef, 'worker-1');
if (worker) {
  console.log(`Worker-1 běží na ${worker.nodeId}`);
  console.log(`Spuštěn v: ${new Date(worker.startedAt).toISOString()}`);
}

// Počet dětí
const count = DistributedSupervisor.countChildren(supRef);
console.log(`Spravuje ${count} dětí`);

// Zkontrolovat, zda běží
if (DistributedSupervisor.isRunning(supRef)) {
  console.log('Supervisor je aktivní');
}
```

## Dynamická správa dětí

### Přidávání dětí

```typescript
// Pro non-simple_one_for_one supervisory: poskytnout spec
const newRef = await DistributedSupervisor.startChild(supRef, {
  id: 'worker-4',
  behavior: 'worker',
  args: [{ priority: 'high' }],
  nodeSelector: 'least_loaded',
});

// Pro simple_one_for_one supervisory: poskytnout pole argumentů
const taskRef = await DistributedSupervisor.startChild(supRef, [{ task: 'process-images' }]);
```

### Manuální operace

```typescript
// Manuálně restartovat dítě (užitečné pro nasazení nového kódu)
const newRef = await DistributedSupervisor.restartChild(supRef, 'worker-1');

// Ukončit dítě (odebere ze supervisoru)
await DistributedSupervisor.terminateChild(supRef, 'worker-4');
```

### Graceful shutdown

```typescript
// Zastavit supervisor a všechny děti
await DistributedSupervisor.stop(supRef);

// S explicitním důvodem
await DistributedSupervisor.stop(supRef, 'shutdown');
```

Děti jsou zastaveny v opačném pořadí startu (poslední spuštěné = první zastavené).

## Auto-Shutdown

Konfigurujte chování supervisoru při ukončení dětí:

```typescript
await DistributedSupervisor.start({
  autoShutdown: 'any_significant',
  children: [
    { id: 'main', behavior: 'coordinator', significant: true },
    { id: 'helper', behavior: 'helper', significant: false },
  ],
});
```

| Nastavení | Chování |
|-----------|---------|
| `'never'` | Supervisor běží, dokud není explicitně zastaven (výchozí) |
| `'any_significant'` | Vypne se, když JAKÉKOLIV `significant: true` dítě skončí |
| `'all_significant'` | Vypne se, když VŠECHNA significant děti skončila |

## Zpracování chyb

```typescript
import {
  DistributedSupervisor,
  DistributedBehaviorNotFoundError,
  DistributedDuplicateChildError,
  DistributedChildNotFoundError,
  DistributedMaxRestartsExceededError,
  NoAvailableNodeError,
} from '@hamicek/noex/distribution';

try {
  await DistributedSupervisor.startChild(supRef, {
    id: 'worker',
    behavior: 'unregistered-behavior',
  });
} catch (error) {
  if (error instanceof DistributedBehaviorNotFoundError) {
    console.error(`Behavior '${error.behaviorName}' není registrován na ${error.nodeId}`);
  } else if (error instanceof DistributedDuplicateChildError) {
    console.error(`Dítě '${error.childId}' již existuje`);
  } else if (error instanceof NoAvailableNodeError) {
    console.error(`Žádné uzly dostupné pro dítě '${error.childId}'`);
  } else if (error instanceof DistributedMaxRestartsExceededError) {
    console.error(`Překročen limit restartů: ${error.maxRestarts} za ${error.withinMs}ms`);
  }
}
```

## Shrnutí

**Klíčové poznatky:**

- **DistributedSupervisor** rozšiřuje supervizi napříč uzly clusteru s automatickým failoverem
- **BehaviorRegistry** musí registrovat behaviory na VŠECH uzlech před startem
- **Výběr uzlu** kontroluje umístění dětí pomocí vestavěných strategií nebo vlastních funkcí
- **Všechny čtyři restart strategie** fungují napříč clusterem
- **Automatický failover** migruje děti na zdravé uzly, když jejich hostitel spadne
- **Lifecycle eventy** umožňují monitoring migrací a selhání
- **Intenzita restartů** brání nekonečným restart smyčkám

**Přehled API:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   PŘEHLED API DISTRIBUOVANÉHO SUPERVISORU                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BEHAVIOR REGISTRY (pre-registrace)                                         │
│  ─────────────────────────────────────────────────────────────────────────  │
│  BehaviorRegistry.register(name, behavior)  → Registrovat pro remote spawn  │
│  BehaviorRegistry.has(name)                 → Zkontrolovat registraci       │
│  BehaviorRegistry.get(name)                 → Získat registrovaný behavior  │
│  BehaviorRegistry.getNames()                → Vypsat všechna reg. jména     │
│                                                                             │
│  ŽIVOTNÍ CYKLUS SUPERVISORU                                                 │
│  ─────────────────────────────────────────────────────────────────────────  │
│  DistributedSupervisor.start(options)       → Spustit supervisor            │
│  DistributedSupervisor.stop(ref, reason?)   → Graceful shutdown             │
│  DistributedSupervisor.isRunning(ref)       → Zkontrolovat, zda běží        │
│                                                                             │
│  SPRÁVA DĚTÍ                                                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│  DistributedSupervisor.startChild(ref, spec) → Přidat dítě dynamicky        │
│  DistributedSupervisor.terminateChild(ref, id) → Odebrat dítě               │
│  DistributedSupervisor.restartChild(ref, id) → Manuální restart             │
│                                                                             │
│  DOTAZY                                                                     │
│  ─────────────────────────────────────────────────────────────────────────  │
│  DistributedSupervisor.getChildren(ref)     → Vypsat všechny děti           │
│  DistributedSupervisor.getChild(ref, id)    → Získat konkrétní dítě         │
│  DistributedSupervisor.countChildren(ref)   → Počet dětí                    │
│  DistributedSupervisor.getStats(ref)        → Statistiky supervisoru        │
│                                                                             │
│  EVENTY                                                                     │
│  ─────────────────────────────────────────────────────────────────────────  │
│  DistributedSupervisor.onLifecycleEvent(handler) → Přihlásit se k eventům   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Strategie výběru uzlu:**

| Strategie | Nejlepší pro |
|-----------|--------------|
| `'local_first'` | Minimalizace latence, preference co-location |
| `'round_robin'` | Rovnoměrná distribuce napříč uzly |
| `'least_loaded'` | CPU-náročné workloady |
| `'random'` | Jednoduchá distribuce zátěže |
| `{ node: NodeId }` | Připnutí ke konkrétnímu hardware |
| Vlastní funkce | Komplexní logika umístění |

**Pamatujte:**

> DistributedSupervisor kombinuje fault-toleranci supervize se škálovatelností distribuce. Registrujte behaviory všude, nechte supervisor zpracovat umístění a failover, a váš systém získá odolnost, která přesahuje celý cluster.

---

Další: [Chat Server Projekt](../12-prakticke-projekty/01-chat-server.md)
