# Types Reference

Complete reference of all types, interfaces, and constants used in the noex distribution module.

## Import

```typescript
import {
  // Types
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

  // Error classes
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

  // Constants
  CLUSTER_DEFAULTS,
  DISTRIBUTED_SUPERVISOR_DEFAULTS,
} from 'noex/distribution';
```

---

## Core Types

### NodeId

Branded string type representing a unique node identifier.

```typescript
type NodeId = string & { readonly __brand: 'NodeId' };
```

Format: `name@host:port` (e.g., `app1@192.168.1.1:4369`)

**Utilities:**

```typescript
import { NodeId, isNodeId } from 'noex/distribution';

// Parse from string
const nodeId = NodeId.parse('app1@192.168.1.1:4369');

// Create from components
const nodeId = NodeId.create('app1', '192.168.1.1', 4369);

// Validate
const valid = NodeId.isValid('app1@192.168.1.1:4369'); // true

// Type guard
if (isNodeId(value)) {
  // value is NodeId
}
```

### NodeIdComponents

Components of a parsed NodeId.

```typescript
interface NodeIdComponents {
  readonly name: string;
  readonly host: string;
  readonly port: number;
}
```

### NodeStatus

Connection status of a node.

```typescript
type NodeStatus = 'connecting' | 'connected' | 'disconnected';
```

### NodeInfo

Information about a cluster node.

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

Status of the local cluster node.

```typescript
type ClusterStatus = 'starting' | 'running' | 'stopping' | 'stopped';
```

### ClusterConfig

Configuration for starting a cluster node.

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

## Messaging Types

### SerializedRef

Serializable representation of a GenServerRef.

```typescript
interface SerializedRef {
  readonly id: string;
  readonly nodeId: NodeId;
}
```

### CallId

Branded type for remote call correlation.

```typescript
type CallId = string & { readonly __brand: 'CallId' };
```

### SpawnId

Branded type for remote spawn correlation.

```typescript
type SpawnId = string & { readonly __brand: 'SpawnId' };
```

### MonitorId

Branded type for process monitor correlation.

```typescript
type MonitorId = string & { readonly __brand: 'MonitorId' };
```

### LinkId

Branded type for process link correlation.

```typescript
type LinkId = string & { readonly __brand: 'LinkId' };
```

---

## Error Types

### NodeDownReason

Reasons why a node may be considered down.

```typescript
type NodeDownReason =
  | 'heartbeat_timeout'
  | 'connection_closed'
  | 'connection_refused'
  | 'graceful_shutdown';
```

### RemoteErrorType

Types of errors during remote calls.

```typescript
type RemoteErrorType =
  | 'server_not_running'
  | 'call_timeout'
  | 'serialization_error'
  | 'unknown_error';
```

### SpawnErrorType

Types of errors during remote spawn.

```typescript
type SpawnErrorType =
  | 'behavior_not_found'
  | 'init_failed'
  | 'init_timeout'
  | 'registration_failed'
  | 'unknown_error';
```

### ProcessDownReason

Reason why a monitored process went down.

```typescript
type ProcessDownReason =
  | { readonly type: 'normal' }
  | { readonly type: 'shutdown' }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'noproc' }
  | { readonly type: 'noconnection' };
```

---

## Handler Types

### NodeUpHandler

Handler for node join events.

```typescript
type NodeUpHandler = (node: NodeInfo) => void;
```

### NodeDownHandler

Handler for node leave events.

```typescript
type NodeDownHandler = (nodeId: NodeId, reason: NodeDownReason) => void;
```

### ClusterStatusHandler

Handler for cluster status changes.

```typescript
type ClusterStatusHandler = (status: ClusterStatus) => void;
```

---

## Supervisor Types

### NodeSelectorType

Built-in node selection strategies.

```typescript
type NodeSelectorType = 'local_first' | 'round_robin' | 'least_loaded' | 'random';
```

### NodeSelectorFn

Custom node selection function.

```typescript
type NodeSelectorFn = (nodes: readonly NodeInfo[], childId: string) => NodeId;
```

### NodeSelector

Node selection configuration.

```typescript
type NodeSelector =
  | NodeSelectorType
  | { readonly node: NodeId }
  | NodeSelectorFn;
```

### DistributedAutoShutdown

Auto-shutdown behavior.

```typescript
type DistributedAutoShutdown = 'never' | 'any_significant' | 'all_significant';
```

