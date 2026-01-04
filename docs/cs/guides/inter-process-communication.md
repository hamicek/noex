# Meziprocesová komunikace

Tento průvodce pokrývá, jak procesy (GenServery) mezi sebou komunikují v noex. Pochopení těchto vzorů je zásadní pro vytváření dobře navržených aplikací.

## Přehled

noex poskytuje několik komunikačních vzorů:

| Vzor | Mechanismus | Případ použití |
|------|-------------|----------------|
| **Přímý** | `GenServer.call/cast` | Jeden na jednoho, známý cíl |
| **Pojmenovaný** | `Registry` | Jeden na jednoho, oddělený |
| **Pub/Sub** | `EventBus` | Jeden na mnoho, události |
| **Supervizovaný** | Předání ref při startu | Komunikace rodič-potomek |

---

## Přímá komunikace

Nejjednodušší vzor: jeden proces přímo volá druhý pomocí jeho reference.

### Synchronní: call()

Použijte `call()`, když potřebujete odpověď:

```typescript
import { GenServer } from 'noex';

// Služba A volá službu B
const result = await GenServer.call(serviceBRef, {
  type: 'get_user',
  id: userId,
});
```

**Charakteristiky:**
- Blokuje do přijetí odpovědi
- Propaguje chyby volajícímu
- Výchozí 5sekundový timeout

### Asynchronní: cast()

Použijte `cast()` pro fire-and-forget zprávy:

```typescript
// Notifikovat logger bez čekání
GenServer.cast(loggerRef, {
  type: 'log',
  level: 'info',
  message: 'Uživatel se přihlásil',
});
```

**Charakteristiky:**
- Vrací se okamžitě
- Žádná odpověď nebo potvrzení
- Chyby nejsou propagovány

### Předávání referencí

Pro přímou komunikaci služby potřebují reference na sebe navzájem:

```typescript
// Možnost 1: Předat při startu přes init args
const orderService = await GenServer.start({
  init: () => ({
    userServiceRef: userServiceRef,
    orders: new Map(),
  }),
  // ...
});

// Možnost 2: Předat přes cast zprávu
GenServer.cast(orderServiceRef, {
  type: 'set_user_service',
  ref: userServiceRef,
});

// Možnost 3: Uložit do stavu z behavior factory
function createOrderBehavior(deps: { userService: UserServiceRef }) {
  return {
    init: () => ({
      userService: deps.userService,
      orders: new Map(),
    }),
    // ...
  };
}
```

---

## Pojmenovaná komunikace s Registry

Registry umožňuje komunikaci bez explicitního předávání referencí.

### Registrace služeb

```typescript
import { GenServer, Registry } from 'noex';

// Spustit a zaregistrovat
const userService = await GenServer.start(userBehavior);
Registry.register('user-service', userService);

// Nebo registrovat během startu
const cacheService = await GenServer.start(cacheBehavior, {
  name: 'cache-service',  // Automaticky registruje v Registry
});
```

### Vyhledávání služeb

```typescript
// Získat referenci podle jména
const userService = Registry.lookup('user-service');
const result = await GenServer.call(userService, { type: 'get_all' });

// Bezpečné vyhledávání (vrací undefined místo vyhození výjimky)
const cache = Registry.whereis('cache-service');
if (cache) {
  await GenServer.call(cache, { type: 'get', key: 'users' });
}
```

### Typově bezpečné vyhledávání

```typescript
// Definovat typy služby
type UserServiceRef = GenServerRef<UserState, UserCall, UserCast, UserReply>;

// Typované vyhledávání
const userService = Registry.lookup<UserState, UserCall, UserCast, UserReply>(
  'user-service'
);

// Nyní plně typováno
const user = await GenServer.call(userService, { type: 'get', id: '123' });
```

### Automatický úklid

Registry automaticky odstraňuje záznamy při ukončení procesů:

```typescript
const ref = await GenServer.start(behavior);
Registry.register('my-service', ref);

Registry.isRegistered('my-service');  // true

await GenServer.stop(ref);

Registry.isRegistered('my-service');  // false (automaticky odstraněno)
```

### Kdy použít Registry

**Dobré pro:**
- Dobře známé singleton služby (např. "cache", "logger", "config")
- Služby, ke kterým potřebuje přistupovat mnoho komponent
- Oddělení implementací služeb od jejich konzumentů

**Vyhněte se pro:**
- Dynamické/dočasné procesy
- Více instancí stejného typu služby
- Výkonově kritické cesty (mírná režie vyhledávání)

---

## Pub/Sub s EventBus

EventBus umožňuje komunikaci jeden na mnoho prostřednictvím témat.

### Základní použití

```typescript
import { EventBus } from 'noex';

// Spustit event bus
const bus = await EventBus.start();

// Přihlásit se k odběru tématu
const unsubscribe = await EventBus.subscribe(bus, 'user.created', (data) => {
  console.log('Nový uživatel:', data);
});

// Publikovat událost
EventBus.publish(bus, 'user.created', { id: '123', name: 'Alice' });

// Úklid
unsubscribe();
await EventBus.stop(bus);
```

