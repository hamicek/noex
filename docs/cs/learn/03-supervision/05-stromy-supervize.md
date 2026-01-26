# Stromy supervize

Zatím jste se naučili, jak jeden supervisor spravuje své děti. Ale reálné aplikace potřebují více než jeden supervisor. **Stromy supervize** jsou hierarchie supervisorů, kde supervisoři mohou být dětmi jiných supervisorů. To vytváří stromovou strukturu, která vám dává jemnozrnnou kontrolu nad izolací selhání a zotavením.

## Co se naučíte

- Proč je plochá supervize omezující
- Budování hierarchií supervisorů
- Izolace failure domains
- Návrh stromů supervize pro reálné aplikace
- Praktické příklady s e-commerce a chat systémy

## Omezení ploché supervize

Představte si e-commerce aplikaci s těmito službami:

- UserService, SessionService (doména uživatelů)
- ProductService, InventoryService (doména katalogu)
- CartService, CheckoutService, PaymentService (doména objednávek)

S jedním plochým supervisorem:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PLOCHÁ SUPERVIZE (Omezená)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                              ┌─────────────┐                                │
│                              │  Supervisor │                                │
│                              └──────┬──────┘                                │
│            ┌───────┬───────┬───────┼───────┬───────┬───────┐               │
│            ▼       ▼       ▼       ▼       ▼       ▼       ▼               │
│         ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐           │
│         │User │ │Sess │ │Prod │ │Inv  │ │Cart │ │Check│ │Pay  │           │
│         └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘           │
│                                                                             │
│  Problémy:                                                                  │
│  • Všechny služby sdílejí stejné limity restart intenzity                   │
│  • Nelze použít různé strategie pro různé domény                            │
│  • Bug v CartService může vyčerpat restarty pro PaymentService              │
│  • Žádná izolace mezi nesouvisejícími failure domains                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Problém: Pokud má `CartService` bug, který způsobuje rychlé pády, může vyčerpat limit restart intenzity supervisoru. To shodí **celou aplikaci**, včetně zcela nesouvisejících služeb jako `UserService`.

## Stromy supervize: Hierarchická organizace

Řešením je organizovat supervisory do stromu:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      STROM SUPERVIZE (Izolovaný)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                              ┌─────────────┐                                │
│                              │    Root     │ strategie: one_for_one         │
│                              │  Supervisor │                                │
│                              └──────┬──────┘                                │
│              ┌──────────────────────┼──────────────────────┐               │
│              ▼                      ▼                      ▼               │
│       ┌─────────────┐        ┌─────────────┐        ┌─────────────┐        │
│       │    User     │        │   Catalog   │        │    Order    │        │
│       │  Supervisor │        │  Supervisor │        │  Supervisor │        │
│       └──────┬──────┘        └──────┬──────┘        └──────┬──────┘        │
│         ┌────┴────┐             ┌───┴───┐           ┌──────┼──────┐        │
│         ▼         ▼             ▼       ▼           ▼      ▼      ▼        │
│      ┌─────┐  ┌─────┐       ┌─────┐ ┌─────┐     ┌─────┐┌─────┐┌─────┐     │
│      │User │  │Sess │       │Prod │ │Inv  │     │Cart ││Check││Pay  │     │
│      └─────┘  └─────┘       └─────┘ └─────┘     └─────┘└─────┘└─────┘     │
│                                                                             │
│  Výhody:                                                                    │
│  • Každá doména má vlastní limity restart intenzity                         │
│  • Různé strategie pro různé domény (user: one_for_one, order: rest_for_one)│
│  • Pády CartService ovlivňují pouze OrderSupervisor                         │
│  • UserSupervisor a CatalogSupervisor běží normálně dál                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Nyní pády `CartService` vyčerpávají pouze limity restartů `OrderSupervisor`. I když celá doména Order spadne, uživatelé se stále mohou přihlásit a prohlížet produkty.

## Izolace Failure Domains

**Failure domain** je hranice, v rámci které jsou selhání omezena. Stromy supervize vám umožňují tyto hranice explicitně definovat.

### Principy návrhu Failure Domains

