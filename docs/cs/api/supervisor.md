# Supervisor API Reference

Objekt `Supervisor` poskytuje metody pro správu supervizních stromů s automatickým restartováním potomků.

## Import

```typescript
import { Supervisor } from 'noex';
```

## Typy

### SupervisorRef

Neprůhledná reference na běžící instanci Supervisoru.

```typescript
interface SupervisorRef {
  readonly id: string;
}
```

### SupervisorOptions

Volby pro `Supervisor.start()`.

```typescript
interface SupervisorOptions {
  readonly strategy?: SupervisorStrategy;
  readonly children?: readonly ChildSpec[];
  readonly childTemplate?: ChildTemplate;
  readonly restartIntensity?: RestartIntensity;
  readonly name?: string;
  readonly autoShutdown?: AutoShutdown;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| `strategy` | `SupervisorStrategy` | `'one_for_one'` | Strategie restartu |
| `children` | `readonly ChildSpec[]` | `[]` | Počáteční potomci (ne pro `simple_one_for_one`) |
| `childTemplate` | `ChildTemplate` | - | Šablona pro dynamické potomky (vyžadováno pro `simple_one_for_one`) |
| `restartIntensity` | `RestartIntensity` | `{maxRestarts: 3, withinMs: 5000}` | Omezení restartů |
| `name` | `string` | - | Název v registru |
| `autoShutdown` | `AutoShutdown` | `'never'` | Chování automatického ukončení |

### SupervisorStrategy

Strategie pro zpracování selhání potomků.

```typescript
type SupervisorStrategy = 'one_for_one' | 'one_for_all' | 'rest_for_one' | 'simple_one_for_one';
```

| Strategie | Chování |
|-----------|---------|
| `'one_for_one'` | Restartovat pouze spadlého potomka (výchozí) |
| `'one_for_all'` | Restartovat všechny potomky, když jeden selže |
| `'rest_for_one'` | Restartovat spadlého potomka a všechny potomky spuštěné po něm |
| `'simple_one_for_one'` | Zjednodušená varianta pro dynamicky spouštěné homogenní potomky |

**Poznámka:** `simple_one_for_one` vyžaduje `childTemplate` místo `children`. Všichni potomci jsou vytvářeni dynamicky pomocí `Supervisor.startChild()` s argumenty předanými start funkci šablony.

### ChildSpec

Specifikace potomka.

```typescript
interface ChildSpec<State = unknown, CallMsg = unknown, CastMsg = unknown, CallReply = unknown> {
  readonly id: string;
  readonly start: () => Promise<GenServerRef<State, CallMsg, CastMsg, CallReply>>;
  readonly restart?: ChildRestartStrategy;
  readonly shutdownTimeout?: number;
  readonly significant?: boolean;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| `id` | `string` | povinné | Unikátní identifikátor potomka |
| `start` | `() => Promise<GenServerRef>` | povinné | Tovární funkce pro vytvoření potomka |
| `restart` | `ChildRestartStrategy` | `'permanent'` | Kdy restartovat potomka |
| `shutdownTimeout` | `number` | `5000` | Milisekundy čekání na graceful shutdown |
| `significant` | `boolean` | `false` | Označuje potomka jako významného pro `autoShutdown` |

### ChildRestartStrategy

Kdy restartovat potomka po ukončení.

```typescript
type ChildRestartStrategy = 'permanent' | 'transient' | 'temporary';
```

| Strategie | Chování |
|-----------|---------|
| `'permanent'` | Vždy restartovat bez ohledu na důvod ukončení (výchozí) |
| `'transient'` | Restartovat pouze při abnormálním ukončení (pády s chybou) |
| `'temporary'` | Nikdy nerestartovat za žádných okolností |

#### Chování restartu podle důvodu ukončení

| Důvod ukončení | `permanent` | `transient` | `temporary` |
|----------------|:-----------:|:-----------:|:-----------:|
| Normal (`'normal'`) | ✅ Restart | ❌ Bez restartu | ❌ Bez restartu |
| Shutdown (`'shutdown'`) | ✅ Restart | ❌ Bez restartu | ❌ Bez restartu |
| Error (`{ error: Error }`) | ✅ Restart | ✅ Restart | ❌ Bez restartu |

**Vysvětlení důvodů ukončení:**
- **Normal** - Proces dokončil práci a ukončil se korektně přes `GenServer.stop(ref, 'normal')`
- **Shutdown** - Proces byl ukončen supervisorem nebo explicitním shutdown přes `GenServer.stop(ref, 'shutdown')`
- **Error** - Proces spadl kvůli neošetřené výjimce nebo byl násilně ukončen s chybou

### ChildTemplate

Šablona pro dynamické vytváření potomků v `simple_one_for_one` supervisorech.

```typescript
interface ChildTemplate<Args extends unknown[] = unknown[]> {
  readonly start: (...args: Args) => Promise<GenServerRef>;
  readonly restart?: ChildRestartStrategy;
  readonly shutdownTimeout?: number;
  readonly significant?: boolean;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| `start` | `(...args) => Promise<GenServerRef>` | povinné | Tovární funkce volaná s argumenty z `startChild()` |
| `restart` | `ChildRestartStrategy` | `'permanent'` | Strategie restartu pro všechny potomky |
| `shutdownTimeout` | `number` | `5000` | Milisekundy čekání na graceful shutdown |
| `significant` | `boolean` | `false` | Označuje potomky jako významné pro `autoShutdown` |

### AutoShutdown

Chování automatického ukončení při ukončení potomků.

```typescript
type AutoShutdown = 'never' | 'any_significant' | 'all_significant';
```

| Hodnota | Chování |
|---------|---------|
| `'never'` | Supervisor pokračuje i po ukončení všech potomků (výchozí) |
| `'any_significant'` | Supervisor se ukončí při ukončení jakéhokoliv významného potomka |
| `'all_significant'` | Supervisor se ukončí až po ukončení všech významných potomků |

**Poznámka:** Pro rozhodnutí o automatickém ukončení jsou bráni v úvahu pouze potomci s `significant: true`.

### RestartIntensity

Konfigurace omezení restartů.

```typescript
interface RestartIntensity {
  readonly maxRestarts: number;  // výchozí: 3
  readonly withinMs: number;     // výchozí: 5000
}
```

### ChildInfo

Informace o běžícím potomkovi.

```typescript
interface ChildInfo {
  readonly id: string;
  readonly ref: GenServerRef;
  readonly spec: ChildSpec;
  readonly restartCount: number;
}
```

---

## Metody

### start()

Spustí nový Supervisor s danými volbami.

```typescript
async start(options?: SupervisorOptions): Promise<SupervisorRef>
```

**Parametry:**
- `options` - Konfigurace Supervisoru
  - `strategy` - Strategie restartu (výchozí: `'one_for_one'`)
  - `children` - Počáteční specifikace potomků
  - `restartIntensity` - Konfigurace omezení restartů
  - `name` - Zaregistrovat supervisor pod tímto jménem

**Vrací:** Promise resolvující na SupervisorRef

**Vyhazuje:**
- `InitializationError` - Pokud některý potomek selže při startu
- `MaxRestartsExceededError` - Pokud je překročena intenzita restartů během startu

**Příklad:**
```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  restartIntensity: { maxRestarts: 5, withinMs: 60000 },
  children: [
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },
    { id: 'worker', start: () => GenServer.start(workerBehavior) },
  ],
});
```

---

### stop()

Gracefully zastaví supervisor a všechny jeho potomky.

```typescript
async stop(ref: SupervisorRef, reason?: TerminateReason): Promise<void>
```

**Parametry:**
- `ref` - Reference na supervisor k zastavení
- `reason` - Důvod zastavení (výchozí: `'normal'`)

**Vrací:** Promise, která se vyřeší po zastavení supervisoru a všech potomků

**Příklad:**
```typescript
await Supervisor.stop(supervisor);

