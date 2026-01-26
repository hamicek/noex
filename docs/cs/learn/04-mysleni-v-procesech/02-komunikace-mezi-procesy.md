# Komunikace mezi procesy

Procesy jsou designově izolované — nesdílejí stav. Tato izolace je základem odolnosti proti chybám. Ale izolované procesy stále potřebují spolupracovat. Tato kapitola prozkoumává tři základní komunikační mechanismy v noex.

## Co se naučíte

- Přímá komunikace s `call()` a `cast()` — kdy a proč
- Vyhledávání s Registry — nalezení procesů podle jména
- Pub/sub s EventBus — oddělené vysílání
- Výběr správného komunikačního patternu pro váš případ použití
- Budování komunikačních topologií

## Tři komunikační mechanismy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    KOMUNIKACE MEZI PROCESY                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. PŘÍMÁ (call/cast)          2. REGISTRY              3. EVENTBUS        │
│  ──────────────────            ────────                 ────────            │
│                                                                             │
│  ┌─────┐    call    ┌─────┐    ┌─────┐  lookup  ┌───┐   ┌───┐   pub   ┌───┐│
│  │  A  │───────────▶│  B  │    │  A  │─────────▶│ R │   │ A │────────▶│Bus││
│  └─────┘◀───reply───└─────┘    └─────┘          │ e │   └───┘         └─┬─┘│
│                                      ▼          │ g │                   │   │
│  ┌─────┐    cast    ┌─────┐    ┌─────────┐     │ i │    ┌──────────────┘   │
│  │  A  │───────────▶│  B  │    │ Service │◀────│ s │    ▼                  │
│  └─────┘  (no reply)└─────┘    └─────────┘     │ t │   ┌───┐  ┌───┐  ┌───┐│
│                                                │ r │   │ B │  │ C │  │ D ││
│  Kdy: Potřebujete   Kdy: Najít podle jména     │ y │   └───┘  └───┘  └───┘│
│  přímou referenci   oddělení komponent         └───┘   odběratelé        │
│                                                                             │
│  Použití: Request/reply  Použití: Service discovery  Použití: Broadcast   │
│       fire-and-forget     singleton lookup           mnoho příjemců       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 1. Přímá komunikace: call() a cast()

Když máte referenci na proces, můžete komunikovat přímo pomocí `call()` a `cast()`.

### call() — Request-Response

`call()` odešle zprávu a čeká na odpověď. Z pohledu volajícího je synchronní.

```typescript
import { GenServer, type GenServerBehavior } from '@hamicek/noex';

// Definice kalkulačky
interface CalcState {
  history: string[];
}

type CalcCall =
  | { type: 'add'; a: number; b: number }
  | { type: 'multiply'; a: number; b: number }
  | { type: 'getHistory' };

const calculatorBehavior: GenServerBehavior<CalcState, CalcCall, never, number | string[]> = {
  init: () => ({ history: [] }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'add': {
        const result = msg.a + msg.b;
        const entry = `${msg.a} + ${msg.b} = ${result}`;
        return [result, { history: [...state.history, entry] }];
      }
      case 'multiply': {
        const result = msg.a * msg.b;
        const entry = `${msg.a} * ${msg.b} = ${result}`;
        return [result, { history: [...state.history, entry] }];
      }
      case 'getHistory':
        return [state.history, state];
    }
  },

  handleCast: (_, state) => state,
};

// Použití
const calc = await GenServer.start(calculatorBehavior);

// call() vrací Promise s odpovědí
const sum = await GenServer.call(calc, { type: 'add', a: 5, b: 3 });
console.log(sum); // 8

const product = await GenServer.call(calc, { type: 'multiply', a: 4, b: 7 });
console.log(product); // 28

const history = await GenServer.call(calc, { type: 'getHistory' });
console.log(history); // ['5 + 3 = 8', '4 * 7 = 28']
```

**Kdy použít `call()`:**
- Potřebujete výsledek operace
- Potřebujete potvrzení, že operace byla dokončena
- Potřebujete zachovat záruky pořadí požadavků
- Operace by měla blokovat do dokončení

### cast() — Fire-and-Forget

`cast()` odešle zprávu bez čekání na odpověď. Volající pokračuje okamžitě.

