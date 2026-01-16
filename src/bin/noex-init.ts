#!/usr/bin/env node
/**
 * noex init - Generate a starter template for noex applications.
 *
 * Creates a well-documented starter file with all configuration options
 * shown as comments, making it easy to discover and customize features.
 *
 * @example
 * ```bash
 * # Create starter file in current directory
 * noex init
 *
 * # Create with custom filename
 * noex init --output my-server.ts
 *
 * # Overwrite existing file
 * noex init --force
 * ```
 */

import { parseArgs, type ParseArgsConfig } from 'node:util';
import { writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

// =============================================================================
// Constants
// =============================================================================

const VERSION = '1.0.0';
const DEFAULT_OUTPUT = 'server.ts';

// =============================================================================
// CLI Argument Definition
// =============================================================================

const argsConfig: ParseArgsConfig = {
  options: {
    output: {
      type: 'string',
      short: 'o',
      default: DEFAULT_OUTPUT,
    },
    force: {
      type: 'boolean',
      short: 'f',
      default: false,
    },
    help: {
      type: 'boolean',
      short: 'h',
      default: false,
    },
    version: {
      type: 'boolean',
      short: 'v',
      default: false,
    },
  },
  strict: true,
  allowPositionals: false,
};

// =============================================================================
// Help & Version Output
// =============================================================================

function printHelp(): void {
  const help = `
noex init - Generate a starter template for noex applications

USAGE:
  noex init [OPTIONS]

OPTIONS:
  -o, --output <file>   Output filename (default: ${DEFAULT_OUTPUT})
  -f, --force           Overwrite existing file
  -h, --help            Show this help message
  -v, --version         Show version number

DESCRIPTION:
  Creates a starter TypeScript file with example GenServer, Supervisor,
  and other noex components. All configuration options are documented
  with comments, making it easy to discover available features.

EXAMPLES:
  # Create server.ts in current directory
  noex init

  # Create with custom filename
  noex init --output my-app.ts

  # Overwrite existing file
  noex init --force

For more information, visit: https://github.com/user/noex
`.trim();

  console.log(help);
}

function printVersion(): void {
  console.log(`noex init v${VERSION}`);
}

// =============================================================================
// Template
// =============================================================================

const STARTER_TEMPLATE = `/**
 * noex Starter Template
 *
 * This file demonstrates all major features of noex with documented options.
 * Uncomment sections as needed for your application.
 *
 * Generated with: noex init
 */

import {
  GenServer,
  Supervisor,
  Registry,
  // Persistence adapters (uncomment as needed)
  // FileAdapter,
  // SQLiteAdapter,
  // MemoryAdapter,
  // Services
  // Cache,
  // RateLimiter,
  // EventBus,
  // Dashboard
  // DashboardServer,
  // Cluster (for distributed systems)
  // Cluster,
} from 'noex';

// =============================================================================
// GENSERVER EXAMPLE
// =============================================================================

/**
 * Example GenServer - a stateful server process.
 *
 * GenServer is the core building block. It manages state and handles
 * synchronous (call) and asynchronous (cast) messages.
 */

// Define your state type
interface CounterState {
  count: number;
  lastUpdated: Date;
}

// Define message types for type safety
type CounterCall =
  | { type: 'get' }
  | { type: 'increment'; amount: number };

type CounterCast =
  | { type: 'reset' }
  | { type: 'log' };

// Create the GenServer
const Counter = GenServer.create<CounterState, CounterCall, CounterCast, number>({
  /**
   * Initialize the server state.
   * Called once when the server starts.
   */
  init() {
    return {
      count: 0,
      lastUpdated: new Date(),
    };
  },

  /**
   * Handle synchronous calls (request-response).
   * The caller waits for the reply.
   */
  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return { reply: state.count, newState: state };

      case 'increment':
        const newState = {
          count: state.count + msg.amount,
          lastUpdated: new Date(),
        };
        return { reply: newState.count, newState };
    }
  },

  /**
   * Handle asynchronous casts (fire-and-forget).
   * The caller does not wait for a response.
   */
  handleCast(msg, state) {
    switch (msg.type) {
      case 'reset':
        return { count: 0, lastUpdated: new Date() };

      case 'log':
        console.log(\`Counter state: \${state.count}\`);
        return state;
    }
  },

  /**
   * Called when the server is shutting down.
   * Use for cleanup (close connections, save state, etc.)
   */
  // terminate(reason, state) {
  //   console.log(\`Counter terminating: \${reason}\`);
  // },
});

// =============================================================================
// START OPTIONS
// =============================================================================

async function startCounter() {
  const ref = await Counter.start({
    // Register with a name for easy lookup
    name: 'main-counter',

    // Timeout for init() call (default: 5000ms)
    // initTimeout: 5000,

    // ------------------------------------
    // PERSISTENCE (uncomment to enable)
    // ------------------------------------
    // persistence: {
    //   // Choose an adapter:
    //
    //   // File-based storage (JSON files)
    //   // adapter: new FileAdapter({
    //   //   directory: './data',        // Storage directory (required)
    //   //   extension: '.json',          // File extension (default: '.json')
    //   //   prettyPrint: true,           // Pretty-print JSON (default: false)
    //   //   checksums: true,             // Enable SHA256 checksums (default: true)
    //   //   atomicWrites: true,          // Use atomic writes (default: true)
    //   // }),
    //
    //   // SQLite storage (requires better-sqlite3)
    //   // adapter: new SQLiteAdapter({
    //   //   filename: './data/state.db', // Database file (or ':memory:')
    //   //   tableName: 'noex_state',     // Table name (default: 'noex_state')
    //   //   walMode: true,               // Enable WAL mode (default: true)
    //   // }),
    //
    //   // In-memory storage (for testing)
    //   // adapter: new MemoryAdapter(),
    //
    //   // Custom persistence key (default: server name or auto-generated)
    //   // key: 'my-custom-key',
    //
    //   // Periodic snapshots (disabled if undefined)
    //   // snapshotIntervalMs: 30000,     // Save every 30 seconds
    //
    //   // Save on shutdown (default: true)
    //   // persistOnShutdown: true,
    //
    //   // Restore on start (default: true)
    //   // restoreOnStart: true,
    //
    //   // Reject state older than this (optional)
    //   // maxStateAgeMs: 3600000,        // 1 hour
    //
    //   // Delete state on termination (default: false)
    //   // cleanupOnTerminate: false,
    //
    //   // Schema versioning for migrations
    //   // schemaVersion: 1,
    //   // migrate: (oldState, oldVersion) => {
    //   //   // Transform old state to new format
    //   //   return { ...oldState, newField: 'default' };
    //   // },
    //
    //   // Custom serialization (optional)
    //   // serialize: (state) => ({ ...state, date: state.date.toISOString() }),
    //   // deserialize: (data) => ({ ...data, date: new Date(data.date) }),
    // },
  });

  return ref;
}

// =============================================================================
// SUPERVISOR EXAMPLE
// =============================================================================

/**
 * Supervisor - manages and restarts child processes.
 *
 * Strategies:
 * - 'one_for_one':  Restart only the failed child
 * - 'one_for_all':  Restart all children if one fails
 * - 'rest_for_one': Restart failed child and those started after it
 * - 'simple_one_for_one': Dynamic children from template
 */

async function startSupervisor() {
  const supervisor = await Supervisor.start({
    // Supervisor name for registry lookup
    name: 'main-supervisor',

    // Restart strategy (default: 'one_for_one')
    strategy: 'one_for_one',

    // Static children - started in order, stopped in reverse
    children: [
      {
        id: 'counter',
        start: () => Counter.start({ name: 'supervised-counter' }),

        // Restart policy:
        // - 'permanent': Always restart (default)
        // - 'transient': Restart only on abnormal exit
        // - 'temporary': Never restart
        restart: 'permanent',

        // Shutdown timeout (default: 5000ms)
        shutdownTimeout: 5000,

        // Mark as significant for auto-shutdown (default: false)
        // significant: true,
      },
      // Add more children here...
    ],

    // Restart intensity limits
    restartIntensity: {
      maxRestarts: 3,      // Max restarts allowed
      withinMs: 5000,      // Time window
    },

    // Auto-shutdown based on significant children
    // - 'never':          Never auto-shutdown (default)
    // - 'any_significant': Shutdown if any significant child terminates
    // - 'all_significant': Shutdown if all significant children terminate
    // autoShutdown: 'never',
  });

  return supervisor;
}

// =============================================================================
// SIMPLE_ONE_FOR_ONE - Dynamic Children
// =============================================================================

/**
 * simple_one_for_one supervisor for dynamic worker pools.
 * Children are started with Supervisor.startChild(ref, ...args)
 */

// async function startWorkerPool() {
//   const pool = await Supervisor.start({
//     name: 'worker-pool',
//     strategy: 'simple_one_for_one',
//
//     // Template for dynamic children
//     childTemplate: {
//       start: (workerId: string, config: { maxTasks: number }) =>
//         Worker.start({ name: \`worker-\${workerId}\`, ...config }),
//       restart: 'transient',
//       shutdownTimeout: 10000,
//     },
//   });
//
//   // Start workers dynamically
//   await Supervisor.startChild(pool, 'worker-1', { maxTasks: 10 });
//   await Supervisor.startChild(pool, 'worker-2', { maxTasks: 20 });
//
//   return pool;
// }

// =============================================================================
// SERVICES - Cache, RateLimiter, EventBus
// =============================================================================

// -------------------------
// CACHE - LRU cache service
// -------------------------

// async function startCache() {
//   const cache = await Cache.start({
//     name: 'app-cache',
//
//     // Maximum entries (LRU eviction when exceeded)
//     maxSize: 1000,
//
//     // Default TTL for entries (null = no expiration)
//     defaultTtlMs: 60000,  // 1 minute
//   });
//
//   // Usage:
//   // await Cache.set(cache, 'key', 'value');
//   // await Cache.set(cache, 'key', 'value', { ttlMs: 30000 }); // Custom TTL
//   // const value = await Cache.get(cache, 'key');
//   // await Cache.delete(cache, 'key');
//   // await Cache.clear(cache);
//
//   return cache;
// }

// -------------------------
// RATE LIMITER - Token bucket
// -------------------------

// async function startRateLimiter() {
//   const limiter = await RateLimiter.start({
//     name: 'api-limiter',
//
//     // Max requests in time window
//     maxRequests: 100,
//     windowMs: 60000,  // 1 minute
//   });
//
//   // Usage:
//   // const allowed = await RateLimiter.checkLimit(limiter, 'user-123');
//   // if (!allowed) {
//   //   throw new Error('Rate limit exceeded');
//   // }
//
//   return limiter;
// }

// -------------------------
// EVENT BUS - Pub/Sub
// -------------------------

// async function startEventBus() {
//   const bus = await EventBus.start({
//     name: 'app-events',
//   });
//
//   // Usage:
//   // Subscribe to events
//   // await EventBus.subscribe(bus, 'user:created', async (event) => {
//   //   console.log('New user:', event.data);
//   // });
//
//   // Publish events
//   // await EventBus.publish(bus, 'user:created', { id: 1, name: 'John' });
//
//   return bus;
// }

// =============================================================================
// DASHBOARD - Real-time monitoring
// =============================================================================

// async function startDashboard() {
//   const dashboard = await DashboardServer.start({
//     // TCP port for dashboard connections
//     port: 9876,
//
//     // Listen host (use '0.0.0.0' for remote access)
//     host: '127.0.0.1',
//
//     // Stats polling interval
//     pollingIntervalMs: 500,
//   });
//
//   console.log('Dashboard available at: noex-dashboard --port 9876');
//
//   return dashboard;
// }

// =============================================================================
// CLUSTER - Distributed Systems
// =============================================================================

/**
 * Cluster enables distributed GenServers across multiple nodes.
 * Nodes communicate via TCP with optional authentication.
 */

// async function startCluster() {
//   const cluster = await Cluster.start({
//     // Unique node name (required)
//     // Format: alphanumeric, underscores, hyphens
//     nodeName: 'node1',
//
//     // Listen address
//     host: '0.0.0.0',  // default
//     port: 4369,       // default (Erlang EPMD port)
//
//     // Seed nodes for cluster discovery
//     // Format: "name@host:port"
//     seeds: [
//       // 'node2@192.168.1.102:4369',
//       // 'node3@192.168.1.103:4369',
//     ],
//
//     // Shared secret for cluster authentication (recommended)
//     // clusterSecret: process.env.CLUSTER_SECRET,
//
//     // Heartbeat configuration
//     heartbeatIntervalMs: 5000,    // default
//     heartbeatMissThreshold: 3,    // default
//
//     // Reconnection with exponential backoff
//     reconnectBaseDelayMs: 1000,   // default
//     reconnectMaxDelayMs: 30000,   // default
//   });
//
//   // Remote operations:
//
//   // Spawn on remote node
//   // const remoteRef = await Cluster.spawn(cluster, 'node2', Counter, {
//   //   name: 'remote-counter',
//   //   registration: 'global',  // 'local' | 'global' | 'none'
//   // });
//
//   // Call remote GenServer
//   // const result = await Cluster.call(cluster, remoteRef, { type: 'get' });
//
//   // Cast to remote GenServer
//   // Cluster.cast(cluster, remoteRef, { type: 'reset' });
//
//   // Monitor remote GenServer
//   // const monitorRef = await Cluster.monitor(cluster, remoteRef, (event) => {
//   //   console.log('Remote process event:', event);
//   // });
//
//   return cluster;
// }

// =============================================================================
// REGISTRY - Process Lookup
// =============================================================================

/**
 * Registry is automatically available for named processes.
 * Use Registry.whereis() to look up processes by name.
 */

// const ref = Registry.whereis('main-counter');
// if (ref) {
//   const count = await Counter.call(ref, { type: 'get' });
// }

// List all registered names
// const names = Registry.list();

// =============================================================================
// MAIN APPLICATION
// =============================================================================

async function main() {
  console.log('Starting noex application...');

  // Start supervisor with all children
  const supervisor = await startSupervisor();
  console.log('Supervisor started');

  // Or start standalone GenServer
  // const counter = await startCounter();

  // Start dashboard for monitoring
  // await startDashboard();

  // Start cluster for distributed operations
  // await startCluster();

  // Example: interact with the counter
  const counterRef = Registry.whereis('supervised-counter');
  if (counterRef) {
    // Synchronous call
    const count = await Counter.call(counterRef, { type: 'get' });
    console.log(\`Initial count: \${count}\`);

    // Increment
    const newCount = await Counter.call(counterRef, { type: 'increment', amount: 5 });
    console.log(\`After increment: \${newCount}\`);

    // Asynchronous cast (fire-and-forget)
    Counter.cast(counterRef, { type: 'log' });
  }

  // Handle shutdown
  const shutdown = async () => {
    console.log('\\nShutting down...');
    await Supervisor.stop(supervisor);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('Application running. Press Ctrl+C to stop.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
`;

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;

  try {
    args = parseArgs(argsConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    console.error('Run "noex init --help" for usage information.');
    process.exit(1);
  }

  // Handle --help
  if (args.values['help']) {
    printHelp();
    process.exit(0);
  }

  // Handle --version
  if (args.values['version']) {
    printVersion();
    process.exit(0);
  }

  const output = args.values['output'] as string;
  const force = args.values['force'] as boolean;
  const outputPath = resolve(process.cwd(), output);

  // Check if file exists
  if (!force) {
    try {
      await access(outputPath);
      console.error(`Error: File already exists: ${output}`);
      console.error('Use --force to overwrite.');
      process.exit(1);
    } catch {
      // File doesn't exist, continue
    }
  }

  // Write template
  try {
    await writeFile(outputPath, STARTER_TEMPLATE, 'utf-8');
    console.log(`Created: ${output}`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Review and customize the generated file');
    console.log('  2. Uncomment features you want to use');
    console.log('  3. Run with: npx tsx server.ts (or ts-node)');
    console.log('');
    console.log('Documentation: https://github.com/user/noex');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error writing file: ${message}`);
    process.exit(1);
  }
}

// =============================================================================
// Execute
// =============================================================================

main().catch((error: unknown) => {
  console.error('Unexpected error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
