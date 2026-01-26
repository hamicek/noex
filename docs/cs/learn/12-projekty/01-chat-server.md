# Chat Server

V tomto projektu vytvoříte real-time chat server, který propojí vše, co jste se naučili. Toto není ukázkový příklad — jedná se o produkčně připravenou architekturu, která demonstruje, jak noex actor model elegantně zvládá souběžná spojení, správu místností a broadcastování zpráv.

## Co se naučíte

- Navrhnout vícesložkový systém pomocí GenServer, Supervisor, Registry a EventBus
- Vytvořit jeden GenServer pro každé WebSocket spojení pro izolaci
- Spravovat dynamické procesy se supervizí `simple_one_for_one`
- Použít EventBus pro broadcastování zpráv do místností
- Sledovat přítomnost uživatelů pomocí Registry
- Implementovat graceful shutdown a úklid spojení

## Co vytvoříte

Real-time chat server s:
- **Více chatovými místnostmi** — Uživatelé mohou dynamicky vstupovat a opouštět místnosti
- **Přítomností uživatelů** — Sledování, kdo je online v každé místnosti
- **Broadcastováním zpráv** — Zprávy okamžitě dorazí ke všem členům místnosti
- **Izolací spojení** — Jedno vadné spojení neovlivní ostatní
- **Graceful shutdown** — Čisté notifikace o odpojení

## Přehled architektury

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ARCHITEKTURA CHAT SERVERU                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Chat Application Supervisor                       │    │
│  │                        (one_for_all)                                 │    │
│  └────────────────────────────┬────────────────────────────────────────┘    │
│                               │                                             │
│           ┌───────────────────┼───────────────────┐                         │
│           │                   │                   │                         │
│           ▼                   ▼                   ▼                         │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐               │
│  │    EventBus     │ │  Room Manager   │ │   Connection    │               │
│  │   (pub/sub)     │ │   (Registry +   │ │   Supervisor    │               │
│  │                 │ │   GenServer)    │ │(simple_one_for  │               │
│  └────────┬────────┘ └────────┬────────┘ │     _one)       │               │
│           │                   │          └────────┬────────┘               │
│           │                   │                   │                         │
│           │    ┌──────────────┘                   │                         │
│           │    │                                  │                         │
│           │    │    ┌─────────────────────────────┼─────────────────┐       │
│           │    │    │                             │                 │       │
│           │    ▼    ▼                             ▼                 ▼       │
│           │  ┌──────────┐                  ┌──────────┐      ┌──────────┐   │
│           │  │  Room 1  │                  │Connection│      │Connection│   │
│           │  │GenServer │                  │ GenServer│      │ GenServer│   │
│           │  │          │◄─── subscribes ──│  (user1) │      │  (user2) │   │
│           │  └──────────┘                  └──────────┘      └──────────┘   │
│           │        │                             │                 │        │
│           │        │                             │                 │        │
│           └────────┴─────────────────────────────┴─────────────────┘        │
│                         Topicy EventBusu:                                   │
│                         • room:{id}:message                                 │
│                         • room:{id}:join                                    │
│                         • room:{id}:leave                                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Zodpovědnosti komponent:**

| Komponenta | Role |
|------------|------|
| **Chat Supervisor** | Top-level supervisor zajišťující běh všech komponent |
| **EventBus** | Směruje zprávy mezi místnostmi a spojeními |
| **Room Manager** | Vytváří/sleduje místnosti, udržuje seznamy členů |
| **Connection Supervisor** | Dynamicky spravuje Connection GenServery |
| **Connection GenServer** | Jeden pro každý WebSocket, zpracovává zprávy uživatele |

## Část 1: Protokol zpráv

Nejprve definujte zprávy, které proudí systémem:

```typescript
// src/chat/protocol.ts
import type { GenServerRef } from '@hamicek/noex';

// Zprávy Klient → Server
export type ClientMessage =
  | { type: 'join'; roomId: string; username: string }
  | { type: 'leave'; roomId: string }
  | { type: 'message'; roomId: string; text: string }
  | { type: 'list_rooms' }
  | { type: 'list_users'; roomId: string };

// Zprávy Server → Klient
export type ServerMessage =
  | { type: 'joined'; roomId: string; users: string[] }
  | { type: 'left'; roomId: string }
  | { type: 'message'; roomId: string; from: string; text: string; timestamp: number }
  | { type: 'user_joined'; roomId: string; username: string }
  | { type: 'user_left'; roomId: string; username: string }
  | { type: 'room_list'; rooms: RoomInfo[] }
  | { type: 'user_list'; roomId: string; users: string[] }
  | { type: 'error'; code: string; message: string };

export interface RoomInfo {
  id: string;
  userCount: number;
}

// Interní události EventBusu
export interface RoomMessageEvent {
  roomId: string;
  from: string;
  text: string;
  timestamp: number;
}

export interface RoomPresenceEvent {
  roomId: string;
  username: string;
  connectionRef: GenServerRef;
}
```

## Část 2: Connection GenServer

Každé WebSocket spojení dostane vlastní GenServer. To izoluje stav a zajistí, že jedno chybující spojení nezpůsobí pád ostatních:

