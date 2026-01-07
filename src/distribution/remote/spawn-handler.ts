/**
 * Handler for incoming remote spawn requests.
 *
 * Processes spawn requests from remote nodes, creates GenServer instances
 * using registered behaviors, and sends back the results.
 *
 * @module distribution/remote/spawn-handler
 */

import type {
  NodeId,
  SpawnRequestMessage,
  SpawnReplyMessage,
  SpawnErrorMessage,
  SpawnErrorType,
} from '../types.js';
import { Cluster } from '../cluster/cluster.js';
import { BehaviorRegistry } from './behavior-registry.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Function to send a reply back to the requesting node.
 */
type SendReplyFn = (reply: SpawnReplyMessage | SpawnErrorMessage) => Promise<void>;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Creates an error reply message.
 *
 * @param spawnId - Spawn request identifier
 * @param errorType - Type of error
 * @param message - Error message
 * @returns SpawnErrorMessage
 */
function createErrorReply(
  spawnId: SpawnRequestMessage['spawnId'],
  errorType: SpawnErrorType,
  message: string,
): SpawnErrorMessage {
  return {
    type: 'spawn_error',
    spawnId,
    errorType,
    message,
  };
}

/**
 * Creates a success reply message.
 *
 * @param spawnId - Spawn request identifier
 * @param serverId - ID of the spawned server
 * @param nodeId - Node where server is running
 * @returns SpawnReplyMessage
 */
function createSuccessReply(
  spawnId: SpawnRequestMessage['spawnId'],
  serverId: string,
  nodeId: NodeId,
): SpawnReplyMessage {
  return {
    type: 'spawn_reply',
    spawnId,
    serverId,
    nodeId,
  };
}

// =============================================================================
// SpawnHandler
// =============================================================================

/**
 * Handler for processing incoming remote spawn requests.
 *
 * When a remote node requests spawning a GenServer on this node,
 * this module looks up the behavior in the registry, creates the
 * GenServer, and sends back the result.
 *
 * @example
 * ```typescript
 * // This is called internally by the Cluster when a spawn_request arrives
 * await SpawnHandler.handleIncomingSpawn(
 *   message,
 *   fromNodeId,
 *   async (reply) => await transport.send(fromNodeId, reply),
 * );
 * ```
 */
export const SpawnHandler = {
  /**
   * Processes an incoming spawn request and sends the reply.
   *
   * This is called by the Cluster when a spawn_request message arrives.
   * It looks up the behavior in the registry, spawns the GenServer,
   * handles registration, and sends back the result.
   *
   * @param message - Incoming spawn request message
   * @param fromNodeId - Source node ID
   * @param sendReply - Function to send reply back
   * @internal
   */
  async handleIncomingSpawn(
    message: SpawnRequestMessage,
    fromNodeId: NodeId,
    sendReply: SendReplyFn,
  ): Promise<void> {
    const { spawnId, behaviorName, options } = message;

    // Look up the behavior in the registry
    const behavior = BehaviorRegistry.get(behaviorName);
    if (!behavior) {
      await sendReply(
        createErrorReply(
          spawnId,
          'behavior_not_found',
          `Behavior '${behaviorName}' is not registered`,
        ),
      );
      return;
    }

    // Import GenServer dynamically to avoid circular dependency
    const { GenServer } = await import('../../core/gen-server.js');

    // Get local node ID early for SerializedRef construction
    const localNodeId = Cluster.getLocalNodeId();

    try {
      // Build start options without undefined values (exactOptionalPropertyTypes)
      const startOptions: { name?: string; initTimeout?: number } = {};
      if (options.name !== undefined) {
        startOptions.name = options.name;
      }
      if (options.initTimeout !== undefined) {
        startOptions.initTimeout = options.initTimeout;
      }

      // Start the GenServer with the registered behavior
      const ref = await GenServer.start(behavior, startOptions);

      // Handle registration based on strategy
      if (options.registration === 'global' && options.name) {
        // Import GlobalRegistry dynamically
        const { GlobalRegistry } = await import('../registry/index.js');
        try {
          // GlobalRegistry expects SerializedRef, not GenServerRef
          await GlobalRegistry.register(options.name, {
            id: ref.id,
            nodeId: localNodeId,
          });
        } catch (regError) {
          // Registration failed - stop the server and report error
          GenServer.stop(ref).catch(() => {
            // Ignore stop errors
          });

          await sendReply(
            createErrorReply(
              spawnId,
              'registration_failed',
              regError instanceof Error ? regError.message : String(regError),
            ),
          );
          return;
        }
      }

      // Send success reply
      await sendReply(createSuccessReply(spawnId, ref.id, localNodeId));
    } catch (error) {
      // Determine error type
      let errorType: SpawnErrorType = 'unknown_error';
      let errorMessage = 'Unknown error';

      if (error instanceof Error) {
        errorMessage = error.message;

        // Check for specific error types
        if (error.name === 'InitTimeoutError') {
          errorType = 'init_timeout';
        } else if (
          error.message.includes('init') ||
          error.name === 'InitError'
        ) {
          errorType = 'init_failed';
        }
      }

      await sendReply(createErrorReply(spawnId, errorType, errorMessage));
    }
  },
} as const;
