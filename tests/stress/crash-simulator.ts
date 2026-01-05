/**
 * Crash simulation utilities for stress testing.
 *
 * Provides controlled ways to crash GenServers for testing
 * supervisor restart behavior under various failure scenarios.
 */

import {
  Supervisor,
  GenServer,
  type SupervisorRef,
  type GenServerRef,
} from '../../src/index.js';
import { delay } from './test-helpers.js';

/**
 * Crash reason for tracking and debugging.
 */
export interface CrashEvent {
  /** ID of the crashed child. */
  readonly childId: string;
  /** GenServerRef ID before crash. */
  readonly refId: string;
  /** Timestamp of the crash. */
  readonly timestamp: number;
  /** Error used to simulate the crash. */
  readonly error: Error;
}

/**
 * Result of a crash operation.
 */
export interface CrashResult {
  /** Whether the crash was successfully initiated. */
  readonly success: boolean;
  /** Child ID that was crashed. */
  readonly childId: string;
  /** GenServerRef ID before crash. */
  readonly refId: string;
  /** Timestamp of the crash. */
  readonly timestamp: number;
  /** Error if crash failed. */
  readonly error?: Error;
}

/**
 * Crashes a single child by force-terminating it.
 *
 * @param ref - GenServer reference to crash
 * @param reason - Optional error message for the crash
 * @returns CrashEvent with details about the crash
 *
 * @example
 * ```typescript
 * const child = Supervisor.getChild(ref, 'child_0');
 * crashChild(child.ref, 'Simulated failure');
 * ```
 */
export function crashChild(
  ref: GenServerRef,
  reason: string = 'Simulated crash',
): CrashEvent {
  const error = new Error(reason);
  const timestamp = Date.now();
  const refId = ref.id;

  GenServer._forceTerminate(ref, { error });

  return {
    childId: extractChildIdFromRef(refId),
    refId,
    timestamp,
    error,
  };
}

/**
 * Crashes a child by its ID within a supervisor.
 *
 * @param supervisorRef - Supervisor containing the child
 * @param childId - ID of the child to crash
 * @param reason - Optional error message
 * @returns CrashResult with success status
 */
export function crashChildById(
  supervisorRef: SupervisorRef,
  childId: string,
  reason: string = 'Simulated crash',
): CrashResult {
  const timestamp = Date.now();
  const child = Supervisor.getChild(supervisorRef, childId);

  if (!child) {
    return {
      success: false,
      childId,
      refId: '',
      timestamp,
      error: new Error(`Child '${childId}' not found`),
    };
  }

  const refId = child.ref.id;
  const error = new Error(reason);

  GenServer._forceTerminate(child.ref, { error });

  return {
    success: true,
    childId,
    refId,
    timestamp,
  };
}

/**
 * Crashes multiple children simultaneously.
 *
 * @param refs - Array of GenServer references to crash
 * @param reason - Optional error message
 * @returns Array of CrashEvents
 *
 * @example
 * ```typescript
 * const crashes = crashMultiple([child1.ref, child2.ref, child3.ref]);
 * ```
 */
export function crashMultiple(
  refs: readonly GenServerRef[],
  reason: string = 'Simultaneous crash',
): readonly CrashEvent[] {
  const timestamp = Date.now();
  const events: CrashEvent[] = [];

  for (const ref of refs) {
    const error = new Error(reason);
    const refId = ref.id;

    GenServer._forceTerminate(ref, { error });

    events.push({
      childId: extractChildIdFromRef(refId),
      refId,
      timestamp,
      error,
    });
  }

  return events;
}

/**
 * Crashes multiple children by their IDs within a supervisor.
 *
 * @param supervisorRef - Supervisor containing the children
 * @param childIds - Array of child IDs to crash
 * @param reason - Optional error message
 * @returns Array of CrashResults
 */
export function crashMultipleByIds(
  supervisorRef: SupervisorRef,
  childIds: readonly string[],
  reason: string = 'Simultaneous crash',
): readonly CrashResult[] {
  const results: CrashResult[] = [];

  for (const childId of childIds) {
    results.push(crashChildById(supervisorRef, childId, reason));
  }

  return results;
}

/**
 * Options for random crash simulation.
 */
export interface RandomCrashOptions {
  /** Number of children to crash. */
  readonly count: number;
  /** Optional reason message. */
  readonly reason?: string;
}

/**
 * Crashes a random selection of children.
 *
 * @param supervisorRef - Supervisor containing the children
 * @param options - Random crash options
 * @returns Array of CrashResults
 *
 * @example
 * ```typescript
 * const results = crashRandom(ref, { count: 3 });
 * ```
 */
