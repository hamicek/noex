# Základní počítadlo

Minimální příklad GenServeru demonstrující základní koncepty.

## Přehled

Tento příklad ukazuje:
- Definování stavu a typů zpráv
- Implementaci GenServerBehavior
- Synchronní volání vs asynchronní casty
- Správu životního cyklu

## Kompletní kód

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

// Stav je jednoduše číslo
type CounterState = number;

// Synchronní zprávy (call) - očekávají odpověď
type CallMsg = 'get';

// Asynchronní zprávy (cast) - fire-and-forget
type CastMsg = 'inc' | 'dec' | 'reset' | { type: 'add'; amount: number };

// Typ odpovědi pro call
type CallReply = number;

// Definice chování GenServeru
const counterBehavior: GenServerBehavior<CounterState, CallMsg, CastMsg, CallReply> = {
  // Inicializace stavu
  init: () => {
    console.log('Počítadlo inicializováno');
    return 0;
  },

  // Zpracování synchronních volání - vrací [odpověď, novýStav]
  handleCall: (msg, state) => {
    switch (msg) {
      case 'get':
        return [state, state];
    }
  },

  // Zpracování asynchronních castů - vrací novýStav
  handleCast: (msg, state) => {
    if (typeof msg === 'string') {
      switch (msg) {
        case 'inc':   return state + 1;
        case 'dec':   return state - 1;
        case 'reset': return 0;
      }
    } else {
      // Zpracování objektové zprávy
      return state + msg.amount;
    }
  },

  // Úklid při ukončení
  terminate: (reason, state) => {
    console.log(`Počítadlo ukončeno: ${reason}, finální hodnota: ${state}`);
  },
};

// Main
async function main() {
  // Spuštění GenServeru
  const counter = await GenServer.start(counterBehavior);

  // Cast zprávy (async, bez odpovědi)
  GenServer.cast(counter, 'inc');
  GenServer.cast(counter, 'inc');
  GenServer.cast(counter, { type: 'add', amount: 5 });

  // Call zpráva (sync, čeká na odpověď)
  const value = await GenServer.call(counter, 'get');
  console.log('Aktuální hodnota:', value); // 7

  // Reset a ověření
  GenServer.cast(counter, 'reset');
  const newValue = await GenServer.call(counter, 'get');
  console.log('Po resetu:', newValue); // 0

  // Čisté ukončení
  await GenServer.stop(counter);
}

main().catch(console.error);
```

## Výstup

```
Počítadlo inicializováno
Aktuální hodnota: 7
Po resetu: 0
Počítadlo ukončeno: normal, finální hodnota: 0
```

## Klíčové body

### Typ stavu
Stav může být jakýkoli typ - primitivy, objekty nebo komplexní datové struktury:
```typescript
type CounterState = number;
// nebo
type CounterState = { value: number; history: number[] };
```

### Typy zpráv
Oddělené typy pro call (sync) a cast (async) poskytují typovou bezpečnost:
```typescript
type CallMsg = 'get';                    // Očekává odpověď
type CastMsg = 'inc' | { type: 'add'; amount: number };  // Fire-and-forget
```

### Návratová hodnota handleCall
Vrací tuple `[odpověď, novýStav]`:
```typescript
handleCall: (msg, state) => [state, state]  // [odpověď, nezměněný stav]
```

### Návratová hodnota handleCast
Vrací pouze nový stav:
```typescript
handleCast: (msg, state) => state + 1  // Nový stav
```

## Variace

### S asynchronní inicializací

```typescript
init: async () => {
  const savedValue = await loadFromDatabase();
  return savedValue ?? 0;
},
```

### S asynchronními handlery

```typescript
handleCast: async (msg, state) => {
  await saveToDatabase(state + 1);
  return state + 1;
},
```

## Související

- [Rychlý start](../getting-started/quick-start.md) - Základní koncepty
- [Koncept GenServer](../concepts/genserver.md) - Detailní vysvětlení
- [GenServer API](../api/genserver.md) - Kompletní API reference
