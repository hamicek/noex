/**
 * RateLimiter - Rate limiting service built on GenServer.
 *
 * Implements sliding window rate limiting with per-key tracking.
 * This is more accurate than fixed window approaches as it smoothly
 * transitions between windows.
 *
 * @example
 * ```typescript
 * const limiter = await RateLimiter.start({
 *   maxRequests: 100,
 *   windowMs: 60000, // 100 requests per minute
 * });
 *
 * // Check if request is allowed
 * const result = await RateLimiter.check(limiter, 'user:123');
 * if (result.allowed) {
 *   // Process request
 * } else {
 *   console.log(`Rate limited. Retry after ${result.retryAfterMs}ms`);
 * }
 *
 * // Or use consume which throws on limit exceeded
 * try {
 *   await RateLimiter.consume(limiter, 'api:endpoint');
 *   // Process request
 * } catch (e) {
 *   if (e instanceof RateLimitExceededError) {
 *     res.status(429).send('Too many requests');
 *   }
 * }
 *
 * await RateLimiter.stop(limiter);
 * ```
 */

import { GenServer, type GenServerRef, type GenServerBehavior } from '../index.js';

/**
 * Error thrown when rate limit is exceeded.
 */
export class RateLimitExceededError extends Error {
  override readonly name = 'RateLimitExceededError' as const;

  constructor(
    readonly key: string,
    readonly retryAfterMs: number,
  ) {
    super(`Rate limit exceeded for '${key}'. Retry after ${retryAfterMs}ms`);
  }
}

/**
 * Sliding window entry tracking requests for a key.
 */
interface WindowEntry {
  /**
   * Timestamps of requests in the current window.
   */
  timestamps: number[];

  /**
   * Count of requests in the previous window (for sliding calculation).
   */
  previousWindowCount: number;

  /**
   * Start time of the current window.
   */
  windowStart: number;
}

/**
 * RateLimiter internal state.
 */
interface RateLimiterState {
  readonly entries: Map<string, WindowEntry>;
  readonly maxRequests: number;
  readonly windowMs: number;
}

/**
 * Options for RateLimiter.start()
 */
export interface RateLimiterOptions {
  /**
   * Maximum number of requests allowed in the time window.
   */
  readonly maxRequests: number;

  /**
   * Time window in milliseconds.
   */
  readonly windowMs: number;

  /**
   * Optional name for registry registration.
   */
  readonly name?: string;
}

/**
 * Result of a rate limit check.
 */
export interface RateLimitResult {
  /**
   * Whether the request is allowed.
   */
  readonly allowed: boolean;

  /**
   * Current number of requests in the window.
   */
  readonly current: number;

  /**
   * Maximum requests allowed.
   */
  readonly limit: number;

  /**
   * Remaining requests in the window.
   */
  readonly remaining: number;

  /**
   * Milliseconds until the window resets.
   */
  readonly resetMs: number;

  /**
   * Milliseconds to wait before retrying (0 if allowed).
   */
  readonly retryAfterMs: number;
}

/**
 * Per-key rate limit configuration override.
 */
export interface KeyLimitOverride {
  readonly maxRequests: number;
  readonly windowMs?: number;
}

/**
 * Call messages for RateLimiter.
 */
type RateLimiterCallMsg =
  | { readonly type: 'check'; readonly key: string; readonly cost?: number }
  | { readonly type: 'consume'; readonly key: string; readonly cost?: number }
  | { readonly type: 'reset'; readonly key: string }
  | { readonly type: 'getStatus'; readonly key: string }
  | { readonly type: 'getKeys' };

/**
 * Cast messages for RateLimiter (background operations).
 */
type RateLimiterCastMsg =
  | { readonly type: 'cleanup' };

/**
 * Reply types for RateLimiter calls.
 */
type RateLimiterCallReply =
  | RateLimitResult
  | boolean
  | readonly string[];

/**
 * RateLimiter reference type.
 */
export type RateLimiterRef = GenServerRef<
  RateLimiterState,
  RateLimiterCallMsg,
  RateLimiterCastMsg,
  RateLimiterCallReply
>;

/**
 * Returns current timestamp in milliseconds.
 */
function now(): number {
  return Date.now();
}

/**
 * Prunes expired timestamps from the entry.
 * Removes all timestamps older than windowMs from the current time.
 */
function pruneExpiredTimestamps(
  entry: WindowEntry,
  windowMs: number,
  timestamp: number,
): void {
  const cutoff = timestamp - windowMs;
  entry.timestamps = entry.timestamps.filter(t => t > cutoff);
}

