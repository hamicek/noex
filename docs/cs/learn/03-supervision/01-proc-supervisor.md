# Proč Supervisor?

V předchozích kapitolách jste se naučili vytvářet GenServery, spravovat jejich životní cyklus a komunikovat pomocí `call` a `cast`. Vaše procesy fungují skvěle, když všechno jde dobře. Ale co se stane, když se něco pokazí?

**Procesy selhávají.** Síťová připojení se přeruší. Externí API vyprší. Bugy se prokradou přes testování. V tradičních Node.js aplikacích byste vše obalili do try-catch bloků, přidali logiku pro opakování a doufali, že jste pokryli každý okrajový případ. Je to defenzivní programování dovedené do extrému a stále to nezaručuje spolehlivost.

Supervisoři nabízejí zásadně odlišný přístup: **místo předcházení selháním je přijměte a automaticky se z nich zotavte**.

## Co se naučíte

- Proč procesy selhávají a proč je to v pořádku
- Jak supervisoři poskytují automatické zotavení
- Výhody izolace supervision patternu
- Filozofie "Let it Crash"

## Procesy selhávají - to je normální

Každý produkční systém se nakonec setká se selháními:

- **Externí závislosti selhávají**: API vracejí chyby, databáze ztrácejí připojení, fronty zpráv se stanou nedostupnými
- **Vyčerpávají se zdroje**: Hromadí se memory leaky, vyčerpávají se file descriptory, connection pooly se zaplní
- **Bugy existují**: Okrajové případy projdou testováním, race conditions se projeví pod zátěží, dochází ke korupci dat
- **Hardware má problémy**: Dochází k síťovým partition, selhávají disky, procesy jsou ukončeny kvůli OOM

Tradiční přístup: obalit vše do defenzivního kódu:

```typescript
// Tradiční Node.js - defenzivní programování všude
async function processOrder(orderId: string) {
  let connection;
  try {
    connection = await getConnection();
    try {
      const order = await connection.query('SELECT * FROM orders WHERE id = ?', [orderId]);
      if (!order) {
        throw new Error('Objednávka nenalezena');
      }

      try {
        await paymentService.charge(order.customerId, order.total);
      } catch (paymentError) {
        // Platba selhala - opakovat? rollback? logovat? notifikovat?
        console.error('Platba selhala:', paymentError);
        // V jakém stavu je teď objednávka?
        throw paymentError;
      }

      try {
        await inventoryService.reserve(order.items);
      } catch (inventoryError) {
        // Inventář selhal - je potřeba vrátit platbu?
        try {
          await paymentService.refund(order.customerId, order.total);
        } catch (refundError) {
          // Refund také selhal - co teď?
          console.error('Refund také selhal:', refundError);
        }
        throw inventoryError;
      }

      return order;
    } finally {
      await connection.release();
    }
  } catch (connectionError) {
    // Připojení selhalo - opakovat celou věc?
    console.error('Připojení selhalo:', connectionError);
    throw connectionError;
  }
}
```

Tento kód je:
- **Těžko čitelný**: Skutečná business logika je pohřbena pod error handlingem
- **Těžko udržovatelný**: Každá nová funkce potřebuje vlastní error handling
- **Neúplný**: Co když `connection.release()` vyhodí výjimku? Co když proces spadne mezi platbou a inventářem?
- **Poškozující stav**: Když se chyby kaskádují, nevíte, v jakém stavu věci jsou

## Automatické zotavení se Supervisory

Supervisor je proces, který **monitoruje ostatní procesy** (své děti) a **restartuje je, když selžou**. Místo ošetřování každého možného selhání necháte procesy spadnout a supervisor je restartuje v čistém stavu.

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from '@hamicek/noex';

// Váš proces - zaměřený na business logiku, ne na error handling
interface OrderProcessorState {
  orderId: string;
  status: 'pending' | 'processing' | 'completed';
}

type OrderCall = { type: 'process' } | { type: 'getStatus' };
type OrderCast = never;
type OrderReply = OrderProcessorState['status'];

const orderProcessorBehavior: GenServerBehavior<OrderProcessorState, OrderCall, OrderCast, OrderReply> = {
  init() {
    return { orderId: '', status: 'pending' };
  },

  handleCall(msg, state) {
    switch (msg.type) {
      case 'process':
        // Pokud toto vyhodí výjimku, proces spadne a je restartován
        // Žádný try-catch není potřeba - supervisor zajistí zotavení
        return ['processing', { ...state, status: 'processing' }];
      case 'getStatus':
        return [state.status, state];
    }
  },

  handleCast(_msg, state) {
    return state;
  },
};

