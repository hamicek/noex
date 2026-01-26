# Konfigurace persistence

Naučili jste se, proč je persistence důležitá a jak fungují storage adaptery. Nyní prozkoumejme **kompletní konfigurační API** — všechny možnosti, které řídí kdy, jak a co se persistuje.

Persistence systém noex je vysoce konfigurovatelný. Pochopení těchto možností vám umožní naladit persistence pro váš specifický use case, od agresivního snapshotování kritických dat po minimální persistence pro cache-like stav.

## Co se naučíte

- Všechny `PersistenceConfig` možnosti a jejich účel
- Automatické snapshoty s `snapshotIntervalMs`
- Chování při obnovení s `restoreOnStart` a `maxStateAgeMs`
- Vlastní persistence klíče
- Strategie čištění
- Vlastní serializace pro komplexní stav
- Strategie ošetření chyb
- Behavior hooks pro jemné řízení
- Manuální checkpointy

## Kompletní konfigurace

Zde je kompletní interface `PersistenceConfig` se všemi dostupnými možnostmi:

```typescript
interface PersistenceConfig<State> {
  // Povinné
  adapter: StorageAdapter;

  // Časování
  snapshotIntervalMs?: number;      // Periodické snapshoty
  persistOnShutdown?: boolean;      // Uložit při graceful stop (default: true)
  restoreOnStart?: boolean;         // Načíst při startu (default: true)

  // Správa stavu
  key?: string;                     // Vlastní persistence klíč
  maxStateAgeMs?: number;           // Zahodit stav starší než toto
  cleanupOnTerminate?: boolean;     // Smazat stav při terminate
  cleanupIntervalMs?: number;       // Periodické čištění starých záznamů

  // Verzování schémat
  schemaVersion?: number;           // Aktuální verze (default: 1)
  migrate?: (oldState: unknown, oldVersion: number) => State;

  // Serializace
  serialize?: (state: State) => unknown;
  deserialize?: (data: unknown) => State;

  // Ošetření chyb
  onError?: (error: Error) => void;
}
```

Pojďme prozkoumat každou možnost detailně.

---

## Automatické snapshoty

### snapshotIntervalMs

Konfiguruje periodické automatické snapshoty. Když je nastaveno, noex ukládá stav do storage v pravidelných intervalech bez jakéhokoliv manuálního zásahu.

```typescript
const counter = await GenServer.start(counterBehavior, {
  name: 'counter',
  persistence: {
    adapter,
    snapshotIntervalMs: 30000, // Uložit každých 30 sekund
  },
});
```

**Kdy použít:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    GUIDELINES PRO INTERVAL SNAPSHOTŮ                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Interval            Use Case                       Trade-off               │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  1-5 sekund          Finanční transakce,            Vysoké I/O,             │
│                      zpracování plateb              více storage zápisů     │
│                                                                             │
│  30-60 sekund        User sessions,                 Vyvážené pro většinu    │
│                      nákupní košíky                 aplikací                │
│                                                                             │
│  5-10 minut          Cache-like data,               Nízké I/O,              │
│                      odvoditelný stav               větší riziko ztráty dat │
│                                                                             │
│  undefined/0         Pouze shutdown persistence     Minimální I/O,          │
│                      (nedoporučeno pro              pád = totální ztráta    │
│                      kritická data)                 od posledního shutdown  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Příklad — Finanční data (agresivní):**

```typescript
const paymentProcessor = await GenServer.start(paymentBehavior, {
  name: 'payments',
  persistence: {
    adapter,
    snapshotIntervalMs: 5000,      // Každých 5 sekund
    persistOnShutdown: true,
  },
});
```

**Příklad — Session cache (relaxované):**

```typescript
const sessionCache = await GenServer.start(sessionBehavior, {
  name: 'sessions',
  persistence: {
    adapter,
    snapshotIntervalMs: 300000,    // Každých 5 minut
    persistOnShutdown: true,
  },
});
```

---

## Chování při shutdown a startu

### persistOnShutdown

Řídí, zda se stav ukládá při graceful zastavení GenServeru. Defaultně `true`.

```typescript
persistence: {
  adapter,
  persistOnShutdown: true,  // Uložit stav když se zavolá GenServer.stop()
}
```

Toto se spouští během:
- `GenServer.stop(ref)` volání
- Supervisor-iniciovaných shutdownů
- Application shutdown přes signal handlery

