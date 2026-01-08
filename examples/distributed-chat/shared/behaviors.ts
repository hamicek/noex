/**
 * GenServer behaviors for the distributed chat example.
 *
 * Implements:
 * - ChatRoom: Manages users and broadcasts messages
 * - ChatUser: Represents a connected user, receives messages
 */

import type { GenServerBehavior, CallResult } from 'noex';
import { GenServer } from 'noex';
import { Cluster, RemoteCall, type SerializedRef } from 'noex/distribution';
import type {
  ChatRoomState,
  ChatRoomCallMsg,
  ChatRoomCastMsg,
  ChatRoomCallReply,
  ChatUserState,
  ChatUserCallMsg,
  ChatUserCastMsg,
  ChatUserCallReply,
  ChatUser,
  ChatMessage,
} from './types.js';
import { MAX_MESSAGE_HISTORY } from './types.js';

// =============================================================================
// Smart Cast Helper
// =============================================================================

/**
 * Casts to a process - uses local GenServer.cast for local refs,
 * RemoteCall.cast for remote refs.
 */
function smartCast(ref: SerializedRef, msg: unknown): void {
  const localNodeId = Cluster.getLocalNodeId();
  if (ref.nodeId === localNodeId) {
    const localRef = GenServer._getRefById(ref.id);
    if (localRef) {
      GenServer.cast(localRef, msg);
    }
  } else {
    RemoteCall.cast(ref, msg);
  }
}

// =============================================================================
// Chat Room Behavior
// =============================================================================

/**
 * Creates a chat room behavior with the specified room name.
 *
 * The room maintains a list of connected users and broadcasts messages
 * to all participants. Message history is kept for late joiners.
 */
export function createChatRoomBehavior(
  roomName: string,
): GenServerBehavior<ChatRoomState, ChatRoomCallMsg, ChatRoomCastMsg, ChatRoomCallReply> {
  return {
    init(): ChatRoomState {
      return {
        name: roomName,
        users: new Map(),
        messages: [],
      };
    },

    handleCall(msg, state): CallResult<ChatRoomCallReply, ChatRoomState> {
      switch (msg.type) {
        case 'join': {
          // Check if username is already taken
          if (state.users.has(msg.username)) {
            return [{ ok: false, error: 'Username already taken in this room' }, state];
          }

          const newUser: ChatUser = {
            username: msg.username,
            ref: msg.userRef,
            joinedAt: Date.now(),
          };

          const newUsers = new Map(state.users);
          newUsers.set(msg.username, newUser);

          return [{ ok: true }, { ...state, users: newUsers }];
        }

        case 'leave': {
          if (!state.users.has(msg.username)) {
            return [{ ok: false, error: 'User not in room' }, state];
          }

          const newUsers = new Map(state.users);
          newUsers.delete(msg.username);

          return [{ ok: true }, { ...state, users: newUsers }];
        }

        case 'get_users': {
          const usernames = Array.from(state.users.keys());
          return [{ users: usernames }, state];
        }

        case 'get_messages': {
          const limit = msg.limit ?? MAX_MESSAGE_HISTORY;
          const messages = state.messages.slice(-limit);
          return [{ messages }, state];
        }

        case 'get_info': {
          return [{ name: state.name, userCount: state.users.size }, state];
        }
      }
    },

    handleCast(msg, state): ChatRoomState {
      switch (msg.type) {
        case 'broadcast': {
          const message: ChatMessage = {
            from: msg.from,
            content: msg.content,
            timestamp: Date.now(),
          };

          // Add to history (with limit)
          const messages = [...state.messages, message].slice(-MAX_MESSAGE_HISTORY);

          // Broadcast to all users via cast
          for (const user of state.users.values()) {
            // Don't send back to sender
            if (user.username !== msg.from) {
              smartCast(user.ref, {
                type: 'message',
                room: state.name,
                from: msg.from,
                content: msg.content,
                timestamp: message.timestamp,
              });
            }
          }

          return { ...state, messages };
        }

        case 'user_left': {
          if (!state.users.has(msg.username)) {
            return state;
          }

          const newUsers = new Map(state.users);
          newUsers.delete(msg.username);

          // Notify remaining users
          for (const user of newUsers.values()) {
            smartCast(user.ref, {
              type: 'message',
              room: state.name,
              from: 'System',
              content: `${msg.username} has left the room`,
              timestamp: Date.now(),
            });
          }

          return { ...state, users: newUsers };
        }
      }
    },
  };
}

/**
 * Generic chat room behavior for remote spawning.
 *
 * This is registered in BehaviorRegistry and creates rooms with
 * a default name. The actual room name should be passed via init args
 * or set after creation.
 */
export const chatRoomBehavior: GenServerBehavior<
  ChatRoomState,
  ChatRoomCallMsg,
  ChatRoomCastMsg,
  ChatRoomCallReply
> = {
  init(): ChatRoomState {
    return {
      name: 'unnamed',
      users: new Map(),
      messages: [],
    };
  },

  handleCall(msg: ChatRoomCallMsg, state: ChatRoomState): CallResult<ChatRoomCallReply, ChatRoomState> {
    return createChatRoomBehavior(state.name).handleCall(msg, state);
  },

  handleCast(msg: ChatRoomCastMsg, state: ChatRoomState): ChatRoomState {
    return createChatRoomBehavior(state.name).handleCast(msg, state);
  },
};

// =============================================================================
// Chat User Behavior
// =============================================================================

/**
 * Creates a chat user behavior with the specified username.
 *
 * The user process receives messages from rooms and invokes
 * the registered message handler for display.
 */
export function createChatUserBehavior(
  username: string,
): GenServerBehavior<ChatUserState, ChatUserCallMsg, ChatUserCastMsg, ChatUserCallReply> {
  return {
    init(): ChatUserState {
      return {
        username,
        currentRoom: null,
        roomRef: null,
        onMessage: null,
      };
    },

    handleCall(msg, state): CallResult<ChatUserCallReply, ChatUserState> {
      switch (msg.type) {
        case 'get_state': {
          return [state, state];
        }

        case 'set_message_handler': {
          return [{ ok: true }, { ...state, onMessage: msg.handler }];
        }
      }
    },

    handleCast(msg, state): ChatUserState {
      switch (msg.type) {
        case 'message': {
          if (state.onMessage) {
            state.onMessage({
              room: msg.room,
              from: msg.from,
              content: msg.content,
              timestamp: msg.timestamp,
            });
          }
          return state;
        }

        case 'room_joined': {
          return {
            ...state,
            currentRoom: msg.room,
            roomRef: msg.roomRef,
          };
        }

        case 'room_left': {
          return {
            ...state,
            currentRoom: null,
            roomRef: null,
          };
        }
      }
    },
  };
}

/**
 * Generic chat user behavior for remote spawning.
 */
export const chatUserBehavior: GenServerBehavior<
  ChatUserState,
  ChatUserCallMsg,
  ChatUserCastMsg,
  ChatUserCallReply
> = {
  init(): ChatUserState {
    return {
      username: 'anonymous',
      currentRoom: null,
      roomRef: null,
      onMessage: null,
    };
  },

  handleCall(msg: ChatUserCallMsg, state: ChatUserState): CallResult<ChatUserCallReply, ChatUserState> {
    return createChatUserBehavior(state.username).handleCall(msg, state);
  },

  handleCast(msg: ChatUserCastMsg, state: ChatUserState): ChatUserState {
    return createChatUserBehavior(state.username).handleCast(msg, state);
  },
};
