/**
 * DurableTimerService - a GenServer-based timer service with persistence.
 *
 * Unlike GenServer.sendAfter() which is non-durable (lost on process restart),
 * this service persists timer entries via a StorageAdapter. On restart, pending
 * timers are restored and continue to fire as expected.
 *
 * Supports one-shot and repeating timers. Messages are delivered via GenServer.cast().
 */

import { GenServer } from '../core/gen-server.js';
import type { GenServerRef, GenServerBehavior } from '../core/types.js';
import type { StorageAdapter, PersistedState } from '../persistence/types.js';

// ─── Public Types ───────────────────────────────────────────────────────────

export interface DurableTimerOptions {
  /** Storage adapter for timer persistence */
  readonly adapter: StorageAdapter;
  /** How often to check for expired timers (ms). Default: 1000 */
  readonly checkIntervalMs?: number;
  /** Optional name for registry registration */
  readonly name?: string;
}

export interface TimerEntry {
  /** Unique timer identifier */
  readonly id: string;
  /** Unix timestamp (ms) when the timer should fire */
  readonly fireAt: number;
  /** Target process reference */
  readonly targetRef: StoredRef;
  /** Message to deliver via GenServer.cast() */
  readonly message: unknown;
  /** If set, the timer repeats with this interval (ms) */
  readonly repeat?: number;
}

export interface ScheduleOptions {
  /** If set, the timer repeats with this interval (ms) */
  readonly repeat?: number;
}

// ─── Internal Types ─────────────────────────────────────────────────────────

interface StoredRef {
  readonly id: string;
  readonly nodeId?: string;
}

interface TimerServiceState {
  readonly timers: Map<string, TimerEntry>;
  readonly adapter: StorageAdapter;
}

type TimerCallMsg =
  | { readonly type: 'schedule'; readonly targetRef: StoredRef; readonly message: unknown; readonly delayMs: number; readonly repeat?: number }
  | { readonly type: 'cancel'; readonly timerId: string }
  | { readonly type: 'get'; readonly timerId: string }
  | { readonly type: 'getAll' };

type TimerCastMsg =
  | { readonly type: 'tick' };

type TimerCallReply = string | boolean | TimerEntry | undefined | readonly TimerEntry[];

export type TimerServiceRef = GenServerRef<TimerServiceState, TimerCallMsg, TimerCastMsg, TimerCallReply>;

// ─── Storage ────────────────────────────────────────────────────────────────

const STORAGE_KEY_PREFIX = 'durable_timer:';

function timerStorageKey(timerId: string): string {
  return `${STORAGE_KEY_PREFIX}${timerId}`;
}

async function persistTimer(adapter: StorageAdapter, entry: TimerEntry): Promise<void> {
  const persisted: PersistedState<TimerEntry> = {
    state: entry,
    metadata: {
      persistedAt: Date.now(),
      serverId: 'timer-service',
      schemaVersion: 1,
    },
  };
  await adapter.save(timerStorageKey(entry.id), persisted);
}

async function removePersistedTimer(adapter: StorageAdapter, timerId: string): Promise<void> {
  await adapter.delete(timerStorageKey(timerId));
}

async function loadAllTimers(adapter: StorageAdapter): Promise<Map<string, TimerEntry>> {
  const keys = await adapter.listKeys(STORAGE_KEY_PREFIX);
  const timers = new Map<string, TimerEntry>();

  for (const key of keys) {
    const persisted = await adapter.load<TimerEntry>(key);
    if (persisted) {
      timers.set(persisted.state.id, persisted.state);
    }
  }

  return timers;
}

// ─── Timer ID Generation ────────────────────────────────────────────────────

let durableTimerIdCounter = 0;

function generateDurableTimerId(): string {
  return `dtimer_${++durableTimerIdCounter}_${Date.now().toString(36)}`;
}

// ─── Check Interval Management ─────────────────────────────────────────────

const checkIntervals = new Map<string, ReturnType<typeof setInterval>>();

// ─── Behavior ───────────────────────────────────────────────────────────────

