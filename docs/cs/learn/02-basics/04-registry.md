# Registry

Když spustíte GenServer, dostanete zpět referenci (ref), kterou potřebujete pro komunikaci s ním. Ale co když jiná část vaší aplikace potřebuje s tímto serverem mluvit? Předávání referencí může být únavné a vytváří těsnou vazbu.

**Registry** tento problém řeší poskytnutím vyhledávání pojmenovaných procesů. Místo předávání referencí registrujete procesy pod dobře známými jmény a vyhledáváte je když je potřebujete.

V této kapitole se naučíte proč pojmenování záleží, jak registrovat a vyhledávat procesy a kdy použít unique vs duplicate režim klíčů.

## Co se naučíte

- Proč pojmenování procesů záleží pro oddělení
- Použití `Registry.register()` a `Registry.lookup()`
- Rozdíl mezi `lookup()` a `whereis()`
- Unique vs duplicate režimy klíčů
- Automatický úklid při ukončení procesů
- Vytváření izolovaných instancí registru

## Proč pojmenovávat procesy?

Zvažte aplikaci s více službami:

```typescript
// Bez Registry - těsná vazba
async function main() {
  const logger = await GenServer.start(loggerBehavior);
  const cache = await GenServer.start(cacheBehavior);
  const userService = await GenServer.start(userServiceBehavior);

  // Každá komponenta potřebuje explicitní reference
  await processRequest(logger, cache, userService);
  await handleWebhook(logger, cache);
  await runBackgroundJob(logger, userService);
}

// Reference musí být předávány všude
async function processRequest(
  logger: GenServerRef,
  cache: GenServerRef,
  userService: GenServerRef,
) {
  // ...
}
```

Toto se stává nepohodlným jak vaše aplikace roste. Každá funkce potřebuje vědět o každé službě, kterou by mohla potřebovat.

S Registry mohou být služby vyhledány podle jména:

```typescript
// S Registry - volná vazba
async function main() {
  const logger = await GenServer.start(loggerBehavior);
  Registry.register('logger', logger);

  const cache = await GenServer.start(cacheBehavior);
  Registry.register('cache', cache);

  const userService = await GenServer.start(userServiceBehavior);
  Registry.register('users', userService);

  // Komponenty si vyhledají co potřebují
  await processRequest();
  await handleWebhook();
  await runBackgroundJob();
}

async function processRequest() {
  const logger = Registry.lookup('logger');
  const cache = Registry.lookup('cache');
  const users = Registry.lookup('users');
  // ...
}
```

### Výhody pojmenovaných procesů

1. **Oddělení**: Komponenty nepotřebují vědět jak jsou služby vytvořeny nebo odkud pocházejí
2. **Testovatelnost**: Snadná záměna implementací registrací mocků pod stejným jménem
3. **Objevitelnost**: Dobře známá jména dokumentují architekturu vašich služeb
4. **Hot swapping**: Nahraďte službu odregistrováním staré a registrací nové

## Registrace procesů

Použijte `Registry.register()` pro přiřazení jména k referenci procesu:

```typescript
import { GenServer, Registry, type GenServerBehavior } from '@hamicek/noex';

interface CounterState {
  value: number;
}

type CallMsg = { type: 'get' } | { type: 'increment' };
type CastMsg = never;
type Reply = number;

const counterBehavior: GenServerBehavior<CounterState, CallMsg, CastMsg, Reply> = {
  init() {
    return { value: 0 };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.value, state];
      case 'increment':
        const newValue = state.value + 1;
        return [newValue, { value: newValue }];
    }
  },

  handleCast(_msg, state) {
    return state;
  },
};

async function main() {
  // Spuštění serveru
  const ref = await GenServer.start(counterBehavior);

  // Registrace pod jménem
  Registry.register('counter', ref);

  console.log('Počítadlo zaregistrováno');

  // ... použití jinde
}
```

### Pravidla registrace

1. **Jména musí být unikátní**: Registrace jména které je již obsazené vyhodí `AlreadyRegisteredError`
2. **Jedna registrace na proces**: Proces může být registrován pouze pod jedním jménem ve výchozím registru
3. **Automatický úklid**: Když proces skončí, jeho registrace je automaticky odebrána

```typescript
import { AlreadyRegisteredError } from '@hamicek/noex';

const server1 = await GenServer.start(behavior);
Registry.register('myService', server1);

const server2 = await GenServer.start(behavior);

try {
  Registry.register('myService', server2); // Vyhodí chybu!
} catch (error) {
  if (error instanceof AlreadyRegisteredError) {
    console.log(`Jméno '${error.name}' je již obsazené`);
  }
}
```

