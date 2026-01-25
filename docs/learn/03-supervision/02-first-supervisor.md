# First Supervisor

Now that you understand why supervisors are essential, let's create your first one. A Supervisor is a process that monitors other processes (its children) and restarts them when they fail.

## What You'll Learn

- Creating a supervisor with child specifications
- Configuring child restart behavior
- Monitoring what happens when children crash
- Dynamic child management

## Creating a Supervisor

The simplest supervisor watches a single child:

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from '@hamicek/noex';

// A simple counter GenServer
interface CounterState {
  count: number;
}

type CounterCall = { type: 'get' } | { type: 'increment' };
type CounterCast = never;
type CounterReply = number;

const counterBehavior: GenServerBehavior<CounterState, CounterCall, CounterCast, CounterReply> = {
  init() {
    console.log('Counter starting...');
    return { count: 0 };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.count, state];
      case 'increment':
        const newState = { count: state.count + 1 };
        return [newState.count, newState];
    }
  },

  handleCast(_msg, state) {
    return state;
  },

  terminate(reason, state) {
    console.log(`Counter terminating (${typeof reason === 'string' ? reason : 'error'}), final count: ${state.count}`);
  },
};

async function main() {
  // Create a supervisor with one child
  const supervisor = await Supervisor.start({
    children: [
      {
        id: 'counter',
        start: () => GenServer.start(counterBehavior),
      },
    ],
  });

  console.log('Supervisor started');

  // Get the child reference
  const children = Supervisor.getChildren(supervisor);
  const counterRef = children[0]?.ref;

  if (counterRef) {
    // Use the counter normally
    await GenServer.call(counterRef, { type: 'increment' });
    await GenServer.call(counterRef, { type: 'increment' });
    const count = await GenServer.call(counterRef, { type: 'get' });
    console.log(`Count: ${count}`); // 2
  }

  // Clean shutdown
  await Supervisor.stop(supervisor);
}

main();
```

**Output:**
```
Counter starting...
Supervisor started
Count: 2
Counter terminating (shutdown), final count: 2
```

## Child Specifications

Each child is defined by a **ChildSpec** object with these properties:

```typescript
interface ChildSpec {
  // Required: unique identifier for this child
  id: string;

  // Required: factory function to start the child
  start: () => Promise<GenServerRef>;

  // Optional: when to restart (default: 'permanent')
  restart?: 'permanent' | 'transient' | 'temporary';

  // Optional: time to wait for graceful shutdown (default: 5000ms)
  shutdownTimeout?: number;

  // Optional: marks child as significant for auto_shutdown
  significant?: boolean;
}
```

### The `id` Field

Every child needs a unique identifier within its supervisor. This ID is used for:
- Looking up children: `Supervisor.getChild(supervisor, 'counter')`
- Terminating specific children: `Supervisor.terminateChild(supervisor, 'counter')`
- Logging and debugging

```typescript
const supervisor = await Supervisor.start({
  children: [
    { id: 'users', start: () => GenServer.start(userBehavior) },
    { id: 'orders', start: () => GenServer.start(orderBehavior) },
    { id: 'payments', start: () => GenServer.start(paymentBehavior) },
  ],
});

