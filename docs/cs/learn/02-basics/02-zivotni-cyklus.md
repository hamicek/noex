# Životní cyklus procesu

Každý GenServer prochází dobře definovaným životním cyklem od zrození po zánik. Pochopení tohoto životního cyklu je zásadní pro budování robustních aplikací, které elegantně zpracovávají selhání a správně uvolňují prostředky.

V této kapitole se naučíte o stavech, kterými GenServer prochází, jak provádět úklid při ukončení procesu a vzory pro graceful shutdown.

## Co se naučíte

- Čtyři stavy, kterými GenServer prochází
- Jak používat callback `terminate()` pro úklid
- Rozdíl mezi graceful a nuceným ukončením
- Zpracování různých důvodů ukončení
- Vzory pro uvolňování prostředků

## Stavy životního cyklu

GenServer prochází čtyřmi odlišnými stavy během svého života:

```
┌──────────────┐      ┌─────────┐      ┌──────────┐      ┌─────────┐
│ initializing │ ──── │ running │ ──── │ stopping │ ──── │ stopped │
└──────────────┘      └─────────┘      └──────────┘      └─────────┘
       │                   │                 │
   init() běží         Zpracovávají     terminate()
   Stav vytvořen       se zprávy        běží
```

### initializing

Když zavoláte `GenServer.start()`, server vstoupí do stavu `initializing`. Během této fáze:

- Vykoná se callback `init()`
- Vytvoří se počáteční stav
- Pokud `init()` vyhodí chybu nebo vyprší timeout, server se nespustí
- Ještě nelze zpracovávat zprávy

```typescript
const ref = await GenServer.start({
  init() {
    console.log('Server se inicializuje...');
    return { count: 0 }; // Počáteční stav
  },
  // ...
});
// V tomto bodě je inicializace dokončena a server běží
```

### running

Jakmile `init()` úspěšně dokončí, server přejde do stavu `running`. V tomto stavu:

- Zpracovávají se zprávy z fronty
- Vykonávají se callbacky `handleCall()` a `handleCast()`
- Server odpovídá na všechny požadavky

Zde server tráví většinu svého života.

### stopping

Když se zavolá `GenServer.stop()`, server vstoupí do stavu `stopping`:

- Nové zprávy jsou odmítnuty s `ServerNotRunningError`
- Vykoná se callback `terminate()` (pokud je definován)
- Běží úklidové operace

### stopped

Finální stav. Server:

- Je odebrán z registru
- Nemůže zpracovávat žádné další zprávy
- Uvolnil všechny prostředky

## Callback terminate()

Callback `terminate()` je vaše příležitost provést úklid když proces končí. Přijímá důvod ukončení a finální stav.

```typescript
import { GenServer, type GenServerBehavior, type TerminateReason } from '@hamicek/noex';

interface ConnectionState {
  socket: WebSocket | null;
  reconnectAttempts: number;
}

const connectionBehavior: GenServerBehavior<
  ConnectionState,
  { type: 'send'; data: string },
  { type: 'reconnect' },
  boolean
> = {
  init() {
    const socket = new WebSocket('wss://api.example.com');
    return { socket, reconnectAttempts: 0 };
  },

  handleCall(msg, state) {
    if (msg.type === 'send' && state.socket) {
      state.socket.send(msg.data);
      return [true, state];
    }
    return [false, state];
  },

  handleCast(msg, state) {
    return state;
  },

  // Úklid když server končí
  terminate(reason: TerminateReason, state: ConnectionState) {
    console.log('Server se ukončuje:', reason);

    // Zavření WebSocket spojení
    if (state.socket) {
      state.socket.close(1000, 'Server se vypíná');
    }

    console.log('Úklid dokončen');
  },
};
```

### Asynchronní úklid

Callback `terminate()` může být asynchronní, což vám umožní čekat na dokončení úklidových operací:

```typescript
terminate: async (reason, state) => {
  // Počkejte na dokončení probíhajících operací
  await state.pendingWrite;

  // Vyprázdněte buffery
  await state.fileHandle.flush();

  // Zavřete file handle
  await state.fileHandle.close();

  console.log('Soubor bezpečně zavřen');
},
```

### Důvody ukončení

Parametr `reason` vám říká, proč se server zastavuje:

```typescript
type TerminateReason =
  | 'normal'              // Normální, očekávané ukončení
  | 'shutdown'            // Celkové vypnutí systému
  | { error: Error };     // Abnormální ukončení kvůli chybě
```

Zpracujte různé důvody odpovídajícím způsobem:

```typescript
terminate(reason, state) {
  if (reason === 'normal') {
    console.log('Požadováno čisté ukončení');
  } else if (reason === 'shutdown') {
    console.log('Systém se vypíná');
  } else {
    console.error('Ukončeno kvůli chybě:', reason.error.message);
    // Možná zalogovat do error tracking služby
  }

  // Úklidový kód běží pro všechny důvody
  state.connection?.close();
},
```

## Graceful vs nucené ukončení

noex poskytuje dva způsoby zastavení GenServeru:

### Graceful shutdown

`GenServer.stop()` provádí graceful shutdown:

```typescript
// Normální ukončení
await GenServer.stop(ref);

// Ukončení se specifickým důvodem
await GenServer.stop(ref, 'shutdown');

// Ukončení kvůli chybě
await GenServer.stop(ref, { error: new Error('Neplatná konfigurace') });
```

Během graceful shutdown:

1. Server přestane přijímat nové zprávy
2. Aktuálně zpracovávaná zpráva se dokončí
3. Běží callback `terminate()`
4. Server je odebrán z registru

### Nucené ukončení

Supervisory používají nucené ukončení (`_forceTerminate`) když potřebují okamžitě zastavit proces:

- Čekající zprávy ve frontě jsou odmítnuty s `ServerNotRunningError`
- Callback `terminate()` stále běží (best-effort, chyby jsou ignorovány)
- Používá se když supervisor potřebuje restartovat selhávající child

Typicky nevoláte `_forceTerminate` přímo - nechte supervisory, aby to řešily.

## Lifecycle events

Můžete pozorovat lifecycle events pro monitoring a debugging:

```typescript
const unsubscribe = GenServer.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Server ${event.ref.id} spuštěn`);
      break;
    case 'terminated':
      console.log(`Server ${event.ref.id} ukončen:`, event.reason);
      break;
    case 'crashed':
      console.error(`Server ${event.ref.id} spadl:`, event.error);
      break;
  }
});

// Později, ukončit poslouchání
unsubscribe();
```

Toto je užitečné pro:

- Logování a monitoring
- Sběr metrik
- Debugging problémů se startem/ukončením

## Kompletní příklad

Zde je kompletní příklad demonstrující správu životního cyklu:

```typescript
// lifecycle-demo.ts
import { GenServer, type GenServerBehavior, type TerminateReason } from '@hamicek/noex';

interface DatabaseState {
  connections: number;
  queries: string[];
}

type CallMsg =
  | { type: 'query'; sql: string }
  | { type: 'getStats' };

type CastMsg = { type: 'log' };

type Reply = string[] | { connections: number; totalQueries: number };

const databaseBehavior: GenServerBehavior<DatabaseState, CallMsg, CastMsg, Reply> = {
  // 1. INICIALIZACE
  init() {
    console.log('[init] Připojování k databázi...');
    // Simulace nastavení připojení
    return {
      connections: 5, // Connection pool
      queries: [],
    };
  },

  // 2. ZPRACOVÁNÍ ZPRÁV (stav running)
  handleCall(msg, state) {
    switch (msg.type) {
      case 'query': {
        console.log(`[handleCall] Vykonávám: ${msg.sql}`);
        const newState = {
          ...state,
          queries: [...state.queries, msg.sql],
        };
        return [[msg.sql], newState]; // Vrátí "výsledky"
      }
      case 'getStats':
        return [
          { connections: state.connections, totalQueries: state.queries.length },
          state,
        ];
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'log') {
      console.log(`[handleCast] Celkem provedených dotazů: ${state.queries.length}`);
    }
    return state;
  },

  // 3. ÚKLID (stav stopping)
  terminate(reason: TerminateReason, state: DatabaseState) {
    console.log('[terminate] Ukončování databázového připojení...');
    console.log(`[terminate] Důvod: ${formatReason(reason)}`);
    console.log(`[terminate] Provedeno ${state.queries.length} dotazů během života`);

    // Zavření všech připojení v poolu
    for (let i = 0; i < state.connections; i++) {
      console.log(`[terminate] Zavírám připojení ${i + 1}/${state.connections}`);
    }

    console.log('[terminate] Všechna připojení zavřena');
  },
};

