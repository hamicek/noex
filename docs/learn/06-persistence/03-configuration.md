# Persistence Configuration

You've learned why persistence matters and how storage adapters work. Now let's explore the **full configuration API** — all the options that control when, how, and what gets persisted.

noex's persistence system is highly configurable. Understanding these options lets you tune persistence for your specific use case, from aggressive snapshotting for critical data to minimal persistence for cache-like state.

## What You'll Learn

- All `PersistenceConfig` options and their purpose
- Automatic snapshots with `snapshotIntervalMs`
- Restore behavior with `restoreOnStart` and `maxStateAgeMs`
- Custom persistence keys
- Cleanup strategies
- Custom serialization for complex state
- Error handling strategies
- Behavior hooks for fine-grained control
- Manual checkpoints

## The Complete Configuration

Here's the full `PersistenceConfig` interface with all available options:

```typescript
interface PersistenceConfig<State> {
  // Required
  adapter: StorageAdapter;

  // Timing
  snapshotIntervalMs?: number;      // Periodic snapshots
  persistOnShutdown?: boolean;      // Save on graceful stop (default: true)
  restoreOnStart?: boolean;         // Load on start (default: true)

  // State management
  key?: string;                     // Custom persistence key
  maxStateAgeMs?: number;           // Discard state older than this
  cleanupOnTerminate?: boolean;     // Delete state on terminate
  cleanupIntervalMs?: number;       // Periodic cleanup of old entries

  // Schema versioning
  schemaVersion?: number;           // Current version (default: 1)
  migrate?: (oldState: unknown, oldVersion: number) => State;

  // Serialization
  serialize?: (state: State) => unknown;
  deserialize?: (data: unknown) => State;

  // Error handling
  onError?: (error: Error) => void;
}
```

Let's explore each option in detail.

---

## Automatic Snapshots

### snapshotIntervalMs

Configures periodic automatic snapshots. When set, noex saves state to storage at regular intervals without any manual intervention.

```typescript
const counter = await GenServer.start(counterBehavior, {
  name: 'counter',
  persistence: {
    adapter,
    snapshotIntervalMs: 30000, // Save every 30 seconds
  },
});
```

**When to use:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SNAPSHOT INTERVAL GUIDELINES                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Interval            Use Case                       Trade-off               │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  1-5 seconds         Financial transactions,        High I/O,               │
│                      payment processing             more storage writes     │
│                                                                             │
│  30-60 seconds       User sessions,                 Balanced for most       │
│                      shopping carts                 applications            │
│                                                                             │
│  5-10 minutes        Cache-like data,               Low I/O,                │
│                      derivable state                more data loss risk     │
│                                                                             │
│  undefined/0         Shutdown-only persistence      Minimal I/O,            │
│                      (not recommended for           crash = total loss      │
│                      critical data)                 since last shutdown     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Example — Financial data (aggressive):**

```typescript
const paymentProcessor = await GenServer.start(paymentBehavior, {
  name: 'payments',
  persistence: {
    adapter,
    snapshotIntervalMs: 5000,      // Every 5 seconds
    persistOnShutdown: true,
  },
});
```

**Example — Session cache (relaxed):**

```typescript
const sessionCache = await GenServer.start(sessionBehavior, {
  name: 'sessions',
  persistence: {
    adapter,
    snapshotIntervalMs: 300000,    // Every 5 minutes
    persistOnShutdown: true,
  },
});
```

---

## Shutdown and Startup Behavior

### persistOnShutdown

Controls whether state is saved when the GenServer stops gracefully. Defaults to `true`.

```typescript
persistence: {
  adapter,
  persistOnShutdown: true,  // Save state when GenServer.stop() is called
}
```

This triggers during:
- `GenServer.stop(ref)` calls
- Supervisor-initiated shutdowns
- Application shutdown via signal handlers

It does **not** trigger during:
- Process crashes (uncaught exceptions)
- `kill -9` or forceful termination
- Out-of-memory kills

