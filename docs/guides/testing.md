# Testing noex Applications

This guide covers best practices and patterns for testing applications built with noex. We'll cover unit testing GenServers, testing supervisors, integration testing, and common testing utilities.

## Overview

Testing noex applications involves:
- **Unit tests** for individual GenServer behaviors
- **Supervisor tests** for restart behavior and child management
- **Integration tests** for multi-process interactions
- **Test isolation** to prevent state leaking between tests

noex is designed with testability in mind - all components can be tested in isolation without complex setup.

---

## Setup

### Test Framework

noex works with any JavaScript test framework. This guide uses [Vitest](https://vitest.dev/), but patterns apply to Jest, Mocha, etc.

```bash
npm install -D vitest
```

### Basic Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenServer, Supervisor, Registry } from 'noex';

describe('MyService', () => {
  beforeEach(() => {
    // Reset internal state
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
  });

  afterEach(async () => {
    // Clean up any running servers
    Registry._clear();
  });

  it('does something', async () => {
    // Test code
  });
});
```

---

## Unit Testing GenServers

### Testing Behavior Functions

Test your behavior handlers in isolation:

```typescript
import { describe, it, expect } from 'vitest';

// The behavior to test
const counterBehavior = {
  init: () => 0,
  handleCall: (msg, state) => {
    if (msg === 'get') return [state, state];
    if (msg.type === 'add') return [state + msg.value, state + msg.value];
    return [null, state];
  },
  handleCast: (msg, state) => {
    if (msg === 'inc') return state + 1;
    if (msg === 'dec') return state - 1;
    return state;
  },
};

describe('counterBehavior', () => {
  describe('init', () => {
    it('returns initial state of 0', () => {
      expect(counterBehavior.init()).toBe(0);
    });
  });

  describe('handleCall', () => {
    it('returns current state for get', () => {
      const [reply, newState] = counterBehavior.handleCall('get', 5);
      expect(reply).toBe(5);
      expect(newState).toBe(5);
    });

    it('adds value for add message', () => {
      const [reply, newState] = counterBehavior.handleCall(
        { type: 'add', value: 10 },
        5
      );
      expect(reply).toBe(15);
      expect(newState).toBe(15);
    });
  });

  describe('handleCast', () => {
    it('increments state for inc', () => {
      expect(counterBehavior.handleCast('inc', 5)).toBe(6);
    });

    it('decrements state for dec', () => {
      expect(counterBehavior.handleCast('dec', 5)).toBe(4);
    });
  });
});
```

### Testing Running GenServers

Test the full GenServer lifecycle:

```typescript
import { GenServer } from 'noex';

describe('Counter GenServer', () => {
  let counterRef;

  beforeEach(async () => {
    counterRef = await GenServer.start(counterBehavior);
  });

  afterEach(async () => {
    if (GenServer.isRunning(counterRef)) {
      await GenServer.stop(counterRef);
    }
  });

  it('starts with initial state', async () => {
    const value = await GenServer.call(counterRef, 'get');
    expect(value).toBe(0);
  });

  it('handles call messages', async () => {
    const result = await GenServer.call(counterRef, { type: 'add', value: 5 });
    expect(result).toBe(5);
  });

  it('handles cast messages', async () => {
    GenServer.cast(counterRef, 'inc');
    GenServer.cast(counterRef, 'inc');

    // Wait for casts to process
    await new Promise((r) => setTimeout(r, 50));

    const value = await GenServer.call(counterRef, 'get');
    expect(value).toBe(2);
  });

  it('processes messages in order', async () => {
    GenServer.cast(counterRef, 'inc');
    GenServer.cast(counterRef, 'inc');
    const afterInc = await GenServer.call(counterRef, 'get');

    GenServer.cast(counterRef, 'dec');
    const afterDec = await GenServer.call(counterRef, 'get');

    expect(afterInc).toBe(2);
    expect(afterDec).toBe(1);
  });
});
```

### Testing Async Initialization

```typescript
describe('async initialization', () => {
  it('waits for async init to complete', async () => {
    const behavior = {
      init: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { ready: true, data: 'loaded' };
      },
      handleCall: (_, state) => [state.data, state],
      handleCast: (_, state) => state,
    };

    const ref = await GenServer.start(behavior);
    const data = await GenServer.call(ref, 'get');

    expect(data).toBe('loaded');

    await GenServer.stop(ref);
  });

  it('handles init failure', async () => {
    const behavior = {
      init: async () => {
        throw new Error('Init failed');
      },
      handleCall: () => [null, null],
      handleCast: (_, state) => state,
    };

    await expect(GenServer.start(behavior)).rejects.toThrow('Init failed');
  });

  it('handles init timeout', async () => {
    const behavior = {
      init: async () => {
        await new Promise((r) => setTimeout(r, 10000)); // Very slow
        return {};
      },
      handleCall: () => [null, null],
      handleCast: (_, state) => state,
    };

    await expect(
      GenServer.start(behavior, { initTimeout: 100 })
    ).rejects.toThrow();
  });
});
```

### Testing Error Handling

```typescript
describe('error handling', () => {
  it('propagates errors from handleCall', async () => {
    const behavior = {
      init: () => null,
      handleCall: () => {
        throw new Error('Handler error');
      },
      handleCast: (_, state) => state,
    };

    const ref = await GenServer.start(behavior);

    await expect(GenServer.call(ref, 'anything')).rejects.toThrow('Handler error');

    await GenServer.stop(ref);
  });

  it('continues processing after cast error', async () => {
    let processedCount = 0;
    const behavior = {
      init: () => 0,
      handleCall: (_, state) => [state, state],
      handleCast: (msg, state) => {
        processedCount++;
        if (msg === 'error') throw new Error('Cast error');
        return state + 1;
      },
    };

    const ref = await GenServer.start(behavior);

    GenServer.cast(ref, 'inc');
    GenServer.cast(ref, 'error');  // Will throw but server continues
    GenServer.cast(ref, 'inc');

    await new Promise((r) => setTimeout(r, 100));

    const value = await GenServer.call(ref, 'get');
    expect(value).toBe(2);  // Both 'inc' processed
    expect(processedCount).toBe(3);

    await GenServer.stop(ref);
  });
});
```

---

## Testing Supervisors

### Basic Supervisor Tests

```typescript
import { Supervisor, GenServer } from 'noex';