```typescript
interface LoggerState {
  logs: Array<{ level: string; message: string; timestamp: Date }>;
}

type LoggerCast =
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'flush' };

type LoggerCall = { type: 'getLogs' };

const loggerBehavior: GenServerBehavior<LoggerState, LoggerCall, LoggerCast, Array<{ level: string; message: string; timestamp: Date }>> = {
  init: () => ({ logs: [] }),

  handleCall(msg, state) {
    if (msg.type === 'getLogs') {
      return [state.logs, state];
    }
    return [[], state];
  },

  handleCast(msg, state) {
    switch (msg.type) {
      case 'log':
        return {
          logs: [
            ...state.logs,
            { level: msg.level, message: msg.message, timestamp: new Date() },
          ],
        };
      case 'flush':
        // Zápis logů do souboru, odeslání na server, atd.
        console.log('Flushing', state.logs.length, 'logs');
        return { logs: [] };
    }
  },
};

// Použití
const logger = await GenServer.start(loggerBehavior);

// cast() vrací void okamžitě — nečeká
GenServer.cast(logger, { type: 'log', level: 'info', message: 'Server started' });
GenServer.cast(logger, { type: 'log', level: 'warn', message: 'High memory usage' });

// Tyto casty jsou zařazeny do fronty a zpracovány v pořadí,
// ale volající na ně nečeká

// Pokud později potřebujete logy:
const logs = await GenServer.call(logger, { type: 'getLogs' });
```

**Kdy použít `cast()`:**
- Nepotřebujete výsledek
- Záleží na výkonu (žádné čekání na round-trip)
- Logování, metriky, notifikace
- Úlohy na pozadí, které neovlivňují volajícího

### Kombinování call() a cast()

Běžný pattern je použít `cast()` pro zápisy a `call()` pro čtení:

```typescript
interface CounterState {
  value: number;
}

type CounterCall = { type: 'get' };
type CounterCast = { type: 'increment' } | { type: 'decrement' };

const counterBehavior: GenServerBehavior<CounterState, CounterCall, CounterCast, number> = {
  init: () => ({ value: 0 }),

  handleCall(msg, state) {
    if (msg.type === 'get') {
      return [state.value, state];
    }
    return [0, state];
  },

  handleCast(msg, state) {
    switch (msg.type) {
      case 'increment':
        return { value: state.value + 1 };
      case 'decrement':
        return { value: state.value - 1 };
    }
  },
};

// Použití
const counter = await GenServer.start(counterBehavior);

// Rychlé zápisy (fire-and-forget)
GenServer.cast(counter, { type: 'increment' });
GenServer.cast(counter, { type: 'increment' });
GenServer.cast(counter, { type: 'increment' });

// Čtení když je potřeba
const value = await GenServer.call(counter, { type: 'get' });
console.log(value); // 3
```

Tento pattern maximalizuje propustnost zápisů a stále umožňuje čtení když je potřeba.

## 2. Registry: Vyhledávání procesů

Přímá komunikace vyžaduje referenci. Ale jak získáte referenci na prvním místě? **Registry** poskytuje vyhledávání pojmenovaných procesů.

### Registrace procesů

```typescript
import { GenServer, Registry } from '@hamicek/noex';

// Spuštění služby a registrace podle jména
const userService = await GenServer.start(userServiceBehavior);
Registry.register('user-service', userService);

// Nebo registrace při startu
const orderService = await GenServer.start(orderServiceBehavior, {
  name: 'order-service', // Automaticky registrováno
});
```

### Vyhledávání procesů

```typescript
// lookup() vyhodí výjimku, pokud nenajde
try {
  const userService = Registry.lookup('user-service');
  const user = await GenServer.call(userService, { type: 'get', id: 'u1' });
} catch (error) {
  if (error instanceof NotRegisteredError) {
    console.log('User service not available');
  }
}

// whereis() vrací undefined, pokud nenajde (žádná výjimka)
const orderService = Registry.whereis('order-service');
if (orderService) {
  const order = await GenServer.call(orderService, { type: 'get', id: 'o1' });
} else {
  console.log('Order service not available');
}
```

### Registry odděluje komponenty

Bez Registry potřebujete předávat reference explicitně:

```typescript
// ❌ Těsně propojené — OrderService potřebuje referenci na UserService
async function startServices() {
  const userService = await GenServer.start(userServiceBehavior);
  const orderService = await GenServer.start(createOrderServiceBehavior(userService));
  return { userService, orderService };
}
```

S Registry se služby najdou navzájem:

```typescript
// ✅ Volně propojené — služby se najdou podle jména
async function startServices() {
  await GenServer.start(userServiceBehavior, { name: 'user-service' });
  await GenServer.start(orderServiceBehavior, { name: 'order-service' });
}

// Implementace OrderService
const orderServiceBehavior: GenServerBehavior<OrderState, OrderCall, OrderCast, Order | null> = {
  init: () => ({ orders: new Map() }),

  async handleCall(msg, state) {
    if (msg.type === 'create') {
      // Dynamické vyhledání user service
      const userService = Registry.whereis('user-service');
      if (!userService) {
        throw new Error('User service unavailable');
      }

      // Ověření, že uživatel existuje
      const user = await GenServer.call(userService, { type: 'get', id: msg.userId });
      if (!user) {
        throw new Error('User not found');
      }

      const order = { id: generateId(), userId: msg.userId, items: msg.items };
      state.orders.set(order.id, order);
      return [order, state];
    }
    // ... ostatní handlery
    return [null, state];
  },

  handleCast: (_, state) => state,
};
```

### Automatické vyčištění

Když proces skončí, jeho registrace je automaticky odstraněna:

```typescript
const service = await GenServer.start(behavior, { name: 'temp-service' });
console.log(Registry.isRegistered('temp-service')); // true

await GenServer.stop(service);
console.log(Registry.isRegistered('temp-service')); // false (automatické vyčištění)
```

### Výpis registrovaných procesů

```typescript
// Získání všech registrovaných jmen
const names = Registry.getNames();
console.log(names); // ['user-service', 'order-service', 'cache']

// Počítání registrovaných procesů
const count = Registry.count();
console.log(count); // 3

// Kontrola, zda je specifické jméno registrováno
if (Registry.isRegistered('cache')) {
  // Cache je dostupná
}
```

## 3. EventBus: Pub/Sub komunikace

Někdy chcete vysílat události více zájemcům, aniž byste věděli, kdo jsou. To je pattern **publish/subscribe**.

### Vytvoření a používání EventBus

```typescript
import { EventBus } from '@hamicek/noex';

// Spuštění EventBus
const bus = await EventBus.start();

// Přihlášení k odběru událostí
const unsubscribe = await EventBus.subscribe(bus, 'user.created', (message, topic) => {
  console.log(`New user created: ${message.name}`);
});

// Publikování událostí (fire-and-forget)
EventBus.publish(bus, 'user.created', { id: 'u1', name: 'Alice' });

// Odhlášení když je hotovo
unsubscribe();
```

### Wildcard odběry

EventBus podporuje pattern matching pro flexibilní odběry:

```typescript
// Přesná shoda
await EventBus.subscribe(bus, 'user.created', handler);
// Odpovídá: 'user.created'
// Neodpovídá: 'user.updated', 'user.created.admin'

// Single-level wildcard
await EventBus.subscribe(bus, 'user.*', handler);
// Odpovídá: 'user.created', 'user.updated', 'user.deleted'
// Neodpovídá: 'order.created', 'user.profile.updated'

// Globální wildcard
await EventBus.subscribe(bus, '*', handler);
// Odpovídá: vše
```

### Praktický příklad: Pipeline zpracování objednávek

