# Cache API Reference

Služba `Cache` poskytuje in-memory cachovací vrstvu s TTL (time-to-live) a LRU (Least Recently Used) vytěsňováním. Postavená na GenServeru pro thread-safe operace.

## Import

```typescript
import { Cache } from 'noex';
```

## Typy

### CacheRef

Neprůhledná reference na běžící instanci Cache.

```typescript
type CacheRef = GenServerRef<CacheState, CacheCallMsg, CacheCastMsg, CacheCallReply>;
```

### CacheOptions

Volby pro `Cache.start()`.

```typescript
interface CacheOptions {
  /**
   * Maximální počet záznamů v cache.
   * Při překročení jsou vytěsněny nejméně nedávno použité záznamy.
   * @default Infinity (bez limitu)
   */
  readonly maxSize?: number;

  /**
   * Výchozí TTL v milisekundách pro záznamy bez explicitního TTL.
   * Použijte null pro žádnou výchozí expiraci.
   * @default null (bez expirace)
   */
  readonly defaultTtlMs?: number | null;

  /**
   * Volitelné jméno pro registraci v registry.
   */
  readonly name?: string;
}
```

### CacheSetOptions

Volby pro `Cache.set()`.

```typescript
interface CacheSetOptions {
  /**
   * Time-to-live v milisekundách pro tento konkrétní záznam.
   * Přepíše výchozí TTL, pokud je nastaveno.
   * Použijte null pro žádnou expiraci.
   */
  readonly ttlMs?: number | null;
}
```

### CacheStats

Statistiky cache vrácené metodou `Cache.stats()`.

```typescript
interface CacheStats {
  readonly size: number;      // Aktuální počet záznamů
  readonly maxSize: number;   // Maximální povolený počet záznamů
  readonly hits: number;      // Počet cache hitů
  readonly misses: number;    // Počet cache missů
  readonly hitRate: number;   // hits / (hits + misses), 0-1
}
```

---

## Metody

### start()

Spustí novou instanci Cache.

```typescript
async start(options?: CacheOptions): Promise<CacheRef>
```

**Parametry:**
- `options` - Volitelná konfigurace cache
  - `maxSize` - Maximální počet záznamů před LRU vytěsněním (výchozí: Infinity)
  - `defaultTtlMs` - Výchozí TTL pro záznamy (výchozí: null, bez expirace)
  - `name` - Registrovat pod tímto jménem v Registry

**Vrací:** Promise resolvující na CacheRef

**Příklad:**
```typescript
// Základní cache bez limitů
const cache = await Cache.start();

// Cache s limitem velikosti a výchozím TTL
const cache = await Cache.start({
  maxSize: 1000,
  defaultTtlMs: 60000, // 1 minuta
});

// Pojmenovaná cache pro vyhledání v registry
const cache = await Cache.start({ name: 'user-cache' });
```

---

### get()

Získá hodnotu z cache.

```typescript
async get<T>(ref: CacheRef, key: string): Promise<T | undefined>
```

**Parametry:**
- `ref` - Reference na Cache
- `key` - Klíč cache

**Vrací:** Cachovanou hodnotu nebo `undefined`, pokud nenalezeno/expirováno

**Příklad:**
```typescript
const user = await Cache.get<User>(cache, 'user:123');
if (user) {
  console.log(user.name);
}
```

---

### set()

Nastaví hodnotu v cache.

```typescript
async set<T>(
  ref: CacheRef,
  key: string,
  value: T,
  options?: CacheSetOptions,
): Promise<void>
```

**Parametry:**
- `ref` - Reference na Cache
- `key` - Klíč cache
- `value` - Hodnota k uložení
- `options` - Volitelná konfigurace nastavení
  - `ttlMs` - Přepsání TTL pro tento záznam

**Příklad:**
```typescript
// Nastavení s výchozím TTL
await Cache.set(cache, 'user:123', { name: 'John' });

// Nastavení s vlastním TTL (5 minut)
await Cache.set(cache, 'session:abc', sessionData, { ttlMs: 300000 });

// Nastavení bez expirace (přepíše výchozí TTL)
await Cache.set(cache, 'config', configData, { ttlMs: null });
```

---

### getOrSet()

Získá hodnotu z cache, nebo ji nastaví pomocí tovární funkce, pokud nenalezena.

```typescript
async getOrSet<T>(
  ref: CacheRef,
  key: string,
  factory: () => T | Promise<T>,
  options?: CacheSetOptions,
): Promise<T>
```

**Parametry:**
- `ref` - Reference na Cache
- `key` - Klíč cache
- `factory` - Funkce pro výpočet hodnoty, pokud není cachována
- `options` - Volitelná konfigurace nastavení

**Vrací:** Cachovanou nebo nově vypočítanou hodnotu

**Příklad:**
```typescript
const user = await Cache.getOrSet(cache, `user:${id}`, async () => {
  return await fetchUserFromDatabase(id);
});

// S vlastním TTL
const config = await Cache.getOrSet(
  cache,
  'app-config',
  () => loadConfig(),
  { ttlMs: 3600000 }, // 1 hodina
);
```