// S důvodem
await Supervisor.stop(supervisor, 'shutdown');
```

Potomci jsou zastavováni v opačném pořadí (naposledy spuštěný = první zastavený).

---

### startChild()

Dynamicky spustí nového potomka pod supervisorem.

**Pro standardní strategie (`one_for_one`, `one_for_all`, `rest_for_one`):**

```typescript
async startChild(ref: SupervisorRef, spec: ChildSpec): Promise<GenServerRef>
```

**Parametry:**
- `ref` - Reference na supervisor
- `spec` - Specifikace potomka

**Vrací:** Promise resolvující na GenServerRef potomka

**Vyhazuje:**
- `DuplicateChildError` - Pokud potomek se stejným ID již existuje

**Příklad:**
```typescript
const workerRef = await Supervisor.startChild(supervisor, {
  id: 'worker-1',
  start: () => GenServer.start(workerBehavior),
  restart: 'permanent',
});
```

**Pro `simple_one_for_one` strategii:**

```typescript
async startChild(ref: SupervisorRef, args: unknown[]): Promise<GenServerRef>
```

**Parametry:**
- `ref` - Reference na supervisor
- `args` - Argumenty předané `start` funkci šablony

**Vrací:** Promise resolvující na GenServerRef potomka (ID je automaticky generováno)

**Příklad:**
```typescript
// Vytvoření supervisoru se šablonou
const supervisor = await Supervisor.start({
  strategy: 'simple_one_for_one',
  childTemplate: {
    start: async (workerId: string, config: WorkerConfig) => {
      return GenServer.start(createWorkerBehavior(workerId, config));
    },
    restart: 'transient',
  },
});

