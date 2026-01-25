# Order Workflow Example

In the previous chapters, you learned when to use GenStateMachine and how to define states and events. Now let's build a complete, production-ready example: an **e-commerce order workflow**.

This is the canonical state machine example — orders naturally have states (pending, paid, shipped, delivered) and clear transitions (pay, ship, deliver, cancel). By the end of this chapter, you'll see how all the GenStateMachine concepts come together in a real application.

## What You'll Learn

- Building a complete order state machine from scratch
- Handling all valid transitions and rejecting invalid ones
- Using timeouts for payment deadlines and shipping reminders
- Managing error states and recovery
- Integrating with external services (payments, shipping)
- Testing state machine behavior

## The Order Lifecycle

Before writing any code, let's map out the order states and transitions:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          ORDER STATE MACHINE                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                              ┌────────────┐                                 │
│                              │  PENDING   │                                 │
│                              │  (start)   │                                 │
│                              └─────┬──────┘                                 │
│                                    │                                        │
│              ┌─────────────────────┼─────────────────────┐                  │
│              │                     │                     │                  │
│              ▼                     ▼                     ▼                  │
│       ┌────────────┐        ┌────────────┐        ┌────────────┐           │
│       │ CANCELLED  │◄───────│   PAID     │        │  EXPIRED   │           │
│       │            │        │            │        │ (timeout)  │           │
│       └────────────┘        └─────┬──────┘        └────────────┘           │
│              ▲                    │                     ▲                   │
│              │                    │                     │                   │
│              │                    ▼                     │                   │
│              │             ┌────────────┐               │                   │
│              ├─────────────│  SHIPPED   │───────────────┘                   │
│              │             │            │  (delivery timeout)               │
│              │             └─────┬──────┘                                   │
│              │                   │                                          │
│              │                   ▼                                          │
│              │             ┌────────────┐                                   │
│              └─────────────│ DELIVERED  │                                   │
│               (refund)     │  (final)   │                                   │
│                            └────────────┘                                   │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  TRANSITIONS:                                                               │
│  • pending → paid       : Customer completes payment                        │
│  • pending → cancelled  : Customer cancels, timeout, or payment fails       │
│  • pending → expired    : Payment deadline exceeded (24h timeout)           │
│  • paid → shipped       : Warehouse ships the order                         │
│  • paid → cancelled     : Admin cancels (refund issued)                     │
│  • shipped → delivered  : Carrier confirms delivery                         │
│  • shipped → expired    : Delivery deadline exceeded (30 days timeout)      │
│  • delivered → cancelled: Customer requests refund (within 14 days)         │
│                                                                             │
│  TERMINAL STATES: cancelled, expired, delivered (after refund window)       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Implementation

### Types Definition

First, let's define our types with precision:

```typescript
import {
  GenStateMachine,
  type StateMachineBehavior,
  type TimeoutEvent,
  type DeferredReply,
} from '@hamicek/noex';

// All possible order states
type OrderState =
  | 'pending'
  | 'paid'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'expired';

// All possible events
type OrderEvent =
  // Customer actions
  | { type: 'pay'; paymentId: string; amount: number }
  | { type: 'cancel'; reason: string }
  | { type: 'request_refund'; reason: string }
  // System events
  | { type: 'payment_confirmed'; transactionId: string }
  | { type: 'payment_failed'; error: string }
  // Warehouse events
  | { type: 'ship'; trackingNumber: string; carrier: string }
  | { type: 'mark_shipped'; trackingNumber: string }
  // Delivery events
  | { type: 'deliver'; signature?: string }
  | { type: 'delivery_failed'; reason: string }
  // Admin events
  | { type: 'admin_cancel'; adminId: string; reason: string }
  | { type: 'process_refund' }
  // Query events (for callWithReply)
  | { type: 'get_status' };

// Order data that persists across states
interface OrderData {
  orderId: string;
  customerId: string;
  items: Array<{ productId: string; quantity: number; price: number }>;
  totalAmount: number;
  currency: string;

  // Payment info
  paymentId: string | null;
  transactionId: string | null;
  paidAt: number | null;

  // Shipping info
  trackingNumber: string | null;
  carrier: string | null;
  shippedAt: number | null;

  // Delivery info
  deliveredAt: number | null;
  deliverySignature: string | null;

  // Cancellation info
  cancelledAt: number | null;
  cancellationReason: string | null;
  refundStatus: 'none' | 'pending' | 'completed' | null;

  // Timestamps
  createdAt: number;
  updatedAt: number;

  // Audit log
  history: Array<{
    timestamp: number;
    fromState: OrderState;
    toState: OrderState;
    event: string;
    details?: string;
  }>;
}
```

