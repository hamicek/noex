/**
 * Ets — factory facade for creating ETS tables.
 *
 * Provides a clean namespace for instantiating typed in-memory key-value tables
 * without directly importing the EtsTable class.
 *
 * @example
 * ```typescript
 * const users = Ets.new<string, User>({ name: 'users', type: 'set' });
 * await users.start();
 * users.insert('u1', { name: 'Alice', age: 30 });
 * ```
 */

import type { EtsOptions } from './ets-types.js';
import { EtsTable } from './ets-table.js';

export const Ets = {
  /**
   * Create a new ETS table with the given options.
   *
   * The table must be started with `start()` before use.
   * Supports four table types: set, ordered_set, bag, and duplicate_bag.
   *
   * @typeParam K - Key type
   * @typeParam V - Value type
   * @param options - Table configuration (type, name, persistence, etc.)
   * @returns A new EtsTable instance
   */
  new<K, V>(options?: EtsOptions<K, V>): EtsTable<K, V> {
    return new EtsTable<K, V>(options);
  },
} as const;
