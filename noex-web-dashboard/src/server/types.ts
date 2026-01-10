/**
 * Server-side type definitions for noex-web-dashboard.
 *
 * Re-exports protocol and observer types from noex for use in the
 * TCP bridge and WebSocket handler. This module serves as the single
 * source of truth for all server-side type imports.
 *
 * @module server/types
 */

// =============================================================================
// Protocol Types (for TCP bridge communication with DashboardServer)
// =============================================================================

export type {
  // Server -> Client messages
  ServerMessage,
  WelcomeMessage,
  SnapshotMessage,
  EventMessage,
  ErrorMessage,
  ClusterSnapshotMessage,
  ClusterStatusMessage,
  // Client -> Server messages
  ClientMessage,
  GetSnapshotRequest,
  StopProcessRequest,
  PingRequest,
  GetClusterSnapshotRequest,
  GetClusterStatusRequest,
  // Parsing utilities
  ParseResult,
  ProtocolErrorCode,
} from 'noex';

export {
  // Serialization functions (needed for TCP framing)
  serializeMessage,
  parseMessage,
  // Protocol constants
  PROTOCOL_VERSION,
  LENGTH_PREFIX_SIZE,
  MAX_MESSAGE_SIZE,
  // Error class
  ProtocolError,
} from 'noex';

// =============================================================================
// Observer Types (for snapshot and event data)
// =============================================================================

export type {
  // Local observer snapshot
  ObserverSnapshot,
  ObserverEvent,
  // Cluster observer types
  ClusterObserverSnapshot,
  NodeObserverSnapshot,
  NodeObserverStatus,
  ClusterAggregatedStats,
  // Process statistics
  GenServerStats,
  SupervisorStats,
  ProcessTreeNode,
  MemoryStats,
} from 'noex';

// =============================================================================
// WebSocket Message Types (for browser communication)
// =============================================================================

/**
 * WebSocket message sent from server to browser clients.
 *
 * Uses the same structure as ServerMessage but transmitted as plain JSON
 * over WebSocket (no length-prefix framing needed).
 */
export type WebSocketServerMessage =
  | { readonly type: 'welcome'; readonly payload: { readonly version: string; readonly serverUptime: number } }
  | { readonly type: 'snapshot'; readonly payload: import('noex').ObserverSnapshot }
  | { readonly type: 'event'; readonly payload: import('noex').ObserverEvent }
  | { readonly type: 'error'; readonly payload: { readonly code: string; readonly message: string } }
  | { readonly type: 'cluster_snapshot'; readonly payload: import('noex').ClusterObserverSnapshot }
  | { readonly type: 'cluster_status'; readonly payload: { readonly available: boolean; readonly nodeId?: string } }
  | { readonly type: 'connection_status'; readonly payload: { readonly connected: boolean; readonly error?: string } };

/**
 * WebSocket message sent from browser clients to server.
 *
 * Uses the same structure as ClientMessage but transmitted as plain JSON.
 */
export type WebSocketClientMessage =
  | { readonly type: 'get_snapshot' }
  | { readonly type: 'stop_process'; readonly payload: { readonly processId: string; readonly reason?: string } }
  | { readonly type: 'ping' }
  | { readonly type: 'get_cluster_snapshot' }
  | { readonly type: 'get_cluster_status' };

// =============================================================================
// Connection State Types
// =============================================================================

/**
 * TCP connection state for the bridge to DashboardServer.
 */
export type TcpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/**
 * Configuration for the TCP bridge connection.
 */
export interface TcpBridgeConfig {
  /** Host of the DashboardServer. @default 'localhost' */
  readonly host: string;
  /** Port of the DashboardServer. @default 9876 */
  readonly port: number;
  /** Initial reconnect delay in milliseconds. @default 1000 */
  readonly reconnectDelayMs: number;
  /** Maximum reconnect delay in milliseconds. @default 30000 */
  readonly maxReconnectDelayMs: number;
  /** Reconnect backoff multiplier. @default 1.5 */
  readonly reconnectBackoffMultiplier: number;
}

/**
 * Configuration for the WebSocket server.
 */
export interface WebSocketServerConfig {
  /** Port for the HTTP/WebSocket server. @default 3000 */
  readonly port: number;
  /** Path for WebSocket connections. @default '/ws' */
  readonly wsPath: string;
}

/**
 * Combined server configuration.
 */
export interface BridgeServerConfig {
  /** TCP bridge configuration */
  readonly tcp: TcpBridgeConfig;
  /** WebSocket server configuration */
  readonly ws: WebSocketServerConfig;
  /** Path to static files (built Svelte app). @default './dist/client' */
  readonly staticPath: string;
}

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: BridgeServerConfig = {
  tcp: {
    host: 'localhost',
    port: 9876,
    reconnectDelayMs: 1000,
    maxReconnectDelayMs: 30000,
    reconnectBackoffMultiplier: 1.5,
  },
  ws: {
    port: 3000,
    wsPath: '/ws',
  },
  staticPath: './dist/client',
};