## Vyhledávání procesů

### lookup() - Vyhodí při absenci

`Registry.lookup()` vrátí registrovanou referenci nebo vyhodí chybu pokud není nalezena:

```typescript
import { Registry, GenServer, NotRegisteredError } from '@hamicek/noex';

try {
  const counter = Registry.lookup('counter');
  const value = await GenServer.call(counter, { type: 'get' });
  console.log('Hodnota počítadla:', value);
} catch (error) {
  if (error instanceof NotRegisteredError) {
    console.log(`Služba '${error.processName}' není dostupná`);
  }
}
```

Použijte `lookup()` když služba **musí existovat** - pokud chybí, je to bug který by měl selhat hlasitě.

### whereis() - Vrátí undefined

`Registry.whereis()` vrátí referenci nebo `undefined` pokud není nalezena:

```typescript
const counter = Registry.whereis('counter');

if (counter) {
  const value = await GenServer.call(counter, { type: 'get' });
  console.log('Hodnota počítadla:', value);
} else {
  console.log('Počítadlo není dostupné, používám fallback');
  // Elegantní zpracování
}
```

Použijte `whereis()` když je služba **volitelná** - váš kód zvládne její absenci.

### Typové parametry

Obě metody přijímají typové parametry pro správné typování:

```typescript
// Plně typované vyhledání
const counter = Registry.lookup<CounterState, CallMsg, CastMsg, Reply>('counter');

// Nyní TypeScript zná typy
const value = await GenServer.call(counter, { type: 'get' }); // Typ Reply
```

## Kontrola a výpis registrací

```typescript
// Kontrola jestli je jméno registrované
if (Registry.isRegistered('counter')) {
  console.log('Počítadlo je dostupné');
}

// Získání všech registrovaných jmen
const names = Registry.getNames();
console.log('Registrované služby:', names);
// ['counter', 'logger', 'cache']

// Získání počtu registrací
console.log(`${Registry.count()} služeb registrováno`);
```

## Odregistrace procesů

Proces můžete manuálně odregistrovat:

```typescript
// Odebrání registrace (proces dál běží)
Registry.unregister('counter');

// Nyní je jméno dostupné pro novou registraci
const newCounter = await GenServer.start(counterBehavior);
Registry.register('counter', newCounter);
```

### Automatický úklid

Když proces skončí, jeho registrace je automaticky odebrána:

```typescript
const server = await GenServer.start(behavior);
Registry.register('myService', server);

console.log(Registry.isRegistered('myService')); // true

await GenServer.stop(server);

console.log(Registry.isRegistered('myService')); // false (automaticky uklizeno)
```

Toto zabraňuje hromadění zastaralých referencí a zajišťuje že vyhledání nikdy nevrátí mrtvé procesy.

## Unique vs Duplicate klíče

Výchozí globální Registry používá režim **unique** klíčů - každé jméno mapuje na přesně jeden proces. Ale když vytváříte vlastní instance registru, můžete zvolit režim **duplicate** klíčů pro pub/sub vzory.

### Režim Unique (výchozí)

Jeden záznam na klíč. Registrace selže pokud je klíč již obsazený.

```typescript
const services = Registry.create<{ version: string }>({
  name: 'services',
  keys: 'unique', // výchozí
});
await services.start();

services.register('auth', authRef, { version: '2.0' });
services.register('auth', anotherRef); // Vyhodí AlreadyRegisteredKeyError!

const entry = services.lookup('auth');
console.log(entry.ref, entry.metadata.version);
```

### Režim Duplicate (Pub/Sub)

Více záznamů na klíč. Užitečné pro event subscriptions:

```typescript
const topics = Registry.create({
  name: 'topics',
  keys: 'duplicate',
});
await topics.start();

// Více handlerů pro stejný event
topics.register('user:created', emailHandler);
topics.register('user:created', analyticsHandler);
topics.register('user:created', welcomeHandler);

// Dispatch všem handlerům
topics.dispatch('user:created', { userId: 123, email: 'user@example.com' });
```

### dispatch() - Broadcasting zpráv

V režimu duplicate, `dispatch()` pošle zprávu všem záznamům pod klíčem:

```typescript
// Výchozí chování: GenServer.cast každému záznamu
topics.dispatch('order:placed', orderData);

// Vlastní dispatch funkce pro větší kontrolu
topics.dispatch('order:placed', orderData, (entries, message) => {
  // Round-robin, weighted routing, atd.
  const selected = entries[Math.floor(Math.random() * entries.length)];
  GenServer.cast(selected.ref, message);
});
```

### lookupAll() - Získání všech záznamů

V režimu duplicate, použijte `lookupAll()` místo `lookup()`:

```typescript
const handlers = topics.lookupAll('user:created');
console.log(`${handlers.length} handlerů registrováno pro user:created`);

for (const entry of handlers) {
  console.log(`Handler: ${entry.ref.id}`);
}
```

## Pattern matching

Vlastní instance registru podporují glob-style pattern matching:

```typescript
const registry = Registry.create<{ role: string }>({
  name: 'workers',
  keys: 'unique',
});
await registry.start();

registry.register('worker:us-east:1', workerA, { role: 'processor' });
registry.register('worker:us-east:2', workerB, { role: 'processor' });
registry.register('worker:eu-west:1', workerC, { role: 'processor' });
registry.register('manager:us-east', managerA, { role: 'coordinator' });

// Vyhledání všech US East workerů
const usEastWorkers = registry.match('worker:us-east:*');
console.log(`Nalezeno ${usEastWorkers.length} US East workerů`);

// Vyhledání všech workerů globálně
const allWorkers = registry.match('worker:**');

// Vyhledání s predikátem hodnoty
const processors = registry.match('*', (entry) => entry.metadata.role === 'processor');
```

Syntaxe vzorů:
- `*` matchuje jakékoliv znaky kromě `:`
- `**` matchuje jakékoliv znaky včetně `:`
- `?` matchuje jeden znak

## Kompletní příklad

Zde je praktický příklad ukazující Registry použitou ve víceslužbové aplikaci:

```typescript
// services.ts
import { GenServer, Registry, type GenServerBehavior } from '@hamicek/noex';

// Logger Service
interface LoggerState {
  logs: string[];
}

type LoggerCall = { type: 'getLogs' };
type LoggerCast = { type: 'log'; level: string; message: string };
type LoggerReply = string[];

const loggerBehavior: GenServerBehavior<LoggerState, LoggerCall, LoggerCast, LoggerReply> = {
  init() {
    return { logs: [] };
  },

  handleCall(msg, state) {
    if (msg.type === 'getLogs') {
      return [state.logs, state];
    }
    return [[], state];
  },

  handleCast(msg, state) {
    if (msg.type === 'log') {
      const entry = `[${msg.level.toUpperCase()}] ${new Date().toISOString()}: ${msg.message}`;
      console.log(entry);
      return { logs: [...state.logs, entry] };
    }
    return state;
  },
};

// Counter Service
interface CounterState {
  value: number;
}

type CounterCall = { type: 'get' } | { type: 'incrementBy'; n: number };
type CounterCast = { type: 'increment' } | { type: 'decrement' };
type CounterReply = number;

const counterBehavior: GenServerBehavior<CounterState, CounterCall, CounterCast, CounterReply> = {
  init() {
    // Log inicializace přes Registry lookup
    const logger = Registry.whereis('logger');
    if (logger) {
      GenServer.cast(logger, { type: 'log', level: 'info', message: 'Počítadlo inicializováno' });
    }
    return { value: 0 };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.value, state];
      case 'incrementBy':
        const newValue = state.value + msg.n;
        return [newValue, { value: newValue }];
    }
  },

  handleCast(msg, state) {
    const logger = Registry.whereis('logger');

    switch (msg.type) {
      case 'increment': {
        const newValue = state.value + 1;
        if (logger) {
          GenServer.cast(logger, {
            type: 'log',
            level: 'debug',
            message: `Počítadlo inkrementováno na ${newValue}`,
          });
        }
        return { value: newValue };
      }
      case 'decrement': {
        const newValue = state.value - 1;
        if (logger) {
          GenServer.cast(logger, {
            type: 'log',
            level: 'debug',
            message: `Počítadlo dekrementováno na ${newValue}`,
          });
        }
        return { value: newValue };
      }
    }
  },
};

async function main() {
  // Spuštění a registrace loggeru první (ostatní služby na něm závisí)
  const logger = await GenServer.start(loggerBehavior);
  Registry.register('logger', logger);

  // Spuštění a registrace počítadla (používá logger v init)
  const counter = await GenServer.start(counterBehavior);
  Registry.register('counter', counter);

  // Nyní jakákoliv část aplikace může tyto služby používat
  await simulateRequests();

  // Kontrola logů
  const loggerRef = Registry.lookup<LoggerState, LoggerCall, LoggerCast, LoggerReply>('logger');
  const logs = await GenServer.call(loggerRef, { type: 'getLogs' });
  console.log('\n--- Všechny logy ---');
  logs.forEach((log) => console.log(log));

  // Úklid
  await GenServer.stop(counter);
  await GenServer.stop(logger);
}

async function simulateRequests() {
  // Tato funkce nepotřebuje žádné předané reference
  // Vyhledává služby podle jména

  const counter = Registry.lookup<CounterState, CounterCall, CounterCast, CounterReply>('counter');
  const logger = Registry.lookup<LoggerState, LoggerCall, LoggerCast, LoggerReply>('logger');

  GenServer.cast(logger, { type: 'log', level: 'info', message: 'Začínám simulaci požadavků' });

  // Provedení některých operací
  GenServer.cast(counter, { type: 'increment' });
  GenServer.cast(counter, { type: 'increment' });
  GenServer.cast(counter, { type: 'increment' });

  // Počkejte na zpracování castů
  await new Promise((r) => setTimeout(r, 50));

  const value = await GenServer.call(counter, { type: 'get' });
  GenServer.cast(logger, {
    type: 'log',
    level: 'info',
    message: `Simulace požadavků dokončena. Počítadlo: ${value}`,
  });

  // Počkejte na finální log
  await new Promise((r) => setTimeout(r, 10));
}

main();
```

