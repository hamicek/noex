# TimerService

V předchozí kapitole jste se naučili chránit služby pomocí rate limitingu. Nyní se budeme věnovat další běžné potřebě: **plánování operací do budoucnosti**. noex poskytuje vestavěnou službu TimerService, která doručuje zprávy v zadaných časech — a na rozdíl od běžných timerů tyto přežijí restarty procesů.

## Co se naučíte

- Proč jsou trvalé timery nezbytné pro spolehlivé plánování
- Konfigurovat jednorázové a opakující se timery
- Persistovat timery přes restarty pomocí storage adapterů
- Budovat systémy plánovaných úloh, které přežijí pády
- Spravovat a dotazovat se na čekající timery

## Proč trvalé timery?

JavaScriptový `setTimeout` a `setInterval` fungují dobře pro krátkodobé operace, ale mají kritickou vadu: **nepřežijí restarty**. Když váš proces spadne nebo se přenasazuje, všechny čekající timery jsou ztraceny.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              BĚŽNÉ TIMERY VS TRVALÉ TIMERY                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BĚŽNÉ TIMERY (setTimeout):          TRVALÉ TIMERY (TimerService):          │
│                                                                             │
│  ┌─────────────────────────┐         ┌─────────────────────────┐            │
│  │ Plán: email za 1h       │         │ Plán: email za 1h       │            │
│  │ Timer ID: 12345         │         │ Timer ID: dtimer_1      │            │
│  └───────────┬─────────────┘         └───────────┬─────────────┘            │
│              │                                   │                          │
│              ▼                                   ▼                          │
│  ┌─────────────────────────┐         ┌─────────────────────────┐            │
│  │ Za 30 min: deploy!      │         │ Za 30 min: deploy!      │            │
│  │ Proces se restartuje... │         │ Proces se restartuje... │            │
│  │                         │         │                         │            │
│  │ ❌ Timer ZTRACEN!       │         │ ✓ Timer obnoven ze      │            │
│  │ Email nikdy neodeslán   │         │   storage adapteru      │            │
│  └─────────────────────────┘         └───────────┬─────────────┘            │
│                                                  │                          │
│                                                  ▼                          │
│                                      ┌─────────────────────────┐            │
│                                      │ Za 30 min: vykonán!     │            │
│                                      │ ✓ Email odeslán         │            │
│                                      └─────────────────────────┘            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Použijte TimerService když:**
- Plánujete operace, které se musí stát i po restartech
- Implementujete systémy připomínek, zpožděné notifikace
- Budujete mechanismy opakování s exponenciálním backoffem
- Vytváříte plánované úlohy údržby
- Implementujete obnovy předplatného, expirace trial období

**Nepoužívejte TimerService když:**
- Potřebujete sub-sekundovou přesnost (použijte `setTimeout` nebo `GenServer.sendAfter`)
- Timery jsou velmi krátkodobé (< 1 minuta) a ztráta je přijatelná
- Už máte dedikovanou frontu úloh (Redis, BullMQ, atd.)

## Jak TimerService funguje

TimerService je GenServer, který periodicky kontroluje expirované timery a doručuje zprávy pomocí `cast`:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      ARCHITEKTURA TIMER SERVICE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐     schedule()     ┌──────────────────────────────┐        │
│  │   Klient    │ ─────────────────► │        TimerService          │        │
│  └─────────────┘                    │  ┌───────────────────────┐   │        │
│                                     │  │ In-Memory Timer Mapa  │   │        │
│  ┌─────────────┐     cast(msg)      │  │ ┌─────────────────┐   │   │        │
│  │   Cílový    │ ◄───────────────── │  │ │ id: dtimer_1    │   │   │        │
│  │  GenServer  │                    │  │ │ fireAt: 1706xxx │   │   │        │
│  └─────────────┘                    │  │ │ target: ref     │   │   │        │
│                                     │  │ │ message: {...}  │   │   │        │
│                                     │  │ └─────────────────┘   │   │        │
│                                     │  └───────────┬───────────┘   │        │
│                                     └──────────────┼───────────────┘        │
│                                                    │                        │
│                                                    │ persist/restore        │
│                                                    ▼                        │
│                                     ┌──────────────────────────────┐        │
│                                     │      Storage Adapter         │        │
│                                     │  (Memory/File/SQLite)        │        │
│                                     └──────────────────────────────┘        │
│                                                                             │
│  Tick cyklus (konfigurovatelný interval, výchozí 1s):                       │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  1. Zkontroluj všechny timery kde fireAt <= now                        │ │
│  │  2. Pro každý expirovaný timer:                                        │ │
│  │     - Cast zprávu cílovému GenServeru                                  │ │
│  │     - Pokud repeat: přeplanuj s novým fireAt                           │ │
│  │     - Pokud jednorázový: odstraň ze storage                            │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Klíčové charakteristiky:
- Timery jsou uloženy v paměti A persistovány do storage adapteru
- Při restartu jsou všechny čekající timery automaticky obnoveny
- Zprávy jsou doručeny pomocí `GenServer.cast()` (fire-and-forget)
- Check interval určuje rozlišení timeru (výchozí: 1 sekunda)

