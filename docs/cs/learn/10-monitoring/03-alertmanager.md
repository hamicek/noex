# AlertManager

V předchozích kapitolách jste se naučili inspektovat procesy pomocí Observeru a vizualizovat stav systému pomocí Dashboardu. Nyní je čas prozkoumat **AlertManager** — systém statistické detekce anomálií, který automaticky identifikuje procesy chující se abnormálně a upozorní vás, když může být nutný zásah.

## Co se naučíte

- Porozumět dynamickému výpočtu prahů pomocí statistické analýzy
- Konfigurovat citlivost, minimální počet vzorků a cooldown periody
- Přihlásit se k událostem alertů pro real-time notifikace
- Dotazovat se a spravovat aktivní alerty
- Manuálně spouštět a řešit alerty pro testování
- Integrovat AlertManager s Observerem pro komplexní monitoring

## Dynamické prahové alertování

Tradiční systémy alertování vyžadují nastavení statických prahů: "alertovat pokud velikost fronty > 100". Problém je, že fronta 100 může být normální pro zaneprázdněného workera, ale kritická pro lehkou službu. Statické prahy buď minou skutečné problémy, nebo vytvoří únavu z alertů.

**AlertManager používá jiný přístup**: učí se co je "normální" pro každý proces sběrem vzorků v čase, pak vypočítá dynamické prahy pomocí statistické analýzy:

```
práh = průměr + (sensitivityMultiplier × směrodatná_odchylka)
```

Tento přístup se adaptuje na unikátní chování každého procesu:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    VÝPOČET DYNAMICKÉHO PRAHU                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Proces A (Nízký provoz)              Proces B (Vysoký provoz)              │
│  ────────────────────────             ────────────────────────              │
│  Vzorky: 2, 3, 2, 4, 3, 2, 3, 2       Vzorky: 80, 95, 85, 90, 88, 92       │
│  Průměr: 2.6                          Průměr: 88.3                          │
│  Odchylka: 0.7                        Odchylka: 5.2                         │
│  Práh: 2.6 + (2 × 0.7) = 4.0          Práh: 88.3 + (2 × 5.2) = 98.7        │
│                                                                             │
│  Fronta = 6 → ALERT! (6 > 4.0)        Fronta = 95 → OK (95 < 98.7)         │
│  Fronta = 4 → OK (4 = 4.0)            Fronta = 150 → ALERT! (150 > 98.7)   │
│                                                                             │
│  Stejná velikost fronty, různé prahy založené na normálním chování!         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Konfigurace

AlertManager poskytuje rozumné výchozí hodnoty, ale umožňuje plné přizpůsobení:

```typescript
import { AlertManager } from '@hamicek/noex';

// Zobrazit aktuální konfiguraci
const config = AlertManager.getConfig();
console.log(config);
// {
//   enabled: true,
//   sensitivityMultiplier: 2.0,
//   minSamples: 30,
//   cooldownMs: 10000
// }

// Aktualizovat konfiguraci (podporovány částečné aktualizace)
AlertManager.configure({
  sensitivityMultiplier: 2.5,  // Méně citlivý (vyšší práh)
  minSamples: 50,              // Potřeba více dat před alertováním
  cooldownMs: 30000,           // 30 sekund mezi alerty
});
```

### Konfigurační možnosti

| Možnost | Výchozí | Popis |
|---------|---------|-------|
| `enabled` | `true` | Hlavní přepínač pro alertování |
| `sensitivityMultiplier` | `2.0` | Kolik směrodatných odchylek nad průměrem spustí alert |
| `minSamples` | `30` | Vzorků potřebných než mohou alerty vzniknout (prevence false positives při rozjezdu) |
| `cooldownMs` | `10000` | Minimální čas mezi alerty pro stejný proces |

### Pokyny pro citlivost

`sensitivityMultiplier` řídí jak neobvyklá musí hodnota být pro spuštění alertu:

| Násobitel | Význam | Případ použití |
|-----------|--------|----------------|
| 1.5 | ~13% šance false positive | Vysoká citlivost, kritické systémy |
| 2.0 | ~5% šance false positive | Vyvážený výchozí stav |
| 2.5 | ~1% šance false positive | Méně šumu, může minout některé anomálie |
| 3.0 | ~0.3% šance false positive | Pouze velké anomálie |

