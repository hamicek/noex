import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { GenServerRef, GenServerBehavior } from '../../../src/core/types.js';
import type { NodeId } from '../../../src/distribution/node-id.js';
import type {
  DistributedChildSpec,
  DistributedSupervisorEvent,
} from '../../../src/distribution/supervisor/types.js';
import {
  DistributedDuplicateChildError,
  DistributedChildNotFoundError,
  DistributedMaxRestartsExceededError,
  DistributedInvalidSimpleOneForOneError,
  DistributedMissingChildTemplateError,
  DistributedBehaviorNotFoundError,
  DistributedSupervisorError,
} from '../../../src/distribution/supervisor/types.js';

// Mock dependencies
const mockLocalNodeId = 'local@localhost:4369' as unknown as NodeId;
const mockRemoteNodeId = 'remote@localhost:4370' as unknown as NodeId;

let mockIsConnectedTo = vi.fn().mockReturnValue(true);
let mockOnNodeDown = vi.fn().mockReturnValue(() => {});
let mockGenServerIsRunning = vi.fn().mockReturnValue(true);
let mockGenServerStart = vi.fn();
let mockGenServerStop = vi.fn();
let mockGenServerOnLifecycleEvent = vi.fn().mockReturnValue(() => {});
let mockGenServerForceTerminate = vi.fn();
let mockBehaviorRegistryHas = vi.fn().mockReturnValue(true);
let mockBehaviorRegistryGet = vi.fn();
let mockRemoteSpawnSpawn = vi.fn();
let mockGlobalRegistryRegister = vi.fn();
let mockGlobalRegistryUnregister = vi.fn();
let mockGlobalRegistryWhereis = vi.fn().mockReturnValue(null);
let mockGlobalRegistryGetNames = vi.fn().mockReturnValue([]);
let serverIdCounter = 0;

vi.mock('../../../src/distribution/cluster/cluster.js', () => ({
  Cluster: {
    getLocalNodeId: () => mockLocalNodeId,
    getConnectedNodes: () => [],
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
    onLifecycleEvent: (handler: () => void) => mockGenServerOnLifecycleEvent(handler),
    _forceTerminate: (ref: GenServerRef, reason?: string) => mockGenServerForceTerminate(ref, reason),
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
    spawn: (behaviorName: string, targetNodeId: NodeId, options?: unknown) => mockRemoteSpawnSpawn(behaviorName, targetNodeId, options),
  },
}));

vi.mock('../../../src/distribution/registry/global-registry.js', () => ({
  GlobalRegistry: {
    register: (name: string, ref: unknown) => {
      mockGlobalRegistryRegister(name, ref);
      return Promise.resolve();
    },
    unregister: (name: string) => {
      mockGlobalRegistryUnregister(name);
      return Promise.resolve();
    },
    whereis: (name: string) => mockGlobalRegistryWhereis(name),
    getNames: () => mockGlobalRegistryGetNames(),
  },
}));

// Import after mocking
import { DistributedSupervisor } from '../../../src/distribution/supervisor/distributed-supervisor.js';