## Spuštění TimerService

TimerService vyžaduje storage adapter pro persistenci:

```typescript
import { TimerService, MemoryAdapter, FileAdapter, SQLiteAdapter } from '@hamicek/noex';

// Pro vývoj/testování: MemoryAdapter (nepersistuje přes restarty)
const devTimers = await TimerService.start({
  adapter: new MemoryAdapter(),
});

// Pro jednoduchou persistenci: FileAdapter
const fileTimers = await TimerService.start({
  adapter: new FileAdapter('./data/timers'),
});

// Pro produkci: SQLiteAdapter
const prodTimers = await TimerService.start({
  adapter: new SQLiteAdapter('./data/timers.db'),
  checkIntervalMs: 500,  // Kontrola každých 500ms pro větší přesnost
  name: 'app-timers',    // Volitelné: registrace v process registry
});

// Kontrola, zda běží
console.log(TimerService.isRunning(prodTimers)); // true

// Čisté vypnutí
await TimerService.stop(prodTimers);
```

### Konfigurační možnosti

| Možnost | Typ | Povinné | Výchozí | Popis |
|---------|-----|---------|---------|-------|
| `adapter` | `StorageAdapter` | Ano | — | Storage backend pro persistenci |
| `checkIntervalMs` | `number` | Ne | `1000` | Jak často kontrolovat expirované timery |
| `name` | `string` | Ne | — | Jméno v registry pro lookup procesu |

### Doporučení pro check interval

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   PRŮVODCE VOLBOU CHECK INTERVALU                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Check Interval │ Nejlepší pro                    │ Kompromisy              │
│  ───────────────┼─────────────────────────────────┼───────────────────────  │
│  100ms          │ Téměř real-time notifikace      │ Vyšší využití CPU       │
│  500ms          │ Uživatelské připomínky          │ Dobrá rovnováha         │
│  1000ms (1s)    │ Obecné účely (výchozí)          │ Až 1s zpoždění          │
│  5000ms (5s)    │ Úlohy na pozadí                 │ Nižší režie             │
│  60000ms (1m)   │ Dlouhodobé plánované úlohy      │ Hrubá granularita       │
│                                                                             │
│  Pravidlo: checkIntervalMs by měl být maximálně polovinou nejkratšího timeru│
│  Pokud jsou timery typicky 5+ minut, 1s check interval stačí                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Plánování jednorázových timerů

Naplánujte timer, který se spustí jednou po zpoždění:

```typescript
import { TimerService, GenServer, MemoryAdapter } from '@hamicek/noex';

// Vytvořte cílový GenServer, který bude přijímat zprávy z timeru
const notificationHandler = await GenServer.start({
  init: () => ({ sentCount: 0 }),
  handleCall: (msg, state) => {
    if (msg === 'getCount') return [state.sentCount, state];
    return [undefined, state];
  },
  handleCast: (msg, state) => {
    if (msg.type === 'sendNotification') {
      console.log(`Odesílám notifikaci: ${msg.text}`);
      return { sentCount: state.sentCount + 1 };
    }
    return state;
  },
});

// Spuštění timer service
const timers = await TimerService.start({
  adapter: new MemoryAdapter(),
});

// Naplánovat notifikaci za 5 sekund
const timerId = await TimerService.schedule(
  timers,
  notificationHandler,
  { type: 'sendNotification', text: 'Vaše objednávka byla odeslána!' },
  5000,  // 5 sekund zpoždění
);

console.log(`Naplánovaný timer: ${timerId}`);
// Výstup: Naplánovaný timer: dtimer_1_lx2k3m

// Timer se spustí za 5 sekund:
// Výstup: Odesílám notifikaci: Vaše objednávka byla odeslána!
```

### Formát Timer ID

Timer ID následují vzor `dtimer_{counter}_{timestamp}`:
- `dtimer_` — prefix pro trvalé timery
- `{counter}` — inkrementující číslo pro unikátnost
- `{timestamp}` — base36-kódovaný čas vytvoření

Tento formát zajišťuje globálně unikátní ID i přes restarty.

## Plánování opakujících se timerů

Pro periodické úlohy použijte volbu `repeat`:

```typescript
// Health check každých 30 sekund
const healthCheckId = await TimerService.schedule(
  timers,
  monitorService,
  { type: 'healthCheck' },
  30000,  // Počáteční zpoždění: 30 sekund
  { repeat: 30000 },  // Pak opakovat každých 30 sekund
);

// Hodinová generace reportů
const reportId = await TimerService.schedule(
  timers,
  reportService,
  { type: 'generateReport', period: 'hourly' },
  60000,  // První report za 1 minutu
  { repeat: 3600000 },  // Pak každou hodinu
);

// Opakující se timery pokračují, dokud nejsou zrušeny
await TimerService.cancel(timers, healthCheckId);
```

