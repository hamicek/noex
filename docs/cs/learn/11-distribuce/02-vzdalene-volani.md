# Vzdálené volání

V předchozí kapitole jste se naučili, jak vytvořit cluster — uzly, které se navzájem objevují a detekují selhání. Nyní je čas, aby tyto uzly skutečně *spolupracovaly*. Vzdálená volání umožňují procesům na různých uzlech komunikovat transparentně, jako by byly na stejném stroji.

## Co se naučíte

- Registrovat behaviory pro vzdálené spouštění pomocí `BehaviorRegistry`
- Spouštět GenServery na vzdálených uzlech s `RemoteSpawn` a `GenServer.startRemote()`
- Provádět call a cast na vzdálené procesy s transparentním routingem
- Objevovat procesy cluster-wide pomocí `GlobalRegistry`
- Gracefully zpracovávat vzdálené chyby a timeouty
- Sestavit distribuovaný counter systém od základů

## Výzva distribuované komunikace

Když vaše aplikace přesahuje více strojů, komunikace se stává složitější:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     LOKÁLNÍ vs DISTRIBUOVANÁ KOMUNIKACE                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  LOKÁLNÍ (Jeden uzel)             │  DISTRIBUOVANÁ (Více uzlů)              │
│  ──────────────────────────       │  ──────────────────────────────────     │
│                                   │                                         │
│  ┌─────────┐       ┌─────────┐    │  ┌─────────┐   síť      ┌─────────┐   │
│  │ Proces  │──────►│ Proces  │    │  │ Proces  │─────?─────►│ Proces  │   │
│  │    A    │  msg  │    B    │    │  │    A    │            │    B    │   │
│  └─────────┘       └─────────┘    │  └─────────┘            └─────────┘   │
│                                   │   Uzel 1                 Uzel 2       │
│  - Přímé volání funkce            │                                        │
│  - Sdílená paměť                  │  Výzvy:                                │
│  - Bez serializace                │  - Jak najít Proces B?                 │
│  - Okamžité, spolehlivé           │  - Jak serializovat zprávy?            │
│                                   │  - Co když síť selže?                  │
│                                   │  - A co timeouty?                      │
│                                   │                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

noex řeší tyto výzvy s **transparentním routingem** — váš kód vypadá stejně, ať voláte lokální nebo vzdálené procesy.

## Jak vzdálená volání fungují

Před ponořením do API pochopme architekturu:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TOK VZDÁLENÉHO VOLÁNÍ                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  UZEL 1 (volající)                     UZEL 2 (volaný)                     │
│  ─────────────────                     ───────────────                      │
│                                                                             │
│  ┌──────────────┐                      ┌──────────────┐                    │
│  │   Caller     │                      │   Counter    │                    │
│  │  GenServer   │                      │  GenServer   │                    │
│  └──────┬───────┘                      └──────▲───────┘                    │
│         │                                     │                            │
│         │ GenServer.call(remoteRef, msg)      │ handleCall(msg, state)     │
│         ▼                                     │                            │
│  ┌──────────────┐                      ┌──────┴───────┐                    │
│  │  RemoteCall  │                      │  RemoteCall  │                    │
│  │   (odeslat)  │                      │  (přijmout)  │                    │
│  └──────┬───────┘                      └──────▲───────┘                    │
│         │                                     │                            │
│         │ serializace + podpis (HMAC)         │ deserializace + ověření    │
│         ▼                                     │                            │
│  ┌──────────────┐                      ┌──────┴───────┐                    │
│  │  Transport   │════════════════════════  Transport  │                    │
│  │    (TCP)     │      TCP spojení      │   (TCP)     │                    │
│  └──────────────┘                      └──────────────┘                    │
│                                                                             │
│  Časová osa:                                                                │
│  1. Caller zavolá GenServer.call(remoteRef, { type: 'get' })               │
│  2. noex detekuje remoteRef.nodeId !== lokální uzel                        │
│  3. Zpráva serializována a odeslána přes TCP na Uzel 2                     │
│  4. Uzel 2 deserializuje a volá Counter.handleCall()                       │
│  5. Odpověď serializována a odeslána zpět přes TCP                         │
│  6. Caller obdrží odpověď (nebo timeout)                                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Behavior Registry

