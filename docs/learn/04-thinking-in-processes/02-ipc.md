# Inter-Process Communication

Processes are isolated by design — they share no state. This isolation is the foundation of fault tolerance. But isolated processes still need to work together. This chapter explores the three fundamental communication mechanisms in noex.

## What You'll Learn

- Direct communication with `call()` and `cast()` — when and why
- Discovery with Registry — finding processes by name
- Pub/sub with EventBus — decoupled broadcasting
- Choosing the right communication pattern for your use case
- Building communication topologies

## The Three Communication Mechanisms

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    INTER-PROCESS COMMUNICATION                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. DIRECT (call/cast)          2. REGISTRY              3. EVENTBUS       │
│  ──────────────────             ────────                 ────────           │
│                                                                             │
│  ┌─────┐    call    ┌─────┐    ┌─────┐  lookup  ┌───┐   ┌───┐   pub   ┌───┐│
│  │  A  │───────────▶│  B  │    │  A  │─────────▶│ R │   │ A │────────▶│Bus││
│  └─────┘◀───reply───└─────┘    └─────┘          │ e │   └───┘         └─┬─┘│
│                                      ▼          │ g │                   │   │
│  ┌─────┐    cast    ┌─────┐    ┌─────────┐     │ i │    ┌──────────────┘   │
│  │  A  │───────────▶│  B  │    │ Service │◀────│ s │    ▼                  │
│  └─────┘  (no reply)└─────┘    └─────────┘     │ t │   ┌───┐  ┌───┐  ┌───┐│
│                                                │ r │   │ B │  │ C │  │ D ││
│  When: Direct ref   When: Find by name         │ y │   └───┘  └───┘  └───┘│
│  needed             decouple components        └───┘   subscribers        │
│                                                                             │
│  Use: Request/reply  Use: Service discovery    Use: Broadcast/notify      │
│       fire-and-forget     singleton lookup          many receivers        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 1. Direct Communication: call() and cast()

When you have a reference to a process, you can communicate directly with `call()` and `cast()`.

### call() — Request-Response

`call()` sends a message and waits for a response. It's synchronous from the caller's perspective.

```typescript
import { GenServer, type GenServerBehavior } from '@hamicek/noex';

// Define a calculator service
interface CalcState {
  history: string[];
}

type CalcCall =
  | { type: 'add'; a: number; b: number }
  | { type: 'multiply'; a: number; b: number }
  | { type: 'getHistory' };

const calculatorBehavior: GenServerBehavior<CalcState, CalcCall, never, number | string[]> = {
  init: () => ({ history: [] }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'add': {
        const result = msg.a + msg.b;
        const entry = `${msg.a} + ${msg.b} = ${result}`;
        return [result, { history: [...state.history, entry] }];
      }
      case 'multiply': {
        const result = msg.a * msg.b;
        const entry = `${msg.a} * ${msg.b} = ${result}`;
        return [result, { history: [...state.history, entry] }];
      }
      case 'getHistory':
        return [state.history, state];
    }
  },

  handleCast: (_, state) => state,
};

// Usage
const calc = await GenServer.start(calculatorBehavior);

// call() returns a Promise with the response
const sum = await GenServer.call(calc, { type: 'add', a: 5, b: 3 });
console.log(sum); // 8

const product = await GenServer.call(calc, { type: 'multiply', a: 4, b: 7 });
console.log(product); // 28

const history = await GenServer.call(calc, { type: 'getHistory' });
console.log(history); // ['5 + 3 = 8', '4 * 7 = 28']
```

**When to use `call()`:**
- You need the result of the operation
- You need confirmation that the operation completed
- You need to maintain request ordering guarantees
- The operation should block until complete

### cast() — Fire-and-Forget

`cast()` sends a message without waiting for a response. The caller continues immediately.

