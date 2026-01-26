# Proč noex?

Budování robustních, stavových Node.js aplikací je těžší, než by mělo být. Pokud jste bojovali s race conditions, snažili se elegantně zotavit z pádů, nebo strávili hodiny debugováním problémů se sdíleným stavem, nejste sami.

noex přináší osvědčené řešení těchto problémů: actor model, prověřený více než 40 lety v Erlang/OTP systémech, které pohánějí vše od WhatsApp po telekomunikační infrastrukturu.

## Co se naučíte

- Proč tradiční Node.js vzory selhávají u stavových aplikací
- Co dělá actor model zásadně odlišným
- Jak Erlang/OTP prokázal tyto vzory v masivním měřítku
- Proč noex přináší tyto koncepty do TypeScriptu

## Problémy

### Sdílený stav vede k chaosu

Zvažte typický Node.js vzor pro správu uživatelských sessions:

```typescript
// Sdílený stav - recept na problémy
const sessions = new Map<string, UserSession>();

async function handleRequest(userId: string) {
  let session = sessions.get(userId);

  if (!session) {
    session = await loadFromDatabase(userId);
    sessions.set(userId, session);
  }

  // Co když jiný request právě teď modifikuje session?
  session.lastAccess = Date.now();
  session.requestCount++;

  // V době ukládání může být stav nekonzistentní
  await saveToDatabase(session);
}
```

Více souběžných requestů pro stejného uživatele se může prokládat, což vede ke ztraceným aktualizacím, nekonzistentnímu stavu a subtilním bugům, které se projeví pouze pod zátěží.

### Race conditions jsou všude

Event loop vás nechrání před logickými race conditions:

```typescript
async function transferFunds(from: string, to: string, amount: number) {
  const fromAccount = await getAccount(from);
  const toAccount = await getAccount(to);

  // NEBEZPEČÍ: Jiný transfer může modifikovat tyto účty
  // mezi naším čtením a zápisem

  if (fromAccount.balance >= amount) {
    fromAccount.balance -= amount;
    toAccount.balance += amount;

    await saveAccount(fromAccount);
    await saveAccount(toAccount);
  }
}
```

Každý `await` je potenciální bod prokládání. Tradiční řešení zahrnují komplexní zamykací mechanismy, které jsou náchylné k chybám a škodí výkonu.

### Error handling se stává nezvladatelným

Reálné aplikace potřebují ošetřit selhání na každé úrovni:

```typescript
async function processOrder(order: Order) {
  try {
    const inventory = await checkInventory(order.items);
    try {
      const payment = await processPayment(order);
      try {
        await updateInventory(order.items);
        try {
          await sendConfirmation(order);
        } catch (emailError) {
          // Notifikace selhala, ale objednávka proběhla - zalogovat a pokračovat?
          // Nebo bychom měli opakovat? Kolikrát?
        }
      } catch (inventoryError) {
        // Potřebujeme vrátit platbu
        await refundPayment(payment);
        throw inventoryError;
      }
    } catch (paymentError) {
      // Platba selhala - uvolnit rezervaci inventáře
      await releaseInventory(inventory);
      throw paymentError;
    }
  } catch (error) {
    // V jakém stavu je teď systém?
    // Dokončili jsme částečně?
    // Jak se zotavíme?
  }
}
```

Tato pyramida error handlingu je křehká. Vynechání catch někde poškodí stav systému. A když neošetřená výjimka shodí proces, ztratíte vše v paměti.

## Řešení: Actor model

Actor model přistupuje k problému radikálně jinak. Místo sdíleného stavu a komplexního error handlingu poskytuje tři jednoduché principy:

### 1. Izolovaný stav

Každý actor (nazývaný "proces" v noex) vlastní svůj stav výhradně. Žádný jiný kód k němu nemá přímý přístup ani ho nemůže modifikovat:

```typescript
// Každý counter je kompletně izolovaný
const counter = await GenServer.start({
  init: () => ({ count: 0 }),

  handleCall(msg, state) {
    if (msg.type === 'get') {
      return [state.count, state];
    }
    if (msg.type === 'increment') {
      const newState = { count: state.count + 1 };
      return [newState.count, newState];
    }
    return [null, state];
  },

  handleCast(msg, state) {
    return state;
  },
});
```