Než můžete spustit GenServer na vzdáleném uzlu, vzdálený uzel musí vědět, *jak* ho vytvořit. Zde přichází `BehaviorRegistry`.

### Proč pre-registrace?

Když Uzel A řekne Uzlu B "spusť counter", Uzel B potřebuje:
- Funkci `init()`
- Funkci `handleCall()`
- Funkci `handleCast()`
- Jakékoliv další behavior options

Protože funkce nelze serializovat přes síť, oba uzly musí mít behavior registrovaný pod stejným názvem.

```typescript
import { BehaviorRegistry, GenServerBehavior } from '@hamicek/noex';

// Definice behavioru
interface CounterState {
  count: number;
}

type CounterCall = { type: 'get' } | { type: 'increment' };
type CounterCast = { type: 'reset' };

const counterBehavior: GenServerBehavior<CounterState, CounterCall, CounterCast, number> = {
  init: () => ({ count: 0 }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.count, state];
      case 'increment':
        const newState = { count: state.count + 1 };
        return [newState.count, newState];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'reset':
        return { count: 0 };
    }
  },
};

// Registrovat na VŠECH uzlech před vzdáleným spouštěním
BehaviorRegistry.register('counter', counterBehavior);
```

### Pravidla registrace

1. **Stejný název, stejný behavior**: Všechny uzly musí registrovat přesně stejný behavior pod stejným názvem
2. **Registrovat před spouštěním**: Registrace musí proběhnout před jakýmikoliv pokusy o vzdálené spuštění
3. **Registrovat při startu**: Best practice je registrovat behaviory během inicializace aplikace

```typescript
// app-startup.ts - Spustit toto na každém uzlu
import { BehaviorRegistry } from '@hamicek/noex';
import { counterBehavior } from './behaviors/counter';
import { userBehavior } from './behaviors/user';
import { sessionBehavior } from './behaviors/session';

export function registerBehaviors(): void {
  BehaviorRegistry.register('counter', counterBehavior);
  BehaviorRegistry.register('user', userBehavior);
  BehaviorRegistry.register('session', sessionBehavior);
}
```

### Kontrola registrace

```typescript
// Zkontrolovat, zda je behavior registrován
const behavior = BehaviorRegistry.get('counter');
if (behavior) {
  console.log('Counter behavior je registrován');
}

// Získat statistiky registrace
const stats = BehaviorRegistry.getStats();
console.log(`Registrované behaviory: ${stats.registeredBehaviors}`);
```

## Remote Spawn

Jakmile jsou behaviory registrovány, můžete spouštět GenServery na vzdálených uzlech.

### Použití GenServer.startRemote() (doporučeno)

Nejjednodušší způsob spuštění na vzdáleném uzlu:

```typescript
import { GenServer, Cluster } from '@hamicek/noex';

// Ujistit se, že cluster běží
await Cluster.start({
  nodeName: 'app1',
  port: 4369,
  seeds: ['app2@192.168.1.2:4370'],
});

// Spustit counter na vzdáleném uzlu
const remoteRef = await GenServer.startRemote<CounterState, CounterCall, CounterCast, number>(
  'counter',  // Název behavioru (musí být registrován na cílovém uzlu)
  {
    targetNode: 'app2@192.168.1.2:4370',  // Kde spustit
    name: 'remote-counter',               // Volitelné: registrovat s tímto názvem
    registration: 'global',               // 'local' | 'global' | 'none'
    spawnTimeout: 15000,                  // Timeout pro spawn operaci
  }
);

console.log(`Spuštěno na uzlu: ${remoteRef.nodeId}`);
```

