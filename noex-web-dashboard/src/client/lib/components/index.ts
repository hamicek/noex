/**
 * Svelte components for noex-web-dashboard.
 *
 * Provides reusable UI components for the dashboard application:
 * - `StatusBar`: Connection status, view mode, keyboard hints
 * - `MemoryGauge`: Visual memory usage gauge with thresholds
 * - `ClusterTree`: Cluster nodes hierarchical view
 *
 * @module components
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { StatusBar, MemoryGauge, ClusterTree } from '$lib/components';
 * </script>
 *
 * <MemoryGauge />
 * <ClusterTree showDetails={true} />
 * <StatusBar viewMode="local" layoutMode="full" />
 * ```
 */

// Layout components
export { default as StatusBar } from './StatusBar.svelte';

// Widget components
export { default as MemoryGauge } from './MemoryGauge.svelte';
export { default as ClusterTree } from './ClusterTree.svelte';
