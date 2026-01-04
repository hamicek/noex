# Návrh supervizních stromů

Tento průvodce pokrývá, jak navrhovat a implementovat efektivní supervizní stromy pomocí noex. Supervizní stromy jsou hierarchické struktury supervizorů, které poskytují izolaci chyb a obnovu.

## Přehled

Supervizní strom je hierarchie, kde:
- **Kořenový supervizor** spravuje subsystémy nejvyšší úrovně
- **Větvoví supervisoři** spravují související skupiny procesů
- **Listové procesy** (GenServery) vykonávají skutečnou práci

```
                    [Root Supervisor]
                    /       |        \
           [Workers]    [Cache]     [API]
            /    \        |         /   \
        [W1]  [W2]   [Primary]  [HTTP] [WS]
```

## Proč používat supervizní stromy?

### 1. Izolace chyb

Selhání v jedné větvi neovlivní ostatní větve:

```typescript
// Pokud worker spadne, cache a API subsystémy nejsou ovlivněny
const root = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'workers', start: () => startWorkerSupervisor() },
    { id: 'cache', start: () => startCacheSupervisor() },
    { id: 'api', start: () => startApiSupervisor() },
  ],
});
```

### 2. Granulární politiky restartování

Různé subsystémy mohou mít různé strategie restartování:

```typescript
// Workers: nezávislé, použij one_for_one
const workerSupervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: workers,
});

// Cache primary + repliky: musí zůstat synchronizované, použij one_for_all
const cacheSupervisor = await Supervisor.start({
  strategy: 'one_for_all',
  children: cacheNodes,
});
```

### 3. Jasné hranice systému

Supervizní stromy činí architekturu systému viditelnou:

```typescript
// Architektura je explicitní v kódu
const system = {
  database: { strategy: 'rest_for_one', children: ['pool', 'cache', 'query'] },
  workers: { strategy: 'one_for_one', children: ['email', 'pdf', 'image'] },
  api: { strategy: 'one_for_all', children: ['auth', 'routes', 'ws'] },
};
```

---

## Návrh vašeho stromu

### Krok 1: Identifikujte subsystémy

Seskupte procesy podle:
- **Sdílené funkcionality** (všechny workery, všechny cache)
- **Sdílených závislostí** (procesy používající stejné databázové spojení)
- **Dopadu selhání** (procesy, které by měly restartovat společně)

### Krok 2: Vyberte strategie pro každou větev

| Typ subsystému | Strategie | Důvod |
|----------------|-----------|-------|
| Nezávislé workery | `one_for_one` | Selhání jsou izolovaná |
| Replikované služby | `one_for_all` | Udržet repliky synchronizované |
| Fáze pipeline | `rest_for_one` | Pozdější fáze závisí na dřívějších |
| Bezstavové služby | `one_for_one` | Žádný sdílený stav |
| Koordinované služby | `one_for_all` | Musí restartovat společně |

### Krok 3: Definujte pořadí potomků

Pořadí je důležité pro:
- **Spuštění**: Závislosti startují první
- **Vypnutí**: Závislé se zastavují první (opačné pořadí)

```typescript
// Databáze musí startovat před službami, které ji používají
const appSupervisor = await Supervisor.start({
  strategy: 'rest_for_one',
  children: [
    { id: 'config', start: () => startConfigServer() },    // 1.: config
    { id: 'database', start: () => startDatabasePool() },  // 2.: databáze
    { id: 'cache', start: () => startCacheServer() },      // 3.: používá databázi
    { id: 'api', start: () => startApiServer() },          // 4.: používá cache + db
  ],
});
```

---

## Implementační vzory

### Vzor 1: Plochá hierarchie (jednoduché aplikace)

Pro jednoduché aplikace může stačit jeden supervizor:

```typescript
const app = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'counter', start: () => GenServer.start(counterBehavior) },
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },
    { id: 'metrics', start: () => GenServer.start(metricsBehavior) },
  ],
});
```

### Vzor 2: Dvouúrovňová hierarchie (střední aplikace)

Seskupte související služby pod větové supervizory:

```typescript
// Větvový supervizor pro workery
async function startWorkerBranch(): Promise<SupervisorRef> {
  return Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 10, withinMs: 60000 },
    children: [
      { id: 'worker-1', start: () => GenServer.start(workerBehavior) },
      { id: 'worker-2', start: () => GenServer.start(workerBehavior) },
      { id: 'worker-3', start: () => GenServer.start(workerBehavior) },
    ],
  });
}

// Větvový supervizor pro cache
async function startCacheBranch(): Promise<SupervisorRef> {
  return Supervisor.start({
    strategy: 'one_for_all',
    children: [
      { id: 'primary', start: () => GenServer.start(cacheBehavior) },
      { id: 'replica-1', start: () => GenServer.start(cacheBehavior) },
      { id: 'replica-2', start: () => GenServer.start(cacheBehavior) },
    ],
  });
}

// Kořenový supervizor
const root = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'workers', start: startWorkerBranch },
    { id: 'cache', start: startCacheBranch },
  ],
});
```

