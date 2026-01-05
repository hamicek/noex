/**
 * Metrics collection utilities for stress testing.
 *
 * Provides comprehensive tracking of restart metrics, message throughput,
 * memory usage, and timeline events during stress tests.
 */

import {
  Supervisor,
  GenServer,
  type SupervisorRef,
  type GenServerRef,
  type LifecycleEvent,
} from '../../src/index.js';

/**
 * Types of events that can be recorded in the timeline.
 */
export type TimelineEventType =
  | 'crash'
  | 'restart_started'
  | 'restart_completed'
  | 'message_sent'
  | 'message_received'
  | 'memory_snapshot'
  | 'custom';

/**
 * A single event in the metrics timeline.
 */
export interface TimelineEvent {
  /** Type of event. */
  readonly type: TimelineEventType;
  /** Unix timestamp in milliseconds. */
  readonly timestamp: number;
  /** Elapsed time from metrics collection start. */
  readonly elapsedMs: number;
  /** ID of affected child (if applicable). */
  readonly childId?: string;
  /** GenServerRef ID (if applicable). */
  readonly refId?: string;
  /** Additional event-specific data. */
  readonly data?: Record<string, unknown>;
}

/**
 * Memory snapshot at a point in time.
 */
export interface MemorySnapshot {
  /** Unix timestamp in milliseconds. */
  readonly timestamp: number;
  /** Elapsed time from metrics collection start. */
  readonly elapsedMs: number;
  /** V8 heap memory in use (bytes). */
  readonly heapUsed: number;
  /** Total V8 heap allocated (bytes). */
  readonly heapTotal: number;
  /** External memory (bytes). */
  readonly external: number;
  /** Resident Set Size (bytes). */
  readonly rss: number;
}

/**
 * Statistics for restart operations.
 */
export interface RestartStats {
  /** Total number of restarts. */
  readonly totalRestarts: number;
  /** Number of successful restarts. */
  readonly successfulRestarts: number;
  /** Number of failed restarts. */
  readonly failedRestarts: number;
  /** Success rate as a decimal (0-1). */
  readonly successRate: number;
  /** Average restart time in milliseconds. */
  readonly avgRestartTimeMs: number;
  /** Minimum restart time in milliseconds. */
  readonly minRestartTimeMs: number;
  /** Maximum restart time in milliseconds. */
  readonly maxRestartTimeMs: number;
  /** 50th percentile (median) restart time. */
  readonly p50RestartTimeMs: number;
  /** 95th percentile restart time. */
  readonly p95RestartTimeMs: number;
  /** 99th percentile restart time. */
  readonly p99RestartTimeMs: number;
  /** All individual restart times in milliseconds. */
  readonly restartTimes: readonly number[];
}

/**
 * Statistics for message operations.
 */
export interface MessageStats {
  /** Total messages sent. */
  readonly messagesSent: number;
  /** Total messages successfully processed. */
  readonly messagesProcessed: number;
  /** Messages that failed or timed out. */
  readonly messagesFailed: number;
  /** Messages per second (throughput). */
  readonly throughputPerSec: number;
  /** Average message latency in milliseconds. */
  readonly avgLatencyMs: number;
  /** Minimum latency in milliseconds. */
  readonly minLatencyMs: number;
  /** Maximum latency in milliseconds. */
  readonly maxLatencyMs: number;
  /** 95th percentile latency. */
  readonly p95LatencyMs: number;
  /** 99th percentile latency. */
  readonly p99LatencyMs: number;
}

/**
 * Complete metrics report from a stress test.
 */
export interface StressTestMetrics {
  /** Test start timestamp. */
  readonly startTime: number;
  /** Test end timestamp. */
  readonly endTime: number;
  /** Total test duration in milliseconds. */
  readonly durationMs: number;
  /** Restart statistics. */
  readonly restarts: RestartStats;
  /** Message statistics. */
  readonly messages: MessageStats;
  /** Memory statistics. */
  readonly memory: {
    /** Initial memory snapshot. */
    readonly initial: MemorySnapshot;
    /** Final memory snapshot. */
    readonly final: MemorySnapshot;
    /** Peak heap usage in bytes. */
    readonly peakHeapUsed: number;
    /** Memory growth (final - initial heap used). */
    readonly heapGrowthBytes: number;
    /** Memory growth as percentage. */
    readonly heapGrowthPercent: number;
    /** All memory snapshots. */
    readonly snapshots: readonly MemorySnapshot[];
  };
  /** Timeline of all events. */
  readonly timeline: readonly TimelineEvent[];
  /** Custom metrics added during the test. */
  readonly custom: Record<string, unknown>;
}

