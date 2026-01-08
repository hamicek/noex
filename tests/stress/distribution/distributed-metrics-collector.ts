/**
 * Extended metrics collection for distributed stress testing.
 *
 * Provides comprehensive tracking of cluster, transport, remote call,
 * remote spawn, registry, and supervisor metrics during distributed tests.
 *
 * @module tests/stress/distribution/distributed-metrics-collector
 */

import type { TestCluster, TestClusterEvents } from './cluster-factory.js';
import type { StressTestMetrics, MemorySnapshot } from '../metrics-collector.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Extended timeline event types for distributed metrics.
 */
export type DistributedTimelineEventType =
  | 'node_up'
  | 'node_down'
  | 'reconnection'
  | 'message_sent'
  | 'message_received'
  | 'message_dropped'
  | 'remote_call_started'
  | 'remote_call_completed'
  | 'remote_call_timeout'
  | 'remote_spawn_started'
  | 'remote_spawn_completed'
  | 'remote_spawn_failed'
  | 'registry_registration'
  | 'registry_conflict'
  | 'registry_sync'
  | 'supervisor_migration'
  | 'supervisor_failover'
  | 'supervisor_restart'
  | 'memory_snapshot'
  | 'custom';

/**
 * A single event in the distributed metrics timeline.
 */
export interface DistributedTimelineEvent {
  /** Type of event. */
  readonly type: DistributedTimelineEventType;
  /** Unix timestamp in milliseconds. */
  readonly timestamp: number;
  /** Elapsed time from metrics collection start. */
  readonly elapsedMs: number;
  /** Node ID associated with the event (if applicable). */
  readonly nodeId?: string;
  /** Target node ID (for remote operations). */
  readonly targetNodeId?: string;
  /** Additional event-specific data. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Cluster-level metrics.
 */
export interface ClusterMetrics {
  /** Number of node_up events received. */
  readonly nodeUpEvents: number;
  /** Number of node_down events received. */
  readonly nodeDownEvents: number;
  /** Number of successful reconnections after node down. */
  readonly reconnections: number;
  /** Average time to reconnect after node down (ms). */
  readonly avgReconnectionTimeMs: number;
  /** Minimum reconnection time (ms). */
  readonly minReconnectionTimeMs: number;
  /** Maximum reconnection time (ms). */
  readonly maxReconnectionTimeMs: number;
  /** 95th percentile reconnection time (ms). */
  readonly p95ReconnectionTimeMs: number;
  /** All individual reconnection times (ms). */
  readonly reconnectionTimes: readonly number[];
}

/**
 * Transport-level metrics.
 */
export interface TransportMetrics {
  /** Total messages sent across cluster. */
  readonly messagesSent: number;
  /** Total messages received across cluster. */
  readonly messagesReceived: number;
  /** Messages that were dropped or failed delivery. */
  readonly messagesDropped: number;
  /** Delivery success rate (0-1). */
  readonly deliveryRate: number;
  /** Average message latency (ms). */
  readonly avgLatencyMs: number;
  /** Minimum message latency (ms). */
  readonly minLatencyMs: number;
  /** Maximum message latency (ms). */
  readonly maxLatencyMs: number;
  /** 95th percentile message latency (ms). */
  readonly p95LatencyMs: number;
  /** 99th percentile message latency (ms). */
  readonly p99LatencyMs: number;
  /** All individual message latencies (ms). */
  readonly latencies: readonly number[];
}

/**
 * Remote call metrics.
 */
export interface RemoteCallMetrics {
  /** Total remote calls initiated. */
  readonly totalCalls: number;
  /** Successful remote calls. */
  readonly successfulCalls: number;
  /** Calls that timed out. */
  readonly timeoutCalls: number;
  /** Calls that failed (non-timeout). */
  readonly failedCalls: number;
  /** Success rate (0-1). */
  readonly successRate: number;
  /** Peak pending call queue size. */
  readonly pendingQueuePeak: number;
  /** Average call duration (ms). */
  readonly avgCallDurationMs: number;
  /** 95th percentile call duration (ms). */
  readonly p95CallDurationMs: number;
  /** 99th percentile call duration (ms). */
  readonly p99CallDurationMs: number;
  /** All individual call durations (ms). */
  readonly callDurations: readonly number[];
}

/**
 * Remote spawn metrics.
 */
export interface RemoteSpawnMetrics {
  /** Total spawn attempts. */
  readonly totalSpawns: number;
  /** Successful spawns. */
  readonly successfulSpawns: number;
  /** Failed spawns. */
  readonly failedSpawns: number;
  /** Success rate (0-1). */
  readonly successRate: number;
  /** Average spawn time (ms). */
  readonly avgSpawnTimeMs: number;
  /** Minimum spawn time (ms). */
  readonly minSpawnTimeMs: number;
  /** Maximum spawn time (ms). */
  readonly maxSpawnTimeMs: number;
  /** 95th percentile spawn time (ms). */
  readonly p95SpawnTimeMs: number;
  /** All individual spawn times (ms). */
  readonly spawnTimes: readonly number[];
}

/**
 * Registry metrics.
 */
export interface RegistryMetrics {
  /** Total registrations attempted. */
  readonly totalRegistrations: number;
  /** Successful registrations. */
  readonly successfulRegistrations: number;
  /** Registration conflicts resolved. */
  readonly conflictsResolved: number;
  /** Sync operations performed. */
  readonly syncOperations: number;
  /** Average sync duration (ms). */
  readonly avgSyncDurationMs: number;
  /** Registration success rate (0-1). */
  readonly successRate: number;
}

/**
 * Supervisor metrics.
 */
export interface SupervisorMetrics {
  /** Total child migrations between nodes. */
  readonly migrations: number;
  /** Total failover events. */
  readonly failovers: number;
  /** Map of node ID to restart count. */
  readonly restartsByNode: Readonly<Record<string, number>>;
  /** Total restarts across all nodes. */
  readonly totalRestarts: number;
  /** Average migration time (ms). */
  readonly avgMigrationTimeMs: number;
  /** Average failover time (ms). */
  readonly avgFailoverTimeMs: number;
}

/**
 * Complete distributed stress test metrics.
 */
export interface DistributedStressMetrics extends StressTestMetrics {
  /** Cluster-level metrics. */
  readonly cluster: ClusterMetrics;
  /** Transport-level metrics. */
  readonly transport: TransportMetrics;
  /** Remote call metrics. */
  readonly remoteCall: RemoteCallMetrics;
  /** Remote spawn metrics. */
  readonly remoteSpawn: RemoteSpawnMetrics;
  /** Registry metrics. */
  readonly registry: RegistryMetrics;
  /** Supervisor metrics. */
  readonly supervisor: SupervisorMetrics;
  /** Extended timeline with distributed events. */
  readonly distributedTimeline: readonly DistributedTimelineEvent[];
}

/**
 * Pending reconnection tracking.
 */
interface PendingReconnection {
  readonly nodeId: string;
  readonly disconnectTime: number;
}

/**
 * Pending remote call tracking.
 */
interface PendingRemoteCall {
  readonly callId: string;
  readonly targetNodeId: string;
  readonly startTime: number;
}

/**
 * Pending remote spawn tracking.
 */
interface PendingRemoteSpawn {
  readonly spawnId: string;
  readonly targetNodeId: string;
  readonly startTime: number;
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration for DistributedMetricsCollector.
 */
export interface DistributedMetricsConfig {
  /** Interval for memory snapshots in ms (0 to disable). Default: 1000. */
  readonly memorySnapshotIntervalMs?: number;
  /** Test cluster to monitor (optional). */
  readonly cluster?: TestCluster;
  /** Enable automatic cluster event tracking. Default: true. */
  readonly trackClusterEvents?: boolean;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Calculates percentile from a sorted array of numbers.
 *
 * @param sortedValues - Pre-sorted array of numbers
 * @param p - Percentile to calculate (0-100)
 * @returns The value at the given percentile
 */
function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))]!;
}