### Jednorázový vs opakující se

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                  JEDNORÁZOVÉ VS OPAKUJÍCÍ SE TIMERY                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  JEDNORÁZOVÝ TIMER:                                                         │
│  ┌─────┐      zpoždění      ┌─────┐                                         │
│  │START│ ─────────────────► │FIRE │ ──► Timer odstraněn ze storage          │
│  └─────┘       5000ms       └─────┘                                         │
│                                                                             │
│  Použijte pro: linky pro reset hesla, zpožděné emaily, jednorázové          │
│                připomínky                                                   │
│                                                                             │
│  ═══════════════════════════════════════════════════════════════════════    │
│                                                                             │
│  OPAKUJÍCÍ SE TIMER:                                                        │
│  ┌─────┐  zpoždění  ┌─────┐   repeat   ┌─────┐   repeat   ┌─────┐          │
│  │START│ ─────────► │FIRE │ ─────────► │FIRE │ ─────────► │FIRE │ ──► ...  │
│  └─────┘   5000ms   └─────┘   5000ms   └─────┘   5000ms   └─────┘          │
│                                                                             │
│  Použijte pro: health checks, sběr metrik, periodický úklid                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Rušení timerů

Zrušte timer před jeho spuštěním:

```typescript
// Naplánovat timer
const timerId = await TimerService.schedule(
  timers,
  targetRef,
  { type: 'sendReminder' },
  300000,  // 5 minut
);

// Uživatel zamítl připomínku, zrušit timer
const wasCancelled = await TimerService.cancel(timers, timerId);

if (wasCancelled) {
  console.log('Timer úspěšně zrušen');
} else {
  console.log('Timer nenalezen (již se spustil nebo nikdy neexistoval)');
}
```

### Návratové hodnoty cancel

| Návrat | Význam |
|--------|--------|
| `true` | Timer čekal a byl zrušen |
| `false` | Timer nenalezen (již se spustil, zrušen nebo neplatné ID) |

## Dotazování na timery

### Získání jednoho timeru

```typescript
const timerId = await TimerService.schedule(
  timers,
  targetRef,
  { type: 'sendEmail', to: 'user@example.com' },
  60000,
);

// Získat detaily timeru
const entry = await TimerService.get(timers, timerId);

if (entry) {
  console.log('Timer nalezen:');
  console.log(`  ID: ${entry.id}`);
  console.log(`  Spustí se v: ${new Date(entry.fireAt).toISOString()}`);
  console.log(`  Cíl: ${entry.targetRef.id}`);
  console.log(`  Zpráva: ${JSON.stringify(entry.message)}`);
  console.log(`  Opakování: ${entry.repeat ?? 'jednorázový'}`);
} else {
  console.log('Timer nenalezen');
}
```

### Seznam všech čekajících timerů

```typescript
const allTimers = await TimerService.getAll(timers);

console.log(`${allTimers.length} čekajících timerů:`);
for (const entry of allTimers) {
  const fireDate = new Date(entry.fireAt);
  const remaining = entry.fireAt - Date.now();
  console.log(`  ${entry.id}: spustí se za ${Math.ceil(remaining / 1000)}s`);
}
```

### Rozhraní TimerEntry

```typescript
interface TimerEntry {
  id: string;           // Unikátní identifikátor timeru
  fireAt: number;       // Unix timestamp (ms) kdy se timer spustí
  targetRef: {          // Reference na cílový proces
    id: string;
    nodeId?: string;    // Pro distribuované setupy
  };
  message: unknown;     // Zpráva k doručení pomocí cast
  repeat?: number;      // Interval opakování v ms (undefined = jednorázový)
}
```

## Persistence a obnova

TimerService persistuje každý timer do storage adapteru. Při restartu jsou čekající timery automaticky obnoveny:

```typescript
import { TimerService, FileAdapter, GenServer } from '@hamicek/noex';

// Session 1: Naplánovat timer
const adapter = new FileAdapter('./data/timers');
const timers = await TimerService.start({ adapter });
const target = await GenServer.start(/* ... */);

await TimerService.schedule(
  timers,
  target,
  { type: 'reminder', text: 'Schůzka za 5 minut' },
  300000,  // 5 minut
);

// Proces se zastaví (deploy, pád, atd.)
await TimerService.stop(timers);

// --- Později (i po restartu procesu) ---

// Session 2: Timery se automaticky obnoví
const timers2 = await TimerService.start({ adapter });

const restored = await TimerService.getAll(timers2);
console.log(`Obnoveno ${restored.length} timer(ů)`);
// Výstup: Obnoveno 1 timer(ů)

// Timer se spustí v původně plánovaném čase!
```

### Ošetření zpožděných timerů

