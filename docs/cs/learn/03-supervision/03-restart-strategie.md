# Restart strategie

Když child proces selže, supervisor musí rozhodnout, **které procesy restartovat**. Toto rozhodnutí je řízeno **restart strategií** supervisoru. Volba správné strategie závisí na tom, jak vaše procesy na sobě závisí.

## Co se naučíte

- Tři restart strategie: `one_for_one`, `one_for_all`, `rest_for_one`
- Kdy použít kterou strategii
- Jak funguje pořadí shutdownu a startu během restartů
- Praktické příklady každé strategie

## Tři strategie na první pohled

```
┌────────────────────────────────────────────────────────────────────────────┐
│                      RESTART STRATEGIE SUPERVISORU                          │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  one_for_one              one_for_all              rest_for_one            │
│  ─────────────            ─────────────            ─────────────           │
│                                                                            │
│  Před pádem:              Před pádem:              Před pádem:             │
│  ┌───┐ ┌───┐ ┌───┐        ┌───┐ ┌───┐ ┌───┐        ┌───┐ ┌───┐ ┌───┐      │
│  │ A │ │ B │ │ C │        │ A │ │ B │ │ C │        │ A │ │ B │ │ C │      │
│  └───┘ └───┘ └───┘        └───┘ └───┘ └───┘        └───┘ └───┘ └───┘      │
│         ↓ pád                   ↓ pád                    ↓ pád            │
│        ┌───┐                    ┌───┐                    ┌───┐            │
│        │ B │                    │ B │                    │ B │            │
│        └───┘                    └───┘                    └───┘            │
│                                                                            │
│  Po restartu:             Po restartu:             Po restartu:           │
│  ┌───┐ ┌───┐ ┌───┐        ┌───┐ ┌───┐ ┌───┐        ┌───┐ ┌───┐ ┌───┐      │
│  │ A │ │ B'│ │ C │        │ A'│ │ B'│ │ C'│        │ A │ │ B'│ │ C'│      │
│  └───┘ └───┘ └───┘        └───┘ └───┘ └───┘        └───┘ └───┘ └───┘      │
│    ↑     ↑     ↑            ↑     ↑     ↑            ↑     ↑     ↑        │
│  stejný nový  stejný      vše   nový   vše         stejný nový  nový      │
│                                                           (a po B)        │
│                                                                            │
│  Použití:                 Použití:                 Použití:               │
│  Děti jsou                Děti sdílejí             Děti mají              │
│  nezávislé                stav nebo musí           sekvenční              │
│                           být synchronní           závislosti             │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

## one_for_one (Výchozí)

Nejjednodušší a nejběžnější strategie. Když dítě spadne, **pouze toto dítě je restartováno**. Ostatní děti pokračují bez přerušení.

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one', // Toto je výchozí
  children: [
    { id: 'users', start: () => GenServer.start(usersBehavior) },
    { id: 'orders', start: () => GenServer.start(ordersBehavior) },
    { id: 'notifications', start: () => GenServer.start(notificationsBehavior) },
  ],
});
```

### Kdy použít one_for_one

Použijte tuto strategii, když jsou děti **nezávislé** na sobě:

- **Microservices pattern**: Každá služba řeší jiné záležitosti (uživatelé, objednávky, platby)
- **Worker pools**: Každý worker zpracovává úlohy nezávisle
- **Bezstavové služby**: Služby, které nesdílejí stav se sourozenci

### Příklad: Nezávislé API handlery

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from '@hamicek/noex';

// Každý handler je nezávislý - nesdílejí stav
interface HandlerState {
  requestCount: number;
}

type HandlerCall = { type: 'handle'; path: string };
type HandlerCast = never;

