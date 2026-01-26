# EventBus

V předchozích kapitolách jste se naučili komunikovat mezi procesy pomocí přímého `call` a `cast`. Co se ale stane, když potřebujete upozornit mnoho procesů na událost, nebo když producenti by neměli vědět o konzumentech? Zde přichází na řadu **EventBus** — publish-subscribe systém zasílání zpráv postavený na základech GenServeru v noex.

## Co se naučíte

- Jak pub/sub zasílání zpráv odděluje producenty událostí od konzumentů
- Přihlašovat se k odběru událostí pomocí přesných shod a wildcard vzorů
- Vybrat mezi fire-and-forget (`publish`) a synchronizovaným (`publishSync`) doručením
- Budovat architektury řízené událostmi s více nezávislými bus
- Ošetřovat chyby v odběratelích bez ovlivnění ostatních handlerů

## Proč Pub/Sub?

Přímá komunikace mezi procesy (`call`/`cast`) funguje dobře, když přesně víte, kdo má zprávu přijmout. Mnoho scénářů ale vyžaduje **volnou vazbu**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   PŘÍMÁ VS PUB/SUB KOMUNIKACE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  PŘÍMÁ (call/cast):                     PUB/SUB (EventBus):                 │
│                                                                             │
│  Producent zná všechny konzumenty      Producent zná pouze téma             │
│                                                                             │
│  ┌──────────┐                          ┌──────────┐                         │
│  │ UserSvc  │──────┐                   │ UserSvc  │                         │
│  └──────────┘      │                   └────┬─────┘                         │
│                    ▼                        │                               │
│  ┌──────────┐   ┌──────────┐               │ publish('user.created')        │
│  │ EmailSvc │◄──│  Order   │               ▼                                │
│  └──────────┘   │   Svc    │          ┌─────────┐                           │
│                 └──────────┘          │EventBus │                           │
│  ┌──────────┐        │                └────┬────┘                           │
│  │  Audit   │◄───────┘                     │                                │
│  │   Svc    │                     ┌────────┼────────┐                       │
│  └──────────┘                     ▼        ▼        ▼                       │
│                             ┌────────┐ ┌────────┐ ┌────────┐                │
│  Přidání nového konzumenta  │ Email  │ │ Order  │ │ Audit  │                │
│  = změna kódu producenta    │  Svc   │ │  Svc   │ │  Svc   │                │
│                             └────────┘ └────────┘ └────────┘                │
│                                                                             │
│                             Přidání konzumenta = pouze subscribe            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Použijte pub/sub když:**
- Více konzumentů potřebuje stejnou událost
- Producenti by neměli vědět o konzumentech (volná vazba)
- Noví konzumenti mohou být přidáni později bez změny producentů
- Události jsou notifikace, ne požadavky (nepotřebujete odpověď)

**Použijte přímé volání když:**
- Potřebujete odpověď od příjemce
- Existuje právě jeden příjemce
- Těsná vazba je záměrná (kontrakty mezi službami)

## Spuštění EventBusu

EventBus je postaven na GenServeru. Každý bus je nezávislý proces:

```typescript
import { EventBus } from '@hamicek/noex';

// Spuštění nepojmenovaného EventBusu
const bus = await EventBus.start();

// Spuštění pojmenovaného EventBusu (registrován v registry)
const namedBus = await EventBus.start({ name: 'app-events' });

// Kontrola, zda běží
console.log(EventBus.isRunning(bus)); // true

// Úklid při ukončení
await EventBus.stop(bus);
```

Více busů je kompletně nezávislých — zprávy publikované na jeden nikdy nedorazí k odběratelům jiného:

```typescript
const userEvents = await EventBus.start({ name: 'user-events' });
const orderEvents = await EventBus.start({ name: 'order-events' });

// Toto jsou izolované proudy událostí
EventBus.publish(userEvents, 'created', { userId: '123' });
EventBus.publish(orderEvents, 'created', { orderId: '456' });
```

## Přihlášení k odběru událostí

Odběry používají **vzory témat** pro filtrování, které události handler obdrží:

```typescript
const bus = await EventBus.start();

// Subscribe vrací funkci pro odhlášení
const unsubscribe = await EventBus.subscribe(
  bus,
  'user.created',  // Vzor tématu
  (message, topic) => {
    console.log(`Přijato na ${topic}:`, message);
  }
);

// Později: odhlásit, když už nemáme zájem
await unsubscribe();
```