```typescript
interface LoggerState {
  logs: Array<{ level: string; message: string; timestamp: Date }>;
}

type LoggerCast =
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'flush' };

type LoggerCall = { type: 'getLogs' };

const loggerBehavior: GenServerBehavior<LoggerState, LoggerCall, LoggerCast, Array<{ level: string; message: string; timestamp: Date }>> = {
  init: () => ({ logs: [] }),

  handleCall(msg, state) {
    if (msg.type === 'getLogs') {
      return [state.logs, state];
    }
    return [[], state];
  },

  handleCast(msg, state) {
    switch (msg.type) {
      case 'log':
        return {
          logs: [
            ...state.logs,
            { level: msg.level, message: msg.message, timestamp: new Date() },
          ],
        };
      case 'flush':
        // Write logs to file, send to server, etc.
        console.log('Flushing', state.logs.length, 'logs');
        return { logs: [] };
    }
  },
};

// Usage
const logger = await GenServer.start(loggerBehavior);

// cast() returns void immediately — doesn't wait
GenServer.cast(logger, { type: 'log', level: 'info', message: 'Server started' });
GenServer.cast(logger, { type: 'log', level: 'warn', message: 'High memory usage' });

// These casts are queued and processed in order,
// but the caller doesn't wait for them

// If you need the logs later:
const logs = await GenServer.call(logger, { type: 'getLogs' });
```

**When to use `cast()`:**
- You don't need the result
- Performance matters (no round-trip wait)
- Logging, metrics, notifications
- Background tasks that don't affect the caller

### Combining call() and cast()

A common pattern is to use `cast()` for writes and `call()` for reads:

```typescript
interface CounterState {
  value: number;
}

type CounterCall = { type: 'get' };
type CounterCast = { type: 'increment' } | { type: 'decrement' };

const counterBehavior: GenServerBehavior<CounterState, CounterCall, CounterCast, number> = {
  init: () => ({ value: 0 }),

  handleCall(msg, state) {
    if (msg.type === 'get') {
      return [state.value, state];
    }
    return [0, state];
  },

  handleCast(msg, state) {
    switch (msg.type) {
      case 'increment':
        return { value: state.value + 1 };
      case 'decrement':
        return { value: state.value - 1 };
    }
  },
};

// Usage
const counter = await GenServer.start(counterBehavior);

// Fast writes (fire-and-forget)
GenServer.cast(counter, { type: 'increment' });
GenServer.cast(counter, { type: 'increment' });
GenServer.cast(counter, { type: 'increment' });

// Read when needed
const value = await GenServer.call(counter, { type: 'get' });
console.log(value); // 3
```

This pattern maximizes write throughput while still allowing reads when needed.

## 2. Registry: Process Discovery

Direct communication requires a reference. But how do you get a reference in the first place? The **Registry** provides named process lookup.

### Registering Processes

```typescript
import { GenServer, Registry } from '@hamicek/noex';

// Start a service and register it by name
const userService = await GenServer.start(userServiceBehavior);
Registry.register('user-service', userService);

// Or register at start time
const orderService = await GenServer.start(orderServiceBehavior, {
  name: 'order-service', // Automatically registered
});
```

### Looking Up Processes

```typescript
// lookup() throws if not found
try {
  const userService = Registry.lookup('user-service');
  const user = await GenServer.call(userService, { type: 'get', id: 'u1' });
} catch (error) {
  if (error instanceof NotRegisteredError) {
    console.log('User service not available');
  }
}

// whereis() returns undefined if not found (no exception)
const orderService = Registry.whereis('order-service');
if (orderService) {
  const order = await GenServer.call(orderService, { type: 'get', id: 'o1' });
} else {
  console.log('Order service not available');
}
```

### Registry Decouples Components

Without Registry, you need to pass references explicitly:

```typescript
// ❌ Tightly coupled — OrderService needs UserService reference
async function startServices() {
  const userService = await GenServer.start(userServiceBehavior);
  const orderService = await GenServer.start(createOrderServiceBehavior(userService));
  return { userService, orderService };
}
```

