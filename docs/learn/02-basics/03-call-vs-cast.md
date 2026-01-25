# Call vs Cast

GenServer provides two ways to send messages: **call** for synchronous request/reply and **cast** for asynchronous fire-and-forget. Choosing the right one is crucial for building responsive, reliable applications.

In this chapter, you'll learn when to use each, how to handle timeouts and errors, and common patterns for combining them effectively.

## What You'll Learn

- The difference between `call()` and `cast()`
- When to use synchronous vs asynchronous messaging
- How to configure and handle timeouts
- Error handling patterns for both message types
- Best practices for message design

## Call: Synchronous Request/Reply

`GenServer.call()` sends a message and **waits for a reply**. The caller blocks until the server processes the message and returns a response (or until timeout).

```typescript
import { GenServer, type GenServerBehavior } from '@hamicek/noex';

interface BankAccountState {
  balance: number;
}

type CallMsg =
  | { type: 'getBalance' }
  | { type: 'withdraw'; amount: number };

type CastMsg = { type: 'deposit'; amount: number };

type Reply = number | { success: boolean; newBalance: number };

const bankAccountBehavior: GenServerBehavior<BankAccountState, CallMsg, CastMsg, Reply> = {
  init() {
    return { balance: 1000 };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'getBalance':
        // Return current balance
        return [state.balance, state];

      case 'withdraw': {
        if (state.balance < msg.amount) {
          // Insufficient funds - return failure
          return [{ success: false, newBalance: state.balance }, state];
        }
        const newBalance = state.balance - msg.amount;
        return [
          { success: true, newBalance },
          { balance: newBalance },
        ];
      }
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'deposit') {
      return { balance: state.balance + msg.amount };
    }
    return state;
  },
};

async function main() {
  const account = await GenServer.start(bankAccountBehavior);

  // call() waits for the response
  const balance = await GenServer.call(account, { type: 'getBalance' });
  console.log('Current balance:', balance); // 1000

  const result = await GenServer.call(account, { type: 'withdraw', amount: 500 });
  console.log('Withdrawal result:', result); // { success: true, newBalance: 500 }

  await GenServer.stop(account);
}
```

### Key Characteristics of Call

1. **Synchronous semantics**: The caller awaits the response
2. **Guaranteed ordering**: Messages are processed in the order they arrive
3. **Reply required**: `handleCall` must return `[reply, newState]`
4. **Timeout-aware**: Calls can timeout if the server doesn't respond

### When to Use Call

Use `call()` when you need:

- **A response**: Getting data, confirming an operation succeeded
- **Ordering guarantees**: Ensuring one operation completes before starting another
- **Error feedback**: Knowing if an operation failed and why
- **Backpressure**: Naturally throttling callers by making them wait

```typescript
// Good use cases for call()
const user = await GenServer.call(userService, { type: 'getUser', id: 123 });
const result = await GenServer.call(paymentService, { type: 'charge', amount: 99.99 });
const isValid = await GenServer.call(authService, { type: 'validateToken', token: 'xyz' });
```

## Cast: Asynchronous Fire-and-Forget

`GenServer.cast()` sends a message and **returns immediately**. The caller doesn't wait for the server to process the message or receive any confirmation.

```typescript
async function main() {
  const account = await GenServer.start(bankAccountBehavior);

  // cast() returns immediately - no waiting
  GenServer.cast(account, { type: 'deposit', amount: 100 });
  GenServer.cast(account, { type: 'deposit', amount: 200 });
  GenServer.cast(account, { type: 'deposit', amount: 300 });

  // The casts are queued but may not be processed yet
  // If we need the updated balance, we must call:
  await new Promise((r) => setTimeout(r, 10)); // Give time for processing

  const balance = await GenServer.call(account, { type: 'getBalance' });
  console.log('Balance after deposits:', balance); // 1600

  await GenServer.stop(account);
}
```

### Key Characteristics of Cast

1. **Asynchronous**: Returns immediately, doesn't wait for processing
2. **No reply**: `handleCast` returns only the new state, no response to sender
3. **Silent failures**: If the handler throws, the caller is not notified
4. **Fire-and-forget**: No confirmation that the message was processed

### When to Use Cast

Use `cast()` when you need:

- **Speed**: Non-blocking operations that shouldn't slow down the caller
- **Broadcasting**: Sending notifications to multiple processes
- **Eventual consistency**: Updates that don't need immediate confirmation
- **Decoupling**: When the sender doesn't care about the outcome