// Dynamické spouštění potomků s argumenty
const worker1 = await Supervisor.startChild(supervisor, ['worker-1', { priority: 'high' }]);
const worker2 = await Supervisor.startChild(supervisor, ['worker-2', { priority: 'low' }]);
```

---

### terminateChild()

Ukončí konkrétního potomka.

```typescript
async terminateChild(ref: SupervisorRef, childId: string): Promise<void>
```

**Parametry:**
- `ref` - Reference na supervisor
- `childId` - ID potomka k ukončení

**Vrací:** Promise, která se vyřeší po zastavení potomka

**Vyhazuje:**
- `ChildNotFoundError` - Pokud potomek nebyl nalezen

**Příklad:**
```typescript
await Supervisor.terminateChild(supervisor, 'worker-1');
```

---

### restartChild()

Manuálně restartuje konkrétního potomka.

```typescript
async restartChild(ref: SupervisorRef, childId: string): Promise<GenServerRef>
```

**Parametry:**
- `ref` - Reference na supervisor
- `childId` - ID potomka k restartu

**Vrací:** Promise resolvující na nový GenServerRef potomka

**Vyhazuje:**
- `ChildNotFoundError` - Pokud potomek nebyl nalezen

**Příklad:**
```typescript
const newRef = await Supervisor.restartChild(supervisor, 'cache');
```

---

### getChildren()

Vrací informace o všech potomcích.

```typescript
getChildren(ref: SupervisorRef): readonly ChildInfo[]
```

**Parametry:**
- `ref` - Reference na supervisor

**Vrací:** Pole informací o potomcích

**Příklad:**
```typescript
const children = Supervisor.getChildren(supervisor);
for (const child of children) {
  console.log(`${child.id}: restartů=${child.restartCount}`);
}
```

---

### getChild()

Vrací informace o konkrétním potomkovi.

```typescript
getChild(ref: SupervisorRef, childId: string): ChildInfo | undefined
```

**Parametry:**
- `ref` - Reference na supervisor
- `childId` - ID potomka

**Vrací:** Informace o potomkovi nebo undefined, pokud nebyl nalezen

**Příklad:**
```typescript
const cache = Supervisor.getChild(supervisor, 'cache');
if (cache) {
  console.log(`Cache restartů: ${cache.restartCount}`);
}
```

---

### countChildren()

Vrací počet potomků.

```typescript
countChildren(ref: SupervisorRef): number
```

**Parametry:**
- `ref` - Reference na supervisor

**Vrací:** Počet potomků

**Příklad:**
```typescript
const count = Supervisor.countChildren(supervisor);
console.log(`Spravuji ${count} potomků`);
```

---

### isRunning()

Zjistí, zda supervisor aktuálně běží.

```typescript
isRunning(ref: SupervisorRef): boolean
```

**Parametry:**
- `ref` - Reference ke kontrole

**Vrací:** `true` pokud supervisor běží

**Příklad:**
```typescript
if (Supervisor.isRunning(supervisor)) {
  await Supervisor.startChild(supervisor, spec);
}
```

---

### onLifecycleEvent()

Registruje handler pro události životního cyklu.

```typescript
onLifecycleEvent(handler: LifecycleHandler): () => void
```

**Parametry:**
- `handler` - Funkce volaná pro každou událost životního cyklu

**Vrací:** Funkci pro odhlášení odběru

**Příklad:**
```typescript
const unsubscribe = Supervisor.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Supervisor spuštěn: ${event.ref.id}`);
      break;
    case 'restarted':
      console.log(`Potomek restartován, pokus #${event.attempt}`);
      break;
    case 'terminated':
      console.log(`Ukončen: ${event.reason}`);
      break;
  }
});

