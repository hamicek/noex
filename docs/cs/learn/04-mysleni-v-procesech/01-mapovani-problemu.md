# Mapování problémů na procesy

Nyní víte, jak vytvořit GenServery, používat supervisory a budovat stromy supervize. Ale zůstává zásadní otázka: **Jak rozhodnout, co by mělo být proces?**

Tato kapitola vás naučí mentální model pro rozklad problémů na procesy. Je to klíčová dovednost, která odděluje kód, který pouze používá noex, od kódu, který skutečně přijímá actor model.

## Co se naučíte

- Princip "jeden proces = jedna zodpovědnost"
- Jak identifikovat stav, který potřebuje izolaci
- Rozpoznávání a vyhýbání se anti-patternům sdíleného stavu
- Praktické heuristiky pro rozklad na procesy
- Reálné příklady s porovnáním před/po

## Mentální posun

Tradiční Node.js programování má tendenci myslet v pojmech:
- Objekty a třídy
- Sdílený měnitelný stav
- Synchronizační primitivy (zámky, mutexy, semafory)
- Callbacky a promises jako jednotka konkurence

Procesově orientované myšlení je odlišné:
- **Procesy** jako jednotka konkurence
- **Zprávy** jako jediný způsob komunikace
- **Izolace** jako výchozí stav
- **Hranice selhání** jako architektonická rozhodnutí

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          POSUN MENTÁLNÍHO MODELU                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Tradiční OOP                         Procesově orientované                 │
│  ───────────────                      ────────────────────                  │
│                                                                             │
│  class UserManager {                    UserProcess                         │
│    private users = new Map();           ┌───────────────┐                   │
│    private sessions = new Map();        │ State: users  │                   │
│    private stats = { ... };             │ Messages: ... │                   │
│                                         └───────────────┘                   │
│    async createUser() { ... }                   ↓                           │
│    async login() { ... }                SessionProcess                      │
│    async logout() { ... }               ┌───────────────┐                   │
│    getStats() { ... }                   │ State: sess   │                   │
│  }                                      │ Messages: ... │                   │
│                                         └───────────────┘                   │
│  Problémy:                                      ↓                           │
│  • Veškerý stav je propojený             StatsProcess                       │
│  • Možné race conditions                 ┌───────────────┐                  │
│  • Nelze restartovat části               │ State: stats  │                  │
│  • Selhání vše nebo nic                  │ Messages: ... │                  │
│                                          └───────────────┘                  │
│                                                                             │
│                                         Výhody:                             │
│                                         • Jasné hranice                     │
│                                         • Nezávislé selhání                 │
│                                         • Konkurentní provádění             │
│                                         • Snadné uvažování                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Jeden proces = jedna zodpovědnost

Princip jediné zodpovědnosti (Single Responsibility Principle) platí i pro procesy, ale s úpravou: **proces by měl mít jeden důvod ke změně stavu**.

### Co tvoří dobrou hranici procesu?

Položte si tyto otázky o části stavu:

1. **Potřebuje tento stav nezávislý životní cyklus?**
   - Může být vytvořen/zrušen nezávisle?
   - Měl by přežít restarty ostatních komponent?

2. **Má tento stav vlastní požadavky na konzistenci?**
   - Existují invarianty, které musí vždy platit?
   - Musí být operace atomické?

3. **Může tento stav selhat nezávisle?**
   - Pokud se něco pokazí, mělo by to ovlivnit ostatní stav?
   - Má vlastní potřeby zpracování chyb?

4. **Je tento stav přistupován z více míst?**
   - Potřebují různé části systému číst/zapisovat?
   - Byl by souběžný přístup problematický?

Pokud na většinu odpovíte "ano", tento stav si pravděpodobně zaslouží vlastní proces.

### Příklad: E-commerce nákupní košík

Pojďme analyzovat funkci nákupního košíku:

```typescript
// ❌ Špatně: Monolitický přístup
class ShoppingService {
  private carts: Map<string, CartItem[]> = new Map();
  private inventory: Map<string, number> = new Map();
  private prices: Map<string, number> = new Map();
  private orders: Order[] = [];

  async addToCart(userId: string, productId: string) {
    // Kontrola skladu
    const stock = this.inventory.get(productId) ?? 0;
    if (stock <= 0) throw new Error('Out of stock');

    // Přidání do košíku
    const cart = this.carts.get(userId) ?? [];
    cart.push({ productId, quantity: 1 });
    this.carts.set(userId, cart);

    // Rezervace skladu (možná race condition!)
    this.inventory.set(productId, stock - 1);
  }

  async checkout(userId: string) {
    const cart = this.carts.get(userId);
    if (!cart) throw new Error('Empty cart');

    // Výpočet celkové ceny, vytvoření objednávky, vyčištění košíku...
    // Vše propojené, chyba v jednom rozbije vše
  }
}
```

