/**
 * Event log state management for the Svelte dashboard.
 *
 * Provides a reactive event log with:
 * - Bounded event storage with configurable max size
 * - Event filtering by type
 * - Automatic timestamp tracking
 * - Integration with WebSocket event stream
 *
 * @module stores/events
 */

import type { ObserverEvent, TerminateReason, GenServerStats } from 'noex';
import { connection } from './connection.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Logged event with metadata.
 */
export interface LoggedEvent {
  /** Unique identifier for this log entry */
  readonly id: number;
  /** Timestamp when the event was received */
  readonly receivedAt: number;
  /** The original observer event */
  readonly event: ObserverEvent;
}

/**
 * Event type for filtering.
 */
export type EventType = ObserverEvent['type'];

/**
 * Configuration for the event store.
 */
export interface EventStoreConfig {
  /** Maximum number of events to keep. @default 1000 */
  readonly maxEvents: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CONFIG: EventStoreConfig = {
  maxEvents: 1000,
};

// =============================================================================
// Event Store Implementation
// =============================================================================

/**
 * Creates an event log store with reactive state.
 *
 * @example
 * ```typescript
 * const events = createEventStore();
 *
 * // Access all events
 * console.log(events.all);
 *
 * // Filter by type
 * const serverEvents = events.filterByType('server_started');
 *
 * // Clear events
 * events.clear();
 * ```
 */
function createEventStore(config: Partial<EventStoreConfig> = {}) {
  const resolvedConfig: EventStoreConfig = { ...DEFAULT_CONFIG, ...config };

  // ---------------------------------------------------------------------------
  // Reactive State (Svelte 5 runes)
  // ---------------------------------------------------------------------------

  let events = $state<LoggedEvent[]>([]);
  let eventIdCounter = $state(0);
  let paused = $state(false);

  // Derived state
  const count = $derived(events.length);
  const isEmpty = $derived(events.length === 0);
  const newest = $derived(events.length > 0 ? events[events.length - 1] : null);
  const oldest = $derived(events.length > 0 ? events[0] : null);

  // Event type counts
  const typeCounts = $derived(() => {
    const counts = new Map<EventType, number>();
    for (const entry of events) {
      const type = entry.event.type;
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return counts;
  });

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  function handleEvent(payload: ObserverEvent): void {
    if (paused) {
      return;
    }

    addEvent(payload);
  }

  function addEvent(event: ObserverEvent): void {
    eventIdCounter++;

    const entry: LoggedEvent = {
      id: eventIdCounter,
      receivedAt: Date.now(),
      event,
    };

    // Add to end and trim from front if needed
    if (events.length >= resolvedConfig.maxEvents) {
      events = [...events.slice(1), entry];
    } else {
      events = [...events, entry];
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket Integration
  // ---------------------------------------------------------------------------

  // Subscribe to event messages from WebSocket
  connection.onMessage('event', handleEvent);

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Filters events by type.
   *
   * @param type - Event type to filter by
   * @returns Filtered events
   */
  function filterByType(type: EventType): readonly LoggedEvent[] {
    return events.filter((e) => e.event.type === type);
  }

  /**
   * Filters events by process ID.
   *
   * @param processId - Process ID to filter by
   * @returns Filtered events
   */
  function filterByProcessId(processId: string): readonly LoggedEvent[] {
    return events.filter((e) => {
      const evt = e.event;
      switch (evt.type) {
        case 'server_started':
          return evt.stats.id === processId;
        case 'server_stopped':
          return evt.id === processId;
        case 'supervisor_started':
          return evt.stats.id === processId;
        case 'supervisor_stopped':
          return evt.id === processId;
        case 'stats_update':
          return (
            evt.servers.some((s) => s.id === processId) ||
            evt.supervisors.some((s) => s.id === processId)
          );
      }
    });
  }

  /**
   * Gets events within a time range.
   *
   * @param startTime - Start timestamp (inclusive)
   * @param endTime - End timestamp (inclusive)
   * @returns Events within range
   */
  function filterByTimeRange(startTime: number, endTime: number): readonly LoggedEvent[] {
    return events.filter((e) => e.receivedAt >= startTime && e.receivedAt <= endTime);
  }

  /**
   * Gets the last N events.
   *
   * @param n - Number of events
   * @returns Last N events (newest first)
   */
  function getLatest(n: number): readonly LoggedEvent[] {
    return events.slice(-n).reverse();
  }

  /**
   * Gets events with a specific server's stats update.
   *
   * @param serverId - Server ID
   * @returns Events containing this server's stats
   */
  function getServerHistory(serverId: string): readonly GenServerStats[] {
    const history: GenServerStats[] = [];

    for (const entry of events) {
      if (entry.event.type === 'stats_update') {
        const serverStats = entry.event.servers.find((s) => s.id === serverId);
        if (serverStats) {
          history.push(serverStats);
        }
      } else if (entry.event.type === 'server_started' && entry.event.stats.id === serverId) {
        history.push(entry.event.stats);
      }
    }

    return history;
  }

  /**
   * Finds all stop events for a given server.
   *
   * @param serverId - Server ID
   * @returns Stop events for this server
   */
  function getStopEvents(serverId: string): readonly { reason: TerminateReason; timestamp: number }[] {
    return events
      .filter((e) => e.event.type === 'server_stopped' && e.event.id === serverId)
      .map((e) => {
        const evt = e.event as Extract<ObserverEvent, { type: 'server_stopped' }>;
        return { reason: evt.reason, timestamp: e.receivedAt };
      });
  }

  /**
   * Gets the count of a specific event type.
   *
   * @param type - Event type
   * @returns Count of events with this type
   */
  function getTypeCount(type: EventType): number {
    return typeCounts().get(type) ?? 0;
  }

  /**
   * Pauses event collection.
   */
  function pause(): void {
    paused = true;
  }

  /**
   * Resumes event collection.
   */
  function resume(): void {
    paused = false;
  }

  /**
   * Toggles pause state.
   */
  function togglePause(): void {
    paused = !paused;
  }

  /**
   * Clears all events.
   */
  function clear(): void {
    events = [];
  }

  /**
   * Manually adds an event.
   * Primarily for testing or external data sources.
   *
   * @param event - Event to add
   */
  function add(event: ObserverEvent): void {
    addEvent(event);
  }

  // ---------------------------------------------------------------------------
  // Store Object
  // ---------------------------------------------------------------------------

  return {
    // Reactive getters
    get all() { return events; },
    get count() { return count; },
    get isEmpty() { return isEmpty; },
    get newest() { return newest; },
    get oldest() { return oldest; },
    get paused() { return paused; },
    get typeCounts() { return typeCounts(); },

    // Filter methods
    filterByType,
    filterByProcessId,
    filterByTimeRange,
    getLatest,
    getServerHistory,
    getStopEvents,
    getTypeCount,

    // Control methods
    pause,
    resume,
    togglePause,
    clear,
    add,

    // Configuration
    maxEvents: resolvedConfig.maxEvents,
  };
}

// =============================================================================
// Singleton Export
// =============================================================================

/**
 * Global event store instance.
 *
 * Provides reactive access to the event log.
 * Automatically updates when event messages are received.
 */
export const events = createEventStore();

// Export factory for testing
export { createEventStore };

// Re-export types for convenience
export type { ObserverEvent };