function createTimerServiceBehavior(
  adapter: StorageAdapter,
): GenServerBehavior<TimerServiceState, TimerCallMsg, TimerCastMsg, TimerCallReply> {
  return {
    async init(): Promise<TimerServiceState> {
      const timers = await loadAllTimers(adapter);
      return { timers, adapter };
    },

    handleCall(msg: TimerCallMsg, state: TimerServiceState): [TimerCallReply, TimerServiceState] {
      switch (msg.type) {
        case 'schedule': {
          const id = generateDurableTimerId();
          const base = {
            id,
            fireAt: Date.now() + msg.delayMs,
            targetRef: msg.targetRef,
            message: msg.message,
          };
          const entry: TimerEntry = msg.repeat !== undefined
            ? { ...base, repeat: msg.repeat }
            : base;
          const newTimers = new Map(state.timers);
          newTimers.set(id, entry);

          // Persist asynchronously (fire-and-forget from call handler perspective)
          void persistTimer(state.adapter, entry);

          return [id, { ...state, timers: newTimers }];
        }

        case 'cancel': {
          const existed = state.timers.has(msg.timerId);
          if (!existed) {
            return [false, state];
          }
          const newTimers = new Map(state.timers);
          newTimers.delete(msg.timerId);

          void removePersistedTimer(state.adapter, msg.timerId);

          return [true, { ...state, timers: newTimers }];
        }

        case 'get': {
          const entry = state.timers.get(msg.timerId);
          return [entry, state];
        }

        case 'getAll': {
          return [Array.from(state.timers.values()), state];
        }
      }
    },

    handleCast(msg: TimerCastMsg, state: TimerServiceState): TimerServiceState {
      if (msg.type !== 'tick') return state;

      const now = Date.now();
      const expired: TimerEntry[] = [];

      for (const entry of state.timers.values()) {
        if (entry.fireAt <= now) {
          expired.push(entry);
        }
      }

      if (expired.length === 0) return state;

      const newTimers = new Map(state.timers);

      for (const entry of expired) {
        // Deliver the message to target
        const targetRef = { id: entry.targetRef.id, nodeId: entry.targetRef.nodeId } as GenServerRef<unknown, unknown, unknown, unknown>;
        try {
          GenServer.cast(targetRef, entry.message);
        } catch {
          // Target not running - silently discard
        }

        if (entry.repeat !== undefined && entry.repeat > 0) {
          // Reschedule repeating timer
          const next: TimerEntry = { ...entry, fireAt: now + entry.repeat };
          newTimers.set(entry.id, next);
          void persistTimer(state.adapter, next);
        } else {
          // Remove one-shot timer
          newTimers.delete(entry.id);
          void removePersistedTimer(state.adapter, entry.id);
        }
      }

      return { ...state, timers: newTimers };
    },

    async terminate(): Promise<void> {
      // Cleanup is handled by TimerService.stop()
    },
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export const TimerService = {
  /**
   * Starts a new DurableTimerService instance.
   *
   * Loads any previously persisted timers from the adapter and begins
   * periodic checking for expired timers.
   */
  async start(options: DurableTimerOptions): Promise<TimerServiceRef> {
    const behavior = createTimerServiceBehavior(options.adapter);
    const startOptions = options.name !== undefined ? { name: options.name } : {};
    const ref = await GenServer.start(behavior, startOptions) as TimerServiceRef;

    const intervalMs = options.checkIntervalMs ?? 1000;
    const intervalId = setInterval(() => {
      if (GenServer.isRunning(ref)) {
        GenServer.cast(ref, { type: 'tick' });
      }
    }, intervalMs);

    checkIntervals.set(ref.id, intervalId);

    return ref;
  },

  /**
   * Schedules a durable timer that delivers a cast message to the target
   * after the specified delay. Survives process restarts.
   *
   * @returns The timer ID for later cancellation
   */
  async schedule(
    ref: TimerServiceRef,
    targetRef: GenServerRef,
    message: unknown,
    delayMs: number,
    options: ScheduleOptions = {},
  ): Promise<string> {
    const storedRef: StoredRef = targetRef.nodeId !== undefined
      ? { id: targetRef.id, nodeId: targetRef.nodeId }
      : { id: targetRef.id };
    const callMsg: TimerCallMsg = options.repeat !== undefined
      ? { type: 'schedule', targetRef: storedRef, message, delayMs, repeat: options.repeat }
      : { type: 'schedule', targetRef: storedRef, message, delayMs };
    const reply = await GenServer.call(ref, callMsg);
    return reply as string;
  },

  /**
   * Cancels a previously scheduled durable timer.
   *
   * @returns true if the timer was pending and was cancelled, false otherwise
   */
  async cancel(ref: TimerServiceRef, timerId: string): Promise<boolean> {
    const reply = await GenServer.call(ref, { type: 'cancel', timerId });
    return reply as boolean;
  },

  /**
   * Returns a specific timer entry by ID, or undefined if not found.
   */
  async get(ref: TimerServiceRef, timerId: string): Promise<TimerEntry | undefined> {
    const reply = await GenServer.call(ref, { type: 'get', timerId });
    return reply as TimerEntry | undefined;
  },

  /**
   * Returns all pending timer entries.
   */
  async getAll(ref: TimerServiceRef): Promise<readonly TimerEntry[]> {
    const reply = await GenServer.call(ref, { type: 'getAll' });
    return reply as readonly TimerEntry[];
  },

  /**
   * Checks if the timer service is running.
   */
  isRunning(ref: TimerServiceRef): boolean {
    return GenServer.isRunning(ref);
  },

  /**
   * Stops the timer service. Persisted timers remain in storage
   * and will be restored on next start.
   */
  async stop(ref: TimerServiceRef): Promise<void> {
    const intervalId = checkIntervals.get(ref.id);
    if (intervalId !== undefined) {
      clearInterval(intervalId);
      checkIntervals.delete(ref.id);
    }
    await GenServer.stop(ref);
  },

  /**
   * Resets the durable timer ID counter.
   * @internal
   */
  _resetIdCounter(): void {
    durableTimerIdCounter = 0;
  },
} as const;
