/**
 * GenServer implementation for TypeScript.
 *
 * Provides an Elixir-style GenServer abstraction with:
 * - Serialized message processing via internal queue
 * - Synchronous call/response pattern
 * - Asynchronous fire-and-forget casts
 * - Graceful shutdown with cleanup hooks
 * - Lifecycle event emission for observability
 */

import {
  type GenServerRef,
  type GenServerBehavior,
  type TerminateReason,
  type CallResult,
  type StartOptions,
  type CallOptions,
  type ServerStatus,
  type LifecycleHandler,
  type GenServerStats,
  CallTimeoutError,
  ServerNotRunningError,
  InitializationError,
  DEFAULTS,
} from './types.js';
import { estimateObjectSize } from '../observer/memory-utils.js';

/**
 * Internal message type for the processing queue.
 * Discriminated union ensures exhaustive handling.
 */
type QueuedMessage<CallMsg, CastMsg, CallReply> =
  | {
      readonly kind: 'call';
      readonly msg: CallMsg;
      readonly resolve: (reply: CallReply) => void;
      readonly reject: (error: Error) => void;
    }
  | {
      readonly kind: 'cast';
      readonly msg: CastMsg;
    }
  | {
      readonly kind: 'stop';
      readonly reason: TerminateReason;
      readonly resolve: () => void;
      readonly reject: (error: Error) => void;
    };

/**
 * Internal server instance that manages state and message processing.
 * This is the actual runtime representation of a GenServer.
 */
class ServerInstance<State, CallMsg, CastMsg, CallReply> {
  private state: State;
  private status: ServerStatus = 'initializing';
  private readonly queue: QueuedMessage<CallMsg, CastMsg, CallReply>[] = [];
  private processing = false;
  private readonly startedAt: number = Date.now();
  private messageCount = 0;

  constructor(
    readonly id: string,
    private readonly behavior: GenServerBehavior<State, CallMsg, CastMsg, CallReply>,
    initialState: State,
  ) {
    this.state = initialState;
  }

  /**
   * Marks the server as running, enabling message processing.
   */
  markRunning(): void {
    this.status = 'running';
  }

  /**
   * Returns current server status.
   */
  getStatus(): ServerStatus {
    return this.status;
  }

  /**
   * Returns the current queue size.
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Returns comprehensive statistics for this server instance.
   */
  getStats(): GenServerStats {
    return {
      id: this.id,
      status: this.status,
      queueSize: this.queue.length,
      messageCount: this.messageCount,
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      stateMemoryBytes: this.getStateMemoryEstimate(),
    };
  }

  /**
   * Estimates the memory footprint of the current state.
   * Uses heuristic-based calculation for approximation.
   */
  getStateMemoryEstimate(): number {
    return estimateObjectSize(this.state);
  }

