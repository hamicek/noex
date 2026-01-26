# Cache

V předchozí kapitole jste se naučili vysílat události pomocí EventBusu. Nyní se podíváme na další běžnou potřebu: **cachování drahých výpočtů nebo externích API volání**. noex poskytuje vestavěnou službu Cache, která kombinuje LRU eviction, TTL expiraci a statistiky hit/miss — vše postavené na známých základech GenServeru.

## Co se naučíte

- Jak Cache poskytuje thread-safe cachování s automatickou správou paměti
- Konfigurovat LRU (Least Recently Used) eviction pro omezení využití paměti
- Používat TTL (Time-To-Live) pro automatickou expiraci zastaralých dat
- Využívat atomické `getOrSet` pro zamezení cache stampede
- Monitorovat výkon cache pomocí vestavěných statistik

## Proč používat Cache?

Cachování zlepšuje výkon ukládáním výsledků drahých operací:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       BEZ CACHE VS S CACHE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BEZ CACHE:                              S CACHE:                           │
│                                                                             │
│  Request 1 ──► Databáze ──► 200ms        Request 1 ──► Databáze ──► 200ms  │
│  Request 2 ──► Databáze ──► 200ms        Request 2 ──► Cache ──────► 1ms   │
│  Request 3 ──► Databáze ──► 200ms        Request 3 ──► Cache ──────► 1ms   │
│  Request 4 ──► Databáze ──► 200ms        Request 4 ──► Cache ──────► 1ms   │
│  ─────────────────────────────           ─────────────────────────────      │
│  Celkem: 800ms                           Celkem: 203ms                      │
│                                                                             │
│  Každý request zasáhne pomalý zdroj      První request naplní cache,       │
│                                          následující jsou okamžité          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Použijte Cache když:**
- Databázové dotazy jsou pomalé nebo drahé
- Externí API volání mají rate limity nebo latenci
- Výpočty jsou CPU-intenzivní, ale výsledky se mění zřídka
- Stejná data jsou požadována často

**Nepoužívejte Cache když:**
- Data musí být vždy čerstvá (real-time ceny akcií)
- Každý request potřebuje unikátní data (user-specific výpočty)
- Paměť je extrémně omezená

## Spuštění Cache

Cache je pod kapotou GenServer. Každá instance cache je nezávislá:

```typescript
import { Cache } from '@hamicek/noex';

// Spuštění s výchozím nastavením (bez limitu velikosti, bez TTL)
const cache = await Cache.start();

// Spuštění s konfigurací
const configuredCache = await Cache.start({
  maxSize: 1000,        // Maximální počet záznamů před LRU eviction
  defaultTtlMs: 60000,  // Výchozí TTL: 1 minuta
  name: 'api-cache',    // Volitelné: registrace v process registry
});

// Kontrola, zda běží
console.log(Cache.isRunning(cache)); // true

// Úklid při ukončení
await Cache.stop(cache);
```

### Konfigurační možnosti

| Možnost | Typ | Výchozí | Popis |
|---------|-----|---------|-------|
| `maxSize` | `number` | `Infinity` | Maximální počet záznamů před LRU eviction |
| `defaultTtlMs` | `number \| null` | `null` | Výchozí TTL pro záznamy (null = bez expirace) |
| `name` | `string` | — | Volitelné jméno pro registraci v registry |

## Základní operace

### Set a Get

```typescript
const cache = await Cache.start();

// Uložení hodnoty
await Cache.set(cache, 'user:123', { name: 'Alice', email: 'alice@example.com' });

// Načtení hodnoty
const user = await Cache.get(cache, 'user:123');
console.log(user); // { name: 'Alice', email: 'alice@example.com' }

// Neexistující klíč vrací undefined
const missing = await Cache.get(cache, 'user:999');
console.log(missing); // undefined
```

### Type-Safe přístup

Použijte TypeScript generika pro typované hodnoty:

```typescript
interface User {
  id: string;
  name: string;
  email: string;
}

// Typ je odvozen z hodnoty
await Cache.set(cache, 'user:123', { id: '123', name: 'Alice', email: 'alice@example.com' });

// Explicitně typujte návratovou hodnotu
const user = await Cache.get<User>(cache, 'user:123');
if (user) {
  console.log(user.name); // TypeScript ví, že toto je string
}
```

### Check, Delete, Clear

