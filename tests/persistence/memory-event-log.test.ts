import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryEventLogAdapter } from '../../src/persistence/index.js';
import type { EventEntry } from '../../src/persistence/index.js';

function createEvent(overrides: Partial<EventEntry> = {}): EventEntry {
  return {
    seq: 0,
    timestamp: Date.now(),
    type: 'TestEvent',
    payload: { value: 1 },
    ...overrides,
  };
}

describe('MemoryEventLogAdapter', () => {
  let adapter: MemoryEventLogAdapter;

  beforeEach(() => {
    adapter = new MemoryEventLogAdapter();
  });

  describe('append', () => {
    it('assigns monotonically increasing sequence numbers', async () => {
      const events = [
        createEvent({ type: 'A', payload: { n: 1 } }),
        createEvent({ type: 'B', payload: { n: 2 } }),
        createEvent({ type: 'C', payload: { n: 3 } }),
      ];

      await adapter.append('stream-1', events);

      const stored = await adapter.read('stream-1');
      expect(stored).toHaveLength(3);
      expect(stored[0]!.seq).toBe(1);
      expect(stored[1]!.seq).toBe(2);
      expect(stored[2]!.seq).toBe(3);
    });

    it('continues sequence across multiple appends', async () => {
      await adapter.append('stream-1', [createEvent()]);
      await adapter.append('stream-1', [createEvent()]);
      await adapter.append('stream-1', [createEvent()]);

      const stored = await adapter.read('stream-1');
      expect(stored[0]!.seq).toBe(1);
      expect(stored[1]!.seq).toBe(2);
      expect(stored[2]!.seq).toBe(3);
    });

    it('returns last sequence number', async () => {
      const lastSeq = await adapter.append('stream-1', [
        createEvent(),
        createEvent(),
        createEvent(),
      ]);

      expect(lastSeq).toBe(3);
    });

    it('returns current last seq for empty append', async () => {
      await adapter.append('stream-1', [createEvent()]);
      const lastSeq = await adapter.append('stream-1', []);

      expect(lastSeq).toBe(1);
    });

    it('returns 0 for empty append on non-existent stream', async () => {
      const lastSeq = await adapter.append('stream-1', []);
      expect(lastSeq).toBe(0);
    });

    it('maintains independent sequences per stream', async () => {
      await adapter.append('stream-a', [createEvent(), createEvent()]);
      await adapter.append('stream-b', [createEvent()]);

      const a = await adapter.read('stream-a');
      const b = await adapter.read('stream-b');

      expect(a[0]!.seq).toBe(1);
      expect(a[1]!.seq).toBe(2);
      expect(b[0]!.seq).toBe(1);
    });

    it('ignores seq field from input events', async () => {
      const events = [
        createEvent({ seq: 999 }),
        createEvent({ seq: 42 }),
      ];

      await adapter.append('stream-1', events);

      const stored = await adapter.read('stream-1');
      expect(stored[0]!.seq).toBe(1);
      expect(stored[1]!.seq).toBe(2);
    });

    it('preserves timestamp, type, and payload', async () => {
      const ts = 1700000000000;
      const events = [
        createEvent({ timestamp: ts, type: 'OrderCreated', payload: { orderId: 'abc' } }),
      ];

      await adapter.append('orders', events);

      const stored = await adapter.read('orders');
      expect(stored[0]!.timestamp).toBe(ts);
      expect(stored[0]!.type).toBe('OrderCreated');
      expect(stored[0]!.payload).toEqual({ orderId: 'abc' });
    });

    it('preserves metadata when provided', async () => {
      const events = [
        createEvent({ metadata: { correlationId: 'xyz', userId: 'user-1' } }),
      ];

      await adapter.append('stream-1', events);

      const stored = await adapter.read('stream-1');
      expect(stored[0]!.metadata).toEqual({ correlationId: 'xyz', userId: 'user-1' });
    });

    it('does not include metadata key when not provided', async () => {
      const events = [createEvent()];
      delete (events[0] as Record<string, unknown>)['metadata'];

      await adapter.append('stream-1', events);

      const stored = await adapter.read('stream-1');
      expect('metadata' in stored[0]!).toBe(false);
    });

    it('deep clones payload to prevent external mutations', async () => {
      const payload = { nested: { value: 1 } };
      await adapter.append('stream-1', [createEvent({ payload })]);

      payload.nested.value = 999;

      const stored = await adapter.read('stream-1');
      expect((stored[0]!.payload as { nested: { value: number } }).nested.value).toBe(1);
    });

    it('deep clones metadata to prevent external mutations', async () => {
      const metadata = { traceId: 'original' };
      await adapter.append('stream-1', [createEvent({ metadata })]);

      metadata.traceId = 'mutated';

      const stored = await adapter.read('stream-1');
      expect(stored[0]!.metadata!['traceId']).toBe('original');
    });
  });

  describe('read', () => {
    it('returns empty array for non-existent stream', async () => {
      const events = await adapter.read('missing');
      expect(events).toEqual([]);
    });

    it('returns all events when no options specified', async () => {
      await adapter.append('stream-1', [
        createEvent({ type: 'A' }),
        createEvent({ type: 'B' }),
        createEvent({ type: 'C' }),
      ]);

      const events = await adapter.read('stream-1');
      expect(events).toHaveLength(3);
    });

    it('filters by fromSeq (inclusive)', async () => {
      await adapter.append('stream-1', [
        createEvent({ type: 'A' }),
        createEvent({ type: 'B' }),
        createEvent({ type: 'C' }),
      ]);

      const events = await adapter.read('stream-1', { fromSeq: 2 });
      expect(events).toHaveLength(2);
      expect(events[0]!.seq).toBe(2);
      expect(events[1]!.seq).toBe(3);
    });

    it('filters by toSeq (inclusive)', async () => {
      await adapter.append('stream-1', [
        createEvent({ type: 'A' }),
        createEvent({ type: 'B' }),
        createEvent({ type: 'C' }),
      ]);

      const events = await adapter.read('stream-1', { toSeq: 2 });
      expect(events).toHaveLength(2);
      expect(events[0]!.seq).toBe(1);
      expect(events[1]!.seq).toBe(2);
    });

    it('filters by fromSeq and toSeq combined', async () => {
      await adapter.append('stream-1', [
        createEvent({ type: 'A' }),
        createEvent({ type: 'B' }),
        createEvent({ type: 'C' }),
        createEvent({ type: 'D' }),
        createEvent({ type: 'E' }),
      ]);

      const events = await adapter.read('stream-1', { fromSeq: 2, toSeq: 4 });
      expect(events).toHaveLength(3);
      expect(events[0]!.seq).toBe(2);
      expect(events[2]!.seq).toBe(4);
    });

    it('filters by event types', async () => {
      await adapter.append('stream-1', [
        createEvent({ type: 'OrderCreated' }),
        createEvent({ type: 'PaymentReceived' }),
        createEvent({ type: 'OrderShipped' }),
        createEvent({ type: 'PaymentRefunded' }),
      ]);

      const events = await adapter.read('stream-1', { types: ['PaymentReceived', 'PaymentRefunded'] });
      expect(events).toHaveLength(2);
      expect(events[0]!.type).toBe('PaymentReceived');
      expect(events[1]!.type).toBe('PaymentRefunded');
    });

    it('applies limit', async () => {
      await adapter.append('stream-1', [
        createEvent({ type: 'A' }),
        createEvent({ type: 'B' }),
        createEvent({ type: 'C' }),
        createEvent({ type: 'D' }),
      ]);

      const events = await adapter.read('stream-1', { limit: 2 });
      expect(events).toHaveLength(2);
      expect(events[0]!.seq).toBe(1);
      expect(events[1]!.seq).toBe(2);
    });

    it('combines all filters: fromSeq, types, and limit', async () => {
      await adapter.append('stream-1', [
        createEvent({ type: 'A' }),
        createEvent({ type: 'B' }),
        createEvent({ type: 'A' }),
        createEvent({ type: 'B' }),
        createEvent({ type: 'A' }),
      ]);

      const events = await adapter.read('stream-1', {
        fromSeq: 2,
        types: ['A'],
        limit: 1,
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.seq).toBe(3);
      expect(events[0]!.type).toBe('A');
    });

    it('returns empty when types filter matches nothing', async () => {
      await adapter.append('stream-1', [createEvent({ type: 'A' })]);

      const events = await adapter.read('stream-1', { types: ['NonExistent'] });
      expect(events).toEqual([]);
    });

    it('deep clones events on read to prevent mutations', async () => {
      await adapter.append('stream-1', [createEvent({ payload: { value: 42 } })]);

      const first = await adapter.read('stream-1');
      (first[0]!.payload as { value: number }).value = 999;

      const second = await adapter.read('stream-1');
      expect((second[0]!.payload as { value: number }).value).toBe(42);
    });
  });

  describe('readAfter', () => {
    it('returns events after given sequence number', async () => {
      await adapter.append('stream-1', [
        createEvent({ type: 'A' }),
        createEvent({ type: 'B' }),
        createEvent({ type: 'C' }),
      ]);

      const events = await adapter.readAfter('stream-1', 1);
      expect(events).toHaveLength(2);
      expect(events[0]!.seq).toBe(2);
      expect(events[1]!.seq).toBe(3);
    });

    it('returns all events when afterSeq is 0', async () => {
      await adapter.append('stream-1', [
        createEvent({ type: 'A' }),
        createEvent({ type: 'B' }),
      ]);

      const events = await adapter.readAfter('stream-1', 0);
      expect(events).toHaveLength(2);
    });

    it('returns empty when afterSeq >= last seq', async () => {
      await adapter.append('stream-1', [createEvent()]);

      const events = await adapter.readAfter('stream-1', 5);
      expect(events).toEqual([]);
    });

    it('returns empty for non-existent stream', async () => {
      const events = await adapter.readAfter('missing', 0);
      expect(events).toEqual([]);
    });
  });

  describe('getLastSeq', () => {
    it('returns 0 for non-existent stream', async () => {
      expect(await adapter.getLastSeq('missing')).toBe(0);
    });

    it('returns last sequence number after appends', async () => {
      await adapter.append('stream-1', [createEvent(), createEvent()]);
      expect(await adapter.getLastSeq('stream-1')).toBe(2);

      await adapter.append('stream-1', [createEvent()]);
      expect(await adapter.getLastSeq('stream-1')).toBe(3);
    });

    it('maintains correct seq after truncation', async () => {
      await adapter.append('stream-1', [createEvent(), createEvent(), createEvent()]);
      await adapter.truncateBefore('stream-1', 3);

      // seq counter should not be affected by truncation
      expect(await adapter.getLastSeq('stream-1')).toBe(3);
    });
  });

  describe('truncateBefore', () => {
    it('removes events with seq < beforeSeq', async () => {
      await adapter.append('stream-1', [
        createEvent({ type: 'A' }),
        createEvent({ type: 'B' }),
        createEvent({ type: 'C' }),
        createEvent({ type: 'D' }),
      ]);

      const removed = await adapter.truncateBefore('stream-1', 3);

      expect(removed).toBe(2);
      const remaining = await adapter.read('stream-1');
      expect(remaining).toHaveLength(2);
      expect(remaining[0]!.seq).toBe(3);
      expect(remaining[1]!.seq).toBe(4);
    });

    it('returns 0 for non-existent stream', async () => {
      const removed = await adapter.truncateBefore('missing', 5);
      expect(removed).toBe(0);
    });

    it('removes nothing when beforeSeq <= first seq', async () => {
      await adapter.append('stream-1', [createEvent(), createEvent()]);

      const removed = await adapter.truncateBefore('stream-1', 1);
      expect(removed).toBe(0);

      const events = await adapter.read('stream-1');
      expect(events).toHaveLength(2);
    });

    it('removes all events when beforeSeq > last seq', async () => {
      await adapter.append('stream-1', [createEvent(), createEvent()]);

      const removed = await adapter.truncateBefore('stream-1', 100);
      expect(removed).toBe(2);

      const events = await adapter.read('stream-1');
      expect(events).toEqual([]);
    });

    it('does not reset sequence counter', async () => {
      await adapter.append('stream-1', [createEvent(), createEvent(), createEvent()]);
      await adapter.truncateBefore('stream-1', 3);

      // New appends should continue from last seq
      await adapter.append('stream-1', [createEvent()]);
      const events = await adapter.read('stream-1');
      expect(events[events.length - 1]!.seq).toBe(4);
    });
  });

  describe('listStreams', () => {
    it('returns empty array when no streams exist', async () => {
      const streams = await adapter.listStreams();
      expect(streams).toEqual([]);
    });

    it('returns all stream IDs', async () => {
      await adapter.append('orders', [createEvent()]);
      await adapter.append('payments', [createEvent()]);
      await adapter.append('users', [createEvent()]);

      const streams = await adapter.listStreams();
      expect(streams).toHaveLength(3);
      expect(streams).toContain('orders');
      expect(streams).toContain('payments');
      expect(streams).toContain('users');
    });

    it('filters by prefix', async () => {
      await adapter.append('order:123', [createEvent()]);
      await adapter.append('order:456', [createEvent()]);
      await adapter.append('payment:789', [createEvent()]);

      const streams = await adapter.listStreams('order:');
      expect(streams).toHaveLength(2);
      expect(streams).toContain('order:123');
      expect(streams).toContain('order:456');
    });

    it('returns empty when no streams match prefix', async () => {
      await adapter.append('stream-1', [createEvent()]);

      const streams = await adapter.listStreams('missing:');
      expect(streams).toEqual([]);
    });
  });

  describe('close', () => {
    it('is a no-op and does not clear data', async () => {
      await adapter.append('stream-1', [createEvent()]);

      await adapter.close();

      const events = await adapter.read('stream-1');
      expect(events).toHaveLength(1);
    });
  });

  describe('streamCount', () => {
    it('returns 0 for empty adapter', () => {
      expect(adapter.streamCount).toBe(0);
    });

    it('reflects number of active streams', async () => {
      await adapter.append('a', [createEvent()]);
      expect(adapter.streamCount).toBe(1);

      await adapter.append('b', [createEvent()]);
      expect(adapter.streamCount).toBe(2);
    });
  });

  describe('clear', () => {
    it('removes all streams and resets counters', async () => {
      await adapter.append('stream-1', [createEvent(), createEvent()]);
      await adapter.append('stream-2', [createEvent()]);

      adapter.clear();

      expect(adapter.streamCount).toBe(0);
      expect(await adapter.getLastSeq('stream-1')).toBe(0);
      expect(await adapter.getLastSeq('stream-2')).toBe(0);
      expect(await adapter.listStreams()).toEqual([]);
    });

    it('resets sequence counters so new appends start from 1', async () => {
      await adapter.append('stream-1', [createEvent(), createEvent()]);
      adapter.clear();

      await adapter.append('stream-1', [createEvent()]);
      const events = await adapter.read('stream-1');
      expect(events[0]!.seq).toBe(1);
    });
  });

  describe('ordering guarantees', () => {
    it('maintains insertion order within a stream', async () => {
      const timestamps = [100, 200, 300, 400, 500];
      const events = timestamps.map((ts) => createEvent({ timestamp: ts, type: `T${ts}` }));

      await adapter.append('stream-1', events);

      const stored = await adapter.read('stream-1');
      for (let i = 0; i < stored.length; i++) {
        expect(stored[i]!.seq).toBe(i + 1);
        expect(stored[i]!.timestamp).toBe(timestamps[i]);
      }
    });

    it('seq is always strictly increasing even with concurrent-like appends', async () => {
      // Simulate interleaved appends to same stream
      await adapter.append('stream-1', [createEvent()]);
      await adapter.append('stream-1', [createEvent(), createEvent()]);
      await adapter.append('stream-1', [createEvent()]);

      const events = await adapter.read('stream-1');
      for (let i = 1; i < events.length; i++) {
        expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
      }
    });
  });

  describe('stream isolation', () => {
    it('operations on one stream do not affect another', async () => {
      await adapter.append('stream-a', [
        createEvent({ type: 'A1' }),
        createEvent({ type: 'A2' }),
      ]);
      await adapter.append('stream-b', [
        createEvent({ type: 'B1' }),
      ]);

      await adapter.truncateBefore('stream-a', 2);

      const a = await adapter.read('stream-a');
      const b = await adapter.read('stream-b');

      expect(a).toHaveLength(1);
      expect(a[0]!.type).toBe('A2');
      expect(b).toHaveLength(1);
      expect(b[0]!.type).toBe('B1');
    });
  });
});
