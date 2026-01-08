/**
 * Distributed Worker Pool - Worker Node
 *
 * A worker node that joins the cluster and can host worker processes.
 * Workers are spawned by the supervisor on this node using RemoteSpawn.
 *
 * Features:
 * - Joins cluster and registers behaviors
 * - Workers are spawned remotely by the supervisor
 * - Interactive commands for testing crash/speed scenarios
 *
 * Usage:
 *   npx tsx worker-node.ts --name <node-name> --port <port> --seed <supervisor@host:port>
 *
 * Example:
 *   npx tsx worker-node.ts --name worker1 --port 4370 --seed supervisor@127.0.0.1:4369
 */

import * as readline from 'node:readline';
import { GenServer, type GenServerRef } from 'noex';
import {
  Cluster,
  BehaviorRegistry,
  GlobalRegistry,
  RemoteCall,
  type NodeId,
  type SerializedRef,
  type NodeInfo,
  type NodeDownReason,
} from 'noex/distribution';

import { workerBehavior, taskQueueBehavior, resultCollectorBehavior } from './shared/behaviors.js';
import {
  BEHAVIOR_NAMES,
  type WorkerCallMsg,
  type WorkerCallReply,
  type WorkerCastMsg,
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
  let port = 4370;
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
        port = parseInt(args[++i] ?? '4370', 10);
        break;
      case '--seed':
      case '-s':
        seeds.push(args[++i] ?? '');
        break;
    }
  }

  if (!name) {
    console.error('Error: --name is required');
    console.error('Usage: npx tsx worker-node.ts --name <name> --port <port> --seed <node@host:port>');
    process.exit(1);
  }

  if (seeds.length === 0) {
    console.error('Warning: No seed nodes specified. This node will not join any cluster.');
  }

  return { name, port, seeds: seeds.filter(Boolean) };
}

// =============================================================================
// State
// =============================================================================

interface AppState {
  localWorkers: Map<string, GenServerRef>;
}

const state: AppState = {
  localWorkers: new Map(),
};

// =============================================================================
// Smart Call/Cast Helpers
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

function smartCast(ref: SerializedRef, msg: unknown): void {
  if (isLocalRef(ref)) {
    const localRef = GenServer._getRefById(ref.id);
    if (localRef) {
      GenServer.cast(localRef, msg);
    }
  } else {
    RemoteCall.cast(ref, msg);
  }
}

// =============================================================================
// Display Helpers
// =============================================================================

let rl: readline.Interface;

function log(message: string): void {
  console.log(`\n${message}`);
  rl.prompt(true);
}

// =============================================================================
// Local Worker Tracking
// =============================================================================

/**
 * Scans for locally running workers (spawned by the distributed supervisor).
 */
