# Cluster API Reference

Singleton `Cluster` spravuje životní cyklus clusteru a poskytuje základ pro distribuovanou komunikaci mezi uzly v P2P síti.

## Import

```typescript
import { Cluster } from 'noex/distribution';
```

## Typy

### ClusterConfig

Konfigurace pro spuštění cluster uzlu.

```typescript
interface ClusterConfig {
  readonly nodeName: string;
  readonly host?: string;
  readonly port?: number;
  readonly seeds?: readonly string[];
  readonly clusterSecret?: string;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatMissThreshold?: number;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
}
```

| Pole | Typ | Výchozí | Popis |
|------|-----|---------|-------|
| `nodeName` | `string` | povinné | Čitelné jméno uzlu (např. `app1` v `app1@host:port`) |
| `host` | `string` | `'0.0.0.0'` | Host adresa pro naslouchání |
| `port` | `number` | `4369` | TCP port pro cluster komunikaci |
| `seeds` | `readonly string[]` | `[]` | Seed uzly pro iniciální discovery (formát: `name@host:port`) |
| `clusterSecret` | `string` | - | Sdílené tajemství pro HMAC autentizaci zpráv |
| `heartbeatIntervalMs` | `number` | `5000` | Interval mezi heartbeaty |
| `heartbeatMissThreshold` | `number` | `3` | Zmeškaných heartbeatů před označením uzlu jako down |
| `reconnectBaseDelayMs` | `number` | `1000` | Počáteční zpoždění pro reconnect |
| `reconnectMaxDelayMs` | `number` | `30000` | Maximální zpoždění pro reconnect |

### NodeId

Branded string typ reprezentující unikátní identifikátor uzlu ve formátu `name@host:port`.

```typescript
type NodeId = string & { readonly __brand: 'NodeId' };
```

Namespace `NodeId` poskytuje utility pro práci s identifikátory:

```typescript
// Parse ze stringu
const nodeId = NodeId.parse('app1@192.168.1.1:4369');

// Vytvoření z komponent
const nodeId = NodeId.create('app1', '192.168.1.1', 4369);

// Validace
const isValid = NodeId.isValid('app1@192.168.1.1:4369'); // true
```

### NodeInfo

Informace o uzlu v clusteru.

```typescript
interface NodeInfo {
  readonly id: NodeId;
  readonly host: string;
  readonly port: number;
  readonly status: NodeStatus;
  readonly processCount: number;
  readonly lastHeartbeatAt: number;
  readonly uptimeMs: number;
}
```

| Pole | Typ | Popis |
|------|-----|-------|
| `id` | `NodeId` | Unikátní identifikátor uzlu |
| `host` | `string` | Host adresa uzlu |
| `port` | `number` | TCP port uzlu |
| `status` | `NodeStatus` | Aktuální stav spojení |
| `processCount` | `number` | Počet GenServer procesů na uzlu |
| `lastHeartbeatAt` | `number` | Unix timestamp posledního heartbeatu |
| `uptimeMs` | `number` | Uptime uzlu v milisekundách |

### NodeStatus

Stav spojení uzlu v clusteru.

```typescript
type NodeStatus = 'connecting' | 'connected' | 'disconnected';
```

| Status | Popis |
|--------|-------|
| `'connecting'` | Probíhá pokus o připojení |
| `'connected'` | Aktivně komunikuje s úspěšnými heartbeaty |
| `'disconnected'` | Spojení ztraceno, probíhá reconnect |

### ClusterStatus

Aktuální stav lokálního uzlu v clusteru.

```typescript
type ClusterStatus = 'starting' | 'running' | 'stopping' | 'stopped';
```

### NodeDownReason

Důvody proč uzel může být označen jako down.

```typescript
type NodeDownReason =
  | 'heartbeat_timeout'
  | 'connection_closed'
  | 'connection_refused'
  | 'graceful_shutdown';
```

---

## Metody

### start()

Spustí cluster uzel.

