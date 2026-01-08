/**
 * Distributed Worker Pool - Supervisor Node
 *
 * Manages a distributed task processing system demonstrating:
 * - DistributedSupervisor with automatic failover
 * - Node selection strategies (round_robin, least_loaded, local_first, random)
 * - Task queue and result collection
 * - Worker lifecycle management
 * - Child migration on node failure
 *
 * Usage:
 *   npx tsx supervisor-node.ts --name <node-name> --port <port> [--seed <node@host:port>]
 *
 * Example:
 *   npx tsx supervisor-node.ts --name supervisor --port 4369
 */

import * as readline from 'node:readline';
import { GenServer, type GenServerRef } from 'noex';
import {
  Cluster,
  BehaviorRegistry,
  GlobalRegistry,
  RemoteCall,
  DistributedSupervisor,
  type DistributedSupervisorRef,
  type DistributedSupervisorEvent,
  type NodeId,
  type SerializedRef,
  type NodeInfo,
  type NodeDownReason,
  type NodeSelectorType,
} from 'noex/distribution';

import {
  createTaskQueueBehavior,
  createResultCollectorBehavior,
  workerBehavior,
  taskQueueBehavior,
  resultCollectorBehavior,
} from './shared/behaviors.js';

import {
  BEHAVIOR_NAMES,
  type TaskQueueCallMsg,
  type TaskQueueCallReply,
  type ResultCollectorCallMsg,
  type ResultCollectorCallReply,
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
    console.error('Usage: npx tsx supervisor-node.ts --name <name> --port <port> [--seed <node@host:port>]');
    process.exit(1);
  }

  return { name, port, seeds: seeds.filter(Boolean) };
}

// =============================================================================
// State
// =============================================================================

type TaskQueueRef = GenServerRef<unknown, TaskQueueCallMsg, unknown, TaskQueueCallReply>;
type ResultCollectorRef = GenServerRef<unknown, ResultCollectorCallMsg, unknown, ResultCollectorCallReply>;

interface AppState {
  supervisorRef: DistributedSupervisorRef | null;
  taskQueueRef: TaskQueueRef | null;
  resultCollectorRef: ResultCollectorRef | null;
  currentStrategy: NodeSelectorType;
  workerIdCounter: number;
}

const state: AppState = {
  supervisorRef: null,
  taskQueueRef: null,
  resultCollectorRef: null,
  currentStrategy: 'round_robin',
  workerIdCounter: 0,
};

// =============================================================================
// Smart Call Helper
// =============================================================================

function isLocalRef(ref: SerializedRef): boolean {
  return ref.nodeId === Cluster.getLocalNodeId();
}

async function smartCall<T>(ref: SerializedRef, msg: unknown, timeout = 5000): Promise<T> {
  if (isLocalRef(ref)) {
    const localRef = GenServer._getRefById(ref.id);
    if (!localRef) {
      throw new Error(`Process ${ref.id} not found`);
    }
    return GenServer.call(localRef, msg, { timeout }) as Promise<T>;
  }
  return RemoteCall.call<T>(ref, msg, { timeout });
}

// =============================================================================
// Display Helpers
// =============================================================================

let rl: readline.Interface;

function log(message: string): void {
  console.log(`\n${message}`);
  rl.prompt(true);
}

