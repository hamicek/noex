# Basic Counter

A minimal GenServer example demonstrating core concepts.

## Overview

This example shows:
- Defining state and message types
- Implementing GenServerBehavior
- Synchronous calls vs asynchronous casts
- Lifecycle management

## Complete Code

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

// State is simply a number
type CounterState = number;

// Synchronous messages (call) - expect a response
type CallMsg = 'get';

// Asynchronous messages (cast) - fire-and-forget
type CastMsg = 'inc' | 'dec' | 'reset' | { type: 'add'; amount: number };

// Reply type for calls
type CallReply = number;

// Define the GenServer behavior
const counterBehavior: GenServerBehavior<CounterState, CallMsg, CastMsg, CallReply> = {
  // Initialize state
  init: () => {
    console.log('Counter initialized');
    return 0;
  },

  // Handle synchronous calls - return [reply, newState]
  handleCall: (msg, state) => {
    switch (msg) {
      case 'get':
        return [state, state];
    }
  },

  // Handle asynchronous casts - return newState
  handleCast: (msg, state) => {
    if (typeof msg === 'string') {
      switch (msg) {
        case 'inc':   return state + 1;
        case 'dec':   return state - 1;
        case 'reset': return 0;
      }
    } else {
      // Handle object message
      return state + msg.amount;
    }
  },

  // Cleanup on shutdown
  terminate: (reason, state) => {
    console.log(`Counter terminated: ${reason}, final value: ${state}`);
  },
};

// Main
async function main() {
  // Start the GenServer
  const counter = await GenServer.start(counterBehavior);

  // Cast messages (async, no response)
  GenServer.cast(counter, 'inc');
  GenServer.cast(counter, 'inc');
  GenServer.cast(counter, { type: 'add', amount: 5 });

  // Call message (sync, waits for response)
  const value = await GenServer.call(counter, 'get');
  console.log('Current value:', value); // 7

  // Reset and verify
  GenServer.cast(counter, 'reset');
  const newValue = await GenServer.call(counter, 'get');
  console.log('After reset:', newValue); // 0

  // Clean shutdown
  await GenServer.stop(counter);
}

main().catch(console.error);
```

## Output

```
Counter initialized
Current value: 7
After reset: 0
Counter terminated: normal, final value: 0
```

## Key Points

### State Type
The state can be any type - primitives, objects, or complex data structures:
```typescript
type CounterState = number;
// or
type CounterState = { value: number; history: number[] };
```

### Message Types
Separate types for calls (sync) and casts (async) provide type safety:
```typescript
type CallMsg = 'get';                    // Expects response
type CastMsg = 'inc' | { type: 'add'; amount: number };  // Fire-and-forget
```

### handleCall Return Value
Returns a tuple `[reply, newState]`:
```typescript
handleCall: (msg, state) => [state, state]  // [response, unchanged state]
```

### handleCast Return Value
Returns just the new state:
```typescript
handleCast: (msg, state) => state + 1  // New state
```

## Variations

### With Async Init

```typescript
init: async () => {
  const savedValue = await loadFromDatabase();
  return savedValue ?? 0;
},
```

### With Async Handlers

```typescript
handleCast: async (msg, state) => {
  await saveToDatabase(state + 1);
  return state + 1;
},
```

## Related

- [Quick Start](../getting-started/quick-start.md) - Basic concepts
- [GenServer Concept](../concepts/genserver.md) - Detailed explanation
- [GenServer API](../api/genserver.md) - Complete API reference
