# Procesové vzory

Nyní rozumíte, jak mapovat problémy na procesy a jak procesy komunikují. Pojďme prozkoumat běžné architektonické vzory. Tyto vzory jsou osvědčená řešení, která využívají silné stránky actor modelu — izolaci, zasílání zpráv a supervizi.

## Co se naučíte

- Request-Response Pipeline — sekvenční zpracování přes fáze
- Worker Pool — paralelní zpracování úloh s backpressure
- Circuit Breaker — ochrana systémů před kaskádovými selháními
- Rate Limiting — řízení propustnosti požadavků
- Kdy aplikovat každý vzor a implementační strategie

## Request-Response Pipeline

Pipeline zpracovává data přes sekvenční fáze, kde každá fáze transformuje nebo obohacuje data před předáním do další. Tento vzor je vhodný, když potřebujete:

- Jasné oddělení zájmů
- Nezávislé škálování fází
- Snadné ladění (inspekce dat mezi fázemi)
- Flexibilní kompozici (přidání/odebrání/přeuspořádání fází)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      REQUEST-RESPONSE PIPELINE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐  │
│  │  Input  │───▶│  Parse  │───▶│Validate │───▶│ Enrich  │───▶│  Store  │  │
│  └─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘  │
│                                                                             │
│  Každá fáze:                                                                │
│  • Je GenServer s izolovaným stavem                                         │
│  • Přijímá data přes call() z předchozí fáze                                │
│  • Transformuje data a vrací výsledek                                       │
│  • Může selhat nezávisle bez ovlivnění ostatních fází                       │
│                                                                             │
│  Výhody:                                                                    │
│  ✓ Jediná zodpovědnost per fáze                                            │
│  ✓ Snadné testování každé fáze izolovaně                                   │
│  ✓ Supervize může restartovat selhané fáze                                 │
│  ✓ Jasný tok dat pro ladění                                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Implementace: Pipeline API požadavků