// Supervisor sleduje a restartuje při selhání
const supervisor = await Supervisor.start({
  children: [
    {
      id: 'order-processor',
      start: () => GenServer.start(orderProcessorBehavior),
    },
  ],
});
```

Když order processor spadne:
1. Supervisor detekuje selhání okamžitě
2. Nová instance je automaticky spuštěna
3. Nová instance začíná s čistým stavem
4. Systém pokračuje v provozu

**Žádná manuální logika pro opakování. Žádné kaskádující error handlery. Žádný poškozený stav.**

## Izolace - omezení selhání

Každý supervizovaný proces běží v izolaci. Když jeden proces spadne, neovlivní to ostatní:

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'users', start: () => GenServer.start(userServiceBehavior) },
    { id: 'orders', start: () => GenServer.start(orderServiceBehavior) },
    { id: 'payments', start: () => GenServer.start(paymentServiceBehavior) },
    { id: 'notifications', start: () => GenServer.start(notificationBehavior) },
  ],
});
```

Pokud služba `notifications` spadne:
- `users`, `orders` a `payments` **běží dál** bez přerušení
- Pouze `notifications` je restartována
- Uživatelé nezaznamenají úplný výpadek systému

Porovnejte to s tradičním Node.js, kde nezachycená výjimka v jednom modulu může shodit celý proces:

```typescript
// Tradiční Node.js - jedna nezachycená výjimka shodí vše
app.post('/notify', async (req, res) => {
  await sendNotification(req.body); // Pokud toto nečekaně vyhodí...
  res.json({ success: true });
});
// ...celý váš Express server spadne
```

Se supervizí jsou selhání **omezena**. Bug v notifikacích neshodí vaše zpracování plateb.

## Filozofie "Let it Crash"

Tento pattern pochází z Erlang OTP, kde se nazývá "Let it Crash". Filozofie je na první pohled neintuitivní:

> **Nesnažte se předcházet všem selháním. Místo toho udělejte selhání levná a zotavení rychlé.**

Proč to funguje:

1. **Čistý stav při restartu**: Když se proces restartuje, začíná se známým dobrým počátečním stavem. Žádný poškozený stav k debugování.

2. **Jednodušší kód**: Místo ošetřování každé možné chyby se zaměřte na happy path. Zbytek nechte na supervisoru.

3. **Přechodné chyby se vyřeší samy**: Mnoho selhání (síťové výpadky, dočasné vyčerpání zdrojů) se opraví samo, když to zkusíte znovu s čerstvým startem.

4. **Bugy se stanou viditelnými**: Pády jsou logovány a sledovány. Tiché selhání, které poškozují stav, je mnohem těžší diagnostikovat.

```typescript
// Styl "Let it Crash" - zaměřený na happy path
const cacheRefreshBehavior: GenServerBehavior<CacheState, RefreshMsg, never, void> = {
  init() {
    return { data: new Map(), lastRefresh: Date.now() };
  },

  async handleCall(msg, state) {
    if (msg.type === 'refresh') {
      // Pokud toto selže, spadneme a restartujeme s prázdnou cache
      // Supervisor nás restartuje a zkusíme to znovu
      const freshData = await fetchFromDatabase();
      return [undefined, { data: freshData, lastRefresh: Date.now() }];
    }
    return [undefined, state];
  },

  handleCast(_msg, state) {
    return state;
  },
};
```

## Kdy ne "Let it Crash"

Filozofie neznamená ignorovat všechny chyby. Stále byste měli:

- **Validovat vstup na hranicích systému**: Odmítnout neplatná data předtím, než vstoupí do vašich procesů
- **Ošetřovat očekávané chyby elegantně**: Pokud uživatel poskytne neplatné přihlašovací údaje, vraťte chybu, nespadněte
- **Persistovat důležitý stav**: Použijte persistence adaptery, aby stav přežil restarty, když je to potřeba

"Let it Crash" je pro **neočekávaná selhání** - bugy, síťové problémy a okrajové případy, které nemůžete předvídat.

## Analogie z reálného světa

Představte si supervizi jako kuchyni v restauraci:

**Tradiční přístup (bez supervisora)**: Šéfkuchař řeší vše. Pokud jeden kuchař udělá chybu, šéfkuchař ji musí opravit a zároveň řídit všechny ostatní kuchaře a jejich úkoly. Jedna špatná situace se kaskáduje do chaosu.

**Přístup supervize**: Každá stanice (gril, příprava, dezerty) má svého kuchaře. Pokud kuchař na grilu něco spálí, vyhodí to a začne znovu. Šéfkuchař (supervisor) zasáhne, pouze pokud stejná stanice selhává opakovaně. Ostatní stanice fungují normálně dál.

## Shrnutí

- **Procesy selhávají** - síťové problémy, bugy, vyčerpání zdrojů jsou nevyhnutelné
- **Supervisoři automaticky restartují** selhané procesy s čistým stavem
- **Izolace** zajišťuje, že jedno selhání se nekaskáduje do celého systému
- **"Let it Crash"** znamená zaměřit se na happy path a nechat zotavení proběhnout automaticky
- **Jednodušší kód**, protože nepotřebujete defenzivní try-catch bloky všude
- **Použijte supervizi pro neočekávaná selhání**, ne pro očekávané chybové stavy

Pattern supervisoru mění vaše myšlení z "předcházet všem selháním" na "rychle se zotavit z jakéhokoli selhání". Tento přístup pohání telekomunikační systémy s 99,9999999% dostupností (devět devítek) už více než 30 let.

---

Další: [První Supervisor](./02-prvni-supervisor.md)
