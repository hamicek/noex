# Cluster Formation Guide

This guide covers the essential aspects of forming and managing noex clusters: seed-based discovery, network configuration, security, and operational patterns.

## Seed-Based Discovery

noex clusters use seed-based discovery where new nodes join by connecting to one or more known nodes.

### How It Works

```
                    ┌─────────────────┐
                    │   Seed Node     │
                    │ (first to start)│
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
        ┌──────────┐   ┌──────────┐   ┌──────────┐
        │  Node B  │   │  Node C  │   │  Node D  │
        │(connects │   │(connects │   │(connects │
        │ to seed) │   │ to seed) │   │ to seed) │
        └────┬─────┘   └────┬─────┘   └────┬─────┘
             │              │              │
             └──────────────┴──────────────┘
                     Gossip Protocol
                  (discover each other)
```

1. First node starts without seeds (becomes the initial seed)
2. Subsequent nodes connect to one or more seeds
3. Gossip protocol shares membership information
4. New connections are established automatically

### Basic Formation

**First node (seed):**

```typescript
await Cluster.start({
  nodeName: 'seed1',
  port: 4369,
  // No seeds - first node
});
```

**Additional nodes:**

```typescript
await Cluster.start({
  nodeName: 'worker1',
  port: 4370,
  seeds: ['seed1@192.168.1.10:4369'],
});
```

### Multiple Seeds for Redundancy

Configure multiple seeds to handle seed node failures:

```typescript
await Cluster.start({
  nodeName: 'worker1',
  port: 4370,
  seeds: [
    'seed1@192.168.1.10:4369',
    'seed2@192.168.1.11:4369',
    'seed3@192.168.1.12:4369',
  ],
});
```

The node connects to available seeds and discovers the rest through gossip.

---

## Network Configuration

### Host Binding

By default, nodes bind to `0.0.0.0` (all interfaces). For security, bind to specific interfaces:

```typescript
// Bind to localhost only (single-machine testing)
await Cluster.start({
  nodeName: 'app1',
  host: '127.0.0.1',
  port: 4369,
});

// Bind to specific interface
await Cluster.start({
  nodeName: 'app1',
  host: '192.168.1.10',
  port: 4369,
});
```

### Port Selection

Choose ports carefully for your environment:

```typescript
await Cluster.start({
  nodeName: 'app1',
  port: 4369,  // Default port
});
```

**Considerations:**
- Ports 1-1023 require root privileges
- Avoid well-known service ports
- Document your port scheme for operations team

### Multiple Nodes Per Host

Run multiple nodes on the same machine using different ports:

```typescript
// Node 1
await Cluster.start({ nodeName: 'app1', port: 4369 });

// Node 2 (same host, different port)
await Cluster.start({ nodeName: 'app2', port: 4370 });

// Node 3
await Cluster.start({ nodeName: 'app3', port: 4371 });
```

### Firewall Configuration

Ensure cluster ports are accessible between nodes:

```bash
# Linux (iptables)
iptables -A INPUT -p tcp --dport 4369:4400 -s 192.168.1.0/24 -j ACCEPT

# Linux (ufw)
ufw allow from 192.168.1.0/24 to any port 4369:4400 proto tcp
```

---

## Security

### Cluster Secret

Enable HMAC authentication to prevent unauthorized nodes from joining:

```typescript
await Cluster.start({
  nodeName: 'secure-node',
  port: 4369,
  clusterSecret: process.env.CLUSTER_SECRET,
});
```

When `clusterSecret` is set:
- All messages are signed with HMAC-SHA256
- Unsigned or incorrectly signed messages are rejected
- All nodes must use identical secrets

**Generating a secure secret:**

