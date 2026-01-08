# Cluster

Modul `Cluster` spravuje P2P formaci clusteru, zjišťování uzlů a udržování spojení. Poskytuje základ pro všechnu distribuovanou komunikaci v noex.

## Architektura

### P2P model

noex používá decentralizovaný P2P model kde každý uzel:

1. Naslouchá příchozím spojením
2. Aktivně se připojuje k seed uzlům
3. Sdílí informace o uzlech přes gossip protokol

```
      ┌───────────┐
      │   Seed    │
      │   Node    │
      └─────┬─────┘
            │ initial
            │ connect
    ┌───────┴───────┐
    │               │
┌───▼───┐       ┌───▼───┐
│ Node A│◄─────►│ Node B│
└───┬───┘ gossip└───┬───┘
    │               │
    └───────┬───────┘
            │
        ┌───▼───┐
        │ Node C│
        └───────┘
```

### Identifikace uzlů

Každý uzel je identifikován jedinečným NodeId ve formátu `name@host:port`:

```typescript
// Příklady NodeId
'app1@192.168.1.1:4369'
'worker-1@10.0.0.5:4370'
'coordinator@cluster.example.com:4369'
```

### Životní cyklus spojení

```
┌──────────────────────────────────────────────────────┐
│                    Stavy spojení                     │
│                                                      │
│  ┌────────────┐    connect    ┌────────────┐        │
│  │disconnected│──────────────►│ connecting │        │
│  └─────▲──────┘               └──────┬─────┘        │
│        │                             │              │
│        │ timeout/                    │ success      │
│        │ error                       │              │
│        │                             ▼              │
│        │                      ┌────────────┐        │
│        └──────────────────────│ connected  │        │
│                               └────────────┘        │
└──────────────────────────────────────────────────────┘
```

## Konfigurace

### ClusterConfig

```typescript
interface ClusterConfig {
  nodeName: string;           // Jméno tohoto uzlu
  host?: string;              // Host pro naslouchání (výchozí: '0.0.0.0')
  port?: number;              // Port (výchozí: 4369)
  seeds?: string[];           // Seed uzly pro připojení
  clusterSecret?: string;     // Sdílené tajemství pro autentizaci
  heartbeatIntervalMs?: number;      // Interval heartbeatů (výchozí: 5000)
  heartbeatMissThreshold?: number;   // Počet zmeškaných heartbeatů (výchozí: 3)
  reconnectBaseDelayMs?: number;     // Základní zpoždění pro reconnect (výchozí: 1000)
  reconnectMaxDelayMs?: number;      // Max zpoždění pro reconnect (výchozí: 30000)
}
```

### Příklad konfigurace

```typescript
await Cluster.start({
  nodeName: 'coordinator',
  port: 4369,
  seeds: [
    'worker1@192.168.1.10:4369',
    'worker2@192.168.1.11:4369',
  ],
  clusterSecret: process.env.CLUSTER_SECRET,
  heartbeatIntervalMs: 3000,
  heartbeatMissThreshold: 2,
});
```

## Seed uzly

### Účel seed uzlů

Seed uzly slouží jako vstupní body do clusteru:

- Nové uzly se připojují k seedům
- Seedům se dozvídají o ostatních uzlech
- Po připojení probíhá komunikace P2P

### Strategie seedů

**Statické seedy:**
```typescript
seeds: ['app1@10.0.0.1:4369', 'app2@10.0.0.2:4369']
```

**DNS-based seedy:**
```typescript
// Kubernetes headless service
seeds: ['noex-cluster-headless.default.svc.cluster.local:4369']
```

**Vlastní seed:**
```typescript
// První uzel bez seedů
await Cluster.start({ nodeName: 'seed', port: 4369 });

// Ostatní uzly se připojují k seedu
await Cluster.start({
  nodeName: 'worker1',
  seeds: ['seed@seed-host:4369'],
});
```

## Heartbeaty

### Mechanismus

1. Každý uzel pravidelně posílá heartbeat všem připojeným uzlům
2. Heartbeat obsahuje informace o uzlu (uptime, počet procesů, atd.)
3. Pokud uzel neobdrží heartbeat v očekávaném čase, započítá se miss
4. Po překročení `heartbeatMissThreshold` je uzel označen jako down

```
┌─────────────────────────────────────────────────────────────┐
│                    Heartbeat timeline                        │
│                                                             │
│  Node A ──●────●────●────●────●────●────●──►                │
│           │    │    │    │    │    │    │                   │
│  Node B ◄─┴────┴────┴────X────X────X────┴──► (Node A down) │
│                          │    │    │                        │
│                        miss  miss  miss                     │
│                                    │                        │
│                              threshold reached              │
└─────────────────────────────────────────────────────────────┘
```