### Vzory témat

EventBus podporuje zástupné vzory:

```typescript
// Přesná shoda
await EventBus.subscribe(bus, 'user.created', handler);
// Odpovídá: 'user.created'

// Jednoúrovňový zástupný znak
await EventBus.subscribe(bus, 'user.*', handler);
// Odpovídá: 'user.created', 'user.deleted', 'user.updated'

// Globální zástupný znak
await EventBus.subscribe(bus, '*', handler);
// Odpovídá: vše
```

### Synchronní publikování

Pro testování nebo když záleží na pořadí:

```typescript
// Fire-and-forget (výchozí)
EventBus.publish(bus, 'order.placed', order);

// Počkat na vyvolání handlerů
await EventBus.publishSync(bus, 'order.placed', order);
```

### Příklad: Událostmi řízená architektura

```typescript
// Definice událostí
interface UserCreatedEvent {
  userId: string;
  email: string;
  timestamp: number;
}

interface OrderPlacedEvent {
  orderId: string;
  userId: string;
  items: string[];
}

// Centrální event bus
const eventBus = await EventBus.start({ name: 'event-bus' });

// Email služba se přihlásí k relevantním událostem
await EventBus.subscribe<UserCreatedEvent>(
  eventBus,
  'user.created',
  (event) => {
    sendWelcomeEmail(event.email);
  }
);

await EventBus.subscribe<OrderPlacedEvent>(
  eventBus,
  'order.*',
  (event, topic) => {
    if (topic === 'order.placed') {
      sendOrderConfirmation(event);
    }
  }
);

// Analytics se přihlásí ke všemu
await EventBus.subscribe(eventBus, '*', (event, topic) => {
  trackEvent(topic, event);
});

// Publikování ze služeb
function createUserService(bus: EventBusRef) {
  return {
    async createUser(email: string) {
      const user = { id: generateId(), email };
      // ... uložit uživatele ...

      EventBus.publish(bus, 'user.created', {
        userId: user.id,
        email: user.email,
        timestamp: Date.now(),
      });

      return user;
    },
  };
}
```

### Kdy použít EventBus

**Dobré pro:**
- Průřezové záležitosti (logování, analytika, notifikace)
- Oddělená událostmi řízená architektura
- Více služeb potřebuje reagovat na stejnou událost
- Vysílání změn stavu

**Vyhněte se pro:**
- Vzory požadavek/odpověď (použijte místo toho `call`)
- Když potřebujete potvrzení doručení
- Výkonově kritická, vysokofrekvenční komunikace

---

## Komunikační vzory

### Vzor 1: Service Mesh

Služby komunikují přes centrální registr:

```typescript
// Všechny služby se zaregistrují
Registry.register('user-service', userService);
Registry.register('order-service', orderService);
Registry.register('inventory-service', inventoryService);

// Jakákoli služba může vyhledat jinou
// V order-service:
handleCall: async (msg, state) => {
  const inventory = Registry.lookup('inventory-service');
  const available = await GenServer.call(inventory, {
    type: 'check_stock',
    productId: msg.productId,
  });
  // ...
},
```

### Vzor 2: Event Sourcing

Všechny změny stavu jsou publikovány jako události:

```typescript
const eventBus = await EventBus.start({ name: 'events' });

// Order služba publikuje všechny změny
GenServer.cast(orderService, { type: 'place_order', ...orderData });
// Interně publikuje: 'order.placed'

GenServer.cast(orderService, { type: 'ship_order', orderId });
// Interně publikuje: 'order.shipped'

GenServer.cast(orderService, { type: 'complete_order', orderId });
// Interně publikuje: 'order.completed'

// Ostatní služby reagují na události
await EventBus.subscribe(eventBus, 'order.*', updateOrderProjection);
await EventBus.subscribe(eventBus, 'order.placed', sendOrderNotification);
await EventBus.subscribe(eventBus, 'order.shipped', updateShipmentTracking);
```

### Vzor 3: Agregace požadavků

Jedna služba agreguje data z více zdrojů:

```typescript
// API Gateway agreguje odpovědi
const apiGatewayBehavior = {
  handleCall: async (msg, state) => {
    if (msg.type === 'get_dashboard') {
      // Paralelní požadavky na více služeb
      const [user, orders, notifications] = await Promise.all([
        GenServer.call(Registry.lookup('user-service'), {
          type: 'get',
          id: msg.userId,
        }),
        GenServer.call(Registry.lookup('order-service'), {
          type: 'list_recent',
          userId: msg.userId,
        }),
        GenServer.call(Registry.lookup('notification-service'), {
          type: 'get_unread',
          userId: msg.userId,
        }),
      ]);

      return [{ user, orders, notifications }, state];
    }
  },
};
```

### Vzor 4: Pipeline zpracování

Sekvenční zpracování přes řetězec služeb:

```typescript
// Pipeline zpracování obrázků
const uploadService = await GenServer.start(createUploadBehavior({
  next: Registry.lookup('resize-service'),
}));

const resizeService = await GenServer.start(createResizeBehavior({
  next: Registry.lookup('optimize-service'),
}));

const optimizeService = await GenServer.start(createOptimizeBehavior({
  next: Registry.lookup('storage-service'),
}));

// Použití: upload -> resize -> optimize -> store
await GenServer.call(uploadService, { type: 'process', file: imageData });
```

