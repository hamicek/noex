# EventBus API Reference

`EventBus` poskytuje pub/sub zasílání zpráv mezi komponentami s routováním založeným na tématech a podporou wildcardů.

## Import

```typescript
import { EventBus } from 'noex';
```

## Typy

### EventBusRef

Reference na běžící instanci EventBusu.

```typescript
type EventBusRef = GenServerRef<EventBusState, EventBusCallMsg, EventBusCastMsg, EventBusCallReply>;
```

### EventBusOptions

Volby pro `EventBus.start()`.

```typescript
interface EventBusOptions {
  readonly name?: string;  // Volitelné jméno pro registry
}
```

### MessageHandler

Handler funkce volaná při publikování odpovídající zprávy.

```typescript
type MessageHandler<T = unknown> = (message: T, topic: string) => void;
```

---

## Vzory témat

EventBus podporuje wildcard vzory pro flexibilní párování odběrů:

| Vzor | Odpovídá | Příklady |
|------|----------|----------|
| `'user.created'` | Pouze přesné téma | `'user.created'` |
| `'user.*'` | Jakýkoliv jeden segment po `user.` | `'user.created'`, `'user.deleted'` |
| `'*'` | Všechna témata | Cokoliv |

**Pravidla párování vzorů:**
- Přesná shoda: `'user.created'` odpovídá pouze `'user.created'`
- Jednoduchý wildcard: `*` odpovídá přesně jednomu segmentu
- Globální wildcard: `'*'` samotný odpovídá všem tématům

---

## Metody

### start()

Spustí novou instanci EventBusu.

```typescript
async start(options?: EventBusOptions): Promise<EventBusRef>
```

**Parametry:**
- `options` - Volitelná konfigurace
  - `name` - Registrovat v Registry pod tímto jménem

**Vrací:** Promise resolvující na EventBusRef

**Příklad:**
```typescript
const bus = await EventBus.start();

// S registrací jména
const bus = await EventBus.start({ name: 'main-bus' });
```

---

### subscribe()

Přihlásí odběr zpráv odpovídajících vzoru tématu.

```typescript
async subscribe<T = unknown>(
  ref: EventBusRef,
  pattern: string,
  handler: MessageHandler<T>,
): Promise<() => Promise<void>>
```

**Parametry:**
- `ref` - Reference na EventBus
- `pattern` - Vzor tématu k odběru
- `handler` - Funkce volaná při publikování odpovídající zprávy

**Vrací:** Promise resolvující na funkci pro odhlášení odběru

**Příklad:**
```typescript
// Odběr konkrétního tématu
const unsub = await EventBus.subscribe(bus, 'user.created', (msg, topic) => {
  console.log(`${topic}:`, msg);
});

// Odběr s wildcardem
await EventBus.subscribe(bus, 'user.*', (msg) => {
  console.log('Událost uživatele:', msg);
});

// Odběr všeho
await EventBus.subscribe(bus, '*', (msg, topic) => {
  console.log(`[${topic}]`, msg);
});

// Odhlášení odběru
await unsub();
```

---

### publish()

Publikuje zprávu do tématu. Fire-and-forget operace.

```typescript
publish<T = unknown>(ref: EventBusRef, topic: string, message: T): void
```

**Parametry:**
- `ref` - Reference na EventBus
- `topic` - Téma pro publikování
- `message` - Obsah zprávy

**Vrací:** void (neblokující)

**Příklad:**
```typescript
EventBus.publish(bus, 'user.created', { id: '123', name: 'Alice' });
EventBus.publish(bus, 'order.placed', { orderId: '456', total: 99.99 });
```

---

### publishSync()

Publikuje zprávu a čeká na zavolání všech handlerů.

```typescript
async publishSync<T = unknown>(
  ref: EventBusRef,
  topic: string,
  message: T,
): Promise<void>
```

**Parametry:**
- `ref` - Reference na EventBus
- `topic` - Téma pro publikování
- `message` - Obsah zprávy

**Vrací:** Promise, která se vyřeší po zavolání všech handlerů

**Příklad:**
```typescript
// Užitečné pro testování nebo když záleží na pořadí
await EventBus.publishSync(bus, 'data.ready', { items: [...] });
// Všechny handlery již byly zavolány
processNextStep();
```

---

### getSubscriptionCount()

Vrací počet aktivních odběrů.

```typescript
async getSubscriptionCount(ref: EventBusRef): Promise<number>
```

**Parametry:**
- `ref` - Reference na EventBus

**Vrací:** Počet odběrů

