# AlertManager

In the previous chapters, you learned how to inspect processes with Observer and visualize system state with Dashboard. Now it's time to explore **AlertManager** — the statistical anomaly detection system that automatically identifies processes behaving abnormally and notifies you when intervention may be needed.

## What You'll Learn

- Understand dynamic threshold calculation using statistical analysis
- Configure sensitivity, minimum samples, and cooldown periods
- Subscribe to alert events for real-time notifications
- Query and manage active alerts
- Manually trigger and resolve alerts for testing
- Integrate AlertManager with Observer for comprehensive monitoring

## Dynamic Threshold Alerting

Traditional alerting systems require you to set static thresholds: "alert if queue size > 100". The problem is that a queue of 100 might be normal for a busy worker but critical for a lightweight service. Static thresholds either miss real problems or create alert fatigue.

**AlertManager takes a different approach**: it learns what's "normal" for each process by collecting samples over time, then calculates dynamic thresholds using statistical analysis:

```
threshold = mean + (sensitivityMultiplier × standardDeviation)
```

This approach adapts to each process's unique behavior:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       DYNAMIC THRESHOLD CALCULATION                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Process A (Low Traffic)              Process B (High Traffic)              │
│  ────────────────────────             ────────────────────────              │
│  Samples: 2, 3, 2, 4, 3, 2, 3, 2      Samples: 80, 95, 85, 90, 88, 92      │
│  Mean: 2.6                            Mean: 88.3                            │
│  StdDev: 0.7                          StdDev: 5.2                           │
│  Threshold: 2.6 + (2 × 0.7) = 4.0     Threshold: 88.3 + (2 × 5.2) = 98.7   │
│                                                                             │
│  Queue = 6 → ALERT! (6 > 4.0)         Queue = 95 → OK (95 < 98.7)          │
│  Queue = 4 → OK (4 = 4.0)             Queue = 150 → ALERT! (150 > 98.7)    │
│                                                                             │
│  Same queue size, different thresholds based on normal behavior!            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Configuration

AlertManager provides sensible defaults but allows full customization:

```typescript
import { AlertManager } from '@hamicek/noex';

// View current configuration
const config = AlertManager.getConfig();
console.log(config);
// {
//   enabled: true,
//   sensitivityMultiplier: 2.0,
//   minSamples: 30,
//   cooldownMs: 10000
// }

// Update configuration (partial updates supported)
AlertManager.configure({
  sensitivityMultiplier: 2.5,  // Less sensitive (higher threshold)
  minSamples: 50,              // Need more data before alerting
  cooldownMs: 30000,           // 30 seconds between alerts
});
```

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Master switch for alerting |
| `sensitivityMultiplier` | `2.0` | How many standard deviations above mean triggers alert |
| `minSamples` | `30` | Samples needed before alerts can fire (prevents warmup false positives) |
| `cooldownMs` | `10000` | Minimum time between alerts for the same process |

### Sensitivity Guidelines

The `sensitivityMultiplier` controls how unusual a value must be to trigger an alert:

| Multiplier | Meaning | Use Case |
|------------|---------|----------|
| 1.5 | ~13% chance of false positive | High-sensitivity, critical systems |
| 2.0 | ~5% chance of false positive | Balanced default |
| 2.5 | ~1% chance of false positive | Lower noise, may miss some anomalies |
| 3.0 | ~0.3% chance of false positive | Only major anomalies |

```typescript
// High sensitivity for critical payment processor
AlertManager.configure({ sensitivityMultiplier: 1.5 });

// Low sensitivity for non-critical background workers
AlertManager.configure({ sensitivityMultiplier: 3.0 });
```

## Subscribing to Alerts

AlertManager uses a subscription model for real-time notifications:

```typescript
import { AlertManager, type AlertEvent } from '@hamicek/noex';

const unsubscribe = AlertManager.subscribe((event: AlertEvent) => {
  switch (event.type) {
    case 'alert_triggered':
      console.log(`[ALERT] ${event.alert.message}`);
      console.log(`  Process: ${event.alert.processId}`);
      console.log(`  Current value: ${event.alert.currentValue}`);
      console.log(`  Threshold: ${event.alert.threshold.toFixed(1)}`);
      // Send to PagerDuty, Slack, email, etc.
      break;

    case 'alert_resolved':
      console.log(`[RESOLVED] Process ${event.processId} back to normal`);
      // Clear the alert in your incident system
      break;
  }
});

// Later: stop receiving alerts
unsubscribe();
```

