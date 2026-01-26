# RateLimiter

V předchozí kapitole jste se naučili cachovat data s TTL a LRU eviction. Nyní se budeme věnovat další běžné potřebě: **ochrana vašich služeb před zahlcením**. noex poskytuje vestavěnou službu RateLimiter implementující rate limiting s posuvným oknem — přesnější než fixní okna a snáze pochopitelný než token buckety.

## Co se naučíte

- Jak rate limiting s posuvným oknem poskytuje hladší kontrolu provozu než fixní okna
- Konfigurovat limity podle klíče pro uživatele, IP adresy nebo API endpointy
- Používat `check` vs `consume` pro různé strategie rate limitingu
- Budovat robustní API rate limiting se správnými HTTP hlavičkami
- Elegantně ošetřovat chyby rate limitu s informacemi retry-after

## Proč Rate Limiting?

Rate limiting chrání vaše služby před zneužitím, zajišťuje spravedlivé rozdělení zdrojů a zabraňuje kaskádovým selháním:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│               BEZ RATE LIMITINGU VS S RATE LIMITINGEM                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BEZ RATE LIMITINGU:                  S RATE LIMITINGEM:                    │
│                                                                             │
│  User A ──► 1000 req/s ──┐            User A ──► 1000 req/s ──┐             │
│  User B ──► 10 req/s   ──┼──► Server  User B ──► 10 req/s   ──┼──► OK       │
│  User C ──► 5 req/s    ──┘    DOWN    User C ──► 5 req/s    ──┘             │
│                                                    ▼                        │
│  Jeden špatný aktér vyřadí            User A ──► 429 Too Many Requests      │
│  celou službu                         (omezen na 100 req/s)                 │
│                                                                             │
│  Problémy:                            Výhody:                               │
│  - Výpadek služby                     - Služba zůstává zdravá               │
│  - Všichni uživatelé ovlivněni        - Spravedlivé rozdělení zdrojů        │
│  - Žádné zotavení bez restartu        - Automatické zotavení                │
│  - Žádná viditelnost do zneužití      - Jasná zpětná vazba klientům         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Použijte RateLimiter když:**
- Chráníte API před zneužitím nebo DDoS
- Vynucujete kvóty využití (API plány, limity free tier)
- Zabraňujete kaskádovým selháním v microservices
- Zajišťujete spravedlivé přidělování zdrojů mezi uživateli

**Nepoužívejte RateLimiter když:**
- Interní volání mezi službami, které kontrolujete (použijte backpressure)
- Jednorázové operace (použijte mutex nebo semafor)
- Data nemají přirozené klíče pro seskupování

## Algoritmus posuvného okna

noex používá algoritmus **sliding window log**, který poskytuje hladší rate limiting než fixní okna:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    FIXNÍ OKNO VS POSUVNÉ OKNO                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  FIXNÍ OKNO (limit: 10 za minutu):                                          │
│                                                                             │
│  Okno 1 (00:00-00:59)       Okno 2 (01:00-01:59)                            │
│  ┌────────────────────┐     ┌────────────────────┐                          │
│  │■■■■■■■■■■          │     │■■■■■■■■■■          │                          │
│  │ 10 requestů @ 0:55 │     │ 10 requestů @ 1:00 │                          │
│  └────────────────────┘     └────────────────────┘                          │
│           ▼                          ▼                                      │
│  Problém: 20 requestů za 10 sekund! (0:55 až 1:05)                          │
│                                                                             │
│  ═══════════════════════════════════════════════════════════════════════    │
│                                                                             │
│  POSUVNÉ OKNO (limit: 10 za minutu):                                        │
│                                                                             │
│  V 1:05 okno se dívá 60 sekund dozadu (0:05 až 1:05):                       │
│  ┌────────────────────────────────────────────────────────────┐             │
│  │ ← 60 sekund →                                              │             │
│  │ 0:05                               0:55  1:00  1:05        │             │
│  │                                    ■■■■■ ■■■■■ X           │             │
│  └────────────────────────────────────────────────────────────┘             │
│           ▼                                                                 │
│  Výsledek: 10 requestů již v okně → request odmítnut                        │
│  Konzistentních 10 req/min bez ohledu na hranice okna                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Přístup posuvného okna:
- Počítá requesty v klouzavém časovém okně
- Žádný problém "boundary burst"
- Předvídatelnější chování pro klienty
- Přesné výpočty remaining/retry-after

