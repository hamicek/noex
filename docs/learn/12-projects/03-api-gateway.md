# API Gateway

In this project, you'll build a production-ready API gateway that demonstrates how noex elegantly handles cross-cutting concerns like rate limiting, caching, and circuit breaking. Unlike traditional middleware chains that can become tangled, the actor model provides clear separation of concerns with built-in fault tolerance.

## What You'll Learn

- Design a composable API gateway using GenServer, Supervisor, Cache, and RateLimiter
- Implement per-route rate limiting with configurable tiers
- Build a response cache that prevents thundering herd problems
- Create circuit breakers to protect downstream services
- Route requests to multiple backends with health-aware load balancing

## What You'll Build

An API gateway with:
- **Rate Limiting** — Per-client and per-route limits with proper HTTP headers
- **Response Caching** — Configurable TTL with cache invalidation
- **Circuit Breaker** — Automatic failure detection and recovery
- **Request Routing** — Path-based routing to multiple backends
- **Health Monitoring** — Real-time backend health tracking

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        API GATEWAY ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                  API Gateway Application Supervisor                  │    │
│  │                          (one_for_all)                               │    │
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
│                     │  1. Rate Limit Check                 │                │
│                     │  2. Cache Lookup                     │                │
│                     │  3. Circuit Breaker Check            │                │
│                     │  4. Route to Backend                 │                │
│                     │  5. Cache Response                   │                │
│                     │  6. Return to Client                 │                │
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

**Component responsibilities:**

| Component | Role |
|-----------|------|
| **Rate Limiter** | Enforces per-client request limits using sliding window |
| **Response Cache** | Caches GET responses with configurable TTL |
| **Circuit Breakers** | Protects backends from cascading failures |
| **Router** | Maps request paths to backend services |
| **Request Handler** | Orchestrates the request flow through all components |

## Part 1: Types and Configuration

First, define the types for gateway configuration and requests:

```typescript
// src/api-gateway/types.ts

// Backend service configuration
export interface BackendConfig {
  name: string;
  baseUrl: string;
  healthCheckPath?: string;
  timeout?: number;
}

// Route configuration
export interface RouteConfig {
  path: string;           // Path pattern (e.g., "/api/users/*")
  backend: string;        // Backend name
  methods?: string[];     // Allowed methods (default: all)
  cacheTtlMs?: number;    // Cache TTL (0 = no cache)
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
}

// Gateway configuration
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

// Request context passed through the pipeline
export interface GatewayRequest {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  clientId: string;
  timestamp: number;
}

// Response from backend or cache
export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  cached: boolean;
  backendTime?: number;
}

// Gateway events for monitoring
export type GatewayEvent =
  | { type: 'request.received'; requestId: string; path: string; clientId: string }
  | { type: 'request.completed'; requestId: string; status: number; duration: number; cached: boolean }
  | { type: 'request.rate_limited'; requestId: string; clientId: string; retryAfterMs: number }
  | { type: 'circuit.opened'; backend: string; failures: number }
  | { type: 'circuit.closed'; backend: string }
  | { type: 'cache.hit'; requestId: string; path: string }
  | { type: 'cache.miss'; requestId: string; path: string }
  | { type: 'backend.error'; backend: string; error: string };

// Default configuration
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

## Part 2: Circuit Breaker GenServer

The circuit breaker protects backends from cascading failures:

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
    console.log(`[CircuitBreaker:${backendName}] initialized`);
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

        // Closed: allow all requests
        if (state.state === 'closed') {
          return [{ allowed: true, state: 'closed' }, state];
        }

        // Open: check if timeout has passed
        if (state.state === 'open') {
          if (now - state.lastFailureTime >= state.config.resetTimeoutMs) {
            // Transition to half-open
            console.log(`[CircuitBreaker:${state.backendName}] Transitioning to half-open`);
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

        // Half-open: allow limited requests
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
            // Close the circuit
            console.log(`[CircuitBreaker:${state.backendName}] Circuit closed after recovery`);
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

        // Reset failures on success in closed state
        if (state.state === 'closed') {
          return { ...state, failures: 0 };
        }

        return state;
      }

      case 'recordFailure': {
        const newFailures = state.failures + 1;
        const now = Date.now();

        // In half-open: immediately reopen
        if (state.state === 'half_open') {
          console.log(`[CircuitBreaker:${state.backendName}] Circuit reopened (half-open failure)`);
          return {
            ...state,
            state: 'open',
            failures: newFailures,
            lastFailureTime: now,
            successes: 0,
            halfOpenAttempts: 0,
          };
        }

        // In closed: check threshold
        if (newFailures >= state.config.failureThreshold) {
          console.log(`[CircuitBreaker:${state.backendName}] Circuit opened (${newFailures} failures)`);
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
        console.log(`[CircuitBreaker:${state.backendName}] Circuit reset`);
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
    console.log(`[CircuitBreaker:${state.backendName}] terminated: ${reason}`);
  },
};

// Start a circuit breaker for a backend
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

// Check if request is allowed
export async function canRequest(ref: GenServerRef): Promise<{ allowed: boolean; state: CircuitState }> {
  return GenServer.call(ref, { type: 'canRequest' }) as Promise<{ allowed: boolean; state: CircuitState }>;
}

// Record success
export function recordSuccess(ref: GenServerRef): void {
  GenServer.cast(ref, { type: 'recordSuccess' });
}

// Record failure
export function recordFailure(ref: GenServerRef): void {
  GenServer.cast(ref, { type: 'recordFailure' });
}
```

