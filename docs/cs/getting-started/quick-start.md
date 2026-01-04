# Rychlý start

V tomto 5minutovém průvodci vytvoříte svůj první GenServer a naučíte se základy noex.

## Co je GenServer?

GenServer (Generic Server) je stavový proces, který:

- Udržuje interní stav
- Zpracovává zprávy jednu po druhé (žádné race conditions)
- Podporuje synchronní volání (request/response) a asynchronní casty (fire-and-forget)
- Má lifecycle hooky pro inicializaci a úklid

## Krok 1: Vytvoření jednoduchého counteru

Vytvořme counter službu, která umí inkrementovat, dekrementovat a vrátit svou hodnotu:

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

// Definice typu stavu
type CounterState = number;

// Definice typů zpráv
type CallMsg = 'get';                    // Synchronní: vrací aktuální hodnotu
type CastMsg = 'inc' | 'dec' | 'reset';  // Asynchronní: fire-and-forget
type CallReply = number;                 // Co vrací 'get'

// Definice chování
const counterBehavior: GenServerBehavior<CounterState, CallMsg, CastMsg, CallReply> = {
  // Inicializace stavu na 0
  init: () => 0,

  // Zpracování synchronních volání
  handleCall: (msg, state) => {
    // 'get' vrací aktuální stav
    return [state, state];  // [odpověď, novýStav]
  },

  // Zpracování asynchronních castů
  handleCast: (msg, state) => {
    switch (msg) {
      case 'inc':   return state + 1;
      case 'dec':   return state - 1;
      case 'reset': return 0;
    }
  },
};
```

## Krok 2: Spuštění a použití GenServeru

```typescript
// Spuštění GenServeru
const counter = await GenServer.start(counterBehavior);

// Odeslání asynchronních zpráv (casty)
GenServer.cast(counter, 'inc');  // stav: 1
GenServer.cast(counter, 'inc');  // stav: 2
GenServer.cast(counter, 'inc');  // stav: 3
GenServer.cast(counter, 'dec');  // stav: 2

// Odeslání synchronní zprávy (call) a čekání na odpověď
const value = await GenServer.call(counter, 'get');
console.log('Aktuální hodnota:', value);  // Aktuální hodnota: 2

// Reset counteru
GenServer.cast(counter, 'reset');
const newValue = await GenServer.call(counter, 'get');
console.log('Po resetu:', newValue);  // Po resetu: 0
```

## Krok 3: Čisté ukončení

Vždy ukončete své GenServery, když jsou hotové:

```typescript
await GenServer.stop(counter);
```

Můžete také uvést důvod:

```typescript
await GenServer.stop(counter, 'shutdown');
```

## Krok 4: Přidání lifecycle hooků

GenServery podporují `terminate` callback pro úklid:

```typescript
const counterWithCleanup: GenServerBehavior<CounterState, CallMsg, CastMsg, CallReply> = {
  init: () => {
    console.log('Counter se spouští...');
    return 0;
  },

  handleCall: (msg, state) => [state, state],

  handleCast: (msg, state) => {
    switch (msg) {
      case 'inc':   return state + 1;
      case 'dec':   return state - 1;
      case 'reset': return 0;
    }
  },

  terminate: (reason, state) => {
    console.log(`Counter se vypíná. Důvod: ${reason}, Konečná hodnota: ${state}`);
  },
};
```

## Kompletní příklad

Zde je celý kód:

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

type CounterState = number;
type CallMsg = 'get';
type CastMsg = 'inc' | 'dec' | 'reset';
type CallReply = number;

const counterBehavior: GenServerBehavior<CounterState, CallMsg, CastMsg, CallReply> = {
  init: () => {
    console.log('Counter inicializován');
    return 0;
  },

  handleCall: (msg, state) => [state, state],

  handleCast: (msg, state) => {
    switch (msg) {
      case 'inc':   return state + 1;
      case 'dec':   return state - 1;
      case 'reset': return 0;
    }
  },

  terminate: (reason, state) => {
    console.log(`Counter ukončen: ${reason}, konečná hodnota: ${state}`);
  },
};

// Main
const counter = await GenServer.start(counterBehavior);

GenServer.cast(counter, 'inc');
GenServer.cast(counter, 'inc');
GenServer.cast(counter, 'inc');

const value = await GenServer.call(counter, 'get');
console.log('Hodnota:', value);  // Hodnota: 3

await GenServer.stop(counter);
```

Výstup:
```
Counter inicializován
Hodnota: 3
Counter ukončen: normal, konečná hodnota: 3
```

## Souhrn klíčových konceptů

| Koncept | Popis |
|---------|-------|
| **State** | Interní data udržovaná GenServerem |
| **init()** | Volá se jednou při startu serveru, vrací počáteční stav |
| **handleCall()** | Zpracovává synchronní zprávy, vrací `[odpověď, novýStav]` |
| **handleCast()** | Zpracovává async zprávy, vrací nový stav |
| **terminate()** | Volitelný úklid při ukončení serveru |
| **call()** | Odešle zprávu a čeká na odpověď |
| **cast()** | Odešle zprávu bez čekání (fire-and-forget) |

## Co dál?

Nyní, když rozumíte základům, pojďme vytvořit kompletnější aplikaci se supervizí v [První aplikace](./first-application.md).

---

Další: [První aplikace](./first-application.md)
