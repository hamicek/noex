# Proč persistence?

Všechny GenServery a stavové automaty, které jsme dosud vytvořili, sdílejí jedno kritické omezení: **ztrácejí vše, když se proces zastaví**. Restartujte svou Node.js aplikaci a každý counter se resetuje na nulu, každá session zmizí, každý workflow objednávky se ztratí.

Tato kapitola zkoumá, proč je persistence důležitá a jak persistence systém noex řeší tento fundamentální problém.

## Co se naučíte

- Proč je in-memory stav nedostatečný pro produkční aplikace
- Rozdíl mezi životním cyklem procesu a životním cyklem dat
- Jak persistence umožňuje obnovu po pádu a horizontální škálování
- Kdy použít persistence (a kdy ne)

## Problém: Pomíjivý stav

Zvažte tento counter GenServer, který jsme vytvořili v dřívějších kapitolách:

```typescript
const counterBehavior: GenServerBehavior<
  { count: number },
  'get',
  'increment',
  number
> = {
  init: () => ({ count: 0 }),

  handleCall: (msg, state) => {
    if (msg === 'get') {
      return [state, state.count];
    }
    throw new Error('Unknown message');
  },

  handleCast: (msg, state) => {
    if (msg === 'increment') {
      return { count: state.count + 1 };
    }
    return state;
  },
};

// Start counter
const counter = await GenServer.start(counterBehavior, { name: 'my-counter' });

// Inkrementuj 1000x
for (let i = 0; i < 1000; i++) {
  GenServer.cast(counter, 'increment');
}

// Získej hodnotu
const count = await GenServer.call(counter, 'get');
console.log(count); // 1000

// Teď restartujte aplikaci...
// Hodnota je pryč. Zpět na 0.
```

Toto není bug — takto fungují in-memory procesy. Ale pro reálné aplikace to vytváří vážné problémy.

## Scénáře z reálného světa

### Scénář 1: Deployment

Nasazujete novou verzi vaší aplikace. Během deploymentu:

```
Před deploymentem:
  - UserSession procesy: 5 000 aktivních sessions
  - ShoppingCart procesy: 2 300 košíků s položkami
  - RateLimiter stav: Počty požadavků pro 10 000 IP adres

Po deploymentu:
  - Veškerý stav: PRYČ
  - Uživatelé: Odhlášeni, košíky prázdné, rate limity resetovány
  - Výsledek: Naštvaní zákazníci, bezpečnostní zranitelnost
```

### Scénář 2: Obnova po pádu

Vaše aplikace spadne kvůli out-of-memory chybě:

```
Před pádem:
  - OrderWorkflow ve stavu 'shipped', tracking number uloženo
  - PaymentProcessor s pending transakcemi
  - NotificationQueue s 500 čekajícími emaily

Po pádu:
  - Objednávky uvízly v limbu
  - Platby vyžadují manuální reconciliaci
  - Notifikace navždy ztraceny
```

### Scénář 3: Škálování

Potřebujete přidat více serverů pro zvládnutí zátěže:

```
Server A: UserSession-alice (autentizovaná, preference načteny)
Server B: [Nový server, žádný stav]

Požadavek od Alice → směrován na Server B → "Kdo je Alice?"
```

## Dva životní cykly

Klíčový insight je, že **životní cyklus procesu a životní cyklus dat jsou rozdílné**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PROCES vs DATA ŽIVOTNÍ CYKLUS                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ŽIVOTNÍ CYKLUS PROCESU (pomíjivý):                                         │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐           │
│  │  start   │────▶│ running  │────▶│ stopping │────▶│ stopped  │           │
│  └──────────┘     └──────────┘     └──────────┘     └──────────┘           │
│       │                │                                   │                │
│       │                │                                   │                │
│   sekundy ───────── minuty až hodiny ───────────────── sekundy              │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  ŽIVOTNÍ CYKLUS DAT (persistentní):                                         │
│  ┌──────────┐                                           ┌──────────┐       │
│  │ vytvořeno│──────────────────────────────────────────▶│archivováno│      │
│  └──────────┘                                           └──────────┘       │
│       │                                                       │             │
│       │                                                       │             │
│      dny ─────────────── měsíce až roky ──────────────── navždy             │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  MEZERA:                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Proces restartuje    Data musí přežít                              │   │
│  │  Proces spadne     ▶  Data musí být obnovena                        │   │
│  │  Proces se přesune    Data musí být dostupná                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  PERSISTENCE PŘEMOSŤUJE TUTO MEZERU                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Persistence odděluje životnost vašich dat od životnosti vašeho procesu.

## Jak funguje persistence v noex

