# Why Persistence?

So far, all the GenServers and state machines we've built share one critical limitation: **they lose everything when the process stops**. Restart your Node.js application, and every counter resets to zero, every session disappears, every order workflow vanishes.

This chapter explores why persistence matters and how noex's persistence system solves this fundamental problem.

## What You'll Learn

- Why in-memory state is insufficient for production applications
- The difference between process lifecycle and data lifecycle
- How persistence enables crash recovery and horizontal scaling
- When to use persistence (and when not to)

## The Problem: Ephemeral State

Consider this counter GenServer we built in earlier chapters:

```typescript
const counterBehavior: GenServerBehavior<
  { count: number },
  'get',
  'increment',
  number
> = {
  init: () => ({ count: 0 }),

  handleCall: (msg, state) => {
    if (msg === 'get') {
      return [state, state.count];
    }
    throw new Error('Unknown message');
  },

  handleCast: (msg, state) => {
    if (msg === 'increment') {
      return { count: state.count + 1 };
    }
    return state;
  },
};

// Start counter
const counter = await GenServer.start(counterBehavior, { name: 'my-counter' });

// Increment 1000 times
for (let i = 0; i < 1000; i++) {
  GenServer.cast(counter, 'increment');
}

// Get count
const count = await GenServer.call(counter, 'get');
console.log(count); // 1000

// Now restart the application...
// The count is gone. Back to 0.
```

This isn't a bug — it's how in-memory processes work. But for real applications, this creates serious problems.

## Real-World Scenarios

### Scenario 1: Deployment

You deploy a new version of your application. During the deployment:

```
Before deployment:
  - UserSession processes: 5,000 active sessions
  - ShoppingCart processes: 2,300 carts with items
  - RateLimiter state: Request counts for 10,000 IPs

After deployment:
  - All state: GONE
  - Users: Logged out, carts empty, rate limits reset
  - Result: Angry customers, security vulnerability
```

### Scenario 2: Crash Recovery

Your application crashes due to an out-of-memory error:

```
Before crash:
  - OrderWorkflow in 'shipped' state, tracking number saved
  - PaymentProcessor with pending transactions
  - NotificationQueue with 500 pending emails

After crash:
  - Orders stuck in limbo
  - Payments need manual reconciliation
  - Notifications lost forever
```

### Scenario 3: Scaling

You need to add more servers to handle load:

```
Server A: UserSession-alice (authenticated, preferences loaded)
Server B: [New server, no state]

Request from Alice → routed to Server B → "Who is Alice?"
```

## Two Lifecycles

The core insight is that **process lifecycle and data lifecycle are different**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PROCESS vs DATA LIFECYCLE                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  PROCESS LIFECYCLE (ephemeral):                                             │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐           │
│  │  start   │────▶│ running  │────▶│ stopping │────▶│ stopped  │           │
│  └──────────┘     └──────────┘     └──────────┘     └──────────┘           │
│       │                │                                   │                │
│       │                │                                   │                │
│   seconds ───────── minutes to hours ─────────────────seconds               │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  DATA LIFECYCLE (persistent):                                               │
│  ┌──────────┐                                           ┌──────────┐       │
│  │ created  │──────────────────────────────────────────▶│ archived │       │
│  └──────────┘                                           └──────────┘       │
│       │                                                       │             │
│       │                                                       │             │
│      days ─────────────── months to years ────────────── forever            │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  THE GAP:                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Process restarts    Data must survive                              │   │
│  │  Process crashes  ▶  Data must recover                              │   │
│  │  Process moves       Data must be accessible                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  PERSISTENCE BRIDGES THIS GAP                                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Persistence decouples your data's lifetime from your process's lifetime.

## How noex Persistence Works

