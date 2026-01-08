# Production Deployment Guide

This guide covers deploying distributed noex applications in production environments: Docker containers, Kubernetes orchestration, health checks, monitoring, and operational best practices.

## Docker Deployment

### Basic Dockerfile

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY dist/ ./dist/
COPY shared/ ./shared/

# Expose cluster port
EXPOSE 4369

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

# Run as non-root user
USER node

CMD ["node", "dist/node.js"]
```

### Docker Compose for Local Testing

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

### Entry Point Script

```typescript
// src/node.ts
import { Cluster, BehaviorRegistry } from 'noex/distribution';
import { createServer, type Server } from 'http';

// Configuration from environment
const config = {
  nodeName: process.env.NODE_NAME || `worker-${process.pid}`,
  clusterPort: parseInt(process.env.CLUSTER_PORT || '4369', 10),
  healthPort: parseInt(process.env.HEALTH_PORT || '8080', 10),
  seeds: process.env.CLUSTER_SEEDS?.split(',').filter(Boolean) || [],
  clusterSecret: process.env.CLUSTER_SECRET,
};

// Health server
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
      // Readiness: cluster running AND at least one other node connected
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
  console.log(`\nReceived ${signal}, starting graceful shutdown...`);

  // Stop accepting new work
  if (healthServer) {
    healthServer.close();
  }

  // Allow in-flight requests to complete (adjust timeout as needed)
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Leave cluster gracefully
  console.log('Leaving cluster...');
  await Cluster.stop();

  console.log('Shutdown complete');
  process.exit(0);
}

async function main(): Promise<void> {
  console.log(`Starting node: ${config.nodeName}`);
  console.log(`Cluster port: ${config.clusterPort}`);
  console.log(`Seeds: ${config.seeds.length > 0 ? config.seeds.join(', ') : '(none - seed node)'}`);

  // Register behaviors BEFORE cluster start
  // BehaviorRegistry.register('worker', workerBehavior);

  // Start cluster
  await Cluster.start({
    nodeName: config.nodeName,
    port: config.clusterPort,
    seeds: config.seeds,
    clusterSecret: config.clusterSecret,
  });

  console.log(`Node started: ${Cluster.getLocalNodeId()}`);

  // Start health endpoint
  startHealthServer();

  // Set up cluster event logging
  Cluster.onNodeUp((node) => {
    console.log(`[CLUSTER] Node joined: ${node.id}`);
  });

  Cluster.onNodeDown((nodeId, reason) => {
    console.log(`[CLUSTER] Node left: ${nodeId} (${reason})`);
  });
}

// Signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Unhandled errors
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

---

## Kubernetes Deployment

### Deployment Manifest

```yaml
# kubernetes/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: noex-cluster
  labels:
    app: noex-cluster
spec:
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
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: CLUSTER_PORT
              value: "4369"
            - name: HEALTH_PORT
              value: "8080"
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
              port: health
            initialDelaySeconds: 10
            periodSeconds: 30
            timeoutSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /ready
              port: health
            initialDelaySeconds: 5
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
      terminationGracePeriodSeconds: 30
```

### Headless Service for Discovery

```yaml
# kubernetes/service-headless.yaml
apiVersion: v1
kind: Service
metadata:
  name: noex-cluster-headless
  labels:
    app: noex-cluster
spec:
  clusterIP: None  # Headless service
  selector:
    app: noex-cluster
  ports:
    - port: 4369
      targetPort: cluster
      name: cluster
```

### StatefulSet for Stable Naming

For predictable seed node naming, use StatefulSet:

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
              # First pod is always the seed
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

Restrict cluster communication to internal pods only:

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
    # Allow cluster traffic from other pods
    - from:
        - podSelector:
            matchLabels:
              app: noex-cluster
      ports:
        - port: 4369
          protocol: TCP
    # Allow health checks from anywhere in cluster
    - ports:
        - port: 8080
          protocol: TCP
  egress:
    # Allow cluster traffic to other pods
    - to:
        - podSelector:
            matchLabels:
              app: noex-cluster
      ports:
        - port: 4369
          protocol: TCP
    # Allow DNS
    - to:
        - namespaceSelector: {}
      ports:
        - port: 53
          protocol: UDP
```

---

## Scaling Strategies

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
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

### Pod Disruption Budget

Ensure cluster stability during updates:

```yaml
# kubernetes/pdb.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: noex-cluster-pdb
spec:
  minAvailable: 2  # Always keep at least 2 nodes
  selector:
    matchLabels:
      app: noex-cluster
```

---

## Monitoring

### Metrics Endpoint

Add Prometheus-compatible metrics:

```typescript
import { Cluster, RemoteCall, RemoteSpawn, RemoteMonitor } from 'noex/distribution';