### The Order Behavior

Now let's implement the complete state machine:

```typescript
// Timeout constants
const PAYMENT_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours to pay
const DELIVERY_TIMEOUT = 30 * 24 * 60 * 60 * 1000; // 30 days to deliver
const REFUND_WINDOW = 14 * 24 * 60 * 60 * 1000; // 14 days to request refund

// Helper to create initial order data
function createOrderData(
  orderId: string,
  customerId: string,
  items: OrderData['items']
): OrderData {
  const totalAmount = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  return {
    orderId,
    customerId,
    items,
    totalAmount,
    currency: 'USD',
    paymentId: null,
    transactionId: null,
    paidAt: null,
    trackingNumber: null,
    carrier: null,
    shippedAt: null,
    deliveredAt: null,
    deliverySignature: null,
    cancelledAt: null,
    cancellationReason: null,
    refundStatus: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [],
  };
}

// Helper to add history entry
function addHistory(
  data: OrderData,
  fromState: OrderState,
  toState: OrderState,
  event: string,
  details?: string
): OrderData {
  return {
    ...data,
    updatedAt: Date.now(),
    history: [
      ...data.history,
      {
        timestamp: Date.now(),
        fromState,
        toState,
        event,
        details,
      },
    ],
  };
}

// The order workflow behavior
const orderBehavior: StateMachineBehavior<OrderState, OrderEvent, OrderData> = {
  init: () => {
    // This would typically receive order data from the caller
    // For this example, we'll create a placeholder
    const data = createOrderData('order-001', 'customer-001', [
      { productId: 'prod-1', quantity: 2, price: 29.99 },
      { productId: 'prod-2', quantity: 1, price: 49.99 },
    ]);

    return {
      state: 'pending',
      data,
      // Start payment timeout immediately
      actions: [
        {
          type: 'generic_timeout',
          name: 'payment_deadline',
          time: PAYMENT_TIMEOUT,
        },
      ],
    };
  },

  states: {
    // ==================== PENDING STATE ====================
    pending: {
      onEnter(data) {
        console.log(`[Order ${data.orderId}] Created, awaiting payment`);
        console.log(`  Total: $${data.totalAmount.toFixed(2)}`);
        console.log(`  Payment deadline: 24 hours`);
      },

      handleEvent(event, data, from) {
        // Handle timeout
        const timeoutEvent = event as TimeoutEvent;
        if (
          timeoutEvent.type === 'timeout' &&
          timeoutEvent.timeoutType === 'generic_timeout' &&
          timeoutEvent.name === 'payment_deadline'
        ) {
          return {
            type: 'transition',
            nextState: 'expired',
            data: addHistory(data, 'pending', 'expired', 'payment_timeout', 'Payment deadline exceeded'),
          };
        }

        // Handle status query
        if (event.type === 'get_status' && from) {
          return {
            type: 'keep_state_and_data',
            actions: [
              {
                type: 'reply',
                to: from,
                value: {
                  state: 'pending',
                  orderId: data.orderId,
                  totalAmount: data.totalAmount,
                  message: 'Awaiting payment',
                },
              },
            ],
          };
        }

        // Customer initiates payment
        if (event.type === 'pay') {
          // Validate amount
          if (event.amount !== data.totalAmount) {
            console.log(`[Order ${data.orderId}] Payment amount mismatch`);
            return { type: 'keep_state_and_data' };
          }

          return {
            type: 'keep_state',
            data: {
              ...data,
              paymentId: event.paymentId,
              updatedAt: Date.now(),
            },
          };
        }

        // Payment processor confirms
        if (event.type === 'payment_confirmed') {
          return {
            type: 'transition',
            nextState: 'paid',
            data: addHistory(
              {
                ...data,
                transactionId: event.transactionId,
                paidAt: Date.now(),
              },
              'pending',
              'paid',
              'payment_confirmed',
              `Transaction: ${event.transactionId}`
            ),
          };
        }

        // Payment failed
        if (event.type === 'payment_failed') {
          console.log(`[Order ${data.orderId}] Payment failed: ${event.error}`);
          return {
            type: 'transition',
            nextState: 'cancelled',
            data: addHistory(
              {
                ...data,
                cancelledAt: Date.now(),
                cancellationReason: `Payment failed: ${event.error}`,
              },
              'pending',
              'cancelled',
              'payment_failed',
              event.error
            ),
          };
        }

        // Customer cancels
        if (event.type === 'cancel') {
          return {
            type: 'transition',
            nextState: 'cancelled',
            data: addHistory(
              {
                ...data,
                cancelledAt: Date.now(),
                cancellationReason: event.reason,
              },
              'pending',
              'cancelled',
              'customer_cancel',
              event.reason
            ),
          };
        }

        return { type: 'keep_state_and_data' };
      },

      onExit(data, nextState) {
        console.log(`[Order ${data.orderId}] Leaving pending → ${nextState}`);
      },
    },

    // ==================== PAID STATE ====================
    paid: {
      onEnter(data) {
        console.log(`[Order ${data.orderId}] Payment confirmed!`);
        console.log(`  Transaction: ${data.transactionId}`);
        console.log(`  Ready for shipping`);
      },

      handleEvent(event, data, from) {
        // Handle status query
        if (event.type === 'get_status' && from) {
          return {
            type: 'keep_state_and_data',
            actions: [
              {
                type: 'reply',
                to: from,
                value: {
                  state: 'paid',
                  orderId: data.orderId,
                  transactionId: data.transactionId,
                  message: 'Paid, awaiting shipment',
                },
              },
            ],
          };
        }

        // Warehouse ships the order
        if (event.type === 'ship') {
          return {
            type: 'transition',
            nextState: 'shipped',
            data: addHistory(
              {
                ...data,
                trackingNumber: event.trackingNumber,
                carrier: event.carrier,
                shippedAt: Date.now(),
              },
              'paid',
              'shipped',
              'shipped',
              `${event.carrier}: ${event.trackingNumber}`
            ),
            actions: [
              // Start delivery timeout
              {
                type: 'generic_timeout',
                name: 'delivery_deadline',
                time: DELIVERY_TIMEOUT,
              },
            ],
          };
        }

        // Admin cancels (with refund)
        if (event.type === 'admin_cancel') {
          return {
            type: 'transition',
            nextState: 'cancelled',
            data: addHistory(
              {
                ...data,
                cancelledAt: Date.now(),
                cancellationReason: `Admin (${event.adminId}): ${event.reason}`,
                refundStatus: 'pending',
              },
              'paid',
              'cancelled',
              'admin_cancel',
              `Admin ${event.adminId}: ${event.reason}`
            ),
            // Trigger refund processing
            actions: [{ type: 'next_event', event: { type: 'process_refund' } }],
          };
        }

        // Prevent customer cancel after payment (must go through admin)
        if (event.type === 'cancel') {
          console.log(`[Order ${data.orderId}] Cannot cancel paid order directly`);
          return { type: 'keep_state_and_data' };
        }

        return { type: 'keep_state_and_data' };
      },
    },

    // ==================== SHIPPED STATE ====================
    shipped: {
      onEnter(data) {
        console.log(`[Order ${data.orderId}] Shipped!`);
        console.log(`  Carrier: ${data.carrier}`);
        console.log(`  Tracking: ${data.trackingNumber}`);
      },

      handleEvent(event, data, from) {
        // Handle timeout
        const timeoutEvent = event as TimeoutEvent;
        if (
          timeoutEvent.type === 'timeout' &&
          timeoutEvent.timeoutType === 'generic_timeout' &&
          timeoutEvent.name === 'delivery_deadline'
        ) {
          console.log(`[Order ${data.orderId}] Delivery deadline exceeded!`);
          return {
            type: 'transition',
            nextState: 'expired',
            data: addHistory(
              data,
              'shipped',
              'expired',
              'delivery_timeout',
              'Delivery deadline exceeded after 30 days'
            ),
          };
        }

        // Handle status query
        if (event.type === 'get_status' && from) {
          return {
            type: 'keep_state_and_data',
            actions: [
              {
                type: 'reply',
                to: from,
                value: {
                  state: 'shipped',
                  orderId: data.orderId,
                  carrier: data.carrier,
                  trackingNumber: data.trackingNumber,
                  message: 'In transit',
                },
              },
            ],
          };
        }

        // Delivery confirmed
        if (event.type === 'deliver') {
          return {
            type: 'transition',
            nextState: 'delivered',
            data: addHistory(
              {
                ...data,
                deliveredAt: Date.now(),
                deliverySignature: event.signature || null,
              },
              'shipped',
              'delivered',
              'delivered',
              event.signature ? `Signed by: ${event.signature}` : 'Left at door'
            ),
            actions: [
              // Start refund window timer
              {
                type: 'generic_timeout',
                name: 'refund_window',
                time: REFUND_WINDOW,
              },
            ],
          };
        }

        // Delivery failed - return to paid for re-shipping
        if (event.type === 'delivery_failed') {
          console.log(`[Order ${data.orderId}] Delivery failed: ${event.reason}`);
          return {
            type: 'transition',
            nextState: 'paid',
            data: addHistory(
              {
                ...data,
                trackingNumber: null,
                carrier: null,
                shippedAt: null,
              },
              'shipped',
              'paid',
              'delivery_failed',
              event.reason
            ),
          };
        }

        return { type: 'keep_state_and_data' };
      },
    },

    // ==================== DELIVERED STATE ====================
    delivered: {
      onEnter(data) {
        console.log(`[Order ${data.orderId}] Delivered!`);
        if (data.deliverySignature) {
          console.log(`  Signed by: ${data.deliverySignature}`);
        }
        console.log(`  Refund window: 14 days`);
      },

      handleEvent(event, data, from) {
        // Handle refund window timeout
        const timeoutEvent = event as TimeoutEvent;
        if (
          timeoutEvent.type === 'timeout' &&
          timeoutEvent.timeoutType === 'generic_timeout' &&
          timeoutEvent.name === 'refund_window'
        ) {
          console.log(`[Order ${data.orderId}] Refund window closed - order complete`);
          // Order is now final - no state change needed, just log
          return { type: 'keep_state_and_data' };
        }

        // Handle status query
        if (event.type === 'get_status' && from) {
          const refundWindowOpen = data.deliveredAt
            ? Date.now() - data.deliveredAt < REFUND_WINDOW
            : false;

          return {
            type: 'keep_state_and_data',
            actions: [
              {
                type: 'reply',
                to: from,
                value: {
                  state: 'delivered',
                  orderId: data.orderId,
                  deliveredAt: data.deliveredAt,
                  refundWindowOpen,
                  message: refundWindowOpen
                    ? 'Delivered - refund available'
                    : 'Delivered - order complete',
                },
              },
            ],
          };
        }

        // Customer requests refund within window
        if (event.type === 'request_refund') {
          // Check if still within refund window
          if (data.deliveredAt && Date.now() - data.deliveredAt > REFUND_WINDOW) {
            console.log(`[Order ${data.orderId}] Refund window expired`);
            return { type: 'keep_state_and_data' };
          }

          return {
            type: 'transition',
            nextState: 'cancelled',
            data: addHistory(
              {
                ...data,
                cancelledAt: Date.now(),
                cancellationReason: `Refund requested: ${event.reason}`,
                refundStatus: 'pending',
              },
              'delivered',
              'cancelled',
              'refund_requested',
              event.reason
            ),
            actions: [{ type: 'next_event', event: { type: 'process_refund' } }],
          };
        }

        return { type: 'keep_state_and_data' };
      },
    },

    // ==================== CANCELLED STATE ====================
    cancelled: {
      onEnter(data) {
        console.log(`[Order ${data.orderId}] Cancelled`);
        console.log(`  Reason: ${data.cancellationReason}`);
        if (data.refundStatus === 'pending') {
          console.log(`  Refund: pending`);
        }
      },

      handleEvent(event, data, from) {
        // Handle status query
        if (event.type === 'get_status' && from) {
          return {
            type: 'keep_state_and_data',
            actions: [
              {
                type: 'reply',
                to: from,
                value: {
                  state: 'cancelled',
                  orderId: data.orderId,
                  reason: data.cancellationReason,
                  refundStatus: data.refundStatus,
                  message: 'Order cancelled',
                },
              },
            ],
          };
        }

        // Process refund (triggered by next_event action)
        if (event.type === 'process_refund' && data.refundStatus === 'pending') {
          console.log(`[Order ${data.orderId}] Processing refund of $${data.totalAmount}`);
          // In real app, this would call payment processor
          return {
            type: 'keep_state',
            data: {
              ...data,
              refundStatus: 'completed',
              updatedAt: Date.now(),
            },
          };
        }

        // Terminal state - ignore most events
        return { type: 'keep_state_and_data' };
      },
    },

    // ==================== EXPIRED STATE ====================
    expired: {
      onEnter(data) {
        console.log(`[Order ${data.orderId}] Expired`);
        const reason = data.history[data.history.length - 1]?.details || 'Timeout';
        console.log(`  Reason: ${reason}`);
      },

      handleEvent(event, data, from) {
        // Handle status query
        if (event.type === 'get_status' && from) {
          return {
            type: 'keep_state_and_data',
            actions: [
              {
                type: 'reply',
                to: from,
                value: {
                  state: 'expired',
                  orderId: data.orderId,
                  message: 'Order expired due to timeout',
                },
              },
            ],
          };
        }

        // Terminal state
        return { type: 'keep_state_and_data' };
      },
    },
  },

  terminate(reason, state, data) {
    console.log(`[Order ${data.orderId}] Process terminated in ${state} state`);
    console.log(`  Reason: ${reason}`);
    console.log(`  History entries: ${data.history.length}`);
  },
};
```

