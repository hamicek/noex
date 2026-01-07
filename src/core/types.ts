/**
 * Core type definitions for noex GenServer/Supervisor pattern.
 *
 * This module defines the foundational types that power the Elixir-style
 * actor model implementation in TypeScript.
 */

import type { PersistenceConfig, StateMetadata } from '../persistence/types.js';

// Re-export for use in GenServerBehavior and LifecycleEvent
export type { StateMetadata } from '../persistence/types.js';

/**
 * Opaque branded type for GenServer references.
 * Prevents accidental mixing of unrelated references.
 */
declare const RefBrand: unique symbol;

/**
 * A reference to a running GenServer instance.
 * This is the primary handle used to interact with a GenServer.
 *
 * @remarks
 * The `nodeId` field enables distributed communication:
 * - When `nodeId` is undefined, the server is local
 * - When `nodeId` matches the local node, the server is local
 * - When `nodeId` differs from local node, calls are routed remotely
 *
 * Note: `nodeId` is typed as `string` to avoid circular imports with
 * the distribution module. At runtime, it should be a valid NodeId
 * from `distribution/node-id.ts`.
 */
export interface GenServerRef<
  State = unknown,
  CallMsg = unknown,
  CastMsg = unknown,
  CallReply = unknown,
> {
  readonly [RefBrand]: 'GenServerRef';
  readonly id: string;
  /**
   * Node identifier where this GenServer is running.
   * undefined means local node (for backward compatibility).
   *
   * Should be a valid NodeId string in format: `name@host:port`
   */
  readonly nodeId?: string;
  readonly _phantom?: {
    readonly state: State;
    readonly callMsg: CallMsg;
    readonly castMsg: CastMsg;
    readonly callReply: CallReply;
  };
}

/**
 * Reason for GenServer termination.
 *
 * - 'normal': Graceful shutdown initiated by stop()
 * - 'shutdown': Supervisor-initiated shutdown
 * - { error: Error }: Crash due to unhandled exception
 */
export type TerminateReason = 'normal' | 'shutdown' | { readonly error: Error };

/**
 * Result of a call handler.
 * Returns both the reply to send back and the new state.
 */
export type CallResult<Reply, State> = readonly [Reply, State];

/**
 * Options for GenServer.start()
 *
 * @typeParam State - The type of the server's internal state (required for persistence)
 */
export interface StartOptions<State = unknown> {
  /**
   * Optional name for registry registration.
   * If provided, the server will be automatically registered in the Registry
   * under this name, allowing lookup via Registry.lookup(name).
   *
   * The registration is automatically cleaned up when the server terminates.
   *
   * @throws {AlreadyRegisteredError} If the name is already in use
   *
   * @example
   * ```typescript
   * const ref = await GenServer.start(behavior, { name: 'my-service' });
   * // Later, from anywhere:
   * const found = Registry.lookup('my-service');
   * ```
   */
  readonly name?: string;

  /**
   * Timeout in milliseconds for the init() call.
   * @default 5000
   */
  readonly initTimeout?: number;

  /**
   * Optional persistence configuration for automatic state persistence.
   *
   * When configured, the GenServer can:
   * - Restore state from storage on startup (restoreOnStart)
   * - Periodically snapshot state to storage (snapshotIntervalMs)
   * - Persist state on graceful shutdown (persistOnShutdown)
   * - Support manual checkpoints via GenServer.checkpoint()
   *
   * @example
   * ```typescript
   * const ref = await GenServer.start(behavior, {
   *   name: 'counter',
   *   persistence: {
   *     adapter: new FileAdapter({ directory: './data' }),
   *     snapshotIntervalMs: 30000,
   *     persistOnShutdown: true,
   *     restoreOnStart: true,
   *   },
   * });
   * ```
   */
  readonly persistence?: PersistenceConfig<State>;
}

/**
 * Options for GenServer.startRemote()
 *
 * Extends StartOptions with distribution-specific configuration for
 * spawning GenServers on remote cluster nodes.
 *
 * @typeParam State - The type of the server's internal state
 */
