import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GenServer } from '../../src/core/gen-server.js';
import type {
  GenServerBehavior,
  GenServerRef,
  LifecycleEvent,
  MonitorRef,
} from '../../src/core/types.js';

/**
 * Tests for GenServer.monitor() and GenServer.demonitor() functionality.
 *
 * Tests local (same-node) process monitoring where:
 * - A monitoring process is notified when a monitored process terminates
 * - Monitors are one-way (monitoring process is not affected by termination)
 * - Multiple monitors to the same process are independent
 * - Monitoring a non-existent process immediately sends 'noproc' notification
 */

// Simple counter behavior for testing
const createCounterBehavior = (): GenServerBehavior<
  number,
  { type: 'get' } | { type: 'inc' },
  { type: 'inc' },
  number
> => ({
  init: () => 0,
  handleCall: (msg, state) => {
    if (msg.type === 'get') {
      return [state, state];
    }
    if (msg.type === 'inc') {
      return [state + 1, state + 1];
    }
    return [state, state];
  },
  handleCast: (msg, state) => {
    if (msg.type === 'inc') {
      return state + 1;
    }
    return state;
  },
});

describe('GenServer.monitor', () => {
  beforeEach(() => {
    GenServer._clearLifecycleHandlers();
    GenServer._clearLocalMonitors();
    GenServer._resetIdCounter();
  });

  afterEach(async () => {
    // Cleanup any running servers
    const serverIds = GenServer._getAllServerIds();
    for (const id of serverIds) {
      const ref = GenServer._getRefById(id);
      if (ref) {
        try {
          await GenServer.stop(ref);
        } catch {
          // Ignore errors during cleanup
        }
      }
    }
    GenServer._clearLifecycleHandlers();
    GenServer._clearLocalMonitors();
  });

  // ===========================================================================
  // Basic Monitor Setup
  // ===========================================================================

  describe('monitor setup', () => {
    it('returns a MonitorRef on successful monitor setup', async () => {
      const monitoringServer = await GenServer.start(createCounterBehavior());
      const monitoredServer = await GenServer.start(createCounterBehavior());

      const monitorRef = await GenServer.monitor(monitoringServer, monitoredServer);

      expect(monitorRef).toBeDefined();
      expect(monitorRef.monitorId).toBeDefined();
      expect(monitorRef.monitoredRef).toBeDefined();
      expect(monitorRef.monitoredRef.id).toBe(monitoredServer.id);

      await GenServer.stop(monitoringServer);
      await GenServer.stop(monitoredServer);
    });

    it('throws ServerNotRunningError when monitoring process does not exist', async () => {
      const monitoredServer = await GenServer.start(createCounterBehavior());
      const fakeRef = { id: 'non-existent-server' } as GenServerRef;

      await expect(
        GenServer.monitor(fakeRef, monitoredServer),
      ).rejects.toThrow('not running');

      await GenServer.stop(monitoredServer);
    });

    it('registers monitor in local monitor registry', async () => {
      const monitoringServer = await GenServer.start(createCounterBehavior());
      const monitoredServer = await GenServer.start(createCounterBehavior());

      expect(GenServer._getLocalMonitorCount()).toBe(0);

      await GenServer.monitor(monitoringServer, monitoredServer);

      expect(GenServer._getLocalMonitorCount()).toBe(1);

      await GenServer.stop(monitoringServer);
      await GenServer.stop(monitoredServer);
    });

    it('allows multiple monitors to the same process', async () => {
      const monitoring1 = await GenServer.start(createCounterBehavior());
      const monitoring2 = await GenServer.start(createCounterBehavior());
      const monitored = await GenServer.start(createCounterBehavior());

      const ref1 = await GenServer.monitor(monitoring1, monitored);
      const ref2 = await GenServer.monitor(monitoring2, monitored);

      expect(GenServer._getLocalMonitorCount()).toBe(2);
      expect(ref1.monitorId).not.toBe(ref2.monitorId);

      await GenServer.stop(monitoring1);
      await GenServer.stop(monitoring2);
      await GenServer.stop(monitored);
    });

    it('allows same process to monitor multiple targets', async () => {
      const monitoring = await GenServer.start(createCounterBehavior());
      const monitored1 = await GenServer.start(createCounterBehavior());
      const monitored2 = await GenServer.start(createCounterBehavior());

      await GenServer.monitor(monitoring, monitored1);
      await GenServer.monitor(monitoring, monitored2);

      expect(GenServer._getLocalMonitorCount()).toBe(2);

      await GenServer.stop(monitoring);
      await GenServer.stop(monitored1);
      await GenServer.stop(monitored2);
    });
  });

  // ===========================================================================
  // Process Down Notifications
  // ===========================================================================

  describe('process_down notifications', () => {
    it('emits process_down when monitored process terminates normally', async () => {
      const monitoringServer = await GenServer.start(createCounterBehavior());
      const monitoredServer = await GenServer.start(createCounterBehavior());

      const receivedEvents: LifecycleEvent[] = [];
      GenServer.onLifecycleEvent((event) => {
        if (event.type === 'process_down') {
          receivedEvents.push(event);
        }
      });

      const monitorRef = await GenServer.monitor(monitoringServer, monitoredServer);

      // Stop the monitored server
      await GenServer.stop(monitoredServer);

      // Wait for events to propagate
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedEvents.length).toBe(1);
      const event = receivedEvents[0];
      expect(event.type).toBe('process_down');
      if (event.type === 'process_down') {
        expect(event.ref.id).toBe(monitoringServer.id);
        expect(event.monitoredRef.id).toBe(monitoredServer.id);
        expect(event.reason.type).toBe('normal');
        expect(event.monitorId).toBe(monitorRef.monitorId);
      }

      await GenServer.stop(monitoringServer);
    });

    it('emits process_down with shutdown reason', async () => {
      const monitoringServer = await GenServer.start(createCounterBehavior());
      const monitoredServer = await GenServer.start(createCounterBehavior());

      const receivedEvents: LifecycleEvent[] = [];
      GenServer.onLifecycleEvent((event) => {
        if (event.type === 'process_down') {
          receivedEvents.push(event);
        }
      });

      await GenServer.monitor(monitoringServer, monitoredServer);
      await GenServer.stop(monitoredServer, 'shutdown');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedEvents.length).toBe(1);
      if (receivedEvents[0].type === 'process_down') {
        expect(receivedEvents[0].reason.type).toBe('shutdown');
      }

      await GenServer.stop(monitoringServer);
    });

    it('emits process_down with error reason on force terminate', async () => {
      const monitoringServer = await GenServer.start(createCounterBehavior());
      const monitoredServer = await GenServer.start(createCounterBehavior());

      const receivedEvents: LifecycleEvent[] = [];
      GenServer.onLifecycleEvent((event) => {
        if (event.type === 'process_down') {
          receivedEvents.push(event);
        }
      });

      await GenServer.monitor(monitoringServer, monitoredServer);
      GenServer._forceTerminate(monitoredServer, { error: new Error('Test error') });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedEvents.length).toBe(1);
      if (receivedEvents[0].type === 'process_down') {
        expect(receivedEvents[0].reason.type).toBe('error');
        if (receivedEvents[0].reason.type === 'error') {
          expect(receivedEvents[0].reason.message).toBe('Test error');
        }
      }

      await GenServer.stop(monitoringServer);
    });

    it('notifies all monitoring processes when one process terminates', async () => {
      const monitoring1 = await GenServer.start(createCounterBehavior());
      const monitoring2 = await GenServer.start(createCounterBehavior());
      const monitoring3 = await GenServer.start(createCounterBehavior());
      const monitored = await GenServer.start(createCounterBehavior());

      const receivedEvents: LifecycleEvent[] = [];
      GenServer.onLifecycleEvent((event) => {
        if (event.type === 'process_down') {
          receivedEvents.push(event);
        }
      });

      await GenServer.monitor(monitoring1, monitored);
      await GenServer.monitor(monitoring2, monitored);
      await GenServer.monitor(monitoring3, monitored);

      await GenServer.stop(monitored);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedEvents.length).toBe(3);

      // Verify all monitoring processes received notifications
      const monitoringIds = receivedEvents
        .filter((e) => e.type === 'process_down')
        .map((e) => (e as Extract<LifecycleEvent, { type: 'process_down' }>).ref.id);

      expect(monitoringIds).toContain(monitoring1.id);
      expect(monitoringIds).toContain(monitoring2.id);
      expect(monitoringIds).toContain(monitoring3.id);

      await GenServer.stop(monitoring1);
      await GenServer.stop(monitoring2);
      await GenServer.stop(monitoring3);
    });
  });

  // ===========================================================================
  // Monitoring Non-Existent Process
  // ===========================================================================

  describe('monitoring non-existent process', () => {
    it('immediately sends noproc notification for non-existent process', async () => {
      const monitoringServer = await GenServer.start(createCounterBehavior());
      const fakeRef = { id: 'non-existent-server' } as GenServerRef;

      const receivedEvents: LifecycleEvent[] = [];
      GenServer.onLifecycleEvent((event) => {
        if (event.type === 'process_down') {
          receivedEvents.push(event);
        }
      });

      const monitorRef = await GenServer.monitor(monitoringServer, fakeRef);

      // Wait for microtask to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedEvents.length).toBe(1);
      if (receivedEvents[0].type === 'process_down') {
        expect(receivedEvents[0].reason.type).toBe('noproc');
        expect(receivedEvents[0].monitorId).toBe(monitorRef.monitorId);
      }

      // Monitor is NOT added to registry for non-existent process
      expect(GenServer._getLocalMonitorCount()).toBe(0);

      await GenServer.stop(monitoringServer);
    });

    it('sends noproc for already stopped process', async () => {
      const monitoringServer = await GenServer.start(createCounterBehavior());
      const stoppedServer = await GenServer.start(createCounterBehavior());
      await GenServer.stop(stoppedServer);

      const receivedEvents: LifecycleEvent[] = [];
      GenServer.onLifecycleEvent((event) => {
        if (event.type === 'process_down') {
          receivedEvents.push(event);
        }
      });

      await GenServer.monitor(monitoringServer, stoppedServer);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedEvents.length).toBe(1);
      if (receivedEvents[0].type === 'process_down') {
        expect(receivedEvents[0].reason.type).toBe('noproc');
      }

      await GenServer.stop(monitoringServer);
    });
  });

  // ===========================================================================
  // Demonitor
  // ===========================================================================

  describe('demonitor', () => {
    it('removes monitor from registry', async () => {
      const monitoringServer = await GenServer.start(createCounterBehavior());
      const monitoredServer = await GenServer.start(createCounterBehavior());

      const monitorRef = await GenServer.monitor(monitoringServer, monitoredServer);
      expect(GenServer._getLocalMonitorCount()).toBe(1);

      await GenServer.demonitor(monitorRef);
      expect(GenServer._getLocalMonitorCount()).toBe(0);

      await GenServer.stop(monitoringServer);
      await GenServer.stop(monitoredServer);
    });

    it('prevents process_down notification after demonitor', async () => {
      const monitoringServer = await GenServer.start(createCounterBehavior());
      const monitoredServer = await GenServer.start(createCounterBehavior());

      const receivedEvents: LifecycleEvent[] = [];
      GenServer.onLifecycleEvent((event) => {
        if (event.type === 'process_down') {
          receivedEvents.push(event);
        }
      });

      const monitorRef = await GenServer.monitor(monitoringServer, monitoredServer);
      await GenServer.demonitor(monitorRef);

      await GenServer.stop(monitoredServer);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedEvents.length).toBe(0);

      await GenServer.stop(monitoringServer);
    });

    it('handles demonitor of already removed monitor gracefully', async () => {
      const monitoringServer = await GenServer.start(createCounterBehavior());
      const monitoredServer = await GenServer.start(createCounterBehavior());

      const monitorRef = await GenServer.monitor(monitoringServer, monitoredServer);
      await GenServer.demonitor(monitorRef);

      // Second demonitor should not throw
      await expect(GenServer.demonitor(monitorRef)).resolves.not.toThrow();

      await GenServer.stop(monitoringServer);
      await GenServer.stop(monitoredServer);
    });

    it('handles demonitor of non-existent monitor gracefully', async () => {
      const fakeMonitorRef: MonitorRef = {
        monitorId: 'non-existent-monitor' as any,
        monitoredRef: { id: 'fake', nodeId: 'local' as any },
      };

      await expect(GenServer.demonitor(fakeMonitorRef)).resolves.not.toThrow();
    });
  });

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  describe('cleanup', () => {
    it('cleans up monitors created by a terminating process', async () => {
      const monitoring = await GenServer.start(createCounterBehavior());
      const monitored1 = await GenServer.start(createCounterBehavior());
      const monitored2 = await GenServer.start(createCounterBehavior());

      await GenServer.monitor(monitoring, monitored1);
      await GenServer.monitor(monitoring, monitored2);
      expect(GenServer._getLocalMonitorCount()).toBe(2);

      // Stop the monitoring process
      await GenServer.stop(monitoring);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // All monitors created by the monitoring process should be cleaned up
      expect(GenServer._getLocalMonitorCount()).toBe(0);

      await GenServer.stop(monitored1);
      await GenServer.stop(monitored2);
    });

    it('cleans up monitors targeting a terminating process', async () => {
      const monitoring1 = await GenServer.start(createCounterBehavior());
      const monitoring2 = await GenServer.start(createCounterBehavior());
      const monitored = await GenServer.start(createCounterBehavior());

      await GenServer.monitor(monitoring1, monitored);
      await GenServer.monitor(monitoring2, monitored);
      expect(GenServer._getLocalMonitorCount()).toBe(2);

      // Stop the monitored process
      await GenServer.stop(monitored);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // All monitors for the monitored process should be cleaned up
      expect(GenServer._getLocalMonitorCount()).toBe(0);

      await GenServer.stop(monitoring1);
      await GenServer.stop(monitoring2);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('allows a process to monitor itself', async () => {
      const server = await GenServer.start(createCounterBehavior());

      const receivedEvents: LifecycleEvent[] = [];
      GenServer.onLifecycleEvent((event) => {
        if (event.type === 'process_down') {
          receivedEvents.push(event);
        }
      });

      await GenServer.monitor(server, server);
      expect(GenServer._getLocalMonitorCount()).toBe(1);

      await GenServer.stop(server);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Self-monitor notification is emitted
      expect(receivedEvents.length).toBe(1);
    });

    it('handles rapid monitor/demonitor cycles', async () => {
      const monitoring = await GenServer.start(createCounterBehavior());
      const monitored = await GenServer.start(createCounterBehavior());

      for (let i = 0; i < 10; i++) {
        const ref = await GenServer.monitor(monitoring, monitored);
        await GenServer.demonitor(ref);
      }

      expect(GenServer._getLocalMonitorCount()).toBe(0);

      await GenServer.stop(monitoring);
      await GenServer.stop(monitored);
    });

    it('handles multiple monitors from same process to same target', async () => {
      const monitoring = await GenServer.start(createCounterBehavior());
      const monitored = await GenServer.start(createCounterBehavior());

      const receivedEvents: LifecycleEvent[] = [];
      GenServer.onLifecycleEvent((event) => {
        if (event.type === 'process_down') {
          receivedEvents.push(event);
        }
      });

      // Create multiple monitors from same process to same target
      const ref1 = await GenServer.monitor(monitoring, monitored);
      const ref2 = await GenServer.monitor(monitoring, monitored);
      const ref3 = await GenServer.monitor(monitoring, monitored);

      expect(ref1.monitorId).not.toBe(ref2.monitorId);
      expect(ref2.monitorId).not.toBe(ref3.monitorId);
      expect(GenServer._getLocalMonitorCount()).toBe(3);

      await GenServer.stop(monitored);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should receive 3 separate process_down events
      expect(receivedEvents.length).toBe(3);

      await GenServer.stop(monitoring);
    });
  });
});
