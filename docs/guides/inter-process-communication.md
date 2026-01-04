# Inter-Process Communication

This guide covers how processes (GenServers) communicate with each other in noex. Understanding these patterns is essential for building well-architected applications.

## Overview

noex provides several communication patterns:

| Pattern | Mechanism | Use Case |
|---------|-----------|----------|
| **Direct** | `GenServer.call/cast` | One-to-one, known target |
| **Named** | `Registry` | One-to-one, decoupled |
| **Pub/Sub** | `EventBus` | One-to-many, events |
| **Supervised** | Pass refs at startup | Parent-child communication |

---

## Direct Communication

The simplest pattern: one process directly calls another using its reference.

### Synchronous: call()

Use `call()` when you need a response:

```typescript
import { GenServer } from 'noex';

// Service A calls Service B
const result = await GenServer.call(serviceBRef, {
  type: 'get_user',
  id: userId,
});
```

**Characteristics:**
- Blocks until response received
- Propagates errors to caller
- Default 5-second timeout

### Asynchronous: cast()

Use `cast()` for fire-and-forget messages:

```typescript
// Notify logger without waiting
GenServer.cast(loggerRef, {
  type: 'log',
  level: 'info',
  message: 'User logged in',
});
```

**Characteristics:**
- Returns immediately
- No response or confirmation
- Errors are not propagated

### Passing References

For direct communication, services need each other's references:

```typescript
// Option 1: Pass at startup via init args
const orderService = await GenServer.start({
  init: () => ({
    userServiceRef: userServiceRef,
    orders: new Map(),
  }),
  // ...
});

// Option 2: Pass via cast message
GenServer.cast(orderServiceRef, {
  type: 'set_user_service',
  ref: userServiceRef,
});

// Option 3: Store in state from behavior factory
function createOrderBehavior(deps: { userService: UserServiceRef }) {
  return {
    init: () => ({
      userService: deps.userService,
      orders: new Map(),
    }),
    // ...
  };
}
```

---

## Named Communication with Registry

Registry enables communication without passing references explicitly.

### Registering Services

```typescript
import { GenServer, Registry } from 'noex';

// Start and register
const userService = await GenServer.start(userBehavior);
Registry.register('user-service', userService);

// Or register during start
const cacheService = await GenServer.start(cacheBehavior, {
  name: 'cache-service',  // Auto-registers in Registry
});
```

### Looking Up Services

```typescript
// Get reference by name
const userService = Registry.lookup('user-service');
const result = await GenServer.call(userService, { type: 'get_all' });

// Safe lookup (returns undefined instead of throwing)
const cache = Registry.whereis('cache-service');
if (cache) {
  await GenServer.call(cache, { type: 'get', key: 'users' });
}
```

### Type-Safe Lookups

```typescript
// Define service types
type UserServiceRef = GenServerRef<UserState, UserCall, UserCast, UserReply>;

// Typed lookup
const userService = Registry.lookup<UserState, UserCall, UserCast, UserReply>(
  'user-service'
);

// Now fully typed
const user = await GenServer.call(userService, { type: 'get', id: '123' });
```

### Automatic Cleanup

Registry automatically removes entries when processes terminate:

```typescript
const ref = await GenServer.start(behavior);
Registry.register('my-service', ref);

Registry.isRegistered('my-service');  // true

await GenServer.stop(ref);

Registry.isRegistered('my-service');  // false (auto-removed)
```

### When to Use Registry

**Good for:**
- Well-known singleton services (e.g., "cache", "logger", "config")
- Services that many components need to access
- Decoupling service implementations from their consumers

**Avoid for:**
- Dynamic/temporary processes
- Multiple instances of the same service type
- Performance-critical paths (slight lookup overhead)

---

## Pub/Sub with EventBus

EventBus enables one-to-many communication through topics.

### Basic Usage

```typescript
import { EventBus } from 'noex';

// Start event bus
const bus = await EventBus.start();

// Subscribe to topic
const unsubscribe = await EventBus.subscribe(bus, 'user.created', (data) => {
  console.log('New user:', data);
});

// Publish event
EventBus.publish(bus, 'user.created', { id: '123', name: 'Alice' });

// Cleanup
unsubscribe();
await EventBus.stop(bus);
```

### Topic Patterns

EventBus supports wildcard patterns:

```typescript
// Exact match
await EventBus.subscribe(bus, 'user.created', handler);
// Matches: 'user.created'

// Single-level wildcard
await EventBus.subscribe(bus, 'user.*', handler);
// Matches: 'user.created', 'user.deleted', 'user.updated'

// Global wildcard
await EventBus.subscribe(bus, '*', handler);
// Matches: everything
```