```typescript
import { GenServer, Supervisor, EventBus, Registry, type EventBusRef } from '@hamicek/noex';

// Typy událostí
type OrderEvent =
  | { type: 'order.created'; orderId: string; userId: string; total: number }
  | { type: 'order.paid'; orderId: string; paymentId: string }
  | { type: 'order.shipped'; orderId: string; trackingNumber: string };

// Spuštění EventBus jako pojmenované služby
const eventBus = await EventBus.start({ name: 'event-bus' });

// Služba skladu — odebírá order.created
interface InventoryState {
  reserved: Map<string, string[]>; // orderId -> productIds
}

const inventoryBehavior: GenServerBehavior<InventoryState, any, any, any> = {
  init() {
    // Přihlášení k odběru událostí objednávek při startu
    const bus = Registry.whereis<EventBusRef>('event-bus');
    if (bus) {
      EventBus.subscribe(bus, 'order.created', async (event: OrderEvent) => {
        if (event.type === 'order.created') {
          console.log(`Reserving inventory for order ${event.orderId}`);
          // Rezervace skladu...
        }
      });
    }
    return { reserved: new Map() };
  },

  handleCall: (_, state) => [null, state],
  handleCast: (_, state) => state,
};

// Email služba — odebírá order.* události
interface EmailState {
  sent: number;
}

const emailBehavior: GenServerBehavior<EmailState, any, any, any> = {
  init() {
    const bus = Registry.whereis<EventBusRef>('event-bus');
    if (bus) {
      EventBus.subscribe(bus, 'order.*', async (event: OrderEvent) => {
        switch (event.type) {
          case 'order.created':
            console.log(`Sending order confirmation email for ${event.orderId}`);
            break;
          case 'order.paid':
            console.log(`Sending payment receipt for ${event.orderId}`);
            break;
          case 'order.shipped':
            console.log(`Sending shipping notification for ${event.orderId}`);
            break;
        }
      });
    }
    return { sent: 0 };
  },

  handleCall: (_, state) => [null, state],
  handleCast: (_, state) => state,
};

// Analytická služba — odebírá všechny události
interface AnalyticsState {
  events: Array<{ topic: string; timestamp: Date }>;
}

const analyticsBehavior: GenServerBehavior<AnalyticsState, any, any, any> = {
  init() {
    const bus = Registry.whereis<EventBusRef>('event-bus');
    if (bus) {
      EventBus.subscribe(bus, '*', (message, topic) => {
        console.log(`[Analytics] Event: ${topic}`);
        // Sledování události...
      });
    }
    return { events: [] };
  },

  handleCall: (_, state) => [null, state],
  handleCast: (_, state) => state,
};

// Spuštění všech služeb
async function startOrderPipeline() {
  await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'inventory', start: () => GenServer.start(inventoryBehavior, { name: 'inventory' }) },
      { id: 'email', start: () => GenServer.start(emailBehavior, { name: 'email' }) },
      { id: 'analytics', start: () => GenServer.start(analyticsBehavior, { name: 'analytics' }) },
    ],
  });
}

// Publikování událostí
async function createOrder(userId: string, items: string[]) {
  const orderId = `order-${Date.now()}`;

  // Vytvoření objednávky...

  // Publikování události — všichni odběratelé jsou notifikováni
  const bus = Registry.whereis<EventBusRef>('event-bus')!;
  EventBus.publish(bus, 'order.created', {
    type: 'order.created',
    orderId,
    userId,
    total: 99.99,
  });

  return orderId;
}
```

Když je publikováno `order.created`:
1. Služba skladu rezervuje položky
2. Email služba odešle potvrzení
3. Analytická služba sleduje událost

Všechny tři se stanou nezávisle a paralelně. Služba objednávek o nich neví ani se nestará.

## Výběr správného mechanismu

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PRŮVODCE ROZHODOVÁNÍM O KOMUNIKACI                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Potřebujete odpověď?                                                       │
│       │                                                                     │
│       ├── ANO ─────────────────────────────────────────────▶ call()        │
│       │   "Získej uživatele podle ID"                                       │
│       │   "Spočítej celkovou cenu"                                          │
│       │   "Validuj vstup"                                                   │
│       │                                                                     │
│       └── NE                                                                │
│            │                                                                │
│            ├── Jeden příjemce?                                              │
│            │        │                                                       │
│            │        ├── ANO ──────────────────────────────▶ cast()         │
│            │        │   "Zaloguj tuto zprávu"                               │
│            │        │   "Inkrementuj čítač"                                 │
│            │        │   "Aktualizuj cache"                                  │
│            │        │                                                       │
│            │        └── NE (více příjemců)                                  │
│            │             │                                                  │
│            │             └───────────────────────────────▶ EventBus        │
│            │                 "Objednávka byla vytvořena"                    │
│            │                 "Uživatel se zaregistroval"                    │
│            │                 "Systém se vypíná"                             │
│            │                                                                │
│            └── Neznámý příjemce? ───────────▶ Registry + call/cast        │
│                "Najdi user-service a zavolej ho"                            │
│                "Najdi jakéhokoli dostupného workera"                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Souhrnná tabulka

