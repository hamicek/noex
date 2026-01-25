# Part 2: Basics

This section covers the fundamental building blocks of noex. You'll learn how to create stateful services, understand their lifecycle, and communicate with them.

## Chapters

### [2.1 First GenServer](./01-first-genserver.md)

Create your first stateful service with GenServer:
- Installation
- Counter example
- `init()`, `handleCall()`, `handleCast()`

### [2.2 Process Lifecycle](./02-lifecycle.md)

Understand the states a process goes through:
- Start → Running → Terminated
- `terminate()` callback
- Graceful shutdown

### [2.3 Call vs Cast](./03-call-vs-cast.md)

Learn when to use each message pattern:
- `call()` - synchronous with response
- `cast()` - asynchronous fire-and-forget
- Timeouts and error handling

### [2.4 Registry](./04-registry.md)

Name your processes for easy discovery:
- Why name processes
- `Registry.whereis()` lookup
- Unique vs duplicate keys

## Exercise

By the end of this section, you'll build a key-value store as a GenServer.

---

Start with: [First GenServer](./01-first-genserver.md)
