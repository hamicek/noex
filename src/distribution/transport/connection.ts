/**
 * TCP Connection implementation for cluster communication.
 *
 * Provides a reliable, bidirectional TCP connection with:
 * - Length-prefix framing for message boundaries
 * - Automatic reconnection with exponential backoff
 * - Event-based message handling
 *
 * @module distribution/transport/connection
 */

import * as net from 'node:net';
import { EventEmitter } from 'node:events';

import type { NodeId, MessageEnvelope, ClusterMessage } from '../types.js';
import { CLUSTER_DEFAULTS, NodeNotReachableError } from '../types.js';
import { NodeId as NodeIdUtils } from '../node-id.js';
import { Serializer, type SerializeOptions, type DeserializeOptions } from '../serialization.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Connection state.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'closing';

/**
 * Configuration for a connection.
 */
export interface ConnectionConfig {
  /** Target node identifier */
  readonly remoteNodeId: NodeId;

  /** Local node identifier (for message signing) */
  readonly localNodeId: NodeId;

  /** Cluster secret for HMAC authentication */
  readonly clusterSecret?: string | undefined;

  /** Initial delay before first reconnection attempt (ms) */
  readonly reconnectBaseDelayMs?: number;

  /** Maximum delay between reconnection attempts (ms) */
  readonly reconnectMaxDelayMs?: number;

  /** Maximum number of reconnection attempts (0 = infinite) */
  readonly maxReconnectAttempts?: number;

  /** Connection timeout in milliseconds */
  readonly connectTimeoutMs?: number;
}

/**
 * Events emitted by Connection.
 */
export interface ConnectionEvents {
  /** Emitted when connection is established */
  connected: [];

  /** Emitted when connection is lost */
  disconnected: [reason: string];

  /** Emitted when a message is received */
  message: [envelope: MessageEnvelope];

  /** Emitted on connection error */
  error: [error: Error];

  /** Emitted when reconnecting */
  reconnecting: [attempt: number, delayMs: number];

  /** Emitted when max reconnect attempts reached */
  reconnectFailed: [];
}

/**
 * Statistics for a connection.
 */
export interface ConnectionStats {
  /** Current connection state */
  readonly state: ConnectionState;

  /** Remote node identifier */
  readonly remoteNodeId: NodeId;

  /** Number of messages sent */
  readonly messagesSent: number;

  /** Number of messages received */
  readonly messagesReceived: number;

  /** Total bytes sent */
  readonly bytesSent: number;

  /** Total bytes received */
  readonly bytesReceived: number;

  /** Timestamp of last successful send */
  readonly lastSentAt: number | null;

  /** Timestamp of last received message */
  readonly lastReceivedAt: number | null;

  /** Number of reconnection attempts */
  readonly reconnectAttempts: number;

  /** Timestamp when connection was established */
  readonly connectedAt: number | null;
}

// =============================================================================
// Connection Class
// =============================================================================

/**
 * Manages a TCP connection to a remote cluster node.
 *
 * Handles low-level socket operations, framing, and reconnection logic.
 * Messages are automatically serialized/deserialized with length-prefix framing.
 *
 * @example
 * ```typescript
 * const connection = new Connection({
 *   remoteNodeId: NodeId.parse('app2@192.168.1.2:4369'),
 *   localNodeId: localNodeId,
 * });
 *
 * connection.on('connected', () => console.log('Connected!'));
 * connection.on('message', (envelope) => handleMessage(envelope));
 *
 * await connection.connect();
 * await connection.send({ type: 'heartbeat', ... });
 * ```
 */
export class Connection extends EventEmitter<ConnectionEvents> {
  private socket: net.Socket | null = null;
  private state: ConnectionState = 'disconnected';
  private receiveBuffer: Buffer = Buffer.alloc(0);

  private readonly config: Required<Omit<ConnectionConfig, 'clusterSecret'>> & {
    clusterSecret: string | undefined;
  };

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  // Statistics
  private messagesSent = 0;
  private messagesReceived = 0;
  private bytesSent = 0;
  private bytesReceived = 0;
  private lastSentAt: number | null = null;
  private lastReceivedAt: number | null = null;
  private connectedAt: number | null = null;

