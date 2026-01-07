/**
 * Remote spawn implementation for distributed GenServer instantiation.
 *
 * Enables spawning GenServer instances on remote cluster nodes. The behavior
 * must be pre-registered on both nodes using BehaviorRegistry, as JavaScript
 * functions cannot be serialized and transmitted over the network.
 *
 * @module distribution/remote/remote-spawn
 */

import type {
  NodeId,
  SpawnId,
  SpawnRequestMessage,
  SpawnReplyMessage,
  SpawnErrorMessage,
  SpawnRequestOptions,
  SpawnErrorType,
} from '../types.js';
import {
  NodeNotReachableError,
  ClusterNotStartedError,
  BehaviorNotFoundError,
  RemoteSpawnInitError,
  RemoteSpawnRegistrationError,
} from '../types.js';
import { generateSpawnId } from '../serialization.js';
import { Cluster } from '../cluster/cluster.js';
import { PendingSpawns, type SpawnResult, type PendingSpawnsStats } from './pending-spawns.js';

// =============================================================================
// Constants
// =============================================================================

/**
 * Default timeout for remote spawn operations in milliseconds.
 */
const DEFAULT_SPAWN_TIMEOUT_MS = 10_000;

// =============================================================================
// Types
// =============================================================================

/**
 * Options for remote spawn.
 */
export interface RemoteSpawnOptions extends SpawnRequestOptions {
  /** Timeout in milliseconds for the entire spawn operation */
  readonly timeout?: number;
}

/**
 * Statistics about remote spawn operations.
 */
export interface RemoteSpawnStats extends PendingSpawnsStats {
  /** Whether the module is initialized */
  readonly initialized: boolean;
}

// =============================================================================
// State
// =============================================================================

/** Pending spawns manager instance */
const pendingSpawns = new PendingSpawns();

/** Whether the remote spawn module is initialized */
let initialized = false;

/** Cleanup function for node down handler */
let nodeDownCleanup: (() => void) | null = null;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initializes the remote spawn module.
 *
 * Sets up event handlers for cluster node failures.
 * Called automatically on first remote spawn if not already initialized.
 */
function ensureInitialized(): void {
  if (initialized) {
    return;
  }

  // Subscribe to cluster node down events
  nodeDownCleanup = Cluster.onNodeDown((nodeId, _reason) => {
    // Reject all pending spawns to the downed node
    const error = new NodeNotReachableError(nodeId);
    pendingSpawns.rejectAllForNode(nodeId, error);
  });

  initialized = true;
}

/**
 * Resets the remote spawn module state.
 *
 * @internal Used for testing.
 */
export function _resetRemoteSpawnState(): void {
  pendingSpawns.clear();
  if (nodeDownCleanup) {
    nodeDownCleanup();
    nodeDownCleanup = null;
  }
  initialized = false;
}

// =============================================================================
// Error Mapping
// =============================================================================

/**
 * Maps a spawn error message to the appropriate Error instance.
 *
 * @param message - Spawn error message
 * @param behaviorName - Name of the behavior that was being spawned
 * @param nodeId - Target node ID
 * @returns Appropriate Error instance
 */
function mapSpawnError(
  message: SpawnErrorMessage,
  behaviorName: string,
  nodeId: NodeId,
): Error {
  switch (message.errorType) {
    case 'behavior_not_found':
      return new BehaviorNotFoundError(behaviorName);

    case 'init_failed':
    case 'init_timeout':
    case 'unknown_error':
      return new RemoteSpawnInitError(behaviorName, nodeId, message.message);

    case 'registration_failed':
      return new RemoteSpawnRegistrationError(
        behaviorName,
        nodeId,
        message.message,
      );

    default: {
      // Exhaustive check
      const _exhaustive: never = message.errorType;
      return new RemoteSpawnInitError(behaviorName, nodeId, message.message);
    }
  }
}

// =============================================================================
// RemoteSpawn
// =============================================================================

/**
 * Remote spawn operations for distributed GenServer instantiation.
 *
 * @example
 * ```typescript
 * import { RemoteSpawn, BehaviorRegistry } from 'noex/distribution';
 *
 * // Register behavior on ALL nodes
 * BehaviorRegistry.register('counter', counterBehavior);
 *
 * // Spawn on a remote node
 * const result = await RemoteSpawn.spawn('counter', remoteNodeId, {
 *   name: 'my-counter',
 *   registration: 'global',
 * });
 *
 * console.log(`Spawned server ${result.serverId} on ${result.nodeId}`);
 * ```
 */
