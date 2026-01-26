# Kdy použít GenStateMachine

Dosud jste používali GenServer pro všechny vaše procesy. GenServer je flexibilní - zpracovává zprávy, udržuje stav a integruje se se supervizí. Ale některé problémy mají **přirozenou strukturu stavového automatu**, kterou GenServer nevyjadřuje dobře.

GenStateMachine je specializované chování postavené na GenServeru, které dělá **explicitní stavy a přechody** prvotřídními občany. Když má vaše doména jasné stavy, definované přechody a chování specifické pro jednotlivé stavy, GenStateMachine to vyjadřuje jasněji než GenServer.

## Co se naučíte

- Rozdíl mezi GenServerem a GenStateMachine
- Kdy zvolit GenStateMachine místo GenServeru
- Klíčové features: explicitní stavy, přechody, timeouty, odkládání
- Reálné use cases a rozhodovací guidelines

## GenServer: Implicitní stav

S GenServerem je stav jakákoliv datová struktura, kterou udržujete. Přechody se dějí implicitně skrze vaši logiku zpracování zpráv:

```typescript
// GenServer přístup k connection handleru
interface ConnectionState {
  status: 'connecting' | 'connected' | 'disconnected';
  socket: Socket | null;
  pendingMessages: Message[];
  retryCount: number;
}

const connectionBehavior: GenServerBehavior<ConnectionState, CallMsg, CastMsg, Reply> = {
  init: () => ({
    status: 'connecting',
    socket: null,
    pendingMessages: [],
    retryCount: 0,
  }),

  handleCall(msg, state) {
    if (msg.type === 'send') {
      // Logika závislá na stavu rozptýlená v podmínkách
      if (state.status === 'connecting') {
        // Zařadit zprávu do fronty
        return [{ queued: true }, {
          ...state,
          pendingMessages: [...state.pendingMessages, msg.message],
        }];
      }
      if (state.status === 'connected') {
        // Odeslat ihned
        state.socket!.send(msg.message);
        return [{ sent: true }, state];
      }
      if (state.status === 'disconnected') {
        throw new Error('Not connected');
      }
    }

    if (msg.type === 'connect') {
      // Další logika závislá na stavu
      if (state.status === 'connecting') {
        // Již se připojujeme
        return [{ alreadyConnecting: true }, state];
      }
      // ... a tak dále
    }

    // Každý handler musí kontrolovat aktuální status
    // Snadné zapomenout na kombinaci stavů
    // Přechody jsou implicitní v mutacích stavu
  },
};
```

Toto funguje, ale všimněte si:
- Přechody stavů jsou skryty v object spreadech (`status: 'connected'`)
- Každý handler musí kontrolovat aktuální status
- Je snadné vynechat kombinace stavů nebo vytvořit neplatné přechody
- Není žádné vynucení, že určité události jsou platné jen v určitých stavech

## GenStateMachine: Explicitní stavy

GenStateMachine dělá stavy explicitní. Každý stav má vlastní handler a přechody jsou vraceny jako strukturované výsledky:

```typescript
// GenStateMachine přístup - stejný connection handler
type State = 'connecting' | 'connected' | 'disconnected';

type Event =
  | { type: 'connected'; socket: Socket }
  | { type: 'disconnected' }
  | { type: 'send'; message: Message }
  | { type: 'reconnect' };

interface Data {
  socket: Socket | null;
  pendingMessages: Message[];
  retryCount: number;
}

const connectionBehavior: StateMachineBehavior<State, Event, Data> = {
  init: () => ({
    state: 'connecting',
    data: { socket: null, pendingMessages: [], retryCount: 0 },
  }),

  states: {
    // Každý stav má vlastní handler - žádné podmínky nejsou potřeba
    connecting: {
      handleEvent(event, data) {
        if (event.type === 'connected') {
          return {
            type: 'transition',
            nextState: 'connected',
            data: { ...data, socket: event.socket, retryCount: 0 },
          };
        }
        if (event.type === 'send') {
          // Zařadit zprávu do fronty během připojování
          return {
            type: 'keep_state',
            data: { ...data, pendingMessages: [...data.pendingMessages, event.message] },
          };
        }
        if (event.type === 'disconnected') {
          return { type: 'transition', nextState: 'disconnected', data };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter(data) {
        // Voláno při vstupu do stavu 'connecting'
        console.log(`Connecting... (attempt ${data.retryCount + 1})`);
      },
    },

    connected: {
      handleEvent(event, data) {
        if (event.type === 'send') {
          // Odeslat přímo - víme, že jsme připojeni
          data.socket!.send(event.message);
          return { type: 'keep_state_and_data' };
        }
        if (event.type === 'disconnected') {
          return {
            type: 'transition',
            nextState: 'disconnected',
            data: { ...data, socket: null },
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter(data) {
        // Vyprázdnit frontu zpráv při připojení
        for (const msg of data.pendingMessages) {
          data.socket!.send(msg);
        }
        data.pendingMessages = [];
      },
    },

    disconnected: {
      handleEvent(event, data) {
        if (event.type === 'reconnect') {
          return {
            type: 'transition',
            nextState: 'connecting',
            data: { ...data, retryCount: data.retryCount + 1 },
          };
        }
        if (event.type === 'send') {
          // Nelze odeslat během odpojení - odložit nebo odmítnout
          throw new Error('Not connected');
        }
        return { type: 'keep_state_and_data' };
      },
    },
  },
};
```

Všimněte si rozdílu:
- Handler každého stavu se zabývá jen událostmi relevantními pro tento stav
- Přechody jsou explicitní: `{ type: 'transition', nextState: 'connected', ... }`
- `onEnter` callbacky se automaticky spouštějí při vstupu do stavu
- Struktura vynucuje, že zpracováváte všechny stavy
- Neplatné přechody jsou nemožné - kontrolujete, jaké přechody existují

## Klíčové features GenStateMachine

### 1. Explicitní přechody stavů

Přechody jsou vraceny jako strukturované výsledky:

```typescript
// Přechod do nového stavu s novými daty
return { type: 'transition', nextState: 'running', data: newData };

// Zůstat v aktuálním stavu, ale aktualizovat data
return { type: 'keep_state', data: newData };

// Zůstat v aktuálním stavu, ponechat aktuální data
return { type: 'keep_state_and_data' };

// Zastavit stavový automat
return { type: 'stop', reason: 'normal', data };
```

### 2. Callbacky vstupu/výstupu ze stavu

Spusťte kód při vstupu nebo opuštění stavů:

```typescript
states: {
  processing: {
    onEnter(data, previousState) {
      // Spustit timer, získat prostředky, logovat
      console.log(`Started processing (from ${previousState})`);
    },

    onExit(data, nextState) {
      // Uvolnit prostředky, logovat
      console.log(`Finished processing (going to ${nextState})`);
    },

    handleEvent(event, data) {
      // ...
    },
  },
}
```

### 3. Tři typy timeoutů

GenStateMachine poskytuje sofistikovanou správu timeoutů:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TIMEOUTY GENSTATTEMACHINE                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  STATE TIMEOUT                                                              │
│  ─────────────                                                              │
│  • Automaticky zrušen při přechodu stavu                                    │
│  • Perfektní pro: "musí opustit tento stav do X času"                       │
│                                                                             │
│      [connecting] ──(5s timeout)──▶ [failed]                                │
│            │                                                                │
│            └──(connected event)──▶ [connected] (timeout zrušen)             │
│                                                                             │
│  ───────────────────────────────────────────────────────────────────────── │
│                                                                             │
│  EVENT TIMEOUT                                                              │
│  ─────────────                                                              │
│  • Automaticky zrušen když přijde JAKÁKOLIV událost                         │
│  • Perfektní pro: "musí přijmout událost do X času"                         │
│                                                                             │
│      [waiting] ──(žádné události po 30s)──▶ [idle]                          │
│           │                                                                 │
│           └──(jakákoliv událost)──▶ (timeout resetován)                     │
│                                                                             │
│  ───────────────────────────────────────────────────────────────────────── │
│                                                                             │
│  GENERIC TIMEOUT                                                            │
│  ───────────────                                                            │
│  • Pojmenované timery, které přežijí přechody stavů                         │
│  • Perfektní pro: "akce X musí být dokončena do Y času"                     │
│                                                                             │
│      Start "payment_timeout" v [pending]                                    │
│             │                                                               │
│             ├──▶ [processing] (timer pokračuje)                             │
│             │                                                               │
│             └──▶ [completed] ←── timeout vystřelí zde pokud nedokončeno    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

