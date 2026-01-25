# Application Structure

In the previous chapter, you learned about TimerService for durable scheduling. Now it's time to put everything together into a **production-ready application**. noex provides an Application behavior that standardizes lifecycle management, signal handling, and graceful shutdown.

## What You'll Learn

- Structure noex applications using the Application behavior
- Configure application entry points with typed configuration
- Implement graceful startup and shutdown sequences
- Monitor application lifecycle events
- Handle multiple applications in a single process

## Why Application Behavior?

When building production services, you need more than just GenServers and Supervisors. You need:

- **Consistent startup** — Initialize dependencies in the right order
- **Signal handling** — Respond to SIGINT/SIGTERM for container orchestration
- **Graceful shutdown** — Drain connections, finish in-flight requests, persist state
- **Lifecycle visibility** — Know when your app started, stopped, and why

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        APPLICATION LIFECYCLE                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────┐    Application.start()    ┌──────────┐                         │
│  │ STOPPED │ ────────────────────────► │ STARTING │                         │
│  └─────────┘                           └────┬─────┘                         │
│       ▲                                     │                               │
│       │                                     │ start() callback completes    │
│       │                                     ▼                               │
│       │                              ┌───────────┐                          │
│       │                              │  RUNNING  │◄──────────┐              │
│       │                              └─────┬─────┘           │              │
│       │                                    │                 │              │
│       │    ┌───────────────────────────────┼─────────────────┘              │
│       │    │                               │                                │
│       │    │  SIGINT/SIGTERM    Application.stop()                          │
│       │    │       │                       │                                │
│       │    │       ▼                       ▼                                │
│       │    │  ┌──────────────────────────────┐                              │
│       │    │  │          STOPPING            │                              │
│       │    │  │  ┌────────────────────────┐  │                              │
│       │    │  │  │ 1. prepStop() callback │  │                              │
│       │    │  │  │ 2. Stop supervisor tree│  │                              │
│       │    │  │  │ 3. stop() callback     │  │                              │
│       │    │  │  └────────────────────────┘  │                              │
│       │    │  └──────────────┬───────────────┘                              │
│       │    │                 │                                              │
│       └────┴─────────────────┘                                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

The Application behavior encapsulates this lifecycle pattern so you can focus on your business logic.

## Defining an Application

Use `Application.create()` to define a typed application behavior:

```typescript
import { Application, Supervisor, GenServer } from '@hamicek/noex';

// Configuration type for the application
interface AppConfig {
  port: number;
  dbUrl: string;
  maxConnections: number;
}

// Create the application behavior
const MyApp = Application.create<AppConfig>({
  // Called when Application.start() is invoked
  async start(config) {
    console.log(`Starting application on port ${config.port}...`);

    // Start the top-level supervisor
    const supervisor = await Supervisor.start({
      strategy: 'one_for_one',
      children: [
        {
          id: 'database',
          start: () => DatabasePool.start(config.dbUrl, config.maxConnections),
        },
        {
          id: 'http-server',
          start: () => HttpServer.start(config.port),
        },
        {
          id: 'background-jobs',
          start: () => JobProcessor.start(),
        },
      ],
    });

    console.log('Application started successfully');
    return supervisor;  // Return the supervisor reference
  },

  // Optional: Called before stopping (prepare for shutdown)
  async prepStop(supervisorRef) {
    console.log('Preparing to stop...');
    // Stop accepting new connections
    // Drain request queues
    // Notify load balancers
  },

  // Optional: Called after supervisor tree is stopped
  async stop(supervisorRef) {
    console.log('Application stopped');
    // Final cleanup: flush logs, close metrics connections, etc.
  },
});
```

### ApplicationBehavior Interface

```typescript
interface ApplicationBehavior<Config = void, State = SupervisorRef> {
  // Required: Start the application
  start(config: Config): State | Promise<State>;

  // Optional: Prepare for shutdown (before supervisor stops)
  prepStop?(state: State): void | Promise<void>;

  // Optional: Final cleanup (after supervisor stops)
  stop?(state: State): void | Promise<void>;
}
```

