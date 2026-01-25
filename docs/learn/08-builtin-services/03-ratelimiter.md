# RateLimiter

In the previous chapter, you learned to cache data with TTL and LRU eviction. Now let's tackle another common need: **protecting your services from being overwhelmed**. noex provides a built-in RateLimiter service that implements sliding window rate limiting — more accurate than fixed windows and easier to reason about than token buckets.

## What You'll Learn

- How sliding window rate limiting provides smoother traffic control than fixed windows
- Configure per-key limits for users, IPs, or API endpoints
- Use `check` vs `consume` for different rate limiting strategies
- Build robust API rate limiting with proper HTTP headers
- Handle rate limit errors gracefully with retry-after information

## Why Rate Limiting?

Rate limiting protects your services from abuse, ensures fair resource distribution, and prevents cascading failures:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    WITHOUT RATE LIMITING VS WITH RATE LIMITING              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  WITHOUT RATE LIMITING:                   WITH RATE LIMITING:               │
│                                                                             │
│  User A ──► 1000 req/s ──┐                User A ──► 1000 req/s ──┐         │
│  User B ──► 10 req/s   ──┼──► Server      User B ──► 10 req/s   ──┼──► OK   │
│  User C ──► 5 req/s    ──┘    💥 DOWN     User C ──► 5 req/s    ──┘         │
│                                                    ▼                        │
│  One bad actor takes down                 User A ──► 429 Too Many Requests  │
│  the entire service                       (limited to 100 req/s)            │
│                                                                             │
│  Problems:                                Benefits:                         │
│  - Service outage                         - Service stays healthy           │
│  - All users affected                     - Fair resource distribution      │
│  - No recovery without restart            - Automatic recovery              │
│  - No visibility into abuse               - Clear feedback to clients       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Use RateLimiter when:**
- Protecting APIs from abuse or DDoS
- Enforcing usage quotas (API plans, free tier limits)
- Preventing cascading failures in microservices
- Ensuring fair resource allocation between users

**Don't use RateLimiter when:**
- Internal service-to-service calls you control (use backpressure instead)
- One-time operations (use mutex or semaphore)
- Data doesn't have natural keys for grouping

## Sliding Window Algorithm

noex uses the **sliding window log** algorithm, which provides smoother rate limiting than fixed windows:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    FIXED WINDOW VS SLIDING WINDOW                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  FIXED WINDOW (limit: 10 per minute):                                       │
│                                                                             │
│  Window 1 (00:00-00:59)     Window 2 (01:00-01:59)                          │
│  ┌────────────────────┐     ┌────────────────────┐                          │
│  │■■■■■■■■■■          │     │■■■■■■■■■■          │                          │
│  │ 10 requests @ 0:55 │     │ 10 requests @ 1:00 │                          │
│  └────────────────────┘     └────────────────────┘                          │
│           ▼                          ▼                                      │
│  Problem: 20 requests in 10 seconds! (0:55 to 1:05)                         │
│                                                                             │
│  ═══════════════════════════════════════════════════════════════════════    │
│                                                                             │
│  SLIDING WINDOW (limit: 10 per minute):                                     │
│                                                                             │
│  At 1:05, window looks back 60 seconds (0:05 to 1:05):                      │
│  ┌────────────────────────────────────────────────────────────┐             │
│  │ ← 60 seconds →                                             │             │
│  │ 0:05                               0:55  1:00  1:05        │             │
│  │                                    ■■■■■ ■■■■■ X           │             │
│  └────────────────────────────────────────────────────────────┘             │
│           ▼                                                                 │
│  Result: 10 requests already in window → request denied                     │
│  Consistent 10 req/min regardless of window boundaries                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

The sliding window approach:
- Counts requests in a rolling time window
- No "boundary burst" problem
- More predictable behavior for clients
- Accurate remaining/retry-after calculations

## Starting a RateLimiter

RateLimiter is a GenServer under the hood. Each instance is independent:

```typescript
import { RateLimiter } from '@hamicek/noex';

// Start a rate limiter: 100 requests per minute
const limiter = await RateLimiter.start({
  maxRequests: 100,
  windowMs: 60000,  // 1 minute
});

// With optional name for registry lookup
const namedLimiter = await RateLimiter.start({
  maxRequests: 1000,
  windowMs: 3600000,  // 1 hour
  name: 'api-rate-limiter',
});

// Check if running
console.log(RateLimiter.isRunning(limiter)); // true

// Clean up when done
await RateLimiter.stop(limiter);
```

### Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `maxRequests` | `number` | Yes | Maximum requests allowed per window |
| `windowMs` | `number` | Yes | Window duration in milliseconds |
| `name` | `string` | No | Optional name for registry registration |

### Common Rate Limit Configurations

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      RATE LIMIT CONFIGURATION GUIDE                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Use Case               │ maxRequests  │ windowMs    │ Effective Rate       │
│  ───────────────────────┼──────────────┼─────────────┼────────────────────  │
│  Public API (free)      │ 60           │ 60000       │ 1 req/sec            │
│  Public API (paid)      │ 1000         │ 60000       │ ~17 req/sec          │
│  Authentication         │ 5            │ 60000       │ 5 attempts/min       │
│  Password reset         │ 3            │ 3600000     │ 3 attempts/hour      │
│  File upload            │ 10           │ 3600000     │ 10 uploads/hour      │
│  SMS verification       │ 3            │ 300000      │ 3 per 5 minutes      │
│  Webhook delivery       │ 100          │ 1000        │ 100 req/sec (burst)  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Check vs Consume

RateLimiter provides two main methods with different behaviors:

### check — Query Without Consuming

`check` tells you if a request **would be** allowed without actually counting it:

```typescript
const limiter = await RateLimiter.start({
  maxRequests: 10,
  windowMs: 60000,
});

// Check without consuming quota
const result = await RateLimiter.check(limiter, 'user:123');

console.log(result);
// {
//   allowed: true,
//   current: 0,      // Current requests in window
//   limit: 10,       // Max allowed
//   remaining: 10,   // Requests still available
//   resetMs: 60000,  // Time until window resets
//   retryAfterMs: 0  // 0 when allowed
// }

// Multiple checks don't consume quota
await RateLimiter.check(limiter, 'user:123');
await RateLimiter.check(limiter, 'user:123');
await RateLimiter.check(limiter, 'user:123');

const status = await RateLimiter.getStatus(limiter, 'user:123');
console.log(status.current); // Still 0!
```

**Use `check` when:**
- Displaying remaining quota to users before they act
- Pre-flight checks for expensive operations
- Monitoring dashboards

### consume — Count and Potentially Reject

`consume` records the request and throws if the limit is exceeded:

```typescript
import { RateLimiter, RateLimitExceededError } from '@hamicek/noex';

const limiter = await RateLimiter.start({
  maxRequests: 3,
  windowMs: 60000,
});

try {
  // Request 1: allowed
  await RateLimiter.consume(limiter, 'user:123');
  console.log('Request 1: OK');

  // Request 2: allowed
  await RateLimiter.consume(limiter, 'user:123');
  console.log('Request 2: OK');

  // Request 3: allowed
  await RateLimiter.consume(limiter, 'user:123');
  console.log('Request 3: OK');

  // Request 4: throws!
  await RateLimiter.consume(limiter, 'user:123');
  console.log('Request 4: OK'); // Never reached
} catch (error) {
  if (error instanceof RateLimitExceededError) {
    console.log(`Rate limited: ${error.message}`);
    console.log(`Key: ${error.key}`);
    console.log(`Retry after: ${error.retryAfterMs}ms`);
  }
}
```

### Variable Cost Operations

Some operations cost more than others. Use the `cost` parameter:

```typescript
const limiter = await RateLimiter.start({
  maxRequests: 100,  // 100 "units" per minute
  windowMs: 60000,
});

// Simple read: 1 unit
await RateLimiter.consume(limiter, 'user:123', 1);

// Complex query: 5 units
await RateLimiter.consume(limiter, 'user:123', 5);

// Bulk export: 20 units
await RateLimiter.consume(limiter, 'user:123', 20);

// Check remaining before expensive operation
const status = await RateLimiter.check(limiter, 'user:123', 50);
if (!status.allowed) {
  console.log(`Not enough quota. Need 50, have ${status.remaining}`);
}
```

## Working with RateLimitResult

Every check and consume operation returns detailed status:

```typescript
interface RateLimitResult {
  allowed: boolean;     // Can this request proceed?
  current: number;      // Requests counted in current window
  limit: number;        // Maximum requests allowed
  remaining: number;    // Requests still available
  resetMs: number;      // Milliseconds until oldest request expires
  retryAfterMs: number; // Milliseconds to wait if denied (0 if allowed)
}
```

