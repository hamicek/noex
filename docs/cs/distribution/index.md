# Distribuce v noex

Dokumentace pro distribuovanou funkcionalitu v noex - tvorbu clusterů, vzdálené zasílání zpráv, globální registry procesů a distribuovanou supervizi.

## Přehled

Distribuční modul rozšiřuje Actor model v noex o možnosti komunikace mezi uzly:

- **Cluster Management** - P2P formace clusteru s gossip protokolem
- **Vzdálené zasílání zpráv** - Transparentní RPC mezi GenServery na různých uzlech
- **Vzdálené spouštění procesů** - Spouštění procesů na vzdálených uzlech
- **Globální registr** - Cluster-wide pojmenování a vyhledávání procesů
- **Vzdálené monitorování** - Sledování procesů na vzdálených uzlech
- **Distribuovaná supervize** - Supervize procesů napříč uzly s automatickým failover

## Sekce dokumentace

### [Koncepty](./concepts/overview.md)

Porozumění distribuované architektuře:

- [Přehled](./concepts/overview.md) - Základní koncepty distribuce
- [Cluster](./concepts/cluster.md) - P2P formace a správa clusteru
- [Vzdálené zasílání zpráv](./concepts/remote-messaging.md) - Komunikace mezi uzly
- [Globální registr](./concepts/global-registry.md) - Cluster-wide pojmenování procesů
- [Distribuovaná supervize](./concepts/distributed-supervisor.md) - Supervize napříč uzly

### [Návody](./guides/getting-started.md)

Praktické návody krok za krokem:

- [Začínáme](./guides/getting-started.md) - První distribuovaná aplikace
- [Formace clusteru](./guides/cluster-formation.md) - Seed uzly, bezpečnost, heartbeaty
- [Vzdálené procesy](./guides/remote-processes.md) - Spouštění a správa vzdálených procesů
- [Monitorování procesů](./guides/process-monitoring.md) - Sledování stavu vzdálených procesů
- [Produkční nasazení](./guides/production-deployment.md) - Docker, Kubernetes, škálování

### [API Reference](./api/cluster.md)

Kompletní API dokumentace:

- [Cluster](./api/cluster.md) - Správa životního cyklu clusteru
- [RemoteCall](./api/remote-call.md) - Vzdálené call/cast operace
- [RemoteSpawn](./api/remote-spawn.md) - Vzdálené spouštění procesů
- [GlobalRegistry](./api/global-registry.md) - Globální pojmenování procesů
- [RemoteMonitor](./api/remote-monitor.md) - Vzdálené monitorování procesů
- [DistributedSupervisor](./api/distributed-supervisor.md) - Distribuovaná supervize
- [Typy](./api/types.md) - Všechny typy, rozhraní a konstanty

## Rychlý příklad

```typescript
import { GenServer } from 'noex';
import {
  Cluster,
  BehaviorRegistry,
  GlobalRegistry,
  RemoteCall,
  RemoteSpawn,
} from 'noex/distribution';

// 1. Definice a registrace behaviour
const counterBehavior = {
  init: () => 0,
  handleCall: (msg: 'get' | 'inc', state: number) => {
    if (msg === 'get') return [state, state];
    return [state + 1, state + 1];
  },
  handleCast: (_msg: never, state: number) => state,
};

BehaviorRegistry.register('counter', counterBehavior);

// 2. Start clusteru
await Cluster.start({
  nodeName: 'app1',
  port: 4369,
  seeds: ['app2@192.168.1.2:4369'],
  clusterSecret: 'shared-secret',
});

// 3. Spawn procesu na vzdáleném uzlu
const result = await RemoteSpawn.spawn('counter', targetNodeId, {
  name: 'main-counter',
  registration: 'global',
});

// 4. Vzdálené volání
const ref = GlobalRegistry.lookup('main-counter');
const count = await RemoteCall.call(ref, 'get');
console.log(`Aktuální hodnota: ${count}`);
```

## Klíčové vlastnosti

### Transparentnost lokace

```typescript
// Stejné API pro lokální i vzdálené procesy
const localRef = GlobalRegistry.whereis('service-a');
const remoteRef = GlobalRegistry.whereis('service-b');

// Volání funguje stejně bez ohledu na lokaci
await RemoteCall.call(localRef, message);
await RemoteCall.call(remoteRef, message);
```

### Automatický failover

```typescript
const supRef = await DistributedSupervisor.start({
  strategy: 'one_for_one',
  nodeSelector: 'round_robin',
  children: [
    { id: 'worker-1', behavior: 'worker' },
    { id: 'worker-2', behavior: 'worker' },
  ],
});

// Při pádu uzlu jsou procesy automaticky přesunuty na jiné uzly
```

### Monitorování procesů

```typescript
const monitorRef = await RemoteMonitor.monitor(watcherRef, workerRef);

GenServer.onLifecycleEvent((event) => {
  if (event.type === 'process_down') {
    console.log(`Proces ${event.monitoredRef.id} spadl: ${event.reason.type}`);
  }
});
```

## Architektura

```
┌─────────────────────────────────────────────────────────────┐
│                     Aplikační vrstva                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │            DistributedSupervisor                     │   │
│  │  (Správa procesů napříč uzly, automatický failover)  │   │
│  └─────────────────────────────────────────────────────┘   │
│                            │                                │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐    │
│  │ RemoteCall   │  │ RemoteSpawn  │  │ RemoteMonitor │    │
│  │ (call/cast)  │  │ (spawn)      │  │ (monitor)     │    │
│  └──────────────┘  └──────────────┘  └───────────────┘    │
│                            │                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  GlobalRegistry                      │   │
│  │         (Cluster-wide pojmenování procesů)           │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────┴────────────────────────────────┐
│                     Transportní vrstva                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                      Cluster                         │   │
│  │    (P2P formace, heartbeaty, gossip protokol)        │   │
│  └─────────────────────────────────────────────────────┘   │
│                            │                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              TCP Transport + Serializace             │   │
│  │         (Spojení mezi uzly, kódování zpráv)          │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Požadavky

- Node.js 18+
- TypeScript 5.0+
- Síťová konektivita mezi uzly (TCP port, výchozí 4369)

## Související

- [GenServer dokumentace](../concepts/genserver.md) - Základní Actor model
- [Supervisor dokumentace](../concepts/supervisor.md) - Lokální supervize
- [Příklady](../../examples/distributed-worker-pool/) - Kompletní příklad distribuované aplikace

---

*[English version](../../distribution/index.md)*
