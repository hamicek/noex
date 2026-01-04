# Quick Start

In this 5-minute guide, you'll create your first GenServer and learn the basics of noex.

## What is a GenServer?

A GenServer (Generic Server) is a stateful process that:

- Maintains internal state
- Processes messages one at a time (no race conditions)
- Supports synchronous calls (request/response) and asynchronous casts (fire-and-forget)
- Has lifecycle hooks for initialization and cleanup

## Step 1: Create a Simple Counter

Let's create a counter service that can increment, decrement, and return its value:

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

// Define the state type
type CounterState = number;

// Define message types
type CallMsg = 'get';                    // Synchronous: returns current value
type CastMsg = 'inc' | 'dec' | 'reset';  // Asynchronous: fire-and-forget
type CallReply = number;                 // What 'get' returns

// Define the behavior
const counterBehavior: GenServerBehavior<CounterState, CallMsg, CastMsg, CallReply> = {
  // Initialize state to 0
  init: () => 0,

  // Handle synchronous calls
  handleCall: (msg, state) => {
    // 'get' returns the current state
    return [state, state];  // [reply, newState]
  },

  // Handle asynchronous casts
  handleCast: (msg, state) => {
    switch (msg) {
      case 'inc':   return state + 1;
      case 'dec':   return state - 1;
      case 'reset': return 0;
    }
  },
};
```

## Step 2: Start and Use the GenServer

```typescript
// Start the GenServer
const counter = await GenServer.start(counterBehavior);

// Send asynchronous messages (casts)
GenServer.cast(counter, 'inc');  // state: 1
GenServer.cast(counter, 'inc');  // state: 2
GenServer.cast(counter, 'inc');  // state: 3
GenServer.cast(counter, 'dec');  // state: 2

// Send synchronous message (call) and wait for response
const value = await GenServer.call(counter, 'get');
console.log('Current value:', value);  // Current value: 2

// Reset the counter
GenServer.cast(counter, 'reset');
const newValue = await GenServer.call(counter, 'get');
console.log('After reset:', newValue);  // After reset: 0
```

## Step 3: Clean Shutdown

Always stop your GenServers when done:

```typescript
await GenServer.stop(counter);
```

You can also provide a reason:

```typescript
await GenServer.stop(counter, 'shutdown');
```

## Step 4: Add Lifecycle Hooks

GenServers support a `terminate` callback for cleanup:

```typescript
const counterWithCleanup: GenServerBehavior<CounterState, CallMsg, CastMsg, CallReply> = {
  init: () => {
    console.log('Counter starting...');
    return 0;
  },

  handleCall: (msg, state) => [state, state],

  handleCast: (msg, state) => {
    switch (msg) {
      case 'inc':   return state + 1;
      case 'dec':   return state - 1;
      case 'reset': return 0;
    }
  },

  terminate: (reason, state) => {
    console.log(`Counter shutting down. Reason: ${reason}, Final value: ${state}`);
  },
};
```

## Complete Example

Here's the full code:

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

type CounterState = number;
type CallMsg = 'get';
type CastMsg = 'inc' | 'dec' | 'reset';
type CallReply = number;

const counterBehavior: GenServerBehavior<CounterState, CallMsg, CastMsg, CallReply> = {
  init: () => {
    console.log('Counter initialized');
    return 0;
  },

  handleCall: (msg, state) => [state, state],

  handleCast: (msg, state) => {
    switch (msg) {
      case 'inc':   return state + 1;
      case 'dec':   return state - 1;
      case 'reset': return 0;
    }
  },

  terminate: (reason, state) => {
    console.log(`Counter terminated: ${reason}, final value: ${state}`);
  },
};

// Main
const counter = await GenServer.start(counterBehavior);

GenServer.cast(counter, 'inc');
GenServer.cast(counter, 'inc');
GenServer.cast(counter, 'inc');

const value = await GenServer.call(counter, 'get');
console.log('Value:', value);  // Value: 3

await GenServer.stop(counter);
```

Output:
```
Counter initialized
Value: 3
Counter terminated: normal, final value: 3
```

## Key Concepts Recap

| Concept | Description |
|---------|-------------|
| **State** | Internal data maintained by the GenServer |
| **init()** | Called once when server starts, returns initial state |
| **handleCall()** | Handles synchronous messages, returns `[reply, newState]` |
| **handleCast()** | Handles async messages, returns new state |
| **terminate()** | Optional cleanup when server stops |
| **call()** | Send message and wait for response |
| **cast()** | Send message without waiting (fire-and-forget) |

## What's Next?

Now that you understand the basics, let's build a more complete application with supervision in [First Application](./first-application.md).

---

Next: [First Application](./first-application.md)
