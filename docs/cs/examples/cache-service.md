# Cache služba

Použití vestavěné Cache služby pro key-value úložiště s podporou TTL.

## Přehled

Tento příklad ukazuje:
- Použití vestavěné Cache služby
- Nastavení hodnot s TTL
- Eviction politiky
- Sledování statistik

## Kompletní kód

```typescript
import { Cache, type CacheRef } from 'noex';

async function main() {
  // Spuštění cache s konfigurací
  const cache: CacheRef = await Cache.start({
    maxSize: 1000,           // Maximální počet položek
    defaultTtl: 60_000,      // Výchozí TTL: 60 sekund
    evictionPolicy: 'lru',   // Least Recently Used eviction
  });

  // Základní operace
  await Cache.set(cache, 'user:1', { name: 'Alice', age: 30 });
  await Cache.set(cache, 'user:2', { name: 'Bob', age: 25 });

  // Získání hodnot
  const user1 = await Cache.get(cache, 'user:1');
  console.log('User 1:', user1); // { name: 'Alice', age: 30 }

  // Kontrola existence
  const exists = await Cache.has(cache, 'user:1');
  console.log('Existuje:', exists); // true

  // Nastavení s vlastním TTL (5 sekund)
  await Cache.set(cache, 'temp:session', 'abc123', { ttl: 5_000 });

  // Vzor get or set
  const value = await Cache.getOrSet(cache, 'computed:key', async () => {
    console.log('Počítám hodnotu...');
    return 'computed-result';
  });
  console.log('Hodnota:', value); // computed-result

  // Druhé volání použije cachovanou hodnotu (žádná zpráva "Počítám...")
  const cachedValue = await Cache.getOrSet(cache, 'computed:key', async () => {
    console.log('Počítám hodnotu...');
    return 'different-result';
  });
  console.log('Z cache:', cachedValue); // computed-result

  // Získání statistik
  const stats = await Cache.getStats(cache);
  console.log('Statistiky cache:', stats);
  // { size: 4, hits: 1, misses: 1, evictions: 0 }

  // Smazání položek
  await Cache.delete(cache, 'user:2');
  console.log('User 2 po smazání:', await Cache.get(cache, 'user:2')); // null

  // Vyčištění všech položek
  await Cache.clear(cache);
  const statsAfterClear = await Cache.getStats(cache);
  console.log('Velikost po vyčištění:', statsAfterClear.size); // 0

  // Zastavení cache
  await Cache.stop(cache);
}

main().catch(console.error);
```

## Výstup

```
User 1: { name: 'Alice', age: 30 }
Existuje: true
Počítám hodnotu...
Hodnota: computed-result
Z cache: computed-result
Statistiky cache: { size: 4, hits: 1, misses: 1, evictions: 0 }
User 2 po smazání: null
Velikost po vyčištění: 0
```

## Vlastní implementace cache

Pro specializované potřeby cachování můžete implementovat vlastní cache GenServer:

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

interface CacheState {
  data: Map<string, { value: unknown; expiresAt: number }>;
}

type CacheCall =
  | { type: 'get'; key: string }
  | { type: 'has'; key: string };

type CacheCast =
  | { type: 'set'; key: string; value: unknown; ttl?: number }
  | { type: 'delete'; key: string }
  | { type: 'cleanup' };

const customCacheBehavior: GenServerBehavior<CacheState, CacheCall, CacheCast, unknown> = {
  init: () => ({ data: new Map() }),

  handleCall: (msg, state) => {
    const now = Date.now();
    switch (msg.type) {
      case 'get': {
        const entry = state.data.get(msg.key);
        if (!entry || entry.expiresAt < now) {
          state.data.delete(msg.key);
          return [null, state];
        }
        return [entry.value, state];
      }
      case 'has': {
        const entry = state.data.get(msg.key);
        return [entry !== undefined && entry.expiresAt > now, state];
      }
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'set': {
        const ttl = msg.ttl ?? 60_000;
        state.data.set(msg.key, {
          value: msg.value,
          expiresAt: Date.now() + ttl,
        });
        return state;
      }
      case 'delete': {
        state.data.delete(msg.key);
        return state;
      }
      case 'cleanup': {
        const now = Date.now();
        for (const [key, entry] of state.data) {
          if (entry.expiresAt < now) {
            state.data.delete(key);
          }
        }
        return state;
      }
    }
  },
};
```

## Konfigurační možnosti

| Možnost | Typ | Výchozí | Popis |
|---------|-----|---------|-------|
| `maxSize` | number | 1000 | Maximální počet položek |
| `defaultTtl` | number | 0 | Výchozí TTL v ms (0 = bez expirace) |
| `evictionPolicy` | 'lru' \| 'lfu' | 'lru' | Eviction strategie při naplnění |

## Best practices

1. **Používejte klíče s namespace**: Prefixujte klíče namespace pro zamezení kolizí
   ```typescript
   await Cache.set(cache, 'users:123', userData);
   await Cache.set(cache, 'sessions:abc', sessionData);
   ```

2. **Nastavte vhodné TTL**: Slaďte TTL s požadavky na čerstvost dat
   ```typescript
   // Často se měnící data - krátké TTL
   await Cache.set(cache, 'prices:btc', price, { ttl: 5_000 });

   // Stabilní data - delší TTL
   await Cache.set(cache, 'config:features', features, { ttl: 3600_000 });
   ```

3. **Používejte getOrSet pro výpočetně náročné operace**:
   ```typescript
   const result = await Cache.getOrSet(cache, key, async () => {
     return await expensiveComputation();
   });
   ```

## Související

- [Cache API](../api/cache.md) - Kompletní API reference
- [Koncept GenServer](../concepts/genserver.md) - Porozumění GenServerům
