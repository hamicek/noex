import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { SQLiteEventLogAdapter } from '../../src/persistence/index.js';
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

describe('SQLiteEventLogAdapter', () => {
  let testDbPath: string;
  let adapter: SQLiteEventLogAdapter;

  beforeEach(() => {
    testDbPath = join(tmpdir(), `noex-event-log-test-${randomUUID()}.db`);
    adapter = new SQLiteEventLogAdapter({ filename: testDbPath });
  });

  afterEach(async () => {
    try {
      await adapter.close();
    } catch {
      // Ignore close errors
    }
    try {
      await rm(testDbPath, { force: true });
      await rm(`${testDbPath}-wal`, { force: true });
      await rm(`${testDbPath}-shm`, { force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('creates database and table on first operation', async () => {
      await adapter.append('stream-1', [createEvent()]);
      const events = await adapter.read('stream-1');
      expect(events).toHaveLength(1);
    });

    it('uses default table name when not specified', () => {
      expect(adapter.getTableName()).toBe('event_log');
    });

    it('accepts custom table name', () => {
      const custom = new SQLiteEventLogAdapter({
        filename: ':memory:',
        tableName: 'custom_events',
      });
      expect(custom.getTableName()).toBe('custom_events');
    });

    it('returns configured filename', () => {
      expect(adapter.getFilename()).toBe(testDbPath);
    });
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

    it('handles complex nested payload', async () => {
      const payload = {
        items: [
          { id: 1, tags: ['a', 'b'] },
          { id: 2, tags: ['c'] },
        ],
        nested: { deep: { value: 42 } },
      };

      await adapter.append('stream-1', [createEvent({ payload })]);

      const stored = await adapter.read('stream-1');
      expect(stored[0]!.payload).toEqual(payload);
    });

    it('handles null values in payload', async () => {
      const payload = { name: null, count: 0, active: false };

      await adapter.append('stream-1', [createEvent({ payload })]);

      const stored = await adapter.read('stream-1');
      expect(stored[0]!.payload).toEqual(payload);
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

    it('returns events in sequence order', async () => {
      await adapter.append('stream-1', [
        createEvent({ type: 'First' }),
        createEvent({ type: 'Second' }),
        createEvent({ type: 'Third' }),
      ]);

      const events = await adapter.read('stream-1');
      expect(events[0]!.type).toBe('First');
      expect(events[1]!.type).toBe('Second');
      expect(events[2]!.type).toBe('Third');
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

      // getLastSeq should still reflect the highest seq ever assigned
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

    it('escapes special SQL LIKE characters in prefix', async () => {
      await adapter.append('test%key', [createEvent()]);
      await adapter.append('test_key', [createEvent()]);
      await adapter.append('testXkey', [createEvent()]);

      const percentStreams = await adapter.listStreams('test%');
      expect(percentStreams).toHaveLength(1);
      expect(percentStreams).toContain('test%key');

      const underscoreStreams = await adapter.listStreams('test_');
      expect(underscoreStreams).toHaveLength(1);
      expect(underscoreStreams).toContain('test_key');
    });

    it('returns unique stream IDs even with multiple events', async () => {
      await adapter.append('stream-1', [createEvent(), createEvent(), createEvent()]);

      const streams = await adapter.listStreams();
      expect(streams).toHaveLength(1);
      expect(streams[0]).toBe('stream-1');
    });
  });

  describe('close', () => {
    it('closes database connection', async () => {
      await adapter.append('stream-1', [createEvent()]);
      await adapter.close();

      // After close, a new adapter should be able to read persisted data
      const newAdapter = new SQLiteEventLogAdapter({ filename: testDbPath });
      const events = await newAdapter.read('stream-1');
      expect(events).toHaveLength(1);
      await newAdapter.close();
    });

    it('can be called multiple times safely', async () => {
      await adapter.append('stream-1', [createEvent()]);

      await adapter.close();
      await adapter.close();
      await adapter.close();
    });
  });

  describe('persistence', () => {
    it('persists events across adapter instances', async () => {
      await adapter.append('stream-1', [
        createEvent({ type: 'A', payload: { n: 1 } }),
        createEvent({ type: 'B', payload: { n: 2 } }),
      ]);
      await adapter.close();

      const newAdapter = new SQLiteEventLogAdapter({ filename: testDbPath });
      const events = await newAdapter.read('stream-1');

      expect(events).toHaveLength(2);
      expect(events[0]!.type).toBe('A');
      expect(events[1]!.type).toBe('B');
      await newAdapter.close();
    });

    it('continues sequence numbering across adapter instances', async () => {
      await adapter.append('stream-1', [createEvent(), createEvent()]);
      await adapter.close();

      const newAdapter = new SQLiteEventLogAdapter({ filename: testDbPath });
      const lastSeq = await newAdapter.append('stream-1', [createEvent()]);

      expect(lastSeq).toBe(3);
      const events = await newAdapter.read('stream-1');
      expect(events[2]!.seq).toBe(3);
      await newAdapter.close();
    });
  });

  describe('WAL mode', () => {
    it('enables WAL mode by default', async () => {
      await adapter.append('stream-1', [createEvent()]);
      const events = await adapter.read('stream-1');
      expect(events).toHaveLength(1);
    });

    it('can disable WAL mode', async () => {
      const noWalPath = join(tmpdir(), `noex-event-log-nowal-${randomUUID()}.db`);
      const noWalAdapter = new SQLiteEventLogAdapter({
        filename: noWalPath,
        walMode: false,
      });

      await noWalAdapter.append('stream-1', [createEvent({ type: 'A' })]);
      const events = await noWalAdapter.read('stream-1');

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('A');
      await noWalAdapter.close();
      await rm(noWalPath, { force: true });
    });
  });

  describe('in-memory mode', () => {
    it('works with :memory: database', async () => {
      const memAdapter = new SQLiteEventLogAdapter({ filename: ':memory:' });

      await memAdapter.append('stream-1', [createEvent({ payload: { value: 42 } })]);
      const events = await memAdapter.read('stream-1');

      expect(events).toHaveLength(1);
      expect((events[0]!.payload as { value: number }).value).toBe(42);
      await memAdapter.close();
    });

    it('loses data after close with :memory:', async () => {
      const memAdapter1 = new SQLiteEventLogAdapter({ filename: ':memory:' });
      await memAdapter1.append('stream-1', [createEvent()]);
      await memAdapter1.close();

      const memAdapter2 = new SQLiteEventLogAdapter({ filename: ':memory:' });
      const events = await memAdapter2.read('stream-1');

      expect(events).toEqual([]);
      await memAdapter2.close();
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

    it('seq is always strictly increasing across appends', async () => {
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

    it('getLastSeq is independent per stream', async () => {
      await adapter.append('stream-a', [createEvent(), createEvent(), createEvent()]);
      await adapter.append('stream-b', [createEvent()]);

      expect(await adapter.getLastSeq('stream-a')).toBe(3);
      expect(await adapter.getLastSeq('stream-b')).toBe(1);
    });
  });

  describe('large volumes', () => {
    it('handles appending many events efficiently', async () => {
      const events = Array.from({ length: 1000 }, (_, i) =>
        createEvent({ type: `Event${i}`, payload: { index: i }, timestamp: 1000 + i })
      );

      await adapter.append('stream-1', events);

      const lastSeq = await adapter.getLastSeq('stream-1');
      expect(lastSeq).toBe(1000);

      const first10 = await adapter.read('stream-1', { limit: 10 });
      expect(first10).toHaveLength(10);
      expect(first10[0]!.seq).toBe(1);

      const last10 = await adapter.read('stream-1', { fromSeq: 991 });
      expect(last10).toHaveLength(10);
      expect(last10[9]!.seq).toBe(1000);
    });

    it('handles many streams', async () => {
      for (let i = 0; i < 100; i++) {
        await adapter.append(`stream-${i}`, [createEvent()]);
      }

      const streams = await adapter.listStreams();
      expect(streams).toHaveLength(100);
    });
  });

  describe('custom table name', () => {
    it('uses custom table name without conflicts', async () => {
      const customPath = join(tmpdir(), `noex-event-log-custom-${randomUUID()}.db`);

      const adapter1 = new SQLiteEventLogAdapter({
        filename: customPath,
        tableName: 'events_v1',
      });
      const adapter2 = new SQLiteEventLogAdapter({
        filename: customPath,
        tableName: 'events_v2',
      });

      await adapter1.append('stream-1', [createEvent({ type: 'FromV1' })]);
      await adapter2.append('stream-1', [createEvent({ type: 'FromV2' })]);

      const v1Events = await adapter1.read('stream-1');
      const v2Events = await adapter2.read('stream-1');

      expect(v1Events).toHaveLength(1);
      expect(v1Events[0]!.type).toBe('FromV1');
      expect(v2Events).toHaveLength(1);
      expect(v2Events[0]!.type).toBe('FromV2');

      await adapter1.close();
      await adapter2.close();
      await rm(customPath, { force: true });
      await rm(`${customPath}-wal`, { force: true });
      await rm(`${customPath}-shm`, { force: true });
    });
  });
});
