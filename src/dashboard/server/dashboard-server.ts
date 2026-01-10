/**
 * DashboardServer - GenServer that exposes dashboard data over TCP.
 *
 * Runs alongside the application, collects data from Observer,
 * and broadcasts updates to connected dashboard clients.
 */

import net from 'node:net';
import { GenServer } from '../../core/gen-server.js';
import type { GenServerBehavior, GenServerRef, ObserverEvent } from '../../core/types.js';
import { Observer } from '../../observer/observer.js';
import { ClusterObserver } from '../../observer/cluster-observer.js';
import { Cluster } from '../../distribution/cluster/cluster.js';
import {
  serializeMessage,
  parseMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
  type ClientMessage,
  type ProtocolErrorCode,
} from './protocol.js';

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration options for DashboardServer.
 */
export interface DashboardServerConfig {
  /** TCP port to listen on. @default 9876 */
  readonly port: number;
  /** Host address to bind to. @default '127.0.0.1' */
  readonly host: string;
  /** Polling interval in milliseconds for stats updates. @default 500 */
  readonly pollingIntervalMs: number;
}

/**
 * Default configuration values.
 */
export const DEFAULT_SERVER_CONFIG: DashboardServerConfig = {
  port: 9876,
  host: '127.0.0.1',
  pollingIntervalMs: 500,
};

// =============================================================================
// GenServer Types
// =============================================================================

/**
 * Internal state for DashboardServer.
 */
interface DashboardServerState {
  /** TCP server instance */
  server: net.Server | null;
  /** Connected clients by ID */
  clients: Map<string, ClientConnection>;
  /** Unsubscribe function for Observer events */
  eventUnsubscribe: (() => void) | null;
  /** Unsubscribe function for polling */
  pollingUnsubscribe: (() => void) | null;
  /** Server start timestamp */
  startedAt: number;
  /** Configuration */
  config: DashboardServerConfig;
  /** Client ID counter */
  clientIdCounter: number;
}

/**
 * Represents a connected client.
 */
interface ClientConnection {
  id: string;
  socket: net.Socket;
  buffer: Buffer;
  connectedAt: number;
}

/**
 * Call message types for DashboardServer.
 */
type DashboardServerCallMsg =
  | { readonly type: 'get_status' }
  | { readonly type: 'get_client_count' };

/**
 * Cast message types for DashboardServer.
 */
type DashboardServerCastMsg =
  | { readonly type: 'client_connected'; readonly socket: net.Socket }
  | { readonly type: 'client_disconnected'; readonly clientId: string }
  | { readonly type: 'client_message'; readonly clientId: string; readonly message: ClientMessage }
  | { readonly type: 'broadcast_snapshot' }
  | { readonly type: 'broadcast_event'; readonly event: ObserverEvent };

/**
 * Reply types for DashboardServer calls.
 */
type DashboardServerReply =
  | { readonly status: 'running'; readonly port: number; readonly host: string; readonly clientCount: number; readonly uptime: number }
  | { readonly clientCount: number };

// =============================================================================
// Client Helpers
// =============================================================================

/**
 * Sends a message to a specific client.
 */
function sendToClient(client: ClientConnection, message: ServerMessage): boolean {
  try {
    const buffer = serializeMessage(message);
    return client.socket.write(buffer);
  } catch {
    return false;
  }
}

/**
 * Broadcasts a message to all connected clients.
 */
function broadcastToClients(
  clients: Map<string, ClientConnection>,
  message: ServerMessage,
): void {
  const buffer = serializeMessage(message);
  for (const client of clients.values()) {
    try {
      client.socket.write(buffer);
    } catch {
      // Ignore write errors, client will be cleaned up on disconnect
    }
  }
}

/**
 * Sends an error message to a client.
 */
function sendError(
  client: ClientConnection,
  code: ProtocolErrorCode | string,
  message: string,
): void {
  sendToClient(client, {
    type: 'error',
    payload: { code, message },
  });
}