noex poskytuje persistence vrstvu, která se přímo integruje s GenServer a GenStateMachine. V jádru funguje přes **snapshoty stavu**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      TOK PERSISTENCE                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  UKLÁDÁNÍ (automatické nebo manuální):                                      │
│                                                                             │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐                │
│  │  GenServer   │────▶│ Serializace  │────▶│   Storage    │                │
│  │    Stav      │     │    Stavu     │     │   Adapter    │                │
│  └──────────────┘     └──────────────┘     └──────────────┘                │
│                             │                     │                         │
│                             ▼                     ▼                         │
│                       JSON + metadata        Memory / File / SQLite         │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  OBNOVENÍ (při startu):                                                     │
│                                                                             │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐                │
│  │   Storage    │────▶│Deserializace │────▶│  GenServer   │                │
│  │   Adapter    │     │    Stavu     │     │    Stav      │                │
│  └──────────────┘     └──────────────┘     └──────────────┘                │
│        │                                         │                          │
│        ▼                                         ▼                          │
│  Čtení z disku           Validace, migrace       Přeskoč init(), použij     │
│  nebo databáze           pokud se schéma změnilo obnovený stav              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Ochutnávka persistence

Zde je stejný counter, nyní s persistence:

```typescript
import { GenServer, FileAdapter } from '@hamicek/noex';

const adapter = new FileAdapter({ directory: './data' });

const counter = await GenServer.start(counterBehavior, {
  name: 'my-counter',
  persistence: {
    adapter,
    restoreOnStart: true,      // Načti předchozí stav při startu
    persistOnShutdown: true,   // Ulož stav při graceful shutdown
    snapshotIntervalMs: 30000, // Také ulož každých 30 sekund
  },
});

// Inkrementuj 1000x
for (let i = 0; i < 1000; i++) {
  GenServer.cast(counter, 'increment');
}

// Graceful shutdown - stav je uložen
await GenServer.stop(counter);

// Později, restartujte aplikaci...
const counter2 = await GenServer.start(counterBehavior, {
  name: 'my-counter',
  persistence: {
    adapter,
    restoreOnStart: true,
    persistOnShutdown: true,
  },
});

// Stav byl obnoven!
const count = await GenServer.call(counter2, 'get');
console.log(count); // 1000 - zachováno přes restarty!
```

## Co se persistuje?

noex persistuje **celý objekt stavu** jako snapshot, plus metadata:

```typescript
interface PersistedState<State> {
  // Váš stav - přesně to, co váš proces drží
  state: State;

  // Metadata pro obnovu a debugging
  metadata: {
    persistedAt: number;      // Kdy to bylo uloženo?
    serverId: string;         // Která instance procesu to uložila?
    serverName?: string;      // Registrované jméno (pokud existuje)
    schemaVersion: number;    // Pro migrace
    checksum?: string;        // Ověření integrity
  };
}
```

To znamená:

1. **Plný stav** — Ne události, ne delty, kompletní stav
2. **Point-in-time** — Snapshot v konkrétním okamžiku
3. **Samostatný** — Vše potřebné k obnovení procesu

## Kdy se snapshoty ukládají

Persistence může být spuštěna několika způsoby:

```typescript
persistence: {
  adapter,

  // 1. Při graceful shutdown (default: true)
  persistOnShutdown: true,

  // 2. V pravidelných intervalech (nastavte na 0 pro vypnutí)
  snapshotIntervalMs: 60000, // Každou minutu

  // 3. Manuální checkpoint (vždy dostupný)
  // await GenServer.checkpoint(ref);
}
```

### Volba frekvence snapshotů

Nastavení `snapshotIntervalMs` vyvažuje mezi:

| Časté snapshoty | Řídké snapshoty |
|-----------------|-----------------|
| Menší ztráta dat při pádu | Menší I/O overhead |
| Více zápisů na disk | Lepší výkon |
| Větší využití storage | Menší storage |
| Vhodné pro kritická data | Vhodné pro cache-like data |

```typescript
// Kritická finanční data - ukládej často
const paymentProcessor = await GenServer.start(paymentBehavior, {
  persistence: {
    adapter,
    snapshotIntervalMs: 5000, // Každých 5 sekund
  },
});

// Session cache - ukládej méně často, ztráta je akceptovatelná
const sessionCache = await GenServer.start(sessionBehavior, {
  persistence: {
    adapter,
    snapshotIntervalMs: 300000, // Každých 5 minut
    // Nebo jen: persistOnShutdown only
  },
});
```

## Scénáře obnovy

### Graceful Shutdown

Šťastná cesta — vaše aplikace se čistě vypne:

```
1. GenServer.stop(ref) zavolán
2. terminate() callback se vykoná
3. Stav uložen do storage (pokud persistOnShutdown: true)
4. Proces končí
5. Později: Proces startuje, stav obnoven, pokračuje kde skončil
```

### Obnova po pádu

Proces neočekávaně zemře:

```
1. Proces spadne (OOM, uncaught exception, kill -9)
2. terminate() se nemusí vykonat
3. Poslední snapshot je bod obnovy
4. Data od posledního snapshotu jsou ztracena
5. Později: Proces startuje, obnovuje se z posledního snapshotu
```