### Vzor 3: Hluboká hierarchie (komplexní aplikace)

Pro velké systémy vytvořte více úrovní:

```typescript
// Úroveň 3: Jednotlivé služby
async function startEmailWorkers(): Promise<SupervisorRef> {
  return Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'sender', start: () => GenServer.start(emailSenderBehavior) },
      { id: 'queue', start: () => GenServer.start(emailQueueBehavior) },
    ],
  });
}

// Úroveň 2: Skupiny služeb
async function startNotificationBranch(): Promise<SupervisorRef> {
  return Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'email', start: startEmailWorkers },
      { id: 'sms', start: startSmsWorkers },
      { id: 'push', start: startPushWorkers },
    ],
  });
}

// Úroveň 1: Hlavní subsystémy
async function startBackgroundJobs(): Promise<SupervisorRef> {
  return Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'notifications', start: startNotificationBranch },
      { id: 'reports', start: startReportBranch },
      { id: 'cleanup', start: startCleanupBranch },
    ],
  });
}

// Kořen: Vstupní bod aplikace
const app = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'core', start: startCoreBranch },
    { id: 'api', start: startApiBranch },
    { id: 'background', start: startBackgroundJobs },
  ],
});
```

---

## Příklad z praxe: E-commerce backend

```typescript
import { Supervisor, GenServer } from 'noex';

// Databázová vrstva (rest_for_one: pozdější procesy závisí na pool)
async function startDatabaseBranch() {
  return Supervisor.start({
    strategy: 'rest_for_one',
    children: [
      { id: 'pool', start: () => GenServer.start(dbPoolBehavior) },
      { id: 'cache', start: () => GenServer.start(queryCacheBehavior) },
      { id: 'migrations', start: () => GenServer.start(migrationBehavior), restart: 'temporary' },
    ],
  });
}

// Zpracování objednávek (one_for_all: platby a sklad musí být konzistentní)
async function startOrderBranch() {
  return Supervisor.start({
    strategy: 'one_for_all',
    children: [
      { id: 'inventory', start: () => GenServer.start(inventoryBehavior) },
      { id: 'payment', start: () => GenServer.start(paymentBehavior) },
      { id: 'orders', start: () => GenServer.start(orderBehavior) },
    ],
  });
}

// Workery (one_for_one: nezávislé úlohy)
async function startWorkerBranch() {
  return Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 20, withinMs: 60000 },
    children: [
      { id: 'email', start: () => GenServer.start(emailBehavior) },
      { id: 'pdf', start: () => GenServer.start(pdfBehavior) },
      { id: 'shipping', start: () => GenServer.start(shippingBehavior) },
    ],
  });
}

// API vrstva
async function startApiBranch() {
  return Supervisor.start({
    strategy: 'rest_for_one',
    children: [
      { id: 'auth', start: () => GenServer.start(authBehavior) },
      { id: 'rate-limiter', start: () => GenServer.start(rateLimiterBehavior) },
      { id: 'http', start: () => GenServer.start(httpServerBehavior) },
      { id: 'websocket', start: () => GenServer.start(wsServerBehavior) },
    ],
  });
}

// Kořenový supervizor aplikace
export async function startApplication() {
  return Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'database', start: startDatabaseBranch },
      { id: 'orders', start: startOrderBranch },
      { id: 'workers', start: startWorkerBranch },
      { id: 'api', start: startApiBranch },
    ],
  });
}
```

---

## Dynamické supervizní stromy

### Přidávání větví za běhu

```typescript
const root = await Supervisor.start({ strategy: 'one_for_one' });

// Přidat subsystémy dynamicky
await Supervisor.startChild(root, {
  id: 'feature-x',
  start: () => startFeatureXSupervisor(),
});

// Odebrat subsystémy
await Supervisor.terminateChild(root, 'feature-x');
```

### Dynamické worker pooly

```typescript
async function startWorkerPool(size: number) {
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
  });

  // Přidat workery dynamicky
  for (let i = 0; i < size; i++) {
    await Supervisor.startChild(supervisor, {
      id: `worker-${i}`,
      start: () => GenServer.start(workerBehavior),
    });
  }

  return supervisor;
}

// Škálovat nahoru/dolů za běhu
async function scaleWorkers(supervisor: SupervisorRef, newSize: number) {
  const current = Supervisor.countChildren(supervisor);

  if (newSize > current) {
    // Škálovat nahoru
    for (let i = current; i < newSize; i++) {
      await Supervisor.startChild(supervisor, {
        id: `worker-${i}`,
        start: () => GenServer.start(workerBehavior),
      });
    }
  } else if (newSize < current) {
    // Škálovat dolů
    for (let i = current - 1; i >= newSize; i--) {
      await Supervisor.terminateChild(supervisor, `worker-${i}`);
    }
  }
}
```

