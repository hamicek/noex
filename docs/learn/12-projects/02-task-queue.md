# Task Queue

In this project, you'll build a production-ready task queue that demonstrates how noex handles background job processing, worker pool management, and fault tolerance. Unlike traditional Node.js job queues that rely on external services, this implementation leverages the actor model for elegant concurrency control and automatic failure recovery.

## What You'll Learn

- Design a job processing system using GenServer, Supervisor, and EventBus
- Implement a worker pool with `simple_one_for_one` dynamic supervision
- Build retry logic with exponential backoff using `sendAfter`
- Create a dead letter queue for failed jobs
- Handle backpressure and rate limiting
- Implement graceful shutdown with in-flight job completion

## What You'll Build

A task queue with:
- **Job Queue** — Priority-based job scheduling with persistence
- **Worker Pool** — Dynamic pool of workers that scale based on load
- **Retry Logic** — Exponential backoff with configurable max attempts
- **Dead Letter Queue** — Failed jobs stored for inspection and replay
- **Job Status Tracking** — Real-time status via EventBus

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        TASK QUEUE ARCHITECTURE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                  Task Queue Application Supervisor                   │    │
│  │                          (one_for_all)                               │    │
│  └────────────────────────────┬────────────────────────────────────────┘    │
│                               │                                             │
│       ┌───────────────────────┼───────────────────────┬────────────────┐    │
│       │                       │                       │                │    │
│       ▼                       ▼                       ▼                ▼    │
│  ┌──────────┐        ┌──────────────┐        ┌──────────┐      ┌──────────┐ │
│  │ EventBus │        │  Job Queue   │        │  Worker  │      │  Dead    │ │
│  │          │        │  GenServer   │        │ Pool Sup │      │  Letter  │ │
│  │          │        │              │        │  (s1f1)  │      │  Queue   │ │
│  └────┬─────┘        └──────┬───────┘        └────┬─────┘      └────┬─────┘ │
│       │                     │                     │                 │       │
│       │                     │    ┌────────────────┤                 │       │
│       │                     │    │                │                 │       │
│       │                     │    │     ┌─────────┬┴─────────┐       │       │
│       │                     │    │     │         │          │       │       │
│       │                     ▼    ▼     ▼         ▼          ▼       │       │
│       │               ┌────────────────────────────────────────┐    │       │
│       │               │  ┌────────┐  ┌────────┐  ┌────────┐   │    │       │
│       │               │  │Worker 1│  │Worker 2│  │Worker N│   │    │       │
│       │               │  │        │  │        │  │        │   │    │       │
│       │               │  └────┬───┘  └────┬───┘  └────┬───┘   │    │       │
│       │               │       │           │           │        │    │       │
│       │               └───────┼───────────┼───────────┼────────┘    │       │
│       │                       │           │           │             │       │
│       └───────────────────────┴───────────┴───────────┴─────────────┘       │
│                            (publishes job events)                           │
│                                                                             │
│  Job Flow:                                                                  │
│  1. Client enqueues job → Job Queue                                         │
│  2. Job Queue dispatches → Available Worker                                 │
│  3. Worker processes → Success/Failure                                      │
│  4. Failure → Retry with backoff OR Dead Letter Queue                       │
│  5. All transitions → EventBus notifications                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Component responsibilities:**

| Component | Role |
|-----------|------|
| **Task Queue Supervisor** | Top-level supervisor ensuring system consistency |
| **Job Queue** | Stores jobs, manages priority queue, dispatches to workers |
| **Worker Pool Supervisor** | Manages dynamic worker instances with `simple_one_for_one` |
| **Worker** | Executes individual jobs, reports results |
| **Dead Letter Queue** | Stores failed jobs after max retries |
| **EventBus** | Publishes job lifecycle events for external observers |

## Part 1: Job Protocol

First, define the job structure and related types:

```typescript
// src/task-queue/types.ts
import type { GenServerRef } from '@hamicek/noex';

// Job priority levels
export type JobPriority = 'critical' | 'high' | 'normal' | 'low';

// Job status throughout its lifecycle
export type JobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'dead';

// Core job definition
export interface Job<TPayload = unknown> {
  id: string;
  type: string;
  payload: TPayload;
  priority: JobPriority;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  scheduledAt?: number; // For delayed jobs
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: unknown;
  metadata?: Record<string, unknown>;
}

// Job handler function signature
export type JobHandler<TPayload = unknown, TResult = unknown> = (
  job: Job<TPayload>
) => Promise<TResult>;

// Registry of job handlers by type
export type JobHandlerRegistry = Map<string, JobHandler>;

// Priority weights for queue ordering
export const PRIORITY_WEIGHTS: Record<JobPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

// Job Queue events published to EventBus
export interface JobEvent {
  jobId: string;
  type: string;
  timestamp: number;
}

export interface JobEnqueuedEvent extends JobEvent {
  eventType: 'job.enqueued';
  priority: JobPriority;
}

export interface JobStartedEvent extends JobEvent {
  eventType: 'job.started';
  workerId: string;
  attempt: number;
}

export interface JobCompletedEvent extends JobEvent {
  eventType: 'job.completed';
  workerId: string;
  result: unknown;
  duration: number;
}

export interface JobFailedEvent extends JobEvent {
  eventType: 'job.failed';
  workerId: string;
  error: string;
  attempt: number;
  willRetry: boolean;
  nextRetryAt?: number;
}

export interface JobDeadEvent extends JobEvent {
  eventType: 'job.dead';
  error: string;
  attempts: number;
}

export type TaskQueueEvent =
  | JobEnqueuedEvent
  | JobStartedEvent
  | JobCompletedEvent
  | JobFailedEvent
  | JobDeadEvent;

// Configuration
export interface TaskQueueConfig {
  maxWorkers: number;
  minWorkers: number;
  defaultMaxAttempts: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  jobTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export const DEFAULT_CONFIG: TaskQueueConfig = {
  maxWorkers: 10,
  minWorkers: 1,
  defaultMaxAttempts: 3,
  baseRetryDelayMs: 1000,
  maxRetryDelayMs: 60_000,
  jobTimeoutMs: 30_000,
  shutdownTimeoutMs: 30_000,
};
```

## Part 2: Job Queue GenServer

The Job Queue manages the priority queue, dispatches jobs to workers, and handles retries:

```typescript
// src/task-queue/job-queue.ts
import {
  GenServer,
  EventBus,
  Registry,
  type GenServerRef,
  type EventBusRef,
  type TimerRef,
} from '@hamicek/noex';
import {
  type Job,
  type JobPriority,
  type JobHandler,
  type JobHandlerRegistry,
  type TaskQueueConfig,
  type TaskQueueEvent,
  PRIORITY_WEIGHTS,
  DEFAULT_CONFIG,
} from './types';

// Internal state
interface JobQueueState {
  config: TaskQueueConfig;
  handlers: JobHandlerRegistry;
  pendingJobs: Job[];
  processingJobs: Map<string, Job>;
  retryTimers: Map<string, TimerRef>;
  eventBus: EventBusRef;
  workerPoolRef: GenServerRef | null;
  availableWorkers: Set<string>;
  isShuttingDown: boolean;
}

// Call messages (request/response)
type JobQueueCallMsg =
  | { type: 'enqueue'; job: Omit<Job, 'id' | 'status' | 'attempts' | 'createdAt' | 'updatedAt'> & { id?: string } }
  | { type: 'getJob'; jobId: string }
  | { type: 'getStats' }
  | { type: 'getQueueSize' }
  | { type: 'cancelJob'; jobId: string };

type JobQueueCallReply =
  | { success: true; jobId: string }
  | { success: true; job: Job | null }
  | { success: true; stats: QueueStats }
  | { success: true; size: number }
  | { success: true; cancelled: boolean }
  | { success: false; error: string };

// Cast messages (fire-and-forget)
type JobQueueCastMsg =
  | { type: 'registerHandler'; jobType: string; handler: JobHandler }
  | { type: 'workerAvailable'; workerId: string }
  | { type: 'workerBusy'; workerId: string }
  | { type: 'jobCompleted'; jobId: string; workerId: string; result: unknown }
  | { type: 'jobFailed'; jobId: string; workerId: string; error: string }
  | { type: 'retryJob'; jobId: string }
  | { type: 'setWorkerPool'; ref: GenServerRef }
  | { type: 'initiateShutdown' };

interface QueueStats {
  pending: number;
  processing: number;
  pendingByPriority: Record<JobPriority, number>;
  availableWorkers: number;
  registeredHandlers: string[];
}

// Generate unique job ID
function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// Calculate exponential backoff delay
function calculateRetryDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number
): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 0.2 * exponentialDelay; // 20% jitter
  return Math.min(exponentialDelay + jitter, maxDelay);
}

// Insert job maintaining priority order
function insertByPriority(jobs: Job[], job: Job): Job[] {
  const newJobs = [...jobs];
  const jobWeight = PRIORITY_WEIGHTS[job.priority];

  // Find insertion point
  let insertIndex = newJobs.length;
  for (let i = 0; i < newJobs.length; i++) {
    if (PRIORITY_WEIGHTS[newJobs[i].priority] > jobWeight) {
      insertIndex = i;
      break;
    }
  }

  newJobs.splice(insertIndex, 0, job);
  return newJobs;
}

export const JobQueueBehavior = {
  init(
    config: Partial<TaskQueueConfig>,
    eventBus: EventBusRef
  ): JobQueueState {
    console.log('[JobQueue] initialized');
    return {
      config: { ...DEFAULT_CONFIG, ...config },
      handlers: new Map(),
      pendingJobs: [],
      processingJobs: new Map(),
      retryTimers: new Map(),
      eventBus,
      workerPoolRef: null,
      availableWorkers: new Set(),
      isShuttingDown: false,
    };
  },

  handleCall(
    msg: JobQueueCallMsg,
    state: JobQueueState
  ): [JobQueueCallReply, JobQueueState] {
    switch (msg.type) {
      case 'enqueue': {
        if (state.isShuttingDown) {
          return [{ success: false, error: 'Queue is shutting down' }, state];
        }

        const jobId = msg.job.id ?? generateJobId();
        const now = Date.now();

        const job: Job = {
          ...msg.job,
          id: jobId,
          status: 'pending',
          attempts: 0,
          maxAttempts: msg.job.maxAttempts ?? state.config.defaultMaxAttempts,
          createdAt: now,
          updatedAt: now,
        };

        // Check if handler exists for this job type
        if (!state.handlers.has(job.type)) {
          return [
            { success: false, error: `No handler registered for job type: ${job.type}` },
            state,
          ];
        }

        // Insert into priority queue
        const newPendingJobs = insertByPriority(state.pendingJobs, job);

        // Publish event
        publishEvent(state.eventBus, {
          eventType: 'job.enqueued',
          jobId: job.id,
          type: job.type,
          priority: job.priority,
          timestamp: now,
        });

        console.log(`[JobQueue] Enqueued job ${jobId} (${job.type}, priority: ${job.priority})`);

        // Try to dispatch immediately
        const newState = { ...state, pendingJobs: newPendingJobs };
        const dispatchedState = tryDispatchJobs(newState);

        return [{ success: true, jobId }, dispatchedState];
      }

      case 'getJob': {
        const job = state.pendingJobs.find((j) => j.id === msg.jobId)
          ?? state.processingJobs.get(msg.jobId)
          ?? null;
        return [{ success: true, job }, state];
      }

      case 'getStats': {
        const pendingByPriority: Record<JobPriority, number> = {
          critical: 0,
          high: 0,
          normal: 0,
          low: 0,
        };

        for (const job of state.pendingJobs) {
          pendingByPriority[job.priority]++;
        }

        const stats: QueueStats = {
          pending: state.pendingJobs.length,
          processing: state.processingJobs.size,
          pendingByPriority,
          availableWorkers: state.availableWorkers.size,
          registeredHandlers: Array.from(state.handlers.keys()),
        };

        return [{ success: true, stats }, state];
      }

      case 'getQueueSize': {
        return [
          { success: true, size: state.pendingJobs.length + state.processingJobs.size },
          state,
        ];
      }

      case 'cancelJob': {
        // Check pending
        const pendingIndex = state.pendingJobs.findIndex((j) => j.id === msg.jobId);
        if (pendingIndex !== -1) {
          const newPendingJobs = [...state.pendingJobs];
          newPendingJobs.splice(pendingIndex, 1);

          // Cancel retry timer if exists
          const timer = state.retryTimers.get(msg.jobId);
          if (timer) {
            GenServer.cancelTimer(timer);
            state.retryTimers.delete(msg.jobId);
          }

          console.log(`[JobQueue] Cancelled job ${msg.jobId}`);
          return [{ success: true, cancelled: true }, { ...state, pendingJobs: newPendingJobs }];
        }

        // Cannot cancel processing jobs
        if (state.processingJobs.has(msg.jobId)) {
          return [{ success: false, error: 'Cannot cancel job that is currently processing' }, state];
        }

        return [{ success: true, cancelled: false }, state];
      }
    }
  },

  handleCast(msg: JobQueueCastMsg, state: JobQueueState): JobQueueState {
    switch (msg.type) {
      case 'registerHandler': {
        state.handlers.set(msg.jobType, msg.handler);
        console.log(`[JobQueue] Registered handler for job type: ${msg.jobType}`);
        return state;
      }

      case 'setWorkerPool': {
        return { ...state, workerPoolRef: msg.ref };
      }

      case 'workerAvailable': {
        const newAvailable = new Set(state.availableWorkers);
        newAvailable.add(msg.workerId);
        const newState = { ...state, availableWorkers: newAvailable };
        return tryDispatchJobs(newState);
      }

      case 'workerBusy': {
        const newAvailable = new Set(state.availableWorkers);
        newAvailable.delete(msg.workerId);
        return { ...state, availableWorkers: newAvailable };
      }

      case 'jobCompleted': {
        const job = state.processingJobs.get(msg.jobId);
        if (!job) return state;

        const now = Date.now();
        const duration = now - (job.startedAt ?? now);

        // Update job state
        const completedJob: Job = {
          ...job,
          status: 'completed',
          result: msg.result,
          completedAt: now,
          updatedAt: now,
        };

        // Remove from processing
        const newProcessing = new Map(state.processingJobs);
        newProcessing.delete(msg.jobId);

        // Publish event
        publishEvent(state.eventBus, {
          eventType: 'job.completed',
          jobId: msg.jobId,
          type: job.type,
          workerId: msg.workerId,
          result: msg.result,
          duration,
          timestamp: now,
        });

        console.log(`[JobQueue] Job ${msg.jobId} completed in ${duration}ms`);

        return { ...state, processingJobs: newProcessing };
      }

      case 'jobFailed': {
        const job = state.processingJobs.get(msg.jobId);
        if (!job) return state;

        const now = Date.now();
        const willRetry = job.attempts < job.maxAttempts;

        // Remove from processing
        const newProcessing = new Map(state.processingJobs);
        newProcessing.delete(msg.jobId);

        let newState = { ...state, processingJobs: newProcessing };

        if (willRetry) {
          // Calculate retry delay with exponential backoff
          const delay = calculateRetryDelay(
            job.attempts,
            state.config.baseRetryDelayMs,
            state.config.maxRetryDelayMs
          );

          // Schedule retry
          const queueRef = Registry.whereis('job-queue');
          if (queueRef) {
            const timerRef = GenServer.sendAfter(
              queueRef,
              { type: 'retryJob', jobId: msg.jobId },
              delay
            );

            const newRetryTimers = new Map(state.retryTimers);
            newRetryTimers.set(msg.jobId, timerRef);

            // Re-add job to pending with updated attempt count
            const retryJob: Job = {
              ...job,
              status: 'pending',
              error: msg.error,
              updatedAt: now,
              scheduledAt: now + delay,
            };

            newState = {
              ...newState,
              pendingJobs: insertByPriority(newState.pendingJobs, retryJob),
              retryTimers: newRetryTimers,
            };
          }

          // Publish retry event
          publishEvent(state.eventBus, {
            eventType: 'job.failed',
            jobId: msg.jobId,
            type: job.type,
            workerId: msg.workerId,
            error: msg.error,
            attempt: job.attempts,
            willRetry: true,
            nextRetryAt: now + delay,
            timestamp: now,
          });

          console.log(
            `[JobQueue] Job ${msg.jobId} failed (attempt ${job.attempts}/${job.maxAttempts}), retrying in ${delay}ms`
          );
        } else {
          // Move to dead letter queue
          const deadJob: Job = {
            ...job,
            status: 'dead',
            error: msg.error,
            completedAt: now,
            updatedAt: now,
          };

          // Send to DLQ
          const dlqRef = Registry.whereis('dead-letter-queue');
          if (dlqRef) {
            GenServer.cast(dlqRef, { type: 'addJob', job: deadJob });
          }

          // Publish dead event
          publishEvent(state.eventBus, {
            eventType: 'job.dead',
            jobId: msg.jobId,
            type: job.type,
            error: msg.error,
            attempts: job.attempts,
            timestamp: now,
          });

          console.log(
            `[JobQueue] Job ${msg.jobId} moved to dead letter queue after ${job.attempts} attempts`
          );
        }

        return newState;
      }

      case 'retryJob': {
        // Clear the retry timer
        const newRetryTimers = new Map(state.retryTimers);
        newRetryTimers.delete(msg.jobId);

        // Find the job in pending and check if it's ready
        const jobIndex = state.pendingJobs.findIndex((j) => j.id === msg.jobId);
        if (jobIndex === -1) {
          return { ...state, retryTimers: newRetryTimers };
        }

        const job = state.pendingJobs[jobIndex];
        const now = Date.now();

        // Check if scheduled time has passed
        if (job.scheduledAt && job.scheduledAt > now) {
          return { ...state, retryTimers: newRetryTimers };
        }

        // Clear scheduledAt and try to dispatch
        const updatedJobs = [...state.pendingJobs];
        updatedJobs[jobIndex] = { ...job, scheduledAt: undefined, updatedAt: now };

        const newState = {
          ...state,
          pendingJobs: updatedJobs,
          retryTimers: newRetryTimers,
        };

        return tryDispatchJobs(newState);
      }

      case 'initiateShutdown': {
        console.log('[JobQueue] Initiating graceful shutdown');

        // Cancel all retry timers
        for (const [, timer] of state.retryTimers) {
          GenServer.cancelTimer(timer);
        }

        return { ...state, isShuttingDown: true, retryTimers: new Map() };
      }
    }
  },

  terminate(reason: string, state: JobQueueState): void {
    console.log(`[JobQueue] terminated: ${reason}`);

    // Cancel all retry timers
    for (const [, timer] of state.retryTimers) {
      GenServer.cancelTimer(timer);
    }
  },
};

// Try to dispatch pending jobs to available workers
function tryDispatchJobs(state: JobQueueState): JobQueueState {
  if (state.isShuttingDown || state.availableWorkers.size === 0 || state.pendingJobs.length === 0) {
    return state;
  }

  let newState = { ...state };
  const now = Date.now();

  // Find dispatchable jobs (not scheduled for future)
  for (const job of state.pendingJobs) {
    if (newState.availableWorkers.size === 0) break;

    // Skip jobs scheduled for future
    if (job.scheduledAt && job.scheduledAt > now) {
      continue;
    }

    // Get available worker
    const workerId = newState.availableWorkers.values().next().value;
    if (!workerId) break;

    // Check if handler exists
    const handler = newState.handlers.get(job.type);
    if (!handler) continue;

    // Mark worker as busy
    const newAvailable = new Set(newState.availableWorkers);
    newAvailable.delete(workerId);

    // Move job to processing
    const updatedJob: Job = {
      ...job,
      status: 'processing',
      attempts: job.attempts + 1,
      startedAt: now,
      updatedAt: now,
    };

    const newProcessing = new Map(newState.processingJobs);
    newProcessing.set(job.id, updatedJob);

    const newPending = newState.pendingJobs.filter((j) => j.id !== job.id);

    // Dispatch to worker
    const workerRef = Registry.whereis(workerId);
    if (workerRef) {
      GenServer.cast(workerRef, {
        type: 'processJob',
        job: updatedJob,
        handler,
      });

      // Publish started event
      publishEvent(newState.eventBus, {
        eventType: 'job.started',
        jobId: job.id,
        type: job.type,
        workerId,
        attempt: updatedJob.attempts,
        timestamp: now,
      });

      console.log(`[JobQueue] Dispatched job ${job.id} to ${workerId} (attempt ${updatedJob.attempts})`);
    }

    newState = {
      ...newState,
      availableWorkers: newAvailable,
      processingJobs: newProcessing,
      pendingJobs: newPending,
    };
  }

  return newState;
}

// Publish event to EventBus
function publishEvent(eventBus: EventBusRef, event: TaskQueueEvent): void {
  EventBus.publish(eventBus, event.eventType, event);
}

// Start the Job Queue
export async function startJobQueue(
  eventBus: EventBusRef,
  config: Partial<TaskQueueConfig> = {}
): Promise<GenServerRef> {
  const ref = await GenServer.start<
    JobQueueState,
    JobQueueCallMsg,
    JobQueueCastMsg,
    JobQueueCallReply
  >({
    init: () => JobQueueBehavior.init(config, eventBus),
    handleCall: JobQueueBehavior.handleCall,
    handleCast: JobQueueBehavior.handleCast,
    terminate: JobQueueBehavior.terminate,
  });

  Registry.register('job-queue', ref);
  return ref;
}

// Public API

export function registerHandler(
  queue: GenServerRef,
  jobType: string,
  handler: JobHandler
): void {
  GenServer.cast(queue, { type: 'registerHandler', jobType, handler });
}

export async function enqueueJob<TPayload>(
  queue: GenServerRef,
  jobType: string,
  payload: TPayload,
  options: {
    priority?: JobPriority;
    maxAttempts?: number;
    metadata?: Record<string, unknown>;
  } = {}
): Promise<string> {
  const result = await GenServer.call<
    JobQueueState,
    JobQueueCallMsg,
    JobQueueCastMsg,
    JobQueueCallReply
  >(queue, {
    type: 'enqueue',
    job: {
      type: jobType,
      payload,
      priority: options.priority ?? 'normal',
      maxAttempts: options.maxAttempts,
      metadata: options.metadata,
    },
  });

  if (!result.success) {
    throw new Error((result as { success: false; error: string }).error);
  }

  return (result as { success: true; jobId: string }).jobId;
}

export async function getQueueStats(queue: GenServerRef): Promise<QueueStats> {
  const result = await GenServer.call(queue, { type: 'getStats' });
  if (!result.success) {
    throw new Error((result as { success: false; error: string }).error);
  }
  return (result as { success: true; stats: QueueStats }).stats;
}
```

