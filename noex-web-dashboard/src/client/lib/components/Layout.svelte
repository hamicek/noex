<!--
  Layout.svelte - Grid composition component for dashboard layouts.

  Orchestrates the arrangement of dashboard widgets based on layout mode:
  - Full: All widgets visible in a multi-column grid
  - Compact: Main view and stats table only
  - Minimal: Single-panel focused view

  Provides consistent spacing, responsive behavior, and proper
  accessibility landmarks for all layout configurations.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { StatusBar } from './index.js';
  import ProcessTree from './ProcessTree.svelte';
  import ClusterTree from './ClusterTree.svelte';
  import StatsTable from './StatsTable.svelte';
  import MemoryGauge from './MemoryGauge.svelte';
  import EventLog from './EventLog.svelte';
  import type { ProcessTreeNode, GenServerStats } from '../stores/snapshot.js';

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  /**
   * Available layout modes.
   */
  export type LayoutMode = 'full' | 'compact' | 'minimal';

  /**
   * Available view modes.
   */
  export type ViewMode = 'local' | 'cluster';

  interface Props {
    /** Current layout mode. */
    layoutMode?: LayoutMode;
    /** Current view mode (local or cluster). */
    viewMode?: ViewMode;
    /** Dashboard start time for uptime display. */
    startTime?: number;
    /** Currently selected process ID. */
    selectedProcessId?: string | null;
    /** Currently selected cluster node ID. */
    selectedNodeId?: string | null;
    /** Callback when a process is selected. */
    onProcessSelect?: (node: ProcessTreeNode) => void;
    /** Callback when a cluster node is selected. */
    onNodeSelect?: (nodeId: string) => void;
    /** Callback when a server is clicked in stats table. */
    onServerClick?: (server: GenServerStats) => void;
    /** Optional custom header content. */
    header?: Snippet;
    /** Optional overlay content (connection status, etc.). */
    overlay?: Snippet;
  }

  // ---------------------------------------------------------------------------
  // Props
  // ---------------------------------------------------------------------------

  const {
    layoutMode = 'full',
    viewMode = 'local',
    startTime = Date.now(),
    selectedProcessId = null,
    selectedNodeId = null,
    onProcessSelect,
    onNodeSelect,
    onServerClick,
    header,
    overlay,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Derived State
  // ---------------------------------------------------------------------------

  const isClusterView = $derived(viewMode === 'cluster');

  // ---------------------------------------------------------------------------
  // Layout Configuration
  // ---------------------------------------------------------------------------

  /**
   * Widget visibility configuration per layout mode.
   */
  interface LayoutConfig {
    readonly showMainPanel: boolean;
    readonly showStatsPanel: boolean;
    readonly showMemoryPanel: boolean;
    readonly showEventsPanel: boolean;
    readonly showDetails: boolean;
  }

  const LAYOUT_CONFIGS: Readonly<Record<LayoutMode, LayoutConfig>> = {
    full: {
      showMainPanel: true,
      showStatsPanel: true,
      showMemoryPanel: true,
      showEventsPanel: true,
      showDetails: true,
    },
    compact: {
      showMainPanel: true,
      showStatsPanel: true,
      showMemoryPanel: false,
      showEventsPanel: false,
      showDetails: false,
    },
    minimal: {
      showMainPanel: false,
      showStatsPanel: true,
      showMemoryPanel: false,
      showEventsPanel: false,
      showDetails: false,
    },
  };

  const config = $derived(LAYOUT_CONFIGS[layoutMode]);

  // ---------------------------------------------------------------------------
  // Server Selection Handling
  // ---------------------------------------------------------------------------

  let selectedServerId = $state<string | null>(null);

  function handleServerClick(server: GenServerStats): void {
    selectedServerId = server.id;
    onServerClick?.(server);
  }

  function handleServerSelectionChange(server: GenServerStats | null): void {
    selectedServerId = server?.id ?? null;
  }
</script>

<div
  class="layout"
  class:layout-full={layoutMode === 'full'}
  class:layout-compact={layoutMode === 'compact'}
  class:layout-minimal={layoutMode === 'minimal'}
>
  {#if header}
    {@render header()}
  {/if}

  <main class="layout-content">
    {#if overlay}
      {@render overlay()}
    {/if}

    {#if layoutMode === 'full'}
      <!-- Full layout: 2-column grid with all widgets -->
      <div class="grid grid-full">
        <section class="widget-panel panel-main" aria-label="Process view">
          {#if isClusterView}
            <ClusterTree
              showDetails={config.showDetails}
              onNodeSelect={onNodeSelect}
              onServerClick={onServerClick}
              selectedNodeId={selectedNodeId}
            />
          {:else}
            <ProcessTree
              showDetails={config.showDetails}
              onProcessSelect={onProcessSelect}
              selectedProcessId={selectedProcessId}
            />
          {/if}
        </section>

        <section class="widget-panel panel-stats" aria-label="Process statistics">
          <StatsTable
            showToolbar={true}
            selectedId={selectedServerId}
            onProcessClick={handleServerClick}
            onSelectionChange={handleServerSelectionChange}
          />
        </section>

        <section class="widget-panel panel-memory" aria-label="Memory usage">
          <MemoryGauge showDetails={true} />
        </section>

        <section class="widget-panel panel-events" aria-label="Event log">
          <EventLog showToolbar={true} maxDisplayCount={100} />
        </section>
      </div>

    {:else if layoutMode === 'compact'}
      <!-- Compact layout: 2-column grid, main + stats only -->
      <div class="grid grid-compact">
        <section class="widget-panel panel-main" aria-label="Process view">
          {#if isClusterView}
            <ClusterTree
              showDetails={config.showDetails}
              onNodeSelect={onNodeSelect}
              onServerClick={onServerClick}
              selectedNodeId={selectedNodeId}
            />
          {:else}
            <ProcessTree
              showDetails={config.showDetails}
              onProcessSelect={onProcessSelect}
              selectedProcessId={selectedProcessId}
            />
          {/if}
        </section>

        <section class="widget-panel panel-stats" aria-label="Process statistics">
          <StatsTable
            showToolbar={true}
            selectedId={selectedServerId}
            onProcessClick={handleServerClick}
            onSelectionChange={handleServerSelectionChange}
          />
        </section>
      </div>

    {:else}
      <!-- Minimal layout: single full-width panel -->
      <div class="grid grid-minimal">
        <section class="widget-panel panel-full" aria-label="Process statistics">
          {#if isClusterView}
            <ClusterTree
              showDetails={false}
              onNodeSelect={onNodeSelect}
              onServerClick={onServerClick}
              selectedNodeId={selectedNodeId}
            />
          {:else}
            <StatsTable
              showToolbar={true}
              maxRows={200}
              selectedId={selectedServerId}
              onProcessClick={handleServerClick}
              onSelectionChange={handleServerSelectionChange}
            />
          {/if}
        </section>
      </div>
    {/if}
  </main>

  <StatusBar
    viewMode={viewMode}
    layoutMode={layoutMode}
    startTime={startTime}
  />
</div>

<style>
  /* ---------------------------------------------------------------------------
   * Layout Container
   * ------------------------------------------------------------------------- */

  .layout {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background-color: var(--color-background);
    color: var(--color-text);
  }

  /* ---------------------------------------------------------------------------
   * Content Area
   * ------------------------------------------------------------------------- */

  .layout-content {
    flex: 1;
    min-height: 0;
    padding: 1rem;
    overflow: auto;
    position: relative;
  }

  /* ---------------------------------------------------------------------------
   * Grid Systems
   * ------------------------------------------------------------------------- */

  .grid {
    display: grid;
    gap: 1rem;
    height: 100%;
    min-height: 0;
  }

  /* Full layout: 2 columns, 3 rows */
  .grid-full {
    grid-template-columns: minmax(300px, 1fr) minmax(400px, 2fr);
    grid-template-rows: 2fr auto 1fr;
    grid-template-areas:
      "main stats"
      "main memory"
      "events events";
  }

  .grid-full .panel-main {
    grid-area: main;
  }

  .grid-full .panel-stats {
    grid-area: stats;
  }

  .grid-full .panel-memory {
    grid-area: memory;
  }

  .grid-full .panel-events {
    grid-area: events;
  }

  /* Compact layout: 2 columns, single row */
  .grid-compact {
    grid-template-columns: minmax(280px, 1fr) minmax(350px, 2fr);
    grid-template-rows: 1fr;
    grid-template-areas: "main stats";
  }

  .grid-compact .panel-main {
    grid-area: main;
  }

  .grid-compact .panel-stats {
    grid-area: stats;
  }

  /* Minimal layout: single column */
  .grid-minimal {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr;
  }

  .grid-minimal .panel-full {
    min-height: 0;
  }

  /* ---------------------------------------------------------------------------
   * Widget Panels
   * ------------------------------------------------------------------------- */

  .widget-panel {
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  /* Ensure child components fill their containers */
  .widget-panel > :global(*) {
    height: 100%;
  }

  /* ---------------------------------------------------------------------------
   * Responsive Adjustments
   * ------------------------------------------------------------------------- */

  @media (max-width: 1024px) {
    .grid-full {
      grid-template-columns: 1fr 1fr;
      grid-template-rows: 1fr auto 1fr;
      grid-template-areas:
        "main stats"
        "main memory"
        "events events";
    }
  }

  @media (max-width: 768px) {
    .layout-content {
      padding: 0.75rem;
    }

    .grid {
      gap: 0.75rem;
    }

    /* Stack all panels vertically on mobile */
    .grid-full {
      grid-template-columns: 1fr;
      grid-template-rows: auto auto auto auto;
      grid-template-areas:
        "main"
        "stats"
        "memory"
        "events";
    }

    .grid-compact {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr 1fr;
      grid-template-areas:
        "main"
        "stats";
    }

    /* Set minimum heights for stacked panels */
    .grid-full .panel-main,
    .grid-compact .panel-main {
      min-height: 250px;
    }

    .grid-full .panel-stats,
    .grid-compact .panel-stats {
      min-height: 200px;
    }

    .grid-full .panel-memory {
      min-height: 120px;
    }

    .grid-full .panel-events {
      min-height: 180px;
    }
  }

  @media (max-width: 480px) {
    .layout-content {
      padding: 0.5rem;
    }

    .grid {
      gap: 0.5rem;
    }
  }

  /* ---------------------------------------------------------------------------
   * Layout Mode Specific Overrides
   * ------------------------------------------------------------------------- */

  /* Full layout can have taller events panel on large screens */
  @media (min-height: 900px) {
    .layout-full .grid-full {
      grid-template-rows: 2fr auto 1.5fr;
    }
  }

  /* Compact layout optimization for wide screens */
  @media (min-width: 1400px) {
    .grid-compact {
      grid-template-columns: minmax(300px, 1fr) minmax(500px, 3fr);
    }
  }

  /* Minimal layout - maximize content area */
  .layout-minimal .layout-content {
    padding: 0.75rem;
  }

  .layout-minimal .grid-minimal {
    gap: 0;
  }
</style>
