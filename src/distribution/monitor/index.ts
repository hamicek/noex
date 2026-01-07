/**
 * Process monitoring module for noex distributed cluster.
 *
 * Implements Erlang-style unidirectional monitors that notify a process
 * when another process terminates. Unlike links, monitors are one-way
 * and don't propagate failures.
 *
 * @module distribution/monitor
 */

export {
  MonitorRegistry,
  type OutgoingMonitor,
  type IncomingMonitor,
  type MonitorRegistryStats,
} from './monitor-registry.js';
