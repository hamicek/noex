# Worker Pool

Dynamický pool workerů pro paralelní zpracování úloh.

## Přehled

Tento příklad ukazuje:
- DynamicSupervisor vzor pro správu workerů
- Distribuce úloh mezi workery
- Load balancing pomocí round-robin
- Elegantní škálování nahoru/dolů

## Kompletní kód

```typescript
import {
  GenServer,
  Supervisor,
  Registry,
  type GenServerBehavior,
  type GenServerRef,
  type ChildSpec,
} from 'noex';

// Typy workeru
interface WorkerState {
  id: number;
  tasksProcessed: number;
}

type WorkerCall = { type: 'process'; task: string };
type WorkerCast = { type: 'reset_stats' };
type WorkerReply = { result: string; workerId: number };

// Chování workeru
const workerBehavior = (id: number): GenServerBehavior<
  WorkerState,
  WorkerCall,
  WorkerCast,
  WorkerReply
> => ({
  init: () => ({ id, tasksProcessed: 0 }),

  handleCall: async (msg, state) => {
    switch (msg.type) {
      case 'process': {
        // Simulace zpracování
        await new Promise(resolve => setTimeout(resolve, 100));
        const result = `Zpracováno "${msg.task}" workerem ${state.id}`;
        return [
          { result, workerId: state.id },
          { ...state, tasksProcessed: state.tasksProcessed + 1 },
        ];
      }
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'reset_stats':
        return { ...state, tasksProcessed: 0 };
    }
  },
});

// Typy pool manageru
interface PoolState {
  workers: GenServerRef[];
  nextWorkerIndex: number;
  poolSize: number;
}

type PoolCall =
  | { type: 'submit'; task: string }
  | { type: 'get_stats' };

type PoolCast =
  | { type: 'scale'; count: number };

type PoolReply =
  | { result: string; workerId: number }
  | { workerCount: number; totalTasks: number };

// Chování pool manageru
const poolBehavior: GenServerBehavior<PoolState, PoolCall, PoolCast, PoolReply> = {
  init: async () => {
    const poolSize = 4;
    const workers: GenServerRef[] = [];

    // Spusť počáteční workery
    for (let i = 0; i < poolSize; i++) {
      const worker = await GenServer.start(workerBehavior(i));
      workers.push(worker);
    }

    return { workers, nextWorkerIndex: 0, poolSize };
  },

  handleCall: async (msg, state) => {
    switch (msg.type) {
      case 'submit': {
        // Round-robin výběr workeru
        const worker = state.workers[state.nextWorkerIndex];
        const nextIndex = (state.nextWorkerIndex + 1) % state.workers.length;

        // Deleguj na workera
        const result = await GenServer.call<WorkerReply>(worker, {
          type: 'process',
          task: msg.task,
        });

        return [result, { ...state, nextWorkerIndex: nextIndex }];
      }

      case 'get_stats': {
        return [
          { workerCount: state.workers.length, totalTasks: 0 },
          state,
        ];
      }
    }
  },

  handleCast: async (msg, state) => {
    switch (msg.type) {
      case 'scale': {
        const currentSize = state.workers.length;
        const targetSize = msg.count;

        if (targetSize > currentSize) {
          // Škálování nahoru
          const newWorkers = [...state.workers];
          for (let i = currentSize; i < targetSize; i++) {
            const worker = await GenServer.start(workerBehavior(i));
            newWorkers.push(worker);
          }
          return { ...state, workers: newWorkers };
        } else if (targetSize < currentSize) {
          // Škálování dolů
          const toRemove = state.workers.slice(targetSize);
          for (const worker of toRemove) {
            await GenServer.stop(worker);
          }
          return { ...state, workers: state.workers.slice(0, targetSize) };
        }

        return state;
      }
    }
  },

  terminate: async (_reason, state) => {
    // Zastav všechny workery při ukončení
    for (const worker of state.workers) {
      await GenServer.stop(worker);
    }
  },
};

// Main
async function main() {
  const pool = await GenServer.start(poolBehavior);

  // Odešli úlohy
  const tasks = ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'];

  console.log('Odesílám úlohy...\n');

  for (const task of tasks) {
    const result = await GenServer.call<{ result: string; workerId: number }>(
      pool,
      { type: 'submit', task }
    );
    console.log(`Výsledek: ${result.result}`);
  }

  // Odešli úlohy paralelně
  console.log('\nOdesílám úlohy paralelně...\n');

  const parallelTasks = ['parallel-1', 'parallel-2', 'parallel-3', 'parallel-4'];
  const results = await Promise.all(
    parallelTasks.map(task =>
      GenServer.call<{ result: string; workerId: number }>(
        pool,
        { type: 'submit', task }
      )
    )
  );

  for (const result of results) {
    console.log(`Výsledek: ${result.result}`);
  }

  // Škálování dolů
  console.log('\nŠkáluji pool na 2 workery...');
  GenServer.cast(pool, { type: 'scale', count: 2 });

  // Počkej na dokončení škálování
  await new Promise(resolve => setTimeout(resolve, 100));

  // Odešli další úlohy s menším poolem
  console.log('\nOdesílám s menším poolem...\n');

  for (const task of ['small-pool-1', 'small-pool-2', 'small-pool-3']) {
    const result = await GenServer.call<{ result: string; workerId: number }>(
      pool,
      { type: 'submit', task }
    );
    console.log(`Výsledek: ${result.result}`);
  }

  await GenServer.stop(pool);
  console.log('\nPool zastaven');
}

main().catch(console.error);
```

