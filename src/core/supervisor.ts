/**
 * Supervisor implementation for TypeScript.
 *
 * Provides Elixir-style supervision tree with:
 * - Automatic child process restart on failure
 * - Multiple restart strategies (one_for_one, one_for_all, rest_for_one)
 * - Restart intensity limiting to prevent infinite restart loops
 * - Dynamic child management (start/terminate)
 * - Graceful shutdown with ordered termination
 */

import {
  type GenServerRef,
  type SupervisorRef,
  type SupervisorOptions,
  type SupervisorStrategy,
  type ChildSpec,
  type ChildRestartStrategy,
  type ChildInfo,
  type TerminateReason,
  type LifecycleHandler,
  type LifecycleEvent,
  type SupervisorStats,
  type AutoShutdown,
  type ChildTemplate,
  MaxRestartsExceededError,
  DuplicateChildError,
  ChildNotFoundError,
  MissingChildTemplateError,
  InvalidSimpleOneForOneConfigError,
  DEFAULTS,
} from './types.js';
import { GenServer } from './gen-server.js';

/**
 * Internal state for tracking a running child.
 */
interface RunningChild {
  readonly id: string;
  readonly spec: ChildSpec;
  ref: GenServerRef;
  restartCount: number;
  readonly restartTimestamps: number[];
  /** Exit reason from the last termination (used for transient restart strategy). */
  lastExitReason?: TerminateReason;
  /** Unsubscribe function for lifecycle event listener. */
  lifecycleUnsubscribe?: () => void;
}

/**
 * Internal supervisor instance that manages children.
 */
class SupervisorInstance {
  private readonly children: Map<string, RunningChild> = new Map();
  private readonly childOrder: string[] = [];
  private running = true;
  private shuttingDown = false;
  private readonly restartTimestamps: number[] = [];
  private readonly startedAt: number = Date.now();
  private totalRestarts = 0;
  private childIdCounter = 0;

  constructor(
    readonly id: string,
    private readonly strategy: SupervisorStrategy,
    private readonly maxRestarts: number,
    private readonly restartWithinMs: number,
    private readonly autoShutdown: AutoShutdown,
    private readonly childTemplate?: ChildTemplate,
  ) {}

  /**
   * Returns supervisor info.
   */
  getInfo(): { readonly strategy: SupervisorStrategy; readonly childCount: number } {
    return {
      strategy: this.strategy,
      childCount: this.children.size,
    };
  }

