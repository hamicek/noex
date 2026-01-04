/**
 * Dashboard module exports.
 *
 * Provides a TUI-based monitoring interface for noex processes.
 * This module is optional and requires blessed-contrib to be installed.
 *
 * @example
 * ```typescript
 * import { Dashboard } from 'noex/dashboard';
 *
 * const dashboard = new Dashboard({
 *   refreshInterval: 500,
 *   theme: 'dark',
 * });
 *
 * dashboard.start();
 * ```
 */

// Main Dashboard (local)
export { Dashboard } from './dashboard.js';
export type {
  DashboardConfig,
  DashboardOptions,
  DashboardLayout,
  DashboardTheme,
  ThemeName,
  EventLogEntry,
} from './types.js';
export { DEFAULT_CONFIG, DARK_THEME, LIGHT_THEME, getTheme } from './types.js';

// Dashboard Server
export { DashboardServer } from './server/dashboard-server.js';
export type {
  DashboardServerConfig,
  DashboardServerRef,
} from './server/dashboard-server.js';

// Dashboard Client (remote)
export { DashboardClient, DashboardConnection } from './client/index.js';
export type {
  DashboardClientConfig,
  ConnectionConfig,
  ConnectionState,
  ConnectionEvent,
} from './client/index.js';
