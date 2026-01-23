import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RemoteLink,
  RemoteLinkTimeoutError,
  _resetRemoteLinkState,
} from '../../src/distribution/monitor/remote-link.js';
import { generateLinkId } from '../../src/distribution/serialization.js';
import { NodeId } from '../../src/distribution/node-id.js';
import { GenServer } from '../../src/core/gen-server.js';
import type {
  LinkAckMessage,
  LinkRequestMessage,
  UnlinkRequestMessage,
  ExitSignalMessage,
  SerializedRef,
  ClusterMessage,
  LinkId,
} from '../../src/distribution/types.js';
import type { GenServerRef, GenServerBehavior } from '../../src/core/types.js';

// Mock Cluster module
vi.mock('../../src/distribution/cluster/cluster.js', () => {
  const sentMessages: Array<{ nodeId: string; message: ClusterMessage }> = [];
  let isConnected = true;
  let mockLocalNodeId = 'local@127.0.0.1:4369';
  const nodeDownHandlers: Array<(nodeId: string, reason: string) => void> = [];

  return {
    Cluster: {
      _getTransport: () => ({
        isConnectedTo: (_nodeId: string) => isConnected,
        send: async (nodeId: string, message: ClusterMessage) => {
          sentMessages.push({ nodeId, message });
        },
      }),
      getLocalNodeId: () => mockLocalNodeId,
      onNodeDown: (handler: (nodeId: string, reason: string) => void) => {
        nodeDownHandlers.push(handler);
        return () => {
          const index = nodeDownHandlers.indexOf(handler);
          if (index !== -1) {
            nodeDownHandlers.splice(index, 1);
          }
        };
      },
      getStatus: () => 'running',
      // Test helpers
      _getSentMessages: () => sentMessages,
      _clearSentMessages: () => {
        sentMessages.length = 0;
      },
      _setConnected: (connected: boolean) => {
        isConnected = connected;
      },
      _setLocalNodeId: (nodeId: string) => {
        mockLocalNodeId = nodeId;
      },
      _simulateNodeDown: (nodeId: string, reason: string) => {
        for (const handler of [...nodeDownHandlers]) {
          handler(nodeId, reason);
        }
      },
      _clearNodeDownHandlers: () => {
        nodeDownHandlers.length = 0;
      },
    },
  };
});

import { Cluster } from '../../src/distribution/cluster/cluster.js';

const ClusterTest = Cluster as typeof Cluster & {
  _getSentMessages: () => Array<{ nodeId: string; message: ClusterMessage }>;
  _clearSentMessages: () => void;
  _setConnected: (connected: boolean) => void;
  _setLocalNodeId: (nodeId: string) => void;
  _simulateNodeDown: (nodeId: string, reason: string) => void;
  _clearNodeDownHandlers: () => void;
};

// =============================================================================
// Test Helpers
// =============================================================================

function createMockRef(id: string, nodeId?: string): GenServerRef {
  return { id, nodeId } as GenServerRef;
}

function createCounterBehavior(): GenServerBehavior<{ count: number }, { type: 'inc' }, { type: 'inc' }, number> {
  return {
    init: () => ({ count: 0 }),
    handleCall: (msg, state) => {
      if (msg.type === 'inc') {
        return { reply: state.count + 1, newState: { count: state.count + 1 } };
      }
      return { reply: state.count, newState: state };
    },
    handleCast: (msg, state) => {
      if (msg.type === 'inc') {
        return { count: state.count + 1 };
      }
      return state;
    },
  };
}

function createTrapExitBehavior(): GenServerBehavior<
  { exitSignals: Array<{ from: string; reason: string }> },
  { type: 'getExitSignals' },
  never,
  Array<{ from: string; reason: string }>