// Později
unsubscribe();
```

---

## Třídy chyb

### MaxRestartsExceededError

```typescript
class MaxRestartsExceededError extends Error {
  readonly name = 'MaxRestartsExceededError';
  readonly supervisorId: string;
  readonly maxRestarts: number;
  readonly withinMs: number;
}
```

### DuplicateChildError

```typescript
class DuplicateChildError extends Error {
  readonly name = 'DuplicateChildError';
  readonly supervisorId: string;
  readonly childId: string;
}
```

### ChildNotFoundError

```typescript
class ChildNotFoundError extends Error {
  readonly name = 'ChildNotFoundError';
  readonly supervisorId: string;
  readonly childId: string;
}
```

### MissingChildTemplateError

Vyhozena když je `simple_one_for_one` supervisor spuštěn bez `childTemplate`.

```typescript
class MissingChildTemplateError extends Error {
  readonly name = 'MissingChildTemplateError';
  readonly supervisorId: string;
}
```

### InvalidSimpleOneForOneConfigError

Vyhozena když má `simple_one_for_one` supervisor neplatnou konfiguraci.

```typescript
class InvalidSimpleOneForOneConfigError extends Error {
  readonly name = 'InvalidSimpleOneForOneConfigError';
  readonly supervisorId: string;
  readonly reason: string;
}
```

---

## Kompletní příklad

```typescript
import { Supervisor, GenServer, type GenServerBehavior, type ChildSpec } from 'noex';

// Chování workeru
const workerBehavior: GenServerBehavior<number, 'status', 'work', string> = {
  init: () => 0,
  handleCall: (msg, state) => [`Zpracováno ${state} položek`, state],
  handleCast: (msg, state) => state + 1,
  terminate: (reason, state) => {
    console.log(`Worker ukončen po zpracování ${state} položek`);
  },
};

// Vytvoření supervisoru s workery
async function startWorkerPool(size: number) {
  const children: ChildSpec[] = [];

  for (let i = 0; i < size; i++) {
    children.push({
      id: `worker-${i}`,
      start: () => GenServer.start(workerBehavior),
      restart: 'permanent',
      shutdownTimeout: 5000,
    });
  }

  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 10, withinMs: 60000 },
    children,
  });

  return supervisor;
}

// Použití
async function main() {
  const pool = await startWorkerPool(3);

  // Výpis workerů
  const workers = Supervisor.getChildren(pool);
  console.log(`Spuštěno ${workers.length} workerů`);

  // Odeslání práce všem workerům
  for (const worker of workers) {
    GenServer.cast(worker.ref, 'work');
  }

  // Dynamické přidání dalšího workeru
  await Supervisor.startChild(pool, {
    id: 'worker-3',
    start: () => GenServer.start(workerBehavior),
  });

  // Kontrola stavu workerů
  for (const worker of Supervisor.getChildren(pool)) {
    const status = await GenServer.call(worker.ref, 'status');
    console.log(`${worker.id}: ${status}`);
  }

  // Ukončení
  await Supervisor.stop(pool);
}
```

---

## Příklady restart strategií potomků

### permanent - Vždy restartovat

Použijte `permanent` pro kritické služby, které musí vždy běžet:

```typescript
const supervisor = await Supervisor.start({
  children: [
    {
      id: 'database-connection',
      start: () => GenServer.start(dbConnectionBehavior),
      restart: 'permanent',  // Vždy restartovat, i při normálním ukončení
    },
  ],
});
```

### transient - Restartovat pouze při pádech

Použijte `transient` pro workery, kteří by měli být restartováni při selhání, ale ne když dokončí normálně:

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from 'noex';

// Procesor úloh, který dokončí práci a normálně se ukončí
const taskProcessorBehavior: GenServerBehavior<
  { taskId: string; completed: boolean },
  'status',
  { type: 'process'; data: unknown },
  string
> = {
  init: () => ({ taskId: '', completed: false }),

  handleCall: (msg, state) => {
    return [`Úloha ${state.taskId}: ${state.completed ? 'hotovo' : 'zpracovává se'}`, state];
  },

  handleCast: async (msg, state) => {
    if (msg.type === 'process') {
      // Zpracování úlohy...
      console.log(`Zpracovávám úlohu s daty: ${JSON.stringify(msg.data)}`);
      return { ...state, completed: true };
    }
    return state;
  },
};

async function main() {
  const supervisor = await Supervisor.start({
    children: [
      {
        id: 'task-processor',
        start: () => GenServer.start(taskProcessorBehavior),
        restart: 'transient',  // Restart při pádu, ne při normálním dokončení
      },
    ],
  });

  const processor = Supervisor.getChild(supervisor, 'task-processor');
  if (processor) {
    // Pokud spadne (vyhodí chybu) → potomek bude restartován
    // Pokud dokončí normálně → potomek NEBUDE restartován
    GenServer.cast(processor.ref, { type: 'process', data: { id: 1 } });
  }
}
```

