import { describe, it, expect, afterEach } from 'vitest';
import {
  Ets,
  EtsTable,
  EtsKeyNotFoundError,
  EtsCounterTypeError,
} from '../../src/index.js';
import type {
  EtsTableType,
  EtsOptions,
  EtsPersistenceConfig,
  EtsEntry,
  EtsPredicate,
  EtsMatchResult,
  EtsInfo,
} from '../../src/index.js';

describe('ETS public exports', () => {
  let table: EtsTable<string, number> | undefined;

  afterEach(async () => {
    if (table) {
      await table.close();
      table = undefined;
    }
  });

  it('should export Ets facade with new() factory', () => {
    expect(Ets).toBeDefined();
    expect(typeof Ets.new).toBe('function');
  });

  it('should export EtsTable class', () => {
    expect(EtsTable).toBeDefined();
    table = new EtsTable<string, number>({ name: 'direct-test' });
    expect(table).toBeInstanceOf(EtsTable);
  });

  it('should export EtsKeyNotFoundError', () => {
    expect(EtsKeyNotFoundError).toBeDefined();
    const err = new EtsKeyNotFoundError('t', 'k');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EtsKeyNotFoundError');
    expect(err.tableName).toBe('t');
    expect(err.key).toBe('k');
  });

  it('should export EtsCounterTypeError', () => {
    expect(EtsCounterTypeError).toBeDefined();
    const err = new EtsCounterTypeError('t', 'k');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EtsCounterTypeError');
    expect(err.tableName).toBe('t');
    expect(err.key).toBe('k');
  });

  it('should create a working table via Ets.new() from public API', async () => {
    const opts: EtsOptions<string, number> = {
      name: 'export-test',
      type: 'ordered_set' satisfies EtsTableType,
    };
    table = Ets.new<string, number>(opts);
    await table.start();

    table.insert('b', 2);
    table.insert('a', 1);
    table.insert('c', 3);

    expect(table.lookup('a')).toBe(1);
    expect(table.size()).toBe(3);
    expect(table.keys()).toEqual(['a', 'b', 'c']);

    const info: EtsInfo = table.info();
    expect(info.name).toBe('export-test');
    expect(info.type).toBe('ordered_set');
    expect(info.size).toBe(3);
  });

  it('should support select with EtsPredicate type', async () => {
    table = Ets.new<string, number>({ name: 'pred-test' });
    await table.start();

    table.insert('x', 10);
    table.insert('y', 20);
    table.insert('z', 5);

    const predicate: EtsPredicate<string, number> = (_k, v) => v > 8;
    const results: EtsMatchResult<string, number>[] = table.select(predicate);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.key).sort()).toEqual(['x', 'y']);
  });

  it('should satisfy EtsEntry interface shape from toArray', async () => {
    table = Ets.new<string, number>({ name: 'entry-test' });
    await table.start();
    table.insert('k', 42);

    const entries = table.toArray();
    expect(entries).toHaveLength(1);

    const [key, value] = entries[0]!;
    const _entry: EtsEntry<string, number> = {
      key,
      value,
      insertedAt: Date.now(),
    };
    expect(_entry.key).toBe('k');
    expect(_entry.value).toBe(42);
  });

  it('should satisfy EtsPersistenceConfig type', () => {
    const config: EtsPersistenceConfig = {
      adapter: {
        load: async () => null,
        save: async () => {},
        delete: async () => {},
      },
      debounceMs: 50,
      restoreOnStart: true,
      persistOnChange: true,
      persistOnShutdown: true,
    };
    expect(config.adapter).toBeDefined();
    expect(config.debounceMs).toBe(50);
  });
});