Timery, které expirují během výpadku, se spustí okamžitě při prvním ticku po restartu:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      OBNOVA ZPOŽDĚNÉHO TIMERU                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Časová osa:                                                                │
│                                                                             │
│  00:00  Naplánovat timer na 00:05                                           │
│    │    ┌─────────────────────┐                                             │
│    ├───►│ Timer uložen: 00:05 │                                             │
│    │    └─────────────────────┘                                             │
│    │                                                                        │
│  00:03  Proces spadne                                                       │
│    │    ┌─────────────────────┐                                             │
│    ├───►│ Proces dole...      │                                             │
│    │    └─────────────────────┘                                             │
│    │                                                                        │
│  00:05  Timer se MĚL spustit (ale proces je dole)                           │
│    │                                                                        │
│  00:10  Proces se restartuje                                                │
│    │    ┌─────────────────────┐                                             │
│    ├───►│ Načíst timery ze    │                                             │
│    │    │ storage adapteru    │                                             │
│    │    └─────────────────────┘                                             │
│    │    ┌─────────────────────┐                                             │
│    ├───►│ První tick: check   │                                             │
│    │    │ fireAt <= now?      │                                             │
│    │    │ ANO! Spustit        │                                             │
│    │    │ zpožděný timer      │                                             │
│    │    │ okamžitě            │                                             │
│    │    └─────────────────────┘                                             │
│    │                                                                        │
│  00:10  Zpráva doručena (5 min pozdě, ale neztracena!)                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Toto chování "dohánění" zajišťuje, že žádné naplánované operace nejsou ztraceny, ani po delším výpadku.

## Praktický příklad: Systém připomínek

Zde je produkčně připravený systém připomínek používající TimerService:

```typescript
import {
  TimerService,
  GenServer,
  SQLiteAdapter,
  type GenServerBehavior,
  type GenServerRef,
  type TimerServiceRef,
} from '@hamicek/noex';

// Typy
interface Reminder {
  id: string;
  userId: string;
  text: string;
  scheduledFor: Date;
  timerId: string;
}

interface ReminderState {
  reminders: Map<string, Reminder>;
  timerService: TimerServiceRef;
}

type ReminderCall =
  | { type: 'create'; userId: string; text: string; delayMs: number }
  | { type: 'cancel'; id: string }
  | { type: 'list'; userId: string }
  | { type: 'get'; id: string };

type ReminderCast =
  | { type: 'fire'; reminderId: string };

type ReminderReply = Reminder | Reminder[] | boolean | undefined;

// Generátor ID připomínek
let reminderIdCounter = 0;
function generateReminderId(): string {
  return `rem_${++reminderIdCounter}_${Date.now().toString(36)}`;
}

// Behavior ReminderService
function createReminderBehavior(
  timerService: TimerServiceRef,
  onReminderFired: (reminder: Reminder) => void,
): GenServerBehavior<ReminderState, ReminderCall, ReminderCast, ReminderReply> {
  return {
    init: () => ({
      reminders: new Map(),
      timerService,
    }),

    handleCall: async (msg, state, self) => {
      switch (msg.type) {
        case 'create': {
          const id = generateReminderId();
          const scheduledFor = new Date(Date.now() + msg.delayMs);

          // Naplánovat timer
          const timerId = await TimerService.schedule(
            state.timerService,
            self,
            { type: 'fire', reminderId: id },
            msg.delayMs,
          );

          const reminder: Reminder = {
            id,
            userId: msg.userId,
            text: msg.text,
            scheduledFor,
            timerId,
          };

          const newReminders = new Map(state.reminders);
          newReminders.set(id, reminder);

          return [reminder, { ...state, reminders: newReminders }];
        }

        case 'cancel': {
          const reminder = state.reminders.get(msg.id);
          if (!reminder) {
            return [false, state];
          }

          // Zrušit timer
          await TimerService.cancel(state.timerService, reminder.timerId);

          const newReminders = new Map(state.reminders);
          newReminders.delete(msg.id);

          return [true, { ...state, reminders: newReminders }];
        }

        case 'list': {
          const userReminders = Array.from(state.reminders.values())
            .filter(r => r.userId === msg.userId)
            .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
          return [userReminders, state];
        }

        case 'get': {
          return [state.reminders.get(msg.id), state];
        }
      }
    },

    handleCast: (msg, state) => {
      if (msg.type === 'fire') {
        const reminder = state.reminders.get(msg.reminderId);
        if (reminder) {
          // Spustit callback připomínky
          onReminderFired(reminder);

          // Odstranit ze stavu (jednorázová připomínka)
          const newReminders = new Map(state.reminders);
          newReminders.delete(msg.reminderId);
          return { ...state, reminders: newReminders };
        }
      }
      return state;
    },
  };
}

// API ReminderService
interface ReminderService {
  create(userId: string, text: string, delayMs: number): Promise<Reminder>;
  cancel(id: string): Promise<boolean>;
  list(userId: string): Promise<Reminder[]>;
  get(id: string): Promise<Reminder | undefined>;
  stop(): Promise<void>;
}

async function createReminderService(
  onReminderFired: (reminder: Reminder) => void,
): Promise<ReminderService> {
  const adapter = new SQLiteAdapter('./data/reminder-timers.db');
  const timerService = await TimerService.start({
    adapter,
    checkIntervalMs: 1000,
  });

  type ReminderRef = GenServerRef<ReminderState, ReminderCall, ReminderCast, ReminderReply>;
  const ref: ReminderRef = await GenServer.start(
    createReminderBehavior(timerService, onReminderFired)
  );

  return {
    async create(userId, text, delayMs) {
      return await GenServer.call(ref, { type: 'create', userId, text, delayMs }) as Reminder;
    },
    async cancel(id) {
      return await GenServer.call(ref, { type: 'cancel', id }) as boolean;
    },
    async list(userId) {
      return await GenServer.call(ref, { type: 'list', userId }) as Reminder[];
    },
    async get(id) {
      return await GenServer.call(ref, { type: 'get', id }) as Reminder | undefined;
    },
    async stop() {
      await GenServer.stop(ref);
      await TimerService.stop(timerService);
    },
  };
}

// Příklad použití
async function main() {
  const reminderService = await createReminderService((reminder) => {
    console.log(`\n🔔 PŘIPOMÍNKA pro ${reminder.userId}: ${reminder.text}`);
  });

  // Vytvořit několik připomínek
  const reminder1 = await reminderService.create(
    'user:alice',
    'Zkontrolovat pull request',
    5000,  // 5 sekund
  );
  console.log(`Vytvořena připomínka: ${reminder1.id}`);
  console.log(`  Spustí se v: ${reminder1.scheduledFor.toISOString()}`);

  const reminder2 = await reminderService.create(
    'user:alice',
    'Týmový standup meeting',
    10000,  // 10 sekund
  );
  console.log(`Vytvořena připomínka: ${reminder2.id}`);

  const reminder3 = await reminderService.create(
    'user:bob',
    'Deploy do produkce',
    3000,  // 3 sekundy
  );
  console.log(`Vytvořena připomínka: ${reminder3.id}`);

  // Seznam připomínek Alice
  const aliceReminders = await reminderService.list('user:alice');
  console.log(`\nAlice má ${aliceReminders.length} připomínek:`);
  for (const r of aliceReminders) {
    console.log(`  - ${r.text} (${r.scheduledFor.toISOString()})`);
  }

  // Zrušit jednu připomínku
  await reminderService.cancel(reminder2.id);
  console.log(`\nZrušena připomínka: ${reminder2.id}`);

  // Počkat na spuštění připomínek
  console.log('\nČekám na připomínky...');
  await new Promise(resolve => setTimeout(resolve, 15000));

  await reminderService.stop();
  console.log('\nSlužba zastavena');
}

main();
```

