/**
 * SQLite-based storage adapter with WAL mode support.
 *
 * This adapter persists state to a SQLite database using better-sqlite3.
 * Requires `better-sqlite3` as an optional peer dependency.
 */

import { createRequire } from 'node:module';
import type { PersistenceKey, PersistedState, StorageAdapter, StateMetadata } from '../types.js';
import { CorruptedStateError, PersistenceError, StorageError } from '../errors.js';
import { defaultSerializer } from '../serializers.js';
import type { StateSerializer } from '../types.js';

const require = createRequire(import.meta.url);

/**
 * Minimal type definitions for better-sqlite3 to avoid requiring @types/better-sqlite3.
 * These are only the methods we use.
 */
interface BetterSqlite3Database {
  pragma(source: string): unknown;
  exec(source: string): this;
  prepare(source: string): BetterSqlite3Statement;
  close(): void;
}

interface BetterSqlite3Statement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

type BetterSqlite3Constructor = new (filename: string) => BetterSqlite3Database;

/**
 * Configuration options for SQLiteAdapter.
 */
export interface SQLiteAdapterOptions {
  /**
   * Path to the SQLite database file.
   * Use ':memory:' for an in-memory database.
   */
  readonly filename: string;

  /**
   * Name of the table to store state data.
   * @default 'noex_state'
   */
  readonly tableName?: string;

  /**
   * Whether to enable WAL (Write-Ahead Logging) mode.
   * Provides better concurrency for read/write operations.
   * @default true
   */
  readonly walMode?: boolean;
}

/**
 * Internal structure for stored data.
 */
interface StoredData {
  readonly state: unknown;
  readonly metadata: StateMetadata;
}

/**
 * SQLite-based implementation of StorageAdapter.
 *
 * Provides durable persistence using SQLite database with:
 * - WAL mode for better concurrency
 * - Lazy initialization on first operation
 * - Prepared statements for optimal performance
 * - Support for in-memory databases
 *
 * @example
 * ```typescript
 * const adapter = new SQLiteAdapter({
 *   filename: './data/state.db',
 *   walMode: true,
 * });
 *
 * await adapter.save('counter', {
 *   state: { count: 42 },
 *   metadata: { persistedAt: Date.now(), serverId: 'server-1', schemaVersion: 1 }
 * });
 *
 * // Data stored in: ./data/state.db
 * ```
 */
export class SQLiteAdapter implements StorageAdapter {
  private readonly filename: string;
  private readonly tableName: string;
  private readonly walMode: boolean;
  private readonly serializer: StateSerializer;
  private db: BetterSqlite3Database | null = null;

  private saveStmt: BetterSqlite3Statement | null = null;
  private loadStmt: BetterSqlite3Statement | null = null;
  private deleteStmt: BetterSqlite3Statement | null = null;
  private existsStmt: BetterSqlite3Statement | null = null;
  private listKeysStmt: BetterSqlite3Statement | null = null;
  private listKeysWithPrefixStmt: BetterSqlite3Statement | null = null;

  constructor(options: SQLiteAdapterOptions) {
    this.filename = options.filename;
    this.tableName = options.tableName ?? 'noex_state';
    this.walMode = options.walMode ?? true;
    this.serializer = defaultSerializer;
  }

