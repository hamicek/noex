/**
 * Supervision Tree Example - Interactive Demo
 *
 * This example demonstrates a hierarchical supervision tree with multiple
 * GenServers organized under nested Supervisors. It simulates a simple
 * e-commerce system with:
 *
 * ApplicationSupervisor (root, one_for_one)
 * ├── Logger (GenServer) - centralized logging
 * └── ServicesSupervisor (one_for_one)
 *     ├── UserService (GenServer) - user management
 *     ├── OrderService (GenServer) - order processing
 *     └── NotificationService (GenServer) - notifications
 *
 * The example shows:
 * - How to build a supervision tree
 * - Communication between GenServers
 * - Automatic restart on crash
 * - Real-time Observer statistics
 * - Interactive console commands
 */

import * as readline from 'readline';
import {
  GenServer,
  Supervisor,
  Observer,
  type GenServerBehavior,
  type GenServerRef,
  type SupervisorRef,
  type ChildSpec,
} from '../../dist/index.js';

// ============================================================================
// Types
// ============================================================================

interface LogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

interface User {
  id: string;
  name: string;
  email: string;
}

interface Order {
  id: string;
  userId: string;
  items: string[];
  status: 'pending' | 'confirmed' | 'shipped';
}

interface Notification {
  id: string;
  userId: string;
  message: string;
  sent: boolean;
}

// ============================================================================
// Logger GenServer
// ============================================================================

interface LoggerState {
  logs: LogEntry[];
  maxLogs: number;
}

type LoggerCall =
  | { type: 'get_logs' }
  | { type: 'get_logs_by_source'; source: string };

type LoggerCast = { type: 'log'; level: 'info' | 'warn' | 'error'; source: string; message: string };

type LoggerReply = LogEntry[];

const loggerBehavior: GenServerBehavior<LoggerState, LoggerCall, LoggerCast, LoggerReply> = {
  init: () => ({ logs: [], maxLogs: 100 }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get_logs':
        return [state.logs, state];
      case 'get_logs_by_source':
        return [state.logs.filter((l) => l.source === msg.source), state];
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'log') {
      const entry: LogEntry = {
        timestamp: new Date(),
        level: msg.level,
        source: msg.source,
        message: msg.message,
      };

      // Keep only last maxLogs entries
      const logs = [...state.logs, entry].slice(-state.maxLogs);
      return { ...state, logs };
    }
    return state;
  },

  terminate: (_reason, state) => {
    log('system', 'info', `Logger shutting down with ${state.logs.length} log entries`);
  },
};

// ============================================================================
// UserService GenServer
// ============================================================================

interface UserServiceState {
  users: Map<string, User>;
  loggerRef: GenServerRef<LoggerState, LoggerCall, LoggerCast, LoggerReply> | null;
}

type UserServiceCall =
  | { type: 'get_user'; id: string }
  | { type: 'list_users' }
  | { type: 'create_user'; name: string; email: string };

type UserServiceCast =
  | { type: 'set_logger'; ref: GenServerRef<LoggerState, LoggerCall, LoggerCast, LoggerReply> }
  | { type: 'simulate_crash' };

type UserServiceReply = User | User[] | null;

const userServiceBehavior: GenServerBehavior<
  UserServiceState,
  UserServiceCall,
  UserServiceCast,
  UserServiceReply
> = {
  init: () => ({ users: new Map(), loggerRef: null }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get_user':
        return [state.users.get(msg.id) ?? null, state];

      case 'list_users':
        return [Array.from(state.users.values()), state];

      case 'create_user': {
        const id = `user_${Date.now()}`;
        const user: User = { id, name: msg.name, email: msg.email };
        const newUsers = new Map(state.users);
        newUsers.set(id, user);

        if (state.loggerRef) {
          GenServer.cast(state.loggerRef, {
            type: 'log',
            level: 'info',
            source: 'UserService',
            message: `Created user: ${user.name} (${user.email})`,
          });
        }

        return [user, { ...state, users: newUsers }];
      }
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'set_logger':
        return { ...state, loggerRef: msg.ref };

      case 'simulate_crash':
        throw new Error('Simulated UserService crash!');
    }
    return state;
  },

  terminate: () => {
    log('system', 'info', 'UserService shutting down');
  },
};

