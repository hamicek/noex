# API Gateway

V tomto projektu vytvoříte produkčně připravenou API gateway, která demonstruje, jak noex elegantně zvládá průřezové záležitosti jako rate limiting, cachování a circuit breaking. Na rozdíl od tradičních middleware řetězců, které se mohou stát zamotanými, actor model poskytuje jasné oddělení zodpovědností s vestavěnou odolností vůči chybám.

## Co se naučíte

- Navrhnout komponovatelnou API gateway pomocí GenServer, Supervisor, Cache a RateLimiter
- Implementovat per-route rate limiting s konfigurovatelnou úrovní
- Vytvořit response cache, která zabraňuje problému thundering herd
- Vytvořit circuit breakers pro ochranu downstream služeb
- Routovat požadavky na více backendů s health-aware load balancingem

## Co vytvoříte

API gateway s:
- **Rate Limiting** — Per-client a per-route limity s korektními HTTP hlavičkami
- **Response Caching** — Konfigurovatelné TTL s invalidací cache
- **Circuit Breaker** — Automatická detekce a zotavení z chyb
- **Request Routing** — Path-based routing na více backendů
- **Health Monitoring** — Real-time sledování zdraví backendů

## Přehled architektury

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       ARCHITEKTURA API GATEWAY                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                  Supervisor aplikace API Gateway                    │    │
│  │                          (one_for_all)                              │    │
│  └────────────────────────────┬────────────────────────────────────────┘    │
│                               │                                             │
│       ┌───────────────────────┼───────────────────────┬────────────────┐    │
│       │                       │                       │                │    │
│       ▼                       ▼                       ▼                ▼    │
│  ┌──────────┐        ┌──────────────┐        ┌──────────┐      ┌──────────┐ │
│  │   Rate   │        │   Response   │        │  Circuit │      │  Router  │ │
│  │ Limiter  │        │    Cache     │        │ Breakers │      │ GenServer│ │
│  │          │        │              │        │  (Map)   │      │          │ │
│  └────┬─────┘        └──────┬───────┘        └────┬─────┘      └────┬─────┘ │
│       │                     │                     │                 │       │
│       │                     │                     │                 │       │
│       └─────────────────────┼─────────────────────┼─────────────────┘       │
│                             │                     │                         │
│                             ▼                     ▼                         │
│                     ┌──────────────────────────────────────┐                │
│                     │          Request Handler             │                │
│                     │                                      │                │
│                     │  1. Kontrola Rate Limit              │                │
│                     │  2. Vyhledání v Cache                │                │
│                     │  3. Kontrola Circuit Breaker         │                │
│                     │  4. Routování na Backend             │                │
│                     │  5. Cache Response                   │                │
│                     │  6. Vrátit klientovi                 │                │
│                     └──────────────────────────────────────┘                │
│                                     │                                       │
│                     ┌───────────────┼───────────────┐                       │
│                     ▼               ▼               ▼                       │
│               ┌──────────┐   ┌──────────┐   ┌──────────┐                   │
│               │ Backend  │   │ Backend  │   │ Backend  │                   │
│               │    A     │   │    B     │   │    C     │                   │
│               │  (users) │   │ (orders) │   │(products)│                   │
│               └──────────┘   └──────────┘   └──────────┘                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Odpovědnosti komponent:**

| Komponenta | Role |
|-----------|------|
| **Rate Limiter** | Vynucuje per-client limity požadavků pomocí sliding window |
| **Response Cache** | Cachuje GET odpovědi s konfigurovatelným TTL |
| **Circuit Breakers** | Chrání backendy před kaskádovými selháními |
| **Router** | Mapuje cesty požadavků na backend služby |
| **Request Handler** | Orchestruje tok požadavku přes všechny komponenty |

## Část 1: Typy a konfigurace

Nejprve definujte typy pro konfiguraci gateway a požadavky:

```typescript
// src/api-gateway/types.ts

// Konfigurace backend služby
export interface BackendConfig {
  name: string;
  baseUrl: string;
  healthCheckPath?: string;
  timeout?: number;
}

// Konfigurace routy
export interface RouteConfig {
  path: string;           // Vzor cesty (např. "/api/users/*")
  backend: string;        // Jméno backendu
  methods?: string[];     // Povolené metody (výchozí: všechny)
  cacheTtlMs?: number;    // Cache TTL (0 = bez cache)
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
}

// Konfigurace gateway
export interface GatewayConfig {
  port?: number;
  backends: BackendConfig[];
  routes: RouteConfig[];
  defaultRateLimit: {
    maxRequests: number;
    windowMs: number;
  };
  circuitBreaker: {
    failureThreshold: number;
    resetTimeoutMs: number;
    halfOpenRequests: number;
  };
  cache: {
    maxSize: number;
    defaultTtlMs: number;
  };
}

// Kontext požadavku předávaný přes pipeline
export interface GatewayRequest {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  clientId: string;
  timestamp: number;
}

// Odpověď z backendu nebo cache
export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  cached: boolean;
  backendTime?: number;
}

// Události gateway pro monitoring
export type GatewayEvent =
  | { type: 'request.received'; requestId: string; path: string; clientId: string }
  | { type: 'request.completed'; requestId: string; status: number; duration: number; cached: boolean }
  | { type: 'request.rate_limited'; requestId: string; clientId: string; retryAfterMs: number }
  | { type: 'circuit.opened'; backend: string; failures: number }
  | { type: 'circuit.closed'; backend: string }
  | { type: 'cache.hit'; requestId: string; path: string }
  | { type: 'cache.miss'; requestId: string; path: string }
  | { type: 'backend.error'; backend: string; error: string };

// Výchozí konfigurace
export const DEFAULT_CONFIG: GatewayConfig = {
  port: 8080,
  backends: [],
  routes: [],
  defaultRateLimit: {
    maxRequests: 100,
    windowMs: 60000,
  },
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 30000,
    halfOpenRequests: 3,
  },
  cache: {
    maxSize: 1000,
    defaultTtlMs: 30000,
  },
};
```

## Část 2: Circuit Breaker GenServer

Circuit breaker chrání backendy před kaskádovými selháními:

```typescript
// src/api-gateway/circuit-breaker.ts
import { GenServer, Registry, type GenServerRef } from '@hamicek/noex';

type CircuitState = 'closed' | 'open' | 'half_open';

interface CircuitBreakerState {
  backendName: string;
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number;
  halfOpenAttempts: number;
  config: {
    failureThreshold: number;
    resetTimeoutMs: number;
    halfOpenRequests: number;
  };
}

type CircuitBreakerCallMsg =
  | { type: 'canRequest' }
  | { type: 'getState' };

type CircuitBreakerCallReply =
  | { allowed: boolean; state: CircuitState }
  | { state: CircuitState; failures: number; lastFailure: number | null };

type CircuitBreakerCastMsg =
  | { type: 'recordSuccess' }
  | { type: 'recordFailure' }
  | { type: 'reset' };

export const CircuitBreakerBehavior = {
  init(
    backendName: string,
    config: CircuitBreakerState['config']
  ): CircuitBreakerState {
    console.log(`[CircuitBreaker:${backendName}] inicializován`);
    return {
      backendName,
      state: 'closed',
      failures: 0,
      successes: 0,
      lastFailureTime: 0,
      halfOpenAttempts: 0,
      config,
    };
  },

  handleCall(
    msg: CircuitBreakerCallMsg,
    state: CircuitBreakerState
  ): [CircuitBreakerCallReply, CircuitBreakerState] {
    switch (msg.type) {
      case 'canRequest': {
        const now = Date.now();

        // Closed: povolit všechny požadavky
        if (state.state === 'closed') {
          return [{ allowed: true, state: 'closed' }, state];
        }

        // Open: zkontrolovat, zda uplynul timeout
        if (state.state === 'open') {
          if (now - state.lastFailureTime >= state.config.resetTimeoutMs) {
            // Přechod do half-open
            console.log(`[CircuitBreaker:${state.backendName}] Přechod do half-open`);
            const newState = {
              ...state,
              state: 'half_open' as CircuitState,
              halfOpenAttempts: 0,
              successes: 0,
            };
            return [{ allowed: true, state: 'half_open' }, newState];
          }
          return [{ allowed: false, state: 'open' }, state];
        }

        // Half-open: povolit omezené požadavky
        if (state.halfOpenAttempts < state.config.halfOpenRequests) {
          return [
            { allowed: true, state: 'half_open' },
            { ...state, halfOpenAttempts: state.halfOpenAttempts + 1 },
          ];
        }

        return [{ allowed: false, state: 'half_open' }, state];
      }

      case 'getState': {
        return [
          {
            state: state.state,
            failures: state.failures,
            lastFailure: state.lastFailureTime || null,
          },
          state,
        ];
      }
    }
  },

  handleCast(msg: CircuitBreakerCastMsg, state: CircuitBreakerState): CircuitBreakerState {
    switch (msg.type) {
      case 'recordSuccess': {
        if (state.state === 'half_open') {
          const newSuccesses = state.successes + 1;
          if (newSuccesses >= state.config.halfOpenRequests) {
            // Zavřít circuit
            console.log(`[CircuitBreaker:${state.backendName}] Circuit zavřen po zotavení`);
            return {
              ...state,
              state: 'closed',
              failures: 0,
              successes: 0,
              halfOpenAttempts: 0,
            };
          }
          return { ...state, successes: newSuccesses };
        }

        // Reset selhání při úspěchu v closed stavu
        if (state.state === 'closed') {
          return { ...state, failures: 0 };
        }

        return state;
      }

      case 'recordFailure': {
        const newFailures = state.failures + 1;
        const now = Date.now();

        // V half-open: okamžitě znovu otevřít
        if (state.state === 'half_open') {
          console.log(`[CircuitBreaker:${state.backendName}] Circuit znovu otevřen (half-open selhání)`);
          return {
            ...state,
            state: 'open',
            failures: newFailures,
            lastFailureTime: now,
            successes: 0,
            halfOpenAttempts: 0,
          };
        }

        // V closed: zkontrolovat threshold
        if (newFailures >= state.config.failureThreshold) {
          console.log(`[CircuitBreaker:${state.backendName}] Circuit otevřen (${newFailures} selhání)`);
          return {
            ...state,
            state: 'open',
            failures: newFailures,
            lastFailureTime: now,
          };
        }

        return { ...state, failures: newFailures, lastFailureTime: now };
      }

      case 'reset': {
        console.log(`[CircuitBreaker:${state.backendName}] Circuit resetován`);
        return {
          ...state,
          state: 'closed',
          failures: 0,
          successes: 0,
          halfOpenAttempts: 0,
        };
      }
    }
  },

  terminate(reason: string, state: CircuitBreakerState): void {
    console.log(`[CircuitBreaker:${state.backendName}] ukončen: ${reason}`);
  },
};

// Spustit circuit breaker pro backend
export async function startCircuitBreaker(
  backendName: string,
  config: CircuitBreakerState['config']
): Promise<GenServerRef> {
  const ref = await GenServer.start<
    CircuitBreakerState,
    CircuitBreakerCallMsg,
    CircuitBreakerCastMsg,
    CircuitBreakerCallReply
  >({
    init: () => CircuitBreakerBehavior.init(backendName, config),
    handleCall: CircuitBreakerBehavior.handleCall,
    handleCast: CircuitBreakerBehavior.handleCast,
    terminate: CircuitBreakerBehavior.terminate,
  });

  Registry.register(`circuit-breaker:${backendName}`, ref);
  return ref;
}

// Zkontrolovat, zda je požadavek povolen
export async function canRequest(ref: GenServerRef): Promise<{ allowed: boolean; state: CircuitState }> {
  return GenServer.call(ref, { type: 'canRequest' }) as Promise<{ allowed: boolean; state: CircuitState }>;
}

// Zaznamenat úspěch
export function recordSuccess(ref: GenServerRef): void {
  GenServer.cast(ref, { type: 'recordSuccess' });
}

// Zaznamenat selhání
export function recordFailure(ref: GenServerRef): void {
  GenServer.cast(ref, { type: 'recordFailure' });
}
```

## Část 3: Router GenServer

Router mapuje příchozí požadavky na backend služby:

```typescript
// src/api-gateway/router.ts
import { GenServer, Registry, type GenServerRef } from '@hamicek/noex';
import type { RouteConfig, BackendConfig, GatewayRequest } from './types';

interface RouteMatch {
  route: RouteConfig;
  backend: BackendConfig;
  params: Record<string, string>;
}

interface RouterState {
  routes: RouteConfig[];
  backends: Map<string, BackendConfig>;
}

type RouterCallMsg =
  | { type: 'match'; request: GatewayRequest }
  | { type: 'getRoutes' }
  | { type: 'getBackends' };

type RouterCallReply =
  | RouteMatch | null
  | RouteConfig[]
  | BackendConfig[];

type RouterCastMsg =
  | { type: 'addRoute'; route: RouteConfig }
  | { type: 'removeRoute'; path: string }
  | { type: 'addBackend'; backend: BackendConfig }
  | { type: 'removeBackend'; name: string };

export const RouterBehavior = {
  init(routes: RouteConfig[], backends: BackendConfig[]): RouterState {
    const backendMap = new Map<string, BackendConfig>();
    for (const backend of backends) {
      backendMap.set(backend.name, backend);
    }

    // Seřadit routy podle specificity (specifičtější cesty první)
    const sortedRoutes = [...routes].sort((a, b) => {
      const aWildcards = (a.path.match(/\*/g) || []).length;
      const bWildcards = (b.path.match(/\*/g) || []).length;
      if (aWildcards !== bWildcards) return aWildcards - bWildcards;
      return b.path.length - a.path.length;
    });

    console.log(`[Router] inicializován s ${sortedRoutes.length} routami a ${backends.length} backendy`);
    return { routes: sortedRoutes, backends: backendMap };
  },

  handleCall(msg: RouterCallMsg, state: RouterState): [RouterCallReply, RouterState] {
    switch (msg.type) {
      case 'match': {
        const { request } = msg;
        const match = findMatchingRoute(request, state.routes, state.backends);
        return [match, state];
      }

      case 'getRoutes':
        return [state.routes, state];

      case 'getBackends':
        return [Array.from(state.backends.values()), state];
    }
  },

  handleCast(msg: RouterCastMsg, state: RouterState): RouterState {
    switch (msg.type) {
      case 'addRoute': {
        const routes = [...state.routes, msg.route].sort((a, b) => {
          const aWildcards = (a.path.match(/\*/g) || []).length;
          const bWildcards = (b.path.match(/\*/g) || []).length;
          if (aWildcards !== bWildcards) return aWildcards - bWildcards;
          return b.path.length - a.path.length;
        });
        console.log(`[Router] Přidána routa: ${msg.route.path}`);
        return { ...state, routes };
      }

      case 'removeRoute': {
        const routes = state.routes.filter((r) => r.path !== msg.path);
        console.log(`[Router] Odebrána routa: ${msg.path}`);
        return { ...state, routes };
      }

      case 'addBackend': {
        const backends = new Map(state.backends);
        backends.set(msg.backend.name, msg.backend);
        console.log(`[Router] Přidán backend: ${msg.backend.name}`);
        return { ...state, backends };
      }

      case 'removeBackend': {
        const backends = new Map(state.backends);
        backends.delete(msg.name);
        console.log(`[Router] Odebrán backend: ${msg.name}`);
        return { ...state, backends };
      }
    }
  },

  terminate(reason: string, state: RouterState): void {
    console.log(`[Router] ukončen: ${reason}`);
  },
};

// Najít odpovídající routu pro požadavek
function findMatchingRoute(
  request: GatewayRequest,
  routes: RouteConfig[],
  backends: Map<string, BackendConfig>
): RouteMatch | null {
  for (const route of routes) {
    // Zkontrolovat metodu
    if (route.methods && !route.methods.includes(request.method)) {
      continue;
    }

    // Zkontrolovat shodu cesty
    const match = matchPath(route.path, request.path);
    if (match) {
      const backend = backends.get(route.backend);
      if (!backend) {
        console.warn(`[Router] Backend nenalezen: ${route.backend}`);
        continue;
      }

      return { route, backend, params: match.params };
    }
  }

  return null;
}

// Porovnat vzor cesty s aktuální cestou
function matchPath(
  pattern: string,
  path: string
): { params: Record<string, string> } | null {
  // Převést vzor na regex
  // /api/users/:id -> /api/users/([^/]+)
  // /api/* -> /api/(.*)
  const paramNames: string[] = [];
  const regexPattern = pattern
    .replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    })
    .replace(/\*/g, '(.*)');

  const regex = new RegExp(`^${regexPattern}$`);
  const match = path.match(regex);

  if (!match) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < paramNames.length; i++) {
    params[paramNames[i]] = match[i + 1];
  }

  return { params };
}

// Spustit router
export async function startRouter(
  routes: RouteConfig[],
  backends: BackendConfig[]
): Promise<GenServerRef> {
  const ref = await GenServer.start<
    RouterState,
    RouterCallMsg,
    RouterCastMsg,
    RouterCallReply
  >({
    init: () => RouterBehavior.init(routes, backends),
    handleCall: RouterBehavior.handleCall,
    handleCast: RouterBehavior.handleCast,
    terminate: RouterBehavior.terminate,
  });

  Registry.register('gateway-router', ref);
  return ref;
}

// Najít shodu požadavku s routou
export async function matchRoute(
  router: GenServerRef,
  request: GatewayRequest
): Promise<RouteMatch | null> {
  return GenServer.call(router, { type: 'match', request }) as Promise<RouteMatch | null>;
}
```

## Část 4: Request Handler GenServer

Request handler orchestruje celý tok požadavku:

```typescript
// src/api-gateway/request-handler.ts
import {
  GenServer,
  Registry,
  Cache,
  RateLimiter,
  RateLimitExceededError,
  EventBus,
  type GenServerRef,
  type CacheRef,
  type RateLimiterRef,
  type EventBusRef,
} from '@hamicek/noex';
import type { GatewayConfig, GatewayRequest, GatewayResponse, GatewayEvent } from './types';
import { matchRoute } from './router';
import { canRequest, recordSuccess, recordFailure } from './circuit-breaker';

interface RequestHandlerState {
  config: GatewayConfig;
  router: GenServerRef;
  cache: CacheRef;
  rateLimiter: RateLimiterRef;
  circuitBreakers: Map<string, GenServerRef>;
  eventBus: EventBusRef;
}

type RequestHandlerCallMsg =
  | { type: 'handleRequest'; request: GatewayRequest }
  | { type: 'getStats' };

type RequestHandlerCallReply =
  | GatewayResponse
  | { requests: number; cacheHits: number; circuitBreaks: number };

type RequestHandlerCastMsg =
  | { type: 'invalidateCache'; pattern: string };

export const RequestHandlerBehavior = {
  init(
    config: GatewayConfig,
    router: GenServerRef,
    cache: CacheRef,
    rateLimiter: RateLimiterRef,
    circuitBreakers: Map<string, GenServerRef>,
    eventBus: EventBusRef
  ): RequestHandlerState {
    console.log('[RequestHandler] inicializován');
    return {
      config,
      router,
      cache,
      rateLimiter,
      circuitBreakers,
      eventBus,
    };
  },

  async handleCall(
    msg: RequestHandlerCallMsg,
    state: RequestHandlerState
  ): Promise<[RequestHandlerCallReply, RequestHandlerState]> {
    switch (msg.type) {
      case 'handleRequest': {
        const response = await handleRequest(msg.request, state);
        return [response, state];
      }

      case 'getStats': {
        const cacheStats = await Cache.stats(state.cache);
        return [
          {
            requests: cacheStats.hits + cacheStats.misses,
            cacheHits: cacheStats.hits,
            circuitBreaks: 0, // Může se sledovat ve stavu
          },
          state,
        ];
      }
    }
  },

  handleCast(msg: RequestHandlerCastMsg, state: RequestHandlerState): RequestHandlerState {
    switch (msg.type) {
      case 'invalidateCache': {
        invalidateCachePattern(state.cache, msg.pattern);
        return state;
      }
    }
  },

  terminate(reason: string, state: RequestHandlerState): void {
    console.log(`[RequestHandler] ukončen: ${reason}`);
  },
};

// Hlavní logika zpracování požadavku
async function handleRequest(
  request: GatewayRequest,
  state: RequestHandlerState
): Promise<GatewayResponse> {
  const startTime = Date.now();

  // Publikovat událost přijetí požadavku
  publishEvent(state.eventBus, {
    type: 'request.received',
    requestId: request.id,
    path: request.path,
    clientId: request.clientId,
  });

  try {
    // Krok 1: Najít shodu routy
    const match = await matchRoute(state.router, request);
    if (!match) {
      return {
        status: 404,
        headers: {},
        body: { error: 'Nenalezeno', message: `Žádná routa nenalezena pro ${request.path}` },
        cached: false,
      };
    }

    // Krok 2: Rate limiting
    const rateLimitKey = `${request.clientId}:${match.route.path}`;
    try {
      await RateLimiter.consume(state.rateLimiter, rateLimitKey);
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        publishEvent(state.eventBus, {
          type: 'request.rate_limited',
          requestId: request.id,
          clientId: request.clientId,
          retryAfterMs: error.retryAfterMs,
        });

        return {
          status: 429,
          headers: {
            'Retry-After': String(Math.ceil(error.retryAfterMs / 1000)),
            'X-RateLimit-Limit': String(state.config.defaultRateLimit.maxRequests),
            'X-RateLimit-Remaining': '0',
          },
          body: {
            error: 'Příliš mnoho požadavků',
            message: 'Rate limit překročen',
            retryAfterMs: error.retryAfterMs,
          },
          cached: false,
        };
      }
      throw error;
    }

    // Krok 3: Zkontrolovat cache (pouze pro GET požadavky)
    if (request.method === 'GET' && match.route.cacheTtlMs !== 0) {
      const cacheKey = `${request.method}:${request.path}`;
      const cachedResponse = await Cache.get<GatewayResponse>(state.cache, cacheKey);

      if (cachedResponse) {
        publishEvent(state.eventBus, {
          type: 'cache.hit',
          requestId: request.id,
          path: request.path,
        });

        publishRequestCompleted(state.eventBus, request.id, cachedResponse.status, startTime, true);
        return { ...cachedResponse, cached: true };
      }

      publishEvent(state.eventBus, {
        type: 'cache.miss',
        requestId: request.id,
        path: request.path,
      });
    }

    // Krok 4: Zkontrolovat circuit breaker
    const circuitBreaker = state.circuitBreakers.get(match.backend.name);
    if (circuitBreaker) {
      const circuitStatus = await canRequest(circuitBreaker);
      if (!circuitStatus.allowed) {
        return {
          status: 503,
          headers: { 'Retry-After': '30' },
          body: {
            error: 'Služba nedostupná',
            message: `Backend ${match.backend.name} je dočasně nedostupný`,
          },
          cached: false,
        };
      }
    }

    // Krok 5: Přeposlat na backend
    const backendResponse = await forwardToBackend(request, match.backend, match.params);

    // Krok 6: Aktualizovat circuit breaker
    if (circuitBreaker) {
      if (backendResponse.status >= 500) {
        recordFailure(circuitBreaker);
        publishEvent(state.eventBus, {
          type: 'backend.error',
          backend: match.backend.name,
          error: `HTTP ${backendResponse.status}`,
        });
      } else {
        recordSuccess(circuitBreaker);
      }
    }

    // Krok 7: Cache odpověď (pouze pro úspěšné GET požadavky)
    if (
      request.method === 'GET' &&
      backendResponse.status >= 200 &&
      backendResponse.status < 300 &&
      match.route.cacheTtlMs !== 0
    ) {
      const cacheKey = `${request.method}:${request.path}`;
      const ttlMs = match.route.cacheTtlMs ?? state.config.cache.defaultTtlMs;
      await Cache.set(state.cache, cacheKey, backendResponse, { ttlMs });
    }

    publishRequestCompleted(state.eventBus, request.id, backendResponse.status, startTime, false);
    return backendResponse;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[RequestHandler] Chyba při zpracování požadavku ${request.id}:`, errorMessage);

    return {
      status: 500,
      headers: {},
      body: { error: 'Interní chyba serveru', message: errorMessage },
      cached: false,
    };
  }
}

