# Tutorial: Building an E-commerce Backend

In this tutorial, you'll build a fault-tolerant e-commerce backend using noex supervision trees. You'll learn how to:
- Design a hierarchical supervision tree
- Create interconnected GenServer services
- Handle service crashes with automatic recovery
- Use the Observer for real-time monitoring

## Prerequisites

- Node.js 18+
- Basic TypeScript knowledge
- Understanding of noex GenServer and Supervisor basics

## Project Setup

Create a new project:

```bash
mkdir ecommerce-backend
cd ecommerce-backend
npm init -y
npm install noex express
npm install -D typescript tsx @types/node @types/express
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

## Architecture Overview

```
                [ApplicationSupervisor]
                /         |          \
         [Logger]  [ServicesSupervisor]  [HTTP Server]
                   /       |        \
           [UserService] [OrderService] [NotificationService]
```

The supervision tree provides:
- **Fault isolation**: One service crash doesn't affect others
- **Automatic recovery**: Crashed services restart automatically
- **Clean dependencies**: Services can communicate with each other
- **Observable state**: Monitor all services in real-time

---

## Step 1: Define Types

Create `src/types.ts`:

```typescript
// User domain
export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

// Order domain
export interface Order {
  id: string;
  userId: string;
  items: OrderItem[];
  status: OrderStatus;
  total: number;
  createdAt: Date;
}

export interface OrderItem {
  productId: string;
  name: string;
  quantity: number;
  price: number;
}

export type OrderStatus = 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';

// Notification domain
export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  message: string;
  read: boolean;
  createdAt: Date;
}

export type NotificationType = 'order_created' | 'order_confirmed' | 'order_shipped' | 'system';

// Log entry
export interface LogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}
```

---

## Step 2: Logger Service

Create `src/services/logger.ts`:

```typescript
import {
  GenServer,
  type GenServerBehavior,
  type GenServerRef,
} from 'noex';
import type { LogEntry } from '../types.js';

// State
interface LoggerState {
  logs: LogEntry[];
  maxLogs: number;
}

// Messages
type LoggerCall =
  | { type: 'get_logs' }
  | { type: 'get_logs_by_source'; source: string }
  | { type: 'get_recent'; count: number };

type LoggerCast = {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
};

type LoggerReply = LogEntry[];

export type LoggerRef = GenServerRef<LoggerState, LoggerCall, LoggerCast, LoggerReply>;

// Behavior
const loggerBehavior: GenServerBehavior<LoggerState, LoggerCall, LoggerCast, LoggerReply> = {
  init: () => ({
    logs: [],
    maxLogs: 1000,
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get_logs':
        return [state.logs, state];

      case 'get_logs_by_source':
        return [state.logs.filter(l => l.source === msg.source), state];

      case 'get_recent':
        return [state.logs.slice(-msg.count), state];
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

      // Console output
      const prefix = msg.level === 'error' ? '\x1b[31m[ERR]\x1b[0m' :
                     msg.level === 'warn' ? '\x1b[33m[WRN]\x1b[0m' :
                     '\x1b[32m[INF]\x1b[0m';
      console.log(`${prefix} [${msg.source}] ${msg.message}`);

      // Keep only last maxLogs entries
      const logs = [...state.logs, entry].slice(-state.maxLogs);
      return { ...state, logs };
    }
    return state;
  },
};

// Public API
export async function startLogger(): Promise<LoggerRef> {
  return GenServer.start(loggerBehavior, { name: 'logger' });
}

export function log(
  ref: LoggerRef,
  level: 'info' | 'warn' | 'error',
  source: string,
  message: string
): void {
  GenServer.cast(ref, { type: 'log', level, source, message });
}

export async function getLogs(ref: LoggerRef): Promise<LogEntry[]> {
  return GenServer.call(ref, { type: 'get_logs' });
}

