/**
 * AlertManager - Dynamic threshold alerting for noex Observer.
 *
 * Uses statistical analysis (rolling mean + standard deviation) to automatically
 * calculate thresholds based on historical data. This approach adapts to each
 * process's normal behavior pattern rather than requiring manual threshold configuration.
 *
 * Key features:
 * - Automatic threshold calculation using mean + (multiplier * stddev)
 * - Per-process statistics tracking with efficient circular buffer
 * - Cooldown mechanism to prevent alert spam
 * - Subscription-based event emission
 */

import type { GenServerStats } from '../core/types.js';
import { Registry } from '../core/registry.js';
import type { Alert, AlertConfig, AlertEvent, AlertEventHandler, AlertType } from './types.js';

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: AlertConfig = {
  enabled: true,
  sensitivityMultiplier: 2.0,
  minSamples: 30,
  cooldownMs: 10000,
};

/**
 * Maximum number of samples to keep per process.
 * Balances memory usage with statistical accuracy.
 */
const MAX_SAMPLES = 1000;

/**
 * Internal structure for tracking per-process statistics.
 */
interface ProcessStatistics {
  /** Circular buffer of queue size samples */
  readonly samples: number[];
  /** Current write position in the circular buffer */
  writeIndex: number;
  /** Number of samples collected (up to MAX_SAMPLES) */
  sampleCount: number;
  /** Cached mean value (recomputed on sample add) */
  mean: number;
  /** Cached standard deviation (recomputed on sample add) */
  stddev: number;
  /** Last computed threshold */
  threshold: number;
  /** Timestamp of last alert for this process */
  lastAlertAt: number;
}

/**
 * Internal state for the AlertManager.
 */
let config: AlertConfig = { ...DEFAULT_CONFIG };
const processStats = new Map<string, ProcessStatistics>();
const activeAlerts = new Map<string, Alert>();
const subscribers = new Set<AlertEventHandler>();
let alertIdCounter = 0;

/**
 * Creates initial statistics tracking structure for a process.
 */
function createProcessStatistics(): ProcessStatistics {
  return {
    samples: new Array<number>(MAX_SAMPLES),
    writeIndex: 0,
    sampleCount: 0,
    mean: 0,
    stddev: 0,
    threshold: Infinity,
    lastAlertAt: 0,
  };
}

/**
 * Computes mean and standard deviation from samples.
 * Uses Welford's online algorithm for numerical stability.
 */
function computeStatistics(stats: ProcessStatistics): void {
  const { samples, sampleCount } = stats;

  if (sampleCount === 0) {
    stats.mean = 0;
    stats.stddev = 0;
    stats.threshold = Infinity;
    return;
  }

  // Compute mean
  let sum = 0;
  for (let i = 0; i < sampleCount; i++) {
    sum += samples[i]!;
  }
  const mean = sum / sampleCount;

  // Compute variance using two-pass algorithm for better numerical stability
  let varianceSum = 0;
  for (let i = 0; i < sampleCount; i++) {
    const diff = samples[i]! - mean;
    varianceSum += diff * diff;
  }

  const variance = sampleCount > 1 ? varianceSum / (sampleCount - 1) : 0;
  const stddev = Math.sqrt(variance);

  stats.mean = mean;
  stats.stddev = stddev;
  stats.threshold = mean + config.sensitivityMultiplier * stddev;
}

/**
 * Adds a sample to process statistics using circular buffer.
 */
function addSample(stats: ProcessStatistics, value: number): void {
  stats.samples[stats.writeIndex] = value;
  stats.writeIndex = (stats.writeIndex + 1) % MAX_SAMPLES;
  stats.sampleCount = Math.min(stats.sampleCount + 1, MAX_SAMPLES);

  computeStatistics(stats);
}

/**
 * Generates a unique alert ID.
 */
function generateAlertId(): string {
  return `alert_${Date.now()}_${++alertIdCounter}`;
}

/**
 * Attempts to resolve the process name from Registry.
 */
function resolveProcessName(processId: string): string | undefined {
  return Registry._getNameById(processId);
}

/**
 * Emits an event to all subscribers.
 */
function emitEvent(event: AlertEvent): void {
  for (const handler of subscribers) {
    try {
      handler(event);
    } catch {
      // Subscriber errors should not affect other subscribers
    }
  }
}

/**
 * Checks if cooldown period has elapsed for a process.
 */
