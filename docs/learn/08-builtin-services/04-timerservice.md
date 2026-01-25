# TimerService

In the previous chapter, you learned to protect services with rate limiting. Now let's tackle another common need: **scheduling operations for the future**. noex provides a built-in TimerService that delivers messages at specified times — and unlike regular timers, these survive process restarts.

## What You'll Learn

- Why durable timers are essential for reliable scheduling
- Configure one-shot and repeating timers
- Persist timers across restarts using storage adapters
- Build scheduled task systems that survive crashes
- Manage and query pending timers

## Why Durable Timers?

JavaScript's `setTimeout` and `setInterval` work fine for short-lived operations, but they have a critical flaw: **they don't survive restarts**. When your process crashes or redeploys, all pending timers are lost.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              REGULAR TIMERS VS DURABLE TIMERS                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  REGULAR TIMERS (setTimeout):          DURABLE TIMERS (TimerService):       │
│                                                                             │
│  ┌─────────────────────────┐           ┌─────────────────────────┐          │
│  │ Schedule: email in 1h   │           │ Schedule: email in 1h   │          │
│  │ Timer ID: 12345         │           │ Timer ID: dtimer_1      │          │
│  └───────────┬─────────────┘           └───────────┬─────────────┘          │
│              │                                     │                        │
│              ▼                                     ▼                        │
│  ┌─────────────────────────┐           ┌─────────────────────────┐          │
│  │ 30 min later: deploy!   │           │ 30 min later: deploy!   │          │
│  │ Process restarts...     │           │ Process restarts...     │          │
│  │                         │           │                         │          │
│  │ ❌ Timer LOST!          │           │ ✓ Timer restored from   │          │
│  │ Email never sent        │           │   storage adapter       │          │
│  └─────────────────────────┘           └───────────┬─────────────┘          │
│                                                    │                        │
│                                                    ▼                        │
│                                        ┌─────────────────────────┐          │
│                                        │ 30 min later: fires!    │          │
│                                        │ ✓ Email sent            │          │
│                                        └─────────────────────────┘          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Use TimerService when:**
- Scheduling operations that must happen even after restarts
- Implementing reminder systems, delayed notifications
- Building retry mechanisms with exponential backoff
- Creating scheduled maintenance tasks
- Implementing subscription renewals, trial expirations

**Don't use TimerService when:**
- Sub-second timing precision is needed (use `setTimeout` or `GenServer.sendAfter`)
- Timers are very short-lived (< 1 minute) and loss is acceptable
- You already have a dedicated job queue (Redis, BullMQ, etc.)

## How TimerService Works

TimerService is a GenServer that periodically checks for expired timers and delivers messages via `cast`:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        TIMER SERVICE ARCHITECTURE                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐     schedule()     ┌──────────────────────────────┐        │
│  │   Client    │ ─────────────────► │        TimerService          │        │
│  └─────────────┘                    │  ┌───────────────────────┐   │        │
│                                     │  │ In-Memory Timer Map   │   │        │
│  ┌─────────────┐     cast(msg)      │  │ ┌─────────────────┐   │   │        │
│  │   Target    │ ◄───────────────── │  │ │ id: dtimer_1    │   │   │        │
│  │  GenServer  │                    │  │ │ fireAt: 1706xxx │   │   │        │
│  └─────────────┘                    │  │ │ target: ref     │   │   │        │
│                                     │  │ │ message: {...}  │   │   │        │
│                                     │  │ └─────────────────┘   │   │        │
│                                     │  └───────────┬───────────┘   │        │
│                                     └──────────────┼───────────────┘        │
│                                                    │                        │
│                                                    │ persist/restore        │
│                                                    ▼                        │
│                                     ┌──────────────────────────────┐        │
│                                     │      Storage Adapter         │        │
│                                     │  (Memory/File/SQLite)        │        │
│                                     └──────────────────────────────┘        │
│                                                                             │
│  Tick Cycle (configurable interval, default 1s):                            │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  1. Check all timers where fireAt <= now                               │ │
│  │  2. For each expired timer:                                            │ │
│  │     - Cast message to target GenServer                                 │ │
│  │     - If repeat: reschedule with new fireAt                            │ │
│  │     - If one-shot: remove from storage                                 │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Key characteristics:
- Timers are stored in memory AND persisted to a storage adapter
- On restart, all pending timers are automatically restored
- Messages are delivered via `GenServer.cast()` (fire-and-forget)
- Check interval determines timer resolution (default: 1 second)

## Starting a TimerService

TimerService requires a storage adapter for persistence:

```typescript
import { TimerService, MemoryAdapter, FileAdapter, SQLiteAdapter } from '@hamicek/noex';

// For development/testing: MemoryAdapter (not persisted across restarts)
const devTimers = await TimerService.start({
  adapter: new MemoryAdapter(),
});

// For simple persistence: FileAdapter
const fileTimers = await TimerService.start({
  adapter: new FileAdapter('./data/timers'),
});

// For production: SQLiteAdapter
const prodTimers = await TimerService.start({
  adapter: new SQLiteAdapter('./data/timers.db'),
  checkIntervalMs: 500,  // Check every 500ms for more precision
  name: 'app-timers',    // Optional: register in process registry
});

// Check if running
console.log(TimerService.isRunning(prodTimers)); // true

// Clean shutdown
await TimerService.stop(prodTimers);
```

### Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `adapter` | `StorageAdapter` | Yes | — | Storage backend for persistence |
| `checkIntervalMs` | `number` | No | `1000` | How often to check for expired timers |
| `name` | `string` | No | — | Registry name for process lookup |

### Check Interval Guidelines

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CHECK INTERVAL SELECTION GUIDE                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Check Interval │ Best For                        │ Trade-offs              │
│  ───────────────┼─────────────────────────────────┼───────────────────────  │
│  100ms          │ Near real-time notifications    │ Higher CPU usage        │
│  500ms          │ User-facing reminders           │ Good balance            │
│  1000ms (1s)    │ General purpose (default)       │ Up to 1s delay          │
│  5000ms (5s)    │ Background tasks                │ Lower overhead          │
│  60000ms (1m)   │ Long-running scheduled jobs     │ Coarse granularity      │
│                                                                             │
│  Rule of thumb: checkIntervalMs should be at most half your shortest timer │
│  If timers are typically 5+ minutes, 1s check interval is plenty           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Scheduling One-Shot Timers

Schedule a timer that fires once after a delay:

```typescript
import { TimerService, GenServer, MemoryAdapter } from '@hamicek/noex';

// Create a target GenServer that will receive timer messages
const notificationHandler = await GenServer.start({
  init: () => ({ sentCount: 0 }),
  handleCall: (msg, state) => {
    if (msg === 'getCount') return [state.sentCount, state];
    return [undefined, state];
  },
  handleCast: (msg, state) => {
    if (msg.type === 'sendNotification') {
      console.log(`Sending notification: ${msg.text}`);
      return { sentCount: state.sentCount + 1 };
    }
    return state;
  },
});

// Start timer service
const timers = await TimerService.start({
  adapter: new MemoryAdapter(),
});

// Schedule a notification in 5 seconds
const timerId = await TimerService.schedule(
  timers,
  notificationHandler,
  { type: 'sendNotification', text: 'Your order has shipped!' },
  5000,  // 5 seconds delay
);

console.log(`Scheduled timer: ${timerId}`);
// Output: Scheduled timer: dtimer_1_lx2k3m

// Timer will fire after 5 seconds:
// Output: Sending notification: Your order has shipped!
```

### Timer ID Format

Timer IDs follow the pattern `dtimer_{counter}_{timestamp}`:
- `dtimer_` — prefix for durable timers
- `{counter}` — incrementing number for uniqueness
- `{timestamp}` — base36-encoded creation time

This format ensures globally unique IDs even across restarts.

## Scheduling Repeating Timers

For periodic tasks, use the `repeat` option:

```typescript
// Health check every 30 seconds
const healthCheckId = await TimerService.schedule(
  timers,
  monitorService,
  { type: 'healthCheck' },
  30000,  // Initial delay: 30 seconds
  { repeat: 30000 },  // Then repeat every 30 seconds
);

// Hourly report generation
const reportId = await TimerService.schedule(
  timers,
  reportService,
  { type: 'generateReport', period: 'hourly' },
  60000,  // First report in 1 minute
  { repeat: 3600000 },  // Then every hour
);

// Repeating timers continue until cancelled
await TimerService.cancel(timers, healthCheckId);
```

### One-Shot vs Repeating

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ONE-SHOT VS REPEATING TIMERS                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ONE-SHOT TIMER:                                                            │
│  ┌─────┐        delay        ┌─────┐                                        │
│  │START│ ──────────────────► │FIRE │ ──► Timer removed from storage         │
│  └─────┘        5000ms       └─────┘                                        │
│                                                                             │
│  Use for: password reset links, delayed emails, one-time reminders          │
│                                                                             │
│  ═══════════════════════════════════════════════════════════════════════    │
│                                                                             │
│  REPEATING TIMER:                                                           │
│  ┌─────┐    delay    ┌─────┐   repeat   ┌─────┐   repeat   ┌─────┐         │
│  │START│ ──────────► │FIRE │ ─────────► │FIRE │ ─────────► │FIRE │ ──► ... │
│  └─────┘    5000ms   └─────┘   5000ms   └─────┘   5000ms   └─────┘         │
│                                                                             │
│  Use for: health checks, metrics collection, periodic cleanup               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Cancelling Timers