export async function getRecentLogs(ref: LoggerRef, count: number): Promise<LogEntry[]> {
  return GenServer.call(ref, { type: 'get_recent', count });
}
```

---

## Step 3: User Service

Create `src/services/user-service.ts`:

```typescript
import {
  GenServer,
  type GenServerBehavior,
  type GenServerRef,
} from 'noex';
import type { User } from '../types.js';
import { log, type LoggerRef } from './logger.js';

// State
interface UserServiceState {
  users: Map<string, User>;
  loggerRef: LoggerRef | null;
}

// Messages
type UserCall =
  | { type: 'get'; id: string }
  | { type: 'get_by_email'; email: string }
  | { type: 'list' }
  | { type: 'create'; name: string; email: string };

type UserCast =
  | { type: 'set_logger'; ref: LoggerRef }
  | { type: 'delete'; id: string };

type UserReply = User | User[] | null;

export type UserServiceRef = GenServerRef<UserServiceState, UserCall, UserCast, UserReply>;

// Behavior
const userServiceBehavior: GenServerBehavior<UserServiceState, UserCall, UserCast, UserReply> = {
  init: () => ({
    users: new Map(),
    loggerRef: null,
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.users.get(msg.id) ?? null, state];

      case 'get_by_email': {
        const user = Array.from(state.users.values()).find(u => u.email === msg.email);
        return [user ?? null, state];
      }

      case 'list':
        return [Array.from(state.users.values()), state];

      case 'create': {
        const id = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const user: User = {
          id,
          name: msg.name,
          email: msg.email,
          createdAt: new Date(),
        };

        const users = new Map(state.users);
        users.set(id, user);

        if (state.loggerRef) {
          log(state.loggerRef, 'info', 'UserService', `Created user: ${user.name} (${user.id})`);
        }

        return [user, { ...state, users }];
      }
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'set_logger':
        return { ...state, loggerRef: msg.ref };

      case 'delete': {
        const users = new Map(state.users);
        users.delete(msg.id);

        if (state.loggerRef) {
          log(state.loggerRef, 'info', 'UserService', `Deleted user: ${msg.id}`);
        }

        return { ...state, users };
      }
    }
    return state;
  },

  terminate: (_reason, state) => {
    if (state.loggerRef) {
      log(state.loggerRef, 'info', 'UserService', 'Shutting down');
    }
  },
};

// Public API
export async function startUserService(): Promise<UserServiceRef> {
  return GenServer.start(userServiceBehavior, { name: 'user-service' });
}

export function setUserServiceLogger(ref: UserServiceRef, loggerRef: LoggerRef): void {
  GenServer.cast(ref, { type: 'set_logger', ref: loggerRef });
}

export async function createUser(
  ref: UserServiceRef,
  name: string,
  email: string
): Promise<User> {
  return GenServer.call(ref, { type: 'create', name, email }) as Promise<User>;
}

export async function getUser(ref: UserServiceRef, id: string): Promise<User | null> {
  return GenServer.call(ref, { type: 'get', id }) as Promise<User | null>;
}

export async function listUsers(ref: UserServiceRef): Promise<User[]> {
  return GenServer.call(ref, { type: 'list' }) as Promise<User[]>;
}
```

---

## Step 4: Notification Service

Create `src/services/notification-service.ts`:

```typescript
import {
  GenServer,
  type GenServerBehavior,
  type GenServerRef,
} from 'noex';
import type { Notification, NotificationType } from '../types.js';
import { log, type LoggerRef } from './logger.js';

// State
interface NotificationState {
  notifications: Notification[];
  loggerRef: LoggerRef | null;
}

// Messages
type NotificationCall =
  | { type: 'get_for_user'; userId: string }
  | { type: 'get_unread'; userId: string }
  | { type: 'get_all' };

type NotificationCast =
  | { type: 'send'; userId: string; notifType: NotificationType; message: string }
  | { type: 'mark_read'; id: string }
  | { type: 'set_logger'; ref: LoggerRef };

type NotificationReply = Notification[];

