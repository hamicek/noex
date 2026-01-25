# First GenServer

A GenServer (Generic Server) is the fundamental building block in noex. It's a process that encapsulates state and processes messages sequentially, eliminating race conditions by design.

In this chapter, you'll build your first GenServer from scratch and understand the core callbacks that make it work.

## What You'll Learn

- How to install noex in your project
- Creating a simple counter with GenServer
- Understanding the `init()`, `handleCall()`, and `handleCast()` callbacks
- Starting and interacting with a GenServer
- Type-safe message handling with TypeScript

## Installation

Install noex via npm:

```bash
npm install @hamicek/noex
```

**Requirements:**
- Node.js 20.0.0 or higher
- TypeScript 5.0+ (recommended for full type safety)

Your `tsconfig.json` should include:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true
  }
}
```

## Creating a Counter

Let's build the classic example: a counter that can be incremented, decremented, and queried. This simple example demonstrates all the core GenServer concepts.

### Step 1: Define Your Types

First, define the types for your state and messages. This is where TypeScript shines - you get full type safety for all interactions with your GenServer.

```typescript
import { GenServer, type GenServerBehavior } from '@hamicek/noex';

// The internal state of our counter
interface CounterState {
  count: number;
}

// Messages that expect a response (synchronous)
type CounterCallMsg =
  | { type: 'get' }
  | { type: 'increment' }
  | { type: 'decrement' }
  | { type: 'add'; amount: number };

// Messages that don't expect a response (fire-and-forget)
type CounterCastMsg =
  | { type: 'reset' }
  | { type: 'log' };

// The type of replies from call messages
type CounterReply = number;
```

### Step 2: Implement the Behavior

A GenServer behavior defines how your server initializes and handles messages:

```typescript
const counterBehavior: GenServerBehavior<
  CounterState,
  CounterCallMsg,
  CounterCastMsg,
  CounterReply
> = {
  // Called once when the server starts
  init() {
    return { count: 0 };
  },

  // Handle synchronous messages (caller waits for response)
  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        // Return [reply, newState]
        return [state.count, state];

      case 'increment':
        const incState = { count: state.count + 1 };
        return [incState.count, incState];

      case 'decrement':
        const decState = { count: state.count - 1 };
        return [decState.count, decState];

      case 'add':
        const addState = { count: state.count + msg.amount };
        return [addState.count, addState];
    }
  },

  // Handle asynchronous messages (fire-and-forget)
  handleCast(msg, state) {
    switch (msg.type) {
      case 'reset':
        return { count: 0 };

      case 'log':
        console.log(`Current count: ${state.count}`);
        return state; // State unchanged
    }
  },
};
```

### Step 3: Start and Use the GenServer

```typescript
async function main() {
  // Start the GenServer
  const counter = await GenServer.start(counterBehavior);

  // Synchronous calls - wait for response
  const initial = await GenServer.call(counter, { type: 'get' });
  console.log(`Initial: ${initial}`); // 0

  await GenServer.call(counter, { type: 'increment' });
  await GenServer.call(counter, { type: 'increment' });
  await GenServer.call(counter, { type: 'add', amount: 10 });

  const current = await GenServer.call(counter, { type: 'get' });
  console.log(`After operations: ${current}`); // 12

  // Asynchronous cast - fire and forget
  GenServer.cast(counter, { type: 'log' }); // Prints: Current count: 12
  GenServer.cast(counter, { type: 'reset' });

  const afterReset = await GenServer.call(counter, { type: 'get' });
  console.log(`After reset: ${afterReset}`); // 0

  // Clean shutdown
  await GenServer.stop(counter);
}

main();
```

## Understanding the Callbacks

### init()

The `init` callback is called once when the GenServer starts. It must return the initial state.

```typescript
init() {
  return { count: 0 };
}
```

**Key points:**
- Called synchronously during `GenServer.start()`
- Can be async (return a Promise) for async initialization
- If `init` throws, the GenServer fails to start
- Has a configurable timeout (default: 5 seconds)

**Async initialization example:**

```typescript
async init() {
  const data = await loadFromDatabase();
  return { count: data.lastCount };
}
```

### handleCall()

The `handleCall` callback handles synchronous messages where the caller expects a response.

```typescript
handleCall(msg, state) {
  return [reply, newState];
}
```

**Key points:**
- Must return a tuple: `[reply, newState]`
- The `reply` is sent back to the caller
- The `newState` becomes the new internal state
- Messages are processed one at a time (serialized)
- Can be async for operations that need to await

**The serialization guarantee is crucial:** Even if 1000 requests call `increment` simultaneously, they'll be processed one by one. No race conditions possible.

```typescript
// This is always safe - no locks needed!
handleCall(msg, state) {
  if (msg.type === 'increment') {
    return [state.count + 1, { count: state.count + 1 }];
  }
  // ...
}
```

### handleCast()

The `handleCast` callback handles asynchronous messages where no response is expected.

```typescript
handleCast(msg, state) {
  return newState;
}
```

**Key points:**
- Returns only the new state (no reply)
- The caller doesn't wait for processing
- Useful for notifications, logging, or updates where you don't need confirmation
- Errors in `handleCast` are silently ignored (no caller to report to)

**When to use cast vs call:**

| Use `call` when... | Use `cast` when... |
|-------------------|-------------------|
| You need the result | You don't need confirmation |
| You need to wait for completion | Fire-and-forget is acceptable |
| You want to propagate errors | Logging, metrics, notifications |
| Read operations | Write operations where order matters but confirmation doesn't |

## Complete Example

Here's a complete, runnable example:

```typescript
// counter.ts
import { GenServer, type GenServerBehavior } from '@hamicek/noex';

