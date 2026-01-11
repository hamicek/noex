<!--
  ProcessDetail.svelte - Modal overlay for detailed process information.

  Displays comprehensive information about a selected GenServer or Supervisor:
  - Full process identification and metadata
  - Runtime statistics with formatted values
  - Status indicators with appropriate styling
  - Accessible modal dialog with keyboard support (Escape to close)
-->
<script lang="ts">
  import type { GenServerStats, SupervisorStats, ProcessTreeNode } from 'noex';
  import {
    formatNumber,
    formatBytes,
    formatUptime,
    formatDateTime,
  } from '../utils/formatters.js';

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  interface Props {
    /** The process to display details for. Null hides the modal. */
    process: ProcessTreeNode | null;
    /** Callback when the modal should be closed. */
    onClose: () => void;
  }

  /**
   * GenServer status type.
   */
  type ServerStatus = GenServerStats['status'];

  /**
   * Status display configuration.
   */
  interface StatusDisplay {
    readonly label: string;
    readonly className: string;
    readonly icon: string;
  }

  /**
   * Section definition for rendering detail groups.
   */
  interface DetailSection {
    readonly title: string;
    readonly items: readonly DetailItem[];
  }

  /**
   * Individual detail item.
   */
  interface DetailItem {
    readonly label: string;
    readonly value: string;
    readonly className?: string;
  }

  // ---------------------------------------------------------------------------
  // Props
  // ---------------------------------------------------------------------------

  const { process, onClose }: Props = $props();

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let dialogElement: HTMLDialogElement | null = $state(null);

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const STATUS_ICONS = {
    RUNNING: '\u25CF',   // ●
    STOPPED: '\u25CB',   // ○
    SUPERVISOR: '\u25BC', // ▼
  } as const;

  const STATUS_MAP: Readonly<Record<ServerStatus, StatusDisplay>> = {
    initializing: { label: 'Initializing', className: 'status-initializing', icon: STATUS_ICONS.RUNNING },
    running: { label: 'Running', className: 'status-running', icon: STATUS_ICONS.RUNNING },
    stopping: { label: 'Stopping', className: 'status-stopping', icon: STATUS_ICONS.STOPPED },
    stopped: { label: 'Stopped', className: 'status-stopped', icon: STATUS_ICONS.STOPPED },
  };

  // ---------------------------------------------------------------------------
  // Derived State
  // ---------------------------------------------------------------------------

  const isOpen = $derived(process !== null);

  const isGenServer = $derived(process?.type === 'genserver');
  const isSupervisor = $derived(process?.type === 'supervisor');

  const serverStats = $derived(
    isGenServer ? (process!.stats as GenServerStats) : null
  );

  const supervisorStats = $derived(
    isSupervisor ? (process!.stats as SupervisorStats) : null
  );

  const processTitle = $derived(
    process?.name ?? process?.id ?? 'Process Details'
  );

  const processTypeLabel = $derived(
    isGenServer ? 'GenServer' : isSupervisor ? 'Supervisor' : 'Process'
  );

  const statusDisplay = $derived.by((): StatusDisplay | null => {
    if (serverStats) {
      return STATUS_MAP[serverStats.status];
    }
    if (isSupervisor) {
      return { label: 'Active', className: 'status-running', icon: STATUS_ICONS.SUPERVISOR };
    }
    return null;
  });

  /**
   * Builds detail sections for GenServer.
   */
  const genServerSections = $derived.by((): readonly DetailSection[] => {
    if (!serverStats) return [];

    return [
      {
        title: 'Identification',
        items: [
          { label: 'ID', value: serverStats.id },
          { label: 'Type', value: 'GenServer' },
          ...(process?.name ? [{ label: 'Registered Name', value: process.name }] : []),
        ],
      },
      {
        title: 'Status',
        items: [
          {
            label: 'Current Status',
            value: STATUS_MAP[serverStats.status].label,
            className: STATUS_MAP[serverStats.status].className,
          },
          { label: 'Uptime', value: formatUptime(serverStats.uptimeMs) },
          { label: 'Started At', value: formatDateTime(serverStats.startedAt) },
        ],
      },
      {
        title: 'Message Processing',
        items: [
          {
            label: 'Queue Size',
            value: String(serverStats.queueSize),
            className: serverStats.queueSize > 10 ? 'value-warning' : undefined,
          },
          { label: 'Total Messages', value: formatNumber(serverStats.messageCount) },
          { label: 'Messages/sec', value: calculateMessagesPerSecond(serverStats) },
        ],
      },
      {
        title: 'Memory',
        items: [
          {
            label: 'State Memory',
            value: serverStats.stateMemoryBytes !== undefined
              ? formatBytes(serverStats.stateMemoryBytes)
              : 'N/A',
          },
        ],
      },
    ];
  });

  /**
   * Builds detail sections for Supervisor.
   */
  const supervisorSections = $derived.by((): readonly DetailSection[] => {
    if (!supervisorStats) return [];

    return [
      {
        title: 'Identification',
        items: [
          { label: 'ID', value: supervisorStats.id },
          { label: 'Type', value: 'Supervisor' },
          ...(process?.name ? [{ label: 'Registered Name', value: process.name }] : []),
        ],
      },
      {
        title: 'Status',
        items: [
          { label: 'Strategy', value: formatStrategy(supervisorStats.strategy) },
          { label: 'Uptime', value: formatUptime(supervisorStats.uptimeMs) },
          { label: 'Started At', value: formatDateTime(supervisorStats.startedAt) },
        ],
      },
      {
        title: 'Children',
        items: [
          { label: 'Child Count', value: String(supervisorStats.childCount) },
          {
            label: 'Total Restarts',
            value: String(supervisorStats.totalRestarts),
            className: supervisorStats.totalRestarts > 0 ? 'value-warning' : undefined,
          },
        ],
      },
    ];
  });

  const sections = $derived(
    isGenServer ? genServerSections : isSupervisor ? supervisorSections : []
  );

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  $effect(() => {
    if (isOpen && dialogElement && !dialogElement.open) {
      dialogElement.showModal();
    } else if (!isOpen && dialogElement?.open) {
      dialogElement.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Calculates approximate messages per second.
   */
  function calculateMessagesPerSecond(stats: GenServerStats): string {
    if (stats.uptimeMs < 1000) return '—';
    const rate = stats.messageCount / (stats.uptimeMs / 1000);
    if (rate < 0.1) return '< 0.1';
    if (rate < 1) return rate.toFixed(2);
    if (rate < 10) return rate.toFixed(1);
    return formatNumber(Math.round(rate));
  }

  /**
   * Formats supervisor strategy for display.
   */
  function formatStrategy(strategy: string): string {
    return strategy.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  function handleBackdropClick(event: MouseEvent): void {
    if (event.target === dialogElement) {
      onClose();
    }
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  function handleDialogCancel(event: Event): void {
    event.preventDefault();
    onClose();
  }
</script>

{#if isOpen}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <dialog
    bind:this={dialogElement}
    class="process-detail-dialog"
    aria-labelledby="process-detail-title"
    aria-describedby="process-detail-description"
    onclick={handleBackdropClick}
    onkeydown={handleKeyDown}
    oncancel={handleDialogCancel}
  >
    <div class="dialog-content" role="document">
      <!-- Header -->
      <header class="dialog-header">
        <div class="header-content">
          <div class="header-icon" class:supervisor={isSupervisor}>
            {#if serverStats}
              <span class="status-indicator {statusDisplay?.className}">
                {statusDisplay?.icon}
              </span>
            {:else}
              <span class="type-icon">{STATUS_ICONS.SUPERVISOR}</span>
            {/if}
          </div>
          <div class="header-text">
            <h2 id="process-detail-title" class="dialog-title">
              {processTitle}
            </h2>
            <p id="process-detail-description" class="dialog-subtitle">
              {processTypeLabel}
              {#if serverStats}
                <span class="subtitle-separator">•</span>
                <span class={statusDisplay?.className}>{statusDisplay?.label}</span>
              {/if}
            </p>
          </div>
        </div>
        <button
          type="button"
          class="close-button"
          onclick={onClose}
          aria-label="Close dialog"
        >
          <span aria-hidden="true">&times;</span>
        </button>
      </header>

      <!-- Body -->
      <div class="dialog-body">
        {#each sections as section (section.title)}
          <section class="detail-section">
            <h3 class="section-title">{section.title}</h3>
            <dl class="detail-list">
              {#each section.items as item (item.label)}
                <div class="detail-item">
                  <dt class="detail-label">{item.label}</dt>
                  <dd class="detail-value {item.className ?? ''}">{item.value}</dd>
                </div>
              {/each}
            </dl>
          </section>
        {/each}
      </div>

      <!-- Footer -->
      <footer class="dialog-footer">
        <button
          type="button"
          class="footer-button"
          onclick={onClose}
        >
          Close
        </button>
      </footer>
    </div>
  </dialog>
{/if}

<style>
  /* Dialog backdrop and container */
  .process-detail-dialog {
    position: fixed;
    inset: 0;
    margin: auto;
    padding: 0;
    border: none;
    border-radius: 8px;
    background-color: var(--color-background-elevated);
    color: var(--color-text);
    box-shadow:
      0 25px 50px -12px var(--color-shadow),
      0 0 0 1px var(--color-border);
    max-width: 520px;
    width: calc(100% - 2rem);
    max-height: calc(100vh - 4rem);
    overflow: hidden;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  .process-detail-dialog::backdrop {
    background-color: var(--color-background-overlay);
    backdrop-filter: blur(4px);
  }

  .process-detail-dialog[open] {
    animation: dialog-fade-in 150ms ease-out;
  }

  @keyframes dialog-fade-in {
    from {
      opacity: 0;
      transform: scale(0.95) translateY(-10px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  /* Dialog content wrapper */
  .dialog-content {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 4rem);
  }

  /* Header */
  .dialog-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding: 1.25rem 1.5rem;
    border-bottom: 1px solid var(--color-border-muted);
    flex-shrink: 0;
  }

  .header-content {
    display: flex;
    align-items: flex-start;
    gap: 0.875rem;
    min-width: 0;
  }

  .header-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    flex-shrink: 0;
    background-color: var(--color-background-sunken);
    border: 1px solid var(--color-border-muted);
    border-radius: 8px;
    font-size: 1.125rem;
  }

  .header-icon.supervisor {
    color: var(--color-secondary);
  }

  .status-indicator {
    line-height: 1;
  }

  .status-indicator.status-initializing { color: var(--color-primary); }
  .status-indicator.status-running { color: var(--color-success); }
  .status-indicator.status-stopping { color: var(--color-warning); }
  .status-indicator.status-stopped { color: var(--color-error); }

  .type-icon {
    color: var(--color-secondary);
  }

  .header-text {
    min-width: 0;
    flex: 1;
  }

  .dialog-title {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    line-height: 1.3;
    color: var(--color-text);
    word-break: break-word;
  }

  .dialog-subtitle {
    margin: 0.25rem 0 0;
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }

  .subtitle-separator {
    margin: 0 0.375rem;
    opacity: 0.5;
  }

  .close-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    padding: 0;
    margin: -0.25rem -0.5rem 0 0;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--color-text-muted);
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
    transition: background-color 100ms ease, color 100ms ease;
  }

  .close-button:hover {
    background-color: var(--color-hover);
    color: var(--color-text);
  }

  .close-button:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }

  /* Body */
  .dialog-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1rem 1.5rem 1.5rem;
  }

  /* Sections */
  .detail-section {
    padding: 0;
  }

  .detail-section + .detail-section {
    margin-top: 1.25rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--color-border-muted);
  }

  .section-title {
    margin: 0 0 0.75rem;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }

  /* Detail list */
  .detail-list {
    margin: 0;
    display: grid;
    gap: 0.5rem;
  }

  .detail-item {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.375rem 0.625rem;
    background-color: var(--color-background-sunken);
    border-radius: 4px;
  }

  .detail-label {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    flex-shrink: 0;
  }

  .detail-value {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-text);
    text-align: right;
    word-break: break-all;
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  }

  /* Value states */
  .detail-value.status-initializing { color: var(--color-primary); }
  .detail-value.status-running { color: var(--color-success); }
  .detail-value.status-stopping { color: var(--color-warning); }
  .detail-value.status-stopped { color: var(--color-error); }
  .detail-value.value-warning { color: var(--color-warning); font-weight: 600; }

  /* Footer */
  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    padding: 1rem 1.5rem;
    border-top: 1px solid var(--color-border-muted);
    flex-shrink: 0;
  }

  .footer-button {
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-text);
    background-color: var(--color-background-sunken);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 100ms ease, border-color 100ms ease;
  }

  .footer-button:hover {
    background-color: var(--color-hover);
    border-color: var(--color-border);
  }

  .footer-button:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }

  /* Responsive */
  @media (max-width: 480px) {
    .process-detail-dialog {
      max-width: none;
      width: 100%;
      max-height: 100vh;
      height: 100%;
      border-radius: 0;
    }

    .dialog-content {
      max-height: 100vh;
    }

    .dialog-header {
      padding: 1rem;
    }

    .dialog-body {
      padding: 1rem;
    }

    .dialog-footer {
      padding: 1rem;
    }

    .detail-item {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.25rem;
    }

    .detail-value {
      text-align: left;
    }
  }
</style>