```typescript
// Vysoká citlivost pro kritický procesor plateb
AlertManager.configure({ sensitivityMultiplier: 1.5 });

// Nízká citlivost pro nekritické background workery
AlertManager.configure({ sensitivityMultiplier: 3.0 });
```

## Přihlášení k odběru alertů

AlertManager používá model odběru pro real-time notifikace:

```typescript
import { AlertManager, type AlertEvent } from '@hamicek/noex';

const unsubscribe = AlertManager.subscribe((event: AlertEvent) => {
  switch (event.type) {
    case 'alert_triggered':
      console.log(`[ALERT] ${event.alert.message}`);
      console.log(`  Proces: ${event.alert.processId}`);
      console.log(`  Aktuální hodnota: ${event.alert.currentValue}`);
      console.log(`  Práh: ${event.alert.threshold.toFixed(1)}`);
      // Odeslat do PagerDuty, Slack, email, atd.
      break;

    case 'alert_resolved':
      console.log(`[VYŘEŠENO] Proces ${event.processId} zpět v normálu`);
      // Vymazat alert ve vašem incident systému
      break;
  }
});

// Později: přestat přijímat alerty
unsubscribe();
```

### Typy Alert událostí

```typescript
type AlertEvent =
  | { type: 'alert_triggered'; alert: Alert }
  | { type: 'alert_resolved'; alertId: string; processId: string };
```

### Struktura Alert objektu

Když je alert spuštěn, obdržíte kompletní `Alert` objekt:

```typescript
interface Alert {
  id: string;           // Unikátní identifikátor, např. "alert_1706123456789_1"
  type: AlertType;      // Aktuálně 'high_queue_size' | 'high_memory'
  processId: string;    // Ovlivněné ID procesu
  processName?: string; // Název v Registry pokud registrován
  threshold: number;    // Vypočítaný práh který byl překročen
  currentValue: number; // Aktuální hodnota která spustila alert
  timestamp: number;    // Unix timestamp kdy byl alert spuštěn
  message: string;      // Lidsky čitelný popis
}
```

Příklad alertu:

```typescript
{
  id: 'alert_1706123456789_42',
  type: 'high_queue_size',
  processId: 'genserver_5_abc123',
  processName: 'order_processor',
  threshold: 45.3,
  currentValue: 127,
  timestamp: 1706123456789,
  message: 'Velikost fronty překročila práh: 127 > 45.3 (proces: order_processor)'
}
```

## Integrace s Observerem

AlertManager se bezproblémově integruje s Observerem. Můžete se přihlásit k odběru přes obě API:

```typescript
import { Observer, AlertManager } from '@hamicek/noex';

// Tyto jsou ekvivalentní:
const unsub1 = AlertManager.subscribe(handler);
const unsub2 = Observer.subscribeToAlerts(handler);

// Získat aktivní alerty přes obě API:
const alerts1 = AlertManager.getActiveAlerts();
const alerts2 = Observer.getActiveAlerts();
```

Když použijete `Observer.startPolling()`, automaticky:
1. Sbírá vzorky velikosti fronty pro každý proces
2. Aktualizuje statistický model
3. Kontroluje porušení prahů
4. Spouští nebo řeší alerty dle potřeby

```typescript
// Observer pollování spouští kontroly AlertManageru automaticky
const stopPolling = Observer.startPolling(1000, (event) => {
  if (event.type === 'stats_update') {
    // AlertManager.checkAlerts() byl zavolán automaticky
    console.log(`Zkontrolováno ${event.servers.length} serverů pro anomálie`);
  }
});
```

## Dotazování alertů

### Získat všechny aktivní alerty

```typescript
const activeAlerts = AlertManager.getActiveAlerts();

for (const alert of activeAlerts) {
  console.log(`${alert.processName ?? alert.processId}: ${alert.message}`);
}
```

### Získat alert pro konkrétní proces