---

## Monitoring supervizních stromů

### Použití Observeru

```typescript
import { Observer } from 'noex';

// Získat přehled celého systému
const snapshot = Observer.getSystemSnapshot();
console.log(`Celkem procesů: ${snapshot.processCount}`);
console.log(`Celkem supervizorů: ${snapshot.supervisorCount}`);

// Získat detaily supervizora
const supervisorStats = Observer.getSupervisorStats(rootRef);
console.log(`Potomci: ${supervisorStats.childCount}`);
console.log(`Celkem restartů: ${supervisorStats.totalRestarts}`);
```

### Události životního cyklu

```typescript
// Monitorovat veškerou aktivitu supervizorů
Supervisor.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Supervizor spuštěn: ${event.ref.id}`);
      break;
    case 'restarted':
      console.log(`Potomek restartován, pokus: ${event.attempt}`);
      break;
    case 'terminated':
      console.log(`Ukončen: ${event.ref.id}`);
      break;
  }
});
```

---

## Osvědčené postupy

### 1. Udržujte stromy mělké

Preferujte širší, mělčí stromy před hlubokými hierarchiemi:

```typescript
// Dobře: 2 úrovně
Root -> [DB, Cache, Workers, API]

// Vyhněte se: 5 úrovní hluboko
Root -> System -> Services -> Workers -> Handlers -> Tasks
```

### 2. Seskupujte podle domény selhání

Umístěte procesy, které by měly selhat společně, pod `one_for_all`:

```typescript
// Primary + repliky by měly restartovat společně
{ strategy: 'one_for_all', children: [primary, replica1, replica2] }
```

### 3. Používejte smysluplná ID

```typescript
// Dobře
{ id: 'order-processor' }
{ id: 'email-worker-pool' }

// Vyhněte se
{ id: 'sup1' }
{ id: 'worker' }
```

### 4. Nastavte vhodnou intenzitu restartování pro každou větev

```typescript
// Kritické služby: přísné limity
restartIntensity: { maxRestarts: 3, withinMs: 60000 }

// Workery: více tolerance
restartIntensity: { maxRestarts: 20, withinMs: 60000 }
```

### 5. Dokumentujte svůj strom

```typescript
/**
 * Supervizní strom aplikace:
 *
 * [root] one_for_one
 * ├── [database] rest_for_one
 * │   ├── pool
 * │   └── cache
 * ├── [workers] one_for_one
 * │   ├── email
 * │   └── pdf
 * └── [api] rest_for_one
 *     ├── auth
 *     └── http
 */
```

---

## Časté chyby

### 1. Jeden supervizor pro vše

```typescript
// Špatně: Všechny procesy pod jedním supervizorem
const app = await Supervisor.start({
  strategy: 'one_for_one',
  children: [db, cache, worker1, worker2, api, ws, email, pdf, ...50more],
});

// Lépe: Seskupit do subsystémů
const app = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'database', start: startDbBranch },
    { id: 'workers', start: startWorkerBranch },
    { id: 'api', start: startApiBranch },
  ],
});
```

### 2. Špatná volba strategie

```typescript
// Špatně: Použití one_for_all pro nezávislé workery
const workers = await Supervisor.start({
  strategy: 'one_for_all',  // Všechny workery restartují při jakémkoli selhání!
  children: independentWorkers,
});

// Lépe: Použít one_for_one
const workers = await Supervisor.start({
  strategy: 'one_for_one',  // Pouze spadlý worker restartuje
  children: independentWorkers,
});
```

### 3. Neuvážení pořadí spuštění

```typescript
// Špatně: API startuje před databází
children: [
  { id: 'api', start: startApi },      // Selže: žádná databáze!
  { id: 'database', start: startDb },
]

// Lépe: Databáze první
children: [
  { id: 'database', start: startDb },  // Startuje první
  { id: 'api', start: startApi },      // Databáze připravena
]
```

---

## Související

- [Koncepty supervizoru](../concepts/supervisor.md) - Pochopení supervizorů
- [Průvodce vytvářením služeb](./building-services.md) - Vytváření GenServerů
- [Průvodce produkcí](./production.md) - Produkční nasazení
- [API Reference supervizoru](../api/supervisor.md) - Kompletní API dokumentace
