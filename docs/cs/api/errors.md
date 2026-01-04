# Reference chyb

Tento dokument poskytuje kompletní referenci pro všechny třídy chyb exportované knihovnou noex.

## Import

```typescript
import {
  CallTimeoutError,
  ServerNotRunningError,
  InitializationError,
  MaxRestartsExceededError,
  DuplicateChildError,
  ChildNotFoundError,
  NotRegisteredError,
  AlreadyRegisteredError,
  RateLimitExceededError,
} from 'noex';
```

---

## Chyby GenServeru

### CallTimeoutError

Vyhozena, když `GenServer.call()` vyprší čas čekání na odpověď.

```typescript
class CallTimeoutError extends Error {
  readonly name = 'CallTimeoutError';
  readonly serverId: string;
  readonly timeoutMs: number;
}
```

**Vlastnosti:**
- `serverId` - ID GenServeru, který vypršel
- `timeoutMs` - Doba timeoutu v milisekundách

**Příklad:**
```typescript
try {
  await GenServer.call(ref, msg, { timeout: 1000 });
} catch (error) {
  if (error instanceof CallTimeoutError) {
    console.log(`Volání na ${error.serverId} vypršelo po ${error.timeoutMs}ms`);
  }
}
```

---

### ServerNotRunningError

Vyhozena při pokusu o call/cast na zastavený GenServer.

```typescript
class ServerNotRunningError extends Error {
  readonly name = 'ServerNotRunningError';
  readonly serverId: string;
}
```

**Vlastnosti:**
- `serverId` - ID GenServeru, který neběží

**Příklad:**
```typescript
try {
  await GenServer.call(ref, msg);
} catch (error) {
  if (error instanceof ServerNotRunningError) {
    console.log(`Server ${error.serverId} neběží`);
  }
}
```

---

### InitializationError

Vyhozena, když callback `init()` GenServeru selže.

```typescript
class InitializationError extends Error {
  readonly name = 'InitializationError';
  readonly serverId: string;
  readonly cause: Error;
}
```

**Vlastnosti:**
- `serverId` - ID GenServeru, který selhal při inicializaci
- `cause` - Původní chyba z `init()`

**Příklad:**
```typescript
try {
  await GenServer.start(behavior);
} catch (error) {
  if (error instanceof InitializationError) {
    console.log(`Selhala inicializace ${error.serverId}`);
    console.log(`Příčina: ${error.cause.message}`);
  }
}
```

---

## Chyby Supervisoru

### MaxRestartsExceededError

Vyhozena, když Supervisor překročí svůj limit intenzity restartů.

```typescript
class MaxRestartsExceededError extends Error {
  readonly name = 'MaxRestartsExceededError';
  readonly supervisorId: string;
  readonly maxRestarts: number;
  readonly withinMs: number;
}
```

**Vlastnosti:**
- `supervisorId` - ID Supervisoru
- `maxRestarts` - Maximální povolený počet restartů
- `withinMs` - Časové okno v milisekundách

**Příklad:**
```typescript
try {
  await Supervisor.start({
    children: [/* ... */],
    restartIntensity: { maxRestarts: 3, withinMs: 5000 },
  });
} catch (error) {
  if (error instanceof MaxRestartsExceededError) {
    console.log(`Supervisor ${error.supervisorId} překročil ${error.maxRestarts} restartů za ${error.withinMs}ms`);
  }
}
```

---

### DuplicateChildError

Vyhozena při pokusu o přidání potomka s duplicitním ID do Supervisoru.

```typescript
class DuplicateChildError extends Error {
  readonly name = 'DuplicateChildError';
  readonly supervisorId: string;
  readonly childId: string;
}
```

**Vlastnosti:**
- `supervisorId` - ID Supervisoru
- `childId` - Duplicitní ID potomka

**Příklad:**
```typescript
try {
  await Supervisor.startChild(supervisor, {
    id: 'worker',
    start: () => GenServer.start(behavior),
  });
} catch (error) {
  if (error instanceof DuplicateChildError) {
    console.log(`Potomek '${error.childId}' již existuje v supervisoru`);
  }
}
```

---

### ChildNotFoundError

