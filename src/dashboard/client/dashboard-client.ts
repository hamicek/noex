/**
 * Remote Dashboard Client.
 *
 * Connects to a DashboardServer over TCP and renders the TUI locally.
 * Reuses existing widget components from the main Dashboard implementation.
 *
 * @example
 * ```typescript
 * import { DashboardClient } from 'noex/dashboard/client';
 *
 * const client = new DashboardClient({
 *   host: '127.0.0.1',
 *   port: 9876,
 *   theme: 'dark',
 *   layout: 'full',
 * });
 *
 * await client.start();
 * ```
 */

import blessed from 'blessed';
import contrib from 'blessed-contrib';
import type { ObserverSnapshot } from '../../observer/types.js';
import type { ObserverEvent, ProcessTreeNode } from '../../core/types.js';
import {
  type DashboardConfig,
  type DashboardTheme,
  type DashboardLayout,
  DEFAULT_CONFIG,
  getTheme,
} from '../types.js';
import {
  ProcessTreeWidget,
  StatsTableWidget,
  MemoryGaugeWidget,
  EventLogWidget,
  ProcessDetailView,
  type GridPosition,
} from '../widgets/index.js';
import { formatReason } from '../utils/formatters.js';
import {
  DashboardConnection,
  type ConnectionConfig,
  type ConnectionEvent,
} from './connection.js';
import type { ServerMessage } from '../server/protocol.js';

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration options for DashboardClient.
 */
export interface DashboardClientConfig extends ConnectionConfig {
  /** Color theme to use. @default 'dark' */
  readonly theme: 'dark' | 'light';
  /** Layout mode. @default 'full' */
  readonly layout: DashboardLayout;
  /** Maximum number of events to keep in the event log. @default 100 */
  readonly maxEventLogSize: number;
}

/**
 * Default client configuration.
 */
export const DEFAULT_CLIENT_CONFIG: DashboardClientConfig = {
  host: '127.0.0.1',
  port: 9876,
  autoReconnect: true,
  reconnectDelayMs: 1000,
  maxReconnectDelayMs: 30000,
  reconnectBackoffMultiplier: 1.5,
  connectionTimeoutMs: 5000,
  theme: 'dark',
  layout: 'full',
  maxEventLogSize: 100,
};

/**
 * Client state enumeration.
 */
type ClientState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

/**
 * Layout configurations for different display modes.
 */
const LAYOUTS = {
  full: {
    processTree: { row: 0, col: 0, rowSpan: 6, colSpan: 4 },
    statsTable: { row: 0, col: 4, rowSpan: 6, colSpan: 8 },
    memoryGauge: { row: 6, col: 0, rowSpan: 3, colSpan: 4 },
    eventLog: { row: 6, col: 4, rowSpan: 4, colSpan: 8 },
    statusBar: { row: 10, col: 0, rowSpan: 2, colSpan: 12 },
  },
  compact: {
    processTree: { row: 0, col: 0, rowSpan: 9, colSpan: 4 },
    statsTable: { row: 0, col: 4, rowSpan: 9, colSpan: 8 },
    statusBar: { row: 10, col: 0, rowSpan: 2, colSpan: 12 },
  },
  minimal: {
    statsTable: { row: 0, col: 0, rowSpan: 10, colSpan: 12 },
    statusBar: { row: 10, col: 0, rowSpan: 2, colSpan: 12 },
  },
} as const satisfies Record<string, Record<string, GridPosition>>;

// =============================================================================
// DashboardClient Class
// =============================================================================

/**
 * Remote TUI dashboard client that connects to DashboardServer.
 *
 * Provides the same visual interface as the main Dashboard,
 * but receives data from a remote server instead of directly
 * from the Observer module.
 */
export class DashboardClient {
  private readonly config: DashboardClientConfig;
  private readonly theme: DashboardTheme;
  private readonly connection: DashboardConnection;

  private state: ClientState = 'idle';
  private currentLayout: DashboardLayout;
  private screen: blessed.Widgets.Screen | null = null;
  private grid: InstanceType<typeof contrib.grid> | null = null;

  // Widgets
  private processTreeWidget: ProcessTreeWidget | null = null;
  private statsTableWidget: StatsTableWidget | null = null;
  private memoryGaugeWidget: MemoryGaugeWidget | null = null;
  private eventLogWidget: EventLogWidget | null = null;
  private statusBar: blessed.Widgets.BoxElement | null = null;
  private processDetailView: ProcessDetailView | null = null;