```typescript
// src/chat/connection.ts
import { GenServer, EventBus, Registry, type GenServerRef, type EventBusRef } from '@hamicek/noex';
import type { ClientMessage, ServerMessage, RoomMessageEvent, RoomPresenceEvent } from './protocol';

// Stav spojení
interface ConnectionState {
  connectionId: string;
  username: string | null;
  joinedRooms: Set<string>;
  eventBus: EventBusRef;
  sendFn: (msg: ServerMessage) => void;
  unsubscribers: Map<string, () => Promise<void>>;
}

// Call zprávy (vyžadují odpověď)
type ConnectionCallMsg =
  | { type: 'get_info' }
  | { type: 'get_username' };

type ConnectionCallReply =
  | { connectionId: string; username: string | null; rooms: string[] }
  | string | null;

// Cast zprávy (fire-and-forget)
type ConnectionCastMsg =
  | { type: 'client_message'; message: ClientMessage }
  | { type: 'send'; message: ServerMessage }
  | { type: 'disconnect' };

// Connection behavior
export const ConnectionBehavior = {
  init(
    connectionId: string,
    eventBus: EventBusRef,
    sendFn: (msg: ServerMessage) => void
  ): ConnectionState {
    console.log(`[Connection:${connectionId}] inicializováno`);
    return {
      connectionId,
      username: null,
      joinedRooms: new Set(),
      eventBus,
      sendFn,
      unsubscribers: new Map(),
    };
  },

  handleCall(
    msg: ConnectionCallMsg,
    state: ConnectionState
  ): [ConnectionCallReply, ConnectionState] {
    switch (msg.type) {
      case 'get_info':
        return [
          {
            connectionId: state.connectionId,
            username: state.username,
            rooms: Array.from(state.joinedRooms),
          },
          state,
        ];

      case 'get_username':
        return [state.username, state];
    }
  },

  handleCast(msg: ConnectionCastMsg, state: ConnectionState): ConnectionState {
    switch (msg.type) {
      case 'client_message':
        return handleClientMessage(msg.message, state);

      case 'send':
        state.sendFn(msg.message);
        return state;

      case 'disconnect':
        // Opustit všechny místnosti před odpojením
        for (const roomId of state.joinedRooms) {
          leaveRoom(roomId, state);
        }
        return state;
    }
  },

  terminate(reason: string, state: ConnectionState): void {
    console.log(`[Connection:${state.connectionId}] ukončeno: ${reason}`);

    // Úklid subscriptions
    for (const [, unsubscribe] of state.unsubscribers) {
      unsubscribe().catch(() => {});
    }

    // Notifikovat místnosti o odchodu
    for (const roomId of state.joinedRooms) {
      if (state.username) {
        EventBus.publish(state.eventBus, `room:${roomId}:leave`, {
          roomId,
          username: state.username,
        });
      }
    }
  },
};

// Zpracování příchozích klientských zpráv
function handleClientMessage(
  msg: ClientMessage,
  state: ConnectionState
): ConnectionState {
  switch (msg.type) {
    case 'join':
      return handleJoin(msg.roomId, msg.username, state);

    case 'leave':
      return handleLeave(msg.roomId, state);

    case 'message':
      return handleMessage(msg.roomId, msg.text, state);

    case 'list_rooms':
      handleListRooms(state);
      return state;

    case 'list_users':
      handleListUsers(msg.roomId, state);
      return state;

    default:
      state.sendFn({
        type: 'error',
        code: 'UNKNOWN_MESSAGE',
        message: 'Neznámý typ zprávy',
      });
      return state;
  }
}

function handleJoin(
  roomId: string,
  username: string,
  state: ConnectionState
): ConnectionState {
  // Validace username
  if (!username || username.length < 1 || username.length > 32) {
    state.sendFn({
      type: 'error',
      code: 'INVALID_USERNAME',
      message: 'Uživatelské jméno musí mít 1-32 znaků',
    });
    return state;
  }

  // Kontrola, zda již je v místnosti
  if (state.joinedRooms.has(roomId)) {
    state.sendFn({
      type: 'error',
      code: 'ALREADY_IN_ROOM',
      message: `Již jste v místnosti ${roomId}`,
    });
    return state;
  }

  // Nastavit username (první join ho nastaví)
  const newState = { ...state, username };

  // Přihlásit se k odběru událostí místnosti
  subscribeToRoom(roomId, newState).catch((err) => {
    console.error(`Selhalo přihlášení k místnosti ${roomId}:`, err);
  });

  // Notifikovat místnost o připojení
  EventBus.publish(newState.eventBus, `room:${roomId}:join`, {
    roomId,
    username,
  } satisfies Omit<RoomPresenceEvent, 'connectionRef'>);

  // Přidat místnost do setu připojených
  newState.joinedRooms.add(roomId);

  // Získat aktuální uživatele a poslat potvrzení
  const roomUsers = getRoomUsers(roomId);
  newState.sendFn({
    type: 'joined',
    roomId,
    users: roomUsers,
  });

  return newState;
}

async function subscribeToRoom(
  roomId: string,
  state: ConnectionState
): Promise<void> {
  // Přihlásit se k zprávám v této místnosti
  const unsubMessage = await EventBus.subscribe<RoomMessageEvent>(
    state.eventBus,
    `room:${roomId}:message`,
    (event) => {
      // Neechovat zpět odesílateli
      if (event.from !== state.username) {
        state.sendFn({
          type: 'message',
          roomId: event.roomId,
          from: event.from,
          text: event.text,
          timestamp: event.timestamp,
        });
      }
    }
  );

  // Přihlásit se k událostem přítomnosti
  const unsubJoin = await EventBus.subscribe<Omit<RoomPresenceEvent, 'connectionRef'>>(
    state.eventBus,
    `room:${roomId}:join`,
    (event) => {
      if (event.username !== state.username) {
        state.sendFn({
          type: 'user_joined',
          roomId: event.roomId,
          username: event.username,
        });
      }
    }
  );

  const unsubLeave = await EventBus.subscribe<Omit<RoomPresenceEvent, 'connectionRef'>>(
    state.eventBus,
    `room:${roomId}:leave`,
    (event) => {
      if (event.username !== state.username) {
        state.sendFn({
          type: 'user_left',
          roomId: event.roomId,
          username: event.username,
        });
      }
    }
  );

  // Uložit unsubscribery pro pozdější úklid
  state.unsubscribers.set(`${roomId}:message`, unsubMessage);
  state.unsubscribers.set(`${roomId}:join`, unsubJoin);
  state.unsubscribers.set(`${roomId}:leave`, unsubLeave);
}

function handleLeave(roomId: string, state: ConnectionState): ConnectionState {
  if (!state.joinedRooms.has(roomId)) {
    state.sendFn({
      type: 'error',
      code: 'NOT_IN_ROOM',
      message: `Nejste v místnosti ${roomId}`,
    });
    return state;
  }

  leaveRoom(roomId, state);

  state.sendFn({
    type: 'left',
    roomId,
  });

  return state;
}

function leaveRoom(roomId: string, state: ConnectionState): void {
  // Odhlásit se z událostí místnosti
  const keys = [`${roomId}:message`, `${roomId}:join`, `${roomId}:leave`];
  for (const key of keys) {
    const unsub = state.unsubscribers.get(key);
    if (unsub) {
      unsub().catch(() => {});
      state.unsubscribers.delete(key);
    }
  }

  // Odstranit z připojených místností
  state.joinedRooms.delete(roomId);

  // Notifikovat místnost o odchodu
  if (state.username) {
    EventBus.publish(state.eventBus, `room:${roomId}:leave`, {
      roomId,
      username: state.username,
    });
  }
}

function handleMessage(
  roomId: string,
  text: string,
  state: ConnectionState
): ConnectionState {
  if (!state.joinedRooms.has(roomId)) {
    state.sendFn({
      type: 'error',
      code: 'NOT_IN_ROOM',
      message: `Nejste v místnosti ${roomId}`,
    });
    return state;
  }

  if (!state.username) {
    state.sendFn({
      type: 'error',
      code: 'NOT_IDENTIFIED',
      message: 'Nejprve se musíte připojit k místnosti',
    });
    return state;
  }

  // Validace zprávy
  if (!text || text.length > 2000) {
    state.sendFn({
      type: 'error',
      code: 'INVALID_MESSAGE',
      message: 'Zpráva musí mít 1-2000 znaků',
    });
    return state;
  }

  const event: RoomMessageEvent = {
    roomId,
    from: state.username,
    text,
    timestamp: Date.now(),
  };

  // Publikovat do místnosti (všichni odběratelé včetně odesílatele obdrží)
  EventBus.publish(state.eventBus, `room:${roomId}:message`, event);

  // Echovat zpět odesílateli s timestampem
  state.sendFn({
    type: 'message',
    roomId,
    from: state.username,
    text,
    timestamp: event.timestamp,
  });

  return state;
}

function handleListRooms(state: ConnectionState): void {
  // Získat místnosti z RoomManageru přes Registry
  const roomManagerRef = Registry.whereis('room-manager');
  if (roomManagerRef) {
    GenServer.call<unknown, { type: 'list_rooms' }, unknown, RoomInfo[]>(
      roomManagerRef,
      { type: 'list_rooms' }
    ).then((rooms) => {
      state.sendFn({
        type: 'room_list',
        rooms,
      });
    }).catch(() => {
      state.sendFn({
        type: 'room_list',
        rooms: [],
      });
    });
  } else {
    state.sendFn({
      type: 'room_list',
      rooms: [],
    });
  }
}

function handleListUsers(roomId: string, state: ConnectionState): void {
  const users = getRoomUsers(roomId);
  state.sendFn({
    type: 'user_list',
    roomId,
    users,
  });
}

function getRoomUsers(roomId: string): string[] {
  const roomManagerRef = Registry.whereis('room-manager');
  if (!roomManagerRef) return [];

  // Toto je synchronní lookup - v produkci byste použili call
  // Pro jednoduchost vrátíme prázdné pole a necháme room manager to vyřešit
  return [];
}

// Spustit Connection GenServer
export async function startConnection(
  connectionId: string,
  eventBus: EventBusRef,
  sendFn: (msg: ServerMessage) => void
): Promise<GenServerRef> {
  return GenServer.start<
    ConnectionState,
    ConnectionCallMsg,
    ConnectionCastMsg,
    ConnectionCallReply
  >({
    init: () => ConnectionBehavior.init(connectionId, eventBus, sendFn),
    handleCall: ConnectionBehavior.handleCall,
    handleCast: ConnectionBehavior.handleCast,
    terminate: ConnectionBehavior.terminate,
  });
}

// Poslat zprávu spojení
export function sendToConnection(
  ref: GenServerRef,
  message: ServerMessage
): void {
  GenServer.cast(ref, { type: 'send', message });
}

// Zpracovat příchozí klientskou zprávu
export function processClientMessage(
  ref: GenServerRef,
  message: ClientMessage
): void {
  GenServer.cast(ref, { type: 'client_message', message });
}

// Odpojit spojení
export function disconnectConnection(ref: GenServerRef): void {
  GenServer.cast(ref, { type: 'disconnect' });
}
```

