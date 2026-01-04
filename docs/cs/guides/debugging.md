# Ladění noex aplikací

Tato příručka popisuje, jak ladit noex aplikace pomocí modulu Observer, Dashboard TUI a dalších technik pro řešení problémů s procesy.

## Přehled

noex poskytuje několik nástrojů pro ladění:

| Nástroj | Účel | Použití |
|---------|------|---------|
| **Observer** | Programatická introspekce | Skripty, automatizovaný monitoring |
| **Dashboard** | Interaktivní TUI | Živé ladění, vizuální inspekce |
| **DashboardServer** | Vzdálený webový dashboard | Ladění v produkci |
| **Lifecycle Events** | Stream událostí | Sledování změn procesů |
| **AlertManager** | Detekce anomálií | Automatická identifikace problémů |

---

## Použití Observer

Observer poskytuje programatický přístup ke stavu systému.

### Získání snímku systému

```typescript
import { Observer } from 'noex';

// Získání kompletního stavu systému
const snapshot = Observer.getSnapshot();

console.log('=== Snímek systému ===');
console.log(`Časové razítko: ${new Date(snapshot.timestamp).toISOString()}`);
console.log(`Procesů: ${snapshot.processCount}`);
console.log(`Celkem zpráv: ${snapshot.totalMessages}`);
console.log(`Celkem restartů: ${snapshot.totalRestarts}`);
console.log(`Použitá halda: ${(snapshot.memoryStats.heapUsed / 1024 / 1024).toFixed(2)} MB`);
```

### Inspekce statistik procesů

```typescript
// Získání statistik všech GenServerů
const servers = Observer.getServerStats();

console.log('\n=== GenServery ===');
for (const server of servers) {
  console.log(`${server.name || server.id}:`);
  console.log(`  Status: ${server.status}`);
  console.log(`  Zpráv: ${server.messageCount}`);
  console.log(`  Spuštěno: ${new Date(server.startedAt).toISOString()}`);
  if (server.lastMessageAt) {
    console.log(`  Poslední zpráva: ${new Date(server.lastMessageAt).toISOString()}`);
  }
}

// Získání statistik všech Supervisorů
const supervisors = Observer.getSupervisorStats();

console.log('\n=== Supervisory ===');
for (const sup of supervisors) {
  console.log(`${sup.name || sup.id}:`);
  console.log(`  Strategie: ${sup.strategy}`);
  console.log(`  Potomků: ${sup.childCount}`);
  console.log(`  Celkem restartů: ${sup.totalRestarts}`);
}
```

### Zobrazení stromu procesů

```typescript
// Získání hierarchického pohledu
const tree = Observer.getProcessTree();

function printTree(nodes: readonly ProcessTreeNode[], indent = 0) {
  for (const node of nodes) {
    const prefix = '  '.repeat(indent);
    const icon = node.type === 'supervisor' ? '[S]' : '[G]';
    const name = node.name || node.id;
    console.log(`${prefix}${icon} ${name}`);

    if (node.type === 'supervisor') {
      const stats = node.stats as SupervisorStats;
      console.log(`${prefix}    Strategie: ${stats.strategy}, Restarty: ${stats.totalRestarts}`);
    } else {
      const stats = node.stats as GenServerStats;
      console.log(`${prefix}    Zpráv: ${stats.messageCount}`);
    }

    printTree(node.children, indent + 1);
  }
}

console.log('\n=== Strom procesů ===');
printTree(tree);
```

### Monitoring událostí v reálném čase

```typescript
// Přihlášení k odběru lifecycle událostí
const unsubscribe = Observer.subscribe((event) => {
  const timestamp = new Date().toISOString();

  switch (event.type) {
    case 'server_started':
      console.log(`[${timestamp}] Server spuštěn: ${event.stats.name || event.stats.id}`);
      break;

    case 'server_stopped':
      console.log(`[${timestamp}] Server zastaven: ${event.id} (důvod: ${event.reason})`);
      break;

    case 'supervisor_started':
      console.log(`[${timestamp}] Supervisor spuštěn: ${event.stats.name || event.stats.id}`);
      break;

    case 'supervisor_stopped':
      console.log(`[${timestamp}] Supervisor zastaven: ${event.id}`);
      break;

    case 'stats_update':
      console.log(`[${timestamp}] Aktualizace statistik: ${event.servers.length} serverů, ${event.supervisors.length} supervisorů`);
      break;
  }
});

// Později: zastavení monitoringu
unsubscribe();
```

