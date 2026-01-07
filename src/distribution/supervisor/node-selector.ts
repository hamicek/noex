/**
 * Node selection strategies for distributed child placement.
 *
 * Provides implementations for selecting which cluster node should host
 * a child process, supporting built-in strategies (local_first, round_robin,
 * least_loaded, random), specific node targeting, and custom selector functions.
 *
 * @module distribution/supervisor/node-selector
 */

import type { NodeId } from '../node-id.js';
import type { NodeInfo } from '../types.js';
import type { NodeSelector, NodeSelectorType } from './types.js';
import { NoAvailableNodeError, DISTRIBUTED_SUPERVISOR_DEFAULTS } from './types.js';
import { Cluster } from '../cluster/index.js';

// =============================================================================
// Internal State
// =============================================================================

/**
 * Round-robin counter for distributing children across nodes.
 * Incremented on each round_robin selection.
 */
let roundRobinCounter = 0;

// =============================================================================
// Strategy Implementations
// =============================================================================

/**
 * Selects the local node if available, falls back to any connected node.
 *
 * This is the default strategy, minimizing network latency by preferring
 * local execution while still providing fault tolerance.
 */
function selectLocalFirst(
  nodes: readonly NodeInfo[],
  localNodeId: NodeId,
  childId: string,
  excludeNode?: NodeId,
): NodeId {
  // If local node is not excluded, prefer it
  if (excludeNode !== localNodeId) {
    return localNodeId;
  }

  // Fall back to any available connected node
  const availableNodes = excludeNode
    ? nodes.filter((n) => n.id !== excludeNode && n.status === 'connected')
    : nodes.filter((n) => n.status === 'connected');

  if (availableNodes.length === 0) {
    throw new NoAvailableNodeError(childId, 'local_first');
  }

  return availableNodes[0]!.id;
}

/**
 * Selects nodes in a round-robin fashion for load distribution.
 *
 * Each call increments an internal counter to ensure even distribution
 * across available nodes over time.
 */
function selectRoundRobin(
  nodes: readonly NodeInfo[],
  localNodeId: NodeId,
  childId: string,
  excludeNode?: NodeId,
): NodeId {
  // Build list of all candidate nodes (including local)
  const allNodes: NodeId[] = [];

  if (excludeNode !== localNodeId) {
    allNodes.push(localNodeId);
  }

  for (const node of nodes) {
    if (node.id !== excludeNode && node.status === 'connected') {
      allNodes.push(node.id);
    }
  }

  if (allNodes.length === 0) {
    throw new NoAvailableNodeError(childId, 'round_robin');
  }

  const index = roundRobinCounter % allNodes.length;
  roundRobinCounter++;

  return allNodes[index]!;
}

/**
 * Selects the node with the lowest process count.
 *
 * Provides dynamic load balancing by always placing new children
 * on the least loaded node.
 */
function selectLeastLoaded(
  nodes: readonly NodeInfo[],
  localNodeId: NodeId,
  childId: string,
  excludeNode?: NodeId,
): NodeId {
  // Build candidates with their process counts
  const candidates: Array<{ nodeId: NodeId; processCount: number }> = [];

  // Include local node (with process count 0 as we don't track it locally)
  if (excludeNode !== localNodeId) {
    candidates.push({ nodeId: localNodeId, processCount: 0 });
  }

  for (const node of nodes) {
    if (node.id !== excludeNode && node.status === 'connected') {
      candidates.push({ nodeId: node.id, processCount: node.processCount });
    }
  }

  if (candidates.length === 0) {
    throw new NoAvailableNodeError(childId, 'least_loaded');
  }

  // Sort by process count ascending and return the first (least loaded)
  candidates.sort((a, b) => a.processCount - b.processCount);

  return candidates[0]!.nodeId;
}

/**
 * Selects a random node from available nodes.
 *
 * Provides simple load distribution without state tracking,
 * useful when exact distribution is not critical.
 */
function selectRandom(
  nodes: readonly NodeInfo[],
  localNodeId: NodeId,
  childId: string,
  excludeNode?: NodeId,
): NodeId {
  // Build list of all candidate nodes (including local)
  const allNodes: NodeId[] = [];

  if (excludeNode !== localNodeId) {
    allNodes.push(localNodeId);
  }

  for (const node of nodes) {
    if (node.id !== excludeNode && node.status === 'connected') {
      allNodes.push(node.id);
    }
  }

  if (allNodes.length === 0) {
    throw new NoAvailableNodeError(childId, 'random');
  }

  const randomIndex = Math.floor(Math.random() * allNodes.length);
  return allNodes[randomIndex]!;
}

/**
 * Selects a specific node by its identifier.
 *
 * Used when a child must run on a particular node, such as
 * for data locality or hardware affinity.
 */