```typescript
const alert = AlertManager.getAlertForProcess('genserver_5_abc123');

if (alert) {
  console.log(`Proces má aktivní alert: ${alert.message}`);
} else {
  console.log('Proces je zdravý');
}
```

### Získat statistiky procesu

Zobrazit statistický model pro jakýkoli proces:

```typescript
const stats = AlertManager.getProcessStatistics('genserver_5_abc123');

if (stats) {
  console.log(`Nasbíráno vzorků: ${stats.sampleCount}`);
  console.log(`Průměrná velikost fronty: ${stats.mean.toFixed(2)}`);
  console.log(`Směrodatná odchylka: ${stats.stddev.toFixed(2)}`);
  console.log(`Aktuální práh: ${stats.threshold.toFixed(2)}`);
} else {
  console.log('Pro tento proces zatím nejsou statistiky');
}
```

### Získat aktuální práh

```typescript
const threshold = AlertManager.getThreshold('genserver_5_abc123');

if (threshold === Infinity) {
  console.log('Nedostatek vzorků pro výpočet prahu');
} else {
  console.log(`Alert se spustí pokud fronta překročí ${threshold.toFixed(1)}`);
}
```

## Manuální ovládání alertů

Pro testování nebo vlastní alertovací logiku můžete manuálně spouštět a řešit alerty:

### Spustit alert

```typescript
// Manuálně spustit alert (respektuje cooldown)
const alert = AlertManager.triggerAlert(
  'high_queue_size',  // typ alertu
  'genserver_5_abc',  // ID procesu
  150                 // aktuální hodnota
);

if (alert) {
  console.log(`Alert spuštěn: ${alert.id}`);
} else {
  console.log('Alert nebyl spuštěn (zakázáno nebo cooldown aktivní)');
}
```

### Vyřešit alert

```typescript
// Manuálně vyřešit alert
const wasResolved = AlertManager.resolveAlert('genserver_5_abc');

if (wasResolved) {
  console.log('Alert vyřešen');
} else {
  console.log('Žádný aktivní alert pro tento proces');
}
```

### Resetovat veškerý stav

```typescript
// Vymazat všechny statistiky, alerty a resetovat na výchozí hodnoty
AlertManager.reset();
```

## Mechanismus cooldown

AlertManager obsahuje cooldown pro prevenci spamu alertů. Po spuštění alertu pro proces se žádné nové alerty pro tento proces nespustí dokud nevyprší cooldown perioda:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CHOVÁNÍ COOLDOWN                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Čas: 0s        5s          10s         15s         20s                    │
│        │         │           │           │           │                      │
│        ▼         ▼           ▼           ▼           ▼                      │
│  ┌──────────┐                     ┌──────────────────────┐                  │
│  │  ALERT   │                     │     COOLDOWN         │                  │
│  │ SPUŠTĚN  │                     │  (10s výchozí)       │                  │
│  └────┬─────┘                     └──────────┬───────────┘                  │
│       │                                      │                              │
│       │  Hodnota překračuje práh             │  Hodnota překračuje práh     │
│       │  znovu v 5s                          │  znovu v 15s                 │
│       │         │                            │         │                    │
│       │         ▼                            │         ▼                    │
│       │  ┌──────────────┐                    │  ┌──────────────┐            │
│       │  │  IGNOROVÁNO  │                    │  │    ALERT     │            │
│       │  │ (v cooldown) │                    │  │   SPUŠTĚN    │            │
│       │  └──────────────┘                    │  └──────────────┘            │
│       │                                      │                              │
│       ▼                                      ▼                              │
│  Notifikace odeslána                    Notifikace odeslána                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Toto zabraňuje přijímání stovek alertů když má proces trvale problémy.

## Kruhový buffer pro vzorky

AlertManager udržuje kruhový buffer až 1000 vzorků na proces. To poskytuje:

- **Ohraničené využití paměti**: Fixní maximum bez ohledu na dobu běhu
- **Adaptivní prahy**: Nedávné chování má větší vliv
- **Postupné přizpůsobení**: Prahy se mění plynule jak se vzorce mění

