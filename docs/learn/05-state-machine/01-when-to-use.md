# When to Use GenStateMachine

So far, you've been using GenServer for all your processes. GenServer is flexible — it handles messages, maintains state, and integrates with supervision. But some problems have a **natural state machine structure** that GenServer doesn't capture well.

GenStateMachine is a specialized behavior built on top of GenServer that makes **explicit states and transitions** first-class citizens. When your domain has clear states, defined transitions, and state-specific behavior, GenStateMachine expresses this more clearly than GenServer.

## What You'll Learn

- The difference between GenServer and GenStateMachine
- When to choose GenStateMachine over GenServer
- Key features: explicit states, transitions, timeouts, postponing
- Real-world use cases and decision guidelines

## GenServer: Implicit State

With GenServer, state is whatever data structure you maintain. Transitions happen implicitly through your message handling logic:

```typescript
// GenServer approach to a connection handler
interface ConnectionState {
  status: 'connecting' | 'connected' | 'disconnected';
  socket: Socket | null;
  pendingMessages: Message[];
  retryCount: number;
}

const connectionBehavior: GenServerBehavior<ConnectionState, CallMsg, CastMsg, Reply> = {
  init: () => ({
    status: 'connecting',
    socket: null,
    pendingMessages: [],
    retryCount: 0,
  }),

  handleCall(msg, state) {
    if (msg.type === 'send') {
      // State-dependent logic scattered in conditionals
      if (state.status === 'connecting') {
        // Queue the message
        return [{ queued: true }, {
          ...state,
          pendingMessages: [...state.pendingMessages, msg.message],
        }];
      }
      if (state.status === 'connected') {
        // Send immediately
        state.socket!.send(msg.message);
        return [{ sent: true }, state];
      }
      if (state.status === 'disconnected') {
        throw new Error('Not connected');
      }
    }

    if (msg.type === 'connect') {
      // More state-dependent logic
      if (state.status === 'connecting') {
        // Already connecting
        return [{ alreadyConnecting: true }, state];
      }
      // ... and so on
    }

    // Every handler needs to check current status
    // Easy to forget a state combination
    // Transitions are implicit in state mutations
  },
};
```

This works, but notice:
- State transitions are hidden in object spreads (`status: 'connected'`)
- Every handler must check the current status
- It's easy to miss state combinations or create invalid transitions
- There's no enforcement that certain events are only valid in certain states

## GenStateMachine: Explicit States

GenStateMachine makes states explicit. Each state has its own handler, and transitions are returned as structured results:

```typescript
// GenStateMachine approach — same connection handler
type State = 'connecting' | 'connected' | 'disconnected';

type Event =
  | { type: 'connected'; socket: Socket }
  | { type: 'disconnected' }
  | { type: 'send'; message: Message }
  | { type: 'reconnect' };

interface Data {
  socket: Socket | null;
  pendingMessages: Message[];
  retryCount: number;
}

const connectionBehavior: StateMachineBehavior<State, Event, Data> = {
  init: () => ({
    state: 'connecting',
    data: { socket: null, pendingMessages: [], retryCount: 0 },
  }),

  states: {
    // Each state has its own handler — no conditionals needed
    connecting: {
      handleEvent(event, data) {
        if (event.type === 'connected') {
          return {
            type: 'transition',
            nextState: 'connected',
            data: { ...data, socket: event.socket, retryCount: 0 },
          };
        }
        if (event.type === 'send') {
          // Queue message while connecting
          return {
            type: 'keep_state',
            data: { ...data, pendingMessages: [...data.pendingMessages, event.message] },
          };
        }
        if (event.type === 'disconnected') {
          return { type: 'transition', nextState: 'disconnected', data };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter(data) {
        // Called when entering 'connecting' state
        console.log(`Connecting... (attempt ${data.retryCount + 1})`);
      },
    },

    connected: {
      handleEvent(event, data) {
        if (event.type === 'send') {
          // Send directly — we know we're connected
          data.socket!.send(event.message);
          return { type: 'keep_state_and_data' };
        }
        if (event.type === 'disconnected') {
          return {
            type: 'transition',
            nextState: 'disconnected',
            data: { ...data, socket: null },
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter(data) {
        // Flush queued messages on connection
        for (const msg of data.pendingMessages) {
          data.socket!.send(msg);
        }
        data.pendingMessages = [];
      },
    },

    disconnected: {
      handleEvent(event, data) {
        if (event.type === 'reconnect') {
          return {
            type: 'transition',
            nextState: 'connecting',
            data: { ...data, retryCount: data.retryCount + 1 },
          };
        }
        if (event.type === 'send') {
          // Can't send while disconnected — postpone or reject
          throw new Error('Not connected');
        }
        return { type: 'keep_state_and_data' };
      },
    },
  },
};
```