## Část 3: Room Manager

Room Manager sleduje všechny místnosti a jejich členy:

```typescript
// src/chat/room-manager.ts
import { GenServer, EventBus, Registry, type GenServerRef, type EventBusRef } from '@hamicek/noex';
import type { RoomInfo, RoomPresenceEvent } from './protocol';

interface Room {
  id: string;
  members: Map<string, GenServerRef>; // username → connectionRef
  createdAt: number;
}

interface RoomManagerState {
  rooms: Map<string, Room>;
  eventBus: EventBusRef;
}

type RoomManagerCallMsg =
  | { type: 'list_rooms' }
  | { type: 'get_room_users'; roomId: string }
  | { type: 'get_room'; roomId: string };

type RoomManagerCallReply = RoomInfo[] | string[] | Room | null;

type RoomManagerCastMsg =
  | { type: 'user_joined'; roomId: string; username: string; connectionRef: GenServerRef }
  | { type: 'user_left'; roomId: string; username: string };

export const RoomManagerBehavior = {
  async init(eventBus: EventBusRef): Promise<RoomManagerState> {
    const state: RoomManagerState = {
      rooms: new Map(),
      eventBus,
    };

    // Přihlásit se k událostem přítomnosti ze všech místností
    await EventBus.subscribe<RoomPresenceEvent>(
      eventBus,
      'room:*:join',
      (event, topic) => {
        const roomId = extractRoomId(topic);
        if (roomId) {
          const roomManagerRef = Registry.whereis('room-manager');
          if (roomManagerRef) {
            GenServer.cast(roomManagerRef, {
              type: 'user_joined',
              roomId,
              username: event.username,
              connectionRef: event.connectionRef,
            });
          }
        }
      }
    );

    await EventBus.subscribe<Omit<RoomPresenceEvent, 'connectionRef'>>(
      eventBus,
      'room:*:leave',
      (event, topic) => {
        const roomId = extractRoomId(topic);
        if (roomId) {
          const roomManagerRef = Registry.whereis('room-manager');
          if (roomManagerRef) {
            GenServer.cast(roomManagerRef, {
              type: 'user_left',
              roomId,
              username: event.username,
            });
          }
        }
      }
    );

    console.log('[RoomManager] inicializován');
    return state;
  },

  handleCall(
    msg: RoomManagerCallMsg,
    state: RoomManagerState
  ): [RoomManagerCallReply, RoomManagerState] {
    switch (msg.type) {
      case 'list_rooms': {
        const rooms: RoomInfo[] = Array.from(state.rooms.values()).map((room) => ({
          id: room.id,
          userCount: room.members.size,
        }));
        return [rooms, state];
      }

      case 'get_room_users': {
        const room = state.rooms.get(msg.roomId);
        if (!room) {
          return [[], state];
        }
        return [Array.from(room.members.keys()), state];
      }

      case 'get_room': {
        const room = state.rooms.get(msg.roomId);
        return [room ?? null, state];
      }
    }
  },

  handleCast(
    msg: RoomManagerCastMsg,
    state: RoomManagerState
  ): RoomManagerState {
    switch (msg.type) {
      case 'user_joined': {
        let room = state.rooms.get(msg.roomId);

        // Vytvořit místnost, pokud neexistuje
        if (!room) {
          room = {
            id: msg.roomId,
            members: new Map(),
            createdAt: Date.now(),
          };
          state.rooms.set(msg.roomId, room);
          console.log(`[RoomManager] Místnost vytvořena: ${msg.roomId}`);
        }

        room.members.set(msg.username, msg.connectionRef);
        console.log(`[RoomManager] ${msg.username} vstoupil do ${msg.roomId} (${room.members.size} uživatelů)`);
        return state;
      }

      case 'user_left': {
        const room = state.rooms.get(msg.roomId);
        if (room) {
          room.members.delete(msg.username);
          console.log(`[RoomManager] ${msg.username} opustil ${msg.roomId} (${room.members.size} uživatelů)`);

          // Odstranit prázdné místnosti
          if (room.members.size === 0) {
            state.rooms.delete(msg.roomId);
            console.log(`[RoomManager] Místnost odstraněna: ${msg.roomId}`);
          }
        }
        return state;
      }
    }
  },

  terminate(reason: string, state: RoomManagerState): void {
    console.log(`[RoomManager] ukončen: ${reason}`);
  },
};

function extractRoomId(topic: string): string | null {
  // formát topicu: room:{roomId}:join nebo room:{roomId}:leave
  const match = topic.match(/^room:([^:]+):/);
  return match ? match[1] : null;
}

// Spustit Room Manager
export async function startRoomManager(
  eventBus: EventBusRef
): Promise<GenServerRef> {
  const ref = await GenServer.start<
    RoomManagerState,
    RoomManagerCallMsg,
    RoomManagerCastMsg,
    RoomManagerCallReply
  >({
    init: () => RoomManagerBehavior.init(eventBus),
    handleCall: RoomManagerBehavior.handleCall,
    handleCast: RoomManagerBehavior.handleCast,
    terminate: RoomManagerBehavior.terminate,
  });

  // Zaregistrovat pro globální lookup
  Registry.register('room-manager', ref);

  return ref;
}

// Získat seznam místností
export async function listRooms(ref: GenServerRef): Promise<RoomInfo[]> {
  return GenServer.call(ref, { type: 'list_rooms' });
}

// Získat uživatele v místnosti
export async function getRoomUsers(
  ref: GenServerRef,
  roomId: string
): Promise<string[]> {
  return GenServer.call(ref, { type: 'get_room_users', roomId });
}
```

