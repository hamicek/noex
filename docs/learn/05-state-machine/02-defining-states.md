# Defining States and Events

In the previous chapter, you learned *when* to use GenStateMachine. Now let's dive into *how* to structure your state machine — defining states, handling events, and managing transitions.

## What You'll Learn

- How to structure state handlers with `handleEvent`, `onEnter`, and `onExit`
- The five transition result types and when to use each
- How events flow through your state machine
- The three timeout types: state, event, and generic
- Practical patterns for building robust state machines

## The Anatomy of a State Machine

A GenStateMachine behavior has three main parts:

```typescript
import { GenStateMachine, type StateMachineBehavior, type TimeoutEvent } from '@hamicek/noex';

type State = 'idle' | 'running' | 'paused';
type Event = { type: 'start' } | { type: 'pause' } | { type: 'resume' } | { type: 'stop' };
interface Data {
  startedAt: number | null;
  pausedAt: number | null;
}

const behavior: StateMachineBehavior<State, Event, Data> = {
  // 1. INITIALIZATION
  init: () => ({
    state: 'idle',
    data: { startedAt: null, pausedAt: null },
  }),

  // 2. STATE HANDLERS
  states: {
    idle: { /* ... */ },
    running: { /* ... */ },
    paused: { /* ... */ },
  },

  // 3. TERMINATION (optional)
  terminate(reason, state, data) {
    console.log(`Stopped in ${state} state with reason: ${reason}`);
  },
};
```

## State Handlers

Each state in your machine is defined by a **StateHandler** object with up to three methods:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           STATE HANDLER STRUCTURE                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│    StateHandler<State, Event, Data>                                         │
│    ┌────────────────────────────────────────────────────────────────┐      │
│    │                                                                 │      │
│    │  handleEvent(event, data, from?)                               │      │
│    │  ─────────────────────────────────                             │      │
│    │  • REQUIRED                                                    │      │
│    │  • Called for every event in this state                        │      │
│    │  • Must return a StateTransitionResult                         │      │
│    │  • `from` is a DeferredReply for callWithReply patterns        │      │
│    │                                                                 │      │
│    │  onEnter(data, previousState)                                  │      │
│    │  ─────────────────────────────                                 │      │
│    │  • OPTIONAL                                                    │      │
│    │  • Called when entering this state                             │      │
│    │  • Can mutate data directly                                    │      │
│    │  • Good for setup, logging, starting timers                    │      │
│    │                                                                 │      │
│    │  onExit(data, nextState)                                       │      │
│    │  ────────────────────────                                      │      │
│    │  • OPTIONAL                                                    │      │
│    │  • Called when leaving this state                              │      │
│    │  • Can mutate data directly                                    │      │
│    │  • Good for cleanup, saving state, canceling operations        │      │
│    │                                                                 │      │
│    └────────────────────────────────────────────────────────────────┘      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### handleEvent — The Core Method

Every state must have a `handleEvent` method. It receives the incoming event and current data, and returns a transition result:

```typescript
states: {
  idle: {
    handleEvent(event, data) {
      if (event.type === 'start') {
        return {
          type: 'transition',
          nextState: 'running',
          data: { ...data, startedAt: Date.now() },
        };
      }
      // Ignore events we don't handle in this state
      return { type: 'keep_state_and_data' };
    },
  },
}
```

### onEnter — Setup on State Entry

The `onEnter` callback runs every time the state machine enters this state:

```typescript
states: {
  running: {
    onEnter(data, previousState) {
      console.log(`Started running (from ${previousState})`);
      // Can mutate data directly
      data.startedAt = Date.now();
    },

    handleEvent(event, data) {
      // ...
    },
  },
}
```

Use `onEnter` for:
- Logging state transitions
- Initializing state-specific resources
- Setting up timers
- Sending notifications

### onExit — Cleanup on State Exit

The `onExit` callback runs when leaving a state:

