/**
 * Dashboard Example - Real-time TUI Monitoring
 *
 * This example demonstrates the noex Dashboard for monitoring supervision trees
 * in real-time. It creates a sample application with multiple GenServers and
 * Supervisors, then launches the TUI dashboard to visualize:
 *
 * - Process tree hierarchy
 * - GenServer statistics (messages, queue size, uptime)
 * - Memory usage
 * - Real-time events
 *
 * Controls:
 *   q, Escape  - Quit
 *   r          - Refresh
 *   1/2/3      - Switch layouts (full/compact/minimal)
 *   Tab        - Navigate between widgets
 *   Enter      - Show process details
 *   ?          - Help
 */

import {
  GenServer,
  Supervisor,
  type GenServerBehavior,
  type GenServerRef,
} from '../../dist/index.js';
import { Dashboard } from '../../dist/dashboard/index.js';

// ============================================================================
// Sample GenServer: Counter
// ============================================================================

interface CounterState {
  value: number;
}

type CounterCall = { type: 'get' } | { type: 'increment'; amount: number };
type CounterCast = { type: 'reset' };
type CounterReply = number;

const counterBehavior: GenServerBehavior<CounterState, CounterCall, CounterCast, CounterReply> = {
  init: () => ({ value: 0 }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.value, state];
      case 'increment':
        const newValue = state.value + msg.amount;
        return [newValue, { value: newValue }];
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'reset') {
      return { value: 0 };
    }
    return state;
  },
};

// ============================================================================
// Sample GenServer: Worker
// ============================================================================

interface WorkerState {
  taskCount: number;
  lastTask: string | null;
}

type WorkerCall = { type: 'status' };
type WorkerCast = { type: 'process'; task: string } | { type: 'crash' };
type WorkerReply = { taskCount: number; lastTask: string | null };

const workerBehavior: GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerReply> = {
  init: () => ({ taskCount: 0, lastTask: null }),

  handleCall: (msg, state) => {
    if (msg.type === 'status') {
      return [{ taskCount: state.taskCount, lastTask: state.lastTask }, state];
    }
    return [{ taskCount: 0, lastTask: null }, state];
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'process':
        return {
          taskCount: state.taskCount + 1,
          lastTask: msg.task,
        };
      case 'crash':
        throw new Error('Simulated worker crash');
    }
    return state;
  },
};

// ============================================================================
// Sample GenServer: Cache
// ============================================================================

interface CacheState {
  data: Map<string, unknown>;
  hits: number;
  misses: number;
}

type CacheCall = { type: 'get'; key: string } | { type: 'stats' };
type CacheCast = { type: 'set'; key: string; value: unknown } | { type: 'clear' };
type CacheReply = unknown | { hits: number; misses: number; size: number };

const cacheBehavior: GenServerBehavior<CacheState, CacheCall, CacheCast, CacheReply> = {
  init: () => ({ data: new Map(), hits: 0, misses: 0 }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get': {
        const value = state.data.get(msg.key);
        if (value !== undefined) {
          return [value, { ...state, hits: state.hits + 1 }];
        }
        return [null, { ...state, misses: state.misses + 1 }];
      }
      case 'stats':
        return [
          { hits: state.hits, misses: state.misses, size: state.data.size },
          state,
        ];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'set': {
        const newData = new Map(state.data);
        newData.set(msg.key, msg.value);
        return { ...state, data: newData };
      }
      case 'clear':
        return { ...state, data: new Map() };
    }
    return state;
  },
};

// ============================================================================
// Application Setup
// ============================================================================

interface AppRefs {
  counter: GenServerRef<CounterState, CounterCall, CounterCast, CounterReply>;
  workers: GenServerRef<WorkerState, WorkerCall, WorkerCast, WorkerReply>[];
  cache: GenServerRef<CacheState, CacheCall, CacheCast, CacheReply>;
}

async function startApplication(): Promise<AppRefs> {
  // Start counter
  const counter = await GenServer.start(counterBehavior);

  // Start workers under supervisor
  const workerSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 5, withinMs: 10000 },
    children: [
      { id: 'worker-1', start: () => GenServer.start(workerBehavior), restart: 'permanent' },
      { id: 'worker-2', start: () => GenServer.start(workerBehavior), restart: 'permanent' },
      { id: 'worker-3', start: () => GenServer.start(workerBehavior), restart: 'permanent' },
    ],
  });

  // Get worker refs
  const workerChildren = Supervisor.getChildren(workerSupervisor);
  const workers = workerChildren.map(
    (c) => c.ref as GenServerRef<WorkerState, WorkerCall, WorkerCast, WorkerReply>
  );

  // Start cache
  const cache = await GenServer.start(cacheBehavior);

  return { counter, workers, cache };
}

function simulateActivity(refs: AppRefs): () => void {
  let running = true;
  let taskId = 0;

  const interval = setInterval(async () => {
    if (!running) return;

    // Increment counter
    try {
      await GenServer.call(refs.counter, { type: 'increment', amount: 1 });
    } catch {
      // Counter may have stopped
    }

    // Send tasks to random worker
    const workerIdx = Math.floor(Math.random() * refs.workers.length);
    try {
      GenServer.cast(refs.workers[workerIdx], {
        type: 'process',
        task: `task-${++taskId}`,
      });
    } catch {
      // Worker may have stopped
    }

    // Cache operations
    const key = `key-${Math.floor(Math.random() * 10)}`;
    try {
      GenServer.cast(refs.cache, { type: 'set', key, value: { id: taskId } });
      await GenServer.call(refs.cache, { type: 'get', key });
    } catch {
      // Cache may have stopped
    }
  }, 200);

  return () => {
    running = false;
    clearInterval(interval);
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Starting application...');

  const refs = await startApplication();
  const stopSimulation = simulateActivity(refs);

  console.log('Application started. Launching dashboard...\n');

  const dashboard = new Dashboard({
    refreshInterval: 500,
    theme: 'dark',
    layout: 'full',
  });

  dashboard.start();

  process.on('SIGINT', async () => {
    stopSimulation();
    dashboard.stop();

    // Cleanup
    await GenServer.stop(refs.counter);
    await GenServer.stop(refs.cache);
    for (const worker of refs.workers) {
      try {
        await GenServer.stop(worker);
      } catch {
        // Already stopped
      }
    }

    process.exit(0);
  });
}

main().catch(console.error);
