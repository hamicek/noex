/**
 * Distributed Counter Node
 *
 * Interactive counter application demonstrating noex fault tolerance features:
 * - Cluster formation with seed-based discovery
 * - Remote process spawning (RemoteSpawn)
 * - Cross-node communication (RemoteCall/Cast)
 * - Remote process monitoring (RemoteMonitor)
 * - Global process registry (GlobalRegistry)
 * - Node lifecycle and process_down events
 *
 * Usage:
 *   npx tsx node.ts --name <node-name> --port <port> [--seed <node@host:port>]
 *
 * Example:
 *   Terminal 1: npx tsx node.ts --name node1 --port 4369
 *   Terminal 2: npx tsx node.ts --name node2 --port 4370 --seed node1@127.0.0.1:4369
 */

import * as readline from 'node:readline';
import { GenServer, type GenServerRef, type MonitorRef, type LifecycleEvent } from 'noex';
import {
  Cluster,
  BehaviorRegistry,
  GlobalRegistry,
  RemoteSpawn,
  RemoteCall,
  RemoteMonitor,
  type NodeId,
  type SerializedRef,
  type NodeInfo,
  type NodeDownReason,
} from 'noex/distribution';

import {
  createCounterBehavior,
  createCounterWatcherBehavior,
  counterBehavior,
  counterWatcherBehavior,
} from './shared/behaviors.js';
import {
  BEHAVIOR_NAMES,
  type CounterCallMsg,
  type CounterCastMsg,
  type CounterCallReply,
  type CounterWatcherCallMsg,
  type CounterWatcherCastMsg,
  type CounterWatcherCallReply,
  type WatcherEvent,
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
    console.error('Usage: npx tsx node.ts --name <name> --port <port> [--seed <node@host:port>]');
    process.exit(1);
  }

  return { name, port, seeds: seeds.filter(Boolean) };
}

// =============================================================================
// State
// =============================================================================

type WatcherRef = GenServerRef<unknown, CounterWatcherCallMsg, CounterWatcherCastMsg, CounterWatcherCallReply>;

interface AppState {
  watcherRef: WatcherRef | null;
  activeMonitors: Map<string, MonitorRef>;
}

