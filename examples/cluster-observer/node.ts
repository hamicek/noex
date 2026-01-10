/**
 * Cluster Observer Example
 *
 * Demonstrates distributed process monitoring across multiple cluster nodes
 * using noex ClusterObserver. Shows how to:
 *
 * - Start and connect cluster nodes
 * - Monitor local processes with Observer
 * - Aggregate statistics across all nodes with ClusterObserver
 * - Handle node join/leave events
 * - Use periodic polling for dashboard updates
 *
 * Usage:
 *   Terminal 1: npx tsx node.ts --name nodeA --port 4369
 *   Terminal 2: npx tsx node.ts --name nodeB --port 4370 --seed nodeA@127.0.0.1:4369
 *   Terminal 3: npx tsx node.ts --name nodeC --port 4371 --seed nodeA@127.0.0.1:4369
 *
 * @module examples/cluster-observer
 */

import {
  GenServer,
  Supervisor,
  Observer,
  Cluster,
  DashboardServer,
  type NodeInfo,
  type NodeDownReason,
  type DashboardServerRef,
} from 'noex';

import {
  ClusterObserver,
  type ClusterObserverSnapshot,
} from 'noex/distribution';

import { createWorkerBehavior, type WorkerStats } from './shared/worker.js';

// =============================================================================
// CLI Argument Parsing
// =============================================================================

interface CliArgs {
  readonly name: string;
  readonly port: number;
  readonly seeds: readonly string[];
  readonly dashboardPort: number | null;
}

/**
 * Parses command-line arguments for node configuration.
 */
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let name = '';
  let port = 4369;
  let dashboardPort: number | null = null;
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
      case '--dashboard':
      case '-d':
        dashboardPort = parseInt(args[++i] ?? '9876', 10);
        break;
    }
  }

  if (!name) {
    console.error('Usage: npx tsx node.ts --name <name> --port <port> [--seed <node@host:port>] [--dashboard <port>]');
    console.error('');
    console.error('Options:');
    console.error('  --name, -n           Node name (required)');
    console.error('  --port, -p           Cluster port (default: 4369)');
    console.error('  --seed, -s           Seed node to connect to (can be repeated)');
    console.error('  --dashboard, -d      Start DashboardServer on specified port (default: 9876)');
    console.error('');
    console.error('Example:');
    console.error('  Terminal 1: npx tsx node.ts --name nodeA --port 4369 --dashboard 9876');
    console.error('  Terminal 2: npx noex-dashboard   # connects to dashboard server');
    process.exit(1);
  }

  return { name, port, seeds: seeds.filter(Boolean), dashboardPort };
}

// =============================================================================
// Console Output Formatting
// =============================================================================

const SEPARATOR = '='.repeat(60);
const THIN_SEPARATOR = '-'.repeat(60);

/**
 * Formats a timestamp for display.
 */
function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/**
 * Formats bytes as human-readable string.
 */
function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Prints the cluster snapshot to console in a readable format.
 */
function printClusterSnapshot(snapshot: ClusterObserverSnapshot): void {
  const { aggregated, nodes, localNodeId } = snapshot;

  console.log(`\nCluster Overview (${formatTime(snapshot.timestamp)}):`);
  console.log(`  Total nodes: ${aggregated.totalNodeCount}`);
  console.log(`  Connected nodes: ${aggregated.connectedNodeCount}`);
  console.log(`  Total processes: ${aggregated.totalProcessCount}`);
  console.log(`  Total servers: ${aggregated.totalServerCount}`);
  console.log(`  Total supervisors: ${aggregated.totalSupervisorCount}`);
  console.log(`  Total messages: ${aggregated.totalMessages}`);
  console.log(`  Total restarts: ${aggregated.totalRestarts}`);

  console.log('\nPer-node breakdown:');

  for (const node of nodes) {
    const isLocal = node.nodeId === localNodeId;
    const marker = isLocal ? ' (local)' : '';

    if (node.status === 'connected' && node.snapshot !== null) {
      const { snapshot: s } = node;
      console.log(`  ${node.nodeId}${marker}:`);
      console.log(`    Status: ${node.status}`);
      console.log(`    Processes: ${s.processCount}`);
      console.log(`    Messages: ${s.totalMessages}`);
      console.log(`    Restarts: ${s.totalRestarts}`);
      console.log(`    Memory: ${formatBytes(s.memoryStats.heapUsed)}`);
    } else {
      console.log(`  ${node.nodeId}${marker}:`);
      console.log(`    Status: ${node.status}`);
      if (node.error !== undefined) {
        console.log(`    Error: ${node.error}`);
      }
    }
  }
}

// =============================================================================
// Application State
// =============================================================================

interface AppState {
  stopPolling: (() => void) | null;
  supervisor: Awaited<ReturnType<typeof Supervisor.start>> | null;
  dashboardServer: DashboardServerRef | null;
}

const state: AppState = {
  stopPolling: null,
  supervisor: null,
  dashboardServer: null,
};

// =============================================================================
// Local Process Setup
// =============================================================================

/**
 * Creates local supervisor with worker processes for demonstration.
 */
