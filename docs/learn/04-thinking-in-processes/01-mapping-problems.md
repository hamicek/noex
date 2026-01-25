# Mapping Problems to Processes

By now, you know how to create GenServers, use supervisors, and build supervision trees. But a crucial question remains: **How do you decide what should be a process?**

This chapter teaches you the mental model for decomposing problems into processes. It's the key skill that separates code that merely uses noex from code that truly embraces the actor model.

## What You'll Learn

- The "one process = one responsibility" principle
- How to identify state that needs isolation
- Recognizing and avoiding shared state anti-patterns
- Practical heuristics for process decomposition
- Real-world examples with before/after comparisons

## The Mental Shift

Traditional Node.js programming tends to think in terms of:
- Objects and classes
- Shared mutable state
- Synchronization primitives (locks, mutexes, semaphores)
- Callbacks and promises as the unit of concurrency

Process-oriented thinking is different:
- **Processes** as the unit of concurrency
- **Messages** as the only way to communicate
- **Isolation** as the default
- **Failure boundaries** as architectural decisions

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MENTAL MODEL SHIFT                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Traditional OOP                        Process-Oriented                    │
│  ───────────────                        ────────────────                    │
│                                                                             │
│  class UserManager {                    UserProcess                         │
│    private users = new Map();           ┌───────────────┐                   │
│    private sessions = new Map();        │ State: users  │                   │
│    private stats = { ... };             │ Messages: ... │                   │
│                                         └───────────────┘                   │
│    async createUser() { ... }                   ↓                           │
│    async login() { ... }                SessionProcess                      │
│    async logout() { ... }               ┌───────────────┐                   │
│    getStats() { ... }                   │ State: sess   │                   │
│  }                                      │ Messages: ... │                   │
│                                         └───────────────┘                   │
│  Problems:                                      ↓                           │
│  • All state is coupled                 StatsProcess                        │
│  • Race conditions possible             ┌───────────────┐                   │
│  • Can't restart parts                  │ State: stats  │                   │
│  • All-or-nothing failure               │ Messages: ... │                   │
│                                         └───────────────┘                   │
│                                                                             │
│                                         Benefits:                           │
│                                         • Clear boundaries                  │
│                                         • Independent failure               │
│                                         • Concurrent execution              │
│                                         • Easy to reason about              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## One Process = One Responsibility

The Single Responsibility Principle applies to processes too, but with a twist: **a process should have one reason to change state**.

### What Makes a Good Process Boundary?

Ask these questions about a piece of state:

1. **Does this state need independent lifecycle?**
   - Can it be created/destroyed independently?
   - Should it survive restarts of other components?

2. **Does this state have its own consistency requirements?**
   - Are there invariants that must always hold?
   - Do operations need to be atomic?

3. **Could this state fail independently?**
   - If something goes wrong, should it affect other state?
   - Does it have its own error handling needs?

4. **Is this state accessed from multiple places?**
   - Do different parts of the system need to read/write it?
   - Would concurrent access be problematic?

If you answer "yes" to most of these, that state likely deserves its own process.

### Example: E-commerce Shopping Cart

Let's analyze a shopping cart feature:

```typescript
// ❌ Bad: Monolithic approach
class ShoppingService {
  private carts: Map<string, CartItem[]> = new Map();
  private inventory: Map<string, number> = new Map();
  private prices: Map<string, number> = new Map();
  private orders: Order[] = [];

  async addToCart(userId: string, productId: string) {
    // Check inventory
    const stock = this.inventory.get(productId) ?? 0;
    if (stock <= 0) throw new Error('Out of stock');

    // Add to cart
    const cart = this.carts.get(userId) ?? [];
    cart.push({ productId, quantity: 1 });
    this.carts.set(userId, cart);

    // Reserve inventory (race condition possible!)
    this.inventory.set(productId, stock - 1);
  }

  async checkout(userId: string) {
    const cart = this.carts.get(userId);
    if (!cart) throw new Error('Empty cart');

    // Calculate total, create order, clear cart...
    // All coupled together, error in one breaks everything
  }
}
```

Problems with this approach:
- **Race condition**: Two users might both see `stock = 1` and both succeed
- **Coupled failure**: An error in pricing crashes the whole checkout
- **No isolation**: Cart state is mixed with inventory and orders
- **Can't scale**: All operations go through one object

