# Persistence API Reference

The persistence module provides a pluggable state persistence layer for GenServer. It enables automatic state saving and restoration across process restarts.

## Import

```typescript
import {
  // Storage Adapters
  MemoryAdapter,
  FileAdapter,
  SQLiteAdapter,
  // Event Log Adapters
  MemoryEventLogAdapter,
  SQLiteEventLogAdapter,
  // Manager
  PersistenceManager,
  // Serializers
  defaultSerializer,
  createPrettySerializer,
  // Error classes
  PersistenceError,
  StateNotFoundError,
  SerializationError,
  DeserializationError,
  CorruptedStateError,
  StaleStateError,
  StorageError,
  MigrationError,
  ChecksumMismatchError,
} from 'noex';
```

## Overview

The persistence system consists of:

- **Storage Adapters** - Pluggable backends for storing state snapshots (Memory, File, SQLite)
- **Event Log Adapters** - Append-only event stream storage (Memory, SQLite)
- **PersistenceManager** - High-level API for save/load operations
- **GenServer Integration** - Automatic state persistence via configuration

## Types

### PersistenceConfig

Configuration for enabling persistence on a GenServer.

```typescript
interface PersistenceConfig<State> {
  /** Storage adapter to use for persistence */
  readonly adapter: StorageAdapter;

  /** Custom persistence key. Defaults to server name or ID. */
  readonly key?: string;

  /**
   * Interval in milliseconds for automatic snapshots.
   * Set to undefined or 0 to disable periodic snapshots.
   */
  readonly snapshotIntervalMs?: number;

  /**
   * Whether to persist state on graceful shutdown.
   * @default true
   */
  readonly persistOnShutdown?: boolean;

  /**
   * Whether to restore state on server start.
   * @default true
   */
  readonly restoreOnStart?: boolean;

  /**
   * Maximum age in milliseconds for restored state.
   * State older than this will be discarded.
   */
  readonly maxStateAgeMs?: number;

  /**
   * Whether to delete persisted state on server termination.
   * When true, all persisted data for this server will be removed on shutdown.
   * @default false
   */
  readonly cleanupOnTerminate?: boolean;

  /**
   * Interval in milliseconds for automatic cleanup of stale entries.
   * Requires maxStateAgeMs to be set. When configured, periodically removes
   * entries older than maxStateAgeMs from storage.
   */
  readonly cleanupIntervalMs?: number;

  /**
   * Schema version for migration support.
   * @default 1
   */
  readonly schemaVersion?: number;

  /**
   * Migration function for upgrading state from older schema versions.
   */
  readonly migrate?: (oldState: unknown, oldVersion: number) => State;

  /** Custom serialization function. */
  readonly serialize?: (state: State) => unknown;

  /** Custom deserialization function. */
  readonly deserialize?: (data: unknown) => State;

  /** Error handler for persistence failures. */
  readonly onError?: (error: Error) => void;
}
```

### StateMetadata

Metadata stored alongside the persisted state.

```typescript
interface StateMetadata {
  /** Unix timestamp (ms) when the state was persisted */
  readonly persistedAt: number;
  /** Unique identifier of the GenServer instance */
  readonly serverId: string;
  /** Optional registered name of the GenServer */
  readonly serverName?: string;
  /** Schema version for migration support */
  readonly schemaVersion: number;
  /** Optional checksum for integrity verification */
  readonly checksum?: string;
}
```

### PersistedState

Container for persisted state with its metadata.

```typescript
interface PersistedState<T> {
  readonly state: T;
  readonly metadata: StateMetadata;
}
```

### StorageAdapter

Interface for implementing custom storage backends.

```typescript
interface StorageAdapter {
  save(key: string, data: PersistedState<unknown>): Promise<void>;
  load<T>(key: string): Promise<PersistedState<T> | undefined>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  listKeys(prefix?: string): Promise<readonly string[]>;
  cleanup?(maxAgeMs: number): Promise<number>;
  close?(): Promise<void>;
}
```

---

## Storage Adapters

### MemoryAdapter

In-memory storage for testing and development. Data is not persisted across restarts.

```typescript
import { MemoryAdapter } from 'noex';

const adapter = new MemoryAdapter();
```

**Options:**

```typescript
interface MemoryAdapterOptions {
  /** Initial data to populate the adapter with. */
  readonly initialData?: ReadonlyMap<string, PersistedState<unknown>>;
}
```