## Spuštění RateLimiteru

RateLimiter je pod kapotou GenServer. Každá instance je nezávislá:

```typescript
import { RateLimiter } from '@hamicek/noex';

// Spuštění rate limiteru: 100 requestů za minutu
const limiter = await RateLimiter.start({
  maxRequests: 100,
  windowMs: 60000,  // 1 minuta
});

// S volitelným jménem pro lookup v registry
const namedLimiter = await RateLimiter.start({
  maxRequests: 1000,
  windowMs: 3600000,  // 1 hodina
  name: 'api-rate-limiter',
});

// Kontrola, zda běží
console.log(RateLimiter.isRunning(limiter)); // true

// Úklid při ukončení
await RateLimiter.stop(limiter);
```

### Konfigurační možnosti

| Možnost | Typ | Povinné | Popis |
|---------|-----|---------|-------|
| `maxRequests` | `number` | Ano | Maximální počet requestů povolených za okno |
| `windowMs` | `number` | Ano | Délka okna v milisekundách |
| `name` | `string` | Ne | Volitelné jméno pro registraci v registry |

### Běžné konfigurace rate limitu

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PRŮVODCE KONFIGURACÍ RATE LIMITU                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Případ použití         │ maxRequests  │ windowMs    │ Efektivní rychlost  │
│  ───────────────────────┼──────────────┼─────────────┼──────────────────── │
│  Veřejné API (free)     │ 60           │ 60000       │ 1 req/sec           │
│  Veřejné API (placené)  │ 1000         │ 60000       │ ~17 req/sec         │
│  Autentizace            │ 5            │ 60000       │ 5 pokusů/min        │
│  Reset hesla            │ 3            │ 3600000     │ 3 pokusy/hodinu     │
│  Upload souborů         │ 10           │ 3600000     │ 10 uploadů/hodinu   │
│  SMS verifikace         │ 3            │ 300000      │ 3 za 5 minut        │
│  Webhook doručení       │ 100          │ 1000        │ 100 req/sec (burst) │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Check vs Consume

RateLimiter poskytuje dvě hlavní metody s různým chováním:

### check — Dotaz bez spotřebování

`check` řekne, zda by request **byl** povolen, aniž by ho skutečně počítala:

```typescript
const limiter = await RateLimiter.start({
  maxRequests: 10,
  windowMs: 60000,
});

// Kontrola bez spotřebování kvóty
const result = await RateLimiter.check(limiter, 'user:123');

console.log(result);
// {
//   allowed: true,
//   current: 0,      // Aktuální requesty v okně
//   limit: 10,       // Maximální povoleno
//   remaining: 10,   // Requesty stále dostupné
//   resetMs: 60000,  // Čas do resetu okna
//   retryAfterMs: 0  // 0 když je povoleno
// }

// Více kontrol nespotřebovává kvótu
await RateLimiter.check(limiter, 'user:123');
await RateLimiter.check(limiter, 'user:123');
await RateLimiter.check(limiter, 'user:123');

const status = await RateLimiter.getStatus(limiter, 'user:123');
console.log(status.current); // Stále 0!
```

**Použijte `check` když:**
- Zobrazujete uživatelům zbývající kvótu před akcí
- Pre-flight kontroly pro drahé operace
- Monitorovací dashboardy

### consume — Započítání a potenciální odmítnutí

`consume` zaznamená request a vyhodí výjimku, pokud je limit překročen:

```typescript
import { RateLimiter, RateLimitExceededError } from '@hamicek/noex';

const limiter = await RateLimiter.start({
  maxRequests: 3,
  windowMs: 60000,
});

try {
  // Request 1: povolen
  await RateLimiter.consume(limiter, 'user:123');
  console.log('Request 1: OK');

  // Request 2: povolen
  await RateLimiter.consume(limiter, 'user:123');
  console.log('Request 2: OK');

  // Request 3: povolen
  await RateLimiter.consume(limiter, 'user:123');
  console.log('Request 3: OK');

  // Request 4: vyhodí výjimku!
  await RateLimiter.consume(limiter, 'user:123');
  console.log('Request 4: OK'); // Nikdy se nedostaneme
} catch (error) {
  if (error instanceof RateLimitExceededError) {
    console.log(`Rate limited: ${error.message}`);
    console.log(`Klíč: ${error.key}`);
    console.log(`Retry za: ${error.retryAfterMs}ms`);
  }
}
```