1. **Seskupte související procesy dohromady** - Služby, které na sobě závisí, by měly sdílet supervisor
2. **Oddělte nesouvisející domény** - Nezávislé subsystémy by měly mít oddělené supervisory
3. **Kritické vs nekritické** - Umístěte kritické služby pod konzervativnější supervisory
4. **Slaďte strategii se závislostmi** - Použijte `rest_for_one` pro sekvenční závislosti, `one_for_all` pro sdílený stav

### Co se stane, když supervisor selže?

Když supervisor překročí svou restart intenzitu a selže:

1. Selhávající supervisor se stane ukončeným dítětem svého rodiče
2. Rodičovský supervisor aplikuje svou restart strategii na selhavšího supervisora
3. Pokud rodič restartuje supervisor, všechna "vnoučata" začínají znovu

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       KASKÁDOVÉ ZOTAVENÍ ZE SELHÁNÍ                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Krok 1: CartService stále padá                                             │
│                                                                             │
│         ┌─────────────┐                                                     │
│         │    Order    │  restartIntensity: { maxRestarts: 3, withinMs: 5000 }
│         │  Supervisor │                                                     │
│         └──────┬──────┘                                                     │
│           ┌────┼────┐                                                       │
│           ▼    ▼    ▼                                                       │
│        ┌────┐ 💥  ┌────┐   CartService: pád, restart, pád, restart...      │
│        │Cart│     │Pay │                                                    │
│        └────┘     └────┘                                                    │
│                                                                             │
│  Krok 2: OrderSupervisor překročí limit restartů → vyhodí chybu             │
│                                                                             │
│         💥 ─────────────                                                    │
│         │    Order    │  MaxRestartsExceededError!                          │
│         │  Supervisor │                                                     │
│         └─────────────┘                                                     │
│                                                                             │
│  Krok 3: Root supervisor vidí OrderSupervisor jako spadlé dítě              │
│          Aplikuje one_for_one: restartuje pouze OrderSupervisor             │
│                                                                             │
│         ┌─────────────┐                                                     │
│         │    Root     │  Restartuje OrderSupervisor                         │
│         │  Supervisor │                                                     │
│         └──────┬──────┘                                                     │
│           ┌────┴────┐                                                       │
│         ┌────┐   ┌─────┐                                                    │
│         │User│   │Order│ ← Čerstvý start s resetovanými čítači restartů    │
│         │Sup │   │Sup' │                                                    │
│         └────┘   └─────┘                                                    │
│                                                                             │
│  Výsledek: User doména neovlivněna, Order doména dostává čerstvý restart   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Budování stromu supervize v kódu

Zde je implementace víceúrovňového stromu supervize:

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from '@hamicek/noex';

// Jednoduchá factory pro chování služby
const createServiceBehavior = (name: string): GenServerBehavior<{ name: string }, { type: 'ping' }, never, string> => ({
  init() {
    console.log(`[${name}] Spuštěn`);
    return { name };
  },
  handleCall(msg, state) {
    if (msg.type === 'ping') {
      return [`pong z ${state.name}`, state];
    }
    return ['', state];
  },
  handleCast: (_, state) => state,
  terminate() {
    console.log(`[${this.name}] Ukončen`);
  },
});

