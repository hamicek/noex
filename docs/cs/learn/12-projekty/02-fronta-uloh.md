# Fronta úloh

V tomto projektu vytvoříte produkčně připravenou frontu úloh, která demonstruje, jak noex elegantně zvládá zpracování úloh na pozadí, správu worker poolu a odolnost vůči chybám. Na rozdíl od tradičních Node.js front úloh, které se spoléhají na externí služby, tato implementace využívá actor model pro elegantní kontrolu souběžnosti a automatické zotavení z chyb.

## Co se naučíte

- Navrhnout systém zpracování úloh pomocí GenServer, Supervisor a EventBus
- Implementovat worker pool s dynamickou supervizí `simple_one_for_one`
- Vytvořit logiku opakování s exponenciálním backoffem pomocí `sendAfter`
- Vytvořit dead letter queue pro neúspěšné úlohy
- Zvládnout backpressure a rate limiting
- Implementovat graceful shutdown s dokončením rozpracovaných úloh

## Co vytvoříte

Frontu úloh s:
- **Job Queue** — Prioritní plánování úloh s perzistencí
- **Worker Pool** — Dynamický pool workerů škálující podle zátěže
- **Logika opakování** — Exponenciální backoff s konfigurovatelným maximem pokusů
- **Dead Letter Queue** — Neúspěšné úlohy uloženy pro inspekci a přehrání
- **Sledování stavu úloh** — Real-time stav přes EventBus

## Přehled architektury

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       ARCHITEKTURA FRONTY ÚLOH                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                  Supervisor aplikace fronty úloh                    │    │
│  │                          (one_for_all)                              │    │
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
│                            (publikuje události úloh)                        │
│                                                                             │
│  Tok úlohy:                                                                 │
│  1. Klient zařadí úlohu → Job Queue                                         │
│  2. Job Queue odešle → Dostupnému Workeru                                   │
│  3. Worker zpracuje → Úspěch/Selhání                                        │
│  4. Selhání → Opakování s backoffem NEBO Dead Letter Queue                  │
│  5. Všechny přechody → Notifikace přes EventBus                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Odpovědnosti komponent:**

| Komponenta | Role |
|-----------|------|
| **Task Queue Supervisor** | Top-level supervisor zajišťující konzistenci systému |
| **Job Queue** | Ukládá úlohy, spravuje prioritní frontu, odesílá workerům |
| **Worker Pool Supervisor** | Spravuje dynamické instance workerů s `simple_one_for_one` |
| **Worker** | Vykonává jednotlivé úlohy, reportuje výsledky |
| **Dead Letter Queue** | Ukládá neúspěšné úlohy po vyčerpání pokusů |
| **EventBus** | Publikuje události životního cyklu úloh pro externí pozorovatele |

## Část 1: Protokol úloh

Nejprve definujte strukturu úlohy a související typy:

