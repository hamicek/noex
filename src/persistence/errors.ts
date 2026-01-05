/**
 * Persistence error classes.
 *
 * All persistence errors extend the base Error class directly,
 * following noex conventions for error handling.
 */

/**
 * Base class for all persistence-related errors.
 */
export class PersistenceError extends Error {
  override readonly name = 'PersistenceError' as const;
  override readonly cause: Error | undefined;

  constructor(message: string, cause?: Error) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Thrown when attempting to load state that does not exist.
 */
export class StateNotFoundError extends Error {
  override readonly name = 'StateNotFoundError' as const;

  constructor(readonly key: string) {
    super(`State not found for key: ${key}`);
  }
}

/**
 * Thrown when state serialization fails.
 */
export class SerializationError extends Error {
  override readonly name = 'SerializationError' as const;
  override readonly cause: Error | undefined;

  constructor(message: string, cause?: Error) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Thrown when state deserialization fails.
 */
export class DeserializationError extends Error {
  override readonly name = 'DeserializationError' as const;
  override readonly cause: Error | undefined;

  constructor(message: string, cause?: Error) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Thrown when persisted state fails integrity checks.
 */
export class CorruptedStateError extends Error {
  override readonly name = 'CorruptedStateError' as const;

  constructor(
    readonly key: string,
    reason: string
  ) {
    super(`Corrupted state for key ${key}: ${reason}`);
  }
}

/**
 * Thrown when persisted state exceeds maximum age.
 */
export class StaleStateError extends Error {
  override readonly name = 'StaleStateError' as const;

  constructor(
    readonly key: string,
    readonly ageMs: number,
    readonly maxAgeMs: number
  ) {
    super(`State for key ${key} is stale: ${ageMs}ms old (max: ${maxAgeMs}ms)`);
  }
}

/**
 * Thrown when a storage operation fails.
 */
export class StorageError extends Error {
  override readonly name = 'StorageError' as const;
  override readonly cause: Error | undefined;

  constructor(
    readonly operation: 'save' | 'load' | 'delete' | 'exists' | 'listKeys' | 'cleanup' | 'close',
    message: string,
    cause?: Error
  ) {
    super(`Storage ${operation} failed: ${message}`);
    this.cause = cause;
  }
}

/**
 * Thrown when state migration fails.
 */
export class MigrationError extends Error {
  override readonly name = 'MigrationError' as const;
  override readonly cause: Error | undefined;

  constructor(
    readonly fromVersion: number,
    readonly toVersion: number,
    cause?: Error
  ) {
    super(`Migration from version ${fromVersion} to ${toVersion} failed`);
    this.cause = cause;
  }
}

/**
 * Thrown when checksum verification fails.
 */
export class ChecksumMismatchError extends Error {
  override readonly name = 'ChecksumMismatchError' as const;

  constructor(
    readonly key: string,
    readonly expected: string,
    readonly actual: string
  ) {
    super(`Corrupted state for key ${key}: checksum mismatch (expected: ${expected}, actual: ${actual})`);
  }
}