function formatReason(reason: TerminateReason): string {
  if (reason === 'normal') return 'normální ukončení';
  if (reason === 'shutdown') return 'systémové ukončení';
  return `chyba: ${reason.error.message}`;
}

async function main() {
  // Registrace lifecycle observeru
  GenServer.onLifecycleEvent((event) => {
    console.log(`[lifecycle] ${event.type.toUpperCase()}`);
  });

  console.log('=== Spouštění serveru ===');
  const db = await GenServer.start(databaseBehavior);

  console.log('\n=== Provádění dotazů ===');
  await GenServer.call(db, { type: 'query', sql: 'SELECT * FROM users' });
  await GenServer.call(db, { type: 'query', sql: 'SELECT * FROM orders' });
  GenServer.cast(db, { type: 'log' });

  // Počkejte na zpracování castu
  await new Promise((r) => setTimeout(r, 10));

  const stats = await GenServer.call(db, { type: 'getStats' });
  console.log('\n=== Statistiky ===');
  console.log(stats);

  console.log('\n=== Zastavování serveru ===');
  await GenServer.stop(db, 'shutdown');

  console.log('\n=== Server zastaven ===');
}

main().catch(console.error);
```

Spusťte pomocí:

```bash
npx tsx lifecycle-demo.ts
```

Očekávaný výstup:

```
=== Spouštění serveru ===
[init] Připojování k databázi...
[lifecycle] STARTED

=== Provádění dotazů ===
[handleCall] Vykonávám: SELECT * FROM users
[handleCall] Vykonávám: SELECT * FROM orders
[handleCast] Celkem provedených dotazů: 2

=== Statistiky ===
{ connections: 5, totalQueries: 2 }

=== Zastavování serveru ===
[terminate] Ukončování databázového připojení...
[terminate] Důvod: systémové ukončení
[terminate] Provedeno 2 dotazů během života
[terminate] Zavírám připojení 1/5
[terminate] Zavírám připojení 2/5
[terminate] Zavírám připojení 3/5
[terminate] Zavírám připojení 4/5
[terminate] Zavírám připojení 5/5
[terminate] Všechna připojení zavřena
[lifecycle] TERMINATED

=== Server zastaven ===
```

## Best practices

### 1. Vždy uvolněte externí prostředky

Pokud váš GenServer drží spojení, file handles nebo jiné externí prostředky, vždy je uvolněte v `terminate()`:

```typescript
terminate(reason, state) {
  state.dbConnection?.end();
  state.redisClient?.quit();
  state.fileStream?.close();
},
```

### 2. Udržujte terminate() rychlý

Vyhněte se dlouhotrvajícím operacím v `terminate()`. Pokud potřebujete persistovat stav, použijte funkce persistence (popsané v pozdější kapitole) místo ukládání v `terminate()`.

### 3. Zpracujte chyby úklidu elegantně

Obalte úklidové operace do try-catch, abyste zajistili uvolnění všech prostředků:

```typescript
terminate(reason, state) {
  try {
    state.primaryDb?.close();
  } catch (e) {
    console.error('Nepodařilo se zavřít primární DB:', e);
  }

  try {
    state.replicaDb?.close();
  } catch (e) {
    console.error('Nepodařilo se zavřít replika DB:', e);
  }
},
```

### 4. Nezačínejte nové operace v terminate()

Callback `terminate()` je pouze pro úklid. Nezačínejte novou práci ani neposílejte zprávy jiným procesům odtud.

## Cvičení

Vytvořte **LoggerServer**, který:

1. Otevře "log soubor" při startu (simulujte pomocí pole)
2. Má cast `write(message)`, který přidává zprávy do logu
3. Má call `flush()`, který vrátí všechny zprávy a vymaže buffer
4. Při ukončení vypíše všechny nezapsané zprávy s prefixem "[UNFLUSHED]"

Otestujte to zapsáním nějakých zpráv, jedním flushem, zapsáním dalších a pak zastavením bez flushe.

**Nápovědy:**
- Stav by měl mít `{ buffer: string[], flushed: string[] }`
- Použijte `terminate()` pro zpracování nezapsaných zpráv

<details>
<summary>Řešení</summary>

```typescript
import { GenServer, type GenServerBehavior, type TerminateReason } from '@hamicek/noex';

