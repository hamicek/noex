/**
 * Registry — global named process lookup, implemented as a facade over RegistryInstance.
 *
 * Provides a global namespace for looking up processes by name.
 * Processes can be registered at start time or dynamically.
 * Registration is automatically cleaned up when processes terminate.
 *
 * The static Registry API delegates to an internal default RegistryInstance
 * (unique mode, no persistence). Use `Registry.create()` to create
 * additional isolated registry instances with custom configuration.
 */

import {
  type GenServerRef,
  NotRegisteredError,
  AlreadyRegisteredError,
} from './types.js';
import { RegistryInstance } from './registry-instance.js';
import type { RegistryOptions } from './registry-types.js';

// =============================================================================
// Default Global Instance
// =============================================================================

let defaultRegistry = new RegistryInstance<unknown>({
  name: '__global__',
  keys: 'unique',
});

let started = false;

/**
 * Lazily starts the default registry instance (sets up lifecycle handler).
 * Called on first register to avoid overhead when Registry is never used.
 */
function ensureStarted(): void {
  if (started) {
    return;
  }
  // start() is async for persistence support, but the lifecycle setup
  // is synchronous. Safe to fire-and-forget for the global instance.
  void defaultRegistry.start();
  started = true;
}

// =============================================================================
// Registry Facade
// =============================================================================

/**
 * Registry provides named process lookup for GenServers and Supervisors.
 *
 * This enables loose coupling between components - services can be looked up
 * by well-known names rather than passing references explicitly.
 *
 * @example
 * ```typescript
 * // Register a server by name
 * const ref = await GenServer.start(behavior);
 * Registry.register('counter', ref);
 *
 * // Look it up elsewhere
 * const counter = Registry.lookup<number, 'get', 'inc', number>('counter');
 * const value = await GenServer.call(counter, 'get');
 *
 * // Automatic cleanup on termination
 * await GenServer.stop(ref);
 * Registry.lookup('counter'); // throws NotRegisteredError
 * ```
 *
 * @example Creating isolated instances
 * ```typescript
 * const services = Registry.create<{ version: string }>({
 *   name: 'services',
 *   keys: 'unique',
 * });
 * await services.start();
 *
 * services.register('auth', authRef, { version: '2.0' });
 * ```
 */