**Nespouští se** během:
- Pádů procesu (uncaught exceptions)
- `kill -9` nebo násilného ukončení
- Out-of-memory killů

**Kdy vypnout:**

```typescript
// Pomíjivý stav, který by neměl přežít restart
const tempWorker = await GenServer.start(workerBehavior, {
  name: 'temp-worker',
  persistence: {
    adapter,
    persistOnShutdown: false,    // Neukládat při shutdown
    snapshotIntervalMs: 30000,   // Ale stále ukládat periodicky (obnova po pádu)
  },
});
```

### restoreOnStart

Řídí, zda se stav načítá ze storage při startu GenServeru. Defaultně `true`.

```typescript
persistence: {
  adapter,
  restoreOnStart: true,  // Načíst předchozí stav pokud je dostupný
}
```

Když je `restoreOnStart` `true` a persistovaný stav existuje:
1. Stav se načte ze storage
2. `init()` se **přeskočí** — použije se obnovený stav přímo
3. Zavolá se `onStateRestore` callback (pokud je definován)

Když je `restoreOnStart` `false` nebo žádný persistovaný stav neexistuje:
1. `init()` se zavolá normálně
2. Inicializuje se čerstvý stav

**Příklad — Vždy startovat čerstvě:**

```typescript
// Přepočítat stav při každém startu (možná z externího zdroje)
const aggregator = await GenServer.start(aggregatorBehavior, {
  name: 'aggregator',
  persistence: {
    adapter,
    restoreOnStart: false,       // Vždy volat init()
    persistOnShutdown: true,     // Ale ukládat pro inspekci/debugging
  },
});
```

---

## Správa stáří stavu

### maxStateAgeMs

Zahazuje persistovaný stav, který je starší než specifikovaný věk. Užitečné pro stav, který se stává neplatným časem.

```typescript
persistence: {
  adapter,
  restoreOnStart: true,
  maxStateAgeMs: 24 * 60 * 60 * 1000,  // 24 hodin
}
```

Při načítání, pokud je stav starší než `maxStateAgeMs`:
1. Stav se zahodí (považuje se za nenalezený)
2. Zavolá se `init()` pro vytvoření čerstvého stavu
3. `StaleStateError` se předá do `onError` (pokud je nakonfigurováno)

**Use cases:**

```typescript
// Session, která expiruje po 24 hodinách
const session = await GenServer.start(sessionBehavior, {
  name: `session-${userId}`,
  persistence: {
    adapter,
    maxStateAgeMs: 24 * 60 * 60 * 1000,  // 24 hodin
  },
});

// Cache, která se invaliduje po 1 hodině
const cache = await GenServer.start(cacheBehavior, {
  name: 'api-cache',
  persistence: {
    adapter,
    maxStateAgeMs: 60 * 60 * 1000,       // 1 hodina
  },
});

// Rate limiter okno, které se resetuje denně
const rateLimiter = await GenServer.start(rateLimitBehavior, {
  name: `rate-${ip}`,
  persistence: {
    adapter,
    maxStateAgeMs: 24 * 60 * 60 * 1000,  // Reset denně
  },
});
```

---

## Vlastní persistence klíče

### key

Defaultně noex používá registrované jméno GenServeru (nebo ID pokud je nepojmenovaný) jako persistence klíč. Můžete to přepsat vlastním klíčem.

```typescript
persistence: {
  adapter,
  key: 'custom-key',  // Použít toto místo jména/ID serveru
}
```

**Kdy použít vlastní klíče:**

1. **Namespacing:** Prefixování klíčů pro organizaci storage

```typescript
const userSession = await GenServer.start(sessionBehavior, {
  name: `session-${userId}`,
  persistence: {
    adapter,
    key: `sessions:user:${userId}`,  // Strukturovaný klíč
  },
});
```

2. **Migrace:** Zachování stejného klíče při přejmenování serverů

```typescript
// Starý server se jmenoval 'user-service', nové jméno je 'auth-service'
const auth = await GenServer.start(authBehavior, {
  name: 'auth-service',
  persistence: {
    adapter,
    key: 'user-service',  // Zachovat data ze starého jména
  },
});
```

3. **Sdílený stav:** Více serverů sdílí stejný persistovaný stav

