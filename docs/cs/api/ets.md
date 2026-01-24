# ETS API Reference

Factory `Ets` a třída `EtsTable` poskytují in-memory key-value store inspirovaný Erlang ETS. Na rozdíl od Registry není ETS vázáno na procesy — ukládá libovolná typovaná data s konfigurovatelnou sémantikou klíčů a volitelnou persistencí.

## Import

```typescript
import { Ets, EtsTable } from 'noex';
import type {
  EtsTableType,
  EtsOptions,
  EtsPersistenceConfig,
  EtsEntry,
  EtsPredicate,
  EtsMatchResult,
  EtsInfo,
} from 'noex';
import { EtsKeyNotFoundError, EtsCounterTypeError } from 'noex';
```

---

## Ets (Factory fasáda)

Objekt `Ets` poskytuje čistý namespace pro vytváření typovaných ETS tabulek.

### new()

Vytvoří novou instanci ETS tabulky.

```typescript
Ets.new<K, V>(options?: EtsOptions<K, V>): EtsTable<K, V>
```

**Parametry:**
- `options` - Volitelná konfigurace tabulky
  - `name` - Čitelný název (automaticky generovaný, pokud vynechán)
  - `type` - Typ tabulky: `'set'` | `'ordered_set'` | `'bag'` | `'duplicate_bag'` (výchozí: `'set'`)
  - `keyComparator` - Vlastní komparátor pro `ordered_set` tabulky
  - `persistence` - Konfigurace persistence

**Vrací:** Novou instanci `EtsTable<K, V>` (nutno zavolat `start()` před použitím)

**Příklad:**
```typescript
const users = Ets.new<string, { name: string; age: number }>({
  name: 'users',
  type: 'set',
});
await users.start();
```

---

## EtsTable

Hlavní třída tabulky poskytující CRUD, pattern matching, counter a navigační operace.

### Typy tabulek

| Typ | Klíče | Hodnoty | Použití |
|-----|-------|---------|---------|
| `set` | Unikátní | Jedna na klíč | Obecný key-value store |
| `ordered_set` | Unikátní, řazené | Jedna na klíč | Řazená data, range dotazy |
| `bag` | Duplicitní | Unikátní {klíč,hodnota} | Tagy, kategorie |
| `duplicate_bag` | Duplicitní | Všechny duplicity | Event logy, časové řady |

---

## Lifecycle

### start()

Inicializuje tabulku. Musí být zavolána před jakýmikoli operacemi. Obnoví persistovaný stav, pokud je persistence nakonfigurována.

```typescript
async start(): Promise<void>
```

**Poznámky:**
- Idempotentní — opakované volání nemá žádný efekt
- Pokud je persistence nakonfigurována s `restoreOnStart: true`, záznamy se načtou ze storage

---

### close()

Ukončí tabulku. Po `close()` nejsou povoleny žádné další operace. Zapíše nedokončenou persistenci, pokud je nakonfigurována.

```typescript
async close(): Promise<void>
```

---

## CRUD operace

### insert()

Vloží pár klíč-hodnota do tabulky.

```typescript
insert(key: K, value: V): void
```

**Chování podle typu tabulky:**
- `set` / `ordered_set`: Přepíše existující hodnotu pro klíč
- `bag`: Přidá záznam pouze pokud tento přesný pár {klíč, hodnota} neexistuje
- `duplicate_bag`: Vždy přidá záznam (duplicity povoleny)

---

### insertMany()

Hromadné vložení více párů klíč-hodnota.

```typescript
insertMany(entries: ReadonlyArray<readonly [K, V]>): void
```

---

### lookup()

Vyhledá hodnotu/hodnoty pro klíč.

```typescript
lookup(key: K): V | V[] | undefined
```

**Vrací podle typu tabulky:**
- `set` / `ordered_set`: `V | undefined`
- `bag` / `duplicate_bag`: `V[]` (prázdné pole, pokud klíč nenalezen)

---

### delete()

Smaže všechny záznamy pro klíč.

```typescript
delete(key: K): boolean
```

**Vrací:** `true` pokud byly nějaké záznamy odstraněny

---

### deleteObject()

Smaže konkrétní pár {klíč, hodnota}. Používá striktní rovnost (`===`).

