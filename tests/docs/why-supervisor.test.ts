/**
 * Tests for the Why Supervisor? documentation examples.
 * Verifies that all code examples from docs/learn/03-supervision/01-why-supervisor.md work correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Supervisor,
  GenServer,
  type GenServerBehavior,
} from '../../src/index.js';

/**
 * Helper to wait for a condition with timeout.
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 1000,
  intervalMs: number = 10,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('Why Supervisor? Documentation Examples', () => {
  beforeEach(() => {
    Supervisor._clearLifecycleHandlers();
    Supervisor._resetIdCounter();
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
  });

  afterEach(async () => {
    await Supervisor._clearAll();
    Supervisor._clearLifecycleHandlers();
    GenServer._clearLifecycleHandlers();
  });

  describe('Order Processor Example', () => {
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
            return ['processing', { ...state, status: 'processing' }];
          case 'getStatus':
            return [state.status, state];
        }
      },

      handleCast(_msg, state) {
        return state;
      },
    };

    it('should start supervisor with order processor child', async () => {
      const supervisor = await Supervisor.start({
        children: [
          {
            id: 'order-processor',
            start: () => GenServer.start(orderProcessorBehavior),
          },
        ],
      });

      expect(Supervisor.isRunning(supervisor)).toBe(true);
      expect(Supervisor.countChildren(supervisor)).toBe(1);

      const child = Supervisor.getChild(supervisor, 'order-processor');
      expect(child).toBeDefined();

      const status = await GenServer.call(child!.ref, { type: 'getStatus' });
      expect(status).toBe('pending');

      await Supervisor.stop(supervisor);
    });

    it('should automatically restart crashed order processor', async () => {
      const supervisor = await Supervisor.start({
        children: [
          {
            id: 'order-processor',
            start: () => GenServer.start(orderProcessorBehavior),
          },
        ],
      });

      const childBefore = Supervisor.getChild(supervisor, 'order-processor')!;
      const refBefore = childBefore.ref;

      // Crash the child
      GenServer._forceTerminate(refBefore, { error: new Error('Simulated crash') });

      // Wait for restart
      await waitFor(() => {
        const childAfter = Supervisor.getChild(supervisor, 'order-processor');
        return childAfter?.ref.id !== refBefore.id;
      }, 2000);

      // Verify new instance is running
      const childAfter = Supervisor.getChild(supervisor, 'order-processor');
      expect(childAfter).toBeDefined();
      expect(GenServer.isRunning(childAfter!.ref)).toBe(true);
      expect(childAfter!.restartCount).toBe(1);

      await Supervisor.stop(supervisor);
    });
  });

  describe('Multiple Services Isolation Example', () => {
    function createSimpleBehavior(): GenServerBehavior<number, 'get', 'inc', number> {
      return {
        init: () => 0,
        handleCall: (_, state) => [state, state],
        handleCast: (_, state) => state + 1,
      };
    }

    it('should isolate failures - only crashed service restarts', async () => {
      const supervisor = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'users', start: () => GenServer.start(createSimpleBehavior()) },
          { id: 'orders', start: () => GenServer.start(createSimpleBehavior()) },
          { id: 'payments', start: () => GenServer.start(createSimpleBehavior()) },
          { id: 'notifications', start: () => GenServer.start(createSimpleBehavior()) },
        ],
      });

      expect(Supervisor.countChildren(supervisor)).toBe(4);

      // Get references before crash
      const notificationsBefore = Supervisor.getChild(supervisor, 'notifications')!;
      const usersBefore = Supervisor.getChild(supervisor, 'users')!;
      const ordersBefore = Supervisor.getChild(supervisor, 'orders')!;
      const paymentsBefore = Supervisor.getChild(supervisor, 'payments')!;

      // Crash notifications
      GenServer._forceTerminate(notificationsBefore.ref, { error: new Error('Notification error') });

      // Wait for restart
      await waitFor(() => {
        const notificationsAfter = Supervisor.getChild(supervisor, 'notifications');
        return notificationsAfter?.ref.id !== notificationsBefore.ref.id;
      }, 2000);

      // Verify only notifications restarted
      const notificationsAfter = Supervisor.getChild(supervisor, 'notifications')!;
      const usersAfter = Supervisor.getChild(supervisor, 'users')!;
      const ordersAfter = Supervisor.getChild(supervisor, 'orders')!;
      const paymentsAfter = Supervisor.getChild(supervisor, 'payments')!;

      // notifications should have new ref and restart count
      expect(notificationsAfter.ref.id).not.toBe(notificationsBefore.ref.id);
      expect(notificationsAfter.restartCount).toBe(1);

      // Other services should be unchanged
      expect(usersAfter.ref.id).toBe(usersBefore.ref.id);
      expect(usersAfter.restartCount).toBe(0);
      expect(ordersAfter.ref.id).toBe(ordersBefore.ref.id);
      expect(ordersAfter.restartCount).toBe(0);
      expect(paymentsAfter.ref.id).toBe(paymentsBefore.ref.id);
      expect(paymentsAfter.restartCount).toBe(0);

      await Supervisor.stop(supervisor);
    });
  });

  describe('Cache Refresh Example (Let it Crash style)', () => {
    interface CacheState {
      data: Map<string, unknown>;
      lastRefresh: number;
    }

    type RefreshMsg = { type: 'refresh' } | { type: 'get'; key: string };
    type Reply = unknown;

    async function fetchFromDatabase(): Promise<Map<string, unknown>> {
      return new Map([['key1', 'value1'], ['key2', 'value2']]);
    }

    const cacheRefreshBehavior: GenServerBehavior<CacheState, RefreshMsg, never, Reply> = {
      init() {
        return { data: new Map(), lastRefresh: Date.now() };
      },

      async handleCall(msg, state) {
        if (msg.type === 'refresh') {
          const freshData = await fetchFromDatabase();
          return [undefined, { data: freshData, lastRefresh: Date.now() }];
        }
        if (msg.type === 'get') {
          return [state.data.get(msg.key), state];
        }
        return [undefined, state];
      },

      handleCast(_msg, state) {
        return state;
      },
    };

    it('should work when database fetch succeeds', async () => {
      const server = await GenServer.start(cacheRefreshBehavior);

      await GenServer.call(server, { type: 'refresh' });
      const value = await GenServer.call(server, { type: 'get', key: 'key1' });
      expect(value).toBe('value1');

      await GenServer.stop(server);
    });

    it('should restart with clean cache after crash', async () => {
      const supervisor = await Supervisor.start({
        children: [
          {
            id: 'cache',
            start: () => GenServer.start(cacheRefreshBehavior),
          },
        ],
      });

      // Populate the cache
      const cacheBefore = Supervisor.getChild(supervisor, 'cache')!;
      await GenServer.call(cacheBefore.ref, { type: 'refresh' });
      const valueBefore = await GenServer.call(cacheBefore.ref, { type: 'get', key: 'key1' });
      expect(valueBefore).toBe('value1');

      // Simulate a crash (e.g., due to OOM or unexpected error)
      GenServer._forceTerminate(cacheBefore.ref, { error: new Error('Unexpected crash') });

      // Wait for restart
      await waitFor(() => {
        const cacheAfter = Supervisor.getChild(supervisor, 'cache');
        return cacheAfter?.ref.id !== cacheBefore.ref.id;
      }, 2000);

      // New instance should start with empty cache
      const cacheAfter = Supervisor.getChild(supervisor, 'cache')!;
      const valueAfterCrash = await GenServer.call(cacheAfter.ref, { type: 'get', key: 'key1' });
      expect(valueAfterCrash).toBeUndefined(); // Clean slate - cache is empty

      // Can refresh and use again
      await GenServer.call(cacheAfter.ref, { type: 'refresh' });
      const valueAfterRefresh = await GenServer.call(cacheAfter.ref, { type: 'get', key: 'key1' });
      expect(valueAfterRefresh).toBe('value1');

      await Supervisor.stop(supervisor);
    });
  });

  describe('Clean Slate on Restart', () => {
    interface CounterState {
      value: number;
    }

    const counterBehavior: GenServerBehavior<CounterState, 'get', 'inc', number> = {
      init() {
        return { value: 0 };
      },

      handleCall(_, state) {
        return [state.value, state];
      },

      handleCast(_, state) {
        return { value: state.value + 1 };
      },
    };

    it('should start with clean state after restart', async () => {
      const supervisor = await Supervisor.start({
        children: [
          {
            id: 'counter',
            start: () => GenServer.start(counterBehavior),
          },
        ],
      });

      // Increment counter several times
      const counterBefore = Supervisor.getChild(supervisor, 'counter')!;
      GenServer.cast(counterBefore.ref, 'inc');
      GenServer.cast(counterBefore.ref, 'inc');
      GenServer.cast(counterBefore.ref, 'inc');

      await new Promise((r) => setTimeout(r, 50));

      const valueBefore = await GenServer.call(counterBefore.ref, 'get');
      expect(valueBefore).toBe(3);

      // Crash the counter
      GenServer._forceTerminate(counterBefore.ref, { error: new Error('Crash') });

      // Wait for restart
      await waitFor(() => {
        const counterAfter = Supervisor.getChild(supervisor, 'counter');
        return counterAfter?.ref.id !== counterBefore.ref.id;
      }, 2000);

      // New instance should have clean state (value = 0)
      const counterAfter = Supervisor.getChild(supervisor, 'counter')!;
      const valueAfter = await GenServer.call(counterAfter.ref, 'get');
      expect(valueAfter).toBe(0);

      await Supervisor.stop(supervisor);
    });
  });
});