**When to disable:**

```typescript
// Ephemeral state that shouldn't survive restart
const tempWorker = await GenServer.start(workerBehavior, {
  name: 'temp-worker',
  persistence: {
    adapter,
    persistOnShutdown: false,    // Don't save on shutdown
    snapshotIntervalMs: 30000,   // But still save periodically (crash recovery)
  },
});
```

### restoreOnStart

Controls whether state is loaded from storage when the GenServer starts. Defaults to `true`.

```typescript
persistence: {
  adapter,
  restoreOnStart: true,  // Load previous state if available
}
```

When `restoreOnStart` is `true` and persisted state exists:
1. State is loaded from storage
2. `init()` is **skipped** — the restored state is used directly
3. `onStateRestore` callback is called (if defined)

When `restoreOnStart` is `false` or no persisted state exists:
1. `init()` is called as normal
2. Fresh state is initialized

**Example — Always start fresh:**

```typescript
// Recompute state on every start (maybe from external source)
const aggregator = await GenServer.start(aggregatorBehavior, {
  name: 'aggregator',
  persistence: {
    adapter,
    restoreOnStart: false,       // Always call init()
    persistOnShutdown: true,     // But save for inspection/debugging
  },
});
```

---

## State Age Management

### maxStateAgeMs

Discards persisted state that's older than the specified age. Useful for state that becomes invalid over time.

```typescript
persistence: {
  adapter,
  restoreOnStart: true,
  maxStateAgeMs: 24 * 60 * 60 * 1000,  // 24 hours
}
```

When loading, if the state is older than `maxStateAgeMs`:
1. State is discarded (treated as not found)
2. `init()` is called to create fresh state
3. A `StaleStateError` is passed to `onError` (if configured)

**Use cases:**

```typescript
// Session that expires after 24 hours
const session = await GenServer.start(sessionBehavior, {
  name: `session-${userId}`,
  persistence: {
    adapter,
    maxStateAgeMs: 24 * 60 * 60 * 1000,  // 24 hours
  },
});

// Cache that invalidates after 1 hour
const cache = await GenServer.start(cacheBehavior, {
  name: 'api-cache',
  persistence: {
    adapter,
    maxStateAgeMs: 60 * 60 * 1000,       // 1 hour
  },
});

// Rate limiter window that resets daily
const rateLimiter = await GenServer.start(rateLimitBehavior, {
  name: `rate-${ip}`,
  persistence: {
    adapter,
    maxStateAgeMs: 24 * 60 * 60 * 1000,  // Reset daily
  },
});
```

---

## Custom Persistence Keys

### key

By default, noex uses the GenServer's registered name (or ID if unnamed) as the persistence key. You can override this with a custom key.

```typescript
persistence: {
  adapter,
  key: 'custom-key',  // Use this instead of server name/ID
}
```

**When to use custom keys:**

1. **Namespacing:** Prefix keys to organize storage

```typescript
const userSession = await GenServer.start(sessionBehavior, {
  name: `session-${userId}`,
  persistence: {
    adapter,
    key: `sessions:user:${userId}`,  // Structured key
  },
});
```

2. **Migration:** Keep the same key when renaming servers

```typescript
// Old server was named 'user-service', new name is 'auth-service'
const auth = await GenServer.start(authBehavior, {
  name: 'auth-service',
  persistence: {
    adapter,
    key: 'user-service',  // Preserve data from old name
  },
});
```

3. **Shared state:** Multiple servers sharing the same persisted state

```typescript
// Primary server
const primary = await GenServer.start(behavior, {
  name: 'primary',
  persistence: { adapter, key: 'shared-state' },
});

// Backup server (on different node) uses same key
const backup = await GenServer.start(behavior, {
  name: 'backup',
  persistence: { adapter, key: 'shared-state', restoreOnStart: true },
});
```

---

## Cleanup Strategies

