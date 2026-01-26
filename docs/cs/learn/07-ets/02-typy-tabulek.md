# Typy tabulek

ETS poskytuje čtyři odlišné typy tabulek, každý navržený pro jiné potřeby organizace dat. Výběr správného typu je klíčový jak pro korektnost, tak pro výkon. V této kapitole se naučíte, kdy a jak použít každý typ.

## Co se naučíte

- Čtyři typy ETS tabulek a jejich sémantika
- Jak jsou klíče a hodnoty ukládány v každém typu
- Kdy použít každý typ pro optimální výsledky
- Navigační operace exkluzivní pro `ordered_set`

## Rychlý přehled

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TYPY ETS TABULEK                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  TYP             KLÍČE      HODNOT NA KLÍČ    DUPLIKÁTY     ŘAZENÍ          │
│  ─────────────   ────────   ──────────────    ──────────    ────────        │
│  set             unikátní   jedna             ne            neřazeno        │
│  ordered_set     unikátní   jedna             ne            seřazeno        │
│  bag             povoleny   více              jen unikátní  neřazeno        │
│  duplicate_bag   povoleny   více              povoleny      neřazeno        │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  CHOVÁNÍ LOOKUP:                                                            │
│  • set / ordered_set:  lookup(key) → V | undefined                          │
│  • bag / duplicate_bag: lookup(key) → V[] (prázdné pole pokud nenalezeno)   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## set — Výchozí typ

Typ `set` je nejjednodušší a nejběžněji používaný. Každý klíč mapuje na přesně jednu hodnotu a vložení s existujícím klíčem přepíše předchozí hodnotu.

**Charakteristiky:**
- Unikátní klíče (jako JavaScript `Map`)
- O(1) lookup, insert a delete
- Pořadí vložení není zachováno

```typescript
import { Ets } from '@hamicek/noex';

// Vytvoření set tabulky (výchozí typ)
const users = Ets.new<string, { name: string; email: string }>({
  name: 'users',
  type: 'set', // volitelné, 'set' je výchozí
});

await users.start();

// Vložení záznamů
users.insert('u1', { name: 'Alice', email: 'alice@example.com' });
users.insert('u2', { name: 'Bob', email: 'bob@example.com' });

// Lookup vrací jednu hodnotu nebo undefined
const alice = users.lookup('u1');
// { name: 'Alice', email: 'alice@example.com' }

const missing = users.lookup('u99');
// undefined

// Přepsání existujícího klíče
users.insert('u1', { name: 'Alice Smith', email: 'alice.smith@example.com' });
console.log(users.lookup('u1')?.name); // 'Alice Smith'

// Velikost reflektuje unikátní klíče
console.log(users.size()); // 2
```

### Kdy použít `set`

- **Key-value cache** — Session data, API odpovědi, konfigurace
- **Entity storage** — Users, products, orders indexované podle ID
- **Lookup tabulky** — Jakékoliv 1:1 mapování kde potřebujete rychlý přístup podle klíče
- **Výchozí volba** — Když si nejste jisti, začněte se `set`

```typescript
// Příklad: Session cache
interface Session {
  userId: string;
  createdAt: number;
  expiresAt: number;
  data: Record<string, unknown>;
}

const sessions = Ets.new<string, Session>({
  name: 'sessions',
  type: 'set',
});

// Uložení session podle tokenu
sessions.insert(sessionToken, {
  userId: 'u123',
  createdAt: Date.now(),
  expiresAt: Date.now() + 3600000, // 1 hodina
  data: { preferences: { theme: 'dark' } },
});

// Rychlé vyhledávání při každém requestu
const session = sessions.lookup(sessionToken);
```

## ordered_set — Seřazené klíče

Typ `ordered_set` udržuje klíče v seřazeném pořadí, což umožňuje efektivní range dotazy a sekvenční navigaci. Jako `set`, každý klíč mapuje na jednu hodnotu.

**Charakteristiky:**
- Unikátní klíče v seřazeném pořadí
- O(log n) lookup, insert a delete (binární vyhledávání)
- Podporuje `first()`, `last()`, `next(key)`, `prev(key)` navigaci
- Podpora vlastního komparátoru pro nestandardní řazení

