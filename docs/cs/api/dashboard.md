# Dashboard API Reference

Třída `Dashboard` poskytuje interaktivní TUI (Terminal User Interface) pro real-time monitoring noex procesů. Postavená na `blessed` a `blessed-contrib`, zobrazuje stromy procesů, statistiky, využití paměti a logy událostí.

## Import

```typescript
import { Dashboard } from 'noex/dashboard';
```

## Přehled

Dashboard poskytuje:

- **Zobrazení stromu procesů**: Hierarchické zobrazení supervisorů a jejich potomků
- **Tabulka statistik**: Real-time metriky pro všechny GenServery
- **Ukazatel paměti**: Vizualizace využití heap
- **Log událostí**: Živý stream událostí životního cyklu
- **Více layoutů**: Plné, kompaktní a minimální zobrazení
- **Klávesová navigace**: Intuitivní ovládání

## Typy

### DashboardConfig

Kompletní konfigurace pro Dashboard.

```typescript
interface DashboardConfig {
  /**
   * Interval obnovování v milisekundách pro dotazování dat.
   * @default 500
   */
  readonly refreshInterval: number;

  /**
   * Maximální počet událostí k uchování v logu událostí.
   * @default 100
   */
  readonly maxEventLogSize: number;

  /**
   * Barevné téma k použití.
   * @default 'dark'
   */
  readonly theme: ThemeName;

  /**
   * Režim layoutu.
   * @default 'full'
   */
  readonly layout: DashboardLayout;
}
```

### DashboardOptions

Částečná konfigurace pro uživatelské přizpůsobení.

```typescript
type DashboardOptions = Partial<DashboardConfig>;
```

### DashboardLayout

Dostupné režimy layoutu.

```typescript
type DashboardLayout = 'full' | 'compact' | 'minimal';
```

- `'full'` - Všechny widgety: strom procesů, tabulka statistik, ukazatel paměti, log událostí
- `'compact'` - Pouze strom procesů + tabulka statistik
- `'minimal'` - Pouze tabulka statistik (pro malé terminály)

### ThemeName

Dostupná barevná témata.

```typescript
type ThemeName = 'dark' | 'light';
```

### DashboardTheme

Konfigurace barevného tématu.

```typescript
interface DashboardTheme {
  readonly primary: string;    // Rámečky a zvýraznění
  readonly secondary: string;  // Méně výrazné prvky
  readonly success: string;    // Běžící stavy
  readonly warning: string;    // Varovné stavy
  readonly error: string;      // Chybové/zastavené stavy
  readonly text: string;       // Výchozí text
  readonly textMuted: string;  // Sekundární text
  readonly background: string; // Barva pozadí
}
```

---

## Konstruktor

### new Dashboard()

Vytvoří novou instanci Dashboardu.

```typescript
constructor(options?: DashboardOptions)
```

**Parametry:**
- `options` - Volitelná konfigurace
  - `refreshInterval` - Interval dotazování v ms (výchozí: 500)
  - `maxEventLogSize` - Max událostí v logu (výchozí: 100)
  - `theme` - Barevné téma: `'dark'` nebo `'light'` (výchozí: `'dark'`)
  - `layout` - Režim layoutu (výchozí: `'full'`)

**Příklad:**
```typescript
// Výchozí konfigurace
const dashboard = new Dashboard();

// Vlastní konfigurace
const dashboard = new Dashboard({
  refreshInterval: 1000,
  theme: 'light',
  layout: 'compact',
});
```

---

## Metody

### start()

Spustí dashboard a zahájí vykreslování.

```typescript
start(): void
```

Vytvoří terminálovou obrazovku, nastaví widgety a zahájí dotazování na aktualizace.

**Vyhazuje:** Chybu, pokud dashboard již běží

**Příklad:**
```typescript
const dashboard = new Dashboard();
dashboard.start();
```

---

### stop()

Zastaví dashboard a uvolní prostředky.

```typescript
stop(): void
```

Odhlásí odběr událostí, zastaví dotazování a zničí terminálovou obrazovku.

**Příklad:**
```typescript
dashboard.stop();
```

---

### refresh()

Vynutí okamžité obnovení všech widgetů.

```typescript
refresh(): void
```

**Příklad:**
```typescript
// Manuální spuštění aktualizace
dashboard.refresh();
```

---

### isRunning()

Vrací, zda dashboard aktuálně běží.

```typescript
isRunning(): boolean
```

**Vrací:** `true` pokud běží

