# Testování noex aplikací

Tento průvodce pokrývá osvědčené postupy a vzory pro testování aplikací postavených na noex. Probereme unit testování GenServerů, testování supervizorů, integrační testování a běžné testovací utility.

## Přehled

Testování noex aplikací zahrnuje:
- **Unit testy** pro jednotlivé GenServer behaviors
- **Testy supervizorů** pro chování restartů a správu potomků
- **Integrační testy** pro interakce více procesů
- **Izolaci testů** pro zabránění úniku stavu mezi testy

noex je navržen s ohledem na testovatelnost - všechny komponenty lze testovat izolovaně bez složitého nastavení.

---

## Nastavení

### Testovací framework

noex funguje s jakýmkoli JavaScript testovacím frameworkem. Tento průvodce používá [Vitest](https://vitest.dev/), ale vzory se aplikují na Jest, Mocha atd.

```bash
npm install -D vitest
```

### Základní struktura testu

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenServer, Supervisor, Registry } from 'noex';

describe('MyService', () => {
  beforeEach(() => {
    // Resetovat interní stav
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
  });

  afterEach(async () => {
    // Uklidit běžící servery
    Registry._clear();
  });

  it('dělá něco', async () => {
    // Testovací kód
  });
});
```

---

## Unit testování GenServerů

### Testování behavior funkcí

Testujte vaše behavior handlery izolovaně:

```typescript
import { describe, it, expect } from 'vitest';

// Behavior k testování
const counterBehavior = {
  init: () => 0,
  handleCall: (msg, state) => {
    if (msg === 'get') return [state, state];
    if (msg.type === 'add') return [state + msg.value, state + msg.value];
    return [null, state];
  },
  handleCast: (msg, state) => {
    if (msg === 'inc') return state + 1;
    if (msg === 'dec') return state - 1;
    return state;
  },
};

describe('counterBehavior', () => {
  describe('init', () => {
    it('vrací počáteční stav 0', () => {
      expect(counterBehavior.init()).toBe(0);
    });
  });

  describe('handleCall', () => {
    it('vrací aktuální stav pro get', () => {
      const [reply, newState] = counterBehavior.handleCall('get', 5);
      expect(reply).toBe(5);
      expect(newState).toBe(5);
    });

    it('přidává hodnotu pro add zprávu', () => {
      const [reply, newState] = counterBehavior.handleCall(
        { type: 'add', value: 10 },
        5
      );
      expect(reply).toBe(15);
      expect(newState).toBe(15);
    });
  });

  describe('handleCast', () => {
    it('inkrementuje stav pro inc', () => {
      expect(counterBehavior.handleCast('inc', 5)).toBe(6);
    });

    it('dekrementuje stav pro dec', () => {
      expect(counterBehavior.handleCast('dec', 5)).toBe(4);
    });
  });
});
```

### Testování běžících GenServerů

Testujte celý životní cyklus GenServeru:

```typescript
import { GenServer } from 'noex';

