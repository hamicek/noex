/**
 * Tests for the Table Types documentation examples.
 * Verifies that all code examples from docs/learn/07-ets/02-table-types.md work correctly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Ets, EtsTable, EtsKeyNotFoundError, EtsCounterTypeError } from '../../src/index.js';

describe('Table Types Documentation Examples', () => {
  const tables: EtsTable<unknown, unknown>[] = [];

  afterEach(async () => {
    for (const table of tables) {
      await table.close();
    }
    tables.length = 0;
  });

  describe('set — The Default', () => {
    it('should work as simple key-value store with overwrites', async () => {
      const users = Ets.new<string, { name: string; email: string }>({
        name: 'users',
        type: 'set',
      });
      tables.push(users as unknown as EtsTable<unknown, unknown>);

      await users.start();

      // Insert entries
      users.insert('u1', { name: 'Alice', email: 'alice@example.com' });
      users.insert('u2', { name: 'Bob', email: 'bob@example.com' });

      // Lookup returns single value or undefined
      const alice = users.lookup('u1');
      expect(alice).toEqual({ name: 'Alice', email: 'alice@example.com' });

      const missing = users.lookup('u99');
      expect(missing).toBeUndefined();

      // Overwrite existing key
      users.insert('u1', { name: 'Alice Smith', email: 'alice.smith@example.com' });
      expect(users.lookup('u1')?.name).toBe('Alice Smith');

      // Size reflects unique keys
      expect(users.size()).toBe(2);
    });

    it('should work as session cache', async () => {
      interface Session {
        userId: string;
        createdAt: number;
        expiresAt: number;
        data: Record<string, unknown>;
      }

      const sessions = Ets.new<string, Session>({
        name: 'sessions',
        type: 'set',
      });
      tables.push(sessions as unknown as EtsTable<unknown, unknown>);

      await sessions.start();

      const sessionToken = 'token-abc123';
      const now = Date.now();

      // Store session by token
      sessions.insert(sessionToken, {
        userId: 'u123',
        createdAt: now,
        expiresAt: now + 3600000,
        data: { preferences: { theme: 'dark' } },
      });

      // Fast lookup on every request
      const session = sessions.lookup(sessionToken);
      expect(session?.userId).toBe('u123');
      expect(session?.data).toEqual({ preferences: { theme: 'dark' } });
    });
  });

  describe('ordered_set — Sorted Keys', () => {
    it('should maintain sorted order', async () => {
      const leaderboard = Ets.new<string, number>({
        name: 'leaderboard',
        type: 'ordered_set',
      });
      tables.push(leaderboard as unknown as EtsTable<unknown, unknown>);

      await leaderboard.start();

      // Insert in any order
      leaderboard.insert('charlie', 85);
      leaderboard.insert('alice', 95);
      leaderboard.insert('bob', 90);

      // toArray() and keys() return sorted results
      expect(leaderboard.keys()).toEqual(['alice', 'bob', 'charlie']);
      expect(leaderboard.toArray()).toEqual([
        ['alice', 95],
        ['bob', 90],
        ['charlie', 85],
      ]);
    });

    it('should support navigation operations', async () => {
      const scores = Ets.new<string, number>({
        name: 'scores',
        type: 'ordered_set',
      });
      tables.push(scores as unknown as EtsTable<unknown, unknown>);

      await scores.start();

      scores.insertMany([
        ['d', 4],
        ['b', 2],
        ['e', 5],
        ['a', 1],
        ['c', 3],
      ]);

      // Get first and last entries
      expect(scores.first()).toEqual({ key: 'a', value: 1 });
      expect(scores.last()).toEqual({ key: 'e', value: 5 });

      // Navigate from a key
      expect(scores.next('b')).toEqual({ key: 'c', value: 3 });
      expect(scores.prev('d')).toEqual({ key: 'c', value: 3 });

      // Edge cases
      expect(scores.next('e')).toBeUndefined();
      expect(scores.prev('a')).toBeUndefined();

      // Throws EtsKeyNotFoundError for non-existent keys
      expect(() => scores.next('missing')).toThrow(EtsKeyNotFoundError);
      expect(() => scores.next('missing')).toThrow(
        "Key 'missing' not found in ETS table 'scores'."
      );
    });

    it('should support custom comparator for numeric keys', async () => {
      const timestamps = Ets.new<number, string>({
        name: 'events',
        type: 'ordered_set',
        keyComparator: (a, b) => a - b,
      });
      tables.push(timestamps as unknown as EtsTable<unknown, unknown>);

      await timestamps.start();

      timestamps.insert(1706000000000, 'Event A');
      timestamps.insert(1705000000000, 'Event B');
      timestamps.insert(1707000000000, 'Event C');

      // Keys are now sorted numerically
      expect(timestamps.keys()).toEqual([1705000000000, 1706000000000, 1707000000000]);

      // Get earliest event
      expect(timestamps.first()).toEqual({ key: 1705000000000, value: 'Event B' });
    });

    it('should work for rate limit sliding window', async () => {
      const requestTimes = Ets.new<number, string>({
        name: 'rate-limit-window',
        type: 'ordered_set',
        keyComparator: (a, b) => a - b,
      });
      tables.push(requestTimes as unknown as EtsTable<unknown, unknown>);

      await requestTimes.start();

      // Record requests at different timestamps
      const now = Date.now();
      requestTimes.insert(now - 30000, 'u1');
      requestTimes.insert(now - 20000, 'u1');
      requestTimes.insert(now - 10000, 'u2');
      requestTimes.insert(now - 5000, 'u1');

      // Count requests in last minute
      const oneMinuteAgo = now - 60000;
      const recentRequests = requestTimes.select((timestamp) => timestamp > oneMinuteAgo);
      expect(recentRequests.length).toBe(4);
    });
  });

  describe('bag — Multiple Values, No Duplicates', () => {
    it('should allow multiple unique values per key', async () => {
      const userRoles = Ets.new<string, string>({
        name: 'user-roles',
        type: 'bag',
      });
      tables.push(userRoles as unknown as EtsTable<unknown, unknown>);

      await userRoles.start();

      // Assign roles to users
      userRoles.insert('alice', 'admin');
      userRoles.insert('alice', 'editor');
      userRoles.insert('bob', 'viewer');

      // lookup() returns array of values
      expect(userRoles.lookup('alice')).toEqual(['admin', 'editor']);
      expect(userRoles.lookup('bob')).toEqual(['viewer']);
      expect(userRoles.lookup('missing')).toEqual([]);

      // Duplicate pair is ignored
      userRoles.insert('alice', 'admin');
      expect(userRoles.lookup('alice')).toEqual(['admin', 'editor']);

      // Different value for same key is added
      userRoles.insert('alice', 'moderator');
      expect(userRoles.lookup('alice')).toEqual(['admin', 'editor', 'moderator']);
    });

    it('should support selective deletion', async () => {
      const userRoles = Ets.new<string, string>({
        name: 'user-roles-delete',
        type: 'bag',
      });
      tables.push(userRoles as unknown as EtsTable<unknown, unknown>);

      await userRoles.start();

      userRoles.insert('bob', 'editor');
      userRoles.insert('bob', 'viewer');
      expect(userRoles.lookup('bob')).toEqual(['editor', 'viewer']);

      // deleteObject removes only that specific pair
      userRoles.deleteObject('bob', 'viewer');
      expect(userRoles.lookup('bob')).toEqual(['editor']);

      // Removing last value removes the key
      userRoles.deleteObject('bob', 'editor');
      expect(userRoles.member('bob')).toBe(false);
    });

    it('should work for product tags example', async () => {
      const productTags = Ets.new<string, string>({
        name: 'product-tags',
        type: 'bag',
      });
      tables.push(productTags as unknown as EtsTable<unknown, unknown>);

      await productTags.start();

      // Tag products
      productTags.insert('laptop-001', 'electronics');
      productTags.insert('laptop-001', 'computers');
      productTags.insert('laptop-001', 'sale');

      // Find all tags for a product
      const tags = productTags.lookup('laptop-001');
      expect(tags).toEqual(['electronics', 'computers', 'sale']);

      // Find all products with a specific tag
      const saleItems = productTags.select((_productId, tag) => tag === 'sale');
      expect(saleItems).toHaveLength(1);
      expect(saleItems[0]!.key).toBe('laptop-001');
    });
  });

  describe('duplicate_bag — Full Duplicates Allowed', () => {
    it('should allow duplicate {key, value} pairs', async () => {
      const clickEvents = Ets.new<string, number>({
        name: 'clicks',
        type: 'duplicate_bag',
      });
      tables.push(clickEvents as unknown as EtsTable<unknown, unknown>);

      await clickEvents.start();

      const timestamp = Date.now();

      // Record clicks (same event can occur multiple times)
      clickEvents.insert('buy-button', timestamp);
      clickEvents.insert('buy-button', timestamp);
      clickEvents.insert('buy-button', timestamp);

      // All entries are preserved
      expect((clickEvents.lookup('buy-button') as number[]).length).toBe(3);

      // size() counts all entries
      expect(clickEvents.size()).toBe(3);
    });

    it('should support deleteObject removing only first match', async () => {
      const events = Ets.new<string, string>({
        name: 'events',
        type: 'duplicate_bag',
      });
      tables.push(events as unknown as EtsTable<unknown, unknown>);

      await events.start();

      // Add duplicate events
      events.insert('page:home', 'view');
      events.insert('page:home', 'view');
      events.insert('page:home', 'scroll');
      events.insert('page:home', 'view');

      expect(events.lookup('page:home')).toEqual(['view', 'view', 'scroll', 'view']);

      // deleteObject removes only the FIRST matching entry
      events.deleteObject('page:home', 'view');
      expect(events.lookup('page:home')).toEqual(['view', 'scroll', 'view']);

      // delete(key) removes ALL entries for the key
      events.delete('page:home');
      expect(events.size()).toBe(0);
    });

    it('should work for activity log example', async () => {
      interface ActivityEvent {
        action: string;
        timestamp: number;
        metadata?: Record<string, unknown>;
      }

      const activityLog = Ets.new<string, ActivityEvent>({
        name: 'activity-log',
        type: 'duplicate_bag',
      });
      tables.push(activityLog as unknown as EtsTable<unknown, unknown>);

      await activityLog.start();

      function logActivity(
        userId: string,
        action: string,
        metadata?: Record<string, unknown>
      ): void {
        activityLog.insert(userId, {
          action,
          timestamp: Date.now(),
          metadata,
        });
      }

      // User can perform same action multiple times
      logActivity('u1', 'page_view', { page: '/home' });
      logActivity('u1', 'page_view', { page: '/home' });
      logActivity('u1', 'click', { button: 'signup' });
      logActivity('u1', 'page_view', { page: '/home' });

      // Get full activity history
      const userActivity = activityLog.lookup('u1') as ActivityEvent[];
      expect(userActivity.length).toBe(4);

      // Count specific actions
      const pageViews = userActivity.filter((e) => e.action === 'page_view').length;
      expect(pageViews).toBe(3);
    });
  });

  describe('bag vs duplicate_bag comparison', () => {
    it('should demonstrate the key difference', async () => {
      // bag: unique pairs only
      const bag = Ets.new<string, string>({ name: 'bag', type: 'bag' });
      tables.push(bag as unknown as EtsTable<unknown, unknown>);

      await bag.start();

      bag.insert('k', 'v');
      bag.insert('k', 'v');
      bag.insert('k', 'v');
      expect(bag.lookup('k')).toEqual(['v']);

      // duplicate_bag: all pairs stored
      const dupBag = Ets.new<string, string>({ name: 'dupbag', type: 'duplicate_bag' });
      tables.push(dupBag as unknown as EtsTable<unknown, unknown>);

      await dupBag.start();

      dupBag.insert('k', 'v');
      dupBag.insert('k', 'v');
      dupBag.insert('k', 'v');
      expect(dupBag.lookup('k')).toEqual(['v', 'v', 'v']);
    });
  });

  describe('Size and Counting', () => {
    it('should count all entries in bag types', async () => {
      const bag = Ets.new<string, number>({ name: 'test', type: 'bag' });
      tables.push(bag as unknown as EtsTable<unknown, unknown>);

      await bag.start();

      bag.insert('a', 1);
      bag.insert('a', 2);
      bag.insert('a', 3);
      bag.insert('b', 10);

      expect(bag.size()).toBe(4);
      expect(bag.keys().length).toBe(2);
    });
  });

  describe('Counter Operations and Table Types', () => {
    it('should work with set/ordered_set', async () => {
      const counters = Ets.new<string, number>({ name: 'counters', type: 'set' });
      tables.push(counters as unknown as EtsTable<unknown, unknown>);

      await counters.start();

      expect(counters.updateCounter('hits', 1)).toBe(1);
      expect(counters.updateCounter('hits', 1)).toBe(2);
      expect(counters.updateCounter('hits', 10)).toBe(12);
    });

    it('should throw EtsCounterTypeError for bag types', async () => {
      const bagCounters = Ets.new<string, number>({ name: 'bag', type: 'bag' });
      tables.push(bagCounters as unknown as EtsTable<unknown, unknown>);

      await bagCounters.start();

      expect(() => bagCounters.updateCounter('hits', 1)).toThrow(EtsCounterTypeError);
    });

    it('should support manual aggregation for bag', async () => {
      const multiCounters = Ets.new<string, number>({ name: 'multi', type: 'bag' });
      tables.push(multiCounters as unknown as EtsTable<unknown, unknown>);

      await multiCounters.start();

      // Add increments as separate entries
      multiCounters.insert('metric', 1);
      multiCounters.insert('metric', 5);
      multiCounters.insert('metric', 3);

      // Sum to get total
      const values = multiCounters.lookup('metric') as number[];
      const total = values.reduce((sum, val) => sum + val, 0);
      expect(total).toBe(9);
    });
  });

  describe('Exercise: Multi-Tenant Permission System', () => {
    type Permission = 'read' | 'write' | 'delete' | 'admin';

    it('should implement the permission system correctly', async () => {
      // Use 'bag' — multiple permissions per key, but each permission unique
      const permissions = Ets.new<string, Permission>({
        name: 'permissions',
        type: 'bag',
      });
      tables.push(permissions as unknown as EtsTable<unknown, unknown>);

      await permissions.start();

      function makeKey(userId: string, resourceId: string): string {
        return `${userId}:${resourceId}`;
      }

      function grant(userId: string, resourceId: string, permission: Permission): void {
        const key = makeKey(userId, resourceId);
        permissions.insert(key, permission);
      }

      function revoke(userId: string, resourceId: string, permission: Permission): boolean {
        const key = makeKey(userId, resourceId);
        return permissions.deleteObject(key, permission);
      }

      function hasPermission(
        userId: string,
        resourceId: string,
        permission: Permission
      ): boolean {
        const key = makeKey(userId, resourceId);
        const perms = permissions.lookup(key) as Permission[];
        return perms.includes(permission);
      }

      function getPermissions(userId: string, resourceId: string): Permission[] {
        const key = makeKey(userId, resourceId);
        return permissions.lookup(key) as Permission[];
      }

      function getAllUserPermissions(
        userId: string
      ): Array<{ resourceId: string; permission: Permission }> {
        const matches = permissions.match(`${userId}:*`);
        return matches.map(({ key, value }) => {
          const resourceId = (key as string).split(':')[1]!;
          return { resourceId, permission: value };
        });
      }

      // Test the system
      grant('alice', 'doc-1', 'read');
      grant('alice', 'doc-1', 'write');
      grant('alice', 'doc-1', 'read'); // no-op, already exists
      grant('alice', 'doc-2', 'read');
      grant('bob', 'doc-1', 'read');

      expect(hasPermission('alice', 'doc-1', 'read')).toBe(true);
      expect(hasPermission('alice', 'doc-1', 'delete')).toBe(false);

      expect(getPermissions('alice', 'doc-1')).toEqual(['read', 'write']);

      const alicePerms = getAllUserPermissions('alice');
      expect(alicePerms).toHaveLength(3);
      expect(alicePerms).toContainEqual({ resourceId: 'doc-1', permission: 'read' });
      expect(alicePerms).toContainEqual({ resourceId: 'doc-1', permission: 'write' });
      expect(alicePerms).toContainEqual({ resourceId: 'doc-2', permission: 'read' });

      revoke('alice', 'doc-1', 'write');
      expect(getPermissions('alice', 'doc-1')).toEqual(['read']);
    });
  });
});
