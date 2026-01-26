# Definice stavů a událostí

V předchozí kapitole jste se naučili *kdy* použít GenStateMachine. Teď se ponoříme do *jak* strukturovat váš stavový automat - definování stavů, zpracování událostí a správu přechodů.

## Co se naučíte

- Jak strukturovat state handlery s `handleEvent`, `onEnter` a `onExit`
- Pět typů výsledků přechodů a kdy použít každý
- Jak události proudí skrz váš stavový automat
- Tři typy timeoutů: state, event a generic
- Praktické patterny pro budování robustních stavových automatů

## Anatomie stavového automatu

GenStateMachine behavior má tři hlavní části:

```typescript
import { GenStateMachine, type StateMachineBehavior, type TimeoutEvent } from '@hamicek/noex';

type State = 'idle' | 'running' | 'paused';
type Event = { type: 'start' } | { type: 'pause' } | { type: 'resume' } | { type: 'stop' };
interface Data {
  startedAt: number | null;
  pausedAt: number | null;
}

const behavior: StateMachineBehavior<State, Event, Data> = {
  // 1. INICIALIZACE
  init: () => ({
    state: 'idle',
    data: { startedAt: null, pausedAt: null },
  }),

  // 2. STATE HANDLERY
  states: {
    idle: { /* ... */ },
    running: { /* ... */ },
    paused: { /* ... */ },
  },

  // 3. UKONČENÍ (volitelné)
  terminate(reason, state, data) {
    console.log(`Stopped in ${state} state with reason: ${reason}`);
  },
};
```

## State handlery

Každý stav ve vašem automatu je definován objektem **StateHandler** s až třemi metodami:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           STRUKTURA STATE HANDLERU                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│    StateHandler<State, Event, Data>                                         │
│    ┌────────────────────────────────────────────────────────────────┐      │
│    │                                                                 │      │
│    │  handleEvent(event, data, from?)                               │      │
│    │  ─────────────────────────────────                             │      │
│    │  • POVINNÉ                                                     │      │
│    │  • Volá se pro každou událost v tomto stavu                    │      │
│    │  • Musí vrátit StateTransitionResult                           │      │
│    │  • `from` je DeferredReply pro callWithReply patterny          │      │
│    │                                                                 │      │
│    │  onEnter(data, previousState)                                  │      │
│    │  ─────────────────────────────                                 │      │
│    │  • VOLITELNÉ                                                   │      │
│    │  • Voláno při vstupu do tohoto stavu                           │      │
│    │  • Může přímo mutovat data                                     │      │
│    │  • Dobré pro setup, logging, spouštění timerů                  │      │
│    │                                                                 │      │
│    │  onExit(data, nextState)                                       │      │
│    │  ────────────────────────                                      │      │
│    │  • VOLITELNÉ                                                   │      │
│    │  • Voláno při opouštění tohoto stavu                           │      │
│    │  • Může přímo mutovat data                                     │      │
│    │  • Dobré pro cleanup, ukládání stavu, rušení operací           │      │
│    │                                                                 │      │
│    └────────────────────────────────────────────────────────────────┘      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### handleEvent — Klíčová metoda

Každý stav musí mít metodu `handleEvent`. Přijímá příchozí událost a aktuální data, a vrací výsledek přechodu:

```typescript
states: {
  idle: {
    handleEvent(event, data) {
      if (event.type === 'start') {
        return {
          type: 'transition',
          nextState: 'running',
          data: { ...data, startedAt: Date.now() },
        };
      }
      // Ignorovat události, které v tomto stavu nezpracováváme
      return { type: 'keep_state_and_data' };
    },
  },
}
```

### onEnter — Setup při vstupu do stavu

Callback `onEnter` se spustí pokaždé, když stavový automat vstoupí do tohoto stavu:

```typescript
states: {
  running: {
    onEnter(data, previousState) {
      console.log(`Started running (from ${previousState})`);
      // Může přímo mutovat data
      data.startedAt = Date.now();
    },

    handleEvent(event, data) {
      // ...
    },
  },
}
```

Použijte `onEnter` pro:
- Logování přechodů stavů
- Inicializaci zdrojů specifických pro stav
- Nastavení timerů
- Odesílání notifikací

### onExit — Cleanup při opuštění stavu

Callback `onExit` se spustí při opouštění stavu:

