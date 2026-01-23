# TimerService API Reference

The `TimerService` provides durable timers that survive process restarts. Unlike `GenServer.sendAfter()` which is non-durable (lost on restart), this service persists timer entries via a `StorageAdapter`. Supports one-shot and repeating timers.

## Import

```typescript
import { TimerService } from 'noex';
```

## Types

### TimerServiceRef

Opaque reference to a running TimerService instance.

```typescript
type TimerServiceRef = GenServerRef<TimerServiceState, TimerCallMsg, TimerCastMsg, TimerCallReply>;
```

### DurableTimerOptions

Options for `TimerService.start()`.

```typescript
interface DurableTimerOptions {
  /** Storage adapter for timer persistence */
  readonly adapter: StorageAdapter;

  /** How often to check for expired timers (ms). @default 1000 */
  readonly checkIntervalMs?: number;

  /** Optional name for registry registration */
  readonly name?: string;
}
```

### TimerEntry

A persisted timer entry.

```typescript
interface TimerEntry {
  /** Unique timer identifier */
  readonly id: string;

  /** Unix timestamp (ms) when the timer should fire */
  readonly fireAt: number;

  /** Target process reference */
  readonly targetRef: { readonly id: string; readonly nodeId?: string };

  /** Message to deliver via GenServer.cast() */
  readonly message: unknown;

  /** If set, the timer repeats with this interval (ms) */
  readonly repeat?: number;
}
```

### ScheduleOptions

Options for `TimerService.schedule()`.

```typescript
interface ScheduleOptions {
  /** If set, the timer repeats with this interval (ms) */
  readonly repeat?: number;
}
```

---

## Methods

### start()

Starts a new DurableTimerService instance. Loads any previously persisted timers from the adapter and begins periodic checking for expired timers.

```typescript
async start(options: DurableTimerOptions): Promise<TimerServiceRef>
```

**Parameters:**
- `options` - Service configuration
  - `adapter` - StorageAdapter for timer persistence (required)
  - `checkIntervalMs` - Interval for checking expired timers (default: 1000ms)
  - `name` - Register under this name in Registry

**Returns:** Promise resolving to a TimerServiceRef

**Example:**
```typescript
import { TimerService, MemoryAdapter } from 'noex';

const timers = await TimerService.start({
  adapter: new MemoryAdapter(),
  checkIntervalMs: 500,
});
```

---

### schedule()

Schedules a durable timer that delivers a cast message to the target after the specified delay.

```typescript
async schedule(
  ref: TimerServiceRef,
  targetRef: GenServerRef,
  message: unknown,
  delayMs: number,
  options?: ScheduleOptions,
): Promise<string>
```

**Parameters:**
- `ref` - TimerService reference
- `targetRef` - Target process to receive the message
- `message` - Cast message to deliver
- `delayMs` - Delay in milliseconds before first delivery
- `options` - Optional schedule configuration
  - `repeat` - If set, the timer repeats at this interval (ms)

**Returns:** Timer ID for later cancellation

**Example:**
```typescript
// One-shot timer
const timerId = await TimerService.schedule(timers, workerRef, { type: 'cleanup' }, 60000);

// Repeating timer (every 5 seconds)
const tickId = await TimerService.schedule(
  timers, monitorRef,
  { type: 'healthcheck' },
  5000,
  { repeat: 5000 },
);
```

---

### cancel()

Cancels a previously scheduled durable timer.

```typescript
async cancel(ref: TimerServiceRef, timerId: string): Promise<boolean>
```

**Parameters:**
- `ref` - TimerService reference
- `timerId` - Timer ID returned by `schedule()`

**Returns:** `true` if the timer was pending and was cancelled, `false` otherwise

**Example:**
```typescript
const wasCancelled = await TimerService.cancel(timers, timerId);
```

---

### get()

Returns a specific timer entry by ID.

```typescript
async get(ref: TimerServiceRef, timerId: string): Promise<TimerEntry | undefined>
```

**Parameters:**
- `ref` - TimerService reference
- `timerId` - Timer ID to look up

**Returns:** The timer entry, or `undefined` if not found

**Example:**
```typescript
const entry = await TimerService.get(timers, timerId);
if (entry) {
  console.log(`Timer fires at: ${new Date(entry.fireAt)}`);
}
```

---

### getAll()

Returns all pending timer entries.

```typescript
async getAll(ref: TimerServiceRef): Promise<readonly TimerEntry[]>
```

**Parameters:**
- `ref` - TimerService reference

**Returns:** Array of all pending timer entries

**Example:**
```typescript
const pending = await TimerService.getAll(timers);
console.log(`${pending.length} timers pending`);
```

---

### isRunning()

Checks if the TimerService is running.

```typescript
isRunning(ref: TimerServiceRef): boolean
```

**Parameters:**
- `ref` - TimerService reference

**Returns:** `true` if running

---

### stop()

Stops the timer service. Persisted timers remain in storage and will be restored on next start.

```typescript
async stop(ref: TimerServiceRef): Promise<void>
```

**Parameters:**
- `ref` - TimerService reference

**Example:**
```typescript
await TimerService.stop(timers);
```

---

## Persistence Behavior

- **On schedule:** Timer entry is immediately persisted to the adapter
- **On cancel:** Timer entry is removed from storage
- **On fire (one-shot):** Timer entry is removed from storage after delivery
- **On fire (repeat):** Timer entry is updated with new `fireAt` and re-persisted
- **On restart:** All timers are loaded from the adapter; overdue timers fire on the first tick

---

## Complete Example

```typescript
import { GenServer, TimerService, MemoryAdapter, type GenServerBehavior } from 'noex';

// Worker that processes periodic tasks
const workerBehavior: GenServerBehavior<number, 'getCount', { type: 'process' }, number> = {
  init: () => 0,
  handleCall: (msg, state) => [state, state],
  handleCast: (msg, state) => {
    if (msg.type === 'process') {
      console.log(`Processing task #${state + 1}`);
      return state + 1;
    }
    return state;
  },
};

async function main() {
  const adapter = new MemoryAdapter();

  // Start worker and timer service
  const worker = await GenServer.start(workerBehavior);
  const timers = await TimerService.start({ adapter, checkIntervalMs: 500 });

  // Schedule recurring task every 2 seconds
  const timerId = await TimerService.schedule(
    timers, worker,
    { type: 'process' },
    2000,
    { repeat: 2000 },
  );

  // After some time, cancel the recurring task
  setTimeout(async () => {
    await TimerService.cancel(timers, timerId);
    const count = await GenServer.call(worker, 'getCount');
    console.log(`Processed ${count} tasks total`);

    await TimerService.stop(timers);
    await GenServer.stop(worker);
  }, 10000);
}
```

---

## sendAfter vs TimerService

| Feature | `GenServer.sendAfter()` | `TimerService.schedule()` |
|---------|------------------------|---------------------------|
| Durability | Non-durable (lost on restart) | Durable (persisted to storage) |
| Overhead | Minimal (raw setTimeout) | Higher (GenServer + persistence) |
| Repeat | Manual re-scheduling | Built-in `repeat` option |
| Cancellation | Synchronous | Async (via GenServer call) |
| Use case | Ephemeral delays | Critical scheduled tasks |

---

## Related

- [GenServer API](./genserver.md) - sendAfter() for non-durable timers
- [Cache API](./cache.md) - Another GenServer-based service
- [Types Reference](./types.md) - TimerRef type
