# Tutorial: Building a WebSocket Chat Server

In this tutorial, you'll build a real-time chat server using noex. You'll learn how to:
- Create GenServers for WebSocket connections
- Use EventBus for broadcasting messages
- Organize services under a Supervisor
- Handle connection lifecycle

## Prerequisites

- Node.js 18+
- Basic TypeScript knowledge
- Understanding of noex GenServer basics

## Project Setup

Create a new project:

```bash
mkdir chat-server
cd chat-server
npm init -y
npm install noex fastify @fastify/websocket @fastify/static
npm install -D typescript tsx @types/node
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

## Architecture Overview

```
                    [ChatSupervisor]
                    /       |       \
            [EventBus]  [HTTP Server]  [ConnectionSupervisor]
                                        /    |    \
                                    [Conn1] [Conn2] [Conn3]
```

Each WebSocket connection is managed by its own GenServer, providing:
- Isolated state per connection
- Serialized message processing
- Clean lifecycle management

---

## Step 1: Connection GenServer

Each WebSocket connection gets its own GenServer. Create `src/connection.ts`:

```typescript
import type { WebSocket } from '@fastify/websocket';
import {
  GenServer,
  EventBus,
  type GenServerBehavior,
  type GenServerRef,
} from 'noex';

// Types for the connection GenServer
export interface ConnectionState {
  socket: WebSocket;
  username: string | null;
  connectedAt: Date;
  messageCount: number;
}

export type ConnectionCall =
  | { type: 'get_info' }
  | { type: 'get_username' };

export type ConnectionCast =
  | { type: 'send'; payload: unknown }
  | { type: 'set_username'; username: string }
  | { type: 'ws_message'; data: string };

export type ConnectionReply =
  | { username: string | null; connectedAt: Date; messageCount: number }
  | string
  | null;

export type ConnectionRef = GenServerRef<
  ConnectionState,
  ConnectionCall,
  ConnectionCast,
  ConnectionReply
>;

// EventBus reference (set during initialization)
let eventBusRef: GenServerRef | null = null;

export function setEventBus(ref: GenServerRef): void {
  eventBusRef = ref;
}

/**
 * Creates the behavior for a WebSocket connection GenServer
 */
export function createConnectionBehavior(
  socket: WebSocket
): GenServerBehavior<ConnectionState, ConnectionCall, ConnectionCast, ConnectionReply> {
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
          // Send message to this connection
          if (state.socket.readyState === 1) {
            state.socket.send(JSON.stringify(msg.payload));
          }
          return state;

        case 'set_username':
          return { ...state, username: msg.username };

        case 'ws_message':
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
 * Handle incoming WebSocket message
 */
function handleIncomingMessage(
  data: string,
  state: ConnectionState
): ConnectionState {
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
        // Broadcast chat message to all
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
 * Send a message to a connection
 */
export function sendToConnection(ref: ConnectionRef, payload: unknown): void {
  GenServer.cast(ref, { type: 'send', payload });
}
```

---

## Step 2: Connection Manager

Create a supervisor to manage all connections. Create `src/connection-manager.ts`:

```typescript
import { Supervisor, GenServer, type SupervisorRef } from 'noex';
import type { WebSocket } from '@fastify/websocket';
import {
  startConnection,
  sendToConnection,
  type ConnectionRef,
} from './connection.js';

// Track active connections
const connections = new Map<string, ConnectionRef>();

let supervisorRef: SupervisorRef | null = null;

/**
 * Start the connection manager supervisor
 */
export async function startConnectionManager(): Promise<SupervisorRef> {
  supervisorRef = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: {
      maxRestarts: 100,  // Connections can fail often
      withinMs: 60000,
    },
  });

  return supervisorRef;
}

/**
 * Handle a new WebSocket connection
 */
export async function handleNewConnection(socket: WebSocket): Promise<ConnectionRef> {
  const ref = await startConnection(socket);
  const connectionId = ref.id;

  connections.set(connectionId, ref);

  // Set up socket event handlers
  socket.on('message', (data) => {
    GenServer.cast(ref, { type: 'ws_message', data: data.toString() });
  });

  socket.on('close', () => {
    connections.delete(connectionId);
    GenServer.stop(ref).catch(() => {
      // Already stopped
    });
  });

  socket.on('error', () => {
    connections.delete(connectionId);
    GenServer.stop(ref).catch(() => {});
  });

  return ref;
}

/**
 * Broadcast a message to all connections
 */
export function broadcastToAll(payload: unknown): void {
  for (const ref of connections.values()) {
    sendToConnection(ref, payload);
  }
}

/**
 * Get the number of active connections
 */