### temporary - Nikdy nerestartovat

Použijte `temporary` pro jednorázové úlohy nebo externě spravované potomky:

```typescript
const supervisor = await Supervisor.start({
  children: [
    {
      id: 'one-time-migration',
      start: () => GenServer.start(migrationBehavior),
      restart: 'temporary',  // Spustit jednou, nikdy nerestartovat
    },
  ],
});
```

---

## Příklad simple_one_for_one

Použijte `simple_one_for_one` když potřebujete dynamicky spouštět mnoho identických potomků:

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from 'noex';

// Továrna na chování workeru
function createWorkerBehavior(workerId: string): GenServerBehavior<{ id: string; count: number }, 'status', 'work', string> {
  return {
    init: () => ({ id: workerId, count: 0 }),
    handleCall: (msg, state) => [`Worker ${state.id}: zpracováno ${state.count} úloh`, state],
    handleCast: (msg, state) => ({ ...state, count: state.count + 1 }),
  };
}

async function main() {
  // Vytvoření supervisoru se šablonou
  const supervisor = await Supervisor.start({
    strategy: 'simple_one_for_one',
    childTemplate: {
      start: async (workerId: string) => GenServer.start(createWorkerBehavior(workerId)),
      restart: 'transient',
    },
  });

  // Dynamické spouštění workerů
  const workers = await Promise.all([
    Supervisor.startChild(supervisor, ['worker-1']),
    Supervisor.startChild(supervisor, ['worker-2']),
    Supervisor.startChild(supervisor, ['worker-3']),
  ]);

  // Všichni workeři nyní běží
  console.log(`Spuštěno ${Supervisor.countChildren(supervisor)} workerů`);

  await Supervisor.stop(supervisor);
}
```

---

## Příklad auto_shutdown

Použijte `autoShutdown` pro automatické ukončení supervisoru při ukončení významných potomků:

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from 'noex';

const primaryBehavior: GenServerBehavior<void, never, never, never> = {
  init: () => undefined,
  handleCall: () => [undefined as never, undefined],
  handleCast: () => undefined,
};

const secondaryBehavior: GenServerBehavior<void, never, never, never> = {
  init: () => undefined,
  handleCall: () => [undefined as never, undefined],
  handleCast: () => undefined,
};

async function main() {
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    autoShutdown: 'any_significant',
    children: [
      {
        id: 'primary-service',
        start: () => GenServer.start(primaryBehavior),
        significant: true,  // Supervisor se ukončí při ukončení tohoto potomka
      },
      {
        id: 'secondary-service',
        start: () => GenServer.start(secondaryBehavior),
        significant: false, // Toto nespustí ukončení
      },
    ],
  });

  // Když se primary-service ukončí, supervisor se automaticky ukončí
}
```

---

## Nejlepší postupy

### Volba správné restart strategie

| Případ použití | Strategie | Důvod |
|----------------|-----------|-------|
| Databázová připojení | `permanent` | Musí být vždy dostupná |
| HTTP servery | `permanent` | Měly by se zotavit z jakéhokoliv selhání |
| Workeři na pozadí | `transient` | Restart při pádu, ne při dokončení úlohy |
| Jednorázová inicializace | `temporary` | Spustit jednou, nerestartovat |
| Event handlery | `transient` | Zotavení z chyb, povolení čistého ukončení |
| Connection pools | `permanent` | Udržení velikosti poolu |

### Volba správné supervisor strategie

| Případ použití | Strategie | Důvod |
|----------------|-----------|-------|
| Nezávislé služby | `one_for_one` | Selhání jsou izolovaná |
| Těsně svázané služby | `one_for_all` | Všechny musí restartovat společně |
| Pipeline zpracování | `rest_for_one` | Downstream závisí na upstream |
| Worker pools | `simple_one_for_one` | Homogenní, dynamičtí potomci |

### Vzory auto-shutdown

| Případ použití | `autoShutdown` | Příklad |
|----------------|----------------|---------|
| Dlouho běžící služby | `'never'` | Web servery, daemoni |
| Dávkové zpracování | `'all_significant'` | Všichni workeři musí dokončit |
| Kritická závislost | `'any_significant'` | Ukončení při selhání primární služby |

---

## Související

- [Koncepty Supervisoru](../concepts/supervisor.md) - Pochopení supervize
- [GenServer API](./genserver.md) - API potomků
- [Reference chyb](./errors.md) - Všechny třídy chyb