```typescript
states: {
  running: {
    onExit(data, nextState) {
      console.log(`Stopping (going to ${nextState})`);
      // Může přímo mutovat data
      if (data.socket) {
        data.socket.pause();
      }
    },

    handleEvent(event, data) {
      // ...
    },
  },
}
```

Použijte `onExit` pro:
- Uvolňování zdrojů
- Rušení pending operací
- Logging
- Ukládání mezistavu

### Životní cyklus přechodu

Když nastane přechod stavu, životní cyklus je:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          ŽIVOTNÍ CYKLUS PŘECHODU STAVU                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│     Přijde událost                                                          │
│          │                                                                  │
│          ▼                                                                  │
│    ┌──────────────┐                                                         │
│    │ handleEvent  │  ◄── Vrací { type: 'transition', nextState: 'B' }       │
│    │   (stav A)   │                                                         │
│    └──────────────┘                                                         │
│          │                                                                  │
│          ▼                                                                  │
│    ┌──────────────┐                                                         │
│    │   onExit     │  ◄── Voláno s (data, 'B')                               │
│    │   (stav A)   │                                                         │
│    └──────────────┘                                                         │
│          │                                                                  │
│          ▼                                                                  │
│    ┌──────────────┐                                                         │
│    │  Přechod     │  ◄── State timeout pro A je zrušen                      │
│    │   A→B        │                                                         │
│    └──────────────┘                                                         │
│          │                                                                  │
│          ▼                                                                  │
│    ┌──────────────┐                                                         │
│    │   onEnter    │  ◄── Voláno s (data, 'A')                               │
│    │   (stav B)   │                                                         │
│    └──────────────┘                                                         │
│          │                                                                  │
│          ▼                                                                  │
│    ┌──────────────┐                                                         │
│    │   Actions    │  ◄── Zpracování actions z výsledku přechodu             │
│    │  zpracovány  │                                                         │
│    └──────────────┘                                                         │
│          │                                                                  │
│          ▼                                                                  │
│    ┌──────────────┐                                                         │
│    │  Odložené    │  ◄── Pokud se stav změnil, přehrát odložené události    │
│    │  přehrány    │                                                         │
│    └──────────────┘                                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Výsledky přechodu stavu

Vaše metoda `handleEvent` musí vrátit jeden z pěti typů výsledků:

### 1. transition — Přejít do nového stavu

Použijte když událost má způsobit změnu stavu:

```typescript
handleEvent(event, data) {
  if (event.type === 'start') {
    return {
      type: 'transition',
      nextState: 'running',
      data: { ...data, startedAt: Date.now() },
    };
  }
  // ...
}
```

Výsledek transition:
- Spustí `onExit` pro aktuální stav
- Změní aktuální stav
- Spustí `onEnter` pro nový stav
- Zruší jakýkoliv state timeout
- Přehraje odložené události (pokud se stav skutečně změnil)

### 2. keep_state — Zůstat ve stavu, aktualizovat data

Použijte když potřebujete aktualizovat data, ale zůstat ve stejném stavu:

```typescript
handleEvent(event, data) {
  if (event.type === 'increment') {
    return {
      type: 'keep_state',
      data: { ...data, count: data.count + 1 },
    };
  }
  // ...
}
```

### 3. keep_state_and_data — Žádné změny

Použijte když událost neovlivňuje stavový automat:

```typescript
handleEvent(event, data) {
  if (event.type === 'unknown_event') {
    // Ignorovat tuto událost
    return { type: 'keep_state_and_data' };
  }
  // ...
}
```

Toto je výsledek "nedělej nic" - žádná změna stavu, žádná změna dat.

### 4. postpone — Zpracovat později

Použijte když událost není platná v aktuálním stavu, ale může být platná v budoucím stavu:

```typescript
states: {
  initializing: {
    handleEvent(event, data) {
      if (event.type === 'process_data') {
        // Zatím nemůžeme zpracovat data - uložit na později
        return { type: 'postpone' };
      }
      if (event.type === 'init_complete') {
        return { type: 'transition', nextState: 'ready', data };
      }
      return { type: 'keep_state_and_data' };
    },
  },

  ready: {
    handleEvent(event, data) {
      if (event.type === 'process_data') {
        // Teď to můžeme zpracovat - odložené události se přehrají automaticky
        return {
          type: 'keep_state',
          data: { ...data, processed: [...data.processed, event.payload] },
        };
      }
      return { type: 'keep_state_and_data' };
    },
  },
}
```