Vyhozena, když potomek není nalezen v Supervisoru.

```typescript
class ChildNotFoundError extends Error {
  readonly name = 'ChildNotFoundError';
  readonly supervisorId: string;
  readonly childId: string;
}
```

**Vlastnosti:**
- `supervisorId` - ID Supervisoru
- `childId` - Chybějící ID potomka

**Příklad:**
```typescript
try {
  await Supervisor.terminateChild(supervisor, 'unknown-child');
} catch (error) {
  if (error instanceof ChildNotFoundError) {
    console.log(`Potomek '${error.childId}' nenalezen`);
  }
}
```

---

## Chyby Registry

### NotRegisteredError

Vyhozena, když vyhledání v Registry nenajde proces.

```typescript
class NotRegisteredError extends Error {
  readonly name = 'NotRegisteredError';
  readonly processName: string;
}
```

**Vlastnosti:**
- `processName` - Jméno, které nebylo nalezeno

**Příklad:**
```typescript
try {
  const ref = Registry.lookup('my-service');
} catch (error) {
  if (error instanceof NotRegisteredError) {
    console.log(`Žádný proces není registrován jako '${error.processName}'`);
  }
}
```

---

### AlreadyRegisteredError

Vyhozena při pokusu o registraci jména, které je již použito.

```typescript
class AlreadyRegisteredError extends Error {
  readonly name = 'AlreadyRegisteredError';
  readonly registeredName: string;
}
```

**Vlastnosti:**
- `registeredName` - Jméno, které je již registrováno

**Příklad:**
```typescript
try {
  await GenServer.start(behavior, { name: 'my-service' });
} catch (error) {
  if (error instanceof AlreadyRegisteredError) {
    console.log(`Jméno '${error.registeredName}' je již registrováno`);
  }
}
```

---

## Chyby RateLimiteru

### RateLimitExceededError

Vyhozena, když je překročen rate limit v `RateLimiter.consume()`.

```typescript
class RateLimitExceededError extends Error {
  readonly name = 'RateLimitExceededError';
  readonly key: string;
  readonly retryAfterMs: number;
}
```

**Vlastnosti:**
- `key` - Klíč rate limitu, který byl překročen
- `retryAfterMs` - Milisekundy do možnosti opakování požadavku

**Příklad:**
```typescript
try {
  await RateLimiter.consume(limiter, 'user:123');
} catch (error) {
  if (error instanceof RateLimitExceededError) {
    res.status(429).json({
      error: 'Příliš mnoho požadavků',
      retryAfter: Math.ceil(error.retryAfterMs / 1000),
    });
  }
}
```

---

## Vzory zpracování chyb

### Komplexní zpracování chyb

```typescript
import {
  GenServer,
  CallTimeoutError,
  ServerNotRunningError,
  InitializationError,
} from 'noex';

async function safeCall<T>(
  ref: GenServerRef,
  msg: unknown,
): Promise<T | null> {
  try {
    return await GenServer.call(ref, msg) as T;
  } catch (error) {
    if (error instanceof CallTimeoutError) {
      console.error(`Timeout při volání ${error.serverId}`);
    } else if (error instanceof ServerNotRunningError) {
      console.error(`Server ${error.serverId} zastaven`);
    } else {
      throw error; // Znovu vyhodit neočekávané chyby
    }
    return null;
  }
}
```

### Funkce pro type guard

```typescript
function isNoexError(error: unknown): error is Error & { name: string } {
  return error instanceof Error && 'name' in error;
}

function handleError(error: unknown): void {
  if (!isNoexError(error)) {
    throw error;
  }

  switch (error.name) {
    case 'CallTimeoutError':
      // Zpracování timeoutu
      break;
    case 'ServerNotRunningError':
      // Zpracování zastaveného serveru
      break;
    case 'MaxRestartsExceededError':
      // Zpracování selhání supervisoru
      break;
    default:
      throw error;
  }
}
```

---

## Související

- [Reference typů](./types.md) - Všechny definice typů
- [GenServer API](./genserver.md) - Metody GenServeru
- [Supervisor API](./supervisor.md) - Metody Supervisoru
- [RateLimiter API](./rate-limiter.md) - Rate limiting