### Alert Event Types

```typescript
type AlertEvent =
  | { type: 'alert_triggered'; alert: Alert }
  | { type: 'alert_resolved'; alertId: string; processId: string };
```

### Alert Object Structure

When an alert is triggered, you receive a complete `Alert` object:

```typescript
interface Alert {
  id: string;           // Unique identifier, e.g., "alert_1706123456789_1"
  type: AlertType;      // Currently 'high_queue_size' | 'high_memory'
  processId: string;    // The affected process ID
  processName?: string; // Registry name if registered
  threshold: number;    // The calculated threshold that was exceeded
  currentValue: number; // The actual value that triggered the alert
  timestamp: number;    // Unix timestamp when alert was triggered
  message: string;      // Human-readable description
}
```

Example alert:

```typescript
{
  id: 'alert_1706123456789_42',
  type: 'high_queue_size',
  processId: 'genserver_5_abc123',
  processName: 'order_processor',
  threshold: 45.3,
  currentValue: 127,
  timestamp: 1706123456789,
  message: 'Queue size exceeded threshold: 127 > 45.3 (process: order_processor)'
}
```

## Observer Integration

AlertManager integrates seamlessly with Observer. You can subscribe through either API:

```typescript
import { Observer, AlertManager } from '@hamicek/noex';

// These are equivalent:
const unsub1 = AlertManager.subscribe(handler);
const unsub2 = Observer.subscribeToAlerts(handler);

// Get active alerts through either API:
const alerts1 = AlertManager.getActiveAlerts();
const alerts2 = Observer.getActiveAlerts();
```

When you use `Observer.startPolling()`, it automatically:
1. Collects queue size samples for each process
2. Updates the statistical model
3. Checks for threshold violations
4. Triggers or resolves alerts as needed

```typescript
// Observer polling triggers AlertManager checks automatically
const stopPolling = Observer.startPolling(1000, (event) => {
  if (event.type === 'stats_update') {
    // AlertManager.checkAlerts() was called automatically
    console.log(`Checked ${event.servers.length} servers for anomalies`);
  }
});
```

## Querying Alerts

### Get All Active Alerts

```typescript
const activeAlerts = AlertManager.getActiveAlerts();

for (const alert of activeAlerts) {
  console.log(`${alert.processName ?? alert.processId}: ${alert.message}`);
}
```

### Get Alert for Specific Process

```typescript
const alert = AlertManager.getAlertForProcess('genserver_5_abc123');

if (alert) {
  console.log(`Process has active alert: ${alert.message}`);
} else {
  console.log('Process is healthy');
}
```

### Get Process Statistics

View the statistical model for any process:

```typescript
const stats = AlertManager.getProcessStatistics('genserver_5_abc123');

if (stats) {
  console.log(`Samples collected: ${stats.sampleCount}`);
  console.log(`Mean queue size: ${stats.mean.toFixed(2)}`);
  console.log(`Standard deviation: ${stats.stddev.toFixed(2)}`);
  console.log(`Current threshold: ${stats.threshold.toFixed(2)}`);
} else {
  console.log('No statistics for this process yet');
}
```

### Get Current Threshold

```typescript
const threshold = AlertManager.getThreshold('genserver_5_abc123');

if (threshold === Infinity) {
  console.log('Insufficient samples to calculate threshold');
} else {
  console.log(`Alert will trigger if queue exceeds ${threshold.toFixed(1)}`);
}
```

## Manual Alert Control

For testing or custom alerting logic, you can manually trigger and resolve alerts:

### Trigger Alert

```typescript
// Manually trigger an alert (respects cooldown)
const alert = AlertManager.triggerAlert(
  'high_queue_size',  // alert type
  'genserver_5_abc',  // process ID
  150                 // current value
);

if (alert) {
  console.log(`Alert triggered: ${alert.id}`);
} else {
  console.log('Alert not triggered (disabled or cooldown active)');
}
```

### Resolve Alert