---

## Použití Dashboard TUI

Dashboard poskytuje interaktivní terminálové rozhraní pro ladění.

### Spuštění Dashboardu

```typescript
import { Dashboard } from 'noex/dashboard';

const dashboard = new Dashboard({
  refreshInterval: 500,  // Aktualizace každých 500ms
  theme: 'dark',
  layout: 'full',
});

dashboard.start();
```

### Rozložení Dashboardu

**Full Layout** - Všechny widgety viditelné:
- Strom procesů (vlevo)
- Tabulka statistik (vpravo)
- Ukazatel paměti (vlevo dole)
- Log událostí (vpravo dole)

**Compact Layout** - Pro menší terminály:
- Pouze strom procesů + statistiky

**Minimal Layout** - Jen to nejnutnější:
- Pouze tabulka statistik

Přepínání rozložení klávesovými zkratkami `1`, `2`, `3` nebo programaticky:

```typescript
dashboard.switchLayout('compact');
```

### Klávesová navigace

| Klávesa | Akce |
|---------|------|
| `q` / `Escape` / `Ctrl+C` | Ukončit |
| `r` | Obnovit data |
| `?` / `h` | Zobrazit nápovědu |
| `Tab` | Fokus na další widget |
| `Enter` | Zobrazit detail procesu |
| `1` / `2` / `3` | Přepnout rozložení |
| Šipky | Navigace |

### Vzdálený Dashboard s DashboardServer

Pro ladění v produkci použijte DashboardServer k zpřístupnění webového rozhraní:

```typescript
import { DashboardServer } from 'noex/dashboard';

const server = new DashboardServer({
  port: 8080,
  refreshInterval: 1000,
});

await server.start();
console.log('Dashboard dostupný na http://localhost:8080');
```

Přistupte z libovolného prohlížeče pro zobrazení informací o procesech v reálném čase.

---

## Běžné scénáře ladění

### Scénář 1: Proces neodpovídá

**Příznaky:** Volání GenServeru vyprší časový limit.

**Diagnóza:**

```typescript
import { Observer, GenServer } from 'noex';

// Kontrola, zda server běží
const servers = Observer.getServerStats();
const target = servers.find((s) => s.name === 'my-service');

if (!target) {
  console.log('Server nenalezen - možná spadl');
} else {
  console.log(`Status: ${target.status}`);
  console.log(`Velikost fronty: ${target.queueSize}`);  // Vysoká = nahromaděné zprávy
  console.log(`Poslední zpráva: ${target.lastMessageAt}`);

  if (target.queueSize > 100) {
    console.log('Velká fronta zpráv - server může být zaseknutý');
  }
}
```

**Řešení:**
- Zkontrolujte blokující operace v handlerech
- Hledejte nekonečné smyčky
- Zvyšte timeout pro pomalé operace
- Zvažte rozdělení práce mezi více serverů

### Scénář 2: Časté restarty

**Příznaky:** Supervisor ukazuje vysoký počet restartů.

**Diagnóza:**

```typescript
// Kontrola statistik supervisoru
const supervisors = Observer.getSupervisorStats();
for (const sup of supervisors) {
  if (sup.totalRestarts > 10) {
    console.log(`Vysoký počet restartů: ${sup.name || sup.id} (${sup.totalRestarts})`);
  }
}

// Monitoring restartů v reálném čase
Observer.subscribe((event) => {
  if (event.type === 'server_started') {
    console.log(`Detekován restart: ${event.stats.name}`);
    console.log(`Statistiky:`, event.stats);
  }
});
```

**Řešení:**
- Zkontrolujte init() na chyby
- Prozkoumejte handleCall/handleCast na výjimky
- Zvyšte limity intenzity restartů, pokud je to vhodné
- Přidejte logování do terminate() pro zjištění důvodů pádu

### Scénář 3: Růst paměti

**Příznaky:** Paměť aplikace neustále roste.

**Diagnóza:**

