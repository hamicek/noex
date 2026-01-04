# Debugging noex Applications

This guide covers how to debug noex applications using the Observer module, Dashboard TUI, and other techniques for troubleshooting process issues.

## Overview

noex provides several debugging tools:

| Tool | Purpose | Use Case |
|------|---------|----------|
| **Observer** | Programmatic introspection | Scripts, automated monitoring |
| **Dashboard** | Interactive TUI | Live debugging, visual inspection |
| **DashboardServer** | Remote web dashboard | Production debugging |
| **Lifecycle Events** | Event stream | Tracking process changes |
| **AlertManager** | Anomaly detection | Identifying problems automatically |

---

## Using Observer

Observer provides programmatic access to system state.

### Getting a System Snapshot

```typescript
import { Observer } from 'noex';

// Get complete system state
const snapshot = Observer.getSnapshot();

console.log('=== System Snapshot ===');
console.log(`Timestamp: ${new Date(snapshot.timestamp).toISOString()}`);
console.log(`Processes: ${snapshot.processCount}`);
console.log(`Total messages: ${snapshot.totalMessages}`);
console.log(`Total restarts: ${snapshot.totalRestarts}`);
console.log(`Heap used: ${(snapshot.memoryStats.heapUsed / 1024 / 1024).toFixed(2)} MB`);
```

### Inspecting Process Statistics

```typescript
// Get all GenServer stats
const servers = Observer.getServerStats();

console.log('\n=== GenServers ===');
for (const server of servers) {
  console.log(`${server.name || server.id}:`);
  console.log(`  Status: ${server.status}`);
  console.log(`  Messages: ${server.messageCount}`);
  console.log(`  Started: ${new Date(server.startedAt).toISOString()}`);
  if (server.lastMessageAt) {
    console.log(`  Last message: ${new Date(server.lastMessageAt).toISOString()}`);
  }
}

// Get all Supervisor stats
const supervisors = Observer.getSupervisorStats();

console.log('\n=== Supervisors ===');
for (const sup of supervisors) {
  console.log(`${sup.name || sup.id}:`);
  console.log(`  Strategy: ${sup.strategy}`);
  console.log(`  Children: ${sup.childCount}`);
  console.log(`  Total restarts: ${sup.totalRestarts}`);
}
```

### Viewing Process Tree

```typescript
// Get hierarchical view
const tree = Observer.getProcessTree();

function printTree(nodes: readonly ProcessTreeNode[], indent = 0) {
  for (const node of nodes) {
    const prefix = '  '.repeat(indent);
    const icon = node.type === 'supervisor' ? '[S]' : '[G]';
    const name = node.name || node.id;
    console.log(`${prefix}${icon} ${name}`);

    if (node.type === 'supervisor') {
      const stats = node.stats as SupervisorStats;
      console.log(`${prefix}    Strategy: ${stats.strategy}, Restarts: ${stats.totalRestarts}`);
    } else {
      const stats = node.stats as GenServerStats;
      console.log(`${prefix}    Messages: ${stats.messageCount}`);
    }

    printTree(node.children, indent + 1);
  }
}

console.log('\n=== Process Tree ===');
printTree(tree);
```

### Real-Time Event Monitoring

```typescript
// Subscribe to lifecycle events
const unsubscribe = Observer.subscribe((event) => {
  const timestamp = new Date().toISOString();

  switch (event.type) {
    case 'server_started':
      console.log(`[${timestamp}] Server started: ${event.stats.name || event.stats.id}`);
      break;

    case 'server_stopped':
      console.log(`[${timestamp}] Server stopped: ${event.id} (reason: ${event.reason})`);
      break;

    case 'supervisor_started':
      console.log(`[${timestamp}] Supervisor started: ${event.stats.name || event.stats.id}`);
      break;

    case 'supervisor_stopped':
      console.log(`[${timestamp}] Supervisor stopped: ${event.id}`);
      break;

    case 'stats_update':
      console.log(`[${timestamp}] Stats update: ${event.servers.length} servers, ${event.supervisors.length} supervisors`);
      break;
  }
});

// Later: stop monitoring
unsubscribe();
```

---

## Using the Dashboard TUI

The Dashboard provides an interactive terminal interface for debugging.

### Starting the Dashboard

```typescript
import { Dashboard } from 'noex/dashboard';

const dashboard = new Dashboard({
  refreshInterval: 500,  // Update every 500ms
  theme: 'dark',
  layout: 'full',
});

dashboard.start();
```

### Dashboard Layouts

**Full Layout** - All widgets visible:
- Process tree (left)
- Statistics table (right)
- Memory gauge (bottom-left)
- Event log (bottom-right)

**Compact Layout** - For smaller terminals:
- Process tree + Statistics only

**Minimal Layout** - Just the essentials:
- Statistics table only

Switch layouts with keyboard shortcuts `1`, `2`, `3` or programmatically:

```typescript
dashboard.switchLayout('compact');
```

### Keyboard Navigation