### DistributedSupervisorEvent

Lifecycle events for distributed supervision.

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

Handler for supervisor lifecycle events.

```typescript
type DistributedSupervisorEventHandler = (event: DistributedSupervisorEvent) => void;
```

---

## Error Classes

### Cluster Errors

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

### Remote Call Errors

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

### Remote Spawn Errors

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

### Registry Errors

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

### Monitor Errors

#### RemoteMonitorTimeoutError

```typescript
class RemoteMonitorTimeoutError extends Error {
  readonly name = 'RemoteMonitorTimeoutError';
  readonly monitoredRef: SerializedRef;
  readonly timeoutMs: number;
}
```

### Link Errors

#### RemoteLinkTimeoutError

```typescript
class RemoteLinkTimeoutError extends Error {
  readonly name = 'RemoteLinkTimeoutError';
  readonly remoteRef: SerializedRef;
  readonly timeoutMs: number;
}
```

### Supervisor Errors

#### NoAvailableNodeError

```typescript
class NoAvailableNodeError extends Error {
  readonly name = 'NoAvailableNodeError';
  readonly childId: string;
  readonly selector?: NodeSelector;
}
```

#### DistributedBehaviorNotFoundError

```typescript
class DistributedBehaviorNotFoundError extends Error {
  readonly name = 'DistributedBehaviorNotFoundError';
  readonly behaviorName: string;
  readonly nodeId: NodeId;
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

#### DistributedInvalidSimpleOneForOneError

```typescript
class DistributedInvalidSimpleOneForOneError extends Error {
  readonly name = 'DistributedInvalidSimpleOneForOneError';
  readonly supervisorId: string;
  readonly reason: string;
}
```

#### DistributedMissingChildTemplateError

```typescript
class DistributedMissingChildTemplateError extends Error {
  readonly name = 'DistributedMissingChildTemplateError';
  readonly supervisorId: string;
}
```

#### DistributedChildClaimError

```typescript
class DistributedChildClaimError extends Error {
  readonly name = 'DistributedChildClaimError';
  readonly supervisorId: string;
  readonly childId: string;
  readonly ownerSupervisorId: string;
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

## Constants

### CLUSTER_DEFAULTS

Default values for cluster configuration.

```typescript
const CLUSTER_DEFAULTS = {
  /** Default host to bind to */
  HOST: '0.0.0.0',

  /** Default port for cluster communication (Erlang EPMD port) */
  PORT: 4369,

  /** Default heartbeat interval in milliseconds */
  HEARTBEAT_INTERVAL_MS: 5000,

  /** Default number of missed heartbeats before marking node as down */
  HEARTBEAT_MISS_THRESHOLD: 3,

  /** Default initial reconnection delay in milliseconds */
  RECONNECT_BASE_DELAY_MS: 1000,

  /** Default maximum reconnection delay in milliseconds */
  RECONNECT_MAX_DELAY_MS: 30000,

  /** Protocol version */
  PROTOCOL_VERSION: 1,
} as const;
```

### DISTRIBUTED_SUPERVISOR_DEFAULTS

Default values for distributed supervisor configuration.

```typescript
const DISTRIBUTED_SUPERVISOR_DEFAULTS = {
  /** Default node selector strategy */
  NODE_SELECTOR: 'local_first',

  /** Default supervisor strategy */
  STRATEGY: 'one_for_one',

  /** Default maximum restarts in intensity window */
  MAX_RESTARTS: 3,

  /** Default restart intensity window in milliseconds */
  RESTART_WITHIN_MS: 5000,

  /** Default shutdown timeout in milliseconds */
  SHUTDOWN_TIMEOUT: 5000,

  /** Default auto-shutdown behavior */
  AUTO_SHUTDOWN: 'never',

  /** Timeout for remote spawn operations in milliseconds */
  SPAWN_TIMEOUT: 10000,

  /** Interval for polling child status in milliseconds */
  CHILD_CHECK_INTERVAL: 50,
} as const;
```

---

## Related

- [Cluster API](./cluster.md)
- [RemoteCall API](./remote-call.md)
- [RemoteSpawn API](./remote-spawn.md)
- [GlobalRegistry API](./global-registry.md)
- [RemoteMonitor API](./remote-monitor.md)
- [RemoteLink API](./remote-link.md)
- [DistributedSupervisor API](./distributed-supervisor.md)
