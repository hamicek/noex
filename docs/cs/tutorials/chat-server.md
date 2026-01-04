# Tutoriál: Vytvoření WebSocket Chat Serveru

V tomto tutoriálu vytvoříte real-time chat server pomocí noex. Naučíte se:
- Vytvářet GenServery pro WebSocket připojení
- Používat EventBus pro broadcasting zpráv
- Organizovat služby pod Supervisor
- Zpracovávat životní cyklus připojení

## Předpoklady

- Node.js 18+
- Základní znalost TypeScriptu
- Pochopení základů noex GenServer

## Nastavení projektu

Vytvořte nový projekt:

```bash
mkdir chat-server
cd chat-server
npm init -y
npm install noex fastify @fastify/websocket @fastify/static
npm install -D typescript tsx @types/node
```

Vytvořte `tsconfig.json`:

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

## Přehled architektury

```
                    [ChatSupervisor]
                    /       |       \
            [EventBus]  [HTTP Server]  [ConnectionSupervisor]
                                        /    |    \
                                    [Conn1] [Conn2] [Conn3]
```

Každé WebSocket připojení je spravováno vlastním GenServerem, což poskytuje:
- Izolovaný stav pro každé připojení
- Serializované zpracování zpráv
- Čistou správu životního cyklu

---

## Krok 1: Connection GenServer

Každé WebSocket připojení získá vlastní GenServer. Vytvořte `src/connection.ts`:

```typescript
import type { WebSocket } from '@fastify/websocket';
import {
  GenServer,
  EventBus,
  type GenServerBehavior,
  type GenServerRef,
} from 'noex';

// Typy pro connection GenServer
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

// Reference na EventBus (nastaveno během inicializace)
let eventBusRef: GenServerRef | null = null;

export function setEventBus(ref: GenServerRef): void {
  eventBusRef = ref;
}

/**
 * Vytvoří behavior pro WebSocket connection GenServer
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
          // Odeslání zprávy tomuto připojení
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
      // Oznámení ostatním, že uživatel odešel
      if (eventBusRef && state.username) {
        EventBus.publish(eventBusRef, 'chat.system', {
          type: 'user_left',
          username: state.username,
          timestamp: new Date().toISOString(),
        });
      }

      // Zavření socketu, pokud je ještě otevřen
      if (state.socket.readyState === 1) {
        state.socket.close();
      }
    },
  };
}

/**
 * Zpracování příchozí WebSocket zprávy
 */
function handleIncomingMessage(
  data: string,
  state: ConnectionState
): ConnectionState {
  try {
    const msg = JSON.parse(data);

    switch (msg.type) {
      case 'join':
        // Uživatel se připojuje s username
        if (msg.username && eventBusRef) {
          EventBus.publish(eventBusRef, 'chat.system', {
            type: 'user_joined',
            username: msg.username,
            timestamp: new Date().toISOString(),
          });
        }
        return { ...state, username: msg.username || state.username };

      case 'message':
        // Broadcast chat zprávy všem
        if (eventBusRef) {
          EventBus.publish(eventBusRef, 'chat.message', {
            from: state.username || 'Anonymní',
            message: msg.text,
            timestamp: new Date().toISOString(),
          });
        }
        return { ...state, messageCount: state.messageCount + 1 };

      case 'ping':
        // Odpověď na ping
        if (state.socket.readyState === 1) {
          state.socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
        return state;

      default:
        return state;
    }
  } catch {
    // Neplatný JSON - ignorovat
    return state;
  }
}

/**
 * Spuštění nového connection GenServeru
 */
export async function startConnection(socket: WebSocket): Promise<ConnectionRef> {
  const behavior = createConnectionBehavior(socket);
  return GenServer.start(behavior);
}

/**
 * Odeslání zprávy do připojení
 */
export function sendToConnection(ref: ConnectionRef, payload: unknown): void {
  GenServer.cast(ref, { type: 'send', payload });
}
```

---

## Krok 2: Connection Manager

Vytvořte supervisor pro správu všech připojení. Vytvořte `src/connection-manager.ts`:

```typescript
import { Supervisor, GenServer, type SupervisorRef } from 'noex';
import type { WebSocket } from '@fastify/websocket';
import {
  startConnection,
  sendToConnection,
  type ConnectionRef,
} from './connection.js';

// Sledování aktivních připojení
const connections = new Map<string, ConnectionRef>();

let supervisorRef: SupervisorRef | null = null;

/**
 * Spuštění connection manager supervisoru
 */
export async function startConnectionManager(): Promise<SupervisorRef> {
  supervisorRef = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: {
      maxRestarts: 100,  // Připojení mohou často selhávat
      withinMs: 60000,
    },
  });

  return supervisorRef;
}

/**
 * Zpracování nového WebSocket připojení
 */
export async function handleNewConnection(socket: WebSocket): Promise<ConnectionRef> {
  const ref = await startConnection(socket);
  const connectionId = ref.id;

  connections.set(connectionId, ref);

  // Nastavení socket event handlerů
  socket.on('message', (data) => {
    GenServer.cast(ref, { type: 'ws_message', data: data.toString() });
  });

  socket.on('close', () => {
    connections.delete(connectionId);
    GenServer.stop(ref).catch(() => {
      // Již zastaveno
    });
  });

  socket.on('error', () => {
    connections.delete(connectionId);
    GenServer.stop(ref).catch(() => {});
  });

  return ref;
}

/**
 * Broadcast zprávy všem připojením
 */
export function broadcastToAll(payload: unknown): void {
  for (const ref of connections.values()) {
    sendToConnection(ref, payload);
  }
}

/**
 * Získání počtu aktivních připojení
 */
export function getConnectionCount(): number {
  return connections.size;
}

/**
 * Zastavení všech připojení a manageru
 */
export async function stopConnectionManager(): Promise<void> {
  if (supervisorRef) {
    await Supervisor.stop(supervisorRef);
  }
  connections.clear();
}
```

---

## Krok 3: Nastavení Chat Serveru

Vytvořte hlavní server. Vytvořte `src/server.ts`:

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
 * Spuštění chat serveru
 */
export async function startChatServer(port = 3000): Promise<SupervisorRef> {
  // 1. Vytvoření EventBus pro broadcasting zpráv
  const eventBus = await EventBus.start({ name: 'chat-events' });
  setEventBus(eventBus);

  // 2. Přihlášení k chat událostem a broadcast všem připojením
  await EventBus.subscribe(eventBus, 'chat.*', (message, topic) => {
    broadcastToAll({
      topic,
      ...message,
    });
  });

  // 3. Spuštění connection manageru
  const connectionManager = await startConnectionManager();

  // 4. Vytvoření Fastify serveru
  const fastify = Fastify({ logger: true });

  await fastify.register(fastifyWebsocket);
  await fastify.register(fastifyStatic, {
    root: join(__dirname, '../public'),
  });

  // WebSocket endpoint
  fastify.get('/ws', { websocket: true }, (socket, _request) => {
    handleNewConnection(socket).catch((err) => {
      fastify.log.error('Nepodařilo se zpracovat připojení:', err);
      socket.close();
    });
  });

  // API endpointy
  fastify.get('/api/stats', async () => ({
    connections: getConnectionCount(),
    timestamp: new Date().toISOString(),
  }));

  // Spuštění HTTP serveru
  await fastify.listen({ port, host: '0.0.0.0' });

  // 5. Vytvoření root supervisoru
  const rootSupervisor = await Supervisor.start({
    strategy: 'one_for_all',  // Pokud jeden selže, restartovat vše
    children: [
      { id: 'event-bus', start: async () => eventBus as any },
      { id: 'connections', start: async () => connectionManager as any },
    ],
  });

  console.log(`Chat server běží na http://localhost:${port}`);

  return rootSupervisor;
}
```

---

## Krok 4: Entry Point

Vytvořte `src/index.ts`:

```typescript
import { startChatServer } from './server.js';
import { stopConnectionManager } from './connection-manager.js';
import { Supervisor } from 'noex';