```typescript
// Nastavit state timeout (zrušen při změně stavu)
return {
  type: 'transition',
  nextState: 'connecting',
  data,
  actions: [{ type: 'state_timeout', time: 5000 }],
};

// Nastavit event timeout (zrušen při jakékoliv události)
return {
  type: 'keep_state_and_data',
  actions: [{ type: 'event_timeout', time: 30000 }],
};

// Nastavit pojmenovaný generic timeout (přežije změny stavů)
return {
  type: 'transition',
  nextState: 'processing',
  data,
  actions: [{ type: 'generic_timeout', name: 'payment', time: 60000 }],
};

// Zpracovat timeout události
handleEvent(event, data) {
  if (event.type === 'timeout') {
    if (event.timeoutType === 'state_timeout') {
      // State timeout vystřelil
      return { type: 'transition', nextState: 'failed', data };
    }
    if (event.timeoutType === 'generic_timeout' && event.name === 'payment') {
      // Payment timeout vystřelil
      return { type: 'transition', nextState: 'payment_expired', data };
    }
  }
  // ...
}
```

### 4. Odkládání událostí

Odložte události do pozdějšího stavu, kde dávají smysl:

```typescript
states: {
  initializing: {
    handleEvent(event, data) {
      if (event.type === 'process_data') {
        // Zatím nemůžeme zpracovat - odložit do stavu 'ready'
        return { type: 'postpone' };
      }
      if (event.type === 'init_complete') {
        // Odložené události se přehrají automaticky po tomto přechodu
        return { type: 'transition', nextState: 'ready', data };
      }
      return { type: 'keep_state_and_data' };
    },
  },

  ready: {
    handleEvent(event, data) {
      if (event.type === 'process_data') {
        // Teď to můžeme zpracovat
        return { type: 'keep_state', data: { ...data, processed: event.payload } };
      }
      return { type: 'keep_state_and_data' };
    },
  },
}
```

### 5. Interní události

Spusťte okamžité zpracování události v rámci stejného handleru:

```typescript
handleEvent(event, data) {
  if (event.type === 'start') {
    return {
      type: 'transition',
      nextState: 'step1',
      data,
      // Tato událost je zpracována ihned po přechodu
      actions: [{ type: 'next_event', event: { type: 'continue' } }],
    };
  }
  // ...
}
```

## Kdy použít GenStateMachine

### Použijte GenStateMachine když:

| Scénář | Proč GenStateMachine |
|--------|----------------------|
| **Explicitní stavový diagram** | Vaše doména má jasné stavy nakreslené na tabuli |
| **Chování závislé na stavu** | Stejná událost znamená různé věci v různých stavech |
| **Komplexní timeouty** | Více typů timeoutů nebo timeouty přesahující stavy |
| **Implementace protokolu** | Stavy spojení, handshaky, správa session |
| **Workflow/business proces** | Životní cyklus objednávky, schvalovací procesy, task workflow |
| **Herní logika** | Tahové hry, stavy zápasu, status hráče |
| **Ovládání zařízení** | Stavy hardware, přepínání režimů, inicializační sekvence |

### Použijte GenServer když:

| Scénář | Proč GenServer |
|--------|----------------|
| **Žádné jasné stavy** | Stav jsou jen data, která se průběžně mění |
| **Všechny události vždy platné** | Jakákoliv zpráva může být zpracována kdykoliv |
| **Jednoduchý request-response** | Bezstavové výpočty, lookups, CRUD |
| **Worker procesy** | Provádění úloh, background joby |
| **Agregátory/koordinátory** | Sběr dat, dispatching práce |

### Rozhodovací flowchart

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              GENSERVER vs GENSTATTEMACHINE ROZHODOVACÍ GUIDE                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                        Můžete nakreslit stavový diagram?                    │
│                                    │                                        │
│                       ┌────────────┴────────────┐                           │
│                       ▼                         ▼                           │
│                      ANO                        NE                          │
│                       │                         │                           │
│                       ▼                         ▼                           │
│            Znamenají události různé      ┌─────────────┐                    │
│            věci v různých stavech?       │  GenServer  │                    │
│                       │                  └─────────────┘                    │
│            ┌──────────┴──────────┐                                          │
│            ▼                     ▼                                          │
│           ANO                    NE                                         │
│            │                     │                                          │
│            ▼                     ▼                                          │
│   Potřebujete timeouty        ┌─────────────┐                               │
│   založené na stavu nebo      │  GenServer  │                               │
│   odkládání?                  │(jednodušší) │                               │
│            │                  └─────────────┘                               │
│       ┌────┴────┐                                                           │
│       ▼         ▼                                                           │
│      ANO        NE                                                          │
│       │         │                                                           │
│       ▼         ▼                                                           │
│ ┌─────────────────┐    Zvažte komplexitu:                                   │
│ │GenStateMachine  │    • 2-3 stavy: GenServer může stačit                   │
│ │  (určitě)       │    • 4+ stavů: GenStateMachine jasnější                 │
│ └─────────────────┘    • Rostoucí stavy: GenStateMachine škáluje lépe       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Reálné příklady

### Příklad 1: WebSocket spojení

Connection manager se stavy connecting → connected → disconnected:

```typescript
import { GenStateMachine, type StateMachineBehavior, type TimeoutEvent } from '@hamicek/noex';

type State = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

type Event =
  | { type: 'connect'; url: string }
  | { type: 'connected'; socket: WebSocket }
  | { type: 'message'; data: unknown }
  | { type: 'send'; payload: unknown }
  | { type: 'close' }
  | { type: 'error'; error: Error };

interface Data {
  url: string | null;
  socket: WebSocket | null;
  messageQueue: unknown[];
  reconnectAttempts: number;
  maxReconnectAttempts: number;
}

const wsConnectionBehavior: StateMachineBehavior<State, Event, Data> = {
  init: () => ({
    state: 'disconnected',
    data: {
      url: null,
      socket: null,
      messageQueue: [],
      reconnectAttempts: 0,
      maxReconnectAttempts: 5,
    },
  }),

  states: {
    disconnected: {
      handleEvent(event, data) {
        if (event.type === 'connect') {
          return {
            type: 'transition',
            nextState: 'connecting',
            data: { ...data, url: event.url },
          };
        }
        if (event.type === 'send') {
          // Zařadit zprávu do fronty pro pozdější odeslání
          return {
            type: 'keep_state',
            data: { ...data, messageQueue: [...data.messageQueue, event.payload] },
          };
        }
        return { type: 'keep_state_and_data' };
      },
    },

    connecting: {
      handleEvent(event, data) {
        if (event.type === 'connected') {
          return {
            type: 'transition',
            nextState: 'connected',
            data: { ...data, socket: event.socket, reconnectAttempts: 0 },
          };
        }
        if (event.type === 'error' || (event as TimeoutEvent).type === 'timeout') {
          if (data.reconnectAttempts < data.maxReconnectAttempts) {
            return {
              type: 'transition',
              nextState: 'reconnecting',
              data: { ...data, reconnectAttempts: data.reconnectAttempts + 1 },
            };
          }
          return {
            type: 'transition',
            nextState: 'disconnected',
            data: { ...data, reconnectAttempts: 0 },
          };
        }
        if (event.type === 'send') {
          return { type: 'postpone' }; // Zařadit do fronty do připojení
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter(data) {
        // Connection timeout: 10 sekund
        console.log(`Connecting to ${data.url}...`);
      },
    },

    connected: {
      handleEvent(event, data) {
        if (event.type === 'send') {
          data.socket?.send(JSON.stringify(event.payload));
          return { type: 'keep_state_and_data' };
        }
        if (event.type === 'message') {
          console.log('Received:', event.data);
          return { type: 'keep_state_and_data' };
        }
        if (event.type === 'close' || event.type === 'error') {
          return {
            type: 'transition',
            nextState: 'reconnecting',
            data: { ...data, socket: null },
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter(data) {
        // Vyprázdnit frontu zpráv
        for (const msg of data.messageQueue) {
          data.socket?.send(JSON.stringify(msg));
        }
        data.messageQueue = [];
        console.log('Connected!');
      },

      onExit(data) {
        data.socket?.close();
      },
    },

    reconnecting: {
      handleEvent(event, data) {
        if ((event as TimeoutEvent).type === 'timeout') {
          return {
            type: 'transition',
            nextState: 'connecting',
            data,
          };
        }
        if (event.type === 'send') {
          return { type: 'postpone' };
        }
        if (event.type === 'close') {
          return {
            type: 'transition',
            nextState: 'disconnected',
            data: { ...data, reconnectAttempts: 0 },
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter(data) {
        // Exponenciální backoff: 1s, 2s, 4s, 8s, 16s
        const backoff = Math.min(1000 * Math.pow(2, data.reconnectAttempts - 1), 16000);
        console.log(`Reconnecting in ${backoff}ms (attempt ${data.reconnectAttempts})...`);
      },
    },
  },
};

// Použití
async function demo() {
  const conn = await GenStateMachine.start(wsConnectionBehavior, { name: 'ws-connection' });

  // Připojit
  GenStateMachine.cast(conn, { type: 'connect', url: 'wss://api.example.com' });

  // Zprávy odeslané před dokončením připojení jsou zařazeny do fronty
  GenStateMachine.cast(conn, { type: 'send', payload: { action: 'subscribe', channel: 'events' } });

  // Zkontrolovat stav
  const state = await GenStateMachine.getState(conn);
  console.log('Current state:', state);

  // Později: čisté odpojení
  GenStateMachine.cast(conn, { type: 'close' });
}
```

### Příklad 2: Autentizační session

Session s více autentizačními kroky:

```typescript
type AuthState = 'anonymous' | 'credentials_entered' | 'awaiting_2fa' | 'authenticated' | 'locked';

type AuthEvent =
  | { type: 'login'; username: string; password: string }
  | { type: 'verify_2fa'; code: string }
  | { type: 'logout' }
  | { type: 'invalid_credentials' }
  | { type: 'invalid_2fa' }
  | { type: 'session_expired' };

interface AuthData {
  username: string | null;
  loginAttempts: number;
  lastActivity: number;
  sessionToken: string | null;
}

const authBehavior: StateMachineBehavior<AuthState, AuthEvent, AuthData> = {
  init: () => ({
    state: 'anonymous',
    data: {
      username: null,
      loginAttempts: 0,
      lastActivity: Date.now(),
      sessionToken: null,
    },
  }),

  states: {
    anonymous: {
      handleEvent(event, data) {
        if (event.type === 'login') {
          // Validovat credentials (zjednodušeno)
          const valid = validateCredentials(event.username, event.password);
          if (!valid) {
            const attempts = data.loginAttempts + 1;
            if (attempts >= 3) {
              return { type: 'transition', nextState: 'locked', data: { ...data, loginAttempts: attempts } };
            }
            return { type: 'keep_state', data: { ...data, loginAttempts: attempts } };
          }

          // Zkontrolovat zda je vyžadována 2FA
          if (requires2FA(event.username)) {
            return {
              type: 'transition',
              nextState: 'awaiting_2fa',
              data: { ...data, username: event.username, loginAttempts: 0 },
              actions: [{ type: 'state_timeout', time: 120000 }], // 2 min na zadání kódu
            };
          }

          return {
            type: 'transition',
            nextState: 'authenticated',
            data: {
              ...data,
              username: event.username,
              loginAttempts: 0,
              sessionToken: generateToken(),
            },
          };
        }
        return { type: 'keep_state_and_data' };
      },
    },

    awaiting_2fa: {
      handleEvent(event, data) {
        if (event.type === 'verify_2fa') {
          const valid = verify2FACode(data.username!, event.code);
          if (!valid) {
            const attempts = data.loginAttempts + 1;
            if (attempts >= 3) {
              return { type: 'transition', nextState: 'locked', data: { ...data, loginAttempts: attempts } };
            }
            return { type: 'keep_state', data: { ...data, loginAttempts: attempts } };
          }

          return {
            type: 'transition',
            nextState: 'authenticated',
            data: { ...data, sessionToken: generateToken(), loginAttempts: 0 },
          };
        }
        if ((event as TimeoutEvent).type === 'timeout') {
          // 2FA timeout - návrat na anonymous
          return {
            type: 'transition',
            nextState: 'anonymous',
            data: { ...data, username: null },
          };
        }
        return { type: 'keep_state_and_data' };
      },
    },

    authenticated: {
      handleEvent(event, data) {
        if (event.type === 'logout' || event.type === 'session_expired') {
          return {
            type: 'transition',
            nextState: 'anonymous',
            data: { ...data, username: null, sessionToken: null },
          };
        }
        if ((event as TimeoutEvent).type === 'timeout') {
          // Session timeout
          return {
            type: 'transition',
            nextState: 'anonymous',
            data: { ...data, username: null, sessionToken: null },
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter(data) {
        console.log(`User ${data.username} authenticated`);
      },
    },

    locked: {
      handleEvent(event, data) {
        if ((event as TimeoutEvent).type === 'timeout') {
          // Odemknout po timeoutu
          return {
            type: 'transition',
            nextState: 'anonymous',
            data: { ...data, loginAttempts: 0 },
          };
        }
        // Ignorovat všechny ostatní události když je zamčeno
        return { type: 'keep_state_and_data' };
      },

      onEnter() {
        console.log('Account locked due to too many failed attempts');
      },
    },
  },
};

// Helper funkce (stubs)
function validateCredentials(username: string, password: string): boolean {
  return username === 'admin' && password === 'secret';
}

function requires2FA(username: string): boolean {
  return username === 'admin';
}

function verify2FACode(username: string, code: string): boolean {
  return code === '123456';
}

function generateToken(): string {
  return `token_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
```

### Příklad 3: Řadič semaforu

Klasický příklad stavového automatu s časovanými přechody:

```typescript
type LightState = 'green' | 'yellow' | 'red' | 'flashing';

type LightEvent =
  | { type: 'timer' }
  | { type: 'emergency' }
  | { type: 'resume' }
  | { type: 'manual'; state: LightState };

interface LightData {
  cycleCount: number;
  inEmergencyMode: boolean;
}

