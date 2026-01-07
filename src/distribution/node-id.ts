/**
 * NodeId type definition, parsing, validation, and utility functions.
 *
 * NodeId follows the Erlang node naming convention: `name@host:port`
 *
 * - name: Alphanumeric identifier with underscores/hyphens (1-64 chars)
 * - host: IPv4 address, IPv6 address, or hostname
 * - port: TCP port number (1-65535)
 *
 * @module distribution/node-id
 */

// =============================================================================
// NodeId Type Definition
// =============================================================================

/**
 * Opaque branded type for node identification.
 *
 * Format: `name@host:port` (e.g., `app1@192.168.1.1:4369`)
 *
 * The branded type prevents accidental string assignment and ensures
 * all NodeId values have been validated through the parsing functions.
 */
declare const NodeIdBrand: unique symbol;

/**
 * A validated node identifier in the cluster.
 *
 * @example
 * ```typescript
 * import { NodeId } from 'noex/distribution';
 *
 * const nodeId = NodeId.parse('app1@192.168.1.1:4369');
 * const name = NodeId.getName(nodeId); // 'app1'
 * const host = NodeId.getHost(nodeId); // '192.168.1.1'
 * const port = NodeId.getPort(nodeId); // 4369
 * ```
 */
export type NodeId = string & { readonly [NodeIdBrand]: 'NodeId' };

// =============================================================================
// Error Class
// =============================================================================

/**
 * Error thrown when a NodeId string is malformed.
 */
export class InvalidNodeIdError extends Error {
  override readonly name = 'InvalidNodeIdError' as const;

  constructor(
    readonly value: string,
    readonly reason: string,
  ) {
    super(`Invalid NodeId '${value}': ${reason}`);
  }
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum length for the node name component.
 */
const MAX_NAME_LENGTH = 64;

/**
 * Minimum TCP port number.
 */
const MIN_PORT = 1;

/**
 * Maximum TCP port number.
 */
const MAX_PORT = 65535;

/**
 * Pattern for valid node names: alphanumeric, underscores, hyphens.
 */
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Pattern for IPv4 addresses.
 */
const IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

/**
 * Pattern to detect if a string looks like an IPv4 address (numbers and dots only).
 * Used to reject invalid IPv4-like strings that would otherwise pass hostname validation.
 */
const LOOKS_LIKE_IPV4_PATTERN = /^[\d.]+$/;

/**
 * Pattern for basic IPv6 validation (simplified).
 * Full IPv6 validation is complex; this catches most common formats.
 */
const IPV6_PATTERN = /^\[?([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\]?$/;

/**
 * Pattern for hostnames (RFC 1123 compliant).
 */
const HOSTNAME_PATTERN = /^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))*$/;

// =============================================================================
// Parsed Components
// =============================================================================

/**
 * Parsed components of a NodeId.
 */
export interface NodeIdComponents {
  /** Node name (e.g., 'app1') */
  readonly name: string;

  /** Host address (e.g., '192.168.1.1') */
  readonly host: string;

  /** Port number (e.g., 4369) */
  readonly port: number;
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validates a node name component.
 *
 * @param name - The name to validate
 * @throws {InvalidNodeIdError} If the name is invalid
 */
function validateName(name: string): void {
  if (name.length === 0) {
    throw new InvalidNodeIdError(name, 'name cannot be empty');
  }

  if (name.length > MAX_NAME_LENGTH) {
    throw new InvalidNodeIdError(
      name,
      `name exceeds maximum length of ${MAX_NAME_LENGTH} characters`,
    );
  }

  if (!NAME_PATTERN.test(name)) {
    throw new InvalidNodeIdError(
      name,
      'name must start with a letter and contain only alphanumeric characters, underscores, or hyphens',
    );
  }
}

/**
 * Validates a host component.
 *
 * @param host - The host to validate
 * @throws {InvalidNodeIdError} If the host is invalid
 */
function validateHost(host: string): void {
  if (host.length === 0) {
    throw new InvalidNodeIdError(host, 'host cannot be empty');
  }

  // Check for valid IPv4
  if (IPV4_PATTERN.test(host)) {
    return;
  }

  // Reject strings that look like IPv4 but aren't valid
  // (e.g., '256.0.0.1', '1.2.3', '1.2.3.4.5')
  if (LOOKS_LIKE_IPV4_PATTERN.test(host)) {
    throw new InvalidNodeIdError(
      host,
      'host looks like IPv4 but is not a valid IPv4 address',
    );
  }

  // Check for valid IPv6 (with or without brackets)
  const ipv6Host = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1)
    : host;
  if (IPV6_PATTERN.test(ipv6Host)) {
    return;
  }

