# noex

Elixir-style GenServer and Supervisor patterns for TypeScript.

**noex** provides a robust abstraction for building stateful, fault-tolerant services in Node.js. Inspired by Elixir/OTP, it brings the GenServer and Supervisor patterns to TypeScript with full type safety.

## Features

- **GenServer**: Stateful services with serialized message processing
- **Supervisor**: Automatic restart strategies for fault tolerance
- **Registry**: Named process lookup for loose coupling
- **Observer**: Real-time introspection into process state
- **Dashboard**: TUI-based monitoring interface
- **Type-safe**: Full TypeScript support with strict typing
- **Zero dependencies**: Core library is lightweight and focused

## Installation

```bash
npm install noex
```

Requires Node.js 20.0.0 or later.

## Quick Start

```typescript
import { GenServer, Supervisor, Registry } from 'noex';

// Define a counter service
const counterBehavior = {
  init: () => 0,
  handleCall: (msg: 'get', state: number) => [state, state] as const,
  handleCast: (msg: 'inc' | 'dec', state: number) =>
    msg === 'inc' ? state + 1 : state - 1,
};

// Start under supervision
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    {
      id: 'counter',
      start: async () => {
        const ref = await GenServer.start(counterBehavior);
        Registry.register('counter', ref);
        return ref;
      },
    },
  ],
});

// Use the service
const counter = Registry.lookup<number, 'get', 'inc' | 'dec', number>('counter');
GenServer.cast(counter, 'inc');
GenServer.cast(counter, 'inc');
const value = await GenServer.call(counter, 'get'); // 2

// Graceful shutdown
await Supervisor.stop(supervisor);
```

## Core Concepts

### GenServer

A GenServer is a stateful process that handles messages sequentially. It provides:

- **Serialized message processing**: Messages are processed one at a time
- **Synchronous calls**: Request/response pattern with timeouts
- **Asynchronous casts**: Fire-and-forget messages
- **Lifecycle hooks**: Initialization and termination callbacks

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

interface CacheState {
  data: Map<string, unknown>;
}

type CallMsg = { type: 'get'; key: string } | { type: 'keys' };
type CastMsg = { type: 'set'; key: string; value: unknown } | { type: 'delete'; key: string };
type CallReply = unknown | string[];

const cacheBehavior: GenServerBehavior<CacheState, CallMsg, CastMsg, CallReply> = {
  init: () => ({ data: new Map() }),

  handleCall: (msg, state) => {
    if (msg.type === 'get') {
      return [state.data.get(msg.key), state];
    }
    return [Array.from(state.data.keys()), state];
  },

  handleCast: (msg, state) => {
    if (msg.type === 'set') {
      state.data.set(msg.key, msg.value);
    } else {
      state.data.delete(msg.key);
    }
    return state;
  },

  terminate: (reason, state) => {
    console.log(`Cache shutting down: ${reason}`);
  },
};

const cache = await GenServer.start(cacheBehavior);

GenServer.cast(cache, { type: 'set', key: 'user:1', value: { name: 'Alice' } });
const user = await GenServer.call(cache, { type: 'get', key: 'user:1' });

await GenServer.stop(cache);
```

### Supervisor

A Supervisor manages child processes and restarts them on failure. It supports three restart strategies:

- **one_for_one**: Only restart the failed child
- **one_for_all**: Restart all children when one fails
- **rest_for_one**: Restart the failed child and all children started after it

```typescript
import { Supervisor, GenServer } from 'noex';

const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  restartIntensity: { maxRestarts: 3, withinMs: 5000 },
  children: [
    {
      id: 'worker-1',
      restart: 'permanent', // Always restart
      start: () => GenServer.start(workerBehavior),
    },
    {
      id: 'worker-2',
      restart: 'transient', // Restart only on abnormal exit
      start: () => GenServer.start(workerBehavior),
    },
    {
      id: 'worker-3',
      restart: 'temporary', // Never restart
      start: () => GenServer.start(workerBehavior),
    },
  ],
});

// Dynamic child management
await Supervisor.startChild(supervisor, {
  id: 'worker-4',
  start: () => GenServer.start(workerBehavior),
});

