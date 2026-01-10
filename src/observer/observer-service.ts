/**
 * Observer Service - GenServer for remote Observer queries.
 *
 * This module provides a GenServer that runs on each cluster node,
 * exposing the local Observer's data for remote access. This is the
 * foundation for ClusterObserver, which aggregates data from all nodes.
 *
 * The service is automatically started when the Cluster starts and
 * stopped when the Cluster stops.
 *
 * @module observer/observer-service
 */

import { GenServer } from '../core/gen-server.js';
import { Registry } from '../core/registry.js';
import type { GenServerRef } from '../core/types.js';
import { Observer } from './observer.js';
import type {
  ObserverServiceCallMessage,
  ObserverServiceCallReply,
} from './types.js';

/**
 * Well-known name for the Observer Service.
 *
 * This name is used for local registry lookup. The service is not
 * registered globally to avoid unnecessary cross-cluster traffic.
 */
export const OBSERVER_SERVICE_NAME = '__noex_observer_service__';

/**
 * State for the Observer Service GenServer.
 *
 * The service is stateless - it delegates all queries to the Observer
 * singleton. We use null as the state type.
 */
type ObserverServiceState = null;

/**
 * Observer Service does not accept any cast messages.
 */
type ObserverServiceCastMessage = never;

/**
 * Reference to the running Observer Service.
 */
let serviceRef: GenServerRef<
  ObserverServiceState,
  ObserverServiceCallMessage,
  ObserverServiceCastMessage,
  ObserverServiceCallReply
> | null = null;

/**
 * Handles incoming call messages by delegating to the Observer.
 *
 * @param msg - The call message to handle
 * @returns Tuple of [reply, state]
 */
function handleServiceCall(
  msg: ObserverServiceCallMessage,
  state: ObserverServiceState,
): readonly [ObserverServiceCallReply, ObserverServiceState] {
  switch (msg.type) {
    case 'get_snapshot': {
      const snapshot = Observer.getSnapshot();
      return [{ type: 'snapshot', data: snapshot }, state];
    }

    case 'get_server_stats': {
      const stats = Observer.getServerStats();
      return [{ type: 'server_stats', data: stats }, state];
    }

    case 'get_supervisor_stats': {
      const stats = Observer.getSupervisorStats();
      return [{ type: 'supervisor_stats', data: stats }, state];
    }

    case 'get_process_tree': {
      const tree = Observer.getProcessTree();
      return [{ type: 'process_tree', data: tree }, state];
    }

    case 'get_process_count': {
      const count = Observer.getProcessCount();
      return [{ type: 'process_count', data: count }, state];
    }
  }
}

/**
 * Starts the Observer Service GenServer.
 *
 * The service is registered under a well-known name in the local registry,
 * making it accessible via Registry.lookup() and through RemoteCall for
 * cross-node queries.
 *
 * This function is idempotent - calling it multiple times has no effect
 * if the service is already running.
 *
 * @throws {Error} If the service fails to start
 *
 * @example
 * ```typescript
 * // Usually called automatically by Cluster.start()
 * await startObserverService();
 *
 * // Service is now available for remote queries
 * const ref = Registry.lookup(OBSERVER_SERVICE_NAME);
 * const reply = await GenServer.call(ref, { type: 'get_snapshot' });
 * ```
 */
export async function startObserverService(): Promise<void> {
  // Idempotent - don't start if already running
  if (serviceRef !== null) {
    return;
  }

  // Check if service is already registered (from a previous start)
  const existingRef = Registry.whereis(OBSERVER_SERVICE_NAME);
  if (existingRef !== undefined) {
    return;
  }

  serviceRef = await GenServer.start<
    ObserverServiceState,
    ObserverServiceCallMessage,
    ObserverServiceCastMessage,
    ObserverServiceCallReply
  >(
    {
      init: () => null,
      handleCall: handleServiceCall,
      handleCast: () => null,
    },
    { name: OBSERVER_SERVICE_NAME },
  );
}

/**
 * Stops the Observer Service GenServer.
 *
 * This function is idempotent - calling it multiple times has no effect
 * if the service is not running.
 *
 * @example
 * ```typescript
 * // Usually called automatically by Cluster.stop()
 * await stopObserverService();
 * ```
 */
export async function stopObserverService(): Promise<void> {
  if (serviceRef === null) {
    return;
  }

  try {
    await GenServer.stop(serviceRef);
  } finally {
    serviceRef = null;
  }
}

/**
 * Checks if the Observer Service is currently running.
 *
 * @returns true if the service is running
 */
export function isObserverServiceRunning(): boolean {
  if (serviceRef === null) {
    return false;
  }
  return GenServer.isRunning(serviceRef);
}

/**
 * Returns a reference to the Observer Service if it's running.
 *
 * @returns The service reference, or undefined if not running
 */
export function getObserverServiceRef(): GenServerRef<
  ObserverServiceState,
  ObserverServiceCallMessage,
  ObserverServiceCastMessage,
  ObserverServiceCallReply
> | undefined {
  if (serviceRef === null || !GenServer.isRunning(serviceRef)) {
    return undefined;
  }
  return serviceRef;
}