export interface RemoteStartOptions<State = unknown> extends StartOptions<State> {
  /**
   * Target node where the GenServer should be spawned.
   * Can be a NodeId or a string in format `name@host:port`.
   *
   * @example
   * ```typescript
   * // Using string format
   * { targetNode: 'app2@192.168.1.2:4369' }
   *
   * // Using NodeId
   * { targetNode: NodeId.parse('app2@192.168.1.2:4369') }
   * ```
   */
  readonly targetNode: string;

  /**
   * Registration strategy for the spawned GenServer.
   *
   * - `'local'`: Register only in the local registry of the target node (default)
   * - `'global'`: Register in the distributed GlobalRegistry for cluster-wide lookup
   * - `'none'`: Do not register the server under any name
   *
   * Note: Requires `name` option to be set for `'local'` and `'global'` strategies.
   *
   * @default 'local'
   */
  readonly registration?: 'local' | 'global' | 'none';

  /**
   * Timeout in milliseconds for the entire spawn operation.
   * Includes network round-trip, initialization, and optional registration.
   *
   * @default 10000
   */
  readonly spawnTimeout?: number;
}

/**
 * Options for GenServer.call()
 */
export interface CallOptions {
  /**
   * Timeout in milliseconds for the call to complete.
   * @default 5000
   */
  readonly timeout?: number;
}

/**
 * The behavior interface that GenServer implementations must satisfy.
 * This follows the Elixir GenServer callback pattern.
 *
 * @typeParam State - The type of the server's internal state
 * @typeParam CallMsg - Union type of all synchronous call messages
 * @typeParam CastMsg - Union type of all asynchronous cast messages
 * @typeParam CallReply - Union type of all possible call replies
 */
export interface GenServerBehavior<
  State,
  CallMsg,
  CastMsg,
  CallReply,
> {
  /**
   * Initialize the server state.
   * Called once when the server starts.
   *
   * @returns Initial state or a Promise that resolves to the initial state
   * @throws If init fails, the server will not start
   */
  init(): State | Promise<State>;

  /**
   * Handle a synchronous call message.
   * The caller will wait for the reply.
   *
   * @param msg - The call message
   * @param state - Current server state
   * @returns Tuple of [reply, newState] or Promise thereof
   */
  handleCall(
    msg: CallMsg,
    state: State,
  ): CallResult<CallReply, State> | Promise<CallResult<CallReply, State>>;

  /**
   * Handle an asynchronous cast message.
   * Fire-and-forget: the sender does not wait for a response.
   *
   * @param msg - The cast message
   * @param state - Current server state
   * @returns New state or Promise thereof
   */
  handleCast(msg: CastMsg, state: State): State | Promise<State>;

  /**
   * Called when the server is about to terminate.
   * Use this for cleanup (closing connections, flushing buffers, etc.).
   *
   * @param reason - Why the server is terminating
   * @param state - Final server state
   */
  terminate?(reason: TerminateReason, state: State): void | Promise<void>;

  /**
   * Called after state is restored from persistence.
   * Allows transformation or validation of the restored state.
   *
   * @param restoredState - The state loaded from persistence
   * @param metadata - Metadata about the persisted state
   * @returns The state to use (can be modified) or Promise thereof
   */
  onStateRestore?(restoredState: State, metadata: StateMetadata): State | Promise<State>;

  /**
   * Called before state is persisted.
   * Allows transformation or filtering of state before persistence.
   *
   * @param state - Current server state
   * @returns The state to persist, or undefined to skip this persistence
   */
  beforePersist?(state: State): State | undefined;
}

/**
 * Restart strategy for child processes in a Supervisor.
 *
 * - 'permanent': Always restart the child, regardless of exit reason
 * - 'transient': Restart only if the child exits abnormally (with error)
 * - 'temporary': Never restart the child
 */
export type ChildRestartStrategy = 'permanent' | 'transient' | 'temporary';

/**
 * Auto-shutdown behavior for supervisors.
 *
 * - 'never': Supervisor continues running even after all children terminate (default)
 * - 'any_significant': Supervisor shuts down when any significant child terminates
 * - 'all_significant': Supervisor shuts down when all significant children have terminated
 */