export function crashRandom(
  supervisorRef: SupervisorRef,
  options: RandomCrashOptions,
): readonly CrashResult[] {
  const { count, reason = 'Random crash' } = options;
  const children = Supervisor.getChildren(supervisorRef);

  if (children.length === 0) {
    return [];
  }

  // Fisher-Yates shuffle for unbiased selection
  const indices = Array.from({ length: children.length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j]!, indices[i]!];
  }

  const selectedCount = Math.min(count, children.length);
  const selectedIds = indices
    .slice(0, selectedCount)
    .map(i => children[i]!.id);

  return crashMultipleByIds(supervisorRef, selectedIds, reason);
}

/**
 * Schedule configuration for timed crashes.
 */
export interface CrashSchedule {
  /** Child ID to crash. */
  readonly childId: string;
  /** Delay in milliseconds from schedule start. */
  readonly delayMs: number;
  /** Optional reason message. */
  readonly reason?: string;
}

/**
 * Result of scheduled crash operation.
 */
export interface ScheduledCrashResult {
  /** All planned crashes. */
  readonly scheduled: readonly CrashSchedule[];
  /** Results of executed crashes. */
  readonly results: readonly CrashResult[];
  /** Total duration of the schedule in milliseconds. */
  readonly durationMs: number;
  /** Function to cancel remaining scheduled crashes. */
  readonly cancel: () => void;
}

/**
 * Schedules crashes to occur at specific times.
 * Crashes are executed asynchronously according to their delays.
 *
 * @param supervisorRef - Supervisor containing the children
 * @param schedule - Array of crash schedules
 * @returns Promise resolving to ScheduledCrashResult when all crashes complete
 *
 * @example
 * ```typescript
 * const result = await scheduleCrashes(ref, [
 *   { childId: 'child_0', delayMs: 100 },
 *   { childId: 'child_1', delayMs: 200 },
 *   { childId: 'child_2', delayMs: 300 },
 * ]);
 * ```
 */
export async function scheduleCrashes(
  supervisorRef: SupervisorRef,
  schedule: readonly CrashSchedule[],
): Promise<ScheduledCrashResult> {
  const startTime = Date.now();
  const results: CrashResult[] = [];
  let cancelled = false;

  const cancel = () => {
    cancelled = true;
  };

  // Sort by delay to ensure correct order
  const sortedSchedule = [...schedule].sort((a, b) => a.delayMs - b.delayMs);

  for (const item of sortedSchedule) {
    if (cancelled) break;

    const elapsed = Date.now() - startTime;
    const waitTime = item.delayMs - elapsed;

    if (waitTime > 0) {
      await delay(waitTime);
    }

    if (cancelled) break;

    const result = crashChildById(
      supervisorRef,
      item.childId,
      item.reason ?? `Scheduled crash at ${item.delayMs}ms`,
    );
    results.push(result);
  }

  return {
    scheduled: schedule,
    results,
    durationMs: Date.now() - startTime,
    cancel,
  };
}

/**
 * Configuration for burst crash simulation.
 */
export interface BurstCrashOptions {
  /** Number of children to crash in each burst. */
  readonly countPerBurst: number;
  /** Number of bursts to execute. */
  readonly burstCount: number;
  /** Delay between bursts in milliseconds. */
  readonly intervalMs: number;
  /** Optional reason message. */
  readonly reason?: string;
}

/**
 * Result of burst crash operation.
 */
export interface BurstCrashResult {
  /** Results grouped by burst index. */
  readonly bursts: readonly (readonly CrashResult[])[];
  /** Total crashes executed. */
  readonly totalCrashes: number;
  /** Total duration in milliseconds. */
  readonly durationMs: number;
}

/**
 * Executes crash bursts at regular intervals.
 * Useful for testing supervisor behavior under periodic stress.
 *
 * @param supervisorRef - Supervisor containing the children
 * @param options - Burst crash configuration
 * @returns Promise resolving to BurstCrashResult
 *
 * @example
 * ```typescript
 * const result = await crashBurst(ref, {
 *   countPerBurst: 2,
 *   burstCount: 5,
 *   intervalMs: 100,
 * });
 * ```
 */
