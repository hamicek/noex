# Restart intenzita

Supervisoři automaticky restartují spadlé děti, ale co se stane, když dítě padá opakovaně? Bez limitů byste dostali **nekonečnou restart smyčku** - dítě spadne, restartuje se, spadne znovu, restartuje se znovu, navždy. To plýtvá zdroji a maskuje základní problémy, které je třeba opravit.

**Restart intenzita** je bezpečnostní mechanismus, který tomuto předchází. Limituje, kolik restartů může nastat v rámci časového okna.

## Co se naučíte

- Jak restart intenzita předchází nekonečným restart smyčkám
- Konfigurace `maxRestarts` a `withinMs`
- Algoritmus posuvného okna
- Co se stane, když je limit překročen
- Volba vhodných hodnot pro váš use case

## Problém: Nekonečné restart smyčky

Představte si službu, která spadne okamžitě při startu kvůli chybě v konfiguraci:

```typescript
const brokenBehavior: GenServerBehavior<null, never, never, never> = {
  init() {
    // Toto vždy selže
    throw new Error('Chybí proměnná prostředí DATABASE_URL');
  },
  handleCall: (_, state) => [undefined as never, state],
  handleCast: (_, state) => state,
};
```

Bez limitů restartů by supervisor:
1. Spustil službu → spadne
2. Restartoval službu → spadne okamžitě
3. Restartoval službu → spadne okamžitě
4. ... (navždy)

Každý restart spotřebovává CPU, paměť a potenciálně externí zdroje (databázová připojení, API volání). Aplikace se zdá "běžet", ale nic užitečného se neděje.

## Jak restart intenzita funguje

Restart intenzita je konfigurována dvěma parametry:

```typescript
const supervisor = await Supervisor.start({
  restartIntensity: {
    maxRestarts: 3,      // Maximální povolené restarty
    withinMs: 5000,      // Časové okno v milisekundách
  },
  children: [...],
});
```

Pravidlo je jednoduché: **pokud dojde k více než `maxRestarts` restartům během `withinMs` milisekund, supervisor se vzdá a vyhodí chybu**.

### Výchozí hodnoty

Pokud nezadáte `restartIntensity`, noex používá rozumné výchozí hodnoty:

| Parametr | Výchozí | Význam |
|----------|---------|--------|
| `maxRestarts` | 3 | Povoleno až 3 restarty |
| `withinMs` | 5000 | V 5sekundovém okně |

```typescript
// Tyto jsou ekvivalentní:
await Supervisor.start({ children: [...] });

await Supervisor.start({
  restartIntensity: { maxRestarts: 3, withinMs: 5000 },
  children: [...],
});
```

## Algoritmus posuvného okna

Restart intenzita používá **posuvné okno** - ne fixní časové období. To je důležité pochopit.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ALGORITMUS POSUVNÉHO OKNA                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Čas →    0s      1s      2s      3s      4s      5s      6s      7s       │
│           │       │       │       │       │       │       │       │        │
│           ▼       ▼       ▼       ▼       ▼       ▼       ▼       ▼        │
│           R1      R2              R3                      R4               │
│           │                       │                       │                │
│           │                       │                       │                │
│           │   V čase 3s:          │   V čase 6s:          │                │
│           │   Okno = [0s-3s]      │   Okno = [1s-6s]      │                │
│           │   Restartů = 3 ✓      │   Restartů = 2 ✓      │                │
│           │   (R1, R2, R3)        │   (R2, R3)            │                │
│           │                       │   R1 vypadlo!         │                │
│                                                                             │
│  S maxRestarts=3, withinMs=5000:                                            │
│  - Při R3 (3s): 3 restarty v okně → OK (na limitu)                         │
│  - Při R4 (6s): Pouze 2 restarty v okně → OK (R1 je příliš staré)          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Každý restart je označen časovou značkou. Při kontrole, zda je nový restart povolen, supervisor počítá pouze restarty, které nastaly během posledních `withinMs` milisekund. Starší restarty "vypadnou" z okna.

To znamená, že se služba může zotavit po náporu selhání, pokud se stabilizuje.

## Co se stane při překročení limitů

Když by restart překročil limit, supervisor:

1. **Přestane se pokoušet restartovat** selhávající dítě
2. **Vyhodí `MaxRestartsExceededError`**
3. **Zastaví sám sebe** (supervisor přestane běžet)

