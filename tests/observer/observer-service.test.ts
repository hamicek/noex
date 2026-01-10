/**
 * Comprehensive tests for Observer Service module.
 *
 * The Observer Service is a GenServer that exposes local Observer
 * data for remote access, enabling cluster-wide process monitoring.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  GenServer,
  Supervisor,
  Registry,
  Observer,
  type GenServerBehavior,
} from '../../src/index.js';
import {
  startObserverService,
  stopObserverService,
  isObserverServiceRunning,
  getObserverServiceRef,
  OBSERVER_SERVICE_NAME,
  type ObserverServiceCallMessage,
  type ObserverServiceCallReply,
} from '../../src/observer/index.js';

/**
 * Creates a simple counter behavior for testing.
 */
function createCounterBehavior(): GenServerBehavior<number, 'get', 'inc', number> {
  return {
    init: () => 0,
    handleCall: (msg, state) => {
      if (msg === 'get') return [state, state];
      throw new Error('Unknown message');
    },
    handleCast: (msg, state) => {
      if (msg === 'inc') return state + 1;
      return state;
    },
  };
}

describe('Observer Service', () => {
  beforeEach(() => {
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
    Supervisor._clearLifecycleHandlers();
    Supervisor._resetIdCounter();
    Registry._clearLifecycleHandler();
    Registry._clear();
    Observer._reset();
  });

  afterEach(async () => {
    // Stop observer service if running
    await stopObserverService();

    Observer._reset();
    await Supervisor._clearAll();
    GenServer._clearLifecycleHandlers();
    Registry._clearLifecycleHandler();
    Registry._clear();
  });

  describe('startObserverService()', () => {
    it('starts the Observer Service GenServer', async () => {
      expect(isObserverServiceRunning()).toBe(false);

      await startObserverService();

      expect(isObserverServiceRunning()).toBe(true);
    });

    it('registers the service under well-known name', async () => {
      await startObserverService();

      const ref = Registry.whereis(OBSERVER_SERVICE_NAME);
      expect(ref).toBeDefined();
    });

    it('is idempotent - multiple calls have no effect', async () => {
      await startObserverService();
      const firstRef = getObserverServiceRef();

      await startObserverService();
      const secondRef = getObserverServiceRef();

      expect(firstRef).toBeDefined();
      expect(secondRef).toBeDefined();
      expect(firstRef!.id).toBe(secondRef!.id);
    });
  });

  describe('stopObserverService()', () => {
    it('stops the Observer Service GenServer', async () => {
      await startObserverService();
      expect(isObserverServiceRunning()).toBe(true);

      await stopObserverService();

      expect(isObserverServiceRunning()).toBe(false);
    });

    it('unregisters the service from Registry', async () => {
      await startObserverService();
      expect(Registry.whereis(OBSERVER_SERVICE_NAME)).toBeDefined();

      await stopObserverService();

      expect(Registry.whereis(OBSERVER_SERVICE_NAME)).toBeUndefined();
    });

    it('is idempotent - multiple calls have no effect', async () => {
      await startObserverService();

      await stopObserverService();
      await stopObserverService();

      expect(isObserverServiceRunning()).toBe(false);
    });

    it('handles being called when service was never started', async () => {
      // Should not throw
      await stopObserverService();

      expect(isObserverServiceRunning()).toBe(false);
    });
  });

  describe('isObserverServiceRunning()', () => {
    it('returns false when service is not started', () => {
      expect(isObserverServiceRunning()).toBe(false);
    });

    it('returns true when service is running', async () => {
      await startObserverService();

      expect(isObserverServiceRunning()).toBe(true);
    });

    it('returns false after service is stopped', async () => {
      await startObserverService();
      await stopObserverService();

      expect(isObserverServiceRunning()).toBe(false);
    });
  });

  describe('getObserverServiceRef()', () => {
    it('returns undefined when service is not running', () => {
      expect(getObserverServiceRef()).toBeUndefined();
    });

    it('returns the service ref when running', async () => {
      await startObserverService();

      const ref = getObserverServiceRef();

      expect(ref).toBeDefined();
      expect(ref!.id).toContain('genserver_');
    });

    it('returns undefined after service is stopped', async () => {
      await startObserverService();
      await stopObserverService();

      expect(getObserverServiceRef()).toBeUndefined();
    });
  });

  describe('get_snapshot message', () => {
    it('returns a complete system snapshot', async () => {
      await startObserverService();
      const serviceRef = getObserverServiceRef()!;

      // Create some processes to observe
      const counterRef = await GenServer.start(createCounterBehavior());
      await GenServer.call(counterRef, 'get');
      GenServer.cast(counterRef, 'inc');
      await new Promise((r) => setTimeout(r, 50));

      const msg: ObserverServiceCallMessage = { type: 'get_snapshot' };
      const reply = await GenServer.call(serviceRef, msg) as ObserverServiceCallReply;

      expect(reply.type).toBe('snapshot');
      if (reply.type === 'snapshot') {
        expect(reply.data.timestamp).toBeGreaterThan(0);
        // Should have at least the counter + observer service
        expect(reply.data.servers.length).toBeGreaterThanOrEqual(2);
        expect(reply.data.totalMessages).toBeGreaterThanOrEqual(2);
      }

      await GenServer.stop(counterRef);
    });

    it('includes memory stats in snapshot', async () => {
      await startObserverService();
      const serviceRef = getObserverServiceRef()!;

      const msg: ObserverServiceCallMessage = { type: 'get_snapshot' };
      const reply = await GenServer.call(serviceRef, msg) as ObserverServiceCallReply;

      expect(reply.type).toBe('snapshot');
      if (reply.type === 'snapshot') {
        expect(reply.data.memoryStats).toBeDefined();
        expect(reply.data.memoryStats.heapUsed).toBeGreaterThan(0);
        expect(reply.data.memoryStats.rss).toBeGreaterThan(0);
      }
    });
  });

  describe('get_server_stats message', () => {
    it('returns stats for all running servers', async () => {
      await startObserverService();
      const serviceRef = getObserverServiceRef()!;

      const counterRef = await GenServer.start(createCounterBehavior());

      const msg: ObserverServiceCallMessage = { type: 'get_server_stats' };
      const reply = await GenServer.call(serviceRef, msg) as ObserverServiceCallReply;

      expect(reply.type).toBe('server_stats');
      if (reply.type === 'server_stats') {
        // Should include both observer service and counter
        expect(reply.data.length).toBeGreaterThanOrEqual(2);
        expect(reply.data.some((s) => s.id === counterRef.id)).toBe(true);
      }

      await GenServer.stop(counterRef);
    });
  });

  describe('get_supervisor_stats message', () => {
    it('returns stats for all running supervisors', async () => {
      await startObserverService();
      const serviceRef = getObserverServiceRef()!;

      const supRef = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'worker', start: () => GenServer.start(createCounterBehavior()) },
        ],
      });

      const msg: ObserverServiceCallMessage = { type: 'get_supervisor_stats' };
      const reply = await GenServer.call(serviceRef, msg) as ObserverServiceCallReply;

      expect(reply.type).toBe('supervisor_stats');
      if (reply.type === 'supervisor_stats') {
        expect(reply.data).toHaveLength(1);
        expect(reply.data[0]!.id).toBe(supRef.id);
        expect(reply.data[0]!.childCount).toBe(1);
      }

      await Supervisor.stop(supRef);
    });

    it('returns empty array when no supervisors running', async () => {
      await startObserverService();
      const serviceRef = getObserverServiceRef()!;

      const msg: ObserverServiceCallMessage = { type: 'get_supervisor_stats' };
      const reply = await GenServer.call(serviceRef, msg) as ObserverServiceCallReply;

      expect(reply.type).toBe('supervisor_stats');
      if (reply.type === 'supervisor_stats') {
        expect(reply.data).toEqual([]);
      }
    });
  });

  describe('get_process_tree message', () => {
    it('returns the complete process tree', async () => {
      await startObserverService();
      const serviceRef = getObserverServiceRef()!;

      const supRef = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'child1', start: () => GenServer.start(createCounterBehavior()) },
          { id: 'child2', start: () => GenServer.start(createCounterBehavior()) },
        ],
      });

      const msg: ObserverServiceCallMessage = { type: 'get_process_tree' };
      const reply = await GenServer.call(serviceRef, msg) as ObserverServiceCallReply;

      expect(reply.type).toBe('process_tree');
      if (reply.type === 'process_tree') {
        // Should have supervisor node with children
        const supNode = reply.data.find((n) => n.type === 'supervisor');
        expect(supNode).toBeDefined();
        expect(supNode!.children).toHaveLength(2);
      }

      await Supervisor.stop(supRef);
    });

    it('includes standalone servers at root level', async () => {
      await startObserverService();
      const serviceRef = getObserverServiceRef()!;

      const counterRef = await GenServer.start(createCounterBehavior());

      const msg: ObserverServiceCallMessage = { type: 'get_process_tree' };
      const reply = await GenServer.call(serviceRef, msg) as ObserverServiceCallReply;

      expect(reply.type).toBe('process_tree');
      if (reply.type === 'process_tree') {
        // Should have both observer service and counter at root level
        const rootServers = reply.data.filter((n) => n.type === 'genserver');
        expect(rootServers.length).toBeGreaterThanOrEqual(2);
        expect(rootServers.some((n) => n.id === counterRef.id)).toBe(true);
      }

      await GenServer.stop(counterRef);
    });
  });

  describe('get_process_count message', () => {
    it('returns the total process count', async () => {
      await startObserverService();
      const serviceRef = getObserverServiceRef()!;

      // Observer service itself is 1 process
      const msg1: ObserverServiceCallMessage = { type: 'get_process_count' };
      const reply1 = await GenServer.call(serviceRef, msg1) as ObserverServiceCallReply;

      expect(reply1.type).toBe('process_count');
      if (reply1.type === 'process_count') {
        expect(reply1.data).toBe(1);
      }

      // Add a counter
      const counterRef = await GenServer.start(createCounterBehavior());

      const msg2: ObserverServiceCallMessage = { type: 'get_process_count' };
      const reply2 = await GenServer.call(serviceRef, msg2) as ObserverServiceCallReply;

      expect(reply2.type).toBe('process_count');
      if (reply2.type === 'process_count') {
        expect(reply2.data).toBe(2);
      }

      await GenServer.stop(counterRef);
    });

    it('counts both servers and supervisors', async () => {
      await startObserverService();
      const serviceRef = getObserverServiceRef()!;

      const counterRef = await GenServer.start(createCounterBehavior());
      const supRef = await Supervisor.start({ strategy: 'one_for_one' });

      const msg: ObserverServiceCallMessage = { type: 'get_process_count' };
      const reply = await GenServer.call(serviceRef, msg) as ObserverServiceCallReply;

      expect(reply.type).toBe('process_count');
      if (reply.type === 'process_count') {
        // observer service + counter + supervisor
        expect(reply.data).toBe(3);
      }

      await GenServer.stop(counterRef);
      await Supervisor.stop(supRef);
    });
  });

  describe('OBSERVER_SERVICE_NAME constant', () => {
    it('is a well-defined string constant', () => {
      expect(OBSERVER_SERVICE_NAME).toBe('__noex_observer_service__');
      expect(typeof OBSERVER_SERVICE_NAME).toBe('string');
    });
  });

  describe('concurrent queries', () => {
    it('handles multiple concurrent queries correctly', async () => {
      await startObserverService();
      const serviceRef = getObserverServiceRef()!;

      // Create some processes
      const refs = await Promise.all([
        GenServer.start(createCounterBehavior()),
        GenServer.start(createCounterBehavior()),
        GenServer.start(createCounterBehavior()),
      ]);

      // Send multiple concurrent queries
      const queries: ObserverServiceCallMessage[] = [
        { type: 'get_snapshot' },
        { type: 'get_server_stats' },
        { type: 'get_supervisor_stats' },
        { type: 'get_process_tree' },
        { type: 'get_process_count' },
      ];

      const replies = await Promise.all(
        queries.map((msg) => GenServer.call(serviceRef, msg) as Promise<ObserverServiceCallReply>)
      );

      expect(replies[0]!.type).toBe('snapshot');
      expect(replies[1]!.type).toBe('server_stats');
      expect(replies[2]!.type).toBe('supervisor_stats');
      expect(replies[3]!.type).toBe('process_tree');
      expect(replies[4]!.type).toBe('process_count');

      // Cleanup
      for (const ref of refs) {
        await GenServer.stop(ref);
      }
    });
  });
});
