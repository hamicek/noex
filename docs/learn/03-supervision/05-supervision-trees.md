# Supervision Trees

So far, you've learned how a single supervisor manages its children. But real applications need more than one supervisor. **Supervision trees** are hierarchies of supervisors, where supervisors can be children of other supervisors. This creates a tree structure that gives you fine-grained control over failure isolation and recovery.

## What You'll Learn

- Why flat supervision is limiting
- Building hierarchies of supervisors
- Isolating failure domains
- Designing supervision trees for real applications
- Practical examples with e-commerce and chat systems

## The Limitation of Flat Supervision

Imagine an e-commerce application with these services:

- UserService, SessionService (user domain)
- ProductService, InventoryService (catalog domain)
- CartService, CheckoutService, PaymentService (order domain)

With a single flat supervisor:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         FLAT SUPERVISION (Limited)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                              ┌─────────────┐                                │
│                              │  Supervisor │                                │
│                              └──────┬──────┘                                │
│            ┌───────┬───────┬───────┼───────┬───────┬───────┐               │
│            ▼       ▼       ▼       ▼       ▼       ▼       ▼               │
│         ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐           │
│         │User │ │Sess │ │Prod │ │Inv  │ │Cart │ │Check│ │Pay  │           │
│         └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘           │
│                                                                             │
│  Problems:                                                                  │
│  • All services share the same restart intensity limits                     │
│  • Can't use different strategies for different domains                     │
│  • A bug in CartService could exhaust restarts for PaymentService           │
│  • No isolation between unrelated failure domains                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

The problem: If `CartService` has a bug that causes rapid crashes, it can exhaust the supervisor's restart intensity limit. This brings down the **entire application**, including completely unrelated services like `UserService`.

## Supervision Trees: Hierarchical Organization

The solution is to organize supervisors into a tree:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SUPERVISION TREE (Isolated)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                              ┌─────────────┐                                │
│                              │    Root     │ strategy: one_for_one          │
│                              │  Supervisor │                                │
│                              └──────┬──────┘                                │
│              ┌──────────────────────┼──────────────────────┐               │
│              ▼                      ▼                      ▼               │
│       ┌─────────────┐        ┌─────────────┐        ┌─────────────┐        │
│       │    User     │        │   Catalog   │        │    Order    │        │
│       │  Supervisor │        │  Supervisor │        │  Supervisor │        │
│       └──────┬──────┘        └──────┬──────┘        └──────┬──────┘        │
│         ┌────┴────┐             ┌───┴───┐           ┌──────┼──────┐        │
│         ▼         ▼             ▼       ▼           ▼      ▼      ▼        │
│      ┌─────┐  ┌─────┐       ┌─────┐ ┌─────┐     ┌─────┐┌─────┐┌─────┐     │
│      │User │  │Sess │       │Prod │ │Inv  │     │Cart ││Check││Pay  │     │
│      └─────┘  └─────┘       └─────┘ └─────┘     └─────┘└─────┘└─────┘     │
│                                                                             │
│  Benefits:                                                                  │
│  • Each domain has its own restart intensity limits                         │
│  • Different strategies per domain (user: one_for_one, order: rest_for_one) │
│  • CartService crashes only affect OrderSupervisor                          │
│  • UserSupervisor and CatalogSupervisor continue running normally           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Now `CartService` crashes only exhaust `OrderSupervisor`'s restart limits. Even if the entire Order domain goes down, Users can still log in and browse Products.

## Failure Domain Isolation

A **failure domain** is a boundary within which failures are contained. Supervision trees let you define these boundaries explicitly.

### Principles of Failure Domain Design

1. **Group related processes together** - Services that depend on each other should share a supervisor
2. **Separate unrelated domains** - Independent subsystems should have separate supervisors
3. **Critical vs non-critical** - Put critical services under more conservative supervisors
4. **Match strategy to dependencies** - Use `rest_for_one` for sequential dependencies, `one_for_all` for shared state

### What Happens When a Supervisor Fails?

When a supervisor exceeds its restart intensity and fails:

1. The failing supervisor becomes a terminated child of its parent
2. The parent supervisor applies its restart strategy to the failed supervisor
3. If the parent restarts the supervisor, all grandchildren start fresh

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CASCADING FAILURE RECOVERY                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Step 1: CartService keeps crashing                                         │
│                                                                             │
│         ┌─────────────┐                                                     │
│         │    Order    │  restartIntensity: { maxRestarts: 3, withinMs: 5000 }
│         │  Supervisor │                                                     │
│         └──────┬──────┘                                                     │
│           ┌────┼────┐                                                       │
│           ▼    ▼    ▼                                                       │
│        ┌────┐ 💥  ┌────┐   CartService: crash, restart, crash, restart...  │
│        │Cart│     │Pay │                                                    │
│        └────┘     └────┘                                                    │
│                                                                             │
│  Step 2: OrderSupervisor exceeds restart limit → throws error               │
│                                                                             │
│         💥 ─────────────                                                    │
│         │    Order    │  MaxRestartsExceededError!                          │
│         │  Supervisor │                                                     │
│         └─────────────┘                                                     │
│                                                                             │
│  Step 3: Root supervisor sees OrderSupervisor as crashed child              │
│          Applies one_for_one: restart only OrderSupervisor                  │
│                                                                             │
│         ┌─────────────┐                                                     │
│         │    Root     │  Restarts OrderSupervisor                           │
│         │  Supervisor │                                                     │
│         └──────┬──────┘                                                     │
│           ┌────┴────┐                                                       │
│         ┌────┐   ┌─────┐                                                    │
│         │User│   │Order│ ← Fresh start with reset restart counters         │
│         │Sup │   │Sup' │                                                    │
│         └────┘   └─────┘                                                    │
│                                                                             │
│  Result: User domain unaffected, Order domain gets fresh restart            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Building a Supervision Tree in Code

Here's how to implement a multi-level supervision tree:

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from '@hamicek/noex';

// Simple service behavior factory
const createServiceBehavior = (name: string): GenServerBehavior<{ name: string }, { type: 'ping' }, never, string> => ({
  init() {
    console.log(`[${name}] Started`);
    return { name };
  },
  handleCall(msg, state) {
    if (msg.type === 'ping') {
      return [`pong from ${state.name}`, state];
    }
    return ['', state];
  },
  handleCast: (_, state) => state,
  terminate() {
    console.log(`[${this.name}] Terminated`);
  },
});

async function buildEcommerceTree() {
  // Level 2: Domain supervisors (leaves of the tree)

  // User domain - independent services
  const userSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 5, withinMs: 10000 },
    children: [
      { id: 'user-service', start: () => GenServer.start(createServiceBehavior('UserService')) },
      { id: 'session-service', start: () => GenServer.start(createServiceBehavior('SessionService')) },
    ],
  });

  // Catalog domain - independent services
  const catalogSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 5, withinMs: 10000 },
    children: [
      { id: 'product-service', start: () => GenServer.start(createServiceBehavior('ProductService')) },
      { id: 'inventory-service', start: () => GenServer.start(createServiceBehavior('InventoryService')) },
    ],
  });

  // Order domain - sequential dependencies (Cart → Checkout → Payment)
  const orderSupervisor = await Supervisor.start({
    strategy: 'rest_for_one', // If Cart fails, restart Checkout and Payment too
    restartIntensity: { maxRestarts: 3, withinMs: 5000 }, // Stricter for critical path
    children: [
      { id: 'cart-service', start: () => GenServer.start(createServiceBehavior('CartService')) },
      { id: 'checkout-service', start: () => GenServer.start(createServiceBehavior('CheckoutService')) },
      { id: 'payment-service', start: () => GenServer.start(createServiceBehavior('PaymentService')) },
    ],
  });

  // Level 1: Root supervisor
  // Wraps domain supervisors in GenServer adapters (supervisors aren't directly children)
  const rootSupervisor = await Supervisor.start({
    strategy: 'one_for_one', // Domains are independent
    restartIntensity: { maxRestarts: 10, withinMs: 60000 }, // Very tolerant at root
    children: [
      {
        id: 'user-domain',
        start: () => createSupervisorWrapper('UserDomain', userSupervisor),
      },
      {
        id: 'catalog-domain',
        start: () => createSupervisorWrapper('CatalogDomain', catalogSupervisor),
      },
      {
        id: 'order-domain',
        start: () => createSupervisorWrapper('OrderDomain', orderSupervisor),
      },
    ],
  });

  console.log('\nE-commerce supervision tree started:');
  console.log('├── UserDomain (one_for_one)');
  console.log('│   ├── UserService');
  console.log('│   └── SessionService');
  console.log('├── CatalogDomain (one_for_one)');
  console.log('│   ├── ProductService');
  console.log('│   └── InventoryService');
  console.log('└── OrderDomain (rest_for_one)');
  console.log('    ├── CartService');
  console.log('    ├── CheckoutService');
  console.log('    └── PaymentService');

  return rootSupervisor;
}