// Look up a specific child
const ordersInfo = Supervisor.getChild(supervisor, 'orders');
if (ordersInfo) {
  console.log(`Orders service restart count: ${ordersInfo.restartCount}`);
}
```

### The `start` Function

The `start` function is a factory that creates the child process. It's called:
- Once during initial supervisor startup
- Every time the child needs to be restarted

Because it's a factory, each call creates a fresh instance with clean state:

```typescript
{
  id: 'cache',
  start: async () => {
    // This runs on every (re)start
    console.log('Starting cache service...');
    return GenServer.start(cacheBehavior);
  },
}
```

You can pass options to `GenServer.start()`:

```typescript
{
  id: 'named-service',
  start: () => GenServer.start(serviceBehavior, {
    name: 'my-service',  // Register in the global registry
  }),
}
```

### The `restart` Field

The `restart` field determines when a child should be restarted after termination:

| Strategy | Restart on crash? | Restart on normal exit? | Use case |
|----------|------------------|------------------------|----------|
| `'permanent'` | Yes | Yes | Core services that must always run |
| `'transient'` | Yes | No | Services that should only restart on failure |
| `'temporary'` | No | No | One-shot tasks |

**Examples:**

```typescript
const supervisor = await Supervisor.start({
  children: [
    // Always running - restart no matter what
    {
      id: 'api-server',
      start: () => GenServer.start(apiBehavior),
      restart: 'permanent', // default
    },

    // Restart only on crashes, not normal termination
    {
      id: 'background-job',
      start: () => GenServer.start(jobBehavior),
      restart: 'transient',
    },

    // Never restart - run once and done
    {
      id: 'migration',
      start: () => GenServer.start(migrationBehavior),
      restart: 'temporary',
    },
  ],
});
```

### The `shutdownTimeout` Field

When stopping a child, the supervisor first asks it to shut down gracefully (calling `terminate()`). The `shutdownTimeout` specifies how long to wait before forcefully terminating:

```typescript
{
  id: 'database-connection',
  start: () => GenServer.start(dbBehavior),
  shutdownTimeout: 10000, // Give 10 seconds to close connections
}
```

## Observing Restarts

When a child terminates (crashes), the supervisor automatically restarts it. Let's see this in action.

**Important:** In noex, when `handleCall` throws an exception, the error is propagated back to the caller but the GenServer continues running. This is useful for error handling. For a process to truly "crash" and trigger supervisor restart, it must terminate - either through an unrecoverable error or explicit stop.

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from '@hamicek/noex';

interface State {
  crashAfter: number;
  callCount: number;
  selfRef?: ReturnType<typeof GenServer.start> extends Promise<infer T> ? T : never;
}

type Call = { type: 'doWork' } | { type: 'setRef'; ref: State['selfRef'] };
type Cast = { type: 'scheduleCrash' };
type Reply = string | void;

// A GenServer that crashes after a certain number of calls
const unstableBehavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init() {
    console.log('[Worker] Starting fresh');
    return { crashAfter: 3, callCount: 0 };
  },

  handleCall(msg, state) {
    if (msg.type === 'setRef') {
      return [undefined, { ...state, selfRef: msg.ref }];
    }

    const newCount = state.callCount + 1;
    console.log(`[Worker] Processing request #${newCount}`);

    if (newCount >= state.crashAfter) {
      console.log('[Worker] Critical failure - initiating crash!');
      // Schedule the crash via cast to happen after we return
      if (state.selfRef) {
        GenServer.cast(state.selfRef, { type: 'scheduleCrash' });
      }
      return ['crashing', { ...state, callCount: newCount }];
    }

    return ['ok', { ...state, callCount: newCount }];
  },

  handleCast(msg, state) {
    if (msg.type === 'scheduleCrash' && state.selfRef) {
      // Stop with error reason to simulate a crash
      GenServer.stop(state.selfRef, { error: new Error('Simulated failure') });
    }
    return state;
  },

  terminate(reason) {
    const reasonStr = typeof reason === 'string' ? reason : 'error';
    console.log(`[Worker] Terminated: ${reasonStr}`);
  },
};

