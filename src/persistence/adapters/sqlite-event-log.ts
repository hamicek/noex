/**
 * SQLite-based event log adapter with WAL mode support.
 *
 * This adapter persists events to a SQLite database using better-sqlite3.
 * Provides durable, append-only event storage with efficient sequence-based reads.
 * Requires `better-sqlite3` as an optional peer dependency.
 */

import type { EventEntry, EventLogAdapter, ReadOptions } from '../types.js';
import { PersistenceError, StorageError } from '../errors.js';

/**
 * Minimal type definitions for better-sqlite3 to avoid requiring @types/better-sqlite3.
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
 * Configuration options for SQLiteEventLogAdapter.
 */
export interface SQLiteEventLogAdapterOptions {
  /**
   * Path to the SQLite database file.
   * Use ':memory:' for an in-memory database.
   */
  readonly filename: string;

  /**
   * Name of the table to store event log entries.
   * @default 'event_log'
   */
  readonly tableName?: string;

  /**
   * Whether to enable WAL (Write-Ahead Logging) mode.
   * @default true
   */
  readonly walMode?: boolean;
}

/**
 * Raw row structure as returned from SQLite queries.
 */
interface EventRow {
  readonly stream_id: string;
  readonly seq: number;
  readonly timestamp: number;
  readonly type: string;
  readonly payload: string;
  readonly metadata: string | null;
}

/**
 * SQLite-based implementation of EventLogAdapter.
 *
 * Provides durable, append-only event log storage with:
 * - WAL mode for better read/write concurrency
 * - Lazy initialization on first operation
 * - Prepared statements for optimal performance
 * - Efficient index-based filtering by stream and event type
 *
 * @example
 * ```typescript
 * const log = new SQLiteEventLogAdapter({
 *   filename: './data/events.db',
 * });
 *
 * await log.append('orders', [
 *   { seq: 0, timestamp: Date.now(), type: 'OrderCreated', payload: { id: '123' } }
 * ]);
 *
 * const events = await log.read('orders');
 * await log.close();
 * ```
 */
export class SQLiteEventLogAdapter implements EventLogAdapter {
  private readonly filename: string;
  private readonly tableName: string;
  private readonly walMode: boolean;
  private db: BetterSqlite3Database | null = null;

  private appendStmt: BetterSqlite3Statement | null = null;
  private readAllStmt: BetterSqlite3Statement | null = null;
  private readRangeStmt: BetterSqlite3Statement | null = null;
  private getLastSeqStmt: BetterSqlite3Statement | null = null;
  private truncateBeforeStmt: BetterSqlite3Statement | null = null;
  private countBeforeStmt: BetterSqlite3Statement | null = null;
  private listStreamsStmt: BetterSqlite3Statement | null = null;
  private listStreamsWithPrefixStmt: BetterSqlite3Statement | null = null;

  constructor(options: SQLiteEventLogAdapterOptions) {
    this.filename = options.filename;
    this.tableName = options.tableName ?? 'event_log';
    this.walMode = options.walMode ?? true;
  }

