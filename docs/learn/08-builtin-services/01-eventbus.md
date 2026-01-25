# EventBus

In the previous chapters, you learned to communicate between processes using direct `call` and `cast`. But what happens when you need to notify many processes about an event, or when producers shouldn't know about consumers? This is where **EventBus** comes in — a publish-subscribe messaging system built on noex's GenServer foundation.

## What You'll Learn

- How pub/sub messaging decouples event producers from consumers
- Subscribe to events using exact matches and wildcard patterns
- Choose between fire-and-forget (`publish`) and synchronized (`publishSync`) delivery
- Build event-driven architectures with multiple independent buses
- Handle errors in subscribers without affecting other handlers

## Why Pub/Sub?

Direct process communication (`call`/`cast`) works well when you know exactly who needs to receive a message. But many scenarios require **loose coupling**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    DIRECT VS PUB/SUB COMMUNICATION                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  DIRECT (call/cast):                  PUB/SUB (EventBus):                   │
│                                                                             │
│  Producer knows all consumers         Producer knows only the topic         │
│                                                                             │
│  ┌──────────┐                         ┌──────────┐                          │
│  │ UserSvc  │──────┐                  │ UserSvc  │                          │
│  └──────────┘      │                  └────┬─────┘                          │
│                    ▼                       │                                │
│  ┌──────────┐   ┌──────────┐              │ publish('user.created')         │
│  │ EmailSvc │◄──│  Order   │              ▼                                 │
│  └──────────┘   │   Svc    │         ┌─────────┐                            │
│                 └──────────┘         │EventBus │                            │
│  ┌──────────┐        │               └────┬────┘                            │
│  │  Audit   │◄───────┘                    │                                 │
│  │   Svc    │                    ┌────────┼────────┐                        │
│  └──────────┘                    ▼        ▼        ▼                        │
│                            ┌────────┐ ┌────────┐ ┌────────┐                 │
│  Adding new consumer       │ Email  │ │ Order  │ │ Audit  │                 │
│  = change producer code    │  Svc   │ │  Svc   │ │  Svc   │                 │
│                            └────────┘ └────────┘ └────────┘                 │
│                                                                             │
│                            Adding new consumer = just subscribe             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Use pub/sub when:**
- Multiple consumers need the same event
- Producers shouldn't know about consumers (loose coupling)
- New consumers might be added later without changing producers
- Events are notifications, not requests (no response needed)

**Keep using direct calls when:**
- You need a response from the recipient
- There's exactly one recipient
- Tight coupling is intentional (service-to-service contracts)

## Starting an EventBus

EventBus is built on GenServer. Each bus is an independent process:

```typescript
import { EventBus } from '@hamicek/noex';

// Start an unnamed EventBus
const bus = await EventBus.start();

// Start a named EventBus (registered in the registry)
const namedBus = await EventBus.start({ name: 'app-events' });

// Check if running
console.log(EventBus.isRunning(bus)); // true

// Clean up when done
await EventBus.stop(bus);
```

Multiple buses are completely independent — messages published to one never reach subscribers of another:

```typescript
const userEvents = await EventBus.start({ name: 'user-events' });
const orderEvents = await EventBus.start({ name: 'order-events' });

// These are isolated event streams
EventBus.publish(userEvents, 'created', { userId: '123' });
EventBus.publish(orderEvents, 'created', { orderId: '456' });
```

## Subscribing to Events

Subscriptions use **topic patterns** to filter which events a handler receives:

```typescript
const bus = await EventBus.start();

// Subscribe returns an unsubscribe function
const unsubscribe = await EventBus.subscribe(
  bus,
  'user.created',  // Topic pattern
  (message, topic) => {
    console.log(`Received on ${topic}:`, message);
  }
);

// Later: unsubscribe when no longer interested
await unsubscribe();
```

The handler receives two arguments:
1. **message** — The event payload (typed via generic parameter)
2. **topic** — The actual topic the message was published to