```typescript
states: {
  running: {
    onExit(data, nextState) {
      console.log(`Stopping (going to ${nextState})`);
      // Can mutate data directly
      if (data.socket) {
        data.socket.pause();
      }
    },

    handleEvent(event, data) {
      // ...
    },
  },
}
```

Use `onExit` for:
- Cleaning up resources
- Canceling pending operations
- Logging
- Saving intermediate state

### Transition Lifecycle

When a state transition occurs, the lifecycle is:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          STATE TRANSITION LIFECYCLE                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│     Event arrives                                                           │
│          │                                                                  │
│          ▼                                                                  │
│    ┌──────────────┐                                                         │
│    │ handleEvent  │  ◄── Returns { type: 'transition', nextState: 'B' }     │
│    │   (state A)  │                                                         │
│    └──────────────┘                                                         │
│          │                                                                  │
│          ▼                                                                  │
│    ┌──────────────┐                                                         │
│    │   onExit     │  ◄── Called with (data, 'B')                            │
│    │   (state A)  │                                                         │
│    └──────────────┘                                                         │
│          │                                                                  │
│          ▼                                                                  │
│    ┌──────────────┐                                                         │
│    │  State A→B   │  ◄── State timeout for A is canceled                    │
│    │  transition  │                                                         │
│    └──────────────┘                                                         │
│          │                                                                  │
│          ▼                                                                  │
│    ┌──────────────┐                                                         │
│    │   onEnter    │  ◄── Called with (data, 'A')                            │
│    │   (state B)  │                                                         │
│    └──────────────┘                                                         │
│          │                                                                  │
│          ▼                                                                  │
│    ┌──────────────┐                                                         │
│    │   Actions    │  ◄── Process any actions from the transition result     │
│    │  processed   │                                                         │
│    └──────────────┘                                                         │
│          │                                                                  │
│          ▼                                                                  │
│    ┌──────────────┐                                                         │
│    │  Postponed   │  ◄── If state changed, replay postponed events          │
│    │   replayed   │                                                         │
│    └──────────────┘                                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## State Transition Results

Your `handleEvent` method must return one of five result types:

### 1. transition — Move to a New State

Use when the event should cause a state change:

```typescript
handleEvent(event, data) {
  if (event.type === 'start') {
    return {
      type: 'transition',
      nextState: 'running',
      data: { ...data, startedAt: Date.now() },
    };
  }
  // ...
}
```

The transition result:
- Triggers `onExit` for the current state
- Changes the current state
- Triggers `onEnter` for the new state
- Cancels any state timeout
- Replays postponed events (if state actually changed)

### 2. keep_state — Stay in State, Update Data

Use when you need to update data but remain in the same state:

```typescript
handleEvent(event, data) {
  if (event.type === 'increment') {
    return {
      type: 'keep_state',
      data: { ...data, count: data.count + 1 },
    };
  }
  // ...
}
```

### 3. keep_state_and_data — No Changes

Use when the event doesn't affect the state machine:

```typescript
handleEvent(event, data) {
  if (event.type === 'unknown_event') {
    // Ignore this event
    return { type: 'keep_state_and_data' };
  }
  // ...
}
```

This is the "do nothing" result — no state change, no data change.

### 4. postpone — Handle Later

Use when an event isn't valid in the current state but might be valid in a future state:

```typescript
states: {
  initializing: {
    handleEvent(event, data) {
      if (event.type === 'process_data') {
        // Can't process data yet — save for later
        return { type: 'postpone' };
      }
      if (event.type === 'init_complete') {
        return { type: 'transition', nextState: 'ready', data };
      }
      return { type: 'keep_state_and_data' };
    },
  },

  ready: {
    handleEvent(event, data) {
      if (event.type === 'process_data') {
        // Now we can handle it — postponed events are replayed automatically
        return {
          type: 'keep_state',
          data: { ...data, processed: [...data.processed, event.payload] },
        };
      }
      return { type: 'keep_state_and_data' };
    },
  },
}
```

Postponed events are automatically replayed when the state changes.

### 5. stop — Terminate the State Machine

