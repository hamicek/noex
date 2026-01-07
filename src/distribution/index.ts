/**
 * Distribution module for noex cluster communication.
 *
 * Provides Erlang-style P2P clustering capabilities for transparent
 * message passing between GenServer instances across multiple nodes.
 *
 * @module distribution
 *
 * @example
 * ```typescript
 * import { NodeId, Serializer, CLUSTER_DEFAULTS } from 'noex/distribution';
 *
 * // Parse and validate a node identifier
 * const nodeId = NodeId.parse('app1@192.168.1.1:4369');
 *
 * // Serialize a cluster message
 * const buffer = Serializer.serialize(message, nodeId);
 * ```
 */

// =============================================================================
// Types
// =============================================================================

export type {
  // Node identification (NodeId type is re-exported from node-id.ts)
  NodeStatus,
  NodeInfo,

  // Configuration
  ClusterConfig,

  // Messages
  CallId,
  ClusterMessage,
  HeartbeatMessage,
  CallMessage,
  CallReplyMessage,
  CallErrorMessage,
  CastMessage,
  RegistrySyncMessage,
  NodeDownMessage,
  RemoteErrorType,
  NodeDownReason,

  // Wire protocol
  MessageEnvelope,
  SerializedRef,
  RegistrySyncEntry,

  // Event handlers
  NodeUpHandler,
  NodeDownHandler,
  ClusterStatusHandler,
  ClusterStatus,
} from './types.js';

// =============================================================================
// Error Classes
// =============================================================================

export {
  InvalidNodeIdError,
  RemoteServerNotRunningError,
  RemoteCallTimeoutError,
  NodeNotReachableError,
  MessageSerializationError,
  ClusterNotStartedError,
  InvalidClusterConfigError,
} from './types.js';

// =============================================================================
// Constants
// =============================================================================

export { CLUSTER_DEFAULTS } from './types.js';

// =============================================================================
// NodeId Utilities
// =============================================================================

export { NodeId, isNodeId } from './node-id.js';
export type { NodeId as NodeIdType, NodeIdComponents } from './node-id.js';

// =============================================================================
// Serialization
// =============================================================================

export {
  Serializer,
  generateCallId,
  isValidCallId,
  type SerializeOptions,
  type DeserializeOptions,
} from './serialization.js';