## Usage Example

Here's how to use the order state machine in practice:

```typescript
async function orderDemo() {
  // Start a new order
  const order = await GenStateMachine.start(orderBehavior, {
    name: 'order-12345',
  });

  // Check initial status
  const initialStatus = await GenStateMachine.callWithReply<{ state: string; message: string }>(
    order,
    { type: 'get_status' }
  );
  console.log('Initial status:', initialStatus);
  // { state: 'pending', orderId: 'order-001', totalAmount: 109.97, message: 'Awaiting payment' }

  // Customer initiates payment
  GenStateMachine.cast(order, {
    type: 'pay',
    paymentId: 'pay-abc123',
    amount: 109.97,
  });

  // Payment processor confirms (in real app, this comes from webhook)
  await GenStateMachine.call(order, {
    type: 'payment_confirmed',
    transactionId: 'txn-xyz789',
  });

  // Check status after payment
  const paidStatus = await GenStateMachine.callWithReply(order, { type: 'get_status' });
  console.log('After payment:', paidStatus);

  // Warehouse ships the order
  await GenStateMachine.call(order, {
    type: 'ship',
    trackingNumber: '1Z999AA10123456784',
    carrier: 'UPS',
  });

  // Carrier confirms delivery
  await GenStateMachine.call(order, {
    type: 'deliver',
    signature: 'John Doe',
  });

  // Final status
  const finalStatus = await GenStateMachine.callWithReply(order, { type: 'get_status' });
  console.log('Final status:', finalStatus);
  // { state: 'delivered', orderId: 'order-001', deliveredAt: ..., refundWindowOpen: true, ... }

  // Clean up
  await GenStateMachine.stop(order);
}
```