// Helper: Wraps a supervisor in a GenServer for the parent supervisor
function createSupervisorWrapper(name: string, childSupervisor: Awaited<ReturnType<typeof Supervisor.start>>) {
  return GenServer.start<{ supervisor: typeof childSupervisor }, { type: 'getSupervisor' }, never, typeof childSupervisor>({
    init() {
      return { supervisor: childSupervisor };
    },
    handleCall(msg, state) {
      if (msg.type === 'getSupervisor') {
        return [state.supervisor, state];
      }
      return [state.supervisor, state];
    },
    handleCast: (_, state) => state,
    async terminate() {
      // When wrapper terminates, stop the child supervisor
      await Supervisor.stop(childSupervisor);
      console.log(`[${name}] Domain supervisor stopped`);
    },
  });
}

async function main() {
  const root = await buildEcommerceTree();

  // Let it run briefly
  await new Promise(resolve => setTimeout(resolve, 100));

  // Graceful shutdown - stops all domains
  await Supervisor.stop(root);
  console.log('\nAll services stopped gracefully');
}

main();
```

## Practical Example: Chat Application

Let's design a supervision tree for a chat application with:
- User connections (WebSocket handlers)
- Chat rooms
- Message persistence
- Push notifications

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CHAT APPLICATION SUPERVISION TREE                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                              ┌─────────────┐                                │
│                              │    Root     │ one_for_one                    │
│                              │  Supervisor │ 10 restarts / 60s              │
│                              └──────┬──────┘                                │
│              ┌──────────────────────┼──────────────────────┐               │
│              ▼                      ▼                      ▼               │
│       ┌─────────────┐        ┌─────────────┐        ┌─────────────┐        │
│       │ Connection  │        │    Room     │        │   Backend   │        │
│       │  Supervisor │        │  Supervisor │        │  Supervisor │        │
│       │simple_one_  │        │simple_one_  │        │ rest_for_one│        │
│       │  for_one    │        │  for_one    │        │             │        │
│       └──────┬──────┘        └──────┬──────┘        └──────┬──────┘        │
│         ┌────┼────┐             ┌───┴───┐              ┌───┴───┐           │
│         ▼    ▼    ▼             ▼       ▼              ▼       ▼           │
│      ┌────┐┌────┐┌────┐     ┌─────┐ ┌─────┐       ┌─────┐ ┌─────┐         │
│      │WS1 ││WS2 ││WS3 │     │Room1│ │Room2│       │ DB  │ │Push │         │
│      └────┘└────┘└────┘     └─────┘ └─────┘       │Svc  │ │Svc  │         │
│       (dynamic)              (dynamic)            └─────┘ └─────┘         │
│                                                                             │
│  Design Decisions:                                                          │
│                                                                             │
│  ConnectionSupervisor: simple_one_for_one                                   │
│  • Dynamic children (one per WebSocket)                                     │
│  • High restart tolerance (connections are transient)                       │
│  • Each connection isolated                                                 │
│                                                                             │
│  RoomSupervisor: simple_one_for_one                                         │
│  • Dynamic children (rooms created on demand)                               │
│  • Moderate restart tolerance                                               │
│  • Room crash doesn't affect other rooms                                    │
│                                                                             │
│  BackendSupervisor: rest_for_one                                            │
│  • Static children with dependencies                                        │
│  • PushService depends on DBService (for user tokens)                       │
│  • Lower restart tolerance (critical services)                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Implementation

```typescript
import { Supervisor, GenServer, type GenServerBehavior, type ChildTemplate } from '@hamicek/noex';

// Connection handler for each WebSocket
interface ConnectionState {
  connectionId: string;
  userId: string;
}

type ConnectionCall = { type: 'send'; message: string } | { type: 'getUser' };
type ConnectionCast = { type: 'received'; message: string };

