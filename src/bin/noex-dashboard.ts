#!/usr/bin/env node
/**
 * noex-dashboard - Remote TUI client for noex DashboardServer.
 *
 * Connects to a running noex application's DashboardServer and displays
 * a real-time terminal UI for monitoring GenServers and Supervisors.
 *
 * @example
 * ```bash
 * # Connect to localhost on default port
 * noex-dashboard
 *
 * # Connect to specific host and port
 * noex-dashboard --host 192.168.1.100 --port 9876
 *
 * # Use compact layout with light theme
 * noex-dashboard -l compact -t light
 * ```
 */

import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { DashboardLayout } from '../dashboard/types.js';

// =============================================================================
// Dependency Check
// =============================================================================

/**
 * Verifies that required optional dependencies are installed.
 * blessed and blessed-contrib are optional deps used for TUI rendering.
 */
async function checkDependencies(): Promise<void> {
  const missing: string[] = [];

  try {
    await import('blessed');
  } catch {
    missing.push('blessed');
  }

  try {
    await import('blessed-contrib');
  } catch {
    missing.push('blessed-contrib');
  }

  if (missing.length > 0) {
    console.error('Error: Missing required dependencies for TUI dashboard.\n');
    console.error('The following packages need to be installed:');
    for (const pkg of missing) {
      console.error(`  - ${pkg}`);
    }
    console.error('\nInstall them with:');
    console.error(`  npm install ${missing.join(' ')}`);
    console.error('\nOr install all optional dependencies:');
    console.error('  npm install blessed blessed-contrib');
    process.exit(1);
  }
}

// =============================================================================
// Constants
// =============================================================================

const VERSION = '1.0.0';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9876;

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
    theme: {
      type: 'string',
      short: 't',
      default: 'dark',
    },
    layout: {
      type: 'string',
      short: 'l',
      default: 'full',
    },
    'no-reconnect': {
      type: 'boolean',
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
noex-dashboard - Remote TUI client for noex DashboardServer

USAGE:
  noex-dashboard [OPTIONS]

OPTIONS:
  -H, --host <address>    Server host address (default: ${DEFAULT_HOST})
  -p, --port <number>     Server port (default: ${DEFAULT_PORT})
  -t, --theme <name>      Color theme: dark, light (default: dark)
  -l, --layout <name>     Layout mode: full, compact, minimal (default: full)
      --no-reconnect      Disable automatic reconnection
  -h, --help              Show this help message
  -v, --version           Show version number

KEYBOARD SHORTCUTS (in dashboard):
  q, Escape, Ctrl+C       Quit client
  r                       Request data refresh
  ?, h                    Show help
  Tab / Shift+Tab         Navigate widgets
  Enter                   Show process detail
  1, 2, 3                 Switch layout (full/compact/minimal)

EXAMPLES:
  # Connect to localhost on default port
  noex-dashboard

  # Connect to remote server
  noex-dashboard --host 192.168.1.100 --port 9876

  # Use compact layout with light theme
  noex-dashboard -l compact -t light

For more information, visit: https://github.com/your-org/noex
`.trim();

  console.log(help);
}

function printVersion(): void {
  console.log(`noex-dashboard v${VERSION}`);
}

// =============================================================================
// Argument Validation
// =============================================================================

interface ValidatedArgs {
  host: string;
  port: number;
  theme: 'dark' | 'light';
  layout: DashboardLayout;
  autoReconnect: boolean;
}

function validateArgs(values: ReturnType<typeof parseArgs>['values']): ValidatedArgs {
  const errors: string[] = [];

  // Validate host
  const host = values['host'] as string;
  if (!host || host.trim() === '') {
    errors.push('Host address cannot be empty');
  }

  // Validate port
  const portStr = values['port'] as string;
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    errors.push(`Invalid port number: ${portStr}. Must be between 1 and 65535.`);
  }

  // Validate theme
  const theme = values['theme'] as string;
  if (theme !== 'dark' && theme !== 'light') {
    errors.push(`Invalid theme: ${theme}. Must be 'dark' or 'light'.`);
  }

  // Validate layout
  const layout = values['layout'] as string;
  if (layout !== 'full' && layout !== 'compact' && layout !== 'minimal') {
    errors.push(`Invalid layout: ${layout}. Must be 'full', 'compact', or 'minimal'.`);
  }

  if (errors.length > 0) {
    console.error('Error: Invalid arguments\n');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    console.error('\nRun "noex-dashboard --help" for usage information.');
    process.exit(1);
  }

  return {
    host,
    port,
    theme: theme as 'dark' | 'light',
    layout: layout as DashboardLayout,
    autoReconnect: !values['no-reconnect'],
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
    console.error('Run "noex-dashboard --help" for usage information.');
    process.exit(1);
  }

  // Handle --help (no dependency check needed)
  if (args.values['help']) {
    printHelp();
    process.exit(0);
  }

  // Handle --version (no dependency check needed)
  if (args.values['version']) {
    printVersion();
    process.exit(0);
  }

  // Check dependencies before attempting to use the TUI
  await checkDependencies();

  const validated = validateArgs(args.values);

  // Dynamic import of DashboardClient (after dependency check)
  const { DashboardClient } = await import('../dashboard/client/index.js');

  // Create and start client
  const client = new DashboardClient({
    host: validated.host,
    port: validated.port,
    theme: validated.theme,
    layout: validated.layout,
    autoReconnect: validated.autoReconnect,
  });

  // Handle process signals for clean shutdown
  const shutdown = (): void => {
    client.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await client.start();
  } catch (error) {
    // If autoReconnect is enabled, the client will keep trying
    // If disabled, we need to handle the error
    if (!validated.autoReconnect) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to connect: ${message}`);
      process.exit(1);
    }
  }
}

// =============================================================================
// Execute
// =============================================================================

main().catch((error: unknown) => {
  console.error('Unexpected error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
