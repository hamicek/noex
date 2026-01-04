/**
 * Process tree builder for the Observer module.
 *
 * Constructs a hierarchical view of the supervision tree by
 * traversing supervisors and their children, enriching nodes
 * with statistics and registry names.
 */

import type { ProcessTreeNode, GenServerStats, SupervisorStats } from '../core/types.js';
import { GenServer } from '../core/gen-server.js';
import { Supervisor } from '../core/supervisor.js';
import { Registry } from '../core/registry.js';

/**
 * Builds a complete process tree from all running supervisors and standalone servers.
 *
 * The tree includes:
 * - All supervisors as parent nodes
 * - Their children (GenServers) as leaf nodes
 * - Standalone GenServers (not under any supervisor) at the root level
 *
 * @returns Array of root-level process tree nodes
 */
export function buildProcessTree(): readonly ProcessTreeNode[] {
  const supervisorIds = Supervisor._getAllSupervisorIds();
  const allServerIds = new Set(GenServer._getAllServerIds());
  const supervisedServerIds = new Set<string>();

  // Build supervisor nodes with their children
  const supervisorNodes: ProcessTreeNode[] = [];

  for (const supId of supervisorIds) {
    const supRef = Supervisor._getRefById(supId);
    if (!supRef) continue;

    const supStats = Supervisor._getStats(supRef);
    if (!supStats) continue;

    const children = Supervisor.getChildren(supRef);
    const childNodes: ProcessTreeNode[] = [];

    for (const child of children) {
      supervisedServerIds.add(child.ref.id);

      const serverStats = GenServer._getStats(child.ref);
      if (!serverStats) continue;

      const childName = Registry._getNameById(child.ref.id) ?? child.id;
      childNodes.push({
        type: 'genserver',
        id: child.ref.id,
        name: childName,
        stats: serverStats,
      });
    }

    const supName = Registry._getNameById(supId);
    const supervisorNode: ProcessTreeNode = {
      type: 'supervisor',
      id: supId,
      stats: supStats,
      children: childNodes,
    };

    // Only add name if it exists
    if (supName !== undefined) {
      supervisorNodes.push({ ...supervisorNode, name: supName });
    } else {
      supervisorNodes.push(supervisorNode);
    }
  }

  // Find standalone servers (not under any supervisor)
  const standaloneNodes: ProcessTreeNode[] = [];

  for (const serverId of allServerIds) {
    if (supervisedServerIds.has(serverId)) continue;

    const stats = findServerStatsById(serverId);
    if (!stats) continue;

    const serverName = Registry._getNameById(serverId);
    const serverNode: ProcessTreeNode = {
      type: 'genserver',
      id: serverId,
      stats,
    };

    // Only add name if it exists
    if (serverName !== undefined) {
      standaloneNodes.push({ ...serverNode, name: serverName });
    } else {
      standaloneNodes.push(serverNode);
    }
  }

  // Return supervisors first, then standalone servers
  return [...supervisorNodes, ...standaloneNodes];
}

/**
 * Builds a flat map of server ID to its parent supervisor ID.
 * Used for quick lookup of supervision relationships.
 *
 * @returns Map from server ID to supervisor ID
 */
export function buildParentMap(): ReadonlyMap<string, string> {
  const parentMap = new Map<string, string>();
  const supervisorIds = Supervisor._getAllSupervisorIds();

  for (const supId of supervisorIds) {
    const supRef = Supervisor._getRefById(supId);
    if (!supRef) continue;

    const children = Supervisor.getChildren(supRef);
    for (const child of children) {
      parentMap.set(child.ref.id, supId);
    }
  }

  return parentMap;
}

/**
 * Counts total nodes in a process tree.
 *
 * @param tree - The process tree to count
 * @returns Total number of nodes (supervisors + servers)
 */
export function countTreeNodes(tree: readonly ProcessTreeNode[]): number {
  let count = 0;

  for (const node of tree) {
    count++;
    if (node.children) {
      count += countTreeNodes(node.children);
    }
  }

  return count;
}

/**
 * Finds a specific node in the tree by ID.
 *
 * @param tree - The process tree to search
 * @param id - The ID to find
 * @returns The matching node or undefined
 */
export function findNodeById(
  tree: readonly ProcessTreeNode[],
  id: string,
): ProcessTreeNode | undefined {
  for (const node of tree) {
    if (node.id === id) {
      return node;
    }
    if (node.children) {
      const found = findNodeById(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Helper to find server stats by ID.
 * Constructs a temporary ref for the lookup.
 */
function findServerStatsById(serverId: string): GenServerStats | undefined {
  // Create a minimal ref for the lookup
  const ref = { id: serverId } as import('../core/types.js').GenServerRef;
  return GenServer._getStats(ref);
}
