/**
 * Distributed child registry for coordinating child ownership across the cluster.
 *
 * Provides cluster-wide coordination for distributed supervisor children using
 * GlobalRegistry. Key responsibilities:
 *
 * - Unique child registration with format `dsup:{supervisorId}:{childId}`
 * - Atomic child claiming for restart coordination (prevents split-brain)
 * - Automatic cleanup on unregistration
 *
 * @module distribution/supervisor/child-registry
 */

import type { NodeId } from '../node-id.js';
import type { SerializedRef } from '../types.js';
import type { GenServerRef } from '../../core/types.js';
import { GlobalRegistry, GlobalNameConflictError } from '../registry/global-registry.js';
import { DistributedChildClaimError } from './types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Result of checking if a child is registered.
 */
export interface ChildRegistrationStatus {
  /** Whether the child is currently registered */
  readonly exists: boolean;

  /** Node where the child is running (if registered) */
  readonly nodeId?: NodeId;

  /** Serialized reference to the child process (if registered) */
  readonly ref?: SerializedRef;

  /** Supervisor that owns this child (if registered) */
  readonly supervisorId?: string;
}

/**
 * Metadata stored with child registration.
 *
 * Encoded in the SerializedRef's id field as JSON to preserve
 * additional information needed for distributed coordination.
 */
interface ChildRegistrationMetadata {
  /** Original GenServer id */
  readonly serverId: string;

  /** Supervisor that owns this child */
  readonly supervisorId: string;

  /** Child identifier within the supervisor */
  readonly childId: string;

  /** Timestamp when the registration was created */
  readonly registeredAt: number;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Prefix for distributed supervisor child registrations.
 */
const REGISTRY_PREFIX = 'dsup' as const;

/**
 * Separator used in registry key construction.
 */
const KEY_SEPARATOR = ':' as const;

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Constructs the global registry key for a distributed child.
 *
 * Format: `dsup:{supervisorId}:{childId}`
 *
 * **Important**: The colon (`:`) is used as a separator. For correct parsing,
 * `supervisorId` should not contain colons. `childId` may contain colons
 * as they are joined back during parsing.
 *
 * @param supervisorId - Unique identifier of the supervisor (should not contain `:`)
 * @param childId - Unique identifier of the child within the supervisor
 * @returns The global registry key
 */
function buildRegistryKey(supervisorId: string, childId: string): string {
  return `${REGISTRY_PREFIX}${KEY_SEPARATOR}${supervisorId}${KEY_SEPARATOR}${childId}`;
}

/**
 * Parses a registry key back into supervisor and child identifiers.
 *
 * @param key - The registry key to parse
 * @returns Parsed components or null if invalid format
 */
function parseRegistryKey(
  key: string,
): { supervisorId: string; childId: string } | null {
  const parts = key.split(KEY_SEPARATOR);

  if (parts.length < 3 || parts[0] !== REGISTRY_PREFIX) {
    return null;
  }

  // Handle childIds that might contain the separator
  const supervisorId = parts[1]!;
  const childId = parts.slice(2).join(KEY_SEPARATOR);

  return { supervisorId, childId };
}

/**
 * Encodes child metadata into a serialized format.
 *
 * @param serverId - The GenServer's unique identifier
 * @param supervisorId - The owning supervisor's identifier
 * @param childId - The child's identifier within the supervisor
 * @returns Encoded metadata string
 */
function encodeMetadata(
  serverId: string,
  supervisorId: string,
  childId: string,
): string {
  const metadata: ChildRegistrationMetadata = {
    serverId,
    supervisorId,
    childId,
    registeredAt: Date.now(),
  };
  return JSON.stringify(metadata);
}

/**
 * Decodes child metadata from a serialized format.
 *
 * @param encoded - The encoded metadata string
 * @returns Decoded metadata or null if invalid
 */
function decodeMetadata(encoded: string): ChildRegistrationMetadata | null {
  try {
    const parsed = JSON.parse(encoded) as unknown;

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as ChildRegistrationMetadata).serverId !== 'string' ||
      typeof (parsed as ChildRegistrationMetadata).supervisorId !== 'string' ||
      typeof (parsed as ChildRegistrationMetadata).childId !== 'string'
    ) {
      return null;
    }

    return parsed as ChildRegistrationMetadata;
  } catch {
    return null;
  }
}

