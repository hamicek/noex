/**
 * Remote call/cast implementation for distributed GenServer communication.
 *
 * Provides transparent message passing between GenServer instances across
 * cluster nodes. Handles serialization, timeout management, and error handling.
 *
 * @module distribution/remote/remote-call
 */

import type {
  NodeId,
  CallId,
  CallMessage,
  CallReplyMessage,
  CallErrorMessage,
  CastMessage,
  SerializedRef,
  MessageEnvelope,
  RemoteErrorType,
} from '../types.js';
import {
  CLUSTER_DEFAULTS,
  NodeNotReachableError,
  RemoteServerNotRunningError,
  RemoteCallTimeoutError,
  ClusterNotStartedError,
} from '../types.js';
import { generateCallId } from '../serialization.js';
import { Cluster } from '../cluster/cluster.js';
import { PendingCalls } from './pending-calls.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Options for remote call.
 */
export interface RemoteCallOptions {
  /** Timeout in milliseconds */
  readonly timeout?: number;
}

/**
 * Result of remote call statistics.
 */
export interface RemoteCallStats {
  /** Number of pending calls */
  readonly pendingCalls: number;

  /** Total calls initiated */
  readonly totalCalls: number;

  /** Total calls resolved */
  readonly totalResolved: number;

  /** Total calls rejected */
  readonly totalRejected: number;

  /** Total calls timed out */
  readonly totalTimedOut: number;

  /** Total casts sent */
  readonly totalCasts: number;
}

// =============================================================================
// State
// =============================================================================

/** Pending calls manager instance */
const pendingCalls = new PendingCalls();

/** Total casts sent counter */
let totalCasts = 0;

/** Whether the remote call module is initialized */
let initialized = false;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initializes the remote call module.
 *
 * Sets up message handlers on the transport layer.
 * Called automatically on first remote call if not already initialized.
 */
function ensureInitialized(): void {
  if (initialized) {
    return;
  }

  // Subscribe to cluster node down events
  Cluster.onNodeDown((nodeId, reason) => {
    // Reject all pending calls to the downed node
    const error = new NodeNotReachableError(nodeId);
    pendingCalls.rejectAllForNode(nodeId, error);
  });

  initialized = true;
}

/**
 * Resets the remote call module state.
 * Used for testing.
 *
 * @internal
 */
export function _resetRemoteCallState(): void {
  pendingCalls.clear();
  totalCasts = 0;
  initialized = false;
}

// =============================================================================
// Remote Call
// =============================================================================

/**
 * Remote call operations for distributed GenServer communication.
 *
 * @example
 * ```typescript
 * import { RemoteCall } from 'noex/distribution';
 *
 * // Make a remote call
 * const result = await RemoteCall.call(remoteRef, { type: 'get' });
 *
 * // Send a remote cast
 * RemoteCall.cast(remoteRef, { type: 'increment' });
 * ```
 */