interface State {
  count: number;
  history: number[];
}

type CallMsg =
  | { type: 'get' }
  | { type: 'increment' }
  | { type: 'decrement' }
  | { type: 'getHistory' };

type CastMsg =
  | { type: 'reset' };

type Reply = number | number[];

const behavior: GenServerBehavior<State, CallMsg, CastMsg, Reply> = {
  init: () => ({
    count: 0,
    history: [],
  }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.count, state];

      case 'increment': {
        const newCount = state.count + 1;
        return [newCount, {
          count: newCount,
          history: [...state.history, newCount],
        }];
      }

      case 'decrement': {
        const newCount = state.count - 1;
        return [newCount, {
          count: newCount,
          history: [...state.history, newCount],
        }];
      }

      case 'getHistory':
        return [state.history, state];
    }
  },

  handleCast(msg, state) {
    switch (msg.type) {
      case 'reset':
        return { count: 0, history: [] };
    }
  },
};

async function main() {
  const counter = await GenServer.start(behavior);

  // Perform some operations
  await GenServer.call(counter, { type: 'increment' });
  await GenServer.call(counter, { type: 'increment' });
  await GenServer.call(counter, { type: 'decrement' });
  await GenServer.call(counter, { type: 'increment' });

  const count = await GenServer.call(counter, { type: 'get' });
  const history = await GenServer.call(counter, { type: 'getHistory' });

  console.log(`Count: ${count}`);        // Count: 2
  console.log(`History: ${history}`);    // History: 1,2,1,2

  await GenServer.stop(counter);
}

main().catch(console.error);
```

Run with:

```bash
npx tsx counter.ts
```

## Named Servers

You can register a GenServer with a name for easy lookup:

```typescript
const counter = await GenServer.start(behavior, {
  name: 'main-counter',
});

// Later, from anywhere in your code:
import { Registry } from '@hamicek/noex';

const ref = Registry.lookup('main-counter');
if (ref) {
  const count = await GenServer.call(ref, { type: 'get' });
}
```

## Error Handling

If `handleCall` throws an error, it's propagated to the caller:

```typescript
handleCall(msg, state) {
  if (msg.type === 'divide') {
    if (msg.by === 0) {
      throw new Error('Division by zero');
    }
    // ...
  }
}

// Caller receives the error
try {
  await GenServer.call(counter, { type: 'divide', by: 0 });
} catch (error) {
  console.error('Operation failed:', error.message);
}
```

The GenServer continues running after an error in `handleCall`. The error is only sent to the specific caller, and other messages continue to be processed normally.

## Exercise

Create a **Stack GenServer** that supports:

1. `push(item)` - adds an item to the top (use cast)
2. `pop()` - removes and returns the top item (use call)
3. `peek()` - returns the top item without removing it (use call)
4. `size()` - returns the number of items (use call)
5. `clear()` - removes all items (use cast)

**Hints:**
- State should be `{ items: T[] }`
- `pop()` on empty stack should return `null`
- Think about which operations need a response (call) vs. which don't (cast)

<details>
<summary>Solution</summary>

```typescript
import { GenServer, type GenServerBehavior } from '@hamicek/noex';

interface StackState<T> {
  items: T[];
}

type StackCallMsg<T> =
  | { type: 'pop' }
  | { type: 'peek' }
  | { type: 'size' };

type StackCastMsg<T> =
  | { type: 'push'; item: T }
  | { type: 'clear' };

type StackReply<T> = T | null | number;

function createStackBehavior<T>(): GenServerBehavior<
  StackState<T>,
  StackCallMsg<T>,
  StackCastMsg<T>,
  StackReply<T>
> {
  return {
    init: () => ({ items: [] }),

    handleCall(msg, state) {
      switch (msg.type) {
        case 'pop': {
          if (state.items.length === 0) {
            return [null, state];
          }
          const [top, ...rest] = state.items;
          return [top, { items: rest }];
        }

        case 'peek':
          return [state.items[0] ?? null, state];

        case 'size':
          return [state.items.length, state];
      }
    },

    handleCast(msg, state) {
      switch (msg.type) {
        case 'push':
          return { items: [msg.item, ...state.items] };

        case 'clear':
          return { items: [] };
      }
    },
  };
}

// Usage
async function main() {
  const stack = await GenServer.start(createStackBehavior<string>());

  GenServer.cast(stack, { type: 'push', item: 'first' });
  GenServer.cast(stack, { type: 'push', item: 'second' });
  GenServer.cast(stack, { type: 'push', item: 'third' });

  console.log(await GenServer.call(stack, { type: 'size' }));  // 3
  console.log(await GenServer.call(stack, { type: 'peek' }));  // 'third'
  console.log(await GenServer.call(stack, { type: 'pop' }));   // 'third'
  console.log(await GenServer.call(stack, { type: 'pop' }));   // 'second'
  console.log(await GenServer.call(stack, { type: 'size' }));  // 1

  await GenServer.stop(stack);
}

main();
```

</details>

## Summary

- **GenServer** encapsulates state and processes messages sequentially
- **`init()`** initializes the state when the server starts
- **`handleCall()`** handles synchronous messages that expect a reply
- **`handleCast()`** handles asynchronous fire-and-forget messages
- Messages are processed one at a time, eliminating race conditions
- Use **call** when you need a response, **cast** when you don't
- GenServers can be **named** for easy discovery via Registry

The sequential message processing is the key insight: by forcing all state changes through a single queue, GenServer makes concurrent programming safe and predictable.

---

Next: [Process Lifecycle](./02-lifecycle.md)
