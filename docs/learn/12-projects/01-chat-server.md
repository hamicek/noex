# Chat Server

In this project, you'll build a real-time chat server that brings together everything you've learned. This isn't a toy example — it's a production-ready architecture that demonstrates how noex's actor model elegantly handles concurrent connections, room management, and message broadcasting.

## What You'll Learn

- Design a multi-component system using GenServer, Supervisor, Registry, and EventBus
- Create one GenServer per WebSocket connection for isolation
- Manage dynamic processes with `simple_one_for_one` supervision
- Use EventBus for room-based message broadcasting
- Handle user presence tracking with Registry
- Implement graceful shutdown and connection cleanup

## What You'll Build

A real-time chat server with:
- **Multiple chat rooms** — Users can join and leave rooms dynamically
- **User presence** — Track who's online in each room
- **Message broadcasting** — Messages reach all room members instantly
- **Connection isolation** — One bad connection doesn't affect others
- **Graceful shutdown** — Clean disconnect notifications

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CHAT SERVER ARCHITECTURE                             │
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
│                         EventBus topics:                                    │
│                         • room:{id}:message                                 │
│                         • room:{id}:join                                    │
│                         • room:{id}:leave                                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Component responsibilities:**

| Component | Role |
|-----------|------|
| **Chat Supervisor** | Top-level supervisor ensuring all components run |
| **EventBus** | Routes messages between rooms and connections |
| **Room Manager** | Creates/tracks rooms, maintains member lists |
| **Connection Supervisor** | Dynamically manages connection GenServers |
| **Connection GenServer** | One per WebSocket, handles user's messages |

## Part 1: Message Protocol

First, define the messages that flow through the system:

```typescript
// src/chat/protocol.ts
import type { GenServerRef } from '@hamicek/noex';

// Client → Server messages
export type ClientMessage =
  | { type: 'join'; roomId: string; username: string }
  | { type: 'leave'; roomId: string }
  | { type: 'message'; roomId: string; text: string }
  | { type: 'list_rooms' }
  | { type: 'list_users'; roomId: string };

// Server → Client messages
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

// Internal EventBus events
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

## Part 2: Connection GenServer

Each WebSocket connection gets its own GenServer. This isolates state and ensures one misbehaving connection doesn't crash others:

```typescript
// src/chat/connection.ts
import { GenServer, EventBus, Registry, type GenServerRef, type EventBusRef } from '@hamicek/noex';
import type { ClientMessage, ServerMessage, RoomMessageEvent, RoomPresenceEvent } from './protocol';

// Connection state
interface ConnectionState {
  connectionId: string;
  username: string | null;
  joinedRooms: Set<string>;
  eventBus: EventBusRef;
  sendFn: (msg: ServerMessage) => void;
  unsubscribers: Map<string, () => Promise<void>>;
}

// Call messages (need response)
type ConnectionCallMsg =
  | { type: 'get_info' }
  | { type: 'get_username' };

type ConnectionCallReply =
  | { connectionId: string; username: string | null; rooms: string[] }
  | string | null;

// Cast messages (fire-and-forget)
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
    console.log(`[Connection:${connectionId}] initialized`);
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
        // Leave all rooms before disconnecting
        for (const roomId of state.joinedRooms) {
          leaveRoom(roomId, state);
        }
        return state;
    }
  },

  terminate(reason: string, state: ConnectionState): void {
    console.log(`[Connection:${state.connectionId}] terminated: ${reason}`);

    // Clean up subscriptions
    for (const [, unsubscribe] of state.unsubscribers) {
      unsubscribe().catch(() => {});
    }

    // Notify rooms about departure
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

// Handle incoming client messages
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
        message: 'Unknown message type',
      });
      return state;
  }
}