```typescript
// src/task-queue/types.ts
import type { GenServerRef } from '@hamicek/noex';

// Úrovně priority úloh
export type JobPriority = 'critical' | 'high' | 'normal' | 'low';

// Stav úlohy v průběhu životního cyklu
export type JobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'dead';

// Základní definice úlohy
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
  scheduledAt?: number; // Pro zpožděné úlohy
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: unknown;
  metadata?: Record<string, unknown>;
}

// Signatura funkce handleru úlohy
export type JobHandler<TPayload = unknown, TResult = unknown> = (
  job: Job<TPayload>
) => Promise<TResult>;

// Registr handlerů úloh podle typu
export type JobHandlerRegistry = Map<string, JobHandler>;

// Váhy priorit pro řazení fronty
export const PRIORITY_WEIGHTS: Record<JobPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

// Události Job Queue publikované do EventBus
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

// Konfigurace
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

## Část 2: Job Queue GenServer

Job Queue spravuje prioritní frontu, odesílá úlohy workerům a zpracovává opakování:

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

// Interní stav
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

// Call zprávy (request/response)
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

// Cast zprávy (fire-and-forget)
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

// Generování unikátního ID úlohy
function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// Výpočet exponenciálního backoff zpoždění
function calculateRetryDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number
): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 0.2 * exponentialDelay; // 20% jitter
  return Math.min(exponentialDelay + jitter, maxDelay);
}

// Vložení úlohy se zachováním pořadí priorit
function insertByPriority(jobs: Job[], job: Job): Job[] {
  const newJobs = [...jobs];
  const jobWeight = PRIORITY_WEIGHTS[job.priority];

  // Najít místo pro vložení
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
    console.log('[JobQueue] inicializován');
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
          return [{ success: false, error: 'Fronta se vypíná' }, state];
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

        // Zkontrolovat, zda existuje handler pro tento typ úlohy
        if (!state.handlers.has(job.type)) {
          return [
            { success: false, error: `Žádný handler registrován pro typ úlohy: ${job.type}` },
            state,
          ];
        }

        // Vložit do prioritní fronty
        const newPendingJobs = insertByPriority(state.pendingJobs, job);

        // Publikovat událost
        publishEvent(state.eventBus, {
          eventType: 'job.enqueued',
          jobId: job.id,
          type: job.type,
          priority: job.priority,
          timestamp: now,
        });

        console.log(`[JobQueue] Zařazena úloha ${jobId} (${job.type}, priorita: ${job.priority})`);

        // Pokusit se okamžitě odeslat
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
        // Zkontrolovat čekající
        const pendingIndex = state.pendingJobs.findIndex((j) => j.id === msg.jobId);
        if (pendingIndex !== -1) {
          const newPendingJobs = [...state.pendingJobs];
          newPendingJobs.splice(pendingIndex, 1);

          // Zrušit retry timer pokud existuje
          const timer = state.retryTimers.get(msg.jobId);
          if (timer) {
            GenServer.cancelTimer(timer);
            state.retryTimers.delete(msg.jobId);
          }

          console.log(`[JobQueue] Zrušena úloha ${msg.jobId}`);
          return [{ success: true, cancelled: true }, { ...state, pendingJobs: newPendingJobs }];
        }

        // Nelze zrušit zpracovávané úlohy
        if (state.processingJobs.has(msg.jobId)) {
          return [{ success: false, error: 'Nelze zrušit úlohu, která se právě zpracovává' }, state];
        }

        return [{ success: true, cancelled: false }, state];
      }
    }
  },

  handleCast(msg: JobQueueCastMsg, state: JobQueueState): JobQueueState {
    switch (msg.type) {
      case 'registerHandler': {
        state.handlers.set(msg.jobType, msg.handler);
        console.log(`[JobQueue] Registrován handler pro typ úlohy: ${msg.jobType}`);
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

        // Aktualizovat stav úlohy
        const completedJob: Job = {
          ...job,
          status: 'completed',
          result: msg.result,
          completedAt: now,
          updatedAt: now,
        };

        // Odebrat ze zpracovávaných
        const newProcessing = new Map(state.processingJobs);
        newProcessing.delete(msg.jobId);

        // Publikovat událost
        publishEvent(state.eventBus, {
          eventType: 'job.completed',
          jobId: msg.jobId,
          type: job.type,
          workerId: msg.workerId,
          result: msg.result,
          duration,
          timestamp: now,
        });

        console.log(`[JobQueue] Úloha ${msg.jobId} dokončena za ${duration}ms`);

        return { ...state, processingJobs: newProcessing };
      }

      case 'jobFailed': {
        const job = state.processingJobs.get(msg.jobId);
        if (!job) return state;

        const now = Date.now();
        const willRetry = job.attempts < job.maxAttempts;

        // Odebrat ze zpracovávaných
        const newProcessing = new Map(state.processingJobs);
        newProcessing.delete(msg.jobId);

        let newState = { ...state, processingJobs: newProcessing };

        if (willRetry) {
          // Vypočítat retry delay s exponenciálním backoffem
          const delay = calculateRetryDelay(
            job.attempts,
            state.config.baseRetryDelayMs,
            state.config.maxRetryDelayMs
          );

          // Naplánovat retry
          const queueRef = Registry.whereis('job-queue');
          if (queueRef) {
            const timerRef = GenServer.sendAfter(
              queueRef,
              { type: 'retryJob', jobId: msg.jobId },
              delay
            );

            const newRetryTimers = new Map(state.retryTimers);
            newRetryTimers.set(msg.jobId, timerRef);

            // Znovu přidat úlohu do čekajících s aktualizovaným počtem pokusů
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

          // Publikovat retry událost
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
            `[JobQueue] Úloha ${msg.jobId} selhala (pokus ${job.attempts}/${job.maxAttempts}), opakování za ${delay}ms`
          );
        } else {
          // Přesunout do dead letter queue
          const deadJob: Job = {
            ...job,
            status: 'dead',
            error: msg.error,
            completedAt: now,
            updatedAt: now,
          };

          // Odeslat do DLQ
          const dlqRef = Registry.whereis('dead-letter-queue');
          if (dlqRef) {
            GenServer.cast(dlqRef, { type: 'addJob', job: deadJob });
          }

          // Publikovat dead událost
          publishEvent(state.eventBus, {
            eventType: 'job.dead',
            jobId: msg.jobId,
            type: job.type,
            error: msg.error,
            attempts: job.attempts,
            timestamp: now,
          });

          console.log(
            `[JobQueue] Úloha ${msg.jobId} přesunuta do dead letter queue po ${job.attempts} pokusech`
          );
        }

        return newState;
      }

      case 'retryJob': {
        // Vyčistit retry timer
        const newRetryTimers = new Map(state.retryTimers);
        newRetryTimers.delete(msg.jobId);

        // Najít úlohu v čekajících a zkontrolovat, zda je připravena
        const jobIndex = state.pendingJobs.findIndex((j) => j.id === msg.jobId);
        if (jobIndex === -1) {
          return { ...state, retryTimers: newRetryTimers };
        }

        const job = state.pendingJobs[jobIndex];
        const now = Date.now();

        // Zkontrolovat, zda uplynul naplánovaný čas
        if (job.scheduledAt && job.scheduledAt > now) {
          return { ...state, retryTimers: newRetryTimers };
        }

        // Vyčistit scheduledAt a pokusit se odeslat
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
        console.log('[JobQueue] Zahajuji graceful shutdown');

        // Zrušit všechny retry timery
        for (const [, timer] of state.retryTimers) {
          GenServer.cancelTimer(timer);
        }

        return { ...state, isShuttingDown: true, retryTimers: new Map() };
      }
    }
  },

  terminate(reason: string, state: JobQueueState): void {
    console.log(`[JobQueue] ukončen: ${reason}`);

    // Zrušit všechny retry timery
    for (const [, timer] of state.retryTimers) {
      GenServer.cancelTimer(timer);
    }
  },
};

// Pokusit se odeslat čekající úlohy dostupným workerům
function tryDispatchJobs(state: JobQueueState): JobQueueState {
  if (state.isShuttingDown || state.availableWorkers.size === 0 || state.pendingJobs.length === 0) {
    return state;
  }

  let newState = { ...state };
  const now = Date.now();

  // Najít odeslatelné úlohy (ne naplánované do budoucnosti)
  for (const job of state.pendingJobs) {
    if (newState.availableWorkers.size === 0) break;

    // Přeskočit úlohy naplánované do budoucnosti
    if (job.scheduledAt && job.scheduledAt > now) {
      continue;
    }

    // Získat dostupného workera
    const workerId = newState.availableWorkers.values().next().value;
    if (!workerId) break;

    // Zkontrolovat, zda existuje handler
    const handler = newState.handlers.get(job.type);
    if (!handler) continue;

    // Označit workera jako zaneprázdněného
    const newAvailable = new Set(newState.availableWorkers);
    newAvailable.delete(workerId);

    // Přesunout úlohu do zpracování
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

    // Odeslat workerovi
    const workerRef = Registry.whereis(workerId);
    if (workerRef) {
      GenServer.cast(workerRef, {
        type: 'processJob',
        job: updatedJob,
        handler,
      });

      // Publikovat started událost
      publishEvent(newState.eventBus, {
        eventType: 'job.started',
        jobId: job.id,
        type: job.type,
        workerId,
        attempt: updatedJob.attempts,
        timestamp: now,
      });

      console.log(`[JobQueue] Odeslána úloha ${job.id} do ${workerId} (pokus ${updatedJob.attempts})`);
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

// Publikovat událost do EventBus
function publishEvent(eventBus: EventBusRef, event: TaskQueueEvent): void {
  EventBus.publish(eventBus, event.eventType, event);
}

// Spustit Job Queue
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

// Veřejné API

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

## Část 3: Worker GenServer

Každý worker zpracovává jednu úlohu najednou a reportuje výsledky zpět do fronty:

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
    console.log(`[Worker:${workerId}] inicializován`);

    // Oznámit frontě, že jsme k dispozici
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

        console.log(`[Worker:${state.workerId}] Zpracovávám úlohu ${job.id}`);

        // Oznámit frontě, že jsme zaneprázdnění
        GenServer.cast(state.queueRef, {
          type: 'workerBusy',
          workerId: state.workerId,
        });

        // Nastavit timeout
        const workerRef = Registry.whereis(state.workerId);
        const timeoutTimer = workerRef
          ? GenServer.sendAfter(
              workerRef,
              { type: 'jobTimeout' },
              state.config.jobTimeoutMs
            )
          : null;

        // Spustit úlohu asynchronně
        executeJob(job, handler, state.workerId, state.queueRef, state.config);

        return {
          ...state,
          currentJob: job,
          timeoutTimer,
        };
      }

      case 'jobTimeout': {
        if (!state.currentJob) return state;

        console.log(`[Worker:${state.workerId}] Úloha ${state.currentJob.id} vypršela`);

        // Reportovat selhání
        GenServer.cast(state.queueRef, {
          type: 'jobFailed',
          jobId: state.currentJob.id,
          workerId: state.workerId,
          error: `Úloha vypršela po ${state.config.jobTimeoutMs}ms`,
        });

        // Označit jako znovu k dispozici
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
        console.log(`[Worker:${state.workerId}] Vypínám se`);

        // Zrušit timeout pokud běží
        if (state.timeoutTimer) {
          GenServer.cancelTimer(state.timeoutTimer);
        }

        return state;
      }
    }
  },

  terminate(reason: string, state: WorkerState): void {
    console.log(`[Worker:${state.workerId}] ukončen: ${reason}`);

    // Zrušit timeout timer
    if (state.timeoutTimer) {
      GenServer.cancelTimer(state.timeoutTimer);
    }
  },
};

// Spustit úlohu a reportovat výsledek
async function executeJob(
  job: Job,
  handler: JobHandler,
  workerId: string,
  queueRef: GenServerRef,
  config: TaskQueueConfig
): Promise<void> {
  try {
    const result = await handler(job);

    // Zrušit timeout a reportovat úspěch
    const workerRef = Registry.whereis(workerId);
    if (workerRef) {
      // Vyčistit stav aktuální úlohy
      GenServer.cast(workerRef, { type: 'jobTimeout' }); // Znovu použít pro vyčištění stavu
    }

    GenServer.cast(queueRef, {
      type: 'jobCompleted',
      jobId: job.id,
      workerId,
      result,
    });

    // Označit workera jako k dispozici
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

    // Označit workera jako k dispozici
    GenServer.cast(queueRef, {
      type: 'workerAvailable',
      workerId,
    });
  }
}

// Spustit workera
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

  // Registrovat pro vyhledávání
  Registry.register(workerId, ref);

  return ref;
}
```

