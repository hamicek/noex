# Registry API Reference

Objekt `Registry` poskytuje vyhledávání pojmenovaných procesů a slouží zároveň jako factory pro vytváření izolovaných `RegistryInstance` instancí s vlastní konfigurací.

## Import

```typescript
import { Registry, RegistryInstance } from 'noex';
import type {
  RegistryOptions,
  RegistryKeyMode,
  RegistryEntry,
  RegistryMatch,
  RegistryPredicate,
  DispatchFn,
} from 'noex';
```

---

## Registry (Globální fasáda)

Statický objekt `Registry` deleguje na interní defaultní `RegistryInstance` v režimu unique. Poskytuje jednoduchý globální namespace pro registraci procesů.

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

**Vyhazuje:**
- `AlreadyRegisteredError` - Pokud je jméno již registrováno

**Poznámky:**
- Registrace je automaticky odstraněna při terminaci procesu
- Každé jméno může být registrováno pouze jednou

**Příklad:**
```typescript
const ref = await GenServer.start(behavior);
Registry.register('my-service', ref);
```

---

### lookup()

Vyhledá proces podle jména. Vyhodí výjimku, pokud nenalezeno.

```typescript
lookup<State = unknown, CallMsg = unknown, CastMsg = unknown, CallReply = unknown>(
  name: string,
): GenServerRef<State, CallMsg, CastMsg, CallReply>
```

**Vyhazuje:**
- `NotRegisteredError` - Pokud není pod jménem registrován žádný proces

**Příklad:**
```typescript
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

**Příklad:**
```typescript
const counter = Registry.whereis('counter');
if (counter) {
  await GenServer.call(counter, 'get');
}
```

---

### unregister()

Odregistruje proces podle jména. Idempotentní.

```typescript
unregister(name: string): void
```

---

### isRegistered()

Zjistí, zda je jméno aktuálně registrováno.

```typescript
isRegistered(name: string): boolean
```

---

### getNames()

Vrací všechna aktuálně registrovaná jména.

```typescript
getNames(): readonly string[]
```

---

### count()

Vrací počet registrovaných procesů.

```typescript
count(): number
```

---

### create()

Vytvoří novou izolovanou `RegistryInstance` s vlastní konfigurací.

```typescript
create<Meta = unknown>(options?: RegistryOptions): RegistryInstance<Meta>
```

**Typové parametry:**
- `Meta` - Typ metadat přiřazených ke každému záznamu

**Parametry:**
- `options` - Konfigurace registru (jméno, režim klíčů, persistence)

**Vrací:** Novou `RegistryInstance`, kterou je třeba nastartovat pomocí `await instance.start()`

**Příklad:**
```typescript
const services = Registry.create<{ version: string }>({
  name: 'services',
  keys: 'unique',
});
await services.start();
services.register('auth', authRef, { version: '2.0' });

// Režim duplicate (pub/sub)
const topics = Registry.create({ name: 'topics', keys: 'duplicate' });
await topics.start();
topics.register('user:created', handlerA);
topics.register('user:created', handlerB);
topics.dispatch('user:created', payload);
```

---

## RegistryInstance

`RegistryInstance` je hlavní třída registru podporující režimy unique a duplicate klíčů, metadata, pattern matching a dispatch.

### Konstruktor

```typescript
new RegistryInstance<Meta = unknown>(options?: RegistryOptions)
```

**Volby:**

| Volba | Typ | Výchozí | Popis |
|-------|-----|---------|-------|
| `name` | `string` | auto-generované | Lidsky čitelné jméno |
| `keys` | `'unique' \| 'duplicate'` | `'unique'` | Režim klíčů |
| `persistence` | `RegistryPersistenceConfig` | — | Volitelná persistence |

---

### start()

Inicializuje registr a nastaví lifecycle handlery pro automatický úklid.

```typescript
async start(): Promise<void>
```

Idempotentní — volání na již nastartované instanci nic nedělá.

---

### close()

Ukončí registr, odstraní lifecycle handlery a vyčistí všechny záznamy.

```typescript
async close(): Promise<void>
```

Idempotentní — bezpečné volat na zastavené instanci.

---

### register()

Registruje referenci pod klíčem s volitelnými metadaty.

```typescript
register(key: string, ref: RegisterableRef, metadata?: Meta): void
```

**Režim unique:** Vyhodí `AlreadyRegisteredKeyError` pokud je klíč již obsazen.
**Režim duplicate:** Vyhodí `DuplicateRegistrationError` pokud je stejný ref již registrován pod stejným klíčem.

---

### unregister()

Odstraní všechny záznamy pro klíč. Idempotentní.

```typescript
unregister(key: string): void
```

---

### unregisterMatch()

Odstraní konkrétní ref z klíče. V režimu duplicate je odstraněn pouze odpovídající záznam.

```typescript
unregisterMatch(key: string, ref: RegisterableRef): void
```

---

### lookup()

Vrací záznam pro klíč (pouze režim unique).

```typescript
lookup(key: string): RegistryEntry<Meta>
```

**Vyhazuje:**
- `DuplicateKeyLookupError` - Pokud voláno na registru v režimu duplicate
- `KeyNotFoundError` - Pokud klíč není registrován

---

### whereis()

Nevyhazující lookup. Vrací záznam nebo undefined.

```typescript
whereis(key: string): RegistryEntry<Meta> | undefined
```

V režimu duplicate vrací první záznam.

---

### lookupAll()

Vrací všechny záznamy pro klíč. Funguje v obou režimech.

```typescript
lookupAll(key: string): ReadonlyArray<RegistryEntry<Meta>>
```

---

### select()

Filtruje záznamy pomocí predikátové funkce.

```typescript
select(predicate: RegistryPredicate<Meta>): RegistryMatch<Meta>[]
```

**Příklad:**
```typescript
const workers = registry.select(
  (key, entry) => entry.metadata.type === 'worker',
);
```

---

### match()

Vyhledá záznamy podle glob-like vzoru klíče s volitelným predikátem hodnoty.

```typescript
match(
  keyPattern: string,
  valuePredicate?: (entry: RegistryEntry<Meta>) => boolean,
): RegistryMatch<Meta>[]
```

**Syntaxe vzoru:**
- `*` odpovídá libovolným znakům kromě `/`
- `**` odpovídá libovolným znakům včetně `/`
- `?` odpovídá jednomu znaku

**Příklad:**
```typescript
const userServices = registry.match('user:*');
const active = registry.match('svc:*', (e) => e.metadata.active);
```

---

### dispatch()

Rozešle zprávu všem záznamům pod klíčem (pouze režim duplicate).

```typescript
dispatch(key: string, message: unknown, dispatchFn?: DispatchFn<Meta>): void
```

**Výchozí chování:** Odesílá zprávu přes `GenServer.cast` každému záznamu.
**Vlastní dispatch:** Poskytněte `dispatchFn` pro vlastní routování (round-robin, filtrování apod.).

**Vyhazuje:**
- `DispatchNotSupportedError` - Pokud voláno na registru v režimu unique

**Příklad:**
```typescript
// Výchozí broadcast
topics.dispatch('user:created', { userId: '123' });

