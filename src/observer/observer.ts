/**
 * Observer module for noex process introspection.
 *
 * Provides a unified API for monitoring GenServers and Supervisors,
 * similar to Elixir's Observer tool. Enables real-time visibility
 * into the process hierarchy, statistics, and lifecycle events.
 */

import type {
  GenServerStats,
  SupervisorStats,
  ProcessTreeNode,
  ObserverEvent,
  LifecycleEvent,
  MemoryStats,
} from '../core/types.js';
import { GenServer } from '../core/gen-server.js';
import { Supervisor } from '../core/supervisor.js';
import type { ObserverSnapshot, ObserverEventHandler } from './types.js';
import { buildProcessTree, countTreeNodes } from './tree-builder.js';
import { getMemoryStats } from './memory-utils.js';
import { createExportData, type ExportData } from './export-utils.js';

/**
 * Internal state for lifecycle event subscriptions.
 */
const eventSubscribers = new Set<ObserverEventHandler>();

/**
 * Tracks whether we've subscribed to core lifecycle events.
 */
let coreSubscribed = false;
let genServerUnsubscribe: (() => void) | null = null;
let supervisorUnsubscribe: (() => void) | null = null;

/**
 * Ensures we're subscribed to core lifecycle events.
 */
function ensureCoreSubscription(): void {
  if (coreSubscribed) return;

  genServerUnsubscribe = GenServer.onLifecycleEvent(handleGenServerEvent);
  supervisorUnsubscribe = Supervisor.onLifecycleEvent(handleSupervisorEvent);
  coreSubscribed = true;
}

/**
 * Handles GenServer lifecycle events and translates to Observer events.
 */
function handleGenServerEvent(event: LifecycleEvent): void {
  if (eventSubscribers.size === 0) return;

  let observerEvent: ObserverEvent | null = null;

  switch (event.type) {
    case 'started': {
      const stats = GenServer._getStats(event.ref as import('../core/types.js').GenServerRef);
      if (stats) {
        observerEvent = { type: 'server_started', stats };
      }
      break;
    }
    case 'terminated': {
      observerEvent = {
        type: 'server_stopped',
        id: event.ref.id,
        reason: event.reason,
      };
      break;
    }
    // 'crashed' and 'restarted' are handled by supervisor
  }

  if (observerEvent) {
    emitObserverEvent(observerEvent);
  }
}

/**
 * Handles Supervisor lifecycle events and translates to Observer events.
 */
function handleSupervisorEvent(event: LifecycleEvent): void {
  if (eventSubscribers.size === 0) return;

  let observerEvent: ObserverEvent | null = null;

  switch (event.type) {
    case 'started': {
      const stats = Supervisor._getStats(event.ref as import('../core/types.js').SupervisorRef);
      if (stats) {
        observerEvent = { type: 'supervisor_started', stats };
      }
      break;
    }
    case 'terminated': {
      observerEvent = { type: 'supervisor_stopped', id: event.ref.id };
      break;
    }
  }

  if (observerEvent) {
    emitObserverEvent(observerEvent);
  }
}

/**
 * Emits an event to all subscribers.
 */
function emitObserverEvent(event: ObserverEvent): void {
  for (const handler of eventSubscribers) {
    try {
      handler(event);
    } catch {
      // Handlers should not throw, but if they do, continue
    }
  }
}

/**
 * Observer provides system-wide introspection for noex processes.
 *
 * Use Observer to:
 * - Get snapshots of all running processes
 * - Monitor real-time lifecycle events
 * - Build process tree visualizations
 * - Track message throughput and restart rates
 *
 * @example
 * ```typescript
 * // Get a complete system snapshot
 * const snapshot = Observer.getSnapshot();
 * console.log(`${snapshot.processCount} processes running`);
 *
 * // Subscribe to real-time events
 * const unsubscribe = Observer.subscribe((event) => {
 *   if (event.type === 'server_started') {
 *     console.log(`Server started: ${event.stats.id}`);
 *   }
 * });
 *
 * // Poll for periodic updates
 * const stopPolling = Observer.startPolling(1000, (event) => {
 *   if (event.type === 'stats_update') {
 *     console.log(`${event.servers.length} servers running`);
 *   }
 * });
 * ```
 */
