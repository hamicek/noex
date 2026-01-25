/**
 * Comprehensive tests for Application behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Application,
  Supervisor,
  GenServer,
  type GenServerBehavior,
  type SupervisorRef,
  type ApplicationRef,
  type ApplicationLifecycleEvent,
  ApplicationStartError,
  ApplicationAlreadyRunningError,
  ApplicationStopTimeoutError,
  ApplicationNotRunningError,
} from '../../src/index.js';

/**
 * Creates a simple counter behavior for testing.
 */
function createCounterBehavior(): GenServerBehavior<number, 'get', 'inc', number> {
  return {
    init: () => 0,
    handleCall: (_, state) => [state, state],
    handleCast: (_, state) => state + 1,
  };
}

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

describe('Application', () => {
  beforeEach(() => {
    Application._clearLifecycleHandlers();
    Application._resetIdCounter();
    Application._clearAll();
    Supervisor._clearLifecycleHandlers();
    Supervisor._resetIdCounter();
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
  });

  afterEach(async () => {
    await Application.stopAll();
    Application._clearLifecycleHandlers();
    Application._clearAll();
    await Supervisor._clearAll();
    Supervisor._clearLifecycleHandlers();
    GenServer._clearLifecycleHandlers();
  });

  describe('create()', () => {
    it('creates a typed behavior', () => {
      interface Config {
        port: number;
      }

      const behavior = Application.create<Config, SupervisorRef>({
        async start(config) {
          return Supervisor.start({
            strategy: 'one_for_one',
            children: [],
          });
        },
        stop() {
          // cleanup
        },
      });

      expect(behavior).toBeDefined();
      expect(behavior.start).toBeInstanceOf(Function);
      expect(behavior.stop).toBeInstanceOf(Function);
    });
  });

  describe('start()', () => {
    it('starts an application with supervisor', async () => {
      const behavior = Application.create<void, SupervisorRef>({
        async start() {
          return Supervisor.start({
            strategy: 'one_for_one',
            children: [],
          });
        },
      });

      const ref = await Application.start(behavior, {
        name: 'test-app',
        config: undefined,
        handleSignals: false,
      });

      expect(ref).toBeDefined();
      expect(ref.name).toBe('test-app');
      expect(Application.isRunning(ref)).toBe(true);
      expect(Application.getStatus(ref)).toBe('running');

      await Application.stop(ref);
    });

    it('starts an application with custom state', async () => {
      interface AppState {
        supervisor: SupervisorRef;
        server: { port: number };
      }

      const behavior = Application.create<{ port: number }, AppState>({
        async start(config) {
          const supervisor = await Supervisor.start();
          return {
            supervisor,
            server: { port: config.port },
          };
        },
      });

      const ref = await Application.start(behavior, {
        name: 'custom-state-app',
        config: { port: 3000 },
        handleSignals: false,
      });

      const state = Application.getState(ref);
      expect(state).toBeDefined();
      expect(state!.server.port).toBe(3000);

      await Application.stop(ref);
    });

    it('throws ApplicationAlreadyRunningError for duplicate name', async () => {
      const behavior = Application.create<void, SupervisorRef>({
        start: () => Supervisor.start(),
      });

      const ref = await Application.start(behavior, {
        name: 'duplicate-app',
        config: undefined,
        handleSignals: false,
      });

      await expect(
        Application.start(behavior, {
          name: 'duplicate-app',
          config: undefined,
          handleSignals: false,
        }),
      ).rejects.toThrow(ApplicationAlreadyRunningError);

      await Application.stop(ref);
    });

    it('throws ApplicationStartError on start failure', async () => {
      const behavior = Application.create<void, SupervisorRef>({
        start() {
          throw new Error('Start failed');
        },
      });

      await expect(
        Application.start(behavior, {
          name: 'failing-app',
          config: undefined,
          handleSignals: false,
        }),
      ).rejects.toThrow(ApplicationStartError);
    });

    it('throws ApplicationStartError on start timeout', async () => {
      const behavior = Application.create<void, SupervisorRef>({
        async start() {
          await new Promise((r) => setTimeout(r, 1000));
          return Supervisor.start();
        },
      });

      await expect(
        Application.start(behavior, {
          name: 'timeout-app',
          config: undefined,
          handleSignals: false,
          startTimeout: 50,
        }),
      ).rejects.toThrow(ApplicationStartError);
    });

    it('emits starting and started lifecycle events', async () => {
      const events: ApplicationLifecycleEvent[] = [];
      const unsubscribe = Application.onLifecycleEvent((event) => {
        events.push(event);
      });

      const behavior = Application.create<void, SupervisorRef>({
        start: () => Supervisor.start(),
      });

      const ref = await Application.start(behavior, {
        name: 'events-app',
        config: undefined,
        handleSignals: false,
      });

      expect(events.length).toBe(2);
      expect(events[0]!.type).toBe('starting');
      expect((events[0] as { name: string }).name).toBe('events-app');
      expect(events[1]!.type).toBe('started');

      unsubscribe();
      await Application.stop(ref);
    });

    it('emits start_failed event on failure', async () => {
      const events: ApplicationLifecycleEvent[] = [];
      const unsubscribe = Application.onLifecycleEvent((event) => {
        events.push(event);
      });

      const behavior = Application.create<void, SupervisorRef>({
        start() {
          throw new Error('Boom');
        },
      });

      await expect(
        Application.start(behavior, {
          name: 'fail-events-app',
          config: undefined,
          handleSignals: false,
        }),
      ).rejects.toThrow();

      expect(events.length).toBe(2);
      expect(events[0]!.type).toBe('starting');
      expect(events[1]!.type).toBe('start_failed');

      unsubscribe();
    });
  });

  describe('stop()', () => {
    it('stops a running application', async () => {
      const behavior = Application.create<void, SupervisorRef>({
        start: () => Supervisor.start(),
      });

      const ref = await Application.start(behavior, {
        name: 'stop-test-app',
        config: undefined,
        handleSignals: false,
      });

      expect(Application.isRunning(ref)).toBe(true);

      await Application.stop(ref);

      expect(Application.isRunning(ref)).toBe(false);
      expect(Application.getStatus(ref)).toBe('stopped');
    });

    it('calls prepStop and stop callbacks', async () => {
      const callOrder: string[] = [];

      const behavior = Application.create<void, SupervisorRef>({
        start: () => Supervisor.start(),
        prepStop() {
          callOrder.push('prepStop');
        },
        stop() {
          callOrder.push('stop');
        },
      });

      const ref = await Application.start(behavior, {
        name: 'callbacks-app',
        config: undefined,
        handleSignals: false,
      });

      await Application.stop(ref);

      expect(callOrder).toEqual(['prepStop', 'stop']);
    });

    it('stops the supervisor tree', async () => {
      let supervisorRef: SupervisorRef | undefined;

      const behavior = Application.create<void, SupervisorRef>({
        async start() {
          supervisorRef = await Supervisor.start({
            children: [
              {
                id: 'child1',
                start: () => GenServer.start(createCounterBehavior()),
              },
            ],
          });
          return supervisorRef;
        },
      });

      const ref = await Application.start(behavior, {
        name: 'supervisor-stop-app',
        config: undefined,
        handleSignals: false,
      });

      expect(Supervisor.isRunning(supervisorRef!)).toBe(true);

      await Application.stop(ref);

      expect(Supervisor.isRunning(supervisorRef!)).toBe(false);
    });

    it('throws ApplicationNotRunningError for stopped application', async () => {
      const behavior = Application.create<void, SupervisorRef>({
        start: () => Supervisor.start(),
      });

      const ref = await Application.start(behavior, {
        name: 'not-running-app',
        config: undefined,
        handleSignals: false,
      });

      await Application.stop(ref);

      await expect(Application.stop(ref)).rejects.toThrow(ApplicationNotRunningError);
    });

    it('throws ApplicationStopTimeoutError on stop timeout', async () => {
      const behavior = Application.create<void, SupervisorRef>({
        start: () => Supervisor.start(),
        async stop() {
          await new Promise((r) => setTimeout(r, 1000));
        },
      });

      const ref = await Application.start(behavior, {
        name: 'stop-timeout-app',
        config: undefined,
        handleSignals: false,
        stopTimeout: 50,
      });

      await expect(Application.stop(ref)).rejects.toThrow(ApplicationStopTimeoutError);

      // Cleanup
      Application._clearAll();
    });

    it('emits stopping and stopped lifecycle events', async () => {
      const events: ApplicationLifecycleEvent[] = [];

      const behavior = Application.create<void, SupervisorRef>({
        start: () => Supervisor.start(),
      });

      const ref = await Application.start(behavior, {
        name: 'stop-events-app',
        config: undefined,
        handleSignals: false,
      });

      const unsubscribe = Application.onLifecycleEvent((event) => {
        events.push(event);
      });

      await Application.stop(ref);

      expect(events.length).toBe(2);
      expect(events[0]!.type).toBe('stopping');
      expect(events[1]!.type).toBe('stopped');

      unsubscribe();
    });
  });

  describe('getStatus()', () => {
    it('returns stopped for unknown ref', () => {
      const fakeRef = { id: 'fake', name: 'fake' } as ApplicationRef;
      expect(Application.getStatus(fakeRef)).toBe('stopped');
    });

    it('returns correct status through lifecycle', async () => {
      const behavior = Application.create<void, SupervisorRef>({
        start: () => Supervisor.start(),
      });

      const ref = await Application.start(behavior, {
        name: 'status-app',
        config: undefined,
        handleSignals: false,
      });

      expect(Application.getStatus(ref)).toBe('running');

      await Application.stop(ref);

      expect(Application.getStatus(ref)).toBe('stopped');
    });
  });

  describe('getSupervisor()', () => {
    it('returns supervisor ref when state is SupervisorRef', async () => {
      const behavior = Application.create<void, SupervisorRef>({
        start: () => Supervisor.start(),
      });

      const ref = await Application.start(behavior, {
        name: 'supervisor-app',
        config: undefined,
        handleSignals: false,
      });

      const supervisorRef = Application.getSupervisor(ref);
      expect(supervisorRef).toBeDefined();
      expect(Supervisor.isRunning(supervisorRef!)).toBe(true);

      await Application.stop(ref);
    });

    it('returns undefined for non-supervisor state', async () => {
      const behavior = Application.create<void, string>({
        start: () => 'custom-state',
      });

      const ref = await Application.start(behavior, {
        name: 'custom-state-app',
        config: undefined,
        handleSignals: false,
      });

      const supervisorRef = Application.getSupervisor(ref);
      expect(supervisorRef).toBeUndefined();

      await Application.stop(ref);
    });
  });

  describe('getAllRunning()', () => {
    it('returns all running applications', async () => {
      const behavior = Application.create<void, SupervisorRef>({
        start: () => Supervisor.start(),
      });

      const ref1 = await Application.start(behavior, {
        name: 'app1',
        config: undefined,
        handleSignals: false,
      });

      const ref2 = await Application.start(behavior, {
        name: 'app2',
        config: undefined,
        handleSignals: false,
      });

      const running = Application.getAllRunning();
      expect(running.length).toBe(2);

      const names = running.map((r) => r.name);
      expect(names).toContain('app1');
      expect(names).toContain('app2');

      await Application.stop(ref1);
      await Application.stop(ref2);
    });

    it('returns empty array when no applications running', () => {
      const running = Application.getAllRunning();
      expect(running.length).toBe(0);
    });
  });

  describe('lookup()', () => {
    it('finds application by name', async () => {
      const behavior = Application.create<void, SupervisorRef>({
        start: () => Supervisor.start(),
      });

      const ref = await Application.start(behavior, {
        name: 'lookup-app',
        config: undefined,
        handleSignals: false,
      });

      const found = Application.lookup('lookup-app');
      expect(found).toBeDefined();
      expect(found!.id).toBe(ref.id);
      expect(found!.name).toBe('lookup-app');

      await Application.stop(ref);
    });

    it('returns undefined for unknown name', () => {
      const found = Application.lookup('nonexistent');
      expect(found).toBeUndefined();
    });
  });

  describe('stopAll()', () => {
    it('stops all running applications in LIFO order', async () => {
      const stopOrder: string[] = [];

      const createBehavior = (name: string) =>
        Application.create<void, SupervisorRef>({
          start: () => Supervisor.start(),
          stop() {
            stopOrder.push(name);
          },
        });

      await Application.start(createBehavior('first'), {
        name: 'first',
        config: undefined,
        handleSignals: false,
      });

      // Small delay to ensure different startedAt timestamps
      await new Promise((r) => setTimeout(r, 10));

      await Application.start(createBehavior('second'), {
        name: 'second',
        config: undefined,
        handleSignals: false,
      });

      await new Promise((r) => setTimeout(r, 10));

      await Application.start(createBehavior('third'), {
        name: 'third',
        config: undefined,
        handleSignals: false,
      });

      await Application.stopAll();

      expect(stopOrder).toEqual(['third', 'second', 'first']);
    });
  });

  describe('getInfo()', () => {
    it('returns application info', async () => {
      const behavior = Application.create<void, SupervisorRef>({
        start: () => Supervisor.start(),
      });

      const ref = await Application.start(behavior, {
        name: 'info-app',
        config: undefined,
        handleSignals: false,
      });

      const info = Application.getInfo(ref);
      expect(info).toBeDefined();
      expect(info!.name).toBe('info-app');
      expect(info!.status).toBe('running');
      expect(info!.startedAt).toBeLessThanOrEqual(Date.now());
      expect(info!.uptimeMs).toBeGreaterThanOrEqual(0);

      await Application.stop(ref);
    });

    it('returns undefined for unknown ref', () => {
      const fakeRef = { id: 'fake', name: 'fake' } as ApplicationRef;
      const info = Application.getInfo(fakeRef);
      expect(info).toBeUndefined();
    });
  });

  describe('onLifecycleEvent()', () => {
    it('registers and unregisters handler', async () => {
      const events: ApplicationLifecycleEvent[] = [];
      const unsubscribe = Application.onLifecycleEvent((event) => {
        events.push(event);
      });

      const behavior = Application.create<void, SupervisorRef>({
        start: () => Supervisor.start(),
      });

      const ref = await Application.start(behavior, {
        name: 'handler-app',
        config: undefined,
        handleSignals: false,
      });

      expect(events.length).toBe(2); // starting, started

      unsubscribe();

      await Application.stop(ref);

      // Should not receive stopping/stopped events after unsubscribe
      expect(events.length).toBe(2);
    });

    it('handles errors in lifecycle handlers gracefully', async () => {
      Application.onLifecycleEvent(() => {
        throw new Error('Handler error');
      });

      const behavior = Application.create<void, SupervisorRef>({
        start: () => Supervisor.start(),
      });

      // Should not throw despite handler error
      const ref = await Application.start(behavior, {
        name: 'error-handler-app',
        config: undefined,
        handleSignals: false,
      });

      await Application.stop(ref);
    });
  });

  describe('integration scenarios', () => {
    it('manages complete application lifecycle with supervisor tree', async () => {
      interface Config {
        workerCount: number;
      }

      const behavior = Application.create<Config, SupervisorRef>({
        async start(config) {
          const children = Array.from({ length: config.workerCount }, (_, i) => ({
            id: `worker-${i}`,
            start: () => GenServer.start(createCounterBehavior()),
          }));

          return Supervisor.start({
            strategy: 'one_for_one',
            children,
          });
        },
        prepStop() {
          // Drain queues
        },
        stop() {
          // Final cleanup
        },
      });

      const ref = await Application.start(behavior, {
        name: 'integration-app',
        config: { workerCount: 3 },
        handleSignals: false,
      });

      const supervisor = Application.getSupervisor(ref);
      expect(supervisor).toBeDefined();
      expect(Supervisor.countChildren(supervisor!)).toBe(3);

      await Application.stop(ref);

      expect(Application.isRunning(ref)).toBe(false);
      expect(Supervisor.isRunning(supervisor!)).toBe(false);
    });

    it('handles async start and stop callbacks', async () => {
      let startCompleted = false;
      let stopCompleted = false;

      const behavior = Application.create<void, SupervisorRef>({
        async start() {
          await new Promise((r) => setTimeout(r, 50));
          startCompleted = true;
          return Supervisor.start();
        },
        async prepStop() {
          await new Promise((r) => setTimeout(r, 20));
        },
        async stop() {
          await new Promise((r) => setTimeout(r, 20));
          stopCompleted = true;
        },
      });

      const ref = await Application.start(behavior, {
        name: 'async-app',
        config: undefined,
        handleSignals: false,
      });

      expect(startCompleted).toBe(true);

      await Application.stop(ref);

      expect(stopCompleted).toBe(true);
    });
  });
});
