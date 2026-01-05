/**
 * Test utilities for stress testing Supervisor and GenServer.
 *
 * Provides helper functions for creating test supervisors,
 * waiting for conditions, and generating message load.
 */

import {
  Supervisor,
  GenServer,
  type SupervisorRef,
  type GenServerRef,
  type GenServerBehavior,
  type ChildSpec,
  type SupervisorStrategy,
} from '../../src/index.js';

/**
 * Options for the waitFor helper function.
 */
export interface WaitForOptions {
  /** Maximum time to wait in milliseconds. */
  readonly timeoutMs?: number;
  /** Polling interval in milliseconds. */
  readonly intervalMs?: number;
  /** Custom error message on timeout. */
  readonly message?: string;
}

/**
 * Result of waiting operation with timing information.
 */
export interface WaitResult {
  /** Whether the condition was met. */
  readonly success: boolean;
  /** Time elapsed in milliseconds. */
  readonly elapsedMs: number;
}

/**
 * Waits for a condition to become true with configurable timeout and polling.
 *
 * @param condition - Function that returns true when condition is met
 * @param options - Wait options
 * @returns WaitResult with success status and elapsed time
 * @throws Error if timeout is reached and no custom handling
 *
 * @example
 * ```typescript
 * await waitFor(() => Supervisor.countChildren(ref) === 5);
 * await waitFor(() => GenServer.isRunning(ref), { timeoutMs: 5000 });
 * ```
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: WaitForOptions = {},
): Promise<WaitResult> {
  const {
    timeoutMs = 2000,
    intervalMs = 10,
    message = 'Timeout waiting for condition',
  } = options;

  const startTime = Date.now();
  const deadline = startTime + timeoutMs;

  while (Date.now() < deadline) {
    const result = await Promise.resolve(condition());
    if (result) {
      return {
        success: true,
        elapsedMs: Date.now() - startTime,
      };
    }
    await delay(intervalMs);
  }

  throw new Error(`${message} (after ${timeoutMs}ms)`);
}

/**
 * Waits until all children of a supervisor have been restarted.
 * Detects restart by comparing GenServerRef IDs.
 *
 * @param ref - Supervisor reference
 * @param originalRefs - Map of child IDs to their original refs
 * @param options - Wait options
 * @returns Map of child IDs to elapsed restart times in ms
 */
export async function waitForAllRestarted(
  ref: SupervisorRef,
  originalRefs: ReadonlyMap<string, GenServerRef>,
  options: WaitForOptions = {},
): Promise<Map<string, number>> {
  const restartTimes = new Map<string, number>();
  const startTime = Date.now();

  await waitFor(
    () => {
      for (const [childId, originalRef] of originalRefs) {
        if (restartTimes.has(childId)) continue;

        const child = Supervisor.getChild(ref, childId);
        if (child && child.ref.id !== originalRef.id) {
          restartTimes.set(childId, Date.now() - startTime);
        }
      }
      return restartTimes.size === originalRefs.size;
    },
    {
      timeoutMs: options.timeoutMs ?? 5000,
      intervalMs: options.intervalMs ?? 10,
      message: options.message ?? 'Timeout waiting for all children to restart',
    },
  );

  return restartTimes;
}

/**
 * Waits for a specific child to be restarted.
 *
 * @param ref - Supervisor reference
 * @param childId - ID of the child to monitor
 * @param originalRefId - Original GenServerRef ID before crash
 * @param options - Wait options
 * @returns Time elapsed until restart in milliseconds
 */
export async function waitForChildRestarted(
  ref: SupervisorRef,
  childId: string,
  originalRefId: string,
  options: WaitForOptions = {},
): Promise<number> {
  const startTime = Date.now();

  await waitFor(
    () => {
      const child = Supervisor.getChild(ref, childId);
      return child !== undefined && child.ref.id !== originalRefId;
    },
    {
      timeoutMs: options.timeoutMs ?? 2000,
      intervalMs: options.intervalMs ?? 10,
      message: options.message ?? `Timeout waiting for child '${childId}' to restart`,
    },
  );

  return Date.now() - startTime;
}

/**
 * Configuration for creating a test supervisor.
 */