```typescript
// Prvních 1000 vzorků: průměr počítán ze všech
// Po 1000: nejstarší vzorky nahrazeny, statistiky přepočítány

// Příklad: Vzorec procesu se mění z nízkého na vysoký provoz
for (let i = 0; i < 1000; i++) {
  AlertManager.recordQueueSize('process-1', 10);  // Nízký provoz
}
// Průměr ≈ 10, práh ≈ 10

for (let i = 0; i < 500; i++) {
  AlertManager.recordQueueSize('process-1', 100); // Vysoký provoz
}
// Nyní 500 vzorků 10 + 500 vzorků 100
// Průměr ≈ 55, práh se adaptuje na nový vzorec
```

## Praktický příklad: Služba notifikace alertů

Zde je kompletní služba notifikace alertů která odesílá alerty do více kanálů:

```typescript
import {
  GenServer,
  AlertManager,
  Observer,
  type GenServerBehavior,
  type GenServerRef,
  type Alert,
  type AlertEvent,
} from '@hamicek/noex';

// Kanály notifikace alertů
interface NotificationChannel {
  name: string;
  send(alert: Alert): Promise<void>;
}

// Implementace Slack kanálu
const slackChannel: NotificationChannel = {
  name: 'slack',
  async send(alert) {
    const emoji = alert.type === 'high_queue_size' ? ':warning:' : ':fire:';
    console.log(`[Slack] ${emoji} ${alert.message}`);
    // V produkci: await fetch(slackWebhookUrl, { method: 'POST', body: JSON.stringify({...}) })
  },
};

// Implementace PagerDuty kanálu
const pagerDutyChannel: NotificationChannel = {
  name: 'pagerduty',
  async send(alert) {
    console.log(`[PagerDuty] Incident: ${alert.id} - ${alert.message}`);
    // V produkci: await pagerdutyClient.createIncident({...})
  },
};

// Záznam historie alertu
interface AlertHistoryEntry {
  alert: Alert;
  notifiedAt: number;
  channels: string[];
  resolved: boolean;
  resolvedAt?: number;
}

// Stav služby
interface AlertServiceState {
  history: AlertHistoryEntry[];
  channels: NotificationChannel[];
  severityThresholds: { warning: number; critical: number };
}

type AlertServiceCall =
  | { type: 'getHistory'; limit?: number }
  | { type: 'getActiveCount' }
  | { type: 'getStats' };

type AlertServiceCast =
  | { type: 'handleAlert'; event: AlertEvent };

type AlertServiceReply =
  | { history: AlertHistoryEntry[] }
  | { activeCount: number }
  | { stats: { total: number; active: number; avgResolutionMs: number } };

const AlertServiceBehavior: GenServerBehavior<
  AlertServiceState,
  AlertServiceCall,
  AlertServiceCast,
  AlertServiceReply
> = {
  init: () => ({
    history: [],
    channels: [slackChannel, pagerDutyChannel],
    severityThresholds: {
      warning: 1.5,   // 1.5x práh = varování
      critical: 2.0,  // 2x práh = kritické
    },
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'getHistory': {
        const limit = msg.limit ?? 100;
        const history = state.history.slice(-limit);
        return [{ history }, state];
      }

      case 'getActiveCount': {
        const activeCount = state.history.filter(h => !h.resolved).length;
        return [{ activeCount }, state];
      }

      case 'getStats': {
        const resolved = state.history.filter(h => h.resolved && h.resolvedAt);
        const avgResolutionMs = resolved.length > 0
          ? resolved.reduce((sum, h) => sum + (h.resolvedAt! - h.notifiedAt), 0) / resolved.length
          : 0;

        return [{
          stats: {
            total: state.history.length,
            active: state.history.filter(h => !h.resolved).length,
            avgResolutionMs,
          },
        }, state];
      }
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'handleAlert') {
      const { event } = msg;

      if (event.type === 'alert_triggered') {
        const { alert } = event;

        // Určit závažnost
        const ratio = alert.currentValue / alert.threshold;
        const severity = ratio >= state.severityThresholds.critical
          ? 'CRITICAL'
          : ratio >= state.severityThresholds.warning
            ? 'WARNING'
            : 'INFO';

        // Vybrat kanály podle závažnosti
        const channelsToNotify = severity === 'CRITICAL'
          ? state.channels
          : state.channels.filter(c => c.name === 'slack');

        // Odeslat notifikace (fire and forget)
        for (const channel of channelsToNotify) {
          channel.send(alert).catch(err => {
            console.error(`Nepodařilo se odeslat do ${channel.name}:`, err);
          });
        }

        // Zaznamenat do historie
        const entry: AlertHistoryEntry = {
          alert,
          notifiedAt: Date.now(),
          channels: channelsToNotify.map(c => c.name),
          resolved: false,
        };

        return {
          ...state,
          history: [...state.history.slice(-999), entry], // Ponechat posledních 1000
        };
      }

      if (event.type === 'alert_resolved') {
        // Najít a označit jako vyřešený
        const history = state.history.map(entry =>
          entry.alert.id === event.alertId
            ? { ...entry, resolved: true, resolvedAt: Date.now() }
            : entry
        );

        return { ...state, history };
      }
    }

    return state;
  },
};

// Spustit službu alertů
async function startAlertService(): Promise<{
  service: GenServerRef;
  stopPolling: () => void;
  cleanup: () => void;
}> {
  // Nakonfigurovat AlertManager
  AlertManager.configure({
    sensitivityMultiplier: 2.0,
    minSamples: 20,
    cooldownMs: 60000,  // 1 minuta cooldown
  });

  // Spustit službu
  const service = await GenServer.start(AlertServiceBehavior, {
    name: 'alert_service',
  });

  // Přihlásit se k alertům a předávat službě
  const unsubscribe = AlertManager.subscribe((event) => {
    GenServer.cast(service, { type: 'handleAlert', event });
  });

  // Spustit Observer pollování (spouští kontroly AlertManageru)
  const stopPolling = Observer.startPolling(1000, () => {});

  return {
    service,
    stopPolling,
    cleanup: () => {
      unsubscribe();
      stopPolling();
    },
  };
}

// Použití
async function main() {
  const { service, cleanup } = await startAlertService();

  // Dotaz na statistiky alertů
  const statsResult = await GenServer.call(service, { type: 'getStats' });
  if ('stats' in statsResult) {
    console.log(`Celkem alertů: ${statsResult.stats.total}`);
    console.log(`Aktivních alertů: ${statsResult.stats.active}`);
    console.log(`Průměrné vyřešení: ${Math.round(statsResult.stats.avgResolutionMs / 1000)}s`);
  }

  // Získat nedávnou historii
  const historyResult = await GenServer.call(service, { type: 'getHistory', limit: 10 });
  if ('history' in historyResult) {
    for (const entry of historyResult.history) {
      const status = entry.resolved ? 'VYŘEŠENO' : 'AKTIVNÍ';
      console.log(`[${status}] ${entry.alert.message}`);
    }
  }

  // Úklid při ukončení
  cleanup();
  await GenServer.stop(service);
}
```

