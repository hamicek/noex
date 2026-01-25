# Key Concepts

Before diving into code, let's establish a clear mental model of how noex applications work. Understanding these four concepts will make everything else click into place.

## What You'll Learn

- How GenServer provides isolated, stateful processes
- Why messages (call/cast) are the only way to communicate
- How supervision automatically recovers from failures
- The counterintuitive wisdom of "let it crash"

## Processes (GenServer)

In noex, a **process** is a lightweight, isolated unit of computation with its own private state. Unlike operating system processes or threads, noex processes are:

- **Lightweight**: You can run thousands without significant overhead
- **Isolated**: Each process owns its state - no shared memory
- **Sequential**: Messages are processed one at a time

The primary building block is `GenServer` (Generic Server):

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

// Define the shape of our process
interface CounterState {
  value: number;
}

type CounterCall = { type: 'get' } | { type: 'increment' };
type CounterCast = { type: 'reset' };
type CounterReply = number;

// Define the behavior
const counterBehavior: GenServerBehavior<
  CounterState,
  CounterCall,
  CounterCast,
  CounterReply
> = {
  // Called once when the process starts
  init: () => ({ value: 0 }),

  // Handle synchronous requests (caller waits for response)
  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.value, state];
      case 'increment':
        const newState = { value: state.value + 1 };
        return [newState.value, newState];
    }
  },

  // Handle asynchronous notifications (fire-and-forget)
  handleCast(msg, state) {
    if (msg.type === 'reset') {
      return { value: 0 };
    }
    return state;
  },

  // Called when the process is stopping (optional)
  terminate(reason, state) {
    console.log(`Counter stopped with value ${state.value}`);
  },
};

// Start the process
const counter = await GenServer.start(counterBehavior);
```

**Key insight**: The state (`{ value: 0 }`) is completely private. No external code can read or modify it directly. The only way to interact with it is through messages.

### Process Identity

Every process has a unique reference (`GenServerRef`). This reference is how you address messages:

```typescript
const counter = await GenServer.start(counterBehavior);
// counter is a GenServerRef - your handle to this specific process

// You can also register processes by name for easier lookup
const namedCounter = await GenServer.start(counterBehavior, {
  name: 'main-counter'
});

// Later, find it by name
const found = Registry.lookup('main-counter');
```

## Messages (call/cast)

Processes communicate exclusively through messages. noex provides two patterns:

### call - Synchronous Request/Response

Use `call` when you need a response:

```typescript
// Caller blocks until the process responds
const currentValue = await GenServer.call(counter, { type: 'get' });
console.log(currentValue); // 0

// You can also set a custom timeout (default is 5 seconds)
const value = await GenServer.call(counter, { type: 'get' }, { timeout: 1000 });
```

**How it works internally:**

1. Your message is added to the process's queue
2. When processed, `handleCall` runs with the message and current state
3. The return value `[reply, newState]` sends `reply` back to you
4. The process state is updated to `newState`

### cast - Asynchronous Fire-and-Forget

Use `cast` when you don't need a response:

```typescript
// Returns immediately - doesn't wait for processing
GenServer.cast(counter, { type: 'reset' });

// Useful for:
// - Logging/metrics
// - Notifications
// - Background operations
// - When you don't care about the result
```

**How it works internally:**

1. Your message is added to the process's queue
2. When processed, `handleCast` runs with the message and current state
3. The return value becomes the new state
4. No response is sent (you've already moved on)

### Sequential Processing

Messages are processed **one at a time**, in the order they arrive. This eliminates race conditions:

```typescript
// These calls will be processed in order
const promise1 = GenServer.call(counter, { type: 'increment' });
const promise2 = GenServer.call(counter, { type: 'increment' });
const promise3 = GenServer.call(counter, { type: 'get' });

const [result1, result2, value] = await Promise.all([promise1, promise2, promise3]);
// value is guaranteed to be 2
```

Even if you fire these concurrently from different parts of your application, the counter will process them sequentially, ensuring consistent state.

## Supervision

Processes will fail. Network connections drop, external services go down, bugs happen. Instead of trying to prevent all failures (impossible), noex embraces them with **supervisors**.

A `Supervisor` is a special process that:

- Starts and monitors child processes
- Automatically restarts children when they crash
- Implements restart strategies for different failure scenarios

```typescript
import { Supervisor, GenServer } from 'noex';

