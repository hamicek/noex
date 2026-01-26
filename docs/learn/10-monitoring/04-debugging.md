# Debugging Techniques

In the previous chapters, you learned how to inspect processes with Observer, visualize system state with Dashboard, and detect anomalies with AlertManager. Now it's time to explore **practical debugging techniques** — the strategies and tools you'll use when things go wrong in your noex applications.

## What You'll Learn

- Use lifecycle events to understand process behavior
- Trace message flow between processes
- Inspect process state and diagnose issues
- Debug common problems with systematic approaches
- Build custom debugging tools for your applications

## Lifecycle Events for Debugging

Every significant event in a noex process emits a lifecycle event. These events are your primary debugging tool — they tell you exactly what's happening inside your system.

### Subscribing to Lifecycle Events

```typescript
import { GenServer, Supervisor } from '@hamicek/noex';

// Subscribe to GenServer events
const unsubGenServer = GenServer.onLifecycleEvent((event) => {
  const timestamp = new Date().toISOString();

  switch (event.type) {
    case 'started':
      console.log(`[${timestamp}] STARTED: ${event.ref.id}`);
      break;

    case 'crashed':
      console.error(`[${timestamp}] CRASHED: ${event.ref.id}`);
      console.error(`  Error: ${event.error.message}`);
      console.error(`  Stack: ${event.error.stack}`);
      break;

    case 'restarted':
      console.log(`[${timestamp}] RESTARTED: ${event.ref.id}`);
      console.log(`  Attempt: ${event.attempt}`);
      break;

    case 'terminated':
      console.log(`[${timestamp}] TERMINATED: ${event.ref.id}`);
      console.log(`  Reason: ${JSON.stringify(event.reason)}`);
      break;

    case 'state_restored':
      console.log(`[${timestamp}] STATE RESTORED: ${event.ref.id}`);
      console.log(`  Schema version: ${event.metadata.schemaVersion}`);
      console.log(`  Persisted at: ${new Date(event.metadata.persistedAt).toISOString()}`);
      break;

    case 'state_persisted':
      console.log(`[${timestamp}] STATE PERSISTED: ${event.ref.id}`);
      break;

    case 'persistence_error':
      console.error(`[${timestamp}] PERSISTENCE ERROR: ${event.ref.id}`);
      console.error(`  Error: ${event.error.message}`);
      break;

    case 'process_down':
      console.log(`[${timestamp}] PROCESS DOWN: monitored by ${event.ref.id}`);
      console.log(`  Dead process: ${event.monitoredRef.id}`);
      console.log(`  Reason: ${event.reason.type}`);
      break;
  }
});

// Subscribe to Supervisor events
const unsubSupervisor = Supervisor.onLifecycleEvent((event) => {
  const timestamp = new Date().toISOString();

  switch (event.type) {
    case 'started':
      console.log(`[${timestamp}] SUPERVISOR STARTED: ${event.ref.id}`);
      break;

    case 'terminated':
      console.log(`[${timestamp}] SUPERVISOR TERMINATED: ${event.ref.id}`);
      break;
  }
});

// Cleanup when done
unsubGenServer();
unsubSupervisor();
```

### Event Types Reference

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          LIFECYCLE EVENT TYPES                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  PROCESS LIFECYCLE                                                          │
│  ─────────────────────────────────────────────────────────────────────────  │
│  started           Process initialized and running                          │
│  crashed           Process threw an unhandled error                         │
│  restarted         Process restarted by supervisor                          │
│  terminated        Process stopped (normal, shutdown, or error)             │
│                                                                             │
│  PERSISTENCE                                                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│  state_persisted   State snapshot saved to storage                          │
│  state_restored    State recovered from storage                             │
│  persistence_error Failed to persist or restore state                       │
│                                                                             │
│  MONITORING                                                                 │
│  ─────────────────────────────────────────────────────────────────────────  │
│  process_down      A monitored process terminated                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Building a Debug Logger

Here's a reusable debug logger that captures all lifecycle events:

```typescript
import {
  GenServer,
  Supervisor,
  type LifecycleEvent,
} from '@hamicek/noex';

interface DebugLogEntry {
  timestamp: number;
  event: LifecycleEvent;
  source: 'genserver' | 'supervisor';
}

class DebugLogger {
  private logs: DebugLogEntry[] = [];
  private maxEntries: number;
  private unsubGenServer: (() => void) | null = null;
  private unsubSupervisor: (() => void) | null = null;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 10000;
  }

  start(): void {
    this.unsubGenServer = GenServer.onLifecycleEvent((event) => {
      this.record(event, 'genserver');
    });

    this.unsubSupervisor = Supervisor.onLifecycleEvent((event) => {
      this.record(event, 'supervisor');
    });

    console.log('[DebugLogger] Started capturing lifecycle events');
  }

  stop(): void {
    this.unsubGenServer?.();
    this.unsubSupervisor?.();
    this.unsubGenServer = null;
    this.unsubSupervisor = null;
    console.log('[DebugLogger] Stopped capturing lifecycle events');
  }

  private record(event: LifecycleEvent, source: 'genserver' | 'supervisor'): void {
    const entry: DebugLogEntry = {
      timestamp: Date.now(),
      event,
      source,
    };

    this.logs.push(entry);

    // Trim if exceeds max
    if (this.logs.length > this.maxEntries) {
      this.logs = this.logs.slice(-this.maxEntries);
    }

    // Print to console
    this.printEvent(entry);
  }

  private printEvent(entry: DebugLogEntry): void {
    const time = new Date(entry.timestamp).toISOString();
    const { event } = entry;

    let details = '';
    if (event.type === 'crashed') {
      details = ` - ${event.error.message}`;
    } else if (event.type === 'restarted') {
      details = ` - attempt #${event.attempt}`;
    } else if (event.type === 'terminated') {
      details = ` - ${event.reason.type}`;
    }

    const ref = 'ref' in event ? event.ref : null;
    const id = ref?.id ?? 'unknown';

    console.log(`[${time}] ${event.type.toUpperCase()} ${id}${details}`);
  }

  // Query methods
  getAll(): readonly DebugLogEntry[] {
    return this.logs;
  }

  getForProcess(processId: string): DebugLogEntry[] {
    return this.logs.filter((entry) => {
      const ref = 'ref' in entry.event ? entry.event.ref : null;
      return ref?.id === processId;
    });
  }

  getCrashes(): DebugLogEntry[] {
    return this.logs.filter((entry) => entry.event.type === 'crashed');
  }

  getRestarts(): DebugLogEntry[] {
    return this.logs.filter((entry) => entry.event.type === 'restarted');
  }

  getSince(timestamp: number): DebugLogEntry[] {
    return this.logs.filter((entry) => entry.timestamp >= timestamp);
  }

  clear(): void {
    this.logs = [];
  }

  // Analysis methods
  getRestartRate(windowMs: number = 60000): number {
    const cutoff = Date.now() - windowMs;
    const restarts = this.logs.filter(
      (entry) => entry.event.type === 'restarted' && entry.timestamp >= cutoff
    );
    return restarts.length / (windowMs / 1000); // restarts per second
  }

  getMostUnstableProcesses(limit: number = 5): { processId: string; restarts: number }[] {
    const restartCounts = new Map<string, number>();

    for (const entry of this.logs) {
      if (entry.event.type === 'restarted') {
        const id = entry.event.ref.id;
        restartCounts.set(id, (restartCounts.get(id) ?? 0) + 1);
      }
    }

    return Array.from(restartCounts.entries())
      .map(([processId, restarts]) => ({ processId, restarts }))
      .sort((a, b) => b.restarts - a.restarts)
      .slice(0, limit);
  }
}