## Part 3: Worker GenServer

Each worker processes one job at a time, reporting results back to the queue:

```typescript
// src/task-queue/worker.ts
import {
  GenServer,
  Registry,
  type GenServerRef,
  type TimerRef,
} from '@hamicek/noex';
import type { Job, JobHandler, TaskQueueConfig } from './types';

interface WorkerState {
  workerId: string;
  queueRef: GenServerRef;
  currentJob: Job | null;
  timeoutTimer: TimerRef | null;
  config: TaskQueueConfig;
}

type WorkerCallMsg =
  | { type: 'getStatus' };

type WorkerCallReply =
  | { status: 'idle' }
  | { status: 'processing'; jobId: string; jobType: string };

type WorkerCastMsg =
  | { type: 'processJob'; job: Job; handler: JobHandler }
  | { type: 'jobTimeout' }
  | { type: 'shutdown' };

export const WorkerBehavior = {
  init(
    workerId: string,
    queueRef: GenServerRef,
    config: TaskQueueConfig
  ): WorkerState {
    console.log(`[Worker:${workerId}] initialized`);

    // Notify queue that we're available
    GenServer.cast(queueRef, { type: 'workerAvailable', workerId });

    return {
      workerId,
      queueRef,
      currentJob: null,
      timeoutTimer: null,
      config,
    };
  },

  handleCall(
    msg: WorkerCallMsg,
    state: WorkerState
  ): [WorkerCallReply, WorkerState] {
    switch (msg.type) {
      case 'getStatus':
        if (state.currentJob) {
          return [
            {
              status: 'processing',
              jobId: state.currentJob.id,
              jobType: state.currentJob.type,
            },
            state,
          ];
        }
        return [{ status: 'idle' }, state];
    }
  },

  handleCast(msg: WorkerCastMsg, state: WorkerState): WorkerState {
    switch (msg.type) {
      case 'processJob': {
        const { job, handler } = msg;

        console.log(`[Worker:${state.workerId}] Processing job ${job.id}`);

        // Notify queue we're busy
        GenServer.cast(state.queueRef, {
          type: 'workerBusy',
          workerId: state.workerId,
        });

        // Set up timeout
        const workerRef = Registry.whereis(state.workerId);
        const timeoutTimer = workerRef
          ? GenServer.sendAfter(
              workerRef,
              { type: 'jobTimeout' },
              state.config.jobTimeoutMs
            )
          : null;

        // Execute job asynchronously
        executeJob(job, handler, state.workerId, state.queueRef, state.config);

        return {
          ...state,
          currentJob: job,
          timeoutTimer,
        };
      }

      case 'jobTimeout': {
        if (!state.currentJob) return state;

        console.log(`[Worker:${state.workerId}] Job ${state.currentJob.id} timed out`);

        // Report failure
        GenServer.cast(state.queueRef, {
          type: 'jobFailed',
          jobId: state.currentJob.id,
          workerId: state.workerId,
          error: `Job timed out after ${state.config.jobTimeoutMs}ms`,
        });

        // Mark as available again
        GenServer.cast(state.queueRef, {
          type: 'workerAvailable',
          workerId: state.workerId,
        });

        return {
          ...state,
          currentJob: null,
          timeoutTimer: null,
        };
      }

      case 'shutdown': {
        console.log(`[Worker:${state.workerId}] Shutting down`);

        // Cancel timeout if running
        if (state.timeoutTimer) {
          GenServer.cancelTimer(state.timeoutTimer);
        }

        return state;
      }
    }
  },

  terminate(reason: string, state: WorkerState): void {
    console.log(`[Worker:${state.workerId}] terminated: ${reason}`);

    // Cancel timeout timer
    if (state.timeoutTimer) {
      GenServer.cancelTimer(state.timeoutTimer);
    }
  },
};

// Execute job and report result
async function executeJob(
  job: Job,
  handler: JobHandler,
  workerId: string,
  queueRef: GenServerRef,
  config: TaskQueueConfig
): Promise<void> {
  try {
    const result = await handler(job);

    // Cancel timeout and report success
    const workerRef = Registry.whereis(workerId);
    if (workerRef) {
      // Clear current job state
      GenServer.cast(workerRef, { type: 'jobTimeout' }); // Reuse to clear state
    }

    GenServer.cast(queueRef, {
      type: 'jobCompleted',
      jobId: job.id,
      workerId,
      result,
    });

    // Mark worker as available
    GenServer.cast(queueRef, {
      type: 'workerAvailable',
      workerId,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    GenServer.cast(queueRef, {
      type: 'jobFailed',
      jobId: job.id,
      workerId,
      error: errorMessage,
    });

    // Mark worker as available
    GenServer.cast(queueRef, {
      type: 'workerAvailable',
      workerId,
    });
  }
}

// Start a worker
export async function startWorker(
  workerId: string,
  queueRef: GenServerRef,
  config: TaskQueueConfig
): Promise<GenServerRef> {
  const ref = await GenServer.start<
    WorkerState,
    WorkerCallMsg,
    WorkerCastMsg,
    WorkerCallReply
  >({
    init: () => WorkerBehavior.init(workerId, queueRef, config),
    handleCall: WorkerBehavior.handleCall,
    handleCast: WorkerBehavior.handleCast,
    terminate: WorkerBehavior.terminate,
  });

  // Register for lookup
  Registry.register(workerId, ref);

  return ref;
}
```

