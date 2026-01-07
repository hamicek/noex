/**
 * Distributed registry module.
 *
 * Provides global process registration across the cluster.
 *
 * @module distribution/registry
 */

export {
  GlobalRegistry,
  GlobalNameConflictError,
  GlobalNameNotFoundError,
  type GlobalRegistryEvents,
  type GlobalRegistryStats,
} from './global-registry.js';
