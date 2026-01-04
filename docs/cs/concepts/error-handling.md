# Zpracování chyb

noex poskytuje strukturované zpracování chyb inspirované Elixir filozofií "let it crash" (nech to spadnout). Místo defenzivního programování všude jsou chyby izolovány do jednotlivých procesů a zpracovávány prostřednictvím supervize.

## Filozofie: Let It Crash

Tradiční zpracování chyb se snaží předvídat a ošetřit každou možnou chybu:

```typescript
// Tradiční defenzivní přístup
async function processRequest(data: unknown) {
  try {
    if (!data) throw new Error('Žádná data');
    if (!isValid(data)) throw new Error('Neplatná data');

    const result = await riskyOperation(data);
    if (!result) throw new Error('Operace selhala');

    return result;
  } catch (error) {
    logger.error(error);
    return null;
  }
}
```

Přístup "let it crash":

```typescript
// noex přístup - nech neočekávané chyby shodit proces
const behavior: GenServerBehavior<State, Msg, Cast, Reply> = {
  init: () => initialState,

  handleCall: (msg, state) => {
    // Ošetři očekávané případy, nech neočekávané spadnout
    const result = processData(msg.data);
    return [result, state];
  },

  handleCast: (msg, state) => state,
};

// Supervisor restartuje při pádu
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [{ id: 'processor', start: () => GenServer.start(behavior) }],
});
```

### Výhody

1. **Jednodušší kód** - Ošetři očekávané případy, nemusíš předvídat každou chybu
2. **Izolace chyb** - Chyby se nešíří za hranice spadlého procesu
3. **Automatická obnova** - Supervisoři restartují spadlé procesy
4. **Čistý stav** - Restart dá čerstvý, známý dobrý stav

## Typy chyb

noex poskytuje specifické třídy chyb pro různé režimy selhání:

### CallTimeoutError

Vyhozena když `GenServer.call()` nedostane odpověď včas:

```typescript
import { CallTimeoutError } from 'noex';

try {
  await GenServer.call(ref, msg, { timeout: 5000 });
} catch (error) {
  if (error instanceof CallTimeoutError) {
    console.error(`Volání vypršelo po ${error.timeoutMs}ms`);
    console.error(`Server: ${error.serverId}`);
  }
}
```

**Běžné příčiny:**
- Server zpracovává pomalou operaci
- Server je zablokovaný nebo v deadlocku
- Server spadl během zpracování

### ServerNotRunningError

Vyhozena při pokusu o interakci se zastaveným serverem:

```typescript
import { ServerNotRunningError } from 'noex';

try {
  await GenServer.call(ref, msg);
} catch (error) {
  if (error instanceof ServerNotRunningError) {
    console.error(`Server ${error.serverId} neběží`);
  }
}
```

**Běžné příčiny:**
- Server byl zastaven
- Server spadl a nebyl restartován
- Použití zastaralé reference

### InitializationError

Vyhozena když `GenServer.start()` selže během inicializace:

```typescript
import { InitializationError } from 'noex';

try {
  await GenServer.start(behavior);
} catch (error) {
  if (error instanceof InitializationError) {
    console.error(`Server ${error.serverId} selhal při inicializaci`);
    console.error(`Příčina:`, error.cause);
  }
}
```

**Běžné příčiny:**
- `init()` vyhodil výjimku
- `init()` vypršel timeout
- Požadované zdroje nedostupné

### MaxRestartsExceededError

Vyhozena když supervisor překročí limit intenzity restartů:

```typescript
import { MaxRestartsExceededError } from 'noex';

try {
  await Supervisor.start({
    restartIntensity: { maxRestarts: 3, withinMs: 5000 },
    children: [{ id: 'unstable', start: () => GenServer.start(crashingBehavior) }],
  });
} catch (error) {
  if (error instanceof MaxRestartsExceededError) {
    console.error(`Supervisor ${error.supervisorId} to vzdal`);
    console.error(`${error.maxRestarts} restartů za ${error.withinMs}ms`);
  }
}
```

