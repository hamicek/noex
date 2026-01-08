/**
 * Test behaviors for distributed stress testing.
 *
 * Provides a collection of GenServer behaviors designed for specific
 * stress testing scenarios:
 *
 * - counterBehavior: Simple counter for basic throughput testing
 * - echoBehavior: Echo service for latency/throughput measurement
 * - slowBehavior: Configurable delay for timeout testing
 * - crashAfterNBehavior: Controlled crash after N operations
 * - memoryHogBehavior: Large state for memory pressure testing
 * - statefulBehavior: Rich state for complex operation testing
 *
 * @module tests/stress/distribution/behaviors
 */

import type { GenServerBehavior, CallResult } from '../../../src/core/types.js';

// =============================================================================
// Counter Behavior
// =============================================================================

/**
 * State for the simple counter behavior.
 */
export interface CounterState {
  readonly value: number;
  readonly operationCount: number;
  readonly createdAt: number;
}

/**
 * Call messages for counter behavior.
 */
export type CounterCallMsg =
  | { readonly type: 'get' }
  | { readonly type: 'increment'; readonly by?: number }
  | { readonly type: 'decrement'; readonly by?: number }
  | { readonly type: 'set'; readonly value: number }
  | { readonly type: 'get_stats' };

/**
 * Cast messages for counter behavior.
 */
export type CounterCastMsg =
  | { readonly type: 'increment'; readonly by?: number }
  | { readonly type: 'decrement'; readonly by?: number }
  | { readonly type: 'reset' };

/**
 * Reply types for counter calls.
 */
export type CounterCallReply =
  | { readonly value: number }
  | { readonly value: number; readonly operationCount: number; readonly uptimeMs: number };

/**
 * Simple counter behavior for basic throughput and correctness testing.
 *
 * Supports both synchronous (call) and asynchronous (cast) operations,
 * making it ideal for testing message delivery guarantees.
 */
export const counterBehavior: GenServerBehavior<
  CounterState,
  CounterCallMsg,
  CounterCastMsg,
  CounterCallReply
> = {
  init(): CounterState {
    return {
      value: 0,
      operationCount: 0,
      createdAt: Date.now(),
    };
  },

  handleCall(msg, state): CallResult<CounterCallReply, CounterState> {
    switch (msg.type) {
      case 'get':
        return [{ value: state.value }, state];

      case 'increment': {
        const by = msg.by ?? 1;
        const newState: CounterState = {
          value: state.value + by,
          operationCount: state.operationCount + 1,
          createdAt: state.createdAt,
        };
        return [{ value: newState.value }, newState];
      }

      case 'decrement': {
        const by = msg.by ?? 1;
        const newState: CounterState = {
          value: state.value - by,
          operationCount: state.operationCount + 1,
          createdAt: state.createdAt,
        };
        return [{ value: newState.value }, newState];
      }

      case 'set': {
        const newState: CounterState = {
          value: msg.value,
          operationCount: state.operationCount + 1,
          createdAt: state.createdAt,
        };
        return [{ value: newState.value }, newState];
      }

      case 'get_stats':
        return [
          {
            value: state.value,
            operationCount: state.operationCount,
            uptimeMs: Date.now() - state.createdAt,
          },
          state,
        ];
    }
  },

  handleCast(msg, state): CounterState {
    switch (msg.type) {
      case 'increment': {
        const by = msg.by ?? 1;
        return {
          value: state.value + by,
          operationCount: state.operationCount + 1,
          createdAt: state.createdAt,
        };
      }

      case 'decrement': {
        const by = msg.by ?? 1;
        return {
          value: state.value - by,
          operationCount: state.operationCount + 1,
          createdAt: state.createdAt,
        };
      }

      case 'reset':
        return {
          value: 0,
          operationCount: state.operationCount + 1,
          createdAt: state.createdAt,
        };
    }
  },
};

// =============================================================================
// Echo Behavior
// =============================================================================

/**
 * State for the echo behavior.
 */