```bash
# Generate a 256-bit secret
openssl rand -base64 32
# Example output: K4mP/x8z...

# Or use Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Secret Rotation

To rotate secrets without downtime:

1. Deploy new nodes with new secret
2. Gracefully shut down old nodes
3. New nodes form a fresh cluster

Or use a rolling update:
1. Stop half the nodes
2. Update their secrets
3. Start them
4. Repeat for the other half

### Network Isolation

For production, combine authentication with network isolation:

```typescript
// Production configuration
await Cluster.start({
  nodeName: process.env.NODE_NAME!,
  host: process.env.CLUSTER_BIND_IP!,  // Private IP only
  port: parseInt(process.env.CLUSTER_PORT!, 10),
  seeds: process.env.CLUSTER_SEEDS?.split(',') || [],
  clusterSecret: process.env.CLUSTER_SECRET!,
});
```

**Best practices:**
- Run clusters on isolated VLANs or VPCs
- Use private IP ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
- Restrict cluster port access via security groups

---

## Heartbeat Configuration

### Understanding Heartbeats

Nodes exchange heartbeat messages to detect failures:

```
Node A ──heartbeat──► Node B
Node A ◄──heartbeat── Node B

Heartbeat contains:
- Node info (ID, status, process count)
- Known nodes list (for gossip)
```

### Tuning Parameters

```typescript
await Cluster.start({
  nodeName: 'app1',
  port: 4369,
  heartbeatIntervalMs: 5000,      // Send heartbeat every 5s
  heartbeatMissThreshold: 3,     // Mark down after 3 misses
});
```

**Failure detection time** = `heartbeatIntervalMs * heartbeatMissThreshold`

| Interval | Threshold | Detection Time | Use Case |
|----------|-----------|----------------|----------|
| 1000ms | 3 | 3s | Fast failure detection, high network load |
| 5000ms | 3 | 15s | Default, balanced |
| 10000ms | 5 | 50s | Slow networks, resource-constrained |

### Trade-offs

**Faster heartbeats (lower interval):**
- Pro: Quick failure detection
- Con: More network traffic, higher CPU usage
- Con: More false positives on slow networks

**Slower heartbeats (higher interval):**
- Pro: Less resource usage
- Con: Slower failure detection
- Pro: Fewer false positives

---

## Reconnection Behavior

### Automatic Reconnection

Disconnected nodes attempt to reconnect automatically:

```typescript
await Cluster.start({
  nodeName: 'app1',
  port: 4369,
  reconnectBaseDelayMs: 1000,    // Initial retry delay
  reconnectMaxDelayMs: 30000,    // Maximum retry delay
});
```

Reconnection uses exponential backoff:
1. First retry: 1 second
2. Second retry: 2 seconds
3. Third retry: 4 seconds
4. ... up to maximum delay

### Handling Reconnection Events

```typescript
Cluster.onNodeDown((nodeId, reason) => {
  if (reason === 'heartbeat_timeout') {
    console.log(`Node ${nodeId} may come back`);
  } else if (reason === 'graceful_shutdown') {
    console.log(`Node ${nodeId} shut down intentionally`);
  }
});

Cluster.onNodeUp((node) => {
  if (wasReconnected(node.id)) {
    console.log(`Node ${node.id} reconnected`);
  } else {
    console.log(`New node ${node.id} joined`);
  }
});
```

---

## Dynamic Discovery Patterns

### Environment-Based Configuration

```typescript
async function getClusterConfig() {
  return {
    nodeName: process.env.NODE_NAME || `worker-${process.pid}`,
    port: parseInt(process.env.CLUSTER_PORT || '4369', 10),
    seeds: process.env.CLUSTER_SEEDS?.split(',').filter(Boolean) || [],
    clusterSecret: process.env.CLUSTER_SECRET,
  };
}

const config = await getClusterConfig();
await Cluster.start(config);
```

### DNS-Based Discovery

Use DNS SRV records or A records for seed discovery:

```typescript
import { promises as dns } from 'dns';

async function discoverSeeds(): Promise<string[]> {
  try {
    // Query DNS for seed nodes
    const records = await dns.resolve4('cluster-seeds.internal');
    return records.map((ip) => `seed@${ip}:4369`);
  } catch {
    // Fallback to environment variable
    return process.env.CLUSTER_SEEDS?.split(',') || [];
  }
}