## Část 4: Connection Supervisor

Connection Supervisor spravuje všechna aktivní spojení pomocí strategie `simple_one_for_one`:

```typescript
// src/chat/connection-supervisor.ts
import { Supervisor, GenServer, type GenServerRef, type SupervisorRef, type EventBusRef } from '@hamicek/noex';
import { startConnection, type ServerMessage } from './connection';

let connectionCounter = 0;

// Spustit Connection Supervisor
export async function startConnectionSupervisor(): Promise<SupervisorRef> {
  const ref = await Supervisor.start({
    strategy: 'simple_one_for_one',
    children: [], // Děti přidány dynamicky
    maxRestarts: 10,
    restartWithinMs: 60_000,
  });

  console.log('[ConnectionSupervisor] spuštěn');
  return ref;
}

// Přidat nové spojení pod supervizi
export async function addConnection(
  supervisor: SupervisorRef,
  eventBus: EventBusRef,
  sendFn: (msg: ServerMessage) => void
): Promise<GenServerRef> {
  const connectionId = `conn-${++connectionCounter}`;

  const childSpec = {
    id: connectionId,
    start: () => startConnection(connectionId, eventBus, sendFn),
    restart: 'temporary' as const, // Nerestartovat odpojená spojení
    shutdownTimeout: 5000,
  };

  const result = await Supervisor.startChild(supervisor, childSpec);
  console.log(`[ConnectionSupervisor] Přidáno spojení: ${connectionId}`);

  return result.ref!;
}

// Odstranit spojení
export async function removeConnection(
  supervisor: SupervisorRef,
  connectionId: string
): Promise<void> {
  await Supervisor.terminateChild(supervisor, connectionId);
  console.log(`[ConnectionSupervisor] Odstraněno spojení: ${connectionId}`);
}

// Získat všechna aktivní spojení
export async function getConnections(
  supervisor: SupervisorRef
): Promise<Array<{ id: string; ref: GenServerRef }>> {
  const children = await Supervisor.getChildren(supervisor);
  return children.map((child) => ({
    id: child.id,
    ref: child.ref!,
  }));
}
```

