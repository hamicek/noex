import { describe, it, expect } from 'vitest';
import {
  defaultSerializer,
  createPrettySerializer,
  SerializationError,
  DeserializationError,
} from '../../src/persistence/index.js';

describe('defaultSerializer', () => {
  describe('primitive types', () => {
    it('handles strings', () => {
      const value = 'hello world';
      const serialized = defaultSerializer.serialize(value);
      const deserialized = defaultSerializer.deserialize<string>(serialized);
      expect(deserialized).toBe(value);
    });

    it('handles numbers', () => {
      const values = [0, 42, -17, 3.14159, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
      for (const value of values) {
        const serialized = defaultSerializer.serialize(value);
        const deserialized = defaultSerializer.deserialize<number>(serialized);
        expect(deserialized).toBe(value);
      }
    });

    it('handles booleans', () => {
      expect(defaultSerializer.deserialize(defaultSerializer.serialize(true))).toBe(true);
      expect(defaultSerializer.deserialize(defaultSerializer.serialize(false))).toBe(false);
    });

    it('handles null', () => {
      const serialized = defaultSerializer.serialize(null);
      const deserialized = defaultSerializer.deserialize(serialized);
      expect(deserialized).toBeNull();
    });

    it('handles undefined', () => {
      const serialized = defaultSerializer.serialize(undefined);
      const deserialized = defaultSerializer.deserialize(serialized);
      expect(deserialized).toBeUndefined();
    });
  });

  describe('Date', () => {
    it('preserves Date objects', () => {
      const date = new Date('2024-06-15T10:30:00.000Z');
      const serialized = defaultSerializer.serialize(date);
      const deserialized = defaultSerializer.deserialize<Date>(serialized);

      expect(deserialized).toBeInstanceOf(Date);
      expect(deserialized.toISOString()).toBe(date.toISOString());
    });

    it('preserves Date in objects', () => {
      const obj = { createdAt: new Date(), name: 'test' };
      const serialized = defaultSerializer.serialize(obj);
      const deserialized = defaultSerializer.deserialize<typeof obj>(serialized);

      expect(deserialized.createdAt).toBeInstanceOf(Date);
      expect(deserialized.createdAt.getTime()).toBe(obj.createdAt.getTime());
      expect(deserialized.name).toBe('test');
    });

    it('preserves Date in arrays', () => {
      const dates = [new Date('2024-01-01'), new Date('2024-06-15'), new Date('2024-12-31')];
      const serialized = defaultSerializer.serialize(dates);
      const deserialized = defaultSerializer.deserialize<Date[]>(serialized);

      expect(deserialized).toHaveLength(3);
      deserialized.forEach((d, i) => {
        expect(d).toBeInstanceOf(Date);
        expect(d.getTime()).toBe(dates[i]!.getTime());
      });
    });
  });

  describe('Map', () => {
    it('preserves Map objects', () => {
      const map = new Map<string, number>([
        ['one', 1],
        ['two', 2],
        ['three', 3],
      ]);
      const serialized = defaultSerializer.serialize(map);
      const deserialized = defaultSerializer.deserialize<Map<string, number>>(serialized);

      expect(deserialized).toBeInstanceOf(Map);
      expect(deserialized.size).toBe(3);
      expect(deserialized.get('one')).toBe(1);
      expect(deserialized.get('two')).toBe(2);
      expect(deserialized.get('three')).toBe(3);
    });

    it('preserves Map with complex values', () => {
      const map = new Map<string, { name: string; date: Date }>([
        ['alice', { name: 'Alice', date: new Date('2024-01-01') }],
        ['bob', { name: 'Bob', date: new Date('2024-06-15') }],
      ]);
      const serialized = defaultSerializer.serialize(map);
      const deserialized = defaultSerializer.deserialize<typeof map>(serialized);

      expect(deserialized).toBeInstanceOf(Map);
      expect(deserialized.size).toBe(2);

      const alice = deserialized.get('alice');
      expect(alice).toBeDefined();
      expect(alice!.name).toBe('Alice');
      expect(alice!.date).toBeInstanceOf(Date);
    });

    it('preserves empty Map', () => {
      const map = new Map();
      const serialized = defaultSerializer.serialize(map);
      const deserialized = defaultSerializer.deserialize<Map<unknown, unknown>>(serialized);

      expect(deserialized).toBeInstanceOf(Map);
      expect(deserialized.size).toBe(0);
    });

    it('preserves nested Maps', () => {
      const inner = new Map([['nested', 'value']]);
      const outer = new Map([['inner', inner]]);
      const serialized = defaultSerializer.serialize(outer);
      const deserialized = defaultSerializer.deserialize<Map<string, Map<string, string>>>(serialized);

      expect(deserialized).toBeInstanceOf(Map);
      expect(deserialized.get('inner')).toBeInstanceOf(Map);
      expect(deserialized.get('inner')!.get('nested')).toBe('value');
    });
  });

  describe('Set', () => {
    it('preserves Set objects', () => {
      const set = new Set([1, 2, 3, 4, 5]);
      const serialized = defaultSerializer.serialize(set);
      const deserialized = defaultSerializer.deserialize<Set<number>>(serialized);

      expect(deserialized).toBeInstanceOf(Set);
      expect(deserialized.size).toBe(5);
      expect(deserialized.has(1)).toBe(true);
      expect(deserialized.has(3)).toBe(true);
      expect(deserialized.has(5)).toBe(true);
    });

    it('preserves Set with objects', () => {
      const obj1 = { id: 1 };
      const obj2 = { id: 2 };
      const set = new Set([obj1, obj2]);
      const serialized = defaultSerializer.serialize(set);
      const deserialized = defaultSerializer.deserialize<Set<{ id: number }>>(serialized);

      expect(deserialized).toBeInstanceOf(Set);
      expect(deserialized.size).toBe(2);

      const values = Array.from(deserialized);
      expect(values).toContainEqual({ id: 1 });
      expect(values).toContainEqual({ id: 2 });
    });

    it('preserves empty Set', () => {
      const set = new Set();
      const serialized = defaultSerializer.serialize(set);
      const deserialized = defaultSerializer.deserialize<Set<unknown>>(serialized);

      expect(deserialized).toBeInstanceOf(Set);
      expect(deserialized.size).toBe(0);
    });
  });

  describe('BigInt', () => {
    it('preserves BigInt values', () => {
      const big = 9007199254740993n; // Beyond Number.MAX_SAFE_INTEGER
      const serialized = defaultSerializer.serialize(big);
      const deserialized = defaultSerializer.deserialize<bigint>(serialized);

      expect(typeof deserialized).toBe('bigint');
      expect(deserialized).toBe(big);
    });

    it('preserves negative BigInt', () => {
      const big = -12345678901234567890n;
      const serialized = defaultSerializer.serialize(big);
      const deserialized = defaultSerializer.deserialize<bigint>(serialized);

      expect(deserialized).toBe(big);
    });

    it('preserves BigInt in objects', () => {
      const obj = { amount: 9007199254740993n, name: 'large' };
      const serialized = defaultSerializer.serialize(obj);
      const deserialized = defaultSerializer.deserialize<typeof obj>(serialized);

      expect(typeof deserialized.amount).toBe('bigint');
      expect(deserialized.amount).toBe(obj.amount);
    });

    it('preserves zero BigInt', () => {
      const big = 0n;
      const serialized = defaultSerializer.serialize(big);
      const deserialized = defaultSerializer.deserialize<bigint>(serialized);

      expect(deserialized).toBe(0n);
    });
  });

  describe('complex nested structures', () => {
    it('handles deeply nested objects', () => {
      const complex = {
        users: new Map([
          [
            'alice',
            {
              name: 'Alice',
              createdAt: new Date('2024-01-01'),
              roles: new Set(['admin', 'user']),
              balance: 1000000000000000n,
            },
          ],
        ]),
        metadata: {
          version: 1,
          lastSync: new Date(),
        },
      };

      const serialized = defaultSerializer.serialize(complex);
      const deserialized = defaultSerializer.deserialize<typeof complex>(serialized);

      expect(deserialized.users).toBeInstanceOf(Map);
      const alice = deserialized.users.get('alice');
      expect(alice).toBeDefined();
      expect(alice!.createdAt).toBeInstanceOf(Date);
      expect(alice!.roles).toBeInstanceOf(Set);
      expect(alice!.roles.has('admin')).toBe(true);
      expect(typeof alice!.balance).toBe('bigint');
      expect(deserialized.metadata.lastSync).toBeInstanceOf(Date);
    });

    it('handles arrays with mixed special types', () => {
      const array = [
        new Date('2024-01-01'),
        new Map([['key', 'value']]),
        new Set([1, 2, 3]),
        12345678901234567890n,
        undefined,
        null,
        'string',
        42,
      ];

      const serialized = defaultSerializer.serialize(array);
      const deserialized = defaultSerializer.deserialize<typeof array>(serialized);

      expect(deserialized[0]).toBeInstanceOf(Date);
      expect(deserialized[1]).toBeInstanceOf(Map);
      expect(deserialized[2]).toBeInstanceOf(Set);
      expect(typeof deserialized[3]).toBe('bigint');
      expect(deserialized[4]).toBeUndefined();
      expect(deserialized[5]).toBeNull();
      expect(deserialized[6]).toBe('string');
      expect(deserialized[7]).toBe(42);
    });

    it('handles object with undefined values', () => {
      const obj = { a: 1, b: undefined, c: 'test' };
      const serialized = defaultSerializer.serialize(obj);
      const deserialized = defaultSerializer.deserialize<typeof obj>(serialized);

      expect(deserialized.a).toBe(1);
      expect(deserialized.b).toBeUndefined();
      expect('b' in deserialized).toBe(true); // key should exist
      expect(deserialized.c).toBe('test');
    });
  });

  describe('edge cases', () => {
    it('handles empty object', () => {
      const obj = {};
      const serialized = defaultSerializer.serialize(obj);
      const deserialized = defaultSerializer.deserialize<Record<string, unknown>>(serialized);
      expect(deserialized).toEqual({});
    });

    it('handles empty array', () => {
      const arr: unknown[] = [];
      const serialized = defaultSerializer.serialize(arr);
      const deserialized = defaultSerializer.deserialize<unknown[]>(serialized);
      expect(deserialized).toEqual([]);
    });

    it('handles special number values', () => {
      // Note: Infinity and NaN become null in JSON
      const obj = { inf: Infinity, negInf: -Infinity, nan: NaN };
      const serialized = defaultSerializer.serialize(obj);
      const deserialized = defaultSerializer.deserialize<typeof obj>(serialized);

      expect(deserialized.inf).toBeNull();
      expect(deserialized.negInf).toBeNull();
      expect(deserialized.nan).toBeNull();
    });

    it('handles objects with numeric keys', () => {
      const obj = { 1: 'one', 2: 'two', 3: 'three' };
      const serialized = defaultSerializer.serialize(obj);
      const deserialized = defaultSerializer.deserialize<typeof obj>(serialized);

      expect(deserialized[1]).toBe('one');
      expect(deserialized[2]).toBe('two');
    });
  });

  describe('error handling', () => {
    it('throws DeserializationError for invalid JSON', () => {
      expect(() => defaultSerializer.deserialize('not valid json')).toThrow(DeserializationError);
    });

    it('throws DeserializationError for truncated JSON', () => {
      expect(() => defaultSerializer.deserialize('{"key": "va')).toThrow(DeserializationError);
    });

    it('throws SerializationError for circular references', () => {
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;

      expect(() => defaultSerializer.serialize(circular)).toThrow(SerializationError);
    });
  });

  describe('round-trip integrity', () => {
    it('maintains data integrity across multiple serializations', () => {
      const original = {
        id: 'test-123',
        count: 42,
        active: true,
        tags: new Set(['a', 'b', 'c']),
        metadata: new Map([['version', 1]]),
        timestamp: new Date('2024-06-15T12:00:00Z'),
        bigValue: 9007199254740993n,
      };

      // Multiple round trips
      let current = original;
      for (let i = 0; i < 3; i++) {
        const serialized = defaultSerializer.serialize(current);
        current = defaultSerializer.deserialize(serialized);
      }

      expect(current.id).toBe(original.id);
      expect(current.count).toBe(original.count);
      expect(current.active).toBe(original.active);
      expect(current.tags).toBeInstanceOf(Set);
      expect(current.tags.size).toBe(3);
      expect(current.metadata).toBeInstanceOf(Map);
      expect(current.metadata.get('version')).toBe(1);
      expect(current.timestamp).toBeInstanceOf(Date);
      expect(current.timestamp.getTime()).toBe(original.timestamp.getTime());
      expect(current.bigValue).toBe(original.bigValue);
    });
  });
});

describe('createPrettySerializer', () => {
  it('creates human-readable output', () => {
    const serializer = createPrettySerializer(2);
    const obj = { name: 'test', value: 42 };
    const serialized = serializer.serialize(obj);

    expect(serialized).toContain('\n');
    expect(serialized).toContain('  '); // indentation
  });

  it('supports custom indentation', () => {
    const serializer = createPrettySerializer(4);
    const obj = { nested: { value: 1 } };
    const serialized = serializer.serialize(obj);

    expect(serialized).toContain('    '); // 4 spaces
  });

  it('preserves special types like defaultSerializer', () => {
    const serializer = createPrettySerializer();
    const date = new Date('2024-06-15');

    const serialized = serializer.serialize(date);
    const deserialized = serializer.deserialize<Date>(serialized);

    expect(deserialized).toBeInstanceOf(Date);
    expect(deserialized.toISOString()).toBe(date.toISOString());
  });
});
