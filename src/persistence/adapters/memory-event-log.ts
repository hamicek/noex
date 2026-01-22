/**
 * In-memory event log adapter for testing and development.
 *
 * This adapter stores events in memory and does not persist across process restarts.
 * Useful for unit testing, development, and scenarios where durable event storage is not needed.
 */

import type { EventEntry, EventLogAdapter, ReadOptions } from '../types.js';
import { StorageError } from '../errors.js';

/**
 * In-memory implementation of EventLogAdapter.
 *
 * Provides a simple, fast event log backend that keeps all events in memory.
 * Each stream maintains an independent, monotonically increasing sequence counter.
 *
 * @example
 * ```typescript
 * const log = new MemoryEventLogAdapter();
 *
 * await log.append('orders', [
 *   { seq: 0, timestamp: Date.now(), type: 'OrderCreated', payload: { id: '123' } }
 * ]);
 *
 * const events = await log.read('orders');
 * console.log(events[0].type); // 'OrderCreated'
 * ```
 */
export class MemoryEventLogAdapter implements EventLogAdapter {
  private readonly streams: Map<string, EventEntry[]> = new Map();
  private readonly seqCounters: Map<string, number> = new Map();

  async append(streamId: string, events: readonly EventEntry[]): Promise<number> {
    if (events.length === 0) {
      return this.getLastSeq(streamId);
    }

    try {
      let seq = this.seqCounters.get(streamId) ?? 0;
      const stream = this.getOrCreateStream(streamId);

      for (const event of events) {
        seq++;
        const entry: EventEntry = {
          seq,
          timestamp: event.timestamp,
          type: event.type,
          payload: structuredClone(event.payload),
          ...(event.metadata !== undefined && { metadata: structuredClone(event.metadata) }),
        };
        stream.push(entry);
      }

      this.seqCounters.set(streamId, seq);
      return seq;
    } catch (error) {
      throw new StorageError(
        'save',
        `Failed to append events to stream: ${streamId}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async read(streamId: string, options?: ReadOptions): Promise<readonly EventEntry[]> {
    try {
      const stream = this.streams.get(streamId);
      if (stream === undefined) {
        return [];
      }

      let result: EventEntry[] = stream;

      if (options?.fromSeq !== undefined) {
        result = result.filter((e) => e.seq >= options.fromSeq!);
      }
      if (options?.toSeq !== undefined) {
        result = result.filter((e) => e.seq <= options.toSeq!);
      }
      if (options?.types !== undefined && options.types.length > 0) {
        const typeSet = new Set(options.types);
        result = result.filter((e) => typeSet.has(e.type));
      }
      if (options?.limit !== undefined && options.limit > 0) {
        result = result.slice(0, options.limit);
      }

      return result.map((e) => structuredClone(e));
    } catch (error) {
      throw new StorageError(
        'load',
        `Failed to read events from stream: ${streamId}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async readAfter(streamId: string, afterSeq: number): Promise<readonly EventEntry[]> {
    return this.read(streamId, { fromSeq: afterSeq + 1 });
  }

  async getLastSeq(streamId: string): Promise<number> {
    return this.seqCounters.get(streamId) ?? 0;
  }

  async truncateBefore(streamId: string, beforeSeq: number): Promise<number> {
    const stream = this.streams.get(streamId);
    if (stream === undefined) {
      return 0;
    }

    const originalLength = stream.length;
    const remaining = stream.filter((e) => e.seq >= beforeSeq);
    this.streams.set(streamId, remaining);

    return originalLength - remaining.length;
  }

  async listStreams(prefix?: string): Promise<readonly string[]> {
    const streams = Array.from(this.streams.keys());
    if (prefix === undefined) {
      return streams;
    }
    return streams.filter((id) => id.startsWith(prefix));
  }

  async close(): Promise<void> {
    // No-op for in-memory storage
  }

  /**
   * Returns the number of active streams.
   * Useful for testing and debugging.
   */
  get streamCount(): number {
    return this.streams.size;
  }

  /**
   * Clears all streams and resets sequence counters.
   * Useful for resetting state between tests.
   */
  clear(): void {
    this.streams.clear();
    this.seqCounters.clear();
  }

  private getOrCreateStream(streamId: string): EventEntry[] {
    let stream = this.streams.get(streamId);
    if (stream === undefined) {
      stream = [];
      this.streams.set(streamId, stream);
    }
    return stream;
  }
}