async function buildEcommerceTree() {
  // Úroveň 2: Doménové supervisory (listy stromu)

  // User doména - nezávislé služby
  const userSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 5, withinMs: 10000 },
    children: [
      { id: 'user-service', start: () => GenServer.start(createServiceBehavior('UserService')) },
      { id: 'session-service', start: () => GenServer.start(createServiceBehavior('SessionService')) },
    ],
  });

  // Catalog doména - nezávislé služby
  const catalogSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 5, withinMs: 10000 },
    children: [
      { id: 'product-service', start: () => GenServer.start(createServiceBehavior('ProductService')) },
      { id: 'inventory-service', start: () => GenServer.start(createServiceBehavior('InventoryService')) },
    ],
  });

  // Order doména - sekvenční závislosti (Cart → Checkout → Payment)
  const orderSupervisor = await Supervisor.start({
    strategy: 'rest_for_one', // Pokud Cart selže, restartovat Checkout a Payment také
    restartIntensity: { maxRestarts: 3, withinMs: 5000 }, // Přísnější pro kritickou cestu
    children: [
      { id: 'cart-service', start: () => GenServer.start(createServiceBehavior('CartService')) },
      { id: 'checkout-service', start: () => GenServer.start(createServiceBehavior('CheckoutService')) },
      { id: 'payment-service', start: () => GenServer.start(createServiceBehavior('PaymentService')) },
    ],
  });

  // Úroveň 1: Root supervisor
  // Obaluje doménové supervisory v GenServer adapterech (supervisory nejsou přímo děti)
  const rootSupervisor = await Supervisor.start({
    strategy: 'one_for_one', // Domény jsou nezávislé
    restartIntensity: { maxRestarts: 10, withinMs: 60000 }, // Velmi tolerantní na rootu
    children: [
      {
        id: 'user-domain',
        start: () => createSupervisorWrapper('UserDomain', userSupervisor),
      },
      {
        id: 'catalog-domain',
        start: () => createSupervisorWrapper('CatalogDomain', catalogSupervisor),
      },
      {
        id: 'order-domain',
        start: () => createSupervisorWrapper('OrderDomain', orderSupervisor),
      },
    ],
  });

  console.log('\nE-commerce strom supervize spuštěn:');
  console.log('├── UserDomain (one_for_one)');
  console.log('│   ├── UserService');
  console.log('│   └── SessionService');
  console.log('├── CatalogDomain (one_for_one)');
  console.log('│   ├── ProductService');
  console.log('│   └── InventoryService');
  console.log('└── OrderDomain (rest_for_one)');
  console.log('    ├── CartService');
  console.log('    ├── CheckoutService');
  console.log('    └── PaymentService');

  return rootSupervisor;
}

// Helper: Obaluje supervisor v GenServer pro rodičovského supervisora
function createSupervisorWrapper(name: string, childSupervisor: Awaited<ReturnType<typeof Supervisor.start>>) {
  return GenServer.start<{ supervisor: typeof childSupervisor }, { type: 'getSupervisor' }, never, typeof childSupervisor>({
    init() {
      return { supervisor: childSupervisor };
    },
    handleCall(msg, state) {
      if (msg.type === 'getSupervisor') {
        return [state.supervisor, state];
      }
      return [state.supervisor, state];
    },
    handleCast: (_, state) => state,
    async terminate() {
      // Když wrapper skončí, zastavit child supervisor
      await Supervisor.stop(childSupervisor);
      console.log(`[${name}] Doménový supervisor zastaven`);
    },
  });
}

async function main() {
  const root = await buildEcommerceTree();

  // Nechat chvíli běžet
  await new Promise(resolve => setTimeout(resolve, 100));

  // Graceful shutdown - zastaví všechny domény
  await Supervisor.stop(root);
  console.log('\nVšechny služby gracefully zastaveny');
}