// ============================================================================
// OrderService GenServer
// ============================================================================

interface OrderServiceState {
  orders: Map<string, Order>;
  loggerRef: GenServerRef<LoggerState, LoggerCall, LoggerCast, LoggerReply> | null;
  notificationRef: GenServerRef<
    NotificationServiceState,
    NotificationServiceCall,
    NotificationServiceCast,
    NotificationServiceReply
  > | null;
}

type OrderServiceCall =
  | { type: 'get_order'; id: string }
  | { type: 'list_orders' }
  | { type: 'create_order'; userId: string; items: string[] }
  | { type: 'confirm_order'; id: string };

type OrderServiceCast =
  | {
      type: 'set_dependencies';
      loggerRef: GenServerRef<LoggerState, LoggerCall, LoggerCast, LoggerReply>;
      notificationRef: GenServerRef<
        NotificationServiceState,
        NotificationServiceCall,
        NotificationServiceCast,
        NotificationServiceReply
      >;
    }
  | { type: 'simulate_crash' };

type OrderServiceReply = Order | Order[] | null;

const orderServiceBehavior: GenServerBehavior<
  OrderServiceState,
  OrderServiceCall,
  OrderServiceCast,
  OrderServiceReply
> = {
  init: () => ({ orders: new Map(), loggerRef: null, notificationRef: null }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get_order':
        return [state.orders.get(msg.id) ?? null, state];

      case 'list_orders':
        return [Array.from(state.orders.values()), state];

      case 'create_order': {
        const id = `order_${Date.now()}`;
        const order: Order = {
          id,
          userId: msg.userId,
          items: msg.items,
          status: 'pending',
        };
        const newOrders = new Map(state.orders);
        newOrders.set(id, order);

        if (state.loggerRef) {
          GenServer.cast(state.loggerRef, {
            type: 'log',
            level: 'info',
            source: 'OrderService',
            message: `Created order ${id} for user ${msg.userId}`,
          });
        }

        return [order, { ...state, orders: newOrders }];
      }

      case 'confirm_order': {
        const order = state.orders.get(msg.id);
        if (!order) return [null, state];

        const confirmedOrder: Order = { ...order, status: 'confirmed' };
        const newOrders = new Map(state.orders);
        newOrders.set(msg.id, confirmedOrder);

        if (state.loggerRef) {
          GenServer.cast(state.loggerRef, {
            type: 'log',
            level: 'info',
            source: 'OrderService',
            message: `Confirmed order ${msg.id}`,
          });
        }

        if (state.notificationRef) {
          GenServer.cast(state.notificationRef, {
            type: 'send',
            userId: order.userId,
            message: `Your order ${msg.id} has been confirmed!`,
          });
        }

        return [confirmedOrder, { ...state, orders: newOrders }];
      }
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'set_dependencies':
        return {
          ...state,
          loggerRef: msg.loggerRef,
          notificationRef: msg.notificationRef,
        };

      case 'simulate_crash':
        throw new Error('Simulated OrderService crash!');
    }
    return state;
  },

  terminate: () => {
    log('system', 'info', 'OrderService shutting down');
  },
};

// ============================================================================
// NotificationService GenServer
// ============================================================================

interface NotificationServiceState {
  notifications: Notification[];
  loggerRef: GenServerRef<LoggerState, LoggerCall, LoggerCast, LoggerReply> | null;
}

type NotificationServiceCall =
  | { type: 'get_notifications'; userId: string }
  | { type: 'get_all' };