```typescript
import { GenServer, Supervisor, Registry, type GenServerBehavior } from '@hamicek/noex';

// Typy pro pipeline
interface RawRequest {
  body: string;
  headers: Record<string, string>;
}

interface ParsedRequest {
  data: Record<string, unknown>;
  contentType: string;
}

interface ValidatedRequest {
  data: Record<string, unknown>;
  userId: string;
}

interface EnrichedRequest {
  data: Record<string, unknown>;
  userId: string;
  user: { id: string; name: string; email: string };
  timestamp: Date;
}

interface StoredResult {
  id: string;
  success: boolean;
}

// ============================================================================
// Fáze 1: Parser — Transformuje surový vstup na strukturovaná data
// ============================================================================

interface ParserState {
  parseCount: number;
}

type ParserCall = { type: 'parse'; request: RawRequest };

const parserBehavior: GenServerBehavior<ParserState, ParserCall, never, ParsedRequest> = {
  init: () => ({ parseCount: 0 }),

  handleCall(msg, state) {
    if (msg.type === 'parse') {
      const { body, headers } = msg.request;
      const contentType = headers['content-type'] ?? 'application/json';

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error('Invalid JSON body');
      }

      const result: ParsedRequest = { data, contentType };
      return [result, { parseCount: state.parseCount + 1 }];
    }
    throw new Error('Unknown message type');
  },

  handleCast: (_, state) => state,
};

// ============================================================================
// Fáze 2: Validator — Zajišťuje, že data splňují požadavky
// ============================================================================

interface ValidatorState {
  validCount: number;
  invalidCount: number;
}

type ValidatorCall = { type: 'validate'; request: ParsedRequest };

const validatorBehavior: GenServerBehavior<ValidatorState, ValidatorCall, never, ValidatedRequest> = {
  init: () => ({ validCount: 0, invalidCount: 0 }),

  handleCall(msg, state) {
    if (msg.type === 'validate') {
      const { data } = msg.request;

      // Validace povinných polí
      if (typeof data.userId !== 'string' || data.userId.length === 0) {
        return [
          { data: {}, userId: '' }, // Bude zachyceno jako chyba
          { ...state, invalidCount: state.invalidCount + 1 },
        ];
      }

      if (!data.action || typeof data.action !== 'string') {
        throw new Error('Missing or invalid action field');
      }

      const result: ValidatedRequest = {
        data,
        userId: data.userId as string,
      };

      return [result, { ...state, validCount: state.validCount + 1 }];
    }
    throw new Error('Unknown message type');
  },

  handleCast: (_, state) => state,
};

// ============================================================================
// Fáze 3: Enricher — Přidává kontext z externích zdrojů
// ============================================================================

interface EnricherState {
  userCache: Map<string, { id: string; name: string; email: string }>;
}

type EnricherCall = { type: 'enrich'; request: ValidatedRequest };

const enricherBehavior: GenServerBehavior<EnricherState, EnricherCall, never, EnrichedRequest> = {
  init: () => ({ userCache: new Map() }),

  async handleCall(msg, state) {
    if (msg.type === 'enrich') {
      const { data, userId } = msg.request;

      // Simulace vyhledání uživatele (v reálném kódu volání DB)
      let user = state.userCache.get(userId);
      if (!user) {
        // Simulace async načtení uživatele
        await new Promise(resolve => setTimeout(resolve, 10));
        user = {
          id: userId,
          name: `User ${userId}`,
          email: `user${userId}@example.com`,
        };
        state.userCache.set(userId, user);
      }

      const result: EnrichedRequest = {
        data,
        userId,
        user,
        timestamp: new Date(),
      };

      return [result, state];
    }
    throw new Error('Unknown message type');
  },

  handleCast: (_, state) => state,
};

// ============================================================================
// Fáze 4: Store — Ukládá zpracovaná data
// ============================================================================

interface StoreState {
  records: Map<string, EnrichedRequest>;
  nextId: number;
}

type StoreCall = { type: 'store'; request: EnrichedRequest };

const storeBehavior: GenServerBehavior<StoreState, StoreCall, never, StoredResult> = {
  init: () => ({ records: new Map(), nextId: 1 }),

  handleCall(msg, state) {
    if (msg.type === 'store') {
      const id = `record-${state.nextId}`;
      state.records.set(id, msg.request);

      const result: StoredResult = { id, success: true };
      return [result, { ...state, nextId: state.nextId + 1 }];
    }
    throw new Error('Unknown message type');
  },

  handleCast: (_, state) => state,
};

// ============================================================================
// Pipeline Orchestrátor — Koordinuje fáze
// ============================================================================

interface PipelineState {
  processedCount: number;
  errorCount: number;
}

type PipelineCall = { type: 'process'; request: RawRequest };

const pipelineBehavior: GenServerBehavior<PipelineState, PipelineCall, never, StoredResult> = {
  init: () => ({ processedCount: 0, errorCount: 0 }),

  async handleCall(msg, state) {
    if (msg.type === 'process') {
      try {
        // Fáze 1: Parse
        const parser = Registry.whereis('pipeline-parser');
        if (!parser) throw new Error('Parser not available');
        const parsed = await GenServer.call(parser, { type: 'parse', request: msg.request });

        // Fáze 2: Validate
        const validator = Registry.whereis('pipeline-validator');
        if (!validator) throw new Error('Validator not available');
        const validated = await GenServer.call(validator, { type: 'validate', request: parsed as ParsedRequest });

        // Fáze 3: Enrich
        const enricher = Registry.whereis('pipeline-enricher');
        if (!enricher) throw new Error('Enricher not available');
        const enriched = await GenServer.call(enricher, { type: 'enrich', request: validated as ValidatedRequest });

        // Fáze 4: Store
        const store = Registry.whereis('pipeline-store');
        if (!store) throw new Error('Store not available');
        const result = await GenServer.call(store, { type: 'store', request: enriched as EnrichedRequest });

        return [result as StoredResult, { ...state, processedCount: state.processedCount + 1 }];
      } catch (error) {
        return [
          { id: '', success: false },
          { ...state, errorCount: state.errorCount + 1 },
        ];
      }
    }
    throw new Error('Unknown message type');
  },

  handleCast: (_, state) => state,
};

// ============================================================================
// Spuštění Pipeline
// ============================================================================

async function startPipeline() {
  // Spuštění všech fází pod supervizí
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'parser', start: () => GenServer.start(parserBehavior, { name: 'pipeline-parser' }) },
      { id: 'validator', start: () => GenServer.start(validatorBehavior, { name: 'pipeline-validator' }) },
      { id: 'enricher', start: () => GenServer.start(enricherBehavior, { name: 'pipeline-enricher' }) },
      { id: 'store', start: () => GenServer.start(storeBehavior, { name: 'pipeline-store' }) },
      { id: 'orchestrator', start: () => GenServer.start(pipelineBehavior, { name: 'pipeline' }) },
    ],
  });

  return supervisor;
}

// Použití
async function demo() {
  await startPipeline();

  const pipeline = Registry.lookup('pipeline');

  const result = await GenServer.call(pipeline, {
    type: 'process',
    request: {
      body: JSON.stringify({ userId: 'u123', action: 'create', payload: { title: 'Hello' } }),
      headers: { 'content-type': 'application/json' },
    },
  });

  console.log(result); // { id: 'record-1', success: true }
}
```

### Kdy použít Pipeline

| Případ použití | Proč Pipeline funguje |
|---------------|----------------------|
| ETL zpracování | Jasné transformační fáze |
| Zpracování API požadavků | Validace → Auth → Business Logic → Response |
| Zpracování dokumentů | Parse → Validate → Transform → Store |
| Ingestace dat | Receive → Normalize → Validate → Index |