Handler přijímá dva argumenty:
1. **message** — Payload události (typovaný přes generický parametr)
2. **topic** — Skutečné téma, na které byla zpráva publikována

### Typované odběry

Použijte TypeScript generika pro type-safe handlery:

```typescript
interface UserCreatedEvent {
  userId: string;
  email: string;
  timestamp: number;
}

await EventBus.subscribe<UserCreatedEvent>(
  bus,
  'user.created',
  (event, topic) => {
    // event je typován jako UserCreatedEvent
    console.log(`Uživatel ${event.userId} vytvořen: ${event.email}`);
  }
);
```

## Vzory témat

EventBus podporuje tři typy pattern matchingu:

### Přesná shoda

Vzor musí přesně odpovídat publikovanému tématu:

```typescript
await EventBus.subscribe(bus, 'user.created', handler);

EventBus.publish(bus, 'user.created', data);  // ✅ Shoda
EventBus.publish(bus, 'user.updated', data);  // ❌ Neshoda
EventBus.publish(bus, 'user.created.admin', data); // ❌ Neshoda
```

### Jednúrovňový wildcard (`*`)

`*` odpovídá přesně jednomu segmentu (segmenty jsou odděleny tečkami):

```typescript
// Odpovídá jakékoli události v namespace 'user'
await EventBus.subscribe(bus, 'user.*', handler);

EventBus.publish(bus, 'user.created', data); // ✅ Shoda
EventBus.publish(bus, 'user.deleted', data); // ✅ Shoda
EventBus.publish(bus, 'user.profile.updated', data); // ❌ Neshoda (2 segmenty za 'user')
EventBus.publish(bus, 'order.created', data); // ❌ Neshoda
```

Více wildcardů funguje segment po segmentu:

```typescript
// Odpovídá událostem jako 'user.123.action'
await EventBus.subscribe(bus, 'user.*.action', handler);

EventBus.publish(bus, 'user.123.action', data);   // ✅ Shoda
EventBus.publish(bus, 'user.456.action', data);   // ✅ Shoda
EventBus.publish(bus, 'user.action', data);       // ❌ Neshoda (chybí prostřední segment)
EventBus.publish(bus, 'user.123.other', data);    // ❌ Neshoda
```

### Globální wildcard (`*`)

Samostatný `*` odpovídá všem tématům:

```typescript
// Přijímá VŠECHNY události (užitečné pro logování/debugging)
await EventBus.subscribe(bus, '*', (message, topic) => {
  console.log(`[${topic}]`, message);
});

EventBus.publish(bus, 'user.created', data);   // ✅ Shoda
EventBus.publish(bus, 'order.placed', data);   // ✅ Shoda
EventBus.publish(bus, 'anything.at.all', data); // ✅ Shoda
```

### Diagram pattern matchingu

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PATTERN MATCHING TÉMAT                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Publikované téma         Vzor                Shoda?                        │
│  ─────────────────────────────────────────────────────────                  │
│  'user.created'           'user.created'      ✅ Přesná shoda              │
│  'user.created'           'user.*'            ✅ Wildcard odpovídá segmentu│
│  'user.created'           '*'                 ✅ Globální wildcard          │
│  'user.created'           'user.deleted'      ❌ Jiný segment               │
│  'user.profile.updated'   'user.*'            ❌ Příliš mnoho segmentů      │
│  'user.123.email'         'user.*.email'      ✅ Prostřední wildcard        │
│  'user.123.email'         '*.*.email'         ✅ Více wildcardů             │
│  'order.created'          'user.*'            ❌ Jiný prefix                │
│                                                                             │
│  Segmenty:   topic.split('.')                                               │
│  Matching:   Každý * odpovídá přesně jednomu segmentu                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Publikování událostí

EventBus nabízí dva režimy publikování s různými zárukami doručení:

### Fire-and-Forget (`publish`)

Výchozí režim vrací okamžitě bez čekání na handlery:

```typescript
// Vrací okamžitě — handlery běží asynchronně
EventBus.publish(bus, 'user.created', {
  userId: '123',
  email: 'alice@example.com'
});

// Můžete publikovat mnoho událostí rychle
for (const user of users) {
  EventBus.publish(bus, 'user.created', user);
}
```

**Charakteristiky:**
- Neblokující — vrací okamžitě
- Žádná záruka, že handlery běžely, když `publish()` vrátí
- Nejlepší pro scénáře s vysokou propustností
- Interně používá GenServer `cast()`