export interface EchoState {
  readonly messageCount: number;
  readonly totalBytesProcessed: number;
  readonly createdAt: number;
}

/**
 * Call messages for echo behavior.
 */
export type EchoCallMsg =
  | { readonly type: 'echo'; readonly payload: unknown }
  | { readonly type: 'get_stats' };

/**
 * Cast messages for echo behavior.
 */
export type EchoCastMsg =
  | { readonly type: 'ping' }
  | { readonly type: 'reset_stats' };

/**
 * Reply types for echo calls.
 */
export type EchoCallReply =
  | { readonly payload: unknown; readonly processedAt: number }
  | { readonly messageCount: number; readonly totalBytesProcessed: number; readonly uptimeMs: number };

/**
 * Estimates the byte size of a value for statistics tracking.
 */
function estimateByteSize(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number') return 8;
  if (typeof value === 'boolean') return 1;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateByteSize(item), 0);
  }
  if (typeof value === 'object') {
    return JSON.stringify(value).length * 2;
  }
  return 0;
}

/**
 * Echo behavior for throughput and latency testing.
 *
 * Simply returns the payload sent to it, allowing accurate
 * measurement of round-trip times and message processing capacity.
 */
export const echoBehavior: GenServerBehavior<
  EchoState,
  EchoCallMsg,
  EchoCastMsg,
  EchoCallReply
> = {
  init(): EchoState {
    return {
      messageCount: 0,
      totalBytesProcessed: 0,
      createdAt: Date.now(),
    };
  },

  handleCall(msg, state): CallResult<EchoCallReply, EchoState> {
    switch (msg.type) {
      case 'echo': {
        const byteSize = estimateByteSize(msg.payload);
        const newState: EchoState = {
          messageCount: state.messageCount + 1,
          totalBytesProcessed: state.totalBytesProcessed + byteSize,
          createdAt: state.createdAt,
        };
        return [{ payload: msg.payload, processedAt: Date.now() }, newState];
      }

      case 'get_stats':
        return [
          {
            messageCount: state.messageCount,
            totalBytesProcessed: state.totalBytesProcessed,
            uptimeMs: Date.now() - state.createdAt,
          },
          state,
        ];
    }
  },

  handleCast(msg, state): EchoState {
    switch (msg.type) {
      case 'ping':
        return {
          ...state,
          messageCount: state.messageCount + 1,
        };

      case 'reset_stats':
        return {
          messageCount: 0,
          totalBytesProcessed: 0,
          createdAt: state.createdAt,
        };
    }
  },
};

// =============================================================================
// Slow Behavior
// =============================================================================

/**
 * State for the slow behavior.
 */
export interface SlowState {
  readonly delayMs: number;
  readonly processedCount: number;
  readonly createdAt: number;
}

/**
 * Call messages for slow behavior.
 */
export type SlowCallMsg =
  | { readonly type: 'slow_echo'; readonly payload: unknown }
  | { readonly type: 'get_stats' }
  | { readonly type: 'set_delay'; readonly delayMs: number };

/**
 * Cast messages for slow behavior.
 */
export type SlowCastMsg =
  | { readonly type: 'slow_ping' }
  | { readonly type: 'set_delay'; readonly delayMs: number };

/**
 * Reply types for slow calls.
 */
export type SlowCallReply =
  | { readonly payload: unknown; readonly actualDelayMs: number }
  | { readonly processedCount: number; readonly delayMs: number; readonly uptimeMs: number }
  | { readonly ok: true };

/**
 * Creates a slow behavior with configurable delay.
 *
 * Used for timeout testing - the delay is applied to every operation,
 * allowing tests to verify timeout handling and retry logic.
 *
 * @param defaultDelayMs - Default delay in milliseconds for each operation
 */
