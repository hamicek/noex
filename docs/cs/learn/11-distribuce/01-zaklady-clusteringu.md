# Základy clusteringu

V předchozích kapitolách jste se naučili, jak budovat robustní aplikace na jednom stroji s GenServery, Supervisory a monitoringem. Nyní je čas škálovat za hranice jednoho procesu — **noex clustering** umožňuje vašim procesům komunikovat napříč více stroji a vytvářet distribuovaný systém s automatickým vyhledáváním uzlů a detekcí selhání.

## Co se naučíte

- Pochopit rozdíl mezi noex clusteringem a Node.js cluster modulem
- Vytvářet a validovat identity uzlů pomocí formátu NodeId
- Konfigurovat seed-based vyhledávání clusteru
- Pochopit heartbeat mechanismus pro detekci selhání
- Zpracovávat lifecycle eventy uzlů (up/down)
- Zabezpečit komunikaci clusteru pomocí sdílených tajemství
- Sestavit multi-node aplikaci od základů

## Co je noex Clustering?

Než se ponoříme do detailů, ujasněme si, co noex clustering je — a co není.

**Node.js cluster modul:**
- Master-worker vzor v rámci jednoho procesu
- Workery sdílejí stejný kód a port
- Omezený na jeden stroj
- Navržen pro využití CPU

**noex clustering:**
- Peer-to-peer, full-mesh síťová topologie
- Každý uzel je nezávislý a rovnocenný
- Překlenuje více strojů napříč sítěmi
- Navržen pro fault-toleranci a distribuci
- Inspirován Erlang/OTP distribucí

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     NODE.JS CLUSTER vs NOEX CLUSTER                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Node.js cluster modul           │  noex Cluster                           │
│  ─────────────────────────────   │  ───────────────────────────────────    │
│                                  │                                          │
│      ┌────────────┐              │      ┌────────┐     ┌────────┐          │
│      │   Master   │              │      │ Uzel A │◄───►│ Uzel B │          │
│      └─────┬──────┘              │      └────┬───┘     └───┬────┘          │
│       ┌────┼────┐                │           │             │               │
│       ▼    ▼    ▼                │           └──────┬──────┘               │
│    ┌───┐ ┌───┐ ┌───┐             │                  ▼                      │
│    │ W │ │ W │ │ W │             │             ┌────────┐                  │
│    └───┘ └───┘ └───┘             │             │ Uzel C │                  │
│    Workery (stejný stroj)        │             └────────┘                  │
│                                  │      Full mesh (libovolná síť)          │
│                                  │                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

V noex clusteru mohou procesy na libovolném uzlu komunikovat s procesy na libovolném jiném uzlu transparentně. Cluster zajišťuje:

- **Vyhledávání**: Automatické nalezení dalších uzlů
- **Heartbeaty**: Detekci selhání uzlů
- **Reconnection**: Automatickou obnovu po síťových problémech
- **Routing**: Doručení zpráv na správný uzel

## Identita uzlu (NodeId)

Každý uzel v clusteru potřebuje unikátní identitu. noex používá formát inspirovaný Erlangem: `název@host:port`.

```typescript
import { Cluster, NodeId } from '@hamicek/noex/distribution';

// Formát NodeId: název@host:port
// Příklady:
//   app1@192.168.1.10:4369
//   worker-1@localhost:4370
//   api-server@api.example.com:4369
//   cluster-node@[::1]:4369  (IPv6)
```

### Pravidla validace NodeId

NodeId má striktní validační pravidla pro zajištění konzistence napříč clusterem:

| Komponenta | Pravidla |
|------------|----------|
| **název** | Začíná písmenem, pouze alfanumerické znaky/podtržítko/pomlčka, max 64 znaků |
| **host** | Platná IPv4, IPv6 (v závorkách), nebo hostname |
| **port** | Integer mezi 1 a 65535 |

```typescript
// Platná NodeIds
NodeId.isValid('app1@192.168.1.1:4369');      // true
NodeId.isValid('worker-1@localhost:4370');    // true
NodeId.isValid('node_2@[::1]:4369');          // true (IPv6)

// Neplatná NodeIds
NodeId.isValid('1app@host:4369');             // false - název začíná číslem
NodeId.isValid('app@host:99999');             // false - port mimo rozsah
NodeId.isValid('');                           // false - prázdný řetězec
```

### Práce s NodeIds

Modul `NodeId` poskytuje funkce pro parsování a manipulaci s identitami uzlů:

```typescript
import { NodeId } from '@hamicek/noex/distribution';

// Vytvoření NodeId
const nodeId = NodeId.create('app1', '192.168.1.10', 4369);
// Výsledek: 'app1@192.168.1.10:4369'

// Parsování existujícího NodeId řetězce
const parsed = NodeId.parse('worker-1@localhost:4370');
// Vrací branded NodeId typ

// Bezpečné parsování (vrací undefined místo vyhození výjimky)
const maybeNodeId = NodeId.tryParse(userInput);
if (maybeNodeId) {
  console.log('Platné NodeId:', maybeNodeId);
}

// Extrakce komponent
const name = NodeId.getName(nodeId);      // 'app1'
const host = NodeId.getHost(nodeId);      // '192.168.1.10'
const port = NodeId.getPort(nodeId);      // 4369

// Získání všech komponent najednou
const { name, host, port } = NodeId.components(nodeId);

// Porovnání NodeIds
if (NodeId.equals(nodeId1, nodeId2)) {
  console.log('Stejný uzel');
}
```

## Spuštění clusteru

Pro vytvoření clusteru spustíte singleton `Cluster` s konfigurací:

```typescript
import { Cluster } from '@hamicek/noex/distribution';

await Cluster.start({
  nodeName: 'app1',              // Povinné: unikátní název pro tento uzel
  host: '0.0.0.0',              // Naslouchá na všech rozhraních (výchozí)
  port: 4369,                   // Výchozí port (Erlang EPMD port)
  seeds: [],                    // Žádné seeds = první uzel v clusteru
});

console.log(`Cluster spuštěn: ${Cluster.getLocalNodeId()}`);
// Výstup: Cluster spuštěn: app1@0.0.0.0:4369
```

### Konfigurační možnosti

| Možnost | Typ | Výchozí | Popis |
|---------|-----|---------|-------|
| `nodeName` | `string` | povinné | Unikátní název pro tento uzel |
| `host` | `string` | `'0.0.0.0'` | Host pro binding |
| `port` | `number` | `4369` | Port pro naslouchání |
| `seeds` | `string[]` | `[]` | Seed uzly pro připojení |
| `clusterSecret` | `string` | `undefined` | Sdílené tajemství pro HMAC autentizaci |
| `heartbeatIntervalMs` | `number` | `5000` | Frekvence heartbeatů |
| `heartbeatMissThreshold` | `number` | `3` | Zmeškaných heartbeatů před označením uzlu jako down |

### Stav clusteru

Cluster prochází několika stavy během svého životního cyklu:

```typescript
const status = Cluster.getStatus();
// 'starting' | 'running' | 'stopping' | 'stopped'
```

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ŽIVOTNÍ CYKLUS CLUSTERU                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                    Cluster.start()                                          │
│                          │                                                  │
│                          ▼                                                  │
│                    ┌──────────┐                                             │
│                    │ starting │                                             │
│                    └────┬─────┘                                             │
│                         │ TCP listener připraven                            │
│                         │ Heartbeat timer spuštěn                           │
│                         │ Připojení k seeds                                 │
│                         ▼                                                   │
│                    ┌──────────┐                                             │
│                    │ running  │◄─────────────────────┐                      │
│                    └────┬─────┘                      │                      │
│                         │                            │                      │
│        Cluster.stop()   │     (normální provoz)     │                      │
│                         ▼                            │                      │
│                    ┌──────────┐                      │                      │
│                    │ stopping │                      │                      │
│                    └────┬─────┘                      │                      │
│                         │ Notifikace peers (graceful)│                      │
│                         │ Uzavření spojení           │                      │
│                         │ Zastavení heartbeat timeru │                      │
│                         ▼                            │                      │
│                    ┌──────────┐                      │                      │
│                    │ stopped  │──────────────────────┘                      │
│                    └──────────┘       Cluster.start() znovu                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Seed uzly a vyhledávání

Seed uzly jsou vstupní body pro připojení k existujícímu clusteru. Když nový uzel startuje, připojí se ke svým nakonfigurovaným seeds, které sdílí své znalosti o dalších uzlech.

### Jak vyhledávání funguje

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SEED-BASED VYHLEDÁVÁNÍ                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. BOOTSTRAP: První uzel startuje bez seeds                                │
│     ┌────────┐                                                              │
│     │ Uzel A │  seeds: []                                                   │
│     └────────┘                                                              │
│                                                                             │
│  2. JOIN: Druhý uzel se připojuje přes seed                                 │
│     ┌────────┐         ┌────────┐                                           │
│     │ Uzel A │◄───────►│ Uzel B │  seeds: ['A@host:port']                   │
│     └────────┘         └────────┘                                           │
│                                                                             │
│  3. GOSSIP: Uzly sdílejí členství přes heartbeaty                           │
│     ┌────────┐         ┌────────┐                                           │
│     │ Uzel A │◄───────►│ Uzel B │                                           │
│     └────┬───┘         └───┬────┘                                           │
│          │    heartbeat    │                                                │
│          │  (knownNodes:   │                                                │
│          │   [A, B, C])    │                                                │
│          └────────┬────────┘                                                │
│                   ▼                                                         │
│              ┌────────┐                                                     │
│              │ Uzel C │  seeds: ['B@host:port']                             │
│              └────────┘                                                     │
│                                                                             │
│  4. FULL MESH: Všechny uzly nakonec znají všechny ostatní uzly              │
│     ┌────────┐         ┌────────┐                                           │
│     │ Uzel A │◄───────►│ Uzel B │                                           │
│     └────┬───┘         └───┬────┘                                           │
│          │                 │                                                │
│          └────────┬────────┘                                                │
│                   ▼                                                         │
│              ┌────────┐                                                     │
│              │ Uzel C │                                                     │
│              └────────┘                                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Konfigurace seeds