noex provides a persistence layer that integrates directly with GenServer and GenStateMachine. At its core, it works through **state snapshots**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      PERSISTENCE FLOW                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  SAVE (automatic or manual):                                                │
│                                                                             │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐                │
│  │  GenServer   │────▶│  Serialize   │────▶│   Storage    │                │
│  │    State     │     │    State     │     │   Adapter    │                │
│  └──────────────┘     └──────────────┘     └──────────────┘                │
│                             │                     │                         │
│                             ▼                     ▼                         │
│                       JSON + metadata        Memory / File / SQLite         │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  RESTORE (on start):                                                        │
│                                                                             │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐                │
│  │   Storage    │────▶│ Deserialize  │────▶│  GenServer   │                │
│  │   Adapter    │     │    State     │     │    State     │                │
│  └──────────────┘     └──────────────┘     └──────────────┘                │
│        │                                         │                          │
│        ▼                                         ▼                          │
│  Read from disk            Validate, migrate     Skip init(), use           │
│  or database               if schema changed     restored state             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### A Taste of Persistence

Here's the same counter, now with persistence:

```typescript
import { GenServer, FileAdapter } from '@hamicek/noex';

const adapter = new FileAdapter({ directory: './data' });

const counter = await GenServer.start(counterBehavior, {
  name: 'my-counter',
  persistence: {
    adapter,
    restoreOnStart: true,      // Load previous state on start
    persistOnShutdown: true,   // Save state on graceful shutdown
    snapshotIntervalMs: 30000, // Also save every 30 seconds
  },
});

// Increment 1000 times
for (let i = 0; i < 1000; i++) {
  GenServer.cast(counter, 'increment');
}

// Graceful shutdown - state is saved
await GenServer.stop(counter);

// Later, restart the application...
const counter2 = await GenServer.start(counterBehavior, {
  name: 'my-counter',
  persistence: {
    adapter,
    restoreOnStart: true,
    persistOnShutdown: true,
  },
});

// State was restored!
const count = await GenServer.call(counter2, 'get');
console.log(count); // 1000 - preserved across restarts!
```

## What Gets Persisted?

noex persists the **entire state object** as a snapshot, plus metadata:

```typescript
interface PersistedState<State> {
  // Your state - exactly what your process holds
  state: State;

  // Metadata for recovery and debugging
  metadata: {
    persistedAt: number;      // When was this saved?
    serverId: string;         // Which process instance saved it?
    serverName?: string;      // Registered name (if any)
    schemaVersion: number;    // For migrations
    checksum?: string;        // Integrity verification
  };
}
```

This means:

1. **Full state** — Not events, not deltas, the complete state
2. **Point-in-time** — A snapshot at a specific moment
3. **Self-contained** — Everything needed to restore the process

## When Snapshots Are Saved

Persistence can be triggered in several ways:

```typescript
persistence: {
  adapter,

  // 1. On graceful shutdown (default: true)
  persistOnShutdown: true,

  // 2. At regular intervals (set to 0 to disable)
  snapshotIntervalMs: 60000, // Every minute

  // 3. Manual checkpoint (always available)
  // await GenServer.checkpoint(ref);
}
```

### Choosing Snapshot Frequency

The `snapshotIntervalMs` setting trades off between:

| Frequent Snapshots | Infrequent Snapshots |
|--------------------|----------------------|
| Less data loss on crash | Less I/O overhead |
| More disk writes | Better performance |
| Larger storage usage | Smaller storage |
| Suitable for critical data | Suitable for cache-like data |

```typescript
// Critical financial data - save frequently
const paymentProcessor = await GenServer.start(paymentBehavior, {
  persistence: {
    adapter,
    snapshotIntervalMs: 5000, // Every 5 seconds
  },
});

// Session cache - save less often, loss is acceptable
const sessionCache = await GenServer.start(sessionBehavior, {
  persistence: {
    adapter,
    snapshotIntervalMs: 300000, // Every 5 minutes
    // Or even: persistOnShutdown only
  },
});
```

## Recovery Scenarios

### Graceful Shutdown

The happy path — your application shuts down cleanly:

```
1. GenServer.stop(ref) called
2. terminate() callback executes
3. State saved to storage (if persistOnShutdown: true)
4. Process exits
5. Later: Process starts, state restored, continues where it left off
```

### Crash Recovery

The process dies unexpectedly:

```
1. Process crashes (OOM, uncaught exception, kill -9)
2. terminate() may not execute
3. Last snapshot is the recovery point
4. Data since last snapshot is lost
5. Later: Process starts, recovers from last snapshot
```