```typescript
// ✅ Good: Process-per-concern approach
import { GenServer, Supervisor, type GenServerBehavior } from '@hamicek/noex';

// Each user has their own cart process
interface CartState {
  userId: string;
  items: Map<string, number>; // productId -> quantity
}

type CartCall =
  | { type: 'add'; productId: string; quantity: number }
  | { type: 'remove'; productId: string }
  | { type: 'get' }
  | { type: 'clear' };

const createCartBehavior = (userId: string): GenServerBehavior<CartState, CartCall, never, CartState['items'] | boolean> => ({
  init: () => ({ userId, items: new Map() }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'add': {
        const current = state.items.get(msg.productId) ?? 0;
        state.items.set(msg.productId, current + msg.quantity);
        return [true, state];
      }
      case 'remove': {
        state.items.delete(msg.productId);
        return [true, state];
      }
      case 'get':
        return [new Map(state.items), state];
      case 'clear':
        return [true, { ...state, items: new Map() }];
    }
  },

  handleCast: (_, state) => state,
});

// Single inventory process (shared resource)
interface InventoryState {
  stock: Map<string, number>;
  reserved: Map<string, number>; // orderId -> quantity reserved
}

type InventoryCall =
  | { type: 'check'; productId: string }
  | { type: 'reserve'; productId: string; quantity: number; orderId: string }
  | { type: 'commit'; orderId: string }
  | { type: 'release'; orderId: string };

const inventoryBehavior: GenServerBehavior<InventoryState, InventoryCall, never, number | boolean> = {
  init: () => ({
    stock: new Map([
      ['product-1', 100],
      ['product-2', 50],
    ]),
    reserved: new Map(),
  }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'check': {
        const available = state.stock.get(msg.productId) ?? 0;
        return [available, state];
      }
      case 'reserve': {
        const available = state.stock.get(msg.productId) ?? 0;
        if (available < msg.quantity) {
          return [false, state]; // Not enough stock
        }
        // Atomically reserve
        state.stock.set(msg.productId, available - msg.quantity);
        state.reserved.set(msg.orderId, msg.quantity);
        return [true, state];
      }
      case 'commit': {
        // Remove reservation (stock already decremented)
        state.reserved.delete(msg.orderId);
        return [true, state];
      }
      case 'release': {
        // Return reserved stock
        const quantity = state.reserved.get(msg.orderId) ?? 0;
        if (quantity > 0) {
          // Note: In real code, you'd need to track which product
          state.reserved.delete(msg.orderId);
        }
        return [true, state];
      }
    }
  },

  handleCast: (_, state) => state,
};
```

Now we have:
- **Cart per user**: Each user's cart is isolated
- **Single inventory**: Stock updates are serialized, no race conditions
- **Independent failure**: A cart crash doesn't affect inventory
- **Clear boundaries**: Easy to understand and test each piece

## State That Needs Isolation

Not all state needs to be in a process. Here's a decision guide:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    WHEN TO USE A PROCESS                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    State Needs a Process If...                      │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │                                                                     │   │
│  │  ✓ It's shared between multiple callers                            │   │
│  │    → Database connections, caches, rate limiters                   │   │
│  │                                                                     │   │
│  │  ✓ It requires atomic operations                                   │   │
│  │    → Counters, balances, inventory                                 │   │
│  │                                                                     │   │
│  │  ✓ It has a lifecycle (start → running → stop)                     │   │
│  │    → Connections, sessions, subscriptions                          │   │
│  │                                                                     │   │
│  │  ✓ It needs to be supervised (auto-restart on failure)             │   │
│  │    → Services that must always be available                        │   │
│  │                                                                     │   │
│  │  ✓ It represents an independent entity                             │   │
│  │    → Users, orders, game sessions, chat rooms                      │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                   State Does NOT Need a Process If...               │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │                                                                     │   │
│  │  ✗ It's local to a single function                                 │   │
│  │    → Loop counters, temporary variables                            │   │
│  │                                                                     │   │
│  │  ✗ It's immutable configuration                                    │   │
│  │    → App settings loaded at startup                                │   │
│  │                                                                     │   │
│  │  ✗ It's derived/computed from other state                          │   │
│  │    → Totals, averages, formatted strings                           │   │
│  │                                                                     │   │
│  │  ✗ It's only used by one process                                   │   │
│  │    → Internal working state                                        │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Entity-Per-Process Pattern