  constructor(config: ConnectionConfig) {
    super();

    this.config = {
      remoteNodeId: config.remoteNodeId,
      localNodeId: config.localNodeId,
      clusterSecret: config.clusterSecret,
      reconnectBaseDelayMs: config.reconnectBaseDelayMs ?? CLUSTER_DEFAULTS.RECONNECT_BASE_DELAY_MS,
      reconnectMaxDelayMs: config.reconnectMaxDelayMs ?? CLUSTER_DEFAULTS.RECONNECT_MAX_DELAY_MS,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 0,
      connectTimeoutMs: config.connectTimeoutMs ?? 10000,
    };
  }

  /**
   * Returns the current connection state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Returns the remote node identifier.
   */
  getRemoteNodeId(): NodeId {
    return this.config.remoteNodeId;
  }

  /**
   * Returns connection statistics.
   */
  getStats(): ConnectionStats {
    return {
      state: this.state,
      remoteNodeId: this.config.remoteNodeId,
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      lastSentAt: this.lastSentAt,
      lastReceivedAt: this.lastReceivedAt,
      reconnectAttempts: this.reconnectAttempts,
      connectedAt: this.connectedAt,
    };
  }

  /**
   * Initiates connection to the remote node.
   *
   * @returns Promise that resolves when connected
   * @throws {NodeNotReachableError} If connection fails
   */
  connect(): Promise<void> {
    if (this.state === 'connected') {
      return Promise.resolve();
    }

    if (this.state === 'connecting') {
      return new Promise((resolve, reject) => {
        const onConnected = () => {
          this.off('error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          this.off('connected', onConnected);
          reject(err);
        };
        this.once('connected', onConnected);
        this.once('error', onError);
      });
    }

    return this.doConnect();
  }

  /**
   * Sends a message to the remote node.
   *
   * @param message - Message to send
   * @throws {NodeNotReachableError} If not connected
   */
  send(message: ClusterMessage): Promise<void> {
    if (this.state !== 'connected' || !this.socket) {
      return Promise.reject(new NodeNotReachableError(this.config.remoteNodeId));
    }

    return new Promise((resolve, reject) => {
      const serializeOptions: SerializeOptions = this.config.clusterSecret
        ? { clusterSecret: this.config.clusterSecret }
        : {};

      try {
        const payload = Serializer.serialize(message, this.config.localNodeId, serializeOptions);
        const framed = Serializer.frame(payload);

        this.socket!.write(framed, (err) => {
          if (err) {
            reject(err);
            return;
          }

          this.messagesSent++;
          this.bytesSent += framed.length;
          this.lastSentAt = Date.now();
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Gracefully closes the connection.
   */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.state === 'disconnected') {
        resolve();
        return;
      }

      this.state = 'closing';
      this.clearTimers();

      if (this.socket) {
        this.socket.end(() => {
          this.cleanup('graceful close');
          resolve();
        });

        // Force destroy after timeout
        setTimeout(() => {
          if (this.socket) {
            this.socket.destroy();
            this.cleanup('close timeout');
          }
          resolve();
        }, 1000);
      } else {
        this.cleanup('no socket');
        resolve();
      }
    });
  }

  /**
   * Destroys the connection immediately without graceful shutdown.
   */
  destroy(): void {
    this.clearTimers();
    if (this.socket) {
      this.socket.destroy();
    }
    this.cleanup('destroyed');
  }

  /**
   * Adopts an existing socket (for incoming connections).
   *
   * @param socket - Pre-connected socket to adopt
   */
  adopt(socket: net.Socket): void {
    if (this.socket) {
      this.socket.destroy();
    }

    this.socket = socket;
    this.setupSocketHandlers();
    this.state = 'connected';
    this.connectedAt = Date.now();
    this.reconnectAttempts = 0;
    this.emit('connected');
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.state = 'connecting';
      let settled = false;

      const host = NodeIdUtils.getHost(this.config.remoteNodeId);
      const port = NodeIdUtils.getPort(this.config.remoteNodeId);

      this.socket = new net.Socket();

      // Connection timeout
      this.connectTimer = setTimeout(() => {
        if (!settled && this.state === 'connecting') {
          settled = true;
          this.socket?.destroy();
          reject(new NodeNotReachableError(this.config.remoteNodeId));
          this.cleanup('connection timeout');
        }
      }, this.config.connectTimeoutMs);

      const cleanup = () => {
        this.socket?.removeListener('connect', onConnect);
        this.socket?.removeListener('error', onError);
      };

      const onConnect = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.clearConnectTimer();
        this.setupSocketHandlers();
        this.state = 'connected';
        this.connectedAt = Date.now();
        this.reconnectAttempts = 0;
        this.emit('connected');
        resolve();
      };

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.clearConnectTimer();
        this.socket?.destroy();
        this.socket = null;
        this.state = 'disconnected';
        reject(new NodeNotReachableError(this.config.remoteNodeId));
      };

      this.socket.once('connect', onConnect);
      this.socket.on('error', onError); // Use 'on' to catch all errors during connect

      this.socket.connect(port, host);
    });
  }

  private setupSocketHandlers(): void {
    if (!this.socket) return;

    this.socket.on('data', (data) => this.handleData(data));
    this.socket.on('close', () => this.handleDisconnect('socket closed'));
    this.socket.on('error', (err) => this.handleError(err));
    this.socket.on('timeout', () => this.handleDisconnect('socket timeout'));

    // Enable keep-alive
    this.socket.setKeepAlive(true, 30000);
  }

  private handleData(data: Buffer): void {
    this.bytesReceived += data.length;
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

    // Process all complete messages in buffer
    let offset = 0;
    while (offset < this.receiveBuffer.length) {
      const result = Serializer.unframe(this.receiveBuffer, offset);

      if (result.payload === null) {
        // Incomplete message, wait for more data
        break;
      }

      offset += result.bytesConsumed;

      try {
        const deserializeOptions: DeserializeOptions = this.config.clusterSecret
          ? { clusterSecret: this.config.clusterSecret }
          : {};

        const envelope = Serializer.deserialize(result.payload, deserializeOptions);
        this.messagesReceived++;
        this.lastReceivedAt = Date.now();
        this.emit('message', envelope);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Keep remaining incomplete data in buffer
    if (offset > 0) {
      this.receiveBuffer = this.receiveBuffer.subarray(offset);
    }
  }

  private handleDisconnect(reason: string): void {
    if (this.state === 'disconnected' || this.state === 'closing') {
      return;
    }

    const wasConnected = this.state === 'connected';
    this.cleanup(reason);

    if (wasConnected) {
      this.emit('disconnected', reason);
      this.scheduleReconnect();
    }
  }

  private handleError(err: Error): void {
    this.emit('error', err);

    // Don't trigger reconnect here - let the 'close' event handle it
    // This prevents double reconnect attempts
  }

  private scheduleReconnect(): void {
    // Check if reconnection is allowed
    if (
      this.config.maxReconnectAttempts > 0 &&
      this.reconnectAttempts >= this.config.maxReconnectAttempts
    ) {
      this.emit('reconnectFailed');
      return;
    }

    // Calculate delay with exponential backoff and jitter
    const exponentialDelay = Math.min(
      this.config.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts),
      this.config.reconnectMaxDelayMs,
    );

    // Add jitter (0.5 - 1.5x of calculated delay)
    const jitter = 0.5 + Math.random();
    const delay = Math.floor(exponentialDelay * jitter);

    this.reconnectAttempts++;
    this.emit('reconnecting', this.reconnectAttempts, delay);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect().catch(() => {
        // Connection failed, schedule another reconnect attempt
        this.scheduleReconnect();
      });
    }, delay);
  }

  private cleanup(reason: string): void {
    this.clearTimers();

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    this.receiveBuffer = Buffer.alloc(0);
    this.state = 'disconnected';
    this.connectedAt = null;
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    this.clearReconnectTimer();
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
