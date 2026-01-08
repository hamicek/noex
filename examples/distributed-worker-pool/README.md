# Distributed Worker Pool Example

A comprehensive example demonstrating `DistributedSupervisor` with automatic failover, node selection strategies, and distributed task processing.

## Features

- **DistributedSupervisor**: Manages workers across multiple nodes with automatic restart and migration
- **Node Selection Strategies**: `round_robin`, `least_loaded`, `local_first`, `random`
- **Automatic Failover**: Workers migrate to available nodes when their host node fails
- **Task Queue**: Centralized task distribution with pull-based worker model
- **Result Collection**: Aggregates task results with success/failure statistics

## Architecture

```
supervisor-node (Terminal 1)
  ├── TaskQueue (GlobalRegistry: "task-queue")
  ├── ResultCollector (GlobalRegistry: "results")
  └── DistributedSupervisor
        └── Manages workers across all nodes

worker-node-1 (Terminal 2)
  └── Workers spawned by DistributedSupervisor
        ├── worker_1
        └── worker_2

worker-node-2 (Terminal 3)
  └── Workers spawned by DistributedSupervisor
        ├── worker_3
        └── worker_4
```

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start Supervisor Node (Terminal 1)

```bash
npm run supervisor
```

### 3. Start Worker Nodes (Terminal 2, 3)

```bash
# Terminal 2
npm run worker1

# Terminal 3
npm run worker2
```

### 4. Add Workers and Submit Tasks (on Supervisor)

```bash
/add-worker      # Add a worker (uses round_robin by default)
/add-worker      # Add another worker
/batch 10        # Submit 10 tasks
/stats           # View statistics
/workers         # See worker distribution
```

## Supervisor Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/add-worker` | Add a new worker (distributed by strategy) |
| `/remove-worker <id>` | Remove a worker by ID |
| `/submit <task>` | Submit a single task |
| `/batch <n>` | Submit n random tasks |
| `/results [n]` | Show last n results (default: 10) |
| `/stats` | Show comprehensive statistics |
| `/strategy <type>` | Set node selection strategy |
| `/workers` | List all workers and their nodes |
| `/nodes` | List connected nodes |
| `/quit` | Shutdown gracefully |

## Worker Node Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/workers` | List workers on this node |
| `/crash <id>` | Simulate worker crash |
| `/slow <id>` | Set worker to 0.5x speed |
| `/fast <id>` | Set worker to 2x speed |
| `/normal <id>` | Reset worker to 1x speed |
| `/nodes` | List connected nodes |
| `/quit` | Disconnect from cluster |

## Demo Scenarios

### 1. Automatic Failover

1. Start supervisor + 2 worker nodes
2. Add 4 workers: `/add-worker` (4x)
3. Submit tasks: `/batch 20`
4. Kill a worker node (Ctrl+C on Terminal 2 or 3)
5. Observe workers migrate to surviving node
6. Check with `/workers` and `/stats`

### 2. Restart Strategies

The example uses `one_for_one` strategy, meaning only the crashed worker restarts. Other strategies available:

- `one_for_one`: Only restart the failed child
- `one_for_all`: Restart all children when one fails
- `rest_for_one`: Restart the failed child and all children started after it
- `simple_one_for_one`: Dynamic children from a template

### 3. Node Selection Strategies

```bash
/strategy round_robin    # Distribute workers evenly across nodes
/strategy least_loaded   # Prefer nodes with fewer workers
/strategy local_first    # Prefer local node, fallback to remote
/strategy random         # Random node selection
```

## Code Structure

```
distributed-worker-pool/
├── package.json
├── README.md
├── supervisor-node.ts   # Supervisor entry point
├── worker-node.ts       # Worker node entry point
└── shared/
    ├── types.ts         # TypeScript type definitions
    └── behaviors.ts     # GenServer behaviors (worker, taskQueue, resultCollector)
```

## Key Concepts

### Worker Behavior

Workers implement a pull-based model:
1. Worker requests work from TaskQueue
2. TaskQueue dispatches pending task to worker
3. Worker processes task (simulated delay)
4. Worker reports result to ResultCollector
5. Worker requests next task

### Distributed Supervision

```typescript
const supervisorRef = await DistributedSupervisor.start({
  strategy: 'one_for_one',
  nodeSelector: 'round_robin',
  restartIntensity: {
    maxRestarts: 10,
    withinMs: 60000,
  },
});

// Dynamically add workers
await DistributedSupervisor.startChild(supervisorRef, {
  id: 'worker_1',
  behavior: 'distributed-worker-pool:worker',
  restart: 'permanent',
});
```

### Global Registry

TaskQueue and ResultCollector register globally for cluster-wide discovery:

```typescript
await GlobalRegistry.register('task-queue', {
  id: taskQueueRef.id,
  nodeId: localNodeId,
});
```

## Requirements

- Node.js 18+
- TypeScript 5+
- noex with distribution module
