/**
 * Svelte stores for noex-web-dashboard.
 *
 * Provides reactive state management for the dashboard application:
 * - `connection`: WebSocket connection state and messaging
 * - `snapshot`: Local observer snapshot data
 * - `events`: Event log with filtering
 * - `cluster`: Cluster-wide state and node data
 *
 * @module stores
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { connection, snapshot, events, cluster } from '$lib/stores';
 *
 *   // Connect on mount
 *   connection.connect();
 *
 *   // Access reactive state
 *   const isOnline = connection.isConnected;
 *   const processCount = snapshot.processCount;
 *   const eventLog = events.all;
 *   const nodeCount = cluster.nodeCount;
 * </script>
 * ```
 */

// Connection store
export { connection, createConnectionStore } from './connection.js';
export type {
  ConnectionState,
  ConnectionConfig,
  ServerMessage,
  ClientMessage,
  MessageHandler,
} from './connection.js';

// Snapshot store
export { snapshot, createSnapshotStore } from './snapshot.js';
export type { ProcessInfo } from './snapshot.js';
export type {
  ObserverSnapshot,
  GenServerStats,
  SupervisorStats,
  ProcessTreeNode,
  MemoryStats,
} from './snapshot.js';

// Events store
export { events, createEventStore } from './events.js';
export type { LoggedEvent, EventType, EventStoreConfig, ObserverEvent } from './events.js';

// Cluster store
export { cluster, createClusterStore } from './cluster.js';
export type {
  ClusterStatus,
  ClusterObserverSnapshot,
  NodeObserverSnapshot,
  ClusterAggregatedStats,
  NodeObserverStatus,
} from './cluster.js';
