# Supervisor

Supervisor is noex's abstraction for building fault-tolerant systems. It monitors child processes (GenServers) and automatically restarts them when they crash, following the "let it crash" philosophy from Elixir/OTP.

## Overview

A Supervisor provides:
- **Automatic restarts** - Failed processes are restarted without manual intervention
- **Restart strategies** - Control how failures affect sibling processes
- **Restart intensity** - Prevent infinite restart loops
- **Ordered lifecycle** - Children start in order, stop in reverse

```typescript
import { Supervisor, GenServer } from 'noex';

const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },
    { id: 'worker', start: () => GenServer.start(workerBehavior) },
  ],
});

// Children are automatically restarted on crash
// Eventually...
await Supervisor.stop(supervisor);
```

## Restart Strategies

The restart strategy determines what happens when a child process crashes.

### one_for_one (Default)

Only restart the crashed child. Other children continue running.

```
Before crash:     After crash:
[A] [B] [C]       [A] [B'] [C]
     ↓ crash           ↑ restarted
```

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'a', start: () => GenServer.start(behaviorA) },
    { id: 'b', start: () => GenServer.start(behaviorB) },
    { id: 'c', start: () => GenServer.start(behaviorC) },
  ],
});
```

**Use when:** Children are independent and don't share state.

### one_for_all

When one child crashes, restart ALL children. Ensures all siblings are in a consistent state.

```
Before crash:     Stop all:        Restart all:
[A] [B] [C]       [×] [×] [×]      [A'] [B'] [C']
     ↓ crash
```

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_all',
  children: [
    { id: 'db', start: () => GenServer.start(dbBehavior) },
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },
    { id: 'api', start: () => GenServer.start(apiBehavior) },
  ],
});
```

**Use when:** Children depend on each other and must restart together to maintain consistency.

### rest_for_one

Restart the crashed child AND all children started after it. Children started before continue running.

```
Before crash:     Stop B & C:      Restart B & C:
[A] [B] [C]       [A] [×] [×]      [A] [B'] [C']
     ↓ crash
```

```typescript
const supervisor = await Supervisor.start({
  strategy: 'rest_for_one',
  children: [
    { id: 'config', start: () => GenServer.start(configBehavior) },   // stays running
    { id: 'pool', start: () => GenServer.start(poolBehavior) },       // crashes → restarts
    { id: 'worker', start: () => GenServer.start(workerBehavior) },   // also restarts
  ],
});
```

**Use when:** Later children depend on earlier children (e.g., worker depends on connection pool).

## Child Specification

Each child is defined by a `ChildSpec` object:

```typescript
interface ChildSpec {
  id: string;                        // Unique identifier
  start: () => Promise<GenServerRef>; // Factory function
  restart?: ChildRestartStrategy;    // 'permanent' | 'transient' | 'temporary'
  shutdownTimeout?: number;          // Graceful shutdown timeout (ms)
}
```

### Child Restart Strategies

Individual children can override the restart behavior:

| Strategy | Behavior | Use Case |
|----------|----------|----------|
| `permanent` | Always restart (default) | Critical services |
| `transient` | Restart only on abnormal exit | Tasks that may complete normally |
| `temporary` | Never restart | One-shot tasks |

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    // Always restart - critical cache service
    {
      id: 'cache',
      start: () => GenServer.start(cacheBehavior),
      restart: 'permanent',
    },
    // Restart on crash, not on normal exit
    {
      id: 'job-processor',
      start: () => GenServer.start(jobBehavior),
      restart: 'transient',
    },
    // Never restart - cleanup task
    {
      id: 'cleanup',
      start: () => GenServer.start(cleanupBehavior),
      restart: 'temporary',
    },
  ],
});
```

### Shutdown Timeout

Control how long to wait for graceful shutdown:

```typescript
{
  id: 'database',
  start: () => GenServer.start(dbBehavior),
  shutdownTimeout: 30000,  // 30 seconds to close connections
}
```

If the child doesn't stop within the timeout, it's forcefully terminated.

## Restart Intensity

Restart intensity prevents infinite restart loops. If too many restarts happen in a time window, the supervisor itself shuts down.

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  restartIntensity: {
    maxRestarts: 3,    // Max 3 restarts...
    withinMs: 5000,    // ...within 5 seconds
  },
  children: [...],
});
```

**Default values:**
- `maxRestarts`: 3
- `withinMs`: 5000 (5 seconds)

### MaxRestartsExceededError

When restart intensity is exceeded:

```typescript
import { MaxRestartsExceededError } from 'noex';

try {
  // Supervisor with a constantly crashing child
  const supervisor = await Supervisor.start({
    children: [{ id: 'unstable', start: () => GenServer.start(crashingBehavior) }],
  });
} catch (error) {
  if (error instanceof MaxRestartsExceededError) {
    console.error(`Supervisor gave up after ${error.maxRestarts} restarts`);
  }
}
```

## Dynamic Child Management

Add and remove children at runtime:

### Starting Children Dynamically