```typescript
// Kontrola, zda klíč existuje (a není expirovaný)
const exists = await Cache.has(cache, 'user:123');
console.log(exists); // true

// Smazání konkrétního klíče
const deleted = await Cache.delete(cache, 'user:123');
console.log(deleted); // true (byl smazán), false (neexistoval)

// Vymazání všech záznamů a reset statistik
await Cache.clear(cache);
```

### Seznam klíčů a velikost

```typescript
await Cache.set(cache, 'a', 1);
await Cache.set(cache, 'b', 2);
await Cache.set(cache, 'c', 3);

// Počet záznamů (vyjma expirovaných)
const count = await Cache.size(cache);
console.log(count); // 3

// Všechny klíče (vyjma expirovaných)
const keys = await Cache.keys(cache);
console.log(keys); // ['a', 'b', 'c']
```

## TTL (Time-To-Live)

TTL automaticky expiruje záznamy po zadané době:

```typescript
const cache = await Cache.start();

// Nastavení s explicitním TTL (5 sekund)
await Cache.set(cache, 'session:abc', { userId: '123' }, { ttlMs: 5000 });

// Hodnota existuje okamžitě
console.log(await Cache.get(cache, 'session:abc')); // { userId: '123' }

// Po 5 sekundách hodnota expiruje
await new Promise(r => setTimeout(r, 5100));
console.log(await Cache.get(cache, 'session:abc')); // undefined
```

### Výchozí TTL vs explicitní TTL

```typescript
// Cache s 1minutovým výchozím TTL
const cache = await Cache.start({ defaultTtlMs: 60000 });

// Použije výchozí TTL (1 minuta)
await Cache.set(cache, 'key1', 'value1');

// Přepíše s explicitním TTL (10 sekund)
await Cache.set(cache, 'key2', 'value2', { ttlMs: 10000 });

// Přepíše bez expirace (null)
await Cache.set(cache, 'key3', 'value3', { ttlMs: null });
```

### Průvodce volbou TTL

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PRŮVODCE KONFIGURACÍ TTL                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Typ dat                │ Doporučené TTL      │ Důvod                       │
│  ───────────────────────┼─────────────────────┼───────────────────────────  │
│  Uživatelská session    │ 30 min - 24 hodin   │ Balance bezpečnost + UX     │
│  API odpověď            │ 1 - 5 minut         │ API se často aktualizuje    │
│  Databázový dotaz       │ 5 - 60 sekund       │ Konzistence dat             │
│  Statická konfigurace   │ null (bez expirace) │ Mění se zřídka              │
│  Feature flags          │ 30 - 300 sekund     │ Umožňuje rychlý rollback    │
│  Rate limit čítače      │ Velikost okna       │ Odpovídá rate limit oknu    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## LRU Eviction

Když je nastaven `maxSize`, Cache automaticky odstraňuje **nejméně nedávno použité** záznamy pro uvolnění místa novým:

```typescript
const cache = await Cache.start({ maxSize: 3 });

await Cache.set(cache, 'a', 1);  // Cache: [a]
await Cache.set(cache, 'b', 2);  // Cache: [a, b]
await Cache.set(cache, 'c', 3);  // Cache: [a, b, c] - plná

// Přístup k 'a' ho označí jako nedávno použitý
await Cache.get(cache, 'a');     // Cache: [b, c, a] - 'a' je nyní nejnovější

// Přidání 'd' - musíme něco odstranit
await Cache.set(cache, 'd', 4);  // Cache: [c, a, d] - 'b' odstraněn (nejméně nedávný)

console.log(await Cache.get(cache, 'a')); // 1 - stále existuje
console.log(await Cache.get(cache, 'b')); // undefined - odstraněn
console.log(await Cache.get(cache, 'c')); // 3 - stále existuje
console.log(await Cache.get(cache, 'd')); // 4 - právě přidán
```

