# Call vs Cast

GenServer poskytuje dva způsoby posílání zpráv: **call** pro synchronní request/reply a **cast** pro asynchronní fire-and-forget. Výběr správného způsobu je klíčový pro budování responzivních, spolehlivých aplikací.

V této kapitole se naučíte kdy použít který, jak zpracovávat timeouty a chyby a běžné vzory pro jejich efektivní kombinování.

## Co se naučíte

- Rozdíl mezi `call()` a `cast()`
- Kdy použít synchronní vs asynchronní zasílání zpráv
- Jak konfigurovat a zpracovávat timeouty
- Vzory error handlingu pro oba typy zpráv
- Best practices pro návrh zpráv

## Call: Synchronní request/reply

`GenServer.call()` pošle zprávu a **čeká na odpověď**. Volající blokuje dokud server nezpracuje zprávu a nevrátí odpověď (nebo dokud nevyprší timeout).

```typescript
import { GenServer, type GenServerBehavior } from '@hamicek/noex';

interface BankAccountState {
  balance: number;
}

type CallMsg =
  | { type: 'getBalance' }
  | { type: 'withdraw'; amount: number };

type CastMsg = { type: 'deposit'; amount: number };

type Reply = number | { success: boolean; newBalance: number };

const bankAccountBehavior: GenServerBehavior<BankAccountState, CallMsg, CastMsg, Reply> = {
  init() {
    return { balance: 1000 };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'getBalance':
        // Vrátí aktuální zůstatek
        return [state.balance, state];

      case 'withdraw': {
        if (state.balance < msg.amount) {
          // Nedostatečné prostředky - vrátí neúspěch
          return [{ success: false, newBalance: state.balance }, state];
        }
        const newBalance = state.balance - msg.amount;
        return [
          { success: true, newBalance },
          { balance: newBalance },
        ];
      }
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'deposit') {
      return { balance: state.balance + msg.amount };
    }
    return state;
  },
};

async function main() {
  const account = await GenServer.start(bankAccountBehavior);

  // call() čeká na odpověď
  const balance = await GenServer.call(account, { type: 'getBalance' });
  console.log('Aktuální zůstatek:', balance); // 1000

  const result = await GenServer.call(account, { type: 'withdraw', amount: 500 });
  console.log('Výsledek výběru:', result); // { success: true, newBalance: 500 }

  await GenServer.stop(account);
}
```

### Klíčové charakteristiky Call

1. **Synchronní sémantika**: Volající čeká na odpověď
2. **Garantované pořadí**: Zprávy se zpracovávají v pořadí příchodu
3. **Vyžadována odpověď**: `handleCall` musí vrátit `[reply, newState]`
4. **Vědomí timeoutu**: Volání mohou vypršet pokud server neodpoví

### Kdy použít Call

Použijte `call()` když potřebujete:

- **Odpověď**: Získání dat, potvrzení úspěchu operace
- **Garance pořadí**: Zajištění dokončení jedné operace před začátkem další
- **Zpětnou vazbu o chybách**: Vědět jestli operace selhala a proč
- **Backpressure**: Přirozeně zpomalovat volající tím, že je necháte čekat

```typescript
// Dobré případy použití pro call()
const user = await GenServer.call(userService, { type: 'getUser', id: 123 });
const result = await GenServer.call(paymentService, { type: 'charge', amount: 99.99 });
const isValid = await GenServer.call(authService, { type: 'validateToken', token: 'xyz' });
```

## Cast: Asynchronní fire-and-forget

`GenServer.cast()` pošle zprávu a **vrátí se okamžitě**. Volající nečeká na zpracování zprávy serverem ani nedostane žádné potvrzení.

```typescript
async function main() {
  const account = await GenServer.start(bankAccountBehavior);

  // cast() se vrátí okamžitě - bez čekání
  GenServer.cast(account, { type: 'deposit', amount: 100 });
  GenServer.cast(account, { type: 'deposit', amount: 200 });
  GenServer.cast(account, { type: 'deposit', amount: 300 });

  // Casty jsou zařazeny ve frontě ale nemusí být ještě zpracovány
  // Pokud potřebujeme aktualizovaný zůstatek, musíme zavolat:
  await new Promise((r) => setTimeout(r, 10)); // Dejte čas na zpracování

  const balance = await GenServer.call(account, { type: 'getBalance' });
  console.log('Zůstatek po vkladech:', balance); // 1600

  await GenServer.stop(account);
}
```

