# Error Handling

noex provides structured error handling inspired by Elixir's "let it crash" philosophy. Instead of defensive programming everywhere, errors are isolated to individual processes and handled through supervision.

## Philosophy: Let It Crash

Traditional error handling tries to anticipate and handle every possible error:

```typescript
// Traditional defensive approach
async function processRequest(data: unknown) {
  try {
    if (!data) throw new Error('No data');
    if (!isValid(data)) throw new Error('Invalid data');

    const result = await riskyOperation(data);
    if (!result) throw new Error('Operation failed');

    return result;
  } catch (error) {
    logger.error(error);
    return null;
  }
}
```

The "let it crash" approach:

```typescript
// noex approach - let unexpected errors crash the process
const behavior: GenServerBehavior<State, Msg, Cast, Reply> = {
  init: () => initialState,

  handleCall: (msg, state) => {
    // Handle expected cases, let unexpected ones crash
    const result = processData(msg.data);
    return [result, state];
  },

  handleCast: (msg, state) => state,
};

// Supervisor will restart on crash
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [{ id: 'processor', start: () => GenServer.start(behavior) }],
});
```

### Benefits

1. **Simpler code** - Handle expected cases, don't anticipate every error
2. **Fault isolation** - Errors don't propagate beyond the crashed process
3. **Automatic recovery** - Supervisors restart crashed processes
4. **Clean state** - Restart gives you fresh, known-good state

## Error Types

noex provides specific error classes for different failure modes:

### CallTimeoutError

Thrown when a `GenServer.call()` doesn't receive a response in time:

```typescript
import { CallTimeoutError } from 'noex';

try {
  await GenServer.call(ref, msg, { timeout: 5000 });
} catch (error) {
  if (error instanceof CallTimeoutError) {
    console.error(`Call timed out after ${error.timeoutMs}ms`);
    console.error(`Server: ${error.serverId}`);
  }
}
```

**Common causes:**
- Server is processing a slow operation
- Server is blocked or deadlocked
- Server crashed during processing

### ServerNotRunningError

Thrown when trying to interact with a stopped server:

```typescript
import { ServerNotRunningError } from 'noex';

try {
  await GenServer.call(ref, msg);
} catch (error) {
  if (error instanceof ServerNotRunningError) {
    console.error(`Server ${error.serverId} is not running`);
  }
}
```

**Common causes:**
- Server was stopped
- Server crashed and wasn't restarted
- Using a stale reference

### InitializationError

Thrown when `GenServer.start()` fails during initialization:

```typescript
import { InitializationError } from 'noex';

try {
  await GenServer.start(behavior);
} catch (error) {
  if (error instanceof InitializationError) {
    console.error(`Server ${error.serverId} failed to init`);
    console.error(`Cause:`, error.cause);
  }
}
```

**Common causes:**
- `init()` threw an exception
- `init()` timed out
- Required resources unavailable

### MaxRestartsExceededError

Thrown when a supervisor exceeds its restart intensity limit:

```typescript
import { MaxRestartsExceededError } from 'noex';

try {
  await Supervisor.start({
    restartIntensity: { maxRestarts: 3, withinMs: 5000 },
    children: [{ id: 'unstable', start: () => GenServer.start(crashingBehavior) }],
  });
} catch (error) {
  if (error instanceof MaxRestartsExceededError) {
    console.error(`Supervisor ${error.supervisorId} gave up`);
    console.error(`${error.maxRestarts} restarts in ${error.withinMs}ms`);
  }
}
```

### DuplicateChildError

Thrown when adding a child with an ID that already exists:

```typescript
import { DuplicateChildError } from 'noex';

try {
  await Supervisor.startChild(supervisor, { id: 'worker', start: ... });
  await Supervisor.startChild(supervisor, { id: 'worker', start: ... }); // Throws!
} catch (error) {
  if (error instanceof DuplicateChildError) {
    console.error(`Child '${error.childId}' already exists`);
  }
}
```

### ChildNotFoundError

Thrown when referencing a non-existent child:

```typescript
import { ChildNotFoundError } from 'noex';

try {
  await Supervisor.terminateChild(supervisor, 'unknown');
} catch (error) {
  if (error instanceof ChildNotFoundError) {
    console.error(`Child '${error.childId}' not found`);
  }
}
```

### NotRegisteredError

Thrown when looking up an unregistered name:

```typescript
import { NotRegisteredError } from 'noex';

try {
  Registry.lookup('unknown-service');
} catch (error) {
  if (error instanceof NotRegisteredError) {
    console.error(`No process named '${error.processName}'`);
  }
}
```

### AlreadyRegisteredError

Thrown when registering a name that's already in use:

```typescript
import { AlreadyRegisteredError } from 'noex';

try {
  Registry.register('counter', ref1);
  Registry.register('counter', ref2); // Throws!
} catch (error) {
  if (error instanceof AlreadyRegisteredError) {
    console.error(`Name '${error.registeredName}' is taken`);
  }
}
```

## Error Propagation

### In handleCall

Errors thrown in `handleCall` are propagated to the caller:

```typescript
const behavior = {
  handleCall: (msg, state) => {
    if (msg.type === 'validate') {
      if (!isValid(msg.data)) {
        throw new Error('Validation failed');
      }
      return [true, state];
    }
    return [null, state];
  },
  // ...
};

// Caller receives the error
try {
  await GenServer.call(server, { type: 'validate', data: badData });
} catch (error) {
  // "Validation failed"
}
```

The server continues running - the error is isolated to that call.

### In handleCast

Errors in `handleCast` are silently swallowed (no caller to notify):

```typescript
const behavior = {
  handleCast: (msg, state) => {
    if (msg.type === 'process') {
      throw new Error('Processing failed'); // Silent!
    }
    return state;
  },
  // ...
};

GenServer.cast(server, { type: 'process', data: badData });
// No error thrown - fire and forget
```

Use lifecycle events to monitor cast failures:

```typescript
GenServer.onLifecycleEvent((event) => {
  if (event.type === 'crashed') {
    console.error('Server crashed:', event.error);
  }
});
```

### In init

Errors in `init` prevent the server from starting:

```typescript
const behavior = {
  init: async () => {
    const conn = await connectToDatabase();
    if (!conn) {
      throw new Error('Database unavailable');
    }
    return { conn };
  },
  // ...
};

try {
  await GenServer.start(behavior);
} catch (error) {
  // InitializationError with cause "Database unavailable"
}
```

### In terminate

Errors in `terminate` during graceful shutdown are logged but don't affect shutdown:

```typescript
const behavior = {
  terminate: async (reason, state) => {
    await state.conn.close(); // Might throw
  },
  // ...
};

await GenServer.stop(server);
// Completes even if terminate throws
```

## Recovery Strategies

### Supervisor Restart

The primary recovery mechanism - let supervisors restart crashed processes:

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  restartIntensity: { maxRestarts: 5, withinMs: 60000 },
  children: [
    { id: 'worker', start: () => GenServer.start(workerBehavior) },
  ],
});
```

### Retry with Backoff

For transient failures, implement retry logic:

```typescript
async function callWithRetry<T>(
  ref: GenServerRef,
  msg: unknown,
  maxRetries = 3,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await GenServer.call(ref, msg);
    } catch (error) {
      lastError = error as Error;

      if (error instanceof ServerNotRunningError) {
        throw error; // Don't retry if server is gone
      }

      // Exponential backoff
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 100));
    }
  }

  throw lastError;
}
```

### Circuit Breaker

Prevent cascading failures:

```typescript
class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private open = false;

  constructor(
    private threshold = 5,
    private resetTimeout = 30000,
  ) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.open) {
      if (Date.now() - this.lastFailure > this.resetTimeout) {
        this.open = false;
        this.failures = 0;
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailure = Date.now();

      if (this.failures >= this.threshold) {
        this.open = true;
      }

      throw error;
    }
  }
}
```

### Fallback Values

Return defaults when a service is unavailable:

```typescript
async function getConfig(key: string): Promise<string> {
  const configServer = Registry.whereis('config');

  if (!configServer) {
    return DEFAULT_CONFIG[key];
  }

  try {
    return await GenServer.call(configServer, { type: 'get', key });
  } catch (error) {
    console.warn(`Config lookup failed, using default for ${key}`);
    return DEFAULT_CONFIG[key];
  }
}
```

## Best Practices

### 1. Use Specific Error Types

```typescript
// Good: Specific, catchable errors
class ValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

handleCall: (msg, state) => {
  if (!msg.email.includes('@')) {
    throw new ValidationError('email', 'Invalid email format');
  }
  // ...
}
```

### 2. Validate at Boundaries

```typescript
// Good: Validate input at the edge
handleCall: (msg, state) => {
  // Validate first
  if (msg.type !== 'create' && msg.type !== 'update') {
    throw new Error(`Unknown message type: ${msg.type}`);
  }

  // Then process with confidence
  return processValidMessage(msg, state);
}
```

### 3. Isolate Risky Operations

```typescript
// Good: Separate risky operations into dedicated processes
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    // Core service - stable
    { id: 'core', start: () => GenServer.start(coreBehavior) },
    // External API - might fail
    { id: 'external-api', start: () => GenServer.start(apiBehavior) },
  ],
});
```

### 4. Log Before Crashing

```typescript
handleCall: (msg, state) => {
  try {
    return processMessage(msg, state);
  } catch (error) {
    // Log context before letting it crash
    console.error('Processing failed', {
      message: msg,
      stateSnapshot: summarizeState(state),
      error,
    });
    throw error; // Let supervisor handle restart
  }
}
```

### 5. Design for Recovery

```typescript
// Good: State can be rebuilt after restart
const behavior = {
  init: async () => {
    // Load persisted state
    const saved = await loadFromDatabase();
    return saved ?? { items: [] };
  },

  handleCast: async (msg, state) => {
    if (msg.type === 'add') {
      const newState = { ...state, items: [...state.items, msg.item] };
      // Persist changes
      await saveToDatabase(newState);
      return newState;
    }
    return state;
  },
};
```

## Related

- [Supervisor](./supervisor.md) - Automatic restart and fault tolerance
- [Lifecycle](./lifecycle.md) - Process states and transitions
- [API Reference: Errors](../api/errors.md) - Complete error class reference
