# API Reference - Persistence

Modul persistence poskytuje zásuvnou vrstvu pro ukládání stavu GenServeru. Umožňuje automatické ukládání a obnovu stavu při restartech procesů.

## Import

```typescript
import {
  // Adaptéry
  MemoryAdapter,
  FileAdapter,
  SQLiteAdapter,
  // Manager
  PersistenceManager,
  // Serializery
  defaultSerializer,
  createPrettySerializer,
  // Třídy chyb
  PersistenceError,
  StateNotFoundError,
  SerializationError,
  DeserializationError,
  CorruptedStateError,
  StaleStateError,
  StorageError,
  MigrationError,
  ChecksumMismatchError,
} from 'noex';
```

## Přehled

Systém persistence se skládá z:

- **Storage Adaptéry** - Zásuvné backendy pro ukládání stavu (Memory, File, SQLite)
- **PersistenceManager** - Vysokoúrovňové API pro save/load operace
- **Integrace s GenServerem** - Automatická persistence stavu přes konfiguraci

## Typy

### PersistenceConfig

Konfigurace pro povolení persistence na GenServeru.

```typescript
interface PersistenceConfig<State> {
  /** Storage adaptér pro persistenci */
  readonly adapter: StorageAdapter;

  /** Vlastní klíč persistence. Výchozí je název serveru nebo ID. */
  readonly key?: string;

  /**
   * Interval v milisekundách pro automatické snapshoty.
   * Nastavte na undefined nebo 0 pro zakázání periodických snapshotů.
   */
  readonly snapshotIntervalMs?: number;

  /**
   * Zda ukládat stav při graceful shutdown.
   * @default true
   */
  readonly persistOnShutdown?: boolean;

  /**
   * Zda obnovit stav při startu serveru.
   * @default true
   */
  readonly restoreOnStart?: boolean;

  /**
   * Maximální stáří v milisekundách pro obnovený stav.
   * Stav starší než toto bude zahozen.
   */
  readonly maxStateAgeMs?: number;

  /**
   * Zda smazat persistovaný stav při ukončení serveru.
   * Při true budou všechna persistovaná data pro tento server odstraněna při shutdown.
   * @default false
   */
  readonly cleanupOnTerminate?: boolean;

  /**
   * Interval v milisekundách pro automatický úklid zastaralých záznamů.
   * Vyžaduje nastavení maxStateAgeMs. Periodicky odstraňuje záznamy starší
   * než maxStateAgeMs ze storage.
   */
  readonly cleanupIntervalMs?: number;

  /**
   * Verze schématu pro podporu migrace.
   * @default 1
   */
  readonly schemaVersion?: number;

  /**
   * Migrační funkce pro upgrade stavu ze starších verzí schématu.
   */
  readonly migrate?: (oldState: unknown, oldVersion: number) => State;

  /** Vlastní serializační funkce. */
  readonly serialize?: (state: State) => unknown;

  /** Vlastní deserializační funkce. */
  readonly deserialize?: (data: unknown) => State;

  /** Handler pro chyby persistence. */
  readonly onError?: (error: Error) => void;
}
```

### StateMetadata

Metadata uložená společně s persistovaným stavem.

```typescript
interface StateMetadata {
  /** Unix timestamp (ms) kdy byl stav uložen */
  readonly persistedAt: number;
  /** Unikátní identifikátor instance GenServeru */
  readonly serverId: string;
  /** Volitelný registrovaný název GenServeru */
  readonly serverName?: string;
  /** Verze schématu pro podporu migrace */
  readonly schemaVersion: number;
  /** Volitelný checksum pro ověření integrity */
  readonly checksum?: string;
}
```

### PersistedState

Kontejner pro persistovaný stav s jeho metadaty.

```typescript
interface PersistedState<T> {
  readonly state: T;
  readonly metadata: StateMetadata;
}
```

### StorageAdapter

Rozhraní pro implementaci vlastních storage backendů.

```typescript
interface StorageAdapter {
  save(key: string, data: PersistedState<unknown>): Promise<void>;
  load<T>(key: string): Promise<PersistedState<T> | undefined>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  listKeys(prefix?: string): Promise<readonly string[]>;
  cleanup?(maxAgeMs: number): Promise<number>;
  close?(): Promise<void>;
}
```

---

## Storage Adaptéry

### MemoryAdapter

In-memory storage pro testování a vývoj. Data nejsou persistována přes restarty.

```typescript
import { MemoryAdapter } from 'noex';

const adapter = new MemoryAdapter();
```

**Volby:**

