/**
 * Link Registry for tracking bidirectional process links.
 *
 * This module manages the local link state, providing efficient
 * lookup by link ID and by server ID. It follows the same pattern
 * as the local monitor registry in gen-server.ts but for bidirectional links.
 *
 * A link connects two processes bidirectionally: when one terminates
 * abnormally, the other is also terminated (unless trapExit is enabled).
 */

import crypto from 'node:crypto';

/**
 * Internal representation of a local link between two processes.
 */
export interface LocalLink {
  readonly linkId: string;
  readonly serverId1: string;
  readonly serverId2: string;
  readonly createdAt: number;
}

/**
 * Registry of local links.
 * Maps linkId to LocalLink.
 */
const localLinks = new Map<string, LocalLink>();

/**
 * Index: serverId -> Set of linkIds involving this server.
 * Enables efficient lookup when a process terminates.
 */
const localLinksByServer = new Map<string, Set<string>>();

/**
 * Generates a unique link ID.
 */
export function generateLinkId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(8).toString('hex');
  return `l${timestamp}-${random}`;
}

/**
 * Adds a link to the registry.
 */
export function addLink(link: LocalLink): void {
  localLinks.set(link.linkId, link);

  // Update server1 index
  let set1 = localLinksByServer.get(link.serverId1);
  if (!set1) {
    set1 = new Set();
    localLinksByServer.set(link.serverId1, set1);
  }
  set1.add(link.linkId);

  // Update server2 index
  let set2 = localLinksByServer.get(link.serverId2);
  if (!set2) {
    set2 = new Set();
    localLinksByServer.set(link.serverId2, set2);
  }
  set2.add(link.linkId);
}

/**
 * Removes a link from the registry.
 * Returns the removed link, or undefined if not found.
 */
export function removeLink(linkId: string): LocalLink | undefined {
  const link = localLinks.get(linkId);
  if (!link) {
    return undefined;
  }

  localLinks.delete(linkId);

  // Update server1 index
  const set1 = localLinksByServer.get(link.serverId1);
  if (set1) {
    set1.delete(linkId);
    if (set1.size === 0) {
      localLinksByServer.delete(link.serverId1);
    }
  }

  // Update server2 index
  const set2 = localLinksByServer.get(link.serverId2);
  if (set2) {
    set2.delete(linkId);
    if (set2.size === 0) {
      localLinksByServer.delete(link.serverId2);
    }
  }

  return link;
}

/**
 * Gets all links involving a specific server.
 * Returns pairs of (link, otherServerId) for convenience.
 */
export function getLinksByServer(serverId: string): Array<{ link: LocalLink; peerServerId: string }> {
  const linkIds = localLinksByServer.get(serverId);
  if (!linkIds) {
    return [];
  }

  const results: Array<{ link: LocalLink; peerServerId: string }> = [];
  for (const linkId of linkIds) {
    const link = localLinks.get(linkId);
    if (link) {
      const peerServerId = link.serverId1 === serverId ? link.serverId2 : link.serverId1;
      results.push({ link, peerServerId });
    }
  }
  return results;
}

/**
 * Removes all links involving a specific server.
 * Returns the removed links with their peer server IDs.
 */
export function removeLinksByServer(serverId: string): Array<{ link: LocalLink; peerServerId: string }> {
  const linkIds = localLinksByServer.get(serverId);
  if (!linkIds) {
    return [];
  }

  const removed: Array<{ link: LocalLink; peerServerId: string }> = [];
  for (const linkId of Array.from(linkIds)) {
    const link = removeLink(linkId);
    if (link) {
      const peerServerId = link.serverId1 === serverId ? link.serverId2 : link.serverId1;
      removed.push({ link, peerServerId });
    }
  }
  return removed;
}

/**
 * Checks if two servers are already linked.
 */
export function areLinked(serverId1: string, serverId2: string): boolean {
  const linkIds = localLinksByServer.get(serverId1);
  if (!linkIds) {
    return false;
  }

  for (const linkId of linkIds) {
    const link = localLinks.get(linkId);
    if (link) {
      if (
        (link.serverId1 === serverId1 && link.serverId2 === serverId2) ||
        (link.serverId1 === serverId2 && link.serverId2 === serverId1)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns the total number of active links.
 * Useful for testing.
 */
export function getLinkCount(): number {
  return localLinks.size;
}

/**
 * Clears all links from the registry.
 * Useful for testing cleanup.
 */
export function clearLinks(): void {
  localLinks.clear();
  localLinksByServer.clear();
}
