/**
 * Multi-node cluster management for distributed stress testing.
 *
 * Since Cluster is a singleton, multi-node testing requires running
 * each node in a separate process. This factory manages the lifecycle
 * of test clusters with IPC-based coordination.
 *
 * @module tests/stress/distribution/cluster-factory
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for a test cluster.
 */
export interface TestClusterConfig {
  /** Number of nodes in the cluster. */
  readonly nodeCount: number;
  /** Base port number - nodes will use basePort, basePort+1, etc. */
  readonly basePort: number;
  /** Optional prefix for node names. Default: 'node'. */
  readonly nodeNamePrefix?: string;
  /** Heartbeat interval in ms. Default: 500. */
  readonly heartbeatIntervalMs?: number;
  /** Heartbeat miss threshold. Default: 2. */
  readonly heartbeatMissThreshold?: number;
  /** Cluster secret for authentication. */
  readonly clusterSecret?: string;
}

/**
 * Status of a test node.
 */
export type TestNodeStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';

/**
 * Information about a test node.
 */
export interface TestNodeInfo {
  /** Node identifier string (e.g., 'node1@127.0.0.1:4369'). */
  readonly nodeId: string;
  /** Node name (e.g., 'node1'). */
  readonly name: string;
  /** Port number. */
  readonly port: number;
  /** Current status. */
  readonly status: TestNodeStatus;
  /** Connected node IDs. */
  readonly connectedNodes: readonly string[];
  /** Timestamp when node was started. */
  readonly startedAt: number | null;
  /** Process ID of the child process. */
  readonly pid: number | null;
}

/**
 * Message types for IPC communication.
 */
export type NodeIPCMessage =
  | { type: 'start'; config: NodeStartConfig }
  | { type: 'stop' }
  | { type: 'get_status' }
  | { type: 'get_connected_nodes' }
  | { type: 'crash'; mode: CrashMode }
  | { type: 'register_behavior'; behaviorName: string }
  | { type: 'spawn_process'; behaviorName: string; globalName?: string }
  | { type: 'remote_call'; callId: string; targetNodeId: string; processId: string; msg: unknown; timeoutMs?: number }
  | { type: 'remote_cast'; targetNodeId: string; processId: string; msg: unknown }
  | { type: 'get_process_info'; processId: string }
  | { type: 'remote_spawn'; spawnId: string; behaviorName: string; targetNodeId: string; options?: RemoteSpawnIPCOptions; timeoutMs?: number };

/**
 * Response types from child process.
 */
export type NodeIPCResponse =
  | { type: 'ready'; nodeId: string }
  | { type: 'started' }
  | { type: 'stopped' }
  | { type: 'status'; info: TestNodeInfo }
  | { type: 'connected_nodes'; nodes: string[] }
  | { type: 'crashed'; mode: CrashMode }
  | { type: 'error'; message: string }
  | { type: 'node_up'; nodeId: string }
  | { type: 'node_down'; nodeId: string; reason: string }
  | { type: 'behavior_registered'; behaviorName: string }
  | { type: 'process_spawned'; processId: string }
  | { type: 'remote_call_result'; callId: string; result: unknown; durationMs: number }
  | { type: 'remote_call_error'; callId: string; errorType: string; message: string; durationMs: number }
  | { type: 'remote_cast_sent' }
  | { type: 'process_info'; info: { id: string; status: string; state?: unknown } | null }
  | { type: 'remote_spawn_result'; spawnId: string; serverId: string; nodeId: string; durationMs: number }
  | { type: 'remote_spawn_error'; spawnId: string; errorType: string; message: string; durationMs: number };

/**
 * Node start configuration for child process.
 */
export interface NodeStartConfig {
  readonly nodeName: string;
  readonly port: number;
  readonly seeds: readonly string[];
  readonly heartbeatIntervalMs: number;
  readonly heartbeatMissThreshold: number;
  readonly clusterSecret?: string;
}

/**
 * Options for remote spawn IPC message.
 */
export interface RemoteSpawnIPCOptions {
  readonly name?: string;
  readonly registration?: 'local' | 'global' | 'none';
  readonly initTimeout?: number;
}

