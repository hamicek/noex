# AlertManager API Reference

The `AlertManager` provides dynamic threshold-based alerting for process metrics. It uses statistical analysis (rolling mean + standard deviation) to automatically calculate thresholds based on historical data.

## Import

```typescript
import { AlertManager } from 'noex/observer';
```

## Overview

AlertManager monitors process metrics and triggers alerts when values exceed dynamically calculated thresholds. Key features:

- **Automatic threshold calculation**: Uses `mean + (multiplier * stddev)` formula
- **Per-process statistics tracking**: Efficient circular buffer for each process
- **Cooldown mechanism**: Prevents alert spam
- **Subscription-based events**: Real-time notifications

## Types

### AlertConfig

Configuration for the AlertManager.

```typescript
interface AlertConfig {
  /** Whether alerting is enabled */
  readonly enabled: boolean;

  /**
   * Multiplier for standard deviation in threshold calculation.
   * Higher values = less sensitive (fewer alerts).
   * @default 2.0
   */
  readonly sensitivityMultiplier: number;

  /**
   * Minimum number of samples required before alerts can fire.
   * Prevents false positives during system warmup.
   * @default 30
   */
  readonly minSamples: number;

  /**
   * Cooldown period in milliseconds between alerts for the same process.
   * Prevents alert spam.
   * @default 10000
   */
  readonly cooldownMs: number;
}
```

### Alert

An active alert indicating a process has exceeded its threshold.

```typescript
interface Alert {
  /** Unique identifier for this alert instance */
  readonly id: string;

  /** Type of condition that triggered the alert */
  readonly type: AlertType;

  /** ID of the process that triggered the alert */
  readonly processId: string;

  /** Optional registered name of the process */
  readonly processName?: string;

  /** The threshold that was exceeded */
  readonly threshold: number;

  /** The current value that exceeded the threshold */
  readonly currentValue: number;

  /** Unix timestamp when the alert was triggered */
  readonly timestamp: number;

  /** Human-readable description of the alert */
  readonly message: string;
}
```

### AlertType

Types of alerts that can be triggered.

```typescript
type AlertType = 'high_queue_size' | 'high_memory';
```

### AlertEvent

Events emitted by the AlertManager.

```typescript
type AlertEvent =
  | { readonly type: 'alert_triggered'; readonly alert: Alert }
  | { readonly type: 'alert_resolved'; readonly alertId: string; readonly processId: string };
```

### AlertEventHandler

Handler function for alert events.

```typescript
type AlertEventHandler = (event: AlertEvent) => void;
```

---

## Methods

### configure()

Updates the alert configuration.

```typescript
configure(newConfig: Partial<AlertConfig>): void
```

**Parameters:**
- `newConfig` - Partial configuration to merge with current config

**Example:**
```typescript
// Make alerts less sensitive
AlertManager.configure({
  sensitivityMultiplier: 3.0,
});

// Disable alerting
AlertManager.configure({ enabled: false });

// Reduce cooldown period
AlertManager.configure({ cooldownMs: 5000 });
```

---

### getConfig()

Returns the current alert configuration.

```typescript
getConfig(): Readonly<AlertConfig>
```

**Returns:** Current configuration (read-only)

**Example:**
```typescript
const config = AlertManager.getConfig();
console.log(`Sensitivity: ${config.sensitivityMultiplier}`);
console.log(`Min samples: ${config.minSamples}`);
```

---

### subscribe()

Subscribes to alert events.

```typescript
subscribe(handler: AlertEventHandler): () => void
```

**Parameters:**
- `handler` - Function to call for each event

**Returns:** Unsubscribe function

**Example:**
```typescript
const unsubscribe = AlertManager.subscribe((event) => {
  if (event.type === 'alert_triggered') {
    console.log(`ALERT: ${event.alert.message}`);
    sendSlackNotification(event.alert);
  } else if (event.type === 'alert_resolved') {
    console.log(`Alert resolved for ${event.processId}`);
  }
});

// Later: stop listening
unsubscribe();
```

---

### getActiveAlerts()

Returns all currently active alerts.

```typescript
getActiveAlerts(): readonly Alert[]
```

**Returns:** Array of active alerts

**Example:**
```typescript
const alerts = AlertManager.getActiveAlerts();

if (alerts.length > 0) {
  console.log(`${alerts.length} active alerts:`);
  for (const alert of alerts) {
    console.log(`  [${alert.type}] ${alert.message}`);
  }
}
```

---

### getAlertForProcess()

Returns active alert for a specific process.

```typescript
getAlertForProcess(processId: string): Alert | undefined
```

**Parameters:**
- `processId` - The process ID to check

**Returns:** Active alert or undefined

**Example:**
```typescript
const alert = AlertManager.getAlertForProcess('genserver_1_abc123');
if (alert) {
  console.log(`Process has active alert: ${alert.message}`);
}
```

---

### getThreshold()

Returns the current dynamic threshold for a process.

```typescript
getThreshold(processId: string): number
```

**Parameters:**
- `processId` - The process ID to get threshold for

**Returns:** The current threshold, or `Infinity` if insufficient samples

**Example:**
```typescript
const threshold = AlertManager.getThreshold('genserver_1_abc123');
if (threshold === Infinity) {
  console.log('Not enough samples yet');
} else {
  console.log(`Current threshold: ${threshold.toFixed(2)}`);
}
```