export function createSlowBehavior(
  defaultDelayMs: number,
): GenServerBehavior<SlowState, SlowCallMsg, SlowCastMsg, SlowCallReply> {
  return {
    init(): SlowState {
      return {
        delayMs: defaultDelayMs,
        processedCount: 0,
        createdAt: Date.now(),
      };
    },

    async handleCall(msg, state): Promise<CallResult<SlowCallReply, SlowState>> {
      switch (msg.type) {
        case 'slow_echo': {
          const startTime = Date.now();
          await delay(state.delayMs);
          const newState: SlowState = {
            ...state,
            processedCount: state.processedCount + 1,
          };
          return [
            { payload: msg.payload, actualDelayMs: Date.now() - startTime },
            newState,
          ];
        }

        case 'get_stats':
          return [
            {
              processedCount: state.processedCount,
              delayMs: state.delayMs,
              uptimeMs: Date.now() - state.createdAt,
            },
            state,
          ];

        case 'set_delay':
          return [{ ok: true }, { ...state, delayMs: msg.delayMs }];
      }
    },

    async handleCast(msg, state): Promise<SlowState> {
      switch (msg.type) {
        case 'slow_ping':
          await delay(state.delayMs);
          return {
            ...state,
            processedCount: state.processedCount + 1,
          };

        case 'set_delay':
          return { ...state, delayMs: msg.delayMs };
      }
    },
  };
}

/**
 * Default slow behavior with 100ms delay.
 */
export const slowBehavior = createSlowBehavior(100);

// =============================================================================
// Crash After N Behavior
// =============================================================================

/**
 * State for the crash-after-n behavior.
 */
export interface CrashAfterNState {
  readonly crashAfter: number;
  readonly currentCount: number;
  readonly createdAt: number;
}

/**
 * Call messages for crash-after-n behavior.
 */
export type CrashAfterNCallMsg =
  | { readonly type: 'operation' }
  | { readonly type: 'get_remaining' }
  | { readonly type: 'reset'; readonly crashAfter?: number };

/**
 * Cast messages for crash-after-n behavior.
 */
export type CrashAfterNCastMsg =
  | { readonly type: 'operation' }
  | { readonly type: 'force_crash' };

/**
 * Reply types for crash-after-n calls.
 */
export type CrashAfterNCallReply =
  | { readonly ok: true; readonly remaining: number }
  | { readonly remaining: number; readonly currentCount: number }
  | { readonly ok: true };

/**
 * Creates a behavior that crashes after N operations.
 *
 * Used for testing fault tolerance, supervisor restart strategies,
 * and recovery scenarios. Both calls and casts count toward the limit.
 *
 * @param crashAfter - Number of operations before crash (0 = immediate crash)
 */
export function createCrashAfterNBehavior(
  crashAfter: number,
): GenServerBehavior<CrashAfterNState, CrashAfterNCallMsg, CrashAfterNCastMsg, CrashAfterNCallReply> {
  return {
    init(): CrashAfterNState {
      return {
        crashAfter,
        currentCount: 0,
        createdAt: Date.now(),
      };
    },

    handleCall(msg, state): CallResult<CrashAfterNCallReply, CrashAfterNState> {
      switch (msg.type) {
        case 'operation': {
          const newCount = state.currentCount + 1;
          if (newCount >= state.crashAfter) {
            throw new Error(
              `CrashAfterN: Intentional crash after ${newCount} operations`,
            );
          }
          const newState: CrashAfterNState = {
            ...state,
            currentCount: newCount,
          };
          return [{ ok: true, remaining: state.crashAfter - newCount }, newState];
        }

        case 'get_remaining':
          return [
            {
              remaining: state.crashAfter - state.currentCount,
              currentCount: state.currentCount,
            },
            state,
          ];

        case 'reset': {
          const newCrashAfter = msg.crashAfter ?? state.crashAfter;
          return [
            { ok: true },
            {
              crashAfter: newCrashAfter,
              currentCount: 0,
              createdAt: state.createdAt,
            },
          ];
        }
      }
    },

    handleCast(msg, state): CrashAfterNState {
      switch (msg.type) {
        case 'operation': {
          const newCount = state.currentCount + 1;
          if (newCount >= state.crashAfter) {
            throw new Error(
              `CrashAfterN: Intentional crash after ${newCount} operations`,
            );
          }
          return {
            ...state,
            currentCount: newCount,
          };
        }

        case 'force_crash':
          throw new Error('CrashAfterN: Forced crash via cast');
      }
    },
  };
}