Notice the difference:
- Each state's handler only deals with events relevant to that state
- Transitions are explicit: `{ type: 'transition', nextState: 'connected', ... }`
- `onEnter` callbacks run automatically when entering a state
- The structure enforces that you handle all states
- Invalid transitions are impossible — you control what transitions exist

## Key Features of GenStateMachine

### 1. Explicit State Transitions

Transitions are returned as structured results:

```typescript
// Transition to a new state with new data
return { type: 'transition', nextState: 'running', data: newData };

// Stay in current state but update data
return { type: 'keep_state', data: newData };

// Stay in current state, keep current data
return { type: 'keep_state_and_data' };

// Stop the state machine
return { type: 'stop', reason: 'normal', data };
```

### 2. State Entry/Exit Callbacks

Run code when entering or leaving states:

```typescript
states: {
  processing: {
    onEnter(data, previousState) {
      // Start a timer, acquire resources, log
      console.log(`Started processing (from ${previousState})`);
    },

    onExit(data, nextState) {
      // Clean up resources, log
      console.log(`Finished processing (going to ${nextState})`);
    },

    handleEvent(event, data) {
      // ...
    },
  },
}
```

### 3. Three Types of Timeouts

GenStateMachine provides sophisticated timeout management:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         GENSTATTEMACHINE TIMEOUTS                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  STATE TIMEOUT                                                              │
│  ─────────────                                                              │
│  • Canceled automatically on state transition                               │
│  • Perfect for: "must leave this state within X time"                       │
│                                                                             │
│      [connecting] ──(5s timeout)──▶ [failed]                                │
│            │                                                                │
│            └──(connected event)──▶ [connected] (timeout canceled)           │
│                                                                             │
│  ───────────────────────────────────────────────────────────────────────── │
│                                                                             │
│  EVENT TIMEOUT                                                              │
│  ─────────────                                                              │
│  • Canceled automatically when ANY event arrives                            │
│  • Perfect for: "must receive an event within X time"                       │
│                                                                             │
│      [waiting] ──(no events for 30s)──▶ [idle]                              │
│           │                                                                 │
│           └──(any event)──▶ (timeout reset)                                 │
│                                                                             │
│  ───────────────────────────────────────────────────────────────────────── │
│                                                                             │
│  GENERIC TIMEOUT                                                            │
│  ───────────────                                                            │
│  • Named timers that survive state transitions                              │
│  • Perfect for: "action X must complete within Y time"                      │
│                                                                             │
│      Start "payment_timeout" in [pending]                                   │
│             │                                                               │
│             ├──▶ [processing] (timer continues)                             │
│             │                                                               │
│             └──▶ [completed] ←── timeout fires here if not done             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

```typescript
// Set a state timeout (canceled on state change)
return {
  type: 'transition',
  nextState: 'connecting',
  data,
  actions: [{ type: 'state_timeout', time: 5000 }],
};

// Set an event timeout (canceled on any event)
return {
  type: 'keep_state_and_data',
  actions: [{ type: 'event_timeout', time: 30000 }],
};

// Set a named generic timeout (survives state changes)
return {
  type: 'transition',
  nextState: 'processing',
  data,
  actions: [{ type: 'generic_timeout', name: 'payment', time: 60000 }],
};

// Handle timeout events
handleEvent(event, data) {
  if (event.type === 'timeout') {
    if (event.timeoutType === 'state_timeout') {
      // State timeout fired
      return { type: 'transition', nextState: 'failed', data };
    }
    if (event.timeoutType === 'generic_timeout' && event.name === 'payment') {
      // Payment timeout fired
      return { type: 'transition', nextState: 'payment_expired', data };
    }
  }
  // ...
}
```