export const RemoteSpawn = {
  /**
   * Spawns a GenServer on a remote node.
   *
   * The behavior must be pre-registered on the target node using
   * BehaviorRegistry. The spawn request is sent to the target node,
   * which creates the GenServer and returns a reference.
   *
   * @param behaviorName - Name of the registered behavior
   * @param targetNodeId - Target node to spawn on
   * @param options - Spawn options
   * @returns Promise resolving to spawn result with serverId and nodeId
   * @throws {ClusterNotStartedError} If cluster is not running
   * @throws {NodeNotReachableError} If target node is not connected
   * @throws {BehaviorNotFoundError} If behavior is not registered on target
   * @throws {RemoteSpawnTimeoutError} If spawn times out
   * @throws {RemoteSpawnInitError} If initialization fails
   * @throws {RemoteSpawnRegistrationError} If registration fails
   */
  async spawn(
    behaviorName: string,
    targetNodeId: NodeId,
    options: RemoteSpawnOptions = {},
  ): Promise<SpawnResult> {
    ensureInitialized();

    const transport = Cluster._getTransport();
    const timeoutMs = options.timeout ?? DEFAULT_SPAWN_TIMEOUT_MS;

    // Check if target node is connected
    if (!transport.isConnectedTo(targetNodeId)) {
      throw new NodeNotReachableError(targetNodeId);
    }

    // Generate unique spawn ID
    const spawnId = generateSpawnId();

    // Register pending spawn
    const { promise } = pendingSpawns.register({
      spawnId,
      behaviorName,
      nodeId: targetNodeId,
      timeoutMs,
    });

    // Create spawn request message
    // Build options object without undefined values (exactOptionalPropertyTypes)
    const spawnOptions: SpawnRequestOptions = {};
    if (options.name !== undefined) {
      (spawnOptions as { name: string }).name = options.name;
    }
    if (options.initTimeout !== undefined) {
      (spawnOptions as { initTimeout: number }).initTimeout = options.initTimeout;
    }
    if (options.registration !== undefined) {
      (spawnOptions as { registration: 'local' | 'global' | 'none' }).registration = options.registration;
    }

    const spawnRequest: SpawnRequestMessage = {
      type: 'spawn_request',
      spawnId,
      behaviorName,
      options: spawnOptions,
      timeoutMs,
      sentAt: Date.now(),
    };

    try {
      await transport.send(targetNodeId, spawnRequest);
    } catch (error) {
      // Failed to send - reject the pending spawn
      pendingSpawns.reject(
        spawnId,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }

    // Wait for response
    return promise;
  },

  /**
   * Handles an incoming spawn reply message.
   *
   * Called by the Cluster when a spawn_reply message is received.
   *
   * @param message - Spawn reply message
   * @internal
   */
  _handleSpawnReply(message: SpawnReplyMessage): void {
    pendingSpawns.resolve(message.spawnId, {
      serverId: message.serverId,
      nodeId: message.nodeId,
    });
  },

  /**
   * Handles an incoming spawn error message.
   *
   * Called by the Cluster when a spawn_error message is received.
   *
   * @param message - Spawn error message
   * @internal
   */
  _handleSpawnError(message: SpawnErrorMessage): void {
    const pendingInfo = pendingSpawns.get(message.spawnId);
    if (!pendingInfo) {
      return;
    }

    const error = mapSpawnError(
      message,
      pendingInfo.behaviorName,
      pendingInfo.nodeId,
    );

    pendingSpawns.reject(message.spawnId, error);
  },

  /**
   * Returns statistics about remote spawn operations.
   */
  getStats(): RemoteSpawnStats {
    const stats = pendingSpawns.getStats();
    return {
      ...stats,
      initialized,
    };
  },

  /**
   * Clears all pending spawns.
   *
   * Called during cluster shutdown.
   *
   * @internal
   */
  _clear(): void {
    pendingSpawns.clear(new ClusterNotStartedError());
  },
} as const;
