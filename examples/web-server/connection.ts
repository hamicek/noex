/**
 * WebSocket Connection GenServer
 *
 * Each WebSocket connection is managed by its own GenServer instance.
 * This provides:
 * - Isolated state per connection
 * - Serialized message processing
 * - Clean lifecycle management
 * - Integration with EventBus for broadcasting
 */

import type { WebSocket } from '@fastify/websocket';
import { GenServer, EventBus, Registry, type GenServerBehavior, type GenServerRef } from 'noex';

// Message types for the connection GenServer
export type ConnectionCallMsg =
  | { type: 'get_info' }
  | { type: 'get_username' };

export type ConnectionCastMsg =
  | { type: 'send'; payload: unknown }
  | { type: 'broadcast'; message: string }
  | { type: 'set_username'; username: string }
  | { type: 'ws_message'; data: string };

export type ConnectionCallReply = ConnectionInfo | string | null;

export interface ConnectionState {
  socket: WebSocket;
  username: string | null;
  connectedAt: Date;
  messageCount: number;
}

export interface ConnectionInfo {
  username: string | null;
  connectedAt: Date;
  messageCount: number;
}

export type ConnectionRef = GenServerRef<ConnectionState, ConnectionCallMsg, ConnectionCastMsg, ConnectionCallReply>;

// Reference to the shared EventBus
let eventBusRef: GenServerRef | null = null;

export function setEventBus(ref: GenServerRef): void {
  eventBusRef = ref;
}

/**
 * Creates a GenServer behavior for a WebSocket connection
 */
export function createConnectionBehavior(socket: WebSocket): GenServerBehavior<
  ConnectionState,
  ConnectionCallMsg,
  ConnectionCastMsg,
  ConnectionCallReply
> {
  return {
    init: () => ({
      socket,
      username: null,
      connectedAt: new Date(),
      messageCount: 0,
    }),

    handleCall: (msg, state) => {
      switch (msg.type) {
        case 'get_info':
          return [{
            username: state.username,
            connectedAt: state.connectedAt,
            messageCount: state.messageCount,
          }, state];

        case 'get_username':
          return [state.username, state];
      }
    },

    handleCast: (msg, state) => {
      switch (msg.type) {
        case 'send':
          // Send message directly to this connection
          if (state.socket.readyState === 1) { // WebSocket.OPEN
            state.socket.send(JSON.stringify(msg.payload));
          }
          return state;

        case 'set_username':
          return { ...state, username: msg.username };

        case 'broadcast':
          // Broadcast via EventBus to all connections
          if (eventBusRef) {
            EventBus.publish(eventBusRef, 'chat.message', {
              from: state.username || 'Anonymous',
              message: msg.message,
              timestamp: new Date().toISOString(),
            });
          }
          return { ...state, messageCount: state.messageCount + 1 };

        case 'ws_message':
          // Handle incoming WebSocket message
          return handleIncomingMessage(msg.data, state);
      }
    },

    terminate: (_reason, state) => {
      // Notify others that user left
      if (eventBusRef && state.username) {
        EventBus.publish(eventBusRef, 'chat.system', {
          type: 'user_left',
          username: state.username,
          timestamp: new Date().toISOString(),
        });
      }

      // Close socket if still open
      if (state.socket.readyState === 1) {
        state.socket.close();
      }
    },
  };
}

/**
 * Handle incoming WebSocket message and return new state
 */
function handleIncomingMessage(data: string, state: ConnectionState): ConnectionState {
  try {
    const msg = JSON.parse(data);

    switch (msg.type) {
      case 'join':
        // User joining with username
        if (msg.username && eventBusRef) {
          EventBus.publish(eventBusRef, 'chat.system', {
            type: 'user_joined',
            username: msg.username,
            timestamp: new Date().toISOString(),
          });
        }
        return { ...state, username: msg.username || state.username };

      case 'message':
        // Chat message - broadcast to all
        if (eventBusRef) {
          EventBus.publish(eventBusRef, 'chat.message', {
            from: state.username || 'Anonymous',
            message: msg.text,
            timestamp: new Date().toISOString(),
          });
        }
        return { ...state, messageCount: state.messageCount + 1 };

      case 'ping':
        // Respond to ping
        if (state.socket.readyState === 1) {
          state.socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
        return state;

      default:
        return state;
    }
  } catch {
    // Invalid JSON - ignore
    return state;
  }
}

/**
 * Start a new connection GenServer
 */
export async function startConnection(socket: WebSocket): Promise<ConnectionRef> {
  const behavior = createConnectionBehavior(socket);
  return GenServer.start(behavior);
}

/**
 * Send a message to a specific connection
 */
export function sendToConnection(ref: ConnectionRef, payload: unknown): void {
  GenServer.cast(ref, { type: 'send', payload });
}

/**
 * Get connection info
 */
export async function getConnectionInfo(ref: ConnectionRef): Promise<ConnectionInfo> {
  return GenServer.call(ref, { type: 'get_info' }) as Promise<ConnectionInfo>;
}
