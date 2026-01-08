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
  DistributedSupervisorIPCOptions,
  DistributedChildSpecIPC,
} from './cluster-factory.js';

// Dynamic import to handle ESM
async function main(): Promise<void> {
  const { Cluster, GenServer, BehaviorRegistry, RemoteCall, RemoteSpawn, RemoteMonitor, GlobalRegistry, DistributedSupervisor } = await import('../../../src/index.js');

  // Registered behaviors for spawning
  const registeredBehaviors = new Map<string, () => any>();

  // Spawned process references for remote calls
  const spawnedProcesses = new Map<string, any>();

  // Active monitor references (monitorRefId -> MonitorRef)
  const activeMonitors = new Map<string, any>();

  // Active DistributedSupervisor references (supervisorId -> SupervisorRef)
  const activeSupervisors = new Map<string, any>();

  // Unsubscribe function for DistributedSupervisor lifecycle events
  let dsupLifecycleUnsubscribe: (() => void) | null = null;

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

        case 'remote_spawn':
          await handleRemoteSpawn(msg.spawnId, msg.behaviorName, msg.targetNodeId, msg.options, msg.timeoutMs);
          break;

        case 'remote_monitor':
          await handleRemoteMonitor(msg.monitorId, msg.monitoringProcessId, msg.targetNodeId, msg.targetProcessId, msg.timeoutMs);
          break;

        case 'remote_demonitor':
          await handleRemoteDemonitor(msg.monitorId, msg.monitorRefId);
          break;

        case 'get_monitor_stats':
          handleGetMonitorStats();
          break;

        case 'global_register':
          await handleGlobalRegister(msg.registrationId, msg.name, msg.processId);
          break;

        case 'global_unregister':
          await handleGlobalUnregister(msg.registrationId, msg.name);
          break;

        case 'global_lookup':
          handleGlobalLookup(msg.lookupId, msg.name);
          break;

        case 'global_whereis':
          handleGlobalWhereis(msg.lookupId, msg.name);
          break;

        case 'get_global_registry_stats':
          handleGetGlobalRegistryStats();
          break;

        case 'get_global_registry_names':
          handleGetGlobalRegistryNames();
          break;

        // DistributedSupervisor messages
        case 'dsup_start':
          await handleDsupStart(msg.requestId, msg.options);
          break;

        case 'dsup_stop':
          await handleDsupStop(msg.requestId, msg.supervisorId, msg.reason);
          break;

        case 'dsup_start_child':
          await handleDsupStartChild(msg.requestId, msg.supervisorId, msg.spec);
          break;

        case 'dsup_terminate_child':
          await handleDsupTerminateChild(msg.requestId, msg.supervisorId, msg.childId);
          break;

        case 'dsup_restart_child':
          await handleDsupRestartChild(msg.requestId, msg.supervisorId, msg.childId);
          break;

        case 'dsup_get_children':
          handleDsupGetChildren(msg.requestId, msg.supervisorId);
          break;

        case 'dsup_get_stats':
          handleDsupGetStats(msg.requestId, msg.supervisorId);
          break;

        case 'dsup_count_children':
          handleDsupCountChildren(msg.requestId, msg.supervisorId);
          break;

        case 'dsup_is_running':
          handleDsupIsRunning(msg.requestId, msg.supervisorId);
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

    // Listen for process_down lifecycle events and forward to parent
    GenServer.onLifecycleEvent((event) => {
      if (event.type === 'process_down') {
        // Find the monitorId from activeMonitors
        let monitorRefId = '';
        for (const [id, ref] of activeMonitors.entries()) {
          if (ref.monitoredRef?.id === event.monitoredRef.id) {
            monitorRefId = id;
            activeMonitors.delete(id);
            break;
          }
        }

        sendResponse({
          type: 'process_down',
          monitorRefId: monitorRefId || event.monitorId || '',
          monitoredProcessId: event.monitoredRef.id,
          reason: {
            type: event.reason.type,
            message: 'message' in event.reason ? (event.reason as { message: string }).message : undefined,
          },
        });
      }
    });

    // Listen for GlobalRegistry events and forward to parent
    GlobalRegistry.on('registered', (name, ref) => {
      sendResponse({
        type: 'global_registry_registered',
        name,
        ref: { id: ref.id, nodeId: ref.nodeId },
      });
    });

    GlobalRegistry.on('unregistered', (name, ref) => {
      sendResponse({
        type: 'global_registry_unregistered',
        name,
        ref: { id: ref.id, nodeId: ref.nodeId },
      });
    });

    GlobalRegistry.on('conflictResolved', (name, winner, loser) => {
      sendResponse({
        type: 'global_registry_conflict_resolved',
        name,
        winner: { id: winner.id, nodeId: winner.nodeId },
        loser: { id: loser.id, nodeId: loser.nodeId },
      });
    });

    GlobalRegistry.on('synced', (fromNodeId, entriesCount) => {
      sendResponse({
        type: 'global_registry_synced',
        fromNodeId,
        entriesCount,
      });
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
   * Spawns a process on a remote node using RemoteSpawn.
   */
  async function handleRemoteSpawn(
    spawnId: string,
    behaviorName: string,
    targetNodeId: string,
    options?: { name?: string; registration?: 'local' | 'global' | 'none'; initTimeout?: number },
    timeoutMs?: number,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      const result = await RemoteSpawn.spawn(
        behaviorName,
        targetNodeId,
        { ...options, timeout: timeoutMs ?? 10000 },
      );

      const durationMs = Date.now() - startTime;
      sendResponse({
        type: 'remote_spawn_result',
        spawnId,
        serverId: result.serverId,
        nodeId: result.nodeId,
        durationMs,
      });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorType = error instanceof Error ? error.name : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({ type: 'remote_spawn_error', spawnId, errorType, message, durationMs });
    }
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

  /**
   * Sets up a remote monitor on a process running on another node.
   */
  async function handleRemoteMonitor(
    monitorId: string,
    monitoringProcessId: string,
    targetNodeId: string,
    targetProcessId: string,
    timeoutMs?: number,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      // Get the local process ref that will receive notifications
      const monitoringRef = spawnedProcesses.get(monitoringProcessId);
      if (!monitoringRef) {
        const durationMs = Date.now() - startTime;
        sendResponse({
          type: 'remote_monitor_error',
          monitorId,
          errorType: 'ProcessNotFound',
          message: `Monitoring process '${monitoringProcessId}' not found`,
          durationMs,
        });
        return;
      }

      // Create a ref for the remote process
      const monitoredRef = {
        id: targetProcessId,
        nodeId: targetNodeId,
      };

      // Set up the monitor
      const monitorRef = await RemoteMonitor.monitor(
        monitoringRef,
        monitoredRef,
        { timeout: timeoutMs ?? 10000 },
      );

      // Store the monitor ref for potential demonitor
      activeMonitors.set(monitorRef.monitorId, monitorRef);

      const durationMs = Date.now() - startTime;
      sendResponse({
        type: 'remote_monitor_result',
        monitorId,
        monitorRefId: monitorRef.monitorId,
        durationMs,
      });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorType = error instanceof Error ? error.name : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({
        type: 'remote_monitor_error',
        monitorId,
        errorType,
        message,
        durationMs,
      });
    }
  }

  /**
   * Removes a remote monitor.
   */
  async function handleRemoteDemonitor(
    monitorId: string,
    monitorRefId: string,
  ): Promise<void> {
    try {
      const monitorRef = activeMonitors.get(monitorRefId);
      if (monitorRef) {
        await RemoteMonitor.demonitor(monitorRef);
        activeMonitors.delete(monitorRefId);
      }

      sendResponse({
        type: 'remote_demonitor_result',
        monitorId,
      });
    } catch (error) {
      // Still report success - demonitor should be idempotent
      sendResponse({
        type: 'remote_demonitor_result',
        monitorId,
      });
    }
  }

  /**
   * Returns remote monitor statistics.
   */
  function handleGetMonitorStats(): void {
    const stats = RemoteMonitor.getStats();
    sendResponse({
      type: 'monitor_stats',
      stats: {
        initialized: stats.initialized,
        pendingCount: stats.pendingCount,
        activeOutgoingCount: stats.activeOutgoingCount,
        totalInitiated: stats.totalInitiated,
        totalEstablished: stats.totalEstablished,
        totalTimedOut: stats.totalTimedOut,
        totalDemonitored: stats.totalDemonitored,
        totalProcessDownReceived: stats.totalProcessDownReceived,
      },
    });
  }

  // ===========================================================================
  // GlobalRegistry Handlers
  // ===========================================================================

  /**
   * Registers a process globally in the cluster registry.
   */
  async function handleGlobalRegister(
    registrationId: string,
    name: string,
    processId: string,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      // Get the process ref from spawned processes
      const ref = spawnedProcesses.get(processId);
      if (!ref) {
        const durationMs = Date.now() - startTime;
        sendResponse({
          type: 'global_register_error',
          registrationId,
          errorType: 'ProcessNotFound',
          message: `Process '${processId}' not found`,
          durationMs,
        });
        return;
      }

      // Create serialized ref for registration
      const serializedRef = {
        id: ref.id,
        nodeId: Cluster.getLocalNodeId(),
      };

      await GlobalRegistry.register(name, serializedRef);

      const durationMs = Date.now() - startTime;
      sendResponse({
        type: 'global_register_result',
        registrationId,
        durationMs,
      });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorType = error instanceof Error ? error.name : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({
        type: 'global_register_error',
        registrationId,
        errorType,
        message,
        durationMs,
      });
    }
  }

  /**
   * Unregisters a globally registered name.
   */
  async function handleGlobalUnregister(
    registrationId: string,
    name: string,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      await GlobalRegistry.unregister(name);

      const durationMs = Date.now() - startTime;
      sendResponse({
        type: 'global_unregister_result',
        registrationId,
        durationMs,
      });
    } catch (error) {
      // Unregister should be idempotent, so still return success
      const durationMs = Date.now() - startTime;
      sendResponse({
        type: 'global_unregister_result',
        registrationId,
        durationMs,
      });
    }
  }

  /**
   * Looks up a globally registered name (throws if not found).
   */
  function handleGlobalLookup(lookupId: string, name: string): void {
    const startTime = Date.now();

    try {
      const ref = GlobalRegistry.lookup(name);
      const durationMs = Date.now() - startTime;

      sendResponse({
        type: 'global_lookup_result',
        lookupId,
        ref: { id: ref.id, nodeId: ref.nodeId },
        durationMs,
      });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorType = error instanceof Error ? error.name : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({
        type: 'global_lookup_error',
        lookupId,
        errorType,
        message,
        durationMs,
      });
    }
  }

  /**
   * Looks up a globally registered name (returns null if not found).
   */
  function handleGlobalWhereis(lookupId: string, name: string): void {
    const startTime = Date.now();

    const ref = GlobalRegistry.whereis(name);
    const durationMs = Date.now() - startTime;

    sendResponse({
      type: 'global_whereis_result',
      lookupId,
      ref: ref ? { id: ref.id, nodeId: ref.nodeId } : null,
      durationMs,
    });
  }

  /**
   * Returns GlobalRegistry statistics.
   */
  function handleGetGlobalRegistryStats(): void {
    const stats = GlobalRegistry.getStats();
    sendResponse({
      type: 'global_registry_stats',
      stats: {
        totalRegistrations: stats.totalRegistrations,
        localRegistrations: stats.localRegistrations,
        remoteRegistrations: stats.remoteRegistrations,
        syncOperations: stats.syncOperations,
        conflictsResolved: stats.conflictsResolved,
      },
    });
  }

  /**
   * Returns all registered global names.
   */
  function handleGetGlobalRegistryNames(): void {
    const names = GlobalRegistry.getNames();
    sendResponse({
      type: 'global_registry_names',
      names: [...names],
    });
  }

  // ===========================================================================
  // DistributedSupervisor Handlers
  // ===========================================================================

  /**
   * Sets up the DistributedSupervisor lifecycle event listener.
   */
  function setupDsupLifecycleListener(): void {
    if (dsupLifecycleUnsubscribe !== null) {
      return; // Already set up
    }

    dsupLifecycleUnsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
      // Convert the event to IPC format
      let ipcEvent: any;

      switch (event.type) {
        case 'supervisor_started':
          ipcEvent = {
            type: 'supervisor_started',
            supervisorId: event.ref.id,
            nodeId: event.ref.nodeId,
          };
          break;

        case 'supervisor_stopped':
          ipcEvent = {
            type: 'supervisor_stopped',
            supervisorId: event.ref.id,
            reason: event.reason,
          };
          break;

        case 'child_started':
          ipcEvent = {
            type: 'child_started',
            supervisorId: event.supervisorId,
            childId: event.childId,
            nodeId: event.nodeId,
            processId: event.ref.id,
          };
          break;

        case 'child_stopped':
          ipcEvent = {
            type: 'child_stopped',
            supervisorId: event.supervisorId,
            childId: event.childId,
            reason: event.reason,
          };
          break;

        case 'child_restarted':
          ipcEvent = {
            type: 'child_restarted',
            supervisorId: event.supervisorId,
            childId: event.childId,
            attempt: event.attempt,
            nodeId: event.newRef.nodeId,
          };
          break;

        case 'child_migrated':
          ipcEvent = {
            type: 'child_migrated',
            supervisorId: event.supervisorId,
            childId: event.childId,
            fromNode: event.fromNode,
            toNode: event.toNode,
          };
          break;

        case 'node_failure_detected':
          ipcEvent = {
            type: 'node_failure_detected',
            supervisorId: event.supervisorId,
            nodeId: event.nodeId,
            affectedChildren: event.affectedChildren,
          };
          break;

        case 'max_restarts_exceeded':
          ipcEvent = {
            type: 'max_restarts_exceeded',
            supervisorId: event.supervisorId,
            childId: event.childId,
          };
          break;

        default:
          return; // Unknown event type
      }

      sendResponse({
        type: 'dsup_lifecycle_event',
        event: ipcEvent,
      });
    });
  }

  /**
   * Starts a DistributedSupervisor.
   */
  async function handleDsupStart(
    requestId: string,
    options: DistributedSupervisorIPCOptions,
  ): Promise<void> {
    try {
      // Ensure lifecycle listener is set up
      setupDsupLifecycleListener();

      // Convert IPC options to actual options
      const supervisorOptions: any = {
        strategy: options.strategy,
        restartIntensity: options.restartIntensity,
        autoShutdown: options.autoShutdown,
        nodeSelector: options.nodeSelector,
      };

      // Convert children specs
      if (options.children) {
        supervisorOptions.children = options.children.map((spec) => ({
          id: spec.id,
          behavior: spec.behavior,
          restart: spec.restart,
          shutdownTimeout: spec.shutdownTimeout,
          significant: spec.significant,
          nodeSelector: spec.targetNodeId
            ? () => spec.targetNodeId
            : undefined,
        }));
      }

      // Convert child template
      if (options.childTemplate) {
        supervisorOptions.childTemplate = {
          behavior: options.childTemplate.behavior,
          restart: options.childTemplate.restart,
          shutdownTimeout: options.childTemplate.shutdownTimeout,
          significant: options.childTemplate.significant,
        };
      }

      const ref = await DistributedSupervisor.start(supervisorOptions);

      // Store reference
      activeSupervisors.set(ref.id, ref);

      sendResponse({
        type: 'dsup_started',
        requestId,
        supervisorId: ref.id,
        nodeId: ref.nodeId,
      });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({
        type: 'dsup_start_error',
        requestId,
        errorType,
        message,
      });
    }
  }

  /**
   * Stops a DistributedSupervisor.
   */
  async function handleDsupStop(
    requestId: string,
    supervisorId: string,
    reason?: 'normal' | 'shutdown',
  ): Promise<void> {
    try {
      const ref = activeSupervisors.get(supervisorId);
      if (!ref) {
        sendResponse({
          type: 'dsup_stop_error',
          requestId,
          errorType: 'SupervisorNotFound',
          message: `Supervisor '${supervisorId}' not found`,
        });
        return;
      }

      await DistributedSupervisor.stop(ref, reason);
      activeSupervisors.delete(supervisorId);

      sendResponse({
        type: 'dsup_stopped',
        requestId,
      });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({
        type: 'dsup_stop_error',
        requestId,
        errorType,
        message,
      });
    }
  }

  /**
   * Starts a child in a DistributedSupervisor.
   */
  async function handleDsupStartChild(
    requestId: string,
    supervisorId: string,
    spec: DistributedChildSpecIPC,
  ): Promise<void> {
    try {
      const ref = activeSupervisors.get(supervisorId);
      if (!ref) {
        sendResponse({
          type: 'dsup_child_start_error',
          requestId,
          errorType: 'SupervisorNotFound',
          message: `Supervisor '${supervisorId}' not found`,
        });
        return;
      }

      // Convert IPC spec to actual spec
      const childSpec: any = {
        id: spec.id,
        behavior: spec.behavior,
        restart: spec.restart,
        shutdownTimeout: spec.shutdownTimeout,
        significant: spec.significant,
        nodeSelector: spec.targetNodeId
          ? () => spec.targetNodeId
          : undefined,
      };

      const childRef = await DistributedSupervisor.startChild(ref, childSpec);

      sendResponse({
        type: 'dsup_child_started',
        requestId,
        childRef: { id: childRef.id, nodeId: childRef.nodeId },
      });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({
        type: 'dsup_child_start_error',
        requestId,
        errorType,
        message,
      });
    }
  }

  /**
   * Terminates a child in a DistributedSupervisor.
   */
  async function handleDsupTerminateChild(
    requestId: string,
    supervisorId: string,
    childId: string,
  ): Promise<void> {
    try {
      const ref = activeSupervisors.get(supervisorId);
      if (!ref) {
        sendResponse({
          type: 'dsup_child_terminate_error',
          requestId,
          errorType: 'SupervisorNotFound',
          message: `Supervisor '${supervisorId}' not found`,
        });
        return;
      }

      await DistributedSupervisor.terminateChild(ref, childId);

      sendResponse({
        type: 'dsup_child_terminated',
        requestId,
      });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({
        type: 'dsup_child_terminate_error',
        requestId,
        errorType,
        message,
      });
    }
  }

  /**
   * Restarts a child in a DistributedSupervisor.
   */
  async function handleDsupRestartChild(
    requestId: string,
    supervisorId: string,
    childId: string,
  ): Promise<void> {
    try {
      const ref = activeSupervisors.get(supervisorId);
      if (!ref) {
        sendResponse({
          type: 'dsup_child_restart_error',
          requestId,
          errorType: 'SupervisorNotFound',
          message: `Supervisor '${supervisorId}' not found`,
        });
        return;
      }

      const newRef = await DistributedSupervisor.restartChild(ref, childId);

      sendResponse({
        type: 'dsup_child_restarted',
        requestId,
        childRef: { id: newRef.id, nodeId: newRef.nodeId },
      });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({
        type: 'dsup_child_restart_error',
        requestId,
        errorType,
        message,
      });
    }
  }

  /**
   * Gets all children of a DistributedSupervisor.
   */
  function handleDsupGetChildren(
    requestId: string,
    supervisorId: string,
  ): void {
    try {
      const ref = activeSupervisors.get(supervisorId);
      if (!ref) {
        sendResponse({
          type: 'dsup_children_error',
          requestId,
          errorType: 'SupervisorNotFound',
          message: `Supervisor '${supervisorId}' not found`,
        });
        return;
      }

      const children = DistributedSupervisor.getChildren(ref);

      sendResponse({
        type: 'dsup_children',
        requestId,
        children: children.map((child) => ({
          id: child.id,
          ref: { id: child.ref.id, nodeId: child.ref.nodeId },
          nodeId: child.nodeId,
          spec: {
            id: child.spec.id,
            behavior: child.spec.behavior,
            restart: child.spec.restart,
            shutdownTimeout: child.spec.shutdownTimeout,
            significant: child.spec.significant,
          },
          restartCount: child.restartCount,
          startedAt: child.startedAt,
        })),
      });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({
        type: 'dsup_children_error',
        requestId,
        errorType,
        message,
      });
    }
  }

  /**
   * Gets statistics from a DistributedSupervisor.
   */
  function handleDsupGetStats(
    requestId: string,
    supervisorId: string,
  ): void {
    try {
      const ref = activeSupervisors.get(supervisorId);
      if (!ref) {
        sendResponse({
          type: 'dsup_stats_error',
          requestId,
          errorType: 'SupervisorNotFound',
          message: `Supervisor '${supervisorId}' not found`,
        });
        return;
      }

      const stats = DistributedSupervisor.getStats(ref);

      sendResponse({
        type: 'dsup_stats',
        requestId,
        stats: {
          id: stats.id,
          strategy: stats.strategy,
          childCount: stats.childCount,
          totalRestarts: stats.totalRestarts,
          nodeFailureRestarts: stats.nodeFailureRestarts,
          uptimeMs: stats.uptimeMs,
          localChildren: stats.localChildren,
          remoteChildren: stats.remoteChildren,
        },
      });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({
        type: 'dsup_stats_error',
        requestId,
        errorType,
        message,
      });
    }
  }

  /**
   * Counts children of a DistributedSupervisor.
   */
  function handleDsupCountChildren(
    requestId: string,
    supervisorId: string,
  ): void {
    try {
      const ref = activeSupervisors.get(supervisorId);
      if (!ref) {
        sendResponse({
          type: 'dsup_count_error',
          requestId,
          errorType: 'SupervisorNotFound',
          message: `Supervisor '${supervisorId}' not found`,
        });
        return;
      }

      const count = DistributedSupervisor.countChildren(ref);

      sendResponse({
        type: 'dsup_count',
        requestId,
        count,
      });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({
        type: 'dsup_count_error',
        requestId,
        errorType,
        message,
      });
    }
  }

  /**
   * Checks if a DistributedSupervisor is running.
   */
  function handleDsupIsRunning(
    requestId: string,
    supervisorId: string,
  ): void {
    const ref = activeSupervisors.get(supervisorId);
    const isRunning = ref ? DistributedSupervisor.isRunning(ref) : false;

    sendResponse({
      type: 'dsup_is_running_result',
      requestId,
      isRunning,
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
