/**
 * Persistence module for GenServer state persistence.
 *
 * Provides a pluggable persistence system with storage adapters,
 * serialization utilities, and integration with GenServer lifecycle.
 *
 * @module persistence
 */

// Types
export type {
  PersistenceKey,
  StateMetadata,
  PersistedState,
  LoadResult,
  StorageAdapter,
  StateSerializer,
  PersistenceConfig,
} from './types.js';

// Error classes
export {
  PersistenceError,
  StateNotFoundError,
  SerializationError,
  DeserializationError,
  CorruptedStateError,
  StaleStateError,
  StorageError,
  MigrationError,
  ChecksumMismatchError,
} from './errors.js';

// Serializers
export { defaultSerializer, createPrettySerializer } from './serializers.js';

// Manager
export { PersistenceManager } from './manager.js';
export type { SaveOptions, ManagerLoadResult, LoadSuccess, LoadFailure } from './manager.js';

// Storage adapters
export { MemoryAdapter, FileAdapter, SQLiteAdapter } from './adapters/index.js';
export type { MemoryAdapterOptions, FileAdapterOptions, SQLiteAdapterOptions } from './adapters/index.js';