const trafficLightBehavior: StateMachineBehavior<LightState, LightEvent, LightData> = {
  init: () => ({
    state: 'red',
    data: { cycleCount: 0, inEmergencyMode: false },
    actions: [{ type: 'state_timeout', time: 5000 }], // Červená 5 sekund na začátku
  }),

  states: {
    green: {
      handleEvent(event, data) {
        if ((event as TimeoutEvent).type === 'timeout' || event.type === 'timer') {
          return {
            type: 'transition',
            nextState: 'yellow',
            data,
            actions: [{ type: 'state_timeout', time: 3000 }], // Žlutá 3s
          };
        }
        if (event.type === 'emergency') {
          return {
            type: 'transition',
            nextState: 'flashing',
            data: { ...data, inEmergencyMode: true },
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter() {
        console.log('🟢 GREEN - Go');
      },
    },

    yellow: {
      handleEvent(event, data) {
        if ((event as TimeoutEvent).type === 'timeout' || event.type === 'timer') {
          return {
            type: 'transition',
            nextState: 'red',
            data: { ...data, cycleCount: data.cycleCount + 1 },
            actions: [{ type: 'state_timeout', time: 5000 }], // Červená 5s
          };
        }
        if (event.type === 'emergency') {
          return {
            type: 'transition',
            nextState: 'flashing',
            data: { ...data, inEmergencyMode: true },
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter() {
        console.log('🟡 YELLOW - Caution');
      },
    },

    red: {
      handleEvent(event, data) {
        if ((event as TimeoutEvent).type === 'timeout' || event.type === 'timer') {
          return {
            type: 'transition',
            nextState: 'green',
            data,
            actions: [{ type: 'state_timeout', time: 10000 }], // Zelená 10s
          };
        }
        if (event.type === 'emergency') {
          return {
            type: 'transition',
            nextState: 'flashing',
            data: { ...data, inEmergencyMode: true },
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter() {
        console.log('🔴 RED - Stop');
      },
    },

    flashing: {
      handleEvent(event, data) {
        if (event.type === 'resume') {
          return {
            type: 'transition',
            nextState: 'red',
            data: { ...data, inEmergencyMode: false },
            actions: [{ type: 'state_timeout', time: 5000 }],
          };
        }
        // Blikací efekt přes event timeout
        if ((event as TimeoutEvent).type === 'timeout') {
          console.log('⚠️  FLASHING');
          return {
            type: 'keep_state_and_data',
            actions: [{ type: 'event_timeout', time: 500 }],
          };
        }
        return { type: 'keep_state_and_data' };
      },

      onEnter() {
        console.log('⚠️  EMERGENCY MODE - Flashing');
      },
    },
  },
};
```

## Anti-patterny

### Nepoužívejte GenStateMachine pro:

1. **Jednoduché čítače nebo akumulátory**
   ```typescript
   // ŠPATNĚ: Overkill pro čítač
   states: {
     counting: { handleEvent: /* increment/decrement */ }
   }

   // DOBŘE: Použijte GenServer
   handleCall(msg, state) {
     return [state.count + 1, { count: state.count + 1 }];
   }
   ```

2. **Čistě request-response služby**
   ```typescript
   // ŠPATNĚ: Žádné smysluplné stavy
   states: {
     ready: { handleEvent: /* vždy zpracovává vše stejně */ }
   }

   // DOBŘE: GenServer je jednodušší
   handleCall(msg, state) {
     return [computeResult(msg), state];
   }
   ```

3. **Stav, který jsou vlastně jen "fáze" stejné logiky**
   ```typescript
   // ŠPATNĚ: Umělé stavy
   states: {
     phase1: { /* udělej krok 1 pak přejdi */ },
     phase2: { /* udělej krok 2 pak přejdi */ },
     phase3: { /* udělej krok 3 pak hotovo */ },
   }

   // DOBŘE: Jen sekvenční kód
   async handleCall(msg, state) {
     await step1();
     await step2();
     await step3();
     return [result, state];
   }
   ```

## Shrnutí

**GenStateMachine** je pro procesy s explicitními, dobře definovanými stavy kde:
- Události mají různé významy v závislosti na aktuálním stavu
- Přechody mezi stavy následují specifická pravidla
- Potřebujete hooky vstupu/výstupu ze stavu
- Potřebujete sofistikovanou správu timeoutů
- Chcete aby struktura kódu zrcadlila váš stavový diagram

**GenServer** je pro všechno ostatní - univerzální procesy kde stav jsou jen data a všechny zprávy mohou být zpracovány kdykoliv.

Pravidlo: **Pokud jste nakreslili stavový diagram pro pochopení problému, použijte GenStateMachine. Pokud jste nakreslili flowchart nebo sekvenční diagram, použijte GenServer.**

---

Další: [Definice stavů a událostí](./02-definice-stavu.md)
