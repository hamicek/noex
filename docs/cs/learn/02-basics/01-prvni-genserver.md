# První GenServer

GenServer (Generic Server) je základní stavební blok v noex. Jedná se o proces, který zapouzdřuje stav a zpracovává zprávy sekvenčně, čímž z principu eliminuje race conditions.

V této kapitole postavíte svůj první GenServer od základů a pochopíte klíčové callbacky, které jej ovládají.

## Co se naučíte

- Jak nainstalovat noex do vašeho projektu
- Vytvoření jednoduchého počítadla s GenServerem
- Pochopení callbacků `init()`, `handleCall()` a `handleCast()`
- Spuštění a interakce s GenServerem
- Type-safe zpracování zpráv s TypeScriptem

## Instalace

Nainstalujte noex přes npm:

```bash
npm install @hamicek/noex
```

**Požadavky:**
- Node.js 20.0.0 nebo vyšší
- TypeScript 5.0+ (doporučeno pro plnou type safety)

Váš `tsconfig.json` by měl obsahovat:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true
  }
}
```

## Vytvoření počítadla

Pojďme postavit klasický příklad: počítadlo, které lze inkrementovat, dekrementovat a dotazovat se na jeho hodnotu. Tento jednoduchý příklad demonstruje všechny základní koncepty GenServeru.

### Krok 1: Definujte typy

Nejprve definujte typy pro váš stav a zprávy. Zde TypeScript vynikne - získáte plnou type safety pro všechny interakce s vaším GenServerem.

```typescript
import { GenServer, type GenServerBehavior } from '@hamicek/noex';

// Vnitřní stav našeho počítadla
interface CounterState {
  count: number;
}

// Zprávy, které očekávají odpověď (synchronní)
type CounterCallMsg =
  | { type: 'get' }
  | { type: 'increment' }
  | { type: 'decrement' }
  | { type: 'add'; amount: number };

// Zprávy, které neočekávají odpověď (fire-and-forget)
type CounterCastMsg =
  | { type: 'reset' }
  | { type: 'log' };

// Typ odpovědí z call zpráv
type CounterReply = number;
```

### Krok 2: Implementujte behavior

GenServer behavior definuje, jak se váš server inicializuje a zpracovává zprávy:

```typescript
const counterBehavior: GenServerBehavior<
  CounterState,
  CounterCallMsg,
  CounterCastMsg,
  CounterReply
> = {
  // Volá se jednou při startu serveru
  init() {
    return { count: 0 };
  },

  // Zpracování synchronních zpráv (volající čeká na odpověď)
  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        // Vrátí [odpověď, novýStav]
        return [state.count, state];

      case 'increment':
        const incState = { count: state.count + 1 };
        return [incState.count, incState];

      case 'decrement':
        const decState = { count: state.count - 1 };
        return [decState.count, decState];

      case 'add':
        const addState = { count: state.count + msg.amount };
        return [addState.count, addState];
    }
  },

  // Zpracování asynchronních zpráv (fire-and-forget)
  handleCast(msg, state) {
    switch (msg.type) {
      case 'reset':
        return { count: 0 };

      case 'log':
        console.log(`Aktuální počet: ${state.count}`);
        return state; // Stav nezměněn
    }
  },
};
```

### Krok 3: Spusťte a používejte GenServer

```typescript
async function main() {
  // Spuštění GenServeru
  const counter = await GenServer.start(counterBehavior);

  // Synchronní volání - čeká na odpověď
  const initial = await GenServer.call(counter, { type: 'get' });
  console.log(`Počáteční: ${initial}`); // 0

  await GenServer.call(counter, { type: 'increment' });
  await GenServer.call(counter, { type: 'increment' });
  await GenServer.call(counter, { type: 'add', amount: 10 });

  const current = await GenServer.call(counter, { type: 'get' });
  console.log(`Po operacích: ${current}`); // 12

  // Asynchronní cast - fire and forget
  GenServer.cast(counter, { type: 'log' }); // Vypíše: Aktuální počet: 12
  GenServer.cast(counter, { type: 'reset' });

  const afterReset = await GenServer.call(counter, { type: 'get' });
  console.log(`Po resetu: ${afterReset}`); // 0

  // Čisté ukončení
  await GenServer.stop(counter);
}