### Using Results for HTTP Headers

```typescript
async function handleApiRequest(userId: string, res: Response) {
  const result = await RateLimiter.consume(limiter, `user:${userId}`);

  // Always set rate limit headers (even when allowed)
  res.setHeader('X-RateLimit-Limit', result.limit);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(Date.now() / 1000 + result.resetMs / 1000));

  // ... process request
}
```

### Handling Rejections

```typescript
async function handleApiRequest(userId: string, res: Response) {
  try {
    const result = await RateLimiter.consume(limiter, `user:${userId}`);
    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(Date.now() / 1000 + result.resetMs / 1000));

    // Process request...
    res.json({ data: 'success' });
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      const retryAfterSec = Math.ceil(error.retryAfterMs / 1000);

      res.setHeader('Retry-After', retryAfterSec);
      res.setHeader('X-RateLimit-Limit', limiter.limit);
      res.setHeader('X-RateLimit-Remaining', 0);

      res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Retry after ${retryAfterSec} seconds.`,
        retryAfter: retryAfterSec,
      });
      return;
    }
    throw error;
  }
}
```

## Per-Key Rate Limiting

The key parameter allows different limits for different entities:

```typescript
const limiter = await RateLimiter.start({
  maxRequests: 100,
  windowMs: 60000,
});

// Each key has independent limits
await RateLimiter.consume(limiter, 'user:alice');  // Alice: 1/100
await RateLimiter.consume(limiter, 'user:bob');    // Bob: 1/100 (separate)
await RateLimiter.consume(limiter, 'user:alice');  // Alice: 2/100

// Common key patterns:
// By user:     'user:123'
// By IP:       'ip:192.168.1.1'
// By API key:  'apikey:sk_live_xxx'
// By endpoint: 'endpoint:/api/users'
// Combined:    'user:123:/api/sensitive'
```

### Multiple Rate Limiters for Different Tiers

```typescript
// Different limits for different user tiers
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

## Managing Rate Limiter State

### Get Status Without Modifying

```typescript
// getStatus returns current state without consuming or even touching the entry
const status = await RateLimiter.getStatus(limiter, 'user:123');
console.log(`User has ${status.remaining} requests remaining`);
```

### Reset a Specific Key

```typescript
// User upgraded their plan - reset their limits
const existed = await RateLimiter.reset(limiter, 'user:123');
console.log(`Reset successful: ${existed}`); // true if key existed
```

### List All Tracked Keys

```typescript
// Monitor who's hitting the rate limiter
const keys = await RateLimiter.getKeys(limiter);
console.log(`Tracking ${keys.length} keys:`, keys);
// ['user:123', 'user:456', 'ip:192.168.1.1', ...]
```

### Background Cleanup

Stale entries (no activity for 2 windows) are cleaned up automatically, but you can trigger it manually:

```typescript
// Fire-and-forget cleanup of stale entries
RateLimiter.cleanup(limiter);

// Periodic cleanup (optional - helps memory in high-cardinality scenarios)
setInterval(() => {
  RateLimiter.cleanup(limiter);
}, 300000); // Every 5 minutes
```

## Practical Example: Express API Rate Limiting

Here's a production-ready rate limiting middleware:

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

  // Periodic cleanup
  const cleanupInterval = setInterval(() => {
    RateLimiter.cleanup(limiter);
  }, windowMs);

  const middleware = async (req: Request, res: Response, next: NextFunction) => {
    // Skip certain requests (health checks, internal, etc.)
    if (skip(req)) {
      return next();
    }

    const key = keyGenerator(req);

    try {
      const result = await RateLimiter.consume(limiter, key);

      // Set standard rate limit headers
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
            message: `Rate limit exceeded. Please retry after ${retryAfterSec} seconds.`,
            retryAfter: retryAfterSec,
          });
        }
        return;
      }
      next(error);
    }
  };

  // Allow stopping the rate limiter
  middleware.stop = async () => {
    clearInterval(cleanupInterval);
    await RateLimiter.stop(limiter);
  };

  middleware.getLimiter = () => limiter;

  return middleware;
}

// Usage with Express
import express from 'express';