### 4. Event Postponing

Defer events until a later state where they make sense:

```typescript
states: {
  initializing: {
    handleEvent(event, data) {
      if (event.type === 'process_data') {
        // Can't process yet — postpone until 'ready' state
        return { type: 'postpone' };
      }
      if (event.type === 'init_complete') {
        // Postponed events will replay automatically after this transition
        return { type: 'transition', nextState: 'ready', data };
      }
      return { type: 'keep_state_and_data' };
    },
  },

  ready: {
    handleEvent(event, data) {
      if (event.type === 'process_data') {
        // Now we can handle it
        return { type: 'keep_state', data: { ...data, processed: event.payload } };
      }
      return { type: 'keep_state_and_data' };
    },
  },
}
```

### 5. Internal Events

Trigger immediate event processing within the same handler:

```typescript
handleEvent(event, data) {
  if (event.type === 'start') {
    return {
      type: 'transition',
      nextState: 'step1',
      data,
      // This event is processed immediately after the transition
      actions: [{ type: 'next_event', event: { type: 'continue' } }],
    };
  }
  // ...
}
```

## When to Use GenStateMachine

### Use GenStateMachine When:

| Scenario | Why GenStateMachine |
|----------|---------------------|
| **Explicit state diagram** | Your domain has clear states drawn on a whiteboard |
| **State-dependent behavior** | Same event means different things in different states |
| **Complex timeouts** | Multiple timeout types or timeouts that span states |
| **Protocol implementation** | Connection states, handshakes, session management |
| **Workflow/business process** | Order lifecycle, approval processes, task workflows |
| **Game logic** | Turn-based games, match states, player status |
| **Device control** | Hardware states, mode switching, initialization sequences |

### Use GenServer When:

| Scenario | Why GenServer |
|----------|---------------|
| **No clear states** | State is just data that changes continuously |
| **All events valid always** | Any message can be handled at any time |
| **Simple request-response** | Stateless calculations, lookups, CRUD |
| **Worker processes** | Task execution, background jobs |
| **Aggregators/coordinators** | Collecting data, dispatching work |

### Decision Flowchart

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              GENSERVER vs GENSTATTEMACHINE DECISION GUIDE                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                        Can you draw a state diagram?                        │
│                                    │                                        │
│                       ┌────────────┴────────────┐                           │
│                       ▼                         ▼                           │
│                      YES                        NO                          │
│                       │                         │                           │
│                       ▼                         ▼                           │
│            Do events mean different      ┌─────────────┐                    │
│            things in different states?   │  GenServer  │                    │
│                       │                  └─────────────┘                    │
│            ┌──────────┴──────────┐                                          │
│            ▼                     ▼                                          │
│           YES                    NO                                         │
│            │                     │                                          │
│            ▼                     ▼                                          │
│   Do you need state-based   ┌─────────────┐                                 │
│   timeouts or postponing?   │  GenServer  │                                 │
│            │                │  (simpler)  │                                 │
│            │                └─────────────┘                                 │
│       ┌────┴────┐                                                           │
│       ▼         ▼                                                           │
│      YES        NO                                                          │
│       │         │                                                           │
│       ▼         ▼                                                           │
│ ┌─────────────────┐    Consider complexity:                                 │
│ │GenStateMachine  │    • 2-3 states: GenServer might be fine                │
│ │  (definitely)   │    • 4+ states: GenStateMachine clearer                 │
│ └─────────────────┘    • Growing states: GenStateMachine scales better      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Real-World Examples

### Example 1: WebSocket Connection

A connection manager with connecting → connected → disconnected states:

```typescript
import { GenStateMachine, type StateMachineBehavior, type TimeoutEvent } from '@hamicek/noex';

type State = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

type Event =
  | { type: 'connect'; url: string }
  | { type: 'connected'; socket: WebSocket }
  | { type: 'message'; data: unknown }
  | { type: 'send'; payload: unknown }
  | { type: 'close' }
  | { type: 'error'; error: Error };

interface Data {
  url: string | null;
  socket: WebSocket | null;
  messageQueue: unknown[];
  reconnectAttempts: number;
  maxReconnectAttempts: number;
}

const wsConnectionBehavior: StateMachineBehavior<State, Event, Data> = {
  init: () => ({
    state: 'disconnected',
    data: {
      url: null,
      socket: null,
      messageQueue: [],
      reconnectAttempts: 0,
      maxReconnectAttempts: 5,
    },
  }),

  states: {
    disconnected: {
      handleEvent(event, data) {
        if (event.type === 'connect') {
          return {
            type: 'transition',
            nextState: 'connecting',
            data: { ...data, url: event.url },
          };
        }
        if (event.type === 'send') {
          // Queue message for when connected
          return {
            type: 'keep_state',
            data: { ...data, messageQueue: [...data.messageQueue, event.payload] },
          };
        }
        return { type: 'keep_state_and_data' };
      },
    },

    connecting: {
      handleEvent(event, data) {
        if (event.type === 'connected') {
          return {
            type: 'transition',
            nextState: 'connected',
            data: { ...data, socket: event.socket, reconnectAttempts: 0 },
          };
        }
        if (event.type === 'error' || (event as TimeoutEvent).type === 'timeout') {
          if (data.reconnectAttempts < data.maxReconnectAttempts) {
            return {
              type: 'transition',
              nextState: 'reconnecting',
              data: { ...data, reconnectAttempts: data.reconnectAttempts + 1 },
            };
          }
          return {
            type: 'transition',
            nextState: 'disconnected',
            data: { ...data, reconnectAttempts: 0 },
          };
        }
        if (event.type === 'send') {
          return { type: 'postpone' }; // Queue until connected
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter(data) {
        // Connection timeout: 10 seconds
        console.log(`Connecting to ${data.url}...`);
      },
    },

    connected: {
      handleEvent(event, data) {
        if (event.type === 'send') {
          data.socket?.send(JSON.stringify(event.payload));
          return { type: 'keep_state_and_data' };
        }
        if (event.type === 'message') {
          console.log('Received:', event.data);
          return { type: 'keep_state_and_data' };
        }
        if (event.type === 'close' || event.type === 'error') {
          return {
            type: 'transition',
            nextState: 'reconnecting',
            data: { ...data, socket: null },
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter(data) {
        // Flush queued messages
        for (const msg of data.messageQueue) {
          data.socket?.send(JSON.stringify(msg));
        }
        data.messageQueue = [];
        console.log('Connected!');
      },

      onExit(data) {
        data.socket?.close();
      },
    },

    reconnecting: {
      handleEvent(event, data) {
        if ((event as TimeoutEvent).type === 'timeout') {
          return {
            type: 'transition',
            nextState: 'connecting',
            data,
          };
        }
        if (event.type === 'send') {
          return { type: 'postpone' };
        }
        if (event.type === 'close') {
          return {
            type: 'transition',
            nextState: 'disconnected',
            data: { ...data, reconnectAttempts: 0 },
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter(data) {
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        const backoff = Math.min(1000 * Math.pow(2, data.reconnectAttempts - 1), 16000);
        console.log(`Reconnecting in ${backoff}ms (attempt ${data.reconnectAttempts})...`);
      },
    },
  },
};

// Usage
async function demo() {
  const conn = await GenStateMachine.start(wsConnectionBehavior, { name: 'ws-connection' });

  // Connect
  GenStateMachine.cast(conn, { type: 'connect', url: 'wss://api.example.com' });

  // Messages sent before connection completes are queued
  GenStateMachine.cast(conn, { type: 'send', payload: { action: 'subscribe', channel: 'events' } });

  // Check state
  const state = await GenStateMachine.getState(conn);
  console.log('Current state:', state);

  // Later: clean disconnect
  GenStateMachine.cast(conn, { type: 'close' });
}
```

### Example 2: Authentication Session

A session with multiple authentication steps:

```typescript
type AuthState = 'anonymous' | 'credentials_entered' | 'awaiting_2fa' | 'authenticated' | 'locked';

type AuthEvent =
  | { type: 'login'; username: string; password: string }
  | { type: 'verify_2fa'; code: string }
  | { type: 'logout' }
  | { type: 'invalid_credentials' }
  | { type: 'invalid_2fa' }
  | { type: 'session_expired' };

interface AuthData {
  username: string | null;
  loginAttempts: number;
  lastActivity: number;
  sessionToken: string | null;
}

const authBehavior: StateMachineBehavior<AuthState, AuthEvent, AuthData> = {
  init: () => ({
    state: 'anonymous',
    data: {
      username: null,
      loginAttempts: 0,
      lastActivity: Date.now(),
      sessionToken: null,
    },
  }),

  states: {
    anonymous: {
      handleEvent(event, data) {
        if (event.type === 'login') {
          // Validate credentials (simplified)
          const valid = validateCredentials(event.username, event.password);
          if (!valid) {
            const attempts = data.loginAttempts + 1;
            if (attempts >= 3) {
              return { type: 'transition', nextState: 'locked', data: { ...data, loginAttempts: attempts } };
            }
            return { type: 'keep_state', data: { ...data, loginAttempts: attempts } };
          }

          // Check if 2FA required
          if (requires2FA(event.username)) {
            return {
              type: 'transition',
              nextState: 'awaiting_2fa',
              data: { ...data, username: event.username, loginAttempts: 0 },
              actions: [{ type: 'state_timeout', time: 120000 }], // 2 min to enter code
            };
          }

          return {
            type: 'transition',
            nextState: 'authenticated',
            data: {
              ...data,
              username: event.username,
              loginAttempts: 0,
              sessionToken: generateToken(),
            },
          };
        }
        return { type: 'keep_state_and_data' };
      },
    },

    awaiting_2fa: {
      handleEvent(event, data) {
        if (event.type === 'verify_2fa') {
          const valid = verify2FACode(data.username!, event.code);
          if (!valid) {
            const attempts = data.loginAttempts + 1;
            if (attempts >= 3) {
              return { type: 'transition', nextState: 'locked', data: { ...data, loginAttempts: attempts } };
            }
            return { type: 'keep_state', data: { ...data, loginAttempts: attempts } };
          }

          return {
            type: 'transition',
            nextState: 'authenticated',
            data: { ...data, sessionToken: generateToken(), loginAttempts: 0 },
          };
        }
        if ((event as TimeoutEvent).type === 'timeout') {
          // 2FA timeout — return to anonymous
          return {
            type: 'transition',
            nextState: 'anonymous',
            data: { ...data, username: null },
          };
        }
        return { type: 'keep_state_and_data' };
      },
    },

    authenticated: {
      handleEvent(event, data) {
        if (event.type === 'logout' || event.type === 'session_expired') {
          return {
            type: 'transition',
            nextState: 'anonymous',
            data: { ...data, username: null, sessionToken: null },
          };
        }
        if ((event as TimeoutEvent).type === 'timeout') {
          // Session timeout
          return {
            type: 'transition',
            nextState: 'anonymous',
            data: { ...data, username: null, sessionToken: null },
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter(data) {
        console.log(`User ${data.username} authenticated`);
      },
    },

    locked: {
      handleEvent(event, data) {
        if ((event as TimeoutEvent).type === 'timeout') {
          // Unlock after timeout
          return {
            type: 'transition',
            nextState: 'anonymous',
            data: { ...data, loginAttempts: 0 },
          };
        }
        // Ignore all other events while locked
        return { type: 'keep_state_and_data' };
      },

      onEnter() {
        console.log('Account locked due to too many failed attempts');
      },
    },
  },
};

// Helper functions (stubs)
function validateCredentials(username: string, password: string): boolean {
  return username === 'admin' && password === 'secret';
}

function requires2FA(username: string): boolean {
  return username === 'admin';
}

function verify2FACode(username: string, code: string): boolean {
  return code === '123456';
}

function generateToken(): string {
  return `token_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
```

### Example 3: Traffic Light Controller

A classic state machine example with timed transitions:

```typescript
type LightState = 'green' | 'yellow' | 'red' | 'flashing';

type LightEvent =
  | { type: 'timer' }
  | { type: 'emergency' }
  | { type: 'resume' }
  | { type: 'manual'; state: LightState };

interface LightData {
  cycleCount: number;
  inEmergencyMode: boolean;
}

