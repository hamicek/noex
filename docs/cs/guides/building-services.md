# Vytváření služeb s GenServerem

Tento průvodce vysvětluje, jak vytvářet robustní, dobře strukturované služby pomocí vzoru GenServer v noex.

## Přehled

GenServer (Generický Server) je základním stavebním blokem pro stavové služby v noex. Poskytuje:

- **Izolovaný stav**: Každá instance serveru udržuje svůj vlastní stav
- **Komunikace založená na zprávách**: Všechny interakce probíhají prostřednictvím zpráv
- **Sekvenční zpracování**: Zprávy jsou zpracovávány jedna po druhé
- **Správa životního cyklu**: Čisté spuštění a vypnutí

## Základní struktura

Každá služba GenServer následuje tuto strukturu:

```typescript
import { GenServer, type GenServerBehavior, type GenServerRef } from 'noex';

// 1. Definice typu stavu
interface MyServiceState {
  // Vaše pole stavu
}

// 2. Definice typů zpráv
type MyServiceCall = /* call zprávy */;
type MyServiceCast = /* cast zprávy */;
type MyServiceReply = /* typy odpovědí */;

// 3. Definice typu reference
type MyServiceRef = GenServerRef<
  MyServiceState,
  MyServiceCall,
  MyServiceCast,
  MyServiceReply
>;

// 4. Implementace behavior
const myServiceBehavior: GenServerBehavior<
  MyServiceState,
  MyServiceCall,
  MyServiceCast,
  MyServiceReply
> = {
  init: () => { /* vrátit počáteční stav */ },
  handleCall: (msg, state) => { /* zpracovat calls */ },
  handleCast: (msg, state) => { /* zpracovat casts */ },
  terminate: (reason, state) => { /* úklid */ },
};

// 5. Export veřejného API
export const MyService = {
  async start(): Promise<MyServiceRef> {
    return GenServer.start(myServiceBehavior);
  },
  // ... další metody
};
```

---

## Krok 1: Navrhněte svůj stav

Začněte definicí, jaký stav vaše služba potřebuje udržovat:

```typescript
interface UserServiceState {
  users: Map<string, User>;
  lastActivity: Date;
  config: {
    maxUsers: number;
    sessionTimeout: number;
  };
}
```

**Osvědčené postupy:**
- Používejte immutable vzory (spread, new Map/Set)
- Udržujte stav minimální a zaměřený
- Vyhněte se ukládání odvozených dat, která lze vypočítat

---

## Krok 2: Definujte typy zpráv

Použijte diskriminované unie pro typově bezpečné zpracování zpráv:

```typescript
// Synchronní zprávy (volající čeká na odpověď)
type UserServiceCall =
  | { type: 'get_user'; id: string }
  | { type: 'list_users' }
  | { type: 'get_count' };

// Asynchronní zprávy (fire-and-forget)
type UserServiceCast =
  | { type: 'create_user'; user: User }
  | { type: 'delete_user'; id: string }
  | { type: 'update_config'; config: Partial<Config> };

// Typy odpovědí
type UserServiceReply = User | User[] | number | null;
```

**Pokyny:**
- Používejte `call` pro operace, které potřebují odpověď
- Používejte `cast` pro fire-and-forget operace
- Udržujte typy zpráv jednoduché a zaměřené

---

## Krok 3: Implementujte behavior

### init()

Inicializujte svůj stav při spuštění serveru:

```typescript
init: () => ({
  users: new Map(),
  lastActivity: new Date(),
  config: {
    maxUsers: 1000,
    sessionTimeout: 3600000,
  },
}),

// Asynchronní inicializace
init: async () => {
  const config = await loadConfig();
  const users = await loadFromDatabase();
  return { users, config, lastActivity: new Date() };
},
```

### handleCall()

Zpracujte synchronní požadavky a vraťte `[reply, newState]`:

```typescript
handleCall: (msg, state) => {
  switch (msg.type) {
    case 'get_user': {
      const user = state.users.get(msg.id) ?? null;
      return [user, state];
    }

    case 'list_users': {
      const users = Array.from(state.users.values());
      return [users, state];
    }

    case 'get_count': {
      return [state.users.size, state];
    }
  }
},
```

### handleCast()

Zpracujte asynchronní zprávy a vraťte nový stav:

```typescript
handleCast: (msg, state) => {
  switch (msg.type) {
    case 'create_user': {
      const newUsers = new Map(state.users);
      newUsers.set(msg.user.id, msg.user);
      return {
        ...state,
        users: newUsers,
        lastActivity: new Date(),
      };
    }

    case 'delete_user': {
      const newUsers = new Map(state.users);
      newUsers.delete(msg.id);
      return { ...state, users: newUsers };
    }

    case 'update_config': {
      return {
        ...state,
        config: { ...state.config, ...msg.config },
      };
    }
  }
},
```

### terminate()

Ukliďte zdroje při zastavení serveru:

```typescript
terminate: async (reason, state) => {
  // Uložit stav do databáze
  await saveToDatabase(state.users);

  // Zavřít spojení
  if (state.dbConnection) {
    await state.dbConnection.close();
  }

  // Zalogovat vypnutí
  console.log(`UserService ukončen: ${reason}`);
},
```

---

## Krok 4: Vytvořte veřejné API

Zabalte GenServer volání do čistého veřejného rozhraní:

```typescript
export const UserService = {
  async start(options: UserServiceOptions = {}): Promise<UserServiceRef> {
    const behavior = createUserServiceBehavior(options);
    return GenServer.start(behavior, { name: options.name });
  },

  async getUser(ref: UserServiceRef, id: string): Promise<User | null> {
    return GenServer.call(ref, { type: 'get_user', id }) as Promise<User | null>;
  },

  async listUsers(ref: UserServiceRef): Promise<User[]> {
    return GenServer.call(ref, { type: 'list_users' }) as Promise<User[]>;
  },

  async getCount(ref: UserServiceRef): Promise<number> {
    return GenServer.call(ref, { type: 'get_count' }) as Promise<number>;
  },

  createUser(ref: UserServiceRef, user: User): void {
    GenServer.cast(ref, { type: 'create_user', user });
  },

  deleteUser(ref: UserServiceRef, id: string): void {
    GenServer.cast(ref, { type: 'delete_user', id });
  },

  async stop(ref: UserServiceRef): Promise<void> {
    await GenServer.stop(ref);
  },
} as const;
```

---

## Kompletní příklad: Služba Counter

```typescript
import { GenServer, type GenServerBehavior, type GenServerRef } from 'noex';

// Typy
interface CounterState {
  value: number;
  history: number[];
  maxHistory: number;
}

type CounterCall =
  | { type: 'get' }
  | { type: 'get_history' };

type CounterCast =
  | { type: 'increment'; by?: number }
  | { type: 'decrement'; by?: number }
  | { type: 'reset' };

type CounterReply = number | number[];

type CounterRef = GenServerRef<CounterState, CounterCall, CounterCast, CounterReply>;

// Behavior
const counterBehavior: GenServerBehavior<
  CounterState,
  CounterCall,
  CounterCast,
  CounterReply
> = {
  init: () => ({
    value: 0,
    history: [],
    maxHistory: 100,
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.value, state];
      case 'get_history':
        return [state.history, state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'increment': {
        const by = msg.by ?? 1;
        const value = state.value + by;
        const history = [...state.history, value].slice(-state.maxHistory);
        return { ...state, value, history };
      }

      case 'decrement': {
        const by = msg.by ?? 1;
        const value = state.value - by;
        const history = [...state.history, value].slice(-state.maxHistory);
        return { ...state, value, history };
      }

      case 'reset':
        return { ...state, value: 0, history: [] };
    }
  },

  terminate: (reason, state) => {
    console.log(`Counter ukončen s hodnotou ${state.value}`);
  },
};

// Veřejné API
export const Counter = {
  async start(name?: string): Promise<CounterRef> {
    return GenServer.start(counterBehavior, name ? { name } : {});
  },

  async get(ref: CounterRef): Promise<number> {
    return GenServer.call(ref, { type: 'get' }) as Promise<number>;
  },

  async getHistory(ref: CounterRef): Promise<number[]> {
    return GenServer.call(ref, { type: 'get_history' }) as Promise<number[]>;
  },

  increment(ref: CounterRef, by?: number): void {
    GenServer.cast(ref, { type: 'increment', by });
  },

  decrement(ref: CounterRef, by?: number): void {
    GenServer.cast(ref, { type: 'decrement', by });
  },

  reset(ref: CounterRef): void {
    GenServer.cast(ref, { type: 'reset' });
  },

  async stop(ref: CounterRef): Promise<void> {
    await GenServer.stop(ref);
  },
} as const;

// Použití
async function main() {
  const counter = await Counter.start('my-counter');

  Counter.increment(counter);
  Counter.increment(counter, 5);
  Counter.decrement(counter, 2);

  console.log(await Counter.get(counter));        // 4
  console.log(await Counter.getHistory(counter)); // [1, 6, 4]

  await Counter.stop(counter);
}
```

---

## Komunikace mezi službami

Služby mohou mezi sebou komunikovat předáváním referencí:

```typescript
interface OrderServiceState {
  orders: Map<string, Order>;
  userServiceRef: UserServiceRef | null;
}

type OrderServiceCast =
  | { type: 'set_user_service'; ref: UserServiceRef }
  | { type: 'create_order'; userId: string; items: string[] };

handleCast: async (msg, state) => {
  switch (msg.type) {
    case 'set_user_service':
      return { ...state, userServiceRef: msg.ref };

    case 'create_order': {
      // Zavolat jinou službu
      if (state.userServiceRef) {
        const user = await GenServer.call(state.userServiceRef, {
          type: 'get_user',
          id: msg.userId,
        });

        if (user) {
          // Vytvořit objednávku...
        }
      }
      return state;
    }
  }
},
```

---

## Osvědčené postupy

1. **Udržujte stav immutable**: Vždy vracejte nové stavové objekty
2. **Používejte typované zprávy**: Využívejte TypeScript pro typovou bezpečnost
3. **Ošetřete všechny případy**: Používejte vyčerpávající switch statements
4. **Oddělte zodpovědnosti**: Jedna služba, jedna zodpovědnost
5. **Čisté veřejné API**: Skryjte interní detaily GenServeru
6. **Korektní ukončení**: Vždy implementujte `terminate`
7. **Zpracování chyb**: Nechte chyby způsobit pád; supervisor restartuje

---

## Související

- [Koncepty GenServeru](../concepts/genserver.md) - Pochopení GenServeru
- [Průvodce supervizními stromy](./supervision-trees.md) - Organizace služeb
- [Průvodce meziprocesovou komunikací](./inter-process-communication.md) - Komunikace služeb
- [API Reference GenServeru](../api/genserver.md) - Kompletní API dokumentace
