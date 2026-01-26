# Naučte se noex

Komplexní příručka pro Node.js vývojáře, kteří chtějí pochopit a zvládnout framework noex. Tato příručka učí nejen API, ale hlavně **způsob myšlení** v actor modelu.

## Pro koho je tato příručka?

- Node.js vývojáři (intermediate+)
- Znáte async/await a Promises
- Nepotřebujete předchozí zkušenosti s Erlang/OTP nebo actor modelem
- Hledáte robustní vzory pro stavové aplikace

## Cesta učení

### Část 1: Úvod

Pochopte, proč noex existuje a jaké problémy řeší.

| Kapitola | Popis |
|----------|-------|
| [1.1 Proč noex?](./01-introduction/01-proc-noex.md) | Problémy tradičních Node.js aplikací a jak pomáhá actor model |
| [1.2 Klíčové koncepty](./01-introduction/02-klicove-koncepty.md) | Přehled procesů, zpráv, supervize a "let it crash" |

### Část 2: Základy

Naučte se základní stavební bloky.

| Kapitola | Popis |
|----------|-------|
| [2.1 První GenServer](./02-basics/01-prvni-genserver.md) | Vytvořte svou první stavovou službu |
| [2.2 Životní cyklus procesu](./02-basics/02-zivotni-cyklus.md) | Stavy start, running, terminate |
| [2.3 Call vs Cast](./02-basics/03-call-vs-cast.md) | Synchronní vs asynchronní posílání zpráv |
| [2.4 Registry](./02-basics/04-registry.md) | Vyhledávání pojmenovaných procesů |

### Část 3: Supervision

Budujte fault-tolerantní aplikace.

| Kapitola | Popis |
|----------|-------|
| [3.1 Proč Supervisor?](./03-supervision/01-proc-supervisor.md) | Automatická obnova po selháních |
| [3.2 První Supervisor](./03-supervision/02-prvni-supervisor.md) | Vytváření supervizovaných procesů |
| [3.3 Restart strategie](./03-supervision/03-restart-strategie.md) | one_for_one, one_for_all, rest_for_one |
| [3.4 Restart intenzita](./03-supervision/04-restart-intenzita.md) | Prevence restart smyček |
| [3.5 Stromy supervize](./03-supervision/05-stromy-supervize.md) | Hierarchická izolace selhání |

### Část 4: Myšlení v procesech

Naučte se rozložit problémy na procesy.

| Kapitola | Popis |
|----------|-------|
| [4.1 Mapování problémů](./04-mysleni-v-procesech/01-mapovani-problemu.md) | Jeden proces = jedna zodpovědnost |
| [4.2 Komunikace mezi procesy](./04-mysleni-v-procesech/02-komunikace-mezi-procesy.md) | Call, cast, EventBus, Registry |
| [4.3 Vzory](./04-mysleni-v-procesech/03-vzory.md) | Request-response, worker pool, circuit breaker |

### Část 5: Stavový automat

Explicitní stavy a přechody pro komplexní business logiku.

| Kapitola | Popis |
|----------|-------|
| [5.1 Kdy použít](./05-stavovy-automat/01-kdy-pouzit.md) | Stavový automat vs GenServer |
| [5.2 Definice stavů](./05-stavovy-automat/02-definice-stavu.md) | Stavy, události, přechody |
| [5.3 Workflow objednávky](./05-stavovy-automat/03-objednavka-workflow.md) | Praktický příklad |

### Část 6: Persistence

Přežijte restarty a zotavte se z pádů.

| Kapitola | Popis |
|----------|-------|
| [6.1 Proč persistence?](../learn/06-persistence/01-why-persistence.md) | Obnova stavu po pádu |
| [6.2 Storage adaptery](../learn/06-persistence/02-storage-adapters.md) | Memory, File, SQLite |
| [6.3 Konfigurace](../learn/06-persistence/03-configuration.md) | Snapshoty, restore, shutdown |
| [6.4 Verzování schémat](../learn/06-persistence/04-schema-versioning.md) | Migrace a verzování |

