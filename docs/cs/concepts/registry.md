# Registr

Registr poskytuje vyhledávání procesů podle jména pro GenServery a Supervisory. Umožňuje volnou vazbu mezi komponentami tím, že služby lze vyhledávat podle známých jmen místo explicitního předávání referencí.

## Přehled

Registr nabízí:
- **Pojmenovaná registrace** - Asociace procesů s textovými jmény
- **Globální namespace** - Jediný bod pro vyhledávání v celé aplikaci
- **Automatický úklid** - Registrace jsou odstraněny při ukončení procesů
- **Typově bezpečné vyhledávání** - Zachování TypeScript typů při vyhledávání

```typescript
import { Registry, GenServer } from 'noex';

// Spuštění a registrace služby
const counter = await GenServer.start(counterBehavior);
Registry.register('counter', counter);

// Vyhledání odkudkoli v aplikaci
const ref = Registry.lookup<number, 'get', 'inc', number>('counter');
const value = await GenServer.call(ref, 'get');
```

## Registrace procesů

### Základní registrace

```typescript
const ref = await GenServer.start(behavior);
Registry.register('my-service', ref);
```

### Registrace při spuštění

Běžný vzor je registrovat ihned po spuštění:

```typescript
async function startNamedService(name: string) {
  const ref = await GenServer.start(serviceBehavior);
  Registry.register(name, ref);
  return ref;
}

await startNamedService('user-cache');
await startNamedService('session-store');
```

### Unikátní jména

Každé jméno lze registrovat pouze jednou. Pokus o registraci duplikátu vyhodí chybu:

```typescript
import { AlreadyRegisteredError } from 'noex';

Registry.register('counter', ref1);

try {
  Registry.register('counter', ref2);  // Vyhodí výjimku!
} catch (error) {
  if (error instanceof AlreadyRegisteredError) {
    console.error(`Jméno '${error.registeredName}' je již obsazeno`);
  }
}
```

## Vyhledávání procesů

### lookup() - Vyhazující varianta

Použijte `lookup()`, když očekáváte, že proces existuje:

```typescript
import { NotRegisteredError } from 'noex';

try {
  const counter = Registry.lookup('counter');
  await GenServer.call(counter, 'get');
} catch (error) {
  if (error instanceof NotRegisteredError) {
    console.error(`Proces '${error.processName}' nenalezen`);
  }
}
```

### whereis() - Nevyhazující varianta

Použijte `whereis()` pro volitelné vyhledávání:

```typescript
const counter = Registry.whereis('counter');
if (counter) {
  await GenServer.call(counter, 'get');
} else {
  console.log('Counter není dostupný');
}
```

### Typově bezpečné vyhledávání

Zachovejte typové informace pomocí typových parametrů:

```typescript
// Definice typů
type CounterState = number;
type CounterCall = 'get' | { type: 'add'; n: number };
type CounterCast = 'increment' | 'reset';
type CounterReply = number;

// Typované vyhledávání
const counter = Registry.lookup<
  CounterState,
  CounterCall,
  CounterCast,
  CounterReply
>('counter');

// Nyní plně typováno
const value = await GenServer.call(counter, 'get');  // Vrací number
GenServer.cast(counter, 'increment');                 // Typově kontrolováno
```

## Automatický úklid

Registrace jsou automaticky odstraněny při ukončení procesů:

```typescript
const ref = await GenServer.start(behavior);
Registry.register('temp-service', ref);

console.log(Registry.isRegistered('temp-service'));  // true

await GenServer.stop(ref);

console.log(Registry.isRegistered('temp-service'));  // false
Registry.lookup('temp-service');  // Vyhodí NotRegisteredError
```

Toto zabraňuje zastaralým referencím a únikům paměti.

## Manuální odregistrace

Odstranění registrace bez zastavení procesu:

```typescript
Registry.unregister('old-name');

// Proces pokračuje v běhu, ale jméno je uvolněno
Registry.register('new-name', sameRef);
```

Odregistrace je idempotentní - odregistrace neexistujícího jména nic nedělá:

```typescript
Registry.unregister('does-not-exist');  // Žádná chyba
```

## Dotazování registru

### Kontrola registrace

```typescript
if (Registry.isRegistered('cache')) {
  // Bezpečné vyhledat
  const cache = Registry.lookup('cache');
}
```

### Seznam všech jmen

```typescript
const names = Registry.getNames();
console.log('Registrované služby:', names);
// ['user-cache', 'session-store', 'metrics-collector']
```

### Počet registrací

```typescript
const count = Registry.count();
console.log(`${count} služeb registrováno`);
```

## Běžné vzory

### Vyhledávání služeb