const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    {
      id: 'counter-1',
      start: () => GenServer.start(counterBehavior),
    },
    {
      id: 'counter-2',
      start: () => GenServer.start(counterBehavior),
    },
  ],
});
```

### Restart Strategies

Supervisors support different strategies for handling crashes:

**`one_for_one`** (most common)

Only restart the crashed child. Other children are unaffected.

```text
Before crash:     [A] [B] [C]
A crashes:        [X] [B] [C]
After restart:    [A'] [B] [C]  (A restarted, B and C unchanged)
```

**`one_for_all`**

When one child crashes, restart all children. Use this when children depend on each other.

```text
Before crash:     [A] [B] [C]
A crashes:        [X] [X] [X]  (all stopped)
After restart:    [A'] [B'] [C']  (all restarted)
```

**`rest_for_one`**

Restart the crashed child and all children started after it. Use this for sequential dependencies.

```text
Before crash:     [A] [B] [C]
B crashes:        [A] [X] [X]  (B and C stopped)
After restart:    [A] [B'] [C']  (B and C restarted)
```

### Child Restart Options

Each child can specify its restart behavior:

```typescript
{
  id: 'worker',
  start: () => GenServer.start(workerBehavior),
  restart: 'permanent',  // Always restart (default)
}

{
  id: 'task-runner',
  start: () => GenServer.start(taskBehavior),
  restart: 'transient',  // Only restart on abnormal exit (errors)
}

{
  id: 'one-shot',
  start: () => GenServer.start(oneshotBehavior),
  restart: 'temporary',  // Never restart
}
```

### Restart Intensity

To prevent infinite restart loops (crash -> restart -> crash -> restart...), supervisors limit how many restarts can occur within a time window:

```typescript
await Supervisor.start({
  strategy: 'one_for_one',
  restartIntensity: {
    maxRestarts: 3,    // Maximum 3 restarts...
    withinMs: 5000,    // ...within 5 seconds
  },
  children: [/* ... */],
});
```

If exceeded, the supervisor itself shuts down, escalating the failure to its parent supervisor (if any).

## "Let it Crash" Philosophy

This is perhaps the most counterintuitive concept for developers from traditional backgrounds. The idea is:

> Don't try to handle every possible error. Let processes crash and recover to a known good state.

### Why This Works

1. **Simplicity**: Error handling code is often more complex than the happy path. By accepting failure, you write less defensive code.

2. **Clean State**: A restarted process begins fresh. No corrupted state, no half-completed operations, no accumulated garbage.

3. **Isolation**: A crash in one process doesn't affect others. The failure is contained.

4. **Recovery**: Supervision ensures the system recovers automatically. No manual intervention needed.

### Example: The Traditional Way vs Let It Crash

**Traditional approach** - Handle every possible error:

```typescript
async function fetchUserData(userId: string): Promise<User | null> {
  try {
    const response = await fetch(`/api/users/${userId}`);
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      if (response.status === 429) {
        // Rate limited - wait and retry?
        await sleep(1000);
        return fetchUserData(userId);
      }
      if (response.status >= 500) {
        // Server error - retry with backoff?
        // How many times? What if it keeps failing?
      }
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    // Validate data structure?
    // Handle malformed responses?
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      // Request was cancelled - retry?
    }
    if (error.code === 'ECONNREFUSED') {
      // Service down - queue for later?
    }
    // Log? Retry? Throw? Return null?
    throw error;
  }
}
```

**Let it crash approach** - Trust supervision:

```typescript
const userServiceBehavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init: () => ({ cache: new Map() }),

  async handleCall(msg, state) {
    if (msg.type === 'get_user') {
      // If this throws for ANY reason, the process crashes
      // and gets restarted by the supervisor
      const response = await fetch(`/api/users/${msg.userId}`);
      const user = await response.json();
      state.cache.set(msg.userId, user);
      return [user, state];
    }
    return [null, state];
  },

  handleCast(msg, state) {
    return state;
  },
};

// Supervisor ensures automatic recovery
await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'user-service', start: () => GenServer.start(userServiceBehavior) },
  ],
});
```

The process doesn't need to handle network errors, timeouts, or malformed responses. If anything goes wrong, it crashes and restarts with a clean state. The supervisor ensures the system stays running.

### When To Use Defensive Code

Let it crash doesn't mean "never handle errors." Use defensive error handling for:

- **Validation at boundaries**: Check user input, API requests from external clients
- **Business logic errors**: Invalid state transitions, insufficient funds, etc.
- **Expected failures**: File not found, record doesn't exist

Use let it crash for:

- **Infrastructure failures**: Network issues, database connection drops
- **Unexpected errors**: Bugs, corrupted state, resource exhaustion
- **Transient failures**: Temporary service unavailability

## How It All Fits Together

Here's how these concepts combine in a real application:

```text
                    ┌─────────────────┐
                    │   Application   │
                    └────────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
     ┌────────┴────────┐          ┌────────┴────────┐
     │  UserSupervisor │          │ OrderSupervisor │
     └────────┬────────┘          └────────┬────────┘
              │                             │
    ┌─────────┼─────────┐         ┌────────┼────────┐
    │         │         │         │        │        │
┌───┴───┐ ┌───┴───┐ ┌───┴───┐ ┌───┴──┐ ┌───┴──┐ ┌───┴──┐
│ User  │ │ User  │ │ User  │ │Order │ │Order │ │Order │
│Service│ │ Cache │ │ Auth  │ │Queue │ │ DB   │ │Notify│
└───────┘ └───────┘ └───────┘ └──────┘ └──────┘ └──────┘
```

1. **Processes** (GenServer) handle individual concerns with isolated state
2. **Messages** (call/cast) enable communication between processes
3. **Supervisors** organize processes into fault-tolerant hierarchies
4. **Let it crash** keeps the code simple - failures are handled by the supervision tree

## Summary

| Concept | Purpose | Key Point |
|---------|---------|-----------|
| **GenServer** | Isolated stateful process | State is private, accessed only via messages |
| **call** | Synchronous request | Blocks until response, returns `[reply, newState]` |
| **cast** | Async notification | Fire-and-forget, returns new state |
| **Supervisor** | Failure recovery | Monitors children, restarts on crash |
| **Let it crash** | Simplicity | Don't handle every error, trust supervision |

With these concepts understood, you're ready to build your first GenServer.

---

Next: [First GenServer](../02-basics/01-first-genserver.md)