// Přeposlat požadavek na backend službu
async function forwardToBackend(
  request: GatewayRequest,
  backend: { baseUrl: string; timeout?: number },
  params: Record<string, string>
): Promise<GatewayResponse> {
  const startTime = Date.now();

  // Sestavit backend URL
  let targetPath = request.path;
  for (const [key, value] of Object.entries(params)) {
    targetPath = targetPath.replace(`:${key}`, value);
  }
  const url = `${backend.baseUrl}${targetPath}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      backend.timeout ?? 30000
    );

    const response = await fetch(url, {
      method: request.method,
      headers: {
        ...request.headers,
        'X-Request-Id': request.id,
        'X-Forwarded-For': request.clientId,
      },
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const body = await response.json().catch(() => null);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      status: response.status,
      headers,
      body,
      cached: false,
      backendTime: Date.now() - startTime,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        status: 504,
        headers: {},
        body: { error: 'Gateway Timeout', message: 'Požadavek na backend vypršel' },
        cached: false,
      };
    }

    throw error;
  }
}

// Invalidovat cache položky odpovídající vzoru
async function invalidateCachePattern(cache: CacheRef, pattern: string): Promise<void> {
  const keys = await Cache.keys(cache);
  for (const key of keys) {
    if (key.includes(pattern)) {
      await Cache.delete(cache, key);
    }
  }
}

// Publikovat událost do EventBus
function publishEvent(eventBus: EventBusRef, event: GatewayEvent): void {
  EventBus.publish(eventBus, `gateway.${event.type}`, event);
}

function publishRequestCompleted(
  eventBus: EventBusRef,
  requestId: string,
  status: number,
  startTime: number,
  cached: boolean
): void {
  publishEvent(eventBus, {
    type: 'request.completed',
    requestId,
    status,
    duration: Date.now() - startTime,
    cached,
  });
}

// Spustit request handler
export async function startRequestHandler(
  config: GatewayConfig,
  router: GenServerRef,
  cache: CacheRef,
  rateLimiter: RateLimiterRef,
  circuitBreakers: Map<string, GenServerRef>,
  eventBus: EventBusRef
): Promise<GenServerRef> {
  const ref = await GenServer.start<
    RequestHandlerState,
    RequestHandlerCallMsg,
    RequestHandlerCastMsg,
    RequestHandlerCallReply
  >({
    init: () => RequestHandlerBehavior.init(config, router, cache, rateLimiter, circuitBreakers, eventBus),
    handleCall: RequestHandlerBehavior.handleCall,
    handleCast: RequestHandlerBehavior.handleCast,
    terminate: RequestHandlerBehavior.terminate,
  });

  Registry.register('gateway-handler', ref);
  return ref;
}

// Zpracovat požadavek
export async function handleGatewayRequest(
  handler: GenServerRef,
  request: GatewayRequest
): Promise<GatewayResponse> {
  return GenServer.call(handler, { type: 'handleRequest', request }) as Promise<GatewayResponse>;
}

// Invalidovat cache
export function invalidateCache(handler: GenServerRef, pattern: string): void {
  GenServer.cast(handler, { type: 'invalidateCache', pattern });
}
```

## Část 5: Aplikace API Gateway

Spojte vše dohromady s hlavní aplikací:

```typescript
// src/api-gateway/gateway-application.ts
import {
  Application,
  EventBus,
  Supervisor,
  Cache,
  RateLimiter,
  GenServer,
  Registry,
  type ApplicationBehavior,
  type SupervisorRef,
  type GenServerRef,
  type EventBusRef,
  type CacheRef,
  type RateLimiterRef,
} from '@hamicek/noex';
import { startRouter } from './router';
import { startCircuitBreaker } from './circuit-breaker';
import { startRequestHandler, handleGatewayRequest, invalidateCache } from './request-handler';
import type { GatewayConfig, GatewayRequest, GatewayResponse, GatewayEvent } from './types';
import { DEFAULT_CONFIG } from './types';

interface GatewayState {
  config: GatewayConfig;
  eventBus: EventBusRef;
  cache: CacheRef;
  rateLimiter: RateLimiterRef;
  router: GenServerRef;
  circuitBreakers: Map<string, GenServerRef>;
  requestHandler: GenServerRef;
}

export const GatewayApplicationBehavior: ApplicationBehavior<
  Partial<GatewayConfig>,
  GatewayState
> = {
  async start(partialConfig) {
    const config = { ...DEFAULT_CONFIG, ...partialConfig };
    console.log('[APIGateway] Spouštím...');

    // 1. Spustit EventBus
    const eventBus = await EventBus.start({ name: 'gateway-events' });
    console.log('[APIGateway] EventBus spuštěn');

    // 2. Spustit Cache
    const cache = await Cache.start({
      maxSize: config.cache.maxSize,
      defaultTtlMs: config.cache.defaultTtlMs,
      name: 'gateway-cache',
    });
    console.log('[APIGateway] Cache spuštěn');

    // 3. Spustit RateLimiter
    const rateLimiter = await RateLimiter.start({
      maxRequests: config.defaultRateLimit.maxRequests,
      windowMs: config.defaultRateLimit.windowMs,
      name: 'gateway-rate-limiter',
    });
    console.log('[APIGateway] RateLimiter spuštěn');

    // 4. Spustit Router
    const router = await startRouter(config.routes, config.backends);
    console.log('[APIGateway] Router spuštěn');

    // 5. Spustit Circuit Breakers pro každý backend
    const circuitBreakers = new Map<string, GenServerRef>();
    for (const backend of config.backends) {
      const breaker = await startCircuitBreaker(backend.name, {
        failureThreshold: config.circuitBreaker.failureThreshold,
        resetTimeoutMs: config.circuitBreaker.resetTimeoutMs,
        halfOpenRequests: config.circuitBreaker.halfOpenRequests,
      });
      circuitBreakers.set(backend.name, breaker);
    }
    console.log(`[APIGateway] ${circuitBreakers.size} Circuit Breakers spuštěno`);

    // 6. Spustit Request Handler
    const requestHandler = await startRequestHandler(
      config,
      router,
      cache,
      rateLimiter,
      circuitBreakers,
      eventBus
    );
    console.log('[APIGateway] RequestHandler spuštěn');

    // 7. Vytvořit top-level supervisor
    const supervisor = await Supervisor.start({
      strategy: 'one_for_all',
      children: [],
      restartIntensity: {
        maxRestarts: 5,
        withinMs: 60_000,
      },
    });

    console.log('[APIGateway] Úspěšně spuštěn');

    return {
      supervisor,
      state: {
        config,
        eventBus,
        cache,
        rateLimiter,
        router,
        circuitBreakers,
        requestHandler,
      },
    };
  },

  async prepStop(reason, state) {
    console.log(`[APIGateway] Připravuji se na zastavení: ${reason}`);
    // Povolit dokončení rozpracovaných požadavků (žádné nové požadavky nebudou přijaty)
    await new Promise((resolve) => setTimeout(resolve, 1000));
  },

  async stop(reason, state) {
    console.log(`[APIGateway] Zastavuji: ${reason}`);

    // Zastavit v opačném pořadí
    await GenServer.stop(state.requestHandler);

    for (const [name, breaker] of state.circuitBreakers) {
      await GenServer.stop(breaker);
      try {
        Registry.unregister(`circuit-breaker:${name}`);
      } catch { /* ignorovat */ }
    }

    await GenServer.stop(state.router);
    await RateLimiter.stop(state.rateLimiter);
    await Cache.stop(state.cache);
    await EventBus.stop(state.eventBus);

    // Vyčistit registry
    try {
      Registry.unregister('gateway-router');
      Registry.unregister('gateway-handler');
    } catch { /* ignorovat */ }

    console.log('[APIGateway] Zastaven');
  },
};

// High-level Gateway třída
export class APIGateway {
  private state: GatewayState | null = null;
  private supervisor: SupervisorRef | null = null;
  private requestCounter = 0;

  async start(config: Partial<GatewayConfig> = {}): Promise<void> {
    const result = await Application.start(GatewayApplicationBehavior, config);
    this.supervisor = result.supervisor;
    this.state = result.state;
  }

  async stop(): Promise<void> {
    if (this.state && this.supervisor) {
      await Application.stop(this.supervisor, 'shutdown');
      this.state = null;
      this.supervisor = null;
    }
  }

  async handleRequest(
    method: string,
    path: string,
    options: {
      headers?: Record<string, string>;
      body?: unknown;
      clientId?: string;
    } = {}
  ): Promise<GatewayResponse> {
    if (!this.state) {
      throw new Error('Gateway není spuštěn');
    }

    const request: GatewayRequest = {
      id: `req-${++this.requestCounter}-${Date.now()}`,
      method: method.toUpperCase(),
      path,
      headers: options.headers ?? {},
      body: options.body,
      clientId: options.clientId ?? 'anonymous',
      timestamp: Date.now(),
    };

    return handleGatewayRequest(this.state.requestHandler, request);
  }

  invalidateCache(pattern: string): void {
    if (!this.state) {
      throw new Error('Gateway není spuštěn');
    }
    invalidateCache(this.state.requestHandler, pattern);
  }

  onEvent(handler: (event: GatewayEvent) => void): () => Promise<void> {
    if (!this.state) {
      throw new Error('Gateway není spuštěn');
    }

    const subscriptions: Array<() => Promise<void>> = [];

    (async () => {
      subscriptions.push(
        await EventBus.subscribe(this.state!.eventBus, 'gateway.*', (event: GatewayEvent) => {
          handler(event);
        })
      );
    })();

    return async () => {
      for (const unsub of subscriptions) {
        await unsub();
      }
    };
  }

  async getStats(): Promise<{
    cache: { size: number; hits: number; misses: number; hitRate: number };
  }> {
    if (!this.state) {
      throw new Error('Gateway není spuštěn');
    }

    const cacheStats = await Cache.stats(this.state.cache);

    return {
      cache: {
        size: cacheStats.size,
        hits: cacheStats.hits,
        misses: cacheStats.misses,
        hitRate: cacheStats.hitRate,
      },
    };
  }

  isRunning(): boolean {
    return this.state !== null;
  }
}
```

## Část 6: Tok požadavku

Takto požadavek prochází gateway:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              TOK POŽADAVKU                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Klient                                                                     │
│    │                                                                        │
│    ▼ GET /api/users/123                                                     │
│  ┌──────────────────┐                                                       │
│  │  Request Handler │                                                       │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Krok 1: Shoda routy                                                    │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │     Router       │──► Shoda "/api/users/:id" → backend: "users-service"  │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Krok 2: Kontrola Rate Limit                                            │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │   RateLimiter    │──► client:abc:/api/users/* → 5/100 použito → POVOLENO │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Krok 3: Vyhledání v Cache (pouze GET)                                  │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │      Cache       │──► GET:/api/users/123 → MISS                          │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Krok 4: Kontrola Circuit Breaker                                       │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │ Circuit Breaker  │──► users-service: CLOSED → POVOLENO                   │
│  │ (users-service)  │                                                       │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Krok 5: Přeposlat na Backend                                           │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │  Backend Call    │──► http://users-api:3001/api/users/123                │
│  │                  │                                                       │
│  │  ← 200 OK        │◄── { "id": "123", "name": "Alice", ... }              │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Krok 6: Aktualizovat Circuit Breaker                                   │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │ Circuit Breaker  │◄── recordSuccess()                                    │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Krok 7: Cache odpovědi                                                 │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │      Cache       │◄── set("GET:/api/users/123", response, ttl=30s)       │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Krok 8: Vrátit klientovi                                               │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │     Klient       │◄── 200 OK + hlavičky + tělo                           │
│  └──────────────────┘                                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Část 7: Příklad použití

Zde je kompletní příklad ukazující gateway v akci:

```typescript
// src/api-gateway/example.ts
import { APIGateway } from './gateway-application';
import type { GatewayEvent } from './types';

async function main() {
  const gateway = new APIGateway();

  // Spustit s konfigurací
  await gateway.start({
    backends: [
      { name: 'users-service', baseUrl: 'http://localhost:3001', timeout: 5000 },
      { name: 'orders-service', baseUrl: 'http://localhost:3002', timeout: 10000 },
      { name: 'products-service', baseUrl: 'http://localhost:3003', timeout: 5000 },
    ],
    routes: [
      { path: '/api/users/*', backend: 'users-service', cacheTtlMs: 30000 },
      { path: '/api/orders/*', backend: 'orders-service', cacheTtlMs: 0 }, // Bez cache
      { path: '/api/products/*', backend: 'products-service', cacheTtlMs: 60000 },
      { path: '/api/health', backend: 'users-service', methods: ['GET'] },
    ],
    defaultRateLimit: {
      maxRequests: 100,
      windowMs: 60000,
    },
    circuitBreaker: {
      failureThreshold: 5,
      resetTimeoutMs: 30000,
      halfOpenRequests: 3,
    },
    cache: {
      maxSize: 1000,
      defaultTtlMs: 30000,
    },
  });

  // Přihlásit se k odběru událostí
  const unsubscribe = gateway.onEvent((event: GatewayEvent) => {
    switch (event.type) {
      case 'request.completed':
        console.log(
          `[Událost] Požadavek ${event.requestId} dokončen: ${event.status} ` +
          `(${event.duration}ms, cache: ${event.cached})`
        );
        break;
      case 'request.rate_limited':
        console.log(`[Událost] Požadavek ${event.requestId} rate limited (opakovat za ${event.retryAfterMs}ms)`);
        break;
      case 'circuit.opened':
        console.log(`[Událost] Circuit otevřen pro ${event.backend} (${event.failures} selhání)`);
        break;
      case 'cache.hit':
        console.log(`[Událost] Cache hit pro ${event.path}`);
        break;
    }
  });

  // Provést požadavky
  console.log('\n--- Provádím API požadavky ---\n');

  // Požadavek 1: První požadavek (cache miss)
  const response1 = await gateway.handleRequest('GET', '/api/users/123', {
    clientId: 'client-abc',
    headers: { 'Accept': 'application/json' },
  });
  console.log('Odpověď 1:', response1.status, response1.cached ? '(cache)' : '(fresh)');

  // Požadavek 2: Stejný požadavek (cache hit)
  const response2 = await gateway.handleRequest('GET', '/api/users/123', {
    clientId: 'client-abc',
  });
  console.log('Odpověď 2:', response2.status, response2.cached ? '(cache)' : '(fresh)');

  // Požadavek 3: Jiný uživatel
  const response3 = await gateway.handleRequest('GET', '/api/users/456', {
    clientId: 'client-abc',
  });
  console.log('Odpověď 3:', response3.status, response3.cached ? '(cache)' : '(fresh)');

  // Požadavek 4: POST (bez cachování)
  const response4 = await gateway.handleRequest('POST', '/api/orders', {
    clientId: 'client-abc',
    body: { productId: '789', quantity: 2 },
  });
  console.log('Odpověď 4:', response4.status, response4.cached ? '(cache)' : '(fresh)');

  // Invalidovat user cache
  console.log('\n--- Invaliduji user cache ---\n');
  gateway.invalidateCache('/api/users');

  // Požadavek 5: Po invalidaci (opět cache miss)
  const response5 = await gateway.handleRequest('GET', '/api/users/123', {
    clientId: 'client-abc',
  });
  console.log('Odpověď 5:', response5.status, response5.cached ? '(cache)' : '(fresh)');

  // Získat statistiky
  const stats = await gateway.getStats();
  console.log('\n--- Statistiky Gateway ---');
  console.log('Cache:', stats.cache);

  // Úklid
  await unsubscribe();
  await gateway.stop();
  console.log('\n--- Gateway zastaven ---');
}

main().catch(console.error);
```

## Část 8: Express integrace

Zde je jak integrovat gateway s Express serverem:

```typescript
// src/api-gateway/server.ts
import express from 'express';
import { APIGateway } from './gateway-application';
import type { GatewayConfig } from './types';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

async function main() {
  const gateway = new APIGateway();

  const config: Partial<GatewayConfig> = {
    backends: [
      { name: 'users-service', baseUrl: process.env.USERS_SERVICE_URL || 'http://localhost:3001' },
      { name: 'orders-service', baseUrl: process.env.ORDERS_SERVICE_URL || 'http://localhost:3002' },
    ],
    routes: [
      { path: '/api/users/*', backend: 'users-service', cacheTtlMs: 30000 },
      { path: '/api/orders/*', backend: 'orders-service', cacheTtlMs: 0 },
    ],
    defaultRateLimit: {
      maxRequests: 100,
      windowMs: 60000,
    },
  };

  await gateway.start(config);

  const app = express();
  app.use(express.json());

  // Gateway routa - zpracovává všechny /api/* požadavky
  app.all('/api/*', async (req, res) => {
    try {
      const clientId = (req.headers['x-api-key'] as string) || req.ip || 'anonymous';

      const response = await gateway.handleRequest(req.method, req.path, {
        clientId,
        headers: req.headers as Record<string, string>,
        body: req.body,
      });

      // Zkopírovat hlavičky z gateway odpovědi
      for (const [key, value] of Object.entries(response.headers)) {
        res.setHeader(key, value);
      }

      // Přidat cache indikátor hlavičku
      if (response.cached) {
        res.setHeader('X-Cache', 'HIT');
      } else {
        res.setHeader('X-Cache', 'MISS');
      }

      res.status(response.status).json(response.body);
    } catch (error) {
      console.error('Chyba gateway:', error);
      res.status(500).json({ error: 'Interní chyba serveru' });
    }
  });

  // Health check
  app.get('/health', async (req, res) => {
    const stats = await gateway.getStats();
    res.json({
      status: 'ok',
      gateway: {
        running: gateway.isRunning(),
        cache: stats.cache,
      },
    });
  });

  const server = app.listen(PORT, () => {
    console.log(`API Gateway naslouchá na portu ${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Vypínám...');
    server.close();
    await gateway.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);
```

## Testování API Gateway

```typescript
// tests/api-gateway.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { APIGateway } from '../src/api-gateway/gateway-application';
import type { GatewayResponse, GatewayEvent } from '../src/api-gateway/types';

// Mock fetch pro backend volání
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('APIGateway', () => {
  let gateway: APIGateway;
  let events: GatewayEvent[];
  let unsubscribe: () => Promise<void>;

  beforeEach(async () => {
    gateway = new APIGateway();
    events = [];

    await gateway.start({
      backends: [
        { name: 'test-backend', baseUrl: 'http://test-backend:3000', timeout: 5000 },
      ],
      routes: [
        { path: '/api/users/*', backend: 'test-backend', cacheTtlMs: 10000 },
        { path: '/api/orders/*', backend: 'test-backend', cacheTtlMs: 0 },
      ],
      defaultRateLimit: { maxRequests: 5, windowMs: 60000 },
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 5000, halfOpenRequests: 1 },
      cache: { maxSize: 100, defaultTtlMs: 5000 },
    });

    unsubscribe = gateway.onEvent((event) => events.push(event));
  });

  afterEach(async () => {
    await unsubscribe();
    await gateway.stop();
    mockFetch.mockReset();
  });

  async function waitFor(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  function mockBackendResponse(status: number, body: unknown): void {
    mockFetch.mockResolvedValueOnce({
      status,
      json: () => Promise.resolve(body),
      headers: new Map([['content-type', 'application/json']]),
    });
  }

  it('měl by routovat požadavky na správný backend', async () => {
    mockBackendResponse(200, { id: '123', name: 'Alice' });

    const response = await gateway.handleRequest('GET', '/api/users/123', {
      clientId: 'test-client',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: '123', name: 'Alice' });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test-backend:3000/api/users/123',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('měl by vrátit 404 pro nenalezené routy', async () => {
    const response = await gateway.handleRequest('GET', '/unknown/path', {
      clientId: 'test-client',
    });

    expect(response.status).toBe(404);
    expect(response.body).toEqual(
      expect.objectContaining({ error: 'Nenalezeno' })
    );
  });

  it('měl by cachovat GET odpovědi', async () => {
    mockBackendResponse(200, { id: '123', name: 'Alice' });

    // První požadavek - cache miss
    const response1 = await gateway.handleRequest('GET', '/api/users/123', {
      clientId: 'test-client',
    });
    expect(response1.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await waitFor(50);

    // Druhý požadavek - cache hit
    const response2 = await gateway.handleRequest('GET', '/api/users/123', {
      clientId: 'test-client',
    });
    expect(response2.cached).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1); // Žádné další volání

    // Ověřit cache události
    expect(events.some((e) => e.type === 'cache.miss')).toBe(true);
    expect(events.some((e) => e.type === 'cache.hit')).toBe(true);
  });

  it('by neměl cachovat routy s cacheTtlMs: 0', async () => {
    mockBackendResponse(200, { orderId: '456' });
    mockBackendResponse(200, { orderId: '456' });

    const response1 = await gateway.handleRequest('GET', '/api/orders/456', {
      clientId: 'test-client',
    });
    expect(response1.cached).toBe(false);

    const response2 = await gateway.handleRequest('GET', '/api/orders/456', {
      clientId: 'test-client',
    });
    expect(response2.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('měl by vynucovat rate limity', async () => {
    mockBackendResponse(200, { ok: true });
    mockBackendResponse(200, { ok: true });
    mockBackendResponse(200, { ok: true });
    mockBackendResponse(200, { ok: true });
    mockBackendResponse(200, { ok: true });

    // Provést 5 požadavků (limit)
    for (let i = 0; i < 5; i++) {
      const response = await gateway.handleRequest('GET', `/api/users/${i}`, {
        clientId: 'test-client',
      });
      expect(response.status).toBe(200);
    }

    // 6. požadavek by měl být rate limited
    const response = await gateway.handleRequest('GET', '/api/users/6', {
      clientId: 'test-client',
    });
    expect(response.status).toBe(429);
    expect(response.body).toEqual(
      expect.objectContaining({ error: 'Příliš mnoho požadavků' })
    );

    expect(events.some((e) => e.type === 'request.rate_limited')).toBe(true);
  });

  it('měl by otevřít circuit breaker po selháních', async () => {
    // Simulovat selhání backendu
    mockFetch.mockRejectedValue(new Error('Connection refused'));
    mockFetch.mockRejectedValue(new Error('Connection refused'));
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    // Provést 3 selhávající požadavky (threshold)
    for (let i = 0; i < 3; i++) {
      await gateway.handleRequest('GET', `/api/users/${i}`, {
        clientId: `client-${i}`, // Různí klienti pro vyhnutí se rate limitu
      });
    }

    await waitFor(50);

    // Circuit by měl být nyní otevřen
    const response = await gateway.handleRequest('GET', '/api/users/99', {
      clientId: 'client-99',
    });
    expect(response.status).toBe(503);
    expect(response.body).toEqual(
      expect.objectContaining({ error: 'Služba nedostupná' })
    );
  });

  it('měl by invalidovat cache na požádání', async () => {
    mockBackendResponse(200, { id: '123', name: 'Alice' });
    mockBackendResponse(200, { id: '123', name: 'Alice Updated' });

    // První požadavek - naplnit cache
    await gateway.handleRequest('GET', '/api/users/123', { clientId: 'test' });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Invalidovat cache
    gateway.invalidateCache('/api/users');
    await waitFor(50);

    // Další požadavek by měl znovu zavolat backend
    const response = await gateway.handleRequest('GET', '/api/users/123', { clientId: 'test' });
    expect(response.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('měl by emitovat události pro životní cyklus požadavku', async () => {
    mockBackendResponse(200, { ok: true });

    await gateway.handleRequest('GET', '/api/users/123', {
      clientId: 'test-client',
    });

    await waitFor(50);

    expect(events.some((e) => e.type === 'request.received')).toBe(true);
    expect(events.some((e) => e.type === 'request.completed')).toBe(true);

    const completed = events.find((e) => e.type === 'request.completed');
    expect(completed).toMatchObject({
      type: 'request.completed',
      status: 200,
      cached: false,
    });
  });
});
```

## Cvičení: Přidat opakování požadavků s backoffem

Rozšiřte API gateway o automatické opakování požadavků:

**Požadavky:**
1. Přidat konfigurovatelný počet opakování pro každou routu (výchozí: 0)
2. Implementovat exponenciální backoff mezi opakováními
3. Opakovat pouze při 5xx chybách nebo timeoutech (ne 4xx)
4. Sledovat pokusy opakování v událostech
5. Přidat hlavičky opakování do odpovědi (`X-Retry-Count`)

**Výchozí kód:**

```typescript
// Rozšířit RouteConfig
interface RouteConfig {
  // ... existující pole
  retries?: number;           // Max počet opakování (výchozí: 0)
  retryDelayMs?: number;      // Základní zpoždění pro exponenciální backoff
}

// Rozšířit GatewayEvent
type GatewayEvent =
  // ... existující události
  | { type: 'request.retry'; requestId: string; attempt: number; reason: string };

// V request-handler.ts, upravit forwardToBackend:
async function forwardWithRetry(
  request: GatewayRequest,
  backend: BackendConfig,
  params: Record<string, string>,
  retries: number,
  retryDelayMs: number
): Promise<GatewayResponse> {
  // TODO: Implementovat logiku opakování s exponenciálním backoffem
  // TODO: Opakovat pouze při 5xx nebo timeout
  // TODO: Emitovat události opakování
  // TODO: Přidat X-Retry-Count hlavičku do odpovědi
}
```

<details>
<summary><strong>Řešení</strong></summary>

```typescript
// Rozšířené typy
interface RetryableRouteConfig extends RouteConfig {
  retries?: number;          // Max počet opakování (výchozí: 0)
  retryDelayMs?: number;     // Základní zpoždění pro exponenciální backoff (výchozí: 1000)
}

interface RetryEvent {
  type: 'request.retry';
  requestId: string;
  backend: string;
  attempt: number;
  maxAttempts: number;
  reason: string;
  nextRetryMs: number;
}

// Vypočítat exponenciální backoff zpoždění s jitterem
function calculateBackoff(attempt: number, baseDelayMs: number): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 0.2 * exponentialDelay; // 20% jitter
  return Math.min(exponentialDelay + jitter, 30000); // Max 30 sekund
}

// Zkontrolovat, zda je chyba opakovatelná
function isRetryableError(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

// Přeposlat požadavek s logikou opakování
async function forwardWithRetry(
  request: GatewayRequest,
  backend: BackendConfig,
  params: Record<string, string>,
  maxRetries: number,
  baseRetryDelayMs: number,
  eventBus: EventBusRef
): Promise<GatewayResponse & { retryCount: number }> {
  let lastError: Error | null = null;
  let lastResponse: GatewayResponse | null = null;
  let attempt = 0;

  while (attempt <= maxRetries) {
    attempt++;

    try {
      const response = await forwardToBackend(request, backend, params);

      // Úspěch nebo neopakovatelná chyba
      if (!isRetryableError(response.status)) {
        return { ...response, retryCount: attempt - 1 };
      }

      // Opakovatelná chyba
      lastResponse = response;

      if (attempt <= maxRetries) {
        const delay = calculateBackoff(attempt, baseRetryDelayMs);

        // Emitovat událost opakování
        EventBus.publish(eventBus, 'gateway.request.retry', {
          type: 'request.retry',
          requestId: request.id,
          backend: backend.name,
          attempt,
          maxAttempts: maxRetries + 1,
          reason: `HTTP ${response.status}`,
          nextRetryMs: delay,
        } satisfies RetryEvent);

        console.log(
          `[Opakování] Požadavek ${request.id} pokus ${attempt}/${maxRetries + 1} ` +
          `selhal s ${response.status}, opakuji za ${delay}ms`
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Zkontrolovat timeout (AbortError) - opakovatelné
      const isTimeout = lastError.name === 'AbortError';
      const isNetworkError = lastError.message.includes('fetch');

      if (!isTimeout && !isNetworkError) {
        throw lastError;
      }

      if (attempt <= maxRetries) {
        const delay = calculateBackoff(attempt, baseRetryDelayMs);

        EventBus.publish(eventBus, 'gateway.request.retry', {
          type: 'request.retry',
          requestId: request.id,
          backend: backend.name,
          attempt,
          maxAttempts: maxRetries + 1,
          reason: isTimeout ? 'Timeout' : 'Síťová chyba',
          nextRetryMs: delay,
        } satisfies RetryEvent);

        console.log(
          `[Opakování] Požadavek ${request.id} pokus ${attempt}/${maxRetries + 1} ` +
          `selhal s ${lastError.message}, opakuji za ${delay}ms`
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Všechna opakování vyčerpána
  if (lastResponse) {
    return { ...lastResponse, retryCount: maxRetries };
  }

  // Vrátit chybovou odpověď
  return {
    status: 502,
    headers: {},
    body: {
      error: 'Bad Gateway',
      message: lastError?.message ?? 'Všechny pokusy o opakování selhaly',
    },
    cached: false,
    retryCount: maxRetries,
  };
}

// Upravená funkce handleRequest
async function handleRequest(
  request: GatewayRequest,
  state: RequestHandlerState
): Promise<GatewayResponse> {
  // ... existující kód až po přeposílání na backend ...

  // Krok 5: Přeposlat na backend s opakováními
  const retries = match.route.retries ?? 0;
  const retryDelayMs = match.route.retryDelayMs ?? 1000;

  const backendResponse = await forwardWithRetry(
    request,
    match.backend,
    match.params,
    retries,
    retryDelayMs,
    state.eventBus
  );

  // Přidat hlavičku opakování pokud došlo k opakováním
  if (backendResponse.retryCount > 0) {
    backendResponse.headers['X-Retry-Count'] = String(backendResponse.retryCount);
  }

  // ... zbytek existujícího kódu ...

  return backendResponse;
}

// Příklad použití
const gateway = new APIGateway();

await gateway.start({
  backends: [
    { name: 'flaky-service', baseUrl: 'http://flaky:3000', timeout: 5000 },
  ],
  routes: [
    {
      path: '/api/critical/*',
      backend: 'flaky-service',
      retries: 3,           // Opakovat až 3x
      retryDelayMs: 1000,   // Začít s 1s zpožděním
    },
    {
      path: '/api/standard/*',
      backend: 'flaky-service',
      retries: 1,           // Jedno opakování
      retryDelayMs: 500,
    },
  ],
});

// Přihlásit se k odběru událostí opakování
gateway.onEvent((event) => {
  if (event.type === 'request.retry') {
    console.log(
      `Opakuji požadavek ${event.requestId} na ${event.backend}: ` +
      `pokus ${event.attempt}/${event.maxAttempts} (${event.reason})`
    );
  }
});
```

**Klíčová rozhodnutí návrhu:**

1. **Exponenciální backoff s jitterem** — Zabraňuje thundering herd když více požadavků selže současně

2. **Selektivní opakování** — Pouze 5xx chyby, timeouty a síťové chyby jsou opakovány (ne 4xx klientské chyby)

3. **Hlavička opakování** — `X-Retry-Count` říká klientům kolik opakování proběhlo

4. **Emise událostí** — Každé opakování je zalogováno pro monitoring a debugging

5. **Konfigurace per-route** — Různé routy mohou mít různé politiky opakování podle jejich kritičnosti

**Příklad časování opakování:**

```
Pokus 1: okamžitě
Pokus 2: ~1000ms (1s základ)
Pokus 3: ~2000ms (2s exponenciálně)
Pokus 4: ~4000ms (4s exponenciálně)
Max zpoždění: 30000ms (30s strop)
```

</details>

## Shrnutí

**Klíčové poznatky:**

- **Rate Limiter** — Per-client sliding window limity chrání před zneužitím
- **Response Cache** — Snižuje zátěž backendu s konfigurovatelným TTL per route
- **Circuit Breaker** — Automaticky rychle selhává když jsou backendy nezdravé
- **Router** — Pattern-based routing s cestovými parametry
- **Event-driven monitoring** — Všechny operace emitují události pro pozorovatelnost

**Použité architektonické vzory:**

| Vzor | Kde použit |
|------|------------|
| Pipeline | Požadavek prochází rate limit → cache → circuit → backend |
| Circuit Breaker | Per-backend detekce a zotavení z chyb |
| Caching | Response cache s LRU eviction |
| Rate Limiting | Sliding window per client/route |
| Pub/Sub | EventBus pro gateway události |
| Application | Kompozice systému a životní cyklus |

**Produkční úvahy:**

| Starost | Řešení |
|---------|--------|
| Perzistence | Použít persistence adapter pro stav rate limiteru přes restarty |
| Distribuované | Sdílet stav rate limitu přes Redis adapter pro multi-instance deployment |
| Health checks | Přidat periodické backend health checks pro preventivní otevření circuits |
| Metriky | Exportovat Prometheus metriky z gateway událostí |
| Logging | Strukturované JSON logování pro trasování požadavků |
| Bezpečnost | Přidat autentizační/autorizační middleware |

**Co jste se naučili:**

1. Jak navrhnout komponovatelnou API gateway s noex
2. Rate limiting s korektními HTTP hlavičkami a zpětnou vazbou pro klienta
3. Response caching s TTL a invalidací cache
4. Circuit breaker pattern pro ochranu backendů
5. Path-based routing s extrakcí parametrů
6. Event-driven monitoring pro pozorovatelnost
7. Graceful shutdown se zpracováním rozpracovaných požadavků

> **Architektonický vhled:** API gateway demonstruje, jak actor model přirozeně zvládá průřezové záležitosti. Každá komponenta (rate limiter, cache, circuit breaker) je nezávislý proces s vlastním stavem, komunikující prostřednictvím zpráv. To činí systém snadno pochopitelným, testovatelným a rozšiřitelným — přidání nového middleware je jen přidání dalšího GenServeru do pipeline.

---

Gratulujeme! Dokončili jste učební příručku noex.

## Co dál?

- Prozkoumejte [API Reference](../../api/index.md) pro detailní dokumentaci
- Podívejte se na další [Příklady](../../examples/index.md) pro reálné vzory
- Připojte se ke komunitě a sdílejte své projekty a získejte pomoc