This is why `snapshotIntervalMs` matters — it determines your **maximum data loss window**.

### Stale State Detection

Sometimes old state shouldn't be restored:

```typescript
persistence: {
  adapter,
  maxStateAgeMs: 24 * 60 * 60 * 1000, // 24 hours
}
```

If the persisted state is older than `maxStateAgeMs`, it's considered stale and discarded. The process starts fresh with `init()`.

Use cases:
- Session data that should expire
- Cache that becomes invalid over time
- Temporary state that's meaningless after a day

## When NOT to Use Persistence

Persistence isn't always the answer:

### 1. Truly Ephemeral State

```typescript
// WebSocket connection state - meaningless after disconnect
const connectionBehavior = {
  init: () => ({
    socketId: generateId(),
    connectedAt: Date.now(),
    // This state is tied to a specific connection
    // Persisting it makes no sense
  }),
};

// NO persistence needed
const conn = await GenServer.start(connectionBehavior);
```

### 2. Derivable State

```typescript
// Aggregation that can be recomputed from source data
const dashboardBehavior = {
  init: async () => {
    // This state is derived from database queries
    // Persisting it just creates stale duplicates
    return await computeDashboardMetrics();
  },
};

// NO persistence - recompute on start
```

### 3. High-Frequency Updates

```typescript
// Real-time metrics updated 100 times/second
const metricsBehavior = {
  handleCast: (msg, state) => {
    // If we persist every change, we'd write 100 times/second
    // That's 8.6 million writes per day - too much
    return { ...state, value: msg.value };
  },
};

// Consider: aggregate in memory, persist periodically
// Or: use EventBus to stream to a time-series database
```

### Decision Framework

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SHOULD YOU USE PERSISTENCE?                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────┐                                    │
│  │  Is the state valuable after        │                                    │
│  │  process restart?                   │                                    │
│  └─────────────────┬───────────────────┘                                    │
│                    │                                                        │
│          ┌────────┴────────┐                                               │
│          ▼                 ▼                                                │
│        YES                NO ──────────▶ Don't persist                     │
│          │                                                                  │
│          ▼                                                                  │
│  ┌─────────────────────────────────────┐                                    │
│  │  Can it be recomputed cheaply       │                                    │
│  │  from other sources?                │                                    │
│  └─────────────────┬───────────────────┘                                    │
│                    │                                                        │
│          ┌────────┴────────┐                                               │
│          ▼                 ▼                                                │
│        YES                 NO                                               │
│          │                  │                                               │
│          ▼                  ▼                                               │
│   Don't persist      ┌─────────────────────────────────────┐               │
│   (recompute)        │  How critical is data loss?         │               │
│                      └─────────────────┬───────────────────┘               │
│                                        │                                    │
│                    ┌───────────────────┼───────────────────┐                │
│                    ▼                   ▼                   ▼                │
│               Critical            Important           Nice-to-have          │
│                    │                   │                   │                │
│                    ▼                   ▼                   ▼                │
│          Frequent snapshots    Moderate snapshots    Shutdown only          │
│          (5-30 seconds)        (1-5 minutes)         persistence            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Preview: What's Next

In the following chapters, you'll learn:

1. **Storage Adapters** — MemoryAdapter for testing, FileAdapter for simple cases, SQLiteAdapter for production
2. **Configuration** — All the persistence options and when to use them
3. **Schema Versioning** — How to migrate state when your data model changes

## Summary

**Key takeaways:**

- **Process lifetime ≠ Data lifetime** — Persistence bridges the gap between ephemeral processes and long-lived data
- **Snapshots, not events** — noex persists complete state snapshots, not individual changes
- **Multiple triggers** — Save on shutdown, at intervals, or manually via checkpoint
- **Recovery modes** — Graceful shutdown preserves everything; crash recovery loses data since last snapshot
- **Not always needed** — Ephemeral, derivable, or high-frequency state may not need persistence

**The fundamental question:**

> "If this process restarts, will users notice?"

If yes, you need persistence. If no, you probably don't.

---

Next: [Storage Adapters](./02-storage-adapters.md)
