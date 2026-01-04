# První aplikace

V tomto průvodci vytvoříte kompletní supervizovanou aplikaci s více službami, automatickými restarty a objevováním služeb pomocí Registry.

## Co budeme vytvářet

Jednoduchý správce úkolů se třemi službami:

1. **TaskService** - Spravuje seznam úkolů
2. **StatsService** - Sleduje statistiky (vytvořené úkoly, dokončené)
3. **Supervisor** - Spravuje obě služby a restartuje je při selhání

```
ApplicationSupervisor (one_for_one)
├── TaskService
└── StatsService
```

## Krok 1: Definice služeb

### StatsService

Sleduje statistiky aplikace:

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

// Stav
interface StatsState {
  tasksCreated: number;
  tasksCompleted: number;
}

// Zprávy
type StatsCallMsg = 'get_stats';
type StatsCastMsg = { type: 'task_created' } | { type: 'task_completed' };
type StatsReply = StatsState;

export const statsBehavior: GenServerBehavior<StatsState, StatsCallMsg, StatsCastMsg, StatsReply> = {
  init: () => ({
    tasksCreated: 0,
    tasksCompleted: 0,
  }),

  handleCall: (msg, state) => {
    return [state, state];
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'task_created':
        return { ...state, tasksCreated: state.tasksCreated + 1 };
      case 'task_completed':
        return { ...state, tasksCompleted: state.tasksCompleted + 1 };
    }
  },

  terminate: (reason) => {
    console.log(`StatsService ukončen: ${reason}`);
  },
};
```

### TaskService

Spravuje úkoly a notifikuje StatsService:

```typescript
import { GenServer, Registry, type GenServerBehavior } from 'noex';

// Typy
interface Task {
  id: string;
  title: string;
  completed: boolean;
}

interface TaskState {
  tasks: Map<string, Task>;
  nextId: number;
}

type TaskCallMsg =
  | { type: 'list' }
  | { type: 'get'; id: string };

type TaskCastMsg =
  | { type: 'create'; title: string }
  | { type: 'complete'; id: string }
  | { type: 'delete'; id: string };

type TaskReply = Task[] | Task | undefined;