type NotificationServiceCast =
  | { type: 'send'; userId: string; message: string }
  | { type: 'set_logger'; ref: GenServerRef<LoggerState, LoggerCall, LoggerCast, LoggerReply> }
  | { type: 'simulate_crash' };

type NotificationServiceReply = Notification[];

const notificationServiceBehavior: GenServerBehavior<
  NotificationServiceState,
  NotificationServiceCall,
  NotificationServiceCast,
  NotificationServiceReply
> = {
  init: () => ({ notifications: [], loggerRef: null }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get_notifications':
        return [state.notifications.filter((n) => n.userId === msg.userId), state];

      case 'get_all':
        return [state.notifications, state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'send': {
        const notification: Notification = {
          id: `notif_${Date.now()}`,
          userId: msg.userId,
          message: msg.message,
          sent: true,
        };

        if (state.loggerRef) {
          GenServer.cast(state.loggerRef, {
            type: 'log',
            level: 'info',
            source: 'NotificationService',
            message: `Sent notification to ${msg.userId}: ${msg.message}`,
          });
        }

        return { ...state, notifications: [...state.notifications, notification] };
      }

      case 'set_logger':
        return { ...state, loggerRef: msg.ref };

      case 'simulate_crash':
        throw new Error('Simulated NotificationService crash!');
    }
    return state;
  },

  terminate: () => {
    log('system', 'info', 'NotificationService shutting down');
  },
};

// ============================================================================
// Global State
// ============================================================================

interface ServiceRefs {
  logger: GenServerRef<LoggerState, LoggerCall, LoggerCast, LoggerReply>;
  userService: GenServerRef<UserServiceState, UserServiceCall, UserServiceCast, UserServiceReply>;
  orderService: GenServerRef<OrderServiceState, OrderServiceCall, OrderServiceCast, OrderServiceReply>;
  notificationService: GenServerRef<
    NotificationServiceState,
    NotificationServiceCall,
    NotificationServiceCast,
    NotificationServiceReply
  >;
}

let serviceRefs: ServiceRefs | null = null;
let servicesSupervisor: SupervisorRef | null = null;
let appSupervisor: SupervisorRef | null = null;
let observerInterval: ReturnType<typeof setInterval> | null = null;

// Simple console logging (bypasses the GenServer logger for system messages)
function log(source: string, level: 'info' | 'warn' | 'error', message: string): void {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
  const prefix = level === 'error' ? '\x1b[31m[ERR]\x1b[0m' : level === 'warn' ? '\x1b[33m[WRN]\x1b[0m' : '\x1b[32m[INF]\x1b[0m';
  console.log(`${timestamp} ${prefix} [${source}] ${message}`);
}

// ============================================================================
// Supervision Tree Setup
// ============================================================================

async function startSupervisionTree(): Promise<void> {
  log('system', 'info', 'Starting Supervision Tree...');

  // Start Logger first
  const loggerRef = await GenServer.start(loggerBehavior);

  // Create child specs for services supervisor
  const servicesChildren: ChildSpec[] = [
    {
      id: 'user-service',
      start: () => GenServer.start(userServiceBehavior),
      restart: 'permanent',
    },
    {
      id: 'notification-service',
      start: () => GenServer.start(notificationServiceBehavior),
      restart: 'permanent',
    },
    {
      id: 'order-service',
      start: () => GenServer.start(orderServiceBehavior),
      restart: 'permanent',
    },
  ];

  // Start Services Supervisor
  servicesSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: servicesChildren,
    restartIntensity: { maxRestarts: 5, withinMs: 10000 },
  });

  // Get references to started services
  const children = Supervisor.getChildren(servicesSupervisor);
  const userServiceRef = children.find((c) => c.id === 'user-service')!.ref as GenServerRef<
    UserServiceState,
    UserServiceCall,
    UserServiceCast,
    UserServiceReply
  >;
  const notificationRef = children.find((c) => c.id === 'notification-service')!.ref as GenServerRef<
    NotificationServiceState,
    NotificationServiceCall,
    NotificationServiceCast,
    NotificationServiceReply
  >;
  const orderServiceRef = children.find((c) => c.id === 'order-service')!.ref as GenServerRef<
    OrderServiceState,
    OrderServiceCall,
    OrderServiceCast,
    OrderServiceReply
  >;

  // Wire up dependencies
  GenServer.cast(userServiceRef, { type: 'set_logger', ref: loggerRef });
  GenServer.cast(notificationRef, { type: 'set_logger', ref: loggerRef });
  GenServer.cast(orderServiceRef, {
    type: 'set_dependencies',
    loggerRef,
    notificationRef,
  });

  // Create root supervisor
  appSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 3, withinMs: 5000 },
  });

  serviceRefs = {
    logger: loggerRef,
    userService: userServiceRef,
    orderService: orderServiceRef,
    notificationService: notificationRef,
  };

  log('system', 'info', 'Supervision Tree started successfully!');
}

