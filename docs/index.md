# noex Documentation

Elixir-style GenServer and Supervisor patterns for TypeScript.

**noex** provides a robust abstraction for building stateful, fault-tolerant services in Node.js. Inspired by Elixir/OTP, it brings the GenServer and Supervisor patterns to TypeScript with full type safety.

## Why noex?

- **Fault Tolerance**: Build self-healing applications with automatic restart strategies
- **Predictable State**: Serialized message processing eliminates race conditions
- **Type Safety**: Full TypeScript support with branded types and strict typing
- **Zero Dependencies**: Core library is lightweight and focused
- **Familiar Patterns**: If you know Elixir/OTP, you'll feel right at home

## Quick Navigation

| Section | Description |
|---------|-------------|
| [Getting Started](./getting-started/index.md) | Installation, quick start, first application |
| [Core Concepts](./concepts/index.md) | GenServer, Supervisor, Registry, lifecycle |
| [Distribution](./distribution/index.md) | Clustering, remote processes, fault tolerance |
| [Guides](./guides/index.md) | Building services, supervision trees, testing |
| [Tutorials](./tutorials/index.md) | Step-by-step projects (chat server, e-commerce) |
| [API Reference](./api/index.md) | Complete API documentation |
| [Examples](./examples/index.md) | Code examples with explanations |
| [FAQ](./faq.md) | Frequently asked questions |

## Installation

```bash
npm install noex
```

Requires Node.js 20.0.0 or later.

## Quick Example

```typescript
import { GenServer, Supervisor, Registry } from 'noex';

// Define a counter service
const counterBehavior = {
  init: () => 0,
  handleCall: (msg: 'get', state: number) => [state, state] as const,
  handleCast: (msg: 'inc' | 'dec', state: number) =>
    msg === 'inc' ? state + 1 : state - 1,
};

// Start under supervision
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    {
      id: 'counter',
      start: async () => {
        const ref = await GenServer.start(counterBehavior);
        Registry.register('counter', ref);
        return ref;
      },
    },
  ],
});

// Use the service
const counter = Registry.lookup<number, 'get', 'inc' | 'dec', number>('counter');
GenServer.cast(counter, 'inc');
GenServer.cast(counter, 'inc');
const value = await GenServer.call(counter, 'get'); // 2

// Graceful shutdown
await Supervisor.stop(supervisor);
```

## Features at a Glance

### Core

| Feature | Description |
|---------|-------------|
| **GenServer** | Stateful services with serialized message processing |
| **Supervisor** | Automatic restart strategies (one_for_one, one_for_all, rest_for_one) |
| **Registry** | Named process lookup for loose coupling |

### Built-in Services

| Service | Description |
|---------|-------------|
| **EventBus** | Pub/sub messaging with wildcard pattern matching |
| **Cache** | In-memory cache with TTL and LRU eviction |
| **RateLimiter** | Sliding window rate limiting |

### Observability

| Feature | Description |
|---------|-------------|
| **Observer** | Real-time introspection into process state |
| **AlertManager** | Dynamic threshold alerting and anomaly detection |
| **Dashboard** | TUI-based monitoring interface |
| **DashboardServer** | Remote monitoring via TCP |

### Distribution

| Feature | Description |
|---------|-------------|
| **Cluster** | P2P node discovery and membership |
| **RemoteCall/Cast** | Transparent cross-node messaging |
| **GlobalRegistry** | Cluster-wide process naming |
| **DistributedSupervisor** | Multi-node supervision with failover |

## Learn More

- **New to noex?** Start with [Getting Started](./getting-started/index.md)
- **Coming from Elixir?** Check out [Elixir Comparison](./concepts/elixir-comparison.md)
- **Want to dive deep?** Read the [Core Concepts](./concepts/index.md)
- **Building distributed systems?** Explore [Distribution](./distribution/index.md)
- **Looking for examples?** Browse [Tutorials](./tutorials/index.md) and [Examples](./examples/index.md)

## Version

Current version: **0.1.0**

See the [Changelog](./changelog.md) for release history.

## Contributing

We welcome contributions! See the [Contributing Guide](./contributing.md) for details.

## License

MIT

---

*[Cesky / Czech version](./cs/index.md)*