// =============================================================================
// DistributedChildRegistry
// =============================================================================

/**
 * Registry for coordinating distributed supervisor children across the cluster.
 *
 * Uses GlobalRegistry as the underlying storage, providing:
 *
 * - **Unique registration**: Each child can only be registered once cluster-wide
 * - **Atomic claiming**: Prevents multiple supervisors from restarting the same child
 * - **Transparent lookup**: Find children regardless of which node they're on
 *
 * @example
 * ```typescript
 * // Register a child
 * await DistributedChildRegistry.registerChild(
 *   'sup-1',
 *   'worker-1',
 *   workerRef,
 *   Cluster.getLocalNodeId(),
 * );
 *
 * // Check registration status
 * const status = DistributedChildRegistry.isChildRegistered('sup-1', 'worker-1');
 * if (status.exists) {
 *   console.log(`Worker running on ${status.nodeId}`);
 * }
 *
 * // Claim child for restart (atomic)
 * const claimed = await DistributedChildRegistry.tryClaimChild('sup-1', 'worker-1');
 * if (claimed) {
 *   // Safe to restart - we own the claim
 * }
 * ```
 */
export const DistributedChildRegistry = {
  /**
   * Registers a child in the distributed registry.
   *
   * Creates a global registration for the child, making it discoverable
   * cluster-wide and preventing duplicate registrations.
   *
   * @param supervisorId - Unique identifier of the owning supervisor
   * @param childId - Unique identifier of the child within the supervisor
   * @param ref - Reference to the running GenServer
   * @param nodeId - Node where the child is running
   * @throws {GlobalNameConflictError} If the child is already registered
   *
   * @example
   * ```typescript
   * await DistributedChildRegistry.registerChild(
   *   'distributed-sup-1',
   *   'cache-worker',
   *   cacheRef,
   *   Cluster.getLocalNodeId(),
   * );
   * ```
   */
  async registerChild(
    supervisorId: string,
    childId: string,
    ref: GenServerRef,
    nodeId: NodeId,
  ): Promise<void> {
    const key = buildRegistryKey(supervisorId, childId);
    const encodedId = encodeMetadata(ref.id, supervisorId, childId);

    const serializedRef: SerializedRef = {
      id: encodedId,
      nodeId,
    };

    await GlobalRegistry.register(key, serializedRef);
  },

  /**
   * Unregisters a child from the distributed registry.
   *
   * Removes the global registration, allowing the child ID to be reused.
   * This should be called when a child is permanently terminated.
   *
   * @param supervisorId - Unique identifier of the owning supervisor
   * @param childId - Unique identifier of the child to unregister
   *
   * @example
   * ```typescript
   * await DistributedChildRegistry.unregisterChild('distributed-sup-1', 'cache-worker');
   * ```
   */
  async unregisterChild(supervisorId: string, childId: string): Promise<void> {
    const key = buildRegistryKey(supervisorId, childId);
    await GlobalRegistry.unregister(key);
  },

  /**
   * Checks if a child is currently registered.
   *
   * Returns detailed information about the registration status,
   * including which node the child is running on.
   *
   * @param supervisorId - Unique identifier of the supervisor
   * @param childId - Unique identifier of the child
   * @returns Registration status with node and reference information
   *
   * @example
   * ```typescript
   * const status = DistributedChildRegistry.isChildRegistered('sup-1', 'worker-1');
   *
   * if (status.exists) {
   *   console.log(`Child running on node: ${status.nodeId}`);
   *   console.log(`Owned by supervisor: ${status.supervisorId}`);
   * }
   * ```
   */
  isChildRegistered(supervisorId: string, childId: string): ChildRegistrationStatus {
    const key = buildRegistryKey(supervisorId, childId);
    const ref = GlobalRegistry.whereis(key);

    if (!ref) {
      return { exists: false };
    }

    const metadata = decodeMetadata(ref.id);

    return {
      exists: true,
      nodeId: ref.nodeId,
      ref,
      supervisorId: metadata?.supervisorId,
    };
  },

  /**
   * Attempts to claim a child for restart.
   *
   * This is an atomic operation that prevents multiple supervisors from
   * trying to restart the same child simultaneously. The claiming process:
   *
   * 1. Unregisters the current registration (if exists)
   * 2. The caller should then restart the child
   * 3. Re-register with the new reference
   *
   * If another supervisor already claimed the child (registration doesn't
   * exist or belongs to a different supervisor), the claim fails.
   *
   * @param supervisorId - Unique identifier of the claiming supervisor
   * @param childId - Unique identifier of the child to claim
   * @returns true if claim succeeded, false if child is claimed by another supervisor
   * @throws {DistributedChildClaimError} If the child belongs to a different supervisor
   *
   * @example
   * ```typescript
   * const claimed = await DistributedChildRegistry.tryClaimChild('sup-1', 'worker-1');
   *
   * if (claimed) {
   *   // We successfully claimed the child - safe to restart
   *   const newRef = await RemoteSpawn.spawn(behaviorName, newNodeId, args);
   *   await DistributedChildRegistry.registerChild('sup-1', 'worker-1', newRef, newNodeId);
   * } else {
   *   // Another supervisor is handling this child
   *   console.log('Child restart being handled by another supervisor');
   * }
   * ```
   */
  async tryClaimChild(supervisorId: string, childId: string): Promise<boolean> {
    const key = buildRegistryKey(supervisorId, childId);
    const existingRef = GlobalRegistry.whereis(key);

    // If not registered, claim fails - nothing to claim
    if (!existingRef) {
      return false;
    }

    // Verify ownership through metadata
    const metadata = decodeMetadata(existingRef.id);

    if (metadata && metadata.supervisorId !== supervisorId) {
      // Child belongs to a different supervisor
      throw new DistributedChildClaimError(
        supervisorId,
        childId,
        metadata.supervisorId,
      );
    }

    // Claim by unregistering - the caller is now responsible for re-registering
    // after successful restart
    await GlobalRegistry.unregister(key);

    return true;
  },

  /**
   * Lists all children registered by a specific supervisor.
   *
   * Useful for supervisor recovery scenarios where we need to know
   * which children were previously managed.
   *
   * @param supervisorId - Unique identifier of the supervisor
   * @returns Array of child IDs registered by this supervisor
   *
   * @example
   * ```typescript
   * const childIds = DistributedChildRegistry.getChildrenForSupervisor('sup-1');
   * console.log(`Supervisor manages ${childIds.length} children`);
   * ```
   */
  getChildrenForSupervisor(supervisorId: string): readonly string[] {
    const prefix = `${REGISTRY_PREFIX}${KEY_SEPARATOR}${supervisorId}${KEY_SEPARATOR}`;
    const allNames = GlobalRegistry.getNames();

    const childIds: string[] = [];

    for (const name of allNames) {
      if (name.startsWith(prefix)) {
        const parsed = parseRegistryKey(name);
        if (parsed && parsed.supervisorId === supervisorId) {
          childIds.push(parsed.childId);
        }
      }
    }

    return childIds;
  },

  /**
   * Unregisters all children belonging to a supervisor.
   *
   * Used during supervisor shutdown to clean up all child registrations.
   *
   * @param supervisorId - Unique identifier of the supervisor
   * @returns Number of children unregistered
   *
   * @example
   * ```typescript
   * const count = await DistributedChildRegistry.unregisterAllChildren('sup-1');
   * console.log(`Cleaned up ${count} child registrations`);
   * ```
   */
  async unregisterAllChildren(supervisorId: string): Promise<number> {
    const childIds = this.getChildrenForSupervisor(supervisorId);

    for (const childId of childIds) {
      await this.unregisterChild(supervisorId, childId);
    }

    return childIds.length;
  },

  /**
   * Gets the original GenServer ID from a child registration.
   *
   * @param supervisorId - Unique identifier of the supervisor
   * @param childId - Unique identifier of the child
   * @returns The GenServer ID if registered, undefined otherwise
   */
  getServerIdForChild(supervisorId: string, childId: string): string | undefined {
    const key = buildRegistryKey(supervisorId, childId);
    const ref = GlobalRegistry.whereis(key);

    if (!ref) {
      return undefined;
    }

    const metadata = decodeMetadata(ref.id);
    return metadata?.serverId;
  },

  // ===========================================================================
  // Internal / Testing APIs
  // ===========================================================================

  /**
   * Builds a registry key for a child.
   *
   * @internal Exported for testing purposes
   */
  _buildRegistryKey: buildRegistryKey,

  /**
   * Parses a registry key.
   *
   * @internal Exported for testing purposes
   */
  _parseRegistryKey: parseRegistryKey,
} as const;
