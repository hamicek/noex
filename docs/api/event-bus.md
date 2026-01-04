# EventBus API Reference

The `EventBus` provides pub/sub messaging between components with topic-based routing and wildcard support.

## Import

```typescript
import { EventBus } from 'noex';
```

## Types

### EventBusRef

Reference to a running EventBus instance.

```typescript
type EventBusRef = GenServerRef<EventBusState, EventBusCallMsg, EventBusCastMsg, EventBusCallReply>;
```

### EventBusOptions

Options for `EventBus.start()`.

```typescript
interface EventBusOptions {
  readonly name?: string;  // Optional registry name
}
```

### MessageHandler

Handler function called when a matching message is published.

```typescript
type MessageHandler<T = unknown> = (message: T, topic: string) => void;
```

---

## Topic Patterns

EventBus supports wildcard patterns for flexible subscription matching:

| Pattern | Matches | Examples |
|---------|---------|----------|
| `'user.created'` | Exact topic only | `'user.created'` |
| `'user.*'` | Any single segment after `user.` | `'user.created'`, `'user.deleted'` |
| `'*'` | All topics | Everything |

**Pattern matching rules:**
- Exact match: `'user.created'` matches only `'user.created'`
- Single wildcard: `*` matches exactly one segment
- Global wildcard: `'*'` alone matches all topics

---

## Methods

### start()

Starts a new EventBus instance.

```typescript
async start(options?: EventBusOptions): Promise<EventBusRef>
```

**Parameters:**
- `options` - Optional configuration
  - `name` - Register in Registry under this name

**Returns:** Promise resolving to EventBusRef

**Example:**
```typescript
const bus = await EventBus.start();

// With name registration
const bus = await EventBus.start({ name: 'main-bus' });
```

---

### subscribe()

Subscribes to messages matching a topic pattern.

```typescript
async subscribe<T = unknown>(
  ref: EventBusRef,
  pattern: string,
  handler: MessageHandler<T>,
): Promise<() => Promise<void>>
```

**Parameters:**
- `ref` - EventBus reference
- `pattern` - Topic pattern to subscribe to
- `handler` - Function called when matching message is published

**Returns:** Promise resolving to an unsubscribe function

**Example:**
```typescript
// Subscribe to specific topic
const unsub = await EventBus.subscribe(bus, 'user.created', (msg, topic) => {
  console.log(`${topic}:`, msg);
});

// Subscribe with wildcard
await EventBus.subscribe(bus, 'user.*', (msg) => {
  console.log('User event:', msg);
});

// Subscribe to all
await EventBus.subscribe(bus, '*', (msg, topic) => {
  console.log(`[${topic}]`, msg);
});

// Unsubscribe
await unsub();
```

---

### publish()

Publishes a message to a topic. Fire-and-forget operation.

```typescript
publish<T = unknown>(ref: EventBusRef, topic: string, message: T): void
```

**Parameters:**
- `ref` - EventBus reference
- `topic` - Topic to publish to
- `message` - Message payload

**Returns:** void (non-blocking)

**Example:**
```typescript
EventBus.publish(bus, 'user.created', { id: '123', name: 'Alice' });
EventBus.publish(bus, 'order.placed', { orderId: '456', total: 99.99 });
```

---

### publishSync()

Publishes a message and waits for all handlers to be invoked.

```typescript
async publishSync<T = unknown>(
  ref: EventBusRef,
  topic: string,
  message: T,
): Promise<void>
```

**Parameters:**
- `ref` - EventBus reference
- `topic` - Topic to publish to
- `message` - Message payload

**Returns:** Promise that resolves after all handlers are invoked

**Example:**
```typescript
// Useful for testing or when ordering matters
await EventBus.publishSync(bus, 'data.ready', { items: [...] });
// All handlers have now been called
processNextStep();
```

---

### getSubscriptionCount()

Returns the number of active subscriptions.

```typescript
async getSubscriptionCount(ref: EventBusRef): Promise<number>
```

**Parameters:**
- `ref` - EventBus reference

**Returns:** Number of subscriptions

