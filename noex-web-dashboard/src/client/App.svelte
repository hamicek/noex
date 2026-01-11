<!--
  App.svelte - Root application component for noex web dashboard.

  Orchestrates the entire dashboard application:
  - Theme initialization and management
  - WebSocket connection lifecycle
  - View mode switching (local/cluster)
  - Layout mode switching (full/compact/minimal)
  - Keyboard shortcut handling
  - Component coordination
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { connection } from './lib/stores/connection.js';
  import { cluster } from './lib/stores/cluster.js';
  import { themeStore } from './lib/utils/theme.js';
  import { Layout, type LayoutMode, type ViewMode } from './lib/components/index.js';
  import type { ProcessTreeNode, GenServerStats } from './lib/stores/snapshot.js';

  // ---------------------------------------------------------------------------
  // Application State
  // ---------------------------------------------------------------------------

  let viewMode = $state<ViewMode>('local');
  let layoutMode = $state<LayoutMode>('full');
  let startTime = $state(Date.now());
  let showHelp = $state(false);
  let selectedNodeId = $state<string | null>(null);
  let selectedProcessId = $state<string | null>(null);

  // Theme cleanup function
  let themeCleanup: (() => void) | null = null;

  // ---------------------------------------------------------------------------
  // Derived State
  // ---------------------------------------------------------------------------

  const isConnected = $derived(connection.isConnected);
  const hasCluster = $derived(cluster.isAvailable);
  const isClusterView = $derived(viewMode === 'cluster');

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onMount(() => {
    // Initialize theme system
    themeCleanup = themeStore.initialize();

    // Connect to WebSocket server
    connection.connect();

    // Set up keyboard event listener
    window.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    // Clean up theme listener
    themeCleanup?.();

    // Disconnect from WebSocket
    connection.disconnect();

    // Remove keyboard event listener
    window.removeEventListener('keydown', handleKeydown);
  });

  // ---------------------------------------------------------------------------
  // Keyboard Handlers
  // ---------------------------------------------------------------------------

  function handleKeydown(event: KeyboardEvent): void {
    // Ignore if typing in an input field
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }

    // Handle help modal first
    if (showHelp) {
      if (event.key === 'Escape' || event.key === '?' || event.key === 'h') {
        showHelp = false;
        event.preventDefault();
      }
      return;
    }

    switch (event.key) {
      case 'r':
        // Refresh - request new snapshot
        handleRefresh();
        event.preventDefault();
        break;

      case 'c':
        // Toggle cluster/local view
        handleToggleView();
        event.preventDefault();
        break;

      case '1':
        // Full layout
        layoutMode = 'full';
        event.preventDefault();
        break;

      case '2':
        // Compact layout
        layoutMode = 'compact';
        event.preventDefault();
        break;

      case '3':
        // Minimal layout
        layoutMode = 'minimal';
        event.preventDefault();
        break;

      case '?':
      case 'h':
        // Show help
        showHelp = true;
        event.preventDefault();
        break;

      case 't':
        // Toggle theme
        themeStore.toggle();
        event.preventDefault();
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  function handleRefresh(): void {
    if (!connection.isConnected) return;

    if (viewMode === 'cluster') {
      connection.requestClusterSnapshot();
    } else {
      connection.requestSnapshot();
    }
  }

  function handleToggleView(): void {
    if (viewMode === 'local') {
      if (cluster.isAvailable) {
        viewMode = 'cluster';
        connection.requestClusterSnapshot();
      }
    } else {
      viewMode = 'local';
      connection.requestSnapshot();
    }
  }

  function handleNodeSelect(nodeId: string): void {
    selectedNodeId = nodeId;
  }

  function handleProcessSelect(node: ProcessTreeNode): void {
    selectedProcessId = node.id;
  }

  function handleServerClick(server: GenServerStats): void {
    selectedProcessId = server.id;
  }

  function closeHelp(): void {
    showHelp = false;
  }
</script>

<div class="app">
  <Layout
    layoutMode={layoutMode}
    viewMode={viewMode}
    startTime={startTime}
    selectedProcessId={selectedProcessId}
    selectedNodeId={selectedNodeId}
    onProcessSelect={handleProcessSelect}
    onNodeSelect={handleNodeSelect}
    onServerClick={handleServerClick}
  >
    {#snippet header()}
      <header class="app-header">
        <h1 class="app-title">noex Dashboard</h1>
        <div class="app-controls">
          <button
            type="button"
            class="control-button"
            onclick={handleRefresh}
            disabled={!isConnected}
            title="Refresh (r)"
          >
            Refresh
          </button>
          <button
            type="button"
            class="control-button"
            class:active={isClusterView}
            onclick={handleToggleView}
            disabled={!hasCluster && viewMode === 'local'}
            title="Toggle Cluster View (c)"
          >
            {isClusterView ? 'Cluster' : 'Local'}
          </button>
          <button
            type="button"
            class="control-button"
            onclick={() => themeStore.toggle()}
            title="Toggle Theme (t)"
          >
            {themeStore.isDark ? 'Light' : 'Dark'}
          </button>
        </div>
      </header>
    {/snippet}

    {#snippet overlay()}
      {#if !isConnected}
        <div class="connection-overlay">
          <div class="connection-status">
            <div class="spinner" aria-hidden="true"></div>
            <p class="status-text">
              {#if connection.state === 'connecting'}
                Connecting to server...
              {:else if connection.state === 'reconnecting'}
                Reconnecting (attempt {connection.reconnectAttempt})...
              {:else}
                Disconnected
              {/if}
            </p>
            {#if connection.hasError}
              <p class="error-text">{connection.lastError}</p>
            {/if}
          </div>
        </div>
      {/if}
    {/snippet}
  </Layout>

  <!-- Help Modal -->
  {#if showHelp}
    <div
      class="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-title"
      tabindex="-1"
      onclick={closeHelp}
      onkeydown={(e) => e.key === 'Escape' && closeHelp()}
    >
      <div class="modal-content" role="document" onclick={(e) => e.stopPropagation()} onkeypress={() => {}}>
        <header class="modal-header">
          <h2 id="help-title">Keyboard Shortcuts</h2>
          <button type="button" class="modal-close" onclick={closeHelp} aria-label="Close">
            \u2715
          </button>
        </header>
        <div class="modal-body">
          <dl class="shortcuts-list">
            <div class="shortcut-item">
              <dt><kbd>r</kbd></dt>
              <dd>Refresh data</dd>
            </div>
            <div class="shortcut-item">
              <dt><kbd>c</kbd></dt>
              <dd>Toggle cluster/local view</dd>
            </div>
            <div class="shortcut-item">
              <dt><kbd>1</kbd></dt>
              <dd>Full layout</dd>
            </div>
            <div class="shortcut-item">
              <dt><kbd>2</kbd></dt>
              <dd>Compact layout</dd>
            </div>
            <div class="shortcut-item">
              <dt><kbd>3</kbd></dt>
              <dd>Minimal layout</dd>
            </div>
            <div class="shortcut-item">
              <dt><kbd>t</kbd></dt>
              <dd>Toggle theme</dd>
            </div>
            <div class="shortcut-item">
              <dt><kbd>?</kbd> / <kbd>h</kbd></dt>
              <dd>Show this help</dd>
            </div>
            <div class="shortcut-item">
              <dt><kbd>Esc</kbd></dt>
              <dd>Close dialogs</dd>
            </div>
          </dl>
        </div>
        <footer class="modal-footer">
          <p class="help-hint">Press any key to close</p>
        </footer>
      </div>
    </div>
  {/if}
</div>

<style>
  /* ---------------------------------------------------------------------------
   * Root Application Container
   * ------------------------------------------------------------------------- */

  .app {
    height: 100vh;
    background-color: var(--color-background);
    color: var(--color-text);
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }

  /* ---------------------------------------------------------------------------
   * Header (passed to Layout via snippet)
   * ------------------------------------------------------------------------- */

  .app-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    background-color: var(--color-background-elevated);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .app-title {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--color-primary);
  }

  .app-controls {
    display: flex;
    gap: 0.5rem;
  }

  .control-button {
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-text);
    background-color: var(--color-background-sunken);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease;
  }

  .control-button:hover:not(:disabled) {
    background-color: var(--color-hover);
    border-color: var(--color-border-focus);
  }

  .control-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .control-button.active {
    background-color: var(--color-primary);
    color: var(--color-text-inverse);
    border-color: var(--color-primary);
  }

  /* ---------------------------------------------------------------------------
   * Connection Overlay (passed to Layout via snippet)
   * ------------------------------------------------------------------------- */

  .connection-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--color-background-overlay);
    z-index: 100;
  }

  .connection-status {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 2rem;
    background-color: var(--color-background-elevated);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    text-align: center;
  }

  .spinner {
    width: 2rem;
    height: 2rem;
    border: 3px solid var(--color-border);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .status-text {
    margin: 0;
    font-size: 1rem;
    color: var(--color-text);
  }

  .error-text {
    margin: 0;
    font-size: 0.875rem;
    color: var(--color-error);
  }

  /* ---------------------------------------------------------------------------
   * Help Modal
   * ------------------------------------------------------------------------- */

  .modal-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--color-background-overlay);
    z-index: 1000;
  }

  .modal-content {
    width: 90%;
    max-width: 400px;
    background-color: var(--color-background-elevated);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 8px 32px var(--color-shadow-color);
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem;
    border-bottom: 1px solid var(--color-border-muted);
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text);
  }

  .modal-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--color-text-muted);
    font-size: 1rem;
    cursor: pointer;
    transition: background-color 150ms ease;
  }

  .modal-close:hover {
    background-color: var(--color-hover);
    color: var(--color-text);
  }

  .modal-body {
    padding: 1rem;
  }

  .shortcuts-list {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .shortcut-item {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .shortcut-item dt {
    flex-shrink: 0;
    min-width: 5rem;
  }

  .shortcut-item dd {
    margin: 0;
    color: var(--color-text-muted);
    font-size: 0.875rem;
  }

  .shortcut-item kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.5rem;
    height: 1.5rem;
    padding: 0 0.375rem;
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-text);
    background-color: var(--color-background-sunken);
    border: 1px solid var(--color-border);
    border-radius: 3px;
  }

  .modal-footer {
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--color-border-muted);
    text-align: center;
  }

  .help-hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  /* ---------------------------------------------------------------------------
   * Responsive Adjustments
   * ------------------------------------------------------------------------- */

  @media (max-width: 768px) {
    .app-controls {
      flex-wrap: wrap;
    }
  }
</style>