// =============================================================================
// GenServer Behavior
// =============================================================================

/**
 * Result of creating behavior - includes setter for selfRef.
 */
interface BehaviorFactoryResult {
  behavior: GenServerBehavior<
    DashboardServerState,
    DashboardServerCallMsg,
    DashboardServerCastMsg,
    DashboardServerReply
  >;
  setSelfRef: (ref: DashboardServerRef) => void;
}

/**
 * Creates the DashboardServer GenServer behavior.
 */
function createDashboardServerBehavior(
  config: DashboardServerConfig,
): BehaviorFactoryResult {
  // We need a reference to the GenServer to send casts to ourselves
  let selfRef: GenServerRef<
    DashboardServerState,
    DashboardServerCallMsg,
    DashboardServerCastMsg,
    DashboardServerReply
  > | null = null;

  const behavior: GenServerBehavior<
    DashboardServerState,
    DashboardServerCallMsg,
    DashboardServerCastMsg,
    DashboardServerReply
  > = {
    init(): DashboardServerState {
      return {
        server: null,
        clients: new Map(),
        eventUnsubscribe: null,
        pollingUnsubscribe: null,
        startedAt: Date.now(),
        config,
        clientIdCounter: 0,
      };
    },

    handleCall(
      msg: DashboardServerCallMsg,
      state: DashboardServerState,
    ): [DashboardServerReply, DashboardServerState] {
      switch (msg.type) {
        case 'get_status':
          return [{
            status: 'running',
            port: state.config.port,
            host: state.config.host,
            clientCount: state.clients.size,
            uptime: Date.now() - state.startedAt,
          }, state];

        case 'get_client_count':
          return [{ clientCount: state.clients.size }, state];

        default: {
          const _exhaustive: never = msg;
          throw new Error(`Unknown call message type: ${(_exhaustive as DashboardServerCallMsg).type}`);
        }
      }
    },

    handleCast(
      msg: DashboardServerCastMsg,
      state: DashboardServerState,
    ): DashboardServerState {
      switch (msg.type) {
        case 'client_connected': {
          const clientId = `client_${++state.clientIdCounter}`;
          const client: ClientConnection = {
            id: clientId,
            socket: msg.socket,
            buffer: Buffer.alloc(0),
            connectedAt: Date.now(),
          };

          state.clients.set(clientId, client);

          // Setup socket handlers
          setupClientHandlers(client, selfRef!);

          // Send welcome message
          sendToClient(client, {
            type: 'welcome',
            payload: {
              version: PROTOCOL_VERSION,
              serverUptime: Date.now() - state.startedAt,
            },
          });

          // Send initial snapshot
          const snapshot = Observer.getSnapshot();
          sendToClient(client, {
            type: 'snapshot',
            payload: snapshot,
          });

          return state;
        }

        case 'client_disconnected': {
          const client = state.clients.get(msg.clientId);
          if (client) {
            client.socket.destroy();
            state.clients.delete(msg.clientId);
          }
          return state;
        }

        case 'client_message': {
          const client = state.clients.get(msg.clientId);
          if (!client) return state;

          handleClientMessage(client, msg.message);
          return state;
        }

        case 'broadcast_snapshot': {
          const snapshot = Observer.getSnapshot();
          broadcastToClients(state.clients, {
            type: 'snapshot',
            payload: snapshot,
          });
          return state;
        }

        case 'broadcast_event': {
          broadcastToClients(state.clients, {
            type: 'event',
            payload: msg.event,
          });
          return state;
        }

        default: {
          const _exhaustive: never = msg;
          throw new Error(`Unknown cast message type: ${(_exhaustive as DashboardServerCastMsg).type}`);
        }
      }
    },

    terminate(
      _reason: import('../../core/types.js').TerminateReason,
      state: DashboardServerState,
    ): void {
      // Cleanup polling
      if (state.pollingUnsubscribe) {
        state.pollingUnsubscribe();
      }

      // Cleanup event subscription
      if (state.eventUnsubscribe) {
        state.eventUnsubscribe();
      }

      // Close all client connections
      for (const client of state.clients.values()) {
        client.socket.destroy();
      }
      state.clients.clear();

      // Close TCP server
      if (state.server) {
        state.server.close();
      }
    },
  };

  /**
   * Sets up event handlers for a client socket.
   */
  function setupClientHandlers(
    client: ClientConnection,
    ref: GenServerRef<
      DashboardServerState,
      DashboardServerCallMsg,
      DashboardServerCastMsg,
      DashboardServerReply
    >,
  ): void {
    client.socket.on('data', (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);

      // Process complete messages
      while (true) {
        try {
          const result = parseMessage<ClientMessage>(client.buffer);
          if (!result.message) break;

          // Update buffer to remove consumed bytes
          client.buffer = client.buffer.subarray(result.bytesConsumed);

          // Send message to GenServer for processing
          GenServer.cast(ref, {
            type: 'client_message',
            clientId: client.id,
            message: result.message,
          });
        } catch (error) {
          // Protocol error - send error and disconnect
          sendError(
            client,
            'PARSE_ERROR',
            error instanceof Error ? error.message : 'Invalid message',
          );
          GenServer.cast(ref, { type: 'client_disconnected', clientId: client.id });
          break;
        }
      }
    });

    client.socket.on('close', () => {
      // Server may have already stopped - ignore errors
      try {
        GenServer.cast(ref, { type: 'client_disconnected', clientId: client.id });
      } catch {
        // Server stopped, ignore
      }
    });

    client.socket.on('error', () => {
      // Server may have already stopped - ignore errors
      try {
        GenServer.cast(ref, { type: 'client_disconnected', clientId: client.id });
      } catch {
        // Server stopped, ignore
      }
    });
  }

  /**
   * Handles a message from a client.
   */
  function handleClientMessage(
    client: ClientConnection,
    message: ClientMessage,
  ): void {
    switch (message.type) {
      case 'get_snapshot': {
        const snapshot = Observer.getSnapshot();
        sendToClient(client, { type: 'snapshot', payload: snapshot });
        break;
      }

      case 'stop_process': {
        Observer.stopProcess(message.payload.processId, message.payload.reason)
          .then((result) => {
            if (!result.success) {
              sendError(client, 'STOP_FAILED', result.error ?? 'Unknown error');
            }
          })
          .catch((error) => {
            sendError(
              client,
              'STOP_FAILED',
              error instanceof Error ? error.message : 'Unknown error',
            );
          });
        break;
      }

      case 'ping':
        // No response needed, just keeps connection alive
        break;

      case 'get_cluster_status': {
        const isClusterRunning = Cluster.getStatus() === 'running';
        const payload: { readonly available: boolean; readonly nodeId?: string } = isClusterRunning
          ? { available: true, nodeId: Cluster.getLocalNodeId() }
          : { available: false };
        sendToClient(client, { type: 'cluster_status', payload });
        break;
      }

      case 'get_cluster_snapshot': {
        if (Cluster.getStatus() !== 'running') {
          sendError(client, 'CLUSTER_NOT_AVAILABLE', 'Cluster is not running');
          break;
        }

        ClusterObserver.getClusterSnapshot()
          .then((snapshot) => {
            sendToClient(client, { type: 'cluster_snapshot', payload: snapshot });
          })
          .catch((error) => {
            sendError(
              client,
              'CLUSTER_ERROR',
              error instanceof Error ? error.message : 'Unknown error',
            );
          });
        break;
      }
    }
  }

  return {
    behavior,
    setSelfRef: (ref: DashboardServerRef) => {
      selfRef = ref;
    },
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Reference type for DashboardServer.
 */
export type DashboardServerRef = GenServerRef<
  DashboardServerState,
  DashboardServerCallMsg,
  DashboardServerCastMsg,
  DashboardServerReply
>;

/**
 * DashboardServer public API.
 *
 * Provides methods to start/stop the dashboard server and query its status.
 *
 * @example
 * ```typescript
 * import { DashboardServer } from 'noex';
 *
 * // Start the dashboard server
 * const ref = await DashboardServer.start({ port: 9876 });
 *
 * // Check status
 * const status = await DashboardServer.getStatus(ref);
 * console.log(`Dashboard server running on ${status.host}:${status.port}`);
 * console.log(`${status.clientCount} clients connected`);
 *
 * // Stop when done
 * await DashboardServer.stop(ref);
 * ```
 */
export const DashboardServer = {
  /**
   * Starts the DashboardServer.
   *
   * Creates a TCP server that listens for dashboard client connections
   * and broadcasts Observer data updates.
   *
   * @param config - Configuration options
   * @returns Reference to the started server
   */
  async start(
    config: Partial<DashboardServerConfig> = {},
  ): Promise<DashboardServerRef> {
    const fullConfig: DashboardServerConfig = {
      ...DEFAULT_SERVER_CONFIG,
      ...config,
    };

    const { behavior, setSelfRef } = createDashboardServerBehavior(fullConfig);
    const ref = await GenServer.start(behavior);

    // Set the self reference for internal casts
    setSelfRef(ref);

    // Start TCP server after GenServer is initialized
    await startTcpServer(ref, fullConfig);

    return ref;
  },

  /**
   * Stops the DashboardServer.
   *
   * Closes all client connections and the TCP server.
   *
   * @param ref - Reference to the server to stop
   */
  async stop(ref: DashboardServerRef): Promise<void> {
    await GenServer.stop(ref);
  },

  /**
   * Gets the current status of the DashboardServer.
   *
   * @param ref - Reference to the server
   * @returns Status information
   */
  async getStatus(ref: DashboardServerRef): Promise<{
    status: 'running';
    port: number;
    host: string;
    clientCount: number;
    uptime: number;
  }> {
    const result = await GenServer.call(ref, { type: 'get_status' });
    return result as {
      status: 'running';
      port: number;
      host: string;
      clientCount: number;
      uptime: number;
    };
  },

  /**
   * Gets the number of connected clients.
   *
   * @param ref - Reference to the server
   * @returns Number of connected clients
   */
  async getClientCount(ref: DashboardServerRef): Promise<number> {
    const result = await GenServer.call(ref, { type: 'get_client_count' });
    return (result as { clientCount: number }).clientCount;
  },
} as const;

// =============================================================================
// TCP Server Setup
// =============================================================================

/**
 * Starts the TCP server and configures Observer subscriptions.
 */
async function startTcpServer(
  ref: DashboardServerRef,
  config: DashboardServerConfig,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      GenServer.cast(ref, { type: 'client_connected', socket });
    });

    server.on('error', (error) => {
      reject(error);
    });

    server.listen(config.port, config.host, () => {
      // Subscribe to Observer events
      const eventUnsubscribe = Observer.subscribe((event) => {
        GenServer.cast(ref, { type: 'broadcast_event', event });
      });

      // Start polling for stats updates
      const pollingUnsubscribe = Observer.startPolling(
        config.pollingIntervalMs,
        (event) => {
          if (event.type === 'stats_update') {
            GenServer.cast(ref, { type: 'broadcast_snapshot' });
          }
        },
      );

      // Store server and unsubscribe functions in state
      // We need to access internal state here, which is a bit hacky
      // but necessary for proper cleanup
      (ref as unknown as { _server: net.Server })._server = server;
      (ref as unknown as { _eventUnsubscribe: () => void })._eventUnsubscribe = eventUnsubscribe;
      (ref as unknown as { _pollingUnsubscribe: () => void })._pollingUnsubscribe = pollingUnsubscribe;

      resolve();
    });
  });
}