describe('Counter GenServer', () => {
  let counterRef;

  beforeEach(async () => {
    counterRef = await GenServer.start(counterBehavior);
  });

  afterEach(async () => {
    if (GenServer.isRunning(counterRef)) {
      await GenServer.stop(counterRef);
    }
  });

  it('startuje s počátečním stavem', async () => {
    const value = await GenServer.call(counterRef, 'get');
    expect(value).toBe(0);
  });

  it('zpracovává call zprávy', async () => {
    const result = await GenServer.call(counterRef, { type: 'add', value: 5 });
    expect(result).toBe(5);
  });

  it('zpracovává cast zprávy', async () => {
    GenServer.cast(counterRef, 'inc');
    GenServer.cast(counterRef, 'inc');

    // Počkat na zpracování castů
    await new Promise((r) => setTimeout(r, 50));

    const value = await GenServer.call(counterRef, 'get');
    expect(value).toBe(2);
  });

  it('zpracovává zprávy v pořadí', async () => {
    GenServer.cast(counterRef, 'inc');
    GenServer.cast(counterRef, 'inc');
    const afterInc = await GenServer.call(counterRef, 'get');

    GenServer.cast(counterRef, 'dec');
    const afterDec = await GenServer.call(counterRef, 'get');

    expect(afterInc).toBe(2);
    expect(afterDec).toBe(1);
  });
});
```

### Testování asynchronní inicializace

```typescript
describe('asynchronní inicializace', () => {
  it('čeká na dokončení async init', async () => {
    const behavior = {
      init: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { ready: true, data: 'loaded' };
      },
      handleCall: (_, state) => [state.data, state],
      handleCast: (_, state) => state,
    };

    const ref = await GenServer.start(behavior);
    const data = await GenServer.call(ref, 'get');

    expect(data).toBe('loaded');

    await GenServer.stop(ref);
  });

  it('zpracovává selhání init', async () => {
    const behavior = {
      init: async () => {
        throw new Error('Init selhal');
      },
      handleCall: () => [null, null],
      handleCast: (_, state) => state,
    };

    await expect(GenServer.start(behavior)).rejects.toThrow('Init selhal');
  });

  it('zpracovává timeout init', async () => {
    const behavior = {
      init: async () => {
        await new Promise((r) => setTimeout(r, 10000)); // Velmi pomalé
        return {};
      },
      handleCall: () => [null, null],
      handleCast: (_, state) => state,
    };

    await expect(
      GenServer.start(behavior, { initTimeout: 100 })
    ).rejects.toThrow();
  });
});
```

### Testování zpracování chyb

```typescript
describe('zpracování chyb', () => {
  it('propaguje chyby z handleCall', async () => {
    const behavior = {
      init: () => null,
      handleCall: () => {
        throw new Error('Chyba handleru');
      },
      handleCast: (_, state) => state,
    };

    const ref = await GenServer.start(behavior);

    await expect(GenServer.call(ref, 'anything')).rejects.toThrow('Chyba handleru');

    await GenServer.stop(ref);
  });

  it('pokračuje ve zpracování po cast chybě', async () => {
    let processedCount = 0;
    const behavior = {
      init: () => 0,
      handleCall: (_, state) => [state, state],
      handleCast: (msg, state) => {
        processedCount++;
        if (msg === 'error') throw new Error('Cast chyba');
        return state + 1;
      },
    };

    const ref = await GenServer.start(behavior);

    GenServer.cast(ref, 'inc');
    GenServer.cast(ref, 'error');  // Vyhodí, ale server pokračuje
    GenServer.cast(ref, 'inc');

    await new Promise((r) => setTimeout(r, 100));

    const value = await GenServer.call(ref, 'get');
    expect(value).toBe(2);  // Oba 'inc' zpracovány
    expect(processedCount).toBe(3);

    await GenServer.stop(ref);
  });
});
```

---

## Testování supervizorů

### Základní testy supervizorů

```typescript
import { Supervisor, GenServer } from 'noex';