### Operace s proměnlivou cenou

Některé operace stojí více než jiné. Použijte parametr `cost`:

```typescript
const limiter = await RateLimiter.start({
  maxRequests: 100,  // 100 "jednotek" za minutu
  windowMs: 60000,
});

// Jednoduché čtení: 1 jednotka
await RateLimiter.consume(limiter, 'user:123', 1);

// Komplexní dotaz: 5 jednotek
await RateLimiter.consume(limiter, 'user:123', 5);

// Hromadný export: 20 jednotek
await RateLimiter.consume(limiter, 'user:123', 20);

// Kontrola zbývajícího před drahou operací
const status = await RateLimiter.check(limiter, 'user:123', 50);
if (!status.allowed) {
  console.log(`Nedostatek kvóty. Potřeba 50, máte ${status.remaining}`);
}
```

## Práce s RateLimitResult

Každá operace check a consume vrací detailní stav:

```typescript
interface RateLimitResult {
  allowed: boolean;     // Může tento request pokračovat?
  current: number;      // Requesty započítané v aktuálním okně
  limit: number;        // Maximální povolené requesty
  remaining: number;    // Requesty stále dostupné
  resetMs: number;      // Milisekundy do expirace nejstaršího requestu
  retryAfterMs: number; // Milisekundy čekání pokud odmítnuto (0 pokud povoleno)
}
```

### Použití výsledků pro HTTP hlavičky

```typescript
async function handleApiRequest(userId: string, res: Response) {
  const result = await RateLimiter.consume(limiter, `user:${userId}`);

  // Vždy nastavit rate limit hlavičky (i když povoleno)
  res.setHeader('X-RateLimit-Limit', result.limit);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(Date.now() / 1000 + result.resetMs / 1000));

  // ... zpracovat request
}
```

### Ošetření odmítnutí

```typescript
async function handleApiRequest(userId: string, res: Response) {
  try {
    const result = await RateLimiter.consume(limiter, `user:${userId}`);
    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(Date.now() / 1000 + result.resetMs / 1000));

    // Zpracovat request...
    res.json({ data: 'success' });
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      const retryAfterSec = Math.ceil(error.retryAfterMs / 1000);

      res.setHeader('Retry-After', retryAfterSec);
      res.setHeader('X-RateLimit-Limit', limiter.limit);
      res.setHeader('X-RateLimit-Remaining', 0);

      res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit překročen. Zkuste znovu za ${retryAfterSec} sekund.`,
        retryAfter: retryAfterSec,
      });
      return;
    }
    throw error;
  }
}
```

## Rate Limiting podle klíče

Parametr key umožňuje různé limity pro různé entity:

```typescript
const limiter = await RateLimiter.start({
  maxRequests: 100,
  windowMs: 60000,
});

// Každý klíč má nezávislé limity
await RateLimiter.consume(limiter, 'user:alice');  // Alice: 1/100
await RateLimiter.consume(limiter, 'user:bob');    // Bob: 1/100 (oddělené)
await RateLimiter.consume(limiter, 'user:alice');  // Alice: 2/100

// Běžné vzory klíčů:
// Podle uživatele:  'user:123'
// Podle IP:         'ip:192.168.1.1'
// Podle API klíče:  'apikey:sk_live_xxx'
// Podle endpointu:  'endpoint:/api/users'
// Kombinované:      'user:123:/api/sensitive'
```

### Více RateLimiterů pro různé úrovně

```typescript
// Různé limity pro různé uživatelské úrovně
const freeLimiter = await RateLimiter.start({
  maxRequests: 60,
  windowMs: 60000,  // 1 req/sec
});

const proLimiter = await RateLimiter.start({
  maxRequests: 600,
  windowMs: 60000,  // 10 req/sec
});

const enterpriseLimiter = await RateLimiter.start({
  maxRequests: 6000,
  windowMs: 60000,  // 100 req/sec
});