main();
```

## Praktický příklad: Chat aplikace

Navrhněme strom supervize pro chat aplikaci s:
- Uživatelskými připojeními (WebSocket handlery)
- Chat místnostmi
- Persistencí zpráv
- Push notifikacemi

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     STROM SUPERVIZE CHAT APLIKACE                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                              ┌─────────────┐                                │
│                              │    Root     │ one_for_one                    │
│                              │  Supervisor │ 10 restartů / 60s              │
│                              └──────┬──────┘                                │
│              ┌──────────────────────┼──────────────────────┐               │
│              ▼                      ▼                      ▼               │
│       ┌─────────────┐        ┌─────────────┐        ┌─────────────┐        │
│       │ Connection  │        │    Room     │        │   Backend   │        │
│       │  Supervisor │        │  Supervisor │        │  Supervisor │        │
│       │simple_one_  │        │simple_one_  │        │ rest_for_one│        │
│       │  for_one    │        │  for_one    │        │             │        │
│       └──────┬──────┘        └──────┬──────┘        └──────┬──────┘        │
│         ┌────┼────┐             ┌───┴───┐              ┌───┴───┐           │
│         ▼    ▼    ▼             ▼       ▼              ▼       ▼           │
│      ┌────┐┌────┐┌────┐     ┌─────┐ ┌─────┐       ┌─────┐ ┌─────┐         │
│      │WS1 ││WS2 ││WS3 │     │Room1│ │Room2│       │ DB  │ │Push │         │
│      └────┘└────┘└────┘     └─────┘ └─────┘       │Svc  │ │Svc  │         │
│       (dynamické)           (dynamické)           └─────┘ └─────┘         │
│                                                                             │
│  Designová rozhodnutí:                                                      │
│                                                                             │
│  ConnectionSupervisor: simple_one_for_one                                   │
│  • Dynamické děti (jedno na WebSocket)                                      │
│  • Vysoká tolerance restartů (připojení jsou přechodná)                     │
│  • Každé připojení izolované                                                │
│                                                                             │
│  RoomSupervisor: simple_one_for_one                                         │
│  • Dynamické děti (místnosti vytvářeny na vyžádání)                         │
│  • Střední tolerance restartů                                               │
│  • Pád místnosti neovlivní ostatní místnosti                                │
│                                                                             │
│  BackendSupervisor: rest_for_one                                            │
│  • Statické děti se závislostmi                                             │
│  • PushService závisí na DBService (pro tokeny uživatelů)                   │
│  • Nižší tolerance restartů (kritické služby)                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Implementace

```typescript
import { Supervisor, GenServer, type GenServerBehavior, type ChildTemplate } from '@hamicek/noex';

// Connection handler pro každý WebSocket
interface ConnectionState {
  connectionId: string;
  userId: string;
}

type ConnectionCall = { type: 'send'; message: string } | { type: 'getUser' };
type ConnectionCast = { type: 'received'; message: string };

// Factory funkce, která vytvoří chování s zachyceným stavem
const createConnectionBehavior = (
  connectionId: string,
  userId: string
): GenServerBehavior<ConnectionState, ConnectionCall, ConnectionCast, string> => ({
  init() {
    console.log(`[Connection ${connectionId}] Uživatel ${userId} připojen`);
    return { connectionId, userId };
  },
  handleCall(msg, state) {
    if (msg.type === 'send') {
      console.log(`[Connection ${state.connectionId}] Odesílám: ${msg.message}`);
      return ['odesláno', state];
    }
    if (msg.type === 'getUser') {
      return [state.userId, state];
    }
    return ['', state];
  },
  handleCast(msg, state) {
    if (msg.type === 'received') {
      console.log(`[Connection ${state.connectionId}] Přijato: ${msg.message}`);
    }
    return state;
  },
  terminate() {
    console.log(`[Connection] Odpojeno`);
  },
});

// Chat místnost
interface RoomState {
  roomId: string;
  members: Set<string>;
}

type RoomCall = { type: 'join'; userId: string } | { type: 'leave'; userId: string } | { type: 'getMembers' };
type RoomCast = { type: 'broadcast'; message: string; from: string };

// Factory funkce, která vytvoří chování místnosti se zachyceným roomId
const createRoomBehavior = (roomId: string): GenServerBehavior<RoomState, RoomCall, RoomCast, string[] | boolean> => ({
  init() {
    console.log(`[Room ${roomId}] Vytvořena`);
    return { roomId, members: new Set() };
  },
  handleCall(msg, state) {
    if (msg.type === 'join') {
      state.members.add(msg.userId);
      console.log(`[Room ${state.roomId}] ${msg.userId} vstoupil (${state.members.size} členů)`);
      return [true, state];
    }
    if (msg.type === 'leave') {
      state.members.delete(msg.userId);
      console.log(`[Room ${state.roomId}] ${msg.userId} odešel (${state.members.size} členů)`);
      return [true, state];
    }
    if (msg.type === 'getMembers') {
      return [Array.from(state.members), state];
    }
    return [[], state];
  },
  handleCast(msg, state) {
    if (msg.type === 'broadcast') {
      console.log(`[Room ${state.roomId}] ${msg.from}: ${msg.message}`);
      // V reálné aplikaci by se odeslalo všem členským připojením
    }
    return state;
  },
  terminate() {
    console.log(`[Room] Uzavřena`);
  },
});

