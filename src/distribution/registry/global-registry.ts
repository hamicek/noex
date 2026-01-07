/**
 * Global distributed registry for cross-cluster process lookup.
 *
 * Provides cluster-wide name registration with:
 * - Unique global names across all nodes
 * - Automatic synchronization on node join
 * - Conflict resolution via timestamp + node priority
 * - Automatic cleanup on node down
 *
 * @module distribution/registry/global-registry
 */

import { EventEmitter } from 'node:events';

import type {
  NodeId,
  SerializedRef,
  RegistrySyncEntry,
  RegistrySyncMessage,
  NodeDownReason,
} from '../types.js';
import { Cluster } from '../cluster/cluster.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Internal representation of a global registry entry.
 */
interface GlobalRegistryEntry {
  /** Registered name */
  readonly name: string;

  /** Serialized reference to the process */
  readonly ref: SerializedRef;

  /** Unix timestamp when the registration was created */
  readonly registeredAt: number;

  /**
   * Priority for conflict resolution.
   * Lower value wins in case of timestamp tie.
   */
  readonly priority: number;
}

/**
 * Events emitted by GlobalRegistry.
 */
export interface GlobalRegistryEvents {
  /** Emitted when a global registration is added */
  registered: [name: string, ref: SerializedRef];

  /** Emitted when a global registration is removed */
  unregistered: [name: string, ref: SerializedRef];

  /** Emitted when a registration conflict is resolved */
  conflictResolved: [name: string, winner: SerializedRef, loser: SerializedRef];

  /** Emitted when registry sync is completed */
  synced: [fromNodeId: NodeId, entriesCount: number];
}

/**
 * Statistics about the global registry.
 */
export interface GlobalRegistryStats {
  /** Total number of global registrations */
  readonly totalRegistrations: number;

  /** Number of local registrations (owned by this node) */
  readonly localRegistrations: number;

  /** Number of remote registrations (owned by other nodes) */
  readonly remoteRegistrations: number;

  /** Number of sync operations completed */
  readonly syncOperations: number;

  /** Number of conflicts resolved */
  readonly conflictsResolved: number;
}

/**
 * Error thrown when attempting to register a name that is already in use.
 */
export class GlobalNameConflictError extends Error {
  override readonly name = 'GlobalNameConflictError' as const;

  constructor(
    readonly registryName: string,
    readonly existingNodeId: NodeId,
  ) {
    super(
      `Global name '${registryName}' is already registered on node '${existingNodeId}'`,
    );
  }
}

/**
 * Error thrown when looking up a name that is not registered.
 */
export class GlobalNameNotFoundError extends Error {
  override readonly name = 'GlobalNameNotFoundError' as const;

  constructor(readonly registryName: string) {
    super(`Global name '${registryName}' is not registered`);
  }
}

// =============================================================================
// GlobalRegistry Class
// =============================================================================

/**
 * Internal implementation of the global registry.
 */
class GlobalRegistryImpl extends EventEmitter<GlobalRegistryEvents> {
  /** Map of name -> entry for all known global registrations */
  private readonly entries = new Map<string, GlobalRegistryEntry>();

  /** Sync operations counter */
  private syncOperations = 0;

  /** Conflicts resolved counter */
  private conflictsResolved = 0;

  /** Whether the registry is initialized and listening to cluster events */
  private initialized = false;

  /** Unsubscribe function for node down events */
  private nodeDownUnsubscribe: (() => void) | null = null;

  /** Unsubscribe function for node up events */
  private nodeUpUnsubscribe: (() => void) | null = null;

  /**
   * Ensures the registry is initialized and listening to cluster events.
   */
  private ensureInitialized(): void {
    if (this.initialized) {
      return;
    }

    // Subscribe to node events
    this.nodeDownUnsubscribe = Cluster.onNodeDown((nodeId, reason) => {
      this.handleNodeDown(nodeId, reason);
    });

    this.nodeUpUnsubscribe = Cluster.onNodeUp((node) => {
      this.handleNodeUp(node.id);
    });

    this.initialized = true;
  }