```typescript
import { Ets } from '@hamicek/noex';

// Stringové klíče jsou řazeny lexikograficky ve výchozím nastavení
const leaderboard = Ets.new<string, number>({
  name: 'leaderboard',
  type: 'ordered_set',
});

await leaderboard.start();

// Vložení v libovolném pořadí
leaderboard.insert('charlie', 85);
leaderboard.insert('alice', 95);
leaderboard.insert('bob', 90);

// toArray() a keys() vrací seřazené výsledky
console.log(leaderboard.keys());
// ['alice', 'bob', 'charlie']

console.log(leaderboard.toArray());
// [['alice', 95], ['bob', 90], ['charlie', 85]]
```

### Navigační operace

`ordered_set` poskytuje unikátní navigační metody pro procházení záznamů v pořadí:

```typescript
// Navigační metody (pouze ordered_set)
const scores = Ets.new<string, number>({
  name: 'scores',
  type: 'ordered_set',
});

scores.insertMany([
  ['d', 4],
  ['b', 2],
  ['e', 5],
  ['a', 1],
  ['c', 3],
]);

// Získání prvního a posledního záznamu
console.log(scores.first()); // { key: 'a', value: 1 }
console.log(scores.last());  // { key: 'e', value: 5 }

// Navigace od klíče
console.log(scores.next('b')); // { key: 'c', value: 3 }
console.log(scores.prev('d')); // { key: 'c', value: 3 }

// Edge cases
console.log(scores.next('e')); // undefined (žádný další po posledním)
console.log(scores.prev('a')); // undefined (žádný předchozí před prvním)

// Vyhazuje EtsKeyNotFoundError pro neexistující klíče
try {
  scores.next('missing');
} catch (err) {
  console.log(err.message);
  // "Key 'missing' not found in ETS table 'scores'."
}
```

### Vlastní komparátor

Pro numerické klíče nebo vlastní logiku řazení poskytněte `keyComparator`:

```typescript
// Numerické klíče s přirozeným řazením
const timestamps = Ets.new<number, string>({
  name: 'events',
  type: 'ordered_set',
  keyComparator: (a, b) => a - b,
});

timestamps.insert(1706000000000, 'Event A');
timestamps.insert(1705000000000, 'Event B');
timestamps.insert(1707000000000, 'Event C');

// Klíče jsou nyní seřazeny numericky
console.log(timestamps.keys());
// [1705000000000, 1706000000000, 1707000000000]

// Získání nejstaršího eventu
console.log(timestamps.first());
// { key: 1705000000000, value: 'Event B' }
```

### Kdy použít `ordered_set`

- **Time-series data** — Eventy seřazené podle timestamp
- **Leaderboardy** — Skóre vyžadující ranking
- **Range dotazy** — Hledání záznamů v rozsahu
- **Iterace v pořadí** — Když potřebujete zpracovávat záznamy sekvenčně
- **Priority queues** — Položky seřazené podle priority

```typescript
// Příklad: Rate limit sliding window
const requestTimes = Ets.new<number, string>({
  name: 'rate-limit-window',
  type: 'ordered_set',
  keyComparator: (a, b) => a - b,
});

// Zaznamenání timestampů requestů
function recordRequest(userId: string): void {
  requestTimes.insert(Date.now(), userId);
}

// Počet requestů za poslední minutu
function countRecentRequests(): number {
  const oneMinuteAgo = Date.now() - 60000;
  return requestTimes.select((timestamp) => timestamp > oneMinuteAgo).length;
}

// Vyčištění starých záznamů (navigace od prvního až do aktuálního)
function cleanOldEntries(): void {
  const oneMinuteAgo = Date.now() - 60000;
  let entry = requestTimes.first();

  while (entry && entry.key < oneMinuteAgo) {
    requestTimes.delete(entry.key);
    entry = requestTimes.first();
  }
}
```

## bag — Více hodnot, bez duplikátů

Typ `bag` povoluje více hodnot na klíč, ale zajišťuje, že každý `{key, value}` pár je unikátní. Představte si to jako `Map<K, Set<V>>`.

**Charakteristiky:**
- Duplicitní klíče povoleny
- Každý `{key, value}` pár je unikátní (přidání stejného páru dvakrát je no-op)
- `lookup()` vrací `V[]` pole
- Užitečné pro one-to-many vztahy

