# Restart Strategies

When a child process fails, the supervisor must decide **which processes to restart**. This decision is controlled by the supervisor's **restart strategy**. Choosing the right strategy depends on how your processes depend on each other.

## What You'll Learn

- The three restart strategies: `one_for_one`, `one_for_all`, `rest_for_one`
- When to use each strategy
- How shutdown and startup order work during restarts
- Practical examples of each strategy

## The Three Strategies at a Glance

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         SUPERVISOR RESTART STRATEGIES                       │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  one_for_one              one_for_all              rest_for_one            │
│  ─────────────            ─────────────            ─────────────           │
│                                                                            │
│  Before crash:            Before crash:            Before crash:           │
│  ┌───┐ ┌───┐ ┌───┐        ┌───┐ ┌───┐ ┌───┐        ┌───┐ ┌───┐ ┌───┐      │
│  │ A │ │ B │ │ C │        │ A │ │ B │ │ C │        │ A │ │ B │ │ C │      │
│  └───┘ └───┘ └───┘        └───┘ └───┘ └───┘        └───┘ └───┘ └───┘      │
│         ↓ crash                  ↓ crash                  ↓ crash         │
│        ┌───┐                    ┌───┐                    ┌───┐            │
│        │ B │                    │ B │                    │ B │            │
│        └───┘                    └───┘                    └───┘            │
│                                                                            │
│  After restart:           After restart:           After restart:          │
│  ┌───┐ ┌───┐ ┌───┐        ┌───┐ ┌───┐ ┌───┐        ┌───┐ ┌───┐ ┌───┐      │
│  │ A │ │ B'│ │ C │        │ A'│ │ B'│ │ C'│        │ A │ │ B'│ │ C'│      │
│  └───┘ └───┘ └───┘        └───┘ └───┘ └───┘        └───┘ └───┘ └───┘      │
│    ↑     ↑     ↑            ↑     ↑     ↑            ↑     ↑     ↑        │
│   same  new   same        all   new    all          same  new   new       │
│                                                           (and after B)   │
│                                                                            │
│  Use when:                Use when:                Use when:               │
│  Children are             Children share           Children have           │
│  independent              state or must            sequential              │
│                           stay in sync             dependencies            │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

## one_for_one (Default)

The simplest and most common strategy. When a child crashes, **only that child is restarted**. Other children continue running undisturbed.

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one', // This is the default
  children: [
    { id: 'users', start: () => GenServer.start(usersBehavior) },
    { id: 'orders', start: () => GenServer.start(ordersBehavior) },
    { id: 'notifications', start: () => GenServer.start(notificationsBehavior) },
  ],
});
```

### When to Use one_for_one

Use this strategy when children are **independent** of each other:

- **Microservices pattern**: Each service handles different concerns (users, orders, payments)
- **Worker pools**: Each worker processes tasks independently
- **Stateless services**: Services that don't share state with siblings

### Example: Independent API Handlers

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from '@hamicek/noex';

// Each handler is independent - they don't share state
interface HandlerState {
  requestCount: number;
}

type HandlerCall = { type: 'handle'; path: string };
type HandlerCast = never;

const createHandler = (name: string): GenServerBehavior<HandlerState, HandlerCall, HandlerCast, string> => ({
  init() {
    console.log(`[${name}] Started`);
    return { requestCount: 0 };
  },
  handleCall(msg, state) {
    const newState = { requestCount: state.requestCount + 1 };
    console.log(`[${name}] Handling ${msg.path} (request #${newState.requestCount})`);
    return [`${name} handled ${msg.path}`, newState];
  },
  handleCast: (_, state) => state,
  terminate(reason) {
    console.log(`[${name}] Terminated: ${typeof reason === 'string' ? reason : 'error'}`);
  },
});

async function main() {
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'users-handler', start: () => GenServer.start(createHandler('Users')) },
      { id: 'orders-handler', start: () => GenServer.start(createHandler('Orders')) },
      { id: 'payments-handler', start: () => GenServer.start(createHandler('Payments')) },
    ],
  });

  // If orders-handler crashes, only it gets restarted
  // users-handler and payments-handler continue running with their state intact

  await Supervisor.stop(supervisor);
}

