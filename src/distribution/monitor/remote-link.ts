/**
 * Remote link implementation for distributed bidirectional process linking.
 *
 * Enables Erlang-style bidirectional links between processes on different nodes.
 * When a linked process terminates abnormally, the exit signal is propagated
 * to the peer process on the remote node:
 * - If the peer has trapExit enabled, it receives an ExitSignal info message.
 * - Otherwise, the peer is force-terminated (cascading failure).
 *
 * Normal exits ('normal') do NOT propagate through links - the link is
 * simply removed on both sides.
 *
 * @module distribution/monitor/remote-link
 */

import type {
  LinkId,
  NodeId,
  LinkRequestMessage,
  LinkAckMessage,
  UnlinkRequestMessage,
  ExitSignalMessage,
  ProcessDownReason,
  SerializedRef,
} from '../types.js';
import { NodeNotReachableError, ClusterNotStartedError } from '../types.js';
import type { GenServerRef, LinkRef, TerminateReason, LifecycleEvent } from '../../core/types.js';
import { generateLinkId } from '../serialization.js';
import { Cluster } from '../cluster/cluster.js';
import { GenServer } from '../../core/gen-server.js';

// =============================================================================
// Constants
// =============================================================================

/**
 * Default timeout for link setup in milliseconds.
 */
const DEFAULT_LINK_TIMEOUT_MS = 10_000;

// =============================================================================
// Types
// =============================================================================

/**
 * State of a pending link request.
 */
type PendingLinkState = 'pending' | 'resolved' | 'rejected' | 'timeout';

/**
 * Information about a pending link request awaiting acknowledgement.
 */
interface PendingLink {
  readonly linkId: LinkId;
  readonly localRef: SerializedRef;
  readonly remoteRef: SerializedRef;
  readonly resolve: (value: LinkRef) => void;
  readonly reject: (error: Error) => void;
  readonly timeoutHandle: ReturnType<typeof setTimeout>;
  readonly timeoutMs: number;
  readonly createdAt: number;
  state: PendingLinkState;
}

/**
 * An active remote link entry tracked in the registry.
 */
interface RemoteLinkEntry {
  readonly linkId: LinkId;
  readonly localServerId: string;
  readonly remoteRef: SerializedRef;
  readonly createdAt: number;
}

/**
 * Options for remote link setup.
 */
export interface RemoteLinkOptions {
  readonly timeout?: number;
}

/**
 * Statistics about remote link operations.
 */
export interface RemoteLinkStats {
  readonly initialized: boolean;
  readonly pendingCount: number;
  readonly activeLinkCount: number;
  readonly totalInitiated: number;
  readonly totalEstablished: number;
  readonly totalTimedOut: number;
  readonly totalUnlinked: number;
  readonly totalExitSignalsReceived: number;
  readonly totalExitSignalsSent: number;
}

/**
 * Error thrown when remote link setup times out.
 */
export class RemoteLinkTimeoutError extends Error {
  override readonly name = 'RemoteLinkTimeoutError' as const;

  constructor(
    readonly remoteRef: SerializedRef,
    readonly timeoutMs: number,
  ) {
    super(
      `Remote link to '${remoteRef.id}' on node '${remoteRef.nodeId}' timed out after ${timeoutMs}ms`,
    );
  }
}

// =============================================================================
// State
// =============================================================================

/** Pending link requests awaiting acknowledgement */
const pendingLinks = new Map<LinkId, PendingLink>();

/** Active remote links: linkId -> entry */
const activeLinks = new Map<LinkId, RemoteLinkEntry>();

/** Index: localServerId -> Set<LinkId> */
const linksByLocalServer = new Map<string, Set<LinkId>>();

/** Index: remoteNodeId -> Set<LinkId> */
const linksByRemoteNode = new Map<NodeId, Set<LinkId>>();

/** Whether the module is initialized */
let initialized = false;

/** Cleanup function for node down handler */
let nodeDownCleanup: (() => void) | null = null;

