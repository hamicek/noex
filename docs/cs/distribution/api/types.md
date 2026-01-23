# Typy Reference

Kompletní reference všech typů, rozhraní a konstant používaných v distribučním modulu noex.

## Import

```typescript
import {
  // Typy
  type NodeId,
  type NodeInfo,
  type NodeStatus,
  type ClusterConfig,
  type ClusterStatus,
  type SerializedRef,
  type CallId,
  type SpawnId,
  type MonitorId,
  type LinkId,
  type NodeDownReason,
  type RemoteErrorType,
  type SpawnErrorType,
  type ProcessDownReason,

  // Chybové třídy
  InvalidNodeIdError,
  ClusterNotStartedError,
  InvalidClusterConfigError,
  NodeNotReachableError,
  RemoteServerNotRunningError,
  RemoteCallTimeoutError,
  MessageSerializationError,
  BehaviorNotFoundError,
  RemoteSpawnTimeoutError,
  RemoteSpawnInitError,
  RemoteSpawnRegistrationError,
  GlobalNameConflictError,
  GlobalNameNotFoundError,
  RemoteMonitorTimeoutError,
  RemoteLinkTimeoutError,
  NoAvailableNodeError,
  DistributedBehaviorNotFoundError,
  DistributedDuplicateChildError,
  DistributedChildNotFoundError,
  DistributedMaxRestartsExceededError,
  DistributedInvalidSimpleOneForOneError,
  DistributedMissingChildTemplateError,
  DistributedChildClaimError,
  DistributedSupervisorError,

  // Konstanty
  CLUSTER_DEFAULTS,
  DISTRIBUTED_SUPERVISOR_DEFAULTS,
} from 'noex/distribution';
```

---

## Základní typy

### NodeId

Branded string typ reprezentující unikátní identifikátor uzlu.

```typescript
type NodeId = string & { readonly __brand: 'NodeId' };
```

Formát: `name@host:port` (např. `app1@192.168.1.1:4369`)

**Utility:**

```typescript
import { NodeId, isNodeId } from 'noex/distribution';

// Parse ze stringu
const nodeId = NodeId.parse('app1@192.168.1.1:4369');

// Vytvoření z komponent
const nodeId = NodeId.create('app1', '192.168.1.1', 4369);

// Validace
const valid = NodeId.isValid('app1@192.168.1.1:4369'); // true

// Type guard
if (isNodeId(value)) {
  // value je NodeId
}
```

### NodeIdComponents

Komponenty parsovaného NodeId.

```typescript
interface NodeIdComponents {
  readonly name: string;
  readonly host: string;
  readonly port: number;
}
```

### NodeStatus

Stav spojení uzlu.

```typescript
type NodeStatus = 'connecting' | 'connected' | 'disconnected';
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

### ClusterStatus

Stav lokálního cluster uzlu.

```typescript
type ClusterStatus = 'starting' | 'running' | 'stopping' | 'stopped';
```

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

---

## Typy pro zasílání zpráv

### SerializedRef

Serializovatelná reprezentace GenServerRef.

```typescript
interface SerializedRef {
  readonly id: string;
  readonly nodeId: NodeId;
}
```

### CallId

Branded typ pro korelaci vzdálených volání.

```typescript
type CallId = string & { readonly __brand: 'CallId' };
```

### SpawnId

Branded typ pro korelaci vzdálených spawnů.

```typescript
type SpawnId = string & { readonly __brand: 'SpawnId' };
```

### MonitorId

Branded typ pro korelaci process monitorů.

```typescript
type MonitorId = string & { readonly __brand: 'MonitorId' };
```

### LinkId

Branded typ pro korelaci process linků.

```typescript
type LinkId = string & { readonly __brand: 'LinkId' };
```

---

## Typy chyb

### NodeDownReason

Důvody proč uzel může být označen jako down.

```typescript
type NodeDownReason =
  | 'heartbeat_timeout'
  | 'connection_closed'
  | 'connection_refused'
  | 'graceful_shutdown';
```

### RemoteErrorType

Typy chyb při vzdálených voláních.

```typescript
type RemoteErrorType =
  | 'server_not_running'
  | 'call_timeout'
  | 'serialization_error'
  | 'unknown_error';
```

### SpawnErrorType

Typy chyb při vzdáleném spawnu.

```typescript
type SpawnErrorType =
  | 'behavior_not_found'
  | 'init_failed'
  | 'init_timeout'
  | 'registration_failed'
  | 'unknown_error';
```

### ProcessDownReason

Důvod proč monitorovaný proces spadl.

```typescript
type ProcessDownReason =
  | { readonly type: 'normal' }
  | { readonly type: 'shutdown' }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'noproc' }
  | { readonly type: 'noconnection' };
