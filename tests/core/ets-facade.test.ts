import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Ets } from '../../src/core/ets-facade.js';
import { EtsTable, _resetEtsInstanceCounter } from '../../src/core/ets-table.js';

describe('Ets facade', () => {
  let table: EtsTable<string, unknown>;

  beforeEach(() => {
    _resetEtsInstanceCounter();
  });

  afterEach(async () => {
    if (table) {
      await table.close();
    }
  });

  it('should return an EtsTable instance', () => {
    table = Ets.new<string, number>();
    expect(table).toBeInstanceOf(EtsTable);
  });

  it('should create a set table by default', () => {
    table = Ets.new<string, number>();
    expect(table.type).toBe('set');
  });

  it('should forward name option', () => {
    table = Ets.new<string, number>({ name: 'counters' });
    expect(table.name).toBe('counters');
  });

  it('should forward type option', () => {
    table = Ets.new<string, number>({ type: 'ordered_set' });
    expect(table.type).toBe('ordered_set');
  });

  it('should create a fully functional table', async () => {
    table = Ets.new<string, number>({ name: 'scores', type: 'set' });
    await table.start();

    table.insert('alice', 100);
    table.insert('bob', 85);

    expect(table.lookup('alice')).toBe(100);
    expect(table.lookup('bob')).toBe(85);
    expect(table.size()).toBe(2);
    expect(table.member('alice')).toBe(true);
    expect(table.member('charlie')).toBe(false);
  });

  it('should create an ordered_set with custom comparator', async () => {
    table = Ets.new<string, number>({
      name: 'sorted',
      type: 'ordered_set',
      keyComparator: (a, b) => a.localeCompare(b),
    });
    await table.start();

    table.insert('banana', 2);
    table.insert('apple', 1);
    table.insert('cherry', 3);

    expect(table.keys()).toEqual(['apple', 'banana', 'cherry']);
  });

  it('should create a bag table', async () => {
    table = Ets.new<string, string>({ name: 'tags', type: 'bag' });
    await table.start();

    table.insert('post:1', 'typescript');
    table.insert('post:1', 'elixir');
    table.insert('post:1', 'typescript'); // duplicate, ignored

    expect(table.lookup('post:1')).toEqual(['typescript', 'elixir']);
  });

  it('should create a duplicate_bag table', async () => {
    table = Ets.new<string, string>({ name: 'logs', type: 'duplicate_bag' });
    await table.start();

    table.insert('event', 'click');
    table.insert('event', 'click'); // duplicate allowed

    expect(table.lookup('event')).toEqual(['click', 'click']);
  });

  it('should create independent table instances', async () => {
    const t1 = Ets.new<string, number>({ name: 'a' });
    const t2 = Ets.new<string, number>({ name: 'b' });
    await t1.start();
    await t2.start();

    t1.insert('x', 1);
    t2.insert('x', 2);

    expect(t1.lookup('x')).toBe(1);
    expect(t2.lookup('x')).toBe(2);

    await t1.close();
    await t2.close();
    table = undefined!;
  });

  it('should auto-generate unique names when not specified', () => {
    const t1 = Ets.new<string, number>();
    const t2 = Ets.new<string, number>();

    expect(t1.name).not.toBe(t2.name);

    table = t1;
    void t2.close();
  });
});
