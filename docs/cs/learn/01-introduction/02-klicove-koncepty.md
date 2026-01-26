# Klíčové koncepty

Než se ponoříme do kódu, pojďme si vytvořit jasný mentální model toho, jak noex aplikace fungují. Pochopení těchto čtyř konceptů způsobí, že vše ostatní zapadne na své místo.

## Co se naučíte

- Jak GenServer poskytuje izolované, stavové procesy
- Proč jsou zprávy (call/cast) jediným způsobem komunikace
- Jak supervision automaticky obnovuje systém po selháních
- Kontraintuitivní moudrost "let it crash"

## Procesy (GenServer)

V noex je **proces** lehká, izolovaná jednotka výpočtu s vlastním privátním stavem. Na rozdíl od procesů operačního systému nebo vláken jsou noex procesy:

- **Lehké**: Můžete jich spustit tisíce bez významné režie
- **Izolované**: Každý proces vlastní svůj stav - žádná sdílená paměť
- **Sekvenční**: Zprávy jsou zpracovávány jedna po druhé

Primárním stavebním blokem je `GenServer` (Generic Server):

```typescript
import { GenServer, type GenServerBehavior } from 'noex';

// Definice tvaru našeho procesu
interface CounterState {
  value: number;
}

type CounterCall = { type: 'get' } | { type: 'increment' };
type CounterCast = { type: 'reset' };
type CounterReply = number;

// Definice chování
const counterBehavior: GenServerBehavior<
  CounterState,
  CounterCall,
  CounterCast,
  CounterReply
> = {
  // Zavoláno jednou při startu procesu
  init: () => ({ value: 0 }),

  // Zpracování synchronních požadavků (volající čeká na odpověď)
  handleCall(msg, state) {
    switch (msg.type) {
      case 'get':
        return [state.value, state];
      case 'increment':
        const newState = { value: state.value + 1 };
        return [newState.value, newState];
    }
  },

  // Zpracování asynchronních notifikací (fire-and-forget)
  handleCast(msg, state) {
    if (msg.type === 'reset') {
      return { value: 0 };
    }
    return state;
  },

  // Zavoláno při zastavování procesu (volitelné)
  terminate(reason, state) {
    console.log(`Counter zastaven s hodnotou ${state.value}`);
  },
};

// Start procesu
const counter = await GenServer.start(counterBehavior);
```

**Klíčový vhled**: Stav (`{ value: 0 }`) je kompletně privátní. Žádný externí kód ho nemůže přímo číst ani modifikovat. Jediný způsob interakce s ním je prostřednictvím zpráv.

### Identita procesu

Každý proces má unikátní referenci (`GenServerRef`). Tato reference je způsob, jak adresujete zprávy:

```typescript
const counter = await GenServer.start(counterBehavior);
// counter je GenServerRef - váš handle na tento konkrétní proces

// Procesy můžete také registrovat jménem pro snazší vyhledávání
const namedCounter = await GenServer.start(counterBehavior, {
  name: 'main-counter'
});

// Později ho najdete podle jména
const found = Registry.lookup('main-counter');
```

## Zprávy (call/cast)

Procesy komunikují výhradně prostřednictvím zpráv. noex poskytuje dva vzory:

### call - Synchronní požadavek/odpověď

Použijte `call`, když potřebujete odpověď:

```typescript
// Volající blokuje, dokud proces neodpoví
const currentValue = await GenServer.call(counter, { type: 'get' });
console.log(currentValue); // 0

// Můžete také nastavit vlastní timeout (výchozí je 5 sekund)
const value = await GenServer.call(counter, { type: 'get' }, { timeout: 1000 });
```

**Jak to interně funguje:**

1. Vaše zpráva je přidána do fronty procesu
2. Při zpracování se spustí `handleCall` se zprávou a aktuálním stavem
3. Návratová hodnota `[reply, newState]` pošle `reply` zpět k vám
4. Stav procesu je aktualizován na `newState`

### cast - Asynchronní fire-and-forget

Použijte `cast`, když nepotřebujete odpověď:

```typescript
// Vrátí se okamžitě - nečeká na zpracování
GenServer.cast(counter, { type: 'reset' });

// Užitečné pro:
// - Logování/metriky
// - Notifikace
// - Operace na pozadí
// - Když vám nezáleží na výsledku
```

**Jak to interně funguje:**

1. Vaše zpráva je přidána do fronty procesu
2. Při zpracování se spustí `handleCast` se zprávou a aktuálním stavem
3. Návratová hodnota se stane novým stavem
4. Žádná odpověď není poslána (vy jste již pokračovali dál)

