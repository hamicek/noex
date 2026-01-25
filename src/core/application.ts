/**
 * Application behavior for noex.
 *
 * Provides standardized lifecycle management for noex applications, including:
 * - Automatic signal handling (SIGINT/SIGTERM)
 * - Graceful shutdown with timeout
 * - Type-safe configuration and state
 * - Lifecycle event notifications
 */

import type { SupervisorRef } from './types.js';
import { Supervisor } from './supervisor.js';
import {
  type ApplicationBehavior,
  type ApplicationStartOptions,
  type ApplicationRef,
  type ApplicationStatus,
  type ApplicationLifecycleEvent,
  type ApplicationLifecycleHandler,
  type ApplicationStopReason,
  ApplicationStartError,
  ApplicationAlreadyRunningError,
  ApplicationStopTimeoutError,
  ApplicationNotRunningError,
  APPLICATION_DEFAULTS,
} from './application-types.js';

/**
 * Internal state for a running application.
 */
interface ApplicationInstance<Config, State> {
  readonly id: string;
  readonly name: string;
  readonly behavior: ApplicationBehavior<Config, State>;
  readonly config: Config;
  state: State;
  status: ApplicationStatus;
  readonly startTimeout: number;
  readonly stopTimeout: number;
  readonly handleSignals: boolean;
  signalHandler?: (signal: NodeJS.Signals) => void;
  readonly startedAt: number;
}

/**
 * Registry of running application instances.
 */
const applicationRegistry = new Map<string, ApplicationInstance<unknown, unknown>>();

/**
 * Registry mapping application names to their IDs for lookup.
 */
const applicationNameIndex = new Map<string, string>();

/**
 * Lifecycle event handlers.
 */
const lifecycleHandlers = new Set<ApplicationLifecycleHandler>();

/**
 * Counter for generating unique application IDs.
 */
let applicationIdCounter = 0;

/**
 * Generates a unique application ID.
 */
function generateApplicationId(): string {
  return `application_${++applicationIdCounter}_${Date.now().toString(36)}`;
}

/**
 * Creates an ApplicationRef from an ID and name.
 */
function createApplicationRef<Config, State>(
  id: string,
  name: string,
): ApplicationRef<Config, State> {
  return { id, name } as ApplicationRef<Config, State>;
}

/**
 * Emits a lifecycle event to all registered handlers.
 */
function emitLifecycleEvent(event: ApplicationLifecycleEvent): void {
  for (const handler of lifecycleHandlers) {
    try {
      handler(event);
    } catch {
      // Lifecycle handlers should not throw, but if they do, ignore it
    }
  }
}

/**
 * Gets an application instance by ref.
 */
function getApplicationInstance<Config, State>(
  ref: ApplicationRef<Config, State>,
): ApplicationInstance<Config, State> | undefined {
  return applicationRegistry.get(ref.id) as ApplicationInstance<Config, State> | undefined;
}

/**
 * Creates a promise that rejects after a timeout.
 */
