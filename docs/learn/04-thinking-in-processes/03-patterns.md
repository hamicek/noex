# Process Patterns

Now that you understand how to map problems to processes and how processes communicate, let's explore common architectural patterns. These patterns are battle-tested solutions that leverage the actor model's strengths — isolation, message passing, and supervision.

## What You'll Learn

- Request-Response Pipeline — sequential processing through stages
- Worker Pool — parallel task processing with backpressure
- Circuit Breaker — protecting systems from cascading failures
- Rate Limiting — controlling request throughput
- When to apply each pattern and implementation strategies

## Request-Response Pipeline

A pipeline processes data through sequential stages, where each stage transforms or enriches the data before passing it to the next. This pattern shines when you need:

- Clear separation of concerns
- Independent scaling of stages
- Easy debugging (inspect data between stages)
- Flexible composition (add/remove/reorder stages)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      REQUEST-RESPONSE PIPELINE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐  │
│  │  Input  │───▶│  Parse  │───▶│Validate │───▶│ Enrich  │───▶│  Store  │  │
│  └─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘  │
│                                                                             │
│  Each stage:                                                                │
│  • Is a GenServer with isolated state                                       │
│  • Receives data via call() from previous stage                             │
│  • Transforms data and returns result                                       │
│  • Can fail independently without affecting other stages                    │
│                                                                             │
│  Benefits:                                                                  │
│  ✓ Single responsibility per stage                                         │
│  ✓ Easy to test each stage in isolation                                    │
│  ✓ Supervision can restart failed stages                                   │
│  ✓ Clear data flow for debugging                                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Implementation: API Request Pipeline

```typescript
import { GenServer, Supervisor, Registry, type GenServerBehavior } from '@hamicek/noex';

// Types for the pipeline
interface RawRequest {
  body: string;
  headers: Record<string, string>;
}

interface ParsedRequest {
  data: Record<string, unknown>;
  contentType: string;
}

interface ValidatedRequest {
  data: Record<string, unknown>;
  userId: string;
}

interface EnrichedRequest {
  data: Record<string, unknown>;
  userId: string;
  user: { id: string; name: string; email: string };
  timestamp: Date;
}

interface StoredResult {
  id: string;
  success: boolean;
}

// ============================================================================
// Stage 1: Parser — Transforms raw input into structured data
// ============================================================================

interface ParserState {
  parseCount: number;
}

type ParserCall = { type: 'parse'; request: RawRequest };

const parserBehavior: GenServerBehavior<ParserState, ParserCall, never, ParsedRequest> = {
  init: () => ({ parseCount: 0 }),

  handleCall(msg, state) {
    if (msg.type === 'parse') {
      const { body, headers } = msg.request;
      const contentType = headers['content-type'] ?? 'application/json';

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error('Invalid JSON body');
      }

      const result: ParsedRequest = { data, contentType };
      return [result, { parseCount: state.parseCount + 1 }];
    }
    throw new Error('Unknown message type');
  },

  handleCast: (_, state) => state,
};

// ============================================================================
// Stage 2: Validator — Ensures data meets requirements
// ============================================================================

interface ValidatorState {
  validCount: number;
  invalidCount: number;
}

type ValidatorCall = { type: 'validate'; request: ParsedRequest };

const validatorBehavior: GenServerBehavior<ValidatorState, ValidatorCall, never, ValidatedRequest> = {
  init: () => ({ validCount: 0, invalidCount: 0 }),

  handleCall(msg, state) {
    if (msg.type === 'validate') {
      const { data } = msg.request;

      // Validate required fields
      if (typeof data.userId !== 'string' || data.userId.length === 0) {
        return [
          { data: {}, userId: '' }, // Will be caught as error
          { ...state, invalidCount: state.invalidCount + 1 },
        ];
      }

      if (!data.action || typeof data.action !== 'string') {
        throw new Error('Missing or invalid action field');
      }

      const result: ValidatedRequest = {
        data,
        userId: data.userId as string,
      };

      return [result, { ...state, validCount: state.validCount + 1 }];
    }
    throw new Error('Unknown message type');
  },

  handleCast: (_, state) => state,
};

// ============================================================================
// Stage 3: Enricher — Adds context from external sources
// ============================================================================

interface EnricherState {
  userCache: Map<string, { id: string; name: string; email: string }>;
}

type EnricherCall = { type: 'enrich'; request: ValidatedRequest };

const enricherBehavior: GenServerBehavior<EnricherState, EnricherCall, never, EnrichedRequest> = {
  init: () => ({ userCache: new Map() }),

  async handleCall(msg, state) {
    if (msg.type === 'enrich') {
      const { data, userId } = msg.request;

      // Simulate user lookup (would be a DB call in real code)
      let user = state.userCache.get(userId);
      if (!user) {
        // Simulate async user fetch
        await new Promise(resolve => setTimeout(resolve, 10));
        user = {
          id: userId,
          name: `User ${userId}`,
          email: `user${userId}@example.com`,
        };
        state.userCache.set(userId, user);
      }

      const result: EnrichedRequest = {
        data,
        userId,
        user,
        timestamp: new Date(),
      };

      return [result, state];
    }
    throw new Error('Unknown message type');
  },

  handleCast: (_, state) => state,
};

// ============================================================================
// Stage 4: Store — Persists the processed data
// ============================================================================

interface StoreState {
  records: Map<string, EnrichedRequest>;
  nextId: number;
}

type StoreCall = { type: 'store'; request: EnrichedRequest };

const storeBehavior: GenServerBehavior<StoreState, StoreCall, never, StoredResult> = {
  init: () => ({ records: new Map(), nextId: 1 }),

  handleCall(msg, state) {
    if (msg.type === 'store') {
      const id = `record-${state.nextId}`;
      state.records.set(id, msg.request);

      const result: StoredResult = { id, success: true };
      return [result, { ...state, nextId: state.nextId + 1 }];
    }
    throw new Error('Unknown message type');
  },

  handleCast: (_, state) => state,
};

// ============================================================================
// Pipeline Orchestrator — Coordinates the stages
// ============================================================================

interface PipelineState {
  processedCount: number;
  errorCount: number;
}

type PipelineCall = { type: 'process'; request: RawRequest };

const pipelineBehavior: GenServerBehavior<PipelineState, PipelineCall, never, StoredResult> = {
  init: () => ({ processedCount: 0, errorCount: 0 }),

  async handleCall(msg, state) {
    if (msg.type === 'process') {
      try {
        // Stage 1: Parse
        const parser = Registry.whereis('pipeline-parser');
        if (!parser) throw new Error('Parser not available');
        const parsed = await GenServer.call(parser, { type: 'parse', request: msg.request });

        // Stage 2: Validate
        const validator = Registry.whereis('pipeline-validator');
        if (!validator) throw new Error('Validator not available');
        const validated = await GenServer.call(validator, { type: 'validate', request: parsed as ParsedRequest });

        // Stage 3: Enrich
        const enricher = Registry.whereis('pipeline-enricher');
        if (!enricher) throw new Error('Enricher not available');
        const enriched = await GenServer.call(enricher, { type: 'enrich', request: validated as ValidatedRequest });

        // Stage 4: Store
        const store = Registry.whereis('pipeline-store');
        if (!store) throw new Error('Store not available');
        const result = await GenServer.call(store, { type: 'store', request: enriched as EnrichedRequest });

        return [result as StoredResult, { ...state, processedCount: state.processedCount + 1 }];
      } catch (error) {
        return [
          { id: '', success: false },
          { ...state, errorCount: state.errorCount + 1 },
        ];
      }
    }
    throw new Error('Unknown message type');
  },

  handleCast: (_, state) => state,
};

// ============================================================================
// Start the Pipeline
// ============================================================================

async function startPipeline() {
  // Start all stages under supervision
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'parser', start: () => GenServer.start(parserBehavior, { name: 'pipeline-parser' }) },
      { id: 'validator', start: () => GenServer.start(validatorBehavior, { name: 'pipeline-validator' }) },
      { id: 'enricher', start: () => GenServer.start(enricherBehavior, { name: 'pipeline-enricher' }) },
      { id: 'store', start: () => GenServer.start(storeBehavior, { name: 'pipeline-store' }) },
      { id: 'orchestrator', start: () => GenServer.start(pipelineBehavior, { name: 'pipeline' }) },
    ],
  });

  return supervisor;
}

// Usage
async function demo() {
  await startPipeline();

  const pipeline = Registry.lookup('pipeline');

  const result = await GenServer.call(pipeline, {
    type: 'process',
    request: {
      body: JSON.stringify({ userId: 'u123', action: 'create', payload: { title: 'Hello' } }),
      headers: { 'content-type': 'application/json' },
    },
  });

  console.log(result); // { id: 'record-1', success: true }
}
```