async function createLocalProcesses(nodeName: string): Promise<void> {
  console.log('\nCreating local processes...');

  state.supervisor = await Supervisor.start({
    children: [
      {
        id: 'worker-1',
        start: () => GenServer.start(createWorkerBehavior(`${nodeName}/Worker-1`)),
      },
      {
        id: 'worker-2',
        start: () => GenServer.start(createWorkerBehavior(`${nodeName}/Worker-2`)),
      },
      {
        id: 'worker-3',
        start: () => GenServer.start(createWorkerBehavior(`${nodeName}/Worker-3`)),
      },
    ],
    strategy: 'one_for_one',
    name: `supervisor-${nodeName}`,
  });

  console.log('  Created supervisor with 3 workers');

  // Generate some observable activity
  const children = Supervisor.getChildren(state.supervisor);

  for (const child of children) {
    // Send 10 work messages to each worker
    for (let i = 0; i < 10; i++) {
      GenServer.cast(child.ref, { type: 'work' });
    }
  }

  console.log('  Generated initial activity on workers');
}

// =============================================================================
// Cluster Monitoring
// =============================================================================

/**
 * Sets up cluster-wide monitoring with ClusterObserver.
 */
async function startClusterMonitoring(): Promise<void> {
  console.log(`\n${THIN_SEPARATOR}`);
  console.log('Cluster Observer');
  console.log(THIN_SEPARATOR);

  // Display local snapshot (synchronous)
  const localSnapshot = Observer.getSnapshot();
  console.log('\nLocal snapshot:');
  console.log(`  Processes: ${localSnapshot.processCount}`);
  console.log(`  Servers: ${localSnapshot.servers.length}`);
  console.log(`  Supervisors: ${localSnapshot.supervisors.length}`);
  console.log(`  Total messages: ${localSnapshot.totalMessages}`);

  // Allow cluster to stabilize before first cluster-wide query
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Attempt cluster snapshot (may fail on single node)
  try {
    const clusterSnapshot = await ClusterObserver.getClusterSnapshot();
    printClusterSnapshot(clusterSnapshot);
  } catch {
    console.log('\nCluster snapshot: Single node mode (no remote nodes connected)');
  }

  // Start periodic polling for cluster-wide updates
  state.stopPolling = ClusterObserver.startPolling(5000, (event) => {
    if (event.type === 'cluster_snapshot_update') {
      console.log(`\n${THIN_SEPARATOR}`);
      console.log('Cluster Update');
      console.log(THIN_SEPARATOR);
      printClusterSnapshot(event.snapshot);
    } else if (event.type === 'node_timeout') {
      console.log(`\n[WARN] Node ${event.nodeId} is not responding`);
    } else if (event.type === 'node_error') {
      console.log(`\n[ERROR] Node ${event.nodeId}: ${event.error}`);
    }
  });
}

// =============================================================================
// Dashboard Server
// =============================================================================

/**
 * Starts the DashboardServer for remote TUI connections.
 */
async function startDashboardServer(port: number): Promise<void> {
  try {
    state.dashboardServer = await DashboardServer.start({ port });
    console.log(`  DashboardServer started on port ${port}`);
    console.log(`  Connect with: npx noex-dashboard --port ${port}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  Failed to start DashboardServer: ${message}`);
  }
}

// =============================================================================
// Graceful Shutdown
// =============================================================================

/**
 * Performs graceful shutdown of all resources.
 */
async function shutdown(): Promise<void> {
  console.log('\nShutting down...');

  // Stop dashboard server
  if (state.dashboardServer !== null) {
    await DashboardServer.stop(state.dashboardServer);
    state.dashboardServer = null;
    console.log('  DashboardServer stopped');
  }

  // Stop polling
  if (state.stopPolling !== null) {
    state.stopPolling();
    state.stopPolling = null;
  }

  // Stop supervisor
  if (state.supervisor !== null) {
    await Supervisor.stop(state.supervisor);
    state.supervisor = null;
  }

  // Stop cluster
  await Cluster.stop();

  console.log('Shutdown complete.');
  process.exit(0);
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const config = parseArgs();

  console.log(SEPARATOR);
  console.log('  Cluster Observer Example');
  console.log(SEPARATOR);
  console.log('');

  // 1. Start the cluster node
  const nodeId = `${config.name}@127.0.0.1:${config.port}`;
  console.log(`Starting node: ${nodeId}`);

  await Cluster.start({
    nodeName: config.name,
    port: config.port,
    seeds: config.seeds as string[],
  });

  console.log(`Node ID: ${Cluster.getLocalNodeId()}`);

  // 2. Set up cluster event handlers
  Cluster.onNodeUp((node: NodeInfo) => {
    console.log(`\n[CLUSTER] Node joined: ${node.id}`);
  });

  Cluster.onNodeDown((nodeId: string, reason: NodeDownReason) => {
    console.log(`\n[CLUSTER] Node left: ${nodeId} (${reason})`);
  });

  // 3. Create local processes for demonstration
  await createLocalProcesses(config.name);

  // 4. Start DashboardServer if requested
  if (config.dashboardPort !== null) {
    await startDashboardServer(config.dashboardPort);
  }

  // 5. Start cluster-wide monitoring (console output)
  await startClusterMonitoring();

  console.log(`\n${SEPARATOR}`);
  console.log('Node is running. Press Ctrl+C to exit.');
  console.log(SEPARATOR);

  // 6. Set up graceful shutdown handlers
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// =============================================================================
// Run
// =============================================================================

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