Seeds se specifikují jako NodeId řetězce:

```typescript
// Uzel 1: První uzel (seed uzel)
await Cluster.start({
  nodeName: 'seed1',
  port: 4369,
  seeds: [],  // Žádné seeds - toto je první uzel
});

// Uzel 2: Připojuje se přes seed1
await Cluster.start({
  nodeName: 'worker1',
  port: 4370,
  seeds: ['seed1@192.168.1.10:4369'],
});

// Uzel 3: Může se připojit přes libovolný existující uzel
await Cluster.start({
  nodeName: 'worker2',
  port: 4371,
  seeds: ['worker1@192.168.1.11:4370'],  // Nemusí znát seed1
});
```

### Best practices pro seed uzly

1. **Více seeds pro redundanci**: Pokud je jeden seed down, nové uzly se mohou připojit přes ostatní
2. **Seeds nemusí být speciální**: Libovolný uzel může být seed
3. **Ne všechny uzly potřebují seeds**: Gossip protokol objevuje uzly automaticky
4. **Seeds jsou pouze pro počáteční připojení**: Jakmile je uzel připojen, objevuje ostatní přes heartbeaty

```typescript
// Produkční konfigurace s více seeds
await Cluster.start({
  nodeName: 'api-server-3',
  port: 4369,
  seeds: [
    'api-server-1@10.0.1.10:4369',
    'api-server-2@10.0.1.11:4369',
  ],
});
```

## Heartbeat mechanismus

Heartbeaty jsou pulzem clusteru — periodické zprávy, které dokazují, že uzel žije a sdílejí informace o členství.

### Jak heartbeaty fungují

```typescript
interface HeartbeatMessage {
  type: 'heartbeat';
  nodeInfo: NodeInfo;      // Aktuální stav odesílatele
  knownNodes: NodeId[];    // Gossip: seznam uzlů, které známe
}
```

Každý heartbeat obsahuje:
- **nodeInfo**: Aktuální status odesílatele (id, host, port, počet procesů, uptime)
- **knownNodes**: Všechny uzly, které odesílatel zná (gossip protokol)

### Detekce selhání

Cluster detekuje selhání uzlů prostřednictvím timeoutů heartbeatů:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         HEARTBEAT DETEKCE SELHÁNÍ                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  heartbeatIntervalMs = 5000ms (výchozí)                                     │
│  heartbeatMissThreshold = 3 (výchozí)                                       │
│  failureTimeout = 5000 × 3 = 15000ms                                        │
│                                                                             │
│  Uzel A posílá heartbeaty Uzlu B:                                           │
│                                                                             │
│  Čas:    0s        5s        10s       15s       20s                        │
│          │         │         │         │         │                          │
│          ▼         ▼         ▼         ▼         ▼                          │
│         [HB]─────►[HB]─────►[HB]─────►[HB]─────►[HB]                        │
│                                                                             │
│  Scénář 1: Normální provoz                                                  │
│  Uzel B přijímá heartbeaty → resetuje timeout → Uzel A je "connected"       │
│                                                                             │
│  Scénář 2: Uzel A spadne v 7s                                               │
│                                                                             │
│  Čas:    0s        5s        10s       15s       20s       22s              │
│          │         │         │         │         │         │                │
│          ▼         ▼         ▼         ▼         ▼         ▼                │
│         [HB]─────►[HB]       ✗         ✗         ✗      [TIMEOUT]           │
│                    │         │         │         │         │                │
│                    │         │ miss 1  │ miss 2  │ miss 3  │                │
│                    └─────────┴─────────┴─────────┴─────────┘                │
│                                                                             │
│  Po 3 zmeškaných heartbeatech (15s od posledního HB):                       │
│  → NodeDown event vyslán s důvodem 'heartbeat_timeout'                      │
│  → Uzel A označen jako 'disconnected'                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Konfigurace časování heartbeatů

Upravte nastavení heartbeatů podle vaší sítě a požadavků:

```typescript
// Rychlá detekce selhání (pro nízko-latentní sítě)
await Cluster.start({
  nodeName: 'realtime-node',
  port: 4369,
  heartbeatIntervalMs: 1000,     // 1 sekunda
  heartbeatMissThreshold: 2,     // Down po 2 sekundách
});

// Tolerantní k síťovým problémům (pro nespolehlivé sítě)
await Cluster.start({
  nodeName: 'remote-node',
  port: 4369,
  heartbeatIntervalMs: 10000,    // 10 sekund
  heartbeatMissThreshold: 5,     // Down po 50 sekundách
});
```