/** Cleanup function for lifecycle event handler */
let lifecycleCleanup: (() => void) | null = null;

// Statistics
let totalInitiated = 0;
let totalEstablished = 0;
let totalTimedOut = 0;
let totalUnlinked = 0;
let totalExitSignalsReceived = 0;
let totalExitSignalsSent = 0;

// =============================================================================
// Registry Helpers
// =============================================================================

function addToIndex<K>(index: Map<K, Set<LinkId>>, key: K, linkId: LinkId): void {
  let set = index.get(key);
  if (!set) {
    set = new Set();
    index.set(key, set);
  }
  set.add(linkId);
}

function removeFromIndex<K>(index: Map<K, Set<LinkId>>, key: K, linkId: LinkId): void {
  const set = index.get(key);
  if (set) {
    set.delete(linkId);
    if (set.size === 0) {
      index.delete(key);
    }
  }
}

function registerLink(entry: RemoteLinkEntry): void {
  activeLinks.set(entry.linkId, entry);
  addToIndex(linksByLocalServer, entry.localServerId, entry.linkId);
  addToIndex(linksByRemoteNode, entry.remoteRef.nodeId, entry.linkId);
}

function unregisterLink(linkId: LinkId): RemoteLinkEntry | undefined {
  const entry = activeLinks.get(linkId);
  if (!entry) {
    return undefined;
  }
  activeLinks.delete(linkId);
  removeFromIndex(linksByLocalServer, entry.localServerId, linkId);
  removeFromIndex(linksByRemoteNode, entry.remoteRef.nodeId, linkId);
  return entry;
}

// =============================================================================
// Initialization
// =============================================================================

function ensureInitialized(): void {
  if (initialized) {
    return;
  }

  nodeDownCleanup = Cluster.onNodeDown((nodeId, _reason) => {
    handleNodeDown(nodeId as NodeId);
  });

  lifecycleCleanup = GenServer.onLifecycleEvent((event) => {
    handleLifecycleEvent(event);
  });

  initialized = true;
}

// =============================================================================
// Internal Handlers
// =============================================================================

/**
 * Maps GenServer TerminateReason to ProcessDownReason.
 */
function mapTerminateReason(reason: TerminateReason): ProcessDownReason {
  if (reason === 'normal') {
    return { type: 'normal' };
  }
  if (reason === 'shutdown') {
    return { type: 'shutdown' };
  }
  return {
    type: 'error',
    message: reason.error.message,
  };
}

/**
 * Handles lifecycle events from GenServer to detect local process termination.
 * When a local process that has remote links terminates, we propagate
 * the exit signal to remote peers or send unlink for normal exits.
 */
function handleLifecycleEvent(event: LifecycleEvent): void {
  if (event.type !== 'terminated') {
    return;
  }

  const serverId = event.ref.id;
  const linkIds = linksByLocalServer.get(serverId);
  if (!linkIds || linkIds.size === 0) {
    return;
  }

  const reason = event.reason;
  const isNormalExit = reason === 'normal';
  const processDownReason = mapTerminateReason(reason);

  // Copy the set since we'll modify it
  for (const linkId of [...linkIds]) {
    const entry = unregisterLink(linkId);
    if (!entry) {
      continue;
    }

    if (isNormalExit) {
      // Normal exit: just remove the link on remote side (no propagation)
      sendUnlinkRequest(entry.remoteRef.nodeId, linkId);
    } else {
      // Abnormal exit: propagate exit signal to remote peer
      sendExitSignal(entry, processDownReason);
    }
  }
}

/**
 * Handles a node going down by propagating noconnection exit signals
 * to all local processes linked to processes on that node.
 */