### 2. Předávání zpráv

Jediný způsob interakce s actorem je prostřednictvím zpráv. Zprávy jsou zpracovávány jedna po druhé, čímž se eliminují race conditions:

```typescript
// Synchronní call - čeká na odpověď
const count = await GenServer.call(counter, { type: 'get' });

// Asynchronní cast - fire and forget
GenServer.cast(counter, { type: 'log', message: 'Něco se stalo' });
```

Protože zprávy jsou zpracovávány sekvenčně, příklad s transferem se stává triviálním:

```typescript
// Všechny operace na účtu jsou serializované - žádné race conditions
const result = await GenServer.call(accountServer, {
  type: 'transfer',
  from: 'alice',
  to: 'bob',
  amount: 100,
});
```

### 3. Let it crash

Místo defenzivního error handlingu všude, actors přijímají selhání:

- Pokud actor spadne, je automaticky restartován supervisorem
- Spadlý actor ztratí pouze svůj in-memory stav
- Ostatní actors pokračují v běhu neovlivněni
- Systém se samo-opravuje bez manuálního zásahu

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    {
      id: 'payment-processor',
      start: () => GenServer.start(paymentBehavior),
      restart: 'permanent', // Vždy restartovat při pádu
    },
    {
      id: 'email-service',
      start: () => GenServer.start(emailBehavior),
      restart: 'transient', // Restartovat pouze při chybách, ne při normálním ukončení
    },
  ],
});
```

## Tradiční Node.js vs Actor model

Následující diagram ilustruje zásadní rozdíl mezi tradičním programováním se sdíleným stavem a actor modelem:

```text
┌─────────────────────────────────────────┐  ┌─────────────────────────────────────────┐
│       TRADIČNÍ NODE.JS                  │  │           ACTOR MODEL (noex)            │
├─────────────────────────────────────────┤  ├─────────────────────────────────────────┤
│                                         │  │                                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
│  │Request 1│  │Request 2│  │Request 3│  │  │  │Request 1│  │Request 2│  │Request 3│  │
│  └────┬────┘  └────┬────┘  └────┬────┘  │  │  └────┬────┘  └────┬────┘  └────┬────┘  │
│       │            │            │       │  │       │            │            │       │
│       ▼            ▼            ▼       │  │       ▼            ▼            ▼       │
│  ┌──────────────────────────────────┐   │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
│  │                                  │   │  │  │ Proces  │  │ Proces  │  │ Proces  │  │
│  │         SDÍLENÝ STAV            │   │  │  │    A    │  │    B    │  │    C    │  │
│  │     ┌─────────────────┐         │   │  │  │ ┌─────┐ │  │ ┌─────┐ │  │ ┌─────┐ │  │
│  │     │   users: Map    │ ◄───────┼───│  │  │ │stav │ │  │ │stav │ │  │ │stav │ │  │
│  │     │   sessions: {}  │         │   │  │  │ └─────┘ │  │ └─────┘ │  │ └─────┘ │  │
│  │     │   orders: []    │         │   │  │  │ privát. │  │ privát. │  │ privát. │  │
│  │     └─────────────────┘         │   │  │  └────┬────┘  └────┬────┘  └────┬────┘  │
│  │                                  │   │  │       │            │            │       │
│  └──────────────────────────────────┘   │  │       └──────┬─────┴────────────┘       │
│                                         │  │              │                          │
│  Problémy:                              │  │              ▼                          │
│  ✗ Race conditions při každém await     │  │     ┌────────────────┐                  │
│  ✗ Stav poškozený souběžným přístupem   │  │     │    ZPRÁVY      │                  │
│  ✗ Pády ztrácí všechna in-memory data   │  │     │  (call/cast)   │                  │
│  ✗ Komplexní error handling všude       │  │     └────────────────┘                  │
│                                         │  │                                         │
│                                         │  │  Výhody:                                │
│  ┌──────────────────────────────────┐   │  │  ✓ Žádné race conditions (sekv. zprávy) │
│  │          ERROR HANDLING          │   │  │  ✓ Izolovaný stav (žádná sdíl. paměť)  │
│  │  try {                           │   │  │  ✓ Pád = restart s čistým stavem       │
│  │    try {                         │   │  │  ✓ Jednoduchý kód (let it crash)       │
│  │      try {                       │   │  │                                         │
│  │        // pyramida zkázy         │   │  │  ┌──────────────────────────────────┐   │
│  │      } catch...                  │   │  │  │         SUPERVISOR               │   │
│  │    } catch...                    │   │  │  │  ┌───┐   ┌───┐   ┌───┐          │   │
│  │  } catch...                      │   │  │  │  │ A │   │ B │   │ C │ ◄─ auto  │   │
│  └──────────────────────────────────┘   │  │  │  └───┘   └───┘   └───┘   restart│   │
│                                         │  │  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘  └─────────────────────────────────────────┘
```

**Klíčový vhled**: V actor modelu každý proces vlastní svůj stav výhradně. Komunikace probíhá pouze prostřednictvím zpráv, které jsou zpracovávány jedna po druhé. To eliminuje celé kategorie bugů.

## Erlang/OTP: 40 let prověření bojem

Tyto vzory nejsou teoretické. Pocházejí z Erlangu, jazyka navrženého v 80. letech pro telekomunikační systémy, které vyžadovaly:

- **99,9999999% dostupnost** (devět devítek - méně než 32 milisekund výpadku za rok)
- **Hot code upgrades** bez přerušení hovorů
- **Obsluhu milionů souběžných spojení**

Dnes Erlang a jeho vzory pohánějí:

- **WhatsApp**: 2 miliardy uživatelů, 100+ miliard zpráv denně, ~50 inženýrů
- **Discord**: Miliony souběžných voice/chat uživatelů
- **Ericsson**: 40%+ globálního telekomunikačního provozu
- **RabbitMQ, CouchDB, Riak**: Průmyslově standardní distribuované systémy

Actor model není pouze elegantní - je prověřený v měřítkách, která by tradiční architektury zničila.

## noex = OTP pro TypeScript

noex přináší tyto prověřené vzory do TypeScript ekosystému:

| Erlang/OTP | noex |
|------------|------|
| `gen_server` | `GenServer` |
| `supervisor` | `Supervisor` |
| `gen_statem` | `GenStateMachine` |
| ETS tables | `ETS` |
| `application` | `Application` |
| Registry | `Registry` |

Získáte spolehlivost Erlang vzorů s developer experience TypeScriptu:

- Plná typová bezpečnost pro zprávy a stav
- Známá async/await syntaxe
- Funguje s vaším existujícím Node.js ekosystémem
- Žádný nový runtime nebo jazyk k naučení

```typescript
import { GenServer, Supervisor, type GenServerBehavior } from 'noex';

