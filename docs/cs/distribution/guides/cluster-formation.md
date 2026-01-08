# Formace clusteru

Tento návod pokrývá pokročilou konfiguraci clusteru: seed uzly, bezpečnost, heartbeaty a řešení problémů.

## Seed strategie

### Statické seedy

Nejjednodušší konfigurace s pevně danými adresami:

```typescript
await Cluster.start({
  nodeName: 'worker1',
  port: 4369,
  seeds: [
    'seed1@192.168.1.10:4369',
    'seed2@192.168.1.11:4369',
  ],
});
```

**Výhody:**
- Jednoduché nastavení
- Předvídatelné chování

**Nevýhody:**
- Manuální aktualizace při změnách
- Single point of failure pokud je jeden seed

### DNS-based discovery

Pro dynamické prostředí (Kubernetes, Docker Swarm):

```typescript
await Cluster.start({
  nodeName: process.env.POD_NAME || 'worker',
  seeds: [
    'noex-cluster-headless.default.svc.cluster.local:4369',
  ],
});
```

### První uzel jako seed

Bootstrap nového clusteru:

```typescript
const isFirstNode = process.env.CLUSTER_ROLE === 'seed';

await Cluster.start({
  nodeName: isFirstNode ? 'seed' : `worker-${process.pid}`,
  port: 4369,
  seeds: isFirstNode ? [] : ['seed@seed-host:4369'],
});
```

### Multi-seed redundance

Pro vysokou dostupnost:

```typescript
await Cluster.start({
  nodeName: 'worker',
  seeds: [
    'seed1@10.0.0.1:4369',
    'seed2@10.0.0.2:4369',
    'seed3@10.0.0.3:4369',
  ],
});
```

Uzel se připojí k prvnímu dostupnému seedu a přes gossip zjistí ostatní.

## Bezpečnost

### Cluster secret

**DŮLEŽITÉ:** Vždy používejte cluster secret v produkci!

```typescript
await Cluster.start({
  nodeName: 'secure-node',
  clusterSecret: process.env.CLUSTER_SECRET,
});
```

**Co secret chrání:**
- Neoprávněné připojení uzlů
- Podvržení zpráv
- Man-in-the-middle útoky

**Best practices:**
- Uchovávejte v bezpečném úložišti (Vault, K8s Secrets)
- Rotujte pravidelně
- Stejný secret na všech uzlech

### Síťová izolace

```yaml
# Kubernetes NetworkPolicy
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: noex-cluster-policy
spec:
  podSelector:
    matchLabels:
      app: noex-cluster
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: noex-cluster
      ports:
        - port: 4369
          protocol: TCP
```

## Konfigurace heartbeatů

### Rychlá detekce selhání

Pro kritické systémy kde je důležitá rychlá reakce:

```typescript
await Cluster.start({
  nodeName: 'critical-service',
  heartbeatIntervalMs: 2000,     // Heartbeat každé 2 sekundy
  heartbeatMissThreshold: 2,     // 2 zmeškaná = down
  // Detekce selhání za: 2s * 2 = 4 sekundy
});
```

### Tolerantní konfigurace

Pro nespolehlivé sítě nebo vysokou latenci:

```typescript
await Cluster.start({
  nodeName: 'remote-worker',
  heartbeatIntervalMs: 10000,    // Heartbeat každých 10 sekund
  heartbeatMissThreshold: 5,     // 5 zmeškaných = down
  // Detekce selhání za: 10s * 5 = 50 sekund
});
```

### Doporučená nastavení

| Prostředí | Interval | Threshold | Detekce |
|-----------|----------|-----------|---------|
| LAN/lokální | 3000ms | 3 | 9s |
| Kubernetes | 5000ms | 3 | 15s |
| Multi-region | 15000ms | 4 | 60s |
| Nespolehlivá síť | 10000ms | 5 | 50s |

## Reconnect strategie

### Exponenciální backoff

noex automaticky používá exponenciální backoff pro reconnect:

```typescript
await Cluster.start({
  nodeName: 'worker',
  reconnectBaseDelayMs: 1000,    // Začít na 1s
  reconnectMaxDelayMs: 30000,    // Max 30s
});

// Pokusy: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...
```

### Manuální reconnect logika

```typescript
Cluster.onNodeDown(async (nodeId, reason) => {
  if (reason === 'heartbeat_timeout') {
    console.log(`Uzel ${nodeId} timeout - bude automaticky reconnect`);
  } else if (reason === 'graceful_shutdown') {
    console.log(`Uzel ${nodeId} se vypnul - nebude reconnect`);
  }
});
```

## Události clusteru

