/**
 * Remote call/cast/spawn module for distributed GenServer communication.
 *
 * @module distribution/remote
 */

export {
  RemoteCall,
  CallHandler,
  _resetRemoteCallState,
  type RemoteCallOptions,
  type RemoteCallStats,
} from './remote-call.js';

export {
  PendingCalls,
  type PendingCallsStats,
} from './pending-calls.js';

export {
  BehaviorRegistry,
  type BehaviorRegistryStats,
} from './behavior-registry.js';

export {
  PendingSpawns,
  type PendingSpawnsStats,
  type SpawnResult,
} from './pending-spawns.js';