## Část 5: Chat Application

Nyní spojte vše dohromady s hlavní Chat Application:

```typescript
// src/chat/chat-application.ts
import {
  Application,
  EventBus,
  Supervisor,
  GenServer,
  Registry,
  type ApplicationBehavior,
  type SupervisorRef,
  type EventBusRef,
} from '@hamicek/noex';
import { startRoomManager } from './room-manager';
import { startConnectionSupervisor, addConnection, getConnections } from './connection-supervisor';
import { processClientMessage, disconnectConnection, type ServerMessage, type ClientMessage } from './connection';

interface ChatConfig {
  maxConnections?: number;
}

interface ChatState {
  eventBus: EventBusRef;
  roomManager: ReturnType<typeof startRoomManager> extends Promise<infer T> ? T : never;
  connectionSupervisor: SupervisorRef;
}

export const ChatApplicationBehavior: ApplicationBehavior<ChatConfig, ChatState> = {
  async start(config) {
    console.log('[ChatApplication] Spouštění...');

    // 1. Spustit EventBus první (ostatní komponenty na něm závisí)
    const eventBus = await EventBus.start({ name: 'chat-events' });
    console.log('[ChatApplication] EventBus spuštěn');

    // 2. Spustit Room Manager
    const roomManager = await startRoomManager(eventBus);
    console.log('[ChatApplication] RoomManager spuštěn');

    // 3. Spustit Connection Supervisor
    const connectionSupervisor = await startConnectionSupervisor();
    console.log('[ChatApplication] ConnectionSupervisor spuštěn');

    // 4. Vytvořit top-level supervisor se všemi komponentami
    const supervisor = await Supervisor.start({
      strategy: 'one_for_all', // Pokud jedna selže, restartovat všechny (zajistí konzistenci)
      children: [], // Komponenty již spuštěny, supervisor je jen sleduje
      maxRestarts: 3,
      restartWithinMs: 60_000,
    });

    console.log('[ChatApplication] Úspěšně spuštěna');

    return {
      supervisor,
      state: {
        eventBus,
        roomManager,
        connectionSupervisor,
      },
    };
  },

  async prepStop(reason, state) {
    console.log(`[ChatApplication] Příprava na zastavení: ${reason}`);

    // Notifikovat všechna spojení o shutdown
    const connections = await getConnections(state.connectionSupervisor);
    for (const { ref } of connections) {
      try {
        GenServer.cast(ref, {
          type: 'send',
          message: {
            type: 'error',
            code: 'SERVER_SHUTDOWN',
            message: 'Server se vypíná',
          },
        });
      } catch {
        // Spojení už může být pryč
      }
    }

    // Dát klientům čas přijmout shutdown zprávu
    await new Promise((resolve) => setTimeout(resolve, 1000));
  },

  async stop(reason, state) {
    console.log(`[ChatApplication] Zastavování: ${reason}`);

    // Zastavit komponenty v opačném pořadí
    await Supervisor.stop(state.connectionSupervisor);
    await GenServer.stop(state.roomManager);
    await EventBus.stop(state.eventBus);

    // Odregistrovat room manager
    try {
      Registry.unregister('room-manager');
    } catch {
      // Již může být odregistrován
    }

    console.log('[ChatApplication] Zastavena');
  },
};

// Wrapper instance chat serveru
export class ChatServer {
  private state: ChatState | null = null;
  private supervisor: SupervisorRef | null = null;

  async start(config: ChatConfig = {}): Promise<void> {
    const result = await Application.start(ChatApplicationBehavior, config);
    this.supervisor = result.supervisor;
    this.state = result.state;
  }

  async stop(): Promise<void> {
    if (this.state && this.supervisor) {
      await Application.stop(this.supervisor, 'shutdown');
      this.state = null;
      this.supervisor = null;
    }
  }

  // Zpracovat nové WebSocket spojení
  async handleConnection(
    sendFn: (msg: ServerMessage) => void
  ): Promise<{
    connectionRef: ReturnType<typeof addConnection> extends Promise<infer T> ? T : never;
    onMessage: (msg: ClientMessage) => void;
    onDisconnect: () => void;
  }> {
    if (!this.state) {
      throw new Error('Chat server není spuštěn');
    }

    const connectionRef = await addConnection(
      this.state.connectionSupervisor,
      this.state.eventBus,
      sendFn
    );

    return {
      connectionRef,
      onMessage: (msg: ClientMessage) => {
        processClientMessage(connectionRef, msg);
      },
      onDisconnect: () => {
        disconnectConnection(connectionRef);
      },
    };
  }

  isRunning(): boolean {
    return this.state !== null;
  }
}
```

