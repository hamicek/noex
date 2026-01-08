# Distribution

Erlang-style P2P clustering for noex, enabling transparent communication between GenServer instances across multiple nodes.

**noex distribution** brings battle-tested distributed systems patterns to TypeScript. Build fault-tolerant, horizontally scalable applications with the same primitives that power Erlang/OTP systems like WhatsApp and Discord.

## Why Distribution?

- **Horizontal Scalability**: Spread workloads across multiple nodes
- **Fault Tolerance**: Automatic failover when nodes crash
- **Location Transparency**: Call remote processes like local ones
- **Zero Configuration Discovery**: Seed-based P2P cluster formation

## Quick Navigation

| Section | Description |
|---------|-------------|
| [Overview](./concepts/overview.md) | Architecture, design principles, comparison with Erlang |
| [Cluster](./concepts/cluster.md) | Node discovery, membership, heartbeats |
| [Remote Messaging](./concepts/remote-messaging.md) | RemoteCall/Cast, serialization |
| [Global Registry](./concepts/global-registry.md) | Cluster-wide process naming |
| [Distributed Supervisor](./concepts/distributed-supervisor.md) | Multi-node supervision, failover |

## Getting Started

```typescript
import { GenServer } from 'noex';
import { Cluster, RemoteCall, BehaviorRegistry } from 'noex/distribution';

// 1. Register behaviors for remote spawning
BehaviorRegistry.register('counter', counterBehavior);

// 2. Start the cluster
await Cluster.start({
  nodeName: 'app1',
  port: 4369,
  seeds: ['app2@192.168.1.2:4369'],
});

// 3. Handle cluster events
Cluster.onNodeUp((node) => {
  console.log(`Node joined: ${node.id}`);
});

// 4. Call remote processes transparently
const result = await RemoteCall.call(remoteRef, { type: 'get' });

// 5. Graceful shutdown
await Cluster.stop();
```

## Core Components

### Cluster Layer

| Component | Purpose |
|-----------|---------|
| **[Cluster](./api/cluster.md)** | Node lifecycle, seed discovery, heartbeats |
| **Membership** | Track connected nodes, failure detection |
| **Transport** | TCP connections, message routing |

### Remote Communication

| Component | Purpose |
|-----------|---------|
| **[RemoteCall](./api/remote-call.md)** | Synchronous cross-node calls |
| **[RemoteSpawn](./api/remote-spawn.md)** | Start processes on remote nodes |
| **[BehaviorRegistry](./api/remote-spawn.md#behaviorregistry)** | Register behaviors for remote spawning |

### Coordination

| Component | Purpose |
|-----------|---------|
| **[GlobalRegistry](./api/global-registry.md)** | Cluster-wide process naming |
| **[RemoteMonitor](./api/remote-monitor.md)** | Cross-node process monitoring |
| **[DistributedSupervisor](./api/distributed-supervisor.md)** | Multi-node supervision trees |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Application                               │
├─────────────────────────────────────────────────────────────────┤
│  GlobalRegistry  │  DistributedSupervisor  │  RemoteMonitor     │
├─────────────────────────────────────────────────────────────────┤
│            RemoteCall / RemoteSpawn / BehaviorRegistry          │
├─────────────────────────────────────────────────────────────────┤
│                    Cluster + Membership                          │
├─────────────────────────────────────────────────────────────────┤
│                    Transport (TCP + Gossip)                      │
└─────────────────────────────────────────────────────────────────┘
```

## Examples

| Example | Demonstrates |
|---------|-------------|
| [distributed-chat](../../examples/distributed-chat/) | GlobalRegistry, RemoteSpawn, RemoteCall |
| [distributed-counter](../../examples/distributed-counter/) | RemoteMonitor, fault tolerance |
| [distributed-worker-pool](../../examples/distributed-worker-pool/) | DistributedSupervisor, load balancing |

## Quick Start by Use Case

### I want to...

**...form a cluster of nodes**
```typescript
await Cluster.start({
  nodeName: 'worker1',
  port: 4369,
  seeds: ['coordinator@192.168.1.1:4369'],
});
```
See: [Cluster Formation Guide](./guides/cluster-formation.md)

**...call a process on another node**
```typescript
const result = await RemoteCall.call(remoteRef, message);
```
See: [Remote Messaging](./concepts/remote-messaging.md)

**...spawn a process on a specific node**
```typescript
const ref = await RemoteSpawn.spawn('worker', targetNodeId);
```
See: [Remote Processes Guide](./guides/remote-processes.md)

**...register a process cluster-wide**
```typescript
await GlobalRegistry.register('leader', processRef);
const ref = GlobalRegistry.whereis('leader');
```
See: [Global Registry](./concepts/global-registry.md)

**...supervise processes across nodes**
```typescript
const supervisor = await DistributedSupervisor.start({
  strategy: 'one_for_one',
  children: [{ id: 'worker', behaviorName: 'worker' }],
});
```
See: [Distributed Supervisor](./concepts/distributed-supervisor.md)

## Configuration Reference

```typescript
interface ClusterConfig {
  nodeName: string;              // Required: unique node identifier
  host?: string;                 // Default: '0.0.0.0'
  port?: number;                 // Default: 4369
  seeds?: string[];              // Seed nodes for discovery
  clusterSecret?: string;        // HMAC authentication secret
  heartbeatIntervalMs?: number;  // Default: 5000
  heartbeatMissThreshold?: number; // Default: 3
}
```

See: [Cluster API Reference](./api/cluster.md) for complete configuration options.

## Related

- [Core Concepts](../concepts/index.md) - GenServer, Supervisor basics
- [API Reference](./api/index.md) - Complete distribution API
- [Production Deployment](./guides/production-deployment.md) - Docker, Kubernetes

---

*[Czech version](../cs/distribution/index.md)*
