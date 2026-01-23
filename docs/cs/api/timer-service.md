# TimerService API Reference

Služba `TimerService` poskytuje odolné (durable) timery, které přežijí restart procesu. Na rozdíl od `GenServer.sendAfter()`, který je non-durable (ztracen při restartu), tato služba persistuje záznamy timerů přes `StorageAdapter`. Podporuje jednorázové i opakované timery.

## Import

```typescript
import { TimerService } from 'noex';
```

## Typy

### TimerServiceRef

Neprůhledná reference na běžící instanci TimerService.

```typescript
type TimerServiceRef = GenServerRef<TimerServiceState, TimerCallMsg, TimerCastMsg, TimerCallReply>;
```

### DurableTimerOptions

Volby pro `TimerService.start()`.

```typescript
interface DurableTimerOptions {
  /** Storage adaptér pro persistenci timerů */
  readonly adapter: StorageAdapter;

  /** Jak často kontrolovat expirované timery (ms). @default 1000 */
  readonly checkIntervalMs?: number;

  /** Volitelné jméno pro registraci v registry */
  readonly name?: string;
}
```

### TimerEntry

Persistovaný záznam timeru.

```typescript
interface TimerEntry {
  /** Unikátní identifikátor timeru */
  readonly id: string;

  /** Unix timestamp (ms) kdy má timer vystřelit */
  readonly fireAt: number;

  /** Reference na cílový proces */
  readonly targetRef: { readonly id: string; readonly nodeId?: string };

  /** Zpráva k doručení přes GenServer.cast() */
  readonly message: unknown;

  /** Pokud je nastaveno, timer se opakuje s tímto intervalem (ms) */
  readonly repeat?: number;
}
```

### ScheduleOptions

Volby pro `TimerService.schedule()`.

```typescript
interface ScheduleOptions {
  /** Pokud je nastaveno, timer se opakuje s tímto intervalem (ms) */
  readonly repeat?: number;
}
```

---

## Metody

### start()

Spustí novou instanci DurableTimerService. Načte dříve persistované timery z adaptéru a zahájí periodickou kontrolu expirovaných timerů.

```typescript
async start(options: DurableTimerOptions): Promise<TimerServiceRef>
```

**Parametry:**
- `options` - Konfigurace služby
  - `adapter` - StorageAdapter pro persistenci timerů (povinný)
  - `checkIntervalMs` - Interval kontroly expirovaných timerů (výchozí: 1000ms)
  - `name` - Registrovat pod tímto jménem v Registry

**Vrací:** Promise s TimerServiceRef

**Příklad:**
```typescript
import { TimerService, MemoryAdapter } from 'noex';

const timers = await TimerService.start({
  adapter: new MemoryAdapter(),
  checkIntervalMs: 500,
});
```

---

### schedule()

Naplánuje odolný timer, který doručí cast zprávu cílovému procesu po zadané prodlevě.

```typescript
async schedule(
  ref: TimerServiceRef,
  targetRef: GenServerRef,
  message: unknown,
  delayMs: number,
  options?: ScheduleOptions,
): Promise<string>
```

**Parametry:**
- `ref` - Reference na TimerService
- `targetRef` - Cílový proces pro příjem zprávy
- `message` - Cast zpráva k doručení
- `delayMs` - Prodleva v milisekundách před prvním doručením
- `options` - Volitelná konfigurace
  - `repeat` - Pokud je nastaveno, timer se opakuje s tímto intervalem (ms)

**Vrací:** ID timeru pro pozdější zrušení

**Příklad:**
```typescript
// Jednorázový timer
const timerId = await TimerService.schedule(timers, workerRef, { type: 'cleanup' }, 60000);

// Opakovaný timer (každých 5 sekund)
const tickId = await TimerService.schedule(
  timers, monitorRef,
  { type: 'healthcheck' },
  5000,
  { repeat: 5000 },
);
```

---

### cancel()

Zruší dříve naplánovaný odolný timer.

```typescript
async cancel(ref: TimerServiceRef, timerId: string): Promise<boolean>
```

**Parametry:**
- `ref` - Reference na TimerService
- `timerId` - ID timeru vrácené z `schedule()`

**Vrací:** `true` pokud timer čekal a byl zrušen, `false` jinak