function handleNodeDown(nodeId: NodeId): void {
  // Reject pending links to the downed node
  for (const [linkId, pending] of pendingLinks) {
    if (pending.remoteRef.nodeId === nodeId && pending.state === 'pending') {
      clearTimeout(pending.timeoutHandle);
      pending.state = 'rejected';
      pendingLinks.delete(linkId);
      pending.reject(new NodeNotReachableError(nodeId));
    }
  }

  // Propagate noconnection to all local processes linked to the downed node
  const linkIds = linksByRemoteNode.get(nodeId);
  if (!linkIds || linkIds.size === 0) {
    return;
  }

  for (const linkId of [...linkIds]) {
    const entry = unregisterLink(linkId);
    if (!entry) {
      continue;
    }
    applyExitSignalLocally(entry.localServerId, entry.remoteRef, { type: 'noconnection' });
  }
}

/**
 * Handles timeout for a pending link request.
 */
function handleTimeout(linkId: LinkId): void {
  const pending = pendingLinks.get(linkId);
  if (!pending || pending.state !== 'pending') {
    return;
  }

  pending.state = 'timeout';
  pendingLinks.delete(linkId);
  totalTimedOut++;

  pending.reject(new RemoteLinkTimeoutError(pending.remoteRef, pending.timeoutMs));
}

/**
 * Applies an exit signal to a local process (either terminate or deliver as info).
 */
function applyExitSignalLocally(
  localServerId: string,
  fromRef: SerializedRef,
  reason: ProcessDownReason,
): void {
  GenServer._deliverRemoteExitSignal(localServerId, fromRef, reason);
}

/**
 * Sends an unlink request to the remote node (fire-and-forget).
 */
function sendUnlinkRequest(nodeId: NodeId, linkId: LinkId): void {
  const message: UnlinkRequestMessage = {
    type: 'unlink_request',
    linkId,
  };

  void (async () => {
    try {
      const transport = Cluster._getTransport();
      if (transport.isConnectedTo(nodeId)) {
        await transport.send(nodeId, message);
      }
    } catch {
      // Best effort
    }
  })();
}

/**
 * Sends an exit signal to the remote peer of a link.
 */
function sendExitSignal(entry: RemoteLinkEntry, reason: ProcessDownReason): void {
  totalExitSignalsSent++;

  const localNodeId = Cluster.getLocalNodeId();
  const message: ExitSignalMessage = {
    type: 'exit_signal',
    linkId: entry.linkId,
    fromRef: { id: entry.localServerId, nodeId: localNodeId },
    toRef: entry.remoteRef,
    reason,
  };

  void (async () => {
    try {
      const transport = Cluster._getTransport();
      if (transport.isConnectedTo(entry.remoteRef.nodeId)) {
        await transport.send(entry.remoteRef.nodeId, message);
      }
    } catch {
      // Best effort
    }
  })();
}

// =============================================================================
// RemoteLink Public API
// =============================================================================

/**
 * Remote link operations for distributed bidirectional process linking.
 *
 * @example
 * ```typescript
 * import { RemoteLink } from 'noex/distribution';
 *
 * // Link a local process with a remote process
 * const linkRef = await RemoteLink.link(localRef, remoteRef);
 *
 * // If remoteRef crashes, localRef will be terminated too
 * // (unless localRef was started with trapExit: true)
 *
 * // Remove the link
 * await RemoteLink.unlink(linkRef);
 * ```
 */