### Konfigurace

```typescript
// Rychlá detekce selhání (15 sekund)
await Cluster.start({
  heartbeatIntervalMs: 5000,
  heartbeatMissThreshold: 3,
});

// Tolerantní k síťovým výkyvům (45 sekund)
await Cluster.start({
  heartbeatIntervalMs: 15000,
  heartbeatMissThreshold: 3,
});
```

## Gossip protokol

### Jak funguje

Uzly sdílejí informace o ostatních uzlech přes gossip protokol:

1. Uzel A se připojí k seedu B
2. B sdílí svůj seznam známých uzlů s A
3. A se připojuje k novým uzlům
4. Proces se opakuje dokud všechny uzly neznají všechny ostatní

```
Čas 0:  A ─── B (A zná B)
              │
              C (B zná B, C)

Čas 1:  A ─── B (B sdílí C s A)
        │     │
        └─────C (A se připojí k C)

Čas 2:  A ─── B
        │╲   │
        │ ╲  │
        │  ╲ │
        └───╲C (Plně propojeno)
```

## Události clusteru

### NodeUp

Emitováno když se uzel připojí:

```typescript
Cluster.onNodeUp((node) => {
  console.log(`Uzel připojen: ${node.id}`);
  console.log(`  Status: ${node.status}`);
  console.log(`  Procesy: ${node.processCount}`);
  console.log(`  Uptime: ${node.uptimeMs}ms`);
});
```

### NodeDown

Emitováno když uzel odpojí nebo timeout:

```typescript
Cluster.onNodeDown((nodeId, reason) => {
  console.log(`Uzel odpojen: ${nodeId}`);
  console.log(`  Důvod: ${reason}`);
  // reason může být: 'heartbeat_timeout', 'connection_closed',
  //                  'connection_refused', 'graceful_shutdown'
});
```

### StatusChange

Emitováno při změně stavu clusteru:

```typescript
Cluster.onStatusChange((status) => {
  console.log(`Status clusteru: ${status}`);
  // status může být: 'starting', 'running', 'stopping', 'stopped'
});
```

## Bezpečnost

### Cluster secret

Sdílené tajemství pro HMAC autentizaci zpráv:

```typescript
await Cluster.start({
  nodeName: 'secure-node',
  clusterSecret: process.env.CLUSTER_SECRET,
});
```

**Důležité:**
- Všechny uzly v clusteru musí mít stejný secret
- Bez secretu může kdokoliv připojit vlastní uzel
- Secret chrání před:
  - Neoprávněným připojením
  - Podvržením zpráv
  - Man-in-the-middle útoky

### Doporučení

1. Vždy používejte `clusterSecret` v produkci
2. Uchovávejte secret v bezpečném úložišti (Vault, K8s Secrets)
3. Pravidelně rotujte secrety
4. Používejte síťovou izolaci (VPC, Network Policies)

## Graceful shutdown

```typescript
// Správné ukončení clusteru
process.on('SIGTERM', async () => {
  console.log('Ukončuji cluster...');

  // Cluster.stop() udělá:
  // 1. Broadcast graceful_shutdown ostatním uzlům
  // 2. Zastaví heartbeaty
  // 3. Uzavře všechna spojení
  // 4. Vyčistí zdroje
  await Cluster.stop();

  console.log('Cluster ukončen');
  process.exit(0);
});
```

## Statistiky a ladění

```typescript
// Základní informace
console.log(`Status: ${Cluster.getStatus()}`);
console.log(`Lokální ID: ${Cluster.getLocalNodeId()}`);
console.log(`Uptime: ${Cluster.getUptimeMs()}ms`);

// Informace o uzlech
const nodes = Cluster.getConnectedNodes();
console.log(`Připojených uzlů: ${nodes.length}`);

for (const node of nodes) {
  console.log(`  ${node.id}:`);
  console.log(`    Status: ${node.status}`);
  console.log(`    Procesy: ${node.processCount}`);
  console.log(`    Poslední heartbeat: ${new Date(node.lastHeartbeatAt)}`);
}
```

## Související

- [Cluster API Reference](../api/cluster.md) - Kompletní API
- [Formace clusteru (návod)](../guides/cluster-formation.md) - Praktický návod
- [Produkční nasazení](../guides/production-deployment.md) - Docker, Kubernetes

---

*[English version](../../../distribution/concepts/cluster.md)*
