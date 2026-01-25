# Practical ETS Usage

You've learned what ETS is and the four table types. Now let's explore **real-world applications** where ETS shines. We'll build production-ready implementations of three common patterns: caches, session storage, and counters.

## What You'll Learn

- Build a TTL-aware cache with automatic cleanup
- Implement session storage with expiration handling
- Create atomic counters and metrics aggregation
- Combine ETS with GenServer for advanced patterns
- Best practices for production ETS usage

## Cache Implementation

Caching is ETS's most common use case. Let's build a full-featured cache with TTL support, size limits, and automatic cleanup.

### Basic TTL Cache

```typescript
import { Ets } from '@hamicek/noex';

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  ttlMs: number;
}

// Generic cache with configurable TTL
function createCache<T>(name: string, defaultTtlMs = 60000) {
  const table = Ets.new<string, CacheEntry<T>>({
    name,
    type: 'set',
  });

  return {
    async start() {
      await table.start();
    },

    set(key: string, data: T, ttlMs = defaultTtlMs): void {
      table.insert(key, {
        data,
        cachedAt: Date.now(),
        ttlMs,
      });
    },

    get(key: string): T | undefined {
      const entry = table.lookup(key);
      if (!entry) return undefined;

      // Check expiration
      if (Date.now() > entry.cachedAt + entry.ttlMs) {
        table.delete(key);
        return undefined;
      }

      return entry.data;
    },

    delete(key: string): boolean {
      return table.delete(key);
    },

    has(key: string): boolean {
      const entry = table.lookup(key);
      if (!entry) return false;

      if (Date.now() > entry.cachedAt + entry.ttlMs) {
        table.delete(key);
        return false;
      }

      return true;
    },

    size(): number {
      return table.size();
    },

    clear(): void {
      table.clear();
    },

    async close() {
      await table.close();
    },
  };
}

// Usage
const userCache = createCache<{ name: string; email: string }>('user-cache', 30000);
await userCache.start();

userCache.set('u1', { name: 'Alice', email: 'alice@example.com' });
userCache.set('u2', { name: 'Bob', email: 'bob@example.com' }, 60000); // Custom TTL

const alice = userCache.get('u1'); // { name: 'Alice', email: 'alice@example.com' }
// ... 30 seconds later ...
const expired = userCache.get('u1'); // undefined
```

### Cache with Automatic Cleanup

Lazy expiration (checking on `get`) works, but expired entries still consume memory. For high-traffic applications, add periodic cleanup:

```typescript
import { Ets } from '@hamicek/noex';

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  ttlMs: number;
}

function createAutoCleaningCache<T>(
  name: string,
  options: {
    defaultTtlMs?: number;
    cleanupIntervalMs?: number;
    maxSize?: number;
  } = {}
) {
  const { defaultTtlMs = 60000, cleanupIntervalMs = 30000, maxSize } = options;

  const table = Ets.new<string, CacheEntry<T>>({
    name,
    type: 'set',
  });

  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function cleanup(): number {
    const now = Date.now();
    const expired = table.select(
      (_, entry) => now > entry.cachedAt + entry.ttlMs
    );

    for (const { key } of expired) {
      table.delete(key);
    }

    return expired.length;
  }

  function evictIfNeeded(): void {
    if (!maxSize) return;

    while (table.size() >= maxSize) {
      // Find oldest entry
      let oldest: { key: string; cachedAt: number } | null = null;

      table.toArray().forEach(([key, entry]) => {
        if (!oldest || entry.cachedAt < oldest.cachedAt) {
          oldest = { key, cachedAt: entry.cachedAt };
        }
      });

      if (oldest) {
        table.delete(oldest.key);
      }
    }
  }

  return {
    async start() {
      await table.start();
      // Start periodic cleanup
      cleanupTimer = setInterval(() => cleanup(), cleanupIntervalMs);
    },

    set(key: string, data: T, ttlMs = defaultTtlMs): void {
      evictIfNeeded();
      table.insert(key, {
        data,
        cachedAt: Date.now(),
        ttlMs,
      });
    },

    get(key: string): T | undefined {
      const entry = table.lookup(key);
      if (!entry) return undefined;

      if (Date.now() > entry.cachedAt + entry.ttlMs) {
        table.delete(key);
        return undefined;
      }

      return entry.data;
    },

    getOrSet(key: string, factory: () => T, ttlMs = defaultTtlMs): T {
      const existing = this.get(key);
      if (existing !== undefined) return existing;

      const data = factory();
      this.set(key, data, ttlMs);
      return data;
    },

    delete(key: string): boolean {
      return table.delete(key);
    },

    cleanup,

    stats() {
      return {
        size: table.size(),
        maxSize: maxSize ?? Infinity,
      };
    },

    async close() {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      await table.close();
    },
  };
}

// Usage
const apiCache = createAutoCleaningCache<unknown>('api-cache', {
  defaultTtlMs: 60000,     // 1 minute default TTL
  cleanupIntervalMs: 30000, // Clean every 30 seconds
  maxSize: 1000,           // Max 1000 entries
});

await apiCache.start();

// Cache API responses
const data = apiCache.getOrSet('/api/users', () => {
  // This runs only on cache miss
  return fetchFromApi('/api/users');
});
```

