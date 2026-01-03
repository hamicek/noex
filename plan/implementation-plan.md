# Noex - GenServer/Supervisor Pattern pro TypeScript

## Přehled projektu

Implementace Elixir-style GenServer a Supervisor patternů v TypeScriptu. Cílem není napodobit BEAM VM, ale poskytnout elegantní abstrakci pro stavové služby s jednotným API a automatickým error recovery.

## Architektura

```
noex/
├── src/
│   ├── core/
│   │   ├── gen-server.ts      # GenServer abstrakce
│   │   ├── supervisor.ts      # Supervisor s restart strategiemi
│   │   ├── registry.ts        # Named process lookup
│   │   └── types.ts           # Sdílené typy
│   ├── services/
│   │   ├── event-bus.ts       # Pub/sub mezi servery
│   │   ├── cache.ts           # Ukázková Cache služba
│   │   └── rate-limiter.ts    # Ukázkový RateLimiter
│   └── index.ts               # Public API
├── tests/
├── examples/
├── package.json
└── tsconfig.json
```

## Implementační kroky

### Krok 1: Inicializace projektu [DONE]
- [x] Vytvořit `package.json` s názvem `noex`
- [x] Nastavit TypeScript (strict mode, ES2022 target)
- [x] Přidat dev dependencies: `typescript`, `vitest`, `@types/node`
- [x] Vytvořit základní adresářovou strukturu

### Krok 2: Core typy (`src/core/types.ts`)
```typescript
interface GenServerBehavior<State, CallMsg, CastMsg, CallReply> {
  init(): Promise<State>
  handleCall(msg: CallMsg, state: State): Promise<[CallReply, State]>
  handleCast(msg: CastMsg, state: State): Promise<State>
  terminate?(reason: TerminateReason, state: State): Promise<void>
}

type TerminateReason = 'normal' | 'shutdown' | { error: Error }

interface SupervisorSpec {
  id: string
  start: () => Promise<GenServerRef>
  restart: 'permanent' | 'transient' | 'temporary'
}

type RestartStrategy = 'one_for_one' | 'one_for_all' | 'rest_for_one'
```

### Krok 3: GenServer implementace (`src/core/gen-server.ts`)
- `GenServer.start()` - spustí server, zavolá `init()`
- `GenServer.call()` - synchronní request/response
- `GenServer.cast()` - asynchronní fire-and-forget
- `GenServer.stop()` - graceful shutdown
- Interní message queue pro serializaci zpráv
- Try/catch kolem handlerů s možností recovery

### Krok 4: Supervisor implementace (`src/core/supervisor.ts`)
- `Supervisor.start()` - spustí supervisor se spec children
- `Supervisor.startChild()` - dynamicky přidá child
- `Supervisor.terminateChild()` - zastaví child
- Restart strategie:
  - `one_for_one` - restartuj jen padlý proces
  - `one_for_all` - restartuj všechny při pádu jednoho
  - `rest_for_one` - restartuj padlý a všechny po něm
- Max restart intensity (např. max 3 restarty za 5 sekund)

### Krok 5: Registry (`src/core/registry.ts`)
- Pojmenované reference na GenServery
- `Registry.register(name, ref)`
- `Registry.lookup(name)`
- `Registry.unregister(name)`
- Automatické odregistrování při terminaci

### Krok 6: EventBus služba (`src/services/event-bus.ts`)
- Implementovaný jako GenServer
- `subscribe(topic, handler)`
- `publish(topic, message)`
- Wildcard topics (např. `user.*`)

### Krok 7: Ukázkové služby
- **Cache** - TTL, max size, LRU eviction
- **RateLimiter** - sliding window, per-key limits

### Krok 8: Testy a dokumentace
- Unit testy pro každou komponentu
- Integration testy pro supervisor tree
- README s příklady použití

## API ukázka (cílový stav)

```typescript
import { GenServer, Supervisor, Registry } from 'noex'

// Definice služby
class CounterServer extends GenServer<number, 'inc' | 'dec' | 'get', 'inc' | 'dec'> {
  async init() { return 0 }

  async handleCall(msg, state) {
    if (msg === 'get') return [state, state]
    throw new Error('Unknown call')
  }

  async handleCast(msg, state) {
    if (msg === 'inc') return state + 1
    if (msg === 'dec') return state - 1
    return state
  }
}

// Spuštění
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'counter', start: () => CounterServer.start() }
  ]
})

const counter = Registry.lookup('counter')
await counter.cast('inc')
const value = await counter.call('get') // 1
```

## Rozhodnutí

- **Název**: `noex`
- **Runtime**: Node.js only (ES2022+)
- **Logging**: Žádný vestavěný logger - knihovna emituje eventy, uživatel si napojí vlastní
- **Observability**: Event emitter pattern pro lifecycle hooks (onStart, onCrash, onRestart, onTerminate)
