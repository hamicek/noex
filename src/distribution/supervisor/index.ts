/**
 * Distributed Supervisor module for noex.
 *
 * Provides DistributedSupervisor - a supervisor capable of spawning and
 * managing child processes across multiple cluster nodes with automatic
 * failover on node failure.
 *
 * @module distribution/supervisor
 *
 * @example
 * ```typescript
 * import {
 *   DistributedSupervisor,
 *   type DistributedChildSpec,
 * } from 'noex/distribution/supervisor';
 *
 * const spec: DistributedChildSpec = {
 *   id: 'worker-1',
 *   behavior: 'worker',
 *   nodeSelector: 'least_loaded',
 * };
 * ```
 */

// =============================================================================
// Types
// =============================================================================

export type {
  // Node selection
  NodeSelectorType,
  NodeSelectorFn,
  NodeSelector,

  // Child specification
  DistributedChildSpec,
  DistributedChildTemplate,

  // Supervisor configuration
  DistributedAutoShutdown,
  DistributedSupervisorOptions,

  // References
  DistributedSupervisorRef,

  // Child information
  DistributedChildInfo,
  DistributedRunningChild,

  // Statistics
  DistributedSupervisorStats,

  // Events
  DistributedSupervisorEvent,
  DistributedSupervisorEventHandler,
} from './types.js';

// =============================================================================
// Constants
// =============================================================================

export { DISTRIBUTED_SUPERVISOR_DEFAULTS } from './types.js';

// =============================================================================
// Error Classes
// =============================================================================

export {
  NoAvailableNodeError,
  DistributedBehaviorNotFoundError,
  DistributedDuplicateChildError,
  DistributedChildNotFoundError,
  DistributedMaxRestartsExceededError,
  DistributedInvalidSimpleOneForOneError,
  DistributedMissingChildTemplateError,
  DistributedChildClaimError,
  DistributedSupervisorError,
} from './types.js';

// =============================================================================
// Node Selection
// =============================================================================

export { NodeSelectorImpl } from './node-selector.js';

// =============================================================================
// Child Registry
// =============================================================================

export { DistributedChildRegistry } from './child-registry.js';
export type { ChildRegistrationStatus } from './child-registry.js';