```typescript
import { Ets } from '@hamicek/noex';

// Sledování uživatelských rolí (uživatelé mohou mít více rolí)
const userRoles = Ets.new<string, string>({
  name: 'user-roles',
  type: 'bag',
});

await userRoles.start();

// Přiřazení rolí uživatelům
userRoles.insert('alice', 'admin');
userRoles.insert('alice', 'editor');
userRoles.insert('bob', 'viewer');

// lookup() vrací pole hodnot
console.log(userRoles.lookup('alice'));
// ['admin', 'editor']

console.log(userRoles.lookup('bob'));
// ['viewer']

console.log(userRoles.lookup('missing'));
// [] (prázdné pole pro chybějící klíč)

// Duplicitní pár je ignorován
userRoles.insert('alice', 'admin'); // no-op, již existuje
console.log(userRoles.lookup('alice'));
// ['admin', 'editor'] (žádný duplicitní 'admin')

// Jiná hodnota pro stejný klíč je přidána
userRoles.insert('alice', 'moderator');
console.log(userRoles.lookup('alice'));
// ['admin', 'editor', 'moderator']
```

### Mazání v Bags

```typescript
// delete(key) odstraní všechny hodnoty pro klíč
userRoles.delete('alice');
console.log(userRoles.lookup('alice')); // []

// deleteObject(key, value) odstraní pouze tento konkrétní pár
userRoles.insert('bob', 'editor');
userRoles.insert('bob', 'viewer');
console.log(userRoles.lookup('bob')); // ['viewer', 'editor']

userRoles.deleteObject('bob', 'viewer');
console.log(userRoles.lookup('bob')); // ['editor']

// Odstranění poslední hodnoty odstraní klíč
userRoles.deleteObject('bob', 'editor');
console.log(userRoles.member('bob')); // false
```

### Kdy použít `bag`

- **Tagging systémy** — Položky s více unikátními tagy
- **Přiřazení rolí** — Uživatelé s více odlišnými rolemi
- **Mapování kategorií** — Produkty ve více kategoriích
- **Hrany grafu** — Spojení uzlů kde každá hrana je unikátní

```typescript
// Příklad: Tagy produktů
interface Product {
  id: string;
  name: string;
}

const productTags = Ets.new<string, string>({
  name: 'product-tags',
  type: 'bag',
});

// Tagování produktů
productTags.insert('laptop-001', 'electronics');
productTags.insert('laptop-001', 'computers');
productTags.insert('laptop-001', 'sale');

// Nalezení všech tagů pro produkt
const tags = productTags.lookup('laptop-001');
// ['electronics', 'computers', 'sale']

// Nalezení všech produktů s konkrétním tagem
const saleItems = productTags.select(
  (_productId, tag) => tag === 'sale'
);
```

## duplicate_bag — Plné duplikáty povoleny

Typ `duplicate_bag` je nejpermisivnější — povoluje více identických `{key, value}` párů. Představte si to jako `Map<K, V[]>` kde pole může obsahovat duplikáty.

**Charakteristiky:**
- Duplicitní klíče povoleny
- Duplicitní `{key, value}` páry povoleny
- `lookup()` vrací `V[]` pole s možnými duplikáty
- Užitečné pro event logy, čítače a audit trails

```typescript
import { Ets } from '@hamicek/noex';

// Sledování všech click eventů (stejný event může nastat vícekrát)
const clickEvents = Ets.new<string, number>({
  name: 'clicks',
  type: 'duplicate_bag',
});

await clickEvents.start();

// Zaznamenání kliků (stejné tlačítko, stejný timestamp možný)
clickEvents.insert('buy-button', Date.now());
clickEvents.insert('buy-button', Date.now());
clickEvents.insert('buy-button', Date.now());

// Všechny záznamy jsou zachovány
console.log(clickEvents.lookup('buy-button').length); // 3

// size() počítá všechny záznamy
console.log(clickEvents.size()); // 3
```

### Mazání v Duplicate Bags