function isCooldownActive(stats: ProcessStatistics, now: number): boolean {
  return stats.lastAlertAt > 0 && now - stats.lastAlertAt < config.cooldownMs;
}

/**
 * Creates an alert for a process exceeding its threshold.
 */
function createAlert(
  type: AlertType,
  processId: string,
  threshold: number,
  currentValue: number,
): Alert {
  const processName = resolveProcessName(processId);

  const typeLabel = type === 'high_queue_size' ? 'Queue size' : 'Memory';
  const thresholdFormatted = threshold.toFixed(1);
  const valueFormatted = currentValue.toFixed(0);

  const baseAlert = {
    id: generateAlertId(),
    type,
    processId,
    threshold,
    currentValue,
    timestamp: Date.now(),
    message: `${typeLabel} exceeded threshold: ${valueFormatted} > ${thresholdFormatted} (process: ${processName ?? processId})`,
  };

  // Only include processName if defined (for exactOptionalPropertyTypes)
  if (processName !== undefined) {
    return { ...baseAlert, processName };
  }

  return baseAlert;
}

/**
 * AlertManager provides dynamic threshold-based alerting for process metrics.
 *
 * The manager automatically calculates thresholds based on historical data,
 * adapting to each process's normal behavior. When a metric exceeds the
 * calculated threshold (mean + multiplier * stddev), an alert is triggered.
 *
 * @example
 * ```typescript
 * import { AlertManager } from 'noex/observer';
 *
 * // Configure sensitivity
 * AlertManager.configure({ sensitivityMultiplier: 2.5 });
 *
 * // Subscribe to alert events
 * const unsubscribe = AlertManager.subscribe((event) => {
 *   if (event.type === 'alert_triggered') {
 *     console.log(`Alert: ${event.alert.message}`);
 *   }
 * });
 *
 * // The Observer automatically calls checkAlerts() during polling
 * ```
 */