Odložené události se automaticky přehrají když se změní stav.

### 5. stop — Ukončit stavový automat

Použijte když se má stavový automat vypnout:

```typescript
handleEvent(event, data) {
  if (event.type === 'shutdown') {
    return {
      type: 'stop',
      reason: 'normal',
      data: { ...data, shutdownAt: Date.now() },
    };
  }
  // ...
}
```

Po výsledku `stop` je zavolán callback `terminate` a stavový automat se vypne.

### Souhrn typů výsledků

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        TYPY VÝSLEDKŮ PŘECHODU STAVU                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Typ výsledku         │ Mění stav? │ Mění data? │ Kdy použít              │
│  ─────────────────────┼────────────┼────────────┼───────────────────────── │
│  transition           │ ANO        │ ANO        │ Událost způsobuje změnu │
│                       │            │            │ stavu                   │
│  ─────────────────────┼────────────┼────────────┼───────────────────────── │
│  keep_state           │ NE         │ ANO        │ Pouze aktualizace dat   │
│  ─────────────────────┼────────────┼────────────┼───────────────────────── │
│  keep_state_and_data  │ NE         │ NE         │ Ignorovat událost       │
│  ─────────────────────┼────────────┼────────────┼───────────────────────── │
│  postpone             │ NE         │ NE         │ Zpracovat událost       │
│                       │            │            │ později                 │
│  ─────────────────────┼────────────┼────────────┼───────────────────────── │
│  stop                 │ UKONČUJE   │ FINÁLNÍ    │ Vypnout automat         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Actions — Side effects z handlerů

Výsledky přechodů mohou obsahovat pole `actions` pro side effects:

```typescript
return {
  type: 'transition',
  nextState: 'processing',
  data,
  actions: [
    { type: 'state_timeout', time: 5000 },
    { type: 'next_event', event: { type: 'begin_processing' } },
  ],
};
```

Dostupné actions:

| Action | Popis |
|--------|-------|
| `state_timeout` | Timer, který vystřelí pokud se stav nezmění |
| `event_timeout` | Timer, který se resetuje při jakékoliv události |
| `generic_timeout` | Pojmenovaný timer, který přežije změny stavů |
| `next_event` | Okamžitě zpracovat další událost |
| `reply` | Odeslat odpověď pro `callWithReply` |

## Timeouty do hloubky

GenStateMachine poskytuje tři odlišné typy timeoutů, každý s jiným chováním:

### State Timeout

State timeout vystřelí pokud zůstanete ve stavu příliš dlouho. Automaticky se zruší když přejdete do jiného stavu.

```typescript
states: {
  connecting: {
    handleEvent(event, data) {
      if (event.type === 'connect') {
        return {
          type: 'transition',
          nextState: 'connecting',
          data,
          actions: [{ type: 'state_timeout', time: 10000 }], // 10 sekund na připojení
        };
      }

      // Zkontrolovat zda je to timeout událost
      const timeoutEvent = event as TimeoutEvent;
      if (timeoutEvent.type === 'timeout' && timeoutEvent.timeoutType === 'state_timeout') {
        // Připojení timeout
        return {
          type: 'transition',
          nextState: 'failed',
          data: { ...data, error: 'Connection timeout' },
        };
      }

      if (event.type === 'connected') {
        // Timeout se automaticky zruší při změně stavu
        return {
          type: 'transition',
          nextState: 'connected',
          data: { ...data, socket: event.socket },
        };
      }

      return { type: 'keep_state_and_data' };
    },
  },
}
```

**Použijte state timeout pro:** "Musí opustit tento stav do X času"

### Event Timeout

Event timeout vystřelí pokud v rámci timeout periody nepřijde žádná událost. Resetuje se při jakékoliv příchozí události.