## Část 4: Worker Pool Supervisor

Worker Pool Supervisor spravuje dynamické workery pomocí `simple_one_for_one`:

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

// Spustit Worker Pool Supervisor
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
      restart: 'transient', // Restartovat pouze při abnormálním ukončení
      shutdownTimeout: config.shutdownTimeoutMs,
    },
    restartIntensity: {
      maxRestarts: 10,
      withinMs: 60_000,
    },
  });

  // Spustit počáteční workery
  for (let i = 0; i < config.minWorkers; i++) {
    await Supervisor.startChild(supervisor, []);
  }

  console.log(`[WorkerPool] Spuštěn s ${config.minWorkers} workery`);
  return supervisor;
}

// Škálovat nahoru workery
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

  console.log(`[WorkerPool] Zvětšen o ${refs.length} workerů`);
  return refs;
}

// Získat počet workerů
export function getWorkerCount(supervisor: SupervisorRef): number {
  const children = Supervisor.getChildren(supervisor);
  return children.length;
}
```

## Část 5: Dead Letter Queue

Dead Letter Queue ukládá neúspěšné úlohy pro inspekci a manuální přehrání:

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
    console.log('[DeadLetterQueue] inicializován');
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

        console.log(`[DeadLetterQueue] Odebrána úloha ${msg.jobId}`);
        return [{ success: true, removed: true }, { ...state, jobs: newJobs }];
      }

      case 'clear': {
        const count = state.jobs.length;
        console.log(`[DeadLetterQueue] Vyčištěno ${count} úloh`);
        return [{ success: true, cleared: count }, { ...state, jobs: [] }];
      }
    }
  },

  handleCast(msg: DLQCastMsg, state: DLQState): DLQState {
    switch (msg.type) {
      case 'addJob': {
        const newJobs = [msg.job, ...state.jobs];

        // Oříznout pokud překračuje max size (odebrat nejstarší)
        if (newJobs.length > state.maxSize) {
          newJobs.length = state.maxSize;
        }

        console.log(`[DeadLetterQueue] Přidána úloha ${msg.job.id} (celkem: ${newJobs.length})`);
        return { ...state, jobs: newJobs };
      }
    }
  },

  terminate(reason: string, state: DLQState): void {
    console.log(`[DeadLetterQueue] ukončen: ${reason}, ${state.jobs.length} úloh ztraceno`);
  },
};

// Spustit Dead Letter Queue
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

// Veřejné API

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
  // Získat úlohu z DLQ
  const getResult = await GenServer.call<DLQState, DLQCallMsg, DLQCastMsg, DLQCallReply>(
    dlq,
    { type: 'getJob', jobId }
  );

  const job = (getResult as { success: true; job: Job | null }).job;
  if (!job) return false;

  // Znovu zařadit s resetovanými pokusy
  const enqueueResult = await GenServer.call(queue, {
    type: 'enqueue',
    job: {
      ...job,
      attempts: 0,
      status: 'pending',
    },
  });

  if ((enqueueResult as { success: boolean }).success) {
    // Odebrat z DLQ
    await GenServer.call(dlq, { type: 'removeJob', jobId });
    console.log(`[DeadLetterQueue] Přehrána úloha ${jobId}`);
    return true;
  }

  return false;
}
```