| Nastavení | Nízká latence | Vyvážené (výchozí) | Vysoká tolerance |
|-----------|---------------|-------------------|------------------|
| `heartbeatIntervalMs` | 1000 | 5000 | 10000 |
| `heartbeatMissThreshold` | 2 | 3 | 5 |
| Detekce selhání | 2s | 15s | 50s |
| Síťová režie | Vyšší | Střední | Nižší |

## Lifecycle eventy uzlů

Cluster vysílá eventy, když se uzly připojují nebo odpojují:

```typescript
import { Cluster, type NodeInfo, type NodeId, type NodeDownReason } from '@hamicek/noex/distribution';

// Uzel se připojil ke clusteru
const unsubUp = Cluster.onNodeUp((node: NodeInfo) => {
  console.log(`Uzel se připojil: ${node.id}`);
  console.log(`  Host: ${node.host}:${node.port}`);
  console.log(`  Procesy: ${node.processCount}`);
  console.log(`  Uptime: ${node.uptimeMs}ms`);
});

// Uzel opustil cluster
const unsubDown = Cluster.onNodeDown((nodeId: NodeId, reason: NodeDownReason) => {
  console.log(`Uzel odešel: ${nodeId}`);
  console.log(`  Důvod: ${reason}`);

  switch (reason) {
    case 'heartbeat_timeout':
      console.log('  Uzel přestal odpovídat (pád nebo síťový problém)');
      break;
    case 'connection_closed':
      console.log('  TCP spojení bylo uzavřeno');
      break;
    case 'connection_refused':
      console.log('  Nelze se připojit k uzlu');
      break;
    case 'graceful_shutdown':
      console.log('  Uzel se gracefully vypnul');
      break;
  }
});

// Stav clusteru se změnil
const unsubStatus = Cluster.onStatusChange((status) => {
  console.log(`Stav clusteru: ${status}`);
});

// Úklid po dokončení
unsubUp();
unsubDown();
unsubStatus();
```

### Typy NodeDownReason

| Důvod | Popis | Typická příčina |
|-------|-------|-----------------|
| `heartbeat_timeout` | Žádný heartbeat po N×interval | Pád procesu, síťová partition |
| `connection_closed` | TCP spojení ukončeno | Graceful shutdown probíhá |
| `connection_refused` | Nelze navázat spojení | Uzel nespuštěn, firewall |
| `graceful_shutdown` | Uzel zavolal Cluster.stop() | Plánované vypnutí |

## Dotazování stavu clusteru

Dotazujte aktuální stav clusteru kdykoliv:

```typescript
// Získat info o lokálním uzlu
const localId = Cluster.getLocalNodeId();
const localInfo = Cluster.getLocalNodeInfo();

console.log(`Lokální uzel: ${localId}`);
console.log(`  Status: ${localInfo.status}`);
console.log(`  Uptime: ${localInfo.uptimeMs}ms`);

// Získat všechny známé uzly (včetně odpojených)
const allNodes = Cluster.getNodes();
console.log(`Známé uzly: ${allNodes.length}`);

// Získat pouze připojené uzly
const connectedNodes = Cluster.getConnectedNodes();
console.log(`Připojené uzly: ${connectedNodes.length}`);

// Zkontrolovat konkrétní uzel
const nodeId = NodeId.parse('worker1@192.168.1.11:4370');
if (Cluster.isNodeConnected(nodeId)) {
  const nodeInfo = Cluster.getNode(nodeId);
  console.log(`Worker1 procesy: ${nodeInfo?.processCount}`);
}

// Rychlý počet
const count = Cluster.getConnectedNodeCount();
console.log(`${count} uzlů online`);

// Uptime lokálního clusteru
const uptime = Cluster.getUptimeMs();
console.log(`Cluster běží ${uptime}ms`);
```

### Struktura NodeInfo

```typescript
interface NodeInfo {
  readonly id: NodeId;           // Identifikátor uzlu
  readonly host: string;         // Host adresa
  readonly port: number;         // Číslo portu
  readonly status: 'connecting' | 'connected' | 'disconnected';
  readonly processCount: number; // Počet procesů na uzlu
  readonly lastHeartbeatAt: number;  // Unix timestamp posledního heartbeatu
  readonly uptimeMs: number;     // Reportovaný uptime uzlu
}
```

## Zabezpečení clusteru

Ve výchozím nastavení je komunikace clusteru nešifrovaná a neautentizovaná. Pro produkci byste měli:

### 1. Použít Cluster Secret

Volba `clusterSecret` povolí HMAC-SHA256 autentizaci na všech zprávách:

```typescript
// Všechny uzly musí použít stejné tajemství
await Cluster.start({
  nodeName: 'secure-node',
  port: 4369,
  clusterSecret: process.env.CLUSTER_SECRET,  // např. 'my-super-secret-key'
});
```