A common pattern is one process per entity instance:

```typescript
// One process per connected user
// One process per active game
// One process per chat room
// One process per order being processed

// Example: Game lobby with per-player processes
async function createGameLobby() {
  // Each player gets their own process
  const playerSupervisor = await Supervisor.start({
    strategy: 'simple_one_for_one',
    childTemplate: {
      start: (playerId: string, socket: WebSocket) =>
        GenServer.start(createPlayerBehavior(playerId, socket)),
      restart: 'transient',
    },
  });

  // When a player connects:
  // await Supervisor.startChild(playerSupervisor, [playerId, socket]);

  // Benefits:
  // - Player crash only affects that player
  // - Players can be processed in parallel
  // - Easy to track and manage individual players
  // - Natural mapping to the domain model

  return playerSupervisor;
}

interface PlayerState {
  id: string;
  position: { x: number; y: number };
  health: number;
  inventory: string[];
}

type PlayerCall =
  | { type: 'getState' }
  | { type: 'move'; dx: number; dy: number }
  | { type: 'damage'; amount: number };

type PlayerCast =
  | { type: 'sendMessage'; message: string };

const createPlayerBehavior = (
  playerId: string,
  socket: WebSocket
): GenServerBehavior<PlayerState, PlayerCall, PlayerCast, PlayerState | boolean> => ({
  init: () => ({
    id: playerId,
    position: { x: 0, y: 0 },
    health: 100,
    inventory: [],
  }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'getState':
        return [state, state];
      case 'move': {
        const newState = {
          ...state,
          position: {
            x: state.position.x + msg.dx,
            y: state.position.y + msg.dy,
          },
        };
        return [true, newState];
      }
      case 'damage': {
        const newHealth = Math.max(0, state.health - msg.amount);
        return [newHealth > 0, { ...state, health: newHealth }];
      }
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'sendMessage') {
      // socket.send(msg.message); // Send to player's WebSocket
    }
    return state;
  },
});
```

### Singleton Process Pattern

Some state should have exactly one process:

```typescript
// Single configuration service
// Single rate limiter per resource
// Single metrics collector
// Single connection pool manager

// Example: Application-wide rate limiter
interface RateLimiterState {
  requests: Map<string, number[]>; // key -> timestamps
  limit: number;
  windowMs: number;
}

type RateLimiterCall =
  | { type: 'check'; key: string }
  | { type: 'consume'; key: string };

const rateLimiterBehavior: GenServerBehavior<RateLimiterState, RateLimiterCall, never, boolean> = {
  init: () => ({
    requests: new Map(),
    limit: 100,
    windowMs: 60000,
  }),

  handleCall(msg, state) {
    const now = Date.now();
    const cutoff = now - state.windowMs;

    // Clean old entries
    const timestamps = (state.requests.get(msg.key) ?? []).filter(t => t > cutoff);

    if (msg.type === 'check') {
      return [timestamps.length < state.limit, state];
    }

    // msg.type === 'consume'
    if (timestamps.length >= state.limit) {
      return [false, state]; // Rate limited
    }

    timestamps.push(now);
    state.requests.set(msg.key, timestamps);
    return [true, state];
  },

  handleCast: (_, state) => state,
};

// Start as named singleton
const rateLimiter = await GenServer.start(rateLimiterBehavior, {
  name: 'rate-limiter',
});
```

## Shared State Anti-Patterns

### Anti-Pattern 1: Global Mutable State

```typescript
// ❌ Bad: Global mutable state
let connectionCount = 0;
const activeUsers = new Map<string, User>();

async function handleConnect(userId: string) {
  connectionCount++; // Race condition!
  activeUsers.set(userId, await loadUser(userId));
}

async function handleDisconnect(userId: string) {
  connectionCount--;
  activeUsers.delete(userId);
}

// Called from multiple async contexts simultaneously
// Result: connectionCount becomes inaccurate
```