### Kompletní handler

```typescript
// Node připojen
Cluster.onNodeUp((node) => {
  console.log(`[+] ${node.id}`);
  console.log(`    Status: ${node.status}`);
  console.log(`    Procesy: ${node.processCount}`);
  console.log(`    Uptime: ${node.uptimeMs}ms`);

  // Aplikační logika
  redistributeWork(node.id);
});

// Node odpojen
Cluster.onNodeDown((nodeId, reason) => {
  console.log(`[-] ${nodeId} (${reason})`);

  switch (reason) {
    case 'heartbeat_timeout':
      // Uzel pravděpodobně spadl
      triggerFailover(nodeId);
      break;
    case 'connection_closed':
      // Spojení uzavřeno (možná síťový problém)
      scheduleReconnect(nodeId);
      break;
    case 'graceful_shutdown':
      // Uzel se vypíná gracefully
      // Práce by měla být přerozepsána automaticky
      break;
  }
});

// Změna stavu clusteru
Cluster.onStatusChange((status) => {
  console.log(`Cluster status: ${status}`);

  if (status === 'running') {
    startAcceptingWork();
  } else if (status === 'stopping') {
    stopAcceptingNewWork();
  }
});
```

## Graceful shutdown

### Správné ukončení

```typescript
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\nPřijat ${signal}, začínám graceful shutdown...`);

  // 1. Přestaň přijímat novou práci
  stopAcceptingWork();

  // 2. Počkej na dokončení in-flight requestů
  await waitForInflightRequests(5000);

  // 3. Odregistruj služby
  for (const name of registeredServices) {
    await GlobalRegistry.unregister(name);
  }

  // 4. Zastav lokální servery
  for (const ref of localServers) {
    await GenServer.stop(ref);
  }

  // 5. Opusť cluster
  await Cluster.stop();

  console.log('Shutdown dokončen');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

## Diagnostika

### Kontrola stavu

```typescript
function printClusterStatus(): void {
  console.log('\n=== Cluster Status ===');
  console.log(`Status: ${Cluster.getStatus()}`);
  console.log(`Local ID: ${Cluster.getLocalNodeId()}`);
  console.log(`Uptime: ${Math.round(Cluster.getUptimeMs() / 1000)}s`);

  const nodes = Cluster.getNodes();
  console.log(`\nUzly (${nodes.length}):`);

  for (const node of nodes) {
    const ago = Date.now() - node.lastHeartbeatAt;
    console.log(`  ${node.id}:`);
    console.log(`    Status: ${node.status}`);
    console.log(`    Procesy: ${node.processCount}`);
    console.log(`    Poslední heartbeat: před ${Math.round(ago / 1000)}s`);
  }
}

// Periodická kontrola
setInterval(printClusterStatus, 30000);
```

### Časté problémy

#### Uzly se nepřipojují

**Symptom:** `getConnectedNodes()` vrací prázdné pole

**Kontrola:**
```typescript
// 1. Ověř formát seedů
const seeds = ['node@host:port']; // Správný formát

// 2. Ověř síťovou dostupnost
// nc -zv host port

// 3. Ověř cluster secret
// Všechny uzly musí mít stejný secret
```

#### Časté odpojování

**Symptom:** Uzly se opakovaně připojují a odpojují

**Řešení:**
```typescript
// Zvýšit toleranci
await Cluster.start({
  heartbeatIntervalMs: 10000,
  heartbeatMissThreshold: 5,
});
```

#### Memory leak

**Symptom:** Rostoucí paměť při dlouhém běhu

**Kontrola:**
```typescript
const stats = RemoteCall.getStats();
console.log(`Pending calls: ${stats.pendingCalls}`);
// Pokud roste → máte nevyřešené calls

const registryStats = GlobalRegistry.getStats();
console.log(`Registrations: ${registryStats.totalRegistrations}`);
// Pokud roste → nezapomeňte unregister
```

## Produkční checklist

- [ ] Cluster secret nastaven
- [ ] Vícero seed uzlů pro redundanci
- [ ] Heartbeat konfigurace odpovídá prostředí
- [ ] Graceful shutdown implementován
- [ ] Síťová izolace (firewall/NetworkPolicy)
- [ ] Monitoring a alerting nastaveny
- [ ] Logy strukturované (JSON)
- [ ] Health check endpoint

## Související

- [Cluster API Reference](../api/cluster.md) - Kompletní API
- [Cluster koncepty](../concepts/cluster.md) - Architektura
- [Produkční nasazení](./production-deployment.md) - Docker, Kubernetes

---

*[English version](../../../distribution/guides/cluster-formation.md)*
