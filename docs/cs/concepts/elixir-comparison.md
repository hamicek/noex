# Srovnání s Elixir/OTP

noex přináší vzory z Elixir/OTP do TypeScriptu. Tento průvodce pomáhá vývojářům znalým Elixiru porozumět noex a pomáhá TypeScript vývojářům pochopit původ těchto vzorů.

## Přehled

| Elixir/OTP | noex | Poznámky |
|------------|------|----------|
| GenServer | GenServer | Základní abstrakce |
| Supervisor | Supervisor | Odolnost vůči chybám |
| Registry | Registry | Vyhledávání pojmenovaných procesů |
| Process | GenServer instance | V noex nejsou surové procesy |
| PID | GenServerRef | Neprůhledná reference |
| send/receive | cast/call | Předávání zpráv |

## GenServer

### Spuštění serveru

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

### Zpracování volání (calls)

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

### Zpracování castů

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

### Ukončení

**Elixir:**
```elixir
@impl true
def terminate(reason, state) do
  IO.puts("Ukončuji: #{inspect(reason)}")
  :ok
end
```

**noex:**
```typescript
terminate: (reason, state) => {
  console.log('Ukončuji:', reason);
}
```

## Supervisor

### Základní supervize

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

### Strategie restartování

| Elixir | noex | Chování |
|--------|------|---------|
| `:one_for_one` | `'one_for_one'` | Restartovat pouze spadlého potomka |
| `:one_for_all` | `'one_for_all'` | Restartovat všechny potomky |
| `:rest_for_one` | `'rest_for_one'` | Restartovat spadlého + pozdější potomky |

### Specifikace potomků

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

### Intenzita restartování

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

### Registrace procesů

**Elixir:**
```elixir
# Via tuple při startu
GenServer.start_link(MyServer, arg, name: {:via, Registry, {MyRegistry, "my_name"}})

# Nebo explicitní registrace
Registry.register(MyRegistry, "my_name", value)
```

**noex:**
```typescript
const ref = await GenServer.start(behavior);
Registry.register('my_name', ref);
```

### Vyhledávání procesů

**Elixir:**
```elixir
case Registry.lookup(MyRegistry, "my_name") do
  [{pid, _value}] -> GenServer.call(pid, :get)
  [] -> :not_found
end
```

**noex:**
```typescript
// Vyhazující verze
const ref = Registry.lookup('my_name');
await GenServer.call(ref, 'get');

// Nevyhazující verze
const ref = Registry.whereis('my_name');
if (ref) {
  await GenServer.call(ref, 'get');
}
```

## Klíčové rozdíly

### Žádné surové procesy

Elixir umožňuje spouštět surové procesy pomocí `spawn`:

```elixir
pid = spawn(fn ->
  receive do
    msg -> IO.puts(msg)
  end
end)
```

noex poskytuje pouze GenServer - všechny "procesy" jsou GenServery. To zjednodušuje model a pokrývá většinu případů použití.

### Žádné pattern matching

Elixir používá pattern matching pro zpracování zpráv:

```elixir
def handle_call({:get, key}, _from, state) do
  {:reply, Map.get(state, key), state}
end
```

noex používá diskriminované unie a podmínky:

```typescript
handleCall: (msg, state) => {
  if (msg.type === 'get') {
    return [state.get(msg.key), state];
  }
  // ...
}
```

### Synchronní API

Callbacky Elixir GenServeru mohou vracet různé tuply:

```elixir
{:reply, reply, new_state}
{:reply, reply, new_state, timeout}
{:noreply, new_state}
{:stop, reason, reply, new_state}
```

noex to zjednodušuje:
- `handleCall` vždy vrací `[reply, newState]`
- `handleCast` vždy vrací `newState`
- Zastavení se provádí přes `GenServer.stop()` nebo vyhozením výjimky

### Žádné linkované procesy

Elixir procesy mohou být linkovány pro obousměrnou propagaci pádů:

```elixir
Process.link(pid)
```

noex nemá linkování procesů. Místo toho použijte supervizní hierarchie.

### Žádné monitorování procesů

Elixir umožňuje monitorovat procesy pro ukončení:

```elixir
ref = Process.monitor(pid)
receive do
  {:DOWN, ^ref, :process, ^pid, reason} -> ...
end
```

noex místo toho používá události životního cyklu:

```typescript
GenServer.onLifecycleEvent((event) => {
  if (event.type === 'terminated' && event.ref.id === targetId) {
    // Ošetřit ukončení
  }
});
```

### TypeScript typová bezpečnost

noex přidává plnou TypeScript typovou bezpečnost, která v Elixiru není dostupná:

```typescript
// Typy zpráv jsou kontrolovány v době kompilace
type CallMsg = { type: 'get'; key: string } | { type: 'keys' };
type CallReply = string | undefined | string[];

const behavior: GenServerBehavior<State, CallMsg, CastMsg, CallReply> = {
  handleCall: (msg, state) => {
    // TypeScript ví, že msg je CallMsg
    // TypeScript vynucuje návratový typ [CallReply, State]
  },
};
```

### Žádné OTP behaviors

Elixir má mnoho OTP behaviors kromě GenServeru:
- `GenStage` - producer/consumer
- `GenEvent` - zpracování událostí
- `Task` - jednorázová asynchronní práce
- `Agent` - jednoduchý obal stavu

noex se zaměřuje na GenServer a Supervisor. Další vzory lze postavit nad nimi:

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

## Migrační vzory

### Z Elixir modulu na noex behavior

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

// Typy
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

// Klientské API (volitelný wrapper)
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

## Související

- [GenServer](./genserver.md) - GenServer detailně
- [Supervisor](./supervisor.md) - Vzory supervize
- [Registr](./registry.md) - Registrace procesů