## Worker Pool

Worker pool zpracovává úlohy paralelně pomocí pevného počtu workerů. Tento vzor poskytuje:

- Omezenou konkurenci (prevence vyčerpání zdrojů)
- Backpressure (fronta se naplní, když jsou workery zaneprázdněné)
- Rozložení zátěže mezi workery
- Odolnost (pád workera neztratí frontu)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           WORKER POOL PATTERN                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                         ┌─────────────────────┐                             │
│                         │     Dispatcher      │                             │
│                         │   ┌───────────────┐ │                             │
│    Task ───────────────▶│   │  Task Queue   │ │                             │
│    Task ───────────────▶│   │ [T1][T2][T3]  │ │                             │
│    Task ───────────────▶│   └───────────────┘ │                             │
│                         └─────────┬───────────┘                             │
│                       ┌───────────┼───────────┐                             │
│                       ▼           ▼           ▼                             │
│                  ┌────────┐  ┌────────┐  ┌────────┐                         │
│                  │Worker 1│  │Worker 2│  │Worker 3│                         │
│                  │(zanep.)│  │ (idle) │  │(zanep.)│                         │
│                  └────────┘  └────────┘  └────────┘                         │
│                                                                             │
│  Tok:                                                                       │
│  1. Úlohy přijdou do dispatcheru a vstoupí do fronty                        │
│  2. Dispatcher přiřadí úlohy dostupným workerům                             │
│  3. Workery zpracují úlohy a hlásí dokončení                                │
│  4. Po dokončení worker požádá o další úlohu z fronty                       │
│                                                                             │
│  Backpressure:                                                              │
│  • Fronta má maximální velikost                                             │
│  • Když je plná, nové úlohy jsou odmítnuty nebo volající blokuje            │
│  • Prevence vyčerpání paměti při zátěži                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Pokyny pro dimensování Worker Pool

| Faktor | Doporučení |
|--------|-----------|
| CPU-náročné úlohy | Workery = počet CPU jader |
| I/O-náročné úlohy | Workery = CPU jader × 2-4 |
| Smíšená zátěž | Začněte s CPU jader × 2, upravte podle metrik |
| Paměťově náročné úlohy | Méně workerů, větší fronta |

## Circuit Breaker

Circuit breaker zabraňuje kaskádovým selháním "otevřením", když downstream služba opakovaně selhává. To chrání váš systém před:

- Vyčerpáním zdrojů (vlákna/spojení čekající na timeout)
- Kaskádovými selháními (jedno selhání srazí celý systém)
- Thundering herd při obnově (všechny požadavky naráz na obnovující se službu)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        STAVY CIRCUIT BREAKERU                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                    ┌─────────────────────────────────────┐                  │
│                    │           CLOSED (ZAVŘENÝ)          │                  │
│                    │    (Normální provoz)                │                  │
│                    │                                     │                  │
│                    │  • Požadavky procházejí             │                  │
│                    │  • Selhání se počítají              │                  │
│                    │  • Úspěch resetuje počet selhání    │                  │
│                    └──────────────┬──────────────────────┘                  │
│                                   │                                         │
│                    selhání > práh                                           │
│                                   │                                         │
│                                   ▼                                         │
│                    ┌─────────────────────────────────────┐                  │
│                    │            OPEN (OTEVŘENÝ)          │                  │
│                    │    (Rychlé selhávání)               │                  │
│                    │                                     │                  │
│                    │  • Požadavky selhávají okamžitě     │                  │
│                    │  • Žádná volání downstream          │                  │
│                    │  • Spustí se časovač pro obnovu     │                  │
│                    └──────────────┬──────────────────────┘                  │
│                                   │                                         │
│                         timeout vypršel                                     │
│                                   │                                         │
│                                   ▼                                         │
│                    ┌─────────────────────────────────────┐                  │
│                    │         HALF-OPEN (POLO-OTEVŘENÝ)   │                  │
│                    │    (Testování obnovy)               │                  │
│                    │                                     │                  │
│                    │  • Omezený počet požadavků prochází │                  │
│                    │  • Úspěch → CLOSED                  │                  │
│                    │  • Selhání → OPEN (reset časovače)  │                  │
│                    └─────────────────────────────────────┘                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Implementace: Circuit Breaker služba