| Callback | When Called | Typical Use |
|----------|-------------|-------------|
| `start` | On `Application.start()` | Initialize supervisor tree, connect to databases |
| `prepStop` | Beginning of shutdown | Stop accepting requests, drain queues |
| `stop` | After supervisor stopped | Flush logs, close metrics, final cleanup |

## Starting an Application

Use `Application.start()` with options to launch your application:

```typescript
import { Application } from '@hamicek/noex';

async function main() {
  // Start the application
  const app = await Application.start(MyApp, {
    name: 'my-api-server',           // Unique name for lookup
    config: {                         // Passed to start() callback
      port: 3000,
      dbUrl: 'postgres://localhost/mydb',
      maxConnections: 10,
    },
    handleSignals: true,              // Auto-handle SIGINT/SIGTERM (default: true)
    startTimeout: 30000,              // Max time for start() to complete (default: 30s)
    stopTimeout: 30000,               // Max time for stop sequence (default: 30s)
  });

  console.log(`Application '${app.name}' is running`);

  // Application reference can be used to:
  // - Check status
  // - Trigger manual stop
  // - Access the supervisor
}

main().catch(console.error);
```

### Start Options Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | — | Required. Unique identifier for the application |
| `config` | `Config` | — | Configuration passed to `start()` callback |
| `handleSignals` | `boolean` | `true` | Auto-register SIGINT/SIGTERM handlers |
| `startTimeout` | `number` | `30000` | Maximum ms for `start()` to complete |
| `stopTimeout` | `number` | `30000` | Maximum ms for stop sequence to complete |

### Start Errors

```typescript
import {
  Application,
  ApplicationStartError,
  ApplicationAlreadyRunningError,
} from '@hamicek/noex';

try {
  await Application.start(MyApp, { name: 'my-app', config });
} catch (error) {
  if (error instanceof ApplicationAlreadyRunningError) {
    console.error(`Application '${error.applicationName}' is already running`);
  } else if (error instanceof ApplicationStartError) {
    console.error(`Failed to start: ${error.message}`);
    console.error(`Cause: ${error.cause?.message}`);
  }
}
```

## Stopping an Application

Applications can be stopped manually or via signals:

```typescript
import { Application } from '@hamicek/noex';

// Manual stop
await Application.stop(app, 'normal');

// The stop sequence is:
// 1. Set status to 'stopping'
// 2. Emit 'stopping' lifecycle event
// 3. Call prepStop() callback (if defined)
// 4. Stop the supervisor tree (if state is SupervisorRef)
// 5. Call stop() callback (if defined)
// 6. Remove signal handlers
// 7. Emit 'stopped' lifecycle event
```

### Stop Reasons

```typescript
type ApplicationStopReason =
  | 'normal'           // Graceful manual stop
  | 'signal'           // SIGINT or SIGTERM received
  | { error: Error };  // Stopped due to error
```

### Stop Timeout

If the stop sequence takes longer than `stopTimeout`, an error is thrown:

```typescript
import { ApplicationStopTimeoutError } from '@hamicek/noex';

try {
  await Application.stop(app);
} catch (error) {
  if (error instanceof ApplicationStopTimeoutError) {
    console.error(`Stop timed out after ${error.timeoutMs}ms`);
    // May need to force-kill the process
    process.exit(1);
  }
}
```

## Application State and Queries

Query application state at runtime:

```typescript
import { Application } from '@hamicek/noex';

// Check if running
if (Application.isRunning(app)) {
  console.log('Application is healthy');
}

// Get current status
const status = Application.getStatus(app);
// 'stopped' | 'starting' | 'running' | 'stopping'

// Get the supervisor reference (if state is SupervisorRef)
const supervisor = Application.getSupervisor(app);
if (supervisor) {
  // Inspect supervisor tree
  const children = Supervisor.children(supervisor);
  console.log(`Running ${children.length} services`);
}

// Get application info
const info = Application.getInfo(app);
if (info) {
  console.log(`Name: ${info.name}`);
  console.log(`Status: ${info.status}`);
  console.log(`Started: ${new Date(info.startedAt).toISOString()}`);
  console.log(`Uptime: ${info.uptimeMs}ms`);
}
```

