# Elixir/OTP Comparison

noex brings Elixir/OTP patterns to TypeScript. This guide helps developers familiar with Elixir understand noex, and helps TypeScript developers understand the origins of these patterns.

## Overview

| Elixir/OTP | noex | Notes |
|------------|------|-------|
| GenServer | GenServer | Core abstraction |
| Supervisor | Supervisor | Fault tolerance |
| Registry | Registry | Named process lookup |
| Process | GenServer instance | No raw processes in noex |
| PID | GenServerRef | Opaque reference |
| send/receive | cast/call | Message passing |

## GenServer

### Starting a Server

**Elixir:**
```elixir
defmodule Counter do
  use GenServer

  def start_link(initial) do
    GenServer.start_link(__MODULE__, initial, name: :counter)
  end

  @impl true
  def init(initial) do
    {:ok, initial}
  end
end

{:ok, pid} = Counter.start_link(0)
```

**noex:**
```typescript
import { GenServer, Registry, type GenServerBehavior } from 'noex';

const counterBehavior: GenServerBehavior<number, 'get', 'inc', number> = {
  init: () => 0,
  handleCall: (msg, state) => [state, state],
  handleCast: (msg, state) => state + 1,
};

const ref = await GenServer.start(counterBehavior);
Registry.register('counter', ref);
```

### Handling Calls

**Elixir:**
```elixir
@impl true
def handle_call(:get, _from, state) do
  {:reply, state, state}
end

def handle_call({:add, n}, _from, state) do
  new_state = state + n
  {:reply, new_state, new_state}
end
```

**noex:**
```typescript
type CallMsg = 'get' | { type: 'add'; n: number };

handleCall: (msg, state) => {
  if (msg === 'get') {
    return [state, state];
  }
  if (msg.type === 'add') {
    const newState = state + msg.n;
    return [newState, newState];
  }
  return [state, state];
}
```

### Handling Casts

**Elixir:**
```elixir
@impl true
def handle_cast(:increment, state) do
  {:noreply, state + 1}
end
```

**noex:**
```typescript
handleCast: (msg, state) => {
  if (msg === 'increment') {
    return state + 1;
  }
  return state;
}
```

### Termination

**Elixir:**
```elixir
@impl true
def terminate(reason, state) do
  IO.puts("Terminating: #{inspect(reason)}")
  :ok
end
```

**noex:**
```typescript
terminate: (reason, state) => {
  console.log('Terminating:', reason);
}
```

## Supervisor

### Basic Supervision

**Elixir:**
```elixir
defmodule MyApp.Supervisor do
  use Supervisor

  def start_link(init_arg) do
    Supervisor.start_link(__MODULE__, init_arg, name: __MODULE__)
  end

  @impl true
  def init(_init_arg) do
    children = [
      {Counter, 0},
      {Cache, []}
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end
end
```

**noex:**
```typescript
import { Supervisor, GenServer } from 'noex';

const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'counter', start: () => GenServer.start(counterBehavior) },
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },
  ],
});
```

### Restart Strategies

| Elixir | noex | Behavior |
|--------|------|----------|
| `:one_for_one` | `'one_for_one'` | Restart only crashed child |
| `:one_for_all` | `'one_for_all'` | Restart all children |
| `:rest_for_one` | `'rest_for_one'` | Restart crashed + later children |

### Child Specifications

**Elixir:**
```elixir
%{
  id: :worker,
  start: {Worker, :start_link, []},
  restart: :permanent,
  shutdown: 5000
}
```

**noex:**
```typescript
{
  id: 'worker',
  start: () => GenServer.start(workerBehavior),
  restart: 'permanent',
  shutdownTimeout: 5000,
}
```

### Restart Intensity

**Elixir:**
```elixir
Supervisor.init(children,
  strategy: :one_for_one,
  max_restarts: 3,
  max_seconds: 5
)
```

**noex:**
```typescript
await Supervisor.start({
  strategy: 'one_for_one',
  restartIntensity: {
    maxRestarts: 3,
    withinMs: 5000,
  },
  children: [...],
});
```

## Registry

### Registering Processes

**Elixir:**
```elixir
# Via tuple at start
GenServer.start_link(MyServer, arg, name: {:via, Registry, {MyRegistry, "my_name"}})

# Or explicit registration
Registry.register(MyRegistry, "my_name", value)
```

**noex:**
```typescript
const ref = await GenServer.start(behavior);
Registry.register('my_name', ref);
```

### Looking Up Processes

**Elixir:**
```elixir
case Registry.lookup(MyRegistry, "my_name") do
  [{pid, _value}] -> GenServer.call(pid, :get)
  [] -> :not_found
end
```

**noex:**
```typescript
// Throwing version
const ref = Registry.lookup('my_name');
await GenServer.call(ref, 'get');

// Non-throwing version
const ref = Registry.whereis('my_name');
if (ref) {
  await GenServer.call(ref, 'get');
}
```

## Key Differences