/**
 * Pending restart tracking.
 */
interface PendingRestart {
  readonly childId: string;
  readonly startTime: number;
  readonly originalRefId: string;
}

/**
 * Metrics collector for stress tests.
 *
 * Tracks restarts, messages, memory usage, and provides detailed
 * statistics and timeline data for analysis.
 *
 * @example
 * ```typescript
 * const collector = new MetricsCollector();
 * collector.start();
 *
 * // Run stress test...
 *
 * collector.stop();
 * const metrics = collector.getMetrics();
 * console.log(`Restart success rate: ${metrics.restarts.successRate * 100}%`);
 * ```
 */
export class MetricsCollector {
  private startTime: number = 0;
  private endTime: number = 0;
  private running: boolean = false;

  // Timeline
  private readonly timeline: TimelineEvent[] = [];

  // Restart tracking
  private readonly pendingRestarts: Map<string, PendingRestart> = new Map();
  private readonly restartTimes: number[] = [];
  private successfulRestarts: number = 0;
  private failedRestarts: number = 0;

  // Message tracking
  private messagesSent: number = 0;
  private messagesProcessed: number = 0;
  private messagesFailed: number = 0;
  private readonly messageLatencies: number[] = [];

  // Memory tracking
  private readonly memorySnapshots: MemorySnapshot[] = [];
  private memorySnapshotInterval: ReturnType<typeof setInterval> | undefined;

  // Lifecycle handler cleanup
  private unsubscribeSupervisor: (() => void) | undefined;
  private unsubscribeGenServer: (() => void) | undefined;

  // Custom metrics
  private readonly customMetrics: Record<string, unknown> = {};

  /**
   * Configuration for the metrics collector.
   */
  constructor(
    private readonly config: {
      /** Interval for memory snapshots in ms (0 to disable). */
      readonly memorySnapshotIntervalMs?: number;
      /** Supervisor ref to monitor (optional). */
      readonly supervisorRef?: SupervisorRef;
    } = {},
  ) {}

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
    const interval = this.config.memorySnapshotIntervalMs ?? 1000;
    if (interval > 0) {
      this.memorySnapshotInterval = setInterval(() => {
        this.takeMemorySnapshot();
      }, interval);
    }

    // Subscribe to lifecycle events
    this.unsubscribeSupervisor = Supervisor.onLifecycleEvent((event) => {
      this.handleLifecycleEvent(event);
    });

    this.unsubscribeGenServer = GenServer.onLifecycleEvent((event) => {
      this.handleLifecycleEvent(event);
    });
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

    // Clear interval
    if (this.memorySnapshotInterval) {
      clearInterval(this.memorySnapshotInterval);
      this.memorySnapshotInterval = undefined;
    }

