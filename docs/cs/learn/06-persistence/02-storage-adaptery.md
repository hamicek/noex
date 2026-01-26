# Storage adaptery

V předchozí kapitole jste se naučili, proč je persistence důležitá a jak noex přemosťuje mezeru mezi pomíjivými procesy a dlouhožijícími daty. Nyní prozkoumejme **storage adaptery** — pluggable backendy, které skutečně ukládají váš stav.

noex poskytuje tři vestavěné adaptery, každý navržený pro různé scénáře. Pochopení, kdy který použít, je klíčem k budování robustních aplikací.

## Co se naučíte

- Interface `StorageAdapter` a jak adaptery fungují
- `MemoryAdapter` pro testování a vývoj
- `FileAdapter` pro jednoduchou souborovou persistence
- `SQLiteAdapter` pro produkční persistence
- Jak vybrat správný adapter pro váš use case
- Jak implementovat vlastní adapter

## Interface StorageAdapter

Všechny storage adaptery implementují stejný interface, což je činí vzájemně zaměnitelnými:

```typescript
interface StorageAdapter {
  // Základní operace
  save(key: PersistenceKey, data: PersistedState<unknown>): Promise<void>;
  load<T>(key: PersistenceKey): Promise<PersistedState<T> | undefined>;
  delete(key: PersistenceKey): Promise<boolean>;
  exists(key: PersistenceKey): Promise<boolean>;
  listKeys(prefix?: string): Promise<readonly PersistenceKey[]>;

  // Volitelné operace
  cleanup?(maxAgeMs: number): Promise<number>;
  close?(): Promise<void>;
}
```

Tento uniformní interface znamená, že můžete:

1. **Vyvíjet s MemoryAdapter** — rychlé, žádný setup
2. **Testovat s MemoryAdapter** — izolované, opakovatelné testy
3. **Nasadit s FileAdapter nebo SQLiteAdapter** — stačí změnit adapter, stejný kód

```typescript
// Vývoj
const adapter = new MemoryAdapter();

// Produkce
const adapter = new SQLiteAdapter({ filename: './data/state.db' });

// Stejný GenServer kód funguje s oběma
const counter = await GenServer.start(counterBehavior, {
  persistence: { adapter, restoreOnStart: true },
});
```

---

## MemoryAdapter

Nejjednodušší adapter — ukládá vše do JavaScript `Map`. Data existují jen po dobu existence instance adapteru.

### Kdy použít

- **Unit testy** — rychlé, izolované, žádný cleanup
- **Vývoj** — rychlá iterace bez souborového nepořádku
- **Dočasné procesy** — když potřebujete persistence sémantiku, ale ne trvanlivost

### Základní použití

```typescript
import { MemoryAdapter, GenServer } from '@hamicek/noex';

const adapter = new MemoryAdapter();

const counter = await GenServer.start(counterBehavior, {
  name: 'test-counter',
  persistence: {
    adapter,
    restoreOnStart: true,
    persistOnShutdown: true,
  },
});
```

### Vlastnosti

```typescript
const adapter = new MemoryAdapter();

// Zkontroluj kolik záznamů je uloženo
console.log(adapter.size); // 0

// Předvyplň pro testování
const prepopulated = new MemoryAdapter({
  initialData: new Map([
    ['counter-1', {
      state: { count: 100 },
      metadata: {
        persistedAt: Date.now(),
        serverId: 'test',
        schemaVersion: 1,
      },
    }],
  ]),
});

// Vymaž všechna data (užitečné mezi testy)
adapter.clear();
```

### Příklad testování

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryAdapter, GenServer } from '@hamicek/noex';