```typescript
// Good use cases for cast()
GenServer.cast(logger, { type: 'log', level: 'info', message: 'User logged in' });
GenServer.cast(metrics, { type: 'increment', counter: 'page_views' });
GenServer.cast(cache, { type: 'invalidate', key: 'user:123' });
GenServer.cast(notifier, { type: 'notify', userId: 456, event: 'order_shipped' });
```

## Comparison: Call vs Cast

| Aspect | `call()` | `cast()` |
|--------|----------|----------|
| Return value | `Promise<Reply>` | `void` |
| Blocks caller | Yes | No |
| Handler return | `[reply, newState]` | `newState` |
| Error propagation | Errors thrown to caller | Errors silently swallowed |
| Timeout support | Yes (configurable) | N/A |
| Use case | Queries, mutations needing confirmation | Notifications, fire-and-forget updates |

## Timeouts

Calls have a default timeout of 5 seconds. If the server doesn't respond within this time, a `CallTimeoutError` is thrown.

### Configuring Timeout

```typescript
import { GenServer, CallTimeoutError } from '@hamicek/noex';

// Custom timeout per call
const result = await GenServer.call(
  server,
  { type: 'slowOperation' },
  { timeout: 30000 }, // 30 seconds
);
```

### Handling Timeout Errors

```typescript
try {
  const result = await GenServer.call(server, { type: 'query' }, { timeout: 1000 });
  console.log('Success:', result);
} catch (error) {
  if (error instanceof CallTimeoutError) {
    console.error(`Timeout after ${error.timeoutMs}ms calling server ${error.serverId}`);
    // Decide: retry, use cached value, or fail gracefully
  } else {
    throw error; // Re-throw unexpected errors
  }
}
```

### Why Timeouts Matter

Timeouts prevent your application from hanging indefinitely when:

- A server is overloaded and processing slowly
- A bug causes an infinite loop in a handler
- The server crashes while processing your message
- A deadlock occurs between processes

**Rule of thumb**: Always set appropriate timeouts for production code. The default 5 seconds is often too long for user-facing operations.

```typescript
// For user-facing APIs, use shorter timeouts
const quickResult = await GenServer.call(server, msg, { timeout: 500 });

// For batch processing, allow more time
const batchResult = await GenServer.call(worker, msg, { timeout: 60000 });
```

## Error Handling

### Errors in handleCall

When `handleCall` throws an error, it propagates to the caller:

```typescript
const behavior: GenServerBehavior<State, CallMsg, CastMsg, Reply> = {
  // ...
  handleCall(msg, state) {
    if (msg.type === 'riskyOperation') {
      throw new Error('Something went wrong');
    }
    return ['ok', state];
  },
  // ...
};

try {
  await GenServer.call(server, { type: 'riskyOperation' });
} catch (error) {
  console.error('Call failed:', error.message); // "Something went wrong"
}
```

**Important**: The server continues running after an error in `handleCall`. Only the individual call fails.

### Errors in handleCast

Errors in `handleCast` are silently ignored - there's no caller to notify:

```typescript
const behavior: GenServerBehavior<State, CallMsg, CastMsg, Reply> = {
  // ...
  handleCast(msg, state) {
    if (msg.type === 'failingSilently') {
      throw new Error('This error is swallowed');
    }
    return state;
  },
  // ...
};

// This doesn't throw - cast returns immediately
GenServer.cast(server, { type: 'failingSilently' });

// The server is still running, but the error went unnoticed
```

To handle cast errors, use lifecycle events:

```typescript
GenServer.onLifecycleEvent((event) => {
  if (event.type === 'crashed') {
    console.error(`Server ${event.ref.id} crashed:`, event.error);
  }
});
```

### Calling a Non-Running Server

Both `call()` and `cast()` throw `ServerNotRunningError` if the server is stopped:

```typescript
import { ServerNotRunningError } from '@hamicek/noex';

const server = await GenServer.start(behavior);
await GenServer.stop(server);

try {
  await GenServer.call(server, { type: 'query' });
} catch (error) {
  if (error instanceof ServerNotRunningError) {
    console.log(`Server ${error.serverId} is not running`);
  }
}
```

## Complete Example

Here's a practical example showing both patterns in a task queue:

```typescript
// task-queue.ts
import { GenServer, type GenServerBehavior, CallTimeoutError } from '@hamicek/noex';

interface Task {
  id: string;
  payload: unknown;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
}

interface TaskQueueState {
  tasks: Map<string, Task>;
  nextId: number;
}

type CallMsg =
  | { type: 'submit'; payload: unknown }
  | { type: 'getStatus'; taskId: string }
  | { type: 'getResult'; taskId: string };

type CastMsg =
  | { type: 'markComplete'; taskId: string; result: unknown }
  | { type: 'markFailed'; taskId: string; error: string };

type Reply =
  | { taskId: string }
  | { status: Task['status'] }
  | { result: unknown }
  | { error: string };

const taskQueueBehavior: GenServerBehavior<TaskQueueState, CallMsg, CastMsg, Reply> = {
  init() {
    return { tasks: new Map(), nextId: 1 };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'submit': {
        const taskId = `task_${state.nextId}`;
        const task: Task = {
          id: taskId,
          payload: msg.payload,
          status: 'pending',
        };

        const newTasks = new Map(state.tasks);
        newTasks.set(taskId, task);

        console.log(`[Queue] Task ${taskId} submitted`);

        return [
          { taskId },
          { tasks: newTasks, nextId: state.nextId + 1 },
        ];
      }

      case 'getStatus': {
        const task = state.tasks.get(msg.taskId);
        if (!task) {
          return [{ error: 'Task not found' }, state];
        }
        return [{ status: task.status }, state];
      }

      case 'getResult': {
        const task = state.tasks.get(msg.taskId);
        if (!task) {
          return [{ error: 'Task not found' }, state];
        }
        if (task.status !== 'completed') {
          return [{ error: `Task is ${task.status}, not completed` }, state];
        }
        return [{ result: task.result }, state];
      }
    }
  },

  handleCast(msg, state) {
    const task = state.tasks.get(msg.taskId);
    if (!task) {
      return state; // Silently ignore unknown tasks
    }

    const newTasks = new Map(state.tasks);

    switch (msg.type) {
      case 'markComplete':
        newTasks.set(msg.taskId, {
          ...task,
          status: 'completed',
          result: msg.result,
        });
        console.log(`[Queue] Task ${msg.taskId} completed`);
        break;

      case 'markFailed':
        newTasks.set(msg.taskId, {
          ...task,
          status: 'failed',
          error: msg.error,
        });
        console.log(`[Queue] Task ${msg.taskId} failed: ${msg.error}`);
        break;
    }

    return { ...state, tasks: newTasks };
  },
};

async function main() {
  const queue = await GenServer.start(taskQueueBehavior);

  // Submit a task (call - need the taskId)
  const { taskId } = await GenServer.call(queue, {
    type: 'submit',
    payload: { action: 'process_image', url: 'https://example.com/img.png' },
  }) as { taskId: string };

  console.log(`Submitted task: ${taskId}`);

  // Check status (call - need the response)
  const statusResult = await GenServer.call(queue, { type: 'getStatus', taskId });
  console.log('Status:', statusResult);

  // Simulate worker completing the task (cast - fire-and-forget)
  GenServer.cast(queue, {
    type: 'markComplete',
    taskId,
    result: { thumbnailUrl: 'https://example.com/thumb.png' },
  });

  // Wait a moment for cast to process
  await new Promise((r) => setTimeout(r, 10));

  // Get result (call - need the response)
  const result = await GenServer.call(queue, { type: 'getResult', taskId });
  console.log('Result:', result);

  await GenServer.stop(queue);
}

main();
```

Run with:

```bash
npx tsx task-queue.ts
```

Expected output:

```
[Queue] Task task_1 submitted
Submitted task: task_1
Status: { status: 'pending' }
[Queue] Task task_1 completed
Result: { result: { thumbnailUrl: 'https://example.com/thumb.png' } }
```

## Best Practices

### 1. Use Call for Queries and Critical Mutations

```typescript
// ✅ Good: Need to know the balance
const balance = await GenServer.call(account, { type: 'getBalance' });

// ✅ Good: Need to confirm withdrawal succeeded
const result = await GenServer.call(account, { type: 'withdraw', amount: 100 });
if (!result.success) {
  // Handle insufficient funds
}
```

### 2. Use Cast for Notifications and Side Effects

```typescript
// ✅ Good: Logging doesn't need confirmation
GenServer.cast(logger, { type: 'log', message: 'User action' });

// ✅ Good: Metrics don't need confirmation
GenServer.cast(metrics, { type: 'increment', counter: 'requests' });
```

### 3. Don't Mix Concerns in One Message Type

```typescript
// ❌ Bad: Cast that the caller expects to confirm
GenServer.cast(orderService, { type: 'placeOrder', items: [...] });
// Caller has no idea if order was placed!

// ✅ Good: Use call for operations that need confirmation
const order = await GenServer.call(orderService, { type: 'placeOrder', items: [...] });
// Now we have the order ID and know it succeeded
```

### 4. Set Appropriate Timeouts