### Synchronous Publishing

For testing or when order matters:

```typescript
// Fire-and-forget (default)
EventBus.publish(bus, 'order.placed', order);

// Wait for handlers to be invoked
await EventBus.publishSync(bus, 'order.placed', order);
```

### Example: Event-Driven Architecture

```typescript
// Define events
interface UserCreatedEvent {
  userId: string;
  email: string;
  timestamp: number;
}

interface OrderPlacedEvent {
  orderId: string;
  userId: string;
  items: string[];
}

// Central event bus
const eventBus = await EventBus.start({ name: 'event-bus' });

// Email service subscribes to relevant events
await EventBus.subscribe<UserCreatedEvent>(
  eventBus,
  'user.created',
  (event) => {
    sendWelcomeEmail(event.email);
  }
);

await EventBus.subscribe<OrderPlacedEvent>(
  eventBus,
  'order.*',
  (event, topic) => {
    if (topic === 'order.placed') {
      sendOrderConfirmation(event);
    }
  }
);

// Analytics subscribes to everything
await EventBus.subscribe(eventBus, '*', (event, topic) => {
  trackEvent(topic, event);
});

// Publishing from services
function createUserService(bus: EventBusRef) {
  return {
    async createUser(email: string) {
      const user = { id: generateId(), email };
      // ... save user ...

      EventBus.publish(bus, 'user.created', {
        userId: user.id,
        email: user.email,
        timestamp: Date.now(),
      });

      return user;
    },
  };
}
```

### When to Use EventBus

**Good for:**
- Cross-cutting concerns (logging, analytics, notifications)
- Decoupled event-driven architecture
- Multiple services need to react to same event
- Broadcasting state changes

**Avoid for:**
- Request/response patterns (use `call` instead)
- When you need confirmation of delivery
- Performance-critical, high-frequency communication

---

## Communication Patterns

### Pattern 1: Service Mesh

Services communicate through a central registry:

```typescript
// All services register themselves
Registry.register('user-service', userService);
Registry.register('order-service', orderService);
Registry.register('inventory-service', inventoryService);

// Any service can lookup another
// In order-service:
handleCall: async (msg, state) => {
  const inventory = Registry.lookup('inventory-service');
  const available = await GenServer.call(inventory, {
    type: 'check_stock',
    productId: msg.productId,
  });
  // ...
},
```

### Pattern 2: Event Sourcing

All state changes are published as events:

```typescript
const eventBus = await EventBus.start({ name: 'events' });

// Order service publishes all changes
GenServer.cast(orderService, { type: 'place_order', ...orderData });
// Internally publishes: 'order.placed'

GenServer.cast(orderService, { type: 'ship_order', orderId });
// Internally publishes: 'order.shipped'

GenServer.cast(orderService, { type: 'complete_order', orderId });
// Internally publishes: 'order.completed'

// Other services react to events
await EventBus.subscribe(eventBus, 'order.*', updateOrderProjection);
await EventBus.subscribe(eventBus, 'order.placed', sendOrderNotification);
await EventBus.subscribe(eventBus, 'order.shipped', updateShipmentTracking);
```

### Pattern 3: Request Aggregation

One service aggregates data from multiple sources:

```typescript
// API Gateway aggregates responses
const apiGatewayBehavior = {
  handleCall: async (msg, state) => {
    if (msg.type === 'get_dashboard') {
      // Parallel requests to multiple services
      const [user, orders, notifications] = await Promise.all([
        GenServer.call(Registry.lookup('user-service'), {
          type: 'get',
          id: msg.userId,
        }),
        GenServer.call(Registry.lookup('order-service'), {
          type: 'list_recent',
          userId: msg.userId,
        }),
        GenServer.call(Registry.lookup('notification-service'), {
          type: 'get_unread',
          userId: msg.userId,
        }),
      ]);

      return [{ user, orders, notifications }, state];
    }
  },
};
```

### Pattern 4: Pipeline Processing

Sequential processing through a chain of services:

```typescript
// Image processing pipeline
const uploadService = await GenServer.start(createUploadBehavior({
  next: Registry.lookup('resize-service'),
}));

const resizeService = await GenServer.start(createResizeBehavior({
  next: Registry.lookup('optimize-service'),
}));

const optimizeService = await GenServer.start(createOptimizeBehavior({
  next: Registry.lookup('storage-service'),
}));

// Usage: upload -> resize -> optimize -> store
await GenServer.call(uploadService, { type: 'process', file: imageData });
```