export type AutoShutdown = 'never' | 'any_significant' | 'all_significant';

/**
 * Specification for a child process managed by a Supervisor.
 */
export interface ChildSpec<
  State = unknown,
  CallMsg = unknown,
  CastMsg = unknown,
  CallReply = unknown,
> {
  /**
   * Unique identifier for this child within the supervisor.
   */
  readonly id: string;

  /**
   * Factory function to start the child process.
   * Called on initial start and on restarts.
   */
  readonly start: () => Promise<GenServerRef<State, CallMsg, CastMsg, CallReply>>;

  /**
   * Restart strategy for this child.
   * @default 'permanent'
   */
  readonly restart?: ChildRestartStrategy;

  /**
   * Time in milliseconds to wait for the child to shut down gracefully.
   * After this timeout, the child will be forcefully terminated.
   * @default 5000
   */
  readonly shutdownTimeout?: number;

  /**
   * Marks this child as significant for auto_shutdown behavior.
   * When true, this child's termination may trigger supervisor shutdown
   * depending on the autoShutdown setting.
   * @default false
   */
  readonly significant?: boolean;
}

/**
 * Strategy for restarting children when one fails.
 *
 * - 'one_for_one': Only restart the failed child
 * - 'one_for_all': Restart all children when one fails
 * - 'rest_for_one': Restart the failed child and all children started after it
 * - 'simple_one_for_one': Simplified one_for_one for dynamically spawned homogeneous children
 */
export type SupervisorStrategy = 'one_for_one' | 'one_for_all' | 'rest_for_one' | 'simple_one_for_one';

/**
 * Template for creating children dynamically in simple_one_for_one supervisors.
 *
 * @typeParam Args - Tuple type of arguments passed to start function
 */
export interface ChildTemplate<Args extends unknown[] = unknown[]> {
  /**
   * Factory function to start a child process.
   * Called with arguments provided to Supervisor.startChild().
   */
  readonly start: (...args: Args) => Promise<GenServerRef>;

  /**
   * Restart strategy for children created from this template.
   * @default 'permanent'
   */
  readonly restart?: ChildRestartStrategy;

  /**
   * Time in milliseconds to wait for children to shut down gracefully.
   * @default 5000
   */
  readonly shutdownTimeout?: number;

  /**
   * Marks children created from this template as significant for auto_shutdown.
   * @default false
   */
  readonly significant?: boolean;
}

/**
 * Configuration for supervisor restart intensity limiting.
 * If more than `maxRestarts` occur within `withinMs` milliseconds,
 * the supervisor itself will shut down to prevent restart loops.
 */
export interface RestartIntensity {
  /**
   * Maximum number of restarts allowed within the time window.
   * @default 3
   */
  readonly maxRestarts: number;

  /**
   * Time window in milliseconds.
   * @default 5000
   */
  readonly withinMs: number;
}

/**
 * Options for Supervisor.start()
 */
export interface SupervisorOptions {
  /**
   * Strategy for handling child failures.
   * @default 'one_for_one'
   */
  readonly strategy?: SupervisorStrategy;

  /**
   * Initial child specifications.
   * Children are started in order and stopped in reverse order.
   * Not allowed when strategy is 'simple_one_for_one'.
   */
  readonly children?: readonly ChildSpec[];

  /**
   * Template for dynamically spawning children.
   * Required when strategy is 'simple_one_for_one'.
   */
  readonly childTemplate?: ChildTemplate;

  /**
   * Restart intensity configuration.
   * Prevents infinite restart loops.
   */
  readonly restartIntensity?: RestartIntensity;

  /**
   * Optional name for registry registration.
   */
  readonly name?: string;

  /**
   * Auto-shutdown behavior when children terminate.
   * @default 'never'
   */
  readonly autoShutdown?: AutoShutdown;
}

/**
 * A reference to a running Supervisor instance.
 */
export interface SupervisorRef {
  readonly [RefBrand]: 'SupervisorRef';
  readonly id: string;
}