// ============================================================================
// Observer Display
// ============================================================================

function displayObserverStats(): void {
  const snapshot = Observer.getSnapshot();

  console.log('\n\x1b[36m' + '═'.repeat(60) + '\x1b[0m');
  console.log('\x1b[36m  OBSERVER SNAPSHOT\x1b[0m');
  console.log('\x1b[36m' + '═'.repeat(60) + '\x1b[0m');

  console.log(`\n  Processes: ${snapshot.processCount} | Messages: ${snapshot.totalMessages} | Restarts: ${snapshot.totalRestarts}`);

  console.log('\n  \x1b[33mGenServers:\x1b[0m');
  for (const gs of snapshot.servers) {
    const status = gs.status === 'running' ? '\x1b[32m●\x1b[0m' : '\x1b[31m●\x1b[0m';
    console.log(`    ${status} ${gs.id.substring(0, 30).padEnd(30)} | msgs: ${gs.messageCount.toString().padStart(4)} | queue: ${gs.queueSize}`);
  }

  console.log('\n  \x1b[33mSupervisors:\x1b[0m');
  for (const sup of snapshot.supervisors) {
    console.log(`    ${sup.id.substring(0, 30).padEnd(30)} | strategy: ${sup.strategy.padEnd(12)} | children: ${sup.childCount} | restarts: ${sup.totalRestarts}`);
  }

  console.log('\n\x1b[36m' + '═'.repeat(60) + '\x1b[0m\n');
}

function displayProcessTree(): void {
  const tree = Observer.getProcessTree();

  console.log('\n\x1b[35m  PROCESS TREE\x1b[0m');
  console.log('\x1b[35m' + '─'.repeat(40) + '\x1b[0m');

  function printNode(node: typeof tree[0], prefix: string = '', isLast: boolean = true): void {
    const connector = isLast ? '└── ' : '├── ';
    const icon = node.type === 'supervisor' ? '\x1b[33m[SUP]\x1b[0m' : '\x1b[32m[GEN]\x1b[0m';
    console.log(`  ${prefix}${connector}${icon} ${node.id}`);

    if (node.children) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      node.children.forEach((child, index) => {
        printNode(child, childPrefix, index === node.children!.length - 1);
      });
    }
  }

  tree.forEach((node, index) => {
    printNode(node, '', index === tree.length - 1);
  });

  console.log('');
}

function displayHelp(): void {
  console.log(`
\x1b[36mAvailable Commands:\x1b[0m
  \x1b[33mstatus\x1b[0m, \x1b[33ms\x1b[0m       - Show Observer statistics
  \x1b[33mtree\x1b[0m, \x1b[33mt\x1b[0m         - Show process tree
  \x1b[33muser <name>\x1b[0m     - Create a new user
  \x1b[33morder <userId>\x1b[0m  - Create an order for user
  \x1b[33mcrash <service>\x1b[0m - Simulate a crash (user/order/notification)
  \x1b[33mlogs\x1b[0m            - Show recent log entries
  \x1b[33mauto [on|off]\x1b[0m   - Toggle auto Observer refresh (every 5s)
  \x1b[33mhelp\x1b[0m, \x1b[33mh\x1b[0m         - Show this help
  \x1b[33mquit\x1b[0m, \x1b[33mq\x1b[0m         - Exit the application
`);
}