---

## Error Handling in Communication

### Handling Call Failures

```typescript
import { CallTimeoutError, ServerNotRunningError } from 'noex';

try {
  const result = await GenServer.call(service, msg, { timeout: 3000 });
} catch (error) {
  if (error instanceof CallTimeoutError) {
    // Service is slow or stuck
    console.error('Call timed out');
  } else if (error instanceof ServerNotRunningError) {
    // Service has stopped
    console.error('Service not available');
  } else {
    // Application error from handleCall
    console.error('Call failed:', error);
  }
}
```

### Handling Missing Services

```typescript
// Safe pattern with Registry
function getService(name: string) {
  const service = Registry.whereis(name);
  if (!service) {
    throw new Error(`Service '${name}' not available`);
  }
  return service;
}

// Or with fallback
async function getUserWithFallback(userId: string) {
  const userService = Registry.whereis('user-service');
  if (userService) {
    return GenServer.call(userService, { type: 'get', id: userId });
  }
  // Fallback: fetch directly from database
  return fetchUserFromDb(userId);
}
```

### Circuit Breaker Pattern

```typescript
interface CircuitState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

async function callWithCircuitBreaker(
  ref: GenServerRef,
  msg: unknown,
  circuit: CircuitState,
  threshold = 5,
  resetTimeout = 30000,
) {
  // Check if circuit is open
  if (circuit.isOpen) {
    const now = Date.now();
    if (now - circuit.lastFailure < resetTimeout) {
      throw new Error('Circuit is open');
    }
    // Try to reset
    circuit.isOpen = false;
    circuit.failures = 0;
  }

  try {
    const result = await GenServer.call(ref, msg, { timeout: 5000 });
    circuit.failures = 0;
    return result;
  } catch (error) {
    circuit.failures++;
    circuit.lastFailure = Date.now();
    if (circuit.failures >= threshold) {
      circuit.isOpen = true;
    }
    throw error;
  }
}
```

---

## Best Practices

### 1. Prefer Explicit Dependencies

```typescript
// Good: Dependencies are clear
function createOrderService(deps: {
  userService: UserServiceRef;
  inventoryService: InventoryServiceRef;
}) {
  return {
    init: () => ({
      userService: deps.userService,
      inventoryService: deps.inventoryService,
      orders: new Map(),
    }),
    // ...
  };
}

// Avoid: Hidden dependencies via Registry lookup in handlers
handleCall: async (msg, state) => {
  const userService = Registry.lookup('user-service');  // Implicit dependency
  // ...
},
```

### 2. Use Appropriate Patterns

| Situation | Pattern |
|-----------|---------|
| Need response | `call()` |
| Fire-and-forget | `cast()` |
| Singleton service | Registry |
| Multiple subscribers | EventBus |
| Tightly coupled | Pass refs directly |
| Loosely coupled | Registry or EventBus |

### 3. Handle Timeouts Gracefully

```typescript
// Set appropriate timeouts
const result = await GenServer.call(slowService, msg, {
  timeout: 30000,  // 30s for slow operations
});

// Or use a wrapper
async function callWithRetry(ref, msg, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await GenServer.call(ref, msg, { timeout: 5000 });
    } catch (error) {
      if (i === retries - 1) throw error;
      await delay(1000 * (i + 1));  // Exponential backoff
    }
  }
}
```

### 4. Document Service Contracts

```typescript
/**
 * UserService - Manages user accounts
 *
 * Call Messages:
 * - { type: 'get', id: string } → User | null
 * - { type: 'list' } → User[]
 *
 * Cast Messages:
 * - { type: 'create', user: CreateUserInput } → void
 * - { type: 'delete', id: string } → void
 *
 * Events Published:
 * - 'user.created': UserCreatedEvent
 * - 'user.deleted': UserDeletedEvent
 */
```

### 5. Avoid Circular Dependencies

```typescript
// Bad: A calls B, B calls A
// A -> B -> A (deadlock risk!)

// Good: Use events to break cycles
// A publishes event -> B subscribes
// B publishes event -> A subscribes
```

---

## Related

- [Building Services Guide](./building-services.md) - Creating GenServers
- [GenServer Concepts](../concepts/genserver.md) - Understanding GenServer
- [Registry Concepts](../concepts/registry.md) - Named process lookup
- [EventBus API Reference](../api/event-bus.md) - Complete EventBus API
- [Registry API Reference](../api/registry.md) - Complete Registry API