export const Registry = {
  /**
   * Registers a process under a given name.
   *
   * The registration is automatically removed when the process terminates.
   * Each name can only be registered once - attempting to register
   * a name that's already in use throws AlreadyRegisteredError.
   *
   * @param name - The name to register under
   * @param ref - The process reference to register
   * @throws {AlreadyRegisteredError} If the name is already registered
   *
   * @example
   * ```typescript
   * const ref = await GenServer.start(behavior);
   * Registry.register('my-service', ref);
   * ```
   */
  register<
    State = unknown,
    CallMsg = unknown,
    CastMsg = unknown,
    CallReply = unknown,
  >(
    name: string,
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
  ): void {
    ensureStarted();

    if (defaultRegistry.isRegistered(name)) {
      throw new AlreadyRegisteredError(name);
    }

    defaultRegistry.register(name, ref);
  },

  /**
   * Looks up a process by name.
   *
   * Returns a typed reference if the process is registered.
   * Use type parameters to get proper typing for the returned reference.
   *
   * @param name - The name to look up
   * @returns The registered process reference
   * @throws {NotRegisteredError} If no process is registered under the name
   *
   * @example
   * ```typescript
   * // With type parameters for full typing
   * const counter = Registry.lookup<number, 'get', 'inc', number>('counter');
   *
   * // Without type parameters (returns unknown types)
   * const service = Registry.lookup('service');
   * ```
   */
  lookup<
    State = unknown,
    CallMsg = unknown,
    CastMsg = unknown,
    CallReply = unknown,
  >(name: string): GenServerRef<State, CallMsg, CastMsg, CallReply> {
    const entry = defaultRegistry.whereis(name);
    if (entry === undefined) {
      throw new NotRegisteredError(name);
    }
    return entry.ref as GenServerRef<State, CallMsg, CastMsg, CallReply>;
  },

  /**
   * Looks up a process by name, returning undefined if not found.
   *
   * This is the non-throwing variant of lookup(), useful when
   * you want to handle missing registrations gracefully.
   *
   * @param name - The name to look up
   * @returns The registered process reference, or undefined
   *
   * @example
   * ```typescript
   * const counter = Registry.whereis('counter');
   * if (counter) {
   *   await GenServer.call(counter, 'get');
   * }
   * ```
   */
  whereis<
    State = unknown,
    CallMsg = unknown,
    CastMsg = unknown,
    CallReply = unknown,
  >(name: string): GenServerRef<State, CallMsg, CastMsg, CallReply> | undefined {
    const entry = defaultRegistry.whereis(name);
    if (entry === undefined) {
      return undefined;
    }
    return entry.ref as GenServerRef<State, CallMsg, CastMsg, CallReply>;
  },

  /**
   * Unregisters a process by name.
   *
   * This removes the name from the registry. The process itself
   * continues running - only the name mapping is removed.
   *
   * This is idempotent - unregistering a name that's not registered
   * does nothing and does not throw.
   *
   * @param name - The name to unregister
   *
   * @example
   * ```typescript
   * Registry.unregister('old-service');
   * // Name is now available for re-registration
   * ```
   */
  unregister(name: string): void {
    defaultRegistry.unregister(name);
  },

  /**
   * Checks if a name is currently registered.
   *
   * @param name - The name to check
   * @returns true if the name is registered
   *
   * @example
   * ```typescript
   * if (Registry.isRegistered('counter')) {
   *   // Safe to lookup
   * }
   * ```
   */
  isRegistered(name: string): boolean {
    return defaultRegistry.isRegistered(name);
  },

  /**
   * Returns all currently registered names.
   *
   * Useful for debugging and introspection.
   *
   * @returns Array of registered names
   *
   * @example
   * ```typescript
   * console.log('Registered services:', Registry.getNames());
   * ```
   */
  getNames(): readonly string[] {
    return defaultRegistry.getKeys();
  },

  /**
   * Returns the count of registered processes.
   *
   * @returns Number of registered processes
   */
  count(): number {
    return defaultRegistry.count();
  },

  // ===========================================================================
  // Factory
  // ===========================================================================

  /**
   * Creates a new isolated RegistryInstance with custom configuration.
   *
   * Use this to create application-specific registries with:
   * - Unique or duplicate key modes
   * - Custom metadata types
   * - Optional persistence
   *
   * The returned instance must be started with `await instance.start()`
   * before use, and should be closed with `await instance.close()` on shutdown.
   *
   * @typeParam Meta - Type of metadata attached to each entry
   * @param options - Registry configuration
   * @returns A new RegistryInstance
   *
   * @example
   * ```typescript
   * // Unique mode with typed metadata
   * const services = Registry.create<{ version: string }>({
   *   name: 'services',
   *   keys: 'unique',
   * });
   * await services.start();
   * services.register('auth', authRef, { version: '2.0' });
   *
   * // Duplicate mode (pub/sub)
   * const topics = Registry.create({ name: 'topics', keys: 'duplicate' });
   * await topics.start();
   * topics.register('user:created', handlerA);
   * topics.register('user:created', handlerB);
   * topics.dispatch('user:created', payload);
   * ```
   */
  create<Meta = unknown>(options?: RegistryOptions): RegistryInstance<Meta> {
    return new RegistryInstance<Meta>(options);
  },

  // ===========================================================================
  // Internal / Test Helpers
  // ===========================================================================

  /**
   * Clears all registrations.
   *
   * This removes all name mappings but does not stop any processes.
   * Primarily useful for testing.
   *
   * @internal
   */
  _clear(): void {
    if (started) {
      void defaultRegistry.close();
      defaultRegistry = new RegistryInstance<unknown>({
        name: '__global__',
        keys: 'unique',
      });
      started = false;
    }
  },

  /**
   * Clears the lifecycle handler.
   * Must be called before _clear() in test cleanup.
   *
   * @internal
   */
  _clearLifecycleHandler(): void {
    if (started) {
      void defaultRegistry.close();
      defaultRegistry = new RegistryInstance<unknown>({
        name: '__global__',
        keys: 'unique',
      });
      started = false;
    }
  },

  /**
   * Returns the registered name for a given ref ID.
   * Used by Observer for process tree display.
   *
   * @internal
   */
  _getNameById(refId: string): string | undefined {
    return defaultRegistry.getKeyByRefId(refId);
  },

  // ===========================================================================
  // Global Registry Methods (Distributed)
  // ===========================================================================

  /**
   * Registers a process globally across the cluster.
   *
   * The registration is broadcast to all connected nodes. Global names
   * must be unique across the entire cluster. Earlier registrations win
   * in case of conflicts.
   *
   * Requires the cluster to be started via `Cluster.start()`.
   *
   * @param name - Unique global name for the registration
   * @param ref - The process reference to register
   * @throws {GlobalNameConflictError} If name is already registered
   * @throws {ClusterNotStartedError} If cluster is not running
   *
   * @example
   * ```typescript
   * import { GenServer, Registry, Cluster } from 'noex';
   *
   * await Cluster.start({ nodeName: 'app1', port: 4369 });
   * const ref = await GenServer.start(behavior);
   * await Registry.registerGlobal('main-counter', ref);
   * ```
   */
  async registerGlobal<
    State = unknown,
    CallMsg = unknown,
    CastMsg = unknown,
    CallReply = unknown,
  >(
    name: string,
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
  ): Promise<void> {
    const { GlobalRegistry, Cluster } = await import('../distribution/index.js');
    const { GenServer } = await import('./gen-server.js');

    const localNodeId = Cluster.getLocalNodeId();

    await GlobalRegistry.register(name, {
      id: ref.id,
      nodeId: localNodeId,
    });

    // Set up cleanup when process terminates
    const unsubscribe = GenServer.onLifecycleEvent((event) => {
      if (event.type === 'terminated' && event.ref.id === ref.id) {
        GlobalRegistry.unregister(name).catch(() => {
          // Ignore unregister errors during cleanup
        });
        unsubscribe();
      }
    });
  },

  /**
   * Looks up a globally registered process.
   *
   * Returns a reference that can be used with `GenServer.call()` and
   * `GenServer.cast()` even if the process is on a remote node.
   *
   * @param name - The global name to look up
   * @returns The registered process reference
   * @throws {GlobalNameNotFoundError} If name is not registered
   *
   * @example
   * ```typescript
   * const counter = await Registry.globalLookup('main-counter');
   * const value = await GenServer.call(counter, { type: 'get' });
   * ```
   */
  async globalLookup<
    State = unknown,
    CallMsg = unknown,
    CastMsg = unknown,
    CallReply = unknown,
  >(name: string): Promise<GenServerRef<State, CallMsg, CastMsg, CallReply>> {
    const { GlobalRegistry } = await import('../distribution/index.js');

    const serializedRef = GlobalRegistry.lookup(name);

    return {
      id: serializedRef.id,
      nodeId: serializedRef.nodeId,
    } as unknown as GenServerRef<State, CallMsg, CastMsg, CallReply>;
  },

  /**
   * Looks up a globally registered process, returning undefined if not found.
   *
   * This is the non-throwing variant of `globalLookup()`.
   *
   * @param name - The global name to look up
   * @returns The registered process reference, or undefined
   *
   * @example
   * ```typescript
   * const counter = await Registry.whereisGlobal('main-counter');
   * if (counter) {
   *   const value = await GenServer.call(counter, { type: 'get' });
   * }
   * ```
   */
  async whereisGlobal<
    State = unknown,
    CallMsg = unknown,
    CastMsg = unknown,
    CallReply = unknown,
  >(name: string): Promise<GenServerRef<State, CallMsg, CastMsg, CallReply> | undefined> {
    const { GlobalRegistry } = await import('../distribution/index.js');

    const serializedRef = GlobalRegistry.whereis(name);

    if (!serializedRef) {
      return undefined;
    }

    return {
      id: serializedRef.id,
      nodeId: serializedRef.nodeId,
    } as unknown as GenServerRef<State, CallMsg, CastMsg, CallReply>;
  },

  /**
   * Unregisters a globally registered process.
   *
   * Only the owning node can unregister a process.
   *
   * @param name - The global name to unregister
   *
   * @example
   * ```typescript
   * await Registry.unregisterGlobal('old-service');
   * ```
   */
  async unregisterGlobal(name: string): Promise<void> {
    const { GlobalRegistry } = await import('../distribution/index.js');
    await GlobalRegistry.unregister(name);
  },

  /**
   * Checks if a name is globally registered.
   *
   * @param name - The name to check
   * @returns true if the name is globally registered
   */
  async isGloballyRegistered(name: string): Promise<boolean> {
    const { GlobalRegistry } = await import('../distribution/index.js');
    return GlobalRegistry.isRegistered(name);
  },

  /**
   * Returns all globally registered names.
   *
   * @returns Array of globally registered names
   */
  async getGlobalNames(): Promise<readonly string[]> {
    const { GlobalRegistry } = await import('../distribution/index.js');
    return GlobalRegistry.getNames();
  },
} as const;