  /**
   * Enqueues a call message and returns a promise for the reply.
   */
  enqueueCall(msg: CallMsg, timeoutMs: number): Promise<CallReply> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // Remove the message from queue if still pending
        const idx = this.queue.findIndex(
          (m) => m.kind === 'call' && m.resolve === resolve,
        );
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
        reject(new CallTimeoutError(this.id, timeoutMs));
      }, timeoutMs);

      const wrappedResolve = (reply: CallReply) => {
        clearTimeout(timeoutId);
        resolve(reply);
      };

      const wrappedReject = (error: Error) => {
        clearTimeout(timeoutId);
        reject(error);
      };

      this.queue.push({
        kind: 'call',
        msg,
        resolve: wrappedResolve,
        reject: wrappedReject,
      });
      this.processQueue();
    });
  }

  /**
   * Enqueues a cast message for asynchronous processing.
   */
  enqueueCast(msg: CastMsg): void {
    this.queue.push({ kind: 'cast', msg });
    this.processQueue();
  }

  /**
   * Initiates graceful shutdown.
   */
  enqueueStop(reason: TerminateReason): Promise<void> {
    return new Promise((resolve, reject) => {
      // If already stopped, resolve immediately
      if (this.status === 'stopped') {
        resolve();
        return;
      }

      // If already stopping, wait for it
      if (this.status === 'stopping') {
        const checkStopped = () => {
          if (this.status === 'stopped') {
            resolve();
          } else {
            setTimeout(checkStopped, 10);
          }
        };
        checkStopped();
        return;
      }

      this.queue.push({ kind: 'stop', reason, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Force terminates the server, rejecting all pending messages.
   * Used by supervisors for immediate shutdown.
   */
  forceTerminate(reason: TerminateReason): void {
    this.status = 'stopped';

    // Reject all pending calls
    for (const msg of this.queue) {
      if (msg.kind === 'call') {
        msg.reject(new ServerNotRunningError(this.id));
      } else if (msg.kind === 'stop') {
        msg.resolve();
      }
    }
    this.queue.length = 0;

    // Best-effort terminate callback
    if (this.behavior.terminate) {
      try {
        // Fire and forget - we're force terminating
        void Promise.resolve(this.behavior.terminate(reason, this.state));
      } catch {
        // Ignore errors during force terminate
      }
    }
  }

  /**
   * Processes messages from the queue sequentially.
   * This ensures message handling is serialized.
   */
  private processQueue(): void {
    if (this.processing || this.status === 'stopped') {
      return;
    }

    const message = this.queue.shift();
    if (!message) {
      return;
    }

    this.processing = true;
    void this.processMessage(message).finally(() => {
      this.processing = false;
      this.processQueue();
    });
  }

  /**
   * Processes a single message from the queue.
   */
  private async processMessage(
    message: QueuedMessage<CallMsg, CastMsg, CallReply>,
  ): Promise<void> {
    switch (message.kind) {
      case 'call':
        await this.handleCallMessage(message);
        break;
      case 'cast':
        await this.handleCastMessage(message);
        break;
      case 'stop':
        await this.handleStopMessage(message);
        break;
    }
  }

  /**
   * Handles a synchronous call message.
   */
  private async handleCallMessage(message: {
    readonly kind: 'call';
    readonly msg: CallMsg;
    readonly resolve: (reply: CallReply) => void;
    readonly reject: (error: Error) => void;
  }): Promise<void> {
    if (this.status !== 'running') {
      message.reject(new ServerNotRunningError(this.id));
      return;
    }

    try {
      const result: CallResult<CallReply, State> = await Promise.resolve(
        this.behavior.handleCall(message.msg, this.state),
      );
      const [reply, newState] = result;
      this.state = newState;
      this.messageCount++;
      message.resolve(reply);
    } catch (error) {
      message.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Handles an asynchronous cast message.
   */
  private async handleCastMessage(message: {
    readonly kind: 'cast';
    readonly msg: CastMsg;
  }): Promise<void> {
    if (this.status !== 'running') {
      // Silently ignore casts to non-running servers
      return;
    }

    try {
      const newState = await Promise.resolve(
        this.behavior.handleCast(message.msg, this.state),
      );
      this.state = newState;
      this.messageCount++;
    } catch {
      // Cast errors are silently ignored as there's no caller to notify.
      // In production, errors should be captured via lifecycle events.
    }
  }

  /**
   * Handles the stop message, performing graceful shutdown.
   */
  private async handleStopMessage(message: {
    readonly kind: 'stop';
    readonly reason: TerminateReason;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }): Promise<void> {
    this.status = 'stopping';

    try {
      if (this.behavior.terminate) {
        await Promise.resolve(this.behavior.terminate(message.reason, this.state));
      }
      this.status = 'stopped';
      message.resolve();
    } catch (error) {
      this.status = 'stopped';
      message.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/**
 * Registry of active server instances.
 * Maps server IDs to their runtime instances.
 */
const serverRegistry = new Map<string, ServerInstance<unknown, unknown, unknown, unknown>>();

/**
 * Global lifecycle event handlers.
 */
const lifecycleHandlers = new Set<LifecycleHandler>();

/**
 * Counter for generating unique server IDs.
 */
let serverIdCounter = 0;

/**
 * Generates a unique server ID.
 */
function generateServerId(): string {
  return `genserver_${++serverIdCounter}_${Date.now().toString(36)}`;
}

/**
 * Emits a lifecycle event to all registered handlers.
 */
function emitLifecycleEvent(
  type: 'started',
  ref: GenServerRef,
): void;
function emitLifecycleEvent(
  type: 'crashed',
  ref: GenServerRef,
  error: Error,
): void;
function emitLifecycleEvent(
  type: 'terminated',
  ref: GenServerRef,
  reason: TerminateReason,
): void;
function emitLifecycleEvent(
  type: 'started' | 'crashed' | 'terminated',
  ref: GenServerRef,
  errorOrReason?: Error | TerminateReason,
): void {
  if (lifecycleHandlers.size === 0) return;

  let event;
  switch (type) {
    case 'started':
      event = { type, ref } as const;
      break;
    case 'crashed':
      event = { type, ref, error: errorOrReason as Error } as const;
      break;
    case 'terminated':
      event = { type, ref, reason: errorOrReason as TerminateReason } as const;
      break;
  }

  for (const handler of lifecycleHandlers) {
    try {
      handler(event);
    } catch {
      // Lifecycle handlers should not throw, but if they do, ignore it
    }
  }
}

/**
 * Creates a GenServerRef from a server ID.
 * This is an internal function - refs are opaque to consumers.
 */
function createRef<State, CallMsg, CastMsg, CallReply>(
  id: string,
): GenServerRef<State, CallMsg, CastMsg, CallReply> {
  // The ref is just a branded object with an ID.
  // The actual runtime is managed via the registry.
  return { id } as GenServerRef<State, CallMsg, CastMsg, CallReply>;
}

/**
 * Gets the server instance for a ref, or throws if not found.
 */
function getServerInstance<State, CallMsg, CastMsg, CallReply>(
  ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
): ServerInstance<State, CallMsg, CastMsg, CallReply> {
  const instance = serverRegistry.get(ref.id);
  if (!instance) {
    throw new ServerNotRunningError(ref.id);
  }
  return instance as ServerInstance<State, CallMsg, CastMsg, CallReply>;
}

/**
 * GenServer provides a process-like abstraction for managing stateful services.
 *
 * It implements the core GenServer pattern from Elixir/OTP:
 * - Serialized message processing
 * - Synchronous calls with timeouts
 * - Asynchronous casts
 * - Lifecycle management
 *
 * @example
 * ```typescript
 * const behavior: GenServerBehavior<number, 'inc' | 'get', 'inc', number> = {
 *   init: () => 0,
 *   handleCall: (msg, state) => {
 *     if (msg === 'get') return [state, state];
 *     throw new Error('Unknown message');
 *   },
 *   handleCast: (msg, state) => {
 *     if (msg === 'inc') return state + 1;
 *     return state;
 *   },
 * };
 *
 * const ref = await GenServer.start(behavior);
 * await GenServer.cast(ref, 'inc');
 * const value = await GenServer.call(ref, 'get'); // 1
 * await GenServer.stop(ref);
 * ```
 */
export const GenServer = {
  /**
   * Starts a new GenServer with the given behavior.
   *
   * @param behavior - The behavior implementation
   * @param options - Start options (name, initTimeout)
   * @returns A reference to the started server
   * @throws {InitializationError} If init() fails or times out
   */
  async start<State, CallMsg, CastMsg, CallReply>(
    behavior: GenServerBehavior<State, CallMsg, CastMsg, CallReply>,
    options: StartOptions = {},
  ): Promise<GenServerRef<State, CallMsg, CastMsg, CallReply>> {
    const id = generateServerId();
    const initTimeout = options.initTimeout ?? DEFAULTS.INIT_TIMEOUT;

    // Create a promise that rejects on timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new InitializationError(id, new Error(`Init timed out after ${initTimeout}ms`)));
      }, initTimeout);
    });

    // Initialize state with timeout
    let initialState: State;
    try {
      initialState = await Promise.race([
        Promise.resolve(behavior.init()),
        timeoutPromise,
      ]);
    } catch (error) {
      if (error instanceof InitializationError) {
        throw error;
      }
      throw new InitializationError(
        id,
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    // Create and register the server instance
    const instance = new ServerInstance(id, behavior, initialState);
    serverRegistry.set(id, instance as ServerInstance<unknown, unknown, unknown, unknown>);
    instance.markRunning();

    const ref = createRef<State, CallMsg, CastMsg, CallReply>(id);
    emitLifecycleEvent('started', ref as GenServerRef);

    return ref;
  },

  /**
   * Sends a synchronous message and waits for a reply.
   *
   * @param ref - Reference to the target server
   * @param msg - The message to send
   * @param options - Call options (timeout)
   * @returns The reply from the server
   * @throws {CallTimeoutError} If the call times out
   * @throws {ServerNotRunningError} If the server is not running
   */
  async call<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
    msg: CallMsg,
    options: CallOptions = {},
  ): Promise<CallReply> {
    const instance = getServerInstance(ref);
    const timeout = options.timeout ?? DEFAULTS.CALL_TIMEOUT;

    if (instance.getStatus() !== 'running') {
      throw new ServerNotRunningError(ref.id);
    }

    return instance.enqueueCall(msg, timeout);
  },

  /**
   * Sends an asynchronous message without waiting for a reply.
   * This is a fire-and-forget operation.
   *
   * @param ref - Reference to the target server
   * @param msg - The message to send
   * @throws {ServerNotRunningError} If the server is not running
   */
  cast<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
    msg: CastMsg,
  ): void {
    const instance = getServerInstance(ref);

    if (instance.getStatus() !== 'running') {
      throw new ServerNotRunningError(ref.id);
    }

    instance.enqueueCast(msg);
  },

  /**
   * Gracefully stops the server.
   *
   * @param ref - Reference to the server to stop
   * @param reason - Reason for stopping (default: 'normal')
   */
  async stop<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
    reason: TerminateReason = 'normal',
  ): Promise<void> {
    const instance = serverRegistry.get(ref.id);
    if (!instance) {
      // Already stopped, nothing to do
      return;
    }

    try {
      await (instance as ServerInstance<State, CallMsg, CastMsg, CallReply>).enqueueStop(reason);
    } finally {
      serverRegistry.delete(ref.id);
      emitLifecycleEvent('terminated', ref as GenServerRef, reason);
    }
  },

  /**
   * Checks if a server is currently running.
   *
   * @param ref - Reference to check
   * @returns true if the server is running
   */
  isRunning<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
  ): boolean {
    const instance = serverRegistry.get(ref.id);
    return instance !== undefined && instance.getStatus() === 'running';
  },

  /**
   * Registers a lifecycle event handler.
   *
   * @param handler - The handler function
   * @returns A function to unregister the handler
   */
  onLifecycleEvent(handler: LifecycleHandler): () => void {
    lifecycleHandlers.add(handler);
    return () => {
      lifecycleHandlers.delete(handler);
    };
  },

  /**
   * Forces termination of a server without graceful shutdown.
   * This is primarily used by supervisors.
   *
   * @internal
   */
  _forceTerminate<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
    reason: TerminateReason,
  ): void {
    const instance = serverRegistry.get(ref.id);
    if (instance) {
      (instance as ServerInstance<State, CallMsg, CastMsg, CallReply>).forceTerminate(reason);
      serverRegistry.delete(ref.id);
      emitLifecycleEvent('terminated', ref as GenServerRef, reason);
    }
  },

  /**
   * Clears all lifecycle handlers.
   * Useful for testing.
   *
   * @internal
   */
  _clearLifecycleHandlers(): void {
    lifecycleHandlers.clear();
  },

  /**
   * Resets the server ID counter.
   * Useful for testing.
   *
   * @internal
   */
  _resetIdCounter(): void {
    serverIdCounter = 0;
  },

  /**
   * Returns statistics for a specific server.
   * Used by Observer for introspection.
   *
   * @internal
   */
  _getStats<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
  ): GenServerStats | undefined {
    const instance = serverRegistry.get(ref.id);
    if (!instance) {
      return undefined;
    }
    return (instance as ServerInstance<State, CallMsg, CastMsg, CallReply>).getStats();
  },

  /**
   * Returns statistics for all running servers.
   * Used by Observer for system-wide introspection.
   *
   * @internal
   */
  _getAllStats(): readonly GenServerStats[] {
    const stats: GenServerStats[] = [];
    for (const instance of serverRegistry.values()) {
      stats.push(instance.getStats());
    }
    return stats;
  },

  /**
   * Returns IDs of all running servers.
   * Used by Observer for enumeration.
   *
   * @internal
   */
  _getAllServerIds(): readonly string[] {
    return Array.from(serverRegistry.keys());
  },

  /**
   * Returns a GenServerRef for the given ID if the server exists.
   * Used by Observer for process control operations.
   *
   * @param id - The server ID to look up
   * @returns GenServerRef if found, undefined otherwise
   *
   * @internal
   */
  _getRefById(id: string): GenServerRef | undefined {
    if (!serverRegistry.has(id)) {
      return undefined;
    }
    return createRef(id);
  },
} as const;
