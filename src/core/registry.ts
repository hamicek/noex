/**
 * Registry for named GenServer and Supervisor references.
 *
 * Provides a global namespace for looking up processes by name.
 * Processes can be registered at start time or dynamically.
 * Registration is automatically cleaned up when processes terminate.
 */

import {
  type GenServerRef,
  type SupervisorRef,
  NotRegisteredError,
  AlreadyRegisteredError,
} from './types.js';
import { GenServer } from './gen-server.js';

/**
 * Union type for references that can be registered.
 */
type RegisterableRef = GenServerRef | SupervisorRef;

/**
 * Entry in the registry storing the reference and cleanup function.
 */
interface RegistryEntry {
  readonly ref: RegisterableRef;
  readonly unsubscribe: () => void;
}

/**
 * Internal storage for named references.
 * Maps process names to their entries.
 */
const registryMap = new Map<string, RegistryEntry>();

/**
 * Reverse lookup: ref ID to name for efficient cleanup.
 */
const refIdToName = new Map<string, string>();

/**
 * Lifecycle handler for automatic unregistration.
 * This is registered once when the first process is registered.
 */
let lifecycleUnsubscribe: (() => void) | null = null;

/**
 * Ensures lifecycle handler is registered.
 */
function ensureLifecycleHandler(): void {
  if (lifecycleUnsubscribe !== null) {
    return;
  }

  lifecycleUnsubscribe = GenServer.onLifecycleEvent((event) => {
    if (event.type === 'terminated') {
      const name = refIdToName.get(event.ref.id);
      if (name !== undefined) {
        // Clean up without calling unsubscribe (we're already in the handler)
        registryMap.delete(name);
        refIdToName.delete(event.ref.id);
      }
    }
  });
}

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
    if (registryMap.has(name)) {
      throw new AlreadyRegisteredError(name);
    }

    ensureLifecycleHandler();

    // Store the mapping
    const entry: RegistryEntry = {
      ref,
      unsubscribe: () => {}, // Cleanup handled by global lifecycle handler
    };

    registryMap.set(name, entry);
    refIdToName.set(ref.id, name);
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
    const entry = registryMap.get(name);
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
    const entry = registryMap.get(name);
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
    const entry = registryMap.get(name);
    if (entry === undefined) {
      return;
    }

    refIdToName.delete(entry.ref.id);
    registryMap.delete(name);
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
    return registryMap.has(name);
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
    return Array.from(registryMap.keys());
  },

  /**
   * Returns the count of registered processes.
   *
   * @returns Number of registered processes
   */
  count(): number {
    return registryMap.size;
  },

  /**
   * Clears all registrations.
   *
   * This removes all name mappings but does not stop any processes.
   * Primarily useful for testing.
   *
   * @internal
   */
  _clear(): void {
    registryMap.clear();
    refIdToName.clear();
  },

  /**
   * Clears the lifecycle handler.
   * Must be called before _clear() in test cleanup.
   *
   * @internal
   */
  _clearLifecycleHandler(): void {
    if (lifecycleUnsubscribe !== null) {
      lifecycleUnsubscribe();
      lifecycleUnsubscribe = null;
    }
  },

  /**
   * Returns the registered name for a given ref ID.
   * Used by Observer for process tree display.
   *
   * @internal
   */
  _getNameById(refId: string): string | undefined {
    return refIdToName.get(refId);
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
    // Dynamic import to avoid circular dependencies
    const { GlobalRegistry, Cluster } = await import('../distribution/index.js');

    const localNodeId = Cluster.getLocalNodeId();

    await GlobalRegistry.register(name, {
      id: ref.id,
      nodeId: localNodeId,
    });

    // Also register locally for automatic cleanup on termination
    ensureLifecycleHandler();

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

    // Convert SerializedRef back to GenServerRef
    // We create a minimal ref that can be used for remote calls
    // The brand is only for compile-time checking, so we can safely cast
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
