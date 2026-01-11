# noex-web-dashboard

Web-based dashboard for real-time monitoring of noex applications. Built with Svelte 5 and TypeScript.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    noex-web-dashboard                       │
│  ┌─────────────────┐      ┌──────────────────────────────┐  │
│  │ DashboardServer │<────>│        Bridge Server         │  │
│  │   (TCP :9876)   │      │  ┌────────┐  ┌─────────┐    │  │
│  └─────────────────┘      │  │  TCP   │──│WebSocket│<───┼──┤ Browsers
│                           │  │ Bridge │  │ Handler │    │  │
│                           │  └────────┘  └─────────┘    │  │
│                           │  ┌───────────────────────┐  │  │
│                           │  │ Static Server (HTTP)  │<─┼──┤ HTTP
│                           │  └───────────────────────┘  │  │
│                           └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

The dashboard operates as a bridge between the noex DashboardServer (TCP) and web browsers (WebSocket):

1. **TCP Bridge** - Connects to the noex DashboardServer using length-prefixed JSON protocol
2. **WebSocket Handler** - Broadcasts messages to connected browser clients in real-time
3. **Static Server** - Serves the built Svelte SPA over HTTP

## Installation

```bash
# Install as a project dependency
npm install noex-web-dashboard

# Or install globally
npm install -g noex-web-dashboard
```

## Usage

### Prerequisites

Start a noex application with the DashboardServer enabled:

```bash
# Example: Start cluster-observer with dashboard on port 9876
npx tsx examples/cluster-observer/node.ts --name nodeA --port 4369 --dashboard 9876
```

### Starting the Web Dashboard

```bash
# Connect to localhost:9876 (default), serve on port 3000
noex-web-dashboard

# Connect to a specific DashboardServer
noex-web-dashboard --host 192.168.1.100 --port 9876

# Use custom web port and auto-open browser
noex-web-dashboard --web-port 8080 --open

# Quiet mode (suppress non-essential output)
noex-web-dashboard --quiet
```

Then open `http://localhost:3000` in your browser.

## CLI Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--host <address>` | `-H` | DashboardServer host | `localhost` |
| `--port <number>` | `-p` | DashboardServer TCP port | `9876` |
| `--web-port <number>` | `-w` | Web server HTTP port | `7210` |
| `--static-path <path>` | `-s` | Path to built Svelte SPA | `./dist/client` |
| `--open` | `-o` | Open browser automatically | `false` |
| `--quiet` | `-q` | Suppress non-essential output | `false` |
| `--help` | `-h` | Show help message | - |
| `--version` | `-v` | Show version number | - |

## Features

### View Modes

- **Local View** - Monitor processes on a single node with process tree, stats table, memory usage, and event log
- **Cluster View** - Monitor multiple nodes in a distributed cluster with aggregated statistics

### Layout Modes

Three layout options optimized for different use cases:

- **Full** - Complete view with all panels visible
- **Compact** - Condensed view with essential information
- **Minimal** - Streamlined view for limited screen space

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `r` | Refresh data |
| `c` | Toggle cluster/local view |
| `1` | Full layout |
| `2` | Compact layout |
| `3` | Minimal layout |
| `t` | Toggle dark/light theme |
| `?` or `h` | Show help |
| `Esc` | Close dialogs |

### Theme Support

Automatic theme detection based on system preferences with manual toggle support. Themes persist across sessions via localStorage.

## Components

The dashboard includes the following Svelte components:

- **ProcessTree** - Hierarchical visualization of process supervision tree
- **StatsTable** - Sortable table of GenServer statistics (message queue, memory, state size)
- **MemoryGauge** - Visual memory usage indicator with percentage display
- **EventLog** - Scrollable log of process lifecycle events
- **ClusterTree** - Tree view of cluster nodes with connection status
- **StatusBar** - Connection status and view mode indicators
- **ProcessDetail** - Modal overlay with detailed process information

## Development

### Project Structure

```
noex-web-dashboard/
├── bin/
│   └── noex-web-dashboard.ts     # CLI entry point
├── src/
│   ├── server/
│   │   ├── index.ts              # BridgeServer orchestrator
│   │   ├── tcp-bridge.ts         # TCP connection to DashboardServer
│   │   ├── websocket-handler.ts  # WebSocket server for browsers
│   │   ├── static-server.ts      # Express static file server
│   │   └── types.ts              # Server-side type definitions
│   └── client/
│       ├── App.svelte            # Root Svelte component
│       ├── main.ts               # SPA entry point
│       ├── app.css               # Global styles
│       └── lib/
│           ├── stores/           # Reactive state management
│           │   ├── connection.ts # WebSocket connection store
│           │   ├── snapshot.ts   # Observer snapshot store
│           │   ├── events.ts     # Event log store
│           │   └── cluster.ts    # Cluster data store
│           ├── components/       # Svelte UI components
│           └── utils/            # Formatters and theme utilities
├── dist/                         # Build output
├── package.json
├── tsconfig.json
├── tsconfig.node.json
└── vite.config.ts
```

### Development Commands

```bash
# Install dependencies
npm install

# Run in development mode (hot reload)
npm run dev

# Build for production
npm run build

# Type check Svelte components
npm run check

# Start production server
npm start
```

### Development Mode

Development mode runs both the Vite dev server (for hot module replacement) and the bridge server concurrently:

```bash
npm run dev
```

This starts:
- Vite dev server on port 5173 (with HMR for Svelte)
- Bridge server connecting to DashboardServer on port 9876

## Configuration

### Programmatic Usage

The bridge server can also be used programmatically:

```typescript
import { BridgeServer, createBridgeServer } from 'noex-web-dashboard/server';

// Using the class directly
const server = new BridgeServer({
  tcp: { host: 'localhost', port: 9876 },
  ws: { port: 3000, wsPath: '/ws' },
  staticPath: './dist/client',
});

server.onEvent((event) => {
  if (event.type === 'ready') {
    console.log(`Dashboard ready at ${event.webUrl}`);
  }
});

server.enableGracefulShutdown();
await server.start();

// Or using the factory function
const server = await createBridgeServer({
  tcp: { port: 9876 },
  ws: { port: 3000 },
});
```

### Default Configuration

```typescript
{
  tcp: {
    host: 'localhost',
    port: 9876,
    reconnectDelayMs: 1000,
    maxReconnectDelayMs: 30000,
    reconnectBackoffMultiplier: 1.5,
  },
  ws: {
    port: 3000,
    wsPath: '/ws',
  },
  staticPath: './dist/client',
}
```

## Protocol

### TCP Communication

Communication with DashboardServer uses length-prefixed JSON framing:
- 4-byte big-endian length prefix
- JSON payload

### WebSocket Communication

Browser clients communicate via plain JSON over WebSocket at the `/ws` endpoint.

**Server Messages:**
- `welcome` - Server greeting with version and uptime
- `snapshot` - Current observer snapshot
- `event` - Real-time process lifecycle events
- `cluster_snapshot` - Cluster-wide snapshot data
- `cluster_status` - Cluster availability status
- `connection_status` - TCP bridge connection status
- `error` - Error notifications

**Client Messages:**
- `get_snapshot` - Request snapshot refresh
- `get_cluster_snapshot` - Request cluster snapshot
- `get_cluster_status` - Request cluster status
- `stop_process` - Stop a specific process
- `ping` - Keep-alive ping

## Requirements

- Node.js >= 18.0.0
- noex >= 0.1.0 (peer dependency)

## License

MIT