## Part 3: Router GenServer

The router maps incoming requests to backend services:

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

    // Sort routes by specificity (more specific paths first)
    const sortedRoutes = [...routes].sort((a, b) => {
      const aWildcards = (a.path.match(/\*/g) || []).length;
      const bWildcards = (b.path.match(/\*/g) || []).length;
      if (aWildcards !== bWildcards) return aWildcards - bWildcards;
      return b.path.length - a.path.length;
    });

    console.log(`[Router] initialized with ${sortedRoutes.length} routes and ${backends.length} backends`);
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
        console.log(`[Router] Added route: ${msg.route.path}`);
        return { ...state, routes };
      }

      case 'removeRoute': {
        const routes = state.routes.filter((r) => r.path !== msg.path);
        console.log(`[Router] Removed route: ${msg.path}`);
        return { ...state, routes };
      }

      case 'addBackend': {
        const backends = new Map(state.backends);
        backends.set(msg.backend.name, msg.backend);
        console.log(`[Router] Added backend: ${msg.backend.name}`);
        return { ...state, backends };
      }

      case 'removeBackend': {
        const backends = new Map(state.backends);
        backends.delete(msg.name);
        console.log(`[Router] Removed backend: ${msg.name}`);
        return { ...state, backends };
      }
    }
  },

  terminate(reason: string, state: RouterState): void {
    console.log(`[Router] terminated: ${reason}`);
  },
};

// Find matching route for a request
function findMatchingRoute(
  request: GatewayRequest,
  routes: RouteConfig[],
  backends: Map<string, BackendConfig>
): RouteMatch | null {
  for (const route of routes) {
    // Check method
    if (route.methods && !route.methods.includes(request.method)) {
      continue;
    }

    // Check path match
    const match = matchPath(route.path, request.path);
    if (match) {
      const backend = backends.get(route.backend);
      if (!backend) {
        console.warn(`[Router] Backend not found: ${route.backend}`);
        continue;
      }

      return { route, backend, params: match.params };
    }
  }

  return null;
}