Když je povoleno:
- Všechny zprávy jsou podepsány HMAC-SHA256
- Zprávy s neplatnými podpisy jsou odmítnuty
- Uzly bez tajemství se nemohou připojit

### 2. Síťová izolace

Doporučené postupy síťového zabezpečení:

```typescript
// Binding pouze na privátní rozhraní
await Cluster.start({
  nodeName: 'internal-node',
  host: '10.0.0.5',  // Privátní IP, ne 0.0.0.0
  port: 4369,
  clusterSecret: process.env.CLUSTER_SECRET,
});
```

- **Privátní VLAN**: Provozujte cluster traffic na izolované síti
- **Firewall**: Povolte port 4369 pouze ze známých cluster IP
- **VPN**: Použijte VPN pro komunikaci mezi datacentry

### Příklad bezpečnostní konfigurace

```typescript
import { Cluster } from '@hamicek/noex/distribution';

// Produkční bezpečnostní konfigurace
await Cluster.start({
  nodeName: process.env.NODE_NAME!,
  host: process.env.CLUSTER_HOST || '10.0.0.5',
  port: parseInt(process.env.CLUSTER_PORT || '4369'),
  seeds: process.env.CLUSTER_SEEDS?.split(',') || [],
  clusterSecret: process.env.CLUSTER_SECRET,
  heartbeatIntervalMs: 5000,
  heartbeatMissThreshold: 3,
});

// Ověření, že cluster secret je nastaven v produkci
if (process.env.NODE_ENV === 'production' && !process.env.CLUSTER_SECRET) {
  console.warn('VAROVÁNÍ: Běh v produkci bez CLUSTER_SECRET!');
}
```

## Zastavení clusteru

Graceful shutdown notifikuje ostatní uzly před odpojením:

```typescript
// Graceful shutdown
await Cluster.stop();
// Ostatní uzly obdrží důvod 'graceful_shutdown'

// Zkontrolovat, zda už je zastaven
if (Cluster.getStatus() !== 'stopped') {
  await Cluster.stop();
}
```

Během graceful shutdown:
1. Status se změní na `'stopping'`
2. Notifikuje všechny připojené uzly
3. Uzavře TCP spojení
4. Zastaví heartbeat timer
5. Status se změní na `'stopped'`

## Praktický příklad: Tři-uzlový cluster

Sestavme kompletní příklad se třemi uzly, které se navzájem objeví:

```typescript
// cluster-node.ts
import { Cluster, NodeId, type NodeInfo } from '@hamicek/noex/distribution';

interface NodeConfig {
  name: string;
  port: number;
  seeds: string[];
}

async function startNode(config: NodeConfig): Promise<void> {
  console.log(`Spouštím uzel: ${config.name}`);

  // Nastavení event handlerů před startem
  Cluster.onNodeUp((node: NodeInfo) => {
    console.log(`[${config.name}] Uzel se připojil: ${node.id}`);
  });

  Cluster.onNodeDown((nodeId, reason) => {
    console.log(`[${config.name}] Uzel odešel: ${nodeId} (${reason})`);
  });

  Cluster.onStatusChange((status) => {
    console.log(`[${config.name}] Stav clusteru: ${status}`);
  });

  // Spuštění clusteru
  await Cluster.start({
    nodeName: config.name,
    port: config.port,
    seeds: config.seeds,
    heartbeatIntervalMs: 2000,  // Rychlejší pro demo
    heartbeatMissThreshold: 2,
  });

  console.log(`[${config.name}] Spuštěn jako ${Cluster.getLocalNodeId()}`);

  // Periodický report stavu
  setInterval(() => {
    const connected = Cluster.getConnectedNodes();
    console.log(`[${config.name}] Připojeno k ${connected.length} uzlům:`);
    for (const node of connected) {
      console.log(`  - ${node.id} (${node.processCount} procesů)`);
    }
  }, 10000);
}

// Parsování argumentů příkazové řádky
const args = process.argv.slice(2);
const name = args[0] || 'node1';
const port = parseInt(args[1] || '4369');
const seeds = args.slice(2);

startNode({ name, port, seeds }).catch(console.error);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nVypínám...');
  await Cluster.stop();
  process.exit(0);
});
```

Spusťte ve třech terminálech:

```bash
# Terminál 1: Seed uzel
npx tsx cluster-node.ts seed1 4369

# Terminál 2: Připojuje se přes seed1
npx tsx cluster-node.ts worker1 4370 seed1@localhost:4369

# Terminál 3: Připojuje se přes worker1 (objeví seed1 přes gossip)
npx tsx cluster-node.ts worker2 4371 worker1@localhost:4370
```

Očekávaný výstup:

```
# Terminál 1 (seed1)
Spouštím uzel: seed1
[seed1] Stav clusteru: starting
[seed1] Stav clusteru: running
[seed1] Spuštěn jako seed1@0.0.0.0:4369
[seed1] Uzel se připojil: worker1@0.0.0.0:4370
[seed1] Uzel se připojil: worker2@0.0.0.0:4371
[seed1] Připojeno k 2 uzlům:
  - worker1@0.0.0.0:4370 (0 procesů)
  - worker2@0.0.0.0:4371 (0 procesů)

# Terminál 2 (worker1)
Spouštím uzel: worker1
[worker1] Stav clusteru: starting
[worker1] Stav clusteru: running
[worker1] Spuštěn jako worker1@0.0.0.0:4370
[worker1] Uzel se připojil: seed1@0.0.0.0:4369
[worker1] Uzel se připojil: worker2@0.0.0.0:4371

# Terminál 3 (worker2)
Spouštím uzel: worker2
[worker2] Stav clusteru: starting
[worker2] Stav clusteru: running
[worker2] Spuštěn jako worker2@0.0.0.0:4371
[worker2] Uzel se připojil: worker1@0.0.0.0:4370
[worker2] Uzel se připojil: seed1@0.0.0.0:4369  # Objeven přes gossip!
```

## Zpracování chyb

Cluster vyhazuje specifické chyby pro konfigurační a runtime problémy:

```typescript
import {
  Cluster,
  ClusterNotStartedError,
  InvalidClusterConfigError,
} from '@hamicek/noex/distribution';

// Konfigurační chyby
try {
  await Cluster.start({
    nodeName: '123invalid',  // Neplatné: začíná číslem
    port: 99999,             // Neplatné: port mimo rozsah
  });
} catch (error) {
  if (error instanceof InvalidClusterConfigError) {
    console.error('Špatná konfigurace:', error.message);
  }
}

// Runtime chyby
try {
  const nodes = Cluster.getNodes();  // Voláno před start()
} catch (error) {
  if (error instanceof ClusterNotStartedError) {
    console.error('Cluster ještě není spuštěn');
  }
}

// Bezpečný vzor: nejprve zkontrolovat status
if (Cluster.getStatus() === 'running') {
  const nodes = Cluster.getNodes();
}
```

## Cvičení: Monitor zdraví clusteru

Sestavte systém monitorování zdraví clusteru, který sleduje dostupnost uzlů a reportuje stav clusteru.

**Požadavky:**

1. Spustit cluster uzel, který se může připojit k existujícím clusterům
2. Sledovat eventy připojení/odpojení uzlů s časovými razítky
3. Počítat a zobrazovat uptime clusteru
4. Zobrazit historii dostupnosti uzlů (posledních 5 eventů)
5. Reportovat celkový health status clusteru

**Startovní kód:**

```typescript
import { Cluster, NodeId, type NodeInfo, type NodeDownReason } from '@hamicek/noex/distribution';

interface NodeEvent {
  timestamp: number;
  nodeId: string;
  event: 'joined' | 'left';
  reason?: NodeDownReason;
}

interface ClusterHealth {
  status: 'healthy' | 'degraded' | 'critical';
  connectedNodes: number;
  totalKnownNodes: number;
  recentEvents: NodeEvent[];
  uptimeMs: number;
}

// TODO: Sledovat eventy
const eventHistory: NodeEvent[] = [];

// TODO: Přihlásit se k cluster eventům
function setupEventTracking(): void {
  // Cluster.onNodeUp(...)
  // Cluster.onNodeDown(...)
}

// TODO: Vypočítat zdraví clusteru
function getClusterHealth(): ClusterHealth {
  // Vrátit health status na základě:
  // - Poměru připojených vs známých uzlů
  // - Nedávných node down eventů
  // - Uptime clusteru
}

// TODO: Zobrazit health report
function printHealthReport(): void {
  // Vyčistit konzoli a vytisknout formátovaný report
}

// TODO: Spustit cluster s argumenty příkazové řádky
async function main(): Promise<void> {
  const name = process.argv[2] || 'monitor';
  const port = parseInt(process.argv[3] || '4369');
  const seeds = process.argv.slice(4);

  // Spustit cluster
  // Nastavit tracking
  // Periodické health reporty
}

main().catch(console.error);
```

<details>
<summary><strong>Řešení</strong></summary>