describe('Supervisor', () => {
  let supervisorRef;

  afterEach(async () => {
    if (supervisorRef && Supervisor.isRunning(supervisorRef)) {
      await Supervisor.stop(supervisorRef);
    }
  });

  it('startuje s potomky', async () => {
    supervisorRef = await Supervisor.start({
      strategy: 'one_for_one',
      children: [
        { id: 'child1', start: () => GenServer.start(counterBehavior) },
        { id: 'child2', start: () => GenServer.start(counterBehavior) },
      ],
    });

    expect(Supervisor.countChildren(supervisorRef)).toBe(2);
  });

  it('umožňuje dynamickou správu potomků', async () => {
    supervisorRef = await Supervisor.start();

    await Supervisor.startChild(supervisorRef, {
      id: 'dynamic',
      start: () => GenServer.start(counterBehavior),
    });

    expect(Supervisor.countChildren(supervisorRef)).toBe(1);

    await Supervisor.terminateChild(supervisorRef, 'dynamic');

    expect(Supervisor.countChildren(supervisorRef)).toBe(0);
  });
});
```

### Testování chování restartů

```typescript
describe('strategie restartování', () => {
  // Helper pro pád potomka
  function crashChild(ref) {
    GenServer._forceTerminate(ref, { error: new Error('Simulovaný pád') });
  }

  // Helper pro čekání na restart
  async function waitForRestart(supervisor, childId, originalRef, timeout = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const child = Supervisor.getChild(supervisor, childId);
      if (child && child.ref.id !== originalRef.id) {
        return child.ref;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('Timeout při čekání na restart');
  }

  it('restartuje spadlého potomka s one_for_one', async () => {
    const supervisor = await Supervisor.start({
      strategy: 'one_for_one',
      children: [
        { id: 'child1', start: () => GenServer.start(counterBehavior) },
        { id: 'child2', start: () => GenServer.start(counterBehavior) },
      ],
    });

    const child1Before = Supervisor.getChild(supervisor, 'child1');
    const child2Before = Supervisor.getChild(supervisor, 'child2');

    // Shodit child1
    crashChild(child1Before.ref);

    // Počkat na restart
    const newChild1Ref = await waitForRestart(
      supervisor,
      'child1',
      child1Before.ref
    );

    // child1 by měl být nový
    expect(newChild1Ref.id).not.toBe(child1Before.ref.id);

    // child2 by měl být nezměněný
    const child2After = Supervisor.getChild(supervisor, 'child2');
    expect(child2After.ref.id).toBe(child2Before.ref.id);

    await Supervisor.stop(supervisor);
  });

  it('restartuje všechny potomky s one_for_all', async () => {
    const supervisor = await Supervisor.start({
      strategy: 'one_for_all',
      children: [
        { id: 'child1', start: () => GenServer.start(counterBehavior) },
        { id: 'child2', start: () => GenServer.start(counterBehavior) },
      ],
    });

    const child1Before = Supervisor.getChild(supervisor, 'child1');
    const child2Before = Supervisor.getChild(supervisor, 'child2');

    // Shodit child1
    crashChild(child1Before.ref);

    // Počkat na restart child1
    await waitForRestart(supervisor, 'child1', child1Before.ref);

    // Oba by měli mít nové ref
    const child1After = Supervisor.getChild(supervisor, 'child1');
    const child2After = Supervisor.getChild(supervisor, 'child2');

    expect(child1After.ref.id).not.toBe(child1Before.ref.id);
    expect(child2After.ref.id).not.toBe(child2Before.ref.id);

    await Supervisor.stop(supervisor);
  });

  it('sleduje počet restartů', async () => {
    const supervisor = await Supervisor.start({
      strategy: 'one_for_one',
      restartIntensity: { maxRestarts: 10, withinMs: 60000 },
      children: [
        { id: 'child', start: () => GenServer.start(counterBehavior) },
      ],
    });

    const childBefore = Supervisor.getChild(supervisor, 'child');
    expect(childBefore.restartCount).toBe(0);

    // Shodit a počkat na restart
    crashChild(childBefore.ref);
    await waitForRestart(supervisor, 'child', childBefore.ref);

    const childAfter = Supervisor.getChild(supervisor, 'child');
    expect(childAfter.restartCount).toBe(1);

    await Supervisor.stop(supervisor);
  });
});
```

### Testování strategií restartu potomků

```typescript
describe('strategie restartu potomků', () => {
  it('permanent potomek je vždy restartován', async () => {
    const supervisor = await Supervisor.start({
      children: [{
        id: 'permanent',
        start: () => GenServer.start(counterBehavior),
        restart: 'permanent',
      }],
    });

    const before = Supervisor.getChild(supervisor, 'permanent');
    GenServer._forceTerminate(before.ref, 'normal');

    await waitForRestart(supervisor, 'permanent', before.ref);

    expect(Supervisor.getChild(supervisor, 'permanent')).toBeDefined();

    await Supervisor.stop(supervisor);
  });

  it('temporary potomek není nikdy restartován', async () => {
    const supervisor = await Supervisor.start({
      children: [{
        id: 'temporary',
        start: () => GenServer.start(counterBehavior),
        restart: 'temporary',
      }],
    });

    const before = Supervisor.getChild(supervisor, 'temporary');
    GenServer._forceTerminate(before.ref, 'normal');

    await new Promise((r) => setTimeout(r, 100));

    expect(Supervisor.getChild(supervisor, 'temporary')).toBeUndefined();

    await Supervisor.stop(supervisor);
  });
});
```

---

## Integrační testování

### Testování komunikace procesů

```typescript
describe('komunikace procesů', () => {
  it('služby komunikují přes Registry', async () => {
    // Spustit služby
    const userService = await GenServer.start(userBehavior);
    const orderService = await GenServer.start(
      createOrderBehavior(userService)
    );

    Registry.register('user-service', userService);
    Registry.register('order-service', orderService);

    // Testovat komunikaci
    await GenServer.call(userService, {
      type: 'create',
      user: { id: '1', name: 'Alice' },
    });

    const order = await GenServer.call(orderService, {
      type: 'create_order',
      userId: '1',
      items: ['item1'],
    });

    expect(order.userId).toBe('1');

    // Úklid
    await GenServer.stop(orderService);
    await GenServer.stop(userService);
    Registry._clear();
  });
});
```

### Testování EventBus

```typescript
import { EventBus } from 'noex';

describe('EventBus integrace', () => {
  it('doručuje události odběratelům', async () => {
    const bus = await EventBus.start();
    const received = [];

    await EventBus.subscribe(bus, 'user.*', (msg) => {
      received.push(msg);
    });

    EventBus.publish(bus, 'user.created', { id: '1' });
    EventBus.publish(bus, 'user.updated', { id: '1' });
    EventBus.publish(bus, 'order.created', { id: '2' });  // Neodpovídá

    // Počkat na doručení
    await EventBus.publishSync(bus, 'sync', null);

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ id: '1' });

    await EventBus.stop(bus);
  });
});
```

### Testování celých supervizních stromů

```typescript
describe('supervizní strom', () => {
  it('zpracovává kaskádová selhání', async () => {
    // Sestavit strom
    const workerSupervisor = await Supervisor.start({
      strategy: 'one_for_one',
      children: [
        { id: 'worker1', start: () => GenServer.start(workerBehavior) },
        { id: 'worker2', start: () => GenServer.start(workerBehavior) },
      ],
    });

    const root = await Supervisor.start({
      strategy: 'one_for_one',
      children: [
        { id: 'workers', start: async () => workerSupervisor },
      ],
    });

    // Ověřit strukturu
    expect(Supervisor.countChildren(root)).toBe(1);
    expect(Supervisor.countChildren(workerSupervisor)).toBe(2);

    // Shodit workera
    const worker1 = Supervisor.getChild(workerSupervisor, 'worker1');
    GenServer._forceTerminate(worker1.ref, { error: new Error('pád') });

    // Počkat a ověřit, že pouze worker1 byl restartován
    await new Promise((r) => setTimeout(r, 200));

    expect(Supervisor.countChildren(workerSupervisor)).toBe(2);

    await Supervisor.stop(root);
  });
});
```

---

## Testovací utility

### Helper pro úklid

```typescript
// test-helpers.ts
import { GenServer, Supervisor, Registry } from 'noex';

