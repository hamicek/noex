# TUI Dashboard pro noex

Plán implementace terminálového dashboardu pro monitoring noex procesů.

## Cíl

Vytvořit interaktivní TUI (Terminal User Interface) dashboard, který zobrazuje stav supervizního stromu, statistiky GenServerů a real-time události. Dashboard využije existující Observer modul.

## Výběr knihovny

**Doporučení: blessed-contrib** (postavený na blessed)

Alternativy:
- `blessed` - Nízkoúrovňová TUI knihovna
- `blessed-contrib` - Rozšíření s dashboardovými widgety (grafy, tabulky, stromy)
- `ink` - React-like přístup pro terminál
- `neo-blessed` - Modernější fork blessed

blessed-contrib je ideální volba, protože:
- Má předpřipravené widgety pro dashboard (tree, table, line chart, gauge)
- Aktivní komunita a dokumentace
- Dobře funguje pro monitoring/dashboard use-case

## Architektura

```
src/dashboard/
├── index.ts           # Export a factory funkce
├── dashboard.ts       # Hlavní Dashboard třída
├── widgets/
│   ├── process-tree.ts    # Vizualizace supervizního stromu
│   ├── stats-table.ts     # Tabulka statistik procesů
│   ├── memory-gauge.ts    # Gauge pro memory usage
│   ├── event-log.ts       # Log posledních událostí
│   └── message-chart.ts   # Graf zpráv za čas
├── layouts/
│   ├── main-layout.ts     # Hlavní rozložení dashboardu
│   └── types.ts           # Layout typy
└── utils/
    ├── formatters.ts      # Formátování dat pro zobrazení
    └── keyboard.ts        # Keyboard shortcuts handler
```

## Komponenty dashboardu

### 1. Process Tree Widget
- Vizualizace supervizního stromu z `Observer.getProcessTree()`
- Barevné rozlišení stavu (zelená = running, červená = stopped, žlutá = initializing)
- Navigace šipkami, Enter pro detail

### 2. Stats Table Widget
- Tabulka všech GenServerů s metrikami:
  - ID, Status, Queue Size, Message Count, Uptime, Memory
- Řazení podle sloupců (Tab pro přepínání)
- Zvýraznění procesů s vysokou frontou

### 3. Memory Gauge Widget
- Vizuální gauge celkové paměti (heapUsed / heapTotal)
- Barevné pásma (zelená < 60%, žlutá < 80%, červená > 80%)

### 4. Event Log Widget
- Scrollovatelný log posledních N událostí
- Typy: started, stopped, crashed, restarted, alert
- Timestamp + message + severity

### 5. Message Chart Widget (volitelné)
- Line chart s počtem zpráv za čas
- Rolling window posledních 60 sekund

## Keyboard Shortcuts

| Klávesa | Akce |
|---------|------|
| `q` / `Escape` | Ukončit dashboard |
| `r` | Refresh / force update |
| `↑↓` | Navigace v process tree |
| `Enter` | Detail vybraného procesu |
| `Tab` | Přepínání mezi widgety |
| `1-5` | Přepínání pohledů/layoutů |
| `?` | Zobrazit nápovědu |

## API

```typescript
import { Dashboard } from 'noex/dashboard';

// Základní použití
const dashboard = new Dashboard();
dashboard.start();

// S konfigurací
const dashboard = new Dashboard({
  refreshInterval: 500,    // ms
  maxEventLogSize: 100,
  theme: 'dark',           // 'dark' | 'light'
  layout: 'full',          // 'full' | 'compact' | 'minimal'
});

dashboard.start();

// Programatické ovládání
dashboard.refresh();
dashboard.selectProcess(processId);
dashboard.stop();
```

## Implementační kroky

### Fáze 1: Základní infrastruktura ✅
1. ✅ Přidat blessed-contrib jako dev dependency
2. ✅ Vytvořit základní Dashboard třídu s lifecycle (start/stop)
3. ✅ Implementovat základní layout s grid systémem
4. ✅ Napojení na Observer pro data

### Fáze 2: Core widgety ✅
5. ✅ Implementovat Process Tree widget
6. ✅ Implementovat Stats Table widget
7. ✅ Implementovat Memory Gauge widget
8. ✅ Implementovat Event Log widget

### Fáze 3: Interaktivita ✅
9. ✅ Implementovat keyboard handling
10. ✅ Přidat navigaci mezi widgety
11. ✅ Implementovat detail view pro proces

### Fáze 4: Polish
12. ✅ Přidat barevné schéma a theming
13. ✅ Implementovat různé layouty (full/compact/minimal)
14. ✅ Přidat help screen
15. Napsat dokumentaci a příklady

## Integrace s Observer

Dashboard využije existující Observer API:

```typescript
// Získání dat
const snapshot = Observer.getSnapshot();
const tree = Observer.getProcessTree();
const memory = getMemoryStats();

// Real-time události
const unsubscribe = Observer.subscribe((event) => {
  dashboard.handleEvent(event);
});

// Polling pro statistiky
Observer.startPolling(500);
```

## Příklad výstupu

```
┌─ noex Dashboard ─────────────────────────────────────────────────────────────┐
│                                                                              │
│  ┌─ Process Tree ──────────────┐  ┌─ Memory ─────────────────────────────┐  │
│  │ ▼ supervisor:main           │  │ ████████████░░░░░░░░ 62% (128MB)     │  │
│  │   ├─ ● counter (running)    │  └──────────────────────────────────────┘  │
│  │   ├─ ● cache (running)      │                                            │
│  │   └─ ○ worker (stopped)     │  ┌─ Stats ──────────────────────────────┐  │
│  └─────────────────────────────┘  │ ID        Status   Queue  Msgs  Mem  │  │
│                                   │ counter   running  0      1.2k  64KB │  │
│  ┌─ Events ────────────────────┐  │ cache     running  2      890   128KB│  │
│  │ 12:34:56 server_started     │  │ worker    stopped  0      0     -    │  │
│  │ 12:34:58 stats_update       │  └──────────────────────────────────────┘  │
│  │ 12:35:01 alert: high_queue  │                                            │
│  └─────────────────────────────┘                                            │
│                                                                              │
│  [q]uit  [r]efresh  [?]help                              Uptime: 00:05:32   │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Poznámky

- Dashboard je volitelná komponenta, neměla by být součástí hlavního exportu
- Blessed-contrib bude dev/optional dependency
- Zvážit lazy loading pro minimalizaci startup time
- Testování: jednotkové testy pro formattery, manuální testy pro UI