Use when the state machine should shut down:

```typescript
handleEvent(event, data) {
  if (event.type === 'shutdown') {
    return {
      type: 'stop',
      reason: 'normal',
      data: { ...data, shutdownAt: Date.now() },
    };
  }
  // ...
}
```

After a `stop` result, the `terminate` callback is called and the state machine shuts down.

### Result Type Summary

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        STATE TRANSITION RESULT TYPES                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Result Type          │ State Changes? │ Data Changes? │ When to Use        │
│  ─────────────────────┼───────────────┼──────────────┼──────────────────── │
│  transition           │ YES           │ YES          │ Event causes state  │
│                       │               │              │ change              │
│  ─────────────────────┼───────────────┼──────────────┼──────────────────── │
│  keep_state           │ NO            │ YES          │ Update data only    │
│  ─────────────────────┼───────────────┼──────────────┼──────────────────── │
│  keep_state_and_data  │ NO            │ NO           │ Ignore event        │
│  ─────────────────────┼───────────────┼──────────────┼──────────────────── │
│  postpone             │ NO            │ NO           │ Handle event later  │
│  ─────────────────────┼───────────────┼──────────────┼──────────────────── │
│  stop                 │ TERMINATES    │ FINAL        │ Shut down machine   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Actions — Side Effects from Handlers

Transition results can include an `actions` array for side effects:

```typescript
return {
  type: 'transition',
  nextState: 'processing',
  data,
  actions: [
    { type: 'state_timeout', time: 5000 },
    { type: 'next_event', event: { type: 'begin_processing' } },
  ],
};
```

Available actions:

| Action | Description |
|--------|-------------|
| `state_timeout` | Timer that fires if state doesn't change |
| `event_timeout` | Timer that resets on any event |
| `generic_timeout` | Named timer that survives state changes |
| `next_event` | Immediately process another event |
| `reply` | Send response for `callWithReply` |

## Timeouts In Depth

GenStateMachine provides three distinct timeout types, each with different behavior:

### State Timeout

A state timeout fires if you stay in a state too long. It's automatically canceled when you transition to a different state.

```typescript
states: {
  connecting: {
    handleEvent(event, data) {
      if (event.type === 'connect') {
        return {
          type: 'transition',
          nextState: 'connecting',
          data,
          actions: [{ type: 'state_timeout', time: 10000 }], // 10 seconds to connect
        };
      }

      // Check if this is a timeout event
      const timeoutEvent = event as TimeoutEvent;
      if (timeoutEvent.type === 'timeout' && timeoutEvent.timeoutType === 'state_timeout') {
        // Connection timed out
        return {
          type: 'transition',
          nextState: 'failed',
          data: { ...data, error: 'Connection timeout' },
        };
      }

      if (event.type === 'connected') {
        // Timeout is automatically canceled on state change
        return {
          type: 'transition',
          nextState: 'connected',
          data: { ...data, socket: event.socket },
        };
      }

      return { type: 'keep_state_and_data' };
    },
  },
}
```

**Use state timeout for:** "Must leave this state within X time"

### Event Timeout

An event timeout fires if no events arrive within the timeout period. It resets on any incoming event.

```typescript
states: {
  active: {
    handleEvent(event, data) {
      const timeoutEvent = event as TimeoutEvent;
      if (timeoutEvent.type === 'timeout' && timeoutEvent.timeoutType === 'event_timeout') {
        // No activity for too long
        return {
          type: 'transition',
          nextState: 'idle',
          data,
        };
      }

      // Any other event — process it and reset the timeout
      if (event.type === 'activity') {
        return {
          type: 'keep_state',
          data: { ...data, lastActivity: Date.now() },
          actions: [{ type: 'event_timeout', time: 30000 }], // Reset 30s timeout
        };
      }

      return { type: 'keep_state_and_data' };
    },

    onEnter(data) {
      // Note: Can't set timeout in onEnter — use init() actions instead
    },
  },
}

// Set initial event timeout in init()
const behavior: StateMachineBehavior<State, Event, Data> = {
  init: () => ({
    state: 'active',
    data: { lastActivity: Date.now() },
    actions: [{ type: 'event_timeout', time: 30000 }],
  }),
  // ...
};
```

