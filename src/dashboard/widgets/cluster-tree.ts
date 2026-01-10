/**
 * Cluster Tree Widget for visualizing processes across cluster nodes.
 *
 * Displays a hierarchical tree with nodes at the top level and their
 * local process trees as children. Each node shows connection status
 * and aggregated statistics.
 */

import blessed from 'blessed';
import contrib from 'blessed-contrib';
import type { ProcessTreeNode, GenServerStats, SupervisorStats } from '../../core/types.js';
import type { ClusterObserverSnapshot, NodeObserverSnapshot } from '../../observer/types.js';
import { BaseWidget, type GridPosition, type WidgetConfig } from './types.js';
import { TreeChars } from '../utils/formatters.js';

/**
 * Data structure for the cluster tree widget.
 */
export interface ClusterTreeData {
  readonly clusterSnapshot: ClusterObserverSnapshot;
}

/**
 * Entry in the line-to-node mapping for selection tracking.
 */
interface TreeLineEntry {
  readonly nodeId: string;
  readonly processNode: ProcessTreeNode | null;
  readonly displayLine: string;
}

/**
 * Widget that visualizes the cluster-wide process tree.
 *
 * Renders a hierarchical structure with cluster nodes at the root level
 * and their local process trees as children. Supports keyboard navigation
 * and selection.
 *
 * @example
 * ```
 * ● nodeA@127.0.0.1:4369 (local) - 4 processes
 *   ├─ ▼ supervisor:main
 *   │  ├─ ● counter (running)
 *   │  └─ ● cache (running)
 *   └─ ● worker (running)
 * ○ nodeB@127.0.0.1:4370 - timeout
 * ● nodeC@127.0.0.1:4371 - 3 processes
 *   └─ ...
 * ```
 */
export class ClusterTreeWidget extends BaseWidget<ClusterTreeData> {
  private listElement: blessed.Widgets.ListElement | null = null;
  private lineMapping: TreeLineEntry[] = [];

  constructor(config: WidgetConfig) {
    super(config);
  }

  create(
    grid: InstanceType<typeof contrib.grid>,
    position: GridPosition,
  ): blessed.Widgets.BlessedElement {
    this.listElement = grid.set(
      position.row,
      position.col,
      position.rowSpan,
      position.colSpan,
      blessed.list,
      {
        label: ' Cluster Tree ',
        tags: true,
        border: this.getBorderStyle(),
        style: {
          border: { fg: this.theme.primary },
          label: this.getLabelStyle(),
          focus: { border: { fg: this.theme.warning } },
          selected: {
            bg: this.theme.primary,
            fg: this.theme.background,
          },
          item: {
            fg: this.theme.text,
          },
        },
        scrollable: true,
        scrollbar: {
          ch: ' ',
          style: { bg: this.theme.primary },
        },
        mouse: true,
        keys: true,
        vi: true,
        focusable: true,
        interactive: true,
      },
    );

    this.element = this.listElement as blessed.Widgets.BlessedElement;
    return this.listElement as blessed.Widgets.BlessedElement;
  }

  update(data: ClusterTreeData): void {
    if (!this.listElement) return;

    const { clusterSnapshot } = data;
    this.lineMapping = [];
    const lines = this.renderClusterTree(clusterSnapshot);

    if (lines.length === 0) {
      this.listElement.setItems([
        `{${this.theme.textMuted}-fg}No cluster data available{/${this.theme.textMuted}-fg}`,
      ]);
      this.lineMapping = [];
    } else {
      this.listElement.setItems(lines);
    }
  }

  /**
   * Gets the currently selected node ID (cluster node, not process).
   */
  getSelectedNodeId(): string | null {
    if (!this.listElement || this.lineMapping.length === 0) return null;

    const selectedIndex = (this.listElement as unknown as { selected?: number }).selected;
    if (selectedIndex === undefined || selectedIndex < 0) return null;
    if (selectedIndex >= this.lineMapping.length) return null;

    const entry = this.lineMapping[selectedIndex];
    return entry ? entry.nodeId : null;
  }

  /**
   * Gets the currently selected process node (if a process is selected).
   */
  getSelectedProcessNode(): ProcessTreeNode | null {
    if (!this.listElement || this.lineMapping.length === 0) return null;

    const selectedIndex = (this.listElement as unknown as { selected?: number }).selected;
    if (selectedIndex === undefined || selectedIndex < 0) return null;
    if (selectedIndex >= this.lineMapping.length) return null;

    const entry = this.lineMapping[selectedIndex];
    return entry ? entry.processNode : null;
  }

  /**
   * Renders the complete cluster tree.
   */
  private renderClusterTree(snapshot: ClusterObserverSnapshot): string[] {
    const { nodes, localNodeId } = snapshot;
    const entries: TreeLineEntry[] = [];
    const nodeCount = nodes.length;

    for (let i = 0; i < nodeCount; i++) {
      const node = nodes[i]!;
      const isLast = i === nodeCount - 1;
      const isLocal = node.nodeId === localNodeId;

      // Render node header
      const headerLine = this.renderNodeHeader(node, isLocal);
      entries.push({
        nodeId: node.nodeId,
        processNode: null,
        displayLine: headerLine,
      });
      this.lineMapping.push(entries[entries.length - 1]!);

      // Render process tree if node is connected
      if (node.status === 'connected' && node.snapshot !== null) {
        const processEntries = this.renderProcessTree(
          node.nodeId,
          node.snapshot.tree,
          isLast,
        );
        entries.push(...processEntries);
      }
    }

    return entries.map(e => e.displayLine);
  }