async function rateLimit(userId: string, tier: 'free' | 'pro' | 'enterprise') {
  const limiter = {
    free: freeLimiter,
    pro: proLimiter,
    enterprise: enterpriseLimiter,
  }[tier];

  return RateLimiter.consume(limiter, `user:${userId}`);
}
```

## Správa stavu RateLimiteru

### Získání stavu bez modifikace

```typescript
// getStatus vrací aktuální stav bez spotřebování nebo i dotýkání záznamu
const status = await RateLimiter.getStatus(limiter, 'user:123');
console.log(`Uživatel má ${status.remaining} requestů zbývajících`);
```

### Reset konkrétního klíče

```typescript
// Uživatel upgradoval plán - resetovat limity
const existed = await RateLimiter.reset(limiter, 'user:123');
console.log(`Reset úspěšný: ${existed}`); // true pokud klíč existoval
```

### Seznam všech sledovaných klíčů

```typescript
// Monitorování kdo zasahuje rate limiter
const keys = await RateLimiter.getKeys(limiter);
console.log(`Sledování ${keys.length} klíčů:`, keys);
// ['user:123', 'user:456', 'ip:192.168.1.1', ...]
```

### Úklid na pozadí

Zastaralé záznamy (bez aktivity po 2 oknech) jsou automaticky čištěny, ale můžete to spustit manuálně:

```typescript
// Fire-and-forget úklid zastaralých záznamů
RateLimiter.cleanup(limiter);

// Periodický úklid (volitelné - pomáhá paměti ve scénářích s vysokou kardinalitou)
setInterval(() => {
  RateLimiter.cleanup(limiter);
}, 300000); // Každých 5 minut
```

## Praktický příklad: Express API Rate Limiting

Zde je produkčně připravený rate limiting middleware:

```typescript
import { RateLimiter, RateLimitExceededError, type RateLimiterRef } from '@hamicek/noex';
import type { Request, Response, NextFunction } from 'express';

interface RateLimitMiddlewareOptions {
  maxRequests: number;
  windowMs: number;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
  onLimited?: (req: Request, res: Response, result: RateLimitExceededError) => void;
}

async function createRateLimitMiddleware(options: RateLimitMiddlewareOptions) {
  const {
    maxRequests,
    windowMs,
    keyGenerator = (req) => req.ip || 'unknown',
    skip = () => false,
    onLimited,
  } = options;

  const limiter = await RateLimiter.start({ maxRequests, windowMs });

  // Periodický úklid
  const cleanupInterval = setInterval(() => {
    RateLimiter.cleanup(limiter);
  }, windowMs);

  const middleware = async (req: Request, res: Response, next: NextFunction) => {
    // Přeskočit určité requesty (health checks, interní, atd.)
    if (skip(req)) {
      return next();
    }

    const key = keyGenerator(req);

    try {
      const result = await RateLimiter.consume(limiter, key);

      // Nastavit standardní rate limit hlavičky
      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(Date.now() / 1000 + result.resetMs / 1000));

      next();
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        const retryAfterSec = Math.ceil(error.retryAfterMs / 1000);

        res.setHeader('Retry-After', retryAfterSec);
        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', 0);

        if (onLimited) {
          onLimited(req, res, error);
        } else {
          res.status(429).json({
            error: 'Too Many Requests',
            message: `Rate limit překročen. Zkuste znovu za ${retryAfterSec} sekund.`,
            retryAfter: retryAfterSec,
          });
        }
        return;
      }
      next(error);
    }
  };

  // Umožnit zastavení rate limiteru
  middleware.stop = async () => {
    clearInterval(cleanupInterval);
    await RateLimiter.stop(limiter);
  };

  middleware.getLimiter = () => limiter;

  return middleware;
}

// Použití s Express
import express from 'express';

