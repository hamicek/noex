# Distributed Chat Example

Interactive chat application demonstrating noex distribution features.

## Features Demonstrated

- **Cluster Formation**: Seed-based P2P cluster discovery
- **Remote Spawn**: Creating processes on remote nodes
- **Remote Call/Cast**: Cross-node message passing
- **Global Registry**: Cluster-wide process lookup
- **Node Lifecycle**: Handling node join/leave events

## Quick Start

```bash
# Install dependencies
npm install

# Terminal 1 - Start first node
npm run node1

# Terminal 2 - Start second node (connects to first)
npm run node2

# Terminal 3 (optional) - Start third node
npm run node3
```

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help message |
| `/name <username>` | Set your username (required before joining) |
| `/create <room>` | Create a chat room on local node |
| `/create <room> on <node>` | Create a room on a specific node |
| `/join <room>` | Join an existing room |
| `/leave` | Leave current room |
| `/msg <text>` | Send a message (or just type directly) |
| `/users` | List users in current room |
| `/rooms` | List all rooms across the cluster |
| `/nodes` | List connected nodes |
| `/quit` | Disconnect and exit |

## Example Session

**Terminal 1 (node1):**
```
> /name Alice
Username set to: Alice

> /create general
Room "general" created successfully.

> /join general
Joined room "general". Type messages directly or use /msg.

> Hello from node1!
[10:30:15] [general] Alice: Hello from node1!
```

**Terminal 2 (node2):**
```
Node joined: node1@127.0.0.1:4369

> /name Bob
Username set to: Bob

> /rooms
Available rooms:
  - general (on node1@127.0.0.1:4369)

> /join general
Joined room "general". Type messages directly or use /msg.

[10:30:15] [general] Alice: Hello from node1!

> Hi Alice! I'm on node2.
[10:30:45] [general] Bob: Hi Alice! I'm on node2.
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Cluster                                  │
├─────────────────────┬───────────────────────────────────────────┤
│      Node 1         │              Node 2                        │
├─────────────────────┼───────────────────────────────────────────┤
│  ChatRoom:general   │◄── RemoteCall ──► ChatUser:Bob            │
│  (GlobalRegistry)   │                                            │
│                     │                                            │
│  ChatUser:Alice     │                                            │
└─────────────────────┴───────────────────────────────────────────┘
```

## Key API Usage

### Cluster Initialization
```typescript
import { Cluster, BehaviorRegistry } from 'noex/distribution';

// Register behaviors before starting cluster
BehaviorRegistry.register('chat:room', chatRoomBehavior);

await Cluster.start({
  nodeName: 'node1',
  port: 4369,
  seeds: ['node2@127.0.0.1:4370'],
});
```

### Remote Spawn
```typescript
import { RemoteSpawn } from 'noex/distribution';

const result = await RemoteSpawn.spawn('chat:room', targetNodeId, {
  name: 'room:general',
  registration: 'global',
});
```

### Global Registry
```typescript
import { GlobalRegistry } from 'noex/distribution';

// Register
await GlobalRegistry.register('room:general', { id: ref.id, nodeId });

// Lookup
const ref = GlobalRegistry.lookup('room:general');
```

### Remote Call/Cast
```typescript
import { RemoteCall } from 'noex/distribution';

// Synchronous call
const result = await RemoteCall.call(remoteRef, { type: 'get_users' });

// Asynchronous cast
RemoteCall.cast(remoteRef, { type: 'broadcast', content: 'Hello!' });
```

### Node Events
```typescript
Cluster.onNodeUp((node) => {
  console.log(`Node joined: ${node.id}`);
});

Cluster.onNodeDown((nodeId, reason) => {
  console.log(`Node left: ${nodeId} (${reason})`);
});
```
