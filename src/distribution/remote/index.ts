/**
 * Remote call/cast module for distributed GenServer communication.
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
