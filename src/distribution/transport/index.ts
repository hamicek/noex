/**
 * Transport layer for cluster TCP communication.
 *
 * Provides reliable, bidirectional TCP connections between cluster nodes
 * with automatic reconnection, message framing, and authentication.
 *
 * @module distribution/transport
 *
 * @example
 * ```typescript
 * import { Transport, Connection } from 'noex/distribution/transport';
 *
 * // Create and start transport
 * const transport = new Transport({
 *   localNodeId: NodeId.parse('app1@192.168.1.1:4369'),
 * });
 *
 * transport.on('message', (envelope, fromNodeId) => {
 *   handleMessage(envelope.payload);
 * });
 *
 * await transport.start();
 * await transport.connectTo(remoteNodeId);
 * await transport.send(remoteNodeId, message);
 * ```
 */

// =============================================================================
// Connection
// =============================================================================

export {
  Connection,
  type ConnectionState,
  type ConnectionConfig,
  type ConnectionEvents,
  type ConnectionStats,
} from './connection.js';

// =============================================================================
// Transport
// =============================================================================

export {
  Transport,
  type TransportState,
  type TransportConfig,
  type TransportEvents,
  type TransportStats,
} from './transport.js';
