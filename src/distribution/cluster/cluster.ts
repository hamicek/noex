/**
 * Main Cluster singleton for distributed noex.
 *
 * Provides the primary API for cluster communication, managing:
 * - Node lifecycle (start, stop)
 * - Seed-based discovery
 * - Heartbeat broadcasting
 * - Gossip protocol for membership
 *
 * @module distribution/cluster/cluster
 */

import { EventEmitter } from 'node:events';

import type {
  NodeId,
  NodeInfo,
  ClusterConfig,
  ClusterStatus,
  NodeDownReason,
  HeartbeatMessage,
  NodeDownMessage,
  MessageEnvelope,
  NodeUpHandler,
  NodeDownHandler,
  ClusterStatusHandler,
} from '../types.js';
import {
  CLUSTER_DEFAULTS,
  ClusterNotStartedError,
  InvalidClusterConfigError,
} from '../types.js';
import { NodeId as NodeIdUtils } from '../node-id.js';
import { Transport } from '../transport/index.js';
import { Membership } from './membership.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Events emitted by Cluster.
 */
export interface ClusterEvents {
  /** Emitted when a node joins the cluster */
  nodeUp: [node: NodeInfo];

  /** Emitted when a node leaves the cluster */
  nodeDown: [nodeId: NodeId, reason: NodeDownReason];

  /** Emitted when cluster status changes */
  statusChange: [status: ClusterStatus];

  /** Emitted on cluster error */
  error: [error: Error];
}

/**
 * Internal state for the cluster.
 */
interface ClusterState {
  /** Current cluster status */
  status: ClusterStatus;

  /** Local node identifier */
  localNodeId: NodeId | null;

  /** Cluster configuration */
  config: ResolvedClusterConfig | null;

  /** Transport layer */
  transport: Transport | null;

  /** Membership manager */
  membership: Membership | null;

  /** Heartbeat timer */
  heartbeatTimer: ReturnType<typeof setInterval> | null;

  /** Timestamp when cluster started */
  startedAt: number | null;
}

/**
 * Resolved cluster configuration with all defaults applied.
 */
interface ResolvedClusterConfig {
  readonly nodeName: string;
  readonly host: string;
  readonly port: number;
  readonly seeds: readonly string[];
  readonly clusterSecret: string | undefined;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatMissThreshold: number;
  readonly reconnectBaseDelayMs: number;
  readonly reconnectMaxDelayMs: number;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validates cluster configuration.
 *
 * @param config - Configuration to validate
 * @throws {InvalidClusterConfigError} If configuration is invalid
 */
function validateConfig(config: ClusterConfig): void {
  if (!config.nodeName || typeof config.nodeName !== 'string') {
    throw new InvalidClusterConfigError('nodeName is required and must be a string');
  }

  // Validate nodeName format (same rules as NodeId name)
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(config.nodeName)) {
    throw new InvalidClusterConfigError(
      'nodeName must start with a letter and contain only alphanumeric characters, underscores, or hyphens',
    );
  }

  if (config.nodeName.length > 64) {
    throw new InvalidClusterConfigError('nodeName exceeds maximum length of 64 characters');
  }

  if (config.port !== undefined) {
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new InvalidClusterConfigError('port must be an integer between 1 and 65535');
    }
  }

  if (config.seeds !== undefined) {
    if (!Array.isArray(config.seeds)) {
      throw new InvalidClusterConfigError('seeds must be an array');
    }

    for (const seed of config.seeds) {
      if (!NodeIdUtils.isValid(seed)) {
        throw new InvalidClusterConfigError(`invalid seed node: ${seed}`);
      }
    }
  }

  if (config.heartbeatIntervalMs !== undefined) {
    if (!Number.isInteger(config.heartbeatIntervalMs) || config.heartbeatIntervalMs < 100) {
      throw new InvalidClusterConfigError('heartbeatIntervalMs must be an integer >= 100');
    }
  }

  if (config.heartbeatMissThreshold !== undefined) {
    if (!Number.isInteger(config.heartbeatMissThreshold) || config.heartbeatMissThreshold < 1) {
      throw new InvalidClusterConfigError('heartbeatMissThreshold must be an integer >= 1');
    }
  }
}

/**
 * Resolves configuration with defaults.
 *
 * @param config - User-provided configuration
 * @param host - Resolved host address
 * @returns Resolved configuration
 */