export const taskBehavior: GenServerBehavior<TaskState, TaskCallMsg, TaskCastMsg, TaskReply> = {
  init: () => ({
    tasks: new Map(),
    nextId: 1,
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'list':
        return [Array.from(state.tasks.values()), state];
      case 'get':
        return [state.tasks.get(msg.id), state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'create': {
        const id = `task-${state.nextId}`;
        const task: Task = { id, title: msg.title, completed: false };
        state.tasks.set(id, task);

        // Notifikace StatsService
        const stats = Registry.whereis('stats');
        if (stats) {
          GenServer.cast(stats, { type: 'task_created' });
        }

        return { ...state, nextId: state.nextId + 1 };
      }

      case 'complete': {
        const task = state.tasks.get(msg.id);
        if (task && !task.completed) {
          state.tasks.set(msg.id, { ...task, completed: true });

          // Notifikace StatsService
          const stats = Registry.whereis('stats');
          if (stats) {
            GenServer.cast(stats, { type: 'task_completed' });
          }
        }
        return state;
      }

      case 'delete': {
        state.tasks.delete(msg.id);
        return state;
      }
    }
  },

  terminate: (reason) => {
    console.log(`TaskService ukončen: ${reason}`);
  },
};
```

## Krok 2: Vytvoření Supervisoru

```typescript
import { Supervisor, GenServer, Registry } from 'noex';
import { statsBehavior } from './stats-service';
import { taskBehavior } from './task-service';

async function startApplication() {
  const supervisor = await Supervisor.start({
    // Restart strategie: restartuje pouze neúspěšné dítě
    strategy: 'one_for_one',

    // Povolí max 3 restarty během 5 sekund
    restartIntensity: {
      maxRestarts: 3,
      withinMs: 5000,
    },

    children: [
      {
        id: 'stats',
        restart: 'permanent',  // Vždy restartovat
        start: async () => {
          const ref = await GenServer.start(statsBehavior);
          Registry.register('stats', ref);
          return ref;
        },
      },
      {
        id: 'tasks',
        restart: 'permanent',
        start: async () => {
          const ref = await GenServer.start(taskBehavior);
          Registry.register('tasks', ref);
          return ref;
        },
      },
    ],
  });

  console.log('Aplikace spuštěna!');
  return supervisor;
}
```

## Krok 3: Použití aplikace

```typescript
async function main() {
  const supervisor = await startApplication();

  // Získání referencí na služby z Registry
  const tasks = Registry.lookup('tasks');
  const stats = Registry.lookup('stats');

  // Vytvoření několika úkolů
  GenServer.cast(tasks, { type: 'create', title: 'Naučit se noex' });
  GenServer.cast(tasks, { type: 'create', title: 'Vytvořit aplikaci' });
  GenServer.cast(tasks, { type: 'create', title: 'Nasadit do produkce' });

  // Dokončení úkolu
  GenServer.cast(tasks, { type: 'complete', id: 'task-1' });

  // Počkáme chvíli na zpracování zpráv
  await new Promise(resolve => setTimeout(resolve, 100));

  // Kontrola statistik
  const currentStats = await GenServer.call(stats, 'get_stats');
  console.log('Statistiky:', currentStats);
  // Statistiky: { tasksCreated: 3, tasksCompleted: 1 }

  // Výpis úkolů
  const taskList = await GenServer.call(tasks, { type: 'list' });
  console.log('Úkoly:', taskList);

  // Elegantní ukončení
  await Supervisor.stop(supervisor);
  console.log('Aplikace ukončena.');
}

main().catch(console.error);
```

## Krok 4: Zpracování elegantního ukončení

V produkci zpracujte procesní signály:

```typescript
async function main() {
  const supervisor = await startApplication();

  // Zpracování signálů ukončení
  const shutdown = async () => {
    console.log('\nUkončování...');
    await Supervisor.stop(supervisor);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('Aplikace běží. Stiskněte Ctrl+C pro ukončení.');

  // Udržení procesu naživu
  await new Promise(() => {});
}
```

## Krok 5: Test odolnosti vůči chybám

Simulujme pád a sledujme, jak Supervisor restartuje službu:

```typescript
import { Observer } from 'noex';

// Přihlášení k odběru lifecycle událostí
GenServer.onLifecycleEvent((event) => {
  if (event.type === 'crashed') {
    console.log(`Služba spadla: ${event.ref.id}`);
  }
  if (event.type === 'restarted') {
    console.log(`Služba restartována: ${event.ref.id} (pokus ${event.attempt})`);
  }
});

// Simulace pádu přidáním metody, která vyhodí výjimku
const crashableTaskBehavior = {
  ...taskBehavior,
  handleCast: (msg, state) => {
    if (msg.type === 'crash') {
      throw new Error('Simulovaný pád!');
    }
    return taskBehavior.handleCast(msg, state);
  },
};

// Později spusťte pád:
// GenServer.cast(tasks, { type: 'crash' });
// Supervisor automaticky restartuje TaskService!
```

## Kompletní kód aplikace

Zde je kompletní aplikace v jednom souboru:

```typescript
import {
  GenServer,
  Supervisor,
  Registry,
  type GenServerBehavior
} from 'noex';

// ============ Stats Service ============
interface StatsState {
  tasksCreated: number;
  tasksCompleted: number;
}

type StatsCallMsg = 'get_stats';
type StatsCastMsg = { type: 'task_created' } | { type: 'task_completed' };

const statsBehavior: GenServerBehavior<StatsState, StatsCallMsg, StatsCastMsg, StatsState> = {
  init: () => ({ tasksCreated: 0, tasksCompleted: 0 }),
  handleCall: (msg, state) => [state, state],
  handleCast: (msg, state) => {
    if (msg.type === 'task_created') {
      return { ...state, tasksCreated: state.tasksCreated + 1 };
    }
    return { ...state, tasksCompleted: state.tasksCompleted + 1 };
  },
};

// ============ Task Service ============
interface Task {
  id: string;
  title: string;
  completed: boolean;
}

interface TaskState {
  tasks: Map<string, Task>;
  nextId: number;
}

type TaskCallMsg = { type: 'list' } | { type: 'get'; id: string };
type TaskCastMsg =
  | { type: 'create'; title: string }
  | { type: 'complete'; id: string };

const taskBehavior: GenServerBehavior<TaskState, TaskCallMsg, TaskCastMsg, Task[] | Task | undefined> = {
  init: () => ({ tasks: new Map(), nextId: 1 }),

  handleCall: (msg, state) => {
    if (msg.type === 'list') return [Array.from(state.tasks.values()), state];
    return [state.tasks.get(msg.id), state];
  },

  handleCast: (msg, state) => {
    if (msg.type === 'create') {
      const id = `task-${state.nextId}`;
      state.tasks.set(id, { id, title: msg.title, completed: false });
      Registry.whereis('stats') && GenServer.cast(Registry.lookup('stats'), { type: 'task_created' });
      return { ...state, nextId: state.nextId + 1 };
    }

    const task = state.tasks.get(msg.id);
    if (task && !task.completed) {
      state.tasks.set(msg.id, { ...task, completed: true });
      Registry.whereis('stats') && GenServer.cast(Registry.lookup('stats'), { type: 'task_completed' });
    }
    return state;
  },
};

// ============ Hlavní aplikace ============
async function main() {
  // Spuštění supervisoru s oběma službami
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      {
        id: 'stats',
        start: async () => {
          const ref = await GenServer.start(statsBehavior);
          Registry.register('stats', ref);
          return ref;
        },
      },
      {
        id: 'tasks',
        start: async () => {
          const ref = await GenServer.start(taskBehavior);
          Registry.register('tasks', ref);
          return ref;
        },
      },
    ],
  });

  // Použití služeb
  const tasks = Registry.lookup('tasks');
  const stats = Registry.lookup('stats');

  GenServer.cast(tasks, { type: 'create', title: 'Naučit se noex' });
  GenServer.cast(tasks, { type: 'create', title: 'Vytvořit něco skvělého' });
  GenServer.cast(tasks, { type: 'complete', id: 'task-1' });

  await new Promise(r => setTimeout(r, 50));

  console.log('Statistiky:', await GenServer.call(stats, 'get_stats'));
  console.log('Úkoly:', await GenServer.call(tasks, { type: 'list' }));

  // Ukončení
  await Supervisor.stop(supervisor);
}

main();
```

## Souhrn

Naučili jste se:

1. **Vytvářet GenServery** s typovaným stavem a zprávami
2. **Používat Supervisor** pro správu životního cyklu služeb
3. **Registrovat služby** v Registry pro objevování
4. **Zpracovávat elegantní ukončení** se správným zpracováním signálů
5. **Vytvářet odolné aplikace** s automatickými restarty

## Co dál?

- Naučte se více o [GenServer](../concepts/genserver.md) konceptech
- Pochopte [Supervisor](../concepts/supervisor.md) strategie
- Prozkoumejte vestavěné služby jako [EventBus](../api/event-bus.md) a [Cache](../api/cache.md)
- Projděte si kompletní [Tutoriály](../tutorials/index.md)

---

[Zpět na Začínáme](./index.md) | [Další: Základní koncepty](../concepts/index.md)
