# Supervisor API Reference

The `Supervisor` object provides methods for managing supervision trees with automatic child restart capabilities.

## Import

```typescript
import { Supervisor } from 'noex';
```

## Types

### SupervisorRef

Opaque reference to a running Supervisor instance.

```typescript
interface SupervisorRef {
  readonly id: string;
}
```

### SupervisorOptions

Options for `Supervisor.start()`.

```typescript
interface SupervisorOptions {
  readonly strategy?: SupervisorStrategy;
  readonly children?: readonly ChildSpec[];
  readonly restartIntensity?: RestartIntensity;
  readonly name?: string;
}
```

### SupervisorStrategy

Strategy for handling child failures.

```typescript
type SupervisorStrategy = 'one_for_one' | 'one_for_all' | 'rest_for_one';
```

| Strategy | Behavior |
|----------|----------|
| `'one_for_one'` | Only restart the failed child (default) |
| `'one_for_all'` | Restart all children when one fails |
| `'rest_for_one'` | Restart failed child and all children started after it |

### ChildSpec

Specification for a child process.

```typescript
interface ChildSpec<State = unknown, CallMsg = unknown, CastMsg = unknown, CallReply = unknown> {
  readonly id: string;
  readonly start: () => Promise<GenServerRef<State, CallMsg, CastMsg, CallReply>>;
  readonly restart?: ChildRestartStrategy;
  readonly shutdownTimeout?: number;
}
```

### ChildRestartStrategy

When to restart a child.

```typescript
type ChildRestartStrategy = 'permanent' | 'transient' | 'temporary';
```

| Strategy | Behavior |
|----------|----------|
| `'permanent'` | Always restart (default) |
| `'transient'` | Restart only on abnormal exit |
| `'temporary'` | Never restart |

### RestartIntensity

Configuration for restart limiting.

```typescript
interface RestartIntensity {
  readonly maxRestarts: number;  // default: 3
  readonly withinMs: number;     // default: 5000
}
```

### ChildInfo

Information about a running child.

```typescript
interface ChildInfo {
  readonly id: string;
  readonly ref: GenServerRef;
  readonly spec: ChildSpec;
  readonly restartCount: number;
}
```

---

## Methods

### start()

Starts a new Supervisor with the given options.

```typescript
async start(options?: SupervisorOptions): Promise<SupervisorRef>
```

**Parameters:**
- `options` - Supervisor configuration
  - `strategy` - Restart strategy (default: `'one_for_one'`)
  - `children` - Initial child specifications
  - `restartIntensity` - Restart limiting configuration
  - `name` - Register supervisor under this name

**Returns:** Promise resolving to a SupervisorRef

**Throws:**
- `InitializationError` - If any child fails to start
- `MaxRestartsExceededError` - If restart intensity exceeded during startup

**Example:**
```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  restartIntensity: { maxRestarts: 5, withinMs: 60000 },
  children: [
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },
    { id: 'worker', start: () => GenServer.start(workerBehavior) },
  ],
});
```

---

### stop()

Gracefully stops the supervisor and all its children.

```typescript
async stop(ref: SupervisorRef, reason?: TerminateReason): Promise<void>
```

**Parameters:**
- `ref` - Reference to the supervisor to stop
- `reason` - Reason for stopping (default: `'normal'`)

**Returns:** Promise that resolves when supervisor and all children are stopped

**Example:**
```typescript
await Supervisor.stop(supervisor);

// With reason
await Supervisor.stop(supervisor, 'shutdown');
```

Children are stopped in reverse order (last started = first stopped).

---

### startChild()

Dynamically starts a new child under the supervisor.

```typescript
async startChild(ref: SupervisorRef, spec: ChildSpec): Promise<GenServerRef>
```

**Parameters:**
- `ref` - Reference to the supervisor
- `spec` - Child specification

**Returns:** Promise resolving to the child's GenServerRef

**Throws:**
- `DuplicateChildError` - If child with same ID already exists

**Example:**
```typescript
const workerRef = await Supervisor.startChild(supervisor, {
  id: 'worker-1',
  start: () => GenServer.start(workerBehavior),
  restart: 'permanent',
});
```

---

### terminateChild()

Terminates a specific child.

```typescript
async terminateChild(ref: SupervisorRef, childId: string): Promise<void>
```

**Parameters:**
- `ref` - Reference to the supervisor
- `childId` - ID of the child to terminate

**Returns:** Promise that resolves when child is stopped

**Throws:**
- `ChildNotFoundError` - If child not found

**Example:**
```typescript
await Supervisor.terminateChild(supervisor, 'worker-1');
```

---

### restartChild()

Manually restarts a specific child.

```typescript
async restartChild(ref: SupervisorRef, childId: string): Promise<GenServerRef>
```

**Parameters:**
- `ref` - Reference to the supervisor
- `childId` - ID of the child to restart