Spusťte pomocí:

```bash
npx tsx services.ts
```

Očekávaný výstup:

```
[INFO] 2024-01-15T10:30:00.000Z: Počítadlo inicializováno
[INFO] 2024-01-15T10:30:00.001Z: Začínám simulaci požadavků
[DEBUG] 2024-01-15T10:30:00.002Z: Počítadlo inkrementováno na 1
[DEBUG] 2024-01-15T10:30:00.003Z: Počítadlo inkrementováno na 2
[DEBUG] 2024-01-15T10:30:00.004Z: Počítadlo inkrementováno na 3
[INFO] 2024-01-15T10:30:00.055Z: Simulace požadavků dokončena. Počítadlo: 3

--- Všechny logy ---
[INFO] 2024-01-15T10:30:00.000Z: Počítadlo inicializováno
[INFO] 2024-01-15T10:30:00.001Z: Začínám simulaci požadavků
[DEBUG] 2024-01-15T10:30:00.002Z: Počítadlo inkrementováno na 1
[DEBUG] 2024-01-15T10:30:00.003Z: Počítadlo inkrementováno na 2
[DEBUG] 2024-01-15T10:30:00.004Z: Počítadlo inkrementováno na 3
[INFO] 2024-01-15T10:30:00.055Z: Simulace požadavků dokončena. Počítadlo: 3
```

## Cvičení

Vytvořte **KeyValueStore** GenServer, který:

1. Podporuje `get(key)` a `set(key, value)` jako cally
2. Podporuje `delete(key)` jako cast
3. Je registrován pod jménem `'kv-store'`
4. Vytvořte helper modul s funkcemi `kvGet`, `kvSet`, `kvDelete` které vyhledávají store přes Registry

Otestujte že:
- Helper funkce fungují bez předávání referencí
- Hodnoty mohou být uloženy a získány
- Automatický úklid nastane když server skončí

**Nápovědy:**
- Použijte `Map<string, unknown>` pro úložiště
- `kvGet` by měl vrátit `undefined` pro chybějící klíče
- Helpery by měly vyhodit `NotRegisteredError` pokud store neběží

<details>
<summary>Řešení</summary>