```typescript
// Manually resolve an alert
const wasResolved = AlertManager.resolveAlert('genserver_5_abc');

if (wasResolved) {
  console.log('Alert resolved');
} else {
  console.log('No active alert for this process');
}
```

### Reset All State

```typescript
// Clear all statistics, alerts, and reset to defaults
AlertManager.reset();
```

## Cooldown Mechanism

AlertManager includes a cooldown to prevent alert spam. After an alert triggers for a process, no new alerts fire for that process until the cooldown period expires:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           COOLDOWN BEHAVIOR                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Time: 0s        5s          10s         15s         20s                    │
│         │         │           │           │           │                     │
│         ▼         ▼           ▼           ▼           ▼                     │
│  ┌──────────┐                     ┌──────────────────────┐                  │
│  │  ALERT   │                     │     COOLDOWN         │                  │
│  │ TRIGGERS │                     │  (10s default)       │                  │
│  └────┬─────┘                     └──────────┬───────────┘                  │
│       │                                      │                              │
│       │  Value exceeds threshold             │  Value exceeds threshold     │
│       │  again at 5s                         │  again at 15s               │
│       │         │                            │         │                    │
│       │         ▼                            │         ▼                    │
│       │  ┌──────────────┐                    │  ┌──────────────┐            │
│       │  │   IGNORED    │                    │  │    ALERT     │            │
│       │  │ (in cooldown)│                    │  │   TRIGGERS   │            │
│       │  └──────────────┘                    │  └──────────────┘            │
│       │                                      │                              │
│       ▼                                      ▼                              │
│  Notification sent                     Notification sent                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

This prevents receiving hundreds of alerts when a process is consistently struggling.

## Circular Buffer for Samples

AlertManager maintains a circular buffer of up to 1000 samples per process. This provides:

- **Bounded memory usage**: Fixed maximum regardless of runtime
- **Adaptive thresholds**: Recent behavior has more influence
- **Gradual adjustment**: Thresholds change smoothly as patterns shift

```typescript
// First 1000 samples: mean calculated from all
// After 1000: oldest samples replaced, statistics recalculated

// Example: Process pattern changes from low to high traffic
for (let i = 0; i < 1000; i++) {
  AlertManager.recordQueueSize('process-1', 10);  // Low traffic
}
// Mean ≈ 10, threshold ≈ 10

for (let i = 0; i < 500; i++) {
  AlertManager.recordQueueSize('process-1', 100); // High traffic
}
// Now 500 samples of 10 + 500 samples of 100
// Mean ≈ 55, threshold adapts to new pattern
```

## Practical Example: Alert Notification Service

Here's a complete alert notification service that sends alerts to multiple channels:

```typescript
import {
  GenServer,
  AlertManager,
  Observer,
  type GenServerBehavior,
  type GenServerRef,
  type Alert,
  type AlertEvent,
} from '@hamicek/noex';

// Alert notification channels
interface NotificationChannel {
  name: string;
  send(alert: Alert): Promise<void>;
}

// Slack channel implementation
const slackChannel: NotificationChannel = {
  name: 'slack',
  async send(alert) {
    const emoji = alert.type === 'high_queue_size' ? ':warning:' : ':fire:';
    console.log(`[Slack] ${emoji} ${alert.message}`);
    // In production: await fetch(slackWebhookUrl, { method: 'POST', body: JSON.stringify({...}) })
  },
};

// PagerDuty channel implementation
const pagerDutyChannel: NotificationChannel = {
  name: 'pagerduty',
  async send(alert) {
    console.log(`[PagerDuty] Incident: ${alert.id} - ${alert.message}`);
    // In production: await pagerdutyClient.createIncident({...})
  },
};

// Alert history entry
interface AlertHistoryEntry {
  alert: Alert;
  notifiedAt: number;
  channels: string[];
  resolved: boolean;
  resolvedAt?: number;
}

// Service state
interface AlertServiceState {
  history: AlertHistoryEntry[];
  channels: NotificationChannel[];
  severityThresholds: { warning: number; critical: number };
}

type AlertServiceCall =
  | { type: 'getHistory'; limit?: number }
  | { type: 'getActiveCount' }
  | { type: 'getStats' };

type AlertServiceCast =
  | { type: 'handleAlert'; event: AlertEvent };

type AlertServiceReply =
  | { history: AlertHistoryEntry[] }
  | { activeCount: number }
  | { stats: { total: number; active: number; avgResolutionMs: number } };

const AlertServiceBehavior: GenServerBehavior<
  AlertServiceState,
  AlertServiceCall,
  AlertServiceCast,
  AlertServiceReply
> = {
  init: () => ({
    history: [],
    channels: [slackChannel, pagerDutyChannel],
    severityThresholds: {
      warning: 1.5,   // 1.5x threshold = warning
      critical: 2.0,  // 2x threshold = critical
    },
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'getHistory': {
        const limit = msg.limit ?? 100;
        const history = state.history.slice(-limit);
        return [{ history }, state];
      }

      case 'getActiveCount': {
        const activeCount = state.history.filter(h => !h.resolved).length;
        return [{ activeCount }, state];
      }

      case 'getStats': {
        const resolved = state.history.filter(h => h.resolved && h.resolvedAt);
        const avgResolutionMs = resolved.length > 0
          ? resolved.reduce((sum, h) => sum + (h.resolvedAt! - h.notifiedAt), 0) / resolved.length
          : 0;

        return [{
          stats: {
            total: state.history.length,
            active: state.history.filter(h => !h.resolved).length,
            avgResolutionMs,
          },
        }, state];
      }
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'handleAlert') {
      const { event } = msg;

      if (event.type === 'alert_triggered') {
        const { alert } = event;

        // Determine severity
        const ratio = alert.currentValue / alert.threshold;
        const severity = ratio >= state.severityThresholds.critical
          ? 'CRITICAL'
          : ratio >= state.severityThresholds.warning
            ? 'WARNING'
            : 'INFO';

        // Select channels based on severity
        const channelsToNotify = severity === 'CRITICAL'
          ? state.channels
          : state.channels.filter(c => c.name === 'slack');

        // Send notifications (fire and forget)
        for (const channel of channelsToNotify) {
          channel.send(alert).catch(err => {
            console.error(`Failed to send to ${channel.name}:`, err);
          });
        }

        // Record in history
        const entry: AlertHistoryEntry = {
          alert,
          notifiedAt: Date.now(),
          channels: channelsToNotify.map(c => c.name),
          resolved: false,
        };

        return {
          ...state,
          history: [...state.history.slice(-999), entry], // Keep last 1000
        };
      }

      if (event.type === 'alert_resolved') {
        // Find and mark as resolved
        const history = state.history.map(entry =>
          entry.alert.id === event.alertId
            ? { ...entry, resolved: true, resolvedAt: Date.now() }
            : entry
        );

        return { ...state, history };
      }
    }

    return state;
  },
};

// Start the alert service
async function startAlertService(): Promise<{
  service: GenServerRef;
  stopPolling: () => void;
  cleanup: () => void;
}> {
  // Configure AlertManager
  AlertManager.configure({
    sensitivityMultiplier: 2.0,
    minSamples: 20,
    cooldownMs: 60000,  // 1 minute cooldown
  });

  // Start the service
  const service = await GenServer.start(AlertServiceBehavior, {
    name: 'alert_service',
  });

  // Subscribe to alerts and forward to service
  const unsubscribe = AlertManager.subscribe((event) => {
    GenServer.cast(service, { type: 'handleAlert', event });
  });

  // Start Observer polling (triggers AlertManager checks)
  const stopPolling = Observer.startPolling(1000, () => {});

  return {
    service,
    stopPolling,
    cleanup: () => {
      unsubscribe();
      stopPolling();
    },
  };
}

// Usage
async function main() {
  const { service, cleanup } = await startAlertService();

  // Query alert statistics
  const statsResult = await GenServer.call(service, { type: 'getStats' });
  if ('stats' in statsResult) {
    console.log(`Total alerts: ${statsResult.stats.total}`);
    console.log(`Active alerts: ${statsResult.stats.active}`);
    console.log(`Avg resolution: ${Math.round(statsResult.stats.avgResolutionMs / 1000)}s`);
  }

  // Get recent history
  const historyResult = await GenServer.call(service, { type: 'getHistory', limit: 10 });
  if ('history' in historyResult) {
    for (const entry of historyResult.history) {
      const status = entry.resolved ? 'RESOLVED' : 'ACTIVE';
      console.log(`[${status}] ${entry.alert.message}`);
    }
  }

  // Cleanup on shutdown
  cleanup();
  await GenServer.stop(service);
}
```

