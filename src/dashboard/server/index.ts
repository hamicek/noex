/**
 * Dashboard Server Module.
 *
 * Provides the DashboardServer GenServer that exposes
 * Observer data over TCP for remote dashboard clients.
 *
 * @example
 * ```typescript
 * import { DashboardServer } from 'noex';
 *
 * const ref = await DashboardServer.start({ port: 9876 });
 * console.log('Dashboard server running on port 9876');
 *
 * // Later...
 * await DashboardServer.stop(ref);
 * ```
 */

// Dashboard Server
export { DashboardServer } from './dashboard-server.js';
export type {
  DashboardServerConfig,
  DashboardServerRef,
} from './dashboard-server.js';
export { DEFAULT_SERVER_CONFIG } from './dashboard-server.js';

// Protocol
export type {
  ServerMessage,
  ClientMessage,
  WelcomeMessage,
  SnapshotMessage,
  EventMessage,
  ErrorMessage,
  GetSnapshotRequest,
  StopProcessRequest,
  PingRequest,
  ProtocolErrorCode,
} from './protocol.js';
export {
  PROTOCOL_VERSION,
  LENGTH_PREFIX_SIZE,
  MAX_MESSAGE_SIZE,
  serializeMessage,
  parseMessage,
  ProtocolError,
} from './protocol.js';