export type NotificationServiceRef = GenServerRef<
  NotificationState,
  NotificationCall,
  NotificationCast,
  NotificationReply
>;

// Behavior
const notificationBehavior: GenServerBehavior<
  NotificationState,
  NotificationCall,
  NotificationCast,
  NotificationReply
> = {
  init: () => ({
    notifications: [],
    loggerRef: null,
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get_for_user':
        return [state.notifications.filter(n => n.userId === msg.userId), state];

      case 'get_unread':
        return [
          state.notifications.filter(n => n.userId === msg.userId && !n.read),
          state,
        ];

      case 'get_all':
        return [state.notifications, state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'send': {
        const notification: Notification = {
          id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          userId: msg.userId,
          type: msg.notifType,
          message: msg.message,
          read: false,
          createdAt: new Date(),
        };

        if (state.loggerRef) {
          log(
            state.loggerRef,
            'info',
            'NotificationService',
            `Sent ${msg.notifType} to user ${msg.userId}`
          );
        }

        return {
          ...state,
          notifications: [...state.notifications, notification],
        };
      }

      case 'mark_read': {
        const notifications = state.notifications.map(n =>
          n.id === msg.id ? { ...n, read: true } : n
        );
        return { ...state, notifications };
      }

      case 'set_logger':
        return { ...state, loggerRef: msg.ref };
    }
    return state;
  },

  terminate: (_reason, state) => {
    if (state.loggerRef) {
      log(state.loggerRef, 'info', 'NotificationService', 'Shutting down');
    }
  },
};

// Public API
export async function startNotificationService(): Promise<NotificationServiceRef> {
  return GenServer.start(notificationBehavior, { name: 'notification-service' });
}

export function setNotificationLogger(
  ref: NotificationServiceRef,
  loggerRef: LoggerRef
): void {
  GenServer.cast(ref, { type: 'set_logger', ref: loggerRef });
}

export function sendNotification(
  ref: NotificationServiceRef,
  userId: string,
  type: NotificationType,
  message: string
): void {
  GenServer.cast(ref, { type: 'send', userId, notifType: type, message });
}

export async function getUserNotifications(
  ref: NotificationServiceRef,
  userId: string
): Promise<Notification[]> {
  return GenServer.call(ref, { type: 'get_for_user', userId });
}
```

---

## Step 5: Order Service

Create `src/services/order-service.ts`:

```typescript
import {
  GenServer,
  type GenServerBehavior,
  type GenServerRef,
} from 'noex';
import type { Order, OrderItem, OrderStatus } from '../types.js';
import { log, type LoggerRef } from './logger.js';
import { sendNotification, type NotificationServiceRef } from './notification-service.js';

// State
interface OrderServiceState {
  orders: Map<string, Order>;
  loggerRef: LoggerRef | null;
  notificationRef: NotificationServiceRef | null;
}

// Messages
type OrderCall =
  | { type: 'get'; id: string }
  | { type: 'get_for_user'; userId: string }
  | { type: 'list' }
  | { type: 'create'; userId: string; items: OrderItem[] }
  | { type: 'update_status'; id: string; status: OrderStatus };

type OrderCast =
  | { type: 'set_dependencies'; loggerRef: LoggerRef; notificationRef: NotificationServiceRef }
  | { type: 'cancel'; id: string };

type OrderReply = Order | Order[] | null;

export type OrderServiceRef = GenServerRef<OrderServiceState, OrderCall, OrderCast, OrderReply>;

// Behavior
const orderServiceBehavior: GenServerBehavior<
  OrderServiceState,
  OrderCall,
  OrderCast,
  OrderReply
> = {
  init: () => ({
    orders: new Map(),
    loggerRef: null,
    notificationRef: null,
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.orders.get(msg.id) ?? null, state];

      case 'get_for_user': {
        const userOrders = Array.from(state.orders.values())
          .filter(o => o.userId === msg.userId);
        return [userOrders, state];
      }

      case 'list':
        return [Array.from(state.orders.values()), state];

      case 'create': {
        const id = `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const total = msg.items.reduce((sum, item) => sum + item.price * item.quantity, 0);

        const order: Order = {
          id,
          userId: msg.userId,
          items: msg.items,
          status: 'pending',
          total,
          createdAt: new Date(),
        };

        const orders = new Map(state.orders);
        orders.set(id, order);

        if (state.loggerRef) {
          log(state.loggerRef, 'info', 'OrderService', `Created order ${id} for user ${msg.userId}`);
        }

        if (state.notificationRef) {
          sendNotification(
            state.notificationRef,
            msg.userId,
            'order_created',
            `Your order ${id} has been created. Total: $${total.toFixed(2)}`
          );
        }

        return [order, { ...state, orders }];
      }

      case 'update_status': {
        const order = state.orders.get(msg.id);
        if (!order) {
          return [null, state];
        }

        const updatedOrder: Order = { ...order, status: msg.status };
        const orders = new Map(state.orders);
        orders.set(msg.id, updatedOrder);

        if (state.loggerRef) {
          log(state.loggerRef, 'info', 'OrderService', `Order ${msg.id} status: ${msg.status}`);
        }

        if (state.notificationRef) {
          const notifType = msg.status === 'confirmed' ? 'order_confirmed' :
                           msg.status === 'shipped' ? 'order_shipped' : 'system';
          sendNotification(
            state.notificationRef,
            order.userId,
            notifType,
            `Your order ${msg.id} is now ${msg.status}`
          );
        }

        return [updatedOrder, { ...state, orders }];
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

      case 'cancel': {
        const order = state.orders.get(msg.id);
        if (order && order.status === 'pending') {
          const orders = new Map(state.orders);
          orders.set(msg.id, { ...order, status: 'cancelled' });

          if (state.loggerRef) {
            log(state.loggerRef, 'info', 'OrderService', `Order ${msg.id} cancelled`);
          }

          return { ...state, orders };
        }
        return state;
      }
    }
    return state;
  },

  terminate: (_reason, state) => {
    if (state.loggerRef) {
      log(state.loggerRef, 'info', 'OrderService', 'Shutting down');
    }
  },
};

// Public API
export async function startOrderService(): Promise<OrderServiceRef> {
  return GenServer.start(orderServiceBehavior, { name: 'order-service' });
}

export function setOrderDependencies(
  ref: OrderServiceRef,
  loggerRef: LoggerRef,
  notificationRef: NotificationServiceRef
): void {
  GenServer.cast(ref, { type: 'set_dependencies', loggerRef, notificationRef });
}

export async function createOrder(
  ref: OrderServiceRef,
  userId: string,
  items: OrderItem[]
): Promise<Order> {
  return GenServer.call(ref, { type: 'create', userId, items }) as Promise<Order>;
}

export async function getOrder(ref: OrderServiceRef, id: string): Promise<Order | null> {
  return GenServer.call(ref, { type: 'get', id }) as Promise<Order | null>;
}

export async function updateOrderStatus(
  ref: OrderServiceRef,
  id: string,
  status: OrderStatus
): Promise<Order | null> {
  return GenServer.call(ref, { type: 'update_status', id, status }) as Promise<Order | null>;
}
```

---

## Step 6: Supervision Tree Setup

Create `src/supervisor.ts`:

```typescript
import { Supervisor, type SupervisorRef, type ChildSpec } from 'noex';
import { startLogger, type LoggerRef } from './services/logger.js';
import {
  startUserService,
  setUserServiceLogger,
  type UserServiceRef,
} from './services/user-service.js';
import {
  startNotificationService,
  setNotificationLogger,
  type NotificationServiceRef,
} from './services/notification-service.js';
import {
  startOrderService,
  setOrderDependencies,
  type OrderServiceRef,
} from './services/order-service.js';

export interface ServiceRefs {
  logger: LoggerRef;
  userService: UserServiceRef;
  notificationService: NotificationServiceRef;
  orderService: OrderServiceRef;
}

let servicesSupervisor: SupervisorRef | null = null;
let appSupervisor: SupervisorRef | null = null;
let services: ServiceRefs | null = null;

/**
 * Start the complete supervision tree
 */
export async function startSupervisionTree(): Promise<ServiceRefs> {
  console.log('Starting supervision tree...');

  // 1. Start Logger first (outside supervision for bootstrapping)
  const loggerRef = await startLogger();

  // 2. Define service children
  const serviceChildren: ChildSpec[] = [
    {
      id: 'user-service',
      start: () => startUserService(),
      restart: 'permanent',
    },
    {
      id: 'notification-service',
      start: () => startNotificationService(),
      restart: 'permanent',
    },
    {
      id: 'order-service',
      start: () => startOrderService(),
      restart: 'permanent',
    },
  ];

  // 3. Start Services Supervisor
  servicesSupervisor = await Supervisor.start({
    strategy: 'one_for_one',  // Restart only the failed service
    children: serviceChildren,
    restartIntensity: {
      maxRestarts: 5,
      withinMs: 60000,
    },
  });

  // 4. Get service references
  const children = Supervisor.getChildren(servicesSupervisor);
  const userServiceRef = children.find(c => c.id === 'user-service')!.ref as UserServiceRef;
  const notificationRef = children.find(c => c.id === 'notification-service')!.ref as NotificationServiceRef;
  const orderServiceRef = children.find(c => c.id === 'order-service')!.ref as OrderServiceRef;

  // 5. Wire up dependencies
  setUserServiceLogger(userServiceRef, loggerRef);
  setNotificationLogger(notificationRef, loggerRef);
  setOrderDependencies(orderServiceRef, loggerRef, notificationRef);

  // 6. Create root supervisor
  appSupervisor = await Supervisor.start({
    strategy: 'one_for_all',  // If services supervisor fails, restart everything
    restartIntensity: {
      maxRestarts: 3,
      withinMs: 30000,
    },
  });

  services = {
    logger: loggerRef,
    userService: userServiceRef,
    notificationService: notificationRef,
    orderService: orderServiceRef,
  };

  console.log('Supervision tree started successfully!');

  return services;
}

/**
 * Get current service references
 */
export function getServices(): ServiceRefs {
  if (!services) {
    throw new Error('Services not initialized');
  }
  return services;
}

/**
 * Refresh service references after restart
 */
export async function refreshServiceRefs(): Promise<void> {
  if (!servicesSupervisor || !services) return;

  const children = Supervisor.getChildren(servicesSupervisor);

  const userServiceRef = children.find(c => c.id === 'user-service')?.ref as UserServiceRef | undefined;
  const notificationRef = children.find(c => c.id === 'notification-service')?.ref as NotificationServiceRef | undefined;
  const orderServiceRef = children.find(c => c.id === 'order-service')?.ref as OrderServiceRef | undefined;

  if (userServiceRef) {
    services.userService = userServiceRef;
    setUserServiceLogger(userServiceRef, services.logger);
  }

  if (notificationRef) {
    services.notificationService = notificationRef;
    setNotificationLogger(notificationRef, services.logger);
  }

  if (orderServiceRef && notificationRef) {
    services.orderService = orderServiceRef;
    setOrderDependencies(orderServiceRef, services.logger, notificationRef);
  }
}

/**
 * Stop the supervision tree
 */
export async function stopSupervisionTree(): Promise<void> {
  console.log('Stopping supervision tree...');

  if (servicesSupervisor) {
    await Supervisor.stop(servicesSupervisor);
  }

  if (appSupervisor) {
    await Supervisor.stop(appSupervisor);
  }

  console.log('Supervision tree stopped');
}
```

---

## Step 7: HTTP API

Create `src/api.ts`:

```typescript
import express from 'express';
import { getServices } from './supervisor.js';
import { createUser, getUser, listUsers } from './services/user-service.js';
import { createOrder, getOrder, updateOrderStatus } from './services/order-service.js';
import { getUserNotifications } from './services/notification-service.js';
import { getRecentLogs } from './services/logger.js';

const router = express.Router();

// Users
router.post('/users', async (req, res) => {
  try {
    const { name, email } = req.body;
    const user = await createUser(getServices().userService, name, email);
    res.status(201).json(user);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.get('/users', async (_req, res) => {
  try {
    const users = await listUsers(getServices().userService);
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.get('/users/:id', async (req, res) => {
  try {
    const user = await getUser(getServices().userService, req.params.id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Orders
router.post('/orders', async (req, res) => {
  try {
    const { userId, items } = req.body;
    const order = await createOrder(getServices().orderService, userId, items);
    res.status(201).json(order);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.get('/orders/:id', async (req, res) => {
  try {
    const order = await getOrder(getServices().orderService, req.params.id);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.patch('/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const order = await updateOrderStatus(getServices().orderService, req.params.id, status);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Notifications
router.get('/users/:userId/notifications', async (req, res) => {
  try {
    const notifications = await getUserNotifications(
      getServices().notificationService,
      req.params.userId
    );
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// System
router.get('/logs', async (_req, res) => {
  try {
    const logs = await getRecentLogs(getServices().logger, 50);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

export { router };
```

---

## Step 8: Server Entry Point

Create `src/index.ts`:

```typescript
import express from 'express';
import { Observer } from 'noex';
import { startSupervisionTree, stopSupervisionTree } from './supervisor.js';
import { router } from './api.js';

async function main() {
  const port = parseInt(process.env.PORT || '7201', 10);

  // Start supervision tree
  await startSupervisionTree();

  // Create Express app
  const app = express();
  app.use(express.json());
  app.use('/api', router);

  // Observer endpoint
  app.get('/api/system/stats', (_req, res) => {
    const snapshot = Observer.getSnapshot();
    res.json({
      processCount: snapshot.processCount,
      totalMessages: snapshot.totalMessages,
      totalRestarts: snapshot.totalRestarts,
      servers: snapshot.servers,
      supervisors: snapshot.supervisors,
      memory: snapshot.memoryStats,
    });
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Start server
  const server = app.listen(port, () => {
    console.log(`E-commerce API running at http://localhost:${port}`);
  });

  // Graceful shutdown
  async function shutdown() {
    console.log('\nShutting down...');
    server.close();
    await stopSupervisionTree();
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(console.error);
```

---

## Step 9: Run and Test

Add scripts to `package.json`:

```json
{
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts"
  }
}
```

Run the server:

```bash
npm start
```

### Test the API

```bash
# Create a user
curl -X POST http://localhost:7201/api/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "email": "alice@example.com"}'

# Create an order (use the user ID from above)
curl -X POST http://localhost:7201/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user_xxx",
    "items": [
      {"productId": "p1", "name": "Widget", "quantity": 2, "price": 9.99},
      {"productId": "p2", "name": "Gadget", "quantity": 1, "price": 24.99}
    ]
  }'

# Confirm the order
curl -X PATCH http://localhost:7201/api/orders/order_xxx/status \
  -H "Content-Type: application/json" \
  -d '{"status": "confirmed"}'

# Check notifications
curl http://localhost:7201/api/users/user_xxx/notifications

# View system stats
curl http://localhost:7201/api/system/stats
```

---

## Fault Tolerance in Action

The supervision tree ensures services restart automatically:

1. If `OrderService` crashes, only it restarts
2. `UserService` and `NotificationService` continue running
3. The `Logger` keeps all logs
4. After restart, dependencies are re-wired automatically

This isolation is the key benefit of the Actor model and supervision trees.

---

## Next Steps

- [Monitoring Dashboard Tutorial](./monitoring-dashboard.md) - Add real-time monitoring UI
- [Supervisor API](../api/supervisor.md) - Advanced supervision patterns
- [Observer API](../api/observer.md) - System introspection