```typescript
const events = Ets.new<string, string>({
  name: 'events',
  type: 'duplicate_bag',
});

// Přidání duplicitních eventů
events.insert('page:home', 'view');
events.insert('page:home', 'view');
events.insert('page:home', 'scroll');
events.insert('page:home', 'view');

console.log(events.lookup('page:home'));
// ['view', 'view', 'scroll', 'view']

// deleteObject odstraní pouze PRVNÍ odpovídající záznam
events.deleteObject('page:home', 'view');
console.log(events.lookup('page:home'));
// ['view', 'scroll', 'view'] (pouze jeden 'view' odstraněn)

// delete(key) odstraní VŠECHNY záznamy pro klíč
events.delete('page:home');
console.log(events.size()); // 0
```

### Kdy použít `duplicate_bag`

- **Event logging** — Zaznamenání každého výskytu eventu
- **Audit trails** — Sledování všech akcí včetně opakovaných
- **Time series** — Více datových bodů na stejném timestampu
- **Message queues** — Kde duplicitní zprávy jsou validní

```typescript
// Příklad: Log uživatelské aktivity
interface ActivityEvent {
  action: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

const activityLog = Ets.new<string, ActivityEvent>({
  name: 'activity-log',
  type: 'duplicate_bag',
});

// Logování všech uživatelských aktivit (včetně duplikátů)
function logActivity(userId: string, action: string, metadata?: Record<string, unknown>): void {
  activityLog.insert(userId, {
    action,
    timestamp: Date.now(),
    metadata,
  });
}

// Uživatel může provést stejnou akci vícekrát
logActivity('u1', 'page_view', { page: '/home' });
logActivity('u1', 'page_view', { page: '/home' }); // duplikát je validní
logActivity('u1', 'click', { button: 'signup' });
logActivity('u1', 'page_view', { page: '/home' });

// Získání kompletní historie aktivit
const userActivity = activityLog.lookup('u1');
console.log(userActivity.length); // 4 (všechny eventy zachovány)

// Počet konkrétních akcí
const pageViews = userActivity.filter(e => e.action === 'page_view').length;
console.log(pageViews); // 3
```

## Porovnání: bag vs duplicate_bag

Klíčový rozdíl je v tom, jak zacházejí s opakovanými `{key, value}` páry:

```typescript
// bag: pouze unikátní páry
const bag = Ets.new<string, string>({ name: 'bag', type: 'bag' });
bag.insert('k', 'v');
bag.insert('k', 'v'); // ignorováno — pár existuje
bag.insert('k', 'v'); // ignorováno — pár existuje
console.log(bag.lookup('k')); // ['v'] — pouze jeden záznam

// duplicate_bag: všechny páry uloženy
const dupBag = Ets.new<string, string>({ name: 'dupbag', type: 'duplicate_bag' });
dupBag.insert('k', 'v');
dupBag.insert('k', 'v'); // uloženo
dupBag.insert('k', 'v'); // uloženo
console.log(dupBag.lookup('k')); // ['v', 'v', 'v'] — tři záznamy
```

**Rozhodovací průvodce:**

| Scénář | Použijte |
|--------|----------|
| Uživatel má role admin, editor, admin | `bag` → uloží [admin, editor] |
| Log ukazuje click, click, click eventy | `duplicate_bag` → uloží všechny tři |
| Produkt má tagy A, B, A | `bag` → uloží [A, B] |
| Čítač inkrementuje +1, +1, +1 | `duplicate_bag` → uloží všechny |

## Velikost a počítání

Pro `bag` a `duplicate_bag` `size()` počítá **všechny záznamy**, ne unikátní klíče:

```typescript
const bag = Ets.new<string, number>({ name: 'test', type: 'bag' });

bag.insert('a', 1);
bag.insert('a', 2);
bag.insert('a', 3);
bag.insert('b', 10);

console.log(bag.size()); // 4 (celkové záznamy)
console.log(bag.keys().length); // 2 (unikátní klíče: 'a', 'b')
```

## Operace s čítači a typy tabulek

`updateCounter()` funguje pouze se `set` a `ordered_set`:

```typescript
// ✅ Funguje se set/ordered_set
const counters = Ets.new<string, number>({ name: 'counters', type: 'set' });
counters.updateCounter('hits', 1);  // 1
counters.updateCounter('hits', 1);  // 2
counters.updateCounter('hits', 10); // 12

// ❌ Vyhazuje EtsCounterTypeError pro bag typy
const bagCounters = Ets.new<string, number>({ name: 'bag', type: 'bag' });
bagCounters.updateCounter('hits', 1); // Error!
```