function resolveConfig(config: ClusterConfig, host: string): ResolvedClusterConfig {
  return {
    nodeName: config.nodeName,
    host,
    port: config.port ?? CLUSTER_DEFAULTS.PORT,
    seeds: config.seeds ?? [],
    clusterSecret: config.clusterSecret,
    heartbeatIntervalMs: config.heartbeatIntervalMs ?? CLUSTER_DEFAULTS.HEARTBEAT_INTERVAL_MS,
    heartbeatMissThreshold:
      config.heartbeatMissThreshold ?? CLUSTER_DEFAULTS.HEARTBEAT_MISS_THRESHOLD,
    reconnectBaseDelayMs:
      config.reconnectBaseDelayMs ?? CLUSTER_DEFAULTS.RECONNECT_BASE_DELAY_MS,
    reconnectMaxDelayMs: config.reconnectMaxDelayMs ?? CLUSTER_DEFAULTS.RECONNECT_MAX_DELAY_MS,
  };
}

// =============================================================================
// Cluster Class
// =============================================================================

/**
 * Main Cluster singleton for distributed communication.
 *
 * The Cluster class manages the entire lifecycle of a node in a P2P cluster.
 * It coordinates the transport layer, membership tracking, heartbeat broadcasting,
 * and seed-based discovery.
 *
 * @example
 * ```typescript
 * import { Cluster } from 'noex/distribution';
 *
 * // Start the cluster
 * await Cluster.start({
 *   nodeName: 'app1',
 *   port: 4369,
 *   seeds: ['app2@192.168.1.2:4369'],
 * });
 *
 * // Register event handlers
 * Cluster.onNodeUp((node) => {
 *   console.log(`Node joined: ${node.id}`);
 * });
 *
 * Cluster.onNodeDown((nodeId, reason) => {
 *   console.log(`Node left: ${nodeId}, reason: ${reason}`);
 * });
 *
 * // Get cluster information
 * const nodes = Cluster.getNodes();
 * const localId = Cluster.getLocalNodeId();
 *
 * // Stop the cluster
 * await Cluster.stop();
 * ```
 */
class ClusterImpl extends EventEmitter<ClusterEvents> {
  private state: ClusterState = {
    status: 'stopped',
    localNodeId: null,
    config: null,
    transport: null,
    membership: null,
    heartbeatTimer: null,
    startedAt: null,
  };

  /**
   * Starts the cluster node.
   *
   * Initializes transport layer, membership tracking, and begins
   * connecting to seed nodes.
   *
   * @param config - Cluster configuration
   * @throws {InvalidClusterConfigError} If configuration is invalid
   * @throws {Error} If cluster is already running
   */
  async start(config: ClusterConfig): Promise<void> {
    if (this.state.status === 'running') {
      throw new Error('Cluster is already running');
    }

    if (this.state.status !== 'stopped') {
      throw new Error(`Cannot start cluster in ${this.state.status} state`);
    }

    validateConfig(config);

    this.setStatus('starting');

    try {
      const host = config.host ?? CLUSTER_DEFAULTS.HOST;
      const resolvedConfig = resolveConfig(config, host);
      const localNodeId = NodeIdUtils.create(
        resolvedConfig.nodeName,
        host === '0.0.0.0' ? '127.0.0.1' : host,
        resolvedConfig.port,
      );

      // Initialize transport
      const transport = new Transport({
        localNodeId,
        host: resolvedConfig.host,
        port: resolvedConfig.port,
        clusterSecret: resolvedConfig.clusterSecret,
        reconnectBaseDelayMs: resolvedConfig.reconnectBaseDelayMs,
        reconnectMaxDelayMs: resolvedConfig.reconnectMaxDelayMs,
      });

      // Initialize membership
      const membership = new Membership({
        localNodeId,
        heartbeatIntervalMs: resolvedConfig.heartbeatIntervalMs,
        heartbeatMissThreshold: resolvedConfig.heartbeatMissThreshold,
      });

      // Set up event forwarding
      this.setupEventHandlers(transport, membership);

      // Store state
      this.state.config = resolvedConfig;
      this.state.localNodeId = localNodeId;
      this.state.transport = transport;
      this.state.membership = membership;
      this.state.startedAt = Date.now();

      // Start transport
      await transport.start();

      // Start heartbeat broadcasting
      this.startHeartbeat();

      // Connect to seed nodes
      await this.connectToSeeds();

      this.setStatus('running');
    } catch (error) {
      // Cleanup on failure
      await this.cleanup();
      this.setStatus('stopped');
      throw error;
    }
  }

  /**
   * Stops the cluster node.
   *
   * Stops heartbeat, disconnects from all nodes, and cleans up resources.
   */
  async stop(): Promise<void> {
    if (this.state.status === 'stopped') {
      return;
    }

    if (this.state.status === 'stopping') {
      return new Promise((resolve) => {
        this.once('statusChange', (status) => {
          if (status === 'stopped') resolve();
        });
      });
    }

    this.setStatus('stopping');

    // Broadcast node_down to other nodes
    await this.broadcastNodeDown('graceful_shutdown');

    await this.cleanup();

    this.setStatus('stopped');
  }

  /**
   * Returns the current cluster status.
   */
  getStatus(): ClusterStatus {
    return this.state.status;
  }

