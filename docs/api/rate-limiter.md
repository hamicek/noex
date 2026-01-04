# RateLimiter API Reference

The `RateLimiter` service provides sliding window rate limiting with per-key tracking. Built on GenServer, it offers accurate request throttling with configurable limits.

## Import

```typescript
import { RateLimiter, RateLimitExceededError } from 'noex';
```

## Types

### RateLimiterRef

Opaque reference to a running RateLimiter instance.

```typescript
type RateLimiterRef = GenServerRef<
  RateLimiterState,
  RateLimiterCallMsg,
  RateLimiterCastMsg,
  RateLimiterCallReply
>;
```

### RateLimiterOptions

Options for `RateLimiter.start()`.

```typescript
interface RateLimiterOptions {
  /**
   * Maximum number of requests allowed in the time window.
   */
  readonly maxRequests: number;

  /**
   * Time window in milliseconds.
   */
  readonly windowMs: number;

  /**
   * Optional name for registry registration.
   */
  readonly name?: string;
}
```

### RateLimitResult

Result of a rate limit check or consume operation.

```typescript
interface RateLimitResult {
  /** Whether the request is allowed */
  readonly allowed: boolean;

  /** Current number of requests in the window */
  readonly current: number;

  /** Maximum requests allowed */
  readonly limit: number;

  /** Remaining requests in the window */
  readonly remaining: number;

  /** Milliseconds until the window resets */
  readonly resetMs: number;

  /** Milliseconds to wait before retrying (0 if allowed) */
  readonly retryAfterMs: number;
}
```

### RateLimitExceededError

Error thrown when rate limit is exceeded.

```typescript
class RateLimitExceededError extends Error {
  readonly name = 'RateLimitExceededError';
  readonly key: string;
  readonly retryAfterMs: number;
}
```

---

## Methods

### start()

Starts a new RateLimiter instance.

```typescript
async start(options: RateLimiterOptions): Promise<RateLimiterRef>
```

**Parameters:**
- `options` - RateLimiter configuration (required)
  - `maxRequests` - Maximum requests allowed per window
  - `windowMs` - Window duration in milliseconds
  - `name` - Optional registry name

**Returns:** Promise resolving to a RateLimiterRef

**Example:**
```typescript
// 100 requests per minute
const limiter = await RateLimiter.start({
  maxRequests: 100,
  windowMs: 60000,
});

// 10 requests per second with registry name
const apiLimiter = await RateLimiter.start({
  maxRequests: 10,
  windowMs: 1000,
  name: 'api-limiter',
});
```

---

### check()

Checks if a request would be allowed without consuming quota.

```typescript
async check(
  ref: RateLimiterRef,
  key: string,
  cost?: number,
): Promise<RateLimitResult>
```

**Parameters:**
- `ref` - RateLimiter reference
- `key` - Rate limit key (e.g., `'user:123'`, `'ip:192.168.1.1'`)
- `cost` - Number of requests to check (default: 1)

**Returns:** Rate limit result with current status

**Example:**
```typescript
const result = await RateLimiter.check(limiter, 'user:123');

if (result.allowed) {
  console.log(`${result.remaining} requests remaining`);
} else {
  console.log(`Rate limited. Retry after ${result.retryAfterMs}ms`);
}
```

---

### consume()

Consumes quota for a request if allowed. Throws if rate limit is exceeded.

```typescript
async consume(
  ref: RateLimiterRef,
  key: string,
  cost?: number,
): Promise<RateLimitResult>
```

**Parameters:**
- `ref` - RateLimiter reference
- `key` - Rate limit key
- `cost` - Number of requests to consume (default: 1)

**Returns:** Rate limit result

**Throws:**
- `RateLimitExceededError` - If rate limit is exceeded

**Example:**
```typescript
try {
  const result = await RateLimiter.consume(limiter, 'api:endpoint');
  // Process the request
  console.log(`${result.remaining} requests remaining`);
} catch (e) {
  if (e instanceof RateLimitExceededError) {
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: e.retryAfterMs,
    });
  }
}
```

---

### getStatus()

Gets the current status for a key without modifying state.

```typescript
async getStatus(ref: RateLimiterRef, key: string): Promise<RateLimitResult>
```