### Jak LRU funguje

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          PROCES LRU EVICTION                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  maxSize = 3                                                                │
│                                                                             │
│  Krok 1: set('a', 1)                                                        │
│  ┌───┐                                                                      │
│  │ a │  ◄── nejnovější                                                      │
│  └───┘                                                                      │
│                                                                             │
│  Krok 2: set('b', 2)                                                        │
│  ┌───┬───┐                                                                  │
│  │ a │ b │  ◄── nejnovější                                                  │
│  └───┴───┘                                                                  │
│                                                                             │
│  Krok 3: set('c', 3)                                                        │
│  ┌───┬───┬───┐                                                              │
│  │ a │ b │ c │  ◄── nejnovější (cache plná)                                 │
│  └───┴───┴───┘                                                              │
│    ▲                                                                        │
│    └── nejstarší (bude odstraněn příště)                                    │
│                                                                             │
│  Krok 4: get('a')  ──► 'a' se přesune na nejnovější pozici                  │
│  ┌───┬───┬───┐                                                              │
│  │ b │ c │ a │  ◄── 'a' nyní nejnovější                                     │
│  └───┴───┴───┘                                                              │
│    ▲                                                                        │
│    └── 'b' nyní nejstarší                                                   │
│                                                                             │
│  Krok 5: set('d', 4)  ──► odstranit 'b', přidat 'd'                         │
│  ┌───┬───┬───┐                                                              │
│  │ c │ a │ d │  ◄── nejnovější                                              │
│  └───┴───┴───┘                                                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Priorita eviction: Nejdříve expirované

Při eviction Cache nejprve odstraňuje **expirované záznamy**, pak padá zpět na LRU:

```typescript
const cache = await Cache.start({ maxSize: 3 });

// Záznam 'a' expiruje za 100ms
await Cache.set(cache, 'a', 1, { ttlMs: 100 });
await Cache.set(cache, 'b', 2);
await Cache.set(cache, 'c', 3);

// Počkat na expiraci 'a'
await new Promise(r => setTimeout(r, 150));

// Přidat 'd' - Cache nejprve odstraní expirovaný 'a', ne LRU 'b'
await Cache.set(cache, 'd', 4);

console.log(await Cache.get(cache, 'a')); // undefined - expirován
console.log(await Cache.get(cache, 'b')); // 2 - stále existuje!
console.log(await Cache.get(cache, 'c')); // 3
console.log(await Cache.get(cache, 'd')); // 4
```

### Volba maxSize

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        DOPORUČENÍ PRO MAXSIZE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Velikost záznamu  │ Doporučená maxSize │ Přibližná paměť                   │
│  ──────────────────┼────────────────────┼───────────────────────────────    │
│  Malá (~100 B)     │ 10 000 - 100 000   │ 1-10 MB                           │
│  Střední (~1 KB)   │ 1 000 - 10 000     │ 1-10 MB                           │
│  Velká (~10 KB)    │ 100 - 1 000        │ 1-10 MB                           │
│  Obrovská (~100 KB)│ 10 - 100           │ 1-10 MB                           │
│                                                                             │
│  Pravidlo: odhadněte (velikost_záznamu * maxSize) pro odhad paměti          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Atomické getOrSet

Operace `getOrSet` atomicky kontroluje cachovanou hodnotu a vypočítá ji, pokud chybí — zabraňuje problému "cache stampede":

```typescript
const cache = await Cache.start({ defaultTtlMs: 60000 });

// Drahý databázový dotaz
async function fetchUser(id: string) {
  console.log(`Načítám uživatele ${id} z databáze...`);
  // Simulace pomalé databáze
  await new Promise(r => setTimeout(r, 200));
  return { id, name: 'Alice', email: 'alice@example.com' };
}

// První volání: vypočítá a uloží do cache
const user1 = await Cache.getOrSet(cache, 'user:123', () => fetchUser('123'));
// Výstup: "Načítám uživatele 123 z databáze..."

// Druhé volání: vrátí cachovanou hodnotu (factory není voláno)
const user2 = await Cache.getOrSet(cache, 'user:123', () => fetchUser('123'));
// Žádný výstup - cache hit!

console.log(user1 === user2); // true - stejná cachovaná reference
```

### Custom TTL pro getOrSet

