# Co je ETS?

Naučili jste se, jak GenServer poskytuje izolovaný stav se sémantikou message-passing. Ale někdy potřebujete něco jednoduššího: **rychlé, in-memory key-value úložiště**, které nevyžaduje režii procesové komunikace. Právě zde přichází na řadu ETS.

ETS (Erlang Term Storage) je jednou z nejsilnějších vestavěných funkcí Erlangu — a noex přináší tento koncept do TypeScriptu. Poskytuje concurrent-safe, typované key-value tabulky se čtyřmi různými režimy ukládání.

## Co se naučíte

- Co je ETS a jak se liší od GenServeru
- Kdy použít ETS vs GenServer vs externí databáze
- Základní ETS operace (insert, lookup, delete)
- Čtyři typy tabulek a jejich případy použití

## Z Erlangu do TypeScriptu

V Erlang/OTP jsou ETS tabulky bitvami prověřené komponenty používané v produkčních systémech po desetiletí. Poskytují:

- **In-process paměť** — Žádná síťová latence, žádná serializace
- **Konstantní čas vyhledávání** — O(1) pro většinu operací
- **Souběžný přístup** — Více procesů může číst současně
- **Pattern matching** — Dotazování dat s expresivními filtry

Implementace ETS v noex zachovává tyto charakteristiky a přidává typovou bezpečnost TypeScriptu:

```typescript
import { Ets } from '@hamicek/noex';

// Vytvoření typované ETS tabulky
const users = Ets.new<string, { name: string; age: number }>({
  name: 'users',
  type: 'set',
});

await users.start();

// Vložení s typovou kontrolou
users.insert('u1', { name: 'Alice', age: 30 });
users.insert('u2', { name: 'Bob', age: 25 });

// Lookup vrací správně typovanou hodnotu
const alice = users.lookup('u1');
// TypeScript ví: alice je { name: string; age: number } | undefined

console.log(alice?.name); // 'Alice'

await users.close();
```

## ETS vs GenServer

Jak ETS, tak GenServer spravují stav, ale slouží různým účelům:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ETS vs GENSERVER                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  GENSERVER:                        ETS:                                     │
│  ┌───────────────────────┐         ┌───────────────────────┐               │
│  │      Proces           │         │       Tabulka         │               │
│  │   ┌─────────────┐     │         │   ┌─────────────┐     │               │
│  │   │    Stav     │     │         │   │  Key-Value  │     │               │
│  │   └─────────────┘     │         │   │   záznamy   │     │               │
│  │   ┌─────────────┐     │         │   └─────────────┘     │               │
│  │   │   Mailbox   │     │         │                       │               │
│  │   └─────────────┘     │         │   Přímý přístup       │               │
│  │   ┌─────────────┐     │         │   Bez message passing │               │
│  │   │   Behavior  │     │         │   Bez callbacků       │               │
│  │   └─────────────┘     │         │                       │               │
│  └───────────────────────┘         └───────────────────────┘               │
│                                                                             │
│  Zprávy → Proces → Stav            Přímý Read/Write do Tabulky             │
│  Sekvenční zpracování              Souběžný přístup                        │
│  Komplexní stavová logika          Jednoduché key-value úložiště           │
│  Integrace se supervizí            Bez supervize                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Kdy použít ETS

Použijte ETS, když potřebujete:

1. **Rychlé vyhledávání** — Cachování dat pro rychlé načtení
2. **Sdílená data** — Více částí aplikace čte stejná data
3. **Jednoduchá struktura** — Key-value páry bez komplexní logiky
4. **Bez procesové režie** — Přímý přístup bez message passing

```typescript
// Dobrý případ použití ETS: Session cache
const sessions = Ets.new<string, { userId: string; expiresAt: number }>({
  name: 'sessions',
  type: 'set',
});

// Rychlé vyhledávání v request handleru
function getSession(sessionId: string) {
  const session = sessions.lookup(sessionId);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}
```

### Kdy použít GenServer

Použijte GenServer, když potřebujete:

1. **Komplexní stavovou logiku** — Business pravidla, validace, výpočty
2. **Sekvenční zpracování** — Operace, které musí probíhat v pořadí
3. **Supervizi** — Automatický restart při selhání
4. **Message-based komunikaci** — Request/response vzory

```typescript
// Dobrý případ použití GenServer: Zpracování objednávek
const orderBehavior: GenServerBehavior<OrderState, OrderCall, OrderCast, OrderReply> = {
  init: () => ({ orders: new Map(), processingQueue: [] }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'submit': {
        // Komplexní validační logika
        if (!validateOrder(msg.order)) {
          return [state, { ok: false, error: 'invalid_order' }];
        }
        // Stavový přechod s business pravidly
        const newState = processSubmission(state, msg.order);
        return [newState, { ok: true, orderId: msg.order.id }];
      }
      // ... další komplexní handlery
    }
  },

  handleCast: (msg, state) => {
    // Background processing logika
    return processQueue(state);
  },
};
```