export const RemoteLink = {
  /**
   * Establishes a bidirectional link between a local and a remote process.
   *
   * @param localRef - Reference to the local process
   * @param remoteRef - Reference to the remote process
   * @param options - Link options
   * @returns Promise resolving to a LinkRef
   * @throws {ClusterNotStartedError} If cluster is not running
   * @throws {NodeNotReachableError} If target node is not connected
   * @throws {RemoteLinkTimeoutError} If link setup times out
   */
  async link(
    localRef: GenServerRef,
    remoteRef: GenServerRef,
    options: RemoteLinkOptions = {},
  ): Promise<LinkRef> {
    ensureInitialized();

    const transport = Cluster._getTransport();
    const localNodeId = Cluster.getLocalNodeId();
    const timeoutMs = options.timeout ?? DEFAULT_LINK_TIMEOUT_MS;

    const serializedLocalRef: SerializedRef = {
      id: localRef.id,
      nodeId: localNodeId,
    };

    const targetNodeId = remoteRef.nodeId as NodeId | undefined;
    if (!targetNodeId) {
      throw new Error('remoteRef must have a nodeId for remote linking');
    }

    const serializedRemoteRef: SerializedRef = {
      id: remoteRef.id,
      nodeId: targetNodeId,
    };

    if (!transport.isConnectedTo(targetNodeId)) {
      throw new NodeNotReachableError(targetNodeId);
    }

    const linkId = generateLinkId();
    totalInitiated++;

    const promise = new Promise<LinkRef>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        handleTimeout(linkId);
      }, timeoutMs);

      if (timeoutHandle.unref) {
        timeoutHandle.unref();
      }

      const pending: PendingLink = {
        linkId,
        localRef: serializedLocalRef,
        remoteRef: serializedRemoteRef,
        resolve,
        reject,
        timeoutHandle,
        timeoutMs,
        createdAt: Date.now(),
        state: 'pending',
      };

      pendingLinks.set(linkId, pending);
    });

    const linkRequest: LinkRequestMessage = {
      type: 'link_request',
      linkId,
      fromRef: serializedLocalRef,
      toRef: serializedRemoteRef,
    };

    try {
      await transport.send(targetNodeId, linkRequest);
    } catch (error) {
      const pending = pendingLinks.get(linkId);
      if (pending && pending.state === 'pending') {
        clearTimeout(pending.timeoutHandle);
        pending.state = 'rejected';
        pendingLinks.delete(linkId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }

    return promise;
  },

  /**
   * Removes a remote link.
   *
   * Sends an unlink request to the remote node and removes
   * the link from the local registry.
   *
   * @param linkRef - Reference to the link to remove
   */
  async unlink(linkRef: LinkRef): Promise<void> {
    ensureInitialized();

    const entry = unregisterLink(linkRef.linkId as LinkId);
    if (!entry) {
      return;
    }

    totalUnlinked++;
    sendUnlinkRequest(entry.remoteRef.nodeId, linkRef.linkId as LinkId);
  },

  /**
   * Handles an incoming link_ack message from the remote node.
   *
   * @param message - Link acknowledgement message
   * @internal
   */
  _handleLinkAck(message: LinkAckMessage): void {
    const pending = pendingLinks.get(message.linkId);
    if (!pending || pending.state !== 'pending') {
      return;
    }

    clearTimeout(pending.timeoutHandle);

    if (!message.success) {
      pending.state = 'rejected';
      pendingLinks.delete(message.linkId);
      pending.reject(new Error(message.reason ?? 'Link setup failed'));
      return;
    }

    pending.state = 'resolved';
    pendingLinks.delete(message.linkId);
    totalEstablished++;

    // Register the active link
    registerLink({
      linkId: message.linkId,
      localServerId: pending.localRef.id,
      remoteRef: pending.remoteRef,
      createdAt: Date.now(),
    });

    pending.resolve({
      linkId: message.linkId,
      ref1: pending.localRef,
      ref2: pending.remoteRef,
    });
  },

  /**
   * Handles an incoming link_request from a remote node.
   *
   * Validates that the target local process exists, registers the link,
   * and sends the acknowledgement.
   *
   * @param message - The link request message
   * @param fromNodeId - The node that sent the request
   * @internal
   */
  async _handleLinkRequest(message: LinkRequestMessage, fromNodeId: NodeId): Promise<void> {
    const { linkId, fromRef, toRef } = message;

    // Verify the target process exists locally
    const localRef = GenServer._getRefById(toRef.id);
    if (!localRef) {
      await sendLinkAck(fromNodeId, linkId, false, 'Process not found');
      return;
    }

    if (!GenServer.isRunning(localRef)) {
      await sendLinkAck(fromNodeId, linkId, false, 'Process not running');
      return;
    }

    // Register the link (from remote's perspective, fromRef is the remote process)
    registerLink({
      linkId,
      localServerId: toRef.id,
      remoteRef: fromRef,
      createdAt: Date.now(),
    });

    await sendLinkAck(fromNodeId, linkId, true);
  },

  /**
   * Handles an incoming unlink_request from a remote node.
   *
   * @param message - The unlink request message
   * @internal
   */
  _handleUnlinkRequest(message: UnlinkRequestMessage): void {
    unregisterLink(message.linkId);
  },

  /**
   * Handles an incoming exit_signal from a remote node.
   *
   * Applies the exit signal to the local linked process.
   *
   * @param message - The exit signal message
   * @internal
   */
  _handleExitSignal(message: ExitSignalMessage): void {
    totalExitSignalsReceived++;

    // Remove the link from registry
    const entry = unregisterLink(message.linkId);
    if (!entry) {
      // Link not found - might be already unlinked or process terminated
      return;
    }

    // Apply exit signal to the local process
    applyExitSignalLocally(entry.localServerId, message.fromRef, message.reason);
  },

  /**
   * Returns statistics about remote link operations.
   */
  getStats(): RemoteLinkStats {
    return {
      initialized,
      pendingCount: pendingLinks.size,
      activeLinkCount: activeLinks.size,
      totalInitiated,
      totalEstablished,
      totalTimedOut,
      totalUnlinked,
      totalExitSignalsReceived,
      totalExitSignalsSent,
    };
  },

  /**
   * Clears all pending and active links.
   *
   * Called during cluster shutdown.
   *
   * @internal
   */
  _clear(): void {
    const error = new ClusterNotStartedError();
    for (const [, pending] of pendingLinks) {
      if (pending.state === 'pending') {
        clearTimeout(pending.timeoutHandle);
        pending.state = 'rejected';
        pending.reject(error);
      }
    }
    pendingLinks.clear();
    activeLinks.clear();
    linksByLocalServer.clear();
    linksByRemoteNode.clear();
  },

  /**
   * Returns the number of active links (for testing).
   *
   * @internal
   */
  _getActiveLinkCount(): number {
    return activeLinks.size;
  },

  /**
   * Returns active links for a given local server (for testing).
   *
   * @internal
   */
  _getLinksByServer(serverId: string): readonly RemoteLinkEntry[] {
    const linkIds = linksByLocalServer.get(serverId);
    if (!linkIds) {
      return [];
    }
    return [...linkIds]
      .map(id => activeLinks.get(id))
      .filter((e): e is RemoteLinkEntry => e !== undefined);
  },
} as const;

