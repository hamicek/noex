# První Supervisor

Teď, když chápete, proč jsou supervisoři nezbytní, pojďme vytvořit váš první. Supervisor je proces, který monitoruje ostatní procesy (své děti) a restartuje je, když selžou.

## Co se naučíte

- Vytváření supervisoru se specifikacemi dětí
- Konfigurace chování restartu dětí
- Sledování, co se děje, když děti spadnou
- Dynamická správa dětí

## Vytvoření Supervisoru

Nejjednodušší supervisor sleduje jediné dítě:

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from '@hamicek/noex';

// Jednoduchý counter GenServer
interface CounterState {
  count: number;
}

type CounterCall = { type: 'get' } | { type: 'increment' };
type CounterCast = never;
type CounterReply = number;

const counterBehavior: GenServerBehavior<CounterState, CounterCall, CounterCast, CounterReply> = {
  init() {
    console.log('Counter se spouští...');
    return { count: 0 };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.count, state];
      case 'increment':
        const newState = { count: state.count + 1 };
        return [newState.count, newState];
    }
  },

  handleCast(_msg, state) {
    return state;
  },

  terminate(reason, state) {
    console.log(`Counter se ukončuje (${typeof reason === 'string' ? reason : 'chyba'}), finální count: ${state.count}`);
  },
};

async function main() {
  // Vytvoření supervisoru s jedním dítětem
  const supervisor = await Supervisor.start({
    children: [
      {
        id: 'counter',
        start: () => GenServer.start(counterBehavior),
      },
    ],
  });

  console.log('Supervisor spuštěn');

  // Získání reference na dítě
  const children = Supervisor.getChildren(supervisor);
  const counterRef = children[0]?.ref;

  if (counterRef) {
    // Použití counteru normálně
    await GenServer.call(counterRef, { type: 'increment' });
    await GenServer.call(counterRef, { type: 'increment' });
    const count = await GenServer.call(counterRef, { type: 'get' });
    console.log(`Count: ${count}`); // 2
  }

  // Čisté ukončení
  await Supervisor.stop(supervisor);
}

main();
```

**Výstup:**
```
Counter se spouští...
Supervisor spuštěn
Count: 2
Counter se ukončuje (shutdown), finální count: 2
```

## Specifikace dětí

Každé dítě je definováno objektem **ChildSpec** s těmito vlastnostmi:

```typescript
interface ChildSpec {
  // Povinné: unikátní identifikátor pro toto dítě
  id: string;

  // Povinné: factory funkce pro spuštění dítěte
  start: () => Promise<GenServerRef>;

  // Volitelné: kdy restartovat (výchozí: 'permanent')
  restart?: 'permanent' | 'transient' | 'temporary';

  // Volitelné: čas čekání na graceful shutdown (výchozí: 5000ms)
  shutdownTimeout?: number;

  // Volitelné: označuje dítě jako významné pro auto_shutdown
  significant?: boolean;
}
```

### Pole `id`

Každé dítě potřebuje unikátní identifikátor v rámci svého supervisoru. Toto ID se používá pro:
- Vyhledávání dětí: `Supervisor.getChild(supervisor, 'counter')`
- Ukončování specifických dětí: `Supervisor.terminateChild(supervisor, 'counter')`
- Logování a debugging

```typescript
const supervisor = await Supervisor.start({
  children: [
    { id: 'users', start: () => GenServer.start(userBehavior) },
    { id: 'orders', start: () => GenServer.start(orderBehavior) },
    { id: 'payments', start: () => GenServer.start(paymentBehavior) },
  ],
});

