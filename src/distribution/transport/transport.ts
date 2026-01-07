/**
 * Transport layer manager for cluster communication.
 *
 * Manages TCP connections to all cluster nodes, handling:
 * - Incoming connection acceptance
 * - Outgoing connection establishment
 * - Message routing to appropriate connections
 * - Connection lifecycle management
 *
 * @module distribution/transport/transport
 */

import * as net from 'node:net';
import { EventEmitter } from 'node:events';

import type { NodeId, MessageEnvelope, ClusterMessage, ClusterConfig } from '../types.js';
import { CLUSTER_DEFAULTS, ClusterNotStartedError, InvalidClusterConfigError } from '../types.js';
import { NodeId as NodeIdUtils } from '../node-id.js';
import { Serializer } from '../serialization.js';
import { Connection, type ConnectionState, type ConnectionStats } from './connection.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Transport layer state.
 */
export type TransportState = 'stopped' | 'starting' | 'running' | 'stopping';

/**
 * Configuration for the transport layer.
 */
export interface TransportConfig {
  /** Local node identifier */
  readonly localNodeId: NodeId;

  /** Host to bind the listener to */
  readonly host?: string;

  /** Port to listen on */
  readonly port?: number;

  /** Cluster secret for HMAC authentication */
  readonly clusterSecret?: string | undefined;

  /** Initial delay before first reconnection attempt (ms) */
  readonly reconnectBaseDelayMs?: number;

  /** Maximum delay between reconnection attempts (ms) */
  readonly reconnectMaxDelayMs?: number;

  /** Connection timeout in milliseconds */
  readonly connectTimeoutMs?: number;
}

/**
 * Events emitted by Transport.
 */
export interface TransportEvents {
  /** Emitted when transport is started and listening */
  started: [port: number];

  /** Emitted when transport is stopped */
  stopped: [];

  /** Emitted when a new connection is established (inbound or outbound) */
  connectionEstablished: [nodeId: NodeId];

  /** Emitted when a connection is lost */
  connectionLost: [nodeId: NodeId, reason: string];

  /** Emitted when a message is received */
  message: [envelope: MessageEnvelope, fromNodeId: NodeId];

  /** Emitted on transport error */
  error: [error: Error];
}

/**
 * Statistics for the transport layer.
 */
export interface TransportStats {
  /** Current transport state */
  readonly state: TransportState;

  /** Local node identifier */
  readonly localNodeId: NodeId;

  /** Port listening on */
  readonly listeningPort: number | null;

  /** Number of active connections */
  readonly activeConnections: number;

  /** Total messages sent across all connections */
  readonly totalMessagesSent: number;

  /** Total messages received across all connections */
  readonly totalMessagesReceived: number;

  /** Per-connection statistics */
  readonly connections: ReadonlyMap<NodeId, ConnectionStats>;
}

// =============================================================================
// Transport Class
// =============================================================================

/**
 * Transport layer singleton for managing cluster connections.
 *
 * Provides a high-level interface for cluster communication, abstracting
 * away individual connection management, reconnection logic, and message routing.
 *
 * @example
 * ```typescript
 * const transport = new Transport({
 *   localNodeId: NodeId.parse('app1@192.168.1.1:4369'),
 *   host: '0.0.0.0',
 *   port: 4369,
 * });
 *
 * transport.on('message', (envelope, fromNodeId) => {
 *   console.log(`Received from ${fromNodeId}:`, envelope.payload);
 * });
 *
 * await transport.start();
 * await transport.connectTo(NodeId.parse('app2@192.168.1.2:4369'));
 * await transport.send(remoteNodeId, message);
 * ```
 */
export class Transport extends EventEmitter<TransportEvents> {
  private state: TransportState = 'stopped';
  private server: net.Server | null = null;
  private readonly connections = new Map<NodeId, Connection>();
  private readonly pendingConnections = new Set<NodeId>();

  private readonly config: Required<Omit<TransportConfig, 'clusterSecret'>> & {
    clusterSecret: string | undefined;
  };

  // Statistics
  private totalMessagesSent = 0;
  private totalMessagesReceived = 0;
  private listeningPort: number | null = null;

  constructor(config: TransportConfig) {
    super();

    if (!config.localNodeId) {
      throw new InvalidClusterConfigError('localNodeId is required');
    }

    this.config = {
      localNodeId: config.localNodeId,
      host: config.host ?? CLUSTER_DEFAULTS.HOST,
      port: config.port ?? NodeIdUtils.getPort(config.localNodeId),
      clusterSecret: config.clusterSecret,
      reconnectBaseDelayMs: config.reconnectBaseDelayMs ?? CLUSTER_DEFAULTS.RECONNECT_BASE_DELAY_MS,
      reconnectMaxDelayMs: config.reconnectMaxDelayMs ?? CLUSTER_DEFAULTS.RECONNECT_MAX_DELAY_MS,
      connectTimeoutMs: config.connectTimeoutMs ?? 10000,
    };
  }

  /**
   * Returns the current transport state.
   */
  getState(): TransportState {
    return this.state;
  }

