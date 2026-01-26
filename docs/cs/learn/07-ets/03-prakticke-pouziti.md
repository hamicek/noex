# Praktické použití ETS

Naučili jste se, co je ETS a čtyři typy tabulek. Nyní prozkoumáme **reálné aplikace**, kde ETS vyniká. Vytvoříme production-ready implementace tří běžných vzorů: cache, session storage a čítače.

## Co se naučíte

- Vytvořit TTL-aware cache s automatickým čištěním
- Implementovat session storage s expirací
- Vytvořit atomické čítače a agregaci metrik
- Kombinovat ETS s GenServerem pro pokročilé vzory
- Best practices pro produkční použití ETS

## Implementace cache

Caching je nejběžnější případ použití ETS. Vytvořme plnohodnotnou cache s podporou TTL, limity velikosti a automatickým čištěním.

### Základní TTL cache

```typescript
import { Ets } from '@hamicek/noex';

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  ttlMs: number;
}

// Generická cache s konfigurovatelným TTL
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

      // Kontrola expirace
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

// Použití
const userCache = createCache<{ name: string; email: string }>('user-cache', 30000);
await userCache.start();

userCache.set('u1', { name: 'Alice', email: 'alice@example.com' });
userCache.set('u2', { name: 'Bob', email: 'bob@example.com' }, 60000); // Vlastní TTL

const alice = userCache.get('u1'); // { name: 'Alice', email: 'alice@example.com' }
// ... 30 sekund později ...
const expired = userCache.get('u1'); // undefined
```

### Cache s automatickým čištěním

Líná expirace (kontrola při `get`) funguje, ale expirované záznamy stále zabírají paměť. Pro aplikace s vysokým provozem přidejte periodické čištění:

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
      // Nalezení nejstaršího záznamu
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
      // Spuštění periodického čištění
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

// Použití
const apiCache = createAutoCleaningCache<unknown>('api-cache', {
  defaultTtlMs: 60000,     // 1 minuta výchozí TTL
  cleanupIntervalMs: 30000, // Čištění každých 30 sekund
  maxSize: 1000,           // Max 1000 záznamů
});

await apiCache.start();

// Cachování API odpovědí
const data = apiCache.getOrSet('/api/users', () => {
  // Toto se spustí pouze při cache miss
  return fetchFromApi('/api/users');
});
```

### Diagram architektury cache

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CACHE S AUTO-ČIŠTĚNÍM                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                           ETS Tabulka                               │    │
│  │  ┌─────────────────────────────────────────────────────────────┐    │    │
│  │  │  klíč       │  data          │  cachedAt        │  ttlMs    │    │    │
│  │  ├────────────┼────────────────┼──────────────────┼────────────┤    │    │
│  │  │  /api/u1   │  {name:"A"}    │  1706000000000   │  60000     │    │    │
│  │  │  /api/u2   │  {name:"B"}    │  1706000001000   │  60000     │    │    │
│  │  │  /api/u3   │  {name:"C"}    │  1705999940000   │  60000     │ ←──┼── Expirováno!
│  │  └─────────────────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌─────────────────┐         ┌─────────────────────┐                        │
│  │    get(key)     │         │  Cleanup Timer      │                        │
│  │  ┌───────────┐  │         │  (setInterval)      │                        │
│  │  │Kontrola   │  │         │  ┌───────────────┐  │                        │
│  │  │TTL při    │  │         │  │ Periodický    │  │                        │
│  │  │přístupu   │  │         │  │ sken, odstra- │  │                        │
│  │  └───────────┘  │         │  │ nění starých  │  │                        │
│  └─────────────────┘         │  └───────────────┘  │                        │
│         ↓                    └─────────────────────┘                        │
│  Líná expirace                     ↓                                        │
│  (při čtení)                 Proaktivní čištění                             │
│                              (na pozadí)                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Session storage

Sessions vyžadují rychlé vyhledávání podle tokenu, zpracování expirace a často vícepólové aktualizace. ETS je pro toto ideální.

### Základní session store

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
    sessionTtlMs = 3600000, // 1 hodina
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

      // Aktualizace času posledního přístupu
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
        expiresAt: now + sessionTtlMs, // Prodloužení expirace
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

// Použití
const sessionStore = createSessionStore({
  sessionTtlMs: 1800000, // 30 minut
});

await sessionStore.start();

// Vytvoření session při přihlášení
const token = sessionStore.create('user-123', { theme: 'dark' });
// sess_1706000000000_abc123xyz

// Validace a získání session v middleware
const session = sessionStore.get(token);
if (session) {
  console.log(`Uživatel ${session.userId} autentizován`);
  console.log(`Téma: ${session.data.theme}`);
}

// Aktualizace session dat
sessionStore.update(token, { lastPage: '/dashboard' });

// Obnovení session (prodloužení TTL)
sessionStore.touch(token);

// Odhlášení
sessionStore.destroy(token);

// Vynucené odhlášení ze všech zařízení
sessionStore.destroyAllForUser('user-123');
```

