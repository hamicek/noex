/**
 * Pending spawns manager for remote spawn correlation.
 *
 * Tracks pending remote spawn requests and matches them with their responses.
 * Handles timeout management and cleanup of stale spawn requests.
 *
 * @module distribution/remote/pending-spawns
 */

import type { SpawnId, NodeId } from '../types.js';
import { RemoteSpawnTimeoutError } from '../types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * State of a pending spawn request.
 */
type PendingSpawnState = 'pending' | 'resolved' | 'rejected' | 'timeout';

/**
 * Result of a successful remote spawn.
 */
export interface SpawnResult {
  /** ID of the spawned GenServer */
  readonly serverId: string;

  /** Node where the GenServer is running */
  readonly nodeId: NodeId;
}

/**
 * Information about a pending spawn request.
 */
interface PendingSpawn {
  /** Unique spawn identifier */
  readonly spawnId: SpawnId;

  /** Name of the behavior being spawned */
  readonly behaviorName: string;

  /** Target node ID */
  readonly nodeId: NodeId;

  /** Promise resolve function */
  readonly resolve: (value: SpawnResult) => void;

  /** Promise reject function */
  readonly reject: (error: Error) => void;

  /** Timeout handle */
  readonly timeoutHandle: ReturnType<typeof setTimeout>;

  /** Timeout duration in milliseconds */
  readonly timeoutMs: number;

  /** Timestamp when spawn was initiated */
  readonly createdAt: number;

  /** Current state of the spawn request */
  state: PendingSpawnState;
}

/**
 * Statistics about pending spawn requests.
 */
export interface PendingSpawnsStats {
  /** Number of currently pending spawns */
  readonly pendingCount: number;

  /** Total number of spawns initiated */
  readonly totalInitiated: number;

  /** Total number of spawns resolved successfully */
  readonly totalResolved: number;

  /** Total number of spawns rejected with error */
  readonly totalRejected: number;

  /** Total number of spawns that timed out */
  readonly totalTimedOut: number;
}

// =============================================================================
// PendingSpawns Manager
// =============================================================================

/**
 * Manages pending remote spawn requests for correlation and timeout handling.
 *
 * Thread-safe tracking of remote spawn requests from initiation to resolution.
 * Automatically cleans up timed-out requests.
 *
 * @example
 * ```typescript
 * const pendingSpawns = new PendingSpawns();
 *
 * // Register a new spawn request
 * const { spawnId, promise } = pendingSpawns.register({
 *   behaviorName: 'counter',
 *   nodeId,
 *   timeoutMs: 10000,
 *   spawnId,
 * });
 *
 * // Send the spawn request with spawnId...
 *
 * // Later, when response arrives:
 * pendingSpawns.resolve(spawnId, { serverId: 'server1', nodeId });
 *
 * // The promise will resolve with the result
 * const result = await promise;
 * ```
 */
export class PendingSpawns {
  private readonly pending = new Map<SpawnId, PendingSpawn>();

  // Statistics
  private totalInitiated = 0;
  private totalResolved = 0;
  private totalRejected = 0;
  private totalTimedOut = 0;

