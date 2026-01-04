# Web Server

WebSocket chat server s per-connection GenServery.

## Přehled

Tento příklad ukazuje:
- Správu GenServerů pro jednotlivá připojení
- EventBus pro broadcasting zpráv
- Registry pro vyhledávání podle jména
- Integraci s Fastify web serverem

## Architektura

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

Každé WebSocket připojení je spravováno vlastním GenServerem:

```typescript
import type { WebSocket } from '@fastify/websocket';
import { GenServer, EventBus, type GenServerBehavior, type GenServerRef } from 'noex';

// Typy zpráv
type ConnectionCall = { type: 'get_info' } | { type: 'get_username' };

type ConnectionCast =
  | { type: 'send'; payload: unknown }
  | { type: 'broadcast'; message: string }
  | { type: 'set_username'; username: string }
  | { type: 'ws_message'; data: string };

// Stav
interface ConnectionState {
  socket: WebSocket;
  username: string | null;
  connectedAt: Date;
  messageCount: number;
}

// EventBus reference pro broadcasting
let eventBusRef: GenServerRef | null = null;

export function setEventBus(ref: GenServerRef): void {
  eventBusRef = ref;
}

// Chování Connection GenServeru
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
          // Odešli přímo tomuto připojení
          if (state.socket.readyState === 1) {
            state.socket.send(JSON.stringify(msg.payload));
          }
          return state;

        case 'set_username':
          return { ...state, username: msg.username };

        case 'broadcast':
          // Broadcast přes EventBus všem připojením
          if (eventBusRef) {
            EventBus.publish(eventBusRef, 'chat.message', {
              from: state.username || 'Anonym',
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
      // Upozorni ostatní
      if (eventBusRef && state.username) {
        EventBus.publish(eventBusRef, 'chat.system', {
          type: 'user_left',
          username: state.username,
          timestamp: new Date().toISOString(),
        });
      }

      // Zavři socket
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
            from: state.username || 'Anonym',
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

## Hlavní server

```typescript
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { GenServer, EventBus, Supervisor } from 'noex';
import { createConnectionBehavior, setEventBus } from './connection';

async function main() {
  // Vytvoř supervizovaný EventBus
  const eventBus = await EventBus.start();
  setEventBus(eventBus);

  // Sleduj všechna připojení
  const connections = new Map<string, GenServerRef>();

  // Přihlaš se k odběru zpráv pro broadcasting
  await EventBus.subscribe(eventBus, 'chat.*', async (topic, data) => {
    const message = JSON.stringify({ topic, data });
    for (const conn of connections.values()) {
      GenServer.cast(conn, { type: 'send', payload: { topic, data } });
    }
  });

  // Vytvoř Fastify server
  const server = Fastify();
  await server.register(websocket);

  // WebSocket route
  server.get('/ws', { websocket: true }, (socket, req) => {
    const connId = crypto.randomUUID();

    // Spusť Connection GenServer
    GenServer.start(createConnectionBehavior(socket)).then(ref => {
      connections.set(connId, ref);

      // Zpracuj příchozí zprávy
      socket.on('message', (data) => {
        GenServer.cast(ref, { type: 'ws_message', data: data.toString() });
      });

      // Zpracuj odpojení
      socket.on('close', async () => {
        await GenServer.stop(ref);
        connections.delete(connId);
      });
    });
  });

  // Health check
  server.get('/health', async () => ({ status: 'ok', connections: connections.size }));

  // Spusť server
  await server.listen({ port: 3000 });
  console.log('Server běží na http://localhost:3000');
}

main().catch(console.error);
```

## Klíčové vzory

### Izolace per-connection

Každé připojení má vlastní GenServer, což poskytuje:
- Izolovaný stav (žádný sdílený mutabilní stav)
- Serializované zpracování zpráv (žádné race conditions)
- Čistou správu životního cyklu

### EventBus broadcasting

EventBus odděluje odesílatele zpráv od příjemců:

```typescript
// Publikuj zprávu
EventBus.publish(eventBus, 'chat.message', { from: 'Alice', message: 'Ahoj!' });

// Přihlaš se k odběru zpráv
await EventBus.subscribe(eventBus, 'chat.*', (topic, data) => {
  // Zpracuj zprávu
});
```

### Elegantní ukončení

Connection GenServery uklízí prostředky v jejich `terminate` callbacku:

```typescript
terminate: (_reason, state) => {
  // Upozorni ostatní
  if (eventBusRef && state.username) {
    EventBus.publish(eventBusRef, 'chat.system', { type: 'user_left', ... });
  }
  // Zavři socket
  state.socket.close();
},
```

## Přidání supervize

Pro fault-tolerance obalte připojení do Supervisoru:

```typescript
const connectionSupervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [],
});

// Přidávej připojení dynamicky
await Supervisor.startChild(connectionSupervisor, {
  id: connId,
  start: () => GenServer.start(createConnectionBehavior(socket)),
  restart: 'temporary', // Nerestartuj při odpojení
});
```

## Související

- [Chat Server tutoriál](../tutorials/chat-server.md) - Kompletní tutoriál krok za krokem
- [EventBus API](../api/event-bus.md) - Reference EventBus
- [Koncept Supervisor](../concepts/supervisor.md) - Vzory supervize