### Klíčové charakteristiky Cast

1. **Asynchronní**: Vrátí se okamžitě, nečeká na zpracování
2. **Bez odpovědi**: `handleCast` vrací pouze nový stav, žádná odpověď odesílateli
3. **Tiché selhání**: Pokud handler vyhodí chybu, volající není informován
4. **Fire-and-forget**: Žádné potvrzení že zpráva byla zpracována

### Kdy použít Cast

Použijte `cast()` když potřebujete:

- **Rychlost**: Neblokující operace které by neměly zpomalovat volajícího
- **Broadcasting**: Posílání notifikací více procesům
- **Eventual consistency**: Aktualizace které nepotřebují okamžité potvrzení
- **Oddělení**: Když odesílateli nezáleží na výsledku

```typescript
// Dobré případy použití pro cast()
GenServer.cast(logger, { type: 'log', level: 'info', message: 'Uživatel přihlášen' });
GenServer.cast(metrics, { type: 'increment', counter: 'page_views' });
GenServer.cast(cache, { type: 'invalidate', key: 'user:123' });
GenServer.cast(notifier, { type: 'notify', userId: 456, event: 'order_shipped' });
```

## Porovnání: Call vs Cast

| Aspekt | `call()` | `cast()` |
|--------|----------|----------|
| Návratová hodnota | `Promise<Reply>` | `void` |
| Blokuje volajícího | Ano | Ne |
| Return handleru | `[reply, newState]` | `newState` |
| Propagace chyb | Chyby se vyhodí volajícímu | Chyby tiše spolknuty |
| Podpora timeoutu | Ano (konfigurovatelný) | N/A |
| Případ použití | Dotazy, mutace vyžadující potvrzení | Notifikace, fire-and-forget aktualizace |

## Timeouty

Volání mají výchozí timeout 5 sekund. Pokud server neodpoví v tomto čase, vyhodí se `CallTimeoutError`.

### Konfigurace timeoutu

```typescript
import { GenServer, CallTimeoutError } from '@hamicek/noex';

// Vlastní timeout pro volání
const result = await GenServer.call(
  server,
  { type: 'slowOperation' },
  { timeout: 30000 }, // 30 sekund
);
```

### Zpracování timeout chyb

```typescript
try {
  const result = await GenServer.call(server, { type: 'query' }, { timeout: 1000 });
  console.log('Úspěch:', result);
} catch (error) {
  if (error instanceof CallTimeoutError) {
    console.error(`Timeout po ${error.timeoutMs}ms při volání serveru ${error.serverId}`);
    // Rozhodněte: opakovat, použít cache hodnotu nebo elegantně selhat
  } else {
    throw error; // Znovu vyhodit neočekávané chyby
  }
}
```

### Proč záleží na timeoutech

Timeouty zabraňují vaší aplikaci viset nekonečně když:

- Server je přetížený a zpracovává pomalu
- Bug způsobí nekonečnou smyčku v handleru
- Server spadne během zpracování vaší zprávy
- Dojde k deadlocku mezi procesy

**Pravidlo**: Vždy nastavte vhodné timeouty pro produkční kód. Výchozích 5 sekund je často příliš dlouho pro uživatelsky orientované operace.

```typescript
// Pro uživatelsky orientované API použijte kratší timeouty
const quickResult = await GenServer.call(server, msg, { timeout: 500 });

// Pro dávkové zpracování povolte více času
const batchResult = await GenServer.call(worker, msg, { timeout: 60000 });
```

## Error handling

### Chyby v handleCall

Když `handleCall` vyhodí chybu, propaguje se volajícímu:

```typescript
const behavior: GenServerBehavior<State, CallMsg, CastMsg, Reply> = {
  // ...
  handleCall(msg, state) {
    if (msg.type === 'riskyOperation') {
      throw new Error('Něco se pokazilo');
    }
    return ['ok', state];
  },
  // ...
};

try {
  await GenServer.call(server, { type: 'riskyOperation' });
} catch (error) {
  console.error('Volání selhalo:', error.message); // "Něco se pokazilo"
}
```