## Exercise: Custom Alert Rules

Build an alert system that supports custom rules beyond queue size.

**Requirements:**

1. Define custom alert rules with conditions and thresholds
2. Evaluate rules against process statistics
3. Support multiple rule types (queue_size, message_rate, memory)
4. Allow per-process rule overrides
5. Track rule violations over time

**Starter code:**

```typescript
import {
  GenServer,
  Observer,
  AlertManager,
  type GenServerBehavior,
  type GenServerStats,
} from '@hamicek/noex';

// Alert rule definition
interface AlertRule {
  id: string;
  name: string;
  metric: 'queue_size' | 'message_rate' | 'memory';
  condition: 'greater_than' | 'less_than';
  threshold: number;
  processPattern?: RegExp;  // If set, only applies to matching processes
}

interface RuleViolation {
  rule: AlertRule;
  processId: string;
  value: number;
  timestamp: number;
}

interface RuleEngineState {
  rules: AlertRule[];
  violations: Map<string, RuleViolation>;  // key: rule.id + processId
  messageRates: Map<string, number>;       // Track message rates
  lastMessageCounts: Map<string, number>;  // Previous message counts
  lastCheckTime: number;
}

// TODO: Implement the rule engine behavior
const RuleEngineBehavior: GenServerBehavior<
  RuleEngineState,
  // ... define call/cast/reply types
> = {
  // ...
};

// TODO: Implement rule evaluation
function evaluateRules(
  rules: AlertRule[],
  servers: readonly GenServerStats[],
  messageRates: Map<string, number>
): RuleViolation[] {
  // ...
}

// TODO: Start the rule engine with Observer integration
async function startRuleEngine() {
  // ...
}
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
import {
  GenServer,
  Observer,
  AlertManager,
  type GenServerBehavior,
  type GenServerRef,
  type GenServerStats,
} from '@hamicek/noex';

// Alert rule definition
interface AlertRule {
  id: string;
  name: string;
  metric: 'queue_size' | 'message_rate' | 'memory';
  condition: 'greater_than' | 'less_than';
  threshold: number;
  processPattern?: RegExp;
  enabled: boolean;
}

interface RuleViolation {
  rule: AlertRule;
  processId: string;
  processName?: string;
  value: number;
  timestamp: number;
}

interface RuleEngineState {
  rules: AlertRule[];
  violations: Map<string, RuleViolation>;
  messageRates: Map<string, number>;
  lastMessageCounts: Map<string, number>;
  lastCheckTime: number;
}

type RuleEngineCall =
  | { type: 'addRule'; rule: Omit<AlertRule, 'enabled'> }
  | { type: 'removeRule'; ruleId: string }
  | { type: 'enableRule'; ruleId: string; enabled: boolean }
  | { type: 'getRules' }
  | { type: 'getViolations' }
  | { type: 'getViolationsForProcess'; processId: string };

type RuleEngineCast =
  | { type: 'evaluate'; servers: readonly GenServerStats[] };

type RuleEngineReply =
  | { success: boolean; ruleId?: string }
  | { rules: AlertRule[] }
  | { violations: RuleViolation[] };

function evaluateRules(
  rules: AlertRule[],
  servers: readonly GenServerStats[],
  messageRates: Map<string, number>,
): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const now = Date.now();

  for (const server of servers) {
    for (const rule of rules) {
      if (!rule.enabled) continue;

      // Check if rule applies to this process
      if (rule.processPattern && !rule.processPattern.test(server.id)) {
        continue;
      }

      // Get the metric value
      let value: number | undefined;

      switch (rule.metric) {
        case 'queue_size':
          value = server.queueSize;
          break;

        case 'message_rate':
          value = messageRates.get(server.id);
          break;

        case 'memory':
          value = server.stateMemoryBytes;
          break;
      }

      if (value === undefined) continue;

      // Evaluate condition
      let violated = false;

      switch (rule.condition) {
        case 'greater_than':
          violated = value > rule.threshold;
          break;

        case 'less_than':
          violated = value < rule.threshold;
          break;
      }

      if (violated) {
        violations.push({
          rule,
          processId: server.id,
          value,
          timestamp: now,
        });
      }
    }
  }

  return violations;
}

const RuleEngineBehavior: GenServerBehavior<
  RuleEngineState,
  RuleEngineCall,
  RuleEngineCast,
  RuleEngineReply
> = {
  init: () => ({
    rules: [
      // Default rules
      {
        id: 'high_queue',
        name: 'High Queue Size',
        metric: 'queue_size',
        condition: 'greater_than',
        threshold: 100,
        enabled: true,
      },
      {
        id: 'low_throughput',
        name: 'Low Throughput',
        metric: 'message_rate',
        condition: 'less_than',
        threshold: 1,
        processPattern: /worker/,
        enabled: true,
      },
    ],
    violations: new Map(),
    messageRates: new Map(),
    lastMessageCounts: new Map(),
    lastCheckTime: Date.now(),
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'addRule': {
        const newRule: AlertRule = { ...msg.rule, enabled: true };
        const rules = [...state.rules, newRule];
        return [{ success: true, ruleId: newRule.id }, { ...state, rules }];
      }

      case 'removeRule': {
        const rules = state.rules.filter(r => r.id !== msg.ruleId);
        const removed = rules.length < state.rules.length;
        return [{ success: removed }, { ...state, rules }];
      }

      case 'enableRule': {
        const rules = state.rules.map(r =>
          r.id === msg.ruleId ? { ...r, enabled: msg.enabled } : r
        );
        return [{ success: true }, { ...state, rules }];
      }

      case 'getRules':
        return [{ rules: state.rules }, state];

      case 'getViolations':
        return [{ violations: Array.from(state.violations.values()) }, state];

      case 'getViolationsForProcess': {
        const violations = Array.from(state.violations.values())
          .filter(v => v.processId === msg.processId);
        return [{ violations }, state];
      }
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'evaluate') {
      const { servers } = msg;
      const now = Date.now();
      const elapsed = (now - state.lastCheckTime) / 1000;

      // Calculate message rates
      const messageRates = new Map<string, number>();
      for (const server of servers) {
        const lastCount = state.lastMessageCounts.get(server.id) ?? server.messageCount;
        const rate = elapsed > 0
          ? (server.messageCount - lastCount) / elapsed
          : 0;
        messageRates.set(server.id, rate);
      }

      // Update last message counts
      const lastMessageCounts = new Map<string, number>();
      for (const server of servers) {
        lastMessageCounts.set(server.id, server.messageCount);
      }

      // Evaluate rules
      const newViolations = evaluateRules(state.rules, servers, messageRates);

      // Update violations map
      const violations = new Map<string, RuleViolation>();

      // Add new violations
      for (const violation of newViolations) {
        const key = `${violation.rule.id}:${violation.processId}`;
        violations.set(key, violation);
      }

      // Log new violations
      for (const violation of newViolations) {
        const key = `${violation.rule.id}:${violation.processId}`;
        if (!state.violations.has(key)) {
          console.log(
            `[RULE VIOLATION] ${violation.rule.name}: ` +
            `${violation.processId} (${violation.value} ${violation.rule.condition} ${violation.rule.threshold})`
          );
        }
      }

      // Log resolved violations
      for (const [key, oldViolation] of state.violations) {
        if (!violations.has(key)) {
          console.log(
            `[RULE RESOLVED] ${oldViolation.rule.name}: ${oldViolation.processId}`
          );
        }
      }

      return {
        ...state,
        violations,
        messageRates,
        lastMessageCounts,
        lastCheckTime: now,
      };
    }

    return state;
  },
};

async function startRuleEngine(): Promise<{
  engine: GenServerRef;
  stopPolling: () => void;
}> {
  const engine = await GenServer.start(RuleEngineBehavior, {
    name: 'rule_engine',
  });

  // Start polling and evaluate rules on each update
  const stopPolling = Observer.startPolling(2000, (event) => {
    if (event.type === 'stats_update') {
      GenServer.cast(engine, { type: 'evaluate', servers: event.servers });
    }
  });

  return { engine, stopPolling };
}

// Demo usage
async function demo() {
  const { engine, stopPolling } = await startRuleEngine();

  // Add a custom rule
  await GenServer.call(engine, {
    type: 'addRule',
    rule: {
      id: 'high_memory',
      name: 'High Memory Usage',
      metric: 'memory',
      condition: 'greater_than',
      threshold: 10 * 1024 * 1024, // 10MB
    },
  });

  // Get all rules
  const rulesResult = await GenServer.call(engine, { type: 'getRules' });
  if ('rules' in rulesResult) {
    console.log('Active rules:');
    for (const rule of rulesResult.rules) {
      const status = rule.enabled ? 'ENABLED' : 'DISABLED';
      console.log(`  [${status}] ${rule.name}: ${rule.metric} ${rule.condition} ${rule.threshold}`);
    }
  }

  // Get current violations
  const violationsResult = await GenServer.call(engine, { type: 'getViolations' });
  if ('violations' in violationsResult) {
    console.log(`Current violations: ${violationsResult.violations.length}`);
    for (const v of violationsResult.violations) {
      console.log(`  ${v.rule.name} on ${v.processId}: ${v.value}`);
    }
  }

  // Cleanup
  stopPolling();
  await GenServer.stop(engine);
}
```

