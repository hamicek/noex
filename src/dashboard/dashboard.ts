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
import type { ObserverEvent } from '../core/types.js';
import {
  type DashboardConfig,
  type DashboardOptions,
  type DashboardTheme,
  DEFAULT_CONFIG,
  getTheme,
} from './types.js';
import {
  ProcessTreeWidget,
  StatsTableWidget,
  MemoryGaugeWidget,
  EventLogWidget,
  ProcessDetailView,
  type GridPosition,
} from './widgets/index.js';
import type { ProcessTreeNode } from '../core/types.js';
import { formatReason } from './utils/formatters.js';

/**
 * Dashboard state enum for lifecycle management.
 */
type DashboardState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

/**
 * Widget grid positions for the full layout.
 */
const LAYOUT = {
  processTree: { row: 0, col: 0, rowSpan: 6, colSpan: 4 },
  statsTable: { row: 0, col: 4, rowSpan: 6, colSpan: 8 },
  memoryGauge: { row: 6, col: 0, rowSpan: 2, colSpan: 4 },
  eventLog: { row: 6, col: 4, rowSpan: 5, colSpan: 8 },
  statusBar: { row: 11, col: 0, rowSpan: 1, colSpan: 12 },
} as const satisfies Record<string, GridPosition>;

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
  private processTreeWidget: ProcessTreeWidget | null = null;
  private statsTableWidget: StatsTableWidget | null = null;
  private memoryGaugeWidget: MemoryGaugeWidget | null = null;
  private eventLogWidget: EventLogWidget | null = null;
  private statusBar: blessed.Widgets.BoxElement | null = null;

  // Process Detail View
  private processDetailView: ProcessDetailView | null = null;

  // Current snapshot for detail lookups
  private currentSnapshot: ObserverSnapshot | null = null;

  // Timing
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

    // Destroy widgets
    this.destroyWidgets();

    // Destroy screen
    if (this.screen) {
      this.screen.destroy();
      this.screen = null;
    }

    this.grid = null;
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

    this.createWidgets();
  }

  /**
   * Creates all dashboard widgets.
   */
  private createWidgets(): void {
    if (!this.grid) return;

    const widgetConfig = { theme: this.theme };

    // Process Tree
    this.processTreeWidget = new ProcessTreeWidget(widgetConfig);
    this.processTreeWidget.create(this.grid, LAYOUT.processTree);

    // Stats Table
    this.statsTableWidget = new StatsTableWidget(widgetConfig);
    this.statsTableWidget.create(this.grid, LAYOUT.statsTable);

    // Memory Gauge
    this.memoryGaugeWidget = new MemoryGaugeWidget(widgetConfig);
    this.memoryGaugeWidget.create(this.grid, LAYOUT.memoryGauge);

    // Event Log
    this.eventLogWidget = new EventLogWidget({
      theme: this.theme,
      maxEntries: this.config.maxEventLogSize,
    });
    this.eventLogWidget.create(this.grid, LAYOUT.eventLog);

    // Status Bar
    this.createStatusBar();

    // Process Detail View (modal, not part of grid)
    this.processDetailView = new ProcessDetailView({ theme: this.theme });
  }

  /**
   * Creates the status bar at the bottom of the screen.
   */
  private createStatusBar(): void {
    if (!this.grid) return;

    const pos = LAYOUT.statusBar;
    this.statusBar = this.grid.set(pos.row, pos.col, pos.rowSpan, pos.colSpan, blessed.box, {
      tags: true,
      style: {
        fg: this.theme.textMuted,
        bg: this.theme.background,
      },
    });
  }

  /**
   * Destroys all widgets and clears references.
   */
  private destroyWidgets(): void {
    this.processTreeWidget?.destroy();
    this.processTreeWidget = null;

    this.statsTableWidget?.destroy();
    this.statsTableWidget = null;

    this.memoryGaugeWidget?.destroy();
    this.memoryGaugeWidget = null;

    this.eventLogWidget?.destroy();
    this.eventLogWidget = null;

    if (this.processDetailView?.isVisible()) {
      this.processDetailView.close();
    }
    this.processDetailView = null;

    if (this.statusBar) {
      this.statusBar.destroy();
      this.statusBar = null;
    }
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

    // Enter key to show process detail
    this.screen.key(['enter'], () => {
      this.showSelectedProcessDetail();
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
          `GenServer stopped: ${event.id} (${formatReason(event.reason)})`,
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
   * Updates all widgets with fresh data.
   */
  private updateWidgets(snapshot: ObserverSnapshot): void {
    this.currentSnapshot = snapshot;
    this.processTreeWidget?.update({ tree: snapshot.tree });
    this.statsTableWidget?.update({ servers: snapshot.servers });
    this.memoryGaugeWidget?.update({ memoryStats: snapshot.memoryStats });
    this.updateStatusBar(snapshot);
  }

  /**
   * Updates the status bar with summary information.
   */
  private updateStatusBar(snapshot: ObserverSnapshot): void {
    if (!this.statusBar) return;

    const uptime = this.formatUptime(Date.now() - this.startTime);
    const { processCount } = snapshot;
    const serverCount = snapshot.servers.length;
    const supervisorCount = snapshot.supervisors.length;

    const content =
      `  {${this.theme.textMuted}-fg}[q]uit  [r]efresh  [Enter]detail  [?]help{/${this.theme.textMuted}-fg}` +
      `{|}` +
      `{${this.theme.textMuted}-fg}Processes: {/${this.theme.textMuted}-fg}${processCount} ` +
      `{${this.theme.textMuted}-fg}({/${this.theme.textMuted}-fg}${serverCount} servers, ${supervisorCount} supervisors{${this.theme.textMuted}-fg}){/${this.theme.textMuted}-fg}  ` +
      `{${this.theme.textMuted}-fg}Uptime:{/${this.theme.textMuted}-fg} ${uptime}  `;

    this.statusBar.setContent(content);
  }

  /**
   * Logs an event to the event log widget.
   */
  private logEvent(severity: 'info' | 'success' | 'warning' | 'error', message: string): void {
    this.eventLogWidget?.log({ message, severity });
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
      height: 15,
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
  {${this.theme.primary}-fg}Enter{/${this.theme.primary}-fg}              Show process detail
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

  /**
   * Shows the detail view for the currently selected process.
   *
   * Attempts to get the selected process ID from the stats table
   * and displays a modal with detailed information.
   */
  private showSelectedProcessDetail(): void {
    if (!this.screen || !this.processDetailView || !this.currentSnapshot) return;

    // Prevent showing detail if another dialog is open
    if (this.processDetailView.isVisible()) return;

    // Get selected ID from stats table
    const selectedId = this.statsTableWidget?.getSelectedId();
    if (!selectedId) return;

    // Find the process node
    const node = this.findProcessNode(selectedId, this.currentSnapshot.tree);
    if (!node) return;

    // Show detail view
    this.processDetailView.show(this.screen, { node }, () => {
      this.render();
    });
  }

  /**
   * Finds a process node by ID in the tree hierarchy.
   *
   * @param id - Process ID to find
   * @param nodes - Tree nodes to search
   * @returns The matching node or null if not found
   */
  private findProcessNode(
    id: string,
    nodes: readonly ProcessTreeNode[],
  ): ProcessTreeNode | null {
    for (const node of nodes) {
      if (node.id === id) {
        return node;
      }

      if (node.children && node.children.length > 0) {
        const found = this.findProcessNode(id, node.children);
        if (found) return found;
      }
    }

    return null;
  }

  /**
   * Programatically selects a process in the stats table.
   *
   * @param processId - ID of the process to select
   */
  selectProcess(processId: string): void {
    if (this.state !== 'running' || !this.currentSnapshot) return;

    const node = this.findProcessNode(processId, this.currentSnapshot.tree);
    if (!node || !this.screen || !this.processDetailView) return;

    this.processDetailView.show(this.screen, { node }, () => {
      this.render();
    });
  }
}
