# Restart Intensity

Supervisors automatically restart crashed children, but what happens if a child keeps crashing repeatedly? Without limits, you'd get an **infinite restart loop** - the child crashes, restarts, crashes again, restarts again, forever. This wastes resources and masks underlying problems that need fixing.

**Restart intensity** is the safety mechanism that prevents this. It limits how many restarts can occur within a time window.

## What You'll Learn

- How restart intensity prevents infinite restart loops
- Configuring `maxRestarts` and `withinMs`
- The sliding window algorithm
- What happens when the limit is exceeded
- Choosing appropriate values for your use case

## The Problem: Infinite Restart Loops

Consider a service that crashes immediately on startup due to a configuration error:

```typescript
const brokenBehavior: GenServerBehavior<null, never, never, never> = {
  init() {
    // This will always fail
    throw new Error('Missing DATABASE_URL environment variable');
  },
  handleCall: (_, state) => [undefined as never, state],
  handleCast: (_, state) => state,
};
```

Without restart limits, the supervisor would:
1. Start the service → crashes
2. Restart the service → crashes immediately
3. Restart the service → crashes immediately
4. ... (forever)

Each restart consumes CPU, memory, and potentially external resources (database connections, API calls). The application appears to be "running" but nothing useful is happening.

## How Restart Intensity Works

Restart intensity is configured with two parameters:

```typescript
const supervisor = await Supervisor.start({
  restartIntensity: {
    maxRestarts: 3,      // Maximum restarts allowed
    withinMs: 5000,      // Time window in milliseconds
  },
  children: [...],
});
```

The rule is simple: **if more than `maxRestarts` restarts occur within `withinMs` milliseconds, the supervisor gives up and throws an error**.

### Default Values

If you don't specify `restartIntensity`, noex uses sensible defaults:

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `maxRestarts` | 3 | Allow up to 3 restarts |
| `withinMs` | 5000 | Within a 5-second window |

```typescript
// These are equivalent:
await Supervisor.start({ children: [...] });

await Supervisor.start({
  restartIntensity: { maxRestarts: 3, withinMs: 5000 },
  children: [...],
});
```

## The Sliding Window Algorithm

The restart intensity uses a **sliding window** - not a fixed time period. This is important to understand.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SLIDING WINDOW ALGORITHM                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Time →   0s      1s      2s      3s      4s      5s      6s      7s       │
│           │       │       │       │       │       │       │       │        │
│           ▼       ▼       ▼       ▼       ▼       ▼       ▼       ▼        │
│           R1      R2              R3                      R4               │
│           │                       │                       │                │
│           │                       │                       │                │
│           │   At time 3s:         │   At time 6s:         │                │
│           │   Window = [0s-3s]    │   Window = [1s-6s]    │                │
│           │   Restarts = 3 ✓      │   Restarts = 2 ✓      │                │
│           │   (R1, R2, R3)        │   (R2, R3)            │                │
│           │                       │   R1 aged out!        │                │
│                                                                             │
│  With maxRestarts=3, withinMs=5000:                                        │
│  - At R3 (3s): 3 restarts in window → OK (at limit)                        │
│  - At R4 (6s): Only 2 restarts in window → OK (R1 is too old)              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Each restart is timestamped. When checking if a new restart is allowed, the supervisor counts only restarts that occurred within the last `withinMs` milliseconds. Older restarts "age out" of the window.

This means a service can recover after a burst of failures, as long as it becomes stable.

## What Happens When Limits Are Exceeded

When a restart would exceed the limit, the supervisor:

1. **Stops trying to restart** the failing child
2. **Throws a `MaxRestartsExceededError`**
3. **Shuts itself down** (the supervisor stops running)