## Application Lookup

Look up applications by name:

```typescript
import { Application } from '@hamicek/noex';

// Find application by name
const app = Application.lookup('my-api-server');
if (app) {
  console.log(`Found application, status: ${Application.getStatus(app)}`);
} else {
  console.log('Application not found');
}

// List all running applications
const allApps = Application.getAllRunning();
console.log(`Running applications: ${allApps.map(a => a.name).join(', ')}`);

// Stop all applications (LIFO order - last started, first stopped)
await Application.stopAll('normal');
```

## Lifecycle Events

Monitor application lifecycle for logging, metrics, or alerting:

```typescript
import { Application, type ApplicationLifecycleEvent } from '@hamicek/noex';

// Register lifecycle handler
const unsubscribe = Application.onLifecycleEvent((event: ApplicationLifecycleEvent) => {
  const timestamp = new Date(event.timestamp).toISOString();

  switch (event.type) {
    case 'starting':
      console.log(`[${timestamp}] Application '${event.name}' starting...`);
      break;

    case 'started':
      console.log(`[${timestamp}] Application '${event.ref.name}' started`);
      // Send "application up" metric
      break;

    case 'stopping':
      console.log(`[${timestamp}] Application '${event.ref.name}' stopping (${formatReason(event.reason)})`);
      break;

    case 'stopped':
      console.log(`[${timestamp}] Application '${event.name}' stopped (${formatReason(event.reason)})`);
      // Send "application down" metric
      break;

    case 'start_failed':
      console.error(`[${timestamp}] Application '${event.name}' failed to start: ${event.error.message}`);
      // Send alert
      break;
  }
});

function formatReason(reason: ApplicationStopReason): string {
  if (reason === 'normal') return 'graceful';
  if (reason === 'signal') return 'signal received';
  return `error: ${reason.error.message}`;
}

// Later: unsubscribe when no longer needed
unsubscribe();
```

### Lifecycle Event Types

| Event | Payload | When |
|-------|---------|------|
| `starting` | `{ name, timestamp }` | `start()` called |
| `started` | `{ ref, timestamp }` | `start()` completed successfully |
| `stopping` | `{ ref, reason, timestamp }` | Stop sequence begins |
| `stopped` | `{ name, reason, timestamp }` | Stop sequence completed |
| `start_failed` | `{ name, error, timestamp }` | `start()` threw or timed out |

## Complete Example: API Server

Here's a production-ready API server structure:

```typescript
import {
  Application,
  Supervisor,
  GenServer,
  Cache,
  RateLimiter,
  type SupervisorRef,
  type GenServerRef,
  type ApplicationRef,
} from '@hamicek/noex';

// Application configuration
interface ApiServerConfig {
  port: number;
  env: 'development' | 'staging' | 'production';
  database: {
    url: string;
    poolSize: number;
  };
  redis: {
    url: string;
  };
  rateLimit: {
    maxRequests: number;
    windowMs: number;
  };
}

// Create application behavior
const ApiServer = Application.create<ApiServerConfig>({
  async start(config) {
    console.log(`[ApiServer] Starting in ${config.env} mode...`);

    // Validate configuration
    if (!config.database.url) {
      throw new Error('Database URL is required');
    }

    // Start the main supervisor tree
    const supervisor = await Supervisor.start({
      strategy: 'one_for_one',
      maxRestarts: 5,
      withinMs: 60000,
      children: [
        // Core infrastructure
        {
          id: 'cache',
          start: async () => Cache.start({
            maxSize: 1000,
            ttlMs: 300000,  // 5 minutes
            name: 'api-cache',
          }),
        },
        {
          id: 'rate-limiter',
          start: async () => RateLimiter.start({
            maxRequests: config.rateLimit.maxRequests,
            windowMs: config.rateLimit.windowMs,
            name: 'api-rate-limiter',
          }),
        },

        // Application services (nested supervisor)
        {
          id: 'services',
          start: async () => Supervisor.start({
            strategy: 'rest_for_one',  // Services depend on each other
            children: [
              {
                id: 'database-pool',
                start: () => createDatabasePool(config.database),
              },
              {
                id: 'user-service',
                start: () => UserService.start(),
              },
              {
                id: 'order-service',
                start: () => OrderService.start(),
              },
            ],
          }),
        },

        // HTTP server (started last)
        {
          id: 'http',
          start: async () => createHttpServer(config.port),
        },
      ],
    });

    console.log(`[ApiServer] Started on port ${config.port}`);
    return supervisor;
  },

  async prepStop(supervisor) {
    console.log('[ApiServer] Preparing for shutdown...');

    // Stop accepting new HTTP connections
    const httpRef = Supervisor.getChild(supervisor, 'http');
    if (httpRef) {
      await GenServer.call(httpRef, { type: 'stopAccepting' });
    }

    // Wait for in-flight requests to complete (max 10 seconds)
    await drainRequests(10000);

    console.log('[ApiServer] Ready for shutdown');
  },

  async stop(supervisor) {
    console.log('[ApiServer] Performing final cleanup...');

    // Flush any pending metrics
    await flushMetrics();

    // Log final state
    console.log('[ApiServer] Shutdown complete');
  },
});

// Helper functions (implementation details)
async function createDatabasePool(config: { url: string; poolSize: number }) {
  // ... database pool initialization
  return GenServer.start({ /* ... */ });
}

async function createHttpServer(port: number) {
  // ... HTTP server initialization
  return GenServer.start({ /* ... */ });
}

async function drainRequests(timeoutMs: number): Promise<void> {
  // ... wait for in-flight requests
}

async function flushMetrics(): Promise<void> {
  // ... flush pending metrics
}

// Application entry point
async function main() {
  // Register lifecycle monitoring
  Application.onLifecycleEvent((event) => {
    if (event.type === 'start_failed') {
      console.error('FATAL: Application failed to start', event.error);
      process.exit(1);
    }
  });

  // Load configuration from environment
  const config: ApiServerConfig = {
    port: parseInt(process.env.PORT || '3000', 10),
    env: (process.env.NODE_ENV || 'development') as ApiServerConfig['env'],
    database: {
      url: process.env.DATABASE_URL || 'postgres://localhost/api',
      poolSize: parseInt(process.env.DB_POOL_SIZE || '10', 10),
    },
    redis: {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    },
    rateLimit: {
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || '60000', 10),
    },
  };

  // Start the application
  const app = await Application.start(ApiServer, {
    name: 'api-server',
    config,
    handleSignals: true,
    startTimeout: 60000,   // 1 minute to start (database connections, etc.)
    stopTimeout: 30000,    // 30 seconds to stop gracefully
  });

  console.log(`API Server running (PID: ${process.pid})`);
  console.log(`  Environment: ${config.env}`);
  console.log(`  Port: ${config.port}`);
  console.log(`  Press Ctrl+C to stop`);
}

main().catch((error) => {
  console.error('Failed to start application:', error);
  process.exit(1);
});
```

## Multiple Applications

Run multiple applications in a single process:

```typescript
import { Application } from '@hamicek/noex';

async function main() {
  // Start multiple applications
  const apiApp = await Application.start(ApiServer, {
    name: 'api-server',
    config: { port: 3000 },
  });

  const adminApp = await Application.start(AdminServer, {
    name: 'admin-server',
    config: { port: 3001 },
  });

  const workerApp = await Application.start(BackgroundWorker, {
    name: 'worker',
    config: { concurrency: 5 },
  });

  console.log('All applications started');

  // List running applications
  const running = Application.getAllRunning();
  console.log(`Running: ${running.map(a => a.name).join(', ')}`);
  // Output: Running: api-server, admin-server, worker

  // Stop one application
  await Application.stop(adminApp);

  // Stop all remaining (LIFO order)
  await Application.stopAll('normal');
}
```

## Exercise: Microservice Application

Build a notification microservice with the following requirements:

1. **Configuration:** Email provider credentials, SMS gateway URL, rate limits
2. **Services:**
   - EmailSender GenServer — Sends emails via SMTP
   - SmsSender GenServer — Sends SMS via HTTP gateway
   - NotificationRouter GenServer — Routes notifications to appropriate sender
