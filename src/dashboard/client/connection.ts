/**
 * TCP Connection Manager for Dashboard Client.
 *
 * Handles TCP connection to DashboardServer with:
 * - Length-prefix framed message parsing
 * - Automatic reconnection with exponential backoff
 * - Type-safe event emission
 * - Clean resource management
 */

import net from 'node:net';
import {
  parseMessage,
  serializeMessage,
  type ServerMessage,
  type ClientMessage,
} from '../server/protocol.js';

// =============================================================================
// Configuration
// =============================================================================

/**
 * Connection configuration options.
 */
export interface ConnectionConfig {
  /** Server host address. @default '127.0.0.1' */
  readonly host: string;
  /** Server TCP port. @default 9876 */
  readonly port: number;
  /** Enable automatic reconnection. @default true */
  readonly autoReconnect: boolean;
  /** Initial reconnect delay in milliseconds. @default 1000 */
  readonly reconnectDelayMs: number;
  /** Maximum reconnect delay in milliseconds. @default 30000 */
  readonly maxReconnectDelayMs: number;
  /** Reconnect delay multiplier for exponential backoff. @default 1.5 */
  readonly reconnectBackoffMultiplier: number;
  /** Connection timeout in milliseconds. @default 5000 */
  readonly connectionTimeoutMs: number;
}

/**
 * Default connection configuration.
 */
export const DEFAULT_CONNECTION_CONFIG: ConnectionConfig = {
  host: '127.0.0.1',
  port: 9876,
  autoReconnect: true,
  reconnectDelayMs: 1000,
  maxReconnectDelayMs: 30000,
  reconnectBackoffMultiplier: 1.5,
  connectionTimeoutMs: 5000,
};

// =============================================================================
// Connection State
// =============================================================================

/**
 * Connection state enumeration.
 */
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

/**
 * Connection event types.
 */
export type ConnectionEvent =
  | { readonly type: 'connected' }
  | { readonly type: 'disconnected'; readonly reason: string }
  | { readonly type: 'reconnecting'; readonly attempt: number; readonly delayMs: number }
  | { readonly type: 'message'; readonly message: ServerMessage }
  | { readonly type: 'error'; readonly error: Error };

/**
 * Event handler for connection events.
 */
export type ConnectionEventHandler = (event: ConnectionEvent) => void;

// =============================================================================
// Connection Class
// =============================================================================

/**
 * Manages TCP connection to the DashboardServer.
 *
 * Provides reliable connection with automatic reconnection,
 * message framing, and clean lifecycle management.
 *
 * @example
 * ```typescript
 * const connection = new DashboardConnection({
 *   host: '127.0.0.1',
 *   port: 9876,
 * });
 *
 * connection.onEvent((event) => {
 *   if (event.type === 'message') {
 *     console.log('Received:', event.message);
 *   }
 * });
 *
 * await connection.connect();
 * connection.send({ type: 'get_snapshot' });
 * ```
 */
export class DashboardConnection {
  private readonly config: ConnectionConfig;
  private readonly handlers: Set<ConnectionEventHandler> = new Set();

  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private state: ConnectionState = 'disconnected';

  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;

  constructor(config: Partial<ConnectionConfig> = {}) {
    this.config = { ...DEFAULT_CONNECTION_CONFIG, ...config };
  }

  /**
   * Returns the current connection state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Returns whether the connection is currently active.
   */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Registers an event handler for connection events.
   *
   * @param handler - The event handler function
   * @returns Unsubscribe function
   */
  onEvent(handler: ConnectionEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Connects to the DashboardServer.
   *
   * @returns Promise that resolves when connected
   * @throws Error if connection fails and autoReconnect is disabled
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
   * Sends a message to the server.
   *
   * @param message - The message to send
   * @returns Whether the message was sent successfully
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
   * Sends a ping to keep the connection alive.
   */
  ping(): boolean {
    return this.send({ type: 'ping' });
  }

  /**
   * Requests a fresh snapshot from the server.
   */
  requestSnapshot(): boolean {
    return this.send({ type: 'get_snapshot' });
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private attemptConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setState('connecting');
      this.buffer = Buffer.alloc(0);

      const socket = new net.Socket();
      this.socket = socket;

      // Connection timeout
      this.connectionTimer = setTimeout(() => {
        socket.destroy();
        const error = new Error(
          `Connection timeout after ${this.config.connectionTimeoutMs}ms`,
        );
        this.handleConnectionError(error, reject);
      }, this.config.connectionTimeoutMs);

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

  private handleDisconnect(reason: string): void {
    this.cleanup();

    if (this.intentionalDisconnect) {
      return;
    }

    this.emit({ type: 'disconnected', reason });

    if (this.config.autoReconnect) {
      this.scheduleReconnect();
    } else {
      this.setState('disconnected');
    }
  }

  private handleConnectionError(error: Error, reject?: (error: Error) => void): void {
    this.cleanup();

    if (this.intentionalDisconnect) {
      return;
    }

    this.emit({ type: 'error', error });

    if (this.config.autoReconnect && this.state !== 'disconnected') {
      this.scheduleReconnect();
    } else {
      this.setState('disconnected');
      if (reject) {
        reject(error);
      }
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
        // Error handling is done in attemptConnection
      });
    }, delay);
  }

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

  private setState(state: ConnectionState): void {
    this.state = state;
  }

  private emit(event: ConnectionEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors
      }
    }
  }
}
