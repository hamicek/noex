# Why Supervisor?

In the previous chapters, you learned how to create GenServers, manage their lifecycle, and communicate using `call` and `cast`. Your processes work great when everything goes right. But what happens when things go wrong?

**Processes fail.** Network connections drop. External APIs timeout. Bugs slip through testing. In traditional Node.js applications, you'd wrap everything in try-catch blocks, add retry logic, and hope you've covered every edge case. It's defensive programming taken to the extreme, and it still doesn't guarantee reliability.

Supervisors offer a fundamentally different approach: **instead of preventing failures, embrace them and recover automatically**.

## What You'll Learn

- Why processes fail and why that's okay
- How supervisors provide automatic recovery
- Isolation benefits of the supervision pattern
- The "Let it Crash" philosophy

## Processes Fail - That's Normal

Every production system eventually encounters failures:

- **External dependencies fail**: APIs return errors, databases lose connections, message queues become unavailable
- **Resources run out**: Memory leaks accumulate, file descriptors exhaust, connection pools fill up
- **Bugs exist**: Edge cases slip through testing, race conditions manifest under load, data corruption occurs
- **Hardware has problems**: Network partitions happen, disks fail, processes get OOM-killed

Traditional approach: wrap everything in defensive code:

```typescript
// Traditional Node.js - defensive programming everywhere
async function processOrder(orderId: string) {
  let connection;
  try {
    connection = await getConnection();
    try {
      const order = await connection.query('SELECT * FROM orders WHERE id = ?', [orderId]);
      if (!order) {
        throw new Error('Order not found');
      }

      try {
        await paymentService.charge(order.customerId, order.total);
      } catch (paymentError) {
        // Payment failed - retry? rollback? log? notify?
        console.error('Payment failed:', paymentError);
        // What state is the order in now?
        throw paymentError;
      }

      try {
        await inventoryService.reserve(order.items);
      } catch (inventoryError) {
        // Inventory failed - need to refund the payment?
        try {
          await paymentService.refund(order.customerId, order.total);
        } catch (refundError) {
          // Refund failed too - now what?
          console.error('Refund also failed:', refundError);
        }
        throw inventoryError;
      }

      return order;
    } finally {
      await connection.release();
    }
  } catch (connectionError) {
    // Connection failed - retry the whole thing?
    console.error('Connection failed:', connectionError);
    throw connectionError;
  }
}
```

This code is:
- **Hard to read**: The actual business logic is buried under error handling
- **Hard to maintain**: Every new feature needs its own error handling
- **Incomplete**: What if `connection.release()` throws? What if the process crashes between payment and inventory?
- **State-corrupting**: When errors cascade, you don't know what state things are in

## Automatic Recovery with Supervisors

A Supervisor is a process that **monitors other processes** (its children) and **restarts them when they fail**. Instead of handling every possible failure, you let processes crash and let the supervisor restart them in a clean state.

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from '@hamicek/noex';

// Your process - focused on business logic, not error handling
interface OrderProcessorState {
  orderId: string;
  status: 'pending' | 'processing' | 'completed';
}

type OrderCall = { type: 'process' } | { type: 'getStatus' };
type OrderCast = never;
type OrderReply = OrderProcessorState['status'];

const orderProcessorBehavior: GenServerBehavior<OrderProcessorState, OrderCall, OrderCast, OrderReply> = {
  init() {
    return { orderId: '', status: 'pending' };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'process':
        // If this throws, the process crashes and gets restarted
        // No try-catch needed - supervisor handles recovery
        return ['processing', { ...state, status: 'processing' }];
      case 'getStatus':
        return [state.status, state];
    }
  },

  handleCast(_msg, state) {
    return state;
  },
};