**Důležité**: Server pokračuje v běhu po chybě v `handleCall`. Pouze individuální volání selže.

### Chyby v handleCast

Chyby v `handleCast` jsou tiše ignorovány - není koho informovat:

```typescript
const behavior: GenServerBehavior<State, CallMsg, CastMsg, Reply> = {
  // ...
  handleCast(msg, state) {
    if (msg.type === 'failingSilently') {
      throw new Error('Tato chyba je spolknuta');
    }
    return state;
  },
  // ...
};

// Toto nevyhodí chybu - cast se vrátí okamžitě
GenServer.cast(server, { type: 'failingSilently' });

// Server stále běží, ale chyba zůstala nepovšimnuta
```

Pro zpracování cast chyb použijte lifecycle events:

```typescript
GenServer.onLifecycleEvent((event) => {
  if (event.type === 'crashed') {
    console.error(`Server ${event.ref.id} spadl:`, event.error);
  }
});
```

### Volání neběžícího serveru

Jak `call()` tak `cast()` vyhodí `ServerNotRunningError` pokud je server zastavený:

```typescript
import { ServerNotRunningError } from '@hamicek/noex';

const server = await GenServer.start(behavior);
await GenServer.stop(server);

try {
  await GenServer.call(server, { type: 'query' });
} catch (error) {
  if (error instanceof ServerNotRunningError) {
    console.log(`Server ${error.serverId} neběží`);
  }
}
```

## Kompletní příklad

Zde je praktický příklad ukazující oba vzory ve frontě úloh:

```typescript
// task-queue.ts
import { GenServer, type GenServerBehavior, CallTimeoutError } from '@hamicek/noex';

interface Task {
  id: string;
  payload: unknown;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
}

interface TaskQueueState {
  tasks: Map<string, Task>;
  nextId: number;
}

type CallMsg =
  | { type: 'submit'; payload: unknown }
  | { type: 'getStatus'; taskId: string }
  | { type: 'getResult'; taskId: string };

type CastMsg =
  | { type: 'markComplete'; taskId: string; result: unknown }
  | { type: 'markFailed'; taskId: string; error: string };

type Reply =
  | { taskId: string }
  | { status: Task['status'] }
  | { result: unknown }
  | { error: string };

const taskQueueBehavior: GenServerBehavior<TaskQueueState, CallMsg, CastMsg, Reply> = {
  init() {
    return { tasks: new Map(), nextId: 1 };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'submit': {
        const taskId = `task_${state.nextId}`;
        const task: Task = {
          id: taskId,
          payload: msg.payload,
          status: 'pending',
        };

        const newTasks = new Map(state.tasks);
        newTasks.set(taskId, task);

        console.log(`[Queue] Úloha ${taskId} odeslána`);

        return [
          { taskId },
          { tasks: newTasks, nextId: state.nextId + 1 },
        ];
      }

      case 'getStatus': {
        const task = state.tasks.get(msg.taskId);
        if (!task) {
          return [{ error: 'Úloha nenalezena' }, state];
        }
        return [{ status: task.status }, state];
      }

      case 'getResult': {
        const task = state.tasks.get(msg.taskId);
        if (!task) {
          return [{ error: 'Úloha nenalezena' }, state];
        }
        if (task.status !== 'completed') {
          return [{ error: `Úloha je ${task.status}, ne completed` }, state];
        }
        return [{ result: task.result }, state];
      }
    }
  },

  handleCast(msg, state) {
    const task = state.tasks.get(msg.taskId);
    if (!task) {
      return state; // Tiše ignorovat neznámé úlohy
    }

    const newTasks = new Map(state.tasks);

    switch (msg.type) {
      case 'markComplete':
        newTasks.set(msg.taskId, {
          ...task,
          status: 'completed',
          result: msg.result,
        });
        console.log(`[Queue] Úloha ${msg.taskId} dokončena`);
        break;

      case 'markFailed':
        newTasks.set(msg.taskId, {
          ...task,
          status: 'failed',
          error: msg.error,
        });
        console.log(`[Queue] Úloha ${msg.taskId} selhala: ${msg.error}`);
        break;
    }

    return { ...state, tasks: newTasks };
  },
};

async function main() {
  const queue = await GenServer.start(taskQueueBehavior);

  // Odeslání úlohy (call - potřebujeme taskId)
  const { taskId } = await GenServer.call(queue, {
    type: 'submit',
    payload: { action: 'process_image', url: 'https://example.com/img.png' },
  }) as { taskId: string };

  console.log(`Odeslaná úloha: ${taskId}`);

  // Kontrola stavu (call - potřebujeme odpověď)
  const statusResult = await GenServer.call(queue, { type: 'getStatus', taskId });
  console.log('Stav:', statusResult);

  // Simulace workeru dokončujícího úlohu (cast - fire-and-forget)
  GenServer.cast(queue, {
    type: 'markComplete',
    taskId,
    result: { thumbnailUrl: 'https://example.com/thumb.png' },
  });

  // Chvíli počkejte na zpracování castu
  await new Promise((r) => setTimeout(r, 10));

  // Získání výsledku (call - potřebujeme odpověď)
  const result = await GenServer.call(queue, { type: 'getResult', taskId });
  console.log('Výsledek:', result);

  await GenServer.stop(queue);
}

main();
```

