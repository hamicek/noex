<!--
  ProcessTree.svelte - Hierarchical process tree visualization.

  Displays the supervision hierarchy as an interactive tree with:
  - Expandable/collapsible supervisor nodes
  - Color-coded status indicators
  - Process type icons (supervisor/genserver)
  - Selection with keyboard navigation support
  - Contextual statistics per process
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { snapshot, type ProcessTreeNode, type GenServerStats, type SupervisorStats } from '../stores/snapshot.js';
  import {
    formatNumber,
    formatUptime,
    truncate,
  } from '../utils/formatters.js';

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  interface Props {
    /** Maximum display length for process IDs. */
    idMaxLength?: number;
    /** Whether to show detailed process statistics. */
    showDetails?: boolean;
    /** Callback when a process node is selected. */
    onProcessSelect?: (node: ProcessTreeNode) => void;
    /** ID of the currently selected process. */
    selectedProcessId?: string | null;
  }

  /**
   * GenServer status from stats.
   */
  type GenServerStatus = GenServerStats['status'];

  /**
   * Display configuration for process status.
   */
  interface StatusDisplay {
    readonly icon: string;
    readonly label: string;
    readonly className: string;
  }

  /**
   * Tree connector characters for consistent rendering.
   */
  const TREE_CHARS = {
    BRANCH: '\u251C',      // ├
    LAST_BRANCH: '\u2514', // └
    VERTICAL: '\u2502',    // │
    HORIZONTAL: '\u2500',  // ─
    COLLAPSED: '\u25B6',   // ▶
    EXPANDED: '\u25BC',    // ▼
    SUPERVISOR: '\u25BC',  // ▼
    RUNNING: '\u25CF',     // ●
    STOPPED: '\u25CB',     // ○
  } as const;

  // ---------------------------------------------------------------------------
  // Props
  // ---------------------------------------------------------------------------

  const {
    idMaxLength = 32,
    showDetails = true,
    onProcessSelect,
    selectedProcessId = null,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Internal State
  // ---------------------------------------------------------------------------

  let expandedNodes = $state<Set<string>>(new Set());
  let treeContainer: HTMLElement | null = $state(null);

  // Store subscriptions
  let treeValue = $state<readonly ProcessTreeNode[]>([]);
  let processCountValue = $state(0);
  let supervisorCountValue = $state(0);
  let serverCountValue = $state(0);
  let unsubscribers: Array<() => void> = [];

  onMount(() => {
    unsubscribers = [
      snapshot.tree.subscribe((v) => (treeValue = v)),
      snapshot.processCount.subscribe((v) => (processCountValue = v)),
      snapshot.supervisorCount.subscribe((v) => (supervisorCountValue = v)),
      snapshot.serverCount.subscribe((v) => (serverCountValue = v)),
    ];
  });

  onDestroy(() => {
    unsubscribers.forEach((fn) => fn());
  });

  // ---------------------------------------------------------------------------
  // Status Configuration
  // ---------------------------------------------------------------------------

  const GENSERVER_STATUS_MAP: Readonly<Record<GenServerStatus, StatusDisplay>> = {
    initializing: { icon: TREE_CHARS.RUNNING, label: 'Initializing', className: 'status-initializing' },
    running: { icon: TREE_CHARS.RUNNING, label: 'Running', className: 'status-running' },
    stopping: { icon: TREE_CHARS.STOPPED, label: 'Stopping', className: 'status-stopping' },
    stopped: { icon: TREE_CHARS.STOPPED, label: 'Stopped', className: 'status-stopped' },
  };

  // ---------------------------------------------------------------------------
  // Computed Values
  // ---------------------------------------------------------------------------

  const hasProcesses = $derived(treeValue.length > 0);

  // Initialize all supervisors as expanded on first render
  $effect(() => {
    if (treeValue.length > 0 && expandedNodes.size === 0) {
      const initialExpanded = new Set<string>();
      collectSupervisorIds(treeValue, initialExpanded);
      expandedNodes = initialExpanded;
    }
  });

  // ---------------------------------------------------------------------------
  // Tree Traversal Helpers
  // ---------------------------------------------------------------------------

  /**
   * Recursively collects all supervisor IDs for initial expansion.
   */
  function collectSupervisorIds(nodes: readonly ProcessTreeNode[], ids: Set<string>): void {
    for (const node of nodes) {
      if (node.type === 'supervisor') {
        ids.add(node.id);
        if (node.children) {
          collectSupervisorIds(node.children, ids);
        }
      }
    }
  }

  /**
   * Flattens the visible tree into an ordered array for keyboard navigation.
   */
  function flattenVisibleTree(nodes: readonly ProcessTreeNode[]): ProcessTreeNode[] {
    const result: ProcessTreeNode[] = [];

    function traverse(nodeList: readonly ProcessTreeNode[]): void {
      for (const node of nodeList) {
        result.push(node);
        if (node.type === 'supervisor' && node.children && isNodeExpanded(node.id)) {
          traverse(node.children);
        }
      }
    }

    traverse(nodes);
    return result;
  }

  const visibleNodes = $derived(flattenVisibleTree(treeValue));

  const selectedIndex = $derived(
    selectedProcessId !== null
      ? visibleNodes.findIndex(n => n.id === selectedProcessId)
      : -1
  );

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  function handleNodeClick(node: ProcessTreeNode): void {
    onProcessSelect?.(node);
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

  function handleKeyDown(event: KeyboardEvent): void {
    if (!hasProcesses) return;

    let newIndex = selectedIndex;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        newIndex = selectedIndex < visibleNodes.length - 1 ? selectedIndex + 1 : 0;
        break;

      case 'ArrowUp':
        event.preventDefault();
        newIndex = selectedIndex > 0 ? selectedIndex - 1 : visibleNodes.length - 1;
        break;

      case 'ArrowRight': {
        event.preventDefault();
        const node = visibleNodes[selectedIndex];
        if (node?.type === 'supervisor' && !isNodeExpanded(node.id)) {
          const newSet = new Set(expandedNodes);
          newSet.add(node.id);
          expandedNodes = newSet;
        }
        return;
      }

      case 'ArrowLeft': {
        event.preventDefault();
        const node = visibleNodes[selectedIndex];
        if (node?.type === 'supervisor' && isNodeExpanded(node.id)) {
          const newSet = new Set(expandedNodes);
          newSet.delete(node.id);
          expandedNodes = newSet;
        }
        return;
      }

      case 'Home':
        event.preventDefault();
        newIndex = 0;
        break;

      case 'End':
        event.preventDefault();
        newIndex = visibleNodes.length - 1;
        break;

      case 'Enter':
      case ' ':
        event.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < visibleNodes.length) {
          const node = visibleNodes[selectedIndex];
          if (node) {
            onProcessSelect?.(node);
          }
        }
        return;

      default:
        return;
    }

    if (newIndex !== selectedIndex && newIndex >= 0) {
      const node = visibleNodes[newIndex];
      if (node) {
        onProcessSelect?.(node);
        scrollToNode(newIndex);
      }
    }
  }

  function scrollToNode(index: number): void {
    if (!treeContainer) return;

    const items = treeContainer.querySelectorAll('.tree-node');
    const item = items[index];
    if (item) {
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ---------------------------------------------------------------------------
  // Node Rendering Helpers
  // ---------------------------------------------------------------------------

  function getGenServerStatus(stats: GenServerStats): StatusDisplay {
    return GENSERVER_STATUS_MAP[stats.status];
  }

  function getSupervisorIcon(isExpanded: boolean): string {
    return isExpanded ? TREE_CHARS.EXPANDED : TREE_CHARS.COLLAPSED;
  }

  function getProcessDisplayName(node: ProcessTreeNode): string {
    return truncate(node.name ?? node.id, idMaxLength);
  }

  function getProcessStatusSummary(node: ProcessTreeNode): string {
    if (node.type === 'supervisor') {
      const stats = node.stats as SupervisorStats;
      return `${stats.childCount} children, ${stats.totalRestarts} restarts`;
    }
    const stats = node.stats as GenServerStats;
    return stats.status;
  }

  function getGenServerDetails(stats: GenServerStats): string {
    const parts: string[] = [];
    if (stats.queueSize > 0) {
      parts.push(`queue: ${stats.queueSize}`);
    }
    parts.push(`msgs: ${formatNumber(stats.messageCount)}`);
    parts.push(formatUptime(stats.uptimeMs));
    return parts.join(' | ');
  }

  function getSupervisorDetails(stats: SupervisorStats): string {
    return `strategy: ${stats.strategy}`;
  }

  function shouldHighlightNode(node: ProcessTreeNode): boolean {
    if (node.type === 'genserver') {
      const stats = node.stats as GenServerStats;
      return stats.queueSize > 10 || stats.status !== 'running';
    }
    if (node.type === 'supervisor') {
      const stats = node.stats as SupervisorStats;
      return stats.totalRestarts > 0;
    }
    return false;
  }
</script>

<div class="process-tree" role="tree" aria-label="Process supervision tree">
  {#if !hasProcesses}
    <div class="empty-state">
      <span class="empty-icon" aria-hidden="true">{TREE_CHARS.SUPERVISOR}</span>
      <p class="empty-message">No processes running</p>
      <p class="empty-hint">Processes will appear here when started</p>
    </div>
  {:else}
    <header class="tree-header">
      <div class="header-stats">
        <span class="stat">
          <span class="stat-value">{processCountValue}</span>
          <span class="stat-label">processes</span>
        </span>
        <span class="stat">
          <span class="stat-value">{supervisorCountValue}</span>
          <span class="stat-label">supervisors</span>
        </span>
        <span class="stat">
          <span class="stat-value">{serverCountValue}</span>
          <span class="stat-label">servers</span>
        </span>
      </div>
    </header>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
    <div
      class="tree-body"
      bind:this={treeContainer}
      onkeydown={handleKeyDown}
      role="group"
      tabindex="0"
    >
      {#snippet renderNodes(nodes: readonly ProcessTreeNode[], prefix: string, isRoot: boolean)}
        {#each nodes as node, index (node.id)}
          {@const isLast = index === nodes.length - 1}
          {@const isSelected = selectedProcessId === node.id}
          {@const isExpanded = isNodeExpanded(node.id)}
          {@const isSupervisor = node.type === 'supervisor'}
          {@const hasChildren = isSupervisor && node.children && node.children.length > 0}
          {@const highlighted = shouldHighlightNode(node)}

          <div
            class="tree-node"
            class:selected={isSelected}
            class:highlighted={highlighted}
            class:supervisor={isSupervisor}
            role="treeitem"
            aria-selected={isSelected}
            aria-expanded={isSupervisor ? isExpanded : undefined}
          >
            <div class="node-row-wrapper">
              <!-- Expand/collapse toggle for supervisors (outside main button) -->
              {#if isSupervisor && hasChildren}
                <button
                  type="button"
                  class="expand-toggle"
                  onclick={(e) => toggleNodeExpanded(node.id, e)}
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                >
                  {getSupervisorIcon(isExpanded)}
                </button>
              {:else if isSupervisor}
                <span class="expand-placeholder">{TREE_CHARS.SUPERVISOR}</span>
              {:else}
                {@const stats = node.stats as GenServerStats}
                {@const statusDisplay = getGenServerStatus(stats)}
                <span
                  class="status-icon {statusDisplay.className}"
                  title={statusDisplay.label}
                >
                  {statusDisplay.icon}
                </span>
              {/if}

              <button
                type="button"
                class="node-row"
                onclick={() => handleNodeClick(node)}
              >
                <!-- Tree structure prefix -->
                <span class="tree-prefix" aria-hidden="true">
                  {#if !isRoot}
                    {prefix}{isLast ? TREE_CHARS.LAST_BRANCH : TREE_CHARS.BRANCH}{TREE_CHARS.HORIZONTAL}
                  {/if}
                </span>

                <!-- Process name -->
                <span class="node-name" title={node.id}>
                  {getProcessDisplayName(node)}
                </span>

                <!-- Status summary -->
                <span class="node-status">
                  ({getProcessStatusSummary(node)})
                </span>

                <!-- Details (optional) -->
                {#if showDetails}
                  <span class="node-details">
                    {#if isSupervisor}
                      {getSupervisorDetails(node.stats as SupervisorStats)}
                    {:else}
                      {getGenServerDetails(node.stats as GenServerStats)}
                    {/if}
                  </span>
                {/if}
              </button>
            </div>
          </div>

          <!-- Render children if expanded -->
          {#if isSupervisor && hasChildren && isExpanded}
            {@const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : `${TREE_CHARS.VERTICAL}  `)}
            {@render renderNodes(node.children!, childPrefix, false)}
          {/if}
        {/each}
      {/snippet}

      {@render renderNodes(treeValue, '', true)}
    </div>
  {/if}
</div>

<style>
  .process-tree {
    display: flex;
    flex-direction: column;
    height: 100%;
    background-color: var(--color-background-elevated);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
    font-size: 0.8125rem;
    overflow: hidden;
  }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
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
    padding: 0.625rem 0.75rem;
    border-bottom: 1px solid var(--color-border-muted);
    flex-shrink: 0;
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
    font-size: 0.6875rem;
    color: var(--color-text-muted);
  }

  /* Tree body */
  .tree-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0.5rem 0;
  }

  .tree-body:focus {
    outline: none;
  }

  .tree-body:focus-visible {
    box-shadow: inset 0 0 0 2px var(--color-border-focus);
  }

  /* Tree node */
  .tree-node {
    position: relative;
  }

  .tree-node.highlighted::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background-color: var(--color-warning);
  }

  .tree-node.selected .node-row-wrapper {
    background-color: var(--color-selected);
  }

  /* Node row wrapper (flex container for toggle + button) */
  .node-row-wrapper {
    display: flex;
    align-items: center;
    padding-left: 0.5rem;
    transition: background-color 100ms ease;
  }

  .node-row-wrapper:hover {
    background-color: var(--color-hover);
  }

  /* Node row (button) */
  .node-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex: 1;
    min-width: 0;
    padding: 0.25rem 0.75rem 0.25rem 0.25rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;
  }

  .node-row:focus {
    outline: none;
  }

  .node-row:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
    border-radius: 2px;
  }

  /* Tree prefix (connectors) */
  .tree-prefix {
    flex-shrink: 0;
    color: var(--color-text-muted);
    white-space: pre;
    user-select: none;
  }

  /* Expand toggle */
  .expand-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    padding: 0;
    background: none;
    border: none;
    border-radius: 2px;
    cursor: pointer;
    color: var(--color-secondary);
    font-size: 0.625rem;
    transition: background-color 100ms ease;
  }

  .expand-toggle:hover {
    background-color: var(--color-active);
    color: var(--color-text);
  }

  .expand-toggle:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 0;
  }

  .expand-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    font-size: 0.625rem;
    color: var(--color-secondary);
  }

  /* Status icon */
  .status-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    font-size: 0.625rem;
  }

  .status-icon.status-initializing {
    color: var(--color-primary);
  }

  .status-icon.status-running {
    color: var(--color-success);
  }

  .status-icon.status-stopping {
    color: var(--color-warning);
  }

  .status-icon.status-stopped {
    color: var(--color-error);
  }

  /* Node name */
  .node-name {
    flex-shrink: 0;
    font-weight: 500;
    color: var(--color-text);
    white-space: nowrap;
  }

  .supervisor .node-name {
    color: var(--color-secondary);
  }

  /* Node status */
  .node-status {
    flex-shrink: 0;
    color: var(--color-text-muted);
    font-size: 0.75rem;
    white-space: nowrap;
  }

  /* Node details */
  .node-details {
    flex: 1;
    min-width: 0;
    text-align: right;
    color: var(--color-text-muted);
    font-size: 0.6875rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }

  /* Responsive */
  @media (max-width: 640px) {
    .header-stats {
      gap: 0.5rem;
    }

    .stat-label {
      display: none;
    }

    .node-details {
      display: none;
    }
  }

  @media (max-width: 480px) {
    .node-status {
      display: none;
    }
  }
</style>
