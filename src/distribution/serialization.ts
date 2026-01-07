/**
 * Message serialization for cluster communication.
 *
 * Provides JSON-based serialization with support for special types
 * (Date, Error, undefined, BigInt) and length-prefix framing for
 * reliable TCP transmission.
 *
 * @module distribution/serialization
 */

import * as crypto from 'node:crypto';

import {
  CLUSTER_DEFAULTS,
  MessageSerializationError,
  type CallId,
  type SpawnId,
  type ClusterMessage,
  type MessageEnvelope,
  type NodeId,
} from './types.js';

// =============================================================================
// Constants
// =============================================================================

/**
 * Length prefix size in bytes (32-bit unsigned integer, big-endian).
 */
const LENGTH_PREFIX_SIZE = 4;

/**
 * Maximum message size (16 MB).
 */
const MAX_MESSAGE_SIZE = 16 * 1024 * 1024;

/**
 * Special marker for serializing undefined values in JSON.
 */
const UNDEFINED_MARKER = '__noex_undefined__';

/**
 * Type marker prefix for special types.
 */
const TYPE_MARKER_PREFIX = '__noex_type__';

// =============================================================================
// Type Markers
// =============================================================================

/**
 * Type markers for serializing non-JSON-native types.
 */
interface TypedValue {
  readonly __noex_type__: string;
  readonly value: unknown;
}

/**
 * Checks if a value is a type-marked object.
 */
function isTypedValue(value: unknown): value is TypedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__noex_type__' in value
  );
}

// =============================================================================
// Serialization Helpers
// =============================================================================

/**
 * Recursively transforms values for JSON serialization.
 * Handles special types like Date, Error, BigInt, Map, Set, RegExp.
 *
 * Note: We use recursive transformation instead of JSON.stringify replacer
 * because Date.toJSON() is called before the replacer, losing the Date instance.
 */
function transformForSerialization(value: unknown, seen = new WeakSet<object>()): unknown {
  // Handle primitives and null
  if (value === null) {
    return null;
  }

  if (value === undefined) {
    return { [TYPE_MARKER_PREFIX]: 'undefined' };
  }

  if (typeof value === 'bigint') {
    return {
      [TYPE_MARKER_PREFIX]: 'BigInt',
      value: value.toString(),
    };
  }

  if (typeof value !== 'object' && typeof value !== 'function') {
    return value;
  }

  // Handle Date (must be before generic object handling)
  if (value instanceof Date) {
    return {
      [TYPE_MARKER_PREFIX]: 'Date',
      value: value.toISOString(),
    };
  }

  // Handle Error
  if (value instanceof Error) {
    return {
      [TYPE_MARKER_PREFIX]: 'Error',
      value: {
        name: value.name,
        message: value.message,
        stack: value.stack,
        ...(value instanceof AggregateError && { errors: value.errors }),
        ...('code' in value && { code: value.code }),
        ...('cause' in value && value.cause instanceof Error && {
          cause: {
            name: value.cause.name,
            message: value.cause.message,
          },
        }),
      },
    };
  }

  // Handle Map
  if (value instanceof Map) {
    return {
      [TYPE_MARKER_PREFIX]: 'Map',
      value: Array.from(value.entries()).map(([k, v]) => [
        transformForSerialization(k, seen),
        transformForSerialization(v, seen),
      ]),
    };
  }

  // Handle Set
  if (value instanceof Set) {
    return {
      [TYPE_MARKER_PREFIX]: 'Set',
      value: Array.from(value).map(v => transformForSerialization(v, seen)),
    };
  }

  // Handle RegExp
  if (value instanceof RegExp) {
    return {
      [TYPE_MARKER_PREFIX]: 'RegExp',
      value: { source: value.source, flags: value.flags },
    };
  }

  // Check for circular references
  if (seen.has(value)) {
    throw new Error('Circular reference detected');
  }
  seen.add(value);

  // Handle Arrays
  if (Array.isArray(value)) {
    return value.map(item => transformForSerialization(item, seen));
  }

  // Handle plain objects
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    result[key] = transformForSerialization(val, seen);
  }
  return result;
}

/**
 * Custom reviver for JSON.parse that restores special types.
 */
function jsonReviver(_key: string, value: unknown): unknown {
  if (!isTypedValue(value)) {
    return value;
  }

  const typeMarker = value.__noex_type__;

  switch (typeMarker) {
    case 'undefined':
      return undefined;

    case 'Date':
      return new Date(value.value as string);

    case 'Error': {
      const errorData = value.value as {
        name: string;
        message: string;
        stack?: string;
        code?: string;
        cause?: { name: string; message: string };
      };
      const error = new Error(errorData.message);
      error.name = errorData.name;
      if (errorData.stack) {
        error.stack = errorData.stack;
      }
      return error;
    }

    case 'BigInt':
      return BigInt(value.value as string);

    case 'Map':
      return new Map(value.value as Array<[unknown, unknown]>);

    case 'Set':
      return new Set(value.value as unknown[]);

    case 'RegExp': {
      const regexData = value.value as { source: string; flags: string };
      return new RegExp(regexData.source, regexData.flags);
    }

    default:
      // Unknown type marker, return as-is
      return value;
  }
}