  /**
   * Renders a cluster node header line.
   */
  private renderNodeHeader(node: NodeObserverSnapshot, isLocal: boolean): string {
    const statusIcon = this.getNodeStatusIcon(node.status);
    const statusColor = this.getNodeStatusColor(node.status);
    const localMarker = isLocal ? ' (local)' : '';

    let statusText: string;
    if (node.status === 'connected' && node.snapshot !== null) {
      statusText = `${node.snapshot.processCount} processes`;
    } else if (node.error) {
      statusText = node.error;
    } else {
      statusText = node.status;
    }

    return (
      `{${statusColor}-fg}${statusIcon}{/${statusColor}-fg} ` +
      `{bold}${node.nodeId}{/bold}` +
      `{${this.theme.secondary}-fg}${localMarker}{/${this.theme.secondary}-fg}` +
      ` {${this.theme.textMuted}-fg}- ${statusText}{/${this.theme.textMuted}-fg}`
    );
  }

  /**
   * Renders a node's process tree.
   */
  private renderProcessTree(
    nodeId: string,
    tree: readonly ProcessTreeNode[],
    isLastNode: boolean,
  ): TreeLineEntry[] {
    const entries: TreeLineEntry[] = [];
    const prefix = isLastNode ? '  ' : `${TreeChars.VERTICAL} `;

    this.renderProcessNodes(nodeId, tree, prefix, true, entries);

    return entries;
  }

  /**
   * Recursively renders process nodes.
   */
  private renderProcessNodes(
    nodeId: string,
    nodes: readonly ProcessTreeNode[],
    prefix: string,
    isRoot: boolean,
    entries: TreeLineEntry[],
  ): void {
    const nodeCount = nodes.length;

    for (let i = 0; i < nodeCount; i++) {
      const node = nodes[i]!;
      const isLast = i === nodeCount - 1;

      const line = this.renderProcessNode(node, prefix, isRoot, isLast);
      const entry: TreeLineEntry = {
        nodeId,
        processNode: node,
        displayLine: line,
      };
      entries.push(entry);
      this.lineMapping.push(entry);

      if (node.children && node.children.length > 0) {
        const childPrefix = this.getChildPrefix(prefix, isRoot, isLast);
        this.renderProcessNodes(nodeId, node.children, childPrefix, false, entries);
      }
    }
  }

  /**
   * Renders a single process node.
   */
  private renderProcessNode(
    node: ProcessTreeNode,
    prefix: string,
    isRoot: boolean,
    isLast: boolean,
  ): string {
    const connector = this.getConnector(isRoot, isLast);
    const icon = this.getProcessIcon(node);
    const statusColor = this.getProcessStatusColor(node);
    const displayName = node.name ?? node.id;
    const statusText = this.getProcessStatusText(node);

    return (
      `${prefix}${connector}` +
      `{${statusColor}-fg}${icon}{/${statusColor}-fg} ` +
      `${displayName} ` +
      `{${this.theme.textMuted}-fg}(${statusText}){/${this.theme.textMuted}-fg}`
    );
  }

  /**
   * Gets tree connector based on position.
   */
  private getConnector(isRoot: boolean, isLast: boolean): string {
    if (isRoot) {
      return isLast
        ? `${TreeChars.LAST_BRANCH}${TreeChars.HORIZONTAL} `
        : `${TreeChars.BRANCH}${TreeChars.HORIZONTAL} `;
    }
    return isLast
      ? `${TreeChars.LAST_BRANCH}${TreeChars.HORIZONTAL} `
      : `${TreeChars.BRANCH}${TreeChars.HORIZONTAL} `;
  }

  /**
   * Gets child node prefix.
   */
  private getChildPrefix(prefix: string, isRoot: boolean, isLast: boolean): string {
    if (isRoot) {
      return prefix + (isLast ? '   ' : `${TreeChars.VERTICAL}  `);
    }
    return prefix + (isLast ? '   ' : `${TreeChars.VERTICAL}  `);
  }

  /**
   * Gets status icon for a cluster node.
   */
  private getNodeStatusIcon(status: NodeObserverSnapshot['status']): string {
    switch (status) {
      case 'connected':
        return TreeChars.FILLED_CIRCLE;
      case 'disconnected':
      case 'timeout':
      case 'error':
        return TreeChars.HOLLOW_CIRCLE;
    }
  }

  /**
   * Gets status color for a cluster node.
   */
  private getNodeStatusColor(status: NodeObserverSnapshot['status']): string {
    switch (status) {
      case 'connected':
        return this.theme.success;
      case 'timeout':
        return this.theme.warning;
      case 'disconnected':
      case 'error':
        return this.theme.error;
    }
  }

  /**
   * Gets icon for a process node.
   */
  private getProcessIcon(node: ProcessTreeNode): string {
    if (node.type === 'supervisor') {
      return TreeChars.DOWN_ARROW;
    }

    const stats = node.stats as GenServerStats;
    return stats.status === 'running' || stats.status === 'initializing'
      ? TreeChars.FILLED_CIRCLE
      : TreeChars.HOLLOW_CIRCLE;
  }

  /**
   * Gets status color for a process node.
   */
  private getProcessStatusColor(node: ProcessTreeNode): string {
    if (node.type === 'supervisor') {
      return this.theme.secondary;
    }

    const stats = node.stats as GenServerStats;
    switch (stats.status) {
      case 'running':
        return this.theme.success;
      case 'initializing':
        return this.theme.warning;
      case 'stopping':
      case 'stopped':
        return this.theme.error;
      default:
        return this.theme.textMuted;
    }
  }

  /**
   * Gets status text for a process node.
   */
  private getProcessStatusText(node: ProcessTreeNode): string {
    if (node.type === 'supervisor') {
      const stats = node.stats as SupervisorStats;
      return `${stats.childCount} children`;
    }

    const stats = node.stats as GenServerStats;
    return stats.status;
  }
}