  /**
   * Returns the local node identifier.
   */
  getLocalNodeId(): NodeId {
    return this.config.localNodeId;
  }

  /**
   * Returns the port the transport is listening on.
   */
  getListeningPort(): number | null {
    return this.listeningPort;
  }

  /**
   * Returns transport statistics.
   */
  getStats(): TransportStats {
    const connectionStats = new Map<NodeId, ConnectionStats>();
    for (const [nodeId, connection] of this.connections) {
      connectionStats.set(nodeId, connection.getStats());
    }

    return {
      state: this.state,
      localNodeId: this.config.localNodeId,
      listeningPort: this.listeningPort,
      activeConnections: this.connections.size,
      totalMessagesSent: this.totalMessagesSent,
      totalMessagesReceived: this.totalMessagesReceived,
      connections: connectionStats,
    };
  }

  /**
   * Returns list of connected node IDs.
   */
  getConnectedNodes(): readonly NodeId[] {
    return Array.from(this.connections.keys()).filter(
      (nodeId) => this.connections.get(nodeId)?.getState() === 'connected',
    );
  }

  /**
   * Checks if connected to a specific node.
   */
  isConnectedTo(nodeId: NodeId): boolean {
    const connection = this.connections.get(nodeId);
    return connection?.getState() === 'connected';
  }

  /**
   * Starts the transport layer.
   *
   * Begins listening for incoming connections on the configured port.
   *
   * @returns Promise that resolves when listening
   * @throws {InvalidClusterConfigError} If configuration is invalid
   */
  start(): Promise<void> {
    if (this.state === 'running') {
      return Promise.resolve();
    }

    if (this.state !== 'stopped') {
      return Promise.reject(new Error(`Cannot start transport in ${this.state} state`));
    }

    return new Promise((resolve, reject) => {
      this.state = 'starting';

      this.server = net.createServer((socket) => this.handleIncomingConnection(socket));

      this.server.on('error', (err) => {
        if (this.state === 'starting') {
          this.state = 'stopped';
          reject(err);
        } else {
          this.emit('error', err);
        }
      });

      this.server.listen(this.config.port, this.config.host, () => {
        const address = this.server!.address();
        this.listeningPort = typeof address === 'object' && address ? address.port : this.config.port;
        this.state = 'running';
        this.emit('started', this.listeningPort);
        resolve();
      });
    });
  }

  /**
   * Stops the transport layer.
   *
   * Closes all connections and stops listening for new ones.
   */
  stop(): Promise<void> {
    if (this.state === 'stopped') {
      return Promise.resolve();
    }

    if (this.state === 'stopping') {
      return new Promise((resolve) => {
        this.once('stopped', () => resolve());
      });
    }

    return new Promise((resolve) => {
      this.state = 'stopping';

      // Close all connections
      const closePromises: Promise<void>[] = [];
      for (const connection of this.connections.values()) {
        closePromises.push(connection.close());
      }

      // Close server
      if (this.server) {
        this.server.close();
        this.server = null;
      }

      Promise.all(closePromises).finally(() => {
        this.connections.clear();
        this.pendingConnections.clear();
        this.listeningPort = null;
        this.state = 'stopped';
        this.emit('stopped');
        resolve();
      });
    });
  }

  /**
   * Establishes a connection to a remote node.
   *
   * If a connection already exists, returns immediately.
   * If connection is already in progress, waits for it.
   *
   * @param nodeId - Target node identifier
   * @returns Promise that resolves when connected
   */
  async connectTo(nodeId: NodeId): Promise<void> {
    this.ensureRunning();

    // Don't connect to self
    if (nodeId === this.config.localNodeId) {
      return;
    }

    // Already connected
    const existing = this.connections.get(nodeId);
    if (existing?.getState() === 'connected') {
      return;
    }

    // Connection in progress
    if (this.pendingConnections.has(nodeId)) {
      return new Promise((resolve, reject) => {
        const onEstablished = (establishedNodeId: NodeId) => {
          if (establishedNodeId === nodeId) {
            this.off('connectionEstablished', onEstablished);
            this.off('connectionLost', onLost);
            resolve();
          }
        };
        const onLost = (lostNodeId: NodeId, reason: string) => {
          if (lostNodeId === nodeId) {
            this.off('connectionEstablished', onEstablished);
            this.off('connectionLost', onLost);
            reject(new Error(`Connection to ${nodeId} failed: ${reason}`));
          }
        };
        this.on('connectionEstablished', onEstablished);
        this.on('connectionLost', onLost);
      });
    }

    this.pendingConnections.add(nodeId);

    try {
      const connection = this.createConnection(nodeId);
      await connection.connect();
      this.connections.set(nodeId, connection);
      this.emit('connectionEstablished', nodeId);
    } finally {
      this.pendingConnections.delete(nodeId);
    }
  }

  /**
   * Disconnects from a remote node.
   *
   * @param nodeId - Target node identifier
   */
  async disconnectFrom(nodeId: NodeId): Promise<void> {
    const connection = this.connections.get(nodeId);
    if (connection) {
      await connection.close();
      this.connections.delete(nodeId);
    }
  }

