# Storage Adapters

In the previous chapter, you learned why persistence matters and how noex bridges the gap between ephemeral processes and long-lived data. Now let's explore the **storage adapters** — the pluggable backends that actually store your state.

noex provides three built-in adapters, each designed for different scenarios. Understanding when to use each one is key to building robust applications.

## What You'll Learn

- The `StorageAdapter` interface and how adapters work
- `MemoryAdapter` for testing and development
- `FileAdapter` for simple file-based persistence
- `SQLiteAdapter` for production-grade persistence
- How to choose the right adapter for your use case
- How to implement a custom adapter

## The StorageAdapter Interface

All storage adapters implement the same interface, making them interchangeable:

```typescript
interface StorageAdapter {
  // Core operations
  save(key: PersistenceKey, data: PersistedState<unknown>): Promise<void>;
  load<T>(key: PersistenceKey): Promise<PersistedState<T> | undefined>;
  delete(key: PersistenceKey): Promise<boolean>;
  exists(key: PersistenceKey): Promise<boolean>;
  listKeys(prefix?: string): Promise<readonly PersistenceKey[]>;

  // Optional operations
  cleanup?(maxAgeMs: number): Promise<number>;
  close?(): Promise<void>;
}
```

This uniform interface means you can:

1. **Develop with MemoryAdapter** — fast, no setup required
2. **Test with MemoryAdapter** — isolated, repeatable tests
3. **Deploy with FileAdapter or SQLiteAdapter** — just change the adapter, same code

```typescript
// Development
const adapter = new MemoryAdapter();

// Production
const adapter = new SQLiteAdapter({ filename: './data/state.db' });

// Same GenServer code works with both
const counter = await GenServer.start(counterBehavior, {
  persistence: { adapter, restoreOnStart: true },
});
```

---

## MemoryAdapter

The simplest adapter — stores everything in a JavaScript `Map`. Data exists only as long as the adapter instance exists.

### When to Use

- **Unit tests** — fast, isolated, no cleanup needed
- **Development** — quick iteration without file clutter
- **Temporary processes** — when you need persistence semantics but not durability

### Basic Usage

```typescript
import { MemoryAdapter, GenServer } from '@hamicek/noex';

const adapter = new MemoryAdapter();

const counter = await GenServer.start(counterBehavior, {
  name: 'test-counter',
  persistence: {
    adapter,
    restoreOnStart: true,
    persistOnShutdown: true,
  },
});
```

### Features

```typescript
const adapter = new MemoryAdapter();

// Check how many entries are stored
console.log(adapter.size); // 0

// Pre-populate for testing
const prepopulated = new MemoryAdapter({
  initialData: new Map([
    ['counter-1', {
      state: { count: 100 },
      metadata: {
        persistedAt: Date.now(),
        serverId: 'test',
        schemaVersion: 1,
      },
    }],
  ]),
});

// Clear all data (useful between tests)
adapter.clear();
```

### Testing Example

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryAdapter, GenServer } from '@hamicek/noex';

describe('Counter persistence', () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    // Fresh adapter for each test — complete isolation
    adapter = new MemoryAdapter();
  });

  it('restores state after restart', async () => {
    // Start counter and increment
    const counter1 = await GenServer.start(counterBehavior, {
      name: 'counter',
      persistence: { adapter, persistOnShutdown: true },
    });

    await GenServer.cast(counter1, 'increment');
    await GenServer.cast(counter1, 'increment');
    await GenServer.stop(counter1);

    // Start new counter with same name — should restore
    const counter2 = await GenServer.start(counterBehavior, {
      name: 'counter',
      persistence: { adapter, restoreOnStart: true },
    });

    const count = await GenServer.call(counter2, 'get');
    expect(count).toBe(2);

    await GenServer.stop(counter2);
  });
});
```

### Characteristics

| Aspect | MemoryAdapter |
|--------|---------------|
| **Durability** | None — lost on process exit |
| **Performance** | Fastest — pure memory operations |
| **Setup** | Zero — no configuration needed |
| **Concurrency** | Single process only |
| **Use case** | Testing, development |

---

## FileAdapter

Persists state as JSON files in a directory. Each GenServer gets its own file.

### When to Use

- **Simple applications** — single server, low complexity
- **Prototyping** — easy to inspect and debug (human-readable JSON)
- **Small state** — files work well for state under ~10MB
- **Single instance** — no concurrent access from multiple processes

### Basic Usage

```typescript
import { FileAdapter, GenServer } from '@hamicek/noex';

const adapter = new FileAdapter({
  directory: './data/persistence',
});