Problémy s tímto přístupem:
- **Race condition**: Dva uživatelé mohou oba vidět `stock = 1` a oba uspět
- **Propojené selhání**: Chyba v cenách zhroutí celý checkout
- **Žádná izolace**: Stav košíku je smíchaný se skladem a objednávkami
- **Nelze škálovat**: Všechny operace procházejí jedním objektem

```typescript
// ✅ Dobře: Přístup proces-per-concern
import { GenServer, Supervisor, type GenServerBehavior } from '@hamicek/noex';

// Každý uživatel má svůj vlastní proces košíku
interface CartState {
  userId: string;
  items: Map<string, number>; // productId -> quantity
}

type CartCall =
  | { type: 'add'; productId: string; quantity: number }
  | { type: 'remove'; productId: string }
  | { type: 'get' }
  | { type: 'clear' };

const createCartBehavior = (userId: string): GenServerBehavior<CartState, CartCall, never, CartState['items'] | boolean> => ({
  init: () => ({ userId, items: new Map() }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'add': {
        const current = state.items.get(msg.productId) ?? 0;
        state.items.set(msg.productId, current + msg.quantity);
        return [true, state];
      }
      case 'remove': {
        state.items.delete(msg.productId);
        return [true, state];
      }
      case 'get':
        return [new Map(state.items), state];
      case 'clear':
        return [true, { ...state, items: new Map() }];
    }
  },

  handleCast: (_, state) => state,
});

// Jeden proces pro sklad (sdílený zdroj)
interface InventoryState {
  stock: Map<string, number>;
  reserved: Map<string, number>; // orderId -> rezervované množství
}

type InventoryCall =
  | { type: 'check'; productId: string }
  | { type: 'reserve'; productId: string; quantity: number; orderId: string }
  | { type: 'commit'; orderId: string }
  | { type: 'release'; orderId: string };

const inventoryBehavior: GenServerBehavior<InventoryState, InventoryCall, never, number | boolean> = {
  init: () => ({
    stock: new Map([
      ['product-1', 100],
      ['product-2', 50],
    ]),
    reserved: new Map(),
  }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'check': {
        const available = state.stock.get(msg.productId) ?? 0;
        return [available, state];
      }
      case 'reserve': {
        const available = state.stock.get(msg.productId) ?? 0;
        if (available < msg.quantity) {
          return [false, state]; // Nedostatek skladu
        }
        // Atomická rezervace
        state.stock.set(msg.productId, available - msg.quantity);
        state.reserved.set(msg.orderId, msg.quantity);
        return [true, state];
      }
      case 'commit': {
        // Odstranění rezervace (sklad již snížen)
        state.reserved.delete(msg.orderId);
        return [true, state];
      }
      case 'release': {
        // Vrácení rezervovaného skladu
        const quantity = state.reserved.get(msg.orderId) ?? 0;
        if (quantity > 0) {
          // Poznámka: V reálném kódu byste museli sledovat, který produkt
          state.reserved.delete(msg.orderId);
        }
        return [true, state];
      }
    }
  },

  handleCast: (_, state) => state,
};
```

Nyní máme:
- **Košík per uživatel**: Košík každého uživatele je izolovaný
- **Jeden sklad**: Aktualizace skladu jsou serializované, žádné race conditions
- **Nezávislé selhání**: Pád košíku neovlivní sklad
- **Jasné hranice**: Snadné pochopit a testovat každou část

## Stav, který potřebuje izolaci

Ne veškerý stav musí být v procesu. Zde je rozhodovací průvodce:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    KDY POUŽÍT PROCES                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    Stav potřebuje proces, pokud...                  │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │                                                                     │   │
│  │  ✓ Je sdílený mezi více volajícími                                 │   │
│  │    → Databázové spojení, cache, rate limitery                      │   │
│  │                                                                     │   │
│  │  ✓ Vyžaduje atomické operace                                       │   │
│  │    → Čítače, zůstatky, sklad                                       │   │
│  │                                                                     │   │
│  │  ✓ Má životní cyklus (start → running → stop)                      │   │
│  │    → Spojení, sessions, subscriptions                              │   │
│  │                                                                     │   │
│  │  ✓ Potřebuje být supervizován (auto-restart při selhání)           │   │
│  │    → Služby, které musí být vždy dostupné                          │   │
│  │                                                                     │   │
│  │  ✓ Reprezentuje nezávislou entitu                                  │   │
│  │    → Uživatelé, objednávky, herní sessions, chat rooms             │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    Stav NEPOTŘEBUJE proces, pokud...                │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │                                                                     │   │
│  │  ✗ Je lokální pro jednu funkci                                     │   │
│  │    → Čítače smyček, dočasné proměnné                               │   │
│  │                                                                     │   │
│  │  ✗ Je neměnná konfigurace                                          │   │
│  │    → Nastavení aplikace načtená při startu                         │   │
│  │                                                                     │   │
│  │  ✗ Je odvozený/vypočítaný z jiného stavu                           │   │
│  │    → Součty, průměry, formátované řetězce                          │   │
│  │                                                                     │   │
│  │  ✗ Je používán pouze jedním procesem                               │   │
│  │    → Interní pracovní stav                                         │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Pattern entita-per-proces

