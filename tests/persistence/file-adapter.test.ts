import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  FileAdapter,
  ChecksumMismatchError,
  CorruptedStateError,
  StorageError,
} from '../../src/persistence/index.js';
import type { PersistedState, StateMetadata } from '../../src/persistence/index.js';

function createMetadata(overrides: Partial<StateMetadata> = {}): StateMetadata {
  return {
    persistedAt: Date.now(),
    serverId: 'test-server-1',
    schemaVersion: 1,
    ...overrides,
  };
}

function createPersistedState<T>(state: T, metadataOverrides: Partial<StateMetadata> = {}): PersistedState<T> {
  return {
    state,
    metadata: createMetadata(metadataOverrides),
  };
}

describe('FileAdapter', () => {
  let testDir: string;
  let adapter: FileAdapter;

  beforeEach(async () => {
    testDir = join(tmpdir(), `noex-test-${randomUUID()}`);
    adapter = new FileAdapter({ directory: testDir });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('directory creation', () => {
    it('creates directory on first save', async () => {
      await adapter.save('key', createPersistedState({ x: 1 }));

      const files = await readdir(testDir);
      expect(files).toContain('key.json');
    });

    it('creates nested directories', async () => {
      const nestedDir = join(testDir, 'nested', 'deep', 'path');
      const nestedAdapter = new FileAdapter({ directory: nestedDir });

      await nestedAdapter.save('key', createPersistedState({ x: 1 }));

      const files = await readdir(nestedDir);
      expect(files).toContain('key.json');
    });

    it('works with existing directory', async () => {
      await mkdir(testDir, { recursive: true });
      await adapter.save('key', createPersistedState({ x: 1 }));

      const loaded = await adapter.load('key');
      expect(loaded).toBeDefined();
    });
  });

  describe('save', () => {
    it('creates file with JSON content', async () => {
      const state = { count: 42, name: 'test' };
      await adapter.save('my-state', createPersistedState(state));

      const filePath = join(testDir, 'my-state.json');
      const content = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(content);

      expect(parsed.state).toEqual(state);
      expect(parsed.metadata).toBeDefined();
      expect(parsed.checksum).toBeDefined();
    });

    it('overwrites existing file', async () => {
      await adapter.save('key', createPersistedState({ v: 1 }));
      await adapter.save('key', createPersistedState({ v: 2 }));

      const loaded = await adapter.load<{ v: number }>('key');
      expect(loaded?.state.v).toBe(2);
    });

    it('handles special characters in key by sanitizing', async () => {
      await adapter.save('user:alice/session', createPersistedState({ x: 1 }));

      const files = await readdir(testDir);
      expect(files.some((f) => f.includes('user') && f.endsWith('.json'))).toBe(true);
    });
  });

  describe('load', () => {
    it('returns undefined for non-existent file', async () => {
      const result = await adapter.load('non-existent');
      expect(result).toBeUndefined();
    });

    it('returns stored state with metadata', async () => {
      const state = { name: 'test', value: 42 };
      const metadata = createMetadata({
        serverId: 'server-123',
        serverName: 'my-server',
        schemaVersion: 3,
      });

      await adapter.save('key', { state, metadata });
      const loaded = await adapter.load<typeof state>('key');

      expect(loaded).toBeDefined();
      expect(loaded!.state).toEqual(state);
      expect(loaded!.metadata.serverId).toBe('server-123');
      expect(loaded!.metadata.serverName).toBe('my-server');
      expect(loaded!.metadata.schemaVersion).toBe(3);
    });

    it('handles complex nested structures', async () => {
      const complexState = {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        settings: {
          theme: 'dark',
          nested: { deep: { value: 42 } },
        },
      };

      await adapter.save('complex', createPersistedState(complexState));
      const loaded = await adapter.load<typeof complexState>('complex');

      expect(loaded?.state).toEqual(complexState);
    });
  });

  describe('delete', () => {
    it('returns true when file exists and is deleted', async () => {
      await adapter.save('key', createPersistedState({}));

      const result = await adapter.delete('key');

      expect(result).toBe(true);
      expect(await adapter.exists('key')).toBe(false);
    });

    it('returns false when file does not exist', async () => {
      const result = await adapter.delete('non-existent');
      expect(result).toBe(false);
    });

    it('only deletes specified file', async () => {
      await adapter.save('key1', createPersistedState({}));
      await adapter.save('key2', createPersistedState({}));

      await adapter.delete('key1');

      expect(await adapter.exists('key1')).toBe(false);
      expect(await adapter.exists('key2')).toBe(true);
    });
  });

  describe('exists', () => {
    it('returns false for non-existent file', async () => {
      expect(await adapter.exists('missing')).toBe(false);
    });

    it('returns true for existing file', async () => {
      await adapter.save('present', createPersistedState({}));
      expect(await adapter.exists('present')).toBe(true);
    });

    it('returns false after file is deleted', async () => {
      await adapter.save('key', createPersistedState({}));
      await adapter.delete('key');
      expect(await adapter.exists('key')).toBe(false);
    });
  });

  describe('listKeys', () => {
    it('returns empty array when directory is empty', async () => {
      await mkdir(testDir, { recursive: true });
      const keys = await adapter.listKeys();
      expect(keys).toEqual([]);
    });

    it('returns empty array when directory does not exist', async () => {
      const nonExistentAdapter = new FileAdapter({
        directory: join(testDir, 'does-not-exist'),
      });
      const keys = await nonExistentAdapter.listKeys();
      expect(keys).toEqual([]);
    });

    it('returns all keys when no prefix specified', async () => {
      await adapter.save('alpha', createPersistedState({}));
      await adapter.save('beta', createPersistedState({}));
      await adapter.save('gamma', createPersistedState({}));

      const keys = await adapter.listKeys();

      expect(keys).toHaveLength(3);
      expect(keys).toContain('alpha');
      expect(keys).toContain('beta');
      expect(keys).toContain('gamma');
    });

    it('filters keys by prefix', async () => {
      await adapter.save('user-alice', createPersistedState({}));
      await adapter.save('user-bob', createPersistedState({}));
      await adapter.save('session-123', createPersistedState({}));

      const userKeys = await adapter.listKeys('user-');

      expect(userKeys).toHaveLength(2);
      expect(userKeys).toContain('user-alice');
      expect(userKeys).toContain('user-bob');
    });

    it('ignores non-json files', async () => {
      await adapter.save('valid', createPersistedState({}));
      await writeFile(join(testDir, 'readme.txt'), 'ignore me');

      const keys = await adapter.listKeys();

      expect(keys).toEqual(['valid']);
    });
  });

  describe('cleanup', () => {
    it('removes files older than maxAgeMs', async () => {
      const now = Date.now();

      await adapter.save('old', createPersistedState({}, { persistedAt: now - 2 * 60 * 60 * 1000 }));
      await adapter.save('recent', createPersistedState({}, { persistedAt: now - 5 * 60 * 1000 }));
      await adapter.save('ancient', createPersistedState({}, { persistedAt: now - 24 * 60 * 60 * 1000 }));

      const cleaned = await adapter.cleanup(60 * 60 * 1000);

      expect(cleaned).toBe(2);
      expect(await adapter.exists('old')).toBe(false);
      expect(await adapter.exists('ancient')).toBe(false);
      expect(await adapter.exists('recent')).toBe(true);
    });

    it('returns 0 when no entries are stale', async () => {
      await adapter.save('fresh', createPersistedState({}));

      const cleaned = await adapter.cleanup(60 * 60 * 1000);

      expect(cleaned).toBe(0);
    });
  });

  describe('close', () => {
    it('cleans up temp files', async () => {
      await adapter.save('key', createPersistedState({}));

      // Manually create a temp file
      await writeFile(join(testDir, 'orphan.tmp'), 'temp');

      await adapter.close();

      const files = await readdir(testDir);
      expect(files.every((f) => !f.endsWith('.tmp'))).toBe(true);
    });
  });

  describe('checksums', () => {
    it('includes checksum when enabled (default)', async () => {
      await adapter.save('key', createPersistedState({ x: 1 }));

      const content = await readFile(join(testDir, 'key.json'), 'utf8');
      const parsed = JSON.parse(content);

      expect(parsed.checksum).toBeDefined();
      expect(typeof parsed.checksum).toBe('string');
      expect(parsed.checksum.length).toBe(64); // SHA256 hex
    });

    it('omits checksum when disabled', async () => {
      const noChecksumAdapter = new FileAdapter({
        directory: testDir,
        checksums: false,
      });

      await noChecksumAdapter.save('key', createPersistedState({ x: 1 }));

      const content = await readFile(join(testDir, 'key.json'), 'utf8');
      const parsed = JSON.parse(content);

      expect(parsed.checksum).toBeUndefined();
    });

    it('throws ChecksumMismatchError when checksum is invalid', async () => {
      await adapter.save('key', createPersistedState({ x: 1 }));

      // Tamper with the file
      const filePath = join(testDir, 'key.json');
      const content = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(content);
      parsed.state.x = 999; // Change state but keep old checksum
      await writeFile(filePath, JSON.stringify(parsed));

      await expect(adapter.load('key')).rejects.toThrow(ChecksumMismatchError);
    });

    it('loads correctly when checksum is valid', async () => {
      const state = { value: 42 };
      await adapter.save('key', createPersistedState(state));

      const loaded = await adapter.load<typeof state>('key');

      expect(loaded?.state.value).toBe(42);
    });
  });

  describe('prettyPrint option', () => {
    it('formats JSON when enabled', async () => {
      const prettyAdapter = new FileAdapter({
        directory: testDir,
        prettyPrint: true,
      });

      await prettyAdapter.save('key', createPersistedState({ x: 1 }));

      const content = await readFile(join(testDir, 'key.json'), 'utf8');
      expect(content).toContain('\n');
      expect(content).toContain('  '); // indentation
    });

    it('produces compact JSON when disabled (default)', async () => {
      await adapter.save('key', createPersistedState({ x: 1 }));

      const content = await readFile(join(testDir, 'key.json'), 'utf8');
      expect(content).not.toContain('\n');
    });
  });

  describe('extension option', () => {
    it('uses custom extension', async () => {
      const customAdapter = new FileAdapter({
        directory: testDir,
        extension: '.state',
      });

      await customAdapter.save('key', createPersistedState({}));

      const files = await readdir(testDir);
      expect(files).toContain('key.state');
    });

    it('filters by custom extension in listKeys', async () => {
      const customAdapter = new FileAdapter({
        directory: testDir,
        extension: '.state',
      });

      await customAdapter.save('key', createPersistedState({}));
      await writeFile(join(testDir, 'other.json'), '{}');

      const keys = await customAdapter.listKeys();

      expect(keys).toEqual(['key']);
    });
  });

  describe('atomicWrites option', () => {
    it('uses temp file when enabled (default)', async () => {
      // This is hard to test directly, but we can verify the result is correct
      await adapter.save('key', createPersistedState({ x: 1 }));

      const loaded = await adapter.load<{ x: number }>('key');
      expect(loaded?.state.x).toBe(1);
    });

    it('writes directly when disabled', async () => {
      const directAdapter = new FileAdapter({
        directory: testDir,
        atomicWrites: false,
      });

      await directAdapter.save('key', createPersistedState({ x: 1 }));

      const loaded = await directAdapter.load<{ x: number }>('key');
      expect(loaded?.state.x).toBe(1);
    });
  });

  describe('corrupted data handling', () => {
    it('throws CorruptedStateError for invalid structure', async () => {
      await mkdir(testDir, { recursive: true });
      await writeFile(join(testDir, 'bad.json'), JSON.stringify({ invalid: true }));

      await expect(adapter.load('bad')).rejects.toThrow(CorruptedStateError);
    });

    it('throws StorageError for invalid JSON', async () => {
      await mkdir(testDir, { recursive: true });
      await writeFile(join(testDir, 'invalid.json'), 'not valid json');

      await expect(adapter.load('invalid')).rejects.toThrow(StorageError);
    });
  });

  describe('getDirectory', () => {
    it('returns configured directory path', () => {
      expect(adapter.getDirectory()).toBe(testDir);
    });

    it('returns resolved absolute path', () => {
      const relativeAdapter = new FileAdapter({ directory: './data' });
      const dir = relativeAdapter.getDirectory();

      expect(dir.startsWith('/')).toBe(true);
      expect(dir.endsWith('/data')).toBe(true);
    });
  });

  describe('concurrent operations', () => {
    it('handles multiple saves to different keys', async () => {
      const saves = Array.from({ length: 10 }, (_, i) =>
        adapter.save(`key-${i}`, createPersistedState({ index: i }))
      );

      await Promise.all(saves);

      const keys = await adapter.listKeys();
      expect(keys).toHaveLength(10);
    });

    it('handles save and load of same key', async () => {
      await adapter.save('key', createPersistedState({ v: 1 }));

      const [loaded1, loaded2, loaded3] = await Promise.all([
        adapter.load<{ v: number }>('key'),
        adapter.load<{ v: number }>('key'),
        adapter.load<{ v: number }>('key'),
      ]);

      expect(loaded1?.state.v).toBe(1);
      expect(loaded2?.state.v).toBe(1);
      expect(loaded3?.state.v).toBe(1);
    });
  });

  describe('special types preservation', () => {
    it('preserves Date objects through serialization', async () => {
      const state = { createdAt: new Date('2024-06-15T10:30:00.000Z') };
      await adapter.save('dates', createPersistedState(state));

      const loaded = await adapter.load<typeof state>('dates');

      expect(loaded?.state.createdAt).toBeInstanceOf(Date);
      expect(loaded?.state.createdAt.toISOString()).toBe('2024-06-15T10:30:00.000Z');
    });

    it('preserves Map objects through serialization', async () => {
      const state = { users: new Map([['alice', { name: 'Alice' }]]) };
      await adapter.save('maps', createPersistedState(state));

      const loaded = await adapter.load<typeof state>('maps');

      expect(loaded?.state.users).toBeInstanceOf(Map);
      expect(loaded?.state.users.get('alice')).toEqual({ name: 'Alice' });
    });

    it('preserves Set objects through serialization', async () => {
      const state = { tags: new Set(['a', 'b', 'c']) };
      await adapter.save('sets', createPersistedState(state));

      const loaded = await adapter.load<typeof state>('sets');

      expect(loaded?.state.tags).toBeInstanceOf(Set);
      expect(loaded?.state.tags.has('a')).toBe(true);
      expect(loaded?.state.tags.has('b')).toBe(true);
      expect(loaded?.state.tags.has('c')).toBe(true);
    });

    it('preserves BigInt through serialization', async () => {
      const state = { bigValue: 9007199254740993n };
      await adapter.save('bigint', createPersistedState(state));

      const loaded = await adapter.load<typeof state>('bigint');

      expect(typeof loaded?.state.bigValue).toBe('bigint');
      expect(loaded?.state.bigValue).toBe(9007199254740993n);
    });
  });
});