```typescript
// ✅ Good: State in a process
interface ConnectionState {
  count: number;
  users: Map<string, User>;
}

type ConnectionCall =
  | { type: 'connect'; userId: string; user: User }
  | { type: 'disconnect'; userId: string }
  | { type: 'getCount' }
  | { type: 'getUser'; userId: string };

const connectionBehavior: GenServerBehavior<ConnectionState, ConnectionCall, never, number | User | undefined> = {
  init: () => ({ count: 0, users: new Map() }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'connect':
        state.users.set(msg.userId, msg.user);
        return [state.count + 1, { ...state, count: state.count + 1 }];
      case 'disconnect':
        state.users.delete(msg.userId);
        return [state.count - 1, { ...state, count: state.count - 1 }];
      case 'getCount':
        return [state.count, state];
      case 'getUser':
        return [state.users.get(msg.userId), state];
    }
  },

  handleCast: (_, state) => state,
};
```

### Anti-Pattern 2: Passing State Between Functions

```typescript
// ❌ Bad: State passed around, hard to track
async function processOrder(order: Order, inventory: Inventory, payments: PaymentState) {
  // Who owns this state? Who can modify it?
  inventory.items[order.productId] -= order.quantity;

  const payment = await chargeCustomer(order.customerId, order.total, payments);

  // If payment fails, how do we roll back inventory?
  // State is scattered, hard to reason about
}
```

```typescript
// ✅ Good: Each process owns its state
async function processOrder(orderId: string) {
  const inventoryRef = Registry.whereis('inventory');
  const paymentRef = Registry.whereis('payments');

  if (!inventoryRef || !paymentRef) {
    throw new Error('Required services not available');
  }

  // Reserve inventory (atomic operation)
  const reserved = await GenServer.call(inventoryRef, {
    type: 'reserve',
    orderId,
    productId: 'product-1',
    quantity: 1,
  });

  if (!reserved) {
    throw new Error('Insufficient inventory');
  }

  try {
    // Process payment
    const paid = await GenServer.call(paymentRef, {
      type: 'charge',
      orderId,
      amount: 100,
    });

    if (!paid) {
      // Release inventory on payment failure
      await GenServer.call(inventoryRef, { type: 'release', orderId });
      throw new Error('Payment failed');
    }

    // Commit inventory
    await GenServer.call(inventoryRef, { type: 'commit', orderId });

  } catch (error) {
    // Release inventory on any error
    await GenServer.call(inventoryRef, { type: 'release', orderId });
    throw error;
  }
}
```

### Anti-Pattern 3: Shared References Between Processes

```typescript
// ❌ Bad: Processes sharing a reference
const sharedCache = new Map<string, any>();

const process1 = await GenServer.start({
  init: () => ({ cache: sharedCache }), // Sharing reference!
  handleCall: (msg, state) => {
    state.cache.set(msg.key, msg.value); // Modifying shared state
    return [true, state];
  },
  handleCast: (_, state) => state,
});

const process2 = await GenServer.start({
  init: () => ({ cache: sharedCache }), // Same reference!
  handleCall: (msg, state) => {
    // Race condition with process1!
    return [state.cache.get(msg.key), state];
  },
  handleCast: (_, state) => state,
});
```

```typescript
// ✅ Good: Dedicated cache process
const cache = await GenServer.start({
  init: () => ({ data: new Map<string, any>() }),
  handleCall(msg: { type: 'get' | 'set'; key: string; value?: any }, state) {
    if (msg.type === 'set') {
      state.data.set(msg.key, msg.value);
      return [true, state];
    }
    return [state.data.get(msg.key), state];
  },
  handleCast: (_, state) => state,
}, { name: 'cache' });

// Both process1 and process2 communicate with cache via messages
// No shared references, no race conditions
```

## Practical Heuristics

Here's a quick reference for decomposing a system into processes:

### 1. Domain Entities → Processes

| Domain Concept | Process Pattern |
|---------------|-----------------|
| User session | One process per session |
| Shopping cart | One process per user |
| Chat room | One process per room |
| Game match | One process per match |
| Document being edited | One process per document |

### 2. Infrastructure Concerns → Singleton Processes