async function main() {
  const app = express();

  // Globální rate limit: 100 requestů za minutu na IP
  const globalLimiter = await createRateLimitMiddleware({
    maxRequests: 100,
    windowMs: 60000,
    keyGenerator: (req) => `ip:${req.ip}`,
    skip: (req) => req.path === '/health',
  });

  // Přísný rate limit pro autentizaci: 5 pokusů za minutu
  const authLimiter = await createRateLimitMiddleware({
    maxRequests: 5,
    windowMs: 60000,
    keyGenerator: (req) => `auth:${req.ip}`,
    onLimited: (req, res) => {
      res.status(429).json({
        error: 'Příliš mnoho pokusů o přihlášení',
        message: 'Prosím počkejte před dalším pokusem.',
      });
    },
  });

  // Aplikovat globální limiter na všechny routes
  app.use(globalLimiter);

  // Aplikovat přísný limiter na auth routes
  app.post('/api/login', authLimiter, (req, res) => {
    res.json({ success: true });
  });

  app.post('/api/register', authLimiter, (req, res) => {
    res.json({ success: true });
  });

  // Běžné API routes používají pouze globální limiter
  app.get('/api/users', (req, res) => {
    res.json({ users: [] });
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  const server = app.listen(3000, () => {
    console.log('Server běží na portu 3000');
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    server.close();
    await globalLimiter.stop();
    await authLimiter.stop();
  });
}

main();
```

## Vzory Rate Limiteru

### Složené klíče pro jemnozrnnou kontrolu

```typescript
const limiter = await RateLimiter.start({
  maxRequests: 10,
  windowMs: 60000,
});

// Limit podle uživatele a endpointu
async function limitByUserAndEndpoint(userId: string, endpoint: string) {
  const key = `${userId}:${endpoint}`;
  return RateLimiter.consume(limiter, key);
}

// Uživatel 123 může volat /api/search 10x za minutu
// A /api/export 10x za minutu (oddělené limity)
await limitByUserAndEndpoint('user:123', '/api/search');
await limitByUserAndEndpoint('user:123', '/api/export');
```

### Fail-Open vs Fail-Closed

```typescript
// Fail-closed (přísné): odmítnout při jakékoli chybě
async function failClosed(limiter: RateLimiterRef, key: string): Promise<boolean> {
  try {
    await RateLimiter.consume(limiter, key);
    return true;
  } catch (error) {
    // Rate limit překročen NEBO jakákoli jiná chyba = odmítnout
    return false;
  }
}

// Fail-open (tolerantní): povolit při interních chybách
async function failOpen(limiter: RateLimiterRef, key: string): Promise<boolean> {
  try {
    await RateLimiter.consume(limiter, key);
    return true;
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      return false;  // Skutečný rate limit = odmítnout
    }
    console.warn('Chyba rate limiteru, povoluji request:', error);
    return true;  // Interní chyba = povolit (fail-open)
  }
}
```

## Cvičení: API Quota systém

Vytvořte API quota systém, který:
1. Sleduje využití podle API klíče s měsíčními limity
2. Podporuje různé úrovně (free: 1000/měsíc, pro: 100000/měsíc)
3. Poskytuje `/usage` endpoint pro kontrolu zbývající kvóty
4. Posílá varování při využití 80% kvóty
5. Elegantně ošetřuje vyčerpání kvóty s pomocnými chybovými zprávami

**Výchozí kód:**

```typescript
import { RateLimiter, RateLimitExceededError, type RateLimiterRef } from '@hamicek/noex';

interface QuotaTier {
  name: string;
  monthlyLimit: number;
}

interface QuotaStatus {
  tier: string;
  used: number;
  limit: number;
  remaining: number;
  percentUsed: number;
  resetDate: Date;
}

interface ApiQuotaSystem {
  start(): Promise<void>;
  consume(apiKey: string, tier: keyof typeof tiers): Promise<QuotaStatus>;
  getUsage(apiKey: string, tier: keyof typeof tiers): Promise<QuotaStatus>;
  stop(): Promise<void>;
}

const tiers: Record<string, QuotaTier> = {
  free: { name: 'Free', monthlyLimit: 1000 },
  pro: { name: 'Pro', monthlyLimit: 100000 },
};

function createApiQuotaSystem(): ApiQuotaSystem {
  // TODO: Implementovat quota systém

  return {
    async start() {
      // TODO: Spustit rate limitery pro každou úroveň
    },

    async consume(apiKey: string, tier: keyof typeof tiers): Promise<QuotaStatus> {
      // TODO: Spotřebovat kvótu a vrátit stav
      // TODO: Logovat varování pokud > 80% využito
      throw new Error('Neimplementováno');
    },

    async getUsage(apiKey: string, tier: keyof typeof tiers): Promise<QuotaStatus> {
      // TODO: Získat aktuální využití bez spotřebování
      throw new Error('Neimplementováno');
    },

    async stop() {
      // TODO: Zastavit všechny rate limitery
    },
  };
}
```

<details>
<summary><strong>Řešení</strong></summary>

```typescript
import { RateLimiter, RateLimitExceededError, type RateLimiterRef } from '@hamicek/noex';

interface QuotaTier {
  name: string;
  monthlyLimit: number;
}

interface QuotaStatus {
  tier: string;
  used: number;
  limit: number;
  remaining: number;
  percentUsed: number;
  resetDate: Date;
}

const tiers: Record<string, QuotaTier> = {
  free: { name: 'Free', monthlyLimit: 1000 },
  pro: { name: 'Pro', monthlyLimit: 100000 },
};

// Vypočítat milisekundy do konce aktuálního měsíce
function msUntilMonthEnd(): number {
  const now = new Date();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return endOfMonth.getTime() - now.getTime();
}

// Získat datum resetu (první den příštího měsíce)
function getResetDate(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

function createApiQuotaSystem() {
  const limiters: Record<string, RateLimiterRef> = {};
  const warningsSent = new Set<string>(); // Sledovat které klíče dostaly varování

  return {
    async start() {
      // Vytvořit rate limiter pro každou úroveň
      // Použití měsíčního okna (přibližné - resetuje se při startu limiteru)
      // V produkci byste chtěli synchronizovat se skutečnými kalendářními měsíci
      const monthMs = 30 * 24 * 60 * 60 * 1000; // ~30 dní

      for (const [tierKey, config] of Object.entries(tiers)) {
        limiters[tierKey] = await RateLimiter.start({
          maxRequests: config.monthlyLimit,
          windowMs: monthMs,
          name: `quota-${tierKey}`,
        });
      }
    },

    async consume(apiKey: string, tier: keyof typeof tiers): Promise<QuotaStatus> {
      const limiter = limiters[tier];
      const tierConfig = tiers[tier];

      if (!limiter || !tierConfig) {
        throw new Error(`Neznámá úroveň: ${tier}`);
      }

      try {
        const result = await RateLimiter.consume(limiter, apiKey);

        const status: QuotaStatus = {
          tier: tierConfig.name,
          used: result.current,
          limit: result.limit,
          remaining: result.remaining,
          percentUsed: (result.current / result.limit) * 100,
          resetDate: getResetDate(),
        };

        // Kontrola 80% varování
        const warningKey = `${apiKey}:${tier}`;
        if (status.percentUsed >= 80 && !warningsSent.has(warningKey)) {
          console.warn(
            `[QUOTA VAROVÁNÍ] API klíč ${apiKey} (${tierConfig.name}) využil ` +
            `${status.percentUsed.toFixed(1)}% měsíční kvóty. ` +
            `${status.remaining} requestů zbývá.`
          );
          warningsSent.add(warningKey);
        }

        return status;
      } catch (error) {
        if (error instanceof RateLimitExceededError) {
          const status = await this.getUsage(apiKey, tier);
          throw new QuotaExhaustedError(
            apiKey,
            tierConfig.name,
            status.resetDate
          );
        }
        throw error;
      }
    },

    async getUsage(apiKey: string, tier: keyof typeof tiers): Promise<QuotaStatus> {
      const limiter = limiters[tier];
      const tierConfig = tiers[tier];

      if (!limiter || !tierConfig) {
        throw new Error(`Neznámá úroveň: ${tier}`);
      }

      const result = await RateLimiter.getStatus(limiter, apiKey);

      return {
        tier: tierConfig.name,
        used: result.current,
        limit: result.limit,
        remaining: result.remaining,
        percentUsed: result.limit > 0 ? (result.current / result.limit) * 100 : 0,
        resetDate: getResetDate(),
      };
    },

    async stop() {
      await Promise.all(
        Object.values(limiters).map(l => RateLimiter.stop(l))
      );
      warningsSent.clear();
    },
  };
}

// Custom chyba pro vyčerpání kvóty
class QuotaExhaustedError extends Error {
  constructor(
    readonly apiKey: string,
    readonly tier: string,
    readonly resetDate: Date,
  ) {
    const resetStr = resetDate.toLocaleDateString('cs-CZ', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    super(
      `Měsíční kvóta vyčerpána pro úroveň ${tier}. ` +
      `Vaše kvóta se resetuje ${resetStr}. ` +
      `Zvažte upgrade plánu pro vyšší limity.`
    );
    this.name = 'QuotaExhaustedError';
  }
}

// Test implementace
async function main() {
  const quotaSystem = createApiQuotaSystem();
  await quotaSystem.start();

  const testApiKey = 'api_key_test_123';

  try {
    // Simulace API využití
    console.log('Provádím API requesty...\n');

    for (let i = 0; i < 12; i++) {
      const status = await quotaSystem.consume(testApiKey, 'free');
      console.log(
        `Request ${i + 1}: ${status.used}/${status.limit} využito ` +
        `(${status.percentUsed.toFixed(1)}%)`
      );
    }

    // Kontrola využití bez spotřebování
    console.log('\nAktuální využití:');
    const usage = await quotaSystem.getUsage(testApiKey, 'free');
    console.log(`  Úroveň: ${usage.tier}`);
    console.log(`  Využito: ${usage.used}/${usage.limit}`);
    console.log(`  Zbývá: ${usage.remaining}`);
    console.log(`  Procent využito: ${usage.percentUsed.toFixed(1)}%`);
    console.log(`  Resetuje se: ${usage.resetDate.toLocaleDateString()}`);

  } catch (error) {
    if (error instanceof QuotaExhaustedError) {
      console.error('\nKvóta vyčerpána:', error.message);
    } else {
      throw error;
    }
  }

  await quotaSystem.stop();
}

main();
```

**Klíčová designová rozhodnutí:**

1. **Aproximace měsíčního okna** — Používá ~30denní okno. Produkční systémy by měly synchronizovat se skutečnými kalendářními měsíci.

2. **Varování při 80%** — Loguje varování jednou při překročení prahu. Používá Set pro zamezení duplicitních varování.

3. **Custom třída chyby** — `QuotaExhaustedError` poskytuje uživatelsky přívětivou zprávu s datem resetu a návrhem na upgrade.

4. **Oddělený limiter pro každou úroveň** — Umožňuje různé limity bez komplexních schémat klíčů.

5. **getUsage vs consume** — Čisté oddělení mezi kontrolou a spotřebováním kvóty.

</details>

## Shrnutí

**Klíčové poznatky:**

- **RateLimiter poskytuje rate limiting s posuvným oknem** — Přesnější než fixní okna, hladší kontrola provozu
- **Sledování podle klíče** — Nezávislé limity pro uživatele, IP, API klíče nebo jakýkoli identifikátor
- **check vs consume** — `check` dotazuje bez počítání; `consume` počítá a vyhodí při limitu
- **Proměnlivá cena** — Použijte parametr `cost` pro operace s různými požadavky na zdroje
- **Bohaté stavové informace** — `RateLimitResult` poskytuje zbývající kvótu, čas resetu a retry-after

**Reference metod:**

| Metoda | Vrací | Popis |
|--------|-------|-------|
| `start(options)` | `Promise<Ref>` | Vytvořit nový rate limiter |
| `check(ref, key, cost?)` | `Promise<Result>` | Zkontrolovat bez spotřebování |
| `consume(ref, key, cost?)` | `Promise<Result>` | Spotřebovat kvótu (vyhodí při překročení) |
| `getStatus(ref, key)` | `Promise<Result>` | Získat aktuální stav |
| `reset(ref, key)` | `Promise<boolean>` | Vymazat limity pro klíč |
| `getKeys(ref)` | `Promise<string[]>` | Seznam všech sledovaných klíčů |
| `cleanup(ref)` | `void` | Odstranit zastaralé záznamy |
| `stop(ref)` | `Promise<void>` | Zastavit rate limiter |

**Pamatujte:**

> Rate limiting je o ochraně vaší služby a zároveň spravedlivosti k uživatelům. Vždy poskytujte jasnou zpětnou vazbu (zbývající kvóta, retry-after), aby se klienti mohli přizpůsobit. Začněte s velkorysými limity a zpřísňujte na základě skutečných vzorů využití.

---

Další: [TimerService](./04-timer-service.md)
