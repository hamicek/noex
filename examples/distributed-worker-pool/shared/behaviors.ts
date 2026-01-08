/**
 * GenServer behaviors for the distributed worker pool example.
 *
 * Implements:
 * - Worker: Processes tasks from the queue
 * - TaskQueue: Manages pending tasks and distributes them to workers
 * - ResultCollector: Collects and stores task results
 */

import type { GenServerBehavior, CallResult } from 'noex';
import { GenServer } from 'noex';
import { Cluster, RemoteCall, type SerializedRef, type NodeId } from 'noex/distribution';

import type {
  Task,
  TaskId,
  TaskResult,
  WorkerState,
  WorkerCallMsg,
  WorkerCastMsg,
  WorkerCallReply,
  TaskQueueState,
  TaskQueueCallMsg,
  TaskQueueCastMsg,
  TaskQueueCallReply,
  ResultCollectorState,
  ResultCollectorCallMsg,
  ResultCollectorCastMsg,
  ResultCollectorCallReply,
} from './types.js';

import { DEFAULTS, generateTaskId } from './types.js';

// =============================================================================
// Smart Cast Helper
// =============================================================================

/**
 * Casts to a process - uses local GenServer.cast for local refs,
 * RemoteCall.cast for remote refs.
 */
function smartCast(ref: SerializedRef, msg: unknown): void {
  const localNodeId = Cluster.getLocalNodeId();
  if (ref.nodeId === localNodeId) {
    const localRef = GenServer._getRefById(ref.id);
    if (localRef) {
      GenServer.cast(localRef, msg);
    }
  } else {
    RemoteCall.cast(ref, msg);
  }
}

// =============================================================================
// Worker Behavior
// =============================================================================

/**
 * Creates a worker behavior with the specified ID.
 *
 * Workers process tasks from the queue and report results to the collector.
 * They implement a pull-based model where they request work when available.
 */
export function createWorkerBehavior(
  workerId: string,
): GenServerBehavior<WorkerState, WorkerCallMsg, WorkerCastMsg, WorkerCallReply> {
  return {
    init(): WorkerState {
      return {
        id: workerId,
        taskQueueRef: null,
        resultCollectorRef: null,
        currentTask: null,
        tasksProcessed: 0,
        speedMultiplier: 1,
        active: false,
      };
    },

    handleCall(msg, state): CallResult<WorkerCallReply, WorkerState> {
      switch (msg.type) {
        case 'get_status': {
          return [
            { id: state.id, active: state.active, currentTask: state.currentTask },
            state,
          ];
        }

        case 'get_stats': {
          return [
            { id: state.id, tasksProcessed: state.tasksProcessed, speedMultiplier: state.speedMultiplier },
            state,
          ];
        }
      }
    },

    handleCast(msg, state): WorkerState {
      switch (msg.type) {
        case 'configure': {
          const newState: WorkerState = {
            ...state,
            taskQueueRef: msg.taskQueueRef,
            resultCollectorRef: msg.resultCollectorRef,
            active: true,
          };

          // Request initial work
          if (msg.taskQueueRef) {
            const localNodeId = Cluster.getLocalNodeId();
            const selfRef: SerializedRef = {
              id: GenServer._getCurrentProcessId()!,
              nodeId: localNodeId,
            };
            smartCast(msg.taskQueueRef, { type: 'worker_available', workerRef: selfRef });
          }

          return newState;
        }

        case 'process_task': {
          if (!state.active || state.currentTask) {
            return state;
          }

          const task = msg.task;

          // Notify queue that task is being processed
          if (state.taskQueueRef) {
            smartCast(state.taskQueueRef, {
              type: 'task_started',
              taskId: task.id,
              workerId: state.id,
            });
          }

          // Process the task asynchronously
          const processingTime = Math.floor(DEFAULTS.TASK_PROCESSING_TIME / state.speedMultiplier);
          const startTime = Date.now();

          setTimeout(() => {
            // Simulate task processing
            const success = Math.random() > 0.1; // 90% success rate
            const result: TaskResult = {
              taskId: task.id,
              success,
              data: success ? { processed: task.payload, workerId: state.id } : undefined,
              error: success ? undefined : 'Simulated task failure',
              workerId: state.id,
              nodeId: Cluster.getLocalNodeId(),
              completedAt: Date.now(),
              durationMs: Date.now() - startTime,
            };

            // Report result
            if (state.resultCollectorRef) {
              smartCast(state.resultCollectorRef, { type: 'record_result', result });
            }

            // Notify queue that task is done
            if (state.taskQueueRef) {
              smartCast(state.taskQueueRef, { type: 'task_completed', taskId: task.id });
            }

            // Get the current GenServer ref and cast to self
            const selfId = GenServer._getCurrentProcessId();
            if (selfId) {
              const selfRef = GenServer._getRefById(selfId);
              if (selfRef) {
                GenServer.cast(selfRef, { type: 'request_work' });
              }
            }
          }, processingTime);

          return {
            ...state,
            currentTask: task,
          };
        }

        case 'request_work': {
          if (!state.active || !state.taskQueueRef) {
            return state;
          }

          const localNodeId = Cluster.getLocalNodeId();
          const selfRef: SerializedRef = {
            id: GenServer._getCurrentProcessId()!,
            nodeId: localNodeId,
          };
          smartCast(state.taskQueueRef, { type: 'worker_available', workerRef: selfRef });

          return {
            ...state,
            currentTask: null,
            tasksProcessed: state.currentTask ? state.tasksProcessed + 1 : state.tasksProcessed,
          };
        }

        case 'set_speed': {
          return {
            ...state,
            speedMultiplier: Math.max(0.1, Math.min(10, msg.multiplier)),
          };
        }

        case 'crash': {
          // Simulate a crash by throwing an error
          throw new Error(`Worker ${state.id} crashed intentionally`);
        }
      }
    },
  };
}

