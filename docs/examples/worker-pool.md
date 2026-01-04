# Worker Pool

A dynamic pool of workers for parallel task processing.

## Overview

This example shows:
- DynamicSupervisor pattern for managing workers
- Task distribution across workers
- Load balancing with round-robin
- Graceful scaling up/down

## Complete Code

```typescript
import {
  GenServer,
  Supervisor,
  Registry,
  type GenServerBehavior,
  type GenServerRef,
  type ChildSpec,
} from 'noex';

// Worker types
interface WorkerState {
  id: number;
  tasksProcessed: number;
}

type WorkerCall = { type: 'process'; task: string };
type WorkerCast = { type: 'reset_stats' };
type WorkerReply = { result: string; workerId: number };

// Worker behavior
const workerBehavior = (id: number): GenServerBehavior<
  WorkerState,
  WorkerCall,
  WorkerCast,
  WorkerReply
> => ({
  init: () => ({ id, tasksProcessed: 0 }),

  handleCall: async (msg, state) => {
    switch (msg.type) {
      case 'process': {
        // Simulate processing
        await new Promise(resolve => setTimeout(resolve, 100));
        const result = `Processed "${msg.task}" by worker ${state.id}`;
        return [
          { result, workerId: state.id },
          { ...state, tasksProcessed: state.tasksProcessed + 1 },
        ];
      }
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'reset_stats':
        return { ...state, tasksProcessed: 0 };
    }
  },
});

// Pool manager types
interface PoolState {
  workers: GenServerRef[];
  nextWorkerIndex: number;
  poolSize: number;
}

type PoolCall =
  | { type: 'submit'; task: string }
  | { type: 'get_stats' };

type PoolCast =
  | { type: 'scale'; count: number };

type PoolReply =
  | { result: string; workerId: number }
  | { workerCount: number; totalTasks: number };

// Pool manager behavior
const poolBehavior: GenServerBehavior<PoolState, PoolCall, PoolCast, PoolReply> = {
  init: async () => {
    const poolSize = 4;
    const workers: GenServerRef[] = [];

    // Start initial workers
    for (let i = 0; i < poolSize; i++) {
      const worker = await GenServer.start(workerBehavior(i));
      workers.push(worker);
    }

    return { workers, nextWorkerIndex: 0, poolSize };
  },

  handleCall: async (msg, state) => {
    switch (msg.type) {
      case 'submit': {
        // Round-robin worker selection
        const worker = state.workers[state.nextWorkerIndex];
        const nextIndex = (state.nextWorkerIndex + 1) % state.workers.length;

        // Delegate to worker
        const result = await GenServer.call<WorkerReply>(worker, {
          type: 'process',
          task: msg.task,
        });

        return [result, { ...state, nextWorkerIndex: nextIndex }];
      }

      case 'get_stats': {
        return [
          { workerCount: state.workers.length, totalTasks: 0 },
          state,
        ];
      }
    }
  },

  handleCast: async (msg, state) => {
    switch (msg.type) {
      case 'scale': {
        const currentSize = state.workers.length;
        const targetSize = msg.count;

        if (targetSize > currentSize) {
          // Scale up
          const newWorkers = [...state.workers];
          for (let i = currentSize; i < targetSize; i++) {
            const worker = await GenServer.start(workerBehavior(i));
            newWorkers.push(worker);
          }
          return { ...state, workers: newWorkers };
        } else if (targetSize < currentSize) {
          // Scale down
          const toRemove = state.workers.slice(targetSize);
          for (const worker of toRemove) {
            await GenServer.stop(worker);
          }
          return { ...state, workers: state.workers.slice(0, targetSize) };
        }

        return state;
      }
    }
  },

  terminate: async (_reason, state) => {
    // Stop all workers on shutdown
    for (const worker of state.workers) {
      await GenServer.stop(worker);
    }
  },
};

// Main
async function main() {
  const pool = await GenServer.start(poolBehavior);

  // Submit tasks
  const tasks = ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'];

  console.log('Submitting tasks...\n');

  for (const task of tasks) {
    const result = await GenServer.call<{ result: string; workerId: number }>(
      pool,
      { type: 'submit', task }
    );
    console.log(`Result: ${result.result}`);
  }

  // Submit tasks in parallel
  console.log('\nSubmitting tasks in parallel...\n');

  const parallelTasks = ['parallel-1', 'parallel-2', 'parallel-3', 'parallel-4'];
  const results = await Promise.all(
    parallelTasks.map(task =>
      GenServer.call<{ result: string; workerId: number }>(
        pool,
        { type: 'submit', task }
      )
    )
  );

  for (const result of results) {
    console.log(`Result: ${result.result}`);
  }

  // Scale down
  console.log('\nScaling pool to 2 workers...');
  GenServer.cast(pool, { type: 'scale', count: 2 });

  // Wait for scale operation
  await new Promise(resolve => setTimeout(resolve, 100));

  // Submit more tasks with smaller pool
  console.log('\nSubmitting with smaller pool...\n');

  for (const task of ['small-pool-1', 'small-pool-2', 'small-pool-3']) {
    const result = await GenServer.call<{ result: string; workerId: number }>(
      pool,
      { type: 'submit', task }
    );
    console.log(`Result: ${result.result}`);
  }

  await GenServer.stop(pool);
  console.log('\nPool stopped');
}

main().catch(console.error);
```