export async function cleanupAll() {
  await Supervisor._clearAll();
  Registry._clearLifecycleHandler();
  Registry._clear();
  GenServer._clearLifecycleHandlers();
  Supervisor._clearLifecycleHandlers();
}

export function resetCounters() {
  GenServer._resetIdCounter();
  Supervisor._resetIdCounter();
}
```

### Helpery pro čekání

```typescript
// Čekat na podmínku
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 1000,
  interval = 10
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('Timeout při čekání na podmínku');
}

// Čekat na zpracování cast zpráv
export async function flushCasts(ref: GenServerRef): Promise<void> {
  // Call bude zařazen po všech čekajících castech
  await GenServer.call(ref, 'get');
}
```

### Sledování událostí životního cyklu

```typescript
export function collectLifecycleEvents() {
  const events: LifecycleEvent[] = [];

  const unsubGenServer = GenServer.onLifecycleEvent((e) => events.push(e));
  const unsubSupervisor = Supervisor.onLifecycleEvent((e) => events.push(e));

  return {
    events,
    cleanup: () => {
      unsubGenServer();
      unsubSupervisor();
    },
  };
}

// Použití
it('sleduje životní cyklus', async () => {
  const { events, cleanup } = collectLifecycleEvents();

  const ref = await GenServer.start(behavior);
  await GenServer.stop(ref);

  expect(events).toHaveLength(2);
  expect(events[0].type).toBe('started');
  expect(events[1].type).toBe('terminated');

  cleanup();
});
```

---

## Osvědčené postupy

### 1. Vždy uklízejte

```typescript
afterEach(async () => {
  // Zastavit všechny servery pro zabránění znečištění testů
  await cleanupAll();
});
```

### 2. Používejte timeouty pro async operace

```typescript
it('zpracovává pomalou operaci', async () => {
  // Nespoléhejte na libovolná zpoždění
  await waitFor(() => someCondition(), 1000);
});
```

### 3. Nejprve testujte behaviors izolovaně

```typescript
// Nejprve testujte pure funkce
describe('behavior handlery', () => {
  it('handleCall vrací správný stav', () => {
    const [reply, state] = behavior.handleCall(msg, initialState);
    expect(reply).toBe(expected);
  });
});