**Očekávaný výstup:**

```
Vytvořena připomínka: rem_1_lx3abc
  Spustí se v: 2024-01-25T10:00:05.000Z
Vytvořena připomínka: rem_2_lx3abd
Vytvořena připomínka: rem_3_lx3abe

Alice má 2 připomínek:
  - Zkontrolovat pull request (2024-01-25T10:00:05.000Z)
  - Týmový standup meeting (2024-01-25T10:00:10.000Z)

Zrušena připomínka: rem_2_lx3abd

Čekám na připomínky...

🔔 PŘIPOMÍNKA pro user:bob: Deploy do produkce

🔔 PŘIPOMÍNKA pro user:alice: Zkontrolovat pull request

Služba zastavena
```

## Cvičení: Plánovač úloh

Vytvořte plánovač úloh, který:
1. Umožňuje plánování úloh se specifikací zpoždění podobnou cronu
2. Podporuje jednorázové a opakující se úlohy
3. Persistuje úlohy přes restarty
4. Poskytuje způsob, jak zobrazit, pozastavit a obnovit úlohy
5. Loguje vykonání úloh s informací o časování

**Výchozí kód:**

```typescript
import {
  TimerService,
  GenServer,
  MemoryAdapter,
  type GenServerBehavior,
  type GenServerRef,
  type TimerServiceRef,
} from '@hamicek/noex';

interface ScheduledTask {
  id: string;
  name: string;
  handler: () => Promise<void> | void;
  intervalMs?: number;  // undefined = jednorázová
  paused: boolean;
  lastRun?: Date;
  nextRun: Date;
  timerId?: string;
}

interface TaskRunner {
  start(): Promise<void>;
  scheduleOnce(name: string, handler: () => Promise<void> | void, delayMs: number): Promise<string>;
  scheduleRepeating(name: string, handler: () => Promise<void> | void, intervalMs: number): Promise<string>;
  pause(taskId: string): Promise<boolean>;
  resume(taskId: string): Promise<boolean>;
  cancel(taskId: string): Promise<boolean>;
  list(): Promise<ScheduledTask[]>;
  stop(): Promise<void>;
}

function createTaskRunner(): TaskRunner {
  // TODO: Implementovat plánovač úloh

  return {
    async start() {
      // TODO: Spustit timer service
    },

    async scheduleOnce(name, handler, delayMs) {
      // TODO: Naplánovat jednorázovou úlohu
      throw new Error('Neimplementováno');
    },

    async scheduleRepeating(name, handler, intervalMs) {
      // TODO: Naplánovat opakující se úlohu
      throw new Error('Neimplementováno');
    },

    async pause(taskId) {
      // TODO: Pozastavit úlohu (zrušit timer, ponechat úlohu v seznamu)
      throw new Error('Neimplementováno');
    },

    async resume(taskId) {
      // TODO: Obnovit pozastavenou úlohu
      throw new Error('Neimplementováno');
    },

    async cancel(taskId) {
      // TODO: Zrušit a odstranit úlohu
      throw new Error('Neimplementováno');
    },

    async list() {
      // TODO: Seznam všech úloh s jejich stavem
      throw new Error('Neimplementováno');
    },

    async stop() {
      // TODO: Zastavit všechny timery a uklidit
    },
  };
}
```

