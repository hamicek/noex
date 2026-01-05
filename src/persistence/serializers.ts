/**
 * State serialization utilities.
 *
 * Provides JSON-based serialization with support for JavaScript
 * built-in types that are not natively supported by JSON.
 */

import type { StateSerializer } from './types.js';
import { DeserializationError, SerializationError } from './errors.js';

/** Internal tag for identifying wrapped types */
const TYPE_TAG = '__noex_type__' as const;
/** Internal tag for the wrapped value */
const VALUE_TAG = '__noex_value__' as const;

/** Supported special type identifiers */
type SpecialType = 'Date' | 'Map' | 'Set' | 'BigInt' | 'undefined';

/** Structure for wrapped special values */
interface WrappedValue {
  readonly [TYPE_TAG]: SpecialType;
  readonly [VALUE_TAG]: unknown;
}

/**
 * Checks if a value is a wrapped special type.
 */
function isWrappedValue(value: unknown): value is WrappedValue {
  return (
    value !== null &&
    typeof value === 'object' &&
    TYPE_TAG in value &&
    VALUE_TAG in value
  );
}

/**
 * Recursively prepares a value for JSON serialization by wrapping special types.
 * This is called BEFORE JSON.stringify to handle Date.toJSON() behavior.
 */
function prepare(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  // Handle undefined
  if (value === undefined) {
    return { [TYPE_TAG]: 'undefined', [VALUE_TAG]: null };
  }

  // Handle null
  if (value === null) {
    return null;
  }

  // Handle primitives
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  // Handle BigInt
  if (typeof value === 'bigint') {
    return { [TYPE_TAG]: 'BigInt', [VALUE_TAG]: value.toString() };
  }

  // Handle Date (BEFORE it gets converted by toJSON)
  if (value instanceof Date) {
    return { [TYPE_TAG]: 'Date', [VALUE_TAG]: value.toISOString() };
  }

  // Handle Map
  if (value instanceof Map) {
    const entries: [unknown, unknown][] = [];
    for (const [k, v] of value) {
      entries.push([prepare(k, seen), prepare(v, seen)]);
    }
    return { [TYPE_TAG]: 'Map', [VALUE_TAG]: entries };
  }

  // Handle Set
  if (value instanceof Set) {
    const values: unknown[] = [];
    for (const v of value) {
      values.push(prepare(v, seen));
    }
    return { [TYPE_TAG]: 'Set', [VALUE_TAG]: values };
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map((item) => prepare(item, seen));
  }

  // Handle objects - check for circular references
  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new Error('Circular reference detected');
    }
    seen.add(value);

    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      result[key] = prepare((value as Record<string, unknown>)[key], seen);
    }
    return result;
  }

  // Functions and symbols are not supported
  return undefined;
}

/**
 * Recursively restores special types from parsed JSON.
 */
function restore(value: unknown): unknown {
  // Handle null and primitives
  if (value === null || typeof value !== 'object') {
    return value;
  }

  // Check for wrapped value
  if (isWrappedValue(value)) {
    const typeTag = value[TYPE_TAG];
    const wrappedValue = value[VALUE_TAG];

    switch (typeTag) {
      case 'undefined':
        return undefined;

      case 'Date':
        return new Date(wrappedValue as string);

      case 'Map': {
        const entries = (wrappedValue as [unknown, unknown][]).map(
          ([k, v]) => [restore(k), restore(v)] as [unknown, unknown]
        );
        return new Map(entries);
      }

      case 'Set': {
        const values = (wrappedValue as unknown[]).map((v) => restore(v));
        return new Set(values);
      }

      case 'BigInt':
        return BigInt(wrappedValue as string);

      default: {
        // Exhaustiveness check
        const _exhaustive: never = typeTag;
        return value;
      }
    }
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map((item) => restore(item));
  }

  // Handle plain objects
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    result[key] = restore((value as Record<string, unknown>)[key]);
  }
  return result;
}

/**
 * Default state serializer using JSON with extended type support.
 *
 * Supports serialization of:
 * - All JSON-native types (string, number, boolean, null, object, array)
 * - Date (preserved as ISO string, restored as Date object)
 * - Map (preserved as entries array, restored as Map)
 * - Set (preserved as values array, restored as Set)
 * - BigInt (preserved as string, restored as BigInt)
 * - undefined (preserved and restored correctly)
 *
 * @example
 * ```typescript
 * const state = {
 *   users: new Map([['alice', { name: 'Alice' }]]),
 *   createdAt: new Date(),
 *   bigNumber: 9007199254740993n,
 * };
 *
 * const json = defaultSerializer.serialize(state);
 * const restored = defaultSerializer.deserialize(json);
 * // restored.users is a Map
 * // restored.createdAt is a Date
 * // restored.bigNumber is a BigInt
 * ```
 */
export const defaultSerializer: StateSerializer = {
  serialize(value: unknown): string {
    try {
      const prepared = prepare(value);
      return JSON.stringify(prepared);
    } catch (error) {
      throw new SerializationError(
        `Failed to serialize value: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  },

  deserialize<T>(data: string): T {
    try {
      const parsed = JSON.parse(data) as unknown;
      return restore(parsed) as T;
    } catch (error) {
      throw new DeserializationError(
        `Failed to deserialize data: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  },
};

/**
 * Creates a custom serializer with pretty-printing enabled.
 *
 * Useful for debugging or human-readable storage formats.
 *
 * @param indent - Number of spaces for indentation (default: 2)
 */
export function createPrettySerializer(indent: number = 2): StateSerializer {
  return {
    serialize(value: unknown): string {
      try {
        const prepared = prepare(value);
        return JSON.stringify(prepared, null, indent);
      } catch (error) {
        throw new SerializationError(
          `Failed to serialize value: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error : undefined
        );
      }
    },

    deserialize<T>(data: string): T {
      try {
        const parsed = JSON.parse(data) as unknown;
        return restore(parsed) as T;
      } catch (error) {
        throw new DeserializationError(
          `Failed to deserialize data: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error : undefined
        );
      }
    },
  };
}