```typescript
// Primární server
const primary = await GenServer.start(behavior, {
  name: 'primary',
  persistence: { adapter, key: 'shared-state' },
});

// Záložní server (na jiném nodu) používá stejný klíč
const backup = await GenServer.start(behavior, {
  name: 'backup',
  persistence: { adapter, key: 'shared-state', restoreOnStart: true },
});
```

---

## Strategie čištění

### cleanupOnTerminate

Když je `true`, maže persistovaný stav při ukončení GenServeru. Užitečné pro dočasné procesy.

```typescript
persistence: {
  adapter,
  cleanupOnTerminate: true,  // Smazat stav když se server zastaví
}
```

**Use case — Dočasná session:**

```typescript
// Když se uživatel odhlásí, smazat jeho session data
const session = await GenServer.start(sessionBehavior, {
  name: `session-${sessionId}`,
  persistence: {
    adapter,
    persistOnShutdown: false,       // Neukládat při logout
    cleanupOnTerminate: true,       // Smazat existující data
  },
});

// Při logout
await GenServer.stop(session);  // Stav je smazán
```

### cleanupIntervalMs

Periodicky odstraňuje zastaralé záznamy ze storage. Vyžaduje nastavení `maxStateAgeMs`.

```typescript
persistence: {
  adapter,
  maxStateAgeMs: 60 * 60 * 1000,       // 1 hodina
  cleanupIntervalMs: 10 * 60 * 1000,   // Zkontrolovat každých 10 minut
}
```

Toto pomáhá předcházet nabobtnání storage od osiřelých záznamů (např. sessions, které nebyly správně ukončeny).

---

## Vlastní serializace

### serialize a deserialize

Defaultně se stav serializuje jako JSON. Pro komplexní typy stavu (Date objekty, Maps, Sets, instance tříd) potřebujete vlastní serializaci.

```typescript
interface State {
  lastUpdated: Date;
  items: Map<string, number>;
}

const server = await GenServer.start(behavior, {
  name: 'complex-state',
  persistence: {
    adapter,
    serialize: (state: State) => ({
      lastUpdated: state.lastUpdated.toISOString(),
      items: Array.from(state.items.entries()),
    }),
    deserialize: (data: unknown) => {
      const raw = data as { lastUpdated: string; items: [string, number][] };
      return {
        lastUpdated: new Date(raw.lastUpdated),
        items: new Map(raw.items),
      };
    },
  },
});
```

**Běžné vzory:**

```typescript
// Date serializace
serialize: (state) => ({
  ...state,
  createdAt: state.createdAt.toISOString(),
  updatedAt: state.updatedAt.toISOString(),
}),
deserialize: (data) => {
  const raw = data as RawState;
  return {
    ...raw,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
  };
},

// Set serializace
serialize: (state) => ({
  ...state,
  tags: Array.from(state.tags),
}),
deserialize: (data) => {
  const raw = data as RawState;
  return {
    ...raw,
    tags: new Set(raw.tags),
  };
},

// BigInt serializace
serialize: (state) => ({
  ...state,
  balance: state.balance.toString(),
}),
deserialize: (data) => {
  const raw = data as RawState;
  return {
    ...raw,
    balance: BigInt(raw.balance),
  };
},
```

---

## Ošetření chyb

### onError

Callback volaný když persistence operace selžou. Nezabraňuje propagaci chyby, ale umožňuje logování, metriky nebo alerting.

```typescript
persistence: {
  adapter,
  onError: (error) => {
    console.error('Chyba persistence:', error.message);
    metrics.increment('persistence.errors');
    alerting.notify('persistence-failure', { error: error.message });
  },
}
```

**Typy chyb, které můžete obdržet:**

```typescript
import {
  StorageError,        // Obecné selhání storage operace
  StateNotFoundError,  // Žádný persistovaný stav pro klíč
  StaleStateError,     // Stav starší než maxStateAgeMs
  MigrationError,      // Migrace schématu selhala
} from '@hamicek/noex';

persistence: {
  adapter,
  onError: (error) => {
    if (error instanceof StaleStateError) {
      console.log(`Zahazuji zastaralý stav: ${error.age}ms starý`);
    } else if (error instanceof StateNotFoundError) {
      console.log(`Žádný předchozí stav pro: ${error.key}`);
    } else if (error instanceof MigrationError) {
      console.error(`Migrace selhala z v${error.fromVersion} na v${error.toVersion}`);
    } else {
      console.error('Storage chyba:', error);
    }
  },
}
```