const createHandler = (name: string): GenServerBehavior<HandlerState, HandlerCall, HandlerCast, string> => ({
  init() {
    console.log(`[${name}] Spuštěn`);
    return { requestCount: 0 };
  },
  handleCall(msg, state) {
    const newState = { requestCount: state.requestCount + 1 };
    console.log(`[${name}] Zpracování ${msg.path} (požadavek #${newState.requestCount})`);
    return [`${name} zpracoval ${msg.path}`, newState];
  },
  handleCast: (_, state) => state,
  terminate(reason) {
    console.log(`[${name}] Ukončen: ${typeof reason === 'string' ? reason : 'chyba'}`);
  },
});

async function main() {
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'users-handler', start: () => GenServer.start(createHandler('Users')) },
      { id: 'orders-handler', start: () => GenServer.start(createHandler('Orders')) },
      { id: 'payments-handler', start: () => GenServer.start(createHandler('Payments')) },
    ],
  });

  // Pokud orders-handler spadne, pouze on se restartuje
  // users-handler a payments-handler pokračují se svým stavem

  await Supervisor.stop(supervisor);
}

main();
```

## one_for_all

Když jakékoli dítě spadne, **všechny děti jsou restartovány**. Supervisor nejprve zastaví všechny ostatní děti (v opačném pořadí startu), pak restartuje všechny (v původním pořadí).

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_all',
  children: [
    { id: 'database', start: () => GenServer.start(dbBehavior) },
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },
    { id: 'api', start: () => GenServer.start(apiBehavior) },
  ],
});
```

### Sekvence restartu pro one_for_all

Když `cache` spadne:
1. **Zastavit** `api` (spuštěno poslední, zastaveno první)
2. **Zastavit** `database` (přeskočit `cache` - už je mrtvá)
3. **Spustit** `database` (první v pořadí)
4. **Spustit** `cache` (druhá v pořadí)
5. **Spustit** `api` (třetí v pořadí)

### Kdy použít one_for_all

Použijte tuto strategii, když děti **sdílejí stav** nebo **musí být synchronizované**:

- **Distribuovaný konsenzus**: Všechny uzly musí souhlasit na stavu
- **Sdílená invalidace cache**: Cache a služby musí být v synchronizaci
- **Těsně svázané komponenty**: Když jedna selže, stav ostatních se stane neplatným

### Příklad: Synchronizovaný cluster counterů

```typescript
import { Supervisor, GenServer, Registry, type GenServerBehavior } from '@hamicek/noex';

// Koordinátor, který udržuje "pravý" count
interface CoordinatorState {
  count: number;
}

type CoordinatorCall = { type: 'get' } | { type: 'set'; value: number };
type CoordinatorCast = never;

const coordinatorBehavior: GenServerBehavior<CoordinatorState, CoordinatorCall, CoordinatorCast, number> = {
  init() {
    console.log('[Koordinátor] Startuji s count = 0');
    return { count: 0 };
  },
  handleCall(msg, state) {
    if (msg.type === 'get') {
      return [state.count, state];
    }
    if (msg.type === 'set') {
      return [msg.value, { count: msg.value }];
    }
    return [state.count, state];
  },
  handleCast: (_, state) => state,
  terminate() {
    console.log('[Koordinátor] Ukončen');
  },
};

// Replika, která cachuje hodnotu koordinátora
interface ReplicaState {
  name: string;
  cachedCount: number;
}

type ReplicaCall = { type: 'read' };
type ReplicaCast = { type: 'sync' };

const createReplicaBehavior = (name: string): GenServerBehavior<ReplicaState, ReplicaCall, ReplicaCast, number> => ({
  init() {
    // Při startu synchronizace s koordinátorem
    const coordinator = Registry.lookup('coordinator');
    let initialCount = 0;
    if (coordinator) {
      console.log(`[${name}] Startuji, synchronizuji s koordinátorem...`);
    }
    return { name, cachedCount: initialCount };
  },
  handleCall(msg, state) {
    if (msg.type === 'read') {
      return [state.cachedCount, state];
    }
    return [state.cachedCount, state];
  },
  handleCast(msg, state) {
    if (msg.type === 'sync') {
      const coordinator = Registry.lookup('coordinator');
      if (coordinator) {
        console.log(`[${state.name}] Synchronizuji s koordinátorem`);
      }
    }
    return state;
  },
  terminate() {
    console.log(`[${name}] Ukončen`);
  },
});

async function main() {
  // Všechny repliky závisí na stavu koordinátora
  // Pokud koordinátor spadne, repliky mají zastaralá data - restartovat vše
  const supervisor = await Supervisor.start({
    strategy: 'one_for_all',
    children: [
      {
        id: 'coordinator',
        start: () => GenServer.start(coordinatorBehavior, { name: 'coordinator' }),
      },
      {
        id: 'replica-1',
        start: () => GenServer.start(createReplicaBehavior('Replika-1')),
      },
      {
        id: 'replica-2',
        start: () => GenServer.start(createReplicaBehavior('Replika-2')),
      },
    ],
  });

  console.log('\nVšechny komponenty spuštěny a synchronizovány');

  // Pokud jakákoli komponenta selže, všechny se restartují pro zajištění konzistence
  // To garantuje, že repliky mají vždy čerstvá data z koordinátora

  await Supervisor.stop(supervisor);
}

main();
```

