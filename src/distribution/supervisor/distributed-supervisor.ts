/**
 * DistributedSupervisor implementation for noex.
 *
 * Provides a supervisor capable of spawning and managing child processes
 * across multiple cluster nodes with automatic failover on node failure.
 *
 * Key features:
 * - Remote child spawning via BehaviorRegistry
 * - Automatic failover when nodes go down
 * - Multiple restart strategies (one_for_one, one_for_all, rest_for_one, simple_one_for_one)
 * - Cluster-wide child coordination via GlobalRegistry
 *
 * @module distribution/supervisor/distributed-supervisor
 */

import type { NodeId } from '../node-id.js';
import type { GenServerRef, ChildRestartStrategy, SupervisorStrategy } from '../../core/types.js';
import { GenServer } from '../../core/gen-server.js';
import { Cluster } from '../cluster/cluster.js';
import { RemoteSpawn } from '../remote/remote-spawn.js';
import { BehaviorRegistry } from '../remote/behavior-registry.js';

import type {
  NodeSelector,
  DistributedChildSpec,
  DistributedChildTemplate,
  DistributedSupervisorOptions,
  DistributedSupervisorRef,
  DistributedChildInfo,
  DistributedRunningChild,
  DistributedSupervisorStats,
  DistributedSupervisorEvent,
  DistributedSupervisorEventHandler,
  DistributedAutoShutdown,
} from './types.js';

import {
  DISTRIBUTED_SUPERVISOR_DEFAULTS,
  DistributedDuplicateChildError,
  DistributedChildNotFoundError,
  DistributedMaxRestartsExceededError,
  DistributedInvalidSimpleOneForOneError,
  DistributedMissingChildTemplateError,
  DistributedBehaviorNotFoundError,
  DistributedSupervisorError,
} from './types.js';

import { NodeSelectorImpl } from './node-selector.js';
import { DistributedChildRegistry } from './child-registry.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Internal exit reason type for child processes.
 */
type ChildExitReason = 'normal' | 'shutdown' | { readonly error: Error };

// =============================================================================
// Internal State
// =============================================================================

/**
 * Counter for generating unique supervisor IDs.
 */
let supervisorIdCounter = 0;

/**
 * Registry of active distributed supervisor instances.
 */
const supervisorRegistry = new Map<string, DistributedSupervisorInstance>();

/**
 * Registry mapping supervisor IDs to their refs.
 */
const supervisorRefs = new Map<string, DistributedSupervisorRef>();

/**
 * Global lifecycle event handlers.
 */
const lifecycleHandlers = new Set<DistributedSupervisorEventHandler>();

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Generates a unique supervisor ID.
 */
function generateSupervisorId(): string {
  return `dsup_${++supervisorIdCounter}_${Date.now().toString(36)}`;
}

/**
 * Creates a DistributedSupervisorRef from an ID and nodeId.
 */
function createSupervisorRef(id: string, nodeId: NodeId): DistributedSupervisorRef {
  return {
    id,
    nodeId,
  } as DistributedSupervisorRef;
}

/**
 * Emits a lifecycle event to all registered handlers.
 */
function emitLifecycleEvent(event: DistributedSupervisorEvent): void {
  for (const handler of lifecycleHandlers) {
    try {
      handler(event);
    } catch {
      // Lifecycle handlers should not throw, but if they do, ignore it
    }
  }
}

/**
 * Determines if a child should be restarted based on its restart strategy and exit reason.
 */
function shouldRestartChild(
  strategy: ChildRestartStrategy,
  exitReason?: ChildExitReason,
): boolean {
  switch (strategy) {
    case 'permanent':
      return true;
    case 'transient':
      if (!exitReason) return true;
      if (exitReason === 'normal' || exitReason === 'shutdown') return false;
      return true;
    case 'temporary':
      return false;
  }
}

// =============================================================================
// DistributedSupervisorInstance
// =============================================================================

/**
 * Internal supervisor instance that manages distributed children.
 */
class DistributedSupervisorInstance {
  private readonly children: Map<string, DistributedRunningChild> = new Map();
  private readonly childOrder: string[] = [];
  private running = true;
  private shuttingDown = false;
  private readonly restartTimestamps: number[] = [];
  private readonly startedAt: number = Date.now();
  private totalRestarts = 0;
  private nodeFailureRestarts = 0;
  private childIdCounter = 0;

  private nodeDownCleanup: (() => void) | null = null;