    // Unsubscribe from events
    this.unsubscribeSupervisor?.();
    this.unsubscribeGenServer?.();
  }

  /**
   * Records a crash event.
   */
  recordCrash(childId: string, refId: string): void {
    this.addTimelineEvent('crash', { childId, refId });

    // Mark restart as pending
    this.pendingRestarts.set(refId, {
      childId,
      startTime: Date.now(),
      originalRefId: refId,
    });
  }

  /**
   * Records a successful restart.
   */
  recordRestartComplete(originalRefId: string, newRefId: string): void {
    const pending = this.pendingRestarts.get(originalRefId);
    if (pending) {
      const restartTime = Date.now() - pending.startTime;
      this.restartTimes.push(restartTime);
      this.successfulRestarts++;
      this.pendingRestarts.delete(originalRefId);

      this.addTimelineEvent('restart_completed', {
        childId: pending.childId,
        refId: newRefId,
        data: { restartTimeMs: restartTime, originalRefId },
      });
    }
  }

  /**
   * Records a failed restart.
   */
  recordRestartFailed(originalRefId: string, error?: Error): void {
    const pending = this.pendingRestarts.get(originalRefId);
    if (pending) {
      this.failedRestarts++;
      this.pendingRestarts.delete(originalRefId);

      this.addTimelineEvent('restart_started', {
        childId: pending.childId,
        refId: originalRefId,
        data: { failed: true, error: error?.message },
      });
    }
  }

  /**
   * Records a message being sent.
   */
  recordMessageSent(): void {
    this.messagesSent++;
    this.addTimelineEvent('message_sent');
  }

  /**
   * Records a message being successfully processed.
   */
  recordMessageProcessed(latencyMs: number): void {
    this.messagesProcessed++;
    this.messageLatencies.push(latencyMs);
    this.addTimelineEvent('message_received', {
      data: { latencyMs },
    });
  }

  /**
   * Records a message that failed.
   */
  recordMessageFailed(): void {
    this.messagesFailed++;
  }

  /**
   * Records a batch of message results.
   */
  recordMessageBatch(sent: number, processed: number, failed: number, latencies: readonly number[]): void {
    this.messagesSent += sent;
    this.messagesProcessed += processed;
    this.messagesFailed += failed;
    this.messageLatencies.push(...latencies);
  }

  /**
   * Adds a custom metric.
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

  /**
   * Gets complete metrics report.
   */
  getMetrics(): StressTestMetrics {
    const duration = (this.endTime || Date.now()) - this.startTime;

    return {
      startTime: this.startTime,
      endTime: this.endTime || Date.now(),
      durationMs: duration,
      restarts: this.calculateRestartStats(),
      messages: this.calculateMessageStats(duration),
      memory: this.calculateMemoryStats(),
      timeline: [...this.timeline],
      custom: { ...this.customMetrics },
    };
  }

  /**
   * Gets a summary suitable for logging.
   */
  getSummary(): string {
    const m = this.getMetrics();
    const lines = [
      `=== Stress Test Metrics ===`,
      `Duration: ${m.durationMs}ms`,
      ``,
      `Restarts:`,
      `  Total: ${m.restarts.totalRestarts}`,
      `  Success Rate: ${(m.restarts.successRate * 100).toFixed(1)}%`,
      `  Avg Time: ${m.restarts.avgRestartTimeMs.toFixed(1)}ms`,
      `  P95 Time: ${m.restarts.p95RestartTimeMs.toFixed(1)}ms`,
      ``,
      `Messages:`,
      `  Sent: ${m.messages.messagesSent}`,
      `  Processed: ${m.messages.messagesProcessed}`,
      `  Throughput: ${m.messages.throughputPerSec.toFixed(1)}/s`,
      `  Avg Latency: ${m.messages.avgLatencyMs.toFixed(1)}ms`,
      ``,
      `Memory:`,
      `  Initial Heap: ${formatBytes(m.memory.initial.heapUsed)}`,
      `  Final Heap: ${formatBytes(m.memory.final.heapUsed)}`,
      `  Peak Heap: ${formatBytes(m.memory.peakHeapUsed)}`,
      `  Growth: ${m.memory.heapGrowthPercent.toFixed(1)}%`,
    ];
    return lines.join('\n');
  }

  /**
   * Resets all collected metrics.
   */
  reset(): void {
    this.timeline.length = 0;
    this.pendingRestarts.clear();
    this.restartTimes.length = 0;
    this.successfulRestarts = 0;
    this.failedRestarts = 0;
    this.messagesSent = 0;
    this.messagesProcessed = 0;
    this.messagesFailed = 0;
    this.messageLatencies.length = 0;
    this.memorySnapshots.length = 0;
    Object.keys(this.customMetrics).forEach(key => delete this.customMetrics[key]);
  }

  private getElapsed(): number {
    return Date.now() - this.startTime;
  }

  private addTimelineEvent(
    type: TimelineEventType,
    options: {
      childId?: string;
      refId?: string;
      data?: Record<string, unknown>;
    } = {},
  ): void {
    this.timeline.push({
      type,
      timestamp: Date.now(),
      elapsedMs: this.getElapsed(),
      childId: options.childId,
      refId: options.refId,
      data: options.data,
    });
  }

  private handleLifecycleEvent(event: LifecycleEvent): void {
    if (event.type === 'restarted') {
      // GenServer was restarted
      this.addTimelineEvent('restart_completed', {
        refId: event.ref.id,
        data: { attempt: event.attempt },
      });
    }
  }

  private calculateRestartStats(): RestartStats {
    const total = this.successfulRestarts + this.failedRestarts;
    const times = [...this.restartTimes].sort((a, b) => a - b);

    return {
      totalRestarts: total,
      successfulRestarts: this.successfulRestarts,
      failedRestarts: this.failedRestarts,
      successRate: total > 0 ? this.successfulRestarts / total : 1,
      avgRestartTimeMs: times.length > 0
        ? times.reduce((a, b) => a + b, 0) / times.length
        : 0,
      minRestartTimeMs: times.length > 0 ? times[0]! : 0,
      maxRestartTimeMs: times.length > 0 ? times[times.length - 1]! : 0,
      p50RestartTimeMs: percentile(times, 50),
      p95RestartTimeMs: percentile(times, 95),
      p99RestartTimeMs: percentile(times, 99),
      restartTimes: times,
    };
  }

  private calculateMessageStats(durationMs: number): MessageStats {
    const latencies = [...this.messageLatencies].sort((a, b) => a - b);
    const durationSec = durationMs / 1000;

    return {
      messagesSent: this.messagesSent,
      messagesProcessed: this.messagesProcessed,
      messagesFailed: this.messagesFailed,
      throughputPerSec: durationSec > 0 ? this.messagesProcessed / durationSec : 0,
      avgLatencyMs: latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0,
      minLatencyMs: latencies.length > 0 ? latencies[0]! : 0,
      maxLatencyMs: latencies.length > 0 ? latencies[latencies.length - 1]! : 0,
      p95LatencyMs: percentile(latencies, 95),
      p99LatencyMs: percentile(latencies, 99),
    };
  }

  private calculateMemoryStats(): StressTestMetrics['memory'] {
    const initial = this.memorySnapshots[0] ?? createEmptyMemorySnapshot();
    const final = this.memorySnapshots[this.memorySnapshots.length - 1] ?? createEmptyMemorySnapshot();
    const peakHeapUsed = this.memorySnapshots.length > 0
      ? Math.max(...this.memorySnapshots.map(s => s.heapUsed))
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

/**
 * Calculates percentile from sorted array.
 */
function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))]!;
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
 * Simple collector that just tracks restart times.
 * Lighter weight alternative for simple tests.
 */
