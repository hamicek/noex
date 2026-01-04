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
  readonly restartIntensity?: RestartIntensity;
  readonly name?: string;
}
```

### SupervisorStrategy

Strategie pro zpracování selhání potomků.

```typescript
type SupervisorStrategy = 'one_for_one' | 'one_for_all' | 'rest_for_one';
```

| Strategie | Chování |
|-----------|---------|
| `'one_for_one'` | Restartovat pouze spadlého potomka (výchozí) |
| `'one_for_all'` | Restartovat všechny potomky, když jeden selže |
| `'rest_for_one'` | Restartovat spadlého potomka a všechny potomky spuštěné po něm |

### ChildSpec

Specifikace potomka.

```typescript
interface ChildSpec<State = unknown, CallMsg = unknown, CastMsg = unknown, CallReply = unknown> {
  readonly id: string;
  readonly start: () => Promise<GenServerRef<State, CallMsg, CastMsg, CallReply>>;
  readonly restart?: ChildRestartStrategy;
  readonly shutdownTimeout?: number;
}
```

### ChildRestartStrategy

Kdy restartovat potomka.

```typescript
type ChildRestartStrategy = 'permanent' | 'transient' | 'temporary';
```

| Strategie | Chování |
|-----------|---------|
| `'permanent'` | Vždy restartovat (výchozí) |
| `'transient'` | Restartovat pouze při abnormálním ukončení |
| `'temporary'` | Nikdy nerestartovat |

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

## Související

- [Koncepty Supervisoru](../concepts/supervisor.md) - Pochopení supervize
- [GenServer API](./genserver.md) - API potomků
- [Reference chyb](./errors.md) - Všechny třídy chyb