export const RemoteCall = {
  /**
   * Sends a synchronous call to a remote GenServer.
   *
   * The call will be serialized, sent to the target node, and the response
   * will be awaited with timeout handling.
   *
   * @param ref - Serialized reference to the target GenServer
   * @param msg - Message to send
   * @param options - Call options
   * @returns Promise resolving to the call reply
   * @throws {ClusterNotStartedError} If cluster is not running
   * @throws {NodeNotReachableError} If target node is not connected
   * @throws {RemoteCallTimeoutError} If call times out
   * @throws {RemoteServerNotRunningError} If target server is not running
   */
  async call<CallReply>(
    ref: SerializedRef,
    msg: unknown,
    options: RemoteCallOptions = {},
  ): Promise<CallReply> {
    ensureInitialized();

    const transport = Cluster._getTransport();
    const localNodeId = Cluster.getLocalNodeId();
    const timeoutMs = options.timeout ?? CLUSTER_DEFAULTS.HEARTBEAT_INTERVAL_MS;

    // Check if target node is connected
    if (!transport.isConnectedTo(ref.nodeId)) {
      throw new NodeNotReachableError(ref.nodeId);
    }

    // Generate unique call ID
    const callId = generateCallId();

    // Register pending call
    const { promise } = pendingCalls.register<CallReply>({
      callId,
      serverId: ref.id,
      nodeId: ref.nodeId,
      timeoutMs,
    });

    // Create and send call message
    const callMessage: CallMessage = {
      type: 'call',
      callId,
      ref,
      msg,
      timeoutMs,
      sentAt: Date.now(),
    };

    try {
      await transport.send(ref.nodeId, callMessage);
    } catch (error) {
      // Failed to send - reject the pending call
      pendingCalls.reject(
        callId,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }

    // Wait for response
    return promise;
  },

  /**
   * Sends an asynchronous cast to a remote GenServer.
   *
   * Fire-and-forget: the sender does not wait for a response.
   * If the cluster is not running or target node is not connected,
   * the cast is silently dropped.
   *
   * @param ref - Serialized reference to the target GenServer
   * @param msg - Message to send
   */
  cast(ref: SerializedRef, msg: unknown): void {
    // Silently drop if cluster not running
    if (Cluster.getStatus() !== 'running') {
      return;
    }

    ensureInitialized();

    let transport;
    try {
      transport = Cluster._getTransport();
    } catch {
      // Cluster not running, silently drop
      return;
    }

    // If not connected, silently drop the cast
    if (!transport.isConnectedTo(ref.nodeId)) {
      return;
    }

    const castMessage: CastMessage = {
      type: 'cast',
      ref,
      msg,
    };

    // Fire and forget
    transport.send(ref.nodeId, castMessage).catch(() => {
      // Silently ignore send errors for casts
    });

    totalCasts++;
  },

  /**
   * Returns statistics about remote calls.
   */
  getStats(): RemoteCallStats {
    const pending = pendingCalls.getStats();
    return {
      pendingCalls: pending.pendingCount,
      totalCalls: pending.totalInitiated,
      totalResolved: pending.totalResolved,
      totalRejected: pending.totalRejected,
      totalTimedOut: pending.totalTimedOut,
      totalCasts,
    };
  },

  /**
   * Handles an incoming call reply message.
   *
   * Called by the Cluster when a call_reply message is received.
   *
   * @param message - Call reply message
   * @internal
   */
  _handleCallReply(message: CallReplyMessage): void {
    pendingCalls.resolve(message.callId, message.result);
  },

  /**
   * Handles an incoming call error message.
   *
   * Called by the Cluster when a call_error message is received.
   *
   * @param message - Call error message
   * @internal
   */
  _handleCallError(message: CallErrorMessage): void {
    const pendingInfo = pendingCalls.get(message.callId);
    if (!pendingInfo) {
      return;
    }

    let error: Error;

    switch (message.errorType) {
      case 'server_not_running':
        error = new RemoteServerNotRunningError(
          pendingInfo.serverId,
          pendingInfo.nodeId,
        );
        break;

      case 'call_timeout':
        error = new RemoteCallTimeoutError(
          pendingInfo.serverId,
          pendingInfo.nodeId,
          pendingInfo.timeoutMs,
        );
        break;

      default:
        error = new Error(message.message);
        break;
    }

    pendingCalls.reject(message.callId, error);
  },

  /**
   * Clears all pending calls.
   *
   * Called during cluster shutdown.
   *
   * @internal
   */
  _clear(): void {
    pendingCalls.clear(new ClusterNotStartedError());
  },
} as const;

// =============================================================================
// Call Handler (for receiving calls on this node)
// =============================================================================

/**
 * Handler for processing incoming remote calls on this node.
 *
 * When a remote node sends a call to a GenServer on this node,
 * this module processes it and sends back the reply.
 */
export const CallHandler = {
  /**
   * Processes an incoming call message and sends the reply.
   *
   * This is called by the Cluster when a call message arrives.
   * It locates the target GenServer, invokes the call, and sends the response.
   *
   * @param message - Incoming call message
   * @param fromNodeId - Source node ID
   * @param sendReply - Function to send reply back
   * @internal
   */
  async handleIncomingCall(
    message: CallMessage,
    fromNodeId: NodeId,
    sendReply: (reply: CallReplyMessage | CallErrorMessage) => Promise<void>,
  ): Promise<void> {
    // Import GenServer and Registry dynamically to avoid circular dependency
    const { GenServer } = await import('../../core/gen-server.js');
    const { Registry } = await import('../../core/registry.js');

    const { callId, ref, msg } = message;

    try {
      // Get the server reference - first try by process ID, then by registered name
      let serverRef = GenServer._getRefById(ref.id);

      // If not found by ID, try Registry lookup (for named servers)
      if (!serverRef) {
        serverRef = Registry.whereis(ref.id);
      }

      if (!serverRef) {
        const errorReply: CallErrorMessage = {
          type: 'call_error',
          callId,
          errorType: 'server_not_running',
          message: `GenServer '${ref.id}' is not running`,
        };
        await sendReply(errorReply);
        return;
      }

      // Make the local call
      const result = await GenServer.call(serverRef, msg, {
        timeout: message.timeoutMs,
      });

      // Send successful reply
      const reply: CallReplyMessage = {
        type: 'call_reply',
        callId,
        result,
      };
      await sendReply(reply);
    } catch (error) {
      // Determine error type
      let errorType: RemoteErrorType = 'unknown_error';
      let errorMessage = 'Unknown error';

      if (error instanceof Error) {
        errorMessage = error.message;

        if (error.name === 'ServerNotRunningError') {
          errorType = 'server_not_running';
        } else if (error.name === 'CallTimeoutError') {
          errorType = 'call_timeout';
        }
      }

      const errorReply: CallErrorMessage = {
        type: 'call_error',
        callId,
        errorType,
        message: errorMessage,
      };
      await sendReply(errorReply);
    }
  },

  /**
   * Processes an incoming cast message.
   *
   * This is called by the Cluster when a cast message arrives.
   * It locates the target GenServer and invokes the cast.
   *
   * @param message - Incoming cast message
   * @internal
   */
  async handleIncomingCast(message: CastMessage): Promise<void> {
    // Import GenServer and Registry dynamically to avoid circular dependency
    const { GenServer } = await import('../../core/gen-server.js');
    const { Registry } = await import('../../core/registry.js');

    const { ref, msg } = message;

    try {
      // Get the server reference - first try by process ID, then by registered name
      let serverRef = GenServer._getRefById(ref.id);

      // If not found by ID, try Registry lookup (for named servers)
      if (!serverRef) {
        serverRef = Registry.whereis(ref.id);
      }

      if (!serverRef) {
        // Silently ignore casts to non-existent servers
        return;
      }

      // Make the local cast
      GenServer.cast(serverRef, msg);
    } catch {
      // Silently ignore cast errors
    }
  },
} as const;