// ============================================================================
// Command Handlers
// ============================================================================

async function handleCommand(input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const args = parts.slice(1);

  if (!serviceRefs || !servicesSupervisor) {
    log('system', 'error', 'Services not initialized');
    return true;
  }

  switch (command) {
    case 'status':
    case 's':
      displayObserverStats();
      break;

    case 'tree':
    case 't':
      displayProcessTree();
      break;

    case 'user': {
      const name = args[0] || `User${Date.now() % 1000}`;
      const email = `${name.toLowerCase()}@example.com`;
      try {
        const user = await GenServer.call(serviceRefs.userService, {
          type: 'create_user',
          name,
          email,
        });
        log('command', 'info', `Created user: ${(user as User).name} (${(user as User).id})`);
      } catch (err) {
        log('command', 'error', `Failed to create user: ${err}`);
        await refreshServiceRefs();
      }
      break;
    }

    case 'order': {
      const userId = args[0];
      if (!userId) {
        log('command', 'warn', 'Usage: order <userId>');
        break;
      }
      try {
        const order = await GenServer.call(serviceRefs.orderService, {
          type: 'create_order',
          userId,
          items: ['Widget', 'Gadget'],
        });
        if (order) {
          log('command', 'info', `Created order: ${(order as Order).id}`);
          // Auto-confirm
          await GenServer.call(serviceRefs.orderService, {
            type: 'confirm_order',
            id: (order as Order).id,
          });
          log('command', 'info', `Confirmed order: ${(order as Order).id}`);
        }
      } catch (err) {
        log('command', 'error', `Failed to create order: ${err}`);
        await refreshServiceRefs();
      }
      break;
    }

    case 'crash': {
      const service = args[0]?.toLowerCase();
      if (!service || !['user', 'order', 'notification'].includes(service)) {
        log('command', 'warn', 'Usage: crash <user|order|notification>');
        break;
      }

      log('command', 'warn', `Crashing ${service} service...`);

      try {
        switch (service) {
          case 'user':
            GenServer.cast(serviceRefs.userService, { type: 'simulate_crash' });
            break;
          case 'order':
            GenServer.cast(serviceRefs.orderService, { type: 'simulate_crash' });
            break;
          case 'notification':
            GenServer.cast(serviceRefs.notificationService, { type: 'simulate_crash' });
            break;
        }

        // Wait for restart and refresh refs
        await sleep(300);
        await refreshServiceRefs();
        log('command', 'info', `${service} service restarted automatically`);
      } catch (err) {
        log('command', 'error', `Error: ${err}`);
      }
      break;
    }

    case 'logs': {
      try {
        const logs = await GenServer.call(serviceRefs.logger, { type: 'get_logs' }) as LogEntry[];
        console.log('\n\x1b[35m  RECENT LOGS\x1b[0m');
        console.log('\x1b[35m' + '─'.repeat(60) + '\x1b[0m');
        const recentLogs = logs.slice(-10);
        for (const entry of recentLogs) {
          const time = entry.timestamp.toISOString().split('T')[1].slice(0, 8);
          console.log(`  ${time} [${entry.source}] ${entry.message}`);
        }
        console.log('');
      } catch (err) {
        log('command', 'error', `Failed to get logs: ${err}`);
      }
      break;
    }

    case 'auto': {
      const mode = args[0]?.toLowerCase();
      if (mode === 'on') {
        if (!observerInterval) {
          observerInterval = setInterval(() => {
            displayObserverStats();
          }, 5000);
          log('command', 'info', 'Auto Observer refresh enabled (every 5s)');
        }
      } else if (mode === 'off') {
        if (observerInterval) {
          clearInterval(observerInterval);
          observerInterval = null;
          log('command', 'info', 'Auto Observer refresh disabled');
        }
      } else {
        log('command', 'info', `Auto refresh is ${observerInterval ? 'ON' : 'OFF'}. Usage: auto [on|off]`);
      }
      break;
    }

    case 'help':
    case 'h':
      displayHelp();
      break;

    case 'quit':
    case 'q':
    case 'exit':
      return false;

    case '':
      break;

    default:
      log('command', 'warn', `Unknown command: ${command}. Type 'help' for available commands.`);
  }

  return true;
}

