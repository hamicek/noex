# Stress Testing

This guide explains how to run stress tests for noex. Stress tests verify system behavior under high load, chaos conditions, and failure scenarios.

## Overview

noex includes two categories of stress tests:

1. **Core stress tests** - Test local GenServer, Supervisor, and utilities under load
2. **Distribution stress tests** - Test distributed cluster with real TCP connections

---

## Running Stress Tests

### Prerequisites

```bash
npm install
npm run build
```

### Run All Stress Tests

```bash
# All stress tests (takes several minutes)
npm test -- tests/stress/

# With verbose output
npm test -- tests/stress/ --reporter=verbose
```

### Run Core Stress Tests Only

```bash
# All core stress tests
npm test -- tests/stress/*.test.ts

# Specific test file
npm test -- tests/stress/supervisor-stress.test.ts
npm test -- tests/stress/chaos-testing.test.ts
npm test -- tests/stress/edge-cases.test.ts
npm test -- tests/stress/utilities.test.ts
```

### Run Distribution Stress Tests Only

```bash
# All distribution stress tests
npm test -- tests/stress/distribution/

# Specific test file
npm test -- tests/stress/distribution/transport-stress.test.ts
npm test -- tests/stress/distribution/cluster-stress.test.ts
npm test -- tests/stress/distribution/remote-call-stress.test.ts
npm test -- tests/stress/distribution/integration-stress.test.ts
```

### Run Specific Test by Name

```bash
# Run tests matching a pattern
npm test -- tests/stress/ -t "high volume"
npm test -- tests/stress/ -t "chaos"
```

---

## Core Stress Tests

Located in `tests/stress/`:

| File | Description |
|------|-------------|
| `supervisor-stress.test.ts` | Supervisor restart strategies, child management under load |
| `chaos-testing.test.ts` | Random crashes, fault injection, recovery scenarios |
| `edge-cases.test.ts` | Boundary conditions, race conditions, unusual inputs |
| `utilities.test.ts` | Test utilities and helpers |

### Example: Supervisor Stress

```bash
npm test -- tests/stress/supervisor-stress.test.ts --reporter=verbose
```

---

## Distribution Stress Tests

Located in `tests/stress/distribution/`. Each test file uses a dedicated port range to avoid conflicts.

| File | Port Range | Description |
|------|------------|-------------|
| `transport-stress.test.ts` | 20000-20099 | TCP transport layer, message throughput |
| `cluster-stress.test.ts` | 21000-21099 | Cluster formation, node membership |
| `remote-call-stress.test.ts` | 23000-23099 | Remote procedure calls under load |
| `remote-spawn-stress.test.ts` | 24000-24099 | Remote process spawning |
| `remote-monitor-stress.test.ts` | 25000-25099 | Cross-node process monitoring |
| `global-registry-stress.test.ts` | 26000-26099 | Global name registration, conflicts |
| `distributed-supervisor-stress.test.ts` | 27000-27099 | Distributed supervisor strategies |
| `integration-stress.test.ts` | 28000-28099 | Full-stack integration scenarios |

### Infrastructure Tests

| File | Description |
|------|-------------|
| `cluster-factory.test.ts` | Test cluster management utilities |
| `node-crash-simulator.test.ts` | Crash simulation utilities |
| `distributed-metrics-collector.test.ts` | Metrics collection |
| `behaviors.test.ts` | Test behaviors (counter, echo, etc.) |

### Example: Integration Tests

```bash
npm test -- tests/stress/distribution/integration-stress.test.ts --reporter=verbose
```

**Output:**
```
✓ handles task distribution across worker pool with chaos
✓ maintains consistency under concurrent writes
✓ handles sustained load across multiple nodes
✓ survives burst traffic patterns
✓ maintains availability during rolling restart
✓ detects and reports node departures
✓ combines remote spawn, call, and global registry
✓ handles concurrent operations from multiple nodes
```

---

## Test Duration

Stress tests take longer than unit tests:

| Category | Approximate Duration |
|----------|---------------------|
| Core stress tests | 30-60 seconds |
| Distribution stress tests | 2-5 minutes |
| All stress tests | 5-10 minutes |

Use `--reporter=verbose` to see progress during long-running tests.

---

## Timeout Configuration

Some tests have extended timeouts (60-120 seconds). If tests timeout on slower machines, you can increase the global timeout:

```bash
npm test -- tests/stress/ --test-timeout=300000
```

---

## Troubleshooting

### Port Conflicts

If tests fail with "address already in use", ensure no previous test processes are running:

```bash
# Find processes using stress test ports
lsof -i :20000-28099

# Kill orphaned node processes
pkill -f "vite-node.*cluster-worker"
```

### Flaky Tests

Some chaos tests may occasionally fail due to timing. Re-run individual failed tests:

```bash
npm test -- tests/stress/distribution/remote-call-stress.test.ts -t "handles calls to crashing"
```

### Memory Issues

For large test suites, increase Node.js memory:

```bash
NODE_OPTIONS="--max-old-space-size=4096" npm test -- tests/stress/
```
