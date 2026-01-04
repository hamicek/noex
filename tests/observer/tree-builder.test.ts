/**
 * Tests for process tree builder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  GenServer,
  Supervisor,
  Registry,
  type GenServerBehavior,
} from '../../src/index.js';
import {
  buildProcessTree,
  buildParentMap,
  countTreeNodes,
  findNodeById,
} from '../../src/observer/tree-builder.js';

function createSimpleBehavior(): GenServerBehavior<null, never, never, never> {
  return {
    init: () => null,
    handleCall: () => { throw new Error('Not implemented'); },
    handleCast: (_, state) => state,
  };
}

describe('tree-builder', () => {
  beforeEach(() => {
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
    Supervisor._clearLifecycleHandlers();
    Supervisor._resetIdCounter();
    Registry._clearLifecycleHandler();
    Registry._clear();
  });

  afterEach(async () => {
    await Supervisor._clearAll();
    GenServer._clearLifecycleHandlers();
    Registry._clearLifecycleHandler();
    Registry._clear();
  });

  describe('buildProcessTree()', () => {
    it('returns empty array when no processes exist', () => {
      const tree = buildProcessTree();
      expect(tree).toEqual([]);
    });

    it('includes standalone GenServers', async () => {
      const ref = await GenServer.start(createSimpleBehavior());

      const tree = buildProcessTree();

      expect(tree).toHaveLength(1);
      expect(tree[0]!.type).toBe('genserver');
      expect(tree[0]!.id).toBe(ref.id);
      expect(tree[0]!.stats.status).toBe('running');

      await GenServer.stop(ref);
    });

    it('includes supervisors with their children', async () => {
      const supRef = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'worker1', start: () => GenServer.start(createSimpleBehavior()) },
          { id: 'worker2', start: () => GenServer.start(createSimpleBehavior()) },
        ],
      });

      const tree = buildProcessTree();

      expect(tree).toHaveLength(1);
      expect(tree[0]!.type).toBe('supervisor');
      expect(tree[0]!.children).toHaveLength(2);

      const childNames = tree[0]!.children!.map((c) => c.name);
      expect(childNames).toContain('worker1');
      expect(childNames).toContain('worker2');

      await Supervisor.stop(supRef);
    });

    it('uses child spec id as name for supervised servers', async () => {
      const supRef = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'my-worker', start: () => GenServer.start(createSimpleBehavior()) },
        ],
      });

      const tree = buildProcessTree();
      expect(tree[0]!.children![0]!.name).toBe('my-worker');

      await Supervisor.stop(supRef);
    });

    it('uses registry name for registered servers', async () => {
      const ref = await GenServer.start(createSimpleBehavior());
      Registry.register('named-server', ref);

      const tree = buildProcessTree();

      expect(tree[0]!.name).toBe('named-server');

      await GenServer.stop(ref);
    });

    it('separates supervised from standalone servers', async () => {
      const standaloneRef = await GenServer.start(createSimpleBehavior());
      const supRef = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'supervised', start: () => GenServer.start(createSimpleBehavior()) },
        ],
      });

      const tree = buildProcessTree();

      // Supervisors first, then standalone
      expect(tree).toHaveLength(2);
      expect(tree[0]!.type).toBe('supervisor');
      expect(tree[1]!.type).toBe('genserver');
      expect(tree[1]!.id).toBe(standaloneRef.id);

      await GenServer.stop(standaloneRef);
      await Supervisor.stop(supRef);
    });

    it('includes correct stats for each node', async () => {
      const supRef = await Supervisor.start({
        strategy: 'one_for_all',
        children: [
          { id: 'worker', start: () => GenServer.start(createSimpleBehavior()) },
        ],
      });

      const tree = buildProcessTree();
      const supNode = tree[0]!;

      expect(supNode.stats).toHaveProperty('strategy', 'one_for_all');
      expect(supNode.stats).toHaveProperty('childCount', 1);
      expect(supNode.stats).toHaveProperty('uptimeMs');

      const childNode = supNode.children![0]!;
      expect(childNode.stats).toHaveProperty('status', 'running');
      expect(childNode.stats).toHaveProperty('queueSize', 0);

      await Supervisor.stop(supRef);
    });
  });

  describe('buildParentMap()', () => {
    it('returns empty map when no supervisors exist', () => {
      const parentMap = buildParentMap();
      expect(parentMap.size).toBe(0);
    });

    it('maps children to their supervisor', async () => {
      const supRef = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'child1', start: () => GenServer.start(createSimpleBehavior()) },
          { id: 'child2', start: () => GenServer.start(createSimpleBehavior()) },
        ],
      });

      const children = Supervisor.getChildren(supRef);
      const parentMap = buildParentMap();

      expect(parentMap.get(children[0]!.ref.id)).toBe(supRef.id);
      expect(parentMap.get(children[1]!.ref.id)).toBe(supRef.id);

      await Supervisor.stop(supRef);
    });

    it('does not include standalone servers', async () => {
      const standaloneRef = await GenServer.start(createSimpleBehavior());

      const parentMap = buildParentMap();

      expect(parentMap.has(standaloneRef.id)).toBe(false);

      await GenServer.stop(standaloneRef);
    });
  });

  describe('countTreeNodes()', () => {
    it('returns zero for empty tree', () => {
      expect(countTreeNodes([])).toBe(0);
    });

    it('counts all nodes including children', async () => {
      const supRef = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'child1', start: () => GenServer.start(createSimpleBehavior()) },
          { id: 'child2', start: () => GenServer.start(createSimpleBehavior()) },
        ],
      });

      const tree = buildProcessTree();
      const count = countTreeNodes(tree);

      // 1 supervisor + 2 children = 3
      expect(count).toBe(3);

      await Supervisor.stop(supRef);
    });

    it('counts standalone servers', async () => {
      const ref1 = await GenServer.start(createSimpleBehavior());
      const ref2 = await GenServer.start(createSimpleBehavior());

      const tree = buildProcessTree();
      expect(countTreeNodes(tree)).toBe(2);

      await GenServer.stop(ref1);
      await GenServer.stop(ref2);
    });
  });

  describe('findNodeById()', () => {
    it('returns undefined for empty tree', () => {
      expect(findNodeById([], 'nonexistent')).toBeUndefined();
    });

    it('finds root level nodes', async () => {
      const ref = await GenServer.start(createSimpleBehavior());

      const tree = buildProcessTree();
      const found = findNodeById(tree, ref.id);

      expect(found).toBeDefined();
      expect(found!.id).toBe(ref.id);

      await GenServer.stop(ref);
    });

    it('finds child nodes', async () => {
      const supRef = await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'worker', start: () => GenServer.start(createSimpleBehavior()) },
        ],
      });

      const children = Supervisor.getChildren(supRef);
      const childId = children[0]!.ref.id;

      const tree = buildProcessTree();
      const found = findNodeById(tree, childId);

      expect(found).toBeDefined();
      expect(found!.id).toBe(childId);
      expect(found!.name).toBe('worker');

      await Supervisor.stop(supRef);
    });

    it('returns undefined for non-existent id', async () => {
      const ref = await GenServer.start(createSimpleBehavior());

      const tree = buildProcessTree();
      const found = findNodeById(tree, 'nonexistent-id');

      expect(found).toBeUndefined();

      await GenServer.stop(ref);
    });
  });
});
