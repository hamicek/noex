# Signal Handling

In the previous chapter, you learned how to structure applications using the Application behavior. Now let's dive deeper into **signal handling** — the mechanism that enables graceful shutdown in production environments.

## What You'll Learn

- Understand Unix signals (SIGINT, SIGTERM) and when they're sent
- Configure automatic signal handling in noex applications
- Implement proper cleanup sequences during shutdown
- Handle edge cases like timeout and forced termination
- Build resilient applications for container orchestration

## Understanding Unix Signals

Unix signals are asynchronous notifications sent to processes. Two signals are critical for graceful shutdown:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SHUTDOWN SIGNALS                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  SIGINT (2)                           SIGTERM (15)                          │
│  ┌─────────────────────┐              ┌─────────────────────┐               │
│  │ "Interrupt Signal"  │              │ "Terminate Signal"  │               │
│  │                     │              │                     │               │
│  │ Triggered by:       │              │ Triggered by:       │               │
│  │ • Ctrl+C in terminal│              │ • kill <pid>        │               │
│  │ • IDE stop button   │              │ • Docker stop       │               │
│  │                     │              │ • Kubernetes pod    │               │
│  │ Intent:             │              │   termination       │               │
│  │ User wants to stop  │              │ • systemctl stop    │               │
│  │ the process         │              │                     │               │
│  └─────────────────────┘              │ Intent:             │               │
│                                       │ System requests     │               │
│  SIGKILL (9)                          │ graceful shutdown   │               │
│  ┌─────────────────────┐              └─────────────────────┘               │
│  │ "Kill Signal"       │                                                    │
│  │                     │              Both SIGINT and SIGTERM allow         │
│  │ Triggered by:       │              the process to perform cleanup.       │
│  │ • kill -9 <pid>     │                                                    │
│  │ • OOM killer        │              SIGKILL cannot be caught and          │
│  │                     │              terminates immediately.               │
│  │ Intent:             │                                                    │
│  │ Force immediate     │                                                    │
│  │ termination         │                                                    │
│  │ (cannot be caught!) │                                                    │
│  └─────────────────────┘                                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key insight:** SIGINT and SIGTERM give your application a chance to shut down gracefully. SIGKILL does not — it's the "nuclear option" that terminates immediately.

## Automatic Signal Handling

By default, noex applications automatically handle SIGINT and SIGTERM:

```typescript
import { Application, Supervisor } from '@hamicek/noex';

const MyApp = Application.create({
  async start() {
    return Supervisor.start({
      strategy: 'one_for_one',
      children: [
        { id: 'worker', start: () => Worker.start() },
      ],
    });
  },
});

// handleSignals defaults to true
const app = await Application.start(MyApp, {
  name: 'my-app',
  config: undefined,
});

// Now pressing Ctrl+C or sending SIGTERM will:
// 1. Trigger Application.stop(app, 'signal')
// 2. Execute the full shutdown sequence
// 3. Exit cleanly
```

### What Happens When a Signal Arrives

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SIGNAL HANDLING SEQUENCE                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  SIGINT/SIGTERM received                                                    │
│         │                                                                   │
│         ▼                                                                   │
│  ┌──────────────────┐                                                       │
│  │ Signal Handler   │  Registered by Application.start()                    │
│  │ (in noex)        │  when handleSignals: true                             │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           │  Calls Application.stop(ref, 'signal')                          │
│           ▼                                                                 │
│  ┌──────────────────────────────────────────────────────────────────┐       │
│  │                     STOP SEQUENCE                                │       │
│  │                                                                  │       │
│  │  1. Status → 'stopping'                                          │       │
│  │  2. Emit 'stopping' lifecycle event                              │       │
│  │  3. Call prepStop() callback                                     │       │
│  │     • Stop accepting new connections                             │       │
│  │     • Drain request queues                                       │       │
│  │     • Notify load balancers                                      │       │
│  │  4. Stop supervisor tree (all children)                          │       │
│  │     • Each GenServer.terminate() is called                       │       │
│  │     • Nested supervisors stop their children                     │       │
│  │  5. Call stop() callback                                         │       │
│  │     • Flush logs and metrics                                     │       │
│  │     • Close external connections                                 │       │
│  │  6. Remove signal handlers                                       │       │
│  │  7. Emit 'stopped' lifecycle event                               │       │
│  │  8. Status → 'stopped'                                           │       │
│  │                                                                  │       │
│  └──────────────────────────────────────────────────────────────────┘       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Stop Reasons