```typescript
const supervisor = await Supervisor.start({ strategy: 'one_for_one' });

// Add a child later
const workerRef = await Supervisor.startChild(supervisor, {
  id: 'worker-1',
  start: () => GenServer.start(workerBehavior),
});

// Add another
await Supervisor.startChild(supervisor, {
  id: 'worker-2',
  start: () => GenServer.start(workerBehavior),
});
```

### Terminating Children

```typescript
// Remove a specific child (graceful shutdown)
await Supervisor.terminateChild(supervisor, 'worker-1');
```

### Restarting Children

```typescript
// Force restart a specific child
const newRef = await Supervisor.restartChild(supervisor, 'cache');
```

### Querying Children

```typescript
// Get all children
const children = Supervisor.getChildren(supervisor);
for (const child of children) {
  console.log(`${child.id}: restarts=${child.restartCount}`);
}

// Get specific child
const cache = Supervisor.getChild(supervisor, 'cache');
if (cache) {
  console.log(`Cache has restarted ${cache.restartCount} times`);
}

// Count children
const count = Supervisor.countChildren(supervisor);
```

## Startup and Shutdown Order

### Startup Order

Children start sequentially in the order specified:

```typescript
const supervisor = await Supervisor.start({
  children: [
    { id: 'config', start: ... },   // 1. Starts first
    { id: 'database', start: ... }, // 2. Starts second
    { id: 'api', start: ... },      // 3. Starts third
  ],
});
```

If any child fails to start, the supervisor:
1. Stops all already-started children (in reverse order)
2. Throws the error

### Shutdown Order

Children stop in **reverse** order (last started = first stopped):

```typescript
await Supervisor.stop(supervisor);
// 1. api stops first
// 2. database stops second
// 3. config stops last
```

This ensures dependencies are respected during shutdown.

## Lifecycle Events

Monitor supervisor and child lifecycle:

```typescript
const unsubscribe = Supervisor.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Supervisor started: ${event.ref.id}`);
      break;
    case 'restarted':
      console.log(`Child restarted: attempt #${event.attempt}`);
      break;
    case 'terminated':
      console.log(`Terminated: ${event.ref.id}, reason: ${event.reason}`);
      break;
  }
});

// Stop listening
unsubscribe();
```

## Supervision Trees

Supervisors can supervise other supervisors, creating hierarchical fault isolation:

```typescript
// Create sub-supervisors
const workerSupervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'worker-1', start: () => GenServer.start(workerBehavior) },
    { id: 'worker-2', start: () => GenServer.start(workerBehavior) },
  ],
});

const cacheSupervisor = await Supervisor.start({
  strategy: 'one_for_all',
  children: [
    { id: 'primary', start: () => GenServer.start(cacheBehavior) },
    { id: 'replica', start: () => GenServer.start(cacheBehavior) },
  ],
});

// Top-level supervisor manages the sub-supervisors
const rootSupervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'workers', start: async () => workerSupervisor as any },
    { id: 'caches', start: async () => cacheSupervisor as any },
  ],
});
```

### Benefits of Supervision Trees

1. **Fault isolation** - Failures in one branch don't affect others
2. **Granular restart policies** - Different strategies per subsystem
3. **Clear boundaries** - Logical grouping of related processes

## Best Practices

### 1. Design for Failure

Expect processes to crash. Keep state recoverable:

```typescript
// Good: State can be rebuilt
const cacheBehavior = {
  init: async () => {
    const data = await loadFromDatabase();
    return { data };
  },
  // ...
};

// Avoid: Critical state lost on crash
const badBehavior = {
  init: () => ({ transactions: [] }), // Lost on restart!
  // ...
};
```

### 2. Choose the Right Strategy

| Scenario | Strategy |
|----------|----------|
| Independent workers | `one_for_one` |
| Tightly coupled services | `one_for_all` |
| Pipeline with dependencies | `rest_for_one` |

### 3. Set Appropriate Restart Intensity

```typescript
// For stable services - strict limits
restartIntensity: { maxRestarts: 3, withinMs: 60000 }

// For volatile services - more tolerance
restartIntensity: { maxRestarts: 10, withinMs: 60000 }
```

### 4. Use Meaningful Child IDs

```typescript
// Good: Descriptive IDs
{ id: 'user-cache' }
{ id: 'email-worker' }
{ id: 'metrics-collector' }

// Avoid: Generic IDs
{ id: 'worker1' }
{ id: 'service' }
```

### 5. Handle Startup Failures

```typescript
try {
  const supervisor = await Supervisor.start({
    children: [
      { id: 'database', start: () => connectToDatabase() },
    ],
  });
} catch (error) {
  console.error('Failed to start supervisor:', error);
  // Implement retry logic or graceful degradation
}
```

## Error Types

| Error | Cause |
|-------|-------|
| `MaxRestartsExceededError` | Too many restarts in time window |
| `DuplicateChildError` | Child with same ID already exists |
| `ChildNotFoundError` | Trying to terminate/restart non-existent child |

## Related

- [GenServer](./genserver.md) - The building block supervised by Supervisor
- [Lifecycle](./lifecycle.md) - Process lifecycle details
- [Error Handling](./error-handling.md) - Error recovery strategies
- [Building Supervision Trees](../guides/supervision-trees.md) - Design patterns
- [API Reference: Supervisor](../api/supervisor.md) - Complete API documentation