**Use event timeout for:** "Must receive any event within X time" (idle detection)

### Generic Timeout

A generic timeout is a named timer that persists across state transitions. It only fires when explicitly set and survives state changes.

```typescript
states: {
  pending: {
    handleEvent(event, data) {
      if (event.type === 'start_payment') {
        // Start a payment timeout that survives state changes
        return {
          type: 'transition',
          nextState: 'processing',
          data,
          actions: [{ type: 'generic_timeout', name: 'payment', time: 60000 }],
        };
      }
      return { type: 'keep_state_and_data' };
    },
  },

  processing: {
    handleEvent(event, data) {
      const timeoutEvent = event as TimeoutEvent;
      if (timeoutEvent.type === 'timeout' &&
          timeoutEvent.timeoutType === 'generic_timeout' &&
          timeoutEvent.name === 'payment') {
        // Payment took too long
        return {
          type: 'transition',
          nextState: 'payment_failed',
          data: { ...data, error: 'Payment timeout' },
        };
      }

      if (event.type === 'payment_complete') {
        // Note: Generic timeout continues ticking — cancel it by setting time: 0
        // or just let the state machine handle it in 'completed' state
        return {
          type: 'transition',
          nextState: 'completed',
          data,
        };
      }

      return { type: 'keep_state_and_data' };
    },
  },

  completed: {
    handleEvent(event, data) {
      // If we get the payment timeout here, we can ignore it
      const timeoutEvent = event as TimeoutEvent;
      if (timeoutEvent.type === 'timeout') {
        return { type: 'keep_state_and_data' };
      }
      return { type: 'keep_state_and_data' };
    },
  },
}
```

**Use generic timeout for:** "Action X must complete within Y time" (even if we change states)

### Timeout Type Comparison

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          TIMEOUT TYPE COMPARISON                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Timeout Type    │ Canceled By          │ Common Use Case                   │
│  ────────────────┼─────────────────────┼────────────────────────────────── │
│  state_timeout   │ State transition    │ Connection timeout, auth timeout  │
│  ────────────────┼─────────────────────┼────────────────────────────────── │
│  event_timeout   │ Any incoming event  │ Idle detection, keepalive         │
│  ────────────────┼─────────────────────┼────────────────────────────────── │
│  generic_timeout │ Only explicitly     │ Business process deadlines        │
│                  │ (or machine stops)  │                                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Timeout Event Structure

When a timeout fires, your handler receives a `TimeoutEvent`:

```typescript
interface TimeoutEvent {
  type: 'timeout';
  timeoutType: 'state_timeout' | 'event_timeout' | 'generic_timeout';
  name: string | undefined;  // Only for generic_timeout
  event: unknown;            // Optional custom payload
}
```

You can include a custom payload when setting the timeout:

```typescript
actions: [
  {
    type: 'state_timeout',
    time: 5000,
    event: { reason: 'connection_attempt', attempt: 3 },
  },
]

// Then in handler:
const timeoutEvent = event as TimeoutEvent;
if (timeoutEvent.type === 'timeout') {
  console.log('Timeout payload:', timeoutEvent.event);
  // { reason: 'connection_attempt', attempt: 3 }
}
```

## The next_event Action

The `next_event` action lets you trigger immediate event processing without going through the message queue:

```typescript
handleEvent(event, data) {
  if (event.type === 'start_sequence') {
    // Transition to step1 and immediately trigger 'execute'
    return {
      type: 'transition',
      nextState: 'step1',
      data,
      actions: [{ type: 'next_event', event: { type: 'execute' } }],
    };
  }
  // ...
}
```

This is useful for:
- Chaining automatic state transitions
- Breaking complex logic into separate handlers
- Starting processing immediately after entering a state

