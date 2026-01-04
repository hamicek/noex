# DashboardServer API Reference

The `DashboardServer` exposes dashboard data over TCP, allowing remote dashboard clients to connect and receive real-time updates. Built on GenServer for reliable operation.

## Import

```typescript
import { DashboardServer } from 'noex';
// Or from submodule
import { DashboardServer } from 'noex/dashboard';
```

## Overview

DashboardServer provides:

- **TCP Server**: Listens for dashboard client connections
- **Real-time Updates**: Broadcasts Observer snapshots to all clients
- **Event Streaming**: Forwards lifecycle events to clients
- **Remote Control**: Allows clients to stop processes remotely
- **Protocol Versioning**: Ensures client-server compatibility

## Types

### DashboardServerRef

Opaque reference to a running DashboardServer instance.

```typescript
type DashboardServerRef = GenServerRef<
  DashboardServerState,
  DashboardServerCallMsg,
  DashboardServerCastMsg,
  DashboardServerReply
>;
```

### DashboardServerConfig

Configuration options for the server.

```typescript
interface DashboardServerConfig {
  /**
   * TCP port to listen on.
   * @default 9876
   */
  readonly port: number;

  /**
   * Host address to bind to.
   * @default '127.0.0.1'
   */
  readonly host: string;

  /**
   * Polling interval in milliseconds for stats updates.
   * @default 500
   */
  readonly pollingIntervalMs: number;
}
```

### ServerStatus

Status information returned by `getStatus()`.

```typescript
interface ServerStatus {
  readonly status: 'running';
  readonly port: number;
  readonly host: string;
  readonly clientCount: number;
  readonly uptime: number;
}
```

---

## Methods

### start()

Starts the DashboardServer.

```typescript
async start(config?: Partial<DashboardServerConfig>): Promise<DashboardServerRef>
```

Creates a TCP server that listens for dashboard client connections and broadcasts Observer data updates.

**Parameters:**
- `config` - Optional configuration
  - `port` - TCP port (default: 9876)
  - `host` - Host address (default: '127.0.0.1')
  - `pollingIntervalMs` - Update interval (default: 500)

**Returns:** Promise resolving to a DashboardServerRef

**Example:**
```typescript
// Start with defaults (localhost:9876)
const server = await DashboardServer.start();

// Start on custom port
const server = await DashboardServer.start({ port: 8080 });

// Bind to all interfaces
const server = await DashboardServer.start({
  port: 9876,
  host: '0.0.0.0',
});

// Slower updates for low-bandwidth connections
const server = await DashboardServer.start({
  pollingIntervalMs: 2000,
});
```

---

### stop()

Stops the DashboardServer.

```typescript
async stop(ref: DashboardServerRef): Promise<void>
```

Closes all client connections and the TCP server.

**Parameters:**
- `ref` - Reference to the server to stop

**Example:**
```typescript
await DashboardServer.stop(server);
```

---

### getStatus()

Gets the current status of the DashboardServer.

```typescript
async getStatus(ref: DashboardServerRef): Promise<ServerStatus>
```

**Parameters:**
- `ref` - Reference to the server

**Returns:** Status information

**Example:**
```typescript
const status = await DashboardServer.getStatus(server);

console.log(`Server running on ${status.host}:${status.port}`);
console.log(`Connected clients: ${status.clientCount}`);
console.log(`Uptime: ${Math.floor(status.uptime / 1000)}s`);
```

---

### getClientCount()

Gets the number of connected clients.

```typescript
async getClientCount(ref: DashboardServerRef): Promise<number>
```

**Parameters:**
- `ref` - Reference to the server

**Returns:** Number of connected clients

**Example:**
```typescript
const count = await DashboardServer.getClientCount(server);
console.log(`${count} clients connected`);
```

---

## Protocol

The DashboardServer uses a binary protocol for communication. Messages are framed with a 4-byte length prefix followed by JSON payload.

### Server Messages

Messages sent from server to clients:

```typescript
type ServerMessage =
  | { type: 'welcome'; payload: { version: number; serverUptime: number } }
  | { type: 'snapshot'; payload: ObserverSnapshot }
  | { type: 'event'; payload: ObserverEvent }
  | { type: 'error'; payload: { code: string; message: string } };
```

### Client Messages

Messages sent from clients to server:

```typescript
type ClientMessage =
  | { type: 'get_snapshot' }
  | { type: 'stop_process'; payload: { processId: string; reason?: string } }
  | { type: 'ping' };
```

---

## Complete Example

```typescript
import { DashboardServer, GenServer, Supervisor } from 'noex';

async function main() {
  // Create some processes to monitor
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      {
        id: 'worker-1',
        start: () => GenServer.start({
          init: () => ({ count: 0 }),
          handleCall: (msg, state) => [state.count, state],
          handleCast: (msg, state) => ({ count: state.count + 1 }),
        }),
      },
      {
        id: 'worker-2',
        start: () => GenServer.start({
          init: () => ({ count: 0 }),
          handleCall: (msg, state) => [state.count, state],
          handleCast: (msg, state) => ({ count: state.count + 1 }),
        }),
      },
    ],
  });

  // Start dashboard server
  const dashboardServer = await DashboardServer.start({
    port: 9876,
    host: '0.0.0.0', // Accept connections from any interface
    pollingIntervalMs: 500,
  });

  const status = await DashboardServer.getStatus(dashboardServer);
  console.log(`Dashboard server running on ${status.host}:${status.port}`);
  console.log('Connect with a dashboard client to monitor processes');

  // Periodically log connection count
  setInterval(async () => {
    const count = await DashboardServer.getClientCount(dashboardServer);
    if (count > 0) {
      console.log(`${count} dashboard client(s) connected`);
    }
  }, 10000);

  // Handle graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    await DashboardServer.stop(dashboardServer);
    await Supervisor.stop(supervisor);
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Security Considerations

1. **Local Binding**: By default, binds to `127.0.0.1` (localhost only)
2. **Network Exposure**: Use `0.0.0.0` only on trusted networks
3. **No Authentication**: Currently no built-in authentication
4. **Process Control**: Clients can stop processes - restrict access accordingly
5. **Firewall**: Consider firewall rules for production deployments

---

## Use Cases

### Development Monitoring

```typescript
// Start server for local development
if (process.env.NODE_ENV === 'development') {
  await DashboardServer.start({ port: 9876 });
}
```

### Production Monitoring

```typescript
// Only allow localhost connections in production
await DashboardServer.start({
  port: 9876,
  host: '127.0.0.1',
  pollingIntervalMs: 1000, // Less frequent updates
});
```

### Docker/Container Monitoring

```typescript
// Bind to container's IP for inter-container access
await DashboardServer.start({
  port: 9876,
  host: '0.0.0.0',
});
```

---

## Related

- [Dashboard API](./dashboard.md) - TUI client
- [Observer API](./observer.md) - Data source
- [GenServer API](./genserver.md) - Server implementation
