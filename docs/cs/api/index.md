# API Reference

Kompletní API dokumentace pro všechny moduly noex.

## Jádro

Základní stavební bloky pro konkurentní aplikace.

| Modul | Popis |
|-------|-------|
| [GenServer](./genserver.md) | Abstrakce stavového procesu |
| [Supervisor](./supervisor.md) | Odolnost proti chybám a automatické restarty |
| [Registry](./registry.md) | Vyhledávání pojmenovaných procesů |

## Služby

Předpřipravené služby pro běžné případy použití.

| Modul | Popis |
|-------|-------|
| [EventBus](./event-bus.md) | Pub/sub distribuce událostí |
| [Cache](./cache.md) | In-memory cache s TTL |
| [RateLimiter](./rate-limiter.md) | Rate limiting s klouzavým oknem |

## Observabilita

Nástroje pro monitoring a ladění.

| Modul | Popis |
|-------|-------|
| [Observer](./observer.md) | Runtime introspekce |
| [AlertManager](./alert-manager.md) | Alerty založené na prahových hodnotách |
| [Dashboard](./dashboard.md) | Terminálové UI pro monitoring |
| [DashboardServer](./dashboard-server.md) | HTTP dashboard server |

## Persistence

Ukládání stavu pro GenServer procesy.

| Modul | Popis |
|-------|-------|
| [Persistence](./persistence.md) | Ukládání stavu se zásuvnými adaptéry |

## Typy a chyby

| Modul | Popis |
|-------|-------|
| [Types](./types.md) | Všechny definice typů |
| [Errors](./errors.md) | Třídy chyb |

## Rychlý přehled

### Spouštění procesů

```typescript
// GenServer
const ref = await GenServer.start(behavior);

// Supervisor
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [{ id: 'worker', start: () => GenServer.start(behavior) }],
});
```

### Předávání zpráv

```typescript
// Synchronní (čeká na odpověď)
const result = await GenServer.call(ref, message);

// Asynchronní (fire-and-forget)
GenServer.cast(ref, message);
```

### Vyhledávání procesů

```typescript
// Registrace
Registry.register('service-name', ref);

// Vyhledání (vyhodí výjimku, pokud nenalezeno)
const ref = Registry.lookup('service-name');

// Vyhledání (vrátí undefined, pokud nenalezeno)
const ref = Registry.whereis('service-name');
```

### Zastavování procesů

```typescript
// GenServer
await GenServer.stop(ref);

// Supervisor (zastaví všechny potomky)
await Supervisor.stop(supervisor);
```

### Zpracování chyb

```typescript
import {
  CallTimeoutError,
  ServerNotRunningError,
  InitializationError,
  MaxRestartsExceededError,
  NotRegisteredError,
} from 'noex';

try {
  await GenServer.call(ref, msg);
} catch (error) {
  if (error instanceof CallTimeoutError) {
    // Zpracování timeoutu
  }
}
```