// Match path pattern against actual path
function matchPath(
  pattern: string,
  path: string
): { params: Record<string, string> } | null {
  // Convert pattern to regex
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

// Start the router
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

// Match a request to a route
export async function matchRoute(
  router: GenServerRef,
  request: GatewayRequest
): Promise<RouteMatch | null> {
  return GenServer.call(router, { type: 'match', request }) as Promise<RouteMatch | null>;
}
```

## Part 4: Request Handler GenServer

The request handler orchestrates the entire request flow:

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
    console.log('[RequestHandler] initialized');
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
            circuitBreaks: 0, // Could track this in state
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
    console.log(`[RequestHandler] terminated: ${reason}`);
  },
};

// Main request handling logic
async function handleRequest(
  request: GatewayRequest,
  state: RequestHandlerState
): Promise<GatewayResponse> {
  const startTime = Date.now();

  // Publish request received event
  publishEvent(state.eventBus, {
    type: 'request.received',
    requestId: request.id,
    path: request.path,
    clientId: request.clientId,
  });

  try {
    // Step 1: Match route
    const match = await matchRoute(state.router, request);
    if (!match) {
      return {
        status: 404,
        headers: {},
        body: { error: 'Not Found', message: `No route found for ${request.path}` },
        cached: false,
      };
    }

    // Step 2: Rate limiting
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
            error: 'Too Many Requests',
            message: 'Rate limit exceeded',
            retryAfterMs: error.retryAfterMs,
          },
          cached: false,
        };
      }
      throw error;
    }

    // Step 3: Check cache (only for GET requests)
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

    // Step 4: Check circuit breaker
    const circuitBreaker = state.circuitBreakers.get(match.backend.name);
    if (circuitBreaker) {
      const circuitStatus = await canRequest(circuitBreaker);
      if (!circuitStatus.allowed) {
        return {
          status: 503,
          headers: { 'Retry-After': '30' },
          body: {
            error: 'Service Unavailable',
            message: `Backend ${match.backend.name} is temporarily unavailable`,
          },
          cached: false,
        };
      }
    }

    // Step 5: Forward to backend
    const backendResponse = await forwardToBackend(request, match.backend, match.params);

    // Step 6: Update circuit breaker
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

    // Step 7: Cache response (only for successful GET requests)
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
    console.error(`[RequestHandler] Error handling request ${request.id}:`, errorMessage);

    return {
      status: 500,
      headers: {},
      body: { error: 'Internal Server Error', message: errorMessage },
      cached: false,
    };
  }
}

// Forward request to backend service
async function forwardToBackend(
  request: GatewayRequest,
  backend: { baseUrl: string; timeout?: number },
  params: Record<string, string>
): Promise<GatewayResponse> {
  const startTime = Date.now();

  // Build backend URL
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
        body: { error: 'Gateway Timeout', message: 'Backend request timed out' },
        cached: false,
      };
    }

    throw error;
  }
}

// Invalidate cache entries matching a pattern
async function invalidateCachePattern(cache: CacheRef, pattern: string): Promise<void> {
  const keys = await Cache.keys(cache);
  for (const key of keys) {
    if (key.includes(pattern)) {
      await Cache.delete(cache, key);
    }
  }
}

// Publish event to EventBus
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

// Start the request handler
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

// Handle a request
export async function handleGatewayRequest(
  handler: GenServerRef,
  request: GatewayRequest
): Promise<GatewayResponse> {
  return GenServer.call(handler, { type: 'handleRequest', request }) as Promise<GatewayResponse>;
}

// Invalidate cache
export function invalidateCache(handler: GenServerRef, pattern: string): void {
  GenServer.cast(handler, { type: 'invalidateCache', pattern });
}
```

## Part 5: API Gateway Application

Bring everything together with the main application:

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
    console.log('[APIGateway] Starting...');

    // 1. Start EventBus
    const eventBus = await EventBus.start({ name: 'gateway-events' });
    console.log('[APIGateway] EventBus started');

    // 2. Start Cache
    const cache = await Cache.start({
      maxSize: config.cache.maxSize,
      defaultTtlMs: config.cache.defaultTtlMs,
      name: 'gateway-cache',
    });
    console.log('[APIGateway] Cache started');

    // 3. Start RateLimiter
    const rateLimiter = await RateLimiter.start({
      maxRequests: config.defaultRateLimit.maxRequests,
      windowMs: config.defaultRateLimit.windowMs,
      name: 'gateway-rate-limiter',
    });
    console.log('[APIGateway] RateLimiter started');

    // 4. Start Router
    const router = await startRouter(config.routes, config.backends);
    console.log('[APIGateway] Router started');

    // 5. Start Circuit Breakers for each backend
    const circuitBreakers = new Map<string, GenServerRef>();
    for (const backend of config.backends) {
      const breaker = await startCircuitBreaker(backend.name, {
        failureThreshold: config.circuitBreaker.failureThreshold,
        resetTimeoutMs: config.circuitBreaker.resetTimeoutMs,
        halfOpenRequests: config.circuitBreaker.halfOpenRequests,
      });
      circuitBreakers.set(backend.name, breaker);
    }
    console.log(`[APIGateway] ${circuitBreakers.size} Circuit Breakers started`);

    // 6. Start Request Handler
    const requestHandler = await startRequestHandler(
      config,
      router,
      cache,
      rateLimiter,
      circuitBreakers,
      eventBus
    );
    console.log('[APIGateway] RequestHandler started');

    // 7. Create top-level supervisor
    const supervisor = await Supervisor.start({
      strategy: 'one_for_all',
      children: [],
      restartIntensity: {
        maxRestarts: 5,
        withinMs: 60_000,
      },
    });

    console.log('[APIGateway] Started successfully');

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
    console.log(`[APIGateway] Preparing to stop: ${reason}`);
    // Allow in-flight requests to complete (no new requests will be accepted)
    await new Promise((resolve) => setTimeout(resolve, 1000));
  },

  async stop(reason, state) {
    console.log(`[APIGateway] Stopping: ${reason}`);

    // Stop in reverse order
    await GenServer.stop(state.requestHandler);

    for (const [name, breaker] of state.circuitBreakers) {
      await GenServer.stop(breaker);
      try {
        Registry.unregister(`circuit-breaker:${name}`);
      } catch { /* ignore */ }
    }

    await GenServer.stop(state.router);
    await RateLimiter.stop(state.rateLimiter);
    await Cache.stop(state.cache);
    await EventBus.stop(state.eventBus);

    // Cleanup registry
    try {
      Registry.unregister('gateway-router');
      Registry.unregister('gateway-handler');
    } catch { /* ignore */ }

    console.log('[APIGateway] Stopped');
  },
};