### RemoteStartOptions

| Možnost | Typ | Výchozí | Popis |
|---------|-----|---------|-------|
| `targetNode` | `string` | povinné | Cílový uzel ve formátu `název@host:port` |
| `name` | `string` | `undefined` | Registrovat proces s tímto názvem |
| `registration` | `'local' \| 'global' \| 'none'` | `'none'` | Kde registrovat název |
| `spawnTimeout` | `number` | `10000` | Timeout pro spawn operaci (ms) |
| `initTimeout` | `number` | `5000` | Timeout pro `init()` callback (ms) |

### Režimy registrace

```typescript
// Bez registrace - přístup pouze přes ref
const ref1 = await GenServer.startRemote('counter', {
  targetNode: 'app2@192.168.1.2:4370',
  registration: 'none',  // Výchozí
});

// Lokální registrace - přístupný pouze na cílovém uzlu
const ref2 = await GenServer.startRemote('counter', {
  targetNode: 'app2@192.168.1.2:4370',
  name: 'local-counter',
  registration: 'local',  // Registrován v Registry pouze na app2
});

// Globální registrace - přístupný z libovolného uzlu v clusteru
const ref3 = await GenServer.startRemote('counter', {
  targetNode: 'app2@192.168.1.2:4370',
  name: 'shared-counter',
  registration: 'global',  // Registrován v GlobalRegistry, viditelný všude
});
```

### Low-Level API: RemoteSpawn

Pro více kontroly použijte `RemoteSpawn` přímo:

```typescript
import { RemoteSpawn, NodeId } from '@hamicek/noex/distribution';

const result = await RemoteSpawn.spawn(
  'counter',                                    // Název behavioru
  NodeId.parse('app2@192.168.1.2:4370'),        // Cílový uzel
  {
    name: 'my-counter',
    registration: 'global',
    timeout: 10000,
  }
);

// Výsledek obsahuje info o spuštěném serveru
const ref = {
  id: result.serverId,
  nodeId: result.nodeId,
};
```

## Vzdálené Call a Cast

Krása distribuce noex je **transparentní routing** — vzdálené procesy voláte stejně jako lokální.

### Transparentní routing

```typescript
import { GenServer } from '@hamicek/noex';

// Toto funguje stejně, ať je ref lokální nebo vzdálený!
const value = await GenServer.call(ref, { type: 'get' });
GenServer.cast(ref, { type: 'reset' });
```

noex automaticky:
1. Kontroluje, zda `ref.nodeId` odpovídá lokálnímu uzlu
2. Pokud vzdálený, serializuje zprávu
3. Posílá přes TCP na cílový uzel
4. Deserializuje odpověď (pro call)
5. Vrací výsledek

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TRANSPARENTNÍ ROUTING                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                  GenServer.call(ref, msg)                                   │
│                           │                                                 │
│                           ▼                                                 │
│                  ┌────────────────┐                                         │
│                  │ Je ref.nodeId  │                                         │
│                  │ === lokální?   │                                         │
│                  └────────┬───────┘                                         │
│                    │             │                                          │
│               ANO  │             │  NE                                      │
│                    ▼             ▼                                          │
│           ┌──────────────┐  ┌──────────────┐                                │
│           │ Lokální Call │  │ Vzdálený Call│                                │
│           │              │  │              │                                │
│           │ - Fronty msg │  │ - Serializace│                                │
│           │ - Spusť handl│  │ - TCP odeslat│                                │
│           │ - Vrať výsl. │  │ - Čekej odp. │                                │
│           └──────────────┘  └──────────────┘                                │
│                    │             │                                          │
│                    └──────┬──────┘                                          │
│                           ▼                                                 │
│                      Stejné API!                                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Call Options

