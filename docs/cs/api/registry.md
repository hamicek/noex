# Registry API Reference

Objekt `Registry` poskytuje vyhledávání pojmenovaných procesů, umožňující objevování procesů podle známých jmen.

## Import

```typescript
import { Registry } from 'noex';
```

## Metody

### register()

Registruje proces pod daným jménem.

```typescript
register<State = unknown, CallMsg = unknown, CastMsg = unknown, CallReply = unknown>(
  name: string,
  ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
): void
```

**Parametry:**
- `name` - Jméno pro registraci
- `ref` - Reference procesu k registraci

**Vrací:** void

**Vyhazuje:**
- `AlreadyRegisteredError` - Pokud je jméno již registrováno

**Poznámky:**
- Registrace je automaticky odstraněna, když proces skončí
- Každé jméno může být registrováno pouze jednou

**Příklad:**
```typescript
const ref = await GenServer.start(behavior);
Registry.register('my-service', ref);

// Pokus o opětovnou registraci vyhodí výjimku
try {
  Registry.register('my-service', anotherRef);
} catch (error) {
  // AlreadyRegisteredError
}
```

---

### lookup()

Vyhledá proces podle jména. Vyhodí výjimku, pokud nenalezeno.

```typescript
lookup<State = unknown, CallMsg = unknown, CastMsg = unknown, CallReply = unknown>(
  name: string,
): GenServerRef<State, CallMsg, CastMsg, CallReply>
```

**Parametry:**
- `name` - Jméno k vyhledání

**Vrací:** Registrovanou GenServerRef

**Vyhazuje:**
- `NotRegisteredError` - Pokud není pod jménem registrován žádný proces

**Příklad:**
```typescript
// Základní vyhledání
const ref = Registry.lookup('my-service');

// Typované vyhledání
const counter = Registry.lookup<number, 'get', 'inc', number>('counter');
const value = await GenServer.call(counter, 'get');
```

---

### whereis()

Vyhledá proces podle jména. Vrátí undefined, pokud nenalezeno.

```typescript
whereis<State = unknown, CallMsg = unknown, CastMsg = unknown, CallReply = unknown>(
  name: string,
): GenServerRef<State, CallMsg, CastMsg, CallReply> | undefined
```

**Parametry:**
- `name` - Jméno k vyhledání

**Vrací:** Registrovanou GenServerRef, nebo undefined, pokud nenalezeno

**Příklad:**
```typescript
const counter = Registry.whereis('counter');
if (counter) {
  await GenServer.call(counter, 'get');
} else {
  console.log('Counter není dostupný');
}
```

---

### unregister()

Odregistruje proces podle jména.

```typescript
unregister(name: string): void
```

**Parametry:**
- `name` - Jméno k odregistraci

**Vrací:** void

**Poznámky:**
- Idempotentní - odregistrace neexistujícího jména nic nedělá
- Proces pokračuje v běhu, pouze je odstraněno mapování jména

**Příklad:**
```typescript
Registry.unregister('old-service');
// Jméno je nyní dostupné pro opětovnou registraci
Registry.register('old-service', newRef);
```

---

### isRegistered()

Zjistí, zda je jméno aktuálně registrováno.

```typescript
isRegistered(name: string): boolean
```

**Parametry:**
- `name` - Jméno ke kontrole

**Vrací:** `true` pokud je jméno registrováno

**Příklad:**
```typescript
if (Registry.isRegistered('counter')) {
  const counter = Registry.lookup('counter');
  // Bezpečné k použití
}
```

---

### getNames()

Vrací všechna aktuálně registrovaná jména.

```typescript
getNames(): readonly string[]
```

**Vrací:** Pole registrovaných jmen

**Příklad:**
```typescript
const names = Registry.getNames();
console.log('Registrované služby:', names);
// ['cache', 'auth', 'metrics']
```

---

### count()

Vrací počet registrovaných procesů.

```typescript
count(): number
```

**Vrací:** Počet registrovaných procesů

**Příklad:**
```typescript
console.log(`${Registry.count()} služeb registrováno`);
```

---

## Třídy chyb

### NotRegisteredError

```typescript
class NotRegisteredError extends Error {
  readonly name = 'NotRegisteredError';
  readonly processName: string;
}
```

### AlreadyRegisteredError

```typescript
class AlreadyRegisteredError extends Error {
  readonly name = 'AlreadyRegisteredError';
  readonly registeredName: string;
}
```

---

## Kompletní příklad

```typescript
import { Registry, GenServer, type GenServerBehavior } from 'noex';

// Definice jmen služeb
const SERVICES = {
  CACHE: 'cache',
  AUTH: 'auth',
  METRICS: 'metrics',
} as const;

// Chování cache služby
const cacheBehavior: GenServerBehavior<
  Map<string, unknown>,
  { type: 'get'; key: string },
  { type: 'set'; key: string; value: unknown },
  unknown
> = {
  init: () => new Map(),
  handleCall: (msg, state) => [state.get(msg.key), state],
  handleCast: (msg, state) => {
    state.set(msg.key, msg.value);
    return state;
  },
};

// Spuštění a registrace služby
async function startCacheService() {
  const ref = await GenServer.start(cacheBehavior);
  Registry.register(SERVICES.CACHE, ref);
  return ref;
}

// Použití služby odkudkoliv
async function cacheGet(key: string): Promise<unknown> {
  const cache = Registry.lookup<
    Map<string, unknown>,
    { type: 'get'; key: string },
    { type: 'set'; key: string; value: unknown },
    unknown
  >(SERVICES.CACHE);

  return GenServer.call(cache, { type: 'get', key });
}

function cacheSet(key: string, value: unknown): void {
  const cache = Registry.whereis(SERVICES.CACHE);
  if (cache) {
    GenServer.cast(cache, { type: 'set', key, value });
  }
}

// Health check
function getServiceStatus(): Record<string, boolean> {
  return {
    cache: Registry.isRegistered(SERVICES.CACHE),
    auth: Registry.isRegistered(SERVICES.AUTH),
    metrics: Registry.isRegistered(SERVICES.METRICS),
  };
}

// Použití
async function main() {
  await startCacheService();

  cacheSet('user:1', { name: 'Alice' });
  const user = await cacheGet('user:1');
  console.log(user);

  console.log('Služby:', getServiceStatus());
  console.log('Všechna jména:', Registry.getNames());
}
```

## Související

- [Koncepty Registry](../concepts/registry.md) - Pochopení Registry
- [GenServer API](./genserver.md) - API procesů
- [Reference chyb](./errors.md) - Všechny třídy chyb
