/**
 * Svelte components for noex-web-dashboard.
 *
 * Provides reusable UI components for the dashboard application:
 * - `StatusBar`: Connection status, view mode, keyboard hints
 * - `MemoryGauge`: Visual memory usage gauge with thresholds
 * - `ClusterTree`: Cluster nodes hierarchical view
 * - `ProcessTree`: Process supervision hierarchy view
 * - `EventLog`: Scrollable event log with filtering
 *
 * @module components
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { StatusBar, MemoryGauge, ClusterTree, ProcessTree, EventLog } from '$lib/components';
 * </script>
 *
 * <MemoryGauge />
 * <ProcessTree showDetails={true} />
 * <ClusterTree showDetails={true} />
 * <EventLog showToolbar={true} />
 * <StatusBar viewMode="local" layoutMode="full" />
 * ```
 */

// Layout components
export { default as StatusBar } from './StatusBar.svelte';

// Widget components
export { default as MemoryGauge } from './MemoryGauge.svelte';
export { default as ProcessTree } from './ProcessTree.svelte';
export { default as ClusterTree } from './ClusterTree.svelte';
export { default as EventLog } from './EventLog.svelte';