```typescript
states: {
  active: {
    handleEvent(event, data) {
      const timeoutEvent = event as TimeoutEvent;
      if (timeoutEvent.type === 'timeout' && timeoutEvent.timeoutType === 'event_timeout') {
        // Příliš dlouho žádná aktivita
        return {
          type: 'transition',
          nextState: 'idle',
          data,
        };
      }

      // Jakákoliv jiná událost - zpracovat ji a resetovat timeout
      if (event.type === 'activity') {
        return {
          type: 'keep_state',
          data: { ...data, lastActivity: Date.now() },
          actions: [{ type: 'event_timeout', time: 30000 }], // Reset 30s timeoutu
        };
      }

      return { type: 'keep_state_and_data' };
    },

    onEnter(data) {
      // Poznámka: Nelze nastavit timeout v onEnter - použijte init() actions místo toho
    },
  },
}

// Nastavit počáteční event timeout v init()
const behavior: StateMachineBehavior<State, Event, Data> = {
  init: () => ({
    state: 'active',
    data: { lastActivity: Date.now() },
    actions: [{ type: 'event_timeout', time: 30000 }],
  }),
  // ...
};
```

**Použijte event timeout pro:** "Musí přijmout jakoukoliv událost do X času" (detekce nečinnosti)

### Generic Timeout

Generic timeout je pojmenovaný timer, který přetrvává napříč přechody stavů. Vystřelí pouze když je explicitně nastaven a přežije změny stavů.

```typescript
states: {
  pending: {
    handleEvent(event, data) {
      if (event.type === 'start_payment') {
        // Spustit payment timeout, který přežije změny stavů
        return {
          type: 'transition',
          nextState: 'processing',
          data,
          actions: [{ type: 'generic_timeout', name: 'payment', time: 60000 }],
        };
      }
      return { type: 'keep_state_and_data' };
    },
  },

  processing: {
    handleEvent(event, data) {
      const timeoutEvent = event as TimeoutEvent;
      if (timeoutEvent.type === 'timeout' &&
          timeoutEvent.timeoutType === 'generic_timeout' &&
          timeoutEvent.name === 'payment') {
        // Platba trvala příliš dlouho
        return {
          type: 'transition',
          nextState: 'payment_failed',
          data: { ...data, error: 'Payment timeout' },
        };
      }

      if (event.type === 'payment_complete') {
        // Poznámka: Generic timeout pokračuje - zrušit ho nastavením time: 0
        // nebo ho nechte zpracovat ve stavu 'completed'
        return {
          type: 'transition',
          nextState: 'completed',
          data,
        };
      }

      return { type: 'keep_state_and_data' };
    },
  },

  completed: {
    handleEvent(event, data) {
      // Pokud zde dostaneme payment timeout, můžeme ho ignorovat
      const timeoutEvent = event as TimeoutEvent;
      if (timeoutEvent.type === 'timeout') {
        return { type: 'keep_state_and_data' };
      }
      return { type: 'keep_state_and_data' };
    },
  },
}
```

**Použijte generic timeout pro:** "Akce X musí být dokončena do Y času" (i když měníme stavy)

### Porovnání typů timeoutů

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          POROVNÁNÍ TYPŮ TIMEOUTŮ                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Typ timeoutu      │ Zrušen čím           │ Běžný use case                  │
│  ──────────────────┼──────────────────────┼──────────────────────────────── │
│  state_timeout     │ Přechodem stavu      │ Connection timeout, auth        │
│                    │                      │ timeout                         │
│  ──────────────────┼──────────────────────┼──────────────────────────────── │
│  event_timeout     │ Jakoukoliv příchozí  │ Detekce nečinnosti, keepalive   │
│                    │ událostí             │                                 │
│  ──────────────────┼──────────────────────┼──────────────────────────────── │
│  generic_timeout   │ Pouze explicitně     │ Deadline business procesu       │
│                    │ (nebo zastavením     │                                 │
│                    │ automatu)            │                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Struktura timeout události

Když timeout vystřelí, váš handler obdrží `TimeoutEvent`:

```typescript
interface TimeoutEvent {
  type: 'timeout';
  timeoutType: 'state_timeout' | 'event_timeout' | 'generic_timeout';
  name: string | undefined;  // Pouze pro generic_timeout
  event: unknown;            // Volitelný vlastní payload
}
```

Můžete zahrnout vlastní payload při nastavování timeoutu:

```typescript
actions: [
  {
    type: 'state_timeout',
    time: 5000,
    event: { reason: 'connection_attempt', attempt: 3 },
  },
]

// Pak v handleru:
const timeoutEvent = event as TimeoutEvent;
if (timeoutEvent.type === 'timeout') {
  console.log('Timeout payload:', timeoutEvent.event);
  // { reason: 'connection_attempt', attempt: 3 }
}
```

