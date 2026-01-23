/**
 * noex - Elixir-style GenServer and Supervisor patterns for TypeScript
 *
 * This module provides the public API for the noex library.
 */

export const VERSION = '0.1.0' as const;

// Core types
export type {
  GenServerRef,
  MonitorRef,
  LinkRef,
  TimerRef,
  ExitSignal,
  TerminateReason,
  CallResult,
  StartOptions,
  RemoteStartOptions,
  CallOptions,
  GenServerBehavior,
  ChildRestartStrategy,
  AutoShutdown,
  ChildSpec,
  ChildTemplate,
  SupervisorStrategy,
  RestartIntensity,
  SupervisorOptions,
  SupervisorRef,
  LifecycleEvent,
  LifecycleHandler,
  ServerStatus,
  ChildInfo,
  // Observer types
  GenServerStats,
  SupervisorStats,
  ProcessTreeNode,
  MemoryStats,
  ObserverEvent,
  // Persistence types (re-exported from core/types.ts)
  StateMetadata,
  // Monitoring types (re-exported from distribution/types.ts via core/types.ts)
  MonitorId,
  ProcessDownReason,
} from './core/types.js';

// Error classes
export {
  CallTimeoutError,
  ServerNotRunningError,
  InitializationError,
  MaxRestartsExceededError,
  DuplicateChildError,
  ChildNotFoundError,
  NotRegisteredError,
  AlreadyRegisteredError,
  MissingChildTemplateError,
  InvalidSimpleOneForOneConfigError,
  DEFAULTS,
} from './core/types.js';

// GenServer
export { GenServer } from './core/gen-server.js';

// Supervisor
export { Supervisor } from './core/supervisor.js';

// Registry
export { Registry } from './core/registry.js';

// Services
export { EventBus, type EventBusRef, type EventBusOptions } from './services/event-bus.js';
export {
  Cache,
  _resetAccessCounter,
  type CacheRef,
  type CacheOptions,
  type CacheSetOptions,
  type CacheStats,
} from './services/cache.js';
export {
  RateLimiter,
  RateLimitExceededError,
  type RateLimiterRef,
  type RateLimiterOptions,
  type RateLimitResult,
} from './services/rate-limiter.js';
export {
  TimerService,
  type TimerServiceRef,
  type DurableTimerOptions,
  type TimerEntry,
  type ScheduleOptions,
} from './services/timer-service.js';

// Observer
export { Observer, AlertManager, ClusterObserver } from './observer/index.js';
export type {
  ObserverSnapshot,
  ObserverEventHandler,
  AlertConfig,
  Alert,
  AlertType,
  AlertEvent,
  AlertEventHandler,
  // ClusterObserver types
  NodeObserverStatus,
  NodeObserverSnapshot,
  ClusterAggregatedStats,
  ClusterObserverSnapshot,
  ClusterObserverEvent,
  ClusterObserverEventHandler,
  ClusterSnapshotOptions,
} from './observer/index.js';

// Observer export utilities
export {
  exportToJson,
  exportToCsv,
  createExportData,
  createExportDataWithHistory,
} from './observer/index.js';
export type {
  ExportData,
  MetricsHistory,
  MetricsDataPoint,
  ProcessMetricsHistory,
  CsvExportResult,
} from './observer/index.js';

// Dashboard Server (for remote dashboard connections)
export { DashboardServer } from './dashboard/server/dashboard-server.js';
export type {
  DashboardServerConfig,
  DashboardServerRef,
} from './dashboard/server/dashboard-server.js';

// Dashboard Protocol (for building custom dashboard clients)
export {
  serializeMessage,
  parseMessage,
  ProtocolError,
  PROTOCOL_VERSION,
  LENGTH_PREFIX_SIZE,
  MAX_MESSAGE_SIZE,
} from './dashboard/server/protocol.js';
export type {
  ServerMessage,
  ClientMessage,
  WelcomeMessage,
  SnapshotMessage,
  EventMessage,
  ErrorMessage,
  ClusterSnapshotMessage,
  ClusterStatusMessage,
  GetSnapshotRequest,
  StopProcessRequest,
  PingRequest,
  GetClusterSnapshotRequest,
  GetClusterStatusRequest,
  ParseResult,
  ProtocolErrorCode,
} from './dashboard/server/protocol.js';