  /**
   * Sends a message to a remote node.
   *
   * @param nodeId - Target node identifier
   * @param message - Message to send
   * @throws {ClusterNotStartedError} If transport not running
   * @throws {NodeNotReachableError} If not connected to the node
   */
  async send(nodeId: NodeId, message: ClusterMessage): Promise<void> {
    this.ensureRunning();

    const connection = this.connections.get(nodeId);
    if (!connection || connection.getState() !== 'connected') {
      throw new Error(`Not connected to node ${nodeId}`);
    }

    await connection.send(message);
    this.totalMessagesSent++;
  }

  /**
   * Broadcasts a message to all connected nodes.
   *
   * @param message - Message to broadcast
   * @returns Number of nodes the message was sent to
   */
  async broadcast(message: ClusterMessage): Promise<number> {
    this.ensureRunning();

    let sentCount = 0;
    const sendPromises: Promise<void>[] = [];

    for (const [nodeId, connection] of this.connections) {
      if (connection.getState() === 'connected') {
        sendPromises.push(
          connection.send(message).then(() => {
            sentCount++;
            this.totalMessagesSent++;
          }).catch((err) => {
            this.emit('error', err);
          }),
        );
      }
    }

    await Promise.all(sendPromises);
    return sentCount;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private ensureRunning(): void {
    if (this.state !== 'running') {
      throw new ClusterNotStartedError();
    }
  }

  private createConnection(nodeId: NodeId): Connection {
    const connection = new Connection({
      remoteNodeId: nodeId,
      localNodeId: this.config.localNodeId,
      clusterSecret: this.config.clusterSecret,
      reconnectBaseDelayMs: this.config.reconnectBaseDelayMs,
      reconnectMaxDelayMs: this.config.reconnectMaxDelayMs,
      connectTimeoutMs: this.config.connectTimeoutMs,
    });

    this.setupConnectionHandlers(connection, nodeId);
    return connection;
  }

  private setupConnectionHandlers(connection: Connection, nodeId: NodeId): void {
    connection.on('message', (envelope) => {
      this.totalMessagesReceived++;
      this.emit('message', envelope, nodeId);
    });

    connection.on('disconnected', (reason) => {
      this.emit('connectionLost', nodeId, reason);
    });

    connection.on('connected', () => {
      this.emit('connectionEstablished', nodeId);
    });

    connection.on('error', (err) => {
      this.emit('error', err);
    });

    connection.on('reconnectFailed', () => {
      this.connections.delete(nodeId);
      this.emit('connectionLost', nodeId, 'max reconnect attempts reached');
    });
  }

  private handleIncomingConnection(socket: net.Socket): void {
    // For incoming connections, we need to receive the first message
    // to identify the remote node. Use a temporary buffer.
    let receiveBuffer = Buffer.alloc(0);
    let identified = false;

    const onData = (data: Buffer) => {
      if (identified) return;

      receiveBuffer = Buffer.concat([receiveBuffer, data]);

      const result = Serializer.unframe(receiveBuffer, 0);
      if (result.payload === null) {
        // Need more data
        return;
      }

      identified = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);

      try {
        const envelope = Serializer.deserialize(result.payload, {
          clusterSecret: this.config.clusterSecret,
        });

        const remoteNodeId = envelope.from;

        // Check if we already have a connection to this node
        const existing = this.connections.get(remoteNodeId);
        if (existing && existing.getState() === 'connected') {
          // Already connected - close the new socket
          socket.destroy();
          return;
        }

        // Create a new connection and adopt the socket
        const connection = new Connection({
          remoteNodeId,
          localNodeId: this.config.localNodeId,
          clusterSecret: this.config.clusterSecret,
          reconnectBaseDelayMs: this.config.reconnectBaseDelayMs,
          reconnectMaxDelayMs: this.config.reconnectMaxDelayMs,
          connectTimeoutMs: this.config.connectTimeoutMs,
        });

        this.setupConnectionHandlers(connection, remoteNodeId);
        connection.adopt(socket);
        this.connections.set(remoteNodeId, connection);

        // Process the first message
        this.totalMessagesReceived++;
        this.emit('message', envelope, remoteNodeId);
        this.emit('connectionEstablished', remoteNodeId);

        // Process remaining data in buffer
        if (result.bytesConsumed < receiveBuffer.length) {
          const remaining = receiveBuffer.subarray(result.bytesConsumed);
          // Re-emit remaining data to the connection
          socket.emit('data', remaining);
        }
      } catch (err) {
        socket.destroy();
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    };

    const onError = (err: Error) => {
      if (!identified) {
        socket.destroy();
      }
    };

    const onClose = () => {
      // Socket closed before identification
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);

    // Timeout for identification
    const identifyTimeout = setTimeout(() => {
      if (!identified) {
        socket.destroy();
      }
    }, 10000);

    socket.once('close', () => clearTimeout(identifyTimeout));
  }
}