export class SimpleRestartTracker {
  private readonly crashTimes: Map<string, number> = new Map();
  private readonly restartTimes: number[] = [];

  /**
   * Records when a crash occurs.
   */
  recordCrash(refId: string): void {
    this.crashTimes.set(refId, Date.now());
  }

  /**
   * Records when a restart completes.
   */
  recordRestart(originalRefId: string): number {
    const crashTime = this.crashTimes.get(originalRefId);
    if (crashTime) {
      const restartTime = Date.now() - crashTime;
      this.restartTimes.push(restartTime);
      this.crashTimes.delete(originalRefId);
      return restartTime;
    }
    return 0;
  }

  /**
   * Gets all restart times.
   */
  getRestartTimes(): readonly number[] {
    return [...this.restartTimes];
  }

  /**
   * Gets average restart time.
   */
  getAverageRestartTime(): number {
    if (this.restartTimes.length === 0) return 0;
    return this.restartTimes.reduce((a, b) => a + b, 0) / this.restartTimes.length;
  }

  /**
   * Gets max restart time.
   */
  getMaxRestartTime(): number {
    if (this.restartTimes.length === 0) return 0;
    return Math.max(...this.restartTimes);
  }

  /**
   * Resets tracking.
   */
  reset(): void {
    this.crashTimes.clear();
    this.restartTimes.length = 0;
  }
}

/**
 * Assertion helpers for metrics validation in tests.
 */
export const MetricsAssertions = {
  /**
   * Asserts all restarts completed within timeout.
   */
  assertAllRestartsWithin(metrics: StressTestMetrics, maxMs: number): void {
    const violations = metrics.restarts.restartTimes.filter(t => t > maxMs);
    if (violations.length > 0) {
      throw new Error(
        `${violations.length} restarts exceeded ${maxMs}ms: ` +
        `max=${Math.max(...violations)}ms`
      );
    }
  },

  /**
   * Asserts restart success rate meets threshold.
   */
  assertRestartSuccessRate(metrics: StressTestMetrics, minRate: number): void {
    if (metrics.restarts.successRate < minRate) {
      throw new Error(
        `Restart success rate ${(metrics.restarts.successRate * 100).toFixed(1)}% ` +
        `below threshold ${(minRate * 100).toFixed(1)}%`
      );
    }
  },

  /**
   * Asserts memory growth is below threshold.
   */
  assertMemoryGrowthBelow(metrics: StressTestMetrics, maxPercent: number): void {
    if (metrics.memory.heapGrowthPercent > maxPercent) {
      throw new Error(
        `Memory growth ${metrics.memory.heapGrowthPercent.toFixed(1)}% ` +
        `exceeds threshold ${maxPercent}%`
      );
    }
  },

  /**
   * Asserts message throughput meets threshold.
   */
  assertThroughputAbove(metrics: StressTestMetrics, minPerSec: number): void {
    if (metrics.messages.throughputPerSec < minPerSec) {
      throw new Error(
        `Throughput ${metrics.messages.throughputPerSec.toFixed(1)}/s ` +
        `below threshold ${minPerSec}/s`
      );
    }
  },
};