With Registry, services discover each other:

```typescript
// ✅ Loosely coupled — services find each other by name
async function startServices() {
  await GenServer.start(userServiceBehavior, { name: 'user-service' });
  await GenServer.start(orderServiceBehavior, { name: 'order-service' });
}

// OrderService implementation
const orderServiceBehavior: GenServerBehavior<OrderState, OrderCall, OrderCast, Order | null> = {
  init: () => ({ orders: new Map() }),

  async handleCall(msg, state) {
    if (msg.type === 'create') {
      // Look up user service dynamically
      const userService = Registry.whereis('user-service');
      if (!userService) {
        throw new Error('User service unavailable');
      }

      // Verify user exists
      const user = await GenServer.call(userService, { type: 'get', id: msg.userId });
      if (!user) {
        throw new Error('User not found');
      }

      const order = { id: generateId(), userId: msg.userId, items: msg.items };
      state.orders.set(order.id, order);
      return [order, state];
    }
    // ... other handlers
    return [null, state];
  },

  handleCast: (_, state) => state,
};
```

### Automatic Cleanup

When a process terminates, its registration is automatically removed:

```typescript
const service = await GenServer.start(behavior, { name: 'temp-service' });
console.log(Registry.isRegistered('temp-service')); // true

await GenServer.stop(service);
console.log(Registry.isRegistered('temp-service')); // false (automatic cleanup)
```

### Listing Registered Processes

```typescript
// Get all registered names
const names = Registry.getNames();
console.log(names); // ['user-service', 'order-service', 'cache']

// Count registered processes
const count = Registry.count();
console.log(count); // 3

// Check if specific name is registered
if (Registry.isRegistered('cache')) {
  // Cache is available
}
```

## 3. EventBus: Pub/Sub Communication

Sometimes you want to broadcast events to multiple interested parties without knowing who they are. This is the **publish/subscribe** pattern.

### Creating and Using EventBus

```typescript
import { EventBus } from '@hamicek/noex';

// Start an EventBus
const bus = await EventBus.start();

// Subscribe to events
const unsubscribe = await EventBus.subscribe(bus, 'user.created', (message, topic) => {
  console.log(`New user created: ${message.name}`);
});

// Publish events (fire-and-forget)
EventBus.publish(bus, 'user.created', { id: 'u1', name: 'Alice' });

// Unsubscribe when done
unsubscribe();
```

### Wildcard Subscriptions

EventBus supports pattern matching for flexible subscriptions:

```typescript
// Exact match
await EventBus.subscribe(bus, 'user.created', handler);
// Matches: 'user.created'
// Doesn't match: 'user.updated', 'user.created.admin'

// Single-level wildcard
await EventBus.subscribe(bus, 'user.*', handler);
// Matches: 'user.created', 'user.updated', 'user.deleted'
// Doesn't match: 'order.created', 'user.profile.updated'

// Global wildcard
await EventBus.subscribe(bus, '*', handler);
// Matches: everything
```

### Practical Example: Order Processing Pipeline