function createTimeoutPromise(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

/**
 * Application provides lifecycle management for noex applications.
 *
 * It implements a standardized pattern for:
 * - Starting applications with configuration
 * - Graceful shutdown with signal handling
 * - Lifecycle event notifications
 *
 * @example
 * ```typescript
 * const MyApp = Application.create<Config, SupervisorRef>({
 *   async start(config) {
 *     return Supervisor.start({
 *       strategy: 'one_for_one',
 *       children: [
 *         { id: 'worker', start: () => Worker.start(config) },
 *       ],
 *     });
 *   },
 *   stop(state) {
 *     console.log('Application stopped');
 *   },
 * });
 *
 * const app = await Application.start(MyApp, {
 *   name: 'my-app',
 *   config: { port: 3000 },
 * });
 *
 * // Later:
 * await Application.stop(app);
 * ```
 */
export const Application = {
  /**
   * Creates a typed ApplicationBehavior.
   *
   * This is a convenience function that provides type inference
   * for the behavior definition.
   *
   * @typeParam Config - Configuration type for the application
   * @typeParam State - State type returned from start callback
   * @param behavior - The application behavior definition
   * @returns The same behavior with proper typing
   */
  create<Config = void, State = SupervisorRef>(
    behavior: ApplicationBehavior<Config, State>,
  ): ApplicationBehavior<Config, State> {
    return behavior;
  },

  /**
   * Starts an application with the given behavior and options.
   *
   * @typeParam Config - Configuration type for the application
   * @typeParam State - State type returned from start callback
   * @param behavior - The application behavior
   * @param options - Start options including name and config
   * @returns A reference to the started application
   * @throws {ApplicationAlreadyRunningError} If an application with the same name is already running
   * @throws {ApplicationStartError} If the start callback fails or times out
   */
  async start<Config, State>(
    behavior: ApplicationBehavior<Config, State>,
    options: ApplicationStartOptions<Config>,
  ): Promise<ApplicationRef<Config, State>> {
    const { name, config } = options;
    const handleSignals = options.handleSignals ?? APPLICATION_DEFAULTS.HANDLE_SIGNALS;
    const startTimeout = options.startTimeout ?? APPLICATION_DEFAULTS.START_TIMEOUT;
    const stopTimeout = options.stopTimeout ?? APPLICATION_DEFAULTS.STOP_TIMEOUT;

    // Check if application with this name already exists
    if (applicationNameIndex.has(name)) {
      throw new ApplicationAlreadyRunningError(name);
    }

    const id = generateApplicationId();
    const ref = createApplicationRef<Config, State>(id, name);

    // Emit starting event
    emitLifecycleEvent({
      type: 'starting',
      name,
      timestamp: Date.now(),
    });

    // Create instance placeholder
    const instance: ApplicationInstance<Config, State> = {
      id,
      name,
      behavior,
      config,
      state: undefined as State,
      status: 'starting',
      startTimeout,
      stopTimeout,
      handleSignals,
      startedAt: Date.now(),
    };

    // Register early to prevent duplicate starts
    applicationRegistry.set(id, instance as ApplicationInstance<unknown, unknown>);
    applicationNameIndex.set(name, id);

    try {
      // Start with timeout
      const state = await Promise.race([
        Promise.resolve(behavior.start(config)),
        createTimeoutPromise(startTimeout, `Start timed out after ${startTimeout}ms`),
      ]);

      instance.state = state;
      instance.status = 'running';

      // Setup signal handlers if requested
      if (handleSignals) {
        const signalHandler = (signal: NodeJS.Signals): void => {
          void Application.stop(ref, 'signal');
        };

        instance.signalHandler = signalHandler;
        process.on('SIGINT', signalHandler);
        process.on('SIGTERM', signalHandler);
      }

      // Emit started event
      emitLifecycleEvent({
        type: 'started',
        ref,
        timestamp: Date.now(),
      });

      return ref;
    } catch (error) {
      // Cleanup on failure
      applicationRegistry.delete(id);
      applicationNameIndex.delete(name);

      const err = error instanceof Error ? error : new Error(String(error));

      // Emit start_failed event
      emitLifecycleEvent({
        type: 'start_failed',
        name,
        error: err,
        timestamp: Date.now(),
      });

      throw new ApplicationStartError(name, err.message, err);
    }
  },

  /**
   * Stops a running application.
   *
   * The stop sequence is:
   * 1. Call prepStop callback (if defined)
   * 2. Stop the supervisor tree (if state is a SupervisorRef)
   * 3. Call stop callback (if defined)
   * 4. Cleanup signal handlers
   *
   * @param ref - Reference to the application to stop
   * @param reason - Reason for stopping
   * @throws {ApplicationNotRunningError} If the application is not running
   * @throws {ApplicationStopTimeoutError} If the stop sequence times out
   */
  async stop<Config, State>(
    ref: ApplicationRef<Config, State>,
    reason: ApplicationStopReason = 'normal',
  ): Promise<void> {
    const instance = getApplicationInstance(ref);

    if (!instance || instance.status === 'stopped' || instance.status === 'stopping') {
      throw new ApplicationNotRunningError(ref.name);
    }

    instance.status = 'stopping';

    // Emit stopping event
    emitLifecycleEvent({
      type: 'stopping',
      ref,
      reason,
      timestamp: Date.now(),
    });

    const stopSequence = async (): Promise<void> => {
      // 1. Call prepStop if defined
      if (instance.behavior.prepStop) {
        await Promise.resolve(instance.behavior.prepStop(instance.state as State));
      }

      // 2. Stop supervisor if state looks like a SupervisorRef
      const state = instance.state as unknown;
      if (
        state !== null &&
        typeof state === 'object' &&
        'id' in state &&
        typeof (state as { id: unknown }).id === 'string'
      ) {
        // Check if it's a running supervisor
        const supervisorRef = state as SupervisorRef;
        if (Supervisor.isRunning(supervisorRef)) {
          await Supervisor.stop(supervisorRef, 'shutdown');
        }
      }

      // 3. Call stop callback if defined
      if (instance.behavior.stop) {
        await Promise.resolve(instance.behavior.stop(instance.state as State));
      }
    };

    try {
      await Promise.race([
        stopSequence(),
        createTimeoutPromise(
          instance.stopTimeout,
          `Stop timed out after ${instance.stopTimeout}ms`,
        ),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('timed out')) {
        throw new ApplicationStopTimeoutError(ref.name, instance.stopTimeout);
      }
      throw error;
    } finally {
      // Cleanup signal handlers
      if (instance.signalHandler) {
        process.removeListener('SIGINT', instance.signalHandler);
        process.removeListener('SIGTERM', instance.signalHandler);
      }

      // Remove from registries
      applicationRegistry.delete(instance.id);
      applicationNameIndex.delete(instance.name);

      instance.status = 'stopped';

      // Emit stopped event
      emitLifecycleEvent({
        type: 'stopped',
        name: ref.name,
        reason,
        timestamp: Date.now(),
      });
    }
  },

  /**
   * Returns the current status of an application.
   *
   * @param ref - Reference to the application
   * @returns Current status or 'stopped' if not found
   */
  getStatus<Config, State>(ref: ApplicationRef<Config, State>): ApplicationStatus {
    const instance = getApplicationInstance(ref);
    return instance?.status ?? 'stopped';
  },

  /**
   * Returns the supervisor reference if the application state is a SupervisorRef.
   *
   * @param ref - Reference to the application
   * @returns The supervisor reference or undefined
   */
  getSupervisor<Config, State>(ref: ApplicationRef<Config, State>): SupervisorRef | undefined {
    const instance = getApplicationInstance(ref);
    if (!instance || instance.status !== 'running') {
      return undefined;
    }

    const state = instance.state as unknown;
    if (
      state !== null &&
      typeof state === 'object' &&
      'id' in state &&
      typeof (state as { id: unknown }).id === 'string'
    ) {
      return state as SupervisorRef;
    }

    return undefined;
  },

  /**
   * Returns the current state of an application.
   *
   * @param ref - Reference to the application
   * @returns The application state or undefined if not running
   */
  getState<Config, State>(ref: ApplicationRef<Config, State>): State | undefined {
    const instance = getApplicationInstance(ref);
    if (!instance || instance.status !== 'running') {
      return undefined;
    }
    return instance.state as State;
  },

  /**
   * Checks if an application is currently running.
   *
   * @param ref - Reference to the application
   * @returns true if the application is running
   */
  isRunning<Config, State>(ref: ApplicationRef<Config, State>): boolean {
    const instance = getApplicationInstance(ref);
    return instance?.status === 'running';
  },

  /**
   * Returns all currently running applications.
   *
   * @returns Array of application references
   */
  getAllRunning(): readonly ApplicationRef[] {
    const result: ApplicationRef[] = [];
    for (const instance of applicationRegistry.values()) {
      if (instance.status === 'running') {
        result.push(createApplicationRef(instance.id, instance.name));
      }
    }
    return result;
  },

  /**
   * Looks up an application by name.
   *
   * @param name - The application name
   * @returns The application reference or undefined if not found
   */
  lookup(name: string): ApplicationRef | undefined {
    const id = applicationNameIndex.get(name);
    if (!id) {
      return undefined;
    }

    const instance = applicationRegistry.get(id);
    if (!instance) {
      return undefined;
    }

    return createApplicationRef(instance.id, instance.name);
  },

  /**
   * Registers a lifecycle event handler.
   *
   * @param handler - The handler function
   * @returns A function to unregister the handler
   */
  onLifecycleEvent(handler: ApplicationLifecycleHandler): () => void {
    lifecycleHandlers.add(handler);
    return () => {
      lifecycleHandlers.delete(handler);
    };
  },

  /**
   * Stops all running applications.
   *
   * Applications are stopped in reverse order of startup (LIFO).
   *
   * @param reason - Reason for stopping
   */
  async stopAll(reason: ApplicationStopReason = 'normal'): Promise<void> {
    const apps = Array.from(applicationRegistry.values())
      .filter((instance) => instance.status === 'running')
      .sort((a, b) => b.startedAt - a.startedAt); // LIFO order

    for (const instance of apps) {
      const ref = createApplicationRef(instance.id, instance.name);
      try {
        await Application.stop(ref, reason);
      } catch {
        // Continue stopping other applications even if one fails
      }
    }
  },

  /**
   * Returns information about a running application.
   *
   * @param ref - Reference to the application
   * @returns Application info or undefined if not found
   */
  getInfo<Config, State>(
    ref: ApplicationRef<Config, State>,
  ): { name: string; status: ApplicationStatus; startedAt: number; uptimeMs: number } | undefined {
    const instance = getApplicationInstance(ref);
    if (!instance) {
      return undefined;
    }

    return {
      name: instance.name,
      status: instance.status,
      startedAt: instance.startedAt,
      uptimeMs: Date.now() - instance.startedAt,
    };
  },

  /**
   * Clears all lifecycle handlers.
   * Useful for testing.
   *
   * @internal
   */
  _clearLifecycleHandlers(): void {
    lifecycleHandlers.clear();
  },

  /**
   * Resets the application ID counter.
   * Useful for testing.
   *
   * @internal
   */
  _resetIdCounter(): void {
    applicationIdCounter = 0;
  },

  /**
   * Clears all applications without stopping them.
   * Useful for testing cleanup.
   *
   * @internal
   */
  _clearAll(): void {
    applicationRegistry.clear();
    applicationNameIndex.clear();
  },
} as const;