3. **Graceful shutdown:** Drain pending notifications before stopping
4. **Lifecycle logging:** Log all application events with timestamps

**Starter code:**

```typescript
import {
  Application,
  Supervisor,
  GenServer,
  type SupervisorRef,
} from '@hamicek/noex';

interface NotificationConfig {
  email: {
    host: string;
    port: number;
    user: string;
    password: string;
  };
  sms: {
    gatewayUrl: string;
    apiKey: string;
  };
  rateLimit: {
    emailsPerMinute: number;
    smsPerMinute: number;
  };
}

// TODO: Define the NotificationService application behavior
const NotificationService = Application.create<NotificationConfig>({
  async start(config) {
    // TODO: Start supervisor tree with:
    //   - email-sender GenServer
    //   - sms-sender GenServer
    //   - notification-router GenServer
    throw new Error('Not implemented');
  },

  async prepStop(supervisor) {
    // TODO: Drain pending notifications
  },

  async stop(supervisor) {
    // TODO: Log final statistics
  },
});

async function main() {
  // TODO: Set up lifecycle logging
  // TODO: Start the application with config from environment
  // TODO: Handle startup errors appropriately
}

main();
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
import {
  Application,
  Supervisor,
  GenServer,
  type SupervisorRef,
  type GenServerRef,
  type GenServerBehavior,
  type ApplicationLifecycleEvent,
  type ApplicationStopReason,
} from '@hamicek/noex';

// Configuration
interface NotificationConfig {
  email: {
    host: string;
    port: number;
    user: string;
    password: string;
  };
  sms: {
    gatewayUrl: string;
    apiKey: string;
  };
  rateLimit: {
    emailsPerMinute: number;
    smsPerMinute: number;
  };
}

// Notification types
interface EmailNotification {
  type: 'email';
  to: string;
  subject: string;
  body: string;
}

interface SmsNotification {
  type: 'sms';
  to: string;
  message: string;
}

type Notification = EmailNotification | SmsNotification;

// EmailSender
interface EmailSenderState {
  sentCount: number;
  queue: EmailNotification[];
  draining: boolean;
}

type EmailSenderCall = { type: 'getStats' } | { type: 'drain' };
type EmailSenderCast = { type: 'send'; notification: EmailNotification };
type EmailSenderReply = { sent: number; queued: number } | { drained: number };

function createEmailSenderBehavior(
  config: NotificationConfig['email'],
): GenServerBehavior<EmailSenderState, EmailSenderCall, EmailSenderCast, EmailSenderReply> {
  return {
    init: () => ({ sentCount: 0, queue: [], draining: false }),

    handleCall: async (msg, state) => {
      switch (msg.type) {
        case 'getStats':
          return [{ sent: state.sentCount, queued: state.queue.length }, state];

        case 'drain': {
          // Process all queued emails
          let drained = 0;
          for (const email of state.queue) {
            console.log(`[EmailSender] Draining: ${email.to} - ${email.subject}`);
            // Simulate sending
            await new Promise(r => setTimeout(r, 100));
            drained++;
          }
          return [{ drained }, { ...state, queue: [], draining: true }];
        }
      }
    },

    handleCast: async (msg, state) => {
      if (msg.type === 'send') {
        if (state.draining) {
          console.log(`[EmailSender] Rejected (draining): ${msg.notification.to}`);
          return state;
        }

        console.log(`[EmailSender] Sending to ${msg.notification.to}: ${msg.notification.subject}`);
        // Simulate sending (in production, use nodemailer or similar)
        await new Promise(r => setTimeout(r, 50));

        return {
          ...state,
          sentCount: state.sentCount + 1,
        };
      }
      return state;
    },
  };
}

// SmsSender
interface SmsSenderState {
  sentCount: number;
  queue: SmsNotification[];
  draining: boolean;
}

type SmsSenderCall = { type: 'getStats' } | { type: 'drain' };
type SmsSenderCast = { type: 'send'; notification: SmsNotification };
type SmsSenderReply = { sent: number; queued: number } | { drained: number };

function createSmsSenderBehavior(
  config: NotificationConfig['sms'],
): GenServerBehavior<SmsSenderState, SmsSenderCall, SmsSenderCast, SmsSenderReply> {
  return {
    init: () => ({ sentCount: 0, queue: [], draining: false }),

    handleCall: async (msg, state) => {
      switch (msg.type) {
        case 'getStats':
          return [{ sent: state.sentCount, queued: state.queue.length }, state];

        case 'drain': {
          let drained = 0;
          for (const sms of state.queue) {
            console.log(`[SmsSender] Draining: ${sms.to}`);
            await new Promise(r => setTimeout(r, 50));
            drained++;
          }
          return [{ drained }, { ...state, queue: [], draining: true }];
        }
      }
    },

    handleCast: async (msg, state) => {
      if (msg.type === 'send') {
        if (state.draining) {
          console.log(`[SmsSender] Rejected (draining): ${msg.notification.to}`);
          return state;
        }

        console.log(`[SmsSender] Sending to ${msg.notification.to}: ${msg.notification.message.slice(0, 30)}...`);
        await new Promise(r => setTimeout(r, 30));

        return {
          ...state,
          sentCount: state.sentCount + 1,
        };
      }
      return state;
    },
  };
}

// NotificationRouter
interface RouterState {
  emailSender: GenServerRef<EmailSenderState, EmailSenderCall, EmailSenderCast, EmailSenderReply>;
  smsSender: GenServerRef<SmsSenderState, SmsSenderCall, SmsSenderCast, SmsSenderReply>;
  routedCount: number;
}

type RouterCall = { type: 'getStats' };
type RouterCast = { type: 'route'; notification: Notification };
type RouterReply = { routed: number };

function createRouterBehavior(
  emailSender: GenServerRef<EmailSenderState, EmailSenderCall, EmailSenderCast, EmailSenderReply>,
  smsSender: GenServerRef<SmsSenderState, SmsSenderCall, SmsSenderCast, SmsSenderReply>,
): GenServerBehavior<RouterState, RouterCall, RouterCast, RouterReply> {
  return {
    init: () => ({ emailSender, smsSender, routedCount: 0 }),

    handleCall: (msg, state) => {
      if (msg.type === 'getStats') {
        return [{ routed: state.routedCount }, state];
      }
      return [{ routed: 0 }, state];
    },

    handleCast: (msg, state) => {
      if (msg.type === 'route') {
        const notification = msg.notification;

        if (notification.type === 'email') {
          GenServer.cast(state.emailSender, { type: 'send', notification });
        } else if (notification.type === 'sms') {
          GenServer.cast(state.smsSender, { type: 'send', notification });
        }

        return { ...state, routedCount: state.routedCount + 1 };
      }
      return state;
    },
  };
}

// Application behavior
const NotificationService = Application.create<NotificationConfig>({
  async start(config) {
    console.log('[NotificationService] Starting...');

    // Create senders first (they'll be passed to router)
    const emailSender = await GenServer.start(
      createEmailSenderBehavior(config.email),
      { name: 'email-sender' },
    );

    const smsSender = await GenServer.start(
      createSmsSenderBehavior(config.sms),
      { name: 'sms-sender' },
    );

    const router = await GenServer.start(
      createRouterBehavior(emailSender, smsSender),
      { name: 'notification-router' },
    );

    // Create supervisor to manage all processes
    const supervisor = await Supervisor.start({
      strategy: 'one_for_all',  // If one fails, restart all (they're interconnected)
      maxRestarts: 3,
      withinMs: 60000,
      children: [
        { id: 'email-sender', start: () => Promise.resolve(emailSender) },
        { id: 'sms-sender', start: () => Promise.resolve(smsSender) },
        { id: 'router', start: () => Promise.resolve(router) },
      ],
    });

    console.log('[NotificationService] Started successfully');
    console.log(`  Email: ${config.email.host}:${config.email.port}`);
    console.log(`  SMS Gateway: ${config.sms.gatewayUrl}`);

    return supervisor;
  },

  async prepStop(supervisor) {
    console.log('[NotificationService] Preparing for shutdown...');

    // Get references to senders
    const emailSender = Supervisor.getChild(supervisor, 'email-sender');
    const smsSender = Supervisor.getChild(supervisor, 'sms-sender');

    // Drain both queues in parallel
    const results = await Promise.all([
      emailSender ? GenServer.call(emailSender, { type: 'drain' }) : { drained: 0 },
      smsSender ? GenServer.call(smsSender, { type: 'drain' }) : { drained: 0 },
    ]);

    console.log(`[NotificationService] Drained ${(results[0] as { drained: number }).drained} emails, ${(results[1] as { drained: number }).drained} SMS`);
  },

  async stop(supervisor) {
    // Get final statistics
    const emailSender = Supervisor.getChild(supervisor, 'email-sender');
    const smsSender = Supervisor.getChild(supervisor, 'sms-sender');
    const router = Supervisor.getChild(supervisor, 'router');

    const [emailStats, smsStats, routerStats] = await Promise.all([
      emailSender ? GenServer.call(emailSender, { type: 'getStats' }) : { sent: 0, queued: 0 },
      smsSender ? GenServer.call(smsSender, { type: 'getStats' }) : { sent: 0, queued: 0 },
      router ? GenServer.call(router, { type: 'getStats' }) : { routed: 0 },
    ]);

    console.log('[NotificationService] Final Statistics:');
    console.log(`  Emails sent: ${(emailStats as { sent: number }).sent}`);
    console.log(`  SMS sent: ${(smsStats as { sent: number }).sent}`);
    console.log(`  Total routed: ${(routerStats as { routed: number }).routed}`);
    console.log('[NotificationService] Shutdown complete');
  },
});

// Lifecycle event formatting
function formatReason(reason: ApplicationStopReason): string {
  if (reason === 'normal') return 'graceful shutdown';
  if (reason === 'signal') return 'signal received';
  return `error: ${reason.error.message}`;
}

// Main entry point
async function main() {
  // Set up lifecycle logging
  Application.onLifecycleEvent((event: ApplicationLifecycleEvent) => {
    const time = new Date(event.timestamp).toISOString();

    switch (event.type) {
      case 'starting':
        console.log(`[${time}] LIFECYCLE: Application '${event.name}' starting`);
        break;
      case 'started':
        console.log(`[${time}] LIFECYCLE: Application '${event.ref.name}' started`);
        break;
      case 'stopping':
        console.log(`[${time}] LIFECYCLE: Application '${event.ref.name}' stopping (${formatReason(event.reason)})`);
        break;
      case 'stopped':
        console.log(`[${time}] LIFECYCLE: Application '${event.name}' stopped (${formatReason(event.reason)})`);
        break;
      case 'start_failed':
        console.error(`[${time}] LIFECYCLE: Application '${event.name}' FAILED: ${event.error.message}`);
        break;
    }
  });

  // Load config from environment
  const config: NotificationConfig = {
    email: {
      host: process.env.SMTP_HOST || 'smtp.example.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      user: process.env.SMTP_USER || 'notifications@example.com',
      password: process.env.SMTP_PASS || 'secret',
    },
    sms: {
      gatewayUrl: process.env.SMS_GATEWAY_URL || 'https://sms.example.com/api',
      apiKey: process.env.SMS_API_KEY || 'test-key',
    },
    rateLimit: {
      emailsPerMinute: parseInt(process.env.EMAIL_RATE_LIMIT || '60', 10),
      smsPerMinute: parseInt(process.env.SMS_RATE_LIMIT || '30', 10),
    },
  };

  try {
    const app = await Application.start(NotificationService, {
      name: 'notification-service',
      config,
      handleSignals: true,
      startTimeout: 10000,
      stopTimeout: 30000,
    });

    console.log(`\nNotification Service running (PID: ${process.pid})`);
    console.log('Press Ctrl+C to stop\n');

    // Simulate some notifications for testing
    const router = Application.getSupervisor(app);
    if (router) {
      const routerRef = Supervisor.getChild(router, 'router');
      if (routerRef) {
        // Send test notifications
        GenServer.cast(routerRef, {
          type: 'route',
          notification: { type: 'email', to: 'user@example.com', subject: 'Welcome!', body: 'Thanks for signing up.' },
        });
        GenServer.cast(routerRef, {
          type: 'route',
          notification: { type: 'sms', to: '+1234567890', message: 'Your verification code is 123456' },
        });
        GenServer.cast(routerRef, {
          type: 'route',
          notification: { type: 'email', to: 'admin@example.com', subject: 'Daily Report', body: 'Here is your report...' },
        });
      }
    }

    // Keep running until signal
    await new Promise(() => {});  // Wait forever (signal handler will stop us)

  } catch (error) {
    console.error('Failed to start NotificationService:', error);
    process.exit(1);
  }
}

main();
```