async function main() {
  // Listen for lifecycle events
  const unsubscribe = Supervisor.onLifecycleEvent((event) => {
    if (event.type === 'restarted') {
      console.log(`[Supervisor] Child restarted (attempt #${event.attempt})`);
    }
  });

  const supervisor = await Supervisor.start({
    children: [
      {
        id: 'worker',
        start: async () => {
          const ref = await GenServer.start(unstableBehavior);
          // Give the worker a reference to itself so it can crash
          await GenServer.call(ref, { type: 'setRef', ref });
          return ref;
        },
      },
    ],
  });

  // Make calls that will eventually cause a crash
  for (let i = 0; i < 6; i++) {
    const children = Supervisor.getChildren(supervisor);
    const worker = children[0]?.ref;

    if (worker && GenServer.isRunning(worker)) {
      try {
        const result = await GenServer.call(worker, { type: 'doWork' });
        console.log(`[Main] Got result: ${result}`);
      } catch (error) {
        console.log(`[Main] Call failed: ${(error as Error).message}`);
      }
    }

    // Small delay to allow restart to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Check restart count
  const childInfo = Supervisor.getChild(supervisor, 'worker');
  console.log(`\n[Main] Worker has been restarted ${childInfo?.restartCount} times`);

  unsubscribe();
  await Supervisor.stop(supervisor);
}

main();
```

**Output:**
```
[Worker] Starting fresh
[Worker] Processing request #1
[Main] Got result: ok
[Worker] Processing request #2
[Main] Got result: ok
[Worker] Processing request #3
[Worker] Critical failure - initiating crash!
[Main] Got result: crashing
[Worker] Terminated: error
[Supervisor] Child restarted (attempt #1)
[Worker] Starting fresh
[Worker] Processing request #1
[Main] Got result: ok
[Worker] Processing request #2
[Main] Got result: ok
[Worker] Processing request #3
[Worker] Critical failure - initiating crash!
[Main] Got result: crashing

[Main] Worker has been restarted 1 times
```

Notice how:
1. The worker detected a critical state on the 3rd call
2. It initiated its own termination with an error reason
3. The supervisor detected the termination and restarted it automatically
4. The new worker instance started with fresh state (`callCount: 0`)
5. Subsequent calls succeeded on the new instance

## Dynamic Child Management

You can add and remove children after the supervisor starts:

```typescript
const supervisor = await Supervisor.start({
  children: [
    { id: 'base-service', start: () => GenServer.start(baseBehavior) },
  ],
});

// Dynamically add a new child
const newChildRef = await Supervisor.startChild(supervisor, {
  id: 'dynamic-worker',
  start: () => GenServer.start(workerBehavior),
});

console.log(`Started new child: ${newChildRef.id}`);

// List all children
const children = Supervisor.getChildren(supervisor);
console.log(`Total children: ${children.length}`);

// Terminate a specific child (won't restart)
await Supervisor.terminateChild(supervisor, 'dynamic-worker');

// Manually restart a child
const restartedRef = await Supervisor.restartChild(supervisor, 'base-service');
```

## Startup Order and Shutdown Order

Children are started **in order** (first to last) and stopped **in reverse order** (last to first). This is important when children have dependencies:

```typescript
const supervisor = await Supervisor.start({
  children: [
    // Started first, stopped last
    { id: 'database', start: () => GenServer.start(dbBehavior) },

    // Started second, stopped second
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },

    // Started third, stopped first
    { id: 'api', start: () => GenServer.start(apiBehavior) },
  ],
});

// Shutdown order: api → cache → database
await Supervisor.stop(supervisor);
```

This ensures that the API stops accepting requests before the cache and database are shut down.

## Complete Example: Service Trio

Here's a practical example with three cooperating services:

```typescript
import { Supervisor, GenServer, Registry, type GenServerBehavior } from '@hamicek/noex';

// Logger service
interface LoggerState {
  logs: string[];
}
type LoggerCall = { type: 'getLogs' };
type LoggerCast = { type: 'log'; message: string };

const loggerBehavior: GenServerBehavior<LoggerState, LoggerCall, LoggerCast, string[]> = {
  init: () => ({ logs: [] }),
  handleCall(msg, state) {
    if (msg.type === 'getLogs') {
      return [state.logs, state];
    }
    return [[], state];
  },
  handleCast(msg, state) {
    if (msg.type === 'log') {
      return { logs: [...state.logs, `[${new Date().toISOString()}] ${msg.message}`] };
    }
    return state;
  },
};

// Counter service that uses the logger
interface CounterState {
  count: number;
}
type CounterCall = { type: 'increment' } | { type: 'get' };

const counterBehavior: GenServerBehavior<CounterState, CounterCall, never, number> = {
  init: () => ({ count: 0 }),
  handleCall(msg, state) {
    if (msg.type === 'get') {
      return [state.count, state];
    }
    if (msg.type === 'increment') {
      const newCount = state.count + 1;

      // Log to the logger service
      const logger = Registry.lookup('logger');
      if (logger) {
        GenServer.cast(logger, { type: 'log', message: `Counter incremented to ${newCount}` });
      }

      return [newCount, { count: newCount }];
    }
    return [state.count, state];
  },
  handleCast: (_msg, state) => state,
};

// Stats service
interface StatsState {
  totalOperations: number;
}
type StatsCall = { type: 'getStats' };
type StatsCast = { type: 'recordOperation' };

const statsBehavior: GenServerBehavior<StatsState, StatsCall, StatsCast, number> = {
  init: () => ({ totalOperations: 0 }),
  handleCall(msg, state) {
    if (msg.type === 'getStats') {
      return [state.totalOperations, state];
    }
    return [0, state];
  },
  handleCast(msg, state) {
    if (msg.type === 'recordOperation') {
      return { totalOperations: state.totalOperations + 1 };
    }
    return state;
  },
};

async function main() {
  const supervisor = await Supervisor.start({
    children: [
      {
        id: 'logger',
        start: () => GenServer.start(loggerBehavior, { name: 'logger' }),
      },
      {
        id: 'stats',
        start: () => GenServer.start(statsBehavior, { name: 'stats' }),
      },
      {
        id: 'counter',
        start: () => GenServer.start(counterBehavior, { name: 'counter' }),
      },
    ],
  });

  console.log('All services started');

  // Use the services
  const counter = Registry.lookup('counter');
  const stats = Registry.lookup('stats');
  const logger = Registry.lookup('logger');

  if (counter && stats && logger) {
    for (let i = 0; i < 3; i++) {
      await GenServer.call(counter, { type: 'increment' });
      GenServer.cast(stats, { type: 'recordOperation' });
    }

    const count = await GenServer.call(counter, { type: 'get' });
    const ops = await GenServer.call(stats, { type: 'getStats' });
    const logs = await GenServer.call(logger, { type: 'getLogs' });

    console.log(`\nFinal count: ${count}`);
    console.log(`Total operations: ${ops}`);
    console.log('Logs:');
    logs.forEach((log) => console.log(`  ${log}`));
  }

  await Supervisor.stop(supervisor);
}

main();
```

## Exercise

Create a supervisor that manages two workers:

1. **PingWorker** - responds to `{ type: 'ping' }` with `'pong'`
2. **EchoWorker** - responds to `{ type: 'echo', message: string }` with the same message

Requirements:
- PingWorker should be `permanent` (always restart)
- EchoWorker should be `transient` (only restart on crash)
- Add lifecycle event logging to see when restarts happen
- Make EchoWorker terminate with error when the message is `'crash'`
- Test that the supervisor restarts the crashed worker

<details>
<summary>Solution</summary>

```typescript
import { Supervisor, GenServer, type GenServerBehavior, type GenServerRef } from '@hamicek/noex';

// PingWorker
type PingCall = { type: 'ping' };
const pingBehavior: GenServerBehavior<null, PingCall, never, string> = {
  init: () => null,
  handleCall(msg, _state) {
    if (msg.type === 'ping') {
      return ['pong', null];
    }
    return ['unknown', null];
  },
  handleCast: (_msg, state) => state,
};

// EchoWorker - needs to store its own ref to be able to crash itself
interface EchoState {
  selfRef?: GenServerRef;
}
type EchoCall = { type: 'echo'; message: string } | { type: 'setRef'; ref: GenServerRef };
type EchoCast = { type: 'crash' };

const echoBehavior: GenServerBehavior<EchoState, EchoCall, EchoCast, string | void> = {
  init: () => {
    console.log('[Echo] Starting');
    return {};
  },
  handleCall(msg, state) {
    if (msg.type === 'setRef') {
      return [undefined, { selfRef: msg.ref }];
    }
    if (msg.type === 'echo') {
      if (msg.message === 'crash' && state.selfRef) {
        // Schedule crash and return immediately
        GenServer.cast(state.selfRef, { type: 'crash' });
        return ['crashing...', state];
      }
      return [msg.message, state];
    }
    return ['', state];
  },
  handleCast(msg, state) {
    if (msg.type === 'crash' && state.selfRef) {
      // Terminate with error to trigger supervisor restart
      GenServer.stop(state.selfRef, { error: new Error('Intentional crash') });
    }
    return state;
  },
  terminate(reason) {
    console.log(`[Echo] Terminated: ${typeof reason === 'string' ? reason : 'error'}`);
  },
};

async function main() {
  // Set up lifecycle monitoring
  const unsubscribe = Supervisor.onLifecycleEvent((event) => {
    if (event.type === 'restarted') {
      console.log(`[Monitor] Process restarted, attempt #${event.attempt}`);
    }
  });

  const supervisor = await Supervisor.start({
    children: [
      {
        id: 'ping',
        start: () => GenServer.start(pingBehavior),
        restart: 'permanent',
      },
      {
        id: 'echo',
        start: async () => {
          const ref = await GenServer.start(echoBehavior);
          await GenServer.call(ref, { type: 'setRef', ref });
          return ref;
        },
        restart: 'transient',
      },
    ],
  });

  // Test ping
  const pingRef = Supervisor.getChild(supervisor, 'ping')?.ref;
  if (pingRef) {
    const pong = await GenServer.call(pingRef, { type: 'ping' });
    console.log(`Ping response: ${pong}`);
  }

  // Test echo
  let echoRef = Supervisor.getChild(supervisor, 'echo')?.ref;
  if (echoRef) {
    const msg = await GenServer.call(echoRef, { type: 'echo', message: 'Hello!' });
    console.log(`Echo response: ${msg}`);
  }

  // Cause a crash
  console.log('\nTriggering crash...');
  echoRef = Supervisor.getChild(supervisor, 'echo')?.ref;
  if (echoRef) {
    const result = await GenServer.call(echoRef, { type: 'echo', message: 'crash' });
    console.log(`Response before crash: ${result}`);
  }

  // Wait for restart
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Verify echo is working again
  echoRef = Supervisor.getChild(supervisor, 'echo')?.ref;
  if (echoRef) {
    const recovered = await GenServer.call(echoRef, { type: 'echo', message: 'Back online!' });
    console.log(`After recovery: ${recovered}`);
  }

  // Check restart count
  const echoInfo = Supervisor.getChild(supervisor, 'echo');
  console.log(`Echo restart count: ${echoInfo?.restartCount}`);

  unsubscribe();
  await Supervisor.stop(supervisor);
}

main();
```

**Expected output:**
```
[Echo] Starting
Ping response: pong
Echo response: Hello!

Triggering crash...
Response before crash: crashing...
[Echo] Terminated: error
[Monitor] Process restarted, attempt #1
[Echo] Starting
After recovery: Back online!
Echo restart count: 1
[Echo] Terminated: shutdown
```

</details>

## Summary

- **Supervisor.start()** creates a supervisor with child specifications
- **ChildSpec** defines how to start and restart each child:
  - `id`: unique identifier
  - `start`: factory function that creates the child
  - `restart`: `'permanent'` (default), `'transient'`, or `'temporary'`
  - `shutdownTimeout`: graceful shutdown wait time
- Children start **in order** and stop **in reverse order**
- Use **Supervisor.getChildren()** to list all managed children
- Use **Supervisor.startChild()** and **Supervisor.terminateChild()** for dynamic management
- Use **Supervisor.onLifecycleEvent()** to monitor restarts

The supervisor gives you automatic failure recovery without writing retry logic. In the next chapter, you'll learn how different restart strategies affect which children get restarted when one fails.

---

Next: [Restart Strategies](./03-restart-strategies.md)