/**
 * Calculates average of an array of numbers.
 *
 * @param values - Array of numbers
 * @returns The average value, or 0 if empty
 */
function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Creates a sorted copy of an array.
 *
 * @param values - Array to sort
 * @returns New sorted array
 */
function sortedCopy(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/**
 * Creates an empty memory snapshot for fallback.
 */
function createEmptyMemorySnapshot(): MemorySnapshot {
  return {
    timestamp: 0,
    elapsedMs: 0,
    heapUsed: 0,
    heapTotal: 0,
    external: 0,
    rss: 0,
  };
}

/**
 * Formats bytes to human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

// =============================================================================
// DistributedMetricsCollector Class
// =============================================================================

/**
 * Collects comprehensive metrics for distributed stress tests.
 *
 * Tracks cluster topology changes, transport statistics, remote operations,
 * registry activity, and supervisor behavior across the distributed system.
 *
 * @example
 * ```typescript
 * const cluster = await TestClusterFactory.createCluster({
 *   nodeCount: 3,
 *   basePort: 20000,
 * });
 *
 * const collector = new DistributedMetricsCollector({ cluster });
 * collector.start();
 *
 * // Run distributed stress tests...
 *
 * collector.stop();
 * const metrics = collector.getDistributedMetrics();
 * console.log(`Node up events: ${metrics.cluster.nodeUpEvents}`);
 * console.log(`Remote call success rate: ${metrics.remoteCall.successRate * 100}%`);
 * ```
 */
export class DistributedMetricsCollector {
  private readonly config: Required<Omit<DistributedMetricsConfig, 'cluster'>> & { cluster?: TestCluster };

  // State
  private startTime: number = 0;
  private endTime: number = 0;
  private running: boolean = false;

  // Timeline
  private readonly timeline: DistributedTimelineEvent[] = [];

  // Cluster tracking
  private nodeUpCount: number = 0;
  private nodeDownCount: number = 0;
  private readonly pendingReconnections: Map<string, PendingReconnection> = new Map();
  private readonly reconnectionTimes: number[] = [];
  private clusterUnsubscribers: Array<() => void> = [];

  // Transport tracking
  private messagesSent: number = 0;
  private messagesReceived: number = 0;
  private messagesDropped: number = 0;
  private readonly messageLatencies: number[] = [];

  // Remote call tracking
  private totalCalls: number = 0;
  private successfulCalls: number = 0;
  private timeoutCalls: number = 0;
  private failedCalls: number = 0;
  private pendingQueuePeak: number = 0;
  private readonly pendingCalls: Map<string, PendingRemoteCall> = new Map();
  private readonly callDurations: number[] = [];

  // Remote spawn tracking
  private totalSpawns: number = 0;
  private successfulSpawns: number = 0;
  private failedSpawns: number = 0;
  private readonly pendingSpawns: Map<string, PendingRemoteSpawn> = new Map();
  private readonly spawnTimes: number[] = [];

  // Registry tracking
  private totalRegistrations: number = 0;
  private successfulRegistrations: number = 0;
  private conflictsResolved: number = 0;
  private syncOperations: number = 0;
  private readonly syncDurations: number[] = [];

  // Supervisor tracking
  private migrations: number = 0;
  private failovers: number = 0;
  private readonly restartsByNode: Map<string, number> = new Map();
  private readonly migrationTimes: number[] = [];
  private readonly failoverTimes: number[] = [];

  // Memory tracking
  private readonly memorySnapshots: MemorySnapshot[] = [];
  private memorySnapshotInterval: ReturnType<typeof setInterval> | undefined;

  // Custom metrics
  private readonly customMetrics: Record<string, unknown> = {};

  constructor(config: DistributedMetricsConfig = {}) {
    this.config = {
      memorySnapshotIntervalMs: config.memorySnapshotIntervalMs ?? 1000,
      cluster: config.cluster,
      trackClusterEvents: config.trackClusterEvents ?? true,
    };
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Starts metrics collection.
   */
  start(): void {
    if (this.running) return;

    this.startTime = Date.now();
    this.running = true;

    // Take initial memory snapshot
    this.takeMemorySnapshot();

    // Set up periodic memory snapshots
    if (this.config.memorySnapshotIntervalMs > 0) {
      this.memorySnapshotInterval = setInterval(() => {
        this.takeMemorySnapshot();
      }, this.config.memorySnapshotIntervalMs);
    }

    // Subscribe to cluster events if configured
    if (this.config.cluster && this.config.trackClusterEvents) {
      this.subscribeToClusterEvents(this.config.cluster);
    }
  }

  /**
   * Stops metrics collection.
   */
  stop(): void {
    if (!this.running) return;

    this.endTime = Date.now();
    this.running = false;

    // Take final memory snapshot
    this.takeMemorySnapshot();

    // Clear memory snapshot interval
    if (this.memorySnapshotInterval) {
      clearInterval(this.memorySnapshotInterval);
      this.memorySnapshotInterval = undefined;
    }

    // Unsubscribe from cluster events
    for (const unsubscribe of this.clusterUnsubscribers) {
      unsubscribe();
    }
    this.clusterUnsubscribers = [];
  }

  /**
   * Resets all collected metrics.
   */
  reset(): void {
    this.timeline.length = 0;

    // Cluster
    this.nodeUpCount = 0;
    this.nodeDownCount = 0;
    this.pendingReconnections.clear();
    this.reconnectionTimes.length = 0;

    // Transport
    this.messagesSent = 0;
    this.messagesReceived = 0;
    this.messagesDropped = 0;
    this.messageLatencies.length = 0;

    // Remote calls
    this.totalCalls = 0;
    this.successfulCalls = 0;
    this.timeoutCalls = 0;
    this.failedCalls = 0;
    this.pendingQueuePeak = 0;
    this.pendingCalls.clear();
    this.callDurations.length = 0;

    // Remote spawns
    this.totalSpawns = 0;
    this.successfulSpawns = 0;
    this.failedSpawns = 0;
    this.pendingSpawns.clear();
    this.spawnTimes.length = 0;

    // Registry
    this.totalRegistrations = 0;
    this.successfulRegistrations = 0;
    this.conflictsResolved = 0;
    this.syncOperations = 0;
    this.syncDurations.length = 0;

    // Supervisor
    this.migrations = 0;
    this.failovers = 0;
    this.restartsByNode.clear();
    this.migrationTimes.length = 0;
    this.failoverTimes.length = 0;

    // Memory
    this.memorySnapshots.length = 0;

    // Custom
    Object.keys(this.customMetrics).forEach((key) => delete this.customMetrics[key]);
  }

  // ===========================================================================
  // Cluster Event Recording
  // ===========================================================================

  /**
   * Records a node_up event.
   */
  recordNodeUp(nodeId: string, fromNodeId?: string): void {
    this.nodeUpCount++;
    this.addTimelineEvent('node_up', { nodeId, data: { fromNodeId } });

    // Check if this completes a reconnection
    const pending = this.pendingReconnections.get(nodeId);
    if (pending) {
      const reconnectionTime = Date.now() - pending.disconnectTime;
      this.reconnectionTimes.push(reconnectionTime);
      this.pendingReconnections.delete(nodeId);
      this.addTimelineEvent('reconnection', {
        nodeId,
        data: { reconnectionTimeMs: reconnectionTime },
      });
    }
  }

  /**
   * Records a node_down event.
   */
  recordNodeDown(nodeId: string, reason: string, fromNodeId?: string): void {
    this.nodeDownCount++;
    this.addTimelineEvent('node_down', { nodeId, data: { reason, fromNodeId } });

    // Start tracking potential reconnection
    this.pendingReconnections.set(nodeId, {
      nodeId,
      disconnectTime: Date.now(),
    });
  }

  // ===========================================================================
  // Transport Event Recording
  // ===========================================================================

  /**
   * Records a message being sent.
   */
  recordMessageSent(targetNodeId?: string): void {
    this.messagesSent++;
    this.addTimelineEvent('message_sent', { targetNodeId });
  }

  /**
   * Records a message being received with latency.
   */
  recordMessageReceived(latencyMs: number, fromNodeId?: string): void {
    this.messagesReceived++;
    this.messageLatencies.push(latencyMs);
    this.addTimelineEvent('message_received', {
      nodeId: fromNodeId,
      data: { latencyMs },
    });
  }

  /**
   * Records a dropped/failed message.
   */
  recordMessageDropped(targetNodeId?: string, reason?: string): void {
    this.messagesDropped++;
    this.addTimelineEvent('message_dropped', {
      targetNodeId,
      data: { reason },
    });
  }

  /**
   * Records a batch of transport metrics.
   */
  recordTransportBatch(
    sent: number,
    received: number,
    dropped: number,
    latencies: readonly number[],
  ): void {
    this.messagesSent += sent;
    this.messagesReceived += received;
    this.messagesDropped += dropped;
    this.messageLatencies.push(...latencies);
  }

  // ===========================================================================
  // Remote Call Event Recording
  // ===========================================================================

  /**
   * Records the start of a remote call.
   * Returns a call ID for tracking completion.
   */
  recordRemoteCallStart(targetNodeId: string): string {
    const callId = `call_${Date.now()}_${this.totalCalls}`;

    this.totalCalls++;
    this.pendingCalls.set(callId, {
      callId,
      targetNodeId,
      startTime: Date.now(),
    });

    // Update peak pending queue size
    if (this.pendingCalls.size > this.pendingQueuePeak) {
      this.pendingQueuePeak = this.pendingCalls.size;
    }

    this.addTimelineEvent('remote_call_started', {
      targetNodeId,
      data: { callId },
    });

    return callId;
  }

  /**
   * Records successful completion of a remote call.
   */
  recordRemoteCallComplete(callId: string): void {
    const pending = this.pendingCalls.get(callId);
    if (pending) {
      const duration = Date.now() - pending.startTime;
      this.callDurations.push(duration);
      this.successfulCalls++;
      this.pendingCalls.delete(callId);

      this.addTimelineEvent('remote_call_completed', {
        targetNodeId: pending.targetNodeId,
        data: { callId, durationMs: duration },
      });
    }
  }

  /**
   * Records a remote call timeout.
   */
  recordRemoteCallTimeout(callId: string): void {
    const pending = this.pendingCalls.get(callId);
    if (pending) {
      const duration = Date.now() - pending.startTime;
      this.callDurations.push(duration);
      this.timeoutCalls++;
      this.pendingCalls.delete(callId);

      this.addTimelineEvent('remote_call_timeout', {
        targetNodeId: pending.targetNodeId,
        data: { callId, durationMs: duration },
      });
    }
  }

  /**
   * Records a failed remote call (non-timeout).
   */
  recordRemoteCallFailed(callId: string, error?: string): void {
    const pending = this.pendingCalls.get(callId);
    if (pending) {
      const duration = Date.now() - pending.startTime;
      this.callDurations.push(duration);
      this.failedCalls++;
      this.pendingCalls.delete(callId);

      this.addTimelineEvent('remote_call_completed', {
        targetNodeId: pending.targetNodeId,
        data: { callId, durationMs: duration, failed: true, error },
      });
    }
  }

  // ===========================================================================
  // Remote Spawn Event Recording
  // ===========================================================================

  /**
   * Records the start of a remote spawn.
   * Returns a spawn ID for tracking completion.
   */
  recordRemoteSpawnStart(targetNodeId: string): string {
    const spawnId = `spawn_${Date.now()}_${this.totalSpawns}`;

    this.totalSpawns++;
    this.pendingSpawns.set(spawnId, {
      spawnId,
      targetNodeId,
      startTime: Date.now(),
    });

    this.addTimelineEvent('remote_spawn_started', {
      targetNodeId,
      data: { spawnId },
    });

    return spawnId;
  }

  /**
   * Records successful completion of a remote spawn.
   */
  recordRemoteSpawnComplete(spawnId: string, processId?: string): void {
    const pending = this.pendingSpawns.get(spawnId);
    if (pending) {
      const spawnTime = Date.now() - pending.startTime;
      this.spawnTimes.push(spawnTime);
      this.successfulSpawns++;
      this.pendingSpawns.delete(spawnId);

      this.addTimelineEvent('remote_spawn_completed', {
        targetNodeId: pending.targetNodeId,
        data: { spawnId, spawnTimeMs: spawnTime, processId },
      });
    }
  }

  /**
   * Records a failed remote spawn.
   */
  recordRemoteSpawnFailed(spawnId: string, error?: string): void {
    const pending = this.pendingSpawns.get(spawnId);
    if (pending) {
      const spawnTime = Date.now() - pending.startTime;
      this.spawnTimes.push(spawnTime);
      this.failedSpawns++;
      this.pendingSpawns.delete(spawnId);

      this.addTimelineEvent('remote_spawn_failed', {
        targetNodeId: pending.targetNodeId,
        data: { spawnId, spawnTimeMs: spawnTime, error },
      });
    }
  }

  // ===========================================================================
  // Registry Event Recording
  // ===========================================================================

  /**
   * Records a registry registration attempt.
   */
  recordRegistration(name: string, success: boolean, nodeId?: string): void {
    this.totalRegistrations++;
    if (success) {
      this.successfulRegistrations++;
    }

    this.addTimelineEvent('registry_registration', {
      nodeId,
      data: { name, success },
    });
  }

  /**
   * Records a registry conflict resolution.
   */
  recordRegistryConflict(name: string, winnerNodeId: string, loserNodeId: string): void {
    this.conflictsResolved++;
    this.addTimelineEvent('registry_conflict', {
      data: { name, winnerNodeId, loserNodeId },
    });
  }

  /**
   * Records a registry sync operation.
   */
  recordRegistrySync(durationMs: number, nodeId?: string): void {
    this.syncOperations++;
    this.syncDurations.push(durationMs);
    this.addTimelineEvent('registry_sync', {
      nodeId,
      data: { durationMs },
    });
  }

  // ===========================================================================
  // Supervisor Event Recording
  // ===========================================================================

  /**
   * Records a child migration between nodes.
   */
  recordMigration(childId: string, fromNodeId: string, toNodeId: string, durationMs: number): void {
    this.migrations++;
    this.migrationTimes.push(durationMs);
    this.addTimelineEvent('supervisor_migration', {
      nodeId: fromNodeId,
      targetNodeId: toNodeId,
      data: { childId, durationMs },
    });
  }

  /**
   * Records a failover event.
   */
  recordFailover(supervisorId: string, failedNodeId: string, durationMs: number): void {
    this.failovers++;
    this.failoverTimes.push(durationMs);
    this.addTimelineEvent('supervisor_failover', {
      nodeId: failedNodeId,
      data: { supervisorId, durationMs },
    });
  }

  /**
   * Records a supervisor restart on a specific node.
   */
  recordSupervisorRestart(nodeId: string, childId?: string): void {
    const current = this.restartsByNode.get(nodeId) ?? 0;
    this.restartsByNode.set(nodeId, current + 1);
    this.addTimelineEvent('supervisor_restart', {
      nodeId,
      data: { childId },
    });
  }

  // ===========================================================================
  // Custom Metrics
  // ===========================================================================

  /**
   * Sets a custom metric value.
   */
  setCustomMetric(key: string, value: unknown): void {
    this.customMetrics[key] = value;
  }

  /**
   * Adds a custom timeline event.
   */
  addCustomEvent(name: string, data?: Record<string, unknown>): void {
    this.addTimelineEvent('custom', { data: { name, ...data } });
  }

  // ===========================================================================
  // Memory Tracking
  // ===========================================================================

  /**
   * Takes a memory snapshot.
   */
  takeMemorySnapshot(): void {
    const mem = process.memoryUsage();
    const snapshot: MemorySnapshot = {
      timestamp: Date.now(),
      elapsedMs: this.getElapsed(),
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      rss: mem.rss,
    };
    this.memorySnapshots.push(snapshot);
    this.addTimelineEvent('memory_snapshot', {
      data: {
        heapUsed: snapshot.heapUsed,
        heapTotal: snapshot.heapTotal,
      },
    });
  }

  // ===========================================================================
  // Metrics Retrieval
  // ===========================================================================

  /**
   * Gets complete distributed metrics report.
   */
  getDistributedMetrics(): DistributedStressMetrics {
    const duration = (this.endTime || Date.now()) - this.startTime;

    return {
      // Base StressTestMetrics
      startTime: this.startTime,
      endTime: this.endTime || Date.now(),
      durationMs: duration,
      restarts: this.calculateRestartStats(),
      messages: this.calculateMessageStats(duration),
      memory: this.calculateMemoryStats(),
      timeline: [],
      custom: { ...this.customMetrics },

      // Distributed metrics
      cluster: this.calculateClusterMetrics(),
      transport: this.calculateTransportMetrics(),
      remoteCall: this.calculateRemoteCallMetrics(),
      remoteSpawn: this.calculateRemoteSpawnMetrics(),
      registry: this.calculateRegistryMetrics(),
      supervisor: this.calculateSupervisorMetrics(),
      distributedTimeline: [...this.timeline],
    };
  }

  /**
   * Gets a summary suitable for logging.
   */
  getSummary(): string {
    const m = this.getDistributedMetrics();
    const lines = [
      `=== Distributed Stress Test Metrics ===`,
      `Duration: ${m.durationMs}ms`,
      ``,
      `Cluster:`,
      `  Node Up Events: ${m.cluster.nodeUpEvents}`,
      `  Node Down Events: ${m.cluster.nodeDownEvents}`,
      `  Reconnections: ${m.cluster.reconnections}`,
      `  Avg Reconnection: ${m.cluster.avgReconnectionTimeMs.toFixed(1)}ms`,
      ``,
      `Transport:`,
      `  Sent: ${m.transport.messagesSent}`,
      `  Received: ${m.transport.messagesReceived}`,
      `  Dropped: ${m.transport.messagesDropped}`,
      `  Delivery Rate: ${(m.transport.deliveryRate * 100).toFixed(1)}%`,
      `  P99 Latency: ${m.transport.p99LatencyMs.toFixed(1)}ms`,
      ``,
      `Remote Calls:`,
      `  Total: ${m.remoteCall.totalCalls}`,
      `  Success Rate: ${(m.remoteCall.successRate * 100).toFixed(1)}%`,
      `  Timeouts: ${m.remoteCall.timeoutCalls}`,
      `  P99 Duration: ${m.remoteCall.p99CallDurationMs.toFixed(1)}ms`,
      `  Pending Queue Peak: ${m.remoteCall.pendingQueuePeak}`,
      ``,
      `Remote Spawns:`,
      `  Total: ${m.remoteSpawn.totalSpawns}`,
      `  Success Rate: ${(m.remoteSpawn.successRate * 100).toFixed(1)}%`,
      `  Avg Time: ${m.remoteSpawn.avgSpawnTimeMs.toFixed(1)}ms`,
      ``,
      `Registry:`,
      `  Registrations: ${m.registry.totalRegistrations}`,
      `  Conflicts: ${m.registry.conflictsResolved}`,
      `  Sync Ops: ${m.registry.syncOperations}`,
      ``,
      `Supervisor:`,
      `  Migrations: ${m.supervisor.migrations}`,
      `  Failovers: ${m.supervisor.failovers}`,
      `  Total Restarts: ${m.supervisor.totalRestarts}`,
      ``,
      `Memory:`,
      `  Initial Heap: ${formatBytes(m.memory.initial.heapUsed)}`,
      `  Final Heap: ${formatBytes(m.memory.final.heapUsed)}`,
      `  Peak Heap: ${formatBytes(m.memory.peakHeapUsed)}`,
      `  Growth: ${m.memory.heapGrowthPercent.toFixed(1)}%`,
    ];
    return lines.join('\n');
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private getElapsed(): number {
    return Date.now() - this.startTime;
  }

  private addTimelineEvent(
    type: DistributedTimelineEventType,
    options: {
      nodeId?: string;
      targetNodeId?: string;
      data?: Record<string, unknown>;
    } = {},
  ): void {
    this.timeline.push({
      type,
      timestamp: Date.now(),
      elapsedMs: this.getElapsed(),
      nodeId: options.nodeId,
      targetNodeId: options.targetNodeId,
      data: options.data,
    });
  }

  private subscribeToClusterEvents(cluster: TestCluster): void {
    const nodeUpHandler = (nodeId: string, fromNodeId: string) => {
      this.recordNodeUp(nodeId, fromNodeId);
    };

    const nodeDownHandler = (nodeId: string, reason: string, fromNodeId: string) => {
      this.recordNodeDown(nodeId, reason, fromNodeId);
    };

    cluster.on('nodeUp', nodeUpHandler);
    cluster.on('nodeDown', nodeDownHandler);

    this.clusterUnsubscribers.push(
      () => cluster.off('nodeUp', nodeUpHandler),
      () => cluster.off('nodeDown', nodeDownHandler),
    );
  }

  private calculateClusterMetrics(): ClusterMetrics {
    const sortedReconnections = sortedCopy(this.reconnectionTimes);

    return {
      nodeUpEvents: this.nodeUpCount,
      nodeDownEvents: this.nodeDownCount,
      reconnections: this.reconnectionTimes.length,
      avgReconnectionTimeMs: average(this.reconnectionTimes),
      minReconnectionTimeMs: sortedReconnections[0] ?? 0,
      maxReconnectionTimeMs: sortedReconnections[sortedReconnections.length - 1] ?? 0,
      p95ReconnectionTimeMs: percentile(sortedReconnections, 95),
      reconnectionTimes: sortedReconnections,
    };
  }

  private calculateTransportMetrics(): TransportMetrics {
    const sortedLatencies = sortedCopy(this.messageLatencies);
    const totalAttempts = this.messagesSent;
    const deliveryRate = totalAttempts > 0
      ? this.messagesReceived / totalAttempts
      : 1;

    return {
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
      messagesDropped: this.messagesDropped,
      deliveryRate,
      avgLatencyMs: average(this.messageLatencies),
      minLatencyMs: sortedLatencies[0] ?? 0,
      maxLatencyMs: sortedLatencies[sortedLatencies.length - 1] ?? 0,
      p95LatencyMs: percentile(sortedLatencies, 95),
      p99LatencyMs: percentile(sortedLatencies, 99),
      latencies: sortedLatencies,
    };
  }

  private calculateRemoteCallMetrics(): RemoteCallMetrics {
    const sortedDurations = sortedCopy(this.callDurations);
    const successRate = this.totalCalls > 0
      ? this.successfulCalls / this.totalCalls
      : 1;

    return {
      totalCalls: this.totalCalls,
      successfulCalls: this.successfulCalls,
      timeoutCalls: this.timeoutCalls,
      failedCalls: this.failedCalls,
      successRate,
      pendingQueuePeak: this.pendingQueuePeak,
      avgCallDurationMs: average(this.callDurations),
      p95CallDurationMs: percentile(sortedDurations, 95),
      p99CallDurationMs: percentile(sortedDurations, 99),
      callDurations: sortedDurations,
    };
  }

  private calculateRemoteSpawnMetrics(): RemoteSpawnMetrics {
    const sortedTimes = sortedCopy(this.spawnTimes);
    const successRate = this.totalSpawns > 0
      ? this.successfulSpawns / this.totalSpawns
      : 1;

    return {
      totalSpawns: this.totalSpawns,
      successfulSpawns: this.successfulSpawns,
      failedSpawns: this.failedSpawns,
      successRate,
      avgSpawnTimeMs: average(this.spawnTimes),
      minSpawnTimeMs: sortedTimes[0] ?? 0,
      maxSpawnTimeMs: sortedTimes[sortedTimes.length - 1] ?? 0,
      p95SpawnTimeMs: percentile(sortedTimes, 95),
      spawnTimes: sortedTimes,
    };
  }

  private calculateRegistryMetrics(): RegistryMetrics {
    const successRate = this.totalRegistrations > 0
      ? this.successfulRegistrations / this.totalRegistrations
      : 1;

    return {
      totalRegistrations: this.totalRegistrations,
      successfulRegistrations: this.successfulRegistrations,
      conflictsResolved: this.conflictsResolved,
      syncOperations: this.syncOperations,
      avgSyncDurationMs: average(this.syncDurations),
      successRate,
    };
  }

  private calculateSupervisorMetrics(): SupervisorMetrics {
    const restartsByNodeObj: Record<string, number> = {};
    let totalRestarts = 0;

    for (const [nodeId, count] of this.restartsByNode) {
      restartsByNodeObj[nodeId] = count;
      totalRestarts += count;
    }

    return {
      migrations: this.migrations,
      failovers: this.failovers,
      restartsByNode: restartsByNodeObj,
      totalRestarts,
      avgMigrationTimeMs: average(this.migrationTimes),
      avgFailoverTimeMs: average(this.failoverTimes),
    };
  }

  private calculateRestartStats(): StressTestMetrics['restarts'] {
    // Use supervisor restarts for base restart stats
    const times = sortedCopy(this.migrationTimes.concat(this.failoverTimes));
    const total = this.migrations + this.failovers;

    return {
      totalRestarts: total,
      successfulRestarts: total,
      failedRestarts: 0,
      successRate: 1,
      avgRestartTimeMs: average(times),
      minRestartTimeMs: times[0] ?? 0,
      maxRestartTimeMs: times[times.length - 1] ?? 0,
      p50RestartTimeMs: percentile(times, 50),
      p95RestartTimeMs: percentile(times, 95),
      p99RestartTimeMs: percentile(times, 99),
      restartTimes: times,
    };
  }

  private calculateMessageStats(durationMs: number): StressTestMetrics['messages'] {
    const sortedLatencies = sortedCopy(this.messageLatencies);
    const durationSec = durationMs / 1000;

    return {
      messagesSent: this.messagesSent,
      messagesProcessed: this.messagesReceived,
      messagesFailed: this.messagesDropped,
      throughputPerSec: durationSec > 0 ? this.messagesReceived / durationSec : 0,
      avgLatencyMs: average(this.messageLatencies),
      minLatencyMs: sortedLatencies[0] ?? 0,
      maxLatencyMs: sortedLatencies[sortedLatencies.length - 1] ?? 0,
      p95LatencyMs: percentile(sortedLatencies, 95),
      p99LatencyMs: percentile(sortedLatencies, 99),
    };
  }

  private calculateMemoryStats(): StressTestMetrics['memory'] {
    const initial = this.memorySnapshots[0] ?? createEmptyMemorySnapshot();
    const final = this.memorySnapshots[this.memorySnapshots.length - 1] ?? createEmptyMemorySnapshot();
    const peakHeapUsed = this.memorySnapshots.length > 0
      ? Math.max(...this.memorySnapshots.map((s) => s.heapUsed))
      : 0;
    const heapGrowth = final.heapUsed - initial.heapUsed;
    const heapGrowthPercent = initial.heapUsed > 0
      ? (heapGrowth / initial.heapUsed) * 100
      : 0;

    return {
      initial,
      final,
      peakHeapUsed,
      heapGrowthBytes: heapGrowth,
      heapGrowthPercent,
      snapshots: [...this.memorySnapshots],
    };
  }
}

// =============================================================================
// Assertion Helpers
// =============================================================================

/**
 * Assertion helpers for distributed metrics validation in tests.
 */
export const DistributedMetricsAssertions = {
  /**
   * Asserts transport delivery rate meets threshold.
   */
  assertDeliveryRate(metrics: DistributedStressMetrics, minRate: number): void {
    if (metrics.transport.deliveryRate < minRate) {
      throw new Error(
        `Delivery rate ${(metrics.transport.deliveryRate * 100).toFixed(1)}% ` +
        `below threshold ${(minRate * 100).toFixed(1)}%`
      );
    }
  },

  /**
   * Asserts remote call success rate meets threshold.
   */
  assertRemoteCallSuccessRate(metrics: DistributedStressMetrics, minRate: number): void {
    if (metrics.remoteCall.successRate < minRate) {
      throw new Error(
        `Remote call success rate ${(metrics.remoteCall.successRate * 100).toFixed(1)}% ` +
        `below threshold ${(minRate * 100).toFixed(1)}%`
      );
    }
  },

  /**
   * Asserts remote spawn success rate meets threshold.
   */
  assertRemoteSpawnSuccessRate(metrics: DistributedStressMetrics, minRate: number): void {
    if (metrics.remoteSpawn.successRate < minRate) {
      throw new Error(
        `Remote spawn success rate ${(metrics.remoteSpawn.successRate * 100).toFixed(1)}% ` +
        `below threshold ${(minRate * 100).toFixed(1)}%`
      );
    }
  },

  /**
   * Asserts P99 latency is below threshold.
   */
  assertLatencyP99Below(metrics: DistributedStressMetrics, maxMs: number): void {
    if (metrics.transport.p99LatencyMs > maxMs) {
      throw new Error(
        `P99 latency ${metrics.transport.p99LatencyMs.toFixed(1)}ms ` +
        `exceeds threshold ${maxMs}ms`
      );
    }
  },

  /**
   * Asserts reconnection time is below threshold.
   */
  assertReconnectionTimeBelow(metrics: DistributedStressMetrics, maxMs: number): void {
    if (metrics.cluster.avgReconnectionTimeMs > maxMs) {
      throw new Error(
        `Average reconnection time ${metrics.cluster.avgReconnectionTimeMs.toFixed(1)}ms ` +
        `exceeds threshold ${maxMs}ms`
      );
    }
  },

  /**
   * Asserts memory growth is below threshold.
   */
  assertMemoryGrowthBelow(metrics: DistributedStressMetrics, maxPercent: number): void {
    if (metrics.memory.heapGrowthPercent > maxPercent) {
      throw new Error(
        `Memory growth ${metrics.memory.heapGrowthPercent.toFixed(1)}% ` +
        `exceeds threshold ${maxPercent}%`
      );
    }
  },

  /**
   * Asserts no message drops occurred.
   */
  assertNoMessageDrops(metrics: DistributedStressMetrics): void {
    if (metrics.transport.messagesDropped > 0) {
      throw new Error(
        `${metrics.transport.messagesDropped} messages were dropped`
      );
    }
  },

  /**
   * Asserts no remote call timeouts occurred.
   */
  assertNoCallTimeouts(metrics: DistributedStressMetrics): void {
    if (metrics.remoteCall.timeoutCalls > 0) {
      throw new Error(
        `${metrics.remoteCall.timeoutCalls} remote calls timed out`
      );
    }
  },
};

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Creates a new DistributedMetricsCollector.
 *
 * @param config - Configuration options
 * @returns New collector instance
 *
 * @example
 * ```typescript
 * const collector = createDistributedMetricsCollector({ cluster });
 * collector.start();
 * ```
 */
export function createDistributedMetricsCollector(
  config?: DistributedMetricsConfig,
): DistributedMetricsCollector {
  return new DistributedMetricsCollector(config);
}
