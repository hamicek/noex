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
  | { type: 'remote_spawn'; spawnId: string; behaviorName: string; targetNodeId: string; options?: RemoteSpawnIPCOptions; timeoutMs?: number }
  | { type: 'remote_monitor'; monitorId: string; monitoringProcessId: string; targetNodeId: string; targetProcessId: string; timeoutMs?: number }
  | { type: 'remote_demonitor'; monitorId: string; monitorRefId: string }
  | { type: 'get_monitor_stats' }
  | { type: 'global_register'; registrationId: string; name: string; processId: string }
  | { type: 'global_unregister'; registrationId: string; name: string }
  | { type: 'global_lookup'; lookupId: string; name: string }
  | { type: 'global_whereis'; lookupId: string; name: string }
  | { type: 'get_global_registry_stats' }
  | { type: 'get_global_registry_names' }
  // DistributedSupervisor messages
  | { type: 'dsup_start'; requestId: string; options: DistributedSupervisorIPCOptions }
  | { type: 'dsup_stop'; requestId: string; supervisorId: string; reason?: 'normal' | 'shutdown' }
  | { type: 'dsup_start_child'; requestId: string; supervisorId: string; spec: DistributedChildSpecIPC }
  | { type: 'dsup_terminate_child'; requestId: string; supervisorId: string; childId: string }
  | { type: 'dsup_restart_child'; requestId: string; supervisorId: string; childId: string }
  | { type: 'dsup_get_children'; requestId: string; supervisorId: string }
  | { type: 'dsup_get_stats'; requestId: string; supervisorId: string }
  | { type: 'dsup_count_children'; requestId: string; supervisorId: string }
  | { type: 'dsup_is_running'; requestId: string; supervisorId: string };

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
  | { type: 'remote_spawn_error'; spawnId: string; errorType: string; message: string; durationMs: number }
  | { type: 'remote_monitor_result'; monitorId: string; monitorRefId: string; durationMs: number }
  | { type: 'remote_monitor_error'; monitorId: string; errorType: string; message: string; durationMs: number }
  | { type: 'remote_demonitor_result'; monitorId: string }
  | { type: 'process_down'; monitorRefId: string; monitoredProcessId: string; reason: { type: string; message?: string } }
  | { type: 'monitor_stats'; stats: { initialized: boolean; pendingCount: number; activeOutgoingCount: number; totalInitiated: number; totalEstablished: number; totalTimedOut: number; totalDemonitored: number; totalProcessDownReceived: number } }
  | { type: 'global_register_result'; registrationId: string; durationMs: number }
  | { type: 'global_register_error'; registrationId: string; errorType: string; message: string; durationMs: number }
  | { type: 'global_unregister_result'; registrationId: string; durationMs: number }
  | { type: 'global_lookup_result'; lookupId: string; ref: { id: string; nodeId: string } | null; durationMs: number }
  | { type: 'global_lookup_error'; lookupId: string; errorType: string; message: string; durationMs: number }
  | { type: 'global_whereis_result'; lookupId: string; ref: { id: string; nodeId: string } | null; durationMs: number }
  | { type: 'global_registry_stats'; stats: GlobalRegistryStatsResult }
  | { type: 'global_registry_names'; names: string[] }
  | { type: 'global_registry_registered'; name: string; ref: { id: string; nodeId: string } }
  | { type: 'global_registry_unregistered'; name: string; ref: { id: string; nodeId: string } }
  | { type: 'global_registry_conflict_resolved'; name: string; winner: { id: string; nodeId: string }; loser: { id: string; nodeId: string } }
  | { type: 'global_registry_synced'; fromNodeId: string; entriesCount: number }
  // DistributedSupervisor responses
  | { type: 'dsup_started'; requestId: string; supervisorId: string; nodeId: string }
  | { type: 'dsup_start_error'; requestId: string; errorType: string; message: string }
  | { type: 'dsup_stopped'; requestId: string }
  | { type: 'dsup_stop_error'; requestId: string; errorType: string; message: string }
  | { type: 'dsup_child_started'; requestId: string; childRef: { id: string; nodeId: string } }
  | { type: 'dsup_child_start_error'; requestId: string; errorType: string; message: string }
  | { type: 'dsup_child_terminated'; requestId: string }
  | { type: 'dsup_child_terminate_error'; requestId: string; errorType: string; message: string }
  | { type: 'dsup_child_restarted'; requestId: string; childRef: { id: string; nodeId: string } }
  | { type: 'dsup_child_restart_error'; requestId: string; errorType: string; message: string }
  | { type: 'dsup_children'; requestId: string; children: DistributedChildInfoIPC[] }
  | { type: 'dsup_children_error'; requestId: string; errorType: string; message: string }
  | { type: 'dsup_stats'; requestId: string; stats: DistributedSupervisorStatsIPC }
  | { type: 'dsup_stats_error'; requestId: string; errorType: string; message: string }
  | { type: 'dsup_count'; requestId: string; count: number }
  | { type: 'dsup_count_error'; requestId: string; errorType: string; message: string }
  | { type: 'dsup_is_running_result'; requestId: string; isRunning: boolean }
  // DistributedSupervisor lifecycle events
  | { type: 'dsup_lifecycle_event'; event: DistributedSupervisorEventIPC };