Cancel a timer before it fires:

```typescript
// Schedule a timer
const timerId = await TimerService.schedule(
  timers,
  targetRef,
  { type: 'sendReminder' },
  300000,  // 5 minutes
);

// User dismissed the reminder, cancel the timer
const wasCancelled = await TimerService.cancel(timers, timerId);

if (wasCancelled) {
  console.log('Timer cancelled successfully');
} else {
  console.log('Timer not found (already fired or never existed)');
}
```

### Cancel Return Values

| Return | Meaning |
|--------|---------|
| `true` | Timer was pending and has been cancelled |
| `false` | Timer not found (already fired, cancelled, or invalid ID) |

## Querying Timers

### Get a Single Timer

```typescript
const timerId = await TimerService.schedule(
  timers,
  targetRef,
  { type: 'sendEmail', to: 'user@example.com' },
  60000,
);

// Get timer details
const entry = await TimerService.get(timers, timerId);

if (entry) {
  console.log('Timer found:');
  console.log(`  ID: ${entry.id}`);
  console.log(`  Fires at: ${new Date(entry.fireAt).toISOString()}`);
  console.log(`  Target: ${entry.targetRef.id}`);
  console.log(`  Message: ${JSON.stringify(entry.message)}`);
  console.log(`  Repeat: ${entry.repeat ?? 'one-shot'}`);
} else {
  console.log('Timer not found');
}
```

### List All Pending Timers

```typescript
const allTimers = await TimerService.getAll(timers);

console.log(`${allTimers.length} pending timers:`);
for (const entry of allTimers) {
  const fireDate = new Date(entry.fireAt);
  const remaining = entry.fireAt - Date.now();
  console.log(`  ${entry.id}: fires in ${Math.ceil(remaining / 1000)}s`);
}
```

### TimerEntry Interface

```typescript
interface TimerEntry {
  id: string;           // Unique timer identifier
  fireAt: number;       // Unix timestamp (ms) when timer fires
  targetRef: {          // Target process reference
    id: string;
    nodeId?: string;    // For distributed setups
  };
  message: unknown;     // Message to deliver via cast
  repeat?: number;      // Repeat interval in ms (undefined = one-shot)
}
```

## Persistence and Recovery

TimerService persists every timer to the storage adapter. On restart, pending timers are automatically restored:

```typescript
import { TimerService, FileAdapter, GenServer } from '@hamicek/noex';

// Session 1: Schedule a timer
const adapter = new FileAdapter('./data/timers');
const timers = await TimerService.start({ adapter });
const target = await GenServer.start(/* ... */);

await TimerService.schedule(
  timers,
  target,
  { type: 'reminder', text: 'Meeting in 5 minutes' },
  300000,  // 5 minutes
);

// Process stops (deploy, crash, etc.)
await TimerService.stop(timers);

// --- Later (even after process restart) ---

// Session 2: Timers are restored automatically
const timers2 = await TimerService.start({ adapter });

const restored = await TimerService.getAll(timers2);
console.log(`Restored ${restored.length} timer(s)`);
// Output: Restored 1 timer(s)

// Timer will fire at the original scheduled time!
```

### Handling Overdue Timers

Timers that expire during downtime fire immediately on the first tick after restart:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        OVERDUE TIMER RECOVERY                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Timeline:                                                                  │
│                                                                             │
│  00:00  Schedule timer for 00:05                                            │
│    │    ┌─────────────────────┐                                             │
│    ├───►│ Timer stored: 00:05 │                                             │
│    │    └─────────────────────┘                                             │
│    │                                                                        │
│  00:03  Process crashes                                                     │
│    │    ┌─────────────────────┐                                             │
│    ├───►│ Process down...     │                                             │
│    │    └─────────────────────┘                                             │
│    │                                                                        │
│  00:05  Timer SHOULD have fired (but process is down)                       │
│    │                                                                        │
│  00:10  Process restarts                                                    │
│    │    ┌─────────────────────┐                                             │
│    ├───►│ Load timers from    │                                             │
│    │    │ storage adapter     │                                             │
│    │    └─────────────────────┘                                             │
│    │    ┌─────────────────────┐                                             │
│    ├───►│ First tick: check   │                                             │
│    │    │ fireAt <= now?      │                                             │
│    │    │ YES! Fire overdue   │                                             │
│    │    │ timer immediately   │                                             │
│    │    └─────────────────────┘                                             │
│    │                                                                        │
│  00:10  Message delivered (5 min late, but not lost!)                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

This "catch up" behavior ensures no scheduled operations are lost, even after extended downtime.