### DuplicateChildError

Vyhozena při přidání potomka s ID, které již existuje:

```typescript
import { DuplicateChildError } from 'noex';

try {
  await Supervisor.startChild(supervisor, { id: 'worker', start: ... });
  await Supervisor.startChild(supervisor, { id: 'worker', start: ... }); // Vyhodí!
} catch (error) {
  if (error instanceof DuplicateChildError) {
    console.error(`Potomek '${error.childId}' již existuje`);
  }
}
```

### ChildNotFoundError

Vyhozena při odkazování na neexistujícího potomka:

```typescript
import { ChildNotFoundError } from 'noex';

try {
  await Supervisor.terminateChild(supervisor, 'unknown');
} catch (error) {
  if (error instanceof ChildNotFoundError) {
    console.error(`Potomek '${error.childId}' nenalezen`);
  }
}
```

### NotRegisteredError

Vyhozena při vyhledávání neregistrovaného jména:

```typescript
import { NotRegisteredError } from 'noex';

try {
  Registry.lookup('unknown-service');
} catch (error) {
  if (error instanceof NotRegisteredError) {
    console.error(`Žádný proces pojmenovaný '${error.processName}'`);
  }
}
```

### AlreadyRegisteredError

Vyhozena při registraci jména, které je již používáno:

```typescript
import { AlreadyRegisteredError } from 'noex';

try {
  Registry.register('counter', ref1);
  Registry.register('counter', ref2); // Vyhodí!
} catch (error) {
  if (error instanceof AlreadyRegisteredError) {
    console.error(`Jméno '${error.registeredName}' je obsazeno`);
  }
}
```

## Šíření chyb

### V handleCall

Chyby vyhozené v `handleCall` jsou propagovány volajícímu:

```typescript
const behavior = {
  handleCall: (msg, state) => {
    if (msg.type === 'validate') {
      if (!isValid(msg.data)) {
        throw new Error('Validace selhala');
      }
      return [true, state];
    }
    return [null, state];
  },
  // ...
};

// Volající obdrží chybu
try {
  await GenServer.call(server, { type: 'validate', data: badData });
} catch (error) {
  // "Validace selhala"
}
```

Server pokračuje v běhu - chyba je izolována na toto volání.

### V handleCast

Chyby v `handleCast` jsou tiše spolknuty (není komu je oznámit):

```typescript
const behavior = {
  handleCast: (msg, state) => {
    if (msg.type === 'process') {
      throw new Error('Zpracování selhalo'); // Tiché!
    }
    return state;
  },
  // ...
};

GenServer.cast(server, { type: 'process', data: badData });
// Žádná chyba nevyhozena - fire and forget
```

Použijte události životního cyklu pro monitoring selhání castů:

```typescript
GenServer.onLifecycleEvent((event) => {
  if (event.type === 'crashed') {
    console.error('Server spadl:', event.error);
  }
});
```

### V init

Chyby v `init` zabrání spuštění serveru:

```typescript
const behavior = {
  init: async () => {
    const conn = await connectToDatabase();
    if (!conn) {
      throw new Error('Databáze nedostupná');
    }
    return { conn };
  },
  // ...
};

try {
  await GenServer.start(behavior);
} catch (error) {
  // InitializationError s příčinou "Databáze nedostupná"
}
```

### V terminate

Chyby v `terminate` během korektního ukončení jsou zalogované, ale neovlivní ukončení:

```typescript
const behavior = {
  terminate: async (reason, state) => {
    await state.conn.close(); // Může vyhodit
  },
  // ...
};

await GenServer.stop(server);
// Dokončí se i když terminate vyhodí
```

## Strategie obnovy

### Restart Supervisorem

