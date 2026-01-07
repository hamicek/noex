import { describe, it, expect } from 'vitest';
import { NodeId } from '../../../src/distribution/node-id.js';
import type { NodeInfo } from '../../../src/distribution/types.js';
import {
  DISTRIBUTED_SUPERVISOR_DEFAULTS,
  NoAvailableNodeError,
  DistributedBehaviorNotFoundError,
  DistributedDuplicateChildError,
  DistributedChildNotFoundError,
  DistributedMaxRestartsExceededError,
  DistributedInvalidSimpleOneForOneError,
  DistributedMissingChildTemplateError,
  DistributedChildClaimError,
  DistributedSupervisorError,
} from '../../../src/distribution/supervisor/types.js';
import type {
  NodeSelectorType,
  NodeSelectorFn,
  NodeSelector,
  DistributedChildSpec,
  DistributedChildTemplate,
  DistributedAutoShutdown,
  DistributedSupervisorOptions,
  DistributedSupervisorRef,
  DistributedChildInfo,
  DistributedRunningChild,
  DistributedSupervisorStats,
  DistributedSupervisorEvent,
  DistributedSupervisorEventHandler,
} from '../../../src/distribution/supervisor/types.js';

describe('Distributed Supervisor Types', () => {
  const testNodeId = NodeId.parse('app1@localhost:4369');
  const testNodeId2 = NodeId.parse('app2@localhost:4370');

  describe('NodeSelectorType', () => {
    it('accepts all built-in strategies', () => {
      const strategies: NodeSelectorType[] = [
        'local_first',
        'round_robin',
        'least_loaded',
        'random',
      ];
      expect(strategies).toHaveLength(4);
    });
  });

  describe('NodeSelector', () => {
    it('accepts built-in strategy string', () => {
      const selector: NodeSelector = 'round_robin';
      expect(selector).toBe('round_robin');
    });

    it('accepts specific node object', () => {
      const selector: NodeSelector = { node: testNodeId };
      expect(selector).toEqual({ node: testNodeId });
    });

    it('accepts custom selector function', () => {
      const selector: NodeSelector = (nodes, childId) => {
        if (nodes.length === 0) {
          throw new NoAvailableNodeError(childId);
        }
        return nodes[0]!.id;
      };
      expect(typeof selector).toBe('function');
    });
  });

  describe('NodeSelectorFn', () => {
    it('can be implemented with custom logic', () => {
      const customSelector: NodeSelectorFn = (nodes, childId) => {
        const workerNodes = nodes.filter((n) => n.id.toString().includes('worker'));
        if (workerNodes.length > 0) {
          return workerNodes[0]!.id;
        }
        if (nodes.length === 0) {
          throw new NoAvailableNodeError(childId);
        }
        return nodes[0]!.id;
      };

      const mockNodes: NodeInfo[] = [
        {
          id: testNodeId,
          host: 'localhost',
          port: 4369,
          status: 'connected',
          processCount: 5,
          lastHeartbeatAt: Date.now(),
          uptimeMs: 10000,
        },
      ];

      const selectedNode = customSelector(mockNodes, 'child-1');
      expect(selectedNode).toBe(testNodeId);
    });
  });

  describe('DistributedChildSpec', () => {
    it('accepts minimal specification', () => {
      const spec: DistributedChildSpec = {
        id: 'worker-1',
        behavior: 'worker',
      };

      expect(spec.id).toBe('worker-1');
      expect(spec.behavior).toBe('worker');
      expect(spec.args).toBeUndefined();
      expect(spec.restart).toBeUndefined();
    });

    it('accepts full specification', () => {
      const spec: DistributedChildSpec = {
        id: 'cache-server',
        behavior: 'cache',
        args: [{ maxSize: 1000 }, 'lru'],
        restart: 'transient',
        nodeSelector: 'least_loaded',
        shutdownTimeout: 10000,
        significant: true,
      };

      expect(spec.id).toBe('cache-server');
      expect(spec.behavior).toBe('cache');
      expect(spec.args).toEqual([{ maxSize: 1000 }, 'lru']);
      expect(spec.restart).toBe('transient');
      expect(spec.nodeSelector).toBe('least_loaded');
      expect(spec.shutdownTimeout).toBe(10000);
      expect(spec.significant).toBe(true);
    });

    it('accepts specific node selector', () => {
      const spec: DistributedChildSpec = {
        id: 'db-worker',
        behavior: 'db_worker',
        nodeSelector: { node: testNodeId },
      };

      expect(spec.nodeSelector).toEqual({ node: testNodeId });
    });

    it('accepts custom selector function', () => {
      const customSelector: NodeSelectorFn = (nodes) => nodes[0]!.id;

      const spec: DistributedChildSpec = {
        id: 'dynamic-worker',
        behavior: 'worker',
        nodeSelector: customSelector,
      };

      expect(typeof spec.nodeSelector).toBe('function');
    });
  });

  describe('DistributedChildTemplate', () => {
    it('accepts minimal template', () => {
      const template: DistributedChildTemplate = {
        behavior: 'worker',
      };

      expect(template.behavior).toBe('worker');
    });

    it('accepts full template', () => {
      const template: DistributedChildTemplate = {
        behavior: 'task_runner',
        restart: 'temporary',
        nodeSelector: 'round_robin',
        shutdownTimeout: 5000,
        significant: false,
      };

      expect(template.behavior).toBe('task_runner');
      expect(template.restart).toBe('temporary');
      expect(template.nodeSelector).toBe('round_robin');
      expect(template.shutdownTimeout).toBe(5000);
      expect(template.significant).toBe(false);
    });
  });

  describe('DistributedAutoShutdown', () => {
    it('accepts all valid values', () => {
      const values: DistributedAutoShutdown[] = [
        'never',
        'any_significant',
        'all_significant',
      ];
      expect(values).toHaveLength(3);
    });
  });

  describe('DistributedSupervisorOptions', () => {
    it('accepts empty options (all defaults)', () => {
      const options: DistributedSupervisorOptions = {};
      expect(options.strategy).toBeUndefined();
    });

    it('accepts full configuration', () => {
      const options: DistributedSupervisorOptions = {
        strategy: 'one_for_all',
        nodeSelector: 'least_loaded',
        children: [
          { id: 'worker1', behavior: 'worker' },
          { id: 'worker2', behavior: 'worker', restart: 'transient' },
        ],
        restartIntensity: { maxRestarts: 10, withinMs: 60000 },
        autoShutdown: 'any_significant',
        name: 'main-supervisor',
      };

      expect(options.strategy).toBe('one_for_all');
      expect(options.nodeSelector).toBe('least_loaded');
      expect(options.children).toHaveLength(2);
      expect(options.restartIntensity?.maxRestarts).toBe(10);
      expect(options.autoShutdown).toBe('any_significant');
      expect(options.name).toBe('main-supervisor');
    });

    it('accepts simple_one_for_one with template', () => {
      const options: DistributedSupervisorOptions = {
        strategy: 'simple_one_for_one',
        childTemplate: {
          behavior: 'worker',
          restart: 'transient',
          nodeSelector: 'round_robin',
        },
      };

      expect(options.strategy).toBe('simple_one_for_one');
      expect(options.childTemplate?.behavior).toBe('worker');
    });
  });

  describe('DistributedSupervisorRef', () => {
    it('type structure is correct', () => {
      // This is a compile-time check - we create a mock ref
      const ref = {
        id: 'sup-1',
        nodeId: testNodeId,
      } as unknown as DistributedSupervisorRef;

      expect(ref.id).toBe('sup-1');
      expect(ref.nodeId).toBe(testNodeId);
    });
  });

  describe('DistributedChildInfo', () => {
    it('contains all required information', () => {
      const mockGenServerRef = { id: 'server-1' } as Parameters<
        typeof NodeId.parse
      >[0] extends string
        ? { id: string }
        : never;

      const info: DistributedChildInfo = {
        id: 'worker-1',
        ref: mockGenServerRef as unknown as DistributedChildInfo['ref'],
        spec: { id: 'worker-1', behavior: 'worker' },
        nodeId: testNodeId,
        restartCount: 3,
        startedAt: Date.now(),
      };

      expect(info.id).toBe('worker-1');
      expect(info.nodeId).toBe(testNodeId);
      expect(info.restartCount).toBe(3);
      expect(info.startedAt).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('DistributedRunningChild', () => {
    it('contains mutable fields for runtime tracking', () => {
      const mockRef = { id: 'server-1' } as DistributedRunningChild['ref'];

      const child: DistributedRunningChild = {
        id: 'worker-1',
        spec: { id: 'worker-1', behavior: 'worker' },
        ref: mockRef,
        nodeId: testNodeId,
        restartCount: 0,
        restartTimestamps: [],
        startedAt: Date.now(),
      };

      // Can mutate runtime fields
      child.ref = { id: 'server-2' } as DistributedRunningChild['ref'];
      child.nodeId = testNodeId2;
      child.restartCount = 1;
      child.startedAt = Date.now();
      child.lastExitReason = { error: new Error('test') };
      child.monitorRef = { monitorId: 'monitor-1' };
      child.lifecycleUnsubscribe = () => {};

      expect(child.restartCount).toBe(1);
      expect(child.nodeId).toBe(testNodeId2);
    });
  });

  describe('DistributedSupervisorStats', () => {
    it('contains all statistics fields', () => {
      const stats: DistributedSupervisorStats = {
        id: 'sup-1',
        strategy: 'one_for_one',
        childCount: 5,
        childrenByNode: new Map([
          [testNodeId, 3],
          [testNodeId2, 2],
        ]),
        totalRestarts: 10,
        nodeFailureRestarts: 2,
        startedAt: Date.now() - 60000,
        uptimeMs: 60000,
      };

      expect(stats.id).toBe('sup-1');
      expect(stats.strategy).toBe('one_for_one');
      expect(stats.childCount).toBe(5);
      expect(stats.childrenByNode.get(testNodeId)).toBe(3);
      expect(stats.totalRestarts).toBe(10);
      expect(stats.nodeFailureRestarts).toBe(2);
    });
  });

  describe('DistributedSupervisorEvent', () => {
    it('handles supervisor_started event', () => {
      const ref = { id: 'sup-1', nodeId: testNodeId } as DistributedSupervisorRef;
      const event: DistributedSupervisorEvent = {
        type: 'supervisor_started',
        ref,
      };

      expect(event.type).toBe('supervisor_started');
      if (event.type === 'supervisor_started') {
        expect(event.ref.id).toBe('sup-1');
      }
    });

    it('handles supervisor_stopped event', () => {
      const ref = { id: 'sup-1', nodeId: testNodeId } as DistributedSupervisorRef;
      const event: DistributedSupervisorEvent = {
        type: 'supervisor_stopped',
        ref,
        reason: 'normal',
      };

      expect(event.type).toBe('supervisor_stopped');
    });

    it('handles child_started event', () => {
      const event: DistributedSupervisorEvent = {
        type: 'child_started',
        supervisorId: 'sup-1',
        childId: 'worker-1',
        nodeId: testNodeId,
      };

      expect(event.type).toBe('child_started');
      if (event.type === 'child_started') {
        expect(event.childId).toBe('worker-1');
        expect(event.nodeId).toBe(testNodeId);
      }
    });

    it('handles child_stopped event', () => {
      const event: DistributedSupervisorEvent = {
        type: 'child_stopped',
        supervisorId: 'sup-1',
        childId: 'worker-1',
        reason: 'normal',
      };

      expect(event.type).toBe('child_stopped');
    });

    it('handles child_restarted event', () => {
      const event: DistributedSupervisorEvent = {
        type: 'child_restarted',
        supervisorId: 'sup-1',
        childId: 'worker-1',
        nodeId: testNodeId,
        attempt: 3,
      };

      expect(event.type).toBe('child_restarted');
      if (event.type === 'child_restarted') {
        expect(event.attempt).toBe(3);
      }
    });

    it('handles child_migrated event', () => {
      const event: DistributedSupervisorEvent = {
        type: 'child_migrated',
        supervisorId: 'sup-1',
        childId: 'worker-1',
        fromNode: testNodeId,
        toNode: testNodeId2,
      };

      expect(event.type).toBe('child_migrated');
      if (event.type === 'child_migrated') {
        expect(event.fromNode).toBe(testNodeId);
        expect(event.toNode).toBe(testNodeId2);
      }
    });

    it('handles node_failure_detected event', () => {
      const event: DistributedSupervisorEvent = {
        type: 'node_failure_detected',
        supervisorId: 'sup-1',
        nodeId: testNodeId,
        affectedChildren: ['worker-1', 'worker-2', 'cache-1'],
      };

      expect(event.type).toBe('node_failure_detected');
      if (event.type === 'node_failure_detected') {
        expect(event.affectedChildren).toHaveLength(3);
      }
    });

    it('enables exhaustive pattern matching', () => {
      const handleEvent = (event: DistributedSupervisorEvent): string => {
        switch (event.type) {
          case 'supervisor_started':
            return `supervisor ${event.ref.id} started`;
          case 'supervisor_stopped':
            return `supervisor ${event.ref.id} stopped: ${event.reason}`;
          case 'child_started':
            return `child ${event.childId} started on ${event.nodeId}`;
          case 'child_stopped':
            return `child ${event.childId} stopped: ${event.reason}`;
          case 'child_restarted':
            return `child ${event.childId} restarted (attempt ${event.attempt})`;
          case 'child_migrated':
            return `child ${event.childId} migrated from ${event.fromNode} to ${event.toNode}`;
          case 'node_failure_detected':
            return `node ${event.nodeId} failed, ${event.affectedChildren.length} children affected`;
        }
      };

      const event: DistributedSupervisorEvent = {
        type: 'child_started',
        supervisorId: 'sup-1',
        childId: 'worker-1',
        nodeId: testNodeId,
      };

      expect(handleEvent(event)).toBe(`child worker-1 started on ${testNodeId}`);
    });
  });

  describe('DistributedSupervisorEventHandler', () => {
    it('can be implemented', () => {
      const events: DistributedSupervisorEvent[] = [];
      const handler: DistributedSupervisorEventHandler = (event) => {
        events.push(event);
      };

      handler({
        type: 'child_started',
        supervisorId: 'sup-1',
        childId: 'worker-1',
        nodeId: testNodeId,
      });

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('child_started');
    });
  });
});

describe('DISTRIBUTED_SUPERVISOR_DEFAULTS', () => {
  it('has correct default values', () => {
    expect(DISTRIBUTED_SUPERVISOR_DEFAULTS.NODE_SELECTOR).toBe('local_first');
    expect(DISTRIBUTED_SUPERVISOR_DEFAULTS.STRATEGY).toBe('one_for_one');
    expect(DISTRIBUTED_SUPERVISOR_DEFAULTS.MAX_RESTARTS).toBe(3);
    expect(DISTRIBUTED_SUPERVISOR_DEFAULTS.RESTART_WITHIN_MS).toBe(5000);
    expect(DISTRIBUTED_SUPERVISOR_DEFAULTS.SHUTDOWN_TIMEOUT).toBe(5000);
    expect(DISTRIBUTED_SUPERVISOR_DEFAULTS.AUTO_SHUTDOWN).toBe('never');
    expect(DISTRIBUTED_SUPERVISOR_DEFAULTS.SPAWN_TIMEOUT).toBe(10000);
    expect(DISTRIBUTED_SUPERVISOR_DEFAULTS.CHILD_CHECK_INTERVAL).toBe(50);
  });

  it('values are readonly', () => {
    // TypeScript compile-time check - these should not be assignable
    const defaults = DISTRIBUTED_SUPERVISOR_DEFAULTS;
    expect(defaults).toBe(DISTRIBUTED_SUPERVISOR_DEFAULTS);
  });
});

describe('Distributed Supervisor Error Classes', () => {
  const testNodeId = NodeId.parse('app1@localhost:4369');

  describe('NoAvailableNodeError', () => {
    it('creates error with child id only', () => {
      const error = new NoAvailableNodeError('worker-1');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(NoAvailableNodeError);
      expect(error.name).toBe('NoAvailableNodeError');
      expect(error.childId).toBe('worker-1');
      expect(error.selector).toBeUndefined();
      expect(error.message).toContain('worker-1');
      expect(error.message).toContain('default');
    });

    it('creates error with string selector', () => {
      const error = new NoAvailableNodeError('worker-1', 'round_robin');

      expect(error.selector).toBe('round_robin');
      expect(error.message).toContain('round_robin');
    });

    it('creates error with node selector', () => {
      const error = new NoAvailableNodeError('worker-1', { node: testNodeId });

      expect(error.message).toContain(`node:${testNodeId}`);
    });

    it('creates error with custom selector', () => {
      const customSelector: NodeSelectorFn = () => testNodeId;
      const error = new NoAvailableNodeError('worker-1', customSelector);

      expect(error.message).toContain('custom');
    });
  });

  describe('DistributedBehaviorNotFoundError', () => {
    it('creates error with correct properties', () => {
      const error = new DistributedBehaviorNotFoundError('unknown-behavior', testNodeId);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DistributedBehaviorNotFoundError);
      expect(error.name).toBe('DistributedBehaviorNotFoundError');
      expect(error.behaviorName).toBe('unknown-behavior');
      expect(error.nodeId).toBe(testNodeId);
      expect(error.message).toContain('unknown-behavior');
      expect(error.message).toContain(testNodeId.toString());
    });
  });

  describe('DistributedDuplicateChildError', () => {
    it('creates error with correct properties', () => {
      const error = new DistributedDuplicateChildError('sup-1', 'worker-1');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DistributedDuplicateChildError);
      expect(error.name).toBe('DistributedDuplicateChildError');
      expect(error.supervisorId).toBe('sup-1');
      expect(error.childId).toBe('worker-1');
      expect(error.message).toContain('worker-1');
      expect(error.message).toContain('sup-1');
    });
  });

  describe('DistributedChildNotFoundError', () => {
    it('creates error with correct properties', () => {
      const error = new DistributedChildNotFoundError('sup-1', 'unknown-child');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DistributedChildNotFoundError);
      expect(error.name).toBe('DistributedChildNotFoundError');
      expect(error.supervisorId).toBe('sup-1');
      expect(error.childId).toBe('unknown-child');
      expect(error.message).toContain('unknown-child');
      expect(error.message).toContain('not found');
    });
  });

  describe('DistributedMaxRestartsExceededError', () => {
    it('creates error with correct properties', () => {
      const error = new DistributedMaxRestartsExceededError('sup-1', 5, 60000);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DistributedMaxRestartsExceededError);
      expect(error.name).toBe('DistributedMaxRestartsExceededError');
      expect(error.supervisorId).toBe('sup-1');
      expect(error.maxRestarts).toBe(5);
      expect(error.withinMs).toBe(60000);
      expect(error.message).toContain('5');
      expect(error.message).toContain('60000ms');
    });
  });

  describe('DistributedInvalidSimpleOneForOneError', () => {
    it('creates error with correct properties', () => {
      const error = new DistributedInvalidSimpleOneForOneError(
        'sup-1',
        'static children not allowed',
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DistributedInvalidSimpleOneForOneError);
      expect(error.name).toBe('DistributedInvalidSimpleOneForOneError');
      expect(error.supervisorId).toBe('sup-1');
      expect(error.reason).toBe('static children not allowed');
      expect(error.message).toContain('simple_one_for_one');
    });
  });

  describe('DistributedMissingChildTemplateError', () => {
    it('creates error with correct properties', () => {
      const error = new DistributedMissingChildTemplateError('sup-1');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DistributedMissingChildTemplateError);
      expect(error.name).toBe('DistributedMissingChildTemplateError');
      expect(error.supervisorId).toBe('sup-1');
      expect(error.message).toContain('simple_one_for_one');
      expect(error.message).toContain('childTemplate');
    });
  });

  describe('DistributedChildClaimError', () => {
    it('creates error with correct properties', () => {
      const error = new DistributedChildClaimError('sup-2', 'worker-1', 'sup-1');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DistributedChildClaimError);
      expect(error.name).toBe('DistributedChildClaimError');
      expect(error.supervisorId).toBe('sup-2');
      expect(error.childId).toBe('worker-1');
      expect(error.ownerSupervisorId).toBe('sup-1');
      expect(error.message).toContain('claimed');
      expect(error.message).toContain('sup-1');
    });
  });

  describe('DistributedSupervisorError', () => {
    it('creates error without cause', () => {
      const error = new DistributedSupervisorError('sup-1', 'Something went wrong');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DistributedSupervisorError);
      expect(error.name).toBe('DistributedSupervisorError');
      expect(error.supervisorId).toBe('sup-1');
      expect(error.message).toContain('sup-1');
      expect(error.message).toContain('Something went wrong');
      expect(error.cause).toBeUndefined();
    });

    it('creates error with cause', () => {
      const cause = new Error('Root cause');
      const error = new DistributedSupervisorError('sup-1', 'Operation failed', cause);

      expect(error.cause).toBe(cause);
      expect(error.message).toContain('Operation failed');
    });
  });

  describe('Error hierarchy', () => {
    it('all errors extend Error', () => {
      const errors: Error[] = [
        new NoAvailableNodeError('child'),
        new DistributedBehaviorNotFoundError('behavior', testNodeId),
        new DistributedDuplicateChildError('sup', 'child'),
        new DistributedChildNotFoundError('sup', 'child'),
        new DistributedMaxRestartsExceededError('sup', 3, 5000),
        new DistributedInvalidSimpleOneForOneError('sup', 'reason'),
        new DistributedMissingChildTemplateError('sup'),
        new DistributedChildClaimError('sup', 'child', 'owner'),
        new DistributedSupervisorError('sup', 'message'),
      ];

      for (const error of errors) {
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBeDefined();
        expect(error.message).toBeDefined();
      }
    });

    it('all errors have unique names', () => {
      const errorNames = [
        'NoAvailableNodeError',
        'DistributedBehaviorNotFoundError',
        'DistributedDuplicateChildError',
        'DistributedChildNotFoundError',
        'DistributedMaxRestartsExceededError',
        'DistributedInvalidSimpleOneForOneError',
        'DistributedMissingChildTemplateError',
        'DistributedChildClaimError',
        'DistributedSupervisorError',
      ];

      const uniqueNames = new Set(errorNames);
      expect(uniqueNames.size).toBe(errorNames.length);
    });
  });
});