export function getConnectionCount(): number {
  return connections.size;
}

/**
 * Stop all connections and the manager
 */
export async function stopConnectionManager(): Promise<void> {
  if (supervisorRef) {
    await Supervisor.stop(supervisorRef);
  }
  connections.clear();
}
```

---

## Step 3: Chat Server Setup

Create the main server. Create `src/server.ts`:

```typescript
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { EventBus, Supervisor, type SupervisorRef } from 'noex';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { setEventBus } from './connection.js';
import {
  startConnectionManager,
  handleNewConnection,
  broadcastToAll,
  getConnectionCount,
  stopConnectionManager,
} from './connection-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Start the chat server
 */
export async function startChatServer(port = 7201): Promise<SupervisorRef> {
  // 1. Create EventBus for message broadcasting
  const eventBus = await EventBus.start({ name: 'chat-events' });
  setEventBus(eventBus);

  // 2. Subscribe to chat events and broadcast to all connections
  await EventBus.subscribe(eventBus, 'chat.*', (message, topic) => {
    broadcastToAll({
      topic,
      ...message,
    });
  });

  // 3. Start connection manager
  const connectionManager = await startConnectionManager();

  // 4. Create Fastify server
  const fastify = Fastify({ logger: true });

  await fastify.register(fastifyWebsocket);
  await fastify.register(fastifyStatic, {
    root: join(__dirname, '../public'),
  });

  // WebSocket endpoint
  fastify.get('/ws', { websocket: true }, (socket, _request) => {
    handleNewConnection(socket).catch((err) => {
      fastify.log.error('Failed to handle connection:', err);
      socket.close();
    });
  });

  // API endpoints
  fastify.get('/api/stats', async () => ({
    connections: getConnectionCount(),
    timestamp: new Date().toISOString(),
  }));

  // Start HTTP server
  await fastify.listen({ port, host: '0.0.0.0' });

  // 5. Create root supervisor
  const rootSupervisor = await Supervisor.start({
    strategy: 'one_for_all',  // If one fails, restart all
    children: [
      { id: 'event-bus', start: async () => eventBus as any },
      { id: 'connections', start: async () => connectionManager as any },
    ],
  });

  console.log(`Chat server running at http://localhost:${port}`);

  return rootSupervisor;
}
```

---

## Step 4: Entry Point

Create `src/index.ts`:

```typescript
import { startChatServer } from './server.js';
import { stopConnectionManager } from './connection-manager.js';
import { Supervisor } from 'noex';