## Testing Order Workflows

Testing state machines is straightforward — you drive them through scenarios and verify the states:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Order Workflow', () => {
  let order: StateMachineRef<OrderState, OrderEvent, OrderData>;

  beforeEach(async () => {
    order = await GenStateMachine.start(orderBehavior, { name: 'test-order' });
  });

  afterEach(async () => {
    await GenStateMachine.stop(order);
  });

  it('should start in pending state', async () => {
    const state = await GenStateMachine.getState(order);
    expect(state).toBe('pending');
  });

  it('should transition to paid after payment confirmation', async () => {
    // Initiate payment
    GenStateMachine.cast(order, { type: 'pay', paymentId: 'pay-1', amount: 109.97 });

    // Confirm payment
    await GenStateMachine.call(order, {
      type: 'payment_confirmed',
      transactionId: 'txn-1',
    });

    const state = await GenStateMachine.getState(order);
    expect(state).toBe('paid');
  });

  it('should transition to cancelled on payment failure', async () => {
    await GenStateMachine.call(order, {
      type: 'payment_failed',
      error: 'Insufficient funds',
    });

    const state = await GenStateMachine.getState(order);
    expect(state).toBe('cancelled');
  });

  it('should prevent customer cancel after payment', async () => {
    // Pay first
    GenStateMachine.cast(order, { type: 'pay', paymentId: 'pay-1', amount: 109.97 });
    await GenStateMachine.call(order, { type: 'payment_confirmed', transactionId: 'txn-1' });

    // Try to cancel
    GenStateMachine.cast(order, { type: 'cancel', reason: 'Changed my mind' });

    // Should still be paid
    const state = await GenStateMachine.getState(order);
    expect(state).toBe('paid');
  });

  it('should complete full happy path', async () => {
    // Pay
    GenStateMachine.cast(order, { type: 'pay', paymentId: 'pay-1', amount: 109.97 });
    await GenStateMachine.call(order, { type: 'payment_confirmed', transactionId: 'txn-1' });
    expect(await GenStateMachine.getState(order)).toBe('paid');

    // Ship
    await GenStateMachine.call(order, {
      type: 'ship',
      trackingNumber: '123456',
      carrier: 'FedEx',
    });
    expect(await GenStateMachine.getState(order)).toBe('shipped');

    // Deliver
    await GenStateMachine.call(order, { type: 'deliver', signature: 'Jane Doe' });
    expect(await GenStateMachine.getState(order)).toBe('delivered');
  });

  it('should handle delivery failure with re-shipping', async () => {
    // Get to shipped state
    GenStateMachine.cast(order, { type: 'pay', paymentId: 'pay-1', amount: 109.97 });
    await GenStateMachine.call(order, { type: 'payment_confirmed', transactionId: 'txn-1' });
    await GenStateMachine.call(order, { type: 'ship', trackingNumber: '123', carrier: 'UPS' });

    // Delivery fails
    await GenStateMachine.call(order, {
      type: 'delivery_failed',
      reason: 'Address not found',
    });

    // Should be back to paid for re-shipping
    expect(await GenStateMachine.getState(order)).toBe('paid');
  });
});
```

## Key Patterns Demonstrated

### 1. Generic Timeouts for Business Deadlines

We use `generic_timeout` for payment and delivery deadlines because these timeouts must survive state transitions:

```typescript
// Payment deadline starts in 'pending', might fire in 'pending'
actions: [{ type: 'generic_timeout', name: 'payment_deadline', time: PAYMENT_TIMEOUT }]