// Vyhledání specifického dítěte
const ordersInfo = Supervisor.getChild(supervisor, 'orders');
if (ordersInfo) {
  console.log(`Počet restartů orders služby: ${ordersInfo.restartCount}`);
}
```

### Funkce `start`

Funkce `start` je factory, která vytváří child proces. Je volána:
- Jednou během počátečního startu supervisoru
- Pokaždé, když dítě potřebuje být restartováno

Protože je to factory, každé volání vytvoří čerstvou instanci s čistým stavem:

```typescript
{
  id: 'cache',
  start: async () => {
    // Toto běží při každém (re)startu
    console.log('Spouštění cache služby...');
    return GenServer.start(cacheBehavior);
  },
}
```

Můžete předat options do `GenServer.start()`:

```typescript
{
  id: 'named-service',
  start: () => GenServer.start(serviceBehavior, {
    name: 'my-service',  // Registrace v globálním registry
  }),
}
```

### Pole `restart`

Pole `restart` určuje, kdy má být dítě restartováno po ukončení:

| Strategie | Restart při pádu? | Restart při normálním ukončení? | Použití |
|-----------|------------------|--------------------------------|---------|
| `'permanent'` | Ano | Ano | Základní služby, které musí vždy běžet |
| `'transient'` | Ano | Ne | Služby, které se mají restartovat pouze při selhání |
| `'temporary'` | Ne | Ne | Jednorázové úlohy |

**Příklady:**

```typescript
const supervisor = await Supervisor.start({
  children: [
    // Vždy běží - restart bez ohledu na cokoliv
    {
      id: 'api-server',
      start: () => GenServer.start(apiBehavior),
      restart: 'permanent', // výchozí
    },

    // Restart pouze při pádech, ne při normálním ukončení
    {
      id: 'background-job',
      start: () => GenServer.start(jobBehavior),
      restart: 'transient',
    },

    // Nikdy nerestartovat - spustit jednou a hotovo
    {
      id: 'migration',
      start: () => GenServer.start(migrationBehavior),
      restart: 'temporary',
    },
  ],
});
```

### Pole `shutdownTimeout`

Při zastavování dítěte supervisor nejprve požádá o graceful shutdown (volání `terminate()`). `shutdownTimeout` specifikuje, jak dlouho čekat před nuceným ukončením:

```typescript
{
  id: 'database-connection',
  start: () => GenServer.start(dbBehavior),
  shutdownTimeout: 10000, // Dát 10 sekund na uzavření připojení
}
```

## Sledování restartů

Když dítě skončí (spadne), supervisor ho automaticky restartuje. Podívejme se na to v akci.

**Důležité:** V noex, když `handleCall` vyhodí výjimku, chyba je propagována zpět volajícímu, ale GenServer pokračuje v běhu. To je užitečné pro error handling. Aby proces skutečně "spadl" a spustil restart supervisoru, musí být ukončen - buď přes nenapravitelnou chybu nebo explicitní stop.

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from '@hamicek/noex';

interface State {
  crashAfter: number;
  callCount: number;
  selfRef?: ReturnType<typeof GenServer.start> extends Promise<infer T> ? T : never;
}

type Call = { type: 'doWork' } | { type: 'setRef'; ref: State['selfRef'] };
type Cast = { type: 'scheduleCrash' };
type Reply = string | void;

// GenServer, který spadne po určitém počtu volání
const unstableBehavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init() {
    console.log('[Worker] Čerstvý start');
    return { crashAfter: 3, callCount: 0 };
  },

  handleCall(msg, state) {
    if (msg.type === 'setRef') {
      return [undefined, { ...state, selfRef: msg.ref }];
    }

    const newCount = state.callCount + 1;
    console.log(`[Worker] Zpracování požadavku #${newCount}`);

    if (newCount >= state.crashAfter) {
      console.log('[Worker] Kritické selhání - iniciuji pád!');
      // Naplánovat pád přes cast, aby proběhl po návratu
      if (state.selfRef) {
        GenServer.cast(state.selfRef, { type: 'scheduleCrash' });
      }
      return ['crashing', { ...state, callCount: newCount }];
    }

    return ['ok', { ...state, callCount: newCount }];
  },

  handleCast(msg, state) {
    if (msg.type === 'scheduleCrash' && state.selfRef) {
      // Zastavit s error reason pro simulaci pádu
      GenServer.stop(state.selfRef, { error: new Error('Simulované selhání') });
    }
    return state;
  },

  terminate(reason) {
    const reasonStr = typeof reason === 'string' ? reason : 'chyba';
    console.log(`[Worker] Ukončen: ${reasonStr}`);
  },
};