## Část 6: Aplikace fronty úloh

Spojte vše dohromady s hlavní aplikací:

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
    console.log('[TaskQueue] Spouštím...');

    // 1. Spustit EventBus
    const eventBus = await EventBus.start({ name: 'task-queue-events' });
    console.log('[TaskQueue] EventBus spuštěn');

    // 2. Spustit Dead Letter Queue
    const deadLetterQueue = await startDeadLetterQueue();
    console.log('[TaskQueue] DeadLetterQueue spuštěn');

    // 3. Spustit Job Queue
    const jobQueue = await startJobQueue(eventBus, fullConfig);
    console.log('[TaskQueue] JobQueue spuštěn');

    // 4. Spustit Worker Pool
    const workerPool = await startWorkerPool(jobQueue, fullConfig);
    GenServer.cast(jobQueue, { type: 'setWorkerPool', ref: workerPool });
    console.log('[TaskQueue] WorkerPool spuštěn');

    // 5. Vytvořit top-level supervisor
    const supervisor = await Supervisor.start({
      strategy: 'one_for_all',
      children: [],
      restartIntensity: {
        maxRestarts: 3,
        withinMs: 60_000,
      },
    });

    console.log('[TaskQueue] Úspěšně spuštěn');

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
    console.log(`[TaskQueue] Připravuji se na zastavení: ${reason}`);

    // Přestat přijímat nové úlohy
    GenServer.cast(state.jobQueue, { type: 'initiateShutdown' });

    // Počkat na dokončení rozpracovaných úloh
    const stats = await getQueueStats(state.jobQueue);
    if (stats.processing > 0) {
      console.log(`[TaskQueue] Čekám na ${stats.processing} rozpracovaných úloh...`);

      // Dotazovat se dokud processing není 0 nebo nevyprší timeout
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
    console.log(`[TaskQueue] Zastavuji: ${reason}`);

    // Zastavit v opačném pořadí
    await Supervisor.stop(state.workerPool);
    await GenServer.stop(state.jobQueue);
    await GenServer.stop(state.deadLetterQueue);
    await EventBus.stop(state.eventBus);

    // Vyčistit registry
    try {
      Registry.unregister('job-queue');
      Registry.unregister('dead-letter-queue');
    } catch {
      // Může být již odregistrováno
    }

    console.log('[TaskQueue] Zastaven');
  },
};

