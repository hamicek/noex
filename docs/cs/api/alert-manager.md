# AlertManager API Reference

`AlertManager` poskytuje dynamické alertování založené na prahových hodnotách pro metriky procesů. Používá statistickou analýzu (klouzavý průměr + standardní odchylka) pro automatický výpočet prahů na základě historických dat.

## Import

```typescript
import { AlertManager } from 'noex/observer';
```

## Přehled

AlertManager monitoruje metriky procesů a spouští alerty, když hodnoty překročí dynamicky vypočítané prahy. Klíčové vlastnosti:

- **Automatický výpočet prahů**: Používá vzorec `mean + (multiplier * stddev)`
- **Sledování statistik per-proces**: Efektivní kruhový buffer pro každý proces
- **Mechanismus cooldown**: Zabraňuje zahlcení alerty
- **Události založené na odběru**: Real-time notifikace

## Typy

### AlertConfig

Konfigurace pro AlertManager.

```typescript
interface AlertConfig {
  /** Zda je alertování povoleno */
  readonly enabled: boolean;

  /**
   * Násobitel pro standardní odchylku ve výpočtu prahu.
   * Vyšší hodnoty = méně citlivé (méně alertů).
   * @default 2.0
   */
  readonly sensitivityMultiplier: number;

  /**
   * Minimální počet vzorků požadovaných před spuštěním alertů.
   * Zabraňuje falešným poplachům během rozjezdu systému.
   * @default 30
   */
  readonly minSamples: number;

  /**
   * Doba cooldown v milisekundách mezi alerty pro stejný proces.
   * Zabraňuje zahlcení alerty.
   * @default 10000
   */
  readonly cooldownMs: number;
}
```

### Alert

Aktivní alert indikující, že proces překročil svůj práh.

```typescript
interface Alert {
  /** Unikátní identifikátor této instance alertu */
  readonly id: string;

  /** Typ podmínky, která spustila alert */
  readonly type: AlertType;

  /** ID procesu, který spustil alert */
  readonly processId: string;

  /** Volitelné registrované jméno procesu */
  readonly processName?: string;

  /** Práh, který byl překročen */
  readonly threshold: number;

  /** Aktuální hodnota, která překročila práh */
  readonly currentValue: number;

  /** Unix timestamp, kdy byl alert spuštěn */
  readonly timestamp: number;

  /** Lidsky čitelný popis alertu */
  readonly message: string;
}
```

### AlertType

Typy alertů, které mohou být spuštěny.

```typescript
type AlertType = 'high_queue_size' | 'high_memory';
```

### AlertEvent

Události emitované AlertManagerem.

```typescript
type AlertEvent =
  | { readonly type: 'alert_triggered'; readonly alert: Alert }
  | { readonly type: 'alert_resolved'; readonly alertId: string; readonly processId: string };
```

### AlertEventHandler

Handler funkce pro události alertů.

```typescript
type AlertEventHandler = (event: AlertEvent) => void;
```

---

## Metody

### configure()

Aktualizuje konfiguraci alertů.

```typescript
configure(newConfig: Partial<AlertConfig>): void
```

**Parametry:**
- `newConfig` - Částečná konfigurace pro sloučení s aktuální konfigurací

**Příklad:**
```typescript
// Snížení citlivosti alertů
AlertManager.configure({
  sensitivityMultiplier: 3.0,
});

// Vypnutí alertování
AlertManager.configure({ enabled: false });

// Zkrácení doby cooldown
AlertManager.configure({ cooldownMs: 5000 });
```

---

### getConfig()

Vrací aktuální konfiguraci alertů.

```typescript
getConfig(): Readonly<AlertConfig>
```

**Vrací:** Aktuální konfiguraci (pouze pro čtení)

**Příklad:**
```typescript
const config = AlertManager.getConfig();
console.log(`Citlivost: ${config.sensitivityMultiplier}`);
console.log(`Min. vzorků: ${config.minSamples}`);
```

---

### subscribe()

Přihlásí odběr událostí alertů.

```typescript
subscribe(handler: AlertEventHandler): () => void
```