  /**
   * Lazily initializes the database connection and creates the table.
   * Throws PersistenceError if better-sqlite3 is not installed or initialization fails.
   */
  private ensureInitialized(): void {
    if (this.db !== null) {
      return;
    }

    try {
      // Dynamic import to fail gracefully if better-sqlite3 is not installed
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const BetterSqlite3 = require('better-sqlite3') as BetterSqlite3Constructor;
      this.db = new BetterSqlite3(this.filename);

      if (this.walMode) {
        this.db.pragma('journal_mode = WAL');
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          key TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      this.prepareStatements();
    } catch (error) {
      this.db = null;
      if (error instanceof Error && error.message.includes('Cannot find module')) {
        throw new PersistenceError(
          'better-sqlite3 is required for SQLiteAdapter. Install it with: npm install better-sqlite3',
          error
        );
      }
      throw new PersistenceError(
        `Failed to initialize SQLite database: ${this.filename}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Prepares SQL statements for reuse.
   */
  private prepareStatements(): void {
    if (this.db === null) {
      return;
    }

    this.saveStmt = this.db.prepare(`
      INSERT INTO ${this.tableName} (key, data, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        data = excluded.data,
        updated_at = excluded.updated_at
    `);

    this.loadStmt = this.db.prepare(`
      SELECT data FROM ${this.tableName} WHERE key = ?
    `);

    this.deleteStmt = this.db.prepare(`
      DELETE FROM ${this.tableName} WHERE key = ?
    `);

    this.existsStmt = this.db.prepare(`
      SELECT 1 FROM ${this.tableName} WHERE key = ? LIMIT 1
    `);

    this.listKeysStmt = this.db.prepare(`
      SELECT key FROM ${this.tableName}
    `);

    this.listKeysWithPrefixStmt = this.db.prepare(`
      SELECT key FROM ${this.tableName} WHERE key LIKE ? ESCAPE '\\'
    `);
  }

  /**
   * Escapes special characters for LIKE queries.
   */
  private escapeLikePattern(pattern: string): string {
    return pattern
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
  }

  async save(key: PersistenceKey, data: PersistedState<unknown>): Promise<void> {
    try {
      this.ensureInitialized();

      const now = Date.now();
      const stored: StoredData = {
        state: data.state,
        metadata: data.metadata,
      };
      const serialized = this.serializer.serialize(stored);

      this.saveStmt!.run(key, serialized, now, now);
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
      this.ensureInitialized();

      const row = this.loadStmt!.get(key) as { data: string } | undefined;
      if (row === undefined) {
        return undefined;
      }

      let stored: StoredData;
      try {
        stored = this.serializer.deserialize<StoredData>(row.data);
      } catch (error) {
        throw new CorruptedStateError(key, 'Invalid JSON data in database');
      }

      if (
        stored === null ||
        typeof stored !== 'object' ||
        !('state' in stored) ||
        !('metadata' in stored)
      ) {
        throw new CorruptedStateError(key, 'Invalid data structure');
      }

      // Deserialize the state through our serializer to restore special types
      const stateJson = this.serializer.serialize(stored.state);
      const state = this.serializer.deserialize<T>(stateJson);

      return {
        state,
        metadata: stored.metadata,
      };
    } catch (error) {
      if (error instanceof StorageError || error instanceof CorruptedStateError) {
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
      this.ensureInitialized();

      const result = this.deleteStmt!.run(key);
      return result.changes > 0;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
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
      this.ensureInitialized();

      const row = this.existsStmt!.get(key);
      return row !== undefined;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
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
      this.ensureInitialized();

      let rows: { key: string }[];
      if (prefix === undefined) {
        rows = this.listKeysStmt!.all() as { key: string }[];
      } else {
        const escapedPrefix = this.escapeLikePattern(prefix);
        rows = this.listKeysWithPrefixStmt!.all(`${escapedPrefix}%`) as { key: string }[];
      }

      return rows.map((row) => row.key);
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
      this.ensureInitialized();

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
    if (this.db !== null) {
      try {
        this.db.close();
      } catch (error) {
        throw new StorageError(
          'close',
          'Failed to close database connection',
          error instanceof Error ? error : undefined
        );
      } finally {
        this.db = null;
        this.saveStmt = null;
        this.loadStmt = null;
        this.deleteStmt = null;
        this.existsStmt = null;
        this.listKeysStmt = null;
        this.listKeysWithPrefixStmt = null;
      }
    }
  }

  /**
   * Returns the configured database filename.
   */
  getFilename(): string {
    return this.filename;
  }

  /**
   * Returns the configured table name.
   */
  getTableName(): string {
    return this.tableName;
  }
}