// Pak testujte s GenServerem
describe('běžící server', () => {
  it('zpracovává zprávy správně', async () => {
    const ref = await GenServer.start(behavior);
    // ...
  });
});
```

### 4. Používejte factory funkce pro testovací data

```typescript
function createTestUser(overrides = {}) {
  return {
    id: 'test-1',
    name: 'Test User',
    email: 'test@example.com',
    ...overrides,
  };
}

function createTestBehavior(options = {}) {
  return {
    init: () => ({ ...defaultState, ...options.initialState }),
    handleCall: options.handleCall || defaultHandleCall,
    handleCast: options.handleCast || defaultHandleCast,
  };
}
```

### 5. Testujte chybové cesty

```typescript
describe('zpracování chyb', () => {
  it('zpracovává chybějícího uživatele', async () => {
    const result = await GenServer.call(userService, {
      type: 'get',
      id: 'neexistující',
    });
    expect(result).toBeNull();
  });

  it('vyhazuje při neplatném vstupu', async () => {
    await expect(
      GenServer.call(userService, { type: 'get', id: null })
    ).rejects.toThrow();
  });
});
```

### 6. Mockujte externí závislosti

```typescript
// Vytvořte behavior s injektovanými závislostmi
function createServiceBehavior(deps: {
  database: DatabaseClient;
  logger: Logger;
}) {
  return {
    init: () => ({ db: deps.database }),
    handleCall: async (msg, state) => {
      deps.logger.log('Zpracovávám call');
      const result = await state.db.query(msg.query);
      return [result, state];
    },
    handleCast: (_, state) => state,
  };
}

// V testech
it('dotazuje databázi', async () => {
  const mockDb = { query: vi.fn().mockResolvedValue({ data: 'test' }) };
  const mockLogger = { log: vi.fn() };

  const behavior = createServiceBehavior({
    database: mockDb,
    logger: mockLogger,
  });

  const ref = await GenServer.start(behavior);
  const result = await GenServer.call(ref, { query: 'SELECT *' });

  expect(mockDb.query).toHaveBeenCalledWith('SELECT *');
  expect(result).toEqual({ data: 'test' });

  await GenServer.stop(ref);
});
```

---

## Související

- [Průvodce vytvářením služeb](./building-services.md) - Vytváření testovatelných služeb
- [API Reference GenServeru](../api/genserver.md) - API včetně testovacích helperů
- [API Reference supervizoru](../api/supervisor.md) - Testovací metody supervizoru
