# Supervisor

Supervisor je abstrakce noex pro vytváření systémů odolných proti chybám. Monitoruje child procesy (GenServery) a automaticky je restartuje když spadnou, následujíc filozofii "nech to spadnout" z Elixir/OTP.

## Přehled

Supervisor poskytuje:
- **Automatické restarty** - Selhané procesy jsou restartovány bez manuálního zásahu
- **Restart strategie** - Kontrola jak selhání ovlivňují sourozenecké procesy
- **Restart intensity** - Prevence nekonečných restart smyček
- **Uspořádaný životní cyklus** - Children se spouští v pořadí, zastavují v opačném

```typescript
import { Supervisor, GenServer } from 'noex';

const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },
    { id: 'worker', start: () => GenServer.start(workerBehavior) },
  ],
});

// Children jsou automaticky restartováni při pádu
// Nakonec...
await Supervisor.stop(supervisor);
```

## Restart strategie

Restart strategie určuje, co se stane když child proces spadne.

### one_for_one (výchozí)

Restartuje pouze spadlého childa. Ostatní children pokračují v běhu.

```
Před pádem:       Po pádu:
[A] [B] [C]       [A] [B'] [C]
     ↓ pád             ↑ restartován
```

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'a', start: () => GenServer.start(behaviorA) },
    { id: 'b', start: () => GenServer.start(behaviorB) },
    { id: 'c', start: () => GenServer.start(behaviorC) },
  ],
});
```

**Použití:** Children jsou nezávislí a nesdílí stav.

### one_for_all

Když jeden child spadne, restartují se VŠICHNI children. Zajišťuje, že všichni sourozenci jsou v konzistentním stavu.

```
Před pádem:       Zastavit vše:    Restartovat vše:
[A] [B] [C]       [×] [×] [×]      [A'] [B'] [C']
     ↓ pád
```

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_all',
  children: [
    { id: 'db', start: () => GenServer.start(dbBehavior) },
    { id: 'cache', start: () => GenServer.start(cacheBehavior) },
    { id: 'api', start: () => GenServer.start(apiBehavior) },
  ],
});
```

**Použití:** Children závisí na sobě navzájem a musí se restartovat společně pro zachování konzistence.

### rest_for_one

Restartuje spadlého childa A všechny children spuštěné po něm. Children spuštění před ním pokračují v běhu.

```
Před pádem:       Zastavit B & C:  Restartovat B & C:
[A] [B] [C]       [A] [×] [×]      [A] [B'] [C']
     ↓ pád
```

```typescript
const supervisor = await Supervisor.start({
  strategy: 'rest_for_one',
  children: [
    { id: 'config', start: () => GenServer.start(configBehavior) },   // zůstává běžet
    { id: 'pool', start: () => GenServer.start(poolBehavior) },       // spadne → restartuje se
    { id: 'worker', start: () => GenServer.start(workerBehavior) },   // také se restartuje
  ],
});
```

**Použití:** Pozdější children závisí na dřívějších (např. worker závisí na connection poolu).

## Child specifikace

Každý child je definován objektem `ChildSpec`:

```typescript
interface ChildSpec {
  id: string;                        // Unikátní identifikátor
  start: () => Promise<GenServerRef>; // Factory funkce
  restart?: ChildRestartStrategy;    // 'permanent' | 'transient' | 'temporary'
  shutdownTimeout?: number;          // Timeout pro graceful shutdown (ms)
}
```

### Child restart strategie

Jednotliví children mohou přepsat chování při restartu:

| Strategie | Chování | Použití |
|-----------|---------|---------|
| `permanent` | Vždy restartovat (výchozí) | Kritické služby |
| `transient` | Restartovat pouze při abnormálním ukončení | Úlohy, které mohou normálně skončit |
| `temporary` | Nikdy nerestartovat | Jednorázové úlohy |

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    // Vždy restartovat - kritická cache služba
    {
      id: 'cache',
      start: () => GenServer.start(cacheBehavior),
      restart: 'permanent',
    },
    // Restartovat při pádu, ne při normálním ukončení
    {
      id: 'job-processor',
      start: () => GenServer.start(jobBehavior),
      restart: 'transient',
    },
    // Nikdy nerestartovat - cleanup úloha
    {
      id: 'cleanup',
      start: () => GenServer.start(cleanupBehavior),
      restart: 'temporary',
    },
  ],
});
```

### Shutdown timeout

Kontrola jak dlouho čekat na graceful shutdown:

```typescript
{
  id: 'database',
  start: () => GenServer.start(dbBehavior),
  shutdownTimeout: 30000,  // 30 sekund na zavření spojení
}
```

Pokud se child nezastaví během timeoutu, je násilně ukončen.

## Restart intensity

Restart intensity zabraňuje nekonečným restart smyčkám. Pokud se stane příliš mnoho restartů v časovém okně, supervisor se sám vypne.

```typescript
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  restartIntensity: {
    maxRestarts: 3,    // Max 3 restarty...
    withinMs: 5000,    // ...během 5 sekund
  },
  children: [...],
});
```

**Výchozí hodnoty:**
- `maxRestarts`: 3
- `withinMs`: 5000 (5 sekund)

### MaxRestartsExceededError

Když je restart intensity překročena:

```typescript
import { MaxRestartsExceededError } from 'noex';

