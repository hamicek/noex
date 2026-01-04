# Tutoriál: Vytvoření Monitoring Dashboardu

V tomto tutoriálu přidáte real-time monitoring do noex aplikace. Naučíte se:
- Používat Observer pro systémovou introspekci
- Zobrazovat statistiky procesů v reálném čase
- Nastavit alerty pro kritické stavy
- Vytvořit TUI dashboard s blessed
- Vytvořit web-based monitoring endpoint

## Předpoklady

- Node.js 18+
- Běžící noex aplikace (použijeme jednoduchý příklad)
- Základní znalost TypeScriptu

## Nastavení projektu

Vytvořte nový projekt:

```bash
mkdir monitoring-dashboard
cd monitoring-dashboard
npm init -y
npm install noex blessed blessed-contrib
npm install -D typescript tsx @types/node
```

Vytvořte `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

## Přehled architektury

```
                    [Aplikace]
                         |
                    [Observer]
                    /    |    \
              [Stats] [Tree] [Events]
                         |
              +----------+----------+
              |          |          |
          [TUI]    [Web API]   [Alerty]
```

Observer poskytuje real-time data o:
- Běžících GenServerech a jejich počtech zpráv
- Supervisorech a statistikách restartů
- Hierarchii stromu procesů
- Využití paměti
- Lifecycle událostech

---

## Krok 1: Ukázková aplikace

Nejprve vytvořte ukázkovou aplikaci k monitorování. Vytvořte `src/app.ts`:

```typescript
import {
  GenServer,
  Supervisor,
  type GenServerBehavior,
  type GenServerRef,
  type SupervisorRef,
} from 'noex';

// Counter GenServer
interface CounterState {
  count: number;
}

type CounterCall = { type: 'get' } | { type: 'increment' };
type CounterCast = { type: 'reset' };
type CounterReply = number;

const counterBehavior: GenServerBehavior<CounterState, CounterCall, CounterCast, CounterReply> = {
  init: () => ({ count: 0 }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'get':
        return [state.count, state];
      case 'increment':
        return [state.count + 1, { count: state.count + 1 }];
    }
  },

  handleCast: (msg, state) => {
    if (msg.type === 'reset') {
      return { count: 0 };
    }
    return state;
  },
};

// Worker zpracovávající úlohy
interface WorkerState {
  processed: number;
  name: string;
}

type WorkerCall = { type: 'get_stats' };
type WorkerCast = { type: 'process'; task: string };
type WorkerReply = { name: string; processed: number };

function createWorkerBehavior(name: string): GenServerBehavior<WorkerState, WorkerCall, WorkerCast, WorkerReply> {
  return {
    init: () => ({ processed: 0, name }),

    handleCall: (msg, state) => {
      if (msg.type === 'get_stats') {
        return [{ name: state.name, processed: state.processed }, state];
      }
      return [{ name: state.name, processed: state.processed }, state];
    },

    handleCast: (msg, state) => {
      if (msg.type === 'process') {
        // Simulace práce
        return { ...state, processed: state.processed + 1 };
      }
      return state;
    },
  };
}

export interface AppRefs {
  supervisor: SupervisorRef;
  counter: GenServerRef<CounterState, CounterCall, CounterCast, CounterReply>;
  workers: GenServerRef<WorkerState, WorkerCall, WorkerCast, WorkerReply>[];
}

/**
 * Spuštění ukázkové aplikace
 */
export async function startApp(): Promise<AppRefs> {
  // Spuštění counteru
  const counter = await GenServer.start(counterBehavior, { name: 'counter' });

  // Spuštění workerů pod supervisorem
  const supervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      { id: 'worker-1', start: () => GenServer.start(createWorkerBehavior('worker-1'), { name: 'worker-1' }) },
      { id: 'worker-2', start: () => GenServer.start(createWorkerBehavior('worker-2'), { name: 'worker-2' }) },
      { id: 'worker-3', start: () => GenServer.start(createWorkerBehavior('worker-3'), { name: 'worker-3' }) },
    ],
    restartIntensity: { maxRestarts: 5, withinMs: 60000 },
  });

  const children = Supervisor.getChildren(supervisor);
  const workers = children.map(c => c.ref as GenServerRef<WorkerState, WorkerCall, WorkerCast, WorkerReply>);

  return { supervisor, counter, workers };
}