**Additional Methods:**

- `size: number` - Current number of stored entries
- `clear(): void` - Clears all stored data

**Example:**

```typescript
const adapter = new MemoryAdapter();

// Use in GenServer
const ref = await GenServer.start(behavior, {
  persistence: {
    adapter,
    snapshotIntervalMs: 5000,
  },
});

// Check storage size
console.log(`Stored entries: ${adapter.size}`);

// Clear for testing
adapter.clear();
```

---

### FileAdapter

File-based persistence with atomic writes and integrity verification.

```typescript
import { FileAdapter } from 'noex';

const adapter = new FileAdapter({
  directory: './data/persistence',
});
```

**Options:**

```typescript
interface FileAdapterOptions {
  /** Directory path where state files will be stored. */
  readonly directory: string;

  /**
   * File extension for state files.
   * @default '.json'
   */
  readonly extension?: string;

  /**
   * Whether to format JSON output for human readability.
   * @default false
   */
  readonly prettyPrint?: boolean;

  /**
   * Whether to compute and verify SHA256 checksums.
   * @default true
   */
  readonly checksums?: boolean;

  /**
   * Whether to use atomic writes (write to temp file, then rename).
   * @default true
   */
  readonly atomicWrites?: boolean;
}
```

**Features:**

- Atomic writes via temp file + rename pattern
- SHA256 checksums for data integrity
- Automatic directory creation
- Safe filename encoding for keys
- Pretty-print option for debugging

**Example:**

```typescript
const adapter = new FileAdapter({
  directory: './data/state',
  prettyPrint: true,
  checksums: true,
  atomicWrites: true,
});

const ref = await GenServer.start(counterBehavior, {
  name: 'counter',
  persistence: {
    adapter,
    key: 'counter-state', // Saves to ./data/state/counter-state.json
    persistOnShutdown: true,
    restoreOnStart: true,
  },
});
```

---

### SQLiteAdapter

SQLite database persistence with WAL mode support. Requires `better-sqlite3` as a peer dependency.

```bash
npm install better-sqlite3
```

```typescript
import { SQLiteAdapter } from 'noex';

const adapter = new SQLiteAdapter({
  filename: './data/state.db',
});
```

**Options:**

```typescript
interface SQLiteAdapterOptions {
  /**
   * Path to the SQLite database file.
   * Use ':memory:' for an in-memory database.
   */
  readonly filename: string;

  /**
   * Name of the table to store state data.
   * @default 'noex_state'
   */
  readonly tableName?: string;

  /**
   * Whether to enable WAL (Write-Ahead Logging) mode.
   * @default true
   */
  readonly walMode?: boolean;
}
```

**Features:**

- WAL mode for better concurrency
- Lazy initialization (database created on first operation)
- Prepared statements for performance
- In-memory database support

**Example:**

```typescript
const adapter = new SQLiteAdapter({
  filename: './data/app.db',
  tableName: 'genserver_state',
  walMode: true,
});

const ref = await GenServer.start(behavior, {
  name: 'service',
  persistence: {
    adapter,
    snapshotIntervalMs: 30000,
  },
});

// Close adapter when done
await adapter.close();
```

---

## Event Log

The event log provides append-only, ordered event streams for deterministic replay. Each stream maintains an independent, monotonically increasing sequence counter.

### Types

#### EventEntry

A single entry in an append-only event log stream.

```typescript
interface EventEntry<T = unknown> {
  /** Monotonically increasing sequence number within the stream */
  readonly seq: number;
  /** Unix timestamp (ms) when the event was created */
  readonly timestamp: number;
  /** Event type identifier for filtering and routing */
  readonly type: string;
  /** Event payload data */
  readonly payload: T;
  /** Optional metadata for tracing, correlation, etc. */
  readonly metadata?: Record<string, unknown>;
}
```

#### ReadOptions

Options for reading events from a stream.

```typescript
interface ReadOptions {
  /** Start reading from this sequence number (inclusive) */
  readonly fromSeq?: number;
  /** Stop reading at this sequence number (inclusive) */
  readonly toSeq?: number;
  /** Maximum number of events to return */
  readonly limit?: number;
  /** Filter events by type(s) */
  readonly types?: readonly string[];
}
```

#### EventLogAdapter

Interface for append-only event log storage backends.

