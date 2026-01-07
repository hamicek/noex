/**
 * Pending calls manager for remote call correlation.
 *
 * Tracks pending remote calls and matches them with their responses.
 * Handles timeout management and cleanup of stale calls.
 *
 * @module distribution/remote/pending-calls
 */

import type { CallId } from '../types.js';
import { RemoteCallTimeoutError, RemoteServerNotRunningError } from '../types.js';
import type { NodeId } from '../node-id.js';

// =============================================================================
// Types
// =============================================================================

/**
 * State of a pending call.
 */
type PendingCallState = 'pending' | 'resolved' | 'rejected' | 'timeout';

/**
 * Information about a pending remote call.
 */
interface PendingCall<T = unknown> {
  /** Unique call identifier */
  readonly callId: CallId;

  /** Target server ID */
  readonly serverId: string;

  /** Target node ID */
  readonly nodeId: NodeId;

  /** Promise resolve function */
  readonly resolve: (value: T) => void;

  /** Promise reject function */
  readonly reject: (error: Error) => void;

  /** Timeout handle */
  readonly timeoutHandle: ReturnType<typeof setTimeout>;

  /** Timeout duration in milliseconds */
  readonly timeoutMs: number;

  /** Timestamp when call was initiated */
  readonly createdAt: number;

  /** Current state of the call */
  state: PendingCallState;
}

/**
 * Statistics about pending calls.
 */
export interface PendingCallsStats {
  /** Number of currently pending calls */
  readonly pendingCount: number;

  /** Total number of calls initiated */
  readonly totalInitiated: number;

  /** Total number of calls resolved successfully */
  readonly totalResolved: number;

  /** Total number of calls rejected with error */
  readonly totalRejected: number;

  /** Total number of calls that timed out */
  readonly totalTimedOut: number;
}

// =============================================================================
// PendingCalls Manager
// =============================================================================

/**
 * Manages pending remote calls for correlation and timeout handling.
 *
 * Thread-safe tracking of remote calls from initiation to resolution.
 * Automatically cleans up timed-out calls.
 *
 * @example
 * ```typescript
 * const pendingCalls = new PendingCalls();
 *
 * // Register a new call
 * const { callId, promise } = pendingCalls.register({
 *   serverId: 'server1',
 *   nodeId,
 *   timeoutMs: 5000,
 * });
 *
 * // Send the call message with callId...
 *
 * // Later, when response arrives:
 * pendingCalls.resolve(callId, result);
 *
 * // The promise will resolve with the result
 * const result = await promise;
 * ```
 */
export class PendingCalls {
  private readonly pending = new Map<CallId, PendingCall>();

  // Statistics
  private totalInitiated = 0;
  private totalResolved = 0;
  private totalRejected = 0;
  private totalTimedOut = 0;

