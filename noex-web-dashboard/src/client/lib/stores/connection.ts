/**
 * WebSocket connection state management for the Svelte dashboard.
 *
 * Provides reactive connection state using Svelte stores, handling:
 * - Connection lifecycle (connect, disconnect, reconnect)
 * - Exponential backoff for automatic reconnection
 * - Message dispatching to registered handlers
 * - Connection status tracking
 *
 * @module stores/connection
 */

import { writable, derived, get } from 'svelte/store';
import type {
  ObserverSnapshot,
  ClusterObserverSnapshot,
  ObserverEvent,
} from 'noex';

// =============================================================================
// Types
// =============================================================================

/**
 * WebSocket connection states.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/**
 * Server-to-client WebSocket message types.
 * Mirrors WebSocketServerMessage from server/types.ts.
 */
export type ServerMessage =
  | { readonly type: 'welcome'; readonly payload: { readonly version: string; readonly serverUptime: number } }
  | { readonly type: 'snapshot'; readonly payload: ObserverSnapshot }
  | { readonly type: 'event'; readonly payload: ObserverEvent }
  | { readonly type: 'error'; readonly payload: { readonly code: string; readonly message: string } }
  | { readonly type: 'cluster_snapshot'; readonly payload: ClusterObserverSnapshot }
  | { readonly type: 'cluster_status'; readonly payload: { readonly available: boolean; readonly nodeId?: string } }
  | { readonly type: 'connection_status'; readonly payload: { readonly connected: boolean; readonly error?: string } };

/**
 * Client-to-server WebSocket message types.
 */
export type ClientMessage =
  | { readonly type: 'get_snapshot' }
  | { readonly type: 'stop_process'; readonly payload: { readonly processId: string; readonly reason?: string } }
  | { readonly type: 'ping' }
  | { readonly type: 'get_cluster_snapshot' }
  | { readonly type: 'get_cluster_status' };

/**
 * Handler for specific message types.
 */
export type MessageHandler<T extends ServerMessage['type']> = (
  payload: Extract<ServerMessage, { type: T }>['payload'],
) => void;

/**
 * Internal handler type for the registry.
 */
type AnyMessageHandler = (payload: unknown) => void;

/**
 * Configuration for the WebSocket connection.
 */