## Part 4: Worker Pool Supervisor

The Worker Pool Supervisor manages dynamic workers using `simple_one_for_one`:

```typescript
// src/task-queue/worker-pool.ts
import {
  Supervisor,
  type SupervisorRef,
  type GenServerRef,
} from '@hamicek/noex';
import { startWorker } from './worker';
import type { TaskQueueConfig } from './types';

let workerCounter = 0;

// Start the Worker Pool Supervisor
export async function startWorkerPool(
  queueRef: GenServerRef,
  config: TaskQueueConfig
): Promise<SupervisorRef> {
  const supervisor = await Supervisor.start({
    strategy: 'simple_one_for_one',
    childTemplate: {
      start: async () => {
        const workerId = `worker-${++workerCounter}`;
        return startWorker(workerId, queueRef, config);
      },
      restart: 'transient', // Restart only on abnormal exit
      shutdownTimeout: config.shutdownTimeoutMs,
    },
    restartIntensity: {
      maxRestarts: 10,
      withinMs: 60_000,
    },
  });

  // Start initial workers
  for (let i = 0; i < config.minWorkers; i++) {
    await Supervisor.startChild(supervisor, []);
  }

  console.log(`[WorkerPool] Started with ${config.minWorkers} workers`);
  return supervisor;
}

// Scale up workers
export async function scaleUp(
  supervisor: SupervisorRef,
  count: number = 1
): Promise<GenServerRef[]> {
  const refs: GenServerRef[] = [];

  for (let i = 0; i < count; i++) {
    const result = await Supervisor.startChild(supervisor, []);
    if (result.ref) {
      refs.push(result.ref);
    }
  }

  console.log(`[WorkerPool] Scaled up by ${refs.length} workers`);
  return refs;
}

// Get worker count
export function getWorkerCount(supervisor: SupervisorRef): number {
  const children = Supervisor.getChildren(supervisor);
  return children.length;
}
```

## Part 5: Dead Letter Queue

The Dead Letter Queue stores failed jobs for inspection and manual replay:

```typescript
// src/task-queue/dead-letter-queue.ts
import {
  GenServer,
  Registry,
  type GenServerRef,
} from '@hamicek/noex';
import type { Job } from './types';

interface DLQState {
  jobs: Job[];
  maxSize: number;
}

type DLQCallMsg =
  | { type: 'getJobs'; limit?: number; offset?: number }
  | { type: 'getJob'; jobId: string }
  | { type: 'getCount' }
  | { type: 'removeJob'; jobId: string }
  | { type: 'clear' };

type DLQCallReply =
  | { success: true; jobs: Job[] }
  | { success: true; job: Job | null }
  | { success: true; count: number }
  | { success: true; removed: boolean }
  | { success: true; cleared: number };

type DLQCastMsg =
  | { type: 'addJob'; job: Job };

export const DLQBehavior = {
  init(maxSize: number = 10_000): DLQState {
    console.log('[DeadLetterQueue] initialized');
    return {
      jobs: [],
      maxSize,
    };
  },

  handleCall(msg: DLQCallMsg, state: DLQState): [DLQCallReply, DLQState] {
    switch (msg.type) {
      case 'getJobs': {
        const offset = msg.offset ?? 0;
        const limit = msg.limit ?? 100;
        const jobs = state.jobs.slice(offset, offset + limit);
        return [{ success: true, jobs }, state];
      }

      case 'getJob': {
        const job = state.jobs.find((j) => j.id === msg.jobId) ?? null;
        return [{ success: true, job }, state];
      }

      case 'getCount': {
        return [{ success: true, count: state.jobs.length }, state];
      }

      case 'removeJob': {
        const index = state.jobs.findIndex((j) => j.id === msg.jobId);
        if (index === -1) {
          return [{ success: true, removed: false }, state];
        }

        const newJobs = [...state.jobs];
        newJobs.splice(index, 1);

        console.log(`[DeadLetterQueue] Removed job ${msg.jobId}`);
        return [{ success: true, removed: true }, { ...state, jobs: newJobs }];
      }

      case 'clear': {
        const count = state.jobs.length;
        console.log(`[DeadLetterQueue] Cleared ${count} jobs`);
        return [{ success: true, cleared: count }, { ...state, jobs: [] }];
      }
    }
  },

  handleCast(msg: DLQCastMsg, state: DLQState): DLQState {
    switch (msg.type) {
      case 'addJob': {
        const newJobs = [msg.job, ...state.jobs];

        // Trim if exceeds max size (remove oldest)
        if (newJobs.length > state.maxSize) {
          newJobs.length = state.maxSize;
        }

        console.log(`[DeadLetterQueue] Added job ${msg.job.id} (total: ${newJobs.length})`);
        return { ...state, jobs: newJobs };
      }
    }
  },

  terminate(reason: string, state: DLQState): void {
    console.log(`[DeadLetterQueue] terminated: ${reason}, ${state.jobs.length} jobs lost`);
  },
};

// Start the Dead Letter Queue
export async function startDeadLetterQueue(
  maxSize: number = 10_000
): Promise<GenServerRef> {
  const ref = await GenServer.start<DLQState, DLQCallMsg, DLQCastMsg, DLQCallReply>({
    init: () => DLQBehavior.init(maxSize),
    handleCall: DLQBehavior.handleCall,
    handleCast: DLQBehavior.handleCast,
    terminate: DLQBehavior.terminate,
  });

  Registry.register('dead-letter-queue', ref);
  return ref;
}

// Public API

export async function getDeadJobs(
  dlq: GenServerRef,
  options: { limit?: number; offset?: number } = {}
): Promise<Job[]> {
  const result = await GenServer.call<DLQState, DLQCallMsg, DLQCastMsg, DLQCallReply>(
    dlq,
    { type: 'getJobs', limit: options.limit, offset: options.offset }
  );
  return (result as { success: true; jobs: Job[] }).jobs;
}

export async function getDeadJobCount(dlq: GenServerRef): Promise<number> {
  const result = await GenServer.call(dlq, { type: 'getCount' });
  return (result as { success: true; count: number }).count;
}

export async function replayJob(
  dlq: GenServerRef,
  queue: GenServerRef,
  jobId: string
): Promise<boolean> {
  // Get job from DLQ
  const getResult = await GenServer.call<DLQState, DLQCallMsg, DLQCastMsg, DLQCallReply>(
    dlq,
    { type: 'getJob', jobId }
  );

  const job = (getResult as { success: true; job: Job | null }).job;
  if (!job) return false;

  // Re-enqueue with reset attempts
  const enqueueResult = await GenServer.call(queue, {
    type: 'enqueue',
    job: {
      ...job,
      attempts: 0,
      status: 'pending',
    },
  });

  if ((enqueueResult as { success: boolean }).success) {
    // Remove from DLQ
    await GenServer.call(dlq, { type: 'removeJob', jobId });
    console.log(`[DeadLetterQueue] Replayed job ${jobId}`);
    return true;
  }

  return false;
}
```

## Part 6: Task Queue Application

Bring everything together with the main application:

```typescript
// src/task-queue/task-queue-application.ts
import {
  Application,
  EventBus,
  Supervisor,
  GenServer,
  Registry,
  type ApplicationBehavior,
  type SupervisorRef,
  type GenServerRef,
  type EventBusRef,
} from '@hamicek/noex';
import { startJobQueue, registerHandler, enqueueJob, getQueueStats } from './job-queue';
import { startWorkerPool, scaleUp, getWorkerCount } from './worker-pool';
import { startDeadLetterQueue, getDeadJobs, getDeadJobCount, replayJob } from './dead-letter-queue';
import type { TaskQueueConfig, JobHandler, Job, TaskQueueEvent } from './types';
import { DEFAULT_CONFIG } from './types';

interface TaskQueueState {
  config: TaskQueueConfig;
  eventBus: EventBusRef;
  jobQueue: GenServerRef;
  workerPool: SupervisorRef;
  deadLetterQueue: GenServerRef;
}

export const TaskQueueApplicationBehavior: ApplicationBehavior<
  Partial<TaskQueueConfig>,
  TaskQueueState
> = {
  async start(config) {
    const fullConfig = { ...DEFAULT_CONFIG, ...config };
    console.log('[TaskQueue] Starting...');

    // 1. Start EventBus
    const eventBus = await EventBus.start({ name: 'task-queue-events' });
    console.log('[TaskQueue] EventBus started');

    // 2. Start Dead Letter Queue
    const deadLetterQueue = await startDeadLetterQueue();
    console.log('[TaskQueue] DeadLetterQueue started');

    // 3. Start Job Queue
    const jobQueue = await startJobQueue(eventBus, fullConfig);
    console.log('[TaskQueue] JobQueue started');

    // 4. Start Worker Pool
    const workerPool = await startWorkerPool(jobQueue, fullConfig);
    GenServer.cast(jobQueue, { type: 'setWorkerPool', ref: workerPool });
    console.log('[TaskQueue] WorkerPool started');

    // 5. Create top-level supervisor
    const supervisor = await Supervisor.start({
      strategy: 'one_for_all',
      children: [],
      restartIntensity: {
        maxRestarts: 3,
        withinMs: 60_000,
      },
    });

    console.log('[TaskQueue] Started successfully');

    return {
      supervisor,
      state: {
        config: fullConfig,
        eventBus,
        jobQueue,
        workerPool,
        deadLetterQueue,
      },
    };
  },

  async prepStop(reason, state) {
    console.log(`[TaskQueue] Preparing to stop: ${reason}`);

    // Stop accepting new jobs
    GenServer.cast(state.jobQueue, { type: 'initiateShutdown' });

    // Wait for in-flight jobs to complete
    const stats = await getQueueStats(state.jobQueue);
    if (stats.processing > 0) {
      console.log(`[TaskQueue] Waiting for ${stats.processing} in-flight jobs...`);

      // Poll until processing is 0 or timeout
      const timeout = state.config.shutdownTimeoutMs;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        const currentStats = await getQueueStats(state.jobQueue);
        if (currentStats.processing === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  },

  async stop(reason, state) {
    console.log(`[TaskQueue] Stopping: ${reason}`);

    // Stop in reverse order
    await Supervisor.stop(state.workerPool);
    await GenServer.stop(state.jobQueue);
    await GenServer.stop(state.deadLetterQueue);
    await EventBus.stop(state.eventBus);

    // Cleanup registry
    try {
      Registry.unregister('job-queue');
      Registry.unregister('dead-letter-queue');
    } catch {
      // May already be unregistered
    }

    console.log('[TaskQueue] Stopped');
  },
};

// High-level TaskQueue class
export class TaskQueue {
  private state: TaskQueueState | null = null;
  private supervisor: SupervisorRef | null = null;

  async start(config: Partial<TaskQueueConfig> = {}): Promise<void> {
    const result = await Application.start(TaskQueueApplicationBehavior, config);
    this.supervisor = result.supervisor;
    this.state = result.state;
  }

  async stop(): Promise<void> {
    if (this.state && this.supervisor) {
      await Application.stop(this.supervisor, 'shutdown');
      this.state = null;
      this.supervisor = null;
    }
  }

  registerHandler<TPayload, TResult>(
    jobType: string,
    handler: JobHandler<TPayload, TResult>
  ): void {
    if (!this.state) throw new Error('TaskQueue not started');
    registerHandler(this.state.jobQueue, jobType, handler as JobHandler);
  }

  async enqueue<TPayload>(
    jobType: string,
    payload: TPayload,
    options: {
      priority?: 'critical' | 'high' | 'normal' | 'low';
      maxAttempts?: number;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<string> {
    if (!this.state) throw new Error('TaskQueue not started');
    return enqueueJob(this.state.jobQueue, jobType, payload, options);
  }

  async getStats(): Promise<{
    pending: number;
    processing: number;
    workers: number;
    deadLetterCount: number;
  }> {
    if (!this.state) throw new Error('TaskQueue not started');

    const queueStats = await getQueueStats(this.state.jobQueue);
    const workerCount = getWorkerCount(this.state.workerPool);
    const dlqCount = await getDeadJobCount(this.state.deadLetterQueue);

    return {
      pending: queueStats.pending,
      processing: queueStats.processing,
      workers: workerCount,
      deadLetterCount: dlqCount,
    };
  }

  async scaleWorkers(count: number): Promise<void> {
    if (!this.state) throw new Error('TaskQueue not started');
    await scaleUp(this.state.workerPool, count);
  }

  async getDeadJobs(options: { limit?: number } = {}): Promise<Job[]> {
    if (!this.state) throw new Error('TaskQueue not started');
    return getDeadJobs(this.state.deadLetterQueue, options);
  }

  async replayDeadJob(jobId: string): Promise<boolean> {
    if (!this.state) throw new Error('TaskQueue not started');
    return replayJob(
      this.state.deadLetterQueue,
      this.state.jobQueue,
      jobId
    );
  }

  onJobEvent(
    handler: (event: TaskQueueEvent) => void
  ): () => Promise<void> {
    if (!this.state) throw new Error('TaskQueue not started');

    // Subscribe to all job events
    let unsubscribes: Array<() => Promise<void>> = [];

    (async () => {
      unsubscribes = await Promise.all([
        EventBus.subscribe(this.state!.eventBus, 'job.enqueued', handler),
        EventBus.subscribe(this.state!.eventBus, 'job.started', handler),
        EventBus.subscribe(this.state!.eventBus, 'job.completed', handler),
        EventBus.subscribe(this.state!.eventBus, 'job.failed', handler),
        EventBus.subscribe(this.state!.eventBus, 'job.dead', handler),
      ]);
    })();

    return async () => {
      for (const unsub of unsubscribes) {
        await unsub();
      }
    };
  }

  isRunning(): boolean {
    return this.state !== null;
  }
}
```