```typescript
import { Supervisor, GenServer, MaxRestartsExceededError } from '@hamicek/noex';

const alwaysCrashesBehavior = {
  init() {
    throw new Error('Vždy padám');
  },
  handleCall: (_, s) => [null, s],
  handleCast: (_, s) => s,
};

async function main() {
  try {
    const supervisor = await Supervisor.start({
      restartIntensity: { maxRestarts: 2, withinMs: 1000 },
      children: [
        {
          id: 'unstable',
          start: () => GenServer.start(alwaysCrashesBehavior),
        },
      ],
    });

    // Čekání na pády
    await new Promise((resolve) => setTimeout(resolve, 500));
  } catch (error) {
    if (error instanceof MaxRestartsExceededError) {
      console.log(`Supervisor se vzdal: ${error.message}`);
      console.log(`  Supervisor: ${error.supervisorId}`);
      console.log(`  Max restartů: ${error.maxRestarts}`);
      console.log(`  Časové okno: ${error.withinMs}ms`);
    }
  }
}

main();
```

**Výstup:**
```
Supervisor se vzdal: Supervisor supervisor_1_... exceeded max restarts (2 within 1000ms)
  Supervisor: supervisor_1_...
  Max restartů: 2
  Časové okno: 1000ms
```

## Praktický příklad: Ladění restart intenzity

Různé služby potřebují různá nastavení restartů na základě jejich charakteristik:

```typescript
import { Supervisor, GenServer, type GenServerBehavior } from '@hamicek/noex';

// Simuluje službu s konfigurovatelným chováním pádu
interface ServiceState {
  name: string;
  crashProbability: number;
  callCount: number;
}

type ServiceCall = { type: 'process' };

const createServiceBehavior = (
  name: string,
  crashProbability: number
): GenServerBehavior<ServiceState, ServiceCall, never, string> => ({
  init() {
    console.log(`[${name}] Startuji`);
    return { name, crashProbability, callCount: 0 };
  },
  handleCall(_msg, state) {
    const newCount = state.callCount + 1;

    // Náhodný pád na základě pravděpodobnosti
    if (Math.random() < state.crashProbability) {
      throw new Error(`${state.name} náhodné selhání`);
    }

    return [`zpracováno #${newCount}`, { ...state, callCount: newCount }];
  },
  handleCast: (_, state) => state,
  terminate(reason) {
    const reasonStr = typeof reason === 'string' ? reason : 'chyba';
    console.log(`[${this.name}] Ukončen: ${reasonStr}`);
  },
});

async function main() {
  // Kritická platební služba - velmi konzervativní nastavení
  // Rychle selhat, pokud je skutečný problém
  const paymentSupervisor = await Supervisor.start({
    restartIntensity: {
      maxRestarts: 2,   // Pouze 2 pokusy
      withinMs: 10000,  // Za 10 sekund
    },
    children: [
      {
        id: 'payment-processor',
        start: () => GenServer.start(createServiceBehavior('Payment', 0.1)),
      },
    ],
  });

  // Background job worker - tolerantnější
  // Joby mohou opakovat, občasné selhání se očekává
  const workerSupervisor = await Supervisor.start({
    restartIntensity: {
      maxRestarts: 10,  // Povolit mnoho opakování
      withinMs: 60000,  // Za 1 minutu
    },
    children: [
      {
        id: 'job-worker',
        start: () => GenServer.start(createServiceBehavior('Worker', 0.3)),
      },
    ],
  });

  // Cache služba - velmi tolerantní
  // Cache miss je obnovitelný, restartovat agresivně
  const cacheSupervisor = await Supervisor.start({
    restartIntensity: {
      maxRestarts: 20,   // Mnoho restartů OK
      withinMs: 30000,   // Za 30 sekund
    },
    children: [
      {
        id: 'cache',
        start: () => GenServer.start(createServiceBehavior('Cache', 0.5)),
      },
    ],
  });

  console.log('\nVšechny supervisory spuštěny s různými restart intenzitami:');
  console.log('- Payment: 2 restarty / 10s (rychle selhat)');
  console.log('- Worker: 10 restartů / 60s (tolerantní)');
  console.log('- Cache: 20 restartů / 30s (velmi tolerantní)');

  // Cleanup
  await Promise.all([
    Supervisor.stop(paymentSupervisor),
    Supervisor.stop(workerSupervisor),
    Supervisor.stop(cacheSupervisor),
  ]);
}

