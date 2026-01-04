# GenServer

GenServer (Generic Server) je základní abstrakce v noex pro vytváření stavových, konkurentních služeb. Poskytuje model podobný procesům inspirovaný Elixir/OTP, přinášející osvědčené vzory do TypeScriptu.

## Přehled

GenServer zapouzdřuje:
- **Stav** - Interní data, která přetrvávají mezi zprávami
- **Zpracování zpráv** - Serializované zpracování příchozích požadavků
- **Správa životního cyklu** - Inicializace, běh a graceful shutdown

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

// Definice behavior
const counterBehavior: GenServerBehavior<number, 'get', 'increment', number> = {
  init: () => 0,
  handleCall: (msg, state) => [state, state],      // Vrací [odpověď, novýStav]
  handleCast: (msg, state) => state + 1,           // Vrací novýStav
};

// Spuštění a použití
const counter = await GenServer.start(counterBehavior);
await GenServer.cast(counter, 'increment');
const value = await GenServer.call(counter, 'get');  // 1
await GenServer.stop(counter);
```

## Základní koncepty

### Serializace zpráv

Všechny zprávy jsou zpracovávány sekvenčně přes interní frontu. To eliminuje race conditions a činí změny stavu předvídatelnými:

```
Fronta zpráv: [msg1] → [msg2] → [msg3]
                ↓
             Zpracuj msg1, aktualizuj stav
                ↓
             Zpracuj msg2, aktualizuj stav
                ↓
             Zpracuj msg3, aktualizuj stav
```

I při konkurentních volajících je každá zpráva zpracována postupně:

```typescript
// Tato volání jsou zařazena do fronty a zpracována sekvenčně
await Promise.all([
  GenServer.call(counter, 'get'),
  GenServer.cast(counter, 'increment'),
  GenServer.call(counter, 'get'),
]);
```

### Call vs Cast

GenServer podporuje dva vzory zpráv:

| Vzor | Metoda | Blokující | Vrací | Použití |
|------|--------|-----------|-------|---------|
| **Call** | `GenServer.call()` | Ano | Hodnotu odpovědi | Dotazy, operace vyžadující potvrzení |
| **Cast** | `GenServer.cast()` | Ne | void | Fire-and-forget aktualizace, notifikace |

#### Call - Synchronní požadavek/odpověď

Call blokuje, dokud server nezpracuje zprávu a nevrátí odpověď:

```typescript
const behavior: GenServerBehavior<Map<string, string>, GetMsg | SetMsg, never, string | void> = {
  init: () => new Map(),
  handleCall: (msg, state) => {
    if (msg.type === 'get') {
      return [state.get(msg.key), state];
    }
    if (msg.type === 'set') {
      state.set(msg.key, msg.value);
      return [undefined, state];
    }
    return [undefined, state];
  },
  handleCast: (_, state) => state,
};

// Volající čeká na odpověď
const value = await GenServer.call(server, { type: 'get', key: 'foo' });
```

#### Cast - Asynchronní fire-and-forget

Cast vrací okamžitě bez čekání:

```typescript
const loggerBehavior: GenServerBehavior<string[], never, LogMsg, never> = {
  init: () => [],
  handleCall: (_, state) => [undefined as never, state],
  handleCast: (msg, state) => {
    console.log(msg.message);
    return [...state, msg.message];
  },
};

// Vrací okamžitě, nečeká na zpracování
GenServer.cast(logger, { message: 'User logged in' });
```

### Rozhraní GenServerBehavior

Každý GenServer vyžaduje behavior objekt implementující čtyři callbacky:

```typescript
interface GenServerBehavior<State, CallMsg, CastMsg, CallReply> {
  // Povinné: Inicializace stavu
  init(): State | Promise<State>;

  // Povinné: Zpracování synchronních call
  handleCall(msg: CallMsg, state: State): CallResult<CallReply, State> | Promise<CallResult<CallReply, State>>;

  // Povinné: Zpracování asynchronních cast
  handleCast(msg: CastMsg, state: State): State | Promise<State>;

  // Volitelné: Čištění při shutdown
  terminate?(reason: TerminateReason, state: State): void | Promise<void>;
}
```

#### init()

Volá se jednou při startu serveru. Vrací počáteční stav.

```typescript
init: () => ({
  connections: new Map(),
  startedAt: Date.now(),
})
```

Asynchronní inicializace je podporována:

```typescript
init: async () => {
  const config = await loadConfig();
  return { config, ready: true };
}
```

#### handleCall(msg, state)

Zpracovává synchronní zprávy. Musí vrátit tuple `[odpověď, novýStav]`:

```typescript
handleCall: (msg, state) => {
  switch (msg.type) {
    case 'get_count':
      return [state.count, state];  // Odpověď s count, stav nezměněn
    case 'increment':
      const newState = { ...state, count: state.count + 1 };
      return [newState.count, newState];  // Odpověď s novým count
    default:
      return [null, state];
  }
}
```

#### handleCast(msg, state)

Zpracovává asynchronní zprávy. Vrací pouze nový stav:

```typescript
handleCast: (msg, state) => {
  switch (msg.type) {
    case 'log':
      console.log(msg.data);
      return state;  // Stav nezměněn
    case 'reset':
      return { ...state, count: 0 };  // Stav aktualizován
    default:
      return state;
  }
}
```

#### terminate(reason, state)

Volitelný cleanup hook volaný při shutdown:

```typescript
terminate: async (reason, state) => {
  // Zavření spojení
  for (const conn of state.connections.values()) {
    await conn.close();
  }
  // Flush pending dat
  await state.buffer.flush();
  console.log(`Server ukončen: ${reason}`);
}
```

## Životní cyklus

GenServer prochází těmito stavy:

```
[start] → initializing → running → stopping → stopped
              ↓                        ↓
          init() voláno         terminate() voláno