Běžný pattern je jeden proces per instance entity:

```typescript
// Jeden proces per připojeného uživatele
// Jeden proces per aktivní hru
// Jeden proces per chat room
// Jeden proces per zpracovávanou objednávku

// Příklad: Herní lobby s procesy per hráč
async function createGameLobby() {
  // Každý hráč dostane svůj vlastní proces
  const playerSupervisor = await Supervisor.start({
    strategy: 'simple_one_for_one',
    childTemplate: {
      start: (playerId: string, socket: WebSocket) =>
        GenServer.start(createPlayerBehavior(playerId, socket)),
      restart: 'transient',
    },
  });

  // Když se hráč připojí:
  // await Supervisor.startChild(playerSupervisor, [playerId, socket]);

  // Výhody:
  // - Pád hráče ovlivní pouze toho hráče
  // - Hráči mohou být zpracováváni paralelně
  // - Snadné sledování a správa jednotlivých hráčů
  // - Přirozené mapování na doménový model

  return playerSupervisor;
}

interface PlayerState {
  id: string;
  position: { x: number; y: number };
  health: number;
  inventory: string[];
}

type PlayerCall =
  | { type: 'getState' }
  | { type: 'move'; dx: number; dy: number }
  | { type: 'damage'; amount: number };

type PlayerCast =
  | { type: 'sendMessage'; message: string };

const createPlayerBehavior = (
  playerId: string,
  socket: WebSocket
): GenServerBehavior<PlayerState, PlayerCall, PlayerCast, PlayerState | boolean> => ({
  init: () => ({
    id: playerId,
    position: { x: 0, y: 0 },
    health: 100,
    inventory: [],
  }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'getState':
        return [state, state];
      case 'move': {
        const newState = {
          ...state,
          position: {
            x: state.position.x + msg.dx,
            y: state.position.y + msg.dy,
          },
        };
        return [true, newState];
      }
      case 'damage': {
        const newHealth = Math.max(0, state.health - msg.amount);
        return [newHealth > 0, { ...state, health: newHealth }];
      }
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'sendMessage') {
      // socket.send(msg.message); // Odeslání na WebSocket hráče
    }
    return state;
  },
});
```

### Pattern singleton procesu

Některý stav by měl mít přesně jeden proces:

```typescript
// Jedna konfigurační služba
// Jeden rate limiter per zdroj
// Jeden metrics collector
// Jeden správce connection poolu

// Příklad: Rate limiter pro celou aplikaci
interface RateLimiterState {
  requests: Map<string, number[]>; // klíč -> časová razítka
  limit: number;
  windowMs: number;
}

type RateLimiterCall =
  | { type: 'check'; key: string }
  | { type: 'consume'; key: string };

const rateLimiterBehavior: GenServerBehavior<RateLimiterState, RateLimiterCall, never, boolean> = {
  init: () => ({
    requests: new Map(),
    limit: 100,
    windowMs: 60000,
  }),

  handleCall(msg, state) {
    const now = Date.now();
    const cutoff = now - state.windowMs;

    // Vyčištění starých záznamů
    const timestamps = (state.requests.get(msg.key) ?? []).filter(t => t > cutoff);

    if (msg.type === 'check') {
      return [timestamps.length < state.limit, state];
    }

    // msg.type === 'consume'
    if (timestamps.length >= state.limit) {
      return [false, state]; // Rate limited
    }

    timestamps.push(now);
    state.requests.set(msg.key, timestamps);
    return [true, state];
  },

  handleCast: (_, state) => state,
};

// Spuštění jako pojmenovaný singleton
const rateLimiter = await GenServer.start(rateLimiterBehavior, {
  name: 'rate-limiter',
});
```

## Anti-patterny sdíleného stavu

### Anti-pattern 1: Globální měnitelný stav