## Základní operace

ETS poskytuje přímočaré API pro key-value operace:

### Insert a Lookup

```typescript
const cache = Ets.new<string, number>({ name: 'cache', type: 'set' });
await cache.start();

// Vložení hodnoty
cache.insert('counter', 42);

// Lookup vrací hodnotu nebo undefined
const value = cache.lookup('counter'); // 42
const missing = cache.lookup('nonexistent'); // undefined

// Kontrola existence klíče
const exists = cache.member('counter'); // true
```

### Delete

```typescript
// Smazání podle klíče
const deleted = cache.delete('counter'); // true pokud existoval

// Smazání konkrétního key-value páru (užitečné pro bag typy)
cache.insert('key', 'value1');
cache.deleteObject('key', 'value1'); // Smaže pouze pokud hodnota odpovídá
```

### Hromadné operace

```typescript
// Vložení více záznamů
cache.insertMany([
  ['a', 1],
  ['b', 2],
  ['c', 3],
]);

// Získání všech záznamů
const entries = cache.toArray(); // [['a', 1], ['b', 2], ['c', 3]]

// Získání všech klíčů
const keys = cache.keys(); // ['a', 'b', 'c']

// Velikost tabulky
const size = cache.size(); // 3

// Vymazání všech záznamů
cache.clear();
```

### Query a Filter

```typescript
const users = Ets.new<string, { name: string; role: string }>({
  name: 'users',
  type: 'set',
});
await users.start();

users.insertMany([
  ['u1', { name: 'Alice', role: 'admin' }],
  ['u2', { name: 'Bob', role: 'user' }],
  ['u3', { name: 'Charlie', role: 'admin' }],
]);

// Filtrování s predikátem
const admins = users.select((key, value) => value.role === 'admin');
// [{ key: 'u1', value: { name: 'Alice', role: 'admin' } },
//  { key: 'u3', value: { name: 'Charlie', role: 'admin' } }]

// Match klíčů s glob patterny
users.insert('admin:root', { name: 'Root', role: 'superadmin' });
const adminKeys = users.match('admin:*');
// [{ key: 'admin:root', value: { name: 'Root', role: 'superadmin' } }]

// Reduce přes všechny záznamy
const count = users.reduce((acc, key, value) => acc + 1, 0); // 4
```

### Operace s čítači

Pro numerické hodnoty poskytuje ETS atomické operace s čítači:

```typescript
const counters = Ets.new<string, number>({ name: 'counters', type: 'set' });
await counters.start();

// Inicializace nebo atomické inkrementování
counters.updateCounter('page_views', 1);  // 1 (inicializováno)
counters.updateCounter('page_views', 1);  // 2
counters.updateCounter('page_views', 10); // 12

// Dekrementování
counters.updateCounter('balance', -50); // -50 (inicializováno na zápornou hodnotu)
```

## Rozhodovací průvodce: ETS vs GenServer vs Databáze

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    VÝBĚR SPRÁVNÉHO ÚLOŽIŠTĚ                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────┐                                    │
│  │  Potřebujete, aby data přežila      │                                    │
│  │  restart aplikace?                  │                                    │
│  └─────────────────┬───────────────────┘                                    │
│                    │                                                        │
│          ┌────────┴────────┐                                               │
│          ▼                 ▼                                                │
│         ANO                NE                                               │
│          │                  │                                               │
│          ▼                  ▼                                               │
│    ┌────────────┐    ┌─────────────────────────────────────┐               │
│    │  Databáze  │    │  Je tam komplexní stavová logika?   │               │
│    │  nebo ETS  │    └─────────────────┬───────────────────┘               │
│    │  s         │                      │                                    │
│    │persistence │          ┌──────────┴──────────┐                          │
│    └────────────┘          ▼                     ▼                          │
│                           ANO                    NE                         │
│                            │                      │                         │
│                            ▼                      ▼                         │
│                      ┌──────────┐          ┌──────────┐                     │
│                      │GenServer │          │   ETS    │                     │
│                      └──────────┘          └──────────┘                     │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  RYCHLÝ PŘEHLED:                                                            │
│                                                                             │
│  Použijte ETS pro:                                                          │
│    • Cache (session, API odpovědi, vypočítané hodnoty)                      │
│    • Lookup tabulky (konfigurace, feature flags)                            │
│    • Čítače a metriky                                                       │
│    • Dočasné úložiště během zpracování                                      │
│                                                                             │
│  Použijte GenServer pro:                                                    │
│    • Doménové entity s chováním (User, Order, Game)                         │
│    • Workflow stavové automaty                                              │
│    • Rate limiter s komplexními pravidly                                    │
│    • Cokoliv vyžadující supervizi                                           │
│                                                                             │
│  Použijte Databázi pro:                                                     │
│    • Trvalá business data                                                   │
│    • Data sdílená mezi instancemi aplikace                                  │
│    • Audit trails a compliance                                              │
│    • Data, která musí přežít pády                                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Životní cyklus tabulky