async function main() {
  const port = parseInt(process.env.PORT || '7201', 10);

  const supervisor = await startChatServer(port);

  // Graceful shutdown
  async function shutdown(signal: string) {
    console.log(`\nReceived ${signal}, shutting down...`);

    await stopConnectionManager();
    await Supervisor.stop(supervisor);

    console.log('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
```

---

## Step 5: Client HTML

Create `public/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>noex Chat</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      background: #16213e;
      padding: 1rem;
      text-align: center;
    }
    .header h1 { font-size: 1.5rem; color: #0f3460; }
    .header h1 { color: #e94560; }
    .container {
      flex: 1;
      display: flex;
      flex-direction: column;
      max-width: 800px;
      margin: 0 auto;
      width: 100%;
      padding: 1rem;
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      background: #16213e;
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1rem;
    }
    .message {
      margin-bottom: 0.5rem;
      padding: 0.5rem;
      border-radius: 4px;
      background: #1a1a2e;
    }
    .message.system {
      color: #888;
      font-style: italic;
      background: transparent;
    }
    .message .username {
      color: #e94560;
      font-weight: bold;
    }
    .message .time {
      color: #666;
      font-size: 0.8rem;
      margin-left: 0.5rem;
    }
    .input-area {
      display: flex;
      gap: 0.5rem;
    }
    input, button {
      padding: 0.75rem 1rem;
      border: none;
      border-radius: 4px;
      font-size: 1rem;
    }
    input {
      flex: 1;
      background: #16213e;
      color: #eee;
    }
    input:focus { outline: 2px solid #e94560; }
    button {
      background: #e94560;
      color: white;
      cursor: pointer;
    }
    button:hover { background: #c73e54; }
    #join-form {
      text-align: center;
      padding: 2rem;
    }
    #join-form input {
      width: 100%;
      max-width: 300px;
      margin-bottom: 1rem;
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="header">
    <h1>noex Chat</h1>
  </div>

  <div class="container">
    <!-- Join Form -->
    <div id="join-form">
      <h2>Enter your username</h2>
      <br>
      <input type="text" id="username-input" placeholder="Username" maxlength="20">
      <br>
      <button onclick="joinChat()">Join Chat</button>
    </div>

    <!-- Chat Area -->
    <div id="chat-area" class="hidden">
      <div id="messages"></div>
      <div class="input-area">
        <input type="text" id="message-input" placeholder="Type a message..." onkeypress="handleKeyPress(event)">
        <button onclick="sendMessage()">Send</button>
      </div>
    </div>
  </div>

  <script>
    let socket;
    let username;

    function joinChat() {
      username = document.getElementById('username-input').value.trim();
      if (!username) {
        alert('Please enter a username');
        return;
      }

      // Connect to WebSocket
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

      socket.onopen = () => {
        // Send join message
        socket.send(JSON.stringify({ type: 'join', username }));

        // Show chat area
        document.getElementById('join-form').classList.add('hidden');
        document.getElementById('chat-area').classList.remove('hidden');
        document.getElementById('message-input').focus();
      };

      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        displayMessage(data);
      };

      socket.onclose = () => {
        addSystemMessage('Disconnected from server');
      };

      socket.onerror = () => {
        addSystemMessage('Connection error');
      };
    }

    function sendMessage() {
      const input = document.getElementById('message-input');
      const text = input.value.trim();

      if (text && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'message', text }));
        input.value = '';
      }
    }

    function handleKeyPress(event) {
      if (event.key === 'Enter') {
        sendMessage();
      }
    }

    function displayMessage(data) {
      const messages = document.getElementById('messages');

      if (data.topic === 'chat.system') {
        if (data.type === 'user_joined') {
          addSystemMessage(`${data.username} joined the chat`);
        } else if (data.type === 'user_left') {
          addSystemMessage(`${data.username} left the chat`);
        }
      } else if (data.topic === 'chat.message') {
        const div = document.createElement('div');
        div.className = 'message';
        const time = new Date(data.timestamp).toLocaleTimeString();
        div.innerHTML = `<span class="username">${escapeHtml(data.from)}</span><span class="time">${time}</span><br>${escapeHtml(data.message)}`;
        messages.appendChild(div);
      }

      messages.scrollTop = messages.scrollHeight;
    }

    function addSystemMessage(text) {
      const messages = document.getElementById('messages');
      const div = document.createElement('div');
      div.className = 'message system';
      div.textContent = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  </script>
</body>
</html>
```

---

## Step 6: Run the Server

Add scripts to `package.json`:

```json
{
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts"
  }
}
```

Run the server:

```bash
npm start
```

Open `http://localhost:7201` in multiple browser tabs to test the chat.

---

## How It Works

### Message Flow

1. **User sends message** via WebSocket
2. **Connection GenServer** receives message via `ws_message` cast
3. **handleIncomingMessage** publishes to EventBus
4. **EventBus subscriber** broadcasts to all connections
5. Each **Connection GenServer** sends to its WebSocket

```
Browser → WebSocket → Connection GenServer → EventBus → All Connections → All Browsers
```

### Fault Tolerance

- Each connection is isolated - one crash doesn't affect others
- Supervisor automatically restarts failed connections
- EventBus continues running even if connections fail
- Graceful shutdown ensures clean disconnection

---

## Exercises

### 1. Add Private Messaging

Extend the protocol to support private messages:

```typescript
case 'private':
  // Send only to specific user
  const targetConn = findConnectionByUsername(msg.to);
  if (targetConn) {
    sendToConnection(targetConn, {
      type: 'private',
      from: state.username,
      message: msg.text,
    });
  }
  return state;
```

### 2. Add Typing Indicators

Show when users are typing:

```typescript
case 'typing':
  if (eventBusRef) {
    EventBus.publish(eventBusRef, 'chat.typing', {
      username: state.username,
      timestamp: new Date().toISOString(),
    });
  }
  return state;
```

### 3. Add Chat Rooms

Create separate EventBus topics per room:

```typescript
// Join room
EventBus.subscribe(eventBusRef, `room.${roomName}.*`, handler);

// Publish to room
EventBus.publish(eventBusRef, `room.${roomName}.message`, message);
```

### 4. Add Monitoring Dashboard

Add the noex Dashboard to monitor connections:

```typescript
import { Dashboard } from 'noex/dashboard';

const dashboard = new Dashboard({ layout: 'compact' });
dashboard.start();
```

---

## Next Steps

- [Rate-Limited API Tutorial](./rate-limited-api.md) - Build an API with rate limiting
- [EventBus API](../api/event-bus.md) - Learn more about EventBus
- [Supervision Trees Guide](../guides/supervision-trees.md) - Advanced supervision patterns