### No Raw Processes

Elixir allows spawning raw processes with `spawn`:

```elixir
pid = spawn(fn ->
  receive do
    msg -> IO.puts(msg)
  end
end)
```

noex only provides GenServer - all "processes" are GenServers. This simplifies the model while covering most use cases.

### No Pattern Matching

Elixir uses pattern matching for message handling:

```elixir
def handle_call({:get, key}, _from, state) do
  {:reply, Map.get(state, key), state}
end
```

noex uses discriminated unions and conditionals:

```typescript
handleCall: (msg, state) => {
  if (msg.type === 'get') {
    return [state.get(msg.key), state];
  }
  // ...
}
```

### Synchronous API

Elixir's GenServer callbacks can return various tuples:

```elixir
{:reply, reply, new_state}
{:reply, reply, new_state, timeout}
{:noreply, new_state}
{:stop, reason, reply, new_state}
```

noex simplifies this:
- `handleCall` always returns `[reply, newState]`
- `handleCast` always returns `newState`
- Stopping is done via `GenServer.stop()` or throwing

### No Linked Processes

Elixir processes can be linked for bidirectional crash propagation:

```elixir
Process.link(pid)
```

noex doesn't have process linking. Use supervision hierarchies instead.

### No Process Monitoring

Elixir allows monitoring processes for termination:

```elixir
ref = Process.monitor(pid)
receive do
  {:DOWN, ^ref, :process, ^pid, reason} -> ...
end
```

noex uses lifecycle events instead:

```typescript
GenServer.onLifecycleEvent((event) => {
  if (event.type === 'terminated' && event.ref.id === targetId) {
    // Handle termination
  }
});
```

### TypeScript Type Safety

noex adds full TypeScript type safety not available in Elixir:

```typescript
// Message types are checked at compile time
type CallMsg = { type: 'get'; key: string } | { type: 'keys' };
type CallReply = string | undefined | string[];

const behavior: GenServerBehavior<State, CallMsg, CastMsg, CallReply> = {
  handleCall: (msg, state) => {
    // TypeScript knows msg is CallMsg
    // TypeScript enforces return type is [CallReply, State]
  },
};
```

### No OTP Behaviors

Elixir has many OTP behaviors beyond GenServer:
- `GenStage` - producer/consumer
- `GenEvent` - event handling
- `Task` - one-off async work
- `Agent` - simple state wrapper

noex focuses on GenServer and Supervisor. Other patterns can be built on top:

```typescript
// Agent-like wrapper
class Agent<T> {
  constructor(private ref: GenServerRef<T, 'get' | T, T, T>) {}

  async get(): Promise<T> {
    return GenServer.call(this.ref, 'get');
  }

  async update(value: T): Promise<void> {
    GenServer.cast(this.ref, value);
  }
}
```

## Migration Patterns

### From Elixir Module to noex Behavior

**Elixir:**
```elixir
defmodule Cache do
  use GenServer

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: :cache)
  end

  def get(key), do: GenServer.call(:cache, {:get, key})
  def put(key, value), do: GenServer.cast(:cache, {:put, key, value})

  @impl true
  def init(_opts), do: {:ok, %{}}

  @impl true
  def handle_call({:get, key}, _from, state) do
    {:reply, Map.get(state, key), state}
  end

  @impl true
  def handle_cast({:put, key, value}, state) do
    {:noreply, Map.put(state, key, value)}
  end
end
```

**noex:**
```typescript
import { GenServer, Registry, type GenServerBehavior, type GenServerRef } from 'noex';

// Types
interface CacheState {
  data: Map<string, unknown>;
}
type CacheCall = { type: 'get'; key: string };
type CacheCast = { type: 'put'; key: string; value: unknown };
type CacheReply = unknown | undefined;

// Behavior
const cacheBehavior: GenServerBehavior<CacheState, CacheCall, CacheCast, CacheReply> = {
  init: () => ({ data: new Map() }),

  handleCall: (msg, state) => {
    if (msg.type === 'get') {
      return [state.data.get(msg.key), state];
    }
    return [undefined, state];
  },

  handleCast: (msg, state) => {
    if (msg.type === 'put') {
      state.data.set(msg.key, msg.value);
    }
    return state;
  },
};

// Client API (optional wrapper)
export class Cache {
  private constructor(private ref: GenServerRef<CacheState, CacheCall, CacheCast, CacheReply>) {}

  static async start(): Promise<Cache> {
    const ref = await GenServer.start(cacheBehavior);
    Registry.register('cache', ref);
    return new Cache(ref);
  }

  async get(key: string): Promise<unknown> {
    return GenServer.call(this.ref, { type: 'get', key });
  }

  put(key: string, value: unknown): void {
    GenServer.cast(this.ref, { type: 'put', key, value });
  }
}
```

## Related

- [GenServer](./genserver.md) - GenServer in detail
- [Supervisor](./supervisor.md) - Supervisor patterns
- [Registry](./registry.md) - Process registration