| Infrastructure | Process Pattern |
|----------------|-----------------|
| Database connection pool | Single process |
| Cache | Single process (or sharded) |
| Rate limiter | Single process per resource |
| Metrics collector | Single process |
| Configuration | Single process |

### 3. Coordination → Supervisor Processes

| Coordination Need | Process Pattern |
|------------------|-----------------|
| Worker pool | Supervisor with `simple_one_for_one` |
| Service discovery | Registry process |
| Health monitoring | Supervisor with lifecycle events |
| Graceful shutdown | Application process |

## Example: Decomposing a Blog API

Let's walk through decomposing a blog API into processes:

### Requirements
- Users can create posts
- Posts can have comments
- Users can follow other users
- Feed shows posts from followed users
- Analytics track post views

### Process Decomposition

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        BLOG API PROCESS ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                              ┌──────────────┐                               │
│                              │     Root     │                               │
│                              │  Supervisor  │                               │
│                              └──────┬───────┘                               │
│          ┌──────────┬───────────────┼───────────────┬──────────┐           │
│          ▼          ▼               ▼               ▼          ▼           │
│    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│    │  User    │ │  Post    │ │  Feed    │ │Analytics │ │  Cache   │       │
│    │ Service  │ │ Service  │ │ Service  │ │ Service  │ │ Service  │       │
│    └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────────┘ └──────────┘       │
│         │            │            │                                         │
│   ┌─────┴─────┐     Uses     Uses Registry                                 │
│   │   User    │   Registry    to find                                      │
│   │ Registry  │   for post     user's                                      │
│   │           │   lookups    followed                                      │
│   └───────────┘              posts                                         │
│                                                                             │
│  Process Responsibilities:                                                  │
│                                                                             │
│  UserService: User CRUD, authentication, follow relationships              │
│  PostService: Post CRUD, manages individual post processes                 │
│  FeedService: Aggregates posts from followed users                         │
│  AnalyticsService: Tracks views, engagement (can be async/eventual)        │
│  CacheService: LRU cache for hot data                                      │
│                                                                             │
│  Communication Flow:                                                        │
│                                                                             │
│  1. User creates post → PostService.createPost()                           │
│  2. User views feed → FeedService gets followed users from UserService     │
│     → FeedService gets posts from PostService                              │
│  3. Post viewed → AnalyticsService.trackView() (cast, fire-and-forget)     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Implementation Sketch