```typescript
// Nastavit timeout pro vzdálené volání (výchozí: 5000ms)
const value = await GenServer.call(remoteRef, { type: 'get' }, {
  timeout: 10000,  // 10 sekund
});

// Cast je fire-and-forget, žádné options potřeba
GenServer.cast(remoteRef, { type: 'reset' });
```

### Zpracování chyb

Vzdálená volání mohou selhat z důvodů souvisejících se sítí:

```typescript
import {
  GenServer,
  NodeNotReachableError,
  RemoteCallTimeoutError,
  RemoteServerNotRunningError,
} from '@hamicek/noex';

try {
  const value = await GenServer.call(remoteRef, { type: 'get' });
} catch (error) {
  if (error instanceof NodeNotReachableError) {
    // Cílový uzel není připojen
    console.error(`Uzel ${error.nodeId} není dosažitelný`);
  } else if (error instanceof RemoteCallTimeoutError) {
    // Call vypršel timeout (pomalá síť nebo přetížený server)
    console.error(`Volání na ${error.ref.id} vypršelo po ${error.timeout}ms`);
  } else if (error instanceof RemoteServerNotRunningError) {
    // GenServer neběží na cílovém uzlu
    console.error(`Server ${error.ref.id} neběží na ${error.ref.nodeId}`);
  }
}
```

### Call vs Cast pro vzdálené

| Aspekt | `call()` | `cast()` |
|--------|----------|----------|
| Vrací | Hodnotu odpovědi | void |
| Blokující | Ano (čeká na odpověď) | Ne (fire-and-forget) |
| Timeout | Ano | Ne |
| Garantované doručení | Ano (nebo chyba) | Ne (best effort) |
| Použít kdy | Potřebujete výsledek | Nepotřebujete potvrzení |

```typescript
// Call: Získat aktuální count (potřebujeme hodnotu)
const count = await GenServer.call(ref, { type: 'get' });

// Cast: Inkrementovat (nepotřebujeme potvrzení)
GenServer.cast(ref, { type: 'increment' });
```

## Global Registry

Zatímco můžete ukládat refs manuálně, `GlobalRegistry` poskytuje cluster-wide vyhledávání procesů — libovolný uzel může najít proces podle jména.

### Globální registrace

```typescript
import { GlobalRegistry } from '@hamicek/noex/distribution';

// Spustit proces
const ref = await GenServer.startRemote('counter', {
  targetNode: 'app2@192.168.1.2:4370',
});

// Registrovat globálně
await GlobalRegistry.register('main-counter', ref);

// Nyní ho může najít libovolný uzel
const foundRef = GlobalRegistry.lookup('main-counter');
```

### Metody vyhledávání

```typescript
// lookup() - vyhazuje chybu pokud nenalezen
try {
  const ref = GlobalRegistry.lookup('main-counter');
  await GenServer.call(ref, { type: 'get' });
} catch (error) {
  if (error instanceof GlobalNameNotFoundError) {
    console.error('Counter není registrován');
  }
}

// whereis() - vrací undefined pokud nenalezen (bezpečnější)
const ref = GlobalRegistry.whereis('main-counter');
if (ref) {
  await GenServer.call(ref, { type: 'get' });
}

// isRegistered() - kontrola bez získání ref
if (GlobalRegistry.isRegistered('main-counter')) {
  // ...
}
```

### Výpis registrací

```typescript
// Získat všechny registrované názvy
const names = GlobalRegistry.getNames();
console.log(`Registrováno: ${names.join(', ')}`);

// Počet registrací
const count = GlobalRegistry.count();
console.log(`Celkem: ${count} globálních procesů`);

// Získat záznamy pro konkrétní uzel
const nodeId = NodeId.parse('app2@192.168.1.2:4370');
const entries = GlobalRegistry.getEntriesForNode(nodeId);
for (const entry of entries) {
  console.log(`  ${entry.name} -> ${entry.ref.id}`);
}
```

### Odregistrování

```typescript
// Odebrat z globální registry
await GlobalRegistry.unregister('main-counter');
```