```typescript
// ❌ Špatně: Globální měnitelný stav
let connectionCount = 0;
const activeUsers = new Map<string, User>();

async function handleConnect(userId: string) {
  connectionCount++; // Race condition!
  activeUsers.set(userId, await loadUser(userId));
}

async function handleDisconnect(userId: string) {
  connectionCount--;
  activeUsers.delete(userId);
}

// Voláno z více async kontextů současně
// Výsledek: connectionCount se stane nepřesným
```

```typescript
// ✅ Dobře: Stav v procesu
interface ConnectionState {
  count: number;
  users: Map<string, User>;
}

type ConnectionCall =
  | { type: 'connect'; userId: string; user: User }
  | { type: 'disconnect'; userId: string }
  | { type: 'getCount' }
  | { type: 'getUser'; userId: string };

const connectionBehavior: GenServerBehavior<ConnectionState, ConnectionCall, never, number | User | undefined> = {
  init: () => ({ count: 0, users: new Map() }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'connect':
        state.users.set(msg.userId, msg.user);
        return [state.count + 1, { ...state, count: state.count + 1 }];
      case 'disconnect':
        state.users.delete(msg.userId);
        return [state.count - 1, { ...state, count: state.count - 1 }];
      case 'getCount':
        return [state.count, state];
      case 'getUser':
        return [state.users.get(msg.userId), state];
    }
  },

  handleCast: (_, state) => state,
};
```

### Anti-pattern 2: Předávání stavu mezi funkcemi

```typescript
// ❌ Špatně: Stav předávaný dokola, těžké sledovat
async function processOrder(order: Order, inventory: Inventory, payments: PaymentState) {
  // Kdo vlastní tento stav? Kdo ho může modifikovat?
  inventory.items[order.productId] -= order.quantity;

  const payment = await chargeCustomer(order.customerId, order.total, payments);

  // Pokud platba selže, jak vrátíme sklad zpět?
  // Stav je rozptýlený, těžké uvažování
}
```

```typescript
// ✅ Dobře: Každý proces vlastní svůj stav
async function processOrder(orderId: string) {
  const inventoryRef = Registry.whereis('inventory');
  const paymentRef = Registry.whereis('payments');

  if (!inventoryRef || !paymentRef) {
    throw new Error('Required services not available');
  }

  // Rezervace skladu (atomická operace)
  const reserved = await GenServer.call(inventoryRef, {
    type: 'reserve',
    orderId,
    productId: 'product-1',
    quantity: 1,
  });

  if (!reserved) {
    throw new Error('Insufficient inventory');
  }

  try {
    // Zpracování platby
    const paid = await GenServer.call(paymentRef, {
      type: 'charge',
      orderId,
      amount: 100,
    });

    if (!paid) {
      // Uvolnění skladu při selhání platby
      await GenServer.call(inventoryRef, { type: 'release', orderId });
      throw new Error('Payment failed');
    }

    // Potvrzení skladu
    await GenServer.call(inventoryRef, { type: 'commit', orderId });

  } catch (error) {
    // Uvolnění skladu při jakékoli chybě
    await GenServer.call(inventoryRef, { type: 'release', orderId });
    throw error;
  }
}
```

### Anti-pattern 3: Sdílené reference mezi procesy

```typescript
// ❌ Špatně: Procesy sdílejí referenci
const sharedCache = new Map<string, any>();

const process1 = await GenServer.start({
  init: () => ({ cache: sharedCache }), // Sdílení reference!
  handleCall: (msg, state) => {
    state.cache.set(msg.key, msg.value); // Modifikace sdíleného stavu
    return [true, state];
  },
  handleCast: (_, state) => state,
});

const process2 = await GenServer.start({
  init: () => ({ cache: sharedCache }), // Stejná reference!
  handleCall: (msg, state) => {
    // Race condition s process1!
    return [state.cache.get(msg.key), state];
  },
  handleCast: (_, state) => state,
});
```

```typescript
// ✅ Dobře: Dedikovaný cache proces
const cache = await GenServer.start({
  init: () => ({ data: new Map<string, any>() }),
  handleCall(msg: { type: 'get' | 'set'; key: string; value?: any }, state) {
    if (msg.type === 'set') {
      state.data.set(msg.key, msg.value);
      return [true, state];
    }
    return [state.data.get(msg.key), state];
  },
  handleCast: (_, state) => state,
}, { name: 'cache' });

// Oba process1 a process2 komunikují s cache přes zprávy
// Žádné sdílené reference, žádné race conditions
```

## Praktické heuristiky

Zde je rychlá reference pro rozklad systému na procesy:

### 1. Doménové entity → Procesy

| Doménový koncept | Pattern procesu |
|-----------------|-----------------|
| Uživatelská session | Jeden proces per session |
| Nákupní košík | Jeden proces per uživatel |
| Chat room | Jeden proces per room |
| Herní zápas | Jeden proces per zápas |
| Editovaný dokument | Jeden proces per dokument |