main();
```

## Doporučení pro volbu hodnot

### Zvažte typ služby

| Typ služby | Doporučené nastavení | Důvod |
|------------|---------------------|-------|
| **Kritické služby** (platby, auth) | Nízké `maxRestarts` (2-3), střední `withinMs` (10-30s) | Rychle selhat, upozornit operátory |
| **Background workers** | Vyšší `maxRestarts` (5-10), delší `withinMs` (60s+) | Tolerovat přechodné selhání |
| **Cache** | Vysoké `maxRestarts` (10-20), střední `withinMs` (30-60s) | Agresivní obnova, data jsou obnovitelná |
| **Služby s náročným startem** | Nižší `maxRestarts`, delší `withinMs` | Selhání startu jsou drahá |

### Zvažte vzory selhání

**Přechodná selhání** (síťové výpadky, resource contention):
```typescript
// Povolit rychlé nápory restartů, pak stabilizovat
restartIntensity: { maxRestarts: 5, withinMs: 10000 }
```

**Konfigurační chyby** (chybějící env vars, špatná konfigurace):
```typescript
// Rychle selhat - tyto se samy neopraví
restartIntensity: { maxRestarts: 2, withinMs: 5000 }
```

**Kaskádová selhání** (závislost je dole):
```typescript
// Dát čas závislostem na obnovu
restartIntensity: { maxRestarts: 5, withinMs: 60000 }
```

### Matematika za restart intenzitou

Zamyslete se, co vaše nastavení znamenají v praxi:

```typescript
// "Povolit 3 restarty za 5 sekund"
// = Průměrná rychlost restartů 0.6 restartů/sekundu při selhávání
restartIntensity: { maxRestarts: 3, withinMs: 5000 }

// "Povolit 10 restartů za 60 sekund"
// = Průměrná rychlost restartů 0.17 restartů/sekundu při selhávání
// = Více času pro vyřešení přechodných problémů
restartIntensity: { maxRestarts: 10, withinMs: 60000 }
```

## Monitorování restart intenzity

Můžete monitorovat restarty pomocí lifecycle events:

```typescript
import { Supervisor, GenServer, type LifecycleEvent } from '@hamicek/noex';

let restartCount = 0;
let lastRestartTime = Date.now();

const unsubscribe = Supervisor.onLifecycleEvent((event: LifecycleEvent) => {
  if (event.type === 'restarted') {
    restartCount++;
    const timeSinceLastRestart = Date.now() - lastRestartTime;
    lastRestartTime = Date.now();

    console.log(`[Monitor] Restart #${restartCount}`);
    console.log(`  Čas od posledního: ${timeSinceLastRestart}ms`);
    console.log(`  Celkový pokus: ${event.attempt}`);

    // Upozornění, pokud restarty probíhají příliš rychle
    if (timeSinceLastRestart < 1000) {
      console.warn('  ⚠️  Varování: Detekován rychlý restart!');
    }
  }
});
```

## Kompletní příklad: Demonstrace posuvného okna

Tento příklad ukazuje, jak posuvné okno funguje v praxi:

```typescript
import { Supervisor, GenServer, type GenServerBehavior, type GenServerRef } from '@hamicek/noex';

interface CrashableState {
  selfRef?: GenServerRef;
}

type CrashableCall = { type: 'setRef'; ref: GenServerRef } | { type: 'crash' };
type CrashableCast = { type: 'doCrash' };

const crashableBehavior: GenServerBehavior<CrashableState, CrashableCall, CrashableCast, void> = {
  init() {
    console.log(`  [${new Date().toISOString()}] Dítě spuštěno`);
    return {};
  },
  handleCall(msg, state) {
    if (msg.type === 'setRef') {
      return [undefined, { selfRef: msg.ref }];
    }
    if (msg.type === 'crash' && state.selfRef) {
      // Naplánovat pád přes cast
      GenServer.cast(state.selfRef, { type: 'doCrash' });
    }
    return [undefined, state];
  },
  handleCast(msg, state) {
    if (msg.type === 'doCrash' && state.selfRef) {
      GenServer.stop(state.selfRef, { error: new Error('Záměrný pád') });
    }
    return state;
  },
  terminate() {
    console.log(`  [${new Date().toISOString()}] Dítě ukončeno`);
  },
};