## Part 7: Job Flow

Here's how a job flows through the system:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              JOB LIFECYCLE                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Client                                                                     │
│    │                                                                        │
│    ▼ enqueue({ type: 'email', payload: {...}, priority: 'high' })          │
│  ┌──────────────┐                                                           │
│  │  Job Queue   │                                                           │
│  │  GenServer   │──► Insert into priority queue                             │
│  └──────────────┘                                                           │
│    │                                                                        │
│    │ Check: Worker available?                                               │
│    │                                                                        │
│    ├─── YES ───┐                                                            │
│    │           ▼                                                            │
│    │    ┌──────────────┐                                                    │
│    │    │   Worker N   │──► Execute handler(job)                            │
│    │    │  GenServer   │                                                    │
│    │    └──────────────┘                                                    │
│    │           │                                                            │
│    │           ├─── Success ───► jobCompleted ───► EventBus                 │
│    │           │                                                            │
│    │           └─── Failure ───► Check: attempts < maxAttempts?             │
│    │                                    │                                   │
│    │                    ┌─── YES ───────┤                                   │
│    │                    │               │                                   │
│    │                    ▼               ▼ NO                                │
│    │           ┌──────────────┐   ┌──────────────┐                          │
│    │           │  Retry with  │   │ Dead Letter  │                          │
│    │           │  exp backoff │   │    Queue     │                          │
│    │           │  (sendAfter) │   └──────────────┘                          │
│    │           └──────────────┘                                             │
│    │                    │                                                   │
│    │                    ▼ After delay                                       │
│    │           Back to Job Queue (re-dispatch)                              │
│    │                                                                        │
│    └─── NO ────► Wait in priority queue                                     │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  EXPONENTIAL BACKOFF                                                        │
│  ────────────────────                                                       │
│  Attempt 1: baseDelay × 2^0 = 1s + jitter                                   │
│  Attempt 2: baseDelay × 2^1 = 2s + jitter                                   │
│  Attempt 3: baseDelay × 2^2 = 4s + jitter                                   │
│  ...                                                                        │
│  Max delay capped at maxRetryDelayMs (default 60s)                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Part 8: Usage Example

Here's a complete example showing the task queue in action:

```typescript
// src/task-queue/example.ts
import { TaskQueue } from './task-queue-application';

interface EmailPayload {
  to: string;
  subject: string;
  body: string;
}

interface ImagePayload {
  url: string;
  width: number;
  height: number;
}

async function main() {
  const queue = new TaskQueue();

  // Start with custom config
  await queue.start({
    maxWorkers: 5,
    minWorkers: 2,
    defaultMaxAttempts: 3,
    baseRetryDelayMs: 1000,
    jobTimeoutMs: 10_000,
  });

  // Register job handlers
  queue.registerHandler<EmailPayload, { messageId: string }>(
    'send-email',
    async (job) => {
      console.log(`Sending email to ${job.payload.to}: ${job.payload.subject}`);

      // Simulate email sending
      await new Promise((r) => setTimeout(r, 500));

      // Simulate occasional failures for demo
      if (Math.random() < 0.3) {
        throw new Error('SMTP connection failed');
      }

      return { messageId: `msg_${Date.now()}` };
    }
  );

  queue.registerHandler<ImagePayload, { path: string }>(
    'resize-image',
    async (job) => {
      console.log(`Resizing image: ${job.payload.url} to ${job.payload.width}x${job.payload.height}`);

      // Simulate image processing
      await new Promise((r) => setTimeout(r, 1000));

      return { path: `/resized/${Date.now()}.jpg` };
    }
  );

  // Subscribe to job events
  const unsubscribe = queue.onJobEvent((event) => {
    console.log(`[Event] ${event.eventType}: job ${event.jobId}`);
  });

  // Enqueue some jobs
  const emailJobId = await queue.enqueue<EmailPayload>(
    'send-email',
    { to: 'user@example.com', subject: 'Hello', body: 'World' },
    { priority: 'high' }
  );
  console.log(`Enqueued email job: ${emailJobId}`);

  const imageJobId = await queue.enqueue<ImagePayload>(
    'resize-image',
    { url: 'https://example.com/image.jpg', width: 800, height: 600 },
    { priority: 'normal' }
  );
  console.log(`Enqueued image job: ${imageJobId}`);

  // Enqueue batch of low-priority jobs
  for (let i = 0; i < 5; i++) {
    await queue.enqueue<EmailPayload>(
      'send-email',
      { to: `batch${i}@example.com`, subject: `Batch ${i}`, body: 'Batch email' },
      { priority: 'low' }
    );
  }

  // Wait for processing
  await new Promise((r) => setTimeout(r, 5000));

  // Check stats
  const stats = await queue.getStats();
  console.log('\nQueue Stats:', stats);

  // Check dead letter queue
  const deadJobs = await queue.getDeadJobs({ limit: 10 });
  if (deadJobs.length > 0) {
    console.log('\nDead Jobs:', deadJobs.length);
    for (const job of deadJobs) {
      console.log(`  - ${job.id}: ${job.type} (${job.error})`);
    }

    // Replay a dead job
    if (deadJobs.length > 0) {
      const replayed = await queue.replayDeadJob(deadJobs[0].id);
      console.log(`Replayed job: ${replayed}`);
    }
  }

  // Wait more
  await new Promise((r) => setTimeout(r, 3000));

  // Cleanup
  await unsubscribe();

  // Graceful shutdown
  console.log('\nShutting down...');
  await queue.stop();
  console.log('Done!');
}

main().catch(console.error);
```

## Testing the Task Queue