## Practical Example: Reminder System

Here's a production-ready reminder system using TimerService:

```typescript
import {
  TimerService,
  GenServer,
  SQLiteAdapter,
  type GenServerBehavior,
  type GenServerRef,
  type TimerServiceRef,
} from '@hamicek/noex';

// Types
interface Reminder {
  id: string;
  userId: string;
  text: string;
  scheduledFor: Date;
  timerId: string;
}

interface ReminderState {
  reminders: Map<string, Reminder>;
  timerService: TimerServiceRef;
}

type ReminderCall =
  | { type: 'create'; userId: string; text: string; delayMs: number }
  | { type: 'cancel'; id: string }
  | { type: 'list'; userId: string }
  | { type: 'get'; id: string };

type ReminderCast =
  | { type: 'fire'; reminderId: string };

type ReminderReply = Reminder | Reminder[] | boolean | undefined;

// Reminder ID generator
let reminderIdCounter = 0;
function generateReminderId(): string {
  return `rem_${++reminderIdCounter}_${Date.now().toString(36)}`;
}

// ReminderService behavior
function createReminderBehavior(
  timerService: TimerServiceRef,
  onReminderFired: (reminder: Reminder) => void,
): GenServerBehavior<ReminderState, ReminderCall, ReminderCast, ReminderReply> {
  return {
    init: () => ({
      reminders: new Map(),
      timerService,
    }),

    handleCall: async (msg, state, self) => {
      switch (msg.type) {
        case 'create': {
          const id = generateReminderId();
          const scheduledFor = new Date(Date.now() + msg.delayMs);

          // Schedule the timer
          const timerId = await TimerService.schedule(
            state.timerService,
            self,
            { type: 'fire', reminderId: id },
            msg.delayMs,
          );

          const reminder: Reminder = {
            id,
            userId: msg.userId,
            text: msg.text,
            scheduledFor,
            timerId,
          };

          const newReminders = new Map(state.reminders);
          newReminders.set(id, reminder);

          return [reminder, { ...state, reminders: newReminders }];
        }

        case 'cancel': {
          const reminder = state.reminders.get(msg.id);
          if (!reminder) {
            return [false, state];
          }

          // Cancel the timer
          await TimerService.cancel(state.timerService, reminder.timerId);

          const newReminders = new Map(state.reminders);
          newReminders.delete(msg.id);

          return [true, { ...state, reminders: newReminders }];
        }

        case 'list': {
          const userReminders = Array.from(state.reminders.values())
            .filter(r => r.userId === msg.userId)
            .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
          return [userReminders, state];
        }

        case 'get': {
          return [state.reminders.get(msg.id), state];
        }
      }
    },

    handleCast: (msg, state) => {
      if (msg.type === 'fire') {
        const reminder = state.reminders.get(msg.reminderId);
        if (reminder) {
          // Fire the reminder callback
          onReminderFired(reminder);

          // Remove from state (one-shot reminder)
          const newReminders = new Map(state.reminders);
          newReminders.delete(msg.reminderId);
          return { ...state, reminders: newReminders };
        }
      }
      return state;
    },
  };
}

// ReminderService API
interface ReminderService {
  create(userId: string, text: string, delayMs: number): Promise<Reminder>;
  cancel(id: string): Promise<boolean>;
  list(userId: string): Promise<Reminder[]>;
  get(id: string): Promise<Reminder | undefined>;
  stop(): Promise<void>;
}

async function createReminderService(
  onReminderFired: (reminder: Reminder) => void,
): Promise<ReminderService> {
  const adapter = new SQLiteAdapter('./data/reminder-timers.db');
  const timerService = await TimerService.start({
    adapter,
    checkIntervalMs: 1000,
  });

  type ReminderRef = GenServerRef<ReminderState, ReminderCall, ReminderCast, ReminderReply>;
  const ref: ReminderRef = await GenServer.start(
    createReminderBehavior(timerService, onReminderFired)
  );

  return {
    async create(userId, text, delayMs) {
      return await GenServer.call(ref, { type: 'create', userId, text, delayMs }) as Reminder;
    },
    async cancel(id) {
      return await GenServer.call(ref, { type: 'cancel', id }) as boolean;
    },
    async list(userId) {
      return await GenServer.call(ref, { type: 'list', userId }) as Reminder[];
    },
    async get(id) {
      return await GenServer.call(ref, { type: 'get', id }) as Reminder | undefined;
    },
    async stop() {
      await GenServer.stop(ref);
      await TimerService.stop(timerService);
    },
  };
}

// Usage example
async function main() {
  const reminderService = await createReminderService((reminder) => {
    console.log(`\n🔔 REMINDER for ${reminder.userId}: ${reminder.text}`);
  });

  // Create some reminders
  const reminder1 = await reminderService.create(
    'user:alice',
    'Review pull request',
    5000,  // 5 seconds
  );
  console.log(`Created reminder: ${reminder1.id}`);
  console.log(`  Will fire at: ${reminder1.scheduledFor.toISOString()}`);

  const reminder2 = await reminderService.create(
    'user:alice',
    'Team standup meeting',
    10000,  // 10 seconds
  );
  console.log(`Created reminder: ${reminder2.id}`);

  const reminder3 = await reminderService.create(
    'user:bob',
    'Deploy to production',
    3000,  // 3 seconds
  );
  console.log(`Created reminder: ${reminder3.id}`);

  // List Alice's reminders
  const aliceReminders = await reminderService.list('user:alice');
  console.log(`\nAlice has ${aliceReminders.length} reminders:`);
  for (const r of aliceReminders) {
    console.log(`  - ${r.text} (${r.scheduledFor.toISOString()})`);
  }

  // Cancel one reminder
  await reminderService.cancel(reminder2.id);
  console.log(`\nCancelled reminder: ${reminder2.id}`);

  // Wait for reminders to fire
  console.log('\nWaiting for reminders...');
  await new Promise(resolve => setTimeout(resolve, 15000));

  await reminderService.stop();
  console.log('\nService stopped');
}

main();
```