| Key | Action |
|-----|--------|
| `q` / `Escape` / `Ctrl+C` | Quit |
| `r` | Refresh data |
| `?` / `h` | Show help |
| `Tab` | Focus next widget |
| `Enter` | Show process details |
| `1` / `2` / `3` | Switch layout |
| Arrow keys | Navigate |

### Remote Dashboard with DashboardServer

For production debugging, use DashboardServer to expose a web interface:

```typescript
import { DashboardServer } from 'noex/dashboard';

const server = new DashboardServer({
  port: 8080,
  refreshInterval: 1000,
});

await server.start();
console.log('Dashboard available at http://localhost:8080');
```

Access from any browser to see real-time process information.

---

## Common Debugging Scenarios

### Scenario 1: Process Not Responding

**Symptoms:** Calls to a GenServer timeout.

**Diagnosis:**

```typescript
import { Observer, GenServer } from 'noex';

// Check if server is running
const servers = Observer.getServerStats();
const target = servers.find((s) => s.name === 'my-service');

if (!target) {
  console.log('Server not found - may have crashed');
} else {
  console.log(`Status: ${target.status}`);
  console.log(`Queue size: ${target.queueSize}`);  // High = backlog
  console.log(`Last message: ${target.lastMessageAt}`);

  if (target.queueSize > 100) {
    console.log('Large queue backlog - server may be stuck');
  }
}
```

**Solutions:**
- Check for blocking operations in handlers
- Look for infinite loops
- Increase timeout for slow operations
- Consider splitting work across multiple servers

### Scenario 2: Frequent Restarts

**Symptoms:** Supervisor shows high restart count.

**Diagnosis:**

```typescript
// Check supervisor stats
const supervisors = Observer.getSupervisorStats();
for (const sup of supervisors) {
  if (sup.totalRestarts > 10) {
    console.log(`High restarts: ${sup.name || sup.id} (${sup.totalRestarts})`);
  }
}

// Monitor for restarts in real-time
Observer.subscribe((event) => {
  if (event.type === 'server_started') {
    console.log(`Restart detected: ${event.stats.name}`);
    console.log(`Stats:`, event.stats);
  }
});
```

**Solutions:**
- Check init() for errors
- Review handleCall/handleCast for exceptions
- Increase restart intensity limits if appropriate
- Add logging to terminate() to see crash reasons

### Scenario 3: Memory Growth

**Symptoms:** Application memory keeps increasing.

**Diagnosis:**

```typescript
// Track memory over time
setInterval(() => {
  const memory = Observer.getMemoryStats();
  const heapMB = memory.heapUsed / 1024 / 1024;
  console.log(`Heap: ${heapMB.toFixed(2)} MB`);
}, 5000);

// Check for large state in servers
const servers = Observer.getServerStats();
for (const server of servers) {
  if (server.messageCount > 10000) {
    console.log(`High message count: ${server.name} (${server.messageCount})`);
  }
}
```

**Solutions:**
- Check for unbounded collections in state
- Implement TTL/eviction for caches
- Review subscription cleanup
- Use weak references where appropriate

### Scenario 4: Deadlocks

**Symptoms:** Multiple processes waiting on each other.

**Diagnosis:**

```typescript
// Look for processes with queued messages but no recent activity
const servers = Observer.getServerStats();
const now = Date.now();

for (const server of servers) {
  const lastActivity = server.lastMessageAt || server.startedAt;
  const idleMs = now - lastActivity;

  if (server.queueSize > 0 && idleMs > 10000) {
    console.log(`Potential deadlock: ${server.name}`);
    console.log(`  Queue size: ${server.queueSize}`);
    console.log(`  Idle for: ${idleMs}ms`);
  }
}
```

**Solutions:**
- Avoid circular dependencies between services
- Use timeouts on all calls
- Consider using cast instead of call for non-critical operations
- Break cycles with EventBus pub/sub pattern

---

## Debug Logging

### Adding Debug Output to Services

```typescript
const debugBehavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init: () => {
    console.log('[DEBUG] Service initializing');
    return initialState;
  },

  handleCall: (msg, state) => {
    console.log('[DEBUG] handleCall:', JSON.stringify(msg));
    const result = processCall(msg, state);
    console.log('[DEBUG] handleCall result:', JSON.stringify(result[0]));
    return result;
  },

  handleCast: (msg, state) => {
    console.log('[DEBUG] handleCast:', JSON.stringify(msg));
    return processCast(msg, state);
  },

  terminate: (reason, state) => {
    console.log('[DEBUG] terminate:', reason);
  },
};
```

### Conditional Debug Mode

```typescript
const DEBUG = process.env.DEBUG === 'true';

function debug(...args: unknown[]) {
  if (DEBUG) {
    console.log('[DEBUG]', ...args);
  }
}

const serviceBehavior = {
  handleCall: (msg, state) => {
    debug('handleCall', msg);
    // ...
  },
};
```

---

## Exporting Debug Data

### Export to JSON

