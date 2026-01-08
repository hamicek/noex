/**
 * Type definitions for the distributed chat example.
 *
 * Demonstrates proper TypeScript typing for GenServer behaviors
 * in a distributed cluster environment.
 */

import type { SerializedRef } from 'noex/distribution';

// =============================================================================
// Chat Room Types
// =============================================================================

/**
 * State of a chat room.
 */
export interface ChatRoomState {
  /** Unique name of the room */
  readonly name: string;

  /** Connected users by their username */
  readonly users: ReadonlyMap<string, ChatUser>;

  /** Message history (limited to last N messages) */
  readonly messages: readonly ChatMessage[];
}

/**
 * A user connected to a chat room.
 */
export interface ChatUser {
  /** Username */
  readonly username: string;

  /** Reference to the user's process (for sending messages) */
  readonly ref: SerializedRef;

  /** When the user joined */
  readonly joinedAt: number;
}

/**
 * A message in the chat room.
 */
export interface ChatMessage {
  /** Username of the sender */
  readonly from: string;

  /** Message content */
  readonly content: string;

  /** Timestamp when sent */
  readonly timestamp: number;
}

/**
 * Call messages for ChatRoom.
 */
export type ChatRoomCallMsg =
  | { readonly type: 'join'; readonly username: string; readonly userRef: SerializedRef }
  | { readonly type: 'leave'; readonly username: string }
  | { readonly type: 'get_users' }
  | { readonly type: 'get_messages'; readonly limit?: number }
  | { readonly type: 'get_info' };

/**
 * Cast messages for ChatRoom.
 */
export type ChatRoomCastMsg =
  | { readonly type: 'broadcast'; readonly from: string; readonly content: string }
  | { readonly type: 'user_left'; readonly username: string };

/**
 * Reply types for ChatRoom calls.
 */
export type ChatRoomCallReply =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }
  | { readonly users: readonly string[] }
  | { readonly messages: readonly ChatMessage[] }
  | { readonly name: string; readonly userCount: number };

// =============================================================================
// Chat User Types
// =============================================================================

/**
 * State of a chat user process.
 */
export interface ChatUserState {
  /** Username */
  readonly username: string;

  /** Currently joined room (if any) */
  readonly currentRoom: string | null;

  /** Reference to the current room's process */
  readonly roomRef: SerializedRef | null;

  /** Callback for received messages */
  readonly onMessage: ((msg: IncomingChatMessage) => void) | null;
}

/**
 * An incoming message to display to the user.
 */
export interface IncomingChatMessage {
  /** Room the message came from */
  readonly room: string;

  /** Username of the sender */
  readonly from: string;

  /** Message content */
  readonly content: string;

  /** Timestamp */
  readonly timestamp: number;
}

/**
 * Call messages for ChatUser.
 */
export type ChatUserCallMsg =
  | { readonly type: 'get_state' }
  | { readonly type: 'set_message_handler'; readonly handler: (msg: IncomingChatMessage) => void };

/**
 * Cast messages for ChatUser.
 */
export type ChatUserCastMsg =
  | { readonly type: 'message'; readonly room: string; readonly from: string; readonly content: string; readonly timestamp: number }
  | { readonly type: 'room_joined'; readonly room: string; readonly roomRef: SerializedRef }
  | { readonly type: 'room_left' };

/**
 * Reply types for ChatUser calls.
 */
export type ChatUserCallReply =
  | ChatUserState
  | { readonly ok: true };

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum number of messages to keep in room history.
 */
export const MAX_MESSAGE_HISTORY = 100;

/**
 * Behavior names for remote spawning.
 */
export const BEHAVIOR_NAMES = {
  CHAT_ROOM: 'distributed-chat:room',
  CHAT_USER: 'distributed-chat:user',
} as const;
