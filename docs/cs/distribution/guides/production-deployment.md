# Produkční nasazení

Tento návod pokrývá nasazení distribuovaných noex aplikací v produkčním prostředí: Docker kontejnery, Kubernetes orchestrace, health checks, monitoring a operační best practices.

## Docker deployment

### Základní Dockerfile

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Kopírování package souborů pro layer caching
COPY package*.json ./
RUN npm ci --only=production

# Kopírování aplikačního kódu
COPY dist/ ./dist/
COPY shared/ ./shared/

# Exponování cluster portu
EXPOSE 4369

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

# Spuštění jako non-root user
USER node

CMD ["node", "dist/node.js"]
```

### Docker Compose pro lokální testování

```yaml
# docker-compose.yml
version: '3.8'

services:
  seed:
    build: .
    environment:
      - NODE_NAME=seed
      - CLUSTER_PORT=4369
      - HEALTH_PORT=8080
      - CLUSTER_SECRET=${CLUSTER_SECRET}
    ports:
      - "4369:4369"
      - "8081:8080"
    networks:
      - cluster-network

  worker-1:
    build: .
    environment:
      - NODE_NAME=worker1
      - CLUSTER_PORT=4369
      - HEALTH_PORT=8080
      - CLUSTER_SEEDS=seed@seed:4369
      - CLUSTER_SECRET=${CLUSTER_SECRET}
    depends_on:
      - seed
    networks:
      - cluster-network

  worker-2:
    build: .
    environment:
      - NODE_NAME=worker2
      - CLUSTER_PORT=4369
      - HEALTH_PORT=8080
      - CLUSTER_SEEDS=seed@seed:4369
      - CLUSTER_SECRET=${CLUSTER_SECRET}
    depends_on:
      - seed
    networks:
      - cluster-network

networks:
  cluster-network:
    driver: bridge
```

### Entry point script

```typescript
// src/node.ts
import { Cluster, BehaviorRegistry } from 'noex/distribution';
import { createServer, type Server } from 'http';

// Konfigurace z prostředí
const config = {
  nodeName: process.env.NODE_NAME || `worker-${process.pid}`,
  clusterPort: parseInt(process.env.CLUSTER_PORT || '4369', 10),
  healthPort: parseInt(process.env.HEALTH_PORT || '8080', 10),
  seeds: process.env.CLUSTER_SEEDS?.split(',').filter(Boolean) || [],
  clusterSecret: process.env.CLUSTER_SECRET,
};

let healthServer: Server;