// High-level TaskQueue třída
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
    if (!this.state) throw new Error('TaskQueue není spuštěn');
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
    if (!this.state) throw new Error('TaskQueue není spuštěn');
    return enqueueJob(this.state.jobQueue, jobType, payload, options);
  }

  async getStats(): Promise<{
    pending: number;
    processing: number;
    workers: number;
    deadLetterCount: number;
  }> {
    if (!this.state) throw new Error('TaskQueue není spuštěn');

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
    if (!this.state) throw new Error('TaskQueue není spuštěn');
    await scaleUp(this.state.workerPool, count);
  }

  async getDeadJobs(options: { limit?: number } = {}): Promise<Job[]> {
    if (!this.state) throw new Error('TaskQueue není spuštěn');
    return getDeadJobs(this.state.deadLetterQueue, options);
  }

  async replayDeadJob(jobId: string): Promise<boolean> {
    if (!this.state) throw new Error('TaskQueue není spuštěn');
    return replayJob(
      this.state.deadLetterQueue,
      this.state.jobQueue,
      jobId
    );
  }

  onJobEvent(
    handler: (event: TaskQueueEvent) => void
  ): () => Promise<void> {
    if (!this.state) throw new Error('TaskQueue není spuštěn');

    // Přihlásit se k odběru všech událostí úloh
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

## Část 7: Tok úlohy

Takto úloha prochází systémem:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ŽIVOTNÍ CYKLUS ÚLOHY                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Klient                                                                     │
│    │                                                                        │
│    ▼ enqueue({ type: 'email', payload: {...}, priority: 'high' })          │
│  ┌──────────────┐                                                           │
│  │  Job Queue   │                                                           │
│  │  GenServer   │──► Vložit do prioritní fronty                             │
│  └──────────────┘                                                           │
│    │                                                                        │
│    │ Kontrola: Worker k dispozici?                                          │
│    │                                                                        │
│    ├─── ANO ────┐                                                           │
│    │            ▼                                                           │
│    │    ┌──────────────┐                                                    │
│    │    │   Worker N   │──► Spustit handler(job)                            │
│    │    │  GenServer   │                                                    │
│    │    └──────────────┘                                                    │
│    │           │                                                            │
│    │           ├─── Úspěch ────► jobCompleted ───► EventBus                 │
│    │           │                                                            │
│    │           └─── Selhání ───► Kontrola: attempts < maxAttempts?          │
│    │                                    │                                   │
│    │                    ┌─── ANO ───────┤                                   │
│    │                    │               │                                   │
│    │                    ▼               ▼ NE                                │
│    │           ┌──────────────┐   ┌──────────────┐                          │
│    │           │ Opakování s  │   │ Dead Letter  │                          │
│    │           │ exp backoff  │   │    Queue     │                          │
│    │           │ (sendAfter)  │   └──────────────┘                          │
│    │           └──────────────┘                                             │
│    │                    │                                                   │
│    │                    ▼ Po zpoždění                                       │
│    │           Zpět do Job Queue (znovu odeslat)                            │
│    │                                                                        │
│    └─── NE ────► Čekat v prioritní frontě                                   │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  EXPONENCIÁLNÍ BACKOFF                                                      │
│  ────────────────────                                                       │
│  Pokus 1: baseDelay × 2^0 = 1s + jitter                                     │
│  Pokus 2: baseDelay × 2^1 = 2s + jitter                                     │
│  Pokus 3: baseDelay × 2^2 = 4s + jitter                                     │
│  ...                                                                        │
│  Max zpoždění omezeno na maxRetryDelayMs (výchozí 60s)                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Část 8: Příklad použití

Zde je kompletní příklad ukazující frontu úloh v akci:

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

  // Spustit s vlastní konfigurací
  await queue.start({
    maxWorkers: 5,
    minWorkers: 2,
    defaultMaxAttempts: 3,
    baseRetryDelayMs: 1000,
    jobTimeoutMs: 10_000,
  });

  // Registrovat handlery úloh
  queue.registerHandler<EmailPayload, { messageId: string }>(
    'send-email',
    async (job) => {
      console.log(`Odesílám email na ${job.payload.to}: ${job.payload.subject}`);

      // Simulovat odesílání emailu
      await new Promise((r) => setTimeout(r, 500));

      // Simulovat občasná selhání pro demo
      if (Math.random() < 0.3) {
        throw new Error('SMTP připojení selhalo');
      }

      return { messageId: `msg_${Date.now()}` };
    }
  );

  queue.registerHandler<ImagePayload, { path: string }>(
    'resize-image',
    async (job) => {
      console.log(`Měním velikost obrázku: ${job.payload.url} na ${job.payload.width}x${job.payload.height}`);

      // Simulovat zpracování obrázku
      await new Promise((r) => setTimeout(r, 1000));

      return { path: `/resized/${Date.now()}.jpg` };
    }
  );

  // Přihlásit se k odběru událostí úloh
  const unsubscribe = queue.onJobEvent((event) => {
    console.log(`[Událost] ${event.eventType}: úloha ${event.jobId}`);
  });

  // Zařadit několik úloh
  const emailJobId = await queue.enqueue<EmailPayload>(
    'send-email',
    { to: 'user@example.com', subject: 'Ahoj', body: 'Světe' },
    { priority: 'high' }
  );
  console.log(`Zařazena email úloha: ${emailJobId}`);

  const imageJobId = await queue.enqueue<ImagePayload>(
    'resize-image',
    { url: 'https://example.com/image.jpg', width: 800, height: 600 },
    { priority: 'normal' }
  );
  console.log(`Zařazena image úloha: ${imageJobId}`);

  // Zařadit dávku úloh s nízkou prioritou
  for (let i = 0; i < 5; i++) {
    await queue.enqueue<EmailPayload>(
      'send-email',
      { to: `batch${i}@example.com`, subject: `Dávka ${i}`, body: 'Dávkový email' },
      { priority: 'low' }
    );
  }

  // Počkat na zpracování
  await new Promise((r) => setTimeout(r, 5000));

  // Zkontrolovat statistiky
  const stats = await queue.getStats();
  console.log('\nStatistiky fronty:', stats);

  // Zkontrolovat dead letter queue
  const deadJobs = await queue.getDeadJobs({ limit: 10 });
  if (deadJobs.length > 0) {
    console.log('\nMrtvé úlohy:', deadJobs.length);
    for (const job of deadJobs) {
      console.log(`  - ${job.id}: ${job.type} (${job.error})`);
    }

    // Přehrát mrtvou úlohu
    if (deadJobs.length > 0) {
      const replayed = await queue.replayDeadJob(deadJobs[0].id);
      console.log(`Přehrána úloha: ${replayed}`);
    }
  }

  // Počkat déle
  await new Promise((r) => setTimeout(r, 3000));

  // Úklid
  await unsubscribe();

  // Graceful shutdown
  console.log('\nVypínám...');
  await queue.stop();
  console.log('Hotovo!');
}

