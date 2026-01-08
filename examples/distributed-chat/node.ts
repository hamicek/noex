/**
 * Distributed Chat Node
 *
 * Interactive chat application demonstrating noex distribution features:
 * - Cluster formation with seed-based discovery
 * - Remote process spawning (RemoteSpawn)
 * - Cross-node communication (RemoteCall/Cast)
 * - Global process registry (GlobalRegistry)
 * - Node lifecycle events
 *
 * Usage:
 *   npx tsx node.ts --name <node-name> --port <port> [--seed <node@host:port>]
 *
 * Example:
 *   Terminal 1: npx tsx node.ts --name node1 --port 4369
 *   Terminal 2: npx tsx node.ts --name node2 --port 4370 --seed node1@127.0.0.1:4369
 */

import * as readline from 'node:readline';
import { GenServer, type GenServerRef } from 'noex';
import {
  Cluster,
  BehaviorRegistry,
  GlobalRegistry,
  RemoteSpawn,
  RemoteCall,
  type NodeId,
  type SerializedRef,
  type NodeInfo,
  type NodeDownReason,
} from 'noex/distribution';

import { createChatRoomBehavior, createChatUserBehavior, chatRoomBehavior, chatUserBehavior } from './shared/behaviors.js';
import {
  BEHAVIOR_NAMES,
  type ChatRoomCallMsg,
  type ChatRoomCallReply,
  type ChatRoomCastMsg,
  type ChatUserCallMsg,
  type ChatUserCastMsg,
  type ChatUserCallReply,
  type IncomingChatMessage,
} from './shared/types.js';

// =============================================================================
// CLI Argument Parsing
// =============================================================================

interface NodeArgs {
  name: string;
  port: number;
  seeds: string[];
}

function parseArgs(): NodeArgs {
  const args = process.argv.slice(2);
  let name = '';
  let port = 4369;
  const seeds: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--name':
      case '-n':
        name = args[++i] ?? '';
        break;
      case '--port':
      case '-p':
        port = parseInt(args[++i] ?? '4369', 10);
        break;
      case '--seed':
      case '-s':
        seeds.push(args[++i] ?? '');
        break;
    }
  }

  if (!name) {
    console.error('Error: --name is required');
    console.error('Usage: npx tsx node.ts --name <name> --port <port> [--seed <node@host:port>]');
    process.exit(1);
  }

  return { name, port, seeds: seeds.filter(Boolean) };
}

// =============================================================================
// State
// =============================================================================

type UserRef = GenServerRef<unknown, ChatUserCallMsg, ChatUserCastMsg, ChatUserCallReply>;

interface ChatState {
  username: string;
  currentRoom: string | null;
  currentRoomRef: SerializedRef | null;
  userRef: UserRef | null;
}

const state: ChatState = {
  username: '',
  currentRoom: null,
  currentRoomRef: null,
  userRef: null,
};

// =============================================================================
// Message Display
// =============================================================================

let rl: readline.Interface;

function displayMessage(msg: IncomingChatMessage): void {
  const time = new Date(msg.timestamp).toLocaleTimeString();
  console.log(`\n[${time}] [${msg.room}] ${msg.from}: ${msg.content}`);
  rl.prompt(true);
}

function log(message: string): void {
  console.log(`\n${message}`);
  rl.prompt(true);
}

// =============================================================================
// Commands
// =============================================================================