### Synchronizované publikování (`publishSync`)

Čeká, až všechny handlery dokončí zpracování:

```typescript
// Čeká na zavolání všech odpovídajících handlerů
await EventBus.publishSync(bus, 'user.created', {
  userId: '123',
  email: 'alice@example.com'
});

// V tomto bodě byly všechny handlery zavolány
console.log('Všechny handlery dokončeny');
```

**Charakteristiky:**
- Blokující — čeká na zavolání handlerů
- Zaručuje, že všechny handlery byly zavolány, když se promise resolvuje
- Nejlepší pro testování a když záleží na pořadí
- Interně používá `cast()` + `call()` pro synchronizaci

### Kdy použít který režim

```typescript
// Vysoká propustnost logování — použijte publish()
EventBus.publish(bus, 'request.received', requestData);

// Testovací assertions — použijte publishSync()
await EventBus.publishSync(bus, 'order.placed', order);
expect(emailSentToUser).toBe(true); // Nyní bezpečné assertovat

// Sekvencování událostí — použijte publishSync()
await EventBus.publishSync(bus, 'step.1.complete', data);
await EventBus.publishSync(bus, 'step.2.complete', data);
// Kroky jsou garantovaně zpracovány v pořadí
```

## Ošetřování chyb

EventBus je **odolný vůči chybám** — pokud jeden handler vyhodí výjimku, ostatní handlery stále běží:

```typescript
await EventBus.subscribe(bus, 'user.created', () => {
  throw new Error('Handler 1 selhal!');
});

await EventBus.subscribe(bus, 'user.created', (msg) => {
  console.log('Handler 2 přijal:', msg);
});

await EventBus.subscribe(bus, 'user.created', (msg) => {
  console.log('Handler 3 přijal:', msg);
});

// Všechny tři handlery jsou zavolány, i když handler 1 vyhodí výjimku
await EventBus.publishSync(bus, 'user.created', { id: '123' });
// Výstup:
// Handler 2 přijal: { id: '123' }
// Handler 3 přijal: { id: '123' }
```

Tato izolace zajišťuje, že bug v jednom odběrateli nerozbije celý systém událostí.

## Odhlášení

Funkce `subscribe()` vrací funkci pro odhlášení:

```typescript
const unsubscribe = await EventBus.subscribe(bus, 'user.*', handler);

// Později, když už odběr nepotřebujeme
await unsubscribe();
```

Funkce pro odhlášení je:
- **Idempotentní** — vícenásobné volání je bezpečné
- **Bezpečná po zastavení** — nevyhodí výjimku, pokud je bus už zastaven

```typescript
await unsubscribe(); // Odstraní odběr
await unsubscribe(); // Bezpečné, bez efektu
await EventBus.stop(bus);
await unsubscribe(); // Stále bezpečné
```

## Monitorování odběrů

Zkontrolujte stav vašeho EventBusu:

```typescript
// Počet aktivních odběrů
const count = await EventBus.getSubscriptionCount(bus);
console.log(`Aktivní odběry: ${count}`);

// Seznam všech přihlášených vzorů
const topics = await EventBus.getTopics(bus);
console.log(`Vzory: ${topics.join(', ')}`);
// např. "user.*, order.created, *"
```

## Praktický příklad: Události životního cyklu uživatele

Zde je kompletní příklad ukazující, jak se různé služby přihlašují k odběru událostí uživatele:

```typescript
import { EventBus, type EventBusRef } from '@hamicek/noex';

// Typy událostí
interface UserCreatedEvent {
  userId: string;
  email: string;
  name: string;
}

interface UserDeletedEvent {
  userId: string;
  reason: string;
}

interface UserEvent {
  userId: string;
  action: string;
  timestamp: number;
}

// Email služba se přihlašuje ke konkrétním událostem
async function startEmailService(bus: EventBusRef) {
  await EventBus.subscribe<UserCreatedEvent>(
    bus,
    'user.created',
    (event) => {
      console.log(`[Email] Odesílám uvítací email na ${event.email}`);
    }
  );

  await EventBus.subscribe<UserDeletedEvent>(
    bus,
    'user.deleted',
    (event) => {
      console.log(`[Email] Odesílám rozlučkový email pro uživatele ${event.userId}`);
    }
  );
}

// Audit služba loguje všechny události uživatele
async function startAuditService(bus: EventBusRef) {
  await EventBus.subscribe<UserEvent>(
    bus,
    'user.*',  // Zachytí všechny user.* události
    (event, topic) => {
      console.log(`[Audit] ${topic}: user=${event.userId}`);
    }
  );
}

// Analytics sleduje vše
async function startAnalyticsService(bus: EventBusRef) {
  await EventBus.subscribe(
    bus,
    '*',  // Všechny události
    (event, topic) => {
      console.log(`[Analytics] Událost zaznamenána: ${topic}`);
    }
  );
}

// Hlavní aplikace
async function main() {
  const bus = await EventBus.start({ name: 'app-events' });

  // Spuštění služeb (pořadí nezáleží)
  await startEmailService(bus);
  await startAuditService(bus);
  await startAnalyticsService(bus);

  // Simulace vytvoření uživatele
  await EventBus.publishSync(bus, 'user.created', {
    userId: 'u123',
    email: 'alice@example.com',
    name: 'Alice',
    action: 'created',
    timestamp: Date.now(),
  });

  // Výstup:
  // [Email] Odesílám uvítací email na alice@example.com
  // [Audit] user.created: user=u123
  // [Analytics] Událost zaznamenána: user.created

  // Simulace smazání uživatele
  await EventBus.publishSync(bus, 'user.deleted', {
    userId: 'u123',
    reason: 'Účet uzavřen uživatelem',
    action: 'deleted',
    timestamp: Date.now(),
  });

  // Výstup:
  // [Email] Odesílám rozlučkový email pro uživatele u123
  // [Audit] user.deleted: user=u123
  // [Analytics] Událost zaznamenána: user.deleted

  await EventBus.stop(bus);
}

main();
```

## Vzory architektury řízené událostmi

### Vzor 1: Vysílání doménových událostí

Každá doména publikuje události; ostatní domény se přihlašují:

```typescript
// Doména objednávek publikuje
EventBus.publish(bus, 'order.placed', {
  orderId: 'o123',
  userId: 'u456',
  total: 99.99,
});

// Doména inventáře se přihlašuje
await EventBus.subscribe(bus, 'order.placed', async (order) => {
  await reserveInventory(order.orderId);
});

// Doména notifikací se přihlašuje
await EventBus.subscribe(bus, 'order.placed', async (order) => {
  await sendOrderConfirmation(order.userId, order.orderId);
});
```

### Vzor 2: Logování / Debugging událostí

Přihlaste se ke všem událostem pro debugging:

```typescript
// Logování událostí pouze pro vývoj
if (process.env.NODE_ENV === 'development') {
  await EventBus.subscribe(bus, '*', (event, topic) => {
    console.log(`[DEBUG] ${new Date().toISOString()} ${topic}:`,
      JSON.stringify(event, null, 2));
  });
}
```

### Vzor 3: Přehrávání událostí pro testování

Použijte `publishSync` pro zajištění deterministického spuštění testů:

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('Flow objednávky', () => {
  it('odešle potvrzovací email při vytvoření objednávky', async () => {
    const bus = await EventBus.start();
    const emailSent = vi.fn();

    await EventBus.subscribe(bus, 'order.placed', () => {
      emailSent();
    });

    await EventBus.publishSync(bus, 'order.placed', { orderId: '123' });

    expect(emailSent).toHaveBeenCalledOnce();

    await EventBus.stop(bus);
  });
});
```

## Architektura EventBusu

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       INTERNÍ STRUKTURA EVENTBUSU                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                      EventBus GenServer                              │    │
│  │                                                                      │    │
│  │  Stav:                                                               │    │
│  │  ┌───────────────────────────────────────────────────────────────┐   │    │
│  │  │  subscriptions: Map<id, { pattern, handler }>                 │   │    │
│  │  │  patternIndex: Map<pattern, Set<subscription_ids>>            │   │    │
│  │  │  nextSubscriptionId: number                                   │   │    │
│  │  └───────────────────────────────────────────────────────────────┘   │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  publish(topic, message)                     subscribe(pattern, handler)    │
│         │                                             │                     │
│         ▼                                             ▼                     │
│  ┌──────────────┐                            ┌──────────────┐               │
│  │ cast: Publish│                            │ call: Subscribe              │
│  └──────┬───────┘                            └──────┬───────┘               │
│         │                                           │                       │
│         ▼                                           ▼                       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                       handleCast / handleCall                         │   │
│  │                                                                       │   │
│  │  Při Publish:                         Při Subscribe:                  │   │
│  │  1. Pro každý odběr                   1. Vygeneruj unikátní ID        │   │
│  │  2. Pokud pattern odpovídá topic      2. Ulož {id, pattern, handler}  │   │
│  │  3. Zavolej handler(message, topic)   3. Přidej do patternIndex       │   │
│  │  4. Zachyť chyby (nepropaguj)         4. Vrať funkci pro odhlášení    │   │
│  │                                                                       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Cvičení: Notifikační hub

Vytvořte notifikační hub, který směruje zprávy do různých kanálů podle typu události:

**Požadavky:**
1. Podpora tří notifikačních kanálů: email, SMS a push
2. Každý kanál se přihlašuje ke specifickým vzorům událostí
3. Sledování statistik doručení pro každý kanál
4. Podpora prioritních událostí, které jdou do všech kanálů

**Výchozí kód:**

```typescript
import { EventBus, type EventBusRef } from '@hamicek/noex';