### Typed Subscriptions

Use TypeScript generics for type-safe handlers:

```typescript
interface UserCreatedEvent {
  userId: string;
  email: string;
  timestamp: number;
}

await EventBus.subscribe<UserCreatedEvent>(
  bus,
  'user.created',
  (event, topic) => {
    // event is typed as UserCreatedEvent
    console.log(`User ${event.userId} created: ${event.email}`);
  }
);
```

## Topic Patterns

EventBus supports three types of pattern matching:

### Exact Match

The pattern must exactly match the published topic:

```typescript
await EventBus.subscribe(bus, 'user.created', handler);

EventBus.publish(bus, 'user.created', data);  // ✅ Matches
EventBus.publish(bus, 'user.updated', data);  // ❌ No match
EventBus.publish(bus, 'user.created.admin', data); // ❌ No match
```

### Single-Level Wildcard (`*`)

A `*` matches exactly one segment (segments are separated by dots):

```typescript
// Matches any event in the 'user' namespace
await EventBus.subscribe(bus, 'user.*', handler);

EventBus.publish(bus, 'user.created', data); // ✅ Matches
EventBus.publish(bus, 'user.deleted', data); // ✅ Matches
EventBus.publish(bus, 'user.profile.updated', data); // ❌ No match (2 segments after 'user')
EventBus.publish(bus, 'order.created', data); // ❌ No match
```

Multiple wildcards work segment by segment:

```typescript
// Match events like 'user.123.action'
await EventBus.subscribe(bus, 'user.*.action', handler);

EventBus.publish(bus, 'user.123.action', data);   // ✅ Matches
EventBus.publish(bus, 'user.456.action', data);   // ✅ Matches
EventBus.publish(bus, 'user.action', data);       // ❌ No match (missing middle segment)
EventBus.publish(bus, 'user.123.other', data);    // ❌ No match
```

### Global Wildcard (`*`)

A standalone `*` matches all topics:

```typescript
// Receive ALL events (useful for logging/debugging)
await EventBus.subscribe(bus, '*', (message, topic) => {
  console.log(`[${topic}]`, message);
});

EventBus.publish(bus, 'user.created', data);   // ✅ Matches
EventBus.publish(bus, 'order.placed', data);   // ✅ Matches
EventBus.publish(bus, 'anything.at.all', data); // ✅ Matches
```

### Pattern Matching Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TOPIC PATTERN MATCHING                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Published Topic          Pattern             Match?                        │
│  ─────────────────────────────────────────────────────────                  │
│  'user.created'           'user.created'      ✅ Exact match               │
│  'user.created'           'user.*'            ✅ Wildcard matches segment  │
│  'user.created'           '*'                 ✅ Global wildcard            │
│  'user.created'           'user.deleted'      ❌ Different segment          │
│  'user.profile.updated'   'user.*'            ❌ Too many segments          │
│  'user.123.email'         'user.*.email'      ✅ Middle wildcard            │
│  'user.123.email'         '*.*.email'         ✅ Multiple wildcards         │
│  'order.created'          'user.*'            ❌ Different prefix           │
│                                                                             │
│  Segments:   topic.split('.')                                               │
│  Matching:   Each * matches exactly one segment                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Publishing Events

EventBus offers two publishing modes with different delivery guarantees:

### Fire-and-Forget (`publish`)

The default mode returns immediately without waiting for handlers:

```typescript
// Returns immediately — handlers run asynchronously
EventBus.publish(bus, 'user.created', {
  userId: '123',
  email: 'alice@example.com'
});

// You can publish many events rapidly
for (const user of users) {
  EventBus.publish(bus, 'user.created', user);
}
```

**Characteristics:**
- Non-blocking — returns immediately
- No guarantee handlers have run when `publish()` returns
- Best for high-throughput scenarios
- Uses GenServer `cast()` internally