```typescript
// tests/task-queue.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskQueue } from '../src/task-queue/task-queue-application';
import type { TaskQueueEvent, JobCompletedEvent, JobFailedEvent, JobDeadEvent } from '../src/task-queue/types';

describe('TaskQueue', () => {
  let queue: TaskQueue;
  let events: TaskQueueEvent[];

  beforeEach(async () => {
    queue = new TaskQueue();
    events = [];

    await queue.start({
      maxWorkers: 3,
      minWorkers: 1,
      defaultMaxAttempts: 2,
      baseRetryDelayMs: 100, // Fast retries for tests
      maxRetryDelayMs: 500,
      jobTimeoutMs: 5000,
    });

    queue.onJobEvent((event) => {
      events.push(event);
    });
  });

  afterEach(async () => {
    await queue.stop();
  });

  async function waitFor(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  function findEvent<T extends TaskQueueEvent>(
    eventType: T['eventType']
  ): T | undefined {
    return events.find((e) => e.eventType === eventType) as T | undefined;
  }

  it('should process a job successfully', async () => {
    queue.registerHandler<{ value: number }, number>(
      'add-one',
      async (job) => job.payload.value + 1
    );

    const jobId = await queue.enqueue('add-one', { value: 41 });

    await waitFor(200);

    const completed = findEvent<JobCompletedEvent>('job.completed');
    expect(completed).toBeDefined();
    expect(completed!.jobId).toBe(jobId);
    expect(completed!.result).toBe(42);
  });

  it('should retry failed jobs with backoff', async () => {
    let attempts = 0;

    queue.registerHandler<{}, string>('flaky-job', async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error('Temporary failure');
      }
      return 'success';
    });

    await queue.enqueue('flaky-job', {});

    await waitFor(500);

    expect(attempts).toBe(2);

    const failed = findEvent<JobFailedEvent>('job.failed');
    expect(failed).toBeDefined();
    expect(failed!.willRetry).toBe(true);

    const completed = findEvent<JobCompletedEvent>('job.completed');
    expect(completed).toBeDefined();
  });

  it('should move to DLQ after max retries', async () => {
    queue.registerHandler<{}, never>('always-fails', async () => {
      throw new Error('Permanent failure');
    });

    await queue.enqueue('always-fails', {});

    await waitFor(1000); // Wait for retries

    const deadEvent = findEvent<JobDeadEvent>('job.dead');
    expect(deadEvent).toBeDefined();
    expect(deadEvent!.attempts).toBe(2); // maxAttempts = 2

    const stats = await queue.getStats();
    expect(stats.deadLetterCount).toBe(1);
  });

  it('should respect priority ordering', async () => {
    const processed: string[] = [];

    queue.registerHandler<{ name: string }, void>('priority-test', async (job) => {
      processed.push(job.payload.name);
      await waitFor(50);
    });

    // Enqueue in reverse priority order
    await queue.enqueue('priority-test', { name: 'low' }, { priority: 'low' });
    await queue.enqueue('priority-test', { name: 'normal' }, { priority: 'normal' });
    await queue.enqueue('priority-test', { name: 'critical' }, { priority: 'critical' });
    await queue.enqueue('priority-test', { name: 'high' }, { priority: 'high' });

    await waitFor(500);

    // Should process in priority order
    expect(processed[0]).toBe('critical');
    expect(processed[1]).toBe('high');
    expect(processed[2]).toBe('normal');
    expect(processed[3]).toBe('low');
  });

  it('should replay dead jobs', async () => {
    let shouldFail = true;

    queue.registerHandler<{}, string>('replayable', async () => {
      if (shouldFail) {
        throw new Error('First run fails');
      }
      return 'replayed successfully';
    });

    await queue.enqueue('replayable', {}, { maxAttempts: 1 });

    await waitFor(300);

    const deadJobs = await queue.getDeadJobs();
    expect(deadJobs.length).toBe(1);

    // Fix the job for replay
    shouldFail = false;

    const replayed = await queue.replayDeadJob(deadJobs[0].id);
    expect(replayed).toBe(true);

    await waitFor(200);

    const finalStats = await queue.getStats();
    expect(finalStats.deadLetterCount).toBe(0);
  });

  it('should scale workers dynamically', async () => {
    const initialStats = await queue.getStats();
    expect(initialStats.workers).toBe(1); // minWorkers

    await queue.scaleWorkers(2);

    const scaledStats = await queue.getStats();
    expect(scaledStats.workers).toBe(3);
  });

  it('should handle graceful shutdown with in-flight jobs', async () => {
    queue.registerHandler<{}, void>('slow-job', async () => {
      await waitFor(200);
    });

    // Enqueue a job
    await queue.enqueue('slow-job', {});

    // Start shutdown immediately
    const shutdownPromise = queue.stop();

    // Should wait for job to complete
    await shutdownPromise;

    const completed = findEvent<JobCompletedEvent>('job.completed');
    expect(completed).toBeDefined();
  });
});
```

## Exercise: Add Job Dependencies

Enhance the task queue with job dependencies:

**Requirements:**
1. Jobs can specify `dependsOn: string[]` with IDs of jobs that must complete first
2. Dependent jobs wait in a separate "blocked" state until dependencies complete
3. If a dependency fails and goes to DLQ, dependent jobs also fail
4. Add a `{ type: 'getDependents', jobId: string }` call to find jobs waiting on a given job

**Starter code:**