```typescript
import { Cluster, NodeId, type NodeInfo, type NodeDownReason } from '@hamicek/noex/distribution';

interface NodeEvent {
  timestamp: number;
  nodeId: string;
  event: 'joined' | 'left';
  reason?: NodeDownReason;
}

interface ClusterHealth {
  status: 'healthy' | 'degraded' | 'critical';
  connectedNodes: number;
  totalKnownNodes: number;
  recentEvents: NodeEvent[];
  uptimeMs: number;
  availabilityPercent: number;
}

// Historie eventů (uchovat posledních 100)
const eventHistory: NodeEvent[] = [];
const MAX_EVENTS = 100;

function addEvent(event: NodeEvent): void {
  eventHistory.push(event);
  if (eventHistory.length > MAX_EVENTS) {
    eventHistory.shift();
  }
}

function setupEventTracking(): void {
  Cluster.onNodeUp((node: NodeInfo) => {
    addEvent({
      timestamp: Date.now(),
      nodeId: node.id,
      event: 'joined',
    });
    console.log(`[EVENT] Uzel se připojil: ${node.id}`);
  });

  Cluster.onNodeDown((nodeId, reason) => {
    addEvent({
      timestamp: Date.now(),
      nodeId,
      event: 'left',
      reason,
    });
    console.log(`[EVENT] Uzel odešel: ${nodeId} (${reason})`);
  });
}

function getClusterHealth(): ClusterHealth {
  const connectedNodes = Cluster.getConnectedNodeCount();
  const allNodes = Cluster.getNodes();
  const totalKnownNodes = allNodes.length;
  const uptimeMs = Cluster.getUptimeMs();

  // Výpočet dostupnosti (připojených / celkem známých)
  const availabilityPercent = totalKnownNodes > 0
    ? Math.round((connectedNodes / totalKnownNodes) * 100)
    : 100;

  // Počet nedávných selhání (posledních 5 minut)
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  const recentFailures = eventHistory.filter(
    e => e.event === 'left' && e.timestamp > fiveMinutesAgo
  ).length;

  // Určení health statusu
  let status: 'healthy' | 'degraded' | 'critical';
  if (availabilityPercent >= 80 && recentFailures <= 1) {
    status = 'healthy';
  } else if (availabilityPercent >= 50 && recentFailures <= 3) {
    status = 'degraded';
  } else {
    status = 'critical';
  }

  return {
    status,
    connectedNodes,
    totalKnownNodes,
    recentEvents: eventHistory.slice(-5),
    uptimeMs,
    availabilityPercent,
  };
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function printHealthReport(): void {
  console.clear();

  const health = getClusterHealth();
  const localId = Cluster.getLocalNodeId();

  // Barvy statusu (ANSI)
  const statusColors: Record<string, string> = {
    healthy: '\x1b[32m',   // Zelená
    degraded: '\x1b[33m',  // Žlutá
    critical: '\x1b[31m',  // Červená
  };
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';
  const dim = '\x1b[2m';

  console.log(`${bold}═══════════════════════════════════════════════════════════════${reset}`);
  console.log(`${bold}                    MONITOR ZDRAVÍ CLUSTERU                     ${reset}`);
  console.log(`${bold}═══════════════════════════════════════════════════════════════${reset}`);
  console.log();

  // Info o lokálním uzlu
  console.log(`${bold}Lokální uzel${reset}`);
  console.log(`  ID:     ${localId}`);
  console.log(`  Uptime: ${formatUptime(health.uptimeMs)}`);
  console.log();

  // Status clusteru
  const statusColor = statusColors[health.status];
  console.log(`${bold}Status clusteru${reset}`);
  console.log(`  Zdraví:      ${statusColor}${health.status.toUpperCase()}${reset}`);
  console.log(`  Dostupnost:  ${health.availabilityPercent}%`);
  console.log(`  Připojeno:   ${health.connectedNodes} / ${health.totalKnownNodes} uzlů`);
  console.log();

  // Připojené uzly
  const connected = Cluster.getConnectedNodes();
  console.log(`${bold}Připojené uzly${reset}`);
  if (connected.length === 0) {
    console.log(`  ${dim}(žádné)${reset}`);
  } else {
    for (const node of connected) {
      const uptime = formatUptime(node.uptimeMs);
      console.log(`  - ${node.id}`);
      console.log(`    ${dim}procesy: ${node.processCount}, uptime: ${uptime}${reset}`);
    }
  }
  console.log();

  // Nedávné eventy
  console.log(`${bold}Nedávné eventy${reset}`);
  if (health.recentEvents.length === 0) {
    console.log(`  ${dim}(žádné eventy)${reset}`);
  } else {
    for (const event of health.recentEvents.reverse()) {
      const time = formatTimestamp(event.timestamp);
      const icon = event.event === 'joined' ? '\x1b[32m+\x1b[0m' : '\x1b[31m-\x1b[0m';
      const reason = event.reason ? ` (${event.reason})` : '';
      console.log(`  ${icon} [${time}] ${event.nodeId}${reason}`);
    }
  }
  console.log();

  console.log(`${dim}Poslední aktualizace: ${new Date().toISOString()} | Stiskněte Ctrl+C pro ukončení${reset}`);
}

async function main(): Promise<void> {
  const name = process.argv[2] || 'monitor';
  const port = parseInt(process.argv[3] || '4369');
  const seeds = process.argv.slice(4);

  console.log(`Spouštím monitor zdraví clusteru: ${name}`);
  console.log(`Port: ${port}`);
  console.log(`Seeds: ${seeds.length > 0 ? seeds.join(', ') : '(žádné)'}`);
  console.log();

  // Nastavit tracking před startem
  setupEventTracking();

  // Spustit cluster
  await Cluster.start({
    nodeName: name,
    port,
    seeds,
    heartbeatIntervalMs: 3000,
    heartbeatMissThreshold: 2,
  });

  console.log(`Cluster spuštěn jako ${Cluster.getLocalNodeId()}`);

  // Počáteční report po krátkém zpoždění
  setTimeout(printHealthReport, 1000);

  // Periodické health reporty
  setInterval(printHealthReport, 5000);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nVypínám monitor...');
    await Cluster.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

**Spuštění řešení:**

```bash
# Terminál 1: Spustit monitor jako seed
npx tsx health-monitor.ts monitor1 4369