```typescript
import { GenServer, Supervisor, Registry, type GenServerBehavior } from '@hamicek/noex';

// User Service - manages users and follow relationships
interface UserState {
  users: Map<string, { id: string; name: string; email: string }>;
  follows: Map<string, Set<string>>; // userId -> Set of followed userIds
}

type UserCall =
  | { type: 'create'; id: string; name: string; email: string }
  | { type: 'get'; id: string }
  | { type: 'follow'; followerId: string; followeeId: string }
  | { type: 'getFollowing'; userId: string };

const userServiceBehavior: GenServerBehavior<UserState, UserCall, never, any> = {
  init: () => ({
    users: new Map(),
    follows: new Map(),
  }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'create': {
        const user = { id: msg.id, name: msg.name, email: msg.email };
        state.users.set(msg.id, user);
        return [user, state];
      }
      case 'get':
        return [state.users.get(msg.id) ?? null, state];
      case 'follow': {
        const following = state.follows.get(msg.followerId) ?? new Set();
        following.add(msg.followeeId);
        state.follows.set(msg.followerId, following);
        return [true, state];
      }
      case 'getFollowing': {
        const following = state.follows.get(msg.userId) ?? new Set();
        return [Array.from(following), state];
      }
    }
  },

  handleCast: (_, state) => state,
};

// Post Service - manages posts
interface PostState {
  posts: Map<string, { id: string; authorId: string; content: string; createdAt: Date }>;
  byAuthor: Map<string, string[]>; // authorId -> postIds
}

type PostCall =
  | { type: 'create'; id: string; authorId: string; content: string }
  | { type: 'get'; id: string }
  | { type: 'getByAuthor'; authorId: string };

type PostCast =
  | { type: 'delete'; id: string };

const postServiceBehavior: GenServerBehavior<PostState, PostCall, PostCast, any> = {
  init: () => ({
    posts: new Map(),
    byAuthor: new Map(),
  }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'create': {
        const post = {
          id: msg.id,
          authorId: msg.authorId,
          content: msg.content,
          createdAt: new Date(),
        };
        state.posts.set(msg.id, post);
        const authorPosts = state.byAuthor.get(msg.authorId) ?? [];
        authorPosts.push(msg.id);
        state.byAuthor.set(msg.authorId, authorPosts);
        return [post, state];
      }
      case 'get':
        return [state.posts.get(msg.id) ?? null, state];
      case 'getByAuthor': {
        const postIds = state.byAuthor.get(msg.authorId) ?? [];
        const posts = postIds.map(id => state.posts.get(id)).filter(Boolean);
        return [posts, state];
      }
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'delete') {
      const post = state.posts.get(msg.id);
      if (post) {
        state.posts.delete(msg.id);
        const authorPosts = state.byAuthor.get(post.authorId) ?? [];
        state.byAuthor.set(
          post.authorId,
          authorPosts.filter(id => id !== msg.id)
        );
      }
    }
    return state;
  },
};

// Analytics Service - fire-and-forget tracking
interface AnalyticsState {
  views: Map<string, number>; // postId -> view count
}

type AnalyticsCast =
  | { type: 'trackView'; postId: string };

type AnalyticsCall =
  | { type: 'getViews'; postId: string };

const analyticsServiceBehavior: GenServerBehavior<AnalyticsState, AnalyticsCall, AnalyticsCast, number> = {
  init: () => ({ views: new Map() }),

  handleCall(msg, state) {
    if (msg.type === 'getViews') {
      return [state.views.get(msg.postId) ?? 0, state];
    }
    return [0, state];
  },

  handleCast(msg, state) {
    if (msg.type === 'trackView') {
      const current = state.views.get(msg.postId) ?? 0;
      state.views.set(msg.postId, current + 1);
    }
    return state;
  },
};

// Start the blog API
async function startBlogAPI() {
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      {
        id: 'user-service',
        start: () => GenServer.start(userServiceBehavior, { name: 'user-service' }),
      },
      {
        id: 'post-service',
        start: () => GenServer.start(postServiceBehavior, { name: 'post-service' }),
      },
      {
        id: 'analytics-service',
        start: () => GenServer.start(analyticsServiceBehavior, { name: 'analytics' }),
      },
    ],
  });

  console.log('Blog API started');
  return supervisor;
}

// Usage example
async function demo() {
  await startBlogAPI();

  const userService = Registry.whereis('user-service')!;
  const postService = Registry.whereis('post-service')!;
  const analytics = Registry.whereis('analytics')!;

  // Create users
  await GenServer.call(userService, { type: 'create', id: 'u1', name: 'Alice', email: 'alice@example.com' });
  await GenServer.call(userService, { type: 'create', id: 'u2', name: 'Bob', email: 'bob@example.com' });

  // Alice follows Bob
  await GenServer.call(userService, { type: 'follow', followerId: 'u1', followeeId: 'u2' });

  // Bob creates a post
  const post = await GenServer.call(postService, {
    type: 'create',
    id: 'p1',
    authorId: 'u2',
    content: 'Hello from Bob!',
  });

  // Track view (fire-and-forget)
  GenServer.cast(analytics, { type: 'trackView', postId: 'p1' });

  // Get feed for Alice (posts from followed users)
  const following = await GenServer.call(userService, { type: 'getFollowing', userId: 'u1' });
  const feed = [];
  for (const authorId of following as string[]) {
    const posts = await GenServer.call(postService, { type: 'getByAuthor', authorId });
    feed.push(...(posts as any[]));
  }

  console.log('Alice\'s feed:', feed);
}
```

## Exercise

Decompose a **notification system** into processes. The system should support:

1. Multiple notification channels (email, SMS, push)
2. User preferences (which channels they want)
3. Rate limiting (max 10 notifications per hour per user)
4. Template rendering (notification templates)
5. Delivery tracking (sent, delivered, failed)

Questions to answer:
1. What processes do you need?
2. Which should be singletons vs. per-entity?
3. How do they communicate?
4. What's the supervision tree?

<details>
<summary>Solution</summary>

