# Frequently Asked Questions

Common questions about noex and their answers.

---

## General

### What is noex?

noex is a TypeScript library that brings Elixir/OTP-style concurrency patterns to Node.js. It provides:

- **GenServer**: Stateful processes with message-based communication
- **Supervisor**: Automatic crash recovery and process management
- **Registry**: Named process lookup
- **Built-in services**: Cache, EventBus, RateLimiter

### Why use noex instead of plain JavaScript/TypeScript?

noex provides several benefits:

1. **No race conditions**: Each GenServer processes messages one at a time
2. **Fault tolerance**: Supervisors automatically restart crashed processes
3. **Clean state management**: State is encapsulated and only modified through messages
4. **Familiar patterns**: If you know Elixir/OTP, you'll feel at home

### Is noex suitable for production?

noex is designed for production use. Key features:

- Comprehensive test coverage
- TypeScript for type safety
- Observable via the built-in Observer and Dashboard
- Well-documented API

### How does noex compare to Elixir/OTP?

noex implements the core patterns from Elixir/OTP:

| Elixir/OTP | noex | Notes |
|------------|------|-------|
| GenServer | GenServer | Similar API |
| Supervisor | Supervisor | Same strategies |
| Registry | Registry | Named lookups |
| GenStage | - | Not yet implemented |
| Phoenix.PubSub | EventBus | Topic-based pub/sub |

Key differences:

- noex runs in a single Node.js process (no BEAM VM)
- No distributed features (yet)
- JavaScript's event loop instead of preemptive scheduling

---

## GenServer

### When should I use call vs cast?

- **call**: When you need a response or confirmation
  ```typescript
  const value = await GenServer.call(ref, 'get');
  ```

- **cast**: Fire-and-forget, when you don't need a response
  ```typescript
  GenServer.cast(ref, 'increment');
  ```

### Can handleCall and handleCast be async?

Yes, both handlers can be async:

```typescript
handleCall: async (msg, state) => {
  const data = await fetchData();
  return [data, state];
},

handleCast: async (msg, state) => {
  await saveToDatabase(state);
  return state;
},
```

### What happens if a GenServer crashes?

If not supervised, the GenServer stops and the reference becomes invalid. Subsequent calls will throw `ServerNotRunningError`.

If supervised, the Supervisor will restart it based on its restart strategy.

### How do I handle timeouts in calls?

Use the `timeout` option:

```typescript
try {
  const result = await GenServer.call(ref, msg, { timeout: 5000 });
} catch (error) {
  if (error instanceof CallTimeoutError) {
    // Handle timeout
  }
}
```

### Can I have multiple GenServers of the same type?

Yes. Each `GenServer.start()` creates an independent instance:

```typescript
const counter1 = await GenServer.start(counterBehavior);
const counter2 = await GenServer.start(counterBehavior);
// These are completely independent
```

---

## Supervisor

### Which restart strategy should I use?

- **one_for_one**: Children are independent
  - Example: Multiple independent worker processes

- **one_for_all**: Children depend on each other
  - Example: Tightly coupled services that share state

- **rest_for_one**: Later children depend on earlier ones
  - Example: A database connection pool that other services depend on

### What restart options are available?

- **permanent**: Always restart (default)
- **temporary**: Never restart
- **transient**: Only restart on abnormal termination

### How do I prevent infinite restart loops?

Configure restart intensity:

```typescript
await Supervisor.start({
  strategy: 'one_for_one',
  restartIntensity: {
    maxRestarts: 5,
    withinMs: 60_000, // 5 restarts per minute max
  },
  children: [...],
});
```

### Can I add/remove children dynamically?

Yes, use `startChild` and `terminateChild`:

```typescript
// Add a child
await Supervisor.startChild(supervisor, {
  id: 'new-worker',
  start: () => GenServer.start(workerBehavior),
  restart: 'permanent',
});

// Remove a child
await Supervisor.terminateChild(supervisor, 'new-worker');
```

---

## Registry

### How do I register a process by name?

Register during start or after:

```typescript
// During start
const ref = await GenServer.start(behavior, { name: 'my-service' });

// Or register later
await Registry.register('my-service', ref);
```

### How do I look up a registered process?

```typescript
const ref = Registry.lookup('my-service');
if (ref) {
  await GenServer.call(ref, 'get');
}
```

### What happens when a registered process crashes?

The registration is automatically removed. If the process is supervised and restarts, you need to re-register it (typically in the `init` callback).

---

## Performance

### How many GenServers can I run?

Thousands to tens of thousands, depending on your workload. Each GenServer is lightweight - just an object with a message queue.

### Are messages processed in order?

Yes. Each GenServer processes messages one at a time in the order they were received. This eliminates race conditions.

### Is noex suitable for high-throughput applications?

Yes, but consider:

- GenServers are single-threaded (one message at a time)
- Use worker pools for CPU-intensive tasks
- Consider horizontal scaling for very high throughput

---

## Debugging

### How do I see what's happening in my GenServers?

Use the Observer:

```typescript
import { Observer } from 'noex';

const observer = await Observer.start();

// Get snapshot of all processes
const snapshot = await Observer.getSnapshot(observer);
console.log(snapshot);

// Subscribe to events
await Observer.subscribe(observer, (event) => {
  console.log('Event:', event);
});
```

### How do I enable the Dashboard?

```typescript
import { DashboardServer } from 'noex';

const dashboard = await DashboardServer.start({
  port: 8080,
});

// Open http://localhost:8080 in your browser
```

### My GenServer seems stuck. What do I check?

1. **Check if it's running**: `GenServer.isRunning(ref)`
2. **Check the state**: Add a `get_state` call message for debugging
3. **Check for blocking operations**: Avoid blocking the event loop
4. **Use Observer**: Check message queue length and processing times

---

## Common Errors

### CallTimeoutError

The GenServer didn't respond within the timeout period.

**Causes**:
- Handler is taking too long
- GenServer is processing many messages
- Deadlock (calling a GenServer from its own handler)

**Solutions**:
- Increase timeout if operations are legitimately slow
- Use cast instead of call for non-blocking operations
- Avoid calling the same GenServer from its handler

### ServerNotRunningError

The GenServer is not running.

**Causes**:
- GenServer was stopped
- GenServer crashed and wasn't supervised

**Solutions**:
- Check if the GenServer is running before calling
- Use a Supervisor to auto-restart crashed processes

### MaxRestartsExceededError

The Supervisor gave up after too many restarts.

**Causes**:
- Child keeps crashing repeatedly
- Initialization keeps failing

**Solutions**:
- Check child's init function for errors
- Review the restart intensity settings
- Fix the underlying cause of crashes

---

## Related

- [Getting Started](./getting-started/index.md) - Quick introduction
- [API Reference](./api/index.md) - Complete API documentation
- [Tutorials](./tutorials/index.md) - Step-by-step guides