```typescript
interface EventLogAdapter {
  append(streamId: string, events: readonly EventEntry[]): Promise<number>;
  read(streamId: string, options?: ReadOptions): Promise<readonly EventEntry[]>;
  readAfter(streamId: string, afterSeq: number): Promise<readonly EventEntry[]>;
  getLastSeq(streamId: string): Promise<number>;
  truncateBefore(streamId: string, beforeSeq: number): Promise<number>;
  listStreams(prefix?: string): Promise<readonly string[]>;
  close?(): Promise<void>;
}
```

---

### MemoryEventLogAdapter

In-memory event log for testing and development. Data is not persisted across restarts.

```typescript
import { MemoryEventLogAdapter } from 'noex';

const log = new MemoryEventLogAdapter();
```

**Additional Methods:**

- `streamCount: number` - Current number of active streams
- `clear(): void` - Clears all streams and resets sequence counters

**Example:**

```typescript
const log = new MemoryEventLogAdapter();

await log.append('orders', [
  { seq: 0, timestamp: Date.now(), type: 'OrderCreated', payload: { id: '123' } },
  { seq: 0, timestamp: Date.now(), type: 'OrderPaid', payload: { id: '123', amount: 99 } },
]);

// Read all events
const events = await log.read('orders');

// Read events after seq 1
const newEvents = await log.readAfter('orders', 1);

// Filter by type
const payments = await log.read('orders', { types: ['OrderPaid'] });

// Compaction: remove old events
await log.truncateBefore('orders', 2);
```

---

### SQLiteEventLogAdapter

SQLite-based event log with WAL mode support. Provides durable, append-only event storage. Requires `better-sqlite3` as a peer dependency.

```bash
npm install better-sqlite3
```

```typescript
import { SQLiteEventLogAdapter } from 'noex';

const log = new SQLiteEventLogAdapter({
  filename: './data/events.db',
});
```

**Options:**

```typescript
interface SQLiteEventLogAdapterOptions {
  /**
   * Path to the SQLite database file.
   * Use ':memory:' for an in-memory database.
   */
  readonly filename: string;

  /**
   * Name of the table to store event log entries.
   * @default 'event_log'
   */
  readonly tableName?: string;

  /**
   * Whether to enable WAL (Write-Ahead Logging) mode.
   * @default true
   */
  readonly walMode?: boolean;
}
```

**Features:**

- WAL mode for better read/write concurrency
- Lazy initialization (database created on first operation)
- Prepared statements for optimal performance
- Composite primary key `(stream_id, seq)` for efficient lookups
- Index on `(stream_id, type)` for type-filtered reads
- Events persist across process restarts

**Additional Methods:**

- `getFilename(): string` - Returns the configured database filename
- `getTableName(): string` - Returns the configured table name

**SQLite Schema:**

```sql
CREATE TABLE event_log (
  stream_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,  -- JSON
  metadata TEXT,          -- JSON, nullable
  PRIMARY KEY (stream_id, seq)
);

CREATE INDEX idx_event_log_type ON event_log(stream_id, type);
```

**Example:**

```typescript
const log = new SQLiteEventLogAdapter({
  filename: './data/workflow-events.db',
});

// Append events to a stream
const lastSeq = await log.append('workflow:abc', [
  { seq: 0, timestamp: Date.now(), type: 'StepStarted', payload: { step: 'validate' } },
  { seq: 0, timestamp: Date.now(), type: 'StepCompleted', payload: { step: 'validate', result: 'ok' } },
]);
console.log(`Last seq: ${lastSeq}`); // 2

// Read with filtering
const completions = await log.read('workflow:abc', {
  types: ['StepCompleted'],
});

// Replay from a specific point
const fromSeq3 = await log.readAfter('workflow:abc', 2);

// List all workflow streams
const streams = await log.listStreams('workflow:');

// Compaction: remove events before seq 10
const removed = await log.truncateBefore('workflow:abc', 10);

// Close when done
await log.close();
```

---

## GenServer Integration

### Basic Configuration

Enable persistence by providing a `persistence` option when starting a GenServer:

```typescript
import { GenServer, FileAdapter } from 'noex';

const adapter = new FileAdapter({ directory: './data' });

const ref = await GenServer.start(counterBehavior, {
  name: 'counter',
  persistence: {
    adapter,
    restoreOnStart: true,
    persistOnShutdown: true,
  },
});
```

