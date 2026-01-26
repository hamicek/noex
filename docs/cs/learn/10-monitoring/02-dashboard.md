# Dashboard

V předchozí kapitole jste se naučili používat Observer pro programatickou introspekci procesů. Nyní prozkoumáme **Dashboard** — vestavěné TUI (Terminal User Interface) pro vizuální monitoring vašich noex aplikací.

## Co se naučíte

- Spustit lokální TUI dashboard pro real-time monitoring
- Konfigurovat rozložení a témata pro různé případy použití
- Používat klávesové zkratky pro efektivní navigaci
- Nastavit vzdálený dashboard server pro produkční monitoring
- Připojit se ke vzdáleným dashboardům z jakéhokoli stroje
- Přepínat mezi lokálním a cluster view módem

## Přehled TUI Dashboardu

Dashboard poskytuje interaktivní terminálové rozhraní postavené na `blessed` a `blessed-contrib`. Zobrazuje:

- **Strom procesů**: Hierarchický pohled na vaši strukturu supervize
- **Tabulka statistik**: Real-time statistiky všech GenServerů
- **Ukazatel paměti**: Vizuální indikátor využití V8 heap
- **Log událostí**: Živý stream lifecycle událostí procesů

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ROZLOŽENÍ DASHBOARDU (Full)                           │
├────────────────────────────────┬────────────────────────────────────────────┤
│                                │                                            │
│     STROM PROCESŮ              │           TABULKA STATISTIK                │
│                                │                                            │
│  [SUP] app_supervisor          │  ID          Stav    Fronta Zprávy  Běží   │
│    ├─ [GEN] database           │  database    running     0  15234   5m     │
│    ├─ [GEN] cache              │  cache       running     3   8921   5m     │
│    └─ [SUP] workers            │  worker_1    running    12   3456   2m     │
│        ├─ [GEN] worker_1       │  worker_2    running     8   3201   5m     │
│        └─ [GEN] worker_2       │  logger      running     0  52341   5m     │
│                                │                                            │
├────────────────────────────────┼────────────────────────────────────────────┤
│                                │                                            │
│     UKAZATEL PAMĚTI            │           LOG UDÁLOSTÍ                     │
│                                │                                            │
│  ████████████░░░░░  45%        │  12:00:01 GenServer spuštěn: worker_1      │
│  Heap: 45MB / 100MB            │  12:00:00 Supervisor spuštěn: workers      │
│                                │  11:59:58 GenServer zastaven: worker_1     │
│                                │                                            │
├────────────────────────────────┴────────────────────────────────────────────┤
│ [q]uit [r]efresh [?]help [1-3]layout [c]luster | [1:Full] | Procesy: 6      │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Spuštění lokálního Dashboardu

Třída Dashboard poskytuje přímý monitoring procesů ve stejném Node.js procesu:

```typescript
import { Dashboard } from 'noex/dashboard';

// Vytvořit dashboard s výchozím nastavením
const dashboard = new Dashboard();

// Spustit TUI
dashboard.start();

// Dashboard převezme terminál dokud není zastaven
// Stiskněte 'q' nebo Escape pro ukončení
```

### Konfigurace Dashboardu

Přizpůsobte chování dashboardu pomocí konfiguračních možností:

```typescript
import { Dashboard } from 'noex/dashboard';

const dashboard = new Dashboard({
  // Interval pollování pro aktualizace statistik (milisekundy)
  refreshInterval: 500,  // výchozí: 500

  // Maximální počet událostí v logu
  maxEventLogSize: 100,  // výchozí: 100

  // Barevné téma
  theme: 'dark',         // 'dark' | 'light', výchozí: 'dark'

  // Počáteční mód rozložení
  layout: 'full',        // 'full' | 'compact' | 'minimal', výchozí: 'full'
});

dashboard.start();
```

### Programatické ovládání

Ovládejte dashboard programaticky:

```typescript
const dashboard = new Dashboard();
dashboard.start();

// Zjistit zda běží
console.log(dashboard.isRunning());  // true

// Vynutit okamžité obnovení
dashboard.refresh();

// Přepnout rozložení za běhu
dashboard.switchLayout('compact');

// Získat aktuální rozložení
console.log(dashboard.getLayout());  // 'compact'

// Přepnout view mód (lokální vs cluster)
dashboard.switchViewMode('cluster');

// Zastavit dashboard
dashboard.stop();
```

## Módy rozložení