### cleanupOnTerminate

When `true`, deletes the persisted state when the GenServer terminates. Useful for temporary processes.

```typescript
persistence: {
  adapter,
  cleanupOnTerminate: true,  // Delete state when server stops
}
```

**Use case — Temporary session:**

```typescript
// When user logs out, delete their session data
const session = await GenServer.start(sessionBehavior, {
  name: `session-${sessionId}`,
  persistence: {
    adapter,
    persistOnShutdown: false,       // Don't save on logout
    cleanupOnTerminate: true,       // Delete existing data
  },
});

// On logout
await GenServer.stop(session);  // State is deleted
```

### cleanupIntervalMs

Periodically removes stale entries from storage. Requires `maxStateAgeMs` to be set.

```typescript
persistence: {
  adapter,
  maxStateAgeMs: 60 * 60 * 1000,       // 1 hour
  cleanupIntervalMs: 10 * 60 * 1000,   // Check every 10 minutes
}
```

This helps prevent storage bloat from orphaned entries (e.g., sessions that were never properly terminated).

---

## Custom Serialization

### serialize and deserialize

By default, state is serialized as JSON. For complex state types (Date objects, Maps, Sets, class instances), you need custom serialization.

```typescript
interface State {
  lastUpdated: Date;
  items: Map<string, number>;
}

const server = await GenServer.start(behavior, {
  name: 'complex-state',
  persistence: {
    adapter,
    serialize: (state: State) => ({
      lastUpdated: state.lastUpdated.toISOString(),
      items: Array.from(state.items.entries()),
    }),
    deserialize: (data: unknown) => {
      const raw = data as { lastUpdated: string; items: [string, number][] };
      return {
        lastUpdated: new Date(raw.lastUpdated),
        items: new Map(raw.items),
      };
    },
  },
});
```

**Common patterns:**

```typescript
// Date serialization
serialize: (state) => ({
  ...state,
  createdAt: state.createdAt.toISOString(),
  updatedAt: state.updatedAt.toISOString(),
}),
deserialize: (data) => {
  const raw = data as RawState;
  return {
    ...raw,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
  };
},

// Set serialization
serialize: (state) => ({
  ...state,
  tags: Array.from(state.tags),
}),
deserialize: (data) => {
  const raw = data as RawState;
  return {
    ...raw,
    tags: new Set(raw.tags),
  };
},

// BigInt serialization
serialize: (state) => ({
  ...state,
  balance: state.balance.toString(),
}),
deserialize: (data) => {
  const raw = data as RawState;
  return {
    ...raw,
    balance: BigInt(raw.balance),
  };
},
```

---

## Error Handling

### onError

Callback invoked when persistence operations fail. Doesn't prevent the error from propagating but allows logging, metrics, or alerting.

```typescript
persistence: {
  adapter,
  onError: (error) => {
    console.error('Persistence error:', error.message);
    metrics.increment('persistence.errors');
    alerting.notify('persistence-failure', { error: error.message });
  },
}
```

**Error types you might receive:**

```typescript
import {
  StorageError,        // General storage operation failure
  StateNotFoundError,  // No persisted state for key
  StaleStateError,     // State older than maxStateAgeMs
  MigrationError,      // Schema migration failed
} from '@hamicek/noex';

persistence: {
  adapter,
  onError: (error) => {
    if (error instanceof StaleStateError) {
      console.log(`Discarding stale state: ${error.age}ms old`);
    } else if (error instanceof StateNotFoundError) {
      console.log(`No previous state for: ${error.key}`);
    } else if (error instanceof MigrationError) {
      console.error(`Migration failed from v${error.fromVersion} to v${error.toVersion}`);
    } else {
      console.error('Storage error:', error);
    }
  },
}
```

---

## Behavior Hooks

In addition to configuration options, you can define callbacks in your GenServer behavior for fine-grained control over persistence.

### onStateRestore

