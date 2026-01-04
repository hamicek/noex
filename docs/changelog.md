# Changelog

All notable changes to noex will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Comprehensive documentation site with tutorials and guides

---

## [0.1.0] - 2025-01-01

### Added

#### Core
- **GenServer** - Generic server pattern for stateful processes
  - Synchronous calls with `GenServer.call()`
  - Asynchronous casts with `GenServer.cast()`
  - Lifecycle hooks (`init`, `terminate`)
  - Configurable call timeout
  - Typed state and messages with full TypeScript support

- **Supervisor** - Fault-tolerant process supervision
  - Restart strategies: `one_for_one`, `one_for_all`, `rest_for_one`
  - Restart types: `permanent`, `temporary`, `transient`
  - Configurable restart intensity (max restarts within time window)
  - Hierarchical supervision trees

- **Registry** - Named process lookup
  - Register processes by name
  - Lookup processes by name
  - Automatic unregistration on process termination
  - Type-safe lookups

#### Built-in Services
- **EventBus** - Pub/sub messaging
  - Topic-based subscriptions
  - Wildcard pattern matching (`user.*`, `*.created`)
  - Async message delivery

- **Cache** - In-memory caching
  - TTL (time-to-live) support
  - LRU eviction policy
  - Configurable max size

- **RateLimiter** - Rate limiting
  - Sliding window algorithm
  - Configurable limits and windows
  - Per-key rate limiting

#### Observability
- **Observer** - Runtime introspection
  - Process state inspection
  - Message queue monitoring
  - Process statistics

- **AlertManager** - Alerting system
  - Threshold-based alerts
  - Anomaly detection
  - Alert handlers

- **Dashboard** - Terminal UI
  - Real-time process monitoring
  - CPU and memory usage
  - Interactive TUI interface

- **DashboardServer** - Remote monitoring
  - TCP server for remote dashboard connections
  - Multi-client support

### Technical Details
- Written in TypeScript with full type definitions
- Zero runtime dependencies (core library)
- ESM-only distribution
- Node.js 20.0.0+ required

---

## Version History

| Version | Release Date | Highlights |
|---------|--------------|------------|
| 0.1.0   | 2025-01-01   | Initial release with GenServer, Supervisor, Registry |

---

*For migration guides between versions, see [Migration Guide](./migration.md).*
