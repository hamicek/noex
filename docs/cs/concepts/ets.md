# ETS (Erlang Term Storage)

ETS poskytuje in-memory key-value store inspirovaný Erlang modulem ETS. Na rozdíl od Registry, které mapuje jména na reference procesů, ETS ukládá libovolná typovaná data bez vazby na procesy. Podporuje více typů tabulek s různou sémantikou klíčů/hodnot, pattern matching, atomické countery a volitelnou persistenci.

## Přehled

Systém ETS nabízí:
- **Čtyři typy tabulek** - set, ordered_set, bag, duplicate_bag
- **Typovaný storage** - Plná generická `<K, V>` typová bezpečnost
- **Pattern matching** - Glob vzory na klíčích, predikátové filtrování
- **Counter operace** - Atomický inkrement/dekrement numerických hodnot
- **Ordered navigace** - first/last/next/prev procházení pro ordered_set
- **Volitelná persistence** - Debounced zápisy přes StorageAdapter s obnovou při startu
- **Jednoduchý lifecycle** - start/close bez procesové režie

```typescript
import { Ets } from 'noex';

// Vytvoření a spuštění typované tabulky
const users = Ets.new<string, { name: string; age: number }>({
  name: 'users',
  type: 'set',
});
await users.start();

// CRUD operace
users.insert('u1', { name: 'Alice', age: 30 });
users.insert('u2', { name: 'Bob', age: 25 });

const alice = users.lookup('u1');         // { name: 'Alice', age: 30 }
const adults = users.select((_, u) => u.age >= 18);
const total = users.reduce((sum, _, u) => sum + u.age, 0);

await users.close();
```

## Typy tabulek

ETS podporuje čtyři typy tabulek, každý s jinou sémantikou klíčů a hodnot:

### set (výchozí)

Každý klíč mapuje na přesně jednu hodnotu. Vložení s existujícím klíčem přepíše předchozí hodnotu.

```typescript
const cache = Ets.new<string, Response>({ type: 'set' });
await cache.start();

cache.insert('api:/users', response1);
cache.insert('api:/users', response2); // přepíše response1
cache.lookup('api:/users');            // response2
```

**Interní struktura:** `Map<K, V>` — O(1) insert, lookup, delete.

### ordered_set

Jako `set`, ale klíče jsou udržovány v seřazeném pořadí. Podporuje navigaci pomocí `first()`, `last()`, `next()`, `prev()`.

```typescript
const leaderboard = Ets.new<number, string>({
  type: 'ordered_set',
});
await leaderboard.start();

leaderboard.insert(250, 'Alice');
leaderboard.insert(100, 'Bob');
leaderboard.insert(180, 'Charlie');

leaderboard.keys();    // [100, 180, 250] — seřazené
leaderboard.first();   // { key: 100, value: 'Bob' }
leaderboard.last();    // { key: 250, value: 'Alice' }
leaderboard.next(100); // { key: 180, value: 'Charlie' }
```

**Interní struktura:** Seřazené pole s binárním vyhledáváním — O(log n) lookup, O(n) insert/delete.

**Vlastní komparátor:**
```typescript
const byDate = Ets.new<Date, string>({
  type: 'ordered_set',
  keyComparator: (a, b) => a.getTime() - b.getTime(),
});
```

### bag

Duplicitní klíče jsou povoleny, ale každý pár {klíč, hodnota} musí být unikátní. Vhodné pro tagování a kategorizaci.

```typescript
const tags = Ets.new<string, string>({ type: 'bag' });
await tags.start();

tags.insert('post:1', 'typescript');
tags.insert('post:1', 'ets');
tags.insert('post:1', 'typescript'); // ignorováno — duplicitní {klíč, hodnota}

tags.lookup('post:1'); // ['typescript', 'ets']
tags.deleteObject('post:1', 'ets'); // odstraní pouze 'ets'
```