**Parametry:**
- `handler` - Funkce volaná pro každou událost

**Vrací:** Funkci pro odhlášení odběru

**Příklad:**
```typescript
const unsubscribe = AlertManager.subscribe((event) => {
  if (event.type === 'alert_triggered') {
    console.log(`ALERT: ${event.alert.message}`);
    sendSlackNotification(event.alert);
  } else if (event.type === 'alert_resolved') {
    console.log(`Alert vyřešen pro ${event.processId}`);
  }
});

// Později: ukončení naslouchání
unsubscribe();
```

---

### getActiveAlerts()

Vrací všechny aktuálně aktivní alerty.

```typescript
getActiveAlerts(): readonly Alert[]
```

**Vrací:** Pole aktivních alertů

**Příklad:**
```typescript
const alerts = AlertManager.getActiveAlerts();

if (alerts.length > 0) {
  console.log(`${alerts.length} aktivních alertů:`);
  for (const alert of alerts) {
    console.log(`  [${alert.type}] ${alert.message}`);
  }
}
```

---

### getAlertForProcess()

Vrací aktivní alert pro konkrétní proces.

```typescript
getAlertForProcess(processId: string): Alert | undefined
```

**Parametry:**
- `processId` - ID procesu ke kontrole

**Vrací:** Aktivní alert nebo undefined

**Příklad:**
```typescript
const alert = AlertManager.getAlertForProcess('genserver_1_abc123');
if (alert) {
  console.log(`Proces má aktivní alert: ${alert.message}`);
}
```

---

### getThreshold()

Vrací aktuální dynamický práh pro proces.

```typescript
getThreshold(processId: string): number
```

**Parametry:**
- `processId` - ID procesu pro získání prahu

**Vrací:** Aktuální práh, nebo `Infinity` pokud není dostatek vzorků

**Příklad:**
```typescript
const threshold = AlertManager.getThreshold('genserver_1_abc123');
if (threshold === Infinity) {
  console.log('Ještě není dostatek vzorků');
} else {
  console.log(`Aktuální práh: ${threshold.toFixed(2)}`);
}
```

---

### getProcessStatistics()

Vrací statistiky pro proces.

```typescript
getProcessStatistics(processId: string): Readonly<{
  mean: number;
  stddev: number;
  threshold: number;
  sampleCount: number;
}> | undefined
```

**Parametry:**
- `processId` - ID procesu pro získání statistik

**Vrací:** Objekt se statistikami nebo undefined, pokud data neexistují

**Příklad:**
```typescript
const stats = AlertManager.getProcessStatistics('genserver_1_abc123');
if (stats) {
  console.log(`Průměr: ${stats.mean.toFixed(2)}`);
  console.log(`Std. odchylka: ${stats.stddev.toFixed(2)}`);
  console.log(`Práh: ${stats.threshold.toFixed(2)}`);
  console.log(`Vzorků: ${stats.sampleCount}`);
}
```

---

### recordQueueSize()

Zaznamená vzorek velikosti fronty pro proces.

```typescript
recordQueueSize(processId: string, size: number): void
```

**Parametry:**
- `processId` - ID procesu pro záznam
- `size` - Aktuální velikost fronty

**Poznámka:** Voláno automaticky Observerem během dotazování.

---

### checkAlerts()

Zkontroluje všechny statistiky procesů a spouští/řeší alerty podle potřeby.

```typescript
checkAlerts(serverStats: readonly GenServerStats[]): void
```

**Parametry:**
- `serverStats` - Aktuální statistiky všech serverů

**Poznámka:** Voláno automaticky Observerem během dotazování.

---

### triggerAlert()

Manuálně spustí alert pro proces.

```typescript
triggerAlert(
  type: AlertType,
  processId: string,
  currentValue: number,
): Alert | undefined
```

**Parametry:**
- `type` - Typ alertu
- `processId` - ID procesu
- `currentValue` - Aktuální hodnota metriky

**Vrací:** Vytvořený alert, nebo undefined pokud je aktivní cooldown