function handleSupervisorEvent(event: DistributedSupervisorEvent): void {
  switch (event.type) {
    case 'child_started':
      log(`Worker ${event.childId} started on ${event.nodeId}`);
      break;
    case 'child_stopped':
      log(`Worker ${event.childId} stopped (${event.reason})`);
      break;
    case 'child_restarted':
      log(`Worker ${event.childId} restarted on ${event.nodeId} (attempt ${event.attempt})`);
      break;
    case 'child_migrated':
      log(`Worker ${event.childId} migrated: ${event.fromNode} -> ${event.toNode}`);
      break;
    case 'node_failure_detected':
      log(`Node failure detected: ${event.nodeId}, affected workers: ${event.affectedChildren.join(', ')}`);
      break;
    case 'supervisor_stopped':
      log(`Supervisor stopped (${event.reason})`);
      break;
  }
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

      case '/add-worker':
        await addWorker(args[0]);
        break;

      case '/remove-worker':
        await removeWorker(args[0]);
        break;

      case '/submit':
        await submitTask(args.join(' '));
        break;

      case '/batch':
        await submitBatch(parseInt(args[0] ?? '5', 10));
        break;

      case '/results':
        await showResults(parseInt(args[0] ?? '10', 10));
        break;

      case '/stats':
        await showStats();
        break;

      case '/strategy':
        setStrategy(args[0] as NodeSelectorType);
        break;

      case '/workers':
        showWorkers();
        break;

      case '/nodes':
        listNodes();
        break;

      case '/quit':
        await quit();
        break;

      default:
        log(`Unknown command: ${command}. Type /help for available commands.`);
    }
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function showHelp(): void {
  console.log(`
Distributed Worker Pool - Supervisor Commands:
  /help                     Show this help message
  /add-worker [on <node>]   Add a new worker (optionally on specific node)
  /remove-worker <id>       Remove a worker by ID
  /submit <task>            Submit a task to the queue
  /batch <n>                Submit n random tasks (default: 5)
  /results [n]              Show last n results (default: 10)
  /stats                    Show supervisor and queue statistics
  /strategy <type>          Set node selection strategy
                            (round_robin, least_loaded, local_first, random)
  /workers                  List all workers and their nodes
  /nodes                    List connected nodes
  /quit                     Shutdown and exit

Demo: Start supervisor, add workers, submit tasks, then kill a worker node.
`);
}