describe('Supervisor', () => {
  let supervisorRef;

  afterEach(async () => {
    if (supervisorRef && Supervisor.isRunning(supervisorRef)) {
      await Supervisor.stop(supervisorRef);
    }
  });

  it('starts with children', async () => {
    supervisorRef = await Supervisor.start({
      strategy: 'one_for_one',
      children: [
        { id: 'child1', start: () => GenServer.start(counterBehavior) },
        { id: 'child2', start: () => GenServer.start(counterBehavior) },
      ],
    });

    expect(Supervisor.countChildren(supervisorRef)).toBe(2);
  });

  it('allows dynamic child management', async () => {
    supervisorRef = await Supervisor.start();

    await Supervisor.startChild(supervisorRef, {
      id: 'dynamic',
      start: () => GenServer.start(counterBehavior),
    });

    expect(Supervisor.countChildren(supervisorRef)).toBe(1);

    await Supervisor.terminateChild(supervisorRef, 'dynamic');

    expect(Supervisor.countChildren(supervisorRef)).toBe(0);
  });
});
```

### Testing Restart Behavior

```typescript
describe('restart strategies', () => {
  // Helper to crash a child
  function crashChild(ref) {
    GenServer._forceTerminate(ref, { error: new Error('Simulated crash') });
  }

  // Helper to wait for restart
  async function waitForRestart(supervisor, childId, originalRef, timeout = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const child = Supervisor.getChild(supervisor, childId);
      if (child && child.ref.id !== originalRef.id) {
        return child.ref;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('Timeout waiting for restart');
  }

  it('restarts crashed child with one_for_one', async () => {
    const supervisor = await Supervisor.start({
      strategy: 'one_for_one',
      children: [
        { id: 'child1', start: () => GenServer.start(counterBehavior) },
        { id: 'child2', start: () => GenServer.start(counterBehavior) },
      ],
    });

    const child1Before = Supervisor.getChild(supervisor, 'child1');
    const child2Before = Supervisor.getChild(supervisor, 'child2');

    // Crash child1
    crashChild(child1Before.ref);

    // Wait for restart
    const newChild1Ref = await waitForRestart(
      supervisor,
      'child1',
      child1Before.ref
    );

    // child1 should be new
    expect(newChild1Ref.id).not.toBe(child1Before.ref.id);

    // child2 should be unchanged
    const child2After = Supervisor.getChild(supervisor, 'child2');
    expect(child2After.ref.id).toBe(child2Before.ref.id);

    await Supervisor.stop(supervisor);
  });

  it('restarts all children with one_for_all', async () => {
    const supervisor = await Supervisor.start({
      strategy: 'one_for_all',
      children: [
        { id: 'child1', start: () => GenServer.start(counterBehavior) },
        { id: 'child2', start: () => GenServer.start(counterBehavior) },
      ],
    });

    const child1Before = Supervisor.getChild(supervisor, 'child1');
    const child2Before = Supervisor.getChild(supervisor, 'child2');

    // Crash child1
    crashChild(child1Before.ref);

    // Wait for child1 restart
    await waitForRestart(supervisor, 'child1', child1Before.ref);

    // Both should have new refs
    const child1After = Supervisor.getChild(supervisor, 'child1');
    const child2After = Supervisor.getChild(supervisor, 'child2');

    expect(child1After.ref.id).not.toBe(child1Before.ref.id);
    expect(child2After.ref.id).not.toBe(child2Before.ref.id);

    await Supervisor.stop(supervisor);
  });

  it('tracks restart count', async () => {
    const supervisor = await Supervisor.start({
      strategy: 'one_for_one',
      restartIntensity: { maxRestarts: 10, withinMs: 60000 },
      children: [
        { id: 'child', start: () => GenServer.start(counterBehavior) },
      ],
    });

    const childBefore = Supervisor.getChild(supervisor, 'child');
    expect(childBefore.restartCount).toBe(0);

    // Crash and wait for restart
    crashChild(childBefore.ref);
    await waitForRestart(supervisor, 'child', childBefore.ref);

    const childAfter = Supervisor.getChild(supervisor, 'child');
    expect(childAfter.restartCount).toBe(1);

    await Supervisor.stop(supervisor);
  });
});
```

### Testing Child Restart Strategies

```typescript
describe('child restart strategies', () => {
  it('permanent child is always restarted', async () => {
    const supervisor = await Supervisor.start({
      children: [{
        id: 'permanent',
        start: () => GenServer.start(counterBehavior),
        restart: 'permanent',
      }],
    });

    const before = Supervisor.getChild(supervisor, 'permanent');
    GenServer._forceTerminate(before.ref, 'normal');

    await waitForRestart(supervisor, 'permanent', before.ref);

    expect(Supervisor.getChild(supervisor, 'permanent')).toBeDefined();

    await Supervisor.stop(supervisor);
  });

  it('temporary child is never restarted', async () => {
    const supervisor = await Supervisor.start({
      children: [{
        id: 'temporary',
        start: () => GenServer.start(counterBehavior),
        restart: 'temporary',
      }],
    });

    const before = Supervisor.getChild(supervisor, 'temporary');
    GenServer._forceTerminate(before.ref, 'normal');

    await new Promise((r) => setTimeout(r, 100));

    expect(Supervisor.getChild(supervisor, 'temporary')).toBeUndefined();

    await Supervisor.stop(supervisor);
  });
});
```

---

## Integration Testing

### Testing Process Communication

```typescript
describe('process communication', () => {
  it('services communicate via Registry', async () => {
    // Start services
    const userService = await GenServer.start(userBehavior);
    const orderService = await GenServer.start(
      createOrderBehavior(userService)
    );

    Registry.register('user-service', userService);
    Registry.register('order-service', orderService);

    // Test communication
    await GenServer.call(userService, {
      type: 'create',
      user: { id: '1', name: 'Alice' },
    });

    const order = await GenServer.call(orderService, {
      type: 'create_order',
      userId: '1',
      items: ['item1'],
    });

    expect(order.userId).toBe('1');

    // Cleanup
    await GenServer.stop(orderService);
    await GenServer.stop(userService);
    Registry._clear();
  });
});
```

### Testing EventBus

```typescript
import { EventBus } from 'noex';

describe('EventBus integration', () => {
  it('delivers events to subscribers', async () => {
    const bus = await EventBus.start();
    const received = [];

    await EventBus.subscribe(bus, 'user.*', (msg) => {
      received.push(msg);
    });

    EventBus.publish(bus, 'user.created', { id: '1' });
    EventBus.publish(bus, 'user.updated', { id: '1' });
    EventBus.publish(bus, 'order.created', { id: '2' });  // Not matched

    // Wait for delivery
    await EventBus.publishSync(bus, 'sync', null);

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ id: '1' });

    await EventBus.stop(bus);
  });
});
```

### Testing Full Supervision Trees

```typescript
describe('supervision tree', () => {
  it('handles cascading failures', async () => {
    // Build tree
    const workerSupervisor = await Supervisor.start({
      strategy: 'one_for_one',
      children: [
        { id: 'worker1', start: () => GenServer.start(workerBehavior) },
        { id: 'worker2', start: () => GenServer.start(workerBehavior) },
      ],
    });

    const root = await Supervisor.start({
      strategy: 'one_for_one',
      children: [
        { id: 'workers', start: async () => workerSupervisor },
      ],
    });

    // Verify structure
    expect(Supervisor.countChildren(root)).toBe(1);
    expect(Supervisor.countChildren(workerSupervisor)).toBe(2);

    // Crash a worker
    const worker1 = Supervisor.getChild(workerSupervisor, 'worker1');
    GenServer._forceTerminate(worker1.ref, { error: new Error('crash') });

    // Wait and verify only worker1 restarted
    await new Promise((r) => setTimeout(r, 200));

    expect(Supervisor.countChildren(workerSupervisor)).toBe(2);

    await Supervisor.stop(root);
  });
});
```

---

## Test Utilities

### Cleanup Helper

```typescript
// test-helpers.ts
import { GenServer, Supervisor, Registry } from 'noex';

