# Životní cyklus procesu

Pochopení životního cyklu GenServerů a Supervisorů je zásadní pro vytváření robustních aplikací. Tento dokument pokrývá stavy, přechody a hooky dostupné během životnosti procesu.

## Životní cyklus GenServeru

GenServer prochází čtyřmi odlišnými stavy:

```
                    ┌─────────────────┐
                    │   start()       │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │  initializing   │ ← volá se init()
                    └────────┬────────┘
                             │ úspěch
                             ▼
                    ┌─────────────────┐
                    │    running      │ ← zpracování zpráv
                    └────────┬────────┘
                             │ stop() nebo pád
                             ▼
                    ┌─────────────────┐
                    │   stopping      │ ← volá se terminate()
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │    stopped      │
                    └─────────────────┘
```

### Stav: Initializing

Když se zavolá `GenServer.start()`:

1. Vygeneruje se unikátní ID
2. Zavolá se callback `init()`
3. Server čeká na dokončení inicializace

```typescript
const behavior = {
  init: async () => {
    // Toto se spouští během stavu 'initializing'
    const config = await loadConfig();
    const connection = await connectToDatabase();
    return { config, connection };
  },
  // ...
};

const ref = await GenServer.start(behavior);
// Server je nyní ve stavu 'running'
```

#### Timeout inicializace

Inicializace má konfigurovatelný timeout (výchozí: 5 sekund):

```typescript
await GenServer.start(behavior, { initTimeout: 10000 });
```

Pokud se `init()` nedokončí včas, vyhodí se `InitializationError`.

#### Selhání inicializace

Pokud `init()` vyhodí výjimku, server nikdy nevstoupí do stavu 'running':

```typescript
const behavior = {
  init: () => {
    throw new Error('Inicializace selhala');
  },
  // ...
};

try {
  await GenServer.start(behavior);
} catch (error) {
  // InitializationError s příčinou
}
```

### Stav: Running

Po inicializaci server vstoupí do stavu 'running' a začne zpracovávat zprávy:

- Zprávy jsou řazeny do fronty a zpracovávány sekvenčně
- `handleCall()` zpracovává synchronní požadavky
- `handleCast()` zpracovává asynchronní zprávy
- Stav je uchováván mezi zprávami

```typescript
// Server běží - může přijímat zprávy
await GenServer.call(ref, { type: 'get' });
GenServer.cast(ref, { type: 'update', data: 'value' });
```

#### Fronta zpráv

Zprávy jsou zpracovávány jedna po druhé, v pořadí:

```
Fronta: [call:get] → [cast:update] → [call:save]
                ↓
        Zpracuj 'get', odpověz
                ↓
        Zpracuj 'update'
                ↓
        Zpracuj 'save', odpověz
```

### Stav: Stopping

Když se zavolá `GenServer.stop()` nebo dojde k restartu pod supervizorem:

1. Status se změní na 'stopping'
2. Nové zprávy jsou odmítnuty
3. Čekající zprávy se dozpracují
4. Zavolá se callback `terminate()`

```typescript
const behavior = {
  // ...
  terminate: async (reason, state) => {
    // Úklid během stavu 'stopping'
    await state.connection.close();
    console.log(`Ukončeno: ${reason}`);
  },
};

await GenServer.stop(ref, 'normal');
```

#### Důvody ukončení

Callback `terminate()` obdrží důvod:

| Důvod | Význam |
|-------|--------|
| `'normal'` | Korektní ukončení přes `stop()` |
| `'shutdown'` | Ukončení iniciované supervizorem |
| `{ error: Error }` | Pád kvůli výjimce |

```typescript
terminate: (reason, state) => {
  if (reason === 'normal') {
    console.log('Čisté vypnutí');
  } else if (reason === 'shutdown') {
    console.log('Supervizor nás zastavil');
  } else {
    console.error('Pád:', reason.error);
  }
}
```

### Stav: Stopped

Finální stav. Server:
- Již nezpracovává zprávy
- Je odebrán z interního registru
- Nelze ho restartovat (musí se spustit nový server)

```typescript
await GenServer.stop(ref);

GenServer.isRunning(ref);  // false

try {
  await GenServer.call(ref, 'get');
} catch (error) {
  // ServerNotRunningError
}
```

## Životní cyklus Supervisoru

Supervisoři mají jednodušší životní cyklus zaměřený na správu potomků:

```
                    ┌─────────────────┐
                    │   start()       │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │    running      │ ← správa potomků
                    └────────┬────────┘
                             │ stop()
                             ▼
                    ┌─────────────────┐
                    │   stopped       │
                    └─────────────────┘
```

### Spuštění Supervisoru

Když se zavolá `Supervisor.start()`:

1. Vytvoří se instance supervisoru
2. Potomci se spustí v pořadí
3. Každý potomek je monitorován pro případ pádu

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'first', start: () => GenServer.start(behavior1) },
    { id: 'second', start: () => GenServer.start(behavior2) },
  ],
});
```

Pokud se některý potomek nepodaří spustit:
1. Již spuštění potomci jsou zastaveni (v opačném pořadí)
2. Spuštění supervisoru selže s chybou

### Běžící Supervisor

Během běhu supervisor:
- Monitoruje všechny potomky pro případ pádů
- Restartuje spadlé potomky podle strategie
- Sleduje počty restartů a intenzitu
- Umožňuje dynamickou správu potomků

### Zastavení Supervisoru

Když se zavolá `Supervisor.stop()`:

1. Potomci jsou zastaveni v opačném pořadí (poslední spuštěný = první zastavený)
2. Každý potomek dostane korektní ukončení s timeoutem
3. Supervisor je odebrán z registru

```typescript
await Supervisor.stop(supervisor);
// Všichni potomci jsou nyní zastaveni
```

## Události životního cyklu

GenServery i Supervisoři emitují události životního cyklu:

### Události GenServeru

```typescript
const unsubscribe = GenServer.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Server ${event.ref.id} spuštěn`);
      break;
    case 'crashed':
      console.log(`Server ${event.ref.id} spadl:`, event.error);
      break;
    case 'terminated':
      console.log(`Server ${event.ref.id} ukončen:`, event.reason);
      break;
  }
});

// Později: přestat naslouchat
unsubscribe();
```