### 2. Infrastrukturní záležitosti → Singleton procesy

| Infrastruktura | Pattern procesu |
|----------------|-----------------|
| Database connection pool | Jeden proces |
| Cache | Jeden proces (nebo sharded) |
| Rate limiter | Jeden proces per zdroj |
| Metrics collector | Jeden proces |
| Konfigurace | Jeden proces |

### 3. Koordinace → Supervisor procesy

| Potřeba koordinace | Pattern procesu |
|-------------------|-----------------|
| Worker pool | Supervisor se `simple_one_for_one` |
| Service discovery | Registry proces |
| Health monitoring | Supervisor s lifecycle events |
| Graceful shutdown | Application proces |

## Příklad: Rozklad Blog API

Pojďme projít rozklad blog API na procesy:

### Požadavky
- Uživatelé mohou vytvářet příspěvky
- Příspěvky mohou mít komentáře
- Uživatelé mohou sledovat jiné uživatele
- Feed zobrazuje příspěvky od sledovaných uživatelů
- Analytika sleduje zobrazení příspěvků

### Rozklad na procesy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ARCHITEKTURA BLOG API PROCESŮ                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                              ┌──────────────┐                               │
│                              │     Root     │                               │
│                              │  Supervisor  │                               │
│                              └──────┬───────┘                               │
│          ┌──────────┬───────────────┼───────────────┬──────────┐           │
│          ▼          ▼               ▼               ▼          ▼           │
│    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│    │  User    │ │  Post    │ │  Feed    │ │Analytics │ │  Cache   │       │
│    │ Service  │ │ Service  │ │ Service  │ │ Service  │ │ Service  │       │
│    └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────────┘ └──────────┘       │
│         │            │            │                                         │
│   ┌─────┴─────┐   Používá     Používá Registry                             │
│   │   User    │   Registry    pro nalezení                                 │
│   │ Registry  │   pro lookup  příspěvků                                    │
│   │           │   příspěvků   sledovaných                                  │
│   └───────────┘              uživatelů                                     │
│                                                                             │
│  Zodpovědnosti procesů:                                                     │
│                                                                             │
│  UserService: CRUD uživatelů, autentizace, vztahy sledování                │
│  PostService: CRUD příspěvků, správa procesů jednotlivých příspěvků        │
│  FeedService: Agregace příspěvků od sledovaných uživatelů                  │
│  AnalyticsService: Sledování zobrazení, engagement (může být async)        │
│  CacheService: LRU cache pro často přistupovaná data                       │
│                                                                             │
│  Tok komunikace:                                                            │
│                                                                             │
│  1. Uživatel vytvoří příspěvek → PostService.createPost()                  │
│  2. Uživatel zobrazí feed → FeedService získá sledované z UserService      │
│     → FeedService získá příspěvky z PostService                            │
│  3. Příspěvek zobrazen → AnalyticsService.trackView() (cast, fire-and-forget)│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Náčrt implementace