## Cvičení: Vlastní pravidla alertů

Vytvořte systém alertů který podporuje vlastní pravidla nad rámec velikosti fronty.

**Požadavky:**

1. Definovat vlastní pravidla alertů s podmínkami a prahy
2. Vyhodnocovat pravidla proti statistikám procesů
3. Podporovat více typů pravidel (queue_size, message_rate, memory)
4. Povolit přepsání pravidel per-proces
5. Sledovat porušení pravidel v čase

**Startovací kód:**

```typescript
import {
  GenServer,
  Observer,
  AlertManager,
  type GenServerBehavior,
  type GenServerStats,
} from '@hamicek/noex';

// Definice pravidla alertu
interface AlertRule {
  id: string;
  name: string;
  metric: 'queue_size' | 'message_rate' | 'memory';
  condition: 'greater_than' | 'less_than';
  threshold: number;
  processPattern?: RegExp;  // Pokud nastaveno, platí pouze pro odpovídající procesy
}

interface RuleViolation {
  rule: AlertRule;
  processId: string;
  value: number;
  timestamp: number;
}

interface RuleEngineState {
  rules: AlertRule[];
  violations: Map<string, RuleViolation>;  // klíč: rule.id + processId
  messageRates: Map<string, number>;       // Sledovat rychlosti zpráv
  lastMessageCounts: Map<string, number>;  // Předchozí počty zpráv
  lastCheckTime: number;
}

// TODO: Implementovat chování rule engine
const RuleEngineBehavior: GenServerBehavior<
  RuleEngineState,
  // ... definovat call/cast/reply typy
> = {
  // ...
};

// TODO: Implementovat vyhodnocení pravidel
function evaluateRules(
  rules: AlertRule[],
  servers: readonly GenServerStats[],
  messageRates: Map<string, number>
): RuleViolation[] {
  // ...
}

// TODO: Spustit rule engine s integrací Observeru
async function startRuleEngine() {
  // ...
}
```