### Cache Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CACHE WITH AUTO-CLEANUP                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                           ETS Table                                 │    │
│  │  ┌─────────────────────────────────────────────────────────────┐    │    │
│  │  │  key       │  data          │  cachedAt        │  ttlMs     │    │    │
│  │  ├────────────┼────────────────┼──────────────────┼────────────┤    │    │
│  │  │  /api/u1   │  {name:"A"}    │  1706000000000   │  60000     │    │    │
│  │  │  /api/u2   │  {name:"B"}    │  1706000001000   │  60000     │    │    │
│  │  │  /api/u3   │  {name:"C"}    │  1705999940000   │  60000     │    │ ←──┼── Expired!
│  │  └─────────────────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌─────────────────┐         ┌─────────────────────┐                        │
│  │    get(key)     │         │  Cleanup Timer      │                        │
│  │  ┌───────────┐  │         │  (setInterval)      │                        │
│  │  │ Check TTL │  │         │  ┌───────────────┐  │                        │
│  │  │ on access │  │         │  │ Periodic scan │  │                        │
│  │  └───────────┘  │         │  │ Remove stale  │  │                        │
│  └─────────────────┘         │  └───────────────┘  │                        │
│         ↓                    └─────────────────────┘                        │
│  Lazy expiration                     ↓                                      │
│  (on read)                   Proactive cleanup                              │
│                              (background)                                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Session Storage

Sessions require fast lookups by token, expiration handling, and often multi-field updates. ETS is perfect for this.

### Basic Session Store