## Action next_event

Action `next_event` umožňuje spustit okamžité zpracování události bez procházení message queue:

```typescript
handleEvent(event, data) {
  if (event.type === 'start_sequence') {
    // Přejít do step1 a okamžitě spustit 'execute'
    return {
      type: 'transition',
      nextState: 'step1',
      data,
      actions: [{ type: 'next_event', event: { type: 'execute' } }],
    };
  }
  // ...
}
```

Toto je užitečné pro:
- Řetězení automatických přechodů stavů
- Rozdělení komplexní logiky do oddělených handlerů
- Okamžité spuštění zpracování po vstupu do stavu

```typescript
// Řetěz automatických přechodů
states: {
  start: {
    handleEvent(event, data) {
      if (event.type === 'begin') {
        return {
          type: 'transition',
          nextState: 'validate',
          data,
          actions: [{ type: 'next_event', event: { type: 'run' } }],
        };
      }
      return { type: 'keep_state_and_data' };
    },
  },

  validate: {
    handleEvent(event, data) {
      if (event.type === 'run') {
        if (isValid(data)) {
          return {
            type: 'transition',
            nextState: 'execute',
            data,
            actions: [{ type: 'next_event', event: { type: 'run' } }],
          };
        }
        return {
          type: 'transition',
          nextState: 'failed',
          data: { ...data, error: 'Validation failed' },
        };
      }
      return { type: 'keep_state_and_data' };
    },
  },

  execute: {
    handleEvent(event, data) {
      if (event.type === 'run') {
        // Udělat práci
        const result = doWork(data);
        return {
          type: 'transition',
          nextState: 'completed',
          data: { ...data, result },
        };
      }
      return { type: 'keep_state_and_data' };
    },
  },

  completed: {
    handleEvent() {
      return { type: 'keep_state_and_data' };
    },
  },

  failed: {
    handleEvent() {
      return { type: 'keep_state_and_data' };
    },
  },
}
```

## Kompletní příklad: Download Manager

Zde je komplexní příklad kombinující všechny koncepty:

```typescript
import { GenStateMachine, type StateMachineBehavior, type TimeoutEvent } from '@hamicek/noex';

// Stavy
type State = 'idle' | 'downloading' | 'paused' | 'completed' | 'failed';

// Události
type Event =
  | { type: 'start'; url: string }
  | { type: 'progress'; bytes: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'complete' }
  | { type: 'error'; message: string }
  | { type: 'retry' }
  | { type: 'cancel' };

// Data
interface Data {
  url: string | null;
  bytesDownloaded: number;
  totalBytes: number | null;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  startedAt: number | null;
}

const downloadManagerBehavior: StateMachineBehavior<State, Event, Data> = {
  init: () => ({
    state: 'idle',
    data: {
      url: null,
      bytesDownloaded: 0,
      totalBytes: null,
      attempts: 0,
      maxAttempts: 3,
      error: null,
      startedAt: null,
    },
  }),

  states: {
    idle: {
      handleEvent(event, data) {
        if (event.type === 'start') {
          return {
            type: 'transition',
            nextState: 'downloading',
            data: {
              ...data,
              url: event.url,
              bytesDownloaded: 0,
              attempts: 1,
              error: null,
              startedAt: Date.now(),
            },
            actions: [
              // 30 sekundový download timeout
              { type: 'state_timeout', time: 30000 },
            ],
          };
        }
        return { type: 'keep_state_and_data' };
      },
    },

    downloading: {
      onEnter(data, previousState) {
        console.log(`Downloading ${data.url} (attempt ${data.attempts}, from ${previousState})`);
      },

      handleEvent(event, data) {
        // Zkontrolovat timeout
        const timeoutEvent = event as TimeoutEvent;
        if (timeoutEvent.type === 'timeout' && timeoutEvent.timeoutType === 'state_timeout') {
          if (data.attempts < data.maxAttempts) {
            return {
              type: 'transition',
              nextState: 'downloading',
              data: { ...data, attempts: data.attempts + 1 },
              actions: [{ type: 'state_timeout', time: 30000 }],
            };
          }
          return {
            type: 'transition',
            nextState: 'failed',
            data: { ...data, error: 'Download timeout after max attempts' },
          };
        }

        if (event.type === 'progress') {
          return {
            type: 'keep_state',
            data: { ...data, bytesDownloaded: data.bytesDownloaded + event.bytes },
          };
        }

        if (event.type === 'pause') {
          return {
            type: 'transition',
            nextState: 'paused',
            data,
          };
        }

        if (event.type === 'complete') {
          return {
            type: 'transition',
            nextState: 'completed',
            data,
          };
        }

        if (event.type === 'error') {
          if (data.attempts < data.maxAttempts) {
            return {
              type: 'transition',
              nextState: 'downloading',
              data: { ...data, attempts: data.attempts + 1 },
              actions: [{ type: 'state_timeout', time: 30000 }],
            };
          }
          return {
            type: 'transition',
            nextState: 'failed',
            data: { ...data, error: event.message },
          };
        }

        if (event.type === 'cancel') {
          return {
            type: 'transition',
            nextState: 'idle',
            data: {
              ...data,
              url: null,
              bytesDownloaded: 0,
              attempts: 0,
              startedAt: null,
            },
          };
        }

        return { type: 'keep_state_and_data' };
      },

      onExit(data, nextState) {
        console.log(`Stopping download (going to ${nextState}), ${data.bytesDownloaded} bytes downloaded`);
      },
    },

    paused: {
      onEnter() {
        console.log('Download paused');
      },

      handleEvent(event, data) {
        if (event.type === 'resume') {
          return {
            type: 'transition',
            nextState: 'downloading',
            data,
            actions: [{ type: 'state_timeout', time: 30000 }],
          };
        }

        if (event.type === 'cancel') {
          return {
            type: 'transition',
            nextState: 'idle',
            data: {
              ...data,
              url: null,
              bytesDownloaded: 0,
              attempts: 0,
              startedAt: null,
            },
          };
        }

        // Ignorovat progress události během pauzy
        if (event.type === 'progress') {
          return { type: 'keep_state_and_data' };
        }

        return { type: 'keep_state_and_data' };
      },
    },

    completed: {
      onEnter(data) {
        const duration = Date.now() - (data.startedAt || Date.now());
        console.log(`Download completed! ${data.bytesDownloaded} bytes in ${duration}ms`);
      },

      handleEvent(event, data) {
        // Může spustit nové stahování
        if (event.type === 'start') {
          return {
            type: 'transition',
            nextState: 'downloading',
            data: {
              ...data,
              url: event.url,
              bytesDownloaded: 0,
              attempts: 1,
              error: null,
              startedAt: Date.now(),
            },
            actions: [{ type: 'state_timeout', time: 30000 }],
          };
        }
        return { type: 'keep_state_and_data' };
      },
    },

    failed: {
      onEnter(data) {
        console.log(`Download failed: ${data.error}`);
      },

      handleEvent(event, data) {
        if (event.type === 'retry' && data.url) {
          return {
            type: 'transition',
            nextState: 'downloading',
            data: {
              ...data,
              bytesDownloaded: 0,
              attempts: 1,
              error: null,
              startedAt: Date.now(),
            },
            actions: [{ type: 'state_timeout', time: 30000 }],
          };
        }

        if (event.type === 'start') {
          return {
            type: 'transition',
            nextState: 'downloading',
            data: {
              ...data,
              url: event.url,
              bytesDownloaded: 0,
              attempts: 1,
              error: null,
              startedAt: Date.now(),
            },
            actions: [{ type: 'state_timeout', time: 30000 }],
          };
        }

        return { type: 'keep_state_and_data' };
      },
    },
  },

  terminate(reason, state, data) {
    console.log(`Download manager terminated in ${state} state (reason: ${reason})`);
    if (data.url && state === 'downloading') {
      console.log(`Warning: Download of ${data.url} was interrupted`);
    }
  },
};

// Použití
async function demo() {
  const manager = await GenStateMachine.start(downloadManagerBehavior, {
    name: 'download-manager',
  });

  // Spustit stahování
  await GenStateMachine.call(manager, {
    type: 'start',
    url: 'https://example.com/file.zip',
  });

  // Simulovat progress
  GenStateMachine.cast(manager, { type: 'progress', bytes: 1024 });
  GenStateMachine.cast(manager, { type: 'progress', bytes: 2048 });

  // Pauza
  await GenStateMachine.call(manager, { type: 'pause' });

  // Zkontrolovat stav
  const state = await GenStateMachine.getState(manager);
  console.log('Current state:', state); // 'paused'

  // Obnovit a dokončit
  await GenStateMachine.call(manager, { type: 'resume' });
  await GenStateMachine.call(manager, { type: 'complete' });

  // Uklidit
  await GenStateMachine.stop(manager);
}
```