Called after state is successfully restored from persistence. Allows transformation, validation, or side effects.

```typescript
const behavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init: () => ({ count: 0, startedAt: Date.now() }),

  onStateRestore: (restoredState, metadata) => {
    console.log(`Restored state from ${new Date(metadata.persistedAt)}`);

    // Update timestamp on restore
    return {
      ...restoredState,
      startedAt: Date.now(),  // Fresh timestamp
      restoredFrom: metadata.persistedAt,
    };
  },

  handleCall: (msg, state) => { /* ... */ },
  handleCast: (msg, state) => { /* ... */ },
};
```

**Use cases:**

```typescript
// Validate restored state
onStateRestore: (state, metadata) => {
  if (!isValidState(state)) {
    throw new Error('Invalid persisted state');
  }
  return state;
},

// Merge with fresh data
onStateRestore: async (state, metadata) => {
  const freshData = await fetchLatestConfig();
  return {
    ...state,
    config: freshData,  // Always use latest config
  };
},

// Log recovery
onStateRestore: (state, metadata) => {
  const age = Date.now() - metadata.persistedAt;
  console.log(`Recovered state from ${age}ms ago`);
  return state;
},
```

### beforePersist

Called before state is persisted. Allows filtering, transformation, or skipping persistence entirely.

```typescript
const behavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init: () => ({
    count: 0,
    tempData: null,      // Temporary, shouldn't persist
    lastRequest: null,   // Large object, skip
  }),

  beforePersist: (state) => {
    // Return modified state for persistence
    // Or undefined to skip this persistence
    const { tempData, lastRequest, ...persistable } = state;
    return persistable;
  },

  handleCall: (msg, state) => { /* ... */ },
  handleCast: (msg, state) => { /* ... */ },
};
```

**Use cases:**

```typescript
// Skip persisting if state hasn't changed meaningfully
beforePersist: (state) => {
  if (state.pendingChanges === 0) {
    return undefined;  // Skip this snapshot
  }
  return state;
},

// Remove sensitive data
beforePersist: (state) => {
  const { password, apiKey, ...safe } = state;
  return safe;
},

// Compress large arrays before persisting
beforePersist: (state) => {
  return {
    ...state,
    largeArray: state.largeArray.slice(-1000),  // Keep only last 1000
  };
},
```

---

## Manual Checkpoints

Sometimes you need to persist state immediately, not waiting for the next interval or shutdown. Use `GenServer.checkpoint()`.

```typescript
import { GenServer } from '@hamicek/noex';

// After a critical operation, force immediate save
async function processCriticalPayment(ref: GenServerRef, payment: Payment) {
  await GenServer.call(ref, { type: 'process', payment });

  // Don't wait for interval — save immediately
  await GenServer.checkpoint(ref);
}
```

**When to use checkpoints:**

- After critical transactions
- Before risky operations
- At business logic boundaries
- When user explicitly saves

```typescript
// API endpoint that explicitly saves user progress
app.post('/api/save-progress', async (req, res) => {
  const session = Registry.lookup(`session-${req.userId}`);

  await GenServer.call(session, { type: 'update', data: req.body });
  await GenServer.checkpoint(session);

  res.json({ saved: true });
});
```

---

## Putting It All Together

Here's a complete example showing multiple configuration options working together:

```typescript
import {
  GenServer,
  GenServerBehavior,
  SQLiteAdapter,
  StateMetadata,
} from '@hamicek/noex';

interface OrderState {
  orderId: string;
  items: Map<string, number>;
  status: 'pending' | 'paid' | 'shipped';
  createdAt: Date;
  updatedAt: Date;
}

const adapter = new SQLiteAdapter({ filename: './data/orders.db' });

const orderBehavior: GenServerBehavior<
  OrderState,
  { type: 'addItem'; sku: string; qty: number } | { type: 'getStatus' },
  { type: 'updateStatus'; status: OrderState['status'] },
  OrderState['status'] | void
> = {
  init: () => ({
    orderId: crypto.randomUUID(),
    items: new Map(),
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
  }),

  onStateRestore: (state, metadata) => {
    console.log(`Order ${state.orderId} restored from ${new Date(metadata.persistedAt)}`);
    return state;
  },

  beforePersist: (state) => {
    // Always persist with fresh updatedAt
    return {
      ...state,
      updatedAt: new Date(),
    };
  },

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'addItem': {
        const current = state.items.get(msg.sku) ?? 0;
        const newItems = new Map(state.items);
        newItems.set(msg.sku, current + msg.qty);
        return [undefined, { ...state, items: newItems }];
      }
      case 'getStatus':
        return [state.status, state];
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'updateStatus') {
      return { ...state, status: msg.status };
    }
    return state;
  },
};

const order = await GenServer.start(orderBehavior, {
  name: 'order-12345',
  persistence: {
    adapter,

    // Timing
    snapshotIntervalMs: 30000,       // Every 30 seconds
    persistOnShutdown: true,
    restoreOnStart: true,

    // State management
    key: 'orders:12345',             // Namespaced key
    maxStateAgeMs: 7 * 24 * 60 * 60 * 1000,  // 7 days

    // Schema versioning
    schemaVersion: 2,
    migrate: (oldState, oldVersion) => {
      if (oldVersion === 1) {
        // v1 had items as array, v2 uses Map
        const old = oldState as { items: [string, number][] };
        return {
          ...oldState,
          items: new Map(old.items),
        } as OrderState;
      }
      return oldState as OrderState;
    },

    // Serialization (for Map and Date)
    serialize: (state) => ({
      ...state,
      items: Array.from(state.items.entries()),
      createdAt: state.createdAt.toISOString(),
      updatedAt: state.updatedAt.toISOString(),
    }),
    deserialize: (data) => {
      const raw = data as {
        orderId: string;
        items: [string, number][];
        status: OrderState['status'];
        createdAt: string;
        updatedAt: string;
      };
      return {
        ...raw,
        items: new Map(raw.items),
        createdAt: new Date(raw.createdAt),
        updatedAt: new Date(raw.updatedAt),
      };
    },

    // Error handling
    onError: (error) => {
      console.error(`Order persistence error: ${error.message}`);
    },
  },
});
```

---

## Exercise: Configurable Session Manager

Create a session manager with the following requirements:

1. Sessions expire after 30 minutes of inactivity
2. State is saved every minute
3. Session data is cleaned up when user logs out
4. Sensitive fields (password hash, tokens) are excluded from persistence
5. Restored sessions update their "lastActive" timestamp

**Starting point:**

```typescript
interface SessionState {
  userId: string;
  email: string;
  passwordHash: string;        // Don't persist
  accessToken: string;         // Don't persist
  lastActive: Date;
  preferences: {
    theme: 'light' | 'dark';
    language: string;
  };
}

const sessionBehavior: GenServerBehavior<
  SessionState,
  { type: 'getPreferences' } | { type: 'touch' },
  { type: 'updatePreferences'; prefs: Partial<SessionState['preferences']> },
  SessionState['preferences'] | void
> = {
  // Implement init, handlers, and hooks...
};
```

### Solution

