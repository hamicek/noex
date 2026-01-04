# Designing Supervision Trees

This guide covers how to design and implement effective supervision trees using noex. Supervision trees are hierarchical structures of supervisors that provide fault isolation and recovery.

## Overview

A supervision tree is a hierarchy where:
- **Root supervisor** manages top-level subsystems
- **Branch supervisors** manage related groups of processes
- **Leaf processes** (GenServers) perform actual work

```
                    [Root Supervisor]
                    /       |        \
           [Workers]    [Cache]     [API]
            /    \        |         /   \
        [W1]  [W2]   [Primary]  [HTTP] [WS]
```

## Why Use Supervision Trees?

### 1. Fault Isolation

Failures in one branch don't affect other branches:

```typescript
// If a worker crashes, cache and API subsystems are unaffected
const root = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'workers', start: () => startWorkerSupervisor() },
    { id: 'cache', start: () => startCacheSupervisor() },
    { id: 'api', start: () => startApiSupervisor() },
  ],
});
```

### 2. Granular Restart Policies

Different subsystems can have different restart strategies:

```typescript
// Workers: independent, use one_for_one
const workerSupervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: workers,
});

// Cache primary + replicas: must stay in sync, use one_for_all
const cacheSupervisor = await Supervisor.start({
  strategy: 'one_for_all',
  children: cacheNodes,
});
```

### 3. Clear System Boundaries

Supervision trees make system architecture visible:

```typescript
// Architecture is explicit in code
const system = {
  database: { strategy: 'rest_for_one', children: ['pool', 'cache', 'query'] },
  workers: { strategy: 'one_for_one', children: ['email', 'pdf', 'image'] },
  api: { strategy: 'one_for_all', children: ['auth', 'routes', 'ws'] },
};
```

---

## Designing Your Tree

### Step 1: Identify Subsystems

Group processes by:
- **Shared functionality** (all workers, all caches)
- **Shared dependencies** (processes using same database connection)
- **Failure impact** (processes that should restart together)

### Step 2: Choose Strategies Per Branch

| Subsystem Type | Strategy | Reason |
|---------------|----------|--------|
| Independent workers | `one_for_one` | Failures are isolated |
| Replicated services | `one_for_all` | Keep replicas in sync |
| Pipeline stages | `rest_for_one` | Later stages depend on earlier |
| Stateless services | `one_for_one` | No shared state |
| Coordinated services | `one_for_all` | Must restart together |

### Step 3: Define Child Order

Order matters for:
- **Startup**: Dependencies start first
- **Shutdown**: Dependents stop first (reverse order)

```typescript
// Database must start before services that use it
const appSupervisor = await Supervisor.start({
  strategy: 'rest_for_one',
  children: [
    { id: 'config', start: () => startConfigServer() },    // 1st: config
    { id: 'database', start: () => startDatabasePool() },  // 2nd: database
    { id: 'cache', start: () => startCacheServer() },      // 3rd: uses database
    { id: 'api', start: () => startApiServer() },          // 4th: uses cache + db
  ],
});
```

---

## Implementation Patterns

### Pattern 1: Flat Hierarchy (Simple Applications)

For simple apps, a single supervisor may suffice:

```typescript
const app = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'counter', start: () => GenServer.start(counterBehavior) },
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },
    { id: 'metrics', start: () => GenServer.start(metricsBehavior) },
  ],
});
```

### Pattern 2: Two-Level Hierarchy (Medium Applications)

Group related services under branch supervisors:

```typescript
// Branch supervisor for workers
async function startWorkerBranch(): Promise<SupervisorRef> {
  return Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 10, withinMs: 60000 },
    children: [
      { id: 'worker-1', start: () => GenServer.start(workerBehavior) },
      { id: 'worker-2', start: () => GenServer.start(workerBehavior) },
      { id: 'worker-3', start: () => GenServer.start(workerBehavior) },
    ],
  });
}

// Branch supervisor for cache
async function startCacheBranch(): Promise<SupervisorRef> {
  return Supervisor.start({
    strategy: 'one_for_all',
    children: [
      { id: 'primary', start: () => GenServer.start(cacheBehavior) },
      { id: 'replica-1', start: () => GenServer.start(cacheBehavior) },
      { id: 'replica-2', start: () => GenServer.start(cacheBehavior) },
    ],
  });
}

// Root supervisor
const root = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'workers', start: startWorkerBranch },
    { id: 'cache', start: startCacheBranch },
  ],
});
```