interface NotificationEvent {
  userId: string;
  title: string;
  body: string;
  priority?: 'low' | 'normal' | 'high';
}

function createNotificationHub() {
  let bus: EventBusRef;
  const stats = {
    email: 0,
    sms: 0,
    push: 0,
  };

  return {
    async start() {
      bus = await EventBus.start({ name: 'notifications' });

      // TODO: Přihlaste email kanál k 'notify.email' a 'notify.all'
      // TODO: Přihlaste SMS kanál k 'notify.sms' a 'notify.all'
      // TODO: Přihlaste push kanál k 'notify.push' a 'notify.all'
      // TODO: Vysoká priorita ('notify.priority') jde do VŠECH kanálů
    },

    sendEmail(event: NotificationEvent): void {
      // TODO: Publikovat do email kanálu
    },

    sendSms(event: NotificationEvent): void {
      // TODO: Publikovat do SMS kanálu
    },

    sendPush(event: NotificationEvent): void {
      // TODO: Publikovat do push kanálu
    },

    sendAll(event: NotificationEvent): void {
      // TODO: Publikovat do všech kanálů
    },

    sendPriority(event: NotificationEvent): void {
      // TODO: Publikovat událost s vysokou prioritou
    },

    getStats() {
      return { ...stats };
    },

    async stop() {
      await EventBus.stop(bus);
    },
  };
}
```

<details>
<summary><strong>Řešení</strong></summary>

```typescript
import { EventBus, type EventBusRef } from '@hamicek/noex';

interface NotificationEvent {
  userId: string;
  title: string;
  body: string;
  priority?: 'low' | 'normal' | 'high';
}

function createNotificationHub() {
  let bus: EventBusRef;
  const stats = {
    email: 0,
    sms: 0,
    push: 0,
  };

  // Handlery kanálů (v produkci by skutečně odesílaly notifikace)
  function handleEmail(event: NotificationEvent) {
    console.log(`[EMAIL] Pro: ${event.userId} | ${event.title}: ${event.body}`);
    stats.email++;
  }

  function handleSms(event: NotificationEvent) {
    console.log(`[SMS] Pro: ${event.userId} | ${event.title}`);
    stats.sms++;
  }

  function handlePush(event: NotificationEvent) {
    console.log(`[PUSH] Pro: ${event.userId} | ${event.title}: ${event.body}`);
    stats.push++;
  }

  return {
    async start() {
      bus = await EventBus.start({ name: 'notifications' });

      // Email kanál: reaguje na email a broadcast události
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.email',
        handleEmail
      );
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.all',
        handleEmail
      );
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.priority',
        handleEmail
      );

      // SMS kanál: reaguje na sms a broadcast události
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.sms',
        handleSms
      );
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.all',
        handleSms
      );
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.priority',
        handleSms
      );

      // Push kanál: reaguje na push a broadcast události
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.push',
        handlePush
      );
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.all',
        handlePush
      );
      await EventBus.subscribe<NotificationEvent>(
        bus,
        'notify.priority',
        handlePush
      );
    },

    sendEmail(event: NotificationEvent): void {
      EventBus.publish(bus, 'notify.email', event);
    },

    sendSms(event: NotificationEvent): void {
      EventBus.publish(bus, 'notify.sms', event);
    },

    sendPush(event: NotificationEvent): void {
      EventBus.publish(bus, 'notify.push', event);
    },

    sendAll(event: NotificationEvent): void {
      EventBus.publish(bus, 'notify.all', event);
    },

    sendPriority(event: NotificationEvent): void {
      // Označit jako vysoká priorita a poslat na dedikované prioritní téma
      EventBus.publish(bus, 'notify.priority', {
        ...event,
        priority: 'high',
      });
    },

    getStats() {
      return { ...stats };
    },

    async stop() {
      await EventBus.stop(bus);
    },
  };
}