---

### has()

Zjistí, zda klíč existuje v cache (a není expirovaný).

```typescript
async has(ref: CacheRef, key: string): Promise<boolean>
```

**Parametry:**
- `ref` - Reference na Cache
- `key` - Klíč cache

**Vrací:** `true` pokud klíč existuje a není expirovaný

**Příklad:**
```typescript
if (await Cache.has(cache, 'user:123')) {
  console.log('Uživatel je v cache');
}
```

---

### delete()

Smaže klíč z cache.

```typescript
async delete(ref: CacheRef, key: string): Promise<boolean>
```

**Parametry:**
- `ref` - Reference na Cache
- `key` - Klíč cache

**Vrací:** `true` pokud klíč existoval

**Příklad:**
```typescript
const wasDeleted = await Cache.delete(cache, 'user:123');
```

---

### clear()

Vymaže všechny záznamy z cache. Také resetuje statistiky hitů/missů.

```typescript
async clear(ref: CacheRef): Promise<void>
```

**Parametry:**
- `ref` - Reference na Cache

**Příklad:**
```typescript
await Cache.clear(cache);
```

---

### size()

Vrací počet záznamů v cache. Expirované záznamy se nepočítají.

```typescript
async size(ref: CacheRef): Promise<number>
```

**Parametry:**
- `ref` - Reference na Cache

**Vrací:** Počet záznamů

**Příklad:**
```typescript
const count = await Cache.size(cache);
console.log(`Cache má ${count} záznamů`);
```

---

### keys()

Vrací všechny klíče v cache. Expirované záznamy nejsou zahrnuty.

```typescript
async keys(ref: CacheRef): Promise<readonly string[]>
```

**Parametry:**
- `ref` - Reference na Cache

**Vrací:** Pole klíčů

**Příklad:**
```typescript
const keys = await Cache.keys(cache);
for (const key of keys) {
  console.log(key);
}
```

---

### stats()

Vrací statistiky cache.

```typescript
async stats(ref: CacheRef): Promise<CacheStats>
```

**Parametry:**
- `ref` - Reference na Cache

**Vrací:** Objekt se statistikami cache

**Příklad:**
```typescript
const stats = await Cache.stats(cache);
console.log(`Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
console.log(`Velikost: ${stats.size}/${stats.maxSize}`);
```

---

### prune()

Spustí čištění expirovaných záznamů na pozadí. Toto je fire-and-forget operace.

```typescript
prune(ref: CacheRef): void
```

**Parametry:**
- `ref` - Reference na Cache

**Příklad:**
```typescript
// Periodicky čistit expirované záznamy
setInterval(() => {
  Cache.prune(cache);
}, 60000);
```

---

### isRunning()

Zjistí, zda Cache běží.

```typescript
isRunning(ref: CacheRef): boolean
```

**Parametry:**
- `ref` - Reference na Cache

**Vrací:** `true` pokud běží

**Příklad:**
```typescript
if (Cache.isRunning(cache)) {
  await Cache.set(cache, 'key', 'value');
}
```

---

### stop()

Gracefully zastaví Cache.

```typescript
async stop(ref: CacheRef): Promise<void>
```

**Parametry:**
- `ref` - Reference na Cache

**Příklad:**
```typescript
await Cache.stop(cache);
```

---

## Kompletní příklad

```typescript
import { Cache, type CacheStats } from 'noex';

interface User {
  id: string;
  name: string;
  email: string;
}

async function main() {
  // Vytvoření cache s limitem 1000 záznamů a 5-minutovým výchozím TTL
  const userCache = await Cache.start({
    maxSize: 1000,
    defaultTtlMs: 5 * 60 * 1000,
    name: 'users',
  });

  // Načtení uživatele s cachováním
  async function getUser(id: string): Promise<User> {
    return Cache.getOrSet(userCache, `user:${id}`, async () => {
      console.log(`Načítám uživatele ${id} z databáze...`);
      // Simulace načtení z databáze
      return { id, name: 'John Doe', email: 'john@example.com' };
    });
  }

  // První volání - cache miss
  const user1 = await getUser('123');
  console.log('Uživatel:', user1);

  // Druhé volání - cache hit
  const user2 = await getUser('123');
  console.log('Uživatel (z cache):', user2);

  // Kontrola statistik
  const stats = await Cache.stats(userCache);
  console.log(`Statistiky cache: ${stats.hits} hitů, ${stats.misses} missů`);
  console.log(`Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);

  // Invalidace uživatele při aktualizaci
  await Cache.delete(userCache, 'user:123');

  // Úklid
  await Cache.stop(userCache);
}
```

---

## Související

- [GenServer API](./genserver.md) - Základní implementace
- [Registry API](./registry.md) - Vyhledávání pojmenovaných procesů
- [Rate Limiter API](./rate-limiter.md) - Omezování požadavků