Pokud potřebujete více čítačů na klíč, použijte `bag` s manuální agregací:

```typescript
const multiCounters = Ets.new<string, number>({ name: 'multi', type: 'bag' });

// Přidání inkrementů jako samostatné záznamy
multiCounters.insert('metric', 1);
multiCounters.insert('metric', 5);
multiCounters.insert('metric', 3);

// Suma pro získání celku
const total = multiCounters.lookup('metric').reduce((sum, val) => sum + val, 0);
console.log(total); // 9
```

## Vývojový diagram pro výběr typu

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   VÝBĚR TYPU ETS TABULKY                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────┐                            │
│  │  Potřebujete více hodnot na klíč?           │                            │
│  └──────────────────────┬──────────────────────┘                            │
│                         │                                                   │
│            ┌────────────┴────────────┐                                      │
│            ▼                         ▼                                      │
│           NE                        ANO                                     │
│            │                         │                                      │
│            ▼                         ▼                                      │
│  ┌─────────────────────┐   ┌─────────────────────────────────┐              │
│  │ Potřebujete seřazené│   │ Může se stejný {key,value}      │              │
│  │ klíče?              │   │ opakovat?                       │              │
│  └──────────┬──────────┘   └──────────────┬──────────────────┘              │
│             │                             │                                 │
│      ┌──────┴──────┐               ┌──────┴──────┐                          │
│      ▼             ▼               ▼             ▼                          │
│     NE            ANO             NE            ANO                         │
│      │             │               │             │                          │
│      ▼             ▼               ▼             ▼                          │
│  ┌───────┐   ┌────────────┐   ┌───────┐   ┌──────────────┐                  │
│  │  set  │   │ ordered_set│   │  bag  │   │ duplicate_bag│                  │
│  └───────┘   └────────────┘   └───────┘   └──────────────┘                  │
│                                                                             │
│  PŘÍKLADY:                                                                  │
│  • Uživatel podle ID       → set                                            │
│  • Eventy podle timestamp  → ordered_set                                    │
│  • Uživatelské role        → bag (uživatel nemůže mít stejnou roli 2×)      │
│  • Click eventy            → duplicate_bag (stejný click se může opakovat)  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Cvičení: Multi-Tenant systém oprávnění

Vytvořte systém oprávnění, který sleduje, kteří uživatelé mají přístup ke kterým zdrojům. Uživatelé mohou mít více oprávnění na zdroj, ale každé unikátní oprávnění by mělo být uloženo pouze jednou.

**Požadavky:**
1. Sledování `{userId, resourceId} → permissions[]`
2. Každé oprávnění pro pár uživatel-zdroj by mělo být unikátní
3. Podpora kontroly, zda má uživatel konkrétní oprávnění na zdroj
4. Podpora výpisu všech oprávnění pro uživatele přes všechny zdroje
5. Podpora odebrání konkrétních oprávnění

**Výchozí kód:**

```typescript
import { Ets } from '@hamicek/noex';

type Permission = 'read' | 'write' | 'delete' | 'admin';

// Zvolte správný typ tabulky!
const permissions = Ets.new<string, Permission>({
  name: 'permissions',
  type: '???', // Který typ?
});

await permissions.start();

// Helper pro vytvoření složeného klíče
function makeKey(userId: string, resourceId: string): string {
  return `${userId}:${resourceId}`;
}

// Udělení oprávnění
function grant(userId: string, resourceId: string, permission: Permission): void {
  // TODO
}

// Odebrání oprávnění
function revoke(userId: string, resourceId: string, permission: Permission): boolean {
  // TODO
}

// Kontrola, zda má uživatel oprávnění
function hasPermission(userId: string, resourceId: string, permission: Permission): boolean {
  // TODO
}

// Získání všech oprávnění pro uživatele na zdroj
function getPermissions(userId: string, resourceId: string): Permission[] {
  // TODO
}

// Získání všech oprávnění uživatele přes všechny zdroje
function getAllUserPermissions(userId: string): Array<{ resourceId: string; permission: Permission }> {
  // TODO
}
```