```typescript
// Cache API odpovědí na 30 sekund
const response = await Cache.getOrSet(
  cache,
  `api:weather:${city}`,
  async () => {
    const res = await fetch(`https://api.weather.com/${city}`);
    return res.json();
  },
  { ttlMs: 30000 }
);
```

### Zamezení cache stampede

Bez atomického getOrSet mohou souběžné requesty všechny současně minout cache:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PROBLÉM CACHE STAMPEDE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BEZ getOrSet (cache stampede):                                             │
│                                                                             │
│  Request 1 ──► has('key')? NE ──► compute() ──► set('key') ─┐              │
│  Request 2 ──► has('key')? NE ──► compute() ──► set('key') ─┤ Všechny do DB│
│  Request 3 ──► has('key')? NE ──► compute() ──► set('key') ─┘              │
│                                                                             │
│  S getOrSet (chráněno):                                                     │
│                                                                             │
│  Request 1 ──► getOrSet('key', compute) ──► compute() ──┐                  │
│  Request 2 ──► getOrSet('key', compute) ──► cache hit! ─┤ Jen 1 DB volání  │
│  Request 3 ──► getOrSet('key', compute) ──► cache hit! ─┘                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Statistiky cache

Monitorujte výkon cache pomocí vestavěných statistik:

```typescript
const cache = await Cache.start({ maxSize: 1000 });

// Nějaké operace
await Cache.set(cache, 'a', 1);
await Cache.set(cache, 'b', 2);
await Cache.get(cache, 'a');     // hit
await Cache.get(cache, 'a');     // hit
await Cache.get(cache, 'c');     // miss
await Cache.get(cache, 'd');     // miss

