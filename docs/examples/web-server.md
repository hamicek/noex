# Web Server

WebSocket chat server with per-connection GenServers.

## Overview

This example shows:
- Per-connection GenServer management
- EventBus for message broadcasting
- Registry for named lookups
- Integration with Fastify web server

## Architecture

```
                    ┌─────────────┐
                    │   Fastify   │
                    │   Server    │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  EventBus   │
                    │ (broadcast) │
                    └──────┬──────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   ┌────▼────┐       ┌────▼────┐       ┌────▼────┐
   │ Conn 1  │       │ Conn 2  │       │ Conn 3  │
   │GenServer│       │GenServer│       │GenServer│
   └─────────┘       └─────────┘       └─────────┘
```

## Connection GenServer

Each WebSocket connection is managed by its own GenServer:

```typescript
import type { WebSocket } from '@fastify/websocket';
import { GenServer, EventBus, type GenServerBehavior, type GenServerRef } from 'noex';

// Message types
type ConnectionCall = { type: 'get_info' } | { type: 'get_username' };

type ConnectionCast =
  | { type: 'send'; payload: unknown }
  | { type: 'broadcast'; message: string }
  | { type: 'set_username'; username: string }
  | { type: 'ws_message'; data: string };

// State
interface ConnectionState {
  socket: WebSocket;
  username: string | null;
  connectedAt: Date;
  messageCount: number;
}

// EventBus reference for broadcasting
let eventBusRef: GenServerRef | null = null;

export function setEventBus(ref: GenServerRef): void {
  eventBusRef = ref;
}

// Connection GenServer behavior
export function createConnectionBehavior(socket: WebSocket): GenServerBehavior<
  ConnectionState,
  ConnectionCall,
  ConnectionCast,
  unknown
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
          // Send directly to this connection
          if (state.socket.readyState === 1) {
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
          return handleIncomingMessage(msg.data, state);
      }
    },

    terminate: (_reason, state) => {
      // Notify others
      if (eventBusRef && state.username) {
        EventBus.publish(eventBusRef, 'chat.system', {
          type: 'user_left',
          username: state.username,
          timestamp: new Date().toISOString(),
        });
      }

      // Close socket
      if (state.socket.readyState === 1) {
        state.socket.close();
      }
    },
  };
}

function handleIncomingMessage(data: string, state: ConnectionState): ConnectionState {
  try {
    const msg = JSON.parse(data);

    switch (msg.type) {
      case 'join':
        if (msg.username && eventBusRef) {
          EventBus.publish(eventBusRef, 'chat.system', {
            type: 'user_joined',
            username: msg.username,
            timestamp: new Date().toISOString(),
          });
        }
        return { ...state, username: msg.username || state.username };

      case 'message':
        if (eventBusRef) {
          EventBus.publish(eventBusRef, 'chat.message', {
            from: state.username || 'Anonymous',
            message: msg.text,
            timestamp: new Date().toISOString(),
          });
        }
        return { ...state, messageCount: state.messageCount + 1 };

      case 'ping':
        if (state.socket.readyState === 1) {
          state.socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
        return state;

      default:
        return state;
    }
  } catch {
    return state;
  }
}
```

## Main Server

```typescript
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { GenServer, EventBus, Supervisor } from 'noex';
import { createConnectionBehavior, setEventBus } from './connection';

async function main() {
  // Create supervised EventBus
  const eventBus = await EventBus.start();
  setEventBus(eventBus);

  // Track all connections
  const connections = new Map<string, GenServerRef>();

  // Subscribe to messages for broadcasting
  await EventBus.subscribe(eventBus, 'chat.*', async (topic, data) => {
    const message = JSON.stringify({ topic, data });
    for (const conn of connections.values()) {
      GenServer.cast(conn, { type: 'send', payload: { topic, data } });
    }
  });

  // Create Fastify server
  const server = Fastify();
  await server.register(websocket);

  // WebSocket route
  server.get('/ws', { websocket: true }, (socket, req) => {
    const connId = crypto.randomUUID();

    // Start connection GenServer
    GenServer.start(createConnectionBehavior(socket)).then(ref => {
      connections.set(connId, ref);

      // Handle incoming messages
      socket.on('message', (data) => {
        GenServer.cast(ref, { type: 'ws_message', data: data.toString() });
      });

      // Handle disconnect
      socket.on('close', async () => {
        await GenServer.stop(ref);
        connections.delete(connId);
      });
    });
  });

  // Health check
  server.get('/health', async () => ({ status: 'ok', connections: connections.size }));

  // Start server
  await server.listen({ port: 7201 });
  console.log('Server running on http://localhost:7201');
}

main().catch(console.error);
```

## Key Patterns

### Per-Connection Isolation

Each connection has its own GenServer, providing:
- Isolated state (no shared mutable state)
- Serialized message processing (no race conditions)
- Clean lifecycle management

### EventBus Broadcasting

The EventBus decouples message senders from receivers:

```typescript
// Publish a message
EventBus.publish(eventBus, 'chat.message', { from: 'Alice', message: 'Hello!' });

// Subscribe to messages
await EventBus.subscribe(eventBus, 'chat.*', (topic, data) => {
  // Handle message
});
```

### Graceful Shutdown

Connection GenServers clean up resources in their `terminate` callback:

```typescript
terminate: (_reason, state) => {
  // Notify others
  if (eventBusRef && state.username) {
    EventBus.publish(eventBusRef, 'chat.system', { type: 'user_left', ... });
  }
  // Close socket
  state.socket.close();
},
```

## Adding Supervision

For fault tolerance, wrap connections in a Supervisor:

```typescript
const connectionSupervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [],
});

// Add connections dynamically
await Supervisor.startChild(connectionSupervisor, {
  id: connId,
  start: () => GenServer.start(createConnectionBehavior(socket)),
  restart: 'temporary', // Don't restart on disconnect
});
```

## Related

- [Chat Server Tutorial](../tutorials/chat-server.md) - Full step-by-step tutorial
- [EventBus API](../api/event-bus.md) - EventBus reference
- [Supervisor Concept](../concepts/supervisor.md) - Supervision patterns