<details>
<summary><strong>Řešení</strong></summary>

```typescript
import {
  GenServer,
  Observer,
  AlertManager,
  type GenServerBehavior,
  type GenServerRef,
  type GenServerStats,
} from '@hamicek/noex';

// Definice pravidla alertu
interface AlertRule {
  id: string;
  name: string;
  metric: 'queue_size' | 'message_rate' | 'memory';
  condition: 'greater_than' | 'less_than';
  threshold: number;
  processPattern?: RegExp;
  enabled: boolean;
}

interface RuleViolation {
  rule: AlertRule;
  processId: string;
  processName?: string;
  value: number;
  timestamp: number;
}

interface RuleEngineState {
  rules: AlertRule[];
  violations: Map<string, RuleViolation>;
  messageRates: Map<string, number>;
  lastMessageCounts: Map<string, number>;
  lastCheckTime: number;
}

type RuleEngineCall =
  | { type: 'addRule'; rule: Omit<AlertRule, 'enabled'> }
  | { type: 'removeRule'; ruleId: string }
  | { type: 'enableRule'; ruleId: string; enabled: boolean }
  | { type: 'getRules' }
  | { type: 'getViolations' }
  | { type: 'getViolationsForProcess'; processId: string };

type RuleEngineCast =
  | { type: 'evaluate'; servers: readonly GenServerStats[] };

type RuleEngineReply =
  | { success: boolean; ruleId?: string }
  | { rules: AlertRule[] }
  | { violations: RuleViolation[] };

function evaluateRules(
  rules: AlertRule[],
  servers: readonly GenServerStats[],
  messageRates: Map<string, number>,
): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const now = Date.now();

  for (const server of servers) {
    for (const rule of rules) {
      if (!rule.enabled) continue;

      // Zkontrolovat zda pravidlo platí pro tento proces
      if (rule.processPattern && !rule.processPattern.test(server.id)) {
        continue;
      }

      // Získat hodnotu metriky
      let value: number | undefined;

      switch (rule.metric) {
        case 'queue_size':
          value = server.queueSize;
          break;

        case 'message_rate':
          value = messageRates.get(server.id);
          break;

        case 'memory':
          value = server.stateMemoryBytes;
          break;
      }

      if (value === undefined) continue;

      // Vyhodnotit podmínku
      let violated = false;

      switch (rule.condition) {
        case 'greater_than':
          violated = value > rule.threshold;
          break;

        case 'less_than':
          violated = value < rule.threshold;
          break;
      }

      if (violated) {
        violations.push({
          rule,
          processId: server.id,
          value,
          timestamp: now,
        });
      }
    }
  }

  return violations;
}

const RuleEngineBehavior: GenServerBehavior<
  RuleEngineState,
  RuleEngineCall,
  RuleEngineCast,
  RuleEngineReply
> = {
  init: () => ({
    rules: [
      // Výchozí pravidla
      {
        id: 'high_queue',
        name: 'Vysoká velikost fronty',
        metric: 'queue_size',
        condition: 'greater_than',
        threshold: 100,
        enabled: true,
      },
      {
        id: 'low_throughput',
        name: 'Nízká propustnost',
        metric: 'message_rate',
        condition: 'less_than',
        threshold: 1,
        processPattern: /worker/,
        enabled: true,
      },
    ],
    violations: new Map(),
    messageRates: new Map(),
    lastMessageCounts: new Map(),
    lastCheckTime: Date.now(),
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'addRule': {
        const newRule: AlertRule = { ...msg.rule, enabled: true };
        const rules = [...state.rules, newRule];
        return [{ success: true, ruleId: newRule.id }, { ...state, rules }];
      }

      case 'removeRule': {
        const rules = state.rules.filter(r => r.id !== msg.ruleId);
        const removed = rules.length < state.rules.length;
        return [{ success: removed }, { ...state, rules }];
      }

      case 'enableRule': {
        const rules = state.rules.map(r =>
          r.id === msg.ruleId ? { ...r, enabled: msg.enabled } : r
        );
        return [{ success: true }, { ...state, rules }];
      }

      case 'getRules':
        return [{ rules: state.rules }, state];

      case 'getViolations':
        return [{ violations: Array.from(state.violations.values()) }, state];

      case 'getViolationsForProcess': {
        const violations = Array.from(state.violations.values())
          .filter(v => v.processId === msg.processId);
        return [{ violations }, state];
      }
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'evaluate') {
      const { servers } = msg;
      const now = Date.now();
      const elapsed = (now - state.lastCheckTime) / 1000;

      // Vypočítat rychlosti zpráv
      const messageRates = new Map<string, number>();
      for (const server of servers) {
        const lastCount = state.lastMessageCounts.get(server.id) ?? server.messageCount;
        const rate = elapsed > 0
          ? (server.messageCount - lastCount) / elapsed
          : 0;
        messageRates.set(server.id, rate);
      }

      // Aktualizovat poslední počty zpráv
      const lastMessageCounts = new Map<string, number>();
      for (const server of servers) {
        lastMessageCounts.set(server.id, server.messageCount);
      }

      // Vyhodnotit pravidla
      const newViolations = evaluateRules(state.rules, servers, messageRates);

      // Aktualizovat mapu porušení
      const violations = new Map<string, RuleViolation>();

      // Přidat nová porušení
      for (const violation of newViolations) {
        const key = `${violation.rule.id}:${violation.processId}`;
        violations.set(key, violation);
      }

      // Logovat nová porušení
      for (const violation of newViolations) {
        const key = `${violation.rule.id}:${violation.processId}`;
        if (!state.violations.has(key)) {
          console.log(
            `[PORUŠENÍ PRAVIDLA] ${violation.rule.name}: ` +
            `${violation.processId} (${violation.value} ${violation.rule.condition} ${violation.rule.threshold})`
          );
        }
      }

      // Logovat vyřešená porušení
      for (const [key, oldViolation] of state.violations) {
        if (!violations.has(key)) {
          console.log(
            `[PRAVIDLO VYŘEŠENO] ${oldViolation.rule.name}: ${oldViolation.processId}`
          );
        }
      }

      return {
        ...state,
        violations,
        messageRates,
        lastMessageCounts,
        lastCheckTime: now,
      };
    }

    return state;
  },
};

async function startRuleEngine(): Promise<{
  engine: GenServerRef;
  stopPolling: () => void;
}> {
  const engine = await GenServer.start(RuleEngineBehavior, {
    name: 'rule_engine',
  });

  // Spustit pollování a vyhodnocovat pravidla při každé aktualizaci
  const stopPolling = Observer.startPolling(2000, (event) => {
    if (event.type === 'stats_update') {
      GenServer.cast(engine, { type: 'evaluate', servers: event.servers });
    }
  });

  return { engine, stopPolling };
}

// Demo použití
async function demo() {
  const { engine, stopPolling } = await startRuleEngine();

  // Přidat vlastní pravidlo
  await GenServer.call(engine, {
    type: 'addRule',
    rule: {
      id: 'high_memory',
      name: 'Vysoké využití paměti',
      metric: 'memory',
      condition: 'greater_than',
      threshold: 10 * 1024 * 1024, // 10MB
    },
  });

  // Získat všechna pravidla
  const rulesResult = await GenServer.call(engine, { type: 'getRules' });
  if ('rules' in rulesResult) {
    console.log('Aktivní pravidla:');
    for (const rule of rulesResult.rules) {
      const status = rule.enabled ? 'POVOLENO' : 'ZAKÁZÁNO';
      console.log(`  [${status}] ${rule.name}: ${rule.metric} ${rule.condition} ${rule.threshold}`);
    }
  }

  // Získat aktuální porušení
  const violationsResult = await GenServer.call(engine, { type: 'getViolations' });
  if ('violations' in violationsResult) {
    console.log(`Aktuální porušení: ${violationsResult.violations.length}`);
    for (const v of violationsResult.violations) {
      console.log(`  ${v.rule.name} na ${v.processId}: ${v.value}`);
    }
  }

  // Úklid
  stopPolling();
  await GenServer.stop(engine);
}
```