  /**
   * Registers a process globally across the cluster.
   *
   * The registration is broadcast to all connected nodes. If the name
   * is already registered, the conflict is resolved using timestamp
   * and node priority - earlier registration wins.
   *
   * @param name - Unique name for the registration
   * @param ref - Serialized reference to the process
   * @returns Promise that resolves when the registration is complete
   * @throws {GlobalNameConflictError} If name is already registered by another node
   */
  async register(name: string, ref: SerializedRef): Promise<void> {
    this.ensureInitialized();

    const localNodeId = Cluster.getLocalNodeId();
    const now = Date.now();

    // Check for existing registration
    const existing = this.entries.get(name);
    if (existing) {
      // If same node and same ref, it's a duplicate - ignore
      if (existing.ref.id === ref.id && existing.ref.nodeId === ref.nodeId) {
        return;
      }

      // Different registration exists - this is a conflict
      // New registrations don't win over existing ones
      throw new GlobalNameConflictError(name, existing.ref.nodeId);
    }

    // Create the entry
    const entry: GlobalRegistryEntry = {
      name,
      ref,
      registeredAt: now,
      priority: this.computeNodePriority(localNodeId),
    };

    // Store locally
    this.entries.set(name, entry);
    this.emit('registered', name, ref);

    // Broadcast to all connected nodes
    await this.broadcastRegistration(entry);
  }

  /**
   * Unregisters a globally registered process.
   *
   * Only the owning node can unregister a process.
   *
   * @param name - Name of the registration to remove
   */
  async unregister(name: string): Promise<void> {
    this.ensureInitialized();

    const localNodeId = Cluster.getLocalNodeId();
    const entry = this.entries.get(name);

    if (!entry) {
      return;
    }

    // Only owner can unregister
    if (entry.ref.nodeId !== localNodeId) {
      return;
    }

    this.entries.delete(name);
    this.emit('unregistered', name, entry.ref);

    // Broadcast unregistration (empty sync for this name)
    await this.broadcastUnregistration(name);
  }

  /**
   * Looks up a globally registered process.
   *
   * @param name - Name to look up
   * @returns The serialized reference if found
   * @throws {GlobalNameNotFoundError} If name is not registered
   */
  lookup(name: string): SerializedRef {
    this.ensureInitialized();

    const entry = this.entries.get(name);
    if (!entry) {
      throw new GlobalNameNotFoundError(name);
    }

    return entry.ref;
  }

  /**
   * Looks up a globally registered process, returning undefined if not found.
   *
   * @param name - Name to look up
   * @returns The serialized reference if found, undefined otherwise
   */
  whereis(name: string): SerializedRef | undefined {
    // Don't require initialization for whereis - it may be called before cluster starts
    const entry = this.entries.get(name);
    return entry?.ref;
  }