| Mechanismus | Použij kdy | Propojení | Blokující |
|------------|-----------|----------|----------|
| `call()` | Potřebujete odpověď | Těsné (přímá ref) | Ano |
| `cast()` | Fire-and-forget | Těsné (přímá ref) | Ne |
| Registry | Service discovery | Volné (podle jména) | Ne |
| EventBus | Broadcast/notify | Žádné (pub/sub) | Ne |

## Komunikační topologie

Různé aplikační architektury používají různé komunikační patterny.

### Hub and Spoke

Centrální koordinátor s periferními workery:

```
                    ┌───────────────┐
                    │   Koordinátor │
                    │   (hub)       │
                    └───────┬───────┘
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         ┌────────┐    ┌────────┐    ┌────────┐
         │Worker A│    │Worker B│    │Worker C│
         └────────┘    └────────┘    └────────┘
```

```typescript
// Koordinátor distribuuje práci přes cast()
// Workery hlásí výsledky přes call() zpět koordinátorovi
const workers = [workerA, workerB, workerC];
let nextWorker = 0;

function distributeWork(task: Task) {
  const worker = workers[nextWorker];
  nextWorker = (nextWorker + 1) % workers.length;
  GenServer.cast(worker, { type: 'process', task });
}
```

### Pipeline

Sekvenční zpracování přes fáze:

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  Input  │───▶│  Parse  │───▶│Validate │───▶│  Store  │
└─────────┘    └─────────┘    └─────────┘    └─────────┘
```

```typescript
// Každá fáze volá další
const parseBehavior: GenServerBehavior<any, ParseCall, never, ParseResult> = {
  init: () => ({}),

  async handleCall(msg, state) {
    if (msg.type === 'parse') {
      const parsed = parseInput(msg.data);

      // Předání do další fáze
      const validator = Registry.whereis('validator')!;
      const validated = await GenServer.call(validator, { type: 'validate', data: parsed });

      return [validated, state];
    }
    return [null, state];
  },

  handleCast: (_, state) => state,
};
```

### Pub/Sub Fan-Out

Jedna událost spouští mnoho handlerů:

```
                    ┌───────────────┐
       publish      │   EventBus    │
    ───────────────▶│               │
                    └───────┬───────┘
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         ┌────────┐    ┌────────┐    ┌────────┐
         │ Email  │    │Analytics│   │Webhook │
         └────────┘    └────────┘    └────────┘
```

```typescript
// Publisher neví o odběratelích
EventBus.publish(bus, 'user.registered', { userId: 'u1' });

// Více nezávislých handlerů reaguje
// - Email odešle uvítací zprávu
// - Analytics sleduje registraci
// - Webhook notifikuje externí systém
```

## Příklad: Budování notifikačního systému

Pojďme zkombinovat všechny tři mechanismy v reálném příkladu:

```typescript
import {
  GenServer,
  Supervisor,
  Registry,
  EventBus,
  type GenServerBehavior,
  type EventBusRef,
} from '@hamicek/noex';

// Typy
type Channel = 'email' | 'sms' | 'push';
type Priority = 'low' | 'normal' | 'high';

interface Notification {
  id: string;
  userId: string;
  channel: Channel;
  title: string;
  body: string;
  priority: Priority;
}

// ============================================================================
// Notification Router — Používá Registry k nalezení handlerů kanálů
// ============================================================================

interface RouterState {
  sent: number;
}

type RouterCall = { type: 'send'; notification: Notification };