const stats = await Cache.stats(cache);
console.log(stats);
// {
//   size: 2,           // Aktuální počet záznamů
//   maxSize: 1000,     // Maximální povolený počet záznamů
//   hits: 2,           // Úspěšná čtení z cache
//   misses: 2,         // Cache misses
//   hitRate: 0.5       // hits / (hits + misses)
// }
```

### Použití statistik pro monitoring

```typescript
// Periodický monitoring
setInterval(async () => {
  const stats = await Cache.stats(cache);

  // Alert při nízkém hit rate
  if (stats.hitRate < 0.7 && stats.hits + stats.misses > 100) {
    console.warn(`Nízký cache hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
  }

  // Alert při vysokém využití
  const utilization = stats.size / stats.maxSize;
  if (utilization > 0.9) {
    console.warn(`Cache téměř plná: ${(utilization * 100).toFixed(1)}%`);
  }

  console.log(`Cache: ${stats.size}/${stats.maxSize} záznamů, ${(stats.hitRate * 100).toFixed(1)}% hit rate`);
}, 60000);
```

### Interpretace hit rate

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        INTERPRETACE HIT RATE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Hit Rate  │ Status    │ Pravděpodobná příčina a akce                       │
│  ──────────┼───────────┼────────────────────────────────────────────────    │
│  > 90%     │ Výborný   │ Cache funguje optimálně                            │
│  70-90%    │ Dobrý     │ Normální pro smíšené workloady                      │
│  50-70%    │ Průměrný  │ Zvažte zvýšení maxSize nebo TTL                    │
│  < 50%     │ Špatný    │ Cache příliš malá, TTL příliš krátké, nebo data    │
│                                                                             │
│  Poznámka: Na začátku životnosti aplikace bude hit rate nízký (cold cache)  │
│            Počkejte na ustálený stav před rozhodnutím o ladění              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Úklid na pozadí

Metoda `prune()` odstraňuje expirované záznamy bez čekání na eviction:

```typescript
// Fire-and-forget úklid
Cache.prune(cache);

// Užitečné pro periodickou údržbu
setInterval(() => {
  Cache.prune(cache);
}, 60000); // Úklid každou minutu
```

Toto je `cast` operace (neblokující) — cache pokračuje v obsluze requestů během prune.

## Praktický příklad: Cache API odpovědí

Zde je produkčně připravená vrstva pro cachování API:

```typescript
import { Cache, type CacheRef } from '@hamicek/noex';

interface ApiCacheConfig {
  maxSize: number;
  defaultTtlMs: number;
  name?: string;
}

interface FetchOptions {
  ttlMs?: number;
  force?: boolean;  // Obejít cache
}

function createApiCache(config: ApiCacheConfig) {
  let cache: CacheRef;
  let requestCount = 0;
  let cacheHits = 0;

  return {
    async start() {
      cache = await Cache.start(config);

      // Periodický úklid
      setInterval(() => Cache.prune(cache), 60000);
    },

    async fetch<T>(url: string, options: FetchOptions = {}): Promise<T> {
      requestCount++;

      // Obejít cache pokud je vynuceno
      if (options.force) {
        const data = await this.doFetch<T>(url);
        await Cache.set(cache, url, data, { ttlMs: options.ttlMs });
        return data;
      }

      // Použít getOrSet pro automatické cachování
      const cached = await Cache.get<T>(cache, url);
      if (cached !== undefined) {
        cacheHits++;
        return cached;
      }

      const data = await this.doFetch<T>(url);
      await Cache.set(cache, url, data, { ttlMs: options.ttlMs });
      return data;
    },

    async doFetch<T>(url: string): Promise<T> {
      console.log(`[API] Načítám: ${url}`);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response.json() as Promise<T>;
    },

    async invalidate(urlPattern: string) {
      const keys = await Cache.keys(cache);
      for (const key of keys) {
        if (key.includes(urlPattern)) {
          await Cache.delete(cache, key);
        }
      }
    },

    async getMetrics() {
      const stats = await Cache.stats(cache);
      return {
        ...stats,
        totalRequests: requestCount,
        applicationHitRate: requestCount > 0 ? cacheHits / requestCount : 0,
      };
    },

    async stop() {
      await Cache.stop(cache);
    },
  };
}

// Použití
async function main() {
  const apiCache = createApiCache({
    maxSize: 500,
    defaultTtlMs: 30000,  // 30 sekund výchozí
    name: 'api-cache',
  });

  await apiCache.start();

  interface User {
    id: number;
    name: string;
    email: string;
  }

  // První request - načte z API
  const user1 = await apiCache.fetch<User>(
    'https://jsonplaceholder.typicode.com/users/1'
  );
  console.log('Uživatel:', user1.name);

  // Druhý request - cache hit
  const user2 = await apiCache.fetch<User>(
    'https://jsonplaceholder.typicode.com/users/1'
  );
  console.log('Uživatel (cached):', user2.name);

  // Vynutit refresh
  const user3 = await apiCache.fetch<User>(
    'https://jsonplaceholder.typicode.com/users/1',
    { force: true }
  );
  console.log('Uživatel (refreshed):', user3.name);

  // Zkontrolovat metriky
  const metrics = await apiCache.getMetrics();
  console.log('Metriky:', metrics);

  await apiCache.stop();
}

main();
```

## Cache vs ostatní úložiště

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     CACHE VS ETS VS DATABÁZE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Vlastnost        │ Cache          │ ETS             │ Databáze             │
│  ─────────────────┼────────────────┼─────────────────┼──────────────────    │
│  Vzor přístupu    │ key-value      │ key-value/query │ komplexní dotazy     │
│  Podpora TTL      │ vestavěná      │ manuální        │ manuální             │
│  LRU eviction     │ vestavěná      │ manuální        │ N/A                  │
│  Hit/miss stats   │ vestavěné      │ manuální        │ N/A                  │
│  Thread safety    │ GenServer      │ vestavěné       │ externí              │
│  Persistence      │ žádná          │ žádná           │ trvalá               │
│  Limit paměti     │ maxSize        │ neomezeno       │ disk-based           │
│                                                                             │
│  Nejlepší pro:                                                              │
│  - Cache: dočasná data s automatickou expirací                              │
│  - ETS: rychlé lookup tabulky, čítače, indexy                               │
│  - Databáze: permanentní data, komplexní dotazy, transakce                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Cvičení: Multi-Tier Cache

Vytvořte dvouúrovňový systém cache kde:
1. L1 cache je malá a rychlá (maxSize: 100, TTL: 10s)
2. L2 cache je větší a pomalejší (maxSize: 1000, TTL: 60s)
3. Při L1 miss zkontrolovat L2 před přístupem k datovému zdroji
4. Sledovat hit rates pro obě úrovně

**Výchozí kód:**

```typescript
import { Cache, type CacheRef } from '@hamicek/noex';

interface TieredCacheStats {
  l1Hits: number;
  l2Hits: number;
  misses: number;
  l1HitRate: number;
  l2HitRate: number;
  totalHitRate: number;
}

function createTieredCache() {
  let l1: CacheRef;
  let l2: CacheRef;
  let l1Hits = 0;
  let l2Hits = 0;
  let misses = 0;

  return {
    async start() {
      // TODO: Spustit L1 cache (malá, krátké TTL)
      // TODO: Spustit L2 cache (větší, delší TTL)
    },

    async get<T>(key: string): Promise<T | undefined> {
      // TODO: Nejdříve zkontrolovat L1
      // TODO: Při L1 miss zkontrolovat L2
      // TODO: Při L2 hit povýšit do L1
      // TODO: Sledovat hit statistiky
      return undefined;
    },

    async set<T>(key: string, value: T): Promise<void> {
      // TODO: Zapsat do obou cache
    },

    async getOrSet<T>(key: string, factory: () => Promise<T>): Promise<T> {
      // TODO: Implementovat se správnou kontrolou úrovní
      return {} as T;
    },

    getStats(): TieredCacheStats {
      // TODO: Vypočítat a vrátit statistiky
      return {
        l1Hits,
        l2Hits,
        misses,
        l1HitRate: 0,
        l2HitRate: 0,
        totalHitRate: 0,
      };
    },

    async stop() {
      // TODO: Zastavit obě cache
    },
  };
}
```

<details>
<summary><strong>Řešení</strong></summary>

```typescript
import { Cache, type CacheRef } from '@hamicek/noex';

interface TieredCacheStats {
  l1Hits: number;
  l2Hits: number;
  misses: number;
  l1HitRate: number;
  l2HitRate: number;
  totalHitRate: number;
}

function createTieredCache() {
  let l1: CacheRef;
  let l2: CacheRef;
  let l1Hits = 0;
  let l2Hits = 0;
  let misses = 0;

  return {
    async start() {
      // L1: Malá, rychlá, krátkodobá
      l1 = await Cache.start({
        maxSize: 100,
        defaultTtlMs: 10000,  // 10 sekund
        name: 'l1-cache',
      });

      // L2: Větší, pomalejší, dlouhodobější
      l2 = await Cache.start({
        maxSize: 1000,
        defaultTtlMs: 60000,  // 60 sekund
        name: 'l2-cache',
      });
    },

    async get<T>(key: string): Promise<T | undefined> {
      // Nejdříve zkontrolovat L1
      const l1Value = await Cache.get<T>(l1, key);
      if (l1Value !== undefined) {
        l1Hits++;
        return l1Value;
      }

      // L1 miss - zkontrolovat L2
      const l2Value = await Cache.get<T>(l2, key);
      if (l2Value !== undefined) {
        l2Hits++;
        // Povýšit do L1 pro rychlejší budoucí přístup
        await Cache.set(l1, key, l2Value);
        return l2Value;
      }

      // Obě minuly
      misses++;
      return undefined;
    },

    async set<T>(key: string, value: T): Promise<void> {
      // Zapsat do obou cache
      await Promise.all([
        Cache.set(l1, key, value),
        Cache.set(l2, key, value),
      ]);
    },

    async getOrSet<T>(key: string, factory: () => Promise<T>): Promise<T> {
      // Zkontrolovat L1
      const l1Value = await Cache.get<T>(l1, key);
      if (l1Value !== undefined) {
        l1Hits++;
        return l1Value;
      }

      // Zkontrolovat L2
      const l2Value = await Cache.get<T>(l2, key);
      if (l2Value !== undefined) {
        l2Hits++;
        // Povýšit do L1
        await Cache.set(l1, key, l2Value);
        return l2Value;
      }

      // Obě minuly - vypočítat hodnotu
      misses++;
      const value = await factory();

      // Uložit do obou cache
      await Promise.all([
        Cache.set(l1, key, value),
        Cache.set(l2, key, value),
      ]);

      return value;
    },

    getStats(): TieredCacheStats {
      const total = l1Hits + l2Hits + misses;
      return {
        l1Hits,
        l2Hits,
        misses,
        l1HitRate: total > 0 ? l1Hits / total : 0,
        l2HitRate: total > 0 ? l2Hits / total : 0,
        totalHitRate: total > 0 ? (l1Hits + l2Hits) / total : 0,
      };
    },

    async stop() {
      await Promise.all([
        Cache.stop(l1),
        Cache.stop(l2),
      ]);
    },
  };
}

// Test tiered cache
async function main() {
  const cache = createTieredCache();
  await cache.start();

  // Simulace databázového fetche
  async function fetchFromDb(id: string) {
    console.log(`[DB] Načítám ${id}...`);
    await new Promise(r => setTimeout(r, 100));
    return { id, data: `Data pro ${id}` };
  }

  // První request - obě cache miss, zasáhne databázi
  console.log('Request 1:');
  const data1 = await cache.getOrSet('item:1', () => fetchFromDb('item:1'));
  console.log('Výsledek:', data1);
  console.log('Statistiky:', cache.getStats());

  // Druhý request - L1 hit
  console.log('\nRequest 2 (stejný klíč):');
  const data2 = await cache.getOrSet('item:1', () => fetchFromDb('item:1'));
  console.log('Výsledek:', data2);
  console.log('Statistiky:', cache.getStats());

  // Počkat na expiraci L1 (10 sekund)
  console.log('\nČekám na expiraci L1...');
  await new Promise(r => setTimeout(r, 11000));

  // Třetí request - L1 miss, L2 hit (povýší do L1)
  console.log('\nRequest 3 (po L1 expiraci):');
  const data3 = await cache.getOrSet('item:1', () => fetchFromDb('item:1'));
  console.log('Výsledek:', data3);
  console.log('Statistiky:', cache.getStats());

  // Čtvrtý request - L1 hit znovu (byl povýšen)
  console.log('\nRequest 4:');
  const data4 = await cache.getOrSet('item:1', () => fetchFromDb('item:1'));
  console.log('Výsledek:', data4);
  console.log('Statistiky:', cache.getStats());

  await cache.stop();
}

main();
```

**Designová rozhodnutí:**

1. **L1 povýšení** — Když L2 zasáhne, zkopírujeme hodnotu do L1 pro rychlejší budoucí přístup
2. **Paralelní zápisy** — `set()` zapisuje do obou cache současně
3. **Nezávislá TTL** — L1 expiruje rychleji, udržuje horká data zatímco L2 slouží jako záloha
4. **Oddělené statistiky** — Sledujte hits na každé úrovni pro ladění

**Výstup:**
```
Request 1:
[DB] Načítám item:1...
Výsledek: { id: 'item:1', data: 'Data pro item:1' }
Statistiky: { l1Hits: 0, l2Hits: 0, misses: 1, l1HitRate: 0, l2HitRate: 0, totalHitRate: 0 }

Request 2 (stejný klíč):
Výsledek: { id: 'item:1', data: 'Data pro item:1' }
Statistiky: { l1Hits: 1, l2Hits: 0, misses: 1, l1HitRate: 0.5, l2HitRate: 0, totalHitRate: 0.5 }

Čekám na expiraci L1...

Request 3 (po L1 expiraci):
Výsledek: { id: 'item:1', data: 'Data pro item:1' }
Statistiky: { l1Hits: 1, l2Hits: 1, misses: 1, l1HitRate: 0.33, l2HitRate: 0.33, totalHitRate: 0.67 }

Request 4:
Výsledek: { id: 'item:1', data: 'Data pro item:1' }
Statistiky: { l1Hits: 2, l2Hits: 1, misses: 1, l1HitRate: 0.5, l2HitRate: 0.25, totalHitRate: 0.75 }
```

</details>

## Shrnutí

**Klíčové poznatky:**

- **Cache poskytuje in-memory cachování** — Postavena na GenServeru pro thread-safe operace
- **LRU eviction** — Automaticky odstraňuje nejméně nedávno použité záznamy při dosažení `maxSize`
- **TTL expirace** — Záznamy automaticky expirují po jejich time-to-live
- **Atomické getOrSet** — Zabraňuje cache stampede atomickým výpočtem chybějících hodnot
- **Vestavěné statistiky** — Monitorujte hit rate a využití cache

**Doporučení pro konfiguraci:**

| Scénář | maxSize | defaultTtlMs | Poznámky |
|--------|---------|--------------|----------|
| API odpovědi | 500-1000 | 30 000-60 000 | Balance čerstvost vs výkon |
| Uživatelské session | 1000-10000 | 1 800 000 | 30 min TTL typické |
| Databázové dotazy | 100-500 | 5 000-30 000 | Udržujte TTL krátké pro konzistenci |
| Statická data | 100-500 | null | Bez expirace pro config/konstanty |

**Pamatujte:**

> Cache s 0% hit rate je jen overhead. Monitorujte statistiky a laďte `maxSize`/`TTL` podle vašich vzorů přístupu. Začněte s konzervativním nastavením a zvyšujte na základě skutečného využití.

---

Další: [RateLimiter](./03-rate-limiter.md)