/**
 * GlobalRegistry statistics result from IPC.
 */
export interface GlobalRegistryStatsResult {
  readonly totalRegistrations: number;
  readonly localRegistrations: number;
  readonly remoteRegistrations: number;
  readonly syncOperations: number;
  readonly conflictsResolved: number;
}

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

// =============================================================================
// DistributedSupervisor IPC Types
// =============================================================================

/**
 * Child specification for DistributedSupervisor IPC.
 */
export interface DistributedChildSpecIPC {
  readonly id: string;
  readonly behavior: string;
  readonly restart?: 'permanent' | 'transient' | 'temporary';
  readonly shutdownTimeout?: number;
  readonly significant?: boolean;
  readonly targetNodeId?: string;
}

/**
 * Options for starting DistributedSupervisor via IPC.
 */
export interface DistributedSupervisorIPCOptions {
  readonly strategy?: 'one_for_one' | 'one_for_all' | 'rest_for_one' | 'simple_one_for_one';
  readonly children?: readonly DistributedChildSpecIPC[];
  readonly childTemplate?: Omit<DistributedChildSpecIPC, 'id'>;
  readonly restartIntensity?: { maxRestarts: number; withinMs: number };
  readonly autoShutdown?: 'never' | 'any_significant' | 'all_significant';
  readonly nodeSelector?: 'local_first' | 'round_robin' | 'least_loaded';
}

/**
 * Child info returned from DistributedSupervisor via IPC.
 */
export interface DistributedChildInfoIPC {
  readonly id: string;
  readonly ref: { id: string; nodeId: string };
  readonly nodeId: string;
  readonly spec: DistributedChildSpecIPC;
  readonly restartCount: number;
  readonly startedAt: number;
}

/**
 * Statistics from DistributedSupervisor via IPC.
 */
export interface DistributedSupervisorStatsIPC {
  readonly id: string;
  readonly strategy: 'one_for_one' | 'one_for_all' | 'rest_for_one' | 'simple_one_for_one';
  readonly childCount: number;
  readonly totalRestarts: number;
  readonly nodeFailureRestarts: number;
  readonly uptimeMs: number;
  readonly localChildren: number;
  readonly remoteChildren: number;
}

/**
 * DistributedSupervisor lifecycle event for IPC.
 */