const state: AppState = {
  watcherRef: null,
  activeMonitors: new Map(),
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

function handleWatcherEvent(event: WatcherEvent): void {
  switch (event.type) {
    case 'watch_started':
      log(`Started watching counter "${event.name}" on ${event.nodeId}`);
      break;
    case 'watch_stopped':
      log(`Stopped watching counter "${event.name}"`);
      break;
    case 'counter_down':
      log(`Counter "${event.name}" on ${event.nodeId} went DOWN! Reason: ${event.reason.type}`);
      state.activeMonitors.delete(event.name);
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

      case '/create':
        await createCounter(args);
        break;

      case '/inc':
        await incrementCounter(args[0], args[1]);
        break;

      case '/dec':
        await decrementCounter(args[0], args[1]);
        break;

      case '/get':
        await getCounter(args[0]);
        break;

      case '/watch':
        await watchCounter(args[0]);
        break;

      case '/unwatch':
        await unwatchCounter(args[0]);
        break;

      case '/counters':
        listCounters();
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
Distributed Counter Commands:
  /help                     Show this help message
  /create <name>            Create a counter locally
  /create <name> on <node>  Create a counter on a specific node
  /inc <name> [amount]      Increment counter (default: 1)
  /dec <name> [amount]      Decrement counter (default: 1)
  /get <name>               Get counter value
  /watch <name>             Start monitoring a counter
  /unwatch <name>           Stop monitoring a counter
  /counters                 List all counters across the cluster
  /nodes                    List connected nodes
  /quit                     Disconnect and exit

Demo: Create a counter on node2, watch it from node1, then kill node2.
`);
}

async function createCounter(args: string[]): Promise<void> {
  const onIndex = args.indexOf('on');
  let counterName: string;
  let targetNode: NodeId | null = null;

  if (onIndex !== -1) {
    counterName = args.slice(0, onIndex).join(' ');
    const nodeName = args.slice(onIndex + 1).join(' ');

    const nodes = Cluster.getNodes();
    const node = nodes.find((n: NodeInfo) => n.id.startsWith(nodeName + '@') || n.id === nodeName);

    if (!node) {
      log(`Node not found: ${nodeName}. Available nodes:`);
      for (const n of nodes) {
        log(`  - ${n.id}`);
      }
      return;
    }
    targetNode = node.id;
  } else {
    counterName = args.join(' ');
  }

  if (!counterName) {
    log('Usage: /create <name> [on <node>]');
    return;
  }

  const globalName = `counter:${counterName}`;
  if (GlobalRegistry.isRegistered(globalName)) {
    log(`Counter "${counterName}" already exists.`);
    return;
  }

  if (targetNode && targetNode !== Cluster.getLocalNodeId()) {
    log(`Creating counter "${counterName}" on ${targetNode}...`);

    const result = await RemoteSpawn.spawn(BEHAVIOR_NAMES.COUNTER, targetNode, {
      name: globalName,
      registration: 'global',
    });

    log(`Counter "${counterName}" created on ${result.nodeId} with value 0.`);
  } else {
    const behavior = createCounterBehavior(counterName, 0);
    const counterRef = await GenServer.start(behavior, { name: globalName });

    const localNodeId = Cluster.getLocalNodeId();
    await GlobalRegistry.register(globalName, {
      id: counterRef.id,
      nodeId: localNodeId,
    });

    log(`Counter "${counterName}" created locally with value 0.`);
  }
}

async function incrementCounter(name: string | undefined, amountStr?: string): Promise<void> {
  if (!name) {
    log('Usage: /inc <name> [amount]');
    return;
  }

  const counterRef = GlobalRegistry.whereis(`counter:${name}`);
  if (!counterRef) {
    log(`Counter "${name}" not found.`);
    return;
  }

  const amount = amountStr ? parseInt(amountStr, 10) : 1;
  smartCast(counterRef, { type: 'increment', by: amount });

  // Get and display new value
  const result = await smartCall<CounterCallReply>(counterRef, { type: 'get' });
  if ('value' in result) {
    log(`Counter "${name}" incremented by ${amount}. New value: ${result.value}`);

    // Update watcher's last known value
    if (state.watcherRef) {
      GenServer.cast(state.watcherRef, { type: 'value_updated', name, value: result.value });
    }
  }
}

async function decrementCounter(name: string | undefined, amountStr?: string): Promise<void> {
  if (!name) {
    log('Usage: /dec <name> [amount]');
    return;
  }

  const counterRef = GlobalRegistry.whereis(`counter:${name}`);
  if (!counterRef) {
    log(`Counter "${name}" not found.`);
    return;
  }

  const amount = amountStr ? parseInt(amountStr, 10) : 1;
  smartCast(counterRef, { type: 'decrement', by: amount });

  // Get and display new value
  const result = await smartCall<CounterCallReply>(counterRef, { type: 'get' });
  if ('value' in result) {
    log(`Counter "${name}" decremented by ${amount}. New value: ${result.value}`);

    // Update watcher's last known value
    if (state.watcherRef) {
      GenServer.cast(state.watcherRef, { type: 'value_updated', name, value: result.value });
    }
  }
}

async function getCounter(name: string | undefined): Promise<void> {
  if (!name) {
    log('Usage: /get <name>');
    return;
  }

  const counterRef = GlobalRegistry.whereis(`counter:${name}`);
  if (!counterRef) {
    log(`Counter "${name}" not found.`);
    return;
  }

  const result = await smartCall<CounterCallReply>(counterRef, { type: 'get_info' });
  if ('name' in result && 'lastUpdated' in result) {
    const updatedAt = new Date(result.lastUpdated).toLocaleTimeString();
    log(`Counter "${result.name}": value=${result.value}, last updated at ${updatedAt}`);
    log(`  Location: ${counterRef.nodeId}`);
  }
}

async function watchCounter(name: string | undefined): Promise<void> {
  if (!name) {
    log('Usage: /watch <name>');
    return;
  }

  if (!state.watcherRef) {
    log('Watcher not initialized.');
    return;
  }

  const counterRef = GlobalRegistry.whereis(`counter:${name}`);
  if (!counterRef) {
    log(`Counter "${name}" not found.`);
    return;
  }

  // Check if already watching
  if (state.activeMonitors.has(name)) {
    log(`Already watching counter "${name}".`);
    return;
  }

  // Register in watcher state
  const watchResult = await GenServer.call(state.watcherRef, {
    type: 'watch',
    name,
    counterRef,
  });

  if ('ok' in watchResult && watchResult.ok === false) {
    log(watchResult.error);
    return;
  }

  // Set up the actual remote monitor
  try {
    // Create a remote-compatible ref for the counter
    // GenServerRef is a branded type, so we need to cast through unknown
    const remoteCounterRef = {
      id: counterRef.id,
      nodeId: counterRef.nodeId,
    } as unknown as GenServerRef;

    const monitorRef = await RemoteMonitor.monitor(state.watcherRef, remoteCounterRef);
    state.activeMonitors.set(name, monitorRef);

    log(`Now watching counter "${name}" on ${counterRef.nodeId}`);
  } catch (error) {
    // Rollback the watcher state
    await GenServer.call(state.watcherRef, { type: 'unwatch', name });
    throw error;
  }
}

async function unwatchCounter(name: string | undefined): Promise<void> {
  if (!name) {
    log('Usage: /unwatch <name>');
    return;
  }

  if (!state.watcherRef) {
    log('Watcher not initialized.');
    return;
  }

  const monitorRef = state.activeMonitors.get(name);
  if (!monitorRef) {
    log(`Not watching counter "${name}".`);
    return;
  }

  // Remove monitor
  await RemoteMonitor.demonitor(monitorRef);
  state.activeMonitors.delete(name);

  // Update watcher state
  await GenServer.call(state.watcherRef, { type: 'unwatch', name });

  log(`Stopped watching counter "${name}".`);
}

function listCounters(): void {
  const names = GlobalRegistry.getNames();
  const counters = names.filter((n: string) => n.startsWith('counter:'));

  if (counters.length === 0) {
    log('No counters available. Use /create <name> to create one.');
    return;
  }

  log('Available counters:');
  for (const counter of counters) {
    const counterName = counter.slice(8); // Remove 'counter:' prefix
    const ref = GlobalRegistry.whereis(counter);
    const nodeId = ref?.nodeId ?? 'unknown';
    const isWatched = state.activeMonitors.has(counterName);
    console.log(`  - ${counterName} (on ${nodeId})${isWatched ? ' [watched]' : ''}`);
  }
}

function listNodes(): void {
  const localId = Cluster.getLocalNodeId();
  const nodes = Cluster.getNodes();

  log('Connected nodes:');
  console.log(`  - ${localId} (local)`);

  for (const node of nodes) {
    if (node.id !== localId) {
      console.log(`  - ${node.id} (${node.status})`);
    }
  }

  console.log(`\nTotal: ${nodes.length + 1} nodes`);
}

async function quit(): Promise<void> {
  // Demonitor all watched counters
  for (const [name, monitorRef] of state.activeMonitors) {
    try {
      await RemoteMonitor.demonitor(monitorRef);
    } catch {
      // Ignore errors during shutdown
    }
  }
  state.activeMonitors.clear();

  // Stop watcher
  if (state.watcherRef) {
    await GenServer.stop(state.watcherRef);
  }

  log('Disconnecting from cluster...');
  await Cluster.stop();
  process.exit(0);
}

// =============================================================================
// Lifecycle Event Handler
// =============================================================================

function handleLifecycleEvent(event: LifecycleEvent): void {
  if (event.type !== 'process_down') {
    return;
  }

  // Find which counter this monitor was for
  for (const [name, monitorRef] of state.activeMonitors) {
    if (monitorRef.monitorId === event.monitorId) {
      // Notify watcher behavior
      if (state.watcherRef) {
        GenServer.cast(state.watcherRef, {
          type: 'counter_down',
          name,
          reason: event.reason,
        });
      }
      state.activeMonitors.delete(name);
      break;
    }
  }
}

// =============================================================================
// Main
// =============================================================================

const args = parseArgs();

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  Distributed Counter - noex Fault Tolerance Example');
  console.log('='.repeat(60));
  console.log();

  // Register behaviors for remote spawning
  BehaviorRegistry.register(BEHAVIOR_NAMES.COUNTER, counterBehavior);
  BehaviorRegistry.register(BEHAVIOR_NAMES.COUNTER_WATCHER, counterWatcherBehavior);

  // Start cluster
  console.log(`Starting node: ${args.name}@127.0.0.1:${args.port}`);
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

  // Create local watcher for monitoring counters
  const watcherBehavior = createCounterWatcherBehavior();
  state.watcherRef = (await GenServer.start(watcherBehavior)) as WatcherRef;

  // Set up event handler for watcher
  await GenServer.call(state.watcherRef, {
    type: 'set_event_handler',
    handler: handleWatcherEvent,
  });

  // Set up lifecycle event handler for process_down events
  GenServer.onLifecycleEvent(handleLifecycleEvent);

  console.log('Type /help for available commands.');
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
    prompt: '> ',
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