```

### Spuštění

```typescript
const ref = await GenServer.start(behavior, {
  name: 'my-server',      // Volitelné: registrace v Registry
  initTimeout: 5000,      // Volitelné: max čas pro init() (výchozí: 5000ms)
});
```

### Kontrola stavu

```typescript
if (GenServer.isRunning(ref)) {
  // Server je dostupný
}
```

### Zastavení

```typescript
// Graceful shutdown - čeká na pending zprávy
await GenServer.stop(ref);

// S vlastním důvodem
await GenServer.stop(ref, 'shutdown');
```

## Timeouty

### Call timeout

Call má výchozí timeout 5 sekund:

```typescript
try {
  // Výchozí 5s timeout
  await GenServer.call(server, msg);

  // Vlastní timeout
  await GenServer.call(server, msg, { timeout: 10000 });
} catch (error) {
  if (error instanceof CallTimeoutError) {
    console.error('Call vypršel');
  }
}
```

### Init timeout

Inicializace serveru má také timeout:

```typescript
try {
  await GenServer.start(behavior, { initTimeout: 3000 });
} catch (error) {
  if (error instanceof InitializationError) {
    console.error('Init selhal nebo vypršel');
  }
}
```

## Zpracování chyb

### V handleCall

Chyby v `handleCall` jsou propagovány volajícímu:

```typescript
handleCall: (msg, state) => {
  if (!state.isReady) {
    throw new Error('Server není připraven');
  }
  return [state.data, state];
}

// Volající obdrží chybu
try {
  await GenServer.call(server, 'getData');
} catch (error) {
  // "Server není připraven"
}
```

### V handleCast

Chyby v `handleCast` jsou tiše ignorovány (není komu je doručit). Pro monitoring použijte lifecycle events:

```typescript
GenServer.onLifecycleEvent((event) => {
  if (event.type === 'crashed') {
    console.error(`Server ${event.ref.id} spadl:`, event.error);
  }
});
```

### Server neběží

Volání zastaveného serveru vyhodí `ServerNotRunningError`:

```typescript
await GenServer.stop(server);

try {
  await GenServer.call(server, msg);
} catch (error) {
  if (error instanceof ServerNotRunningError) {
    console.error('Server je zastaven');
  }
}
```

## Typová bezpečnost

GenServer využívá typový systém TypeScriptu pro bezpečnost zpráv:

```typescript
// Definice typů zpráv
type CallMsg =
  | { type: 'get'; key: string }
  | { type: 'keys' };

type CastMsg =
  | { type: 'set'; key: string; value: string }
  | { type: 'delete'; key: string };

type CallReply = string | undefined | string[];

// Typ stavu
interface CacheState {
  data: Map<string, string>;
}

// Plně typovaný behavior
const behavior: GenServerBehavior<CacheState, CallMsg, CastMsg, CallReply> = {
  init: () => ({ data: new Map() }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.data.get(msg.key), state];
      case 'keys':
        return [Array.from(state.data.keys()), state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'set':
        state.data.set(msg.key, msg.value);
        return state;
      case 'delete':
        state.data.delete(msg.key);
        return state;
    }
  },
};
```

## Lifecycle Events

Monitorujte životní cyklus GenServeru pomocí globálních handlerů:

```typescript
const unsubscribe = GenServer.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Server spuštěn: ${event.ref.id}`);
      break;
    case 'crashed':
      console.log(`Server spadl: ${event.ref.id}`, event.error);
      break;
    case 'terminated':
      console.log(`Server ukončen: ${event.ref.id}, důvod: ${event.reason}`);
      break;
  }
});

// Později: ukončení naslouchání
unsubscribe();
```

## Nejlepší praktiky

### 1. Udržujte stav immutable

Preferujte vytváření nových stavových objektů před mutací:

```typescript
// Správně
handleCast: (msg, state) => ({
  ...state,
  count: state.count + 1,
})

// Vyhněte se (mutace může způsobit jemné chyby)
handleCast: (msg, state) => {
  state.count++;
  return state;
}
```

### 2. Používejte diskriminované unie pro zprávy

```typescript
type Msg =
  | { type: 'add'; item: string }
  | { type: 'remove'; id: number }
  | { type: 'clear' };

handleCast: (msg, state) => {
  switch (msg.type) {
    case 'add': // TypeScript ví, že msg má 'item'
    case 'remove': // TypeScript ví, že msg má 'id'
    case 'clear': // TypeScript ví, že msg nemá extra pole
  }
}
```

### 3. Ošetřete všechny typy zpráv

Exhaustive checking v TypeScriptu pomáhá:

```typescript
handleCall: (msg, state) => {
  switch (msg.type) {
    case 'get':
      return [state.value, state];
    case 'set':
      return [undefined, { ...state, value: msg.value }];
    default:
      // TypeScript chyba pokud chybí case
      const _exhaustive: never = msg;
      return [undefined, state];
  }
}
```

### 4. Uvolňujte prostředky

Vždy implementujte `terminate` pokud server drží prostředky:

```typescript
terminate: async (reason, state) => {
  await state.dbConnection?.close();
  await state.fileHandle?.close();
  state.timers.forEach(clearInterval);
}
```

## Související

- [Supervisor](./supervisor.md) - Odolnost proti chybám a automatické restarty
- [Registry](./registry.md) - Pojmenované vyhledávání procesů
- [Životní cyklus](./lifecycle.md) - Detaily životního cyklu procesů
- [API Reference: GenServer](../api/genserver.md) - Kompletní dokumentace API
