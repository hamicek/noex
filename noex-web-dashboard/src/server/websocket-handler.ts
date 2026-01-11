/**
 * WebSocket handler for browser client connections.
 *
 * Manages WebSocket connections from browser clients with:
 * - Connection lifecycle management
 * - Message broadcasting to all connected clients
 * - Individual client message handling
 * - Integration with TcpBridge for DashboardServer communication
 * - Connection status tracking and reporting
 *
 * @module server/websocket-handler
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { TcpBridge } from './tcp-bridge.js';
import {
  PROTOCOL_VERSION,
  type WebSocketServerMessage,
  type WebSocketClientMessage,
  type WebSocketServerConfig,
  type ClientMessage,
} from './types.js';

// =============================================================================
// Constants
// =============================================================================

/** Interval for checking client connection health via ping. */
const PING_INTERVAL_MS = 30000;

// =============================================================================
// Types
// =============================================================================

/**
 * Extended WebSocket with client metadata.
 */
interface ClientSocket extends WebSocket {
  isAlive: boolean;
  clientId: string;
}

/**
 * Events emitted by the WebSocket handler.
 */
export type WebSocketHandlerEvent =
  | { readonly type: 'client_connected'; readonly clientId: string; readonly clientCount: number }
  | { readonly type: 'client_disconnected'; readonly clientId: string; readonly clientCount: number }
  | { readonly type: 'client_message'; readonly clientId: string; readonly message: WebSocketClientMessage }
  | { readonly type: 'error'; readonly clientId: string | null; readonly error: Error };

/**
 * Event handler for WebSocket handler events.
 */
export type WebSocketHandlerEventHandler = (event: WebSocketHandlerEvent) => void;

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: WebSocketServerConfig = {
  port: 3000,
  wsPath: '/ws',
};

// =============================================================================
// WebSocketHandler Class
// =============================================================================

/**
 * WebSocket handler for browser client connections.
 *
 * Bridges communication between browser clients and the TcpBridge,
 * handling message routing, broadcasting, and connection lifecycle.
 *
 * @example
 * ```typescript
 * const httpServer = createServer(app);
 * const bridge = new TcpBridge({ port: 9876 });
 * const wsHandler = new WebSocketHandler(httpServer, bridge, { wsPath: '/ws' });
 *
 * // Handler automatically:
 * // - Broadcasts TcpBridge messages to all browser clients
 * // - Forwards client messages to TcpBridge
 * // - Manages connection lifecycle
 *
 * wsHandler.onEvent((event) => {
 *   console.log('WebSocket event:', event.type);
 * });
 * ```
 */
export class WebSocketHandler {
  private readonly config: WebSocketServerConfig;
  private readonly wss: WebSocketServer;
  private readonly tcpBridge: TcpBridge;
  private readonly handlers = new Set<WebSocketHandlerEventHandler>();

  private clientIdCounter = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private bridgeUnsubscribe: (() => void) | null = null;

