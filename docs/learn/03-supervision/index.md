# Part 3: Supervision

This section teaches you how to build fault-tolerant applications using Supervisors. You'll learn to embrace failures as a normal part of operation and let the system recover automatically.

## Chapters

### [3.1 Why Supervisor?](./01-why-supervisor.md)

Understand the need for automatic recovery:
- Processes fail - that's normal
- Automatic restart vs manual error handling
- Isolation - one failure doesn't affect others

### [3.2 First Supervisor](./02-first-supervisor.md)

Create your first supervised application:
- Creating a supervisor with children
- Child specs (`id`, `start`, `restart`)
- Monitoring restarts

### [3.3 Restart Strategies](./03-restart-strategies.md)

Learn the three restart strategies:
- `one_for_one` - restart only the failed child
- `one_for_all` - restart all children (dependent services)
- `rest_for_one` - restart failed + following children

### [3.4 Restart Intensity](./04-restart-intensity.md)

Prevent restart loops:
- `maxRestarts` and `withinMs`
- When supervisor gives up

### [3.5 Supervision Trees](./05-supervision-trees.md)

Build hierarchical fault isolation:
- Supervisor hierarchies
- Failure domain isolation
- Practical structure examples

## Exercise

Design a supervision tree for a chat application.

---

Start with: [Why Supervisor?](./01-why-supervisor.md)