Spusťte pomocí:

```bash
npx tsx task-queue.ts
```

Očekávaný výstup:

```
[Queue] Úloha task_1 odeslána
Odeslaná úloha: task_1
Stav: { status: 'pending' }
[Queue] Úloha task_1 dokončena
Výsledek: { result: { thumbnailUrl: 'https://example.com/thumb.png' } }
```

## Best practices

### 1. Používejte Call pro dotazy a kritické mutace

```typescript
// ✅ Dobře: Potřebujeme znát zůstatek
const balance = await GenServer.call(account, { type: 'getBalance' });

// ✅ Dobře: Potřebujeme potvrdit úspěch výběru
const result = await GenServer.call(account, { type: 'withdraw', amount: 100 });
if (!result.success) {
  // Zpracování nedostatečných prostředků
}
```

### 2. Používejte Cast pro notifikace a side effects

```typescript
// ✅ Dobře: Logování nepotřebuje potvrzení
GenServer.cast(logger, { type: 'log', message: 'Akce uživatele' });

// ✅ Dobře: Metriky nepotřebují potvrzení
GenServer.cast(metrics, { type: 'increment', counter: 'requests' });
```

### 3. Nemíchejte zájmy v jednom typu zprávy

```typescript
// ❌ Špatně: Cast kde volající očekává potvrzení
GenServer.cast(orderService, { type: 'placeOrder', items: [...] });
// Volající neví jestli byla objednávka vytvořena!

// ✅ Dobře: Použijte call pro operace vyžadující potvrzení
const order = await GenServer.call(orderService, { type: 'placeOrder', items: [...] });
// Nyní máme ID objednávky a víme že uspěla
```

### 4. Nastavte vhodné timeouty

```typescript
// ❌ Špatně: Výchozí timeout pro pomalé operace
await GenServer.call(reportService, { type: 'generateYearlyReport' });

// ✅ Dobře: Explicitní timeout pro pomalé operace
await GenServer.call(reportService, { type: 'generateYearlyReport' }, { timeout: 60000 });
```

### 5. Zpracujte chyby elegantně

```typescript
// ✅ Dobře: Komplexní error handling
try {
  const result = await GenServer.call(service, msg, { timeout: 1000 });
  return result;
} catch (error) {
  if (error instanceof CallTimeoutError) {
    return { error: 'Služba je pomalá, zkuste to znovu' };
  }
  if (error instanceof ServerNotRunningError) {
    return { error: 'Služba není dostupná' };
  }
  throw error; // Neočekávaná chyba, nechte probublat
}
```

## Cvičení

Vytvořte **CounterServer**, který podporuje:

1. `increment` a `decrement` jako casty (fire-and-forget)
2. `get` jako call (vrací aktuální hodnotu)
3. `incrementBy(n)` jako call (vrací novou hodnotu)
4. `reset` jako call (vrací hodnotu před resetem)