**Výstup:**
```
[Koordinátor] Startuji s count = 0
[Replika-1] Startuji, synchronizuji s koordinátorem...
[Replika-2] Startuji, synchronizuji s koordinátorem...

Všechny komponenty spuštěny a synchronizovány
[Replika-2] Ukončen
[Replika-1] Ukončen
[Koordinátor] Ukončen
```

## rest_for_one

Kompromis mezi oběma předchozími. Když dítě spadne, **spadlé dítě a všechny děti spuštěné po něm jsou restartovány**. Děti spuštěné před spadlým pokračují v běhu.

```typescript
const supervisor = await Supervisor.start({
  strategy: 'rest_for_one',
  children: [
    { id: 'database', start: () => GenServer.start(dbBehavior) },
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },    // závisí na database
    { id: 'api', start: () => GenServer.start(apiBehavior) },        // závisí na cache
  ],
});
```

### Sekvence restartu pro rest_for_one

Když `cache` spadne:
1. **Zastavit** `api` (spuštěno po cache)
2. *(cache je již mrtvá)*
3. **Spustit** `cache`
4. **Spustit** `api`

`database` pokračuje v běhu bez přerušení.

### Kdy použít rest_for_one

Použijte tuto strategii, když děti mají **sekvenční závislosti**:

- **Pipeline zpracování**: Stage 2 závisí na Stage 1, Stage 3 závisí na Stage 2
- **Vrstvená architektura**: Vyšší vrstvy závisí na nižších
- **Inicializační řetězce**: Pozdější služby potřebují, aby dřívější byly připraveny

### Příklad: Data processing pipeline

```typescript
import { Supervisor, GenServer, Registry, type GenServerBehavior } from '@hamicek/noex';

// Stage 1: Data Fetcher (žádné závislosti)
interface FetcherState {
  fetchCount: number;
}

type FetcherCall = { type: 'fetch' };

const fetcherBehavior: GenServerBehavior<FetcherState, FetcherCall, never, string> = {
  init() {
    console.log('[Fetcher] Spuštěn');
    return { fetchCount: 0 };
  },
  handleCall(msg, state) {
    if (msg.type === 'fetch') {
      const newCount = state.fetchCount + 1;
      console.log(`[Fetcher] Stahování dat (požadavek #${newCount})`);
      return [`raw_data_${newCount}`, { fetchCount: newCount }];
    }
    return ['', state];
  },
  handleCast: (_, state) => state,
  terminate() {
    console.log('[Fetcher] Ukončen');
  },
};

// Stage 2: Transformer (závisí na Fetcher)
interface TransformerState {
  transformCount: number;
}

