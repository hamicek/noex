# First Application

In this guide, you'll build a complete supervised application with multiple services, automatic restarts, and service discovery using the Registry.

## What We're Building

A simple task manager with three services:

1. **TaskService** - Manages a list of tasks
2. **StatsService** - Tracks statistics (tasks created, completed)
3. **Supervisor** - Manages both services and restarts them on failure

```
ApplicationSupervisor (one_for_one)
├── TaskService
└── StatsService
```

## Step 1: Define the Services

### StatsService

Tracks application statistics:

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

// State
interface StatsState {
  tasksCreated: number;
  tasksCompleted: number;
}

// Messages
type StatsCallMsg = 'get_stats';
type StatsCastMsg = { type: 'task_created' } | { type: 'task_completed' };
type StatsReply = StatsState;

export const statsBehavior: GenServerBehavior<StatsState, StatsCallMsg, StatsCastMsg, StatsReply> = {
  init: () => ({
    tasksCreated: 0,
    tasksCompleted: 0,
  }),

  handleCall: (msg, state) => {
    return [state, state];
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'task_created':
        return { ...state, tasksCreated: state.tasksCreated + 1 };
      case 'task_completed':
        return { ...state, tasksCompleted: state.tasksCompleted + 1 };
    }
  },

  terminate: (reason) => {
    console.log(`StatsService terminated: ${reason}`);
  },
};
```

### TaskService

Manages tasks and notifies StatsService:

```typescript
import { GenServer, Registry, type GenServerBehavior } from 'noex';

// Types
interface Task {
  id: string;
  title: string;
  completed: boolean;
}

interface TaskState {
  tasks: Map<string, Task>;
  nextId: number;
}

type TaskCallMsg =
  | { type: 'list' }
  | { type: 'get'; id: string };

type TaskCastMsg =
  | { type: 'create'; title: string }
  | { type: 'complete'; id: string }
  | { type: 'delete'; id: string };

type TaskReply = Task[] | Task | undefined;