main();
```

## one_for_all

When any child crashes, **all children are restarted**. The supervisor first stops all other children (in reverse start order), then restarts everyone (in original start order).

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_all',
  children: [
    { id: 'database', start: () => GenServer.start(dbBehavior) },
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },
    { id: 'api', start: () => GenServer.start(apiBehavior) },
  ],
});
```

### Restart Sequence for one_for_all

When `cache` crashes:
1. **Stop** `api` (last started, first stopped)
2. **Stop** `database` (skip `cache` - already dead)
3. **Start** `database` (first in order)
4. **Start** `cache` (second in order)
5. **Start** `api` (third in order)

### When to Use one_for_all

Use this strategy when children **share state** or **must stay synchronized**:

- **Distributed consensus**: All nodes must agree on state
- **Shared cache invalidation**: Cache and services must be in sync
- **Tightly coupled components**: When one fails, others' state becomes invalid

### Example: Synchronized Counter Cluster

```typescript
import { Supervisor, GenServer, Registry, type GenServerBehavior } from '@hamicek/noex';

// A coordinator that maintains the "true" count
interface CoordinatorState {
  count: number;
}

type CoordinatorCall = { type: 'get' } | { type: 'set'; value: number };
type CoordinatorCast = never;

const coordinatorBehavior: GenServerBehavior<CoordinatorState, CoordinatorCall, CoordinatorCast, number> = {
  init() {
    console.log('[Coordinator] Starting with count = 0');
    return { count: 0 };
  },
  handleCall(msg, state) {
    if (msg.type === 'get') {
      return [state.count, state];
    }
    if (msg.type === 'set') {
      return [msg.value, { count: msg.value }];
    }
    return [state.count, state];
  },
  handleCast: (_, state) => state,
  terminate() {
    console.log('[Coordinator] Terminated');
  },
};

// A replica that caches the coordinator's value
interface ReplicaState {
  name: string;
  cachedCount: number;
}

type ReplicaCall = { type: 'read' };
type ReplicaCast = { type: 'sync' };

const createReplicaBehavior = (name: string): GenServerBehavior<ReplicaState, ReplicaCall, ReplicaCast, number> => ({
  init() {
    // On start, sync with coordinator
    const coordinator = Registry.lookup('coordinator');
    let initialCount = 0;
    if (coordinator) {
      // In real code, this would be async
      console.log(`[${name}] Starting, syncing with coordinator...`);
    }
    return { name, cachedCount: initialCount };
  },
  handleCall(msg, state) {
    if (msg.type === 'read') {
      return [state.cachedCount, state];
    }
    return [state.cachedCount, state];
  },
  handleCast(msg, state) {
    if (msg.type === 'sync') {
      const coordinator = Registry.lookup('coordinator');
      if (coordinator) {
        // Sync would update cachedCount from coordinator
        console.log(`[${state.name}] Syncing with coordinator`);
      }
    }
    return state;
  },
  terminate() {
    console.log(`[${name}] Terminated`);
  },
});

async function main() {
  // All replicas depend on coordinator's state
  // If coordinator crashes, replicas have stale data - restart all
  const supervisor = await Supervisor.start({
    strategy: 'one_for_all',
    children: [
      {
        id: 'coordinator',
        start: () => GenServer.start(coordinatorBehavior, { name: 'coordinator' }),
      },
      {
        id: 'replica-1',
        start: () => GenServer.start(createReplicaBehavior('Replica-1')),
      },
      {
        id: 'replica-2',
        start: () => GenServer.start(createReplicaBehavior('Replica-2')),
      },
    ],
  });

  console.log('\nAll components started and synchronized');

  // If any component fails, all restart to ensure consistency
  // This guarantees replicas always have fresh data from coordinator

  await Supervisor.stop(supervisor);
}

main();
```

**Output:**
```
[Coordinator] Starting with count = 0
[Replica-1] Starting, syncing with coordinator...
[Replica-2] Starting, syncing with coordinator...

All components started and synchronized
[Replica-2] Terminated
[Replica-1] Terminated
[Coordinator] Terminated
```