### Periodic Snapshots

Automatically save state at regular intervals:

```typescript
const ref = await GenServer.start(behavior, {
  persistence: {
    adapter,
    snapshotIntervalMs: 60000, // Save every minute
  },
});
```

### Manual Checkpoints

Save state on demand using `GenServer.checkpoint()`:

```typescript
// Trigger immediate save
await GenServer.checkpoint(ref);

// With custom options
await GenServer.checkpoint(ref, { force: true });
```

### Get Last Checkpoint Metadata

```typescript
const metadata = await GenServer.getLastCheckpointMeta(ref);
if (metadata) {
  console.log(`Last saved: ${new Date(metadata.persistedAt)}`);
  console.log(`Schema version: ${metadata.schemaVersion}`);
}
```

### Clear Persisted State

```typescript
await GenServer.clearPersistedState(ref);
```

---

## State Cleanup

The persistence system provides automatic cleanup capabilities to manage storage over time.

### Cleanup on Termination

Delete persisted state when the server shuts down:

```typescript
const ref = await GenServer.start(behavior, {
  persistence: {
    adapter,
    cleanupOnTerminate: true, // Delete state on shutdown
  },
});

// When this server stops, its persisted state will be removed
await GenServer.stop(ref);
```

This is useful for:
- Temporary servers with ephemeral state
- Test environments where state should not persist
- Servers that fully rebuild state on restart

### Periodic Cleanup

Automatically remove stale entries from storage at regular intervals:

```typescript
const ref = await GenServer.start(behavior, {
  persistence: {
    adapter,
    maxStateAgeMs: 24 * 60 * 60 * 1000, // 24 hours
    cleanupIntervalMs: 60 * 60 * 1000,   // Run cleanup every hour
  },
});
```

Periodic cleanup requires `maxStateAgeMs` to be set. Entries older than `maxStateAgeMs` will be removed during each cleanup cycle.

### PersistenceManager Methods

The `PersistenceManager` exposes cleanup methods directly:

```typescript
const manager = new PersistenceManager({
  adapter,
  key: 'my-server',
  maxStateAgeMs: 86400000, // 24 hours
});

// Manually trigger cleanup of stale entries
const removedCount = await manager.cleanup();
console.log(`Removed ${removedCount} stale entries`);

// Cleanup with custom age threshold
const count = await manager.cleanup(3600000); // Remove entries older than 1 hour

// Close the adapter when done (releases connections/file handles)
await manager.close();
```

---

## Behavior Hooks

GenServer behaviors can implement hooks for persistence customization:

### onStateRestore

Called when state is restored from persistence. Use to transform or validate restored state.

```typescript
const behavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init: () => ({ count: 0 }),

  onStateRestore(restoredState, metadata) {
    console.log(`Restoring state from ${new Date(metadata.persistedAt)}`);
    // Return transformed state or original
    return {
      ...restoredState,
      restoredAt: Date.now(),
    };
  },

  // ... other handlers
};
```

### beforePersist

Called before state is saved. Return `undefined` to skip persistence.

```typescript
const behavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init: () => ({ data: [], dirty: false }),

  beforePersist(state) {
    // Only persist if dirty
    if (!state.dirty) {
      return undefined; // Skip save
    }
    // Remove transient fields before saving
    const { dirty, ...persistable } = state;
    return persistable;
  },

  // ... other handlers
};
```

---

## Schema Migration

Handle state schema changes between versions:

```typescript
interface StateV1 {
  count: number;
}

interface StateV2 {
  count: number;
  lastUpdated: number;
}

const ref = await GenServer.start(behavior, {
  persistence: {
    adapter,
    schemaVersion: 2,
    migrate: (oldState, oldVersion) => {
      if (oldVersion === 1) {
        const v1 = oldState as StateV1;
        return {
          count: v1.count,
          lastUpdated: Date.now(),
        };
      }
      return oldState as StateV2;
    },
  },
});
```

---

## Lifecycle Events

The persistence system emits lifecycle events:

```typescript
const ref = await GenServer.start(behavior, {
  persistence: { adapter },
});

// Listen for persistence events
GenServer.subscribe(ref, (event) => {
  switch (event.type) {
    case 'state_restored':
      console.log('State restored from persistence');
      break;
    case 'state_persisted':
      console.log('State saved to persistence');
      break;
    case 'persistence_error':
      console.error('Persistence failed:', event.error);
      break;
  }
});
```