/**
 * Default crash-after-n behavior that crashes after 10 operations.
 */
export const crashAfterNBehavior = createCrashAfterNBehavior(10);

// =============================================================================
// Memory Hog Behavior
// =============================================================================

/**
 * State for the memory hog behavior.
 */
export interface MemoryHogState {
  readonly targetSizeKb: number;
  readonly data: readonly number[];
  readonly operationCount: number;
  readonly createdAt: number;
}

/**
 * Call messages for memory hog behavior.
 */
export type MemoryHogCallMsg =
  | { readonly type: 'get_size' }
  | { readonly type: 'grow'; readonly additionalKb: number }
  | { readonly type: 'shrink'; readonly targetKb: number }
  | { readonly type: 'get_stats' };

/**
 * Cast messages for memory hog behavior.
 */
export type MemoryHogCastMsg =
  | { readonly type: 'grow'; readonly additionalKb: number }
  | { readonly type: 'shrink'; readonly targetKb: number }
  | { readonly type: 'reset' };

/**
 * Reply types for memory hog calls.
 */
export type MemoryHogCallReply =
  | { readonly sizeKb: number; readonly elementCount: number }
  | { readonly ok: true; readonly newSizeKb: number }
  | { readonly operationCount: number; readonly sizeKb: number; readonly uptimeMs: number };

/**
 * Number of 64-bit floats (8 bytes each) per kilobyte.
 */
const FLOATS_PER_KB = 128;

/**
 * Creates state data of the specified size.
 */
function createDataArray(sizeKb: number): readonly number[] {
  const elementCount = Math.max(0, Math.floor(sizeKb * FLOATS_PER_KB));
  const data: number[] = new Array(elementCount);
  for (let i = 0; i < elementCount; i++) {
    data[i] = Math.random();
  }
  return data;
}

/**
 * Creates a behavior with large state for memory pressure testing.
 *
 * Used to test memory limits, GC behavior, and state serialization
 * performance under memory pressure.
 *
 * @param initialSizeKb - Initial state size in kilobytes
 */
export function createMemoryHogBehavior(
  initialSizeKb: number,
): GenServerBehavior<MemoryHogState, MemoryHogCallMsg, MemoryHogCastMsg, MemoryHogCallReply> {
  return {
    init(): MemoryHogState {
      return {
        targetSizeKb: initialSizeKb,
        data: createDataArray(initialSizeKb),
        operationCount: 0,
        createdAt: Date.now(),
      };
    },

    handleCall(msg, state): CallResult<MemoryHogCallReply, MemoryHogState> {
      switch (msg.type) {
        case 'get_size': {
          const actualSizeKb = state.data.length / FLOATS_PER_KB;
          return [
            { sizeKb: actualSizeKb, elementCount: state.data.length },
            state,
          ];
        }

        case 'grow': {
          const newTargetKb = state.targetSizeKb + msg.additionalKb;
          const newData = createDataArray(newTargetKb);
          const newState: MemoryHogState = {
            targetSizeKb: newTargetKb,
            data: newData,
            operationCount: state.operationCount + 1,
            createdAt: state.createdAt,
          };
          return [{ ok: true, newSizeKb: newTargetKb }, newState];
        }

        case 'shrink': {
          const newTargetKb = Math.max(0, msg.targetKb);
          const newData = createDataArray(newTargetKb);
          const newState: MemoryHogState = {
            targetSizeKb: newTargetKb,
            data: newData,
            operationCount: state.operationCount + 1,
            createdAt: state.createdAt,
          };
          return [{ ok: true, newSizeKb: newTargetKb }, newState];
        }

        case 'get_stats': {
          const actualSizeKb = state.data.length / FLOATS_PER_KB;
          return [
            {
              operationCount: state.operationCount,
              sizeKb: actualSizeKb,
              uptimeMs: Date.now() - state.createdAt,
            },
            state,
          ];
        }
      }
    },

    handleCast(msg, state): MemoryHogState {
      switch (msg.type) {
        case 'grow': {
          const newTargetKb = state.targetSizeKb + msg.additionalKb;
          return {
            targetSizeKb: newTargetKb,
            data: createDataArray(newTargetKb),
            operationCount: state.operationCount + 1,
            createdAt: state.createdAt,
          };
        }

        case 'shrink': {
          const newTargetKb = Math.max(0, msg.targetKb);
          return {
            targetSizeKb: newTargetKb,
            data: createDataArray(newTargetKb),
            operationCount: state.operationCount + 1,
            createdAt: state.createdAt,
          };
        }

        case 'reset':
          return {
            targetSizeKb: 0,
            data: [],
            operationCount: state.operationCount + 1,
            createdAt: state.createdAt,
          };
      }
    },
  };
}