async function handleCommand(input: string): Promise<void> {
  const trimmed = input.trim();
  if (!trimmed) return;

  const [command, ...args] = trimmed.split(/\s+/);

  try {
    switch (command) {
      case '/help':
        showHelp();
        break;

      case '/name':
        await setUsername(args.join(' '));
        break;

      case '/create':
        await createRoom(args);
        break;

      case '/join':
        await joinRoom(args[0]);
        break;

      case '/leave':
        await leaveRoom();
        break;

      case '/msg':
        await sendMessage(args.join(' '));
        break;

      case '/users':
        await listUsers();
        break;

      case '/rooms':
        listRooms();
        break;

      case '/nodes':
        listNodes();
        break;

      case '/quit':
        await quit();
        break;

      default:
        // If in a room, treat as a message
        if (state.currentRoom && !trimmed.startsWith('/')) {
          await sendMessage(trimmed);
        } else {
          log(`Unknown command: ${command}. Type /help for available commands.`);
        }
    }
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function showHelp(): void {
  console.log(`
Distributed Chat Commands:
  /help                     Show this help message
  /name <username>          Set your username (required before joining rooms)
  /create <room>            Create a chat room locally
  /create <room> on <node>  Create a room on a specific node
  /join <room>              Join a chat room
  /leave                    Leave the current room
  /msg <text>               Send a message to the current room
  /users                    List users in the current room
  /rooms                    List all available rooms (GlobalRegistry)
  /nodes                    List connected nodes
  /quit                     Disconnect and exit

When in a room, you can type messages directly without /msg.
`);
}

async function setUsername(username: string): Promise<void> {
  if (!username) {
    log('Usage: /name <username>');
    return;
  }

  if (state.currentRoom) {
    log('Cannot change username while in a room. Use /leave first.');
    return;
  }

  state.username = username;

  // Create user process
  const userBehavior = createChatUserBehavior(username);
  state.userRef = await GenServer.start(userBehavior) as UserRef;

  // Set up message handler
  await GenServer.call(state.userRef, {
    type: 'set_message_handler',
    handler: displayMessage,
  });

  log(`Username set to: ${username}`);
}

async function createRoom(args: string[]): Promise<void> {
  // Parse: /create <room> [on <node>]
  const onIndex = args.indexOf('on');
  let roomName: string;
  let targetNode: NodeId | null = null;

  if (onIndex !== -1) {
    roomName = args.slice(0, onIndex).join(' ');
    const nodeName = args.slice(onIndex + 1).join(' ');

    // Find the node
    const nodes = Cluster.getNodes();
    const node = nodes.find((n: NodeInfo) => n.id.startsWith(nodeName + '@') || n.id === nodeName);

    if (!node) {
      log(`Node not found: ${nodeName}. Available nodes:`);
      for (const n of nodes) {
        log(`  - ${n.id}`);
      }
      return;
    }
    targetNode = node.id;
  } else {
    roomName = args.join(' ');
  }

  if (!roomName) {
    log('Usage: /create <room> [on <node>]');
    return;
  }

  // Check if room already exists
  const globalName = `room:${roomName}`;
  if (GlobalRegistry.isRegistered(globalName)) {
    log(`Room "${roomName}" already exists.`);
    return;
  }

  if (targetNode && targetNode !== Cluster.getLocalNodeId()) {
    // Spawn on remote node
    log(`Creating room "${roomName}" on ${targetNode}...`);

    const result = await RemoteSpawn.spawn(BEHAVIOR_NAMES.CHAT_ROOM, targetNode, {
      name: globalName,
      registration: 'global',
    });

    log(`Room "${roomName}" created on ${result.nodeId}.`);
  } else {
    // Spawn locally
    const behavior = createChatRoomBehavior(roomName);
    const roomRef = await GenServer.start(behavior, { name: globalName });

    // Register globally
    const localNodeId = Cluster.getLocalNodeId();
    await GlobalRegistry.register(globalName, {
      id: roomRef.id,
      nodeId: localNodeId,
    });

    log(`Room "${roomName}" created successfully.`);
  }
}

async function joinRoom(roomName: string | undefined): Promise<void> {
  if (!roomName) {
    log('Usage: /join <room>');
    return;
  }

  if (!state.username) {
    log('Please set a username first with /name <username>');
    return;
  }

  if (state.currentRoom) {
    log(`Already in room "${state.currentRoom}". Use /leave first.`);
    return;
  }

  const globalName = `room:${roomName}`;
  const roomRef = GlobalRegistry.whereis(globalName);

  if (!roomRef) {
    log(`Room "${roomName}" not found. Use /create to create it.`);
    return;
  }

  // Join the room
  const localNodeId = Cluster.getLocalNodeId();
  const userSerializedRef: SerializedRef = {
    id: state.userRef!.id,
    nodeId: localNodeId,
  };

  const result = await RemoteCall.call<ChatRoomCallReply>(roomRef, {
    type: 'join',
    username: state.username,
    userRef: userSerializedRef,
  }, { timeout: 5000 });

  if ('ok' in result && result.ok === false) {
    log(`Failed to join: ${result.error}`);
    return;
  }

  state.currentRoom = roomName;
  state.currentRoomRef = roomRef;

  // Update user state
  GenServer.cast(state.userRef!, {
    type: 'room_joined',
    room: roomName,
    roomRef: roomRef,
  });

  log(`Joined room "${roomName}". Type messages directly or use /msg.`);
}

async function leaveRoom(): Promise<void> {
  if (!state.currentRoom || !state.currentRoomRef) {
    log('Not in any room.');
    return;
  }

  try {
    // Notify room
    RemoteCall.cast(state.currentRoomRef, {
      type: 'user_left',
      username: state.username,
    });
  } catch {
    // Room might be gone
  }

  const roomName = state.currentRoom;
  state.currentRoom = null;
  state.currentRoomRef = null;

  // Update user state
  if (state.userRef) {
    GenServer.cast(state.userRef, { type: 'room_left' });
  }

  log(`Left room "${roomName}".`);
}

async function sendMessage(content: string): Promise<void> {
  if (!content) {
    return;
  }

  if (!state.currentRoom || !state.currentRoomRef) {
    log('Not in any room. Use /join <room> first.');
    return;
  }

  // Send to room via cast (fire-and-forget)
  RemoteCall.cast(state.currentRoomRef, {
    type: 'broadcast',
    from: state.username,
    content: content,
  });

  // Display own message locally
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] [${state.currentRoom}] ${state.username}: ${content}`);
}

async function listUsers(): Promise<void> {
  if (!state.currentRoom || !state.currentRoomRef) {
    log('Not in any room.');
    return;
  }

  const result = await RemoteCall.call<ChatRoomCallReply>(state.currentRoomRef, {
    type: 'get_users',
  }, { timeout: 5000 });

  if ('users' in result) {
    log(`Users in "${state.currentRoom}":`);
    for (const user of result.users) {
      console.log(`  - ${user}${user === state.username ? ' (you)' : ''}`);
    }
  }
}

function listRooms(): void {
  const names = GlobalRegistry.getNames();
  const rooms = names.filter((n: string) => n.startsWith('room:'));

  if (rooms.length === 0) {
    log('No rooms available. Use /create <name> to create one.');
    return;
  }

  log('Available rooms:');
  for (const room of rooms) {
    const roomName = room.slice(5); // Remove 'room:' prefix
    const ref = GlobalRegistry.whereis(room);
    const nodeId = ref?.nodeId ?? 'unknown';
    const isCurrent = roomName === state.currentRoom;
    console.log(`  - ${roomName} (on ${nodeId})${isCurrent ? ' [joined]' : ''}`);
  }
}

function listNodes(): void {
  const localId = Cluster.getLocalNodeId();
  const nodes = Cluster.getNodes();

  log('Connected nodes:');
  console.log(`  - ${localId} (local)`);

  for (const node of nodes) {
    if (node.id !== localId) {
      console.log(`  - ${node.id} (${node.status})`);
    }
  }

  console.log(`\nTotal: ${nodes.length + 1} nodes`);
}

async function quit(): Promise<void> {
  await leaveRoom();

  if (state.userRef) {
    await GenServer.stop(state.userRef);
  }

  log('Disconnecting from cluster...');
  await Cluster.stop();
  process.exit(0);
}

// =============================================================================
// Main
// =============================================================================

const args = parseArgs();

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  Distributed Chat - noex Distribution Example');
  console.log('='.repeat(60));
  console.log();

  // Register behaviors for remote spawning
  BehaviorRegistry.register(BEHAVIOR_NAMES.CHAT_ROOM, chatRoomBehavior);
  BehaviorRegistry.register(BEHAVIOR_NAMES.CHAT_USER, chatUserBehavior);

  // Start cluster
  console.log(`Starting node: ${args.name}@127.0.0.1:${args.port}`);
  if (args.seeds.length > 0) {
    console.log(`Connecting to seeds: ${args.seeds.join(', ')}`);
  }
  console.log();

  await Cluster.start({
    nodeName: args.name,
    port: args.port,
    seeds: args.seeds,
  });

  console.log('Cluster started successfully!');
  console.log('Type /help for available commands.');
  console.log();

  // Set up event handlers
  Cluster.onNodeUp((node: NodeInfo) => {
    log(`Node joined: ${node.id}`);
  });

  Cluster.onNodeDown((nodeId: NodeId, reason: NodeDownReason) => {
    log(`Node left: ${nodeId} (${reason})`);

    // If we were in a room on that node, leave it
    if (state.currentRoomRef?.nodeId === nodeId) {
      state.currentRoom = null;
      state.currentRoomRef = null;
      log('You were disconnected from the room.');
    }
  });

  // Set up readline
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.on('line', async (line: string) => {
    await handleCommand(line);
    rl.prompt();
  });

  rl.on('close', async () => {
    await quit();
  });

  rl.prompt();
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\nShutting down...');
  await quit();
});

process.on('SIGTERM', async () => {
  await quit();
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