  // Check for valid hostname
  if (HOSTNAME_PATTERN.test(host)) {
    return;
  }

  throw new InvalidNodeIdError(
    host,
    'host must be a valid IPv4 address, IPv6 address, or hostname',
  );
}

/**
 * Validates a port component.
 *
 * @param port - The port to validate
 * @param originalValue - Original string for error messages
 * @throws {InvalidNodeIdError} If the port is invalid
 */
function validatePort(port: number, originalValue: string): void {
  if (!Number.isInteger(port)) {
    throw new InvalidNodeIdError(originalValue, 'port must be an integer');
  }

  if (port < MIN_PORT || port > MAX_PORT) {
    throw new InvalidNodeIdError(
      originalValue,
      `port must be between ${MIN_PORT} and ${MAX_PORT}`,
    );
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * NodeId namespace providing parsing, validation, and utility functions.
 *
 * @example
 * ```typescript
 * import { NodeId } from 'noex/distribution';
 *
 * // Parse and validate
 * const nodeId = NodeId.parse('app1@192.168.1.1:4369');
 *
 * // Extract components
 * const name = NodeId.getName(nodeId); // 'app1'
 * const host = NodeId.getHost(nodeId); // '192.168.1.1'
 * const port = NodeId.getPort(nodeId); // 4369
 *
 * // Create from components
 * const created = NodeId.create('app2', '192.168.1.2', 4369);
 *
 * // Safe parsing (returns undefined instead of throwing)
 * const maybeNode = NodeId.tryParse('invalid');
 * if (maybeNode) {
 *   // valid
 * }
 * ```
 */
export const NodeId = {
  /**
   * Parses and validates a NodeId string.
   *
   * @param value - String in format `name@host:port`
   * @returns Validated NodeId
   * @throws {InvalidNodeIdError} If the format is invalid
   *
   * @example
   * ```typescript
   * const nodeId = NodeId.parse('app1@192.168.1.1:4369');
   * ```
   */
  parse(value: string): NodeId {
    if (typeof value !== 'string') {
      throw new InvalidNodeIdError(String(value), 'must be a string');
    }

    const atIndex = value.indexOf('@');
    if (atIndex === -1) {
      throw new InvalidNodeIdError(value, "missing '@' separator");
    }

    const lastColonIndex = value.lastIndexOf(':');
    if (lastColonIndex === -1 || lastColonIndex < atIndex) {
      throw new InvalidNodeIdError(value, "missing ':' port separator");
    }

    const name = value.slice(0, atIndex);
    const host = value.slice(atIndex + 1, lastColonIndex);
    const portStr = value.slice(lastColonIndex + 1);

    validateName(name);
    validateHost(host);

    const port = parseInt(portStr, 10);
    if (isNaN(port)) {
      throw new InvalidNodeIdError(value, 'port is not a valid number');
    }

    validatePort(port, value);

    return value as NodeId;
  },

  /**
   * Attempts to parse a NodeId string without throwing.
   *
   * @param value - String to parse
   * @returns NodeId if valid, undefined otherwise
   *
   * @example
   * ```typescript
   * const nodeId = NodeId.tryParse('app1@host:4369');
   * if (nodeId) {
   *   console.log('Valid:', nodeId);
   * }
   * ```
   */
  tryParse(value: string): NodeId | undefined {
    try {
      return NodeId.parse(value);
    } catch {
      return undefined;
    }
  },

  /**
   * Creates a NodeId from individual components.
   *
   * @param name - Node name
   * @param host - Host address
   * @param port - Port number
   * @returns Validated NodeId
   * @throws {InvalidNodeIdError} If any component is invalid
   *
   * @example
   * ```typescript
   * const nodeId = NodeId.create('app1', '192.168.1.1', 4369);
   * // Returns: 'app1@192.168.1.1:4369'
   * ```
   */
  create(name: string, host: string, port: number): NodeId {
    validateName(name);
    validateHost(host);
    validatePort(port, `${name}@${host}:${port}`);

    return `${name}@${host}:${port}` as NodeId;
  },

  /**
   * Extracts the name component from a NodeId.
   *
   * @param nodeId - Valid NodeId
   * @returns Node name
   *
   * @example
   * ```typescript
   * const name = NodeId.getName(nodeId); // 'app1'
   * ```
   */
  getName(nodeId: NodeId): string {
    const atIndex = nodeId.indexOf('@');
    return nodeId.slice(0, atIndex);
  },

  /**
   * Extracts the host component from a NodeId.
   *
   * @param nodeId - Valid NodeId
   * @returns Host address
   *
   * @example
   * ```typescript
   * const host = NodeId.getHost(nodeId); // '192.168.1.1'
   * ```
   */
  getHost(nodeId: NodeId): string {
    const atIndex = nodeId.indexOf('@');
    const lastColonIndex = nodeId.lastIndexOf(':');
    return nodeId.slice(atIndex + 1, lastColonIndex);
  },

  /**
   * Extracts the port component from a NodeId.
   *
   * @param nodeId - Valid NodeId
   * @returns Port number
   *
   * @example
   * ```typescript
   * const port = NodeId.getPort(nodeId); // 4369
   * ```
   */
  getPort(nodeId: NodeId): number {
    const lastColonIndex = nodeId.lastIndexOf(':');
    return parseInt(nodeId.slice(lastColonIndex + 1), 10);
  },

  /**
   * Extracts all components from a NodeId.
   *
   * @param nodeId - Valid NodeId
   * @returns Object with name, host, and port
   *
   * @example
   * ```typescript
   * const { name, host, port } = NodeId.components(nodeId);
   * ```
   */
  components(nodeId: NodeId): NodeIdComponents {
    return {
      name: NodeId.getName(nodeId),
      host: NodeId.getHost(nodeId),
      port: NodeId.getPort(nodeId),
    };
  },

  /**
   * Checks if a string is a valid NodeId without throwing.
   *
   * @param value - String to validate
   * @returns true if valid, false otherwise
   *
   * @example
   * ```typescript
   * if (NodeId.isValid('app1@host:4369')) {
   *   // proceed
   * }
   * ```
   */
  isValid(value: string): value is NodeId {
    return NodeId.tryParse(value) !== undefined;
  },

  /**
   * Compares two NodeIds for equality.
   *
   * @param a - First NodeId
   * @param b - Second NodeId
   * @returns true if equal
   */
  equals(a: NodeId, b: NodeId): boolean {
    return a === b;
  },

  /**
   * Returns a string representation suitable for logging.
   *
   * @param nodeId - NodeId to format
   * @returns Formatted string
   */
  toString(nodeId: NodeId): string {
    return nodeId;
  },
} as const;

/**
 * Type guard for NodeId.
 *
 * @param value - Value to check
 * @returns true if value is a valid NodeId string
 */
export function isNodeId(value: unknown): value is NodeId {
  return typeof value === 'string' && NodeId.isValid(value);
}
