# Historie změn

Všechny významné změny v noex budou dokumentovány v tomto souboru.

Formát je založen na [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
a tento projekt dodržuje [Sémantické verzování](https://semver.org/spec/v2.0.0.html).

## [Nevydáno]

### Přidáno
- Komplexní dokumentační web s tutoriály a průvodci

---

## [0.1.0] - 2025-01-01

### Přidáno

#### Jádro
- **GenServer** - Vzor generického serveru pro stavové procesy
  - Synchronní volání s `GenServer.call()`
  - Asynchronní casty s `GenServer.cast()`
  - Lifecycle hooky (`init`, `terminate`)
  - Konfigurovatelný timeout volání
  - Typovaný stav a zprávy s plnou podporou TypeScript

- **Supervisor** - Supervize procesů odolná vůči chybám
  - Strategie restartování: `one_for_one`, `one_for_all`, `rest_for_one`
  - Typy restartu: `permanent`, `temporary`, `transient`
  - Konfigurovatelná intenzita restartování (max restartů v časovém okně)
  - Hierarchické supervizní stromy

- **Registry** - Vyhledávání pojmenovaných procesů
  - Registrace procesů podle jména
  - Vyhledávání procesů podle jména
  - Automatická odregistrace při ukončení procesu
  - Typově bezpečné vyhledávání

#### Vestavěné služby
- **EventBus** - Pub/sub zasílání zpráv
  - Odběry založené na tématech
  - Porovnávání se zástupnými znaky (`user.*`, `*.created`)
  - Asynchronní doručování zpráv

- **Cache** - In-memory cache
  - Podpora TTL (time-to-live)
  - LRU politika vytěsňování
  - Konfigurovatelná maximální velikost

- **RateLimiter** - Omezování rychlosti
  - Algoritmus posuvného okna
  - Konfigurovatelné limity a okna
  - Omezování rychlosti podle klíče

#### Pozorovatelnost
- **Observer** - Runtime introspekce
  - Inspekce stavu procesů
  - Monitorování fronty zpráv
  - Statistiky procesů

- **AlertManager** - Systém alertů
  - Alerty založené na prazích
  - Detekce anomálií
  - Handlery alertů

- **Dashboard** - Terminálové UI
  - Real-time monitorování procesů
  - Využití CPU a paměti
  - Interaktivní TUI rozhraní

- **DashboardServer** - Vzdálené monitorování
  - TCP server pro vzdálené připojení dashboardu
  - Podpora více klientů

### Technické detaily
- Napsáno v TypeScriptu s plnými typovými definicemi
- Žádné runtime závislosti (core knihovna)
- Pouze ESM distribuce
- Vyžaduje Node.js 20.0.0+

---

## Historie verzí

| Verze | Datum vydání | Hlavní novinky |
|-------|--------------|----------------|
| 0.1.0 | 2025-01-01   | Úvodní vydání s GenServer, Supervisor, Registry |

---

*Pro migrační průvodce mezi verzemi viz [Průvodce migrací](./migration.md).*