type TransformerCall = { type: 'transform'; data: string };

const transformerBehavior: GenServerBehavior<TransformerState, TransformerCall, never, string> = {
  init() {
    console.log('[Transformer] Spuštěn');
    return { transformCount: 0 };
  },
  handleCall(msg, state) {
    if (msg.type === 'transform') {
      const newCount = state.transformCount + 1;
      console.log(`[Transformer] Transformuji: ${msg.data}`);
      return [`transformed_${msg.data}`, { transformCount: newCount }];
    }
    return ['', state];
  },
  handleCast: (_, state) => state,
  terminate() {
    console.log('[Transformer] Ukončen');
  },
};

// Stage 3: Loader (závisí na Transformer)
interface LoaderState {
  loadCount: number;
}

type LoaderCall = { type: 'load'; data: string };

const loaderBehavior: GenServerBehavior<LoaderState, LoaderCall, never, boolean> = {
  init() {
    console.log('[Loader] Spuštěn');
    return { loadCount: 0 };
  },
  handleCall(msg, state) {
    if (msg.type === 'load') {
      const newCount = state.loadCount + 1;
      console.log(`[Loader] Nahrávám: ${msg.data}`);
      return [true, { loadCount: newCount }];
    }
    return [false, state];
  },
  handleCast: (_, state) => state,
  terminate() {
    console.log('[Loader] Ukončen');
  },
};

async function main() {
  // ETL pipeline: Fetcher → Transformer → Loader
  // Pokud Transformer spadne:
  //   - Fetcher pokračuje (stále platný, žádný downstream stav)
  //   - Transformer se restartuje
  //   - Loader se restartuje (měl stav odvozený z Transformeru)
  const supervisor = await Supervisor.start({
    strategy: 'rest_for_one',
    children: [
      {
        id: 'fetcher',
        start: () => GenServer.start(fetcherBehavior, { name: 'fetcher' }),
      },
      {
        id: 'transformer',
        start: () => GenServer.start(transformerBehavior, { name: 'transformer' }),
      },
      {
        id: 'loader',
        start: () => GenServer.start(loaderBehavior, { name: 'loader' }),
      },
    ],
  });

  // Spuštění pipeline
  const fetcher = Registry.lookup('fetcher');
  const transformer = Registry.lookup('transformer');
  const loader = Registry.lookup('loader');

  if (fetcher && transformer && loader) {
    const raw = await GenServer.call(fetcher, { type: 'fetch' });
    const transformed = await GenServer.call(transformer, { type: 'transform', data: raw });
    await GenServer.call(loader, { type: 'load', data: transformed });
  }

  console.log('\nPipeline úspěšně dokončena');

  await Supervisor.stop(supervisor);
}