Proto záleží na `snapshotIntervalMs` — určuje vaše **maximální okno ztráty dat**.

### Detekce zastaralého stavu

Někdy by starý stav neměl být obnoven:

```typescript
persistence: {
  adapter,
  maxStateAgeMs: 24 * 60 * 60 * 1000, // 24 hodin
}
```

Pokud je persistovaný stav starší než `maxStateAgeMs`, je považován za zastaralý a zahozen. Proces startuje čerstvě s `init()`.

Případy použití:
- Session data, která by měla expirovat
- Cache, která se stává neplatnou časem
- Dočasný stav, který je bezvýznamný po dni

## Kdy NEPOUŽÍVAT persistence

Persistence není vždy odpověď:

### 1. Skutečně pomíjivý stav

```typescript
// Stav WebSocket connection - bezvýznamný po odpojení
const connectionBehavior = {
  init: () => ({
    socketId: generateId(),
    connectedAt: Date.now(),
    // Tento stav je vázán na konkrétní připojení
    // Persistovat ho nedává smysl
  }),
};

// ŽÁDNÁ persistence potřeba
const conn = await GenServer.start(connectionBehavior);
```

### 2. Odvoditelný stav

```typescript
// Agregace, která může být přepočítána ze zdrojových dat
const dashboardBehavior = {
  init: async () => {
    // Tento stav je odvozen z databázových dotazů
    // Persistovat ho jen vytváří zastaralé duplikáty
    return await computeDashboardMetrics();
  },
};

// ŽÁDNÁ persistence - přepočítej při startu
```

### 3. Vysokofrekvenční aktualizace

```typescript
// Real-time metriky aktualizované 100x za sekundu
const metricsBehavior = {
  handleCast: (msg, state) => {
    // Pokud bychom persistovali každou změnu, zapsali bychom 100x za sekundu
    // To je 8.6 milionu zápisů denně - příliš mnoho
    return { ...state, value: msg.value };
  },
};

// Zvažte: agregovat v paměti, periodicky persistovat
// Nebo: použít EventBus pro streaming do time-series databáze
```

### Rozhodovací framework

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    MĚLI BYSTE POUŽÍT PERSISTENCE?                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────┐                                    │
│  │  Je stav hodnotný po restartu       │                                    │
│  │  procesu?                           │                                    │
│  └─────────────────┬───────────────────┘                                    │
│                    │                                                        │
│          ┌────────┴────────┐                                               │
│          ▼                 ▼                                                │
│        ANO                NE ──────────▶ Nepersistovat                      │
│          │                                                                  │
│          ▼                                                                  │
│  ┌─────────────────────────────────────┐                                    │
│  │  Může být levně přepočítán          │                                    │
│  │  z jiných zdrojů?                   │                                    │
│  └─────────────────┬───────────────────┘                                    │
│                    │                                                        │
│          ┌────────┴────────┐                                               │
│          ▼                 ▼                                                │
│        ANO                NE                                                │
│          │                 │                                                │
│          ▼                 ▼                                                │
│   Nepersistovat     ┌─────────────────────────────────────┐                │
│   (přepočítat)      │  Jak kritická je ztráta dat?        │                │
│                     └─────────────────┬───────────────────┘                │
│                                       │                                     │
│                   ┌───────────────────┼───────────────────┐                 │
│                   ▼                   ▼                   ▼                 │
│              Kritická            Důležitá           Nice-to-have            │
│                   │                   │                   │                 │
│                   ▼                   ▼                   ▼                 │
│         Časté snapshoty    Střední snapshoty    Pouze shutdown              │
│         (5-30 sekund)      (1-5 minut)          persistence                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Náhled: Co dál

V následujících kapitolách se naučíte:

1. **Storage adaptery** — MemoryAdapter pro testování, FileAdapter pro jednoduché případy, SQLiteAdapter pro produkci
2. **Konfigurace** — Všechny persistence možnosti a kdy je použít
3. **Verzování schémat** — Jak migrovat stav, když se váš datový model změní

## Shrnutí

**Klíčové poznatky:**

- **Životnost procesu ≠ Životnost dat** — Persistence přemosťuje mezeru mezi pomíjivými procesy a dlouhožijícími daty
- **Snapshoty, ne události** — noex persistuje kompletní snapshoty stavu, ne jednotlivé změny
- **Více spouštěčů** — Ukládej při shutdown, v intervalech, nebo manuálně přes checkpoint
- **Režimy obnovy** — Graceful shutdown zachovává vše; obnova po pádu ztrácí data od posledního snapshotu
- **Ne vždy potřeba** — Pomíjivý, odvoditelný, nebo vysokofrekvenční stav nemusí potřebovat persistence

**Fundamentální otázka:**

> "Pokud tento proces restartuje, všimnou si uživatelé?"

Pokud ano, potřebujete persistence. Pokud ne, pravděpodobně ne.

---

Další: [Storage adaptery](./02-storage-adaptery.md)