```typescript
import { GenServer, Supervisor, EventBus, Registry, type EventBusRef } from '@hamicek/noex';

// Event types
type OrderEvent =
  | { type: 'order.created'; orderId: string; userId: string; total: number }
  | { type: 'order.paid'; orderId: string; paymentId: string }
  | { type: 'order.shipped'; orderId: string; trackingNumber: string };

// Start EventBus as named service
const eventBus = await EventBus.start({ name: 'event-bus' });

// Inventory service — subscribes to order.created
interface InventoryState {
  reserved: Map<string, string[]>; // orderId -> productIds
}

const inventoryBehavior: GenServerBehavior<InventoryState, any, any, any> = {
  init() {
    // Subscribe to order events on startup
    const bus = Registry.whereis<EventBusRef>('event-bus');
    if (bus) {
      EventBus.subscribe(bus, 'order.created', async (event: OrderEvent) => {
        if (event.type === 'order.created') {
          console.log(`Reserving inventory for order ${event.orderId}`);
          // Reserve inventory...
        }
      });
    }
    return { reserved: new Map() };
  },

  handleCall: (_, state) => [null, state],
  handleCast: (_, state) => state,
};

// Email service — subscribes to order.* events
interface EmailState {
  sent: number;
}

const emailBehavior: GenServerBehavior<EmailState, any, any, any> = {
  init() {
    const bus = Registry.whereis<EventBusRef>('event-bus');
    if (bus) {
      EventBus.subscribe(bus, 'order.*', async (event: OrderEvent) => {
        switch (event.type) {
          case 'order.created':
            console.log(`Sending order confirmation email for ${event.orderId}`);
            break;
          case 'order.paid':
            console.log(`Sending payment receipt for ${event.orderId}`);
            break;
          case 'order.shipped':
            console.log(`Sending shipping notification for ${event.orderId}`);
            break;
        }
      });
    }
    return { sent: 0 };
  },

  handleCall: (_, state) => [null, state],
  handleCast: (_, state) => state,
};

// Analytics service — subscribes to all events
interface AnalyticsState {
  events: Array<{ topic: string; timestamp: Date }>;
}

const analyticsBehavior: GenServerBehavior<AnalyticsState, any, any, any> = {
  init() {
    const bus = Registry.whereis<EventBusRef>('event-bus');
    if (bus) {
      EventBus.subscribe(bus, '*', (message, topic) => {
        console.log(`[Analytics] Event: ${topic}`);
        // Track event...
      });
    }
    return { events: [] };
  },

  handleCall: (_, state) => [null, state],
  handleCast: (_, state) => state,
};

// Start all services
async function startOrderPipeline() {
  await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'inventory', start: () => GenServer.start(inventoryBehavior, { name: 'inventory' }) },
      { id: 'email', start: () => GenServer.start(emailBehavior, { name: 'email' }) },
      { id: 'analytics', start: () => GenServer.start(analyticsBehavior, { name: 'analytics' }) },
    ],
  });
}

// Publishing events
async function createOrder(userId: string, items: string[]) {
  const orderId = `order-${Date.now()}`;

  // Create order...

  // Publish event — all subscribers notified
  const bus = Registry.whereis<EventBusRef>('event-bus')!;
  EventBus.publish(bus, 'order.created', {
    type: 'order.created',
    orderId,
    userId,
    total: 99.99,
  });

  return orderId;
}
```

When `order.created` is published:
1. Inventory service reserves items
2. Email service sends confirmation
3. Analytics service tracks the event

All three happen independently and in parallel. The order service doesn't know or care about them.

## Choosing the Right Mechanism

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    COMMUNICATION DECISION GUIDE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Need a response?                                                           │
│       │                                                                     │
│       ├── YES ─────────────────────────────────────────────▶ call()        │
│       │   "Get user by ID"                                                  │
│       │   "Calculate total"                                                 │
│       │   "Validate input"                                                  │
│       │                                                                     │
│       └── NO                                                                │
│            │                                                                │
│            ├── Single recipient?                                            │
│            │        │                                                       │
│            │        ├── YES ──────────────────────────────▶ cast()         │
│            │        │   "Log this message"                                  │
│            │        │   "Increment counter"                                 │
│            │        │   "Update cache"                                      │
│            │        │                                                       │
│            │        └── NO (multiple recipients)                            │
│            │             │                                                  │
│            │             └───────────────────────────────▶ EventBus        │
│            │                 "Order was created"                            │
│            │                 "User signed up"                               │
│            │                 "System shutting down"                         │
│            │                                                                │
│            └── Unknown recipient? ───────────▶ Registry + call/cast        │
│                "Find user-service and call it"                              │
│                "Find any available worker"                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Summary Table