/**
 * Crash modes for node simulation.
 */
export type CrashMode =
  | 'graceful_shutdown'
  | 'abrupt_kill'
  | 'process_exit';

/**
 * Events emitted by TestCluster.
 */
export interface TestClusterEvents {
  /** Emitted when a node joins the cluster. */
  nodeUp: [nodeId: string, fromNodeId: string];
  /** Emitted when a node leaves the cluster. */
  nodeDown: [nodeId: string, reason: string, fromNodeId: string];
  /** Emitted when a node status changes. */
  nodeStatusChange: [nodeId: string, status: TestNodeStatus];
  /** Emitted when all nodes are connected to form a full mesh. */
  fullMesh: [];
  /** Emitted on cluster error. */
  error: [error: Error, nodeId?: string];
}

/**
 * Managed test node.
 */
interface ManagedNode {
  process: ChildProcess;
  nodeId: string;
  name: string;
  port: number;
  status: TestNodeStatus;
  connectedNodes: Set<string>;
  startedAt: number | null;
  pendingPromises: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>;
}

// =============================================================================
// TestCluster Class
// =============================================================================

/**
 * Manages a multi-node test cluster.
 *
 * Each node runs in a separate child process with IPC communication
 * for coordination. This allows testing real TCP connections between
 * nodes while maintaining control over the cluster topology.
 *
 * @example
 * ```typescript
 * const cluster = await TestClusterFactory.createCluster({
 *   nodeCount: 3,
 *   basePort: 20000,
 * });
 *
 * await cluster.waitForFullMesh();
 *
 * // Run stress tests...
 *
 * await cluster.stop();
 * ```
 */
export class TestCluster extends EventEmitter<TestClusterEvents> {
  private readonly nodes: Map<string, ManagedNode> = new Map();
  private readonly config: Required<TestClusterConfig>;
  private messageIdCounter = 0;

  constructor(config: TestClusterConfig) {
    super();
    this.config = {
      nodeCount: config.nodeCount,
      basePort: config.basePort,
      nodeNamePrefix: config.nodeNamePrefix ?? 'node',
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 500,
      heartbeatMissThreshold: config.heartbeatMissThreshold ?? 2,
      clusterSecret: config.clusterSecret ?? 'test-secret',
    };
  }

  /**
   * Returns information about all nodes.
   */
  getNodes(): readonly TestNodeInfo[] {
    return Array.from(this.nodes.values()).map((node) => ({
      nodeId: node.nodeId,
      name: node.name,
      port: node.port,
      status: node.status,
      connectedNodes: Array.from(node.connectedNodes),
      startedAt: node.startedAt,
      pid: node.process.pid ?? null,
    }));
  }

  /**
   * Returns information about a specific node.
   */
  getNode(nodeId: string): TestNodeInfo | undefined {
    const node = this.nodes.get(nodeId);
    if (!node) return undefined;

    return {
      nodeId: node.nodeId,
      name: node.name,
      port: node.port,
      status: node.status,
      connectedNodes: Array.from(node.connectedNodes),
      startedAt: node.startedAt,
      pid: node.process.pid ?? null,
    };
  }

  /**
   * Returns the number of running nodes.
   */
  getRunningNodeCount(): number {
    let count = 0;
    for (const node of this.nodes.values()) {
      if (node.status === 'running') count++;
    }
    return count;
  }