export const Observer = {
  /**
   * Returns a complete snapshot of the system state.
   *
   * The snapshot provides a consistent point-in-time view of:
   * - All running GenServers with their statistics
   * - All running Supervisors with their statistics
   * - The complete process tree hierarchy
   * - Aggregate metrics (process count, total messages, total restarts)
   *
   * @returns Complete system snapshot
   */
  getSnapshot(): ObserverSnapshot {
    const servers = GenServer._getAllStats();
    const supervisors = Supervisor._getAllStats();
    const tree = buildProcessTree();

    const totalMessages = servers.reduce((sum, s) => sum + s.messageCount, 0);
    const totalRestarts = supervisors.reduce((sum, s) => sum + s.totalRestarts, 0);

    return {
      timestamp: Date.now(),
      servers,
      supervisors,
      tree,
      processCount: countTreeNodes(tree),
      totalMessages,
      totalRestarts,
      memoryStats: getMemoryStats(),
    };
  },

  /**
   * Returns current process memory statistics.
   *
   * Provides heap usage, RSS, and external memory metrics
   * from the Node.js runtime.
   *
   * @returns Current memory statistics
   */
  getMemoryStats(): MemoryStats {
    return getMemoryStats();
  },

  /**
   * Returns statistics for all running GenServers.
   *
   * @returns Array of GenServer statistics
   */
  getServerStats(): readonly GenServerStats[] {
    return GenServer._getAllStats();
  },

  /**
   * Returns statistics for all running Supervisors.
   *
   * @returns Array of Supervisor statistics
   */
  getSupervisorStats(): readonly SupervisorStats[] {
    return Supervisor._getAllStats();
  },

  /**
   * Returns the complete process tree.
   *
   * The tree represents the supervision hierarchy:
   * - Root nodes are supervisors or standalone servers
   * - Child nodes under supervisors are their managed processes
   * - Each node includes statistics and optional registry name
   *
   * @returns Array of root-level process tree nodes
   */
  getProcessTree(): readonly ProcessTreeNode[] {
    return buildProcessTree();
  },

  /**
   * Subscribes to real-time Observer events.
   *
   * Events are emitted when:
   * - A GenServer starts or stops
   * - A Supervisor starts or stops
   * - Periodic stats updates (when polling is enabled)
   *
   * @param handler - Function called for each event
   * @returns Unsubscribe function
   */
  subscribe(handler: ObserverEventHandler): () => void {
    ensureCoreSubscription();
    eventSubscribers.add(handler);

    return () => {
      eventSubscribers.delete(handler);
    };
  },

  /**
   * Starts periodic polling for stats updates.
   *
   * At the specified interval, emits a 'stats_update' event
   * containing current statistics for all servers and supervisors.
   * This is useful for dashboards that need regular updates.
   *
   * @param intervalMs - Polling interval in milliseconds
   * @param handler - Function called with each stats update
   * @returns Function to stop polling
   */
  startPolling(intervalMs: number, handler: ObserverEventHandler): () => void {
    let active = true;

    const poll = () => {
      if (!active) return;

      const event: ObserverEvent = {
        type: 'stats_update',
        servers: GenServer._getAllStats(),
        supervisors: Supervisor._getAllStats(),
      };

      try {
        handler(event);
      } catch {
        // Handler errors should not stop polling
      }
    };

    const intervalId = setInterval(poll, intervalMs);

    // Emit initial update
    poll();

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  },

  /**
   * Returns the count of all running processes.
   *
   * @returns Total number of GenServers and Supervisors
   */
  getProcessCount(): number {
    return GenServer._getAllServerIds().length + Supervisor._getAllSupervisorIds().length;
  },

  /**
   * Prepares data for export in a standardized format.
   *
   * Returns a complete export data structure containing the current
   * system snapshot, ready for JSON or CSV export. This is the
   * recommended way to create exportable data.
   *
   * @returns Export data structure with current snapshot
   *
   * @example
   * ```typescript
   * import { Observer, exportToJson, exportToCsv } from 'noex/observer';
   *
   * const data = Observer.prepareExportData();
   * const json = exportToJson(data);
   * const csvs = exportToCsv(data);
   * ```
   */
  prepareExportData(): ExportData {
    return createExportData(this.getSnapshot());
  },

  /**
   * Clears all event subscribers.
   * Useful for testing.
   *
   * @internal
   */
  _clearSubscribers(): void {
    eventSubscribers.clear();
  },

  /**
   * Resets the core subscription state.
   * Useful for testing.
   *
   * @internal
   */
  _reset(): void {
    eventSubscribers.clear();
    if (genServerUnsubscribe) {
      genServerUnsubscribe();
      genServerUnsubscribe = null;
    }
    if (supervisorUnsubscribe) {
      supervisorUnsubscribe();
      supervisorUnsubscribe = null;
    }
    coreSubscribed = false;
  },
} as const;