### Pattern 3: Deep Hierarchy (Complex Applications)

For large systems, create multiple levels:

```typescript
// Level 3: Individual services
async function startEmailWorkers(): Promise<SupervisorRef> {
  return Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'sender', start: () => GenServer.start(emailSenderBehavior) },
      { id: 'queue', start: () => GenServer.start(emailQueueBehavior) },
    ],
  });
}

// Level 2: Service groups
async function startNotificationBranch(): Promise<SupervisorRef> {
  return Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'email', start: startEmailWorkers },
      { id: 'sms', start: startSmsWorkers },
      { id: 'push', start: startPushWorkers },
    ],
  });
}

// Level 1: Major subsystems
async function startBackgroundJobs(): Promise<SupervisorRef> {
  return Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'notifications', start: startNotificationBranch },
      { id: 'reports', start: startReportBranch },
      { id: 'cleanup', start: startCleanupBranch },
    ],
  });
}

// Root: Application entry point
const app = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'core', start: startCoreBranch },
    { id: 'api', start: startApiBranch },
    { id: 'background', start: startBackgroundJobs },
  ],
});
```

---

## Real-World Example: E-Commerce Backend

```typescript
import { Supervisor, GenServer } from 'noex';

// Database layer (rest_for_one: later processes depend on pool)
async function startDatabaseBranch() {
  return Supervisor.start({
    strategy: 'rest_for_one',
    children: [
      { id: 'pool', start: () => GenServer.start(dbPoolBehavior) },
      { id: 'cache', start: () => GenServer.start(queryCacheBehavior) },
      { id: 'migrations', start: () => GenServer.start(migrationBehavior), restart: 'temporary' },
    ],
  });
}

// Order processing (one_for_all: payment and inventory must be consistent)
async function startOrderBranch() {
  return Supervisor.start({
    strategy: 'one_for_all',
    children: [
      { id: 'inventory', start: () => GenServer.start(inventoryBehavior) },
      { id: 'payment', start: () => GenServer.start(paymentBehavior) },
      { id: 'orders', start: () => GenServer.start(orderBehavior) },
    ],
  });
}

// Workers (one_for_one: independent tasks)
async function startWorkerBranch() {
  return Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 20, withinMs: 60000 },
    children: [
      { id: 'email', start: () => GenServer.start(emailBehavior) },
      { id: 'pdf', start: () => GenServer.start(pdfBehavior) },
      { id: 'shipping', start: () => GenServer.start(shippingBehavior) },
    ],
  });
}

// API layer
async function startApiBranch() {
  return Supervisor.start({
    strategy: 'rest_for_one',
    children: [
      { id: 'auth', start: () => GenServer.start(authBehavior) },
      { id: 'rate-limiter', start: () => GenServer.start(rateLimiterBehavior) },
      { id: 'http', start: () => GenServer.start(httpServerBehavior) },
      { id: 'websocket', start: () => GenServer.start(wsServerBehavior) },
    ],
  });
}

// Root application supervisor
export async function startApplication() {
  return Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'database', start: startDatabaseBranch },
      { id: 'orders', start: startOrderBranch },
      { id: 'workers', start: startWorkerBranch },
      { id: 'api', start: startApiBranch },
    ],
  });
}
```

---

## Dynamic Supervision Trees

### Adding Branches at Runtime

```typescript
const root = await Supervisor.start({ strategy: 'one_for_one' });

// Add subsystems dynamically
await Supervisor.startChild(root, {
  id: 'feature-x',
  start: () => startFeatureXSupervisor(),
});

// Remove subsystems
await Supervisor.terminateChild(root, 'feature-x');
```

### Dynamic Worker Pools