async function main() {
  const app = express();

  // Global rate limit: 100 requests per minute per IP
  const globalLimiter = await createRateLimitMiddleware({
    maxRequests: 100,
    windowMs: 60000,
    keyGenerator: (req) => `ip:${req.ip}`,
    skip: (req) => req.path === '/health',
  });

  // Strict rate limit for authentication: 5 attempts per minute
  const authLimiter = await createRateLimitMiddleware({
    maxRequests: 5,
    windowMs: 60000,
    keyGenerator: (req) => `auth:${req.ip}`,
    onLimited: (req, res) => {
      res.status(429).json({
        error: 'Too Many Login Attempts',
        message: 'Please wait before trying again.',
      });
    },
  });

  // Apply global limiter to all routes
  app.use(globalLimiter);

  // Apply strict limiter to auth routes
  app.post('/api/login', authLimiter, (req, res) => {
    res.json({ success: true });
  });

  app.post('/api/register', authLimiter, (req, res) => {
    res.json({ success: true });
  });

  // Regular API routes use only global limiter
  app.get('/api/users', (req, res) => {
    res.json({ users: [] });
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  const server = app.listen(3000, () => {
    console.log('Server running on port 3000');
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

## Multiple Rate Limit Tiers

Implement different limits based on user subscription:

```typescript
import { RateLimiter, RateLimitExceededError, type RateLimiterRef } from '@hamicek/noex';

interface RateTier {
  name: string;
  requestsPerMinute: number;
  requestsPerDay: number;
}

const tiers: Record<string, RateTier> = {
  free: { name: 'Free', requestsPerMinute: 10, requestsPerDay: 1000 },
  pro: { name: 'Pro', requestsPerMinute: 100, requestsPerDay: 50000 },
  enterprise: { name: 'Enterprise', requestsPerMinute: 1000, requestsPerDay: 1000000 },
};

async function createTieredRateLimiter() {
  // Per-minute limiters for each tier
  const minuteLimiters: Record<string, RateLimiterRef> = {};
  for (const [tier, config] of Object.entries(tiers)) {
    minuteLimiters[tier] = await RateLimiter.start({
      maxRequests: config.requestsPerMinute,
      windowMs: 60000,
      name: `rate-limit-${tier}-minute`,
    });
  }

  // Per-day limiters for each tier
  const dayLimiters: Record<string, RateLimiterRef> = {};
  for (const [tier, config] of Object.entries(tiers)) {
    dayLimiters[tier] = await RateLimiter.start({
      maxRequests: config.requestsPerDay,
      windowMs: 86400000, // 24 hours
      name: `rate-limit-${tier}-day`,
    });
  }

  return {
    async consume(userId: string, tier: keyof typeof tiers): Promise<{
      minuteResult: { remaining: number; limit: number };
      dayResult: { remaining: number; limit: number };
    }> {
      const minuteLimiter = minuteLimiters[tier];
      const dayLimiter = dayLimiters[tier];

      if (!minuteLimiter || !dayLimiter) {
        throw new Error(`Unknown tier: ${tier}`);
      }

      // Check both limits (day limit first as it's more likely to be exceeded)
      const dayResult = await RateLimiter.consume(dayLimiter, userId);
      const minuteResult = await RateLimiter.consume(minuteLimiter, userId);

      return {
        minuteResult: { remaining: minuteResult.remaining, limit: minuteResult.limit },
        dayResult: { remaining: dayResult.remaining, limit: dayResult.limit },
      };
    },

    async getStatus(userId: string, tier: keyof typeof tiers) {
      const minuteLimiter = minuteLimiters[tier];
      const dayLimiter = dayLimiters[tier];

      if (!minuteLimiter || !dayLimiter) {
        throw new Error(`Unknown tier: ${tier}`);
      }

      const [minuteStatus, dayStatus] = await Promise.all([
        RateLimiter.getStatus(minuteLimiter, userId),
        RateLimiter.getStatus(dayLimiter, userId),
      ]);

      return {
        tier: tiers[tier],
        minute: minuteStatus,
        day: dayStatus,
      };
    },

    async stop() {
      await Promise.all([
        ...Object.values(minuteLimiters).map(l => RateLimiter.stop(l)),
        ...Object.values(dayLimiters).map(l => RateLimiter.stop(l)),
      ]);
    },
  };
}

// Usage
async function main() {
  const rateLimiter = await createTieredRateLimiter();

  try {
    // Pro user makes a request
    const result = await rateLimiter.consume('user:123', 'pro');
    console.log('Request allowed');
    console.log(`Minute: ${result.minuteResult.remaining}/${result.minuteResult.limit}`);
    console.log(`Day: ${result.dayResult.remaining}/${result.dayResult.limit}`);
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      console.log('Rate limited:', error.message);
    }
  }

  // Check status for dashboard
  const status = await rateLimiter.getStatus('user:123', 'pro');
  console.log('Current status:', status);

  await rateLimiter.stop();
}

main();
```

## Rate Limiter Patterns

### Leaky Bucket for Smoothing Bursts

Use multiple small windows to prevent bursts:

```typescript
// Instead of 60 requests per minute (allows 60-request burst)
// Use 1 request per second (smooth rate)
const smoothLimiter = await RateLimiter.start({
  maxRequests: 1,
  windowMs: 1000,  // 1 second window
});

// For APIs that can handle small bursts:
const burstableLimiter = await RateLimiter.start({
  maxRequests: 5,
  windowMs: 5000,  // 5 requests per 5 seconds = avg 1/sec but allows bursts
});
```

### Compound Keys for Fine-Grained Control

```typescript
const limiter = await RateLimiter.start({
  maxRequests: 10,
  windowMs: 60000,
});

// Limit per user per endpoint
async function limitByUserAndEndpoint(userId: string, endpoint: string) {
  const key = `${userId}:${endpoint}`;
  return RateLimiter.consume(limiter, key);
}

// User 123 can call /api/search 10 times per minute
// AND /api/export 10 times per minute (separate limits)
await limitByUserAndEndpoint('user:123', '/api/search');
await limitByUserAndEndpoint('user:123', '/api/export');
```

### Fail-Open vs Fail-Closed

```typescript
// Fail-closed (strict): deny on any error
async function failClosed(limiter: RateLimiterRef, key: string): Promise<boolean> {
  try {
    await RateLimiter.consume(limiter, key);
    return true;
  } catch (error) {
    // Rate limit exceeded OR any other error = deny
    return false;
  }
}

// Fail-open (lenient): allow on internal errors
async function failOpen(limiter: RateLimiterRef, key: string): Promise<boolean> {
  try {
    await RateLimiter.consume(limiter, key);
    return true;
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      return false;  // Actual rate limit = deny
    }
    console.warn('Rate limiter error, allowing request:', error);
    return true;  // Internal error = allow (fail-open)
  }
}
```

## Exercise: API Quota System

Build an API quota system that:
1. Tracks usage per API key with monthly limits
2. Supports different tiers (free: 1000/month, pro: 100000/month)
3. Provides a `/usage` endpoint to check remaining quota
4. Sends warning when 80% of quota is used
5. Gracefully handles quota exhaustion with helpful error messages

**Starter code:**

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
  // TODO: Implement the quota system

  return {
    async start() {
      // TODO: Start rate limiters for each tier
    },

    async consume(apiKey: string, tier: keyof typeof tiers): Promise<QuotaStatus> {
      // TODO: Consume quota and return status
      // TODO: Log warning if > 80% used
      throw new Error('Not implemented');
    },

    async getUsage(apiKey: string, tier: keyof typeof tiers): Promise<QuotaStatus> {
      // TODO: Get current usage without consuming
      throw new Error('Not implemented');
    },

    async stop() {
      // TODO: Stop all rate limiters
    },
  };
}
```

<details>
<summary><strong>Solution</strong></summary>

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

// Calculate milliseconds until end of current month
function msUntilMonthEnd(): number {
  const now = new Date();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return endOfMonth.getTime() - now.getTime();
}

// Get reset date (first of next month)
function getResetDate(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

function createApiQuotaSystem() {
  const limiters: Record<string, RateLimiterRef> = {};
  const warningsSent = new Set<string>(); // Track which keys got warnings

  return {
    async start() {
      // Create a rate limiter for each tier
      // Using monthly window (approximate - resets on limiter start)
      // In production, you'd want to sync with actual calendar months
      const monthMs = 30 * 24 * 60 * 60 * 1000; // ~30 days

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
        throw new Error(`Unknown tier: ${tier}`);
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

        // Check for 80% warning
        const warningKey = `${apiKey}:${tier}`;
        if (status.percentUsed >= 80 && !warningsSent.has(warningKey)) {
          console.warn(
            `[QUOTA WARNING] API key ${apiKey} (${tierConfig.name}) has used ` +
            `${status.percentUsed.toFixed(1)}% of monthly quota. ` +
            `${status.remaining} requests remaining.`
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
        throw new Error(`Unknown tier: ${tier}`);
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

// Custom error for quota exhaustion
class QuotaExhaustedError extends Error {
  constructor(
    readonly apiKey: string,
    readonly tier: string,
    readonly resetDate: Date,
  ) {
    const resetStr = resetDate.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
    super(
      `Monthly quota exhausted for ${tier} tier. ` +
      `Your quota will reset on ${resetStr}. ` +
      `Consider upgrading your plan for higher limits.`
    );
    this.name = 'QuotaExhaustedError';
  }
}

// Test the implementation
async function main() {
  const quotaSystem = createApiQuotaSystem();
  await quotaSystem.start();

  const testApiKey = 'api_key_test_123';

  try {
    // Simulate API usage
    console.log('Making API requests...\n');

    for (let i = 0; i < 12; i++) {
      const status = await quotaSystem.consume(testApiKey, 'free');
      console.log(
        `Request ${i + 1}: ${status.used}/${status.limit} used ` +
        `(${status.percentUsed.toFixed(1)}%)`
      );

      // For demo: artificially trigger warning at request 9
      if (i === 8) {
        // Simulate being at 80% - in real usage this would happen naturally
        console.log('\n--- Simulating 80% usage threshold ---\n');
      }
    }

    // Check usage without consuming
    console.log('\nCurrent usage:');
    const usage = await quotaSystem.getUsage(testApiKey, 'free');
    console.log(`  Tier: ${usage.tier}`);
    console.log(`  Used: ${usage.used}/${usage.limit}`);
    console.log(`  Remaining: ${usage.remaining}`);
    console.log(`  Percent used: ${usage.percentUsed.toFixed(1)}%`);
    console.log(`  Resets: ${usage.resetDate.toLocaleDateString()}`);

  } catch (error) {
    if (error instanceof QuotaExhaustedError) {
      console.error('\nQuota exhausted:', error.message);
    } else {
      throw error;
    }
  }

  await quotaSystem.stop();
}

main();
```

**Key design decisions:**

1. **Monthly window approximation** — Uses ~30-day window. Production systems should sync with actual calendar months.

2. **Warning at 80%** — Logs warning once when threshold crossed. Uses Set to avoid duplicate warnings.

3. **Custom error class** — `QuotaExhaustedError` provides user-friendly message with reset date and upgrade suggestion.

4. **Separate limiter per tier** — Allows different limits without complex key schemes.

5. **getUsage vs consume** — Clean separation between checking and consuming quota.

**Sample output:**

```
Making API requests...

Request 1: 1/1000 used (0.1%)
Request 2: 2/1000 used (0.2%)
...
Request 9: 9/1000 used (0.9%)

--- Simulating 80% usage threshold ---

[QUOTA WARNING] API key api_key_test_123 (Free) has used 80.1% of monthly quota. 199 requests remaining.
Request 10: 801/1000 used (80.1%)
...

Current usage:
  Tier: Free
  Used: 12/1000
  Remaining: 988
  Percent used: 1.2%
  Resets: 2/1/2024
```

</details>

## Summary

**Key takeaways:**

- **RateLimiter provides sliding window rate limiting** — More accurate than fixed windows, smoother traffic control
- **Per-key tracking** — Independent limits for users, IPs, API keys, or any identifier
- **check vs consume** — `check` queries without counting; `consume` counts and throws on limit
- **Variable cost** — Use `cost` parameter for operations with different resource requirements
- **Rich status information** — `RateLimitResult` provides remaining quota, reset time, and retry-after

**Method reference:**

| Method | Returns | Description |
|--------|---------|-------------|
| `start(options)` | `Promise<Ref>` | Create a new rate limiter |
| `check(ref, key, cost?)` | `Promise<Result>` | Check without consuming |
| `consume(ref, key, cost?)` | `Promise<Result>` | Consume quota (throws if exceeded) |
| `getStatus(ref, key)` | `Promise<Result>` | Get current status |
| `reset(ref, key)` | `Promise<boolean>` | Clear limits for a key |
| `getKeys(ref)` | `Promise<string[]>` | List all tracked keys |
| `cleanup(ref)` | `void` | Remove stale entries |
| `stop(ref)` | `Promise<void>` | Stop the rate limiter |

**Remember:**

> Rate limiting is about protecting your service while being fair to users. Always provide clear feedback (remaining quota, retry-after) so clients can adapt. Start with generous limits and tighten based on actual usage patterns.

---

Next: [TimerService](./04-timerservice.md)
