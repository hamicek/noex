# Příklad: Workflow objednávky

V předchozích kapitolách jste se naučili kdy použít GenStateMachine a jak definovat stavy a události. Teď vytvořme kompletní, production-ready příklad: **e-commerce workflow objednávky**.

Toto je kanonický příklad stavového automatu - objednávky přirozeně mají stavy (pending, paid, shipped, delivered) a jasné přechody (pay, ship, deliver, cancel). Na konci této kapitoly uvidíte, jak všechny koncepty GenStateMachine zapadají do reálné aplikace.

## Co se naučíte

- Vytvoření kompletního stavového automatu objednávky od základů
- Zpracování všech platných přechodů a odmítnutí neplatných
- Použití timeoutů pro platební deadliny a připomínky doručení
- Správa chybových stavů a recovery
- Integrace s externími službami (platby, doručení)
- Testování chování stavového automatu

## Životní cyklus objednávky

Před psaním jakéhokoliv kódu si zmapujme stavy objednávky a přechody:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          STAVOVÝ AUTOMAT OBJEDNÁVKY                         │
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
│  PŘECHODY:                                                                  │
│  • pending → paid       : Zákazník dokončí platbu                           │
│  • pending → cancelled  : Zákazník zruší, timeout, nebo platba selže        │
│  • pending → expired    : Překročen deadline platby (24h timeout)           │
│  • paid → shipped       : Sklad odešle objednávku                           │
│  • paid → cancelled     : Admin zruší (vystavena refund)                    │
│  • shipped → delivered  : Dopravce potvrdí doručení                         │
│  • shipped → expired    : Překročen deadline doručení (30 dní timeout)      │
│  • delivered → cancelled: Zákazník požádá o refund (do 14 dnů)              │
│                                                                             │
│  TERMINÁLNÍ STAVY: cancelled, expired, delivered (po uzavření refund okna) │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Implementace

### Definice typů

Nejprve definujme naše typy s přesností:

```typescript
import {
  GenStateMachine,
  type StateMachineBehavior,
  type TimeoutEvent,
  type DeferredReply,
} from '@hamicek/noex';

// Všechny možné stavy objednávky
type OrderState =
  | 'pending'
  | 'paid'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'expired';

// Všechny možné události
type OrderEvent =
  // Akce zákazníka
  | { type: 'pay'; paymentId: string; amount: number }
  | { type: 'cancel'; reason: string }
  | { type: 'request_refund'; reason: string }
  // Systémové události
  | { type: 'payment_confirmed'; transactionId: string }
  | { type: 'payment_failed'; error: string }
  // Události ze skladu
  | { type: 'ship'; trackingNumber: string; carrier: string }
  | { type: 'mark_shipped'; trackingNumber: string }
  // Události doručení
  | { type: 'deliver'; signature?: string }
  | { type: 'delivery_failed'; reason: string }
  // Admin události
  | { type: 'admin_cancel'; adminId: string; reason: string }
  | { type: 'process_refund' }
  // Query události (pro callWithReply)
  | { type: 'get_status' };

// Data objednávky, která přetrvávají napříč stavy
interface OrderData {
  orderId: string;
  customerId: string;
  items: Array<{ productId: string; quantity: number; price: number }>;
  totalAmount: number;
  currency: string;

  // Info o platbě
  paymentId: string | null;
  transactionId: string | null;
  paidAt: number | null;

  // Info o doručení
  trackingNumber: string | null;
  carrier: string | null;
  shippedAt: number | null;

  // Info o doručení
  deliveredAt: number | null;
  deliverySignature: string | null;

  // Info o zrušení
  cancelledAt: number | null;
  cancellationReason: string | null;
  refundStatus: 'none' | 'pending' | 'completed' | null;

  // Časová razítka
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

### Behavior objednávky

Teď implementujme kompletní stavový automat:

```typescript
// Konstanty timeoutů
const PAYMENT_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hodin na platbu
const DELIVERY_TIMEOUT = 30 * 24 * 60 * 60 * 1000; // 30 dní na doručení
const REFUND_WINDOW = 14 * 24 * 60 * 60 * 1000; // 14 dní na požádání o refund

