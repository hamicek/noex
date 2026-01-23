# GenServer API Reference

Objekt `GenServer` poskytuje metody pro spouštění, komunikaci a zastavování instancí GenServeru.

## Import

```typescript
import { GenServer } from 'noex';
```

## Typy

### GenServerRef

Neprůhledná reference na běžící instanci GenServeru.

```typescript
interface GenServerRef<
  State = unknown,
  CallMsg = unknown,
  CastMsg = unknown,
  CallReply = unknown,
> {
  readonly id: string;
}
```

### GenServerBehavior

Rozhraní definující callbacky GenServeru.

```typescript
interface GenServerBehavior<State, CallMsg, CastMsg, CallReply> {
  init(): State | Promise<State>;
  handleCall(msg: CallMsg, state: State): CallResult<CallReply, State> | Promise<CallResult<CallReply, State>>;
  handleCast(msg: CastMsg, state: State): State | Promise<State>;
  terminate?(reason: TerminateReason, state: State): void | Promise<void>;
}
```

### CallResult

Návratový typ pro `handleCall`.

```typescript
type CallResult<Reply, State> = readonly [Reply, State];
```

### TerminateReason

Důvod předaný do callbacku `terminate`.

```typescript
type TerminateReason = 'normal' | 'shutdown' | { readonly error: Error };
```

### StartOptions

Volby pro `GenServer.start()`.

```typescript
interface StartOptions {
  readonly name?: string;
  readonly initTimeout?: number;  // výchozí: 5000
}
```

### CallOptions

Volby pro `GenServer.call()`.

```typescript
interface CallOptions {
  readonly timeout?: number;  // výchozí: 5000
}
```

---

## Metody

### start()

Spustí nový GenServer s daným chováním.

```typescript
async start<State, CallMsg, CastMsg, CallReply>(
  behavior: GenServerBehavior<State, CallMsg, CastMsg, CallReply>,
  options?: StartOptions,
): Promise<GenServerRef<State, CallMsg, CastMsg, CallReply>>
```

**Parametry:**
- `behavior` - Objekt implementující callbacky GenServerBehavior
- `options` - Volitelná konfigurace startu
  - `name` - Zaregistrovat server pod tímto jménem v Registry (automaticky odregistrován při ukončení)
  - `initTimeout` - Maximální čas pro dokončení `init()` (výchozí: 5000ms)

**Vrací:** Promise resolvující na GenServerRef

**Vyhazuje:**
- `InitializationError` - Pokud `init()` selže nebo vyprší timeout
- `AlreadyRegisteredError` - Pokud je `options.name` již zaregistrováno

**Příklad:**
```typescript
const behavior: GenServerBehavior<number, 'get', 'inc', number> = {
  init: () => 0,
  handleCall: (msg, state) => [state, state],
  handleCast: (msg, state) => state + 1,
};

const ref = await GenServer.start(behavior);

// S registrací jména (lze vyhledat přes Registry.lookup('counter'))
const ref = await GenServer.start(behavior, {
  name: 'counter',
  initTimeout: 10000,
});
```

---

### call()

Odešle synchronní zprávu a čeká na odpověď.

```typescript
async call<State, CallMsg, CastMsg, CallReply>(
  ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
  msg: CallMsg,
  options?: CallOptions,
): Promise<CallReply>
```

**Parametry:**
- `ref` - Reference na cílový server
- `msg` - Zpráva k odeslání
- `options` - Volitelná konfigurace volání
  - `timeout` - Maximální čas čekání na odpověď (výchozí: 5000ms)

**Vrací:** Promise resolvující na odpověď z `handleCall`

**Vyhazuje:**
- `CallTimeoutError` - Pokud nepřijde odpověď v rámci timeoutu
- `ServerNotRunningError` - Pokud server neběží
- Jakákoliv chyba vyhozená z `handleCall`

**Příklad:**
```typescript
// Základní volání
const value = await GenServer.call(counter, 'get');

// S timeoutem
const value = await GenServer.call(counter, 'get', { timeout: 10000 });

// Typovaná zpráva
const result = await GenServer.call(cache, { type: 'get', key: 'user:1' });
```

---

### cast()

Odešle asynchronní zprávu bez čekání na odpověď.

```typescript
cast<State, CallMsg, CastMsg, CallReply>(
  ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
  msg: CastMsg,
): void
```

