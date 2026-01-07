/**
 * Registry for GenServer behaviors available for remote spawning.
 *
 * Since JavaScript functions cannot be serialized and transmitted over
 * the network, behaviors must be pre-registered on all nodes under
 * a well-known name. Remote spawn requests reference behaviors by name,
 * and the target node looks up the behavior in its local registry.
 *
 * @module distribution/remote/behavior-registry
 *
 * @example
 * ```typescript
 * import { BehaviorRegistry } from 'noex/distribution';
 *
 * // Register a behavior on ALL nodes at startup
 * BehaviorRegistry.register('counter', {
 *   init: () => 0,
 *   handleCall: (msg, state) => msg === 'get' ? [state, state] : [state + 1, state + 1],
 *   handleCast: (msg, state) => state + 1,
 * });
 *
 * // Later, spawn remotely by name
 * const ref = await GenServer.startRemote('counter', { targetNode: 'node2@host:4369' });
 * ```
 */

import type { GenServerBehavior } from '../../core/types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Type-erased behavior for internal storage.
 * Actual types are preserved during register/get via generics.
 */
type AnyBehavior = GenServerBehavior<unknown, unknown, unknown, unknown>;

/**
 * Statistics about the behavior registry.
 */
export interface BehaviorRegistryStats {
  /** Number of registered behaviors */
  readonly count: number;

  /** Names of all registered behaviors */
  readonly names: readonly string[];
}

// =============================================================================
// Internal State
// =============================================================================

/**
 * Internal storage for registered behaviors.
 * Uses a Map for O(1) lookups by name.
 */
const behaviors = new Map<string, AnyBehavior>();

// =============================================================================
// BehaviorRegistry
// =============================================================================

/**
 * Registry for GenServer behaviors available for remote spawning.
 *
 * This is a singleton module that maintains a global registry of behaviors
 * that can be instantiated on remote nodes. Behaviors must be registered
 * on all nodes in the cluster for remote spawn to work.
 *
 * @remarks
 * - Behavior names must be unique within a node
 * - The same behavior name should map to compatible behavior on all nodes
 * - Registration is typically done at application startup
 * - Behaviors cannot be registered while spawns are in progress
 */
export const BehaviorRegistry = {
  /**
   * Registers a behavior under a given name.
   *
   * @typeParam State - Type of the GenServer state
   * @typeParam CallMsg - Type of call messages
   * @typeParam CastMsg - Type of cast messages
   * @typeParam CallReply - Type of call replies
   *
   * @param name - Unique name for the behavior
   * @param behavior - The GenServer behavior implementation
   *
   * @throws {Error} If a behavior with this name is already registered
   *
   * @example
   * ```typescript
   * BehaviorRegistry.register('counter', counterBehavior);
   * BehaviorRegistry.register('cache', cacheBehavior);
   * ```
   */
  register<State, CallMsg, CastMsg, CallReply>(
    name: string,
    behavior: GenServerBehavior<State, CallMsg, CastMsg, CallReply>,
  ): void {
    if (behaviors.has(name)) {
      throw new Error(`Behavior '${name}' is already registered`);
    }

    if (!name || typeof name !== 'string') {
      throw new Error('Behavior name must be a non-empty string');
    }

    if (!behavior || typeof behavior !== 'object') {
      throw new Error('Behavior must be an object');
    }

    if (typeof behavior.init !== 'function') {
      throw new Error('Behavior must have an init function');
    }

    if (typeof behavior.handleCall !== 'function') {
      throw new Error('Behavior must have a handleCall function');
    }

    if (typeof behavior.handleCast !== 'function') {
      throw new Error('Behavior must have a handleCast function');
    }

    behaviors.set(name, behavior as AnyBehavior);
  },

  /**
   * Retrieves a behavior by name.
   *
   * @typeParam State - Expected type of the GenServer state
   * @typeParam CallMsg - Expected type of call messages
   * @typeParam CastMsg - Expected type of cast messages
   * @typeParam CallReply - Expected type of call replies
   *
   * @param name - Name of the behavior to retrieve
   * @returns The behavior if found, undefined otherwise
   *
   * @example
   * ```typescript
   * const behavior = BehaviorRegistry.get<number, 'get' | 'inc', 'inc', number>('counter');
   * if (behavior) {
   *   const ref = await GenServer.start(behavior);
   * }
   * ```
   */
  get<State, CallMsg, CastMsg, CallReply>(
    name: string,
  ): GenServerBehavior<State, CallMsg, CastMsg, CallReply> | undefined {
    return behaviors.get(name) as
      | GenServerBehavior<State, CallMsg, CastMsg, CallReply>
      | undefined;
  },

  /**
   * Checks if a behavior is registered under a given name.
   *
   * @param name - Name to check
   * @returns true if a behavior is registered with this name
   */
  has(name: string): boolean {
    return behaviors.has(name);
  },

  /**
   * Removes a behavior from the registry.
   *
   * @param name - Name of the behavior to remove
   * @returns true if the behavior was found and removed, false otherwise
   *
   * @remarks
   * Use with caution - removing a behavior while remote spawns are in
   * progress or pending can cause spawn failures.
   */
  unregister(name: string): boolean {
    return behaviors.delete(name);
  },

  /**
   * Returns the names of all registered behaviors.
   *
   * @returns Readonly array of behavior names
   */
  getNames(): readonly string[] {
    return Array.from(behaviors.keys());
  },

  /**
   * Returns statistics about the registry.
   *
   * @returns Registry statistics
   */
  getStats(): BehaviorRegistryStats {
    return {
      count: behaviors.size,
      names: Array.from(behaviors.keys()),
    };
  },

  /**
   * Clears all registered behaviors.
   *
   * @internal
   * @remarks
   * This is primarily intended for testing purposes.
   * Use with extreme caution in production code.
   */
  _clear(): void {
    behaviors.clear();
  },
} as const;
