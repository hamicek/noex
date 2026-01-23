/**
 * Type definitions for noex distributed cluster communication.
 *
 * This module defines the foundational types for Erlang-style P2P clustering,
 * enabling transparent message passing between GenServer instances across
 * multiple nodes.
 *
 * @module distribution/types
 */

// NodeId type is defined in node-id.ts to enable type-value declaration merging
// Re-export for consumers who import from types.ts
export type { NodeId } from './node-id.js';

// Import for use within this file
import type { NodeId } from './node-id.js';

// =============================================================================
// Cluster Configuration
// =============================================================================

/**
 * Configuration for starting a cluster node.
 *
 * @example
 * ```typescript
 * await Cluster.start({
 *   nodeName: 'app1',
 *   host: '192.168.1.1',
 *   port: 4369,
 *   seeds: ['app2@192.168.1.2:4369'],
 *   clusterSecret: 'my-secure-secret',
 * });
 * ```
 */
export interface ClusterConfig {
  /**
   * Human-readable name for this node.
   * Used as the prefix in the NodeId (e.g., `app1` in `app1@host:port`).
   * Must be a valid identifier: alphanumeric, underscores, hyphens.
   */
  readonly nodeName: string;

  /**
   * Host address this node listens on.
   * Can be an IP address or hostname.
   * @default '0.0.0.0'
   */
  readonly host?: string;

  /**
   * TCP port for cluster communication.
   * @default 4369
   */
  readonly port?: number;

  /**
   * Seed nodes for initial cluster discovery.
   * Format: `name@host:port` for each seed.
   * At least one seed should be reachable for cluster join.
   */
  readonly seeds?: readonly string[];

  /**
   * Shared secret for cluster authentication.
   * All nodes in the cluster must use the same secret.
   * When provided, enables HMAC-based message authentication.
   */
  readonly clusterSecret?: string;

  /**
   * Heartbeat interval in milliseconds.
   * Nodes exchange heartbeats to detect failures.
   * @default 5000
   */
  readonly heartbeatIntervalMs?: number;

  /**
   * Number of missed heartbeats before marking a node as down.
   * Node is considered dead after: heartbeatIntervalMs * heartbeatMissThreshold
   * @default 3
   */
  readonly heartbeatMissThreshold?: number;

  /**
   * Initial delay before first reconnection attempt in milliseconds.
   * Uses exponential backoff with jitter.
   * @default 1000
   */
  readonly reconnectBaseDelayMs?: number;

  /**
   * Maximum delay between reconnection attempts in milliseconds.
   * @default 30000
   */
  readonly reconnectMaxDelayMs?: number;
}

// =============================================================================
// Node Status
// =============================================================================

/**
 * Connection status of a node in the cluster.
 *
 * - `connecting`: Initial connection attempt in progress
 * - `connected`: Actively communicating with successful heartbeats
 * - `disconnected`: Connection lost, attempting reconnection
 */
export type NodeStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * Information about a node in the cluster.
 *
 * Used for membership tracking and discovery.
 */
export interface NodeInfo {
  /** Unique identifier of the node */
  readonly id: NodeId;

  /** Host address of the node */
  readonly host: string;

  /** TCP port of the node */
  readonly port: number;

  /** Current connection status */
  readonly status: NodeStatus;

  /** Number of GenServer processes running on this node */
  readonly processCount: number;

  /** Unix timestamp of last successful heartbeat */
  readonly lastHeartbeatAt: number;

  /** Node's view of its own uptime in milliseconds */
  readonly uptimeMs: number;
}

// =============================================================================
// Serialized References
// =============================================================================

/**
 * Serializable representation of a GenServerRef for network transmission.
 *
 * GenServerRef contains phantom types and symbols that cannot be serialized.
 * This type captures the essential identity information for routing.
 */
export interface SerializedRef {
  /** GenServer instance identifier */
  readonly id: string;

  /** Node where the GenServer is running */
  readonly nodeId: NodeId;
}

// =============================================================================
// Cluster Messages
// =============================================================================

/**
 * Unique identifier for tracking pending remote calls.
 */
export type CallId = string & { readonly __brand: 'CallId' };

/**
 * Unique identifier for tracking pending remote spawn requests.
 */
export type SpawnId = string & { readonly __brand: 'SpawnId' };

/**
 * Unique identifier for process monitors.
 *
 * Used to correlate monitor setup, acknowledgement, and down notifications
 * across distributed nodes.
 */
