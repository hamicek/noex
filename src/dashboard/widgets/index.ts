/**
 * Dashboard widgets module.
 *
 * Exports all widget components and their associated types
 * for building the dashboard UI.
 */

// Base types and interfaces
export type { Widget, GridPosition, WidgetConfig } from './types.js';
export { BaseWidget } from './types.js';

// Process Tree Widget
export { ProcessTreeWidget } from './process-tree.js';
export type { ProcessTreeData } from './process-tree.js';

// Stats Table Widget
export { StatsTableWidget } from './stats-table.js';
export type { StatsTableData } from './stats-table.js';

// Memory Gauge Widget
export { MemoryGaugeWidget } from './memory-gauge.js';
export type { MemoryGaugeData } from './memory-gauge.js';

// Event Log Widget
export { EventLogWidget, createEventLogWidget } from './event-log.js';
export type { LogEvent, EventSeverity, EventLogConfig } from './event-log.js';

// Process Detail View
export { ProcessDetailView } from './process-detail.js';
export type { ProcessDetailData } from './process-detail.js';

// Cluster Tree Widget
export { ClusterTreeWidget } from './cluster-tree.js';
export type { ClusterTreeData } from './cluster-tree.js';
