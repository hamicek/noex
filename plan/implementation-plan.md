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

### Krok 2: Core typy (`src/core/types.ts`) [DONE]
- [x] `GenServerRef` - branded type pro reference na GenServer
- [x] `GenServerBehavior` - interface pro implementaci serveru (init, handleCall, handleCast, terminate)
- [x] `TerminateReason` - důvod ukončení ('normal' | 'shutdown' | { error: Error })
- [x] `ChildSpec` - specifikace child procesu pro Supervisor
- [x] `SupervisorStrategy` - strategie restartu ('one_for_one' | 'one_for_all' | 'rest_for_one')
- [x] `ChildRestartStrategy` - restart strategie pro child ('permanent' | 'transient' | 'temporary')
- [x] `RestartIntensity` - konfigurace limitu restartů
- [x] `SupervisorOptions`, `SupervisorRef` - typy pro Supervisor
- [x] `LifecycleEvent`, `LifecycleHandler` - eventy pro observability
- [x] Error classes - `CallTimeoutError`, `ServerNotRunningError`, `InitializationError`, `MaxRestartsExceededError`, `DuplicateChildError`, `ChildNotFoundError`, `NotRegisteredError`, `AlreadyRegisteredError`
- [x] `DEFAULTS` - výchozí hodnoty pro timeouty a limity
- [x] Comprehensive tests

### Krok 3: GenServer implementace (`src/core/gen-server.ts`) [DONE]
- [x] `GenServer.start()` - spustí server, zavolá `init()`
- [x] `GenServer.call()` - synchronní request/response
- [x] `GenServer.cast()` - asynchronní fire-and-forget
- [x] `GenServer.stop()` - graceful shutdown
- [x] Interní message queue pro serializaci zpráv
- [x] Try/catch kolem handlerů s možností recovery
- [x] Lifecycle events (started, terminated)
- [x] Comprehensive tests (32 test cases)

### Krok 4: Supervisor implementace (`src/core/supervisor.ts`) [DONE]
- [x] `Supervisor.start()` - spustí supervisor se spec children
- [x] `Supervisor.startChild()` - dynamicky přidá child
- [x] `Supervisor.terminateChild()` - zastaví child
- [x] `Supervisor.restartChild()` - manuální restart child
- [x] `Supervisor.getChildren()` / `Supervisor.getChild()` - introspekce
- [x] Restart strategie:
  - [x] `one_for_one` - restartuj jen padlý proces
  - [x] `one_for_all` - restartuj všechny při pádu jednoho
  - [x] `rest_for_one` - restartuj padlý a všechny po něm
- [x] Child restart strategie (permanent, transient, temporary)
- [x] Max restart intensity (např. max 3 restarty za 5 sekund)
- [x] Graceful shutdown s ordered termination
- [x] Lifecycle events
- [x] Comprehensive tests (38 test cases)

### Krok 5: Registry (`src/core/registry.ts`) [DONE]
- [x] Pojmenované reference na GenServery
- [x] `Registry.register(name, ref)` - registrace s AlreadyRegisteredError
- [x] `Registry.lookup(name)` - vyhledání s NotRegisteredError
- [x] `Registry.whereis(name)` - non-throwing varianta lookup
- [x] `Registry.unregister(name)` - idempotentní odregistrování
- [x] `Registry.isRegistered(name)` - kontrola existence
- [x] `Registry.getNames()` - seznam všech registrovaných jmen
- [x] `Registry.count()` - počet registrací
- [x] Automatické odregistrování při terminaci pomocí lifecycle events
- [x] Comprehensive tests (31 test cases)

### Krok 6: EventBus služba (`src/services/event-bus.ts`) [DONE]
- [x] Implementovaný jako GenServer
- [x] `subscribe(topic, handler)` - vrací unsubscribe funkci
- [x] `publish(topic, message)` - fire-and-forget
- [x] `publishSync(topic, message)` - synchronní varianta pro testování
- [x] Wildcard topics (`*` - globální, `user.*` - single-level, `*.*.event` - multi-level)
- [x] `getSubscriptionCount()` a `getTopics()` pro introspekci
- [x] Comprehensive tests (35 test cases)

### Krok 7: Ukázkové služby [DONE]
- [x] **Cache** - TTL, max size, LRU eviction
- [x] **RateLimiter** - sliding window, per-key limits

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
