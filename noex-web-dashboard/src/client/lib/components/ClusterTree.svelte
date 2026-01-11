<!--
  ClusterTree.svelte - Cluster nodes hierarchical view component.

  Displays cluster topology with per-node status and statistics:
  - Node connection status indicators
  - Process counts and memory usage per node
  - Expandable/collapsible node details
  - Selection support for node inspection
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { cluster, type NodeObserverSnapshot } from '../stores/cluster.js';
  import type { GenServerStats } from 'noex';
  import {
    formatNodeId,
    formatNumber,
    formatBytes,
    formatDuration,
    truncate,
  } from '../utils/formatters.js';

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  interface Props {
    /** Whether to show detailed node statistics. */
    showDetails?: boolean;
    /** Maximum width for node ID display. */
    nodeIdMaxLength?: number;
    /** Callback when a node is selected. */
    onNodeSelect?: (nodeId: string) => void;
    /** Callback when a server is clicked. */
    onServerClick?: (server: GenServerStats) => void;
    /** Currently selected node ID. */
    selectedNodeId?: string | null;
  }

  type NodeStatus = NodeObserverSnapshot['status'];

  // ---------------------------------------------------------------------------
  // Props
  // ---------------------------------------------------------------------------

  const {
    showDetails = true,
    nodeIdMaxLength = 24,
    onNodeSelect,
    onServerClick,
    selectedNodeId = null,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Internal State
  // ---------------------------------------------------------------------------

  let expandedNodes = $state<Set<string>>(new Set());

  // Store-derived state (via subscriptions)
  let nodesValue = $state<NodeObserverSnapshot[]>([]);
  let hasNodesValue = $state(false);
  let isAvailableValue = $state(false);
  let localNodeIdValue = $state<string | symbol | null>(null);
  let connectedNodeCountValue = $state(0);
  let nodeCountValue = $state(0);
  let totalProcessCountValue = $state(0);

  let unsubscribers: Array<() => void> = [];

  onMount(() => {
    unsubscribers = [
      cluster.nodes.subscribe((v) => (nodesValue = v as NodeObserverSnapshot[])),
      cluster.hasNodes.subscribe((v) => (hasNodesValue = v)),
      cluster.isAvailable.subscribe((v) => (isAvailableValue = v)),
      cluster.localNodeId.subscribe((v) => (localNodeIdValue = v)),
      cluster.connectedNodeCount.subscribe((v) => (connectedNodeCountValue = v)),
      cluster.nodeCount.subscribe((v) => (nodeCountValue = v)),
      cluster.totalProcessCount.subscribe((v) => (totalProcessCountValue = v)),
    ];
  });

  onDestroy(() => {
    unsubscribers.forEach((fn) => fn());
  });

  // ---------------------------------------------------------------------------
  // Status Mapping
  // ---------------------------------------------------------------------------

  interface StatusDisplay {
    readonly icon: string;
    readonly label: string;
    readonly className: string;
  }

  const NODE_STATUS_MAP: Readonly<Record<NodeStatus, StatusDisplay>> = {
    connected: { icon: '\u25CF', label: 'Connected', className: 'status-connected' },
    disconnected: { icon: '\u25CB', label: 'Disconnected', className: 'status-disconnected' },
    error: { icon: '\u2717', label: 'Error', className: 'status-error' },
    timeout: { icon: '\u23F1', label: 'Timeout', className: 'status-timeout' },
  };

  // ---------------------------------------------------------------------------
  // Computed Values
  // ---------------------------------------------------------------------------

  const sortedNodes = $derived(
    [...nodesValue].sort((a, b) => {
      // Sort by status priority, then by nodeId
      const statusPriority: Record<NodeStatus, number> = {
        connected: 0,
        disconnected: 1,
        timeout: 2,
        error: 3,
      };
      const statusDiff = statusPriority[a.status] - statusPriority[b.status];
      if (statusDiff !== 0) return statusDiff;
      return String(a.nodeId).localeCompare(String(b.nodeId));
    })
  );

  function isLocalNode(nodeId: string): boolean {
    return localNodeIdValue !== null && String(localNodeIdValue) === nodeId;
  }

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  function handleNodeClick(nodeId: string): void {
    onNodeSelect?.(nodeId);
  }

  function handleServerClick(server: GenServerStats, event: MouseEvent): void {
    event.stopPropagation();
    onServerClick?.(server);
  }

  function toggleNodeExpanded(nodeId: string, event: MouseEvent): void {
    event.stopPropagation();
    const newSet = new Set(expandedNodes);
    if (newSet.has(nodeId)) {
      newSet.delete(nodeId);
    } else {
      newSet.add(nodeId);
    }
    expandedNodes = newSet;
  }

  function isNodeExpanded(nodeId: string): boolean {
    return expandedNodes.has(nodeId);
  }

  // ---------------------------------------------------------------------------
  // Node Stats Helpers
  // ---------------------------------------------------------------------------

  function getNodeProcessCount(node: NodeObserverSnapshot): number {
    return node.snapshot?.processCount ?? 0;
  }

  function getNodeServerCount(node: NodeObserverSnapshot): number {
    return node.snapshot?.servers.length ?? 0;
  }

  function getNodeSupervisorCount(node: NodeObserverSnapshot): number {
    return node.snapshot?.supervisors.length ?? 0;
  }

  function getNodeMemoryUsed(node: NodeObserverSnapshot): number {
    return node.snapshot?.memoryStats.heapUsed ?? 0;
  }

  function getNodeMemoryTotal(node: NodeObserverSnapshot): number {
    return node.snapshot?.memoryStats.heapTotal ?? 0;
  }

  function getNodeUptime(node: NodeObserverSnapshot): number {
    if (!node.snapshot || node.snapshot.timestamp === 0) return 0;
    return Date.now() - node.lastUpdate;
  }

  function getStatusDisplay(status: NodeStatus): StatusDisplay {
    return NODE_STATUS_MAP[status];
  }
</script>

<div class="cluster-tree" role="tree" aria-label="Cluster nodes">
  {#if !hasNodesValue}
    <div class="empty-state">
      <span class="empty-icon" aria-hidden="true">\u2601</span>
      <p class="empty-message">No cluster nodes available</p>
      <p class="empty-hint">
        {#if !isAvailableValue}
          Cluster mode is not enabled
        {:else}
          Waiting for node discovery...
        {/if}
      </p>
    </div>
  {:else}
    <header class="tree-header">
      <div class="header-stats">
        <span class="stat">
          <span class="stat-value">{connectedNodeCountValue}</span>
          <span class="stat-label">/{nodeCountValue} nodes</span>
        </span>
        <span class="stat">
          <span class="stat-value">{formatNumber(totalProcessCountValue)}</span>
          <span class="stat-label">processes</span>
        </span>
      </div>
      {#if localNodeIdValue}
        <div class="local-node-badge" title="Local node">
          \u2302 {formatNodeId(String(localNodeIdValue), 16)}
        </div>
      {/if}
    </header>

    <ul class="node-list" role="group">
      {#each sortedNodes as node (node.nodeId)}
        {@const nodeIdStr = String(node.nodeId)}
        {@const statusDisplay = getStatusDisplay(node.status)}
        {@const isSelected = selectedNodeId === nodeIdStr}
        {@const isExpanded = isNodeExpanded(nodeIdStr)}
        {@const isLocal = isLocalNode(nodeIdStr)}

        <li
          class="node-item"
          class:selected={isSelected}
          class:expanded={isExpanded}
          class:local={isLocal}
          role="treeitem"
          aria-selected={isSelected}
          aria-expanded={showDetails ? isExpanded : undefined}
        >
          <div class="node-header-wrapper">
            <button
              type="button"
              class="node-header"
              onclick={() => handleNodeClick(nodeIdStr)}
              aria-label="Select node {formatNodeId(nodeIdStr, nodeIdMaxLength)}"
            >
              <span
                class="node-status {statusDisplay.className}"
                title={statusDisplay.label}
                aria-label={statusDisplay.label}
              >
                {statusDisplay.icon}
              </span>

              <span class="node-id" title={nodeIdStr}>
                {formatNodeId(nodeIdStr, nodeIdMaxLength)}
                {#if isLocal}
                  <span class="local-badge">(local)</span>
                {/if}
              </span>

              <span class="node-stats-summary">
                {#if node.status === 'connected' && node.snapshot}
                  <span class="stat-chip" title="Processes">
                    {getNodeProcessCount(node)} procs
                  </span>
                  <span class="stat-chip" title="Heap memory">
                    {formatBytes(getNodeMemoryUsed(node))}
                  </span>
                {:else if node.error}
                  <span class="error-chip" title={node.error}>
                    {node.error.slice(0, 20)}{node.error.length > 20 ? '\u2026' : ''}
                  </span>
                {:else}
                  <span class="status-chip {statusDisplay.className}">
                    {statusDisplay.label}
                  </span>
                {/if}
              </span>
            </button>

            {#if showDetails && node.status === 'connected' && node.snapshot}
              <button
                type="button"
                class="expand-toggle"
                onclick={(e) => toggleNodeExpanded(nodeIdStr, e)}
                aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
              >
                {isExpanded ? '\u25BC' : '\u25B6'}
              </button>
            {/if}
          </div>

          {#if showDetails && isExpanded && node.status === 'connected' && node.snapshot}
            <div class="node-details" role="group">
              <dl class="details-grid">
                <div class="detail-item">
                  <dt>Servers</dt>
                  <dd>{getNodeServerCount(node)}</dd>
                </div>
                <div class="detail-item">
                  <dt>Supervisors</dt>
                  <dd>{getNodeSupervisorCount(node)}</dd>
                </div>
                <div class="detail-item">
                  <dt>Heap Used</dt>
                  <dd>{formatBytes(getNodeMemoryUsed(node))}</dd>
                </div>
                <div class="detail-item">
                  <dt>Heap Total</dt>
                  <dd>{formatBytes(getNodeMemoryTotal(node))}</dd>
                </div>
                <div class="detail-item">
                  <dt>Messages</dt>
                  <dd>{formatNumber(node.snapshot.totalMessages)}</dd>
                </div>
                <div class="detail-item">
                  <dt>Last Update</dt>
                  <dd>{formatDuration(getNodeUptime(node))} ago</dd>
                </div>
              </dl>

              {#if node.snapshot.servers.length > 0}
                <div class="servers-section">
                  <h4 class="servers-title">GenServers</h4>
                  <ul class="servers-list">
                    {#each node.snapshot.servers as server (server.id)}
                      <li>
                        <button
                          type="button"
                          class="server-item"
                          onclick={(e) => handleServerClick(server, e)}
                        >
                          <span class="server-status status-{server.status}">●</span>
                          <span class="server-name">{truncate(server.id, 30)}</span>
                          <span class="server-stats">
                            {server.messageCount} msgs, q:{server.queueSize}
                          </span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .cluster-tree {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    background-color: var(--color-background-elevated);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
    font-size: 0.8125rem;
    overflow-y: auto;
    max-height: 100%;
  }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem 1rem;
    text-align: center;
    color: var(--color-text-muted);
  }

  .empty-icon {
    font-size: 2rem;
    margin-bottom: 0.75rem;
    opacity: 0.5;
  }

  .empty-message {
    font-weight: 500;
    color: var(--color-text);
    margin: 0 0 0.25rem 0;
  }

  .empty-hint {
    font-size: 0.75rem;
    margin: 0;
  }

  /* Header */
  .tree-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--color-border-muted);
  }

  .header-stats {
    display: flex;
    gap: 1rem;
  }

  .stat {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
  }

  .stat-value {
    font-weight: 600;
    color: var(--color-text);
    font-variant-numeric: tabular-nums;
  }

  .stat-label {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .local-node-badge {
    font-size: 0.6875rem;
    padding: 0.125rem 0.5rem;
    background-color: var(--color-primary);
    color: var(--color-text-inverse);
    border-radius: 9999px;
    font-weight: 500;
  }

  /* Node list */
  .node-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .node-item {
    position: relative;
    border-radius: 4px;
    transition: background-color 150ms ease;
  }

  .node-item:hover {
    background-color: var(--color-hover);
  }

  .node-item.selected {
    background-color: var(--color-selected);
  }

  .node-item.local {
    border-left: 2px solid var(--color-primary);
    padding-left: 0.25rem;
  }

  /* Node header wrapper */
  .node-header-wrapper {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  /* Node header */
  .node-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
    padding: 0.5rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    font-size: inherit;
    color: inherit;
  }

  .node-header:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
    border-radius: 4px;
  }

  /* Node status indicator */
  .node-status {
    flex-shrink: 0;
    width: 1rem;
    text-align: center;
    font-size: 0.875rem;
  }

  .status-connected {
    color: var(--color-status-connected);
  }

  .status-disconnected {
    color: var(--color-status-disconnected);
  }

  .status-error {
    color: var(--color-error);
  }

  .status-timeout {
    color: var(--color-warning);
  }

  /* Node ID */
  .node-id {
    flex: 1;
    min-width: 0;
    font-weight: 500;
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .local-badge {
    font-size: 0.6875rem;
    font-weight: 400;
    color: var(--color-primary);
    margin-left: 0.25rem;
  }

  /* Stats summary */
  .node-stats-summary {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .stat-chip,
  .status-chip,
  .error-chip {
    font-size: 0.6875rem;
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    font-variant-numeric: tabular-nums;
  }

  .stat-chip {
    background-color: var(--color-background-sunken);
    color: var(--color-text-muted);
  }

  .status-chip {
    background-color: var(--color-background-sunken);
  }

  .error-chip {
    background-color: var(--color-error-muted);
    color: var(--color-error);
  }

  /* Expand toggle */
  .expand-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    padding: 0;
    background: none;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: 0.625rem;
    transition: background-color 150ms ease;
  }

  .expand-toggle:hover {
    background-color: var(--color-active);
    color: var(--color-text);
  }

  .expand-toggle:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 0;
  }

  /* Node details */
  .node-details {
    position: relative;
    z-index: 1;
    padding: 0.5rem 0.5rem 0.5rem 2rem;
    border-top: 1px solid var(--color-border-muted);
    margin-top: 0.25rem;
  }

  .details-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 0.5rem 1rem;
    margin: 0;
  }

  .detail-item {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .detail-item dt {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.025em;
    color: var(--color-text-muted);
  }

  .detail-item dd {
    margin: 0;
    font-weight: 500;
    color: var(--color-text);
    font-variant-numeric: tabular-nums;
  }

  /* Servers section */
  .servers-section {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--color-border-muted);
  }

  .servers-title {
    margin: 0 0 0.5rem 0;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.025em;
    color: var(--color-text-muted);
  }

  .servers-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: 200px;
    overflow-y: auto;
  }

  .server-item {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    background-color: var(--color-background-sunken);
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.75rem;
    text-align: left;
    color: var(--color-text);
    transition: background-color 100ms ease, border-color 100ms ease;
  }

  .server-item:hover {
    background-color: var(--color-hover);
    border-color: var(--color-border);
  }

  .server-item:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
  }

  .server-status {
    flex-shrink: 0;
    font-size: 0.625rem;
  }

  .server-status.status-running { color: var(--color-success); }
  .server-status.status-initializing { color: var(--color-primary); }
  .server-status.status-stopping { color: var(--color-warning); }
  .server-status.status-stopped { color: var(--color-error); }

  .server-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  }

  .server-stats {
    flex-shrink: 0;
    font-size: 0.6875rem;
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* Responsive adjustments */
  @media (max-width: 480px) {
    .header-stats {
      flex-direction: column;
      gap: 0.25rem;
    }

    .node-stats-summary {
      display: none;
    }

    .details-grid {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