**Příklad:**
```typescript
// Spuštění vlastního alertu
const alert = AlertManager.triggerAlert(
  'high_queue_size',
  'genserver_1_abc123',
  150,
);

if (alert) {
  console.log(`Alert spuštěn: ${alert.id}`);
}
```

---

### resolveAlert()

Manuálně vyřeší alert pro proces.

```typescript
resolveAlert(processId: string): boolean
```

**Parametry:**
- `processId` - ID procesu pro vyřešení alertu

**Vrací:** `true` pokud byl alert vyřešen

**Příklad:**
```typescript
const resolved = AlertManager.resolveAlert('genserver_1_abc123');
if (resolved) {
  console.log('Alert vyřešen');
}
```

---

### reset()

Vymaže všechny statistiky, aktivní alerty a resetuje konfiguraci na výchozí hodnoty.

```typescript
reset(): void
```

**Příklad:**
```typescript
// Reset všech stavů alertování
AlertManager.reset();
```

---

### removeProcess()

Odstraní sledování statistik pro konkrétní proces.

```typescript
removeProcess(processId: string): void
```

**Parametry:**
- `processId` - ID procesu k odstranění

---

## Kompletní příklad

```typescript
import { AlertManager, Observer } from 'noex/observer';
import { GenServer } from 'noex';

async function main() {
  // Konfigurace citlivosti alertování
  AlertManager.configure({
    sensitivityMultiplier: 2.5, // Méně citlivé
    minSamples: 50,             // Počkat na více dat
    cooldownMs: 30000,          // 30 sekundový cooldown
  });

  // Odběr alertů
  const unsubscribe = AlertManager.subscribe((event) => {
    if (event.type === 'alert_triggered') {
      const { alert } = event;

      console.log('=== ALERT ===');
      console.log(`Typ: ${alert.type}`);
      console.log(`Proces: ${alert.processName || alert.processId}`);
      console.log(`Zpráva: ${alert.message}`);
      console.log(`Hodnota: ${alert.currentValue} (práh: ${alert.threshold.toFixed(2)})`);

      // Odeslání do externího monitoringu
      sendToSlack(alert);
      sendToDatadog(alert);
    } else {
      console.log(`Alert vyřešen pro ${event.processId}`);
    }
  });

  // Spuštění Observer dotazování (které spouští kontrolu alertů)
  const stopPolling = Observer.startPolling(1000, (event) => {
    if (event.type === 'stats_update') {
      const alerts = AlertManager.getActiveAlerts();
      if (alerts.length > 0) {
        console.log(`Aktivních alertů: ${alerts.length}`);
      }
    }
  });

  // Vaše aplikační logika zde...
  const server = await GenServer.start({
    init: () => ({ queue: [] }),
    handleCall: (msg, state) => [state.queue.length, state],
    handleCast: (msg, state) => ({ queue: [...state.queue, msg] }),
  });

  // Úklid při ukončení
  process.on('SIGTERM', () => {
    stopPolling();
    unsubscribe();
  });
}
```

---

## Jak fungují prahy

AlertManager používá statistickou analýzu pro výpočet dynamických prahů:

```
threshold = mean + (sensitivityMultiplier * stddev)
```

1. **Sběr dat**: Velikost fronty každého procesu je vzorkována během Observer dotazování
2. **Výpočet statistik**: Průměr a standardní odchylka jsou vypočítány ze vzorků
3. **Výpočet prahu**: Práh se přizpůsobuje normálnímu chování každého procesu
4. **Spuštění alertu**: Když aktuální hodnota překročí práh, alert se spustí
5. **Vyřešení alertu**: Když hodnota klesne pod práh, alert je vyřešen

Tento přístup:
- Automaticky se přizpůsobuje normálním zátěžovým vzorcům každého procesu
- Detekuje anomálie relativně k typickému chování
- Zabraňuje falešným poplachům během rozjezdu (požadavek minSamples)
- Zabraňuje únavě z alertů (mechanismus cooldown)

---

## Související

- [Observer API](./observer.md) - Systémová introspekce
- [Dashboard API](./dashboard.md) - TUI monitoring
- [GenServer API](./genserver.md) - Implementace procesů