/**
 * Generování aktivity pro monitoring
 */
export function startActivityGenerator(refs: AppRefs): () => void {
  const interval = setInterval(() => {
    // Inkrementace counteru
    GenServer.call(refs.counter, { type: 'increment' });

    // Odesílání úloh workerům
    for (const worker of refs.workers) {
      GenServer.cast(worker, { type: 'process', task: `task_${Date.now()}` });
    }
  }, 500);

  return () => clearInterval(interval);
}
```

---

## Krok 2: Integrace Observer

Vytvořte `src/monitoring.ts`:

```typescript
import { Observer, type ObserverSnapshot, type ObserverEvent } from 'noex';

/**
 * Vytisknutí formátovaného snímku na konzoli
 */
export function printSnapshot(snapshot: ObserverSnapshot): void {
  console.clear();
  console.log('\x1b[36m' + '='.repeat(60) + '\x1b[0m');
  console.log('\x1b[36m  NOEX OBSERVER\x1b[0m');
  console.log('\x1b[36m' + '='.repeat(60) + '\x1b[0m');

  // Shrnutí
  console.log(`
  Procesů: ${snapshot.processCount}
  Celkem zpráv: ${snapshot.totalMessages}
  Celkem restartů: ${snapshot.totalRestarts}
  Použitá halda: ${(snapshot.memoryStats.heapUsed / 1024 / 1024).toFixed(2)} MB
  `);

  // Tabulka GenServerů
  console.log('\x1b[33m  GenServery:\x1b[0m');
  console.log('  ' + '-'.repeat(56));

  for (const server of snapshot.servers) {
    const status = server.status === 'running' ? '\x1b[32m●\x1b[0m' : '\x1b[31m●\x1b[0m';
    const name = (server.name || server.id).substring(0, 20).padEnd(20);
    const msgs = server.messageCount.toString().padStart(6);
    console.log(`  ${status} ${name} | zpráv: ${msgs}`);
  }

  // Supervisory
  console.log('\n\x1b[33m  Supervisory:\x1b[0m');
  console.log('  ' + '-'.repeat(56));

  for (const sup of snapshot.supervisors) {
    const name = (sup.name || sup.id).substring(0, 20).padEnd(20);
    console.log(`  ${name} | potomků: ${sup.childCount} | restartů: ${sup.totalRestarts} | ${sup.strategy}`);
  }

  console.log('\n\x1b[36m' + '='.repeat(60) + '\x1b[0m');
  console.log('  Pro ukončení stiskněte Ctrl+C');
}

/**
 * Vytisknutí stromu procesů
 */
export function printProcessTree(): void {
  const tree = Observer.getProcessTree();

  console.log('\n\x1b[35m  Strom procesů:\x1b[0m');

  function printNode(
    node: typeof tree[0],
    prefix: string = '',
    isLast: boolean = true
  ): void {
    const connector = isLast ? '└── ' : '├── ';
    const icon = node.type === 'supervisor' ? '\x1b[33m[SUP]\x1b[0m' : '\x1b[32m[GEN]\x1b[0m';
    const name = node.name || node.id;

    console.log(`  ${prefix}${connector}${icon} ${name}`);

    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    node.children.forEach((child, index) => {
      printNode(child, childPrefix, index === node.children.length - 1);
    });
  }

  tree.forEach((node, index) => {
    printNode(node, '', index === tree.length - 1);
  });
}

/**
 * Spuštění živého monitoringu s pollingem
 */
export function startLiveMonitoring(intervalMs: number = 1000): () => void {
  const stopPolling = Observer.startPolling(intervalMs, (event) => {
    if (event.type === 'stats_update') {
      const snapshot = Observer.getSnapshot();
      printSnapshot(snapshot);
    }
  });

  // Přihlášení k lifecycle událostem
  const unsubscribe = Observer.subscribe((event) => {
    logEvent(event);
  });

  return () => {
    stopPolling();
    unsubscribe();
  };
}

/**
 * Logování lifecycle událostí
 */