### Sekvenční zpracování

Zprávy jsou zpracovávány **jedna po druhé**, v pořadí, v jakém přišly. To eliminuje race conditions:

```typescript
// Tato volání budou zpracována v pořadí
const promise1 = GenServer.call(counter, { type: 'increment' });
const promise2 = GenServer.call(counter, { type: 'increment' });
const promise3 = GenServer.call(counter, { type: 'get' });

const [result1, result2, value] = await Promise.all([promise1, promise2, promise3]);
// value je garantovaně 2
```

I když je vystřelíte souběžně z různých částí vaší aplikace, counter je zpracuje sekvenčně, čímž zajistí konzistentní stav.

## Supervision

Procesy budou selhávat. Síťová spojení se přeruší, externí služby spadnou, bugy se stanou. Místo snahy zabránit všem selháním (nemožné), noex je přijímá pomocí **supervisorů**.

`Supervisor` je speciální proces, který:

- Startuje a monitoruje podřízené procesy
- Automaticky restartuje podřízené při pádu
- Implementuje restart strategie pro různé scénáře selhání

```typescript
import { Supervisor, GenServer } from 'noex';

const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    {
      id: 'counter-1',
      start: () => GenServer.start(counterBehavior),
    },
    {
      id: 'counter-2',
      start: () => GenServer.start(counterBehavior),
    },
  ],
});
```

### Restart strategie

Supervisory podporují různé strategie pro ošetření pádů:

**`one_for_one`** (nejběžnější)

Restartuje pouze spadlé dítě. Ostatní děti nejsou ovlivněny.

```text
Před pádem:       [A] [B] [C]
A spadne:         [X] [B] [C]
Po restartu:      [A'] [B] [C]  (A restartováno, B a C nezměněny)
```

**`one_for_all`**

Když jedno dítě spadne, restartují se všechny děti. Použijte, když děti závisí na sobě navzájem.

```text
Před pádem:       [A] [B] [C]
A spadne:         [X] [X] [X]  (všechny zastaveny)
Po restartu:      [A'] [B'] [C']  (všechny restartovány)
```

**`rest_for_one`**

Restartuje spadlé dítě a všechny děti startované po něm. Použijte pro sekvenční závislosti.

```text
Před pádem:       [A] [B] [C]
B spadne:         [A] [X] [X]  (B a C zastaveny)
Po restartu:      [A] [B'] [C']  (B a C restartovány)
```

### Restart možnosti pro děti

Každé dítě může specifikovat své restart chování:

```typescript
{
  id: 'worker',
  start: () => GenServer.start(workerBehavior),
  restart: 'permanent',  // Vždy restartovat (výchozí)
}

{
  id: 'task-runner',
  start: () => GenServer.start(taskBehavior),
  restart: 'transient',  // Restartovat pouze při abnormálním ukončení (chybách)
}

{
  id: 'one-shot',
  start: () => GenServer.start(oneshotBehavior),
  restart: 'temporary',  // Nikdy nerestartovat
}
```

### Restart intenzita

Pro zabránění nekonečným restart smyčkám (pád -> restart -> pád -> restart...), supervisory omezují, kolik restartů může nastat v časovém okně:

```typescript
await Supervisor.start({
  strategy: 'one_for_one',
  restartIntensity: {
    maxRestarts: 3,    // Maximum 3 restarty...
    withinMs: 5000,    // ...během 5 sekund
  },
  children: [/* ... */],
});
```

Pokud je překročeno, supervisor sám se vypne, čímž eskaluje selhání na svého rodičovského supervisora (pokud existuje).

## Filozofie "Let it crash"

Toto je možná nejkontraintuitivnější koncept pro vývojáře z tradičního prostředí. Myšlenka je:

> Nesnažte se ošetřit každou možnou chybu. Nechte procesy spadnout a obnovte se do známého dobrého stavu.

### Proč to funguje

1. **Jednoduchost**: Kód pro error handling je často komplexnější než happy path. Přijetím selhání píšete méně defenzivního kódu.

2. **Čistý stav**: Restartovaný proces začíná čerstvě. Žádný poškozený stav, žádné napůl dokončené operace, žádný nahromaděný odpad.

3. **Izolace**: Pád v jednom procesu neovlivní ostatní. Selhání je ohraničeno.

4. **Obnova**: Supervision zajišťuje automatickou obnovu systému. Není potřeba manuální zásah.

### Příklad: Tradiční způsob vs Let it crash