main();
```

## Pochopení callbacků

### init()

Callback `init` se volá jednou při startu GenServeru. Musí vrátit počáteční stav.

```typescript
init() {
  return { count: 0 };
}
```

**Klíčové body:**
- Volá se synchronně během `GenServer.start()`
- Může být async (vrací Promise) pro asynchronní inicializaci
- Pokud `init` vyhodí chybu, GenServer se nespustí
- Má konfigurovatelný timeout (výchozí: 5 sekund)

**Příklad asynchronní inicializace:**

```typescript
async init() {
  const data = await loadFromDatabase();
  return { count: data.lastCount };
}
```

### handleCall()

Callback `handleCall` zpracovává synchronní zprávy, kde volající očekává odpověď.

```typescript
handleCall(msg, state) {
  return [reply, newState];
}
```

**Klíčové body:**
- Musí vrátit tuple: `[reply, newState]`
- `reply` se pošle zpět volajícímu
- `newState` se stane novým vnitřním stavem
- Zprávy se zpracovávají jedna po druhé (serializovaně)
- Může být async pro operace, které potřebují await

**Garance serializace je klíčová:** I když 1000 požadavků zavolá `increment` současně, budou zpracovány jeden po druhém. Žádné race conditions nejsou možné.

```typescript
// Toto je vždy bezpečné - žádné zámky nejsou potřeba!
handleCall(msg, state) {
  if (msg.type === 'increment') {
    return [state.count + 1, { count: state.count + 1 }];
  }
  // ...
}
```

### handleCast()

Callback `handleCast` zpracovává asynchronní zprávy, kde se neočekává odpověď.

```typescript
handleCast(msg, state) {
  return newState;
}
```

**Klíčové body:**
- Vrací pouze nový stav (žádná odpověď)
- Volající nečeká na zpracování
- Užitečné pro notifikace, logování nebo aktualizace, kde nepotřebujete potvrzení
- Chyby v `handleCast` jsou tiše ignorovány (není komu reportovat)

**Kdy použít cast vs call:**

| Použijte `call` když... | Použijte `cast` když... |
|-------------------------|-------------------------|
| Potřebujete výsledek | Nepotřebujete potvrzení |
| Potřebujete čekat na dokončení | Fire-and-forget je přijatelné |
| Chcete propagovat chyby | Logování, metriky, notifikace |
| Čtecí operace | Zápisové operace kde záleží na pořadí, ale ne na potvrzení |

## Kompletní příklad

Zde je kompletní, spustitelný příklad:

```typescript
// counter.ts
import { GenServer, type GenServerBehavior } from '@hamicek/noex';

interface State {
  count: number;
  history: number[];
}

type CallMsg =
  | { type: 'get' }
  | { type: 'increment' }
  | { type: 'decrement' }
  | { type: 'getHistory' };

type CastMsg =
  | { type: 'reset' };

type Reply = number | number[];

const behavior: GenServerBehavior<State, CallMsg, CastMsg, Reply> = {
  init: () => ({
    count: 0,
    history: [],
  }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.count, state];

      case 'increment': {
        const newCount = state.count + 1;
        return [newCount, {
          count: newCount,
          history: [...state.history, newCount],
        }];
      }

      case 'decrement': {
        const newCount = state.count - 1;
        return [newCount, {
          count: newCount,
          history: [...state.history, newCount],
        }];
      }

      case 'getHistory':
        return [state.history, state];
    }
  },

  handleCast(msg, state) {
    switch (msg.type) {
      case 'reset':
        return { count: 0, history: [] };
    }
  },
};

async function main() {
  const counter = await GenServer.start(behavior);

  // Proveďte nějaké operace
  await GenServer.call(counter, { type: 'increment' });
  await GenServer.call(counter, { type: 'increment' });
  await GenServer.call(counter, { type: 'decrement' });
  await GenServer.call(counter, { type: 'increment' });

  const count = await GenServer.call(counter, { type: 'get' });
  const history = await GenServer.call(counter, { type: 'getHistory' });

  console.log(`Počet: ${count}`);        // Počet: 2
  console.log(`Historie: ${history}`);   // Historie: 1,2,1,2

  await GenServer.stop(counter);
}

main().catch(console.error);
```

Spusťte pomocí:

```bash
npx tsx counter.ts
```

## Pojmenované servery

GenServer můžete zaregistrovat pod jménem pro snadné vyhledání:

```typescript
const counter = await GenServer.start(behavior, {
  name: 'main-counter',
});