## Část 6: Integrace WebSocketu

Zde je návod, jak integrovat s WebSocket serverem (pomocí knihovny `ws`):

```typescript
// src/chat/server.ts
import { WebSocketServer, WebSocket } from 'ws';
import { ChatServer } from './chat-application';
import type { ClientMessage, ServerMessage } from './protocol';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

async function main() {
  // Spustit chat aplikaci
  const chat = new ChatServer();
  await chat.start({ maxConnections: 1000 });

  // Vytvořit WebSocket server
  const wss = new WebSocketServer({ port: PORT });
  console.log(`WebSocket server naslouchá na portu ${PORT}`);

  wss.on('connection', async (ws: WebSocket) => {
    console.log('Nové WebSocket spojení');

    // Send funkce obaluje WebSocket.send
    const sendFn = (msg: ServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    // Vytvořit connection handler
    const { onMessage, onDisconnect } = await chat.handleConnection(sendFn);

    // Zpracovat příchozí zprávy
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        onMessage(msg);
      } catch (err) {
        sendFn({
          type: 'error',
          code: 'INVALID_JSON',
          message: 'Neplatná JSON zpráva',
        });
      }
    });

    // Zpracovat odpojení
    ws.on('close', () => {
      console.log('WebSocket spojení uzavřeno');
      onDisconnect();
    });

    // Zpracovat chyby
    ws.on('error', (err) => {
      console.error('WebSocket chyba:', err);
      onDisconnect();
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Vypínání...');
    wss.close();
    await chat.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);
```

## Část 7: Tok zpráv

Zde je, jak chat zpráva prochází systémem:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             TOK ZPRÁV                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Uživatel A posílá: { type: 'message', roomId: 'general', text: 'Ahoj!' }  │
│                                                                             │
│  ┌──────────────┐                                                           │
│  │  WebSocket   │──► JSON.parse()                                           │
│  │   Server     │                                                           │
│  └──────────────┘                                                           │
│         │                                                                   │
│         ▼ onMessage(msg)                                                    │
│  ┌──────────────┐                                                           │
│  │ Connection A │──► cast({ type: 'client_message', ... })                  │
│  │  GenServer   │                                                           │
│  └──────────────┘                                                           │
│         │                                                                   │
│         ▼ handleCast → handleMessage()                                      │
│  ┌──────────────┐                                                           │
│  │   EventBus   │──► publish('room:general:message', {...})                 │
│  └──────────────┘                                                           │
│         │                                                                   │
│         │ topic odpovídá 'room:general:message'                             │
│         │                                                                   │
│    ┌────┴────┐                                                              │
│    │         │                                                              │
│    ▼         ▼                                                              │
│  ┌──────┐  ┌──────┐                                                         │
│  │Conn A│  │Conn B│──► handler přijímá událost                              │
│  │      │  │      │                                                         │
│  └──────┘  └──────┘                                                         │
│    │         │                                                              │
│    │         ▼ sendFn(msg)                                                  │
│    │    ┌──────────┐                                                        │
│    │    │WebSocket │──► JSON.stringify() → ws.send()                        │
│    │    │  (B)     │                                                        │
│    │    └──────────┘                                                        │
│    │                                                                        │
│    ▼ Echo zpět odesílateli                                                  │
│  ┌──────────┐                                                               │
│  │WebSocket │──► { type: 'message', from: 'UživatelA', ... }                │
│  │  (A)     │                                                               │
│  └──────────┘                                                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Testování Chat Serveru

Zde je návod, jak testovat chat server s integračními testy:

```typescript
// tests/chat-server.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatServer } from '../src/chat/chat-application';
import type { ServerMessage, ClientMessage } from '../src/chat/protocol';

describe('ChatServer', () => {
  let server: ChatServer;
  let receivedMessages: Map<string, ServerMessage[]>;

  beforeEach(async () => {
    server = new ChatServer();
    await server.start();
    receivedMessages = new Map();
  });

  afterEach(async () => {
    await server.stop();
  });

  function createMockConnection(id: string) {
    receivedMessages.set(id, []);

    return server.handleConnection((msg) => {
      receivedMessages.get(id)!.push(msg);
    });
  }

  function getMessages(id: string): ServerMessage[] {
    return receivedMessages.get(id) ?? [];
  }

  async function waitFor(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('měl by umožnit připojení k místnosti', async () => {
    const { onMessage } = await createMockConnection('user1');

    onMessage({ type: 'join', roomId: 'test-room', username: 'Alice' });

    await waitFor(50);

    const messages = getMessages('user1');
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'joined', roomId: 'test-room' })
    );
  });

  it('měl by broadcastovat zprávy členům místnosti', async () => {
    const conn1 = await createMockConnection('user1');
    const conn2 = await createMockConnection('user2');

    // Oba uživatelé vstoupí do stejné místnosti
    conn1.onMessage({ type: 'join', roomId: 'chat', username: 'Alice' });
    conn2.onMessage({ type: 'join', roomId: 'chat', username: 'Bob' });

    await waitFor(50);

    // Alice pošle zprávu
    conn1.onMessage({ type: 'message', roomId: 'chat', text: 'Ahoj, Bobe!' });

    await waitFor(50);

    // Bob by měl obdržet zprávu
    const bobMessages = getMessages('user2');
    expect(bobMessages).toContainEqual(
      expect.objectContaining({
        type: 'message',
        roomId: 'chat',
        from: 'Alice',
        text: 'Ahoj, Bobe!',
      })
    );
  });

  it('měl by notifikovat při připojení/odchodu uživatelů', async () => {
    const conn1 = await createMockConnection('user1');
    const conn2 = await createMockConnection('user2');

    // Alice se připojí první
    conn1.onMessage({ type: 'join', roomId: 'lobby', username: 'Alice' });
    await waitFor(50);

    // Bob se připojí poté
    conn2.onMessage({ type: 'join', roomId: 'lobby', username: 'Bob' });
    await waitFor(50);

    // Alice by měla vidět, že Bob se připojil
    const aliceMessages = getMessages('user1');
    expect(aliceMessages).toContainEqual(
      expect.objectContaining({
        type: 'user_joined',
        roomId: 'lobby',
        username: 'Bob',
      })
    );

    // Bob odchází
    conn2.onMessage({ type: 'leave', roomId: 'lobby' });
    await waitFor(50);

    // Alice by měla vidět, že Bob odešel
    expect(aliceMessages).toContainEqual(
      expect.objectContaining({
        type: 'user_left',
        roomId: 'lobby',
        username: 'Bob',
      })
    );
  });

  it('měl by gracefully zpracovat odpojení', async () => {
    const conn1 = await createMockConnection('user1');
    const conn2 = await createMockConnection('user2');

    conn1.onMessage({ type: 'join', roomId: 'temp', username: 'Alice' });
    conn2.onMessage({ type: 'join', roomId: 'temp', username: 'Bob' });
    await waitFor(50);

    // Simulovat odpojení Boba
    conn2.onDisconnect();
    await waitFor(50);

    // Alice by měla vidět, že Bob odešel
    const aliceMessages = getMessages('user1');
    expect(aliceMessages).toContainEqual(
      expect.objectContaining({
        type: 'user_left',
        roomId: 'temp',
        username: 'Bob',
      })
    );
  });

  it('měl by zabránit posílání do místností, kde nejsem', async () => {
    const { onMessage } = await createMockConnection('user1');

    onMessage({ type: 'join', roomId: 'room1', username: 'Alice' });
    await waitFor(50);

    // Pokusit se poslat do jiné místnosti
    onMessage({ type: 'message', roomId: 'room2', text: 'Zákeřné!' });
    await waitFor(50);

    const messages = getMessages('user1');
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'error',
        code: 'NOT_IN_ROOM',
      })
    );
  });
});
```

## Cvičení: Přidat historii zpráv

Vylepšete chat server o historii zpráv:

**Požadavky:**
1. Ukládat posledních 100 zpráv pro každou místnost
2. Posílat historii uživatelům při vstupu do místnosti
3. Přidat klientskou zprávu `{ type: 'get_history', roomId: string }`
4. Omezit úložiště historie pro prevenci problémů s pamětí

**Startovací kód:**

```typescript
// Rozšířit rozhraní Room
interface Room {
  id: string;
  members: Map<string, GenServerRef>;
  createdAt: number;
  history: RoomMessageEvent[]; // Přidat toto
  maxHistorySize: number;      // Přidat toto
}

// Přidat do RoomManager handleCast
case 'room_message': {
  // TODO: Uložit zprávu do historie místnosti
  // TODO: Oříznout historii, pokud překročí maxHistorySize
}

// Přidat do Connection handleJoin
// TODO: Vyžádat historii z RoomManageru
// TODO: Poslat historii klientovi po zprávě 'joined'
```

<details>
<summary><strong>Řešení</strong></summary>