export type MonitorId = string & { readonly __brand: 'MonitorId' };

/**
 * Unique identifier for bidirectional process links.
 *
 * Used to correlate link setup, acknowledgement, unlink, and exit signal
 * propagation across distributed nodes.
 */
export type LinkId = string & { readonly __brand: 'LinkId' };

/**
 * Registry synchronization entry for distributed registry.
 */
export interface RegistrySyncEntry {
  /** Registered name */
  readonly name: string;

  /** Reference to the registered process */
  readonly ref: SerializedRef;

  /** Unix timestamp when the registration was created */
  readonly registeredAt: number;

  /** Priority for conflict resolution (lower wins) */
  readonly priority: number;
}

/**
 * Discriminated union of all cluster protocol messages.
 *
 * These messages are exchanged between nodes for:
 * - Health monitoring (heartbeat)
 * - Remote procedure calls (call, call_reply, call_error)
 * - Fire-and-forget messaging (cast)
 * - Registry synchronization (registry_sync)
 * - Membership changes (node_down)
 * - Remote spawn (spawn_request, spawn_reply, spawn_error)
 *
 * @example
 * ```typescript
 * function handleMessage(msg: ClusterMessage): void {
 *   switch (msg.type) {
 *     case 'heartbeat':
 *       updateNodeInfo(msg.nodeInfo);
 *       break;
 *     case 'call':
 *       processRemoteCall(msg.ref, msg.msg, msg.callId);
 *       break;
 *     // ... exhaustive handling
 *   }
 * }
 * ```
 */
export type ClusterMessage =
  | HeartbeatMessage
  | CallMessage
  | CallReplyMessage
  | CallErrorMessage
  | CastMessage
  | RegistrySyncMessage
  | NodeDownMessage
  | SpawnRequestMessage
  | SpawnReplyMessage
  | SpawnErrorMessage
  | MonitorRequestMessage
  | MonitorAckMessage
  | DemonitorRequestMessage
  | ProcessDownMessage
  | LinkRequestMessage
  | LinkAckMessage
  | UnlinkRequestMessage
  | ExitSignalMessage;

/**
 * Heartbeat message for health monitoring.
 * Sent periodically to all connected nodes.
 */
export interface HeartbeatMessage {
  readonly type: 'heartbeat';

  /** Current information about the sending node */
  readonly nodeInfo: NodeInfo;

  /** List of nodes known to the sender (for gossip protocol) */
  readonly knownNodes: readonly NodeId[];
}

/**
 * Remote call message - synchronous request expecting a reply.
 */
export interface CallMessage {
  readonly type: 'call';

  /** Unique identifier for this call (for reply correlation) */
  readonly callId: CallId;

  /** Target GenServer reference */
  readonly ref: SerializedRef;

  /** Call message payload (serialized) */
  readonly msg: unknown;

  /** Timeout in milliseconds for this call */
  readonly timeoutMs: number;

  /** Unix timestamp when the call was initiated */
  readonly sentAt: number;
}

/**
 * Successful reply to a remote call.
 */
export interface CallReplyMessage {
  readonly type: 'call_reply';

  /** Correlation identifier matching the original call */
  readonly callId: CallId;

  /** Reply payload (serialized) */
  readonly result: unknown;
}

/**
 * Error reply to a remote call.
 */
export interface CallErrorMessage {
  readonly type: 'call_error';

  /** Correlation identifier matching the original call */
  readonly callId: CallId;

  /** Error type for reconstruction on the calling side */
  readonly errorType: RemoteErrorType;

  /** Error message */
  readonly message: string;

  /** Optional additional error context */
  readonly context?: Record<string, unknown>;
}

/**
 * Types of errors that can occur during remote calls.
 */
export type RemoteErrorType =
  | 'server_not_running'
  | 'call_timeout'
  | 'serialization_error'
  | 'unknown_error';

/**
 * Remote cast message - fire-and-forget asynchronous message.
 */
export interface CastMessage {
  readonly type: 'cast';

  /** Target GenServer reference */
  readonly ref: SerializedRef;

  /** Cast message payload (serialized) */
  readonly msg: unknown;
}

/**
 * Registry synchronization message.
 * Sent on node join and when global registrations change.
 */
export interface RegistrySyncMessage {
  readonly type: 'registry_sync';

  /** Registry entries to synchronize */
  readonly entries: readonly RegistrySyncEntry[];

  /** Whether this is a full sync (true) or incremental update (false) */
  readonly fullSync: boolean;
}