```typescript
import { Observer, exportToJson } from 'noex/observer';

// Get export-ready data
const data = Observer.prepareExportData();
const json = exportToJson(data);

// Save to file
import { writeFileSync } from 'fs';
writeFileSync('debug-snapshot.json', json);
console.log('Snapshot saved to debug-snapshot.json');
```

### Export to CSV

```typescript
import { Observer, exportToCsv } from 'noex/observer';

const data = Observer.prepareExportData();
const csvFiles = exportToCsv(data);

// csvFiles contains separate CSV strings for servers and supervisors
writeFileSync('servers.csv', csvFiles.servers);
writeFileSync('supervisors.csv', csvFiles.supervisors);
```

---

## AlertManager for Debugging

Use AlertManager to automatically detect anomalies:

```typescript
import { AlertManager, Observer } from 'noex/observer';

// Configure for sensitive detection during debugging
AlertManager.configure({
  enabled: true,
  sensitivityMultiplier: 1.5,  // More sensitive
  minSamples: 10,              // Faster baseline
  cooldownMs: 5000,            // More frequent alerts
});

// Log all alerts
AlertManager.subscribe((event) => {
  if (event.type === 'alert_triggered') {
    console.log('\n=== ALERT ===');
    console.log(`Type: ${event.alert.type}`);
    console.log(`Process: ${event.alert.processName || event.alert.processId}`);
    console.log(`Message: ${event.alert.message}`);
    console.log(`Value: ${event.alert.currentValue}`);
    console.log(`Threshold: ${event.alert.threshold}`);

    // Get more details
    const stats = AlertManager.getProcessStatistics(event.alert.processId);
    if (stats) {
      console.log(`Mean: ${stats.mean.toFixed(2)}`);
      console.log(`StdDev: ${stats.stddev.toFixed(2)}`);
      console.log(`Samples: ${stats.sampleCount}`);
    }
  }
});

// Start polling to trigger alert checks
Observer.startPolling(1000, () => {});
```

---

## Debugging Tips

### 1. Start with the Process Tree

```typescript
const tree = Observer.getProcessTree();
// Visualize the hierarchy to understand relationships
```

### 2. Check Restart History

```typescript
const sups = Observer.getSupervisorStats();
// High restarts = unstable children
```

### 3. Monitor Memory Trends

```typescript
// Sample every 10 seconds, look for growth
```

### 4. Use Call Timeouts

```typescript
// Short timeouts help identify slow handlers
await GenServer.call(ref, msg, { timeout: 1000 });
```

### 5. Add Unique Request IDs

```typescript
handleCall: (msg, state) => {
  const requestId = generateId();
  console.log(`[${requestId}] Start`, msg.type);
  // ... process ...
  console.log(`[${requestId}] End`);
};
```

### 6. Test with Dashboard During Development

```typescript
// Add dashboard to your dev script
if (process.env.NODE_ENV === 'development') {
  const dashboard = new Dashboard();
  dashboard.start();
}
```

---

## Debug Script Template

```typescript
// debug.ts - Run with: npx tsx debug.ts
import { Observer, GenServer, Supervisor, AlertManager } from 'noex';

async function debug() {
  console.log('=== noex Debug Report ===\n');

  // System overview
  const snapshot = Observer.getSnapshot();
  console.log('System Overview:');
  console.log(`  Processes: ${snapshot.processCount}`);
  console.log(`  Messages: ${snapshot.totalMessages}`);
  console.log(`  Restarts: ${snapshot.totalRestarts}`);
  console.log(`  Memory: ${(snapshot.memoryStats.heapUsed / 1024 / 1024).toFixed(2)} MB`);

  // Process details
  console.log('\nGenServers:');
  for (const server of snapshot.servers) {
    console.log(`  ${server.name || server.id}: ${server.messageCount} msgs, status=${server.status}`);
  }

  console.log('\nSupervisors:');
  for (const sup of snapshot.supervisors) {
    console.log(`  ${sup.name || sup.id}: ${sup.childCount} children, ${sup.totalRestarts} restarts, strategy=${sup.strategy}`);
  }

  // Active alerts
  const alerts = Observer.getActiveAlerts();
  if (alerts.length > 0) {
    console.log('\nActive Alerts:');
    for (const alert of alerts) {
      console.log(`  [${alert.type}] ${alert.message}`);
    }
  } else {
    console.log('\nNo active alerts');
  }

  // Process tree
  console.log('\nProcess Tree:');
  function printTree(nodes, indent = 0) {
    for (const node of nodes) {
      const prefix = '  '.repeat(indent + 1);
      console.log(`${prefix}${node.type === 'supervisor' ? '[S]' : '[G]'} ${node.name || node.id}`);
      printTree(node.children, indent + 1);
    }
  }
  printTree(snapshot.tree);
}

debug().catch(console.error);
```

---

## Related

- [Production Guide](./production.md) - Production deployment
- [Observer API](../api/observer.md) - Observer reference
- [Dashboard API](../api/dashboard.md) - Dashboard reference
- [AlertManager API](../api/alert-manager.md) - AlertManager reference
- [Testing Guide](./testing.md) - Testing noex applications