**Interní struktura:** `Map<K, V[]>` s kontrolou rovnosti při insertu.

### duplicate_bag

Jako `bag`, ale povoluje plně duplicitní páry {klíč, hodnota}. Vhodné pro event logy nebo časové řady.

```typescript
const events = Ets.new<string, { ts: number; data: string }>({
  type: 'duplicate_bag',
});
await events.start();

events.insert('clicks', { ts: 1000, data: 'btn-a' });
events.insert('clicks', { ts: 1000, data: 'btn-a' }); // povoleno — duplicity OK

events.lookup('clicks'); // oba záznamy vráceny
```

**Interní struktura:** `Map<K, V[]>` bez deduplikace.

## Pattern matching

### select()

Filtruje záznamy pomocí predikátové funkce:

```typescript
const expensive = products.select((_, p) => p.price > 100);
const active = users.select((_, u) => u.lastSeen > Date.now() - 3600000);
```

### match()

Matching klíčů pomocí glob vzorů s volitelným value predikátem:

```typescript
// Všechny user klíče
const allUsers = table.match('user:*');

// Uživatelé v konkrétním regionu s filtrací věku
const filtered = table.match('user:eu:*', (_, u) => u.age >= 18);
```

Glob syntaxe:
- `*` — libovolné znaky kromě `/`
- `**` — libovolné znaky včetně `/`
- `?` — jeden znak

### reduce()

Fold přes všechny záznamy:

```typescript
const stats = metrics.reduce(
  (acc, key, value) => ({
    total: acc.total + value,
    count: acc.count + 1,
  }),
  { total: 0, count: 0 },
);
```

## Counter operace

Pro `set`/`ordered_set` tabulky s numerickými hodnotami `updateCounter()` poskytuje atomický inkrement/dekrement:

```typescript
const counters = Ets.new<string, number>({ name: 'app-counters' });
await counters.start();

counters.updateCounter('requests', 1);   // 1
counters.updateCounter('requests', 1);   // 2
counters.updateCounter('errors', 1);     // 1
counters.updateCounter('requests', -1);  // 1

// Neexistující klíče jsou inicializovány na hodnotu inkrementu
counters.updateCounter('new-metric', 5); // 5
```

## Persistence

ETS tabulky mohou volitelně persistovat svůj stav pomocí stejného rozhraní `StorageAdapter` jako Registry. Persistence je řízena změnami s konfigurovatelným debouncingem.

```typescript
import { Ets } from 'noex';
import { FileAdapter } from 'noex/persistence';

const table = Ets.new<string, number>({
  name: 'persistent-counters',
  persistence: {
    adapter: new FileAdapter({ dir: './data' }),
    debounceMs: 200,         // seskupování rychlých změn
    restoreOnStart: true,    // načtení předchozího stavu
    persistOnShutdown: true, // zápis při close()
    onError: (err) => console.error('Persistence selhala:', err),
  },
});

await table.start();  // obnoví předchozí stav, pokud existuje
table.updateCounter('hits', 1);
await table.close();  // persistuje finální stav
```

**Chování persistence:**
- `restoreOnStart` — při `start()` načte záznamy ze storage (výchozí: `true`)
- `persistOnChange` — naplánuje debounced zápis po každé mutaci (výchozí: `true`)
- `debounceMs` — okno pro seskupování rychlých změn (výchozí: `100`)
- `persistOnShutdown` — zapíše stav při `close()` (výchozí: `true`)
- Chyby jsou non-fatální — tabulka pokračuje v in-memory provozu

## Příklady použití

### Caching

```typescript
const cache = Ets.new<string, { data: unknown; expiresAt: number }>({
  name: 'api-cache',
  type: 'set',
});
await cache.start();

cache.insert('/users/1', { data: userData, expiresAt: Date.now() + 60000 });

// Vyřazení expirovaných záznamů
const expired = cache.select((_, entry) => entry.expiresAt < Date.now());
for (const { key } of expired) cache.delete(key);
```

