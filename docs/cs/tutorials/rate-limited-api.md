# Tutoriál: Vytvoření Rate-Limited API

V tomto tutoriálu vytvoříte REST API s rate limitingem pomocí noex. Naučíte se:
- Vytvářet API endpointy s Express
- Používat službu RateLimiter pro throttling požadavků
- Implementovat per-user a per-endpoint limity
- Vracet správné rate limit hlavičky a chybové odpovědi

## Předpoklady

- Node.js 18+
- Základní znalost TypeScriptu
- Pochopení základů noex GenServer

## Nastavení projektu

Vytvořte nový projekt:

```bash
mkdir rate-limited-api
cd rate-limited-api
npm init -y
npm install noex express
npm install -D typescript tsx @types/node @types/express
```

Vytvořte `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

## Přehled architektury

```
                    [AppSupervisor]
                    /      |      \
         [GlobalLimiter] [UserLimiter] [API Server]
              |              |
         100 req/min    10 req/min per user
```

API používá dva rate limitery:
- **Global Limiter**: Chrání API před zahlcením (100 požadavků/minuta)
- **User Limiter**: Limituje jednotlivé uživatele (10 požadavků/minuta per user)

---

## Krok 1: Služba Rate Limiteru

Vytvořte `src/limiters.ts`:

```typescript
import { RateLimiter, type RateLimiterRef } from 'noex';

// Reference na limitery
let globalLimiter: RateLimiterRef | null = null;
let userLimiter: RateLimiterRef | null = null;

/**
 * Inicializace rate limiterů
 */
export async function initLimiters(): Promise<void> {
  // Globální rate limit: 100 požadavků za minutu
  globalLimiter = await RateLimiter.start({
    maxRequests: 100,
    windowMs: 60000,
    name: 'global-limiter',
  });

  // Per-user rate limit: 10 požadavků za minutu
  userLimiter = await RateLimiter.start({
    maxRequests: 10,
    windowMs: 60000,
    name: 'user-limiter',
  });

  console.log('Rate limitery inicializovány');
}

/**
 * Získání globálního rate limiteru
 */
export function getGlobalLimiter(): RateLimiterRef {
  if (!globalLimiter) {
    throw new Error('Globální limiter není inicializován');
  }
  return globalLimiter;
}

/**
 * Získání user rate limiteru
 */
export function getUserLimiter(): RateLimiterRef {
  if (!userLimiter) {
    throw new Error('User limiter není inicializován');
  }
  return userLimiter;
}

/**
 * Zastavení všech rate limiterů
 */
export async function stopLimiters(): Promise<void> {
  if (globalLimiter) {
    await RateLimiter.stop(globalLimiter);
  }
  if (userLimiter) {
    await RateLimiter.stop(userLimiter);
  }
}
```

---

## Krok 2: Rate Limit Middleware

Vytvořte `src/middleware.ts`:

```typescript
import type { Request, Response, NextFunction } from 'express';
import { RateLimiter, RateLimitExceededError } from 'noex';
import { getGlobalLimiter, getUserLimiter } from './limiters.js';

/**
 * Express middleware pro globální rate limiting
 */
export async function globalRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const limiter = getGlobalLimiter();
  const key = 'global';

  try {
    const result = await RateLimiter.consume(limiter, key);
    setRateLimitHeaders(res, result);
    next();
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      res.status(429).json({
        error: 'Příliš mnoho požadavků',
        message: 'Globální rate limit překročen',
        retryAfter: Math.ceil(error.retryAfterMs / 1000),
      });
    } else {
      next(error);
    }
  }
}

/**
 * Express middleware pro per-user rate limiting
 */
export async function userRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const limiter = getUserLimiter();

  // Použití API klíče, user ID nebo IP adresy jako klíče rate limitu
  const userId = req.headers['x-api-key'] as string || req.ip || 'anonymous';
  const key = `user:${userId}`;

  try {
    const result = await RateLimiter.consume(limiter, key);
    setRateLimitHeaders(res, result);
    next();
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      res.status(429).json({
        error: 'Příliš mnoho požadavků',
        message: 'User rate limit překročen',
        retryAfter: Math.ceil(error.retryAfterMs / 1000),
      });
    } else {
      next(error);
    }
  }
}

/**
 * Nastavení standardních rate limit hlaviček
 */
function setRateLimitHeaders(
  res: Response,
  result: { limit: number; remaining: number; resetMs: number }
): void {
  res.set('X-RateLimit-Limit', String(result.limit));
  res.set('X-RateLimit-Remaining', String(result.remaining));
  res.set('X-RateLimit-Reset', String(Math.ceil(Date.now() / 1000 + result.resetMs / 1000)));
}
```

---

## Krok 3: API Endpointy

Vytvořte `src/routes.ts`:

```typescript
import { Router } from 'express';
import { RateLimiter } from 'noex';
import { getGlobalLimiter, getUserLimiter } from './limiters.js';