```typescript
import { GenServer, Supervisor, Registry, type GenServerBehavior } from '@hamicek/noex';

// User Service - správa uživatelů a vztahů sledování
interface UserState {
  users: Map<string, { id: string; name: string; email: string }>;
  follows: Map<string, Set<string>>; // userId -> Set sledovaných userIds
}

type UserCall =
  | { type: 'create'; id: string; name: string; email: string }
  | { type: 'get'; id: string }
  | { type: 'follow'; followerId: string; followeeId: string }
  | { type: 'getFollowing'; userId: string };

const userServiceBehavior: GenServerBehavior<UserState, UserCall, never, any> = {
  init: () => ({
    users: new Map(),
    follows: new Map(),
  }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'create': {
        const user = { id: msg.id, name: msg.name, email: msg.email };
        state.users.set(msg.id, user);
        return [user, state];
      }
      case 'get':
        return [state.users.get(msg.id) ?? null, state];
      case 'follow': {
        const following = state.follows.get(msg.followerId) ?? new Set();
        following.add(msg.followeeId);
        state.follows.set(msg.followerId, following);
        return [true, state];
      }
      case 'getFollowing': {
        const following = state.follows.get(msg.userId) ?? new Set();
        return [Array.from(following), state];
      }
    }
  },

  handleCast: (_, state) => state,
};

// Post Service - správa příspěvků
interface PostState {
  posts: Map<string, { id: string; authorId: string; content: string; createdAt: Date }>;
  byAuthor: Map<string, string[]>; // authorId -> postIds
}

type PostCall =
  | { type: 'create'; id: string; authorId: string; content: string }
  | { type: 'get'; id: string }
  | { type: 'getByAuthor'; authorId: string };

type PostCast =
  | { type: 'delete'; id: string };

const postServiceBehavior: GenServerBehavior<PostState, PostCall, PostCast, any> = {
  init: () => ({
    posts: new Map(),
    byAuthor: new Map(),
  }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'create': {
        const post = {
          id: msg.id,
          authorId: msg.authorId,
          content: msg.content,
          createdAt: new Date(),
        };
        state.posts.set(msg.id, post);
        const authorPosts = state.byAuthor.get(msg.authorId) ?? [];
        authorPosts.push(msg.id);
        state.byAuthor.set(msg.authorId, authorPosts);
        return [post, state];
      }
      case 'get':
        return [state.posts.get(msg.id) ?? null, state];
      case 'getByAuthor': {
        const postIds = state.byAuthor.get(msg.authorId) ?? [];
        const posts = postIds.map(id => state.posts.get(id)).filter(Boolean);
        return [posts, state];
      }
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'delete') {
      const post = state.posts.get(msg.id);
      if (post) {
        state.posts.delete(msg.id);
        const authorPosts = state.byAuthor.get(post.authorId) ?? [];
        state.byAuthor.set(
          post.authorId,
          authorPosts.filter(id => id !== msg.id)
        );
      }
    }
    return state;
  },
};

// Analytics Service - fire-and-forget sledování
interface AnalyticsState {
  views: Map<string, number>; // postId -> počet zobrazení
}

type AnalyticsCast =
  | { type: 'trackView'; postId: string };

type AnalyticsCall =
  | { type: 'getViews'; postId: string };

const analyticsServiceBehavior: GenServerBehavior<AnalyticsState, AnalyticsCall, AnalyticsCast, number> = {
  init: () => ({ views: new Map() }),

  handleCall(msg, state) {
    if (msg.type === 'getViews') {
      return [state.views.get(msg.postId) ?? 0, state];
    }
    return [0, state];
  },

  handleCast(msg, state) {
    if (msg.type === 'trackView') {
      const current = state.views.get(msg.postId) ?? 0;
      state.views.set(msg.postId, current + 1);
    }
    return state;
  },
};

// Spuštění blog API
async function startBlogAPI() {
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      {
        id: 'user-service',
        start: () => GenServer.start(userServiceBehavior, { name: 'user-service' }),
      },
      {
        id: 'post-service',
        start: () => GenServer.start(postServiceBehavior, { name: 'post-service' }),
      },
      {
        id: 'analytics-service',
        start: () => GenServer.start(analyticsServiceBehavior, { name: 'analytics' }),
      },
    ],
  });

  console.log('Blog API started');
  return supervisor;
}

// Příklad použití
async function demo() {
  await startBlogAPI();

  const userService = Registry.whereis('user-service')!;
  const postService = Registry.whereis('post-service')!;
  const analytics = Registry.whereis('analytics')!;

  // Vytvoření uživatelů
  await GenServer.call(userService, { type: 'create', id: 'u1', name: 'Alice', email: 'alice@example.com' });
  await GenServer.call(userService, { type: 'create', id: 'u2', name: 'Bob', email: 'bob@example.com' });

  // Alice sleduje Boba
  await GenServer.call(userService, { type: 'follow', followerId: 'u1', followeeId: 'u2' });

  // Bob vytvoří příspěvek
  const post = await GenServer.call(postService, {
    type: 'create',
    id: 'p1',
    authorId: 'u2',
    content: 'Hello from Bob!',
  });

  // Sledování zobrazení (fire-and-forget)
  GenServer.cast(analytics, { type: 'trackView', postId: 'p1' });

  // Získání feedu pro Alice (příspěvky od sledovaných uživatelů)
  const following = await GenServer.call(userService, { type: 'getFollowing', userId: 'u1' });
  const feed = [];
  for (const authorId of following as string[]) {
    const posts = await GenServer.call(postService, { type: 'getByAuthor', authorId });
    feed.push(...(posts as any[]));
  }

  console.log('Feed Alice:', feed);
}
```

## Cvičení

Rozložte **notifikační systém** na procesy. Systém by měl podporovat:

1. Více notifikačních kanálů (email, SMS, push)
2. Uživatelské preference (které kanály chtějí)
3. Rate limiting (max 10 notifikací za hodinu per uživatel)
4. Renderování šablon (notifikační šablony)
5. Sledování doručení (odesláno, doručeno, selhalo)

Otázky k zodpovězení:
1. Jaké procesy potřebujete?
2. Které by měly být singletony vs. per-entity?
3. Jak komunikují?
4. Jaký je strom supervize?

<details>
<summary>Řešení</summary>