```typescript
interface MemoryAdapterOptions {
  /** Počáteční data pro naplnění adaptéru. */
  readonly initialData?: ReadonlyMap<string, PersistedState<unknown>>;
}
```

**Další metody:**

- `size: number` - Aktuální počet uložených záznamů
- `clear(): void` - Vymaže všechna uložená data

**Příklad:**

```typescript
const adapter = new MemoryAdapter();

// Použití v GenServeru
const ref = await GenServer.start(behavior, {
  persistence: {
    adapter,
    snapshotIntervalMs: 5000,
  },
});

// Kontrola velikosti storage
console.log(`Uložené záznamy: ${adapter.size}`);

// Vymazání pro testování
adapter.clear();
```

---

### FileAdapter

Souborová persistence s atomickými zápisy a ověřováním integrity.

```typescript
import { FileAdapter } from 'noex';

const adapter = new FileAdapter({
  directory: './data/persistence',
});
```

**Volby:**

```typescript
interface FileAdapterOptions {
  /** Cesta k adresáři, kam budou ukládány soubory se stavem. */
  readonly directory: string;

  /**
   * Přípona souborů se stavem.
   * @default '.json'
   */
  readonly extension?: string;

  /**
   * Zda formátovat JSON výstup pro čitelnost.
   * @default false
   */
  readonly prettyPrint?: boolean;

  /**
   * Zda počítat a ověřovat SHA256 checksums.
   * @default true
   */
  readonly checksums?: boolean;

  /**
   * Zda používat atomické zápisy (zápis do temp souboru, pak přejmenování).
   * @default true
   */
  readonly atomicWrites?: boolean;
}
```

**Vlastnosti:**

- Atomické zápisy přes temp soubor + přejmenování
- SHA256 checksums pro integritu dat
- Automatické vytvoření adresáře
- Bezpečné kódování názvů souborů pro klíče
- Pretty-print volba pro debugování

**Příklad:**

```typescript
const adapter = new FileAdapter({
  directory: './data/state',
  prettyPrint: true,
  checksums: true,
  atomicWrites: true,
});

const ref = await GenServer.start(counterBehavior, {
  name: 'counter',
  persistence: {
    adapter,
    key: 'counter-state', // Uloží do ./data/state/counter-state.json
    persistOnShutdown: true,
    restoreOnStart: true,
  },
});
```

---

### SQLiteAdapter

SQLite databázová persistence s podporou WAL módu. Vyžaduje `better-sqlite3` jako peer dependency.

```bash
npm install better-sqlite3
```

```typescript
import { SQLiteAdapter } from 'noex';

const adapter = new SQLiteAdapter({
  filename: './data/state.db',
});
```

**Volby:**

```typescript
interface SQLiteAdapterOptions {
  /**
   * Cesta k SQLite databázovému souboru.
   * Použijte ':memory:' pro in-memory databázi.
   */
  readonly filename: string;

  /**
   * Název tabulky pro ukládání dat stavu.
   * @default 'noex_state'
   */
  readonly tableName?: string;

  /**
   * Zda povolit WAL (Write-Ahead Logging) mód.
   * @default true
   */
  readonly walMode?: boolean;
}
```

**Vlastnosti:**

- WAL mód pro lepší konkurenci
- Líná inicializace (databáze vytvořena při první operaci)
- Připravené příkazy pro výkon
- Podpora in-memory databáze

**Příklad:**

```typescript
const adapter = new SQLiteAdapter({
  filename: './data/app.db',
  tableName: 'genserver_state',
  walMode: true,
});

const ref = await GenServer.start(behavior, {
  name: 'service',
  persistence: {
    adapter,
    snapshotIntervalMs: 30000,
  },
});

// Zavření adaptéru po dokončení
await adapter.close();
```

---

## Integrace s GenServerem

### Základní konfigurace

Povolte persistenci poskytnutím `persistence` volby při spouštění GenServeru:

```typescript
import { GenServer, FileAdapter } from 'noex';

const adapter = new FileAdapter({ directory: './data' });

const ref = await GenServer.start(counterBehavior, {
  name: 'counter',
  persistence: {
    adapter,
    restoreOnStart: true,
    persistOnShutdown: true,
  },
});
```

### Periodické snapshoty

Automatické ukládání stavu v pravidelných intervalech:

```typescript
const ref = await GenServer.start(behavior, {
  persistence: {
    adapter,
    snapshotIntervalMs: 60000, // Uložení každou minutu
  },
});
```

### Ruční checkpointy

Uložení stavu na vyžádání pomocí `GenServer.checkpoint()`:

```typescript
// Okamžité uložení
await GenServer.checkpoint(ref);

// S vlastními volbami
await GenServer.checkpoint(ref, { force: true });
```

### Získání metadat posledního checkpointu

```typescript
const metadata = await GenServer.getLastCheckpointMeta(ref);
if (metadata) {
  console.log(`Naposledy uloženo: ${new Date(metadata.persistedAt)}`);
  console.log(`Verze schématu: ${metadata.schemaVersion}`);
}
```

### Vymazání persistovaného stavu

```typescript
await GenServer.clearPersistedState(ref);
```

---

## Úklid stavu

Systém persistence poskytuje automatické funkce úklidu pro správu úložiště v čase.

### Úklid při ukončení

Smazání persistovaného stavu při vypnutí serveru:

```typescript
const ref = await GenServer.start(behavior, {
  persistence: {
    adapter,
    cleanupOnTerminate: true, // Smazat stav při shutdown
  },
});

// Když se tento server zastaví, jeho persistovaný stav bude odstraněn
await GenServer.stop(ref);
```

Toto je užitečné pro:
- Dočasné servery s efemérním stavem
- Testovací prostředí kde stav nemá přetrvávat
- Servery které kompletně obnoví stav při restartu

### Periodický úklid

Automatické odstraňování zastaralých záznamů ze storage v pravidelných intervalech:

```typescript
const ref = await GenServer.start(behavior, {
  persistence: {
    adapter,
    maxStateAgeMs: 24 * 60 * 60 * 1000, // 24 hodin
    cleanupIntervalMs: 60 * 60 * 1000,   // Spustit úklid každou hodinu
  },
});
```

Periodický úklid vyžaduje nastavení `maxStateAgeMs`. Záznamy starší než `maxStateAgeMs` budou odstraněny během každého cyklu úklidu.

### Metody PersistenceManageru

`PersistenceManager` vystavuje cleanup metody přímo:

```typescript
const manager = new PersistenceManager({
  adapter,
  key: 'my-server',
  maxStateAgeMs: 86400000, // 24 hodin
});

// Ruční spuštění úklidu zastaralých záznamů
const removedCount = await manager.cleanup();
console.log(`Odstraněno ${removedCount} zastaralých záznamů`);

// Úklid s vlastním prahem stáří
const count = await manager.cleanup(3600000); // Odstranit záznamy starší než 1 hodina

// Zavření adaptéru po dokončení (uvolní spojení/file handles)
await manager.close();
```

---

## Hooky behavioru

GenServer behaviory mohou implementovat hooky pro přizpůsobení persistence:

### onStateRestore

Voláno při obnově stavu z persistence. Použijte pro transformaci nebo validaci obnoveného stavu.

```typescript
const behavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init: () => ({ count: 0 }),

  onStateRestore(restoredState, metadata) {
    console.log(`Obnova stavu z ${new Date(metadata.persistedAt)}`);
    // Vrátí transformovaný stav nebo originál
    return {
      ...restoredState,
      restoredAt: Date.now(),
    };
  },

  // ... další handlery
};
```

### beforePersist

Voláno před uložením stavu. Vraťte `undefined` pro přeskočení persistence.

```typescript
const behavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init: () => ({ data: [], dirty: false }),

  beforePersist(state) {
    // Persistovat pouze pokud je dirty
    if (!state.dirty) {
      return undefined; // Přeskočit uložení
    }
    // Odstranit přechodná pole před uložením
    const { dirty, ...persistable } = state;
    return persistable;
  },

  // ... další handlery
};
```

---

## Migrace schématu

Zpracování změn schématu stavu mezi verzemi:

```typescript
interface StateV1 {
  count: number;
}

interface StateV2 {
  count: number;
  lastUpdated: number;
}

const ref = await GenServer.start(behavior, {
  persistence: {
    adapter,
    schemaVersion: 2,
    migrate: (oldState, oldVersion) => {
      if (oldVersion === 1) {
        const v1 = oldState as StateV1;
        return {
          count: v1.count,
          lastUpdated: Date.now(),
        };
      }
      return oldState as StateV2;
    },
  },
});
```

---

## Lifecycle události

Systém persistence emituje lifecycle události:

```typescript
const ref = await GenServer.start(behavior, {
  persistence: { adapter },
});

// Poslouchání persistence událostí
GenServer.subscribe(ref, (event) => {
  switch (event.type) {
    case 'state_restored':
      console.log('Stav obnoven z persistence');
      break;
    case 'state_persisted':
      console.log('Stav uložen do persistence');
      break;
    case 'persistence_error':
      console.error('Persistence selhala:', event.error);
      break;
  }
});
```