function findLocalWorkers(): Map<string, GenServerRef> {
  const workers = new Map<string, GenServerRef>();

  // GenServer doesn't expose a way to enumerate all servers,
  // so we track workers that were spawned on this node via lifecycle events
  // For now, we'll try to find them through GlobalRegistry names

  return workers;
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

      case '/workers':
        await listLocalWorkers();
        break;

      case '/crash':
        await crashWorker(args[0]);
        break;

      case '/slow':
        await setWorkerSpeed(args[0], 0.5);
        break;

      case '/fast':
        await setWorkerSpeed(args[0], 2);
        break;

      case '/normal':
        await setWorkerSpeed(args[0], 1);
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
Distributed Worker Pool - Worker Node Commands:
  /help                 Show this help message
  /workers              List workers running on this node
  /crash <worker-id>    Simulate worker crash
  /slow <worker-id>     Set worker to slow mode (0.5x speed)
  /fast <worker-id>     Set worker to fast mode (2x speed)
  /normal <worker-id>   Reset worker to normal speed (1x)
  /nodes                List connected nodes
  /quit                 Disconnect and exit

Workers are spawned by the supervisor node. Use supervisor commands to add workers.
`);
}

async function listLocalWorkers(): Promise<void> {
  // Get all registered names and find workers
  const names = GlobalRegistry.getNames();
  const localNodeId = Cluster.getLocalNodeId();

  // Track workers that are running on this node
  // Workers don't register globally, but we can find them via DistributedChildRegistry
  // For simplicity in this example, we'll iterate through the supervisor's children
  // and filter by node

  log('Workers on this node:');
  console.log('  (Workers are managed by the supervisor. Use /workers on supervisor node to see all workers.)');
  console.log(`  Local node: ${localNodeId}`);

  // Check if we have any locally tracked workers
  if (state.localWorkers.size > 0) {
    for (const [id, ref] of state.localWorkers) {
      const isRunning = GenServer.isRunning(ref);
      console.log(`  - ${id}: ${isRunning ? 'running' : 'stopped'}`);
    }
  } else {
    console.log('  No locally tracked workers yet.');
    console.log('  Workers spawned by the supervisor will be listed when they start processing.');
  }
}

async function crashWorker(workerId: string | undefined): Promise<void> {
  if (!workerId) {
    log('Usage: /crash <worker-id>');
    log('Note: Worker IDs are like "worker_1". Check with supervisor /workers command.');
    return;
  }

  // Try to find the worker by looking up through registered behaviors
  // This is a simplified approach - in production you'd use proper tracking
  log(`Attempting to crash worker ${workerId}...`);
  log('Note: Use the supervisor to identify and manage workers.');
  log('This command broadcasts a crash message to any matching local worker.');

  // Broadcast crash to any local process that might be the worker
  const localProcesses = getAllLocalGenServers();
  let found = false;

  for (const ref of localProcesses) {
    try {
      // Try to get status to see if this is a worker
      const status = await GenServer.call(ref, { type: 'get_status' }, { timeout: 1000 }) as WorkerCallReply;
      if ('id' in status && status.id.includes(workerId.replace('worker_', ''))) {
        GenServer.cast(ref, { type: 'crash' });
        log(`Crash signal sent to worker ${workerId}`);
        found = true;
        break;
      }
    } catch {
      // Not a worker or different type of process
    }
  }

  if (!found) {
    log(`Worker ${workerId} not found on this node.`);
  }
}

async function setWorkerSpeed(workerId: string | undefined, multiplier: number): Promise<void> {
  if (!workerId) {
    log(`Usage: /slow <worker-id> or /fast <worker-id> or /normal <worker-id>`);
    return;
  }

  const localProcesses = getAllLocalGenServers();
  let found = false;

  for (const ref of localProcesses) {
    try {
      const status = await GenServer.call(ref, { type: 'get_status' }, { timeout: 1000 }) as WorkerCallReply;
      if ('id' in status && status.id.includes(workerId.replace('worker_', ''))) {
        GenServer.cast(ref, { type: 'set_speed', multiplier });
        const speedName = multiplier < 1 ? 'slow' : multiplier > 1 ? 'fast' : 'normal';
        log(`Worker ${workerId} set to ${speedName} mode (${multiplier}x speed)`);
        found = true;
        break;
      }
    } catch {
      // Not a worker or different type of process
    }
  }

  if (!found) {
    log(`Worker ${workerId} not found on this node.`);
  }
}

/**
 * Gets all locally running GenServer refs.
 * Note: This is a simplified implementation for the example.
 */
function getAllLocalGenServers(): GenServerRef[] {
  // GenServer doesn't expose enumeration, so we use internal tracking
  // In production, you'd maintain your own registry or use a proper service registry
  return Array.from(state.localWorkers.values());
}

function listNodes(): void {
  const localId = Cluster.getLocalNodeId();
  const nodes = Cluster.getNodes();

  log('Connected nodes:');
  console.log(`  - ${localId} (local, worker node)`);

  for (const node of nodes) {
    if (node.id !== localId) {
      console.log(`  - ${node.id} (${node.status})`);
    }
  }

  console.log(`\nTotal: ${nodes.length + 1} nodes`);
}

async function quit(): Promise<void> {
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
  console.log('  Distributed Worker Pool - Worker Node');
  console.log('='.repeat(60));
  console.log();

  // Register behaviors for remote spawning
  // IMPORTANT: All nodes must register the same behaviors
  BehaviorRegistry.register(BEHAVIOR_NAMES.WORKER, workerBehavior);
  BehaviorRegistry.register(BEHAVIOR_NAMES.TASK_QUEUE, taskQueueBehavior);
  BehaviorRegistry.register(BEHAVIOR_NAMES.RESULT_COLLECTOR, resultCollectorBehavior);

  // Start cluster
  console.log(`Starting worker node: ${args.name}@127.0.0.1:${args.port}`);
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
  console.log('This node is ready to host workers spawned by the supervisor.');
  console.log('\nType /help for available commands.');
  console.log();

  // Track lifecycle events to know when workers are spawned on this node
  GenServer.onLifecycleEvent((event) => {
    if (event.type === 'started') {
      // A new GenServer started - might be a worker
      state.localWorkers.set(event.ref.id, event.ref);
    } else if (event.type === 'terminated') {
      state.localWorkers.delete(event.ref.id);
    }
  });

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
    prompt: 'worker> ',
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