try {
  // Supervisor s neustále padajícím childem
  const supervisor = await Supervisor.start({
    children: [{ id: 'unstable', start: () => GenServer.start(crashingBehavior) }],
  });
} catch (error) {
  if (error instanceof MaxRestartsExceededError) {
    console.error(`Supervisor se vzdal po ${error.maxRestarts} restartech`);
  }
}
```

## Dynamická správa children

Přidávání a odebírání children za běhu:

### Dynamické spouštění children

```typescript
const supervisor = await Supervisor.start({ strategy: 'one_for_one' });

// Přidání childa později
const workerRef = await Supervisor.startChild(supervisor, {
  id: 'worker-1',
  start: () => GenServer.start(workerBehavior),
});

// Přidání dalšího
await Supervisor.startChild(supervisor, {
  id: 'worker-2',
  start: () => GenServer.start(workerBehavior),
});
```

### Ukončování children

```typescript
// Odebrání konkrétního childa (graceful shutdown)
await Supervisor.terminateChild(supervisor, 'worker-1');
```

### Restartování children

```typescript
// Vynucený restart konkrétního childa
const newRef = await Supervisor.restartChild(supervisor, 'cache');
```

### Dotazování na children

```typescript
// Získání všech children
const children = Supervisor.getChildren(supervisor);
for (const child of children) {
  console.log(`${child.id}: restarts=${child.restartCount}`);
}

// Získání konkrétního childa
const cache = Supervisor.getChild(supervisor, 'cache');
if (cache) {
  console.log(`Cache se restartovala ${cache.restartCount} krát`);
}

// Počet children
const count = Supervisor.countChildren(supervisor);
```

## Pořadí spouštění a vypínání

### Pořadí spouštění

Children se spouští sekvenčně v uvedeném pořadí:

```typescript
const supervisor = await Supervisor.start({
  children: [
    { id: 'config', start: ... },   // 1. Spustí se první
    { id: 'database', start: ... }, // 2. Spustí se druhý
    { id: 'api', start: ... },      // 3. Spustí se třetí
  ],
});
```

Pokud se některý child nepodaří spustit, supervisor:
1. Zastaví všechny již spuštěné children (v opačném pořadí)
2. Vyhodí chybu

### Pořadí vypínání

Children se zastavují v **opačném** pořadí (poslední spuštěný = první zastavený):

```typescript
await Supervisor.stop(supervisor);
// 1. api se zastaví první
// 2. database se zastaví druhá
// 3. config se zastaví poslední
```

Tím je zajištěno respektování závislostí při vypínání.

## Lifecycle Events

Monitorování životního cyklu supervisoru a children:

```typescript
const unsubscribe = Supervisor.onLifecycleEvent((event) => {
  switch (event.type) {
    case 'started':
      console.log(`Supervisor spuštěn: ${event.ref.id}`);
      break;
    case 'restarted':
      console.log(`Child restartován: pokus #${event.attempt}`);
      break;
    case 'terminated':
      console.log(`Ukončen: ${event.ref.id}, důvod: ${event.reason}`);
      break;
  }
});