Dashboard podporuje tři módy rozložení pro různé velikosti terminálů a případy použití:

### Full rozložení

Zobrazuje všechny widgety — ideální pro velké terminály:

```typescript
dashboard.switchLayout('full');
// Nebo stiskněte '1' v dashboardu
```

**Zobrazené widgety:**
- Strom procesů (vlevo)
- Tabulka statistik (vpravo)
- Ukazatel paměti (vlevo dole)
- Log událostí (vpravo dole)
- Stavový řádek (dole)

### Compact rozložení

Pouze základní widgety — dobré pro střední terminály:

```typescript
dashboard.switchLayout('compact');
// Nebo stiskněte '2' v dashboardu
```

**Zobrazené widgety:**
- Strom procesů (vlevo)
- Tabulka statistik (vpravo)
- Stavový řádek (dole)

### Minimal rozložení

Pouze tabulka statistik — pro malé terminály nebo embedded displeje:

```typescript
dashboard.switchLayout('minimal');
// Nebo stiskněte '3' v dashboardu
```

**Zobrazené widgety:**
- Tabulka statistik (celá šířka)
- Stavový řádek (dole)

## Klávesové zkratky

| Klávesa | Akce |
|---------|------|
| `q`, `Escape`, `Ctrl+C` | Ukončit dashboard |
| `r` | Okamžitě obnovit data |
| `?`, `h` | Zobrazit dialog nápovědy |
| `Tab` | Fokus na další widget |
| `Shift+Tab` | Fokus na předchozí widget |
| `Enter` | Zobrazit detail procesu |
| `Šipky` | Navigace ve fokusovaném widgetu |
| `1` | Přepnout na full rozložení |
| `2` | Přepnout na compact rozložení |
| `3` | Přepnout na minimal rozložení |
| `c` | Přepnout lokální/cluster pohled |

## Barevná témata

Dvě vestavěná témata optimalizovaná pro různá pozadí terminálu:

**Tmavé téma (výchozí):**
```typescript
const dashboard = new Dashboard({ theme: 'dark' });
```

- Cyan primární akcenty
- Bílý text na černém pozadí
- Vhodné pro tmavá témata terminálu

**Světlé téma:**
```typescript
const dashboard = new Dashboard({ theme: 'light' });
```

- Modré primární akcenty
- Černý text na bílém pozadí
- Vhodné pro světlá témata terminálu

## Architektura vzdáleného Dashboardu

Pro produkční prostředí typicky provozujete aplikaci na serveru a chcete ji monitorovat ze své pracovní stanice. noex poskytuje klient-server architekturu pro vzdálený monitoring:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ARCHITEKTURA VZDÁLENÉHO DASHBOARDU                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────┐      TCP      ┌──────────────────────────┐ │
│  │     Produkční server        │    :9876      │    Vaše pracovní stanice │ │
│  │                             │◄─────────────►│                          │ │
│  │  ┌───────────────────────┐  │               │  ┌────────────────────┐  │ │
│  │  │   Vaše aplikace       │  │               │  │  DashboardClient   │  │ │
│  │  │                       │  │               │  │  (TUI rendering)   │  │ │
│  │  │  GenServery           │  │   Snímek      │  │                    │  │ │
│  │  │  Supervisory          │──┼──Aktualizace─►│  │  Strom procesů     │  │ │
│  │  │  ...                  │  │               │  │  Tabulka statistik │  │ │
│  │  └───────────────────────┘  │   Lifecycle   │  │  Log událostí      │  │ │
│  │           │                 │◄──Události────│  │  Ukazatel paměti   │  │ │
│  │           ▼                 │               │  └────────────────────┘  │ │
│  │  ┌───────────────────────┐  │               │                          │ │
│  │  │   DashboardServer     │  │               │                          │ │
│  │  │   (GenServer)         │  │               │  $ noex-dashboard        │ │
│  │  │                       │  │               │    --host 192.168.1.100  │ │
│  │  │  - TCP Server         │  │               │    --port 9876           │ │
│  │  │  - Observer pollování │  │               │                          │ │
│  │  │  - Event streaming    │  │               │                          │ │
│  │  └───────────────────────┘  │               │                          │ │
│  │                             │               │                          │ │
│  └─────────────────────────────┘               └──────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Nastavení Dashboard Serveru

Na vašem produkčním serveru vložte DashboardServer do vaší aplikace:

```typescript
import { Application, DashboardServer } from '@hamicek/noex';

// Spustit vaši aplikaci
const app = await Application.start({
  name: 'my_app',
  behavior: MyAppBehavior,
  config: { /* ... */ },
});

// Spustit dashboard server
const dashboardRef = await DashboardServer.start({
  port: 9876,           // TCP port pro naslouchání
  host: '0.0.0.0',      // Bind na všechna rozhraní (nebo '127.0.0.1' pouze lokální)
  pollingIntervalMs: 500, // Jak často pollovat Observer
});

console.log('Dashboard server naslouchá na portu 9876');

// Dotaz na stav serveru
const status = await DashboardServer.getStatus(dashboardRef);
console.log(`Připojených klientů: ${status.clientCount}`);
console.log(`Doba běhu: ${status.uptime}ms`);

// Získat počet klientů
const clientCount = await DashboardServer.getClientCount(dashboardRef);
console.log(`${clientCount} dashboard klientů připojeno`);

// Zastavit při vypínání
process.on('SIGTERM', async () => {
  await DashboardServer.stop(dashboardRef);
  await Application.stop(app);
});
```

**Funkce DashboardServeru:**

- Běží jako GenServer vedle vaší aplikace
- Polluje Observer pro aktualizace statistik
- Přihlašuje se k lifecycle událostem
- Broadcastuje aktualizace všem připojeným klientům
- Zvládá více souběžných klientských připojení
- Používá length-prefixed TCP protokol pro spolehlivé zprávy

## Připojení pomocí DashboardClient

Z vaší pracovní stanice se připojte ke vzdálenému serveru:

```typescript
import { DashboardClient } from 'noex/dashboard/client';

const client = new DashboardClient({
  // Nastavení připojení
  host: '192.168.1.100',
  port: 9876,

  // Nastavení znovupřipojení
  autoReconnect: true,            // Povolit auto-reconnect
  reconnectDelayMs: 1000,         // Počáteční prodleva
  maxReconnectDelayMs: 30000,     // Max prodleva (30s)
  reconnectBackoffMultiplier: 1.5, // Exponenciální backoff

  // Timeout připojení
  connectionTimeoutMs: 5000,      // 5 sekund timeout

  // TUI nastavení (stejné jako lokální Dashboard)
  theme: 'dark',
  layout: 'full',
  maxEventLogSize: 100,
});

// Spustit klienta (připojí se a vykreslí TUI)
await client.start();
```

**Funkce připojení:**

- Automatické znovupřipojení s exponenciálním backoff
- Zpracování timeout připojení
- Čisté odpojení při ukončení
- Stejný TUI zážitek jako lokální dashboard
- Podpora cluster view (pokud má server cluster povolený)

## Použití CLI nástroje

Nejjednodušší způsob připojení ke vzdálenému dashboardu je CLI `noex-dashboard`:

```bash
# Nainstalovat závislosti pro TUI
npm install blessed blessed-contrib

# Připojit se k localhost na výchozím portu
noex-dashboard

# Připojit se ke vzdálenému serveru
noex-dashboard --host 192.168.1.100 --port 9876

# Použít compact rozložení se světlým tématem
noex-dashboard -l compact -t light

# Zakázat auto-reconnect
noex-dashboard --no-reconnect
```

**CLI možnosti:**

| Možnost | Zkratka | Výchozí | Popis |
|---------|---------|---------|-------|
| `--host` | `-H` | `127.0.0.1` | Adresa serveru |
| `--port` | `-p` | `9876` | TCP port serveru |
| `--theme` | `-t` | `dark` | Barevné téma: `dark`, `light` |
| `--layout` | `-l` | `full` | Rozložení: `full`, `compact`, `minimal` |
| `--no-reconnect` | | `false` | Zakázat automatické znovupřipojení |
| `--help` | `-h` | | Zobrazit nápovědu |
| `--version` | `-v` | | Zobrazit verzi |

## Cluster View mód

Při provozu distribuovaného noex clusteru může Dashboard zobrazit procesy napříč všemi uzly:

```typescript
// Ve vaší aplikaci (s povoleným clusterem)
import { Cluster, DashboardServer } from '@hamicek/noex';

// Spustit cluster
await Cluster.start({
  nodeId: 'node_1',
  seedNodes: ['node_2:5555', 'node_3:5555'],
  // ...
});

// Spustit dashboard server
await DashboardServer.start({ port: 9876 });
```