The lifecycle events include a `reason` that indicates why the application stopped:

```typescript
import {
  Application,
  type ApplicationLifecycleEvent,
  type ApplicationStopReason,
} from '@hamicek/noex';

Application.onLifecycleEvent((event) => {
  if (event.type === 'stopping' || event.type === 'stopped') {
    console.log(`Stop reason: ${formatReason(event.reason)}`);
  }
});

function formatReason(reason: ApplicationStopReason): string {
  switch (reason) {
    case 'normal':
      // Manual call to Application.stop(ref)
      return 'graceful shutdown requested';
    case 'signal':
      // SIGINT or SIGTERM received
      return 'signal received (SIGINT/SIGTERM)';
    default:
      // { error: Error } - shutdown due to error
      return `error: ${reason.error.message}`;
  }
}
```

## The Cleanup Sequence

The `prepStop` and `stop` callbacks give you control over the shutdown process:

```typescript
const ApiServer = Application.create<ApiConfig>({
  async start(config) {
    // Start your application
    return Supervisor.start({ /* ... */ });
  },

  // Called BEFORE supervisor tree stops
  async prepStop(supervisor) {
    console.log('[prepStop] Starting graceful shutdown...');

    // 1. Stop accepting new requests
    const httpServer = Supervisor.getChild(supervisor, 'http');
    if (httpServer) {
      await GenServer.call(httpServer, { type: 'stopAccepting' });
      console.log('[prepStop] Stopped accepting new connections');
    }

    // 2. Wait for in-flight requests to complete
    await waitForInflightRequests(5000);
    console.log('[prepStop] All in-flight requests completed');

    // 3. Notify load balancer (optional)
    await notifyLoadBalancer('draining');
    console.log('[prepStop] Notified load balancer');
  },

  // Called AFTER supervisor tree stops
  async stop(supervisor) {
    console.log('[stop] Performing final cleanup...');

    // 1. Flush any buffered data
    await flushMetrics();
    await flushLogs();

    // 2. Close external connections
    await closeExternalConnections();

    console.log('[stop] Cleanup complete');
  },
});
```

### prepStop vs stop: When to Use Each

| Callback | When Called | Use For |
|----------|-------------|---------|
| `prepStop` | Before supervisor stops | Drain queues, stop accepting requests, notify external services |
| `stop` | After supervisor stops | Final cleanup, flush logs, close persistent connections |

```
Timeline:
                    ┌── prepStop ──┐ ┌─ Supervisor stops ─┐ ┌─── stop ───┐
Signal ────────────►│ Drain work   │►│ GenServers stop    │►│ Final flush│► Exit
received            │ Stop inputs  │ │ terminate() called │ │ Close conn │
                    └──────────────┘ └────────────────────┘ └────────────┘
```

## Stop Timeout

The entire stop sequence must complete within `stopTimeout` (default: 30 seconds):

```typescript
const app = await Application.start(MyApp, {
  name: 'my-app',
  config,
  stopTimeout: 60000,  // 60 seconds for complex cleanup
});

// If stop takes longer than stopTimeout:
try {
  await Application.stop(app);
} catch (error) {
  if (error instanceof ApplicationStopTimeoutError) {
    console.error(`Stop timed out after ${error.timeoutMs}ms`);
    // At this point, the process may need to be killed forcefully
    process.exit(1);
  }
}
```

**Container orchestration note:** Kubernetes sends SIGTERM, waits `terminationGracePeriodSeconds` (default: 30s), then sends SIGKILL. Set your `stopTimeout` lower than this to ensure clean exit:

```typescript
// Kubernetes terminationGracePeriodSeconds: 60
const app = await Application.start(MyApp, {
  name: 'my-app',
  config,
  stopTimeout: 55000,  // 55 seconds — leaves 5s buffer before SIGKILL
});
```

## Disabling Automatic Signal Handling

In some cases, you may want to handle signals yourself:

```typescript
// Disable automatic signal handling
const app = await Application.start(MyApp, {
  name: 'my-app',
  config,
  handleSignals: false,  // We'll handle signals manually
});

// Custom signal handling
let shuttingDown = false;

async function handleShutdown(signal: string) {
  if (shuttingDown) {
    console.log('Already shutting down, ignoring signal');
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}, initiating shutdown...`);

  try {
    // Custom pre-shutdown logic
    await notifyCluster('node-leaving');

    // Now stop the application
    await Application.stop(app, 'signal');

    console.log('Shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('Shutdown failed:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
```

### When to Disable Automatic Handling

| Scenario | Why Disable |
|----------|-------------|
| Cluster coordination | Need to notify other nodes before stopping |
| Custom logging | Want to log the exact signal received |
| Multi-application process | Need to coordinate shutdown order |
| Testing | Need to control shutdown timing precisely |

## Graceful Shutdown Patterns

### HTTP Server Pattern

Stop accepting new connections, then drain existing ones:

```typescript
interface HttpServerState {
  server: http.Server;
  activeConnections: Set<http.ServerResponse>;
}

const HttpServer: GenServerBehavior<HttpServerState, HttpCall, HttpCast, HttpReply> = {
  init: () => {
    const server = http.createServer((req, res) => {
      state.activeConnections.add(res);
      res.on('close', () => state.activeConnections.delete(res));
      // Handle request...
    });
    return { server, activeConnections: new Set() };
  },

  handleCall: (msg, state) => {
    if (msg.type === 'stopAccepting') {
      // Stop accepting new connections
      state.server.close();
      return [{ stopped: true }, state];
    }

    if (msg.type === 'getActiveCount') {
      return [{ count: state.activeConnections.size }, state];
    }

    return [null, state];
  },

  terminate: async (reason, state) => {
    // Force-close any remaining connections
    for (const res of state.activeConnections) {
      res.end();
    }
    state.server.close();
  },
};
```

### Background Worker Pattern

Finish current job, reject new ones:

```typescript
interface WorkerState {
  currentJob: Job | null;
  accepting: boolean;
}

const BackgroundWorker: GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerReply> = {
  init: () => ({ currentJob: null, accepting: true }),

  handleCast: async (msg, state) => {
    if (msg.type === 'process' && state.accepting) {
      // Process the job
      const result = await processJob(msg.job);
      return { ...state, currentJob: null };
    }
    return state;
  },

  handleCall: (msg, state) => {
    if (msg.type === 'drain') {
      // Stop accepting new jobs
      return [{ draining: true }, { ...state, accepting: false }];
    }

    if (msg.type === 'getStatus') {
      return [{
        processing: state.currentJob !== null,
        accepting: state.accepting,
      }, state];
    }

    return [null, state];
  },

  terminate: async (reason, state) => {
    if (state.currentJob) {
      // Let current job complete (or implement timeout)
      console.log('Waiting for current job to complete...');
    }
  },
};
```

### WebSocket Pattern

Notify connected clients before disconnecting:

```typescript
interface WebSocketServerState {
  clients: Map<string, WebSocket>;
}

const WebSocketServer: GenServerBehavior<WebSocketServerState, WsCall, WsCast, WsReply> = {
  init: () => ({ clients: new Map() }),

  handleCall: (msg, state) => {
    if (msg.type === 'prepareShutdown') {
      // Notify all clients
      for (const [id, ws] of state.clients) {
        ws.send(JSON.stringify({
          type: 'server_shutdown',
          message: 'Server is shutting down, please reconnect',
          reconnectAfterMs: 5000,
        }));
      }
      return [{ notified: state.clients.size }, state];
    }

    return [null, state];
  },

  terminate: async (reason, state) => {
    // Close all connections with proper close code
    for (const [id, ws] of state.clients) {
      ws.close(1001, 'Server shutting down');  // 1001 = Going Away
    }
  },
};
```

## Complete Example: Production API Server

Here's a production-ready API server with comprehensive signal handling:

```typescript
import {
  Application,
  Supervisor,
  GenServer,
  type SupervisorRef,
  type ApplicationLifecycleEvent,
} from '@hamicek/noex';
import * as http from 'http';

interface ServerConfig {
  port: number;
  shutdownTimeoutMs: number;
}

interface ServerState {
  supervisor: SupervisorRef;
  requestCount: number;
  activeRequests: number;
}

// Track metrics
let metrics = {
  totalRequests: 0,
  shutdownRequestsCompleted: 0,
};

const ProductionServer = Application.create<ServerConfig>({
  async start(config) {
    console.log(`[Server] Starting on port ${config.port}...`);

    const supervisor = await Supervisor.start({
      strategy: 'rest_for_one',
      children: [
        {
          id: 'metrics',
          start: () => MetricsCollector.start(),
        },
        {
          id: 'http',
          start: () => HttpHandler.start(config.port),
        },
      ],
    });

    console.log(`[Server] Ready to accept connections`);
    return supervisor;
  },

  async prepStop(supervisor) {
    console.log('[Server] Preparing for shutdown...');
    const startTime = Date.now();

    // 1. Get HTTP handler and stop accepting
    const httpHandler = Supervisor.getChild(supervisor, 'http');
    if (httpHandler) {
      const result = await GenServer.call(httpHandler, { type: 'stopAccepting' });
      console.log(`[Server] Stopped accepting new connections`);

      // 2. Wait for in-flight requests (with timeout)
      const maxWait = 10000;  // 10 seconds max
      let waited = 0;
      while (waited < maxWait) {
        const status = await GenServer.call(httpHandler, { type: 'getStatus' });
        if ((status as { activeRequests: number }).activeRequests === 0) {
          break;
        }
        console.log(`[Server] Waiting for ${(status as { activeRequests: number }).activeRequests} active requests...`);
        await new Promise(r => setTimeout(r, 1000));
        waited += 1000;
      }

      metrics.shutdownRequestsCompleted =
        (await GenServer.call(httpHandler, { type: 'getStatus' }) as { completed: number }).completed;
    }

    console.log(`[Server] prepStop completed in ${Date.now() - startTime}ms`);
  },

  async stop(supervisor) {
    console.log('[Server] Final cleanup...');

    // Flush metrics before exit
    const metricsCollector = Supervisor.getChild(supervisor, 'metrics');
    if (metricsCollector) {
      await GenServer.call(metricsCollector, { type: 'flush' });
    }

    console.log('[Server] Shutdown statistics:');
    console.log(`  Total requests handled: ${metrics.totalRequests}`);
    console.log(`  Requests completed during shutdown: ${metrics.shutdownRequestsCompleted}`);
    console.log('[Server] Goodbye!');
  },
});

// Application entry point
async function main() {
  // Register lifecycle observer for logging
  const unsubscribe = Application.onLifecycleEvent((event: ApplicationLifecycleEvent) => {
    const time = new Date(event.timestamp).toISOString();

    switch (event.type) {
      case 'starting':
        console.log(`[${time}] 🚀 Starting application '${event.name}'`);
        break;
      case 'started':
        console.log(`[${time}] ✅ Application '${event.ref.name}' started`);
        break;
      case 'stopping':
        const reason = event.reason === 'signal' ? 'signal received' :
                      event.reason === 'normal' ? 'graceful stop' :
                      `error: ${event.reason.error.message}`;
        console.log(`[${time}] 🛑 Stopping application '${event.ref.name}' (${reason})`);
        break;
      case 'stopped':
        console.log(`[${time}] ⭕ Application '${event.name}' stopped`);
        break;
      case 'start_failed':
        console.error(`[${time}] ❌ Application '${event.name}' failed to start: ${event.error.message}`);
        break;
    }
  });

  const config: ServerConfig = {
    port: parseInt(process.env.PORT || '3000', 10),
    shutdownTimeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT || '30000', 10),
  };

  try {
    const app = await Application.start(ProductionServer, {
      name: 'production-api',
      config,
      handleSignals: true,
      stopTimeout: config.shutdownTimeoutMs,
    });

    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║  Production API Server                                        ║');
    console.log(`║  Port: ${config.port.toString().padEnd(55)}║`);
    console.log(`║  PID: ${process.pid.toString().padEnd(56)}║`);
    console.log('║                                                               ║');
    console.log('║  Press Ctrl+C to initiate graceful shutdown                   ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('');

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
```

**Sample output when Ctrl+C is pressed:**

```
[2024-01-25T12:00:00.000Z] 🚀 Starting application 'production-api'
[Server] Starting on port 3000...
[Server] Ready to accept connections
[2024-01-25T12:00:00.100Z] ✅ Application 'production-api' started

╔═══════════════════════════════════════════════════════════════╗
║  Production API Server                                        ║
║  Port: 3000                                                   ║
║  PID: 12345                                                   ║
║                                                               ║
║  Press Ctrl+C to initiate graceful shutdown                   ║
╚═══════════════════════════════════════════════════════════════╝

^C
[2024-01-25T12:05:30.000Z] 🛑 Stopping application 'production-api' (signal received)
[Server] Preparing for shutdown...
[Server] Stopped accepting new connections
[Server] Waiting for 3 active requests...
[Server] Waiting for 1 active requests...
[Server] prepStop completed in 2150ms
[Server] Final cleanup...
[Server] Shutdown statistics:
  Total requests handled: 1547
  Requests completed during shutdown: 3
[Server] Goodbye!
[2024-01-25T12:05:32.200Z] ⭕ Application 'production-api' stopped
```

## Exercise: Graceful Worker Pool

Build a worker pool that handles shutdown gracefully:

**Requirements:**

1. **WorkerPool GenServer** that manages N worker processes
2. **Workers** process jobs from a queue
3. **On shutdown:**
   - Stop accepting new jobs immediately
   - Let currently running jobs complete (with timeout)
   - Report how many jobs completed vs. were abandoned
4. **Lifecycle logging** for all state transitions

**Starter code:**

```typescript
import {
  Application,
  Supervisor,
  GenServer,
  type SupervisorRef,
  type GenServerBehavior,
} from '@hamicek/noex';

interface PoolConfig {
  workerCount: number;
  jobTimeoutMs: number;
  shutdownTimeoutMs: number;
}

interface Job {
  id: string;
  payload: unknown;
}

// TODO: Implement WorkerPool GenServer
// - Manages queue of pending jobs
// - Tracks which jobs are currently being processed
// - Handles 'submit' cast to add jobs
// - Handles 'drain' call to stop accepting and wait for completion
// - Handles 'getStats' call to return queue/processing counts

// TODO: Implement Worker GenServer
// - Processes single jobs
// - Reports completion back to pool

// TODO: Implement WorkerPoolApp Application
// - Starts supervisor with pool and workers
// - prepStop: calls drain on pool
// - stop: logs final statistics

async function main() {
  // TODO: Start the application
  // TODO: Submit some test jobs
  // TODO: Press Ctrl+C to test graceful shutdown
}

main();
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
import {
  Application,
  Supervisor,
  GenServer,
  Registry,
  type SupervisorRef,
  type GenServerRef,
  type GenServerBehavior,
  type ApplicationLifecycleEvent,
} from '@hamicek/noex';

interface PoolConfig {
  workerCount: number;
  jobTimeoutMs: number;
  shutdownTimeoutMs: number;
}

interface Job {
  id: string;
  payload: unknown;
  submittedAt: number;
}

// Pool state
interface PoolState {
  queue: Job[];
  processing: Map<string, { job: Job; workerId: string; startedAt: number }>;
  workers: Map<string, GenServerRef>;
  accepting: boolean;
  completedCount: number;
  abandonedCount: number;
}

type PoolCall =
  | { type: 'getStats' }
  | { type: 'drain'; timeoutMs: number }
  | { type: 'jobCompleted'; jobId: string; workerId: string }
  | { type: 'jobFailed'; jobId: string; workerId: string; error: string };

type PoolCast =
  | { type: 'submit'; job: Job }
  | { type: 'registerWorker'; workerId: string; ref: GenServerRef };

type PoolReply =
  | { queued: number; processing: number; completed: number; abandoned: number; accepting: boolean }
  | { drained: boolean; completed: number; abandoned: number };

function createPoolBehavior(
  config: PoolConfig,
): GenServerBehavior<PoolState, PoolCall, PoolCast, PoolReply> {
  const assignJobToWorker = (state: PoolState): PoolState => {
    if (state.queue.length === 0) return state;

    // Find an available worker
    for (const [workerId, ref] of state.workers) {
      const isProcessing = Array.from(state.processing.values())
        .some(p => p.workerId === workerId);

      if (!isProcessing) {
        const job = state.queue[0];
        const newQueue = state.queue.slice(1);

        // Send job to worker
        GenServer.cast(ref, { type: 'process', job });

        const newProcessing = new Map(state.processing);
        newProcessing.set(job.id, {
          job,
          workerId,
          startedAt: Date.now(),
        });

        console.log(`[Pool] Assigned job ${job.id} to worker ${workerId}`);

        return {
          ...state,
          queue: newQueue,
          processing: newProcessing,
        };
      }
    }
    return state;
  };

  return {
    init: () => ({
      queue: [],
      processing: new Map(),
      workers: new Map(),
      accepting: true,
      completedCount: 0,
      abandonedCount: 0,
    }),

    handleCall: async (msg, state) => {
      switch (msg.type) {
        case 'getStats':
          return [{
            queued: state.queue.length,
            processing: state.processing.size,
            completed: state.completedCount,
            abandoned: state.abandonedCount,
            accepting: state.accepting,
          }, state];

        case 'drain': {
          console.log('[Pool] Drain requested, stopping acceptance');
          let newState = { ...state, accepting: false };

          // Wait for processing jobs to complete (with timeout)
          const startTime = Date.now();
          while (newState.processing.size > 0 && Date.now() - startTime < msg.timeoutMs) {
            console.log(`[Pool] Waiting for ${newState.processing.size} jobs to complete...`);
            await new Promise(r => setTimeout(r, 500));
          }

          // Mark remaining as abandoned
          const abandoned = newState.processing.size;
          if (abandoned > 0) {
            console.log(`[Pool] Timeout: abandoning ${abandoned} jobs`);
            newState = {
              ...newState,
              abandonedCount: newState.abandonedCount + abandoned,
              processing: new Map(),
            };
          }

          // Also abandon queued jobs
          const queuedAbandoned = newState.queue.length;
          if (queuedAbandoned > 0) {
            console.log(`[Pool] Abandoning ${queuedAbandoned} queued jobs`);
            newState = {
              ...newState,
              abandonedCount: newState.abandonedCount + queuedAbandoned,
              queue: [],
            };
          }

          return [{
            drained: true,
            completed: newState.completedCount,
            abandoned: newState.abandonedCount,
          }, newState];
        }

        case 'jobCompleted': {
          console.log(`[Pool] Job ${msg.jobId} completed by ${msg.workerId}`);
          const newProcessing = new Map(state.processing);
          newProcessing.delete(msg.jobId);

          let newState = {
            ...state,
            processing: newProcessing,
            completedCount: state.completedCount + 1,
          };

          // Try to assign next job
          if (newState.accepting) {
            newState = assignJobToWorker(newState);
          }

          return [{
            queued: newState.queue.length,
            processing: newState.processing.size,
            completed: newState.completedCount,
            abandoned: newState.abandonedCount,
            accepting: newState.accepting,
          }, newState];
        }

        case 'jobFailed': {
          console.log(`[Pool] Job ${msg.jobId} failed on ${msg.workerId}: ${msg.error}`);
          const newProcessing = new Map(state.processing);
          newProcessing.delete(msg.jobId);

          // Count as abandoned (could also retry)
          return [{
            queued: state.queue.length,
            processing: newProcessing.size,
            completed: state.completedCount,
            abandoned: state.abandonedCount + 1,
            accepting: state.accepting,
          }, {
            ...state,
            processing: newProcessing,
            abandonedCount: state.abandonedCount + 1,
          }];
        }
      }
    },

    handleCast: (msg, state) => {
      switch (msg.type) {
        case 'submit': {
          if (!state.accepting) {
            console.log(`[Pool] Rejected job ${msg.job.id} (not accepting)`);
            return state;
          }

          console.log(`[Pool] Received job ${msg.job.id}`);
          const newState = {
            ...state,
            queue: [...state.queue, msg.job],
          };

          // Try to assign immediately
          return assignJobToWorker(newState);
        }

        case 'registerWorker': {
          console.log(`[Pool] Worker ${msg.workerId} registered`);
          const newWorkers = new Map(state.workers);
          newWorkers.set(msg.workerId, msg.ref);

          // Try to assign a job to the new worker
          return assignJobToWorker({ ...state, workers: newWorkers });
        }
      }
      return state;
    },
  };
}

// Worker behavior
interface WorkerState {
  id: string;
  pool: GenServerRef;
  currentJob: Job | null;
}

type WorkerCall = { type: 'getStatus' };
type WorkerCast = { type: 'process'; job: Job };
type WorkerReply = { busy: boolean; currentJobId: string | null };

function createWorkerBehavior(
  id: string,
  pool: GenServerRef,
  jobTimeoutMs: number,
): GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerReply> {
  return {
    init: () => {
      // Register with pool
      GenServer.cast(pool, { type: 'registerWorker', workerId: id, ref: GenServer.self!() });
      return { id, pool, currentJob: null };
    },

    handleCall: (msg, state) => {
      if (msg.type === 'getStatus') {
        return [{
          busy: state.currentJob !== null,
          currentJobId: state.currentJob?.id ?? null,
        }, state];
      }
      return [{ busy: false, currentJobId: null }, state];
    },

    handleCast: async (msg, state) => {
      if (msg.type === 'process') {
        const { job } = msg;
        console.log(`[Worker ${state.id}] Processing job ${job.id}`);

        try {
          // Simulate work (random duration)
          const duration = 500 + Math.random() * 2000;
          await new Promise(r => setTimeout(r, duration));

          // Report completion
          await GenServer.call(state.pool, {
            type: 'jobCompleted',
            jobId: job.id,
            workerId: state.id,
          });

          console.log(`[Worker ${state.id}] Completed job ${job.id}`);
        } catch (error) {
          await GenServer.call(state.pool, {
            type: 'jobFailed',
            jobId: job.id,
            workerId: state.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        return { ...state, currentJob: null };
      }
      return state;
    },

    terminate: (reason, state) => {
      if (state.currentJob) {
        console.log(`[Worker ${state.id}] Terminated with job ${state.currentJob.id} in progress`);
      }
    },
  };
}

// Application behavior
const WorkerPoolApp = Application.create<PoolConfig>({
  async start(config) {
    console.log(`[App] Starting worker pool with ${config.workerCount} workers`);

    // Create pool first
    const pool = await GenServer.start(
      createPoolBehavior(config),
      { name: 'job-pool' },
    );

    // Create workers
    const workerRefs: GenServerRef[] = [];
    for (let i = 0; i < config.workerCount; i++) {
      const workerId = `worker-${i + 1}`;
      const worker = await GenServer.start(
        createWorkerBehavior(workerId, pool, config.jobTimeoutMs),
        { name: workerId },
      );
      workerRefs.push(worker);
    }

    // Create supervisor to manage pool and workers
    const supervisor = await Supervisor.start({
      strategy: 'one_for_all',
      children: [
        { id: 'pool', start: () => Promise.resolve(pool) },
        ...workerRefs.map((ref, i) => ({
          id: `worker-${i + 1}`,
          start: () => Promise.resolve(ref),
        })),
      ],
    });

    console.log(`[App] Worker pool started`);
    return supervisor;
  },

  async prepStop(supervisor) {
    console.log('[App] Initiating graceful shutdown...');

    const pool = Supervisor.getChild(supervisor, 'pool');
    if (pool) {
      const result = await GenServer.call(pool, {
        type: 'drain',
        timeoutMs: 10000,
      }) as { drained: boolean; completed: number; abandoned: number };

      console.log('[App] Pool drained:');
      console.log(`  Completed: ${result.completed}`);
      console.log(`  Abandoned: ${result.abandoned}`);
    }
  },

  async stop(supervisor) {
    console.log('[App] Final statistics:');

    const pool = Supervisor.getChild(supervisor, 'pool');
    if (pool) {
      const stats = await GenServer.call(pool, { type: 'getStats' }) as {
        completed: number;
        abandoned: number;
      };

      console.log(`  Total completed: ${stats.completed}`);
      console.log(`  Total abandoned: ${stats.abandoned}`);
    }

    console.log('[App] Shutdown complete');
  },
});

// Main entry point
async function main() {
  // Lifecycle logging
  Application.onLifecycleEvent((event: ApplicationLifecycleEvent) => {
    const time = new Date(event.timestamp).toISOString();

    switch (event.type) {
      case 'starting':
        console.log(`[${time}] LIFECYCLE: Starting '${event.name}'`);
        break;
      case 'started':
        console.log(`[${time}] LIFECYCLE: Started '${event.ref.name}'`);
        break;
      case 'stopping':
        const reason = event.reason === 'signal' ? 'signal' :
                      event.reason === 'normal' ? 'normal' :
                      `error: ${event.reason.error.message}`;
        console.log(`[${time}] LIFECYCLE: Stopping '${event.ref.name}' (${reason})`);
        break;
      case 'stopped':
        console.log(`[${time}] LIFECYCLE: Stopped '${event.name}'`);
        break;
      case 'start_failed':
        console.error(`[${time}] LIFECYCLE: Failed '${event.name}': ${event.error.message}`);
        break;
    }
  });

  const config: PoolConfig = {
    workerCount: 3,
    jobTimeoutMs: 5000,
    shutdownTimeoutMs: 15000,
  };

  try {
    const app = await Application.start(WorkerPoolApp, {
      name: 'worker-pool',
      config,
      handleSignals: true,
      stopTimeout: config.shutdownTimeoutMs,
    });

    // Submit test jobs
    const pool = Application.getSupervisor(app);
    if (pool) {
      const poolRef = Supervisor.getChild(pool, 'pool');
      if (poolRef) {
        console.log('\n[Test] Submitting 10 test jobs...\n');

        for (let i = 1; i <= 10; i++) {
          GenServer.cast(poolRef, {
            type: 'submit',
            job: { id: `job-${i}`, payload: { task: i }, submittedAt: Date.now() },
          });
          await new Promise(r => setTimeout(r, 200));  // Stagger submissions
        }

        console.log('\n[Test] All jobs submitted. Press Ctrl+C to test graceful shutdown.\n');
      }
    }

    // Keep running
    await new Promise(() => {});

  } catch (error) {
    console.error('Failed to start worker pool:', error);
    process.exit(1);
  }
}

main();
```

**Sample output:**

```
[2024-01-25T12:00:00.000Z] LIFECYCLE: Starting 'worker-pool'
[App] Starting worker pool with 3 workers
[Pool] Worker worker-1 registered
[Pool] Worker worker-2 registered
[Pool] Worker worker-3 registered
[App] Worker pool started
[2024-01-25T12:00:00.100Z] LIFECYCLE: Started 'worker-pool'

[Test] Submitting 10 test jobs...

[Pool] Received job job-1
[Pool] Assigned job job-1 to worker worker-1
[Worker worker-1] Processing job job-1
[Pool] Received job job-2
[Pool] Assigned job job-2 to worker worker-2
[Worker worker-2] Processing job job-2
[Pool] Received job job-3
[Pool] Assigned job job-3 to worker worker-3
[Worker worker-3] Processing job job-3
[Pool] Received job job-4
[Pool] Received job job-5
...

[Test] All jobs submitted. Press Ctrl+C to test graceful shutdown.

[Worker worker-1] Completed job job-1
[Pool] Job job-1 completed by worker-1
[Pool] Assigned job job-4 to worker worker-1
...

^C
[2024-01-25T12:00:05.000Z] LIFECYCLE: Stopping 'worker-pool' (signal)
[App] Initiating graceful shutdown...
[Pool] Drain requested, stopping acceptance
[Pool] Waiting for 3 jobs to complete...
[Worker worker-2] Completed job job-7
[Pool] Job job-7 completed by worker-2
[Pool] Waiting for 2 jobs to complete...
[Worker worker-1] Completed job job-8
[Pool] Job job-8 completed by worker-1
[Pool] Waiting for 1 jobs to complete...
[Worker worker-3] Completed job job-9
[Pool] Job job-9 completed by worker-3
[Pool] Abandoning 1 queued jobs
[App] Pool drained:
  Completed: 9
  Abandoned: 1
[App] Final statistics:
  Total completed: 9
  Total abandoned: 1
[App] Shutdown complete
[2024-01-25T12:00:07.500Z] LIFECYCLE: Stopped 'worker-pool'
```

**Key design decisions:**

1. **Immediate rejection** — New jobs rejected as soon as drain starts
2. **In-flight completion** — Workers finish their current job
3. **Timeout handling** — Jobs still processing after timeout are marked abandoned
4. **Queue cleanup** — Queued jobs also marked as abandoned
5. **Statistics** — Complete accounting of completed vs. abandoned jobs

</details>

## Summary

**Key takeaways:**

- **SIGINT/SIGTERM** are graceful shutdown signals — handle them properly
- **SIGKILL** cannot be caught — ensure cleanup happens before it arrives
- **handleSignals: true** (default) automatically manages signal handlers
- **prepStop** runs before supervisor stops — use for draining and notifications
- **stop** runs after supervisor stops — use for final cleanup
- **stopTimeout** must be less than container termination grace period

**Signal handling patterns:**

| Application Type | prepStop Action | stop Action |
|-----------------|-----------------|-------------|
| HTTP Server | Stop accepting, drain connections | Flush logs |
| Worker Pool | Stop accepting jobs, wait for completion | Report statistics |
| WebSocket Server | Notify clients, close gracefully | Clean up state |
| Database Service | Stop writes, flush buffers | Close connections |

**Container orchestration checklist:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ☐ Set stopTimeout < terminationGracePeriodSeconds                         │
│  ☐ Implement prepStop to drain connections/requests                        │
│  ☐ Handle in-flight work before supervisor stops                           │
│  ☐ Log shutdown progress for debugging                                     │
│  ☐ Test with `docker stop` and `kubectl delete pod`                        │
│  ☐ Monitor for SIGKILL (indicates timeout issues)                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Remember:**

> Graceful shutdown is not optional in production. Users don't see your internal state — they see dropped connections and lost data. Handle signals properly, drain work before stopping, and always leave time for cleanup before SIGKILL arrives.

---

Next: [Production Setup](./03-production-setup.md)