```typescript
import { Ets } from '@hamicek/noex';

interface Session {
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  data: Record<string, unknown>;
}

function createSessionStore(options: {
  name?: string;
  sessionTtlMs?: number;
  cleanupIntervalMs?: number;
} = {}) {
  const {
    name = 'sessions',
    sessionTtlMs = 3600000, // 1 hour
    cleanupIntervalMs = 60000,
  } = options;

  const sessions = Ets.new<string, Session>({
    name,
    type: 'set',
  });

  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function generateToken(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  return {
    async start() {
      await sessions.start();
      cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    },

    create(userId: string, initialData: Record<string, unknown> = {}): string {
      const token = generateToken();
      const now = Date.now();

      sessions.insert(token, {
        userId,
        createdAt: now,
        expiresAt: now + sessionTtlMs,
        lastAccessedAt: now,
        data: initialData,
      });

      return token;
    },

    get(token: string): Session | null {
      const session = sessions.lookup(token);

      if (!session) return null;

      if (Date.now() > session.expiresAt) {
        sessions.delete(token);
        return null;
      }

      // Update last accessed time
      sessions.insert(token, {
        ...session,
        lastAccessedAt: Date.now(),
      });

      return session;
    },

    update(token: string, data: Record<string, unknown>): boolean {
      const session = this.get(token);
      if (!session) return false;

      sessions.insert(token, {
        ...session,
        data: { ...session.data, ...data },
        lastAccessedAt: Date.now(),
      });

      return true;
    },

    touch(token: string): boolean {
      const session = sessions.lookup(token);
      if (!session) return false;

      if (Date.now() > session.expiresAt) {
        sessions.delete(token);
        return false;
      }

      const now = Date.now();
      sessions.insert(token, {
        ...session,
        lastAccessedAt: now,
        expiresAt: now + sessionTtlMs, // Extend expiration
      });

      return true;
    },

    destroy(token: string): boolean {
      return sessions.delete(token);
    },

    destroyAllForUser(userId: string): number {
      const userSessions = sessions.select(
        (_, session) => session.userId === userId
      );

      for (const { key } of userSessions) {
        sessions.delete(key);
      }

      return userSessions.length;
    },

    cleanup(): number {
      const now = Date.now();
      const expired = sessions.select((_, session) => now > session.expiresAt);

      for (const { key } of expired) {
        sessions.delete(key);
      }

      return expired.length;
    },

    stats() {
      const now = Date.now();
      const allSessions = sessions.toArray();

      return {
        total: allSessions.length,
        active: allSessions.filter(([_, s]) => now <= s.expiresAt).length,
        expired: allSessions.filter(([_, s]) => now > s.expiresAt).length,
      };
    },

    async close() {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      await sessions.close();
    },
  };
}

// Usage
const sessionStore = createSessionStore({
  sessionTtlMs: 1800000, // 30 minutes
});

await sessionStore.start();

// Create session on login
const token = sessionStore.create('user-123', { theme: 'dark' });
// sess_1706000000000_abc123xyz

// Validate and get session in middleware
const session = sessionStore.get(token);
if (session) {
  console.log(`User ${session.userId} authenticated`);
  console.log(`Theme: ${session.data.theme}`);
}

// Update session data
sessionStore.update(token, { lastPage: '/dashboard' });

// Refresh session (extend TTL)
sessionStore.touch(token);

// Logout
sessionStore.destroy(token);

// Force logout from all devices
sessionStore.destroyAllForUser('user-123');
```

### Session Store with User Index

For efficient "find all sessions for user" queries, maintain a secondary index using a `bag` table:

```typescript
import { Ets, type EtsTable } from '@hamicek/noex';

interface Session {
  userId: string;
  createdAt: number;
  expiresAt: number;
  data: Record<string, unknown>;
}

function createIndexedSessionStore() {
  // Primary storage: token → session
  const sessions = Ets.new<string, Session>({
    name: 'sessions',
    type: 'set',
  });

  // Secondary index: userId → tokens (bag allows multiple tokens per user)
  const userIndex = Ets.new<string, string>({
    name: 'session-user-index',
    type: 'bag',
  });

  return {
    async start() {
      await sessions.start();
      await userIndex.start();
    },

    create(userId: string, data: Record<string, unknown> = {}): string {
      const token = `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const now = Date.now();

      // Insert into primary table
      sessions.insert(token, {
        userId,
        createdAt: now,
        expiresAt: now + 3600000,
        data,
      });

      // Add to user index
      userIndex.insert(userId, token);

      return token;
    },

    get(token: string): Session | null {
      const session = sessions.lookup(token);
      if (!session || Date.now() > session.expiresAt) {
        if (session) this.destroy(token);
        return null;
      }
      return session;
    },

    destroy(token: string): boolean {
      const session = sessions.lookup(token);
      if (!session) return false;

      // Remove from primary table
      sessions.delete(token);

      // Remove from user index
      userIndex.deleteObject(session.userId, token);

      return true;
    },

    // O(1) lookup of user's sessions via index
    getSessionsForUser(userId: string): Session[] {
      const tokens = userIndex.lookup(userId) as string[];
      const now = Date.now();
      const validSessions: Session[] = [];

      for (const token of tokens) {
        const session = sessions.lookup(token);
        if (session && now <= session.expiresAt) {
          validSessions.push(session);
        } else {
          // Clean up expired
          this.destroy(token);
        }
      }

      return validSessions;
    },

    destroyAllForUser(userId: string): number {
      const tokens = userIndex.lookup(userId) as string[];
      let count = 0;

      for (const token of tokens) {
        if (sessions.delete(token)) count++;
      }

      // Clear all entries for this user in index
      userIndex.delete(userId);

      return count;
    },

    async close() {
      await sessions.close();
      await userIndex.close();
    },
  };
}
```

## Counters and Metrics

ETS provides atomic counter operations via `updateCounter()`, making it ideal for metrics collection.

### Basic Counters

```typescript
import { Ets } from '@hamicek/noex';