// Factory function that creates a behavior with captured state
const createConnectionBehavior = (
  connectionId: string,
  userId: string
): GenServerBehavior<ConnectionState, ConnectionCall, ConnectionCast, string> => ({
  init() {
    console.log(`[Connection ${connectionId}] User ${userId} connected`);
    return { connectionId, userId };
  },
  handleCall(msg, state) {
    if (msg.type === 'send') {
      console.log(`[Connection ${state.connectionId}] Sending: ${msg.message}`);
      return ['sent', state];
    }
    if (msg.type === 'getUser') {
      return [state.userId, state];
    }
    return ['', state];
  },
  handleCast(msg, state) {
    if (msg.type === 'received') {
      console.log(`[Connection ${state.connectionId}] Received: ${msg.message}`);
    }
    return state;
  },
  terminate() {
    console.log(`[Connection] Disconnected`);
  },
});

// Chat room
interface RoomState {
  roomId: string;
  members: Set<string>;
}

type RoomCall = { type: 'join'; userId: string } | { type: 'leave'; userId: string } | { type: 'getMembers' };
type RoomCast = { type: 'broadcast'; message: string; from: string };

// Factory function that creates a room behavior with captured roomId
const createRoomBehavior = (roomId: string): GenServerBehavior<RoomState, RoomCall, RoomCast, string[] | boolean> => ({
  init() {
    console.log(`[Room ${roomId}] Created`);
    return { roomId, members: new Set() };
  },
  handleCall(msg, state) {
    if (msg.type === 'join') {
      state.members.add(msg.userId);
      console.log(`[Room ${state.roomId}] ${msg.userId} joined (${state.members.size} members)`);
      return [true, state];
    }
    if (msg.type === 'leave') {
      state.members.delete(msg.userId);
      console.log(`[Room ${state.roomId}] ${msg.userId} left (${state.members.size} members)`);
      return [true, state];
    }
    if (msg.type === 'getMembers') {
      return [Array.from(state.members), state];
    }
    return [[], state];
  },
  handleCast(msg, state) {
    if (msg.type === 'broadcast') {
      console.log(`[Room ${state.roomId}] ${msg.from}: ${msg.message}`);
      // In real app, would send to all member connections
    }
    return state;
  },
  terminate() {
    console.log(`[Room] Closed`);
  },
});

// Backend services
const createBackendService = (name: string): GenServerBehavior<{ name: string }, { type: 'health' }, never, string> => ({
  init() {
    console.log(`[${name}] Started`);
    return { name };
  },
  handleCall(msg, state) {
    if (msg.type === 'health') {
      return ['healthy', state];
    }
    return ['', state];
  },
  handleCast: (_, state) => state,
  terminate() {
    console.log(`[${this.name}] Stopped`);
  },
});

async function buildChatTree() {
  // Connection supervisor - dynamic children via simple_one_for_one
  const connectionSupervisor = await Supervisor.start({
    strategy: 'simple_one_for_one',
    restartIntensity: { maxRestarts: 100, withinMs: 60000 }, // Very tolerant
    childTemplate: {
      start: (connectionId: string, userId: string) =>
        GenServer.start(createConnectionBehavior(connectionId, userId)),
      restart: 'transient', // Don't restart if user disconnects normally
    },
  });

  // Room supervisor - dynamic children via simple_one_for_one
  const roomSupervisor = await Supervisor.start({
    strategy: 'simple_one_for_one',
    restartIntensity: { maxRestarts: 20, withinMs: 60000 },
    childTemplate: {
      start: (roomId: string) => GenServer.start(createRoomBehavior(roomId)),
      restart: 'permanent',
    },
  });

  // Backend supervisor - static children with dependencies
  const backendSupervisor = await Supervisor.start({
    strategy: 'rest_for_one', // PushService depends on DBService
    restartIntensity: { maxRestarts: 5, withinMs: 30000 },
    children: [
      { id: 'db-service', start: () => GenServer.start(createBackendService('DBService')) },
      { id: 'push-service', start: () => GenServer.start(createBackendService('PushService')) },
    ],
  });

  // Root supervisor
  const rootSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 10, withinMs: 60000 },
    children: [
      {
        id: 'connections',
        start: () => createSupervisorWrapper('Connections', connectionSupervisor),
      },
      {
        id: 'rooms',
        start: () => createSupervisorWrapper('Rooms', roomSupervisor),
      },
      {
        id: 'backend',
        start: () => createSupervisorWrapper('Backend', backendSupervisor),
      },
    ],
  });

  // Simulate some connections and rooms
  await Supervisor.startChild(connectionSupervisor, ['ws_1', 'alice']);
  await Supervisor.startChild(connectionSupervisor, ['ws_2', 'bob']);
  await Supervisor.startChild(roomSupervisor, ['general']);
  await Supervisor.startChild(roomSupervisor, ['random']);

  return { rootSupervisor, connectionSupervisor, roomSupervisor, backendSupervisor };
}