Primární mechanismus obnovy - nech supervisory restartovat spadlé procesy:

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  restartIntensity: { maxRestarts: 5, withinMs: 60000 },
  children: [
    { id: 'worker', start: () => GenServer.start(workerBehavior) },
  ],
});
```

### Retry s backoffem

Pro přechodná selhání implementuj logiku opakování:

```typescript
async function callWithRetry<T>(
  ref: GenServerRef,
  msg: unknown,
  maxRetries = 3,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await GenServer.call(ref, msg);
    } catch (error) {
      lastError = error as Error;

      if (error instanceof ServerNotRunningError) {
        throw error; // Neopakuj, pokud server neexistuje
      }

      // Exponenciální backoff
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 100));
    }
  }

  throw lastError;
}
```

### Circuit Breaker

Prevence kaskádových selhání:

```typescript
class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private open = false;

  constructor(
    private threshold = 5,
    private resetTimeout = 30000,
  ) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.open) {
      if (Date.now() - this.lastFailure > this.resetTimeout) {
        this.open = false;
        this.failures = 0;
      } else {
        throw new Error('Circuit breaker je otevřený');
      }
    }

    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailure = Date.now();

      if (this.failures >= this.threshold) {
        this.open = true;
      }

      throw error;
    }
  }
}
```

### Fallback hodnoty

Vrať výchozí hodnoty když služba není dostupná:

```typescript
async function getConfig(key: string): Promise<string> {
  const configServer = Registry.whereis('config');

  if (!configServer) {
    return DEFAULT_CONFIG[key];
  }

  try {
    return await GenServer.call(configServer, { type: 'get', key });
  } catch (error) {
    console.warn(`Vyhledání konfigurace selhalo, používám výchozí pro ${key}`);
    return DEFAULT_CONFIG[key];
  }
}
```

## Osvědčené postupy

### 1. Používejte specifické typy chyb

```typescript
// Dobře: Specifické, zachytitelné chyby
class ValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

handleCall: (msg, state) => {
  if (!msg.email.includes('@')) {
    throw new ValidationError('email', 'Neplatný formát emailu');
  }
  // ...
}
```

### 2. Validujte na hranicích

```typescript
// Dobře: Validuj vstup na okraji
handleCall: (msg, state) => {
  // Nejdřív validuj
  if (msg.type !== 'create' && msg.type !== 'update') {
    throw new Error(`Neznámý typ zprávy: ${msg.type}`);
  }

  // Pak zpracuj s jistotou
  return processValidMessage(msg, state);
}
```

### 3. Izolujte rizikové operace

```typescript
// Dobře: Oddělte rizikové operace do dedikovaných procesů
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    // Jádrová služba - stabilní
    { id: 'core', start: () => GenServer.start(coreBehavior) },
    // Externí API - může selhat
    { id: 'external-api', start: () => GenServer.start(apiBehavior) },
  ],
});
```

### 4. Logujte před pádem

```typescript
handleCall: (msg, state) => {
  try {
    return processMessage(msg, state);
  } catch (error) {
    // Zaloguj kontext před pádem
    console.error('Zpracování selhalo', {
      message: msg,
      stateSnapshot: summarizeState(state),
      error,
    });
    throw error; // Nech supervisor ošetřit restart
  }
}
```

### 5. Navrhujte pro obnovu

```typescript
// Dobře: Stav lze obnovit po restartu
const behavior = {
  init: async () => {
    // Načti perzistovaný stav
    const saved = await loadFromDatabase();
    return saved ?? { items: [] };
  },

  handleCast: async (msg, state) => {
    if (msg.type === 'add') {
      const newState = { ...state, items: [...state.items, msg.item] };
      // Perzistuj změny
      await saveToDatabase(newState);
      return newState;
    }
    return state;
  },
};
```

## Související

- [Supervisor](./supervisor.md) - Automatický restart a odolnost vůči chybám
- [Životní cyklus](./lifecycle.md) - Stavy a přechody procesů
- [API Reference: Errors](../api/errors.md) - Kompletní reference tříd chyb