**Příklad:**
```typescript
const wasCancelled = await TimerService.cancel(timers, timerId);
```

---

### get()

Vrátí konkrétní záznam timeru podle ID.

```typescript
async get(ref: TimerServiceRef, timerId: string): Promise<TimerEntry | undefined>
```

**Parametry:**
- `ref` - Reference na TimerService
- `timerId` - ID timeru k vyhledání

**Vrací:** Záznam timeru, nebo `undefined` pokud nebyl nalezen

**Příklad:**
```typescript
const entry = await TimerService.get(timers, timerId);
if (entry) {
  console.log(`Timer vystřelí: ${new Date(entry.fireAt)}`);
}
```

---

### getAll()

Vrátí všechny čekající záznamy timerů.

```typescript
async getAll(ref: TimerServiceRef): Promise<readonly TimerEntry[]>
```

**Parametry:**
- `ref` - Reference na TimerService

**Vrací:** Pole všech čekajících záznamů timerů

**Příklad:**
```typescript
const pending = await TimerService.getAll(timers);
console.log(`${pending.length} timerů čeká`);
```

---

### isRunning()

Zjistí, zda TimerService běží.

```typescript
isRunning(ref: TimerServiceRef): boolean
```

**Parametry:**
- `ref` - Reference na TimerService

**Vrací:** `true` pokud běží

---

### stop()

Zastaví službu timerů. Persistované timery zůstanou v úložišti a budou obnoveny při dalším startu.

```typescript
async stop(ref: TimerServiceRef): Promise<void>
```

**Parametry:**
- `ref` - Reference na TimerService

**Příklad:**
```typescript
await TimerService.stop(timers);
```

---

## Chování persistence

- **Při naplánování:** Záznam timeru je okamžitě persistován do adaptéru
- **Při zrušení:** Záznam timeru je odstraněn z úložiště
- **Při vystřelení (jednorázový):** Záznam je odstraněn po doručení
- **Při vystřelení (opakovaný):** Záznam je aktualizován s novým `fireAt` a znovu persistován
- **Při restartu:** Všechny timery jsou načteny z adaptéru; zpožděné timery vystřelí při prvním ticku

---

## Kompletní příklad

```typescript
import { GenServer, TimerService, MemoryAdapter, type GenServerBehavior } from 'noex';

// Worker zpracovávající periodické úlohy
const workerBehavior: GenServerBehavior<number, 'getCount', { type: 'process' }, number> = {
  init: () => 0,
  handleCall: (msg, state) => [state, state],
  handleCast: (msg, state) => {
    if (msg.type === 'process') {
      console.log(`Zpracovávám úlohu #${state + 1}`);
      return state + 1;
    }
    return state;
  },
};

async function main() {
  const adapter = new MemoryAdapter();

  // Spustit worker a timer service
  const worker = await GenServer.start(workerBehavior);
  const timers = await TimerService.start({ adapter, checkIntervalMs: 500 });

  // Naplánovat opakovanou úlohu každé 2 sekundy
  const timerId = await TimerService.schedule(
    timers, worker,
    { type: 'process' },
    2000,
    { repeat: 2000 },
  );

  // Po nějakém čase zrušit opakovanou úlohu
  setTimeout(async () => {
    await TimerService.cancel(timers, timerId);
    const count = await GenServer.call(worker, 'getCount');
    console.log(`Zpracováno ${count} úloh celkem`);

    await TimerService.stop(timers);
    await GenServer.stop(worker);
  }, 10000);
}
```

---

## sendAfter vs TimerService

| Vlastnost | `GenServer.sendAfter()` | `TimerService.schedule()` |
|-----------|------------------------|---------------------------|
| Odolnost | Non-durable (ztracen při restartu) | Durable (persistován do úložiště) |
| Režie | Minimální (raw setTimeout) | Vyšší (GenServer + persistence) |
| Opakování | Ruční přeplánování | Vestavěná volba `repeat` |
| Zrušení | Synchronní | Async (přes GenServer call) |
| Použití | Efemérní prodlevy | Kritické plánované úlohy |

---

## Související

- [GenServer API](./genserver.md) - sendAfter() pro non-durable timery
- [Cache API](./cache.md) - Další služba postavená na GenServeru
- [Reference typů](./types.md) - Typ TimerRef