// =============================================================================
// Helper Functions
// =============================================================================

async function sendLinkAck(
  nodeId: NodeId,
  linkId: LinkId,
  success: boolean,
  reason?: string,
): Promise<void> {
  const ack: LinkAckMessage = {
    type: 'link_ack',
    linkId,
    success,
    ...(reason !== undefined && { reason }),
  };

  try {
    const transport = Cluster._getTransport();
    await transport.send(nodeId, ack);
  } catch {
    // Best effort
  }
}

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Resets all remote link state.
 *
 * @internal Used for testing.
 */
export function _resetRemoteLinkState(): void {
  for (const [, pending] of pendingLinks) {
    if (pending.state === 'pending') {
      clearTimeout(pending.timeoutHandle);
    }
  }
  pendingLinks.clear();
  activeLinks.clear();
  linksByLocalServer.clear();
  linksByRemoteNode.clear();

  if (nodeDownCleanup) {
    nodeDownCleanup();
    nodeDownCleanup = null;
  }

  if (lifecycleCleanup) {
    lifecycleCleanup();
    lifecycleCleanup = null;
  }

  totalInitiated = 0;
  totalEstablished = 0;
  totalTimedOut = 0;
  totalUnlinked = 0;
  totalExitSignalsReceived = 0;
  totalExitSignalsSent = 0;

  initialized = false;
}