```typescript
import {
  GenServer,
  Registry,
  NotRegisteredError,
  type GenServerBehavior,
} from '@hamicek/noex';

// Typy
interface KVState {
  data: Map<string, unknown>;
}

type KVCallMsg =
  | { type: 'get'; key: string }
  | { type: 'set'; key: string; value: unknown }
  | { type: 'keys' };

type KVCastMsg = { type: 'delete'; key: string };

type KVReply = unknown | string[];

// Behavior
const kvStoreBehavior: GenServerBehavior<KVState, KVCallMsg, KVCastMsg, KVReply> = {
  init() {
    return { data: new Map() };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.data.get(msg.key), state];

      case 'set': {
        const newData = new Map(state.data);
        newData.set(msg.key, msg.value);
        return [msg.value, { data: newData }];
      }

      case 'keys':
        return [Array.from(state.data.keys()), state];
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'delete') {
      const newData = new Map(state.data);
      newData.delete(msg.key);
      return { data: newData };
    }
    return state;
  },
};

// Helper modul
const KV_STORE_NAME = 'kv-store';

function getStore() {
  return Registry.lookup<KVState, KVCallMsg, KVCastMsg, KVReply>(KV_STORE_NAME);
}

export async function kvGet<T = unknown>(key: string): Promise<T | undefined> {
  const store = getStore();
  return (await GenServer.call(store, { type: 'get', key })) as T | undefined;
}

export async function kvSet<T>(key: string, value: T): Promise<T> {
  const store = getStore();
  return (await GenServer.call(store, { type: 'set', key, value })) as T;
}

export function kvDelete(key: string): void {
  const store = getStore();
  GenServer.cast(store, { type: 'delete', key });
}

export async function kvKeys(): Promise<string[]> {
  const store = getStore();
  return (await GenServer.call(store, { type: 'keys' })) as string[];
}

// Test
async function main() {
  // Spuštění a registrace store
  const storeRef = await GenServer.start(kvStoreBehavior);
  Registry.register(KV_STORE_NAME, storeRef);
  console.log('KV Store spuštěn a zaregistrován');

  // Test helper funkcí (žádné reference nejsou potřeba!)
  await kvSet('user:1', { name: 'Alice', age: 30 });
  await kvSet('user:2', { name: 'Bob', age: 25 });
  await kvSet('config:theme', 'dark');

  console.log('\nUložené hodnoty:');
  console.log('user:1 =', await kvGet('user:1'));
  console.log('user:2 =', await kvGet('user:2'));
  console.log('config:theme =', await kvGet('config:theme'));
  console.log('missing =', await kvGet('missing'));

  console.log('\nVšechny klíče:', await kvKeys());

  // Test delete
  kvDelete('user:2');
  await new Promise((r) => setTimeout(r, 10));
  console.log('\nPo smazání user:2:');
  console.log('user:2 =', await kvGet('user:2'));
  console.log('Všechny klíče:', await kvKeys());

  // Test automatického úklidu
  console.log('\nZastavuji store...');
  await GenServer.stop(storeRef);
  console.log('Store zaregistrován:', Registry.isRegistered(KV_STORE_NAME)); // false

  // Toto by mělo vyhodit NotRegisteredError
  try {
    await kvGet('user:1');
  } catch (error) {
    if (error instanceof NotRegisteredError) {
      console.log(`\nOčekávaná chyba: Store '${error.processName}' není zaregistrován`);
    }
  }
}

main();
```

Očekávaný výstup:

```
KV Store spuštěn a zaregistrován

Uložené hodnoty:
user:1 = { name: 'Alice', age: 30 }
user:2 = { name: 'Bob', age: 25 }
config:theme = dark
missing = undefined

Všechny klíče: [ 'user:1', 'user:2', 'config:theme' ]

Po smazání user:2:
user:2 = undefined
Všechny klíče: [ 'user:1', 'config:theme' ]

Zastavuji store...
Store zaregistrován: false

Očekávaná chyba: Store 'kv-store' není zaregistrován
```

</details>

## Shrnutí

- **Registry** poskytuje vyhledávání pojmenovaných procesů, odděluje komponenty od explicitních referencí
- Použijte `Registry.register(name, ref)` pro přiřazení jména k procesu
- Použijte `Registry.lookup(name)` když služba musí existovat (vyhodí při absenci)
- Použijte `Registry.whereis(name)` když je služba volitelná (vrátí undefined)
- Režim **Unique** (výchozí): Každé jméno mapuje na přesně jeden proces
- Režim **Duplicate**: Více záznamů na klíč, užitečné pro pub/sub s `dispatch()`
- Registrace jsou **automaticky uklizeny** když procesy skončí
- Vytvořte izolované registry s `Registry.create()` pro vlastní konfigurace
- Pattern matching s `match()` podporuje glob-style vzory (`*`, `**`, `?`)

Pojmenované procesy jsou základním stavebním blokem pro větší aplikace. Umožňují volnou vazbu, činí váš kód modulárnějším a testovatelnějším.

---

Další: [Proč Supervisor?](../03-supervision/01-proc-supervisor.md)