```typescript
deleteObject(key: K, value: V): boolean
```

**Vrací:** `true` pokud byl záznam odstraněn

**Poznámky:**
- Pro `bag`/`duplicate_bag`: odstraní pouze odpovídající záznam
- Pro `set`/`ordered_set`: chová se jako `delete(key)` pokud hodnota odpovídá

---

### member()

Ověří, zda klíč v tabulce existuje.

```typescript
member(key: K): boolean
```

---

### size()

Vrátí celkový počet záznamů. Pro bags počítá všechny záznamy přes všechny klíče.

```typescript
size(): number
```

---

### toArray()

Vrátí všechny záznamy jako `[klíč, hodnota]` tuples. Pro `ordered_set` jsou záznamy v seřazeném pořadí.

```typescript
toArray(): [K, V][]
```

---

### keys()

Vrátí všechny klíče. Pro `ordered_set` jsou klíče v seřazeném pořadí.

```typescript
keys(): K[]
```

---

### clear()

Odstraní všechny záznamy z tabulky.

```typescript
clear(): void
```

---

## Dotazování a pattern matching

### select()

Filtruje záznamy pomocí predikátové funkce.

```typescript
select(predicate: EtsPredicate<K, V>): EtsMatchResult<K, V>[]
```

**Parametry:**
- `predicate` - Funkce `(key: K, value: V) => boolean`

**Vrací:** Pole `{ key, value }` pro odpovídající záznamy

**Příklad:**
```typescript
const adults = users.select((key, user) => user.age >= 18);
```

---

### match()

Matching záznamů pomocí glob vzoru na klíčích s volitelným value predikátem.

```typescript
match(keyPattern: string, valuePredicate?: EtsPredicate<K, V>): EtsMatchResult<K, V>[]
```

**Glob syntaxe:**
- `*` — libovolné znaky kromě `/`
- `**` — libovolné znaky včetně `/`
- `?` — jeden znak

**Příklad:**
```typescript
const userEntries = table.match('user:*');
const filtered = table.match('user:*', (_, u) => u.age > 25);
```

---

### reduce()

Fold přes všechny záznamy v tabulce.

```typescript
reduce<A>(fn: (accumulator: A, key: K, value: V) => A, initial: A): A
```

**Příklad:**
```typescript
const totalAge = users.reduce((sum, _, user) => sum + user.age, 0);
```

---

## Counter operace

### updateCounter()

Atomicky inkrementuje/dekrementuje numerický counter. Platné pouze pro `set`/`ordered_set` tabulky.

```typescript
updateCounter(key: K, increment: number): number
```

**Vrací:** Novou hodnotu counteru

**Poznámky:**
- Pokud klíč neexistuje, inicializuje ho na hodnotu `increment`
- Funguje pouze na tabulkách s numerickými hodnotami

**Vyhazuje:**
- `EtsCounterTypeError` - Pokud existující hodnota není číslo, nebo pokud voláno na bag/duplicate_bag

**Příklad:**
```typescript
const counters = Ets.new<string, number>({ name: 'counters' });
await counters.start();

counters.updateCounter('page_views', 1);  // 1
counters.updateCounter('page_views', 1);  // 2
counters.updateCounter('page_views', -1); // 1
```

---

## Navigace v ordered_set

Tyto metody mají smysl pouze pro `ordered_set` tabulky.

### first()

Vrátí první (nejmenší klíč) záznam.

```typescript
first(): EtsMatchResult<K, V> | undefined
```

---

### last()

Vrátí poslední (největší klíč) záznam.

```typescript
last(): EtsMatchResult<K, V> | undefined
```

---

### next()

Vrátí záznam bezprostředně za daným klíčem.

```typescript
next(key: K): EtsMatchResult<K, V> | undefined
```

**Vyhazuje:**
- `EtsKeyNotFoundError` - Pokud klíč neexistuje

---

### prev()

Vrátí záznam bezprostředně před daným klíčem.

```typescript
prev(key: K): EtsMatchResult<K, V> | undefined
```

**Vyhazuje:**
- `EtsKeyNotFoundError` - Pokud klíč neexistuje