### Synchronized Publishing (`publishSync`)

Wait for all handlers to complete before returning:

```typescript
// Waits for all matching handlers to be invoked
await EventBus.publishSync(bus, 'user.created', {
  userId: '123',
  email: 'alice@example.com'
});

// At this point, all handlers have been called
console.log('All handlers completed');
```

**Characteristics:**
- Blocking — waits for handler invocation
- Guarantees all handlers have been called when the promise resolves
- Best for testing and when ordering matters
- Uses `cast()` + `call()` internally for synchronization

### When to Use Each Mode

```typescript
// High-throughput logging — use publish()
EventBus.publish(bus, 'request.received', requestData);

// Test assertions — use publishSync()
await EventBus.publishSync(bus, 'order.placed', order);
expect(emailSentToUser).toBe(true); // Now safe to assert

// Event sequencing — use publishSync()
await EventBus.publishSync(bus, 'step.1.complete', data);
await EventBus.publishSync(bus, 'step.2.complete', data);
// Steps are guaranteed to be processed in order
```

## Error Handling

EventBus is **fault-tolerant** — if one handler throws, other handlers still run:

```typescript
await EventBus.subscribe(bus, 'user.created', () => {
  throw new Error('Handler 1 failed!');
});

await EventBus.subscribe(bus, 'user.created', (msg) => {
  console.log('Handler 2 received:', msg);
});

await EventBus.subscribe(bus, 'user.created', (msg) => {
  console.log('Handler 3 received:', msg);
});

// All three handlers are called, even though handler 1 throws
await EventBus.publishSync(bus, 'user.created', { id: '123' });
// Output:
// Handler 2 received: { id: '123' }
// Handler 3 received: { id: '123' }
```

This isolation ensures that a bug in one subscriber doesn't break the entire event system.

## Unsubscribing

The `subscribe()` function returns an unsubscribe function:

```typescript
const unsubscribe = await EventBus.subscribe(bus, 'user.*', handler);

// Later, when done with the subscription
await unsubscribe();
```

The unsubscribe function is:
- **Idempotent** — calling multiple times is safe
- **Safe after stop** — won't throw if bus is already stopped

```typescript
await unsubscribe(); // Removes subscription
await unsubscribe(); // Safe, no effect
await EventBus.stop(bus);
await unsubscribe(); // Still safe
```

## Monitoring Subscriptions

Check the state of your EventBus:

```typescript
// Count of active subscriptions
const count = await EventBus.getSubscriptionCount(bus);
console.log(`Active subscriptions: ${count}`);

// List all subscribed patterns
const topics = await EventBus.getTopics(bus);
console.log(`Patterns: ${topics.join(', ')}`);
// e.g., "user.*, order.created, *"
```

## Practical Example: User Lifecycle Events

Here's a complete example showing how different services subscribe to user events:

```typescript
import { EventBus, type EventBusRef } from '@hamicek/noex';

// Event types
interface UserCreatedEvent {
  userId: string;
  email: string;
  name: string;
}

interface UserDeletedEvent {
  userId: string;
  reason: string;
}

interface UserEvent {
  userId: string;
  action: string;
  timestamp: number;
}

// Email service subscribes to specific events
async function startEmailService(bus: EventBusRef) {
  await EventBus.subscribe<UserCreatedEvent>(
    bus,
    'user.created',
    (event) => {
      console.log(`[Email] Sending welcome email to ${event.email}`);
    }
  );

  await EventBus.subscribe<UserDeletedEvent>(
    bus,
    'user.deleted',
    (event) => {
      console.log(`[Email] Sending goodbye email for user ${event.userId}`);
    }
  );
}

// Audit service logs all user events
async function startAuditService(bus: EventBusRef) {
  await EventBus.subscribe<UserEvent>(
    bus,
    'user.*',  // Catches all user.* events
    (event, topic) => {
      console.log(`[Audit] ${topic}: user=${event.userId}`);
    }
  );
}

// Analytics tracks everything
async function startAnalyticsService(bus: EventBusRef) {
  await EventBus.subscribe(
    bus,
    '*',  // All events
    (event, topic) => {
      console.log(`[Analytics] Event tracked: ${topic}`);
    }
  );
}

// Main application
async function main() {
  const bus = await EventBus.start({ name: 'app-events' });

  // Start services (order doesn't matter)
  await startEmailService(bus);
  await startAuditService(bus);
  await startAnalyticsService(bus);

  // Simulate user creation
  await EventBus.publishSync(bus, 'user.created', {
    userId: 'u123',
    email: 'alice@example.com',
    name: 'Alice',
    action: 'created',
    timestamp: Date.now(),
  });

  // Output:
  // [Email] Sending welcome email to alice@example.com
  // [Audit] user.created: user=u123
  // [Analytics] Event tracked: user.created

  // Simulate user deletion
  await EventBus.publishSync(bus, 'user.deleted', {
    userId: 'u123',
    reason: 'Account closed by user',
    action: 'deleted',
    timestamp: Date.now(),
  });

  // Output:
  // [Email] Sending goodbye email for user u123
  // [Audit] user.deleted: user=u123
  // [Analytics] Event tracked: user.deleted

  await EventBus.stop(bus);
}

main();
```

## Event-Driven Architecture Patterns

### Pattern 1: Domain Event Broadcasting

Each domain publishes events; other domains subscribe:

```typescript
// Order domain publishes
EventBus.publish(bus, 'order.placed', {
  orderId: 'o123',
  userId: 'u456',
  total: 99.99,
});

// Inventory domain subscribes
await EventBus.subscribe(bus, 'order.placed', async (order) => {
  await reserveInventory(order.orderId);
});

// Notification domain subscribes
await EventBus.subscribe(bus, 'order.placed', async (order) => {
  await sendOrderConfirmation(order.userId, order.orderId);
});
```

### Pattern 2: Event Logging / Debugging

Subscribe to all events for debugging:

```typescript
// Development-only event logging
if (process.env.NODE_ENV === 'development') {
  await EventBus.subscribe(bus, '*', (event, topic) => {
    console.log(`[DEBUG] ${new Date().toISOString()} ${topic}:`,
      JSON.stringify(event, null, 2));
  });
}
```

### Pattern 3: Event Replay for Testing

Use `publishSync` to ensure deterministic test execution:

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('Order flow', () => {
  it('sends confirmation email on order placed', async () => {
    const bus = await EventBus.start();
    const emailSent = vi.fn();

    await EventBus.subscribe(bus, 'order.placed', () => {
      emailSent();
    });

    await EventBus.publishSync(bus, 'order.placed', { orderId: '123' });

    expect(emailSent).toHaveBeenCalledOnce();

    await EventBus.stop(bus);
  });
});
```

## EventBus Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EVENTBUS INTERNALS                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                        EventBus GenServer                            │    │
│  │                                                                      │    │
│  │  State:                                                              │    │
│  │  ┌───────────────────────────────────────────────────────────────┐   │    │
│  │  │  subscriptions: Map<id, { pattern, handler }>                 │   │    │
│  │  │  patternIndex: Map<pattern, Set<subscription_ids>>            │   │    │
│  │  │  nextSubscriptionId: number                                   │   │    │
│  │  └───────────────────────────────────────────────────────────────┘   │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  publish(topic, message)                     subscribe(pattern, handler)    │
│         │                                             │                     │
│         ▼                                             ▼                     │
│  ┌──────────────┐                            ┌──────────────┐               │
│  │ cast: Publish│                            │ call: Subscribe              │
│  └──────┬───────┘                            └──────┬───────┘               │
│         │                                           │                       │
│         ▼                                           ▼                       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                         handleCast / handleCall                       │   │
│  │                                                                       │   │
│  │  On Publish:                          On Subscribe:                   │   │
│  │  1. For each subscription             1. Generate unique ID           │   │
│  │  2. If pattern matches topic          2. Store {id, pattern, handler} │   │
│  │  3. Invoke handler(message, topic)    3. Add to patternIndex          │   │
│  │  4. Catch errors (don't propagate)    4. Return unsubscribe function  │   │
│  │                                                                       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Exercise: Notification Hub

Build a notification hub that routes messages to different channels based on event type:

**Requirements:**
1. Support three notification channels: email, SMS, and push
2. Each channel subscribes to specific event patterns
3. Track delivery statistics per channel
4. Support priority events that go to all channels

**Starter code:**

```typescript
import { EventBus, type EventBusRef } from '@hamicek/noex';