<details>
<summary><strong>Řešení</strong></summary>

```typescript
import {
  TimerService,
  GenServer,
  MemoryAdapter,
  type GenServerBehavior,
  type GenServerRef,
  type TimerServiceRef,
} from '@hamicek/noex';

interface ScheduledTask {
  id: string;
  name: string;
  handler: () => Promise<void> | void;
  intervalMs?: number;
  paused: boolean;
  lastRun?: Date;
  nextRun: Date;
  timerId?: string;
}

interface TaskRunnerState {
  tasks: Map<string, ScheduledTask>;
  timerService: TimerServiceRef;
}

type TaskCall =
  | { type: 'scheduleOnce'; name: string; handler: () => Promise<void> | void; delayMs: number }
  | { type: 'scheduleRepeating'; name: string; handler: () => Promise<void> | void; intervalMs: number }
  | { type: 'pause'; taskId: string }
  | { type: 'resume'; taskId: string }
  | { type: 'cancel'; taskId: string }
  | { type: 'list' };

type TaskCast = { type: 'execute'; taskId: string };

type TaskReply = string | boolean | ScheduledTask[];

let taskIdCounter = 0;
function generateTaskId(): string {
  return `task_${++taskIdCounter}_${Date.now().toString(36)}`;
}

function createTaskRunnerBehavior(
  timerService: TimerServiceRef,
): GenServerBehavior<TaskRunnerState, TaskCall, TaskCast, TaskReply> {
  async function scheduleTimer(
    self: GenServerRef<TaskRunnerState, TaskCall, TaskCast, TaskReply>,
    task: ScheduledTask,
    delayMs: number,
  ): Promise<string> {
    return await TimerService.schedule(
      timerService,
      self,
      { type: 'execute', taskId: task.id },
      delayMs,
      task.intervalMs ? { repeat: task.intervalMs } : undefined,
    );
  }

  return {
    init: () => ({
      tasks: new Map(),
      timerService,
    }),

    handleCall: async (msg, state, self) => {
      switch (msg.type) {
        case 'scheduleOnce': {
          const id = generateTaskId();
          const nextRun = new Date(Date.now() + msg.delayMs);

          const task: ScheduledTask = {
            id,
            name: msg.name,
            handler: msg.handler,
            intervalMs: undefined,
            paused: false,
            nextRun,
          };

          const timerId = await scheduleTimer(self, task, msg.delayMs);
          task.timerId = timerId;

          const newTasks = new Map(state.tasks);
          newTasks.set(id, task);

          console.log(`[TaskRunner] Naplánována jednorázová úloha "${msg.name}" (${id}) na ${nextRun.toISOString()}`);
          return [id, { ...state, tasks: newTasks }];
        }

        case 'scheduleRepeating': {
          const id = generateTaskId();
          const nextRun = new Date(Date.now() + msg.intervalMs);

          const task: ScheduledTask = {
            id,
            name: msg.name,
            handler: msg.handler,
            intervalMs: msg.intervalMs,
            paused: false,
            nextRun,
          };

          const timerId = await scheduleTimer(self, task, msg.intervalMs);
          task.timerId = timerId;

          const newTasks = new Map(state.tasks);
          newTasks.set(id, task);

          console.log(`[TaskRunner] Naplánována opakující se úloha "${msg.name}" (${id}) každých ${msg.intervalMs}ms`);
          return [id, { ...state, tasks: newTasks }];
        }

        case 'pause': {
          const task = state.tasks.get(msg.taskId);
          if (!task || task.paused) {
            return [false, state];
          }

          // Zrušit timer ale ponechat úlohu
          if (task.timerId) {
            await TimerService.cancel(timerService, task.timerId);
          }

          const pausedTask: ScheduledTask = {
            ...task,
            paused: true,
            timerId: undefined,
          };

          const newTasks = new Map(state.tasks);
          newTasks.set(msg.taskId, pausedTask);

          console.log(`[TaskRunner] Pozastavena úloha "${task.name}" (${task.id})`);
          return [true, { ...state, tasks: newTasks }];
        }

        case 'resume': {
          const task = state.tasks.get(msg.taskId);
          if (!task || !task.paused) {
            return [false, state];
          }

          // Vypočítat zpoždění (pro opakující se úlohy použít interval; pro jednorázové vypočítat zbývající)
          const delayMs = task.intervalMs ?? Math.max(0, task.nextRun.getTime() - Date.now());
          const nextRun = new Date(Date.now() + delayMs);

          const resumedTask: ScheduledTask = {
            ...task,
            paused: false,
            nextRun,
          };

          const timerId = await scheduleTimer(self, resumedTask, delayMs);
          resumedTask.timerId = timerId;

          const newTasks = new Map(state.tasks);
          newTasks.set(msg.taskId, resumedTask);

          console.log(`[TaskRunner] Obnovena úloha "${task.name}" (${task.id}), další běh: ${nextRun.toISOString()}`);
          return [true, { ...state, tasks: newTasks }];
        }

        case 'cancel': {
          const task = state.tasks.get(msg.taskId);
          if (!task) {
            return [false, state];
          }

          if (task.timerId) {
            await TimerService.cancel(timerService, task.timerId);
          }

          const newTasks = new Map(state.tasks);
          newTasks.delete(msg.taskId);

          console.log(`[TaskRunner] Zrušena úloha "${task.name}" (${task.id})`);
          return [true, { ...state, tasks: newTasks }];
        }

        case 'list': {
          const taskList = Array.from(state.tasks.values()).map(t => ({
            ...t,
            handler: t.handler,  // Ponechat referenci handleru
          }));
          return [taskList, state];
        }
      }
    },

    handleCast: async (msg, state, self) => {
      if (msg.type === 'execute') {
        const task = state.tasks.get(msg.taskId);
        if (!task || task.paused) {
          return state;
        }

        const startTime = Date.now();
        console.log(`[TaskRunner] Vykonávám úlohu "${task.name}" (${task.id})`);

        try {
          await task.handler();
          const duration = Date.now() - startTime;
          console.log(`[TaskRunner] Úloha "${task.name}" dokončena za ${duration}ms`);
        } catch (error) {
          const duration = Date.now() - startTime;
          console.error(`[TaskRunner] Úloha "${task.name}" selhala po ${duration}ms:`, error);
        }

        // Aktualizovat stav úlohy
        const newTasks = new Map(state.tasks);

        if (task.intervalMs) {
          // Opakující se úloha: aktualizovat lastRun a nextRun
          const updatedTask: ScheduledTask = {
            ...task,
            lastRun: new Date(startTime),
            nextRun: new Date(Date.now() + task.intervalMs),
          };
          newTasks.set(task.id, updatedTask);
        } else {
          // Jednorázová úloha: odstranit ze seznamu
          newTasks.delete(task.id);
        }

        return { ...state, tasks: newTasks };
      }
      return state;
    },
  };
}

interface TaskRunner {
  start(): Promise<void>;
  scheduleOnce(name: string, handler: () => Promise<void> | void, delayMs: number): Promise<string>;
  scheduleRepeating(name: string, handler: () => Promise<void> | void, intervalMs: number): Promise<string>;
  pause(taskId: string): Promise<boolean>;
  resume(taskId: string): Promise<boolean>;
  cancel(taskId: string): Promise<boolean>;
  list(): Promise<ScheduledTask[]>;
  stop(): Promise<void>;
}

function createTaskRunner(): TaskRunner {
  let timerService: TimerServiceRef;
  let ref: GenServerRef<TaskRunnerState, TaskCall, TaskCast, TaskReply>;

  return {
    async start() {
      const adapter = new MemoryAdapter();
      timerService = await TimerService.start({
        adapter,
        checkIntervalMs: 100,  // 100ms rozlišení pro demo
      });

      ref = await GenServer.start(createTaskRunnerBehavior(timerService));
      console.log('[TaskRunner] Spuštěn');
    },

    async scheduleOnce(name, handler, delayMs) {
      return await GenServer.call(ref, { type: 'scheduleOnce', name, handler, delayMs }) as string;
    },

    async scheduleRepeating(name, handler, intervalMs) {
      return await GenServer.call(ref, { type: 'scheduleRepeating', name, handler, intervalMs }) as string;
    },

    async pause(taskId) {
      return await GenServer.call(ref, { type: 'pause', taskId }) as boolean;
    },

    async resume(taskId) {
      return await GenServer.call(ref, { type: 'resume', taskId }) as boolean;
    },

    async cancel(taskId) {
      return await GenServer.call(ref, { type: 'cancel', taskId }) as boolean;
    },

    async list() {
      return await GenServer.call(ref, { type: 'list' }) as ScheduledTask[];
    },

    async stop() {
      await GenServer.stop(ref);
      await TimerService.stop(timerService);
      console.log('[TaskRunner] Zastaven');
    },
  };
}

// Test implementace
async function main() {
  const runner = createTaskRunner();
  await runner.start();

  // Naplánovat jednorázovou úlohu
  const cleanupId = await runner.scheduleOnce(
    'Úklid databáze',
    () => console.log('  → Čistím staré záznamy...'),
    2000,
  );

  // Naplánovat opakující se úlohy
  const metricsId = await runner.scheduleRepeating(
    'Sběr metrik',
    () => console.log('  → Sbírám systémové metriky'),
    3000,
  );

  const heartbeatId = await runner.scheduleRepeating(
    'Heartbeat',
    () => console.log('  → ♥ heartbeat'),
    1500,
  );

  // Seznam počátečních úloh
  console.log('\nPočáteční úlohy:');
  const tasks = await runner.list();
  for (const task of tasks) {
    const status = task.paused ? '⏸ POZASTAVENA' : '▶ AKTIVNÍ';
    const type = task.intervalMs ? `každých ${task.intervalMs}ms` : 'jednorázová';
    console.log(`  ${task.name} (${task.id}): ${status}, ${type}`);
  }

  // Počkat chvíli
  console.log('\nBěžím po dobu 5 sekund...\n');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Pozastavit heartbeat
  console.log('\nPozastavuji heartbeat...');
  await runner.pause(heartbeatId);

  // Počkat déle
  console.log('Běžím další 3 sekundy (heartbeat pozastaven)...\n');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Obnovit heartbeat
  console.log('\nObnovuji heartbeat...');
  await runner.resume(heartbeatId);

  // Počkat déle
  console.log('Běžím další 3 sekundy...\n');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Seznam konečných úloh
  console.log('\nKonečné úlohy:');
  const finalTasks = await runner.list();
  for (const task of finalTasks) {
    const status = task.paused ? '⏸ POZASTAVENA' : '▶ AKTIVNÍ';
    const lastRunStr = task.lastRun ? task.lastRun.toISOString() : 'nikdy';
    console.log(`  ${task.name}: ${status}, poslední běh: ${lastRunStr}`);
  }

  await runner.stop();
}

main();
```