// Backend služby
const createBackendService = (name: string): GenServerBehavior<{ name: string }, { type: 'health' }, never, string> => ({
  init() {
    console.log(`[${name}] Spuštěn`);
    return { name };
  },
  handleCall(msg, state) {
    if (msg.type === 'health') {
      return ['healthy', state];
    }
    return ['', state];
  },
  handleCast: (_, state) => state,
  terminate() {
    console.log(`[${this.name}] Zastaven`);
  },
});

async function buildChatTree() {
  // Connection supervisor - dynamické děti přes simple_one_for_one
  const connectionSupervisor = await Supervisor.start({
    strategy: 'simple_one_for_one',
    restartIntensity: { maxRestarts: 100, withinMs: 60000 }, // Velmi tolerantní
    childTemplate: {
      start: (connectionId: string, userId: string) =>
        GenServer.start(createConnectionBehavior(connectionId, userId)),
      restart: 'transient', // Nerestartovat při normálním odpojení uživatele
    },
  });

  // Room supervisor - dynamické děti přes simple_one_for_one
  const roomSupervisor = await Supervisor.start({
    strategy: 'simple_one_for_one',
    restartIntensity: { maxRestarts: 20, withinMs: 60000 },
    childTemplate: {
      start: (roomId: string) => GenServer.start(createRoomBehavior(roomId)),
      restart: 'permanent',
    },
  });

  // Backend supervisor - statické děti se závislostmi
  const backendSupervisor = await Supervisor.start({
    strategy: 'rest_for_one', // PushService závisí na DBService
    restartIntensity: { maxRestarts: 5, withinMs: 30000 },
    children: [
      { id: 'db-service', start: () => GenServer.start(createBackendService('DBService')) },
      { id: 'push-service', start: () => GenServer.start(createBackendService('PushService')) },
    ],
  });

  // Root supervisor
  const rootSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 10, withinMs: 60000 },
    children: [
      {
        id: 'connections',
        start: () => createSupervisorWrapper('Connections', connectionSupervisor),
      },
      {
        id: 'rooms',
        start: () => createSupervisorWrapper('Rooms', roomSupervisor),
      },
      {
        id: 'backend',
        start: () => createSupervisorWrapper('Backend', backendSupervisor),
      },
    ],
  });

  // Simulace některých připojení a místností
  await Supervisor.startChild(connectionSupervisor, ['ws_1', 'alice']);
  await Supervisor.startChild(connectionSupervisor, ['ws_2', 'bob']);
  await Supervisor.startChild(roomSupervisor, ['general']);
  await Supervisor.startChild(roomSupervisor, ['random']);

  return { rootSupervisor, connectionSupervisor, roomSupervisor, backendSupervisor };
}

// Helper funkce (stejná jako dříve)
function createSupervisorWrapper(name: string, childSupervisor: Awaited<ReturnType<typeof Supervisor.start>>) {
  return GenServer.start({
    init: () => ({ supervisor: childSupervisor }),
    handleCall: (_, state) => [state.supervisor, state],
    handleCast: (_, state) => state,
    async terminate() {
      await Supervisor.stop(childSupervisor);
    },
  });
}

async function main() {
  const { rootSupervisor } = await buildChatTree();

  console.log('\nStrom supervize chatu běží...');
  await new Promise(resolve => setTimeout(resolve, 100));

  await Supervisor.stop(rootSupervisor);
  console.log('\nChat server zastaven');
}