// Vlastní dispatch
topics.dispatch('events', payload, (entries, msg) => {
  for (const entry of entries) {
    if (entry.metadata.priority > 5) {
      GenServer.cast(entry.ref, msg);
    }
  }
});
```

---

### getMetadata()

Vrací metadata pro klíč. V režimu duplicate vrací metadata prvního záznamu.

```typescript
getMetadata(key: string): Meta | undefined
```

---

### updateMetadata()

Aktualizuje metadata pomocí updater funkce. V režimu duplicate aktualizuje všechny záznamy.

```typescript
updateMetadata(key: string, updater: (meta: Meta) => Meta): boolean
```

Vrací `true` pokud byly aktualizovány nějaké záznamy.

---

### isRegistered()

```typescript
isRegistered(key: string): boolean
```

---

### getKeys()

```typescript
getKeys(): readonly string[]
```

---

### count()

Vrací celkový počet záznamů přes všechny klíče.

```typescript
count(): number
```

---

### countForKey()

Vrací počet záznamů pro konkrétní klíč.

```typescript
countForKey(key: string): number
```

---

## Typy

### RegistryOptions

```typescript
interface RegistryOptions {
  readonly name?: string;
  readonly keys?: RegistryKeyMode;
  readonly persistence?: RegistryPersistenceConfig;
}
```

### RegistryKeyMode

```typescript
type RegistryKeyMode = 'unique' | 'duplicate';
```

### RegistryEntry\<Meta\>

```typescript
interface RegistryEntry<Meta = unknown> {
  readonly ref: RegisterableRef;
  readonly metadata: Meta;
  readonly registeredAt: number;
}
```

### RegistryMatch\<Meta\>

```typescript
interface RegistryMatch<Meta = unknown> {
  readonly key: string;
  readonly ref: RegisterableRef;
  readonly metadata: Meta;
}
```

### RegistryPredicate\<Meta\>

```typescript
type RegistryPredicate<Meta> = (
  key: string,
  entry: RegistryEntry<Meta>,
) => boolean;
```

### DispatchFn\<Meta\>

```typescript
type DispatchFn<Meta> = (
  entries: ReadonlyArray<RegistryEntry<Meta>>,
  message: unknown,
) => void;
```

### RegistryPersistenceConfig

```typescript
interface RegistryPersistenceConfig {
  readonly adapter: StorageAdapter;
  readonly key?: string;
  readonly restoreOnStart?: boolean;    // výchozí: true
  readonly persistOnChange?: boolean;   // výchozí: true
  readonly debounceMs?: number;         // výchozí: 100
  readonly persistOnShutdown?: boolean; // výchozí: true
  readonly onError?: (error: Error) => void;
}
```

---

## Třídy chyb

### AlreadyRegisteredKeyError

Vyhodí se, když je klíč již registrován v režimu unique.

```typescript
class AlreadyRegisteredKeyError extends Error {
  readonly name = 'AlreadyRegisteredKeyError';
  readonly registryName: string;
  readonly key: string;
}
```

### KeyNotFoundError

Vyhodí se, když `lookup()` selže, protože klíč nebyl nalezen.

```typescript
class KeyNotFoundError extends Error {
  readonly name = 'KeyNotFoundError';
  readonly registryName: string;
  readonly key: string;
}
```

### DuplicateKeyLookupError

Vyhodí se, když je `lookup()` voláno na registru v režimu duplicate.

```typescript
class DuplicateKeyLookupError extends Error {
  readonly name = 'DuplicateKeyLookupError';
  readonly registryName: string;
  readonly key: string;
}
```

### DispatchNotSupportedError

Vyhodí se, když je `dispatch()` voláno na registru v režimu unique.

```typescript
class DispatchNotSupportedError extends Error {
  readonly name = 'DispatchNotSupportedError';
  readonly registryName: string;
}
```

### DuplicateRegistrationError

Vyhodí se, když je stejný ref registrován pod stejným klíčem v režimu duplicate.

```typescript
class DuplicateRegistrationError extends Error {
  readonly name = 'DuplicateRegistrationError';
  readonly registryName: string;
  readonly key: string;
  readonly refId: string;
}
```

---

## Související

- [Koncepty Registry](../concepts/registry.md) - Instance vs globální, režimy klíčů, vzory
- [GenServer API](./genserver.md) - API procesů
- [Reference chyb](./errors.md) - Všechny třídy chyb
