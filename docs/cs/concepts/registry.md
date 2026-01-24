# Registr

Registr poskytuje vyhledávání procesů podle jména pro GenServery a Supervisory. Umožňuje volnou vazbu mezi komponentami tím, že služby lze vyhledávat podle známých jmen místo explicitního předávání referencí.

## Přehled

Systém registrů nabízí:
- **Globální registr** - Jednoduché mapování jméno→proces pro celou aplikaci
- **Instance registrů** - Izolované registry s vlastními režimy klíčů a metadaty
- **Unikátní klíče** - Jeden záznam na klíč (výchozí, service discovery)
- **Duplicitní klíče** - Více záznamů na klíč (pub/sub, event routing)
- **Metadata** - Typovaná data připojená ke každé registraci
- **Pattern matching** - Dotazování záznamů pomocí glob vzorů nebo predikátů
- **Dispatch** - Rozesílání zpráv všem záznamům pod klíčem
- **Automatický úklid** - Záznamy jsou odstraněny při terminaci procesů
- **Persistence** - Volitelné ukládání stavu registru přes restarty

```typescript
import { Registry, RegistryInstance } from 'noex';

// Globální registr (jednoduchý, unikátní klíče)
const counter = await GenServer.start(counterBehavior);
Registry.register('counter', counter);
const ref = Registry.lookup('counter');

// Vlastní instance registru (typovaná metadata, duplicitní klíče)
const topics = Registry.create({ name: 'topics', keys: 'duplicate' });
await topics.start();
topics.register('user:created', handlerA);
topics.register('user:created', handlerB);
topics.dispatch('user:created', { userId: '123' });
```

## Globální registr vs Instance registrů

### Globální registr

Objekt `Registry` je fasáda nad interní defaultní `RegistryInstance` v režimu unique. Poskytuje nejjednodušší API pro běžné service discovery:

```typescript
// Automatická registrace při spuštění
const ref = await GenServer.start(behavior, { name: 'auth' });

// Vyhledání odkudkoli
const auth = Registry.lookup('auth');
await GenServer.call(auth, { type: 'validate', token });
```

### Instance registrů

Pro pokročilejší případy vytvořte izolované instance pomocí `Registry.create()`:

```typescript
const services = Registry.create<{ version: string }>({
  name: 'services',
  keys: 'unique',
});
await services.start();

services.register('auth', authRef, { version: '2.1' });
services.register('cache', cacheRef, { version: '1.0' });

// Plně izolováno od globálního Registry
Registry.isRegistered('auth'); // false (není v globálním)
services.isRegistered('auth'); // true
```

Instance jsou nezávislé — uzavření jedné neovlivní ostatní.

## Režimy klíčů

### Režim Unique (výchozí)

Každý klíč mapuje na právě jeden záznam. Pokus o registraci duplicitního klíče vyhodí chybu:

```typescript
const registry = Registry.create({ name: 'services', keys: 'unique' });
await registry.start();

registry.register('db', dbRef);
registry.register('db', anotherRef); // vyhodí AlreadyRegisteredKeyError
```

Použijte režim unique pro:
- Service discovery (jedna autoritativní instance na jméno)
- Singleton procesy
- Pojmenované workery

### Režim Duplicate

Každý klíč může mapovat na více záznamů, umožňující pub/sub vzory:

```typescript
const events = Registry.create({ name: 'events', keys: 'duplicate' });
await events.start();

// Více handlerů pro stejnou událost
events.register('order:placed', emailHandler);
events.register('order:placed', inventoryHandler);
events.register('order:placed', analyticsHandler);

// Broadcast všem handlerům
events.dispatch('order:placed', orderData);
```

Použijte režim duplicate pro:
- Event routing
- Pub/sub messaging
- Fan-out vzory
- Topic subscriptions

## Metadata

Připojte typovaná metadata ke každé registraci pro bohatší dotazování:

```typescript
interface ServiceMeta {
  version: string;
  priority: number;
  healthy: boolean;
}

const services = Registry.create<ServiceMeta>({
  name: 'services',
  keys: 'unique',
});
await services.start();

services.register('auth', authRef, {
  version: '2.1',
  priority: 10,
  healthy: true,
});

// Čtení metadat
const meta = services.getMetadata('auth');
// { version: '2.1', priority: 10, healthy: true }

// Aktualizace metadat
services.updateMetadata('auth', (m) => ({ ...m, healthy: false }));
```

## Pattern Matching

### select()

Filtrování záznamů pomocí libovolných predikátů:

```typescript
// Nalezení všech služeb s vysokou prioritou
const critical = services.select(
  (key, entry) => entry.metadata.priority >= 8,
);

// Nalezení záznamů podle prefixu klíče
const userServices = services.select(
  (key) => key.startsWith('user:'),
);
```

### match()

Vyhledávání záznamů pomocí glob-like vzorů na klíčích:

```typescript
// * odpovídá libovolným znakům kromě /
const userHandlers = events.match('user:*');
// Odpovídá: 'user:created', 'user:deleted'
// Přeskakuje: 'order:placed'

// ** odpovídá libovolným znakům včetně /
const allNested = registry.match('app/**');
// Odpovídá: 'app/auth', 'app/cache/redis'

// ? odpovídá jednomu znaku
const versions = registry.match('v?');
// Odpovídá: 'v1', 'v2'
// Přeskakuje: 'v10'

// S predikátem hodnoty
const activeAuth = services.match('auth:*', (e) => e.metadata.healthy);
```