| Mechanism | Use When | Coupling | Blocking |
|-----------|----------|----------|----------|
| `call()` | Need response | Tight (direct ref) | Yes |
| `cast()` | Fire-and-forget | Tight (direct ref) | No |
| Registry | Service discovery | Loose (by name) | No |
| EventBus | Broadcast/notify | None (pub/sub) | No |

## Communication Topologies

Different application architectures use different communication patterns.

### Hub and Spoke

Central coordinator with peripheral workers:

```
                    ┌───────────────┐
                    │   Coordinator │
                    │   (hub)       │
                    └───────┬───────┘
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         ┌────────┐    ┌────────┐    ┌────────┐
         │Worker A│    │Worker B│    │Worker C│
         └────────┘    └────────┘    └────────┘
```

```typescript
// Coordinator distributes work via cast()
// Workers report results via call() back to coordinator
const workers = [workerA, workerB, workerC];
let nextWorker = 0;

function distributeWork(task: Task) {
  const worker = workers[nextWorker];
  nextWorker = (nextWorker + 1) % workers.length;
  GenServer.cast(worker, { type: 'process', task });
}
```

### Pipeline

Sequential processing through stages:

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  Input  │───▶│  Parse  │───▶│Validate │───▶│  Store  │
└─────────┘    └─────────┘    └─────────┘    └─────────┘
```

```typescript
// Each stage calls the next
const parseBehavior: GenServerBehavior<any, ParseCall, never, ParseResult> = {
  init: () => ({}),

  async handleCall(msg, state) {
    if (msg.type === 'parse') {
      const parsed = parseInput(msg.data);

      // Forward to next stage
      const validator = Registry.whereis('validator')!;
      const validated = await GenServer.call(validator, { type: 'validate', data: parsed });

      return [validated, state];
    }
    return [null, state];
  },

  handleCast: (_, state) => state,
};
```

### Pub/Sub Fan-Out

One event triggers many handlers:

```
                    ┌───────────────┐
       publish      │   EventBus    │
    ───────────────▶│               │
                    └───────┬───────┘
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         ┌────────┐    ┌────────┐    ┌────────┐
         │ Email  │    │Analytics│   │Webhook │
         └────────┘    └────────┘    └────────┘
```

```typescript
// Publisher doesn't know about subscribers
EventBus.publish(bus, 'user.registered', { userId: 'u1' });

// Multiple independent handlers react
// - Email sends welcome message
// - Analytics tracks signup
// - Webhook notifies external system
```

## Example: Building a Notification System

Let's combine all three mechanisms in a real-world example:

```typescript
import {
  GenServer,
  Supervisor,
  Registry,
  EventBus,
  type GenServerBehavior,
  type EventBusRef,
} from '@hamicek/noex';

// Types
type Channel = 'email' | 'sms' | 'push';
type Priority = 'low' | 'normal' | 'high';

interface Notification {
  id: string;
  userId: string;
  channel: Channel;
  title: string;
  body: string;
  priority: Priority;
}

// ============================================================================
// Notification Router — Uses Registry to find channel handlers
// ============================================================================

interface RouterState {
  sent: number;
}

type RouterCall = { type: 'send'; notification: Notification };

const routerBehavior: GenServerBehavior<RouterState, RouterCall, never, boolean> = {
  init: () => ({ sent: 0 }),

  async handleCall(msg, state) {
    if (msg.type === 'send') {
      const { notification } = msg;

      // Use Registry to find the appropriate channel handler
      const channelHandler = Registry.whereis(`channel-${notification.channel}`);

      if (!channelHandler) {
        console.error(`No handler for channel: ${notification.channel}`);
        return [false, state];
      }

      // Direct call to channel handler
      const delivered = await GenServer.call(channelHandler, {
        type: 'deliver',
        notification,
      });

      if (delivered) {
        // Publish success event via EventBus
        const bus = Registry.whereis<EventBusRef>('event-bus');
        if (bus) {
          EventBus.publish(bus, `notification.sent.${notification.channel}`, {
            notificationId: notification.id,
            userId: notification.userId,
          });
        }
      }

      return [delivered as boolean, { sent: state.sent + (delivered ? 1 : 0) }];
    }
    return [false, state];
  },

  handleCast: (_, state) => state,
};