**Expected output:**

```
Created reminder: rem_1_lx3abc
  Will fire at: 2024-01-25T10:00:05.000Z
Created reminder: rem_2_lx3abd
Created reminder: rem_3_lx3abe

Alice has 2 reminders:
  - Review pull request (2024-01-25T10:00:05.000Z)
  - Team standup meeting (2024-01-25T10:00:10.000Z)

Cancelled reminder: rem_2_lx3abd

Waiting for reminders...

🔔 REMINDER for user:bob: Deploy to production

🔔 REMINDER for user:alice: Review pull request

Service stopped
```

## Exercise: Scheduled Task Runner

Build a scheduled task runner that:
1. Allows scheduling tasks with cron-like delay specification
2. Supports one-shot and repeating tasks
3. Persists tasks across restarts
4. Provides a way to list, pause, and resume tasks
5. Logs task execution with timing information

**Starter code:**

```typescript
import {
  TimerService,
  GenServer,
  MemoryAdapter,
  type GenServerBehavior,
  type GenServerRef,
  type TimerServiceRef,
} from '@hamicek/noex';

interface ScheduledTask {
  id: string;
  name: string;
  handler: () => Promise<void> | void;
  intervalMs?: number;  // undefined = one-shot
  paused: boolean;
  lastRun?: Date;
  nextRun: Date;
  timerId?: string;
}

interface TaskRunner {
  start(): Promise<void>;
  scheduleOnce(name: string, handler: () => Promise<void> | void, delayMs: number): Promise<string>;
  scheduleRepeating(name: string, handler: () => Promise<void> | void, intervalMs: number): Promise<string>;
  pause(taskId: string): Promise<boolean>;
  resume(taskId: string): Promise<boolean>;
  cancel(taskId: string): Promise<boolean>;
  list(): Promise<ScheduledTask[]>;
  stop(): Promise<void>;
}

function createTaskRunner(): TaskRunner {
  // TODO: Implement the task runner

  return {
    async start() {
      // TODO: Start timer service
    },

    async scheduleOnce(name, handler, delayMs) {
      // TODO: Schedule a one-shot task
      throw new Error('Not implemented');
    },

    async scheduleRepeating(name, handler, intervalMs) {
      // TODO: Schedule a repeating task
      throw new Error('Not implemented');
    },

    async pause(taskId) {
      // TODO: Pause a task (cancel timer, keep task in list)
      throw new Error('Not implemented');
    },

    async resume(taskId) {
      // TODO: Resume a paused task
      throw new Error('Not implemented');
    },

    async cancel(taskId) {
      // TODO: Cancel and remove a task
      throw new Error('Not implemented');
    },

    async list() {
      // TODO: List all tasks with their status
      throw new Error('Not implemented');
    },

    async stop() {
      // TODO: Stop all timers and clean up
    },
  };
}
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
import {
  TimerService,
  GenServer,
  MemoryAdapter,
  type GenServerBehavior,
  type GenServerRef,
  type TimerServiceRef,
} from '@hamicek/noex';

interface ScheduledTask {
  id: string;
  name: string;
  handler: () => Promise<void> | void;
  intervalMs?: number;
  paused: boolean;
  lastRun?: Date;
  nextRun: Date;
  timerId?: string;
}

interface TaskRunnerState {
  tasks: Map<string, ScheduledTask>;
  timerService: TimerServiceRef;
}

type TaskCall =
  | { type: 'scheduleOnce'; name: string; handler: () => Promise<void> | void; delayMs: number }
  | { type: 'scheduleRepeating'; name: string; handler: () => Promise<void> | void; intervalMs: number }
  | { type: 'pause'; taskId: string }
  | { type: 'resume'; taskId: string }
  | { type: 'cancel'; taskId: string }
  | { type: 'list' };

type TaskCast = { type: 'execute'; taskId: string };

type TaskReply = string | boolean | ScheduledTask[];

let taskIdCounter = 0;
function generateTaskId(): string {
  return `task_${++taskIdCounter}_${Date.now().toString(36)}`;
}

function createTaskRunnerBehavior(
  timerService: TimerServiceRef,
): GenServerBehavior<TaskRunnerState, TaskCall, TaskCast, TaskReply> {
  async function scheduleTimer(
    self: GenServerRef<TaskRunnerState, TaskCall, TaskCast, TaskReply>,
    task: ScheduledTask,
    delayMs: number,
  ): Promise<string> {
    return await TimerService.schedule(
      timerService,
      self,
      { type: 'execute', taskId: task.id },
      delayMs,
      task.intervalMs ? { repeat: task.intervalMs } : undefined,
    );
  }

  return {
    init: () => ({
      tasks: new Map(),
      timerService,
    }),

    handleCall: async (msg, state, self) => {
      switch (msg.type) {
        case 'scheduleOnce': {
          const id = generateTaskId();
          const nextRun = new Date(Date.now() + msg.delayMs);

          const task: ScheduledTask = {
            id,
            name: msg.name,
            handler: msg.handler,
            intervalMs: undefined,
            paused: false,
            nextRun,
          };

          const timerId = await scheduleTimer(self, task, msg.delayMs);
          task.timerId = timerId;

          const newTasks = new Map(state.tasks);
          newTasks.set(id, task);

          console.log(`[TaskRunner] Scheduled one-shot task "${msg.name}" (${id}) for ${nextRun.toISOString()}`);
          return [id, { ...state, tasks: newTasks }];
        }

        case 'scheduleRepeating': {
          const id = generateTaskId();
          const nextRun = new Date(Date.now() + msg.intervalMs);

          const task: ScheduledTask = {
            id,
            name: msg.name,
            handler: msg.handler,
            intervalMs: msg.intervalMs,
            paused: false,
            nextRun,
          };

          const timerId = await scheduleTimer(self, task, msg.intervalMs);
          task.timerId = timerId;

          const newTasks = new Map(state.tasks);
          newTasks.set(id, task);

          console.log(`[TaskRunner] Scheduled repeating task "${msg.name}" (${id}) every ${msg.intervalMs}ms`);
          return [id, { ...state, tasks: newTasks }];
        }

        case 'pause': {
          const task = state.tasks.get(msg.taskId);
          if (!task || task.paused) {
            return [false, state];
          }

          // Cancel the timer but keep the task
          if (task.timerId) {
            await TimerService.cancel(timerService, task.timerId);
          }

          const pausedTask: ScheduledTask = {
            ...task,
            paused: true,
            timerId: undefined,
          };

          const newTasks = new Map(state.tasks);
          newTasks.set(msg.taskId, pausedTask);

          console.log(`[TaskRunner] Paused task "${task.name}" (${task.id})`);
          return [true, { ...state, tasks: newTasks }];
        }

        case 'resume': {
          const task = state.tasks.get(msg.taskId);
          if (!task || !task.paused) {
            return [false, state];
          }

          // Calculate delay (for repeating tasks, use interval; for one-shot, calculate remaining)
          const delayMs = task.intervalMs ?? Math.max(0, task.nextRun.getTime() - Date.now());
          const nextRun = new Date(Date.now() + delayMs);

          const resumedTask: ScheduledTask = {
            ...task,
            paused: false,
            nextRun,
          };

          const timerId = await scheduleTimer(self, resumedTask, delayMs);
          resumedTask.timerId = timerId;

          const newTasks = new Map(state.tasks);
          newTasks.set(msg.taskId, resumedTask);

          console.log(`[TaskRunner] Resumed task "${task.name}" (${task.id}), next run: ${nextRun.toISOString()}`);
          return [true, { ...state, tasks: newTasks }];
        }

        case 'cancel': {
          const task = state.tasks.get(msg.taskId);
          if (!task) {
            return [false, state];
          }

          if (task.timerId) {
            await TimerService.cancel(timerService, task.timerId);
          }

          const newTasks = new Map(state.tasks);
          newTasks.delete(msg.taskId);

          console.log(`[TaskRunner] Cancelled task "${task.name}" (${task.id})`);
          return [true, { ...state, tasks: newTasks }];
        }

        case 'list': {
          const taskList = Array.from(state.tasks.values()).map(t => ({
            ...t,
            handler: t.handler,  // Keep handler reference
          }));
          return [taskList, state];
        }
      }
    },

    handleCast: async (msg, state, self) => {
      if (msg.type === 'execute') {
        const task = state.tasks.get(msg.taskId);
        if (!task || task.paused) {
          return state;
        }

        const startTime = Date.now();
        console.log(`[TaskRunner] Executing task "${task.name}" (${task.id})`);

        try {
          await task.handler();
          const duration = Date.now() - startTime;
          console.log(`[TaskRunner] Task "${task.name}" completed in ${duration}ms`);
        } catch (error) {
          const duration = Date.now() - startTime;
          console.error(`[TaskRunner] Task "${task.name}" failed after ${duration}ms:`, error);
        }

        // Update task state
        const newTasks = new Map(state.tasks);

        if (task.intervalMs) {
          // Repeating task: update lastRun and nextRun
          const updatedTask: ScheduledTask = {
            ...task,
            lastRun: new Date(startTime),
            nextRun: new Date(Date.now() + task.intervalMs),
          };
          newTasks.set(task.id, updatedTask);
        } else {
          // One-shot task: remove from list
          newTasks.delete(task.id);
        }

        return { ...state, tasks: newTasks };
      }
      return state;
    },
  };
}

interface TaskRunner {
  start(): Promise<void>;
  scheduleOnce(name: string, handler: () => Promise<void> | void, delayMs: number): Promise<string>;
  scheduleRepeating(name: string, handler: () => Promise<void> | void, intervalMs: number): Promise<string>;
  pause(taskId: string): Promise<boolean>;
  resume(taskId: string): Promise<boolean>;
  cancel(taskId: string): Promise<boolean>;
  list(): Promise<ScheduledTask[]>;
  stop(): Promise<void>;
}

function createTaskRunner(): TaskRunner {
  let timerService: TimerServiceRef;
  let ref: GenServerRef<TaskRunnerState, TaskCall, TaskCast, TaskReply>;

  return {
    async start() {
      const adapter = new MemoryAdapter();
      timerService = await TimerService.start({
        adapter,
        checkIntervalMs: 100,  // 100ms resolution for demo
      });

      ref = await GenServer.start(createTaskRunnerBehavior(timerService));
      console.log('[TaskRunner] Started');
    },

    async scheduleOnce(name, handler, delayMs) {
      return await GenServer.call(ref, { type: 'scheduleOnce', name, handler, delayMs }) as string;
    },

    async scheduleRepeating(name, handler, intervalMs) {
      return await GenServer.call(ref, { type: 'scheduleRepeating', name, handler, intervalMs }) as string;
    },

    async pause(taskId) {
      return await GenServer.call(ref, { type: 'pause', taskId }) as boolean;
    },

    async resume(taskId) {
      return await GenServer.call(ref, { type: 'resume', taskId }) as boolean;
    },

    async cancel(taskId) {
      return await GenServer.call(ref, { type: 'cancel', taskId }) as boolean;
    },

    async list() {
      return await GenServer.call(ref, { type: 'list' }) as ScheduledTask[];
    },

    async stop() {
      await GenServer.stop(ref);
      await TimerService.stop(timerService);
      console.log('[TaskRunner] Stopped');
    },
  };
}

// Test the implementation
async function main() {
  const runner = createTaskRunner();
  await runner.start();

  // Schedule a one-shot task
  const cleanupId = await runner.scheduleOnce(
    'Database cleanup',
    () => console.log('  → Cleaning up old records...'),
    2000,
  );

  // Schedule repeating tasks
  const metricsId = await runner.scheduleRepeating(
    'Collect metrics',
    () => console.log('  → Collecting system metrics'),
    3000,
  );

  const heartbeatId = await runner.scheduleRepeating(
    'Heartbeat',
    () => console.log('  → ♥ heartbeat'),
    1500,
  );

  // List initial tasks
  console.log('\nInitial tasks:');
  const tasks = await runner.list();
  for (const task of tasks) {
    const status = task.paused ? '⏸ PAUSED' : '▶ ACTIVE';
    const type = task.intervalMs ? `every ${task.intervalMs}ms` : 'one-shot';
    console.log(`  ${task.name} (${task.id}): ${status}, ${type}`);
  }

  // Wait a bit
  console.log('\nRunning for 5 seconds...\n');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Pause heartbeat
  console.log('\nPausing heartbeat...');
  await runner.pause(heartbeatId);

  // Wait more
  console.log('Running for 3 more seconds (heartbeat paused)...\n');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Resume heartbeat
  console.log('\nResuming heartbeat...');
  await runner.resume(heartbeatId);

  // Wait more
  console.log('Running for 3 more seconds...\n');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // List final tasks
  console.log('\nFinal tasks:');
  const finalTasks = await runner.list();
  for (const task of finalTasks) {
    const status = task.paused ? '⏸ PAUSED' : '▶ ACTIVE';
    const lastRunStr = task.lastRun ? task.lastRun.toISOString() : 'never';
    console.log(`  ${task.name}: ${status}, last run: ${lastRunStr}`);
  }

  await runner.stop();
}

main();
```