**Parameters:**
- `ref` - RateLimiter reference
- `key` - Rate limit key

**Returns:** Current rate limit status

**Example:**
```typescript
const status = await RateLimiter.getStatus(limiter, 'user:123');
console.log(`Used: ${status.current}/${status.limit}`);
console.log(`Resets in: ${status.resetMs}ms`);
```

---

### reset()

Resets rate limit state for a specific key.

```typescript
async reset(ref: RateLimiterRef, key: string): Promise<boolean>
```

**Parameters:**
- `ref` - RateLimiter reference
- `key` - Rate limit key to reset

**Returns:** `true` if the key existed

**Example:**
```typescript
// Reset limit for a user (e.g., after payment)
await RateLimiter.reset(limiter, 'user:123');
```

---

### getKeys()

Returns all tracked keys.

```typescript
async getKeys(ref: RateLimiterRef): Promise<readonly string[]>
```

**Parameters:**
- `ref` - RateLimiter reference

**Returns:** Array of tracked keys

**Example:**
```typescript
const keys = await RateLimiter.getKeys(limiter);
console.log(`Tracking ${keys.length} clients`);
```

---

### cleanup()

Triggers cleanup of stale entries. This is a fire-and-forget operation.

```typescript
cleanup(ref: RateLimiterRef): void
```

**Parameters:**
- `ref` - RateLimiter reference

**Example:**
```typescript
// Periodically clean up inactive entries
setInterval(() => {
  RateLimiter.cleanup(limiter);
}, 300000); // Every 5 minutes
```

---

### isRunning()

Checks if the RateLimiter is running.

```typescript
isRunning(ref: RateLimiterRef): boolean
```

**Parameters:**
- `ref` - RateLimiter reference

**Returns:** `true` if running

---

### stop()

Gracefully stops the RateLimiter.

```typescript
async stop(ref: RateLimiterRef): Promise<void>
```

**Parameters:**
- `ref` - RateLimiter reference

---

## Complete Example

```typescript
import { RateLimiter, RateLimitExceededError } from 'noex';

async function main() {
  // Create rate limiter: 100 requests per minute
  const limiter = await RateLimiter.start({
    maxRequests: 100,
    windowMs: 60000,
    name: 'api-rate-limiter',
  });

  // Express middleware example
  async function rateLimitMiddleware(req, res, next) {
    const key = `ip:${req.ip}`;

    try {
      const result = await RateLimiter.consume(limiter, key);

      // Add rate limit headers
      res.set('X-RateLimit-Limit', String(result.limit));
      res.set('X-RateLimit-Remaining', String(result.remaining));
      res.set('X-RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));

      next();
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        res.status(429).json({
          error: 'Too Many Requests',
          retryAfter: Math.ceil(error.retryAfterMs / 1000),
        });
      } else {
        next(error);
      }
    }
  }

  // Tiered rate limiting example
  async function tierRateLimit(userId: string, tier: 'free' | 'pro') {
    // Different limits per tier
    const key = tier === 'pro' ? `pro:${userId}` : `free:${userId}`;
    const cost = tier === 'free' ? 2 : 1; // Free tier consumes more quota

    return RateLimiter.consume(limiter, key, cost);
  }

  // Cleanup on shutdown
  process.on('SIGTERM', async () => {
    await RateLimiter.stop(limiter);
  });
}
```

---

## Sliding Window Algorithm

The RateLimiter uses a sliding window log algorithm for accurate rate limiting:

1. **Timestamp Tracking**: Each request timestamp is stored
2. **Window Calculation**: Only requests within the last `windowMs` are counted
3. **Smooth Transitions**: No fixed window boundaries that cause burst patterns
4. **Accurate Remaining**: Precisely tracks how many requests are available

This approach is more accurate than fixed window algorithms, which can allow burst traffic at window boundaries.

```
Fixed Window Problem:
[Window 1: 100 req]|[Window 2: 100 req]
                  ↑
         200 requests in 1 second possible

Sliding Window Solution:
[←────── windowMs ──────→]
Always counts requests in the sliding window
```

---

## Related

- [GenServer API](./genserver.md) - Underlying implementation
- [Cache API](./cache.md) - In-memory caching
- [Registry API](./registry.md) - Named process lookup