function getMetrics(): string {
  const clusterStatus = Cluster.getStatus();
  const connectedNodes = clusterStatus === 'running' ? Cluster.getConnectedNodeCount() : 0;
  const remoteCallStats = RemoteCall.getStats();
  const remoteSpawnStats = RemoteSpawn.getStats();
  const monitorStats = RemoteMonitor.getStats();

  return `
# HELP noex_cluster_status Cluster status (1=running, 0=other)
# TYPE noex_cluster_status gauge
noex_cluster_status ${clusterStatus === 'running' ? 1 : 0}

# HELP noex_connected_nodes Number of connected nodes
# TYPE noex_connected_nodes gauge
noex_connected_nodes ${connectedNodes}

# HELP noex_remote_calls_total Total remote calls
# TYPE noex_remote_calls_total counter
noex_remote_calls_total ${remoteCallStats.callsSent}

# HELP noex_remote_calls_pending Pending remote calls
# TYPE noex_remote_calls_pending gauge
noex_remote_calls_pending ${remoteCallStats.pendingCallsCount}

# HELP noex_remote_spawns_total Total remote spawns
# TYPE noex_remote_spawns_total counter
noex_remote_spawns_total ${remoteSpawnStats.totalRegistered}

# HELP noex_remote_monitors_active Active remote monitors
# TYPE noex_remote_monitors_active gauge
noex_remote_monitors_active ${monitorStats.activeOutgoingCount}
`.trim();
}

// Add to health server
if (req.url === '/metrics') {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(getMetrics());
  return;
}
```

### Prometheus ServiceMonitor

```yaml
# kubernetes/servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: noex-cluster
  labels:
    app: noex-cluster
spec:
  selector:
    matchLabels:
      app: noex-cluster
  endpoints:
    - port: health
      path: /metrics
      interval: 15s
```

### Logging Best Practices

```typescript
// Structured logging
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

// Usage
log('info', 'Node started', { port: config.clusterPort });
log('warn', 'Node disconnected', { nodeId, reason });
log('error', 'Remote call failed', { targetNode, error: error.message });
```

---

## Security Checklist

### Configuration

- [ ] Set `CLUSTER_SECRET` environment variable
- [ ] Use secrets management (K8s Secrets, Vault, etc.)
- [ ] Rotate secrets regularly

### Network

- [ ] Use private networks/VPCs for cluster traffic
- [ ] Apply network policies to restrict cluster port access
- [ ] Use TLS for external traffic (reverse proxy)
- [ ] Firewall rules for cluster ports

### Container

- [ ] Run as non-root user
- [ ] Use read-only root filesystem where possible
- [ ] Scan images for vulnerabilities
- [ ] Keep base images updated

### Operational

- [ ] Enable audit logging
- [ ] Set resource limits
- [ ] Configure pod security policies
- [ ] Regular security reviews

---

## Rolling Updates

### Update Strategy

```yaml
# In StatefulSet
spec:
  updateStrategy:
    type: RollingUpdate
  podManagementPolicy: OrderedReady  # One pod at a time
```

### Blue-Green Deployment

For zero-downtime updates:

1. Deploy new cluster alongside old
2. Shift traffic gradually
3. Decommission old cluster

```yaml
# New deployment with different name
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: noex-cluster-v2
  labels:
    app: noex-cluster
    version: v2
```

---

## Troubleshooting

### Common Issues

**Nodes not discovering each other:**
- Check DNS resolution for service names
- Verify network policies allow cluster port traffic
- Ensure seed format is correct: `name@host:port`

**Frequent node disconnections:**
- Increase heartbeat timeout
- Check network latency between pods
- Review resource limits (CPU throttling can affect heartbeats)

**Memory growth:**
- Monitor pending calls/spawns
- Check for unhandled process_down events
- Review GlobalRegistry size

### Debug Commands

```bash
# Check pod logs
kubectl logs -f noex-cluster-0

# Check DNS resolution
kubectl exec noex-cluster-0 -- nslookup noex-cluster-headless

# Test cluster connectivity
kubectl exec noex-cluster-0 -- nc -zv noex-cluster-1.noex-cluster-headless 4369

# Get health status
kubectl exec noex-cluster-0 -- wget -qO- http://localhost:8080/health
```

---

## Related

- [Cluster Formation Guide](./cluster-formation.md) - Seeds, security, heartbeats
- [Getting Started](./getting-started.md) - First distributed application
- [Core Production Guide](../../guides/production.md) - General production tips

---

*[Czech version](../../cs/distribution/guides/production-deployment.md)*