```typescript
import { GenServer, Registry, type GenServerBehavior } from '@hamicek/noex';

// Stavy circuit breakeru
type CircuitState = 'closed' | 'open' | 'half_open';

interface CircuitBreakerConfig {
  failureThreshold: number;    // Selhání před otevřením
  successThreshold: number;    // Úspěchy v half-open pro zavření
  timeout: number;             // Ms čekání před half-open
  name: string;                // Identifikátor služby
}

interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
  config: CircuitBreakerConfig;
}

type CircuitBreakerCall =
  | { type: 'execute'; fn: () => Promise<unknown> }
  | { type: 'getState' }
  | { type: 'reset' };

type CircuitBreakerReply =
  | { success: true; result: unknown }
  | { success: false; error: string; circuitOpen: boolean }
  | CircuitState
  | boolean;

const createCircuitBreakerBehavior = (
  config: CircuitBreakerConfig,
): GenServerBehavior<CircuitBreakerState, CircuitBreakerCall, never, CircuitBreakerReply> => ({
  init: () => ({
    state: 'closed',
    failureCount: 0,
    successCount: 0,
    lastFailureTime: 0,
    config,
  }),

  async handleCall(msg, state) {
    switch (msg.type) {
      case 'execute': {
        // Kontrola, zda by circuit měl přejít z open do half-open
        if (state.state === 'open') {
          const timeSinceFailure = Date.now() - state.lastFailureTime;
          if (timeSinceFailure >= state.config.timeout) {
            state.state = 'half_open';
            state.successCount = 0;
            console.log(`[CircuitBreaker:${state.config.name}] Přechod do half-open`);
          }
        }

        // Pokud je stále otevřený, rychle selhej
        if (state.state === 'open') {
          return [
            { success: false, error: 'Circuit breaker is open', circuitOpen: true },
            state,
          ];
        }

        // Spuštění funkce
        try {
          const result = await msg.fn();

          // Zpracování úspěchu
          if (state.state === 'half_open') {
            state.successCount++;
            if (state.successCount >= state.config.successThreshold) {
              state.state = 'closed';
              state.failureCount = 0;
              state.successCount = 0;
              console.log(`[CircuitBreaker:${state.config.name}] Circuit zavřen`);
            }
          } else {
            // Reset počtu selhání při úspěchu v closed stavu
            state.failureCount = 0;
          }

          return [{ success: true, result }, state];

        } catch (error) {
          // Zpracování selhání
          state.failureCount++;
          state.lastFailureTime = Date.now();

          if (state.state === 'half_open') {
            // Jakékoli selhání v half-open znovu otevře circuit
            state.state = 'open';
            state.successCount = 0;
            console.log(`[CircuitBreaker:${state.config.name}] Circuit znovu otevřen po half-open selhání`);
          } else if (state.failureCount >= state.config.failureThreshold) {
            state.state = 'open';
            console.log(`[CircuitBreaker:${state.config.name}] Circuit otevřen po ${state.failureCount} selháních`);
          }

          return [
            {
              success: false,
              error: error instanceof Error ? error.message : String(error),
              circuitOpen: state.state === 'open',
            },
            state,
          ];
        }
      }

      case 'getState':
        return [state.state, state];

      case 'reset':
        return [
          true,
          { ...state, state: 'closed', failureCount: 0, successCount: 0 },
        ];
    }
  },

  handleCast: (_, state) => state,
});

// ============================================================================
// Circuit Breaker Wrapper — Snadno použitelné API
// ============================================================================

export const CircuitBreaker = {
  async start(config: CircuitBreakerConfig) {
    const behavior = createCircuitBreakerBehavior(config);
    return GenServer.start(behavior, { name: `circuit-breaker:${config.name}` });
  },

  async execute<T>(
    ref: ReturnType<typeof GenServer.start>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const result = await GenServer.call(await ref, { type: 'execute', fn }) as CircuitBreakerReply;

    if ('success' in result) {
      if (result.success) {
        return result.result as T;
      }
      const error = new Error(result.error);
      (error as Error & { circuitOpen: boolean }).circuitOpen = result.circuitOpen;
      throw error;
    }
    throw new Error('Unexpected response');
  },

  async getState(ref: ReturnType<typeof GenServer.start>): Promise<CircuitState> {
    return GenServer.call(await ref, { type: 'getState' }) as Promise<CircuitState>;
  },

  async reset(ref: ReturnType<typeof GenServer.start>): Promise<void> {
    await GenServer.call(await ref, { type: 'reset' });
  },
};
```

### Pokyny pro konfiguraci Circuit Breakeru

| Parametr | Nízká tolerance | Střední | Vysoká tolerance |
|----------|----------------|---------|------------------|
| `failureThreshold` | 2-3 | 5-10 | 15-20 |
| `successThreshold` | 1-2 | 3-5 | 5-10 |
| `timeout` | 5-10s | 30-60s | 2-5min |

## Rate Limiting