export interface ConnectionConfig {
  /** WebSocket URL. @default 'ws://localhost:7210/ws' */
  readonly url: string;
  /** Initial reconnect delay in milliseconds. @default 1000 */
  readonly reconnectDelayMs: number;
  /** Maximum reconnect delay in milliseconds. @default 30000 */
  readonly maxReconnectDelayMs: number;
  /** Reconnect backoff multiplier. @default 1.5 */
  readonly reconnectBackoffMultiplier: number;
  /** Maximum number of reconnect attempts. 0 = infinite. @default 0 */
  readonly maxReconnectAttempts: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CONFIG: ConnectionConfig = {
  url: `ws://${typeof window !== 'undefined' ? window.location.host : 'localhost:7210'}/ws`,
  reconnectDelayMs: 1000,
  maxReconnectDelayMs: 30000,
  reconnectBackoffMultiplier: 1.5,
  maxReconnectAttempts: 0,
};

// =============================================================================
// Connection Store Implementation
// =============================================================================

/**
 * Creates a WebSocket connection store with reactive state.
 */
function createConnectionStore(config: Partial<ConnectionConfig> = {}) {
  const resolvedConfig: ConnectionConfig = { ...DEFAULT_CONFIG, ...config };

  // ---------------------------------------------------------------------------
  // Writable Stores
  // ---------------------------------------------------------------------------

  const state = writable<ConnectionState>('disconnected');
  const bridgeConnected = writable(false);
  const lastError = writable<string | null>(null);
  const reconnectAttempt = writable(0);
  const serverVersion = writable<string | null>(null);
  const serverUptime = writable<number | null>(null);

  // Derived stores
  const isConnected = derived(state, ($state) => $state === 'connected');
  const isReconnecting = derived(state, ($state) => $state === 'reconnecting');
  const hasError = derived(lastError, ($lastError) => $lastError !== null);

  // ---------------------------------------------------------------------------
  // Private State
  // ---------------------------------------------------------------------------

  let socket: WebSocket | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let currentReconnectDelay = resolvedConfig.reconnectDelayMs;

  // Message handlers registry
  const handlers = new Map<ServerMessage['type'], Set<AnyMessageHandler>>();

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  function resetReconnectState(): void {
    reconnectAttempt.set(0);
    currentReconnectDelay = resolvedConfig.reconnectDelayMs;
    clearReconnectTimeout();
  }

  function clearReconnectTimeout(): void {
    if (reconnectTimeout !== null) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
  }

  function scheduleReconnect(): void {
    const currentAttempt = get(reconnectAttempt);
    if (resolvedConfig.maxReconnectAttempts > 0 && currentAttempt >= resolvedConfig.maxReconnectAttempts) {
      state.set('disconnected');
      lastError.set(`Max reconnect attempts (${resolvedConfig.maxReconnectAttempts}) exceeded`);
      return;
    }

    state.set('reconnecting');
    reconnectAttempt.update((n) => n + 1);

    reconnectTimeout = setTimeout(() => {
      connect();
    }, currentReconnectDelay);

    // Apply exponential backoff
    currentReconnectDelay = Math.min(
      currentReconnectDelay * resolvedConfig.reconnectBackoffMultiplier,
      resolvedConfig.maxReconnectDelayMs,
    );
  }

  function handleMessage(event: MessageEvent): void {
    try {
      const message = JSON.parse(event.data as string) as ServerMessage;
      dispatchMessage(message);
    } catch {
      lastError.set('Failed to parse server message');
    }
  }

  function dispatchMessage(message: ServerMessage): void {
    // Handle internal state updates
    switch (message.type) {
      case 'welcome':
        serverVersion.set(message.payload.version);
        serverUptime.set(message.payload.serverUptime);
        break;

      case 'connection_status':
        bridgeConnected.set(message.payload.connected);
        if (message.payload.error) {
          lastError.set(message.payload.error);
        }
        break;

      case 'error':
        lastError.set(`${message.payload.code}: ${message.payload.message}`);
        break;
    }

    // Dispatch to registered handlers
    const messageHandlers = handlers.get(message.type);
    if (messageHandlers) {
      for (const handler of messageHandlers) {
        try {
          handler(message.payload);
        } catch {
          // Ignore handler errors to prevent cascade failures
        }
      }
    }
  }

  function handleOpen(): void {
    state.set('connected');
    lastError.set(null);
    resetReconnectState();
    // Request initial data
    send({ type: 'get_snapshot' });
    send({ type: 'get_cluster_status' });
  }

  function handleClose(): void {
    socket = null;
    const currentState = get(state);

    if (currentState === 'connected' || currentState === 'connecting') {
      scheduleReconnect();
    } else {
      state.set('disconnected');
    }
  }

  function handleError(): void {
    lastError.set('WebSocket connection error');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Establishes WebSocket connection to the server.
   */
  function connect(): void {
    if (socket !== null) {
      return;
    }

    clearReconnectTimeout();
    state.set('connecting');
    lastError.set(null);

    try {
      socket = new WebSocket(resolvedConfig.url);

      socket.addEventListener('open', handleOpen);
      socket.addEventListener('message', handleMessage);
      socket.addEventListener('close', handleClose);
      socket.addEventListener('error', handleError);
    } catch {
      state.set('disconnected');
      lastError.set('Failed to create WebSocket connection');
      scheduleReconnect();
    }
  }

  /**
   * Closes the WebSocket connection.
   * Prevents automatic reconnection.
   */
  function disconnect(): void {
    clearReconnectTimeout();

    if (socket !== null) {
      // Remove listeners before closing to prevent reconnect
      socket.removeEventListener('close', handleClose);
      socket.close(1000, 'Client disconnect');
      socket = null;
    }

    state.set('disconnected');
    bridgeConnected.set(false);
  }

  /**
   * Sends a message to the server.
   */
  function send(message: ClientMessage): boolean {
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Requests a snapshot refresh from the server.
   */
  function requestSnapshot(): boolean {
    return send({ type: 'get_snapshot' });
  }

  /**
   * Requests a cluster snapshot from the server.
   */
  function requestClusterSnapshot(): boolean {
    return send({ type: 'get_cluster_snapshot' });
  }

  /**
   * Requests cluster status from the server.
   */
  function requestClusterStatus(): boolean {
    return send({ type: 'get_cluster_status' });
  }

  /**
   * Sends a stop process command to the server.
   */
  function stopProcess(processId: string, reason?: string): boolean {
    return send({
      type: 'stop_process',
      payload: { processId, reason },
    });
  }

  /**
   * Registers a handler for a specific message type.
   */
  function onMessage<T extends ServerMessage['type']>(
    type: T,
    handler: MessageHandler<T>,
  ): () => void {
    let typeHandlers = handlers.get(type);
    if (!typeHandlers) {
      typeHandlers = new Set();
      handlers.set(type, typeHandlers);
    }

    const anyHandler = handler as AnyMessageHandler;
    typeHandlers.add(anyHandler);

    return () => {
      typeHandlers!.delete(anyHandler);
      if (typeHandlers!.size === 0) {
        handlers.delete(type);
      }
    };
  }

  /**
   * Clears the last error.
   */
  function clearError(): void {
    lastError.set(null);
  }

  // ---------------------------------------------------------------------------
  // Store Object
  // ---------------------------------------------------------------------------

  return {
    // Stores for subscription
    state,
    isConnected,
    isReconnecting,
    bridgeConnected,
    lastError,
    hasError,
    reconnectAttempt,
    serverVersion,
    serverUptime,

    // Methods
    connect,
    disconnect,
    send,
    requestSnapshot,
    requestClusterSnapshot,
    requestClusterStatus,
    stopProcess,
    onMessage,
    clearError,
  };
}

// =============================================================================
// Singleton Export
// =============================================================================

/**
 * Global connection store instance.
 */
export const connection = createConnectionStore();

// Export factory for testing
export { createConnectionStore };