### Architektura procesů

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PROCESY NOTIFIKAČNÍHO SYSTÉMU                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. NotificationRouter (singleton)                                          │
│     - Přijímá požadavky na notifikace                                       │
│     - Kontroluje uživatelské preference                                     │
│     - Směruje na příslušný kanál                                            │
│                                                                             │
│  2. UserPreferencesService (singleton)                                      │
│     - Ukládá preference notifikací uživatelů                                │
│     - Odpovídá "které kanály pro tohoto uživatele?"                         │
│                                                                             │
│  3. RateLimiterService (singleton)                                          │
│     - Sleduje notifikace per uživatel                                       │
│     - Vrací allow/deny pro každou notifikaci                                │
│                                                                             │
│  4. TemplateService (singleton)                                             │
│     - Renderuje notifikační šablony                                         │
│     - Cachuje zkompilované šablony                                          │
│                                                                             │
│  5. EmailChannel (singleton)                                                │
│  6. SMSChannel (singleton)                                                  │
│  7. PushChannel (singleton)                                                 │
│     - Každý kanál zajišťuje své doručení                                    │
│     - Hlásí stav doručení                                                   │
│                                                                             │
│  8. DeliveryTracker (singleton)                                             │
│     - Zaznamenává všechny pokusy o notifikaci                               │
│     - Ukládá stav (pending/sent/delivered/failed)                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Strom supervize

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    STROM SUPERVIZE NOTIFIKACÍ                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                              ┌─────────────┐                                │
│                              │    Root     │ one_for_one                    │
│                              │  Supervisor │                                │
│                              └──────┬──────┘                                │
│              ┌──────────────────────┼──────────────────────┐               │
│              ▼                      ▼                      ▼               │
│       ┌─────────────┐        ┌─────────────┐        ┌─────────────┐        │
│       │   Core      │        │  Channels   │        │  Tracking   │        │
│       │ Supervisor  │        │ Supervisor  │        │  Supervisor │        │
│       │ one_for_one │        │ one_for_one │        │ one_for_one │        │
│       └──────┬──────┘        └──────┬──────┘        └──────┬──────┘        │
│         ┌────┴────┐            ┌────┼────┐                 │               │
│         ▼    ▼    ▼            ▼    ▼    ▼                 ▼               │
│      ┌────┐┌────┐┌────┐    ┌────┐┌────┐┌────┐        ┌──────────┐         │
│      │Rout││Pref││Tmpl│    │Mail││SMS ││Push│        │ Tracker  │         │
│      │ er ││ s  ││Svc │    │Chan││Chan││Chan│        │          │         │
│      └────┘└────┘└────┘    └────┘└────┘└────┘        └──────────┘         │
│        │                     ↑                              ↑              │
│        └─────────────────────┴───────hlásí stav─────────────┘              │
│                                                                             │
│  Zdůvodnění:                                                                │
│  • Core služby seskupené - router závisí na preferencích a šablonách       │
│  • Kanály seskupené - všechny doručovací mechanismy izolované spolu        │
│  • Tracker odděleně - sledování doručení může selhat bez vlivu na odesílání│
│  • one_for_one všude - služby jsou nezávislé v rámci skupin                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Náčrt implementace