```typescript
// Sledování paměti v čase
setInterval(() => {
  const memory = Observer.getMemoryStats();
  const heapMB = memory.heapUsed / 1024 / 1024;
  console.log(`Halda: ${heapMB.toFixed(2)} MB`);
}, 5000);

// Kontrola velkého stavu v serverech
const servers = Observer.getServerStats();
for (const server of servers) {
  if (server.messageCount > 10000) {
    console.log(`Vysoký počet zpráv: ${server.name} (${server.messageCount})`);
  }
}
```

**Řešení:**
- Zkontrolujte neomezené kolekce ve stavu
- Implementujte TTL/evikci pro cache
- Zkontrolujte úklid subscriptions
- Použijte weak reference tam, kde je to vhodné

### Scénář 4: Deadlocky

**Příznaky:** Více procesů čeká na sebe navzájem.

**Diagnóza:**

```typescript
// Hledání procesů s frontou zpráv, ale bez nedávné aktivity
const servers = Observer.getServerStats();
const now = Date.now();

for (const server of servers) {
  const lastActivity = server.lastMessageAt || server.startedAt;
  const idleMs = now - lastActivity;

  if (server.queueSize > 0 && idleMs > 10000) {
    console.log(`Potenciální deadlock: ${server.name}`);
    console.log(`  Velikost fronty: ${server.queueSize}`);
    console.log(`  Nečinný: ${idleMs}ms`);
  }
}
```

**Řešení:**
- Vyhněte se kruhovým závislostem mezi službami
- Používejte timeouty na všech voláních
- Zvažte použití cast místo call pro nekritické operace
- Přerušte cykly pomocí EventBus pub/sub vzoru

---

## Debug logování

### Přidání debug výstupu do služeb

```typescript
const debugBehavior: GenServerBehavior<State, Call, Cast, Reply> = {
  init: () => {
    console.log('[DEBUG] Služba se inicializuje');
    return initialState;
  },

  handleCall: (msg, state) => {
    console.log('[DEBUG] handleCall:', JSON.stringify(msg));
    const result = processCall(msg, state);
    console.log('[DEBUG] handleCall výsledek:', JSON.stringify(result[0]));
    return result;
  },

  handleCast: (msg, state) => {
    console.log('[DEBUG] handleCast:', JSON.stringify(msg));
    return processCast(msg, state);
  },

  terminate: (reason, state) => {
    console.log('[DEBUG] terminate:', reason);
  },
};
```

### Podmíněný debug režim

```typescript
const DEBUG = process.env.DEBUG === 'true';

function debug(...args: unknown[]) {
  if (DEBUG) {
    console.log('[DEBUG]', ...args);
  }
}

const serviceBehavior = {
  handleCall: (msg, state) => {
    debug('handleCall', msg);
    // ...
  },
};
```

---

## Export debug dat

### Export do JSON

```typescript
import { Observer, exportToJson } from 'noex/observer';

// Získání dat připravených k exportu
const data = Observer.prepareExportData();
const json = exportToJson(data);

// Uložení do souboru
import { writeFileSync } from 'fs';
writeFileSync('debug-snapshot.json', json);
console.log('Snímek uložen do debug-snapshot.json');
```

### Export do CSV

```typescript
import { Observer, exportToCsv } from 'noex/observer';

const data = Observer.prepareExportData();
const csvFiles = exportToCsv(data);

// csvFiles obsahuje oddělené CSV řetězce pro servery a supervisory
writeFileSync('servers.csv', csvFiles.servers);
writeFileSync('supervisors.csv', csvFiles.supervisors);
```

---

## AlertManager pro ladění

Použijte AlertManager k automatické detekci anomálií:

```typescript
import { AlertManager, Observer } from 'noex/observer';

// Konfigurace pro citlivou detekci během ladění
AlertManager.configure({
  enabled: true,
  sensitivityMultiplier: 1.5,  // Citlivější
  minSamples: 10,              // Rychlejší baseline
  cooldownMs: 5000,            // Častější alertys
});

// Logování všech alertů
AlertManager.subscribe((event) => {
  if (event.type === 'alert_triggered') {
    console.log('\n=== ALERT ===');
    console.log(`Typ: ${event.alert.type}`);
    console.log(`Proces: ${event.alert.processName || event.alert.processId}`);
    console.log(`Zpráva: ${event.alert.message}`);
    console.log(`Hodnota: ${event.alert.currentValue}`);
    console.log(`Práh: ${event.alert.threshold}`);

    // Získání více detailů
    const stats = AlertManager.getProcessStatistics(event.alert.processId);
    if (stats) {
      console.log(`Průměr: ${stats.mean.toFixed(2)}`);
      console.log(`StdDev: ${stats.stddev.toFixed(2)}`);
      console.log(`Vzorků: ${stats.sampleCount}`);
    }
  }
});

// Spuštění pollingu pro triggernování kontrol alertů
Observer.startPolling(1000, () => {});
```

---

## Tipy pro ladění

### 1. Začněte stromem procesů

```typescript
const tree = Observer.getProcessTree();
// Vizualizujte hierarchii pro pochopení vztahů
```

### 2. Zkontrolujte historii restartů

```typescript
const sups = Observer.getSupervisorStats();
// Vysoký počet restartů = nestabilní potomci
```

### 3. Monitorujte trendy paměti

```typescript
// Vzorkujte každých 10 sekund, hledejte růst
```

### 4. Používejte timeouty na voláních

```typescript
// Krátké timeouty pomáhají identifikovat pomalé handlery
await GenServer.call(ref, msg, { timeout: 1000 });
```

### 5. Přidejte unikátní ID požadavků

```typescript
handleCall: (msg, state) => {
  const requestId = generateId();
  console.log(`[${requestId}] Start`, msg.type);
  // ... zpracování ...
  console.log(`[${requestId}] Konec`);
};
```

### 6. Testujte s Dashboardem během vývoje

```typescript
// Přidejte dashboard do vašeho dev skriptu
if (process.env.NODE_ENV === 'development') {
  const dashboard = new Dashboard();
  dashboard.start();
}
```

---

## Šablona debug skriptu

```typescript
// debug.ts - Spusťte pomocí: npx tsx debug.ts
import { Observer, GenServer, Supervisor, AlertManager } from 'noex';

async function debug() {
  console.log('=== noex Debug Report ===\n');

  // Přehled systému
  const snapshot = Observer.getSnapshot();
  console.log('Přehled systému:');
  console.log(`  Procesů: ${snapshot.processCount}`);
  console.log(`  Zpráv: ${snapshot.totalMessages}`);
  console.log(`  Restartů: ${snapshot.totalRestarts}`);
  console.log(`  Paměť: ${(snapshot.memoryStats.heapUsed / 1024 / 1024).toFixed(2)} MB`);

  // Detaily procesů
  console.log('\nGenServery:');
  for (const server of snapshot.servers) {
    console.log(`  ${server.name || server.id}: ${server.messageCount} zpráv, status=${server.status}`);
  }

  console.log('\nSupervisory:');
  for (const sup of snapshot.supervisors) {
    console.log(`  ${sup.name || sup.id}: ${sup.childCount} potomků, ${sup.totalRestarts} restartů, strategie=${sup.strategy}`);
  }

  // Aktivní alerty
  const alerts = Observer.getActiveAlerts();
  if (alerts.length > 0) {
    console.log('\nAktivní alerty:');
    for (const alert of alerts) {
      console.log(`  [${alert.type}] ${alert.message}`);
    }
  } else {
    console.log('\nŽádné aktivní alerty');
  }

  // Strom procesů
  console.log('\nStrom procesů:');
  function printTree(nodes, indent = 0) {
    for (const node of nodes) {
      const prefix = '  '.repeat(indent + 1);
      console.log(`${prefix}${node.type === 'supervisor' ? '[S]' : '[G]'} ${node.name || node.id}`);
      printTree(node.children, indent + 1);
    }
  }
  printTree(snapshot.tree);
}

debug().catch(console.error);
```

---

## Související

- [Příručka pro produkci](./production.md) - Nasazení do produkce
- [Observer API](../api/observer.md) - Reference Observer
- [Dashboard API](../api/dashboard.md) - Reference Dashboard
- [AlertManager API](../api/alert-manager.md) - Reference AlertManager
- [Příručka testování](./testing.md) - Testování noex aplikací