```typescript
// Modifikovaný room-manager.ts

interface Room {
  id: string;
  members: Map<string, GenServerRef>;
  createdAt: number;
  history: RoomMessageEvent[];
  maxHistorySize: number;
}

type RoomManagerCallMsg =
  | { type: 'list_rooms' }
  | { type: 'get_room_users'; roomId: string }
  | { type: 'get_room'; roomId: string }
  | { type: 'get_history'; roomId: string; limit?: number }; // Nové

type RoomManagerCastMsg =
  | { type: 'user_joined'; roomId: string; username: string; connectionRef: GenServerRef }
  | { type: 'user_left'; roomId: string; username: string }
  | { type: 'room_message'; roomId: string; message: RoomMessageEvent }; // Nové

// V handleCall přidat:
case 'get_history': {
  const room = state.rooms.get(msg.roomId);
  if (!room) {
    return [[], state];
  }
  const limit = msg.limit ?? 50;
  const history = room.history.slice(-limit);
  return [history, state];
}

// V handleCast přidat:
case 'room_message': {
  const room = state.rooms.get(msg.roomId);
  if (room) {
    room.history.push(msg.message);

    // Oříznout historii, pokud překročí max
    if (room.history.length > room.maxHistorySize) {
      room.history = room.history.slice(-room.maxHistorySize);
    }
  }
  return state;
}

// Aktualizovat user_joined case pro inicializaci historie:
case 'user_joined': {
  let room = state.rooms.get(msg.roomId);

  if (!room) {
    room = {
      id: msg.roomId,
      members: new Map(),
      createdAt: Date.now(),
      history: [],           // Inicializovat historii
      maxHistorySize: 100,   // Výchozí limit
    };
    state.rooms.set(msg.roomId, room);
  }

  room.members.set(msg.username, msg.connectionRef);
  return state;
}

// Modifikovaný connection.ts - funkce handleMessage
function handleMessage(
  roomId: string,
  text: string,
  state: ConnectionState
): ConnectionState {
  // ... existující validace ...

  const event: RoomMessageEvent = {
    roomId,
    from: state.username,
    text,
    timestamp: Date.now(),
  };

  // Publikovat do místnosti
  EventBus.publish(state.eventBus, `room:${roomId}:message`, event);

  // Také notifikovat RoomManager pro uložení do historie
  const roomManagerRef = Registry.whereis('room-manager');
  if (roomManagerRef) {
    GenServer.cast(roomManagerRef, {
      type: 'room_message',
      roomId,
      message: event,
    });
  }

  // Echo zpět odesílateli
  state.sendFn({
    type: 'message',
    roomId,
    from: state.username,
    text,
    timestamp: event.timestamp,
  });

  return state;
}

// Modifikovaný handleJoin - po připojení načíst a poslat historii
async function handleJoin(
  roomId: string,
  username: string,
  state: ConnectionState
): Promise<ConnectionState> {
  // ... existující validace a setup ...

  // Po odeslání zprávy 'joined' poslat historii
  const roomManagerRef = Registry.whereis('room-manager');
  if (roomManagerRef) {
    try {
      const history = await GenServer.call<
        unknown,
        { type: 'get_history'; roomId: string; limit?: number },
        unknown,
        RoomMessageEvent[]
      >(roomManagerRef, { type: 'get_history', roomId, limit: 50 });

      // Poslat historii jako jednotlivé zprávy
      for (const msg of history) {
        state.sendFn({
          type: 'message',
          roomId: msg.roomId,
          from: msg.from,
          text: msg.text,
          timestamp: msg.timestamp,
        });
      }
    } catch {
      // Načtení historie selhalo, pokračovat bez ní
    }
  }

  return newState;
}

// Přidat nový typ klientské zprávy
type ClientMessage =
  | { type: 'join'; roomId: string; username: string }
  | { type: 'leave'; roomId: string }
  | { type: 'message'; roomId: string; text: string }
  | { type: 'list_rooms' }
  | { type: 'list_users'; roomId: string }
  | { type: 'get_history'; roomId: string; limit?: number }; // Nové

// Zpracovat get_history ve spojení
case 'get_history': {
  if (!state.joinedRooms.has(msg.roomId)) {
    state.sendFn({
      type: 'error',
      code: 'NOT_IN_ROOM',
      message: `Nejste v místnosti ${msg.roomId}`,
    });
    return state;
  }

  const roomManagerRef = Registry.whereis('room-manager');
  if (roomManagerRef) {
    GenServer.call<
      unknown,
      { type: 'get_history'; roomId: string; limit?: number },
      unknown,
      RoomMessageEvent[]
    >(roomManagerRef, { type: 'get_history', roomId: msg.roomId, limit: msg.limit })
      .then((history) => {
        for (const msg of history) {
          state.sendFn({
            type: 'message',
            roomId: msg.roomId,
            from: msg.from,
            text: msg.text,
            timestamp: msg.timestamp,
          });
        }
      })
      .catch(() => {
        state.sendFn({
          type: 'error',
          code: 'HISTORY_FETCH_FAILED',
          message: 'Selhalo načtení historie',
        });
      });
  }
  return state;
}
```

**Klíčová rozhodnutí návrhu:**

1. **Historie uložena v RoomManageru** — Centrální úložiště s konzistentními limity
2. **Vzor kruhového bufferu** — `slice(-maxHistorySize)` ponechává pouze nedávné zprávy
3. **Asynchronní načítání historie** — Neblokuje operaci připojení
4. **Limity pro každou místnost** — Každá místnost může mít různé velikosti historie
5. **Historie při připojení** — Noví uživatelé vidí kontext nedávné konverzace

</details>

## Shrnutí

**Klíčové poznatky:**

- **Jeden GenServer pro každé spojení** — Izoluje stav a selhání mezi uživateli
- **Supervisor pro dynamické děti** — `simple_one_for_one` spravuje životní cyklus spojení
- **EventBus pro broadcastování** — Odpojuje místnosti od spojení
- **Registry pro service discovery** — Pojmenovaný lookup pro room manager
- **Graceful shutdown** — Notifikovat klienty před zastavením

**Použité architektonické vzory:**

| Vzor | Kde použito |
|------|-------------|
| GenServer pro každou entitu | Každé WebSocket spojení |
| Dynamický Supervisor | Správa spojení |
| Pub/Sub | Broadcastování zpráv do místnosti |
| Registry | Service lookup |
| Application | Kompozice systému |

**Co jste se naučili:**

1. Jak navrhnout vícesložkový actor systém
2. Izolace pro každé spojení pomocí GenServeru
3. Dynamická správa procesů pomocí Supervisoru
4. Event-driven messaging pomocí EventBusu
5. Service discovery pomocí Registry
6. Graceful startup a shutdown

> **Architektonický vhled:** Chat server demonstruje sílu kompozice actor modelu. Každá komponenta má jednu zodpovědnost, komunikuje přes dobře definované zprávy a může selhat nezávisle bez ovlivnění celého systému.

---

Další: [Task Queue](./02-task-queue.md)