export interface TestSupervisorConfig {
  /** Number of children to create. */
  readonly childCount: number;
  /** Supervisor restart strategy. */
  readonly strategy?: SupervisorStrategy;
  /** Restart intensity configuration. */
  readonly restartIntensity?: {
    readonly maxRestarts: number;
    readonly withinMs: number;
  };
  /** Optional prefix for child IDs. */
  readonly childIdPrefix?: string;
  /** Custom behavior factory for children. */
  readonly behaviorFactory?: () => GenServerBehavior<number, TestCallMsg, TestCastMsg, number>;
}

/**
 * Call message types for test GenServers.
 */
export type TestCallMsg = { readonly type: 'get' } | { readonly type: 'get_pid' };

/**
 * Cast message types for test GenServers.
 */
export type TestCastMsg =
  | { readonly type: 'inc' }
  | { readonly type: 'work'; readonly durationMs: number };

/**
 * Creates a standard test behavior for stress testing.
 * Supports get/inc operations and simulated work.
 */
export function createTestBehavior(): GenServerBehavior<number, TestCallMsg, TestCastMsg, number> {
  return {
    init: () => 0,
    handleCall: (msg, state) => {
      switch (msg.type) {
        case 'get':
          return [state, state];
        case 'get_pid':
          return [state, state];
      }
    },
    handleCast: (msg, state) => {
      switch (msg.type) {
        case 'inc':
          return state + 1;
        case 'work':
          // Simulate CPU-bound work
          const end = Date.now() + msg.durationMs;
          while (Date.now() < end) {
            // Busy wait
          }
          return state + 1;
      }
    },
  };
}

/**
 * Result of creating a test supervisor.
 */
export interface TestSupervisorResult {
  /** Reference to the supervisor. */
  readonly ref: SupervisorRef;
  /** Map of child IDs to their refs. */
  readonly childRefs: Map<string, GenServerRef>;
  /** Ordered list of child IDs. */
  readonly childIds: readonly string[];
}

/**
 * Creates a test supervisor with a configurable number of children.
 *
 * @param config - Supervisor configuration
 * @returns TestSupervisorResult with supervisor ref and child information
 *
 * @example
 * ```typescript
 * const { ref, childRefs } = await createTestSupervisor({ childCount: 10 });
 * ```
 */
export async function createTestSupervisor(
  config: TestSupervisorConfig,
): Promise<TestSupervisorResult> {
  const {
    childCount,
    strategy = 'one_for_one',
    restartIntensity = { maxRestarts: 100, withinMs: 5000 },
    childIdPrefix = 'child',
    behaviorFactory = createTestBehavior,
  } = config;

  const childIds: string[] = [];
  const childSpecs: ChildSpec[] = [];

  for (let i = 0; i < childCount; i++) {
    const id = `${childIdPrefix}_${i}`;
    childIds.push(id);
    childSpecs.push({
      id,
      start: () => GenServer.start(behaviorFactory()),
    });
  }

  const ref = await Supervisor.start({
    strategy,
    restartIntensity,
    children: childSpecs,
  });

  const childRefs = new Map<string, GenServerRef>();
  for (const id of childIds) {
    const child = Supervisor.getChild(ref, id);
    if (child) {
      childRefs.set(id, child.ref);
    }
  }

  return { ref, childRefs, childIds };
}

/**
 * Options for load generation.
 */
export interface LoadGeneratorOptions {
  /** Messages per second to target. */
  readonly messagesPerSecond: number;
  /** Duration of load generation in milliseconds. */
  readonly durationMs: number;
  /** Type of messages to send. */
  readonly messageType?: 'call' | 'cast';
}

/**
 * Result of load generation.
 */
export interface LoadResult {
  /** Total messages sent. */
  readonly messagesSent: number;
  /** Successful messages (calls that got replies). */
  readonly successfulMessages: number;
  /** Failed messages (timeouts or errors). */
  readonly failedMessages: number;
  /** Average latency in milliseconds (for calls). */
  readonly avgLatencyMs: number;
  /** Maximum latency in milliseconds. */
  readonly maxLatencyMs: number;
  /** Actual duration in milliseconds. */
  readonly actualDurationMs: number;
  /** Actual messages per second achieved. */
  readonly actualMps: number;
}

