# noex Dokumentace

Elixir-style GenServer a Supervisor vzory pro TypeScript.

**noex** poskytuje robustní abstrakci pro vytváření stavových, odolných služeb v Node.js. Inspirováno Elixir/OTP, přináší GenServer a Supervisor vzory do TypeScriptu s plnou typovou bezpečností.

## Proč noex?

- **Odolnost vůči chybám**: Vytvářejte samoopravující se aplikace s automatickými restart strategiemi
- **Předvídatelný stav**: Serializované zpracování zpráv eliminuje race conditions
- **Typová bezpečnost**: Plná podpora TypeScriptu s branded types a striktním typováním
- **Žádné závislosti**: Základní knihovna je lehká a zaměřená
- **Známé vzory**: Pokud znáte Elixir/OTP, budete se cítit jako doma

## Rychlá navigace

| Sekce | Popis |
|-------|-------|
| [Začínáme](./getting-started/index.md) | Instalace, rychlý start, první aplikace |
| [Základní koncepty](./concepts/index.md) | GenServer, Supervisor, Registry, životní cyklus |
| [Distribuce](./distribution/index.md) | Clustering, vzdálené procesy, odolnost proti chybám |
| [Průvodci](./guides/index.md) | Vytváření služeb, supervision stromy, testování |
| [Tutoriály](./tutorials/index.md) | Projekty krok za krokem (chat server, e-commerce) |
| [API Reference](./api/index.md) | Kompletní API dokumentace |
| [Příklady](./examples/index.md) | Ukázky kódu s vysvětlením |
| [FAQ](./faq.md) | Často kladené otázky |

## Instalace

```bash
npm install noex
```

Vyžaduje Node.js 20.0.0 nebo novější.

## Rychlý příklad

```typescript
import { GenServer, Supervisor, Registry } from 'noex';

// Definice counter služby
const counterBehavior = {
  init: () => 0,
  handleCall: (msg: 'get', state: number) => [state, state] as const,
  handleCast: (msg: 'inc' | 'dec', state: number) =>
    msg === 'inc' ? state + 1 : state - 1,
};

// Spuštění pod supervizí
const supervisor = await Supervisor.start({
  strategy: 'one_for_one',
  children: [
    {
      id: 'counter',
      start: async () => {
        const ref = await GenServer.start(counterBehavior);
        Registry.register('counter', ref);
        return ref;
      },
    },
  ],
});

// Použití služby
const counter = Registry.lookup<number, 'get', 'inc' | 'dec', number>('counter');
GenServer.cast(counter, 'inc');
GenServer.cast(counter, 'inc');
const value = await GenServer.call(counter, 'get'); // 2

// Elegantní ukončení
await Supervisor.stop(supervisor);
```

## Přehled funkcí

### Jádro

| Funkce | Popis |
|--------|-------|
| **GenServer** | Stavové služby se serializovaným zpracováním zpráv |
| **Supervisor** | Automatické restart strategie (one_for_one, one_for_all, rest_for_one) |
| **Registry** | Vyhledávání procesů podle jména pro volné provázání |

### Vestavěné služby

| Služba | Popis |
|--------|-------|
| **EventBus** | Pub/sub messaging s wildcard pattern matching |
| **Cache** | In-memory cache s TTL a LRU eviction |
| **RateLimiter** | Sliding window rate limiting |

### Observabilita

| Funkce | Popis |
|--------|-------|
| **Observer** | Real-time introspekce do stavu procesů |
| **AlertManager** | Dynamické threshold alerting a detekce anomálií |
| **Dashboard** | TUI-based monitorovací rozhraní |
| **DashboardServer** | Vzdálený monitoring přes TCP |

### Distribuce

| Funkce | Popis |
|--------|-------|
| **Cluster** | P2P discovery uzlů a membership |
| **RemoteCall/Cast** | Transparentní messaging mezi uzly |
| **GlobalRegistry** | Cluster-wide pojmenování procesů |
| **DistributedSupervisor** | Multi-node supervize s failover |

## Další informace

- **Nový v noex?** Začněte s [Začínáme](./getting-started/index.md)
- **Přicházíte z Elixiru?** Podívejte se na [Porovnání s Elixirem](./concepts/elixir-comparison.md)
- **Chcete jít do hloubky?** Přečtěte si [Základní koncepty](./concepts/index.md)
- **Stavíte distribuované systémy?** Prozkoumejte [Distribuce](./distribution/index.md)
- **Hledáte příklady?** Prozkoumejte [Tutoriály](./tutorials/index.md) a [Příklady](./examples/index.md)

## Verze

Aktuální verze: **0.1.0**

Viz [Seznam změn](./changelog.md) pro historii vydání.

## Přispívání

Vítáme příspěvky! Podívejte se na [Průvodce přispíváním](./contributing.md) pro detaily.

## Licence

MIT

---

*[English version](../index.md)*
