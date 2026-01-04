# Types Reference

This document provides a comprehensive reference for all types exported by noex.

## Import

```typescript
import type {
  GenServerRef,
  GenServerBehavior,
  CallResult,
  TerminateReason,
  StartOptions,
  CallOptions,
  SupervisorRef,
  SupervisorOptions,
  SupervisorStrategy,
  ChildSpec,
  ChildRestartStrategy,
  ChildInfo,
  RestartIntensity,
  LifecycleEvent,
  LifecycleHandler,
  GenServerStats,
  SupervisorStats,
  MemoryStats,
  ProcessTreeNode,
  ObserverEvent,
  ServerStatus,
} from 'noex';
```

---

## GenServer Types

### GenServerRef

Opaque reference to a running GenServer instance.

```typescript
interface GenServerRef<
  State = unknown,
  CallMsg = unknown,
  CastMsg = unknown,
  CallReply = unknown,
> {
  readonly id: string;
}
```

The type parameters provide compile-time type safety for messages:

- `State` - The server's internal state type
- `CallMsg` - Union of all synchronous call message types
- `CastMsg` - Union of all asynchronous cast message types
- `CallReply` - Union of all possible call reply types

**Example:**
```typescript
type MyRef = GenServerRef<
  { count: number },           // State
  { type: 'get' },             // CallMsg
  { type: 'increment' },       // CastMsg
  number                       // CallReply
>;
```

---

### GenServerBehavior

Interface that GenServer implementations must satisfy.

```typescript
interface GenServerBehavior<State, CallMsg, CastMsg, CallReply> {
  init(): State | Promise<State>;

  handleCall(
    msg: CallMsg,
    state: State,
  ): CallResult<CallReply, State> | Promise<CallResult<CallReply, State>>;

  handleCast(msg: CastMsg, state: State): State | Promise<State>;

  terminate?(reason: TerminateReason, state: State): void | Promise<void>;
}
```

**Callbacks:**

| Callback | Required | Description |
|----------|----------|-------------|
| `init` | Yes | Initialize server state |
| `handleCall` | Yes | Handle synchronous messages |
| `handleCast` | Yes | Handle asynchronous messages |
| `terminate` | No | Cleanup on shutdown |

---

### CallResult

Return type for `handleCall`.

```typescript
type CallResult<Reply, State> = readonly [Reply, State];
```

Returns a tuple of `[reply, newState]`.

---

### TerminateReason

Reason for GenServer termination.

```typescript
type TerminateReason = 'normal' | 'shutdown' | { readonly error: Error };
```

| Value | Description |
|-------|-------------|
| `'normal'` | Graceful shutdown via `stop()` |
| `'shutdown'` | Supervisor-initiated shutdown |
| `{ error: Error }` | Crash due to unhandled exception |

---

### StartOptions

Options for `GenServer.start()`.

```typescript
interface StartOptions {
  /** Register server under this name */
  readonly name?: string;

  /** Timeout for init() in milliseconds @default 5000 */
  readonly initTimeout?: number;
}
```

---

### CallOptions

Options for `GenServer.call()`.

```typescript
interface CallOptions {
  /** Timeout for call in milliseconds @default 5000 */
  readonly timeout?: number;
}
```

---

## Supervisor Types

### SupervisorRef

Reference to a running Supervisor instance.

```typescript
interface SupervisorRef {
  readonly id: string;
}
```

---

### SupervisorOptions

Options for `Supervisor.start()`.

```typescript
interface SupervisorOptions {
  /** Restart strategy @default 'one_for_one' */
  readonly strategy?: SupervisorStrategy;

  /** Initial child specifications */
  readonly children?: readonly ChildSpec[];

  /** Restart intensity configuration */
  readonly restartIntensity?: RestartIntensity;

  /** Optional registry name */
  readonly name?: string;
}
```

---

### SupervisorStrategy

Strategy for restarting children when one fails.

```typescript
type SupervisorStrategy = 'one_for_one' | 'one_for_all' | 'rest_for_one';
```

| Strategy | Description |
|----------|-------------|
| `'one_for_one'` | Only restart the failed child |
| `'one_for_all'` | Restart all children when one fails |
| `'rest_for_one'` | Restart failed child and all children started after it |

---

### ChildSpec

Specification for a child process managed by a Supervisor.

```typescript
interface ChildSpec<
  State = unknown,
  CallMsg = unknown,
  CastMsg = unknown,
  CallReply = unknown,
> {
  /** Unique identifier for this child */
  readonly id: string;

  /** Factory function to start the child process */
  readonly start: () => Promise<GenServerRef<State, CallMsg, CastMsg, CallReply>>;

  /** Restart strategy @default 'permanent' */
  readonly restart?: ChildRestartStrategy;

  /** Shutdown timeout in milliseconds @default 5000 */
  readonly shutdownTimeout?: number;
}
```

---

### ChildRestartStrategy

Restart strategy for individual child processes.

```typescript
type ChildRestartStrategy = 'permanent' | 'transient' | 'temporary';
```