/**
 * Generates message load on child GenServers.
 * Distributes messages round-robin across all children.
 *
 * @param childRefs - Array of GenServer references to target
 * @param options - Load generation options
 * @returns LoadResult with statistics
 *
 * @example
 * ```typescript
 * const result = await generateLoad(Array.from(childRefs.values()), {
 *   messagesPerSecond: 100,
 *   durationMs: 1000,
 * });
 * console.log(`Sent ${result.messagesSent} messages`);
 * ```
 */
export async function generateLoad(
  childRefs: readonly GenServerRef[],
  options: LoadGeneratorOptions,
): Promise<LoadResult> {
  const {
    messagesPerSecond,
    durationMs,
    messageType = 'cast',
  } = options;

  const intervalMs = 1000 / messagesPerSecond;
  const startTime = Date.now();
  const endTime = startTime + durationMs;

  let messagesSent = 0;
  let successfulMessages = 0;
  let failedMessages = 0;
  const latencies: number[] = [];

  let nextSendTime = startTime;
  let childIndex = 0;

  while (Date.now() < endTime) {
    const now = Date.now();

    if (now >= nextSendTime) {
      const ref = childRefs[childIndex % childRefs.length]!;
      childIndex++;

      if (messageType === 'cast') {
        try {
          if (GenServer.isRunning(ref)) {
            GenServer.cast(ref, { type: 'inc' });
            messagesSent++;
            successfulMessages++;
          } else {
            messagesSent++;
            failedMessages++;
          }
        } catch {
          messagesSent++;
          failedMessages++;
        }
      } else {
        const callStart = Date.now();
        try {
          if (GenServer.isRunning(ref)) {
            await GenServer.call(ref, { type: 'get' }, { timeout: 1000 });
            const latency = Date.now() - callStart;
            latencies.push(latency);
            messagesSent++;
            successfulMessages++;
          } else {
            messagesSent++;
            failedMessages++;
          }
        } catch {
          messagesSent++;
          failedMessages++;
        }
      }

      nextSendTime += intervalMs;

      // If we've fallen behind, reset to now
      if (nextSendTime < now) {
        nextSendTime = now + intervalMs;
      }
    }

    // Small yield to allow other operations
    await delay(1);
  }

  const actualDurationMs = Date.now() - startTime;
  const avgLatencyMs = latencies.length > 0
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length
    : 0;
  const maxLatencyMs = latencies.length > 0 ? Math.max(...latencies) : 0;

  return {
    messagesSent,
    successfulMessages,
    failedMessages,
    avgLatencyMs,
    maxLatencyMs,
    actualDurationMs,
    actualMps: messagesSent / (actualDurationMs / 1000),
  };
}

/**
 * Captures the current state of all children in a supervisor.
 * Useful for before/after comparisons in tests.
 *
 * @param ref - Supervisor reference
 * @returns Map of child IDs to their current GenServerRef IDs
 */
export function captureChildState(ref: SupervisorRef): Map<string, string> {
  const state = new Map<string, string>();
  const children = Supervisor.getChildren(ref);

  for (const child of children) {
    state.set(child.id, child.ref.id);
  }

  return state;
}

/**
 * Compares two child state snapshots and returns changes.
 *
 * @param before - State before operation
 * @param after - State after operation
 * @returns Object with unchanged, changed, added, and removed child IDs
 */
export function compareChildStates(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): {
  readonly unchanged: readonly string[];
  readonly changed: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
} {
  const unchanged: string[] = [];
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [id, refId] of before) {
    const afterRefId = after.get(id);
    if (afterRefId === undefined) {
      removed.push(id);
    } else if (afterRefId === refId) {
      unchanged.push(id);
    } else {
      changed.push(id);
    }
  }

  for (const id of after.keys()) {
    if (!before.has(id)) {
      added.push(id);
    }
  }

  return { unchanged, changed, added, removed };
}

/**
 * Simple delay helper using setTimeout.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cleans up test resources - stops supervisor and clears handlers.
 */
export async function cleanupTest(ref: SupervisorRef): Promise<void> {
  if (Supervisor.isRunning(ref)) {
    await Supervisor.stop(ref);
  }
}

/**
 * Resets global state for clean test runs.
 */
export function resetTestState(): void {
  Supervisor._clearLifecycleHandlers();
  Supervisor._resetIdCounter();
  GenServer._clearLifecycleHandlers();
  GenServer._resetIdCounter();
}