/**
 * Calculates the current request count using sliding window log algorithm.
 * This counts all requests within the last windowMs milliseconds.
 */
function calculateSlidingWindowCount(
  entry: WindowEntry,
  windowMs: number,
  timestamp: number,
): number {
  const cutoff = timestamp - windowMs;
  return entry.timestamps.filter(t => t > cutoff).length;
}

/**
 * Updates the window entry, pruning expired timestamps.
 */
function updateWindow(
  entry: WindowEntry,
  windowMs: number,
  timestamp: number,
): void {
  pruneExpiredTimestamps(entry, windowMs, timestamp);
}

/**
 * Creates the RateLimiter behavior implementation.
 */
function createRateLimiterBehavior(options: RateLimiterOptions): GenServerBehavior<
  RateLimiterState,
  RateLimiterCallMsg,
  RateLimiterCastMsg,
  RateLimiterCallReply
> {
  const { maxRequests, windowMs } = options;

  return {
    init(): RateLimiterState {
      return {
        entries: new Map(),
        maxRequests,
        windowMs,
      };
    },

    handleCall(
      msg: RateLimiterCallMsg,
      state: RateLimiterState,
    ): readonly [RateLimiterCallReply, RateLimiterState] {
      const timestamp = now();

      switch (msg.type) {
        case 'check':
        case 'consume': {
          const cost = msg.cost ?? 1;
          let entry = state.entries.get(msg.key);

          // Create new entry if doesn't exist
          if (!entry) {
            entry = {
              timestamps: [],
              previousWindowCount: 0,
              windowStart: timestamp,
            };
            state.entries.set(msg.key, entry);
          }

          // Update window if needed
          updateWindow(entry, state.windowMs, timestamp);

          // Calculate current count using sliding window
          const currentCount = calculateSlidingWindowCount(entry, state.windowMs, timestamp);
          const remaining = Math.max(0, state.maxRequests - currentCount);
          const allowed = currentCount + cost <= state.maxRequests;

          // Calculate reset time (time until oldest request expires)
          let resetMs = state.windowMs;
          if (entry.timestamps.length > 0) {
            const oldestTimestamp = entry.timestamps[0];
            if (oldestTimestamp !== undefined) {
              const expireTime = oldestTimestamp + state.windowMs;
              resetMs = Math.max(0, expireTime - timestamp);
            }
          }

          // Calculate retry after (when enough requests will have expired to allow this request)
          let retryAfterMs = 0;
          if (!allowed && entry.timestamps.length > 0) {
            // Need to wait until oldest request expires
            const oldestTimestamp = entry.timestamps[0];
            if (oldestTimestamp !== undefined) {
              const expireTime = oldestTimestamp + state.windowMs;
              retryAfterMs = Math.max(0, expireTime - timestamp);
            }
          }

          // Only record timestamp if consuming (not just checking)
          if (msg.type === 'consume' && allowed) {
            for (let i = 0; i < cost; i++) {
              entry.timestamps.push(timestamp);
            }
          }

          // For check: remaining is without cost deduction
          // For consume: remaining is after consumption
          const effectiveRemaining = msg.type === 'consume' && allowed
            ? remaining - cost
            : remaining;

          const result: RateLimitResult = {
            allowed,
            current: currentCount,
            limit: state.maxRequests,
            remaining: allowed ? effectiveRemaining : 0,
            resetMs,
            retryAfterMs,
          };

          return [result, state];
        }

        case 'reset': {
          const deleted = state.entries.delete(msg.key);
          return [deleted, state];
        }

        case 'getStatus': {
          const entry = state.entries.get(msg.key);

          if (!entry) {
            const result: RateLimitResult = {
              allowed: true,
              current: 0,
              limit: state.maxRequests,
              remaining: state.maxRequests,
              resetMs: state.windowMs,
              retryAfterMs: 0,
            };
            return [result, state];
          }

          // Update window if needed
          updateWindow(entry, state.windowMs, timestamp);

          const currentCount = calculateSlidingWindowCount(entry, state.windowMs, timestamp);
          const remaining = Math.max(0, state.maxRequests - currentCount);

          // Calculate reset time (time until oldest request expires)
          let resetMs = state.windowMs;
          if (entry.timestamps.length > 0) {
            const oldestTimestamp = entry.timestamps[0];
            if (oldestTimestamp !== undefined) {
              const expireTime = oldestTimestamp + state.windowMs;
              resetMs = Math.max(0, expireTime - timestamp);
            }
          }

          const result: RateLimitResult = {
            allowed: remaining > 0,
            current: currentCount,
            limit: state.maxRequests,
            remaining,
            resetMs,
            retryAfterMs: 0,
          };

          return [result, state];
        }

        case 'getKeys': {
          return [Array.from(state.entries.keys()), state];
        }
      }
    },

    handleCast(msg: RateLimiterCastMsg, state: RateLimiterState): RateLimiterState {
      if (msg.type === 'cleanup') {
        const timestamp = now();

        // Remove entries that have been inactive for more than 2 windows
        const cutoff = timestamp - (state.windowMs * 2);

        for (const [key, entry] of state.entries) {
          // Check if all timestamps are older than cutoff
          const hasRecentActivity = entry.timestamps.some(t => t > cutoff);
          if (!hasRecentActivity) {
            state.entries.delete(key);
          }
        }
      }
      return state;
    },
  };
}