// ============================================================================
// Channel Handlers — Called directly by Router
// ============================================================================

interface ChannelState {
  delivered: number;
  failed: number;
}

type ChannelCall = { type: 'deliver'; notification: Notification } | { type: 'getStats' };

function createChannelBehavior(channel: Channel): GenServerBehavior<ChannelState, ChannelCall, never, boolean | ChannelState> {
  return {
    init: () => ({ delivered: 0, failed: 0 }),

    async handleCall(msg, state) {
      switch (msg.type) {
        case 'deliver': {
          // Simulate channel-specific delivery
          const success = await deliverViaChannel(channel, msg.notification);

          if (success) {
            return [true, { ...state, delivered: state.delivered + 1 }];
          } else {
            return [false, { ...state, failed: state.failed + 1 }];
          }
        }
        case 'getStats':
          return [state, state];
      }
    },

    handleCast: (_, state) => state,
  };
}

async function deliverViaChannel(channel: Channel, notification: Notification): Promise<boolean> {
  // Simulate delivery with some latency
  await new Promise(resolve => setTimeout(resolve, 10));
  console.log(`[${channel.toUpperCase()}] Delivered to ${notification.userId}: ${notification.title}`);
  return true;
}

// ============================================================================
// Analytics Service — Subscribes to EventBus
// ============================================================================

interface AnalyticsState {
  byChannel: Map<Channel, number>;
}

const analyticsBehavior: GenServerBehavior<AnalyticsState, any, any, any> = {
  init() {
    const bus = Registry.whereis<EventBusRef>('event-bus');
    if (bus) {
      // Subscribe to all notification events using wildcard
      EventBus.subscribe(bus, 'notification.sent.*', (message, topic) => {
        const channel = topic.split('.')[2] as Channel;
        console.log(`[Analytics] Notification sent via ${channel}`);
      });
    }
    return { byChannel: new Map() };
  },

  handleCall: (_, state) => [null, state],
  handleCast: (_, state) => state,
};

// ============================================================================
// Start the System
// ============================================================================

async function startNotificationSystem() {
  // Start EventBus first
  await EventBus.start({ name: 'event-bus' });

  // Start channel handlers
  await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      {
        id: 'channel-email',
        start: () => GenServer.start(createChannelBehavior('email'), { name: 'channel-email' }),
      },
      {
        id: 'channel-sms',
        start: () => GenServer.start(createChannelBehavior('sms'), { name: 'channel-sms' }),
      },
      {
        id: 'channel-push',
        start: () => GenServer.start(createChannelBehavior('push'), { name: 'channel-push' }),
      },
    ],
  });

  // Start router and analytics
  await GenServer.start(routerBehavior, { name: 'notification-router' });
  await GenServer.start(analyticsBehavior, { name: 'analytics' });

  console.log('Notification system started');
}

// ============================================================================
// Usage
// ============================================================================

async function demo() {
  await startNotificationSystem();

  const router = Registry.lookup('notification-router');

  // Send notifications via different channels
  await GenServer.call(router, {
    type: 'send',
    notification: {
      id: 'n1',
      userId: 'user-1',
      channel: 'email',
      title: 'Welcome!',
      body: 'Thanks for signing up.',
      priority: 'normal',
    },
  });

  await GenServer.call(router, {
    type: 'send',
    notification: {
      id: 'n2',
      userId: 'user-1',
      channel: 'push',
      title: 'New message',
      body: 'You have a new message.',
      priority: 'high',
    },
  });
}