```typescript
import { GenServer, GenServerBehavior, FileAdapter, StateMetadata } from '@hamicek/noex';

interface SessionState {
  userId: string;
  email: string;
  passwordHash: string;
  accessToken: string;
  lastActive: Date;
  preferences: {
    theme: 'light' | 'dark';
    language: string;
  };
}

// Type for persisted state (without sensitive fields)
interface PersistedSessionState {
  userId: string;
  email: string;
  lastActive: string;  // ISO string
  preferences: SessionState['preferences'];
}

const adapter = new FileAdapter({ directory: './data/sessions' });

const sessionBehavior: GenServerBehavior<
  SessionState,
  { type: 'getPreferences' } | { type: 'touch' },
  { type: 'updatePreferences'; prefs: Partial<SessionState['preferences']> },
  SessionState['preferences'] | void
> = {
  init: () => ({
    userId: '',
    email: '',
    passwordHash: '',
    accessToken: '',
    lastActive: new Date(),
    preferences: {
      theme: 'light',
      language: 'en',
    },
  }),

  onStateRestore: (state, metadata) => {
    console.log(`Session restored, was saved ${Date.now() - metadata.persistedAt}ms ago`);

    // Update lastActive on restore
    return {
      ...state,
      lastActive: new Date(),
      // Sensitive fields need to be re-populated after restore
      passwordHash: '',
      accessToken: '',
    };
  },

  beforePersist: (state) => {
    // Exclude sensitive fields
    const { passwordHash, accessToken, ...safe } = state;
    return safe as SessionState;
  },

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'getPreferences':
        return [state.preferences, { ...state, lastActive: new Date() }];
      case 'touch':
        return [undefined, { ...state, lastActive: new Date() }];
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'updatePreferences') {
      return {
        ...state,
        lastActive: new Date(),
        preferences: { ...state.preferences, ...msg.prefs },
      };
    }
    return state;
  },
};

async function createSession(userId: string, email: string): Promise<GenServerRef> {
  return GenServer.start(sessionBehavior, {
    name: `session-${userId}`,
    persistence: {
      adapter,

      // Session expires after 30 minutes
      maxStateAgeMs: 30 * 60 * 1000,

      // Save every minute
      snapshotIntervalMs: 60 * 1000,
      persistOnShutdown: true,
      restoreOnStart: true,

      // Namespaced key
      key: `sessions:${userId}`,

      // Date serialization
      serialize: (state) => ({
        ...state,
        lastActive: state.lastActive.toISOString(),
      }),
      deserialize: (data) => {
        const raw = data as PersistedSessionState;
        return {
          ...raw,
          lastActive: new Date(raw.lastActive),
          passwordHash: '',  // Not in persisted data
          accessToken: '',   // Not in persisted data
        };
      },

      onError: (error) => {
        console.error(`Session persistence error: ${error.message}`);
      },
    },
  });
}

async function logoutSession(ref: GenServerRef) {
  // Stop with cleanup to delete persisted state
  await GenServer.stop(ref);
  // Note: For actual cleanup, you'd reconfigure with cleanupOnTerminate: true
  // or manually call adapter.delete()
}
```

---

## Summary

**Key takeaways:**

- **`snapshotIntervalMs`** — Automatic periodic saves; tune based on data criticality
- **`persistOnShutdown`** — Saves on graceful stop (default: true)
- **`restoreOnStart`** — Loads state on startup, skips `init()` (default: true)
- **`maxStateAgeMs`** — Discards stale state; essential for sessions and caches
- **`key`** — Custom persistence key for namespacing or migration
- **`cleanupOnTerminate`** — Deletes state when server stops
- **`serialize`/`deserialize`** — Handle complex types (Date, Map, Set, etc.)
- **`onError`** — Central error handling for all persistence operations
- **`onStateRestore`/`beforePersist`** — Behavior hooks for fine-grained control
- **`GenServer.checkpoint()`** — Force immediate save when needed

**Configuration checklist:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PERSISTENCE CONFIGURATION CHECKLIST                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  □ Choose appropriate snapshotIntervalMs for data criticality              │
│  □ Set maxStateAgeMs if state should expire                                 │
│  □ Add serialize/deserialize if state has Date, Map, Set, or BigInt        │
│  □ Implement onError for logging and alerting                              │
│  □ Use beforePersist to exclude sensitive or temporary data                │
│  □ Use onStateRestore to validate or refresh restored state                │
│  □ Consider cleanupOnTerminate for temporary processes                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

Next: [Schema Versioning](./04-schema-versioning.md)