export type DistributedSupervisorEventIPC =
  | { type: 'supervisor_started'; supervisorId: string; nodeId: string }
  | { type: 'supervisor_stopped'; supervisorId: string; reason: string }
  | { type: 'child_started'; supervisorId: string; childId: string; nodeId: string; processId: string }
  | { type: 'child_stopped'; supervisorId: string; childId: string; reason: string }
  | { type: 'child_restarted'; supervisorId: string; childId: string; attempt: number; nodeId: string }
  | { type: 'child_migrated'; supervisorId: string; childId: string; fromNode: string; toNode: string }
  | { type: 'node_failure_detected'; supervisorId: string; nodeId: string; affectedChildren: readonly string[] }
  | { type: 'max_restarts_exceeded'; supervisorId: string; childId: string };

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
  /** Emitted when a monitored process goes down. */
  processDown: [monitorRefId: string, monitoredProcessId: string, reason: { type: string; message?: string }, fromNodeId: string];
  /** Emitted when a global name is registered. */
  globalRegistered: [name: string, ref: { id: string; nodeId: string }, fromNodeId: string];
  /** Emitted when a global name is unregistered. */
  globalUnregistered: [name: string, ref: { id: string; nodeId: string }, fromNodeId: string];
  /** Emitted when a registry conflict is resolved. */
  globalConflictResolved: [name: string, winner: { id: string; nodeId: string }, loser: { id: string; nodeId: string }, fromNodeId: string];
  /** Emitted when registry sync completes. */
  globalSynced: [fromNodeId: string, entriesCount: number, reportingNodeId: string];
  /** Emitted when a distributed supervisor lifecycle event occurs. */
  dsupLifecycleEvent: [event: DistributedSupervisorEventIPC, fromNodeId: string];
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

  /** Counter for generating unique monitor IDs. */
  private remoteMonitorIdCounter = 0;

  /**
   * Sets up a remote monitor from one node to a process on another node.
   *
   * @param fromNodeId - Node to set up the monitor from
   * @param monitoringProcessId - Local process ID that will receive notifications
   * @param targetNodeId - Node where the target process is running
   * @param targetProcessId - ID of the process to monitor
   * @param timeoutMs - Monitor setup timeout in milliseconds
   * @returns Monitor result with monitorRefId, or error
   */
  async remoteMonitor(
    fromNodeId: string,
    monitoringProcessId: string,
    targetNodeId: string,
    targetProcessId: string,
    timeoutMs: number = 10000,
  ): Promise<{ monitorRefId: string; durationMs: number } | { error: true; errorType: string; message: string; durationMs: number }> {
    const node = this.nodes.get(fromNodeId);
    if (!node) {
      throw new Error(`Node ${fromNodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${fromNodeId} is not running`);
    }

    const monitorId = `rm_${this.remoteMonitorIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'remote_monitor', monitorId, monitoringProcessId, targetNodeId, targetProcessId, timeoutMs },
      monitorId,
      timeoutMs + 5000,
    );
  }

  /**
   * Removes a remote monitor.
   *
   * @param fromNodeId - Node that has the monitor set up
   * @param monitorRefId - ID of the monitor reference to remove
   */
  async remoteDemonitor(
    fromNodeId: string,
    monitorRefId: string,
  ): Promise<void> {
    const node = this.nodes.get(fromNodeId);
    if (!node) {
      throw new Error(`Node ${fromNodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${fromNodeId} is not running`);
    }

    const monitorId = `dm_${this.remoteMonitorIdCounter++}_${Date.now()}`;

    await this.sendMessageWithId(
      node,
      { type: 'remote_demonitor', monitorId, monitorRefId },
      monitorId,
      5000,
    );
  }

  /**
   * Gets remote monitor statistics from a node.
   *
   * @param nodeId - Node to get stats from
   */
  async getMonitorStats(
    nodeId: string,
  ): Promise<{
    initialized: boolean;
    pendingCount: number;
    activeOutgoingCount: number;
    totalInitiated: number;
    totalEstablished: number;
    totalTimedOut: number;
    totalDemonitored: number;
    totalProcessDownReceived: number;
  }> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    return await this.sendMessage(node, { type: 'get_monitor_stats' }, 5000);
  }

  // ===========================================================================
  // GlobalRegistry Methods
  // ===========================================================================

  /** Counter for generating unique registration IDs. */
  private globalRegistrationIdCounter = 0;

  /** Counter for generating unique lookup IDs. */
  private globalLookupIdCounter = 0;

  /**
   * Registers a process globally in the cluster registry.
   *
   * @param nodeId - Node to register from
   * @param name - Global name for the registration
   * @param processId - ID of the process to register
   * @param timeoutMs - Registration timeout in milliseconds
   * @returns Registration result with duration, or error
   */
  async globalRegister(
    nodeId: string,
    name: string,
    processId: string,
    timeoutMs: number = 10000,
  ): Promise<{ durationMs: number } | { error: true; errorType: string; message: string; durationMs: number }> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    const registrationId = `gr_${this.globalRegistrationIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'global_register', registrationId, name, processId },
      registrationId,
      timeoutMs + 5000,
    );
  }

  /**
   * Unregisters a globally registered name.
   *
   * @param nodeId - Node to unregister from
   * @param name - Global name to unregister
   * @param timeoutMs - Unregistration timeout in milliseconds
   */
  async globalUnregister(
    nodeId: string,
    name: string,
    timeoutMs: number = 5000,
  ): Promise<{ durationMs: number }> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    const registrationId = `gu_${this.globalRegistrationIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'global_unregister', registrationId, name },
      registrationId,
      timeoutMs + 5000,
    );
  }

  /**
   * Looks up a globally registered name (throws if not found).
   *
   * @param nodeId - Node to look up from
   * @param name - Global name to look up
   * @param timeoutMs - Lookup timeout in milliseconds
   * @returns Reference to the registered process, or error
   */
  async globalLookup(
    nodeId: string,
    name: string,
    timeoutMs: number = 5000,
  ): Promise<{ ref: { id: string; nodeId: string }; durationMs: number } | { error: true; errorType: string; message: string; durationMs: number }> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    const lookupId = `gl_${this.globalLookupIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'global_lookup', lookupId, name },
      lookupId,
      timeoutMs + 5000,
    );
  }

  /**
   * Looks up a globally registered name (returns null if not found).
   *
   * @param nodeId - Node to look up from
   * @param name - Global name to look up
   * @param timeoutMs - Lookup timeout in milliseconds
   * @returns Reference to the registered process, or null if not found
   */
  async globalWhereis(
    nodeId: string,
    name: string,
    timeoutMs: number = 5000,
  ): Promise<{ ref: { id: string; nodeId: string } | null; durationMs: number }> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    const lookupId = `gw_${this.globalLookupIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'global_whereis', lookupId, name },
      lookupId,
      timeoutMs + 5000,
    );
  }

  /**
   * Gets GlobalRegistry statistics from a node.
   *
   * @param nodeId - Node to get stats from
   */
  async getGlobalRegistryStats(nodeId: string): Promise<GlobalRegistryStatsResult> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    return await this.sendMessage(node, { type: 'get_global_registry_stats' }, 5000);
  }

  /**
   * Gets all registered global names from a node.
   *
   * @param nodeId - Node to get names from
   */
  async getGlobalRegistryNames(nodeId: string): Promise<string[]> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    return await this.sendMessage(node, { type: 'get_global_registry_names' }, 5000);
  }

  // ===========================================================================
  // DistributedSupervisor Methods
  // ===========================================================================

  /** Counter for generating unique DistributedSupervisor request IDs. */
  private dsupRequestIdCounter = 0;

  /**
   * Starts a DistributedSupervisor on a node.
   *
   * @param nodeId - Node to start supervisor on
   * @param options - Supervisor options
   * @param timeoutMs - Start timeout in milliseconds
   * @returns Supervisor reference, or error
   */
  async dsupStart(
    nodeId: string,
    options: DistributedSupervisorIPCOptions = {},
    timeoutMs: number = 30000,
  ): Promise<{ supervisorId: string; nodeId: string } | { error: true; errorType: string; message: string }> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    const requestId = `dsup_start_${this.dsupRequestIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'dsup_start', requestId, options },
      requestId,
      timeoutMs + 5000,
    );
  }

  /**
   * Stops a DistributedSupervisor on a node.
   *
   * @param nodeId - Node where supervisor is running
   * @param supervisorId - Supervisor ID to stop
   * @param reason - Stop reason
   * @param timeoutMs - Stop timeout in milliseconds
   */
  async dsupStop(
    nodeId: string,
    supervisorId: string,
    reason: 'normal' | 'shutdown' = 'normal',
    timeoutMs: number = 30000,
  ): Promise<void | { error: true; errorType: string; message: string }> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    const requestId = `dsup_stop_${this.dsupRequestIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'dsup_stop', requestId, supervisorId, reason },
      requestId,
      timeoutMs + 5000,
    );
  }

  /**
   * Starts a child in a DistributedSupervisor.
   *
   * @param nodeId - Node where supervisor is running
   * @param supervisorId - Supervisor ID
   * @param spec - Child specification
   * @param timeoutMs - Start timeout in milliseconds
   * @returns Child reference, or error
   */
  async dsupStartChild(
    nodeId: string,
    supervisorId: string,
    spec: DistributedChildSpecIPC,
    timeoutMs: number = 30000,
  ): Promise<{ childRef: { id: string; nodeId: string } } | { error: true; errorType: string; message: string }> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    const requestId = `dsup_child_${this.dsupRequestIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'dsup_start_child', requestId, supervisorId, spec },
      requestId,
      timeoutMs + 5000,
    );
  }

  /**
   * Terminates a child in a DistributedSupervisor.
   *
   * @param nodeId - Node where supervisor is running
   * @param supervisorId - Supervisor ID
   * @param childId - Child ID to terminate
   * @param timeoutMs - Terminate timeout in milliseconds
   */
  async dsupTerminateChild(
    nodeId: string,
    supervisorId: string,
    childId: string,
    timeoutMs: number = 10000,
  ): Promise<void | { error: true; errorType: string; message: string }> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    const requestId = `dsup_term_${this.dsupRequestIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'dsup_terminate_child', requestId, supervisorId, childId },
      requestId,
      timeoutMs + 5000,
    );
  }

  /**
   * Restarts a child in a DistributedSupervisor.
   *
   * @param nodeId - Node where supervisor is running
   * @param supervisorId - Supervisor ID
   * @param childId - Child ID to restart
   * @param timeoutMs - Restart timeout in milliseconds
   * @returns New child reference, or error
   */
  async dsupRestartChild(
    nodeId: string,
    supervisorId: string,
    childId: string,
    timeoutMs: number = 30000,
  ): Promise<{ childRef: { id: string; nodeId: string } } | { error: true; errorType: string; message: string }> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    const requestId = `dsup_restart_${this.dsupRequestIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'dsup_restart_child', requestId, supervisorId, childId },
      requestId,
      timeoutMs + 5000,
    );
  }

  /**
   * Gets all children of a DistributedSupervisor.
   *
   * @param nodeId - Node where supervisor is running
   * @param supervisorId - Supervisor ID
   * @param timeoutMs - Timeout in milliseconds
   * @returns Array of child info
   */
  async dsupGetChildren(
    nodeId: string,
    supervisorId: string,
    timeoutMs: number = 5000,
  ): Promise<DistributedChildInfoIPC[] | { error: true; errorType: string; message: string }> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    const requestId = `dsup_children_${this.dsupRequestIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'dsup_get_children', requestId, supervisorId },
      requestId,
      timeoutMs + 5000,
    );
  }

  /**
   * Gets statistics from a DistributedSupervisor.
   *
   * @param nodeId - Node where supervisor is running
   * @param supervisorId - Supervisor ID
   * @param timeoutMs - Timeout in milliseconds
   * @returns Supervisor stats
   */
  async dsupGetStats(
    nodeId: string,
    supervisorId: string,
    timeoutMs: number = 5000,
  ): Promise<DistributedSupervisorStatsIPC | { error: true; errorType: string; message: string }> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    const requestId = `dsup_stats_${this.dsupRequestIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'dsup_get_stats', requestId, supervisorId },
      requestId,
      timeoutMs + 5000,
    );
  }

  /**
   * Counts children of a DistributedSupervisor.
   *
   * @param nodeId - Node where supervisor is running
   * @param supervisorId - Supervisor ID
   * @param timeoutMs - Timeout in milliseconds
   * @returns Child count
   */
  async dsupCountChildren(
    nodeId: string,
    supervisorId: string,
    timeoutMs: number = 5000,
  ): Promise<number | { error: true; errorType: string; message: string }> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    const requestId = `dsup_count_${this.dsupRequestIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'dsup_count_children', requestId, supervisorId },
      requestId,
      timeoutMs + 5000,
    );
  }

  /**
   * Checks if a DistributedSupervisor is running.
   *
   * @param nodeId - Node where supervisor is running
   * @param supervisorId - Supervisor ID
   * @param timeoutMs - Timeout in milliseconds
   * @returns Whether supervisor is running
   */
  async dsupIsRunning(
    nodeId: string,
    supervisorId: string,
    timeoutMs: number = 5000,
  ): Promise<boolean> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'running') {
      throw new Error(`Node ${nodeId} is not running`);
    }

    const requestId = `dsup_running_${this.dsupRequestIdCounter++}_${Date.now()}`;

    return await this.sendMessageWithId(
      node,
      { type: 'dsup_is_running', requestId, supervisorId },
      requestId,
      timeoutMs + 5000,
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

      case 'remote_monitor_result':
        this.resolvePending(node, msg.monitorId, {
          monitorRefId: msg.monitorRefId,
          durationMs: msg.durationMs,
        });
        break;

      case 'remote_monitor_error':
        this.resolvePending(node, msg.monitorId, {
          error: true,
          errorType: msg.errorType,
          message: msg.message,
          durationMs: msg.durationMs,
        });
        break;

      case 'remote_demonitor_result':
        this.resolvePending(node, msg.monitorId);
        break;

      case 'process_down':
        this.emit('processDown' as keyof TestClusterEvents, msg.monitorRefId, msg.monitoredProcessId, msg.reason, node.nodeId);
        break;

      case 'monitor_stats':
        this.resolvePending(node, 'get_monitor_stats', msg.stats);
        break;

      case 'global_register_result':
        this.resolvePending(node, msg.registrationId, { durationMs: msg.durationMs });
        break;

      case 'global_register_error':
        this.resolvePending(node, msg.registrationId, {
          error: true,
          errorType: msg.errorType,
          message: msg.message,
          durationMs: msg.durationMs,
        });
        break;

      case 'global_unregister_result':
        this.resolvePending(node, msg.registrationId, { durationMs: msg.durationMs });
        break;

      case 'global_lookup_result':
        this.resolvePending(node, msg.lookupId, {
          ref: msg.ref,
          durationMs: msg.durationMs,
        });
        break;

      case 'global_lookup_error':
        this.resolvePending(node, msg.lookupId, {
          error: true,
          errorType: msg.errorType,
          message: msg.message,
          durationMs: msg.durationMs,
        });
        break;

      case 'global_whereis_result':
        this.resolvePending(node, msg.lookupId, {
          ref: msg.ref,
          durationMs: msg.durationMs,
        });
        break;

      case 'global_registry_stats':
        this.resolvePending(node, 'get_global_registry_stats', msg.stats);
        break;

      case 'global_registry_names':
        this.resolvePending(node, 'get_global_registry_names', msg.names);
        break;

      case 'global_registry_registered':
        this.emit('globalRegistered', msg.name, msg.ref, node.nodeId);
        break;

      case 'global_registry_unregistered':
        this.emit('globalUnregistered', msg.name, msg.ref, node.nodeId);
        break;

      case 'global_registry_conflict_resolved':
        this.emit('globalConflictResolved', msg.name, msg.winner, msg.loser, node.nodeId);
        break;

      case 'global_registry_synced':
        this.emit('globalSynced', msg.fromNodeId, msg.entriesCount, node.nodeId);
        break;

      // DistributedSupervisor responses
      case 'dsup_started':
        this.resolvePending(node, msg.requestId, { supervisorId: msg.supervisorId, nodeId: msg.nodeId });
        break;

      case 'dsup_start_error':
        this.resolvePending(node, msg.requestId, {
          error: true,
          errorType: msg.errorType,
          message: msg.message,
        });
        break;

      case 'dsup_stopped':
        this.resolvePending(node, msg.requestId);
        break;

      case 'dsup_stop_error':
        this.resolvePending(node, msg.requestId, {
          error: true,
          errorType: msg.errorType,
          message: msg.message,
        });
        break;

      case 'dsup_child_started':
        this.resolvePending(node, msg.requestId, { childRef: msg.childRef });
        break;

      case 'dsup_child_start_error':
        this.resolvePending(node, msg.requestId, {
          error: true,
          errorType: msg.errorType,
          message: msg.message,
        });
        break;

      case 'dsup_child_terminated':
        this.resolvePending(node, msg.requestId);
        break;

      case 'dsup_child_terminate_error':
        this.resolvePending(node, msg.requestId, {
          error: true,
          errorType: msg.errorType,
          message: msg.message,
        });
        break;

      case 'dsup_child_restarted':
        this.resolvePending(node, msg.requestId, { childRef: msg.childRef });
        break;

      case 'dsup_child_restart_error':
        this.resolvePending(node, msg.requestId, {
          error: true,
          errorType: msg.errorType,
          message: msg.message,
        });
        break;

      case 'dsup_children':
        this.resolvePending(node, msg.requestId, msg.children);
        break;

      case 'dsup_children_error':
        this.resolvePending(node, msg.requestId, {
          error: true,
          errorType: msg.errorType,
          message: msg.message,
        });
        break;

      case 'dsup_stats':
        this.resolvePending(node, msg.requestId, msg.stats);
        break;

      case 'dsup_stats_error':
        this.resolvePending(node, msg.requestId, {
          error: true,
          errorType: msg.errorType,
          message: msg.message,
        });
        break;

      case 'dsup_count':
        this.resolvePending(node, msg.requestId, msg.count);
        break;

      case 'dsup_count_error':
        this.resolvePending(node, msg.requestId, {
          error: true,
          errorType: msg.errorType,
          message: msg.message,
        });
        break;

      case 'dsup_is_running_result':
        this.resolvePending(node, msg.requestId, msg.isRunning);
        break;

      case 'dsup_lifecycle_event':
        this.emit('dsupLifecycleEvent', msg.event, node.nodeId);
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