**V dashboard klientovi:**

Stiskněte `c` pro přepnutí mezi lokálním a cluster view módem.

**Cluster view zobrazuje:**
- Všechny uzly v clusteru
- Počty procesů na uzel
- Agregované statistiky
- Stav připojení pro každý uzel

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CLUSTER VIEW                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  STROM CLUSTERU                     │   STATISTIKY (Agregované)             │
│                                     │                                       │
│  ● node_1 (lokální)                 │   Celkem procesů: 18                  │
│    ├─ [SUP] app_supervisor          │   Celkem zpráv:   52341               │
│    │   ├─ [GEN] database            │   Celkem restartů: 3                  │
│    │   └─ [GEN] cache               │                                       │
│    └─ [GEN] logger                  │   Stav uzlů:                          │
│                                     │   ● node_1: 6 procesů (připojen)      │
│  ● node_2                           │   ● node_2: 6 procesů (připojen)      │
│    ├─ [SUP] app_supervisor          │   ○ node_3: 6 procesů (připojování)   │
│    │   ├─ [GEN] database            │                                       │
│    │   └─ [GEN] cache               │                                       │
│    └─ [GEN] logger                  │                                       │
│                                     │                                       │
│  ○ node_3 (připojování...)          │                                       │
│                                     │                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Praktický příklad: Produkční monitorovací setup

Zde je kompletní produkční setup s integrací DashboardServeru:

```typescript
import {
  Application,
  DashboardServer,
  Observer,
  type ApplicationBehavior,
} from '@hamicek/noex';

interface AppConfig {
  port: number;
  dashboardPort: number;
  dashboardHost: string;
}

const ProductionApp: ApplicationBehavior<AppConfig> = {
  async start(config) {
    // Spustit hlavní supervisor aplikace
    const mainSupervisor = await Supervisor.start({
      strategy: 'one_for_one',
      children: [
        { id: 'database', start: () => DatabasePool.start(config) },
        { id: 'cache', start: () => CacheService.start() },
        { id: 'api', start: () => ApiServer.start(config.port) },
      ],
    });

    // Spustit dashboard server pro vzdálený monitoring
    const dashboardServer = await DashboardServer.start({
      port: config.dashboardPort,
      host: config.dashboardHost,
      pollingIntervalMs: 500,
    });

    // Logovat když se klienti připojí (přes Observer události)
    const unsubscribe = Observer.subscribe((event) => {
      if (event.type === 'server_started' && event.stats.id.includes('dashboard')) {
        console.log('Dashboard server připraven pro připojení');
      }
    });

    return { mainSupervisor, dashboardServer, unsubscribe };
  },

  async prepStop({ dashboardServer }) {
    // Přestat přijímat nová dashboard připojení
    await DashboardServer.stop(dashboardServer);
  },

  async stop({ mainSupervisor, unsubscribe }) {
    unsubscribe();
    await Supervisor.stop(mainSupervisor);
  },
};

// Spustit aplikaci
const app = await Application.start({
  name: 'production_app',
  behavior: ProductionApp,
  config: {
    port: 3000,
    dashboardPort: 9876,
    dashboardHost: '0.0.0.0',
  },
  handleSignals: true,
  stopTimeout: 30000,
});

console.log('Aplikace spuštěna');
console.log('Dashboard dostupný na :9876');
console.log('Připojte se pomocí: noex-dashboard --host <server-ip> --port 9876');
```

**Poznámky k nasazení:**

1. **Firewall**: Otevřete port 9876 (nebo vámi zvolený port) pro dashboard připojení
2. **Bezpečnost**: Zvažte bind na `127.0.0.1` a použití SSH tunelování pro produkci
3. **Více klientů**: DashboardServer podporuje více souběžných připojení
4. **Graceful shutdown**: Zastavte DashboardServer před zastavením hlavní aplikace

## Bezpečnostní úvahy

Dashboard používá plain TCP protokol bez autentizace. Pro produkci:

**Možnost 1: SSH Tunelování (Doporučeno)**

```bash
# Na vaší pracovní stanici vytvořte SSH tunel
ssh -L 9876:localhost:9876 user@production-server

# Poté se připojte k localhost
noex-dashboard --host 127.0.0.1 --port 9876
```

**Možnost 2: Bind pouze na Localhost**

```typescript
// Povolit pouze lokální připojení
await DashboardServer.start({
  host: '127.0.0.1',  // Bind pouze na localhost
  port: 9876,
});
```