### Část 7: ETS

Vysoce výkonné in-memory úložiště.

| Kapitola | Popis |
|----------|-------|
| [7.1 Co je ETS](../learn/07-ets/01-what-is-ets.md) | Erlang Term Storage v TypeScriptu |
| [7.2 Typy tabulek](../learn/07-ets/02-table-types.md) | set, ordered_set, bag, duplicate_bag |
| [7.3 Praktické použití](../learn/07-ets/03-practical-usage.md) | Cache, sessions, countery |

### Část 8: Vestavěné služby

Služby připravené k použití pro běžné potřeby.

| Kapitola | Popis |
|----------|-------|
| [8.1 EventBus](../learn/08-builtin-services/01-eventbus.md) | Pub/sub messaging |
| [8.2 Cache](../learn/08-builtin-services/02-cache.md) | LRU cache s TTL |
| [8.3 RateLimiter](../learn/08-builtin-services/03-ratelimiter.md) | Sliding window rate limiting |
| [8.4 TimerService](../learn/08-builtin-services/04-timerservice.md) | Trvanlivé naplánované úlohy |

### Část 9: Application

Struktura produkčních aplikací.

| Kapitola | Popis |
|----------|-------|
| [9.1 Struktura aplikace](../learn/09-application/01-application-structure.md) | Entry point a životní cyklus |
| [9.2 Zpracování signálů](../learn/09-application/02-signal-handling.md) | SIGINT/SIGTERM cleanup |
| [9.3 Produkční setup](../learn/09-application/03-production-setup.md) | Config, logging, health checks |

### Část 10: Monitoring

Pozorujte a debugujte své aplikace.

| Kapitola | Popis |
|----------|-------|
| [10.1 Observer](../learn/10-monitoring/01-observer.md) | Introspekce procesů |
| [10.2 Dashboard](../learn/10-monitoring/02-dashboard.md) | TUI a vzdálený monitoring |
| [10.3 AlertManager](../learn/10-monitoring/03-alertmanager.md) | Detekce anomálií |
| [10.4 Debugging](../learn/10-monitoring/04-debugging.md) | Běžné problémy a techniky |

### Část 11: Distribuce

Budujte distribuované systémy.

| Kapitola | Popis |
|----------|-------|
| [11.1 Základy clusteringu](../learn/11-distribution/01-clustering-basics.md) | Uzly, discovery, heartbeats |
| [11.2 Vzdálená volání](../learn/11-distribution/02-remote-calls.md) | Messaging mezi uzly |
| [11.3 Distributed Supervisor](../learn/11-distribution/03-distributed-supervisor.md) | Multi-node supervize |

### Část 12: Projekty

Aplikujte vše v reálných projektech.

| Kapitola | Popis |
|----------|-------|
| [12.1 Chat Server](../learn/12-projects/01-chat-server.md) | WebSocket + noex |
| [12.2 Task Queue](../learn/12-projects/02-task-queue.md) | Zpracování úloh s workery |
| [12.3 API Gateway](../learn/12-projects/03-api-gateway.md) | Rate limiting, caching, circuit breaker |

## Formát kapitol

Každá kapitola obsahuje:

1. **Úvod** - Co se naučíte a proč je to důležité
2. **Teorie** - Vysvětlení konceptu
3. **Příklad** - Spustitelný kód s komentáři
4. **Cvičení** - Praktický úkol (kde je to vhodné)
5. **Shrnutí** - Klíčové poznatky
6. **Další kroky** - Odkaz na další kapitolu

## Získání pomoci

- [API Reference](../../api/index.md) - Kompletní API dokumentace
- [FAQ](../../faq.md) - Často kladené dotazy
- [Příklady](../../examples/index.md) - Další ukázky kódu

---

Připraveni začít? Začněte s [Proč noex?](./01-introduction/01-proc-noex.md)
