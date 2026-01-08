/**
 * Node-level crash simulation for distributed stress testing.
 *
 * Provides controlled ways to crash, partition, and degrade cluster nodes
 * for testing distributed system behavior under various failure scenarios.
 *
 * @module tests/stress/distribution/node-crash-simulator
 */

import type { TestCluster, TestNodeInfo, CrashMode } from './cluster-factory.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Extended crash modes for node-level simulation.
 *
 * - `graceful_shutdown`: Clean Cluster.stop() before process exit
 * - `abrupt_kill`: SIGKILL signal - immediate termination without cleanup
 * - `process_exit`: SIGTERM signal - termination with minimal cleanup
 * - `network_disconnect`: Simulate network failure (crash node, keep record)
 * - `freeze`: Stop processing but keep heartbeat timers (simulated by crash + delay)
 * - `slow_death`: Gradual degradation through repeated brief disconnections
 */
export type NodeCrashMode =
  | CrashMode
  | 'network_disconnect'
  | 'freeze'
  | 'slow_death';

/**
 * Result of a node crash operation.
 */
export interface NodeCrashResult {
  /** Node ID that was affected. */
  readonly nodeId: string;
  /** Crash mode used. */
  readonly mode: NodeCrashMode;
  /** Whether the operation succeeded. */
  readonly success: boolean;
  /** Timestamp of the crash. */
  readonly timestamp: number;
  /** Duration of the crash operation in ms. */
  readonly durationMs: number;
  /** Error if operation failed. */
  readonly error?: Error;
}

/**
 * Result of a chaos pattern execution.
 */
export interface ChaosPatternResult {
  /** Name of the pattern executed. */
  readonly pattern: ChaosPattern;
  /** Results for each affected node. */
  readonly nodeResults: readonly NodeCrashResult[];
  /** Total duration in ms. */
  readonly totalDurationMs: number;
  /** Whether the pattern completed successfully. */
  readonly success: boolean;
  /** Any errors that occurred. */
  readonly errors: readonly Error[];
}

/**
 * Chaos patterns for distributed system testing.
 */
export type ChaosPattern =
  | 'random_kill'
  | 'rolling_restart'
  | 'split_brain'
  | 'cascade_failure';

/**
 * Configuration for random kill pattern.
 */
export interface RandomKillConfig {
  /** Number of nodes to kill. Default: 1. */
  readonly count?: number;
  /** Minimum delay between kills in ms. Default: 0. */
  readonly minDelayMs?: number;
  /** Maximum delay between kills in ms. Default: 0. */
  readonly maxDelayMs?: number;
  /** Crash mode to use. Default: 'process_exit'. */
  readonly mode?: CrashMode;
  /** Exclude specific node IDs from selection. */
  readonly excludeNodeIds?: readonly string[];
}

/**
 * Configuration for rolling restart pattern.
 */
export interface RollingRestartConfig {
  /** Delay between restarts in ms. Default: 1000. */
  readonly delayBetweenMs?: number;
  /** Wait for node to rejoin before next restart. Default: true. */
  readonly waitForRejoin?: boolean;
  /** Timeout for node rejoin in ms. Default: 10000. */
  readonly rejoinTimeoutMs?: number;
  /** Node IDs to restart (empty = all). */
  readonly nodeIds?: readonly string[];
}

/**
 * Configuration for split brain pattern.
 */
export interface SplitBrainConfig {
  /** Node IDs for partition 1. If not specified, splits evenly. */
  readonly partition1?: readonly string[];
  /** Node IDs for partition 2. If not specified, remaining nodes. */
  readonly partition2?: readonly string[];
  /** Duration of the split in ms before healing. 0 = no auto-heal. */
  readonly splitDurationMs?: number;
  /** Which partition survives (crashes the other). Default: 'larger'. */
  readonly survivingPartition?: 'partition1' | 'partition2' | 'larger' | 'smaller';
}

/**
 * Configuration for cascade failure pattern.
 */
export interface CascadeFailureConfig {
  /** Starting node ID. If not specified, picks randomly. */
  readonly startNodeId?: string;
  /** Delay between cascade steps in ms. Default: 500. */
  readonly cascadeDelayMs?: number;
  /** Maximum nodes to crash. Default: all but one. */
  readonly maxCrashes?: number;
  /** Probability of cascade spreading (0-1). Default: 1.0. */
  readonly spreadProbability?: number;
}

/**
 * Events emitted by NodeCrashSimulator.
 */