```typescript
async start(config: ClusterConfig): Promise<void>
```

**Parametry:**
- `config` - Konfigurace clusteru

**Vyhodí:**
- `InvalidClusterConfigError` - Pokud je konfigurace neplatná
- `Error` - Pokud cluster již běží

**Příklad:**
```typescript
await Cluster.start({
  nodeName: 'app1',
  port: 4369,
  seeds: ['app2@192.168.1.2:4369'],
  clusterSecret: 'my-secure-secret',
});
```

---

### stop()

Gracefully zastaví cluster uzel.

```typescript
async stop(): Promise<void>
```

Broadcast node_down zprávu ostatním uzlům, zastaví heartbeaty, odpojí od všech uzlů a vyčistí zdroje.

**Příklad:**
```typescript
await Cluster.stop();
```

---

### getStatus()

Vrátí aktuální stav clusteru.

```typescript
getStatus(): ClusterStatus
```

**Vrací:** Aktuální stav (`'starting'`, `'running'`, `'stopping'`, nebo `'stopped'`)

**Příklad:**
```typescript
if (Cluster.getStatus() === 'running') {
  console.log('Cluster je aktivní');
}
```

---

### getLocalNodeId()

Vrátí identifikátor lokálního uzlu.

```typescript
getLocalNodeId(): NodeId
```

**Vrací:** Identifikátor lokálního uzlu

**Vyhodí:**
- `ClusterNotStartedError` - Pokud cluster neběží

**Příklad:**
```typescript
const localId = Cluster.getLocalNodeId();
console.log(`Tento uzel: ${localId}`); // např. "app1@192.168.1.1:4369"
```

---

### getLocalNodeInfo()

Vrátí informace o lokálním uzlu.

```typescript
getLocalNodeInfo(): NodeInfo
```

**Vrací:** NodeInfo pro lokální uzel

**Vyhodí:**
- `ClusterNotStartedError` - Pokud cluster neběží

---

### getNodes()

Vrátí informace o všech známých uzlech v clusteru.

```typescript
getNodes(): readonly NodeInfo[]
```

**Vrací:** Pole všech známých uzlů (včetně odpojených)

**Vyhodí:**
- `ClusterNotStartedError` - Pokud cluster neběží

**Příklad:**
```typescript
const nodes = Cluster.getNodes();
for (const node of nodes) {
  console.log(`${node.id}: ${node.status}`);
}
```

---

### getConnectedNodes()

Vrátí informace pouze o připojených uzlech.

```typescript
getConnectedNodes(): readonly NodeInfo[]
```

**Vrací:** Pole aktuálně připojených uzlů

**Vyhodí:**
- `ClusterNotStartedError` - Pokud cluster neběží

**Příklad:**
```typescript
const connected = Cluster.getConnectedNodes();
console.log(`${connected.length} uzlů online`);
```

---

### getNode()

Vrátí informace o konkrétním uzlu.

```typescript
getNode(nodeId: NodeId): NodeInfo | undefined
```

**Parametry:**
- `nodeId` - Identifikátor uzlu

**Vrací:** NodeInfo pokud nalezen, jinak undefined

---

### isNodeConnected()

Zkontroluje zda je uzel aktuálně připojen.

```typescript
isNodeConnected(nodeId: NodeId): boolean
```

**Parametry:**
- `nodeId` - Identifikátor uzlu

**Vrací:** `true` pokud je uzel připojen

---

### getConnectedNodeCount()

Vrátí počet připojených uzlů.

```typescript
getConnectedNodeCount(): number
```

**Vrací:** Počet aktuálně připojených uzlů

---

### getUptimeMs()

Vrátí uptime clusteru v milisekundách.

```typescript
getUptimeMs(): number
```

**Vrací:** Milisekundy od spuštění clusteru

---

### onNodeUp()

Registruje handler pro události připojení uzlu.

```typescript
onNodeUp(handler: NodeUpHandler): () => void
```

