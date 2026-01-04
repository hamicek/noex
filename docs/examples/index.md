# Examples

Annotated code examples demonstrating noex patterns and best practices.

## Basic Examples

### [Basic Counter](./basic-counter.md)

A minimal GenServer example showing core concepts:
- State management
- Synchronous calls and async casts
- Lifecycle hooks

**Complexity**: Simple | **Lines**: ~50

---

### [Cache Service](./cache-service.md)

A key-value cache with TTL support:
- Built-in Cache service usage
- Expiration and eviction policies
- Statistics tracking

**Complexity**: Simple | **Lines**: ~40

---

## Intermediate Examples

### [Worker Pool](./worker-pool.md)

A dynamic pool of workers for parallel processing:
- DynamicSupervisor pattern
- Work distribution
- Load balancing

**Complexity**: Intermediate | **Lines**: ~100

---

### [Web Server](./web-server.md)

WebSocket chat server with connection management:
- Per-connection GenServers
- EventBus integration
- Broadcasting patterns

**Complexity**: Intermediate | **Lines**: ~150

---

## Advanced Examples

### [Supervision Tree](./supervision-tree.md)

Multi-tier application with supervision:
- Nested supervisors
- Service isolation
- Recovery strategies

**Complexity**: Advanced | **Lines**: ~200

---

## Running Examples

All examples can be run directly with tsx:

```bash
npx tsx example.ts
```

Or compile with TypeScript and run:

```bash
tsc example.ts
node example.js
```

## Related

- [Quick Start](../getting-started/quick-start.md) - Get started with noex
- [Tutorials](../tutorials/index.md) - Step-by-step guides
- [API Reference](../api/index.md) - Complete API documentation
