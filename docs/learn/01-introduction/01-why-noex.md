# Why noex?

Building robust, stateful Node.js applications is harder than it should be. If you've wrestled with race conditions, struggled to recover from crashes gracefully, or spent hours debugging shared state issues, you're not alone.

noex brings a proven solution to these problems: the actor model, battle-tested for over 40 years in Erlang/OTP systems that power everything from WhatsApp to telecommunications infrastructure.

## What You'll Learn

- Why traditional Node.js patterns fall short for stateful applications
- What makes the actor model fundamentally different
- How Erlang/OTP has proven these patterns at massive scale
- Why noex brings these concepts to TypeScript

## The Problems

### Shared State Leads to Chaos

Consider a typical Node.js pattern for managing user sessions:

```typescript
// Shared state - a recipe for problems
const sessions = new Map<string, UserSession>();

async function handleRequest(userId: string) {
  let session = sessions.get(userId);

  if (!session) {
    session = await loadFromDatabase(userId);
    sessions.set(userId, session);
  }

  // What if another request modifies session right now?
  session.lastAccess = Date.now();
  session.requestCount++;

  // By the time we save, the state may be inconsistent
  await saveToDatabase(session);
}
```

Multiple concurrent requests for the same user can interleave, leading to lost updates, inconsistent state, and subtle bugs that only appear under load.

### Race Conditions Are Everywhere

The event loop doesn't protect you from logical races:

```typescript
async function transferFunds(from: string, to: string, amount: number) {
  const fromAccount = await getAccount(from);
  const toAccount = await getAccount(to);

  // DANGER: Another transfer could modify these accounts
  // between our reads and writes

  if (fromAccount.balance >= amount) {
    fromAccount.balance -= amount;
    toAccount.balance += amount;

    await saveAccount(fromAccount);
    await saveAccount(toAccount);
  }
}
```

Every `await` is a potential interleaving point. Traditional solutions involve complex locking mechanisms that are error-prone and hurt performance.

### Error Handling Becomes Overwhelming

Real applications need to handle failures at every level:

```typescript
async function processOrder(order: Order) {
  try {
    const inventory = await checkInventory(order.items);
    try {
      const payment = await processPayment(order);
      try {
        await updateInventory(order.items);
        try {
          await sendConfirmation(order);
        } catch (emailError) {
          // Notification failed, but order succeeded - log and continue?
          // Or should we retry? How many times?
        }
      } catch (inventoryError) {
        // Need to refund payment
        await refundPayment(payment);
        throw inventoryError;
      }
    } catch (paymentError) {
      // Payment failed - release inventory reservation
      await releaseInventory(inventory);
      throw paymentError;
    }
  } catch (error) {
    // What state is the system in now?
    // Did we partially complete?
    // How do we recover?
  }
}
```

This pyramid of error handling is fragile. Missing a catch somewhere corrupts system state. And when an unhandled exception crashes the process, you lose everything in memory.

## The Solution: Actor Model

The actor model takes a radically different approach. Instead of shared state and complex error handling, it provides three simple principles:

### 1. Isolated State

Each actor (called a "process" in noex) owns its state exclusively. No other code can directly access or modify it:

```typescript
// Each counter is completely isolated
const counter = await GenServer.start({
  init: () => ({ count: 0 }),

  handleCall(msg, state) {
    if (msg.type === 'get') {
      return [state.count, state];
    }
    if (msg.type === 'increment') {
      const newState = { count: state.count + 1 };
      return [newState.count, newState];
    }
    return [null, state];
  },

  handleCast(msg, state) {
    return state;
  },
});
```

### 2. Message Passing

The only way to interact with an actor is through messages. Messages are processed one at a time, eliminating race conditions:

```typescript
// Synchronous call - waits for response
const count = await GenServer.call(counter, { type: 'get' });

// Asynchronous cast - fire and forget
GenServer.cast(counter, { type: 'log', message: 'Something happened' });
```

Because messages are processed sequentially, the transfer example becomes trivial:

```typescript
// All operations on an account are serialized - no races possible
const result = await GenServer.call(accountServer, {
  type: 'transfer',
  from: 'alice',
  to: 'bob',
  amount: 100,
});
```

### 3. Let It Crash

Instead of defensive error handling everywhere, actors embrace failure:

- If an actor crashes, it's automatically restarted by a supervisor
- The crashed actor loses only its in-memory state
- Other actors continue running unaffected
- The system self-heals without manual intervention

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    {
      id: 'payment-processor',
      start: () => GenServer.start(paymentBehavior),
      restart: 'permanent', // Always restart on crash
    },
    {
      id: 'email-service',
      start: () => GenServer.start(emailBehavior),
      restart: 'transient', // Only restart on errors, not normal exits
    },
  ],
});
```

## Traditional Node.js vs Actor Model

The following diagram illustrates the fundamental difference between traditional shared-state programming and the actor model:

```text
┌─────────────────────────────────────────┐  ┌─────────────────────────────────────────┐
│       TRADITIONAL NODE.JS               │  │           ACTOR MODEL (noex)            │
├─────────────────────────────────────────┤  ├─────────────────────────────────────────┤
│                                         │  │                                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
│  │Request 1│  │Request 2│  │Request 3│  │  │  │Request 1│  │Request 2│  │Request 3│  │
│  └────┬────┘  └────┬────┘  └────┬────┘  │  │  └────┬────┘  └────┬────┘  └────┬────┘  │
│       │            │            │       │  │       │            │            │       │
│       ▼            ▼            ▼       │  │       ▼            ▼            ▼       │
│  ┌──────────────────────────────────┐   │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
│  │                                  │   │  │  │ Process │  │ Process │  │ Process │  │
│  │         SHARED STATE            │   │  │  │    A    │  │    B    │  │    C    │  │
│  │     ┌─────────────────┐         │   │  │  │ ┌─────┐ │  │ ┌─────┐ │  │ ┌─────┐ │  │
│  │     │   users: Map    │ ◄───────┼───│  │  │ │state│ │  │ │state│ │  │ │state│ │  │
│  │     │   sessions: {}  │         │   │  │  │ └─────┘ │  │ └─────┘ │  │ └─────┘ │  │
│  │     │   orders: []    │         │   │  │  │ private │  │ private │  │ private │  │
│  │     └─────────────────┘         │   │  │  └────┬────┘  └────┬────┘  └────┬────┘  │
│  │                                  │   │  │       │            │            │       │
│  └──────────────────────────────────┘   │  │       └──────┬─────┴────────────┘       │
│                                         │  │              │                          │
│  Problems:                              │  │              ▼                          │
│  ✗ Race conditions at every await       │  │     ┌────────────────┐                  │
│  ✗ State corrupted by concurrent access │  │     │   MESSAGES     │                  │
│  ✗ Crashes lose all in-memory data      │  │     │  (call/cast)   │                  │
│  ✗ Complex error handling everywhere    │  │     └────────────────┘                  │
│                                         │  │                                         │
│                                         │  │  Benefits:                              │
│  ┌──────────────────────────────────┐   │  │  ✓ No race conditions (sequential msgs) │
│  │          ERROR HANDLING          │   │  │  ✓ Isolated state (no shared memory)   │
│  │  try {                           │   │  │  ✓ Crash = restart with clean state    │
│  │    try {                         │   │  │  ✓ Simple code (let it crash)          │
│  │      try {                       │   │  │                                         │
│  │        // pyramid of doom        │   │  │  ┌──────────────────────────────────┐   │
│  │      } catch...                  │   │  │  │         SUPERVISOR               │   │
│  │    } catch...                    │   │  │  │  ┌───┐   ┌───┐   ┌───┐          │   │
│  │  } catch...                      │   │  │  │  │ A │   │ B │   │ C │ ◄─ auto  │   │
│  └──────────────────────────────────┘   │  │  │  └───┘   └───┘   └───┘   restart│   │
│                                         │  │  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘  └─────────────────────────────────────────┘
```

**Key insight**: In the actor model, each process owns its state exclusively. Communication happens only through messages, which are processed one at a time. This eliminates entire categories of bugs.

## Erlang/OTP: 40 Years of Battle-Testing

These patterns aren't theoretical. They come from Erlang, a language designed in the 1980s for telecommunications systems that required:

- **99.9999999% uptime** (nine nines - less than 32 milliseconds of downtime per year)
- **Hot code upgrades** without dropping calls
- **Handling millions of concurrent connections**

Today, Erlang and its patterns power:

- **WhatsApp**: 2 billion users, 100+ billion messages daily, ~50 engineers
- **Discord**: Millions of concurrent voice/chat users
- **Ericsson**: 40%+ of global telecom traffic
- **RabbitMQ, CouchDB, Riak**: Industry-standard distributed systems

The actor model isn't just elegant - it's proven at scales that would crush traditional architectures.

## noex = OTP for TypeScript

noex brings these battle-tested patterns to the TypeScript ecosystem:

| Erlang/OTP | noex |
|------------|------|
| `gen_server` | `GenServer` |
| `supervisor` | `Supervisor` |
| `gen_statem` | `GenStateMachine` |
| ETS tables | `ETS` |
| `application` | `Application` |
| Registry | `Registry` |

You get the reliability of Erlang patterns with the developer experience of TypeScript:

- Full type safety for messages and state
- Familiar async/await syntax
- Works with your existing Node.js ecosystem
- No new runtime or language to learn

```typescript
import { GenServer, Supervisor, type GenServerBehavior } from 'noex';

interface State {
  users: Map<string, User>;
}

type CallMsg =
  | { type: 'get'; id: string }
  | { type: 'create'; user: User };

type CastMsg = { type: 'log'; message: string };
type Reply = User | null;

const userServiceBehavior: GenServerBehavior<State, CallMsg, CastMsg, Reply> = {
  init: () => ({ users: new Map() }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.users.get(msg.id) ?? null, state];
      case 'create':
        state.users.set(msg.user.id, msg.user);
        return [msg.user, state];
    }
  },

  handleCast(msg, state) {
    console.log(`[UserService] ${msg.message}`);
    return state;
  },
};

// Start with supervision
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'users', start: () => GenServer.start(userServiceBehavior) },
  ],
});
```

## Summary

- Traditional Node.js patterns struggle with shared state, race conditions, and error handling
- The actor model solves these problems through isolated state, message passing, and the "let it crash" philosophy
- Erlang/OTP has proven these patterns at massive scale for 40+ years
- noex brings OTP patterns to TypeScript with full type safety and familiar syntax

The result: applications that are simpler to reason about, easier to debug, and resilient by design.

---

Next: [Key Concepts](./02-key-concepts.md)
