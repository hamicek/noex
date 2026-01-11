/**
 * Svelte components for noex-web-dashboard.
 *
 * Provides reusable UI components for the dashboard application:
 * - `Layout`: Grid composition for different layout modes
 * - `StatusBar`: Connection status, view mode, keyboard hints
 * - `StatsTable`: Sortable process statistics table
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
 *   import { Layout, StatusBar, StatsTable, MemoryGauge, ProcessTree, EventLog } from '$lib/components';
 * </script>
 *
 * <Layout layoutMode="full" viewMode="local" />
 * <MemoryGauge />
 * <ProcessTree showDetails={true} />
 * <StatsTable showToolbar={true} />
 * <EventLog showToolbar={true} />
 * ```
 */

// Layout components
export { default as Layout } from './Layout.svelte';
export { default as StatusBar } from './StatusBar.svelte';

// Widget components
export { default as StatsTable } from './StatsTable.svelte';
export { default as MemoryGauge } from './MemoryGauge.svelte';
export { default as ProcessTree } from './ProcessTree.svelte';
export { default as ClusterTree } from './ClusterTree.svelte';
export { default as EventLog } from './EventLog.svelte';

// Re-export types from Layout
export type { LayoutMode, ViewMode } from './Layout.svelte';