## Výstup

```
Odesílám úlohy...

Výsledek: Zpracováno "task-1" workerem 0
Výsledek: Zpracováno "task-2" workerem 1
Výsledek: Zpracováno "task-3" workerem 2
Výsledek: Zpracováno "task-4" workerem 3
Výsledek: Zpracováno "task-5" workerem 0

Odesílám úlohy paralelně...

Výsledek: Zpracováno "parallel-1" workerem 1
Výsledek: Zpracováno "parallel-2" workerem 2
Výsledek: Zpracováno "parallel-3" workerem 3
Výsledek: Zpracováno "parallel-4" workerem 0

Škáluji pool na 2 workery...

Odesílám s menším poolem...

Výsledek: Zpracováno "small-pool-1" workerem 0
Výsledek: Zpracováno "small-pool-2" workerem 1
Výsledek: Zpracováno "small-pool-3" workerem 0

Pool zastaven
```

## Klíčové vzory

### Round-Robin distribuce

```typescript
const worker = state.workers[state.nextWorkerIndex];
const nextIndex = (state.nextWorkerIndex + 1) % state.workers.length;
```

### Dynamické škálování

```typescript
// Škálování nahoru: přidej workery
for (let i = currentSize; i < targetSize; i++) {
  const worker = await GenServer.start(workerBehavior(i));
  newWorkers.push(worker);
}

// Škálování dolů: odeber workery
const toRemove = state.workers.slice(targetSize);
for (const worker of toRemove) {
  await GenServer.stop(worker);
}
```

### Supervizovaný worker pool

Pro fault-tolerant worker pooly použijte Supervisor:

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: Array.from({ length: 4 }, (_, i) => ({
    id: `worker-${i}`,
    start: () => GenServer.start(workerBehavior(i)),
    restart: 'permanent',
  })),
});
```

## Alternativa: Distribuce podle zátěže

Místo round-robin můžete distribuovat podle zatížení workeru:

```typescript
handleCall: async (msg, state) => {
  switch (msg.type) {
    case 'submit': {
      // Najdi workera s nejmenším počtem úloh
      let minTasks = Infinity;
      let selectedWorker = state.workers[0];

      for (const worker of state.workers) {
        const info = await GenServer.call<WorkerState>(worker, { type: 'get_info' });
        if (info.tasksProcessed < minTasks) {
          minTasks = info.tasksProcessed;
          selectedWorker = worker;
        }
      }

      const result = await GenServer.call<WorkerReply>(selectedWorker, {
        type: 'process',
        task: msg.task,
      });

      return [result, state];
    }
  }
},
```

## Související

- [Koncept Supervisor](../concepts/supervisor.md) - Strategie supervize
- [Průvodce Supervision Trees](../guides/supervision-trees.md) - Stavba supervision trees
- [Supervisor API](../api/supervisor.md) - Kompletní API reference