**Klíčová designová rozhodnutí:**

1. **Oddělený stav pro metadata úloh** — Úlohy sledují svůj vlastní stav (paused, lastRun, nextRun) nezávisle na timerech.

2. **Handler uložen v paměti** — Funkce nemohou být serializovány, takže handlery jsou uchovány v paměti. Pro skutečnou persistenci přes restarty byste potřebovali registr úloh, který mapuje jména úloh na handlery.

3. **Pause/Resume** — Pozastavení zruší timer ale ponechá úlohu v seznamu. Obnovení vytvoří nový timer.

4. **Informace o časování** — Každé vykonání úlohy loguje dobu trvání pro monitoring výkonu.

5. **Graceful cleanup** — Jednorázové úlohy jsou automaticky odstraněny po vykonání.

</details>

## Shrnutí

**Klíčové poznatky:**

- **TimerService poskytuje trvalé timery** — Persistují přes restarty pomocí storage adapterů
- **Jednorázové a opakující se** — Použijte volbu `repeat` pro periodické úlohy
- **Automatická obnova** — Zpožděné timery se spustí okamžitě po restartu
- **Doručení zpráv pomocí cast** — Cílový GenServer přijímá zprávy asynchronně
- **Konfigurovatelná přesnost** — `checkIntervalMs` kontroluje rozlišení timeru

**Reference metod:**

| Metoda | Vrací | Popis |
|--------|-------|-------|
| `start(options)` | `Promise<Ref>` | Spustit timer service s adapterem |
| `schedule(ref, target, msg, delay, opts?)` | `Promise<string>` | Naplánovat timer, vrátí timer ID |
| `cancel(ref, timerId)` | `Promise<boolean>` | Zrušit čekající timer |
| `get(ref, timerId)` | `Promise<Entry \| undefined>` | Získat detaily timeru |
| `getAll(ref)` | `Promise<Entry[]>` | Seznam všech čekajících timerů |
| `isRunning(ref)` | `boolean` | Zkontrolovat, zda služba běží |
| `stop(ref)` | `Promise<void>` | Zastavit službu |

**Pamatujte:**

> Trvalé timery zajišťují, že naplánované operace proběhnou i po restartech. Použijte je pro cokoli, co se musí vykonat v konkrétním čase — připomínky, zpožděné notifikace, plánovaná údržba nebo mechanismy opakování. Pro sub-sekundovou přesnost nebo skutečně efemérní timery zůstaňte u `setTimeout` nebo `GenServer.sendAfter`.

---

Další: [Struktura aplikace](../09-application/01-struktura-aplikace.md)
