# API Reference

Complete API documentation for all noex modules.

## Core

The foundational building blocks for concurrent applications.

| Module | Description |
|--------|-------------|
| [GenServer](./genserver.md) | Stateful process abstraction |
| [Supervisor](./supervisor.md) | Fault tolerance and automatic restarts |
| [Registry](./registry.md) | Named process lookup |

## Services

Pre-built services for common use cases.

| Module | Description |
|--------|-------------|
| [EventBus](./event-bus.md) | Pub/sub event distribution |
| [Cache](./cache.md) | In-memory cache with TTL |
| [RateLimiter](./rate-limiter.md) | Rate limiting with sliding window |

## Observability

Tools for monitoring and debugging.

| Module | Description |
|--------|-------------|
| [Observer](./observer.md) | Runtime introspection |
| [AlertManager](./alert-manager.md) | Threshold-based alerts |
| [Dashboard](./dashboard.md) | Terminal UI for monitoring |
| [DashboardServer](./dashboard-server.md) | HTTP dashboard server |

## Persistence

State persistence for GenServer processes.

| Module | Description |
|--------|-------------|
| [Persistence](./persistence.md) | State persistence with pluggable adapters |

## Distribution

APIs for building distributed systems.

| Module | Description |
|--------|-------------|
| [Cluster](../distribution/api/cluster.md) | Node discovery and membership |
| [RemoteCall](../distribution/api/remote-call.md) | Cross-node call/cast messaging |
| [RemoteSpawn](../distribution/api/remote-spawn.md) | Remote process spawning |
| [GlobalRegistry](../distribution/api/global-registry.md) | Cluster-wide process naming |
| [RemoteMonitor](../distribution/api/remote-monitor.md) | Cross-node process monitoring |
| [DistributedSupervisor](../distribution/api/distributed-supervisor.md) | Multi-node supervision |
| [Distribution Types](../distribution/api/types.md) | Type definitions and errors |

## Types & Errors

| Module | Description |
|--------|-------------|
| [Types](./types.md) | All type definitions |
| [Errors](./errors.md) | Error classes |

## Quick Reference

### Starting Processes

```typescript
// GenServer
const ref = await GenServer.start(behavior);

// Supervisor
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [{ id: 'worker', start: () => GenServer.start(behavior) }],
});
```

### Message Passing

```typescript
// Synchronous (waits for reply)
const result = await GenServer.call(ref, message);

// Asynchronous (fire-and-forget)
GenServer.cast(ref, message);
```

### Process Lookup

```typescript
// Register
Registry.register('service-name', ref);

// Lookup (throws if not found)
const ref = Registry.lookup('service-name');

// Lookup (returns undefined if not found)
const ref = Registry.whereis('service-name');
```

### Stopping Processes

```typescript
// GenServer
await GenServer.stop(ref);

// Supervisor (stops all children)
await Supervisor.stop(supervisor);
```

### Error Handling

```typescript
import {
  CallTimeoutError,
  ServerNotRunningError,
  InitializationError,
  MaxRestartsExceededError,
  NotRegisteredError,
} from 'noex';

try {
  await GenServer.call(ref, msg);
} catch (error) {
  if (error instanceof CallTimeoutError) {
    // Handle timeout
  }
}
```