/**
 * Generic worker behavior for remote spawning.
 */
export const workerBehavior: GenServerBehavior<
  WorkerState,
  WorkerCallMsg,
  WorkerCastMsg,
  WorkerCallReply
> = {
  init(workerId?: string): WorkerState {
    return createWorkerBehavior(workerId ?? `worker_${Date.now()}`).init();
  },

  handleCall(
    msg: WorkerCallMsg,
    state: WorkerState,
  ): CallResult<WorkerCallReply, WorkerState> {
    return createWorkerBehavior(state.id).handleCall(msg, state);
  },

  handleCast(msg: WorkerCastMsg, state: WorkerState): WorkerState {
    return createWorkerBehavior(state.id).handleCast(msg, state);
  },
};

// =============================================================================
// Task Queue Behavior
// =============================================================================

/**
 * Creates a task queue behavior.
 *
 * The queue manages pending tasks and distributes them to available workers
 * using a FIFO strategy with pull-based distribution.
 */
export function createTaskQueueBehavior(): GenServerBehavior<
  TaskQueueState,
  TaskQueueCallMsg,
  TaskQueueCastMsg,
  TaskQueueCallReply
> {
  return {
    init(): TaskQueueState {
      return {
        pendingTasks: [],
        processingTasks: new Map(),
        availableWorkers: [],
        totalSubmitted: 0,
        totalDispatched: 0,
      };
    },

    handleCall(msg, state): CallResult<TaskQueueCallReply, TaskQueueState> {
      switch (msg.type) {
        case 'submit_task': {
          const taskId = generateTaskId();
          const task: Task = {
            id: taskId,
            type: msg.taskType,
            payload: msg.payload,
            submittedAt: Date.now(),
            status: 'pending',
          };

          const newPendingTasks = [...state.pendingTasks, task];
          let newState: TaskQueueState = {
            ...state,
            pendingTasks: newPendingTasks,
            totalSubmitted: state.totalSubmitted + 1,
          };

          // Try to dispatch immediately if workers available
          newState = tryDispatchTasks(newState);

          return [{ taskId }, newState];
        }

        case 'get_stats': {
          return [
            {
              pendingCount: state.pendingTasks.length,
              processingCount: state.processingTasks.size,
              totalSubmitted: state.totalSubmitted,
              totalDispatched: state.totalDispatched,
            },
            state,
          ];
        }

        case 'get_pending_count': {
          return [{ count: state.pendingTasks.length }, state];
        }
      }
    },

    handleCast(msg, state): TaskQueueState {
      switch (msg.type) {
        case 'worker_available': {
          // Add worker to available pool
          const alreadyExists = state.availableWorkers.some(
            (w) => w.id === msg.workerRef.id && w.nodeId === msg.workerRef.nodeId,
          );

          if (alreadyExists) {
            return tryDispatchTasks(state);
          }

          const newState: TaskQueueState = {
            ...state,
            availableWorkers: [...state.availableWorkers, msg.workerRef],
          };

          return tryDispatchTasks(newState);
        }

        case 'worker_unavailable': {
          return {
            ...state,
            availableWorkers: state.availableWorkers.filter(
              (w) => !w.id.includes(msg.workerId),
            ),
          };
        }

        case 'task_started': {
          const task = state.pendingTasks.find((t) => t.id === msg.taskId);
          if (!task) {
            return state;
          }

          const updatedTask: Task = {
            ...task,
            status: 'processing',
            assignedWorker: msg.workerId,
            startedAt: Date.now(),
          };

          const newProcessingTasks = new Map(state.processingTasks);
          newProcessingTasks.set(msg.taskId, updatedTask);

          return {
            ...state,
            pendingTasks: state.pendingTasks.filter((t) => t.id !== msg.taskId),
            processingTasks: newProcessingTasks,
          };
        }

        case 'task_completed': {
          const newProcessingTasks = new Map(state.processingTasks);
          newProcessingTasks.delete(msg.taskId);

          return {
            ...state,
            processingTasks: newProcessingTasks,
          };
        }
      }
    },
  };
}

