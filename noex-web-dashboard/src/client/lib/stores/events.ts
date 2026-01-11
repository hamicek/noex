/**
 * Event log state management for the Svelte dashboard.
 *
 * @module stores/events
 */

import { writable, derived, get } from 'svelte/store';
import type { ObserverEvent } from 'noex';
import { connection } from './connection.js';

// =============================================================================
// Types
// =============================================================================

export interface LoggedEvent {
  readonly id: number;
  readonly receivedAt: number;
  readonly event: ObserverEvent;
}

export type EventType = ObserverEvent['type'];

export interface EventStoreConfig {
  readonly maxEvents: number;
}

const DEFAULT_CONFIG: EventStoreConfig = {
  maxEvents: 1000,
};

// =============================================================================
// Events Store Implementation
// =============================================================================

function createEventStore(config: Partial<EventStoreConfig> = {}) {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  let nextId = 0;

  const events = writable<LoggedEvent[]>([]);
  const filter = writable<EventType | null>(null);
  const paused = writable(false);

  const all = derived(events, ($events) => $events);
  const count = derived(events, ($events) => $events.length);
  const filtered = derived([events, filter], ([$events, $filter]) =>
    $filter ? $events.filter((e) => e.event.type === $filter) : $events
  );
  const latest = derived(events, ($events) => $events[0] ?? null);
  const isEmpty = derived(events, ($events) => $events.length === 0);

  // Subscribe to event messages
  connection.onMessage('event', (payload) => {
    const logged: LoggedEvent = {
      id: nextId++,
      receivedAt: Date.now(),
      event: payload,
    };
    events.update(($events) => {
      const updated = [logged, ...$events];
      return updated.length > resolvedConfig.maxEvents
        ? updated.slice(0, resolvedConfig.maxEvents)
        : updated;
    });
  });

  function setFilter(type: EventType | null): void {
    filter.set(type);
  }

  function clear(): void {
    events.set([]);
  }

  function getEventsByType(type: EventType): LoggedEvent[] {
    return get(events).filter((e) => e.event.type === type);
  }

  function filterByType(type: EventType): LoggedEvent[] {
    return get(events).filter((e) => e.event.type === type);
  }

  function pause(): void {
    paused.set(true);
  }

  function resume(): void {
    paused.set(false);
  }

  function togglePause(): void {
    paused.update(v => !v);
  }

  return {
    all,
    count,
    filtered,
    filter,
    paused,
    latest,
    isEmpty,
    setFilter,
    clear,
    getEventsByType,
    filterByType,
    pause,
    resume,
    togglePause,
  };
}

export const events = createEventStore();
export { createEventStore };
export type { ObserverEvent };