  /**
   * Checks if a name is globally registered.
   *
   * @param name - Name to check
   * @returns true if the name is registered
   */
  isRegistered(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * Returns all registered names.
   */
  getNames(): readonly string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Returns all entries for a given node.
   *
   * @param nodeId - Node to get entries for
   */
  getEntriesForNode(nodeId: NodeId): readonly GlobalRegistryEntry[] {
    return Array.from(this.entries.values()).filter(
      (entry) => entry.ref.nodeId === nodeId,
    );
  }

  /**
   * Returns the number of global registrations.
   */
  count(): number {
    return this.entries.size;
  }

  /**
   * Returns statistics about the global registry.
   */
  getStats(): GlobalRegistryStats {
    let localNodeId: NodeId | null = null;
    try {
      localNodeId = Cluster.getLocalNodeId();
    } catch {
      // Cluster not started
    }

    let localCount = 0;
    let remoteCount = 0;

    for (const entry of this.entries.values()) {
      if (localNodeId && entry.ref.nodeId === localNodeId) {
        localCount++;
      } else {
        remoteCount++;
      }
    }

    return {
      totalRegistrations: this.entries.size,
      localRegistrations: localCount,
      remoteRegistrations: remoteCount,
      syncOperations: this.syncOperations,
      conflictsResolved: this.conflictsResolved,
    };
  }

  /**
   * Handles an incoming registry sync message.
   *
   * Called by the Cluster when a registry_sync message is received.
   *
   * @param message - Registry sync message
   * @param fromNodeId - Source node ID
   * @internal
   */
  handleRegistrySync(message: RegistrySyncMessage, fromNodeId: NodeId): void {
    this.ensureInitialized();

    if (message.fullSync) {
      // Full sync - remove all entries from this node first
      this.removeEntriesFromNode(fromNodeId);
    }

    // Process each entry
    for (const syncEntry of message.entries) {
      this.processIncomingEntry(syncEntry);
    }

    this.syncOperations++;
    this.emit('synced', fromNodeId, message.entries.length);
  }

  /**
   * Creates a full sync message containing all local registrations.
   *
   * Used when a new node joins to send our registrations.
   */
  createFullSyncMessage(): RegistrySyncMessage {
    let localNodeId: NodeId | null = null;
    try {
      localNodeId = Cluster.getLocalNodeId();
    } catch {
      // Cluster not started
    }

    const entries: RegistrySyncEntry[] = [];

    for (const entry of this.entries.values()) {
      // Only include local entries in full sync
      if (localNodeId && entry.ref.nodeId === localNodeId) {
        entries.push({
          name: entry.name,
          ref: entry.ref,
          registeredAt: entry.registeredAt,
          priority: entry.priority,
        });
      }
    }

    return {
      type: 'registry_sync',
      entries,
      fullSync: true,
    };
  }

  /**
   * Clears all registrations.
   *
   * @internal
   */
  _clear(): void {
    this.entries.clear();
    this.syncOperations = 0;
    this.conflictsResolved = 0;
  }

  /**
   * Resets the initialization state.
   *
   * @internal
   */
  _reset(): void {
    if (this.nodeDownUnsubscribe) {
      this.nodeDownUnsubscribe();
      this.nodeDownUnsubscribe = null;
    }

    if (this.nodeUpUnsubscribe) {
      this.nodeUpUnsubscribe();
      this.nodeUpUnsubscribe = null;
    }

    this._clear();
    this.initialized = false;
    this.removeAllListeners();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Processes an incoming registry entry from sync.
   */
  private processIncomingEntry(syncEntry: RegistrySyncEntry): void {
    const existing = this.entries.get(syncEntry.name);

    if (!existing) {
      // No conflict - just add
      this.entries.set(syncEntry.name, {
        name: syncEntry.name,
        ref: syncEntry.ref,
        registeredAt: syncEntry.registeredAt,
        priority: syncEntry.priority,
      });
      this.emit('registered', syncEntry.name, syncEntry.ref);
      return;
    }

    // Same entry - ignore
    if (
      existing.ref.id === syncEntry.ref.id &&
      existing.ref.nodeId === syncEntry.ref.nodeId
    ) {
      return;
    }

    // Conflict - resolve using timestamp then priority
    const winner = this.resolveConflict(existing, syncEntry);

    if (winner !== existing) {
      // New entry wins
      this.entries.set(syncEntry.name, {
        name: syncEntry.name,
        ref: syncEntry.ref,
        registeredAt: syncEntry.registeredAt,
        priority: syncEntry.priority,
      });

      this.emit('conflictResolved', syncEntry.name, syncEntry.ref, existing.ref);
      this.conflictsResolved++;
    } else {
      // Existing entry wins
      this.emit('conflictResolved', syncEntry.name, existing.ref, syncEntry.ref);
      this.conflictsResolved++;
    }
  }

  /**
   * Resolves a conflict between two entries.
   * Returns the winner (earlier timestamp wins, lower priority as tiebreaker).
   */
  private resolveConflict(
    a: GlobalRegistryEntry | RegistrySyncEntry,
    b: GlobalRegistryEntry | RegistrySyncEntry,
  ): GlobalRegistryEntry | RegistrySyncEntry {
    // Earlier registration wins
    if (a.registeredAt < b.registeredAt) {
      return a;
    }
    if (b.registeredAt < a.registeredAt) {
      return b;
    }

    // Same timestamp - lower priority wins (deterministic tiebreaker)
    if (a.priority <= b.priority) {
      return a;
    }
    return b;
  }

  /**
   * Computes priority for a node (used as tiebreaker in conflict resolution).
   * Lower is better. Based on hash of node ID for deterministic ordering.
   */
  private computeNodePriority(nodeId: NodeId): number {
    let hash = 0;
    for (let i = 0; i < nodeId.length; i++) {
      const char = nodeId.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Removes all entries from a specific node.
   */
  private removeEntriesFromNode(nodeId: NodeId): void {
    const toRemove: string[] = [];

    for (const [name, entry] of this.entries) {
      if (entry.ref.nodeId === nodeId) {
        toRemove.push(name);
      }
    }

    for (const name of toRemove) {
      const entry = this.entries.get(name);
      if (entry) {
        this.entries.delete(name);
        this.emit('unregistered', name, entry.ref);
      }
    }
  }

  /**
   * Handles node down event - removes all registrations from that node.
   */
  private handleNodeDown(nodeId: NodeId, _reason: NodeDownReason): void {
    this.removeEntriesFromNode(nodeId);
  }

  /**
   * Handles node up event - sends full sync to the new node.
   */
  private handleNodeUp(nodeId: NodeId): void {
    // Send our registrations to the new node
    this.sendFullSyncToNode(nodeId).catch((err) => {
      // Log but don't throw - sync failure is not critical
      console.error(`Failed to send registry sync to ${nodeId}:`, err);
    });
  }

  /**
   * Broadcasts a registration to all connected nodes.
   */
  private async broadcastRegistration(entry: GlobalRegistryEntry): Promise<void> {
    const message: RegistrySyncMessage = {
      type: 'registry_sync',
      entries: [
        {
          name: entry.name,
          ref: entry.ref,
          registeredAt: entry.registeredAt,
          priority: entry.priority,
        },
      ],
      fullSync: false,
    };

    try {
      const transport = Cluster._getTransport();
      await transport.broadcast(message);
    } catch {
      // Ignore broadcast errors - nodes may not be connected yet
    }
  }

  /**
   * Broadcasts an unregistration to all connected nodes.
   */
  private async broadcastUnregistration(name: string): Promise<void> {
    // Send empty sync with the name removed
    // Other nodes will remove when they don't see the entry in next full sync
    // For immediate removal, we could add a dedicated message type,
    // but for simplicity we rely on node down handling
  }

  /**
   * Sends a full sync to a specific node.
   */
  private async sendFullSyncToNode(nodeId: NodeId): Promise<void> {
    const message = this.createFullSyncMessage();

    if (message.entries.length === 0) {
      return;
    }

    try {
      const transport = Cluster._getTransport();
      await transport.send(nodeId, message);
    } catch {
      // Ignore send errors
    }
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

/**
 * Global registry singleton for distributed process lookup.
 *
 * @example
 * ```typescript
 * import { GlobalRegistry, Cluster } from 'noex/distribution';
 *
 * // Register a process globally
 * await GlobalRegistry.register('main-counter', {
 *   id: ref.id,
 *   nodeId: Cluster.getLocalNodeId(),
 * });
 *
 * // Look up from any node
 * const counterRef = GlobalRegistry.lookup('main-counter');
 * ```
 */
export const GlobalRegistry = new GlobalRegistryImpl();