main().catch(console.error);
```

## Testování fronty úloh

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
      baseRetryDelayMs: 100, // Rychlá opakování pro testy
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

  it('měl by úspěšně zpracovat úlohu', async () => {
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

  it('měl by opakovat neúspěšné úlohy s backoffem', async () => {
    let attempts = 0;

    queue.registerHandler<{}, string>('flaky-job', async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error('Dočasné selhání');
      }
      return 'úspěch';
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

  it('měl by přesunout do DLQ po max opakováních', async () => {
    queue.registerHandler<{}, never>('always-fails', async () => {
      throw new Error('Permanentní selhání');
    });

    await queue.enqueue('always-fails', {});

    await waitFor(1000); // Počkat na opakování

    const deadEvent = findEvent<JobDeadEvent>('job.dead');
    expect(deadEvent).toBeDefined();
    expect(deadEvent!.attempts).toBe(2); // maxAttempts = 2

    const stats = await queue.getStats();
    expect(stats.deadLetterCount).toBe(1);
  });

  it('měl by respektovat pořadí priorit', async () => {
    const processed: string[] = [];

    queue.registerHandler<{ name: string }, void>('priority-test', async (job) => {
      processed.push(job.payload.name);
      await waitFor(50);
    });

    // Zařadit v opačném pořadí priorit
    await queue.enqueue('priority-test', { name: 'low' }, { priority: 'low' });
    await queue.enqueue('priority-test', { name: 'normal' }, { priority: 'normal' });
    await queue.enqueue('priority-test', { name: 'critical' }, { priority: 'critical' });
    await queue.enqueue('priority-test', { name: 'high' }, { priority: 'high' });

    await waitFor(500);

    // Měl by zpracovat v pořadí priorit
    expect(processed[0]).toBe('critical');
    expect(processed[1]).toBe('high');
    expect(processed[2]).toBe('normal');
    expect(processed[3]).toBe('low');
  });

  it('měl by přehrát mrtvé úlohy', async () => {
    let shouldFail = true;

    queue.registerHandler<{}, string>('replayable', async () => {
      if (shouldFail) {
        throw new Error('První běh selže');
      }
      return 'úspěšně přehráno';
    });

    await queue.enqueue('replayable', {}, { maxAttempts: 1 });

    await waitFor(300);

    const deadJobs = await queue.getDeadJobs();
    expect(deadJobs.length).toBe(1);

    // Opravit úlohu pro přehrání
    shouldFail = false;

    const replayed = await queue.replayDeadJob(deadJobs[0].id);
    expect(replayed).toBe(true);

    await waitFor(200);

    const finalStats = await queue.getStats();
    expect(finalStats.deadLetterCount).toBe(0);
  });

  it('měl by dynamicky škálovat workery', async () => {
    const initialStats = await queue.getStats();
    expect(initialStats.workers).toBe(1); // minWorkers

    await queue.scaleWorkers(2);

    const scaledStats = await queue.getStats();
    expect(scaledStats.workers).toBe(3);
  });

  it('měl by zvládnout graceful shutdown s rozpracovanými úlohami', async () => {
    queue.registerHandler<{}, void>('slow-job', async () => {
      await waitFor(200);
    });

    // Zařadit úlohu
    await queue.enqueue('slow-job', {});

    // Okamžitě zahájit shutdown
    const shutdownPromise = queue.stop();

    // Měl by počkat na dokončení úlohy
    await shutdownPromise;

    const completed = findEvent<JobCompletedEvent>('job.completed');
    expect(completed).toBeDefined();
  });
});
```

## Cvičení: Přidat závislosti úloh

Rozšiřte frontu úloh o závislosti úloh:

**Požadavky:**
1. Úlohy mohou specifikovat `dependsOn: string[]` s ID úloh, které musí být nejprve dokončeny
2. Závislé úlohy čekají v samostatném stavu "blocked" dokud se závislosti nedokončí
3. Pokud závislost selže a přejde do DLQ, závislé úlohy také selžou
4. Přidat volání `{ type: 'getDependents', jobId: string }` pro nalezení úloh čekajících na danou úlohu

**Výchozí kód:**

```typescript
// Rozšířit Job interface
interface Job<TPayload = unknown> {
  // ... existující pole
  dependsOn?: string[];      // ID úloh, na kterých závisí
  dependents?: string[];     // ID úloh čekajících na tuto
}

// Přidat do JobQueueState
interface JobQueueState {
  // ... existující pole
  blockedJobs: Map<string, Job>;  // Úlohy čekající na závislosti
}

// Přidat do handleCast
case 'jobCompleted': {
  // TODO: Zkontrolovat, zda nějaké blokované úlohy čekaly na tuto
  // TODO: Pokud jsou všechny závislosti dokončeny, přesunout do čekající fronty
}

case 'jobDead': {
  // TODO: Selhat všechny závislé úlohy
  // TODO: Přesunout závislé do DLQ s odpovídající chybou
}
```