main();
```

**Výstup:**
```
[Fetcher] Spuštěn
[Transformer] Spuštěn
[Loader] Spuštěn
[Fetcher] Stahování dat (požadavek #1)
[Transformer] Transformuji: raw_data_1
[Loader] Nahrávám: transformed_raw_data_1

Pipeline úspěšně dokončena
[Loader] Ukončen
[Transformer] Ukončen
[Fetcher] Ukončen
```

## Porovnání strategií

| Aspekt | one_for_one | one_for_all | rest_for_one |
|--------|-------------|-------------|--------------|
| **Restartuje** | Pouze spadlé dítě | Všechny děti | Spadlé + pozdější děti |
| **Izolace** | Maximální | Minimální | Částečná |
| **Výkon** | Nejlepší (minimální restart) | Nejhorší (plný restart) | Střední |
| **Použití** | Nezávislé služby | Sdílený stav | Sekvenční závislosti |
| **Složitost** | Nejjednodušší | Jednoduchá | Vyžaduje pečlivé řazení |

## Praktický rozhodovací strom

```
Zneplatňuje pád dítěte A stav dítěte B?
│
├─ Ne pro VŠECHNY děti → one_for_one
│
├─ Ano pro VŠECHNY děti → one_for_all
│
└─ Ano pouze pro děti spuštěné PO A → rest_for_one
```

## Příklady architektur z reálného světa

### E-commerce systém (one_for_one)

```typescript
// Každá doména je nezávislá
await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'users', start: () => GenServer.start(usersBehavior) },
    { id: 'products', start: () => GenServer.start(productsBehavior) },
    { id: 'orders', start: () => GenServer.start(ordersBehavior) },
    { id: 'payments', start: () => GenServer.start(paymentsBehavior) },
  ],
});
```

### Distribuovaný cache cluster (one_for_all)

```typescript
// Všechny uzly musí být v synchronizaci
await Supervisor.start({
  strategy: 'one_for_all',
  children: [
    { id: 'cache-primary', start: () => GenServer.start(cacheBehavior) },
    { id: 'cache-replica-1', start: () => GenServer.start(replicaBehavior) },
    { id: 'cache-replica-2', start: () => GenServer.start(replicaBehavior) },
  ],
});
```

### Webový aplikační stack (rest_for_one)

```typescript
// Každá vrstva závisí na předchozích
await Supervisor.start({
  strategy: 'rest_for_one',
  children: [
    { id: 'database', start: () => GenServer.start(dbBehavior) },      // Základ
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },      // Potřebuje DB
    { id: 'session', start: () => GenServer.start(sessionBehavior) },  // Potřebuje cache
    { id: 'api', start: () => GenServer.start(apiBehavior) },          // Potřebuje vše výše
  ],
});
```

## Cvičení

Vytvořte supervisor pro logovací systém se třemi komponentami:

1. **LogWriter** - Zapisuje logy na disk (nezávislý, žádné závislosti)
2. **LogAggregator** - Agreguje logy z více zdrojů (závisí na LogWriter)
3. **AlertManager** - Monitoruje agregované logy pro chyby (závisí na LogAggregator)

Požadavky:
- Zvolte vhodnou restart strategii
- Pokud LogAggregator spadne, AlertManager by se měl také restartovat (má zastaralý agregační stav)
- Pokud LogWriter spadne, pouze LogWriter by se měl restartovat (ostatní komponenty mohou dočasně bufferovat)

**Nápověda:** Zamyslete se, která strategie správně řeší tuto částečnou závislost.

<details>
<summary>Řešení</summary>

Trik je v tom, že máme **dva různé vzory závislostí**:
- LogWriter je nezávislý
- LogAggregator → AlertManager mají sekvenční závislost

Řešením je použít **vnořené supervisory** s různými strategiemi:

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from '@hamicek/noex';

// LogWriter - nezávislý, zapisuje na disk
const logWriterBehavior: GenServerBehavior<null, { type: 'write'; msg: string }, never, boolean> = {
  init() {
    console.log('[LogWriter] Spuštěn');
    return null;
  },
  handleCall(msg, state) {
    console.log(`[LogWriter] Zapisuji: ${msg.msg}`);
    return [true, state];
  },
  handleCast: (_, state) => state,
  terminate() {
    console.log('[LogWriter] Ukončen');
  },
};

// LogAggregator - sbírá a agreguje logy
interface AggregatorState {
  buffer: string[];
}

const logAggregatorBehavior: GenServerBehavior<AggregatorState, { type: 'getStats' }, { type: 'log'; msg: string }, number> = {
  init() {
    console.log('[LogAggregator] Spuštěn');
    return { buffer: [] };
  },
  handleCall(msg, state) {
    if (msg.type === 'getStats') {
      return [state.buffer.length, state];
    }
    return [0, state];
  },
  handleCast(msg, state) {
    if (msg.type === 'log') {
      return { buffer: [...state.buffer, msg.msg] };
    }
    return state;
  },
  terminate() {
    console.log('[LogAggregator] Ukončen');
  },
};

// AlertManager - monitoruje chyby
interface AlertState {
  alertCount: number;
}

const alertManagerBehavior: GenServerBehavior<AlertState, { type: 'getAlertCount' }, { type: 'check' }, number> = {
  init() {
    console.log('[AlertManager] Spuštěn');
    return { alertCount: 0 };
  },
  handleCall(msg, state) {
    if (msg.type === 'getAlertCount') {
      return [state.alertCount, state];
    }
    return [0, state];
  },
  handleCast(msg, state) {
    if (msg.type === 'check') {
      // Kontrola agregátoru na chyby...
      return state;
    }
    return state;
  },
  terminate() {
    console.log('[AlertManager] Ukončen');
  },
};

async function main() {
  // Hlavní supervisor s one_for_one
  // - LogWriter je nezávislý
  // - Agregační subsystém je jedno dítě (další supervisor)
  const mainSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      {
        id: 'log-writer',
        start: () => GenServer.start(logWriterBehavior),
      },
      {
        // Agregační subsystém jako vnořený supervisor s rest_for_one
        id: 'aggregation-subsystem',
        start: async () => {
          const sub = await Supervisor.start({
            strategy: 'rest_for_one',
            children: [
              {
                id: 'log-aggregator',
                start: () => GenServer.start(logAggregatorBehavior),
              },
              {
                id: 'alert-manager',
                start: () => GenServer.start(alertManagerBehavior),
              },
            ],
          });
          // Vrátit GenServer ref, který obaluje supervisor
          return GenServer.start({
            init: () => sub,
            handleCall: (_, state) => [state, state],
            handleCast: (_, state) => state,
          });
        },
      },
    ],
  });

  console.log('\nLogovací systém spuštěn');
  console.log('- Pokud LogWriter spadne: pouze LogWriter se restartuje');
  console.log('- Pokud LogAggregator spadne: LogAggregator + AlertManager se restartují');
  console.log('- Pokud AlertManager spadne: pouze AlertManager se restartuje');

  await Supervisor.stop(mainSupervisor);
}

main();
```