function selectSpecificNode(
  targetNodeId: NodeId,
  nodes: readonly NodeInfo[],
  localNodeId: NodeId,
  childId: string,
  excludeNode?: NodeId,
): NodeId {
  // Check if target is excluded
  if (targetNodeId === excludeNode) {
    throw new NoAvailableNodeError(childId, { node: targetNodeId });
  }

  // Target is local node - always available
  if (targetNodeId === localNodeId) {
    return targetNodeId;
  }

  // Check if target is a connected remote node
  const targetNode = nodes.find((n) => n.id === targetNodeId);
  if (!targetNode || targetNode.status !== 'connected') {
    throw new NoAvailableNodeError(childId, { node: targetNodeId });
  }

  return targetNodeId;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Node selector implementation for distributed child placement.
 *
 * Provides a unified interface for all node selection strategies,
 * handling both built-in strategies and custom selector functions.
 *
 * @example
 * ```typescript
 * // Using default strategy (local_first)
 * const nodeId = NodeSelectorImpl.selectNode('local_first', 'worker-1');
 *
 * // Using round-robin with exclusion
 * const nodeId = NodeSelectorImpl.selectNode(
 *   'round_robin',
 *   'worker-1',
 *   failedNodeId
 * );
 *
 * // Using custom selector
 * const customSelector = (nodes, childId) => {
 *   const preferred = nodes.find(n => n.id.includes('worker'));
 *   if (!preferred) throw new NoAvailableNodeError(childId);
 *   return preferred.id;
 * };
 * const nodeId = NodeSelectorImpl.selectNode(customSelector, 'task-1');
 * ```
 */
export const NodeSelectorImpl = {
  /**
   * Selects a node for spawning a child process.
   *
   * @param selector - Node selection strategy or custom function
   * @param childId - Identifier of the child being placed
   * @param excludeNode - Optional node to exclude (e.g., after failure)
   * @returns Selected node identifier
   * @throws {NoAvailableNodeError} When no suitable node is available
   * @throws {ClusterNotStartedError} When cluster is not running
   */
  selectNode(
    selector: NodeSelector | undefined,
    childId: string,
    excludeNode?: NodeId,
  ): NodeId {
    const effectiveSelector = selector ?? DISTRIBUTED_SUPERVISOR_DEFAULTS.NODE_SELECTOR;
    const localNodeId = Cluster.getLocalNodeId();
    const connectedNodes = Cluster.getConnectedNodes();

    return this.selectNodeWithContext(
      effectiveSelector,
      childId,
      localNodeId,
      connectedNodes,
      excludeNode,
    );
  },

  /**
   * Selects a node with explicit context (for testing and direct use).
   *
   * This method allows passing node information directly instead of
   * reading from Cluster, enabling unit testing without cluster setup.
   *
   * @param selector - Node selection strategy or custom function
   * @param childId - Identifier of the child being placed
   * @param localNodeId - Local node identifier
   * @param connectedNodes - List of connected remote nodes
   * @param excludeNode - Optional node to exclude
   * @returns Selected node identifier
   * @throws {NoAvailableNodeError} When no suitable node is available
   */
  selectNodeWithContext(
    selector: NodeSelector,
    childId: string,
    localNodeId: NodeId,
    connectedNodes: readonly NodeInfo[],
    excludeNode?: NodeId,
  ): NodeId {
    // Handle custom selector function
    if (typeof selector === 'function') {
      return this.selectWithCustomFunction(
        selector,
        childId,
        localNodeId,
        connectedNodes,
        excludeNode,
      );
    }

    // Handle specific node selector
    if (typeof selector === 'object' && 'node' in selector) {
      return selectSpecificNode(
        selector.node,
        connectedNodes,
        localNodeId,
        childId,
        excludeNode,
      );
    }

    // Handle built-in strategy
    return this.selectWithBuiltinStrategy(
      selector,
      childId,
      localNodeId,
      connectedNodes,
      excludeNode,
    );
  },

  /**
   * Selects a node using a built-in strategy.
   *
   * @internal
   */
  selectWithBuiltinStrategy(
    strategy: NodeSelectorType,
    childId: string,
    localNodeId: NodeId,
    connectedNodes: readonly NodeInfo[],
    excludeNode?: NodeId,
  ): NodeId {
    switch (strategy) {
      case 'local_first':
        return selectLocalFirst(connectedNodes, localNodeId, childId, excludeNode);

      case 'round_robin':
        return selectRoundRobin(connectedNodes, localNodeId, childId, excludeNode);

      case 'least_loaded':
        return selectLeastLoaded(connectedNodes, localNodeId, childId, excludeNode);

      case 'random':
        return selectRandom(connectedNodes, localNodeId, childId, excludeNode);

      default: {
        // Exhaustive check - TypeScript will error if a case is missing
        const _exhaustive: never = strategy;
        throw new NoAvailableNodeError(childId, _exhaustive);
      }
    }
  },

  /**
   * Selects a node using a custom selector function.
   *
   * Prepares the node list for the custom function, filtering out
   * excluded nodes and including the local node.
   *
   * @internal
   */
  selectWithCustomFunction(
    selectorFn: (nodes: readonly NodeInfo[], childId: string) => NodeId,
    childId: string,
    localNodeId: NodeId,
    connectedNodes: readonly NodeInfo[],
    excludeNode?: NodeId,
  ): NodeId {
    // Build node list including local node for custom function
    const allNodes: NodeInfo[] = [];

    // Add local node info
    if (excludeNode !== localNodeId) {
      allNodes.push({
        id: localNodeId,
        host: '127.0.0.1',
        port: 0,
        status: 'connected',
        processCount: 0,
        lastHeartbeatAt: Date.now(),
        uptimeMs: 0,
      });
    }

    // Add remote nodes (excluding the excluded one)
    for (const node of connectedNodes) {
      if (node.id !== excludeNode && node.status === 'connected') {
        allNodes.push(node);
      }
    }

    // Let the custom function select (it can throw NoAvailableNodeError)
    return selectorFn(allNodes, childId);
  },

  /**
   * Resets the round-robin counter.
   *
   * Useful for testing to ensure deterministic behavior.
   *
   * @internal
   */
  _resetRoundRobinCounter(): void {
    roundRobinCounter = 0;
  },

  /**
   * Gets the current round-robin counter value.
   *
   * @internal
   */
  _getRoundRobinCounter(): number {
    return roundRobinCounter;
  },
} as const;