Rate limiting řídí propustnost požadavků pro ochranu služeb před přetížením. Framework noex obsahuje vestavěnou službu `RateLimiter`, ale porozumění vzoru vám pomůže ji přizpůsobit.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      SLIDING WINDOW RATE LIMITING                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Časové okno: 1 minuta (60 000 ms)                                          │
│  Limit: 100 požadavků                                                       │
│                                                                             │
│  Okno se kontinuálně posouvá s časem:                                       │
│                                                                             │
│  ──────────────────────────────────────────────────────────────────────▶   │
│  │←───────────── 60 sekund ──────────────▶│                                │
│  │                                         │                                │
│  │  [r1] [r2] [r3] ... [r95] [r96] [r97]  │  [NOVÝ POŽADAVEK]              │
│  │   ▲                                     │       │                        │
│  │   │                                     │       ▼                        │
│  │   └── nejstarší požadavek ──────────────┘   Počet = 97                  │
│  │       (vyprší za 5 sekund)                 Povolen? ANO (97 < 100)      │
│  │                                                                          │
│  └──────────────────────────────────────────────────────────────────────   │
│                                                                             │
│  Klíčové výhody Sliding Window:                                             │
│  • Žádný problém "burst na hranici"                                         │
│  • Plynulý rate limiting v čase                                             │
│  • Přesné počítání požadavků                                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Použití vestavěného RateLimiteru

```typescript
import { RateLimiter, type RateLimitResult } from '@hamicek/noex';

async function rateLimiterDemo() {
  // Spuštění rate limiteru: 10 požadavků za minutu
  const limiter = await RateLimiter.start({
    maxRequests: 10,
    windowMs: 60000,
    name: 'api-limiter',
  });

  // Simulace API požadavků
  async function handleRequest(userId: string): Promise<string> {
    const key = `user:${userId}`;

    // Kontrola rate limitu před zpracováním
    const result = await RateLimiter.check(limiter, key);

    if (!result.allowed) {
      return `Rate limited. Retry after ${result.retryAfterMs}ms. ` +
             `Used: ${result.current}/${result.limit}`;
    }

    // Spotřebování jednoho slotu požadavku
    await RateLimiter.consume(limiter, key);

    // Zpracování požadavku
    return `Request processed. Remaining: ${result.remaining - 1}/${result.limit}`;
  }

  // Test s více požadavky
  for (let i = 0; i < 15; i++) {
    const response = await handleRequest('user123');
    console.log(`Request ${i + 1}: ${response}`);
  }

  // Kontrola stavu
  const status = await RateLimiter.getStatus(limiter, 'user:user123');
  console.log('\nFinal status:', status);

  await RateLimiter.stop(limiter);
}
```

### Víceúrovňový Rate Limiting

Různé limity pro různé typy operací:

```typescript
import { GenServer, Supervisor, Registry, type GenServerBehavior } from '@hamicek/noex';
import { RateLimiter, type RateLimitResult, type RateLimiterRef } from '@hamicek/noex';

interface TieredLimiterState {
  limiters: Map<string, RateLimiterRef>;
}

type TierConfig = {
  name: string;
  maxRequests: number;
  windowMs: number;
};

const tiers: TierConfig[] = [
  { name: 'read', maxRequests: 1000, windowMs: 60000 },   // 1000/min pro čtení
  { name: 'write', maxRequests: 100, windowMs: 60000 },   // 100/min pro zápis
  { name: 'admin', maxRequests: 10, windowMs: 60000 },    // 10/min pro admin operace
];

type TieredCall =
  | { type: 'check'; tier: string; key: string }
  | { type: 'consume'; tier: string; key: string };

const tieredLimiterBehavior: GenServerBehavior<TieredLimiterState, TieredCall, never, RateLimitResult> = {
  async init() {
    const limiters = new Map<string, RateLimiterRef>();

    for (const tier of tiers) {
      const limiter = await RateLimiter.start({
        maxRequests: tier.maxRequests,
        windowMs: tier.windowMs,
        name: `tier-${tier.name}`,
      });
      limiters.set(tier.name, limiter);
    }

    return { limiters };
  },

  async handleCall(msg, state) {
    const limiter = state.limiters.get(msg.tier);
    if (!limiter) {
      throw new Error(`Unknown tier: ${msg.tier}`);
    }

    if (msg.type === 'check') {
      const result = await RateLimiter.check(limiter, msg.key);
      return [result, state];
    }

    // consume
    try {
      const result = await RateLimiter.consume(limiter, msg.key);
      return [result, state];
    } catch (error) {
      // Vrať status rate limitu i při překročení limitu
      const status = await RateLimiter.getStatus(limiter, msg.key);
      return [status, state];
    }
  },

  handleCast: (_, state) => state,

  async terminate(_, state) {
    for (const limiter of state.limiters.values()) {
      await RateLimiter.stop(limiter);
    }
  },
};
```

## Kombinování vzorů

Reálné systémy často kombinují více vzorů. Zde je příklad kombinace rate limiting a circuit breaker:

```typescript
import { GenServer, Registry, type GenServerBehavior } from '@hamicek/noex';
import { RateLimiter } from '@hamicek/noex';

// Odolný API klient kombinující rate limiting + circuit breaker
interface ResilientClientState {
  circuitState: 'closed' | 'open' | 'half_open';
  failureCount: number;
  lastFailureTime: number;
  successCount: number;
}

interface ResilientClientConfig {
  // Rate limiting
  maxRequestsPerMinute: number;
  // Circuit breaker
  failureThreshold: number;
  successThreshold: number;
  circuitTimeout: number;
}

type ClientCall = {
  type: 'request';
  key: string;
  fn: () => Promise<unknown>;
};

const createResilientClientBehavior = (
  config: ResilientClientConfig,
): GenServerBehavior<ResilientClientState, ClientCall, never, unknown> => ({
  init: () => ({
    circuitState: 'closed',
    failureCount: 0,
    lastFailureTime: 0,
    successCount: 0,
  }),

  async handleCall(msg, state) {
    if (msg.type === 'request') {
      // Krok 1: Kontrola rate limitu
      const limiter = Registry.whereis('client-rate-limiter');
      if (limiter) {
        const rateResult = await RateLimiter.check(limiter as any, msg.key);
        if (!rateResult.allowed) {
          throw new Error(`Rate limited. Retry after ${rateResult.retryAfterMs}ms`);
        }
      }

      // Krok 2: Kontrola circuit breakeru
      if (state.circuitState === 'open') {
        const timeSinceFailure = Date.now() - state.lastFailureTime;
        if (timeSinceFailure < config.circuitTimeout) {
          throw new Error('Circuit breaker open');
        }
        state.circuitState = 'half_open';
        state.successCount = 0;
      }

      // Krok 3: Provedení požadavku
      try {
        // Spotřebování rate limitu
        if (limiter) {
          await RateLimiter.consume(limiter as any, msg.key);
        }

        const result = await msg.fn();

        // Zpracování úspěchu
        if (state.circuitState === 'half_open') {
          state.successCount++;
          if (state.successCount >= config.successThreshold) {
            state.circuitState = 'closed';
            state.failureCount = 0;
          }
        } else {
          state.failureCount = 0;
        }

        return [result, state];

      } catch (error) {
        // Zpracování selhání
        state.failureCount++;
        state.lastFailureTime = Date.now();

        if (state.circuitState === 'half_open' ||
            state.failureCount >= config.failureThreshold) {
          state.circuitState = 'open';
          state.successCount = 0;
        }

        throw error;
      }
    }

    throw new Error('Unknown message type');
  },

  handleCast: (_, state) => state,
});
```

## Cvičení

Vytvořte **systém doručování notifikací** pomocí vzorů z této kapitoly:

Požadavky:
1. **Worker Pool**: 3 workery pro zpracování doručování notifikací
2. **Rate Limiting**: Max 100 notifikací za minutu per uživatel
3. **Circuit Breaker**: Per-channel (email, SMS, push) circuit breakery
4. **Pipeline**: Validate → Rate Check → Deliver → Track

Tipy:
- Použijte `simple_one_for_one` supervisor pro dynamické vytváření workerů
- Každý kanál (email, SMS, push) by měl mít svůj vlastní circuit breaker
- Sledujte stav doručení v odděleném GenServeru

<details>
<summary>Řešení</summary>