/**
 * Node down notification.
 * Broadcast when a node is detected as unreachable.
 */
export interface NodeDownMessage {
  readonly type: 'node_down';

  /** Identifier of the node that went down */
  readonly nodeId: NodeId;

  /** Unix timestamp when the node was detected as down */
  readonly detectedAt: number;

  /** Reason for considering the node down */
  readonly reason: NodeDownReason;
}

/**
 * Reasons why a node may be considered down.
 */
export type NodeDownReason =
  | 'heartbeat_timeout'
  | 'connection_closed'
  | 'connection_refused'
  | 'graceful_shutdown';

// =============================================================================
// Remote Spawn Messages
// =============================================================================

/**
 * Options passed in spawn request for remote GenServer creation.
 */
export interface SpawnRequestOptions {
  /** Optional name for registry registration */
  readonly name?: string;

  /** Timeout for init() call in milliseconds */
  readonly initTimeout?: number;

  /** Registration strategy on the target node */
  readonly registration?: 'local' | 'global' | 'none';
}

/**
 * Remote spawn request message.
 * Sent to a target node to request starting a GenServer.
 */
export interface SpawnRequestMessage {
  readonly type: 'spawn_request';

  /** Unique identifier for this spawn request (for reply correlation) */
  readonly spawnId: SpawnId;

  /** Name of the behavior registered in BehaviorRegistry */
  readonly behaviorName: string;

  /** Options for the GenServer creation */
  readonly options: SpawnRequestOptions;

  /** Timeout in milliseconds for the entire spawn operation */
  readonly timeoutMs: number;

  /** Unix timestamp when the request was initiated */
  readonly sentAt: number;
}

/**
 * Successful reply to a remote spawn request.
 */
export interface SpawnReplyMessage {
  readonly type: 'spawn_reply';

  /** Correlation identifier matching the original spawn request */
  readonly spawnId: SpawnId;

  /** ID of the successfully spawned GenServer */
  readonly serverId: string;

  /** Node where the GenServer is running */
  readonly nodeId: NodeId;
}

/**
 * Error reply to a remote spawn request.
 */
export interface SpawnErrorMessage {
  readonly type: 'spawn_error';

  /** Correlation identifier matching the original spawn request */
  readonly spawnId: SpawnId;

  /** Type of error that occurred */
  readonly errorType: SpawnErrorType;

  /** Human-readable error message */
  readonly message: string;
}

/**
 * Types of errors that can occur during remote spawn.
 */
export type SpawnErrorType =
  | 'behavior_not_found'
  | 'init_failed'
  | 'init_timeout'
  | 'registration_failed'
  | 'unknown_error';

// =============================================================================
// Process Monitoring Messages
// =============================================================================

/**
 * Reason why a monitored process went down.
 *
 * Following Erlang semantics:
 * - `normal`: Process terminated gracefully via stop()
 * - `shutdown`: Process was shut down by its supervisor
 * - `error`: Process crashed with an exception
 * - `noproc`: Process did not exist when monitor was established
 * - `noconnection`: Node hosting the process became unreachable
 */
export type ProcessDownReason =
  | { readonly type: 'normal' }
  | { readonly type: 'shutdown' }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'noproc' }
  | { readonly type: 'noconnection' };

/**
 * Request to establish a monitor on a remote process.
 *
 * Sent from the monitoring node to the node hosting the monitored process.
 * The target node should respond with MonitorAckMessage.
 */
export interface MonitorRequestMessage {
  readonly type: 'monitor_request';

  /** Unique identifier for this monitor */
  readonly monitorId: MonitorId;

  /** Reference to the process requesting the monitor */
  readonly monitoringRef: SerializedRef;

  /** Reference to the process being monitored */
  readonly monitoredRef: SerializedRef;
}

/**
 * Acknowledgement of a monitor request.
 *
 * Sent from the monitored node back to the monitoring node.
 * If the process doesn't exist, success will be false and a
 * ProcessDownMessage with reason 'noproc' will follow immediately.
 */
export interface MonitorAckMessage {
  readonly type: 'monitor_ack';

  /** Monitor identifier matching the request */
  readonly monitorId: MonitorId;

  /** Whether the monitor was successfully established */
  readonly success: boolean;

  /** Reason for failure (when success is false) */
  readonly reason?: string;
}

/**
 * Request to remove an existing monitor.
 *
 * Sent from the monitoring node when demonitor() is called.
 * No acknowledgement is expected.
 */
export interface DemonitorRequestMessage {
  readonly type: 'demonitor_request';