  /**
   * Registers a new pending spawn request.
   *
   * Creates a promise that will resolve when the spawn response arrives
   * or reject on timeout/error.
   *
   * @param options - Spawn registration options
   * @returns Spawn ID and promise for the result
   */
  register(options: {
    readonly behaviorName: string;
    readonly nodeId: NodeId;
    readonly timeoutMs: number;
    readonly spawnId: SpawnId;
  }): { readonly spawnId: SpawnId; readonly promise: Promise<SpawnResult> } {
    const { spawnId, behaviorName, nodeId, timeoutMs } = options;

    // Create the pending spawn entry
    let pendingSpawn: PendingSpawn;

    const promise = new Promise<SpawnResult>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.handleTimeout(spawnId);
      }, timeoutMs);

      // Don't block process exit
      if (timeoutHandle.unref) {
        timeoutHandle.unref();
      }

      pendingSpawn = {
        spawnId,
        behaviorName,
        nodeId,
        resolve,
        reject,
        timeoutHandle,
        timeoutMs,
        createdAt: Date.now(),
        state: 'pending',
      };

      this.pending.set(spawnId, pendingSpawn);
    });

    this.totalInitiated++;

    return { spawnId, promise };
  }

  /**
   * Resolves a pending spawn with a successful result.
   *
   * @param spawnId - Spawn identifier
   * @param result - Result containing serverId and nodeId
   * @returns true if spawn was found and resolved, false if not found
   */
  resolve(spawnId: SpawnId, result: SpawnResult): boolean {
    const pendingSpawn = this.pending.get(spawnId);

    if (!pendingSpawn || pendingSpawn.state !== 'pending') {
      return false;
    }

    clearTimeout(pendingSpawn.timeoutHandle);
    pendingSpawn.state = 'resolved';
    this.pending.delete(spawnId);
    this.totalResolved++;

    pendingSpawn.resolve(result);
    return true;
  }

  /**
   * Rejects a pending spawn with an error.
   *
   * @param spawnId - Spawn identifier
   * @param error - Error to reject with
   * @returns true if spawn was found and rejected, false if not found
   */
  reject(spawnId: SpawnId, error: Error): boolean {
    const pendingSpawn = this.pending.get(spawnId);

    if (!pendingSpawn || pendingSpawn.state !== 'pending') {
      return false;
    }

    clearTimeout(pendingSpawn.timeoutHandle);
    pendingSpawn.state = 'rejected';
    this.pending.delete(spawnId);
    this.totalRejected++;

    pendingSpawn.reject(error);
    return true;
  }

  /**
   * Checks if a spawn request is pending.
   *
   * @param spawnId - Spawn identifier
   * @returns true if spawn is still pending
   */
  isPending(spawnId: SpawnId): boolean {
    const pendingSpawn = this.pending.get(spawnId);
    return pendingSpawn?.state === 'pending';
  }

  /**
   * Gets information about a pending spawn request.
   *
   * @param spawnId - Spawn identifier
   * @returns Spawn info if found, undefined otherwise
   */
  get(spawnId: SpawnId): {
    readonly behaviorName: string;
    readonly nodeId: NodeId;
    readonly timeoutMs: number;
    readonly createdAt: number;
    readonly elapsedMs: number;
  } | undefined {
    const pendingSpawn = this.pending.get(spawnId);
    if (!pendingSpawn) {
      return undefined;
    }

    return {
      behaviorName: pendingSpawn.behaviorName,
      nodeId: pendingSpawn.nodeId,
      timeoutMs: pendingSpawn.timeoutMs,
      createdAt: pendingSpawn.createdAt,
      elapsedMs: Date.now() - pendingSpawn.createdAt,
    };
  }

  /**
   * Returns the number of currently pending spawn requests.
   */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Returns statistics about pending spawn requests.
   */
  getStats(): PendingSpawnsStats {
    return {
      pendingCount: this.pending.size,
      totalInitiated: this.totalInitiated,
      totalResolved: this.totalResolved,
      totalRejected: this.totalRejected,
      totalTimedOut: this.totalTimedOut,
    };
  }

  /**
   * Rejects all pending spawn requests to a specific node.
   *
   * Called when a node goes down to fail all pending spawns to that node.
   *
   * @param nodeId - Node identifier
   * @param error - Error to reject with
   * @returns Number of spawns rejected
   */
  rejectAllForNode(nodeId: NodeId, error: Error): number {
    let rejected = 0;

    for (const [spawnId, pendingSpawn] of this.pending) {
      if (pendingSpawn.nodeId === nodeId && pendingSpawn.state === 'pending') {
        clearTimeout(pendingSpawn.timeoutHandle);
        pendingSpawn.state = 'rejected';
        this.pending.delete(spawnId);
        this.totalRejected++;
        pendingSpawn.reject(error);
        rejected++;
      }
    }

    return rejected;
  }

  /**
   * Clears all pending spawn requests.
   *
   * Used during shutdown to clean up resources.
   *
   * @param error - Optional error to reject pending spawns with
   */
  clear(error?: Error): void {
    const rejectError = error ?? new Error('Pending spawns cleared');

    for (const [spawnId, pendingSpawn] of this.pending) {
      if (pendingSpawn.state === 'pending') {
        clearTimeout(pendingSpawn.timeoutHandle);
        pendingSpawn.state = 'rejected';
        pendingSpawn.reject(rejectError);
        this.totalRejected++;
      }
    }

    this.pending.clear();
  }

  /**
   * Handles timeout for a pending spawn request.
   *
   * @param spawnId - Spawn identifier
   */
  private handleTimeout(spawnId: SpawnId): void {
    const pendingSpawn = this.pending.get(spawnId);

    if (!pendingSpawn || pendingSpawn.state !== 'pending') {
      return;
    }

    pendingSpawn.state = 'timeout';
    this.pending.delete(spawnId);
    this.totalTimedOut++;

    pendingSpawn.reject(
      new RemoteSpawnTimeoutError(
        pendingSpawn.behaviorName,
        pendingSpawn.nodeId,
        pendingSpawn.timeoutMs,
      ),
    );
  }
}
