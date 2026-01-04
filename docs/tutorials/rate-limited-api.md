# Tutorial: Building a Rate-Limited API

In this tutorial, you'll build a REST API with rate limiting using noex. You'll learn how to:
- Create API endpoints with Express
- Use the RateLimiter service for request throttling
- Implement per-user and per-endpoint limits
- Return proper rate limit headers and error responses

## Prerequisites

- Node.js 18+
- Basic TypeScript knowledge
- Understanding of noex GenServer basics

## Project Setup

Create a new project:

```bash
mkdir rate-limited-api
cd rate-limited-api
npm init -y
npm install noex express
npm install -D typescript tsx @types/node @types/express
```

Create `tsconfig.json`:

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

## Architecture Overview

```
                    [AppSupervisor]
                    /      |      \
         [GlobalLimiter] [UserLimiter] [API Server]
              |              |
         100 req/min    10 req/min per user
```

The API uses two rate limiters:
- **Global Limiter**: Protects the API from overwhelming traffic (100 requests/minute)
- **User Limiter**: Limits individual users (10 requests/minute per user)

---

## Step 1: Rate Limiter Service

Create `src/limiters.ts`:

```typescript
import { RateLimiter, type RateLimiterRef } from 'noex';

// Limiter references
let globalLimiter: RateLimiterRef | null = null;
let userLimiter: RateLimiterRef | null = null;

/**
 * Initialize rate limiters
 */
export async function initLimiters(): Promise<void> {
  // Global rate limit: 100 requests per minute
  globalLimiter = await RateLimiter.start({
    maxRequests: 100,
    windowMs: 60000,
    name: 'global-limiter',
  });

  // Per-user rate limit: 10 requests per minute
  userLimiter = await RateLimiter.start({
    maxRequests: 10,
    windowMs: 60000,
    name: 'user-limiter',
  });

  console.log('Rate limiters initialized');
}

/**
 * Get the global rate limiter
 */
export function getGlobalLimiter(): RateLimiterRef {
  if (!globalLimiter) {
    throw new Error('Global limiter not initialized');
  }
  return globalLimiter;
}

/**
 * Get the user rate limiter
 */
export function getUserLimiter(): RateLimiterRef {
  if (!userLimiter) {
    throw new Error('User limiter not initialized');
  }
  return userLimiter;
}

/**
 * Stop all rate limiters
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

## Step 2: Rate Limit Middleware

Create `src/middleware.ts`:

```typescript
import type { Request, Response, NextFunction } from 'express';
import { RateLimiter, RateLimitExceededError } from 'noex';
import { getGlobalLimiter, getUserLimiter } from './limiters.js';

/**
 * Express middleware for global rate limiting
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
        error: 'Too Many Requests',
        message: 'Global rate limit exceeded',
        retryAfter: Math.ceil(error.retryAfterMs / 1000),
      });
    } else {
      next(error);
    }
  }
}

/**
 * Express middleware for per-user rate limiting
 */
export async function userRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const limiter = getUserLimiter();

  // Use API key, user ID, or IP address as the rate limit key
  const userId = req.headers['x-api-key'] as string || req.ip || 'anonymous';
  const key = `user:${userId}`;

  try {
    const result = await RateLimiter.consume(limiter, key);
    setRateLimitHeaders(res, result);
    next();
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      res.status(429).json({
        error: 'Too Many Requests',
        message: 'User rate limit exceeded',
        retryAfter: Math.ceil(error.retryAfterMs / 1000),
      });
    } else {
      next(error);
    }
  }
}

/**
 * Set standard rate limit headers
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

## Step 3: API Endpoints

Create `src/routes.ts`:

```typescript
import { Router } from 'express';
import { RateLimiter } from 'noex';
import { getGlobalLimiter, getUserLimiter } from './limiters.js';

const router = Router();

// Sample data store
const items = new Map<string, { id: string; name: string; price: number }>();

/**
 * GET /api/items - List all items
 */
router.get('/items', (_req, res) => {
  const allItems = Array.from(items.values());
  res.json({ items: allItems, count: allItems.length });
});

/**
 * GET /api/items/:id - Get item by ID
 */
router.get('/items/:id', (req, res) => {
  const item = items.get(req.params.id);

  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }

  res.json(item);
});

/**
 * POST /api/items - Create new item
 */
router.post('/items', (req, res) => {
  const { name, price } = req.body;

  if (!name || typeof price !== 'number') {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }

  const id = `item_${Date.now()}`;
  const item = { id, name, price };
  items.set(id, item);

  res.status(201).json(item);
});

/**
 * DELETE /api/items/:id - Delete item
 */
router.delete('/items/:id', (req, res) => {
  const deleted = items.delete(req.params.id);

  if (!deleted) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }

  res.status(204).send();
});

/**
 * GET /api/rate-limit/status - Get current rate limit status
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

## Step 4: Server Setup

Create `src/server.ts`:

```typescript
import express from 'express';
import { Supervisor, type SupervisorRef } from 'noex';
import { initLimiters, stopLimiters } from './limiters.js';
import { globalRateLimitMiddleware, userRateLimitMiddleware } from './middleware.js';
import { router } from './routes.js';

let supervisor: SupervisorRef | null = null;

/**
 * Start the API server
 */
