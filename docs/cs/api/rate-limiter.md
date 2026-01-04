# RateLimiter API Reference

Služba `RateLimiter` poskytuje rate limiting s klouzavým oknem a sledováním podle klíče. Postavená na GenServeru, nabízí přesné omezování požadavků s konfigurovatelným limitem.

## Import

```typescript
import { RateLimiter, RateLimitExceededError } from 'noex';
```

## Typy

### RateLimiterRef

Neprůhledná reference na běžící instanci RateLimiteru.

```typescript
type RateLimiterRef = GenServerRef<
  RateLimiterState,
  RateLimiterCallMsg,
  RateLimiterCastMsg,
  RateLimiterCallReply
>;
```

### RateLimiterOptions

Volby pro `RateLimiter.start()`.

```typescript
interface RateLimiterOptions {
  /**
   * Maximální počet požadavků povolených v časovém okně.
   */
  readonly maxRequests: number;

  /**
   * Časové okno v milisekundách.
   */
  readonly windowMs: number;

  /**
   * Volitelné jméno pro registraci v registry.
   */
  readonly name?: string;
}
```

### RateLimitResult

Výsledek kontroly nebo spotřeby rate limitu.

```typescript
interface RateLimitResult {
  /** Zda je požadavek povolen */
  readonly allowed: boolean;

  /** Aktuální počet požadavků v okně */
  readonly current: number;

  /** Maximální povolený počet požadavků */
  readonly limit: number;

  /** Zbývající požadavky v okně */
  readonly remaining: number;

  /** Milisekundy do resetu okna */
  readonly resetMs: number;

  /** Milisekundy k čekání před dalším pokusem (0 pokud povoleno) */
  readonly retryAfterMs: number;
}
```

### RateLimitExceededError

Chyba vyhozená při překročení rate limitu.

```typescript
class RateLimitExceededError extends Error {
  readonly name = 'RateLimitExceededError';
  readonly key: string;
  readonly retryAfterMs: number;
}
```

---

## Metody

### start()

Spustí novou instanci RateLimiteru.

```typescript
async start(options: RateLimiterOptions): Promise<RateLimiterRef>
```

**Parametry:**
- `options` - Konfigurace RateLimiteru (povinná)
  - `maxRequests` - Maximální počet požadavků povolených za okno
  - `windowMs` - Délka okna v milisekundách
  - `name` - Volitelné jméno pro registry

**Vrací:** Promise resolvující na RateLimiterRef

**Příklad:**
```typescript
// 100 požadavků za minutu
const limiter = await RateLimiter.start({
  maxRequests: 100,
  windowMs: 60000,
});

// 10 požadavků za sekundu s registrací jména
const apiLimiter = await RateLimiter.start({
  maxRequests: 10,
  windowMs: 1000,
  name: 'api-limiter',
});
```

---

### check()

Zkontroluje, zda by byl požadavek povolen, bez spotřeby kvóty.

```typescript
async check(
  ref: RateLimiterRef,
  key: string,
  cost?: number,
): Promise<RateLimitResult>
```

**Parametry:**
- `ref` - Reference na RateLimiter
- `key` - Klíč rate limitu (např. `'user:123'`, `'ip:192.168.1.1'`)
- `cost` - Počet požadavků ke kontrole (výchozí: 1)

**Vrací:** Výsledek rate limitu s aktuálním stavem

**Příklad:**
```typescript
const result = await RateLimiter.check(limiter, 'user:123');

if (result.allowed) {
  console.log(`${result.remaining} zbývajících požadavků`);
} else {
  console.log(`Rate limited. Zkuste za ${result.retryAfterMs}ms`);
}
```

---

### consume()

Spotřebuje kvótu pro požadavek, pokud je povoleno. Vyhodí výjimku, pokud je rate limit překročen.

```typescript
async consume(
  ref: RateLimiterRef,
  key: string,
  cost?: number,
): Promise<RateLimitResult>
```

**Parametry:**
- `ref` - Reference na RateLimiter
- `key` - Klíč rate limitu
- `cost` - Počet požadavků ke spotřebě (výchozí: 1)

**Vrací:** Výsledek rate limitu

**Vyhazuje:**
- `RateLimitExceededError` - Pokud je rate limit překročen

**Příklad:**
```typescript
try {
  const result = await RateLimiter.consume(limiter, 'api:endpoint');
  // Zpracovat požadavek
  console.log(`${result.remaining} zbývajících požadavků`);
} catch (e) {
  if (e instanceof RateLimitExceededError) {
    res.status(429).json({
      error: 'Příliš mnoho požadavků',
      retryAfter: e.retryAfterMs,
    });
  }
}
```

---

### getStatus()

Získá aktuální stav pro klíč bez modifikace stavu.