describe('Counter persistence', () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    // Čerstvý adapter pro každý test — kompletní izolace
    adapter = new MemoryAdapter();
  });

  it('obnoví stav po restartu', async () => {
    // Start counter a inkrementuj
    const counter1 = await GenServer.start(counterBehavior, {
      name: 'counter',
      persistence: { adapter, persistOnShutdown: true },
    });

    await GenServer.cast(counter1, 'increment');
    await GenServer.cast(counter1, 'increment');
    await GenServer.stop(counter1);

    // Start nového counteru se stejným jménem — měl by obnovit
    const counter2 = await GenServer.start(counterBehavior, {
      name: 'counter',
      persistence: { adapter, restoreOnStart: true },
    });

    const count = await GenServer.call(counter2, 'get');
    expect(count).toBe(2);

    await GenServer.stop(counter2);
  });
});
```

### Charakteristiky

| Aspekt | MemoryAdapter |
|--------|---------------|
| **Trvanlivost** | Žádná — ztraceno při ukončení procesu |
| **Výkon** | Nejrychlejší — čisté paměťové operace |
| **Setup** | Nulový — žádná konfigurace potřeba |
| **Souběžnost** | Pouze jeden proces |
| **Use case** | Testování, vývoj |

---

## FileAdapter

Persistuje stav jako JSON soubory v adresáři. Každý GenServer dostane vlastní soubor.

### Kdy použít

- **Jednoduché aplikace** — jeden server, nízká komplexita
- **Prototypování** — snadná inspekce a debugging (čitelný JSON)
- **Malý stav** — soubory fungují dobře pro stav pod ~10MB
- **Jedna instance** — žádný souběžný přístup z více procesů

### Základní použití

```typescript
import { FileAdapter, GenServer } from '@hamicek/noex';

const adapter = new FileAdapter({
  directory: './data/persistence',
});

const counter = await GenServer.start(counterBehavior, {
  name: 'my-counter',
  persistence: {
    adapter,
    restoreOnStart: true,
    persistOnShutdown: true,
  },
});

// Vytvoří soubor: ./data/persistence/my-counter.json
```

### Konfigurační možnosti

```typescript
const adapter = new FileAdapter({
  // Povinné: kam ukládat soubory
  directory: './data/persistence',

  // Volitelné: přípona souboru (default: '.json')
  extension: '.json',

  // Volitelné: čitelný JSON (default: false)
  prettyPrint: true,

  // Volitelné: ověření integrity dat pomocí SHA256 (default: true)
  checksums: true,

  // Volitelné: atomické zápisy přes temp soubor + rename (default: true)
  atomicWrites: true,
});
```

### Struktura souboru

S `prettyPrint: true` soubory vypadají takto:

```json
{
  "state": {
    "count": 42,
    "lastUpdated": "2024-01-15T10:30:00.000Z"
  },
  "metadata": {
    "persistedAt": 1705312200000,
    "serverId": "gs_abc123",
    "serverName": "my-counter",
    "schemaVersion": 1
  },
  "checksum": "a3f2b8c9d4e5f6..."
}
```

### Bezpečnostní funkce

**Atomické zápisy**

FileAdapter používá vzor zápis-do-temp-pak-přejmenování pro prevenci korupce:

```
1. Zapiš stav do: my-counter.json.{uuid}.tmp
2. Přejmenuj atomicky: my-counter.json.{uuid}.tmp → my-counter.json
```

Pokud proces spadne během zápisu, temp soubor zůstane a originální soubor zůstává netknutý.

**Checksums**

SHA256 checksums detekují korupci:

```typescript
// Při ukládání: vypočítej checksum serializovaného stavu
const checksum = sha256(JSON.stringify(state));

// Při načítání: ověř že checksum odpovídá
if (computedChecksum !== storedChecksum) {
  throw new ChecksumMismatchError(key, stored, computed);
}
```

### Příklad: Debug-friendly setup

```typescript
const adapter = new FileAdapter({
  directory: './data/state',
  prettyPrint: true,  // Snadné čtení s cat/less
  checksums: true,    // Detekce korupce
  atomicWrites: true, // Bezpečnost při pádu
});

// Po spuštění, inspekce stavu:
// $ cat ./data/state/my-counter.json | jq .
```

### Cleanup při zavření

Když zavoláte `adapter.close()`, FileAdapter vyčistí zbylé temp soubory z přerušených zápisů:

```typescript
const adapter = new FileAdapter({ directory: './data' });

// ... použití adapteru ...