// Ukončení naslouchání
unsubscribe();
```

## Supervision stromy

Supervisory mohou supervizovat jiné supervisory, vytvářející hierarchickou izolaci chyb:

```typescript
// Vytvoření sub-supervisorů
const workerSupervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'worker-1', start: () => GenServer.start(workerBehavior) },
    { id: 'worker-2', start: () => GenServer.start(workerBehavior) },
  ],
});

const cacheSupervisor = await Supervisor.start({
  strategy: 'one_for_all',
  children: [
    { id: 'primary', start: () => GenServer.start(cacheBehavior) },
    { id: 'replica', start: () => GenServer.start(cacheBehavior) },
  ],
});

// Top-level supervisor spravuje sub-supervisory
const rootSupervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'workers', start: async () => workerSupervisor as any },
    { id: 'caches', start: async () => cacheSupervisor as any },
  ],
});
```

### Výhody supervision stromů

1. **Izolace chyb** - Selhání v jedné větvi neovlivňují ostatní
2. **Granulární restart politiky** - Různé strategie pro každý subsystém
3. **Jasné hranice** - Logické seskupení souvisejících procesů

## Nejlepší praktiky

### 1. Navrhujte pro selhání

Očekávejte, že procesy spadnou. Udržujte stav obnovitelný:

```typescript
// Správně: Stav lze znovu vytvořit
const cacheBehavior = {
  init: async () => {
    const data = await loadFromDatabase();
    return { data };
  },
  // ...
};

// Vyhněte se: Kritický stav ztracen při pádu
const badBehavior = {
  init: () => ({ transactions: [] }), // Ztraceno při restartu!
  // ...
};
```

### 2. Zvolte správnou strategii

| Scénář | Strategie |
|--------|-----------|
| Nezávislí workři | `one_for_one` |
| Těsně svázané služby | `one_for_all` |
| Pipeline se závislostmi | `rest_for_one` |

### 3. Nastavte vhodnou restart intensity

```typescript
// Pro stabilní služby - přísné limity
restartIntensity: { maxRestarts: 3, withinMs: 60000 }

// Pro volatilní služby - větší tolerance
restartIntensity: { maxRestarts: 10, withinMs: 60000 }
```

### 4. Používejte smysluplná child ID

```typescript
// Správně: Popisná ID
{ id: 'user-cache' }
{ id: 'email-worker' }
{ id: 'metrics-collector' }

// Vyhněte se: Generická ID
{ id: 'worker1' }
{ id: 'service' }
```

### 5. Ošetřete selhání při startu

```typescript
try {
  const supervisor = await Supervisor.start({
    children: [
      { id: 'database', start: () => connectToDatabase() },
    ],
  });
} catch (error) {
  console.error('Nepodařilo se spustit supervisor:', error);
  // Implementujte retry logiku nebo graceful degradaci
}
```

## Typy chyb

| Chyba | Příčina |
|-------|---------|
| `MaxRestartsExceededError` | Příliš mnoho restartů v časovém okně |
| `DuplicateChildError` | Child se stejným ID již existuje |
| `ChildNotFoundError` | Pokus o ukončení/restart neexistujícího childa |

## Související

- [GenServer](./genserver.md) - Stavební blok supervizovaný Supervisorem
- [Životní cyklus](./lifecycle.md) - Detaily životního cyklu procesů
- [Zpracování chyb](./error-handling.md) - Strategie zotavení z chyb
- [Vytváření supervision stromů](../guides/supervision-trees.md) - Návrhové vzory
- [API Reference: Supervisor](../api/supervisor.md) - Kompletní dokumentace API