```

---

## Typy handlerů

### NodeUpHandler

Handler pro eventy připojení uzlu.

```typescript
type NodeUpHandler = (node: NodeInfo) => void;
```

### NodeDownHandler

Handler pro eventy odpojení uzlu.

```typescript
type NodeDownHandler = (nodeId: NodeId, reason: NodeDownReason) => void;
```

### ClusterStatusHandler

Handler pro změny stavu clusteru.

```typescript
type ClusterStatusHandler = (status: ClusterStatus) => void;
```

---

## Typy supervisoru

### NodeSelectorType

Vestavěné strategie výběru uzlu.

```typescript
type NodeSelectorType = 'local_first' | 'round_robin' | 'least_loaded' | 'random';
```

### NodeSelectorFn

Custom funkce pro výběr uzlu.

```typescript
type NodeSelectorFn = (nodes: readonly NodeInfo[], childId: string) => NodeId;
```

### NodeSelector

Konfigurace výběru uzlu.

```typescript
type NodeSelector =
  | NodeSelectorType
  | { readonly node: NodeId }
  | NodeSelectorFn;
```

### DistributedAutoShutdown

Chování auto-shutdown.

```typescript
type DistributedAutoShutdown = 'never' | 'any_significant' | 'all_significant';
```

### DistributedSupervisorEvent

Lifecycle eventy pro distribuovanou supervizi.

```typescript
type DistributedSupervisorEvent =
  | { type: 'supervisor_started'; ref: DistributedSupervisorRef }
  | { type: 'supervisor_stopped'; ref: DistributedSupervisorRef; reason: string }
  | { type: 'child_started'; supervisorId: string; childId: string; nodeId: NodeId }
  | { type: 'child_stopped'; supervisorId: string; childId: string; reason: string }
  | { type: 'child_restarted'; supervisorId: string; childId: string; nodeId: NodeId; attempt: number }
  | { type: 'child_migrated'; supervisorId: string; childId: string; fromNode: NodeId; toNode: NodeId }
  | { type: 'node_failure_detected'; supervisorId: string; nodeId: NodeId; affectedChildren: string[] };