### When to Use Pipeline

| Use Case | Why Pipeline Works |
|----------|-------------------|
| ETL processing | Clear transformation stages |
| API request handling | Validation → Auth → Business Logic → Response |
| Document processing | Parse → Validate → Transform → Store |
| Data ingestion | Receive → Normalize → Validate → Index |

## Worker Pool

A worker pool processes tasks in parallel using a fixed number of workers. This pattern provides:

- Bounded concurrency (prevent resource exhaustion)
- Backpressure (queue fills up when workers are busy)
- Load balancing across workers
- Resilience (worker crashes don't lose the queue)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           WORKER POOL PATTERN                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                         ┌─────────────────────┐                             │
│                         │     Dispatcher      │                             │
│                         │   ┌───────────────┐ │                             │
│    Task ───────────────▶│   │  Task Queue   │ │                             │
│    Task ───────────────▶│   │ [T1][T2][T3]  │ │                             │
│    Task ───────────────▶│   └───────────────┘ │                             │
│                         └─────────┬───────────┘                             │
│                       ┌───────────┼───────────┐                             │
│                       ▼           ▼           ▼                             │
│                  ┌────────┐  ┌────────┐  ┌────────┐                         │
│                  │Worker 1│  │Worker 2│  │Worker 3│                         │
│                  │ (busy) │  │ (idle) │  │ (busy) │                         │
│                  └────────┘  └────────┘  └────────┘                         │
│                                                                             │
│  Flow:                                                                      │
│  1. Tasks arrive at dispatcher and enter queue                              │
│  2. Dispatcher assigns tasks to available workers                           │
│  3. Workers process tasks and report completion                             │
│  4. On completion, worker requests next task from queue                     │
│                                                                             │
│  Backpressure:                                                              │
│  • Queue has max size                                                       │
│  • When full, new tasks are rejected or caller blocks                       │
│  • Prevents memory exhaustion under load                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Implementation: Job Processing Pool

```typescript
import {
  GenServer,
  Supervisor,
  Registry,
  EventBus,
  type GenServerBehavior,
  type GenServerRef,
  type EventBusRef,
} from '@hamicek/noex';

// Types
interface Job {
  id: string;
  type: string;
  payload: unknown;
  priority: number;
  createdAt: Date;
}

interface JobResult {
  jobId: string;
  success: boolean;
  result?: unknown;
  error?: string;
  processedBy: string;
  duration: number;
}

// ============================================================================
// Dispatcher — Manages job queue and worker assignment
// ============================================================================

interface DispatcherState {
  queue: Job[];
  maxQueueSize: number;
  workerCount: number;
  availableWorkers: Set<string>;
  inProgress: Map<string, { job: Job; workerId: string; startedAt: number }>;
  completed: number;
  failed: number;
}

type DispatcherCall =
  | { type: 'submit'; job: Omit<Job, 'id' | 'createdAt'> }
  | { type: 'getStats' }
  | { type: 'getQueueSize' };

type DispatcherCast =
  | { type: 'workerReady'; workerId: string }
  | { type: 'jobComplete'; jobId: string; result: JobResult }
  | { type: 'processQueue' };

const createDispatcherBehavior = (
  workerCount: number,
  maxQueueSize: number,
): GenServerBehavior<DispatcherState, DispatcherCall, DispatcherCast, string | number | DispatcherState> => ({
  init() {
    const availableWorkers = new Set<string>();
    for (let i = 0; i < workerCount; i++) {
      availableWorkers.add(`worker-${i}`);
    }
    return {
      queue: [],
      maxQueueSize,
      workerCount,
      availableWorkers,
      inProgress: new Map(),
      completed: 0,
      failed: 0,
    };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'submit': {
        // Check queue capacity (backpressure)
        if (state.queue.length >= state.maxQueueSize) {
          throw new Error('Queue full - try again later');
        }

        const job: Job = {
          ...msg.job,
          id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          createdAt: new Date(),
        };

        // Insert by priority (higher priority first)
        const insertIdx = state.queue.findIndex(j => j.priority < job.priority);
        if (insertIdx === -1) {
          state.queue.push(job);
        } else {
          state.queue.splice(insertIdx, 0, job);
        }

        // Trigger queue processing
        const self = Registry.whereis('job-dispatcher');
        if (self) {
          GenServer.cast(self, { type: 'processQueue' });
        }

        return [job.id, state];
      }

      case 'getStats':
        return [
          {
            queueSize: state.queue.length,
            inProgress: state.inProgress.size,
            availableWorkers: state.availableWorkers.size,
            completed: state.completed,
            failed: state.failed,
          } as unknown as DispatcherState,
          state,
        ];

      case 'getQueueSize':
        return [state.queue.length, state];
    }
  },

  handleCast(msg, state) {
    switch (msg.type) {
      case 'workerReady': {
        state.availableWorkers.add(msg.workerId);
        // Trigger queue processing
        const self = Registry.whereis('job-dispatcher');
        if (self) {
          GenServer.cast(self, { type: 'processQueue' });
        }
        return state;
      }

      case 'jobComplete': {
        const inProgressEntry = state.inProgress.get(msg.jobId);
        if (inProgressEntry) {
          state.inProgress.delete(msg.jobId);
          state.availableWorkers.add(inProgressEntry.workerId);

          if (msg.result.success) {
            state.completed++;
          } else {
            state.failed++;
          }

          // Publish completion event
          const bus = Registry.whereis<EventBusRef>('event-bus');
          if (bus) {
            EventBus.publish(bus, 'job.completed', msg.result);
          }
        }

        // Process next job
        const self = Registry.whereis('job-dispatcher');
        if (self) {
          GenServer.cast(self, { type: 'processQueue' });
        }
        return state;
      }

      case 'processQueue': {
        // Assign jobs to available workers
        while (state.queue.length > 0 && state.availableWorkers.size > 0) {
          const job = state.queue.shift()!;
          const workerId = state.availableWorkers.values().next().value as string;
          state.availableWorkers.delete(workerId);

          // Track in-progress job
          state.inProgress.set(job.id, {
            job,
            workerId,
            startedAt: Date.now(),
          });

          // Send job to worker
          const worker = Registry.whereis(workerId);
          if (worker) {
            GenServer.cast(worker, { type: 'process', job });
          }
        }
        return state;
      }
    }
  },
});

// ============================================================================
// Worker — Processes individual jobs
// ============================================================================

interface WorkerState {
  id: string;
  processedCount: number;
  currentJob: Job | null;
}

type WorkerCall = { type: 'getStats' };
type WorkerCast = { type: 'process'; job: Job };

function createWorkerBehavior(workerId: string): GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerState> {
  return {
    init() {
      // Register as available when starting
      setTimeout(() => {
        const dispatcher = Registry.whereis('job-dispatcher');
        if (dispatcher) {
          GenServer.cast(dispatcher, { type: 'workerReady', workerId });
        }
      }, 0);

      return {
        id: workerId,
        processedCount: 0,
        currentJob: null,
      };
    },

    handleCall(msg, state) {
      if (msg.type === 'getStats') {
        return [state, state];
      }
      return [state, state];
    },

    async handleCast(msg, state) {
      if (msg.type === 'process') {
        const { job } = msg;
        const startTime = Date.now();

        try {
          // Simulate job processing based on type
          const result = await processJob(job);

          // Report completion
          const dispatcher = Registry.whereis('job-dispatcher');
          if (dispatcher) {
            GenServer.cast(dispatcher, {
              type: 'jobComplete',
              jobId: job.id,
              result: {
                jobId: job.id,
                success: true,
                result,
                processedBy: workerId,
                duration: Date.now() - startTime,
              },
            });
          }

          return { ...state, processedCount: state.processedCount + 1, currentJob: null };
        } catch (error) {
          // Report failure
          const dispatcher = Registry.whereis('job-dispatcher');
          if (dispatcher) {
            GenServer.cast(dispatcher, {
              type: 'jobComplete',
              jobId: job.id,
              result: {
                jobId: job.id,
                success: false,
                error: error instanceof Error ? error.message : String(error),
                processedBy: workerId,
                duration: Date.now() - startTime,
              },
            });
          }

          return { ...state, currentJob: null };
        }
      }
      return state;
    },
  };
}

// Simulated job processor
async function processJob(job: Job): Promise<unknown> {
  // Simulate varying processing times
  const baseTime = 50;
  const variance = Math.random() * 100;
  await new Promise(resolve => setTimeout(resolve, baseTime + variance));

  // Simulate occasional failures (10% chance)
  if (Math.random() < 0.1) {
    throw new Error('Random job failure');
  }

  return { processed: true, type: job.type, payload: job.payload };
}

// ============================================================================
// Start the Worker Pool
// ============================================================================

async function startWorkerPool(workerCount: number = 3, maxQueueSize: number = 100) {
  // Start EventBus for completion notifications
  await EventBus.start({ name: 'event-bus' });

  // Create worker child specs
  const workerSpecs = Array.from({ length: workerCount }, (_, i) => ({
    id: `worker-${i}`,
    start: () => GenServer.start(createWorkerBehavior(`worker-${i}`), { name: `worker-${i}` }),
  }));

  // Start supervisor with dispatcher and workers
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      {
        id: 'dispatcher',
        start: () => GenServer.start(
          createDispatcherBehavior(workerCount, maxQueueSize),
          { name: 'job-dispatcher' },
        ),
      },
      ...workerSpecs,
    ],
  });

  return supervisor;
}

// Usage
async function workerPoolDemo() {
  await startWorkerPool(3, 50);

  const dispatcher = Registry.lookup('job-dispatcher');

  // Subscribe to completion events
  const bus = Registry.whereis<EventBusRef>('event-bus')!;
  EventBus.subscribe(bus, 'job.completed', (result: JobResult) => {
    console.log(`Job ${result.jobId} completed by ${result.processedBy} in ${result.duration}ms`);
  });

  // Submit jobs
  const jobIds = await Promise.all([
    GenServer.call(dispatcher, { type: 'submit', job: { type: 'email', payload: { to: 'a@b.com' }, priority: 1 } }),
    GenServer.call(dispatcher, { type: 'submit', job: { type: 'image', payload: { url: 'img.jpg' }, priority: 2 } }),
    GenServer.call(dispatcher, { type: 'submit', job: { type: 'report', payload: { id: 123 }, priority: 3 } }),
  ]);

  console.log('Submitted jobs:', jobIds);
}
```

### Worker Pool Sizing Guidelines

| Factor | Recommendation |
|--------|---------------|
| CPU-bound tasks | Workers = CPU cores |
| I/O-bound tasks | Workers = CPU cores × 2-4 |
| Mixed workload | Start with CPU cores × 2, adjust based on metrics |
| Memory-heavy tasks | Fewer workers, larger queue |

## Circuit Breaker

A circuit breaker prevents cascading failures by "opening" when a downstream service fails repeatedly. This protects your system from:

- Resource exhaustion (threads/connections waiting for timeouts)
- Cascade failures (one failure bringing down the entire system)
- Thundering herd on recovery (all requests hitting recovering service at once)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CIRCUIT BREAKER STATES                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                    ┌─────────────────────────────────────┐                  │
│                    │           CLOSED                    │                  │
│                    │    (Normal operation)               │                  │
│                    │                                     │                  │
│                    │  • Requests pass through            │                  │
│                    │  • Failures are counted             │                  │
│                    │  • Success resets failure count     │                  │
│                    └──────────────┬──────────────────────┘                  │
│                                   │                                         │
│                    failures > threshold                                     │
│                                   │                                         │
│                                   ▼                                         │
│                    ┌─────────────────────────────────────┐                  │
│                    │            OPEN                     │                  │
│                    │    (Fail fast mode)                 │                  │
│                    │                                     │                  │
│                    │  • Requests fail immediately        │                  │
│                    │  • No calls to downstream           │                  │
│                    │  • Timer starts for recovery        │                  │
│                    └──────────────┬──────────────────────┘                  │
│                                   │                                         │
│                         timeout expires                                     │
│                                   │                                         │
│                                   ▼                                         │
│                    ┌─────────────────────────────────────┐                  │
│                    │         HALF-OPEN                   │                  │
│                    │    (Testing recovery)               │                  │
│                    │                                     │                  │
│                    │  • Limited requests pass through    │                  │
│                    │  • Success → CLOSED                 │                  │
│                    │  • Failure → OPEN (reset timer)     │                  │
│                    └─────────────────────────────────────┘                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Implementation: Circuit Breaker Service

```typescript
import { GenServer, Registry, type GenServerBehavior } from '@hamicek/noex';

// Circuit breaker states
type CircuitState = 'closed' | 'open' | 'half_open';

interface CircuitBreakerConfig {
  failureThreshold: number;    // Failures before opening
  successThreshold: number;    // Successes in half-open to close
  timeout: number;             // Ms to wait before half-open
  name: string;                // Service identifier
}

interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
  config: CircuitBreakerConfig;
}

type CircuitBreakerCall =
  | { type: 'execute'; fn: () => Promise<unknown> }
  | { type: 'getState' }
  | { type: 'reset' };

type CircuitBreakerReply =
  | { success: true; result: unknown }
  | { success: false; error: string; circuitOpen: boolean }
  | CircuitState
  | boolean;

const createCircuitBreakerBehavior = (
  config: CircuitBreakerConfig,
): GenServerBehavior<CircuitBreakerState, CircuitBreakerCall, never, CircuitBreakerReply> => ({
  init: () => ({
    state: 'closed',
    failureCount: 0,
    successCount: 0,
    lastFailureTime: 0,
    config,
  }),

  async handleCall(msg, state) {
    switch (msg.type) {
      case 'execute': {
        // Check if circuit should transition from open to half-open
        if (state.state === 'open') {
          const timeSinceFailure = Date.now() - state.lastFailureTime;
          if (timeSinceFailure >= state.config.timeout) {
            state.state = 'half_open';
            state.successCount = 0;
            console.log(`[CircuitBreaker:${state.config.name}] Transitioning to half-open`);
          }
        }

        // If still open, fail fast
        if (state.state === 'open') {
          return [
            { success: false, error: 'Circuit breaker is open', circuitOpen: true },
            state,
          ];
        }

        // Execute the function
        try {
          const result = await msg.fn();

          // Handle success
          if (state.state === 'half_open') {
            state.successCount++;
            if (state.successCount >= state.config.successThreshold) {
              state.state = 'closed';
              state.failureCount = 0;
              state.successCount = 0;
              console.log(`[CircuitBreaker:${state.config.name}] Circuit closed`);
            }
          } else {
            // Reset failure count on success in closed state
            state.failureCount = 0;
          }

          return [{ success: true, result }, state];

        } catch (error) {
          // Handle failure
          state.failureCount++;
          state.lastFailureTime = Date.now();

          if (state.state === 'half_open') {
            // Any failure in half-open reopens the circuit
            state.state = 'open';
            state.successCount = 0;
            console.log(`[CircuitBreaker:${state.config.name}] Circuit reopened after half-open failure`);
          } else if (state.failureCount >= state.config.failureThreshold) {
            state.state = 'open';
            console.log(`[CircuitBreaker:${state.config.name}] Circuit opened after ${state.failureCount} failures`);
          }

          return [
            {
              success: false,
              error: error instanceof Error ? error.message : String(error),
              circuitOpen: state.state === 'open',
            },
            state,
          ];
        }
      }

      case 'getState':
        return [state.state, state];

      case 'reset':
        return [
          true,
          { ...state, state: 'closed', failureCount: 0, successCount: 0 },
        ];
    }
  },

  handleCast: (_, state) => state,
});

// ============================================================================
// Circuit Breaker Wrapper — Easy-to-use API
// ============================================================================

export const CircuitBreaker = {
  async start(config: CircuitBreakerConfig) {
    const behavior = createCircuitBreakerBehavior(config);
    return GenServer.start(behavior, { name: `circuit-breaker:${config.name}` });
  },

  async execute<T>(
    ref: ReturnType<typeof GenServer.start>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const result = await GenServer.call(await ref, { type: 'execute', fn }) as CircuitBreakerReply;

    if ('success' in result) {
      if (result.success) {
        return result.result as T;
      }
      const error = new Error(result.error);
      (error as Error & { circuitOpen: boolean }).circuitOpen = result.circuitOpen;
      throw error;
    }
    throw new Error('Unexpected response');
  },

  async getState(ref: ReturnType<typeof GenServer.start>): Promise<CircuitState> {
    return GenServer.call(await ref, { type: 'getState' }) as Promise<CircuitState>;
  },

  async reset(ref: ReturnType<typeof GenServer.start>): Promise<void> {
    await GenServer.call(await ref, { type: 'reset' });
  },
};

// ============================================================================
// Usage Example
// ============================================================================

async function circuitBreakerDemo() {
  // Create circuit breaker for external API
  const apiBreaker = await CircuitBreaker.start({
    name: 'external-api',
    failureThreshold: 3,      // Open after 3 failures
    successThreshold: 2,      // Close after 2 successes in half-open
    timeout: 5000,            // Try again after 5 seconds
  });

  // Simulated external API call
  async function callExternalAPI(): Promise<{ data: string }> {
    // Simulate 50% failure rate
    if (Math.random() < 0.5) {
      throw new Error('API unavailable');
    }
    return { data: 'success' };
  }

  // Make requests through circuit breaker
  for (let i = 0; i < 10; i++) {
    try {
      const result = await CircuitBreaker.execute(Promise.resolve(apiBreaker), callExternalAPI);
      console.log(`Request ${i + 1}: Success`, result);
    } catch (error) {
      const err = error as Error & { circuitOpen?: boolean };
      if (err.circuitOpen) {
        console.log(`Request ${i + 1}: Circuit open - failing fast`);
      } else {
        console.log(`Request ${i + 1}: Failed -`, err.message);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
```

### Circuit Breaker Configuration Guidelines

| Parameter | Low Tolerance | Medium | High Tolerance |
|-----------|--------------|--------|----------------|
| `failureThreshold` | 2-3 | 5-10 | 15-20 |
| `successThreshold` | 1-2 | 3-5 | 5-10 |
| `timeout` | 5-10s | 30-60s | 2-5min |

## Rate Limiting

Rate limiting controls the throughput of requests to protect services from overload. The noex framework includes a built-in `RateLimiter` service, but understanding the pattern helps you customize it.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      SLIDING WINDOW RATE LIMITING                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Time Window: 1 minute (60,000 ms)                                          │
│  Limit: 100 requests                                                        │
│                                                                             │
│  Window slides continuously with time:                                      │
│                                                                             │
│  ──────────────────────────────────────────────────────────────────────▶   │
│  │←───────────── 60 seconds ───────────────▶│                              │
│  │                                           │                              │
│  │  [r1] [r2] [r3] ... [r95] [r96] [r97]    │  [NEW REQUEST]               │
│  │   ▲                                       │       │                      │
│  │   │                                       │       ▼                      │
│  │   └── oldest request ────────────────────┘   Count = 97                  │
│  │       (expires in 5 seconds)                 Allowed? YES (97 < 100)     │
│  │                                                                          │
│  └──────────────────────────────────────────────────────────────────────   │
│                                                                             │
│  Key Benefits of Sliding Window:                                            │
│  • No "boundary burst" problem                                              │
│  • Smooth rate limiting across time                                         │
│  • Accurate request counting                                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Using the Built-in RateLimiter

```typescript
import { RateLimiter, type RateLimitResult } from '@hamicek/noex';

async function rateLimiterDemo() {
  // Start rate limiter: 10 requests per minute
  const limiter = await RateLimiter.start({
    maxRequests: 10,
    windowMs: 60000,
    name: 'api-limiter',
  });

  // Simulate API requests
  async function handleRequest(userId: string): Promise<string> {
    const key = `user:${userId}`;

    // Check rate limit before processing
    const result = await RateLimiter.check(limiter, key);

    if (!result.allowed) {
      return `Rate limited. Retry after ${result.retryAfterMs}ms. ` +
             `Used: ${result.current}/${result.limit}`;
    }

    // Consume one request slot
    await RateLimiter.consume(limiter, key);

    // Process the request
    return `Request processed. Remaining: ${result.remaining - 1}/${result.limit}`;
  }

  // Test with multiple requests
  for (let i = 0; i < 15; i++) {
    const response = await handleRequest('user123');
    console.log(`Request ${i + 1}: ${response}`);
  }

  // Check status
  const status = await RateLimiter.getStatus(limiter, 'user:user123');
  console.log('\nFinal status:', status);

  await RateLimiter.stop(limiter);
}
```

### Multi-Tier Rate Limiting

Different limits for different operation types:

```typescript
import { GenServer, Supervisor, Registry, type GenServerBehavior } from '@hamicek/noex';
import { RateLimiter, type RateLimitResult, type RateLimiterRef } from '@hamicek/noex';

interface TieredLimiterState {
  limiters: Map<string, RateLimiterRef>;
}

type TierConfig = {
  name: string;
  maxRequests: number;
  windowMs: number;
};

const tiers: TierConfig[] = [
  { name: 'read', maxRequests: 1000, windowMs: 60000 },   // 1000/min for reads
  { name: 'write', maxRequests: 100, windowMs: 60000 },   // 100/min for writes
  { name: 'admin', maxRequests: 10, windowMs: 60000 },    // 10/min for admin ops
];

type TieredCall =
  | { type: 'check'; tier: string; key: string }
  | { type: 'consume'; tier: string; key: string };

const tieredLimiterBehavior: GenServerBehavior<TieredLimiterState, TieredCall, never, RateLimitResult> = {
  async init() {
    const limiters = new Map<string, RateLimiterRef>();

    for (const tier of tiers) {
      const limiter = await RateLimiter.start({
        maxRequests: tier.maxRequests,
        windowMs: tier.windowMs,
        name: `tier-${tier.name}`,
      });
      limiters.set(tier.name, limiter);
    }

    return { limiters };
  },

  async handleCall(msg, state) {
    const limiter = state.limiters.get(msg.tier);
    if (!limiter) {
      throw new Error(`Unknown tier: ${msg.tier}`);
    }

    if (msg.type === 'check') {
      const result = await RateLimiter.check(limiter, msg.key);
      return [result, state];
    }

    // consume
    try {
      const result = await RateLimiter.consume(limiter, msg.key);
      return [result, state];
    } catch (error) {
      // Return the rate limit status even on limit exceeded
      const status = await RateLimiter.getStatus(limiter, msg.key);
      return [status, state];
    }
  },

  handleCast: (_, state) => state,

  async terminate(_, state) {
    for (const limiter of state.limiters.values()) {
      await RateLimiter.stop(limiter);
    }
  },
};

// Usage
async function tieredRateLimitDemo() {
  const tieredLimiter = await GenServer.start(tieredLimiterBehavior, { name: 'tiered-limiter' });

  // Check read limit (high)
  const readResult = await GenServer.call(tieredLimiter, {
    type: 'consume',
    tier: 'read',
    key: 'user:123',
  });
  console.log('Read request:', readResult);

  // Check write limit (medium)
  const writeResult = await GenServer.call(tieredLimiter, {
    type: 'consume',
    tier: 'write',
    key: 'user:123',
  });
  console.log('Write request:', writeResult);

  // Check admin limit (low)
  const adminResult = await GenServer.call(tieredLimiter, {
    type: 'consume',
    tier: 'admin',
    key: 'user:123',
  });
  console.log('Admin request:', adminResult);

  await GenServer.stop(tieredLimiter);
}
```

## Combining Patterns

Real-world systems often combine multiple patterns. Here's an example combining rate limiting and circuit breaker:

```typescript
import { GenServer, Registry, type GenServerBehavior } from '@hamicek/noex';
import { RateLimiter } from '@hamicek/noex';

// Resilient API client that combines rate limiting + circuit breaker
interface ResilientClientState {
  circuitState: 'closed' | 'open' | 'half_open';
  failureCount: number;
  lastFailureTime: number;
  successCount: number;
}

interface ResilientClientConfig {
  // Rate limiting
  maxRequestsPerMinute: number;
  // Circuit breaker
  failureThreshold: number;
  successThreshold: number;
  circuitTimeout: number;
}

type ClientCall = {
  type: 'request';
  key: string;
  fn: () => Promise<unknown>;
};

const createResilientClientBehavior = (
  config: ResilientClientConfig,
): GenServerBehavior<ResilientClientState, ClientCall, never, unknown> => ({
  init: () => ({
    circuitState: 'closed',
    failureCount: 0,
    lastFailureTime: 0,
    successCount: 0,
  }),

  async handleCall(msg, state) {
    if (msg.type === 'request') {
      // Step 1: Check rate limit
      const limiter = Registry.whereis('client-rate-limiter');
      if (limiter) {
        const rateResult = await RateLimiter.check(limiter as any, msg.key);
        if (!rateResult.allowed) {
          throw new Error(`Rate limited. Retry after ${rateResult.retryAfterMs}ms`);
        }
      }

      // Step 2: Check circuit breaker
      if (state.circuitState === 'open') {
        const timeSinceFailure = Date.now() - state.lastFailureTime;
        if (timeSinceFailure < config.circuitTimeout) {
          throw new Error('Circuit breaker open');
        }
        state.circuitState = 'half_open';
        state.successCount = 0;
      }

      // Step 3: Execute request
      try {
        // Consume rate limit
        if (limiter) {
          await RateLimiter.consume(limiter as any, msg.key);
        }

        const result = await msg.fn();

        // Success handling
        if (state.circuitState === 'half_open') {
          state.successCount++;
          if (state.successCount >= config.successThreshold) {
            state.circuitState = 'closed';
            state.failureCount = 0;
          }
        } else {
          state.failureCount = 0;
        }

        return [result, state];

      } catch (error) {
        // Failure handling
        state.failureCount++;
        state.lastFailureTime = Date.now();

        if (state.circuitState === 'half_open' ||
            state.failureCount >= config.failureThreshold) {
          state.circuitState = 'open';
          state.successCount = 0;
        }

        throw error;
      }
    }

    throw new Error('Unknown message type');
  },

  handleCast: (_, state) => state,
});
```

## Exercise

Build a **notification delivery system** using the patterns from this chapter:

Requirements:
1. **Worker Pool**: 3 workers to process notification deliveries
2. **Rate Limiting**: Max 100 notifications per minute per user
3. **Circuit Breaker**: Per-channel (email, SMS, push) circuit breakers
4. **Pipeline**: Validate → Rate Check → Deliver → Track

Hints:
- Use `simple_one_for_one` supervisor for dynamic worker creation
- Each channel (email, SMS, push) should have its own circuit breaker
- Track delivery status in a separate GenServer

<details>
<summary>Solution</summary>

```typescript
import {
  GenServer,
  Supervisor,
  Registry,
  EventBus,
  type GenServerBehavior,
  type GenServerRef,
  type SupervisorRef,
  type EventBusRef,
} from '@hamicek/noex';
import { RateLimiter, type RateLimiterRef } from '@hamicek/noex';

// ============================================================================
// Types
// ============================================================================

type Channel = 'email' | 'sms' | 'push';

interface Notification {
  id: string;
  userId: string;
  channel: Channel;
  content: string;
  priority: number;
}

interface DeliveryResult {
  notificationId: string;
  success: boolean;
  channel: Channel;
  error?: string;
  timestamp: Date;
}

// ============================================================================
// Circuit Breaker (per channel)
// ============================================================================

interface ChannelCircuitState {
  state: 'closed' | 'open' | 'half_open';
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
}

type CircuitCall =
  | { type: 'canExecute' }
  | { type: 'recordSuccess' }
  | { type: 'recordFailure' };

const createCircuitBehavior = (channel: Channel): GenServerBehavior<
  ChannelCircuitState,
  CircuitCall,
  never,
  boolean
> => ({
  init: () => ({
    state: 'closed',
    failureCount: 0,
    successCount: 0,
    lastFailureTime: 0,
  }),

  handleCall(msg, state) {
    const FAILURE_THRESHOLD = 5;
    const SUCCESS_THRESHOLD = 3;
    const TIMEOUT = 30000;

    switch (msg.type) {
      case 'canExecute': {
        if (state.state === 'open') {
          if (Date.now() - state.lastFailureTime >= TIMEOUT) {
            return [true, { ...state, state: 'half_open', successCount: 0 }];
          }
          return [false, state];
        }
        return [true, state];
      }

      case 'recordSuccess': {
        if (state.state === 'half_open') {
          const newSuccessCount = state.successCount + 1;
          if (newSuccessCount >= SUCCESS_THRESHOLD) {
            return [true, { ...state, state: 'closed', failureCount: 0, successCount: 0 }];
          }
          return [true, { ...state, successCount: newSuccessCount }];
        }
        return [true, { ...state, failureCount: 0 }];
      }

      case 'recordFailure': {
        const newFailureCount = state.failureCount + 1;
        if (state.state === 'half_open' || newFailureCount >= FAILURE_THRESHOLD) {
          return [false, {
            ...state,
            state: 'open',
            failureCount: newFailureCount,
            lastFailureTime: Date.now(),
            successCount: 0,
          }];
        }
        return [false, { ...state, failureCount: newFailureCount }];
      }
    }
  },

  handleCast: (_, state) => state,
});

// ============================================================================
// Delivery Tracker
// ============================================================================

interface TrackerState {
  deliveries: Map<string, DeliveryResult>;
}

type TrackerCall =
  | { type: 'get'; notificationId: string }
  | { type: 'getAll' };

type TrackerCast =
  | { type: 'record'; result: DeliveryResult };

const trackerBehavior: GenServerBehavior<
  TrackerState,
  TrackerCall,
  TrackerCast,
  DeliveryResult | undefined | DeliveryResult[]
> = {
  init: () => ({ deliveries: new Map() }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.deliveries.get(msg.notificationId), state];
      case 'getAll':
        return [Array.from(state.deliveries.values()), state];
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'record') {
      state.deliveries.set(msg.result.notificationId, msg.result);
    }
    return state;
  },
};

// ============================================================================
// Delivery Worker
// ============================================================================

interface WorkerState {
  id: string;
  delivered: number;
}

type WorkerCast = { type: 'deliver'; notification: Notification };

function createWorkerBehavior(workerId: string): GenServerBehavior<
  WorkerState,
  never,
  WorkerCast,
  never
> {
  return {
    init: () => ({ id: workerId, delivered: 0 }),

    handleCall(_, state) {
      return [undefined as never, state];
    },

    async handleCast(msg, state) {
      if (msg.type === 'deliver') {
        const { notification } = msg;
        const circuit = Registry.whereis(`circuit-${notification.channel}`);
        const tracker = Registry.whereis('tracker');
        const bus = Registry.whereis<EventBusRef>('event-bus');

        // Check circuit breaker
        if (circuit) {
          const canExecute = await GenServer.call(circuit, { type: 'canExecute' });
          if (!canExecute) {
            // Circuit open - fail fast
            const result: DeliveryResult = {
              notificationId: notification.id,
              success: false,
              channel: notification.channel,
              error: 'Circuit breaker open',
              timestamp: new Date(),
            };
            if (tracker) GenServer.cast(tracker, { type: 'record', result });
            if (bus) EventBus.publish(bus, 'delivery.failed', result);
            return state;
          }
        }

        // Simulate delivery
        try {
          await simulateDelivery(notification.channel);

          // Record success
          if (circuit) {
            await GenServer.call(circuit, { type: 'recordSuccess' });
          }

          const result: DeliveryResult = {
            notificationId: notification.id,
            success: true,
            channel: notification.channel,
            timestamp: new Date(),
          };
          if (tracker) GenServer.cast(tracker, { type: 'record', result });
          if (bus) EventBus.publish(bus, 'delivery.success', result);

          return { ...state, delivered: state.delivered + 1 };

        } catch (error) {
          // Record failure
          if (circuit) {
            await GenServer.call(circuit, { type: 'recordFailure' });
          }

          const result: DeliveryResult = {
            notificationId: notification.id,
            success: false,
            channel: notification.channel,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date(),
          };
          if (tracker) GenServer.cast(tracker, { type: 'record', result });
          if (bus) EventBus.publish(bus, 'delivery.failed', result);

          return state;
        }
      }
      return state;
    },
  };
}

async function simulateDelivery(channel: Channel): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));

  // Simulate different failure rates per channel
  const failureRates: Record<Channel, number> = {
    email: 0.05,  // 5% failure
    sms: 0.15,    // 15% failure
    push: 0.02,   // 2% failure
  };

  if (Math.random() < failureRates[channel]) {
    throw new Error(`${channel} delivery failed`);
  }
}

// ============================================================================
// Pipeline Coordinator
// ============================================================================

interface PipelineState {
  queue: Notification[];
  nextWorker: number;
  workerCount: number;
}

type PipelineCall = { type: 'submit'; notification: Omit<Notification, 'id'> };
type PipelineCast = { type: 'processQueue' };

const createPipelineBehavior = (
  workerCount: number,
): GenServerBehavior<PipelineState, PipelineCall, PipelineCast, string> => ({
  init: () => ({ queue: [], nextWorker: 0, workerCount }),

  async handleCall(msg, state) {
    if (msg.type === 'submit') {
      const notification: Notification = {
        ...msg.notification,
        id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      };

      // Step 1: Validate
      if (!notification.userId || !notification.content) {
        throw new Error('Invalid notification: missing userId or content');
      }

      // Step 2: Check rate limit
      const limiter = Registry.whereis('notification-limiter') as RateLimiterRef | undefined;
      if (limiter) {
        const key = `user:${notification.userId}`;
        const result = await RateLimiter.check(limiter, key);
        if (!result.allowed) {
          throw new Error(`Rate limited. Retry after ${result.retryAfterMs}ms`);
        }
        await RateLimiter.consume(limiter, key);
      }

      // Step 3: Add to queue
      state.queue.push(notification);

      // Trigger processing
      const self = Registry.whereis('notification-pipeline');
      if (self) {
        GenServer.cast(self, { type: 'processQueue' });
      }

      return [notification.id, state];
    }
    throw new Error('Unknown message type');
  },

  handleCast(msg, state) {
    if (msg.type === 'processQueue') {
      while (state.queue.length > 0) {
        const notification = state.queue.shift()!;
        const workerId = `delivery-worker-${state.nextWorker}`;
        state.nextWorker = (state.nextWorker + 1) % state.workerCount;

        const worker = Registry.whereis(workerId);
        if (worker) {
          GenServer.cast(worker, { type: 'deliver', notification });
        }
      }
    }
    return state;
  },
});

// ============================================================================
// Start the System
// ============================================================================

async function startNotificationSystem() {
  // EventBus
  await EventBus.start({ name: 'event-bus' });

  // Rate Limiter: 100 notifications per minute per user
  await RateLimiter.start({
    maxRequests: 100,
    windowMs: 60000,
    name: 'notification-limiter',
  });

  // Circuit breakers for each channel
  for (const channel of ['email', 'sms', 'push'] as Channel[]) {
    await GenServer.start(createCircuitBehavior(channel), {
      name: `circuit-${channel}`,
    });
  }

  // Tracker
  await GenServer.start(trackerBehavior, { name: 'tracker' });

  // Workers (using simple_one_for_one would be better for production)
  const workerCount = 3;
  for (let i = 0; i < workerCount; i++) {
    await GenServer.start(createWorkerBehavior(`worker-${i}`), {
      name: `delivery-worker-${i}`,
    });
  }

  // Pipeline
  await GenServer.start(createPipelineBehavior(workerCount), {
    name: 'notification-pipeline',
  });

  console.log('Notification system started');
}

// ============================================================================
// Demo
// ============================================================================

async function notificationDemo() {
  await startNotificationSystem();

  const pipeline = Registry.lookup('notification-pipeline');
  const bus = Registry.whereis<EventBusRef>('event-bus')!;

  // Subscribe to events
  EventBus.subscribe(bus, 'delivery.*', (result: DeliveryResult, topic) => {
    console.log(`[${topic}] ${result.notificationId} via ${result.channel}: ${result.success ? 'OK' : result.error}`);
  });

  // Send notifications
  const notifications = [
    { userId: 'user1', channel: 'email' as Channel, content: 'Welcome!', priority: 1 },
    { userId: 'user1', channel: 'push' as Channel, content: 'New message', priority: 2 },
    { userId: 'user2', channel: 'sms' as Channel, content: 'Verify code: 123456', priority: 3 },
    { userId: 'user1', channel: 'email' as Channel, content: 'Order shipped', priority: 1 },
    { userId: 'user3', channel: 'push' as Channel, content: 'Sale ends soon!', priority: 1 },
  ];

  for (const notification of notifications) {
    try {
      const id = await GenServer.call(pipeline, { type: 'submit', notification });
      console.log(`Submitted: ${id}`);
    } catch (error) {
      console.error(`Failed to submit:`, error);
    }
  }

  // Wait for processing
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Check tracker
  const tracker = Registry.whereis('tracker');
  if (tracker) {
    const results = await GenServer.call(tracker, { type: 'getAll' });
    console.log('\nDelivery results:', results);
  }
}
```

### Key Design Decisions

1. **Worker Pool with round-robin**: Simple load balancing across workers
2. **Per-channel circuit breakers**: SMS can fail without affecting email
3. **Single rate limiter per user**: Prevents any user from flooding the system
4. **Tracker as separate process**: Delivery tracking doesn't block delivery
5. **EventBus for observability**: Loose coupling for monitoring and analytics

</details>

## Summary

- **Request-Response Pipeline**: Sequential processing with clear stage separation
  - Best for: ETL, data processing, request handling
  - Key benefit: Each stage can fail/restart independently

- **Worker Pool**: Parallel processing with bounded concurrency
  - Best for: Job queues, background tasks, batch processing
  - Key benefit: Backpressure prevents resource exhaustion

- **Circuit Breaker**: Fail-fast when downstream services are unhealthy
  - Best for: External API calls, database connections
  - Key benefit: Prevents cascade failures

- **Rate Limiting**: Control request throughput per key
  - Best for: API endpoints, user actions
  - Key benefit: Protects services from overload

These patterns compose well together. A typical production system might use:
- Rate limiting at the API gateway
- Worker pool for async processing
- Circuit breakers for external calls
- Pipelines for complex transformations

The actor model makes these patterns natural to implement because each component is already an isolated process with its own state and failure handling.

---

Next: [When to Use GenStateMachine](../05-state-machine/01-when-to-use.md)