async function main() {
  const port = parseInt(process.env.PORT || '3000', 10);

  const supervisor = await startChatServer(port);

  // Graceful shutdown
  async function shutdown(signal: string) {
    console.log(`\nPřijat ${signal}, vypínám...`);

    await stopConnectionManager();
    await Supervisor.stop(supervisor);

    console.log('Shutdown dokončen');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Nepodařilo se spustit:', err);
  process.exit(1);
});
```

---

## Krok 5: Klientské HTML

Vytvořte `public/index.html`:

```html
<!DOCTYPE html>
<html lang="cs">
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
    <!-- Formulář pro připojení -->
    <div id="join-form">
      <h2>Zadejte své uživatelské jméno</h2>
      <br>
      <input type="text" id="username-input" placeholder="Uživatelské jméno" maxlength="20">
      <br>
      <button onclick="joinChat()">Připojit se do chatu</button>
    </div>

    <!-- Oblast chatu -->
    <div id="chat-area" class="hidden">
      <div id="messages"></div>
      <div class="input-area">
        <input type="text" id="message-input" placeholder="Napište zprávu..." onkeypress="handleKeyPress(event)">
        <button onclick="sendMessage()">Odeslat</button>
      </div>
    </div>
  </div>

  <script>
    let socket;
    let username;

    function joinChat() {
      username = document.getElementById('username-input').value.trim();
      if (!username) {
        alert('Prosím zadejte uživatelské jméno');
        return;
      }

      // Připojení k WebSocketu
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

      socket.onopen = () => {
        // Odeslání join zprávy
        socket.send(JSON.stringify({ type: 'join', username }));

        // Zobrazení chat oblasti
        document.getElementById('join-form').classList.add('hidden');
        document.getElementById('chat-area').classList.remove('hidden');
        document.getElementById('message-input').focus();
      };

      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        displayMessage(data);
      };

      socket.onclose = () => {
        addSystemMessage('Odpojeno od serveru');
      };

      socket.onerror = () => {
        addSystemMessage('Chyba připojení');
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
          addSystemMessage(`${data.username} se připojil do chatu`);
        } else if (data.type === 'user_left') {
          addSystemMessage(`${data.username} opustil chat`);
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

## Krok 6: Spuštění serveru

Přidejte skripty do `package.json`:

```json
{
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts"
  }
}
```

Spusťte server:

```bash
npm start
```

Otevřete `http://localhost:3000` ve více záložkách prohlížeče pro otestování chatu.

---

## Jak to funguje

### Tok zpráv

1. **Uživatel odešle zprávu** přes WebSocket
2. **Connection GenServer** přijme zprávu přes `ws_message` cast
3. **handleIncomingMessage** publikuje do EventBus
4. **EventBus subscriber** broadcastuje všem připojením
5. Každý **Connection GenServer** odešle do svého WebSocketu

```
Prohlížeč → WebSocket → Connection GenServer → EventBus → Všechna připojení → Všechny prohlížeče
```

### Fault Tolerance

- Každé připojení je izolované - jeden pád neovlivní ostatní
- Supervisor automaticky restartuje selhavší připojení
- EventBus pokračuje v běhu i když připojení selžou
- Graceful shutdown zajistí čisté odpojení

---

## Cvičení

### 1. Přidání soukromých zpráv

Rozšiřte protokol pro podporu soukromých zpráv:

```typescript
case 'private':
  // Odeslání pouze konkrétnímu uživateli
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

### 2. Přidání indikátoru psaní

Zobrazení, když uživatelé píší:

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

### 3. Přidání chat místností

Vytvořte oddělené EventBus topivy pro každou místnost:

```typescript
// Připojení do místnosti
EventBus.subscribe(eventBusRef, `room.${roomName}.*`, handler);

// Publikování do místnosti
EventBus.publish(eventBusRef, `room.${roomName}.message`, message);
```

### 4. Přidání monitorovacího dashboardu

Přidejte noex Dashboard pro monitoring připojení:

```typescript
import { Dashboard } from 'noex/dashboard';

const dashboard = new Dashboard({ layout: 'compact' });
dashboard.start();
```

---

## Další kroky

- [Tutoriál Rate-Limited API](./rate-limited-api.md) - Vytvoření API s rate limitingem
- [EventBus API](../api/event-bus.md) - Více o EventBus
- [Příručka Supervision Trees](../guides/supervision-trees.md) - Pokročilé vzory supervize