/**
 * Attempts to dispatch pending tasks to available workers.
 */
function tryDispatchTasks(state: TaskQueueState): TaskQueueState {
  if (state.pendingTasks.length === 0 || state.availableWorkers.length === 0) {
    return state;
  }

  let pendingTasks = [...state.pendingTasks];
  let availableWorkers = [...state.availableWorkers];
  let totalDispatched = state.totalDispatched;

  while (pendingTasks.length > 0 && availableWorkers.length > 0) {
    const task = pendingTasks.shift()!;
    const worker = availableWorkers.shift()!;

    // Send task to worker
    smartCast(worker, { type: 'process_task', task });
    totalDispatched++;
  }

  return {
    ...state,
    pendingTasks,
    availableWorkers,
    totalDispatched,
  };
}

/**
 * Generic task queue behavior for remote spawning.
 */
export const taskQueueBehavior: GenServerBehavior<
  TaskQueueState,
  TaskQueueCallMsg,
  TaskQueueCastMsg,
  TaskQueueCallReply
> = createTaskQueueBehavior();

// =============================================================================
// Result Collector Behavior
// =============================================================================

/**
 * Creates a result collector behavior.
 *
 * The collector stores task results with configurable history limits.
 */
export function createResultCollectorBehavior(
  maxResults = DEFAULTS.MAX_RESULTS,
): GenServerBehavior<
  ResultCollectorState,
  ResultCollectorCallMsg,
  ResultCollectorCastMsg,
  ResultCollectorCallReply
> {
  return {
    init(): ResultCollectorState {
      return {
        results: [],
        successCount: 0,
        failedCount: 0,
        maxResults,
      };
    },

    handleCall(msg, state): CallResult<ResultCollectorCallReply, ResultCollectorState> {
      switch (msg.type) {
        case 'get_results': {
          const limit = msg.limit ?? 10;
          const results = state.results.slice(-limit);
          return [{ results }, state];
        }

        case 'get_stats': {
          return [
            {
              totalResults: state.results.length,
              successCount: state.successCount,
              failedCount: state.failedCount,
            },
            state,
          ];
        }

        case 'clear': {
          return [
            { ok: true },
            {
              ...state,
              results: [],
              successCount: 0,
              failedCount: 0,
            },
          ];
        }
      }
    },

    handleCast(msg, state): ResultCollectorState {
      switch (msg.type) {
        case 'record_result': {
          const newResults = [...state.results, msg.result].slice(-state.maxResults);

          return {
            ...state,
            results: newResults,
            successCount: msg.result.success ? state.successCount + 1 : state.successCount,
            failedCount: msg.result.success ? state.failedCount : state.failedCount + 1,
          };
        }
      }
    },
  };
}

/**
 * Generic result collector behavior for remote spawning.
 */
export const resultCollectorBehavior: GenServerBehavior<
  ResultCollectorState,
  ResultCollectorCallMsg,
  ResultCollectorCastMsg,
  ResultCollectorCallReply
> = createResultCollectorBehavior();