**Example:**
```typescript
const count = await EventBus.getSubscriptionCount(bus);
console.log(`${count} active subscriptions`);
```

---

### getTopics()

Returns all subscribed topic patterns.

```typescript
async getTopics(ref: EventBusRef): Promise<readonly string[]>
```

**Parameters:**
- `ref` - EventBus reference

**Returns:** Array of subscribed patterns

**Example:**
```typescript
const topics = await EventBus.getTopics(bus);
console.log('Subscribed patterns:', topics);
// ['user.created', 'user.*', 'order.placed']
```

---

### isRunning()

Checks if the EventBus is running.

```typescript
isRunning(ref: EventBusRef): boolean
```

**Parameters:**
- `ref` - EventBus reference

**Returns:** `true` if running

**Example:**
```typescript
if (EventBus.isRunning(bus)) {
  EventBus.publish(bus, 'status', 'ok');
}
```

---

### stop()

Gracefully stops the EventBus.

```typescript
async stop(ref: EventBusRef): Promise<void>
```

**Parameters:**
- `ref` - EventBus reference

**Returns:** Promise that resolves when stopped

**Example:**
```typescript
await EventBus.stop(bus);
```

---

## Complete Example

```typescript
import { EventBus, type EventBusRef } from 'noex';

// Event types
interface UserCreatedEvent {
  id: string;
  email: string;
  name: string;
}

interface OrderPlacedEvent {
  orderId: string;
  userId: string;
  total: number;
}

// Application event bus
let bus: EventBusRef;

async function initEventBus() {
  bus = await EventBus.start({ name: 'app-events' });

  // Logging subscriber - catches all events
  await EventBus.subscribe(bus, '*', (msg, topic) => {
    console.log(`[EVENT] ${topic}:`, JSON.stringify(msg));
  });

  // Email service - user events
  await EventBus.subscribe<UserCreatedEvent>(bus, 'user.created', async (event) => {
    console.log(`Sending welcome email to ${event.email}`);
  });

  // Analytics - all user events
  await EventBus.subscribe(bus, 'user.*', (event, topic) => {
    console.log(`Analytics: ${topic}`);
  });

  // Inventory service - order events
  await EventBus.subscribe<OrderPlacedEvent>(bus, 'order.placed', (event) => {
    console.log(`Reserving inventory for order ${event.orderId}`);
  });
}

// Publishing events from various parts of the app
function onUserRegistration(user: UserCreatedEvent) {
  EventBus.publish(bus, 'user.created', user);
}

function onOrderSubmit(order: OrderPlacedEvent) {
  EventBus.publish(bus, 'order.placed', order);
}

// Usage
async function main() {
  await initEventBus();

  // Simulate events
  onUserRegistration({ id: '1', email: 'alice@example.com', name: 'Alice' });
  onOrderSubmit({ orderId: 'ORD-001', userId: '1', total: 150.00 });

  // Check status
  const count = await EventBus.getSubscriptionCount(bus);
  console.log(`Active subscriptions: ${count}`);

  // Cleanup
  await EventBus.stop(bus);
}
```

## Use Cases

### Decoupling Components

```typescript
// User service - just publishes
function createUser(data: UserData) {
  const user = saveUser(data);
  EventBus.publish(bus, 'user.created', user);
  return user;
}

// Email service - subscribes independently
EventBus.subscribe(bus, 'user.created', sendWelcomeEmail);

// Analytics - subscribes independently
EventBus.subscribe(bus, 'user.*', trackUserEvent);
```

### Request/Response Pattern

For request/response, use GenServer.call instead. EventBus is for fire-and-forget pub/sub only.

### Error Handling in Handlers

Handlers should not throw. If a handler throws, the error is caught and ignored, and other handlers continue executing.

```typescript
await EventBus.subscribe(bus, 'data', (msg) => {
  try {
    processData(msg);
  } catch (error) {
    console.error('Handler error:', error);
    // Don't re-throw
  }
});
```

## Related

- [GenServer API](./genserver.md) - Underlying implementation
- [Cache API](./cache.md) - Another built-in service
- [RateLimiter API](./rate-limiter.md) - Another built-in service