export interface CrashSimulatorEvents {
  /** Emitted before a node crash. */
  beforeCrash: [nodeId: string, mode: NodeCrashMode];
  /** Emitted after a node crash. */
  afterCrash: [result: NodeCrashResult];
  /** Emitted before a pattern starts. */
  patternStart: [pattern: ChaosPattern];
  /** Emitted after a pattern completes. */
  patternEnd: [result: ChaosPatternResult];
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Delays execution for specified milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns a random integer between min and max (inclusive).
 */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Fisher-Yates shuffle for unbiased random selection.
 */
function shuffle<T>(array: readonly T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/**
 * Selects random elements from an array.
 */
function selectRandom<T>(
  array: readonly T[],
  count: number,
  exclude: readonly T[] = []
): T[] {
  const filtered = array.filter((item) => !exclude.includes(item));
  const shuffled = shuffle(filtered);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

// =============================================================================
// NodeCrashSimulator Class
// =============================================================================

/**
 * Orchestrates node-level crash simulations for distributed stress testing.
 *
 * Provides methods for individual node crashes and complex chaos patterns
 * like split-brain, cascade failures, and rolling restarts.
 *
 * @example
 * ```typescript
 * const cluster = await TestClusterFactory.createCluster({
 *   nodeCount: 5,
 *   basePort: 20000,
 * });
 * await cluster.waitForFullMesh();
 *
 * const simulator = new NodeCrashSimulator(cluster);
 *
 * // Execute random kill pattern
 * const result = await simulator.randomKill({ count: 2 });
 *
 * // Execute split brain
 * const splitResult = await simulator.splitBrain({
 *   splitDurationMs: 5000,
 * });
 * ```
 */
export class NodeCrashSimulator {
  private readonly cluster: TestCluster;
  private readonly eventListeners: Map<string, Set<(...args: any[]) => void>> = new Map();

  constructor(cluster: TestCluster) {
    this.cluster = cluster;
  }

  // ===========================================================================
  // Event Emitter Methods
  // ===========================================================================

  /**
   * Registers an event listener.
   */
  on<K extends keyof CrashSimulatorEvents>(
    event: K,
    listener: (...args: CrashSimulatorEvents[K]) => void
  ): this {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);
    return this;
  }

  /**
   * Removes an event listener.
   */
  off<K extends keyof CrashSimulatorEvents>(
    event: K,
    listener: (...args: CrashSimulatorEvents[K]) => void
  ): this {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(listener);
    }
    return this;
  }

  /**
   * Emits an event to all registered listeners.
   */
  private emit<K extends keyof CrashSimulatorEvents>(
    event: K,
    ...args: CrashSimulatorEvents[K]
  ): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        listener(...args);
      }
    }
  }

  // ===========================================================================
  // Individual Node Operations
  // ===========================================================================

  /**
   * Crashes a single node with the specified mode.
   *
   * @param nodeId - The node to crash
   * @param mode - The crash mode to use
   * @returns Promise resolving to crash result
   */
  async crashNode(
    nodeId: string,
    mode: NodeCrashMode = 'process_exit'
  ): Promise<NodeCrashResult> {
    const startTime = Date.now();

    this.emit('beforeCrash', nodeId, mode);

    try {
      const node = this.cluster.getNode(nodeId);
      if (!node) {
        throw new Error(`Node ${nodeId} not found`);
      }

      if (node.status !== 'running') {
        throw new Error(`Node ${nodeId} is not running (status: ${node.status})`);
      }

      // Handle extended crash modes
      switch (mode) {
        case 'network_disconnect':
          // Simulate network disconnect by crashing the node
          // The "network" aspect is that we don't do graceful shutdown
          await this.cluster.crashNode(nodeId, 'abrupt_kill');
          break;

        case 'freeze':
          // Simulate freeze by abrupt kill (process stops responding)
          // In a real implementation this would use SIGSTOP/SIGCONT
          await this.cluster.crashNode(nodeId, 'abrupt_kill');
          break;

        case 'slow_death':
          // Gradual degradation - currently implemented as delayed crash
          // Future: could implement as series of reconnections
          await delay(randomInt(100, 500));
          await this.cluster.crashNode(nodeId, 'process_exit');
          break;

        default:
          // Standard crash modes
          await this.cluster.crashNode(nodeId, mode);
      }

      const result: NodeCrashResult = {
        nodeId,
        mode,
        success: true,
        timestamp: startTime,
        durationMs: Date.now() - startTime,
      };

      this.emit('afterCrash', result);
      return result;
    } catch (error) {
      const result: NodeCrashResult = {
        nodeId,
        mode,
        success: false,
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error : new Error(String(error)),
      };

      this.emit('afterCrash', result);
      return result;
    }
  }

  /**
   * Crashes multiple nodes simultaneously.
   *
   * @param nodeIds - The nodes to crash
   * @param mode - The crash mode to use
   * @returns Promise resolving to array of crash results
   */
  async crashMultiple(
    nodeIds: readonly string[],
    mode: NodeCrashMode = 'process_exit'
  ): Promise<readonly NodeCrashResult[]> {
    const promises = nodeIds.map((nodeId) => this.crashNode(nodeId, mode));
    return Promise.all(promises);
  }

  /**
   * Returns list of running node IDs.
   */
  getRunningNodeIds(): readonly string[] {
    return this.cluster
      .getNodes()
      .filter((n) => n.status === 'running')
      .map((n) => n.nodeId);
  }

  // ===========================================================================
  // Chaos Patterns
  // ===========================================================================

  /**
   * Executes random kill pattern.
   *
   * Randomly selects and crashes nodes from the cluster.
   *
   * @param config - Random kill configuration
   * @returns Promise resolving to chaos pattern result
   */
  async randomKill(config: RandomKillConfig = {}): Promise<ChaosPatternResult> {
    const {
      count = 1,
      minDelayMs = 0,
      maxDelayMs = 0,
      mode = 'process_exit',
      excludeNodeIds = [],
    } = config;

    const startTime = Date.now();
    this.emit('patternStart', 'random_kill');

    const results: NodeCrashResult[] = [];
    const errors: Error[] = [];

    const runningNodes = this.getRunningNodeIds();
    const targetNodes = selectRandom(runningNodes, count, excludeNodeIds);

    for (let i = 0; i < targetNodes.length; i++) {
      const nodeId = targetNodes[i]!;

      // Apply delay between kills
      if (i > 0 && (minDelayMs > 0 || maxDelayMs > 0)) {
        const delayTime = randomInt(minDelayMs, maxDelayMs);
        await delay(delayTime);
      }

      const result = await this.crashNode(nodeId, mode);
      results.push(result);

      if (!result.success && result.error) {
        errors.push(result.error);
      }
    }

    const patternResult: ChaosPatternResult = {
      pattern: 'random_kill',
      nodeResults: results,
      totalDurationMs: Date.now() - startTime,
      success: errors.length === 0,
      errors,
    };

    this.emit('patternEnd', patternResult);
    return patternResult;
  }

  /**
   * Executes rolling restart pattern.
   *
   * Restarts nodes one by one, optionally waiting for rejoin.
   *
   * @param config - Rolling restart configuration
   * @returns Promise resolving to chaos pattern result
   */
  async rollingRestart(config: RollingRestartConfig = {}): Promise<ChaosPatternResult> {
    const {
      delayBetweenMs = 1000,
      waitForRejoin = true,
      rejoinTimeoutMs = 10000,
      nodeIds,
    } = config;

    const startTime = Date.now();
    this.emit('patternStart', 'rolling_restart');

    const results: NodeCrashResult[] = [];
    const errors: Error[] = [];

    // Determine which nodes to restart
    const targetNodes = nodeIds
      ? [...nodeIds]
      : this.cluster.getNodeIds() as string[];

    for (let i = 0; i < targetNodes.length; i++) {
      const nodeId = targetNodes[i]!;

      // Delay before restart (except first)
      if (i > 0 && delayBetweenMs > 0) {
        await delay(delayBetweenMs);
      }

      // Crash the node
      const crashResult = await this.crashNode(nodeId, 'graceful_shutdown');
      results.push(crashResult);

      if (!crashResult.success && crashResult.error) {
        errors.push(crashResult.error);
        continue;
      }

      // Small delay before restart
      await delay(100);

      // Restart the node
      try {
        await this.cluster.restartNode(nodeId);

        // Wait for rejoin if requested
        if (waitForRejoin) {
          await this.waitForNodeRunning(nodeId, rejoinTimeoutMs);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(err);
      }
    }

    const patternResult: ChaosPatternResult = {
      pattern: 'rolling_restart',
      nodeResults: results,
      totalDurationMs: Date.now() - startTime,
      success: errors.length === 0,
      errors,
    };

    this.emit('patternEnd', patternResult);
    return patternResult;
  }

  /**
   * Executes split brain pattern.
   *
   * Partitions the cluster into two groups by crashing nodes in one partition.
   *
   * @param config - Split brain configuration
   * @returns Promise resolving to chaos pattern result
   */
  async splitBrain(config: SplitBrainConfig = {}): Promise<ChaosPatternResult> {
    const {
      partition1,
      partition2,
      splitDurationMs = 0,
      survivingPartition = 'larger',
    } = config;

    const startTime = Date.now();
    this.emit('patternStart', 'split_brain');

    const results: NodeCrashResult[] = [];
    const errors: Error[] = [];

    // Get all running nodes
    const runningNodes = this.getRunningNodeIds();

    // Determine partitions
    let p1: string[];
    let p2: string[];

    if (partition1 && partition2) {
      p1 = [...partition1];
      p2 = [...partition2];
    } else if (partition1) {
      p1 = [...partition1];
      p2 = runningNodes.filter((n) => !p1.includes(n));
    } else if (partition2) {
      p2 = [...partition2];
      p1 = runningNodes.filter((n) => !p2.includes(n));
    } else {
      // Split evenly
      const midpoint = Math.ceil(runningNodes.length / 2);
      p1 = runningNodes.slice(0, midpoint);
      p2 = runningNodes.slice(midpoint);
    }

    // Determine which partition to kill
    let toKill: string[];
    switch (survivingPartition) {
      case 'partition1':
        toKill = p2;
        break;
      case 'partition2':
        toKill = p1;
        break;
      case 'smaller':
        toKill = p1.length <= p2.length ? p1 : p2;
        break;
      case 'larger':
      default:
        toKill = p1.length >= p2.length ? p1 : p2;
        break;
    }

    // Kill nodes in the partition
    for (const nodeId of toKill) {
      const result = await this.crashNode(nodeId, 'network_disconnect');
      results.push(result);

      if (!result.success && result.error) {
        errors.push(result.error);
      }
    }

    // Wait for split duration then heal (restart crashed nodes)
    if (splitDurationMs > 0) {
      await delay(splitDurationMs);

      // Restart crashed nodes to heal the partition
      for (const nodeId of toKill) {
        try {
          await this.cluster.restartNode(nodeId);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          errors.push(err);
        }
      }
    }

    const patternResult: ChaosPatternResult = {
      pattern: 'split_brain',
      nodeResults: results,
      totalDurationMs: Date.now() - startTime,
      success: errors.length === 0,
      errors,
    };

    this.emit('patternEnd', patternResult);
    return patternResult;
  }

  /**
   * Executes cascade failure pattern.
   *
   * Crashes nodes in sequence, simulating cascading failures.
   *
   * @param config - Cascade failure configuration
   * @returns Promise resolving to chaos pattern result
   */
  async cascadeFailure(config: CascadeFailureConfig = {}): Promise<ChaosPatternResult> {
    const {
      startNodeId,
      cascadeDelayMs = 500,
      maxCrashes,
      spreadProbability = 1.0,
    } = config;

    const startTime = Date.now();
    this.emit('patternStart', 'cascade_failure');

    const results: NodeCrashResult[] = [];
    const errors: Error[] = [];

    const runningNodes = [...this.getRunningNodeIds()];
    const maxToKill = maxCrashes ?? Math.max(1, runningNodes.length - 1);

    // Determine starting node
    const firstNode = startNodeId ?? selectRandom(runningNodes, 1)[0];
    if (!firstNode) {
      const patternResult: ChaosPatternResult = {
        pattern: 'cascade_failure',
        nodeResults: [],
        totalDurationMs: Date.now() - startTime,
        success: false,
        errors: [new Error('No nodes available for cascade failure')],
      };
      this.emit('patternEnd', patternResult);
      return patternResult;
    }

    // Track which nodes have been crashed
    const crashed = new Set<string>();
    let nodesToCrash = [firstNode];

    while (nodesToCrash.length > 0 && crashed.size < maxToKill) {
      const nodeId = nodesToCrash.shift()!;

      // Skip if already crashed or not running
      if (crashed.has(nodeId)) continue;

      const node = this.cluster.getNode(nodeId);
      if (!node || node.status !== 'running') continue;

      // Apply cascade delay (except for first node)
      if (crashed.size > 0) {
        await delay(cascadeDelayMs);
      }

      // Crash the node
      const result = await this.crashNode(nodeId, 'process_exit');
      results.push(result);
      crashed.add(nodeId);

      if (!result.success && result.error) {
        errors.push(result.error);
      }

      // Determine cascade spread
      if (Math.random() < spreadProbability && crashed.size < maxToKill) {
        // Get remaining running nodes as potential cascade targets
        const remaining = this.getRunningNodeIds().filter((n) => !crashed.has(n));

        if (remaining.length > 0) {
          // Select next node(s) to cascade to
          const nextTarget = selectRandom(remaining, 1)[0];
          if (nextTarget) {
            nodesToCrash.push(nextTarget);
          }
        }
      }
    }

    const patternResult: ChaosPatternResult = {
      pattern: 'cascade_failure',
      nodeResults: results,
      totalDurationMs: Date.now() - startTime,
      success: errors.length === 0,
      errors,
    };

    this.emit('patternEnd', patternResult);
    return patternResult;
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * Waits for a specific node to reach running status.
   */
  private async waitForNodeRunning(
    nodeId: string,
    timeoutMs: number
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const node = this.cluster.getNode(nodeId);
      if (node?.status === 'running') {
        return;
      }
      await delay(100);
    }

    throw new Error(`Timeout waiting for node ${nodeId} to become running`);
  }

  /**
   * Returns statistics about current cluster state.
   */
  getClusterStats(): ClusterStats {
    const nodes = this.cluster.getNodes();
    const runningCount = nodes.filter((n) => n.status === 'running').length;
    const crashedCount = nodes.filter((n) => n.status === 'crashed').length;
    const stoppedCount = nodes.filter((n) => n.status === 'stopped').length;

    return {
      totalNodes: nodes.length,
      runningNodes: runningCount,
      crashedNodes: crashedCount,
      stoppedNodes: stoppedCount,
      isFullMesh: this.cluster.isFullMesh(),
    };
  }
}

