/**
 * Cluster worker for distributed stress testing.
 *
 * This script runs in a child process and manages a single Cluster node.
 * Communication with the parent process is done via IPC messages.
 *
 * @module tests/stress/distribution/cluster-worker
 */

import type {
  NodeIPCMessage,
  NodeIPCResponse,
  NodeStartConfig,
  CrashMode,
} from './cluster-factory.js';

// Dynamic import to handle ESM
async function main(): Promise<void> {
  const { Cluster, GenServer, BehaviorRegistry, RemoteCall } = await import('../../../src/index.js');

  // Registered behaviors for spawning
  const registeredBehaviors = new Map<string, () => any>();

  // Spawned process references for remote calls
  const spawnedProcesses = new Map<string, any>();

  /**
   * Sends a response to the parent process.
   */
  function sendResponse(response: NodeIPCResponse): void {
    if (process.send) {
      process.send(response);
    }
  }

  /**
   * Handles incoming IPC messages from parent.
   */
  async function handleMessage(msg: NodeIPCMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'start':
          await handleStart(msg.config);
          break;

        case 'stop':
          await handleStop();
          break;

        case 'get_status':
          handleGetStatus();
          break;

        case 'get_connected_nodes':
          handleGetConnectedNodes();
          break;

        case 'crash':
          handleCrash(msg.mode);
          break;

        case 'register_behavior':
          handleRegisterBehavior(msg.behaviorName);
          break;

        case 'spawn_process':
          await handleSpawnProcess(msg.behaviorName, msg.globalName);
          break;

        case 'remote_call':
          await handleRemoteCall(msg.callId, msg.targetNodeId, msg.processId, msg.msg, msg.timeoutMs);
          break;

        case 'remote_cast':
          handleRemoteCast(msg.targetNodeId, msg.processId, msg.msg);
          break;

        case 'get_process_info':
          handleGetProcessInfo(msg.processId);
          break;
      }
    } catch (error) {
      sendResponse({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Starts the cluster node.
   */
  async function handleStart(config: NodeStartConfig): Promise<void> {
    // Register event handlers before starting
    Cluster.onNodeUp((node) => {
      sendResponse({ type: 'node_up', nodeId: node.id });
    });

    Cluster.onNodeDown((nodeId, reason) => {
      sendResponse({ type: 'node_down', nodeId, reason });
    });

    await Cluster.start({
      nodeName: config.nodeName,
      port: config.port,
      seeds: [...config.seeds],
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      heartbeatMissThreshold: config.heartbeatMissThreshold,
      clusterSecret: config.clusterSecret,
    });

    sendResponse({ type: 'started' });
  }

  /**
   * Stops the cluster node.
   */
  async function handleStop(): Promise<void> {
    if (Cluster.getStatus() !== 'stopped') {
      await Cluster.stop();
    }
    sendResponse({ type: 'stopped' });
    process.exit(0);
  }

  /**
   * Returns status information.
   */
  function handleGetStatus(): void {
    const status = Cluster.getStatus();

    if (status !== 'running') {
      sendResponse({
        type: 'status',
        info: {
          nodeId: '',
          name: '',
          port: 0,
          status: 'stopped',
          connectedNodes: [],
          startedAt: null,
          pid: process.pid,
        },
      });
      return;
    }

    const localId = Cluster.getLocalNodeId();
    const connectedNodes = Cluster.getConnectedNodes().map((n) => n.id);

    sendResponse({
      type: 'status',
      info: {
        nodeId: localId,
        name: localId.split('@')[0] ?? '',
        port: Cluster.getLocalNodeInfo().port,
        status: 'running',
        connectedNodes,
        startedAt: Date.now() - Cluster.getUptimeMs(),
        pid: process.pid,
      },
    });
  }

  /**
   * Returns connected node IDs.
   */
  function handleGetConnectedNodes(): void {
    const nodes = Cluster.getStatus() === 'running'
      ? Cluster.getConnectedNodes().map((n) => n.id)
      : [];

    sendResponse({
      type: 'connected_nodes',
      nodes,
    });
  }

  /**
   * Simulates a crash.
   */
  function handleCrash(mode: CrashMode): void {
    sendResponse({ type: 'crashed', mode });

    switch (mode) {
      case 'graceful_shutdown':
        Cluster.stop().finally(() => {
          process.exit(0);
        });
        break;

      case 'abrupt_kill':
        // Immediate exit without cleanup
        process.exit(1);
        break;

      case 'process_exit':
        // Exit with error code
        process.exit(1);
        break;
    }
  }

  /**
   * Registers a behavior for remote spawning.
   *
   * Supports both:
   * - Factory functions (e.g., createSlowBehavior) that return a behavior
   * - Direct behavior objects (e.g., counterBehavior, echoBehavior)
   */
  function handleRegisterBehavior(behaviorName: string): void {
    // Import the behaviors module dynamically
    import('./behaviors.js').then((behaviors) => {
      const behaviorOrFactory = (behaviors as Record<string, unknown>)[behaviorName];

      if (behaviorOrFactory === undefined) {
        sendResponse({
          type: 'error',
          message: `Behavior '${behaviorName}' not found in behaviors module`,
        });
        return;
      }

      let behavior: any;
      let behaviorFactory: () => any;

      // Determine if it's a factory function or a behavior object
      if (typeof behaviorOrFactory === 'function') {
        // It's a factory function - call it to get the behavior
        behavior = (behaviorOrFactory as () => any)();
        behaviorFactory = behaviorOrFactory as () => any;
      } else if (
        typeof behaviorOrFactory === 'object' &&
        behaviorOrFactory !== null &&
        'init' in behaviorOrFactory
      ) {
        // It's a behavior object - use it directly
        behavior = behaviorOrFactory;
        behaviorFactory = () => behaviorOrFactory;
      } else {
        sendResponse({
          type: 'error',
          message: `'${behaviorName}' is neither a factory function nor a valid behavior object`,
        });
        return;
      }

      // Store the factory for spawning
      registeredBehaviors.set(behaviorName, behaviorFactory);

      // Register with BehaviorRegistry (expects behavior object, not factory)
      // Only register if not already registered to avoid errors
      if (!BehaviorRegistry.has(behaviorName)) {
        BehaviorRegistry.register(behaviorName, behavior);
      }

      sendResponse({ type: 'behavior_registered', behaviorName });
    }).catch((error) => {
      sendResponse({
        type: 'error',
        message: `Failed to load behavior: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
  }

  /**
   * Spawns a process with a registered behavior.
   */
  async function handleSpawnProcess(
    behaviorName: string,
    globalName?: string
  ): Promise<void> {
    const behaviorFactory = registeredBehaviors.get(behaviorName);

    if (!behaviorFactory) {
      sendResponse({
        type: 'error',
        message: `Behavior '${behaviorName}' not registered`,
      });
      return;
    }

    const behavior = behaviorFactory();
    const ref = await GenServer.start(behavior, globalName ? { name: globalName } : undefined);

    // Store reference for remote calls
    spawnedProcesses.set(ref.id, ref);

    sendResponse({ type: 'process_spawned', processId: ref.id });
  }

  /**
   * Makes a remote call to a process on another node.
   */
  async function handleRemoteCall(
    callId: string,
    targetNodeId: string,
    processId: string,
    msg: unknown,
    timeoutMs?: number,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      // Create a serialized ref for the remote process
      const serializedRef = {
        id: processId,
        nodeId: targetNodeId,
      };

      const result = await RemoteCall.call(
        serializedRef,
        msg,
        { timeout: timeoutMs ?? 5000 },
      );

      const durationMs = Date.now() - startTime;
      sendResponse({ type: 'remote_call_result', callId, result, durationMs });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorType = error instanceof Error ? error.name : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({ type: 'remote_call_error', callId, errorType, message, durationMs });
    }
  }

  /**
   * Sends a remote cast to a process on another node.
   */
  function handleRemoteCast(
    targetNodeId: string,
    processId: string,
    msg: unknown,
  ): void {
    // Create a serialized ref for the remote process
    const serializedRef = {
      id: processId,
      nodeId: targetNodeId,
    };

    RemoteCall.cast(serializedRef, msg);
    sendResponse({ type: 'remote_cast_sent' });
  }

  /**
   * Returns information about a local spawned process.
   */
  function handleGetProcessInfo(processId: string): void {
    const ref = spawnedProcesses.get(processId);

    if (!ref) {
      sendResponse({ type: 'process_info', info: null });
      return;
    }

    const status = GenServer.getStatus(ref);

    sendResponse({
      type: 'process_info',
      info: {
        id: ref.id,
        status,
      },
    });
  }

  // Signal ready state
  sendResponse({ type: 'ready', nodeId: '' });

  // Listen for messages
  process.on('message', handleMessage);

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    // Don't exit for expected network errors during node crashes
    const isExpectedError = error.message.includes('ECONNRESET') ||
                            error.message.includes('EPIPE') ||
                            error.message.includes('socket hang up') ||
                            error.message.includes('connection refused');
    sendResponse({ type: 'error', message: `Uncaught: ${error.message}` });
    if (!isExpectedError) {
      process.exit(1);
    }
  });

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    // Don't report expected network errors
    const isExpectedError = message.includes('ECONNRESET') ||
                            message.includes('EPIPE') ||
                            message.includes('socket hang up') ||
                            message.includes('connection refused');
    if (!isExpectedError) {
      sendResponse({
        type: 'error',
        message: `Unhandled rejection: ${message}`,
      });
    }
  });
}

// Run main
main().catch((error) => {
  console.error('Worker failed to start:', error);
  process.exit(1);
});