  constructor(
    httpServer: HttpServer,
    tcpBridge: TcpBridge,
    config: Partial<WebSocketServerConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tcpBridge = tcpBridge;

    this.wss = new WebSocketServer({
      server: httpServer,
      path: this.config.wsPath,
    });

    this.setupServerListeners();
    this.setupBridgeListener();
    this.startPingInterval();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Returns the number of currently connected clients.
   */
  getClientCount(): number {
    return this.wss.clients.size;
  }

  /**
   * Registers an event handler for WebSocket events.
   *
   * @param handler - Callback invoked on each event
   * @returns Unsubscribe function
   */
  onEvent(handler: WebSocketHandlerEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Broadcasts a message to all connected clients.
   *
   * @param message - Message to broadcast
   */
  broadcast(message: WebSocketServerMessage): void {
    const data = JSON.stringify(message);

    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Sends a message to a specific client.
   *
   * @param clientId - Target client ID
   * @param message - Message to send
   * @returns Whether the message was sent
   */
  sendTo(clientId: string, message: WebSocketServerMessage): boolean {
    for (const client of this.wss.clients) {
      const clientSocket = client as ClientSocket;
      if (clientSocket.clientId === clientId && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
        return true;
      }
    }
    return false;
  }

  /**
   * Closes all client connections and stops the server.
   */
  close(): void {
    this.stopPingInterval();

    if (this.bridgeUnsubscribe) {
      this.bridgeUnsubscribe();
      this.bridgeUnsubscribe = null;
    }

    for (const client of this.wss.clients) {
      client.close(1000, 'Server shutting down');
    }

    this.wss.close();
  }

  // ===========================================================================
  // Private Methods - Setup
  // ===========================================================================

  private setupServerListeners(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    this.wss.on('error', (error: Error) => {
      this.emit({ type: 'error', clientId: null, error });
    });
  }

  private setupBridgeListener(): void {
    this.bridgeUnsubscribe = this.tcpBridge.onEvent((event) => {
      switch (event.type) {
        case 'message':
          // Forward all DashboardServer messages to browser clients
          this.broadcast(event.message);
          break;

        case 'connected':
          // Notify clients that connection to DashboardServer is established
          this.broadcast({
            type: 'connection_status',
            payload: { connected: true },
          });
          break;

        case 'disconnected':
          // Notify clients that connection to DashboardServer was lost
          this.broadcast({
            type: 'connection_status',
            payload: { connected: false, error: event.reason },
          });
          break;

        case 'reconnecting':
          // Notify clients about reconnection attempts
          this.broadcast({
            type: 'connection_status',
            payload: {
              connected: false,
              error: `Reconnecting (attempt ${event.attempt})...`,
            },
          });
          break;

        case 'error':
          // Broadcast error as connection status
          this.broadcast({
            type: 'error',
            payload: { code: 'BRIDGE_ERROR', message: event.error.message },
          });
          break;
      }
    });
  }

  // ===========================================================================
  // Private Methods - Connection Handling
  // ===========================================================================

  private handleConnection(ws: WebSocket): void {
    const client = ws as ClientSocket;
    client.isAlive = true;
    client.clientId = this.generateClientId();

    // Send welcome message
    this.sendWelcome(client);

    // Send current bridge connection status
    this.sendConnectionStatus(client);

    // Setup client event handlers
    client.on('message', (data) => {
      this.handleClientMessage(client, data);
    });

    client.on('pong', () => {
      client.isAlive = true;
    });

    client.on('close', () => {
      this.handleClientDisconnect(client);
    });

    client.on('error', (error: Error) => {
      this.emit({ type: 'error', clientId: client.clientId, error });
    });

    this.emit({
      type: 'client_connected',
      clientId: client.clientId,
      clientCount: this.getClientCount(),
    });
  }

  private handleClientMessage(client: ClientSocket, data: unknown): void {
    try {
      const message = this.parseClientMessage(data);
      if (!message) return;

      this.emit({
        type: 'client_message',
        clientId: client.clientId,
        message,
      });

      // Forward message to TcpBridge
      this.forwardToBridge(message);
    } catch (error) {
      this.emit({
        type: 'error',
        clientId: client.clientId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private handleClientDisconnect(client: ClientSocket): void {
    this.emit({
      type: 'client_disconnected',
      clientId: client.clientId,
      clientCount: this.getClientCount(),
    });
  }

  // ===========================================================================
  // Private Methods - Message Handling
  // ===========================================================================

  private parseClientMessage(data: unknown): WebSocketClientMessage | null {
    const text = typeof data === 'string' ? data : data?.toString();
    if (!text) return null;

    const parsed = JSON.parse(text);

    // Validate message type
    if (!parsed || typeof parsed.type !== 'string') {
      return null;
    }

    return parsed as WebSocketClientMessage;
  }

  private forwardToBridge(message: WebSocketClientMessage): void {
    // WebSocketClientMessage maps directly to ClientMessage
    const bridgeMessage: ClientMessage = message;
    this.tcpBridge.send(bridgeMessage);
  }

  private sendWelcome(client: ClientSocket): void {
    const message: WebSocketServerMessage = {
      type: 'welcome',
      payload: {
        version: PROTOCOL_VERSION,
        serverUptime: process.uptime(),
      },
    };
    client.send(JSON.stringify(message));
  }

  private sendConnectionStatus(client: ClientSocket): void {
    const message: WebSocketServerMessage = {
      type: 'connection_status',
      payload: {
        connected: this.tcpBridge.isConnected(),
      },
    };
    client.send(JSON.stringify(message));
  }

  // ===========================================================================
  // Private Methods - Ping/Pong Health Check
  // ===========================================================================

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      this.checkClientHealth();
    }, PING_INTERVAL_MS);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private checkClientHealth(): void {
    for (const ws of this.wss.clients) {
      const client = ws as ClientSocket;

      if (!client.isAlive) {
        // Client didn't respond to last ping, terminate
        client.terminate();
        continue;
      }

      // Mark as not alive and send ping
      client.isAlive = false;
      client.ping();
    }
  }

  // ===========================================================================
  // Private Methods - Utilities
  // ===========================================================================

  private generateClientId(): string {
    this.clientIdCounter++;
    return `client-${Date.now()}-${this.clientIdCounter}`;
  }

  private emit(event: WebSocketHandlerEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors to prevent cascade failures
      }
    }
  }
}