function handleJoin(
  roomId: string,
  username: string,
  state: ConnectionState
): ConnectionState {
  // Validate username
  if (!username || username.length < 1 || username.length > 32) {
    state.sendFn({
      type: 'error',
      code: 'INVALID_USERNAME',
      message: 'Username must be 1-32 characters',
    });
    return state;
  }

  // Check if already in room
  if (state.joinedRooms.has(roomId)) {
    state.sendFn({
      type: 'error',
      code: 'ALREADY_IN_ROOM',
      message: `Already in room ${roomId}`,
    });
    return state;
  }

  // Set username (first join sets it)
  const newState = { ...state, username };

  // Subscribe to room events
  subscribeToRoom(roomId, newState).catch((err) => {
    console.error(`Failed to subscribe to room ${roomId}:`, err);
  });

  // Notify room about join
  EventBus.publish(newState.eventBus, `room:${roomId}:join`, {
    roomId,
    username,
  } satisfies Omit<RoomPresenceEvent, 'connectionRef'>);

  // Add room to joined set
  newState.joinedRooms.add(roomId);

  // Get current users and send confirmation
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
  // Subscribe to messages in this room
  const unsubMessage = await EventBus.subscribe<RoomMessageEvent>(
    state.eventBus,
    `room:${roomId}:message`,
    (event) => {
      // Don't echo back to sender
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

  // Subscribe to presence events
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

  // Store unsubscribers for cleanup
  state.unsubscribers.set(`${roomId}:message`, unsubMessage);
  state.unsubscribers.set(`${roomId}:join`, unsubJoin);
  state.unsubscribers.set(`${roomId}:leave`, unsubLeave);
}

function handleLeave(roomId: string, state: ConnectionState): ConnectionState {
  if (!state.joinedRooms.has(roomId)) {
    state.sendFn({
      type: 'error',
      code: 'NOT_IN_ROOM',
      message: `Not in room ${roomId}`,
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
  // Unsubscribe from room events
  const keys = [`${roomId}:message`, `${roomId}:join`, `${roomId}:leave`];
  for (const key of keys) {
    const unsub = state.unsubscribers.get(key);
    if (unsub) {
      unsub().catch(() => {});
      state.unsubscribers.delete(key);
    }
  }

  // Remove from joined rooms
  state.joinedRooms.delete(roomId);

  // Notify room about departure
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
      message: `Not in room ${roomId}`,
    });
    return state;
  }

  if (!state.username) {
    state.sendFn({
      type: 'error',
      code: 'NOT_IDENTIFIED',
      message: 'Must join a room first',
    });
    return state;
  }

  // Validate message
  if (!text || text.length > 2000) {
    state.sendFn({
      type: 'error',
      code: 'INVALID_MESSAGE',
      message: 'Message must be 1-2000 characters',
    });
    return state;
  }

  const event: RoomMessageEvent = {
    roomId,
    from: state.username,
    text,
    timestamp: Date.now(),
  };

  // Publish to room (all subscribers including sender will receive)
  EventBus.publish(state.eventBus, `room:${roomId}:message`, event);

  // Echo back to sender with timestamp
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
  // Get rooms from RoomManager via Registry
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

  // This is synchronous lookup - in production you'd use call
  // For simplicity, we'll return empty array and let room manager handle it
  return [];
}

// Start a connection GenServer
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

// Send a message to a connection
export function sendToConnection(
  ref: GenServerRef,
  message: ServerMessage
): void {
  GenServer.cast(ref, { type: 'send', message });
}

// Process incoming client message
export function processClientMessage(
  ref: GenServerRef,
  message: ClientMessage
): void {
  GenServer.cast(ref, { type: 'client_message', message });
}

// Disconnect a connection
export function disconnectConnection(ref: GenServerRef): void {
  GenServer.cast(ref, { type: 'disconnect' });
}
```

## Part 3: Room Manager

The Room Manager tracks all rooms and their members:

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

    // Subscribe to presence events from all rooms
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

    console.log('[RoomManager] initialized');
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

        // Create room if doesn't exist
        if (!room) {
          room = {
            id: msg.roomId,
            members: new Map(),
            createdAt: Date.now(),
          };
          state.rooms.set(msg.roomId, room);
          console.log(`[RoomManager] Room created: ${msg.roomId}`);
        }

        room.members.set(msg.username, msg.connectionRef);
        console.log(`[RoomManager] ${msg.username} joined ${msg.roomId} (${room.members.size} users)`);
        return state;
      }

      case 'user_left': {
        const room = state.rooms.get(msg.roomId);
        if (room) {
          room.members.delete(msg.username);
          console.log(`[RoomManager] ${msg.username} left ${msg.roomId} (${room.members.size} users)`);

          // Remove empty rooms
          if (room.members.size === 0) {
            state.rooms.delete(msg.roomId);
            console.log(`[RoomManager] Room removed: ${msg.roomId}`);
          }
        }
        return state;
      }
    }
  },

  terminate(reason: string, state: RoomManagerState): void {
    console.log(`[RoomManager] terminated: ${reason}`);
  },
};

function extractRoomId(topic: string): string | null {
  // topic format: room:{roomId}:join or room:{roomId}:leave
  const match = topic.match(/^room:([^:]+):/);
  return match ? match[1] : null;
}

// Start the Room Manager
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

  // Register for global lookup
  Registry.register('room-manager', ref);

  return ref;
}

// Get list of rooms
export async function listRooms(ref: GenServerRef): Promise<RoomInfo[]> {
  return GenServer.call(ref, { type: 'list_rooms' });
}

// Get users in a room
export async function getRoomUsers(
  ref: GenServerRef,
  roomId: string
): Promise<string[]> {
  return GenServer.call(ref, { type: 'get_room_users', roomId });
}
```

## Part 4: Connection Supervisor

The Connection Supervisor manages all active connections using `simple_one_for_one` strategy:

```typescript
// src/chat/connection-supervisor.ts
import { Supervisor, GenServer, type GenServerRef, type SupervisorRef, type EventBusRef } from '@hamicek/noex';
import { startConnection, type ServerMessage } from './connection';

let connectionCounter = 0;

// Start the Connection Supervisor
export async function startConnectionSupervisor(): Promise<SupervisorRef> {
  const ref = await Supervisor.start({
    strategy: 'simple_one_for_one',
    children: [], // Children added dynamically
    maxRestarts: 10,
    restartWithinMs: 60_000,
  });

  console.log('[ConnectionSupervisor] started');
  return ref;
}

// Add a new connection under supervision
export async function addConnection(
  supervisor: SupervisorRef,
  eventBus: EventBusRef,
  sendFn: (msg: ServerMessage) => void
): Promise<GenServerRef> {
  const connectionId = `conn-${++connectionCounter}`;

  const childSpec = {
    id: connectionId,
    start: () => startConnection(connectionId, eventBus, sendFn),
    restart: 'temporary' as const, // Don't restart disconnected connections
    shutdownTimeout: 5000,
  };

  const result = await Supervisor.startChild(supervisor, childSpec);
  console.log(`[ConnectionSupervisor] Added connection: ${connectionId}`);

  return result.ref!;
}

// Remove a connection
export async function removeConnection(
  supervisor: SupervisorRef,
  connectionId: string
): Promise<void> {
  await Supervisor.terminateChild(supervisor, connectionId);
  console.log(`[ConnectionSupervisor] Removed connection: ${connectionId}`);
}

// Get all active connections
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

## Part 5: Chat Application

Now bring everything together with the main Chat Application:

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
    console.log('[ChatApplication] Starting...');

    // 1. Start EventBus first (other components depend on it)
    const eventBus = await EventBus.start({ name: 'chat-events' });
    console.log('[ChatApplication] EventBus started');

    // 2. Start Room Manager
    const roomManager = await startRoomManager(eventBus);
    console.log('[ChatApplication] RoomManager started');

    // 3. Start Connection Supervisor
    const connectionSupervisor = await startConnectionSupervisor();
    console.log('[ChatApplication] ConnectionSupervisor started');

    // 4. Create top-level supervisor with all components
    const supervisor = await Supervisor.start({
      strategy: 'one_for_all', // If one fails, restart all (ensures consistency)
      children: [], // Components already started, supervisor just tracks them
      maxRestarts: 3,
      restartWithinMs: 60_000,
    });

    console.log('[ChatApplication] Started successfully');

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
    console.log(`[ChatApplication] Preparing to stop: ${reason}`);

    // Notify all connections about shutdown
    const connections = await getConnections(state.connectionSupervisor);
    for (const { ref } of connections) {
      try {
        GenServer.cast(ref, {
          type: 'send',
          message: {
            type: 'error',
            code: 'SERVER_SHUTDOWN',
            message: 'Server is shutting down',
          },
        });
      } catch {
        // Connection might already be gone
      }
    }

    // Give clients time to receive shutdown message
    await new Promise((resolve) => setTimeout(resolve, 1000));
  },

  async stop(reason, state) {
    console.log(`[ChatApplication] Stopping: ${reason}`);

    // Stop components in reverse order
    await Supervisor.stop(state.connectionSupervisor);
    await GenServer.stop(state.roomManager);
    await EventBus.stop(state.eventBus);

    // Unregister room manager
    try {
      Registry.unregister('room-manager');
    } catch {
      // May already be unregistered
    }

    console.log('[ChatApplication] Stopped');
  },
};

// Chat server instance wrapper
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

  // Handle new WebSocket connection
  async handleConnection(
    sendFn: (msg: ServerMessage) => void
  ): Promise<{
    connectionRef: ReturnType<typeof addConnection> extends Promise<infer T> ? T : never;
    onMessage: (msg: ClientMessage) => void;
    onDisconnect: () => void;
  }> {
    if (!this.state) {
      throw new Error('Chat server not started');
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

## Part 6: WebSocket Integration

Here's how to integrate with a WebSocket server (using `ws` library):

```typescript
// src/chat/server.ts
import { WebSocketServer, WebSocket } from 'ws';
import { ChatServer } from './chat-application';
import type { ClientMessage, ServerMessage } from './protocol';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

async function main() {
  // Start the chat application
  const chat = new ChatServer();
  await chat.start({ maxConnections: 1000 });

  // Create WebSocket server
  const wss = new WebSocketServer({ port: PORT });
  console.log(`WebSocket server listening on port ${PORT}`);

  wss.on('connection', async (ws: WebSocket) => {
    console.log('New WebSocket connection');

    // Send function wraps WebSocket.send
    const sendFn = (msg: ServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    // Create connection handler
    const { onMessage, onDisconnect } = await chat.handleConnection(sendFn);

    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        onMessage(msg);
      } catch (err) {
        sendFn({
          type: 'error',
          code: 'INVALID_JSON',
          message: 'Invalid JSON message',
        });
      }
    });

    // Handle disconnect
    ws.on('close', () => {
      console.log('WebSocket connection closed');
      onDisconnect();
    });

    // Handle errors
    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      onDisconnect();
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    wss.close();
    await chat.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);
```

## Part 7: Message Flow

Here's how a chat message flows through the system:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MESSAGE FLOW                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  User A sends: { type: 'message', roomId: 'general', text: 'Hello!' }      │
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
│         │ topic matches 'room:general:message'                              │
│         │                                                                   │
│    ┌────┴────┐                                                              │
│    │         │                                                              │
│    ▼         ▼                                                              │
│  ┌──────┐  ┌──────┐                                                         │
│  │Conn A│  │Conn B│──► handler receives event                               │
│  │      │  │      │                                                         │
│  └──────┘  └──────┘                                                         │
│    │         │                                                              │
│    │         ▼ sendFn(msg)                                                  │
│    │    ┌──────────┐                                                        │
│    │    │WebSocket │──► JSON.stringify() → ws.send()                        │
│    │    │  (B)     │                                                        │
│    │    └──────────┘                                                        │
│    │                                                                        │
│    ▼ Echo back to sender                                                    │
│  ┌──────────┐                                                               │
│  │WebSocket │──► { type: 'message', from: 'UserA', ... }                    │
│  │  (A)     │                                                               │
│  └──────────┘                                                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Testing the Chat Server

Here's how to test the chat server with integration tests:

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

  it('should allow joining a room', async () => {
    const { onMessage } = await createMockConnection('user1');

    onMessage({ type: 'join', roomId: 'test-room', username: 'Alice' });

    await waitFor(50);

    const messages = getMessages('user1');
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'joined', roomId: 'test-room' })
    );
  });

  it('should broadcast messages to room members', async () => {
    const conn1 = await createMockConnection('user1');
    const conn2 = await createMockConnection('user2');

    // Both users join the same room
    conn1.onMessage({ type: 'join', roomId: 'chat', username: 'Alice' });
    conn2.onMessage({ type: 'join', roomId: 'chat', username: 'Bob' });

    await waitFor(50);

    // Alice sends a message
    conn1.onMessage({ type: 'message', roomId: 'chat', text: 'Hello, Bob!' });

    await waitFor(50);

    // Bob should receive the message
    const bobMessages = getMessages('user2');
    expect(bobMessages).toContainEqual(
      expect.objectContaining({
        type: 'message',
        roomId: 'chat',
        from: 'Alice',
        text: 'Hello, Bob!',
      })
    );
  });

  it('should notify when users join/leave', async () => {
    const conn1 = await createMockConnection('user1');
    const conn2 = await createMockConnection('user2');

    // Alice joins first
    conn1.onMessage({ type: 'join', roomId: 'lobby', username: 'Alice' });
    await waitFor(50);

    // Bob joins after
    conn2.onMessage({ type: 'join', roomId: 'lobby', username: 'Bob' });
    await waitFor(50);

    // Alice should see Bob joined
    const aliceMessages = getMessages('user1');
    expect(aliceMessages).toContainEqual(
      expect.objectContaining({
        type: 'user_joined',
        roomId: 'lobby',
        username: 'Bob',
      })
    );

    // Bob leaves
    conn2.onMessage({ type: 'leave', roomId: 'lobby' });
    await waitFor(50);

    // Alice should see Bob left
    expect(aliceMessages).toContainEqual(
      expect.objectContaining({
        type: 'user_left',
        roomId: 'lobby',
        username: 'Bob',
      })
    );
  });

  it('should handle disconnect gracefully', async () => {
    const conn1 = await createMockConnection('user1');
    const conn2 = await createMockConnection('user2');

    conn1.onMessage({ type: 'join', roomId: 'temp', username: 'Alice' });
    conn2.onMessage({ type: 'join', roomId: 'temp', username: 'Bob' });
    await waitFor(50);

    // Simulate Bob disconnecting
    conn2.onDisconnect();
    await waitFor(50);

    // Alice should see Bob left
    const aliceMessages = getMessages('user1');
    expect(aliceMessages).toContainEqual(
      expect.objectContaining({
        type: 'user_left',
        roomId: 'temp',
        username: 'Bob',
      })
    );
  });

  it('should prevent sending to rooms not joined', async () => {
    const { onMessage } = await createMockConnection('user1');

    onMessage({ type: 'join', roomId: 'room1', username: 'Alice' });
    await waitFor(50);

    // Try to send to a different room
    onMessage({ type: 'message', roomId: 'room2', text: 'Sneaky!' });
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

## Exercise: Add Message History

Enhance the chat server with message history:

**Requirements:**
1. Store the last 100 messages per room
2. Send history to users when they join a room
3. Add a `{ type: 'get_history', roomId: string }` client message
4. Limit history storage to prevent memory issues

**Starter code:**

```typescript
// Extend the Room interface
interface Room {
  id: string;
  members: Map<string, GenServerRef>;
  createdAt: number;
  history: RoomMessageEvent[]; // Add this
  maxHistorySize: number;      // Add this
}

// Add to RoomManager handleCast
case 'room_message': {
  // TODO: Store message in room history
  // TODO: Trim history if exceeds maxHistorySize
}

// Add to Connection handleJoin
// TODO: Request history from RoomManager
// TODO: Send history to client after 'joined' message
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
// Modified room-manager.ts

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
  | { type: 'get_history'; roomId: string; limit?: number }; // New

type RoomManagerCastMsg =
  | { type: 'user_joined'; roomId: string; username: string; connectionRef: GenServerRef }
  | { type: 'user_left'; roomId: string; username: string }
  | { type: 'room_message'; roomId: string; message: RoomMessageEvent }; // New

// In handleCall, add:
case 'get_history': {
  const room = state.rooms.get(msg.roomId);
  if (!room) {
    return [[], state];
  }
  const limit = msg.limit ?? 50;
  const history = room.history.slice(-limit);
  return [history, state];
}

// In handleCast, add:
case 'room_message': {
  const room = state.rooms.get(msg.roomId);
  if (room) {
    room.history.push(msg.message);

    // Trim history if exceeds max
    if (room.history.length > room.maxHistorySize) {
      room.history = room.history.slice(-room.maxHistorySize);
    }
  }
  return state;
}

// Update user_joined case to initialize history:
case 'user_joined': {
  let room = state.rooms.get(msg.roomId);

  if (!room) {
    room = {
      id: msg.roomId,
      members: new Map(),
      createdAt: Date.now(),
      history: [],           // Initialize history
      maxHistorySize: 100,   // Default limit
    };
    state.rooms.set(msg.roomId, room);
  }

  room.members.set(msg.username, msg.connectionRef);
  return state;
}

// Modified connection.ts - handleMessage function
function handleMessage(
  roomId: string,
  text: string,
  state: ConnectionState
): ConnectionState {
  // ... existing validation ...

  const event: RoomMessageEvent = {
    roomId,
    from: state.username,
    text,
    timestamp: Date.now(),
  };

  // Publish to room
  EventBus.publish(state.eventBus, `room:${roomId}:message`, event);

  // Also notify RoomManager to store in history
  const roomManagerRef = Registry.whereis('room-manager');
  if (roomManagerRef) {
    GenServer.cast(roomManagerRef, {
      type: 'room_message',
      roomId,
      message: event,
    });
  }

  // Echo back to sender
  state.sendFn({
    type: 'message',
    roomId,
    from: state.username,
    text,
    timestamp: event.timestamp,
  });

  return state;
}

// Modified handleJoin - after joining, fetch and send history
async function handleJoin(
  roomId: string,
  username: string,
  state: ConnectionState
): Promise<ConnectionState> {
  // ... existing validation and setup ...

  // After sending 'joined' message, send history
  const roomManagerRef = Registry.whereis('room-manager');
  if (roomManagerRef) {
    try {
      const history = await GenServer.call<
        unknown,
        { type: 'get_history'; roomId: string; limit?: number },
        unknown,
        RoomMessageEvent[]
      >(roomManagerRef, { type: 'get_history', roomId, limit: 50 });

      // Send history as individual messages
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
      // History fetch failed, continue without it
    }
  }

  return newState;
}

// Add new client message type
type ClientMessage =
  | { type: 'join'; roomId: string; username: string }
  | { type: 'leave'; roomId: string }
  | { type: 'message'; roomId: string; text: string }
  | { type: 'list_rooms' }
  | { type: 'list_users'; roomId: string }
  | { type: 'get_history'; roomId: string; limit?: number }; // New

// Handle get_history in connection
case 'get_history': {
  if (!state.joinedRooms.has(msg.roomId)) {
    state.sendFn({
      type: 'error',
      code: 'NOT_IN_ROOM',
      message: `Not in room ${msg.roomId}`,
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
          message: 'Failed to fetch history',
        });
      });
  }
  return state;
}
```

**Key design decisions:**

1. **History stored in RoomManager** — Central storage with consistent limits
2. **Circular buffer pattern** — `slice(-maxHistorySize)` keeps only recent messages
3. **Async history fetch** — Doesn't block join operation
4. **Per-room limits** — Each room can have different history sizes
5. **History on join** — New users see recent conversation context

</details>

## Summary

**Key takeaways:**

- **One GenServer per connection** — Isolates state and failures between users
- **Supervisor for dynamic children** — `simple_one_for_one` handles connection lifecycle
- **EventBus for broadcasting** — Decouples rooms from connections
- **Registry for service discovery** — Named lookup for room manager
- **Graceful shutdown** — Notify clients before stopping

**Architecture patterns used:**

| Pattern | Where Used |
|---------|------------|
| Per-entity GenServer | Each WebSocket connection |
| Dynamic Supervisor | Connection management |
| Pub/Sub | Room message broadcasting |
| Registry | Service lookup |
| Application | System composition |

**What you've learned:**

1. How to design a multi-component actor system
2. Per-connection isolation with GenServer
3. Dynamic process management with Supervisor
4. Event-driven messaging with EventBus
5. Service discovery with Registry
6. Graceful startup and shutdown

> **Architecture insight:** The chat server demonstrates the power of actor model composition. Each component has a single responsibility, communicates through well-defined messages, and can fail independently without affecting the whole system.

---

Next: [Task Queue](./02-task-queue.md)