```typescript
import { Supervisor, GenServer, MaxRestartsExceededError } from '@hamicek/noex';

const alwaysCrashesBehavior = {
  init() {
    throw new Error('I always crash');
  },
  handleCall: (_, s) => [null, s],
  handleCast: (_, s) => s,
};

async function main() {
  try {
    const supervisor = await Supervisor.start({
      restartIntensity: { maxRestarts: 2, withinMs: 1000 },
      children: [
        {
          id: 'unstable',
          start: () => GenServer.start(alwaysCrashesBehavior),
        },
      ],
    });

    // Wait for crashes to happen
    await new Promise((resolve) => setTimeout(resolve, 500));
  } catch (error) {
    if (error instanceof MaxRestartsExceededError) {
      console.log(`Supervisor gave up: ${error.message}`);
      console.log(`  Supervisor: ${error.supervisorId}`);
      console.log(`  Max restarts: ${error.maxRestarts}`);
      console.log(`  Time window: ${error.withinMs}ms`);
    }
  }
}

main();
```

**Output:**
```
Supervisor gave up: Supervisor supervisor_1_... exceeded max restarts (2 within 1000ms)
  Supervisor: supervisor_1_...
  Max restarts: 2
  Time window: 1000ms
```

## Practical Example: Tuning Restart Intensity

Different services need different restart settings based on their characteristics:

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from '@hamicek/noex';

// Simulates a service with configurable crash behavior
interface ServiceState {
  name: string;
  crashProbability: number;
  callCount: number;
}

type ServiceCall = { type: 'process' };

const createServiceBehavior = (
  name: string,
  crashProbability: number
): GenServerBehavior<ServiceState, ServiceCall, never, string> => ({
  init() {
    console.log(`[${name}] Starting`);
    return { name, crashProbability, callCount: 0 };
  },
  handleCall(_msg, state) {
    const newCount = state.callCount + 1;

    // Randomly crash based on probability
    if (Math.random() < state.crashProbability) {
      throw new Error(`${state.name} random failure`);
    }

    return [`processed #${newCount}`, { ...state, callCount: newCount }];
  },
  handleCast: (_, state) => state,
  terminate(reason) {
    const reasonStr = typeof reason === 'string' ? reason : 'error';
    console.log(`[${this.name}] Terminated: ${reasonStr}`);
  },
});

async function main() {
  // Critical payment service - very conservative settings
  // Fail fast if there's a real problem
  const paymentSupervisor = await Supervisor.start({
    restartIntensity: {
      maxRestarts: 2,   // Only 2 attempts
      withinMs: 10000,  // In 10 seconds
    },
    children: [
      {
        id: 'payment-processor',
        start: () => GenServer.start(createServiceBehavior('Payment', 0.1)),
      },
    ],
  });

  // Background job worker - more tolerant
  // Jobs can retry, occasional failures are expected
  const workerSupervisor = await Supervisor.start({
    restartIntensity: {
      maxRestarts: 10,  // Allow many retries
      withinMs: 60000,  // Over 1 minute
    },
    children: [
      {
        id: 'job-worker',
        start: () => GenServer.start(createServiceBehavior('Worker', 0.3)),
      },
    ],
  });

  // Cache service - very tolerant
  // Cache misses are recoverable, restart aggressively
  const cacheSupervisor = await Supervisor.start({
    restartIntensity: {
      maxRestarts: 20,   // Many restarts OK
      withinMs: 30000,   // In 30 seconds
    },
    children: [
      {
        id: 'cache',
        start: () => GenServer.start(createServiceBehavior('Cache', 0.5)),
      },
    ],
  });

  console.log('\nAll supervisors started with different restart intensities:');
  console.log('- Payment: 2 restarts / 10s (fail fast)');
  console.log('- Worker: 10 restarts / 60s (tolerant)');
  console.log('- Cache: 20 restarts / 30s (very tolerant)');

  // Cleanup
  await Promise.all([
    Supervisor.stop(paymentSupervisor),
    Supervisor.stop(workerSupervisor),
    Supervisor.stop(cacheSupervisor),
  ]);
}