> {
  return {
    init: () => ({ exitSignals: [] }),
    handleCall: (_msg, state) => [state.exitSignals, state],
    handleCast: (_msg, state) => state,
    handleInfo: (info, state) => {
      if (info && typeof info === 'object' && 'type' in info && info.type === 'EXIT') {
        const signal = info as { from: SerializedRef; reason: { type: string } };
        return {
          exitSignals: [
            ...state.exitSignals,
            { from: signal.from.id, reason: signal.reason.type },
          ],
        };
      }
      return state;
    },
  };
}

async function establishLink(
  localRefId: string,
  remoteRefId: string,
  remoteNodeId: string,
  timeout = 1000,
): Promise<{ linkId: LinkId; promise: Promise<ReturnType<typeof RemoteLink.link>> }> {
  const localRef = createMockRef(localRefId);
  const remoteRef = createMockRef(remoteRefId, remoteNodeId);

  const promise = RemoteLink.link(localRef, remoteRef, { timeout });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const sentMessages = ClusterTest._getSentMessages();
  const request = sentMessages[sentMessages.length - 1].message as LinkRequestMessage;

  return { linkId: request.linkId, promise };
}

async function establishAndAckLink(
  localRefId: string,
  remoteRefId: string,
  remoteNodeId: string,
): Promise<ReturnType<typeof RemoteLink.link>> {
  const { linkId, promise } = await establishLink(localRefId, remoteRefId, remoteNodeId);

  const ack: LinkAckMessage = {
    type: 'link_ack',
    linkId,
    success: true,
  };
  RemoteLink._handleLinkAck(ack);

  return promise;
}

// =============================================================================
// Tests
// =============================================================================