## Dispatch

V režimu duplicate rozešlete zprávy všem záznamům pod klíčem:

```typescript
const topics = Registry.create({ name: 'topics', keys: 'duplicate' });
await topics.start();

topics.register('events', workerA);
topics.register('events', workerB);
topics.register('events', workerC);

// Výchozí: GenServer.cast na každý záznam
topics.dispatch('events', { type: 'process', data });

// Vlastní dispatch funkce
topics.dispatch('events', payload, (entries, msg) => {
  // Round-robin: vyber jeden záznam
  const idx = Math.floor(Math.random() * entries.length);
  GenServer.cast(entries[idx].ref, msg);
});
```

## Integrace s GenServerem

Použijte volbu `registry` v `GenServer.start()` pro registraci ve vlastním registru:

```typescript
const services = Registry.create({ name: 'app-services' });
await services.start();

// Registrace ve vlastním registru místo globálního
const ref = await GenServer.start(behavior, {
  name: 'auth',
  registry: services,
});

// Registrováno v services, NE v globálním Registry
services.isRegistered('auth'); // true
Registry.isRegistered('auth'); // false
```

V režimu duplicate mohou více serverů sdílet stejné jméno:

```typescript
const workers = Registry.create({ name: 'workers', keys: 'duplicate' });
await workers.start();

// Spuštění více workerů pod stejným klíčem
const w1 = await GenServer.start(workerBehavior, { name: 'pool', registry: workers });
const w2 = await GenServer.start(workerBehavior, { name: 'pool', registry: workers });

workers.countForKey('pool'); // 2
workers.dispatch('pool', job); // broadcast oběma
```

## Automatický úklid

Záznamy jsou automaticky odstraněny při terminaci registrovaného procesu:

```typescript
const registry = Registry.create({ name: 'test' });
await registry.start();

const ref = await GenServer.start(behavior);
registry.register('ephemeral', ref);
registry.isRegistered('ephemeral'); // true

await GenServer.stop(ref);
// Po propagaci lifecycle eventu:
registry.isRegistered('ephemeral'); // false
```

Funguje napříč více registry — pokud je proces registrován v několika instancích, všechny registrace jsou vyčištěny při terminaci.

## Persistence

Instance registrů mohou persistovat svůj stav přes restarty pomocí `StorageAdapter`:

```typescript
import { FileAdapter } from 'noex';

const registry = Registry.create<{ role: string }>({
  name: 'services',
  keys: 'unique',
  persistence: {
    adapter: new FileAdapter({ directory: './data' }),
    restoreOnStart: true,
    persistOnChange: true,
    debounceMs: 200,
    persistOnShutdown: true,
    onError: (err) => console.error('Persistence registru selhala:', err),
  },
});

await registry.start(); // Obnoví záznamy ze storage (mrtvé refy jsou přeskočeny)

registry.register('auth', authRef, { role: 'authentication' });
// Stav je persistován po 200ms debounce

await registry.close(); // Finální flush do storage
```

**Klíčové chování:**
- Změny jsou debounced pro zamezení nadměrným zápisům
- Mrtvé refy jsou přeskočeny při obnově
- Chyby persistence jsou nefatální (registr pokračuje in-memory)

## Běžné vzory

### Service Discovery s metadaty

```typescript
interface ServiceInfo {
  version: string;
  port: number;
  healthEndpoint: string;
}

const services = Registry.create<ServiceInfo>({ name: 'services' });
await services.start();

services.register('api-gateway', gatewayRef, {
  version: '3.2.0',
  port: 8080,
  healthEndpoint: '/health',
});

// Nalezení všech služeb v3.x
const v3Services = services.select(
  (_, entry) => entry.metadata.version.startsWith('3.'),
);
```

### Event Bus s topicy

```typescript
const bus = Registry.create({ name: 'event-bus', keys: 'duplicate' });
await bus.start();

// Přihlášení handlerů k topicům
bus.register('order:*', orderLogger);
bus.register('order:placed', inventoryUpdater);
bus.register('order:placed', emailNotifier);

// Dispatch na konkrétní topic
bus.dispatch('order:placed', { orderId: '456', items: [...] });
```

### Monitoring zdraví

```typescript
const monitored = Registry.create<{ healthy: boolean; lastCheck: number }>({
  name: 'monitored',
});
await monitored.start();

// Periodická kontrola zdraví
setInterval(() => {
  const unhealthy = monitored.select(
    (_, entry) => !entry.metadata.healthy,
  );
  if (unhealthy.length > 0) {
    console.warn('Nezdravé služby:', unhealthy.map((m) => m.key));
  }
}, 10000);
```

## Srovnání s Elixirem

| noex | Elixir |
|------|--------|
| `Registry.register(name, ref)` | `{:via, Registry, name}` při startu |
| `Registry.lookup(name)` | `GenServer.call({:via, Registry, name}, msg)` |
| `Registry.create({ keys: 'duplicate' })` | `Registry.start_link(keys: :duplicate)` |
| `registry.select(predicate)` | `Registry.select(registry, spec)` |
| `registry.match(pattern)` | `Registry.match(registry, key, pattern)` |
| `registry.dispatch(key, msg)` | `Registry.dispatch(registry, key, fn)` |

## Související

- [API Reference: Registry](../api/registry.md) - Kompletní API dokumentace
- [GenServer](./genserver.md) - Procesy, které lze registrovat
- [Supervisor](./supervisor.md) - Supervize registrovaných procesů