async function main() {
  // Naslouchání lifecycle eventům
  const unsubscribe = Supervisor.onLifecycleEvent((event) => {
    if (event.type === 'restarted') {
      console.log(`[Supervisor] Dítě restartováno (pokus #${event.attempt})`);
    }
  });

  const supervisor = await Supervisor.start({
    children: [
      {
        id: 'worker',
        start: async () => {
          const ref = await GenServer.start(unstableBehavior);
          // Dát workerovi referenci na sebe, aby se mohl ukončit
          await GenServer.call(ref, { type: 'setRef', ref });
          return ref;
        },
      },
    ],
  });

  // Volání, která nakonec způsobí pád
  for (let i = 0; i < 6; i++) {
    const children = Supervisor.getChildren(supervisor);
    const worker = children[0]?.ref;

    if (worker && GenServer.isRunning(worker)) {
      try {
        const result = await GenServer.call(worker, { type: 'doWork' });
        console.log(`[Main] Výsledek: ${result}`);
      } catch (error) {
        console.log(`[Main] Volání selhalo: ${(error as Error).message}`);
      }
    }

    // Malé zpoždění pro dokončení restartu
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Kontrola počtu restartů
  const childInfo = Supervisor.getChild(supervisor, 'worker');
  console.log(`\n[Main] Worker byl restartován ${childInfo?.restartCount}x`);

  unsubscribe();
  await Supervisor.stop(supervisor);
}

main();
```

**Výstup:**
```
[Worker] Čerstvý start
[Worker] Zpracování požadavku #1
[Main] Výsledek: ok
[Worker] Zpracování požadavku #2
[Main] Výsledek: ok
[Worker] Zpracování požadavku #3
[Worker] Kritické selhání - iniciuji pád!
[Main] Výsledek: crashing
[Worker] Ukončen: chyba
[Supervisor] Dítě restartováno (pokus #1)
[Worker] Čerstvý start
[Worker] Zpracování požadavku #1
[Main] Výsledek: ok
[Worker] Zpracování požadavku #2
[Main] Výsledek: ok
[Worker] Zpracování požadavku #3
[Worker] Kritické selhání - iniciuji pád!
[Main] Výsledek: crashing

[Main] Worker byl restartován 1x
```

Všimněte si:
1. Worker detekoval kritický stav při 3. volání
2. Inicioval vlastní ukončení s error reason
3. Supervisor detekoval ukončení a automaticky ho restartoval
4. Nová instance workeru začala s čerstvým stavem (`callCount: 0`)
5. Následná volání uspěla na nové instanci

## Dynamická správa dětí

Můžete přidávat a odebírat děti po startu supervisoru:

```typescript
const supervisor = await Supervisor.start({
  children: [
    { id: 'base-service', start: () => GenServer.start(baseBehavior) },
  ],
});

// Dynamické přidání nového dítěte
const newChildRef = await Supervisor.startChild(supervisor, {
  id: 'dynamic-worker',
  start: () => GenServer.start(workerBehavior),
});

console.log(`Spuštěno nové dítě: ${newChildRef.id}`);

// Seznam všech dětí
const children = Supervisor.getChildren(supervisor);
console.log(`Celkem dětí: ${children.length}`);

// Ukončení specifického dítěte (nebude restartováno)
await Supervisor.terminateChild(supervisor, 'dynamic-worker');

// Manuální restart dítěte
const restartedRef = await Supervisor.restartChild(supervisor, 'base-service');
```

## Pořadí startu a shutdownu

Děti jsou spouštěny **v pořadí** (první až poslední) a zastavovány **v opačném pořadí** (poslední až první). To je důležité, když děti mají závislosti:

```typescript
const supervisor = await Supervisor.start({
  children: [
    // Spuštěno první, zastaveno poslední
    { id: 'database', start: () => GenServer.start(dbBehavior) },

    // Spuštěno druhé, zastaveno druhé
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },

    // Spuštěno třetí, zastaveno první
    { id: 'api', start: () => GenServer.start(apiBehavior) },
  ],
});

// Pořadí shutdownu: api → cache → database
await Supervisor.stop(supervisor);
```

To zajišťuje, že API přestane přijímat požadavky před ukončením cache a databáze.

## Kompletní příklad: Trio služeb

Zde je praktický příklad se třemi spolupracujícími službami:

```typescript
import { Supervisor, GenServer, Registry, type GenServerBehavior } from '@hamicek/noex';

// Logger služba
interface LoggerState {
  logs: string[];
}
type LoggerCall = { type: 'getLogs' };
type LoggerCast = { type: 'log'; message: string };

const loggerBehavior: GenServerBehavior<LoggerState, LoggerCall, LoggerCast, string[]> = {
  init: () => ({ logs: [] }),
  handleCall(msg, state) {
    if (msg.type === 'getLogs') {
      return [state.logs, state];
    }
    return [[], state];
  },
  handleCast(msg, state) {
    if (msg.type === 'log') {
      return { logs: [...state.logs, `[${new Date().toISOString()}] ${msg.message}`] };
    }
    return state;
  },
};

// Counter služba, která používá logger
interface CounterState {
  count: number;
}
type CounterCall = { type: 'increment' } | { type: 'get' };

const counterBehavior: GenServerBehavior<CounterState, CounterCall, never, number> = {
  init: () => ({ count: 0 }),
  handleCall(msg, state) {
    if (msg.type === 'get') {
      return [state.count, state];
    }
    if (msg.type === 'increment') {
      const newCount = state.count + 1;

      // Logování do logger služby
      const logger = Registry.lookup('logger');
      if (logger) {
        GenServer.cast(logger, { type: 'log', message: `Counter inkrementován na ${newCount}` });
      }

      return [newCount, { count: newCount }];
    }
    return [state.count, state];
  },
  handleCast: (_msg, state) => state,
};

// Stats služba
interface StatsState {
  totalOperations: number;
}
type StatsCall = { type: 'getStats' };
type StatsCast = { type: 'recordOperation' };

const statsBehavior: GenServerBehavior<StatsState, StatsCall, StatsCast, number> = {
  init: () => ({ totalOperations: 0 }),
  handleCall(msg, state) {
    if (msg.type === 'getStats') {
      return [state.totalOperations, state];
    }
    return [0, state];
  },
  handleCast(msg, state) {
    if (msg.type === 'recordOperation') {
      return { totalOperations: state.totalOperations + 1 };
    }
    return state;
  },
};

async function main() {
  const supervisor = await Supervisor.start({
    children: [
      {
        id: 'logger',
        start: () => GenServer.start(loggerBehavior, { name: 'logger' }),
      },
      {
        id: 'stats',
        start: () => GenServer.start(statsBehavior, { name: 'stats' }),
      },
      {
        id: 'counter',
        start: () => GenServer.start(counterBehavior, { name: 'counter' }),
      },
    ],
  });

  console.log('Všechny služby spuštěny');

  // Použití služeb
  const counter = Registry.lookup('counter');
  const stats = Registry.lookup('stats');
  const logger = Registry.lookup('logger');

  if (counter && stats && logger) {
    for (let i = 0; i < 3; i++) {
      await GenServer.call(counter, { type: 'increment' });
      GenServer.cast(stats, { type: 'recordOperation' });
    }

    const count = await GenServer.call(counter, { type: 'get' });
    const ops = await GenServer.call(stats, { type: 'getStats' });
    const logs = await GenServer.call(logger, { type: 'getLogs' });

    console.log(`\nFinální count: ${count}`);
    console.log(`Celkem operací: ${ops}`);
    console.log('Logy:');
    logs.forEach((log) => console.log(`  ${log}`));
  }

  await Supervisor.stop(supervisor);
}

main();
```

## Cvičení

Vytvořte supervisor, který spravuje dva workery:

1. **PingWorker** - odpovídá na `{ type: 'ping' }` s `'pong'`
2. **EchoWorker** - odpovídá na `{ type: 'echo', message: string }` stejnou zprávou

Požadavky:
- PingWorker by měl být `permanent` (vždy restartovat)
- EchoWorker by měl být `transient` (restartovat pouze při pádu)
- Přidejte logování lifecycle eventů pro sledování restartů
- Nechte EchoWorker ukončit s chybou, když je zpráva `'crash'`
- Otestujte, že supervisor restartuje spadlý worker

<details>
<summary>Řešení</summary>

```typescript
import { Supervisor, GenServer, type GenServerBehavior, type GenServerRef } from '@hamicek/noex';

// PingWorker
type PingCall = { type: 'ping' };
const pingBehavior: GenServerBehavior<null, PingCall, never, string> = {
  init: () => null,
  handleCall(msg, _state) {
    if (msg.type === 'ping') {
      return ['pong', null];
    }
    return ['unknown', null];
  },
  handleCast: (_msg, state) => state,
};

// EchoWorker - potřebuje uložit vlastní ref, aby se mohl ukončit
interface EchoState {
  selfRef?: GenServerRef;
}
type EchoCall = { type: 'echo'; message: string } | { type: 'setRef'; ref: GenServerRef };
type EchoCast = { type: 'crash' };

const echoBehavior: GenServerBehavior<EchoState, EchoCall, EchoCast, string | void> = {
  init: () => {
    console.log('[Echo] Startuji');
    return {};
  },
  handleCall(msg, state) {
    if (msg.type === 'setRef') {
      return [undefined, { selfRef: msg.ref }];
    }
    if (msg.type === 'echo') {
      if (msg.message === 'crash' && state.selfRef) {
        // Naplánovat pád a ihned vrátit
        GenServer.cast(state.selfRef, { type: 'crash' });
        return ['padám...', state];
      }
      return [msg.message, state];
    }
    return ['', state];
  },
  handleCast(msg, state) {
    if (msg.type === 'crash' && state.selfRef) {
      // Ukončit s chybou pro spuštění restartu supervisorem
      GenServer.stop(state.selfRef, { error: new Error('Záměrný pád') });
    }
    return state;
  },
  terminate(reason) {
    console.log(`[Echo] Ukončen: ${typeof reason === 'string' ? reason : 'chyba'}`);
  },
};

async function main() {
  // Nastavení monitorování lifecycle
  const unsubscribe = Supervisor.onLifecycleEvent((event) => {
    if (event.type === 'restarted') {
      console.log(`[Monitor] Proces restartován, pokus #${event.attempt}`);
    }
  });

  const supervisor = await Supervisor.start({
    children: [
      {
        id: 'ping',
        start: () => GenServer.start(pingBehavior),
        restart: 'permanent',
      },
      {
        id: 'echo',
        start: async () => {
          const ref = await GenServer.start(echoBehavior);
          await GenServer.call(ref, { type: 'setRef', ref });
          return ref;
        },
        restart: 'transient',
      },
    ],
  });

  // Test ping
  const pingRef = Supervisor.getChild(supervisor, 'ping')?.ref;
  if (pingRef) {
    const pong = await GenServer.call(pingRef, { type: 'ping' });
    console.log(`Ping odpověď: ${pong}`);
  }

  // Test echo
  let echoRef = Supervisor.getChild(supervisor, 'echo')?.ref;
  if (echoRef) {
    const msg = await GenServer.call(echoRef, { type: 'echo', message: 'Ahoj!' });
    console.log(`Echo odpověď: ${msg}`);
  }

  // Způsobení pádu
  console.log('\nSpouštím pád...');
  echoRef = Supervisor.getChild(supervisor, 'echo')?.ref;
  if (echoRef) {
    const result = await GenServer.call(echoRef, { type: 'echo', message: 'crash' });
    console.log(`Odpověď před pádem: ${result}`);
  }

  // Čekání na restart
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Ověření, že echo opět funguje
  echoRef = Supervisor.getChild(supervisor, 'echo')?.ref;
  if (echoRef) {
    const recovered = await GenServer.call(echoRef, { type: 'echo', message: 'Zpět online!' });
    console.log(`Po zotavení: ${recovered}`);
  }

  // Kontrola počtu restartů
  const echoInfo = Supervisor.getChild(supervisor, 'echo');
  console.log(`Počet restartů Echo: ${echoInfo?.restartCount}`);

  unsubscribe();
  await Supervisor.stop(supervisor);
}

main();
```

**Očekávaný výstup:**
```
[Echo] Startuji
Ping odpověď: pong
Echo odpověď: Ahoj!

Spouštím pád...
Odpověď před pádem: padám...
[Echo] Ukončen: chyba
[Monitor] Proces restartován, pokus #1
[Echo] Startuji
Po zotavení: Zpět online!
Počet restartů Echo: 1
[Echo] Ukončen: shutdown
```

</details>

## Shrnutí

- **Supervisor.start()** vytváří supervisor se specifikacemi dětí
- **ChildSpec** definuje, jak spustit a restartovat každé dítě:
  - `id`: unikátní identifikátor
  - `start`: factory funkce, která vytváří dítě
  - `restart`: `'permanent'` (výchozí), `'transient'`, nebo `'temporary'`
  - `shutdownTimeout`: čas čekání na graceful shutdown
- Děti se spouští **v pořadí** a zastavují **v opačném pořadí**
- Použijte **Supervisor.getChildren()** pro seznam všech spravovaných dětí
- Použijte **Supervisor.startChild()** a **Supervisor.terminateChild()** pro dynamickou správu
- Použijte **Supervisor.onLifecycleEvent()** pro monitorování restartů

Supervisor vám dává automatické zotavení ze selhání bez psaní logiky pro opakování. V další kapitole se naučíte, jak různé restart strategie ovlivňují, která děti se restartují, když jedno selže.

---

Další: [Restart strategie](./03-restart-strategie.md)
