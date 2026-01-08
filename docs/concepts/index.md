# Concepts

This section explains the core concepts and patterns behind noex. Understanding these fundamentals will help you design robust, fault-tolerant applications.

## Core Patterns

### [GenServer](./genserver.md)
The foundational building block for stateful services. Learn about:
- Message serialization and queuing
- Call vs Cast patterns
- Behavior callbacks
- Lifecycle management

### [Supervisor](./supervisor.md)
Fault tolerance through supervision trees:
- Restart strategies (one_for_one, one_for_all, rest_for_one)
- Child specifications
- Restart intensity limits
- Hierarchical supervision

### [Registry](./registry.md)
Named process lookup and discovery:
- Registering processes by name
- Looking up processes
- Automatic cleanup on termination

## Process Model

### [Lifecycle](./lifecycle.md)
Understanding process states and transitions:
- Initialization
- Running state
- Graceful shutdown
- Force termination

### [Error Handling](./error-handling.md)
How noex handles failures:
- Error propagation
- Crash isolation
- Recovery strategies
- Defensive programming patterns

## Background

### [Elixir Comparison](./elixir-comparison.md)
For developers familiar with Elixir/OTP:
- Mapping Elixir concepts to TypeScript
- Key differences and limitations
- Migration patterns

## Distribution

Build distributed systems with noex clustering capabilities.

### [Distribution Overview](../distribution/concepts/overview.md)
Introduction to distributed noex:
- P2P architecture without central coordination
- Node discovery and cluster formation
- When to use distribution

### [Cluster](../distribution/concepts/cluster.md)
Node discovery and membership:
- Cluster formation and seeds
- Heartbeats and failure detection
- Network partitions

### [Remote Messaging](../distribution/concepts/remote-messaging.md)
Cross-node communication:
- RemoteCall and RemoteCast
- Serialization and network transport
- Error handling patterns

### [GlobalRegistry](../distribution/concepts/global-registry.md)
Cluster-wide process naming:
- Registering processes across nodes
- Conflict resolution
- Lookup patterns

### [DistributedSupervisor](../distribution/concepts/distributed-supervisor.md)
Multi-node supervision:
- Failover strategies
- Process placement
- Node failure handling

## Quick Reference

| Concept | Purpose | Key Types |
|---------|---------|-----------|
| GenServer | Stateful processes | `GenServerBehavior`, `GenServerRef` |
| Supervisor | Fault tolerance | `SupervisorOptions`, `ChildSpec` |
| Registry | Process naming | `Registry.register()`, `Registry.lookup()` |

## Next Steps

- New to noex? Start with [GenServer](./genserver.md)
- Ready to build? See [Building Services](../guides/building-services.md)
- Want examples? Check [Examples](../examples/index.md)