**Key design decisions:**

1. **Separate state for task metadata** — Tasks track their own state (paused, lastRun, nextRun) independently from timers.

2. **Handler stored in memory** — Functions can't be serialized, so handlers are kept in memory. For true persistence across restarts, you'd need a task registry that maps task names to handlers.

3. **Pause/Resume** — Pausing cancels the timer but keeps the task in the list. Resuming creates a new timer.

4. **Timing information** — Each task execution logs duration for performance monitoring.

5. **Graceful cleanup** — One-shot tasks are automatically removed after execution.

**Sample output:**

```
[TaskRunner] Started
[TaskRunner] Scheduled one-shot task "Database cleanup" (task_1_lx4abc) for 2024-01-25T10:00:02.000Z
[TaskRunner] Scheduled repeating task "Collect metrics" (task_2_lx4abd) every 3000ms
[TaskRunner] Scheduled repeating task "Heartbeat" (task_3_lx4abe) every 1500ms

Initial tasks:
  Database cleanup (task_1_lx4abc): ▶ ACTIVE, one-shot
  Collect metrics (task_2_lx4abd): ▶ ACTIVE, every 3000ms
  Heartbeat (task_3_lx4abe): ▶ ACTIVE, every 1500ms

Running for 5 seconds...

[TaskRunner] Executing task "Heartbeat" (task_3_lx4abe)
  → ♥ heartbeat
[TaskRunner] Task "Heartbeat" completed in 1ms
[TaskRunner] Executing task "Database cleanup" (task_1_lx4abc)
  → Cleaning up old records...
[TaskRunner] Task "Database cleanup" completed in 0ms
[TaskRunner] Executing task "Collect metrics" (task_2_lx4abd)
  → Collecting system metrics
[TaskRunner] Task "Collect metrics" completed in 0ms
[TaskRunner] Executing task "Heartbeat" (task_3_lx4abe)
  → ♥ heartbeat
[TaskRunner] Task "Heartbeat" completed in 0ms
...

Pausing heartbeat...
[TaskRunner] Paused task "Heartbeat" (task_3_lx4abe)
Running for 3 more seconds (heartbeat paused)...

[TaskRunner] Executing task "Collect metrics" (task_2_lx4abd)
  → Collecting system metrics
[TaskRunner] Task "Collect metrics" completed in 0ms

Resuming heartbeat...
[TaskRunner] Resumed task "Heartbeat" (task_3_lx4abe), next run: 2024-01-25T10:00:09.500Z
...

Final tasks:
  Collect metrics: ▶ ACTIVE, last run: 2024-01-25T10:00:09.000Z
  Heartbeat: ▶ ACTIVE, last run: 2024-01-25T10:00:11.000Z

[TaskRunner] Stopped
```