// Delivery deadline starts in 'shipped', fires in 'shipped' or later
actions: [{ type: 'generic_timeout', name: 'delivery_deadline', time: DELIVERY_TIMEOUT }]
```

### 2. next_event for Immediate Follow-up

When an admin cancels a paid order, we automatically trigger refund processing:

```typescript
// In 'paid' state, admin_cancel handler
return {
  type: 'transition',
  nextState: 'cancelled',
  data: { ...data, refundStatus: 'pending' },
  actions: [{ type: 'next_event', event: { type: 'process_refund' } }],
};
```

### 3. callWithReply for Status Queries

Using `callWithReply` with `DeferredReply` allows synchronous status queries:

```typescript
// Handler receives 'from' parameter
handleEvent(event, data, from) {
  if (event.type === 'get_status' && from) {
    return {
      type: 'keep_state_and_data',
      actions: [{ type: 'reply', to: from, value: { state: 'pending', ... } }],
    };
  }
}

// Caller gets the response
const status = await GenStateMachine.callWithReply(order, { type: 'get_status' });
```

### 4. Audit Trail with History

Every transition logs to the history array for compliance and debugging:

```typescript
function addHistory(data, fromState, toState, event, details) {
  return {
    ...data,
    history: [...data.history, { timestamp: Date.now(), fromState, toState, event, details }],
  };
}
```

### 5. Invalid Transition Prevention

The state structure naturally prevents invalid transitions. For example, you can't ship an order that isn't paid:

```typescript
// In 'pending' state, there's no handler for 'ship' event
// It falls through to: return { type: 'keep_state_and_data' };
```

## Exercise: Add Express Return Flow

Extend the order workflow with an express return capability:

**Requirements:**
1. Add a new state: `return_requested`
2. From `delivered` state, customer can request a return (different from refund)
3. Return must be initiated within 30 days of delivery
4. Returns require admin approval before transitioning to `cancelled` with refund
5. If admin rejects return, order goes back to `delivered` state
6. Add new events: `request_return`, `approve_return`, `reject_return`

### Solution

<details>
<summary>Click to reveal solution</summary>

```typescript
// Add to OrderState type
type OrderState =
  | 'pending'
  | 'paid'
  | 'shipped'
  | 'delivered'
  | 'return_requested'  // NEW
  | 'cancelled'
  | 'expired';