  constructor(
    readonly id: string,
    readonly nodeId: NodeId,
    private readonly strategy: SupervisorStrategy,
    private readonly maxRestarts: number,
    private readonly restartWithinMs: number,
    private readonly autoShutdown: DistributedAutoShutdown,
    private readonly defaultNodeSelector: NodeSelector,
    private readonly childTemplate?: DistributedChildTemplate,
  ) {
    this.setupNodeDownHandler();
  }

  // ===========================================================================
  // Public Query Methods
  // ===========================================================================

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
  getStats(): DistributedSupervisorStats {
    const childrenByNode = new Map<NodeId, number>();
    for (const child of this.children.values()) {
      const count = childrenByNode.get(child.nodeId) ?? 0;
      childrenByNode.set(child.nodeId, count + 1);
    }

    return {
      id: this.id,
      strategy: this.strategy,
      childCount: this.children.size,
      childrenByNode,
      totalRestarts: this.totalRestarts,
      nodeFailureRestarts: this.nodeFailureRestarts,
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  /**
   * Returns information about all children.
   */
  getChildren(): readonly DistributedChildInfo[] {
    return this.childOrder
      .filter((id) => this.children.has(id))
      .map((id) => {
        const child = this.children.get(id)!;
        return {
          id: child.id,
          ref: child.ref,
          spec: child.spec,
          nodeId: child.nodeId,
          restartCount: child.restartCount,
          startedAt: child.startedAt,
        };
      });
  }

  /**
   * Returns a specific child by ID.
   */
  getChild(childId: string): DistributedChildInfo | undefined {
    const child = this.children.get(childId);
    if (!child) return undefined;
    return {
      id: child.id,
      ref: child.ref,
      spec: child.spec,
      nodeId: child.nodeId,
      restartCount: child.restartCount,
      startedAt: child.startedAt,
    };
  }

  /**
   * Checks if supervisor is running.
   */
  isRunning(): boolean {
    return this.running && !this.shuttingDown;
  }

  /**
   * Returns true if this is a simple_one_for_one supervisor.
   */
  isSimpleOneForOne(): boolean {
    return this.strategy === 'simple_one_for_one';
  }

  // ===========================================================================
  // Child Lifecycle Management
  // ===========================================================================

  /**
   * Starts all children from specs.
   */
  async startChildren(specs: readonly DistributedChildSpec[]): Promise<void> {
    for (const spec of specs) {
      await this.startChild(spec);
    }
  }

  /**
   * Starts a single child.
   * @throws {DistributedDuplicateChildError} if child with same ID exists
   */
  async startChild(spec: DistributedChildSpec): Promise<GenServerRef> {
    if (this.children.has(spec.id)) {
      throw new DistributedDuplicateChildError(this.id, spec.id);
    }

    // Validate behavior exists locally before attempting spawn
    if (!BehaviorRegistry.has(spec.behavior)) {
      throw new DistributedBehaviorNotFoundError(spec.behavior, this.nodeId);
    }

    // Select target node
    const selector = spec.nodeSelector ?? this.defaultNodeSelector;
    const targetNodeId = NodeSelectorImpl.selectNode(selector, spec.id);

    // Spawn the child
    const ref = await this.spawnChild(spec, targetNodeId);

    const child: DistributedRunningChild = {
      id: spec.id,
      spec,
      ref,
      nodeId: targetNodeId,
      restartCount: 0,
      restartTimestamps: [],
      startedAt: Date.now(),
    };

    this.children.set(spec.id, child);
    this.childOrder.push(spec.id);

    // Register in distributed registry
    await DistributedChildRegistry.registerChild(this.id, spec.id, ref, targetNodeId);

    // Set up monitoring
    this.watchChild(child);

    emitLifecycleEvent({
      type: 'child_started',
      supervisorId: this.id,
      childId: spec.id,
      nodeId: targetNodeId,
    });

    return ref;
  }

  /**
   * Starts a child from the template with given arguments.
   * Only valid for simple_one_for_one supervisors.
   */
  async startChildFromTemplate(args: readonly unknown[]): Promise<GenServerRef> {
    if (!this.childTemplate) {
      throw new DistributedMissingChildTemplateError(this.id);
    }

    const childId = `child_${++this.childIdCounter}`;

    // Create spec from template with only defined properties (exactOptionalPropertyTypes)
    const spec: DistributedChildSpec = {
      id: childId,
      behavior: this.childTemplate.behavior,
      args,
      ...(this.childTemplate.restart !== undefined && { restart: this.childTemplate.restart }),
      ...(this.childTemplate.nodeSelector !== undefined && { nodeSelector: this.childTemplate.nodeSelector }),
      ...(this.childTemplate.shutdownTimeout !== undefined && { shutdownTimeout: this.childTemplate.shutdownTimeout }),
      ...(this.childTemplate.significant !== undefined && { significant: this.childTemplate.significant }),
    };

    return this.startChild(spec);
  }

  /**
   * Terminates a specific child.
   * @throws {DistributedChildNotFoundError} if child not found
   */
  async terminateChild(childId: string): Promise<void> {
    const child = this.children.get(childId);
    if (!child) {
      throw new DistributedChildNotFoundError(this.id, childId);
    }

    await this.stopChild(child, 'shutdown');
    await this.removeChild(childId);

    emitLifecycleEvent({
      type: 'child_stopped',
      supervisorId: this.id,
      childId,
      reason: 'shutdown',
    });

    // Check auto_shutdown after child removal
    if (this.checkAutoShutdown(child.spec)) {
      const ref = supervisorRefs.get(this.id)!;
      void DistributedSupervisor.stop(ref, 'shutdown');
    }
  }

  /**
   * Restarts a specific child.
   * @throws {DistributedChildNotFoundError} if child not found
   */
  async restartChild(childId: string): Promise<GenServerRef> {
    const child = this.children.get(childId);
    if (!child) {
      throw new DistributedChildNotFoundError(this.id, childId);
    }

    await this.stopChild(child, 'shutdown');

    // Select target node (may differ from previous)
    const selector = child.spec.nodeSelector ?? this.defaultNodeSelector;
    const targetNodeId = NodeSelectorImpl.selectNode(selector, childId);

    // Spawn new child
    const newRef = await this.spawnChild(child.spec, targetNodeId);

    // Update tracking
    child.ref = newRef;
    child.nodeId = targetNodeId;
    child.restartCount++;
    child.startedAt = Date.now();

    // Update registry
    await DistributedChildRegistry.registerChild(this.id, childId, newRef, targetNodeId);

    // Set up monitoring
    this.watchChild(child);

    emitLifecycleEvent({
      type: 'child_restarted',
      supervisorId: this.id,
      childId,
      nodeId: targetNodeId,
      attempt: child.restartCount,
    });

    return newRef;
  }

  /**
   * Gracefully shuts down all children in reverse order.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.running = false;

    // Cleanup node down handler
    if (this.nodeDownCleanup) {
      this.nodeDownCleanup();
      this.nodeDownCleanup = null;
    }

    // Stop children in reverse order (last started = first stopped)
    const reversedOrder = [...this.childOrder].reverse();

    for (const childId of reversedOrder) {
      const child = this.children.get(childId);
      if (child) {
        try {
          await this.stopChild(child, 'shutdown');
        } catch {
          // Continue shutdown even if individual child stops fail
        }
      }
    }

    // Cleanup all lifecycle listeners
    for (const child of this.children.values()) {
      child.lifecycleUnsubscribe?.();
    }

    // Unregister all children from distributed registry
    await DistributedChildRegistry.unregisterAllChildren(this.id);

    this.children.clear();
    this.childOrder.length = 0;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Sets up the node down handler for automatic failover.
   */
  private setupNodeDownHandler(): void {
    this.nodeDownCleanup = Cluster.onNodeDown((nodeId, _reason) => {
      this.handleNodeDown(nodeId).catch((error) => {
        // Error is already handled in handleNodeDown (supervisor stopped, event emitted)
        // Just ensure we don't have unhandled rejection
        if (!(error instanceof DistributedMaxRestartsExceededError)) {
          // Unexpected error - log it (in production, this would go to a logger)
        }
      });
    });
  }

  /**
   * Handles a node going down by restarting affected children.
   */
  private async handleNodeDown(nodeId: NodeId): Promise<void> {
    if (!this.running || this.shuttingDown) return;

    const affectedChildren = this.getChildrenOnNode(nodeId);

    if (affectedChildren.length === 0) return;

    emitLifecycleEvent({
      type: 'node_failure_detected',
      supervisorId: this.id,
      nodeId,
      affectedChildren: affectedChildren.map((c) => c.id),
    });

    for (const child of affectedChildren) {
      try {
        await this.handleChildNodeFailure(child, nodeId);
      } catch (error) {
        if (error instanceof DistributedMaxRestartsExceededError) {
          // Supervisor should shut down
          this.running = false;
          const ref = supervisorRefs.get(this.id);
          if (ref) {
            emitLifecycleEvent({
              type: 'supervisor_stopped',
              ref,
              reason: 'max_restarts_exceeded',
            });
          }
          throw error;
        }
        // Log error but continue with other children
      }
    }
  }

  /**
   * Returns all children running on a specific node.
   */
  private getChildrenOnNode(nodeId: NodeId): DistributedRunningChild[] {
    const result: DistributedRunningChild[] = [];
    for (const child of this.children.values()) {
      if (child.nodeId === nodeId) {
        result.push(child);
      }
    }
    return result;
  }

  /**
   * Handles a child failure due to node going down.
   */
  private async handleChildNodeFailure(
    child: DistributedRunningChild,
    failedNodeId: NodeId,
  ): Promise<void> {
    const restartStrategy = child.spec.restart ?? 'permanent';

    // Check if we should restart based on child restart strategy
    if (!shouldRestartChild(restartStrategy, { error: new Error('node_down') })) {
      await this.removeChild(child.id);
      emitLifecycleEvent({
        type: 'child_stopped',
        supervisorId: this.id,
        childId: child.id,
        reason: 'node_down',
      });

      if (this.checkAutoShutdown(child.spec)) {
        const ref = supervisorRefs.get(this.id)!;
        void DistributedSupervisor.stop(ref, 'shutdown');
      }
      return;
    }

    // Check restart intensity
    if (!this.checkRestartIntensity()) {
      this.running = false;
      throw new DistributedMaxRestartsExceededError(
        this.id,
        this.maxRestarts,
        this.restartWithinMs,
      );
    }

    this.recordRestart();
    this.nodeFailureRestarts++;

    // Cleanup lifecycle listener
    child.lifecycleUnsubscribe?.();

    // Try to claim the child for restart (prevents duplicate restarts)
    const claimed = await DistributedChildRegistry.tryClaimChild(this.id, child.id);
    if (!claimed) {
      // Another supervisor might be handling this, or child was already removed
      return;
    }

    // Select new node (exclude the failed one)
    const selector = child.spec.nodeSelector ?? this.defaultNodeSelector;
    const newNodeId = NodeSelectorImpl.selectNode(selector, child.id, failedNodeId);

    // Spawn on new node
    const newRef = await this.spawnChild(child.spec, newNodeId);

    const oldNodeId = child.nodeId;

    // Update tracking
    child.ref = newRef;
    child.nodeId = newNodeId;
    child.restartCount++;
    child.startedAt = Date.now();

    // Re-register in distributed registry
    await DistributedChildRegistry.registerChild(this.id, child.id, newRef, newNodeId);

    // Set up monitoring
    this.watchChild(child);

    emitLifecycleEvent({
      type: 'child_migrated',
      supervisorId: this.id,
      childId: child.id,
      fromNode: oldNodeId,
      toNode: newNodeId,
    });
  }

  /**
   * Spawns a child on the specified node.
   */
  private async spawnChild(
    spec: DistributedChildSpec,
    targetNodeId: NodeId,
  ): Promise<GenServerRef> {
    const localNodeId = Cluster.getLocalNodeId();
    const isLocal = targetNodeId === localNodeId;

    if (isLocal) {
      // Spawn locally using behavior registry
      const behavior = BehaviorRegistry.get(spec.behavior);
      if (!behavior) {
        throw new DistributedBehaviorNotFoundError(spec.behavior, targetNodeId);
      }

      // Create behavior with args applied to init
      const args = spec.args ?? [];
      const behaviorWithArgs = {
        ...behavior,
        init: () => {
          // Apply args to the original init function
          const initFn = behavior.init as (...a: unknown[]) => unknown;
          return initFn.apply(behavior, args as unknown[]);
        },
      };

      const ref = await GenServer.start(behaviorWithArgs);

      // Attach nodeId for consistency using unknown intermediate
      (ref as unknown as { nodeId: NodeId }).nodeId = localNodeId;

      return ref;
    }

    // Spawn remotely
    const result = await RemoteSpawn.spawn(spec.behavior, targetNodeId, {
      timeout: DISTRIBUTED_SUPERVISOR_DEFAULTS.SPAWN_TIMEOUT,
    });

    // Construct GenServerRef with nodeId using unknown intermediate for branded types
    return {
      id: result.serverId,
      nodeId: result.nodeId,
    } as unknown as GenServerRef;
  }

  /**
   * Watches a child for crashes and handles restart.
   */
  private watchChild(child: DistributedRunningChild): void {
    // Unsubscribe previous listener if exists (e.g., after restart)
    child.lifecycleUnsubscribe?.();
    delete child.lastExitReason;

    const localNodeId = Cluster.getLocalNodeId();
    const isLocal = child.nodeId === localNodeId;

    if (isLocal) {
      // Local child - use GenServer lifecycle events
      const unsubscribe = GenServer.onLifecycleEvent((event) => {
        if (event.type === 'terminated' && event.ref.id === child.ref.id) {
          child.lastExitReason = event.reason as ChildExitReason;
        }
      });
      child.lifecycleUnsubscribe = unsubscribe;

      // Poll-based monitoring for local processes
      const checkInterval = setInterval(() => {
        if (!this.running || this.shuttingDown) {
          clearInterval(checkInterval);
          unsubscribe();
          return;
        }

        if (!GenServer.isRunning(child.ref)) {
          clearInterval(checkInterval);
          unsubscribe();
          void this.handleChildCrash(child);
        }
      }, DISTRIBUTED_SUPERVISOR_DEFAULTS.CHILD_CHECK_INTERVAL);
    } else {
      // Remote child - will be handled by node down events
      // Remote monitoring will be implemented in Phase 5
    }
  }

  /**
   * Handles a child crash based on the supervisor strategy.
   */
  private async handleChildCrash(crashedChild: DistributedRunningChild): Promise<void> {
    if (!this.running || this.shuttingDown) return;

    const restartStrategy = crashedChild.spec.restart ?? 'permanent';

    // Check if we should restart based on child restart strategy and exit reason
    if (!shouldRestartChild(restartStrategy, crashedChild.lastExitReason)) {
      await this.removeChild(crashedChild.id);
      emitLifecycleEvent({
        type: 'child_stopped',
        supervisorId: this.id,
        childId: crashedChild.id,
        reason: String(crashedChild.lastExitReason ?? 'unknown'),
      });

      if (this.checkAutoShutdown(crashedChild.spec)) {
        const ref = supervisorRefs.get(this.id)!;
        void DistributedSupervisor.stop(ref, 'shutdown');
      }
      return;
    }

    // Check restart intensity
    if (!this.checkRestartIntensity()) {
      this.running = false;
      throw new DistributedMaxRestartsExceededError(
        this.id,
        this.maxRestarts,
        this.restartWithinMs,
      );
    }

    this.recordRestart();

    try {
      await this.executeRestartStrategy(crashedChild);
    } catch (error) {
      // If restart fails, supervisor should shut down
      this.running = false;
      if (error instanceof DistributedMaxRestartsExceededError) {
        throw error;
      }
      throw new DistributedSupervisorError(
        this.id,
        `Failed to restart child ${crashedChild.id}`,
        error instanceof Error ? error : undefined,
      );
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
    while (
      this.restartTimestamps.length > 0 &&
      this.restartTimestamps[0]! < windowStart
    ) {
      this.restartTimestamps.shift();
    }
  }

  /**
   * Executes the appropriate restart strategy.
   */
  private async executeRestartStrategy(
    crashedChild: DistributedRunningChild,
  ): Promise<void> {
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
  private async restartOneForOne(crashedChild: DistributedRunningChild): Promise<void> {
    const selector = crashedChild.spec.nodeSelector ?? this.defaultNodeSelector;
    const targetNodeId = NodeSelectorImpl.selectNode(selector, crashedChild.id);

    const newRef = await this.spawnChild(crashedChild.spec, targetNodeId);

    crashedChild.ref = newRef;
    crashedChild.nodeId = targetNodeId;
    crashedChild.restartCount++;
    crashedChild.startedAt = Date.now();

    await DistributedChildRegistry.registerChild(
      this.id,
      crashedChild.id,
      newRef,
      targetNodeId,
    );

    emitLifecycleEvent({
      type: 'child_restarted',
      supervisorId: this.id,
      childId: crashedChild.id,
      nodeId: targetNodeId,
      attempt: crashedChild.restartCount,
    });

    this.watchChild(crashedChild);
  }

  /**
   * One-for-all strategy: restart all children when one fails.
   */
  private async restartOneForAll(crashedChild: DistributedRunningChild): Promise<void> {
    // Stop all children (in reverse order)
    const reversedOrder = [...this.childOrder].reverse();
    for (const childId of reversedOrder) {
      const child = this.children.get(childId);
      if (child && childId !== crashedChild.id) {
        try {
          await this.stopChild(child, 'shutdown');
        } catch {
          // Continue even if individual stop fails
        }
      }
    }

    // Restart all children (in original order)
    for (const childId of this.childOrder) {
      const child = this.children.get(childId);
      if (child) {
        const selector = child.spec.nodeSelector ?? this.defaultNodeSelector;
        const targetNodeId = NodeSelectorImpl.selectNode(selector, childId);

        const newRef = await this.spawnChild(child.spec, targetNodeId);

        child.ref = newRef;
        child.nodeId = targetNodeId;
        if (childId === crashedChild.id) {
          child.restartCount++;
        }
        child.startedAt = Date.now();

        await DistributedChildRegistry.registerChild(this.id, childId, newRef, targetNodeId);

        this.watchChild(child);
      }
    }

    emitLifecycleEvent({
      type: 'child_restarted',
      supervisorId: this.id,
      childId: crashedChild.id,
      nodeId: crashedChild.nodeId,
      attempt: crashedChild.restartCount,
    });
  }

  /**
   * Rest-for-one strategy: restart the crashed child and all children started after it.
   */
  private async restartRestForOne(crashedChild: DistributedRunningChild): Promise<void> {
    const crashedIndex = this.childOrder.indexOf(crashedChild.id);
    if (crashedIndex === -1) return;

    // Get children to restart (crashed + all after)
    const childrenToRestart = this.childOrder.slice(crashedIndex);

    // Stop them in reverse order
    const reversedChildren = [...childrenToRestart].reverse();
    for (const childId of reversedChildren) {
      const child = this.children.get(childId);
      if (child && childId !== crashedChild.id) {
        try {
          await this.stopChild(child, 'shutdown');
        } catch {
          // Continue even if individual stop fails
        }
      }
    }

    // Restart in original order
    for (const childId of childrenToRestart) {
      const child = this.children.get(childId);
      if (child) {
        const selector = child.spec.nodeSelector ?? this.defaultNodeSelector;
        const targetNodeId = NodeSelectorImpl.selectNode(selector, childId);

        const newRef = await this.spawnChild(child.spec, targetNodeId);

        child.ref = newRef;
        child.nodeId = targetNodeId;
        if (childId === crashedChild.id) {
          child.restartCount++;
        }
        child.startedAt = Date.now();

        await DistributedChildRegistry.registerChild(this.id, childId, newRef, targetNodeId);

        this.watchChild(child);
      }
    }

    emitLifecycleEvent({
      type: 'child_restarted',
      supervisorId: this.id,
      childId: crashedChild.id,
      nodeId: crashedChild.nodeId,
      attempt: crashedChild.restartCount,
    });
  }

  /**
   * Stops a child gracefully.
   */
  private async stopChild(
    child: DistributedRunningChild,
    reason: 'normal' | 'shutdown',
  ): Promise<void> {
    const localNodeId = Cluster.getLocalNodeId();
    const isLocal = child.nodeId === localNodeId;

    if (isLocal && GenServer.isRunning(child.ref)) {
      const timeout = child.spec.shutdownTimeout ?? DISTRIBUTED_SUPERVISOR_DEFAULTS.SHUTDOWN_TIMEOUT;

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
    // Remote children are handled by their node's shutdown
  }

  /**
   * Removes a child from tracking.
   */
  private async removeChild(childId: string): Promise<void> {
    const child = this.children.get(childId);
    if (child) {
      child.lifecycleUnsubscribe?.();
      await DistributedChildRegistry.unregisterChild(this.id, childId);
    }
    this.children.delete(childId);
    const index = this.childOrder.indexOf(childId);
    if (index !== -1) {
      this.childOrder.splice(index, 1);
    }
  }

  /**
   * Checks if supervisor should auto-shutdown based on child termination.
   */
  private checkAutoShutdown(terminatedChildSpec: DistributedChildSpec): boolean {
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

// =============================================================================
// Public API
// =============================================================================

/**
 * DistributedSupervisor manages child processes across cluster nodes with
 * automatic failover when nodes go down.
 *
 * @example
 * ```typescript
 * import { DistributedSupervisor, BehaviorRegistry, Cluster } from 'noex/distribution';
 *
 * // 1. Register behaviors on ALL nodes
 * BehaviorRegistry.register('worker', workerBehavior);
 *
 * // 2. Start cluster
 * await Cluster.start({
 *   nodeName: 'supervisor-node',
 *   port: 4369,
 * });
 *
 * // 3. Start distributed supervisor
 * const supRef = await DistributedSupervisor.start({
 *   strategy: 'one_for_one',
 *   nodeSelector: 'round_robin',
 *   children: [
 *     { id: 'worker1', behavior: 'worker', restart: 'permanent' },
 *   ],
 * });
 *
 * // 4. If a node goes down, children are automatically restarted on other nodes
 *
 * // 5. Graceful shutdown
 * await DistributedSupervisor.stop(supRef);
 * ```
 */
export const DistributedSupervisor = {
  /**
   * Starts a new DistributedSupervisor with the given options.
   *
   * @param options - Supervisor configuration
   * @returns A reference to the started supervisor
   * @throws {DistributedMissingChildTemplateError} if simple_one_for_one without childTemplate
   * @throws {DistributedInvalidSimpleOneForOneError} if simple_one_for_one with static children
   */
  async start(
    options: DistributedSupervisorOptions = {},
  ): Promise<DistributedSupervisorRef> {
    const id = generateSupervisorId();
    const nodeId = Cluster.getLocalNodeId();
    const strategy = options.strategy ?? DISTRIBUTED_SUPERVISOR_DEFAULTS.STRATEGY;
    const maxRestarts =
      options.restartIntensity?.maxRestarts ?? DISTRIBUTED_SUPERVISOR_DEFAULTS.MAX_RESTARTS;
    const restartWithinMs =
      options.restartIntensity?.withinMs ?? DISTRIBUTED_SUPERVISOR_DEFAULTS.RESTART_WITHIN_MS;
    const autoShutdown = options.autoShutdown ?? DISTRIBUTED_SUPERVISOR_DEFAULTS.AUTO_SHUTDOWN;
    const defaultNodeSelector =
      options.nodeSelector ?? DISTRIBUTED_SUPERVISOR_DEFAULTS.NODE_SELECTOR;

    // Validate simple_one_for_one configuration
    if (strategy === 'simple_one_for_one') {
      if (!options.childTemplate) {
        throw new DistributedMissingChildTemplateError(id);
      }
      if (options.children && options.children.length > 0) {
        throw new DistributedInvalidSimpleOneForOneError(
          id,
          'static children are not allowed',
        );
      }
    }

    const instance = new DistributedSupervisorInstance(
      id,
      nodeId,
      strategy,
      maxRestarts,
      restartWithinMs,
      autoShutdown,
      defaultNodeSelector,
      options.childTemplate,
    );

    supervisorRegistry.set(id, instance);

    const ref = createSupervisorRef(id, nodeId);
    supervisorRefs.set(id, ref);

    // Register in GlobalRegistry if name is provided
    if (options.name) {
      const { GlobalRegistry } = await import('../registry/global-registry.js');
      await GlobalRegistry.register(options.name, { id, nodeId });
    }

    // Start initial children
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

    emitLifecycleEvent({
      type: 'supervisor_started',
      ref,
    });

    return ref;
  },

  /**
   * Gracefully stops the supervisor and all its children.
   *
   * @param ref - Reference to the supervisor to stop
   * @param reason - Reason for stopping
   */
  async stop(
    ref: DistributedSupervisorRef,
    reason: 'normal' | 'shutdown' = 'normal',
  ): Promise<void> {
    const instance = supervisorRegistry.get(ref.id);
    if (!instance) {
      // Already stopped
      return;
    }

    await instance.shutdown();
    supervisorRegistry.delete(ref.id);
    supervisorRefs.delete(ref.id);

    emitLifecycleEvent({
      type: 'supervisor_stopped',
      ref,
      reason,
    });
  },

  /**
   * Dynamically starts a new child under the supervisor.
   *
   * For regular supervisors, provide a DistributedChildSpec.
   * For simple_one_for_one supervisors, provide an array of arguments.
   *
   * @param ref - Reference to the supervisor
   * @param specOrArgs - Child specification or arguments array for simple_one_for_one
   * @returns Reference to the started child
   */
  async startChild(
    ref: DistributedSupervisorRef,
    specOrArgs: DistributedChildSpec | readonly unknown[],
  ): Promise<GenServerRef> {
    const instance = supervisorRegistry.get(ref.id);
    if (!instance) {
      throw new DistributedSupervisorError(ref.id, 'Supervisor not found');
    }

    if (instance.isSimpleOneForOne()) {
      if (!Array.isArray(specOrArgs)) {
        throw new DistributedInvalidSimpleOneForOneError(
          ref.id,
          'startChild requires an arguments array for simple_one_for_one',
        );
      }
      return instance.startChildFromTemplate(specOrArgs as readonly unknown[]);
    }

    if (Array.isArray(specOrArgs)) {
      throw new DistributedInvalidSimpleOneForOneError(
        ref.id,
        'startChild requires a DistributedChildSpec for non-simple_one_for_one supervisors',
      );
    }

    // At this point, specOrArgs must be DistributedChildSpec
    const spec = specOrArgs as DistributedChildSpec;
    return instance.startChild(spec);
  },

  /**
   * Terminates a specific child.
   *
   * @param ref - Reference to the supervisor
   * @param childId - ID of the child to terminate
   */
  async terminateChild(ref: DistributedSupervisorRef, childId: string): Promise<void> {
    const instance = supervisorRegistry.get(ref.id);
    if (!instance) {
      throw new DistributedSupervisorError(ref.id, 'Supervisor not found');
    }
    await instance.terminateChild(childId);
  },

  /**
   * Restarts a specific child.
   *
   * @param ref - Reference to the supervisor
   * @param childId - ID of the child to restart
   * @returns Reference to the restarted child
   */
  async restartChild(
    ref: DistributedSupervisorRef,
    childId: string,
  ): Promise<GenServerRef> {
    const instance = supervisorRegistry.get(ref.id);
    if (!instance) {
      throw new DistributedSupervisorError(ref.id, 'Supervisor not found');
    }
    return instance.restartChild(childId);
  },

  /**
   * Returns information about all children.
   *
   * @param ref - Reference to the supervisor
   * @returns Array of child information
   */
  getChildren(ref: DistributedSupervisorRef): readonly DistributedChildInfo[] {
    const instance = supervisorRegistry.get(ref.id);
    if (!instance) {
      throw new DistributedSupervisorError(ref.id, 'Supervisor not found');
    }
    return instance.getChildren();
  },

  /**
   * Returns information about a specific child.
   *
   * @param ref - Reference to the supervisor
   * @param childId - ID of the child
   * @returns Child information or undefined if not found
   */
  getChild(
    ref: DistributedSupervisorRef,
    childId: string,
  ): DistributedChildInfo | undefined {
    const instance = supervisorRegistry.get(ref.id);
    if (!instance) {
      throw new DistributedSupervisorError(ref.id, 'Supervisor not found');
    }
    return instance.getChild(childId);
  },

  /**
   * Checks if a supervisor is currently running.
   *
   * @param ref - Reference to check
   * @returns true if the supervisor is running
   */
  isRunning(ref: DistributedSupervisorRef): boolean {
    const instance = supervisorRegistry.get(ref.id);
    return instance !== undefined && instance.isRunning();
  },

  /**
   * Returns the number of children managed by the supervisor.
   *
   * @param ref - Reference to the supervisor
   * @returns Number of children
   */
  countChildren(ref: DistributedSupervisorRef): number {
    const instance = supervisorRegistry.get(ref.id);
    if (!instance) {
      throw new DistributedSupervisorError(ref.id, 'Supervisor not found');
    }
    return instance.getChildren().length;
  },

  /**
   * Returns statistics for the supervisor.
   *
   * @param ref - Reference to the supervisor
   * @returns Supervisor statistics
   */
  getStats(ref: DistributedSupervisorRef): DistributedSupervisorStats {
    const instance = supervisorRegistry.get(ref.id);
    if (!instance) {
      throw new DistributedSupervisorError(ref.id, 'Supervisor not found');
    }
    return instance.getStats();
  },

  /**
   * Registers a lifecycle event handler.
   *
   * @param handler - The handler function
   * @returns A function to unregister the handler
   */
  onLifecycleEvent(handler: DistributedSupervisorEventHandler): () => void {
    lifecycleHandlers.add(handler);
    return () => {
      lifecycleHandlers.delete(handler);
    };
  },

  // ===========================================================================
  // Internal / Testing APIs
  // ===========================================================================

  /**
   * Clears all lifecycle handlers.
   *
   * @internal
   */
  _clearLifecycleHandlers(): void {
    lifecycleHandlers.clear();
  },

  /**
   * Resets the supervisor ID counter.
   *
   * @internal
   */
  _resetIdCounter(): void {
    supervisorIdCounter = 0;
  },

  /**
   * Returns statistics for all running supervisors.
   *
   * @internal
   */
  _getAllStats(): readonly DistributedSupervisorStats[] {
    const stats: DistributedSupervisorStats[] = [];
    for (const instance of supervisorRegistry.values()) {
      stats.push(instance.getStats());
    }
    return stats;
  },

  /**
   * Clears all supervisors from the registry.
   *
   * @internal
   */
  async _clearAll(): Promise<void> {
    const refs = Array.from(supervisorRefs.values());
    await Promise.all(refs.map((ref) => this.stop(ref)));
  },
} as const;