const routerBehavior: GenServerBehavior<RouterState, RouterCall, never, boolean> = {
  init: () => ({ sent: 0 }),

  async handleCall(msg, state) {
    if (msg.type === 'send') {
      const { notification } = msg;

      // Použití Registry k nalezení příslušného handleru kanálu
      const channelHandler = Registry.whereis(`channel-${notification.channel}`);

      if (!channelHandler) {
        console.error(`No handler for channel: ${notification.channel}`);
        return [false, state];
      }

      // Přímé volání handleru kanálu
      const delivered = await GenServer.call(channelHandler, {
        type: 'deliver',
        notification,
      });

      if (delivered) {
        // Publikování úspěšné události přes EventBus
        const bus = Registry.whereis<EventBusRef>('event-bus');
        if (bus) {
          EventBus.publish(bus, `notification.sent.${notification.channel}`, {
            notificationId: notification.id,
            userId: notification.userId,
          });
        }
      }

      return [delivered as boolean, { sent: state.sent + (delivered ? 1 : 0) }];
    }
    return [false, state];
  },

  handleCast: (_, state) => state,
};

// ============================================================================
// Handlery kanálů — Volány přímo Routerem
// ============================================================================

interface ChannelState {
  delivered: number;
  failed: number;
}

type ChannelCall = { type: 'deliver'; notification: Notification } | { type: 'getStats' };

function createChannelBehavior(channel: Channel): GenServerBehavior<ChannelState, ChannelCall, never, boolean | ChannelState> {
  return {
    init: () => ({ delivered: 0, failed: 0 }),

    async handleCall(msg, state) {
      switch (msg.type) {
        case 'deliver': {
          // Simulace doručení specifického pro kanál
          const success = await deliverViaChannel(channel, msg.notification);

          if (success) {
            return [true, { ...state, delivered: state.delivered + 1 }];
          } else {
            return [false, { ...state, failed: state.failed + 1 }];
          }
        }
        case 'getStats':
          return [state, state];
      }
    },

    handleCast: (_, state) => state,
  };
}

async function deliverViaChannel(channel: Channel, notification: Notification): Promise<boolean> {
  // Simulace doručení s určitou latencí
  await new Promise(resolve => setTimeout(resolve, 10));
  console.log(`[${channel.toUpperCase()}] Delivered to ${notification.userId}: ${notification.title}`);
  return true;
}

// ============================================================================
// Analytická služba — Odebírá EventBus
// ============================================================================

interface AnalyticsState {
  byChannel: Map<Channel, number>;
}

const analyticsBehavior: GenServerBehavior<AnalyticsState, any, any, any> = {
  init() {
    const bus = Registry.whereis<EventBusRef>('event-bus');
    if (bus) {
      // Odběr všech notifikačních událostí pomocí wildcard
      EventBus.subscribe(bus, 'notification.sent.*', (message, topic) => {
        const channel = topic.split('.')[2] as Channel;
        console.log(`[Analytics] Notification sent via ${channel}`);
      });
    }
    return { byChannel: new Map() };
  },

  handleCall: (_, state) => [null, state],
  handleCast: (_, state) => state,
};

// ============================================================================
// Spuštění systému
// ============================================================================

async function startNotificationSystem() {
  // Spuštění EventBus jako první
  await EventBus.start({ name: 'event-bus' });

  // Spuštění handlerů kanálů
  await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      {
        id: 'channel-email',
        start: () => GenServer.start(createChannelBehavior('email'), { name: 'channel-email' }),
      },
      {
        id: 'channel-sms',
        start: () => GenServer.start(createChannelBehavior('sms'), { name: 'channel-sms' }),
      },
      {
        id: 'channel-push',
        start: () => GenServer.start(createChannelBehavior('push'), { name: 'channel-push' }),
      },
    ],
  });

  // Spuštění routeru a analytiky
  await GenServer.start(routerBehavior, { name: 'notification-router' });
  await GenServer.start(analyticsBehavior, { name: 'analytics' });

  console.log('Notification system started');
}

// ============================================================================
// Použití
// ============================================================================

async function demo() {
  await startNotificationSystem();

  const router = Registry.lookup('notification-router');

  // Odeslání notifikací přes různé kanály
  await GenServer.call(router, {
    type: 'send',
    notification: {
      id: 'n1',
      userId: 'user-1',
      channel: 'email',
      title: 'Welcome!',
      body: 'Thanks for signing up.',
      priority: 'normal',
    },
  });

  await GenServer.call(router, {
    type: 'send',
    notification: {
      id: 'n2',
      userId: 'user-1',
      channel: 'push',
      title: 'New message',
      body: 'You have a new message.',
      priority: 'high',
    },
  });
}