describe('RemoteLink', () => {
  let localNodeId: ReturnType<typeof NodeId.parse>;
  let remoteNodeId: ReturnType<typeof NodeId.parse>;

  beforeEach(() => {
    localNodeId = NodeId.parse('local@127.0.0.1:4369');
    remoteNodeId = NodeId.parse('remote@127.0.0.1:4370');

    ClusterTest._setLocalNodeId(localNodeId as string);
    ClusterTest._setConnected(true);
    ClusterTest._clearSentMessages();
    ClusterTest._clearNodeDownHandlers();
    GenServer._clearLifecycleHandlers();
    GenServer._clearLocalMonitors();
    GenServer._clearLocalLinks();
    GenServer._resetIdCounter();
  });

  afterEach(() => {
    _resetRemoteLinkState();
    GenServer._clearLifecycleHandlers();
  });

  // ===========================================================================
  // link() Tests
  // ===========================================================================

  describe('link', () => {
    it('sends link request to remote node', async () => {
      const localRef = createMockRef('localServer');
      const remoteRef = createMockRef('remoteServer', remoteNodeId as string);

      const linkPromise = RemoteLink.link(localRef, remoteRef, { timeout: 100 });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].nodeId).toBe(remoteNodeId);
      expect(sentMessages[0].message.type).toBe('link_request');

      const request = sentMessages[0].message as LinkRequestMessage;
      expect(request.fromRef.id).toBe('localServer');
      expect(request.fromRef.nodeId).toBe(localNodeId);
      expect(request.toRef.id).toBe('remoteServer');
      expect(request.toRef.nodeId).toBe(remoteNodeId);

      await expect(linkPromise).rejects.toThrow(RemoteLinkTimeoutError);
    });

    it('resolves with LinkRef on successful ack', async () => {
      const result = await establishAndAckLink(
        'localServer',
        'remoteServer',
        remoteNodeId as string,
      );

      expect(result.linkId).toBeDefined();
      expect(result.ref1.id).toBe('localServer');
      expect(result.ref2.id).toBe('remoteServer');
    });

    it('rejects when ack has success=false', async () => {
      const { linkId, promise } = await establishLink(
        'localServer',
        'remoteServer',
        remoteNodeId as string,
      );

      const ack: LinkAckMessage = {
        type: 'link_ack',
        linkId,
        success: false,
        reason: 'Process not found',
      };
      RemoteLink._handleLinkAck(ack);

      await expect(promise).rejects.toThrow('Process not found');
    });

    it('times out when no ack received', async () => {
      const localRef = createMockRef('localServer');
      const remoteRef = createMockRef('remoteServer', remoteNodeId as string);

      await expect(
        RemoteLink.link(localRef, remoteRef, { timeout: 50 }),
      ).rejects.toThrow(RemoteLinkTimeoutError);
    });

    it('throws when target node is not connected', async () => {
      ClusterTest._setConnected(false);

      const localRef = createMockRef('localServer');
      const remoteRef = createMockRef('remoteServer', remoteNodeId as string);

      await expect(
        RemoteLink.link(localRef, remoteRef),
      ).rejects.toThrow('not reachable');
    });

    it('throws when remote ref has no nodeId', async () => {
      const localRef = createMockRef('localServer');
      const remoteRef = createMockRef('remoteServer');

      await expect(
        RemoteLink.link(localRef, remoteRef),
      ).rejects.toThrow('must have a nodeId');
    });

    it('registers active link on successful ack', async () => {
      await establishAndAckLink('localServer', 'remoteServer', remoteNodeId as string);

      expect(RemoteLink._getActiveLinkCount()).toBe(1);

      const links = RemoteLink._getLinksByServer('localServer');
      expect(links).toHaveLength(1);
      expect(links[0].remoteRef.id).toBe('remoteServer');
    });

    it('supports multiple links from same local process', async () => {
      await establishAndAckLink('localServer', 'remote1', remoteNodeId as string);
      await establishAndAckLink('localServer', 'remote2', remoteNodeId as string);

      expect(RemoteLink._getActiveLinkCount()).toBe(2);

      const links = RemoteLink._getLinksByServer('localServer');
      expect(links).toHaveLength(2);
    });

    it('increments totalInitiated stat on each link attempt', async () => {
      const localRef = createMockRef('localServer');
      const remoteRef = createMockRef('remoteServer', remoteNodeId as string);

      const promise = RemoteLink.link(localRef, remoteRef, { timeout: 50 });
      await expect(promise).rejects.toThrow();

      expect(RemoteLink.getStats().totalInitiated).toBe(1);
    });

    it('increments totalEstablished stat on successful ack', async () => {
      await establishAndAckLink('localServer', 'remoteServer', remoteNodeId as string);

      expect(RemoteLink.getStats().totalEstablished).toBe(1);
    });
  });

  // ===========================================================================
  // unlink() Tests
  // ===========================================================================

  describe('unlink', () => {
    it('removes link from active registry', async () => {
      const linkRef = await establishAndAckLink(
        'localServer',
        'remoteServer',
        remoteNodeId as string,
      );

      expect(RemoteLink._getActiveLinkCount()).toBe(1);

      await RemoteLink.unlink(linkRef);

      expect(RemoteLink._getActiveLinkCount()).toBe(0);
    });

    it('sends unlink request to remote node', async () => {
      const linkRef = await establishAndAckLink(
        'localServer',
        'remoteServer',
        remoteNodeId as string,
      );

      ClusterTest._clearSentMessages();
      await RemoteLink.unlink(linkRef);

      // Give async fire-and-forget time to execute
      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].message.type).toBe('unlink_request');
      expect((sentMessages[0].message as UnlinkRequestMessage).linkId).toBe(linkRef.linkId);
    });

    it('does nothing if link already removed', async () => {
      const linkRef = await establishAndAckLink(
        'localServer',
        'remoteServer',
        remoteNodeId as string,
      );

      await RemoteLink.unlink(linkRef);
      ClusterTest._clearSentMessages();

      // Second unlink should be a no-op
      await RemoteLink.unlink(linkRef);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(ClusterTest._getSentMessages()).toHaveLength(0);
    });

    it('increments totalUnlinked stat', async () => {
      const linkRef = await establishAndAckLink(
        'localServer',
        'remoteServer',
        remoteNodeId as string,
      );

      await RemoteLink.unlink(linkRef);
      expect(RemoteLink.getStats().totalUnlinked).toBe(1);
    });
  });

  // ===========================================================================
  // _handleLinkRequest Tests (Incoming)
  // ===========================================================================

  describe('_handleLinkRequest', () => {
    it('sends successful ack when local process exists', async () => {
      const serverRef = await GenServer.start(createCounterBehavior());

      const linkId = generateLinkId();
      const request: LinkRequestMessage = {
        type: 'link_request',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: serverRef.id, nodeId: localNodeId },
      };

      ClusterTest._clearSentMessages();
      await RemoteLink._handleLinkRequest(request, remoteNodeId);

      const sentMessages = ClusterTest._getSentMessages();
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].message.type).toBe('link_ack');

      const ack = sentMessages[0].message as LinkAckMessage;
      expect(ack.linkId).toBe(linkId);
      expect(ack.success).toBe(true);

      await GenServer.stop(serverRef);
    });

    it('registers the link on successful request', async () => {
      const serverRef = await GenServer.start(createCounterBehavior());

      const linkId = generateLinkId();
      const request: LinkRequestMessage = {
        type: 'link_request',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: serverRef.id, nodeId: localNodeId },
      };

      await RemoteLink._handleLinkRequest(request, remoteNodeId);

      expect(RemoteLink._getActiveLinkCount()).toBe(1);
      const links = RemoteLink._getLinksByServer(serverRef.id);
      expect(links).toHaveLength(1);
      expect(links[0].remoteRef.id).toBe('remoteServer');

      await GenServer.stop(serverRef);
    });

    it('sends failed ack when local process does not exist', async () => {
      const linkId = generateLinkId();
      const request: LinkRequestMessage = {
        type: 'link_request',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: 'nonexistent', nodeId: localNodeId },
      };

      ClusterTest._clearSentMessages();
      await RemoteLink._handleLinkRequest(request, remoteNodeId);

      const sentMessages = ClusterTest._getSentMessages();
      expect(sentMessages).toHaveLength(1);

      const ack = sentMessages[0].message as LinkAckMessage;
      expect(ack.success).toBe(false);
      expect(ack.reason).toBe('Process not found');
    });

    it('sends failed ack when local process is not running', async () => {
      const serverRef = await GenServer.start(createCounterBehavior());
      await GenServer.stop(serverRef);

      const linkId = generateLinkId();
      const request: LinkRequestMessage = {
        type: 'link_request',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: serverRef.id, nodeId: localNodeId },
      };

      ClusterTest._clearSentMessages();
      await RemoteLink._handleLinkRequest(request, remoteNodeId);

      const sentMessages = ClusterTest._getSentMessages();
      const ack = sentMessages[0].message as LinkAckMessage;
      expect(ack.success).toBe(false);
    });
  });

  // ===========================================================================
  // _handleUnlinkRequest Tests
  // ===========================================================================

  describe('_handleUnlinkRequest', () => {
    it('removes the link from registry', async () => {
      const linkRef = await establishAndAckLink(
        'localServer',
        'remoteServer',
        remoteNodeId as string,
      );

      expect(RemoteLink._getActiveLinkCount()).toBe(1);

      RemoteLink._handleUnlinkRequest({
        type: 'unlink_request',
        linkId: linkRef.linkId as LinkId,
      });

      expect(RemoteLink._getActiveLinkCount()).toBe(0);
    });

    it('does nothing if link does not exist', () => {
      // Should not throw
      RemoteLink._handleUnlinkRequest({
        type: 'unlink_request',
        linkId: 'nonexistent' as LinkId,
      });

      expect(RemoteLink._getActiveLinkCount()).toBe(0);
    });
  });

  // ===========================================================================
  // _handleExitSignal Tests
  // ===========================================================================

  describe('_handleExitSignal', () => {
    it('force-terminates local process when exit signal received', async () => {
      const serverRef = await GenServer.start(createCounterBehavior());

      // Establish an incoming link (simulate remote node linked to our process)
      const linkId = generateLinkId();
      const request: LinkRequestMessage = {
        type: 'link_request',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: serverRef.id, nodeId: localNodeId },
      };
      await RemoteLink._handleLinkRequest(request, remoteNodeId);

      expect(GenServer.isRunning(serverRef)).toBe(true);

      // Simulate exit signal from remote
      const exitSignal: ExitSignalMessage = {
        type: 'exit_signal',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: serverRef.id, nodeId: localNodeId },
        reason: { type: 'error', message: 'Remote crash' },
      };
      RemoteLink._handleExitSignal(exitSignal);

      // Wait for force terminate to propagate
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(GenServer.isRunning(serverRef)).toBe(false);
    });

    it('delivers ExitSignal as info when local process has trapExit', async () => {
      const serverRef = await GenServer.start(createTrapExitBehavior(), {
        trapExit: true,
      });

      const linkId = generateLinkId();
      const request: LinkRequestMessage = {
        type: 'link_request',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: serverRef.id, nodeId: localNodeId },
      };
      await RemoteLink._handleLinkRequest(request, remoteNodeId);

      const exitSignal: ExitSignalMessage = {
        type: 'exit_signal',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: serverRef.id, nodeId: localNodeId },
        reason: { type: 'error', message: 'Remote crash' },
      };
      RemoteLink._handleExitSignal(exitSignal);

      // Wait for info message to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(GenServer.isRunning(serverRef)).toBe(true);

      const exitSignals = await GenServer.call(serverRef, { type: 'getExitSignals' } as never) as Array<{ from: string; reason: string }>;
      expect(exitSignals).toHaveLength(1);
      expect(exitSignals[0].from).toBe('remoteServer');
      expect(exitSignals[0].reason).toBe('error');

      await GenServer.stop(serverRef);
    });

    it('removes link from registry after processing exit signal', async () => {
      const serverRef = await GenServer.start(createTrapExitBehavior(), {
        trapExit: true,
      });

      const linkId = generateLinkId();
      const request: LinkRequestMessage = {
        type: 'link_request',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: serverRef.id, nodeId: localNodeId },
      };
      await RemoteLink._handleLinkRequest(request, remoteNodeId);

      expect(RemoteLink._getActiveLinkCount()).toBe(1);

      const exitSignal: ExitSignalMessage = {
        type: 'exit_signal',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: serverRef.id, nodeId: localNodeId },
        reason: { type: 'shutdown' },
      };
      RemoteLink._handleExitSignal(exitSignal);

      expect(RemoteLink._getActiveLinkCount()).toBe(0);

      await GenServer.stop(serverRef);
    });

    it('increments totalExitSignalsReceived stat', async () => {
      const serverRef = await GenServer.start(createTrapExitBehavior(), {
        trapExit: true,
      });

      const linkId = generateLinkId();
      const request: LinkRequestMessage = {
        type: 'link_request',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: serverRef.id, nodeId: localNodeId },
      };
      await RemoteLink._handleLinkRequest(request, remoteNodeId);

      RemoteLink._handleExitSignal({
        type: 'exit_signal',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: serverRef.id, nodeId: localNodeId },
        reason: { type: 'error', message: 'test' },
      });

      expect(RemoteLink.getStats().totalExitSignalsReceived).toBe(1);

      await GenServer.stop(serverRef);
    });

    it('does nothing if link not found in registry', () => {
      // Should not throw
      RemoteLink._handleExitSignal({
        type: 'exit_signal',
        linkId: 'nonexistent' as LinkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: 'localServer', nodeId: localNodeId },
        reason: { type: 'error', message: 'test' },
      });

      // Just increments the received counter even if link not found
      expect(RemoteLink.getStats().totalExitSignalsReceived).toBe(1);
    });
  });

  // ===========================================================================
  // Exit Propagation to Remote (Local Process Terminates)
  // ===========================================================================

  describe('local process termination propagation', () => {
    it('sends exit signal to remote when local process crashes', async () => {
      const serverRef = await GenServer.start(createCounterBehavior());

      // Establish an outgoing link
      await establishAndAckLink(
        serverRef.id,
        'remoteServer',
        remoteNodeId as string,
      );

      ClusterTest._clearSentMessages();

      // Terminate the local process with an error
      await GenServer.stop(serverRef, { error: new Error('crash!') });

      // Wait for lifecycle event to propagate
      await new Promise((resolve) => setTimeout(resolve, 50));

      const sentMessages = ClusterTest._getSentMessages();
      const exitSignals = sentMessages.filter(m => m.message.type === 'exit_signal');
      expect(exitSignals).toHaveLength(1);

      const signal = exitSignals[0].message as ExitSignalMessage;
      expect(signal.fromRef.id).toBe(serverRef.id);
      expect(signal.toRef.id).toBe('remoteServer');
      expect(signal.reason.type).toBe('error');
    });

    it('sends unlink request (not exit signal) on normal stop', async () => {
      const serverRef = await GenServer.start(createCounterBehavior());

      await establishAndAckLink(
        serverRef.id,
        'remoteServer',
        remoteNodeId as string,
      );

      ClusterTest._clearSentMessages();

      await GenServer.stop(serverRef);

      // Wait for lifecycle event
      await new Promise((resolve) => setTimeout(resolve, 50));

      const sentMessages = ClusterTest._getSentMessages();
      const exitSignals = sentMessages.filter(m => m.message.type === 'exit_signal');
      const unlinkRequests = sentMessages.filter(m => m.message.type === 'unlink_request');

      expect(exitSignals).toHaveLength(0);
      expect(unlinkRequests).toHaveLength(1);
    });

    it('propagates to multiple remote peers', async () => {
      const serverRef = await GenServer.start(createCounterBehavior());

      const remoteNodeId2 = NodeId.parse('remote2@127.0.0.1:4371');

      await establishAndAckLink(serverRef.id, 'remote1', remoteNodeId as string);
      await establishAndAckLink(serverRef.id, 'remote2', remoteNodeId2 as string);

      ClusterTest._clearSentMessages();

      // Terminate with error to trigger exit propagation
      await GenServer.stop(serverRef, { error: new Error('crash!') });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const sentMessages = ClusterTest._getSentMessages();
      const exitSignals = sentMessages.filter(m => m.message.type === 'exit_signal');
      expect(exitSignals).toHaveLength(2);
    });

    it('removes all links for terminated process from registry', async () => {
      const serverRef = await GenServer.start(createCounterBehavior());

      await establishAndAckLink(serverRef.id, 'remote1', remoteNodeId as string);
      await establishAndAckLink(serverRef.id, 'remote2', remoteNodeId as string);

      expect(RemoteLink._getActiveLinkCount()).toBe(2);

      // Terminate with error
      await GenServer.stop(serverRef, { error: new Error('crash!') });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(RemoteLink._getActiveLinkCount()).toBe(0);
    });
  });

  // ===========================================================================
  // Node Down Tests
  // ===========================================================================

  describe('node down handling', () => {
    it('rejects pending links to downed node', async () => {
      const localRef = createMockRef('localServer');
      const remoteRef = createMockRef('remoteServer', remoteNodeId as string);

      const linkPromise = RemoteLink.link(localRef, remoteRef, { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 10));

      ClusterTest._simulateNodeDown(remoteNodeId as string, 'heartbeat_timeout');

      await expect(linkPromise).rejects.toThrow('not reachable');
    });

    it('propagates noconnection to local processes linked to downed node', async () => {
      const serverRef = await GenServer.start(createTrapExitBehavior(), {
        trapExit: true,
      });

      // Establish outgoing link
      await establishAndAckLink(serverRef.id, 'remoteServer', remoteNodeId as string);

      ClusterTest._simulateNodeDown(remoteNodeId as string, 'connection_closed');

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(GenServer.isRunning(serverRef)).toBe(true);

      const exitSignals = await GenServer.call(serverRef, { type: 'getExitSignals' } as never) as Array<{ from: string; reason: string }>;
      expect(exitSignals).toHaveLength(1);
      expect(exitSignals[0].reason).toBe('noconnection');

      await GenServer.stop(serverRef);
    });

    it('force-terminates local process without trapExit on node down', async () => {
      const serverRef = await GenServer.start(createCounterBehavior());

      await establishAndAckLink(serverRef.id, 'remoteServer', remoteNodeId as string);

      ClusterTest._simulateNodeDown(remoteNodeId as string, 'heartbeat_timeout');

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(GenServer.isRunning(serverRef)).toBe(false);
    });

    it('removes all links to downed node from registry', async () => {
      const serverRef = await GenServer.start(createTrapExitBehavior(), {
        trapExit: true,
      });

      await establishAndAckLink(serverRef.id, 'remote1', remoteNodeId as string);
      await establishAndAckLink(serverRef.id, 'remote2', remoteNodeId as string);

      expect(RemoteLink._getActiveLinkCount()).toBe(2);

      ClusterTest._simulateNodeDown(remoteNodeId as string, 'connection_closed');

      expect(RemoteLink._getActiveLinkCount()).toBe(0);

      await GenServer.stop(serverRef);
    });

    it('only affects links to the specific downed node', async () => {
      const serverRef = await GenServer.start(createTrapExitBehavior(), {
        trapExit: true,
      });

      const remoteNodeId2 = NodeId.parse('remote2@127.0.0.1:4371');

      await establishAndAckLink(serverRef.id, 'remote1', remoteNodeId as string);
      await establishAndAckLink(serverRef.id, 'remote2', remoteNodeId2 as string);

      expect(RemoteLink._getActiveLinkCount()).toBe(2);

      ClusterTest._simulateNodeDown(remoteNodeId as string, 'connection_closed');

      expect(RemoteLink._getActiveLinkCount()).toBe(1);
      const links = RemoteLink._getLinksByServer(serverRef.id);
      expect(links[0].remoteRef.nodeId).toBe(remoteNodeId2);

      await GenServer.stop(serverRef);
    });
  });

  // ===========================================================================
  // Stats Tests
  // ===========================================================================

  describe('getStats', () => {
    it('returns correct initial stats', () => {
      const stats = RemoteLink.getStats();
      expect(stats.initialized).toBe(false);
      expect(stats.pendingCount).toBe(0);
      expect(stats.activeLinkCount).toBe(0);
      expect(stats.totalInitiated).toBe(0);
      expect(stats.totalEstablished).toBe(0);
      expect(stats.totalTimedOut).toBe(0);
      expect(stats.totalUnlinked).toBe(0);
      expect(stats.totalExitSignalsReceived).toBe(0);
      expect(stats.totalExitSignalsSent).toBe(0);
    });

    it('tracks pending count', async () => {
      const localRef = createMockRef('localServer');
      const remoteRef = createMockRef('remoteServer', remoteNodeId as string);

      const promise = RemoteLink.link(localRef, remoteRef, { timeout: 100 });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(RemoteLink.getStats().pendingCount).toBe(1);

      await expect(promise).rejects.toThrow();
      expect(RemoteLink.getStats().pendingCount).toBe(0);
    });

    it('tracks timeout count', async () => {
      const localRef = createMockRef('localServer');
      const remoteRef = createMockRef('remoteServer', remoteNodeId as string);

      await expect(
        RemoteLink.link(localRef, remoteRef, { timeout: 50 }),
      ).rejects.toThrow();

      expect(RemoteLink.getStats().totalTimedOut).toBe(1);
    });

    it('reports initialized after first operation', async () => {
      expect(RemoteLink.getStats().initialized).toBe(false);

      const localRef = createMockRef('localServer');
      const remoteRef = createMockRef('remoteServer', remoteNodeId as string);

      const promise = RemoteLink.link(localRef, remoteRef, { timeout: 50 });
      await expect(promise).rejects.toThrow();

      expect(RemoteLink.getStats().initialized).toBe(true);
    });
  });

  // ===========================================================================
  // _clear Tests
  // ===========================================================================

  describe('_clear', () => {
    it('rejects all pending links with ClusterNotStartedError', async () => {
      const localRef = createMockRef('localServer');
      const remoteRef = createMockRef('remoteServer', remoteNodeId as string);

      const promise = RemoteLink.link(localRef, remoteRef, { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 10));

      RemoteLink._clear();

      await expect(promise).rejects.toThrow('Cluster');
    });

    it('clears all active links', async () => {
      await establishAndAckLink('local1', 'remote1', remoteNodeId as string);
      await establishAndAckLink('local2', 'remote2', remoteNodeId as string);

      expect(RemoteLink._getActiveLinkCount()).toBe(2);

      RemoteLink._clear();

      expect(RemoteLink._getActiveLinkCount()).toBe(0);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('handles exit signal for already terminated process gracefully', async () => {
      const serverRef = await GenServer.start(createCounterBehavior());

      const linkId = generateLinkId();
      const request: LinkRequestMessage = {
        type: 'link_request',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: serverRef.id, nodeId: localNodeId },
      };
      await RemoteLink._handleLinkRequest(request, remoteNodeId);

      // Stop the process first
      await GenServer.stop(serverRef);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Now try to deliver exit signal - should not throw
      RemoteLink._handleExitSignal({
        type: 'exit_signal',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: serverRef.id, nodeId: localNodeId },
        reason: { type: 'error', message: 'late signal' },
      });
    });

    it('handles concurrent link and unlink gracefully', async () => {
      const linkRef = await establishAndAckLink(
        'localServer',
        'remoteServer',
        remoteNodeId as string,
      );

      // Unlink twice concurrently
      await Promise.all([
        RemoteLink.unlink(linkRef),
        RemoteLink.unlink(linkRef),
      ]);

      expect(RemoteLink._getActiveLinkCount()).toBe(0);
    });

    it('handles link ack for already-timed-out link', async () => {
      const localRef = createMockRef('localServer');
      const remoteRef = createMockRef('remoteServer', remoteNodeId as string);

      const promise = RemoteLink.link(localRef, remoteRef, { timeout: 50 });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = ClusterTest._getSentMessages();
      const request = sentMessages[0].message as LinkRequestMessage;

      // Wait for timeout
      await expect(promise).rejects.toThrow(RemoteLinkTimeoutError);

      // Late ack should be a no-op
      RemoteLink._handleLinkAck({
        type: 'link_ack',
        linkId: request.linkId,
        success: true,
      });

      expect(RemoteLink._getActiveLinkCount()).toBe(0);
    });

    it('shutdown reason propagates through link', async () => {
      const serverRef = await GenServer.start(createTrapExitBehavior(), {
        trapExit: true,
      });

      const linkId = generateLinkId();
      await RemoteLink._handleLinkRequest({
        type: 'link_request',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: serverRef.id, nodeId: localNodeId },
      }, remoteNodeId);

      RemoteLink._handleExitSignal({
        type: 'exit_signal',
        linkId,
        fromRef: { id: 'remoteServer', nodeId: remoteNodeId },
        toRef: { id: serverRef.id, nodeId: localNodeId },
        reason: { type: 'shutdown' },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const exitSignals = await GenServer.call(serverRef, { type: 'getExitSignals' } as never) as Array<{ from: string; reason: string }>;
      expect(exitSignals[0].reason).toBe('shutdown');

      await GenServer.stop(serverRef);
    });
  });
});