**Parametry:**
- `ref` - Reference na cílový server
- `msg` - Zpráva k odeslání

**Vrací:** void (fire-and-forget)

**Vyhazuje:**
- `ServerNotRunningError` - Pokud server neběží

**Příklad:**
```typescript
// Fire and forget
GenServer.cast(counter, 'increment');

// Typovaná zpráva
GenServer.cast(logger, { type: 'log', level: 'info', message: 'Hello' });
```

---

### sendAfter()

Naplánuje cast zprávu k doručení po zadané prodlevě. Non-durable: timer nepřežije restart procesu. Pro odolné timery viz [TimerService](./timer-service.md).

```typescript
sendAfter<State, CallMsg, CastMsg, CallReply>(
  ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
  msg: CastMsg,
  delayMs: number,
): TimerRef
```

**Parametry:**
- `ref` - Reference na cílový server
- `msg` - Cast zpráva k odeslání
- `delayMs` - Prodleva v milisekundách před odesláním

**Vrací:** `TimerRef` použitelný s `cancelTimer()`

**Příklad:**
```typescript
// Odeslat zprávu po 5 sekundách
const timerRef = GenServer.sendAfter(worker, { type: 'timeout' }, 5000);

// Implementace periodického ticku přeplánováním v handleCast
GenServer.sendAfter(ref, 'tick', 1000);
```

---

### cancelTimer()

Zruší dříve naplánovaný timer.

```typescript
cancelTimer(timerRef: TimerRef): boolean
```

**Parametry:**
- `timerRef` - Reference na timer ke zrušení (vrácená z `sendAfter()`)

**Vrací:** `true` pokud timer stále čekal a byl zrušen, `false` pokud již vystřelil nebo byl dříve zrušen

**Příklad:**
```typescript
const timerRef = GenServer.sendAfter(server, 'timeout', 10000);

// Zrušit před vystřelením
if (GenServer.cancelTimer(timerRef)) {
  console.log('Timer zrušen');
}
```

---

### stop()

Gracefully zastaví server.

```typescript
async stop<State, CallMsg, CastMsg, CallReply>(
  ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
  reason?: TerminateReason,
): Promise<void>
```

**Parametry:**
- `ref` - Reference na server k zastavení
- `reason` - Důvod zastavení (výchozí: `'normal'`)

**Vrací:** Promise, která se vyřeší po zastavení serveru

**Příklad:**
```typescript
// Normální ukončení
await GenServer.stop(counter);

// S důvodem
await GenServer.stop(counter, 'shutdown');
await GenServer.stop(counter, { error: new Error('Fatal') });
```

---

### isRunning()

Zjistí, zda server aktuálně běží.

```typescript
isRunning<State, CallMsg, CastMsg, CallReply>(
  ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
): boolean
```

**Parametry:**
- `ref` - Reference ke kontrole

**Vrací:** `true` pokud server běží

**Příklad:**
```typescript
if (GenServer.isRunning(counter)) {
  await GenServer.call(counter, 'get');
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

**Typy LifecycleEvent:**
```typescript
type LifecycleEvent =
  | { type: 'started'; ref: GenServerRef }
  | { type: 'crashed'; ref: GenServerRef; error: Error }
  | { type: 'terminated'; ref: GenServerRef; reason: TerminateReason };
```

**Příklad:**
```typescript
const unsubscribe = GenServer.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Spuštěn: ${event.ref.id}`);
      break;
    case 'crashed':
      console.error(`Spadl: ${event.ref.id}`, event.error);
      break;
    case 'terminated':
      console.log(`Ukončen: ${event.ref.id}`, event.reason);
      break;
  }
});

// Později: ukončení naslouchání
unsubscribe();
```

---

## Callbacky chování

### init()

Voláno jednou při startu serveru pro inicializaci stavu.

```typescript
init(): State | Promise<State>
```

**Vrací:** Počáteční stav (sync nebo async)

**Vyhazuje:** Jakákoliv chyba zabrání spuštění serveru

**Příklad:**
```typescript
// Synchronní
init: () => ({ count: 0, items: [] })

// Asynchronní
init: async () => {
  const data = await loadFromDatabase();
  return { data, ready: true };
}
```

---

### handleCall()

Zpracovává synchronní call zprávy.

