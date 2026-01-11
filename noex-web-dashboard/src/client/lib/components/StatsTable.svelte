<!--
  StatsTable.svelte - Sortable process statistics table.

  Displays GenServer statistics in a tabular format with:
  - Sortable columns (click header to sort)
  - Row selection with keyboard navigation
  - Visual status indicators
  - Click handler for process details
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { snapshot, type GenServerStats } from '../stores/snapshot.js';
  import {
    formatNumber,
    formatBytes,
    formatUptime,
    truncate,
  } from '../utils/formatters.js';

  /**
   * Server status type from GenServerStats.
   */
  type ServerStatus = GenServerStats['status'];

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  interface Props {
    /** Maximum number of rows to display. @default 100 */
    maxRows?: number;
    /** Whether to show the toolbar with count and controls. @default true */
    showToolbar?: boolean;
    /** ID of the currently selected process. */
    selectedId?: string | null;
    /** Callback when a process row is clicked. */
    onProcessClick?: (server: GenServerStats) => void;
    /** Callback when selection changes via keyboard. */
    onSelectionChange?: (server: GenServerStats | null) => void;
  }

  /**
   * Sortable column identifiers.
   */
  type SortColumn = 'id' | 'status' | 'queueSize' | 'messageCount' | 'uptimeMs' | 'stateMemoryBytes';

  /**
   * Sort direction.
   */
  type SortDirection = 'asc' | 'desc';

  /**
   * Column configuration.
   */
  interface ColumnConfig {
    readonly key: SortColumn;
    readonly label: string;
    readonly width: string;
    readonly align: 'left' | 'right';
    readonly sortable: boolean;
  }

  // ---------------------------------------------------------------------------
  // Props & State
  // ---------------------------------------------------------------------------

  const {
    maxRows = 100,
    showToolbar = true,
    selectedId = null,
    onProcessClick,
    onSelectionChange,
  }: Props = $props();

  let sortColumn = $state<SortColumn>('id');
  let sortDirection = $state<SortDirection>('asc');
  let tableContainer: HTMLElement | null = $state(null);

  // Store subscription
  let serversValue = $state<readonly GenServerStats[]>([]);
  let unsubscribe: (() => void) | null = null;

  onMount(() => {
    unsubscribe = snapshot.servers.subscribe(v => serversValue = v);
  });

  onDestroy(() => {
    unsubscribe?.();
  });

  // ---------------------------------------------------------------------------
  // Column Configuration
  // ---------------------------------------------------------------------------

  const COLUMNS: readonly ColumnConfig[] = [
    { key: 'id', label: 'ID', width: '1fr', align: 'left', sortable: true },
    { key: 'status', label: 'Status', width: '90px', align: 'left', sortable: true },
    { key: 'queueSize', label: 'Queue', width: '70px', align: 'right', sortable: true },
    { key: 'messageCount', label: 'Messages', width: '90px', align: 'right', sortable: true },
    { key: 'uptimeMs', label: 'Uptime', width: '90px', align: 'right', sortable: true },
    { key: 'stateMemoryBytes', label: 'Memory', width: '80px', align: 'right', sortable: true },
  ] as const;

  // ---------------------------------------------------------------------------
  // Derived State
  // ---------------------------------------------------------------------------

  /**
   * Sorted servers based on current sort configuration.
   */
  const sortedServers = $derived(sortServers(serversValue, sortColumn, sortDirection));

  /**
   * Servers limited to maxRows.
   */
  const displayServers = $derived(sortedServers.slice(0, maxRows));

  /**
   * Whether there are servers to display.
   */
  const hasServers = $derived(displayServers.length > 0);

  /**
   * Total server count.
   */
  const serverCount = $derived(serversValue.length);

  /**
   * Index of currently selected row.
   */
  const selectedIndex = $derived(
    selectedId !== null
      ? displayServers.findIndex(s => s.id === selectedId)
      : -1
  );

  // ---------------------------------------------------------------------------
  // Sorting Logic
  // ---------------------------------------------------------------------------

  /**
   * Sorts servers by the specified column and direction.
   */
  function sortServers(
    servers: readonly GenServerStats[],
    column: SortColumn,
    direction: SortDirection
  ): readonly GenServerStats[] {
    if (servers.length === 0) return servers;

    const sorted = [...servers].sort((a, b) => {
      const aVal = getColumnValue(a, column);
      const bVal = getColumnValue(b, column);

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return direction === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }

      const aNum = aVal as number;
      const bNum = bVal as number;
      return direction === 'asc' ? aNum - bNum : bNum - aNum;
    });

    return sorted;
  }

  /**
   * Extracts the sortable value from a server for a given column.
   */
  function getColumnValue(server: GenServerStats, column: SortColumn): string | number {
    switch (column) {
      case 'id':
        return server.id;
      case 'status':
        return server.status;
      case 'queueSize':
        return server.queueSize;
      case 'messageCount':
        return server.messageCount;
      case 'uptimeMs':
        return server.uptimeMs;
      case 'stateMemoryBytes':
        return server.stateMemoryBytes ?? 0;
    }
  }

  /**
   * Handles column header click to toggle sort.
   */
  function handleColumnClick(column: SortColumn): void {
    if (column === sortColumn) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortColumn = column;
      sortDirection = 'desc';
    }
  }

  /**
   * Gets sort indicator for a column.
   */
  function getSortIndicator(column: SortColumn): string {
    if (column !== sortColumn) return '';
    return sortDirection === 'asc' ? ' \u25B2' : ' \u25BC';
  }

  // ---------------------------------------------------------------------------
  // Row Formatting
  // ---------------------------------------------------------------------------

  /**
   * Status display configuration.
   */
  interface StatusDisplay {
    readonly text: string;
    readonly className: string;
  }

  /**
   * Maps server status to display configuration.
   */
  function getStatusDisplay(status: ServerStatus): StatusDisplay {
    switch (status) {
      case 'initializing':
        return { text: 'Initializing', className: 'status-initializing' };
      case 'running':
        return { text: 'Running', className: 'status-running' };
      case 'stopping':
        return { text: 'Stopping', className: 'status-stopping' };
      case 'stopped':
        return { text: 'Stopped', className: 'status-stopped' };
    }
  }

  /**
   * Formats a cell value for display.
   */
  function formatCellValue(server: GenServerStats, column: SortColumn): string {
    switch (column) {
      case 'id':
        return truncate(server.id, 40);
      case 'status':
        return getStatusDisplay(server.status).text;
      case 'queueSize':
        return String(server.queueSize);
      case 'messageCount':
        return formatNumber(server.messageCount);
      case 'uptimeMs':
        return formatUptime(server.uptimeMs);
      case 'stateMemoryBytes':
        return server.stateMemoryBytes !== undefined
          ? formatBytes(server.stateMemoryBytes)
          : '-';
    }
  }

  /**
   * Determines if a server row should be highlighted (has issues).
   */
  function shouldHighlight(server: GenServerStats): boolean {
    return server.queueSize > 10 || server.status !== 'running';
  }

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  /**
   * Handles row click.
   */
  function handleRowClick(server: GenServerStats): void {
    onProcessClick?.(server);
  }

  /**
   * Handles keyboard navigation.
   */
  function handleKeyDown(event: KeyboardEvent): void {
    if (!hasServers) return;

    let newIndex = selectedIndex;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        newIndex = selectedIndex < displayServers.length - 1 ? selectedIndex + 1 : 0;
        break;

      case 'ArrowUp':
        event.preventDefault();
        newIndex = selectedIndex > 0 ? selectedIndex - 1 : displayServers.length - 1;
        break;

      case 'Home':
        event.preventDefault();
        newIndex = 0;
        break;

      case 'End':
        event.preventDefault();
        newIndex = displayServers.length - 1;
        break;

      case 'Enter':
      case ' ':
        event.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < displayServers.length) {
          const server = displayServers[selectedIndex];
          if (server) {
            onProcessClick?.(server);
          }
        }
        return;

      default:
        return;
    }

    if (newIndex !== selectedIndex && newIndex >= 0) {
      const server = displayServers[newIndex];
      if (server) {
        onSelectionChange?.(server);
        scrollToRow(newIndex);
      }
    }
  }

  /**
   * Scrolls to ensure a row is visible.
   */
  function scrollToRow(index: number): void {
    if (!tableContainer) return;

    const rows = tableContainer.querySelectorAll('.table-row');
    const row = rows[index];
    if (row) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ---------------------------------------------------------------------------
  // Grid Template
  // ---------------------------------------------------------------------------

  const gridTemplate = $derived(
    COLUMNS.map(col => col.width).join(' ')
  );
</script>

<div class="stats-table" role="region" aria-label="Process statistics">
  {#if showToolbar}
    <header class="table-toolbar">
      <span class="server-count">
        {serverCount} {serverCount === 1 ? 'process' : 'processes'}
        {#if serverCount > maxRows}
          <span class="truncated">(showing {maxRows})</span>
        {/if}
      </span>

      <div class="sort-info">
        Sorted by: <strong>{COLUMNS.find(c => c.key === sortColumn)?.label}</strong>
        {sortDirection === 'asc' ? '(asc)' : '(desc)'}
      </div>
    </header>
  {/if}

  <div class="table-header" style:grid-template-columns={gridTemplate}>
    {#each COLUMNS as column}
      {#if column.sortable}
        <button
          type="button"
          class="header-cell"
          class:sorted={column.key === sortColumn}
          class:align-right={column.align === 'right'}
          onclick={() => handleColumnClick(column.key)}
          title="Sort by {column.label}"
        >
          {column.label}{getSortIndicator(column.key)}
        </button>
      {:else}
        <div
          class="header-cell"
          class:align-right={column.align === 'right'}
        >
          {column.label}
        </div>
      {/if}
    {/each}
  </div>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="table-body"
    bind:this={tableContainer}
    onkeydown={handleKeyDown}
    role="grid"
    tabindex="0"
    aria-rowcount={displayServers.length}
  >
    {#if hasServers}
      {#each displayServers as server, index (server.id)}
        <button
          type="button"
          class="table-row"
          class:selected={server.id === selectedId}
          class:highlighted={shouldHighlight(server)}
          style:grid-template-columns={gridTemplate}
          onclick={() => handleRowClick(server)}
          role="row"
          aria-rowindex={index + 1}
          aria-selected={server.id === selectedId}
        >
          {#each COLUMNS as column}
            <span
              class="table-cell"
              class:align-right={column.align === 'right'}
              class:cell-status={column.key === 'status'}
              class:cell-queue-warning={column.key === 'queueSize' && server.queueSize > 10}
              class:status-initializing={column.key === 'status' && server.status === 'initializing'}
              class:status-running={column.key === 'status' && server.status === 'running'}
              class:status-stopping={column.key === 'status' && server.status === 'stopping'}
              class:status-stopped={column.key === 'status' && server.status === 'stopped'}
              role="gridcell"
            >
              {formatCellValue(server, column.key)}
            </span>
          {/each}
        </button>
      {/each}
    {:else}
      <div class="table-empty">
        <p>No processes</p>
        <p class="empty-hint">Processes will appear here when started</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .stats-table {
    display: flex;
    flex-direction: column;
    height: 100%;
    background-color: var(--color-background-elevated);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
  }

  /* Toolbar */
  .table-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0.75rem;
    background-color: var(--color-background-sunken);
    border-bottom: 1px solid var(--color-border-muted);
    flex-shrink: 0;
  }

  .server-count {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }

  .truncated {
    color: var(--color-text-muted);
    opacity: 0.7;
  }

  .sort-info {
    font-size: 0.6875rem;
    color: var(--color-text-muted);
  }

  .sort-info strong {
    color: var(--color-text);
  }

  /* Header */
  .table-header {
    display: grid;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background-color: var(--color-background-sunken);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .header-cell {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
    transition: color 100ms ease;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .header-cell:hover {
    color: var(--color-text);
  }

  .header-cell.sorted {
    color: var(--color-primary);
  }

  .header-cell.align-right {
    text-align: right;
  }

  /* Body */
  .table-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
    font-size: 0.75rem;
    line-height: 1.4;
  }

  .table-body:focus {
    outline: none;
  }

  .table-body:focus-visible {
    box-shadow: inset 0 0 0 2px var(--color-border-focus);
  }

  /* Rows */
  .table-row {
    display: grid;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem;
    width: 100%;
    background: none;
    border: none;
    border-bottom: 1px solid var(--color-border-muted);
    cursor: pointer;
    text-align: left;
    font: inherit;
    transition: background-color 100ms ease;
  }

  .table-row:hover {
    background-color: var(--color-hover);
  }

  .table-row:focus {
    outline: none;
    background-color: var(--color-active);
  }

  .table-row.selected {
    background-color: var(--color-selected);
  }

  .table-row.selected:hover {
    background-color: var(--color-selected);
  }

  .table-row.highlighted {
    border-left: 3px solid var(--color-warning);
    padding-left: calc(0.75rem - 3px);
  }

  .table-row:last-child {
    border-bottom: none;
  }

  /* Cells */
  .table-cell {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
  }

  .table-cell.align-right {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  /* Status Cell */
  .cell-status {
    font-weight: 500;
  }

  .cell-status.status-initializing {
    color: var(--color-primary);
  }

  .cell-status.status-running {
    color: var(--color-success);
  }

  .cell-status.status-stopping {
    color: var(--color-warning);
  }

  .cell-status.status-stopped {
    color: var(--color-error);
  }

  /* Queue Warning */
  .cell-queue-warning {
    color: var(--color-warning);
    font-weight: 600;
  }

  /* Empty State */
  .table-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 2rem;
    text-align: center;
    color: var(--color-text-muted);
  }

  .table-empty p {
    margin: 0;
  }

  .empty-hint {
    font-size: 0.6875rem;
    margin-top: 0.25rem !important;
    opacity: 0.7;
  }

  /* Responsive */
  @media (max-width: 768px) {
    .table-toolbar {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.25rem;
    }

    .table-header,
    .table-row {
      gap: 0.25rem;
      padding: 0.375rem 0.5rem;
    }
  }

  @media (max-width: 640px) {
    .header-cell:nth-child(5),
    .table-cell:nth-child(5),
    .header-cell:nth-child(6),
    .table-cell:nth-child(6) {
      display: none;
    }
  }

  @media (max-width: 480px) {
    .header-cell:nth-child(4),
    .table-cell:nth-child(4) {
      display: none;
    }
  }
</style>