```

### DistributedSupervisorEventHandler

Handler pro supervisor lifecycle eventy.

```typescript
type DistributedSupervisorEventHandler = (event: DistributedSupervisorEvent) => void;
```

---

## Chybové třídy

### Cluster chyby

#### InvalidNodeIdError

```typescript
class InvalidNodeIdError extends Error {
  readonly name = 'InvalidNodeIdError';
  readonly input: string;
  readonly reason: string;
}
```

#### ClusterNotStartedError

```typescript
class ClusterNotStartedError extends Error {
  readonly name = 'ClusterNotStartedError';
}
```

#### InvalidClusterConfigError

```typescript
class InvalidClusterConfigError extends Error {
  readonly name = 'InvalidClusterConfigError';
  readonly reason: string;
}
```

### Remote Call chyby

#### NodeNotReachableError

```typescript
class NodeNotReachableError extends Error {
  readonly name = 'NodeNotReachableError';
  readonly nodeId: NodeId;
}
```

#### RemoteServerNotRunningError

```typescript
class RemoteServerNotRunningError extends Error {
  readonly name = 'RemoteServerNotRunningError';
  readonly serverId: string;
  readonly nodeId: NodeId;
}
```

#### RemoteCallTimeoutError

```typescript
class RemoteCallTimeoutError extends Error {
  readonly name = 'RemoteCallTimeoutError';
  readonly serverId: string;
  readonly nodeId: NodeId;
  readonly timeoutMs: number;
}
```

#### MessageSerializationError

```typescript
class MessageSerializationError extends Error {
  readonly name = 'MessageSerializationError';
  readonly operation: 'serialize' | 'deserialize';
  readonly cause: Error;
}
```

### Remote Spawn chyby

#### BehaviorNotFoundError

```typescript
class BehaviorNotFoundError extends Error {
  readonly name = 'BehaviorNotFoundError';
  readonly behaviorName: string;
}
```

#### RemoteSpawnTimeoutError

```typescript
class RemoteSpawnTimeoutError extends Error {
  readonly name = 'RemoteSpawnTimeoutError';
  readonly behaviorName: string;
  readonly nodeId: NodeId;
  readonly timeoutMs: number;
}
```

#### RemoteSpawnInitError

```typescript
class RemoteSpawnInitError extends Error {
  readonly name = 'RemoteSpawnInitError';
  readonly behaviorName: string;
  readonly nodeId: NodeId;
  readonly reason: string;
}
```

#### RemoteSpawnRegistrationError

```typescript
class RemoteSpawnRegistrationError extends Error {
  readonly name = 'RemoteSpawnRegistrationError';
  readonly behaviorName: string;
  readonly nodeId: NodeId;
  readonly registeredName: string;
}
```

### Registry chyby

#### GlobalNameConflictError

```typescript
class GlobalNameConflictError extends Error {
  readonly name = 'GlobalNameConflictError';
  readonly registryName: string;
  readonly existingNodeId: NodeId;
}
```

#### GlobalNameNotFoundError

```typescript
class GlobalNameNotFoundError extends Error {
  readonly name = 'GlobalNameNotFoundError';
  readonly registryName: string;
}
```

### Monitor chyby

#### RemoteMonitorTimeoutError

```typescript
class RemoteMonitorTimeoutError extends Error {
  readonly name = 'RemoteMonitorTimeoutError';
  readonly monitoredRef: SerializedRef;
  readonly timeoutMs: number;
}
```

### Link chyby

#### RemoteLinkTimeoutError

```typescript
class RemoteLinkTimeoutError extends Error {
  readonly name = 'RemoteLinkTimeoutError';
  readonly remoteRef: SerializedRef;
  readonly timeoutMs: number;
}
```

### Supervisor chyby

#### NoAvailableNodeError

```typescript
class NoAvailableNodeError extends Error {
  readonly name = 'NoAvailableNodeError';
  readonly childId: string;
  readonly selector?: NodeSelector;
}
```

#### DistributedDuplicateChildError

```typescript
class DistributedDuplicateChildError extends Error {
  readonly name = 'DistributedDuplicateChildError';
  readonly supervisorId: string;
  readonly childId: string;
}
```

#### DistributedChildNotFoundError

```typescript
class DistributedChildNotFoundError extends Error {
  readonly name = 'DistributedChildNotFoundError';
  readonly supervisorId: string;
  readonly childId: string;
}
```

#### DistributedMaxRestartsExceededError

```typescript
class DistributedMaxRestartsExceededError extends Error {
  readonly name = 'DistributedMaxRestartsExceededError';
  readonly supervisorId: string;
  readonly maxRestarts: number;
  readonly withinMs: number;
}
```

#### DistributedSupervisorError

```typescript
class DistributedSupervisorError extends Error {
  readonly name = 'DistributedSupervisorError';
  readonly supervisorId: string;
  readonly cause?: Error;
}
```

---

## Konstanty

### CLUSTER_DEFAULTS

Výchozí hodnoty pro konfiguraci clusteru.

```typescript
const CLUSTER_DEFAULTS = {
  /** Výchozí host pro binding */
  HOST: '0.0.0.0',

  /** Výchozí port pro cluster komunikaci (Erlang EPMD port) */
  PORT: 4369,

  /** Výchozí interval heartbeatů v milisekundách */
  HEARTBEAT_INTERVAL_MS: 5000,

  /** Výchozí počet zmeškaných heartbeatů před označením uzlu jako down */
  HEARTBEAT_MISS_THRESHOLD: 3,

  /** Výchozí počáteční zpoždění pro reconnect v milisekundách */
  RECONNECT_BASE_DELAY_MS: 1000,

  /** Výchozí maximální zpoždění pro reconnect v milisekundách */
  RECONNECT_MAX_DELAY_MS: 30000,

  /** Verze protokolu */
  PROTOCOL_VERSION: 1,
} as const;
```

### DISTRIBUTED_SUPERVISOR_DEFAULTS

Výchozí hodnoty pro konfiguraci distribuovaného supervisoru.

```typescript
const DISTRIBUTED_SUPERVISOR_DEFAULTS = {
  /** Výchozí strategie výběru uzlu */
  NODE_SELECTOR: 'local_first',

  /** Výchozí strategie supervisoru */
  STRATEGY: 'one_for_one',

  /** Výchozí maximum restartů v okně intensity */
  MAX_RESTARTS: 3,

  /** Výchozí okno restart intensity v milisekundách */
  RESTART_WITHIN_MS: 5000,

  /** Výchozí timeout pro shutdown v milisekundách */
  SHUTDOWN_TIMEOUT: 5000,

  /** Výchozí chování auto-shutdown */
  AUTO_SHUTDOWN: 'never',

  /** Timeout pro vzdálené spawn operace v milisekundách */
  SPAWN_TIMEOUT: 10000,

  /** Interval pro polling stavu child v milisekundách */
  CHILD_CHECK_INTERVAL: 50,
} as const;
```

---

## Související

- [Cluster API](./cluster.md)
- [RemoteCall API](./remote-call.md)
- [RemoteSpawn API](./remote-spawn.md)
- [GlobalRegistry API](./global-registry.md)
- [RemoteMonitor API](./remote-monitor.md)
- [RemoteLink API](./remote-link.md)
- [DistributedSupervisor API](./distributed-supervisor.md)

---

*[English version](../../../distribution/api/types.md)*