```typescript
handleCall(
  msg: CallMsg,
  state: State,
): CallResult<CallReply, State> | Promise<CallResult<CallReply, State>>
```

**Parametry:**
- `msg` - Call zpráva
- `state` - Aktuální stav serveru

**Vrací:** Tuple `[reply, newState]`

**Příklad:**
```typescript
handleCall: (msg, state) => {
  switch (msg.type) {
    case 'get':
      return [state.value, state];
    case 'getAndIncrement':
      return [state.value, { ...state, value: state.value + 1 }];
    default:
      return [null, state];
  }
}
```

---

### handleCast()

Zpracovává asynchronní cast zprávy.

```typescript
handleCast(msg: CastMsg, state: State): State | Promise<State>
```

**Parametry:**
- `msg` - Cast zpráva
- `state` - Aktuální stav serveru

**Vrací:** Nový stav

**Příklad:**
```typescript
handleCast: (msg, state) => {
  switch (msg.type) {
    case 'increment':
      return { ...state, count: state.count + 1 };
    case 'reset':
      return { ...state, count: 0 };
    default:
      return state;
  }
}
```

---

### terminate()

Voláno během graceful shutdown pro úklid. Volitelné.

```typescript
terminate?(reason: TerminateReason, state: State): void | Promise<void>
```

**Parametry:**
- `reason` - Proč se server ukončuje
- `state` - Finální stav serveru

**Příklad:**
```typescript
terminate: async (reason, state) => {
  console.log(`Ukončuji: ${reason}`);
  await state.connection?.close();
  clearInterval(state.timer);
}
```

---

## Třídy chyb

### CallTimeoutError

```typescript
class CallTimeoutError extends Error {
  readonly name = 'CallTimeoutError';
  readonly serverId: string;
  readonly timeoutMs: number;
}
```

### ServerNotRunningError

```typescript
class ServerNotRunningError extends Error {
  readonly name = 'ServerNotRunningError';
  readonly serverId: string;
}
```

### InitializationError

```typescript
class InitializationError extends Error {
  readonly name = 'InitializationError';
  readonly serverId: string;
  readonly cause: Error;
}
```

---

## Kompletní příklad

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

// Definice typů
interface CounterState {
  value: number;
  history: number[];
}

type CounterCall =
  | { type: 'get' }
  | { type: 'getHistory' };

type CounterCast =
  | { type: 'increment'; by?: number }
  | { type: 'decrement'; by?: number }
  | { type: 'reset' };

type CounterReply = number | number[];

// Definice chování
const counterBehavior: GenServerBehavior<
  CounterState,
  CounterCall,
  CounterCast,
  CounterReply
> = {
  init: () => ({
    value: 0,
    history: [],
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.value, state];
      case 'getHistory':
        return [state.history, state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'increment': {
        const by = msg.by ?? 1;
        return {
          value: state.value + by,
          history: [...state.history, state.value + by],
        };
      }
      case 'decrement': {
        const by = msg.by ?? 1;
        return {
          value: state.value - by,
          history: [...state.history, state.value - by],
        };
      }
      case 'reset':
        return { value: 0, history: [] };
    }
  },

  terminate: (reason, state) => {
    console.log(`Čítač ukončen s hodnotou ${state.value}`);
  },
};

// Použití
async function main() {
  const counter = await GenServer.start(counterBehavior);

  GenServer.cast(counter, { type: 'increment' });
  GenServer.cast(counter, { type: 'increment', by: 5 });
  GenServer.cast(counter, { type: 'decrement', by: 2 });

  const value = await GenServer.call(counter, { type: 'get' });
  console.log('Hodnota:', value);  // 4

  const history = await GenServer.call(counter, { type: 'getHistory' });
  console.log('Historie:', history);  // [1, 6, 4]

  await GenServer.stop(counter);
}
```

## Související

- [Koncepty GenServeru](../concepts/genserver.md) - Pochopení GenServeru
- [TimerService API](./timer-service.md) - Odolné timery s persistencí
- [Supervisor API](./supervisor.md) - Odolnost proti chybám
- [Registry API](./registry.md) - Vyhledávání pojmenovaných procesů
- [Reference typů](./types.md) - Všechny definice typů
- [Reference chyb](./errors.md) - Všechny třídy chyb