```typescript
// Chain of automatic transitions
states: {
  start: {
    handleEvent(event, data) {
      if (event.type === 'begin') {
        return {
          type: 'transition',
          nextState: 'validate',
          data,
          actions: [{ type: 'next_event', event: { type: 'run' } }],
        };
      }
      return { type: 'keep_state_and_data' };
    },
  },

  validate: {
    handleEvent(event, data) {
      if (event.type === 'run') {
        if (isValid(data)) {
          return {
            type: 'transition',
            nextState: 'execute',
            data,
            actions: [{ type: 'next_event', event: { type: 'run' } }],
          };
        }
        return {
          type: 'transition',
          nextState: 'failed',
          data: { ...data, error: 'Validation failed' },
        };
      }
      return { type: 'keep_state_and_data' };
    },
  },

  execute: {
    handleEvent(event, data) {
      if (event.type === 'run') {
        // Do the work
        const result = doWork(data);
        return {
          type: 'transition',
          nextState: 'completed',
          data: { ...data, result },
        };
      }
      return { type: 'keep_state_and_data' };
    },
  },

  completed: {
    handleEvent() {
      return { type: 'keep_state_and_data' };
    },
  },

  failed: {
    handleEvent() {
      return { type: 'keep_state_and_data' };
    },
  },
}
```

## Complete Example: Download Manager

Here's a comprehensive example combining all the concepts:

```typescript
import { GenStateMachine, type StateMachineBehavior, type TimeoutEvent } from '@hamicek/noex';

// States
type State = 'idle' | 'downloading' | 'paused' | 'completed' | 'failed';

// Events
type Event =
  | { type: 'start'; url: string }
  | { type: 'progress'; bytes: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'complete' }
  | { type: 'error'; message: string }
  | { type: 'retry' }
  | { type: 'cancel' };

// Data
interface Data {
  url: string | null;
  bytesDownloaded: number;
  totalBytes: number | null;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  startedAt: number | null;
}

const downloadManagerBehavior: StateMachineBehavior<State, Event, Data> = {
  init: () => ({
    state: 'idle',
    data: {
      url: null,
      bytesDownloaded: 0,
      totalBytes: null,
      attempts: 0,
      maxAttempts: 3,
      error: null,
      startedAt: null,
    },
  }),

  states: {
    idle: {
      handleEvent(event, data) {
        if (event.type === 'start') {
          return {
            type: 'transition',
            nextState: 'downloading',
            data: {
              ...data,
              url: event.url,
              bytesDownloaded: 0,
              attempts: 1,
              error: null,
              startedAt: Date.now(),
            },
            actions: [
              // 30 second download timeout
              { type: 'state_timeout', time: 30000 },
            ],
          };
        }
        return { type: 'keep_state_and_data' };
      },
    },

    downloading: {
      onEnter(data, previousState) {
        console.log(`Downloading ${data.url} (attempt ${data.attempts}, from ${previousState})`);
      },

      handleEvent(event, data) {
        // Check for timeout
        const timeoutEvent = event as TimeoutEvent;
        if (timeoutEvent.type === 'timeout' && timeoutEvent.timeoutType === 'state_timeout') {
          if (data.attempts < data.maxAttempts) {
            return {
              type: 'transition',
              nextState: 'downloading',
              data: { ...data, attempts: data.attempts + 1 },
              actions: [{ type: 'state_timeout', time: 30000 }],
            };
          }
          return {
            type: 'transition',
            nextState: 'failed',
            data: { ...data, error: 'Download timeout after max attempts' },
          };
        }

        if (event.type === 'progress') {
          return {
            type: 'keep_state',
            data: { ...data, bytesDownloaded: data.bytesDownloaded + event.bytes },
          };
        }

        if (event.type === 'pause') {
          return {
            type: 'transition',
            nextState: 'paused',
            data,
          };
        }

        if (event.type === 'complete') {
          return {
            type: 'transition',
            nextState: 'completed',
            data,
          };
        }

        if (event.type === 'error') {
          if (data.attempts < data.maxAttempts) {
            return {
              type: 'transition',
              nextState: 'downloading',
              data: { ...data, attempts: data.attempts + 1 },
              actions: [{ type: 'state_timeout', time: 30000 }],
            };
          }
          return {
            type: 'transition',
            nextState: 'failed',
            data: { ...data, error: event.message },
          };
        }

        if (event.type === 'cancel') {
          return {
            type: 'transition',
            nextState: 'idle',
            data: {
              ...data,
              url: null,
              bytesDownloaded: 0,
              attempts: 0,
              startedAt: null,
            },
          };
        }

        return { type: 'keep_state_and_data' };
      },

      onExit(data, nextState) {
        console.log(`Stopping download (going to ${nextState}), ${data.bytesDownloaded} bytes downloaded`);
      },
    },

    paused: {
      onEnter() {
        console.log('Download paused');
      },

      handleEvent(event, data) {
        if (event.type === 'resume') {
          return {
            type: 'transition',
            nextState: 'downloading',
            data,
            actions: [{ type: 'state_timeout', time: 30000 }],
          };
        }

        if (event.type === 'cancel') {
          return {
            type: 'transition',
            nextState: 'idle',
            data: {
              ...data,
              url: null,
              bytesDownloaded: 0,
              attempts: 0,
              startedAt: null,
            },
          };
        }

        // Ignore progress events while paused
        if (event.type === 'progress') {
          return { type: 'keep_state_and_data' };
        }

        return { type: 'keep_state_and_data' };
      },
    },

    completed: {
      onEnter(data) {
        const duration = Date.now() - (data.startedAt || Date.now());
        console.log(`Download completed! ${data.bytesDownloaded} bytes in ${duration}ms`);
      },

      handleEvent(event, data) {
        // Can start a new download
        if (event.type === 'start') {
          return {
            type: 'transition',
            nextState: 'downloading',
            data: {
              ...data,
              url: event.url,
              bytesDownloaded: 0,
              attempts: 1,
              error: null,
              startedAt: Date.now(),
            },
            actions: [{ type: 'state_timeout', time: 30000 }],
          };
        }
        return { type: 'keep_state_and_data' };
      },
    },

    failed: {
      onEnter(data) {
        console.log(`Download failed: ${data.error}`);
      },

      handleEvent(event, data) {
        if (event.type === 'retry' && data.url) {
          return {
            type: 'transition',
            nextState: 'downloading',
            data: {
              ...data,
              bytesDownloaded: 0,
              attempts: 1,
              error: null,
              startedAt: Date.now(),
            },
            actions: [{ type: 'state_timeout', time: 30000 }],
          };
        }

        if (event.type === 'start') {
          return {
            type: 'transition',
            nextState: 'downloading',
            data: {
              ...data,
              url: event.url,
              bytesDownloaded: 0,
              attempts: 1,
              error: null,
              startedAt: Date.now(),
            },
            actions: [{ type: 'state_timeout', time: 30000 }],
          };
        }

        return { type: 'keep_state_and_data' };
      },
    },
  },

  terminate(reason, state, data) {
    console.log(`Download manager terminated in ${state} state (reason: ${reason})`);
    if (data.url && state === 'downloading') {
      console.log(`Warning: Download of ${data.url} was interrupted`);
    }
  },
};

// Usage
async function demo() {
  const manager = await GenStateMachine.start(downloadManagerBehavior, {
    name: 'download-manager',
  });

  // Start download
  await GenStateMachine.call(manager, {
    type: 'start',
    url: 'https://example.com/file.zip',
  });

  // Simulate progress
  GenStateMachine.cast(manager, { type: 'progress', bytes: 1024 });
  GenStateMachine.cast(manager, { type: 'progress', bytes: 2048 });

  // Pause
  await GenStateMachine.call(manager, { type: 'pause' });

  // Check state
  const state = await GenStateMachine.getState(manager);
  console.log('Current state:', state); // 'paused'

  // Resume and complete
  await GenStateMachine.call(manager, { type: 'resume' });
  await GenStateMachine.call(manager, { type: 'complete' });

  // Clean up
  await GenStateMachine.stop(manager);
}
```