```typescript
// Extend the Job interface
interface Job<TPayload = unknown> {
  // ... existing fields
  dependsOn?: string[];      // IDs of jobs this depends on
  dependents?: string[];     // IDs of jobs waiting on this
}

// Add to JobQueueState
interface JobQueueState {
  // ... existing fields
  blockedJobs: Map<string, Job>;  // Jobs waiting for dependencies
}

// Add to handleCast
case 'jobCompleted': {
  // TODO: Check if any blocked jobs were waiting on this
  // TODO: If all dependencies complete, move to pending queue
}

case 'jobDead': {
  // TODO: Fail all dependent jobs
  // TODO: Move dependents to DLQ with appropriate error
}
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
// Extended Job interface
interface Job<TPayload = unknown> {
  id: string;
  type: string;
  payload: TPayload;
  priority: JobPriority;
  status: JobStatus | 'blocked';  // Add blocked status
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  scheduledAt?: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: unknown;
  metadata?: Record<string, unknown>;
  dependsOn?: string[];           // Jobs this depends on
  dependents?: string[];          // Jobs waiting on this
}

// Extended state
interface JobQueueState {
  // ... existing fields
  blockedJobs: Map<string, Job>;            // Jobs waiting for dependencies
  completedJobResults: Map<string, unknown>; // Cache of completed job results
}

// Extended call messages
type JobQueueCallMsg =
  // ... existing
  | { type: 'getDependents'; jobId: string };

type JobQueueCallReply =
  // ... existing
  | { success: true; dependents: string[] };

// Modified enqueue handling
case 'enqueue': {
  // ... existing validation

  const job: Job = {
    // ... existing fields
    dependsOn: msg.job.dependsOn,
    dependents: [],
  };

  // Check if job has dependencies
  if (job.dependsOn && job.dependsOn.length > 0) {
    const unmetDependencies: string[] = [];

    for (const depId of job.dependsOn) {
      // Check if dependency is already completed
      if (state.completedJobResults.has(depId)) {
        continue; // Dependency already met
      }

      // Check if dependency exists and is pending/processing
      const depJob = state.pendingJobs.find(j => j.id === depId)
        ?? state.processingJobs.get(depId)
        ?? state.blockedJobs.get(depId);

      if (!depJob) {
        return [
          { success: false, error: `Dependency ${depId} not found` },
          state,
        ];
      }

      // Check if dependency failed
      if (depJob.status === 'dead') {
        return [
          { success: false, error: `Dependency ${depId} has failed` },
          state,
        ];
      }

      unmetDependencies.push(depId);

      // Register this job as dependent
      depJob.dependents = depJob.dependents ?? [];
      depJob.dependents.push(job.id);
    }

    // If there are unmet dependencies, block this job
    if (unmetDependencies.length > 0) {
      const blockedJob: Job = {
        ...job,
        status: 'blocked',
        dependsOn: unmetDependencies, // Only track unmet ones
      };

      const newBlockedJobs = new Map(state.blockedJobs);
      newBlockedJobs.set(job.id, blockedJob);

      console.log(`[JobQueue] Job ${job.id} blocked, waiting for: ${unmetDependencies.join(', ')}`);

      return [{ success: true, jobId: job.id }, { ...state, blockedJobs: newBlockedJobs }];
    }
  }

  // No dependencies or all met - proceed normally
  // ... existing enqueue logic
}

// Modified jobCompleted handling
case 'jobCompleted': {
  const job = state.processingJobs.get(msg.jobId);
  if (!job) return state;

  // ... existing completion logic

  // Cache result for dependency tracking
  const newCompletedResults = new Map(state.completedJobResults);
  newCompletedResults.set(msg.jobId, msg.result);

  // Check for dependent jobs that might be unblocked
  let newState = {
    ...state,
    processingJobs: newProcessing,
    completedJobResults: newCompletedResults,
  };

  if (job.dependents && job.dependents.length > 0) {
    newState = checkAndUnblockDependents(job.id, newState);
  }

  return newState;
}

// Check and unblock dependent jobs
function checkAndUnblockDependents(
  completedJobId: string,
  state: JobQueueState
): JobQueueState {
  let newState = { ...state };
  const newBlockedJobs = new Map(state.blockedJobs);
  const jobsToUnblock: Job[] = [];

  for (const [blockedId, blockedJob] of newBlockedJobs) {
    if (!blockedJob.dependsOn?.includes(completedJobId)) continue;

    // Remove completed dependency
    const remainingDeps = blockedJob.dependsOn.filter(d => d !== completedJobId);

    if (remainingDeps.length === 0) {
      // All dependencies met - unblock
      jobsToUnblock.push(blockedJob);
      newBlockedJobs.delete(blockedId);
      console.log(`[JobQueue] Unblocking job ${blockedId} - all dependencies met`);
    } else {
      // Update remaining dependencies
      newBlockedJobs.set(blockedId, {
        ...blockedJob,
        dependsOn: remainingDeps,
      });
    }
  }

  newState = { ...newState, blockedJobs: newBlockedJobs };

  // Move unblocked jobs to pending
  for (const job of jobsToUnblock) {
    const unblockedJob: Job = {
      ...job,
      status: 'pending',
      dependsOn: undefined,
      updatedAt: Date.now(),
    };
    newState = {
      ...newState,
      pendingJobs: insertByPriority(newState.pendingJobs, unblockedJob),
    };
  }

  // Try to dispatch
  return tryDispatchJobs(newState);
}

// Handle failed dependency - fail all dependents
function failDependentJobs(
  failedJobId: string,
  error: string,
  state: JobQueueState
): JobQueueState {
  const failedJob = state.processingJobs.get(failedJobId)
    ?? state.blockedJobs.get(failedJobId);

  if (!failedJob?.dependents || failedJob.dependents.length === 0) {
    return state;
  }

  let newState = { ...state };
  const now = Date.now();

  for (const dependentId of failedJob.dependents) {
    // Find the dependent job (might be blocked or pending)
    const dependent = newState.blockedJobs.get(dependentId)
      ?? newState.pendingJobs.find(j => j.id === dependentId);

    if (!dependent) continue;

    // Create dead job
    const deadJob: Job = {
      ...dependent,
      status: 'dead',
      error: `Dependency ${failedJobId} failed: ${error}`,
      completedAt: now,
      updatedAt: now,
    };

    // Remove from blocked/pending
    const newBlockedJobs = new Map(newState.blockedJobs);
    newBlockedJobs.delete(dependentId);

    const newPendingJobs = newState.pendingJobs.filter(j => j.id !== dependentId);

    newState = {
      ...newState,
      blockedJobs: newBlockedJobs,
      pendingJobs: newPendingJobs,
    };

    // Send to DLQ
    const dlqRef = Registry.whereis('dead-letter-queue');
    if (dlqRef) {
      GenServer.cast(dlqRef, { type: 'addJob', job: deadJob });
    }

    // Publish event
    publishEvent(newState.eventBus, {
      eventType: 'job.dead',
      jobId: dependentId,
      type: dependent.type,
      error: deadJob.error!,
      attempts: dependent.attempts,
      timestamp: now,
    });

    console.log(`[JobQueue] Dependent job ${dependentId} failed due to dependency ${failedJobId}`);

    // Recursively fail dependents of this dependent
    newState = failDependentJobs(dependentId, deadJob.error!, newState);
  }

  return newState;
}

// Add to jobDead case (when moving to DLQ after max retries)
case 'jobFailed': {
  // ... existing failure handling

  if (!willRetry) {
    // Move to DLQ...

    // Also fail all dependent jobs
    newState = failDependentJobs(msg.jobId, msg.error, newState);
  }

  return newState;
}

// Handle getDependents call
case 'getDependents': {
  const job = state.pendingJobs.find(j => j.id === msg.jobId)
    ?? state.processingJobs.get(msg.jobId)
    ?? state.blockedJobs.get(msg.jobId);

  if (!job) {
    return [{ success: true, dependents: [] }, state];
  }

  return [{ success: true, dependents: job.dependents ?? [] }, state];
}

// Usage example
async function example(queue: TaskQueue) {
  // Register handlers
  queue.registerHandler('fetch-data', async (job) => {
    return { data: 'fetched' };
  });

  queue.registerHandler('process-data', async (job) => {
    // This job depends on fetch-data completing first
    return { processed: true };
  });

  // Enqueue parent job
  const fetchJobId = await queue.enqueue('fetch-data', { url: '/api/data' });

  // Enqueue dependent job
  const processJobId = await queue.enqueue(
    'process-data',
    { input: 'data' },
    { dependsOn: [fetchJobId] }  // Will wait for fetch-data to complete
  );

  // process-data will automatically start after fetch-data completes
}
```

**Key design decisions:**

1. **Blocked state** — Jobs with unmet dependencies go to a separate `blockedJobs` map
2. **Completed results cache** — Track completed job IDs to check dependency status
3. **Bidirectional tracking** — Jobs know their dependents for cascading failure handling
4. **Cascading failures** — When a job goes to DLQ, all its dependents also fail
5. **Automatic unblocking** — Dependents automatically move to pending when all dependencies complete

</details>

## Summary

**Key takeaways:**

- **Priority queue with GenServer** — Central coordination with type-safe message passing
- **Worker pool with simple_one_for_one** — Dynamic scaling of homogeneous workers
- **Exponential backoff with sendAfter** — Resilient retry without blocking
- **Dead Letter Queue** — Failed jobs preserved for inspection and replay
- **EventBus for observability** — Decoupled monitoring without affecting job processing
- **Graceful shutdown** — Wait for in-flight jobs before terminating

**Architecture patterns used:**

| Pattern | Where Used |
|---------|------------|
| Priority Queue | Job ordering by importance |
| Worker Pool | Dynamic scaling with supervision |
| Exponential Backoff | Retry delays with jitter |
| Dead Letter Queue | Failed job persistence |
| Pub/Sub | Job lifecycle events |
| Application | System composition |

**Production considerations:**

| Concern | Solution |
|---------|----------|
| Job persistence | Add StorageAdapter to JobQueue for crash recovery |
| Scaling | Increase workers based on queue depth |
| Monitoring | Subscribe to EventBus for metrics (Prometheus, etc.) |
| Rate limiting | Track job throughput per type |
| Deduplication | Add idempotency keys to job metadata |

**What you've learned:**

1. How to design a job processing system with noex
2. Priority-based queue management with GenServer state
3. Dynamic worker pool with `simple_one_for_one` supervision
4. Retry logic with exponential backoff using `sendAfter`
5. Dead letter queue for failed job handling
6. Event-driven observability with EventBus
7. Graceful shutdown with in-flight job completion

> **Architecture insight:** The task queue demonstrates how the actor model naturally handles concurrent job processing. Each worker is isolated, the queue maintains consistent state through sequential message processing, and supervision ensures automatic recovery from failures — all without explicit locking or complex error handling.

---

Next: [API Gateway](./03-api-gateway.md)
