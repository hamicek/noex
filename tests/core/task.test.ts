/**
 * Tests for Task module.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Task } from '../../src/core/task.js';
import { TaskTimeoutError, TaskExecutionError } from '../../src/core/task-types.js';
import { Supervisor } from '../../src/core/supervisor.js';
import { GenServer } from '../../src/core/gen-server.js';

describe('Task', () => {
  describe('Task.async', () => {
    it('should create and execute a task', async () => {
      const task = await Task.async(async () => 42);
      const result = await Task.await(task);
      expect(result).toBe(42);
    });

    it('should handle sync functions', async () => {
      const task = await Task.async(() => 'hello');
      const result = await Task.await(task);
      expect(result).toBe('hello');
    });

    it('should execute task immediately', async () => {
      let executed = false;
      const task = await Task.async(async () => {
        executed = true;
        return 'done';
      });
      // Give it a moment to execute
      await new Promise((r) => setTimeout(r, 10));
      expect(executed).toBe(true);
      await Task.await(task);
    });

    it('should handle complex return types', async () => {
      const task = await Task.async(async () => ({
        data: [1, 2, 3],
        meta: { count: 3 },
      }));
      const result = await Task.await(task);
      expect(result).toEqual({ data: [1, 2, 3], meta: { count: 3 } });
    });
  });

  describe('Task.await', () => {
    it('should wait for task completion', async () => {
      const task = await Task.async(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return 'delayed';
      });
      const result = await Task.await(task);
      expect(result).toBe('delayed');
    });

    it('should throw TaskTimeoutError on timeout', async () => {
      const task = await Task.async(async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return 'never';
      });
      await expect(Task.await(task, { timeout: 50 })).rejects.toThrow(TaskTimeoutError);
      await Task.shutdown(task);
    });

    it('should throw TaskExecutionError on task failure', async () => {
      const task = await Task.async(async () => {
        throw new Error('Task failed');
      });
      // Wait for execution to complete
      await new Promise((r) => setTimeout(r, 20));
      await expect(Task.await(task)).rejects.toThrow(TaskExecutionError);
    });

    it('should preserve error message in TaskExecutionError', async () => {
      const task = await Task.async(async () => {
        throw new Error('Specific error message');
      });
      await new Promise((r) => setTimeout(r, 20));
      try {
        await Task.await(task);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TaskExecutionError);
        expect((error as TaskExecutionError).message).toContain('Specific error message');
      }
    });
  });

  describe('Task.yield', () => {
    it('should return result if task is complete', async () => {
      const task = await Task.async(() => 'instant');
      // Wait for execution
      await new Promise((r) => setTimeout(r, 20));
      const result = await Task.yield(task);
      expect(result).toBe('instant');
    });

    it('should return undefined if task is still running', async () => {
      const task = await Task.async(async () => {
        await new Promise((r) => setTimeout(r, 500));
        return 'slow';
      });
      const result = await Task.yield(task);
      expect(result).toBeUndefined();
      await Task.shutdown(task);
    });
  });

  describe('Task.shutdown', () => {
    it('should stop a running task', async () => {
      const task = await Task.async(async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return 'never';
      });
      await Task.shutdown(task);
      expect(GenServer.isRunning(task)).toBe(false);
    });

    it('should be idempotent', async () => {
      const task = await Task.async(() => 'done');
      await Task.await(task);
      await Task.shutdown(task);
      await Task.shutdown(task); // Should not throw
    });
  });
});

describe('Task.Supervisor', () => {
  let sup: ReturnType<typeof Task.Supervisor.start> extends Promise<infer T> ? T : never;

  beforeEach(async () => {
    sup = await Task.Supervisor.start();
  });

  afterEach(async () => {
    if (Supervisor.isRunning(sup)) {
      await Task.Supervisor.stop(sup);
    }
  });

  describe('start', () => {
    it('should create a supervisor', async () => {
      expect(Supervisor.isRunning(sup)).toBe(true);
    });

    it('should accept name option', async () => {
      const named = await Task.Supervisor.start({ name: 'test-sup' });
      expect(Supervisor.isRunning(named)).toBe(true);
      await Task.Supervisor.stop(named);
    });
  });

  describe('async', () => {
    it('should start a supervised task', async () => {
      const task = await Task.Supervisor.async(sup, async () => 'supervised');
      const result = await Task.await(task);
      expect(result).toBe('supervised');
    });

    it('should run multiple tasks concurrently', async () => {
      const results: number[] = [];
      const tasks = await Promise.all([
        Task.Supervisor.async(sup, async () => {
          results.push(1);
          return 1;
        }),
        Task.Supervisor.async(sup, async () => {
          results.push(2);
          return 2;
        }),
        Task.Supervisor.async(sup, async () => {
          results.push(3);
          return 3;
        }),
      ]);

      const values = await Promise.all(tasks.map((t) => Task.await(t)));
      expect(values).toEqual([1, 2, 3]);
    });
  });

  describe('asyncStream', () => {
    it('should execute all functions and return results', async () => {
      const results = await Task.Supervisor.asyncStream(
        sup,
        [
          async () => 1,
          async () => 2,
          async () => 3,
        ],
      );
      expect(results).toEqual([1, 2, 3]);
    });

    it('should handle empty array', async () => {
      const results = await Task.Supervisor.asyncStream(sup, []);
      expect(results).toEqual([]);
    });

    it('should respect concurrency limit', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const fns = Array.from({ length: 10 }, (_, i) => async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
        return i;
      });

      const results = await Task.Supervisor.asyncStream(sup, fns, { concurrency: 3 });

      expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(maxConcurrent).toBeLessThanOrEqual(3);
    });

    it('should preserve order by default', async () => {
      const fns = [
        async () => {
          await new Promise((r) => setTimeout(r, 50));
          return 'slow';
        },
        async () => {
          await new Promise((r) => setTimeout(r, 10));
          return 'fast';
        },
      ];

      const results = await Task.Supervisor.asyncStream(sup, fns, { ordered: true });
      expect(results).toEqual(['slow', 'fast']);
    });

    it('should fail fast by default', async () => {
      const fns = [
        async () => {
          await new Promise((r) => setTimeout(r, 50));
          return 'slow';
        },
        async () => {
          throw new Error('Fast fail');
        },
      ];

      await expect(Task.Supervisor.asyncStream(sup, fns)).rejects.toThrow('Fast fail');
    });

    it('should apply timeout to individual tasks', async () => {
      const fns = [
        async () => 'quick',
        async () => {
          await new Promise((r) => setTimeout(r, 500));
          return 'slow';
        },
      ];

      await expect(
        Task.Supervisor.asyncStream(sup, fns, { timeout: 50, concurrency: 2 }),
      ).rejects.toThrow(TaskTimeoutError);
    });
  });

  describe('asyncStreamSettled', () => {
    it('should return StreamResult for each task', async () => {
      const results = await Task.Supervisor.asyncStreamSettled(
        sup,
        [
          async () => 'success',
          async () => {
            throw new Error('failure');
          },
          async () => 42,
        ],
      );

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ status: 'ok', value: 'success' });
      expect(results[1]?.status).toBe('error');
      expect((results[1] as { status: 'error'; error: Error }).error.message).toContain('failure');
      expect(results[2]).toEqual({ status: 'ok', value: 42 });
    });

    it('should not fail fast', async () => {
      let thirdExecuted = false;
      const results = await Task.Supervisor.asyncStreamSettled(
        sup,
        [
          async () => {
            throw new Error('first fails');
          },
          async () => {
            throw new Error('second fails');
          },
          async () => {
            thirdExecuted = true;
            return 'third succeeds';
          },
        ],
        { concurrency: 3 },
      );

      expect(thirdExecuted).toBe(true);
      expect(results).toHaveLength(3);
      expect(results[2]).toEqual({ status: 'ok', value: 'third succeeds' });
    });

    it('should respect concurrency limit', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const fns = Array.from({ length: 6 }, (_, i) => async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
        if (i % 2 === 0) throw new Error(`Error ${i}`);
        return i;
      });

      const results = await Task.Supervisor.asyncStreamSettled(sup, fns, { concurrency: 2 });

      expect(results).toHaveLength(6);
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('should handle timeout per task', async () => {
      const results = await Task.Supervisor.asyncStreamSettled(
        sup,
        [
          async () => 'quick',
          async () => {
            await new Promise((r) => setTimeout(r, 500));
            return 'slow';
          },
        ],
        { timeout: 50, concurrency: 2 },
      );

      expect(results[0]).toEqual({ status: 'ok', value: 'quick' });
      expect(results[1]?.status).toBe('error');
      expect((results[1] as { status: 'error'; error: Error }).error).toBeInstanceOf(TaskTimeoutError);
    });

    it('should handle empty array', async () => {
      const results = await Task.Supervisor.asyncStreamSettled(sup, []);
      expect(results).toEqual([]);
    });
  });

  describe('stop', () => {
    it('should stop the supervisor and all tasks', async () => {
      const task = await Task.Supervisor.async(sup, async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return 'never';
      });

      await Task.Supervisor.stop(sup);

      expect(Supervisor.isRunning(sup)).toBe(false);
    });
  });
});

describe('Task integration', () => {
  it('should work with real async operations', async () => {
    const task = await Task.async(async () => {
      // Simulate async I/O
      await new Promise((r) => setTimeout(r, 10));
      return { status: 'ok', data: [1, 2, 3] };
    });

    const result = await Task.await(task);
    expect(result).toEqual({ status: 'ok', data: [1, 2, 3] });
  });

  it('should handle many concurrent tasks', async () => {
    const sup = await Task.Supervisor.start();

    const fns = Array.from({ length: 100 }, (_, i) => async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 10));
      return i;
    });

    const results = await Task.Supervisor.asyncStream(sup, fns, { concurrency: 10 });

    expect(results).toHaveLength(100);
    expect(results.every((r, i) => r === i)).toBe(true);

    await Task.Supervisor.stop(sup);
  });

  it('should handle mixed success and failure in stream', async () => {
    const sup = await Task.Supervisor.start();

    const results = await Task.Supervisor.asyncStreamSettled(
      sup,
      [
        async () => 'a',
        async () => {
          throw new Error('b');
        },
        async () => 'c',
        async () => {
          throw new Error('d');
        },
        async () => 'e',
      ],
      { concurrency: 5 },
    );

    const successes = results.filter((r) => r.status === 'ok').length;
    const failures = results.filter((r) => r.status === 'error').length;

    expect(successes).toBe(3);
    expect(failures).toBe(2);

    await Task.Supervisor.stop(sup);
  });
});