function logEvent(event: ObserverEvent): void {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);

  switch (event.type) {
    case 'server_started':
      console.log(`[${timestamp}] \x1b[32m+\x1b[0m Server spuštěn: ${event.stats.name || event.stats.id}`);
      break;
    case 'server_stopped':
      console.log(`[${timestamp}] \x1b[31m-\x1b[0m Server zastaven: ${event.id} (${event.reason})`);
      break;
    case 'supervisor_started':
      console.log(`[${timestamp}] \x1b[32m+\x1b[0m Supervisor spuštěn: ${event.stats.name || event.stats.id}`);
      break;
    case 'supervisor_stopped':
      console.log(`[${timestamp}] \x1b[31m-\x1b[0m Supervisor zastaven: ${event.id}`);
      break;
  }
}
```

---

## Krok 3: Konfigurace alertů

Vytvořte `src/alerts.ts`:

```typescript
import { Observer, AlertManager, type Alert } from 'noex';

/**
 * Konfigurace systémových alertů
 */
export function setupAlerts(): () => void {
  // Konfigurace prahových hodnot alertů
  AlertManager.configure({
    messageRateThreshold: 100,      // Alert při > 100 zpráv/sec
    restartRateThreshold: 3,        // Alert při > 3 restartech/min
    memoryThresholdPercent: 80,     // Alert při haldě > 80%
    queueSizeThreshold: 50,         // Alert při frontě > 50 zpráv
  });

  // Přihlášení k alert událostem
  const unsubscribe = Observer.subscribeToAlerts((event) => {
    if (event.type === 'alert_triggered') {
      handleAlert(event.alert);
    } else if (event.type === 'alert_resolved') {
      console.log(`\x1b[32m[VYŘEŠENO]\x1b[0m Alert vyřešen pro ${event.processId}`);
    }
  });

  return unsubscribe;
}

/**
 * Zpracování spuštěných alertů
 */
function handleAlert(alert: Alert): void {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);

  switch (alert.type) {
    case 'high_message_rate':
      console.log(`\x1b[31m[ALERT ${timestamp}]\x1b[0m Vysoká rychlost zpráv na ${alert.processId}: ${alert.currentValue}/sec (práh: ${alert.threshold})`);
      break;

    case 'high_restart_rate':
      console.log(`\x1b[31m[ALERT ${timestamp}]\x1b[0m Vysoká rychlost restartů na ${alert.processId}: ${alert.currentValue} restartů (práh: ${alert.threshold})`);
      break;

    case 'high_memory':
      console.log(`\x1b[31m[ALERT ${timestamp}]\x1b[0m Vysoké využití paměti: ${alert.currentValue}% (práh: ${alert.threshold}%)`);
      break;

    case 'queue_overflow':
      console.log(`\x1b[31m[ALERT ${timestamp}]\x1b[0m Přetečení fronty na ${alert.processId}: ${alert.currentValue} zpráv (práh: ${alert.threshold})`);
      break;
  }
}

/**
 * Získání všech aktivních alertů
 */
export function getActiveAlerts(): readonly Alert[] {
  return Observer.getActiveAlerts();
}
```

---

## Krok 4: Vestavěný TUI Dashboard

Nejjednodušší způsob monitoringu je použití vestavěného Dashboardu. Vytvořte `src/dashboard-example.ts`:

```typescript
import { Dashboard } from 'noex/dashboard';
import { startApp, startActivityGenerator } from './app.js';