**Key design decisions:**

1. **Layered architecture** — Senders handle delivery, Router handles routing logic
2. **Drain before stop** — `prepStop` ensures all queued notifications are sent
3. **Statistics on shutdown** — `stop` logs final counts for monitoring
4. **one_for_all strategy** — Senders and router are tightly coupled
5. **Lifecycle logging** — All events logged with timestamps for debugging

**Sample output:**

```
[2024-01-25T10:00:00.000Z] LIFECYCLE: Application 'notification-service' starting
[NotificationService] Starting...
[NotificationService] Started successfully
  Email: smtp.example.com:587
  SMS Gateway: https://sms.example.com/api
[2024-01-25T10:00:00.100Z] LIFECYCLE: Application 'notification-service' started

Notification Service running (PID: 12345)
Press Ctrl+C to stop

[EmailSender] Sending to user@example.com: Welcome!
[SmsSender] Sending to +1234567890: Your verification code is 1234...
[EmailSender] Sending to admin@example.com: Daily Report

^C
[2024-01-25T10:00:30.000Z] LIFECYCLE: Application 'notification-service' stopping (signal received)
[NotificationService] Preparing for shutdown...
[NotificationService] Drained 0 emails, 0 SMS
[NotificationService] Final Statistics:
  Emails sent: 2
  SMS sent: 1
  Total routed: 3
[NotificationService] Shutdown complete
[2024-01-25T10:00:30.500Z] LIFECYCLE: Application 'notification-service' stopped (signal received)
```