---

### getProcessStatistics()

Returns statistics for a process.

```typescript
getProcessStatistics(processId: string): Readonly<{
  mean: number;
  stddev: number;
  threshold: number;
  sampleCount: number;
}> | undefined
```

**Parameters:**
- `processId` - The process ID to get stats for

**Returns:** Statistics object or undefined if no data exists

**Example:**
```typescript
const stats = AlertManager.getProcessStatistics('genserver_1_abc123');
if (stats) {
  console.log(`Mean: ${stats.mean.toFixed(2)}`);
  console.log(`Stddev: ${stats.stddev.toFixed(2)}`);
  console.log(`Threshold: ${stats.threshold.toFixed(2)}`);
  console.log(`Samples: ${stats.sampleCount}`);
}
```

---

### recordQueueSize()

Records a queue size sample for a process.

```typescript
recordQueueSize(processId: string, size: number): void
```

**Parameters:**
- `processId` - The process ID to record for
- `size` - The current queue size

**Note:** Called automatically by Observer during polling.

---

### checkAlerts()

Checks all process stats and triggers/resolves alerts as needed.

```typescript
checkAlerts(serverStats: readonly GenServerStats[]): void
```

**Parameters:**
- `serverStats` - Current statistics for all servers

**Note:** Called automatically by Observer during polling.

---

### triggerAlert()

Manually triggers an alert for a process.

```typescript
triggerAlert(
  type: AlertType,
  processId: string,
  currentValue: number,
): Alert | undefined
```

**Parameters:**
- `type` - The type of alert
- `processId` - The process ID
- `currentValue` - The current metric value

**Returns:** The created alert, or undefined if cooldown is active

**Example:**
```typescript
// Trigger a custom alert
const alert = AlertManager.triggerAlert(
  'high_queue_size',
  'genserver_1_abc123',
  150,
);

if (alert) {
  console.log(`Alert triggered: ${alert.id}`);
}
```

---

### resolveAlert()

Manually resolves an alert for a process.

```typescript
resolveAlert(processId: string): boolean
```

**Parameters:**
- `processId` - The process ID to resolve alert for

**Returns:** `true` if an alert was resolved

**Example:**
```typescript
const resolved = AlertManager.resolveAlert('genserver_1_abc123');
if (resolved) {
  console.log('Alert resolved');
}
```

---

### reset()

Clears all statistics, active alerts, and resets configuration to defaults.

```typescript
reset(): void
```

**Example:**
```typescript
// Reset all alerting state
AlertManager.reset();
```

---

### removeProcess()

Removes statistics tracking for a specific process.

```typescript
removeProcess(processId: string): void
```

**Parameters:**
- `processId` - The process ID to remove

---

## Complete Example

```typescript
import { AlertManager, Observer } from 'noex/observer';
import { GenServer } from 'noex';

async function main() {
  // Configure alerting sensitivity
  AlertManager.configure({
    sensitivityMultiplier: 2.5, // Less sensitive
    minSamples: 50,             // Wait for more data
    cooldownMs: 30000,          // 30 second cooldown
  });

  // Subscribe to alerts
  const unsubscribe = AlertManager.subscribe((event) => {
    if (event.type === 'alert_triggered') {
      const { alert } = event;

      console.log('=== ALERT ===');
      console.log(`Type: ${alert.type}`);
      console.log(`Process: ${alert.processName || alert.processId}`);
      console.log(`Message: ${alert.message}`);
      console.log(`Value: ${alert.currentValue} (threshold: ${alert.threshold.toFixed(2)})`);

      // Send to external monitoring
      sendToSlack(alert);
      sendToDatadog(alert);
    } else {
      console.log(`Alert resolved for ${event.processId}`);
    }
  });

  // Start Observer polling (which triggers alert checks)
  const stopPolling = Observer.startPolling(1000, (event) => {
    if (event.type === 'stats_update') {
      const alerts = AlertManager.getActiveAlerts();
      if (alerts.length > 0) {
        console.log(`Active alerts: ${alerts.length}`);
      }
    }
  });

  // Your application logic here...
  const server = await GenServer.start({
    init: () => ({ queue: [] }),
    handleCall: (msg, state) => [state.queue.length, state],
    handleCast: (msg, state) => ({ queue: [...state.queue, msg] }),
  });

  // Cleanup on shutdown
  process.on('SIGTERM', () => {
    stopPolling();
    unsubscribe();
  });
}
```

---

## How Thresholds Work

AlertManager uses statistical analysis to calculate dynamic thresholds:

```
threshold = mean + (sensitivityMultiplier * stddev)
```

1. **Data Collection**: Each process's queue size is sampled during Observer polling
2. **Statistics Calculation**: Mean and standard deviation are computed from samples
3. **Threshold Calculation**: Threshold adapts to each process's normal behavior
4. **Alert Triggering**: When current value exceeds threshold, alert fires
5. **Alert Resolution**: When value drops below threshold, alert resolves

This approach:
- Automatically adapts to each process's normal load patterns
- Detects anomalies relative to typical behavior
- Avoids false positives during warmup (minSamples requirement)
- Prevents alert fatigue (cooldown mechanism)

---

## Related

- [Observer API](./observer.md) - System introspection
- [Dashboard API](./dashboard.md) - TUI monitoring
- [GenServer API](./genserver.md) - Process implementation