export const taskBehavior: GenServerBehavior<TaskState, TaskCallMsg, TaskCastMsg, TaskReply> = {
  init: () => ({
    tasks: new Map(),
    nextId: 1,
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'list':
        return [Array.from(state.tasks.values()), state];
      case 'get':
        return [state.tasks.get(msg.id), state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'create': {
        const id = `task-${state.nextId}`;
        const task: Task = { id, title: msg.title, completed: false };
        state.tasks.set(id, task);

        // Notify StatsService
        const stats = Registry.whereis('stats');
        if (stats) {
          GenServer.cast(stats, { type: 'task_created' });
        }

        return { ...state, nextId: state.nextId + 1 };
      }

      case 'complete': {
        const task = state.tasks.get(msg.id);
        if (task && !task.completed) {
          state.tasks.set(msg.id, { ...task, completed: true });

          // Notify StatsService
          const stats = Registry.whereis('stats');
          if (stats) {
            GenServer.cast(stats, { type: 'task_completed' });
          }
        }
        return state;
      }

      case 'delete': {
        state.tasks.delete(msg.id);
        return state;
      }
    }
  },

  terminate: (reason) => {
    console.log(`TaskService terminated: ${reason}`);
  },
};
```

## Step 2: Create the Supervisor

```typescript
import { Supervisor, GenServer, Registry } from 'noex';
import { statsBehavior } from './stats-service';
import { taskBehavior } from './task-service';

async function startApplication() {
  const supervisor = await Supervisor.start({
    // Restart strategy: only restart the failed child
    strategy: 'one_for_one',

    // Allow max 3 restarts within 5 seconds
    restartIntensity: {
      maxRestarts: 3,
      withinMs: 5000,
    },

    children: [
      {
        id: 'stats',
        restart: 'permanent',  // Always restart
        start: async () => {
          const ref = await GenServer.start(statsBehavior);
          Registry.register('stats', ref);
          return ref;
        },
      },
      {
        id: 'tasks',
        restart: 'permanent',
        start: async () => {
          const ref = await GenServer.start(taskBehavior);
          Registry.register('tasks', ref);
          return ref;
        },
      },
    ],
  });

  console.log('Application started!');
  return supervisor;
}
```

## Step 3: Use the Application

```typescript
async function main() {
  const supervisor = await startApplication();

  // Get service references from Registry
  const tasks = Registry.lookup('tasks');
  const stats = Registry.lookup('stats');

  // Create some tasks
  GenServer.cast(tasks, { type: 'create', title: 'Learn noex' });
  GenServer.cast(tasks, { type: 'create', title: 'Build an app' });
  GenServer.cast(tasks, { type: 'create', title: 'Deploy to production' });

  // Complete a task
  GenServer.cast(tasks, { type: 'complete', id: 'task-1' });

  // Wait a bit for messages to process
  await new Promise(resolve => setTimeout(resolve, 100));

  // Check stats
  const currentStats = await GenServer.call(stats, 'get_stats');
  console.log('Stats:', currentStats);
  // Stats: { tasksCreated: 3, tasksCompleted: 1 }

  // List tasks
  const taskList = await GenServer.call(tasks, { type: 'list' });
  console.log('Tasks:', taskList);

  // Graceful shutdown
  await Supervisor.stop(supervisor);
  console.log('Application stopped.');
}

main().catch(console.error);
```

## Step 4: Handle Graceful Shutdown

In production, handle process signals:

```typescript
async function main() {
  const supervisor = await startApplication();

  // Handle shutdown signals
  const shutdown = async () => {
    console.log('\nShutting down...');
    await Supervisor.stop(supervisor);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('Application running. Press Ctrl+C to stop.');

  // Keep the process alive
  await new Promise(() => {});
}
```

## Step 5: Test Fault Tolerance

Let's simulate a crash and see the Supervisor restart the service:

```typescript
import { Observer } from 'noex';

// Subscribe to lifecycle events
GenServer.onLifecycleEvent((event) => {
  if (event.type === 'crashed') {
    console.log(`Service crashed: ${event.ref.id}`);
  }
  if (event.type === 'restarted') {
    console.log(`Service restarted: ${event.ref.id} (attempt ${event.attempt})`);
  }
});

// Simulate a crash by adding a method that throws
const crashableTaskBehavior = {
  ...taskBehavior,
  handleCast: (msg, state) => {
    if (msg.type === 'crash') {
      throw new Error('Simulated crash!');
    }
    return taskBehavior.handleCast(msg, state);
  },
};

// Later, trigger the crash:
// GenServer.cast(tasks, { type: 'crash' });
// The supervisor will automatically restart the TaskService!
```

## Complete Application Code

Here's the complete application in a single file:

```typescript
import {
  GenServer,
  Supervisor,
  Registry,
  type GenServerBehavior
} from 'noex';

// ============ Stats Service ============
interface StatsState {
  tasksCreated: number;
  tasksCompleted: number;
}

type StatsCallMsg = 'get_stats';
type StatsCastMsg = { type: 'task_created' } | { type: 'task_completed' };

const statsBehavior: GenServerBehavior<StatsState, StatsCallMsg, StatsCastMsg, StatsState> = {
  init: () => ({ tasksCreated: 0, tasksCompleted: 0 }),
  handleCall: (msg, state) => [state, state],
  handleCast: (msg, state) => {
    if (msg.type === 'task_created') {
      return { ...state, tasksCreated: state.tasksCreated + 1 };
    }
    return { ...state, tasksCompleted: state.tasksCompleted + 1 };
  },
};

// ============ Task Service ============
interface Task {
  id: string;
  title: string;
  completed: boolean;
}

interface TaskState {
  tasks: Map<string, Task>;
  nextId: number;
}

type TaskCallMsg = { type: 'list' } | { type: 'get'; id: string };
type TaskCastMsg =
  | { type: 'create'; title: string }
  | { type: 'complete'; id: string };

const taskBehavior: GenServerBehavior<TaskState, TaskCallMsg, TaskCastMsg, Task[] | Task | undefined> = {
  init: () => ({ tasks: new Map(), nextId: 1 }),

  handleCall: (msg, state) => {
    if (msg.type === 'list') return [Array.from(state.tasks.values()), state];
    return [state.tasks.get(msg.id), state];
  },

  handleCast: (msg, state) => {
    if (msg.type === 'create') {
      const id = `task-${state.nextId}`;
      state.tasks.set(id, { id, title: msg.title, completed: false });
      Registry.whereis('stats') && GenServer.cast(Registry.lookup('stats'), { type: 'task_created' });
      return { ...state, nextId: state.nextId + 1 };
    }

    const task = state.tasks.get(msg.id);
    if (task && !task.completed) {
      state.tasks.set(msg.id, { ...task, completed: true });
      Registry.whereis('stats') && GenServer.cast(Registry.lookup('stats'), { type: 'task_completed' });
    }
    return state;
  },
};

// ============ Main Application ============
async function main() {
  // Start supervisor with both services
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      {
        id: 'stats',
        start: async () => {
          const ref = await GenServer.start(statsBehavior);
          Registry.register('stats', ref);
          return ref;
        },
      },
      {
        id: 'tasks',
        start: async () => {
          const ref = await GenServer.start(taskBehavior);
          Registry.register('tasks', ref);
          return ref;
        },
      },
    ],
  });

  // Use the services
  const tasks = Registry.lookup('tasks');
  const stats = Registry.lookup('stats');

  GenServer.cast(tasks, { type: 'create', title: 'Learn noex' });
  GenServer.cast(tasks, { type: 'create', title: 'Build something cool' });
  GenServer.cast(tasks, { type: 'complete', id: 'task-1' });

  await new Promise(r => setTimeout(r, 50));

  console.log('Stats:', await GenServer.call(stats, 'get_stats'));
  console.log('Tasks:', await GenServer.call(tasks, { type: 'list' }));

  // Shutdown
  await Supervisor.stop(supervisor);
}

main();
```

## Summary

You've learned how to:

1. **Create GenServers** with typed state and messages
2. **Use a Supervisor** to manage service lifecycle
3. **Register services** with the Registry for discovery
4. **Handle graceful shutdown** with proper signal handling
5. **Build fault-tolerant apps** with automatic restarts

## What's Next?

- Learn more about [GenServer](../concepts/genserver.md) concepts
- Understand [Supervisor](../concepts/supervisor.md) strategies
- Explore built-in services like [EventBus](../api/event-bus.md) and [Cache](../api/cache.md)
- Check out complete [Tutorials](../tutorials/index.md)

---

[Back to Getting Started](./index.md) | [Next: Core Concepts](../concepts/index.md)