main();
```

## Doporučení pro návrh stromů supervize

### 1. Hloubka stromu

| Hloubka | Použití |
|---------|---------|
| 1 úroveň | Malé aplikace, mikroslužby |
| 2 úrovně | Střední aplikace s odlišnými doménami |
| 3+ úrovní | Velké aplikace s komplexními hierarchiemi |

Nepřehánějte to - začněte jednoduše a přidávejte hloubku podle potřeby.

### 2. Volba strategií na každé úrovni

| Úroveň | Typická strategie | Důvod |
|--------|------------------|-------|
| Root | `one_for_one` | Domény jsou obvykle nezávislé |
| Doména | Záleží | Závisí na vztazích služeb |
| List | `one_for_one` nebo `simple_one_for_one` | Jednotliví workers |

### 3. Doporučení pro restart intenzitu

| Úroveň | Typické nastavení | Důvod |
|--------|------------------|-------|
| Root | Vysoká tolerance (10+ restartů / 60s) | Vyhnout se totálnímu selhání systému |
| Doména | Střední (5-10 restartů / 30s) | Umožnit zotavení, ale detekovat perzistentní problémy |
| List | Závisí na kritičnosti služby | Odpovídat charakteristikám služby |

### 4. Běžné vzory

**Worker Pool vzor:**
```
Supervisor (simple_one_for_one)
├── Worker 1
├── Worker 2
└── Worker N (dynamické)
```

**Pipeline vzor:**
```
Supervisor (rest_for_one)
├── Stage 1 (Zdroj)
├── Stage 2 (Transformace)
└── Stage 3 (Cíl)
```

**Hub and Spoke vzor:**
```
Supervisor (one_for_all)
├── Hub (koordinátor)
├── Spoke 1 (závisí na hub)
├── Spoke 2 (závisí na hub)
└── Spoke 3 (závisí na hub)
```

## Cvičení

Navrhněte strom supervize pro real-time multiplayerový herní server s:

1. **Hráčská připojení** - Jeden proces na připojeného hráče
2. **Herní lobby** - Dynamické lobby, kde hráči čekají na zápasy
3. **Herní instance** - Aktivní hry s více hráči
4. **Matchmaking služba** - Páruje hráče do her
5. **Leaderboard služba** - Sleduje skóre (závisí na databázové službě)
6. **Databázová služba** - Persistuje herní data

Požadavky:
- Odpojení hráče by nemělo ovlivnit ostatní hráče
- Padající hra by neměla ovlivnit lobby
- Matchmaking a Leaderboard jsou nezávislé, ale oba potřebují databázi
- Pokud databáze spadne, Matchmaking i Leaderboard by se měly restartovat

Nakreslete strom supervize a vysvětlete svá rozhodnutí.

<details>
<summary>Řešení</summary>

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       STROM SUPERVIZE HERNÍHO SERVERU                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                              ┌─────────────┐                                │
│                              │    Root     │ one_for_one                    │
│                              │  Supervisor │ 10 restartů / 60s              │
│                              └──────┬──────┘                                │
│       ┌──────────────┬──────────────┼──────────────┬─────────────┐         │
│       ▼              ▼              ▼              ▼             ▼         │
│ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐     │
│ │  Player   │ │  Lobby    │ │   Game    │ │  Backend  │ │ Database  │     │
│ │Supervisor │ │Supervisor │ │Supervisor │ │Supervisor │ │ Wrapper   │     │
│ │simple_1_1 │ │simple_1_1 │ │simple_1_1 │ │one_for_all│ │           │     │
│ └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └───────────┘     │
│   ┌───┴───┐     ┌───┴───┐     ┌───┴───┐     ┌───┴───┐                     │
│   ▼   ▼   ▼     ▼   ▼   ▼     ▼   ▼   ▼     ▼       ▼                     │
│ ┌───┐───┐───┐ ┌───┐───┐───┐ ┌───┐───┐───┐ ┌─────┐┌─────┐                  │
│ │P1 │P2 │...│ │L1 │L2 │...│ │G1 │G2 │...│ │Match││Lead │                  │
│ └───┘───┘───┘ └───┘───┘───┘ └───┘───┘───┘ │make ││board│                  │
│  (dynamické)  (dynamické)   (dynamické)   └─────┘└─────┘                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Designová rozhodnutí:**

1. **PlayerSupervisor (simple_one_for_one)**
   - Dynamické děti pro každého připojeného hráče
   - Vysoká tolerance restartů - připojení jsou přechodná
   - `transient` restart strategie - nerestartovat při normálním odpojení

2. **LobbySupervisor (simple_one_for_one)**
   - Dynamické lobby vytvářené na vyžádání
   - Střední tolerance restartů
   - Pád lobby neovlivní probíhající hry

3. **GameSupervisor (simple_one_for_one)**
   - Dynamické herní instance
   - Každá hra je izolovaná
   - Pád hry ovlivní pouze hráče v té hře

4. **BackendSupervisor (one_for_all)**
   - Obsahuje Matchmaking a Leaderboard
   - Oba závisí na databázi přes lookup
   - Pokud některý selže, oba se restartují pro resynchronizaci stavu

5. **Database jako samostatné dítě Root**
   - Nezávislá na Backend supervisoru
   - Pokud DB spadne, Backend to vidí přes selhání Registry lookup
   - Backend služby mohou elegantně řešit nedostupnost DB

**Alternativa: Pokud pád DB MUSÍ restartovat Backend:**

```
BackendSupervisor (rest_for_one)
├── DatabaseService
├── MatchmakingService
└── LeaderboardService
```

To zajistí, že pád DB restartuje obě služby, které na ní závisí.

**Náčrt implementace:**

```typescript
async function buildGameTree() {
  // Dynamické supervisory pro přechodné entity
  const playerSupervisor = await Supervisor.start({
    strategy: 'simple_one_for_one',
    restartIntensity: { maxRestarts: 100, withinMs: 60000 },
    childTemplate: {
      start: (playerId: string, socket: unknown) =>
        GenServer.start(playerBehavior, { playerId, socket }),
      restart: 'transient',
    },
  });

  const lobbySupervisor = await Supervisor.start({
    strategy: 'simple_one_for_one',
    restartIntensity: { maxRestarts: 20, withinMs: 30000 },
    childTemplate: {
      start: (lobbyId: string) => GenServer.start(lobbyBehavior, { lobbyId }),
      restart: 'permanent',
    },
  });

  const gameSupervisor = await Supervisor.start({
    strategy: 'simple_one_for_one',
    restartIntensity: { maxRestarts: 20, withinMs: 30000 },
    childTemplate: {
      start: (gameId: string, players: string[]) =>
        GenServer.start(gameBehavior, { gameId, players }),
      restart: 'permanent',
    },
  });

  // Backend se sdílenou databázovou závislostí
  const backendSupervisor = await Supervisor.start({
    strategy: 'one_for_all', // Resync při jakémkoli selhání
    restartIntensity: { maxRestarts: 5, withinMs: 30000 },
    children: [
      { id: 'matchmaking', start: () => GenServer.start(matchmakingBehavior) },
      { id: 'leaderboard', start: () => GenServer.start(leaderboardBehavior) },
    ],
  });

  // Root sestavuje všechny domény
  const rootSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    restartIntensity: { maxRestarts: 10, withinMs: 60000 },
    children: [
      { id: 'database', start: () => GenServer.start(databaseBehavior, { name: 'database' }) },
      { id: 'players', start: () => wrapSupervisor(playerSupervisor) },
      { id: 'lobbies', start: () => wrapSupervisor(lobbySupervisor) },
      { id: 'games', start: () => wrapSupervisor(gameSupervisor) },
      { id: 'backend', start: () => wrapSupervisor(backendSupervisor) },
    ],
  });

  return rootSupervisor;
}
```

</details>

## Shrnutí

- **Stromy supervize** organizují supervisory hierarchicky pro lepší izolaci selhání
- **Plochá supervize** nutí všechny služby sdílet limity restartů a strategie
- **Failure domains** jsou hranice, které omezují selhání - navrhujte je záměrně
- **Když supervisor selže**, jeho rodič aplikuje svou restart strategii
- **Doporučení pro návrh**:
  - Seskupte související služby pod stejný supervisor
  - Použijte `one_for_one` na rootu pro nezávislé domény
  - Slaďte strategie se vzory závislostí v doménách
  - Nastavte restart intenzitu na základě kritičnosti a úrovně
- **Běžné vzory**: Worker Pool, Pipeline, Hub and Spoke
- **Začněte jednoduše** - přidávejte hloubku do stromu pouze když je potřeba

Stromy supervize jsou páteří fault-tolerantních noex aplikací. Umožňují vám uvažovat o selhání na vysoké úrovni: "Pokud Order doména selže, uživatelé stále mohou prohlížet produkty." To je síla filozofie "let it crash" podpořená správnou supervizí.

---

Další: [Mapování problémů](../04-thinking-in-processes/01-mapping-problems.md)