  // State
  private currentSnapshot: ObserverSnapshot | null = null;
  private startTime = 0;
  private serverUptime = 0;
  private connectionUnsubscribe: (() => void) | null = null;

  constructor(config: Partial<DashboardClientConfig> = {}) {
    this.config = { ...DEFAULT_CLIENT_CONFIG, ...config };
    this.theme = getTheme(this.config.theme);
    this.currentLayout = this.config.layout;

    this.connection = new DashboardConnection({
      host: this.config.host,
      port: this.config.port,
      autoReconnect: this.config.autoReconnect,
      reconnectDelayMs: this.config.reconnectDelayMs,
      maxReconnectDelayMs: this.config.maxReconnectDelayMs,
      reconnectBackoffMultiplier: this.config.reconnectBackoffMultiplier,
      connectionTimeoutMs: this.config.connectionTimeoutMs,
    });
  }

  /**
   * Starts the dashboard client.
   *
   * Initializes the TUI, connects to the server, and begins
   * receiving and displaying data.
   *
   * @throws Error if already running or connection fails
   */
  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      throw new Error('DashboardClient is already running');
    }

    this.state = 'starting';
    this.startTime = Date.now();

    this.initializeScreen();
    this.createLayout();
    this.setupKeyboardHandlers();
    this.subscribeToConnection();

    this.logEvent('info', 'Connecting to server...');
    this.render();

    try {
      await this.connection.connect();
      this.state = 'running';
    } catch (error) {
      this.logEvent(
        'error',
        `Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      this.state = 'running'; // Keep running for reconnect attempts
    }
  }

  /**
   * Stops the dashboard client.
   *
   * Disconnects from the server, cleans up resources,
   * and destroys the terminal screen.
   */
  stop(): void {
    if (this.state !== 'running') {
      return;
    }

    this.state = 'stopping';

    // Cleanup connection
    if (this.connectionUnsubscribe) {
      this.connectionUnsubscribe();
      this.connectionUnsubscribe = null;
    }
    this.connection.disconnect();

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
   * Returns whether the client is currently running.
   */
  isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * Returns the current layout mode.
   */
  getLayout(): DashboardLayout {
    return this.currentLayout;
  }

  /**
   * Switches to a different layout mode.
   */
  switchLayout(layout: DashboardLayout): void {
    if (this.state !== 'running' || !this.screen) return;
    if (layout === this.currentLayout) return;

    const snapshot = this.currentSnapshot;

    this.destroyWidgets();

    if (this.grid) {
      const children = [...this.screen.children];
      for (const child of children) {
        child.destroy();
      }
      this.grid = null;
    }

    this.currentLayout = layout;
    this.createLayout();

    if (snapshot) {
      this.updateWidgets(snapshot);
    }

    this.logEvent('info', `Switched to ${layout} layout`);
    this.render();
  }

  // ===========================================================================
  // Screen Initialization
  // ===========================================================================

  private initializeScreen(): void {
    // Suppress blessed terminfo warnings
    const originalStderr = process.stderr.write.bind(process.stderr);
    const suppressedWrite = function (
      this: NodeJS.WriteStream,
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean {
      const str = typeof chunk === 'string' ? chunk : chunk.toString();
      if (str.includes('Setulc') || str.includes('stack.push')) {
        return true;
      }
      if (typeof encodingOrCb === 'function') {
        return originalStderr(chunk, encodingOrCb);
      }
      return originalStderr(chunk, encodingOrCb, cb);
    };
    process.stderr.write = suppressedWrite as typeof process.stderr.write;

    this.screen = blessed.screen({
      smartCSR: true,
      title: 'noex Dashboard (Remote)',
      fullUnicode: true,
      autoPadding: true,
      warnings: false,
    });

    process.stderr.write = originalStderr;
  }

  private createLayout(): void {
    if (!this.screen) return;

    this.grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen,
    });

    this.createWidgets();
  }

  private createWidgets(): void {
    if (!this.grid) return;

    const layout = LAYOUTS[this.currentLayout];
    const widgetConfig = { theme: this.theme };

    // Process Tree (full + compact layouts)
    if ('processTree' in layout) {
      this.processTreeWidget = new ProcessTreeWidget(widgetConfig);
      this.processTreeWidget.create(this.grid, layout.processTree);
    }

    // Stats Table (all layouts)
    this.statsTableWidget = new StatsTableWidget(widgetConfig);
    this.statsTableWidget.create(this.grid, layout.statsTable);

    // Memory Gauge (full layout only)
    if ('memoryGauge' in layout) {
      this.memoryGaugeWidget = new MemoryGaugeWidget(widgetConfig);
      this.memoryGaugeWidget.create(this.grid, layout.memoryGauge);
    }

    // Event Log (full layout only)
    if ('eventLog' in layout) {
      this.eventLogWidget = new EventLogWidget({
        theme: this.theme,
        maxEntries: this.config.maxEventLogSize,
      });
      this.eventLogWidget.create(this.grid, layout.eventLog);
    }

    // Status Bar (all layouts)
    this.createStatusBar();

    // Process Detail View (modal)
    this.processDetailView = new ProcessDetailView({ theme: this.theme });

    // Set initial focus
    const statsElement = this.statsTableWidget?.getElement();
    if (statsElement) {
      statsElement.focus();
    }
  }

  private createStatusBar(): void {
    if (!this.grid) return;

    const layout = LAYOUTS[this.currentLayout];
    const pos = layout.statusBar;
    this.statusBar = this.grid.set(
      pos.row,
      pos.col,
      pos.rowSpan,
      pos.colSpan,
      blessed.box,
      {
        tags: true,
        border: { type: 'line' },
        style: {
          fg: this.theme.text,
          bg: this.theme.background,
          border: { fg: this.theme.primary },
        },
      },
    );
  }

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

  // ===========================================================================
  // Keyboard Handlers
  // ===========================================================================

  private setupKeyboardHandlers(): void {
    if (!this.screen) return;

    // Quit
    this.screen.key(['escape', 'q', 'C-c'], () => {
      this.stop();
      // eslint-disable-next-line n/no-process-exit
      process.exit(0);
    });

    // Refresh (request new snapshot)
    this.screen.key(['r'], () => {
      if (this.connection.isConnected()) {
        this.connection.requestSnapshot();
        this.logEvent('info', 'Refresh requested');
      } else {
        this.logEvent('warning', 'Not connected - cannot refresh');
      }
    });

    // Help
    this.screen.key(['?', 'h'], () => {
      this.showHelp();
    });

    // Tab navigation
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

    // Layout switching
    this.screen.key(['1'], () => this.switchLayout('full'));
    this.screen.key(['2'], () => this.switchLayout('compact'));
    this.screen.key(['3'], () => this.switchLayout('minimal'));
  }

  // ===========================================================================
  // Connection Handling
  // ===========================================================================

  private subscribeToConnection(): void {
    this.connectionUnsubscribe = this.connection.onEvent((event) => {
      this.handleConnectionEvent(event);
    });
  }

  private handleConnectionEvent(event: ConnectionEvent): void {
    switch (event.type) {
      case 'connected':
        this.logEvent('success', 'Connected to server');
        break;

      case 'disconnected':
        this.logEvent('warning', `Disconnected: ${event.reason}`);
        break;

      case 'reconnecting':
        this.logEvent(
          'info',
          `Reconnecting (attempt ${event.attempt}) in ${event.delayMs}ms...`,
        );
        break;

      case 'error':
        this.logEvent('error', `Error: ${event.error.message}`);
        break;

      case 'message':
        this.handleServerMessage(event.message);
        break;
    }

    this.updateStatusBar();
    this.render();
  }

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.serverUptime = message.payload.serverUptime;
        this.logEvent(
          'success',
          `Server v${message.payload.version} (uptime: ${this.formatUptime(this.serverUptime)})`,
        );
        break;

      case 'snapshot':
        this.updateWidgets(message.payload);
        break;

      case 'event':
        this.handleObserverEvent(message.payload);
        break;

      case 'error':
        this.logEvent('error', `Server error [${message.payload.code}]: ${message.payload.message}`);
        break;
    }
  }

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
  }

  // ===========================================================================
  // Widget Updates
  // ===========================================================================

  private updateWidgets(snapshot: ObserverSnapshot): void {
    this.currentSnapshot = snapshot;
    this.processTreeWidget?.update({ tree: snapshot.tree });
    this.statsTableWidget?.update({ servers: snapshot.servers });
    this.memoryGaugeWidget?.update({ memoryStats: snapshot.memoryStats });
    this.updateStatusBar();
    this.render();
  }

  private updateStatusBar(): void {
    if (!this.statusBar) return;

    const uptime = this.formatUptime(Date.now() - this.startTime);
    const connectionStatus = this.getConnectionStatusIndicator();
    const layoutIndicator = this.getLayoutIndicator();

    let processInfo = 'Waiting for data...';
    if (this.currentSnapshot) {
      const { processCount } = this.currentSnapshot;
      const serverCount = this.currentSnapshot.servers.length;
      const supervisorCount = this.currentSnapshot.supervisors.length;
      processInfo = `Processes: ${processCount} (${serverCount} servers, ${supervisorCount} supervisors)`;
    }

    const content =
      ` [q]uit [r]efresh [?]help [1-3]layout` +
      `  |  ${connectionStatus}` +
      `  |  ${layoutIndicator}` +
      `  |  ${processInfo}` +
      `  |  Up: ${uptime}`;

    this.statusBar.setContent(content);
  }

  private getConnectionStatusIndicator(): string {
    switch (this.connection.getState()) {
      case 'connected':
        return `{green-fg}Connected{/green-fg}`;
      case 'connecting':
        return `{yellow-fg}Connecting...{/yellow-fg}`;
      case 'reconnecting':
        return `{yellow-fg}Reconnecting...{/yellow-fg}`;
      case 'disconnected':
        return `{red-fg}Disconnected{/red-fg}`;
    }
  }

  private getLayoutIndicator(): string {
    switch (this.currentLayout) {
      case 'full':
        return '[1:Full]';
      case 'compact':
        return '[2:Compact]';
      case 'minimal':
        return '[3:Minimal]';
    }
  }

  // ===========================================================================
  // Process Detail
  // ===========================================================================

  private showSelectedProcessDetail(): void {
    if (!this.screen || !this.processDetailView || !this.currentSnapshot) return;
    if (this.processDetailView.isVisible()) return;

    let node: ProcessTreeNode | null = null;

    const treeNode = this.processTreeWidget?.getSelectedNode?.();
    if (treeNode) {
      node = treeNode;
    }

    if (!node) {
      const selectedId = this.statsTableWidget?.getSelectedId();
      if (selectedId) {
        node = this.findProcessNode(selectedId, this.currentSnapshot.tree);

        if (!node) {
          const server = this.currentSnapshot.servers.find((s) => s.id === selectedId);
          if (server) {
            node = {
              id: server.id,
              type: 'genserver',
              name: server.id,
              stats: server,
            };
          }
        }
      }
    }

    if (!node) {
      this.logEvent('warning', 'No process selected');
      return;
    }

    this.processDetailView.show(this.screen, { node }, () => {
      this.render();
    });
  }

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

  // ===========================================================================
  // Help & Utilities
  // ===========================================================================

  private showHelp(): void {
    if (!this.screen) return;

    const helpBox = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 52,
      height: 21,
      label: ' Keyboard Shortcuts (Remote Dashboard) ',
      tags: true,
      border: { type: 'line' },
      style: {
        border: { fg: this.theme.primary },
        label: { fg: this.theme.primary },
      },
      content: `
  {${this.theme.primary}-fg}q, Escape, Ctrl+C{/${this.theme.primary}-fg}  Quit client
  {${this.theme.primary}-fg}r{/${this.theme.primary}-fg}                  Request refresh
  {${this.theme.primary}-fg}?, h{/${this.theme.primary}-fg}               Show this help
  {${this.theme.primary}-fg}Tab{/${this.theme.primary}-fg}                Next widget
  {${this.theme.primary}-fg}Shift+Tab{/${this.theme.primary}-fg}          Previous widget
  {${this.theme.primary}-fg}Enter{/${this.theme.primary}-fg}              Show process detail
  {${this.theme.primary}-fg}Arrow keys{/${this.theme.primary}-fg}         Navigate within widget

  {${this.theme.secondary}-fg}Layouts:{/${this.theme.secondary}-fg}
  {${this.theme.primary}-fg}1{/${this.theme.primary}-fg}                  Full layout
  {${this.theme.primary}-fg}2{/${this.theme.primary}-fg}                  Compact layout
  {${this.theme.primary}-fg}3{/${this.theme.primary}-fg}                  Minimal layout

  {${this.theme.textMuted}-fg}Remote server: ${this.config.host}:${this.config.port}{/${this.theme.textMuted}-fg}
  {${this.theme.textMuted}-fg}Press any key to close{/${this.theme.textMuted}-fg}
`,
    });

    helpBox.focus();

    helpBox.key(['escape', 'q', 'enter', 'space'], () => {
      helpBox.destroy();
      this.render();
    });

    helpBox.once('keypress', () => {
      helpBox.destroy();
      this.render();
    });

    this.render();
  }

  private logEvent(
    severity: 'info' | 'success' | 'warning' | 'error',
    message: string,
  ): void {
    this.eventLogWidget?.log({ message, severity });
  }

  private render(): void {
    if (this.screen) {
      this.screen.render();
    }
  }

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