// Čistý shutdown
await adapter.close(); // Odstraní všechny *.tmp soubory
```

### Charakteristiky

| Aspekt | FileAdapter |
|--------|-------------|
| **Trvanlivost** | Trvanlivý — přežije restart procesu |
| **Výkon** | Dobrý — cache filesystému pomáhá |
| **Setup** | Minimální — stačí specifikovat adresář |
| **Souběžnost** | Jeden proces — žádné zamykání |
| **Use case** | Jednoduché aplikace, prototypy, debugging |

---

## SQLiteAdapter

Produkční persistence pomocí SQLite databáze s WAL (Write-Ahead Logging) režimem.

### Kdy použít

- **Produkční aplikace** — ověřené, spolehlivé
- **Mnoho GenServerů** — efektivní pro stovky/tisíce procesů
- **Souběžné čtení** — WAL režim umožňuje čtenáře během zápisů
- **Potřeba dotazování** — můžete dotazovat stav přímo pomocí SQL nástrojů

### Instalace

SQLiteAdapter vyžaduje `better-sqlite3` jako peer dependency:

```bash
npm install better-sqlite3
# nebo
pnpm add better-sqlite3
```

### Základní použití

```typescript
import { SQLiteAdapter, GenServer } from '@hamicek/noex';

const adapter = new SQLiteAdapter({
  filename: './data/state.db',
});

