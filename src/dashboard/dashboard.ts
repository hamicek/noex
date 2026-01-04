/**
 * Main Dashboard class for TUI-based process monitoring.
 *
 * Provides an interactive terminal interface for monitoring noex processes,
 * displaying the supervision tree, statistics, and real-time events.
 *
 * The dashboard integrates with the Observer module to receive real-time
 * updates about GenServers and Supervisors.
 */

import * as blessed from 'blessed';
import contrib from 'blessed-contrib';
import { Observer } from '../observer/index.js';
import type { ObserverSnapshot } from '../observer/types.js';
import type { ObserverEvent, ProcessTreeNode, GenServerStats } from '../core/types.js';
import { formatBytes } from '../observer/memory-utils.js';
import {
  type DashboardConfig,
  type DashboardOptions,
  type DashboardTheme,
  type EventLogEntry,
  DEFAULT_CONFIG,
  getTheme,
} from './types.js';

/**
 * Dashboard state enum for lifecycle management.
 */
type DashboardState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

/**
 * Interactive TUI dashboard for monitoring noex processes.
 *
 * @example
 * ```typescript
 * import { Dashboard } from 'noex/dashboard';
 *
 * const dashboard = new Dashboard({
 *   refreshInterval: 500,
 *   theme: 'dark',
 *   layout: 'full',
 * });
 *
 * dashboard.start();
 * ```
 */
export class Dashboard {
  private readonly config: DashboardConfig;
  private readonly theme: DashboardTheme;

  private state: DashboardState = 'idle';
  private screen: blessed.Widgets.Screen | null = null;
  private grid: InstanceType<typeof contrib.grid> | null = null;

  // Widgets
  private processTree: blessed.Widgets.BoxElement | null = null;
  private statsTable: ReturnType<typeof contrib.table> | null = null;
  private memoryGauge: ReturnType<typeof contrib.gauge> | null = null;
  private eventLog: ReturnType<typeof contrib.log> | null = null;
  private statusBar: blessed.Widgets.BoxElement | null = null;

  // Data
  private eventLogEntries: EventLogEntry[] = [];
  private startTime: number = 0;

  // Subscriptions
  private observerUnsubscribe: (() => void) | null = null;
  private pollingUnsubscribe: (() => void) | null = null;