<details>
<summary><strong>Řešení</strong></summary>

```typescript
// Rozšířené Job interface
interface Job<TPayload = unknown> {
  id: string;
  type: string;
  payload: TPayload;
  priority: JobPriority;
  status: JobStatus | 'blocked';  // Přidat blocked stav
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
  dependsOn?: string[];           // Úlohy, na kterých závisí
  dependents?: string[];          // Úlohy čekající na tuto
}

// Rozšířený stav
interface JobQueueState {
  // ... existující pole
  blockedJobs: Map<string, Job>;            // Úlohy čekající na závislosti
  completedJobResults: Map<string, unknown>; // Cache výsledků dokončených úloh
}

// Rozšířené call zprávy
type JobQueueCallMsg =
  // ... existující
  | { type: 'getDependents'; jobId: string };

type JobQueueCallReply =
  // ... existující
  | { success: true; dependents: string[] };

// Upravené zpracování enqueue
case 'enqueue': {
  // ... existující validace

  const job: Job = {
    // ... existující pole
    dependsOn: msg.job.dependsOn,
    dependents: [],
  };

  // Zkontrolovat, zda má úloha závislosti
  if (job.dependsOn && job.dependsOn.length > 0) {
    const unmetDependencies: string[] = [];

    for (const depId of job.dependsOn) {
      // Zkontrolovat, zda je závislost již dokončena
      if (state.completedJobResults.has(depId)) {
        continue; // Závislost již splněna
      }

      // Zkontrolovat, zda závislost existuje a je pending/processing
      const depJob = state.pendingJobs.find(j => j.id === depId)
        ?? state.processingJobs.get(depId)
        ?? state.blockedJobs.get(depId);

      if (!depJob) {
        return [
          { success: false, error: `Závislost ${depId} nenalezena` },
          state,
        ];
      }

      // Zkontrolovat, zda závislost selhala
      if (depJob.status === 'dead') {
        return [
          { success: false, error: `Závislost ${depId} selhala` },
          state,
        ];
      }

      unmetDependencies.push(depId);

      // Registrovat tuto úlohu jako závislou
      depJob.dependents = depJob.dependents ?? [];
      depJob.dependents.push(job.id);
    }

    // Pokud jsou nesplněné závislosti, blokovat tuto úlohu
    if (unmetDependencies.length > 0) {
      const blockedJob: Job = {
        ...job,
        status: 'blocked',
        dependsOn: unmetDependencies, // Sledovat pouze nesplněné
      };

      const newBlockedJobs = new Map(state.blockedJobs);
      newBlockedJobs.set(job.id, blockedJob);

      console.log(`[JobQueue] Úloha ${job.id} blokována, čeká na: ${unmetDependencies.join(', ')}`);

      return [{ success: true, jobId: job.id }, { ...state, blockedJobs: newBlockedJobs }];
    }
  }

  // Žádné závislosti nebo všechny splněny - pokračovat normálně
  // ... existující logika enqueue
}

// Upravené zpracování jobCompleted
case 'jobCompleted': {
  const job = state.processingJobs.get(msg.jobId);
  if (!job) return state;

  // ... existující logika dokončení

  // Cache výsledku pro sledování závislostí
  const newCompletedResults = new Map(state.completedJobResults);
  newCompletedResults.set(msg.jobId, msg.result);

  // Zkontrolovat závislé úlohy, které mohou být odblokovány
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

// Zkontrolovat a odblokovat závislé úlohy
function checkAndUnblockDependents(
  completedJobId: string,
  state: JobQueueState
): JobQueueState {
  let newState = { ...state };
  const newBlockedJobs = new Map(state.blockedJobs);
  const jobsToUnblock: Job[] = [];

  for (const [blockedId, blockedJob] of newBlockedJobs) {
    if (!blockedJob.dependsOn?.includes(completedJobId)) continue;

    // Odebrat dokončenou závislost
    const remainingDeps = blockedJob.dependsOn.filter(d => d !== completedJobId);

    if (remainingDeps.length === 0) {
      // Všechny závislosti splněny - odblokovat
      jobsToUnblock.push(blockedJob);
      newBlockedJobs.delete(blockedId);
      console.log(`[JobQueue] Odblokovávám úlohu ${blockedId} - všechny závislosti splněny`);
    } else {
      // Aktualizovat zbývající závislosti
      newBlockedJobs.set(blockedId, {
        ...blockedJob,
        dependsOn: remainingDeps,
      });
    }
  }

  newState = { ...newState, blockedJobs: newBlockedJobs };

  // Přesunout odblokované úlohy do čekajících
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

  // Pokusit se odeslat
  return tryDispatchJobs(newState);
}

// Zpracovat selhání závislosti - selhat všechny závislé
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
    // Najít závislou úlohu (může být blokovaná nebo čekající)
    const dependent = newState.blockedJobs.get(dependentId)
      ?? newState.pendingJobs.find(j => j.id === dependentId);

    if (!dependent) continue;

    // Vytvořit mrtvou úlohu
    const deadJob: Job = {
      ...dependent,
      status: 'dead',
      error: `Závislost ${failedJobId} selhala: ${error}`,
      completedAt: now,
      updatedAt: now,
    };

    // Odebrat z blocked/pending
    const newBlockedJobs = new Map(newState.blockedJobs);
    newBlockedJobs.delete(dependentId);

    const newPendingJobs = newState.pendingJobs.filter(j => j.id !== dependentId);

    newState = {
      ...newState,
      blockedJobs: newBlockedJobs,
      pendingJobs: newPendingJobs,
    };

    // Odeslat do DLQ
    const dlqRef = Registry.whereis('dead-letter-queue');
    if (dlqRef) {
      GenServer.cast(dlqRef, { type: 'addJob', job: deadJob });
    }

    // Publikovat událost
    publishEvent(newState.eventBus, {
      eventType: 'job.dead',
      jobId: dependentId,
      type: dependent.type,
      error: deadJob.error!,
      attempts: dependent.attempts,
      timestamp: now,
    });

    console.log(`[JobQueue] Závislá úloha ${dependentId} selhala kvůli závislosti ${failedJobId}`);

    // Rekurzivně selhat závislé na této závislé
    newState = failDependentJobs(dependentId, deadJob.error!, newState);
  }

  return newState;
}

// Přidat do jobDead case (při přesunu do DLQ po max opakováních)
case 'jobFailed': {
  // ... existující zpracování selhání

  if (!willRetry) {
    // Přesunout do DLQ...

    // Také selhat všechny závislé úlohy
    newState = failDependentJobs(msg.jobId, msg.error, newState);
  }

  return newState;
}

// Zpracovat getDependents volání
case 'getDependents': {
  const job = state.pendingJobs.find(j => j.id === msg.jobId)
    ?? state.processingJobs.get(msg.jobId)
    ?? state.blockedJobs.get(msg.jobId);

  if (!job) {
    return [{ success: true, dependents: [] }, state];
  }

  return [{ success: true, dependents: job.dependents ?? [] }, state];
}

// Příklad použití
async function example(queue: TaskQueue) {
  // Registrovat handlery
  queue.registerHandler('fetch-data', async (job) => {
    return { data: 'načteno' };
  });

  queue.registerHandler('process-data', async (job) => {
    // Tato úloha závisí na fetch-data dokončení jako první
    return { processed: true };
  });

  // Zařadit rodičovskou úlohu
  const fetchJobId = await queue.enqueue('fetch-data', { url: '/api/data' });

  // Zařadit závislou úlohu
  const processJobId = await queue.enqueue(
    'process-data',
    { input: 'data' },
    { dependsOn: [fetchJobId] }  // Počká na dokončení fetch-data
  );

  // process-data se automaticky spustí po dokončení fetch-data
}
```