function startHealthServer(): void {
  healthServer = createServer((req, res) => {
    if (req.url === '/health') {
      const status = Cluster.getStatus();
      const healthy = status === 'running';

      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status,
        nodeId: healthy ? Cluster.getLocalNodeId() : null,
        connectedNodes: healthy ? Cluster.getConnectedNodeCount() : 0,
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    if (req.url === '/ready') {
      // Readiness: cluster běží A alespoň jeden uzel připojen (pokud máme seedy)
      const ready = Cluster.getStatus() === 'running' &&
                   (config.seeds.length === 0 || Cluster.getConnectedNodeCount() > 0);

      res.writeHead(ready ? 200 : 503);
      res.end(ready ? 'ready' : 'not ready');
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  healthServer.listen(config.healthPort, '0.0.0.0', () => {
    console.log(`Health endpoint: http://0.0.0.0:${config.healthPort}/health`);
  });
}

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\nPřijat ${signal}, začínám graceful shutdown...`);

  if (healthServer) {
    healthServer.close();
  }

  // Počkej na dokončení in-flight požadavků
  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log('Opouštím cluster...');
  await Cluster.stop();

  console.log('Shutdown dokončen');
  process.exit(0);
}

async function main(): Promise<void> {
  console.log(`Spouštím uzel: ${config.nodeName}`);
  console.log(`Cluster port: ${config.clusterPort}`);
  console.log(`Seeds: ${config.seeds.length > 0 ? config.seeds.join(', ') : '(žádné - seed uzel)'}`);

  // Registrace behaviour PŘED startem clusteru
  // BehaviorRegistry.register('worker', workerBehavior);

  await Cluster.start({
    nodeName: config.nodeName,
    port: config.clusterPort,
    seeds: config.seeds,
    clusterSecret: config.clusterSecret,
  });

  console.log(`Uzel spuštěn: ${Cluster.getLocalNodeId()}`);

  startHealthServer();

  Cluster.onNodeUp((node) => {
    console.log(`[CLUSTER] Uzel připojen: ${node.id}`);
  });

  Cluster.onNodeDown((nodeId, reason) => {
    console.log(`[CLUSTER] Uzel odpojen: ${nodeId} (${reason})`);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
```

## Kubernetes deployment

### StatefulSet pro stabilní pojmenování

```yaml
# kubernetes/statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: noex-cluster
spec:
  serviceName: noex-cluster-headless
  replicas: 3
  selector:
    matchLabels:
      app: noex-cluster
  template:
    metadata:
      labels:
        app: noex-cluster
    spec:
      containers:
        - name: noex
          image: your-registry/noex-app:latest
          ports:
            - containerPort: 4369
              name: cluster
            - containerPort: 8080
              name: health
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: NODE_NAME
              value: "$(POD_NAME)"
            - name: CLUSTER_PORT
              value: "4369"
            - name: CLUSTER_SEEDS
              value: "noex-cluster-0.noex-cluster-headless:4369"
            - name: CLUSTER_SECRET
              valueFrom:
                secretKeyRef:
                  name: noex-secrets
                  key: cluster-secret
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
```

### Headless Service pro discovery

```yaml
# kubernetes/service-headless.yaml
apiVersion: v1
kind: Service
metadata:
  name: noex-cluster-headless
  labels:
    app: noex-cluster
spec:
  clusterIP: None
  selector:
    app: noex-cluster
  ports:
    - port: 4369
      targetPort: cluster
      name: cluster
```

### Secrets

```yaml
# kubernetes/secrets.yaml
apiVersion: v1
kind: Secret
metadata:
  name: noex-secrets
type: Opaque
data:
  # base64 encoded: echo -n 'your-secret-key' | base64
  cluster-secret: eW91ci1zZWNyZXQta2V5
```

### Network Policy

```yaml
# kubernetes/network-policy.yaml
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
    - ports:
        - port: 8080
          protocol: TCP
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: noex-cluster
      ports:
        - port: 4369
          protocol: TCP
    - to:
        - namespaceSelector: {}
      ports:
        - port: 53
          protocol: UDP
```

## Škálování

### Horizontal Pod Autoscaler

```yaml
# kubernetes/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: noex-cluster-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: StatefulSet
    name: noex-cluster
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

### Pod Disruption Budget

```yaml
# kubernetes/pdb.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: noex-cluster-pdb
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: noex-cluster
```

## Monitoring

### Prometheus metriky

```typescript
import { Cluster, RemoteCall, RemoteSpawn, RemoteMonitor } from 'noex/distribution';

function getMetrics(): string {
  const clusterStatus = Cluster.getStatus();
  const connectedNodes = clusterStatus === 'running' ? Cluster.getConnectedNodeCount() : 0;
  const remoteCallStats = RemoteCall.getStats();
  const remoteSpawnStats = RemoteSpawn.getStats();
  const monitorStats = RemoteMonitor.getStats();

  return `
# HELP noex_cluster_status Status clusteru (1=running, 0=other)
# TYPE noex_cluster_status gauge
noex_cluster_status ${clusterStatus === 'running' ? 1 : 0}

# HELP noex_connected_nodes Počet připojených uzlů
# TYPE noex_connected_nodes gauge
noex_connected_nodes ${connectedNodes}

# HELP noex_remote_calls_total Celkem vzdálených volání
# TYPE noex_remote_calls_total counter
noex_remote_calls_total ${remoteCallStats.totalCalls}

# HELP noex_remote_calls_pending Čekající vzdálená volání
# TYPE noex_remote_calls_pending gauge
noex_remote_calls_pending ${remoteCallStats.pendingCalls}

# HELP noex_remote_spawns_total Celkem vzdálených spawnů
# TYPE noex_remote_spawns_total counter
noex_remote_spawns_total ${remoteSpawnStats.totalInitiated}

# HELP noex_remote_monitors_active Aktivní vzdálené monitory
# TYPE noex_remote_monitors_active gauge
noex_remote_monitors_active ${monitorStats.activeOutgoingCount}
`.trim();
}

// Přidání do health serveru
if (req.url === '/metrics') {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(getMetrics());
  return;
}
```

### Strukturované logování

```typescript
function log(level: string, message: string, metadata: Record<string, unknown> = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    nodeId: Cluster.getStatus() === 'running' ? Cluster.getLocalNodeId() : null,
    message,
    ...metadata,
  };
  console.log(JSON.stringify(entry));
}

// Použití
log('info', 'Uzel spuštěn', { port: config.clusterPort });
log('warn', 'Uzel odpojen', { nodeId, reason });
log('error', 'Vzdálené volání selhalo', { targetNode, error: error.message });
```

## Security checklist

### Konfigurace

- [ ] `CLUSTER_SECRET` nastaven
- [ ] Secrets management (K8s Secrets, Vault)
- [ ] Pravidelná rotace secrets

### Síť

- [ ] Privátní sítě/VPC pro cluster traffic
- [ ] Network policies pro omezení přístupu
- [ ] Firewall pravidla pro cluster porty

### Kontejner

- [ ] Spuštění jako non-root user
- [ ] Read-only root filesystem kde možno
- [ ] Skenování images na zranitelnosti
- [ ] Aktuální base images

### Operace

- [ ] Audit logging
- [ ] Resource limits
- [ ] Pod security policies
- [ ] Pravidelné security reviews

## Troubleshooting

### Časté problémy

**Uzly se nepřipojují:**
- Zkontrolujte DNS resolution pro service names
- Ověřte network policies pro cluster port
- Zkontrolujte formát seedů: `name@host:port`

**Časté odpojování:**
- Zvyšte heartbeat timeout
- Zkontrolujte síťovou latenci
- Ověřte resource limits (CPU throttling ovlivňuje heartbeaty)

**Rostoucí paměť:**
- Monitorujte pending calls/spawns
- Kontrolujte neošetřené process_down events
- Sledujte velikost GlobalRegistry

### Debug příkazy

```bash
# Logy podu
kubectl logs -f noex-cluster-0

# DNS resolution
kubectl exec noex-cluster-0 -- nslookup noex-cluster-headless

# Cluster konektivita
kubectl exec noex-cluster-0 -- nc -zv noex-cluster-1.noex-cluster-headless 4369

# Health status
kubectl exec noex-cluster-0 -- wget -qO- http://localhost:8080/health
```

## Související

- [Formace clusteru](./cluster-formation.md) - Seeds, bezpečnost, heartbeaty
- [Začínáme](./getting-started.md) - První distribuovaná aplikace
- [Cluster API](../api/cluster.md) - Kompletní API reference

---

*[English version](../../../distribution/guides/production-deployment.md)*
