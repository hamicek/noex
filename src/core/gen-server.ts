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
  type RemoteStartOptions,
  type CallOptions,
  type ServerStatus,
  type LifecycleHandler,
  type GenServerStats,
  type MonitorId,
  type MonitorRef,
  type LinkRef,
  type TimerRef,
  type ExitSignal,
  type ProcessDownReason,
  type SerializedRef,
  CallTimeoutError,
  ServerNotRunningError,
  InitializationError,
  DEFAULTS,
} from './types.js';
import { generateMonitorId } from '../distribution/serialization.js';
import { estimateObjectSize } from '../observer/memory-utils.js';
import { Registry } from './registry.js';
import { PersistenceManager, type ManagerLoadResult } from '../persistence/manager.js';
import type { PersistenceConfig, StateMetadata } from '../persistence/types.js';
import {
  generateLinkId,
  addLink,
  removeLink,
  getLinksByServer,
  removeLinksByServer,
  getLinkCount,
  clearLinks,
} from './link-registry.js';

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
      readonly kind: 'info';
      readonly info: ExitSignal;
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

  private persistenceManager: PersistenceManager<State> | undefined;
  private snapshotTimer: ReturnType<typeof setInterval> | undefined;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private persistenceConfig: PersistenceConfig<State> | undefined;
  private readonly serverName: string | undefined;
  readonly trapExit: boolean;

  constructor(
    readonly id: string,
    private readonly behavior: GenServerBehavior<State, CallMsg, CastMsg, CallReply>,
    initialState: State,
    options?: { name?: string | undefined; persistence?: PersistenceConfig<State> | undefined; trapExit?: boolean | undefined },
  ) {
    this.state = initialState;
    this.serverName = options?.name;
    this.persistenceConfig = options?.persistence;
    this.trapExit = options?.trapExit ?? false;

    if (this.persistenceConfig) {
      const key = this.persistenceConfig.key ?? this.serverName ?? this.id;
      this.persistenceManager = new PersistenceManager<State>(this.persistenceConfig).withKey(key);
    }
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
   * Enqueues an info message (exit signal) for processing.
   */
  enqueueInfo(info: ExitSignal): void {
    this.queue.push({ kind: 'info', info });
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

    // Stop all periodic timers
    this.stopPeriodicSnapshots();
    this.stopPeriodicCleanup();

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

    // Fire and forget cleanup of persistence resources
    void this.cleanupPersistence();
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
      case 'info':
        await this.handleInfoMessage(message);
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
      // Set current process ID for _getCurrentProcessId()
      currentlyProcessingServerId = this.id;
      const result: CallResult<CallReply, State> = await Promise.resolve(
        this.behavior.handleCall(message.msg, this.state),
      );
      const [reply, newState] = result;
      this.state = newState;
      this.messageCount++;
      message.resolve(reply);
    } catch (error) {
      message.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      currentlyProcessingServerId = null;
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
      // Set current process ID for _getCurrentProcessId()
      currentlyProcessingServerId = this.id;
      const newState = await Promise.resolve(
        this.behavior.handleCast(message.msg, this.state),
      );
      this.state = newState;
      this.messageCount++;
    } catch {
      // Cast errors are silently ignored as there's no caller to notify.
      // In production, errors should be captured via lifecycle events.
    } finally {
      currentlyProcessingServerId = null;
    }
  }

  /**
   * Handles an info message (exit signal from linked process).
   */
  private async handleInfoMessage(message: {
    readonly kind: 'info';
    readonly info: ExitSignal;
  }): Promise<void> {
    if (this.status !== 'running') {
      return;
    }

    if (!this.behavior.handleInfo) {
      // No handler defined - silently ignore (trapExit was set but no handler)
      return;
    }

    try {
      currentlyProcessingServerId = this.id;
      const newState = await Promise.resolve(
        this.behavior.handleInfo(message.info, this.state),
      );
      this.state = newState;
    } catch {
      // Info handler errors are silently ignored (same as cast)
    } finally {
      currentlyProcessingServerId = null;
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

    // Stop periodic timers first
    this.stopPeriodicSnapshots();
    this.stopPeriodicCleanup();

    try {
      // Persist state on shutdown if configured
      if (this.persistenceConfig?.persistOnShutdown !== false && this.persistenceManager) {
        try {
          await this.saveSnapshot();
        } catch {
          // Persistence errors during shutdown are logged but don't fail the shutdown
          // The onError callback in persistence config handles error reporting
        }
      }

      // Cleanup persistence resources (delete data if configured, close adapter)
      await this.cleanupPersistence();

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

  /**
   * Attempts to restore state from persistence.
   * Returns the restored state and metadata, or undefined if no state was found
   * or restore is disabled.
   *
   * @throws For actual persistence errors (not StateNotFoundError)
   */
  async initializePersistence(): Promise<{ state: State; metadata: StateMetadata } | undefined> {
    if (!this.persistenceManager || this.persistenceConfig?.restoreOnStart === false) {
      return undefined;
    }

    const result = await this.persistenceManager.load();
    if (!result.success) {
      // StateNotFoundError is expected for new servers - not an error
      if (result.error.name === 'StateNotFoundError') {
        return undefined;
      }
      // Actual persistence errors should be thrown and reported
      throw result.error;
    }

    return { state: result.state, metadata: result.metadata };
  }

  /**
   * Starts periodic snapshot timer if configured.
   */
  startPeriodicSnapshots(): void {
    const intervalMs = this.persistenceConfig?.snapshotIntervalMs;
    if (!intervalMs || intervalMs <= 0 || !this.persistenceManager) {
      return;
    }

    this.snapshotTimer = setInterval(() => {
      // Fire and forget - errors are handled by onError callback
      void this.saveSnapshot().catch(() => {
        // Silently ignore - onError callback handles error reporting
      });
    }, intervalMs);

    // Don't prevent process exit
    if (this.snapshotTimer.unref) {
      this.snapshotTimer.unref();
    }
  }

  /**
   * Stops periodic snapshot timer.
   */
  stopPeriodicSnapshots(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = undefined;
    }
  }

  /**
   * Starts periodic cleanup timer if configured.
   * Periodically removes old persisted states based on maxStateAgeMs.
   */
  startPeriodicCleanup(): void {
    const { cleanupIntervalMs, maxStateAgeMs } = this.persistenceConfig ?? {};
    if (!cleanupIntervalMs || !maxStateAgeMs || !this.persistenceManager) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      void this.persistenceManager?.cleanup(maxStateAgeMs);
    }, cleanupIntervalMs);

    // Don't prevent process exit
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stops periodic cleanup timer.
   */
  stopPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * Saves current state to persistence.
   * Returns the metadata of the saved state.
   */
  async saveSnapshot(): Promise<StateMetadata> {
    if (!this.persistenceManager) {
      throw new Error('Persistence not configured for this server');
    }

    // Apply beforePersist hook if defined
    let stateToSave = this.state;
    if (this.behavior.beforePersist) {
      const transformed = this.behavior.beforePersist(this.state);
      if (transformed === undefined) {
        throw new Error('beforePersist returned undefined, skipping persistence');
      }
      stateToSave = transformed;
    }

    await this.persistenceManager.save(stateToSave, {
      serverId: this.id,
      serverName: this.serverName,
    });

    const metadata = await this.persistenceManager.getMetadata();
    if (!metadata) {
      throw new Error('Failed to retrieve metadata after save');
    }

    return metadata;
  }

  /**
   * Updates the internal state.
   * Used during state restoration.
   */
  setState(newState: State): void {
    this.state = newState;
  }

  /**
   * Returns current state.
   * Used for persistence operations.
   */
  getState(): State {
    return this.state;
  }

  /**
   * Returns the persistence manager if configured.
   */
  getPersistenceManager(): PersistenceManager<State> | undefined {
    return this.persistenceManager;
  }

  /**
   * Returns the persistence configuration if set.
   */
  getPersistenceConfig(): PersistenceConfig<State> | undefined {
    return this.persistenceConfig;
  }

  /**
   * Performs cleanup of persistence resources on server termination.
   * Deletes persisted data if cleanupOnTerminate is configured,
   * then closes the adapter connection.
   */
  private async cleanupPersistence(): Promise<void> {
    if (!this.persistenceManager) {
      return;
    }

    // Delete persisted data if configured
    if (this.persistenceConfig?.cleanupOnTerminate) {
      await this.persistenceManager.delete().catch(() => {
        // Ignore deletion errors during cleanup
      });
    }

    // Close the adapter connection
    await this.persistenceManager.close().catch(() => {
      // Ignore close errors during cleanup
    });
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

// =============================================================================
// Local Monitor Support
// =============================================================================

/**
 * Represents a local monitor (same-node monitoring).
 */
interface LocalMonitor {
  readonly monitorId: MonitorId;
  readonly monitoringServerId: string;
  readonly monitoredServerId: string;
  readonly createdAt: number;
}

/**
 * Registry of local monitors (same-node process monitoring).
 * Maps monitorId to LocalMonitor.
 */
const localMonitors = new Map<MonitorId, LocalMonitor>();

/**
 * Index: monitoredServerId -> Set of monitorIds monitoring it.
 * Enables efficient lookup when a process terminates.
 */
const localMonitorsByMonitored = new Map<string, Set<MonitorId>>();

/**
 * Index: monitoringServerId -> Set of monitorIds it created.
 * Enables cleanup when monitoring process terminates.
 */
const localMonitorsByMonitoring = new Map<string, Set<MonitorId>>();

/**
 * Adds a local monitor to the registry.
 */
function addLocalMonitor(monitor: LocalMonitor): void {
  localMonitors.set(monitor.monitorId, monitor);

  // Update monitoredServerId index
  let monitoredSet = localMonitorsByMonitored.get(monitor.monitoredServerId);
  if (!monitoredSet) {
    monitoredSet = new Set();
    localMonitorsByMonitored.set(monitor.monitoredServerId, monitoredSet);
  }
  monitoredSet.add(monitor.monitorId);

  // Update monitoringServerId index
  let monitoringSet = localMonitorsByMonitoring.get(monitor.monitoringServerId);
  if (!monitoringSet) {
    monitoringSet = new Set();
    localMonitorsByMonitoring.set(monitor.monitoringServerId, monitoringSet);
  }
  monitoringSet.add(monitor.monitorId);
}

/**
 * Removes a local monitor from the registry.
 */
function removeLocalMonitor(monitorId: MonitorId): LocalMonitor | undefined {
  const monitor = localMonitors.get(monitorId);
  if (!monitor) {
    return undefined;
  }

  localMonitors.delete(monitorId);

  // Update monitoredServerId index
  const monitoredSet = localMonitorsByMonitored.get(monitor.monitoredServerId);
  if (monitoredSet) {
    monitoredSet.delete(monitorId);
    if (monitoredSet.size === 0) {
      localMonitorsByMonitored.delete(monitor.monitoredServerId);
    }
  }

  // Update monitoringServerId index
  const monitoringSet = localMonitorsByMonitoring.get(monitor.monitoringServerId);
  if (monitoringSet) {
    monitoringSet.delete(monitorId);
    if (monitoringSet.size === 0) {
      localMonitorsByMonitoring.delete(monitor.monitoringServerId);
    }
  }

  return monitor;
}

/**
 * Gets all monitors for a monitored server ID.
 */
function getLocalMonitorsByMonitored(monitoredServerId: string): LocalMonitor[] {
  const monitorIds = localMonitorsByMonitored.get(monitoredServerId);
  if (!monitorIds) {
    return [];
  }
  const monitors: LocalMonitor[] = [];
  for (const id of monitorIds) {
    const monitor = localMonitors.get(id);
    if (monitor) {
      monitors.push(monitor);
    }
  }
  return monitors;
}

/**
 * Removes all monitors created by a monitoring server (cleanup on termination).
 */
function removeLocalMonitorsByMonitoring(monitoringServerId: string): LocalMonitor[] {
  const monitorIds = localMonitorsByMonitoring.get(monitoringServerId);
  if (!monitorIds) {
    return [];
  }
  const removed: LocalMonitor[] = [];
  for (const id of Array.from(monitorIds)) {
    const monitor = removeLocalMonitor(id);
    if (monitor) {
      removed.push(monitor);
    }
  }
  return removed;
}

/**
 * Converts TerminateReason to ProcessDownReason.
 */
function mapTerminateReason(reason: TerminateReason): ProcessDownReason {
  if (reason === 'normal') {
    return { type: 'normal' };
  }
  if (reason === 'shutdown') {
    return { type: 'shutdown' };
  }
  // reason is { error: Error }
  return {
    type: 'error',
    message: reason.error.message,
  };
}

/**
 * Cleans up remote monitors created by a terminating server.
 *
 * Called when a local GenServer terminates to remove any remote monitors
 * it had established. This follows Erlang semantics where monitors are
 * automatically cleaned up when the monitoring process terminates.
 *
 * @param serverId - The server ID of the terminated monitoring process
 */
async function cleanupRemoteMonitorsForServer(serverId: string): Promise<void> {
  try {
    const { RemoteMonitor } = await import('../distribution/monitor/index.js');
    RemoteMonitor._handleMonitoringProcessTerminated(serverId);
  } catch {
    // Distribution module may not be available or cluster not running
    // This is fine - no remote monitors to clean up
  }
}

/**
 * Notifies all monitoring processes when a monitored process terminates.
 * Emits process_down lifecycle events and cleans up the monitor registry.
 */
async function notifyLocalMonitorsOfTermination(
  terminatedServerId: string,
  reason: TerminateReason,
): Promise<void> {
  const monitors = getLocalMonitorsByMonitored(terminatedServerId);
  if (monitors.length === 0) {
    return;
  }

  const processDownReason = mapTerminateReason(reason);

  // Get local node ID if cluster is running
  let localNodeId: string;
  try {
    const { Cluster } = await import('../distribution/cluster/cluster.js');
    if (Cluster.getStatus() === 'running') {
      localNodeId = Cluster.getLocalNodeId() as string;
    } else {
      localNodeId = 'local';
    }
  } catch {
    localNodeId = 'local';
  }

  const monitoredRef: SerializedRef = {
    id: terminatedServerId,
    nodeId: localNodeId as SerializedRef['nodeId'],
  };

  // Emit process_down for each monitor
  for (const monitor of monitors) {
    const monitoringRef = createRef(monitor.monitoringServerId);
    GenServer._emitProcessDown(
      monitoringRef,
      monitoredRef,
      processDownReason,
      monitor.monitorId,
    );
  }

  // Clean up all monitors for the terminated server
  for (const monitor of monitors) {
    removeLocalMonitor(monitor.monitorId);
  }
}

/**
 * Propagates exit signals to all processes linked to the terminated process.
 *
 * Follows Erlang semantics:
 * - Normal exits ('normal') do NOT propagate - links are simply removed.
 * - Abnormal exits propagate to linked processes:
 *   - If peer has trapExit: deliver ExitSignal via handleInfo
 *   - If peer does not trap exits: force terminate the peer
 */
function propagateExitToLinkedProcesses(
  terminatedServerId: string,
  reason: TerminateReason,
): void {
  const linkedPeers = removeLinksByServer(terminatedServerId);
  if (linkedPeers.length === 0) {
    return;
  }

  // Normal exit does not propagate - links are already removed above
  if (reason === 'normal') {
    return;
  }

  const processDownReason = mapTerminateReason(reason);

  // Get local node ID for the serialized ref
  let localNodeId = 'local';
  // Note: We use synchronous approach here as this is called from
  // synchronous forceTerminate path. For the async stop path,
  // the node ID is determined beforehand.

  const fromRef: SerializedRef = {
    id: terminatedServerId,
    nodeId: localNodeId as SerializedRef['nodeId'],
  };

  for (const { peerServerId } of linkedPeers) {
    const peerInstance = serverRegistry.get(peerServerId);
    if (!peerInstance || peerInstance.getStatus() !== 'running') {
      continue;
    }

    if (peerInstance.trapExit) {
      // Deliver exit signal as info message
      const exitSignal: ExitSignal = {
        type: 'EXIT',
        from: fromRef,
        reason: processDownReason,
      };
      peerInstance.enqueueInfo(exitSignal);
    } else {
      // Force terminate the peer (cascading link propagation)
      const peerRef = createRef(peerServerId);
      GenServer._forceTerminate(peerRef, {
        error: new Error(`Linked process '${terminatedServerId}' exited`),
      });
    }
  }
}

/**
 * Counter for generating unique server IDs.
 */
let serverIdCounter = 0;

/**
 * Tracks the currently processing server ID.
 * Used by _getCurrentProcessId() to allow handlers to get their own ID.
 */
let currentlyProcessingServerId: string | null = null;

/**
 * Counter for generating unique timer IDs.
 */
let timerIdCounter = 0;

/**
 * Registry of active timers. Maps timerId to the timeout handle.
 */
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Generates a unique timer ID.
 */
function generateTimerId(): string {
  return `timer_${++timerIdCounter}_${Date.now().toString(36)}`;
}

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
  type: 'state_restored',
  ref: GenServerRef,
  metadata: StateMetadata,
): void;
function emitLifecycleEvent(
  type: 'state_persisted',
  ref: GenServerRef,
  metadata: StateMetadata,
): void;
function emitLifecycleEvent(
  type: 'persistence_error',
  ref: GenServerRef,
  error: Error,
): void;
function emitLifecycleEvent(
  type: 'started' | 'crashed' | 'terminated' | 'state_restored' | 'state_persisted' | 'persistence_error',
  ref: GenServerRef,
  extra?: Error | TerminateReason | StateMetadata,
): void {
  if (lifecycleHandlers.size === 0) return;

  let event;
  switch (type) {
    case 'started':
      event = { type, ref } as const;
      break;
    case 'crashed':
      event = { type, ref, error: extra as Error } as const;
      break;
    case 'terminated':
      event = { type, ref, reason: extra as TerminateReason } as const;
      break;
    case 'state_restored':
      event = { type, ref, metadata: extra as StateMetadata } as const;
      break;
    case 'state_persisted':
      event = { type, ref, metadata: extra as StateMetadata } as const;
      break;
    case 'persistence_error':
      event = { type, ref, error: extra as Error } as const;
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
 * Checks if a nodeId refers to a remote node.
 *
 * @param nodeId - Node identifier to check
 * @returns true if the node is remote, false if local or cluster not running
 */
async function isRemoteRef(nodeId: string): Promise<boolean> {
  try {
    const { Cluster } = await import('../distribution/cluster/cluster.js');
    if (Cluster.getStatus() !== 'running') {
      return false;
    }
    const localNodeId = Cluster.getLocalNodeId();
    return nodeId !== localNodeId;
  } catch {
    // Cluster module not available or not running
    return false;
  }
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
   * @param options - Start options (name, initTimeout, persistence)
   * @returns A reference to the started server
   * @throws {InitializationError} If init() fails or times out
   * @throws {AlreadyRegisteredError} If options.name is already registered
   */
  async start<State, CallMsg, CastMsg, CallReply>(
    behavior: GenServerBehavior<State, CallMsg, CastMsg, CallReply>,
    options: StartOptions<State> = {},
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

    // Create and register the server instance with persistence config
    const instance = new ServerInstance(id, behavior, initialState, {
      name: options.name,
      persistence: options.persistence,
      trapExit: options.trapExit,
    });
    serverRegistry.set(id, instance as ServerInstance<unknown, unknown, unknown, unknown>);

    const ref = createRef<State, CallMsg, CastMsg, CallReply>(id);

    // Try to restore state from persistence if configured
    if (options.persistence) {
      try {
        const restored = await instance.initializePersistence();
        if (restored) {
          // Apply onStateRestore hook if defined
          let stateToUse = restored.state;
          if (behavior.onStateRestore) {
            stateToUse = await Promise.resolve(
              behavior.onStateRestore(restored.state, restored.metadata)
            );
          }
          instance.setState(stateToUse);
          emitLifecycleEvent('state_restored', ref as GenServerRef, restored.metadata);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        options.persistence.onError?.(err);
        emitLifecycleEvent('persistence_error', ref as GenServerRef, err);
        // Continue with init state - persistence errors don't fail startup
      }
    }

    instance.markRunning();

    // Register in Registry if name is provided
    if (options.name) {
      try {
        Registry.register(options.name, ref);
      } catch (error) {
        // Rollback: clean up the server instance on registration failure
        instance.stopPeriodicSnapshots();
        serverRegistry.delete(id);
        throw error;
      }
    }

    // Start periodic snapshots and cleanup after successful startup
    instance.startPeriodicSnapshots();
    instance.startPeriodicCleanup();

    emitLifecycleEvent('started', ref as GenServerRef);

    return ref;
  },

  /**
   * Starts a GenServer on a remote cluster node.
   *
   * The behavior must be pre-registered on the target node using BehaviorRegistry,
   * as JavaScript functions cannot be serialized and transmitted over the network.
   *
   * @param behaviorName - Name of the behavior registered in BehaviorRegistry on the target node
   * @param options - Remote start options including target node and registration strategy
   * @returns A reference to the remotely started server
   * @throws {ClusterNotStartedError} If the cluster is not running
   * @throws {NodeNotReachableError} If the target node is not connected
   * @throws {BehaviorNotFoundError} If the behavior is not registered on the target node
   * @throws {RemoteSpawnTimeoutError} If the spawn operation times out
   * @throws {RemoteSpawnInitError} If initialization fails on the target node
   * @throws {RemoteSpawnRegistrationError} If name registration fails on the target node
   *
   * @example
   * ```typescript
   * import { GenServer, BehaviorRegistry, Cluster } from 'noex';
   *
   * // 1. Register behavior on ALL nodes (including target)
   * BehaviorRegistry.register('counter', counterBehavior);
   *
   * // 2. Start cluster
   * await Cluster.start({ nodeName: 'app1', port: 4369 });
   *
   * // 3. Spawn on remote node
   * const ref = await GenServer.startRemote('counter', {
   *   targetNode: 'app2@192.168.1.2:4370',
   *   name: 'remote-counter',
   *   registration: 'global',
   * });
   *
   * // 4. Use transparently (calls are automatically routed)
   * const count = await GenServer.call(ref, { type: 'get' });
   * ```
   */
  async startRemote<State, CallMsg, CastMsg, CallReply>(
    behaviorName: string,
    options: RemoteStartOptions<State>,
  ): Promise<GenServerRef<State, CallMsg, CastMsg, CallReply>> {
    // Import distribution modules dynamically to avoid circular dependencies
    const { RemoteSpawn, NodeId } = await import('../distribution/index.js');

    // Parse target node ID (accepts both string and NodeId)
    const targetNodeId = NodeId.isValid(options.targetNode)
      ? NodeId.parse(options.targetNode)
      : NodeId.parse(options.targetNode);

    // Build spawn options from RemoteStartOptions (exactOptionalPropertyTypes compliant)
    const spawnOptions: Parameters<typeof RemoteSpawn.spawn>[2] = {};

    // Only include timeout if provided
    if (options.spawnTimeout !== undefined) {
      (spawnOptions as { timeout: number }).timeout = options.spawnTimeout;
    }

    // Only include name if provided
    if (options.name !== undefined) {
      (spawnOptions as { name: string }).name = options.name;
    }

    // Only include initTimeout if provided
    if (options.initTimeout !== undefined) {
      (spawnOptions as { initTimeout: number }).initTimeout = options.initTimeout;
    }

    // Map registration strategy (default to 'local' if name is provided)
    if (options.registration !== undefined) {
      (spawnOptions as { registration: 'local' | 'global' | 'none' }).registration = options.registration;
    } else if (options.name !== undefined) {
      // Default to 'local' registration when name is provided
      (spawnOptions as { registration: 'local' | 'global' | 'none' }).registration = 'local';
    }

    // Execute remote spawn
    const result = await RemoteSpawn.spawn(behaviorName, targetNodeId, spawnOptions);

    // Construct and return GenServerRef with nodeId for transparent remote routing
    // Use unknown intermediate cast for branded type (RefBrand is internal)
    return {
      id: result.serverId,
      nodeId: result.nodeId,
    } as unknown as GenServerRef<State, CallMsg, CastMsg, CallReply>;
  },

  /**
   * Sends a synchronous message and waits for a reply.
   *
   * Automatically routes to remote nodes when the ref has a nodeId
   * that differs from the local node.
   *
   * @param ref - Reference to the target server
   * @param msg - The message to send
   * @param options - Call options (timeout)
   * @returns The reply from the server
   * @throws {CallTimeoutError} If the call times out
   * @throws {ServerNotRunningError} If the server is not running
   * @throws {RemoteCallTimeoutError} If remote call times out
   * @throws {NodeNotReachableError} If remote node is not connected
   */
  async call<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
    msg: CallMsg,
    options: CallOptions = {},
  ): Promise<CallReply> {
    const timeout = options.timeout ?? DEFAULTS.CALL_TIMEOUT;

    // Check if this is a remote call
    if (ref.nodeId !== undefined) {
      const isRemote = await isRemoteRef(ref.nodeId);
      if (isRemote) {
        const { RemoteCall } = await import('../distribution/remote/index.js');
        const { NodeId: NodeIdUtils } = await import('../distribution/node-id.js');
        // Cast to NodeId type for remote call (nodeId is already validated at this point)
        const remoteNodeId = ref.nodeId as ReturnType<typeof NodeIdUtils.parse>;
        return RemoteCall.call<CallReply>(
          { id: ref.id, nodeId: remoteNodeId },
          msg,
          { timeout },
        );
      }
    }

    // Local call
    const instance = getServerInstance(ref);

    if (instance.getStatus() !== 'running') {
      throw new ServerNotRunningError(ref.id);
    }

    return instance.enqueueCall(msg, timeout);
  },

  /**
   * Sends an asynchronous message without waiting for a reply.
   * This is a fire-and-forget operation.
   *
   * Automatically routes to remote nodes when the ref has a nodeId
   * that differs from the local node.
   *
   * @param ref - Reference to the target server
   * @param msg - The message to send
   * @throws {ServerNotRunningError} If the server is not running (local only)
   */
  cast<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
    msg: CastMsg,
  ): void {
    // Check if this is potentially a remote cast
    if (ref.nodeId !== undefined) {
      // Fire and forget remote cast attempt
      void (async () => {
        try {
          const isRemote = await isRemoteRef(ref.nodeId!);
          if (isRemote) {
            const { RemoteCall } = await import('../distribution/remote/index.js');
            const { NodeId: NodeIdUtils } = await import('../distribution/node-id.js');
            // Cast to NodeId type for remote call (nodeId is already validated at this point)
            const remoteNodeId = ref.nodeId as ReturnType<typeof NodeIdUtils.parse>;
            RemoteCall.cast({ id: ref.id, nodeId: remoteNodeId }, msg);
            return;
          }
        } catch {
          // If remote check fails, fall through to local
        }

        // Local fallback
        const instance = serverRegistry.get(ref.id);
        if (instance && instance.getStatus() === 'running') {
          instance.enqueueCast(msg);
        }
      })();
      return;
    }

    // Local cast
    const instance = getServerInstance(ref);

    if (instance.getStatus() !== 'running') {
      throw new ServerNotRunningError(ref.id);
    }

    instance.enqueueCast(msg);
  },

  /**
   * Schedules a cast message to be delivered after a delay.
   * Non-durable: the timer does not survive process restarts.
   *
   * If the target process is no longer running when the timer fires,
   * the message is silently discarded.
   *
   * @param ref - Reference to the target server
   * @param msg - The cast message to send
   * @param delayMs - Delay in milliseconds before sending
   * @returns A TimerRef that can be used with cancelTimer()
   *
   * @example
   * ```typescript
   * // Send a 'tick' message every second
   * const timerRef = GenServer.sendAfter(ref, 'tick', 1000);
   *
   * // Cancel if needed
   * GenServer.cancelTimer(timerRef);
   * ```
   */
  sendAfter<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
    msg: CastMsg,
    delayMs: number,
  ): TimerRef {
    const timerId = generateTimerId();

    const handle = setTimeout(() => {
      activeTimers.delete(timerId);
      const instance = serverRegistry.get(ref.id);
      if (instance && instance.getStatus() === 'running') {
        instance.enqueueCast(msg);
      }
    }, delayMs);

    activeTimers.set(timerId, handle);

    return { timerId } as TimerRef;
  },

  /**
   * Cancels a previously scheduled timer.
   *
   * @param timerRef - Reference to the timer to cancel
   * @returns true if the timer was still pending and was cancelled,
   *          false if it had already fired or was previously cancelled
   */
  cancelTimer(timerRef: TimerRef): boolean {
    const handle = activeTimers.get(timerRef.timerId);
    if (handle === undefined) {
      return false;
    }
    clearTimeout(handle);
    activeTimers.delete(timerRef.timerId);
    return true;
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

      // Propagate exit to linked processes (before monitors, as propagation may cause further terminations)
      propagateExitToLinkedProcesses(ref.id, reason);

      // Notify all processes monitoring this server
      notifyLocalMonitorsOfTermination(ref.id, reason);

      // Cleanup monitors created by this server (local)
      removeLocalMonitorsByMonitoring(ref.id);

      // Cleanup remote monitors created by this server (fire and forget)
      void cleanupRemoteMonitorsForServer(ref.id);

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
   * Establishes a monitor on another process.
   *
   * When the monitored process terminates, the monitoring process
   * receives a `process_down` lifecycle event with the termination reason.
   *
   * Monitors are one-way: the monitoring process is notified but not affected
   * by the monitored process's termination (unlike links).
   *
   * Automatically detects whether the monitored process is local or remote
   * and uses the appropriate monitoring mechanism.
   *
   * @param monitoringRef - Reference to the process that will receive notifications
   * @param monitoredRef - Reference to the process to monitor
   * @returns A MonitorRef for later demonitoring
   * @throws {ServerNotRunningError} If the monitoring process is not running
   *
   * @example
   * ```typescript
   * // Start monitoring a remote process
   * const monitorRef = await GenServer.monitor(localServer, remoteServer);
   *
   * // Listen for process_down events
   * GenServer.onLifecycleEvent((event) => {
   *   if (event.type === 'process_down' && event.monitorId === monitorRef.monitorId) {
   *     console.log(`Process ${event.monitoredRef.id} went down: ${event.reason.type}`);
   *   }
   * });
   *
   * // Later, to stop monitoring:
   * await GenServer.demonitor(monitorRef);
   * ```
   */
  async monitor<State, CallMsg, CastMsg, CallReply>(
    monitoringRef: GenServerRef<State, CallMsg, CastMsg, CallReply>,
    monitoredRef: GenServerRef,
  ): Promise<MonitorRef> {
    // Verify monitoring process exists locally
    const monitoringInstance = serverRegistry.get(monitoringRef.id);
    if (!monitoringInstance || monitoringInstance.getStatus() !== 'running') {
      throw new ServerNotRunningError(monitoringRef.id);
    }

    // Determine if monitored process is local or remote
    const monitoredNodeId = monitoredRef.nodeId;
    const isRemote = monitoredNodeId !== undefined && await isRemoteRef(monitoredNodeId);

    if (isRemote) {
      // Remote monitoring - delegate to RemoteMonitor
      const { RemoteMonitor } = await import('../distribution/monitor/index.js');
      return RemoteMonitor.monitor(monitoringRef as GenServerRef, monitoredRef);
    }

    // Local monitoring - handle within GenServer
    const monitorId = generateMonitorId();

    // Check if monitored process exists
    const monitoredInstance = serverRegistry.get(monitoredRef.id);
    const processExists = monitoredInstance !== undefined && monitoredInstance.getStatus() === 'running';

    // Get local node ID if cluster is running
    let localNodeId: string;
    try {
      const { Cluster } = await import('../distribution/cluster/cluster.js');
      if (Cluster.getStatus() === 'running') {
        localNodeId = Cluster.getLocalNodeId() as string;
      } else {
        localNodeId = 'local';
      }
    } catch {
      localNodeId = 'local';
    }

    const monitoredSerializedRef: SerializedRef = {
      id: monitoredRef.id,
      nodeId: localNodeId as SerializedRef['nodeId'],
    };

    const monitorRef: MonitorRef = {
      monitorId,
      monitoredRef: monitoredSerializedRef,
    };

    if (!processExists) {
      // Process doesn't exist - immediately emit process_down with 'noproc'
      // This follows Erlang semantics where monitor setup always succeeds
      // but you get immediate notification if the process doesn't exist
      queueMicrotask(() => {
        GenServer._emitProcessDown(
          monitoringRef as GenServerRef,
          monitoredSerializedRef,
          { type: 'noproc' },
          monitorId,
        );
      });
      return monitorRef;
    }

    // Register the local monitor
    addLocalMonitor({
      monitorId,
      monitoringServerId: monitoringRef.id,
      monitoredServerId: monitoredRef.id,
      createdAt: Date.now(),
    });

    return monitorRef;
  },

  /**
   * Removes a previously established monitor.
   *
   * After calling demonitor, no more process_down notifications will be
   * received for this monitor, even if the monitored process terminates.
   *
   * @param monitorRef - Reference to the monitor to remove
   * @param options - Demonitor options
   * @param options.flush - If true, also removes any pending process_down
   *                        messages from the message queue (not yet implemented)
   *
   * @example
   * ```typescript
   * const monitorRef = await GenServer.monitor(localServer, remoteServer);
   * // ... later ...
   * await GenServer.demonitor(monitorRef);
   * ```
   */
  async demonitor(
    monitorRef: MonitorRef,
    options?: { readonly flush?: boolean },
  ): Promise<void> {
    // First, try to remove from local monitors
    const localMonitor = removeLocalMonitor(monitorRef.monitorId);
    if (localMonitor) {
      return; // Was a local monitor, nothing more to do
    }

    // Not a local monitor - try remote demonitor
    try {
      const { RemoteMonitor } = await import('../distribution/monitor/index.js');
      await RemoteMonitor.demonitor(monitorRef);
    } catch {
      // Ignore errors - monitor might already be gone
    }
  },

  /**
   * Creates a bidirectional link between two processes.
   *
   * When one linked process terminates abnormally, the other is also
   * terminated - unless it has trapExit enabled, in which case it
   * receives an ExitSignal via handleInfo.
   *
   * Normal exits ('normal' reason) do NOT propagate through links.
   * Links are simply removed when a process exits normally.
   *
   * @param ref1 - Reference to the first process
   * @param ref2 - Reference to the second process
   * @returns A LinkRef for later unlinking
   * @throws {ServerNotRunningError} If either process is not running
   *
   * @example
   * ```typescript
   * const linkRef = await GenServer.link(serverA, serverB);
   * // If serverB crashes, serverA is also terminated.
   * // Unless serverA was started with { trapExit: true }
   * ```
   */
  async link(
    ref1: GenServerRef,
    ref2: GenServerRef,
  ): Promise<LinkRef> {
    // Verify both processes exist and are running
    const instance1 = serverRegistry.get(ref1.id);
    if (!instance1 || instance1.getStatus() !== 'running') {
      throw new ServerNotRunningError(ref1.id);
    }

    const instance2 = serverRegistry.get(ref2.id);
    if (!instance2 || instance2.getStatus() !== 'running') {
      throw new ServerNotRunningError(ref2.id);
    }

    const linkId = generateLinkId();

    // Get local node ID
    let localNodeId = 'local';
    try {
      const { Cluster } = await import('../distribution/cluster/cluster.js');
      if (Cluster.getStatus() === 'running') {
        localNodeId = Cluster.getLocalNodeId() as string;
      }
    } catch {
      // Cluster not available
    }

    const serializedRef1: SerializedRef = {
      id: ref1.id,
      nodeId: localNodeId as SerializedRef['nodeId'],
    };

    const serializedRef2: SerializedRef = {
      id: ref2.id,
      nodeId: localNodeId as SerializedRef['nodeId'],
    };

    // Register the link
    addLink({
      linkId,
      serverId1: ref1.id,
      serverId2: ref2.id,
      createdAt: Date.now(),
    });

    return {
      linkId,
      ref1: serializedRef1,
      ref2: serializedRef2,
    };
  },

  /**
   * Removes a bidirectional link between two processes.
   *
   * After unlinking, termination of one process will no longer
   * affect the other.
   *
   * @param linkRef - Reference to the link to remove
   *
   * @example
   * ```typescript
   * const linkRef = await GenServer.link(serverA, serverB);
   * // Later, to prevent propagation:
   * await GenServer.unlink(linkRef);
   * ```
   */
  async unlink(linkRef: LinkRef): Promise<void> {
    removeLink(linkRef.linkId);
  },

  /**
   * Manually triggers a state checkpoint (persistence snapshot).
   *
   * This is useful for creating savepoints at critical moments,
   * independent of the automatic periodic snapshots.
   *
   * @param ref - Reference to the server
   * @throws {Error} If persistence is not configured for this server
   * @throws {ServerNotRunningError} If the server is not running
   *
   * @example
   * ```typescript
   * // After completing a critical operation
   * await GenServer.checkpoint(ref);
   * ```
   */
  async checkpoint<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
  ): Promise<void> {
    const instance = serverRegistry.get(ref.id);
    if (!instance) {
      throw new ServerNotRunningError(ref.id);
    }

    const typedInstance = instance as ServerInstance<State, CallMsg, CastMsg, CallReply>;
    if (typedInstance.getStatus() !== 'running') {
      throw new ServerNotRunningError(ref.id);
    }

    try {
      const metadata = await typedInstance.saveSnapshot();
      emitLifecycleEvent('state_persisted', ref as GenServerRef, metadata);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      typedInstance.getPersistenceConfig()?.onError?.(err);
      emitLifecycleEvent('persistence_error', ref as GenServerRef, err);
      throw err;
    }
  },

  /**
   * Returns metadata from the last persisted checkpoint.
   *
   * @param ref - Reference to the server
   * @returns Metadata if checkpoint exists, undefined otherwise
   * @throws {Error} If persistence is not configured for this server
   *
   * @example
   * ```typescript
   * const meta = await GenServer.getLastCheckpointMeta(ref);
   * if (meta) {
   *   console.log(`Last saved: ${new Date(meta.persistedAt)}`);
   * }
   * ```
   */
  async getLastCheckpointMeta<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
  ): Promise<StateMetadata | undefined> {
    const instance = serverRegistry.get(ref.id);
    if (!instance) {
      return undefined;
    }

    const typedInstance = instance as ServerInstance<State, CallMsg, CastMsg, CallReply>;
    const manager = typedInstance.getPersistenceManager();
    if (!manager) {
      throw new Error('Persistence not configured for this server');
    }

    return manager.getMetadata();
  },

  /**
   * Clears any persisted state for this server.
   *
   * Use this to remove stale or corrupted persisted state.
   * The server continues running with its current in-memory state.
   *
   * @param ref - Reference to the server
   * @returns true if state was deleted, false if no state existed
   * @throws {Error} If persistence is not configured for this server
   *
   * @example
   * ```typescript
   * // Clear corrupted state before restart
   * await GenServer.clearPersistedState(ref);
   * ```
   */
  async clearPersistedState<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
  ): Promise<boolean> {
    const instance = serverRegistry.get(ref.id);
    if (!instance) {
      throw new ServerNotRunningError(ref.id);
    }

    const typedInstance = instance as ServerInstance<State, CallMsg, CastMsg, CallReply>;
    const manager = typedInstance.getPersistenceManager();
    if (!manager) {
      throw new Error('Persistence not configured for this server');
    }

    return manager.delete();
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

      // Propagate exit to linked processes
      propagateExitToLinkedProcesses(ref.id, reason);

      // Notify local monitors synchronously (fire and forget async operation)
      void notifyLocalMonitorsOfTermination(ref.id, reason);

      // Cleanup monitors created by this server (local)
      removeLocalMonitorsByMonitoring(ref.id);

      // Cleanup remote monitors created by this server (fire and forget)
      void cleanupRemoteMonitorsForServer(ref.id);

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

  /**
   * Returns the number of active local monitors.
   * Useful for testing.
   *
   * @internal
   */
  _getLocalMonitorCount(): number {
    return localMonitors.size;
  },

  /**
   * Clears all local monitors.
   * Useful for testing cleanup.
   *
   * @internal
   */
  _clearLocalMonitors(): void {
    localMonitors.clear();
    localMonitorsByMonitored.clear();
    localMonitorsByMonitoring.clear();
  },

  /**
   * Emits a process_down lifecycle event for a monitored process termination.
   *
   * Called by RemoteMonitor when a monitored process goes down.
   *
   * @param monitoringRef - Reference to the local process doing the monitoring
   * @param monitoredRef - Reference to the process that went down
   * @param reason - Reason for the process going down
   * @param monitorId - Monitor identifier
   *
   * @internal
   */
  _emitProcessDown(
    monitoringRef: GenServerRef,
    monitoredRef: SerializedRef,
    reason: ProcessDownReason,
    monitorId: MonitorId,
  ): void {
    if (lifecycleHandlers.size === 0) return;

    const event = {
      type: 'process_down' as const,
      ref: monitoringRef,
      monitoredRef,
      reason,
      monitorId,
    };

    for (const handler of lifecycleHandlers) {
      try {
        handler(event);
      } catch {
        // Lifecycle handlers should not throw, but if they do, ignore it
      }
    }
  },

  /**
   * Returns the ID of the currently processing GenServer.
   *
   * This method only returns a valid ID when called synchronously from within
   * a handleCall or handleCast handler. Outside of message processing context,
   * it returns null.
   *
   * Note: This will NOT work in asynchronous callbacks like setTimeout.
   * For async cases, store the ID in your state during init or configure.
   *
   * @returns The server ID if called during message processing, null otherwise
   *
   * @internal
   */
  _getCurrentProcessId(): string | null {
    return currentlyProcessingServerId;
  },

  /**
   * Returns the number of active local links.
   * Useful for testing.
   *
   * @internal
   */
  _getLocalLinkCount(): number {
    return getLinkCount();
  },

  /**
   * Clears all local links.
   * Useful for testing cleanup.
   *
   * @internal
   */
  _clearLocalLinks(): void {
    clearLinks();
  },

  /**
   * Delivers an exit signal from a remote linked process to a local process.
   *
   * If the local process has trapExit enabled, the signal is delivered
   * as an info message. Otherwise, the process is force-terminated.
   *
   * @param serverId - ID of the local process to deliver the signal to
   * @param fromRef - Reference to the remote process that exited
   * @param reason - Reason for the remote process's termination
   * @returns true if the signal was delivered, false if process not found
   *
   * @internal
   */
  _deliverRemoteExitSignal(
    serverId: string,
    fromRef: SerializedRef,
    reason: ProcessDownReason,
  ): boolean {
    const instance = serverRegistry.get(serverId);
    if (!instance || instance.getStatus() !== 'running') {
      return false;
    }

    if (instance.trapExit) {
      const exitSignal: ExitSignal = {
        type: 'EXIT',
        from: fromRef,
        reason,
      };
      instance.enqueueInfo(exitSignal);
    } else {
      const ref = createRef(serverId);
      GenServer._forceTerminate(ref, {
        error: new Error(`Linked process '${fromRef.id}' on node '${fromRef.nodeId}' exited`),
      });
    }

    return true;
  },

  /**
   * Cancels all active timers and resets the timer ID counter.
   * Useful for testing cleanup.
   *
   * @internal
   */
  _clearTimers(): void {
    for (const handle of activeTimers.values()) {
      clearTimeout(handle);
    }
    activeTimers.clear();
    timerIdCounter = 0;
  },
} as const;