await Supervisor.terminateChild(supervisor, 'worker-4');

// Introspection
const children = Supervisor.getChildren(supervisor);
console.log(`Managing ${children.length} children`);

await Supervisor.stop(supervisor);
```

### Registry

The Registry provides named process lookup, enabling loose coupling between components:

```typescript
import { Registry, GenServer } from 'noex';

const ref = await GenServer.start(behavior);
Registry.register('my-service', ref);

// Lookup elsewhere in the application
const service = Registry.lookup('my-service');
await GenServer.call(service, 'ping');

// Non-throwing variant
const maybeService = Registry.whereis('optional-service');
if (maybeService) {
  GenServer.cast(maybeService, 'notify');
}

// Automatic cleanup on termination
await GenServer.stop(ref);
Registry.isRegistered('my-service'); // false
```

## Built-in Services

noex includes production-ready services built on GenServer:

### EventBus

Pub/sub messaging with wildcard pattern matching:

```typescript
import { EventBus } from 'noex';

const bus = await EventBus.start();

// Subscribe with wildcards
await EventBus.subscribe(bus, 'user.*', (message, topic) => {
  console.log(`${topic}: ${JSON.stringify(message)}`);
});

// Publish events
EventBus.publish(bus, 'user.created', { id: '123', name: 'Alice' });
EventBus.publish(bus, 'user.updated', { id: '123', email: 'alice@example.com' });

await EventBus.stop(bus);
```

### Cache

In-memory cache with TTL and LRU eviction:

```typescript
import { Cache } from 'noex';

const cache = await Cache.start({
  maxSize: 1000,
  defaultTtlMs: 60000, // 1 minute
});

await Cache.set(cache, 'session:abc', { userId: '123' });
await Cache.set(cache, 'temp', { data: 'expires soon' }, { ttlMs: 5000 });

const session = await Cache.get(cache, 'session:abc');

// Get or compute
const user = await Cache.getOrSet(cache, 'user:123', async () => {
  return await fetchUserFromDatabase('123');
});

const stats = await Cache.stats(cache);
console.log(`Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);

await Cache.stop(cache);
```

### RateLimiter

Sliding window rate limiting:

```typescript
import { RateLimiter, RateLimitExceededError } from 'noex';

const limiter = await RateLimiter.start({
  maxRequests: 100,
  windowMs: 60000, // 100 requests per minute
});

// Check without consuming
const status = await RateLimiter.check(limiter, 'user:123');
console.log(`Remaining: ${status.remaining}/${status.limit}`);

// Consume quota
try {
  await RateLimiter.consume(limiter, 'user:123');
  // Process request
} catch (e) {
  if (e instanceof RateLimitExceededError) {
    console.log(`Rate limited. Retry after ${e.retryAfterMs}ms`);
  }
}

await RateLimiter.stop(limiter);
```

## Observer

The Observer module provides real-time introspection into your supervision tree:

```typescript
import { Observer } from 'noex';

// Get a snapshot of all processes
const snapshot = Observer.getSnapshot();
console.log(`Total processes: ${snapshot.processCount}`);
console.log(`Total messages processed: ${snapshot.totalMessages}`);

// Iterate GenServer statistics
for (const server of snapshot.servers) {
  console.log(`${server.id}: ${server.messageCount} messages, queue: ${server.queueSize}`);
}

// Get hierarchical process tree
const tree = Observer.getProcessTree();
// Returns nested structure of supervisors and their children

// Subscribe to real-time events
const unsubscribe = Observer.subscribe((event) => {
  console.log(`Event: ${event.type}`, event);
});

// Start polling for periodic updates
const stopPolling = Observer.startPolling(1000, (event) => {
  if (event.type === 'stats_update') {
    console.log('Stats updated');
  }
});
```

## Dashboard (TUI)

noex includes an optional TUI dashboard for real-time monitoring. It requires `blessed-contrib`:

```bash
npm install blessed-contrib
```

```typescript
import { Dashboard } from 'noex/dashboard';

const dashboard = new Dashboard({
  refreshInterval: 500,  // Update every 500ms
  theme: 'dark',         // 'dark' or 'light'
  layout: 'full',        // 'full', 'compact', or 'minimal'
});

dashboard.start();

// The dashboard displays:
// - Process tree with status indicators
// - GenServer statistics table
// - Memory usage gauge
// - Real-time event log

// Keyboard controls:
// q, Escape  - Quit
// r          - Refresh
// 1/2/3      - Switch layouts
// Tab        - Navigate widgets
// Enter      - Process details
// ?          - Help
```

### Dashboard Layouts

| Layout | Widgets |
|--------|---------|
| `full` | Process tree, stats table, memory gauge, event log |
| `compact` | Process tree, stats table |
| `minimal` | Stats table only |

### Dashboard API

| Method | Description |
|--------|-------------|
| `start()` | Start the dashboard |
| `stop()` | Stop and cleanup |
| `refresh()` | Force immediate refresh |
| `switchLayout(layout)` | Change layout at runtime |
| `selectProcess(id)` | Show process details |
| `isRunning()` | Check if dashboard is active |
| `getLayout()` | Get current layout |

## Lifecycle Events

Monitor your services with lifecycle events:

```typescript
import { GenServer, Supervisor } from 'noex';

GenServer.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Server started: ${event.ref.id}`);
      break;
    case 'terminated':
      console.log(`Server terminated: ${event.ref.id} (${event.reason})`);
      break;
    case 'crashed':
      console.error(`Server crashed: ${event.ref.id}`, event.error);
      break;
  }
});

