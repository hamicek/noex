/**
 * Protocol definitions for Dashboard client-server communication.
 *
 * Uses JSON messages over TCP with length-prefix framing:
 * [4 bytes: message length (big-endian uint32)][JSON payload]
 */

import type { ObserverSnapshot, ClusterObserverSnapshot } from '../../observer/types.js';
import type { ObserverEvent } from '../../core/types.js';

// =============================================================================
// Server -> Client Messages
// =============================================================================

/**
 * Welcome message sent when a client connects.
 */
export interface WelcomeMessage {
  readonly type: 'welcome';
  readonly payload: {
    readonly version: string;
    readonly serverUptime: number;
  };
}

/**
 * Snapshot of the current system state.
 */
export interface SnapshotMessage {
  readonly type: 'snapshot';
  readonly payload: ObserverSnapshot;
}

/**
 * Real-time observer event.
 */
export interface EventMessage {
  readonly type: 'event';
  readonly payload: ObserverEvent;
}

/**
 * Error message from server.
 */
export interface ErrorMessage {
  readonly type: 'error';
  readonly payload: {
    readonly code: string;
    readonly message: string;
  };
}

/**
 * Cluster snapshot message.
 * Contains aggregated data from all nodes in the cluster.
 */
export interface ClusterSnapshotMessage {
  readonly type: 'cluster_snapshot';
  readonly payload: ClusterObserverSnapshot;
}

/**
 * Cluster availability status message.
 * Indicates whether cluster mode is available.
 */
export interface ClusterStatusMessage {
  readonly type: 'cluster_status';
  readonly payload: {
    readonly available: boolean;
    readonly nodeId?: string;
  };
}

/**
 * All possible server-to-client message types.
 */
export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | EventMessage
  | ErrorMessage
  | ClusterSnapshotMessage
  | ClusterStatusMessage;

// =============================================================================
// Client -> Server Messages
// =============================================================================

/**
 * Request a snapshot of current system state.
 */
export interface GetSnapshotRequest {
  readonly type: 'get_snapshot';
}

/**
 * Request to stop a process.
 */
export interface StopProcessRequest {
  readonly type: 'stop_process';
  readonly payload: {
    readonly processId: string;
    readonly reason?: string;
  };
}

/**
 * Keep-alive ping.
 */
export interface PingRequest {
  readonly type: 'ping';
}

/**
 * Request cluster snapshot (if cluster is available).
 */
export interface GetClusterSnapshotRequest {
  readonly type: 'get_cluster_snapshot';
}

/**
 * Request cluster status.
 */
export interface GetClusterStatusRequest {
  readonly type: 'get_cluster_status';
}

/**
 * All possible client-to-server message types.
 */
export type ClientMessage =
  | GetSnapshotRequest
  | StopProcessRequest
  | PingRequest
  | GetClusterSnapshotRequest
  | GetClusterStatusRequest;

// =============================================================================
// Protocol Constants
// =============================================================================

/**
 * Protocol version string.
 */
export const PROTOCOL_VERSION = '1.0.0';

/**
 * Length of the message length prefix in bytes.
 */
export const LENGTH_PREFIX_SIZE = 4;

/**
 * Maximum allowed message size in bytes (1MB).
 */
export const MAX_MESSAGE_SIZE = 1024 * 1024;

// =============================================================================
// Serialization Utilities
// =============================================================================

/**
 * Serialize a message to a framed buffer.
 * Format: [4-byte length prefix (big-endian)][JSON payload]
 */
export function serializeMessage(message: ServerMessage | ClientMessage): Buffer {
  const json = JSON.stringify(message);
  const jsonBuffer = Buffer.from(json, 'utf-8');
  const frame = Buffer.alloc(LENGTH_PREFIX_SIZE + jsonBuffer.length);
  frame.writeUInt32BE(jsonBuffer.length, 0);
  jsonBuffer.copy(frame, LENGTH_PREFIX_SIZE);
  return frame;
}

/**
 * Result of attempting to parse a message from a buffer.
 */
export interface ParseResult<T> {
  /** The parsed message, if complete */
  readonly message: T | null;
  /** Number of bytes consumed from the buffer */
  readonly bytesConsumed: number;
}

/**
 * Attempt to parse a complete message from a buffer.
 * Returns null message if buffer doesn't contain a complete message.
 */
export function parseMessage<T extends ServerMessage | ClientMessage>(
  buffer: Buffer,
): ParseResult<T> {
  // Need at least 4 bytes for length prefix
  if (buffer.length < LENGTH_PREFIX_SIZE) {
    return { message: null, bytesConsumed: 0 };
  }

  const messageLength = buffer.readUInt32BE(0);

  // Validate message size
  if (messageLength > MAX_MESSAGE_SIZE) {
    throw new ProtocolError(
      'MESSAGE_TOO_LARGE',
      `Message size ${messageLength} exceeds maximum ${MAX_MESSAGE_SIZE}`,
    );
  }

  // Check if we have the complete message
  const totalLength = LENGTH_PREFIX_SIZE + messageLength;
  if (buffer.length < totalLength) {
    return { message: null, bytesConsumed: 0 };
  }

  // Parse the JSON payload
  const jsonData = buffer.subarray(LENGTH_PREFIX_SIZE, totalLength).toString('utf-8');

  try {
    const message = JSON.parse(jsonData) as T;
    return { message, bytesConsumed: totalLength };
  } catch {
    throw new ProtocolError('PARSE_ERROR', 'Invalid JSON in message payload');
  }
}

// =============================================================================
// Errors
// =============================================================================

/**
 * Error codes for protocol errors.
 */
export type ProtocolErrorCode =
  | 'PARSE_ERROR'
  | 'MESSAGE_TOO_LARGE'
  | 'INVALID_MESSAGE_TYPE'
  | 'CONNECTION_CLOSED';

/**
 * Error thrown for protocol-level issues.
 */
export class ProtocolError extends Error {
  override readonly name = 'ProtocolError' as const;

  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
  }
}
