/**
 * Type definitions for Application behavior.
 *
 * Application provides standardized lifecycle management for noex applications,
 * including automatic signal handling, graceful shutdown, and type-safe configuration.
 */

import type { SupervisorRef } from './types.js';

/**
 * Opaque branded type for Application references.
 * Prevents accidental mixing with other reference types.
 */
declare const ApplicationRefBrand: unique symbol;

/**
 * Current status of an Application instance.
 *
 * - 'stopped': Application is not running
 * - 'starting': Application is initializing (start callback in progress)
 * - 'running': Application is fully operational
 * - 'stopping': Application is shutting down (stop sequence in progress)
 */
export type ApplicationStatus = 'stopped' | 'starting' | 'running' | 'stopping';

/**
 * A reference to a running Application instance.
 * This is the primary handle used to interact with an Application.
 *
 * @typeParam Config - Configuration type passed to the application
 * @typeParam State - State type returned from the start callback
 */
export interface ApplicationRef<Config = unknown, State = unknown> {
  readonly [ApplicationRefBrand]: 'ApplicationRef';
  readonly id: string;
  readonly name: string;
  readonly _phantom?: {
    readonly config: Config;
    readonly state: State;
  };
}

/**
 * The behavior interface that Application implementations must satisfy.
 * Defines the lifecycle callbacks for application management.
 *
 * @typeParam Config - Configuration type for the application
 * @typeParam State - State type (typically a SupervisorRef or custom state)
 */
export interface ApplicationBehavior<Config = void, State = SupervisorRef> {
  /**
   * Start the application.
   * This is called when Application.start() is invoked.
   *
   * Typically used to start the application's top-level supervisor
   * and any initial child processes.
   *
   * @param config - Application configuration
   * @returns The application state (often a SupervisorRef) or Promise thereof
   * @throws If start fails, the application will not be started
   */
  start(config: Config): State | Promise<State>;

  /**
   * Prepare for shutdown.
   * Called before the main stop sequence begins.
   *
   * Use this for any pre-shutdown tasks like notifying external services,
   * stopping accepting new requests, or draining queues.
   *
   * @param state - Current application state
   */
  prepStop?(state: State): void | Promise<void>;

  /**
   * Final cleanup after shutdown.
   * Called after the supervisor tree has been stopped.
   *
   * Use this for final cleanup like closing database connections,
   * flushing logs, or releasing external resources.
   *
   * @param state - Final application state
   */
  stop?(state: State): void | Promise<void>;
}

/**
 * Options for Application.start()
 *
 * @typeParam Config - Configuration type for the application
 */
export interface ApplicationStartOptions<Config = void> {
  /**
   * Unique name for this application instance.
   * Used for lookup and identification in logs.
   */
  readonly name: string;

  /**
   * Configuration passed to the application's start callback.
   * Type must match the ApplicationBehavior's Config type parameter.
   */
  readonly config: Config;

  /**
   * Whether to automatically handle SIGINT and SIGTERM signals.
   * When true, these signals trigger graceful application shutdown.
   *
   * @default true
   */
  readonly handleSignals?: boolean;

  /**
   * Timeout in milliseconds for the start callback to complete.
   * If exceeded, ApplicationStartError is thrown.
   *
   * @default 30000
   */
  readonly startTimeout?: number;

  /**
   * Timeout in milliseconds for the entire stop sequence.
   * Includes prepStop, supervisor shutdown, and stop callback.
   *
   * @default 30000
   */
  readonly stopTimeout?: number;
}

/**
 * Lifecycle events emitted by Applications.
 * Used for monitoring and debugging application state changes.
 */
export type ApplicationLifecycleEvent =
  | {
      readonly type: 'starting';
      readonly name: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'started';
      readonly ref: ApplicationRef;
      readonly timestamp: number;
    }
  | {
      readonly type: 'stopping';
      readonly ref: ApplicationRef;
      readonly reason: ApplicationStopReason;
      readonly timestamp: number;
    }
  | {
      readonly type: 'stopped';
      readonly name: string;
      readonly reason: ApplicationStopReason;
      readonly timestamp: number;
    }
  | {
      readonly type: 'start_failed';
      readonly name: string;
      readonly error: Error;
      readonly timestamp: number;
    };

/**
 * Handler for application lifecycle events.
 */
export type ApplicationLifecycleHandler = (event: ApplicationLifecycleEvent) => void;

/**
 * Reason for application shutdown.
 *
 * - 'normal': Graceful shutdown via Application.stop()
 * - 'signal': Shutdown triggered by SIGINT or SIGTERM
 * - { error: Error }: Shutdown due to unhandled error
 */
export type ApplicationStopReason = 'normal' | 'signal' | { readonly error: Error };

/**
 * Error thrown when application start fails.
 */
export class ApplicationStartError extends Error {
  override readonly name = 'ApplicationStartError' as const;
  override readonly cause: Error | undefined;

  constructor(
    readonly applicationName: string,
    message: string,
    cause?: Error,
  ) {
    super(`Application '${applicationName}' failed to start: ${message}`);
    this.cause = cause;
  }
}

/**
 * Error thrown when attempting to start an already running application.
 */
export class ApplicationAlreadyRunningError extends Error {
  override readonly name = 'ApplicationAlreadyRunningError' as const;

  constructor(readonly applicationName: string) {
    super(`Application '${applicationName}' is already running`);
  }
}

/**
 * Error thrown when application stop times out.
 */
export class ApplicationStopTimeoutError extends Error {
  override readonly name = 'ApplicationStopTimeoutError' as const;

  constructor(
    readonly applicationName: string,
    readonly timeoutMs: number,
  ) {
    super(`Application '${applicationName}' stop timed out after ${timeoutMs}ms`);
  }
}

/**
 * Error thrown when attempting to stop an application that is not running.
 */
export class ApplicationNotRunningError extends Error {
  override readonly name = 'ApplicationNotRunningError' as const;

  constructor(readonly applicationName: string) {
    super(`Application '${applicationName}' is not running`);
  }
}

/**
 * Default values for Application options.
 */
export const APPLICATION_DEFAULTS = {
  /** Default timeout for start callback */
  START_TIMEOUT: 30000,
  /** Default timeout for stop sequence */
  STOP_TIMEOUT: 30000,
  /** Whether to handle signals by default */
  HANDLE_SIGNALS: true,
} as const;
