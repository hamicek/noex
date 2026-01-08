/**
 * GenServer behaviors for the distributed counter example.
 *
 * Implements:
 * - Counter: Simple incrementing/decrementing counter
 * - CounterWatcher: Monitors counters and reacts to their termination
 */

import type { GenServerBehavior, CallResult } from 'noex';
import type {
  CounterState,
  CounterCallMsg,
  CounterCastMsg,
  CounterCallReply,
  CounterWatcherState,
  CounterWatcherCallMsg,
  CounterWatcherCastMsg,
  CounterWatcherCallReply,
  WatchedCounter,
} from './types.js';

// =============================================================================
// Counter Behavior
// =============================================================================

/**
 * Creates a counter behavior with the specified name.
 */
export function createCounterBehavior(
  counterName: string,
  initialValue = 0,
): GenServerBehavior<CounterState, CounterCallMsg, CounterCastMsg, CounterCallReply> {
  return {
    init(): CounterState {
      return {
        name: counterName,
        value: initialValue,
        lastUpdated: Date.now(),
      };
    },

    handleCall(msg, state): CallResult<CounterCallReply, CounterState> {
      switch (msg.type) {
        case 'get': {
          return [{ value: state.value }, state];
        }

        case 'get_info': {
          return [
            {
              name: state.name,
              value: state.value,
              lastUpdated: state.lastUpdated,
            },
            state,
          ];
        }
      }
    },

    handleCast(msg, state): CounterState {
      switch (msg.type) {
        case 'increment': {
          const by = msg.by ?? 1;
          return {
            ...state,
            value: state.value + by,
            lastUpdated: Date.now(),
          };
        }

        case 'decrement': {
          const by = msg.by ?? 1;
          return {
            ...state,
            value: state.value - by,
            lastUpdated: Date.now(),
          };
        }

        case 'set': {
          return {
            ...state,
            value: msg.value,
            lastUpdated: Date.now(),
          };
        }
      }
    },
  };
}

/**
 * Generic counter behavior for remote spawning.
 */
export const counterBehavior: GenServerBehavior<
  CounterState,
  CounterCallMsg,
  CounterCastMsg,
  CounterCallReply
> = {
  init(): CounterState {
    return {
      name: 'unnamed',
      value: 0,
      lastUpdated: Date.now(),
    };
  },

  handleCall(
    msg: CounterCallMsg,
    state: CounterState,
  ): CallResult<CounterCallReply, CounterState> | Promise<CallResult<CounterCallReply, CounterState>> {
    return createCounterBehavior(state.name, state.value).handleCall(msg, state);
  },

  handleCast(msg: CounterCastMsg, state: CounterState): CounterState | Promise<CounterState> {
    return createCounterBehavior(state.name, state.value).handleCast(msg, state);
  },
};

// =============================================================================
// Counter Watcher Behavior
// =============================================================================

/**
 * Creates a counter watcher behavior.
 *
 * The watcher monitors counters and emits events when they go down.
 * Uses RemoteMonitor for cross-node process monitoring.
 */
export function createCounterWatcherBehavior(): GenServerBehavior<
  CounterWatcherState,
  CounterWatcherCallMsg,
  CounterWatcherCastMsg,
  CounterWatcherCallReply
> {
  return {
    init(): CounterWatcherState {
      return {
        watched: new Map(),
        onEvent: null,
      };
    },

    handleCall(msg, state): CallResult<CounterWatcherCallReply, CounterWatcherState> {
      switch (msg.type) {
        case 'watch': {
          if (state.watched.has(msg.name)) {
            return [{ ok: false, error: `Already watching counter "${msg.name}"` }, state];
          }

          // Note: The actual monitoring is set up in node.ts using RemoteMonitor.monitor()
          // This call just registers the counter in the watcher state.
          // The monitorId will be updated after the monitor is established.
          const watchedCounter: WatchedCounter = {
            name: msg.name,
            counterRef: msg.counterRef,
            monitorId: '' as never, // Will be set by node.ts
            watchedAt: Date.now(),
            lastKnownValue: null,
          };

          const newWatched = new Map(state.watched);
          newWatched.set(msg.name, watchedCounter);

          if (state.onEvent) {
            state.onEvent({
              type: 'watch_started',
              name: msg.name,
              nodeId: msg.counterRef.nodeId,
            });
          }

          return [{ ok: true }, { ...state, watched: newWatched }];
        }

        case 'unwatch': {
          if (!state.watched.has(msg.name)) {
            return [{ ok: false, error: `Not watching counter "${msg.name}"` }, state];
          }

          const newWatched = new Map(state.watched);
          newWatched.delete(msg.name);

          if (state.onEvent) {
            state.onEvent({
              type: 'watch_stopped',
              name: msg.name,
            });
          }

          return [{ ok: true }, { ...state, watched: newWatched }];
        }

        case 'get_watched': {
          const watched = Array.from(state.watched.values()).map((w) => ({
            name: w.name,
            nodeId: w.counterRef.nodeId,
            lastKnownValue: w.lastKnownValue,
          }));
          return [{ watched }, state];
        }

        case 'set_event_handler': {
          return [{ ok: true }, { ...state, onEvent: msg.handler }];
        }
      }
    },

    handleCast(msg, state): CounterWatcherState {
      switch (msg.type) {
        case 'counter_down': {
          const watched = state.watched.get(msg.name);
          if (!watched) {
            return state;
          }

          if (state.onEvent) {
            state.onEvent({
              type: 'counter_down',
              name: msg.name,
              nodeId: watched.counterRef.nodeId,
              reason: msg.reason,
            });
          }

          // Remove from watched
          const newWatched = new Map(state.watched);
          newWatched.delete(msg.name);

          return { ...state, watched: newWatched };
        }

        case 'value_updated': {
          const watched = state.watched.get(msg.name);
          if (!watched) {
            return state;
          }

          // Update last known value (mutable for efficiency)
          watched.lastKnownValue = msg.value;
          return state;
        }
      }
    },
  };
}

/**
 * Generic counter watcher behavior for remote spawning.
 */
export const counterWatcherBehavior: GenServerBehavior<
  CounterWatcherState,
  CounterWatcherCallMsg,
  CounterWatcherCastMsg,
  CounterWatcherCallReply
> = createCounterWatcherBehavior();
