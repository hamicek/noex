/**
 * Tests for memory estimation utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  estimateObjectSize,
  getMemoryStats,
  formatBytes,
} from '../../src/observer/memory-utils.js';

describe('estimateObjectSize()', () => {
  describe('primitives', () => {
    it('estimates null as pointer size', () => {
      const size = estimateObjectSize(null);
      expect(size).toBe(8); // POINTER size
    });

    it('estimates undefined as zero', () => {
      const size = estimateObjectSize(undefined);
      expect(size).toBe(0);
    });

    it('estimates boolean as 4 bytes', () => {
      expect(estimateObjectSize(true)).toBe(4);
      expect(estimateObjectSize(false)).toBe(4);
    });

    it('estimates number as 8 bytes', () => {
      expect(estimateObjectSize(42)).toBe(8);
      expect(estimateObjectSize(3.14159)).toBe(8);
      expect(estimateObjectSize(Number.MAX_VALUE)).toBe(8);
    });

    it('estimates string based on length', () => {
      // String overhead (12) + 2 bytes per char
      expect(estimateObjectSize('')).toBe(12);
      expect(estimateObjectSize('hello')).toBe(12 + 5 * 2); // 22
      expect(estimateObjectSize('a')).toBe(12 + 2); // 14
    });

    it('estimates symbol as 8 bytes', () => {
      const sym = Symbol('test');
      expect(estimateObjectSize(sym)).toBe(8);
    });

    it('estimates bigint based on bit length', () => {
      // Base overhead + 8 bytes per 64-bit word
      const size0 = estimateObjectSize(0n);
      expect(size0).toBe(16 + 8); // 1 word

      const sizeLarge = estimateObjectSize(2n ** 128n);
      expect(sizeLarge).toBe(16 + 3 * 8); // 3 words for 129 bits
    });

    it('estimates function with base overhead', () => {
      const fn = () => 42;
      expect(estimateObjectSize(fn)).toBe(64);
    });
  });

  describe('arrays', () => {
    it('estimates empty array', () => {
      const size = estimateObjectSize([]);
      expect(size).toBe(24); // ARRAY_OVERHEAD
    });

    it('estimates array with numbers', () => {
      const arr = [1, 2, 3];
      const size = estimateObjectSize(arr);
      // Array overhead + 3 pointers + 3 numbers
      expect(size).toBe(24 + 3 * 8 + 3 * 8);
    });

    it('estimates nested arrays', () => {
      const arr = [[1], [2]];
      const size = estimateObjectSize(arr);
      expect(size).toBeGreaterThan(24 + 24 + 24); // At least 3 array overheads
    });
  });

  describe('objects', () => {
    it('estimates empty object', () => {
      const size = estimateObjectSize({});
      expect(size).toBe(16); // OBJECT_OVERHEAD
    });

    it('estimates object with properties', () => {
      const obj = { a: 1, b: 2 };
      const size = estimateObjectSize(obj);
      // Object overhead + 2 property pointers + 2 string keys + 2 number values
      expect(size).toBeGreaterThan(16 + 2 * 8);
    });

    it('estimates nested objects', () => {
      const obj = { outer: { inner: 42 } };
      const size = estimateObjectSize(obj);
      expect(size).toBeGreaterThan(16 + 16); // At least 2 object overheads
    });

    it('handles objects with symbol properties', () => {
      const sym = Symbol('key');
      const obj = { [sym]: 'value' };
      const size = estimateObjectSize(obj);
      expect(size).toBeGreaterThan(16); // Object overhead + symbol + string
    });
  });

  describe('special objects', () => {
    it('estimates Date', () => {
      const date = new Date();
      const size = estimateObjectSize(date);
      expect(size).toBe(48);
    });

    it('estimates RegExp', () => {
      const regex = /hello/gi;
      const size = estimateObjectSize(regex);
      // Base overhead + source length
      expect(size).toBe(64 + 5 * 2);
    });

    it('estimates Map', () => {
      const map = new Map([['a', 1], ['b', 2]]);
      const size = estimateObjectSize(map);
      expect(size).toBeGreaterThan(16); // At least object overhead + entries
    });

    it('estimates Set', () => {
      const set = new Set([1, 2, 3]);
      const size = estimateObjectSize(set);
      expect(size).toBeGreaterThan(16);
    });

    it('estimates ArrayBuffer', () => {
      const buffer = new ArrayBuffer(1024);
      const size = estimateObjectSize(buffer);
      expect(size).toBe(56 + 1024);
    });

    it('estimates typed arrays', () => {
      const arr = new Uint8Array(100);
      const size = estimateObjectSize(arr);
      expect(size).toBe(56 + 100);
    });

    it('returns base overhead for WeakMap/WeakSet', () => {
      const weakMap = new WeakMap();
      const weakSet = new WeakSet();
      expect(estimateObjectSize(weakMap)).toBe(16);
      expect(estimateObjectSize(weakSet)).toBe(16);
    });
  });

  describe('circular references', () => {
    it('handles self-referencing objects', () => {
      const obj: Record<string, unknown> = { name: 'test' };
      obj.self = obj;

      // Should not throw or infinite loop
      const size = estimateObjectSize(obj);
      expect(size).toBeGreaterThan(0);
    });

    it('handles mutually referencing objects', () => {
      const a: Record<string, unknown> = { name: 'a' };
      const b: Record<string, unknown> = { name: 'b' };
      a.ref = b;
      b.ref = a;

      const size = estimateObjectSize(a);
      expect(size).toBeGreaterThan(0);
    });

    it('handles circular arrays', () => {
      const arr: unknown[] = [1, 2, 3];
      arr.push(arr);

      const size = estimateObjectSize(arr);
      expect(size).toBeGreaterThan(0);
    });
  });

  describe('complex structures', () => {
    it('estimates realistic state object', () => {
      const state = {
        users: [
          { id: 1, name: 'Alice', email: 'alice@example.com' },
          { id: 2, name: 'Bob', email: 'bob@example.com' },
        ],
        config: {
          maxRetries: 3,
          timeout: 5000,
          features: new Set(['feature1', 'feature2']),
        },
        cache: new Map([
          ['key1', { data: 'value1', timestamp: Date.now() }],
        ]),
      };

      const size = estimateObjectSize(state);
      expect(size).toBeGreaterThan(500); // Reasonable minimum for this structure
    });
  });
});

describe('getMemoryStats()', () => {
  it('returns valid memory statistics', () => {
    const stats = getMemoryStats();

    expect(stats.heapUsed).toBeGreaterThan(0);
    expect(stats.heapTotal).toBeGreaterThan(0);
    expect(stats.heapTotal).toBeGreaterThanOrEqual(stats.heapUsed);
    expect(stats.rss).toBeGreaterThan(0);
    expect(stats.external).toBeGreaterThanOrEqual(0);
    expect(stats.timestamp).toBeGreaterThan(0);
  });

  it('returns consistent timestamp', () => {
    const before = Date.now();
    const stats = getMemoryStats();
    const after = Date.now();

    expect(stats.timestamp).toBeGreaterThanOrEqual(before);
    expect(stats.timestamp).toBeLessThanOrEqual(after);
  });
});

describe('formatBytes()', () => {
  it('formats zero bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatBytes(100)).toBe('100 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1536)).toBe('1.50 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.50 MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
  });

  it('formats terabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1.00 TB');
  });
});