**Možnost 3: VPN/Privátní síť**

Nasaďte dashboard server pouze na interní sítě přístupné přes VPN.

## Cvičení: Vlastní integrace Dashboardu

Vytvořte monitorovací setup, který integruje dashboard s vlastními health checky.

**Požadavky:**

1. Spusťte DashboardServer s vaší aplikací
2. Vytvořte HealthMonitor GenServer který:
   - Polluje Observer každých 5 sekund
   - Sleduje propustnost zpráv
   - Generuje alerty když hloubka fronty překročí práh
3. Logujte když se dashboard klienti připojí/odpojí
4. Vystavte health endpoint který obsahuje stav dashboardu

**Startovací kód:**

```typescript
import {
  GenServer,
  Supervisor,
  Observer,
  DashboardServer,
  type GenServerBehavior,
  type SupervisorStrategy,
} from '@hamicek/noex';

interface HealthMonitorState {
  lastMessageCount: number;
  lastCheckTime: number;
  throughputRate: number;
  alerts: string[];
  dashboardClientCount: number;
}

type HealthCall =
  | { type: 'getHealth' }
  | { type: 'getAlerts' };

type HealthCast =
  | { type: 'checkHealth' }
  | { type: 'dashboardClientConnected' }
  | { type: 'dashboardClientDisconnected' };

type HealthReply =
  | { healthy: boolean; throughput: number; dashboardClients: number }
  | { alerts: string[] };

const HealthMonitorBehavior: GenServerBehavior<
  HealthMonitorState,
  HealthCall,
  HealthCast,
  HealthReply
> = {
  init: () => ({
    // TODO: Inicializovat stav
  }),

  handleCall: (msg, state) => {
    // TODO: Zpracovat getHealth a getAlerts volání
  },

  handleCast: (msg, state) => {
    // TODO: Zpracovat health checky a sledování dashboard klientů
  },
};

async function main() {
  // TODO: Spustit supervisor s HealthMonitorem
  // TODO: Spustit DashboardServer
  // TODO: Nastavit periodické health checky
  // TODO: Sledovat dashboard připojení
}

main().catch(console.error);
```

<details>
<summary><strong>Řešení</strong></summary>