### Sběr metrik

```typescript
const metrics = Ets.new<string, number>({ name: 'metrics' });
await metrics.start();

metrics.updateCounter('http.requests.total', 1);
metrics.updateCounter('http.requests.errors', 1);
metrics.updateCounter('http.requests.total', 1);

// Dotaz na všechny HTTP metriky
const httpMetrics = metrics.match('http.*');
```

### Řazený leaderboard

```typescript
const scores = Ets.new<number, { player: string; timestamp: number }>({
  name: 'leaderboard',
  type: 'ordered_set',
});
await scores.start();

scores.insert(1500, { player: 'Alice', timestamp: Date.now() });
scores.insert(2100, { player: 'Bob', timestamp: Date.now() });

const topPlayer = scores.last();  // nejvyšší skóre
const bottomPlayer = scores.first(); // nejnižší skóre
```

### Event tagging

```typescript
const tags = Ets.new<string, string>({ name: 'tags', type: 'bag' });
await tags.start();

tags.insert('post:42', 'javascript');
tags.insert('post:42', 'tutorial');
tags.insert('post:99', 'javascript');

// Všechny příspěvky tagované 'javascript'
const jsPosts = tags.select((_, tag) => tag === 'javascript');
```

## ETS vs Registry

| Vlastnost | ETS | Registry |
|-----------|-----|----------|
| Ukládá | Libovolná typovaná data | Reference procesů |
| Vázáno na procesy | Ne | Ano (auto-úklid při terminaci) |
| Sémantika klíčů | set, ordered_set, bag, duplicate_bag | unique, duplicate |
| Navigace | first/last/next/prev | Ne |
| Counter operace | updateCounter | Ne |
| Pattern matching | Glob + predikát | Glob + predikát |
| Persistence | Volitelná | Volitelná |
| Lifecycle | start/close | start/close |

**Kdy použít ETS:** Stav aplikace, cache, metriky, konfigurace, jakákoli data nevázaná na lifecycle procesu.

**Kdy použít Registry:** Service discovery, vyhledávání pojmenovaných procesů, pub/sub dispatch do procesů.

## Srovnání s Elixirem

| Elixir ETS | noex ETS |
|------------|----------|
| `:ets.new(:table, [:set])` | `Ets.new({ name: 'table', type: 'set' })` |
| `:ets.insert(tab, {key, val})` | `table.insert(key, val)` |
| `:ets.lookup(tab, key)` | `table.lookup(key)` |
| `:ets.delete(tab, key)` | `table.delete(key)` |
| `:ets.member(tab, key)` | `table.member(key)` |
| `:ets.tab2list(tab)` | `table.toArray()` |
| `:ets.select(tab, matchSpec)` | `table.select(predicate)` |
| `:ets.update_counter(tab, key, inc)` | `table.updateCounter(key, inc)` |
| `:ets.first(tab)` | `table.first()` |
| `:ets.last(tab)` | `table.last()` |
| `:ets.next(tab, key)` | `table.next(key)` |
| `:ets.prev(tab, key)` | `table.prev(key)` |
| `:ets.info(tab)` | `table.info()` |
| DETS (disk-based) | volba `persistence` |

**Klíčové rozdíly oproti Elixir ETS:**
- Typově bezpečné generiky (`<K, V>`) místo tuplů
- `lookup()` vrací hodnotu přímo, ne seznam tuplů
- `select()` používá predikátové funkce místo match specifications
- Persistence je vestavěná přes `StorageAdapter` (nahrazuje use case DETS)
- Žádný ownership model — tabulky nejsou vázány na proces

## Související

- [ETS API Reference](../api/ets.md) - Kompletní reference metod
- [Registry koncepty](./registry.md) - Vyhledávání procesů podle jmen
- [Srovnání s Elixirem](./elixir-comparison.md) - Celkové srovnání s OTP