```typescript
async getStatus(ref: RateLimiterRef, key: string): Promise<RateLimitResult>
```

**Parametry:**
- `ref` - Reference na RateLimiter
- `key` - Klíč rate limitu

**Vrací:** Aktuální stav rate limitu

**Příklad:**
```typescript
const status = await RateLimiter.getStatus(limiter, 'user:123');
console.log(`Použito: ${status.current}/${status.limit}`);
console.log(`Reset za: ${status.resetMs}ms`);
```

---

### reset()

Resetuje stav rate limitu pro konkrétní klíč.

```typescript
async reset(ref: RateLimiterRef, key: string): Promise<boolean>
```

**Parametry:**
- `ref` - Reference na RateLimiter
- `key` - Klíč rate limitu k resetování

**Vrací:** `true` pokud klíč existoval

**Příklad:**
```typescript
// Reset limitu pro uživatele (např. po platbě)
await RateLimiter.reset(limiter, 'user:123');
```

---

### getKeys()

Vrací všechny sledované klíče.

```typescript
async getKeys(ref: RateLimiterRef): Promise<readonly string[]>
```

**Parametry:**
- `ref` - Reference na RateLimiter

**Vrací:** Pole sledovaných klíčů

**Příklad:**
```typescript
const keys = await RateLimiter.getKeys(limiter);
console.log(`Sledování ${keys.length} klientů`);
```

---

### cleanup()

Spustí čištění zastaralých záznamů. Toto je fire-and-forget operace.

```typescript
cleanup(ref: RateLimiterRef): void
```

**Parametry:**
- `ref` - Reference na RateLimiter

**Příklad:**
```typescript
// Periodicky čistit neaktivní záznamy
setInterval(() => {
  RateLimiter.cleanup(limiter);
}, 300000); // Každých 5 minut
```

---

### isRunning()

Zjistí, zda RateLimiter běží.

```typescript
isRunning(ref: RateLimiterRef): boolean
```

**Parametry:**
- `ref` - Reference na RateLimiter

**Vrací:** `true` pokud běží

---

### stop()

Gracefully zastaví RateLimiter.

```typescript
async stop(ref: RateLimiterRef): Promise<void>
```

**Parametry:**
- `ref` - Reference na RateLimiter

---

## Kompletní příklad

```typescript
import { RateLimiter, RateLimitExceededError } from 'noex';

async function main() {
  // Vytvoření rate limiteru: 100 požadavků za minutu
  const limiter = await RateLimiter.start({
    maxRequests: 100,
    windowMs: 60000,
    name: 'api-rate-limiter',
  });

  // Příklad Express middleware
  async function rateLimitMiddleware(req, res, next) {
    const key = `ip:${req.ip}`;

    try {
      const result = await RateLimiter.consume(limiter, key);

      // Přidání rate limit hlaviček
      res.set('X-RateLimit-Limit', String(result.limit));
      res.set('X-RateLimit-Remaining', String(result.remaining));
      res.set('X-RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));

      next();
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        res.status(429).json({
          error: 'Příliš mnoho požadavků',
          retryAfter: Math.ceil(error.retryAfterMs / 1000),
        });
      } else {
        next(error);
      }
    }
  }

  // Příklad odstupňovaného rate limitingu
  async function tierRateLimit(userId: string, tier: 'free' | 'pro') {
    // Různé limity podle tarifu
    const key = tier === 'pro' ? `pro:${userId}` : `free:${userId}`;
    const cost = tier === 'free' ? 2 : 1; // Free tarif spotřebuje více kvóty

    return RateLimiter.consume(limiter, key, cost);
  }

  // Úklid při ukončení
  process.on('SIGTERM', async () => {
    await RateLimiter.stop(limiter);
  });
}
```

---

## Algoritmus klouzavého okna

RateLimiter používá algoritmus logu klouzavého okna pro přesný rate limiting:

1. **Sledování časových razítek**: Každé časové razítko požadavku je uloženo
2. **Výpočet okna**: Počítají se pouze požadavky v posledních `windowMs`
3. **Plynulé přechody**: Žádné pevné hranice okna způsobující burst vzory
4. **Přesný zbytek**: Přesné sledování dostupných požadavků

Tento přístup je přesnější než algoritmy s pevným oknem, které mohou povolit burst provoz na hranicích okna.

```
Problém pevného okna:
[Okno 1: 100 req]|[Okno 2: 100 req]
                  ↑
         200 požadavků za 1 sekundu možných

Řešení klouzavého okna:
[←────── windowMs ──────→]
Vždy počítá požadavky v klouzavém okně
```

---

## Související

- [GenServer API](./genserver.md) - Základní implementace
- [Cache API](./cache.md) - In-memory cachování
- [Registry API](./registry.md) - Vyhledávání pojmenovaných procesů