  /** Monitor identifier to remove */
  readonly monitorId: MonitorId;
}

/**
 * Notification that a monitored process has terminated.
 *
 * Sent from the node hosting the monitored process to the monitoring node.
 * This is a one-way notification with no expected response.
 */
export interface ProcessDownMessage {
  readonly type: 'process_down';

  /** Monitor identifier for correlation */
  readonly monitorId: MonitorId;

  /** Reference to the process that terminated */
  readonly monitoredRef: SerializedRef;

  /** Reason for termination */
  readonly reason: ProcessDownReason;
}

// =============================================================================
// Process Linking Messages
// =============================================================================

/**
 * Request to establish a bidirectional link between two processes across nodes.
 *
 * Unlike monitors (unidirectional observation), links are symmetric:
 * when either linked process terminates abnormally, the other is also terminated
 * (unless it has trapExit enabled, in which case it receives an ExitSignal info message).
 *
 * Sent from the requesting node to the node hosting the target process.
 * The target node should respond with LinkAckMessage.
 */
export interface LinkRequestMessage {
  readonly type: 'link_request';

  /** Unique identifier for this link */
  readonly linkId: LinkId;

  /** Reference to the process initiating the link */
  readonly fromRef: SerializedRef;

  /** Reference to the target process to link with */
  readonly toRef: SerializedRef;
}

/**
 * Acknowledgement of a link request.
 *
 * Sent from the target node back to the requesting node.
 * If the target process doesn't exist, success will be false and reason will indicate why.
 */
export interface LinkAckMessage {
  readonly type: 'link_ack';

  /** Link identifier matching the request */
  readonly linkId: LinkId;

  /** Whether the link was successfully established */
  readonly success: boolean;

  /** Reason for failure (when success is false) */
  readonly reason?: string;
}

/**
 * Request to remove an existing link.
 *
 * Sent from either node when unlink() is called or when a linked process
 * terminates normally (normal exit does not propagate through links).
 * No acknowledgement is expected (fire-and-forget).
 */
export interface UnlinkRequestMessage {
  readonly type: 'unlink_request';

  /** Link identifier to remove */
  readonly linkId: LinkId;
}

/**
 * Exit signal propagation through a link.
 *
 * Sent from the node where a linked process terminated abnormally
 * to the node hosting the other linked process.
 * The receiving node should either terminate the target process
 * or deliver an ExitSignal info message if trapExit is enabled.
 */
export interface ExitSignalMessage {
  readonly type: 'exit_signal';

  /** Link identifier for correlation */
  readonly linkId: LinkId;

  /** Reference to the process that terminated */
  readonly fromRef: SerializedRef;

  /** Reference to the process that should receive the exit signal */
  readonly toRef: SerializedRef;

  /** Reason for termination of the source process */
  readonly reason: ProcessDownReason;
}

// =============================================================================
// Wire Protocol
// =============================================================================

/**
 * Envelope wrapping all cluster messages for network transmission.
 *
 * Includes metadata for routing, authentication, and protocol versioning.
 */
export interface MessageEnvelope {
  /** Protocol version for forward/backward compatibility */
  readonly version: 1;

  /** Sender node identifier */
  readonly from: NodeId;

  /** Unix timestamp when the message was created */
  readonly timestamp: number;

  /** HMAC signature when cluster secret is configured */
  readonly signature?: string;

  /** The actual cluster message */
  readonly payload: ClusterMessage;
}

// =============================================================================
// Event Handlers
// =============================================================================

/**
 * Handler called when a node joins the cluster.
 */
export type NodeUpHandler = (node: NodeInfo) => void;

/**
 * Handler called when a node leaves the cluster.
 */
export type NodeDownHandler = (nodeId: NodeId, reason: NodeDownReason) => void;

/**
 * Handler called when the local node's cluster status changes.
 */
export type ClusterStatusHandler = (status: ClusterStatus) => void;

/**
 * Current status of the local node in the cluster.
 */
export type ClusterStatus = 'starting' | 'running' | 'stopping' | 'stopped';

// =============================================================================
// Default Configuration Values
// =============================================================================

/**
 * Default values for cluster configuration.
 */
