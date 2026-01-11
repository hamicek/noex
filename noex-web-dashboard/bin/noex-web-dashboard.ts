#!/usr/bin/env node
/**
 * noex-web-dashboard - Web-based dashboard for monitoring noex applications.
 *
 * Launches a bridge server that connects to a noex DashboardServer via TCP
 * and serves a Svelte-based web interface for browser clients.
 *
 * @example
 * ```bash
 * # Connect to localhost DashboardServer on default ports
 * noex-web-dashboard
 *
 * # Connect to specific DashboardServer
 * noex-web-dashboard --host 192.168.1.100 --port 9876
 *
 * # Use custom web port and auto-open browser
 * noex-web-dashboard --web-port 8080 --open
 * ```
 *
 * @module bin/noex-web-dashboard
 */

import { parseArgs, type ParseArgsConfig } from 'node:util';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep } from 'node:path';

// =============================================================================
// Constants
// =============================================================================

const VERSION = '0.1.0';
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 9876;
const DEFAULT_WEB_PORT = 7210;

// Resolve static path relative to this file's location
// Handles both development (bin/) and production (dist/bin/) paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isCompiledMode = __dirname.includes(`${sep}dist${sep}`) || __dirname.endsWith(`${sep}dist`);
const DEFAULT_STATIC_PATH = resolve(__dirname, isCompiledMode ? '../client' : '../dist/client');

// =============================================================================
// CLI Argument Definition
// =============================================================================