```typescript
import {
  GenServer,
  Supervisor,
  Observer,
  DashboardServer,
  type GenServerBehavior,
  type GenServerRef,
  type ObserverEvent,
} from '@hamicek/noex';

// ============================================================================
// HealthMonitor GenServer
// ============================================================================

interface HealthMonitorState {
  lastMessageCount: number;
  lastCheckTime: number;
  throughputRate: number;
  alerts: string[];
  dashboardClientCount: number;
}

type HealthCall =
  | { type: 'getHealth' }
  | { type: 'getAlerts' };

type HealthCast =
  | { type: 'checkHealth' }
  | { type: 'dashboardClientConnected' }
  | { type: 'dashboardClientDisconnected' }
  | { type: 'clearAlerts' };

type HealthReply =
  | { healthy: boolean; throughput: number; dashboardClients: number; processCount: number }
  | { alerts: string[] };

const HealthMonitorBehavior: GenServerBehavior<
  HealthMonitorState,
  HealthCall,
  HealthCast,
  HealthReply
> = {
  init: () => ({
    lastMessageCount: 0,
    lastCheckTime: Date.now(),
    throughputRate: 0,
    alerts: [],
    dashboardClientCount: 0,
  }),

  handleCall: (msg, state) => {
    switch (msg.type) {
      case 'getHealth': {
        const snapshot = Observer.getSnapshot();
        const highQueueProcesses = snapshot.servers.filter(s => s.queueSize > 50);
        const healthy = highQueueProcesses.length === 0 && state.alerts.length < 5;

        return [
          {
            healthy,
            throughput: Math.round(state.throughputRate * 10) / 10,
            dashboardClients: state.dashboardClientCount,
            processCount: snapshot.processCount,
          },
          state,
        ];
      }

      case 'getAlerts':
        return [{ alerts: [...state.alerts] }, state];
    }
  },

  handleCast: (msg, state) => {
    switch (msg.type) {
      case 'checkHealth': {
        const snapshot = Observer.getSnapshot();
        const now = Date.now();
        const elapsed = (now - state.lastCheckTime) / 1000;

        // Vypočítat propustnost
        const throughput = elapsed > 0
          ? (snapshot.totalMessages - state.lastMessageCount) / elapsed
          : 0;

        // Zkontrolovat vysokou hloubku fronty
        const newAlerts: string[] = [];
        for (const server of snapshot.servers) {
          if (server.queueSize > 100) {
            newAlerts.push(
              `KRITICKÉ: ${server.id} hloubka fronty ${server.queueSize}`
            );
          } else if (server.queueSize > 50) {
            newAlerts.push(
              `VAROVÁNÍ: ${server.id} hloubka fronty ${server.queueSize}`
            );
          }
        }

        // Zkontrolovat paměť
        const heapPercent = (snapshot.memoryStats.heapUsed / snapshot.memoryStats.heapTotal) * 100;
        if (heapPercent > 90) {
          newAlerts.push(`KRITICKÉ: Využití heap na ${Math.round(heapPercent)}%`);
        }

        return {
          ...state,
          lastMessageCount: snapshot.totalMessages,
          lastCheckTime: now,
          throughputRate: throughput,
          alerts: [...state.alerts, ...newAlerts].slice(-20),
        };
      }

      case 'dashboardClientConnected':
        console.log(`Dashboard klient připojen (celkem: ${state.dashboardClientCount + 1})`);
        return { ...state, dashboardClientCount: state.dashboardClientCount + 1 };

      case 'dashboardClientDisconnected':
        console.log(`Dashboard klient odpojen (celkem: ${state.dashboardClientCount - 1})`);
        return { ...state, dashboardClientCount: Math.max(0, state.dashboardClientCount - 1) };

      case 'clearAlerts':
        return { ...state, alerts: [] };
    }
  },
};

// ============================================================================
// Hlavní aplikace
// ============================================================================

async function main() {
  // Spustit health monitor
  const healthMonitor = await GenServer.start(HealthMonitorBehavior, {
    name: 'health_monitor',
  });

  // Spustit nějaké příkladové workery pro monitoring
  const workerSupervisor = await Supervisor.start({
    strategy: 'one_for_one',
    children: [
      {
        id: 'worker_1',
        start: () => GenServer.start({
          init: () => ({ count: 0 }),
          handleCall: () => [null, { count: 0 }],
          handleCast: (_, s) => ({ count: s.count + 1 }),
        }),
      },
      {
        id: 'worker_2',
        start: () => GenServer.start({
          init: () => ({ count: 0 }),
          handleCall: () => [null, { count: 0 }],
          handleCast: (_, s) => ({ count: s.count + 1 }),
        }),
      },
    ],
  });

  // Spustit dashboard server
  const dashboardServer = await DashboardServer.start({
    port: 9876,
    host: '127.0.0.1',
    pollingIntervalMs: 500,
  });

  console.log('Dashboard server spuštěn na portu 9876');
  console.log('Připojte se pomocí: noex-dashboard --port 9876');

  // Nastavit periodické health checky (každých 5 sekund)
  const healthCheckInterval = setInterval(() => {
    GenServer.cast(healthMonitor, { type: 'checkHealth' });
  }, 5000);

  // Počáteční health check
  GenServer.cast(healthMonitor, { type: 'checkHealth' });

  // Sledovat připojení dashboard klientů
  let lastClientCount = 0;
  const clientCheckInterval = setInterval(async () => {
    const clientCount = await DashboardServer.getClientCount(dashboardServer);

    if (clientCount > lastClientCount) {
      // Noví klienti se připojili
      for (let i = 0; i < clientCount - lastClientCount; i++) {
        GenServer.cast(healthMonitor, { type: 'dashboardClientConnected' });
      }
    } else if (clientCount < lastClientCount) {
      // Klienti se odpojili
      for (let i = 0; i < lastClientCount - clientCount; i++) {
        GenServer.cast(healthMonitor, { type: 'dashboardClientDisconnected' });
      }
    }

    lastClientCount = clientCount;
  }, 1000);

  // Vystavit health endpoint (jednoduché HTTP pro demonstraci)
  const http = await import('node:http');
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      const health = await GenServer.call(healthMonitor, { type: 'getHealth' }) as {
        healthy: boolean;
        throughput: number;
        dashboardClients: number;
        processCount: number;
      };

      const dashboardStatus = await DashboardServer.getStatus(dashboardServer);

      res.writeHead(health.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: health.healthy ? 'healthy' : 'degraded',
        processCount: health.processCount,
        throughput: `${health.throughput}/s`,
        dashboard: {
          port: dashboardStatus.port,
          clients: health.dashboardClients,
          uptime: `${Math.round(dashboardStatus.uptime / 1000)}s`,
        },
      }, null, 2));
    } else if (req.url === '/alerts') {
      const alerts = await GenServer.call(healthMonitor, { type: 'getAlerts' }) as {
        alerts: string[];
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ alerts: alerts.alerts }, null, 2));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(3000, () => {
    console.log('Health endpoint dostupný na http://localhost:3000/health');
    console.log('Alerts endpoint dostupný na http://localhost:3000/alerts');
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nUkončování...');

    clearInterval(healthCheckInterval);
    clearInterval(clientCheckInterval);

    server.close();
    await DashboardServer.stop(dashboardServer);
    await Supervisor.stop(workerSupervisor);
    await GenServer.stop(healthMonitor);

    console.log('Ukončení dokončeno');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);
```