/**
 * RateLimiter provides sliding window rate limiting.
 *
 * Built on GenServer, it provides:
 * - Per-key rate limiting with sliding window algorithm
 * - Configurable limits (requests per window)
 * - Accurate remaining/reset time tracking
 * - Memory-efficient cleanup of stale entries
 */
export const RateLimiter = {
  /**
   * Starts a new RateLimiter instance.
   *
   * @param options - RateLimiter configuration
   * @returns Reference to the started RateLimiter
   */
  async start(options: RateLimiterOptions): Promise<RateLimiterRef> {
    const behavior = createRateLimiterBehavior(options);
    const startOptions = options.name !== undefined ? { name: options.name } : {};
    return GenServer.start(behavior, startOptions);
  },

  /**
   * Checks if a request would be allowed without consuming quota.
   *
   * @param ref - RateLimiter reference
   * @param key - Rate limit key (e.g., 'user:123', 'ip:192.168.1.1')
   * @param cost - Number of requests to check (default: 1)
   * @returns Rate limit result
   */
  async check(
    ref: RateLimiterRef,
    key: string,
    cost: number = 1,
  ): Promise<RateLimitResult> {
    return GenServer.call(ref, { type: 'check', key, cost }) as Promise<RateLimitResult>;
  },

  /**
   * Consumes quota for a request if allowed.
   *
   * @param ref - RateLimiter reference
   * @param key - Rate limit key
   * @param cost - Number of requests to consume (default: 1)
   * @returns Rate limit result
   * @throws {RateLimitExceededError} If rate limit is exceeded
   */
  async consume(
    ref: RateLimiterRef,
    key: string,
    cost: number = 1,
  ): Promise<RateLimitResult> {
    const result = await GenServer.call(ref, { type: 'consume', key, cost }) as RateLimitResult;

    if (!result.allowed) {
      throw new RateLimitExceededError(key, result.retryAfterMs);
    }

    return result;
  },

  /**
   * Gets the current status for a key without modifying state.
   *
   * @param ref - RateLimiter reference
   * @param key - Rate limit key
   * @returns Current rate limit status
   */
  async getStatus(ref: RateLimiterRef, key: string): Promise<RateLimitResult> {
    return GenServer.call(ref, { type: 'getStatus', key }) as Promise<RateLimitResult>;
  },

  /**
   * Resets rate limit state for a specific key.
   *
   * @param ref - RateLimiter reference
   * @param key - Rate limit key to reset
   * @returns true if the key existed
   */
  async reset(ref: RateLimiterRef, key: string): Promise<boolean> {
    return GenServer.call(ref, { type: 'reset', key }) as Promise<boolean>;
  },

  /**
   * Returns all tracked keys.
   *
   * @param ref - RateLimiter reference
   * @returns Array of tracked keys
   */
  async getKeys(ref: RateLimiterRef): Promise<readonly string[]> {
    return GenServer.call(ref, { type: 'getKeys' }) as Promise<readonly string[]>;
  },

  /**
   * Triggers cleanup of stale entries.
   * This is a fire-and-forget operation.
   *
   * @param ref - RateLimiter reference
   */
  cleanup(ref: RateLimiterRef): void {
    GenServer.cast(ref, { type: 'cleanup' });
  },

  /**
   * Checks if the RateLimiter is running.
   *
   * @param ref - RateLimiter reference
   * @returns true if running
   */
  isRunning(ref: RateLimiterRef): boolean {
    return GenServer.isRunning(ref);
  },

  /**
   * Gracefully stops the RateLimiter.
   *
   * @param ref - RateLimiter reference
   */
  async stop(ref: RateLimiterRef): Promise<void> {
    await GenServer.stop(ref);
  },
} as const;