/**
 * Lifecycle event types emitted by GenServers and Supervisors.
 */
export type LifecycleEvent =
  | { readonly type: 'started'; readonly ref: GenServerRef | SupervisorRef }
  | { readonly type: 'crashed'; readonly ref: GenServerRef; readonly error: Error }
  | { readonly type: 'restarted'; readonly ref: GenServerRef; readonly attempt: number }
  | { readonly type: 'terminated'; readonly ref: GenServerRef | SupervisorRef; readonly reason: TerminateReason }
  | { readonly type: 'state_restored'; readonly ref: GenServerRef; readonly metadata: StateMetadata }
  | { readonly type: 'state_persisted'; readonly ref: GenServerRef; readonly metadata: StateMetadata }
  | { readonly type: 'persistence_error'; readonly ref: GenServerRef; readonly error: Error };

/**
 * Handler for lifecycle events.
 */
export type LifecycleHandler = (event: LifecycleEvent) => void;

/**
 * Error thrown when a call times out.
 */
export class CallTimeoutError extends Error {
  override readonly name = 'CallTimeoutError' as const;

  constructor(
    readonly serverId: string,
    readonly timeoutMs: number,
  ) {
    super(`Call to GenServer '${serverId}' timed out after ${timeoutMs}ms`);
  }
}

/**
 * Error thrown when trying to call/cast to a stopped server.
 */
export class ServerNotRunningError extends Error {
  override readonly name = 'ServerNotRunningError' as const;

  constructor(readonly serverId: string) {
    super(`GenServer '${serverId}' is not running`);
  }
}

/**
 * Error thrown when a server's init() fails.
 */
export class InitializationError extends Error {
  override readonly name = 'InitializationError' as const;
  override readonly cause: Error;

  constructor(
    readonly serverId: string,
    cause: Error,
  ) {
    super(`GenServer '${serverId}' failed to initialize: ${cause.message}`);
    this.cause = cause;
  }
}

/**
 * Error thrown when supervisor restart intensity is exceeded.
 */
export class MaxRestartsExceededError extends Error {
  override readonly name = 'MaxRestartsExceededError' as const;

  constructor(
    readonly supervisorId: string,
    readonly maxRestarts: number,
    readonly withinMs: number,
  ) {
    super(
      `Supervisor '${supervisorId}' exceeded max restarts (${maxRestarts} within ${withinMs}ms)`,
    );
  }
}

/**
 * Error thrown when a child with duplicate ID is added to supervisor.
 */
export class DuplicateChildError extends Error {
  override readonly name = 'DuplicateChildError' as const;

  constructor(
    readonly supervisorId: string,
    readonly childId: string,
  ) {
    super(`Child '${childId}' already exists in supervisor '${supervisorId}'`);
  }
}

/**
 * Error thrown when a child is not found in supervisor.
 */
export class ChildNotFoundError extends Error {
  override readonly name = 'ChildNotFoundError' as const;

  constructor(
    readonly supervisorId: string,
    readonly childId: string,
  ) {
    super(`Child '${childId}' not found in supervisor '${supervisorId}'`);
  }
}

/**
 * Error thrown when registry lookup fails.
 */
export class NotRegisteredError extends Error {
  override readonly name = 'NotRegisteredError' as const;

  constructor(readonly processName: string) {
    super(`No process registered under name '${processName}'`);
  }
}

/**
 * Error thrown when attempting to register with an already-used name.
 */
export class AlreadyRegisteredError extends Error {
  override readonly name = 'AlreadyRegisteredError' as const;

  constructor(readonly registeredName: string) {
    super(`Name '${registeredName}' is already registered`);
  }
}

/**
 * Error thrown when simple_one_for_one supervisor is started without childTemplate.
 */
export class MissingChildTemplateError extends Error {
  override readonly name = 'MissingChildTemplateError' as const;

  constructor(readonly supervisorId: string) {
    super(
      `Supervisor '${supervisorId}': simple_one_for_one strategy requires childTemplate`,
    );
  }
}

/**
 * Error thrown when simple_one_for_one supervisor is configured with static children.
 */