**Tradiční přístup** - Ošetři každou možnou chybu:

```typescript
async function fetchUserData(userId: string): Promise<User | null> {
  try {
    const response = await fetch(`/api/users/${userId}`);
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      if (response.status === 429) {
        // Rate limited - počkat a opakovat?
        await sleep(1000);
        return fetchUserData(userId);
      }
      if (response.status >= 500) {
        // Server error - opakovat s backoff?
        // Kolikrát? Co když stále selhává?
      }
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    // Validovat strukturu dat?
    // Ošetřit malformované odpovědi?
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      // Požadavek byl zrušen - opakovat?
    }
    if (error.code === 'ECONNREFUSED') {
      // Služba je nedostupná - zařadit na později?
    }
    // Logovat? Opakovat? Vyhodit? Vrátit null?
    throw error;
  }
}
```

**Let it crash přístup** - Důvěřuj supervizi:

```typescript
const userServiceBehavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init: () => ({ cache: new Map() }),

  async handleCall(msg, state) {
    if (msg.type === 'get_user') {
      // Pokud toto vyhodí výjimku z JAKÉHOKOLI důvodu, proces spadne
      // a je restartován supervisorem
      const response = await fetch(`/api/users/${msg.userId}`);
      const user = await response.json();
      state.cache.set(msg.userId, user);
      return [user, state];
    }
    return [null, state];
  },

  handleCast(msg, state) {
    return state;
  },
};

// Supervisor zajišťuje automatickou obnovu
await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    { id: 'user-service', start: () => GenServer.start(userServiceBehavior) },
  ],
});
```

Proces nemusí ošetřovat síťové chyby, timeouty nebo malformované odpovědi. Pokud se cokoli pokazí, spadne a restartuje se s čistým stavem. Supervisor zajišťuje, že systém zůstane běžet.

### Kdy použít defenzivní kód

Let it crash neznamená "nikdy neošetřuj chyby." Použijte defenzivní error handling pro:

- **Validaci na hranicích**: Kontrola uživatelského vstupu, API požadavky od externích klientů
- **Chyby business logiky**: Neplatné přechody stavů, nedostatek prostředků atd.
- **Očekávaná selhání**: Soubor nenalezen, záznam neexistuje

Použijte let it crash pro:

- **Infrastrukturní selhání**: Síťové problémy, výpadky databázového připojení
- **Neočekávané chyby**: Bugy, poškozený stav, vyčerpání zdrojů
- **Přechodná selhání**: Dočasná nedostupnost služby

## Jak to vše zapadá dohromady

Takto se tyto koncepty kombinují v reálné aplikaci:

```text
                    ┌─────────────────┐
                    │    Aplikace     │
                    └────────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
     ┌────────┴────────┐          ┌────────┴────────┐
     │ UserSupervisor  │          │ OrderSupervisor │
     └────────┬────────┘          └────────┬────────┘
              │                             │
    ┌─────────┼─────────┐         ┌────────┼────────┐
    │         │         │         │        │        │
┌───┴───┐ ┌───┴───┐ ┌───┴───┐ ┌───┴──┐ ┌───┴──┐ ┌───┴──┐
│ User  │ │ User  │ │ User  │ │Order │ │Order │ │Order │
│Service│ │ Cache │ │ Auth  │ │Queue │ │ DB   │ │Notify│
└───────┘ └───────┘ └───────┘ └──────┘ └──────┘ └──────┘
```

1. **Procesy** (GenServer) obsluhují jednotlivé zodpovědnosti s izolovaným stavem
2. **Zprávy** (call/cast) umožňují komunikaci mezi procesy
3. **Supervisory** organizují procesy do fault-tolerantních hierarchií
4. **Let it crash** udržuje kód jednoduchý - selhání jsou ošetřována stromem supervize

## Shrnutí

| Koncept | Účel | Klíčový bod |
|---------|------|-------------|
| **GenServer** | Izolovaný stavový proces | Stav je privátní, přístupný pouze přes zprávy |
| **call** | Synchronní požadavek | Blokuje do odpovědi, vrací `[reply, newState]` |
| **cast** | Async notifikace | Fire-and-forget, vrací nový stav |
| **Supervisor** | Obnova po selhání | Monitoruje děti, restartuje při pádu |
| **Let it crash** | Jednoduchost | Neošetřuj každou chybu, důvěřuj supervizi |

S pochopením těchto konceptů jste připraveni postavit svůj první GenServer.

---

Další: [První GenServer](../02-basics/01-first-genserver.md)