### Global Registry Eventy

```typescript
// Monitorovat registrace
GlobalRegistry.on('registered', (name, ref) => {
  console.log(`Registrováno: ${name} -> ${ref.id}@${ref.nodeId}`);
});

GlobalRegistry.on('unregistered', (name, ref) => {
  console.log(`Odregistrováno: ${name}`);
});

// Zpracovat konflikty (stejný název registrován na více uzlech)
GlobalRegistry.on('conflictResolved', (name, winner, loser) => {
  console.log(`Konflikt pro ${name}: ${winner.id} vyhrál nad ${loser.id}`);
});

// Sync eventy (když uzly sdílejí své registrace)
GlobalRegistry.on('synced', (fromNodeId, entriesCount) => {
  console.log(`Synchronizováno ${entriesCount} záznamů z ${fromNodeId}`);
});
```

### Řešení konfliktů

Když se dva uzly pokusí registrovat stejný název současně, noex řeší konflikty pomocí:

1. **Časové razítko registrace**: Dřívější registrace vyhrává
2. **Priorita**: Vyšší priorita vyhrává (pokud jsou časová razítka stejná)
3. **Node ID**: Lexikografické porovnání jako tiebreaker

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       KONFLIKT GLOBAL REGISTRY                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Uzel 1                              Uzel 2                                 │
│  ──────                              ──────                                 │
│                                                                             │
│  register('counter', refA)           register('counter', refB)              │
│  timestamp: 1000                     timestamp: 1005                        │
│         │                                   │                               │
│         └─────────────┬─────────────────────┘                               │
│                       ▼                                                     │
│             ┌────────────────────┐                                          │
│             │ Konflikt detekován!│                                          │
│             │                    │                                          │
│             │ refA: ts=1000      │                                          │
│             │ refB: ts=1005      │                                          │
│             │                    │                                          │
│             │ Vítěz: refA        │  (dřívější timestamp)                    │
│             └────────────────────┘                                          │
│                       │                                                     │
│                       ▼                                                     │
│         'conflictResolved' event vyslán                                     │
│         refA je zachován, refB je odmítnut                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Automatická registrace při spawn

Nejpohodlnější vzor je registrovat během spawn:

```typescript
// Vše v jednom: spawn + globální registrace
const ref = await GenServer.startRemote('counter', {
  targetNode: 'app2@192.168.1.2:4370',
  name: 'shared-counter',
  registration: 'global',  // Automaticky registruje v GlobalRegistry
});

// Z libovolného uzlu v clusteru:
const foundRef = GlobalRegistry.lookup('shared-counter');
const value = await GenServer.call(foundRef, { type: 'get' });
```

## Praktický příklad: Distribuovaná služba počítadla

Sestavme kompletní distribuovanou counter službu, která přesahuje více uzlů:

```typescript
// counter-service.ts
import {
  GenServer,
  GenServerBehavior,
  BehaviorRegistry,
  Cluster,
  Application,
  Supervisor,
} from '@hamicek/noex';
import { GlobalRegistry, NodeId } from '@hamicek/noex/distribution';

// ============================================================================
// Typy
// ============================================================================

interface CounterState {
  count: number;
  lastUpdatedBy: string | null;
  history: Array<{ value: number; timestamp: number }>;
}

type CounterCall =
  | { type: 'get' }
  | { type: 'getHistory' }
  | { type: 'increment'; by?: number; actor: string }
  | { type: 'decrement'; by?: number; actor: string };

type CounterCast =
  | { type: 'reset'; actor: string };

interface CounterReply {
  count: number;
  lastUpdatedBy: string | null;
}

// ============================================================================
// Definice behavioru
// ============================================================================

const counterBehavior: GenServerBehavior<
  CounterState,
  CounterCall,
  CounterCast,
  CounterReply | CounterState['history']
> = {
  init: () => ({
    count: 0,
    lastUpdatedBy: null,
    history: [{ value: 0, timestamp: Date.now() }],
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [
          { count: state.count, lastUpdatedBy: state.lastUpdatedBy },
          state,
        ];

      case 'getHistory':
        return [state.history, state];

      case 'increment': {
        const delta = msg.by ?? 1;
        const newCount = state.count + delta;
        const newState: CounterState = {
          count: newCount,
          lastUpdatedBy: msg.actor,
          history: [
            ...state.history.slice(-99),  // Uchovej posledních 100 záznamů
            { value: newCount, timestamp: Date.now() },
          ],
        };
        return [{ count: newCount, lastUpdatedBy: msg.actor }, newState];
      }

      case 'decrement': {
        const delta = msg.by ?? 1;
        const newCount = state.count - delta;
        const newState: CounterState = {
          count: newCount,
          lastUpdatedBy: msg.actor,
          history: [
            ...state.history.slice(-99),
            { value: newCount, timestamp: Date.now() },
          ],
        };
        return [{ count: newCount, lastUpdatedBy: msg.actor }, newState];
      }
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'reset':
        return {
          count: 0,
          lastUpdatedBy: msg.actor,
          history: [{ value: 0, timestamp: Date.now() }],
        };
    }
  },
};

// ============================================================================
// Nastavení aplikace
// ============================================================================

export class CounterServiceApp {
  private localRef: GenServerRef<CounterState, CounterCall, CounterCast, CounterReply> | null = null;

  async start(config: {
    nodeName: string;
    port: number;
    seeds: string[];
    isPrimary: boolean;
  }): Promise<void> {
    // 1. Registrovat behaviory (musí být provedeno na VŠECH uzlech)
    BehaviorRegistry.register('distributed-counter', counterBehavior);

    // 2. Spustit cluster
    await Cluster.start({
      nodeName: config.nodeName,
      port: config.port,
      seeds: config.seeds,
      heartbeatIntervalMs: 3000,
      heartbeatMissThreshold: 2,
    });

    console.log(`Cluster spuštěn jako ${Cluster.getLocalNodeId()}`);

    // 3. Nastavit event handlery
    Cluster.onNodeUp((node) => {
      console.log(`Uzel se připojil: ${node.id}`);
    });

    Cluster.onNodeDown((nodeId, reason) => {
      console.log(`Uzel odešel: ${nodeId} (${reason})`);
      // Zde můžete spustit failover logiku
    });

    GlobalRegistry.on('registered', (name, ref) => {
      console.log(`Globální registrace: ${name} -> ${ref.nodeId}`);
    });

    // 4. Pokud primární, spustit sdílený counter
    if (config.isPrimary) {
      await this.spawnPrimaryCounter();
    }
  }

  private async spawnPrimaryCounter(): Promise<void> {
    console.log('Spouštím primární counter...');

    // Spustit lokálně na tomto uzlu
    this.localRef = await GenServer.start(counterBehavior, {
      name: 'primary-counter',
    });

    // Registrovat globálně, aby ho všechny uzly mohly najít
    await GlobalRegistry.register('shared-counter', this.localRef);
    console.log('Primární counter registrován globálně');
  }

  async getCounter(): Promise<GenServerRef<CounterState, CounterCall, CounterCast, CounterReply> | null> {
    // Nejprve zkusit lokální ref
    if (this.localRef) {
      return this.localRef;
    }

    // Jinak vyhledat v global registry
    return GlobalRegistry.whereis('shared-counter') ?? null;
  }

  async getValue(): Promise<CounterReply | null> {
    const ref = await this.getCounter();
    if (!ref) {
      return null;
    }

    try {
      return await GenServer.call(ref, { type: 'get' });
    } catch (error) {
      console.error('Chyba při získávání hodnoty counteru:', error);
      return null;
    }
  }

  async increment(actor: string, by: number = 1): Promise<CounterReply | null> {
    const ref = await this.getCounter();
    if (!ref) {
      return null;
    }

    try {
      return await GenServer.call(ref, { type: 'increment', by, actor });
    } catch (error) {
      console.error('Chyba při inkrementaci:', error);
      return null;
    }
  }

  async stop(): Promise<void> {
    if (this.localRef) {
      await GlobalRegistry.unregister('shared-counter');
      await GenServer.stop(this.localRef);
    }
    await Cluster.stop();
  }
}

// ============================================================================
// Příklad použití
// ============================================================================

async function runPrimaryNode(): Promise<void> {
  const app = new CounterServiceApp();

  await app.start({
    nodeName: 'primary',
    port: 4369,
    seeds: [],
    isPrimary: true,
  });

  // Inkrementovat každou sekundu pro ukázku aktivity
  setInterval(async () => {
    const result = await app.increment('primary-node');
    if (result) {
      console.log(`Counter: ${result.count} (od ${result.lastUpdatedBy})`);
    }
  }, 1000);

  process.on('SIGINT', async () => {
    console.log('\nVypínám...');
    await app.stop();
    process.exit(0);
  });
}

async function runSecondaryNode(seedHost: string): Promise<void> {
  const app = new CounterServiceApp();

  await app.start({
    nodeName: 'secondary',
    port: 4370,
    seeds: [`primary@${seedHost}:4369`],
    isPrimary: false,
  });

  // Počkat na synchronizaci global registry
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Číst a inkrementovat každé 2 sekundy
  setInterval(async () => {
    const value = await app.getValue();
    if (value) {
      console.log(`Přečteno: ${value.count}`);
    }

    const result = await app.increment('secondary-node', 5);
    if (result) {
      console.log(`Po inkrementaci: ${result.count}`);
    }
  }, 2000);

  process.on('SIGINT', async () => {
    console.log('\nVypínám...');
    await app.stop();
    process.exit(0);
  });
}

// Spustit s: npx tsx counter-service.ts primary
// Nebo:     npx tsx counter-service.ts secondary localhost
const mode = process.argv[2];
if (mode === 'primary') {
  runPrimaryNode().catch(console.error);
} else if (mode === 'secondary') {
  const seedHost = process.argv[3] || 'localhost';
  runSecondaryNode(seedHost).catch(console.error);
}
```