ETS tabulky mají jednoduchý životní cyklus:

```typescript
// 1. Vytvoření tabulky
const table = Ets.new<string, number>({ name: 'my-table', type: 'set' });

// 2. Start (vyžadováno při použití persistence, jinak volitelné)
await table.start();

// 3. Použití tabulky
table.insert('key', 123);
const value = table.lookup('key');

// 4. Uzavření (flushne persistence, zabrání dalším operacím)
await table.close();

// Po close operace vyhazují chybu
table.insert('key', 456); // Error: ETS table 'my-table' is closed.
```

## Informace o tabulce

Získání runtime metadat o tabulce:

```typescript
const table = Ets.new<string, number>({
  name: 'metrics',
  type: 'ordered_set',
});

table.insertMany([
  ['cpu', 45],
  ['memory', 78],
  ['disk', 23],
]);

const info = table.info();
// {
//   name: 'metrics',
//   type: 'ordered_set',
//   size: 3
// }
```

## Příklad: API Response Cache

Zde je praktický příklad kombinující několik ETS funkcí:

```typescript
import { Ets } from '@hamicek/noex';

interface CachedResponse {
  data: unknown;
  cachedAt: number;
  ttlMs: number;
}

// Vytvoření cache tabulky
const responseCache = Ets.new<string, CachedResponse>({
  name: 'api-response-cache',
  type: 'set',
});

await responseCache.start();

// Uložení odpovědi do cache
function cacheResponse(url: string, data: unknown, ttlMs = 60000) {
  responseCache.insert(url, {
    data,
    cachedAt: Date.now(),
    ttlMs,
  });
}

// Získání cachované odpovědi (s kontrolou TTL)
function getCachedResponse(url: string): unknown | null {
  const cached = responseCache.lookup(url);

  if (!cached) {
    return null;
  }

  // Kontrola expirace
  if (Date.now() > cached.cachedAt + cached.ttlMs) {
    responseCache.delete(url);
    return null;
  }

  return cached.data;
}

// Vyčištění expirovaných záznamů
function cleanExpiredEntries() {
  const now = Date.now();
  const expired = responseCache.select(
    (key, value) => now > value.cachedAt + value.ttlMs
  );

  for (const entry of expired) {
    responseCache.delete(entry.key);
  }

  return expired.length;
}

// Použití
cacheResponse('/api/users', [{ id: 1, name: 'Alice' }], 30000);

const data = getCachedResponse('/api/users'); // Vrací cachovaná data
// ... 30 sekund později ...
const stale = getCachedResponse('/api/users'); // Vrací null (expirováno)

// Periodické čištění
setInterval(() => {
  const cleaned = cleanExpiredEntries();
  console.log(`Vyčištěno ${cleaned} expirovaných cache záznamů`);
}, 60000);
```

## Shrnutí

**Klíčové poznatky:**

- **ETS je rychlé, in-memory key-value úložiště** — Inspirováno bitvami prověřenými ETS tabulkami Erlangu
- **Přímý přístup, bez message passing** — Rychlejší než GenServer pro jednoduché vyhledávání
- **Čtyři typy tabulek** — `set`, `ordered_set`, `bag`, `duplicate_bag` (pokryto v další kapitole)
- **Bohaté query API** — Filtrování s predikáty, match s glob patterny, reduce přes záznamy
- **Atomické čítače** — `updateCounter()` pro bezpečné inkrement/dekrement operace
- **Typově bezpečné** — Plné TypeScript generiky pro klíče a hodnoty

**Kdy použít ETS:**

| Případ použití | Proč ETS |
|----------------|----------|
| Session cache | Rychlé vyhledávání, jednoduchý key-value |
| Feature flags | Read-heavy, zřídka se mění |
| Rate limiting buckets | Operace s čítači |
| Lookup tabulky | Statická data, rychlý přístup |
| Dočasné úložiště | Zpracovací buffery |

**Zapamatujte si:**

> ETS je pro **ukládání dat**. GenServer je pro **data + chování**. Pokud váš stav potřebuje logiku nad rámec CRUD, použijte GenServer.

---

Další: [Typy tabulek](./02-typy-tabulek.md)