interface NotificationEvent {
  userId: string;
  title: string;
  body: string;
  priority?: 'low' | 'normal' | 'high';
}

function createNotificationHub() {
  let bus: EventBusRef;
  const stats = {
    email: 0,
    sms: 0,
    push: 0,
  };

  return {
    async start() {
      bus = await EventBus.start({ name: 'notifications' });

      // TODO: Subscribe email channel to 'notify.email' and 'notify.all'
      // TODO: Subscribe SMS channel to 'notify.sms' and 'notify.all'
      // TODO: Subscribe push channel to 'notify.push' and 'notify.all'
      // TODO: High priority events ('notify.priority') go to ALL channels
    },

    sendEmail(event: NotificationEvent): void {
      // TODO: Publish to email channel
    },

    sendSms(event: NotificationEvent): void {
      // TODO: Publish to SMS channel
    },

    sendPush(event: NotificationEvent): void {
      // TODO: Publish to push channel
    },

    sendAll(event: NotificationEvent): void {
      // TODO: Publish to all channels
    },

    sendPriority(event: NotificationEvent): void {
      // TODO: Publish high-priority event
    },

    getStats() {
      return { ...stats };
    },

    async stop() {
      await EventBus.stop(bus);
    },
  };
}
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
import { EventBus, type EventBusRef } from '@hamicek/noex';

interface NotificationEvent {
  userId: string;
  title: string;
  body: string;
  priority?: 'low' | 'normal' | 'high';
}

function createNotificationHub() {
  let bus: EventBusRef;
  const stats = {
    email: 0,
    sms: 0,
    push: 0,
  };

  // Channel handlers (in production, these would actually send notifications)
  function handleEmail(event: NotificationEvent) {
    console.log(`[EMAIL] To: ${event.userId} | ${event.title}: ${event.body}`);
    stats.email++;
  }

  function handleSms(event: NotificationEvent) {
    console.log(`[SMS] To: ${event.userId} | ${event.title}`);
    stats.sms++;
  }

  function handlePush(event: NotificationEvent) {
    console.log(`[PUSH] To: ${event.userId} | ${event.title}: ${event.body}`);
    stats.push++;
  }

  return {
    async start() {
      bus = await EventBus.start({ name: 'notifications' });

      // Email channel: responds to email and broadcast events
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.email',
        handleEmail
      );
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.all',
        handleEmail
      );
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.priority',
        handleEmail
      );

      // SMS channel: responds to sms and broadcast events
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.sms',
        handleSms
      );
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.all',
        handleSms
      );
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.priority',
        handleSms
      );

      // Push channel: responds to push and broadcast events
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.push',
        handlePush
      );
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.all',
        handlePush
      );
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.priority',
        handlePush
      );
    },

    sendEmail(event: NotificationEvent): void {
      EventBus.publish(bus, 'notify.email', event);
    },

    sendSms(event: NotificationEvent): void {
      EventBus.publish(bus, 'notify.sms', event);
    },

    sendPush(event: NotificationEvent): void {
      EventBus.publish(bus, 'notify.push', event);
    },

    sendAll(event: NotificationEvent): void {
      EventBus.publish(bus, 'notify.all', event);
    },

    sendPriority(event: NotificationEvent): void {
      // Mark as high priority and send to dedicated priority topic
      EventBus.publish(bus, 'notify.priority', {
        ...event,
        priority: 'high',
      });
    },

    getStats() {
      return { ...stats };
    },

    async stop() {
      await EventBus.stop(bus);
    },
  };
}