## Exercise: Build a Session Manager

Create a session state machine that handles user login sessions with:

**States:** `logged_out` → `authenticating` → `active` → `expired`

**Events:**
- `login` with username/password
- `login_success` with session token
- `login_failed` with reason
- `activity` (any user activity)
- `logout`

**Requirements:**
1. Authentication has a 10-second timeout (state timeout)
2. After 3 failed login attempts, lock out for 30 seconds
3. Active sessions expire after 5 minutes of inactivity (event timeout)
4. Track failed login attempts and session start time

### Solution

<details>
<summary>Click to reveal solution</summary>

```typescript
import { GenStateMachine, type StateMachineBehavior, type TimeoutEvent } from '@hamicek/noex';

type State = 'logged_out' | 'authenticating' | 'active' | 'locked' | 'expired';

type Event =
  | { type: 'login'; username: string; password: string }
  | { type: 'login_success'; token: string }
  | { type: 'login_failed'; reason: string }
  | { type: 'activity' }
  | { type: 'logout' };

interface Data {
  username: string | null;
  token: string | null;
  failedAttempts: number;
  sessionStartedAt: number | null;
  lastActivityAt: number | null;
}

const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const AUTH_TIMEOUT = 10 * 1000; // 10 seconds
const LOCKOUT_TIME = 30 * 1000; // 30 seconds
const MAX_ATTEMPTS = 3;

const sessionBehavior: StateMachineBehavior<State, Event, Data> = {
  init: () => ({
    state: 'logged_out',
    data: {
      username: null,
      token: null,
      failedAttempts: 0,
      sessionStartedAt: null,
      lastActivityAt: null,
    },
  }),

  states: {
    logged_out: {
      handleEvent(event, data) {
        if (event.type === 'login') {
          return {
            type: 'transition',
            nextState: 'authenticating',
            data: { ...data, username: event.username },
            actions: [{ type: 'state_timeout', time: AUTH_TIMEOUT }],
          };
        }
        return { type: 'keep_state_and_data' };
      },
    },

    authenticating: {
      onEnter(data) {
        console.log(`Authenticating user: ${data.username}`);
      },

      handleEvent(event, data) {
        const timeoutEvent = event as TimeoutEvent;
        if (timeoutEvent.type === 'timeout' && timeoutEvent.timeoutType === 'state_timeout') {
          const attempts = data.failedAttempts + 1;
          if (attempts >= MAX_ATTEMPTS) {
            return {
              type: 'transition',
              nextState: 'locked',
              data: { ...data, failedAttempts: attempts },
              actions: [{ type: 'state_timeout', time: LOCKOUT_TIME }],
            };
          }
          return {
            type: 'transition',
            nextState: 'logged_out',
            data: { ...data, failedAttempts: attempts, username: null },
          };
        }

        if (event.type === 'login_success') {
          return {
            type: 'transition',
            nextState: 'active',
            data: {
              ...data,
              token: event.token,
              failedAttempts: 0,
              sessionStartedAt: Date.now(),
              lastActivityAt: Date.now(),
            },
            actions: [{ type: 'event_timeout', time: SESSION_TIMEOUT }],
          };
        }

        if (event.type === 'login_failed') {
          const attempts = data.failedAttempts + 1;
          console.log(`Login failed: ${event.reason} (attempt ${attempts}/${MAX_ATTEMPTS})`);

          if (attempts >= MAX_ATTEMPTS) {
            return {
              type: 'transition',
              nextState: 'locked',
              data: { ...data, failedAttempts: attempts },
              actions: [{ type: 'state_timeout', time: LOCKOUT_TIME }],
            };
          }

          return {
            type: 'transition',
            nextState: 'logged_out',
            data: { ...data, failedAttempts: attempts, username: null },
          };
        }

        return { type: 'keep_state_and_data' };
      },
    },

    active: {
      onEnter(data) {
        console.log(`Session started for ${data.username}`);
      },

      handleEvent(event, data) {
        const timeoutEvent = event as TimeoutEvent;
        if (timeoutEvent.type === 'timeout' && timeoutEvent.timeoutType === 'event_timeout') {
          return {
            type: 'transition',
            nextState: 'expired',
            data,
          };
        }

        if (event.type === 'activity') {
          return {
            type: 'keep_state',
            data: { ...data, lastActivityAt: Date.now() },
            actions: [{ type: 'event_timeout', time: SESSION_TIMEOUT }],
          };
        }

        if (event.type === 'logout') {
          return {
            type: 'transition',
            nextState: 'logged_out',
            data: {
              ...data,
              username: null,
              token: null,
              sessionStartedAt: null,
              lastActivityAt: null,
            },
          };
        }

        return { type: 'keep_state_and_data' };
      },

      onExit(data, nextState) {
        if (data.sessionStartedAt) {
          const duration = Date.now() - data.sessionStartedAt;
          console.log(`Session ended after ${Math.round(duration / 1000)}s (going to ${nextState})`);
        }
      },
    },

    locked: {
      onEnter(data) {
        console.log(`Account locked after ${data.failedAttempts} failed attempts`);
      },

      handleEvent(event, data) {
        const timeoutEvent = event as TimeoutEvent;
        if (timeoutEvent.type === 'timeout' && timeoutEvent.timeoutType === 'state_timeout') {
          return {
            type: 'transition',
            nextState: 'logged_out',
            data: { ...data, failedAttempts: 0 },
          };
        }

        // Ignore login attempts while locked
        if (event.type === 'login') {
          console.log('Cannot login while locked');
          return { type: 'keep_state_and_data' };
        }

        return { type: 'keep_state_and_data' };
      },
    },

    expired: {
      onEnter(data) {
        console.log(`Session expired for ${data.username} due to inactivity`);
      },

      handleEvent(event, data) {
        if (event.type === 'login') {
          return {
            type: 'transition',
            nextState: 'authenticating',
            data: {
              ...data,
              username: event.username,
              token: null,
              sessionStartedAt: null,
              lastActivityAt: null,
            },
            actions: [{ type: 'state_timeout', time: AUTH_TIMEOUT }],
          };
        }
        return { type: 'keep_state_and_data' };
      },
    },
  },

  terminate(reason, state, data) {
    if (data.token) {
      console.log(`Invalidating session token for ${data.username}`);
    }
  },
};

// Test the session manager
async function testSession() {
  const session = await GenStateMachine.start(sessionBehavior, { name: 'session' });

  // Login
  await GenStateMachine.call(session, {
    type: 'login',
    username: 'john',
    password: 'secret',
  });

  // Simulate successful authentication
  await GenStateMachine.call(session, {
    type: 'login_success',
    token: 'abc123',
  });

  console.log('State:', await GenStateMachine.getState(session)); // 'active'

  // Simulate activity
  GenStateMachine.cast(session, { type: 'activity' });

  // Logout
  await GenStateMachine.call(session, { type: 'logout' });

  console.log('State:', await GenStateMachine.getState(session)); // 'logged_out'

  await GenStateMachine.stop(session);
}
```

</details>

## Summary

- **State handlers** define behavior for each state with `handleEvent` (required), `onEnter`, and `onExit`
- **Transition results** control state machine behavior: `transition`, `keep_state`, `keep_state_and_data`, `postpone`, `stop`
- **Actions** add side effects: timeouts, next events, replies
- **Three timeout types** serve different purposes:
  - State timeout: canceled on state change
  - Event timeout: reset on any event
  - Generic timeout: survives state changes
- **next_event** enables immediate event processing and state chaining
- Use `onEnter` for setup, `onExit` for cleanup

---

Next: [Order Workflow](./03-order-workflow.md)
