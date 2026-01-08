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
  const { Cluster, GenServer, BehaviorRegistry } = await import('../../../src/index.js');

  // Registered behaviors for spawning
  const registeredBehaviors = new Map<string, () => any>();

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
   */
  function handleRegisterBehavior(behaviorName: string): void {
    // Import the behaviors module dynamically
    import('./behaviors.js').then((behaviors) => {
      const behaviorFactory = (behaviors as Record<string, unknown>)[behaviorName];

      if (typeof behaviorFactory !== 'function') {
        sendResponse({
          type: 'error',
          message: `Behavior '${behaviorName}' not found`,
        });
        return;
      }

      registeredBehaviors.set(behaviorName, behaviorFactory);

      // Also register with BehaviorRegistry for remote spawning
      BehaviorRegistry.register(behaviorName, behaviorFactory);

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

    sendResponse({ type: 'process_spawned', processId: ref.id });
  }

  // Signal ready state
  sendResponse({ type: 'ready', nodeId: '' });

  // Listen for messages
  process.on('message', handleMessage);

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    sendResponse({ type: 'error', message: `Uncaught: ${error.message}` });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    sendResponse({
      type: 'error',
      message: `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    });
  });
}

// Run main
main().catch((error) => {
  console.error('Worker failed to start:', error);
  process.exit(1);
});