async function main() {
  // Spuštění aplikace
  const refs = await startApp();
  const stopActivity = startActivityGenerator(refs);

  // Vytvoření a spuštění dashboardu
  const dashboard = new Dashboard({
    refreshInterval: 500,
    theme: 'dark',
    layout: 'full',
  });

  dashboard.start();

  // Zpracování shutdownu
  process.on('SIGINT', async () => {
    stopActivity();
    dashboard.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

Spusťte pomocí:

```bash
npx tsx src/dashboard-example.ts
```

### Ovládání Dashboardu

| Klávesa | Akce |
|---------|------|
| `q` / `Escape` | Ukončit |
| `r` | Obnovit |
| `1` / `2` / `3` | Přepnout rozložení |
| `Tab` | Fokus na další widget |
| `Enter` | Zobrazit detail procesu |
| `?` / `h` | Nápověda |

---

## Krok 5: Web-based monitoring

Pro vzdálený monitoring vytvořte web endpoint. Vytvořte `src/web-monitor.ts`:

```typescript
import express from 'express';
import { Observer } from 'noex';
import { startApp, startActivityGenerator } from './app.js';
import { setupAlerts, getActiveAlerts } from './alerts.js';

async function main() {
  const port = parseInt(process.env.PORT || '8080', 10);

  // Spuštění aplikace
  const refs = await startApp();
  const stopActivity = startActivityGenerator(refs);
  const stopAlerts = setupAlerts();

  // Vytvoření Express aplikace
  const app = express();

  // JSON API endpointy
  app.get('/api/snapshot', (_req, res) => {
    const snapshot = Observer.getSnapshot();
    res.json(snapshot);
  });

  app.get('/api/servers', (_req, res) => {
    const servers = Observer.getServerStats();
    res.json(servers);
  });

  app.get('/api/supervisors', (_req, res) => {
    const supervisors = Observer.getSupervisorStats();
    res.json(supervisors);
  });

  app.get('/api/tree', (_req, res) => {
    const tree = Observer.getProcessTree();
    res.json(tree);
  });

  app.get('/api/memory', (_req, res) => {
    const memory = Observer.getMemoryStats();
    res.json(memory);
  });

  app.get('/api/alerts', (_req, res) => {
    const alerts = getActiveAlerts();
    res.json(alerts);
  });

  // Jednoduchý HTML dashboard
  app.get('/', (_req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>noex Monitor</title>
  <style>
    body { font-family: monospace; background: #1a1a2e; color: #eee; padding: 20px; }
    h1 { color: #e94560; }
    .stats { display: flex; gap: 20px; margin: 20px 0; }
    .stat { background: #16213e; padding: 15px; border-radius: 8px; }
    .stat h3 { margin: 0 0 10px; color: #0f3460; }
    .stat .value { font-size: 24px; color: #e94560; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
    th { background: #16213e; color: #e94560; }
    .running { color: #4caf50; }
    .stopped { color: #f44336; }
  </style>
</head>
<body>
  <h1>noex Monitor</h1>
  <div class="stats">
    <div class="stat">
      <h3>Procesů</h3>
      <div class="value" id="processes">-</div>
    </div>
    <div class="stat">
      <h3>Zpráv</h3>
      <div class="value" id="messages">-</div>
    </div>
    <div class="stat">
      <h3>Restartů</h3>
      <div class="value" id="restarts">-</div>
    </div>
    <div class="stat">
      <h3>Paměť</h3>
      <div class="value" id="memory">-</div>
    </div>
  </div>

  <h2>GenServery</h2>
  <table id="servers">
    <thead>
      <tr>
        <th>Status</th>
        <th>Název</th>
        <th>Zpráv</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

  <h2>Supervisory</h2>
  <table id="supervisors">
    <thead>
      <tr>
        <th>Název</th>
        <th>Strategie</th>
        <th>Potomků</th>
        <th>Restartů</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

  <script>
    async function refresh() {
      const res = await fetch('/api/snapshot');
      const data = await res.json();

      document.getElementById('processes').textContent = data.processCount;
      document.getElementById('messages').textContent = data.totalMessages;
      document.getElementById('restarts').textContent = data.totalRestarts;
      document.getElementById('memory').textContent =
        (data.memoryStats.heapUsed / 1024 / 1024).toFixed(1) + ' MB';

      // Aktualizace tabulky serverů
      const serversBody = document.querySelector('#servers tbody');
      serversBody.innerHTML = data.servers.map(s => \`
        <tr>
          <td class="\${s.status}">\${s.status === 'running' ? '●' : '○'}</td>
          <td>\${s.name || s.id}</td>
          <td>\${s.messageCount}</td>
        </tr>
      \`).join('');

      // Aktualizace tabulky supervisorů
      const supervisorsBody = document.querySelector('#supervisors tbody');
      supervisorsBody.innerHTML = data.supervisors.map(s => \`
        <tr>
          <td>\${s.name || s.id}</td>
          <td>\${s.strategy}</td>
          <td>\${s.childCount}</td>
          <td>\${s.totalRestarts}</td>
        </tr>
      \`).join('');
    }

    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>
    `);
  });

  // Spuštění serveru
  const server = app.listen(port, () => {
    console.log(`Monitor běží na http://localhost:${port}`);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    stopActivity();
    stopAlerts();
    server.close();
    process.exit(0);
  });
}