**Returns:** Promise resolving to the new child GenServerRef

**Throws:**
- `ChildNotFoundError` - If child not found

**Example:**
```typescript
const newRef = await Supervisor.restartChild(supervisor, 'cache');
```

---

### getChildren()

Returns information about all children.

```typescript
getChildren(ref: SupervisorRef): readonly ChildInfo[]
```

**Parameters:**
- `ref` - Reference to the supervisor

**Returns:** Array of child information

**Example:**
```typescript
const children = Supervisor.getChildren(supervisor);
for (const child of children) {
  console.log(`${child.id}: restarts=${child.restartCount}`);
}
```

---

### getChild()

Returns information about a specific child.

```typescript
getChild(ref: SupervisorRef, childId: string): ChildInfo | undefined
```

**Parameters:**
- `ref` - Reference to the supervisor
- `childId` - ID of the child

**Returns:** Child information or undefined if not found

**Example:**
```typescript
const cache = Supervisor.getChild(supervisor, 'cache');
if (cache) {
  console.log(`Cache restarts: ${cache.restartCount}`);
}
```

---

### countChildren()

Returns the number of children.

```typescript
countChildren(ref: SupervisorRef): number
```

**Parameters:**
- `ref` - Reference to the supervisor

**Returns:** Number of children

**Example:**
```typescript
const count = Supervisor.countChildren(supervisor);
console.log(`Managing ${count} children`);
```

---

### isRunning()

Checks if a supervisor is currently running.

```typescript
isRunning(ref: SupervisorRef): boolean
```

**Parameters:**
- `ref` - Reference to check

**Returns:** `true` if the supervisor is running

**Example:**
```typescript
if (Supervisor.isRunning(supervisor)) {
  await Supervisor.startChild(supervisor, spec);
}
```

---

### onLifecycleEvent()

Registers a handler for lifecycle events.

```typescript
onLifecycleEvent(handler: LifecycleHandler): () => void
```

**Parameters:**
- `handler` - Function called for each lifecycle event

**Returns:** Unsubscribe function

**Example:**
```typescript
const unsubscribe = Supervisor.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Supervisor started: ${event.ref.id}`);
      break;
    case 'restarted':
      console.log(`Child restarted, attempt #${event.attempt}`);
      break;
    case 'terminated':
      console.log(`Terminated: ${event.reason}`);
      break;
  }
});

// Later
unsubscribe();
```

---

## Error Classes

### MaxRestartsExceededError

```typescript
class MaxRestartsExceededError extends Error {
  readonly name = 'MaxRestartsExceededError';
  readonly supervisorId: string;
  readonly maxRestarts: number;
  readonly withinMs: number;
}
```

### DuplicateChildError

```typescript
class DuplicateChildError extends Error {
  readonly name = 'DuplicateChildError';
  readonly supervisorId: string;
  readonly childId: string;
}
```

### ChildNotFoundError

```typescript
class ChildNotFoundError extends Error {
  readonly name = 'ChildNotFoundError';
  readonly supervisorId: string;
  readonly childId: string;
}
```

---

## Complete Example

```typescript
import { Supervisor, GenServer, type GenServerBehavior, type ChildSpec } from 'noex';

// Worker behavior
const workerBehavior: GenServerBehavior<number, 'status', 'work', string> = {
  init: () => 0,
  handleCall: (msg, state) => [`Processed ${state} items`, state],
  handleCast: (msg, state) => state + 1,
  terminate: (reason, state) => {
    console.log(`Worker terminated after processing ${state} items`);
  },
};

// Create supervisor with workers
async function startWorkerPool(size: number) {
  const children: ChildSpec[] = [];

  for (let i = 0; i < size; i++) {
    children.push({
      id: `worker-${i}`,
      start: () => GenServer.start(workerBehavior),
      restart: 'permanent',
      shutdownTimeout: 5000,
    });
  }

  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 10, withinMs: 60000 },
    children,
  });

  return supervisor;
}

// Usage
async function main() {
  const pool = await startWorkerPool(3);

  // List workers
  const workers = Supervisor.getChildren(pool);
  console.log(`Started ${workers.length} workers`);

  // Send work to all workers
  for (const worker of workers) {
    GenServer.cast(worker.ref, 'work');
  }

  // Add another worker dynamically
  await Supervisor.startChild(pool, {
    id: 'worker-3',
    start: () => GenServer.start(workerBehavior),
  });

  // Check worker status
  for (const worker of Supervisor.getChildren(pool)) {
    const status = await GenServer.call(worker.ref, 'status');
    console.log(`${worker.id}: ${status}`);
  }

  // Shutdown
  await Supervisor.stop(pool);
}
```

## Related

- [Supervisor Concepts](../concepts/supervisor.md) - Understanding supervision
- [GenServer API](./genserver.md) - Child process API
- [Errors Reference](./errors.md) - All error classes