**Spuštění příkladu:**

```bash
# Terminál 1: Spustit aplikaci
npx ts-node example.ts

# Terminál 2: Připojit dashboard
noex-dashboard --port 9876

# Terminál 3: Zkontrolovat health endpointy
curl http://localhost:3000/health
curl http://localhost:3000/alerts
```

**Příklad výstupu /health:**

```json
{
  "status": "healthy",
  "processCount": 5,
  "throughput": "45.2/s",
  "dashboard": {
    "port": 9876,
    "clients": 1,
    "uptime": "120s"
  }
}
```

</details>

## Shrnutí

**Klíčové poznatky:**

- **Dashboard** poskytuje real-time TUI pro vizuální monitoring procesů
- **Tři rozložení** (full/compact/minimal) se hodí pro různé velikosti terminálů
- **DashboardServer** umožňuje vzdálený monitoring přes TCP
- **DashboardClient** nebo `noex-dashboard` CLI se připojují ke vzdáleným serverům
- **Cluster view** zobrazuje procesy napříč všemi uzly clusteru
- **Klávesové zkratky** umožňují efektivní navigaci

**Architektura dashboardu:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         KOMPONENTY DASHBOARDU                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  LOKÁLNÍ MONITORING                                                         │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Dashboard              → TUI třída pro monitoring stejného procesu         │
│    .start()             → Začít vykreslování                                │
│    .stop()              → Zastavit a uklidit                                │
│    .refresh()           → Vynutit okamžitou aktualizaci                     │
│    .switchLayout()      → Změnit mód rozložení                              │
│    .switchViewMode()    → Přepnout lokální/cluster pohled                   │
│                                                                             │
│  VZDÁLENÝ MONITORING                                                        │
│  ─────────────────────────────────────────────────────────────────────────  │
│  DashboardServer        → GenServer vystavující data přes TCP               │
│    .start(config)       → Spustit TCP server                                │
│    .stop(ref)           → Zastavit server                                   │
│    .getStatus(ref)      → Dotaz na stav serveru                             │
│    .getClientCount(ref) → Počet připojených klientů                         │
│                                                                             │
│  DashboardClient        → Vzdálený TUI klient                               │
│    .start()             → Připojit a vykreslit                              │
│    .stop()              → Odpojit a uklidit                                 │
│                                                                             │
│  CLI NÁSTROJ                                                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│  noex-dashboard         → Příkazový řádek vzdálený dashboard klient         │
│    --host, --port       → Nastavení připojení                               │
│    --theme, --layout    → Vzhled TUI                                        │
│    --no-reconnect       → Zakázat auto-reconnection                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Kdy použít kterou komponentu:**

| Scénář | Komponenta |
|--------|------------|
| Debugging při vývoji | `Dashboard` (lokální) |
| Monitoring produkčního serveru | `DashboardServer` + `noex-dashboard` |
| Embedded monitoring UI | `Dashboard` s `minimal` rozložením |
| Vlastní integrace monitoringu | `Observer` API přímo |
| Monitoring distribuovaného clusteru | `DashboardServer` + cluster view |

**Pamatujte:**

> Dashboard je vaše vizuální okno do běžící noex aplikace. Používejte lokální Dashboard během vývoje pro sledování interakcí procesů v reálném čase. V produkci vložte DashboardServer a připojte se vzdáleně pomocí `noex-dashboard` nebo SSH tunelování pro bezpečný přístup.

---

Další: [AlertManager](./03-alertmanager.md)
