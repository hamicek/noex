/**
 * Comprehensive tests for RegistryInstance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  GenServer,
  type GenServerBehavior,
  type GenServerRef,
} from '../../src/index.js';
import {
  RegistryInstance,
  AlreadyRegisteredKeyError,
  KeyNotFoundError,
  DuplicateKeyLookupError,
  DispatchNotSupportedError,
  DuplicateRegistrationError,
  _resetInstanceCounter,
} from '../../src/core/registry-instance.js';
import { Registry } from '../../src/core/registry.js';

function createCounterBehavior(): GenServerBehavior<
  number,
  'get',
  'inc' | { cast: unknown },
  number
> {
  return {
    init: () => 0,
    handleCall: (msg, state) => {
      if (msg === 'get') return [state, state];
      throw new Error(`Unknown call: ${String(msg)}`);
    },
    handleCast: (msg, state) => {
      if (msg === 'inc') return state + 1;
      return state;
    },
  };
}

describe('RegistryInstance', () => {
  let registry: RegistryInstance;
  const refs: GenServerRef[] = [];

  beforeEach(() => {
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
    Registry._clearLifecycleHandler();
    Registry._clear();
    _resetInstanceCounter();
  });

  afterEach(async () => {
    if (registry) {
      await registry.close();
    }
    for (const ref of refs) {
      if (GenServer.isRunning(ref)) {
        await GenServer.stop(ref);
      }
    }
    refs.length = 0;
    GenServer._clearLifecycleHandlers();
    Registry._clearLifecycleHandler();
    Registry._clear();
  });

  async function startRef(): Promise<GenServerRef<number, 'get', 'inc' | { cast: unknown }, number>> {
    const ref = await GenServer.start(createCounterBehavior());
    refs.push(ref);
    return ref;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  describe('lifecycle', () => {
    it('creates instance with default options', () => {
      registry = new RegistryInstance();
      expect(registry.name).toBe('registry-1');
      expect(registry.keyMode).toBe('unique');
    });

    it('creates instance with custom name and key mode', () => {
      registry = new RegistryInstance({ name: 'my-registry', keys: 'duplicate' });
      expect(registry.name).toBe('my-registry');
      expect(registry.keyMode).toBe('duplicate');
    });

    it('start() is idempotent', async () => {
      registry = new RegistryInstance({ name: 'test' });
      await registry.start();
      await registry.start(); // should not throw
    });

    it('close() is idempotent', async () => {
      registry = new RegistryInstance({ name: 'test' });
      await registry.start();
      await registry.close();
      await registry.close(); // should not throw
    });

    it('close() clears all entries', async () => {
      registry = new RegistryInstance({ name: 'test' });
      await registry.start();

      const ref = await startRef();
      registry.register('key1', ref);
      expect(registry.count()).toBe(1);

      await registry.close();
      expect(registry.count()).toBe(0);
    });

    it('close() on never-started instance does nothing', async () => {
      registry = new RegistryInstance({ name: 'test' });
      await registry.close(); // should not throw
    });
  });

  // ===========================================================================
  // Unique Mode — register/lookup/unregister
  // ===========================================================================

  describe('unique mode', () => {
    beforeEach(async () => {
      registry = new RegistryInstance({ name: 'unique-test', keys: 'unique' });
      await registry.start();
    });

    describe('register()', () => {
      it('registers a ref under a key', async () => {
        const ref = await startRef();
        registry.register('svc', ref);
        expect(registry.isRegistered('svc')).toBe(true);
      });

      it('registers with metadata', async () => {
        const reg = new RegistryInstance<{ role: string }>({ name: 'meta-test' });
        await reg.start();

        const ref = await startRef();
        reg.register('svc', ref, { role: 'worker' });

        const entry = reg.lookup('svc');
        expect(entry.metadata).toEqual({ role: 'worker' });
        await reg.close();
      });

      it('throws AlreadyRegisteredKeyError for duplicate key', async () => {
        const ref1 = await startRef();
        const ref2 = await startRef();

        registry.register('key', ref1);
        expect(() => registry.register('key', ref2)).toThrow(AlreadyRegisteredKeyError);
        expect(() => registry.register('key', ref2)).toThrow(
          "Key 'key' is already registered in registry 'unique-test'.",
        );
      });

      it('allows the same ref under different keys', async () => {
        const ref = await startRef();
        registry.register('a', ref);
        registry.register('b', ref);

        // Note: in unique mode, refToKey maps only the last key
        // Both should be registered
        expect(registry.isRegistered('a')).toBe(true);
        expect(registry.isRegistered('b')).toBe(true);
      });
    });

    describe('lookup()', () => {
      it('returns the entry for a registered key', async () => {
        const ref = await startRef();
        registry.register('svc', ref);

        const entry = registry.lookup('svc');
        expect(entry.ref.id).toBe(ref.id);
        expect(entry.registeredAt).toBeGreaterThan(0);
      });

      it('throws KeyNotFoundError for unknown key', () => {
        expect(() => registry.lookup('missing')).toThrow(KeyNotFoundError);
        expect(() => registry.lookup('missing')).toThrow(
          "Key 'missing' is not registered in registry 'unique-test'.",
        );
      });
    });

    describe('whereis()', () => {
      it('returns the entry if registered', async () => {
        const ref = await startRef();
        registry.register('svc', ref);

        const entry = registry.whereis('svc');
        expect(entry).toBeDefined();
        expect(entry!.ref.id).toBe(ref.id);
      });

      it('returns undefined for unknown key', () => {
        expect(registry.whereis('missing')).toBeUndefined();
      });
    });

    describe('lookupAll()', () => {
      it('returns single-element array for registered key', async () => {
        const ref = await startRef();
        registry.register('svc', ref);

        const entries = registry.lookupAll('svc');
        expect(entries).toHaveLength(1);
        expect(entries[0].ref.id).toBe(ref.id);
      });

      it('returns empty array for unknown key', () => {
        expect(registry.lookupAll('missing')).toHaveLength(0);
      });
    });

    describe('unregister()', () => {
      it('removes the key mapping', async () => {
        const ref = await startRef();
        registry.register('svc', ref);
        registry.unregister('svc');

        expect(registry.isRegistered('svc')).toBe(false);
      });

      it('is idempotent for unknown keys', () => {
        expect(() => registry.unregister('missing')).not.toThrow();
      });

      it('allows re-registration after unregister', async () => {
        const ref1 = await startRef();
        const ref2 = await startRef();

        registry.register('svc', ref1);
        registry.unregister('svc');
        registry.register('svc', ref2);

        expect(registry.lookup('svc').ref.id).toBe(ref2.id);
      });
    });

    describe('unregisterMatch()', () => {
      it('removes the entry if ref matches', async () => {
        const ref = await startRef();
        registry.register('svc', ref);
        registry.unregisterMatch('svc', ref);

        expect(registry.isRegistered('svc')).toBe(false);
      });

      it('does nothing if ref does not match', async () => {
        const ref1 = await startRef();
        const ref2 = await startRef();

        registry.register('svc', ref1);
        registry.unregisterMatch('svc', ref2);

        expect(registry.isRegistered('svc')).toBe(true);
      });

      it('does nothing for unknown key', async () => {
        const ref = await startRef();
        expect(() => registry.unregisterMatch('missing', ref)).not.toThrow();
      });
    });

    describe('utility methods', () => {
      it('getKeys() returns all registered keys', async () => {
        const ref1 = await startRef();
        const ref2 = await startRef();

        registry.register('a', ref1);
        registry.register('b', ref2);

        const keys = registry.getKeys();
        expect(keys).toHaveLength(2);
        expect(keys).toContain('a');
        expect(keys).toContain('b');
      });

      it('count() returns total entries', async () => {
        expect(registry.count()).toBe(0);

        const ref1 = await startRef();
        registry.register('a', ref1);
        expect(registry.count()).toBe(1);

        const ref2 = await startRef();
        registry.register('b', ref2);
        expect(registry.count()).toBe(2);
      });

      it('countForKey() returns 0 or 1 in unique mode', async () => {
        expect(registry.countForKey('a')).toBe(0);

        const ref = await startRef();
        registry.register('a', ref);
        expect(registry.countForKey('a')).toBe(1);
      });
    });
  });

  // ===========================================================================
  // Duplicate Mode
  // ===========================================================================

  describe('duplicate mode', () => {
    beforeEach(async () => {
      registry = new RegistryInstance({ name: 'dup-test', keys: 'duplicate' });
      await registry.start();
    });

    describe('register()', () => {
      it('allows multiple refs under the same key', async () => {
        const ref1 = await startRef();
        const ref2 = await startRef();
        const ref3 = await startRef();

        registry.register('topic', ref1);
        registry.register('topic', ref2);
        registry.register('topic', ref3);

        expect(registry.countForKey('topic')).toBe(3);
      });

      it('throws DuplicateRegistrationError for same ref+key', async () => {
        const ref = await startRef();

        registry.register('topic', ref);
        expect(() => registry.register('topic', ref)).toThrow(DuplicateRegistrationError);
        expect(() => registry.register('topic', ref)).toThrow(
          `Ref '${ref.id}' is already registered under key 'topic' in registry 'dup-test'.`,
        );
      });

      it('allows same ref under different keys', async () => {
        const ref = await startRef();

        registry.register('topic-a', ref);
        registry.register('topic-b', ref);

        expect(registry.countForKey('topic-a')).toBe(1);
        expect(registry.countForKey('topic-b')).toBe(1);
      });
    });

    describe('lookupAll()', () => {
      it('returns all entries for a key', async () => {
        const ref1 = await startRef();
        const ref2 = await startRef();

        registry.register('topic', ref1);
        registry.register('topic', ref2);

        const entries = registry.lookupAll('topic');
        expect(entries).toHaveLength(2);
        expect(entries.map((e) => e.ref.id)).toContain(ref1.id);
        expect(entries.map((e) => e.ref.id)).toContain(ref2.id);
      });

      it('returns empty array for unknown key', () => {
        expect(registry.lookupAll('missing')).toHaveLength(0);
      });
    });

    describe('lookup() throws in duplicate mode', () => {
      it('throws DuplicateKeyLookupError', async () => {
        const ref = await startRef();
        registry.register('topic', ref);

        expect(() => registry.lookup('topic')).toThrow(DuplicateKeyLookupError);
        expect(() => registry.lookup('topic')).toThrow(
          "Cannot use lookup() on duplicate-key registry 'dup-test' for key 'topic'. Use lookupAll() instead.",
        );
      });
    });

    describe('whereis() in duplicate mode', () => {
      it('returns first entry', async () => {
        const ref1 = await startRef();
        const ref2 = await startRef();

        registry.register('topic', ref1);
        registry.register('topic', ref2);

        const entry = registry.whereis('topic');
        expect(entry).toBeDefined();
        expect(entry!.ref.id).toBe(ref1.id);
      });

      it('returns undefined for unknown key', () => {
        expect(registry.whereis('missing')).toBeUndefined();
      });
    });

    describe('unregister()', () => {
      it('removes all entries for a key', async () => {
        const ref1 = await startRef();
        const ref2 = await startRef();

        registry.register('topic', ref1);
        registry.register('topic', ref2);

        registry.unregister('topic');
        expect(registry.isRegistered('topic')).toBe(false);
        expect(registry.countForKey('topic')).toBe(0);
      });

      it('cleans up refToKeys mapping', async () => {
        const ref = await startRef();

        registry.register('a', ref);
        registry.register('b', ref);
        registry.unregister('a');

        // ref should still be tracked for key 'b'
        expect(registry.isRegistered('b')).toBe(true);
        expect(registry.countForKey('b')).toBe(1);
      });
    });

    describe('unregisterMatch()', () => {
      it('removes only the specified ref from a key', async () => {
        const ref1 = await startRef();
        const ref2 = await startRef();
        const ref3 = await startRef();

        registry.register('topic', ref1);
        registry.register('topic', ref2);
        registry.register('topic', ref3);

        registry.unregisterMatch('topic', ref2);

        const entries = registry.lookupAll('topic');
        expect(entries).toHaveLength(2);
        expect(entries.map((e) => e.ref.id)).not.toContain(ref2.id);
      });

      it('removes key entry if last ref is removed', async () => {
        const ref = await startRef();
        registry.register('topic', ref);
        registry.unregisterMatch('topic', ref);

        expect(registry.isRegistered('topic')).toBe(false);
      });

      it('does nothing if ref not found under key', async () => {
        const ref1 = await startRef();
        const ref2 = await startRef();

        registry.register('topic', ref1);
        registry.unregisterMatch('topic', ref2);

        expect(registry.countForKey('topic')).toBe(1);
      });
    });

    describe('dispatch()', () => {
      it('casts message to all entries by default', async () => {
        const ref1 = await startRef();
        const ref2 = await startRef();

        registry.register('topic', ref1);
        registry.register('topic', ref2);

        registry.dispatch('topic', 'inc');

        await new Promise((r) => setTimeout(r, 50));

        const val1 = await GenServer.call(ref1, 'get');
        const val2 = await GenServer.call(ref2, 'get');
        expect(val1).toBe(1);
        expect(val2).toBe(1);
      });

      it('uses custom dispatch function when provided', async () => {
        const ref1 = await startRef();
        const ref2 = await startRef();

        registry.register('topic', ref1);
        registry.register('topic', ref2);

        const dispatched: string[] = [];
        registry.dispatch('topic', 'hello', (entries, msg) => {
          for (const entry of entries) {
            dispatched.push(`${entry.ref.id}:${msg}`);
          }
        });

        expect(dispatched).toHaveLength(2);
        expect(dispatched[0]).toBe(`${ref1.id}:hello`);
        expect(dispatched[1]).toBe(`${ref2.id}:hello`);
      });

      it('does nothing for unregistered key', () => {
        expect(() => registry.dispatch('missing', 'msg')).not.toThrow();
      });
    });

    describe('dispatch() throws in unique mode', () => {
      it('throws DispatchNotSupportedError', async () => {
        const uniqueReg = new RegistryInstance({ name: 'unique-dispatch', keys: 'unique' });
        await uniqueReg.start();

        expect(() => uniqueReg.dispatch('key', 'msg')).toThrow(DispatchNotSupportedError);
        expect(() => uniqueReg.dispatch('key', 'msg')).toThrow(
          "dispatch() is not supported on unique-key registry 'unique-dispatch'. Use a duplicate-key registry instead.",
        );

        await uniqueReg.close();
      });
    });

    describe('utility methods', () => {
      it('count() returns total entries across all keys', async () => {
        const ref1 = await startRef();
        const ref2 = await startRef();
        const ref3 = await startRef();

        registry.register('a', ref1);
        registry.register('a', ref2);
        registry.register('b', ref3);

        expect(registry.count()).toBe(3);
      });

      it('getKeys() returns keys with entries', async () => {
        const ref1 = await startRef();
        const ref2 = await startRef();

        registry.register('x', ref1);
        registry.register('y', ref2);

        const keys = registry.getKeys();
        expect(keys).toContain('x');
        expect(keys).toContain('y');
      });
    });
  });

  // ===========================================================================
  // Metadata
  // ===========================================================================

  describe('metadata', () => {
    it('getMetadata() returns metadata for unique mode', async () => {
      const reg = new RegistryInstance<{ priority: number }>({ name: 'meta' });
      await reg.start();

      const ref = await startRef();
      reg.register('svc', ref, { priority: 5 });

      expect(reg.getMetadata('svc')).toEqual({ priority: 5 });
      await reg.close();
    });

    it('getMetadata() returns undefined for unknown key', async () => {
      registry = new RegistryInstance({ name: 'meta' });
      await registry.start();
      expect(registry.getMetadata('missing')).toBeUndefined();
    });

    it('getMetadata() returns first entry metadata in duplicate mode', async () => {
      const reg = new RegistryInstance<{ idx: number }>({
        name: 'meta-dup',
        keys: 'duplicate',
      });
      await reg.start();

      const ref1 = await startRef();
      const ref2 = await startRef();

      reg.register('key', ref1, { idx: 1 });
      reg.register('key', ref2, { idx: 2 });

      expect(reg.getMetadata('key')).toEqual({ idx: 1 });
      await reg.close();
    });

    it('updateMetadata() updates entry in unique mode', async () => {
      const reg = new RegistryInstance<{ count: number }>({ name: 'meta-update' });
      await reg.start();

      const ref = await startRef();
      reg.register('svc', ref, { count: 0 });

      const updated = reg.updateMetadata('svc', (m) => ({ count: m.count + 1 }));
      expect(updated).toBe(true);
      expect(reg.getMetadata('svc')).toEqual({ count: 1 });
      await reg.close();
    });

    it('updateMetadata() updates all entries in duplicate mode', async () => {
      const reg = new RegistryInstance<{ seen: boolean }>({
        name: 'meta-upd-dup',
        keys: 'duplicate',
      });
      await reg.start();

      const ref1 = await startRef();
      const ref2 = await startRef();

      reg.register('topic', ref1, { seen: false });
      reg.register('topic', ref2, { seen: false });

      const updated = reg.updateMetadata('topic', () => ({ seen: true }));
      expect(updated).toBe(true);

      const entries = reg.lookupAll('topic');
      expect(entries[0].metadata).toEqual({ seen: true });
      expect(entries[1].metadata).toEqual({ seen: true });
      await reg.close();
    });

    it('updateMetadata() returns false for unknown key', async () => {
      registry = new RegistryInstance({ name: 'meta-miss' });
      await registry.start();
      expect(registry.updateMetadata('missing', (m) => m)).toBe(false);
    });
  });

  // ===========================================================================
  // Select & Match
  // ===========================================================================

  describe('select()', () => {
    it('filters entries by predicate in unique mode', async () => {
      const reg = new RegistryInstance<{ type: string }>({ name: 'sel' });
      await reg.start();

      const ref1 = await startRef();
      const ref2 = await startRef();
      const ref3 = await startRef();

      reg.register('svc-a', ref1, { type: 'worker' });
      reg.register('svc-b', ref2, { type: 'manager' });
      reg.register('svc-c', ref3, { type: 'worker' });

      const workers = reg.select((_key, entry) => entry.metadata.type === 'worker');
      expect(workers).toHaveLength(2);
      expect(workers.map((m) => m.key).sort()).toEqual(['svc-a', 'svc-c']);
      await reg.close();
    });

    it('filters entries by predicate in duplicate mode', async () => {
      const reg = new RegistryInstance<{ priority: number }>({
        name: 'sel-dup',
        keys: 'duplicate',
      });
      await reg.start();

      const ref1 = await startRef();
      const ref2 = await startRef();
      const ref3 = await startRef();

      reg.register('events', ref1, { priority: 1 });
      reg.register('events', ref2, { priority: 10 });
      reg.register('logs', ref3, { priority: 5 });

      const highPriority = reg.select((_key, entry) => entry.metadata.priority >= 5);
      expect(highPriority).toHaveLength(2);
      await reg.close();
    });

    it('can filter by key', async () => {
      registry = new RegistryInstance({ name: 'sel-key' });
      await registry.start();

      const ref1 = await startRef();
      const ref2 = await startRef();

      registry.register('prefix:a', ref1);
      registry.register('prefix:b', ref2);

      const matches = registry.select((key) => key.startsWith('prefix:'));
      expect(matches).toHaveLength(2);
    });

    it('returns empty array when nothing matches', async () => {
      registry = new RegistryInstance({ name: 'sel-empty' });
      await registry.start();

      const ref = await startRef();
      registry.register('svc', ref);

      const matches = registry.select(() => false);
      expect(matches).toHaveLength(0);
    });
  });

  describe('match()', () => {
    beforeEach(async () => {
      registry = new RegistryInstance({ name: 'match-test' });
      await registry.start();
    });

    it('matches with * wildcard', async () => {
      const ref1 = await startRef();
      const ref2 = await startRef();
      const ref3 = await startRef();

      registry.register('user:alice', ref1);
      registry.register('user:bob', ref2);
      registry.register('order:123', ref3);

      const userMatches = registry.match('user:*');
      expect(userMatches).toHaveLength(2);
      expect(userMatches.map((m) => m.key).sort()).toEqual(['user:alice', 'user:bob']);
    });

    it('matches with ? wildcard', async () => {
      const ref1 = await startRef();
      const ref2 = await startRef();
      const ref3 = await startRef();

      registry.register('v1', ref1);
      registry.register('v2', ref2);
      registry.register('v10', ref3);

      const matches = registry.match('v?');
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.key).sort()).toEqual(['v1', 'v2']);
    });

    it('matches with ** wildcard across separators', async () => {
      const ref1 = await startRef();
      const ref2 = await startRef();
      const ref3 = await startRef();

      registry.register('a/b/c', ref1);
      registry.register('a/x', ref2);
      registry.register('b/y', ref3);

      const matches = registry.match('a/**');
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.key).sort()).toEqual(['a/b/c', 'a/x']);
    });

    it('applies value predicate after key match', async () => {
      const reg = new RegistryInstance<{ active: boolean }>({ name: 'match-pred' });
      await reg.start();

      const ref1 = await startRef();
      const ref2 = await startRef();

      reg.register('svc:auth', ref1, { active: true });
      reg.register('svc:cache', ref2, { active: false });

      const matches = reg.match('svc:*', (entry) => entry.metadata.active);
      expect(matches).toHaveLength(1);
      expect(matches[0].key).toBe('svc:auth');
      await reg.close();
    });

    it('matches exact string without wildcards', async () => {
      const ref1 = await startRef();
      const ref2 = await startRef();

      registry.register('exact', ref1);
      registry.register('other', ref2);

      const matches = registry.match('exact');
      expect(matches).toHaveLength(1);
      expect(matches[0].key).toBe('exact');
    });

    it('escapes regex special characters', async () => {
      const ref = await startRef();
      registry.register('test.key[0]', ref);

      const matches = registry.match('test.key[0]');
      expect(matches).toHaveLength(1);
    });

    it('works in duplicate mode', async () => {
      const reg = new RegistryInstance({ name: 'match-dup', keys: 'duplicate' });
      await reg.start();

      const ref1 = await startRef();
      const ref2 = await startRef();
      const ref3 = await startRef();

      reg.register('topic:news', ref1);
      reg.register('topic:news', ref2);
      reg.register('topic:sports', ref3);

      const matches = reg.match('topic:*');
      expect(matches).toHaveLength(3);
      await reg.close();
    });
  });

  // ===========================================================================
  // Automatic Cleanup on Termination
  // ===========================================================================

  describe('auto-cleanup on process termination', () => {
    it('removes entry when process is stopped (unique mode)', async () => {
      registry = new RegistryInstance({ name: 'cleanup-unique' });
      await registry.start();

      const ref = await startRef();
      registry.register('svc', ref);

      expect(registry.isRegistered('svc')).toBe(true);

      await GenServer.stop(ref);
      await new Promise((r) => setTimeout(r, 20));

      expect(registry.isRegistered('svc')).toBe(false);
    });

    it('removes entries when process is stopped (duplicate mode)', async () => {
      registry = new RegistryInstance({ name: 'cleanup-dup', keys: 'duplicate' });
      await registry.start();

      const ref1 = await startRef();
      const ref2 = await startRef();

      registry.register('topic', ref1);
      registry.register('topic', ref2);
      registry.register('other', ref1);

      expect(registry.count()).toBe(3);

      await GenServer.stop(ref1);
      await new Promise((r) => setTimeout(r, 20));

      // ref1 entries should be gone
      expect(registry.count()).toBe(1);
      expect(registry.countForKey('topic')).toBe(1);
      expect(registry.isRegistered('other')).toBe(false);
    });

    it('does not affect other entries when one process terminates', async () => {
      registry = new RegistryInstance({ name: 'cleanup-partial' });
      await registry.start();

      const ref1 = await startRef();
      const ref2 = await startRef();

      registry.register('a', ref1);
      registry.register('b', ref2);

      await GenServer.stop(ref1);
      await new Promise((r) => setTimeout(r, 20));

      expect(registry.isRegistered('a')).toBe(false);
      expect(registry.isRegistered('b')).toBe(true);
    });

    it('handles force termination', async () => {
      registry = new RegistryInstance({ name: 'cleanup-force' });
      await registry.start();

      const ref = await startRef();
      registry.register('svc', ref);

      GenServer._forceTerminate(ref, 'shutdown');
      await new Promise((r) => setTimeout(r, 20));

      expect(registry.isRegistered('svc')).toBe(false);
    });
  });

  // ===========================================================================
  // Multiple Instances — Isolation
  // ===========================================================================

  describe('instance isolation', () => {
    it('multiple registries maintain independent state', async () => {
      const reg1 = new RegistryInstance({ name: 'iso-1' });
      const reg2 = new RegistryInstance({ name: 'iso-2' });
      await reg1.start();
      await reg2.start();

      const ref1 = await startRef();
      const ref2 = await startRef();

      reg1.register('key', ref1);
      reg2.register('key', ref2);

      expect(reg1.lookup('key').ref.id).toBe(ref1.id);
      expect(reg2.lookup('key').ref.id).toBe(ref2.id);
      expect(reg1.count()).toBe(1);
      expect(reg2.count()).toBe(1);

      await reg1.close();
      await reg2.close();
      registry = undefined!;
    });

    it('closing one registry does not affect another', async () => {
      const reg1 = new RegistryInstance({ name: 'close-1' });
      const reg2 = new RegistryInstance({ name: 'close-2' });
      await reg1.start();
      await reg2.start();

      const ref = await startRef();
      reg1.register('shared-key', ref);
      reg2.register('shared-key', ref);

      await reg1.close();

      expect(reg2.isRegistered('shared-key')).toBe(true);
      await reg2.close();
      registry = undefined!;
    });

    it('termination cleanup works across multiple registries', async () => {
      const reg1 = new RegistryInstance({ name: 'multi-1' });
      const reg2 = new RegistryInstance({ name: 'multi-2' });
      await reg1.start();
      await reg2.start();

      const ref = await startRef();
      reg1.register('key-in-1', ref);
      reg2.register('key-in-2', ref);

      await GenServer.stop(ref);
      await new Promise((r) => setTimeout(r, 20));

      expect(reg1.isRegistered('key-in-1')).toBe(false);
      expect(reg2.isRegistered('key-in-2')).toBe(false);

      await reg1.close();
      await reg2.close();
      registry = undefined!;
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    beforeEach(async () => {
      registry = new RegistryInstance({ name: 'edge' });
      await registry.start();
    });

    it('handles empty string keys', async () => {
      const ref = await startRef();
      registry.register('', ref);
      expect(registry.isRegistered('')).toBe(true);
      expect(registry.lookup('').ref.id).toBe(ref.id);
    });

    it('handles special characters in keys', async () => {
      const ref = await startRef();
      const key = 'ns:v1.0/instance#1@host';
      registry.register(key, ref);
      expect(registry.isRegistered(key)).toBe(true);
    });

    it('handles unicode keys', async () => {
      const ref = await startRef();
      const key = 'サービス/кластер';
      registry.register(key, ref);
      expect(registry.lookup(key).ref.id).toBe(ref.id);
    });

    it('rapid register/unregister maintains consistency', async () => {
      const ref = await startRef();

      for (let i = 0; i < 100; i++) {
        registry.register('key', ref);
        expect(registry.isRegistered('key')).toBe(true);
        registry.unregister('key');
        expect(registry.isRegistered('key')).toBe(false);
      }
    });

    it('metadata defaults to undefined when not provided', async () => {
      const ref = await startRef();
      registry.register('svc', ref);
      const entry = registry.lookup('svc');
      expect(entry.metadata).toBeUndefined();
    });

    it('registeredAt is set correctly', async () => {
      const before = Date.now();
      const ref = await startRef();
      registry.register('svc', ref);
      const after = Date.now();

      const entry = registry.lookup('svc');
      expect(entry.registeredAt).toBeGreaterThanOrEqual(before);
      expect(entry.registeredAt).toBeLessThanOrEqual(after);
    });
  });
});