// Usage
const debugLogger = new DebugLogger({ maxEntries: 5000 });
debugLogger.start();

// Later: analyze crashes
const crashes = debugLogger.getCrashes();
console.log(`Total crashes: ${crashes.length}`);

for (const crash of crashes.slice(-5)) {
  const event = crash.event as { type: 'crashed'; ref: { id: string }; error: Error };
  console.log(`  ${event.ref.id}: ${event.error.message}`);
}

// Find unstable processes
const unstable = debugLogger.getMostUnstableProcesses();
console.log('Most unstable processes:');
for (const { processId, restarts } of unstable) {
  console.log(`  ${processId}: ${restarts} restarts`);
}
```

## Message Tracing

Understanding message flow between processes is crucial for debugging. noex provides several approaches for tracing messages.

### Using Observer Statistics

Every GenServer tracks message statistics that you can query:

```typescript
import { Observer } from '@hamicek/noex';

// Get stats for all servers
const snapshot = Observer.getSnapshot();

for (const server of snapshot.servers) {
  console.log(`Process: ${server.id}`);
  console.log(`  Status: ${server.status}`);
  console.log(`  Queue size: ${server.queueSize}`);
  console.log(`  Messages processed: ${server.messageCount}`);
  console.log(`  Uptime: ${Math.round(server.uptimeMs / 1000)}s`);
  console.log(`  Throughput: ${(server.messageCount / (server.uptimeMs / 1000)).toFixed(2)} msg/s`);
}
```

### Building a Message Tracer

You can wrap GenServer calls to trace message flow:

```typescript
import { GenServer, type GenServerRef } from '@hamicek/noex';

interface TraceEntry {
  timestamp: number;
  direction: 'call' | 'cast' | 'reply';
  from?: string;
  to: string;
  message: unknown;
  duration?: number;
}

class MessageTracer {
  private traces: TraceEntry[] = [];
  private enabled: boolean = false;

  enable(): void {
    this.enabled = true;
    console.log('[Tracer] Message tracing enabled');
  }

  disable(): void {
    this.enabled = false;
    console.log('[Tracer] Message tracing disabled');
  }

  // Traced call - wraps GenServer.call
  async call<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
    msg: CallMsg,
    options?: { timeout?: number; from?: string }
  ): Promise<CallReply> {
    if (!this.enabled) {
      return GenServer.call(ref, msg, options);
    }

    const start = Date.now();
    const fromId = options?.from ?? 'external';

    this.record({
      timestamp: start,
      direction: 'call',
      from: fromId,
      to: ref.id,
      message: msg,
    });

    try {
      const result = await GenServer.call(ref, msg, options);

      this.record({
        timestamp: Date.now(),
        direction: 'reply',
        from: ref.id,
        to: fromId,
        message: result,
        duration: Date.now() - start,
      });

      return result;
    } catch (error) {
      this.record({
        timestamp: Date.now(),
        direction: 'reply',
        from: ref.id,
        to: fromId,
        message: { error: error instanceof Error ? error.message : String(error) },
        duration: Date.now() - start,
      });
      throw error;
    }
  }

  // Traced cast - wraps GenServer.cast
  cast<State, CallMsg, CastMsg, CallReply>(
    ref: GenServerRef<State, CallMsg, CastMsg, CallReply>,
    msg: CastMsg,
    options?: { from?: string }
  ): void {
    if (this.enabled) {
      this.record({
        timestamp: Date.now(),
        direction: 'cast',
        from: options?.from ?? 'external',
        to: ref.id,
        message: msg,
      });
    }

    GenServer.cast(ref, msg);
  }

  private record(entry: TraceEntry): void {
    this.traces.push(entry);
    this.printTrace(entry);
  }

  private printTrace(entry: TraceEntry): void {
    const time = new Date(entry.timestamp).toISOString().slice(11, 23);
    const arrow = entry.direction === 'reply' ? '<--' : '-->';
    const from = entry.from ?? '?';
    const duration = entry.duration ? ` (${entry.duration}ms)` : '';

    const msgStr = typeof entry.message === 'object'
      ? JSON.stringify(entry.message)
      : String(entry.message);
    const truncated = msgStr.length > 80 ? msgStr.slice(0, 77) + '...' : msgStr;

    console.log(`[${time}] ${entry.direction.toUpperCase()} ${from} ${arrow} ${entry.to}${duration}`);
    console.log(`         ${truncated}`);
  }

  getTraces(): readonly TraceEntry[] {
    return this.traces;
  }

  getTracesFor(processId: string): TraceEntry[] {
    return this.traces.filter(
      (t) => t.from === processId || t.to === processId
    );
  }

  clear(): void {
    this.traces = [];
  }
}

// Usage
const tracer = new MessageTracer();
tracer.enable();

// Use tracer instead of direct GenServer calls
const result = await tracer.call(myServer, { type: 'get_status' }, { from: 'main' });
tracer.cast(myServer, { type: 'increment' }, { from: 'main' });
```

### Using EventBus for System-Wide Tracing

For application-level message tracing, use EventBus with a wildcard subscription:

```typescript
import { EventBus } from '@hamicek/noex';

const bus = await EventBus.start({ name: 'message_bus' });