---

## Error Classes

### PersistenceError

Base class for persistence-related errors.

```typescript
class PersistenceError extends Error {
  readonly cause?: Error;
}
```

### StateNotFoundError

Thrown when attempting to load state that does not exist.

```typescript
class StateNotFoundError extends Error {
  readonly key: string;
}
```

### SerializationError

Thrown when state serialization fails.

```typescript
class SerializationError extends Error {
  readonly cause?: Error;
}
```

### DeserializationError

Thrown when state deserialization fails.

```typescript
class DeserializationError extends Error {
  readonly cause?: Error;
}
```

### CorruptedStateError

Thrown when persisted state fails integrity checks.

```typescript
class CorruptedStateError extends Error {
  readonly key: string;
}
```

### StaleStateError

Thrown when persisted state exceeds maximum age.

```typescript
class StaleStateError extends Error {
  readonly key: string;
  readonly ageMs: number;
  readonly maxAgeMs: number;
}
```

### StorageError

Thrown when a storage operation fails.

```typescript
class StorageError extends Error {
  readonly operation: 'save' | 'load' | 'delete' | 'exists' | 'listKeys' | 'cleanup' | 'close';
  readonly cause?: Error;
}
```

### MigrationError

Thrown when state migration fails.

```typescript
class MigrationError extends Error {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly cause?: Error;
}
```

### ChecksumMismatchError

Thrown when checksum verification fails.

```typescript
class ChecksumMismatchError extends Error {
  readonly key: string;
  readonly expected: string;
  readonly actual: string;
}
```

---

## Complete Example

```typescript
import { GenServer, FileAdapter, type GenServerBehavior } from 'noex';

interface CounterState {
  count: number;
  lastModified: number;
}

type CounterCall = { type: 'get' } | { type: 'increment'; amount: number };
type CounterCast = { type: 'reset' };
type CounterReply = number;

const counterBehavior: GenServerBehavior<CounterState, CounterCall, CounterCast, CounterReply> = {
  init: () => ({ count: 0, lastModified: Date.now() }),

  onStateRestore(state, metadata) {
    console.log(`Restored state from ${new Date(metadata.persistedAt)}`);
    return state;
  },

  beforePersist(state) {
    // Always persist
    return state;
  },

  handleCall(state, message) {
    switch (message.type) {
      case 'get':
        return { reply: state.count };
      case 'increment':
        return {
          newState: {
            count: state.count + message.amount,
            lastModified: Date.now(),
          },
          reply: state.count + message.amount,
        };
    }
  },

  handleCast(state, message) {
    switch (message.type) {
      case 'reset':
        return { newState: { count: 0, lastModified: Date.now() } };
    }
  },
};

async function main() {
  const adapter = new FileAdapter({
    directory: './data/counters',
    prettyPrint: true,
  });

  const counter = await GenServer.start(counterBehavior, {
    name: 'main-counter',
    persistence: {
      adapter,
      key: 'main-counter',
      snapshotIntervalMs: 30000, // Save every 30 seconds
      persistOnShutdown: true,
      restoreOnStart: true,
      maxStateAgeMs: 24 * 60 * 60 * 1000, // Discard state older than 24 hours
      cleanupIntervalMs: 60 * 60 * 1000,   // Cleanup stale entries every hour
      cleanupOnTerminate: false,           // Keep state after shutdown (default)
      schemaVersion: 1,
      onError: (err) => console.error('Persistence error:', err),
    },
  });

  // Use the counter
  await GenServer.call(counter, { type: 'increment', amount: 5 });
  const value = await GenServer.call(counter, { type: 'get' });
  console.log(`Counter value: ${value}`);

  // Manual checkpoint
  await GenServer.checkpoint(counter);

  // Check metadata
  const meta = await GenServer.getLastCheckpointMeta(counter);
  console.log(`Last checkpoint: ${meta?.persistedAt}`);

  // Graceful shutdown (auto-saves state)
  await GenServer.stop(counter);

  // Clean up adapter
  await adapter.close();
}
```

---

## Related

- [GenServer API](./genserver.md) - GenServer documentation
- [Types](./types.md) - Type definitions
- [Errors](./errors.md) - Error classes
