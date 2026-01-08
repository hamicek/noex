/**
 * Distributed stress testing infrastructure.
 *
 * This module provides comprehensive tools for stress testing distributed
 * cluster communication, including multi-node cluster management, crash
 * simulation, metrics collection, and test behaviors.
 *
 * @module tests/stress/distribution
 */

// Cluster management
export {
  TestCluster,
  TestClusterFactory,
  type TestClusterConfig,
  type TestNodeInfo,
  type TestNodeStatus,
  type TestClusterEvents,
  type NodeIPCMessage,
  type NodeIPCResponse,
  type NodeStartConfig,
  type CrashMode,
} from './cluster-factory.js';

// Crash simulation
export {
  NodeCrashSimulator,
  createCrashSimulator,
  killRandomNodes,
  rollingRestartCluster,
  createSplitBrain,
  triggerCascadeFailure,
  type NodeCrashMode,
  type NodeCrashResult,
  type ChaosPatternResult,
  type ChaosPattern,
  type RandomKillConfig,
  type RollingRestartConfig,
  type SplitBrainConfig,
  type CascadeFailureConfig,
  type CrashSimulatorEvents,
  type ClusterStats,
} from './node-crash-simulator.js';

// Metrics collection
export {
  DistributedMetricsCollector,
  DistributedMetricsAssertions,
  createDistributedMetricsCollector,
  type DistributedStressMetrics,
  type DistributedTimelineEvent,
  type DistributedTimelineEventType,
  type DistributedMetricsConfig,
  type ClusterMetrics,
  type TransportMetrics,
  type RemoteCallMetrics,
  type RemoteSpawnMetrics,
  type RegistryMetrics,
  type SupervisorMetrics,
} from './distributed-metrics-collector.js';

// Test behaviors
export {
  counterBehavior,
  echoBehavior,
  slowBehavior,
  crashAfterNBehavior,
  memoryHogBehavior,
  statefulBehavior,
  createSlowBehavior,
  createCrashAfterNBehavior,
  createMemoryHogBehavior,
  createStatefulBehavior,
  stressTestBehaviors,
  type CounterState,
  type CounterCallMsg,
  type CounterCastMsg,
  type CounterCallReply,
  type EchoState,
  type EchoCallMsg,
  type EchoCastMsg,
  type EchoCallReply,
  type SlowState,
  type SlowCallMsg,
  type SlowCastMsg,
  type SlowCallReply,
  type CrashAfterNState,
  type CrashAfterNCallMsg,
  type CrashAfterNCastMsg,
  type CrashAfterNCallReply,
  type MemoryHogState,
  type MemoryHogCallMsg,
  type MemoryHogCastMsg,
  type MemoryHogCallReply,
  type StatefulState,
  type StatefulCallMsg,
  type StatefulCastMsg,
  type StatefulCallReply,
  type OperationLogEntry,
  type StressTestBehaviorName,
} from './behaviors.js';
