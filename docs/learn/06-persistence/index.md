# Part 6: Persistence

This section covers how to persist process state across restarts and recover from crashes.

## Chapters

### [6.1 Why Persistence?](./01-why-persistence.md)

Understand the need for state persistence:
- Surviving restarts
- Recovery after crash
- State snapshots

### [6.2 Storage Adapters](./02-storage-adapters.md)

Available storage backends:
- MemoryAdapter (dev/test)
- FileAdapter (simple)
- SQLiteAdapter (production)

### [6.3 Configuration](./03-configuration.md)

Configure persistence behavior:
- `snapshotIntervalMs`
- `persistOnShutdown`
- `restoreOnStart`

### [6.4 Schema Versioning](./04-schema-versioning.md)

Handle state evolution:
- `schemaVersion`
- `migrate()` callback

## Exercise

Add persistence to the Counter GenServer.

---

Start with: [Why Persistence?](./01-why-persistence.md)
