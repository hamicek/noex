import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MonitorHandler } from '../../../src/distribution/monitor/monitor-handler.js';
import { generateMonitorId } from '../../../src/distribution/serialization.js';
import { NodeId } from '../../../src/distribution/node-id.js';
import { GenServer } from '../../../src/core/gen-server.js';
import type {
  MonitorRequestMessage,
  DemonitorRequestMessage,
  MonitorAckMessage,
  ProcessDownMessage,
  SerializedRef,
  MonitorId,
} from '../../../src/distribution/types.js';

describe('MonitorHandler', () => {
  let handler: MonitorHandler;
  let localNodeId: ReturnType<typeof NodeId.parse>;
  let remoteNodeId: ReturnType<typeof NodeId.parse>;
  let sentMessages: Array<{ nodeId: string; message: MonitorAckMessage | ProcessDownMessage }>;
  let existingProcesses: Set<string>;

  const createSerializedRef = (
    id: string,
    nodeId: ReturnType<typeof NodeId.parse>,
  ): SerializedRef => ({
    id,
    nodeId,
  });

  beforeEach(() => {
    localNodeId = NodeId.parse('local@127.0.0.1:4369');
    remoteNodeId = NodeId.parse('remote@127.0.0.1:4370');
    sentMessages = [];
    existingProcesses = new Set(['existingServer', 'anotherServer']);

    handler = new MonitorHandler({
      send: async (nodeId, message) => {
        sentMessages.push({ nodeId: nodeId as string, message });
      },
      processExists: (serverId) => existingProcesses.has(serverId),
      localNodeId,
    });

    handler.start();
  });

  afterEach(() => {
    handler.stop();
    GenServer._clearLifecycleHandlers();
  });

  // ==========================================================================
  // handleMonitorRequest Tests
  // ==========================================================================

  describe('handleMonitorRequest', () => {
    it('accepts monitor request for existing process', async () => {
      const monitorId = generateMonitorId();
      const message: MonitorRequestMessage = {
        type: 'monitor_request',
        monitorId,
        monitoringRef: createSerializedRef('remoteMonitor', remoteNodeId),
        monitoredRef: createSerializedRef('existingServer', localNodeId),
      };

      await handler.handleMonitorRequest(message, remoteNodeId);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].message.type).toBe('monitor_ack');
      const ack = sentMessages[0].message as MonitorAckMessage;
      expect(ack.success).toBe(true);
      expect(ack.monitorId).toBe(monitorId);
    });

    it('registers incoming monitor in registry', async () => {
      const monitorId = generateMonitorId();
      const message: MonitorRequestMessage = {
        type: 'monitor_request',
        monitorId,
        monitoringRef: createSerializedRef('remoteMonitor', remoteNodeId),
        monitoredRef: createSerializedRef('existingServer', localNodeId),
      };

      await handler.handleMonitorRequest(message, remoteNodeId);

      const registry = handler._getRegistry();
      expect(registry.getIncoming(monitorId)).toBeDefined();
      expect(registry.incomingCount).toBe(1);
    });

    it('sends noproc for non-existent process', async () => {
      const monitorId = generateMonitorId();
      const message: MonitorRequestMessage = {
        type: 'monitor_request',
        monitorId,
        monitoringRef: createSerializedRef('remoteMonitor', remoteNodeId),
        monitoredRef: createSerializedRef('nonExistentServer', localNodeId),
      };

      await handler.handleMonitorRequest(message, remoteNodeId);

      // Should send ack (success=true) followed by process_down with noproc
      expect(sentMessages).toHaveLength(2);

      const ack = sentMessages[0].message as MonitorAckMessage;
      expect(ack.type).toBe('monitor_ack');
      expect(ack.success).toBe(true);

      const down = sentMessages[1].message as ProcessDownMessage;
      expect(down.type).toBe('process_down');
      expect(down.monitorId).toBe(monitorId);
      expect(down.reason.type).toBe('noproc');
    });

    it('does not register monitor for non-existent process', async () => {
      const monitorId = generateMonitorId();
      const message: MonitorRequestMessage = {
        type: 'monitor_request',
        monitorId,
        monitoringRef: createSerializedRef('remoteMonitor', remoteNodeId),
        monitoredRef: createSerializedRef('nonExistentServer', localNodeId),
      };

      await handler.handleMonitorRequest(message, remoteNodeId);

      const registry = handler._getRegistry();
      expect(registry.getIncoming(monitorId)).toBeUndefined();
      expect(registry.incomingCount).toBe(0);
    });

    it('rejects duplicate monitor request', async () => {
      const monitorId = generateMonitorId();
      const message: MonitorRequestMessage = {
        type: 'monitor_request',
        monitorId,
        monitoringRef: createSerializedRef('remoteMonitor', remoteNodeId),
        monitoredRef: createSerializedRef('existingServer', localNodeId),
      };

      await handler.handleMonitorRequest(message, remoteNodeId);
      sentMessages = [];

      // Send duplicate
      await handler.handleMonitorRequest(message, remoteNodeId);

      expect(sentMessages).toHaveLength(1);
      const ack = sentMessages[0].message as MonitorAckMessage;
      expect(ack.success).toBe(false);
      expect(ack.reason).toContain('already exists');
    });

    it('rejects monitor for process on wrong node', async () => {
      const monitorId = generateMonitorId();
      const otherNodeId = NodeId.parse('other@127.0.0.1:4371');
      const message: MonitorRequestMessage = {
        type: 'monitor_request',
        monitorId,
        monitoringRef: createSerializedRef('remoteMonitor', remoteNodeId),
        monitoredRef: createSerializedRef('existingServer', otherNodeId), // Wrong node
      };

      await handler.handleMonitorRequest(message, remoteNodeId);

      expect(sentMessages).toHaveLength(1);
      const ack = sentMessages[0].message as MonitorAckMessage;
      expect(ack.success).toBe(false);
      expect(ack.reason).toContain('not on this node');
    });

    it('tracks multiple monitors for same server', async () => {
      const messages: MonitorRequestMessage[] = [];
      for (let i = 0; i < 3; i++) {
        messages.push({
          type: 'monitor_request',
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef(`remoteMonitor${i}`, remoteNodeId),
          monitoredRef: createSerializedRef('existingServer', localNodeId),
        });
      }

      for (const msg of messages) {
        await handler.handleMonitorRequest(msg, remoteNodeId);
      }

      const registry = handler._getRegistry();
      expect(registry.incomingCount).toBe(3);

      const monitors = registry.getIncomingByMonitoredServer('existingServer');
      expect(monitors).toHaveLength(3);
    });
  });

  // ==========================================================================
  // handleDemonitorRequest Tests
  // ==========================================================================

  describe('handleDemonitorRequest', () => {
    it('removes existing monitor', async () => {
      const monitorId = generateMonitorId();

      // First establish monitor
      await handler.handleMonitorRequest(
        {
          type: 'monitor_request',
          monitorId,
          monitoringRef: createSerializedRef('remoteMonitor', remoteNodeId),
          monitoredRef: createSerializedRef('existingServer', localNodeId),
        },
        remoteNodeId,
      );

      const registry = handler._getRegistry();
      expect(registry.incomingCount).toBe(1);

      // Now demonitor
      const demonitorMsg: DemonitorRequestMessage = {
        type: 'demonitor_request',
        monitorId,
      };
      handler.handleDemonitorRequest(demonitorMsg);

      expect(registry.incomingCount).toBe(0);
      expect(registry.getIncoming(monitorId)).toBeUndefined();
    });

    it('handles demonitor for non-existent monitor gracefully', () => {
      const demonitorMsg: DemonitorRequestMessage = {
        type: 'demonitor_request',
        monitorId: generateMonitorId(),
      };

      // Should not throw
      expect(() => handler.handleDemonitorRequest(demonitorMsg)).not.toThrow();
    });

    it('updates statistics on demonitor', async () => {
      const monitorId = generateMonitorId();

      await handler.handleMonitorRequest(
        {
          type: 'monitor_request',
          monitorId,
          monitoringRef: createSerializedRef('remoteMonitor', remoteNodeId),
          monitoredRef: createSerializedRef('existingServer', localNodeId),
        },
        remoteNodeId,
      );

      handler.handleDemonitorRequest({
        type: 'demonitor_request',
        monitorId,
      });

      const stats = handler.getStats();
      expect(stats.totalDemonitorRequests).toBe(1);
    });
  });

  // ==========================================================================
  // handleNodeDown Tests
  // ==========================================================================

  describe('handleNodeDown', () => {
    it('removes all incoming monitors from disconnected node', async () => {
      // Establish monitors from remoteNodeId
      for (let i = 0; i < 3; i++) {
        await handler.handleMonitorRequest(
          {
            type: 'monitor_request',
            monitorId: generateMonitorId(),
            monitoringRef: createSerializedRef(`remoteMonitor${i}`, remoteNodeId),
            monitoredRef: createSerializedRef('existingServer', localNodeId),
          },
          remoteNodeId,
        );
      }

      const registry = handler._getRegistry();
      expect(registry.incomingCount).toBe(3);

      // Simulate node disconnect
      const removedCount = handler.handleNodeDown(remoteNodeId);

      expect(removedCount).toBe(3);
      expect(registry.incomingCount).toBe(0);
    });

    it('only removes monitors from specified node', async () => {
      const otherNodeId = NodeId.parse('other@127.0.0.1:4371');

      // Monitor from remoteNodeId
      await handler.handleMonitorRequest(
        {
          type: 'monitor_request',
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef('remoteMonitor1', remoteNodeId),
          monitoredRef: createSerializedRef('existingServer', localNodeId),
        },
        remoteNodeId,
      );

      // Monitor from otherNodeId
      await handler.handleMonitorRequest(
        {
          type: 'monitor_request',
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef('otherMonitor1', otherNodeId),
          monitoredRef: createSerializedRef('existingServer', localNodeId),
        },
        otherNodeId,
      );

      const registry = handler._getRegistry();
      expect(registry.incomingCount).toBe(2);

      // Disconnect only remoteNodeId
      handler.handleNodeDown(remoteNodeId);

      expect(registry.incomingCount).toBe(1);
    });

    it('returns 0 when no monitors from disconnected node', () => {
      const unknownNodeId = NodeId.parse('unknown@127.0.0.1:9999');
      const removedCount = handler.handleNodeDown(unknownNodeId);

      expect(removedCount).toBe(0);
    });
  });

  // ==========================================================================
  // Statistics Tests
  // ==========================================================================

  describe('getStats', () => {
    it('returns initial stats', () => {
      const stats = handler.getStats();

      expect(stats.activeIncomingMonitors).toBe(0);
      expect(stats.totalMonitorRequests).toBe(0);
      expect(stats.successfulMonitors).toBe(0);
      expect(stats.noprocResponses).toBe(0);
      expect(stats.totalDemonitorRequests).toBe(0);
      expect(stats.totalProcessDownSent).toBe(0);
    });

    it('tracks successful monitor requests', async () => {
      await handler.handleMonitorRequest(
        {
          type: 'monitor_request',
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef('remoteMonitor', remoteNodeId),
          monitoredRef: createSerializedRef('existingServer', localNodeId),
        },
        remoteNodeId,
      );

      const stats = handler.getStats();
      expect(stats.totalMonitorRequests).toBe(1);
      expect(stats.successfulMonitors).toBe(1);
      expect(stats.activeIncomingMonitors).toBe(1);
    });

    it('tracks noproc responses', async () => {
      await handler.handleMonitorRequest(
        {
          type: 'monitor_request',
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef('remoteMonitor', remoteNodeId),
          monitoredRef: createSerializedRef('nonExistentServer', localNodeId),
        },
        remoteNodeId,
      );

      const stats = handler.getStats();
      expect(stats.totalMonitorRequests).toBe(1);
      expect(stats.noprocResponses).toBe(1);
      expect(stats.totalProcessDownSent).toBe(1);
      expect(stats.activeIncomingMonitors).toBe(0);
    });
  });

  // ==========================================================================
  // Lifecycle Integration Tests
  // ==========================================================================

  describe('lifecycle integration', () => {
    it('starts and stops cleanly', () => {
      const newHandler = new MonitorHandler({
        send: vi.fn(),
        processExists: () => true,
        localNodeId,
      });

      expect(() => newHandler.start()).not.toThrow();
      expect(() => newHandler.stop()).not.toThrow();
    });

    it('can be started multiple times safely', () => {
      expect(() => {
        handler.start();
        handler.start();
      }).not.toThrow();
    });

    it('clears registry on stop', async () => {
      await handler.handleMonitorRequest(
        {
          type: 'monitor_request',
          monitorId: generateMonitorId(),
          monitoringRef: createSerializedRef('remoteMonitor', remoteNodeId),
          monitoredRef: createSerializedRef('existingServer', localNodeId),
        },
        remoteNodeId,
      );

      const registry = handler._getRegistry();
      expect(registry.incomingCount).toBe(1);

      handler.stop();

      expect(registry.incomingCount).toBe(0);
    });
  });

  // ==========================================================================
  // Error Handling Tests
  // ==========================================================================

  describe('error handling', () => {
    it('handles send errors gracefully', async () => {
      const failingHandler = new MonitorHandler({
        send: async () => {
          throw new Error('Network error');
        },
        processExists: () => true,
        localNodeId,
      });
      failingHandler.start();

      // Should not throw despite send error
      await expect(
        failingHandler.handleMonitorRequest(
          {
            type: 'monitor_request',
            monitorId: generateMonitorId(),
            monitoringRef: createSerializedRef('remoteMonitor', remoteNodeId),
            monitoredRef: createSerializedRef('existingServer', localNodeId),
          },
          remoteNodeId,
        ),
      ).resolves.not.toThrow();

      failingHandler.stop();
    });
  });

  // ==========================================================================
  // Complex Scenarios
  // ==========================================================================

  describe('complex scenarios', () => {
    it('handles high volume of monitor requests', async () => {
      const monitorIds: MonitorId[] = [];

      for (let i = 0; i < 100; i++) {
        const monitorId = generateMonitorId();
        monitorIds.push(monitorId);
        await handler.handleMonitorRequest(
          {
            type: 'monitor_request',
            monitorId,
            monitoringRef: createSerializedRef(`remoteMonitor${i}`, remoteNodeId),
            monitoredRef: createSerializedRef('existingServer', localNodeId),
          },
          remoteNodeId,
        );
      }

      const registry = handler._getRegistry();
      expect(registry.incomingCount).toBe(100);

      const stats = handler.getStats();
      expect(stats.totalMonitorRequests).toBe(100);
      expect(stats.successfulMonitors).toBe(100);
    });

    it('handles interleaved monitor/demonitor requests', async () => {
      const monitorIds: MonitorId[] = [];

      // Add 10 monitors
      for (let i = 0; i < 10; i++) {
        const monitorId = generateMonitorId();
        monitorIds.push(monitorId);
        await handler.handleMonitorRequest(
          {
            type: 'monitor_request',
            monitorId,
            monitoringRef: createSerializedRef(`remoteMonitor${i}`, remoteNodeId),
            monitoredRef: createSerializedRef('existingServer', localNodeId),
          },
          remoteNodeId,
        );
      }

      // Remove half
      for (let i = 0; i < 5; i++) {
        handler.handleDemonitorRequest({
          type: 'demonitor_request',
          monitorId: monitorIds[i],
        });
      }

      // Add 3 more
      for (let i = 0; i < 3; i++) {
        await handler.handleMonitorRequest(
          {
            type: 'monitor_request',
            monitorId: generateMonitorId(),
            monitoringRef: createSerializedRef(`newMonitor${i}`, remoteNodeId),
            monitoredRef: createSerializedRef('existingServer', localNodeId),
          },
          remoteNodeId,
        );
      }

      const registry = handler._getRegistry();
      expect(registry.incomingCount).toBe(8); // 10 - 5 + 3

      const stats = handler.getStats();
      expect(stats.totalMonitorRequests).toBe(13);
      expect(stats.totalDemonitorRequests).toBe(5);
    });

    it('handles monitors from multiple nodes', async () => {
      const node1 = NodeId.parse('node1@127.0.0.1:4371');
      const node2 = NodeId.parse('node2@127.0.0.1:4372');
      const node3 = NodeId.parse('node3@127.0.0.1:4373');

      for (const nodeId of [node1, node2, node3]) {
        for (let i = 0; i < 5; i++) {
          await handler.handleMonitorRequest(
            {
              type: 'monitor_request',
              monitorId: generateMonitorId(),
              monitoringRef: createSerializedRef(`monitor${i}`, nodeId),
              monitoredRef: createSerializedRef('existingServer', localNodeId),
            },
            nodeId,
          );
        }
      }

      const registry = handler._getRegistry();
      expect(registry.incomingCount).toBe(15);

      // Disconnect one node
      handler.handleNodeDown(node2);
      expect(registry.incomingCount).toBe(10);
    });
  });
});