## rest_for_one

A middle ground between the two. When a child crashes, **the crashed child and all children started after it are restarted**. Children started before the crashed one continue running.

```typescript
const supervisor = await Supervisor.start({
  strategy: 'rest_for_one',
  children: [
    { id: 'database', start: () => GenServer.start(dbBehavior) },
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },    // depends on database
    { id: 'api', start: () => GenServer.start(apiBehavior) },        // depends on cache
  ],
});
```

### Restart Sequence for rest_for_one

When `cache` crashes:
1. **Stop** `api` (started after cache)
2. *(cache is already dead)*
3. **Start** `cache`
4. **Start** `api`

`database` continues running undisturbed.

### When to Use rest_for_one

Use this strategy when children have **sequential dependencies**:

- **Pipeline processing**: Stage 2 depends on Stage 1, Stage 3 depends on Stage 2
- **Layered architecture**: Higher layers depend on lower layers
- **Initialization chains**: Later services need earlier ones to be ready

### Example: Data Processing Pipeline

```typescript
import { Supervisor, GenServer, Registry, type GenServerBehavior } from '@hamicek/noex';

// Stage 1: Data Fetcher (no dependencies)
interface FetcherState {
  fetchCount: number;
}

type FetcherCall = { type: 'fetch' };

const fetcherBehavior: GenServerBehavior<FetcherState, FetcherCall, never, string> = {
  init() {
    console.log('[Fetcher] Started');
    return { fetchCount: 0 };
  },
  handleCall(msg, state) {
    if (msg.type === 'fetch') {
      const newCount = state.fetchCount + 1;
      console.log(`[Fetcher] Fetching data (request #${newCount})`);
      return [`raw_data_${newCount}`, { fetchCount: newCount }];
    }
    return ['', state];
  },
  handleCast: (_, state) => state,
  terminate() {
    console.log('[Fetcher] Terminated');
  },
};

// Stage 2: Transformer (depends on Fetcher)
interface TransformerState {
  transformCount: number;
}

type TransformerCall = { type: 'transform'; data: string };

const transformerBehavior: GenServerBehavior<TransformerState, TransformerCall, never, string> = {
  init() {
    console.log('[Transformer] Started');
    return { transformCount: 0 };
  },
  handleCall(msg, state) {
    if (msg.type === 'transform') {
      const newCount = state.transformCount + 1;
      console.log(`[Transformer] Transforming: ${msg.data}`);
      return [`transformed_${msg.data}`, { transformCount: newCount }];
    }
    return ['', state];
  },
  handleCast: (_, state) => state,
  terminate() {
    console.log('[Transformer] Terminated');
  },
};

// Stage 3: Loader (depends on Transformer)
interface LoaderState {
  loadCount: number;
}

type LoaderCall = { type: 'load'; data: string };

const loaderBehavior: GenServerBehavior<LoaderState, LoaderCall, never, boolean> = {
  init() {
    console.log('[Loader] Started');
    return { loadCount: 0 };
  },
  handleCall(msg, state) {
    if (msg.type === 'load') {
      const newCount = state.loadCount + 1;
      console.log(`[Loader] Loading: ${msg.data}`);
      return [true, { loadCount: newCount }];
    }
    return [false, state];
  },
  handleCast: (_, state) => state,
  terminate() {
    console.log('[Loader] Terminated');
  },
};

async function main() {
  // ETL pipeline: Fetcher → Transformer → Loader
  // If Transformer crashes:
  //   - Fetcher continues (still valid, no downstream state)
  //   - Transformer restarts
  //   - Loader restarts (had state derived from Transformer)
  const supervisor = await Supervisor.start({
    strategy: 'rest_for_one',
    children: [
      {
        id: 'fetcher',
        start: () => GenServer.start(fetcherBehavior, { name: 'fetcher' }),
      },
      {
        id: 'transformer',
        start: () => GenServer.start(transformerBehavior, { name: 'transformer' }),
      },
      {
        id: 'loader',
        start: () => GenServer.start(loaderBehavior, { name: 'loader' }),
      },
    ],
  });

  // Run the pipeline
  const fetcher = Registry.lookup('fetcher');
  const transformer = Registry.lookup('transformer');
  const loader = Registry.lookup('loader');

  if (fetcher && transformer && loader) {
    const raw = await GenServer.call(fetcher, { type: 'fetch' });
    const transformed = await GenServer.call(transformer, { type: 'transform', data: raw });
    await GenServer.call(loader, { type: 'load', data: transformed });
  }

  console.log('\nPipeline completed successfully');

  await Supervisor.stop(supervisor);
}

