/**
 * Integration tests for DistributedSupervisor.
 *
 * These tests verify end-to-end behavior and complex workflows
 * that span multiple components of the distributed supervisor system.
 *
 * @module tests/distribution/supervisor/integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { GenServerRef, GenServerBehavior } from '../../../src/core/types.js';
import type { NodeId } from '../../../src/distribution/node-id.js';
import type { NodeInfo } from '../../../src/distribution/types.js';
import type {
  DistributedChildSpec,
  DistributedSupervisorEvent,
} from '../../../src/distribution/supervisor/types.js';
import {
  DistributedMaxRestartsExceededError,
} from '../../../src/distribution/supervisor/types.js';

// =============================================================================
// Mock Setup
// =============================================================================

const mockLocalNodeId = 'local@localhost:4369' as unknown as NodeId;
const mockRemoteNodeA = 'remoteA@localhost:4370' as unknown as NodeId;
const mockRemoteNodeB = 'remoteB@localhost:4371' as unknown as NodeId;

let mockIsConnectedTo = vi.fn().mockReturnValue(true);
let mockOnNodeDown = vi.fn().mockReturnValue(() => {});
let mockGetConnectedNodes = vi.fn().mockReturnValue([]);
let mockGenServerIsRunning = vi.fn().mockReturnValue(true);
let mockGenServerStart = vi.fn();
let mockGenServerStop = vi.fn();
let mockGenServerOnLifecycleEvent = vi.fn().mockReturnValue(() => {});
let mockGenServerForceTerminate = vi.fn();
let mockRemoteMonitorMonitor = vi.fn();
let mockRemoteMonitorDemonitor = vi.fn();
let mockBehaviorRegistryHas = vi.fn().mockReturnValue(true);
let mockBehaviorRegistryGet = vi.fn();
let mockRemoteSpawnSpawn = vi.fn();
let mockGlobalRegistryRegister = vi.fn();
let mockGlobalRegistryUnregister = vi.fn();
let mockGlobalRegistryWhereis = vi.fn().mockReturnValue(null);
let mockGlobalRegistryGetNames = vi.fn().mockReturnValue([]);

let serverIdCounter = 0;
let monitorIdCounter = 0;
let capturedNodeDownHandler: ((nodeId: NodeId, reason: string) => void) | null = null;
let capturedLifecycleHandlers: ((event: unknown) => void)[] = [];

// Track registered names for GlobalRegistry mock
const registeredNames = new Map<string, unknown>();

vi.mock('../../../src/distribution/cluster/cluster.js', () => ({
  Cluster: {
    getLocalNodeId: () => mockLocalNodeId,
    getConnectedNodes: () => mockGetConnectedNodes(),
    onNodeDown: (handler: (nodeId: NodeId, reason: string) => void) => mockOnNodeDown(handler),
    _getTransport: () => ({
      isConnectedTo: mockIsConnectedTo,
    }),
  },
}));

vi.mock('../../../src/core/gen-server.js', () => ({
  GenServer: {
    start: (behavior: GenServerBehavior<unknown, unknown, unknown, unknown>) => {
      const id = `genserver_${++serverIdCounter}_test`;
      const ref = { id } as GenServerRef;
      mockGenServerStart(behavior);
      return Promise.resolve(ref);
    },
    stop: (ref: GenServerRef, reason?: string) => {
      mockGenServerStop(ref, reason);
      return Promise.resolve();
    },
    isRunning: (ref: GenServerRef) => mockGenServerIsRunning(ref),
    onLifecycleEvent: (handler: (event: unknown) => void) => {
      capturedLifecycleHandlers.push(handler);
      const cleanup = mockGenServerOnLifecycleEvent(handler);
      return () => {
        const idx = capturedLifecycleHandlers.indexOf(handler);
        if (idx !== -1) capturedLifecycleHandlers.splice(idx, 1);
        cleanup();
      };
    },
    _forceTerminate: (ref: GenServerRef, reason?: string) =>
      mockGenServerForceTerminate(ref, reason),
  },
}));

vi.mock('../../../src/distribution/remote/behavior-registry.js', () => ({
  BehaviorRegistry: {
    has: (name: string) => mockBehaviorRegistryHas(name),
    get: (name: string) => mockBehaviorRegistryGet(name),
  },
}));

vi.mock('../../../src/distribution/remote/remote-spawn.js', () => ({
  RemoteSpawn: {
    spawn: (behaviorName: string, targetNodeId: NodeId, options?: unknown) =>
      mockRemoteSpawnSpawn(behaviorName, targetNodeId, options),
  },
}));

vi.mock('../../../src/distribution/monitor/remote-monitor.js', () => ({
  RemoteMonitor: {
    monitor: (
      monitoringRef: unknown,
      monitoredRef: { id: string; nodeId: NodeId },
      options?: unknown,
    ) => {
      mockRemoteMonitorMonitor(monitoringRef, monitoredRef, options);
      const monitorId = `monitor_${++monitorIdCounter}`;
      return Promise.resolve({
        monitorId,
        monitoredRef: { id: monitoredRef.id, nodeId: monitoredRef.nodeId },
      });
    },
    demonitor: (monitorRef: unknown) => {
      mockRemoteMonitorDemonitor(monitorRef);
      return Promise.resolve();
    },
  },
}));

vi.mock('../../../src/distribution/registry/global-registry.js', () => ({
  GlobalRegistry: {
    register: (name: string, ref: unknown) => {
      mockGlobalRegistryRegister(name, ref);
      registeredNames.set(name, ref);
      return Promise.resolve();
    },
    unregister: (name: string) => {
      mockGlobalRegistryUnregister(name);
      registeredNames.delete(name);
      return Promise.resolve();
    },
    whereis: (name: string) => {
      mockGlobalRegistryWhereis(name);
      return registeredNames.get(name) ?? null;
    },
    getNames: () => {
      mockGlobalRegistryGetNames();
      return Array.from(registeredNames.keys());
    },
  },
}));

// Import after mocking
import { DistributedSupervisor } from '../../../src/distribution/supervisor/distributed-supervisor.js';
import { DistributedChildRegistry } from '../../../src/distribution/supervisor/child-registry.js';
import { NodeSelectorImpl } from '../../../src/distribution/supervisor/node-selector.js';

// =============================================================================
// Helper Functions
// =============================================================================

function createNodeInfo(id: NodeId, processCount = 0): NodeInfo {
  return {
    id,
    host: 'localhost',
    port: 4369,
    status: 'connected',
    processCount,
    lastHeartbeatAt: Date.now(),
    uptimeMs: 10000,
  };
}

function setupClusterWithNodes(): void {
  mockGetConnectedNodes.mockReturnValue([
    createNodeInfo(mockRemoteNodeA, 5),
    createNodeInfo(mockRemoteNodeB, 10),
  ]);

  capturedNodeDownHandler = null;
  mockOnNodeDown.mockImplementation((handler: (nodeId: NodeId, reason: string) => void) => {
    capturedNodeDownHandler = handler;
    return () => {
      capturedNodeDownHandler = null;
    };
  });

  mockRemoteSpawnSpawn.mockImplementation((_behavior: string, nodeId: NodeId) => {
    const id = `remote_genserver_${++serverIdCounter}_test`;
    return Promise.resolve({
      serverId: id,
      nodeId,
    });
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('DistributedSupervisor Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverIdCounter = 0;
    monitorIdCounter = 0;
    registeredNames.clear();
    capturedNodeDownHandler = null;
    capturedLifecycleHandlers = [];
    DistributedSupervisor._resetIdCounter();
    DistributedSupervisor._clearLifecycleHandlers();
    NodeSelectorImpl._resetRoundRobinCounter();

    // Reset mock implementations
    mockIsConnectedTo = vi.fn().mockReturnValue(true);
    mockOnNodeDown = vi.fn().mockReturnValue(() => {});
    mockGetConnectedNodes = vi.fn().mockReturnValue([]);
    mockGenServerIsRunning = vi.fn().mockReturnValue(true);
    mockGenServerStart = vi.fn();
    mockGenServerStop = vi.fn();
    mockGenServerOnLifecycleEvent = vi.fn().mockReturnValue(() => {});
    mockGenServerForceTerminate = vi.fn();
    mockRemoteMonitorMonitor = vi.fn();
    mockRemoteMonitorDemonitor = vi.fn();
    mockBehaviorRegistryHas = vi.fn().mockReturnValue(true);
    mockBehaviorRegistryGet = vi.fn().mockReturnValue({
      init: () => 0,
      handleCall: (msg: unknown, state: number) => [state, state],
      handleCast: (_msg: unknown, state: number) => state,
    });
    mockRemoteSpawnSpawn = vi.fn();
    mockGlobalRegistryRegister = vi.fn();
    mockGlobalRegistryUnregister = vi.fn();
    mockGlobalRegistryWhereis = vi.fn().mockReturnValue(null);
    mockGlobalRegistryGetNames = vi.fn().mockReturnValue([]);
  });

  afterEach(async () => {
    await DistributedSupervisor._clearAll();
  });

  describe('Multi-node child distribution', () => {
    it('starts children on multiple nodes using round_robin selector', async () => {
      setupClusterWithNodes();

      const ref = await DistributedSupervisor.start({
        strategy: 'one_for_one',
        nodeSelector: 'round_robin',
        children: [
          { id: 'worker-1', behavior: 'worker' },
          { id: 'worker-2', behavior: 'worker' },
          { id: 'worker-3', behavior: 'worker' },
        ],
      });

      const children = DistributedSupervisor.getChildren(ref);
      expect(children).toHaveLength(3);

      // Round robin should distribute across local, remoteA, remoteB
      const nodeDistribution = new Set(children.map((c) => c.nodeId));
      expect(nodeDistribution.size).toBeGreaterThanOrEqual(2);
    });

    it('starts children on least loaded nodes', async () => {
      setupClusterWithNodes();

      const ref = await DistributedSupervisor.start({
        strategy: 'one_for_one',
        nodeSelector: 'least_loaded',
        children: [
          { id: 'worker-1', behavior: 'worker' },
        ],
      });

      const children = DistributedSupervisor.getChildren(ref);
      // Local node has 0 process count (implicit), so it should be selected
      expect(children[0]!.nodeId).toBe(mockLocalNodeId);
    });

    it('allows per-child node selection strategy', async () => {
      setupClusterWithNodes();

      const ref = await DistributedSupervisor.start({
        strategy: 'one_for_one',
        nodeSelector: 'local_first',
        children: [
          { id: 'local-worker', behavior: 'worker', nodeSelector: 'local_first' },
          { id: 'remote-worker', behavior: 'worker', nodeSelector: { node: mockRemoteNodeA } },
        ],
      });

      const children = DistributedSupervisor.getChildren(ref);
      expect(children.find((c) => c.id === 'local-worker')?.nodeId).toBe(mockLocalNodeId);
      expect(children.find((c) => c.id === 'remote-worker')?.nodeId).toBe(mockRemoteNodeA);
    });
  });

  describe('Complete supervisor lifecycle workflow', () => {
    it('executes full lifecycle: start -> add children -> terminate child -> stop', async () => {
      const events: DistributedSupervisorEvent[] = [];
      const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
        events.push(event);
      });

      // Start
      const ref = await DistributedSupervisor.start({
        strategy: 'one_for_one',
        children: [{ id: 'initial-worker', behavior: 'worker' }],
      });

      expect(events.filter((e) => e.type === 'supervisor_started')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'child_started')).toHaveLength(1);

      // Add dynamic child
      await DistributedSupervisor.startChild(ref, { id: 'dynamic-worker', behavior: 'worker' });
      expect(DistributedSupervisor.countChildren(ref)).toBe(2);
      expect(events.filter((e) => e.type === 'child_started')).toHaveLength(2);

      // Terminate one child
      await DistributedSupervisor.terminateChild(ref, 'initial-worker');
      expect(DistributedSupervisor.countChildren(ref)).toBe(1);
      expect(events.filter((e) => e.type === 'child_stopped')).toHaveLength(1);

      // Stop supervisor
      await DistributedSupervisor.stop(ref);
      expect(DistributedSupervisor.isRunning(ref)).toBe(false);
      expect(events.filter((e) => e.type === 'supervisor_stopped')).toHaveLength(1);

      unsubscribe();
    });

    it('maintains child order throughout lifecycle operations', async () => {
      const ref = await DistributedSupervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'first', behavior: 'worker' },
          { id: 'second', behavior: 'worker' },
          { id: 'third', behavior: 'worker' },
        ],
      });

      // Add dynamic child
      await DistributedSupervisor.startChild(ref, { id: 'fourth', behavior: 'worker' });

      let children = DistributedSupervisor.getChildren(ref);
      expect(children.map((c) => c.id)).toEqual(['first', 'second', 'third', 'fourth']);

      // Restart a child in the middle
      await DistributedSupervisor.restartChild(ref, 'second');

      children = DistributedSupervisor.getChildren(ref);
      expect(children.map((c) => c.id)).toEqual(['first', 'second', 'third', 'fourth']);

      // Terminate and verify order preserved for remaining
      await DistributedSupervisor.terminateChild(ref, 'second');

      children = DistributedSupervisor.getChildren(ref);
      expect(children.map((c) => c.id)).toEqual(['first', 'third', 'fourth']);
    });
  });

  describe('Node failure and child migration', () => {
    it('migrates children to available nodes when their node fails', async () => {
      setupClusterWithNodes();

      const events: DistributedSupervisorEvent[] = [];
      const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
        events.push(event);
      });

      // Custom selector that places first child on remoteA, subsequent on local
      let callCount = 0;
      const customSelector = () => {
        callCount++;
        if (callCount === 1) return mockRemoteNodeA;
        return mockLocalNodeId;
      };

      const ref = await DistributedSupervisor.start({
        nodeSelector: customSelector,
        children: [{ id: 'worker-1', behavior: 'worker', restart: 'permanent' }],
      });

      const childBefore = DistributedSupervisor.getChild(ref, 'worker-1');
      expect(childBefore?.nodeId).toBe(mockRemoteNodeA);

      // Simulate node failure
      capturedNodeDownHandler!(mockRemoteNodeA, 'connection_lost');

      // Wait for async handling
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Child should be migrated
      const childAfter = DistributedSupervisor.getChild(ref, 'worker-1');
      expect(childAfter?.nodeId).toBe(mockLocalNodeId);
      expect(childAfter?.restartCount).toBe(1);

      // Verify events
      const nodeFailureEvent = events.find((e) => e.type === 'node_failure_detected');
      expect(nodeFailureEvent).toBeDefined();

      const migratedEvent = events.find((e) => e.type === 'child_migrated');
      expect(migratedEvent).toBeDefined();
      if (migratedEvent && 'fromNode' in migratedEvent && 'toNode' in migratedEvent) {
        expect(migratedEvent.fromNode).toBe(mockRemoteNodeA);
        expect(migratedEvent.toNode).toBe(mockLocalNodeId);
      }

      unsubscribe();
    });

    it('respects restart strategy during node failure', async () => {
      setupClusterWithNodes();

      // Place all children on remote node
      const remoteSelector = () => mockRemoteNodeA;

      const ref = await DistributedSupervisor.start({
        nodeSelector: remoteSelector,
        children: [
          { id: 'permanent-worker', behavior: 'worker', restart: 'permanent' },
          { id: 'temporary-worker', behavior: 'worker', restart: 'temporary' },
          { id: 'transient-worker', behavior: 'worker', restart: 'transient' },
        ],
      });

      expect(DistributedSupervisor.countChildren(ref)).toBe(3);

      // Simulate node failure
      capturedNodeDownHandler!(mockRemoteNodeA, 'connection_lost');

      // Wait for async handling
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Permanent and transient should be restarted (node failure is abnormal exit)
      // Temporary should be removed
      const children = DistributedSupervisor.getChildren(ref);
      const childIds = children.map((c) => c.id);

      expect(childIds).toContain('permanent-worker');
      expect(childIds).not.toContain('temporary-worker');
      expect(childIds).toContain('transient-worker');
    });

    it('stops supervisor when restart intensity exceeded during node failure', async () => {
      setupClusterWithNodes();

      const events: DistributedSupervisorEvent[] = [];
      const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
        events.push(event);
      });

      // All children on remote, low restart limit
      const remoteSelector = () => mockRemoteNodeA;

      const ref = await DistributedSupervisor.start({
        nodeSelector: remoteSelector,
        restartIntensity: { maxRestarts: 1, withinMs: 60000 },
        children: [
          { id: 'worker-1', behavior: 'worker' },
          { id: 'worker-2', behavior: 'worker' },
          { id: 'worker-3', behavior: 'worker' },
        ],
      });

      // Simulate node failure (will try to restart 3 children, exceeding limit of 1)
      capturedNodeDownHandler!(mockRemoteNodeA, 'connection_lost');

      // Wait for async handling
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Supervisor should have stopped
      expect(DistributedSupervisor.isRunning(ref)).toBe(false);

      const stoppedEvent = events.find(
        (e) => e.type === 'supervisor_stopped' && 'reason' in e && e.reason === 'max_restarts_exceeded',
      );
      expect(stoppedEvent).toBeDefined();

      unsubscribe();
    });
  });

  describe('Child registry coordination', () => {
    it('registers and unregisters children in global registry', async () => {
      const ref = await DistributedSupervisor.start({
        children: [
          { id: 'worker-1', behavior: 'worker' },
          { id: 'worker-2', behavior: 'worker' },
        ],
      });

      // Verify registrations
      expect(mockGlobalRegistryRegister).toHaveBeenCalled();

      // Get registration calls
      const registrationCalls = mockGlobalRegistryRegister.mock.calls;
      const registeredChildNames = registrationCalls
        .map((call) => call[0] as string)
        .filter((name) => name.startsWith('dsup:'));

      expect(registeredChildNames.length).toBeGreaterThanOrEqual(2);

      // Stop supervisor - should unregister
      await DistributedSupervisor.stop(ref);

      expect(mockGlobalRegistryUnregister).toHaveBeenCalled();
    });

    it('prevents duplicate child registration across supervisors', async () => {
      const ref1 = await DistributedSupervisor.start({
        children: [{ id: 'shared-name', behavior: 'worker' }],
      });

      // Child is registered under ref1's namespace
      const status1 = DistributedChildRegistry.isChildRegistered(ref1.id, 'shared-name');
      expect(status1.exists).toBe(true);

      // Different supervisor can have child with same name (different namespace)
      const ref2 = await DistributedSupervisor.start({
        children: [{ id: 'shared-name', behavior: 'worker' }],
      });

      const status2 = DistributedChildRegistry.isChildRegistered(ref2.id, 'shared-name');
      expect(status2.exists).toBe(true);

      // Both should coexist
      expect(DistributedSupervisor.getChild(ref1, 'shared-name')).toBeDefined();
      expect(DistributedSupervisor.getChild(ref2, 'shared-name')).toBeDefined();
    });

    it('claims child atomically during restart to prevent race conditions', async () => {
      setupClusterWithNodes();

      // Start supervisor with remote child
      let callCount = 0;
      const customSelector = () => {
        callCount++;
        if (callCount === 1) return mockRemoteNodeA;
        return mockLocalNodeId;
      };

      const ref = await DistributedSupervisor.start({
        nodeSelector: customSelector,
        children: [{ id: 'contested-child', behavior: 'worker' }],
      });

      // Verify child is registered
      const statusBefore = DistributedChildRegistry.isChildRegistered(ref.id, 'contested-child');
      expect(statusBefore.exists).toBe(true);

      // Simulate node failure - this will trigger claim + re-register
      capturedNodeDownHandler!(mockRemoteNodeA, 'connection_lost');

      // Wait for handling
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Child should still be registered (claimed and re-registered)
      const statusAfter = DistributedChildRegistry.isChildRegistered(ref.id, 'contested-child');
      expect(statusAfter.exists).toBe(true);
    });
  });

  describe('Restart strategies with multiple children', () => {
    it('one_for_all restarts all children in correct order', async () => {
      const restartOrder: string[] = [];
      const originalSpawn = mockBehaviorRegistryGet;
      mockBehaviorRegistryGet = vi.fn().mockImplementation((name: string) => ({
        init: () => {
          restartOrder.push(name);
          return 0;
        },
        handleCall: (_msg: unknown, state: number) => [state, state],
        handleCast: (_msg: unknown, state: number) => state,
      }));

      const ref = await DistributedSupervisor.start({
        strategy: 'one_for_all',
        children: [
          { id: 'first', behavior: 'first' },
          { id: 'second', behavior: 'second' },
          { id: 'third', behavior: 'third' },
        ],
      });

      restartOrder.length = 0;

      const childrenBefore = DistributedSupervisor.getChildren(ref);

      // Simulate crash of second child
      mockGenServerIsRunning = vi.fn().mockImplementation((r: GenServerRef) => {
        if (r.id === childrenBefore[1]!.ref.id) return false;
        return true;
      });

      // Wait for crash detection and restart
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify all children have new refs
      const childrenAfter = DistributedSupervisor.getChildren(ref);
      expect(childrenAfter[0]!.ref.id).not.toBe(childrenBefore[0]!.ref.id);
      expect(childrenAfter[1]!.ref.id).not.toBe(childrenBefore[1]!.ref.id);
      expect(childrenAfter[2]!.ref.id).not.toBe(childrenBefore[2]!.ref.id);

      mockBehaviorRegistryGet = originalSpawn;
    });

    it('rest_for_one only restarts affected children', async () => {
      const ref = await DistributedSupervisor.start({
        strategy: 'rest_for_one',
        children: [
          { id: 'first', behavior: 'worker' },
          { id: 'second', behavior: 'worker' },
          { id: 'third', behavior: 'worker' },
          { id: 'fourth', behavior: 'worker' },
        ],
      });

      const childrenBefore = DistributedSupervisor.getChildren(ref);
      const secondRef = childrenBefore[1]!.ref.id;

      // Simulate crash of second child
      mockGenServerIsRunning = vi.fn().mockImplementation((r: GenServerRef) => {
        if (r.id === secondRef) return false;
        return true;
      });

      // Wait for crash detection
      await new Promise((resolve) => setTimeout(resolve, 200));

      const childrenAfter = DistributedSupervisor.getChildren(ref);

      // First should be unchanged
      expect(childrenAfter[0]!.ref.id).toBe(childrenBefore[0]!.ref.id);

      // Second, third, fourth should have new refs
      expect(childrenAfter[1]!.ref.id).not.toBe(childrenBefore[1]!.ref.id);
      expect(childrenAfter[2]!.ref.id).not.toBe(childrenBefore[2]!.ref.id);
      expect(childrenAfter[3]!.ref.id).not.toBe(childrenBefore[3]!.ref.id);
    });
  });

  describe('Simple one-for-one dynamic workers', () => {
    it('manages pool of identical workers with template', async () => {
      const ref = await DistributedSupervisor.start({
        strategy: 'simple_one_for_one',
        childTemplate: {
          behavior: 'worker',
          restart: 'permanent',
        },
      });

      // Start multiple workers
      const workers = await Promise.all([
        DistributedSupervisor.startChild(ref, [{ id: 1 }]),
        DistributedSupervisor.startChild(ref, [{ id: 2 }]),
        DistributedSupervisor.startChild(ref, [{ id: 3 }]),
      ]);

      expect(workers).toHaveLength(3);
      expect(DistributedSupervisor.countChildren(ref)).toBe(3);

      // All children should have unique IDs
      const children = DistributedSupervisor.getChildren(ref);
      const ids = new Set(children.map((c) => c.id));
      expect(ids.size).toBe(3);
    });

    it('restarts crashed workers independently in simple_one_for_one', async () => {
      const ref = await DistributedSupervisor.start({
        strategy: 'simple_one_for_one',
        childTemplate: {
          behavior: 'worker',
          restart: 'permanent',
        },
      });

      await DistributedSupervisor.startChild(ref, [{ value: 'a' }]);
      await DistributedSupervisor.startChild(ref, [{ value: 'b' }]);
      await DistributedSupervisor.startChild(ref, [{ value: 'c' }]);

      const childrenBefore = DistributedSupervisor.getChildren(ref);
      const child1Id = childrenBefore[0]!.id;
      const child2Ref = childrenBefore[1]!.ref.id;
      const child3Id = childrenBefore[2]!.id;

      // Crash child2
      mockGenServerIsRunning = vi.fn().mockImplementation((r: GenServerRef) => {
        if (r.id === child2Ref) return false;
        return true;
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      const childrenAfter = DistributedSupervisor.getChildren(ref);

      // Child1 and child3 unchanged
      expect(childrenAfter.find((c) => c.id === child1Id)?.restartCount).toBe(0);
      expect(childrenAfter.find((c) => c.id === child3Id)?.restartCount).toBe(0);

      // Child2 restarted
      const restartedChild = childrenAfter.find((c) => c.id === childrenBefore[1]!.id);
      expect(restartedChild?.restartCount).toBe(1);
    });
  });

  describe('Statistics and monitoring', () => {
    it('tracks comprehensive statistics throughout lifecycle', async () => {
      setupClusterWithNodes();

      // Place child on remote for migration test
      let callCount = 0;
      const customSelector = () => {
        callCount++;
        if (callCount === 1) return mockRemoteNodeA;
        return mockLocalNodeId;
      };

      const ref = await DistributedSupervisor.start({
        strategy: 'one_for_one',
        nodeSelector: customSelector,
        children: [{ id: 'worker-1', behavior: 'worker' }],
      });

      let stats = DistributedSupervisor.getStats(ref);
      expect(stats.childCount).toBe(1);
      expect(stats.totalRestarts).toBe(0);
      expect(stats.nodeFailureRestarts).toBe(0);

      // Manual restart
      await DistributedSupervisor.restartChild(ref, 'worker-1');

      stats = DistributedSupervisor.getStats(ref);
      // Manual restarts don't count against intensity limits
      // but child's restartCount is tracked

      // Add more children
      await DistributedSupervisor.startChild(ref, { id: 'worker-2', behavior: 'worker' });

      stats = DistributedSupervisor.getStats(ref);
      expect(stats.childCount).toBe(2);

      // Verify uptime is tracking
      expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
    });

    it('tracks children by node distribution', async () => {
      setupClusterWithNodes();

      const ref = await DistributedSupervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'local-1', behavior: 'worker', nodeSelector: 'local_first' },
          { id: 'local-2', behavior: 'worker', nodeSelector: 'local_first' },
          { id: 'remote-1', behavior: 'worker', nodeSelector: { node: mockRemoteNodeA } },
        ],
      });

      const stats = DistributedSupervisor.getStats(ref);
      expect(stats.childrenByNode.get(mockLocalNodeId)).toBe(2);
      expect(stats.childrenByNode.get(mockRemoteNodeA)).toBe(1);
    });
  });

  describe('Graceful shutdown', () => {
    it('stops children in reverse order during shutdown', async () => {
      const stopOrder: string[] = [];
      mockGenServerStop.mockImplementation((ref: GenServerRef) => {
        stopOrder.push(ref.id);
        return Promise.resolve();
      });

      const ref = await DistributedSupervisor.start({
        children: [
          { id: 'first', behavior: 'worker' },
          { id: 'second', behavior: 'worker' },
          { id: 'third', behavior: 'worker' },
        ],
      });

      const children = DistributedSupervisor.getChildren(ref);
      const firstRef = children[0]!.ref.id;
      const secondRef = children[1]!.ref.id;
      const thirdRef = children[2]!.ref.id;

      stopOrder.length = 0;
      await DistributedSupervisor.stop(ref);

      // Should stop in reverse: third, second, first
      const childStops = stopOrder.filter(
        (id) => id === firstRef || id === secondRef || id === thirdRef,
      );

      expect(childStops[0]).toBe(thirdRef);
      expect(childStops[1]).toBe(secondRef);
      expect(childStops[2]).toBe(firstRef);
    });

    it('cleans up all resources on shutdown', async () => {
      setupClusterWithNodes();

      const ref = await DistributedSupervisor.start({
        nodeSelector: () => mockRemoteNodeA,
        children: [{ id: 'remote-worker', behavior: 'worker' }],
      });

      // Wait for monitor setup
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify setup
      expect(mockRemoteMonitorMonitor).toHaveBeenCalled();
      expect(capturedNodeDownHandler).not.toBeNull();

      await DistributedSupervisor.stop(ref);

      // Verify cleanup
      expect(mockRemoteMonitorDemonitor).toHaveBeenCalled();
      expect(mockGlobalRegistryUnregister).toHaveBeenCalled();
    });

    it('handles shutdown during active node failure handling', async () => {
      setupClusterWithNodes();

      const ref = await DistributedSupervisor.start({
        nodeSelector: () => mockRemoteNodeA,
        children: [
          { id: 'worker-1', behavior: 'worker' },
          { id: 'worker-2', behavior: 'worker' },
        ],
      });

      // Trigger node failure
      capturedNodeDownHandler!(mockRemoteNodeA, 'connection_lost');

      // Immediately stop
      await DistributedSupervisor.stop(ref);

      expect(DistributedSupervisor.isRunning(ref)).toBe(false);
    });
  });

  describe('Auto-shutdown scenarios', () => {
    it('shuts down when significant child terminates with any_significant', async () => {
      const events: DistributedSupervisorEvent[] = [];
      const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
        events.push(event);
      });

      const ref = await DistributedSupervisor.start({
        autoShutdown: 'any_significant',
        children: [
          { id: 'significant-worker', behavior: 'worker', restart: 'temporary', significant: true },
          { id: 'regular-worker', behavior: 'worker' },
        ],
      });

      // Terminate the significant child
      await DistributedSupervisor.terminateChild(ref, 'significant-worker');

      // Wait for auto-shutdown
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(DistributedSupervisor.isRunning(ref)).toBe(false);

      unsubscribe();
    });

    it('continues when non-significant child terminates with any_significant', async () => {
      const ref = await DistributedSupervisor.start({
        autoShutdown: 'any_significant',
        children: [
          { id: 'significant-worker', behavior: 'worker', significant: true },
          { id: 'regular-worker', behavior: 'worker', restart: 'temporary' },
        ],
      });

      // Terminate the regular child
      await DistributedSupervisor.terminateChild(ref, 'regular-worker');

      // Should still be running
      expect(DistributedSupervisor.isRunning(ref)).toBe(true);
      expect(DistributedSupervisor.countChildren(ref)).toBe(1);
    });
  });

  describe('Error recovery scenarios', () => {
    it('recovers from child spawn failure during startup', async () => {
      mockBehaviorRegistryHas.mockReturnValue(false);

      await expect(
        DistributedSupervisor.start({
          children: [{ id: 'bad-worker', behavior: 'unknown-behavior' }],
        }),
      ).rejects.toThrow();

      // Supervisor should not be registered
      expect(DistributedSupervisor._getAllStats()).toHaveLength(0);
    });

    it('continues operating after individual child operations fail', async () => {
      const ref = await DistributedSupervisor.start({
        children: [{ id: 'worker-1', behavior: 'worker' }],
      });

      // Try to terminate non-existent child
      await expect(
        DistributedSupervisor.terminateChild(ref, 'nonexistent'),
      ).rejects.toThrow();

      // Supervisor should still be running
      expect(DistributedSupervisor.isRunning(ref)).toBe(true);
      expect(DistributedSupervisor.countChildren(ref)).toBe(1);
    });
  });
});