```typescript
import {
  GenServer,
  Supervisor,
  Registry,
  EventBus,
  type GenServerBehavior,
  type GenServerRef,
  type SupervisorRef,
  type EventBusRef,
} from '@hamicek/noex';
import { RateLimiter, type RateLimiterRef } from '@hamicek/noex';

// ============================================================================
// Typy
// ============================================================================

type Channel = 'email' | 'sms' | 'push';

interface Notification {
  id: string;
  userId: string;
  channel: Channel;
  content: string;
  priority: number;
}

interface DeliveryResult {
  notificationId: string;
  success: boolean;
  channel: Channel;
  error?: string;
  timestamp: Date;
}

// ============================================================================
// Circuit Breaker (per kanál)
// ============================================================================

interface ChannelCircuitState {
  state: 'closed' | 'open' | 'half_open';
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
}

type CircuitCall =
  | { type: 'canExecute' }
  | { type: 'recordSuccess' }
  | { type: 'recordFailure' };

const createCircuitBehavior = (channel: Channel): GenServerBehavior<
  ChannelCircuitState,
  CircuitCall,
  never,
  boolean
> => ({
  init: () => ({
    state: 'closed',
    failureCount: 0,
    successCount: 0,
    lastFailureTime: 0,
  }),

  handleCall(msg, state) {
    const FAILURE_THRESHOLD = 5;
    const SUCCESS_THRESHOLD = 3;
    const TIMEOUT = 30000;

    switch (msg.type) {
      case 'canExecute': {
        if (state.state === 'open') {
          if (Date.now() - state.lastFailureTime >= TIMEOUT) {
            return [true, { ...state, state: 'half_open', successCount: 0 }];
          }
          return [false, state];
        }
        return [true, state];
      }

      case 'recordSuccess': {
        if (state.state === 'half_open') {
          const newSuccessCount = state.successCount + 1;
          if (newSuccessCount >= SUCCESS_THRESHOLD) {
            return [true, { ...state, state: 'closed', failureCount: 0, successCount: 0 }];
          }
          return [true, { ...state, successCount: newSuccessCount }];
        }
        return [true, { ...state, failureCount: 0 }];
      }

      case 'recordFailure': {
        const newFailureCount = state.failureCount + 1;
        if (state.state === 'half_open' || newFailureCount >= FAILURE_THRESHOLD) {
          return [false, {
            ...state,
            state: 'open',
            failureCount: newFailureCount,
            lastFailureTime: Date.now(),
            successCount: 0,
          }];
        }
        return [false, { ...state, failureCount: newFailureCount }];
      }
    }
  },

  handleCast: (_, state) => state,
});

// ============================================================================
// Delivery Tracker
// ============================================================================

interface TrackerState {
  deliveries: Map<string, DeliveryResult>;
}

type TrackerCall =
  | { type: 'get'; notificationId: string }
  | { type: 'getAll' };

type TrackerCast =
  | { type: 'record'; result: DeliveryResult };

const trackerBehavior: GenServerBehavior<
  TrackerState,
  TrackerCall,
  TrackerCast,
  DeliveryResult | undefined | DeliveryResult[]
> = {
  init: () => ({ deliveries: new Map() }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.deliveries.get(msg.notificationId), state];
      case 'getAll':
        return [Array.from(state.deliveries.values()), state];
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'record') {
      state.deliveries.set(msg.result.notificationId, msg.result);
    }
    return state;
  },
};

// ============================================================================
// Delivery Worker
// ============================================================================

interface WorkerState {
  id: string;
  delivered: number;
}

type WorkerCast = { type: 'deliver'; notification: Notification };

function createWorkerBehavior(workerId: string): GenServerBehavior<
  WorkerState,
  never,
  WorkerCast,
  never
> {
  return {
    init: () => ({ id: workerId, delivered: 0 }),

    handleCall(_, state) {
      return [undefined as never, state];
    },

    async handleCast(msg, state) {
      if (msg.type === 'deliver') {
        const { notification } = msg;
        const circuit = Registry.whereis(`circuit-${notification.channel}`);
        const tracker = Registry.whereis('tracker');
        const bus = Registry.whereis<EventBusRef>('event-bus');

        // Kontrola circuit breakeru
        if (circuit) {
          const canExecute = await GenServer.call(circuit, { type: 'canExecute' });
          if (!canExecute) {
            // Circuit otevřený - rychlé selhání
            const result: DeliveryResult = {
              notificationId: notification.id,
              success: false,
              channel: notification.channel,
              error: 'Circuit breaker open',
              timestamp: new Date(),
            };
            if (tracker) GenServer.cast(tracker, { type: 'record', result });
            if (bus) EventBus.publish(bus, 'delivery.failed', result);
            return state;
          }
        }

        // Simulace doručení
        try {
          await simulateDelivery(notification.channel);

          // Záznam úspěchu
          if (circuit) {
            await GenServer.call(circuit, { type: 'recordSuccess' });
          }

          const result: DeliveryResult = {
            notificationId: notification.id,
            success: true,
            channel: notification.channel,
            timestamp: new Date(),
          };
          if (tracker) GenServer.cast(tracker, { type: 'record', result });
          if (bus) EventBus.publish(bus, 'delivery.success', result);

          return { ...state, delivered: state.delivered + 1 };

        } catch (error) {
          // Záznam selhání
          if (circuit) {
            await GenServer.call(circuit, { type: 'recordFailure' });
          }

          const result: DeliveryResult = {
            notificationId: notification.id,
            success: false,
            channel: notification.channel,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date(),
          };
          if (tracker) GenServer.cast(tracker, { type: 'record', result });
          if (bus) EventBus.publish(bus, 'delivery.failed', result);

          return state;
        }
      }
      return state;
    },
  };
}

async function simulateDelivery(channel: Channel): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));

  // Simulace různých míry selhání per kanál
  const failureRates: Record<Channel, number> = {
    email: 0.05,  // 5% selhání
    sms: 0.15,    // 15% selhání
    push: 0.02,   // 2% selhání
  };

  if (Math.random() < failureRates[channel]) {
    throw new Error(`${channel} delivery failed`);
  }
}

// ============================================================================
// Pipeline Koordinátor
// ============================================================================

interface PipelineState {
  queue: Notification[];
  nextWorker: number;
  workerCount: number;
}

type PipelineCall = { type: 'submit'; notification: Omit<Notification, 'id'> };
type PipelineCast = { type: 'processQueue' };

const createPipelineBehavior = (
  workerCount: number,
): GenServerBehavior<PipelineState, PipelineCall, PipelineCast, string> => ({
  init: () => ({ queue: [], nextWorker: 0, workerCount }),

  async handleCall(msg, state) {
    if (msg.type === 'submit') {
      const notification: Notification = {
        ...msg.notification,
        id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      };

      // Krok 1: Validace
      if (!notification.userId || !notification.content) {
        throw new Error('Invalid notification: missing userId or content');
      }

      // Krok 2: Kontrola rate limitu
      const limiter = Registry.whereis('notification-limiter') as RateLimiterRef | undefined;
      if (limiter) {
        const key = `user:${notification.userId}`;
        const result = await RateLimiter.check(limiter, key);
        if (!result.allowed) {
          throw new Error(`Rate limited. Retry after ${result.retryAfterMs}ms`);
        }
        await RateLimiter.consume(limiter, key);
      }

      // Krok 3: Přidání do fronty
      state.queue.push(notification);

      // Spuštění zpracování
      const self = Registry.whereis('notification-pipeline');
      if (self) {
        GenServer.cast(self, { type: 'processQueue' });
      }

      return [notification.id, state];
    }
    throw new Error('Unknown message type');
  },

  handleCast(msg, state) {
    if (msg.type === 'processQueue') {
      while (state.queue.length > 0) {
        const notification = state.queue.shift()!;
        const workerId = `delivery-worker-${state.nextWorker}`;
        state.nextWorker = (state.nextWorker + 1) % state.workerCount;

        const worker = Registry.whereis(workerId);
        if (worker) {
          GenServer.cast(worker, { type: 'deliver', notification });
        }
      }
    }
    return state;
  },
});

// ============================================================================
// Spuštění systému
// ============================================================================

async function startNotificationSystem() {
  // EventBus
  await EventBus.start({ name: 'event-bus' });

  // Rate Limiter: 100 notifikací za minutu per uživatel
  await RateLimiter.start({
    maxRequests: 100,
    windowMs: 60000,
    name: 'notification-limiter',
  });

  // Circuit breakery pro každý kanál
  for (const channel of ['email', 'sms', 'push'] as Channel[]) {
    await GenServer.start(createCircuitBehavior(channel), {
      name: `circuit-${channel}`,
    });
  }

  // Tracker
  await GenServer.start(trackerBehavior, { name: 'tracker' });

  // Workery
  const workerCount = 3;
  for (let i = 0; i < workerCount; i++) {
    await GenServer.start(createWorkerBehavior(`worker-${i}`), {
      name: `delivery-worker-${i}`,
    });
  }

  // Pipeline
  await GenServer.start(createPipelineBehavior(workerCount), {
    name: 'notification-pipeline',
  });

  console.log('Notification system started');
}
```

