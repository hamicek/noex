/**
 * Memory estimation utilities for noex Observer.
 *
 * Provides heuristic-based memory size estimation for JavaScript objects.
 * These are approximations based on V8's typical memory layout, not exact
 * measurements. Useful for monitoring relative memory usage trends.
 */

import type { MemoryStats } from '../core/types.js';

/**
 * Size constants based on V8's typical memory layout.
 * These are approximations for a 64-bit system.
 */
const SIZES = {
  /** Pointer/reference size on 64-bit systems */
  POINTER: 8,
  /** Object header overhead (hidden class pointer + properties pointer) */
  OBJECT_OVERHEAD: 16,
  /** Array header overhead (length + elements pointer) */
  ARRAY_OVERHEAD: 24,
  /** Map/Set entry overhead */
  MAP_ENTRY_OVERHEAD: 32,
  /** String header overhead */
  STRING_OVERHEAD: 12,
  /** Number (IEEE 754 double) */
  NUMBER: 8,
  /** Boolean (stored as SMI in V8, but estimate 4 bytes) */
  BOOLEAN: 4,
  /** Symbol overhead */
  SYMBOL: 8,
  /** BigInt base overhead */
  BIGINT_OVERHEAD: 16,
  /** Date object */
  DATE: 48,
  /** RegExp base overhead */
  REGEXP_OVERHEAD: 64,
  /** Function base overhead */
  FUNCTION_OVERHEAD: 64,
  /** ArrayBuffer header */
  ARRAYBUFFER_OVERHEAD: 56,
} as const;

/**
 * Estimates the memory footprint of a JavaScript value in bytes.
 *
 * This function provides a heuristic approximation of memory usage based on
 * V8's typical object layout. It handles:
 * - Primitives (string, number, boolean, null, undefined, symbol, bigint)
 * - Plain objects and arrays
 * - Maps and Sets
 * - Typed arrays and ArrayBuffers
 * - Dates and RegExps
 * - Circular references (via WeakSet tracking)
 *
 * Limitations:
 * - Does not account for V8's hidden class sharing
 * - Function closures are approximated
 * - Prototype chain memory is not included
 * - WeakMaps/WeakSets cannot be iterated (returns base overhead)
 *
 * @param value - The value to estimate size for
 * @returns Estimated size in bytes
 *
 * @example
 * ```typescript
 * estimateObjectSize(42);              // 8 (number)
 * estimateObjectSize("hello");         // 22 (12 overhead + 2*5 chars)
 * estimateObjectSize({ a: 1, b: 2 });  // ~56 (object + 2 properties)
 * estimateObjectSize([1, 2, 3]);       // ~48 (array + 3 elements)
 * ```
 */
export function estimateObjectSize(value: unknown): number {
  const visited = new WeakSet<object>();
  return estimateSizeRecursive(value, visited);
}

/**
 * Internal recursive implementation with cycle detection.
 */