---

## Třídy chyb

### PersistenceError

Základní třída pro chyby související s persistencí.

```typescript
class PersistenceError extends Error {
  readonly cause?: Error;
}
```

### StateNotFoundError

Vyhozeno při pokusu o načtení stavu, který neexistuje.

```typescript
class StateNotFoundError extends Error {
  readonly key: string;
}
```

### SerializationError

Vyhozeno při selhání serializace stavu.

```typescript
class SerializationError extends Error {
  readonly cause?: Error;
}
```

### DeserializationError

Vyhozeno při selhání deserializace stavu.

```typescript
class DeserializationError extends Error {
  readonly cause?: Error;
}
```

### CorruptedStateError

Vyhozeno když persistovaný stav nesplní kontroly integrity.

```typescript
class CorruptedStateError extends Error {
  readonly key: string;
}
```

### StaleStateError

Vyhozeno když persistovaný stav překročí maximální stáří.

```typescript
class StaleStateError extends Error {
  readonly key: string;
  readonly ageMs: number;
  readonly maxAgeMs: number;
}
```

### StorageError

Vyhozeno při selhání storage operace.

```typescript
class StorageError extends Error {
  readonly operation: 'save' | 'load' | 'delete' | 'exists' | 'listKeys' | 'cleanup' | 'close';
  readonly cause?: Error;
}
```

### MigrationError

Vyhozeno při selhání migrace stavu.

```typescript
class MigrationError extends Error {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly cause?: Error;
}
```

### ChecksumMismatchError

Vyhozeno při selhání ověření checksumu.

```typescript
class ChecksumMismatchError extends Error {
  readonly key: string;
  readonly expected: string;
  readonly actual: string;
}
```

---

## Kompletní příklad

```typescript
import { GenServer, FileAdapter, type GenServerBehavior } from 'noex';

interface CounterState {
  count: number;
  lastModified: number;
}

type CounterCall = { type: 'get' } | { type: 'increment'; amount: number };
type CounterCast = { type: 'reset' };
type CounterReply = number;

const counterBehavior: GenServerBehavior<CounterState, CounterCall, CounterCast, CounterReply> = {
  init: () => ({ count: 0, lastModified: Date.now() }),

  onStateRestore(state, metadata) {
    console.log(`Obnoven stav z ${new Date(metadata.persistedAt)}`);
    return state;
  },

  beforePersist(state) {
    // Vždy persistovat
    return state;
  },

  handleCall(state, message) {
    switch (message.type) {
      case 'get':
        return { reply: state.count };
      case 'increment':
        return {
          newState: {
            count: state.count + message.amount,
            lastModified: Date.now(),
          },
          reply: state.count + message.amount,
        };
    }
  },

  handleCast(state, message) {
    switch (message.type) {
      case 'reset':
        return { newState: { count: 0, lastModified: Date.now() } };
    }
  },
};

async function main() {
  const adapter = new FileAdapter({
    directory: './data/counters',
    prettyPrint: true,
  });

  const counter = await GenServer.start(counterBehavior, {
    name: 'main-counter',
    persistence: {
      adapter,
      key: 'main-counter',
      snapshotIntervalMs: 30000, // Uložení každých 30 sekund
      persistOnShutdown: true,
      restoreOnStart: true,
      maxStateAgeMs: 24 * 60 * 60 * 1000, // Zahození stavu staršího než 24 hodin
      cleanupIntervalMs: 60 * 60 * 1000,   // Úklid zastaralých záznamů každou hodinu
      cleanupOnTerminate: false,           // Zachovat stav po shutdown (default)
      schemaVersion: 1,
      onError: (err) => console.error('Chyba persistence:', err),
    },
  });

  // Použití counteru
  await GenServer.call(counter, { type: 'increment', amount: 5 });
  const value = await GenServer.call(counter, { type: 'get' });
  console.log(`Hodnota counteru: ${value}`);

  // Ruční checkpoint
  await GenServer.checkpoint(counter);

  // Kontrola metadat
  const meta = await GenServer.getLastCheckpointMeta(counter);
  console.log(`Poslední checkpoint: ${meta?.persistedAt}`);

  // Graceful shutdown (auto-uložení stavu)
  await GenServer.stop(counter);

  // Úklid adaptéru
  await adapter.close();
}
```

---

## Související

- [GenServer API](./genserver.md) - Dokumentace GenServeru
- [Types](./types.md) - Definice typů
- [Errors](./errors.md) - Třídy chyb