// Výstup:
// [EMAIL] Delivered to user-1: Welcome!
// [Analytics] Notification sent via email
// [PUSH] Delivered to user-1: New message
// [Analytics] Notification sent via push
```

Tento příklad demonstruje:
1. **Přímé call()** — Router volá handlery kanálů
2. **Registry lookup** — Router nachází handlery podle jména (`channel-email`, atd.)
3. **EventBus pub/sub** — Analytics odebírá události `notification.sent.*`

## Cvičení

Vytvořte **task queue** s následujícími požadavky:

1. **Producer** — přijímá úlohy a zařazuje je do fronty
2. **Worker pool** — 3 workery, které zpracovávají úlohy
3. **Monitor** — sleduje dokončení úloh přes EventBus

Požadavky:
- Producer používá `call()` pro zařazení (vrací task ID)
- Producer používá `cast()` pro přiřazení úloh workerům
- Workery publikují události dokončení do EventBus
- Monitor odebírá všechny události dokončení

<details>
<summary>Řešení</summary>

```typescript
import {
  GenServer,
  Supervisor,
  Registry,
  EventBus,
  type GenServerBehavior,
  type GenServerRef,
  type EventBusRef,
} from '@hamicek/noex';

// Typy
interface Task {
  id: string;
  payload: string;
}

// ============================================================================
// Producer — Správa fronty úloh
// ============================================================================

interface ProducerState {
  queue: Task[];
  nextWorker: number;
  workerCount: number;
}

type ProducerCall =
  | { type: 'enqueue'; payload: string }
  | { type: 'getQueueSize' };

type ProducerCast = { type: 'processNext' };

const producerBehavior: GenServerBehavior<ProducerState, ProducerCall, ProducerCast, string | number> = {
  init: () => ({
    queue: [],
    nextWorker: 0,
    workerCount: 3,
  }),

  handleCall(msg, state) {
    switch (msg.type) {
      case 'enqueue': {
        const task: Task = {
          id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          payload: msg.payload,
        };
        const newQueue = [...state.queue, task];

        // Spuštění zpracování
        const self = Registry.whereis('producer')!;
        GenServer.cast(self, { type: 'processNext' });

        return [task.id, { ...state, queue: newQueue }];
      }
      case 'getQueueSize':
        return [state.queue.length, state];
    }
  },

  handleCast(msg, state) {
    if (msg.type === 'processNext' && state.queue.length > 0) {
      const [task, ...remaining] = state.queue;

      // Round-robin výběr workera
      const workerId = `worker-${state.nextWorker}`;
      const worker = Registry.whereis(workerId);

      if (worker) {
        GenServer.cast(worker, { type: 'process', task });
      }

      return {
        ...state,
        queue: remaining,
        nextWorker: (state.nextWorker + 1) % state.workerCount,
      };
    }
    return state;
  },
};

// ============================================================================
// Worker — Zpracování úloh
// ============================================================================

interface WorkerState {
  id: string;
  processed: number;
}

type WorkerCall = { type: 'getProcessed' };
type WorkerCast = { type: 'process'; task: Task };

function createWorkerBehavior(workerId: string): GenServerBehavior<WorkerState, WorkerCall, WorkerCast, number> {
  return {
    init: () => ({ id: workerId, processed: 0 }),

    handleCall(msg, state) {
      if (msg.type === 'getProcessed') {
        return [state.processed, state];
      }
      return [0, state];
    },

    async handleCast(msg, state) {
      if (msg.type === 'process') {
        // Simulace práce
        await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));

        console.log(`[${state.id}] Processed task: ${msg.task.id}`);

        // Publikování události dokončení
        const bus = Registry.whereis<EventBusRef>('event-bus');
        if (bus) {
          EventBus.publish(bus, 'task.completed', {
            taskId: msg.task.id,
            workerId: state.id,
          });
        }

        // Požadavek na další práci
        const producer = Registry.whereis('producer');
        if (producer) {
          GenServer.cast(producer, { type: 'processNext' });
        }

        return { ...state, processed: state.processed + 1 };
      }
      return state;
    },
  };
}

// ============================================================================
// Monitor — Sledování dokončení přes EventBus
// ============================================================================

interface MonitorState {
  completions: Array<{ taskId: string; workerId: string; timestamp: Date }>;
}