async function main() {
  console.log('Demonstrace posuvného okna restart intenzity\n');
  console.log('Nastavení: maxRestarts=3, withinMs=3000 (3 restarty za 3 sekundy)\n');

  const supervisor = await Supervisor.start({
    restartIntensity: {
      maxRestarts: 3,
      withinMs: 3000,
    },
    children: [
      {
        id: 'crashable',
        start: async () => {
          const ref = await GenServer.start(crashableBehavior);
          await GenServer.call(ref, { type: 'setRef', ref });
          return ref;
        },
      },
    ],
  });

  async function triggerCrash(label: string) {
    console.log(`\n${label}`);
    const child = Supervisor.getChild(supervisor, 'crashable');
    if (child && GenServer.isRunning(child.ref)) {
      await GenServer.call(child.ref, { type: 'crash' });
      // Čekání na pád a restart
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  try {
    // Pád 1 - v T+0s
    await triggerCrash('Pád 1 (T+0s):');

    // Pád 2 - v T+1s
    await new Promise((resolve) => setTimeout(resolve, 900));
    await triggerCrash('Pád 2 (T+1s):');

    // Pád 3 - v T+2s
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await triggerCrash('Pád 3 (T+2s):');

    console.log('\n--- Čekání 2 sekundy, než pád 1 vypadne z okna ---');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Pád 4 - v T+4s (pád 1 vypadl, pouze 2 restarty v okně)
    await triggerCrash('Pád 4 (T+4s) - Pád 1 vypadl:');

    console.log('\n✓ Supervisor stále běží, protože pád 1 vypadl z okna');

    const info = Supervisor.getChild(supervisor, 'crashable');
    console.log(`Celkem restartů: ${info?.restartCount}`);
  } catch (error) {
    console.log(`\n✗ Supervisor se vzdal: ${(error as Error).message}`);
  }

  await Supervisor.stop(supervisor);
}

main();
```

**Výstup:**
```
Demonstrace posuvného okna restart intenzity

Nastavení: maxRestarts=3, withinMs=3000 (3 restarty za 3 sekundy)

  [2024-01-15T10:00:00.000Z] Dítě spuštěno

Pád 1 (T+0s):
  [2024-01-15T10:00:00.050Z] Dítě ukončeno
  [2024-01-15T10:00:00.055Z] Dítě spuštěno

Pád 2 (T+1s):
  [2024-01-15T10:00:01.060Z] Dítě ukončeno
  [2024-01-15T10:00:01.065Z] Dítě spuštěno

Pád 3 (T+2s):
  [2024-01-15T10:00:02.070Z] Dítě ukončeno
  [2024-01-15T10:00:02.075Z] Dítě spuštěno

--- Čekání 2 sekundy, než pád 1 vypadne z okna ---

Pád 4 (T+4s) - Pád 1 vypadl:
  [2024-01-15T10:00:04.080Z] Dítě ukončeno
  [2024-01-15T10:00:04.085Z] Dítě spuštěno

✓ Supervisor stále běží, protože pád 1 vypadl z okna
Celkem restartů: 4
```

## Cvičení

Vytvořte testovací prostředí, které demonstruje chování restart intenzity:

1. Vytvořte supervisor s `maxRestarts: 3` a `withinMs: 2000`
2. Vytvořte dítě, které lze příkazem shodit
3. Spusťte 3 pády během 2 sekund - supervisor by měl stále běžet
4. Spusťte 4. pád okamžitě - supervisor by měl vyhodit `MaxRestartsExceededError`
5. V druhém testu spusťte 3 pády, počkejte 2 sekundy, pak spusťte další - mělo by uspět

<details>
<summary>Řešení</summary>

```typescript
import { Supervisor, GenServer, MaxRestartsExceededError, type GenServerBehavior, type GenServerRef } from '@hamicek/noex';

interface TestState {
  selfRef?: GenServerRef;
}

type TestCall = { type: 'setRef'; ref: GenServerRef };
type TestCast = { type: 'crash' };

const testBehavior: GenServerBehavior<TestState, TestCall, TestCast, void> = {
  init: () => ({}),
  handleCall(msg, state) {
    if (msg.type === 'setRef') {
      return [undefined, { selfRef: msg.ref }];
    }
    return [undefined, state];
  },
  handleCast(msg, state) {
    if (msg.type === 'crash' && state.selfRef) {
      GenServer.stop(state.selfRef, { error: new Error('Testovací pád') });
    }
    return state;
  },
};

async function crashChild(supervisor: Awaited<ReturnType<typeof Supervisor.start>>) {
  const child = Supervisor.getChild(supervisor, 'test');
  if (child && GenServer.isRunning(child.ref)) {
    GenServer.cast(child.ref, { type: 'crash' });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function createSupervisor() {
  return Supervisor.start({
    restartIntensity: { maxRestarts: 3, withinMs: 2000 },
    children: [
      {
        id: 'test',
        start: async () => {
          const ref = await GenServer.start(testBehavior);
          await GenServer.call(ref, { type: 'setRef', ref });
          return ref;
        },
      },
    ],
  });
}

async function test1_exceedLimit() {
  console.log('Test 1: Překročení limitu restartů');
  console.log('Očekáváno: MaxRestartsExceededError po 4. pádu\n');

  const supervisor = await createSupervisor();

  try {
    // 3 pády v rámci okna - mělo by být OK
    for (let i = 1; i <= 3; i++) {
      console.log(`  Pád ${i}...`);
      await crashChild(supervisor);
    }

    console.log('  Po 3 pádech supervisor stále běží:', Supervisor.isRunning(supervisor));

    // 4. pád by měl překročit limit
    console.log('  Pád 4 (měl by selhat)...');
    await crashChild(supervisor);

    // Chvíli počkat na propagaci chyby
    await new Promise((resolve) => setTimeout(resolve, 200));

    console.log('  ✗ Očekávána MaxRestartsExceededError, ale supervisor stále běží');
  } catch (error) {
    if (error instanceof MaxRestartsExceededError) {
      console.log('  ✓ Dostali jsme MaxRestartsExceededError dle očekávání');
    } else {
      throw error;
    }
  }
}

async function test2_windowAging() {
  console.log('\nTest 2: Stárnutí okna');
  console.log('Očekáváno: 4. pád uspěje po čekání na vyčištění okna\n');

  const supervisor = await createSupervisor();

  try {
    // 3 pády v rámci okna
    for (let i = 1; i <= 3; i++) {
      console.log(`  Pád ${i}...`);
      await crashChild(supervisor);
    }

    console.log('  Čekání 2.5 sekundy na vyčištění okna...');
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // 4. pád by měl uspět (staré pády vypadly)
    console.log('  Pád 4 (měl by uspět)...');
    await crashChild(supervisor);

    console.log('  ✓ 4. pád uspěl - supervisor stále běží:', Supervisor.isRunning(supervisor));

    await Supervisor.stop(supervisor);
  } catch (error) {
    console.log('  ✗ Neočekávaná chyba:', (error as Error).message);
  }
}

async function main() {
  await test1_exceedLimit();
  await test2_windowAging();
}

main();
```

**Očekávaný výstup:**
```
Test 1: Překročení limitu restartů
Očekáváno: MaxRestartsExceededError po 4. pádu

  Pád 1...
  Pád 2...
  Pád 3...
  Po 3 pádech supervisor stále běží: true
  Pád 4 (měl by selhat)...
  ✓ Dostali jsme MaxRestartsExceededError dle očekávání

Test 2: Stárnutí okna
Očekáváno: 4. pád uspěje po čekání na vyčištění okna

  Pád 1...
  Pád 2...
  Pád 3...
  Čekání 2.5 sekundy na vyčištění okna...
  Pád 4 (měl by uspět)...
  ✓ 4. pád uspěl - supervisor stále běží: true
```

</details>

## Shrnutí

- **Restart intenzita** předchází nekonečným restart smyčkám omezením restartů v časovém okně
- Konfigurace pomocí `restartIntensity: { maxRestarts, withinMs }` v options supervisoru
- **Výchozí**: 3 restarty během 5 sekund
- Používá **posuvné okno** - staré restarty vypadnou, což umožňuje zotavení po náporech
- Při překročení limitu supervisor vyhodí `MaxRestartsExceededError` a zastaví se
- **Volte hodnoty na základě typu služby**:
  - Kritické služby: nízké limity, rychle selhat
  - Background workers: vyšší limity, tolerovat přechodná selhání
  - Cache: vysoké limity, agresivní obnova
- Monitorujte restarty pomocí `Supervisor.onLifecycleEvent()`

Restart intenzita je vaše záchranná síť - zachytává nekontrolovatelná selhání a nutí vás řešit kořenovou příčinu místo toho, aby se systém nekontrolovaně třás.

---

Další: [Stromy supervize](./05-stromy-supervize.md)
