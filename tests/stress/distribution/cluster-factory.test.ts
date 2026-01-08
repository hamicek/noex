/**
 * Tests for cluster-factory.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TestCluster, TestClusterFactory } from './cluster-factory.js';

describe('TestCluster', () => {
  let cluster: TestCluster | null = null;

  afterEach(async () => {
    if (cluster) {
      await cluster.stop();
      cluster = null;
    }
  }, 30000);

  describe('createCluster', () => {
    it('creates a single-node cluster', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 1,
        basePort: 28000,
      });

      expect(cluster.getRunningNodeCount()).toBe(1);
      const nodes = cluster.getNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.status).toBe('running');
      expect(nodes[0]?.nodeId).toBe('node0@127.0.0.1:28000');
    }, 15000);

    it('creates a two-node cluster and forms connections', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 2,
        basePort: 28010,
      });

      expect(cluster.getRunningNodeCount()).toBe(2);

      // Wait for full mesh
      await cluster.waitForFullMesh(10000);

      expect(cluster.isFullMesh()).toBe(true);
    }, 20000);

    it('uses custom node name prefix', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 1,
        basePort: 28020,
        nodeNamePrefix: 'worker',
      });

      const nodes = cluster.getNodes();
      expect(nodes[0]?.nodeId).toBe('worker0@127.0.0.1:28020');
    }, 15000);
  });

  describe('getNode', () => {
    it('returns node info for existing node', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 1,
        basePort: 28030,
      });

      const nodeId = 'node0@127.0.0.1:28030';
      const node = cluster.getNode(nodeId);

      expect(node).toBeDefined();
      expect(node?.nodeId).toBe(nodeId);
      expect(node?.status).toBe('running');
      expect(node?.pid).toBeGreaterThan(0);
    }, 15000);

    it('returns undefined for non-existent node', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 1,
        basePort: 28040,
      });

      const node = cluster.getNode('nonexistent@127.0.0.1:9999');
      expect(node).toBeUndefined();
    }, 15000);
  });

  describe('crashNode', () => {
    it('crashes a node with process_exit mode', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 2,
        basePort: 28050,
      });

      await cluster.waitForFullMesh(10000);

      const nodeId = 'node0@127.0.0.1:28050';
      await cluster.crashNode(nodeId, 'process_exit');

      const node = cluster.getNode(nodeId);
      expect(node?.status).toBe('crashed');
      expect(cluster.getRunningNodeCount()).toBe(1);
    }, 20000);
  });

  describe('stopNode', () => {
    it('stops a node gracefully', async () => {
      cluster = await TestClusterFactory.createCluster({
        nodeCount: 2,
        basePort: 28060,
      });

      await cluster.waitForFullMesh(10000);

      const nodeId = 'node0@127.0.0.1:28060';
      await cluster.stopNode(nodeId);

      const node = cluster.getNode(nodeId);
      expect(node?.status).toBe('stopped');
    }, 20000);
  });

  describe('events', () => {
    it('emits nodeUp events when nodes connect', async () => {
      const nodeUpEvents: string[] = [];

      cluster = new TestCluster({
        nodeCount: 2,
        basePort: 28070,
      });

      cluster.on('nodeUp', (nodeId) => {
        nodeUpEvents.push(nodeId);
      });

      await cluster._start();
      await cluster.waitForFullMesh(10000);

      // Each node should see the other connect
      expect(nodeUpEvents.length).toBeGreaterThanOrEqual(2);
    }, 20000);

    it('emits nodeDown events when nodes disconnect', async () => {
      const nodeDownEvents: Array<{ nodeId: string; reason: string }> = [];

      cluster = await TestClusterFactory.createCluster({
        nodeCount: 2,
        basePort: 28080,
      });

      await cluster.waitForFullMesh(10000);

      cluster.on('nodeDown', (nodeId, reason) => {
        nodeDownEvents.push({ nodeId, reason });
      });

      // Crash one node
      await cluster.crashNode('node0@127.0.0.1:28080', 'process_exit');

      // Wait a bit for the event
      await new Promise((resolve) => setTimeout(resolve, 2000));

      expect(nodeDownEvents.length).toBeGreaterThan(0);
    }, 25000);
  });
});

describe('TestClusterFactory', () => {
  let cluster: TestCluster | null = null;

  afterEach(async () => {
    if (cluster) {
      await cluster.stop();
      cluster = null;
    }
  }, 30000);

  it('provides convenience methods', async () => {
    cluster = await TestClusterFactory.createCluster({
      nodeCount: 2,
      basePort: 28090,
    });

    await TestClusterFactory.waitForFullMesh(cluster, 10000);
    expect(cluster.isFullMesh()).toBe(true);

    await TestClusterFactory.crashNode(cluster, 'node0@127.0.0.1:28090');
    expect(cluster.getRunningNodeCount()).toBe(1);
  }, 25000);
});