main();
```

## Guidelines for Choosing Values

### Consider the Service Type

| Service Type | Recommended Settings | Rationale |
|--------------|---------------------|-----------|
| **Critical services** (payments, auth) | Low `maxRestarts` (2-3), moderate `withinMs` (10-30s) | Fail fast, alert operators |
| **Background workers** | Higher `maxRestarts` (5-10), longer `withinMs` (60s+) | Tolerate transient failures |
| **Caches** | High `maxRestarts` (10-20), moderate `withinMs` (30-60s) | Aggressive recovery, data is recoverable |
| **Startup-heavy services** | Lower `maxRestarts`, longer `withinMs` | Startup failures are expensive |

### Consider Failure Patterns

**Transient failures** (network blips, resource contention):
```typescript
// Allow quick bursts of restarts, then stabilize
restartIntensity: { maxRestarts: 5, withinMs: 10000 }
```

**Configuration errors** (missing env vars, bad config):
```typescript
// Fail fast - these won't fix themselves
restartIntensity: { maxRestarts: 2, withinMs: 5000 }
```

**Cascading failures** (dependency down):
```typescript
// Give time for dependencies to recover
restartIntensity: { maxRestarts: 5, withinMs: 60000 }
```

### The Math Behind Restart Intensity

Think about what your settings mean in practice:

```typescript
// "Allow 3 restarts in 5 seconds"
// = Average restart rate of 0.6 restarts/second when failing
restartIntensity: { maxRestarts: 3, withinMs: 5000 }

// "Allow 10 restarts in 60 seconds"
// = Average restart rate of 0.17 restarts/second when failing
// = More time for transient issues to resolve
restartIntensity: { maxRestarts: 10, withinMs: 60000 }
```

## Monitoring Restart Intensity

You can monitor restarts using lifecycle events:

```typescript
import { Supervisor, GenServer, type LifecycleEvent } from '@hamicek/noex';

let restartCount = 0;
let lastRestartTime = Date.now();

const unsubscribe = Supervisor.onLifecycleEvent((event: LifecycleEvent) => {
  if (event.type === 'restarted') {
    restartCount++;
    const timeSinceLastRestart = Date.now() - lastRestartTime;
    lastRestartTime = Date.now();

    console.log(`[Monitor] Restart #${restartCount}`);
    console.log(`  Time since last: ${timeSinceLastRestart}ms`);
    console.log(`  Total attempt: ${event.attempt}`);

    // Alert if restarts are happening too frequently
    if (timeSinceLastRestart < 1000) {
      console.warn('  ⚠️  Warning: Rapid restart detected!');
    }
  }
});
```

## Complete Example: Demonstrating the Sliding Window

This example shows how the sliding window works in practice:

```typescript
import { Supervisor, GenServer, type GenServerBehavior, type GenServerRef } from '@hamicek/noex';

interface CrashableState {
  selfRef?: GenServerRef;
}

type CrashableCall = { type: 'setRef'; ref: GenServerRef } | { type: 'crash' };
type CrashableCast = { type: 'doCrash' };

const crashableBehavior: GenServerBehavior<CrashableState, CrashableCall, CrashableCast, void> = {
  init() {
    console.log(`  [${new Date().toISOString()}] Child started`);
    return {};
  },
  handleCall(msg, state) {
    if (msg.type === 'setRef') {
      return [undefined, { selfRef: msg.ref }];
    }
    if (msg.type === 'crash' && state.selfRef) {
      // Schedule crash via cast
      GenServer.cast(state.selfRef, { type: 'doCrash' });
    }
    return [undefined, state];
  },
  handleCast(msg, state) {
    if (msg.type === 'doCrash' && state.selfRef) {
      GenServer.stop(state.selfRef, { error: new Error('Intentional crash') });
    }
    return state;
  },
  terminate() {
    console.log(`  [${new Date().toISOString()}] Child terminated`);
  },
};