// Později, odkudkoliv ve vašem kódu:
import { Registry } from '@hamicek/noex';

const ref = Registry.lookup('main-counter');
if (ref) {
  const count = await GenServer.call(ref, { type: 'get' });
}
```

## Zpracování chyb

Pokud `handleCall` vyhodí chybu, propaguje se volajícímu:

```typescript
handleCall(msg, state) {
  if (msg.type === 'divide') {
    if (msg.by === 0) {
      throw new Error('Dělení nulou');
    }
    // ...
  }
}

// Volající obdrží chybu
try {
  await GenServer.call(counter, { type: 'divide', by: 0 });
} catch (error) {
  console.error('Operace selhala:', error.message);
}
```

GenServer pokračuje v běhu po chybě v `handleCall`. Chyba se pošle pouze konkrétnímu volajícímu a ostatní zprávy se zpracovávají normálně.

## Cvičení

Vytvořte **Stack GenServer**, který podporuje:

1. `push(item)` - přidá položku na vrchol (použijte cast)
2. `pop()` - odebere a vrátí vrchní položku (použijte call)
3. `peek()` - vrátí vrchní položku bez odebrání (použijte call)
4. `size()` - vrátí počet položek (použijte call)
5. `clear()` - odebere všechny položky (použijte cast)

**Nápovědy:**
- Stav by měl být `{ items: T[] }`
- `pop()` na prázdném zásobníku by měl vrátit `null`
- Přemýšlejte, které operace potřebují odpověď (call) vs které ne (cast)

<details>
<summary>Řešení</summary>

```typescript
import { GenServer, type GenServerBehavior } from '@hamicek/noex';

interface StackState<T> {
  items: T[];
}

type StackCallMsg<T> =
  | { type: 'pop' }
  | { type: 'peek' }
  | { type: 'size' };

type StackCastMsg<T> =
  | { type: 'push'; item: T }
  | { type: 'clear' };

type StackReply<T> = T | null | number;

function createStackBehavior<T>(): GenServerBehavior<
  StackState<T>,
  StackCallMsg<T>,
  StackCastMsg<T>,
  StackReply<T>
> {
  return {
    init: () => ({ items: [] }),

    handleCall(msg, state) {
      switch (msg.type) {
        case 'pop': {
          if (state.items.length === 0) {
            return [null, state];
          }
          const [top, ...rest] = state.items;
          return [top, { items: rest }];
        }

        case 'peek':
          return [state.items[0] ?? null, state];

        case 'size':
          return [state.items.length, state];
      }
    },

    handleCast(msg, state) {
      switch (msg.type) {
        case 'push':
          return { items: [msg.item, ...state.items] };

        case 'clear':
          return { items: [] };
      }
    },
  };
}

// Použití
async function main() {
  const stack = await GenServer.start(createStackBehavior<string>());

  GenServer.cast(stack, { type: 'push', item: 'první' });
  GenServer.cast(stack, { type: 'push', item: 'druhý' });
  GenServer.cast(stack, { type: 'push', item: 'třetí' });

  console.log(await GenServer.call(stack, { type: 'size' }));  // 3
  console.log(await GenServer.call(stack, { type: 'peek' }));  // 'třetí'
  console.log(await GenServer.call(stack, { type: 'pop' }));   // 'třetí'
  console.log(await GenServer.call(stack, { type: 'pop' }));   // 'druhý'
  console.log(await GenServer.call(stack, { type: 'size' }));  // 1

  await GenServer.stop(stack);
}

main();
```

</details>

## Shrnutí

- **GenServer** zapouzdřuje stav a zpracovává zprávy sekvenčně
- **`init()`** inicializuje stav při startu serveru
- **`handleCall()`** zpracovává synchronní zprávy, které očekávají odpověď
- **`handleCast()`** zpracovává asynchronní fire-and-forget zprávy
- Zprávy se zpracovávají jedna po druhé, což eliminuje race conditions
- Použijte **call** když potřebujete odpověď, **cast** když ne
- GenServery mohou být **pojmenovány** pro snadné vyhledání přes Registry

Sekvenční zpracování zpráv je klíčový vhled: tím, že všechny změny stavu procházejí jedinou frontou, GenServer činí souběžné programování bezpečným a předvídatelným.

---

Další: [Životní cyklus procesu](./02-zivotni-cyklus.md)