  /**
   * Returns the local node identifier.
   *
   * @throws {ClusterNotStartedError} If cluster is not running
   */
  getLocalNodeId(): NodeId {
    this.ensureRunning();
    return this.state.localNodeId!;
  }

  /**
   * Returns information about all known nodes in the cluster.
   *
   * @throws {ClusterNotStartedError} If cluster is not running
   */
  getNodes(): readonly NodeInfo[] {
    this.ensureRunning();
    return this.state.membership!.getNodes();
  }

  /**
   * Returns information about connected nodes only.
   *
   * @throws {ClusterNotStartedError} If cluster is not running
   */
  getConnectedNodes(): readonly NodeInfo[] {
    this.ensureRunning();
    return this.state.membership!.getConnectedNodes();
  }

  /**
   * Returns the node identifiers of all known nodes.
   *
   * @throws {ClusterNotStartedError} If cluster is not running
   */
  getNodeIds(): readonly NodeId[] {
    this.ensureRunning();
    return this.state.membership!.getNodeIds();
  }

  /**
   * Returns information about a specific node.
   *
   * @param nodeId - Node identifier to look up
   * @throws {ClusterNotStartedError} If cluster is not running
   */
  getNode(nodeId: NodeId): NodeInfo | undefined {
    this.ensureRunning();
    return this.state.membership!.getNode(nodeId);
  }

  /**
   * Checks if a node is currently connected.
   *
   * @param nodeId - Node identifier to check
   * @throws {ClusterNotStartedError} If cluster is not running
   */
  isNodeConnected(nodeId: NodeId): boolean {
    this.ensureRunning();
    return this.state.membership!.isNodeConnected(nodeId);
  }

  /**
   * Returns the number of connected nodes.
   *
   * @throws {ClusterNotStartedError} If cluster is not running
   */
  getConnectedNodeCount(): number {
    this.ensureRunning();
    return this.state.membership!.connectedCount;
  }

  /**
   * Returns information about the local node.
   *
   * @throws {ClusterNotStartedError} If cluster is not running
   */
  getLocalNodeInfo(): NodeInfo {
    this.ensureRunning();
    return this.createLocalNodeInfo();
  }

  /**
   * Returns the cluster uptime in milliseconds.
   *
   * @throws {ClusterNotStartedError} If cluster is not running
   */
  getUptimeMs(): number {
    this.ensureRunning();
    return Date.now() - this.state.startedAt!;
  }

  /**
   * Registers a handler for node join events.
   *
   * @param handler - Handler function
   * @returns Function to unregister the handler
   */
  onNodeUp(handler: NodeUpHandler): () => void {
    this.on('nodeUp', handler);
    return () => this.off('nodeUp', handler);
  }

  /**
   * Registers a handler for node leave events.
   *
   * @param handler - Handler function
   * @returns Function to unregister the handler
   */
  onNodeDown(handler: NodeDownHandler): () => void {
    this.on('nodeDown', handler);
    return () => this.off('nodeDown', handler);
  }

  /**
   * Registers a handler for cluster status changes.
   *
   * @param handler - Handler function
   * @returns Function to unregister the handler
   */
  onStatusChange(handler: ClusterStatusHandler): () => void {
    this.on('statusChange', handler);
    return () => this.off('statusChange', handler);
  }

  // ===========================================================================
  // Internal Methods
  // ===========================================================================

  /**
   * Returns the internal transport for use by other distribution modules.
   *
   * @internal
   */
  _getTransport(): Transport {
    this.ensureRunning();
    return this.state.transport!;
  }

