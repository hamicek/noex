import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  EtsTable,
  EtsKeyNotFoundError,
  EtsCounterTypeError,
  _resetEtsInstanceCounter,
} from '../../src/core/ets-table.js';

describe('EtsTable', () => {
  let table: EtsTable<string, unknown>;

  beforeEach(() => {
    _resetEtsInstanceCounter();
  });

  afterEach(async () => {
    if (table) {
      await table.close();
    }
  });

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  describe('lifecycle', () => {
    it('should create a table with default options', () => {
      table = new EtsTable();
      expect(table.name).toBe('ets-1');
      expect(table.type).toBe('set');
    });

    it('should create a table with custom name and type', () => {
      table = new EtsTable({ name: 'users', type: 'ordered_set' });
      expect(table.name).toBe('users');
      expect(table.type).toBe('ordered_set');
    });

    it('should auto-increment instance names', async () => {
      const t1 = new EtsTable();
      const t2 = new EtsTable();
      expect(t1.name).toBe('ets-1');
      expect(t2.name).toBe('ets-2');
      table = t1;
      await t2.close();
    });

    it('should be idempotent on start()', async () => {
      table = new EtsTable({ name: 'test' });
      await table.start();
      await table.start(); // no-op
      table.insert('a', 1);
      expect(table.lookup('a')).toBe(1);
    });

    it('should be idempotent on close()', async () => {
      table = new EtsTable({ name: 'test' });
      await table.start();
      await table.close();
      await table.close(); // no-op
    });

    it('should throw on operations after close', async () => {
      table = new EtsTable({ name: 'test' });
      await table.start();
      await table.close();

      expect(() => table.insert('a', 1)).toThrow("ETS table 'test' is closed.");
      expect(() => table.lookup('a')).toThrow("ETS table 'test' is closed.");
      expect(() => table.delete('a')).toThrow("ETS table 'test' is closed.");
      expect(() => table.member('a')).toThrow("ETS table 'test' is closed.");
      expect(() => table.size()).toThrow("ETS table 'test' is closed.");
      expect(() => table.toArray()).toThrow("ETS table 'test' is closed.");
      expect(() => table.keys()).toThrow("ETS table 'test' is closed.");
      expect(() => table.clear()).toThrow("ETS table 'test' is closed.");
      expect(() => table.select(() => true)).toThrow("ETS table 'test' is closed.");
      expect(() => table.match('*')).toThrow("ETS table 'test' is closed.");
      expect(() => table.reduce((acc) => acc, 0)).toThrow("ETS table 'test' is closed.");
      expect(() => table.updateCounter('a', 1)).toThrow("ETS table 'test' is closed.");
      expect(() => table.first()).toThrow("ETS table 'test' is closed.");
      expect(() => table.last()).toThrow("ETS table 'test' is closed.");
    });

    it('should work without calling start()', () => {
      table = new EtsTable({ name: 'no-start' });
      table.insert('key', 'value');
      expect(table.lookup('key')).toBe('value');
    });
  });

  // ===========================================================================
  // Set Operations
  // ===========================================================================

  describe('set (default type)', () => {
    beforeEach(() => {
      table = new EtsTable<string, unknown>({ name: 'set-test', type: 'set' });
    });

    describe('insert() / lookup()', () => {
      it('should insert and lookup a value', () => {
        table.insert('user:1', { name: 'Alice' });
        expect(table.lookup('user:1')).toEqual({ name: 'Alice' });
      });

      it('should overwrite existing value for same key', () => {
        table.insert('k', 'first');
        table.insert('k', 'second');
        expect(table.lookup('k')).toBe('second');
        expect(table.size()).toBe(1);
      });

      it('should return undefined for missing key', () => {
        expect(table.lookup('missing')).toBeUndefined();
      });
    });

    describe('insertMany()', () => {
      it('should insert multiple entries', () => {
        table.insertMany([
          ['a', 1],
          ['b', 2],
          ['c', 3],
        ]);
        expect(table.size()).toBe(3);
        expect(table.lookup('a')).toBe(1);
        expect(table.lookup('b')).toBe(2);
        expect(table.lookup('c')).toBe(3);
      });

      it('should overwrite duplicates in batch', () => {
        table.insertMany([
          ['x', 'first'],
          ['x', 'second'],
        ]);
        expect(table.lookup('x')).toBe('second');
        expect(table.size()).toBe(1);
      });
    });

    describe('delete()', () => {
      it('should delete an existing key', () => {
        table.insert('k', 'v');
        expect(table.delete('k')).toBe(true);
        expect(table.lookup('k')).toBeUndefined();
        expect(table.size()).toBe(0);
      });

      it('should return false for missing key', () => {
        expect(table.delete('missing')).toBe(false);
      });
    });

    describe('deleteObject()', () => {
      it('should delete entry when value matches', () => {
        table.insert('k', 'value');
        expect(table.deleteObject('k', 'value')).toBe(true);
        expect(table.member('k')).toBe(false);
      });

      it('should not delete when value does not match', () => {
        table.insert('k', 'value');
        expect(table.deleteObject('k', 'other')).toBe(false);
        expect(table.member('k')).toBe(true);
      });

      it('should return false for missing key', () => {
        expect(table.deleteObject('missing', 'v')).toBe(false);
      });
    });

    describe('member()', () => {
      it('should return true for existing key', () => {
        table.insert('k', 'v');
        expect(table.member('k')).toBe(true);
      });

      it('should return false for missing key', () => {
        expect(table.member('missing')).toBe(false);
      });
    });

    describe('size()', () => {
      it('should return 0 for empty table', () => {
        expect(table.size()).toBe(0);
      });

      it('should track insertions and deletions', () => {
        table.insert('a', 1);
        table.insert('b', 2);
        expect(table.size()).toBe(2);
        table.delete('a');
        expect(table.size()).toBe(1);
      });
    });

    describe('toArray()', () => {
      it('should return empty array for empty table', () => {
        expect(table.toArray()).toEqual([]);
      });

      it('should return all entries as [key, value] tuples', () => {
        table.insert('a', 1);
        table.insert('b', 2);
        const arr = table.toArray();
        expect(arr).toHaveLength(2);
        expect(arr).toContainEqual(['a', 1]);
        expect(arr).toContainEqual(['b', 2]);
      });
    });

    describe('keys()', () => {
      it('should return all keys', () => {
        table.insert('x', 1);
        table.insert('y', 2);
        const k = table.keys();
        expect(k).toHaveLength(2);
        expect(k).toContain('x');
        expect(k).toContain('y');
      });
    });

    describe('clear()', () => {
      it('should remove all entries', () => {
        table.insert('a', 1);
        table.insert('b', 2);
        table.clear();
        expect(table.size()).toBe(0);
        expect(table.lookup('a')).toBeUndefined();
      });
    });
  });

  // ===========================================================================
  // Ordered Set
  // ===========================================================================

  describe('ordered_set', () => {
    let ordered: EtsTable<string, number>;

    beforeEach(() => {
      ordered = new EtsTable<string, number>({
        name: 'ordered-test',
        type: 'ordered_set',
      });
      table = ordered as unknown as EtsTable<string, unknown>;
    });

    it('should maintain sorted order on toArray()', () => {
      ordered.insert('cherry', 3);
      ordered.insert('apple', 1);
      ordered.insert('banana', 2);

      expect(ordered.toArray()).toEqual([
        ['apple', 1],
        ['banana', 2],
        ['cherry', 3],
      ]);
    });

    it('should return sorted keys()', () => {
      ordered.insert('z', 26);
      ordered.insert('a', 1);
      ordered.insert('m', 13);
      expect(ordered.keys()).toEqual(['a', 'm', 'z']);
    });

    it('should overwrite value for existing key', () => {
      ordered.insert('key', 1);
      ordered.insert('key', 99);
      expect(ordered.lookup('key')).toBe(99);
      expect(ordered.size()).toBe(1);
    });

    it('should support lookup via binary search', () => {
      ordered.insertMany([
        ['d', 4],
        ['b', 2],
        ['f', 6],
        ['a', 1],
        ['c', 3],
        ['e', 5],
      ]);
      expect(ordered.lookup('c')).toBe(3);
      expect(ordered.lookup('f')).toBe(6);
      expect(ordered.lookup('missing')).toBeUndefined();
    });

    it('should delete while maintaining order', () => {
      ordered.insertMany([
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]);
      ordered.delete('b');
      expect(ordered.toArray()).toEqual([
        ['a', 1],
        ['c', 3],
      ]);
    });

    it('should support custom comparator', () => {
      const numTable = new EtsTable<number, string>({
        name: 'num-ordered',
        type: 'ordered_set',
        keyComparator: (a, b) => a - b,
      });

      numTable.insert(30, 'thirty');
      numTable.insert(10, 'ten');
      numTable.insert(20, 'twenty');

      expect(numTable.keys()).toEqual([10, 20, 30]);
      expect(numTable.toArray()).toEqual([
        [10, 'ten'],
        [20, 'twenty'],
        [30, 'thirty'],
      ]);

      void numTable.close();
    });

    describe('navigation', () => {
      beforeEach(() => {
        ordered.insertMany([
          ['b', 2],
          ['d', 4],
          ['a', 1],
          ['c', 3],
          ['e', 5],
        ]);
      });

      it('first() should return the smallest entry', () => {
        expect(ordered.first()).toEqual({ key: 'a', value: 1 });
      });

      it('last() should return the largest entry', () => {
        expect(ordered.last()).toEqual({ key: 'e', value: 5 });
      });

      it('next() should return the entry after the given key', () => {
        expect(ordered.next('a')).toEqual({ key: 'b', value: 2 });
        expect(ordered.next('c')).toEqual({ key: 'd', value: 4 });
      });

      it('next() should return undefined for the last key', () => {
        expect(ordered.next('e')).toBeUndefined();
      });

      it('prev() should return the entry before the given key', () => {
        expect(ordered.prev('e')).toEqual({ key: 'd', value: 4 });
        expect(ordered.prev('c')).toEqual({ key: 'b', value: 2 });
      });

      it('prev() should return undefined for the first key', () => {
        expect(ordered.prev('a')).toBeUndefined();
      });

      it('next() should throw for non-existent key', () => {
        expect(() => ordered.next('missing')).toThrow(EtsKeyNotFoundError);
        expect(() => ordered.next('missing')).toThrow(
          "Key 'missing' not found in ETS table 'ordered-test'.",
        );
      });

      it('prev() should throw for non-existent key', () => {
        expect(() => ordered.prev('missing')).toThrow(EtsKeyNotFoundError);
      });

      it('first() should return undefined on empty table', () => {
        ordered.clear();
        expect(ordered.first()).toBeUndefined();
      });

      it('last() should return undefined on empty table', () => {
        ordered.clear();
        expect(ordered.last()).toBeUndefined();
      });
    });

    describe('navigation type restriction', () => {
      it('next() should throw on non-ordered_set tables', () => {
        const setTable = new EtsTable<string, number>({ name: 'set', type: 'set' });
        setTable.insert('a', 1);
        expect(() => setTable.next('a')).toThrow(
          "next() is only supported on ordered_set tables, but 'set' is of type 'set'.",
        );
        void setTable.close();
      });

      it('prev() should throw on non-ordered_set tables', () => {
        const bagTable = new EtsTable<string, number>({ name: 'bag', type: 'bag' });
        bagTable.insert('a', 1);
        expect(() => bagTable.prev('a')).toThrow(
          "prev() is only supported on ordered_set tables, but 'bag' is of type 'bag'.",
        );
        void bagTable.close();
      });
    });
  });

  // ===========================================================================
  // Bag
  // ===========================================================================

  describe('bag', () => {
    let bag: EtsTable<string, string>;

    beforeEach(() => {
      bag = new EtsTable<string, string>({ name: 'bag-test', type: 'bag' });
      table = bag as unknown as EtsTable<string, unknown>;
    });

    it('should allow multiple values for the same key', () => {
      bag.insert('role', 'admin');
      bag.insert('role', 'editor');
      expect(bag.lookup('role')).toEqual(['admin', 'editor']);
    });

    it('should prevent duplicate {key, value} pairs', () => {
      bag.insert('tag', 'urgent');
      bag.insert('tag', 'urgent'); // duplicate — should be ignored
      bag.insert('tag', 'important');
      expect(bag.lookup('tag')).toEqual(['urgent', 'important']);
      expect(bag.size()).toBe(2);
    });

    it('should return empty array for missing key', () => {
      expect(bag.lookup('missing')).toEqual([]);
    });

    it('should count all entries across keys in size()', () => {
      bag.insert('a', 'v1');
      bag.insert('a', 'v2');
      bag.insert('b', 'v3');
      expect(bag.size()).toBe(3);
    });

    it('should delete all values for a key', () => {
      bag.insert('k', 'v1');
      bag.insert('k', 'v2');
      expect(bag.delete('k')).toBe(true);
      expect(bag.lookup('k')).toEqual([]);
      expect(bag.size()).toBe(0);
    });

    describe('deleteObject()', () => {
      it('should delete only the matching value', () => {
        bag.insert('k', 'v1');
        bag.insert('k', 'v2');
        bag.insert('k', 'v3');

        expect(bag.deleteObject('k', 'v2')).toBe(true);
        expect(bag.lookup('k')).toEqual(['v1', 'v3']);
        expect(bag.size()).toBe(2);
      });

      it('should remove key entirely when last value deleted', () => {
        bag.insert('k', 'only');
        bag.deleteObject('k', 'only');
        expect(bag.member('k')).toBe(false);
        expect(bag.lookup('k')).toEqual([]);
      });

      it('should return false for non-matching value', () => {
        bag.insert('k', 'v1');
        expect(bag.deleteObject('k', 'other')).toBe(false);
      });

      it('should return false for missing key', () => {
        expect(bag.deleteObject('missing', 'v')).toBe(false);
      });
    });

    it('should include all entries in toArray()', () => {
      bag.insert('a', 'x');
      bag.insert('a', 'y');
      bag.insert('b', 'z');

      const arr = bag.toArray();
      expect(arr).toHaveLength(3);
      expect(arr).toContainEqual(['a', 'x']);
      expect(arr).toContainEqual(['a', 'y']);
      expect(arr).toContainEqual(['b', 'z']);
    });

    it('keys() should return unique keys', () => {
      bag.insert('a', 'x');
      bag.insert('a', 'y');
      bag.insert('b', 'z');
      expect(bag.keys()).toEqual(['a', 'b']);
    });
  });

  // ===========================================================================
  // Duplicate Bag
  // ===========================================================================

  describe('duplicate_bag', () => {
    let dupBag: EtsTable<string, string>;

    beforeEach(() => {
      dupBag = new EtsTable<string, string>({
        name: 'dup-bag-test',
        type: 'duplicate_bag',
      });
      table = dupBag as unknown as EtsTable<string, unknown>;
    });

    it('should allow duplicate {key, value} pairs', () => {
      dupBag.insert('event', 'click');
      dupBag.insert('event', 'click');
      dupBag.insert('event', 'click');
      expect(dupBag.lookup('event')).toEqual(['click', 'click', 'click']);
      expect(dupBag.size()).toBe(3);
    });

    it('should delete all entries for a key', () => {
      dupBag.insert('k', 'v');
      dupBag.insert('k', 'v');
      dupBag.delete('k');
      expect(dupBag.size()).toBe(0);
    });

    it('deleteObject() should remove only the first matching entry', () => {
      dupBag.insert('k', 'v');
      dupBag.insert('k', 'v');
      dupBag.insert('k', 'v');

      expect(dupBag.deleteObject('k', 'v')).toBe(true);
      expect(dupBag.size()).toBe(2);
    });
  });

  // ===========================================================================
  // Pattern Matching & Queries
  // ===========================================================================

  describe('select()', () => {
    beforeEach(() => {
      table = new EtsTable<string, unknown>({ name: 'select-test' });
      table.insert('alice', { age: 30, role: 'admin' });
      table.insert('bob', { age: 25, role: 'user' });
      table.insert('charlie', { age: 35, role: 'admin' });
    });

    it('should filter entries by predicate', () => {
      const admins = table.select(
        (_k, v) => (v as { role: string }).role === 'admin',
      );
      expect(admins).toHaveLength(2);
      expect(admins.map((r) => r.key)).toContain('alice');
      expect(admins.map((r) => r.key)).toContain('charlie');
    });

    it('should return empty array when no entries match', () => {
      const result = table.select((_k, v) => (v as { age: number }).age > 100);
      expect(result).toEqual([]);
    });

    it('should match all entries with always-true predicate', () => {
      const all = table.select(() => true);
      expect(all).toHaveLength(3);
    });
  });

  describe('match()', () => {
    beforeEach(() => {
      table = new EtsTable<string, unknown>({ name: 'match-test' });
      table.insert('user:1', { name: 'Alice' });
      table.insert('user:2', { name: 'Bob' });
      table.insert('admin:1', { name: 'Charlie' });
      table.insert('service/auth', { port: 3000 });
      table.insert('service/db', { port: 5432 });
    });

    it('should match with wildcard prefix', () => {
      const users = table.match('user:*');
      expect(users).toHaveLength(2);
      expect(users.map((r) => r.key)).toContain('user:1');
      expect(users.map((r) => r.key)).toContain('user:2');
    });

    it('should match with ? for single char', () => {
      const result = table.match('user:?');
      expect(result).toHaveLength(2);
    });

    it('should match with ** for paths', () => {
      const services = table.match('service/**');
      expect(services).toHaveLength(2);
    });

    it('should not match across / with single *', () => {
      const noMatch = table.match('service*');
      // 'service/auth' has a / so single * won't cross it
      expect(noMatch).toHaveLength(0);
    });

    it('should support value predicate', () => {
      const result = table.match(
        'user:*',
        (_k, v) => (v as { name: string }).name === 'Alice',
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.key).toBe('user:1');
    });

    it('should return empty array for non-matching pattern', () => {
      expect(table.match('nothing:*')).toEqual([]);
    });

    it('should match exact string without wildcards', () => {
      const result = table.match('admin:1');
      expect(result).toHaveLength(1);
      expect(result[0]!.key).toBe('admin:1');
    });
  });

  describe('reduce()', () => {
    it('should fold over all entries', () => {
      const numTable = new EtsTable<string, number>({ name: 'reduce-test' });
      numTable.insert('a', 10);
      numTable.insert('b', 20);
      numTable.insert('c', 30);

      const sum = numTable.reduce((acc, _k, v) => acc + v, 0);
      expect(sum).toBe(60);

      void numTable.close();
    });

    it('should return initial value for empty table', () => {
      const empty = new EtsTable<string, number>({ name: 'empty-reduce' });
      expect(empty.reduce((acc, _k, v) => acc + v, 0)).toBe(0);
      void empty.close();
    });

    it('should accumulate keys', () => {
      const t = new EtsTable<string, number>({ name: 'keys-reduce' });
      t.insert('x', 1);
      t.insert('y', 2);
      const keys = t.reduce<string[]>((acc, k) => [...acc, k], []);
      expect(keys).toHaveLength(2);
      expect(keys).toContain('x');
      expect(keys).toContain('y');
      void t.close();
    });
  });

  // ===========================================================================
  // Counter Operations
  // ===========================================================================

  describe('updateCounter()', () => {
    let counters: EtsTable<string, number>;

    beforeEach(() => {
      counters = new EtsTable<string, number>({
        name: 'counters',
        type: 'set',
      });
      table = counters as unknown as EtsTable<string, unknown>;
    });

    it('should initialize counter to increment value if key missing', () => {
      expect(counters.updateCounter('hits', 1)).toBe(1);
      expect(counters.lookup('hits')).toBe(1);
    });

    it('should increment existing counter', () => {
      counters.insert('hits', 5);
      expect(counters.updateCounter('hits', 3)).toBe(8);
      expect(counters.lookup('hits')).toBe(8);
    });

    it('should decrement with negative increment', () => {
      counters.insert('balance', 100);
      expect(counters.updateCounter('balance', -25)).toBe(75);
    });

    it('should work with ordered_set', () => {
      const ordCounters = new EtsTable<string, number>({
        name: 'ord-counters',
        type: 'ordered_set',
      });
      ordCounters.updateCounter('x', 10);
      ordCounters.updateCounter('x', 5);
      expect(ordCounters.lookup('x')).toBe(15);
      void ordCounters.close();
    });

    it('should throw EtsCounterTypeError for non-numeric value', () => {
      const mixed = new EtsTable<string, unknown>({ name: 'mixed' });
      mixed.insert('name', 'Alice');
      expect(() => mixed.updateCounter('name', 1)).toThrow(EtsCounterTypeError);
      expect(() => mixed.updateCounter('name', 1)).toThrow(
        "Cannot use updateCounter on key 'name' in ETS table 'mixed': value is not a number.",
      );
      void mixed.close();
    });

    it('should throw EtsCounterTypeError for bag types', () => {
      const bagTable = new EtsTable<string, number>({
        name: 'bag-counter',
        type: 'bag',
      });
      expect(() => bagTable.updateCounter('k', 1)).toThrow(EtsCounterTypeError);
      void bagTable.close();
    });

    it('should throw EtsCounterTypeError for duplicate_bag types', () => {
      const dupBag = new EtsTable<string, number>({
        name: 'dupbag-counter',
        type: 'duplicate_bag',
      });
      expect(() => dupBag.updateCounter('k', 1)).toThrow(EtsCounterTypeError);
      void dupBag.close();
    });
  });

  // ===========================================================================
  // Info
  // ===========================================================================

  describe('info()', () => {
    it('should return table metadata', () => {
      table = new EtsTable<string, unknown>({
        name: 'my-table',
        type: 'ordered_set',
      });
      table.insert('a', 1);
      table.insert('b', 2);

      expect(table.info()).toEqual({
        name: 'my-table',
        type: 'ordered_set',
        size: 2,
      });
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle empty string keys', () => {
      table = new EtsTable<string, unknown>({ name: 'edge' });
      table.insert('', 'empty-key');
      expect(table.lookup('')).toBe('empty-key');
      expect(table.member('')).toBe(true);
    });

    it('should handle undefined values in set', () => {
      const t = new EtsTable<string, undefined>({ name: 'undef' });
      t.insert('k', undefined);
      expect(t.member('k')).toBe(true);
      // lookup returns undefined which is the stored value
      expect(t.lookup('k')).toBeUndefined();
      void t.close();
    });

    it('should handle null values', () => {
      const t = new EtsTable<string, null>({ name: 'null-vals' });
      t.insert('k', null);
      expect(t.lookup('k')).toBeNull();
      expect(t.member('k')).toBe(true);
      void t.close();
    });

    it('should handle numeric keys in ordered_set', () => {
      const t = new EtsTable<number, string>({
        name: 'num-keys',
        type: 'ordered_set',
        keyComparator: (a, b) => a - b,
      });
      t.insert(100, 'hundred');
      t.insert(1, 'one');
      t.insert(50, 'fifty');
      expect(t.keys()).toEqual([1, 50, 100]);
      void t.close();
    });

    it('should handle large number of entries', () => {
      table = new EtsTable<string, unknown>({ name: 'large' });
      for (let i = 0; i < 1000; i++) {
        table.insert(`key-${i}`, i);
      }
      expect(table.size()).toBe(1000);
      expect(table.lookup('key-500')).toBe(500);
      expect(table.lookup('key-999')).toBe(999);
    });

    it('should handle large ordered_set with random insert order', () => {
      const t = new EtsTable<number, number>({
        name: 'large-ordered',
        type: 'ordered_set',
        keyComparator: (a, b) => a - b,
      });

      const keys = Array.from({ length: 100 }, (_, i) => i);
      // Shuffle
      for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [keys[i], keys[j]] = [keys[j]!, keys[i]!];
      }

      for (const k of keys) {
        t.insert(k!, k!);
      }

      const result = t.keys();
      for (let i = 0; i < 100; i++) {
        expect(result[i]).toBe(i);
      }

      void t.close();
    });

    it('should handle clear() followed by operations', () => {
      table = new EtsTable<string, unknown>({ name: 'clear-reuse' });
      table.insert('a', 1);
      table.clear();
      expect(table.size()).toBe(0);
      table.insert('b', 2);
      expect(table.size()).toBe(1);
      expect(table.lookup('b')).toBe(2);
    });

    it('select() on bag should iterate all values', () => {
      const bag = new EtsTable<string, number>({ name: 'bag-select', type: 'bag' });
      bag.insert('k', 1);
      bag.insert('k', 2);
      bag.insert('k', 3);
      bag.insert('other', 10);

      const big = bag.select((_k, v) => v > 2);
      expect(big).toHaveLength(2);
      expect(big).toContainEqual({ key: 'k', value: 3 });
      expect(big).toContainEqual({ key: 'other', value: 10 });
      void bag.close();
    });

    it('match() on ordered_set should work correctly', () => {
      const t = new EtsTable<string, number>({
        name: 'ord-match',
        type: 'ordered_set',
      });
      t.insert('user:alice', 1);
      t.insert('user:bob', 2);
      t.insert('admin:root', 3);

      const users = t.match('user:*');
      expect(users).toHaveLength(2);
      void t.close();
    });

    it('reduce() on bag should see all entries', () => {
      const bag = new EtsTable<string, number>({ name: 'bag-reduce', type: 'bag' });
      bag.insert('a', 1);
      bag.insert('a', 2);
      bag.insert('b', 3);

      const sum = bag.reduce((acc, _k, v) => acc + v, 0);
      expect(sum).toBe(6);
      void bag.close();
    });

    it('first()/last() on set should return some entry', () => {
      table = new EtsTable<string, unknown>({ name: 'set-first' });
      table.insert('only', 42);
      const first = table.first();
      expect(first).toEqual({ key: 'only', value: 42 });
    });

    it('first() on empty table should return undefined', () => {
      table = new EtsTable<string, unknown>({ name: 'empty-first' });
      expect(table.first()).toBeUndefined();
    });

    it('deleteObject() on ordered_set', () => {
      const t = new EtsTable<string, number>({
        name: 'ord-delobj',
        type: 'ordered_set',
      });
      t.insert('a', 1);
      t.insert('b', 2);
      t.insert('c', 3);

      expect(t.deleteObject('b', 2)).toBe(true);
      expect(t.toArray()).toEqual([
        ['a', 1],
        ['c', 3],
      ]);

      expect(t.deleteObject('c', 999)).toBe(false);
      expect(t.size()).toBe(2);
      void t.close();
    });
  });

  // ===========================================================================
  // Error Class Properties
  // ===========================================================================

  describe('error classes', () => {
    it('EtsKeyNotFoundError should have correct properties', () => {
      const err = new EtsKeyNotFoundError('my-table', 'the-key');
      expect(err.name).toBe('EtsKeyNotFoundError');
      expect(err.tableName).toBe('my-table');
      expect(err.key).toBe('the-key');
      expect(err.message).toBe("Key 'the-key' not found in ETS table 'my-table'.");
      expect(err).toBeInstanceOf(Error);
    });

    it('EtsCounterTypeError should have correct properties', () => {
      const err = new EtsCounterTypeError('counters', 'bad-key');
      expect(err.name).toBe('EtsCounterTypeError');
      expect(err.tableName).toBe('counters');
      expect(err.key).toBe('bad-key');
      expect(err.message).toContain('not a number');
      expect(err).toBeInstanceOf(Error);
    });
  });
});