/**
 * Default memory hog behavior with 1MB initial size.
 */
export const memoryHogBehavior = createMemoryHogBehavior(1024);

// =============================================================================
// Stateful Behavior
// =============================================================================

/**
 * State for the stateful behavior with rich data operations.
 */
export interface StatefulState {
  readonly items: ReadonlyMap<string, unknown>;
  readonly operationLog: readonly OperationLogEntry[];
  readonly maxLogSize: number;
  readonly createdAt: number;
}

/**
 * Entry in the operation log.
 */
export interface OperationLogEntry {
  readonly type: string;
  readonly key?: string;
  readonly timestamp: number;
}

/**
 * Call messages for stateful behavior.
 */
export type StatefulCallMsg =
  | { readonly type: 'get'; readonly key: string }
  | { readonly type: 'set'; readonly key: string; readonly value: unknown }
  | { readonly type: 'delete'; readonly key: string }
  | { readonly type: 'list_keys' }
  | { readonly type: 'get_log'; readonly limit?: number }
  | { readonly type: 'clear' };

/**
 * Cast messages for stateful behavior.
 */
export type StatefulCastMsg =
  | { readonly type: 'set'; readonly key: string; readonly value: unknown }
  | { readonly type: 'delete'; readonly key: string }
  | { readonly type: 'clear' };

/**
 * Reply types for stateful calls.
 */
export type StatefulCallReply =
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false }
  | { readonly ok: true }
  | { readonly keys: readonly string[] }
  | { readonly log: readonly OperationLogEntry[] };

/**
 * Creates a stateful behavior with key-value storage and operation logging.
 *
 * Used for testing complex state management, state synchronization
 * across nodes, and recovery after crashes.
 *
 * @param maxLogSize - Maximum number of operations to keep in the log
 */
