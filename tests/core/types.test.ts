import { describe, it, expect } from 'vitest';
import {
  CallTimeoutError,
  ServerNotRunningError,
  InitializationError,
  MaxRestartsExceededError,
  DuplicateChildError,
  ChildNotFoundError,
  NotRegisteredError,
  AlreadyRegisteredError,
  DEFAULTS,
} from '../../src/index.js';
import type {
  GenServerRef,
  TerminateReason,
  CallResult,
  GenServerBehavior,
  ChildRestartStrategy,
  ChildSpec,
  SupervisorStrategy,
  RestartIntensity,
  SupervisorOptions,
  SupervisorRef,
  LifecycleEvent,
  ServerStatus,
  ChildInfo,
} from '../../src/index.js';

describe('Core Types', () => {
  describe('DEFAULTS', () => {
    it('has correct default values', () => {
      expect(DEFAULTS.INIT_TIMEOUT).toBe(5000);
      expect(DEFAULTS.CALL_TIMEOUT).toBe(5000);
      expect(DEFAULTS.SHUTDOWN_TIMEOUT).toBe(5000);
      expect(DEFAULTS.MAX_RESTARTS).toBe(3);
      expect(DEFAULTS.RESTART_WITHIN_MS).toBe(5000);
    });

    it('is readonly (compile-time check)', () => {
      // TypeScript ensures this is readonly at compile time
      const timeout: 5000 = DEFAULTS.CALL_TIMEOUT;
      expect(timeout).toBe(5000);
    });
  });

  describe('Error Classes', () => {
    describe('CallTimeoutError', () => {
      it('creates error with correct message and properties', () => {
        const error = new CallTimeoutError('test-server', 3000);

        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(CallTimeoutError);
        expect(error.name).toBe('CallTimeoutError');
        expect(error.serverId).toBe('test-server');
        expect(error.timeoutMs).toBe(3000);
        expect(error.message).toBe(
          "Call to GenServer 'test-server' timed out after 3000ms",
        );
      });

      it('can be caught as Error', () => {
        try {
          throw new CallTimeoutError('srv', 1000);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      });
    });

    describe('ServerNotRunningError', () => {
      it('creates error with correct message and properties', () => {
        const error = new ServerNotRunningError('my-server');

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('ServerNotRunningError');
        expect(error.serverId).toBe('my-server');
        expect(error.message).toBe("GenServer 'my-server' is not running");
      });
    });

    describe('InitializationError', () => {
      it('creates error with correct message and properties', () => {
        const cause = new Error('Database connection failed');
        const error = new InitializationError('db-server', cause);

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('InitializationError');
        expect(error.serverId).toBe('db-server');
        expect(error.cause).toBe(cause);
        expect(error.message).toBe(
          "GenServer 'db-server' failed to initialize: Database connection failed",
        );
      });
    });

    describe('MaxRestartsExceededError', () => {
      it('creates error with correct message and properties', () => {
        const error = new MaxRestartsExceededError('main-sup', 5, 10000);

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('MaxRestartsExceededError');
        expect(error.supervisorId).toBe('main-sup');
        expect(error.maxRestarts).toBe(5);
        expect(error.withinMs).toBe(10000);
        expect(error.message).toBe(
          "Supervisor 'main-sup' exceeded max restarts (5 within 10000ms)",
        );
      });
    });

    describe('DuplicateChildError', () => {
      it('creates error with correct message and properties', () => {
        const error = new DuplicateChildError('app-sup', 'worker-1');

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('DuplicateChildError');
        expect(error.supervisorId).toBe('app-sup');
        expect(error.childId).toBe('worker-1');
        expect(error.message).toBe(
          "Child 'worker-1' already exists in supervisor 'app-sup'",
        );
      });
    });

    describe('ChildNotFoundError', () => {
      it('creates error with correct message and properties', () => {
        const error = new ChildNotFoundError('app-sup', 'missing-child');

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('ChildNotFoundError');
        expect(error.supervisorId).toBe('app-sup');
        expect(error.childId).toBe('missing-child');
        expect(error.message).toBe(
          "Child 'missing-child' not found in supervisor 'app-sup'",
        );
      });
    });

    describe('NotRegisteredError', () => {
      it('creates error with correct message and properties', () => {
        const error = new NotRegisteredError('unknown-process');

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('NotRegisteredError');
        expect(error.processName).toBe('unknown-process');
        expect(error.message).toBe(
          "No process registered under name 'unknown-process'",
        );
      });
    });

    describe('AlreadyRegisteredError', () => {
      it('creates error with correct message and properties', () => {
        const error = new AlreadyRegisteredError('main-server');

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('AlreadyRegisteredError');
        expect(error.registeredName).toBe('main-server');
        expect(error.message).toBe("Name 'main-server' is already registered");
      });
    });
  });

  describe('Type Definitions (compile-time checks)', () => {
    it('TerminateReason accepts valid values', () => {
      const normal: TerminateReason = 'normal';
      const shutdown: TerminateReason = 'shutdown';
      const errorReason: TerminateReason = { error: new Error('crash') };

      expect(normal).toBe('normal');
      expect(shutdown).toBe('shutdown');
      expect(errorReason.error).toBeInstanceOf(Error);
    });

    it('CallResult is a readonly tuple', () => {
      const result: CallResult<number, string> = [42, 'state'] as const;
      expect(result[0]).toBe(42);
      expect(result[1]).toBe('state');
    });

    it('ChildRestartStrategy accepts valid values', () => {
      const strategies: ChildRestartStrategy[] = [
        'permanent',
        'transient',
        'temporary',
      ];
      expect(strategies).toHaveLength(3);
    });

    it('SupervisorStrategy accepts valid values', () => {
      const strategies: SupervisorStrategy[] = [
        'one_for_one',
        'one_for_all',
        'rest_for_one',
      ];
      expect(strategies).toHaveLength(3);
    });

    it('ServerStatus accepts valid values', () => {
      const statuses: ServerStatus[] = [
        'initializing',
        'running',
        'stopping',
        'stopped',
      ];
      expect(statuses).toHaveLength(4);
    });

    it('GenServerBehavior interface can be implemented', () => {
      interface TestState {
        count: number;
      }
      type TestCallMsg = { type: 'get' } | { type: 'increment'; by: number };
      type TestCastMsg = { type: 'reset' };
      type TestCallReply = number;

      const behavior: GenServerBehavior<
        TestState,
        TestCallMsg,
        TestCastMsg,
        TestCallReply
      > = {
        init: () => ({ count: 0 }),
        handleCall: (msg, state) => {
          if (msg.type === 'get') {
            return [state.count, state] as const;
          }
          const newState = { count: state.count + msg.by };
          return [newState.count, newState] as const;
        },
        handleCast: (msg, state) => {
          if (msg.type === 'reset') {
            return { count: 0 };
          }
          return state;
        },
        terminate: (_reason, _state) => {
          // cleanup
        },
      };

      const initialState = behavior.init();
      expect(initialState).toEqual({ count: 0 });

      const [reply, newState] = behavior.handleCall(
        { type: 'increment', by: 5 },
        initialState,
      );
      expect(reply).toBe(5);
      expect(newState).toEqual({ count: 5 });

      const resetState = behavior.handleCast({ type: 'reset' }, newState);
      expect(resetState).toEqual({ count: 0 });
    });

    it('ChildSpec can be defined with all options', () => {
      const spec: ChildSpec<number, string, string, string> = {
        id: 'test-child',
        start: async () => {
          // This would normally start a GenServer
          return {} as GenServerRef<number, string, string, string>;
        },
        restart: 'permanent',
        shutdownTimeout: 10000,
      };

      expect(spec.id).toBe('test-child');
      expect(spec.restart).toBe('permanent');
      expect(spec.shutdownTimeout).toBe(10000);
    });

    it('SupervisorOptions can be defined with all options', () => {
      const options: SupervisorOptions = {
        strategy: 'one_for_all',
        children: [],
        restartIntensity: {
          maxRestarts: 5,
          withinMs: 10000,
        },
        name: 'main-supervisor',
      };

      expect(options.strategy).toBe('one_for_all');
      expect(options.restartIntensity?.maxRestarts).toBe(5);
      expect(options.name).toBe('main-supervisor');
    });

    it('RestartIntensity can be defined', () => {
      const intensity: RestartIntensity = {
        maxRestarts: 10,
        withinMs: 60000,
      };

      expect(intensity.maxRestarts).toBe(10);
      expect(intensity.withinMs).toBe(60000);
    });

    it('LifecycleEvent discriminated union works correctly', () => {
      const handleEvent = (event: LifecycleEvent): string => {
        switch (event.type) {
          case 'started':
            return `Started: ${event.ref.id}`;
          case 'crashed':
            return `Crashed: ${event.ref.id} - ${event.error.message}`;
          case 'restarted':
            return `Restarted: ${event.ref.id} (attempt ${event.attempt})`;
          case 'terminated':
            return `Terminated: ${event.ref.id}`;
        }
      };

      const startedEvent: LifecycleEvent = {
        type: 'started',
        ref: { id: 'test' } as GenServerRef,
      };

      const crashedEvent: LifecycleEvent = {
        type: 'crashed',
        ref: { id: 'test' } as GenServerRef,
        error: new Error('boom'),
      };

      expect(handleEvent(startedEvent)).toBe('Started: test');
      expect(handleEvent(crashedEvent)).toBe('Crashed: test - boom');
    });

    it('ChildInfo contains expected fields', () => {
      const info: ChildInfo = {
        id: 'worker',
        ref: { id: 'worker-ref' } as GenServerRef,
        spec: {
          id: 'worker',
          start: async () => ({}) as GenServerRef,
        },
        restartCount: 3,
      };

      expect(info.id).toBe('worker');
      expect(info.restartCount).toBe(3);
    });
  });
});
