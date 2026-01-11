/**
 * Bridge Server - Main server orchestrator for noex-web-dashboard.
 *
 * Composes and coordinates all server components:
 * - StaticServer: Serves the built Svelte SPA
 * - TcpBridge: Maintains connection to DashboardServer
 * - WebSocketHandler: Manages browser client connections
 *
 * Provides unified lifecycle management, graceful shutdown,
 * and centralized event handling for all components.
 *
 * @module server/index
 */

import process from 'node:process';
import { StaticServer } from './static-server.js';
import { TcpBridge, type TcpBridgeEvent } from './tcp-bridge.js';
import { WebSocketHandler, type WebSocketHandlerEvent } from './websocket-handler.js';
import { type BridgeServerConfig, DEFAULT_CONFIG } from './types.js';

// =============================================================================
// Re-exports
// =============================================================================

export { StaticServer } from './static-server.js';
export { TcpBridge } from './tcp-bridge.js';
export { WebSocketHandler } from './websocket-handler.js';
export type { StaticServerConfig, StaticServerEvent, StaticServerEventHandler } from './static-server.js';
export type { TcpBridgeEvent, TcpBridgeEventHandler } from './tcp-bridge.js';
export type { WebSocketHandlerEvent, WebSocketHandlerEventHandler } from './websocket-handler.js';
export type {
  BridgeServerConfig,
  TcpBridgeConfig,
  WebSocketServerConfig,
  TcpConnectionState,
  WebSocketServerMessage,
  WebSocketClientMessage,
} from './types.js';
export { DEFAULT_CONFIG } from './types.js';

// =============================================================================
// BridgeServer Types
// =============================================================================

/**
 * Events emitted by the BridgeServer.
 */
export type BridgeServerEvent =
  | { readonly type: 'starting' }
  | { readonly type: 'ready'; readonly webUrl: string; readonly dashboardHost: string; readonly dashboardPort: number }
  | { readonly type: 'stopping' }
  | { readonly type: 'stopped' }
  | { readonly type: 'tcp'; readonly event: TcpBridgeEvent }
  | { readonly type: 'ws'; readonly event: WebSocketHandlerEvent }
  | { readonly type: 'error'; readonly error: Error; readonly source: 'tcp' | 'ws' | 'http' | 'server' };

/**
 * Event handler for BridgeServer events.
 */
export type BridgeServerEventHandler = (event: BridgeServerEvent) => void;

/**
 * Server state enumeration.
 */
export type BridgeServerState = 'stopped' | 'starting' | 'running' | 'stopping';

// =============================================================================
// BridgeServer Class
// =============================================================================

/**
 * Bridge Server that orchestrates all dashboard components.
 *
 * This is the main entry point for the noex-web-dashboard server.
 * It manages the lifecycle of all components and provides unified
 * event handling and graceful shutdown support.
 *
 * @example
 * ```typescript
 * const server = new BridgeServer({
 *   tcp: { host: 'localhost', port: 9876 },
 *   ws: { port: 3000, wsPath: '/ws' },
 *   staticPath: './dist/client',
 * });
 *
 * server.onEvent((event) => {
 *   if (event.type === 'ready') {
 *     console.log(`Dashboard ready at ${event.webUrl}`);
 *   }
 * });
 *
 * await server.start();
 *
 * // Graceful shutdown on process signals
 * server.enableGracefulShutdown();
 * ```
 */
export class BridgeServer {
  private readonly config: BridgeServerConfig;
  private readonly handlers = new Set<BridgeServerEventHandler>();

  private staticServer: StaticServer | null = null;
  private tcpBridge: TcpBridge | null = null;
  private wsHandler: WebSocketHandler | null = null;

  private state: BridgeServerState = 'stopped';
  private shutdownHandlersRegistered = false;

  constructor(config: Partial<BridgeServerConfig> = {}) {
    this.config = this.mergeConfig(config);
  }

  // ===========================================================================
  // Public API - State
  // ===========================================================================

  /**
   * Returns the current server state.
   */
  getState(): BridgeServerState {
    return this.state;
  }

  /**
   * Returns whether the server is currently running.
   */
  isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * Returns the TCP connection state to DashboardServer.
   */
  getTcpConnectionState(): string {
    return this.tcpBridge?.getState() ?? 'disconnected';
  }

  /**
   * Returns the number of connected browser clients.
   */
  getClientCount(): number {
    return this.wsHandler?.getClientCount() ?? 0;
  }

  // ===========================================================================
  // Public API - Events
  // ===========================================================================