export function createStatefulBehavior(
  maxLogSize: number = 100,
): GenServerBehavior<StatefulState, StatefulCallMsg, StatefulCastMsg, StatefulCallReply> {
  const addLogEntry = (
    state: StatefulState,
    type: string,
    key?: string,
  ): readonly OperationLogEntry[] => {
    const entry: OperationLogEntry = { type, key, timestamp: Date.now() };
    const newLog = [...state.operationLog, entry];
    return newLog.slice(-state.maxLogSize);
  };

  return {
    init(): StatefulState {
      return {
        items: new Map(),
        operationLog: [],
        maxLogSize,
        createdAt: Date.now(),
      };
    },

    handleCall(msg, state): CallResult<StatefulCallReply, StatefulState> {
      switch (msg.type) {
        case 'get': {
          const value = state.items.get(msg.key);
          const newLog = addLogEntry(state, 'get', msg.key);
          const newState: StatefulState = { ...state, operationLog: newLog };
          if (value !== undefined) {
            return [{ found: true, value }, newState];
          }
          return [{ found: false }, newState];
        }

        case 'set': {
          const newItems = new Map(state.items);
          newItems.set(msg.key, msg.value);
          const newLog = addLogEntry(state, 'set', msg.key);
          return [
            { ok: true },
            { ...state, items: newItems, operationLog: newLog },
          ];
        }

        case 'delete': {
          const newItems = new Map(state.items);
          newItems.delete(msg.key);
          const newLog = addLogEntry(state, 'delete', msg.key);
          return [
            { ok: true },
            { ...state, items: newItems, operationLog: newLog },
          ];
        }

        case 'list_keys': {
          const newLog = addLogEntry(state, 'list_keys');
          return [
            { keys: Array.from(state.items.keys()) },
            { ...state, operationLog: newLog },
          ];
        }

        case 'get_log': {
          const limit = msg.limit ?? state.maxLogSize;
          return [{ log: state.operationLog.slice(-limit) }, state];
        }

        case 'clear': {
          const newLog = addLogEntry(state, 'clear');
          return [
            { ok: true },
            { ...state, items: new Map(), operationLog: newLog },
          ];
        }
      }
    },

    handleCast(msg, state): StatefulState {
      switch (msg.type) {
        case 'set': {
          const newItems = new Map(state.items);
          newItems.set(msg.key, msg.value);
          const newLog = addLogEntry(state, 'set', msg.key);
          return { ...state, items: newItems, operationLog: newLog };
        }

        case 'delete': {
          const newItems = new Map(state.items);
          newItems.delete(msg.key);
          const newLog = addLogEntry(state, 'delete', msg.key);
          return { ...state, items: newItems, operationLog: newLog };
        }

        case 'clear': {
          const newLog = addLogEntry(state, 'clear');
          return { ...state, items: new Map(), operationLog: newLog };
        }
      }
    },
  };
}

/**
 * Default stateful behavior with 100 entry log limit.
 */
export const statefulBehavior = createStatefulBehavior(100);

// =============================================================================
// Crash On Init Behavior
// =============================================================================

/**
 * State for the crash-on-init behavior (never reached).
 */
export interface CrashOnInitState {
  readonly initialized: boolean;
}

/**
 * Call messages for crash-on-init behavior.
 */
export type CrashOnInitCallMsg = { readonly type: 'ping' };

/**
 * Cast messages for crash-on-init behavior.
 */
export type CrashOnInitCastMsg = { readonly type: 'ping' };

/**
 * Reply types for crash-on-init calls.
 */
export type CrashOnInitCallReply = { readonly pong: true };

/**
 * Creates a behavior that throws during initialization.
 *
 * Used for testing error handling when spawning processes that fail
 * during their init phase.
 *
 * @param errorMessage - Custom error message (default: 'Intentional init crash')
 */
export function createCrashOnInitBehavior(
  errorMessage: string = 'Intentional init crash',
): GenServerBehavior<CrashOnInitState, CrashOnInitCallMsg, CrashOnInitCastMsg, CrashOnInitCallReply> {
  return {
    init(): CrashOnInitState {
      throw new Error(errorMessage);
    },

    handleCall(_msg, state): CallResult<CrashOnInitCallReply, CrashOnInitState> {
      return [{ pong: true }, state];
    },

    handleCast(_msg, state): CrashOnInitState {
      return state;
    },
  };
}

/**
 * Default crash-on-init behavior.
 */
export const crashOnInitBehavior = createCrashOnInitBehavior();

// =============================================================================
// Utilities
// =============================================================================

/**
 * Promise-based delay utility.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Behavior Registry Helpers
// =============================================================================

/**
 * All stress test behaviors with their registry names.
 *
 * Use this to register all behaviors at once in test setup.
 */
export const stressTestBehaviors = {
  counter: counterBehavior,
  echo: echoBehavior,
  slow: slowBehavior,
  crashAfterN: crashAfterNBehavior,
  memoryHog: memoryHogBehavior,
  stateful: statefulBehavior,
  crashOnInit: crashOnInitBehavior,
} as const;

/**
 * Type for behavior names in the stress test suite.
 */
export type StressTestBehaviorName = keyof typeof stressTestBehaviors;