```typescript
// ❌ Bad: Default timeout for slow operations
await GenServer.call(reportService, { type: 'generateYearlyReport' });

// ✅ Good: Explicit timeout for slow operations
await GenServer.call(reportService, { type: 'generateYearlyReport' }, { timeout: 60000 });
```

### 5. Handle Errors Gracefully

```typescript
// ✅ Good: Comprehensive error handling
try {
  const result = await GenServer.call(service, msg, { timeout: 1000 });
  return result;
} catch (error) {
  if (error instanceof CallTimeoutError) {
    return { error: 'Service is slow, please try again' };
  }
  if (error instanceof ServerNotRunningError) {
    return { error: 'Service is unavailable' };
  }
  throw error; // Unexpected error, let it bubble up
}
```

## Exercise

Create a **CounterServer** that supports:

1. `increment` and `decrement` as casts (fire-and-forget)
2. `get` as a call (returns current value)
3. `incrementBy(n)` as a call (returns the new value)
4. `reset` as a call (returns the value before reset)

Test all operations and verify that:
- Casts don't block
- Calls return the expected values
- The counter state is consistent

**Hints:**
- Use discriminated unions for message types
- Cast handlers return just the new state
- Call handlers return `[reply, newState]`

<details>
<summary>Solution</summary>

```typescript
import { GenServer, type GenServerBehavior } from '@hamicek/noex';

interface CounterState {
  value: number;
}

type CallMsg =
  | { type: 'get' }
  | { type: 'incrementBy'; n: number }
  | { type: 'reset' };

type CastMsg =
  | { type: 'increment' }
  | { type: 'decrement' };

type Reply = number;

const counterBehavior: GenServerBehavior<CounterState, CallMsg, CastMsg, Reply> = {
  init() {
    return { value: 0 };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.value, state];

      case 'incrementBy': {
        const newValue = state.value + msg.n;
        return [newValue, { value: newValue }];
      }

      case 'reset': {
        const oldValue = state.value;
        return [oldValue, { value: 0 }];
      }
    }
  },

  handleCast(msg, state) {
    switch (msg.type) {
      case 'increment':
        return { value: state.value + 1 };

      case 'decrement':
        return { value: state.value - 1 };
    }
  },
};

async function main() {
  const counter = await GenServer.start(counterBehavior);

  // Test casts (fire-and-forget)
  console.log('Sending increment casts...');
  GenServer.cast(counter, { type: 'increment' });
  GenServer.cast(counter, { type: 'increment' });
  GenServer.cast(counter, { type: 'increment' });

  // Small delay for casts to process
  await new Promise((r) => setTimeout(r, 10));

  // Test get (call)
  const value1 = await GenServer.call(counter, { type: 'get' });
  console.log('After 3 increments:', value1); // 3

  // Test decrement cast
  GenServer.cast(counter, { type: 'decrement' });
  await new Promise((r) => setTimeout(r, 10));

  const value2 = await GenServer.call(counter, { type: 'get' });
  console.log('After decrement:', value2); // 2

  // Test incrementBy (call with reply)
  const newValue = await GenServer.call(counter, { type: 'incrementBy', n: 10 });
  console.log('After incrementBy(10):', newValue); // 12

  // Test reset (call returns old value)
  const oldValue = await GenServer.call(counter, { type: 'reset' });
  console.log('Reset returned old value:', oldValue); // 12

  const finalValue = await GenServer.call(counter, { type: 'get' });
  console.log('After reset:', finalValue); // 0

  await GenServer.stop(counter);
}

main();
```

Expected output:

```
Sending increment casts...
After 3 increments: 3
After decrement: 2
After incrementBy(10): 12
Reset returned old value: 12
After reset: 0
```

</details>

## Summary

- **`call()`** is synchronous: the caller waits for a reply
  - Use for queries and operations that need confirmation
  - Returns `Promise<Reply>`, handler returns `[reply, newState]`
  - Supports configurable timeouts (default: 5 seconds)
  - Errors propagate to the caller

- **`cast()`** is asynchronous: returns immediately
  - Use for notifications and fire-and-forget updates
  - Returns `void`, handler returns just `newState`
  - Errors are silently ignored (use lifecycle events to catch them)

- **Timeouts** prevent hanging on slow or crashed servers
  - Always set appropriate timeouts for production code
  - Handle `CallTimeoutError` gracefully

- **Error handling** differs between the two
  - Call errors reach the caller
  - Cast errors need lifecycle event observers

The call/cast distinction is fundamental to the actor model. Understanding when to use each helps you build applications that are both responsive and reliable.

---

Next: [Registry](./04-registry.md)