```typescript
// Definice služeb
const SERVICES = {
  CACHE: 'cache',
  AUTH: 'auth',
  METRICS: 'metrics',
} as const;

// Spuštění
async function bootstrap() {
  await startAndRegister(SERVICES.CACHE, cacheBehavior);
  await startAndRegister(SERVICES.AUTH, authBehavior);
  await startAndRegister(SERVICES.METRICS, metricsBehavior);
}

// Použití kdekoli v aplikaci
function getCache() {
  return Registry.lookup(SERVICES.CACHE);
}
```

### Volitelné závislosti

```typescript
async function processRequest(data: Request) {
  // Základní zpracování
  const result = await handleRequest(data);

  // Volitelné metriky (nemusí běžet)
  const metrics = Registry.whereis('metrics');
  if (metrics) {
    GenServer.cast(metrics, { type: 'record', request: data });
  }

  return result;
}
```

### Korektní výměna služby

```typescript
async function replaceService(name: string, newBehavior: GenServerBehavior) {
  // Získat starou referenci pokud existuje
  const old = Registry.whereis(name);

  // Spustit novou službu
  const newRef = await GenServer.start(newBehavior);

  // Atomická výměna: odregistrovat starou, registrovat novou
  if (old) {
    Registry.unregister(name);
  }
  Registry.register(name, newRef);

  // Zastavit starou službu po výměně
  if (old) {
    await GenServer.stop(old);
  }

  return newRef;
}
```

### Registrace pod supervizorem

Kombinace se Supervisorem pro odolné pojmenované služby:

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    {
      id: 'cache',
      start: async () => {
        const ref = await GenServer.start(cacheBehavior);
        // Přeregistrovat při každém restartu
        if (Registry.isRegistered('cache')) {
          Registry.unregister('cache');
        }
        Registry.register('cache', ref);
        return ref;
      },
    },
  ],
});
```

## Osvědčené postupy

### 1. Používejte konstanty pro jména

```typescript
// Dobře: Centralizovaná jména
export const PROCESS_NAMES = {
  USER_CACHE: 'user-cache',
  SESSION_STORE: 'session-store',
  RATE_LIMITER: 'rate-limiter',
} as const;

Registry.register(PROCESS_NAMES.USER_CACHE, ref);
Registry.lookup(PROCESS_NAMES.USER_CACHE);

// Vyhněte se: Stringové literály rozházené po kódu
Registry.register('user-cache', ref);
Registry.lookup('user-cache');  // Riziko překlepu!
```

### 2. Typujte vyhledávání

```typescript
// Dobře: Typově bezpečná reference
type CacheRef = GenServerRef<CacheState, CacheCall, CacheCast, CacheReply>;
const cache = Registry.lookup<CacheState, CacheCall, CacheCast, CacheReply>('cache');

// Vyhněte se: Netypovaná reference
const cache = Registry.lookup('cache');  // Typy jsou neznámé
```

### 3. Ošetřete chybějící služby

```typescript
// Dobře: Elegantní ošetření
const metrics = Registry.whereis('metrics');
if (metrics) {
  GenServer.cast(metrics, event);
}

// Nebo s ošetřením chyb
try {
  const required = Registry.lookup('required-service');
} catch (error) {
  // Ošetřit chybějící požadovanou službu
  throw new Error('Aplikace špatně nakonfigurována: chybí required-service');
}
```

### 4. Dokumentujte jména služeb

```typescript
/**
 * Známá jména služeb v aplikaci.
 *
 * - USER_CACHE: Cache uživatelských profilů, TTL 5 minut
 * - SESSION_STORE: Úložiště aktivních sessions
 * - RATE_LIMITER: Rate limiting API
 */
export const SERVICES = {
  USER_CACHE: 'user-cache',
  SESSION_STORE: 'session-store',
  RATE_LIMITER: 'rate-limiter',
} as const;
```

## Typy chyb

| Chyba | Příčina |
|-------|---------|
| `AlreadyRegisteredError` | Jméno je již používáno |
| `NotRegisteredError` | Pod daným jménem není registrován žádný proces |

## Srovnání s Elixirem

| noex | Elixir |
|------|--------|
| `Registry.register(name, ref)` | `{:via, Registry, name}` při startu |
| `Registry.lookup(name)` | `GenServer.call({:via, Registry, name}, msg)` |
| `Registry.whereis(name)` | `Registry.lookup/2` |
| `Registry.unregister(name)` | Automatické přes linkování procesů |

## Související

- [GenServer](./genserver.md) - Procesy, které lze registrovat
- [Supervisor](./supervisor.md) - Supervize registrovaných procesů
- [API Reference: Registry](../api/registry.md) - Kompletní API dokumentace
