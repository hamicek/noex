/**
 * noex - Elixir-style GenServer and Supervisor patterns for TypeScript
 *
 * This module provides the public API for the noex library.
 */

export const VERSION = '0.1.0' as const;

// Core types
export type {
  GenServerRef,
  TerminateReason,
  CallResult,
  StartOptions,
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
  ObserverEvent,
  // Persistence types (re-exported from core/types.ts)
  StateMetadata,
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

// Observer
export { Observer, AlertManager } from './observer/index.js';
export type {
  ObserverSnapshot,
  ObserverEventHandler,
  AlertConfig,
  Alert,
  AlertType,
  AlertEvent,
  AlertEventHandler,
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

// Persistence
export { MemoryAdapter, FileAdapter } from './persistence/adapters/index.js';
export type {
  StorageAdapter,
  PersistenceConfig,
  PersistenceKey,
  PersistedState,
  LoadResult,
  StateSerializer,
  MemoryAdapterOptions,
  FileAdapterOptions,
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