const counter = await GenServer.start(counterBehavior, {
  name: 'my-counter',
  persistence: {
    adapter,
    restoreOnStart: true,
    persistOnShutdown: true,
  },
});

// Creates file: ./data/persistence/my-counter.json
```

### Configuration Options

```typescript
const adapter = new FileAdapter({
  // Required: where to store files
  directory: './data/persistence',

  // Optional: file extension (default: '.json')
  extension: '.json',

  // Optional: human-readable JSON (default: false)
  prettyPrint: true,

  // Optional: verify data integrity with SHA256 (default: true)
  checksums: true,

  // Optional: atomic writes via temp file + rename (default: true)
  atomicWrites: true,
});
```

### File Structure

With `prettyPrint: true`, files look like this:

```json
{
  "state": {
    "count": 42,
    "lastUpdated": "2024-01-15T10:30:00.000Z"
  },
  "metadata": {
    "persistedAt": 1705312200000,
    "serverId": "gs_abc123",
    "serverName": "my-counter",
    "schemaVersion": 1
  },
  "checksum": "a3f2b8c9d4e5f6..."
}
```

### Safety Features

**Atomic Writes**

FileAdapter uses a write-to-temp-then-rename pattern to prevent corruption:

```
1. Write state to: my-counter.json.{uuid}.tmp
2. Rename atomically: my-counter.json.{uuid}.tmp → my-counter.json
```

If the process crashes during write, the temp file is left behind and the original file remains intact.

**Checksums**

SHA256 checksums detect corruption:

```typescript
// On save: compute checksum of serialized state
const checksum = sha256(JSON.stringify(state));

// On load: verify checksum matches
if (computedChecksum !== storedChecksum) {
  throw new ChecksumMismatchError(key, stored, computed);
}
```

### Example: Debug-Friendly Setup

```typescript
const adapter = new FileAdapter({
  directory: './data/state',
  prettyPrint: true,  // Easy to read with cat/less
  checksums: true,    // Detect corruption
  atomicWrites: true, // Crash safety
});

// After running, inspect state:
// $ cat ./data/state/my-counter.json | jq .
```

### Cleanup on Close

When you call `adapter.close()`, FileAdapter cleans up leftover temp files from interrupted writes:

```typescript
const adapter = new FileAdapter({ directory: './data' });

// ... use adapter ...

// Clean shutdown
await adapter.close(); // Removes any *.tmp files
```

### Characteristics

| Aspect | FileAdapter |
|--------|-------------|
| **Durability** | Durable — survives process restart |
| **Performance** | Good — filesystem caching helps |
| **Setup** | Minimal — just specify directory |
| **Concurrency** | Single process — no locking |
| **Use case** | Simple apps, prototypes, debugging |

---

## SQLiteAdapter

Production-grade persistence using SQLite database with WAL (Write-Ahead Logging) mode.

### When to Use

- **Production applications** — battle-tested, reliable
- **Many GenServers** — efficient for hundreds/thousands of processes
- **Concurrent reads** — WAL mode allows readers during writes
- **Need querying** — can query state directly with SQL tools

### Installation

SQLiteAdapter requires `better-sqlite3` as a peer dependency:

```bash
npm install better-sqlite3
# or
pnpm add better-sqlite3
```

### Basic Usage

```typescript
import { SQLiteAdapter, GenServer } from '@hamicek/noex';

const adapter = new SQLiteAdapter({
  filename: './data/state.db',
});