// Test the notification hub
async function main() {
  const hub = createNotificationHub();
  await hub.start();

  // Send to specific channels
  hub.sendEmail({ userId: 'u1', title: 'Welcome', body: 'Welcome to our app!' });
  hub.sendSms({ userId: 'u2', title: 'Code', body: 'Your code is 1234' });
  hub.sendPush({ userId: 'u3', title: 'New message', body: 'You have a new message' });

  // Send to all channels
  hub.sendAll({ userId: 'u4', title: 'Announcement', body: 'System maintenance tonight' });

  // Priority notification (reaches all channels)
  hub.sendPriority({ userId: 'u5', title: 'URGENT', body: 'Security alert!' });

  // Wait for async handlers
  await new Promise((resolve) => setTimeout(resolve, 100));

  console.log('Stats:', hub.getStats());
  // Stats: { email: 3, sms: 3, push: 3 }
  // (1 direct + 1 all + 1 priority for each channel)

  await hub.stop();
}

main();
```

**Alternative approach using wildcards:**

```typescript
// More elegant: use wildcard pattern for broadcast topics
async start() {
  bus = await EventBus.start({ name: 'notifications' });

  // Each channel subscribes to its own topic + wildcard for broadcasts
  await EventBus.subscribe<NotificationEvent>(bus, 'notify.email', handleEmail);
  await EventBus.subscribe<NotificationEvent>(bus, 'notify.sms', handleSms);
  await EventBus.subscribe<NotificationEvent>(bus, 'notify.push', handlePush);

  // Broadcast handler with 'notify.broadcast.*' pattern
  await EventBus.subscribe<NotificationEvent>(bus, 'notify.broadcast.*', (event, topic) => {
    // Route to all channels for broadcast events
    handleEmail(event);
    handleSms(event);
    handlePush(event);
  });
}

sendAll(event: NotificationEvent): void {
  EventBus.publish(bus, 'notify.broadcast.all', event);
}

sendPriority(event: NotificationEvent): void {
  EventBus.publish(bus, 'notify.broadcast.priority', {
    ...event,
    priority: 'high',
  });
}
```

**Design decisions:**

1. **Separate subscriptions for each topic** — Clear and explicit routing
2. **Stats tracking in handlers** — Each handler increments its channel counter
3. **Fire-and-forget publishing** — Notifications are async; we don't wait for delivery
4. **Broadcast via dedicated topics** — `notify.all` and `notify.priority` reach all channels

</details>

## Summary

**Key takeaways:**

- **EventBus provides pub/sub messaging** — Decouple event producers from consumers
- **Three pattern types** — Exact match, single-level wildcard (`*`), and global wildcard
- **Two publishing modes** — `publish()` for fire-and-forget, `publishSync()` for guaranteed delivery
- **Fault-tolerant handlers** — One failing handler doesn't affect others
- **Multiple independent buses** — Isolate different event domains

**EventBus vs direct communication:**

| Scenario | Use EventBus | Use call/cast |
|----------|--------------|---------------|
| Multiple consumers | ✅ | ❌ |
| Need response | ❌ | ✅ |
| Loose coupling | ✅ | ❌ |
| Event notifications | ✅ | ❌ |
| Service contracts | ❌ | ✅ |
| Testing/debugging | ✅ (with `*`) | ❌ |

**Remember:**

> EventBus shines when you need to broadcast events without knowing (or caring) who's listening. Keep your event topics consistent and well-documented — they become the contract between publishers and subscribers.

---

Next: [Cache](./02-cache.md)