Otestujte všechny operace a ověřte že:
- Casty neblokují
- Cally vracejí očekávané hodnoty
- Stav počítadla je konzistentní

**Nápovědy:**
- Použijte discriminated unions pro typy zpráv
- Cast handlery vracejí pouze nový stav
- Call handlery vracejí `[reply, newState]`

<details>
<summary>Řešení</summary>

```typescript
import { GenServer, type GenServerBehavior } from '@hamicek/noex';

interface CounterState {
  value: number;
}

type CallMsg =
  | { type: 'get' }
  | { type: 'incrementBy'; n: number }
  | { type: 'reset' };

type CastMsg =
  | { type: 'increment' }
  | { type: 'decrement' };

type Reply = number;

const counterBehavior: GenServerBehavior<CounterState, CallMsg, CastMsg, Reply> = {
  init() {
    return { value: 0 };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.value, state];

      case 'incrementBy': {
        const newValue = state.value + msg.n;
        return [newValue, { value: newValue }];
      }

      case 'reset': {
        const oldValue = state.value;
        return [oldValue, { value: 0 }];
      }
    }
  },

  handleCast(msg, state) {
    switch (msg.type) {
      case 'increment':
        return { value: state.value + 1 };

      case 'decrement':
        return { value: state.value - 1 };
    }
  },
};

async function main() {
  const counter = await GenServer.start(counterBehavior);

  // Test castů (fire-and-forget)
  console.log('Posílám increment casty...');
  GenServer.cast(counter, { type: 'increment' });
  GenServer.cast(counter, { type: 'increment' });
  GenServer.cast(counter, { type: 'increment' });

  // Krátká pauza pro zpracování castů
  await new Promise((r) => setTimeout(r, 10));

  // Test get (call)
  const value1 = await GenServer.call(counter, { type: 'get' });
  console.log('Po 3 incrementech:', value1); // 3

  // Test decrement cast
  GenServer.cast(counter, { type: 'decrement' });
  await new Promise((r) => setTimeout(r, 10));

  const value2 = await GenServer.call(counter, { type: 'get' });
  console.log('Po decrementu:', value2); // 2

  // Test incrementBy (call s odpovědí)
  const newValue = await GenServer.call(counter, { type: 'incrementBy', n: 10 });
  console.log('Po incrementBy(10):', newValue); // 12

  // Test reset (call vrací starou hodnotu)
  const oldValue = await GenServer.call(counter, { type: 'reset' });
  console.log('Reset vrátil starou hodnotu:', oldValue); // 12

  const finalValue = await GenServer.call(counter, { type: 'get' });
  console.log('Po resetu:', finalValue); // 0

  await GenServer.stop(counter);
}

main();
```

Očekávaný výstup:

```
Posílám increment casty...
Po 3 incrementech: 3
Po decrementu: 2
Po incrementBy(10): 12
Reset vrátil starou hodnotu: 12
Po resetu: 0
```

</details>

## Shrnutí

- **`call()`** je synchronní: volající čeká na odpověď
  - Použijte pro dotazy a operace vyžadující potvrzení
  - Vrací `Promise<Reply>`, handler vrací `[reply, newState]`
  - Podporuje konfigurovatelné timeouty (výchozí: 5 sekund)
  - Chyby se propagují volajícímu

- **`cast()`** je asynchronní: vrátí se okamžitě
  - Použijte pro notifikace a fire-and-forget aktualizace
  - Vrací `void`, handler vrací pouze `newState`
  - Chyby jsou tiše ignorovány (použijte lifecycle events pro jejich zachycení)

- **Timeouty** zabraňují visení na pomalých nebo spadlých serverech
  - Vždy nastavte vhodné timeouty pro produkční kód
  - Zpracujte `CallTimeoutError` elegantně

- **Error handling** se liší mezi oběma způsoby
  - Call chyby dosáhnou volajícího
  - Cast chyby vyžadují lifecycle event observery

Rozlišení call/cast je fundamentální pro actor model. Pochopení kdy použít který vám pomůže budovat aplikace, které jsou responzivní i spolehlivé.

---

Další: [Registry](./04-registry.md)