**Příklad:**
```typescript
const count = await EventBus.getSubscriptionCount(bus);
console.log(`${count} aktivních odběrů`);
```

---

### getTopics()

Vrací všechny odebírané vzory témat.

```typescript
async getTopics(ref: EventBusRef): Promise<readonly string[]>
```

**Parametry:**
- `ref` - Reference na EventBus

**Vrací:** Pole odebíraných vzorů

**Příklad:**
```typescript
const topics = await EventBus.getTopics(bus);
console.log('Odebírané vzory:', topics);
// ['user.created', 'user.*', 'order.placed']
```

---

### isRunning()

Zjistí, zda EventBus běží.

```typescript
isRunning(ref: EventBusRef): boolean
```

**Parametry:**
- `ref` - Reference na EventBus

**Vrací:** `true` pokud běží

**Příklad:**
```typescript
if (EventBus.isRunning(bus)) {
  EventBus.publish(bus, 'status', 'ok');
}
```

---

### stop()

Gracefully zastaví EventBus.

```typescript
async stop(ref: EventBusRef): Promise<void>
```

**Parametry:**
- `ref` - Reference na EventBus

**Vrací:** Promise, která se vyřeší po zastavení

**Příklad:**
```typescript
await EventBus.stop(bus);
```

---

## Kompletní příklad

```typescript
import { EventBus, type EventBusRef } from 'noex';

// Typy událostí
interface UserCreatedEvent {
  id: string;
  email: string;
  name: string;
}

interface OrderPlacedEvent {
  orderId: string;
  userId: string;
  total: number;
}

// Aplikační event bus
let bus: EventBusRef;

async function initEventBus() {
  bus = await EventBus.start({ name: 'app-events' });

  // Logovací odběratel - zachycuje všechny události
  await EventBus.subscribe(bus, '*', (msg, topic) => {
    console.log(`[EVENT] ${topic}:`, JSON.stringify(msg));
  });

  // Emailová služba - události uživatelů
  await EventBus.subscribe<UserCreatedEvent>(bus, 'user.created', async (event) => {
    console.log(`Odesílám uvítací email na ${event.email}`);
  });

  // Analytika - všechny události uživatelů
  await EventBus.subscribe(bus, 'user.*', (event, topic) => {
    console.log(`Analytika: ${topic}`);
  });

  // Skladová služba - události objednávek
  await EventBus.subscribe<OrderPlacedEvent>(bus, 'order.placed', (event) => {
    console.log(`Rezervuji zásoby pro objednávku ${event.orderId}`);
  });
}

// Publikování událostí z různých částí aplikace
function onUserRegistration(user: UserCreatedEvent) {
  EventBus.publish(bus, 'user.created', user);
}

function onOrderSubmit(order: OrderPlacedEvent) {
  EventBus.publish(bus, 'order.placed', order);
}

// Použití
async function main() {
  await initEventBus();

  // Simulace událostí
  onUserRegistration({ id: '1', email: 'alice@example.com', name: 'Alice' });
  onOrderSubmit({ orderId: 'ORD-001', userId: '1', total: 150.00 });

  // Kontrola stavu
  const count = await EventBus.getSubscriptionCount(bus);
  console.log(`Aktivních odběrů: ${count}`);

  // Úklid
  await EventBus.stop(bus);
}
```

## Případy použití

### Oddělení komponent

```typescript
// Uživatelská služba - pouze publikuje
function createUser(data: UserData) {
  const user = saveUser(data);
  EventBus.publish(bus, 'user.created', user);
  return user;
}

// Emailová služba - odebírá nezávisle
EventBus.subscribe(bus, 'user.created', sendWelcomeEmail);

// Analytika - odebírá nezávisle
EventBus.subscribe(bus, 'user.*', trackUserEvent);
```

### Vzor Request/Response

Pro request/response použijte místo toho GenServer.call. EventBus je pouze pro fire-and-forget pub/sub.

### Zpracování chyb v handlerech

Handlery by neměly vyhazovat výjimky. Pokud handler vyhodí výjimku, chyba je zachycena a ignorována, a ostatní handlery pokračují ve vykonávání.

```typescript
await EventBus.subscribe(bus, 'data', (msg) => {
  try {
    processData(msg);
  } catch (error) {
    console.error('Chyba handleru:', error);
    // Nevyhazovat znovu
  }
});
```

## Související

- [GenServer API](./genserver.md) - Základní implementace
- [Cache API](./cache.md) - Další vestavěná služba
- [RateLimiter API](./rate-limiter.md) - Další vestavěná služba