export async function cleanupAll() {
  await Supervisor._clearAll();
  Registry._clearLifecycleHandler();
  Registry._clear();
  GenServer._clearLifecycleHandlers();
  Supervisor._clearLifecycleHandlers();
}

export function resetCounters() {
  GenServer._resetIdCounter();
  Supervisor._resetIdCounter();
}
```

### Wait Helpers

```typescript
// Wait for a condition
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 1000,
  interval = 10
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('Timeout waiting for condition');
}

// Wait for cast messages to be processed
export async function flushCasts(ref: GenServerRef): Promise<void> {
  // A call will be queued after all pending casts
  await GenServer.call(ref, 'get');
}
```

### Spy on Lifecycle Events

```typescript
export function collectLifecycleEvents() {
  const events: LifecycleEvent[] = [];

  const unsubGenServer = GenServer.onLifecycleEvent((e) => events.push(e));
  const unsubSupervisor = Supervisor.onLifecycleEvent((e) => events.push(e));

  return {
    events,
    cleanup: () => {
      unsubGenServer();
      unsubSupervisor();
    },
  };
}

// Usage
it('tracks lifecycle', async () => {
  const { events, cleanup } = collectLifecycleEvents();

  const ref = await GenServer.start(behavior);
  await GenServer.stop(ref);

  expect(events).toHaveLength(2);
  expect(events[0].type).toBe('started');
  expect(events[1].type).toBe('terminated');

  cleanup();
});
```

---

## Best Practices

### 1. Always Clean Up

```typescript
afterEach(async () => {
  // Stop all servers to prevent test pollution
  await cleanupAll();
});
```

### 2. Use Timeouts for Async Operations

```typescript
it('handles slow operation', async () => {
  // Don't rely on arbitrary delays
  await waitFor(() => someCondition(), 1000);
});
```

### 3. Test Behaviors in Isolation First

```typescript
// First test pure functions
describe('behavior handlers', () => {
  it('handleCall returns correct state', () => {
    const [reply, state] = behavior.handleCall(msg, initialState);
    expect(reply).toBe(expected);
  });
});