export async function crashBurst(
  supervisorRef: SupervisorRef,
  options: BurstCrashOptions,
): Promise<BurstCrashResult> {
  const {
    countPerBurst,
    burstCount,
    intervalMs,
    reason = 'Burst crash',
  } = options;

  const startTime = Date.now();
  const bursts: CrashResult[][] = [];

  for (let i = 0; i < burstCount; i++) {
    if (i > 0) {
      await delay(intervalMs);
    }

    const burstReason = `${reason} (burst ${i + 1}/${burstCount})`;
    const results = crashRandom(supervisorRef, {
      count: countPerBurst,
      reason: burstReason,
    });

    bursts.push([...results]);
  }

  const totalCrashes = bursts.reduce((sum, burst) => sum + burst.length, 0);

  return {
    bursts,
    totalCrashes,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Configuration for continuous random crashes.
 */
export interface ContinuousCrashOptions {
  /** Duration of crash simulation in milliseconds. */
  readonly durationMs: number;
  /** Average interval between crashes in milliseconds. */
  readonly avgIntervalMs: number;
  /** Variance in interval (0-1, where 0 = fixed interval). */
  readonly variance?: number;
  /** Maximum concurrent crashes. */
  readonly maxConcurrent?: number;
  /** Optional reason message. */
  readonly reason?: string;
}

/**
 * Result of continuous crash operation.
 */
export interface ContinuousCrashResult {
  /** All crash results. */
  readonly results: readonly CrashResult[];
  /** Actual duration in milliseconds. */
  readonly actualDurationMs: number;
  /** Number of successful crashes. */
  readonly successfulCrashes: number;
  /** Number of failed crashes (child not found). */
  readonly failedCrashes: number;
  /** Average interval between crashes in milliseconds. */
  readonly avgIntervalMs: number;
}

/**
 * Executes random crashes continuously over a duration.
 * Useful for chaos testing and long-running stability tests.
 *
 * @param supervisorRef - Supervisor containing the children
 * @param options - Continuous crash configuration
 * @returns Promise resolving to ContinuousCrashResult
 *
 * @example
 * ```typescript
 * const result = await crashContinuous(ref, {
 *   durationMs: 10000,
 *   avgIntervalMs: 500,
 *   variance: 0.5,
 * });
 * ```
 */
export async function crashContinuous(
  supervisorRef: SupervisorRef,
  options: ContinuousCrashOptions,
): Promise<ContinuousCrashResult> {
  const {
    durationMs,
    avgIntervalMs,
    variance = 0.3,
    maxConcurrent = 1,
    reason = 'Continuous crash',
  } = options;

  const startTime = Date.now();
  const endTime = startTime + durationMs;
  const results: CrashResult[] = [];
  const intervals: number[] = [];
  let lastCrashTime = startTime;

  while (Date.now() < endTime) {
    // Calculate next interval with variance
    const varianceFactor = 1 + (Math.random() - 0.5) * 2 * variance;
    const nextInterval = Math.max(10, avgIntervalMs * varianceFactor);

    await delay(nextInterval);

    if (Date.now() >= endTime) break;

    const crashResults = crashRandom(supervisorRef, {
      count: maxConcurrent,
      reason,
    });

    const now = Date.now();
    intervals.push(now - lastCrashTime);
    lastCrashTime = now;

    results.push(...crashResults);
  }

  const successfulCrashes = results.filter(r => r.success).length;
  const failedCrashes = results.filter(r => !r.success).length;
  const avgInterval = intervals.length > 0
    ? intervals.reduce((a, b) => a + b, 0) / intervals.length
    : 0;

  return {
    results,
    actualDurationMs: Date.now() - startTime,
    successfulCrashes,
    failedCrashes,
    avgIntervalMs: avgInterval,
  };
}

/**
 * Crashes all children of a supervisor.
 *
 * @param supervisorRef - Supervisor containing the children
 * @param reason - Optional error message
 * @returns Array of CrashResults
 */
export function crashAll(
  supervisorRef: SupervisorRef,
  reason: string = 'Crash all',
): readonly CrashResult[] {
  const children = Supervisor.getChildren(supervisorRef);
  const childIds = children.map(c => c.id);
  return crashMultipleByIds(supervisorRef, childIds, reason);
}

/**
 * Crashes children in a specific order with delays.
 * Useful for testing cascade effects.
 *
 * @param supervisorRef - Supervisor containing the children
 * @param childIds - Ordered list of child IDs to crash
 * @param delayBetweenMs - Delay between each crash
 * @param reason - Optional error message
 * @returns Promise resolving to array of CrashResults
 */
export async function crashSequential(
  supervisorRef: SupervisorRef,
  childIds: readonly string[],
  delayBetweenMs: number = 0,
  reason: string = 'Sequential crash',
): Promise<readonly CrashResult[]> {
  const results: CrashResult[] = [];

  for (let i = 0; i < childIds.length; i++) {
    if (i > 0 && delayBetweenMs > 0) {
      await delay(delayBetweenMs);
    }

    const result = crashChildById(
      supervisorRef,
      childIds[i]!,
      `${reason} (${i + 1}/${childIds.length})`,
    );
    results.push(result);
  }

  return results;
}

/**
 * Extracts a child ID hint from a GenServerRef ID.
 * Used for logging and debugging purposes.
 */
function extractChildIdFromRef(refId: string): string {
  // GenServer IDs are like "genserver_1_abc123"
  // We can't reliably extract child ID, so return the ref ID
  return refId;
}
