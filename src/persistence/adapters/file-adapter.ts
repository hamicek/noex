/**
 * File-based storage adapter with atomic writes and integrity verification.
 *
 * This adapter persists state to the filesystem using JSON files.
 * Supports atomic writes via temp file + rename pattern for crash safety.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PersistenceKey, PersistedState, StorageAdapter, StateMetadata } from '../types.js';
import { ChecksumMismatchError, CorruptedStateError, StorageError } from '../errors.js';
import { defaultSerializer, createPrettySerializer } from '../serializers.js';
import type { StateSerializer } from '../types.js';

/**
 * Configuration options for FileAdapter.
 */
export interface FileAdapterOptions {
  /**
   * Directory path where state files will be stored.
   * Will be created if it doesn't exist.
   */
  readonly directory: string;

  /**
   * File extension for state files.
   * @default '.json'
   */
  readonly extension?: string;

  /**
   * Whether to format JSON output for human readability.
   * Increases file size but makes debugging easier.
   * @default false
   */
  readonly prettyPrint?: boolean;

  /**
   * Whether to compute and verify SHA256 checksums.
   * Provides data integrity verification at the cost of some performance.
   * @default true
   */
  readonly checksums?: boolean;

  /**
   * Whether to use atomic writes (write to temp file, then rename).
   * Prevents data corruption on crashes but requires temp file creation.
   * @default true
   */
  readonly atomicWrites?: boolean;
}

/**
 * Internal structure for stored data including checksum.
 */
interface StoredData {
  readonly state: unknown;
  readonly metadata: StateMetadata;
  readonly checksum?: string;
}

/**
 * File-based implementation of StorageAdapter.
 *
 * Provides durable persistence to the filesystem with:
 * - Atomic writes via temp file + rename pattern
 * - SHA256 checksums for integrity verification
 * - Pretty-print option for human-readable files
 * - Automatic directory creation
 *
 * @example
 * ```typescript
 * const adapter = new FileAdapter({
 *   directory: './data/persistence',
 *   prettyPrint: true,
 *   checksums: true,
 * });
 *
 * await adapter.save('counter', {
 *   state: { count: 42 },
 *   metadata: { persistedAt: Date.now(), serverId: 'server-1', schemaVersion: 1 }
 * });
 *
 * // Creates file: ./data/persistence/counter.json
 * ```
 */
export class FileAdapter implements StorageAdapter {
  private readonly directory: string;
  private readonly extension: string;
  private readonly serializer: StateSerializer;
  private readonly checksums: boolean;
  private readonly atomicWrites: boolean;
  private initialized = false;

  constructor(options: FileAdapterOptions) {
    this.directory = resolve(options.directory);
    this.extension = options.extension ?? '.json';
    this.serializer = options.prettyPrint
      ? createPrettySerializer(2)
      : defaultSerializer;
    this.checksums = options.checksums ?? true;
    this.atomicWrites = options.atomicWrites ?? true;
  }

  /**
   * Ensures the storage directory exists.
   */
  private async ensureDirectory(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await mkdir(this.directory, { recursive: true });
    this.initialized = true;
  }

