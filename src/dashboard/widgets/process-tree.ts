/**
 * Process Tree Widget for visualizing the supervision hierarchy.
 *
 * Displays a hierarchical tree of supervisors and GenServers with:
 * - Color-coded status indicators
 * - Collapsible nodes (future enhancement)
 * - Navigation support via keyboard
 */

import * as blessed from 'blessed';
import contrib from 'blessed-contrib';
import type { ProcessTreeNode, GenServerStats, SupervisorStats } from '../../core/types.js';
import { BaseWidget, type GridPosition, type WidgetConfig } from './types.js';
import { TreeChars } from '../utils/formatters.js';

/**
 * Data structure for the process tree widget.
 */
export interface ProcessTreeData {
  readonly tree: readonly ProcessTreeNode[];
}

/**
 * Widget that visualizes the supervision tree hierarchy.
 *
 * Renders a tree structure showing supervisors and their children,
 * with visual indicators for process status and type.
 *
 * @example
 * ```
 * \u25BC supervisor:main
 *   \u251C\u2500 \u25CF counter (running)
 *   \u251C\u2500 \u25CF cache (running)
 *   \u2514\u2500 \u25CB worker (stopped)
 * ```
 */
export class ProcessTreeWidget extends BaseWidget<ProcessTreeData> {
  private boxElement: blessed.Widgets.BoxElement | null = null;

  constructor(config: WidgetConfig) {
    super(config);
  }

  create(
    grid: InstanceType<typeof contrib.grid>,
    position: GridPosition,
  ): blessed.Widgets.BlessedElement {
    this.boxElement = grid.set(
      position.row,
      position.col,
      position.rowSpan,
      position.colSpan,
      blessed.box,
      {
        label: ' Process Tree ',
        tags: true,
        border: this.getBorderStyle(),
        style: {
          border: { fg: this.theme.primary },
          label: this.getLabelStyle(),
        },
        scrollable: true,
        scrollbar: {
          ch: ' ',
          style: { bg: this.theme.primary },
        },
        mouse: true,
        keys: true,
        vi: true,
      },
    );

    this.element = this.boxElement as blessed.Widgets.BlessedElement;
    return this.boxElement as blessed.Widgets.BlessedElement;
  }

  update(data: ProcessTreeData): void {
    if (!this.boxElement) return;

    const { tree } = data;
    const lines = this.renderTree(tree);
    const content = lines.length > 0
      ? lines.join('\n')
      : `{${this.theme.textMuted}-fg}No processes running{/${this.theme.textMuted}-fg}`;

    this.boxElement.setContent(content);
  }

  /**
   * Renders the entire tree to formatted lines.
   */
  private renderTree(nodes: readonly ProcessTreeNode[]): string[] {
    return this.renderNodes(nodes, '', true);
  }

  /**
   * Recursively renders tree nodes with proper indentation and connectors.
   */
  private renderNodes(
    nodes: readonly ProcessTreeNode[],
    prefix: string,
    isRoot: boolean,
  ): string[] {
    const lines: string[] = [];
    const nodeCount = nodes.length;

    for (let i = 0; i < nodeCount; i++) {
      const node = nodes[i]!;
      const isLast = i === nodeCount - 1;

      const line = this.renderNode(node, prefix, isRoot, isLast);
      lines.push(line);

      if (node.children && node.children.length > 0) {
        const childPrefix = this.getChildPrefix(prefix, isRoot, isLast);
        const childLines = this.renderNodes(node.children, childPrefix, false);
        lines.push(...childLines);
      }
    }

    return lines;
  }

  /**
   * Renders a single tree node.
   */
  private renderNode(
    node: ProcessTreeNode,
    prefix: string,
    isRoot: boolean,
    isLast: boolean,
  ): string {
    const connector = this.getConnector(isRoot, isLast);
    const icon = this.getNodeIcon(node);
    const statusColor = this.getStatusColor(node);
    const displayName = node.name ?? node.id;
    const statusText = this.getStatusText(node);

    return (
      `${prefix}${connector}` +
      `{${statusColor}-fg}${icon}{/${statusColor}-fg} ` +
      `${displayName} ` +
      `{${this.theme.textMuted}-fg}(${statusText}){/${this.theme.textMuted}-fg}`
    );
  }

  /**
   * Gets the tree connector characters based on position.
   */
  private getConnector(isRoot: boolean, isLast: boolean): string {
    if (isRoot) return '';
    return isLast
      ? `${TreeChars.LAST_BRANCH}${TreeChars.HORIZONTAL} `
      : `${TreeChars.BRANCH}${TreeChars.HORIZONTAL} `;
  }

  /**
   * Gets the prefix for child nodes.
   */
  private getChildPrefix(prefix: string, isRoot: boolean, isLast: boolean): string {
    if (isRoot) return '';
    return prefix + (isLast ? '   ' : `${TreeChars.VERTICAL}  `);
  }

  /**
   * Gets the icon for a node based on its type.
   */
  private getNodeIcon(node: ProcessTreeNode): string {
    if (node.type === 'supervisor') {
      return TreeChars.DOWN_ARROW;
    }

    const stats = node.stats as GenServerStats;
    return stats.status === 'running' || stats.status === 'initializing'
      ? TreeChars.FILLED_CIRCLE
      : TreeChars.HOLLOW_CIRCLE;
  }

  /**
   * Gets the color for a node based on its status.
   */
  private getStatusColor(node: ProcessTreeNode): string {
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
   * Gets human-readable status text for a node.
   */
  private getStatusText(node: ProcessTreeNode): string {
    if (node.type === 'supervisor') {
      const stats = node.stats as SupervisorStats;
      return `${stats.childCount} children, ${stats.totalRestarts} restarts`;
    }

    const stats = node.stats as GenServerStats;
    return stats.status;
  }
}
