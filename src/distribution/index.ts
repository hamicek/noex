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
  SpawnId,
  MonitorId,
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

  // Remote spawn messages
  SpawnRequestMessage,
  SpawnReplyMessage,
  SpawnErrorMessage,
  SpawnRequestOptions,
  SpawnErrorType,

  // Process monitoring messages
  ProcessDownReason,
  MonitorRequestMessage,
  MonitorAckMessage,
  DemonitorRequestMessage,
  ProcessDownMessage,

  // Process linking messages
  LinkId,
  LinkRequestMessage,
  LinkAckMessage,
  UnlinkRequestMessage,
  ExitSignalMessage,

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
  // Remote spawn errors
  BehaviorNotFoundError,
  RemoteSpawnTimeoutError,
  RemoteSpawnInitError,
  RemoteSpawnRegistrationError,
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
  generateSpawnId,
  isValidSpawnId,
  generateMonitorId,
  isValidMonitorId,
  generateLinkId,
  isValidLinkId,
  type SerializeOptions,
  type DeserializeOptions,
} from './serialization.js';

// =============================================================================
// Transport Layer
// =============================================================================

export {
  Connection,
  Transport,
  type ConnectionState,
  type ConnectionConfig,
  type ConnectionEvents,
  type ConnectionStats,
  type TransportState,
  type TransportConfig,
  type TransportEvents,
  type TransportStats,
} from './transport/index.js';

// =============================================================================
// Cluster Layer
// =============================================================================

export {
  Cluster,
  Membership,
  type ClusterEvents,
  type MembershipConfig,
  type MembershipEvents,
} from './cluster/index.js';

// =============================================================================
// Remote Call/Cast
// =============================================================================

export {
  RemoteCall,
  CallHandler,
  PendingCalls,
  _resetRemoteCallState,
  // Remote spawn
  BehaviorRegistry,
  PendingSpawns,
  RemoteSpawn,
  SpawnHandler,
  _resetRemoteSpawnState,
  type RemoteCallOptions,
  type RemoteCallStats,
  type PendingCallsStats,
  type BehaviorRegistryStats,
  type PendingSpawnsStats,
  type SpawnResult,
  type RemoteSpawnOptions,
  type RemoteSpawnStats,
} from './remote/index.js';

// =============================================================================
// Global Registry
// =============================================================================

export {
  GlobalRegistry,
  GlobalNameConflictError,
  GlobalNameNotFoundError,
  type GlobalRegistryEvents,
  type GlobalRegistryStats,
} from './registry/index.js';

// =============================================================================
// Process Monitoring
// =============================================================================

export {
  MonitorRegistry,
  RemoteMonitor,
  RemoteMonitorTimeoutError,
  _resetRemoteMonitorState,
  RemoteLink,
  RemoteLinkTimeoutError,
  _resetRemoteLinkState,
  type OutgoingMonitor,
  type IncomingMonitor,
  type MonitorRegistryStats,
  type RemoteMonitorOptions,
  type RemoteMonitorStats,
  type RemoteLinkOptions,
  type RemoteLinkStats,
} from './monitor/index.js';

// =============================================================================
// Distributed Supervisor
// =============================================================================

export {
  DistributedSupervisor,
  DistributedChildRegistry,
  NodeSelectorImpl,
  // Error classes
  NoAvailableNodeError,
  DistributedBehaviorNotFoundError,
  DistributedDuplicateChildError,
  DistributedChildNotFoundError,
  DistributedMaxRestartsExceededError,
  DistributedInvalidSimpleOneForOneError,
  DistributedMissingChildTemplateError,
  DistributedChildClaimError,
  DistributedSupervisorError,
  // Constants
  DISTRIBUTED_SUPERVISOR_DEFAULTS,
  // Types
  type NodeSelectorType,
  type NodeSelectorFn,
  type NodeSelector,
  type DistributedChildSpec,
  type DistributedChildTemplate,
  type DistributedAutoShutdown,
  type DistributedSupervisorOptions,
  type DistributedSupervisorRef,
  type DistributedChildInfo,
  type DistributedRunningChild,
  type DistributedSupervisorStats,
  type DistributedSupervisorEvent,
  type DistributedSupervisorEventHandler,
  type ChildRegistrationStatus,
} from './supervisor/index.js';

// =============================================================================
// Cluster Observer
// =============================================================================

export {
  ClusterObserver,
  type NodeObserverStatus,
  type NodeObserverSnapshot,
  type ClusterAggregatedStats,
  type ClusterObserverSnapshot,
  type ClusterObserverEvent,
  type ClusterObserverEventHandler,
  type ClusterSnapshotOptions,
} from '../observer/index.js';
