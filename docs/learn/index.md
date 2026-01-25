# Learning noex

A comprehensive guide for Node.js developers who want to understand and master the noex framework. This guide teaches not just the API, but the **way of thinking** in the actor model.

## Who Is This For?

- Node.js developers (intermediate+)
- You know async/await and Promises
- You don't need prior Erlang/OTP or actor model experience
- You're looking for robust patterns for stateful applications

## Learning Path

### Part 1: Introduction

Understand why noex exists and what problems it solves.

| Chapter | Description |
|---------|-------------|
| [1.1 Why noex?](./01-introduction/01-why-noex.md) | Problems with traditional Node.js apps and how actor model helps |
| [1.2 Key Concepts](./01-introduction/02-key-concepts.md) | Overview of processes, messages, supervision, and "let it crash" |

### Part 2: Basics

Learn the fundamental building blocks.

| Chapter | Description |
|---------|-------------|
| [2.1 First GenServer](./02-basics/01-first-genserver.md) | Create your first stateful service |
| [2.2 Process Lifecycle](./02-basics/02-lifecycle.md) | Start, running, terminate states |
| [2.3 Call vs Cast](./02-basics/03-call-vs-cast.md) | Synchronous vs asynchronous messaging |
| [2.4 Registry](./02-basics/04-registry.md) | Named process lookup |

### Part 3: Supervision

Build fault-tolerant applications.

| Chapter | Description |
|---------|-------------|
| [3.1 Why Supervisor?](./03-supervision/01-why-supervisor.md) | Automatic recovery from failures |
| [3.2 First Supervisor](./03-supervision/02-first-supervisor.md) | Creating supervised processes |
| [3.3 Restart Strategies](./03-supervision/03-restart-strategies.md) | one_for_one, one_for_all, rest_for_one |
| [3.4 Restart Intensity](./03-supervision/04-restart-intensity.md) | Preventing restart loops |
| [3.5 Supervision Trees](./03-supervision/05-supervision-trees.md) | Hierarchical fault isolation |

### Part 4: Thinking in Processes

Learn to decompose problems into processes.

| Chapter | Description |
|---------|-------------|
| [4.1 Mapping Problems](./04-thinking-in-processes/01-mapping-problems.md) | One process = one responsibility |
| [4.2 Inter-Process Communication](./04-thinking-in-processes/02-ipc.md) | Calls, casts, EventBus, Registry |
| [4.3 Patterns](./04-thinking-in-processes/03-patterns.md) | Request-response, worker pool, circuit breaker |

### Part 5: State Machine

Explicit states and transitions for complex business logic.

| Chapter | Description |
|---------|-------------|
| [5.1 When to Use](./05-state-machine/01-when-to-use.md) | State machine vs GenServer |
| [5.2 Defining States](./05-state-machine/02-defining-states.md) | States, events, transitions |
| [5.3 Order Workflow](./05-state-machine/03-order-workflow.md) | Practical example |

### Part 6: Persistence

Survive restarts and recover from crashes.

| Chapter | Description |
|---------|-------------|
| [6.1 Why Persistence?](./06-persistence/01-why-persistence.md) | State recovery after crash |
| [6.2 Storage Adapters](./06-persistence/02-storage-adapters.md) | Memory, File, SQLite |
| [6.3 Configuration](./06-persistence/03-configuration.md) | Snapshots, restore, shutdown |
| [6.4 Schema Versioning](./06-persistence/04-schema-versioning.md) | Migrations and versioning |

### Part 7: ETS

High-performance in-memory storage.

| Chapter | Description |
|---------|-------------|
| [7.1 What is ETS](./07-ets/01-what-is-ets.md) | Erlang Term Storage in TypeScript |
| [7.2 Table Types](./07-ets/02-table-types.md) | set, ordered_set, bag, duplicate_bag |
| [7.3 Practical Usage](./07-ets/03-practical-usage.md) | Cache, sessions, counters |

### Part 8: Built-in Services

Ready-to-use services for common needs.

| Chapter | Description |
|---------|-------------|
| [8.1 EventBus](./08-builtin-services/01-eventbus.md) | Pub/sub messaging |
| [8.2 Cache](./08-builtin-services/02-cache.md) | LRU cache with TTL |
| [8.3 RateLimiter](./08-builtin-services/03-ratelimiter.md) | Sliding window rate limiting |
| [8.4 TimerService](./08-builtin-services/04-timerservice.md) | Durable scheduled tasks |

### Part 9: Application

Structure production applications.

| Chapter | Description |
|---------|-------------|
| [9.1 Application Structure](./09-application/01-application-structure.md) | Entry point and lifecycle |
| [9.2 Signal Handling](./09-application/02-signal-handling.md) | SIGINT/SIGTERM cleanup |
| [9.3 Production Setup](./09-application/03-production-setup.md) | Config, logging, health checks |

### Part 10: Monitoring

Observe and debug your applications.

| Chapter | Description |
|---------|-------------|
| [10.1 Observer](./10-monitoring/01-observer.md) | Process introspection |
| [10.2 Dashboard](./10-monitoring/02-dashboard.md) | TUI and remote monitoring |
| [10.3 AlertManager](./10-monitoring/03-alertmanager.md) | Anomaly detection |
| [10.4 Debugging](./10-monitoring/04-debugging.md) | Common issues and techniques |

### Part 11: Distribution

Build distributed systems.

| Chapter | Description |
|---------|-------------|
| [11.1 Clustering Basics](./11-distribution/01-clustering-basics.md) | Nodes, discovery, heartbeats |
| [11.2 Remote Calls](./11-distribution/02-remote-calls.md) | Cross-node messaging |
| [11.3 Distributed Supervisor](./11-distribution/03-distributed-supervisor.md) | Multi-node supervision |

### Part 12: Projects

Apply everything in real projects.

| Chapter | Description |
|---------|-------------|
| [12.1 Chat Server](./12-projects/01-chat-server.md) | WebSocket + noex |
| [12.2 Task Queue](./12-projects/02-task-queue.md) | Job processing with workers |
| [12.3 API Gateway](./12-projects/03-api-gateway.md) | Rate limiting, caching, circuit breaker |

## Chapter Format

Each chapter includes:

1. **Introduction** - What you'll learn and why it matters
2. **Theory** - Concept explanation
3. **Example** - Runnable code with comments
4. **Exercise** - Practice task (where applicable)
5. **Summary** - Key takeaways
6. **Next Steps** - Link to next chapter

## Getting Help

- [API Reference](../api/index.md) - Complete API documentation
- [FAQ](../faq.md) - Frequently asked questions
- [Examples](../examples/index.md) - More code samples

---

Ready to start? Begin with [Why noex?](./01-introduction/01-why-noex.md)
