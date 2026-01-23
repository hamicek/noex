/**
 * Storage adapter implementations.
 *
 * @module persistence/adapters
 */

export { MemoryAdapter } from './memory-adapter.js';
export type { MemoryAdapterOptions } from './memory-adapter.js';

export { FileAdapter } from './file-adapter.js';
export type { FileAdapterOptions } from './file-adapter.js';

export { SQLiteAdapter } from './sqlite-adapter.js';
export type { SQLiteAdapterOptions } from './sqlite-adapter.js';

export { MemoryEventLogAdapter } from './memory-event-log.js';

export { SQLiteEventLogAdapter } from './sqlite-event-log.js';
export type { SQLiteEventLogAdapterOptions } from './sqlite-event-log.js';