  /**
   * Registers a new pending call.
   *
   * Creates a promise that will resolve when the call response arrives
   * or reject on timeout/error.
   *
   * @param options - Call registration options
   * @returns Call ID and promise for the result
   */
  register<T>(options: {
    readonly serverId: string;
    readonly nodeId: NodeId;
    readonly timeoutMs: number;
    readonly callId: CallId;
  }): { readonly callId: CallId; readonly promise: Promise<T> } {
    const { callId, serverId, nodeId, timeoutMs } = options;

    // Create the pending call entry
    let pendingCall: PendingCall<T>;

    const promise = new Promise<T>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.handleTimeout(callId);
      }, timeoutMs);

      // Don't block process exit
      if (timeoutHandle.unref) {
        timeoutHandle.unref();
      }

      pendingCall = {
        callId,
        serverId,
        nodeId,
        resolve,
        reject,
        timeoutHandle,
        timeoutMs,
        createdAt: Date.now(),
        state: 'pending',
      };

      this.pending.set(callId, pendingCall as PendingCall);
    });

    this.totalInitiated++;

    return { callId, promise };
  }

  /**
   * Resolves a pending call with a successful result.
   *
   * @param callId - Call identifier
   * @param result - Result value
   * @returns true if call was found and resolved, false if not found
   */
  resolve<T>(callId: CallId, result: T): boolean {
    const pendingCall = this.pending.get(callId) as PendingCall<T> | undefined;

    if (!pendingCall || pendingCall.state !== 'pending') {
      return false;
    }

    clearTimeout(pendingCall.timeoutHandle);
    pendingCall.state = 'resolved';
    this.pending.delete(callId);
    this.totalResolved++;

    pendingCall.resolve(result);
    return true;
  }

  /**
   * Rejects a pending call with an error.
   *
   * @param callId - Call identifier
   * @param error - Error to reject with
   * @returns true if call was found and rejected, false if not found
   */
  reject(callId: CallId, error: Error): boolean {
    const pendingCall = this.pending.get(callId);

    if (!pendingCall || pendingCall.state !== 'pending') {
      return false;
    }

    clearTimeout(pendingCall.timeoutHandle);
    pendingCall.state = 'rejected';
    this.pending.delete(callId);
    this.totalRejected++;

    pendingCall.reject(error);
    return true;
  }

  /**
   * Rejects a pending call with a server not running error.
   *
   * @param callId - Call identifier
   * @returns true if call was found and rejected, false if not found
   */
  rejectServerNotRunning(callId: CallId): boolean {
    const pendingCall = this.pending.get(callId);
    if (!pendingCall) {
      return false;
    }

    return this.reject(
      callId,
      new RemoteServerNotRunningError(pendingCall.serverId, pendingCall.nodeId),
    );
  }

  /**
   * Checks if a call is pending.
   *
   * @param callId - Call identifier
   * @returns true if call is still pending
   */
  isPending(callId: CallId): boolean {
    const pendingCall = this.pending.get(callId);
    return pendingCall?.state === 'pending';
  }

  /**
   * Gets information about a pending call.
   *
   * @param callId - Call identifier
   * @returns Call info if found, undefined otherwise
   */
  get(callId: CallId): {
    readonly serverId: string;
    readonly nodeId: NodeId;
    readonly timeoutMs: number;
    readonly createdAt: number;
    readonly elapsedMs: number;
  } | undefined {
    const pendingCall = this.pending.get(callId);
    if (!pendingCall) {
      return undefined;
    }

    return {
      serverId: pendingCall.serverId,
      nodeId: pendingCall.nodeId,
      timeoutMs: pendingCall.timeoutMs,
      createdAt: pendingCall.createdAt,
      elapsedMs: Date.now() - pendingCall.createdAt,
    };
  }

  /**
   * Returns the number of currently pending calls.
   */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Returns statistics about pending calls.
   */
  getStats(): PendingCallsStats {
    return {
      pendingCount: this.pending.size,
      totalInitiated: this.totalInitiated,
      totalResolved: this.totalResolved,
      totalRejected: this.totalRejected,
      totalTimedOut: this.totalTimedOut,
    };
  }

  /**
   * Rejects all pending calls to a specific node.
   *
   * Called when a node goes down to fail all pending calls to that node.
   *
   * @param nodeId - Node identifier
   * @param error - Error to reject with
   * @returns Number of calls rejected
   */
  rejectAllForNode(nodeId: NodeId, error: Error): number {
    let rejected = 0;

    for (const [callId, pendingCall] of this.pending) {
      if (pendingCall.nodeId === nodeId && pendingCall.state === 'pending') {
        clearTimeout(pendingCall.timeoutHandle);
        pendingCall.state = 'rejected';
        this.pending.delete(callId);
        this.totalRejected++;
        pendingCall.reject(error);
        rejected++;
      }
    }

    return rejected;
  }

  /**
   * Clears all pending calls.
   *
   * Used during shutdown to clean up resources.
   *
   * @param error - Optional error to reject pending calls with
   */
  clear(error?: Error): void {
    const rejectError = error ?? new Error('Pending calls cleared');

    for (const [callId, pendingCall] of this.pending) {
      if (pendingCall.state === 'pending') {
        clearTimeout(pendingCall.timeoutHandle);
        pendingCall.state = 'rejected';
        pendingCall.reject(rejectError);
        this.totalRejected++;
      }
    }

    this.pending.clear();
  }

  /**
   * Handles timeout for a pending call.
   *
   * @param callId - Call identifier
   */
  private handleTimeout(callId: CallId): void {
    const pendingCall = this.pending.get(callId);

    if (!pendingCall || pendingCall.state !== 'pending') {
      return;
    }

    pendingCall.state = 'timeout';
    this.pending.delete(callId);
    this.totalTimedOut++;

    pendingCall.reject(
      new RemoteCallTimeoutError(
        pendingCall.serverId,
        pendingCall.nodeId,
        pendingCall.timeoutMs,
      ),
    );
  }
}