const router = Router();

// Ukázkový datový store
const items = new Map<string, { id: string; name: string; price: number }>();

/**
 * GET /api/items - Seznam všech položek
 */
router.get('/items', (_req, res) => {
  const allItems = Array.from(items.values());
  res.json({ items: allItems, count: allItems.length });
});

/**
 * GET /api/items/:id - Získání položky podle ID
 */
router.get('/items/:id', (req, res) => {
  const item = items.get(req.params.id);

  if (!item) {
    res.status(404).json({ error: 'Položka nenalezena' });
    return;
  }

  res.json(item);
});

/**
 * POST /api/items - Vytvoření nové položky
 */
router.post('/items', (req, res) => {
  const { name, price } = req.body;

  if (!name || typeof price !== 'number') {
    res.status(400).json({ error: 'Neplatné tělo požadavku' });
    return;
  }

  const id = `item_${Date.now()}`;
  const item = { id, name, price };
  items.set(id, item);

  res.status(201).json(item);
});

/**
 * DELETE /api/items/:id - Smazání položky
 */
router.delete('/items/:id', (req, res) => {
  const deleted = items.delete(req.params.id);

  if (!deleted) {
    res.status(404).json({ error: 'Položka nenalezena' });
    return;
  }

  res.status(204).send();
});

/**
 * GET /api/rate-limit/status - Získání aktuálního stavu rate limitu
 */
router.get('/rate-limit/status', async (req, res) => {
  const globalLimiter = getGlobalLimiter();
  const userLimiter = getUserLimiter();

  const userId = req.headers['x-api-key'] as string || req.ip || 'anonymous';

  const [globalStatus, userStatus] = await Promise.all([
    RateLimiter.getStatus(globalLimiter, 'global'),
    RateLimiter.getStatus(userLimiter, `user:${userId}`),
  ]);

  res.json({
    global: {
      current: globalStatus.current,
      limit: globalStatus.limit,
      remaining: globalStatus.remaining,
      resetMs: globalStatus.resetMs,
    },
    user: {
      current: userStatus.current,
      limit: userStatus.limit,
      remaining: userStatus.remaining,
      resetMs: userStatus.resetMs,
    },
  });
});

export { router };
```

---

## Krok 4: Nastavení serveru

Vytvořte `src/server.ts`:

```typescript
import express from 'express';
import { Supervisor, type SupervisorRef } from 'noex';
import { initLimiters, stopLimiters } from './limiters.js';
import { globalRateLimitMiddleware, userRateLimitMiddleware } from './middleware.js';
import { router } from './routes.js';

let supervisor: SupervisorRef | null = null;

/**
 * Spuštění API serveru
 */
export async function startServer(port = 3000): Promise<void> {
  // Inicializace rate limiterů
  await initLimiters();

  // Vytvoření Express aplikace
  const app = express();
  app.use(express.json());

  // Aplikace rate limiting middleware
  app.use('/api', globalRateLimitMiddleware);
  app.use('/api', userRateLimitMiddleware);

  // Připojení rout
  app.use('/api', router);

  // Health check endpoint (bez rate limitingu)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Neošetřená chyba:', err);
    res.status(500).json({ error: 'Interní chyba serveru' });
  });

  // Spuštění naslouchání
  const server = app.listen(port, () => {
    console.log(`API server běží na http://localhost:${port}`);
  });

  // Vytvoření supervisoru pro monitoring
  supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 5, withinMs: 60000 },
  });

  // Graceful shutdown
  process.on('SIGTERM', () => shutdown(server));
  process.on('SIGINT', () => shutdown(server));
}

/**
 * Graceful shutdown
 */
async function shutdown(server: ReturnType<typeof express.application.listen>): Promise<void> {
  console.log('\nVypínám...');

  server.close();
  await stopLimiters();

  if (supervisor) {
    await Supervisor.stop(supervisor);
  }

  console.log('Shutdown dokončen');
  process.exit(0);
}
```

---

## Krok 5: Entry Point

Vytvořte `src/index.ts`:

```typescript
import { startServer } from './server.js';

const port = parseInt(process.env.PORT || '3000', 10);

startServer(port).catch((err) => {
  console.error('Nepodařilo se spustit server:', err);
  process.exit(1);
});
```

---

## Krok 6: Spuštění a testování

Přidejte skripty do `package.json`:

```json
{
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts"
  }
}
```

Spusťte server:

```bash
npm start
```

### Testování API

```bash
# Vytvoření položky
curl -X POST http://localhost:3000/api/items \
  -H "Content-Type: application/json" \
  -d '{"name": "Widget", "price": 99.90}'

# Seznam položek
curl http://localhost:3000/api/items

# Kontrola stavu rate limitu
curl http://localhost:3000/api/rate-limit/status

