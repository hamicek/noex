/**
 * Process Detail Widget for displaying detailed process information.
 *
 * Shows a modal dialog with comprehensive information about a selected
 * GenServer or Supervisor, including statistics, memory usage, and
 * restart history.
 */

import blessed from 'blessed';
import type { GenServerStats, SupervisorStats, ProcessTreeNode } from '../../core/types.js';
import { formatBytes } from '../../observer/memory-utils.js';
import type { DashboardTheme } from '../types.js';
import { formatNumber, formatUptime, formatTime } from '../utils/formatters.js';

/**
 * Data for displaying process details.
 */
export interface ProcessDetailData {
  readonly node: ProcessTreeNode;
}

/**
 * Configuration for the process detail dialog.
 */
interface ProcessDetailConfig {
  readonly theme: DashboardTheme;
}

/**
 * Modal dialog that displays detailed information about a process.
 *
 * Supports both GenServer and Supervisor nodes with appropriate
 * statistics for each type.
 */
export class ProcessDetailView {
  private readonly theme: DashboardTheme;
  private dialog: blessed.Widgets.BoxElement | null = null;
  private onClose: (() => void) | null = null;

  constructor(config: ProcessDetailConfig) {
    this.theme = config.theme;
  }

  /**
   * Shows the detail dialog for a process.
   *
   * @param screen - The blessed screen to attach to
   * @param data - Process data to display
   * @param onClose - Callback when dialog is closed
   */
  show(
    screen: blessed.Widgets.Screen,
    data: ProcessDetailData,
    onClose?: () => void,
  ): void {
    if (this.dialog) {
      this.close();
    }

    this.onClose = onClose ?? null;
    const content = this.buildContent(data.node);

    this.dialog = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 60,
      height: 20,
      label: ` ${this.getDialogTitle(data.node)} `,
      tags: true,
      border: { type: 'line' },
      style: {
        border: { fg: this.theme.primary },
        label: { fg: this.theme.primary },
        bg: this.theme.background,
      },
      content,
      padding: { left: 1, right: 1, top: 0, bottom: 0 },
      keys: true,
      vi: true,
    });

    this.setupKeyHandlers(screen);
    this.dialog.focus();
    screen.render();
  }

  /**
   * Closes the detail dialog.
   */
  close(): void {
    if (this.dialog) {
      this.dialog.destroy();
      this.dialog = null;
    }

    if (this.onClose) {
      this.onClose();
      this.onClose = null;
    }
  }

  /**
   * Returns whether the dialog is currently visible.
   */
  isVisible(): boolean {
    return this.dialog !== null;
  }

  /**
   * Gets the dialog title based on process type.
   */
  private getDialogTitle(node: ProcessTreeNode): string {
    const typeLabel = node.type === 'supervisor' ? 'Supervisor' : 'GenServer';
    const displayName = node.name ?? node.id;
    return `${typeLabel}: ${displayName}`;
  }

  /**
   * Builds the content for the detail dialog.
   */
  private buildContent(node: ProcessTreeNode): string {
    if (node.type === 'supervisor') {
      return this.buildSupervisorContent(node);
    }
    return this.buildGenServerContent(node);
  }

  /**
   * Builds content for a GenServer node.
   */
  private buildGenServerContent(node: ProcessTreeNode): string {
    const stats = node.stats as GenServerStats;
    const lines: string[] = [];

    lines.push('');
    lines.push(this.formatSection('Identity'));
    lines.push(this.formatField('ID', stats.id));
    if (node.name) {
      lines.push(this.formatField('Name', node.name));
    }
    lines.push(this.formatField('Status', this.formatStatus(stats.status)));

    lines.push('');
    lines.push(this.formatSection('Statistics'));
    lines.push(this.formatField('Queue Size', this.formatQueueSize(stats.queueSize)));
    lines.push(this.formatField('Messages Processed', formatNumber(stats.messageCount)));
    lines.push(this.formatField('Uptime', formatUptime(stats.uptimeMs)));
    lines.push(this.formatField('Started At', formatTime(stats.startedAt)));

    lines.push('');
    lines.push(this.formatSection('Memory'));
    if (stats.stateMemoryBytes !== undefined) {
      lines.push(this.formatField('State Memory', formatBytes(stats.stateMemoryBytes)));
    } else {
      lines.push(this.formatField('State Memory', this.formatMuted('not available')));
    }

    lines.push('');
    lines.push(this.formatMuted('Press Escape, Enter or q to close'));

    return lines.join('\n');
  }

  /**
   * Builds content for a Supervisor node.
   */
  private buildSupervisorContent(node: ProcessTreeNode): string {
    const stats = node.stats as SupervisorStats;
    const lines: string[] = [];

    lines.push('');
    lines.push(this.formatSection('Identity'));
    lines.push(this.formatField('ID', stats.id));
    if (node.name) {
      lines.push(this.formatField('Name', node.name));
    }

    lines.push('');
    lines.push(this.formatSection('Configuration'));
    lines.push(this.formatField('Strategy', this.formatStrategy(stats.strategy)));
    lines.push(this.formatField('Child Count', String(stats.childCount)));

    lines.push('');
    lines.push(this.formatSection('Statistics'));
    lines.push(this.formatField('Total Restarts', this.formatRestarts(stats.totalRestarts)));
    lines.push(this.formatField('Uptime', formatUptime(stats.uptimeMs)));
    lines.push(this.formatField('Started At', formatTime(stats.startedAt)));

    lines.push('');
    lines.push(this.formatMuted('Press Escape, Enter or q to close'));

    return lines.join('\n');
  }

  /**
   * Formats a section header.
   */
  private formatSection(title: string): string {
    return `{${this.theme.primary}-fg}${title}{/${this.theme.primary}-fg}`;
  }

  /**
   * Formats a field with label and value.
   */
  private formatField(label: string, value: string): string {
    const paddedLabel = label.padEnd(20);
    return `  {${this.theme.textMuted}-fg}${paddedLabel}{/${this.theme.textMuted}-fg}${value}`;
  }

  /**
   * Formats muted text.
   */
  private formatMuted(text: string): string {
    return `{${this.theme.textMuted}-fg}${text}{/${this.theme.textMuted}-fg}`;
  }

  /**
   * Formats status with appropriate color.
   */
  private formatStatus(status: GenServerStats['status']): string {
    const colorMap: Record<GenServerStats['status'], string> = {
      running: this.theme.success,
      initializing: this.theme.warning,
      stopping: this.theme.warning,
      stopped: this.theme.error,
    };

    const color = colorMap[status];
    return `{${color}-fg}${status}{/${color}-fg}`;
  }

  /**
   * Formats queue size with warning color if high.
   */
  private formatQueueSize(size: number): string {
    if (size > 100) {
      return `{${this.theme.error}-fg}${size}{/${this.theme.error}-fg}`;
    }
    if (size > 10) {
      return `{${this.theme.warning}-fg}${size}{/${this.theme.warning}-fg}`;
    }
    return String(size);
  }

  /**
   * Formats supervisor strategy for display.
   */
  private formatStrategy(strategy: SupervisorStats['strategy']): string {
    const strategyNames: Record<SupervisorStats['strategy'], string> = {
      one_for_one: 'One for One',
      one_for_all: 'One for All',
      rest_for_one: 'Rest for One',
      simple_one_for_one: 'Simple One for One',
    };
    return strategyNames[strategy];
  }

  /**
   * Formats restart count with warning color if high.
   */
  private formatRestarts(count: number): string {
    if (count > 5) {
      return `{${this.theme.error}-fg}${count}{/${this.theme.error}-fg}`;
    }
    if (count > 0) {
      return `{${this.theme.warning}-fg}${count}{/${this.theme.warning}-fg}`;
    }
    return String(count);
  }

  /**
   * Sets up keyboard handlers for closing the dialog.
   */
  private setupKeyHandlers(screen: blessed.Widgets.Screen): void {
    if (!this.dialog) return;

    const closeHandler = (): void => {
      this.close();
      screen.render();
    };

    this.dialog.key(['escape', 'q', 'enter'], closeHandler);
  }
}