### Události Supervisoru

```typescript
const unsubscribe = Supervisor.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Supervisor ${event.ref.id} spuštěn`);
      break;
    case 'restarted':
      console.log(`Potomek restartován, pokus #${event.attempt}`);
      break;
    case 'terminated':
      console.log(`Ukončeno:`, event.reason);
      break;
  }
});
```

## Korektní ukončení

### Ukončení GenServeru

Pro čisté vypnutí implementujte callback `terminate()`:

```typescript
const behavior = {
  init: () => ({
    connections: new Map(),
    buffer: [],
    timer: setInterval(flush, 1000),
  }),

  // ... handleCall, handleCast ...

  terminate: async (reason, state) => {
    // 1. Zastavit časovače
    clearInterval(state.timer);

    // 2. Vyprázdnit čekající data
    if (state.buffer.length > 0) {
      await flushToDatabase(state.buffer);
    }

    // 3. Zavřít spojení
    for (const conn of state.connections.values()) {
      await conn.close();
    }

    console.log('Úklid dokončen');
  },
};
```

### Pořadí ukončení Supervisoru

Potomci se zastavují v opačném pořadí, aby se respektovaly závislosti:

```typescript
const supervisor = await Supervisor.start({
  children: [
    { id: 'database', start: ... },   // Spuštěn 1., zastaven poslední
    { id: 'cache', start: ... },      // Spuštěn 2., zastaven 2.
    { id: 'api', start: ... },        // Spuštěn 3., zastaven první
  ],
});

await Supervisor.stop(supervisor);
// Pořadí: api → cache → database
```

### Timeout ukončení

Každý potomek má timeout pro ukončení:

```typescript
{
  id: 'slow-service',
  start: () => GenServer.start(behavior),
  shutdownTimeout: 30000,  // 30 sekund na úklid
}
```

Pokud se potomek nezastaví v rámci timeoutu, je násilně ukončen.

## Násilné ukončení

V některých případech jsou procesy násilně ukončeny:

1. **Překročen timeout ukončení** - Potomek se nezastaví korektně včas
2. **Restart supervisoru** - Když strategie vyžaduje zastavení běžících potomků
3. **Překročen maximální počet restartů** - Supervisor vzdá padající potomky

Násilné ukončení:
- Přeskočí zpracování zbývající fronty
- Odmítne všechny čekající volání s `ServerNotRunningError`
- Zavolá `terminate()` jako best-effort (chyby jsou ignorovány)

## Zdraví procesu

### Kontrola, zda běží

```typescript
// GenServer
if (GenServer.isRunning(ref)) {
  await GenServer.call(ref, msg);
}

// Supervisor
if (Supervisor.isRunning(supervisorRef)) {
  await Supervisor.startChild(supervisorRef, spec);
}
```

### Získání statistik

```typescript
import { Observer } from 'noex';

// Spustit pozorování
Observer.start({ interval: 1000 });

// Získat statistiky serveru
const stats = Observer.getServerStats(ref.id);
console.log(`Uptime: ${stats.uptimeMs}ms`);
console.log(`Zpracovaných zpráv: ${stats.messageCount}`);
console.log(`Velikost fronty: ${stats.queueSize}`);
```

## Osvědčené postupy pro životní cyklus

### 1. Udržujte init() rychlý

```typescript
// Dobře: Rychlý synchronní init
init: () => ({ data: new Map(), ready: false })

// Pak načtěte data asynchronně přes cast
// GenServer.cast(ref, 'load-data');

// Vyhněte se: Pomalý blokující init
init: async () => {
  const data = await fetchFromSlowAPI();  // Může vypršet timeout
  return { data };
}
```

### 2. Vždy implementujte terminate()

```typescript
// Dobře: Uklidit zdroje
terminate: async (reason, state) => {
  await state.db?.close();
  clearInterval(state.timer);
}

// Vyhněte se: Nechat zdroje otevřené
// (žádný terminate callback)
```

### 3. Ošetřete všechny důvody ukončení

```typescript
terminate: (reason, state) => {
  const isGraceful = reason === 'normal' || reason === 'shutdown';

  if (isGraceful) {
    // Může si vzít čas na vyprázdnění dat
    return flushData(state.buffer);
  } else {
    // Pád - pouze zalogovat, úklid může být nebezpečný
    console.error('Pád:', reason.error);
  }
}
```

### 4. Používejte události životního cyklu pro monitoring

```typescript
// Nastavit monitoring jednou při startu
GenServer.onLifecycleEvent((event) => {
  metrics.record('process_lifecycle', {
    type: event.type,
    processId: event.ref.id,
    timestamp: Date.now(),
  });
});
```

## Související

- [GenServer](./genserver.md) - Základy GenServeru
- [Supervisor](./supervisor.md) - Supervize a odolnost vůči chybám
- [Zpracování chyb](./error-handling.md) - Co se stane, když se něco pokazí
- [Ladění](../guides/debugging.md) - Nástroje pro inspekci běžících procesů