const counters = Ets.new<string, number>({
  name: 'app-counters',
  type: 'set',
});

await counters.start();

// Atomic increment
counters.updateCounter('http_requests_total', 1);
counters.updateCounter('http_requests_total', 1);
counters.updateCounter('http_requests_total', 1);

// Atomic decrement
counters.updateCounter('active_connections', 1);
counters.updateCounter('active_connections', -1);

// Read current value
const total = counters.lookup('http_requests_total'); // 3

// Increment by arbitrary amount
counters.updateCounter('bytes_transferred', 1024);
counters.updateCounter('bytes_transferred', 2048);
// bytes_transferred = 3072
```

### Request Metrics Collector

```typescript
import { Ets } from '@hamicek/noex';

function createMetricsCollector() {
  // Counter metrics (monotonic)
  const counters = Ets.new<string, number>({
    name: 'metrics-counters',
    type: 'set',
  });

  // Gauge metrics (current value)
  const gauges = Ets.new<string, number>({
    name: 'metrics-gauges',
    type: 'set',
  });

  // Histogram buckets using ordered_set for range queries
  const histograms = Ets.new<string, number>({
    name: 'metrics-histograms',
    type: 'set',
  });

  return {
    async start() {
      await counters.start();
      await gauges.start();
      await histograms.start();
    },

    // Counters: only increment
    increment(name: string, value = 1, labels: Record<string, string> = {}): void {
      const key = formatMetricKey(name, labels);
      counters.updateCounter(key, value);
    },

    // Gauges: set to absolute value
    gauge(name: string, value: number, labels: Record<string, string> = {}): void {
      const key = formatMetricKey(name, labels);
      gauges.insert(key, value);
    },

    // Gauges: increment/decrement
    gaugeAdd(name: string, delta: number, labels: Record<string, string> = {}): void {
      const key = formatMetricKey(name, labels);
      const current = gauges.lookup(key) ?? 0;
      gauges.insert(key, current + delta);
    },

    // Histograms: record value in bucket
    histogram(name: string, value: number, labels: Record<string, string> = {}): void {
      const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, Infinity];

      for (const bucket of buckets) {
        if (value <= bucket) {
          const key = `${formatMetricKey(name, labels)}:le=${bucket}`;
          histograms.updateCounter(key, 1);
        }
      }

      // Also track sum and count
      const baseKey = formatMetricKey(name, labels);
      histograms.updateCounter(`${baseKey}:sum`, value);
      histograms.updateCounter(`${baseKey}:count`, 1);
    },

    // Get all metrics in Prometheus format
    toPrometheus(): string {
      const lines: string[] = [];

      // Counters
      for (const [key, value] of counters.toArray()) {
        lines.push(`${key} ${value}`);
      }

      // Gauges
      for (const [key, value] of gauges.toArray()) {
        lines.push(`${key} ${value}`);
      }

      // Histograms
      for (const [key, value] of histograms.toArray()) {
        lines.push(`${key} ${value}`);
      }

      return lines.join('\n');
    },

    reset(): void {
      counters.clear();
      gauges.clear();
      histograms.clear();
    },

    async close() {
      await counters.close();
      await gauges.close();
      await histograms.close();
    },
  };
}

function formatMetricKey(name: string, labels: Record<string, string>): string {
  if (Object.keys(labels).length === 0) return name;

  const labelStr = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');

  return `${name}{${labelStr}}`;
}

// Usage
const metrics = createMetricsCollector();
await metrics.start();

// Track HTTP requests
metrics.increment('http_requests_total', 1, { method: 'GET', path: '/api/users' });
metrics.increment('http_requests_total', 1, { method: 'POST', path: '/api/users' });

// Track response times
metrics.histogram('http_request_duration_seconds', 0.043, { method: 'GET' });
metrics.histogram('http_request_duration_seconds', 0.128, { method: 'POST' });