main().catch(console.error);
```

Spusťte pomocí:

```bash
npx tsx src/web-monitor.ts
```

Otevřete `http://localhost:8080` ve vašem prohlížeči pro zobrazení dashboardu.

---

## Krok 6: Konzolový živý monitor

Pro jednoduchý konzolový monitor vytvořte `src/console-monitor.ts`:

```typescript
import { Observer } from 'noex';
import { startApp, startActivityGenerator } from './app.js';
import { printSnapshot, printProcessTree } from './monitoring.js';
import { setupAlerts } from './alerts.js';

async function main() {
  // Spuštění aplikace
  const refs = await startApp();
  const stopActivity = startActivityGenerator(refs);
  const stopAlerts = setupAlerts();

  console.log('Spouštím živý monitoring...\n');

  // Vytisknutí počátečního stromu
  printProcessTree();

  // Spuštění živého monitoringu
  const stopMonitoring = Observer.startPolling(1000, () => {
    const snapshot = Observer.getSnapshot();
    printSnapshot(snapshot);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nVypínám...');
    stopActivity();
    stopAlerts();
    stopMonitoring();
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Krok 7: Vzdálený TUI Dashboard

Pro připojení ke vzdálené noex aplikaci použijte DashboardServer:

Ve vaší aplikaci (`src/app-with-dashboard-server.ts`):

```typescript
import { DashboardServer } from 'noex';
import { startApp, startActivityGenerator } from './app.js';

async function main() {
  // Spuštění aplikace
  const refs = await startApp();
  const stopActivity = startActivityGenerator(refs);

  // Spuštění Dashboard Serveru
  const dashboardServer = await DashboardServer.start({
    port: 9876,
  });

  console.log('Aplikace běží s DashboardServer na portu 9876');
  console.log('Připojte se z jiného terminálu pomocí: npx noex-dashboard --port 9876');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    stopActivity();
    await DashboardServer.stop(dashboardServer);
    process.exit(0);
  });
}

main().catch(console.error);
```

Z jiného terminálu se připojte:

```bash
npx noex-dashboard --port 9876
```

---

## Krok 8: Export dat

Export monitoring dat pro externí nástroje. Vytvořte `src/export.ts`:

```typescript
import { Observer, exportToJson, exportToCsv } from 'noex/observer';
import { writeFileSync } from 'fs';

/**
 * Export aktuálního stavu do JSON
 */
export function exportJsonSnapshot(filename: string): void {
  const data = Observer.prepareExportData();
  const json = exportToJson(data);
  writeFileSync(filename, json);
  console.log(`Exportováno JSON do ${filename}`);
}

/**
 * Export aktuálního stavu do CSV souborů
 */
export function exportCsvSnapshot(prefix: string): void {
  const data = Observer.prepareExportData();
  const csvs = exportToCsv(data);

  writeFileSync(`${prefix}_servers.csv`, csvs.servers);
  writeFileSync(`${prefix}_supervisors.csv`, csvs.supervisors);

  console.log(`Exportovány CSV soubory s prefixem ${prefix}`);
}

// Použití:
// exportJsonSnapshot('snapshot.json');
// exportCsvSnapshot('monitoring');
```

---

## Package.json skripty

Přidejte do vašeho `package.json`:

```json
{
  "type": "module",
  "scripts": {
    "start": "tsx src/app.ts",
    "dashboard": "tsx src/dashboard-example.ts",
    "web-monitor": "tsx src/web-monitor.ts",
    "console-monitor": "tsx src/console-monitor.ts"
  }
}
```

---

## Best Practices

1. **Polling interval**: Používejte 500-1000ms pro dashboardy, delší pro logování
2. **Paměť**: Monitorujte využití haldy pro detekci memory leaků
3. **Restarty**: Sledujte rychlost restartů pro zachycení selhávajících služeb
4. **Alerty**: Nastavte rozumné prahy na základě vaší aplikace
5. **Export**: Pravidelně exportujte data pro historickou analýzu

---

## Další kroky

- [Observer API](../api/observer.md) - Kompletní reference Observer
- [Dashboard API](../api/dashboard.md) - Možnosti TUI dashboardu
- [DashboardServer API](../api/dashboard-server.md) - Vzdálený monitoring
- [AlertManager API](../api/alert-manager.md) - Konfigurace alertů
