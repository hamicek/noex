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
  ChildSpec,
  SupervisorStrategy,
  RestartIntensity,
  SupervisorOptions,
  SupervisorRef,
  LifecycleEvent,
  LifecycleHandler,
  ServerStatus,
  ChildInfo,
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
  DEFAULTS,
} from './core/types.js';

// GenServer
export { GenServer } from './core/gen-server.js';

// Supervisor
export { Supervisor } from './core/supervisor.js';