## Cvičení: Vytvořte Session Manager

Vytvořte stavový automat session, který zpracovává uživatelské přihlašovací sessions:

**Stavy:** `logged_out` → `authenticating` → `active` → `expired`

**Události:**
- `login` s username/password
- `login_success` se session tokenem
- `login_failed` s důvodem
- `activity` (jakákoliv uživatelská aktivita)
- `logout`

**Požadavky:**
1. Autentizace má 10-sekundový timeout (state timeout)
2. Po 3 neúspěšných pokusech o přihlášení zamknout na 30 sekund
3. Aktivní sessions expirují po 5 minutách nečinnosti (event timeout)
4. Sledovat neúspěšné pokusy o přihlášení a čas začátku session

### Řešení

<details>
<summary>Klikněte pro zobrazení řešení</summary>

```typescript
import { GenStateMachine, type StateMachineBehavior, type TimeoutEvent } from '@hamicek/noex';

type State = 'logged_out' | 'authenticating' | 'active' | 'locked' | 'expired';

type Event =
  | { type: 'login'; username: string; password: string }
  | { type: 'login_success'; token: string }
  | { type: 'login_failed'; reason: string }
  | { type: 'activity' }
  | { type: 'logout' };

interface Data {
  username: string | null;
  token: string | null;
  failedAttempts: number;
  sessionStartedAt: number | null;
  lastActivityAt: number | null;
}

const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minut
const AUTH_TIMEOUT = 10 * 1000; // 10 sekund
const LOCKOUT_TIME = 30 * 1000; // 30 sekund
const MAX_ATTEMPTS = 3;

const sessionBehavior: StateMachineBehavior<State, Event, Data> = {
  init: () => ({
    state: 'logged_out',
    data: {
      username: null,
      token: null,
      failedAttempts: 0,
      sessionStartedAt: null,
      lastActivityAt: null,
    },
  }),

  states: {
    logged_out: {
      handleEvent(event, data) {
        if (event.type === 'login') {
          return {
            type: 'transition',
            nextState: 'authenticating',
            data: { ...data, username: event.username },
            actions: [{ type: 'state_timeout', time: AUTH_TIMEOUT }],
          };
        }
        return { type: 'keep_state_and_data' };
      },
    },

    authenticating: {
      onEnter(data) {
        console.log(`Authenticating user: ${data.username}`);
      },

      handleEvent(event, data) {
        const timeoutEvent = event as TimeoutEvent;
        if (timeoutEvent.type === 'timeout' && timeoutEvent.timeoutType === 'state_timeout') {
          const attempts = data.failedAttempts + 1;
          if (attempts >= MAX_ATTEMPTS) {
            return {
              type: 'transition',
              nextState: 'locked',
              data: { ...data, failedAttempts: attempts },
              actions: [{ type: 'state_timeout', time: LOCKOUT_TIME }],
            };
          }
          return {
            type: 'transition',
            nextState: 'logged_out',
            data: { ...data, failedAttempts: attempts, username: null },
          };
        }

        if (event.type === 'login_success') {
          return {
            type: 'transition',
            nextState: 'active',
            data: {
              ...data,
              token: event.token,
              failedAttempts: 0,
              sessionStartedAt: Date.now(),
              lastActivityAt: Date.now(),
            },
            actions: [{ type: 'event_timeout', time: SESSION_TIMEOUT }],
          };
        }

        if (event.type === 'login_failed') {
          const attempts = data.failedAttempts + 1;
          console.log(`Login failed: ${event.reason} (attempt ${attempts}/${MAX_ATTEMPTS})`);

          if (attempts >= MAX_ATTEMPTS) {
            return {
              type: 'transition',
              nextState: 'locked',
              data: { ...data, failedAttempts: attempts },
              actions: [{ type: 'state_timeout', time: LOCKOUT_TIME }],
            };
          }

          return {
            type: 'transition',
            nextState: 'logged_out',
            data: { ...data, failedAttempts: attempts, username: null },
          };
        }

        return { type: 'keep_state_and_data' };
      },
    },

    active: {
      onEnter(data) {
        console.log(`Session started for ${data.username}`);
      },

      handleEvent(event, data) {
        const timeoutEvent = event as TimeoutEvent;
        if (timeoutEvent.type === 'timeout' && timeoutEvent.timeoutType === 'event_timeout') {
          return {
            type: 'transition',
            nextState: 'expired',
            data,
          };
        }

        if (event.type === 'activity') {
          return {
            type: 'keep_state',
            data: { ...data, lastActivityAt: Date.now() },
            actions: [{ type: 'event_timeout', time: SESSION_TIMEOUT }],
          };
        }

        if (event.type === 'logout') {
          return {
            type: 'transition',
            nextState: 'logged_out',
            data: {
              ...data,
              username: null,
              token: null,
              sessionStartedAt: null,
              lastActivityAt: null,
            },
          };
        }

        return { type: 'keep_state_and_data' };
      },

      onExit(data, nextState) {
        if (data.sessionStartedAt) {
          const duration = Date.now() - data.sessionStartedAt;
          console.log(`Session ended after ${Math.round(duration / 1000)}s (going to ${nextState})`);
        }
      },
    },

    locked: {
      onEnter(data) {
        console.log(`Account locked after ${data.failedAttempts} failed attempts`);
      },

      handleEvent(event, data) {
        const timeoutEvent = event as TimeoutEvent;
        if (timeoutEvent.type === 'timeout' && timeoutEvent.timeoutType === 'state_timeout') {
          return {
            type: 'transition',
            nextState: 'logged_out',
            data: { ...data, failedAttempts: 0 },
          };
        }

        // Ignorovat pokusy o přihlášení když je zamčeno
        if (event.type === 'login') {
          console.log('Cannot login while locked');
          return { type: 'keep_state_and_data' };
        }

        return { type: 'keep_state_and_data' };
      },
    },

    expired: {
      onEnter(data) {
        console.log(`Session expired for ${data.username} due to inactivity`);
      },

      handleEvent(event, data) {
        if (event.type === 'login') {
          return {
            type: 'transition',
            nextState: 'authenticating',
            data: {
              ...data,
              username: event.username,
              token: null,
              sessionStartedAt: null,
              lastActivityAt: null,
            },
            actions: [{ type: 'state_timeout', time: AUTH_TIMEOUT }],
          };
        }
        return { type: 'keep_state_and_data' };
      },
    },
  },

  terminate(reason, state, data) {
    if (data.token) {
      console.log(`Invalidating session token for ${data.username}`);
    }
  },
};

// Test session manageru
async function testSession() {
  const session = await GenStateMachine.start(sessionBehavior, { name: 'session' });

  // Přihlášení
  await GenStateMachine.call(session, {
    type: 'login',
    username: 'john',
    password: 'secret',
  });

  // Simulovat úspěšnou autentizaci
  await GenStateMachine.call(session, {
    type: 'login_success',
    token: 'abc123',
  });

  console.log('State:', await GenStateMachine.getState(session)); // 'active'

  // Simulovat aktivitu
  GenStateMachine.cast(session, { type: 'activity' });

  // Odhlášení
  await GenStateMachine.call(session, { type: 'logout' });

  console.log('State:', await GenStateMachine.getState(session)); // 'logged_out'

  await GenStateMachine.stop(session);
}
```

</details>

## Shrnutí

- **State handlery** definují chování pro každý stav s `handleEvent` (povinné), `onEnter` a `onExit`
- **Výsledky přechodů** řídí chování stavového automatu: `transition`, `keep_state`, `keep_state_and_data`, `postpone`, `stop`
- **Actions** přidávají side effects: timeouty, next events, replies
- **Tři typy timeoutů** slouží různým účelům:
  - State timeout: zrušen při změně stavu
  - Event timeout: resetován při jakékoliv události
  - Generic timeout: přežije změny stavů
- **next_event** umožňuje okamžité zpracování událostí a řetězení stavů
- Použijte `onEnter` pro setup, `onExit` pro cleanup

---

Další: [Workflow objednávky](./03-objednavka-workflow.md)