  /**
   * Returns comprehensive statistics for this supervisor instance.
   */
  getStats(): SupervisorStats {
    return {
      id: this.id,
      strategy: this.strategy,
      childCount: this.children.size,
      totalRestarts: this.totalRestarts,
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  /**
   * Returns information about all children.
   */
  getChildren(): readonly ChildInfo[] {
    return this.childOrder
      .filter((id) => this.children.has(id))
      .map((id) => {
        const child = this.children.get(id)!;
        return {
          id: child.id,
          ref: child.ref,
          spec: child.spec,
          restartCount: child.restartCount,
        };
      });
  }

  /**
   * Returns a specific child by ID.
   */
  getChild(childId: string): ChildInfo | undefined {
    const child = this.children.get(childId);
    if (!child) return undefined;
    return {
      id: child.id,
      ref: child.ref,
      spec: child.spec,
      restartCount: child.restartCount,
    };
  }

  /**
   * Starts all children from specs.
   */
  async startChildren(specs: readonly ChildSpec[]): Promise<void> {
    for (const spec of specs) {
      await this.startChild(spec);
    }
  }

  /**
   * Starts a single child.
   * @throws {DuplicateChildError} if child with same ID exists
   */
  async startChild(spec: ChildSpec): Promise<GenServerRef> {
    if (this.children.has(spec.id)) {
      throw new DuplicateChildError(this.id, spec.id);
    }

    const ref = await spec.start();

    const child: RunningChild = {
      id: spec.id,
      spec,
      ref,
      restartCount: 0,
      restartTimestamps: [],
    };

    this.children.set(spec.id, child);
    this.childOrder.push(spec.id);

    this.watchChild(child);

    return ref;
  }

  /**
   * Starts a child from the template with given arguments.
   * Only valid for simple_one_for_one supervisors.
   */
  async startChildFromTemplate(args: unknown[]): Promise<GenServerRef> {
    if (!this.childTemplate) {
      throw new MissingChildTemplateError(this.id);
    }

    const childId = `child_${++this.childIdCounter}`;
    const ref = await this.childTemplate.start(...args);

    // Build spec with only defined properties to satisfy exactOptionalPropertyTypes
    const spec: ChildSpec = {
      id: childId,
      start: async () => this.childTemplate!.start(...args),
      ...(this.childTemplate.restart !== undefined && { restart: this.childTemplate.restart }),
      ...(this.childTemplate.shutdownTimeout !== undefined && { shutdownTimeout: this.childTemplate.shutdownTimeout }),
      ...(this.childTemplate.significant !== undefined && { significant: this.childTemplate.significant }),
    };

    const child: RunningChild = {
      id: childId,
      spec,
      ref,
      restartCount: 0,
      restartTimestamps: [],
    };

    this.children.set(childId, child);
    this.childOrder.push(childId);

    this.watchChild(child);

    return ref;
  }

  /**
   * Returns true if this is a simple_one_for_one supervisor.
   */
  isSimpleOneForOne(): boolean {
    return this.strategy === 'simple_one_for_one';
  }

  /**
   * Terminates a specific child.
   * @throws {ChildNotFoundError} if child not found
   */
  async terminateChild(childId: string): Promise<void> {
    const child = this.children.get(childId);
    if (!child) {
      throw new ChildNotFoundError(this.id, childId);
    }

    const spec = child.spec;
    await this.stopChild(child, 'shutdown');
    this.removeChild(childId);

    // Check auto_shutdown after child removal
    if (this.checkAutoShutdown(spec)) {
      const ref = supervisorRefs.get(this.id)!;
      void Supervisor.stop(ref, 'shutdown');
    }
  }

  /**
   * Restarts a specific child.
   * @throws {ChildNotFoundError} if child not found
   */
  async restartChild(childId: string): Promise<GenServerRef> {
    const child = this.children.get(childId);
    if (!child) {
      throw new ChildNotFoundError(this.id, childId);
    }

    await this.stopChild(child, 'shutdown');

    const newRef = await child.spec.start();
    child.ref = newRef;
    child.restartCount++;

    this.watchChild(child);

    return newRef;
  }

  /**
   * Gracefully shuts down all children in reverse order.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.running = false;

    // Stop children in reverse order (last started = first stopped)
    const reversedOrder = [...this.childOrder].reverse();

    for (const childId of reversedOrder) {
      const child = this.children.get(childId);
      if (child) {
        await this.stopChild(child, 'shutdown');
      }
    }

    // Clean up all lifecycle listeners
    for (const child of this.children.values()) {
      child.lifecycleUnsubscribe?.();
    }

    this.children.clear();
    this.childOrder.length = 0;
  }

  /**
   * Checks if supervisor is running.
   */
  isRunning(): boolean {
    return this.running && !this.shuttingDown;
  }

  /**
   * Watches a child for crashes and handles restart.
   */
  private watchChild(child: RunningChild): void {
    // Unsubscribe previous listener if exists (e.g., after restart)
    child.lifecycleUnsubscribe?.();
    delete child.lastExitReason;

    // Register lifecycle listener to capture exit reason
    const unsubscribe = GenServer.onLifecycleEvent((event) => {
      if (event.type === 'terminated' && event.ref.id === child.ref.id) {
        child.lastExitReason = event.reason;
      }
    });
    child.lifecycleUnsubscribe = unsubscribe;

    // Poll-based monitoring since we don't have direct crash notifications
    const checkInterval = setInterval(() => {
      if (!this.running || this.shuttingDown) {
        clearInterval(checkInterval);
        unsubscribe();
        return;
      }

      if (!GenServer.isRunning(child.ref)) {
        clearInterval(checkInterval);
        unsubscribe();

        // Child has died - handle based on restart strategy
        void this.handleChildCrash(child);
      }
    }, 50);
  }

  /**
   * Handles a child crash based on the supervisor strategy.
   */
  private async handleChildCrash(crashedChild: RunningChild): Promise<void> {
    if (!this.running || this.shuttingDown) return;

    const restartStrategy = crashedChild.spec.restart ?? 'permanent';

    // Check if we should restart based on child restart strategy and exit reason
    if (!this.shouldRestartChild(restartStrategy, crashedChild.lastExitReason)) {
      const spec = crashedChild.spec;
      this.removeChild(crashedChild.id);
      emitSupervisorEvent('child_terminated', supervisorRefs.get(this.id)!, crashedChild.ref);

      // Check auto_shutdown after child removal
      if (this.checkAutoShutdown(spec)) {
        const ref = supervisorRefs.get(this.id)!;
        void Supervisor.stop(ref, 'shutdown');
      }
      return;
    }

    // Check restart intensity
    if (!this.checkRestartIntensity()) {
      this.running = false;
      throw new MaxRestartsExceededError(this.id, this.maxRestarts, this.restartWithinMs);
    }

    this.recordRestart();

    try {
      await this.executeRestartStrategy(crashedChild);
    } catch (error) {
      // If restart fails, supervisor should shut down
      this.running = false;
      if (error instanceof MaxRestartsExceededError) {
        throw error;
      }
      throw new Error(`Supervisor ${this.id} failed to restart child ${crashedChild.id}: ${error}`);
    }
  }

  /**
   * Determines if a child should be restarted based on its restart strategy and exit reason.
   */
  private shouldRestartChild(
    strategy: ChildRestartStrategy,
    exitReason?: TerminateReason,
  ): boolean {
    switch (strategy) {
      case 'permanent':
        return true;
      case 'transient':
        // Restart only on abnormal exit (errors)
        if (!exitReason) return true; // Unknown reason - restart to be safe
        if (exitReason === 'normal' || exitReason === 'shutdown') return false;
        return true; // { error: Error } - restart
      case 'temporary':
        return false;
    }
  }

  /**
   * Checks if restart intensity limit has been exceeded.
   */
  private checkRestartIntensity(): boolean {
    const now = Date.now();
    const windowStart = now - this.restartWithinMs;

    // Count restarts within the window
    const recentRestarts = this.restartTimestamps.filter((ts) => ts >= windowStart);

    return recentRestarts.length < this.maxRestarts;
  }

  /**
   * Records a restart timestamp.
   */
  private recordRestart(): void {
    const now = Date.now();
    this.restartTimestamps.push(now);
    this.totalRestarts++;

    // Cleanup old timestamps
    const windowStart = now - this.restartWithinMs;
    while (this.restartTimestamps.length > 0 && this.restartTimestamps[0]! < windowStart) {
      this.restartTimestamps.shift();
    }
  }

  /**
   * Executes the appropriate restart strategy.
   */
  private async executeRestartStrategy(crashedChild: RunningChild): Promise<void> {
    switch (this.strategy) {
      case 'one_for_one':
      case 'simple_one_for_one':
        await this.restartOneForOne(crashedChild);
        break;
      case 'one_for_all':
        await this.restartOneForAll(crashedChild);
        break;
      case 'rest_for_one':
        await this.restartRestForOne(crashedChild);
        break;
    }
  }

  /**
   * One-for-one strategy: only restart the crashed child.
   */
  private async restartOneForOne(crashedChild: RunningChild): Promise<void> {
    const newRef = await crashedChild.spec.start();
    crashedChild.ref = newRef;
    crashedChild.restartCount++;

    emitSupervisorEvent('child_restarted', supervisorRefs.get(this.id)!, newRef, crashedChild.restartCount);
    this.watchChild(crashedChild);
  }

  /**
   * One-for-all strategy: restart all children when one fails.
   */
  private async restartOneForAll(crashedChild: RunningChild): Promise<void> {
    // Stop all children (in reverse order)
    const reversedOrder = [...this.childOrder].reverse();
    for (const childId of reversedOrder) {
      const child = this.children.get(childId);
      if (child && childId !== crashedChild.id && GenServer.isRunning(child.ref)) {
        await this.stopChild(child, 'shutdown');
      }
    }

    // Restart all children (in original order)
    for (const childId of this.childOrder) {
      const child = this.children.get(childId);
      if (child) {
        const newRef = await child.spec.start();
        child.ref = newRef;
        if (childId === crashedChild.id) {
          child.restartCount++;
        }
        this.watchChild(child);
      }
    }

    emitSupervisorEvent('child_restarted', supervisorRefs.get(this.id)!, crashedChild.ref, crashedChild.restartCount);
  }

  /**
   * Rest-for-one strategy: restart the crashed child and all children started after it.
   */
  private async restartRestForOne(crashedChild: RunningChild): Promise<void> {
    const crashedIndex = this.childOrder.indexOf(crashedChild.id);
    if (crashedIndex === -1) return;

    // Get children to restart (crashed + all after)
    const childrenToRestart = this.childOrder.slice(crashedIndex);

    // Stop them in reverse order
    const reversedChildren = [...childrenToRestart].reverse();
    for (const childId of reversedChildren) {
      const child = this.children.get(childId);
      if (child && childId !== crashedChild.id && GenServer.isRunning(child.ref)) {
        await this.stopChild(child, 'shutdown');
      }
    }

    // Restart in original order
    for (const childId of childrenToRestart) {
      const child = this.children.get(childId);
      if (child) {
        const newRef = await child.spec.start();
        child.ref = newRef;
        if (childId === crashedChild.id) {
          child.restartCount++;
        }
        this.watchChild(child);
      }
    }

    emitSupervisorEvent('child_restarted', supervisorRefs.get(this.id)!, crashedChild.ref, crashedChild.restartCount);
  }

  /**
   * Stops a child gracefully.
   */
  private async stopChild(child: RunningChild, reason: TerminateReason): Promise<void> {
    if (GenServer.isRunning(child.ref)) {
      const timeout = child.spec.shutdownTimeout ?? DEFAULTS.SHUTDOWN_TIMEOUT;

      try {
        await Promise.race([
          GenServer.stop(child.ref, reason),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Shutdown timeout')), timeout),
          ),
        ]);
      } catch {
        // Force terminate if graceful shutdown fails
        GenServer._forceTerminate(child.ref, reason);
      }
    }
  }

  /**
   * Removes a child from tracking.
   */
  private removeChild(childId: string): void {
    const child = this.children.get(childId);
    child?.lifecycleUnsubscribe?.();
    this.children.delete(childId);
    const index = this.childOrder.indexOf(childId);
    if (index !== -1) {
      this.childOrder.splice(index, 1);
    }
  }

  /**
   * Checks if supervisor should auto-shutdown based on child termination.
   * Returns true if supervisor should shut down.
   */
  checkAutoShutdown(terminatedChildSpec: ChildSpec): boolean {
    if (this.autoShutdown === 'never') {
      return false;
    }

    const wasSignificant = terminatedChildSpec.significant === true;

    if (this.autoShutdown === 'any_significant') {
      return wasSignificant;
    }

    if (this.autoShutdown === 'all_significant') {
      if (!wasSignificant) {
        return false;
      }
      // Check if any significant children remain
      for (const child of this.children.values()) {
        if (child.spec.significant === true) {
          return false;
        }
      }
      return true;
    }

    return false;
  }
}

/**
 * Registry of active supervisor instances.
 */
const supervisorRegistry = new Map<string, SupervisorInstance>();

/**
 * Registry mapping supervisor IDs to their refs.
 */
const supervisorRefs = new Map<string, SupervisorRef>();

/**
 * Lifecycle event handlers for supervisor events.
 */
const supervisorLifecycleHandlers = new Set<LifecycleHandler>();

/**
 * Counter for generating unique supervisor IDs.
 */
let supervisorIdCounter = 0;

/**
 * Generates a unique supervisor ID.
 */
function generateSupervisorId(): string {
  return `supervisor_${++supervisorIdCounter}_${Date.now().toString(36)}`;
}

/**
 * Creates a SupervisorRef from an ID.
 */
function createSupervisorRef(id: string): SupervisorRef {
  return { id } as SupervisorRef;
}

/**
 * Emits supervisor lifecycle events.
 */
function emitSupervisorEvent(
  type: 'started',
  ref: SupervisorRef,
): void;
function emitSupervisorEvent(
  type: 'terminated',
  ref: SupervisorRef,
  reason: TerminateReason,
): void;
function emitSupervisorEvent(
  type: 'child_restarted',
  ref: SupervisorRef,
  childRef: GenServerRef,
  attempt: number,
): void;
function emitSupervisorEvent(
  type: 'child_terminated',
  ref: SupervisorRef,
  childRef: GenServerRef,
): void;
function emitSupervisorEvent(
  type: 'started' | 'terminated' | 'child_restarted' | 'child_terminated',
  ref: SupervisorRef,
  reasonOrChildRef?: TerminateReason | GenServerRef,
  attempt?: number,
): void {
  if (supervisorLifecycleHandlers.size === 0) return;

  let event: LifecycleEvent;
  switch (type) {
    case 'started':
      event = { type: 'started', ref };
      break;
    case 'terminated':
      event = { type: 'terminated', ref, reason: reasonOrChildRef as TerminateReason };
      break;
    case 'child_restarted':
      event = { type: 'restarted', ref: reasonOrChildRef as GenServerRef, attempt: attempt! };
      break;
    case 'child_terminated':
      event = { type: 'terminated', ref: reasonOrChildRef as GenServerRef, reason: 'normal' };
      break;
  }

  for (const handler of supervisorLifecycleHandlers) {
    try {
      handler(event);
    } catch {
      // Lifecycle handlers should not throw, but if they do, ignore it
    }
  }
}

/**
 * Gets a supervisor instance by ref.
 */
function getSupervisorInstance(ref: SupervisorRef): SupervisorInstance {
  const instance = supervisorRegistry.get(ref.id);
  if (!instance) {
    throw new Error(`Supervisor '${ref.id}' not found`);
  }
  return instance;
}

/**
 * Supervisor provides a supervision tree abstraction for managing child processes.
 *
 * It implements the core Supervisor pattern from Elixir/OTP:
 * - Automatic restart of failed children
 * - Multiple restart strategies
 * - Restart intensity limiting
 * - Ordered startup and shutdown
 *
 * @example
 * ```typescript
 * const supervisor = await Supervisor.start({
 *   strategy: 'one_for_one',
 *   children: [
 *     { id: 'counter', start: () => GenServer.start(counterBehavior) },
 *     { id: 'cache', start: () => GenServer.start(cacheBehavior) },
 *   ],
 * });
 *
 * // Children are automatically restarted on crash
 * // Shut down gracefully
 * await Supervisor.stop(supervisor);
 * ```
 */
export const Supervisor = {
  /**
   * Starts a new Supervisor with the given options.
   *
   * @param options - Supervisor configuration
   * @returns A reference to the started supervisor
   * @throws {MissingChildTemplateError} if simple_one_for_one without childTemplate
   * @throws {InvalidSimpleOneForOneConfigError} if simple_one_for_one with static children
   */
  async start(options: SupervisorOptions = {}): Promise<SupervisorRef> {
    const id = generateSupervisorId();
    const strategy = options.strategy ?? 'one_for_one';
    const maxRestarts = options.restartIntensity?.maxRestarts ?? DEFAULTS.MAX_RESTARTS;
    const restartWithinMs = options.restartIntensity?.withinMs ?? DEFAULTS.RESTART_WITHIN_MS;
    const autoShutdown = options.autoShutdown ?? 'never';

    // Validate simple_one_for_one configuration
    if (strategy === 'simple_one_for_one') {
      if (!options.childTemplate) {
        throw new MissingChildTemplateError(id);
      }
      if (options.children && options.children.length > 0) {
        throw new InvalidSimpleOneForOneConfigError(
          id,
          'static children are not allowed',
        );
      }
    }

    const instance = new SupervisorInstance(
      id,
      strategy,
      maxRestarts,
      restartWithinMs,
      autoShutdown,
      options.childTemplate,
    );
    supervisorRegistry.set(id, instance);

    const ref = createSupervisorRef(id);
    supervisorRefs.set(id, ref);

    // Start initial children (not allowed for simple_one_for_one, validated above)
    if (options.children && options.children.length > 0) {
      try {
        await instance.startChildren(options.children);
      } catch (error) {
        // If any child fails to start, clean up and rethrow
        await instance.shutdown();
        supervisorRegistry.delete(id);
        supervisorRefs.delete(id);
        throw error;
      }
    }

    emitSupervisorEvent('started', ref);
    return ref;
  },

  /**
   * Gracefully stops the supervisor and all its children.
   *
   * @param ref - Reference to the supervisor to stop
   * @param reason - Reason for stopping
   */
  async stop(ref: SupervisorRef, reason: TerminateReason = 'normal'): Promise<void> {
    const instance = supervisorRegistry.get(ref.id);
    if (!instance) {
      // Already stopped
      return;
    }

    await instance.shutdown();
    supervisorRegistry.delete(ref.id);
    supervisorRefs.delete(ref.id);

    emitSupervisorEvent('terminated', ref, reason);
  },

  /**
   * Dynamically starts a new child under the supervisor.
   *
   * For regular supervisors, provide a ChildSpec.
   * For simple_one_for_one supervisors, provide an array of arguments
   * that will be passed to the childTemplate.start function.
   *
   * @param ref - Reference to the supervisor
   * @param specOrArgs - Child specification or arguments array for simple_one_for_one
   * @returns Reference to the started child
   * @throws {DuplicateChildError} if child with same ID exists (regular supervisors)
   * @throws {MissingChildTemplateError} if simple_one_for_one without template
   * @throws {InvalidSimpleOneForOneConfigError} if wrong argument type for supervisor strategy
   */
  async startChild(
    ref: SupervisorRef,
    specOrArgs: ChildSpec | unknown[],
  ): Promise<GenServerRef> {
    const instance = getSupervisorInstance(ref);

    if (instance.isSimpleOneForOne()) {
      if (!Array.isArray(specOrArgs)) {
        throw new InvalidSimpleOneForOneConfigError(
          ref.id,
          'startChild requires an arguments array for simple_one_for_one',
        );
      }
      return instance.startChildFromTemplate(specOrArgs);
    }

    if (Array.isArray(specOrArgs)) {
      throw new InvalidSimpleOneForOneConfigError(
        ref.id,
        'startChild requires a ChildSpec for non-simple_one_for_one supervisors',
      );
    }
    return instance.startChild(specOrArgs);
  },

  /**
   * Terminates a specific child.
   *
   * @param ref - Reference to the supervisor
   * @param childId - ID of the child to terminate
   * @throws {ChildNotFoundError} if child not found
   */
  async terminateChild(ref: SupervisorRef, childId: string): Promise<void> {
    const instance = getSupervisorInstance(ref);
    await instance.terminateChild(childId);
  },

  /**
   * Restarts a specific child.
   *
   * @param ref - Reference to the supervisor
   * @param childId - ID of the child to restart
   * @returns Reference to the restarted child
   * @throws {ChildNotFoundError} if child not found
   */
  async restartChild(ref: SupervisorRef, childId: string): Promise<GenServerRef> {
    const instance = getSupervisorInstance(ref);
    return instance.restartChild(childId);
  },

  /**
   * Returns information about all children.
   *
   * @param ref - Reference to the supervisor
   * @returns Array of child information
   */
  getChildren(ref: SupervisorRef): readonly ChildInfo[] {
    const instance = getSupervisorInstance(ref);
    return instance.getChildren();
  },

  /**
   * Returns information about a specific child.
   *
   * @param ref - Reference to the supervisor
   * @param childId - ID of the child
   * @returns Child information or undefined if not found
   */
  getChild(ref: SupervisorRef, childId: string): ChildInfo | undefined {
    const instance = getSupervisorInstance(ref);
    return instance.getChild(childId);
  },

  /**
   * Checks if a supervisor is currently running.
   *
   * @param ref - Reference to check
   * @returns true if the supervisor is running
   */
  isRunning(ref: SupervisorRef): boolean {
    const instance = supervisorRegistry.get(ref.id);
    return instance !== undefined && instance.isRunning();
  },

  /**
   * Returns the number of children managed by the supervisor.
   *
   * @param ref - Reference to the supervisor
   * @returns Number of children
   */
  countChildren(ref: SupervisorRef): number {
    const instance = getSupervisorInstance(ref);
    return instance.getChildren().length;
  },

  /**
   * Registers a lifecycle event handler.
   *
   * @param handler - The handler function
   * @returns A function to unregister the handler
   */
  onLifecycleEvent(handler: LifecycleHandler): () => void {
    supervisorLifecycleHandlers.add(handler);
    return () => {
      supervisorLifecycleHandlers.delete(handler);
    };
  },

  /**
   * Clears all lifecycle handlers.
   * Useful for testing.
   *
   * @internal
   */
  _clearLifecycleHandlers(): void {
    supervisorLifecycleHandlers.clear();
  },

  /**
   * Resets the supervisor ID counter.
   * Useful for testing.
   *
   * @internal
   */
  _resetIdCounter(): void {
    supervisorIdCounter = 0;
  },

  /**
   * Returns statistics for a specific supervisor.
   * Used by Observer for introspection.
   *
   * @internal
   */
  _getStats(ref: SupervisorRef): SupervisorStats | undefined {
    const instance = supervisorRegistry.get(ref.id);
    if (!instance) {
      return undefined;
    }
    return instance.getStats();
  },

  /**
   * Returns statistics for all running supervisors.
   * Used by Observer for system-wide introspection.
   *
   * @internal
   */
  _getAllStats(): readonly SupervisorStats[] {
    const stats: SupervisorStats[] = [];
    for (const instance of supervisorRegistry.values()) {
      stats.push(instance.getStats());
    }
    return stats;
  },

  /**
   * Returns IDs of all running supervisors.
   * Used by Observer for enumeration.
   *
   * @internal
   */
  _getAllSupervisorIds(): readonly string[] {
    return Array.from(supervisorRegistry.keys());
  },

  /**
   * Returns a SupervisorRef by its ID.
   * Used by Observer for lookups.
   *
   * @internal
   */
  _getRefById(id: string): SupervisorRef | undefined {
    return supervisorRefs.get(id);
  },

  /**
   * Clears all supervisors from the registry.
   * Useful for testing to ensure clean state between tests.
   *
   * @internal
   */
  async _clearAll(): Promise<void> {
    const refs = Array.from(supervisorRefs.values());
    await Promise.all(refs.map((ref) => this.stop(ref)));
  },
} as const;