  async append(streamId: string, events: readonly EventEntry[]): Promise<number> {
    if (events.length === 0) {
      return this.getLastSeq(streamId);
    }

    try {
      this.ensureInitialized();

      let seq = await this.getLastSeq(streamId);

      for (const event of events) {
        seq++;
        const payloadJson = JSON.stringify(event.payload);
        const metadataJson = event.metadata !== undefined ? JSON.stringify(event.metadata) : null;
        this.appendStmt!.run(streamId, seq, event.timestamp, event.type, payloadJson, metadataJson);
      }

      return seq;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        'save',
        `Failed to append events to stream: ${streamId}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async read(streamId: string, options?: ReadOptions): Promise<readonly EventEntry[]> {
    try {
      this.ensureInitialized();

      const fromSeq = options?.fromSeq ?? 1;
      const toSeq = options?.toSeq ?? Number.MAX_SAFE_INTEGER;

      let rows = this.readRangeStmt!.all(streamId, fromSeq, toSeq) as EventRow[];

      if (options?.types !== undefined && options.types.length > 0) {
        const typeSet = new Set(options.types);
        rows = rows.filter((row) => typeSet.has(row.type));
      }

      if (options?.limit !== undefined && options.limit > 0) {
        rows = rows.slice(0, options.limit);
      }

      return rows.map((row) => this.rowToEntry(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        'load',
        `Failed to read events from stream: ${streamId}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async readAfter(streamId: string, afterSeq: number): Promise<readonly EventEntry[]> {
    return this.read(streamId, { fromSeq: afterSeq + 1 });
  }

  async getLastSeq(streamId: string): Promise<number> {
    try {
      this.ensureInitialized();

      const row = this.getLastSeqStmt!.get(streamId) as { max_seq: number | null } | undefined;
      return row?.max_seq ?? 0;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        'load',
        `Failed to get last seq for stream: ${streamId}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async truncateBefore(streamId: string, beforeSeq: number): Promise<number> {
    try {
      this.ensureInitialized();

      const countRow = this.countBeforeStmt!.get(streamId, beforeSeq) as { cnt: number } | undefined;
      const count = countRow?.cnt ?? 0;

      if (count > 0) {
        this.truncateBeforeStmt!.run(streamId, beforeSeq);
      }

      return count;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        'delete',
        `Failed to truncate events from stream: ${streamId}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async listStreams(prefix?: string): Promise<readonly string[]> {
    try {
      this.ensureInitialized();

      let rows: { stream_id: string }[];
      if (prefix === undefined) {
        rows = this.listStreamsStmt!.all() as { stream_id: string }[];
      } else {
        const escapedPrefix = this.escapeLikePattern(prefix);
        rows = this.listStreamsWithPrefixStmt!.all(`${escapedPrefix}%`) as { stream_id: string }[];
      }

      return rows.map((row) => row.stream_id);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        'load',
        'Failed to list streams',
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
        this.appendStmt = null;
        this.readAllStmt = null;
        this.readRangeStmt = null;
        this.getLastSeqStmt = null;
        this.truncateBeforeStmt = null;
        this.countBeforeStmt = null;
        this.listStreamsStmt = null;
        this.listStreamsWithPrefixStmt = null;
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

  /**
   * Lazily initializes the database connection, creates the table and indexes.
   */
  private ensureInitialized(): void {
    if (this.db !== null) {
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const BetterSqlite3 = require('better-sqlite3') as BetterSqlite3Constructor;
      this.db = new BetterSqlite3(this.filename);

      if (this.walMode) {
        this.db.pragma('journal_mode = WAL');
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          stream_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          metadata TEXT,
          PRIMARY KEY (stream_id, seq)
        )
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_type
        ON ${this.tableName}(stream_id, type)
      `);

      this.prepareStatements();
    } catch (error) {
      this.db = null;
      if (error instanceof Error && error.message.includes('Cannot find module')) {
        throw new PersistenceError(
          'better-sqlite3 is required for SQLiteEventLogAdapter. Install it with: npm install better-sqlite3',
          error
        );
      }
      throw new PersistenceError(
        `Failed to initialize SQLite database: ${this.filename}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  private prepareStatements(): void {
    if (this.db === null) {
      return;
    }

    this.appendStmt = this.db.prepare(`
      INSERT INTO ${this.tableName} (stream_id, seq, timestamp, type, payload, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.readAllStmt = this.db.prepare(`
      SELECT stream_id, seq, timestamp, type, payload, metadata
      FROM ${this.tableName}
      WHERE stream_id = ?
      ORDER BY seq ASC
    `);

    this.readRangeStmt = this.db.prepare(`
      SELECT stream_id, seq, timestamp, type, payload, metadata
      FROM ${this.tableName}
      WHERE stream_id = ? AND seq >= ? AND seq <= ?
      ORDER BY seq ASC
    `);

    this.getLastSeqStmt = this.db.prepare(`
      SELECT MAX(seq) as max_seq FROM ${this.tableName} WHERE stream_id = ?
    `);

    this.truncateBeforeStmt = this.db.prepare(`
      DELETE FROM ${this.tableName} WHERE stream_id = ? AND seq < ?
    `);

    this.countBeforeStmt = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM ${this.tableName} WHERE stream_id = ? AND seq < ?
    `);

    this.listStreamsStmt = this.db.prepare(`
      SELECT DISTINCT stream_id FROM ${this.tableName}
    `);

    this.listStreamsWithPrefixStmt = this.db.prepare(`
      SELECT DISTINCT stream_id FROM ${this.tableName} WHERE stream_id LIKE ? ESCAPE '\\'
    `);
  }

  private escapeLikePattern(pattern: string): string {
    return pattern
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
  }

  private rowToEntry(row: EventRow): EventEntry {
    const entry: EventEntry = {
      seq: row.seq,
      timestamp: row.timestamp,
      type: row.type,
      payload: JSON.parse(row.payload) as unknown,
      ...(row.metadata !== null && { metadata: JSON.parse(row.metadata) as Record<string, unknown> }),
    };
    return entry;
  }
}