  /**
   * Returns node IDs.
   */
  getNodeIds(): readonly string[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Checks if cluster has formed a full mesh (all nodes connected to all others).
   */
  isFullMesh(): boolean {
    const runningNodes = Array.from(this.nodes.values()).filter(
      (n) => n.status === 'running'
    );

    if (runningNodes.length < 2) {
      return runningNodes.length === this.config.nodeCount;
    }

    const expectedConnections = runningNodes.length - 1;

    for (const node of runningNodes) {
      if (node.connectedNodes.size < expectedConnections) {
        return false;
      }
    }

    return true;
  }

  /**
   * Waits for all nodes to connect to each other (full mesh).
   */
  async waitForFullMesh(timeoutMs: number = 30000): Promise<void> {
    if (this.isFullMesh()) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for full mesh after ${timeoutMs}ms`));
      }, timeoutMs);

      const checkMesh = () => {
        if (this.isFullMesh()) {
          clearTimeout(timeout);
          this.off('nodeUp', checkMesh);
          resolve();
        }
      };

      this.on('nodeUp', checkMesh);
      checkMesh();
    });
  }

  /**
   * Waits for a specific number of nodes to be running.
   */
  async waitForNodes(
    count: number,
    timeoutMs: number = 15000
  ): Promise<void> {
    if (this.getRunningNodeCount() >= count) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for ${count} nodes after ${timeoutMs}ms`));
      }, timeoutMs);

      const check = () => {
        if (this.getRunningNodeCount() >= count) {
          clearTimeout(timeout);
          this.off('nodeStatusChange', check);
          resolve();
        }
      };

      this.on('nodeStatusChange', check);
      check();
    });
  }

  /**
   * Stops all nodes gracefully.
   */
  async stop(): Promise<void> {
    const stopPromises = Array.from(this.nodes.keys()).map((nodeId) =>
      this.stopNode(nodeId)
    );

    await Promise.all(stopPromises);
    this.nodes.clear();
  }

  /**
   * Stops a specific node gracefully.
   */
  async stopNode(nodeId: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    if (node.status === 'stopped' || node.status === 'crashed') {
      return;
    }

    node.status = 'stopping';
    this.emit('nodeStatusChange', nodeId, 'stopping');

    try {
      await this.sendMessage(node, { type: 'stop' }, 5000);
    } catch {
      // If stop fails, force kill
      node.process.kill('SIGKILL');
    }

    node.status = 'stopped';
    this.emit('nodeStatusChange', nodeId, 'stopped');
  }

  /**
   * Crashes a node with specified mode.
   */
  async crashNode(nodeId: string, mode: CrashMode = 'process_exit'): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Cannot crash node in ${node.status} state`);
    }

    if (mode === 'process_exit' || mode === 'abrupt_kill') {
      // Immediately kill the process
      node.process.kill(mode === 'abrupt_kill' ? 'SIGKILL' : 'SIGTERM');
      node.status = 'crashed';
      this.emit('nodeStatusChange', nodeId, 'crashed');
    } else {
      // Graceful shutdown through IPC
      await this.sendMessage(node, { type: 'crash', mode }, 5000);
      node.status = 'crashed';
      this.emit('nodeStatusChange', nodeId, 'crashed');
    }
  }

  /**
   * Restarts a stopped or crashed node.
   */
  async restartNode(nodeId: string): Promise<void> {
    const oldNode = this.nodes.get(nodeId);
    if (!oldNode) {
      throw new Error(`Node ${nodeId} not found`);
    }

    // Clean up old process if still running
    if (oldNode.process.connected) {
      oldNode.process.kill('SIGKILL');
    }

    // Create new process
    const seeds = this.getSeeds(oldNode.name);
    await this.startNodeProcess(oldNode.name, oldNode.port, seeds);
  }

  /**
   * Registers a behavior on a specific node for spawning processes.
   *
   * @param nodeId - Target node ID
   * @param behaviorName - Name of the behavior to register
   */
  async registerBehavior(nodeId: string, behaviorName: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    await this.sendMessage(node, { type: 'register_behavior', behaviorName }, 10000);
  }

  /**
   * Spawns a process on a specific node.
   *
   * @param nodeId - Target node ID
   * @param behaviorName - Name of the registered behavior
   * @param globalName - Optional global name for the process
   * @returns Process ID of the spawned process
   */
  async spawnProcess(
    nodeId: string,
    behaviorName: string,
    globalName?: string,
  ): Promise<string> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    return await this.sendMessage(
      node,
      { type: 'spawn_process', behaviorName, globalName },
      10000,
    );
  }

  /** Counter for generating unique call IDs. */
  private remoteCallIdCounter = 0;

  /**
   * Makes a remote call from one node to a process on another node.
   *
   * @param fromNodeId - Node to make the call from
   * @param targetNodeId - Node where the target process is running
   * @param processId - ID of the target process
   * @param msg - Message to send
   * @param timeoutMs - Call timeout in milliseconds
   * @returns Call result with duration metrics
   */
  async remoteCall<T>(
    fromNodeId: string,
    targetNodeId: string,
    processId: string,
    msg: unknown,
    timeoutMs: number = 5000,
  ): Promise<{ result: T; durationMs: number } | { error: true; errorType: string; message: string; durationMs: number }> {
    const node = this.nodes.get(fromNodeId);
    if (!node) {
      throw new Error(`Node ${fromNodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${fromNodeId} is not running`);
    }

    // Generate unique call ID for correlating response
    const callId = `rc_${this.remoteCallIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'remote_call', callId, targetNodeId, processId, msg, timeoutMs },
      callId,
      timeoutMs + 5000, // Add buffer for IPC communication
    );
  }

  /**
   * Sends a remote cast from one node to a process on another node.
   *
   * @param fromNodeId - Node to send the cast from
   * @param targetNodeId - Node where the target process is running
   * @param processId - ID of the target process
   * @param msg - Message to send
   */
  async remoteCast(
    fromNodeId: string,
    targetNodeId: string,
    processId: string,
    msg: unknown,
  ): Promise<void> {
    const node = this.nodes.get(fromNodeId);
    if (!node) {
      throw new Error(`Node ${fromNodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${fromNodeId} is not running`);
    }

    await this.sendMessage(
      node,
      { type: 'remote_cast', targetNodeId, processId, msg },
      5000,
    );
  }

  /** Counter for generating unique spawn IDs. */
  private remoteSpawnIdCounter = 0;

  /**
   * Spawns a process on a remote node using RemoteSpawn.
   *
   * @param fromNodeId - Node to initiate the spawn from
   * @param targetNodeId - Node to spawn the process on
   * @param behaviorName - Name of the registered behavior
   * @param options - Spawn options
   * @param timeoutMs - Spawn timeout in milliseconds
   * @returns Spawn result with serverId and nodeId, or error
   */
  async remoteSpawn(
    fromNodeId: string,
    targetNodeId: string,
    behaviorName: string,
    options?: RemoteSpawnIPCOptions,
    timeoutMs: number = 10000,
  ): Promise<{ serverId: string; nodeId: string; durationMs: number } | { error: true; errorType: string; message: string; durationMs: number }> {
    const node = this.nodes.get(fromNodeId);
    if (!node) {
      throw new Error(`Node ${fromNodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${fromNodeId} is not running`);
    }

    // Generate unique spawn ID for correlating response
    const spawnId = `rs_${this.remoteSpawnIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'remote_spawn', spawnId, behaviorName, targetNodeId, options, timeoutMs },
      spawnId,
      timeoutMs + 5000, // Add buffer for IPC communication
    );
  }

  /**
   * Starts the cluster by spawning all node processes.
   * Called internally by TestClusterFactory.
   */
  async _start(): Promise<void> {
    // Start all nodes
    for (let i = 0; i < this.config.nodeCount; i++) {
      const name = `${this.config.nodeNamePrefix}${i}`;
      const port = this.config.basePort + i;
      const seeds = this.getSeeds(name);

      await this.startNodeProcess(name, port, seeds);
    }

    // Wait for all nodes to be running
    await this.waitForNodes(this.config.nodeCount);
  }

  private getSeeds(excludeName: string): string[] {
    const seeds: string[] = [];

    for (let i = 0; i < this.config.nodeCount; i++) {
      const name = `${this.config.nodeNamePrefix}${i}`;
      if (name !== excludeName) {
        const port = this.config.basePort + i;
        seeds.push(`${name}@127.0.0.1:${port}`);
      }
    }

    return seeds;
  }

  private async startNodeProcess(
    name: string,
    port: number,
    seeds: readonly string[]
  ): Promise<void> {
    const nodeId = `${name}@127.0.0.1:${port}`;

    // Get paths
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const workerPath = path.join(__dirname, 'cluster-worker.ts');
    const projectRoot = path.resolve(__dirname, '../../..');
    const viteNodePath = path.join(projectRoot, 'node_modules/.bin/vite-node');

    // Use vite-node to run TypeScript directly with IPC
    const child = spawn(viteNodePath, [workerPath], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: '--experimental-vm-modules',
      },
    });

    const managedNode: ManagedNode = {
      process: child,
      nodeId,
      name,
      port,
      status: 'starting',
      connectedNodes: new Set(),
      startedAt: null,
      pendingPromises: new Map(),
    };

    this.nodes.set(nodeId, managedNode);

    // Set up message handling
    child.on('message', (msg: NodeIPCResponse) => {
      this.handleNodeMessage(managedNode, msg);
    });

    child.on('error', (error) => {
      this.emit('error', error, nodeId);
    });

    child.on('exit', (code, signal) => {
      if (managedNode.status !== 'stopped' && managedNode.status !== 'crashed') {
        managedNode.status = 'crashed';
        this.emit('nodeStatusChange', nodeId, 'crashed');
      }

      // Reject any pending promises
      for (const [, promise] of managedNode.pendingPromises) {
        promise.reject(new Error(`Process exited with code ${code}, signal ${signal}`));
      }
      managedNode.pendingPromises.clear();
    });

    // Wait for ready signal
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Node ${nodeId} failed to become ready`));
      }, 10000);

      const onReady = (msg: NodeIPCResponse) => {
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          child.off('message', onReady);
          resolve();
        }
      };

      child.on('message', onReady);
    });

    // Send start config
    const config: NodeStartConfig = {
      nodeName: name,
      port,
      seeds,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
      heartbeatMissThreshold: this.config.heartbeatMissThreshold,
      clusterSecret: this.config.clusterSecret,
    };

    await this.sendMessage(managedNode, { type: 'start', config }, 10000);

    managedNode.status = 'running';
    managedNode.startedAt = Date.now();
    this.emit('nodeStatusChange', nodeId, 'running');
  }

  private handleNodeMessage(node: ManagedNode, msg: NodeIPCResponse): void {
    switch (msg.type) {
      case 'started':
        this.resolvePending(node, 'start');
        break;

      case 'stopped':
        this.resolvePending(node, 'stop');
        break;

      case 'crashed':
        this.resolvePending(node, 'crash');
        break;

      case 'status':
        this.resolvePending(node, 'get_status', msg.info);
        break;

      case 'connected_nodes':
        this.resolvePending(node, 'get_connected_nodes', msg.nodes);
        break;

      case 'node_up':
        node.connectedNodes.add(msg.nodeId);
        this.emit('nodeUp', msg.nodeId, node.nodeId);
        if (this.isFullMesh()) {
          this.emit('fullMesh');
        }
        break;

      case 'node_down':
        node.connectedNodes.delete(msg.nodeId);
        this.emit('nodeDown', msg.nodeId, msg.reason, node.nodeId);
        break;

      case 'error':
        // Don't reject pending for expected errors during crash scenarios
        const isExpectedError = msg.message.includes('ECONNRESET') ||
                                msg.message.includes('EPIPE') ||
                                msg.message.includes('socket hang up');
        if (!isExpectedError) {
          this.rejectPending(node, new Error(msg.message));
        }
        // Emit error but mark expected errors so tests can handle them appropriately
        const error = new Error(msg.message) as Error & { expected?: boolean };
        error.expected = isExpectedError;
        this.emit('error', error, node.nodeId);
        break;

      case 'behavior_registered':
        this.resolvePending(node, 'register_behavior');
        break;

      case 'process_spawned':
        this.resolvePending(node, 'spawn_process', msg.processId);
        break;

      case 'remote_call_result':
        this.resolvePending(node, msg.callId, { result: msg.result, durationMs: msg.durationMs });
        break;

      case 'remote_call_error':
        this.resolvePending(node, msg.callId, {
          error: true,
          errorType: msg.errorType,
          message: msg.message,
          durationMs: msg.durationMs,
        });
        break;

      case 'remote_cast_sent':
        this.resolvePending(node, 'remote_cast');
        break;

      case 'process_info':
        this.resolvePending(node, 'get_process_info', msg.info);
        break;

      case 'remote_spawn_result':
        this.resolvePending(node, msg.spawnId, { serverId: msg.serverId, nodeId: msg.nodeId, durationMs: msg.durationMs });
        break;

      case 'remote_spawn_error':
        this.resolvePending(node, msg.spawnId, {
          error: true,
          errorType: msg.errorType,
          message: msg.message,
          durationMs: msg.durationMs,
        });
        break;
    }
  }

  private sendMessage(
    node: ManagedNode,
    msg: NodeIPCMessage,
    timeoutMs: number = 5000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const messageId = `${msg.type}_${this.messageIdCounter++}`;

      const timeout = setTimeout(() => {
        node.pendingPromises.delete(messageId);
        reject(new Error(`Timeout waiting for ${msg.type} response`));
      }, timeoutMs);

      node.pendingPromises.set(messageId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      // Store message type for resolution
      node.pendingPromises.set(msg.type, node.pendingPromises.get(messageId)!);

      node.process.send(msg);
    });
  }

  /**
   * Sends a message with a specific correlation ID for response tracking.
   * Used for messages that may be sent concurrently (like remote_call).
   */
  private sendMessageWithId(
    node: ManagedNode,
    msg: NodeIPCMessage,
    correlationId: string,
    timeoutMs: number = 5000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        node.pendingPromises.delete(correlationId);
        reject(new Error(`Timeout waiting for ${msg.type} response`));
      }, timeoutMs);

      node.pendingPromises.set(correlationId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      node.process.send(msg);
    });
  }

  private resolvePending(node: ManagedNode, type: string, value?: any): void {
    const promise = node.pendingPromises.get(type);
    if (promise) {
      node.pendingPromises.delete(type);
      promise.resolve(value);
    }
  }

  private rejectPending(node: ManagedNode, error: Error): void {
    // Reject all pending promises
    for (const [type, promise] of node.pendingPromises) {
      promise.reject(error);
    }
    node.pendingPromises.clear();
  }
}