async function main() {
  console.log('Demonstrating sliding window restart intensity\n');
  console.log('Settings: maxRestarts=3, withinMs=3000 (3 restarts per 3 seconds)\n');

  const supervisor = await Supervisor.start({
    restartIntensity: {
      maxRestarts: 3,
      withinMs: 3000,
    },
    children: [
      {
        id: 'crashable',
        start: async () => {
          const ref = await GenServer.start(crashableBehavior);
          await GenServer.call(ref, { type: 'setRef', ref });
          return ref;
        },
      },
    ],
  });

  async function triggerCrash(label: string) {
    console.log(`\n${label}`);
    const child = Supervisor.getChild(supervisor, 'crashable');
    if (child && GenServer.isRunning(child.ref)) {
      await GenServer.call(child.ref, { type: 'crash' });
      // Wait for crash and restart
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  try {
    // Crash 1 - at T+0s
    await triggerCrash('Crash 1 (T+0s):');

    // Crash 2 - at T+1s
    await new Promise((resolve) => setTimeout(resolve, 900));
    await triggerCrash('Crash 2 (T+1s):');

    // Crash 3 - at T+2s
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await triggerCrash('Crash 3 (T+2s):');

    console.log('\n--- Waiting 2 seconds for crash 1 to age out of window ---');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Crash 4 - at T+4s (crash 1 has aged out, only 2 restarts in window)
    await triggerCrash('Crash 4 (T+4s) - Crash 1 aged out:');

    console.log('\n✓ Supervisor is still running because crash 1 aged out of the window');

    const info = Supervisor.getChild(supervisor, 'crashable');
    console.log(`Total restarts: ${info?.restartCount}`);
  } catch (error) {
    console.log(`\n✗ Supervisor gave up: ${(error as Error).message}`);
  }

  await Supervisor.stop(supervisor);
}

main();
```

**Output:**
```
Demonstrating sliding window restart intensity

Settings: maxRestarts=3, withinMs=3000 (3 restarts per 3 seconds)

  [2024-01-15T10:00:00.000Z] Child started

Crash 1 (T+0s):
  [2024-01-15T10:00:00.050Z] Child terminated
  [2024-01-15T10:00:00.055Z] Child started

Crash 2 (T+1s):
  [2024-01-15T10:00:01.060Z] Child terminated
  [2024-01-15T10:00:01.065Z] Child started

Crash 3 (T+2s):
  [2024-01-15T10:00:02.070Z] Child terminated
  [2024-01-15T10:00:02.075Z] Child started

--- Waiting 2 seconds for crash 1 to age out of window ---

Crash 4 (T+4s) - Crash 1 aged out:
  [2024-01-15T10:00:04.080Z] Child terminated
  [2024-01-15T10:00:04.085Z] Child started

✓ Supervisor is still running because crash 1 aged out of the window
Total restarts: 4
```

## Exercise

Create a test harness that demonstrates restart intensity behavior:

1. Create a supervisor with `maxRestarts: 3` and `withinMs: 2000`
2. Create a child that can be commanded to crash
3. Trigger 3 crashes within 2 seconds - supervisor should still be running
4. Trigger a 4th crash immediately - supervisor should throw `MaxRestartsExceededError`
5. In a second test, trigger 3 crashes, wait 2 seconds, then trigger another - should succeed

<details>
<summary>Solution</summary>

```typescript
import { Supervisor, GenServer, MaxRestartsExceededError, type GenServerBehavior, type GenServerRef } from '@hamicek/noex';

interface TestState {
  selfRef?: GenServerRef;
}

type TestCall = { type: 'setRef'; ref: GenServerRef };
type TestCast = { type: 'crash' };

const testBehavior: GenServerBehavior<TestState, TestCall, TestCast, void> = {
  init: () => ({}),
  handleCall(msg, state) {
    if (msg.type === 'setRef') {
      return [undefined, { selfRef: msg.ref }];
    }
    return [undefined, state];
  },
  handleCast(msg, state) {
    if (msg.type === 'crash' && state.selfRef) {
      GenServer.stop(state.selfRef, { error: new Error('Test crash') });
    }
    return state;
  },
};

async function crashChild(supervisor: Awaited<ReturnType<typeof Supervisor.start>>) {
  const child = Supervisor.getChild(supervisor, 'test');
  if (child && GenServer.isRunning(child.ref)) {
    GenServer.cast(child.ref, { type: 'crash' });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function createSupervisor() {
  return Supervisor.start({
    restartIntensity: { maxRestarts: 3, withinMs: 2000 },
    children: [
      {
        id: 'test',
        start: async () => {
          const ref = await GenServer.start(testBehavior);
          await GenServer.call(ref, { type: 'setRef', ref });
          return ref;
        },
      },
    ],
  });
}

async function test1_exceedLimit() {
  console.log('Test 1: Exceed restart limit');
  console.log('Expected: MaxRestartsExceededError after 4th crash\n');

  const supervisor = await createSupervisor();

  try {
    // 3 crashes within window - should be OK
    for (let i = 1; i <= 3; i++) {
      console.log(`  Crash ${i}...`);
      await crashChild(supervisor);
    }

    console.log('  After 3 crashes, supervisor still running:', Supervisor.isRunning(supervisor));

    // 4th crash should exceed limit
    console.log('  Crash 4 (should fail)...');
    await crashChild(supervisor);

    // Wait a bit for the error to propagate
    await new Promise((resolve) => setTimeout(resolve, 200));

    console.log('  ✗ Expected MaxRestartsExceededError but supervisor is still running');
  } catch (error) {
    if (error instanceof MaxRestartsExceededError) {
      console.log('  ✓ Got MaxRestartsExceededError as expected');
    } else {
      throw error;
    }
  }
}

async function test2_windowAging() {
  console.log('\nTest 2: Window aging');
  console.log('Expected: 4th crash succeeds after waiting for window to clear\n');

  const supervisor = await createSupervisor();

  try {
    // 3 crashes within window
    for (let i = 1; i <= 3; i++) {
      console.log(`  Crash ${i}...`);
      await crashChild(supervisor);
    }

    console.log('  Waiting 2.5 seconds for window to clear...');
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // 4th crash should succeed (old crashes aged out)
    console.log('  Crash 4 (should succeed)...');
    await crashChild(supervisor);

    console.log('  ✓ 4th crash succeeded - supervisor still running:', Supervisor.isRunning(supervisor));

    await Supervisor.stop(supervisor);
  } catch (error) {
    console.log('  ✗ Unexpected error:', (error as Error).message);
  }
}

async function main() {
  await test1_exceedLimit();
  await test2_windowAging();
}

main();
```

**Expected output:**
```
Test 1: Exceed restart limit
Expected: MaxRestartsExceededError after 4th crash

  Crash 1...
  Crash 2...
  Crash 3...
  After 3 crashes, supervisor still running: true
  Crash 4 (should fail)...
  ✓ Got MaxRestartsExceededError as expected

Test 2: Window aging
Expected: 4th crash succeeds after waiting for window to clear

  Crash 1...
  Crash 2...
  Crash 3...
  Waiting 2.5 seconds for window to clear...
  Crash 4 (should succeed)...
  ✓ 4th crash succeeded - supervisor still running: true
```

</details>

## Summary

- **Restart intensity** prevents infinite restart loops by limiting restarts within a time window
- Configure with `restartIntensity: { maxRestarts, withinMs }` in supervisor options
- **Defaults**: 3 restarts within 5 seconds
- Uses a **sliding window** - old restarts age out, allowing recovery after bursts
- When limit exceeded, supervisor throws `MaxRestartsExceededError` and stops
- **Choose values based on service type**:
  - Critical services: low limits, fail fast
  - Background workers: higher limits, tolerate transient failures
  - Caches: high limits, aggressive recovery
- Monitor restarts using `Supervisor.onLifecycleEvent()`

Restart intensity is your safety net - it catches runaway failures and forces you to address the root cause rather than letting the system thrash indefinitely.

---

Next: [Supervision Trees](./05-supervision-trees.md)