export async function startServer(port = 3000): Promise<void> {
  // Initialize rate limiters
  await initLimiters();

  // Create Express app
  const app = express();
  app.use(express.json());

  // Apply rate limiting middleware
  app.use('/api', globalRateLimitMiddleware);
  app.use('/api', userRateLimitMiddleware);

  // Mount routes
  app.use('/api', router);

  // Health check endpoint (no rate limiting)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  });

  // Start listening
  const server = app.listen(port, () => {
    console.log(`API server running at http://localhost:${port}`);
  });

  // Create supervisor for monitoring
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
  console.log('\nShutting down...');

  server.close();
  await stopLimiters();

  if (supervisor) {
    await Supervisor.stop(supervisor);
  }

  console.log('Shutdown complete');
  process.exit(0);
}
```

---

## Step 5: Entry Point

Create `src/index.ts`:

```typescript
import { startServer } from './server.js';

const port = parseInt(process.env.PORT || '3000', 10);

startServer(port).catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
```

---

## Step 6: Run and Test

Add scripts to `package.json`:

```json
{
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts"
  }
}
```

Run the server:

```bash
npm start
```

### Test the API

```bash
# Create an item
curl -X POST http://localhost:3000/api/items \
  -H "Content-Type: application/json" \
  -d '{"name": "Widget", "price": 9.99}'

# List items
curl http://localhost:3000/api/items

# Check rate limit status
curl http://localhost:3000/api/rate-limit/status

# Test rate limiting (run many times quickly)
for i in {1..15}; do
  curl -w "\n" http://localhost:3000/api/items
done
```

After 10 requests, you'll see:

```json
{
  "error": "Too Many Requests",
  "message": "User rate limit exceeded",
  "retryAfter": 58
}
```

---

## Advanced: Tiered Rate Limiting

Implement different limits for different user tiers:

```typescript
import { RateLimiter, type RateLimiterRef } from 'noex';

// Different limiters for different tiers
const tierLimiters = new Map<string, RateLimiterRef>();

export async function initTieredLimiters(): Promise<void> {
  // Free tier: 10 requests per minute
  tierLimiters.set('free', await RateLimiter.start({
    maxRequests: 10,
    windowMs: 60000,
    name: 'free-tier-limiter',
  }));

  // Pro tier: 100 requests per minute
  tierLimiters.set('pro', await RateLimiter.start({
    maxRequests: 100,
    windowMs: 60000,
    name: 'pro-tier-limiter',
  }));

  // Enterprise tier: 1000 requests per minute
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
    throw new Error(`Unknown tier: ${tier}`);
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

## Advanced: Endpoint-Specific Limits

Apply different limits to different endpoints:

```typescript
import { RateLimiter, RateLimitExceededError, type RateLimiterRef } from 'noex';
import type { Request, Response, NextFunction } from 'express';

const endpointLimiters = new Map<string, RateLimiterRef>();

export async function initEndpointLimiters(): Promise<void> {
  // Strict limit for expensive operations
  endpointLimiters.set('search', await RateLimiter.start({
    maxRequests: 5,
    windowMs: 60000,
    name: 'search-limiter',
  }));

  // Relaxed limit for read operations
  endpointLimiters.set('read', await RateLimiter.start({
    maxRequests: 100,
    windowMs: 60000,
    name: 'read-limiter',
  }));

  // Very strict limit for write operations
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
          error: 'Too Many Requests',
          message: `Rate limit exceeded for ${type} operations`,
          retryAfter: Math.ceil(error.retryAfterMs / 1000),
        });
      } else {
        next(error);
      }
    }
  };
}

// Usage in routes:
// router.get('/search', endpointRateLimit('search'), searchHandler);
// router.get('/items', endpointRateLimit('read'), listHandler);
// router.post('/items', endpointRateLimit('write'), createHandler);
```

---

## Exercises

### 1. Add Redis-based Rate Limiting

For distributed systems, implement a Redis-backed rate limiter that works across multiple server instances.

### 2. Add Rate Limit Bypass for Admin Users

Implement a middleware that bypasses rate limiting for users with admin privileges.

### 3. Add Rate Limit Monitoring

Use the Observer to monitor rate limiter statistics and display them on a dashboard.

### 4. Implement Sliding Log with Cleanup

Schedule periodic cleanup of stale rate limit entries:

```typescript
// Clean up every 5 minutes
setInterval(() => {
  RateLimiter.cleanup(globalLimiter);
  RateLimiter.cleanup(userLimiter);
}, 300000);
```

---

## Next Steps

- [E-commerce Backend Tutorial](./ecommerce-backend.md) - Build a complete backend with supervision
- [Monitoring Dashboard Tutorial](./monitoring-dashboard.md) - Add real-time monitoring
- [RateLimiter API](../api/rate-limiter.md) - Complete API reference