// =============================================================================
// TestClusterFactory
// =============================================================================

/**
 * Factory for creating test clusters.
 *
 * @example
 * ```typescript
 * const cluster = await TestClusterFactory.createCluster({
 *   nodeCount: 5,
 *   basePort: 20000,
 * });
 *
 * // Wait for all nodes to connect
 * await TestClusterFactory.waitForFullMesh(cluster);
 *
 * // Stop the cluster
 * await TestClusterFactory.stopCluster(cluster);
 * ```
 */
export const TestClusterFactory = {
  /**
   * Creates and starts a new test cluster.
   */
  async createCluster(config: TestClusterConfig): Promise<TestCluster> {
    const cluster = new TestCluster(config);
    await cluster._start();
    return cluster;
  },

  /**
   * Waits for cluster to form a full mesh.
   */
  async waitForFullMesh(
    cluster: TestCluster,
    timeoutMs: number = 30000
  ): Promise<void> {
    return cluster.waitForFullMesh(timeoutMs);
  },

  /**
   * Stops a cluster and all its nodes.
   */
  async stopCluster(cluster: TestCluster): Promise<void> {
    return cluster.stop();
  },

  /**
   * Crashes a specific node in the cluster.
   */
  async crashNode(
    cluster: TestCluster,
    nodeId: string,
    mode: CrashMode = 'process_exit'
  ): Promise<void> {
    return cluster.crashNode(nodeId, mode);
  },

  /**
   * Simulates a network partition by crashing multiple nodes.
   */
  async partitionNetwork(
    cluster: TestCluster,
    partition1NodeIds: readonly string[],
    partition2NodeIds: readonly string[]
  ): Promise<void> {
    // In a real implementation, this would simulate network isolation
    // For now, we crash the smaller partition
    const toKill = partition1NodeIds.length <= partition2NodeIds.length
      ? partition1NodeIds
      : partition2NodeIds;

    await Promise.all(
      toKill.map((nodeId) => cluster.crashNode(nodeId, 'process_exit'))
    );
  },
};