// Test notifikačního hubu
async function main() {
  const hub = createNotificationHub();
  await hub.start();

  // Odeslat do konkrétních kanálů
  hub.sendEmail({ userId: 'u1', title: 'Vítejte', body: 'Vítejte v naší aplikaci!' });
  hub.sendSms({ userId: 'u2', title: 'Kód', body: 'Váš kód je 1234' });
  hub.sendPush({ userId: 'u3', title: 'Nová zpráva', body: 'Máte novou zprávu' });

  // Odeslat do všech kanálů
  hub.sendAll({ userId: 'u4', title: 'Oznámení', body: 'Údržba systému dnes v noci' });

  // Prioritní notifikace (dorazí do všech kanálů)
  hub.sendPriority({ userId: 'u5', title: 'URGENTNÍ', body: 'Bezpečnostní varování!' });

  // Počkat na async handlery
  await new Promise((resolve) => setTimeout(resolve, 100));

  console.log('Statistiky:', hub.getStats());
  // Statistiky: { email: 3, sms: 3, push: 3 }
  // (1 přímý + 1 all + 1 priority pro každý kanál)

  await hub.stop();
}

main();
```

**Alternativní přístup pomocí wildcardů:**

```typescript
// Elegantnější: použít wildcard vzor pro broadcast témata
async start() {
  bus = await EventBus.start({ name: 'notifications' });

  // Každý kanál se přihlašuje ke svému tématu + wildcard pro broadcast
  await EventBus.subscribe<NotificationEvent>(bus, 'notify.email', handleEmail);
  await EventBus.subscribe<NotificationEvent>(bus, 'notify.sms', handleSms);
  await EventBus.subscribe<NotificationEvent>(bus, 'notify.push', handlePush);

  // Broadcast handler se vzorem 'notify.broadcast.*'
  await EventBus.subscribe<NotificationEvent>(bus, 'notify.broadcast.*', (event, topic) => {
    // Směrovat do všech kanálů pro broadcast události
    handleEmail(event);
    handleSms(event);
    handlePush(event);
  });
}

sendAll(event: NotificationEvent): void {
  EventBus.publish(bus, 'notify.broadcast.all', event);
}

sendPriority(event: NotificationEvent): void {
  EventBus.publish(bus, 'notify.broadcast.priority', {
    ...event,
    priority: 'high',
  });
}
```

**Designová rozhodnutí:**

1. **Oddělené odběry pro každé téma** — Jasné a explicitní směrování
2. **Sledování statistik v handlerech** — Každý handler inkrementuje svůj čítač kanálu
3. **Fire-and-forget publikování** — Notifikace jsou async; nečekáme na doručení
4. **Broadcast přes dedikovaná témata** — `notify.all` a `notify.priority` dorazí do všech kanálů

</details>

## Shrnutí

**Klíčové poznatky:**

- **EventBus poskytuje pub/sub zasílání zpráv** — Odděluje producenty událostí od konzumentů
- **Tři typy vzorů** — Přesná shoda, jednúrovňový wildcard (`*`) a globální wildcard
- **Dva režimy publikování** — `publish()` pro fire-and-forget, `publishSync()` pro garantované doručení
- **Handlery odolné vůči chybám** — Jeden selhávající handler neovlivní ostatní
- **Více nezávislých busů** — Izolujte různé doménové události

**EventBus vs přímá komunikace:**

| Scénář | Použít EventBus | Použít call/cast |
|--------|-----------------|------------------|
| Více konzumentů | ✅ | ❌ |
| Potřeba odpovědi | ❌ | ✅ |
| Volná vazba | ✅ | ❌ |
| Notifikace událostí | ✅ | ❌ |
| Kontrakty služeb | ❌ | ✅ |
| Testování/debugging | ✅ (s `*`) | ❌ |

**Pamatujte:**

> EventBus vyniká, když potřebujete vysílat události, aniž byste věděli (nebo se starali), kdo poslouchá. Udržujte témata událostí konzistentní a dobře zdokumentovaná — stávají se kontraktem mezi publishery a subscribery.

---

Další: [Cache](./02-cache.md)