const seeds = await discoverSeeds();
await Cluster.start({
  nodeName: 'worker',
  port: 4369,
  seeds,
});
```

### Service Registry Integration

Integrate with Consul, etcd, or similar:

```typescript
interface ServiceRegistryClient {
  getEndpoints(service: string): Promise<string[]>;
  register(service: string, endpoint: string): Promise<void>;
}

async function startWithServiceRegistry(
  registry: ServiceRegistryClient,
  config: { nodeName: string; port: number },
): Promise<void> {
  // Get current seeds from registry
  const seeds = await registry.getEndpoints('noex-cluster');

  // Start the cluster
  await Cluster.start({
    nodeName: config.nodeName,
    port: config.port,
    seeds,
  });

  // Register ourselves
  const localId = Cluster.getLocalNodeId();
  await registry.register('noex-cluster', localId);
}
```

---

## Operational Patterns

### Health Check Endpoint

Expose cluster health for load balancers and orchestrators:

```typescript
import { createServer } from 'http';

function startHealthServer(port: number): void {
  createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404);
      res.end();
      return;
    }

    const status = Cluster.getStatus();
    const healthy = status === 'running';
    const connectedNodes = healthy ? Cluster.getConnectedNodeCount() : 0;

    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status,
      healthy,
      nodeId: healthy ? Cluster.getLocalNodeId() : null,
      connectedNodes,
    }));
  }).listen(port);

  console.log(`Health endpoint: http://0.0.0.0:${port}/health`);
}

// Start health server on separate port
startHealthServer(8080);
```

### Graceful Shutdown

Implement proper shutdown for rolling deployments:

```typescript
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, starting graceful shutdown...`);

  // 1. Stop accepting new work
  // (application-specific)

  // 2. Wait for in-flight operations
  await drainOperations();

  // 3. Leave the cluster gracefully
  await Cluster.stop();

  // 4. Exit
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

### Cluster Monitoring

Track cluster metrics:

```typescript
function logClusterMetrics(): void {
  const nodes = Cluster.getConnectedNodes();
  const status = Cluster.getStatus();

  console.log({
    timestamp: new Date().toISOString(),
    status,
    connectedNodes: nodes.length,
    nodes: nodes.map((n) => ({
      id: n.id,
      status: n.status,
      processCount: n.processCount,
      uptimeMs: n.uptimeMs,
    })),
  });
}

// Log metrics every 30 seconds
setInterval(logClusterMetrics, 30000);
```

---

## Troubleshooting

### Nodes Not Connecting

**Check connectivity:**

```bash
# Test TCP connection to seed
nc -zv 192.168.1.10 4369

# Check if port is listening
netstat -tlnp | grep 4369
```

**Verify seed format:**

```typescript
// Correct format: name@host:port
seeds: ['seed1@192.168.1.10:4369']

// Wrong formats:
seeds: ['seed1@192.168.1.10']      // Missing port
seeds: ['192.168.1.10:4369']       // Missing name
seeds: ['seed1:192.168.1.10:4369'] // Wrong separator
```

### Authentication Failures

If nodes connect but immediately disconnect, check secrets:

```typescript
// Both nodes must have identical secrets
await Cluster.start({
  nodeName: 'node1',
  clusterSecret: 'my-secret-key',  // Must match
});
```

### Nodes Flapping (Up/Down Repeatedly)

Increase heartbeat tolerance:

```typescript
await Cluster.start({
  nodeName: 'app1',
  port: 4369,
  heartbeatIntervalMs: 10000,     // Longer interval
  heartbeatMissThreshold: 5,     // More misses allowed
});
```

Or investigate network issues:
- Packet loss between nodes
- Firewall timeouts
- Network congestion

---

## Related

- [Cluster Concepts](../concepts/cluster.md) - Membership and failure detection
- [Getting Started](./getting-started.md) - First distributed application
- [Production Deployment](./production-deployment.md) - Docker and Kubernetes setup

---

*[Czech version](../../cs/distribution/guides/cluster-formation.md)*