const argsConfig: ParseArgsConfig = {
  options: {
    host: {
      type: 'string',
      short: 'H',
      default: DEFAULT_HOST,
    },
    port: {
      type: 'string',
      short: 'p',
      default: String(DEFAULT_PORT),
    },
    'web-port': {
      type: 'string',
      short: 'w',
      default: String(DEFAULT_WEB_PORT),
    },
    'static-path': {
      type: 'string',
      short: 's',
    },
    open: {
      type: 'boolean',
      short: 'o',
      default: false,
    },
    quiet: {
      type: 'boolean',
      short: 'q',
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
noex-web-dashboard - Web-based dashboard for monitoring noex applications

USAGE:
  noex-web-dashboard [OPTIONS]

OPTIONS:
  -H, --host <address>      DashboardServer host (default: ${DEFAULT_HOST})
  -p, --port <number>       DashboardServer TCP port (default: ${DEFAULT_PORT})
  -w, --web-port <number>   Web server HTTP port (default: ${DEFAULT_WEB_PORT})
  -s, --static-path <path>  Path to built Svelte SPA (default: ./dist/client)
  -o, --open                Open browser automatically after server starts
  -q, --quiet               Suppress non-essential output
  -h, --help                Show this help message
  -v, --version             Show version number

ARCHITECTURE:
  ┌─────────────────────────────────────────────────────────────┐
  │                    noex-web-dashboard                       │
  │  ┌─────────────────┐      ┌──────────────────────────────┐  │
  │  │ DashboardServer │<────>│        Bridge Server         │  │
  │  │   (TCP :${String(DEFAULT_PORT).padEnd(5)})   │      │  ┌────────┐  ┌─────────┐  │  │
  │  └─────────────────┘      │  │  TCP   │──│WebSocket│<──┼──┤ Browsers
  │                           │  │ Bridge │  │ Handler │  │  │
  │                           │  └────────┘  └─────────┘  │  │
  │                           │  ┌───────────────────────┐│  │
  │                           │  │ Static Server (HTTP)  │├──┤ HTTP
  │                           │  └───────────────────────┘│  │
  │                           └──────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────┘

EXAMPLES:
  # Start with defaults (connects to localhost:9876, serves on :3000)
  noex-web-dashboard

  # Connect to remote DashboardServer
  noex-web-dashboard --host 192.168.1.100 --port 9876

  # Use custom web port and auto-open browser
  noex-web-dashboard -w 8080 --open

  # Quiet mode for scripted usage
  noex-web-dashboard -q

For more information, visit: https://github.com/anthropics/noex
`.trim();

  console.log(help);
}

function printVersion(): void {
  console.log(`noex-web-dashboard v${VERSION}`);
}

// =============================================================================
// Argument Validation
// =============================================================================

interface ValidatedArgs {
  readonly host: string;
  readonly port: number;
  readonly webPort: number;
  readonly staticPath: string;
  readonly open: boolean;
  readonly quiet: boolean;
}

function validateArgs(values: ReturnType<typeof parseArgs>['values']): ValidatedArgs {
  const errors: string[] = [];

  // Validate host
  const host = values['host'] as string;
  if (!host || host.trim() === '') {
    errors.push('Host address cannot be empty');
  }

  // Validate DashboardServer port
  const portStr = values['port'] as string;
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    errors.push(`Invalid DashboardServer port: ${portStr}. Must be between 1 and 65535.`);
  }

  // Validate web port
  const webPortStr = values['web-port'] as string;
  const webPort = parseInt(webPortStr, 10);
  if (isNaN(webPort) || webPort < 1 || webPort > 65535) {
    errors.push(`Invalid web port: ${webPortStr}. Must be between 1 and 65535.`);
  }

  // Validate static path (use default if not provided)
  const staticPath = (values['static-path'] as string | undefined) ?? DEFAULT_STATIC_PATH;

  if (errors.length > 0) {
    console.error('Error: Invalid arguments\n');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    console.error('\nRun "noex-web-dashboard --help" for usage information.');
    process.exit(1);
  }

  return {
    host,
    port,
    webPort,
    staticPath,
    open: values['open'] as boolean,
    quiet: values['quiet'] as boolean,
  };
}

// =============================================================================
// Browser Opener
// =============================================================================

/**
 * Opens the given URL in the system's default browser.
 * Uses platform-specific commands for cross-platform compatibility.
 */
async function openBrowser(url: string): Promise<void> {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  const command =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;

  try {
    await execAsync(command);
  } catch {
    // Ignore errors - browser opening is best-effort
  }
}

// =============================================================================
// Logger
// =============================================================================

interface Logger {
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function createLogger(quiet: boolean): Logger {
  const noop = (): void => {};

  if (quiet) {
    return {
      info: noop,
      success: noop,
      warn: (msg) => console.warn(msg),
      error: (msg) => console.error(msg),
    };
  }

  return {
    info: (msg) => console.log(`  ${msg}`),
    success: (msg) => console.log(`✓ ${msg}`),
    warn: (msg) => console.warn(`⚠ ${msg}`),
    error: (msg) => console.error(`✗ ${msg}`),
  };
}

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
    console.error('Run "noex-web-dashboard --help" for usage information.');
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

  const validated = validateArgs(args.values);
  const log = createLogger(validated.quiet);

  // Dynamic import of BridgeServer (allows for better tree-shaking)
  const { BridgeServer } = await import('../src/server/index.js');

  // Create server instance with merged configuration
  const server = new BridgeServer({
    tcp: {
      host: validated.host,
      port: validated.port,
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 30000,
      reconnectBackoffMultiplier: 1.5,
    },
    ws: {
      port: validated.webPort,
      wsPath: '/ws',
    },
    staticPath: validated.staticPath,
  });

  // Register event handlers
  server.onEvent((event) => {
    switch (event.type) {
      case 'starting':
        log.info('Starting noex-web-dashboard...');
        break;

      case 'ready':
        log.success(`Web dashboard ready at ${event.webUrl}`);
        log.info(`Connecting to DashboardServer at ${event.dashboardHost}:${event.dashboardPort}`);
        break;

      case 'tcp':
        switch (event.event.type) {
          case 'connected':
            log.success('Connected to DashboardServer');
            break;
          case 'disconnected':
            log.warn('Disconnected from DashboardServer');
            break;
          case 'reconnecting':
            log.info(`Reconnecting in ${Math.round(event.event.delayMs / 1000)}s...`);
            break;
        }
        break;

      case 'ws':
        switch (event.event.type) {
          case 'client_connected':
            log.info(`Browser client connected (${server.getClientCount()} total)`);
            break;
          case 'client_disconnected':
            log.info(`Browser client disconnected (${server.getClientCount()} total)`);
            break;
        }
        break;

      case 'error':
        log.error(`[${event.source}] ${event.error.message}`);
        break;

      case 'stopping':
        log.info('Shutting down...');
        break;

      case 'stopped':
        log.success('Server stopped');
        break;
    }
  });

  // Enable graceful shutdown on SIGINT/SIGTERM
  server.enableGracefulShutdown();

  // Start server
  try {
    await server.start();

    // Open browser if requested
    if (validated.open) {
      const url = `http://localhost:${validated.webPort}`;
      log.info(`Opening browser at ${url}...`);
      await openBrowser(url);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Failed to start server: ${message}`);
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