### Session store s indexem uživatelů

Pro efektivní dotazy "najdi všechny sessions pro uživatele" udržujte sekundární index pomocí `bag` tabulky:

```typescript
import { Ets, type EtsTable } from '@hamicek/noex';

interface Session {
  userId: string;
  createdAt: number;
  expiresAt: number;
  data: Record<string, unknown>;
}

function createIndexedSessionStore() {
  // Primární úložiště: token → session
  const sessions = Ets.new<string, Session>({
    name: 'sessions',
    type: 'set',
  });

  // Sekundární index: userId → tokens (bag povoluje více tokenů na uživatele)
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

      // Vložení do primární tabulky
      sessions.insert(token, {
        userId,
        createdAt: now,
        expiresAt: now + 3600000,
        data,
      });

      // Přidání do indexu uživatelů
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

      // Odstranění z primární tabulky
      sessions.delete(token);

      // Odstranění z indexu uživatelů
      userIndex.deleteObject(session.userId, token);

      return true;
    },

    // O(1) vyhledávání sessions uživatele přes index
    getSessionsForUser(userId: string): Session[] {
      const tokens = userIndex.lookup(userId) as string[];
      const now = Date.now();
      const validSessions: Session[] = [];

      for (const token of tokens) {
        const session = sessions.lookup(token);
        if (session && now <= session.expiresAt) {
          validSessions.push(session);
        } else {
          // Vyčištění expirovaných
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

      // Vymazání všech záznamů pro tohoto uživatele v indexu
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

## Čítače a metriky

ETS poskytuje atomické operace s čítači přes `updateCounter()`, což je ideální pro sběr metrik.

### Základní čítače

```typescript
import { Ets } from '@hamicek/noex';

const counters = Ets.new<string, number>({
  name: 'app-counters',
  type: 'set',
});

await counters.start();

// Atomický inkrement
counters.updateCounter('http_requests_total', 1);
counters.updateCounter('http_requests_total', 1);
counters.updateCounter('http_requests_total', 1);

// Atomický dekrement
counters.updateCounter('active_connections', 1);
counters.updateCounter('active_connections', -1);

// Čtení aktuální hodnoty
const total = counters.lookup('http_requests_total'); // 3

// Inkrement o libovolné množství
counters.updateCounter('bytes_transferred', 1024);
counters.updateCounter('bytes_transferred', 2048);
// bytes_transferred = 3072
```

### Kolektor metrik requestů

```typescript
import { Ets } from '@hamicek/noex';