export class InvalidSimpleOneForOneConfigError extends Error {
  override readonly name = 'InvalidSimpleOneForOneConfigError' as const;

  constructor(
    readonly supervisorId: string,
    readonly reason: string,
  ) {
    super(`Supervisor '${supervisorId}': invalid simple_one_for_one config - ${reason}`);
  }
}

/**
 * Internal state of a GenServer.
 * Used by GenServer implementation, not meant for public consumption.
 */
export type ServerStatus = 'initializing' | 'running' | 'stopping' | 'stopped';

/**
 * Information about a running child in a supervisor.
 */
export interface ChildInfo {
  readonly id: string;
  readonly ref: GenServerRef;
  readonly spec: ChildSpec;
  readonly restartCount: number;
}

/**
 * Default values for various options.
 */
export const DEFAULTS = {
  INIT_TIMEOUT: 5000,
  CALL_TIMEOUT: 5000,
  SHUTDOWN_TIMEOUT: 5000,
  MAX_RESTARTS: 3,
  RESTART_WITHIN_MS: 5000,
} as const;

// =============================================================================
// Observer Types
// =============================================================================

/**
 * Runtime statistics for a GenServer instance.
 * Provides introspection data for monitoring and debugging.
 */
export interface GenServerStats {
  /** Unique identifier of the server */
  readonly id: string;
  /** Current operational status */
  readonly status: ServerStatus;
  /** Number of messages waiting in the queue */
  readonly queueSize: number;
  /** Total number of messages processed (calls + casts) */
  readonly messageCount: number;
  /** Unix timestamp when the server started */
  readonly startedAt: number;
  /** Time elapsed since start in milliseconds */
  readonly uptimeMs: number;
  /** Estimated memory usage of the server's state in bytes */
  readonly stateMemoryBytes?: number;
}

/**
 * Global memory statistics from process.memoryUsage().
 * Provides system-wide memory introspection.
 */
export interface MemoryStats {
  /** V8 heap memory currently in use (bytes) */
  readonly heapUsed: number;
  /** Total V8 heap memory allocated (bytes) */
  readonly heapTotal: number;
  /** Memory used by C++ objects bound to JavaScript (bytes) */
  readonly external: number;
  /** Resident Set Size - total memory allocated for the process (bytes) */
  readonly rss: number;
  /** Unix timestamp when the stats were collected */
  readonly timestamp: number;
}

/**
 * Runtime statistics for a Supervisor instance.
 * Provides introspection data for monitoring supervision trees.
 */
export interface SupervisorStats {
  /** Unique identifier of the supervisor */
  readonly id: string;
  /** Restart strategy in use */
  readonly strategy: SupervisorStrategy;
  /** Number of children currently managed */
  readonly childCount: number;
  /** Total number of child restarts performed */
  readonly totalRestarts: number;
  /** Unix timestamp when the supervisor started */
  readonly startedAt: number;
  /** Time elapsed since start in milliseconds */
  readonly uptimeMs: number;
}

/**
 * A node in the process tree hierarchy.
 * Used for visualizing the supervision structure.
 */
export interface ProcessTreeNode {
  /** Type of process */
  readonly type: 'genserver' | 'supervisor';
  /** Unique identifier */
  readonly id: string;
  /** Optional registered name */
  readonly name?: string;
  /** Runtime statistics */
  readonly stats: GenServerStats | SupervisorStats;
  /** Child nodes (only for supervisors) */
  readonly children?: readonly ProcessTreeNode[];
}

/**
 * Events emitted by the Observer for real-time monitoring.
 * Discriminated union for type-safe event handling.
 */
export type ObserverEvent =
  | { readonly type: 'server_started'; readonly stats: GenServerStats }
  | { readonly type: 'server_stopped'; readonly id: string; readonly reason: TerminateReason }
  | { readonly type: 'supervisor_started'; readonly stats: SupervisorStats }
  | { readonly type: 'supervisor_stopped'; readonly id: string }
  | { readonly type: 'stats_update'; readonly servers: readonly GenServerStats[]; readonly supervisors: readonly SupervisorStats[] };