/**
 * Statistics about cluster state.
 */
export interface ClusterStats {
  readonly totalNodes: number;
  readonly runningNodes: number;
  readonly crashedNodes: number;
  readonly stoppedNodes: number;
  readonly isFullMesh: boolean;
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Creates a NodeCrashSimulator for a test cluster.
 *
 * @param cluster - The test cluster to simulate crashes on
 * @returns New NodeCrashSimulator instance
 *
 * @example
 * ```typescript
 * const simulator = createCrashSimulator(cluster);
 * await simulator.randomKill({ count: 2 });
 * ```
 */
export function createCrashSimulator(cluster: TestCluster): NodeCrashSimulator {
  return new NodeCrashSimulator(cluster);
}

/**
 * Convenience function to execute a random kill on a cluster.
 *
 * @param cluster - The test cluster
 * @param count - Number of nodes to kill
 * @returns Promise resolving to chaos pattern result
 */
export async function killRandomNodes(
  cluster: TestCluster,
  count: number = 1
): Promise<ChaosPatternResult> {
  const simulator = new NodeCrashSimulator(cluster);
  return simulator.randomKill({ count });
}

/**
 * Convenience function to execute a rolling restart on a cluster.
 *
 * @param cluster - The test cluster
 * @param delayBetweenMs - Delay between restarts
 * @returns Promise resolving to chaos pattern result
 */
export async function rollingRestartCluster(
  cluster: TestCluster,
  delayBetweenMs: number = 1000
): Promise<ChaosPatternResult> {
  const simulator = new NodeCrashSimulator(cluster);
  return simulator.rollingRestart({ delayBetweenMs });
}

/**
 * Convenience function to create a split brain scenario.
 *
 * @param cluster - The test cluster
 * @param durationMs - Duration of split before healing
 * @returns Promise resolving to chaos pattern result
 */
export async function createSplitBrain(
  cluster: TestCluster,
  durationMs: number = 0
): Promise<ChaosPatternResult> {
  const simulator = new NodeCrashSimulator(cluster);
  return simulator.splitBrain({ splitDurationMs: durationMs });
}

/**
 * Convenience function to trigger cascade failure.
 *
 * @param cluster - The test cluster
 * @param startNodeId - Optional starting node
 * @returns Promise resolving to chaos pattern result
 */
export async function triggerCascadeFailure(
  cluster: TestCluster,
  startNodeId?: string
): Promise<ChaosPatternResult> {
  const simulator = new NodeCrashSimulator(cluster);
  return simulator.cascadeFailure({ startNodeId });
}