**Alternativní jednodušší řešení** - pokud můžete akceptovat, že pád LogWriter restartuje i závislé služby:

```typescript
// Jednoduché řešení pomocí rest_for_one
// Kompromis: Pád LogWriter restartuje vše za ním
const supervisor = await Supervisor.start({
  strategy: 'rest_for_one',
  children: [
    { id: 'log-writer', start: () => GenServer.start(logWriterBehavior) },
    { id: 'log-aggregator', start: () => GenServer.start(logAggregatorBehavior) },
    { id: 'alert-manager', start: () => GenServer.start(alertManagerBehavior) },
  ],
});
```

Přístup s vnořeným supervisorem vám dává jemnozrnnou kontrolu nad chováním restartů. Toto je běžný pattern v produkčních systémech.

</details>

## Shrnutí

- **one_for_one** (výchozí): Restartuje pouze spadlé dítě
  - Použijte pro nezávislé služby
  - Nejlepší výkon, maximální izolace

- **one_for_all**: Restartuje všechny děti, když jedno spadne
  - Použijte, když děti sdílejí stav
  - Zastavení v opačném pořadí, start v původním pořadí

- **rest_for_one**: Restartuje spadlé dítě + všechny děti spuštěné po něm
  - Použijte pro sekvenční závislosti
  - Dřívější děti pokračují v běhu

- **Pořadí dětí záleží** pro `rest_for_one` - seřaďte děti od nejméně závislých po nejvíce závislé
- **Vnořené supervisory** vám umožňují kombinovat strategie pro komplexní vzory závislostí

V další kapitole se naučíte, jak předcházet nekonečným restart smyčkám pomocí limitů **restart intenzity**.

---

Další: [Restart intenzita](./04-restart-intenzita.md)