// Supervisor watches and restarts on failure
const supervisor = await Supervisor.start({
  children: [
    {
      id: 'order-processor',
      start: () => GenServer.start(orderProcessorBehavior),
    },
  ],
});
```

When the order processor crashes:
1. Supervisor detects the failure immediately
2. A new instance is started automatically
3. The new instance begins with clean state
4. The system continues operating

**No manual retry logic. No cascading error handlers. No corrupted state.**

## Isolation - Failure Containment

Each supervised process runs in isolation. When one process crashes, it doesn't affect others:

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'users', start: () => GenServer.start(userServiceBehavior) },
    { id: 'orders', start: () => GenServer.start(orderServiceBehavior) },
    { id: 'payments', start: () => GenServer.start(paymentServiceBehavior) },
    { id: 'notifications', start: () => GenServer.start(notificationBehavior) },
  ],
});
```

If the `notifications` service crashes:
- `users`, `orders`, and `payments` **keep running** without interruption
- Only `notifications` gets restarted
- Users don't experience a total system outage

Compare this to traditional Node.js where an uncaught exception in one module can crash the entire process:

```typescript
// Traditional Node.js - one uncaught exception crashes everything
app.post('/notify', async (req, res) => {
  await sendNotification(req.body); // If this throws unexpectedly...
  res.json({ success: true });
});
// ...your entire Express server goes down
```

With supervision, failures are **contained**. A bug in notifications doesn't take down your payment processing.

## The "Let it Crash" Philosophy

This pattern comes from Erlang's OTP, where it's called "Let it Crash". The philosophy is counterintuitive at first:

> **Don't try to prevent all failures. Instead, make failures cheap and recovery fast.**

Why this works:

1. **Clean slate on restart**: When a process restarts, it begins with known-good initial state. No corrupted state to debug.

2. **Simpler code**: Instead of handling every possible error, focus on the happy path. Let the supervisor handle the rest.

3. **Transient errors resolve themselves**: Many failures (network blips, temporary resource exhaustion) fix themselves when you retry with a fresh start.

4. **Bugs become visible**: Crashes are logged and tracked. Silent failures that corrupt state are much harder to diagnose.

```typescript
// "Let it Crash" style - focused on the happy path
const cacheRefreshBehavior: GenServerBehavior<CacheState, RefreshMsg, never, void> = {
  init() {
    return { data: new Map(), lastRefresh: Date.now() };
  },

  async handleCall(msg, state) {
    if (msg.type === 'refresh') {
      // If this fails, we crash and restart with empty cache
      // The supervisor will restart us, and we'll try again
      const freshData = await fetchFromDatabase();
      return [undefined, { data: freshData, lastRefresh: Date.now() }];
    }
    return [undefined, state];
  },

  handleCast(_msg, state) {
    return state;
  },
};
```

## When Not to "Let it Crash"

The philosophy doesn't mean ignoring all errors. You should still:

- **Validate input at system boundaries**: Reject invalid data before it enters your processes
- **Handle expected errors gracefully**: If a user provides invalid credentials, return an error, don't crash
- **Persist important state**: Use persistence adapters so state survives restarts when needed

"Let it Crash" is for **unexpected failures** - the bugs, network issues, and edge cases you can't anticipate.

## Real-World Analogy

Think of supervision like a restaurant kitchen:

**Traditional approach (no supervisor)**: The head chef handles everything. If one cook makes a mistake, the head chef has to fix it while also managing all other cooks and their tasks. One bad situation cascades into chaos.

**Supervision approach**: Each station (grill, prep, pastry) has a line cook. If the grill cook burns something, they throw it out and start fresh. The head chef (supervisor) only steps in if the same station keeps failing repeatedly. Other stations keep working normally.

## Summary

- **Processes fail** - network issues, bugs, resource exhaustion are inevitable
- **Supervisors automatically restart** failed processes with clean state
- **Isolation** ensures one failure doesn't cascade to the entire system
- **"Let it Crash"** means focusing on the happy path and letting recovery happen automatically
- **Simpler code** because you don't need defensive try-catch blocks everywhere
- **Use supervision for unexpected failures**, not for expected error conditions

The supervisor pattern shifts your mindset from "prevent all failures" to "recover quickly from any failure". This approach has powered telecom systems with 99.9999999% uptime (nine nines) for over 30 years.

---

Next: [First Supervisor](./02-first-supervisor.md)
