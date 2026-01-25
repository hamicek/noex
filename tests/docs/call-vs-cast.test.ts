/**
 * Tests for the Call vs Cast documentation examples.
 * Verifies that all code examples from docs/learn/02-basics/03-call-vs-cast.md work correctly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  GenServer,
  type GenServerBehavior,
  CallTimeoutError,
  ServerNotRunningError,
} from '../../src/index.js';

describe('Call vs Cast Documentation Examples', () => {
  beforeEach(() => {
    GenServer._clearLifecycleHandlers();
  });

  describe('Bank Account Example', () => {
    interface BankAccountState {
      balance: number;
    }

    type CallMsg =
      | { type: 'getBalance' }
      | { type: 'withdraw'; amount: number };

    type CastMsg = { type: 'deposit'; amount: number };

    type Reply = number | { success: boolean; newBalance: number };

    const bankAccountBehavior: GenServerBehavior<BankAccountState, CallMsg, CastMsg, Reply> = {
      init() {
        return { balance: 1000 };
      },

      handleCall(msg, state) {
        switch (msg.type) {
          case 'getBalance':
            return [state.balance, state];

          case 'withdraw': {
            if (state.balance < msg.amount) {
              return [{ success: false, newBalance: state.balance }, state];
            }
            const newBalance = state.balance - msg.amount;
            return [
              { success: true, newBalance },
              { balance: newBalance },
            ];
          }
        }
      },

      handleCast(msg, state) {
        if (msg.type === 'deposit') {
          return { balance: state.balance + msg.amount };
        }
        return state;
      },
    };

    it('should handle call() for getBalance', async () => {
      const account = await GenServer.start(bankAccountBehavior);

      const balance = await GenServer.call(account, { type: 'getBalance' });
      expect(balance).toBe(1000);

      await GenServer.stop(account);
    });

    it('should handle call() for successful withdrawal', async () => {
      const account = await GenServer.start(bankAccountBehavior);

      const result = await GenServer.call(account, { type: 'withdraw', amount: 500 });
      expect(result).toEqual({ success: true, newBalance: 500 });

      const balance = await GenServer.call(account, { type: 'getBalance' });
      expect(balance).toBe(500);

      await GenServer.stop(account);
    });

    it('should handle call() for failed withdrawal (insufficient funds)', async () => {
      const account = await GenServer.start(bankAccountBehavior);

      const result = await GenServer.call(account, { type: 'withdraw', amount: 2000 });
      expect(result).toEqual({ success: false, newBalance: 1000 });

      // Balance should remain unchanged
      const balance = await GenServer.call(account, { type: 'getBalance' });
      expect(balance).toBe(1000);

      await GenServer.stop(account);
    });

    it('should handle cast() for deposits', async () => {
      const account = await GenServer.start(bankAccountBehavior);

      // cast() returns immediately
      GenServer.cast(account, { type: 'deposit', amount: 100 });
      GenServer.cast(account, { type: 'deposit', amount: 200 });
      GenServer.cast(account, { type: 'deposit', amount: 300 });

      // Wait for casts to process
      await new Promise((r) => setTimeout(r, 50));

      const balance = await GenServer.call(account, { type: 'getBalance' });
      expect(balance).toBe(1600); // 1000 + 100 + 200 + 300

      await GenServer.stop(account);
    });
  });

  describe('Timeout Handling', () => {
    interface SlowState {
      value: number;
    }

    type CallMsg = { type: 'slowOperation' } | { type: 'fastOperation' };
    type CastMsg = never;
    type Reply = string;

    const slowBehavior: GenServerBehavior<SlowState, CallMsg, CastMsg, Reply> = {
      init() {
        return { value: 0 };
      },

      async handleCall(msg, state) {
        if (msg.type === 'slowOperation') {
          await new Promise((r) => setTimeout(r, 200));
          return ['slow done', state];
        }
        return ['fast done', state];
      },

      handleCast(_msg, state) {
        return state;
      },
    };

    it('should throw CallTimeoutError when call times out', async () => {
      const server = await GenServer.start(slowBehavior);

      await expect(
        GenServer.call(server, { type: 'slowOperation' }, { timeout: 50 }),
      ).rejects.toThrow(CallTimeoutError);

      await GenServer.stop(server);
    });

    it('should succeed with sufficient timeout', async () => {
      const server = await GenServer.start(slowBehavior);

      const result = await GenServer.call(
        server,
        { type: 'slowOperation' },
        { timeout: 500 },
      );
      expect(result).toBe('slow done');

      await GenServer.stop(server);
    });

    it('should work with fast operations using default timeout', async () => {
      const server = await GenServer.start(slowBehavior);

      const result = await GenServer.call(server, { type: 'fastOperation' });
      expect(result).toBe('fast done');

      await GenServer.stop(server);
    });
  });

  describe('Error Handling', () => {
    interface State {
      value: number;
    }

    type CallMsg = { type: 'riskyOperation' } | { type: 'safeOperation' };
    type CastMsg = { type: 'failingSilently' } | { type: 'safeUpdate' };
    type Reply = string;

    const errorBehavior: GenServerBehavior<State, CallMsg, CastMsg, Reply> = {
      init() {
        return { value: 0 };
      },

      handleCall(msg, state) {
        if (msg.type === 'riskyOperation') {
          throw new Error('Something went wrong');
        }
        return ['ok', state];
      },

      handleCast(msg, state) {
        if (msg.type === 'failingSilently') {
          throw new Error('This error is swallowed');
        }
        return { value: state.value + 1 };
      },
    };

    it('should propagate errors from handleCall to caller', async () => {
      const server = await GenServer.start(errorBehavior);

      await expect(
        GenServer.call(server, { type: 'riskyOperation' }),
      ).rejects.toThrow('Something went wrong');

      // Server should still be running
      const result = await GenServer.call(server, { type: 'safeOperation' });
      expect(result).toBe('ok');

      await GenServer.stop(server);
    });

    it('should silently ignore errors in handleCast', async () => {
      const server = await GenServer.start(errorBehavior);

      // This doesn't throw
      GenServer.cast(server, { type: 'failingSilently' });

      // Wait for cast to process
      await new Promise((r) => setTimeout(r, 50));

      // Server should still be running
      const result = await GenServer.call(server, { type: 'safeOperation' });
      expect(result).toBe('ok');

      await GenServer.stop(server);
    });

    it('should throw ServerNotRunningError for stopped server', async () => {
      const server = await GenServer.start(errorBehavior);
      await GenServer.stop(server);

      await expect(
        GenServer.call(server, { type: 'safeOperation' }),
      ).rejects.toThrow(ServerNotRunningError);
    });
  });

  describe('Task Queue Example', () => {
    interface Task {
      id: string;
      payload: unknown;
      status: 'pending' | 'processing' | 'completed' | 'failed';
      result?: unknown;
      error?: string;
    }

    interface TaskQueueState {
      tasks: Map<string, Task>;
      nextId: number;
    }

    type CallMsg =
      | { type: 'submit'; payload: unknown }
      | { type: 'getStatus'; taskId: string }
      | { type: 'getResult'; taskId: string };

    type CastMsg =
      | { type: 'markComplete'; taskId: string; result: unknown }
      | { type: 'markFailed'; taskId: string; error: string };

    type Reply =
      | { taskId: string }
      | { status: Task['status'] }
      | { result: unknown }
      | { error: string };

    const taskQueueBehavior: GenServerBehavior<TaskQueueState, CallMsg, CastMsg, Reply> = {
      init() {
        return { tasks: new Map(), nextId: 1 };
      },

      handleCall(msg, state) {
        switch (msg.type) {
          case 'submit': {
            const taskId = `task_${state.nextId}`;
            const task: Task = {
              id: taskId,
              payload: msg.payload,
              status: 'pending',
            };

            const newTasks = new Map(state.tasks);
            newTasks.set(taskId, task);

            return [
              { taskId },
              { tasks: newTasks, nextId: state.nextId + 1 },
            ];
          }

          case 'getStatus': {
            const task = state.tasks.get(msg.taskId);
            if (!task) {
              return [{ error: 'Task not found' }, state];
            }
            return [{ status: task.status }, state];
          }

          case 'getResult': {
            const task = state.tasks.get(msg.taskId);
            if (!task) {
              return [{ error: 'Task not found' }, state];
            }
            if (task.status !== 'completed') {
              return [{ error: `Task is ${task.status}, not completed` }, state];
            }
            return [{ result: task.result }, state];
          }
        }
      },

      handleCast(msg, state) {
        const task = state.tasks.get(msg.taskId);
        if (!task) {
          return state;
        }

        const newTasks = new Map(state.tasks);

        switch (msg.type) {
          case 'markComplete':
            newTasks.set(msg.taskId, {
              ...task,
              status: 'completed',
              result: msg.result,
            });
            break;

          case 'markFailed':
            newTasks.set(msg.taskId, {
              ...task,
              status: 'failed',
              error: msg.error,
            });
            break;
        }

        return { ...state, tasks: newTasks };
      },
    };

    it('should submit tasks via call', async () => {
      const queue = await GenServer.start(taskQueueBehavior);

      const result = await GenServer.call(queue, {
        type: 'submit',
        payload: { action: 'test' },
      });

      expect(result).toEqual({ taskId: 'task_1' });

      await GenServer.stop(queue);
    });

    it('should get task status via call', async () => {
      const queue = await GenServer.start(taskQueueBehavior);

      const { taskId } = await GenServer.call(queue, {
        type: 'submit',
        payload: { action: 'test' },
      }) as { taskId: string };

      const status = await GenServer.call(queue, { type: 'getStatus', taskId });
      expect(status).toEqual({ status: 'pending' });

      await GenServer.stop(queue);
    });

    it('should mark task complete via cast', async () => {
      const queue = await GenServer.start(taskQueueBehavior);

      const { taskId } = await GenServer.call(queue, {
        type: 'submit',
        payload: { action: 'test' },
      }) as { taskId: string };

      GenServer.cast(queue, {
        type: 'markComplete',
        taskId,
        result: { data: 'success' },
      });

      await new Promise((r) => setTimeout(r, 50));

      const status = await GenServer.call(queue, { type: 'getStatus', taskId });
      expect(status).toEqual({ status: 'completed' });

      const result = await GenServer.call(queue, { type: 'getResult', taskId });
      expect(result).toEqual({ result: { data: 'success' } });

      await GenServer.stop(queue);
    });

    it('should mark task failed via cast', async () => {
      const queue = await GenServer.start(taskQueueBehavior);

      const { taskId } = await GenServer.call(queue, {
        type: 'submit',
        payload: { action: 'test' },
      }) as { taskId: string };

      GenServer.cast(queue, {
        type: 'markFailed',
        taskId,
        error: 'Something went wrong',
      });

      await new Promise((r) => setTimeout(r, 50));

      const status = await GenServer.call(queue, { type: 'getStatus', taskId });
      expect(status).toEqual({ status: 'failed' });

      await GenServer.stop(queue);
    });
  });

  describe('Counter Exercise', () => {
    interface CounterState {
      value: number;
    }

    type CallMsg =
      | { type: 'get' }
      | { type: 'incrementBy'; n: number }
      | { type: 'reset' };

    type CastMsg = { type: 'increment' } | { type: 'decrement' };

    type Reply = number;

    const counterBehavior: GenServerBehavior<CounterState, CallMsg, CastMsg, Reply> = {
      init() {
        return { value: 0 };
      },

      handleCall(msg, state) {
        switch (msg.type) {
          case 'get':
            return [state.value, state];

          case 'incrementBy': {
            const newValue = state.value + msg.n;
            return [newValue, { value: newValue }];
          }

          case 'reset': {
            const oldValue = state.value;
            return [oldValue, { value: 0 }];
          }
        }
      },

      handleCast(msg, state) {
        switch (msg.type) {
          case 'increment':
            return { value: state.value + 1 };

          case 'decrement':
            return { value: state.value - 1 };
        }
      },
    };

    it('should handle increment casts', async () => {
      const counter = await GenServer.start(counterBehavior);

      GenServer.cast(counter, { type: 'increment' });
      GenServer.cast(counter, { type: 'increment' });
      GenServer.cast(counter, { type: 'increment' });

      await new Promise((r) => setTimeout(r, 50));

      const value = await GenServer.call(counter, { type: 'get' });
      expect(value).toBe(3);

      await GenServer.stop(counter);
    });

    it('should handle decrement casts', async () => {
      const counter = await GenServer.start(counterBehavior);

      GenServer.cast(counter, { type: 'increment' });
      GenServer.cast(counter, { type: 'increment' });
      GenServer.cast(counter, { type: 'decrement' });

      await new Promise((r) => setTimeout(r, 50));

      const value = await GenServer.call(counter, { type: 'get' });
      expect(value).toBe(1);

      await GenServer.stop(counter);
    });

    it('should handle incrementBy call', async () => {
      const counter = await GenServer.start(counterBehavior);

      const newValue = await GenServer.call(counter, { type: 'incrementBy', n: 10 });
      expect(newValue).toBe(10);

      const currentValue = await GenServer.call(counter, { type: 'get' });
      expect(currentValue).toBe(10);

      await GenServer.stop(counter);
    });

    it('should handle reset call', async () => {
      const counter = await GenServer.start(counterBehavior);

      // Set up some value
      await GenServer.call(counter, { type: 'incrementBy', n: 42 });

      // Reset should return old value
      const oldValue = await GenServer.call(counter, { type: 'reset' });
      expect(oldValue).toBe(42);

      // New value should be 0
      const currentValue = await GenServer.call(counter, { type: 'get' });
      expect(currentValue).toBe(0);

      await GenServer.stop(counter);
    });

    it('should maintain consistency with mixed operations', async () => {
      const counter = await GenServer.start(counterBehavior);

      // Mix of casts and calls
      GenServer.cast(counter, { type: 'increment' });
      GenServer.cast(counter, { type: 'increment' });
      GenServer.cast(counter, { type: 'increment' });

      await new Promise((r) => setTimeout(r, 50));

      const value1 = await GenServer.call(counter, { type: 'get' });
      expect(value1).toBe(3);

      GenServer.cast(counter, { type: 'decrement' });
      await new Promise((r) => setTimeout(r, 50));

      const value2 = await GenServer.call(counter, { type: 'get' });
      expect(value2).toBe(2);

      const newValue = await GenServer.call(counter, { type: 'incrementBy', n: 10 });
      expect(newValue).toBe(12);

      const oldValue = await GenServer.call(counter, { type: 'reset' });
      expect(oldValue).toBe(12);

      const finalValue = await GenServer.call(counter, { type: 'get' });
      expect(finalValue).toBe(0);

      await GenServer.stop(counter);
    });
  });
});