  /**
   * Converts a persistence key to a safe filename.
   * Replaces potentially problematic characters.
   */
  private keyToFilename(key: PersistenceKey): string {
    const safeKey = key
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\.+/g, '_');
    return `${safeKey}${this.extension}`;
  }

  /**
   * Extracts persistence key from filename.
   */
  private filenameToKey(filename: string): PersistenceKey | undefined {
    if (!filename.endsWith(this.extension)) {
      return undefined;
    }
    return filename.slice(0, -this.extension.length);
  }

  /**
   * Gets the full file path for a persistence key.
   */
  private getFilePath(key: PersistenceKey): string {
    return join(this.directory, this.keyToFilename(key));
  }

  /**
   * Computes SHA256 checksum of data.
   */
  private computeChecksum(data: string): string {
    return createHash('sha256').update(data, 'utf8').digest('hex');
  }

  async save(key: PersistenceKey, data: PersistedState<unknown>): Promise<void> {
    try {
      await this.ensureDirectory();

      const filePath = this.getFilePath(key);

      // Serialize state and metadata
      const stateJson = this.serializer.serialize(data.state);
      const checksum = this.checksums ? this.computeChecksum(stateJson) : undefined;

      const stored: StoredData = {
        state: JSON.parse(stateJson),
        metadata: data.metadata,
        ...(checksum !== undefined && { checksum }),
      };

      const content = this.serializer.serialize(stored);

      if (this.atomicWrites) {
        // Write to temp file first, then rename for atomicity
        const tempPath = `${filePath}.${randomUUID()}.tmp`;
        await writeFile(tempPath, content, 'utf8');
        await rename(tempPath, filePath);
      } else {
        await writeFile(filePath, content, 'utf8');
      }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        'save',
        `Failed to save state for key: ${key}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async load<T>(key: PersistenceKey): Promise<PersistedState<T> | undefined> {
    try {
      const filePath = this.getFilePath(key);

      let content: string;
      try {
        content = await readFile(filePath, 'utf8');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }

      const stored = this.serializer.deserialize<StoredData>(content);

      // Verify structure
      if (
        stored === null ||
        typeof stored !== 'object' ||
        !('state' in stored) ||
        !('metadata' in stored)
      ) {
        throw new CorruptedStateError(key, 'Invalid data structure');
      }

      // Verify checksum if present and checksums are enabled
      if (this.checksums && stored.checksum !== undefined) {
        const stateJson = this.serializer.serialize(stored.state);
        const actualChecksum = this.computeChecksum(stateJson);

        if (actualChecksum !== stored.checksum) {
          throw new ChecksumMismatchError(key, stored.checksum, actualChecksum);
        }
      }

      // Deserialize the state through our serializer to restore special types
      const stateJson = this.serializer.serialize(stored.state);
      const state = this.serializer.deserialize<T>(stateJson);

      return {
        state,
        metadata: stored.metadata,
      };
    } catch (error) {
      if (
        error instanceof StorageError ||
        error instanceof CorruptedStateError ||
        error instanceof ChecksumMismatchError
      ) {
        throw error;
      }
      throw new StorageError(
        'load',
        `Failed to load state for key: ${key}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async delete(key: PersistenceKey): Promise<boolean> {
    try {
      const filePath = this.getFilePath(key);
      await unlink(filePath);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return false;
      }
      throw new StorageError(
        'delete',
        `Failed to delete state for key: ${key}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async exists(key: PersistenceKey): Promise<boolean> {
    try {
      const filePath = this.getFilePath(key);
      await stat(filePath);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return false;
      }
      throw new StorageError(
        'exists',
        `Failed to check existence for key: ${key}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async listKeys(prefix?: string): Promise<readonly PersistenceKey[]> {
    try {
      await this.ensureDirectory();

      let files: string[];
      try {
        files = await readdir(this.directory);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return [];
        }
        throw error;
      }

      const keys: PersistenceKey[] = [];
      for (const file of files) {
        const key = this.filenameToKey(file);
        if (key !== undefined) {
          if (prefix === undefined || key.startsWith(prefix)) {
            keys.push(key);
          }
        }
      }

      return keys;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        'listKeys',
        'Failed to list keys',
        error instanceof Error ? error : undefined
      );
    }
  }

  async cleanup(maxAgeMs: number): Promise<number> {
    try {
      const now = Date.now();
      const keys = await this.listKeys();
      let cleaned = 0;

      for (const key of keys) {
        const data = await this.load(key);
        if (data !== undefined) {
          const age = now - data.metadata.persistedAt;
          if (age > maxAgeMs) {
            const deleted = await this.delete(key);
            if (deleted) {
              cleaned++;
            }
          }
        }
      }

      return cleaned;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        'cleanup',
        'Failed to cleanup stale entries',
        error instanceof Error ? error : undefined
      );
    }
  }

  async close(): Promise<void> {
    // Clean up any leftover temp files
    try {
      const files = await readdir(this.directory);
      const tempFiles = files.filter((f) => f.endsWith('.tmp'));

      for (const tempFile of tempFiles) {
        try {
          await rm(join(this.directory, tempFile));
        } catch {
          // Ignore errors cleaning up temp files
        }
      }
    } catch {
      // Directory might not exist, ignore
    }

    this.initialized = false;
  }

  /**
   * Returns the configured directory path.
   */
  getDirectory(): string {
    return this.directory;
  }
}