// Helper function (same as before)
function createSupervisorWrapper(name: string, childSupervisor: Awaited<ReturnType<typeof Supervisor.start>>) {
  return GenServer.start({
    init: () => ({ supervisor: childSupervisor }),
    handleCall: (_, state) => [state.supervisor, state],
    handleCast: (_, state) => state,
    async terminate() {
      await Supervisor.stop(childSupervisor);
    },
  });
}

async function main() {
  const { rootSupervisor } = await buildChatTree();

  console.log('\nChat supervision tree running...');
  await new Promise(resolve => setTimeout(resolve, 100));

  await Supervisor.stop(rootSupervisor);
  console.log('\nChat server stopped');
}

main();
```

## Design Guidelines for Supervision Trees

### 1. Depth of Tree

| Depth | Use Case |
|-------|----------|
| 1 level | Small applications, microservices |
| 2 levels | Medium applications with distinct domains |
| 3+ levels | Large applications with complex hierarchies |

Don't over-engineer - start simple and add depth as needed.

### 2. Choosing Strategies at Each Level

| Level | Typical Strategy | Reasoning |
|-------|------------------|-----------|
| Root | `one_for_one` | Domains are usually independent |
| Domain | Varies | Depends on service relationships |
| Leaf | `one_for_one` or `simple_one_for_one` | Individual workers |

### 3. Restart Intensity Guidelines

| Level | Typical Settings | Reasoning |
|-------|------------------|-----------|
| Root | High tolerance (10+ restarts / 60s) | Avoid total system failure |
| Domain | Moderate (5-10 restarts / 30s) | Allow recovery, but detect persistent issues |
| Leaf | Depends on service criticality | Match to service characteristics |

### 4. Common Patterns

**Worker Pool Pattern:**
```
Supervisor (simple_one_for_one)
├── Worker 1
├── Worker 2
└── Worker N (dynamic)
```

**Pipeline Pattern:**
```
Supervisor (rest_for_one)
├── Stage 1 (Source)
├── Stage 2 (Transform)
└── Stage 3 (Sink)
```

**Hub and Spoke Pattern:**
```
Supervisor (one_for_all)
├── Hub (coordinator)
├── Spoke 1 (depends on hub)
├── Spoke 2 (depends on hub)
└── Spoke 3 (depends on hub)
```

## Exercise

Design a supervision tree for a real-time multiplayer game server with:

1. **Player connections** - One process per connected player
2. **Game lobbies** - Dynamic lobbies where players wait for matches
3. **Game instances** - Active games with multiple players
4. **Matchmaking service** - Pairs players into games
5. **Leaderboard service** - Tracks scores (depends on a database service)
6. **Database service** - Persists game data

Requirements:
- Player disconnects shouldn't affect other players
- A crashing game shouldn't affect lobbies
- Matchmaking and Leaderboard are independent but both need the database
- If the database crashes, both Matchmaking and Leaderboard should restart

Draw the supervision tree and explain your choices.

<details>
<summary>Solution</summary>

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    GAME SERVER SUPERVISION TREE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                              ┌─────────────┐                                │
│                              │    Root     │ one_for_one                    │
│                              │  Supervisor │ 10 restarts / 60s              │
│                              └──────┬──────┘                                │
│       ┌──────────────┬──────────────┼──────────────┬─────────────┐         │
│       ▼              ▼              ▼              ▼             ▼         │
│ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐     │
│ │  Player   │ │  Lobby    │ │   Game    │ │  Backend  │ │ Database  │     │
│ │Supervisor │ │Supervisor │ │Supervisor │ │Supervisor │ │ Wrapper   │     │
│ │simple_1_1 │ │simple_1_1 │ │simple_1_1 │ │one_for_all│ │           │     │
│ └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └───────────┘     │
│   ┌───┴───┐     ┌───┴───┐     ┌───┴───┐     ┌───┴───┐                     │
│   ▼   ▼   ▼     ▼   ▼   ▼     ▼   ▼   ▼     ▼       ▼                     │
│ ┌───┐───┐───┐ ┌───┐───┐───┐ ┌───┐───┐───┐ ┌─────┐┌─────┐                  │
│ │P1 │P2 │...│ │L1 │L2 │...│ │G1 │G2 │...│ │Match││Lead │                  │
│ └───┘───┘───┘ └───┘───┘───┘ └───┘───┘───┘ │make ││board│                  │
│  (dynamic)     (dynamic)     (dynamic)    └─────┘└─────┘                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Design Decisions:**

1. **PlayerSupervisor (simple_one_for_one)**
   - Dynamic children for each connected player
   - High restart tolerance - connections are transient
   - `transient` restart strategy - don't restart on normal disconnect

2. **LobbySupervisor (simple_one_for_one)**
   - Dynamic lobbies created on demand
   - Moderate restart tolerance
   - Lobby crash doesn't affect games in progress

3. **GameSupervisor (simple_one_for_one)**
   - Dynamic game instances
   - Each game is isolated
   - Game crash only affects players in that game

4. **BackendSupervisor (one_for_all)**
   - Contains Matchmaking and Leaderboard
   - Both depend on Database via lookup
   - If either fails, both restart to resync state

5. **Database as separate child of Root**
   - Independent of Backend supervisor
   - If DB crashes, Backend sees it through Registry lookup failure
   - Backend services can handle DB unavailability gracefully

**Alternative: If DB crash MUST restart Backend:**

```
BackendSupervisor (rest_for_one)
├── DatabaseService
├── MatchmakingService
└── LeaderboardService
```

This ensures DB crash restarts both services that depend on it.

**Implementation sketch:**

```typescript
async function buildGameTree() {
  // Dynamic supervisors for transient entities
  const playerSupervisor = await Supervisor.start({
    strategy: 'simple_one_for_one',
    restartIntensity: { maxRestarts: 100, withinMs: 60000 },
    childTemplate: {
      start: (playerId: string, socket: unknown) =>
        GenServer.start(playerBehavior, { playerId, socket }),
      restart: 'transient',
    },
  });

  const lobbySupervisor = await Supervisor.start({
    strategy: 'simple_one_for_one',
    restartIntensity: { maxRestarts: 20, withinMs: 30000 },
    childTemplate: {
      start: (lobbyId: string) => GenServer.start(lobbyBehavior, { lobbyId }),
      restart: 'permanent',
    },
  });

  const gameSupervisor = await Supervisor.start({
    strategy: 'simple_one_for_one',
    restartIntensity: { maxRestarts: 20, withinMs: 30000 },
    childTemplate: {
      start: (gameId: string, players: string[]) =>
        GenServer.start(gameBehavior, { gameId, players }),
      restart: 'permanent',
    },
  });

  // Backend with shared database dependency
  const backendSupervisor = await Supervisor.start({
    strategy: 'one_for_all', // Resync on any failure
    restartIntensity: { maxRestarts: 5, withinMs: 30000 },
    children: [
      { id: 'matchmaking', start: () => GenServer.start(matchmakingBehavior) },
      { id: 'leaderboard', start: () => GenServer.start(leaderboardBehavior) },
    ],
  });

  // Root assembles all domains
  const rootSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 10, withinMs: 60000 },
    children: [
      { id: 'database', start: () => GenServer.start(databaseBehavior, { name: 'database' }) },
      { id: 'players', start: () => wrapSupervisor(playerSupervisor) },
      { id: 'lobbies', start: () => wrapSupervisor(lobbySupervisor) },
      { id: 'games', start: () => wrapSupervisor(gameSupervisor) },
      { id: 'backend', start: () => wrapSupervisor(backendSupervisor) },
    ],
  });

  return rootSupervisor;
}
```

</details>

## Summary

- **Supervision trees** organize supervisors hierarchically for better failure isolation
- **Flat supervision** forces all services to share restart limits and strategies
- **Failure domains** are boundaries that contain failures - design them intentionally
- **When a supervisor fails**, its parent applies its restart strategy
- **Design guidelines**:
  - Group related services under the same supervisor
  - Use `one_for_one` at the root for independent domains
  - Match strategies to dependency patterns within domains
  - Set restart intensity based on criticality and level
- **Common patterns**: Worker Pool, Pipeline, Hub and Spoke
- **Start simple** - add depth to your tree only when needed

Supervision trees are the backbone of fault-tolerant noex applications. They let you reason about failure at a high level: "If the Order domain fails, Users can still browse products." This is the power of the "let it crash" philosophy backed by proper supervision.

---

Next: [Mapping Problems](../04-thinking-in-processes/01-mapping-problems.md)