**Klíčová rozhodnutí návrhu:**

1. **Blokovaný stav** — Úlohy s nesplněnými závislostmi jdou do samostatné `blockedJobs` mapy
2. **Cache dokončených výsledků** — Sledovat ID dokončených úloh pro kontrolu stavu závislostí
3. **Obousměrné sledování** — Úlohy znají své závislé pro kaskádové zpracování selhání
4. **Kaskádová selhání** — Když úloha přejde do DLQ, všechny její závislé také selžou
5. **Automatické odblokování** — Závislé se automaticky přesunou do pending když jsou všechny závislosti dokončeny

</details>

## Shrnutí

**Klíčové poznatky:**

- **Prioritní fronta s GenServer** — Centrální koordinace s typově bezpečným předáváním zpráv
- **Worker pool se simple_one_for_one** — Dynamické škálování homogenních workerů
- **Exponenciální backoff se sendAfter** — Odolné opakování bez blokování
- **Dead Letter Queue** — Selhané úlohy zachovány pro inspekci a přehrání
- **EventBus pro pozorovatelnost** — Oddělený monitoring bez ovlivnění zpracování úloh
- **Graceful shutdown** — Počkat na rozpracované úlohy před ukončením

**Použité architektonické vzory:**

| Vzor | Kde použit |
|------|------------|
| Prioritní fronta | Řazení úloh podle důležitosti |
| Worker Pool | Dynamické škálování se supervizí |
| Exponenciální Backoff | Zpoždění opakování s jitterem |
| Dead Letter Queue | Perzistence selhavších úloh |
| Pub/Sub | Události životního cyklu úloh |
| Application | Kompozice systému |

**Produkční úvahy:**

| Starost | Řešení |
|---------|--------|
| Perzistence úloh | Přidat StorageAdapter do JobQueue pro zotavení z pádu |
| Škálování | Zvýšit workery na základě hloubky fronty |
| Monitoring | Přihlásit se k EventBus pro metriky (Prometheus, atd.) |
| Rate limiting | Sledovat propustnost úloh podle typu |
| Deduplikace | Přidat idempotentní klíče do metadat úlohy |

**Co jste se naučili:**

1. Jak navrhnout systém zpracování úloh s noex
2. Správa prioritní fronty se stavem GenServer
3. Dynamický worker pool se supervizí `simple_one_for_one`
4. Logika opakování s exponenciálním backoffem pomocí `sendAfter`
5. Dead letter queue pro zpracování neúspěšných úloh
6. Event-driven pozorovatelnost s EventBus
7. Graceful shutdown s dokončením rozpracovaných úloh

> **Architektonický vhled:** Fronta úloh demonstruje, jak actor model přirozeně zvládá souběžné zpracování úloh. Každý worker je izolovaný, fronta udržuje konzistentní stav prostřednictvím sekvenčního zpracování zpráv a supervize zajišťuje automatické zotavení z chyb — vše bez explicitního zamykání nebo komplexního zpracování chyb.

---

Další: [API Gateway](./03-api-brana.md)