**Key features of the solution:**

1. **Multiple metrics**: Supports queue_size, message_rate, and memory
2. **Flexible conditions**: greater_than and less_than comparisons
3. **Process filtering**: Optional regex pattern to target specific processes
4. **Message rate calculation**: Tracks messages over time to calculate throughput
5. **Violation tracking**: Records which rules are currently violated
6. **Dynamic rule management**: Add, remove, and enable/disable rules at runtime

</details>

## Summary

**Key takeaways:**

- **AlertManager uses statistical analysis** (mean + multiplier × stddev) to calculate dynamic thresholds
- **Thresholds adapt** to each process's normal behavior pattern
- **Configuration options** control sensitivity, warmup period, and cooldown
- **Cooldown mechanism** prevents alert spam during sustained issues
- **Integration with Observer** provides automatic alerting during polling
- **Manual controls** (triggerAlert/resolveAlert) enable testing and custom logic

**AlertManager API at a glance:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ALERTMANAGER API OVERVIEW                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CONFIGURATION                                                              │
│  ─────────────────────────────────────────────────────────────────────────  │
│  configure(config)          → Update alerting configuration                 │
│  getConfig()                → Get current configuration                     │
│                                                                             │
│  SUBSCRIPTIONS                                                              │
│  ─────────────────────────────────────────────────────────────────────────  │
│  subscribe(handler)         → Receive alert events                          │
│                             → Returns unsubscribe function                  │
│                                                                             │
│  QUERIES                                                                    │
│  ─────────────────────────────────────────────────────────────────────────  │
│  getActiveAlerts()          → All currently active alerts                   │
│  getAlertForProcess(id)     → Alert for specific process                    │
│  getThreshold(id)           → Current threshold for process                 │
│  getProcessStatistics(id)   → Statistical model for process                 │
│                                                                             │
│  MANUAL CONTROL                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  triggerAlert(type, id, v)  → Manually trigger an alert                     │
│  resolveAlert(id)           → Manually resolve an alert                     │
│  reset()                    → Clear all state                               │
│                                                                             │
│  OBSERVER INTEGRATION                                                       │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Observer.subscribeToAlerts → Same as AlertManager.subscribe                │
│  Observer.getActiveAlerts   → Same as AlertManager.getActiveAlerts          │
│  Observer.startPolling      → Automatically triggers checkAlerts            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**When to use AlertManager:**

| Scenario | Approach |
|----------|----------|
| Automatic anomaly detection | Use Observer.startPolling() with AlertManager |
| Custom alert thresholds | Add custom rules on top of AlertManager |
| Testing alert handling | Use triggerAlert() and resolveAlert() |
| Multi-channel notifications | Subscribe and dispatch to Slack/PagerDuty/etc. |
| Alert history/analytics | Build a GenServer that records alert events |

**Remember:**

> AlertManager learns what's normal for each process, so you don't have to manually configure thresholds. Let the statistical model do the work while you focus on building great applications.

---

Next: [Debugging](./04-debugging.md)