main();
```

**Output:**
```
[Fetcher] Started
[Transformer] Started
[Loader] Started
[Fetcher] Fetching data (request #1)
[Transformer] Transforming: raw_data_1
[Loader] Loading: transformed_raw_data_1

Pipeline completed successfully
[Loader] Terminated
[Transformer] Terminated
[Fetcher] Terminated
```

## Strategy Comparison

| Aspect | one_for_one | one_for_all | rest_for_one |
|--------|-------------|-------------|--------------|
| **Restarts** | Only crashed child | All children | Crashed + later children |
| **Isolation** | Maximum | Minimum | Partial |
| **Performance** | Best (minimal restart) | Worst (full restart) | Medium |
| **Use case** | Independent services | Shared state | Sequential dependencies |
| **Complexity** | Simplest | Simple | Requires careful ordering |

## Practical Decision Tree

```
Does child A's crash invalidate child B's state?
│
├─ No for ALL children → one_for_one
│
├─ Yes for ALL children → one_for_all
│
└─ Yes only for children started AFTER A → rest_for_one
```

## Real-World Architecture Examples

### E-commerce System (one_for_one)

```typescript
// Each domain is independent
await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'users', start: () => GenServer.start(usersBehavior) },
    { id: 'products', start: () => GenServer.start(productsBehavior) },
    { id: 'orders', start: () => GenServer.start(ordersBehavior) },
    { id: 'payments', start: () => GenServer.start(paymentsBehavior) },
  ],
});
```

### Distributed Cache Cluster (one_for_all)

```typescript
// All nodes must be in sync
await Supervisor.start({
  strategy: 'one_for_all',
  children: [
    { id: 'cache-primary', start: () => GenServer.start(cacheBehavior) },
    { id: 'cache-replica-1', start: () => GenServer.start(replicaBehavior) },
    { id: 'cache-replica-2', start: () => GenServer.start(replicaBehavior) },
  ],
});
```

### Web Application Stack (rest_for_one)

```typescript
// Each layer depends on previous ones
await Supervisor.start({
  strategy: 'rest_for_one',
  children: [
    { id: 'database', start: () => GenServer.start(dbBehavior) },      // Foundation
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },      // Needs DB
    { id: 'session', start: () => GenServer.start(sessionBehavior) },  // Needs cache
    { id: 'api', start: () => GenServer.start(apiBehavior) },          // Needs all above
  ],
});
```

## Exercise

Create a supervisor for a logging system with three components:

1. **LogWriter** - Writes logs to disk (independent, no dependencies)
2. **LogAggregator** - Aggregates logs from multiple sources (depends on LogWriter being available)
3. **AlertManager** - Monitors aggregated logs for errors (depends on LogAggregator)

Requirements:
- Choose the appropriate restart strategy
- If LogAggregator crashes, AlertManager should also restart (it has stale aggregation state)
- If LogWriter crashes, only LogWriter should restart (other components can buffer temporarily)

**Hint:** Think about which strategy handles this partial dependency correctly.

<details>
<summary>Solution</summary>

The trick here is that we have **two different dependency patterns**:
- LogWriter is independent
- LogAggregator → AlertManager have sequential dependency

The solution is to use **nested supervisors** with different strategies:

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from '@hamicek/noex';

// LogWriter - independent, writes to disk
const logWriterBehavior: GenServerBehavior<null, { type: 'write'; msg: string }, never, boolean> = {
  init() {
    console.log('[LogWriter] Started');
    return null;
  },
  handleCall(msg, state) {
    console.log(`[LogWriter] Writing: ${msg.msg}`);
    return [true, state];
  },
  handleCast: (_, state) => state,
  terminate() {
    console.log('[LogWriter] Terminated');
  },
};

// LogAggregator - collects and aggregates logs
interface AggregatorState {
  buffer: string[];
}

const logAggregatorBehavior: GenServerBehavior<AggregatorState, { type: 'getStats' }, { type: 'log'; msg: string }, number> = {
  init() {
    console.log('[LogAggregator] Started');
    return { buffer: [] };
  },
  handleCall(msg, state) {
    if (msg.type === 'getStats') {
      return [state.buffer.length, state];
    }
    return [0, state];
  },
  handleCast(msg, state) {
    if (msg.type === 'log') {
      return { buffer: [...state.buffer, msg.msg] };
    }
    return state;
  },
  terminate() {
    console.log('[LogAggregator] Terminated');
  },
};

// AlertManager - monitors for errors
interface AlertState {
  alertCount: number;
}

const alertManagerBehavior: GenServerBehavior<AlertState, { type: 'getAlertCount' }, { type: 'check' }, number> = {
  init() {
    console.log('[AlertManager] Started');
    return { alertCount: 0 };
  },
  handleCall(msg, state) {
    if (msg.type === 'getAlertCount') {
      return [state.alertCount, state];
    }
    return [0, state];
  },
  handleCast(msg, state) {
    if (msg.type === 'check') {
      // Check aggregator for errors...
      return state;
    }
    return state;
  },
  terminate() {
    console.log('[AlertManager] Terminated');
  },
};

async function main() {
  // Main supervisor with one_for_one
  // - LogWriter is independent
  // - Aggregation subsystem is one child (another supervisor)
  const mainSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      {
        id: 'log-writer',
        start: () => GenServer.start(logWriterBehavior),
      },
      {
        // Aggregation subsystem as nested supervisor with rest_for_one
        id: 'aggregation-subsystem',
        start: async () => {
          const sub = await Supervisor.start({
            strategy: 'rest_for_one',
            children: [
              {
                id: 'log-aggregator',
                start: () => GenServer.start(logAggregatorBehavior),
              },
              {
                id: 'alert-manager',
                start: () => GenServer.start(alertManagerBehavior),
              },
            ],
          });
          // Return a GenServer ref that wraps the supervisor
          // (In practice, you might use a different pattern)
          return GenServer.start({
            init: () => sub,
            handleCall: (_, state) => [state, state],
            handleCast: (_, state) => state,
          });
        },
      },
    ],
  });

  console.log('\nLogging system started');
  console.log('- If LogWriter crashes: only LogWriter restarts');
  console.log('- If LogAggregator crashes: LogAggregator + AlertManager restart');
  console.log('- If AlertManager crashes: only AlertManager restarts');

  await Supervisor.stop(mainSupervisor);
}

main();
```