### Process Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    NOTIFICATION SYSTEM PROCESSES                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. NotificationRouter (singleton)                                          │
│     - Receives notification requests                                        │
│     - Checks user preferences                                               │
│     - Routes to appropriate channel                                         │
│                                                                             │
│  2. UserPreferencesService (singleton)                                      │
│     - Stores user notification preferences                                  │
│     - Answers "which channels for this user?"                               │
│                                                                             │
│  3. RateLimiterService (singleton)                                          │
│     - Tracks notifications per user                                         │
│     - Returns allow/deny for each notification                              │
│                                                                             │
│  4. TemplateService (singleton)                                             │
│     - Renders notification templates                                        │
│     - Caches compiled templates                                             │
│                                                                             │
│  5. EmailChannel (singleton)                                                │
│  6. SMSChannel (singleton)                                                  │
│  7. PushChannel (singleton)                                                 │
│     - Each channel handles its delivery                                     │
│     - Reports delivery status                                               │
│                                                                             │
│  8. DeliveryTracker (singleton)                                             │
│     - Records all notification attempts                                     │
│     - Stores status (pending/sent/delivered/failed)                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Supervision Tree

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    NOTIFICATION SUPERVISION TREE                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                              ┌─────────────┐                                │
│                              │    Root     │ one_for_one                    │
│                              │  Supervisor │                                │
│                              └──────┬──────┘                                │
│              ┌──────────────────────┼──────────────────────┐               │
│              ▼                      ▼                      ▼               │
│       ┌─────────────┐        ┌─────────────┐        ┌─────────────┐        │
│       │   Core      │        │  Channels   │        │  Tracking   │        │
│       │ Supervisor  │        │ Supervisor  │        │  Supervisor │        │
│       │ one_for_one │        │ one_for_one │        │ one_for_one │        │
│       └──────┬──────┘        └──────┬──────┘        └──────┬──────┘        │
│         ┌────┴────┐            ┌────┼────┐                 │               │
│         ▼    ▼    ▼            ▼    ▼    ▼                 ▼               │
│      ┌────┐┌────┐┌────┐    ┌────┐┌────┐┌────┐        ┌──────────┐         │
│      │Rout││Pref││Tmpl│    │Mail││SMS ││Push│        │ Tracker  │         │
│      │ er ││ s  ││Svc │    │Chan││Chan││Chan│        │          │         │
│      └────┘└────┘└────┘    └────┘└────┘└────┘        └──────────┘         │
│        │                     ↑                              ↑              │
│        └─────────────────────┴───────reports status─────────┘              │
│                                                                             │
│  Rationale:                                                                 │
│  • Core services grouped - router depends on preferences and templates     │
│  • Channels grouped - all delivery mechanisms isolated together            │
│  • Tracker separate - delivery tracking can fail without affecting sends   │
│  • one_for_one everywhere - services are independent within groups         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Implementation Sketch