const counter = await GenServer.start(counterBehavior, {
  name: 'my-counter',
  persistence: {
    adapter,
    restoreOnStart: true,
    persistOnShutdown: true,
  },
});
```

### Configuration Options

```typescript
const adapter = new SQLiteAdapter({
  // Required: database file path (use ':memory:' for in-memory)
  filename: './data/state.db',

  // Optional: table name (default: 'noex_state')
  tableName: 'noex_state',

  // Optional: enable WAL mode for better concurrency (default: true)
  walMode: true,
});
```

### Database Schema

SQLiteAdapter creates this table automatically:

```sql
CREATE TABLE IF NOT EXISTS noex_state (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,        -- JSON serialized state + metadata
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### WAL Mode Benefits

With `walMode: true` (default), SQLite uses Write-Ahead Logging:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         WAL MODE BENEFITS                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Without WAL (journal mode):                                                │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐                            │
│  │  Writer  │────▶│  LOCKED  │────▶│  Reader  │ ✗ blocked                  │
│  └──────────┘     └──────────┘     └──────────┘                            │
│                                                                             │
│  With WAL mode:                                                             │
│  ┌──────────┐     ┌──────────┐                                             │
│  │  Writer  │────▶│   WAL    │                                             │
│  └──────────┘     └──────────┘                                             │
│                         │                                                   │
│  ┌──────────┐     ┌──────────┐                                             │
│  │  Reader  │────▶│   DB     │ ✓ reads committed data                      │
│  └──────────┘     └──────────┘                                             │
│                                                                             │
│  Result: Readers never block writers, writers never block readers           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### In-Memory Database

For testing with SQLite features but without file I/O:

```typescript
const adapter = new SQLiteAdapter({
  filename: ':memory:',
});

// Fast, isolated, but lost when adapter closes
```

### Inspecting State with SQL

You can query the database directly for debugging:

```bash
$ sqlite3 ./data/state.db

sqlite> SELECT key, json_extract(data, '$.state.count') as count
        FROM noex_state
        WHERE key LIKE 'counter%';

key          | count
-------------|------
counter-1    | 42
counter-2    | 17
```

### Example: Production Setup

```typescript
import { SQLiteAdapter, Application } from '@hamicek/noex';

const adapter = new SQLiteAdapter({
  filename: process.env.DB_PATH || './data/state.db',
  walMode: true,
});

const app = Application.create({
  // ... children ...
});

// Graceful shutdown ensures adapter is closed
process.on('SIGTERM', async () => {
  await app.stop();
  await adapter.close();
  process.exit(0);
});
```

### Characteristics

| Aspect | SQLiteAdapter |
|--------|---------------|
| **Durability** | Durable — ACID guarantees |
| **Performance** | Excellent — prepared statements, WAL |
| **Setup** | Requires `better-sqlite3` dependency |
| **Concurrency** | Multiple readers, single writer |
| **Use case** | Production applications |

---

## Choosing the Right Adapter

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ADAPTER SELECTION GUIDE                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────┐                                    │
│  │  Is this for testing or dev?        │                                    │
│  └─────────────────┬───────────────────┘                                    │
│                    │                                                        │
│          ┌────────┴────────┐                                               │
│          ▼                 ▼                                                │
│        YES                 NO                                               │
│          │                  │                                               │
│          ▼                  ▼                                               │
│   MemoryAdapter    ┌─────────────────────────────────────┐                 │
│                    │  Do you need to inspect state       │                 │
│                    │  files manually for debugging?      │                 │
│                    └─────────────────┬───────────────────┘                 │
│                                      │                                      │
│                    ┌────────────────┴────────────────┐                     │
│                    ▼                                 ▼                      │
│                   YES                               NO                      │
│                    │                                 │                      │
│                    ▼                                 ▼                      │
│             FileAdapter              ┌─────────────────────────────────┐   │
│             (prettyPrint: true)      │  How many GenServers will       │   │
│                                      │  you have?                       │   │
│                                      └─────────────────┬───────────────┘   │
│                                                        │                    │
│                                      ┌────────────────┴────────────────┐   │
│                                      ▼                                 ▼   │
│                                   < 50                              >= 50   │
│                                      │                                 │    │
│                                      ▼                                 ▼    │
│                               FileAdapter                      SQLiteAdapter│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Quick Reference Table

| Scenario | Recommended Adapter |
|----------|---------------------|
| Unit tests | `MemoryAdapter` |
| Integration tests | `MemoryAdapter` or `SQLiteAdapter({ filename: ':memory:' })` |
| Local development | `FileAdapter({ prettyPrint: true })` |
| Simple production (< 50 processes) | `FileAdapter` |
| Production (>= 50 processes) | `SQLiteAdapter` |
| Need SQL queries on state | `SQLiteAdapter` |
| Debugging persistence issues | `FileAdapter({ prettyPrint: true })` |

---

## Implementing a Custom Adapter

Need to store state in Redis, PostgreSQL, or S3? Implement the `StorageAdapter` interface:

```typescript
import type {
  StorageAdapter,
  PersistenceKey,
  PersistedState
} from '@hamicek/noex';

export class RedisAdapter implements StorageAdapter {
  private client: RedisClient;
  private prefix: string;

  constructor(options: { url: string; prefix?: string }) {
    this.client = createRedisClient(options.url);
    this.prefix = options.prefix ?? 'noex:';
  }

  private getKey(key: PersistenceKey): string {
    return `${this.prefix}${key}`;
  }

  async save(key: PersistenceKey, data: PersistedState<unknown>): Promise<void> {
    const serialized = JSON.stringify(data);
    await this.client.set(this.getKey(key), serialized);
  }

  async load<T>(key: PersistenceKey): Promise<PersistedState<T> | undefined> {
    const data = await this.client.get(this.getKey(key));
    if (data === null) {
      return undefined;
    }
    return JSON.parse(data) as PersistedState<T>;
  }

  async delete(key: PersistenceKey): Promise<boolean> {
    const result = await this.client.del(this.getKey(key));
    return result > 0;
  }

  async exists(key: PersistenceKey): Promise<boolean> {
    const result = await this.client.exists(this.getKey(key));
    return result > 0;
  }

  async listKeys(prefix?: string): Promise<readonly PersistenceKey[]> {
    const pattern = prefix
      ? `${this.prefix}${prefix}*`
      : `${this.prefix}*`;

    const keys = await this.client.keys(pattern);
    return keys.map(k => k.slice(this.prefix.length));
  }

  async cleanup(maxAgeMs: number): Promise<number> {
    const now = Date.now();
    const keys = await this.listKeys();
    let cleaned = 0;

    for (const key of keys) {
      const data = await this.load(key);
      if (data && now - data.metadata.persistedAt > maxAgeMs) {
        if (await this.delete(key)) {
          cleaned++;
        }
      }
    }

    return cleaned;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
```

### Best Practices for Custom Adapters

1. **Handle errors gracefully** — Throw `StorageError` with meaningful messages
2. **Implement `close()`** — Clean up connections and resources
3. **Consider atomicity** — Prevent partial writes where possible
4. **Test thoroughly** — Use the same test suite as built-in adapters
5. **Document limitations** — Note any concurrency or consistency constraints

---

## Exercise: Multi-Environment Configuration

Create a helper function that returns the appropriate adapter based on `NODE_ENV`:

```typescript
import { StorageAdapter, MemoryAdapter, FileAdapter, SQLiteAdapter } from '@hamicek/noex';

interface PersistenceConfig {
  dataDir?: string;
  dbPath?: string;
}

function createAdapter(config: PersistenceConfig = {}): StorageAdapter {
  const env = process.env.NODE_ENV || 'development';

  // Your implementation here:
  // - 'test': return MemoryAdapter
  // - 'development': return FileAdapter with prettyPrint
  // - 'production': return SQLiteAdapter
}
```

**Requirements:**

1. In `test` environment, use `MemoryAdapter`
2. In `development`, use `FileAdapter` with:
   - Directory from `config.dataDir` or `./data/dev`
   - `prettyPrint: true` for debugging
3. In `production`, use `SQLiteAdapter` with:
   - Database path from `config.dbPath` or `./data/state.db`
   - WAL mode enabled

### Solution

```typescript
import {
  StorageAdapter,
  MemoryAdapter,
  FileAdapter,
  SQLiteAdapter
} from '@hamicek/noex';

interface PersistenceConfig {
  dataDir?: string;
  dbPath?: string;
}

function createAdapter(config: PersistenceConfig = {}): StorageAdapter {
  const env = process.env.NODE_ENV || 'development';

  switch (env) {
    case 'test':
      return new MemoryAdapter();

    case 'development':
      return new FileAdapter({
        directory: config.dataDir || './data/dev',
        prettyPrint: true,
        checksums: true,
        atomicWrites: true,
      });

    case 'production':
      return new SQLiteAdapter({
        filename: config.dbPath || './data/state.db',
        walMode: true,
      });

    default:
      // Unknown environment — fail safe with MemoryAdapter
      console.warn(`Unknown NODE_ENV: ${env}, using MemoryAdapter`);
      return new MemoryAdapter();
  }
}

// Usage
const adapter = createAdapter({
  dataDir: process.env.DATA_DIR,
  dbPath: process.env.DB_PATH,
});

const counter = await GenServer.start(counterBehavior, {
  name: 'counter',
  persistence: {
    adapter,
    restoreOnStart: true,
    persistOnShutdown: true,
  },
});
```

---

## Summary

**Key takeaways:**

- **StorageAdapter interface** — All adapters are interchangeable, enabling easy swaps between environments
- **MemoryAdapter** — Zero-config, in-memory storage for tests and development
- **FileAdapter** — File-based persistence with atomic writes and checksums, great for simple apps and debugging
- **SQLiteAdapter** — Production-grade persistence with WAL mode, ideal for many processes
- **Choose based on needs** — Tests → Memory, Debug → File, Production → SQLite
- **Custom adapters** — Implement `StorageAdapter` to integrate with any backend

**The pattern:**

```typescript
// Same code, different adapters
const adapter = isTest ? new MemoryAdapter() : new SQLiteAdapter({ filename: './data.db' });
const server = await GenServer.start(behavior, { persistence: { adapter } });
```

---

Next: [Configuration](./03-configuration.md)