```typescript
import { GenServer, Supervisor, Registry, type GenServerBehavior } from '@hamicek/noex';

// Typy
type Channel = 'email' | 'sms' | 'push';
type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed';

interface NotificationRequest {
  id: string;
  userId: string;
  templateId: string;
  data: Record<string, string>;
  channels?: Channel[]; // Přepsání uživatelských preferencí
}

// Router - vstupní bod pro notifikace
interface RouterState {
  pending: Map<string, NotificationRequest>;
}

type RouterCall = { type: 'send'; request: NotificationRequest };

const routerBehavior: GenServerBehavior<RouterState, RouterCall, never, boolean> = {
  init: () => ({ pending: new Map() }),

  async handleCall(msg, state) {
    if (msg.type === 'send') {
      const { request } = msg;

      // Kontrola rate limitu
      const rateLimiter = Registry.whereis('rate-limiter');
      if (rateLimiter) {
        const allowed = await GenServer.call(rateLimiter, {
          type: 'check',
          userId: request.userId,
        });
        if (!allowed) {
          return [false, state]; // Rate limited
        }
      }

      // Získání uživatelských preferencí (nebo použití přepsání)
      let channels = request.channels;
      if (!channels) {
        const prefs = Registry.whereis('preferences');
        if (prefs) {
          channels = await GenServer.call(prefs, {
            type: 'getChannels',
            userId: request.userId,
          }) as Channel[];
        }
      }
      channels = channels ?? ['email']; // Výchozí je email

      // Renderování šablony
      const templateSvc = Registry.whereis('templates');
      let content = request.data.message ?? '';
      if (templateSvc) {
        content = await GenServer.call(templateSvc, {
          type: 'render',
          templateId: request.templateId,
          data: request.data,
        }) as string;
      }

      // Odeslání na každý kanál
      for (const channel of channels) {
        const channelRef = Registry.whereis(`channel-${channel}`);
        if (channelRef) {
          GenServer.cast(channelRef, {
            type: 'deliver',
            notificationId: request.id,
            userId: request.userId,
            content,
          });
        }
      }

      return [true, state];
    }
    return [false, state];
  },

  handleCast: (_, state) => state,
};

// Delivery Tracker
interface TrackerState {
  notifications: Map<string, {
    id: string;
    userId: string;
    status: NotificationStatus;
    channel: Channel;
    timestamp: Date;
  }>;
}

type TrackerCall = { type: 'getStatus'; notificationId: string };
type TrackerCast = { type: 'record'; notificationId: string; userId: string; channel: Channel; status: NotificationStatus };

const trackerBehavior: GenServerBehavior<TrackerState, TrackerCall, TrackerCast, NotificationStatus | null> = {
  init: () => ({ notifications: new Map() }),

  handleCall(msg, state) {
    if (msg.type === 'getStatus') {
      const notification = state.notifications.get(msg.notificationId);
      return [notification?.status ?? null, state];
    }
    return [null, state];
  },

  handleCast(msg, state) {
    if (msg.type === 'record') {
      state.notifications.set(msg.notificationId, {
        id: msg.notificationId,
        userId: msg.userId,
        status: msg.status,
        channel: msg.channel,
        timestamp: new Date(),
      });
    }
    return state;
  },
};

// Spuštění notifikačního systému
async function startNotificationSystem() {
  // Core služby
  const coreSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'router', start: () => GenServer.start(routerBehavior, { name: 'router' }) },
      { id: 'preferences', start: () => GenServer.start(preferencesBehavior, { name: 'preferences' }) },
      { id: 'templates', start: () => GenServer.start(templateBehavior, { name: 'templates' }) },
      { id: 'rate-limiter', start: () => GenServer.start(rateLimiterBehavior, { name: 'rate-limiter' }) },
    ],
  });

  // Kanálové služby
  const channelsSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'email', start: () => GenServer.start(createChannelBehavior('email'), { name: 'channel-email' }) },
      { id: 'sms', start: () => GenServer.start(createChannelBehavior('sms'), { name: 'channel-sms' }) },
      { id: 'push', start: () => GenServer.start(createChannelBehavior('push'), { name: 'channel-push' }) },
    ],
  });

  // Tracking služba
  const trackingSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'tracker', start: () => GenServer.start(trackerBehavior, { name: 'tracker' }) },
    ],
  });

  return { coreSupervisor, channelsSupervisor, trackingSupervisor };
}
```

### Klíčová rozhodnutí návrhu

1. **Router je singleton**: Jediný vstupní bod pro všechny notifikace
2. **Kanály jsou singletony**: Každý kanál spravuje své vlastní spojení/stav
3. **Tracker je oddělen**: Selhání sledování by nemělo ovlivnit doručení
4. **Fire-and-forget do kanálů**: Router nečeká na doručení
5. **Kanály hlásí zpět**: Cast do trackeru se stavem doručení

</details>

## Shrnutí

- **Jeden proces = jedna zodpovědnost**: Proces by měl mít jeden důvod ke změně stavu
- **Položte si čtyři otázky** pro identifikaci hranic procesů:
  - Potřebuje nezávislý životní cyklus?
  - Má požadavky na konzistenci?
  - Může selhat nezávisle?
  - Je přistupován z více míst?
- **Pattern entita-per-proces** pro doménové objekty (uživatelé, objednávky, sessions)
- **Pattern singleton procesu** pro infrastrukturu (cache, rate limiter, config)
- **Vyhněte se anti-patternům sdíleného stavu**:
  - Žádné globální měnitelné proměnné
  - Žádné předávání stavu mezi funkcemi
  - Žádné sdílené reference mezi procesy
- **Veškerá modifikace stavu probíhá přes zprávy**: To je základní záruka

Mentální posun z "objektů a metod" na "procesy a zprávy" vyžaduje praxi. Začněte identifikací stavu ve vašem systému, pak se ptejte, které části potřebují izolaci. Když máte pochybnosti, přikloňte se k více procesům — jsou levné na vytvoření a snadno se kombinují pod supervisory.

---

Další: [Komunikace mezi procesy](./02-komunikace-mezi-procesy.md)