</details>

## Summary

**Key takeaways:**

- **TimerService provides durable timers** — Persist across restarts via storage adapters
- **One-shot and repeating** — Use `repeat` option for periodic tasks
- **Automatic recovery** — Overdue timers fire immediately after restart
- **Message delivery via cast** — Target GenServer receives messages asynchronously
- **Configurable precision** — `checkIntervalMs` controls timer resolution

**Method reference:**

| Method | Returns | Description |
|--------|---------|-------------|
| `start(options)` | `Promise<Ref>` | Start timer service with adapter |
| `schedule(ref, target, msg, delay, opts?)` | `Promise<string>` | Schedule a timer, returns timer ID |
| `cancel(ref, timerId)` | `Promise<boolean>` | Cancel pending timer |
| `get(ref, timerId)` | `Promise<Entry \| undefined>` | Get timer details |
| `getAll(ref)` | `Promise<Entry[]>` | List all pending timers |
| `isRunning(ref)` | `boolean` | Check if service is running |
| `stop(ref)` | `Promise<void>` | Stop the service |

**Remember:**

> Durable timers ensure scheduled operations happen even after restarts. Use them for anything that must execute at a specific time — reminders, delayed notifications, scheduled maintenance, or retry mechanisms. For sub-second precision or truly ephemeral timers, stick with `setTimeout` or `GenServer.sendAfter`.

---

Next: [Application Structure](../09-application/01-application-structure.md)