**Příklad:**
```typescript
if (dashboard.isRunning()) {
  console.log('Dashboard je aktivní');
}
```

---

### switchLayout()

Přepne na jiný režim layoutu.

```typescript
switchLayout(layout: DashboardLayout): void
```

**Parametry:**
- `layout` - Režim layoutu: `'full'`, `'compact'`, nebo `'minimal'`

**Příklad:**
```typescript
// Přepnutí na minimální layout
dashboard.switchLayout('minimal');

// Přepnutí zpět na plný layout
dashboard.switchLayout('full');
```

---

### getLayout()

Vrací aktuální režim layoutu.

```typescript
getLayout(): DashboardLayout
```

**Vrací:** Aktuální režim layoutu

---

### selectProcess()

Programově vybere proces a zobrazí jeho detailní pohled.

```typescript
selectProcess(processId: string): void
```

**Parametry:**
- `processId` - ID procesu k výběru

**Příklad:**
```typescript
dashboard.selectProcess('genserver_1_abc123');
```

---

## Klávesové zkratky

| Klávesa | Akce |
|---------|------|
| `q`, `Escape`, `Ctrl+C` | Ukončit dashboard |
| `r` | Obnovit data |
| `?`, `h` | Zobrazit dialog nápovědy |
| `Tab` | Fokus na další widget |
| `Shift+Tab` | Fokus na předchozí widget |
| `Enter` | Zobrazit detailní pohled procesu |
| `1` | Přepnout na plný layout |
| `2` | Přepnout na kompaktní layout |
| `3` | Přepnout na minimální layout |
| Šipky | Navigace v rámci zaměřeného widgetu |

---

## Layouty

### Plný layout

```
+----------------+----------------------------------+
|                |                                  |
|  Strom procesů |       Tabulka statistik          |
|                |                                  |
+----------------+----------------------------------+
|                |                                  |
| Ukazatel paměti|          Log událostí            |
|                |                                  |
+----------------+----------------------------------+
|              Stavový řádek                        |
+---------------------------------------------------+
```

### Kompaktní layout

```
+----------------+----------------------------------+
|                |                                  |
|                |                                  |
|  Strom procesů |       Tabulka statistik          |
|                |                                  |
|                |                                  |
+----------------+----------------------------------+
|              Stavový řádek                        |
+---------------------------------------------------+
```

### Minimální layout

```
+---------------------------------------------------+
|                                                   |
|                                                   |
|               Tabulka statistik                   |
|                                                   |
|                                                   |
+---------------------------------------------------+
|              Stavový řádek                        |
+---------------------------------------------------+
```

---

## Kompletní příklad

```typescript
import { Dashboard } from 'noex/dashboard';
import { GenServer, Supervisor } from 'noex';

async function main() {
  // Vytvoření procesů k monitorování
  const workers = await Promise.all([
    GenServer.start({
      init: () => ({ count: 0 }),
      handleCall: (msg, state) => [state.count, state],
      handleCast: (msg, state) => ({ count: state.count + 1 }),
    }, { name: 'worker-1' }),

    GenServer.start({
      init: () => ({ count: 0 }),
      handleCall: (msg, state) => [state.count, state],
      handleCast: (msg, state) => ({ count: state.count + 1 }),
    }, { name: 'worker-2' }),
  ]);

  // Vytvoření a spuštění dashboardu
  const dashboard = new Dashboard({
    refreshInterval: 500,
    theme: 'dark',
    layout: 'full',
  });

  dashboard.start();

  // Generování aktivity
  setInterval(() => {
    for (const worker of workers) {
      GenServer.cast(worker, 'increment');
    }
  }, 100);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    dashboard.stop();
    for (const worker of workers) {
      await GenServer.stop(worker);
    }
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Spuštění dashboardu

```bash
# Spuštění vaší aplikace s dashboardem
npx tsx src/main.ts

# Nebo přidejte skript do package.json
npm run dashboard
```

---

## Tipy

1. **Velikost terminálu**: Pro nejlepší zážitek použijte terminál alespoň 120x40 znaků
2. **Podpora barev**: Ujistěte se, že váš terminál podporuje 256 barev
3. **SSH sessions**: Funguje přes SSH se správným nastavením terminálu
4. **Čtečky obrazovky**: Zvažte použití textových logů pro přístupnost

---

## Související

- [DashboardServer API](./dashboard-server.md) - Vzdálený přístup k dashboardu
- [Observer API](./observer.md) - Zdroj dat pro dashboard
- [AlertManager API](./alert-manager.md) - Notifikace alertů