---

## Behavior hooks

Kromě konfiguračních možností můžete definovat callbacky ve vašem GenServer behavior pro jemné řízení persistence.

### onStateRestore

Volá se po úspěšném obnovení stavu z persistence. Umožňuje transformaci, validaci nebo side effects.

```typescript
const behavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init: () => ({ count: 0, startedAt: Date.now() }),

  onStateRestore: (restoredState, metadata) => {
    console.log(`Obnoven stav z ${new Date(metadata.persistedAt)}`);

    // Aktualizovat timestamp při obnovení
    return {
      ...restoredState,
      startedAt: Date.now(),  // Čerstvý timestamp
      restoredFrom: metadata.persistedAt,
    };
  },

  handleCall: (msg, state) => { /* ... */ },
  handleCast: (msg, state) => { /* ... */ },
};
```

**Use cases:**

```typescript
// Validovat obnovený stav
onStateRestore: (state, metadata) => {
  if (!isValidState(state)) {
    throw new Error('Neplatný persistovaný stav');
  }
  return state;
},

// Sloučit s čerstvými daty
onStateRestore: async (state, metadata) => {
  const freshData = await fetchLatestConfig();
  return {
    ...state,
    config: freshData,  // Vždy použít nejnovější config
  };
},

// Logovat obnovu
onStateRestore: (state, metadata) => {
  const age = Date.now() - metadata.persistedAt;
  console.log(`Obnoven stav z před ${age}ms`);
  return state;
},
```

### beforePersist

Volá se před persistováním stavu. Umožňuje filtrování, transformaci nebo úplné přeskočení persistence.

```typescript
const behavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init: () => ({
    count: 0,
    tempData: null,      // Dočasné, nemělo by se persistovat
    lastRequest: null,   // Velký objekt, přeskočit
  }),

  beforePersist: (state) => {
    // Vrátit modifikovaný stav pro persistence
    // Nebo undefined pro přeskočení této persistence
    const { tempData, lastRequest, ...persistable } = state;
    return persistable;
  },

  handleCall: (msg, state) => { /* ... */ },
  handleCast: (msg, state) => { /* ... */ },
};
```

**Use cases:**

```typescript
// Přeskočit persistování pokud se stav významně nezměnil
beforePersist: (state) => {
  if (state.pendingChanges === 0) {
    return undefined;  // Přeskočit tento snapshot
  }
  return state;
},

// Odstranit citlivá data
beforePersist: (state) => {
  const { password, apiKey, ...safe } = state;
  return safe;
},

// Komprimovat velká pole před persistováním
beforePersist: (state) => {
  return {
    ...state,
    largeArray: state.largeArray.slice(-1000),  // Zachovat jen posledních 1000
  };
},
```

---

## Manuální checkpointy

Někdy potřebujete persistovat stav okamžitě, nečekat na další interval nebo shutdown. Použijte `GenServer.checkpoint()`.

```typescript
import { GenServer } from '@hamicek/noex';

// Po kritické operaci, vynutit okamžité uložení
async function processCriticalPayment(ref: GenServerRef, payment: Payment) {
  await GenServer.call(ref, { type: 'process', payment });

  // Nečekat na interval — uložit okamžitě
  await GenServer.checkpoint(ref);
}
```

**Kdy použít checkpointy:**

- Po kritických transakcích
- Před rizikovými operacemi
- Na hranicích business logiky
- Když uživatel explicitně ukládá

```typescript
// API endpoint, který explicitně ukládá postup uživatele
app.post('/api/save-progress', async (req, res) => {
  const session = Registry.lookup(`session-${req.userId}`);

  await GenServer.call(session, { type: 'update', data: req.body });
  await GenServer.checkpoint(session);

  res.json({ saved: true });
});
```

---

## Vše dohromady

Zde je kompletní příklad ukazující více konfiguračních možností spolupracujících:

```typescript
import {
  GenServer,
  GenServerBehavior,
  SQLiteAdapter,
  StateMetadata,
} from '@hamicek/noex';

interface OrderState {
  orderId: string;
  items: Map<string, number>;
  status: 'pending' | 'paid' | 'shipped';
  createdAt: Date;
  updatedAt: Date;
}

const adapter = new SQLiteAdapter({ filename: './data/orders.db' });

const orderBehavior: GenServerBehavior<
  OrderState,
  { type: 'addItem'; sku: string; qty: number } | { type: 'getStatus' },
  { type: 'updateStatus'; status: OrderState['status'] },
  OrderState['status'] | void
> = {
  init: () => ({
    orderId: crypto.randomUUID(),
    items: new Map(),
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
  }),

  onStateRestore: (state, metadata) => {
    console.log(`Objednávka ${state.orderId} obnovena z ${new Date(metadata.persistedAt)}`);
    return state;
  },

  beforePersist: (state) => {
    // Vždy persistovat s čerstvým updatedAt
    return {
      ...state,
      updatedAt: new Date(),
    };
  },

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'addItem': {
        const current = state.items.get(msg.sku) ?? 0;
        const newItems = new Map(state.items);
        newItems.set(msg.sku, current + msg.qty);
        return [undefined, { ...state, items: newItems }];
      }
      case 'getStatus':
        return [state.status, state];
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'updateStatus') {
      return { ...state, status: msg.status };
    }
    return state;
  },
};

const order = await GenServer.start(orderBehavior, {
  name: 'order-12345',
  persistence: {
    adapter,

    // Časování
    snapshotIntervalMs: 30000,       // Každých 30 sekund
    persistOnShutdown: true,
    restoreOnStart: true,

    // Správa stavu
    key: 'orders:12345',             // Namespaced klíč
    maxStateAgeMs: 7 * 24 * 60 * 60 * 1000,  // 7 dní

    // Verzování schémat
    schemaVersion: 2,
    migrate: (oldState, oldVersion) => {
      if (oldVersion === 1) {
        // v1 mělo items jako pole, v2 používá Map
        const old = oldState as { items: [string, number][] };
        return {
          ...oldState,
          items: new Map(old.items),
        } as OrderState;
      }
      return oldState as OrderState;
    },

    // Serializace (pro Map a Date)
    serialize: (state) => ({
      ...state,
      items: Array.from(state.items.entries()),
      createdAt: state.createdAt.toISOString(),
      updatedAt: state.updatedAt.toISOString(),
    }),
    deserialize: (data) => {
      const raw = data as {
        orderId: string;
        items: [string, number][];
        status: OrderState['status'];
        createdAt: string;
        updatedAt: string;
      };
      return {
        ...raw,
        items: new Map(raw.items),
        createdAt: new Date(raw.createdAt),
        updatedAt: new Date(raw.updatedAt),
      };
    },

    // Ošetření chyb
    onError: (error) => {
      console.error(`Chyba persistence objednávky: ${error.message}`);
    },
  },
});
```

---

## Cvičení: Konfigurovatelný Session Manager

Vytvořte session manager s následujícími požadavky:

1. Sessions expirují po 30 minutách neaktivity
2. Stav se ukládá každou minutu
3. Session data se čistí když se uživatel odhlásí
4. Citlivá pole (password hash, tokeny) jsou vyloučena z persistence
5. Obnovené sessions aktualizují svůj "lastActive" timestamp

**Výchozí bod:**

```typescript
interface SessionState {
  userId: string;
  email: string;
  passwordHash: string;        // Nepersistovat
  accessToken: string;         // Nepersistovat
  lastActive: Date;
  preferences: {
    theme: 'light' | 'dark';
    language: string;
  };
}

const sessionBehavior: GenServerBehavior<
  SessionState,
  { type: 'getPreferences' } | { type: 'touch' },
  { type: 'updatePreferences'; prefs: Partial<SessionState['preferences']> },
  SessionState['preferences'] | void
> = {
  // Implementujte init, handlery a hooks...
};
```

### Řešení