**Alternative simpler solution** - if you can accept that LogWriter crash restarts the dependent services too:

```typescript
// Simple solution using rest_for_one
// Trade-off: LogWriter crash restarts everything after it
const supervisor = await Supervisor.start({
  strategy: 'rest_for_one',
  children: [
    { id: 'log-writer', start: () => GenServer.start(logWriterBehavior) },
    { id: 'log-aggregator', start: () => GenServer.start(logAggregatorBehavior) },
    { id: 'alert-manager', start: () => GenServer.start(alertManagerBehavior) },
  ],
});
```

The nested supervisor approach gives you fine-grained control over restart behavior. This is a common pattern in production systems.

</details>

## Summary

- **one_for_one** (default): Restart only the crashed child
  - Use for independent services
  - Best performance, maximum isolation

- **one_for_all**: Restart all children when one crashes
  - Use when children share state
  - Stop in reverse order, start in original order

- **rest_for_one**: Restart crashed child + all children started after it
  - Use for sequential dependencies
  - Earlier children continue running

- **Child order matters** for `rest_for_one` - arrange children from least dependent to most dependent
- **Nested supervisors** let you combine strategies for complex dependency patterns

In the next chapter, you'll learn how to prevent infinite restart loops using **restart intensity** limits.

---

Next: [Restart Intensity](./04-restart-intensity.md)
