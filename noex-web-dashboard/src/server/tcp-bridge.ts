/**
 * TCP Bridge for connecting to DashboardServer.
 *
 * Manages a TCP connection to the noex DashboardServer with:
 * - Length-prefix framed message parsing
 * - Automatic reconnection with exponential backoff
 * - Type-safe event emission
 * - Clean resource management
 *
 * This bridge is used by the WebSocket handler to relay messages
 * between browser clients and the DashboardServer.
 *
 * @module server/tcp-bridge
 */

import net from 'node:net';
import {
  parseMessage,
  serializeMessage,
  type ServerMessage,
  type ClientMessage,
  type TcpBridgeConfig,
  type TcpConnectionState,
} from './types.js';

// =============================================================================
// Constants
// =============================================================================

/** Default connection timeout in milliseconds. */
const CONNECTION_TIMEOUT_MS = 5000;

// =============================================================================
// Event Types
// =============================================================================

/**
 * Events emitted by the TCP bridge.
 */
export type TcpBridgeEvent =
  | { readonly type: 'connected' }
  | { readonly type: 'disconnected'; readonly reason: string }
  | { readonly type: 'reconnecting'; readonly attempt: number; readonly delayMs: number }
  | { readonly type: 'message'; readonly message: ServerMessage }
  | { readonly type: 'error'; readonly error: Error };

/**
 * Event handler for TCP bridge events.
 */
export type TcpBridgeEventHandler = (event: TcpBridgeEvent) => void;

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: TcpBridgeConfig = {
  host: 'localhost',
  port: 9876,
  reconnectDelayMs: 1000,
  maxReconnectDelayMs: 30000,
  reconnectBackoffMultiplier: 1.5,
};

// =============================================================================
// TcpBridge Class
// =============================================================================

/**
 * TCP bridge that maintains a connection to DashboardServer.
 *
 * Provides reliable communication with automatic reconnection,
 * message framing, and clean lifecycle management.
 *
 * @example
 * ```typescript
 * const bridge = new TcpBridge({ host: '127.0.0.1', port: 9876 });
 *
 * bridge.onEvent((event) => {
 *   if (event.type === 'message') {
 *     // Forward to WebSocket clients
 *     broadcastToClients(event.message);
 *   }
 * });
 *
 * await bridge.connect();
 * bridge.send({ type: 'get_snapshot' });
 * ```
 */
export class TcpBridge {
  private readonly config: TcpBridgeConfig;
  private readonly handlers = new Set<TcpBridgeEventHandler>();

  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private state: TcpConnectionState = 'disconnected';

  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;

  constructor(config: Partial<TcpBridgeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Returns the current connection state.
   */
  getState(): TcpConnectionState {
    return this.state;
  }

  /**
   * Returns whether the connection is currently active.
   */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Registers an event handler for bridge events.
   *
   * @param handler - Callback invoked on each event
   * @returns Unsubscribe function
   */
  onEvent(handler: TcpBridgeEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Connects to the DashboardServer.
   *
   * Establishes TCP connection and begins receiving messages.
   * If already connected or connecting, this is a no-op.
   *
   * @returns Promise that resolves when connected
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.intentionalDisconnect = false;
    this.reconnectAttempt = 0;

    return this.attemptConnection();
  }

  /**
   * Disconnects from the server.
   *
   * Performs a clean disconnect without triggering reconnection.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.cleanup();
    this.setState('disconnected');
    this.emit({ type: 'disconnected', reason: 'manual' });
  }

  /**
   * Sends a message to the DashboardServer.
   *
   * @param message - The client message to send
   * @returns Whether the message was queued for sending
   */
  send(message: ClientMessage): boolean {
    if (!this.socket || this.state !== 'connected') {
      return false;
    }

    try {
      const buffer = serializeMessage(message);
      return this.socket.write(buffer);
    } catch {
      return false;
    }
  }

  /**
   * Requests a fresh snapshot from the server.
   */
  requestSnapshot(): boolean {
    return this.send({ type: 'get_snapshot' });
  }

  /**
   * Requests cluster snapshot from the server.
   */
  requestClusterSnapshot(): boolean {
    return this.send({ type: 'get_cluster_snapshot' });
  }

  /**
   * Requests cluster availability status.
   */
  requestClusterStatus(): boolean {
    return this.send({ type: 'get_cluster_status' });
  }

  /**
   * Sends a keep-alive ping.
   */
  ping(): boolean {
    return this.send({ type: 'ping' });
  }

  // ===========================================================================
  // Private Methods - Connection
  // ===========================================================================

  private attemptConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setState('connecting');
      this.buffer = Buffer.alloc(0);

      const socket = new net.Socket();
      this.socket = socket;

      this.connectionTimer = setTimeout(() => {
        socket.destroy();
        const error = new Error(`Connection timeout after ${CONNECTION_TIMEOUT_MS}ms`);
        this.handleConnectionError(error, reject);
      }, CONNECTION_TIMEOUT_MS);

      socket.on('connect', () => {
        this.clearConnectionTimeout();
        this.reconnectAttempt = 0;
        this.setState('connected');
        this.emit({ type: 'connected' });
        resolve();
      });

      socket.on('data', (chunk) => {
        this.handleData(chunk);
      });

      socket.on('close', () => {
        this.handleDisconnect('connection closed');
      });

      socket.on('error', (error) => {
        this.clearConnectionTimeout();
        this.handleConnectionError(error, reject);
      });

      socket.connect(this.config.port, this.config.host);
    });
  }

  // ===========================================================================
  // Private Methods - Data Handling
  // ===========================================================================

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      try {
        const result = parseMessage<ServerMessage>(this.buffer);
        if (!result.message) break;

        this.buffer = this.buffer.subarray(result.bytesConsumed);
        this.emit({ type: 'message', message: result.message });
      } catch (error) {
        this.emit({
          type: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        });
        break;
      }
    }
  }

  // ===========================================================================
  // Private Methods - Disconnect & Reconnect
  // ===========================================================================

  private handleDisconnect(reason: string): void {
    this.cleanup();

    if (this.intentionalDisconnect) {
      return;
    }

    this.emit({ type: 'disconnected', reason });
    this.scheduleReconnect();
  }

  private handleConnectionError(error: Error, reject?: (error: Error) => void): void {
    this.cleanup();

    if (this.intentionalDisconnect) {
      return;
    }

    this.emit({ type: 'error', error });

    if (this.state !== 'disconnected') {
      this.scheduleReconnect();
    } else if (reject) {
      reject(error);
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt++;

    const delay = Math.min(
      this.config.reconnectDelayMs *
        Math.pow(this.config.reconnectBackoffMultiplier, this.reconnectAttempt - 1),
      this.config.maxReconnectDelayMs,
    );

    this.setState('reconnecting');
    this.emit({
      type: 'reconnecting',
      attempt: this.reconnectAttempt,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptConnection().catch(() => {
        // Reconnection errors are handled via events
      });
    }, delay);
  }

  // ===========================================================================
  // Private Methods - Cleanup
  // ===========================================================================

  private cleanup(): void {
    this.clearConnectionTimeout();
    this.clearReconnectTimer();

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    this.buffer = Buffer.alloc(0);
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: TcpConnectionState): void {
    this.state = state;
  }

  private emit(event: TcpBridgeEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors to prevent cascade failures
      }
    }
  }
}