```typescript
import { GenServer, GenServerBehavior, FileAdapter, StateMetadata } from '@hamicek/noex';

interface SessionState {
  userId: string;
  email: string;
  passwordHash: string;
  accessToken: string;
  lastActive: Date;
  preferences: {
    theme: 'light' | 'dark';
    language: string;
  };
}

// Typ pro persistovaný stav (bez citlivých polí)
interface PersistedSessionState {
  userId: string;
  email: string;
  lastActive: string;  // ISO string
  preferences: SessionState['preferences'];
}

const adapter = new FileAdapter({ directory: './data/sessions' });

const sessionBehavior: GenServerBehavior<
  SessionState,
  { type: 'getPreferences' } | { type: 'touch' },
  { type: 'updatePreferences'; prefs: Partial<SessionState['preferences']> },
  SessionState['preferences'] | void
> = {
  init: () => ({
    userId: '',
    email: '',
    passwordHash: '',
    accessToken: '',
    lastActive: new Date(),
    preferences: {
      theme: 'light',
      language: 'en',
    },
  }),

  onStateRestore: (state, metadata) => {
    console.log(`Session obnovena, byla uložena před ${Date.now() - metadata.persistedAt}ms`);

    // Aktualizovat lastActive při obnovení
    return {
      ...state,
      lastActive: new Date(),
      // Citlivá pole musí být znovu naplněna po obnovení
      passwordHash: '',
      accessToken: '',
    };
  },

  beforePersist: (state) => {
    // Vyloučit citlivá pole
    const { passwordHash, accessToken, ...safe } = state;
    return safe as SessionState;
  },

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'getPreferences':
        return [state.preferences, { ...state, lastActive: new Date() }];
      case 'touch':
        return [undefined, { ...state, lastActive: new Date() }];
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'updatePreferences') {
      return {
        ...state,
        lastActive: new Date(),
        preferences: { ...state.preferences, ...msg.prefs },
      };
    }
    return state;
  },
};

async function createSession(userId: string, email: string): Promise<GenServerRef> {
  return GenServer.start(sessionBehavior, {
    name: `session-${userId}`,
    persistence: {
      adapter,

      // Session expiruje po 30 minutách
      maxStateAgeMs: 30 * 60 * 1000,

      // Ukládat každou minutu
      snapshotIntervalMs: 60 * 1000,
      persistOnShutdown: true,
      restoreOnStart: true,

      // Namespaced klíč
      key: `sessions:${userId}`,

      // Date serializace
      serialize: (state) => ({
        ...state,
        lastActive: state.lastActive.toISOString(),
      }),
      deserialize: (data) => {
        const raw = data as PersistedSessionState;
        return {
          ...raw,
          lastActive: new Date(raw.lastActive),
          passwordHash: '',  // Není v persistovaných datech
          accessToken: '',   // Není v persistovaných datech
        };
      },

      onError: (error) => {
        console.error(`Chyba persistence session: ${error.message}`);
      },
    },
  });
}

async function logoutSession(ref: GenServerRef) {
  // Zastavit s cleanup pro smazání persistovaného stavu
  await GenServer.stop(ref);
  // Poznámka: Pro skutečný cleanup byste překonfigurovali s cleanupOnTerminate: true
  // nebo manuálně zavolali adapter.delete()
}
```

---

## Shrnutí

**Klíčové poznatky:**

- **`snapshotIntervalMs`** — Automatické periodické ukládání; laďte podle kritičnosti dat
- **`persistOnShutdown`** — Ukládá při graceful stop (default: true)
- **`restoreOnStart`** — Načítá stav při startu, přeskakuje `init()` (default: true)
- **`maxStateAgeMs`** — Zahazuje zastaralý stav; esenciální pro sessions a cache
- **`key`** — Vlastní persistence klíč pro namespacing nebo migraci
- **`cleanupOnTerminate`** — Maže stav když se server zastaví
- **`serialize`/`deserialize`** — Ošetřuje komplexní typy (Date, Map, Set, atd.)
- **`onError`** — Centrální ošetření chyb pro všechny persistence operace
- **`onStateRestore`/`beforePersist`** — Behavior hooks pro jemné řízení
- **`GenServer.checkpoint()`** — Vynutit okamžité uložení když je potřeba

**Konfigurační checklist:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CHECKLIST KONFIGURACE PERSISTENCE                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  □ Zvolit vhodný snapshotIntervalMs pro kritičnost dat                     │
│  □ Nastavit maxStateAgeMs pokud by stav měl expirovat                      │
│  □ Přidat serialize/deserialize pokud stav obsahuje Date, Map, Set, BigInt │
│  □ Implementovat onError pro logování a alerting                           │
│  □ Použít beforePersist pro vyloučení citlivých nebo dočasných dat         │
│  □ Použít onStateRestore pro validaci nebo obnovení obnoveného stavu       │
│  □ Zvážit cleanupOnTerminate pro dočasné procesy                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

Další: [Verzování schémat](./04-verzovani-schemat.md)