// Add new events
type OrderEvent =
  // ... existing events ...
  | { type: 'request_return'; reason: string }
  | { type: 'approve_return'; adminId: string }
  | { type: 'reject_return'; adminId: string; reason: string };

// Update OrderData
interface OrderData {
  // ... existing fields ...
  returnRequestedAt: number | null;
  returnReason: string | null;
}

const RETURN_WINDOW = 30 * 24 * 60 * 60 * 1000; // 30 days

// Add to states object
const orderBehaviorExtended: StateMachineBehavior<OrderState, OrderEvent, OrderData> = {
  // ... init and other states ...

  states: {
    // ... existing states ...

    // Update delivered state to handle return requests
    delivered: {
      handleEvent(event, data, from) {
        // ... existing handlers ...

        // Customer requests return
        if (event.type === 'request_return') {
          // Check if still within return window
          if (data.deliveredAt && Date.now() - data.deliveredAt > RETURN_WINDOW) {
            console.log(`[Order ${data.orderId}] Return window expired`);
            return { type: 'keep_state_and_data' };
          }

          return {
            type: 'transition',
            nextState: 'return_requested',
            data: addHistory(
              {
                ...data,
                returnRequestedAt: Date.now(),
                returnReason: event.reason,
              },
              'delivered',
              'return_requested',
              'return_requested',
              event.reason
            ),
            actions: [
              // Admin has 7 days to review
              { type: 'state_timeout', time: 7 * 24 * 60 * 60 * 1000 },
            ],
          };
        }

        return { type: 'keep_state_and_data' };
      },
    },

    // NEW: return_requested state
    return_requested: {
      onEnter(data) {
        console.log(`[Order ${data.orderId}] Return requested`);
        console.log(`  Reason: ${data.returnReason}`);
        console.log(`  Awaiting admin review (7 day timeout)`);
      },

      handleEvent(event, data, from) {
        // Handle review timeout - auto-approve after 7 days
        const timeoutEvent = event as TimeoutEvent;
        if (timeoutEvent.type === 'timeout' && timeoutEvent.timeoutType === 'state_timeout') {
          console.log(`[Order ${data.orderId}] Return auto-approved after timeout`);
          return {
            type: 'transition',
            nextState: 'cancelled',
            data: addHistory(
              {
                ...data,
                cancelledAt: Date.now(),
                cancellationReason: `Return approved (auto): ${data.returnReason}`,
                refundStatus: 'pending',
              },
              'return_requested',
              'cancelled',
              'return_auto_approved',
              'Admin review timeout - auto-approved'
            ),
            actions: [{ type: 'next_event', event: { type: 'process_refund' } }],
          };
        }

        // Handle status query
        if (event.type === 'get_status' && from) {
          return {
            type: 'keep_state_and_data',
            actions: [
              {
                type: 'reply',
                to: from,
                value: {
                  state: 'return_requested',
                  orderId: data.orderId,
                  returnReason: data.returnReason,
                  message: 'Return pending admin approval',
                },
              },
            ],
          };
        }

        // Admin approves return
        if (event.type === 'approve_return') {
          return {
            type: 'transition',
            nextState: 'cancelled',
            data: addHistory(
              {
                ...data,
                cancelledAt: Date.now(),
                cancellationReason: `Return approved by ${event.adminId}: ${data.returnReason}`,
                refundStatus: 'pending',
              },
              'return_requested',
              'cancelled',
              'return_approved',
              `Approved by admin ${event.adminId}`
            ),
            actions: [{ type: 'next_event', event: { type: 'process_refund' } }],
          };
        }

        // Admin rejects return
        if (event.type === 'reject_return') {
          return {
            type: 'transition',
            nextState: 'delivered',
            data: addHistory(
              {
                ...data,
                returnRequestedAt: null,
                returnReason: null,
              },
              'return_requested',
              'delivered',
              'return_rejected',
              `Rejected by admin ${event.adminId}: ${event.reason}`
            ),
          };
        }

        return { type: 'keep_state_and_data' };
      },

      onExit(data, nextState) {
        console.log(`[Order ${data.orderId}] Return review complete → ${nextState}`);
      },
    },
  },
};
```

</details>

## Summary

In this chapter, you built a complete order workflow that demonstrates:

- **Complete state coverage**: All business states (pending, paid, shipped, delivered, cancelled, expired) with clear responsibilities
- **Timeout management**: Payment deadlines, delivery tracking, and refund windows using generic timeouts
- **Event handling**: Customer actions, system events, admin overrides, all handled appropriately per state
- **Error recovery**: Delivery failures return to paid state for re-shipping
- **Audit trail**: Every transition logged with timestamp and details
- **Status queries**: Using `callWithReply` for synchronous state inspection
- **Testing**: Driving the state machine through scenarios to verify behavior

This pattern scales to any workflow: payment processing, document approval, ticket management, subscription lifecycle, and more. The key insight is that **GenStateMachine makes your state diagram executable** — the code structure mirrors the business logic exactly.

---

Next: [Why Persistence?](../06-persistence/01-why-persistence.md)