interface State {
  users: Map<string, User>;
}

type CallMsg =
  | { type: 'get'; id: string }
  | { type: 'create'; user: User };

type CastMsg = { type: 'log'; message: string };
type Reply = User | null;

const userServiceBehavior: GenServerBehavior<State, CallMsg, CastMsg, Reply> = {
  init: () => ({ users: new Map() }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.users.get(msg.id) ?? null, state];
      case 'create':
        state.users.set(msg.user.id, msg.user);
        return [msg.user, state];
    }
  },

  handleCast(msg, state) {
    console.log(`[UserService] ${msg.message}`);
    return state;
  },
};

// Start se supervizí
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'users', start: () => GenServer.start(userServiceBehavior) },
  ],
});
```

## Shrnutí

- Tradiční Node.js vzory zápasí se sdíleným stavem, race conditions a error handlingem
- Actor model řeší tyto problémy prostřednictvím izolovaného stavu, předávání zpráv a filozofie "let it crash"
- Erlang/OTP prokázal tyto vzory v masivním měřítku za více než 40 let
- noex přináší OTP vzory do TypeScriptu s plnou typovou bezpečností a známou syntaxí

Výsledek: aplikace, které se snadněji pochopí, lépe debugují a jsou odolné již od návrhu.

---

Další: [Klíčové koncepty](./02-klicove-koncepty.md)