  /**
   * Registers an event handler for server events.
   *
   * @param handler - Callback invoked on each event
   * @returns Unsubscribe function
   */
  onEvent(handler: BridgeServerEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  // ===========================================================================
  // Public API - Lifecycle
  // ===========================================================================

  /**
   * Starts all server components.
   *
   * Initialization order:
   * 1. Static server (creates HTTP server)
   * 2. WebSocket handler (attaches to HTTP server)
   * 3. TCP bridge (connects to DashboardServer)
   * 4. HTTP server starts listening
   *
   * @throws Error if server is already running or starting
   */
  async start(): Promise<void> {
    if (this.state !== 'stopped') {
      throw new Error(`Cannot start server: current state is '${this.state}'`);
    }

    this.state = 'starting';
    this.emit({ type: 'starting' });

    try {
      // Create static server and get HTTP server instance
      this.staticServer = new StaticServer({
        port: this.config.ws.port,
        staticPath: this.config.staticPath,
      });

      this.staticServer.onEvent((event) => {
        if (event.type === 'error') {
          this.emit({ type: 'error', error: event.error, source: 'http' });
        }
      });

      const httpServer = this.staticServer.createHttpServer();

      // Create TCP bridge
      this.tcpBridge = new TcpBridge(this.config.tcp);

      this.tcpBridge.onEvent((event) => {
        this.emit({ type: 'tcp', event });
        if (event.type === 'error') {
          this.emit({ type: 'error', error: event.error, source: 'tcp' });
        }
      });

      // Create WebSocket handler (attaches to HTTP server)
      this.wsHandler = new WebSocketHandler(httpServer, this.tcpBridge, {
        wsPath: this.config.ws.wsPath,
      });

      this.wsHandler.onEvent((event) => {
        this.emit({ type: 'ws', event });
        if (event.type === 'error') {
          this.emit({ type: 'error', error: event.error, source: 'ws' });
        }
      });

      // Start HTTP server
      await this.staticServer.start();

      // Connect to DashboardServer (non-blocking, will reconnect on failure)
      this.tcpBridge.connect().catch(() => {
        // Connection errors are handled via events
      });

      this.state = 'running';
      this.emit({
        type: 'ready',
        webUrl: `http://localhost:${this.config.ws.port}`,
        dashboardHost: this.config.tcp.host,
        dashboardPort: this.config.tcp.port,
      });
    } catch (error) {
      // Cleanup on startup failure
      await this.cleanup();
      this.state = 'stopped';
      throw error;
    }
  }

  /**
   * Stops all server components gracefully.
   *
   * Shutdown order:
   * 1. Disconnect TCP bridge (stops reconnection)
   * 2. Close WebSocket connections
   * 3. Stop HTTP server
   */
  async stop(): Promise<void> {
    if (this.state !== 'running') {
      return;
    }

    this.state = 'stopping';
    this.emit({ type: 'stopping' });

    await this.cleanup();

    this.state = 'stopped';
    this.emit({ type: 'stopped' });
  }

  /**
   * Registers process signal handlers for graceful shutdown.
   *
   * Handles SIGINT (Ctrl+C) and SIGTERM signals to ensure
   * clean shutdown of all server components.
   *
   * @returns Cleanup function to remove signal handlers
   */
  enableGracefulShutdown(): () => void {
    if (this.shutdownHandlersRegistered) {
      return () => {};
    }

    const handleShutdown = async (signal: string) => {
      // Avoid duplicate shutdown attempts
      if (this.state === 'stopping' || this.state === 'stopped') {
        return;
      }

      process.stdout.write(`\nReceived ${signal}, shutting down...\n`);

      try {
        await this.stop();
        process.exit(0);
      } catch {
        process.exit(1);
      }
    };

    const sigintHandler = () => void handleShutdown('SIGINT');
    const sigtermHandler = () => void handleShutdown('SIGTERM');

    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);

    this.shutdownHandlersRegistered = true;

    return () => {
      process.off('SIGINT', sigintHandler);
      process.off('SIGTERM', sigtermHandler);
      this.shutdownHandlersRegistered = false;
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private mergeConfig(config: Partial<BridgeServerConfig>): BridgeServerConfig {
    return {
      tcp: { ...DEFAULT_CONFIG.tcp, ...config.tcp },
      ws: { ...DEFAULT_CONFIG.ws, ...config.ws },
      staticPath: config.staticPath ?? DEFAULT_CONFIG.staticPath,
    };
  }

  private async cleanup(): Promise<void> {
    // Disconnect TCP bridge first (stops reconnection attempts)
    if (this.tcpBridge) {
      this.tcpBridge.disconnect();
      this.tcpBridge = null;
    }

    // Close WebSocket connections
    if (this.wsHandler) {
      this.wsHandler.close();
      this.wsHandler = null;
    }

    // Stop HTTP server
    if (this.staticServer) {
      try {
        await this.staticServer.stop();
      } catch {
        // Ignore stop errors during cleanup
      }
      this.staticServer = null;
    }
  }

  private emit(event: BridgeServerEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors to prevent cascade failures
      }
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Creates and starts a BridgeServer with the given configuration.
 *
 * Convenience function that creates, configures, and starts a server
 * with graceful shutdown enabled.
 *
 * @example
 * ```typescript
 * const server = await createBridgeServer({
 *   tcp: { port: 9876 },
 *   ws: { port: 3000 },
 * });
 *
 * // Server is now running with graceful shutdown enabled
 * ```
 *
 * @param config - Server configuration
 * @param options - Additional options
 * @returns Started BridgeServer instance
 */
export async function createBridgeServer(
  config: Partial<BridgeServerConfig> = {},
  options: { enableGracefulShutdown?: boolean } = {},
): Promise<BridgeServer> {
  const server = new BridgeServer(config);

  if (options.enableGracefulShutdown !== false) {
    server.enableGracefulShutdown();
  }

  await server.start();
  return server;
}
