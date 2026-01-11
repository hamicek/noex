<!--
  MemoryGauge.svelte - Visual memory usage gauge component.

  Displays heap memory usage as an animated progress bar with:
  - Color-coded thresholds (green/yellow/red)
  - Percentage and absolute values
  - Smooth CSS transitions
-->
<script lang="ts">
  import { snapshot } from '../stores/snapshot.js';
  import { formatBytes, calculatePercent } from '../utils/formatters.js';

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  interface Props {
    /** Label text for the gauge. */
    label?: string;
    /** Optional explicit memory stats (uses snapshot store if not provided). */
    heapUsed?: number;
    /** Optional explicit heap total (uses snapshot store if not provided). */
    heapTotal?: number;
    /** Warning threshold percentage (yellow). */
    warningThreshold?: number;
    /** Critical threshold percentage (red). */
    criticalThreshold?: number;
    /** Whether to show the detailed breakdown. */
    showDetails?: boolean;
  }

  // ---------------------------------------------------------------------------
  // Props
  // ---------------------------------------------------------------------------

  const {
    label = 'Heap Memory',
    heapUsed,
    heapTotal,
    warningThreshold = 60,
    criticalThreshold = 80,
    showDetails = true,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Computed Values
  // ---------------------------------------------------------------------------

  // Use provided values or fall back to snapshot store
  const usedBytes = $derived(heapUsed ?? snapshot.memoryStats.heapUsed);
  const totalBytes = $derived(heapTotal ?? snapshot.memoryStats.heapTotal);

  // Calculate percentage (clamped to 0-100)
  const percentage = $derived(calculatePercent(usedBytes, totalBytes));

  // Determine severity level for color coding
  type SeverityLevel = 'healthy' | 'warning' | 'critical';

  const severity: SeverityLevel = $derived(
    percentage >= criticalThreshold ? 'critical' :
    percentage >= warningThreshold ? 'warning' :
    'healthy'
  );

  // Format display values
  const usedFormatted = $derived(formatBytes(usedBytes));
  const totalFormatted = $derived(formatBytes(totalBytes));

  // Accessibility description
  const ariaLabel = $derived(
    `${label}: ${percentage}% used, ${usedFormatted} of ${totalFormatted}`
  );
</script>

<div class="memory-gauge" role="meter" aria-label={ariaLabel} aria-valuenow={percentage} aria-valuemin={0} aria-valuemax={100}>
  <header class="gauge-header">
    <span class="gauge-label">{label}</span>
    <span class="gauge-values">
      {usedFormatted} / {totalFormatted}
    </span>
  </header>

  <div class="gauge-track">
    <div
      class="gauge-fill severity-{severity}"
      style:width="{percentage}%"
      aria-hidden="true"
    ></div>
    <span class="gauge-percentage">{percentage}%</span>
  </div>

  {#if showDetails}
    <footer class="gauge-details">
      <div class="detail-item">
        <span class="detail-label">Used</span>
        <span class="detail-value">{usedFormatted}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">Free</span>
        <span class="detail-value">{formatBytes(totalBytes - usedBytes)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">Total</span>
        <span class="detail-value">{totalFormatted}</span>
      </div>
    </footer>
  {/if}
</div>

<style>
  .memory-gauge {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    background-color: var(--color-background-elevated);
    border: 1px solid var(--color-border);
    border-radius: 6px;
  }

  .gauge-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .gauge-label {
    font-weight: 600;
    color: var(--color-text);
    font-size: 0.875rem;
  }

  .gauge-values {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  }

  .gauge-track {
    position: relative;
    height: 1.5rem;
    background-color: var(--color-gauge-background);
    border-radius: 4px;
    overflow: hidden;
  }

  .gauge-fill {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    border-radius: 4px;
    transition:
      width 300ms ease-out,
      background-color 300ms ease;
    will-change: width;
  }

  /* Severity colors */
  .severity-healthy {
    background-color: var(--color-gauge-foreground);
  }

  .severity-warning {
    background-color: var(--color-gauge-warning);
  }

  .severity-critical {
    background-color: var(--color-gauge-critical);
  }

  .gauge-percentage {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text);
    text-shadow: 0 1px 2px var(--color-shadow-color, rgba(0, 0, 0, 0.3));
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    z-index: 1;
  }

  .gauge-details {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--color-border-muted);
  }

  .detail-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1;
  }

  .detail-label {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }

  .detail-value {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-text);
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
    font-variant-numeric: tabular-nums;
  }

  /* Hover effect */
  .memory-gauge:hover {
    border-color: var(--color-border-focus);
  }

  /* Compact mode - no details */
  .memory-gauge:not(:has(.gauge-details)) {
    padding: 0.5rem 0.75rem;
    gap: 0.375rem;
  }

  /* Animation for critical level */
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.85; }
  }

  .gauge-fill.severity-critical {
    animation: pulse 2s ease-in-out infinite;
  }
</style>