</details>

## Summary

**Key takeaways:**

- **Application behavior** standardizes lifecycle management — `start`, `prepStop`, `stop`
- **Typed configuration** — Pass config to `start()` for dependency injection
- **Automatic signal handling** — SIGINT/SIGTERM trigger graceful shutdown
- **Timeouts** — Both startup and shutdown have configurable timeouts
- **Lifecycle events** — Monitor application state changes for logging/metrics

**API reference:**

| Method | Returns | Description |
|--------|---------|-------------|
| `Application.create(behavior)` | `ApplicationBehavior` | Create typed behavior |
| `Application.start(behavior, options)` | `Promise<ApplicationRef>` | Start application |
| `Application.stop(ref, reason?)` | `Promise<void>` | Stop application |
| `Application.getStatus(ref)` | `ApplicationStatus` | Get current status |
| `Application.getSupervisor(ref)` | `SupervisorRef \| undefined` | Get supervisor if state is SupervisorRef |
| `Application.getState(ref)` | `State \| undefined` | Get application state |
| `Application.isRunning(ref)` | `boolean` | Check if running |
| `Application.lookup(name)` | `ApplicationRef \| undefined` | Find by name |
| `Application.getAllRunning()` | `ApplicationRef[]` | List all running |
| `Application.stopAll(reason?)` | `Promise<void>` | Stop all (LIFO order) |
| `Application.onLifecycleEvent(handler)` | `() => void` | Subscribe to events |
| `Application.getInfo(ref)` | `{ name, status, startedAt, uptimeMs }` | Get app info |

**Remember:**

> The Application behavior is the entry point for production noex applications. It provides the structure needed for reliable deployment: consistent startup, graceful shutdown, and lifecycle visibility. Always use Application.create() to define your application and Application.start() to launch it.

---

Next: [Signal Handling](./02-signal-handling.md)
