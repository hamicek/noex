# Errors Reference

This document provides a comprehensive reference for all error classes exported by noex.

## Import

```typescript
import {
  CallTimeoutError,
  ServerNotRunningError,
  InitializationError,
  MaxRestartsExceededError,
  DuplicateChildError,
  ChildNotFoundError,
  NotRegisteredError,
  AlreadyRegisteredError,
  RateLimitExceededError,
} from 'noex';
```

---

## GenServer Errors

### CallTimeoutError

Thrown when a `GenServer.call()` times out waiting for a response.

```typescript
class CallTimeoutError extends Error {
  readonly name = 'CallTimeoutError';
  readonly serverId: string;
  readonly timeoutMs: number;
}
```

**Properties:**
- `serverId` - ID of the GenServer that timed out
- `timeoutMs` - The timeout duration in milliseconds

**Example:**
```typescript
try {
  await GenServer.call(ref, msg, { timeout: 1000 });
} catch (error) {
  if (error instanceof CallTimeoutError) {
    console.log(`Call to ${error.serverId} timed out after ${error.timeoutMs}ms`);
  }
}
```

---

### ServerNotRunningError

Thrown when trying to call/cast to a stopped GenServer.

```typescript
class ServerNotRunningError extends Error {
  readonly name = 'ServerNotRunningError';
  readonly serverId: string;
}
```

**Properties:**
- `serverId` - ID of the GenServer that is not running

**Example:**
```typescript
try {
  await GenServer.call(ref, msg);
} catch (error) {
  if (error instanceof ServerNotRunningError) {
    console.log(`Server ${error.serverId} is not running`);
  }
}
```

---

### InitializationError

Thrown when a GenServer's `init()` callback fails.

```typescript
class InitializationError extends Error {
  readonly name = 'InitializationError';
  readonly serverId: string;
  readonly cause: Error;
}
```

**Properties:**
- `serverId` - ID of the GenServer that failed to initialize
- `cause` - The original error from `init()`

**Example:**
```typescript
try {
  await GenServer.start(behavior);
} catch (error) {
  if (error instanceof InitializationError) {
    console.log(`Failed to initialize ${error.serverId}`);
    console.log(`Cause: ${error.cause.message}`);
  }
}
```

---

## Supervisor Errors

### MaxRestartsExceededError

Thrown when a Supervisor exceeds its restart intensity limit.

```typescript
class MaxRestartsExceededError extends Error {
  readonly name = 'MaxRestartsExceededError';
  readonly supervisorId: string;
  readonly maxRestarts: number;
  readonly withinMs: number;
}
```

**Properties:**
- `supervisorId` - ID of the Supervisor
- `maxRestarts` - Maximum restarts allowed
- `withinMs` - Time window in milliseconds

**Example:**
```typescript
try {
  await Supervisor.start({
    children: [/* ... */],
    restartIntensity: { maxRestarts: 3, withinMs: 5000 },
  });
} catch (error) {
  if (error instanceof MaxRestartsExceededError) {
    console.log(`Supervisor ${error.supervisorId} exceeded ${error.maxRestarts} restarts in ${error.withinMs}ms`);
  }
}
```

---

### DuplicateChildError

Thrown when attempting to add a child with a duplicate ID to a Supervisor.

```typescript
class DuplicateChildError extends Error {
  readonly name = 'DuplicateChildError';
  readonly supervisorId: string;
  readonly childId: string;
}
```

**Properties:**
- `supervisorId` - ID of the Supervisor
- `childId` - The duplicate child ID

**Example:**
```typescript
try {
  await Supervisor.startChild(supervisor, {
    id: 'worker',
    start: () => GenServer.start(behavior),
  });
} catch (error) {
  if (error instanceof DuplicateChildError) {
    console.log(`Child '${error.childId}' already exists in supervisor`);
  }
}
```

---

### ChildNotFoundError

Thrown when a child is not found in a Supervisor.

```typescript
class ChildNotFoundError extends Error {
  readonly name = 'ChildNotFoundError';
  readonly supervisorId: string;
  readonly childId: string;
}
```

**Properties:**
- `supervisorId` - ID of the Supervisor
- `childId` - The missing child ID

**Example:**
```typescript
try {
  await Supervisor.terminateChild(supervisor, 'unknown-child');
} catch (error) {
  if (error instanceof ChildNotFoundError) {
    console.log(`Child '${error.childId}' not found`);
  }
}
```

---

## Registry Errors

### NotRegisteredError

Thrown when a Registry lookup fails to find a process.

```typescript
class NotRegisteredError extends Error {
  readonly name = 'NotRegisteredError';
  readonly processName: string;
}
```

**Properties:**
- `processName` - The name that was not found

**Example:**
```typescript
try {
  const ref = Registry.lookup('my-service');
} catch (error) {
  if (error instanceof NotRegisteredError) {
    console.log(`No process registered as '${error.processName}'`);
  }
}
```

---

### AlreadyRegisteredError

Thrown when attempting to register a name that is already in use.

```typescript
class AlreadyRegisteredError extends Error {
  readonly name = 'AlreadyRegisteredError';
  readonly registeredName: string;
}
```

**Properties:**
- `registeredName` - The name that is already registered

**Example:**
```typescript
try {
  await GenServer.start(behavior, { name: 'my-service' });
} catch (error) {
  if (error instanceof AlreadyRegisteredError) {
    console.log(`Name '${error.registeredName}' is already registered`);
  }
}
```

---

## RateLimiter Errors

### RateLimitExceededError

Thrown when rate limit is exceeded in `RateLimiter.consume()`.

```typescript
class RateLimitExceededError extends Error {
  readonly name = 'RateLimitExceededError';
  readonly key: string;
  readonly retryAfterMs: number;
}
```

**Properties:**
- `key` - The rate limit key that was exceeded
- `retryAfterMs` - Milliseconds until the request can be retried

**Example:**
```typescript
try {
  await RateLimiter.consume(limiter, 'user:123');
} catch (error) {
  if (error instanceof RateLimitExceededError) {
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil(error.retryAfterMs / 1000),
    });
  }
}
```

---

## Error Handling Patterns

### Comprehensive Error Handling

```typescript
import {
  GenServer,
  CallTimeoutError,
  ServerNotRunningError,
  InitializationError,
} from 'noex';

async function safeCall<T>(
  ref: GenServerRef,
  msg: unknown,
): Promise<T | null> {
  try {
    return await GenServer.call(ref, msg) as T;
  } catch (error) {
    if (error instanceof CallTimeoutError) {
      console.error(`Timeout calling ${error.serverId}`);
    } else if (error instanceof ServerNotRunningError) {
      console.error(`Server ${error.serverId} stopped`);
    } else {
      throw error; // Re-throw unexpected errors
    }
    return null;
  }
}
```

### Type Guard Functions

```typescript
function isNoexError(error: unknown): error is Error & { name: string } {
  return error instanceof Error && 'name' in error;
}

function handleError(error: unknown): void {
  if (!isNoexError(error)) {
    throw error;
  }

  switch (error.name) {
    case 'CallTimeoutError':
      // Handle timeout
      break;
    case 'ServerNotRunningError':
      // Handle stopped server
      break;
    case 'MaxRestartsExceededError':
      // Handle supervisor failure
      break;
    default:
      throw error;
  }
}
```

---

## Related

- [Types Reference](./types.md) - All type definitions
- [GenServer API](./genserver.md) - GenServer methods
- [Supervisor API](./supervisor.md) - Supervisor methods
- [RateLimiter API](./rate-limiter.md) - Rate limiting