const trafficLightBehavior: StateMachineBehavior<LightState, LightEvent, LightData> = {
  init: () => ({
    state: 'red',
    data: { cycleCount: 0, inEmergencyMode: false },
    actions: [{ type: 'state_timeout', time: 5000 }], // Red for 5 seconds initially
  }),

  states: {
    green: {
      handleEvent(event, data) {
        if ((event as TimeoutEvent).type === 'timeout' || event.type === 'timer') {
          return {
            type: 'transition',
            nextState: 'yellow',
            data,
            actions: [{ type: 'state_timeout', time: 3000 }], // Yellow for 3s
          };
        }
        if (event.type === 'emergency') {
          return {
            type: 'transition',
            nextState: 'flashing',
            data: { ...data, inEmergencyMode: true },
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter() {
        console.log('🟢 GREEN - Go');
      },
    },

    yellow: {
      handleEvent(event, data) {
        if ((event as TimeoutEvent).type === 'timeout' || event.type === 'timer') {
          return {
            type: 'transition',
            nextState: 'red',
            data: { ...data, cycleCount: data.cycleCount + 1 },
            actions: [{ type: 'state_timeout', time: 5000 }], // Red for 5s
          };
        }
        if (event.type === 'emergency') {
          return {
            type: 'transition',
            nextState: 'flashing',
            data: { ...data, inEmergencyMode: true },
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter() {
        console.log('🟡 YELLOW - Caution');
      },
    },

    red: {
      handleEvent(event, data) {
        if ((event as TimeoutEvent).type === 'timeout' || event.type === 'timer') {
          return {
            type: 'transition',
            nextState: 'green',
            data,
            actions: [{ type: 'state_timeout', time: 10000 }], // Green for 10s
          };
        }
        if (event.type === 'emergency') {
          return {
            type: 'transition',
            nextState: 'flashing',
            data: { ...data, inEmergencyMode: true },
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter() {
        console.log('🔴 RED - Stop');
      },
    },

    flashing: {
      handleEvent(event, data) {
        if (event.type === 'resume') {
          return {
            type: 'transition',
            nextState: 'red',
            data: { ...data, inEmergencyMode: false },
            actions: [{ type: 'state_timeout', time: 5000 }],
          };
        }
        // Blink effect via event timeout
        if ((event as TimeoutEvent).type === 'timeout') {
          console.log('⚠️  FLASHING');
          return {
            type: 'keep_state_and_data',
            actions: [{ type: 'event_timeout', time: 500 }],
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter() {
        console.log('⚠️  EMERGENCY MODE - Flashing');
      },
    },
  },
};
```

## Anti-Patterns

### Don't Use GenStateMachine For:

1. **Simple counters or accumulators**
   ```typescript
   // BAD: Overkill for a counter
   states: {
     counting: { handleEvent: /* increment/decrement */ }
   }

   // GOOD: Just use GenServer
   handleCall(msg, state) {
     return [state.count + 1, { count: state.count + 1 }];
   }
   ```

2. **Pure request-response services**
   ```typescript
   // BAD: No meaningful states
   states: {
     ready: { handleEvent: /* always handles everything the same */ }
   }

   // GOOD: GenServer is simpler
   handleCall(msg, state) {
     return [computeResult(msg), state];
   }
   ```

3. **State that's really just "phases" of the same logic**
   ```typescript
   // BAD: Artificial states
   states: {
     phase1: { /* do step 1 then transition */ },
     phase2: { /* do step 2 then transition */ },
     phase3: { /* do step 3 then done */ },
   }

   // GOOD: Just sequential code
   async handleCall(msg, state) {
     await step1();
     await step2();
     await step3();
     return [result, state];
   }
   ```

## Summary

**GenStateMachine** is for processes with explicit, well-defined states where:
- Events have different meanings depending on the current state
- Transitions between states follow specific rules
- You need state entry/exit hooks
- You need sophisticated timeout management
- You want the code structure to mirror your state diagram

**GenServer** is for everything else — general-purpose processes where state is just data and all messages can be handled at any time.

The rule of thumb: **If you drew a state diagram to understand the problem, use GenStateMachine. If you drew a flowchart or sequence diagram, use GenServer.**

---

Next: [Defining States and Events](./02-defining-states.md)