function createMetricsCollector() {
  // Counter metriky (monotónní)
  const counters = Ets.new<string, number>({
    name: 'metrics-counters',
    type: 'set',
  });

  // Gauge metriky (aktuální hodnota)
  const gauges = Ets.new<string, number>({
    name: 'metrics-gauges',
    type: 'set',
  });

  // Histogram buckety s ordered_set pro range dotazy
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

    // Countery: pouze inkrementace
    increment(name: string, value = 1, labels: Record<string, string> = {}): void {
      const key = formatMetricKey(name, labels);
      counters.updateCounter(key, value);
    },

    // Gauges: nastavení na absolutní hodnotu
    gauge(name: string, value: number, labels: Record<string, string> = {}): void {
      const key = formatMetricKey(name, labels);
      gauges.insert(key, value);
    },

    // Gauges: inkrement/dekrement
    gaugeAdd(name: string, delta: number, labels: Record<string, string> = {}): void {
      const key = formatMetricKey(name, labels);
      const current = gauges.lookup(key) ?? 0;
      gauges.insert(key, current + delta);
    },

    // Histogramy: zaznamenání hodnoty do bucketu
    histogram(name: string, value: number, labels: Record<string, string> = {}): void {
      const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, Infinity];

      for (const bucket of buckets) {
        if (value <= bucket) {
          const key = `${formatMetricKey(name, labels)}:le=${bucket}`;
          histograms.updateCounter(key, 1);
        }
      }

      // Také sledování sumy a počtu
      const baseKey = formatMetricKey(name, labels);
      histograms.updateCounter(`${baseKey}:sum`, value);
      histograms.updateCounter(`${baseKey}:count`, 1);
    },

    // Získání všech metrik ve formátu Prometheus
    toPrometheus(): string {
      const lines: string[] = [];

      // Countery
      for (const [key, value] of counters.toArray()) {
        lines.push(`${key} ${value}`);
      }

      // Gauges
      for (const [key, value] of gauges.toArray()) {
        lines.push(`${key} ${value}`);
      }

      // Histogramy
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

// Použití
const metrics = createMetricsCollector();
await metrics.start();

// Sledování HTTP requestů
metrics.increment('http_requests_total', 1, { method: 'GET', path: '/api/users' });
metrics.increment('http_requests_total', 1, { method: 'POST', path: '/api/users' });

// Sledování časů odpovědí
metrics.histogram('http_request_duration_seconds', 0.043, { method: 'GET' });
metrics.histogram('http_request_duration_seconds', 0.128, { method: 'POST' });

// Sledování aktuálních spojení
metrics.gauge('active_connections', 42);
metrics.gaugeAdd('active_connections', 1);  // Nyní 43
metrics.gaugeAdd('active_connections', -1); // Nyní 42

// Export pro Prometheus scraping
console.log(metrics.toPrometheus());
```

### Rate counter s časovými okny

Sledování počtů za časové okno (např. requesty za minutu):

```typescript
import { Ets } from '@hamicek/noex';

function createRateCounter(windowMs = 60000, bucketCount = 60) {
  const bucketMs = windowMs / bucketCount;

  // ordered_set pro efektivní časově založené čištění
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

      // Periodické čištění
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

// Použití
const requestRate = createRateCounter(60000, 60); // 60 bucketů, 1 za sekundu
await requestRate.start();

// Zaznamenání requestů
requestRate.increment('/api/users');
requestRate.increment('/api/users');
requestRate.increment('/api/orders');

// Kontrola rates
console.log(requestRate.getRate('/api/users'));        // 2 requesty za poslední minutu
console.log(requestRate.getRatePerSecond('/api/users')); // 0.033 req/sec
```

## Kombinace ETS s GenServerem

Pro komplexní scénáře kombinujte ETS (rychlý přístup k datům) s GenServerem (business logika a koordinace):

```typescript
import { GenServer, Ets, type GenServerBehavior, type Pid } from '@hamicek/noex';

// ETS pro rychlé session vyhledávání
const sessionData = Ets.new<string, { userId: string; data: unknown }>({
  name: 'session-data',
  type: 'set',
});

// Stav pro session manager GenServer
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

    // Spuštění cleanup timeru
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

        // Rychlý zápis do ETS
        sessionData.insert(token, {
          userId: msg.userId,
          data: msg.data,
        });

        // Sledování expirace ve stavu GenServeru
        state.expirations.set(token, expiresAt);

        return [state, { type: 'created', token }];
      }

      case 'get': {
        const expiresAt = state.expirations.get(msg.token);

        if (!expiresAt || Date.now() > expiresAt) {
          // Expirováno nebo nenalezeno
          sessionData.delete(msg.token);
          state.expirations.delete(msg.token);
          return [state, { type: 'session', session: null }];
        }

        // Rychlé čtení z ETS
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

// Spuštění session manageru
const sessionManager = GenServer.start(sessionManagerBehavior, {
  name: 'session-manager',
});
```

### Architektura: ETS + GenServer

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      VZOR ETS + GENSERVER                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────────────────┐    ┌──────────────────────────────┐      │
│  │         GenServer            │    │           ETS Tabulka         │      │
│  │    (Session Manager)         │    │        (Session Data)         │      │
│  │                              │    │                               │      │
│  │  • Sledování expirace        │    │  • Rychlé O(1) vyhledávání    │      │
│  │  • Koordinace čištění        │    │  • Session payloady           │      │
│  │  • Business logika           │    │  • Bez message passing        │      │
│  │  • Sekvenční operace         │    │  • Souběžné čtení             │      │
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
│  │                            Klienti                                   │   │
│  │                                                                      │   │
│  │  • Vytváření sessions přes GenServer (získání tokenu zpět)           │   │
│  │  • Validace sessions přes GenServer (kontrola expirace)              │   │
│  │  • GenServer koordinuje, ETS ukládá                                  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  VÝHODY:                                                                    │
│  • GenServer zpracovává komplexní logiku (expirace, plánování čištění)      │
│  • ETS poskytuje rychlý přístup k datům bez režie message passing           │
│  • Jasné oddělení: koordinace vs úložiště                                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Best practices

### 1. Vždy zavírejte tabulky

```typescript
// Špatně: Tabulka zůstala otevřená, memory leak
const table = Ets.new<string, number>({ name: 'temp' });
await table.start();
table.insert('key', 123);
// ... zapomněli jsme zavřít

// Správně: Použití try/finally nebo cleanup vzoru
const table = Ets.new<string, number>({ name: 'temp' });
try {
  await table.start();
  // ... použití tabulky
} finally {
  await table.close();
}
```

### 2. Vyberte správný typ tabulky

```typescript
// Špatně: Použití set když potřebujete více hodnot na klíč
const permissions = Ets.new<string, string>({ type: 'set' });
permissions.insert('user:1', 'read');
permissions.insert('user:1', 'write'); // Přepíše 'read'!

// Správně: Použití bag pro více unikátních hodnot
const permissions = Ets.new<string, string>({ type: 'bag' });
permissions.insert('user:1', 'read');
permissions.insert('user:1', 'write'); // Obě uloženy
```

### 3. Zpracujte chybějící klíče elegantně

```typescript
// Špatně: Předpokládání že klíč existuje
const value = table.lookup(key);
console.log(value.property); // TypeError pokud undefined

// Správně: Kontrola undefined
const value = table.lookup(key);
if (value === undefined) {
  // Zpracování chybějícího klíče
  return null;
}
console.log(value.property);

// Také správně: Použití nullish coalescing
const value = table.lookup(key) ?? defaultValue;
```

### 4. Použijte složené klíče pro vícerozměrné vyhledávání

```typescript
// Vzor: "dimenze1:dimenze2:dimenze3"
const cache = Ets.new<string, CachedResult>({ name: 'query-cache' });

function cacheKey(userId: string, query: string, page: number): string {
  return `${userId}:${query}:${page}`;
}

cache.insert(cacheKey('u1', 'search', 1), result);
const cached = cache.lookup(cacheKey('u1', 'search', 1));
```

### 5. Zvažte využití paměti

```typescript
// Špatně: Neomezený růst
const events = Ets.new<string, Event[]>({ name: 'events' });
// Eventy se stále hromadí...

// Správně: Implementace limitů velikosti a čištění
function addEvent(key: string, event: Event): void {
  const existing = events.lookup(key) ?? [];

  // Ponechání pouze posledních 100 eventů
  const updated = [...existing, event].slice(-100);
  events.insert(key, updated);
}

// Nebo použití čištění s TTL (viz příklady cache výše)
```

## Cvičení: Leaderboard s historií

Vytvořte herní leaderboard, který sleduje:
1. Aktuální skóre (rychlé vyhledávání podle player ID)
2. Top 10 hráčů (seřazeno podle skóre)
3. Historie skóre na hráče (posledních 10 skóre)

**Požadavky:**
- `submitScore(playerId, score)` — Zaznamenání skóre
- `getPlayerScore(playerId)` — Získání aktuálního (nejvyššího) skóre
- `getTop10()` — Získání top 10 hráčů a skóre
- `getHistory(playerId)` — Získání posledních 10 skóre pro hráče
- Zpracování remíz v top 10 (stejné skóre = abecedně podle player ID)

**Výchozí kód:**

```typescript
import { Ets } from '@hamicek/noex';

// Zvolte vhodné typy tabulek!
// Nápověda: Budete potřebovat více tabulek

function createLeaderboard() {
  // TODO: Vytvoření tabulek

  return {
    async start() {
      // TODO
    },

    submitScore(playerId: string, score: number): void {
      // TODO: Aktualizace aktuálního skóre pokud vyšší
      // TODO: Přidání do historie (ponechání posledních 10)
      // TODO: Aktualizace top 10
    },

    getPlayerScore(playerId: string): number | null {
      // TODO
    },

    getTop10(): Array<{ playerId: string; score: number }> {
      // TODO: Vrácení seřazeno podle skóre sestupně, pak playerId vzestupně
    },

    getHistory(playerId: string): number[] {
      // TODO: Vrácení posledních 10 skóre (nejnovější první)
    },

    async close() {
      // TODO
    },
  };
}
```

<details>
<summary><strong>Řešení</strong></summary>

```typescript
import { Ets } from '@hamicek/noex';

function createLeaderboard() {
  // Aktuální high scores: playerId → score
  const scores = Ets.new<string, number>({
    name: 'leaderboard-scores',
    type: 'set',
  });

  // Historie skóre: playerId → scores[] (použití bag by ztratilo pořadí)
  const history = Ets.new<string, number[]>({
    name: 'leaderboard-history',
    type: 'set',
  });

  // Top skóre: "score:playerId" → {playerId, score}
  // Použití ordered_set s vlastním komparátorem pro řazení
  const topScores = Ets.new<string, { playerId: string; score: number }>({
    name: 'leaderboard-top',
    type: 'ordered_set',
    // Řazení podle skóre sestupně, pak playerId vzestupně
    keyComparator: (a, b) => {
      const [scoreA, playerA] = parseTopKey(a);
      const [scoreB, playerB] = parseTopKey(b);

      // Vyšší skóre první
      if (scoreB !== scoreA) return scoreB - scoreA;
      // Stejné skóre: abecedně podle hráče
      return playerA.localeCompare(playerB);
    },
  });

  function makeTopKey(score: number, playerId: string): string {
    // Padding skóre pro správné stringové řazení (pokud nepoužíváme komparátor)
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
      // Aktualizace historie (ponechání posledních 10, nejnovější první)
      const playerHistory = history.lookup(playerId) ?? [];
      const updatedHistory = [score, ...playerHistory].slice(0, 10);
      history.insert(playerId, updatedHistory);

      // Kontrola zda je toto nové high score
      const currentHigh = scores.lookup(playerId);

      if (currentHigh === undefined || score > currentHigh) {
        // Odstranění starého záznamu z top scores
        if (currentHigh !== undefined) {
          topScores.delete(makeTopKey(currentHigh, playerId));
        }

        // Aktualizace aktuálního skóre
        scores.insert(playerId, score);

        // Přidání do top scores
        topScores.insert(makeTopKey(score, playerId), { playerId, score });

        // Oříznutí top scores na rozumnou velikost (ponechání top 100)
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
          // Žádné další záznamy
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

// Odeslání skóre
leaderboard.submitScore('alice', 100);
leaderboard.submitScore('bob', 150);
leaderboard.submitScore('charlie', 150); // Remíza s bob
leaderboard.submitScore('alice', 120);   // Nové high pro alice
leaderboard.submitScore('alice', 80);    // Není high score, ale je v historii

console.log(leaderboard.getPlayerScore('alice')); // 120 (nejvyšší)

console.log(leaderboard.getTop10());
// [
//   { playerId: 'bob', score: 150 },
//   { playerId: 'charlie', score: 150 },  // Abecedně po bob
//   { playerId: 'alice', score: 120 }
// ]

console.log(leaderboard.getHistory('alice'));
// [80, 120, 100] — nejnovější první

await leaderboard.close();
```

**Rozhodnutí o designu:**

1. **Tři tabulky pro tři záležitosti:**
   - `scores` (set): O(1) vyhledávání aktuálního skóre
   - `history` (set s hodnotou pole): Seřazená historie na hráče
   - `topScores` (ordered_set): Seřazený leaderboard

2. **Složený klíč pro top scores:** `"score:playerId"` umožňuje přirozené řazení

3. **Vlastní komparátor:** Zpracovává sestupné skóre + abecední tiebreaker

4. **Historie jako hodnota pole:** Zachovává pořadí vložení (bag/duplicate_bag by nezachoval)

5. **Oříznutí top scores:** Zabraňuje neomezenému růstu při zachování dostatku pro top 10

</details>

## Shrnutí

**Klíčové poznatky:**

- **Cache s TTL** — Kombinace `set` tabulky s expiration timestamps a cleanup timery
- **Session storage** — Použití složených klíčů nebo sekundárních indexů pro vícepólové dotazy
- **Čítače** — `updateCounter()` poskytuje atomický inkrement/dekrement pro metriky
- **ETS + GenServer** — Kombinace rychlého přístupu k datům ETS s koordinační logikou GenServeru
- **Vždy zavírejte tabulky** — Prevence memory leaků se správným čištěním

**Průvodce výběrem vzoru:**

| Případ použití | Vzor |
|----------------|------|
| Jednoduchá cache | `set` + TTL pole + líná expirace |
| Cache s vysokým provozem | Přidání periodického cleanup timeru |
| Cache s limitem velikosti | Přidání evikce při vkládání |
| Sessions | `set` + sledování expirace |
| Multi-user sessions | Přidání sekundárního indexu s `bag` |
| Počítání requestů | `updateCounter()` na `set` |
| Rate limiting | `ordered_set` pro časově okénkové buckety |
| Komplexní koordinace | GenServer + ETS hybrid |

**Zapamatujte si:**

> ETS vyniká v rychlém, souběžném přístupu k datům. Když potřebujete business logiku, koordinaci nebo supervizi, přidejte GenServer. Kombinace obou vám dává to nejlepší z obou světů.

---

Další: [EventBus](../08-vestavene-sluzby/01-eventbus.md)