| Strategy | Description |
|----------|-------------|
| `'permanent'` | Always restart, regardless of exit reason |
| `'transient'` | Restart only on abnormal exit (error) |
| `'temporary'` | Never restart |

---

### ChildInfo

Information about a running child in a supervisor.

```typescript
interface ChildInfo {
  readonly id: string;
  readonly ref: GenServerRef;
  readonly spec: ChildSpec;
  readonly restartCount: number;
}
```

---

### RestartIntensity

Configuration for supervisor restart intensity limiting.

```typescript
interface RestartIntensity {
  /** Maximum restarts allowed @default 3 */
  readonly maxRestarts: number;

  /** Time window in milliseconds @default 5000 */
  readonly withinMs: number;
}
```

If `maxRestarts` is exceeded within `withinMs`, the supervisor shuts down.

---

## Lifecycle Types

### LifecycleEvent

Events emitted by GenServers and Supervisors.

```typescript
type LifecycleEvent =
  | { readonly type: 'started'; readonly ref: GenServerRef | SupervisorRef }
  | { readonly type: 'crashed'; readonly ref: GenServerRef; readonly error: Error }
  | { readonly type: 'restarted'; readonly ref: GenServerRef; readonly attempt: number }
  | { readonly type: 'terminated'; readonly ref: GenServerRef | SupervisorRef; readonly reason: TerminateReason };
```

---

### LifecycleHandler

Handler function for lifecycle events.

```typescript
type LifecycleHandler = (event: LifecycleEvent) => void;
```

---

## Observer Types

### GenServerStats

Runtime statistics for a GenServer instance.

```typescript
interface GenServerStats {
  /** Unique identifier */
  readonly id: string;

  /** Current status */
  readonly status: ServerStatus;

  /** Messages waiting in queue */
  readonly queueSize: number;

  /** Total messages processed */
  readonly messageCount: number;

  /** Start timestamp (Unix ms) */
  readonly startedAt: number;

  /** Uptime in milliseconds */
  readonly uptimeMs: number;

  /** Estimated state memory in bytes */
  readonly stateMemoryBytes?: number;
}
```

---

### SupervisorStats

Runtime statistics for a Supervisor instance.

```typescript
interface SupervisorStats {
  /** Unique identifier */
  readonly id: string;

  /** Restart strategy */
  readonly strategy: SupervisorStrategy;

  /** Number of children */
  readonly childCount: number;

  /** Total restarts performed */
  readonly totalRestarts: number;

  /** Start timestamp (Unix ms) */
  readonly startedAt: number;

  /** Uptime in milliseconds */
  readonly uptimeMs: number;
}
```

---

### MemoryStats

Node.js process memory statistics.

```typescript
interface MemoryStats {
  /** V8 heap used (bytes) */
  readonly heapUsed: number;

  /** V8 heap total (bytes) */
  readonly heapTotal: number;

  /** C++ objects memory (bytes) */
  readonly external: number;

  /** Resident Set Size (bytes) */
  readonly rss: number;

  /** Collection timestamp */
  readonly timestamp: number;
}
```

---

### ProcessTreeNode

A node in the process tree hierarchy.

```typescript
interface ProcessTreeNode {
  /** Type of process */
  readonly type: 'genserver' | 'supervisor';

  /** Unique identifier */
  readonly id: string;

  /** Optional registered name */
  readonly name?: string;

  /** Runtime statistics */
  readonly stats: GenServerStats | SupervisorStats;

  /** Child nodes (supervisors only) */
  readonly children?: readonly ProcessTreeNode[];
}
```

---

### ObserverEvent

Events emitted by the Observer.

```typescript
type ObserverEvent =
  | { readonly type: 'server_started'; readonly stats: GenServerStats }
  | { readonly type: 'server_stopped'; readonly id: string; readonly reason: TerminateReason }
  | { readonly type: 'supervisor_started'; readonly stats: SupervisorStats }
  | { readonly type: 'supervisor_stopped'; readonly id: string }
  | { readonly type: 'stats_update'; readonly servers: readonly GenServerStats[]; readonly supervisors: readonly SupervisorStats[] };
```

---

### ServerStatus

Internal state of a GenServer.

```typescript
type ServerStatus = 'initializing' | 'running' | 'stopping' | 'stopped';
```

---

## Default Values

Constants for default configuration values.

```typescript
const DEFAULTS = {
  INIT_TIMEOUT: 5000,      // GenServer init timeout
  CALL_TIMEOUT: 5000,      // GenServer call timeout
  SHUTDOWN_TIMEOUT: 5000,  // Child shutdown timeout
  MAX_RESTARTS: 3,         // Restart intensity max
  RESTART_WITHIN_MS: 5000, // Restart intensity window
} as const;
```

---

## Related

- [GenServer API](./genserver.md) - GenServer methods
- [Supervisor API](./supervisor.md) - Supervisor methods
- [Errors Reference](./errors.md) - Error classes