  /**
   * Returns the internal membership for use by other distribution modules.
   *
   * @internal
   */
  _getMembership(): Membership {
    this.ensureRunning();
    return this.state.membership!;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private ensureRunning(): void {
    if (this.state.status !== 'running') {
      throw new ClusterNotStartedError();
    }
  }

  private setStatus(status: ClusterStatus): void {
    if (this.state.status !== status) {
      this.state.status = status;
      this.emit('statusChange', status);
    }
  }

  private setupEventHandlers(transport: Transport, membership: Membership): void {
    // Forward membership events
    membership.on('nodeUp', (node) => {
      this.emit('nodeUp', node);
    });

    membership.on('nodeDown', (nodeId, reason) => {
      this.emit('nodeDown', nodeId, reason);
    });

    // Handle transport events
    transport.on('connectionEstablished', (nodeId) => {
      // Connection established - wait for heartbeat to confirm membership
    });

    transport.on('connectionLost', (nodeId, reason) => {
      // Mark node as down due to connection loss
      membership.markNodeDown(nodeId, 'connection_closed');
    });

    transport.on('message', (envelope, fromNodeId) => {
      this.handleMessage(envelope, fromNodeId);
    });

    transport.on('error', (error) => {
      this.emit('error', error);
    });
  }

  private handleMessage(envelope: MessageEnvelope, fromNodeId: NodeId): void {
    const { payload } = envelope;

    switch (payload.type) {
      case 'heartbeat':
        this.handleHeartbeat(payload, fromNodeId);
        break;

      case 'node_down':
        this.handleNodeDown(payload);
        break;

      // Other message types will be handled by remote call module
      default:
        // Forward to message handlers when implemented
        break;
    }
  }

  private handleHeartbeat(message: HeartbeatMessage, fromNodeId: NodeId): void {
    const { membership, transport } = this.state;
    if (!membership || !transport) return;

    // Update node info from heartbeat
    membership.updateNode(message.nodeInfo);

    // Gossip: learn about other nodes
    for (const knownNodeId of message.knownNodes) {
      if (
        knownNodeId !== this.state.localNodeId &&
        !membership.hasNode(knownNodeId) &&
        !transport.isConnectedTo(knownNodeId)
      ) {
        // Try to connect to newly discovered node
        this.connectToNode(knownNodeId).catch((err) => {
          // Connection failed - ignore, will retry via future heartbeats
        });
      }
    }
  }

  private handleNodeDown(message: NodeDownMessage): void {
    const { membership } = this.state;
    if (!membership) return;

    membership.markNodeDown(message.nodeId, message.reason);
  }

  private createLocalNodeInfo(): NodeInfo {
    return {
      id: this.state.localNodeId!,
      host: this.state.config!.host === '0.0.0.0' ? '127.0.0.1' : this.state.config!.host,
      port: this.state.config!.port,
      status: 'connected',
      processCount: 0, // Will be populated by GenServer module
      lastHeartbeatAt: Date.now(),
      uptimeMs: this.getUptimeMs(),
    };
  }

  private createHeartbeatMessage(): HeartbeatMessage {
    const membership = this.state.membership!;

    return {
      type: 'heartbeat',
      nodeInfo: this.createLocalNodeInfo(),
      knownNodes: membership.getNodeIds(),
    };
  }

  private startHeartbeat(): void {
    const { config } = this.state;
    if (!config) return;

    this.state.heartbeatTimer = setInterval(() => {
      this.broadcastHeartbeat().catch((err) => {
        this.emit('error', err);
      });
    }, config.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.state.heartbeatTimer) {
      clearInterval(this.state.heartbeatTimer);
      this.state.heartbeatTimer = null;
    }
  }

  private async broadcastHeartbeat(): Promise<void> {
    const { transport } = this.state;
    if (!transport || transport.getState() !== 'running') return;

    const message = this.createHeartbeatMessage();
    await transport.broadcast(message);
  }

  private async broadcastNodeDown(reason: NodeDownReason): Promise<void> {
    const { transport, localNodeId } = this.state;
    if (!transport || !localNodeId || transport.getState() !== 'running') return;

    const message: NodeDownMessage = {
      type: 'node_down',
      nodeId: localNodeId,
      detectedAt: Date.now(),
      reason,
    };

    try {
      await transport.broadcast(message);
    } catch {
      // Ignore broadcast errors during shutdown
    }
  }

  private async connectToSeeds(): Promise<void> {
    const { config, transport, localNodeId } = this.state;
    if (!config || !transport || !localNodeId) return;

    const connectionPromises: Promise<void>[] = [];

    for (const seedStr of config.seeds) {
      const seedNodeId = NodeIdUtils.parse(seedStr);

      // Don't connect to self
      if (seedNodeId === localNodeId) {
        continue;
      }

      connectionPromises.push(this.connectToNode(seedNodeId));
    }

    // Connect to all seeds in parallel, don't fail if some are unreachable
    await Promise.allSettled(connectionPromises);
    // Seed connection failures are normal if seeds are not yet running
  }

  private async connectToNode(nodeId: NodeId): Promise<void> {
    const { transport } = this.state;
    if (!transport) return;

    try {
      await transport.connectTo(nodeId);

      // Send initial heartbeat immediately after connection
      const message = this.createHeartbeatMessage();
      await transport.send(nodeId, message);
    } catch (error) {
      throw error;
    }
  }

  private async cleanup(): Promise<void> {
    this.stopHeartbeat();

    if (this.state.membership) {
      this.state.membership.clear();
      this.state.membership.removeAllListeners();
      this.state.membership = null;
    }

    if (this.state.transport) {
      await this.state.transport.stop();
      this.state.transport.removeAllListeners();
      this.state.transport = null;
    }

    this.state.localNodeId = null;
    this.state.config = null;
    this.state.startedAt = null;
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

/**
 * Global Cluster singleton instance.
 *
 * Provides the primary API for cluster communication.
 */
export const Cluster = new ClusterImpl();