function estimateSizeRecursive(value: unknown, visited: WeakSet<object>): number {
  // Handle null explicitly (typeof null === 'object')
  if (value === null) {
    return SIZES.POINTER;
  }

  // Handle undefined
  if (value === undefined) {
    return 0;
  }

  const type = typeof value;

  // Primitives
  switch (type) {
    case 'boolean':
      return SIZES.BOOLEAN;

    case 'number':
      return SIZES.NUMBER;

    case 'string':
      // V8 uses different string representations (SeqOneByteString, SeqTwoByteString, etc.)
      // Approximate as: overhead + 2 bytes per character (UTF-16)
      return SIZES.STRING_OVERHEAD + (value as string).length * 2;

    case 'symbol':
      return SIZES.SYMBOL;

    case 'bigint':
      // BigInt size depends on the number of digits
      // Base overhead + 8 bytes per 64-bit word needed
      const bigintValue = value as bigint;
      const bitLength = bigintValue === 0n ? 1 : bigintValue.toString(2).replace('-', '').length;
      const words = Math.ceil(bitLength / 64);
      return SIZES.BIGINT_OVERHEAD + words * 8;

    case 'function':
      // Functions are complex - approximate with base overhead
      // We don't recurse into closure scope as it's not easily accessible
      return SIZES.FUNCTION_OVERHEAD;
  }

  // At this point, value is an object
  const obj = value as object;

  // Check for circular references
  if (visited.has(obj)) {
    return SIZES.POINTER; // Just count the reference
  }
  visited.add(obj);

  // Typed arrays and ArrayBuffers
  if (ArrayBuffer.isView(obj)) {
    const view = obj as ArrayBufferView;
    return SIZES.ARRAYBUFFER_OVERHEAD + view.byteLength;
  }

  if (obj instanceof ArrayBuffer) {
    return SIZES.ARRAYBUFFER_OVERHEAD + obj.byteLength;
  }

  // Date
  if (obj instanceof Date) {
    return SIZES.DATE;
  }

  // RegExp
  if (obj instanceof RegExp) {
    return SIZES.REGEXP_OVERHEAD + obj.source.length * 2;
  }

  // Map
  if (obj instanceof Map) {
    let size = SIZES.OBJECT_OVERHEAD + SIZES.POINTER * 2; // Base + internal buckets reference
    for (const [key, val] of obj) {
      size += SIZES.MAP_ENTRY_OVERHEAD;
      size += estimateSizeRecursive(key, visited);
      size += estimateSizeRecursive(val, visited);
    }
    return size;
  }

  // Set
  if (obj instanceof Set) {
    let size = SIZES.OBJECT_OVERHEAD + SIZES.POINTER * 2;
    for (const val of obj) {
      size += SIZES.MAP_ENTRY_OVERHEAD;
      size += estimateSizeRecursive(val, visited);
    }
    return size;
  }

  // WeakMap/WeakSet - cannot iterate, return base overhead
  if (obj instanceof WeakMap || obj instanceof WeakSet) {
    return SIZES.OBJECT_OVERHEAD;
  }

  // Arrays
  if (Array.isArray(obj)) {
    let size = SIZES.ARRAY_OVERHEAD;
    // V8 may use different representations for sparse vs dense arrays
    // For dense arrays, each element slot takes a pointer
    size += obj.length * SIZES.POINTER;
    for (const element of obj) {
      size += estimateSizeRecursive(element, visited);
    }
    return size;
  }

  // Plain objects and class instances
  let size = SIZES.OBJECT_OVERHEAD;

  // Enumerate own properties (including non-enumerable for completeness)
  const propertyNames = Object.getOwnPropertyNames(obj);
  const symbolProperties = Object.getOwnPropertySymbols(obj);

  // Each property descriptor has overhead
  size += (propertyNames.length + symbolProperties.length) * SIZES.POINTER;

  // Estimate string key storage (interned strings are shared, but we approximate)
  for (const key of propertyNames) {
    size += SIZES.STRING_OVERHEAD + key.length * 2;
    size += estimateSizeRecursive((obj as Record<string, unknown>)[key], visited);
  }

  for (const sym of symbolProperties) {
    size += SIZES.SYMBOL;
    size += estimateSizeRecursive((obj as Record<symbol, unknown>)[sym], visited);
  }

  return size;
}

/**
 * Collects current process memory statistics.
 *
 * Wraps Node.js `process.memoryUsage()` into the MemoryStats interface
 * with an added timestamp for temporal tracking.
 *
 * @returns Current memory statistics
 *
 * @example
 * ```typescript
 * const stats = getMemoryStats();
 * console.log(`Heap: ${(stats.heapUsed / 1024 / 1024).toFixed(2)} MB`);
 * ```
 */
export function getMemoryStats(): MemoryStats {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    rss: usage.rss,
    timestamp: Date.now(),
  };
}

/**
 * Formats bytes into a human-readable string.
 *
 * @param bytes - Number of bytes
 * @returns Formatted string (e.g., "1.5 MB", "256 KB")
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const base = 1024;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(base)), units.length - 1);
  const value = bytes / Math.pow(base, exponent);

  return `${value.toFixed(exponent === 0 ? 0 : 2)} ${units[exponent]}`;
}