const counter = await GenServer.start(counterBehavior, {
  name: 'my-counter',
  persistence: {
    adapter,
    restoreOnStart: true,
    persistOnShutdown: true,
  },
});
```

### Konfigurační možnosti

```typescript
const adapter = new SQLiteAdapter({
  // Povinné: cesta k databázovému souboru (použijte ':memory:' pro in-memory)
  filename: './data/state.db',

  // Volitelné: název tabulky (default: 'noex_state')
  tableName: 'noex_state',

  // Volitelné: povolení WAL režimu pro lepší souběžnost (default: true)
  walMode: true,
});
```

### Schéma databáze

SQLiteAdapter vytváří tuto tabulku automaticky:

```sql
CREATE TABLE IF NOT EXISTS noex_state (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,        -- JSON serializovaný stav + metadata
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### Výhody WAL režimu

S `walMode: true` (default) SQLite používá Write-Ahead Logging:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         VÝHODY WAL REŽIMU                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Bez WAL (journal mode):                                                    │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐                            │
│  │  Writer  │────▶│ ZAMČENO  │────▶│  Reader  │ ✗ blokován                 │
│  └──────────┘     └──────────┘     └──────────┘                            │
│                                                                             │
│  S WAL režimem:                                                             │
│  ┌──────────┐     ┌──────────┐                                             │
│  │  Writer  │────▶│   WAL    │                                             │
│  └──────────┘     └──────────┘                                             │
│                         │                                                   │
│  ┌──────────┐     ┌──────────┐                                             │
│  │  Reader  │────▶│   DB     │ ✓ čte commitnutá data                       │
│  └──────────┘     └──────────┘                                             │
│                                                                             │
│  Výsledek: Čtenáři nikdy neblokují writery, writeři nikdy neblokují čtenáře│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### In-Memory databáze

Pro testování s SQLite features bez souborového I/O:

```typescript
const adapter = new SQLiteAdapter({
  filename: ':memory:',
});

// Rychlé, izolované, ale ztracené když se adapter zavře
```

### Inspekce stavu pomocí SQL

Můžete dotazovat databázi přímo pro debugging:

```bash
$ sqlite3 ./data/state.db

sqlite> SELECT key, json_extract(data, '$.state.count') as count
        FROM noex_state
        WHERE key LIKE 'counter%';

key          | count
-------------|------
counter-1    | 42
counter-2    | 17
```

### Příklad: Produkční setup

```typescript
import { SQLiteAdapter, Application } from '@hamicek/noex';

const adapter = new SQLiteAdapter({
  filename: process.env.DB_PATH || './data/state.db',
  walMode: true,
});

const app = Application.create({
  // ... děti ...
});

// Graceful shutdown zajišťuje zavření adapteru
process.on('SIGTERM', async () => {
  await app.stop();
  await adapter.close();
  process.exit(0);
});
```

### Charakteristiky

| Aspekt | SQLiteAdapter |
|--------|---------------|
| **Trvanlivost** | Trvanlivý — ACID garance |
| **Výkon** | Výborný — prepared statements, WAL |
| **Setup** | Vyžaduje `better-sqlite3` dependency |
| **Souběžnost** | Více čtenářů, jeden writer |
| **Use case** | Produkční aplikace |

---

## Výběr správného adapteru

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PRŮVODCE VÝBĚREM ADAPTERU                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────┐                                    │
│  │  Je to pro testování nebo vývoj?    │                                    │
│  └─────────────────┬───────────────────┘                                    │
│                    │                                                        │
│          ┌────────┴────────┐                                               │
│          ▼                 ▼                                                │
│        ANO                NE                                                │
│          │                 │                                                │
│          ▼                 ▼                                                │
│   MemoryAdapter    ┌─────────────────────────────────────┐                 │
│                    │  Potřebujete manuálně inspektovat   │                 │
│                    │  stavové soubory pro debugging?     │                 │
│                    └─────────────────┬───────────────────┘                 │
│                                      │                                      │
│                    ┌────────────────┴────────────────┐                     │
│                    ▼                                 ▼                      │
│                   ANO                               NE                      │
│                    │                                 │                      │
│                    ▼                                 ▼                      │
│             FileAdapter              ┌─────────────────────────────────┐   │
│             (prettyPrint: true)      │  Kolik GenServerů budete        │   │
│                                      │  mít?                           │   │
│                                      └─────────────────┬───────────────┘   │
│                                                        │                    │
│                                      ┌────────────────┴────────────────┐   │
│                                      ▼                                 ▼   │
│                                   < 50                              >= 50   │
│                                      │                                 │    │
│                                      ▼                                 ▼    │
│                               FileAdapter                      SQLiteAdapter│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Rychlá referenční tabulka

| Scénář | Doporučený adapter |
|--------|-------------------|
| Unit testy | `MemoryAdapter` |
| Integrační testy | `MemoryAdapter` nebo `SQLiteAdapter({ filename: ':memory:' })` |
| Lokální vývoj | `FileAdapter({ prettyPrint: true })` |
| Jednoduchá produkce (< 50 procesů) | `FileAdapter` |
| Produkce (>= 50 procesů) | `SQLiteAdapter` |
| Potřeba SQL dotazů na stav | `SQLiteAdapter` |
| Debugging problémů s persistence | `FileAdapter({ prettyPrint: true })` |

---

## Implementace vlastního adapteru

Potřebujete ukládat stav do Redis, PostgreSQL nebo S3? Implementujte interface `StorageAdapter`:

```typescript
import type {
  StorageAdapter,
  PersistenceKey,
  PersistedState
} from '@hamicek/noex';

export class RedisAdapter implements StorageAdapter {
  private client: RedisClient;
  private prefix: string;

  constructor(options: { url: string; prefix?: string }) {
    this.client = createRedisClient(options.url);
    this.prefix = options.prefix ?? 'noex:';
  }

  private getKey(key: PersistenceKey): string {
    return `${this.prefix}${key}`;
  }

  async save(key: PersistenceKey, data: PersistedState<unknown>): Promise<void> {
    const serialized = JSON.stringify(data);
    await this.client.set(this.getKey(key), serialized);
  }

  async load<T>(key: PersistenceKey): Promise<PersistedState<T> | undefined> {
    const data = await this.client.get(this.getKey(key));
    if (data === null) {
      return undefined;
    }
    return JSON.parse(data) as PersistedState<T>;
  }

  async delete(key: PersistenceKey): Promise<boolean> {
    const result = await this.client.del(this.getKey(key));
    return result > 0;
  }

  async exists(key: PersistenceKey): Promise<boolean> {
    const result = await this.client.exists(this.getKey(key));
    return result > 0;
  }

  async listKeys(prefix?: string): Promise<readonly PersistenceKey[]> {
    const pattern = prefix
      ? `${this.prefix}${prefix}*`
      : `${this.prefix}*`;

    const keys = await this.client.keys(pattern);
    return keys.map(k => k.slice(this.prefix.length));
  }

  async cleanup(maxAgeMs: number): Promise<number> {
    const now = Date.now();
    const keys = await this.listKeys();
    let cleaned = 0;

    for (const key of keys) {
      const data = await this.load(key);
      if (data && now - data.metadata.persistedAt > maxAgeMs) {
        if (await this.delete(key)) {
          cleaned++;
        }
      }
    }

    return cleaned;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
```

### Best practices pro vlastní adaptery

1. **Ošetřujte chyby elegantně** — Vyhazujte `StorageError` s smysluplnými zprávami
2. **Implementujte `close()`** — Uklízejte spojení a zdroje
3. **Zvažte atomicitu** — Předcházejte částečným zápisům kde je to možné
4. **Testujte důkladně** — Použijte stejnou testovací sadu jako vestavěné adaptery
5. **Dokumentujte omezení** — Poznamenejte jakákoliv omezení souběžnosti nebo konzistence

---

## Cvičení: Multi-environment konfigurace

Vytvořte pomocnou funkci, která vrací vhodný adapter na základě `NODE_ENV`:

```typescript
import { StorageAdapter, MemoryAdapter, FileAdapter, SQLiteAdapter } from '@hamicek/noex';

interface PersistenceConfig {
  dataDir?: string;
  dbPath?: string;
}

function createAdapter(config: PersistenceConfig = {}): StorageAdapter {
  const env = process.env.NODE_ENV || 'development';

  // Vaše implementace zde:
  // - 'test': vrať MemoryAdapter
  // - 'development': vrať FileAdapter s prettyPrint
  // - 'production': vrať SQLiteAdapter
}
```

**Požadavky:**

1. V `test` prostředí použijte `MemoryAdapter`
2. V `development` použijte `FileAdapter` s:
   - Adresářem z `config.dataDir` nebo `./data/dev`
   - `prettyPrint: true` pro debugging
3. V `production` použijte `SQLiteAdapter` s:
   - Cestou k databázi z `config.dbPath` nebo `./data/state.db`
   - Povoleným WAL režimem

### Řešení

```typescript
import {
  StorageAdapter,
  MemoryAdapter,
  FileAdapter,
  SQLiteAdapter
} from '@hamicek/noex';

interface PersistenceConfig {
  dataDir?: string;
  dbPath?: string;
}

function createAdapter(config: PersistenceConfig = {}): StorageAdapter {
  const env = process.env.NODE_ENV || 'development';

  switch (env) {
    case 'test':
      return new MemoryAdapter();

    case 'development':
      return new FileAdapter({
        directory: config.dataDir || './data/dev',
        prettyPrint: true,
        checksums: true,
        atomicWrites: true,
      });

    case 'production':
      return new SQLiteAdapter({
        filename: config.dbPath || './data/state.db',
        walMode: true,
      });

    default:
      // Neznámé prostředí — bezpečně s MemoryAdapter
      console.warn(`Neznámé NODE_ENV: ${env}, používám MemoryAdapter`);
      return new MemoryAdapter();
  }
}

// Použití
const adapter = createAdapter({
  dataDir: process.env.DATA_DIR,
  dbPath: process.env.DB_PATH,
});

const counter = await GenServer.start(counterBehavior, {
  name: 'counter',
  persistence: {
    adapter,
    restoreOnStart: true,
    persistOnShutdown: true,
  },
});
```

---

## Shrnutí

**Klíčové poznatky:**

- **StorageAdapter interface** — Všechny adaptery jsou zaměnitelné, umožňující snadné výměny mezi prostředími
- **MemoryAdapter** — Zero-config, in-memory úložiště pro testy a vývoj
- **FileAdapter** — Souborová persistence s atomickými zápisy a checksums, skvělé pro jednoduché aplikace a debugging
- **SQLiteAdapter** — Produkční persistence s WAL režimem, ideální pro mnoho procesů
- **Vybírejte podle potřeb** — Testy → Memory, Debug → File, Produkce → SQLite
- **Vlastní adaptery** — Implementujte `StorageAdapter` pro integraci s jakýmkoliv backendem

**Vzor:**

```typescript
// Stejný kód, různé adaptery
const adapter = isTest ? new MemoryAdapter() : new SQLiteAdapter({ filename: './data.db' });
const server = await GenServer.start(behavior, { persistence: { adapter } });
```

---

Další: [Konfigurace](./03-konfigurace.md)
