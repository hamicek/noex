<!--
  StatusBar.svelte - Dashboard status bar component.

  Displays connection status, view mode, layout mode, system metrics,
  and keyboard shortcut hints in a fixed bottom bar.
-->
<script lang="ts">
  import { connection, type ConnectionState } from '../stores/connection.js';
  import { snapshot } from '../stores/snapshot.js';
  import { cluster } from '../stores/cluster.js';
  import { formatUptime } from '../utils/formatters.js';

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  type ViewMode = 'local' | 'cluster';
  type LayoutMode = 'full' | 'compact' | 'minimal';

  interface Props {
    /** Current view mode. */
    viewMode?: ViewMode;
    /** Current layout mode. */
    layoutMode?: LayoutMode;
    /** Dashboard start timestamp for uptime calculation. */
    startTime?: number;
  }

  // ---------------------------------------------------------------------------
  // Props & State
  // ---------------------------------------------------------------------------

  const {
    viewMode = 'local',
    layoutMode = 'full',
    startTime = Date.now(),
  }: Props = $props();

  // Derived reactive state
  const uptime = $derived(formatUptime(Date.now() - startTime));

  // ---------------------------------------------------------------------------
  // Connection Status
  // ---------------------------------------------------------------------------

  interface StatusIndicator {
    readonly label: string;
    readonly className: string;
  }

  const CONNECTION_STATUS_MAP: Record<ConnectionState, StatusIndicator> = {
    connected: { label: 'Connected', className: 'status-connected' },
    connecting: { label: 'Connecting...', className: 'status-connecting' },
    reconnecting: { label: 'Reconnecting...', className: 'status-reconnecting' },
    disconnected: { label: 'Disconnected', className: 'status-disconnected' },
  };

  function getConnectionStatus(): StatusIndicator {
    return CONNECTION_STATUS_MAP[connection.state];
  }

  // ---------------------------------------------------------------------------
  // Layout Indicator
  // ---------------------------------------------------------------------------

  const LAYOUT_LABELS: Record<LayoutMode, string> = {
    full: '1:Full',
    compact: '2:Compact',
    minimal: '3:Minimal',
  };

  // ---------------------------------------------------------------------------
  // View Mode Indicator
  // ---------------------------------------------------------------------------

  function getViewModeClassName(): string {
    if (viewMode === 'cluster') return 'view-cluster';
    return cluster.isAvailable ? 'view-local' : 'view-local-only';
  }

  // ---------------------------------------------------------------------------
  // Process Information
  // ---------------------------------------------------------------------------

  function getProcessInfo(): string {
    if (viewMode === 'cluster' && cluster.hasData) {
      const { connectedNodeCount, nodeCount, totalProcessCount, totalServerCount } = cluster;
      return `Cluster: ${connectedNodeCount}/${nodeCount} nodes, ${totalProcessCount} processes, ${totalServerCount} servers`;
    }

    if (snapshot.hasData) {
      const { processCount, serverCount, supervisorCount } = snapshot;
      return `Processes: ${processCount} (${serverCount} servers, ${supervisorCount} supervisors)`;
    }

    return 'Waiting for data...';
  }
</script>

<footer class="status-bar">
  <div class="shortcuts">
    <kbd>q</kbd><span>quit</span>
    <kbd>r</kbd><span>refresh</span>
    <kbd>?</kbd><span>help</span>
    <kbd>1-3</kbd><span>layout</span>
    <kbd>c</kbd><span>cluster</span>
  </div>

  <div class="divider" aria-hidden="true"></div>

  <div class="status-group">
    <span class="label">Status:</span>
    <span class="connection-status {getConnectionStatus().className}">
      {getConnectionStatus().label}
    </span>
  </div>

  <div class="divider" aria-hidden="true"></div>

  <div class="status-group">
    <span class="label">Layout:</span>
    <span class="layout-indicator">[{LAYOUT_LABELS[layoutMode]}]</span>
  </div>

  <div class="divider" aria-hidden="true"></div>

  <div class="status-group">
    <span class="label">View:</span>
    <span class="view-indicator {getViewModeClassName()}">
      [{viewMode === 'cluster' ? 'Cluster' : 'Local'}]
    </span>
  </div>

  <div class="divider" aria-hidden="true"></div>

  <div class="process-info">
    {getProcessInfo()}
  </div>

  <div class="spacer"></div>

  <div class="uptime">
    <span class="label">Up:</span>
    <time>{uptime}</time>
  </div>
</footer>

<style>
  .status-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    background-color: var(--color-background-elevated);
    border-top: 1px solid var(--color-border);
    font-size: 0.8125rem;
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
    user-select: none;
  }

  .shortcuts {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .shortcuts kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.25rem;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--color-text);
    background-color: var(--color-background-sunken);
    border: 1px solid var(--color-border);
    border-radius: 3px;
    margin-right: 0.125rem;
  }

  .shortcuts span {
    color: var(--color-text-muted);
    margin-right: 0.5rem;
  }

  .divider {
    width: 1px;
    height: 1rem;
    background-color: var(--color-border-muted);
    flex-shrink: 0;
  }

  .status-group {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
  }

  .label {
    color: var(--color-text-muted);
  }

  /* Connection status indicators */
  .connection-status {
    font-weight: 500;
  }

  .status-connected {
    color: var(--color-status-connected);
  }

  .status-connecting,
  .status-reconnecting {
    color: var(--color-status-connecting);
  }

  .status-disconnected {
    color: var(--color-status-disconnected);
  }

  /* Layout indicator */
  .layout-indicator {
    color: var(--color-text);
  }

  /* View mode indicators */
  .view-indicator {
    font-weight: 500;
  }

  .view-cluster {
    color: var(--color-primary);
  }

  .view-local {
    color: var(--color-text);
  }

  .view-local-only {
    color: var(--color-text-muted);
  }

  .process-info {
    color: var(--color-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .spacer {
    flex: 1;
  }

  .uptime {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
  }

  .uptime time {
    color: var(--color-text);
    font-variant-numeric: tabular-nums;
  }

  /* Responsive: hide some elements on smaller screens */
  @media (max-width: 768px) {
    .shortcuts span {
      display: none;
    }

    .process-info {
      display: none;
    }
  }

  @media (max-width: 480px) {
    .shortcuts {
      display: none;
    }
  }
</style>