  /**
   * Creates a new Dashboard instance.
   *
   * @param options - Configuration options
   */
  constructor(options: DashboardOptions = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options };
    this.theme = getTheme(this.config.theme);
  }

  /**
   * Starts the dashboard and begins rendering.
   *
   * Creates the terminal screen, sets up widgets, and begins
   * polling for updates from the Observer.
   *
   * @throws Error if dashboard is already running
   */
  start(): void {
    if (this.state === 'running' || this.state === 'starting') {
      throw new Error('Dashboard is already running');
    }

    this.state = 'starting';
    this.startTime = Date.now();

    this.initializeScreen();
    this.createLayout();
    this.setupKeyboardHandlers();
    this.subscribeToEvents();
    this.startPolling();

    this.state = 'running';
    this.render();
  }

  /**
   * Stops the dashboard and cleans up resources.
   *
   * Unsubscribes from events, stops polling, and destroys
   * the terminal screen.
   */
  stop(): void {
    if (this.state !== 'running') {
      return;
    }

    this.state = 'stopping';

    // Cleanup subscriptions
    if (this.pollingUnsubscribe) {
      this.pollingUnsubscribe();
      this.pollingUnsubscribe = null;
    }

    if (this.observerUnsubscribe) {
      this.observerUnsubscribe();
      this.observerUnsubscribe = null;
    }

    // Destroy screen
    if (this.screen) {
      this.screen.destroy();
      this.screen = null;
    }

    // Clear references
    this.grid = null;
    this.processTree = null;
    this.statsTable = null;
    this.memoryGauge = null;
    this.eventLog = null;
    this.statusBar = null;
    this.eventLogEntries = [];

    this.state = 'stopped';
  }

  /**
   * Forces an immediate refresh of all widgets.
   */
  refresh(): void {
    if (this.state !== 'running') {
      return;
    }

    const snapshot = Observer.getSnapshot();
    this.updateWidgets(snapshot);
    this.render();
  }

  /**
   * Returns whether the dashboard is currently running.
   */
  isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * Initializes the blessed screen with proper configuration.
   */
  private initializeScreen(): void {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'noex Dashboard',
      fullUnicode: true,
      autoPadding: true,
      warnings: false,
    });
  }

  /**
   * Creates the grid layout and all widgets.
   */
  private createLayout(): void {
    if (!this.screen) return;

    // Create a 12x12 grid for flexible layout
    this.grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen,
    });

    this.createProcessTreeWidget();
    this.createStatsTableWidget();
    this.createMemoryGaugeWidget();
    this.createEventLogWidget();
    this.createStatusBar();
  }

  /**
   * Creates the process tree widget for visualizing supervision hierarchy.
   */
  private createProcessTreeWidget(): void {
    if (!this.grid) return;

    // Use a box with custom rendering for the tree
    this.processTree = this.grid.set(0, 0, 6, 4, blessed.box, {
      label: ' Process Tree ',
      tags: true,
      border: { type: 'line' },
      style: {
        border: { fg: this.theme.primary },
        label: { fg: this.theme.primary },
      },
      scrollable: true,
      scrollbar: {
        ch: ' ',
        style: { bg: this.theme.primary },
      },
      mouse: true,
      keys: true,
      vi: true,
    });
  }

  /**
   * Creates the stats table widget for displaying GenServer statistics.
   */
  private createStatsTableWidget(): void {
    if (!this.grid) return;

    this.statsTable = this.grid.set(0, 4, 6, 8, contrib.table, {
      keys: true,
      fg: this.theme.text,
      selectedFg: this.theme.background,
      selectedBg: this.theme.primary,
      interactive: true,
      label: ' Process Statistics ',
      border: { type: 'line', fg: this.theme.primary },
      columnSpacing: 2,
      columnWidth: [24, 12, 8, 10, 12, 10],
    });
  }

  /**
   * Creates the memory gauge widget.
   */
  private createMemoryGaugeWidget(): void {
    if (!this.grid) return;

    this.memoryGauge = this.grid.set(6, 0, 2, 4, contrib.gauge, {
      label: ' Heap Memory ',
      stroke: this.theme.success,
      fill: this.theme.background,
      border: { type: 'line', fg: this.theme.primary },
    });
  }

  /**
   * Creates the event log widget for displaying recent events.
   */
  private createEventLogWidget(): void {
    if (!this.grid) return;

    this.eventLog = this.grid.set(6, 4, 5, 8, contrib.log, {
      label: ' Event Log ',
      fg: this.theme.text,
      selectedFg: this.theme.background,
      border: { type: 'line', fg: this.theme.primary },
      bufferLength: this.config.maxEventLogSize,
    });
  }

  /**
   * Creates the status bar at the bottom of the screen.
   */
  private createStatusBar(): void {
    if (!this.grid) return;

    this.statusBar = this.grid.set(11, 0, 1, 12, blessed.box, {
      tags: true,
      style: {
        fg: this.theme.textMuted,
        bg: this.theme.background,
      },
    });
  }

  /**
   * Sets up keyboard event handlers for navigation and commands.
   */
  private setupKeyboardHandlers(): void {
    if (!this.screen) return;

    // Quit
    this.screen.key(['escape', 'q', 'C-c'], () => {
      this.stop();
      // eslint-disable-next-line n/no-process-exit
      process.exit(0);
    });

    // Refresh
    this.screen.key(['r'], () => {
      this.refresh();
      this.logEvent('info', 'Manual refresh triggered');
    });

    // Help
    this.screen.key(['?', 'h'], () => {
      this.showHelp();
    });

    // Tab navigation between widgets
    this.screen.key(['tab'], () => {
      if (!this.screen) return;
      this.screen.focusNext();
      this.render();
    });

    this.screen.key(['S-tab'], () => {
      if (!this.screen) return;
      this.screen.focusPrevious();
      this.render();
    });
  }

  /**
   * Subscribes to Observer events for real-time updates.
   */
  private subscribeToEvents(): void {
    this.observerUnsubscribe = Observer.subscribe((event) => {
      this.handleObserverEvent(event);
    });
  }

  /**
   * Starts the polling loop for periodic updates.
   */
  private startPolling(): void {
    this.pollingUnsubscribe = Observer.startPolling(
      this.config.refreshInterval,
      (event) => {
        if (event.type === 'stats_update') {
          const snapshot = Observer.getSnapshot();
          this.updateWidgets(snapshot);
          this.render();
        }
      },
    );
  }

  /**
   * Handles incoming Observer events.
   */
  private handleObserverEvent(event: ObserverEvent): void {
    switch (event.type) {
      case 'server_started':
        this.logEvent('success', `GenServer started: ${event.stats.id}`);
        break;
      case 'server_stopped':
        this.logEvent(
          event.reason === 'normal' ? 'info' : 'warning',
          `GenServer stopped: ${event.id} (${this.formatReason(event.reason)})`,
        );
        break;
      case 'supervisor_started':
        this.logEvent('success', `Supervisor started: ${event.stats.id}`);
        break;
      case 'supervisor_stopped':
        this.logEvent('info', `Supervisor stopped: ${event.id}`);
        break;
    }

    this.render();
  }

  /**
   * Formats a terminate reason for display.
   */
  private formatReason(reason: 'normal' | 'shutdown' | { error: Error }): string {
    if (reason === 'normal') return 'normal';
    if (reason === 'shutdown') return 'shutdown';
    return `error: ${reason.error.message}`;
  }

  /**
   * Updates all widgets with fresh data.
   */
  private updateWidgets(snapshot: ObserverSnapshot): void {
    this.updateProcessTree(snapshot.tree);
    this.updateStatsTable(snapshot.servers);
    this.updateMemoryGauge(snapshot.memoryStats);
    this.updateStatusBar(snapshot);
  }

  /**
   * Updates the process tree widget.
   */
  private updateProcessTree(tree: readonly ProcessTreeNode[]): void {
    if (!this.processTree) return;

    const lines = this.renderTreeToLines(tree, '', true);
    const content = lines.length > 0 ? lines.join('\n') : '{gray-fg}No processes running{/gray-fg}';

    this.processTree.setContent(content);
  }

  /**
   * Recursively renders the process tree to formatted lines.
   */
  private renderTreeToLines(
    nodes: readonly ProcessTreeNode[],
    prefix: string,
    isRoot: boolean,
  ): string[] {
    const lines: string[] = [];

    for (const [i, node] of nodes.entries()) {
      const isLast = i === nodes.length - 1;
      const connector = isRoot ? '' : isLast ? '\\u2514\\u2500 ' : '\\u251C\\u2500 ';
      const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '\\u2502  ');

      const statusColor = this.getStatusColor(node);
      const icon = node.type === 'supervisor' ? '\\u25BC' : '\\u25CF';
      const name = node.name ?? node.id;
      const status = this.getNodeStatus(node);

      lines.push(`${prefix}${connector}{${statusColor}-fg}${icon}{/${statusColor}-fg} ${name} {${this.theme.textMuted}-fg}(${status}){/${this.theme.textMuted}-fg}`);

      if (node.children && node.children.length > 0) {
        const childLines = this.renderTreeToLines(node.children, childPrefix, false);
        lines.push(...childLines);
      }
    }

    return lines;
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
   * Gets a human-readable status string for a node.
   */
  private getNodeStatus(node: ProcessTreeNode): string {
    if (node.type === 'supervisor') {
      const stats = node.stats as { childCount: number; totalRestarts: number };
      return `${stats.childCount} children, ${stats.totalRestarts} restarts`;
    }

    const stats = node.stats as GenServerStats;
    return stats.status;
  }

  /**
   * Updates the stats table widget.
   */
  private updateStatsTable(servers: readonly GenServerStats[]): void {
    if (!this.statsTable) return;

    const headers = ['ID', 'Status', 'Queue', 'Messages', 'Uptime', 'Memory'];
    const rows = servers.map((s) => [
      this.truncate(s.id, 22),
      s.status,
      String(s.queueSize),
      this.formatNumber(s.messageCount),
      this.formatUptime(s.uptimeMs),
      s.stateMemoryBytes !== undefined ? formatBytes(s.stateMemoryBytes) : '-',
    ]);

    this.statsTable.setData({
      headers,
      data: rows.length > 0 ? rows : [['No processes', '-', '-', '-', '-', '-']],
    });
  }

  /**
   * Updates the memory gauge widget.
   */
  private updateMemoryGauge(memoryStats: { heapUsed: number; heapTotal: number }): void {
    if (!this.memoryGauge) return;

    const percent = Math.round((memoryStats.heapUsed / memoryStats.heapTotal) * 100);

    // Update color based on usage level
    let strokeColor: string;
    if (percent >= 80) {
      strokeColor = this.theme.error;
    } else if (percent >= 60) {
      strokeColor = this.theme.warning;
    } else {
      strokeColor = this.theme.success;
    }

    // Update gauge options directly (blessed-contrib types don't expose setOptions)
    (this.memoryGauge.options as { stroke?: string }).stroke = strokeColor;

    this.memoryGauge.setPercent(percent);
    this.memoryGauge.setLabel(
      ` Heap Memory (${formatBytes(memoryStats.heapUsed)} / ${formatBytes(memoryStats.heapTotal)}) `,
    );
  }

  /**
   * Updates the status bar with summary information.
   */
  private updateStatusBar(snapshot: ObserverSnapshot): void {
    if (!this.statusBar) return;

    const uptime = this.formatUptime(Date.now() - this.startTime);
    const processCount = snapshot.processCount;
    const serverCount = snapshot.servers.length;
    const supervisorCount = snapshot.supervisors.length;

    const content =
      `  {${this.theme.textMuted}-fg}[q]uit  [r]efresh  [?]help{/${this.theme.textMuted}-fg}` +
      `{|}` +
      `{${this.theme.textMuted}-fg}Processes: {/${this.theme.textMuted}-fg}${processCount} ` +
      `{${this.theme.textMuted}-fg}({/${this.theme.textMuted}-fg}${serverCount} servers, ${supervisorCount} supervisors{${this.theme.textMuted}-fg}){/${this.theme.textMuted}-fg}  ` +
      `{${this.theme.textMuted}-fg}Uptime:{/${this.theme.textMuted}-fg} ${uptime}  `;

    this.statusBar.setContent(content);
  }

  /**
   * Logs an event to the event log widget.
   */
  private logEvent(severity: EventLogEntry['severity'], message: string): void {
    const entry: EventLogEntry = {
      timestamp: Date.now(),
      type: severity,
      message,
      severity,
    };

    this.eventLogEntries.push(entry);
    if (this.eventLogEntries.length > this.config.maxEventLogSize) {
      this.eventLogEntries.shift();
    }

    if (this.eventLog) {
      const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
      const color = this.getSeverityColor(severity);
      this.eventLog.log(`{${this.theme.textMuted}-fg}${time}{/${this.theme.textMuted}-fg} {${color}-fg}${message}{/${color}-fg}`);
    }
  }

  /**
   * Gets the color for a severity level.
   */
  private getSeverityColor(severity: EventLogEntry['severity']): string {
    switch (severity) {
      case 'success':
        return this.theme.success;
      case 'warning':
        return this.theme.warning;
      case 'error':
        return this.theme.error;
      default:
        return this.theme.text;
    }
  }

  /**
   * Shows a help dialog with keyboard shortcuts.
   */
  private showHelp(): void {
    if (!this.screen) return;

    const helpBox = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 50,
      height: 14,
      label: ' Keyboard Shortcuts ',
      tags: true,
      border: { type: 'line' },
      style: {
        border: { fg: this.theme.primary },
        label: { fg: this.theme.primary },
      },
      content: `
  {${this.theme.primary}-fg}q, Escape, Ctrl+C{/${this.theme.primary}-fg}  Quit dashboard
  {${this.theme.primary}-fg}r{/${this.theme.primary}-fg}                  Refresh data
  {${this.theme.primary}-fg}?, h{/${this.theme.primary}-fg}               Show this help
  {${this.theme.primary}-fg}Tab{/${this.theme.primary}-fg}                Next widget
  {${this.theme.primary}-fg}Shift+Tab{/${this.theme.primary}-fg}          Previous widget
  {${this.theme.primary}-fg}Arrow keys{/${this.theme.primary}-fg}         Navigate within widget

  {${this.theme.textMuted}-fg}Press any key to close{/${this.theme.textMuted}-fg}
`,
    });

    helpBox.focus();

    helpBox.key(['escape', 'q', 'enter', 'space'], () => {
      helpBox.destroy();
      this.render();
    });

    // Close on any key
    helpBox.once('keypress', () => {
      helpBox.destroy();
      this.render();
    });

    this.render();
  }

  /**
   * Renders the screen.
   */
  private render(): void {
    if (this.screen) {
      this.screen.render();
    }
  }

  /**
   * Truncates a string to a maximum length.
   */
  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 1) + '\\u2026';
  }

  /**
   * Formats a number with K/M suffixes.
   */
  private formatNumber(num: number): string {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    }
    if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    }
    return String(num);
  }

  /**
   * Formats uptime in human-readable format.
   */
  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    const h = String(hours).padStart(2, '0');
    const m = String(minutes % 60).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');

    return `${h}:${m}:${s}`;
  }
}