**Příklad:**
```typescript
const sorted = Ets.new<number, string>({ name: 'sorted', type: 'ordered_set' });
await sorted.start();

sorted.insert(10, 'ten');
sorted.insert(20, 'twenty');
sorted.insert(30, 'thirty');

sorted.first();    // { key: 10, value: 'ten' }
sorted.last();     // { key: 30, value: 'thirty' }
sorted.next(10);   // { key: 20, value: 'twenty' }
sorted.prev(30);   // { key: 20, value: 'twenty' }
```

---

## Info

### info()

Vrátí runtime informace o tabulce.

```typescript
info(): EtsInfo
```

**Vrací:** `{ name: string; type: EtsTableType; size: number }`

---

## Chybové třídy

### EtsKeyNotFoundError

Vyhozena při volání `next()`/`prev()` s klíčem, který neexistuje v ordered_set.

**Vlastnosti:**
- `name` - `'EtsKeyNotFoundError'`
- `tableName` - Název tabulky
- `key` - Chybějící klíč

### EtsCounterTypeError

Vyhozena při volání `updateCounter()` na ne-numerické hodnotě nebo na bag/duplicate_bag tabulce.

**Vlastnosti:**
- `name` - `'EtsCounterTypeError'`
- `tableName` - Název tabulky
- `key` - Klíč, který způsobil chybu

---

## Typy

### EtsTableType

```typescript
type EtsTableType = 'set' | 'ordered_set' | 'bag' | 'duplicate_bag';
```

### EtsOptions

```typescript
interface EtsOptions<K, V> {
  readonly name?: string;
  readonly type?: EtsTableType;
  readonly keyComparator?: (a: K, b: K) => number;
  readonly persistence?: EtsPersistenceConfig;
}
```

### EtsPersistenceConfig

```typescript
interface EtsPersistenceConfig {
  readonly adapter: StorageAdapter;
  readonly key?: string;
  readonly restoreOnStart?: boolean;     // výchozí: true
  readonly persistOnChange?: boolean;    // výchozí: true
  readonly debounceMs?: number;          // výchozí: 100
  readonly persistOnShutdown?: boolean;  // výchozí: true
  readonly onError?: (error: Error) => void;
}
```

### EtsEntry

```typescript
interface EtsEntry<K, V> {
  readonly key: K;
  readonly value: V;
  readonly insertedAt: number;
}
```

### EtsPredicate

```typescript
type EtsPredicate<K, V> = (key: K, value: V) => boolean;
```

### EtsMatchResult

```typescript
interface EtsMatchResult<K, V> {
  readonly key: K;
  readonly value: V;
}
```

### EtsInfo

```typescript
interface EtsInfo {
  readonly name: string;
  readonly type: EtsTableType;
  readonly size: number;
}
```

---

## Kompletní příklad

```typescript
import { Ets } from 'noex';

interface User {
  name: string;
  age: number;
  role: 'admin' | 'user';
}

async function main() {
  // Vytvoření typované set tabulky
  const users = Ets.new<string, User>({ name: 'users', type: 'set' });
  await users.start();

  // Vložení dat
  users.insert('u1', { name: 'Alice', age: 30, role: 'admin' });
  users.insert('u2', { name: 'Bob', age: 25, role: 'user' });
  users.insert('u3', { name: 'Charlie', age: 35, role: 'user' });

  // Dotazování
  const admins = users.select((_, user) => user.role === 'admin');
  const totalAge = users.reduce((sum, _, user) => sum + user.age, 0);

  // Countery
  const metrics = Ets.new<string, number>({ name: 'metrics' });
  await metrics.start();
  metrics.updateCounter('requests', 1);
  metrics.updateCounter('requests', 1);

  // Ordered navigace
  const leaderboard = Ets.new<number, string>({
    name: 'scores',
    type: 'ordered_set',
  });
  await leaderboard.start();
  leaderboard.insert(100, 'Alice');
  leaderboard.insert(250, 'Bob');
  leaderboard.insert(180, 'Charlie');

  const top = leaderboard.last(); // { key: 250, value: 'Bob' }

  // Úklid
  await users.close();
  await metrics.close();
  await leaderboard.close();
}
```

## Související

- [ETS koncepty](../concepts/ets.md) - Typy tabulek, use cases, vzory
- [Registry API](./registry.md) - Vyhledávání pojmenovaných procesů
- [Persistence API](./persistence.md) - Rozhraní StorageAdapter