// Subscribe to ALL messages for tracing
await EventBus.subscribe(bus, '*', (message, topic) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [EventBus] ${topic}:`, message);
});

// Now all publishes are traced
EventBus.publish(bus, 'user.login', { userId: '123' });
EventBus.publish(bus, 'order.created', { orderId: 'ORD-456' });
```

### Message Flow Visualization

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MESSAGE FLOW DIAGRAM                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────┐       call(get_order)        ┌──────────┐                     │
│  │  Client  │ ─────────────────────────────▶│  Order   │                     │
│  │          │                               │  Server  │                     │
│  │          │◀───────────────────────────── │          │                     │
│  └──────────┘      reply({id, status})     └──────────┘                     │
│       │                                          │                          │
│       │  cast(notify_user)                       │  call(get_user)          │
│       │                                          │                          │
│       ▼                                          ▼                          │
│  ┌──────────┐                              ┌──────────┐                     │
│  │  Notif.  │                              │   User   │                     │
│  │  Service │                              │  Server  │                     │
│  └──────────┘                              └──────────┘                     │
│       │                                                                     │
│       │  publish('email.send', {...})                                       │
│       ▼                                                                     │
│  ┌──────────┐                                                               │
│  │ EventBus │───▶ email.* subscribers                                       │
│  └──────────┘                                                               │
│                                                                             │
│  LEGEND:                                                                    │
│  ──────▶  call (sync, waits for reply)                                      │
│  - - - ▶  cast (async, fire-and-forget)                                     │
│  ......▶  publish (one-to-many via EventBus)                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Process Introspection

When debugging, you often need to look inside a running process. noex provides several APIs for this.

### Observer Snapshot

Get a complete view of your system at a point in time:

```typescript
import { Observer } from '@hamicek/noex';

function printSystemSnapshot(): void {
  const snapshot = Observer.getSnapshot();

  console.log('=== System Snapshot ===');
  console.log(`Timestamp: ${new Date(snapshot.timestamp).toISOString()}`);
  console.log(`Total processes: ${snapshot.processCount}`);
  console.log(`Total messages: ${snapshot.totalMessages}`);
  console.log(`Total restarts: ${snapshot.totalRestarts}`);
  console.log();

  // Memory stats
  const mem = snapshot.memoryStats;
  const formatMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  console.log('Memory:');
  console.log(`  Heap: ${formatMB(mem.heapUsed)}MB / ${formatMB(mem.heapTotal)}MB`);
  console.log(`  RSS: ${formatMB(mem.rss)}MB`);
  console.log();

  // GenServers
  console.log('GenServers:');
  for (const server of snapshot.servers) {
    const status = server.status === 'running' ? '[OK]' : `[${server.status.toUpperCase()}]`;
    console.log(`  ${status} ${server.id}`);
    console.log(`      Queue: ${server.queueSize}, Messages: ${server.messageCount}`);
  }
  console.log();

  // Supervisors
  console.log('Supervisors:');
  for (const sup of snapshot.supervisors) {
    console.log(`  ${sup.id}`);
    console.log(`      Children: ${sup.childCount}, Restarts: ${sup.totalRestarts}`);
  }
}
```

### Process Tree Visualization

See the supervision hierarchy:

```typescript
import { Observer, type ProcessTreeNode } from '@hamicek/noex';

function printProcessTree(node: ProcessTreeNode, indent: number = 0): void {
  const prefix = '  '.repeat(indent);
  const name = node.name ?? node.id;
  const type = node.type === 'supervisor' ? '[SUP]' : '[GEN]';

  let status = '';
  if (node.type === 'genserver') {
    const stats = node.stats;
    status = ` (queue: ${stats.queueSize}, msgs: ${stats.messageCount})`;
  } else {
    const stats = node.stats;
    status = ` (children: ${stats.childCount}, restarts: ${stats.totalRestarts})`;
  }

  console.log(`${prefix}${type} ${name}${status}`);

  if (node.children) {
    for (const child of node.children) {
      printProcessTree(child, indent + 1);
    }
  }
}

// Print the tree
const tree = Observer.getProcessTree();
console.log('=== Process Tree ===');
for (const root of tree) {
  printProcessTree(root);
}
```

Example output:
```
=== Process Tree ===
[SUP] application_supervisor (children: 3, restarts: 0)
  [SUP] database_supervisor (children: 2, restarts: 1)
    [GEN] connection_pool (queue: 0, msgs: 1523)
    [GEN] query_cache (queue: 2, msgs: 892)
  [GEN] api_server (queue: 5, msgs: 4201)
  [GEN] metrics_collector (queue: 0, msgs: 156)
```

### Real-Time Process Monitoring

Watch a specific process in real-time:

```typescript
import { Observer } from '@hamicek/noex';

function watchProcess(processId: string, intervalMs: number = 1000): () => void {
  let lastMessageCount = 0;
  let lastCheck = Date.now();

  const interval = setInterval(() => {
    const servers = Observer.getServerStats();
    const server = servers.find((s) => s.id === processId);

    if (!server) {
      console.log(`Process ${processId} not found`);
      return;
    }

    const now = Date.now();
    const elapsed = (now - lastCheck) / 1000;
    const messagesDelta = server.messageCount - lastMessageCount;
    const throughput = messagesDelta / elapsed;

    console.clear();
    console.log(`=== Watching: ${processId} ===`);
    console.log(`Status: ${server.status}`);
    console.log(`Queue size: ${server.queueSize}`);
    console.log(`Total messages: ${server.messageCount}`);
    console.log(`Throughput: ${throughput.toFixed(1)} msg/s`);
    console.log(`Uptime: ${Math.round(server.uptimeMs / 1000)}s`);

    lastMessageCount = server.messageCount;
    lastCheck = now;
  }, intervalMs);

  return () => clearInterval(interval);
}

// Watch a process
const stopWatching = watchProcess('order_processor', 500);

// Stop watching later
setTimeout(() => stopWatching(), 30000);
```

### Low-Level Introspection APIs

For advanced debugging, use the internal APIs:

```typescript
import { GenServer, Supervisor } from '@hamicek/noex';

// Get all GenServer IDs
const serverIds = GenServer._getAllServerIds();
console.log('GenServer IDs:', serverIds);

// Get ref by ID
const ref = GenServer._getRefById('my_server');
if (ref) {
  const stats = GenServer._getStats(ref);
  console.log('Stats:', stats);
}

// Get current process ID (only in message handlers)
// Useful for correlation/logging within handlers
const behavior = {
  init: () => ({}),
  handleCall: (msg, state) => {
    const currentId = GenServer._getCurrentProcessId();
    console.log(`Handling message in process: ${currentId}`);
    return [null, state];
  },
  handleCast: (msg, state) => state,
};

// Get monitor count
const monitorCount = GenServer._getLocalMonitorCount();
console.log(`Active monitors: ${monitorCount}`);

// Supervisor introspection
const supervisorIds = Supervisor._getAllSupervisorIds();
console.log('Supervisor IDs:', supervisorIds);

const supRef = Supervisor._getRefById('my_supervisor');
if (supRef) {
  const supStats = Supervisor._getStats(supRef);
  console.log('Supervisor stats:', supStats);
}
```

## Common Issues and Solutions

### Issue 1: Process Keeps Restarting (Restart Loop)

**Symptoms:**
- Process restarts repeatedly
- Supervisor eventually gives up (MaxRestartsExceededError)
- System becomes unresponsive

**Diagnosis:**

```typescript
import { GenServer, Supervisor } from '@hamicek/noex';

// Track restart attempts
const restartHistory: { processId: string; timestamp: number; error?: string }[] = [];

GenServer.onLifecycleEvent((event) => {
  if (event.type === 'crashed') {
    restartHistory.push({
      processId: event.ref.id,
      timestamp: Date.now(),
      error: event.error.message,
    });
  }

  if (event.type === 'restarted') {
    console.log(`Process ${event.ref.id} restarted (attempt ${event.attempt})`);
  }
});

Supervisor.onLifecycleEvent((event) => {
  if (event.type === 'terminated' && event.reason.type === 'error') {
    console.error('Supervisor terminated due to error - check restart intensity settings');
  }
});

// Analyze restart patterns
function analyzeRestarts(processId: string): void {
  const history = restartHistory.filter((h) => h.processId === processId);

  if (history.length === 0) {
    console.log('No restarts recorded');
    return;
  }

  console.log(`Restart history for ${processId}:`);
  for (const entry of history.slice(-10)) {
    const time = new Date(entry.timestamp).toISOString();
    console.log(`  ${time}: ${entry.error ?? 'unknown error'}`);
  }

  // Check for patterns
  const errors = history.map((h) => h.error).filter(Boolean);
  const uniqueErrors = [...new Set(errors)];

  console.log(`\nUnique errors (${uniqueErrors.length}):`);
  for (const error of uniqueErrors) {
    const count = errors.filter((e) => e === error).length;
    console.log(`  [${count}x] ${error}`);
  }
}
```

**Common Causes:**
1. Error in `init()` — process crashes before starting
2. External dependency unavailable — database, API, etc.
3. Invalid configuration — missing env vars, wrong paths
4. Resource exhaustion — file handles, memory, etc.

**Solutions:**

```typescript
// 1. Validate configuration before starting
const ConfigValidatorBehavior = {
  init: () => {
    // Validate all required config exists
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable required');
    }

    // Return initial state only if valid
    return { configured: true };
  },
  // ...
};

// 2. Use backoff strategy
const supervisorSpec = {
  strategy: 'one_for_one' as const,
  maxRestarts: 5,
  withinMs: 30000, // Longer window = more tolerance
  children: [...],
};

// 3. Add health checks before critical operations
const behavior = {
  init: async () => {
    // Check database connectivity
    const dbAvailable = await checkDatabaseConnection();
    if (!dbAvailable) {
      // Log and retry instead of crashing
      console.warn('Database not available, will retry...');
    }
    return { dbAvailable };
  },
  // ...
};
```

### Issue 2: Message Queue Growing

**Symptoms:**
- Process queue size keeps increasing
- Response times degrade
- Eventually system becomes unresponsive

**Diagnosis:**

```typescript
import { Observer } from '@hamicek/noex';

function findQueueBottlenecks(threshold: number = 10): void {
  const servers = Observer.getServerStats();

  const overloaded = servers.filter((s) => s.queueSize > threshold);

  if (overloaded.length === 0) {
    console.log('No queue bottlenecks detected');
    return;
  }

  console.log('Overloaded processes:');
  for (const server of overloaded.sort((a, b) => b.queueSize - a.queueSize)) {
    const throughput = server.messageCount / (server.uptimeMs / 1000);
    console.log(`  ${server.id}:`);
    console.log(`    Queue: ${server.queueSize}`);
    console.log(`    Throughput: ${throughput.toFixed(1)} msg/s`);
  }
}

// Monitor queue growth over time
function monitorQueueGrowth(processId: string, intervalMs: number = 5000): () => void {
  const samples: { timestamp: number; queueSize: number }[] = [];

  const interval = setInterval(() => {
    const servers = Observer.getServerStats();
    const server = servers.find((s) => s.id === processId);

    if (server) {
      samples.push({ timestamp: Date.now(), queueSize: server.queueSize });

      // Keep last 100 samples
      if (samples.length > 100) samples.shift();

      // Calculate growth rate
      if (samples.length >= 2) {
        const first = samples[0];
        const last = samples[samples.length - 1];
        const elapsed = (last.timestamp - first.timestamp) / 1000;
        const growth = (last.queueSize - first.queueSize) / elapsed;

        if (growth > 0) {
          console.warn(`Queue growing: ${growth.toFixed(2)} msg/s`);
        }
      }
    }
  }, intervalMs);

  return () => clearInterval(interval);
}
```

**Common Causes:**
1. Slow message handlers — expensive computations, blocking I/O
2. Producer faster than consumer — rate limiting needed
3. Downstream service slow — cascading backpressure

**Solutions:**

```typescript
// 1. Use async operations, don't block
const behavior = {
  handleCall: async (msg, state) => {
    // BAD: Blocking computation
    // const result = expensiveSync();

    // GOOD: Defer to next tick or use worker
    const result = await computeAsync();
    return [result, state];
  },
  // ...
};

// 2. Implement backpressure
const behavior = {
  handleCall: (msg, state) => {
    // Check queue size and reject if overloaded
    const stats = GenServer._getStats(selfRef);
    if (stats && stats.queueSize > 100) {
      return [{ error: 'overloaded', retryAfterMs: 1000 }, state];
    }

    // Process normally
    return [processMessage(msg), state];
  },
  // ...
};

// 3. Use worker pool for scaling
const workerPool = await Supervisor.start({
  strategy: 'one_for_one',
  maxRestarts: 10,
  withinMs: 60000,
  children: Array.from({ length: 4 }, (_, i) => ({
    id: `worker_${i}`,
    start: () => GenServer.start(workerBehavior),
    restart: 'permanent',
  })),
});
```

### Issue 3: Memory Leak

**Symptoms:**
- Heap usage keeps growing
- GC pauses increase
- Eventually OOM crash

**Diagnosis:**

```typescript
import { Observer } from '@hamicek/noex';

// Track memory over time
const memoryHistory: { timestamp: number; heapUsed: number }[] = [];

function trackMemory(): () => void {
  const interval = setInterval(() => {
    const stats = Observer.getMemoryStats();
    memoryHistory.push({
      timestamp: stats.timestamp,
      heapUsed: stats.heapUsed,
    });

    // Keep last 1000 samples
    if (memoryHistory.length > 1000) memoryHistory.shift();
  }, 10000);

  return () => clearInterval(interval);
}

function analyzeMemoryTrend(): void {
  if (memoryHistory.length < 10) {
    console.log('Not enough data');
    return;
  }

  // Simple linear regression
  const n = memoryHistory.length;
  const firstHalf = memoryHistory.slice(0, n / 2);
  const secondHalf = memoryHistory.slice(n / 2);

  const avgFirst = firstHalf.reduce((sum, s) => sum + s.heapUsed, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((sum, s) => sum + s.heapUsed, 0) / secondHalf.length;

  const elapsed = (memoryHistory[n - 1].timestamp - memoryHistory[0].timestamp) / 1000;
  const growth = (avgSecond - avgFirst) / (elapsed / 2);

  const formatMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

  console.log('Memory Analysis:');
  console.log(`  First half avg: ${formatMB(avgFirst)}MB`);
  console.log(`  Second half avg: ${formatMB(avgSecond)}MB`);
  console.log(`  Growth rate: ${formatMB(growth)}/s`);

  if (growth > 1024 * 1024) { // > 1MB/s
    console.warn('  WARNING: Significant memory growth detected!');
  }
}

// Find processes with high memory
function findHighMemoryProcesses(): void {
  const servers = Observer.getServerStats();

  const withMemory = servers
    .filter((s) => s.stateMemoryBytes !== undefined)
    .sort((a, b) => (b.stateMemoryBytes ?? 0) - (a.stateMemoryBytes ?? 0));

  console.log('Processes by memory:');
  for (const server of withMemory.slice(0, 10)) {
    const mb = ((server.stateMemoryBytes ?? 0) / 1024 / 1024).toFixed(2);
    console.log(`  ${server.id}: ${mb}MB`);
  }
}
```

**Common Causes:**
1. Unbounded state growth — arrays/maps without cleanup
2. Retained references — closures capturing large objects
3. Event listener leaks — subscribing without unsubscribing

**Solutions:**

```typescript
// 1. Bound state collections
interface State {
  recentOrders: Order[];  // Bounded
  orderById: Map<string, Order>;
}

const behavior = {
  handleCast: (msg, state) => {
    if (msg.type === 'add_order') {
      const recentOrders = [...state.recentOrders, msg.order].slice(-1000); // Keep last 1000
      const orderById = new Map(state.orderById);

      // Remove old entries if map is too large
      if (orderById.size > 10000) {
        const toRemove = Array.from(orderById.keys()).slice(0, 1000);
        for (const key of toRemove) {
          orderById.delete(key);
        }
      }

      orderById.set(msg.order.id, msg.order);
      return { ...state, recentOrders, orderById };
    }
    return state;
  },
  // ...
};

// 2. Clean up in terminate
const behavior = {
  // ...
  terminate: (reason, state) => {
    // Clear any intervals, subscriptions, etc.
    state.cleanupFn?.();
    return undefined;
  },
};

// 3. Track subscriptions
let subscriptions: (() => void)[] = [];

function cleanup(): void {
  for (const unsub of subscriptions) {
    unsub();
  }
  subscriptions = [];
}
```

### Issue 4: Deadlock / Timeout

**Symptoms:**
- call() times out
- System appears frozen
- Circular dependencies

**Diagnosis:**

```typescript
// Enable verbose timeout logging
import { GenServer } from '@hamicek/noex';

// Wrap calls with detailed logging
async function tracedCall<T>(
  ref: { id: string },
  msg: unknown,
  timeout: number = 5000
): Promise<T> {
  const start = Date.now();
  const callId = Math.random().toString(36).slice(2, 8);

  console.log(`[${callId}] CALL START: ${ref.id}`);
  console.log(`[${callId}] Message: ${JSON.stringify(msg)}`);

  try {
    const result = await GenServer.call(ref as any, msg as any, { timeout });
    const elapsed = Date.now() - start;
    console.log(`[${callId}] CALL SUCCESS: ${elapsed}ms`);
    return result as T;
  } catch (error) {
    const elapsed = Date.now() - start;
    console.error(`[${callId}] CALL FAILED: ${elapsed}ms`);
    console.error(`[${callId}] Error: ${error instanceof Error ? error.message : error}`);
    throw error;
  }
}

// Detect potential circular calls
function detectCircularCalls(): void {
  const callChain: string[] = [];

  GenServer.onLifecycleEvent((event) => {
    if (event.type === 'started') {
      // New process started - check if it was started during a call chain
      if (callChain.length > 0) {
        console.log(`Process ${event.ref.id} started during call chain: ${callChain.join(' -> ')}`);
      }
    }
  });
}
```

**Common Causes:**
1. A calls B, B calls A — circular sync dependency
2. Handler takes too long — expensive computation
3. External service timeout — cascades into noex timeout

**Solutions:**

```typescript
// 1. Break circular dependencies with cast
// Instead of: A.call(B, msg), B.call(A, response)
// Use: A.call(B, msg), B.cast(A, response)

// 2. Use reasonable timeouts
const result = await GenServer.call(ref, msg, { timeout: 10000 }); // 10s for slow ops

// 3. Add timeout handling in handlers
const behavior = {
  handleCall: async (msg, state) => {
    try {
      const result = await Promise.race([
        fetchExternalData(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('External timeout')), 5000)
        ),
      ]);
      return [result, state];
    } catch (error) {
      // Return error response instead of crashing
      return [{ error: 'timeout' }, state];
    }
  },
  // ...
};
```

## Debugging Decision Flowchart

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       DEBUGGING DECISION FLOWCHART                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  START: Something is wrong                                                  │
│         │                                                                   │
│         ▼                                                                   │
│  ┌─────────────────┐                                                        │
│  │ Check lifecycle │                                                        │
│  │    events       │                                                        │
│  └────────┬────────┘                                                        │
│           │                                                                 │
│     ┌─────┴─────┐                                                           │
│     │           │                                                           │
│     ▼           ▼                                                           │
│  Crashes?    No crashes                                                     │
│     │           │                                                           │
│     │           ▼                                                           │
│     │    ┌─────────────────┐                                                │
│     │    │  Check queues   │                                                │
│     │    │  (Observer)     │                                                │
│     │    └────────┬────────┘                                                │
│     │             │                                                         │
│     │       ┌─────┴─────┐                                                   │
│     │       │           │                                                   │
│     │       ▼           ▼                                                   │
│     │   Growing?     Normal                                                 │
│     │       │           │                                                   │
│     │       │           ▼                                                   │
│     │       │    ┌─────────────────┐                                        │
│     │       │    │  Check memory   │                                        │
│     │       │    │  (Observer)     │                                        │
│     │       │    └────────┬────────┘                                        │
│     │       │             │                                                 │
│     │       │       ┌─────┴─────┐                                           │
│     │       │       │           │                                           │
│     │       │       ▼           ▼                                           │
│     │       │   Growing?     Normal                                         │
│     │       │       │           │                                           │
│     ▼       ▼       ▼           ▼                                           │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────────┐                                    │
│  │Error │ │Back- │ │Memory│ │Check     │                                    │
│  │in    │ │press-│ │leak  │ │message   │                                    │
│  │init/ │ │ure   │ │issue │ │tracing   │                                    │
│  │handler│ │issue │ │      │ │          │                                    │
│  └──────┘ └──────┘ └──────┘ └──────────┘                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Exercise: Build a Debugging Dashboard

Build a GenServer that provides comprehensive debugging information.

**Requirements:**

1. Aggregate lifecycle events from all processes
2. Track restart patterns and identify unstable processes
3. Monitor queue sizes and detect bottlenecks
4. Provide API for querying debug information
5. Export debug reports

**Starter code:**

```typescript
import {
  GenServer,
  Supervisor,
  Observer,
  type GenServerBehavior,
  type LifecycleEvent,
} from '@hamicek/noex';

interface DebugEvent {
  timestamp: number;
  processId: string;
  type: string;
  details: Record<string, unknown>;
}

interface ProcessHealth {
  processId: string;
  status: 'healthy' | 'warning' | 'critical';
  restartCount: number;
  lastError?: string;
  avgQueueSize: number;
  messageRate: number;
}

interface DebugDashboardState {
  events: DebugEvent[];
  processHealth: Map<string, ProcessHealth>;
  queueSamples: Map<string, number[]>;
  messageCounts: Map<string, number>;
  lastSampleTime: number;
}

type DebugDashboardCall =
  | { type: 'getEvents'; limit?: number }
  | { type: 'getProcessHealth'; processId?: string }
  | { type: 'getUnstableProcesses'; restartThreshold?: number }
  | { type: 'getBottlenecks'; queueThreshold?: number }
  | { type: 'exportReport' };

type DebugDashboardCast =
  | { type: 'recordEvent'; event: DebugEvent }
  | { type: 'sampleStats' };

// TODO: Implement the debug dashboard behavior
const DebugDashboardBehavior: GenServerBehavior<
  DebugDashboardState,
  DebugDashboardCall,
  DebugDashboardCast,
  unknown
> = {
  // ...
};

// TODO: Wire up lifecycle event collection
async function startDebugDashboard() {
  // ...
}
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
import {
  GenServer,
  Supervisor,
  Observer,
  type GenServerBehavior,
  type GenServerRef,
  type LifecycleEvent,
} from '@hamicek/noex';

interface DebugEvent {
  timestamp: number;
  processId: string;
  type: string;
  details: Record<string, unknown>;
}

interface ProcessHealth {
  processId: string;
  status: 'healthy' | 'warning' | 'critical';
  restartCount: number;
  lastError?: string;
  avgQueueSize: number;
  messageRate: number;
  lastSeen: number;
}

interface DebugDashboardState {
  events: DebugEvent[];
  processHealth: Map<string, ProcessHealth>;
  queueSamples: Map<string, number[]>;
  messageCounts: Map<string, number>;
  lastSampleTime: number;
  maxEvents: number;
  maxSamples: number;
}

type DebugDashboardCall =
  | { type: 'getEvents'; limit?: number; processId?: string }
  | { type: 'getProcessHealth'; processId?: string }
  | { type: 'getUnstableProcesses'; restartThreshold?: number }
  | { type: 'getBottlenecks'; queueThreshold?: number }
  | { type: 'getStats' }
  | { type: 'exportReport' };

type DebugDashboardCast =
  | { type: 'recordLifecycleEvent'; event: LifecycleEvent }
  | { type: 'sampleStats' }
  | { type: 'cleanup' };

type DebugDashboardReply =
  | { events: DebugEvent[] }
  | { health: ProcessHealth[] }
  | { processes: { processId: string; restarts: number }[] }
  | { bottlenecks: { processId: string; avgQueue: number }[] }
  | { stats: { totalEvents: number; activeProcesses: number; totalRestarts: number } }
  | { report: string };

function calculateHealthStatus(health: ProcessHealth): 'healthy' | 'warning' | 'critical' {
  if (health.restartCount > 5 || health.avgQueueSize > 100) {
    return 'critical';
  }
  if (health.restartCount > 2 || health.avgQueueSize > 50) {
    return 'warning';
  }
  return 'healthy';
}

const DebugDashboardBehavior: GenServerBehavior<
  DebugDashboardState,
  DebugDashboardCall,
  DebugDashboardCast,
  DebugDashboardReply
> = {
  init: () => ({
    events: [],
    processHealth: new Map(),
    queueSamples: new Map(),
    messageCounts: new Map(),
    lastSampleTime: Date.now(),
    maxEvents: 10000,
    maxSamples: 100,
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'getEvents': {
        let events = state.events;

        if (msg.processId) {
          events = events.filter((e) => e.processId === msg.processId);
        }

        const limit = msg.limit ?? 100;
        events = events.slice(-limit);

        return [{ events }, state];
      }

      case 'getProcessHealth': {
        if (msg.processId) {
          const health = state.processHealth.get(msg.processId);
          return [{ health: health ? [health] : [] }, state];
        }

        return [{ health: Array.from(state.processHealth.values()) }, state];
      }

      case 'getUnstableProcesses': {
        const threshold = msg.restartThreshold ?? 3;

        const processes = Array.from(state.processHealth.values())
          .filter((h) => h.restartCount >= threshold)
          .sort((a, b) => b.restartCount - a.restartCount)
          .map((h) => ({ processId: h.processId, restarts: h.restartCount }));

        return [{ processes }, state];
      }

      case 'getBottlenecks': {
        const threshold = msg.queueThreshold ?? 10;

        const bottlenecks = Array.from(state.processHealth.values())
          .filter((h) => h.avgQueueSize >= threshold)
          .sort((a, b) => b.avgQueueSize - a.avgQueueSize)
          .map((h) => ({ processId: h.processId, avgQueue: h.avgQueueSize }));

        return [{ bottlenecks }, state];
      }

      case 'getStats': {
        const totalRestarts = Array.from(state.processHealth.values())
          .reduce((sum, h) => sum + h.restartCount, 0);

        return [{
          stats: {
            totalEvents: state.events.length,
            activeProcesses: state.processHealth.size,
            totalRestarts,
          },
        }, state];
      }

      case 'exportReport': {
        const lines: string[] = [];
        const now = new Date().toISOString();

        lines.push('='.repeat(60));
        lines.push(`DEBUG REPORT - ${now}`);
        lines.push('='.repeat(60));
        lines.push('');

        // Summary
        const totalRestarts = Array.from(state.processHealth.values())
          .reduce((sum, h) => sum + h.restartCount, 0);

        lines.push('SUMMARY');
        lines.push('-'.repeat(40));
        lines.push(`Total events: ${state.events.length}`);
        lines.push(`Active processes: ${state.processHealth.size}`);
        lines.push(`Total restarts: ${totalRestarts}`);
        lines.push('');

        // Critical processes
        const critical = Array.from(state.processHealth.values())
          .filter((h) => h.status === 'critical');

        if (critical.length > 0) {
          lines.push('CRITICAL PROCESSES');
          lines.push('-'.repeat(40));
          for (const h of critical) {
            lines.push(`  ${h.processId}:`);
            lines.push(`    Restarts: ${h.restartCount}`);
            lines.push(`    Avg Queue: ${h.avgQueueSize.toFixed(1)}`);
            if (h.lastError) {
              lines.push(`    Last Error: ${h.lastError}`);
            }
          }
          lines.push('');
        }

        // Recent errors
        const recentErrors = state.events
          .filter((e) => e.type === 'crashed')
          .slice(-10);

        if (recentErrors.length > 0) {
          lines.push('RECENT ERRORS');
          lines.push('-'.repeat(40));
          for (const e of recentErrors) {
            const time = new Date(e.timestamp).toISOString();
            lines.push(`  [${time}] ${e.processId}`);
            if (e.details.error) {
              lines.push(`    ${e.details.error}`);
            }
          }
          lines.push('');
        }

        // Process health table
        lines.push('PROCESS HEALTH');
        lines.push('-'.repeat(40));
        lines.push('Process ID'.padEnd(30) + 'Status'.padEnd(10) + 'Restarts'.padEnd(10) + 'Queue');

        const sorted = Array.from(state.processHealth.values())
          .sort((a, b) => {
            const statusOrder = { critical: 0, warning: 1, healthy: 2 };
            return statusOrder[a.status] - statusOrder[b.status];
          });

        for (const h of sorted) {
          const id = h.processId.slice(0, 28).padEnd(30);
          const status = h.status.toUpperCase().padEnd(10);
          const restarts = String(h.restartCount).padEnd(10);
          const queue = h.avgQueueSize.toFixed(1);
          lines.push(`${id}${status}${restarts}${queue}`);
        }

        return [{ report: lines.join('\n') }, state];
      }
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'recordLifecycleEvent': {
        const { event } = msg;
        const timestamp = Date.now();

        // Extract process ID
        let processId = 'unknown';
        if ('ref' in event && event.ref) {
          processId = event.ref.id;
        }

        // Record event
        const debugEvent: DebugEvent = {
          timestamp,
          processId,
          type: event.type,
          details: {},
        };

        // Extract details based on event type
        if (event.type === 'crashed') {
          debugEvent.details.error = event.error.message;
          debugEvent.details.stack = event.error.stack;
        } else if (event.type === 'restarted') {
          debugEvent.details.attempt = event.attempt;
        } else if (event.type === 'terminated') {
          debugEvent.details.reason = event.reason;
        }

        // Update events list
        let events = [...state.events, debugEvent];
        if (events.length > state.maxEvents) {
          events = events.slice(-state.maxEvents);
        }

        // Update process health
        const processHealth = new Map(state.processHealth);
        let health = processHealth.get(processId) ?? {
          processId,
          status: 'healthy' as const,
          restartCount: 0,
          avgQueueSize: 0,
          messageRate: 0,
          lastSeen: timestamp,
        };

        if (event.type === 'crashed') {
          health = {
            ...health,
            lastError: event.error.message,
            lastSeen: timestamp,
          };
        } else if (event.type === 'restarted') {
          health = {
            ...health,
            restartCount: health.restartCount + 1,
            lastSeen: timestamp,
          };
        }

        health.status = calculateHealthStatus(health);
        processHealth.set(processId, health);

        return { ...state, events, processHealth };
      }

      case 'sampleStats': {
        const servers = Observer.getServerStats();
        const now = Date.now();
        const elapsed = (now - state.lastSampleTime) / 1000;

        const queueSamples = new Map(state.queueSamples);
        const messageCounts = new Map(state.messageCounts);
        const processHealth = new Map(state.processHealth);

        for (const server of servers) {
          // Update queue samples
          const samples = queueSamples.get(server.id) ?? [];
          samples.push(server.queueSize);
          if (samples.length > state.maxSamples) {
            samples.shift();
          }
          queueSamples.set(server.id, samples);

          // Calculate average queue size
          const avgQueue = samples.reduce((a, b) => a + b, 0) / samples.length;

          // Calculate message rate
          const lastCount = messageCounts.get(server.id) ?? server.messageCount;
          const rate = elapsed > 0 ? (server.messageCount - lastCount) / elapsed : 0;
          messageCounts.set(server.id, server.messageCount);

          // Update health
          let health = processHealth.get(server.id) ?? {
            processId: server.id,
            status: 'healthy' as const,
            restartCount: 0,
            avgQueueSize: 0,
            messageRate: 0,
            lastSeen: now,
          };

          health = {
            ...health,
            avgQueueSize: avgQueue,
            messageRate: rate,
            lastSeen: now,
          };

          health.status = calculateHealthStatus(health);
          processHealth.set(server.id, health);
        }

        return {
          ...state,
          queueSamples,
          messageCounts,
          processHealth,
          lastSampleTime: now,
        };
      }

      case 'cleanup': {
        // Remove stale processes (not seen in 5 minutes)
        const cutoff = Date.now() - 5 * 60 * 1000;
        const processHealth = new Map(state.processHealth);
        const queueSamples = new Map(state.queueSamples);
        const messageCounts = new Map(state.messageCounts);

        for (const [id, health] of processHealth) {
          if (health.lastSeen < cutoff) {
            processHealth.delete(id);
            queueSamples.delete(id);
            messageCounts.delete(id);
          }
        }

        return { ...state, processHealth, queueSamples, messageCounts };
      }
    }

    return state;
  },
};

async function startDebugDashboard(): Promise<{
  dashboard: GenServerRef;
  stop: () => void;
}> {
  const dashboard = await GenServer.start(DebugDashboardBehavior, {
    name: 'debug_dashboard',
  });

  // Subscribe to lifecycle events
  const unsubGenServer = GenServer.onLifecycleEvent((event) => {
    GenServer.cast(dashboard, { type: 'recordLifecycleEvent', event });
  });

  const unsubSupervisor = Supervisor.onLifecycleEvent((event) => {
    GenServer.cast(dashboard, { type: 'recordLifecycleEvent', event });
  });

  // Sample stats periodically
  const sampleInterval = setInterval(() => {
    GenServer.cast(dashboard, { type: 'sampleStats' });
  }, 5000);

  // Cleanup stale processes periodically
  const cleanupInterval = setInterval(() => {
    GenServer.cast(dashboard, { type: 'cleanup' });
  }, 60000);

  return {
    dashboard,
    stop: () => {
      unsubGenServer();
      unsubSupervisor();
      clearInterval(sampleInterval);
      clearInterval(cleanupInterval);
    },
  };
}

// Demo usage
async function demo() {
  const { dashboard, stop } = await startDebugDashboard();

  // Get current stats
  const statsResult = await GenServer.call(dashboard, { type: 'getStats' });
  if ('stats' in statsResult) {
    console.log('Dashboard Stats:');
    console.log(`  Events: ${statsResult.stats.totalEvents}`);
    console.log(`  Processes: ${statsResult.stats.activeProcesses}`);
    console.log(`  Restarts: ${statsResult.stats.totalRestarts}`);
  }

  // Find unstable processes
  const unstableResult = await GenServer.call(dashboard, {
    type: 'getUnstableProcesses',
    restartThreshold: 2,
  });
  if ('processes' in unstableResult && unstableResult.processes.length > 0) {
    console.log('\nUnstable Processes:');
    for (const p of unstableResult.processes) {
      console.log(`  ${p.processId}: ${p.restarts} restarts`);
    }
  }

  // Find bottlenecks
  const bottlenecksResult = await GenServer.call(dashboard, {
    type: 'getBottlenecks',
    queueThreshold: 5,
  });
  if ('bottlenecks' in bottlenecksResult && bottlenecksResult.bottlenecks.length > 0) {
    console.log('\nQueue Bottlenecks:');
    for (const b of bottlenecksResult.bottlenecks) {
      console.log(`  ${b.processId}: avg queue ${b.avgQueue.toFixed(1)}`);
    }
  }

  // Export full report
  const reportResult = await GenServer.call(dashboard, { type: 'exportReport' });
  if ('report' in reportResult) {
    console.log('\n' + reportResult.report);
  }

  // Cleanup
  stop();
  await GenServer.stop(dashboard);
}
```

**Key features of the solution:**

1. **Event aggregation**: Captures all lifecycle events with details
2. **Health tracking**: Calculates health status based on restarts and queue sizes
3. **Queue monitoring**: Samples queue sizes and calculates averages
4. **Throughput calculation**: Tracks message rates per process
5. **Query API**: Multiple ways to query debug information
6. **Report export**: Human-readable summary report

</details>

## Summary

**Key takeaways:**

- **Lifecycle events** are your primary debugging tool — they tell you exactly what's happening
- **Message tracing** helps understand communication patterns and bottlenecks
- **Process introspection** via Observer provides real-time visibility
- **Common issues** (restart loops, queue growth, memory leaks, deadlocks) have systematic solutions
- **Custom debugging tools** can be built using noex primitives

**Debugging Toolkit at a Glance:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          DEBUGGING TOOLKIT                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  LIFECYCLE EVENTS                                                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│  GenServer.onLifecycleEvent()   Track GenServer events                      │
│  Supervisor.onLifecycleEvent()  Track Supervisor events                     │
│                                                                             │
│  OBSERVER                                                                   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Observer.getSnapshot()         Complete system state                       │
│  Observer.getServerStats()      GenServer statistics                        │
│  Observer.getProcessTree()      Supervision hierarchy                       │
│  Observer.getMemoryStats()      Memory usage                                │
│                                                                             │
│  LOW-LEVEL APIs                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  GenServer._getStats(ref)       Stats for specific server                   │
│  GenServer._getRefById(id)      Lookup by ID                                │
│  GenServer._getCurrentProcessId() Current handler context                    │
│                                                                             │
│  MESSAGE TRACING                                                            │
│  ─────────────────────────────────────────────────────────────────────────  │
│  EventBus with '*' subscription Trace all events                            │
│  Custom call/cast wrappers      Trace individual messages                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**When debugging:**

| Symptom | First Check | Tool |
|---------|-------------|------|
| Process crashing | Lifecycle events | `GenServer.onLifecycleEvent()` |
| System slow | Queue sizes | `Observer.getServerStats()` |
| High memory | Memory stats | `Observer.getMemoryStats()` |
| Timeout errors | Message flow | Message tracer |
| Missing messages | Process tree | `Observer.getProcessTree()` |

**Remember:**

> The best debugging tool is prevention: use supervision, handle errors gracefully, and monitor your system from day one. When problems do occur, lifecycle events and Observer give you the visibility you need to diagnose and fix issues quickly.

---

Next: [Clustering Basics](../11-distribution/01-clustering-basics.md)