type MonitorCall = { type: 'getCompletions' };

const monitorBehavior: GenServerBehavior<MonitorState, MonitorCall, never, MonitorState['completions']> = {
  init() {
    const bus = Registry.whereis<EventBusRef>('event-bus');
    if (bus) {
      EventBus.subscribe(bus, 'task.completed', (message: { taskId: string; workerId: string }) => {
        console.log(`[Monitor] Task ${message.taskId} completed by ${message.workerId}`);
      });
    }
    return { completions: [] };
  },

  handleCall(msg, state) {
    if (msg.type === 'getCompletions') {
      return [state.completions, state];
    }
    return [[], state];
  },

  handleCast: (_, state) => state,
};

// ============================================================================
// Spuštění systému
// ============================================================================

async function startTaskQueue() {
  // EventBus
  await EventBus.start({ name: 'event-bus' });

  // Workery
  await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'worker-0', start: () => GenServer.start(createWorkerBehavior('worker-0'), { name: 'worker-0' }) },
      { id: 'worker-1', start: () => GenServer.start(createWorkerBehavior('worker-1'), { name: 'worker-1' }) },
      { id: 'worker-2', start: () => GenServer.start(createWorkerBehavior('worker-2'), { name: 'worker-2' }) },
    ],
  });

  // Producer a Monitor
  await GenServer.start(producerBehavior, { name: 'producer' });
  await GenServer.start(monitorBehavior, { name: 'monitor' });

  console.log('Task queue system started');
}

// ============================================================================
// Demo
// ============================================================================

async function demo() {
  await startTaskQueue();

  const producer = Registry.lookup('producer');

  // Zařazení úloh pomocí call() — získáte zpět task IDs
  const taskIds = await Promise.all([
    GenServer.call(producer, { type: 'enqueue', payload: 'Process image 1' }),
    GenServer.call(producer, { type: 'enqueue', payload: 'Process image 2' }),
    GenServer.call(producer, { type: 'enqueue', payload: 'Process image 3' }),
    GenServer.call(producer, { type: 'enqueue', payload: 'Send email 1' }),
    GenServer.call(producer, { type: 'enqueue', payload: 'Send email 2' }),
  ]);

  console.log('Enqueued tasks:', taskIds);

  // Čekání na zpracování
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Kontrola statistik workerů
  for (let i = 0; i < 3; i++) {
    const worker = Registry.whereis(`worker-${i}`)!;
    const processed = await GenServer.call(worker, { type: 'getProcessed' });
    console.log(`Worker ${i} processed: ${processed}`);
  }
}
```

### Klíčové body návrhu

1. **Producer používá `call()`** pro zařazení — volající dostane zpět task ID
2. **Producer používá `cast()`** pro spuštění zpracování — neblokující
3. **Workery používají `cast()`** pro přijímání úloh — paralelní zpracování
4. **Workery publikují do EventBus** — monitor nepotřebuje přímou referenci
5. **Registry** umožňuje všem komponentám najít se navzájem podle jména

</details>

## Shrnutí

- **Tři komunikační mechanismy** slouží různým účelům:
  - `call()` — request-response, blokující
  - `cast()` — fire-and-forget, neblokující
  - EventBus — pub/sub, mnoho příjemců

- **Registry** odděluje komponenty pomocí pojmenovaného vyhledávání:
  - `Registry.register()` — registrace podle jména
  - `Registry.lookup()` / `Registry.whereis()` — nalezení podle jména
  - Automatické vyčištění při ukončení procesu

- **EventBus** umožňuje vysílání:
  - `EventBus.subscribe()` — poslouchání témat pomocí patternů
  - `EventBus.publish()` — vysílání všem odběratelům
  - Wildcard patterny (`user.*`, `*`)

- **Vyberte správný nástroj**:
  - Potřebujete odpověď? → `call()`
  - Jeden příjemce, žádná odpověď? → `cast()`
  - Více příjemců? → EventBus
  - Nemáte referenci? → Registry

Kombinace těchto tří mechanismů vám dává všechny stavební bloky pro komplexní distribuované systémy při zachování volného propojení a odolnosti proti chybám.

---

Další: [Vzory](./03-vzory.md)