// Persistence
export { MemoryAdapter, FileAdapter, SQLiteAdapter } from './persistence/adapters/index.js';
export { MemoryEventLogAdapter, SQLiteEventLogAdapter } from './persistence/adapters/index.js';
export type {
  StorageAdapter,
  PersistenceConfig,
  PersistenceKey,
  PersistedState,
  LoadResult,
  StateSerializer,
  MemoryAdapterOptions,
  FileAdapterOptions,
  SQLiteAdapterOptions,
  EventEntry,
  EventLogAdapter,
  ReadOptions,
  SQLiteEventLogAdapterOptions,
} from './persistence/index.js';
export {
  PersistenceError,
  StateNotFoundError,
  SerializationError,
  DeserializationError,
  CorruptedStateError,
  StaleStateError,
  StorageError,
  MigrationError,
  ChecksumMismatchError,
} from './persistence/index.js';
export { PersistenceManager } from './persistence/index.js';
export type { SaveOptions, ManagerLoadResult, LoadSuccess, LoadFailure } from './persistence/index.js';
export { defaultSerializer, createPrettySerializer } from './persistence/index.js';

// Distribution (Cluster Communication)
export {
  // NodeId utilities
  NodeId,
  isNodeId,
  // Serialization
  Serializer,
  generateCallId,
  isValidCallId,
  generateSpawnId,
  isValidSpawnId,
  generateMonitorId,
  isValidMonitorId,
  generateLinkId,
  isValidLinkId,
  // Transport
  Connection,
  Transport,
  // Cluster
  Cluster,
  Membership,
  // Remote Call/Cast
  RemoteCall,
  CallHandler,
  PendingCalls,
  _resetRemoteCallState,
  // Remote Spawn
  BehaviorRegistry,
  PendingSpawns,
  RemoteSpawn,
  SpawnHandler,
  _resetRemoteSpawnState,
  // Remote Monitor
  RemoteMonitor,
  _resetRemoteMonitorState,
  RemoteMonitorTimeoutError,
  // Remote Link
  RemoteLink,
  _resetRemoteLinkState,
  RemoteLinkTimeoutError,
  // Global Registry
  GlobalRegistry,
  // Distributed Supervisor
  DistributedSupervisor,
  // Error classes
  InvalidNodeIdError,
  RemoteServerNotRunningError,
  RemoteCallTimeoutError,
  NodeNotReachableError,
  MessageSerializationError,
  ClusterNotStartedError,
  InvalidClusterConfigError,
  BehaviorNotFoundError,
  RemoteSpawnTimeoutError,
  RemoteSpawnInitError,
  RemoteSpawnRegistrationError,
  // Constants
  CLUSTER_DEFAULTS,
} from './distribution/index.js';
export type {
  // Node identification
  NodeIdType,
  NodeIdComponents,
  NodeStatus,
  NodeInfo,
  // Configuration
  ClusterConfig,
  // Messages
  CallId,
  SpawnId,
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
  // Process linking messages
  LinkId,
  LinkRequestMessage,
  LinkAckMessage,
  UnlinkRequestMessage,
  ExitSignalMessage,
  // Remote spawn messages
  SpawnRequestMessage,
  SpawnReplyMessage,
  SpawnErrorMessage,
  SpawnRequestOptions,
  SpawnErrorType,
  // Wire protocol
  MessageEnvelope,
  SerializedRef,
  RegistrySyncEntry,
  // Event handlers
  NodeUpHandler,
  NodeDownHandler,
  ClusterStatusHandler,
  ClusterStatus,
  // Serialization options
  SerializeOptions,
  DeserializeOptions,
  // Transport types
  ConnectionState,
  ConnectionConfig,
  ConnectionEvents,
  ConnectionStats,
  TransportState,
  TransportConfig,
  TransportEvents,
  TransportStats,
  // Cluster types
  ClusterEvents,
  MembershipConfig,
  MembershipEvents,
  // Remote call types
  RemoteCallOptions,
  RemoteCallStats,
  PendingCallsStats,
  // Remote spawn types
  BehaviorRegistryStats,
  PendingSpawnsStats,
  SpawnResult,
  RemoteSpawnOptions,
  RemoteSpawnStats,
  // Remote monitor types
  RemoteMonitorOptions,
  RemoteMonitorStats,
  // Remote link types
  RemoteLinkOptions,
  RemoteLinkStats,
  // Global registry types
  GlobalRegistryEvents,
  GlobalRegistryStats,
  // Distributed Supervisor types
  DistributedSupervisorRef,
  DistributedSupervisorOptions,
  DistributedSupervisorStats,
  DistributedSupervisorEvent,
  DistributedSupervisorEventHandler,
  DistributedChildSpec,
  DistributedChildInfo,
} from './distribution/index.js';