**Klíčové vlastnosti řešení:**

1. **Více metrik**: Podporuje queue_size, message_rate a memory
2. **Flexibilní podmínky**: Porovnání greater_than a less_than
3. **Filtrování procesů**: Volitelný regex pattern pro cílení konkrétních procesů
4. **Výpočet rychlosti zpráv**: Sleduje zprávy v čase pro výpočet propustnosti
5. **Sledování porušení**: Zaznamenává která pravidla jsou aktuálně porušena
6. **Dynamická správa pravidel**: Přidávání, odebírání a povolování/zakazování pravidel za běhu

</details>

## Shrnutí

**Klíčové poznatky:**

- **AlertManager používá statistickou analýzu** (průměr + násobitel × odchylka) pro výpočet dynamických prahů
- **Prahy se adaptují** na normální vzorec chování každého procesu
- **Konfigurační možnosti** řídí citlivost, období rozjezdu a cooldown
- **Mechanismus cooldown** zabraňuje spamu alertů během trvalých problémů
- **Integrace s Observerem** poskytuje automatické alertování během pollování
- **Manuální ovládání** (triggerAlert/resolveAlert) umožňuje testování a vlastní logiku

**Přehled AlertManager API:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       PŘEHLED ALERTMANAGER API                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  KONFIGURACE                                                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│  configure(config)          → Aktualizovat konfiguraci alertování           │
│  getConfig()                → Získat aktuální konfiguraci                   │
│                                                                             │
│  ODBĚRY                                                                     │
│  ─────────────────────────────────────────────────────────────────────────  │
│  subscribe(handler)         → Přijímat události alertů                      │
│                             → Vrací funkci pro odhlášení                    │
│                                                                             │
│  DOTAZY                                                                     │
│  ─────────────────────────────────────────────────────────────────────────  │
│  getActiveAlerts()          → Všechny aktuálně aktivní alerty               │
│  getAlertForProcess(id)     → Alert pro konkrétní proces                    │
│  getThreshold(id)           → Aktuální práh pro proces                      │
│  getProcessStatistics(id)   → Statistický model pro proces                  │
│                                                                             │
│  MANUÁLNÍ OVLÁDÁNÍ                                                          │
│  ─────────────────────────────────────────────────────────────────────────  │
│  triggerAlert(type, id, v)  → Manuálně spustit alert                        │
│  resolveAlert(id)           → Manuálně vyřešit alert                        │
│  reset()                    → Vymazat veškerý stav                          │
│                                                                             │
│  INTEGRACE S OBSERVEREM                                                     │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Observer.subscribeToAlerts → Stejné jako AlertManager.subscribe            │
│  Observer.getActiveAlerts   → Stejné jako AlertManager.getActiveAlerts      │
│  Observer.startPolling      → Automaticky spouští checkAlerts               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Kdy použít AlertManager:**

| Scénář | Přístup |
|--------|---------|
| Automatická detekce anomálií | Použít Observer.startPolling() s AlertManagerem |
| Vlastní prahy alertů | Přidat vlastní pravidla nad AlertManager |
| Testování zpracování alertů | Použít triggerAlert() a resolveAlert() |
| Multi-kanálové notifikace | Přihlásit se a dispatchovat do Slack/PagerDuty/atd. |
| Historie/analytika alertů | Vytvořit GenServer zaznamenávající události alertů |

**Pamatujte:**

> AlertManager se učí co je normální pro každý proces, takže nemusíte manuálně konfigurovat prahy. Nechte statistický model dělat práci zatímco se soustředíte na vytváření skvělých aplikací.

---

Další: [Debugging](./04-debugging.md)