// High-level Gateway class
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
      throw new Error('Gateway not started');
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
      throw new Error('Gateway not started');
    }
    invalidateCache(this.state.requestHandler, pattern);
  }

  onEvent(handler: (event: GatewayEvent) => void): () => Promise<void> {
    if (!this.state) {
      throw new Error('Gateway not started');
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
      throw new Error('Gateway not started');
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

## Part 6: Request Flow

Here's how a request flows through the gateway:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              REQUEST FLOW                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Client                                                                     │
│    │                                                                        │
│    ▼ GET /api/users/123                                                     │
│  ┌──────────────────┐                                                       │
│  │  Request Handler │                                                       │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Step 1: Route Matching                                                 │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │     Router       │──► Match "/api/users/:id" → backend: "users-service"  │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Step 2: Rate Limit Check                                               │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │   RateLimiter    │──► client:abc:/api/users/* → 5/100 used → ALLOWED     │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Step 3: Cache Lookup (GET only)                                        │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │      Cache       │──► GET:/api/users/123 → MISS                          │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Step 4: Circuit Breaker Check                                          │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │ Circuit Breaker  │──► users-service: CLOSED → ALLOWED                    │
│  │ (users-service)  │                                                       │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Step 5: Forward to Backend                                             │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │  Backend Call    │──► http://users-api:3001/api/users/123                │
│  │                  │                                                       │
│  │  ← 200 OK        │◄── { "id": "123", "name": "Alice", ... }              │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Step 6: Update Circuit Breaker                                         │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │ Circuit Breaker  │◄── recordSuccess()                                    │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Step 7: Cache Response                                                 │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │      Cache       │◄── set("GET:/api/users/123", response, ttl=30s)       │
│  └──────────────────┘                                                       │
│    │                                                                        │
│    │ Step 8: Return to Client                                               │
│    ▼                                                                        │
│  ┌──────────────────┐                                                       │
│  │     Client       │◄── 200 OK + headers + body                            │
│  └──────────────────┘                                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Part 7: Usage Example

Here's a complete example showing the gateway in action:

```typescript
// src/api-gateway/example.ts
import { APIGateway } from './gateway-application';
import type { GatewayEvent } from './types';

async function main() {
  const gateway = new APIGateway();

  // Start with configuration
  await gateway.start({
    backends: [
      { name: 'users-service', baseUrl: 'http://localhost:3001', timeout: 5000 },
      { name: 'orders-service', baseUrl: 'http://localhost:3002', timeout: 10000 },
      { name: 'products-service', baseUrl: 'http://localhost:3003', timeout: 5000 },
    ],
    routes: [
      { path: '/api/users/*', backend: 'users-service', cacheTtlMs: 30000 },
      { path: '/api/orders/*', backend: 'orders-service', cacheTtlMs: 0 }, // No cache
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

  // Subscribe to events
  const unsubscribe = gateway.onEvent((event: GatewayEvent) => {
    switch (event.type) {
      case 'request.completed':
        console.log(
          `[Event] Request ${event.requestId} completed: ${event.status} ` +
          `(${event.duration}ms, cached: ${event.cached})`
        );
        break;
      case 'request.rate_limited':
        console.log(`[Event] Request ${event.requestId} rate limited (retry in ${event.retryAfterMs}ms)`);
        break;
      case 'circuit.opened':
        console.log(`[Event] Circuit opened for ${event.backend} (${event.failures} failures)`);
        break;
      case 'cache.hit':
        console.log(`[Event] Cache hit for ${event.path}`);
        break;
    }
  });

  // Make requests
  console.log('\n--- Making API requests ---\n');

  // Request 1: First request (cache miss)
  const response1 = await gateway.handleRequest('GET', '/api/users/123', {
    clientId: 'client-abc',
    headers: { 'Accept': 'application/json' },
  });
  console.log('Response 1:', response1.status, response1.cached ? '(cached)' : '(fresh)');

  // Request 2: Same request (cache hit)
  const response2 = await gateway.handleRequest('GET', '/api/users/123', {
    clientId: 'client-abc',
  });
  console.log('Response 2:', response2.status, response2.cached ? '(cached)' : '(fresh)');

  // Request 3: Different user
  const response3 = await gateway.handleRequest('GET', '/api/users/456', {
    clientId: 'client-abc',
  });
  console.log('Response 3:', response3.status, response3.cached ? '(cached)' : '(fresh)');

  // Request 4: POST (no caching)
  const response4 = await gateway.handleRequest('POST', '/api/orders', {
    clientId: 'client-abc',
    body: { productId: '789', quantity: 2 },
  });
  console.log('Response 4:', response4.status, response4.cached ? '(cached)' : '(fresh)');

  // Invalidate user cache
  console.log('\n--- Invalidating user cache ---\n');
  gateway.invalidateCache('/api/users');

  // Request 5: After invalidation (cache miss again)
  const response5 = await gateway.handleRequest('GET', '/api/users/123', {
    clientId: 'client-abc',
  });
  console.log('Response 5:', response5.status, response5.cached ? '(cached)' : '(fresh)');

  // Get stats
  const stats = await gateway.getStats();
  console.log('\n--- Gateway Stats ---');
  console.log('Cache:', stats.cache);

  // Cleanup
  await unsubscribe();
  await gateway.stop();
  console.log('\n--- Gateway stopped ---');
}

main().catch(console.error);
```

## Part 8: Express Integration

Here's how to integrate the gateway with an Express server:

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

  // Gateway route - handles all /api/* requests
  app.all('/api/*', async (req, res) => {
    try {
      const clientId = (req.headers['x-api-key'] as string) || req.ip || 'anonymous';

      const response = await gateway.handleRequest(req.method, req.path, {
        clientId,
        headers: req.headers as Record<string, string>,
        body: req.body,
      });

      // Copy headers from gateway response
      for (const [key, value] of Object.entries(response.headers)) {
        res.setHeader(key, value);
      }

      // Add cache indicator header
      if (response.cached) {
        res.setHeader('X-Cache', 'HIT');
      } else {
        res.setHeader('X-Cache', 'MISS');
      }

      res.status(response.status).json(response.body);
    } catch (error) {
      console.error('Gateway error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
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
    console.log(`API Gateway listening on port ${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    server.close();
    await gateway.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);
```

## Testing the API Gateway

```typescript
// tests/api-gateway.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { APIGateway } from '../src/api-gateway/gateway-application';
import type { GatewayResponse, GatewayEvent } from '../src/api-gateway/types';

// Mock fetch for backend calls
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

  it('should route requests to correct backend', async () => {
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

  it('should return 404 for unmatched routes', async () => {
    const response = await gateway.handleRequest('GET', '/unknown/path', {
      clientId: 'test-client',
    });

    expect(response.status).toBe(404);
    expect(response.body).toEqual(
      expect.objectContaining({ error: 'Not Found' })
    );
  });

  it('should cache GET responses', async () => {
    mockBackendResponse(200, { id: '123', name: 'Alice' });

    // First request - cache miss
    const response1 = await gateway.handleRequest('GET', '/api/users/123', {
      clientId: 'test-client',
    });
    expect(response1.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await waitFor(50);

    // Second request - cache hit
    const response2 = await gateway.handleRequest('GET', '/api/users/123', {
      clientId: 'test-client',
    });
    expect(response2.cached).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1); // No additional call

    // Verify cache events
    expect(events.some((e) => e.type === 'cache.miss')).toBe(true);
    expect(events.some((e) => e.type === 'cache.hit')).toBe(true);
  });

  it('should not cache routes with cacheTtlMs: 0', async () => {
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

  it('should enforce rate limits', async () => {
    mockBackendResponse(200, { ok: true });
    mockBackendResponse(200, { ok: true });
    mockBackendResponse(200, { ok: true });
    mockBackendResponse(200, { ok: true });
    mockBackendResponse(200, { ok: true });

    // Make 5 requests (limit)
    for (let i = 0; i < 5; i++) {
      const response = await gateway.handleRequest('GET', `/api/users/${i}`, {
        clientId: 'test-client',
      });
      expect(response.status).toBe(200);
    }

    // 6th request should be rate limited
    const response = await gateway.handleRequest('GET', '/api/users/6', {
      clientId: 'test-client',
    });
    expect(response.status).toBe(429);
    expect(response.body).toEqual(
      expect.objectContaining({ error: 'Too Many Requests' })
    );

    expect(events.some((e) => e.type === 'request.rate_limited')).toBe(true);
  });

  it('should open circuit breaker after failures', async () => {
    // Simulate backend failures
    mockFetch.mockRejectedValue(new Error('Connection refused'));
    mockFetch.mockRejectedValue(new Error('Connection refused'));
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    // Make 3 failing requests (threshold)
    for (let i = 0; i < 3; i++) {
      await gateway.handleRequest('GET', `/api/users/${i}`, {
        clientId: `client-${i}`, // Different clients to avoid rate limit
      });
    }

    await waitFor(50);

    // Circuit should be open now
    const response = await gateway.handleRequest('GET', '/api/users/99', {
      clientId: 'client-99',
    });
    expect(response.status).toBe(503);
    expect(response.body).toEqual(
      expect.objectContaining({ error: 'Service Unavailable' })
    );
  });

  it('should invalidate cache on demand', async () => {
    mockBackendResponse(200, { id: '123', name: 'Alice' });
    mockBackendResponse(200, { id: '123', name: 'Alice Updated' });

    // First request - populate cache
    await gateway.handleRequest('GET', '/api/users/123', { clientId: 'test' });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Invalidate cache
    gateway.invalidateCache('/api/users');
    await waitFor(50);

    // Next request should hit backend again
    const response = await gateway.handleRequest('GET', '/api/users/123', { clientId: 'test' });
    expect(response.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should emit events for request lifecycle', async () => {
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

## Exercise: Add Request Retry with Backoff

Enhance the API gateway with automatic request retries:

**Requirements:**
1. Add configurable retry count per route (default: 0)
2. Implement exponential backoff between retries
3. Only retry on 5xx errors or timeouts (not 4xx)
4. Track retry attempts in events
5. Add retry headers to response (`X-Retry-Count`)

**Starter code:**

```typescript
// Extend RouteConfig
interface RouteConfig {
  // ... existing fields
  retries?: number;           // Max retry attempts (default: 0)
  retryDelayMs?: number;      // Base delay for exponential backoff
}

// Extend GatewayEvent
type GatewayEvent =
  // ... existing events
  | { type: 'request.retry'; requestId: string; attempt: number; reason: string };

// In request-handler.ts, modify forwardToBackend:
async function forwardWithRetry(
  request: GatewayRequest,
  backend: BackendConfig,
  params: Record<string, string>,
  retries: number,
  retryDelayMs: number
): Promise<GatewayResponse> {
  // TODO: Implement retry logic with exponential backoff
  // TODO: Only retry on 5xx or timeout
  // TODO: Emit retry events
  // TODO: Add X-Retry-Count header to response
}
```

<details>
<summary><strong>Solution</strong></summary>

```typescript
// Extended types
interface RetryableRouteConfig extends RouteConfig {
  retries?: number;          // Max retry attempts (default: 0)
  retryDelayMs?: number;     // Base delay for exponential backoff (default: 1000)
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

// Calculate exponential backoff delay with jitter
function calculateBackoff(attempt: number, baseDelayMs: number): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 0.2 * exponentialDelay; // 20% jitter
  return Math.min(exponentialDelay + jitter, 30000); // Max 30 seconds
}

// Check if error is retryable
function isRetryableError(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

// Forward request with retry logic
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

      // Success or non-retryable error
      if (!isRetryableError(response.status)) {
        return { ...response, retryCount: attempt - 1 };
      }

      // Retryable error
      lastResponse = response;

      if (attempt <= maxRetries) {
        const delay = calculateBackoff(attempt, baseRetryDelayMs);

        // Emit retry event
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
          `[Retry] Request ${request.id} attempt ${attempt}/${maxRetries + 1} ` +
          `failed with ${response.status}, retrying in ${delay}ms`
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if timeout (AbortError) - retryable
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
          reason: isTimeout ? 'Timeout' : 'Network error',
          nextRetryMs: delay,
        } satisfies RetryEvent);

        console.log(
          `[Retry] Request ${request.id} attempt ${attempt}/${maxRetries + 1} ` +
          `failed with ${lastError.message}, retrying in ${delay}ms`
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // All retries exhausted
  if (lastResponse) {
    return { ...lastResponse, retryCount: maxRetries };
  }

  // Return error response
  return {
    status: 502,
    headers: {},
    body: {
      error: 'Bad Gateway',
      message: lastError?.message ?? 'All retry attempts failed',
    },
    cached: false,
    retryCount: maxRetries,
  };
}

// Modified handleRequest function
async function handleRequest(
  request: GatewayRequest,
  state: RequestHandlerState
): Promise<GatewayResponse> {
  // ... existing code until backend forwarding ...

  // Step 5: Forward to backend with retries
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

  // Add retry header if retries occurred
  if (backendResponse.retryCount > 0) {
    backendResponse.headers['X-Retry-Count'] = String(backendResponse.retryCount);
  }

  // ... rest of the existing code ...

  return backendResponse;
}

// Usage example
const gateway = new APIGateway();

await gateway.start({
  backends: [
    { name: 'flaky-service', baseUrl: 'http://flaky:3000', timeout: 5000 },
  ],
  routes: [
    {
      path: '/api/critical/*',
      backend: 'flaky-service',
      retries: 3,           // Retry up to 3 times
      retryDelayMs: 1000,   // Start with 1s delay
    },
    {
      path: '/api/standard/*',
      backend: 'flaky-service',
      retries: 1,           // Single retry
      retryDelayMs: 500,
    },
  ],
});

// Subscribe to retry events
gateway.onEvent((event) => {
  if (event.type === 'request.retry') {
    console.log(
      `Retrying request ${event.requestId} to ${event.backend}: ` +
      `attempt ${event.attempt}/${event.maxAttempts} (${event.reason})`
    );
  }
});
```

**Key design decisions:**

1. **Exponential backoff with jitter** — Prevents thundering herd when multiple requests fail simultaneously

2. **Selective retry** — Only 5xx errors, timeouts, and network errors are retried (not 4xx client errors)

3. **Retry header** — `X-Retry-Count` tells clients how many retries occurred

4. **Event emission** — Each retry is logged for monitoring and debugging

5. **Per-route configuration** — Different routes can have different retry policies based on their criticality

**Retry timing example:**

```
Attempt 1: immediate
Attempt 2: ~1000ms (1s base)
Attempt 3: ~2000ms (2s exponential)
Attempt 4: ~4000ms (4s exponential)
Max delay: 30000ms (30s cap)
```

</details>

## Summary

**Key takeaways:**

- **Rate Limiter** — Per-client sliding window limits protect against abuse
- **Response Cache** — Reduces backend load with configurable TTL per route
- **Circuit Breaker** — Automatically fails fast when backends are unhealthy
- **Router** — Pattern-based routing with path parameters
- **Event-driven monitoring** — All operations emit events for observability

**Architecture patterns used:**

| Pattern | Where Used |
|---------|------------|
| Pipeline | Request flows through rate limit → cache → circuit → backend |
| Circuit Breaker | Per-backend failure detection and recovery |
| Caching | Response cache with LRU eviction |
| Rate Limiting | Sliding window per client/route |
| Pub/Sub | EventBus for gateway events |
| Application | System composition and lifecycle |

**Production considerations:**

| Concern | Solution |
|---------|----------|
| Persistence | Use persistence adapter for rate limiter state across restarts |
| Distributed | Share rate limit state via Redis adapter for multi-instance deployment |
| Health checks | Add periodic backend health checks to preemptively open circuits |
| Metrics | Export Prometheus metrics from gateway events |
| Logging | Structured JSON logging for request tracing |
| Security | Add authentication/authorization middleware |

**What you've learned:**

1. How to design a composable API gateway with noex
2. Rate limiting with proper HTTP headers and client feedback
3. Response caching with TTL and cache invalidation
4. Circuit breaker pattern for backend protection
5. Path-based routing with parameter extraction
6. Event-driven monitoring for observability
7. Graceful shutdown with in-flight request handling

> **Architecture insight:** The API gateway demonstrates how the actor model naturally handles cross-cutting concerns. Each component (rate limiter, cache, circuit breaker) is an independent process with its own state, communicating through messages. This makes the system easy to reason about, test, and extend — adding a new middleware is just adding another GenServer to the pipeline.

---

Congratulations! You've completed the noex learning guide.

## What's Next?

- Explore the [API Reference](../../api/index.md) for detailed documentation
- Check out more [Examples](../../examples/index.md) for real-world patterns
- Join the community to share your projects and get help