// Output:
// [EMAIL] Delivered to user-1: Welcome!
// [Analytics] Notification sent via email
// [PUSH] Delivered to user-1: New message
// [Analytics] Notification sent via push
```

This example demonstrates:
1. **Direct call()** — Router calls channel handlers
2. **Registry lookup** — Router finds handlers by name (`channel-email`, etc.)
3. **EventBus pub/sub** — Analytics subscribes to `notification.sent.*` events

## Exercise

Build a **task queue** with the following requirements:

1. **Producer** — accepts tasks and queues them
2. **Worker pool** — 3 workers that process tasks
3. **Monitor** — tracks task completion via EventBus

Requirements:
- Producer uses `call()` to enqueue (returns task ID)
- Producer uses `cast()` to assign tasks to workers
- Workers publish completion events to EventBus
- Monitor subscribes to all completion events

<details>
<summary>Solution</summary>

```typescript
import {
  GenServer,
  Supervisor,
  Registry,
  EventBus,
  type GenServerBehavior,
  type GenServerRef,
  type EventBusRef,
} from '@hamicek/noex';

// Types
interface Task {
  id: string;
  payload: string;
}

// ============================================================================
// Producer — Manages task queue
// ============================================================================

interface ProducerState {
  queue: Task[];
  nextWorker: number;
  workerCount: number;
}

type ProducerCall =
  | { type: 'enqueue'; payload: string }
  | { type: 'getQueueSize' };

type ProducerCast = { type: 'processNext' };

const producerBehavior: GenServerBehavior<ProducerState, ProducerCall, ProducerCast, string | number> = {
  init: () => ({
    queue: [],
    nextWorker: 0,
    workerCount: 3,
  }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'enqueue': {
        const task: Task = {
          id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          payload: msg.payload,
        };
        const newQueue = [...state.queue, task];

        // Trigger processing
        const self = Registry.whereis('producer')!;
        GenServer.cast(self, { type: 'processNext' });

        return [task.id, { ...state, queue: newQueue }];
      }
      case 'getQueueSize':
        return [state.queue.length, state];
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'processNext' && state.queue.length > 0) {
      const [task, ...remaining] = state.queue;

      // Round-robin worker selection
      const workerId = `worker-${state.nextWorker}`;
      const worker = Registry.whereis(workerId);

      if (worker) {
        GenServer.cast(worker, { type: 'process', task });
      }

      return {
        ...state,
        queue: remaining,
        nextWorker: (state.nextWorker + 1) % state.workerCount,
      };
    }
    return state;
  },
};

// ============================================================================
// Worker — Processes tasks
// ============================================================================

interface WorkerState {
  id: string;
  processed: number;
}

type WorkerCall = { type: 'getProcessed' };
type WorkerCast = { type: 'process'; task: Task };

function createWorkerBehavior(workerId: string): GenServerBehavior<WorkerState, WorkerCall, WorkerCast, number> {
  return {
    init: () => ({ id: workerId, processed: 0 }),

    handleCall(msg, state) {
      if (msg.type === 'getProcessed') {
        return [state.processed, state];
      }
      return [0, state];
    },

    async handleCast(msg, state) {
      if (msg.type === 'process') {
        // Simulate work
        await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));

        console.log(`[${state.id}] Processed task: ${msg.task.id}`);

        // Publish completion event
        const bus = Registry.whereis<EventBusRef>('event-bus');
        if (bus) {
          EventBus.publish(bus, 'task.completed', {
            taskId: msg.task.id,
            workerId: state.id,
          });
        }

        // Request more work
        const producer = Registry.whereis('producer');
        if (producer) {
          GenServer.cast(producer, { type: 'processNext' });
        }

        return { ...state, processed: state.processed + 1 };
      }
      return state;
    },
  };
}

// ============================================================================
// Monitor — Tracks completions via EventBus
// ============================================================================

