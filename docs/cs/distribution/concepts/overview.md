# Přehled distribuce

Tento dokument poskytuje přehled architektonických konceptů, které umožňují distribuovanou komunikaci v noex.

## Základní principy

Distribuční vrstva noex je postavena na několika klíčových principech:

### 1. Transparentnost lokace

Procesy komunikují stejným způsobem bez ohledu na to, zda jsou na stejném uzlu nebo na vzdáleném:

```typescript
// Lokální i vzdálená volání používají stejné API
const result = await RemoteCall.call(ref, message);
```

### 2. Fail-fast sémantika

Když komunikace selže, chyba se propaguje okamžitě místo tichého selhání:

```typescript
try {
  await RemoteCall.call(ref, message, { timeout: 5000 });
} catch (error) {
  if (error instanceof RemoteCallTimeoutError) {
    // Explicitně ošetřit timeout
  }
}
```

### 3. Explicitní registrace behaviour

Protože JavaScript funkce nelze serializovat, behaviour musí být explicitně registrované:

```typescript
// Na VŠECH uzlech před startem clusteru
BehaviorRegistry.register('worker', workerBehavior);
```

## Komponenty

### Cluster

Spravuje P2P formaci clusteru a udržuje informace o připojených uzlech.

```
┌─────────────────┐      ┌─────────────────┐
│     Node A      │◄────►│     Node B      │
│  ┌───────────┐  │      │  ┌───────────┐  │
│  │  Cluster  │  │      │  │  Cluster  │  │
│  └───────────┘  │      │  └───────────┘  │
└─────────────────┘      └─────────────────┘
        ▲                        ▲
        │         gossip         │
        └────────────────────────┘
```

[Detailní dokumentace Clusteru →](./cluster.md)

### Vzdálené zasílání zpráv

`RemoteCall` poskytuje transparentní RPC mezi GenServery:

```
┌──────────────┐                     ┌──────────────┐
│   Volající   │                     │    Cíl       │
│  GenServer   │                     │  GenServer   │
└──────┬───────┘                     └──────▲───────┘
       │                                    │
       │  call/cast                         │
       ▼                                    │
┌──────────────┐     TCP/IP          ┌──────────────┐
│  RemoteCall  │────────────────────►│  RemoteCall  │
└──────────────┘                     └──────────────┘
```

[Detailní dokumentace vzdáleného zasílání zpráv →](./remote-messaging.md)

### GlobalRegistry

Poskytuje cluster-wide pojmenování procesů:

```
┌─────────────────────────────────────────────────────┐
│                   GlobalRegistry                     │
│  ┌─────────────────────────────────────────────┐   │
│  │  "counter" → {id: "abc", nodeId: "node1@.."}│   │
│  │  "cache"   → {id: "xyz", nodeId: "node2@.."}│   │
│  └─────────────────────────────────────────────┘   │
│           Synchronizováno napříč všemi uzly         │
└─────────────────────────────────────────────────────┘
```

[Detailní dokumentace GlobalRegistry →](./global-registry.md)

### DistributedSupervisor

Spravuje procesy napříč uzly s automatickým failover:

```
┌─────────────────────────────────────────────────────┐
│              DistributedSupervisor                   │
│                                                     │
│  Node A         Node B         Node C              │
│  ┌───────┐     ┌───────┐     ┌───────┐            │
│  │Worker1│     │Worker2│     │Worker3│            │
│  └───────┘     └───────┘     └───────┘            │
│                                                     │
│  Při pádu Node B → Worker2 automaticky             │
│  restartován na Node A nebo Node C                 │
└─────────────────────────────────────────────────────┘
```

[Detailní dokumentace DistributedSupervisor →](./distributed-supervisor.md)

## Tok dat

### Vzdálené volání (call)

```
1. Klient volá RemoteCall.call(ref, msg)
2. RemoteCall serializuje zprávu
3. Cluster najde spojení na cílový uzel
4. Zpráva odeslána přes TCP
5. Cílový uzel deserializuje zprávu
6. Lokální GenServer zpracuje call
7. Odpověď serializována a odeslána zpět
8. Klient obdrží deserializovanou odpověď
```

### Vzdálený spawn

```
1. Volající volá RemoteSpawn.spawn("behavior", nodeId)
2. BehaviorRegistry najde registrované behaviour
3. Požadavek odeslán na cílový uzel
4. Cílový uzel vytvoří GenServer s daným behaviour
5. Volitelně zaregistruje v GlobalRegistry
6. Odpověď s ID procesu odeslána zpět
```

### Monitorování procesů

```
1. Watcher volá RemoteMonitor.monitor(watcherRef, targetRef)
2. Monitor požadavek odeslán na uzel cílového procesu
3. Cílový uzel registruje monitor
4. Při ukončení procesu:
   - Notifikace odeslána všem monitorujícím procesům
   - Watcher obdrží process_down event
```

## Chybové scénáře

### Nedostupný uzel

```typescript
try {
  await RemoteCall.call(ref, message);
} catch (error) {
  if (error instanceof NodeNotReachableError) {
    // Uzel je offline nebo nedostupný
  }
}
```

### Timeout

```typescript
try {
  await RemoteCall.call(ref, message, { timeout: 1000 });
} catch (error) {
  if (error instanceof RemoteCallTimeoutError) {
    // Volání překročilo timeout
  }
}
```

### Proces neexistuje

```typescript
try {
  await RemoteCall.call(ref, message);
} catch (error) {
  if (error instanceof RemoteServerNotRunningError) {
    // GenServer na cílovém uzlu neběží
  }
}
```

## Best practices

### 1. Vždy používejte timeouty

```typescript
// Dobře: explicitní timeout
await RemoteCall.call(ref, msg, { timeout: 5000 });

// Špatně: spoléhání na výchozí timeout
await RemoteCall.call(ref, msg);
```

### 2. Registrujte behaviour před startem clusteru

```typescript
// Správné pořadí
BehaviorRegistry.register('worker', workerBehavior);
await Cluster.start(config);

// Špatné pořadí - vzdálené spawny selžou
await Cluster.start(config);
BehaviorRegistry.register('worker', workerBehavior);
```

### 3. Ošetřujte všechny chybové případy

```typescript
try {
  const result = await RemoteCall.call(ref, message);
  return result;
} catch (error) {
  if (error instanceof NodeNotReachableError) {
    return handleNodeFailure(error.nodeId);
  }
  if (error instanceof RemoteCallTimeoutError) {
    return handleTimeout();
  }
  if (error instanceof RemoteServerNotRunningError) {
    return handleServerNotRunning(error.serverId);
  }
  throw error;
}
```

### 4. Používejte GlobalRegistry pro služby

```typescript
// Namísto předávání referencí
const cacheRef = GlobalRegistry.whereis('cache');
if (cacheRef) {
  await RemoteCall.call(cacheRef, { type: 'get', key });
}
```

## Související

- [Cluster](./cluster.md) - P2P formace clusteru
- [Vzdálené zasílání zpráv](./remote-messaging.md) - RemoteCall API
- [Globální registr](./global-registry.md) - Cluster-wide pojmenování
- [Distribuovaná supervize](./distributed-supervisor.md) - Supervize napříč uzly

---

*[English version](../../../distribution/concepts/overview.md)*