# Terminál 2: Připojit se ke clusteru
npx tsx health-monitor.ts monitor2 4370 monitor1@localhost:4369

# Terminál 3: Další uzel
npx tsx health-monitor.ts monitor3 4371 monitor1@localhost:4369
```

**Ukázkový výstup:**

```
═══════════════════════════════════════════════════════════════
                    MONITOR ZDRAVÍ CLUSTERU
═══════════════════════════════════════════════════════════════

Lokální uzel
  ID:     monitor1@0.0.0.0:4369
  Uptime: 2m 15s

Status clusteru
  Zdraví:      HEALTHY
  Dostupnost:  100%
  Připojeno:   2 / 2 uzlů

Připojené uzly
  - monitor2@0.0.0.0:4370
    procesy: 0, uptime: 1m 45s
  - monitor3@0.0.0.0:4371
    procesy: 0, uptime: 30s

Nedávné eventy
  + [12:00:30] monitor3@0.0.0.0:4371
  + [12:00:00] monitor2@0.0.0.0:4370

Poslední aktualizace: 2024-01-25T12:02:15.000Z | Stiskněte Ctrl+C pro ukončení
```

</details>

## Shrnutí

**Klíčové poznatky:**

- **noex clustering** je peer-to-peer, ne master-worker jako Node.js cluster
- Formát **NodeId** je `název@host:port` se striktními validačními pravidly
- **Seed uzly** bootstrapují vyhledávání clusteru; gossip šíří členství
- **Heartbeaty** detekují selhání uzlů (výchozí: 15 sekund timeout)
- **Eventy** vás notifikují, když se uzly připojují (`onNodeUp`) nebo odpojují (`onNodeDown`)
- **clusterSecret** povoluje HMAC autentizaci pro zabezpečení

**Cluster API na první pohled:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PŘEHLED CLUSTER API                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ŽIVOTNÍ CYKLUS                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Cluster.start(config)     → Spustit a připojit se ke clusteru              │
│  Cluster.stop()            → Graceful shutdown                              │
│  Cluster.getStatus()       → 'starting' | 'running' | 'stopping' | 'stopped'│
│                                                                             │
│  IDENTITA UZLU                                                              │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Cluster.getLocalNodeId()      → Identifikátor tohoto uzlu                  │
│  Cluster.getLocalNodeInfo()    → Plné info o tomto uzlu                     │
│  Cluster.getUptimeMs()         → Jak dlouho cluster běží                    │
│                                                                             │
│  DOTAZY NA ČLENSTVÍ                                                         │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Cluster.getNodes()            → Všechny známé uzly (jakýkoliv status)      │
│  Cluster.getConnectedNodes()   → Pouze připojené uzly                       │
│  Cluster.getNode(nodeId)       → Info pro konkrétní uzel                    │
│  Cluster.isNodeConnected(id)   → Zkontrolovat, zda je uzel online           │
│  Cluster.getConnectedNodeCount() → Rychlý počet                             │
│                                                                             │
│  EVENT HANDLERY                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Cluster.onNodeUp(handler)     → Voláno při připojení uzlu                  │
│  Cluster.onNodeDown(handler)   → Voláno při odpojení uzlu                   │
│  Cluster.onStatusChange(handler) → Voláno při změnách statusu               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Rychlá reference konfigurace:**

| Nastavení | Výchozí | Popis |
|-----------|---------|-------|
| `nodeName` | povinné | Unikátní identifikátor uzlu |
| `host` | `'0.0.0.0'` | Bind adresa |
| `port` | `4369` | Listen port |
| `seeds` | `[]` | Seed uzly pro vyhledávání |
| `clusterSecret` | `undefined` | HMAC autentizační tajemství |
| `heartbeatIntervalMs` | `5000` | Frekvence heartbeatů |
| `heartbeatMissThreshold` | `3` | Zmeškaných heartbeatů před down |

**Pamatujte:**

> Clustering je základem distribuovaného noex. Jakmile se uzly mohou navzájem objevit a detekovat selhání, můžete na tom stavět — spouštět procesy vzdáleně, volat procesy napříč uzly a vytvářet skutečně fault-tolerantní distribuované systémy.

---

Další: [Vzdálené volání](./02-vzdalene-volani.md)