interface LoggerState {
  buffer: string[];
  totalFlushed: number;
}

type LoggerCallMsg = { type: 'flush' };
type LoggerCastMsg = { type: 'write'; message: string };
type LoggerReply = string[];

const loggerBehavior: GenServerBehavior<
  LoggerState,
  LoggerCallMsg,
  LoggerCastMsg,
  LoggerReply
> = {
  init() {
    console.log('[Logger] Inicializován');
    return { buffer: [], totalFlushed: 0 };
  },

  handleCall(msg, state) {
    if (msg.type === 'flush') {
      const messages = [...state.buffer];
      console.log(`[Logger] Flushování ${messages.length} zpráv`);
      return [
        messages,
        { buffer: [], totalFlushed: state.totalFlushed + messages.length },
      ];
    }
    return [[], state];
  },

  handleCast(msg, state) {
    if (msg.type === 'write') {
      return {
        ...state,
        buffer: [...state.buffer, msg.message],
      };
    }
    return state;
  },

  terminate(reason: TerminateReason, state: LoggerState) {
    console.log(`[Logger] Ukončování (důvod: ${formatReason(reason)})`);
    console.log(`[Logger] Celkem flushováno během života: ${state.totalFlushed}`);

    if (state.buffer.length > 0) {
      console.log(`[Logger] ${state.buffer.length} nezapsaných zpráv:`);
      for (const msg of state.buffer) {
        console.log(`[UNFLUSHED] ${msg}`);
      }
    } else {
      console.log('[Logger] Všechny zprávy byly zapsány');
    }
  },
};

function formatReason(reason: TerminateReason): string {
  if (reason === 'normal') return 'normální';
  if (reason === 'shutdown') return 'shutdown';
  return `chyba: ${reason.error.message}`;
}

async function main() {
  const logger = await GenServer.start(loggerBehavior);

  // Zapište nějaké zprávy
  GenServer.cast(logger, { type: 'write', message: 'První záznam' });
  GenServer.cast(logger, { type: 'write', message: 'Druhý záznam' });

  // Počkejte na zpracování castů
  await new Promise((r) => setTimeout(r, 10));

  // Flush
  const flushed = await GenServer.call(logger, { type: 'flush' });
  console.log('Zapsané zprávy:', flushed);

  // Zapište další bez flushe
  GenServer.cast(logger, { type: 'write', message: 'Třetí záznam' });
  GenServer.cast(logger, { type: 'write', message: 'Čtvrtý záznam' });

  await new Promise((r) => setTimeout(r, 10));

  // Zastavení bez flushe - terminate() ukáže nezapsané zprávy
  console.log('\n--- Zastavování loggeru ---');
  await GenServer.stop(logger);
}

main();
```

Očekávaný výstup:

```
[Logger] Inicializován
Zapsané zprávy: [ 'První záznam', 'Druhý záznam' ]

--- Zastavování loggeru ---
[Logger] Ukončování (důvod: normální)
[Logger] Celkem flushováno během života: 2
[Logger] 2 nezapsaných zpráv:
[UNFLUSHED] Třetí záznam
[UNFLUSHED] Čtvrtý záznam
```

</details>

## Shrnutí

- GenServery procházejí čtyřmi stavy: **initializing** → **running** → **stopping** → **stopped**
- Callback **`terminate()`** je vaše šance na úklid prostředků když proces končí
- **Důvody ukončení** vám říkají proč se proces zastavuje: `'normal'`, `'shutdown'`, nebo `{ error: Error }`
- **Graceful shutdown** (`GenServer.stop()`) umožní dokončit aktuální zprávu a spustí úklid
- **Lifecycle events** vám umožní pozorovat kdy servery startují a končí
- Vždy uvolněte externí prostředky (spojení, file handles) v `terminate()`

Správa životního cyklu v noex následuje vzory Erlang/OTP, zajišťující předvídatelné chování i za podmínek selhání. V kombinaci se supervizí (popsáno v Části 3) získáte robustní procesy, které správně uvolňují prostředky a mohou být automaticky restartovány.

---

Další: [Call vs Cast](./03-call-vs-cast.md)