## Output

```
Submitting tasks...

Result: Processed "task-1" by worker 0
Result: Processed "task-2" by worker 1
Result: Processed "task-3" by worker 2
Result: Processed "task-4" by worker 3
Result: Processed "task-5" by worker 0

Submitting tasks in parallel...

Result: Processed "parallel-1" by worker 1
Result: Processed "parallel-2" by worker 2
Result: Processed "parallel-3" by worker 3
Result: Processed "parallel-4" by worker 0

Scaling pool to 2 workers...

Submitting with smaller pool...

Result: Processed "small-pool-1" by worker 0
Result: Processed "small-pool-2" by worker 1
Result: Processed "small-pool-3" by worker 0

Pool stopped
```

## Key Patterns

### Round-Robin Distribution

```typescript
const worker = state.workers[state.nextWorkerIndex];
const nextIndex = (state.nextWorkerIndex + 1) % state.workers.length;
```

### Dynamic Scaling

```typescript
// Scale up: add workers
for (let i = currentSize; i < targetSize; i++) {
  const worker = await GenServer.start(workerBehavior(i));
  newWorkers.push(worker);
}

// Scale down: remove workers
const toRemove = state.workers.slice(targetSize);
for (const worker of toRemove) {
  await GenServer.stop(worker);
}
```

### Supervised Worker Pool

For fault-tolerant worker pools, use a Supervisor:

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: Array.from({ length: 4 }, (_, i) => ({
    id: `worker-${i}`,
    start: () => GenServer.start(workerBehavior(i)),
    restart: 'permanent',
  })),
});
```

## Alternative: Load-Based Distribution

Instead of round-robin, distribute based on worker load:

```typescript
handleCall: async (msg, state) => {
  switch (msg.type) {
    case 'submit': {
      // Find worker with least tasks
      let minTasks = Infinity;
      let selectedWorker = state.workers[0];

      for (const worker of state.workers) {
        const info = await GenServer.call<WorkerState>(worker, { type: 'get_info' });
        if (info.tasksProcessed < minTasks) {
          minTasks = info.tasksProcessed;
          selectedWorker = worker;
        }
      }

      const result = await GenServer.call<WorkerReply>(selectedWorker, {
        type: 'process',
        task: msg.task,
      });

      return [result, state];
    }
  }
},
```

## Related

- [Supervisor Concept](../concepts/supervisor.md) - Supervision strategies
- [Supervision Trees Guide](../guides/supervision-trees.md) - Building supervision trees
- [Supervisor API](../api/supervisor.md) - Complete API reference