async function addWorker(nodeArg?: string): Promise<void> {
  if (!state.supervisorRef) {
    log('Supervisor not initialized.');
    return;
  }

  const workerId = `worker_${++state.workerIdCounter}`;

  // Parse optional "on <node>" syntax
  let nodeSelector: NodeSelectorType | undefined;
  if (nodeArg === 'on') {
    log('Usage: /add-worker [on <node>] - specify node name after "on"');
    return;
  }

  // Use current strategy as default
  nodeSelector = state.currentStrategy;

  try {
    const childRef = await DistributedSupervisor.startChild(state.supervisorRef, {
      id: workerId,
      behavior: BEHAVIOR_NAMES.WORKER,
      restart: 'permanent',
      nodeSelector,
    });

    // Configure the worker with queue and collector refs
    const localNodeId = Cluster.getLocalNodeId();
    const taskQueueSerializedRef: SerializedRef = {
      id: state.taskQueueRef!.id,
      nodeId: localNodeId,
    };
    const resultCollectorSerializedRef: SerializedRef = {
      id: state.resultCollectorRef!.id,
      nodeId: localNodeId,
    };

    // Get the worker's serialized ref for remote cast
    const childInfo = DistributedSupervisor.getChild(state.supervisorRef, workerId);
    if (childInfo) {
      const workerRef: SerializedRef = {
        id: childInfo.ref.id,
        nodeId: childInfo.nodeId,
      };

      if (isLocalRef(workerRef)) {
        GenServer.cast(childInfo.ref, {
          type: 'configure',
          taskQueueRef: taskQueueSerializedRef,
          resultCollectorRef: resultCollectorSerializedRef,
        });
      } else {
        RemoteCall.cast(workerRef, {
          type: 'configure',
          taskQueueRef: taskQueueSerializedRef,
          resultCollectorRef: resultCollectorSerializedRef,
        });
      }
    }

    log(`Added worker ${workerId}`);
  } catch (error) {
    log(`Failed to add worker: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function removeWorker(workerId: string | undefined): Promise<void> {
  if (!workerId) {
    log('Usage: /remove-worker <id>');
    return;
  }

  if (!state.supervisorRef) {
    log('Supervisor not initialized.');
    return;
  }

  try {
    await DistributedSupervisor.terminateChild(state.supervisorRef, workerId);
    log(`Removed worker ${workerId}`);
  } catch (error) {
    log(`Failed to remove worker: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function submitTask(taskPayload: string): Promise<void> {
  if (!taskPayload) {
    log('Usage: /submit <task description>');
    return;
  }

  if (!state.taskQueueRef) {
    log('Task queue not initialized.');
    return;
  }

  const localNodeId = Cluster.getLocalNodeId();
  const queueRef: SerializedRef = {
    id: state.taskQueueRef.id,
    nodeId: localNodeId,
  };

  const result = await smartCall<TaskQueueCallReply>(queueRef, {
    type: 'submit_task',
    taskType: 'default',
    payload: taskPayload,
  });

  if ('taskId' in result) {
    log(`Task submitted: ${result.taskId}`);
  }
}

async function submitBatch(count: number): Promise<void> {
  if (!state.taskQueueRef) {
    log('Task queue not initialized.');
    return;
  }

  if (count < 1 || count > 100) {
    log('Batch size must be between 1 and 100.');
    return;
  }

  const localNodeId = Cluster.getLocalNodeId();
  const queueRef: SerializedRef = {
    id: state.taskQueueRef.id,
    nodeId: localNodeId,
  };

  log(`Submitting ${count} tasks...`);

  for (let i = 0; i < count; i++) {
    await smartCall<TaskQueueCallReply>(queueRef, {
      type: 'submit_task',
      taskType: 'batch',
      payload: `Batch task #${i + 1}`,
    });
  }

  log(`Submitted ${count} tasks.`);
}

async function showResults(limit: number): Promise<void> {
  if (!state.resultCollectorRef) {
    log('Result collector not initialized.');
    return;
  }

  const localNodeId = Cluster.getLocalNodeId();
  const collectorRef: SerializedRef = {
    id: state.resultCollectorRef.id,
    nodeId: localNodeId,
  };

  const result = await smartCall<ResultCollectorCallReply>(collectorRef, {
    type: 'get_results',
    limit,
  });

  if ('results' in result) {
    if (result.results.length === 0) {
      log('No results yet.');
      return;
    }

    log(`Last ${result.results.length} results:`);
    for (const r of result.results) {
      const status = r.success ? 'OK' : 'FAILED';
      const time = new Date(r.completedAt).toLocaleTimeString();
      console.log(`  [${time}] ${r.taskId}: ${status} (${r.workerId} on ${r.nodeId}, ${r.durationMs}ms)`);
    }
  }
}

async function showStats(): Promise<void> {
  log('=== Statistics ===');

  // Supervisor stats
  if (state.supervisorRef) {
    const supStats = DistributedSupervisor.getStats(state.supervisorRef);
    console.log('\nSupervisor:');
    console.log(`  Strategy: ${supStats.strategy}`);
    console.log(`  Workers: ${supStats.childCount}`);
    console.log(`  Total restarts: ${supStats.totalRestarts}`);
    console.log(`  Node failure restarts: ${supStats.nodeFailureRestarts}`);
    console.log(`  Uptime: ${Math.floor(supStats.uptimeMs / 1000)}s`);

    console.log('  Workers by node:');
    for (const [nodeId, count] of supStats.childrenByNode) {
      console.log(`    ${nodeId}: ${count}`);
    }
  }

  // Queue stats
  if (state.taskQueueRef) {
    const localNodeId = Cluster.getLocalNodeId();
    const queueRef: SerializedRef = {
      id: state.taskQueueRef.id,
      nodeId: localNodeId,
    };

    const queueStats = await smartCall<TaskQueueCallReply>(queueRef, { type: 'get_stats' });
    if ('pendingCount' in queueStats) {
      console.log('\nTask Queue:');
      console.log(`  Pending: ${queueStats.pendingCount}`);
      console.log(`  Processing: ${queueStats.processingCount}`);
      console.log(`  Total submitted: ${queueStats.totalSubmitted}`);
      console.log(`  Total dispatched: ${queueStats.totalDispatched}`);
    }
  }

  // Collector stats
  if (state.resultCollectorRef) {
    const localNodeId = Cluster.getLocalNodeId();
    const collectorRef: SerializedRef = {
      id: state.resultCollectorRef.id,
      nodeId: localNodeId,
    };

    const collectorStats = await smartCall<ResultCollectorCallReply>(collectorRef, { type: 'get_stats' });
    if ('totalResults' in collectorStats) {
      console.log('\nResult Collector:');
      console.log(`  Total results: ${collectorStats.totalResults}`);
      console.log(`  Successful: ${collectorStats.successCount}`);
      console.log(`  Failed: ${collectorStats.failedCount}`);
      const successRate = collectorStats.totalResults > 0
        ? ((collectorStats.successCount / collectorStats.totalResults) * 100).toFixed(1)
        : 0;
      console.log(`  Success rate: ${successRate}%`);
    }
  }

  console.log(`\nCurrent strategy: ${state.currentStrategy}`);
}

function setStrategy(strategy: NodeSelectorType | undefined): void {
  const validStrategies: NodeSelectorType[] = ['round_robin', 'least_loaded', 'local_first', 'random'];

  if (!strategy || !validStrategies.includes(strategy)) {
    log(`Valid strategies: ${validStrategies.join(', ')}`);
    return;
  }

  state.currentStrategy = strategy;
  log(`Node selection strategy set to: ${strategy}`);
}

function showWorkers(): void {
  if (!state.supervisorRef) {
    log('Supervisor not initialized.');
    return;
  }

  const children = DistributedSupervisor.getChildren(state.supervisorRef);

  if (children.length === 0) {
    log('No workers. Use /add-worker to add one.');
    return;
  }

  log('Workers:');
  for (const child of children) {
    const uptime = Math.floor((Date.now() - child.startedAt) / 1000);
    console.log(`  - ${child.id} on ${child.nodeId} (restarts: ${child.restartCount}, uptime: ${uptime}s)`);
  }
}

function listNodes(): void {
  const localId = Cluster.getLocalNodeId();
  const nodes = Cluster.getNodes();

  log('Connected nodes:');
  console.log(`  - ${localId} (local, supervisor)`);

  for (const node of nodes) {
    if (node.id !== localId) {
      console.log(`  - ${node.id} (${node.status})`);
    }
  }

  console.log(`\nTotal: ${nodes.length + 1} nodes`);
}

async function quit(): Promise<void> {
  log('Shutting down...');

  if (state.supervisorRef) {
    await DistributedSupervisor.stop(state.supervisorRef);
  }

  if (state.taskQueueRef) {
    await GenServer.stop(state.taskQueueRef);
  }

  if (state.resultCollectorRef) {
    await GenServer.stop(state.resultCollectorRef);
  }

  await Cluster.stop();
  process.exit(0);
}

// =============================================================================
// Main
// =============================================================================

const args = parseArgs();

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  Distributed Worker Pool - Supervisor Node');
  console.log('='.repeat(60));
  console.log();

  // Register behaviors for remote spawning
  BehaviorRegistry.register(BEHAVIOR_NAMES.WORKER, workerBehavior);
  BehaviorRegistry.register(BEHAVIOR_NAMES.TASK_QUEUE, taskQueueBehavior);
  BehaviorRegistry.register(BEHAVIOR_NAMES.RESULT_COLLECTOR, resultCollectorBehavior);

  // Start cluster
  console.log(`Starting supervisor node: ${args.name}@127.0.0.1:${args.port}`);
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

  // Create task queue (local)
  const taskQueueBeh = createTaskQueueBehavior();
  state.taskQueueRef = (await GenServer.start(taskQueueBeh, { name: 'task-queue' })) as TaskQueueRef;

  const localNodeId = Cluster.getLocalNodeId();
  await GlobalRegistry.register('task-queue', {
    id: state.taskQueueRef.id,
    nodeId: localNodeId,
  });
  console.log('Task queue created and registered globally.');

  // Create result collector (local)
  const resultCollectorBeh = createResultCollectorBehavior();
  state.resultCollectorRef = (await GenServer.start(resultCollectorBeh, { name: 'results' })) as ResultCollectorRef;

  await GlobalRegistry.register('results', {
    id: state.resultCollectorRef.id,
    nodeId: localNodeId,
  });
  console.log('Result collector created and registered globally.');

  // Create distributed supervisor for workers
  state.supervisorRef = await DistributedSupervisor.start({
    strategy: 'one_for_one',
    nodeSelector: state.currentStrategy,
    restartIntensity: {
      maxRestarts: 10,
      withinMs: 60000,
    },
  });
  console.log('Distributed supervisor started.');

  // Register supervisor lifecycle events
  DistributedSupervisor.onLifecycleEvent(handleSupervisorEvent);

  console.log('\nType /help for available commands.');
  console.log();

  // Set up cluster event handlers
  Cluster.onNodeUp((node: NodeInfo) => {
    log(`Node joined: ${node.id}`);
  });

  Cluster.onNodeDown((nodeId: NodeId, reason: NodeDownReason) => {
    log(`Node left: ${nodeId} (${reason})`);
  });

  // Set up readline
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'supervisor> ',
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