<details>
<summary><strong>Řešení</strong></summary>

```typescript
import { Ets } from '@hamicek/noex';

type Permission = 'read' | 'write' | 'delete' | 'admin';

// Použijte 'bag' — více oprávnění na klíč, ale každé oprávnění unikátní
const permissions = Ets.new<string, Permission>({
  name: 'permissions',
  type: 'bag',
});

await permissions.start();

function makeKey(userId: string, resourceId: string): string {
  return `${userId}:${resourceId}`;
}

function grant(userId: string, resourceId: string, permission: Permission): void {
  const key = makeKey(userId, resourceId);
  permissions.insert(key, permission);
  // bag typ zajistí, že stejné oprávnění nebude přidáno dvakrát
}

function revoke(userId: string, resourceId: string, permission: Permission): boolean {
  const key = makeKey(userId, resourceId);
  return permissions.deleteObject(key, permission);
}

function hasPermission(userId: string, resourceId: string, permission: Permission): boolean {
  const key = makeKey(userId, resourceId);
  const perms = permissions.lookup(key) as Permission[];
  return perms.includes(permission);
}

function getPermissions(userId: string, resourceId: string): Permission[] {
  const key = makeKey(userId, resourceId);
  return permissions.lookup(key) as Permission[];
}

function getAllUserPermissions(userId: string): Array<{ resourceId: string; permission: Permission }> {
  // Match všech klíčů začínajících s userId:
  const matches = permissions.match(`${userId}:*`);

  return matches.map(({ key, value }) => {
    const resourceId = (key as string).split(':')[1]!;
    return { resourceId, permission: value };
  });
}

// Test systému
grant('alice', 'doc-1', 'read');
grant('alice', 'doc-1', 'write');
grant('alice', 'doc-1', 'read'); // no-op, již existuje
grant('alice', 'doc-2', 'read');
grant('bob', 'doc-1', 'read');

console.log(hasPermission('alice', 'doc-1', 'read'));  // true
console.log(hasPermission('alice', 'doc-1', 'delete')); // false

console.log(getPermissions('alice', 'doc-1'));
// ['read', 'write']

console.log(getAllUserPermissions('alice'));
// [
//   { resourceId: 'doc-1', permission: 'read' },
//   { resourceId: 'doc-1', permission: 'write' },
//   { resourceId: 'doc-2', permission: 'read' }
// ]

revoke('alice', 'doc-1', 'write');
console.log(getPermissions('alice', 'doc-1'));
// ['read']

await permissions.close();
```

**Proč `bag`?**
- Více oprávnění na pár uživatel-zdroj ✓
- Každé oprávnění by mělo být unikátní (žádné duplicitní "read" granty) ✓
- `duplicate_bag` by povolil udělení "read" vícekrát
- `set`/`ordered_set` by povolily pouze jedno oprávnění na klíč

</details>

## Shrnutí

**Klíčové poznatky:**

- **`set`** — Výchozí volba. Unikátní klíče, jedna hodnota každý. Použijte pro cache, entity storage, lookup tabulky.
- **`ordered_set`** — Jako `set`, ale klíče jsou seřazeny. Umožňuje navigaci (`first`, `last`, `next`, `prev`). Použijte pro time-series, leaderboardy, range dotazy.
- **`bag`** — Více hodnot na klíč, ale každý `{key, value}` pár je unikátní. Použijte pro role, tagy, kategorie.
- **`duplicate_bag`** — Více hodnot na klíč, duplikáty povoleny. Použijte pro event logy, audit trails, čítače.

**Rychlé rozhodnutí:**

| Otázka | Odpověď → Typ |
|--------|---------------|
| Jednoduchá key-value cache? | `set` |
| Potřebujete seřazenou iteraci? | `ordered_set` |
| Více unikátních hodnot na klíč? | `bag` |
| Potřebujete zaznamenat každý výskyt? | `duplicate_bag` |

**Zapamatujte si:**

> Chování `lookup()` se mění podle typu: `set`/`ordered_set` vrací `V | undefined`, zatímco `bag`/`duplicate_bag` vrací `V[]`.

---

Další: [Praktické použití](./03-prakticke-pouziti.md)