// =============================================================================
// HMAC Signature
// =============================================================================

/**
 * Creates an HMAC-SHA256 signature for message authentication.
 *
 * @param payload - Serialized message payload
 * @param secret - Cluster secret
 * @returns Hex-encoded signature
 */
function createSignature(payload: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
}

/**
 * Verifies an HMAC-SHA256 signature.
 *
 * @param payload - Serialized message payload
 * @param signature - Expected signature
 * @param secret - Cluster secret
 * @returns true if signature is valid
 */
function verifySignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = createSignature(payload, secret);
  // Use timing-safe comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex'),
  );
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Serialization options for message encoding.
 */
export interface SerializeOptions {
  /** Cluster secret for HMAC signature (optional) */
  readonly clusterSecret?: string | undefined;
}

/**
 * Deserialization options for message decoding.
 */
export interface DeserializeOptions {
  /** Cluster secret for signature verification (optional) */
  readonly clusterSecret?: string | undefined;

  /** Whether to require valid signature when secret is provided */
  readonly requireSignature?: boolean;
}

/**
 * Serializer for cluster messages.
 *
 * Handles conversion between ClusterMessage objects and network-ready
 * byte buffers with length-prefix framing.
 *
 * @example
 * ```typescript
 * import { Serializer } from 'noex/distribution';
 *
 * // Serialize a message
 * const buffer = Serializer.serialize(message, nodeId);
 *
 * // Deserialize
 * const envelope = Serializer.deserialize(buffer);
 *
 * // Frame for TCP transmission
 * const framed = Serializer.frame(buffer);
 *
 * // Unframe received data
 * const result = Serializer.unframe(receivedData, offset);
 * ```
 */