interface MonitorState {
  completions: Array<{ taskId: string; workerId: string; timestamp: Date }>;
}

type MonitorCall = { type: 'getCompletions' };

const monitorBehavior: GenServerBehavior<MonitorState, MonitorCall, never, MonitorState['completions']> = {
  init() {
    const bus = Registry.whereis<EventBusRef>('event-bus');
    if (bus) {
      EventBus.subscribe(bus, 'task.completed', (message: { taskId: string; workerId: string }) => {
        console.log(`[Monitor] Task ${message.taskId} completed by ${message.workerId}`);
      });
    }
    return { completions: [] };
  },

  handleCall(msg, state) {
    if (msg.type === 'getCompletions') {
      return [state.completions, state];
    }
    return [[], state];
  },

  handleCast: (_, state) => state,
};

// ============================================================================
// Start System
// ============================================================================

async function startTaskQueue() {
  // EventBus
  await EventBus.start({ name: 'event-bus' });

  // Workers
  await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'worker-0', start: () => GenServer.start(createWorkerBehavior('worker-0'), { name: 'worker-0' }) },
      { id: 'worker-1', start: () => GenServer.start(createWorkerBehavior('worker-1'), { name: 'worker-1' }) },
      { id: 'worker-2', start: () => GenServer.start(createWorkerBehavior('worker-2'), { name: 'worker-2' }) },
    ],
  });

  // Producer and Monitor
  await GenServer.start(producerBehavior, { name: 'producer' });
  await GenServer.start(monitorBehavior, { name: 'monitor' });

  console.log('Task queue system started');
}

// ============================================================================
// Demo
// ============================================================================

async function demo() {
  await startTaskQueue();

  const producer = Registry.lookup('producer');

  // Enqueue tasks using call() — get task IDs back
  const taskIds = await Promise.all([
    GenServer.call(producer, { type: 'enqueue', payload: 'Process image 1' }),
    GenServer.call(producer, { type: 'enqueue', payload: 'Process image 2' }),
    GenServer.call(producer, { type: 'enqueue', payload: 'Process image 3' }),
    GenServer.call(producer, { type: 'enqueue', payload: 'Send email 1' }),
    GenServer.call(producer, { type: 'enqueue', payload: 'Send email 2' }),
  ]);

  console.log('Enqueued tasks:', taskIds);

  // Wait for processing
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Check worker stats
  for (let i = 0; i < 3; i++) {
    const worker = Registry.whereis(`worker-${i}`)!;
    const processed = await GenServer.call(worker, { type: 'getProcessed' });
    console.log(`Worker ${i} processed: ${processed}`);
  }
}
```

### Key Design Points

1. **Producer uses `call()`** for enqueue — caller gets task ID back
2. **Producer uses `cast()`** to trigger processing — non-blocking
3. **Workers use `cast()`** to receive tasks — parallel processing
4. **Workers publish to EventBus** — monitor doesn't need direct reference
5. **Registry** enables all components to find each other by name

</details>

## Summary

- **Three communication mechanisms** serve different purposes:
  - `call()` — request-response, blocking
  - `cast()` — fire-and-forget, non-blocking
  - EventBus — pub/sub, many receivers

- **Registry** decouples components through named lookup:
  - `Registry.register()` — register by name
  - `Registry.lookup()` / `Registry.whereis()` — find by name
  - Automatic cleanup on process termination

- **EventBus** enables broadcasting:
  - `EventBus.subscribe()` — listen to topic patterns
  - `EventBus.publish()` — broadcast to all subscribers
  - Wildcard patterns (`user.*`, `*`)

- **Choose the right tool**:
  - Need response? → `call()`
  - Single recipient, no response? → `cast()`
  - Multiple recipients? → EventBus
  - Don't have reference? → Registry

The combination of these three mechanisms gives you all the building blocks for complex distributed systems while maintaining loose coupling and fault tolerance.

---

Next: [Patterns](./03-patterns.md)