// Then test with GenServer
describe('running server', () => {
  it('processes messages correctly', async () => {
    const ref = await GenServer.start(behavior);
    // ...
  });
});
```

### 4. Use Factory Functions for Test Data

```typescript
function createTestUser(overrides = {}) {
  return {
    id: 'test-1',
    name: 'Test User',
    email: 'test@example.com',
    ...overrides,
  };
}

function createTestBehavior(options = {}) {
  return {
    init: () => ({ ...defaultState, ...options.initialState }),
    handleCall: options.handleCall || defaultHandleCall,
    handleCast: options.handleCast || defaultHandleCast,
  };
}
```

### 5. Test Error Paths

```typescript
describe('error handling', () => {
  it('handles missing user', async () => {
    const result = await GenServer.call(userService, {
      type: 'get',
      id: 'nonexistent',
    });
    expect(result).toBeNull();
  });

  it('throws on invalid input', async () => {
    await expect(
      GenServer.call(userService, { type: 'get', id: null })
    ).rejects.toThrow();
  });
});
```

### 6. Mock External Dependencies

```typescript
// Create behavior with injected dependencies
function createServiceBehavior(deps: {
  database: DatabaseClient;
  logger: Logger;
}) {
  return {
    init: () => ({ db: deps.database }),
    handleCall: async (msg, state) => {
      deps.logger.log('Handling call');
      const result = await state.db.query(msg.query);
      return [result, state];
    },
    handleCast: (_, state) => state,
  };
}

// In tests
it('queries database', async () => {
  const mockDb = { query: vi.fn().mockResolvedValue({ data: 'test' }) };
  const mockLogger = { log: vi.fn() };

  const behavior = createServiceBehavior({
    database: mockDb,
    logger: mockLogger,
  });

  const ref = await GenServer.start(behavior);
  const result = await GenServer.call(ref, { query: 'SELECT *' });

  expect(mockDb.query).toHaveBeenCalledWith('SELECT *');
  expect(result).toEqual({ data: 'test' });

  await GenServer.stop(ref);
});
```

---

## Related

- [Building Services Guide](./building-services.md) - Creating testable services
- [GenServer API Reference](../api/genserver.md) - API including test helpers
- [Supervisor API Reference](../api/supervisor.md) - Supervisor test methods
