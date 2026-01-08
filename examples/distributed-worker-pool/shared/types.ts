/**
 * Type definitions for the distributed worker pool example.
 *
 * Demonstrates proper TypeScript typing for a distributed task processing system
 * using DistributedSupervisor with automatic failover and node selection strategies.
 */

import type { SerializedRef, NodeId } from 'noex/distribution';

// =============================================================================
// Task Types
// =============================================================================

/**
 * Unique identifier for a task.
 */
export type TaskId = string & { readonly __brand: 'TaskId' };

/**
 * Status of a task in the queue.
 */
export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * A task to be processed by a worker.
 */
export interface Task {
  /** Unique task identifier */
  readonly id: TaskId;

  /** Task type for routing/processing */
  readonly type: string;

  /** Task payload */
  readonly payload: unknown;

  /** When the task was submitted */
  readonly submittedAt: number;

  /** Current status */
  readonly status: TaskStatus;

  /** Worker processing this task (if any) */
  readonly assignedWorker?: string;

  /** When processing started */
  readonly startedAt?: number;
}

/**
 * Result of a completed task.
 */
export interface TaskResult {
  /** Task identifier */
  readonly taskId: TaskId;

  /** Whether the task succeeded */
  readonly success: boolean;

  /** Result data (if successful) */
  readonly data?: unknown;

  /** Error message (if failed) */
  readonly error?: string;

  /** Worker that processed the task */
  readonly workerId: string;

  /** Node where the worker ran */
  readonly nodeId: NodeId;

  /** When the task completed */
  readonly completedAt: number;

  /** Processing duration in milliseconds */
  readonly durationMs: number;
}

// =============================================================================
// Worker Types
// =============================================================================

/**
 * State of a worker process.
 */
export interface WorkerState {
  /** Worker identifier */
  readonly id: string;

  /** GenServer ID of this worker (for self-referencing in async callbacks) */
  readonly selfId: string | null;

  /** Reference to the task queue */
  readonly taskQueueRef: SerializedRef | null;

  /** Reference to the result collector */
  readonly resultCollectorRef: SerializedRef | null;

  /** Current task being processed */
  readonly currentTask: Task | null;

  /** Number of tasks processed */
  readonly tasksProcessed: number;

  /** Processing speed multiplier (1 = normal, < 1 = slow, > 1 = fast) */
  readonly speedMultiplier: number;

  /** Whether the worker is active */
  readonly active: boolean;
}

/**
 * Call messages for Worker.
 */
export type WorkerCallMsg =
  | { readonly type: 'get_status' }
  | { readonly type: 'get_stats' };

/**
 * Cast messages for Worker.
 */
export type WorkerCastMsg =
  | { readonly type: 'configure'; readonly taskQueueRef: SerializedRef; readonly resultCollectorRef: SerializedRef }
  | { readonly type: 'process_task'; readonly task: Task }
  | { readonly type: 'set_speed'; readonly multiplier: number }
  | { readonly type: 'crash' }
  | { readonly type: 'request_work' };

/**
 * Reply types for Worker calls.
 */
export type WorkerCallReply =
  | { readonly id: string; readonly active: boolean; readonly currentTask: Task | null }
  | { readonly id: string; readonly tasksProcessed: number; readonly speedMultiplier: number };

// =============================================================================
// Task Queue Types
// =============================================================================

/**
 * State of the task queue process.
 */
export interface TaskQueueState {
  /** Pending tasks awaiting processing */
  readonly pendingTasks: readonly Task[];

  /** Tasks currently being processed */
  readonly processingTasks: ReadonlyMap<TaskId, Task>;

  /** Available workers waiting for tasks */
  readonly availableWorkers: readonly SerializedRef[];

  /** Total tasks submitted */
  readonly totalSubmitted: number;

  /** Total tasks dispatched to workers */
  readonly totalDispatched: number;
}

/**
 * Call messages for TaskQueue.
 */
export type TaskQueueCallMsg =
  | { readonly type: 'submit_task'; readonly taskType: string; readonly payload: unknown }
  | { readonly type: 'get_stats' }
  | { readonly type: 'get_pending_count' };

/**
 * Cast messages for TaskQueue.
 */
export type TaskQueueCastMsg =
  | { readonly type: 'worker_available'; readonly workerRef: SerializedRef }
  | { readonly type: 'worker_unavailable'; readonly workerId: string }
  | { readonly type: 'task_started'; readonly taskId: TaskId; readonly workerId: string }
  | { readonly type: 'task_completed'; readonly taskId: TaskId };

/**
 * Reply types for TaskQueue calls.
 */
export type TaskQueueCallReply =
  | { readonly taskId: TaskId }
  | { readonly pendingCount: number; readonly processingCount: number; readonly totalSubmitted: number; readonly totalDispatched: number }
  | { readonly count: number };

// =============================================================================
// Result Collector Types
// =============================================================================

/**
 * State of the result collector process.
 */
export interface ResultCollectorState {
  /** Completed task results */
  readonly results: readonly TaskResult[];

  /** Count of successful tasks */
  readonly successCount: number;

  /** Count of failed tasks */
  readonly failedCount: number;

  /** Maximum results to keep */
  readonly maxResults: number;
}

/**
 * Call messages for ResultCollector.
 */
export type ResultCollectorCallMsg =
  | { readonly type: 'get_results'; readonly limit?: number }
  | { readonly type: 'get_stats' }
  | { readonly type: 'clear' };

/**
 * Cast messages for ResultCollector.
 */
export type ResultCollectorCastMsg =
  | { readonly type: 'record_result'; readonly result: TaskResult };

/**
 * Reply types for ResultCollector calls.
 */
export type ResultCollectorCallReply =
  | { readonly results: readonly TaskResult[] }
  | { readonly totalResults: number; readonly successCount: number; readonly failedCount: number }
  | { readonly ok: true };

// =============================================================================
// Supervisor Event Types
// =============================================================================

/**
 * Events emitted to the supervisor console.
 */
export type SupervisorConsoleEvent =
  | { readonly type: 'worker_added'; readonly workerId: string; readonly nodeId: NodeId }
  | { readonly type: 'worker_removed'; readonly workerId: string }
  | { readonly type: 'worker_crashed'; readonly workerId: string; readonly nodeId: NodeId }
  | { readonly type: 'worker_migrated'; readonly workerId: string; readonly fromNode: NodeId; readonly toNode: NodeId }
  | { readonly type: 'task_submitted'; readonly taskId: TaskId }
  | { readonly type: 'task_completed'; readonly taskId: TaskId; readonly success: boolean; readonly workerId: string }
  | { readonly type: 'node_joined'; readonly nodeId: NodeId }
  | { readonly type: 'node_left'; readonly nodeId: NodeId };

// =============================================================================
// Constants
// =============================================================================

/**
 * Behavior names for remote spawning.
 */
export const BEHAVIOR_NAMES = {
  WORKER: 'distributed-worker-pool:worker',
  TASK_QUEUE: 'distributed-worker-pool:task-queue',
  RESULT_COLLECTOR: 'distributed-worker-pool:result-collector',
} as const;

/**
 * Default configuration values.
 */
export const DEFAULTS = {
  /** Default processing time for tasks (ms) */
  TASK_PROCESSING_TIME: 1000,

  /** Maximum results to keep in collector */
  MAX_RESULTS: 1000,

  /** Task ID prefix */
  TASK_ID_PREFIX: 'task',
} as const;

/**
 * Generates a unique task ID.
 */
export function generateTaskId(): TaskId {
  return `${DEFAULTS.TASK_ID_PREFIX}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` as TaskId;
}