# Test rate limitingu (spusťte mnohokrát rychle za sebou)
for i in {1..15}; do
  curl -w "\n" http://localhost:3000/api/items
done
```

Po 10 požadavcích uvidíte:

```json
{
  "error": "Příliš mnoho požadavků",
  "message": "User rate limit překročen",
  "retryAfter": 58
}
```

---

## Pokročilé: Odstupňovaný Rate Limiting

Implementace různých limitů pro různé úrovně uživatelů:

```typescript
import { RateLimiter, type RateLimiterRef } from 'noex';

// Různé limitery pro různé úrovně
const tierLimiters = new Map<string, RateLimiterRef>();

export async function initTieredLimiters(): Promise<void> {
  // Free tier: 10 požadavků za minutu
  tierLimiters.set('free', await RateLimiter.start({
    maxRequests: 10,
    windowMs: 60000,
    name: 'free-tier-limiter',
  }));

  // Pro tier: 100 požadavků za minutu
  tierLimiters.set('pro', await RateLimiter.start({
    maxRequests: 100,
    windowMs: 60000,
    name: 'pro-tier-limiter',
  }));

  // Enterprise tier: 1000 požadavků za minutu
  tierLimiters.set('enterprise', await RateLimiter.start({
    maxRequests: 1000,
    windowMs: 60000,
    name: 'enterprise-tier-limiter',
  }));
}

export async function checkTieredLimit(
  userId: string,
  tier: 'free' | 'pro' | 'enterprise'
): Promise<{ allowed: boolean; remaining: number; retryAfter?: number }> {
  const limiter = tierLimiters.get(tier);
  if (!limiter) {
    throw new Error(`Neznámá úroveň: ${tier}`);
  }

  const result = await RateLimiter.check(limiter, userId);

  return {
    allowed: result.allowed,
    remaining: result.remaining,
    retryAfter: result.allowed ? undefined : result.retryAfterMs,
  };
}
```

---

## Pokročilé: Endpoint-Specific Limity

Aplikace různých limitů na různé endpointy:

```typescript
import { RateLimiter, RateLimitExceededError, type RateLimiterRef } from 'noex';
import type { Request, Response, NextFunction } from 'express';

const endpointLimiters = new Map<string, RateLimiterRef>();

export async function initEndpointLimiters(): Promise<void> {
  // Striktní limit pro náročné operace
  endpointLimiters.set('search', await RateLimiter.start({
    maxRequests: 5,
    windowMs: 60000,
    name: 'search-limiter',
  }));

  // Uvolněný limit pro čtecí operace
  endpointLimiters.set('read', await RateLimiter.start({
    maxRequests: 100,
    windowMs: 60000,
    name: 'read-limiter',
  }));

  // Velmi striktní limit pro zápisové operace
  endpointLimiters.set('write', await RateLimiter.start({
    maxRequests: 10,
    windowMs: 60000,
    name: 'write-limiter',
  }));
}

export function endpointRateLimit(type: 'search' | 'read' | 'write') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const limiter = endpointLimiters.get(type);
    if (!limiter) {
      next();
      return;
    }

    const userId = req.headers['x-api-key'] as string || req.ip || 'anonymous';

    try {
      await RateLimiter.consume(limiter, userId);
      next();
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        res.status(429).json({
          error: 'Příliš mnoho požadavků',
          message: `Rate limit překročen pro ${type} operace`,
          retryAfter: Math.ceil(error.retryAfterMs / 1000),
        });
      } else {
        next(error);
      }
    }
  };
}

// Použití v routách:
// router.get('/search', endpointRateLimit('search'), searchHandler);
// router.get('/items', endpointRateLimit('read'), listHandler);
// router.post('/items', endpointRateLimit('write'), createHandler);
```

---

## Cvičení

### 1. Přidání Redis-based Rate Limitingu

Pro distribuované systémy implementujte Redis-backed rate limiter, který funguje napříč více instancemi serveru.

### 2. Přidání Rate Limit Bypass pro admin uživatele

Implementujte middleware, který obchází rate limiting pro uživatele s admin oprávněními.

### 3. Přidání Rate Limit Monitoringu

Použijte Observer k monitorování statistik rate limiteru a zobrazte je na dashboardu.

### 4. Implementace Sliding Log s Cleanup

Naplánujte periodický úklid zastaralých rate limit záznamů:

```typescript
// Úklid každých 5 minut
setInterval(() => {
  RateLimiter.cleanup(globalLimiter);
  RateLimiter.cleanup(userLimiter);
}, 300000);
```

---

## Další kroky

- [Tutoriál E-commerce Backend](./ecommerce-backend.md) - Vytvoření kompletního backendu se supervizí
- [Tutoriál Monitoring Dashboard](./monitoring-dashboard.md) - Přidání real-time monitoringu
- [RateLimiter API](../api/rate-limiter.md) - Kompletní API reference
