/**
 * Tests for code examples in docs/learn/03-supervision/05-supervision-trees.md
 *
 * Verifies that the code examples in the documentation compile and work correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Supervisor,
  GenServer,
  type GenServerBehavior,
  type GenServerRef,
} from '../../src/index.js';

// Helper function from the chapter
function createSupervisorWrapper(name: string, childSupervisor: Awaited<ReturnType<typeof Supervisor.start>>) {
  return GenServer.start({
    init: () => ({ supervisor: childSupervisor }),
    handleCall: (_: unknown, state: { supervisor: typeof childSupervisor }) => [state.supervisor, state],
    handleCast: (_: unknown, state: { supervisor: typeof childSupervisor }) => state,
    async terminate() {
      await Supervisor.stop(childSupervisor);
    },
  });
}

// Simple service behavior factory from the chapter
const createServiceBehavior = (name: string): GenServerBehavior<{ name: string }, { type: 'ping' }, never, string> => ({
  init() {
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
    // Cleanup
  },
});

describe('Supervision Trees Documentation Examples', () => {
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

  describe('E-commerce supervision tree', () => {
    it('builds a multi-level supervision tree', async () => {
      // User domain - independent services
      const userSupervisor = await Supervisor.start({
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts: 5, withinMs: 10000 },
        children: [
          { id: 'user-service', start: () => GenServer.start(createServiceBehavior('UserService')) },
          { id: 'session-service', start: () => GenServer.start(createServiceBehavior('SessionService')) },
        ],
      });

      expect(Supervisor.isRunning(userSupervisor)).toBe(true);
      expect(Supervisor.countChildren(userSupervisor)).toBe(2);

      // Order domain - sequential dependencies
      const orderSupervisor = await Supervisor.start({
        strategy: 'rest_for_one',
        restartIntensity: { maxRestarts: 3, withinMs: 5000 },
        children: [
          { id: 'cart-service', start: () => GenServer.start(createServiceBehavior('CartService')) },
          { id: 'checkout-service', start: () => GenServer.start(createServiceBehavior('CheckoutService')) },
          { id: 'payment-service', start: () => GenServer.start(createServiceBehavior('PaymentService')) },
        ],
      });

      expect(Supervisor.isRunning(orderSupervisor)).toBe(true);
      expect(Supervisor.countChildren(orderSupervisor)).toBe(3);

      // Root supervisor wrapping domain supervisors
      const rootSupervisor = await Supervisor.start({
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts: 10, withinMs: 60000 },
        children: [
          {
            id: 'user-domain',
            start: () => createSupervisorWrapper('UserDomain', userSupervisor),
          },
          {
            id: 'order-domain',
            start: () => createSupervisorWrapper('OrderDomain', orderSupervisor),
          },
        ],
      });

      expect(Supervisor.isRunning(rootSupervisor)).toBe(true);
      expect(Supervisor.countChildren(rootSupervisor)).toBe(2);

      // Verify children are accessible
      const userDomainChild = Supervisor.getChild(rootSupervisor, 'user-domain');
      expect(userDomainChild).toBeDefined();

      const orderDomainChild = Supervisor.getChild(rootSupervisor, 'order-domain');
      expect(orderDomainChild).toBeDefined();

      // Cleanup - root supervisor stops all nested supervisors
      await Supervisor.stop(rootSupervisor);

      expect(Supervisor.isRunning(rootSupervisor)).toBe(false);
    });

    it('isolates failures between domains', async () => {
      // Create a simple domain supervisor
      const stableDomain = await Supervisor.start({
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts: 3, withinMs: 5000 },
        children: [
          { id: 'stable-service', start: () => GenServer.start(createServiceBehavior('StableService')) },
        ],
      });

      const unstableDomain = await Supervisor.start({
        strategy: 'one_for_one',
        restartIntensity: { maxRestarts: 3, withinMs: 5000 },
        children: [
          { id: 'unstable-service', start: () => GenServer.start(createServiceBehavior('UnstableService')) },
        ],
      });

      // Root supervisor
      const root = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'stable', start: () => createSupervisorWrapper('Stable', stableDomain) },
          { id: 'unstable', start: () => createSupervisorWrapper('Unstable', unstableDomain) },
        ],
      });

      // Both domains running
      expect(Supervisor.isRunning(stableDomain)).toBe(true);
      expect(Supervisor.isRunning(unstableDomain)).toBe(true);

      // Get the unstable service ref
      const unstableChild = Supervisor.getChild(unstableDomain, 'unstable-service');
      expect(unstableChild).toBeDefined();

      // Crash the unstable service
      GenServer._forceTerminate(unstableChild!.ref, { error: new Error('Simulated crash') });

      // Wait for restart
      await new Promise(r => setTimeout(r, 100));

      // Stable domain should still be running
      expect(Supervisor.isRunning(stableDomain)).toBe(true);
      const stableChild = Supervisor.getChild(stableDomain, 'stable-service');
      expect(stableChild).toBeDefined();
      expect(GenServer.isRunning(stableChild!.ref)).toBe(true);

      // Cleanup
      await Supervisor.stop(root);
    });
  });

  describe('simple_one_for_one for dynamic children', () => {
    it('creates dynamic children from template', async () => {
      // Factory function that creates a behavior with captured state
      const createConnectionBehavior = (connectionId: string, userId: string): GenServerBehavior<
        { connectionId: string; userId: string },
        { type: 'getUser' },
        never,
        string
      > => ({
        init() {
          // State is captured from closure
          return { connectionId, userId };
        },
        handleCall(msg, state) {
          if (msg.type === 'getUser') {
            return [state.userId, state];
          }
          return ['', state];
        },
        handleCast: (_, state) => state,
      });

      // Connection supervisor with simple_one_for_one
      const connectionSupervisor = await Supervisor.start({
        strategy: 'simple_one_for_one',
        restartIntensity: { maxRestarts: 100, withinMs: 60000 },
        childTemplate: {
          start: (connectionId: string, userId: string) =>
            GenServer.start(createConnectionBehavior(connectionId, userId)),
          restart: 'transient',
        },
      });

      expect(Supervisor.isRunning(connectionSupervisor)).toBe(true);
      expect(Supervisor.countChildren(connectionSupervisor)).toBe(0);

      // Add dynamic children
      const conn1 = await Supervisor.startChild(connectionSupervisor, ['ws_1', 'alice']);
      const conn2 = await Supervisor.startChild(connectionSupervisor, ['ws_2', 'bob']);

      expect(Supervisor.countChildren(connectionSupervisor)).toBe(2);
      expect(GenServer.isRunning(conn1)).toBe(true);
      expect(GenServer.isRunning(conn2)).toBe(true);

      // Verify the children have correct state
      const user1 = await GenServer.call(conn1, { type: 'getUser' });
      const user2 = await GenServer.call(conn2, { type: 'getUser' });

      expect(user1).toBe('alice');
      expect(user2).toBe('bob');

      // Cleanup
      await Supervisor.stop(connectionSupervisor);
    });
  });

  describe('rest_for_one strategy with dependencies', () => {
    it('restarts dependent services when upstream fails', async () => {
      const startOrder: string[] = [];

      const createTrackedBehavior = (name: string): GenServerBehavior<{ name: string }, { type: 'ping' }, never, string> => ({
        init() {
          startOrder.push(name);
          return { name };
        },
        handleCall(msg, state) {
          if (msg.type === 'ping') {
            return [`pong from ${state.name}`, state];
          }
          return ['', state];
        },
        handleCast: (_, state) => state,
      });

      // Pipeline: DB → Cache → API
      const pipelineSupervisor = await Supervisor.start({
        strategy: 'rest_for_one',
        restartIntensity: { maxRestarts: 5, withinMs: 10000 },
        children: [
          { id: 'db', start: () => GenServer.start(createTrackedBehavior('DB')) },
          { id: 'cache', start: () => GenServer.start(createTrackedBehavior('Cache')) },
          { id: 'api', start: () => GenServer.start(createTrackedBehavior('API')) },
        ],
      });

      expect(startOrder).toEqual(['DB', 'Cache', 'API']);

      // Get cache ref
      const cacheChild = Supervisor.getChild(pipelineSupervisor, 'cache');
      expect(cacheChild).toBeDefined();

      // Crash cache
      startOrder.length = 0; // Clear
      GenServer._forceTerminate(cacheChild!.ref, { error: new Error('Cache crash') });

      // Wait for restart
      await new Promise(r => setTimeout(r, 200));

      // Cache and API should have restarted (rest_for_one), but not DB
      expect(startOrder).toEqual(['Cache', 'API']);

      // All services should be running
      const dbChild = Supervisor.getChild(pipelineSupervisor, 'db');
      const newCacheChild = Supervisor.getChild(pipelineSupervisor, 'cache');
      const apiChild = Supervisor.getChild(pipelineSupervisor, 'api');

      expect(GenServer.isRunning(dbChild!.ref)).toBe(true);
      expect(GenServer.isRunning(newCacheChild!.ref)).toBe(true);
      expect(GenServer.isRunning(apiChild!.ref)).toBe(true);

      // Cleanup
      await Supervisor.stop(pipelineSupervisor);
    });
  });
});