```typescript
async function startWorkerPool(size: number) {
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
  });

  // Add workers dynamically
  for (let i = 0; i < size; i++) {
    await Supervisor.startChild(supervisor, {
      id: `worker-${i}`,
      start: () => GenServer.start(workerBehavior),
    });
  }

  return supervisor;
}

// Scale up/down at runtime
async function scaleWorkers(supervisor: SupervisorRef, newSize: number) {
  const current = Supervisor.countChildren(supervisor);

  if (newSize > current) {
    // Scale up
    for (let i = current; i < newSize; i++) {
      await Supervisor.startChild(supervisor, {
        id: `worker-${i}`,
        start: () => GenServer.start(workerBehavior),
      });
    }
  } else if (newSize < current) {
    // Scale down
    for (let i = current - 1; i >= newSize; i--) {
      await Supervisor.terminateChild(supervisor, `worker-${i}`);
    }
  }
}
```

---

## Monitoring Supervision Trees

### Using Observer

```typescript
import { Observer } from 'noex';

// Get system-wide overview
const snapshot = Observer.getSystemSnapshot();
console.log(`Total processes: ${snapshot.processCount}`);
console.log(`Total supervisors: ${snapshot.supervisorCount}`);

// Get supervisor details
const supervisorStats = Observer.getSupervisorStats(rootRef);
console.log(`Children: ${supervisorStats.childCount}`);
console.log(`Total restarts: ${supervisorStats.totalRestarts}`);
```

### Lifecycle Events

```typescript
// Monitor all supervisor activity
Supervisor.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Supervisor started: ${event.ref.id}`);
      break;
    case 'restarted':
      console.log(`Child restarted, attempt: ${event.attempt}`);
      break;
    case 'terminated':
      console.log(`Terminated: ${event.ref.id}`);
      break;
  }
});
```

---

## Best Practices

### 1. Keep Trees Shallow

Prefer wider, shallower trees over deep hierarchies:

```typescript
// Good: 2 levels
Root -> [DB, Cache, Workers, API]

// Avoid: 5 levels deep
Root -> System -> Services -> Workers -> Handlers -> Tasks
```

### 2. Group by Failure Domain

Put processes that should fail together under `one_for_all`:

```typescript
// Primary + replicas should restart together
{ strategy: 'one_for_all', children: [primary, replica1, replica2] }
```

### 3. Use Meaningful IDs

```typescript
// Good
{ id: 'order-processor' }
{ id: 'email-worker-pool' }

// Avoid
{ id: 'sup1' }
{ id: 'worker' }
```

### 4. Set Appropriate Restart Intensity Per Branch

```typescript
// Critical services: strict limits
restartIntensity: { maxRestarts: 3, withinMs: 60000 }

// Workers: more tolerance
restartIntensity: { maxRestarts: 20, withinMs: 60000 }
```

### 5. Document Your Tree

```typescript
/**
 * Application Supervision Tree:
 *
 * [root] one_for_one
 * ├── [database] rest_for_one
 * │   ├── pool
 * │   └── cache
 * ├── [workers] one_for_one
 * │   ├── email
 * │   └── pdf
 * └── [api] rest_for_one
 *     ├── auth
 *     └── http
 */
```

---

## Common Mistakes

### 1. Single Supervisor for Everything

```typescript
// Bad: All processes under one supervisor
const app = await Supervisor.start({
  strategy: 'one_for_one',
  children: [db, cache, worker1, worker2, api, ws, email, pdf, ...50more],
});

// Better: Group into subsystems
const app = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'database', start: startDbBranch },
    { id: 'workers', start: startWorkerBranch },
    { id: 'api', start: startApiBranch },
  ],
});
```

### 2. Wrong Strategy Choice

```typescript
// Bad: Using one_for_all for independent workers
const workers = await Supervisor.start({
  strategy: 'one_for_all',  // All workers restart on any failure!
  children: independentWorkers,
});

// Better: Use one_for_one
const workers = await Supervisor.start({
  strategy: 'one_for_one',  // Only failed worker restarts
  children: independentWorkers,
});
```

### 3. Not Considering Startup Order

```typescript
// Bad: API starts before database
children: [
  { id: 'api', start: startApi },      // Fails: no database yet!
  { id: 'database', start: startDb },
]

// Better: Database first
children: [
  { id: 'database', start: startDb },  // Starts first
  { id: 'api', start: startApi },      // Database ready
]
```

---

## Related

- [Supervisor Concepts](../concepts/supervisor.md) - Understanding supervisors
- [Building Services Guide](./building-services.md) - Creating GenServers
- [Production Guide](./production.md) - Production deployment
- [Supervisor API Reference](../api/supervisor.md) - Complete API docs