// Track current connections
metrics.gauge('active_connections', 42);
metrics.gaugeAdd('active_connections', 1);  // Now 43
metrics.gaugeAdd('active_connections', -1); // Now 42

// Export for Prometheus scraping
console.log(metrics.toPrometheus());
```

### Rate Counter with Time Windows

Track counts per time window (e.g., requests per minute):

```typescript
import { Ets } from '@hamicek/noex';

function createRateCounter(windowMs = 60000, bucketCount = 60) {
  const bucketMs = windowMs / bucketCount;

  // ordered_set for efficient time-based cleanup
  const buckets = Ets.new<number, Map<string, number>>({
    name: 'rate-buckets',
    type: 'ordered_set',
    keyComparator: (a, b) => a - b,
  });

  function getBucketKey(timestamp: number): number {
    return Math.floor(timestamp / bucketMs) * bucketMs;
  }

  function cleanup(): void {
    const cutoff = Date.now() - windowMs;
    let entry = buckets.first();

    while (entry && entry.key < cutoff) {
      buckets.delete(entry.key);
      entry = buckets.first();
    }
  }

  return {
    async start() {
      await buckets.start();
    },

    increment(key: string, count = 1): void {
      const bucketKey = getBucketKey(Date.now());
      const bucket = buckets.lookup(bucketKey) ?? new Map<string, number>();

      bucket.set(key, (bucket.get(key) ?? 0) + count);
      buckets.insert(bucketKey, bucket);

      // Periodic cleanup
      if (Math.random() < 0.1) cleanup();
    },

    getRate(key: string): number {
      cleanup();

      const cutoff = Date.now() - windowMs;
      let total = 0;

      for (const [bucketKey, bucket] of buckets.toArray()) {
        if (bucketKey >= cutoff) {
          total += bucket.get(key) ?? 0;
        }
      }

      return total;
    },

    getRatePerSecond(key: string): number {
      return this.getRate(key) / (windowMs / 1000);
    },

    async close() {
      await buckets.close();
    },
  };
}

// Usage
const requestRate = createRateCounter(60000, 60); // 60 buckets, 1 per second
await requestRate.start();

// Record requests
requestRate.increment('/api/users');
requestRate.increment('/api/users');
requestRate.increment('/api/orders');

// Check rates
console.log(requestRate.getRate('/api/users'));        // 2 requests in last minute
console.log(requestRate.getRatePerSecond('/api/users')); // 0.033 req/sec
```

## Combining ETS with GenServer

For complex scenarios, combine ETS (fast data access) with GenServer (business logic and coordination):

```typescript
import { GenServer, Ets, type GenServerBehavior, type Pid } from '@hamicek/noex';

// ETS for fast session lookups
const sessionData = Ets.new<string, { userId: string; data: unknown }>({
  name: 'session-data',
  type: 'set',
});

// State for the session manager GenServer
interface SessionManagerState {
  cleanupIntervalId: ReturnType<typeof setInterval> | null;
  sessionTtlMs: number;
  expirations: Map<string, number>; // token → expiresAt
}

type SessionManagerCall =
  | { type: 'create'; userId: string; data: unknown }
  | { type: 'get'; token: string }
  | { type: 'destroy'; token: string }
  | { type: 'stats' };

type SessionManagerCast =
  | { type: 'cleanup' };

type SessionManagerReply =
  | { type: 'created'; token: string }
  | { type: 'session'; session: { userId: string; data: unknown } | null }
  | { type: 'destroyed'; success: boolean }
  | { type: 'stats'; total: number; expired: number };

const sessionManagerBehavior: GenServerBehavior<
  SessionManagerState,
  SessionManagerCall,
  SessionManagerCast,
  SessionManagerReply