export const Serializer = {
  /**
   * Serializes a cluster message into a Buffer.
   *
   * Creates a MessageEnvelope containing the message with metadata,
   * serializes to JSON, and returns a Buffer ready for framing.
   *
   * @param message - Cluster message to serialize
   * @param fromNodeId - Sender node identifier
   * @param options - Serialization options
   * @returns Serialized message as Buffer
   * @throws {MessageSerializationError} If serialization fails
   */
  serialize(
    message: ClusterMessage,
    fromNodeId: NodeId,
    options: SerializeOptions = {},
  ): Buffer {
    try {
      const envelope: Omit<MessageEnvelope, 'signature'> = {
        version: CLUSTER_DEFAULTS.PROTOCOL_VERSION,
        from: fromNodeId,
        timestamp: Date.now(),
        payload: message,
      };

      // Transform special types before JSON serialization
      const transformed = transformForSerialization(envelope);
      const json = JSON.stringify(transformed);

      // Add signature if cluster secret is provided
      if (options.clusterSecret) {
        const signature = createSignature(json, options.clusterSecret);
        const signedEnvelope = {
          ...transformed as object,
          signature,
        };
        return Buffer.from(JSON.stringify(signedEnvelope), 'utf8');
      }

      return Buffer.from(json, 'utf8');
    } catch (error) {
      throw new MessageSerializationError(
        'serialize',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  },

  /**
   * Deserializes a Buffer into a MessageEnvelope.
   *
   * @param buffer - Buffer containing serialized message
   * @param options - Deserialization options
   * @returns Deserialized message envelope
   * @throws {MessageSerializationError} If deserialization or signature verification fails
   */
  deserialize(
    buffer: Buffer,
    options: DeserializeOptions = {},
  ): MessageEnvelope {
    try {
      const json = buffer.toString('utf8');
      const envelope = JSON.parse(json, jsonReviver) as MessageEnvelope;

      // Verify signature if cluster secret is provided
      if (options.clusterSecret) {
        if (!envelope.signature) {
          if (options.requireSignature !== false) {
            throw new Error('Message signature is missing');
          }
        } else {
          // For signature verification, we need the original JSON without signature
          // Parse without reviver to get the raw serialized form, then remove signature
          const rawEnvelope = JSON.parse(json) as { signature?: string };
          const { signature: _, ...unsigned } = rawEnvelope;
          const unsignedJson = JSON.stringify(unsigned);

          if (!verifySignature(unsignedJson, envelope.signature, options.clusterSecret)) {
            throw new Error('Message signature verification failed');
          }
        }
      }

      return envelope;
    } catch (error) {
      throw new MessageSerializationError(
        'deserialize',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  },

  /**
   * Adds length-prefix framing to a serialized message.
   *
   * The frame format is:
   * - 4 bytes: Message length (32-bit unsigned big-endian)
   * - N bytes: Message payload
   *
   * @param payload - Serialized message buffer
   * @returns Framed buffer ready for TCP transmission
   * @throws {MessageSerializationError} If message exceeds maximum size
   */
  frame(payload: Buffer): Buffer {
    if (payload.length > MAX_MESSAGE_SIZE) {
      throw new MessageSerializationError(
        'serialize',
        new Error(`Message size ${payload.length} exceeds maximum ${MAX_MESSAGE_SIZE}`),
      );
    }

    const frame = Buffer.allocUnsafe(LENGTH_PREFIX_SIZE + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, LENGTH_PREFIX_SIZE);

    return frame;
  },

  /**
   * Result of unframe operation.
   */
  UnframeResult: {} as {
    /** Extracted payload (null if incomplete) */
    payload: Buffer | null;
    /** Number of bytes consumed from input */
    bytesConsumed: number;
  },

  /**
   * Extracts a message from a length-prefix framed buffer.
   *
   * Handles partial data gracefully - returns null payload if
   * insufficient data is available.
   *
   * @param buffer - Buffer containing framed data
   * @param offset - Offset to start reading from
   * @returns Unframed payload and bytes consumed
   *
   * @example
   * ```typescript
   * let offset = 0;
   * while (offset < buffer.length) {
   *   const result = Serializer.unframe(buffer, offset);
   *   if (result.payload === null) {
   *     // Need more data
   *     break;
   *   }
   *   processMessage(result.payload);
   *   offset += result.bytesConsumed;
   * }
   * ```
   */
  unframe(
    buffer: Buffer,
    offset: number = 0,
  ): { payload: Buffer | null; bytesConsumed: number } {
    const available = buffer.length - offset;

    // Not enough data for length prefix
    if (available < LENGTH_PREFIX_SIZE) {
      return { payload: null, bytesConsumed: 0 };
    }

    const messageLength = buffer.readUInt32BE(offset);

    // Validate message size
    if (messageLength > MAX_MESSAGE_SIZE) {
      throw new MessageSerializationError(
        'deserialize',
        new Error(`Message size ${messageLength} exceeds maximum ${MAX_MESSAGE_SIZE}`),
      );
    }

    const totalLength = LENGTH_PREFIX_SIZE + messageLength;

    // Not enough data for complete message
    if (available < totalLength) {
      return { payload: null, bytesConsumed: 0 };
    }

    const payload = buffer.subarray(
      offset + LENGTH_PREFIX_SIZE,
      offset + totalLength,
    );

    return { payload, bytesConsumed: totalLength };
  },

  /**
   * Calculates the size of a framed message.
   *
   * @param payloadSize - Size of the message payload
   * @returns Total framed size including length prefix
   */
  framedSize(payloadSize: number): number {
    return LENGTH_PREFIX_SIZE + payloadSize;
  },

  /**
   * Maximum allowed message size.
   */
  MAX_MESSAGE_SIZE,

  /**
   * Size of the length prefix in bytes.
   */
  LENGTH_PREFIX_SIZE,
} as const;

// =============================================================================
// CallId Generation
// =============================================================================

/**
 * Generates a unique CallId for remote call correlation.
 *
 * Uses a combination of timestamp and random bytes to ensure
 * uniqueness across nodes.
 *
 * @returns Unique CallId
 */
export function generateCallId(): CallId {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(8).toString('hex');
  return `${timestamp}-${random}` as CallId;
}

/**
 * Validates that a string is a valid CallId format.
 *
 * @param value - String to validate
 * @returns true if valid CallId format
 */
export function isValidCallId(value: string): value is CallId {
  // Format: timestamp(base36)-random(16 hex chars)
  const pattern = /^[0-9a-z]+-[0-9a-f]{16}$/;
  return pattern.test(value);
}

// =============================================================================
// SpawnId Generation
// =============================================================================

/**
 * Generates a unique SpawnId for remote spawn correlation.
 *
 * Uses a combination of timestamp and random bytes to ensure
 * uniqueness across nodes. Prefixed with 's' to distinguish from CallId.
 *
 * @returns Unique SpawnId
 */
export function generateSpawnId(): SpawnId {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(8).toString('hex');
  return `s${timestamp}-${random}` as SpawnId;
}

/**
 * Validates that a string is a valid SpawnId format.
 *
 * @param value - String to validate
 * @returns true if valid SpawnId format
 */
export function isValidSpawnId(value: string): value is SpawnId {
  // Format: s + timestamp(base36) + - + random(16 hex chars)
  const pattern = /^s[0-9a-z]+-[0-9a-f]{16}$/;
  return pattern.test(value);
}