// Helper pro vytvoření počátečních dat objednávky
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
    currency: 'CZK',
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

// Helper pro přidání záznamu do historie
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

// Behavior workflow objednávky
const orderBehavior: StateMachineBehavior<OrderState, OrderEvent, OrderData> = {
  init: () => {
    // Toto by typicky přijímalo data objednávky od volajícího
    // Pro tento příklad vytvoříme placeholder
    const data = createOrderData('order-001', 'customer-001', [
      { productId: 'prod-1', quantity: 2, price: 299 },
      { productId: 'prod-2', quantity: 1, price: 499 },
    ]);

    return {
      state: 'pending',
      data,
      // Spustit timeout platby ihned
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
    // ==================== STAV PENDING ====================
    pending: {
      onEnter(data) {
        console.log(`[Order ${data.orderId}] Created, awaiting payment`);
        console.log(`  Total: ${data.totalAmount.toFixed(2)} ${data.currency}`);
        console.log(`  Payment deadline: 24 hours`);
      },

      handleEvent(event, data, from) {
        // Zpracovat timeout
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

        // Zpracovat status query
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

        // Zákazník iniciuje platbu
        if (event.type === 'pay') {
          // Validovat částku
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

        // Platební procesor potvrzuje
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

        // Platba selhala
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

        // Zákazník ruší
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

    // ==================== STAV PAID ====================
    paid: {
      onEnter(data) {
        console.log(`[Order ${data.orderId}] Payment confirmed!`);
        console.log(`  Transaction: ${data.transactionId}`);
        console.log(`  Ready for shipping`);
      },

      handleEvent(event, data, from) {
        // Zpracovat status query
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

        // Sklad odesílá objednávku
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
              // Spustit timeout doručení
              {
                type: 'generic_timeout',
                name: 'delivery_deadline',
                time: DELIVERY_TIMEOUT,
              },
            ],
          };
        }

        // Admin ruší (s refundem)
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
            // Spustit zpracování refundu
            actions: [{ type: 'next_event', event: { type: 'process_refund' } }],
          };
        }

        // Zabránit zákaznickému zrušení po platbě (musí přes admina)
        if (event.type === 'cancel') {
          console.log(`[Order ${data.orderId}] Cannot cancel paid order directly`);
          return { type: 'keep_state_and_data' };
        }

        return { type: 'keep_state_and_data' };
      },
    },

    // ==================== STAV SHIPPED ====================
    shipped: {
      onEnter(data) {
        console.log(`[Order ${data.orderId}] Shipped!`);
        console.log(`  Carrier: ${data.carrier}`);
        console.log(`  Tracking: ${data.trackingNumber}`);
      },

      handleEvent(event, data, from) {
        // Zpracovat timeout
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

        // Zpracovat status query
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

        // Doručení potvrzeno
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
              // Spustit timer refund okna
              {
                type: 'generic_timeout',
                name: 'refund_window',
                time: REFUND_WINDOW,
              },
            ],
          };
        }

        // Doručení selhalo - vrátit do paid pro opětovné odeslání
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

    // ==================== STAV DELIVERED ====================
    delivered: {
      onEnter(data) {
        console.log(`[Order ${data.orderId}] Delivered!`);
        if (data.deliverySignature) {
          console.log(`  Signed by: ${data.deliverySignature}`);
        }
        console.log(`  Refund window: 14 days`);
      },

      handleEvent(event, data, from) {
        // Zpracovat timeout refund okna
        const timeoutEvent = event as TimeoutEvent;
        if (
          timeoutEvent.type === 'timeout' &&
          timeoutEvent.timeoutType === 'generic_timeout' &&
          timeoutEvent.name === 'refund_window'
        ) {
          console.log(`[Order ${data.orderId}] Refund window closed - order complete`);
          // Objednávka je nyní finální - žádná změna stavu není potřeba, jen log
          return { type: 'keep_state_and_data' };
        }

        // Zpracovat status query
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

        // Zákazník žádá refund v rámci okna
        if (event.type === 'request_refund') {
          // Zkontrolovat zda je ještě v refund okně
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

    // ==================== STAV CANCELLED ====================
    cancelled: {
      onEnter(data) {
        console.log(`[Order ${data.orderId}] Cancelled`);
        console.log(`  Reason: ${data.cancellationReason}`);
        if (data.refundStatus === 'pending') {
          console.log(`  Refund: pending`);
        }
      },

      handleEvent(event, data, from) {
        // Zpracovat status query
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

        // Zpracovat refund (spuštěno next_event action)
        if (event.type === 'process_refund' && data.refundStatus === 'pending') {
          console.log(`[Order ${data.orderId}] Processing refund of ${data.totalAmount} ${data.currency}`);
          // V reálné aplikaci by toto volalo platební procesor
          return {
            type: 'keep_state',
            data: {
              ...data,
              refundStatus: 'completed',
              updatedAt: Date.now(),
            },
          };
        }

        // Terminální stav - ignorovat většinu událostí
        return { type: 'keep_state_and_data' };
      },
    },

    // ==================== STAV EXPIRED ====================
    expired: {
      onEnter(data) {
        console.log(`[Order ${data.orderId}] Expired`);
        const reason = data.history[data.history.length - 1]?.details || 'Timeout';
        console.log(`  Reason: ${reason}`);
      },

      handleEvent(event, data, from) {
        // Zpracovat status query
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

        // Terminální stav
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

## Příklad použití

Zde je jak použít stavový automat objednávky v praxi:

```typescript
async function orderDemo() {
  // Spustit novou objednávku
  const order = await GenStateMachine.start(orderBehavior, {
    name: 'order-12345',
  });

  // Zkontrolovat počáteční status
  const initialStatus = await GenStateMachine.callWithReply<{ state: string; message: string }>(
    order,
    { type: 'get_status' }
  );
  console.log('Initial status:', initialStatus);
  // { state: 'pending', orderId: 'order-001', totalAmount: 1097, message: 'Awaiting payment' }

  // Zákazník iniciuje platbu
  GenStateMachine.cast(order, {
    type: 'pay',
    paymentId: 'pay-abc123',
    amount: 1097,
  });

  // Platební procesor potvrzuje (v reálné aplikaci přichází z webhooku)
  await GenStateMachine.call(order, {
    type: 'payment_confirmed',
    transactionId: 'txn-xyz789',
  });

  // Zkontrolovat status po platbě
  const paidStatus = await GenStateMachine.callWithReply(order, { type: 'get_status' });
  console.log('After payment:', paidStatus);

  // Sklad odesílá objednávku
  await GenStateMachine.call(order, {
    type: 'ship',
    trackingNumber: 'CZ123456789',
    carrier: 'PPL',
  });

  // Dopravce potvrzuje doručení
  await GenStateMachine.call(order, {
    type: 'deliver',
    signature: 'Jan Novák',
  });

  // Finální status
  const finalStatus = await GenStateMachine.callWithReply(order, { type: 'get_status' });
  console.log('Final status:', finalStatus);
  // { state: 'delivered', orderId: 'order-001', deliveredAt: ..., refundWindowOpen: true, ... }

  // Uklidit
  await GenStateMachine.stop(order);
}
```

## Testování workflow objednávky

Testování stavových automatů je přímočaré - provádíte je skrz scénáře a ověřujete stavy:

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
    // Iniciovat platbu
    GenStateMachine.cast(order, { type: 'pay', paymentId: 'pay-1', amount: 1097 });

    // Potvrdit platbu
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
    // Nejprve zaplatit
    GenStateMachine.cast(order, { type: 'pay', paymentId: 'pay-1', amount: 1097 });
    await GenStateMachine.call(order, { type: 'payment_confirmed', transactionId: 'txn-1' });

    // Pokusit se zrušit
    GenStateMachine.cast(order, { type: 'cancel', reason: 'Changed my mind' });

    // Mělo by být stále paid
    const state = await GenStateMachine.getState(order);
    expect(state).toBe('paid');
  });

  it('should complete full happy path', async () => {
    // Platba
    GenStateMachine.cast(order, { type: 'pay', paymentId: 'pay-1', amount: 1097 });
    await GenStateMachine.call(order, { type: 'payment_confirmed', transactionId: 'txn-1' });
    expect(await GenStateMachine.getState(order)).toBe('paid');

    // Odeslání
    await GenStateMachine.call(order, {
      type: 'ship',
      trackingNumber: '123456',
      carrier: 'FedEx',
    });
    expect(await GenStateMachine.getState(order)).toBe('shipped');

    // Doručení
    await GenStateMachine.call(order, { type: 'deliver', signature: 'Jana Nováková' });
    expect(await GenStateMachine.getState(order)).toBe('delivered');
  });

  it('should handle delivery failure with re-shipping', async () => {
    // Dostat se do stavu shipped
    GenStateMachine.cast(order, { type: 'pay', paymentId: 'pay-1', amount: 1097 });
    await GenStateMachine.call(order, { type: 'payment_confirmed', transactionId: 'txn-1' });
    await GenStateMachine.call(order, { type: 'ship', trackingNumber: '123', carrier: 'PPL' });

    // Doručení selže
    await GenStateMachine.call(order, {
      type: 'delivery_failed',
      reason: 'Address not found',
    });

    // Mělo by být zpět v paid pro opětovné odeslání
    expect(await GenStateMachine.getState(order)).toBe('paid');
  });
});
```

## Klíčové patterny demonstrované

### 1. Generic timeouty pro business deadliny

Používáme `generic_timeout` pro platební a doručovací deadliny, protože tyto timeouty musí přežít přechody stavů:

```typescript
// Payment deadline začíná v 'pending', může vystřelit v 'pending'
actions: [{ type: 'generic_timeout', name: 'payment_deadline', time: PAYMENT_TIMEOUT }]

// Delivery deadline začíná v 'shipped', vystřelí v 'shipped' nebo později
actions: [{ type: 'generic_timeout', name: 'delivery_deadline', time: DELIVERY_TIMEOUT }]
```

### 2. next_event pro okamžitý follow-up

Když admin zruší zaplacenou objednávku, automaticky spustíme zpracování refundu:

```typescript
// Ve stavu 'paid', admin_cancel handler
return {
  type: 'transition',
  nextState: 'cancelled',
  data: { ...data, refundStatus: 'pending' },
  actions: [{ type: 'next_event', event: { type: 'process_refund' } }],
};
```

### 3. callWithReply pro status queries

Použití `callWithReply` s `DeferredReply` umožňuje synchronní dotazy na status:

```typescript
// Handler přijímá parametr 'from'
handleEvent(event, data, from) {
  if (event.type === 'get_status' && from) {
    return {
      type: 'keep_state_and_data',
      actions: [{ type: 'reply', to: from, value: { state: 'pending', ... } }],
    };
  }
}

// Volající dostane odpověď
const status = await GenStateMachine.callWithReply(order, { type: 'get_status' });
```

### 4. Audit trail s historií

Každý přechod loguje do pole historie pro compliance a debugging:

```typescript
function addHistory(data, fromState, toState, event, details) {
  return {
    ...data,
    history: [...data.history, { timestamp: Date.now(), fromState, toState, event, details }],
  };
}
```

### 5. Prevence neplatných přechodů

Struktura stavů přirozeně zabraňuje neplatným přechodům. Například nelze odeslat objednávku, která není zaplacena:

```typescript
// Ve stavu 'pending' není handler pro událost 'ship'
// Propadne do: return { type: 'keep_state_and_data' };
```

## Cvičení: Přidejte Express Return Flow

Rozšiřte workflow objednávky o schopnost express return:

**Požadavky:**
1. Přidejte nový stav: `return_requested`
2. Ze stavu `delivered` může zákazník požádat o return (odlišné od refundu)
3. Return musí být iniciován do 30 dnů od doručení
4. Returns vyžadují schválení admina před přechodem do `cancelled` s refundem
5. Pokud admin return zamítne, objednávka se vrátí do stavu `delivered`
6. Přidejte nové události: `request_return`, `approve_return`, `reject_return`

### Řešení

<details>
<summary>Klikněte pro zobrazení řešení</summary>

```typescript
// Přidat do typu OrderState
type OrderState =
  | 'pending'
  | 'paid'
  | 'shipped'
  | 'delivered'
  | 'return_requested'  // NOVÉ
  | 'cancelled'
  | 'expired';

// Přidat nové události
type OrderEvent =
  // ... existující události ...
  | { type: 'request_return'; reason: string }
  | { type: 'approve_return'; adminId: string }
  | { type: 'reject_return'; adminId: string; reason: string };

// Aktualizovat OrderData
interface OrderData {
  // ... existující pole ...
  returnRequestedAt: number | null;
  returnReason: string | null;
}

const RETURN_WINDOW = 30 * 24 * 60 * 60 * 1000; // 30 dní

// Přidat do objektu states
const orderBehaviorExtended: StateMachineBehavior<OrderState, OrderEvent, OrderData> = {
  // ... init a ostatní stavy ...

  states: {
    // ... existující stavy ...

    // Aktualizovat stav delivered pro zpracování return požadavků
    delivered: {
      handleEvent(event, data, from) {
        // ... existující handlery ...

        // Zákazník žádá o return
        if (event.type === 'request_return') {
          // Zkontrolovat zda je ještě v return okně
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
              // Admin má 7 dní na review
              { type: 'state_timeout', time: 7 * 24 * 60 * 60 * 1000 },
            ],
          };
        }

        return { type: 'keep_state_and_data' };
      },
    },

    // NOVÝ: stav return_requested
    return_requested: {
      onEnter(data) {
        console.log(`[Order ${data.orderId}] Return requested`);
        console.log(`  Reason: ${data.returnReason}`);
        console.log(`  Awaiting admin review (7 day timeout)`);
      },

      handleEvent(event, data, from) {
        // Zpracovat timeout review - auto-schválení po 7 dnech
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

        // Zpracovat status query
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

        // Admin schvaluje return
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

        // Admin zamítá return
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

## Shrnutí

V této kapitole jste vytvořili kompletní workflow objednávky, které demonstruje:

- **Kompletní pokrytí stavů**: Všechny business stavy (pending, paid, shipped, delivered, cancelled, expired) s jasnými odpovědnostmi
- **Správa timeoutů**: Platební deadliny, sledování doručení a refund okna pomocí generic timeoutů
- **Zpracování událostí**: Akce zákazníka, systémové události, admin overrides, vše zpracováno vhodně podle stavu
- **Error recovery**: Selhání doručení vrací do stavu paid pro opětovné odeslání
- **Audit trail**: Každý přechod zalogován s časovým razítkem a detaily
- **Status queries**: Použití `callWithReply` pro synchronní inspekci stavu
- **Testování**: Provádění stavového automatu skrz scénáře pro ověření chování

Tento pattern škáluje na jakýkoliv workflow: zpracování plateb, schvalování dokumentů, správa ticketů, životní cyklus předplatného a další. Klíčový poznatek je, že **GenStateMachine dělá váš stavový diagram spustitelným** - struktura kódu přesně zrcadlí business logiku.

---

Další: [Proč persistence?](../06-persistence/01-proc-persistence.md)