export const CLUSTER_DEFAULTS = {
  /** Default host to bind to */
  HOST: '0.0.0.0',

  /** Default port for cluster communication (Erlang EPMD port) */
  PORT: 4369,

  /** Default heartbeat interval in milliseconds */
  HEARTBEAT_INTERVAL_MS: 5000,

  /** Default number of missed heartbeats before marking node as down */
  HEARTBEAT_MISS_THRESHOLD: 3,

  /** Default initial reconnection delay in milliseconds */
  RECONNECT_BASE_DELAY_MS: 1000,

  /** Default maximum reconnection delay in milliseconds */
  RECONNECT_MAX_DELAY_MS: 30000,

  /** Protocol version */
  PROTOCOL_VERSION: 1 as const,
} as const;

// =============================================================================
// Error Types
// =============================================================================

// InvalidNodeIdError is defined in node-id.ts - re-export for convenience
export { InvalidNodeIdError } from './node-id.js';

/**
 * Error thrown when attempting to call a remote GenServer that is not running.
 */
export class RemoteServerNotRunningError extends Error {
  override readonly name = 'RemoteServerNotRunningError' as const;

  constructor(
    readonly serverId: string,
    readonly nodeId: NodeId,
  ) {
    super(`GenServer '${serverId}' is not running on node '${nodeId}'`);
  }
}

/**
 * Error thrown when a remote call times out.
 */
export class RemoteCallTimeoutError extends Error {
  override readonly name = 'RemoteCallTimeoutError' as const;

  constructor(
    readonly serverId: string,
    readonly nodeId: NodeId,
    readonly timeoutMs: number,
  ) {
    super(
      `Remote call to GenServer '${serverId}' on node '${nodeId}' timed out after ${timeoutMs}ms`,
    );
  }
}

/**
 * Error thrown when the target node is not reachable.
 */
export class NodeNotReachableError extends Error {
  override readonly name = 'NodeNotReachableError' as const;

  constructor(readonly nodeId: NodeId) {
    super(`Node '${nodeId}' is not reachable`);
  }
}

/**
 * Error thrown when cluster message serialization fails.
 */
export class MessageSerializationError extends Error {
  override readonly name = 'MessageSerializationError' as const;
  override readonly cause: Error;

  constructor(
    readonly operation: 'serialize' | 'deserialize',
    cause: Error,
  ) {
    super(`Failed to ${operation} cluster message: ${cause.message}`);
    this.cause = cause;
  }
}

/**
 * Error thrown when cluster is not started.
 */
export class ClusterNotStartedError extends Error {
  override readonly name = 'ClusterNotStartedError' as const;

  constructor() {
    super('Cluster has not been started. Call Cluster.start() first.');
  }
}

/**
 * Error thrown when cluster configuration is invalid.
 */
export class InvalidClusterConfigError extends Error {
  override readonly name = 'InvalidClusterConfigError' as const;

  constructor(readonly reason: string) {
    super(`Invalid cluster configuration: ${reason}`);
  }
}

// =============================================================================
// Remote Spawn Errors
// =============================================================================

/**
 * Error thrown when a behavior is not found in the BehaviorRegistry.
 */
export class BehaviorNotFoundError extends Error {
  override readonly name = 'BehaviorNotFoundError' as const;

  constructor(readonly behaviorName: string) {
    super(`Behavior '${behaviorName}' is not registered in BehaviorRegistry`);
  }
}

/**
 * Error thrown when a remote spawn request times out.
 */
export class RemoteSpawnTimeoutError extends Error {
  override readonly name = 'RemoteSpawnTimeoutError' as const;

  constructor(
    readonly behaviorName: string,
    readonly nodeId: NodeId,
    readonly timeoutMs: number,
  ) {
    super(
      `Remote spawn of '${behaviorName}' on node '${nodeId}' timed out after ${timeoutMs}ms`,
    );
  }
}

/**
 * Error thrown when a remote spawn fails during initialization.
 */
export class RemoteSpawnInitError extends Error {
  override readonly name = 'RemoteSpawnInitError' as const;

  constructor(
    readonly behaviorName: string,
    readonly nodeId: NodeId,
    readonly reason: string,
  ) {
    super(
      `Remote spawn of '${behaviorName}' on node '${nodeId}' failed: ${reason}`,
    );
  }
}

/**
 * Error thrown when remote spawn fails due to registration conflict.
 */
export class RemoteSpawnRegistrationError extends Error {
  override readonly name = 'RemoteSpawnRegistrationError' as const;

  constructor(
    readonly behaviorName: string,
    readonly nodeId: NodeId,
    readonly registeredName: string,
  ) {
    super(
      `Remote spawn of '${behaviorName}' on node '${nodeId}' failed: name '${registeredName}' already registered`,
    );
  }
}
