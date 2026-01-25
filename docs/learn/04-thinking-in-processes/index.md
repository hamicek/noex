# Part 4: Thinking in Processes

This section teaches you how to decompose problems into processes - the key mental shift for effective noex development.

## Chapters

### [4.1 Mapping Problems](./01-mapping-problems.md)

Learn to identify what should be a process:
- One process = one responsibility
- State that needs isolation = process
- Shared state anti-pattern

### [4.2 Inter-Process Communication](./02-ipc.md)

Communication patterns between processes:
- Direct calls (`call`/`cast`)
- EventBus for pub/sub
- Registry for discovery

### [4.3 Patterns](./03-patterns.md)

Common patterns for process-based architectures:
- Request-response pipeline
- Worker pool
- Circuit breaker
- Rate limiting

## Exercise

Refactor Express middleware to noex processes.

---

Start with: [Mapping Problems](./01-mapping-problems.md)