> = {
  async init() {
    await sessionData.start();

    // Start cleanup timer
    const cleanupIntervalId = setInterval(() => {
      GenServer.cast(this as unknown as Pid, { type: 'cleanup' });
    }, 30000);

    return {
      cleanupIntervalId,
      sessionTtlMs: 3600000,
      expirations: new Map(),
    };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'create': {
        const token = `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const expiresAt = Date.now() + state.sessionTtlMs;

        // Fast write to ETS
        sessionData.insert(token, {
          userId: msg.userId,
          data: msg.data,
        });

        // Track expiration in GenServer state
        state.expirations.set(token, expiresAt);

        return [state, { type: 'created', token }];
      }

      case 'get': {
        const expiresAt = state.expirations.get(msg.token);

        if (!expiresAt || Date.now() > expiresAt) {
          // Expired or not found
          sessionData.delete(msg.token);
          state.expirations.delete(msg.token);
          return [state, { type: 'session', session: null }];
        }

        // Fast read from ETS
        const data = sessionData.lookup(msg.token);
        return [state, { type: 'session', session: data ?? null }];
      }

      case 'destroy': {
        const existed = sessionData.delete(msg.token);
        state.expirations.delete(msg.token);
        return [state, { type: 'destroyed', success: existed }];
      }

      case 'stats': {
        const now = Date.now();
        let expired = 0;

        for (const expiresAt of state.expirations.values()) {
          if (now > expiresAt) expired++;
        }

        return [
          state,
          { type: 'stats', total: state.expirations.size, expired },
        ];
      }
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'cleanup') {
      const now = Date.now();

      for (const [token, expiresAt] of state.expirations.entries()) {
        if (now > expiresAt) {
          sessionData.delete(token);
          state.expirations.delete(token);
        }
      }
    }

    return state;
  },

  async terminate(_reason, state) {
    if (state.cleanupIntervalId) {
      clearInterval(state.cleanupIntervalId);
    }
    await sessionData.close();
  },
};

// Start the session manager
const sessionManager = GenServer.start(sessionManagerBehavior, {
  name: 'session-manager',
});
```

### Architecture: ETS + GenServer

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      ETS + GENSERVER PATTERN                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────────────────┐    ┌──────────────────────────────┐      │
│  │         GenServer            │    │           ETS Table           │      │
│  │    (Session Manager)         │    │        (Session Data)         │      │
│  │                              │    │                               │      │
│  │  • Expiration tracking       │    │  • Fast O(1) lookups          │      │
│  │  • Cleanup coordination      │    │  • Session payloads           │      │
│  │  • Business logic            │    │  • No message passing         │      │
│  │  • Sequential operations     │    │  • Concurrent reads           │      │
│  │                              │    │                               │      │
│  │  state.expirations: Map      │◄──►│  token → {userId, data}       │      │
│  │  (token → expiresAt)         │    │                               │      │
│  └──────────────────────────────┘    └──────────────────────────────┘      │
│           │                                     ▲                           │
│           │                                     │                           │
│           │    call('create')                   │ insert(token, data)       │
│           │    call('get')                      │ lookup(token)             │
│           │    call('destroy')                  │ delete(token)             │
│           ▼                                     │                           │
│  ┌──────────────────────────────────────────────┴──────────────────────┐   │
│  │                            Clients                                   │   │
│  │                                                                      │   │
│  │  • Create sessions via GenServer (get token back)                    │   │
│  │  • Validate sessions via GenServer (checks expiration)               │   │
│  │  • GenServer coordinates, ETS stores                                 │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  BENEFITS:                                                                  │
│  • GenServer handles complex logic (expiration, cleanup scheduling)         │
│  • ETS provides fast data access without message passing overhead           │
│  • Clear separation: coordination vs storage                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Best Practices

### 1. Always Close Tables

```typescript
// Bad: Table left open, memory leak
const table = Ets.new<string, number>({ name: 'temp' });
await table.start();
table.insert('key', 123);
// ... forgot to close

// Good: Use try/finally or cleanup pattern
const table = Ets.new<string, number>({ name: 'temp' });
try {
  await table.start();
  // ... use table
} finally {
  await table.close();
}
```

### 2. Choose the Right Table Type

```typescript
// Bad: Using set when you need multiple values per key
const permissions = Ets.new<string, string>({ type: 'set' });
permissions.insert('user:1', 'read');
permissions.insert('user:1', 'write'); // Overwrites 'read'!

// Good: Use bag for multiple unique values
const permissions = Ets.new<string, string>({ type: 'bag' });
permissions.insert('user:1', 'read');
permissions.insert('user:1', 'write'); // Both stored
```

### 3. Handle Missing Keys Gracefully

```typescript
// Bad: Assuming key exists
const value = table.lookup(key);
console.log(value.property); // TypeError if undefined

// Good: Check for undefined
const value = table.lookup(key);
if (value === undefined) {
  // Handle missing key
  return null;
}
console.log(value.property);

// Also good: Use nullish coalescing
const value = table.lookup(key) ?? defaultValue;
```

### 4. Use Composite Keys for Multi-Dimensional Lookups

```typescript
// Pattern: "dimension1:dimension2:dimension3"
const cache = Ets.new<string, CachedResult>({ name: 'query-cache' });

function cacheKey(userId: string, query: string, page: number): string {
  return `${userId}:${query}:${page}`;
}

cache.insert(cacheKey('u1', 'search', 1), result);
const cached = cache.lookup(cacheKey('u1', 'search', 1));
```

### 5. Consider Memory Usage

```typescript
// Bad: Unbounded growth
const events = Ets.new<string, Event[]>({ name: 'events' });
// Events keep accumulating forever...

// Good: Implement size limits and cleanup
function addEvent(key: string, event: Event): void {
  const existing = events.lookup(key) ?? [];

  // Keep only last 100 events
  const updated = [...existing, event].slice(-100);
  events.insert(key, updated);
}

// Or use cleanup with TTL (see cache examples above)
```

## Exercise: Leaderboard with History

Build a game leaderboard that tracks:
1. Current scores (fast lookup by player ID)
2. Top 10 players (sorted by score)
3. Score history per player (last 10 scores)

**Requirements:**
- `submitScore(playerId, score)` — Record a score
- `getPlayerScore(playerId)` — Get current (highest) score
- `getTop10()` — Get top 10 players and scores
- `getHistory(playerId)` — Get last 10 scores for player
- Handle ties in top 10 (same score = alphabetical by player ID)

**Starter code:**

```typescript
import { Ets } from '@hamicek/noex';

// Choose appropriate table types!
// Hint: You'll need multiple tables

function createLeaderboard() {
  // TODO: Create tables

  return {
    async start() {
      // TODO
    },

    submitScore(playerId: string, score: number): void {
      // TODO: Update current score if higher
      // TODO: Add to history (keep last 10)
      // TODO: Update top 10
    },

    getPlayerScore(playerId: string): number | null {
      // TODO
    },

    getTop10(): Array<{ playerId: string; score: number }> {
      // TODO: Return sorted by score desc, then playerId asc
    },

    getHistory(playerId: string): number[] {
      // TODO: Return last 10 scores (newest first)
    },

    async close() {
      // TODO
    },
  };
}
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
import { Ets } from '@hamicek/noex';

function createLeaderboard() {
  // Current high scores: playerId → score
  const scores = Ets.new<string, number>({
    name: 'leaderboard-scores',
    type: 'set',
  });

  // Score history: playerId → scores[] (using bag would lose order)
  const history = Ets.new<string, number[]>({
    name: 'leaderboard-history',
    type: 'set',
  });

  // Top scores: "score:playerId" → {playerId, score}
  // Using ordered_set with custom comparator for sorting
  const topScores = Ets.new<string, { playerId: string; score: number }>({
    name: 'leaderboard-top',
    type: 'ordered_set',
    // Sort by score descending, then playerId ascending
    keyComparator: (a, b) => {
      const [scoreA, playerA] = parseTopKey(a);
      const [scoreB, playerB] = parseTopKey(b);

      // Higher score first
      if (scoreB !== scoreA) return scoreB - scoreA;
      // Same score: alphabetical by player
      return playerA.localeCompare(playerB);
    },
  });

  function makeTopKey(score: number, playerId: string): string {
    // Pad score for correct string sorting (if not using comparator)
    return `${score.toString().padStart(10, '0')}:${playerId}`;
  }

  function parseTopKey(key: string): [number, string] {
    const [scoreStr, playerId] = key.split(':');
    return [parseInt(scoreStr!, 10), playerId!];
  }

  return {
    async start() {
      await scores.start();
      await history.start();
      await topScores.start();
    },

    submitScore(playerId: string, score: number): void {
      // Update history (keep last 10, newest first)
      const playerHistory = history.lookup(playerId) ?? [];
      const updatedHistory = [score, ...playerHistory].slice(0, 10);
      history.insert(playerId, updatedHistory);

      // Check if this is a new high score
      const currentHigh = scores.lookup(playerId);

      if (currentHigh === undefined || score > currentHigh) {
        // Remove old entry from top scores
        if (currentHigh !== undefined) {
          topScores.delete(makeTopKey(currentHigh, playerId));
        }

        // Update current score
        scores.insert(playerId, score);

        // Add to top scores
        topScores.insert(makeTopKey(score, playerId), { playerId, score });

        // Trim top scores to reasonable size (keep top 100)
        while (topScores.size() > 100) {
          const last = topScores.last();
          if (last) topScores.delete(last.key);
        }
      }
    },

    getPlayerScore(playerId: string): number | null {
      return scores.lookup(playerId) ?? null;
    },

    getTop10(): Array<{ playerId: string; score: number }> {
      const result: Array<{ playerId: string; score: number }> = [];
      let entry = topScores.first();

      while (entry && result.length < 10) {
        result.push(entry.value);
        try {
          entry = topScores.next(entry.key);
        } catch {
          // No more entries
          break;
        }
      }

      return result;
    },

    getHistory(playerId: string): number[] {
      return history.lookup(playerId) ?? [];
    },

    async close() {
      await scores.close();
      await history.close();
      await topScores.close();
    },
  };
}

// Test
const leaderboard = createLeaderboard();
await leaderboard.start();

// Submit scores
leaderboard.submitScore('alice', 100);
leaderboard.submitScore('bob', 150);
leaderboard.submitScore('charlie', 150); // Tie with bob
leaderboard.submitScore('alice', 120);   // New high for alice
leaderboard.submitScore('alice', 80);    // Not a high score, but in history

console.log(leaderboard.getPlayerScore('alice')); // 120 (highest)

console.log(leaderboard.getTop10());
// [
//   { playerId: 'bob', score: 150 },
//   { playerId: 'charlie', score: 150 },  // Alphabetical after bob
//   { playerId: 'alice', score: 120 }
// ]

console.log(leaderboard.getHistory('alice'));
// [80, 120, 100] — newest first

await leaderboard.close();
```

**Design decisions:**

1. **Three tables for three concerns:**
   - `scores` (set): O(1) current score lookup
   - `history` (set with array value): Ordered history per player
   - `topScores` (ordered_set): Sorted leaderboard

2. **Composite key for top scores:** `"score:playerId"` allows natural sorting

3. **Custom comparator:** Handles descending score + alphabetical tiebreaker

4. **History as array value:** Preserves insertion order (bag/duplicate_bag wouldn't)

5. **Top scores trimming:** Prevents unbounded growth while keeping enough for top 10

</details>

## Summary

**Key takeaways:**

- **Cache with TTL** — Combine `set` table with expiration timestamps and cleanup timers
- **Session storage** — Use composite keys or secondary indexes for multi-field queries
- **Counters** — `updateCounter()` provides atomic increment/decrement for metrics
- **ETS + GenServer** — Combine fast ETS data access with GenServer coordination logic
- **Always close tables** — Prevent memory leaks with proper cleanup

**Pattern selection guide:**

| Use Case | Pattern |
|----------|---------|
| Simple cache | `set` + TTL field + lazy expiration |
| High-traffic cache | Add periodic cleanup timer |
| Size-limited cache | Add eviction on insert |
| Sessions | `set` + expiration tracking |
| Multi-user sessions | Add secondary index with `bag` |
| Request counting | `updateCounter()` on `set` |
| Rate limiting | `ordered_set` for time-windowed buckets |
| Complex coordination | GenServer + ETS hybrid |

**Remember:**

> ETS excels at fast, concurrent data access. When you need business logic, coordination, or supervision, add GenServer. The combination of both gives you the best of both worlds.

---

Next: [EventBus](../08-builtin-services/01-eventbus.md)
