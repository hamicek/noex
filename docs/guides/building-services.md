# Building Services with GenServer

This guide explains how to build robust, well-structured services using the GenServer pattern in noex.

## Overview

A GenServer (Generic Server) is the fundamental building block for stateful services in noex. It provides:

- **Isolated State**: Each server instance maintains its own state
- **Message-Based Communication**: All interactions happen through messages
- **Sequential Processing**: Messages are processed one at a time
- **Lifecycle Management**: Clean startup and shutdown handling

## Basic Structure

Every GenServer service follows this structure:

```typescript
import { GenServer, type GenServerBehavior, type GenServerRef } from 'noex';

// 1. Define state type
interface MyServiceState {
  // Your state fields
}

// 2. Define message types
type MyServiceCall = /* call messages */;
type MyServiceCast = /* cast messages */;
type MyServiceReply = /* reply types */;

// 3. Define reference type
type MyServiceRef = GenServerRef<
  MyServiceState,
  MyServiceCall,
  MyServiceCast,
  MyServiceReply
>;

// 4. Implement behavior
const myServiceBehavior: GenServerBehavior<
  MyServiceState,
  MyServiceCall,
  MyServiceCast,
  MyServiceReply
> = {
  init: () => { /* return initial state */ },
  handleCall: (msg, state) => { /* handle calls */ },
  handleCast: (msg, state) => { /* handle casts */ },
  terminate: (reason, state) => { /* cleanup */ },
};

// 5. Export public API
export const MyService = {
  async start(): Promise<MyServiceRef> {
    return GenServer.start(myServiceBehavior);
  },
  // ... other methods
};
```

---

## Step 1: Design Your State

Start by defining what state your service needs to maintain:

```typescript
interface UserServiceState {
  users: Map<string, User>;
  lastActivity: Date;
  config: {
    maxUsers: number;
    sessionTimeout: number;
  };
}
```

**Best Practices:**
- Use immutable patterns (spread, new Map/Set)
- Keep state minimal and focused
- Avoid storing derived data that can be computed

---

## Step 2: Define Message Types

Use discriminated unions for type-safe message handling:

```typescript
// Synchronous messages (caller waits for response)
type UserServiceCall =
  | { type: 'get_user'; id: string }
  | { type: 'list_users' }
  | { type: 'get_count' };

// Asynchronous messages (fire-and-forget)
type UserServiceCast =
  | { type: 'create_user'; user: User }
  | { type: 'delete_user'; id: string }
  | { type: 'update_config'; config: Partial<Config> };

// Reply types
type UserServiceReply = User | User[] | number | null;
```

**Guidelines:**
- Use `call` for operations that need a response
- Use `cast` for fire-and-forget operations
- Keep message types simple and focused

---

## Step 3: Implement the Behavior

### init()

Initialize your state when the server starts:

```typescript
init: () => ({
  users: new Map(),
  lastActivity: new Date(),
  config: {
    maxUsers: 1000,
    sessionTimeout: 3600000,
  },
}),

// Async initialization
init: async () => {
  const config = await loadConfig();
  const users = await loadFromDatabase();
  return { users, config, lastActivity: new Date() };
},
```

### handleCall()

Handle synchronous requests and return `[reply, newState]`:

```typescript
handleCall: (msg, state) => {
  switch (msg.type) {
    case 'get_user': {
      const user = state.users.get(msg.id) ?? null;
      return [user, state];
    }

    case 'list_users': {
      const users = Array.from(state.users.values());
      return [users, state];
    }

    case 'get_count': {
      return [state.users.size, state];
    }
  }
},
```

### handleCast()

Handle asynchronous messages and return the new state:

```typescript
handleCast: (msg, state) => {
  switch (msg.type) {
    case 'create_user': {
      const newUsers = new Map(state.users);
      newUsers.set(msg.user.id, msg.user);
      return {
        ...state,
        users: newUsers,
        lastActivity: new Date(),
      };
    }

    case 'delete_user': {
      const newUsers = new Map(state.users);
      newUsers.delete(msg.id);
      return { ...state, users: newUsers };
    }

    case 'update_config': {
      return {
        ...state,
        config: { ...state.config, ...msg.config },
      };
    }
  }
},
```

### terminate()

Clean up resources when the server stops:

```typescript
terminate: async (reason, state) => {
  // Save state to database
  await saveToDatabase(state.users);

  // Close connections
  if (state.dbConnection) {
    await state.dbConnection.close();
  }

  // Log shutdown
  console.log(`UserService terminated: ${reason}`);
},
```

---

## Step 4: Create the Public API

Wrap GenServer calls in a clean public interface:

```typescript
export const UserService = {
  async start(options: UserServiceOptions = {}): Promise<UserServiceRef> {
    const behavior = createUserServiceBehavior(options);
    return GenServer.start(behavior, { name: options.name });
  },

  async getUser(ref: UserServiceRef, id: string): Promise<User | null> {
    return GenServer.call(ref, { type: 'get_user', id }) as Promise<User | null>;
  },

  async listUsers(ref: UserServiceRef): Promise<User[]> {
    return GenServer.call(ref, { type: 'list_users' }) as Promise<User[]>;
  },

  async getCount(ref: UserServiceRef): Promise<number> {
    return GenServer.call(ref, { type: 'get_count' }) as Promise<number>;
  },

  createUser(ref: UserServiceRef, user: User): void {
    GenServer.cast(ref, { type: 'create_user', user });
  },

  deleteUser(ref: UserServiceRef, id: string): void {
    GenServer.cast(ref, { type: 'delete_user', id });
  },

  async stop(ref: UserServiceRef): Promise<void> {
    await GenServer.stop(ref);
  },
} as const;
```

---

## Complete Example: Counter Service

```typescript
import { GenServer, type GenServerBehavior, type GenServerRef } from 'noex';

// Types
interface CounterState {
  value: number;
  history: number[];
  maxHistory: number;
}

type CounterCall =
  | { type: 'get' }
  | { type: 'get_history' };

type CounterCast =
  | { type: 'increment'; by?: number }
  | { type: 'decrement'; by?: number }
  | { type: 'reset' };

type CounterReply = number | number[];

type CounterRef = GenServerRef<CounterState, CounterCall, CounterCast, CounterReply>;

// Behavior
const counterBehavior: GenServerBehavior<
  CounterState,
  CounterCall,
  CounterCast,
  CounterReply
> = {
  init: () => ({
    value: 0,
    history: [],
    maxHistory: 100,
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.value, state];
      case 'get_history':
        return [state.history, state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'increment': {
        const by = msg.by ?? 1;
        const value = state.value + by;
        const history = [...state.history, value].slice(-state.maxHistory);
        return { ...state, value, history };
      }

      case 'decrement': {
        const by = msg.by ?? 1;
        const value = state.value - by;
        const history = [...state.history, value].slice(-state.maxHistory);
        return { ...state, value, history };
      }

      case 'reset':
        return { ...state, value: 0, history: [] };
    }
  },

  terminate: (reason, state) => {
    console.log(`Counter terminated with value ${state.value}`);
  },
};

// Public API
export const Counter = {
  async start(name?: string): Promise<CounterRef> {
    return GenServer.start(counterBehavior, name ? { name } : {});
  },

  async get(ref: CounterRef): Promise<number> {
    return GenServer.call(ref, { type: 'get' }) as Promise<number>;
  },

  async getHistory(ref: CounterRef): Promise<number[]> {
    return GenServer.call(ref, { type: 'get_history' }) as Promise<number[]>;
  },

  increment(ref: CounterRef, by?: number): void {
    GenServer.cast(ref, { type: 'increment', by });
  },

  decrement(ref: CounterRef, by?: number): void {
    GenServer.cast(ref, { type: 'decrement', by });
  },

  reset(ref: CounterRef): void {
    GenServer.cast(ref, { type: 'reset' });
  },

  async stop(ref: CounterRef): Promise<void> {
    await GenServer.stop(ref);
  },
} as const;

// Usage
async function main() {
  const counter = await Counter.start('my-counter');

  Counter.increment(counter);
  Counter.increment(counter, 5);
  Counter.decrement(counter, 2);

  console.log(await Counter.get(counter));        // 4
  console.log(await Counter.getHistory(counter)); // [1, 6, 4]

  await Counter.stop(counter);
}
```

---

## Communication Between Services

Services can communicate with each other by passing references:

```typescript
interface OrderServiceState {
  orders: Map<string, Order>;
  userServiceRef: UserServiceRef | null;
}

type OrderServiceCast =
  | { type: 'set_user_service'; ref: UserServiceRef }
  | { type: 'create_order'; userId: string; items: string[] };

handleCast: async (msg, state) => {
  switch (msg.type) {
    case 'set_user_service':
      return { ...state, userServiceRef: msg.ref };

    case 'create_order': {
      // Call another service
      if (state.userServiceRef) {
        const user = await GenServer.call(state.userServiceRef, {
          type: 'get_user',
          id: msg.userId,
        });

        if (user) {
          // Create order...
        }
      }
      return state;
    }
  }
},
```

---

## Best Practices

1. **Keep State Immutable**: Always return new state objects
2. **Use Typed Messages**: Leverage TypeScript for type safety
3. **Handle All Cases**: Use exhaustive switch statements
4. **Separate Concerns**: One service, one responsibility
5. **Clean Public API**: Hide GenServer internals
6. **Graceful Shutdown**: Always implement `terminate`
7. **Error Handling**: Let errors crash; supervisor will restart

---

## Related

- [GenServer Concepts](../concepts/genserver.md) - Understanding GenServer
- [Supervision Trees Guide](./supervision-trees.md) - Organizing services
- [Inter-Process Communication Guide](./inter-process-communication.md) - Service communication
- [GenServer API Reference](../api/genserver.md) - Full API documentation