Supervisor.onLifecycleEvent((event) => {
  if (event.type === 'restarted') {
    console.log(`Child restarted (attempt ${event.attempt})`);
  }
});
```

## Error Handling

noex provides specific error types for different failure scenarios:

```typescript
import {
  CallTimeoutError,
  ServerNotRunningError,
  InitializationError,
  MaxRestartsExceededError,
  DuplicateChildError,
  ChildNotFoundError,
  AlreadyRegisteredError,
  NotRegisteredError,
} from 'noex';

try {
  await GenServer.call(ref, 'message', { timeout: 1000 });
} catch (e) {
  if (e instanceof CallTimeoutError) {
    console.log(`Call timed out after ${e.timeoutMs}ms`);
  } else if (e instanceof ServerNotRunningError) {
    console.log(`Server ${e.serverId} is not running`);
  }
}
```

## API Reference

### GenServer

| Method | Description |
|--------|-------------|
| `start(behavior, options?)` | Start a new GenServer |
| `call(ref, message, options?)` | Synchronous request/response |
| `cast(ref, message)` | Asynchronous fire-and-forget |
| `stop(ref, reason?)` | Graceful shutdown |
| `isRunning(ref)` | Check if server is running |
| `onLifecycleEvent(handler)` | Register lifecycle handler |

### Supervisor

| Method | Description |
|--------|-------------|
| `start(options?)` | Start a new Supervisor |
| `stop(ref, reason?)` | Graceful shutdown |
| `startChild(ref, spec)` | Dynamically add a child |
| `terminateChild(ref, id)` | Stop a specific child |
| `restartChild(ref, id)` | Manually restart a child |
| `getChildren(ref)` | Get all children info |
| `getChild(ref, id)` | Get specific child info |
| `countChildren(ref)` | Get child count |
| `isRunning(ref)` | Check if supervisor is running |
| `onLifecycleEvent(handler)` | Register lifecycle handler |

### Registry

| Method | Description |
|--------|-------------|
| `register(name, ref)` | Register a process by name |
| `lookup(name)` | Look up by name (throws if not found) |
| `whereis(name)` | Look up by name (returns undefined) |
| `unregister(name)` | Remove registration |
| `isRegistered(name)` | Check if name is registered |
| `getNames()` | Get all registered names |
| `count()` | Get registration count |

## Support

If you find noex useful, consider supporting its development:

[![Sponsor](https://img.shields.io/github/sponsors/hamicek?label=Sponsor&logo=github)](https://github.com/sponsors/hamicek)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5f5f?logo=ko-fi)](https://ko-fi.com/noex)

## License

MIT