---

## Zpracování chyb v komunikaci

### Zpracování selhání volání

```typescript
import { CallTimeoutError, ServerNotRunningError } from 'noex';

try {
  const result = await GenServer.call(service, msg, { timeout: 3000 });
} catch (error) {
  if (error instanceof CallTimeoutError) {
    // Služba je pomalá nebo zaseknutá
    console.error('Volání vypršelo');
  } else if (error instanceof ServerNotRunningError) {
    // Služba se zastavila
    console.error('Služba není dostupná');
  } else {
    // Aplikační chyba z handleCall
    console.error('Volání selhalo:', error);
  }
}
```

### Zpracování chybějících služeb

```typescript
// Bezpečný vzor s Registry
function getService(name: string) {
  const service = Registry.whereis(name);
  if (!service) {
    throw new Error(`Služba '${name}' není dostupná`);
  }
  return service;
}

// Nebo s fallbackem
async function getUserWithFallback(userId: string) {
  const userService = Registry.whereis('user-service');
  if (userService) {
    return GenServer.call(userService, { type: 'get', id: userId });
  }
  // Fallback: načíst přímo z databáze
  return fetchUserFromDb(userId);
}
```

### Vzor Circuit Breaker

```typescript
interface CircuitState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

async function callWithCircuitBreaker(
  ref: GenServerRef,
  msg: unknown,
  circuit: CircuitState,
  threshold = 5,
  resetTimeout = 30000,
) {
  // Zkontrolovat, zda je circuit otevřený
  if (circuit.isOpen) {
    const now = Date.now();
    if (now - circuit.lastFailure < resetTimeout) {
      throw new Error('Circuit je otevřený');
    }
    // Zkusit resetovat
    circuit.isOpen = false;
    circuit.failures = 0;
  }

  try {
    const result = await GenServer.call(ref, msg, { timeout: 5000 });
    circuit.failures = 0;
    return result;
  } catch (error) {
    circuit.failures++;
    circuit.lastFailure = Date.now();
    if (circuit.failures >= threshold) {
      circuit.isOpen = true;
    }
    throw error;
  }
}
```

---

## Osvědčené postupy

### 1. Preferujte explicitní závislosti

```typescript
// Dobře: Závislosti jsou jasné
function createOrderService(deps: {
  userService: UserServiceRef;
  inventoryService: InventoryServiceRef;
}) {
  return {
    init: () => ({
      userService: deps.userService,
      inventoryService: deps.inventoryService,
      orders: new Map(),
    }),
    // ...
  };
}

// Vyhněte se: Skryté závislosti přes Registry lookup v handlerech
handleCall: async (msg, state) => {
  const userService = Registry.lookup('user-service');  // Implicitní závislost
  // ...
},
```

### 2. Používejte vhodné vzory

| Situace | Vzor |
|---------|------|
| Potřebuji odpověď | `call()` |
| Fire-and-forget | `cast()` |
| Singleton služba | Registry |
| Více odběratelů | EventBus |
| Úzce propojené | Předat ref přímo |
| Volně propojené | Registry nebo EventBus |

### 3. Zpracujte timeouty elegantně

```typescript
// Nastavte vhodné timeouty
const result = await GenServer.call(slowService, msg, {
  timeout: 30000,  // 30s pro pomalé operace
});

// Nebo použijte wrapper
async function callWithRetry(ref, msg, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await GenServer.call(ref, msg, { timeout: 5000 });
    } catch (error) {
      if (i === retries - 1) throw error;
      await delay(1000 * (i + 1));  // Exponenciální backoff
    }
  }
}
```

### 4. Dokumentujte kontrakty služeb

```typescript
/**
 * UserService - Spravuje uživatelské účty
 *
 * Call zprávy:
 * - { type: 'get', id: string } → User | null
 * - { type: 'list' } → User[]
 *
 * Cast zprávy:
 * - { type: 'create', user: CreateUserInput } → void
 * - { type: 'delete', id: string } → void
 *
 * Publikované události:
 * - 'user.created': UserCreatedEvent
 * - 'user.deleted': UserDeletedEvent
 */
```

### 5. Vyhněte se cyklickým závislostem

```typescript
// Špatně: A volá B, B volá A
// A -> B -> A (riziko deadlocku!)

// Dobře: Použijte události k přerušení cyklů
// A publikuje událost -> B se přihlásí
// B publikuje událost -> A se přihlásí
```

---

## Související

- [Průvodce vytvářením služeb](./building-services.md) - Vytváření GenServerů
- [Koncepty GenServeru](../concepts/genserver.md) - Pochopení GenServeru
- [Koncepty registru](../concepts/registry.md) - Vyhledávání pojmenovaných procesů
- [API Reference EventBus](../api/event-bus.md) - Kompletní EventBus API
- [API Reference Registry](../api/registry.md) - Kompletní Registry API