Spusťte ve dvou terminálech:

```bash
# Terminál 1: Spustit primární uzel
npx tsx counter-service.ts primary

# Terminál 2: Spustit sekundární uzel
npx tsx counter-service.ts secondary localhost
```

## Best practices pro zpracování chyb

### Graceful degradation

```typescript
async function safeRemoteCall<T>(
  ref: GenServerRef<any, any, any, T>,
  msg: unknown,
  fallback: T,
): Promise<T> {
  try {
    return await GenServer.call(ref, msg, { timeout: 5000 });
  } catch (error) {
    if (error instanceof NodeNotReachableError) {
      console.warn(`Uzel ${error.nodeId} nedosažitelný, používám fallback`);
      return fallback;
    }
    if (error instanceof RemoteCallTimeoutError) {
      console.warn('Vzdálené volání vypršelo, používám fallback');
      return fallback;
    }
    throw error;  // Přehodit neočekávané chyby
  }
}

// Použití
const count = await safeRemoteCall(counterRef, { type: 'get' }, { count: 0 });
```

### Retry s backoff

```typescript
async function retryRemoteCall<T>(
  ref: GenServerRef<any, any, any, T>,
  msg: unknown,
  maxRetries: number = 3,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await GenServer.call(ref, msg, { timeout: 5000 });
    } catch (error) {
      lastError = error as Error;

      if (error instanceof RemoteServerNotRunningError) {
        throw error;  // Neretryovat - server je určitě down
      }

      // Exponenciální backoff: 100ms, 200ms, 400ms, ...
      const delay = 100 * Math.pow(2, attempt);
      console.warn(`Pokus ${attempt + 1} selhal, retry za ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
