<!--
  EventLog.svelte - Scrollable event log component.

  Displays system events with:
  - Auto-scroll to newest entries
  - Color-coded event types
  - Pause/resume functionality
  - Filter by event type
  - Clear functionality
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { events, type LoggedEvent, type EventType, type ObserverEvent } from '../stores/events.js';
  import { formatTime, formatReason, truncate } from '../utils/formatters.js';

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  interface Props {
    /** Maximum number of events to display. @default 100 */
    maxDisplayCount?: number;
    /** Whether to show the toolbar with controls. @default true */
    showToolbar?: boolean;
    /** Whether to enable auto-scroll on new events. @default true */
    autoScroll?: boolean;
    /** Callback when an event is clicked. */
    onEventClick?: (event: LoggedEvent) => void;
  }

  /**
   * Event severity level for styling.
   */
  type EventSeverity = 'info' | 'success' | 'warning' | 'error';

  /**
   * Formatted event for display.
   */
  interface FormattedEvent {
    readonly id: number;
    readonly timestamp: string;
    readonly type: EventType;
    readonly message: string;
    readonly severity: EventSeverity;
    readonly original: LoggedEvent;
  }

  // ---------------------------------------------------------------------------
  // Props & State
  // ---------------------------------------------------------------------------

  const {
    maxDisplayCount = 100,
    showToolbar = true,
    autoScroll = true,
    onEventClick,
  }: Props = $props();

  let scrollContainer: HTMLElement | null = $state(null);
  let activeFilter = $state<EventType | null>(null);
  let isUserScrolling = $state(false);
  let lastScrollTop = $state(0);

  // ---------------------------------------------------------------------------
  // Event Type Configuration
  // ---------------------------------------------------------------------------

  /**
   * Event type display configuration.
   */
  const EVENT_CONFIG: Record<EventType, { label: string; severity: EventSeverity; icon: string }> = {
    server_started: { label: 'Server Started', severity: 'success', icon: '+' },
    server_stopped: { label: 'Server Stopped', severity: 'warning', icon: '-' },
    supervisor_started: { label: 'Supervisor Started', severity: 'success', icon: '+' },
    supervisor_stopped: { label: 'Supervisor Stopped', severity: 'warning', icon: '-' },
    stats_update: { label: 'Stats Update', severity: 'info', icon: '\u2022' },
  };

  /**
   * Available event type filters.
   */
  const FILTER_OPTIONS: readonly { value: EventType | null; label: string }[] = [
    { value: null, label: 'All' },
    { value: 'server_started', label: 'Server+' },
    { value: 'server_stopped', label: 'Server-' },
    { value: 'supervisor_started', label: 'Sup+' },
    { value: 'supervisor_stopped', label: 'Sup-' },
    { value: 'stats_update', label: 'Stats' },
  ];

  // ---------------------------------------------------------------------------
  // Derived State
  // ---------------------------------------------------------------------------

  /**
   * Filtered events based on active filter.
   */
  const filteredEvents = $derived(
    activeFilter !== null
      ? events.filterByType(activeFilter)
      : events.all
  );

  /**
   * Events to display, limited by maxDisplayCount.
   */
  const displayEvents = $derived(
    filteredEvents.slice(-maxDisplayCount)
  );

  /**
   * Formatted events for rendering.
   */
  const formattedEvents = $derived(
    displayEvents.map(formatEvent)
  );

  /**
   * Whether the log is currently paused.
   */
  const isPaused = $derived(events.paused);

  /**
   * Whether there are events to display.
   */
  const hasEvents = $derived(displayEvents.length > 0);

  /**
   * Current event count for status display.
   */
  const eventCount = $derived(events.count);

  /**
   * Filtered event count.
   */
  const filteredCount = $derived(filteredEvents.length);

  // ---------------------------------------------------------------------------
  // Event Formatting
  // ---------------------------------------------------------------------------

  /**
   * Formats a logged event for display.
   */
  function formatEvent(entry: LoggedEvent): FormattedEvent {
    const config = EVENT_CONFIG[entry.event.type];
    return {
      id: entry.id,
      timestamp: formatTime(entry.receivedAt),
      type: entry.event.type,
      message: formatEventMessage(entry.event),
      severity: config.severity,
      original: entry,
    };
  }

  /**
   * Formats the event message based on event type.
   */
  function formatEventMessage(event: ObserverEvent): string {
    switch (event.type) {
      case 'server_started':
        return `GenServer started: ${truncate(event.stats.id, 40)}`;

      case 'server_stopped': {
        const reasonStr = formatReason(event.reason);
        return `GenServer stopped: ${truncate(event.id, 30)} (${reasonStr})`;
      }

      case 'supervisor_started':
        return `Supervisor started: ${truncate(event.stats.id, 40)}`;

      case 'supervisor_stopped':
        return `Supervisor stopped: ${truncate(event.id, 40)}`;

      case 'stats_update': {
        const serverCount = event.servers.length;
        const supervisorCount = event.supervisors.length;
        return `Stats update: ${serverCount} servers, ${supervisorCount} supervisors`;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-scroll Logic
  // ---------------------------------------------------------------------------

  /**
   * Scrolls to the bottom of the log.
   */
  async function scrollToBottom(): Promise<void> {
    await tick();
    if (scrollContainer && !isUserScrolling) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }

  /**
   * Handles scroll events to detect user scrolling.
   */
  function handleScroll(event: Event): void {
    const target = event.target as HTMLElement;
    const isAtBottom = target.scrollHeight - target.scrollTop <= target.clientHeight + 50;

    // Detect if user is scrolling up
    if (target.scrollTop < lastScrollTop && !isAtBottom) {
      isUserScrolling = true;
    }

    // Reset when user scrolls back to bottom
    if (isAtBottom) {
      isUserScrolling = false;
    }

    lastScrollTop = target.scrollTop;
  }

  // Auto-scroll when new events arrive
  $effect(() => {
    if (autoScroll && events.newest && !isPaused) {
      scrollToBottom();
    }
  });

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Toggles the pause state.
   */
  function togglePause(): void {
    events.togglePause();
  }

  /**
   * Clears all events.
   */
  function clearEvents(): void {
    events.clear();
  }

  /**
   * Sets the active filter.
   */
  function setFilter(filter: EventType | null): void {
    activeFilter = filter;
  }

  /**
   * Handles event click.
   */
  function handleEventClick(entry: LoggedEvent): void {
    onEventClick?.(entry);
  }

  /**
   * Scrolls to bottom manually.
   */
  function scrollToLatest(): void {
    isUserScrolling = false;
    scrollToBottom();
  }

  // ---------------------------------------------------------------------------
  // Severity CSS Classes
  // ---------------------------------------------------------------------------

  /**
   * Gets the CSS class for an event severity.
   */
  function getSeverityClass(severity: EventSeverity): string {
    switch (severity) {
      case 'success':
        return 'event-success';
      case 'warning':
        return 'event-warning';
      case 'error':
        return 'event-error';
      default:
        return 'event-info';
    }
  }
</script>

<div class="event-log" role="log" aria-label="Event log" aria-live="polite">
  {#if showToolbar}
    <header class="event-log-toolbar">
      <div class="toolbar-left">
        <span class="event-count">
          {#if activeFilter !== null}
            {filteredCount}/{eventCount}
          {:else}
            {eventCount}
          {/if}
          events
        </span>
      </div>

      <div class="toolbar-filters">
        {#each FILTER_OPTIONS as option}
          <button
            type="button"
            class="filter-button"
            class:active={activeFilter === option.value}
            onclick={() => setFilter(option.value)}
            title="Filter: {option.label}"
          >
            {option.label}
          </button>
        {/each}
      </div>

      <div class="toolbar-actions">
        <button
          type="button"
          class="action-button"
          class:active={isPaused}
          onclick={togglePause}
          title={isPaused ? 'Resume (collecting paused)' : 'Pause (stop collecting)'}
        >
          {isPaused ? 'Resume' : 'Pause'}
        </button>

        {#if isUserScrolling}
          <button
            type="button"
            class="action-button scroll-button"
            onclick={scrollToLatest}
            title="Scroll to latest"
          >
            Latest
          </button>
        {/if}

        <button
          type="button"
          class="action-button action-danger"
          onclick={clearEvents}
          disabled={!hasEvents}
          title="Clear all events"
        >
          Clear
        </button>
      </div>
    </header>
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="event-log-content"
    bind:this={scrollContainer}
    onscroll={handleScroll}
    role="list"
    tabindex="0"
  >
    {#if hasEvents}
      {#each formattedEvents as event (event.id)}
        {#if onEventClick}
          <button
            type="button"
            class="event-item {getSeverityClass(event.severity)}"
            onclick={() => handleEventClick(event.original)}
          >
            <span class="event-time">{event.timestamp}</span>
            <span class="event-icon" aria-hidden="true">{EVENT_CONFIG[event.type].icon}</span>
            <span class="event-message">{event.message}</span>
          </button>
        {:else}
          <div class="event-item {getSeverityClass(event.severity)}" role="listitem">
            <span class="event-time">{event.timestamp}</span>
            <span class="event-icon" aria-hidden="true">{EVENT_CONFIG[event.type].icon}</span>
            <span class="event-message">{event.message}</span>
          </div>
        {/if}
      {/each}
    {:else}
      <div class="event-log-empty">
        <p>No events{activeFilter !== null ? ` matching filter "${activeFilter}"` : ''}</p>
        <p class="empty-hint">Events will appear here as they occur</p>
      </div>
    {/if}
  </div>

  {#if isPaused}
    <div class="pause-indicator" aria-live="assertive">
      Paused
    </div>
  {/if}
</div>

<style>
  .event-log {
    display: flex;
    flex-direction: column;
    height: 100%;
    background-color: var(--color-background-elevated);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
    position: relative;
  }

  /* Toolbar */
  .event-log-toolbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    background-color: var(--color-background-sunken);
    border-bottom: 1px solid var(--color-border-muted);
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .toolbar-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .event-count {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }

  .toolbar-filters {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex: 1;
    min-width: 0;
    flex-wrap: wrap;
  }

  .filter-button {
    padding: 0.25rem 0.5rem;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--color-text-muted);
    background: none;
    border: 1px solid transparent;
    border-radius: 3px;
    cursor: pointer;
    transition: all 100ms ease;
    white-space: nowrap;
  }

  .filter-button:hover {
    color: var(--color-text);
    background-color: var(--color-hover);
  }

  .filter-button.active {
    color: var(--color-primary);
    background-color: var(--color-selected);
    border-color: var(--color-primary);
  }

  .toolbar-actions {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
  }

  .action-button {
    padding: 0.25rem 0.5rem;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--color-text);
    background-color: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: 3px;
    cursor: pointer;
    transition: all 100ms ease;
  }

  .action-button:hover:not(:disabled) {
    background-color: var(--color-hover);
    border-color: var(--color-border-focus);
  }

  .action-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .action-button.active {
    color: var(--color-warning);
    border-color: var(--color-warning);
  }

  .action-danger:hover:not(:disabled) {
    color: var(--color-error);
    border-color: var(--color-error);
  }

  .scroll-button {
    color: var(--color-primary);
    border-color: var(--color-primary);
  }

  /* Content */
  .event-log-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0.25rem 0;
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
    font-size: 0.75rem;
    line-height: 1.5;
  }

  .event-log-content:focus {
    outline: none;
  }

  .event-log-content:focus-visible {
    box-shadow: inset 0 0 0 2px var(--color-border-focus);
  }

  /* Event Items */
  .event-item {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.1875rem 0.75rem;
    cursor: default;
    transition: background-color 100ms ease;
    width: 100%;
    background: none;
    border: none;
    text-align: left;
    font: inherit;
  }

  .event-item:hover {
    background-color: var(--color-hover);
  }

  .event-item:focus {
    outline: none;
    background-color: var(--color-active);
  }

  button.event-item {
    cursor: pointer;
  }

  .event-time {
    flex-shrink: 0;
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }

  .event-icon {
    flex-shrink: 0;
    width: 0.75rem;
    text-align: center;
    font-weight: 700;
  }

  .event-message {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Severity Colors */
  .event-info .event-icon {
    color: var(--color-text-muted);
  }

  .event-info .event-message {
    color: var(--color-text-muted);
  }

  .event-success .event-icon {
    color: var(--color-success);
  }

  .event-success .event-message {
    color: var(--color-text);
  }

  .event-warning .event-icon {
    color: var(--color-warning);
  }

  .event-warning .event-message {
    color: var(--color-text);
  }

  .event-error .event-icon {
    color: var(--color-error);
  }

  .event-error .event-message {
    color: var(--color-error);
  }

  /* Empty State */
  .event-log-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 2rem;
    text-align: center;
    color: var(--color-text-muted);
  }

  .event-log-empty p {
    margin: 0;
  }

  .empty-hint {
    font-size: 0.6875rem;
    margin-top: 0.25rem !important;
    opacity: 0.7;
  }

  /* Pause Indicator */
  .pause-indicator {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-warning);
    background-color: var(--color-warning-muted);
    border-radius: 3px;
  }

  /* Responsive */
  @media (max-width: 640px) {
    .event-log-toolbar {
      gap: 0.5rem;
    }

    .toolbar-filters {
      order: 3;
      width: 100%;
      justify-content: flex-start;
    }

    .event-item {
      padding: 0.25rem 0.5rem;
    }

    .event-time {
      display: none;
    }
  }
</style>