describe('DistributedSupervisor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverIdCounter = 0;
    DistributedSupervisor._resetIdCounter();
    DistributedSupervisor._clearLifecycleHandlers();

    // Reset mock implementations
    mockIsConnectedTo = vi.fn().mockReturnValue(true);
    mockOnNodeDown = vi.fn().mockReturnValue(() => {});
    mockGenServerIsRunning = vi.fn().mockReturnValue(true);
    mockGenServerStart = vi.fn();
    mockGenServerStop = vi.fn();
    mockGenServerOnLifecycleEvent = vi.fn().mockReturnValue(() => {});
    mockGenServerForceTerminate = vi.fn();
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

  describe('start', () => {
    it('starts a supervisor with default options', async () => {
      const ref = await DistributedSupervisor.start();

      expect(ref).toBeDefined();
      expect(ref.id).toMatch(/^dsup_/);
      expect(ref.nodeId).toBe(mockLocalNodeId);
      expect(DistributedSupervisor.isRunning(ref)).toBe(true);
    });

    it('starts a supervisor with children', async () => {
      const spec: DistributedChildSpec = {
        id: 'worker-1',
        behavior: 'worker',
        restart: 'permanent',
      };

      const ref = await DistributedSupervisor.start({
        children: [spec],
      });

      expect(DistributedSupervisor.countChildren(ref)).toBe(1);
      const children = DistributedSupervisor.getChildren(ref);
      expect(children).toHaveLength(1);
      expect(children[0]!.id).toBe('worker-1');
    });

    it('throws when behavior is not registered', async () => {
      mockBehaviorRegistryHas.mockReturnValue(false);

      const spec: DistributedChildSpec = {
        id: 'worker-1',
        behavior: 'unknown-behavior',
      };

      await expect(
        DistributedSupervisor.start({ children: [spec] }),
      ).rejects.toThrow(DistributedBehaviorNotFoundError);
    });

    it('validates simple_one_for_one requires childTemplate', async () => {
      await expect(
        DistributedSupervisor.start({
          strategy: 'simple_one_for_one',
        }),
      ).rejects.toThrow(DistributedMissingChildTemplateError);
    });

    it('validates simple_one_for_one cannot have static children', async () => {
      await expect(
        DistributedSupervisor.start({
          strategy: 'simple_one_for_one',
          childTemplate: {
            behavior: 'worker',
          },
          children: [{ id: 'child-1', behavior: 'worker' }],
        }),
      ).rejects.toThrow(DistributedInvalidSimpleOneForOneError);
    });

    it('emits supervisor_started event', async () => {
      const events: DistributedSupervisorEvent[] = [];
      const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
        events.push(event);
      });

      const ref = await DistributedSupervisor.start();

      expect(events).toContainEqual({
        type: 'supervisor_started',
        ref,
      });

      unsubscribe();
    });

    it('emits child_started event for each child', async () => {
      const events: DistributedSupervisorEvent[] = [];
      const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
        events.push(event);
      });

      const ref = await DistributedSupervisor.start({
        children: [
          { id: 'worker-1', behavior: 'worker' },
          { id: 'worker-2', behavior: 'worker' },
        ],
      });

      const childStartedEvents = events.filter((e) => e.type === 'child_started');
      expect(childStartedEvents).toHaveLength(2);

      unsubscribe();
    });
  });

  describe('stop', () => {
    it('stops a running supervisor', async () => {
      const ref = await DistributedSupervisor.start();
      expect(DistributedSupervisor.isRunning(ref)).toBe(true);

      await DistributedSupervisor.stop(ref);

      expect(DistributedSupervisor.isRunning(ref)).toBe(false);
    });

    it('stops all children in reverse order', async () => {
      const stopOrder: string[] = [];
      mockGenServerStop.mockImplementation((ref: GenServerRef) => {
        stopOrder.push(ref.id);
        return Promise.resolve();
      });

      const ref = await DistributedSupervisor.start({
        children: [
          { id: 'worker-1', behavior: 'worker' },
          { id: 'worker-2', behavior: 'worker' },
          { id: 'worker-3', behavior: 'worker' },
        ],
      });

      await DistributedSupervisor.stop(ref);

      // Children should be stopped in reverse order (last started first)
      expect(stopOrder[0]).toContain('3');
      expect(stopOrder[1]).toContain('2');
      expect(stopOrder[2]).toContain('1');
    });

    it('emits supervisor_stopped event', async () => {
      const events: DistributedSupervisorEvent[] = [];
      const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
        events.push(event);
      });

      const ref = await DistributedSupervisor.start();
      await DistributedSupervisor.stop(ref);

      expect(events).toContainEqual({
        type: 'supervisor_stopped',
        ref,
        reason: 'normal',
      });

      unsubscribe();
    });

    it('handles stopping already stopped supervisor', async () => {
      const ref = await DistributedSupervisor.start();
      await DistributedSupervisor.stop(ref);

      // Should not throw
      await DistributedSupervisor.stop(ref);
    });
  });

  describe('startChild', () => {
    it('starts a child dynamically', async () => {
      const ref = await DistributedSupervisor.start();

      const childRef = await DistributedSupervisor.startChild(ref, {
        id: 'dynamic-worker',
        behavior: 'worker',
      });

      expect(childRef).toBeDefined();
      expect(DistributedSupervisor.countChildren(ref)).toBe(1);
    });

    it('throws on duplicate child ID', async () => {
      const ref = await DistributedSupervisor.start({
        children: [{ id: 'worker-1', behavior: 'worker' }],
      });

      await expect(
        DistributedSupervisor.startChild(ref, {
          id: 'worker-1',
          behavior: 'worker',
        }),
      ).rejects.toThrow(DistributedDuplicateChildError);
    });

    it('starts child from template in simple_one_for_one', async () => {
      const ref = await DistributedSupervisor.start({
        strategy: 'simple_one_for_one',
        childTemplate: {
          behavior: 'worker',
          restart: 'permanent',
        },
      });

      const childRef1 = await DistributedSupervisor.startChild(ref, [{ value: 1 }]);
      const childRef2 = await DistributedSupervisor.startChild(ref, [{ value: 2 }]);

      expect(childRef1).toBeDefined();
      expect(childRef2).toBeDefined();
      expect(DistributedSupervisor.countChildren(ref)).toBe(2);
    });

    it('throws when passing array to non-simple_one_for_one', async () => {
      const ref = await DistributedSupervisor.start({
        strategy: 'one_for_one',
      });

      await expect(
        DistributedSupervisor.startChild(ref, [{ value: 1 }]),
      ).rejects.toThrow(DistributedInvalidSimpleOneForOneError);
    });

    it('throws when passing spec to simple_one_for_one', async () => {
      const ref = await DistributedSupervisor.start({
        strategy: 'simple_one_for_one',
        childTemplate: { behavior: 'worker' },
      });

      await expect(
        DistributedSupervisor.startChild(ref, { id: 'worker', behavior: 'worker' }),
      ).rejects.toThrow(DistributedInvalidSimpleOneForOneError);
    });
  });

  describe('terminateChild', () => {
    it('terminates a specific child', async () => {
      const ref = await DistributedSupervisor.start({
        children: [
          { id: 'worker-1', behavior: 'worker' },
          { id: 'worker-2', behavior: 'worker' },
        ],
      });

      expect(DistributedSupervisor.countChildren(ref)).toBe(2);

      await DistributedSupervisor.terminateChild(ref, 'worker-1');

      expect(DistributedSupervisor.countChildren(ref)).toBe(1);
      expect(DistributedSupervisor.getChild(ref, 'worker-1')).toBeUndefined();
      expect(DistributedSupervisor.getChild(ref, 'worker-2')).toBeDefined();
    });

    it('throws when child not found', async () => {
      const ref = await DistributedSupervisor.start();

      await expect(
        DistributedSupervisor.terminateChild(ref, 'nonexistent'),
      ).rejects.toThrow(DistributedChildNotFoundError);
    });

    it('emits child_stopped event', async () => {
      const events: DistributedSupervisorEvent[] = [];
      const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
        events.push(event);
      });

      const ref = await DistributedSupervisor.start({
        children: [{ id: 'worker-1', behavior: 'worker' }],
      });

      await DistributedSupervisor.terminateChild(ref, 'worker-1');

      expect(events).toContainEqual({
        type: 'child_stopped',
        supervisorId: ref.id,
        childId: 'worker-1',
        reason: 'shutdown',
      });

      unsubscribe();
    });
  });

  describe('restartChild', () => {
    it('restarts a specific child', async () => {
      const ref = await DistributedSupervisor.start({
        children: [{ id: 'worker-1', behavior: 'worker' }],
      });

      const childBefore = DistributedSupervisor.getChild(ref, 'worker-1');
      const childRefBefore = childBefore!.ref;

      const newRef = await DistributedSupervisor.restartChild(ref, 'worker-1');

      const childAfter = DistributedSupervisor.getChild(ref, 'worker-1');
      expect(childAfter!.ref.id).not.toBe(childRefBefore.id);
      expect(childAfter!.restartCount).toBe(1);
    });

    it('throws when child not found', async () => {
      const ref = await DistributedSupervisor.start();

      await expect(
        DistributedSupervisor.restartChild(ref, 'nonexistent'),
      ).rejects.toThrow(DistributedChildNotFoundError);
    });

    it('emits child_restarted event', async () => {
      const events: DistributedSupervisorEvent[] = [];
      const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
        events.push(event);
      });

      const ref = await DistributedSupervisor.start({
        children: [{ id: 'worker-1', behavior: 'worker' }],
      });

      await DistributedSupervisor.restartChild(ref, 'worker-1');

      const restartEvent = events.find((e) => e.type === 'child_restarted');
      expect(restartEvent).toBeDefined();
      expect(restartEvent).toMatchObject({
        type: 'child_restarted',
        supervisorId: ref.id,
        childId: 'worker-1',
        attempt: 1,
      });

      unsubscribe();
    });
  });

  describe('getChildren', () => {
    it('returns all children info', async () => {
      const ref = await DistributedSupervisor.start({
        children: [
          { id: 'worker-1', behavior: 'worker', restart: 'permanent' },
          { id: 'worker-2', behavior: 'worker', restart: 'transient' },
        ],
      });

      const children = DistributedSupervisor.getChildren(ref);

      expect(children).toHaveLength(2);
      expect(children[0]!.id).toBe('worker-1');
      expect(children[0]!.spec.restart).toBe('permanent');
      expect(children[1]!.id).toBe('worker-2');
      expect(children[1]!.spec.restart).toBe('transient');
    });

    it('returns children in start order', async () => {
      const ref = await DistributedSupervisor.start({
        children: [
          { id: 'first', behavior: 'worker' },
          { id: 'second', behavior: 'worker' },
          { id: 'third', behavior: 'worker' },
        ],
      });

      const children = DistributedSupervisor.getChildren(ref);

      expect(children.map((c) => c.id)).toEqual(['first', 'second', 'third']);
    });

    it('throws when supervisor not found', async () => {
      const fakeRef = { id: 'nonexistent', nodeId: mockLocalNodeId } as any;

      expect(() => DistributedSupervisor.getChildren(fakeRef)).toThrow(
        DistributedSupervisorError,
      );
    });
  });

  describe('getChild', () => {
    it('returns specific child info', async () => {
      const ref = await DistributedSupervisor.start({
        children: [{ id: 'worker-1', behavior: 'worker', restart: 'permanent' }],
      });

      const child = DistributedSupervisor.getChild(ref, 'worker-1');

      expect(child).toBeDefined();
      expect(child!.id).toBe('worker-1');
      expect(child!.spec.behavior).toBe('worker');
      expect(child!.restartCount).toBe(0);
    });

    it('returns undefined for nonexistent child', async () => {
      const ref = await DistributedSupervisor.start();

      const child = DistributedSupervisor.getChild(ref, 'nonexistent');

      expect(child).toBeUndefined();
    });
  });

  describe('getStats', () => {
    it('returns supervisor statistics', async () => {
      const ref = await DistributedSupervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'worker-1', behavior: 'worker' },
          { id: 'worker-2', behavior: 'worker' },
        ],
      });

      const stats = DistributedSupervisor.getStats(ref);

      expect(stats.id).toBe(ref.id);
      expect(stats.strategy).toBe('one_for_one');
      expect(stats.childCount).toBe(2);
      expect(stats.totalRestarts).toBe(0);
      expect(stats.nodeFailureRestarts).toBe(0);
      expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
    });

    it('tracks child restart count', async () => {
      const ref = await DistributedSupervisor.start({
        children: [{ id: 'worker-1', behavior: 'worker' }],
      });

      await DistributedSupervisor.restartChild(ref, 'worker-1');
      await DistributedSupervisor.restartChild(ref, 'worker-1');

      // Manual restarts are tracked in child's restartCount
      const child = DistributedSupervisor.getChild(ref, 'worker-1');
      expect(child!.restartCount).toBe(2);
    });
  });

  describe('restart strategies', () => {
    describe('one_for_one', () => {
      it('only restarts crashed child', async () => {
        const ref = await DistributedSupervisor.start({
          strategy: 'one_for_one',
          children: [
            { id: 'worker-1', behavior: 'worker' },
            { id: 'worker-2', behavior: 'worker' },
            { id: 'worker-3', behavior: 'worker' },
          ],
        });

        const childrenBefore = DistributedSupervisor.getChildren(ref);
        const worker2RefBefore = childrenBefore[1]!.ref;
        const worker3RefBefore = childrenBefore[2]!.ref;

        await DistributedSupervisor.restartChild(ref, 'worker-1');

        const childrenAfter = DistributedSupervisor.getChildren(ref);
        // worker-2 and worker-3 should have the same refs
        expect(childrenAfter[1]!.ref.id).toBe(worker2RefBefore.id);
        expect(childrenAfter[2]!.ref.id).toBe(worker3RefBefore.id);
      });
    });
  });

  describe('restart intensity', () => {
    it('manual restartChild does not count against intensity limit', async () => {
      // Manual restarts (via restartChild API) are not subject to intensity limits
      // because they are explicit user actions, not automatic crash recovery.
      // Intensity limits only apply to automatic restarts from child crashes.
      const ref = await DistributedSupervisor.start({
        restartIntensity: { maxRestarts: 1, withinMs: 10000 },
        children: [{ id: 'worker-1', behavior: 'worker' }],
      });

      // All manual restarts should succeed
      await DistributedSupervisor.restartChild(ref, 'worker-1');
      await DistributedSupervisor.restartChild(ref, 'worker-1');
      await DistributedSupervisor.restartChild(ref, 'worker-1');

      expect(DistributedSupervisor.getChild(ref, 'worker-1')!.restartCount).toBe(3);
    });

    it('tracks child restart count across multiple restarts', async () => {
      const ref = await DistributedSupervisor.start({
        restartIntensity: { maxRestarts: 1, withinMs: 50 },
        children: [{ id: 'worker-1', behavior: 'worker' }],
      });

      // First restart
      await DistributedSupervisor.restartChild(ref, 'worker-1');

      // Wait
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Second restart
      await DistributedSupervisor.restartChild(ref, 'worker-1');

      expect(DistributedSupervisor.getChild(ref, 'worker-1')!.restartCount).toBe(2);
    });
  });

  describe('onLifecycleEvent', () => {
    it('subscribes to lifecycle events', async () => {
      const events: DistributedSupervisorEvent[] = [];
      const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
        events.push(event);
      });

      const ref = await DistributedSupervisor.start({
        children: [{ id: 'worker-1', behavior: 'worker' }],
      });

      await DistributedSupervisor.stop(ref);

      expect(events.length).toBeGreaterThan(0);
      expect(events.map((e) => e.type)).toContain('supervisor_started');
      expect(events.map((e) => e.type)).toContain('child_started');
      expect(events.map((e) => e.type)).toContain('supervisor_stopped');

      unsubscribe();
    });

    it('unsubscribes correctly', async () => {
      const events: DistributedSupervisorEvent[] = [];
      const unsubscribe = DistributedSupervisor.onLifecycleEvent((event) => {
        events.push(event);
      });

      await DistributedSupervisor.start();

      const countBefore = events.length;
      unsubscribe();

      await DistributedSupervisor.start();

      // No new events should be added
      expect(events.length).toBe(countBefore);
    });
  });

  describe('countChildren', () => {
    it('returns correct count', async () => {
      const ref = await DistributedSupervisor.start({
        children: [
          { id: 'worker-1', behavior: 'worker' },
          { id: 'worker-2', behavior: 'worker' },
        ],
      });

      expect(DistributedSupervisor.countChildren(ref)).toBe(2);

      await DistributedSupervisor.terminateChild(ref, 'worker-1');

      expect(DistributedSupervisor.countChildren(ref)).toBe(1);
    });
  });

  describe('isRunning', () => {
    it('returns true for running supervisor', async () => {
      const ref = await DistributedSupervisor.start();

      expect(DistributedSupervisor.isRunning(ref)).toBe(true);
    });

    it('returns false for stopped supervisor', async () => {
      const ref = await DistributedSupervisor.start();
      await DistributedSupervisor.stop(ref);

      expect(DistributedSupervisor.isRunning(ref)).toBe(false);
    });

    it('returns false for unknown ref', () => {
      const fakeRef = { id: 'nonexistent', nodeId: mockLocalNodeId } as any;

      expect(DistributedSupervisor.isRunning(fakeRef)).toBe(false);
    });
  });

  describe('child registration', () => {
    it('registers children in GlobalRegistry via DistributedChildRegistry', async () => {
      await DistributedSupervisor.start({
        children: [{ id: 'worker-1', behavior: 'worker' }],
      });

      // GlobalRegistry.register should be called for the child
      expect(mockGlobalRegistryRegister).toHaveBeenCalled();
    });

    it('unregisters children on terminate', async () => {
      const ref = await DistributedSupervisor.start({
        children: [{ id: 'worker-1', behavior: 'worker' }],
      });

      await DistributedSupervisor.terminateChild(ref, 'worker-1');

      expect(mockGlobalRegistryUnregister).toHaveBeenCalled();
    });

    it('unregisters all children on supervisor stop', async () => {
      const ref = await DistributedSupervisor.start({
        children: [
          { id: 'worker-1', behavior: 'worker' },
          { id: 'worker-2', behavior: 'worker' },
        ],
      });

      mockGlobalRegistryGetNames.mockReturnValue([
        `dsup:${ref.id}:worker-1`,
        `dsup:${ref.id}:worker-2`,
      ]);

      await DistributedSupervisor.stop(ref);

      // Should call unregister for each child
      expect(mockGlobalRegistryUnregister.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('error handling', () => {
    it('throws DistributedSupervisorError when supervisor not found', async () => {
      const fakeRef = { id: 'nonexistent', nodeId: mockLocalNodeId } as any;

      await expect(
        DistributedSupervisor.startChild(fakeRef, { id: 'child', behavior: 'worker' }),
      ).rejects.toThrow(DistributedSupervisorError);

      expect(() => DistributedSupervisor.getStats(fakeRef)).toThrow(
        DistributedSupervisorError,
      );
    });

    it('throws when behavior is not found', async () => {
      mockBehaviorRegistryHas.mockReturnValue(false);

      await expect(
        DistributedSupervisor.start({
          children: [{ id: 'worker-1', behavior: 'unknown' }],
        }),
      ).rejects.toThrow(DistributedBehaviorNotFoundError);

      // Supervisor should not be registered after failure
      expect(DistributedSupervisor._getAllStats()).toHaveLength(0);
    });
  });
});