```

## Shrnutí

**Klíčové poznatky:**

- **BehaviorRegistry** musí registrovat behaviory na VŠECH uzlech před vzdáleným spouštěním
- **GenServer.startRemote()** spouští procesy na libovolném uzlu v clusteru
- **Transparentní routing** činí lokální a vzdálená volání identickými
- **GlobalRegistry** poskytuje cluster-wide vyhledávání procesů podle jména
- Vzdálená volání mohou selhat — zpracujte `NodeNotReachableError`, `RemoteCallTimeoutError`, `RemoteServerNotRunningError`

**Přehled API vzdálených volání:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       PŘEHLED API VZDÁLENÝCH VOLÁNÍ                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BEHAVIOR REGISTRY (pre-registrace behaviorů)                               │
│  ─────────────────────────────────────────────────────────────────────────  │
│  BehaviorRegistry.register(name, behavior)  → Registrovat pro remote spawn  │
│  BehaviorRegistry.get(name)                 → Získat registrovaný behavior  │
│                                                                             │
│  VZDÁLENÉ SPOUŠTĚNÍ                                                         │
│  ─────────────────────────────────────────────────────────────────────────  │
│  GenServer.startRemote(behaviorName, opts)  → Spustit na cílovém uzlu       │
│    opts.targetNode       - Cílový uzel (povinné)                            │
│    opts.name             - Název procesu                                    │
│    opts.registration     - 'local' | 'global' | 'none'                      │
│    opts.spawnTimeout     - Timeout spawn (ms)                               │
│                                                                             │
│  TRANSPARENTNÍ ROUTING (stejné API pro lokální/vzdálené)                    │
│  ─────────────────────────────────────────────────────────────────────────  │
│  GenServer.call(ref, msg, opts)    → Synchronní call (vrací odpověď)        │
│  GenServer.cast(ref, msg)          → Asynchronní cast (fire-and-forget)     │
│                                                                             │
│  GLOBAL REGISTRY (cluster-wide vyhledávání)                                 │
│  ─────────────────────────────────────────────────────────────────────────  │
│  GlobalRegistry.register(name, ref)     → Registrovat globálně              │
│  GlobalRegistry.unregister(name)        → Odebrat registraci                │
│  GlobalRegistry.lookup(name)            → Získat ref (vyhazuje pokud není)  │
│  GlobalRegistry.whereis(name)           → Získat ref (undefined pokud není) │
│  GlobalRegistry.isRegistered(name)      → Zkontrolovat registraci           │
│  GlobalRegistry.getNames()              → Vypsat všechna jména              │
│  GlobalRegistry.count()                 → Počet registrací                  │
│                                                                             │
│  ZPRACOVÁNÍ CHYB                                                            │
│  ─────────────────────────────────────────────────────────────────────────  │
│  NodeNotReachableError        → Cílový uzel není připojen                   │
│  RemoteCallTimeoutError       → Call vypršel timeout                        │
│  RemoteServerNotRunningError  → GenServer neběží na cíli                    │
│  GlobalNameNotFoundError      → Jméno není v GlobalRegistry                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Porovnání režimů registrace:**

| Režim | Rozsah | Použití |
|-------|--------|---------|
| `'none'` | Pouze přes ref | Dočasné procesy, interní služby |
| `'local'` | Pouze stejný uzel | Node-specific singleton služby |
| `'global'` | Celý cluster | Sdílené služby, distribuovaná koordinace |

**Pamatujte:**

> Vzdálená volání v noex jsou navržena jako transparentní — napište kód jednou a funguje, ať jsou procesy lokální nebo napříč sítí. Použijte GlobalRegistry pro budování vyhledatelných služeb a vždy zpracujte síťové chyby gracefully.

---

Další: [Distribuovaný Supervisor](./03-distribuovany-supervisor.md)
