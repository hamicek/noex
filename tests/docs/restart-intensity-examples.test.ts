/**
 * Tests for examples from docs/learn/03-supervision/04-restart-intensity.md
 * Ensures that the code examples in the documentation actually work.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Supervisor,
  GenServer,
  MaxRestartsExceededError,
  type GenServerBehavior,
  type GenServerRef,
} from '../../src/index.js';

describe('Restart Intensity Documentation Examples', () => {
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

  describe('Default values', () => {
    it('uses default restartIntensity when not specified', async () => {
      const supervisor = await Supervisor.start({
        children: [],
      });

      expect(Supervisor.isRunning(supervisor)).toBe(true);
      await Supervisor.stop(supervisor);
    });

    it('accepts explicit restartIntensity configuration', async () => {
      const supervisor = await Supervisor.start({
        restartIntensity: { maxRestarts: 3, withinMs: 5000 },
        children: [],
      });

      expect(Supervisor.isRunning(supervisor)).toBe(true);
      await Supervisor.stop(supervisor);
    });
  });

  describe('MaxRestartsExceededError', () => {
    it('throws MaxRestartsExceededError with correct properties', async () => {
      interface CrashState {
        selfRef?: GenServerRef;
      }

      type CrashCall = { type: 'setRef'; ref: GenServerRef };
      type CrashCast = { type: 'crash' };

      const crashBehavior: GenServerBehavior<CrashState, CrashCall, CrashCast, void> = {
        init: () => ({}),
        handleCall(msg, state) {
          if (msg.type === 'setRef') {
            return [undefined, { selfRef: msg.ref }];
          }
          return [undefined, state];
        },
        handleCast(msg, state) {
          if (msg.type === 'crash' && state.selfRef) {
            GenServer.stop(state.selfRef, { error: new Error('Test crash') });
          }
          return state;
        },
      };

      let caughtError: MaxRestartsExceededError | null = null;

      // Set up error handler to catch the async thrown error
      const errorHandler = (error: Error) => {
        if (error instanceof MaxRestartsExceededError) {
          caughtError = error;
        }
      };
      process.on('unhandledRejection', errorHandler);

      const supervisor = await Supervisor.start({
        restartIntensity: { maxRestarts: 2, withinMs: 5000 },
        children: [
          {
            id: 'crashable',
            start: async () => {
              const ref = await GenServer.start(crashBehavior);
              await GenServer.call(ref, { type: 'setRef', ref });
              return ref;
            },
          },
        ],
      });

      // Trigger crashes until limit exceeded
      for (let i = 0; i < 5; i++) {
        const child = Supervisor.getChild(supervisor, 'crashable');
        if (child && GenServer.isRunning(child.ref) && Supervisor.isRunning(supervisor)) {
          GenServer.cast(child.ref, { type: 'crash' });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      // Wait for error to propagate
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Clean up error handler
      process.removeListener('unhandledRejection', errorHandler);

      expect(caughtError).toBeInstanceOf(MaxRestartsExceededError);
      if (caughtError) {
        expect(caughtError.supervisorId).toMatch(/^supervisor_/);
        expect(caughtError.maxRestarts).toBe(2);
        expect(caughtError.withinMs).toBe(5000);
      }

      // Supervisor should have stopped
      expect(Supervisor.isRunning(supervisor)).toBe(false);
    });
  });

  describe('Sliding window algorithm', () => {
    it('allows restart after old crashes age out of window', async () => {
      interface TestState {
        selfRef?: GenServerRef;
      }

      type TestCall = { type: 'setRef'; ref: GenServerRef };
      type TestCast = { type: 'crash' };

      const testBehavior: GenServerBehavior<TestState, TestCall, TestCast, void> = {
        init: () => ({}),
        handleCall(msg, state) {
          if (msg.type === 'setRef') {
            return [undefined, { selfRef: msg.ref }];
          }
          return [undefined, state];
        },
        handleCast(msg, state) {
          if (msg.type === 'crash' && state.selfRef) {
            GenServer.stop(state.selfRef, { error: new Error('Test crash') });
          }
          return state;
        },
      };

      const supervisor = await Supervisor.start({
        restartIntensity: { maxRestarts: 2, withinMs: 1000 },
        children: [
          {
            id: 'test',
            start: async () => {
              const ref = await GenServer.start(testBehavior);
              await GenServer.call(ref, { type: 'setRef', ref });
              return ref;
            },
          },
        ],
      });

      async function triggerCrash() {
        const child = Supervisor.getChild(supervisor, 'test');
        if (child && GenServer.isRunning(child.ref)) {
          GenServer.cast(child.ref, { type: 'crash' });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      // Trigger 2 crashes (at limit)
      await triggerCrash();
      await triggerCrash();

      expect(Supervisor.isRunning(supervisor)).toBe(true);

      // Wait for window to clear
      await new Promise((resolve) => setTimeout(resolve, 1200));

      // Should be able to crash again
      await triggerCrash();

      expect(Supervisor.isRunning(supervisor)).toBe(true);

      await Supervisor.stop(supervisor);
    });
  });

  describe('Different service configurations', () => {
    it('supports different restart intensity configurations', async () => {
      const simpleBehavior: GenServerBehavior<null, never, never, never> = {
        init: () => null,
        handleCall: (_, state) => [undefined as never, state],
        handleCast: (_, state) => state,
      };

      // Critical service - conservative
      const critical = await Supervisor.start({
        restartIntensity: { maxRestarts: 2, withinMs: 10000 },
        children: [
          { id: 'payment', start: () => GenServer.start(simpleBehavior) },
        ],
      });

      // Background worker - tolerant
      const worker = await Supervisor.start({
        restartIntensity: { maxRestarts: 10, withinMs: 60000 },
        children: [
          { id: 'job', start: () => GenServer.start(simpleBehavior) },
        ],
      });

      // Cache - very tolerant
      const cache = await Supervisor.start({
        restartIntensity: { maxRestarts: 20, withinMs: 30000 },
        children: [
          { id: 'cache', start: () => GenServer.start(simpleBehavior) },
        ],
      });

      expect(Supervisor.isRunning(critical)).toBe(true);
      expect(Supervisor.isRunning(worker)).toBe(true);
      expect(Supervisor.isRunning(cache)).toBe(true);

      await Promise.all([
        Supervisor.stop(critical),
        Supervisor.stop(worker),
        Supervisor.stop(cache),
      ]);
    });
  });

  describe('Lifecycle events', () => {
    it('emits restarted events that can be monitored', async () => {
      interface CrashState {
        selfRef?: GenServerRef;
      }

      type CrashCall = { type: 'setRef'; ref: GenServerRef };
      type CrashCast = { type: 'crash' };

      const crashBehavior: GenServerBehavior<CrashState, CrashCall, CrashCast, void> = {
        init: () => ({}),
        handleCall(msg, state) {
          if (msg.type === 'setRef') {
            return [undefined, { selfRef: msg.ref }];
          }
          return [undefined, state];
        },
        handleCast(msg, state) {
          if (msg.type === 'crash' && state.selfRef) {
            GenServer.stop(state.selfRef, { error: new Error('Test crash') });
          }
          return state;
        },
      };

      let restartCount = 0;
      const unsubscribe = Supervisor.onLifecycleEvent((event) => {
        if (event.type === 'restarted') {
          restartCount++;
        }
      });

      const supervisor = await Supervisor.start({
        restartIntensity: { maxRestarts: 5, withinMs: 5000 },
        children: [
          {
            id: 'crashable',
            start: async () => {
              const ref = await GenServer.start(crashBehavior);
              await GenServer.call(ref, { type: 'setRef', ref });
              return ref;
            },
          },
        ],
      });

      // Trigger 2 crashes
      for (let i = 0; i < 2; i++) {
        const child = Supervisor.getChild(supervisor, 'crashable');
        if (child && GenServer.isRunning(child.ref)) {
          GenServer.cast(child.ref, { type: 'crash' });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      unsubscribe();
      await Supervisor.stop(supervisor);

      expect(restartCount).toBe(2);
    });
  });
});