### Klíčová rozhodnutí návrhu

1. **Worker Pool s round-robin**: Jednoduché rozložení zátěže mezi workery
2. **Per-channel circuit breakery**: SMS může selhat bez ovlivnění emailu
3. **Jeden rate limiter per uživatel**: Prevence zahlcení systému jakýmkoli uživatelem
4. **Tracker jako oddělený proces**: Sledování doručení neblokuje doručování
5. **EventBus pro pozorovatelnost**: Volné propojení pro monitoring a analytiku

</details>

## Shrnutí

- **Request-Response Pipeline**: Sekvenční zpracování s jasným oddělením fází
  - Nejlepší pro: ETL, zpracování dat, obsluhu požadavků
  - Klíčová výhoda: Každá fáze může selhat/restartovat nezávisle

- **Worker Pool**: Paralelní zpracování s omezenou konkurencí
  - Nejlepší pro: Job queues, úlohy na pozadí, dávkové zpracování
  - Klíčová výhoda: Backpressure zabraňuje vyčerpání zdrojů

- **Circuit Breaker**: Rychlé selhávání, když jsou downstream služby nezdravé
  - Nejlepší pro: Volání externích API, databázová spojení
  - Klíčová výhoda: Prevence kaskádových selhání

- **Rate Limiting**: Řízení propustnosti požadavků per klíč
  - Nejlepší pro: API endpointy, uživatelské akce
  - Klíčová výhoda: Ochrana služeb před přetížením

Tyto vzory se dobře skládají dohromady. Typický produkční systém může používat:
- Rate limiting na API gateway
- Worker pool pro async zpracování
- Circuit breakery pro externí volání
- Pipelines pro komplexní transformace

Actor model dělá tyto vzory přirozenými pro implementaci, protože každá komponenta je již izolovaný proces s vlastním stavem a zpracováním selhání.

---

Další: [Kdy použít GenStateMachine](../05-state-machine/01-when-to-use.md)