**Parametry:**
- `handler` - Funkce volaná při připojení uzlu: `(node: NodeInfo) => void`

**Vrací:** Funkce pro odhlášení

**Příklad:**
```typescript
const unsubscribe = Cluster.onNodeUp((node) => {
  console.log(`Uzel připojen: ${node.id}`);
});

// Později
unsubscribe();
```

---

### onNodeDown()

Registruje handler pro události odpojení uzlu.

```typescript
onNodeDown(handler: NodeDownHandler): () => void
```

**Parametry:**
- `handler` - Funkce volaná při odpojení uzlu: `(nodeId: NodeId, reason: NodeDownReason) => void`

**Vrací:** Funkce pro odhlášení

**Příklad:**
```typescript
const unsubscribe = Cluster.onNodeDown((nodeId, reason) => {
  console.log(`Uzel odpojen: ${nodeId}, důvod: ${reason}`);
});
```

---

### onStatusChange()

Registruje handler pro změny stavu clusteru.

```typescript
onStatusChange(handler: ClusterStatusHandler): () => void
```

**Parametry:**
- `handler` - Funkce volaná při změně stavu: `(status: ClusterStatus) => void`

**Vrací:** Funkce pro odhlášení

---

## Chybové třídy

### ClusterNotStartedError

```typescript
class ClusterNotStartedError extends Error {
  readonly name = 'ClusterNotStartedError';
}
```

Vyhodí se při pokusu použít cluster funkcionalitu před voláním `Cluster.start()`.

### InvalidClusterConfigError

```typescript
class InvalidClusterConfigError extends Error {
  readonly name = 'InvalidClusterConfigError';
  readonly reason: string;
}
```

Vyhodí se když je konfigurace clusteru neplatná.

---

## Konstanty

### CLUSTER_DEFAULTS

Výchozí hodnoty pro konfiguraci clusteru.

```typescript
const CLUSTER_DEFAULTS = {
  HOST: '0.0.0.0',
  PORT: 4369,
  HEARTBEAT_INTERVAL_MS: 5000,
  HEARTBEAT_MISS_THRESHOLD: 3,
  RECONNECT_BASE_DELAY_MS: 1000,
  RECONNECT_MAX_DELAY_MS: 30000,
  PROTOCOL_VERSION: 1,
} as const;
```

---

## Kompletní příklad

```typescript
import { Cluster, NodeId } from 'noex/distribution';

async function main() {
  // Start clusteru
  await Cluster.start({
    nodeName: 'coordinator',
    port: 4369,
    seeds: ['worker1@192.168.1.10:4369', 'worker2@192.168.1.11:4369'],
    clusterSecret: process.env.CLUSTER_SECRET,
    heartbeatIntervalMs: 3000,
    heartbeatMissThreshold: 2,
  });

  console.log(`Spuštěn jako ${Cluster.getLocalNodeId()}`);

  // Sledování událostí clusteru
  Cluster.onNodeUp((node) => {
    console.log(`Uzel připojen: ${node.id} (${node.processCount} procesů)`);
  });

  Cluster.onNodeDown((nodeId, reason) => {
    console.log(`Uzel odpojen: ${nodeId} (${reason})`);
  });

  // Počkej na spojení
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Kontrola stavu clusteru
  const nodes = Cluster.getConnectedNodes();
  console.log(`Připojeno k ${nodes.length} uzlům:`);
  for (const node of nodes) {
    console.log(`  - ${node.id}: uptime ${Math.round(node.uptimeMs / 1000)}s`);
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Ukončuji...');
    await Cluster.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Související

- [Cluster koncepty](../concepts/cluster.md) - Pochopení formace clusteru
- [RemoteCall API](./remote-call.md) - Mezinodová komunikace
- [GlobalRegistry API](./global-registry.md) - Cluster-wide pojmenování
- [Typy Reference](./types.md) - Všechny distribuční typy

---

*[English version](../../../distribution/api/cluster.md)*