async function refreshServiceRefs(): Promise<void> {
  if (!servicesSupervisor || !serviceRefs) return;

  const children = Supervisor.getChildren(servicesSupervisor);

  const userServiceRef = children.find((c) => c.id === 'user-service')?.ref as GenServerRef<
    UserServiceState,
    UserServiceCall,
    UserServiceCast,
    UserServiceReply
  > | undefined;

  const notificationRef = children.find((c) => c.id === 'notification-service')?.ref as GenServerRef<
    NotificationServiceState,
    NotificationServiceCall,
    NotificationServiceCast,
    NotificationServiceReply
  > | undefined;

  const orderServiceRef = children.find((c) => c.id === 'order-service')?.ref as GenServerRef<
    OrderServiceState,
    OrderServiceCall,
    OrderServiceCast,
    OrderServiceReply
  > | undefined;

  if (userServiceRef) {
    serviceRefs.userService = userServiceRef;
    GenServer.cast(userServiceRef, { type: 'set_logger', ref: serviceRefs.logger });
  }

  if (notificationRef) {
    serviceRefs.notificationService = notificationRef;
    GenServer.cast(notificationRef, { type: 'set_logger', ref: serviceRefs.logger });
  }

  if (orderServiceRef && notificationRef) {
    serviceRefs.orderService = orderServiceRef;
    GenServer.cast(orderServiceRef, {
      type: 'set_dependencies',
      loggerRef: serviceRefs.logger,
      notificationRef,
    });
  }
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

async function shutdown(): Promise<void> {
  log('system', 'info', 'Initiating graceful shutdown...');

  if (observerInterval) {
    clearInterval(observerInterval);
  }

  if (servicesSupervisor) {
    await Supervisor.stop(servicesSupervisor);
    log('system', 'info', 'ServicesSupervisor stopped');
  }

  if (serviceRefs?.logger) {
    await GenServer.stop(serviceRefs.logger);
    log('system', 'info', 'Logger stopped');
  }

  if (appSupervisor) {
    await Supervisor.stop(appSupervisor);
    log('system', 'info', 'ApplicationSupervisor stopped');
  }

  log('system', 'info', 'Shutdown complete');
}

// ============================================================================
// Main
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('\x1b[36m' + '═'.repeat(60) + '\x1b[0m');
  console.log('\x1b[36m  Supervision Tree Demo - Interactive Mode\x1b[0m');
  console.log('\x1b[36m' + '═'.repeat(60) + '\x1b[0m');

  try {
    await startSupervisionTree();

    // Show initial status
    displayObserverStats();
    displayHelp();

    // Setup readline for interactive input
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.setPrompt('\x1b[33mnoex>\x1b[0m ');
    rl.prompt();

    rl.on('line', async (line) => {
      const shouldContinue = await handleCommand(line);
      if (!shouldContinue) {
        rl.close();
        return;
      }
      rl.prompt();
    });

    rl.on('close', async () => {
      await shutdown();
      process.exit(0);
    });

    // Handle Ctrl+C
    process.on('SIGINT', async () => {
      console.log('\n');
      rl.close();
    });

  } catch (error) {
    log('system', 'error', `Fatal error: ${error}`);
    process.exit(1);
  }
}

main();