export const AlertManager = {
  /**
   * Updates the alert configuration.
   *
   * Partial configuration is allowed - unspecified fields retain their current values.
   * Changes take effect immediately for subsequent alert checks.
   *
   * @param newConfig - Partial configuration to merge with current config
   */
  configure(newConfig: Partial<AlertConfig>): void {
    config = { ...config, ...newConfig };
  },

  /**
   * Returns the current alert configuration.
   *
   * @returns Current configuration (read-only)
   */
  getConfig(): Readonly<AlertConfig> {
    return config;
  },

  /**
   * Records a queue size sample for a process.
   *
   * Called automatically by Observer during polling. Each sample contributes
   * to the statistical model used for threshold calculation.
   *
   * @param processId - The process ID to record for
   * @param size - The current queue size
   */
  recordQueueSize(processId: string, size: number): void {
    let stats = processStats.get(processId);
    if (!stats) {
      stats = createProcessStatistics();
      processStats.set(processId, stats);
    }
    addSample(stats, size);
  },

  /**
   * Returns the current dynamic threshold for a process.
   *
   * The threshold is calculated as: mean + (sensitivityMultiplier * stddev)
   * Returns Infinity if insufficient samples have been collected.
   *
   * @param processId - The process ID to get threshold for
   * @returns The current threshold, or Infinity if not enough data
   */
  getThreshold(processId: string): number {
    const stats = processStats.get(processId);
    if (!stats || stats.sampleCount < config.minSamples) {
      return Infinity;
    }
    return stats.threshold;
  },

  /**
   * Returns statistics for a process.
   *
   * Useful for debugging and understanding the current statistical model.
   *
   * @param processId - The process ID to get stats for
   * @returns Statistics object or undefined if no data exists
   */
  getProcessStatistics(
    processId: string,
  ): Readonly<{ mean: number; stddev: number; threshold: number; sampleCount: number }> | undefined {
    const stats = processStats.get(processId);
    if (!stats) return undefined;

    return {
      mean: stats.mean,
      stddev: stats.stddev,
      threshold: stats.threshold,
      sampleCount: stats.sampleCount,
    };
  },

  /**
   * Returns all currently active alerts.
   *
   * An alert remains active until the monitored value drops below the threshold.
   *
   * @returns Array of active alerts
   */
  getActiveAlerts(): readonly Alert[] {
    return Array.from(activeAlerts.values());
  },

  /**
   * Returns active alert for a specific process, if any.
   *
   * @param processId - The process ID to check
   * @returns Active alert or undefined
   */
  getAlertForProcess(processId: string): Alert | undefined {
    return activeAlerts.get(processId);
  },

  /**
   * Subscribes to alert events.
   *
   * Events are emitted when:
   * - An alert is triggered (value exceeds threshold)
   * - An alert is resolved (value drops below threshold)
   *
   * @param handler - Function to call for each event
   * @returns Unsubscribe function
   */
  subscribe(handler: AlertEventHandler): () => void {
    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
    };
  },

  /**
   * Checks all process stats and triggers/resolves alerts as needed.
   *
   * Called automatically by Observer during polling. Should not typically
   * be called directly unless implementing custom polling logic.
   *
   * @param serverStats - Current statistics for all servers
   */
  checkAlerts(serverStats: readonly GenServerStats[]): void {
    if (!config.enabled) return;

    const now = Date.now();
    const currentProcessIds = new Set<string>();

    for (const server of serverStats) {
      const { id: processId, queueSize } = server;
      currentProcessIds.add(processId);

      // Record the sample for threshold calculation
      this.recordQueueSize(processId, queueSize);

      const stats = processStats.get(processId);
      if (!stats || stats.sampleCount < config.minSamples) {
        continue; // Not enough data yet
      }

      const threshold = stats.threshold;
      const hasActiveAlert = activeAlerts.has(processId);

      if (queueSize > threshold) {
        // Value exceeds threshold
        if (!hasActiveAlert && !isCooldownActive(stats, now)) {
          // Trigger new alert
          const alert = createAlert('high_queue_size', processId, threshold, queueSize);
          activeAlerts.set(processId, alert);
          stats.lastAlertAt = now;
          emitEvent({ type: 'alert_triggered', alert });
        }
      } else if (hasActiveAlert) {
        // Value back below threshold - resolve alert
        const alert = activeAlerts.get(processId)!;
        activeAlerts.delete(processId);
        emitEvent({ type: 'alert_resolved', alertId: alert.id, processId });
      }
    }

    // Clean up alerts for processes that no longer exist
    for (const [processId, alert] of activeAlerts) {
      if (!currentProcessIds.has(processId)) {
        activeAlerts.delete(processId);
        emitEvent({ type: 'alert_resolved', alertId: alert.id, processId });
      }
    }
  },

  /**
   * Manually triggers an alert for a process.
   *
   * Useful for testing or for triggering alerts based on custom conditions.
   * Respects cooldown settings.
   *
   * @param type - The type of alert
   * @param processId - The process ID
   * @param currentValue - The current metric value
   * @returns The created alert, or undefined if cooldown is active
   */
  triggerAlert(type: AlertType, processId: string, currentValue: number): Alert | undefined {
    if (!config.enabled) return undefined;

    const stats = processStats.get(processId) ?? createProcessStatistics();
    if (!processStats.has(processId)) {
      processStats.set(processId, stats);
    }

    const now = Date.now();
    if (isCooldownActive(stats, now)) {
      return undefined;
    }

    const threshold = stats.sampleCount >= config.minSamples ? stats.threshold : currentValue;
    const alert = createAlert(type, processId, threshold, currentValue);
    activeAlerts.set(processId, alert);
    stats.lastAlertAt = now;
    emitEvent({ type: 'alert_triggered', alert });

    return alert;
  },

  /**
   * Manually resolves an alert for a process.
   *
   * @param processId - The process ID to resolve alert for
   * @returns true if an alert was resolved, false if none existed
   */
  resolveAlert(processId: string): boolean {
    const alert = activeAlerts.get(processId);
    if (!alert) return false;

    activeAlerts.delete(processId);
    emitEvent({ type: 'alert_resolved', alertId: alert.id, processId });
    return true;
  },

  /**
   * Clears all statistics and active alerts, and resets configuration to defaults.
   *
   * Useful for testing or when resetting the monitoring state.
   */
  reset(): void {
    processStats.clear();
    activeAlerts.clear();
    alertIdCounter = 0;
    config = { ...DEFAULT_CONFIG };
  },

  /**
   * Removes statistics tracking for a specific process.
   *
   * Called automatically when a process terminates.
   *
   * @param processId - The process ID to remove
   */
  removeProcess(processId: string): void {
    processStats.delete(processId);
    const alert = activeAlerts.get(processId);
    if (alert) {
      activeAlerts.delete(processId);
      emitEvent({ type: 'alert_resolved', alertId: alert.id, processId });
    }
  },

  /**
   * Clears all subscribers.
   *
   * @internal
   */
  _clearSubscribers(): void {
    subscribers.clear();
  },
} as const;
