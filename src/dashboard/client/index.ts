/**
 * Dashboard Client Module.
 *
 * Provides a remote TUI client that connects to DashboardServer
 * over TCP and renders the dashboard locally.
 *
 * @example
 * ```typescript
 * import { DashboardClient } from 'noex/dashboard/client';
 *
 * const client = new DashboardClient({
 *   host: '127.0.0.1',
 *   port: 9876,
 * });
 *
 * await client.start();
 * ```
 */

// Main client
export { DashboardClient } from './dashboard-client.js';
export type { DashboardClientConfig } from './dashboard-client.js';

// Connection manager
export { DashboardConnection } from './connection.js';
export type {
  ConnectionConfig,
  ConnectionState,
  ConnectionEvent,
  ConnectionEventHandler,
} from './connection.js';