```typescript
import { GenServer, Supervisor, Registry, type GenServerBehavior } from '@hamicek/noex';

// Types
type Channel = 'email' | 'sms' | 'push';
type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed';

interface NotificationRequest {
  id: string;
  userId: string;
  templateId: string;
  data: Record<string, string>;
  channels?: Channel[]; // Override user preferences
}

// Router - entry point for notifications
interface RouterState {
  pending: Map<string, NotificationRequest>;
}

type RouterCall = { type: 'send'; request: NotificationRequest };

const routerBehavior: GenServerBehavior<RouterState, RouterCall, never, boolean> = {
  init: () => ({ pending: new Map() }),

  async handleCall(msg, state) {
    if (msg.type === 'send') {
      const { request } = msg;

      // Check rate limit
      const rateLimiter = Registry.whereis('rate-limiter');
      if (rateLimiter) {
        const allowed = await GenServer.call(rateLimiter, {
          type: 'check',
          userId: request.userId,
        });
        if (!allowed) {
          return [false, state]; // Rate limited
        }
      }

      // Get user preferences (or use override)
      let channels = request.channels;
      if (!channels) {
        const prefs = Registry.whereis('preferences');
        if (prefs) {
          channels = await GenServer.call(prefs, {
            type: 'getChannels',
            userId: request.userId,
          }) as Channel[];
        }
      }
      channels = channels ?? ['email']; // Default to email

      // Render template
      const templateSvc = Registry.whereis('templates');
      let content = request.data.message ?? '';
      if (templateSvc) {
        content = await GenServer.call(templateSvc, {
          type: 'render',
          templateId: request.templateId,
          data: request.data,
        }) as string;
      }

      // Send to each channel
      for (const channel of channels) {
        const channelRef = Registry.whereis(`channel-${channel}`);
        if (channelRef) {
          GenServer.cast(channelRef, {
            type: 'deliver',
            notificationId: request.id,
            userId: request.userId,
            content,
          });
        }
      }

      return [true, state];
    }
    return [false, state];
  },

  handleCast: (_, state) => state,
};

// Delivery Tracker
interface TrackerState {
  notifications: Map<string, {
    id: string;
    userId: string;
    status: NotificationStatus;
    channel: Channel;
    timestamp: Date;
  }>;
}

type TrackerCall = { type: 'getStatus'; notificationId: string };
type TrackerCast = { type: 'record'; notificationId: string; userId: string; channel: Channel; status: NotificationStatus };

const trackerBehavior: GenServerBehavior<TrackerState, TrackerCall, TrackerCast, NotificationStatus | null> = {
  init: () => ({ notifications: new Map() }),

  handleCall(msg, state) {
    if (msg.type === 'getStatus') {
      const notification = state.notifications.get(msg.notificationId);
      return [notification?.status ?? null, state];
    }
    return [null, state];
  },

  handleCast(msg, state) {
    if (msg.type === 'record') {
      state.notifications.set(msg.notificationId, {
        id: msg.notificationId,
        userId: msg.userId,
        status: msg.status,
        channel: msg.channel,
        timestamp: new Date(),
      });
    }
    return state;
  },
};

// Start the notification system
async function startNotificationSystem() {
  // Core services
  const coreSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'router', start: () => GenServer.start(routerBehavior, { name: 'router' }) },
      { id: 'preferences', start: () => GenServer.start(preferencesBehavior, { name: 'preferences' }) },
      { id: 'templates', start: () => GenServer.start(templateBehavior, { name: 'templates' }) },
      { id: 'rate-limiter', start: () => GenServer.start(rateLimiterBehavior, { name: 'rate-limiter' }) },
    ],
  });

  // Channel services
  const channelsSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'email', start: () => GenServer.start(createChannelBehavior('email'), { name: 'channel-email' }) },
      { id: 'sms', start: () => GenServer.start(createChannelBehavior('sms'), { name: 'channel-sms' }) },
      { id: 'push', start: () => GenServer.start(createChannelBehavior('push'), { name: 'channel-push' }) },
    ],
  });

  // Tracking service
  const trackingSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'tracker', start: () => GenServer.start(trackerBehavior, { name: 'tracker' }) },
    ],
  });

  return { coreSupervisor, channelsSupervisor, trackingSupervisor };
}
```

### Key Design Decisions

1. **Router is singleton**: Single entry point for all notifications
2. **Channels are singletons**: Each channel manages its own connection/state
3. **Tracker is separate**: Tracking failures shouldn't affect delivery
4. **Fire-and-forget to channels**: Router doesn't wait for delivery
5. **Channels report back**: Cast to tracker with delivery status

</details>

## Summary

- **One process = one responsibility**: A process should have one reason to change state
- **Ask four questions** to identify process boundaries:
  - Does it need independent lifecycle?
  - Does it have consistency requirements?
  - Could it fail independently?
  - Is it accessed from multiple places?
- **Entity-per-process** pattern for domain objects (users, orders, sessions)
- **Singleton process** pattern for infrastructure (cache, rate limiter, config)
- **Avoid shared state anti-patterns**:
  - No global mutable variables
  - No passing state between functions
  - No shared references between processes
- **All state modification happens through messages**: This is the fundamental guarantee

The mental shift from "objects and methods" to "processes and messages" takes practice. Start by identifying the state in your system, then ask which pieces need isolation. When in doubt, err on the side of more processes — they're cheap to create and easy to combine under supervisors.

---

Next: [Inter-Process Communication](./02-ipc.md)
