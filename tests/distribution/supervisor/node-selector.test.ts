import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NodeId } from '../../../src/distribution/node-id.js';
import type { NodeInfo } from '../../../src/distribution/types.js';
import { NodeSelectorImpl } from '../../../src/distribution/supervisor/node-selector.js';
import { NoAvailableNodeError } from '../../../src/distribution/supervisor/types.js';
import type { NodeSelector, NodeSelectorFn } from '../../../src/distribution/supervisor/types.js';

describe('NodeSelectorImpl', () => {
  const localNodeId = NodeId.parse('local@localhost:4369');
  const nodeA = NodeId.parse('nodeA@localhost:4370');
  const nodeB = NodeId.parse('nodeB@localhost:4371');
  const nodeC = NodeId.parse('nodeC@localhost:4372');

  const createNodeInfo = (
    id: NodeId,
    processCount = 0,
    status: NodeInfo['status'] = 'connected',
  ): NodeInfo => ({
    id,
    host: 'localhost',
    port: NodeId.getPort(id),
    status,
    processCount,
    lastHeartbeatAt: Date.now(),
    uptimeMs: 10000,
  });

  beforeEach(() => {
    NodeSelectorImpl._resetRoundRobinCounter();
  });

  describe('selectNodeWithContext', () => {
    describe('local_first strategy', () => {
      it('returns local node when no exclusion', () => {
        const nodes = [createNodeInfo(nodeA), createNodeInfo(nodeB)];

        const selected = NodeSelectorImpl.selectNodeWithContext(
          'local_first',
          'child-1',
          localNodeId,
          nodes,
        );

        expect(selected).toBe(localNodeId);
      });

      it('falls back to connected node when local is excluded', () => {
        const nodes = [createNodeInfo(nodeA), createNodeInfo(nodeB)];

        const selected = NodeSelectorImpl.selectNodeWithContext(
          'local_first',
          'child-1',
          localNodeId,
          nodes,
          localNodeId,
        );

        expect(selected).toBe(nodeA);
      });

      it('throws NoAvailableNodeError when no nodes available', () => {
        const nodes: NodeInfo[] = [];

        expect(() =>
          NodeSelectorImpl.selectNodeWithContext(
            'local_first',
            'child-1',
            localNodeId,
            nodes,
            localNodeId,
          ),
        ).toThrow(NoAvailableNodeError);
      });

      it('skips disconnected nodes in fallback', () => {
        const nodes = [
          createNodeInfo(nodeA, 0, 'disconnected'),
          createNodeInfo(nodeB, 0, 'connected'),
        ];

        const selected = NodeSelectorImpl.selectNodeWithContext(
          'local_first',
          'child-1',
          localNodeId,
          nodes,
          localNodeId,
        );

        expect(selected).toBe(nodeB);
      });

      it('throws when all remote nodes are disconnected', () => {
        const nodes = [
          createNodeInfo(nodeA, 0, 'disconnected'),
          createNodeInfo(nodeB, 0, 'disconnected'),
        ];

        expect(() =>
          NodeSelectorImpl.selectNodeWithContext(
            'local_first',
            'child-1',
            localNodeId,
            nodes,
            localNodeId,
          ),
        ).toThrow(NoAvailableNodeError);
      });
    });

    describe('round_robin strategy', () => {
      it('cycles through all nodes including local', () => {
        const nodes = [createNodeInfo(nodeA), createNodeInfo(nodeB)];

        // First call should return local
        const first = NodeSelectorImpl.selectNodeWithContext(
          'round_robin',
          'child-1',
          localNodeId,
          nodes,
        );

        // Second call should return nodeA
        const second = NodeSelectorImpl.selectNodeWithContext(
          'round_robin',
          'child-2',
          localNodeId,
          nodes,
        );

        // Third call should return nodeB
        const third = NodeSelectorImpl.selectNodeWithContext(
          'round_robin',
          'child-3',
          localNodeId,
          nodes,
        );

        // Fourth call should wrap around to local
        const fourth = NodeSelectorImpl.selectNodeWithContext(
          'round_robin',
          'child-4',
          localNodeId,
          nodes,
        );

        expect(first).toBe(localNodeId);
        expect(second).toBe(nodeA);
        expect(third).toBe(nodeB);
        expect(fourth).toBe(localNodeId);
      });

      it('skips excluded node in rotation', () => {
        const nodes = [createNodeInfo(nodeA), createNodeInfo(nodeB)];
        NodeSelectorImpl._resetRoundRobinCounter();

        // With local excluded, should cycle through nodeA and nodeB only
        const selections: NodeId[] = [];
        for (let i = 0; i < 4; i++) {
          selections.push(
            NodeSelectorImpl.selectNodeWithContext(
              'round_robin',
              `child-${i}`,
              localNodeId,
              nodes,
              localNodeId,
            ),
          );
        }

        expect(selections).toEqual([nodeA, nodeB, nodeA, nodeB]);
      });

      it('throws when only excluded node is available', () => {
        const nodes: NodeInfo[] = [];

        expect(() =>
          NodeSelectorImpl.selectNodeWithContext(
            'round_robin',
            'child-1',
            localNodeId,
            nodes,
            localNodeId,
          ),
        ).toThrow(NoAvailableNodeError);
      });

      it('increments counter correctly', () => {
        const nodes = [createNodeInfo(nodeA)];

        expect(NodeSelectorImpl._getRoundRobinCounter()).toBe(0);

        NodeSelectorImpl.selectNodeWithContext('round_robin', 'child-1', localNodeId, nodes);
        expect(NodeSelectorImpl._getRoundRobinCounter()).toBe(1);

        NodeSelectorImpl.selectNodeWithContext('round_robin', 'child-2', localNodeId, nodes);
        expect(NodeSelectorImpl._getRoundRobinCounter()).toBe(2);
      });
    });

    describe('least_loaded strategy', () => {
      it('selects node with lowest process count', () => {
        const nodes = [
          createNodeInfo(nodeA, 10),
          createNodeInfo(nodeB, 5),
          createNodeInfo(nodeC, 15),
        ];

        const selected = NodeSelectorImpl.selectNodeWithContext(
          'least_loaded',
          'child-1',
          localNodeId,
          nodes,
        );

        // Local node has 0 process count, so it should be selected
        expect(selected).toBe(localNodeId);
      });

      it('selects least loaded remote when local is excluded', () => {
        const nodes = [
          createNodeInfo(nodeA, 10),
          createNodeInfo(nodeB, 5),
          createNodeInfo(nodeC, 15),
        ];

        const selected = NodeSelectorImpl.selectNodeWithContext(
          'least_loaded',
          'child-1',
          localNodeId,
          nodes,
          localNodeId,
        );

        expect(selected).toBe(nodeB);
      });

      it('skips excluded remote node', () => {
        const nodes = [
          createNodeInfo(nodeA, 5),  // Lowest but excluded
          createNodeInfo(nodeB, 10),
          createNodeInfo(nodeC, 15),
        ];

        const selected = NodeSelectorImpl.selectNodeWithContext(
          'least_loaded',
          'child-1',
          localNodeId,
          nodes,
          nodeA,
        );

        // Should select local (0) since nodeA is excluded
        expect(selected).toBe(localNodeId);
      });

      it('throws when no nodes available', () => {
        const nodes: NodeInfo[] = [];

        expect(() =>
          NodeSelectorImpl.selectNodeWithContext(
            'least_loaded',
            'child-1',
            localNodeId,
            nodes,
            localNodeId,
          ),
        ).toThrow(NoAvailableNodeError);
      });

      it('skips disconnected nodes', () => {
        const nodes = [
          createNodeInfo(nodeA, 1, 'disconnected'),
          createNodeInfo(nodeB, 100, 'connected'),
        ];

        const selected = NodeSelectorImpl.selectNodeWithContext(
          'least_loaded',
          'child-1',
          localNodeId,
          nodes,
          localNodeId,
        );

        expect(selected).toBe(nodeB);
      });
    });

    describe('random strategy', () => {
      it('returns a valid node', () => {
        const nodes = [createNodeInfo(nodeA), createNodeInfo(nodeB), createNodeInfo(nodeC)];

        const selected = NodeSelectorImpl.selectNodeWithContext(
          'random',
          'child-1',
          localNodeId,
          nodes,
        );

        const validNodes = [localNodeId, nodeA, nodeB, nodeC];
        expect(validNodes).toContain(selected);
      });

      it('excludes specified node', () => {
        const nodes = [createNodeInfo(nodeA), createNodeInfo(nodeB)];

        // Run multiple times to verify exclusion works
        for (let i = 0; i < 20; i++) {
          const selected = NodeSelectorImpl.selectNodeWithContext(
            'random',
            `child-${i}`,
            localNodeId,
            nodes,
            nodeA,
          );

          expect(selected).not.toBe(nodeA);
          expect([localNodeId, nodeB]).toContain(selected);
        }
      });

      it('throws when no nodes available', () => {
        const nodes: NodeInfo[] = [];

        expect(() =>
          NodeSelectorImpl.selectNodeWithContext(
            'random',
            'child-1',
            localNodeId,
            nodes,
            localNodeId,
          ),
        ).toThrow(NoAvailableNodeError);
      });

      it('skips disconnected nodes', () => {
        const nodes = [
          createNodeInfo(nodeA, 0, 'disconnected'),
          createNodeInfo(nodeB, 0, 'connected'),
        ];

        // Run multiple times - should always get nodeB or local
        for (let i = 0; i < 10; i++) {
          const selected = NodeSelectorImpl.selectNodeWithContext(
            'random',
            `child-${i}`,
            localNodeId,
            nodes,
          );

          expect([localNodeId, nodeB]).toContain(selected);
        }
      });

      it('provides distribution over many calls', () => {
        const nodes = [createNodeInfo(nodeA), createNodeInfo(nodeB)];
        const counts = new Map<NodeId, number>();

        for (let i = 0; i < 100; i++) {
          const selected = NodeSelectorImpl.selectNodeWithContext(
            'random',
            `child-${i}`,
            localNodeId,
            nodes,
          );
          counts.set(selected, (counts.get(selected) ?? 0) + 1);
        }

        // All nodes should be selected at least once in 100 iterations
        expect(counts.size).toBeGreaterThanOrEqual(2);
      });
    });

    describe('specific node selector { node: NodeId }', () => {
      it('returns specified node when available', () => {
        const nodes = [createNodeInfo(nodeA), createNodeInfo(nodeB)];

        const selected = NodeSelectorImpl.selectNodeWithContext(
          { node: nodeA },
          'child-1',
          localNodeId,
          nodes,
        );

        expect(selected).toBe(nodeA);
      });

      it('returns local node when specified', () => {
        const nodes = [createNodeInfo(nodeA)];

        const selected = NodeSelectorImpl.selectNodeWithContext(
          { node: localNodeId },
          'child-1',
          localNodeId,
          nodes,
        );

        expect(selected).toBe(localNodeId);
      });

      it('throws when specified node is excluded', () => {
        const nodes = [createNodeInfo(nodeA), createNodeInfo(nodeB)];

        expect(() =>
          NodeSelectorImpl.selectNodeWithContext(
            { node: nodeA },
            'child-1',
            localNodeId,
            nodes,
            nodeA,
          ),
        ).toThrow(NoAvailableNodeError);
      });

      it('throws when specified node is not connected', () => {
        const nodes = [createNodeInfo(nodeA, 0, 'disconnected')];

        expect(() =>
          NodeSelectorImpl.selectNodeWithContext(
            { node: nodeA },
            'child-1',
            localNodeId,
            nodes,
          ),
        ).toThrow(NoAvailableNodeError);
      });

      it('throws when specified node is not in cluster', () => {
        const unknownNode = NodeId.parse('unknown@localhost:9999');
        const nodes = [createNodeInfo(nodeA)];

        expect(() =>
          NodeSelectorImpl.selectNodeWithContext(
            { node: unknownNode },
            'child-1',
            localNodeId,
            nodes,
          ),
        ).toThrow(NoAvailableNodeError);
      });
    });

    describe('custom selector function', () => {
      it('calls custom function with filtered node list', () => {
        const nodes = [createNodeInfo(nodeA), createNodeInfo(nodeB)];
        const customSelector: NodeSelectorFn = vi.fn((availableNodes) => {
          return availableNodes[0]!.id;
        });

        NodeSelectorImpl.selectNodeWithContext(
          customSelector,
          'child-1',
          localNodeId,
          nodes,
        );

        expect(customSelector).toHaveBeenCalledTimes(1);
        const calledNodes = (customSelector as ReturnType<typeof vi.fn>).mock.calls[0]![0] as NodeInfo[];
        // Should include local + 2 remote nodes
        expect(calledNodes.length).toBe(3);
      });

      it('excludes specified node from custom function input', () => {
        const nodes = [createNodeInfo(nodeA), createNodeInfo(nodeB)];
        const customSelector: NodeSelectorFn = vi.fn((availableNodes) => {
          return availableNodes[0]!.id;
        });

        NodeSelectorImpl.selectNodeWithContext(
          customSelector,
          'child-1',
          localNodeId,
          nodes,
          localNodeId,
        );

        const calledNodes = (customSelector as ReturnType<typeof vi.fn>).mock.calls[0]![0] as NodeInfo[];
        // Should include only 2 remote nodes (local excluded)
        expect(calledNodes.length).toBe(2);
        expect(calledNodes.find((n) => n.id === localNodeId)).toBeUndefined();
      });

      it('returns result from custom function', () => {
        const nodes = [createNodeInfo(nodeA), createNodeInfo(nodeB)];
        const customSelector: NodeSelectorFn = () => nodeB;

        const selected = NodeSelectorImpl.selectNodeWithContext(
          customSelector,
          'child-1',
          localNodeId,
          nodes,
        );

        expect(selected).toBe(nodeB);
      });

      it('propagates error from custom function', () => {
        const nodes = [createNodeInfo(nodeA)];
        const customSelector: NodeSelectorFn = (_, childId) => {
          throw new NoAvailableNodeError(childId);
        };

        expect(() =>
          NodeSelectorImpl.selectNodeWithContext(
            customSelector,
            'child-1',
            localNodeId,
            nodes,
          ),
        ).toThrow(NoAvailableNodeError);
      });

      it('receives correct childId parameter', () => {
        const nodes = [createNodeInfo(nodeA)];
        let receivedChildId = '';
        const customSelector: NodeSelectorFn = (_, childId) => {
          receivedChildId = childId;
          return nodeA;
        };

        NodeSelectorImpl.selectNodeWithContext(
          customSelector,
          'my-special-child',
          localNodeId,
          nodes,
        );

        expect(receivedChildId).toBe('my-special-child');
      });

      it('filters disconnected nodes before calling custom function', () => {
        const nodes = [
          createNodeInfo(nodeA, 0, 'disconnected'),
          createNodeInfo(nodeB, 0, 'connected'),
        ];
        const customSelector: NodeSelectorFn = vi.fn((availableNodes) => {
          return availableNodes[0]!.id;
        });

        NodeSelectorImpl.selectNodeWithContext(
          customSelector,
          'child-1',
          localNodeId,
          nodes,
        );

        const calledNodes = (customSelector as ReturnType<typeof vi.fn>).mock.calls[0]![0] as NodeInfo[];
        // Should include local + nodeB (nodeA is disconnected)
        expect(calledNodes.length).toBe(2);
        expect(calledNodes.find((n) => n.id === nodeA)).toBeUndefined();
      });
    });
  });

  describe('_resetRoundRobinCounter', () => {
    it('resets counter to zero', () => {
      const nodes = [createNodeInfo(nodeA)];

      // Increment counter
      NodeSelectorImpl.selectNodeWithContext('round_robin', 'child-1', localNodeId, nodes);
      NodeSelectorImpl.selectNodeWithContext('round_robin', 'child-2', localNodeId, nodes);
      expect(NodeSelectorImpl._getRoundRobinCounter()).toBe(2);

      // Reset
      NodeSelectorImpl._resetRoundRobinCounter();
      expect(NodeSelectorImpl._getRoundRobinCounter()).toBe(0);
    });
  });

  describe('NoAvailableNodeError', () => {
    it('contains correct information for built-in strategy', () => {
      const nodes: NodeInfo[] = [];

      try {
        NodeSelectorImpl.selectNodeWithContext(
          'round_robin',
          'worker-1',
          localNodeId,
          nodes,
          localNodeId,
        );
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NoAvailableNodeError);
        const noNodeError = error as NoAvailableNodeError;
        expect(noNodeError.childId).toBe('worker-1');
        expect(noNodeError.selector).toBe('round_robin');
        expect(noNodeError.message).toContain('worker-1');
        expect(noNodeError.message).toContain('round_robin');
      }
    });

    it('contains correct information for specific node selector', () => {
      const nodes: NodeInfo[] = [];

      try {
        NodeSelectorImpl.selectNodeWithContext(
          { node: nodeA },
          'cache-1',
          localNodeId,
          nodes,
        );
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NoAvailableNodeError);
        const noNodeError = error as NoAvailableNodeError;
        expect(noNodeError.childId).toBe('cache-1');
        expect(noNodeError.message).toContain('cache-1');
        expect(noNodeError.message).toContain('node:');
      }
    });
  });

  describe('edge cases', () => {
    it('handles empty connected nodes list with local available', () => {
      const nodes: NodeInfo[] = [];

      const selected = NodeSelectorImpl.selectNodeWithContext(
        'local_first',
        'child-1',
        localNodeId,
        nodes,
      );

      expect(selected).toBe(localNodeId);
    });

    it('handles single remote node', () => {
      const nodes = [createNodeInfo(nodeA)];

      const selected = NodeSelectorImpl.selectNodeWithContext(
        'round_robin',
        'child-1',
        localNodeId,
        nodes,
        localNodeId,
      );

      expect(selected).toBe(nodeA);
    });

    it('handles all strategies with same single node', () => {
      const nodes: NodeInfo[] = [];
      const strategies: Array<NodeSelector> = [
        'local_first',
        'round_robin',
        'least_loaded',
        'random',
      ];

      for (const strategy of strategies) {
        NodeSelectorImpl._resetRoundRobinCounter();
        const selected = NodeSelectorImpl.selectNodeWithContext(
          strategy,
          'child-1',
          localNodeId,
          nodes,
        );
        expect(selected).toBe(localNodeId);
      }
    });
  });
});
