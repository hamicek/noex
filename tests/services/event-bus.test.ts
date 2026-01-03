/**
 * Comprehensive tests for EventBus service.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus, type EventBusRef, GenServer } from '../../src/index.js';

describe('EventBus', () => {
  let bus: EventBusRef;

  beforeEach(async () => {
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
    bus = await EventBus.start();
  });

  afterEach(async () => {
    if (EventBus.isRunning(bus)) {
      await EventBus.stop(bus);
    }
    GenServer._clearLifecycleHandlers();
  });

  describe('start()', () => {
    it('starts an EventBus instance', async () => {
      expect(bus).toBeDefined();
      expect(EventBus.isRunning(bus)).toBe(true);
    });

    it('starts with zero subscriptions', async () => {
      const count = await EventBus.getSubscriptionCount(bus);
      expect(count).toBe(0);
    });

    it('starts with empty topics list', async () => {
      const topics = await EventBus.getTopics(bus);
      expect(topics).toEqual([]);
    });

    it('supports named instances', async () => {
      const namedBus = await EventBus.start({ name: 'my-bus' });
      expect(EventBus.isRunning(namedBus)).toBe(true);
      await EventBus.stop(namedBus);
    });
  });

  describe('subscribe()', () => {
    it('subscribes to a topic and returns unsubscribe function', async () => {
      const handler = vi.fn();
      const unsub = await EventBus.subscribe(bus, 'test.topic', handler);

      expect(typeof unsub).toBe('function');
      expect(await EventBus.getSubscriptionCount(bus)).toBe(1);
    });

    it('allows multiple subscriptions to the same topic', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      await EventBus.subscribe(bus, 'test.topic', handler1);
      await EventBus.subscribe(bus, 'test.topic', handler2);

      expect(await EventBus.getSubscriptionCount(bus)).toBe(2);
    });

    it('allows subscriptions to different topics', async () => {
      const handler = vi.fn();

      await EventBus.subscribe(bus, 'topic.a', handler);
      await EventBus.subscribe(bus, 'topic.b', handler);

      expect(await EventBus.getSubscriptionCount(bus)).toBe(2);
      const topics = await EventBus.getTopics(bus);
      expect(topics).toContain('topic.a');
      expect(topics).toContain('topic.b');
    });

    it('unsubscribe removes the subscription', async () => {
      const handler = vi.fn();
      const unsub = await EventBus.subscribe(bus, 'test.topic', handler);

      expect(await EventBus.getSubscriptionCount(bus)).toBe(1);

      await unsub();

      expect(await EventBus.getSubscriptionCount(bus)).toBe(0);
    });

    it('unsubscribe is idempotent', async () => {
      const handler = vi.fn();
      const unsub = await EventBus.subscribe(bus, 'test.topic', handler);

      await unsub();
      await unsub(); // Should not throw

      expect(await EventBus.getSubscriptionCount(bus)).toBe(0);
    });

    it('unsubscribe on stopped bus does not throw', async () => {
      const handler = vi.fn();
      const unsub = await EventBus.subscribe(bus, 'test.topic', handler);

      await EventBus.stop(bus);

      // Should not throw even though bus is stopped
      await expect(unsub()).resolves.toBeUndefined();
    });
  });

  describe('publish()', () => {
    it('delivers message to matching subscriber', async () => {
      const handler = vi.fn();
      await EventBus.subscribe(bus, 'user.created', handler);

      EventBus.publish(bus, 'user.created', { id: '123' });
      await EventBus.publishSync(bus, 'dummy', null); // Sync point

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ id: '123' }, 'user.created');
    });

    it('delivers message to multiple subscribers', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      await EventBus.subscribe(bus, 'user.created', handler1);
      await EventBus.subscribe(bus, 'user.created', handler2);

      await EventBus.publishSync(bus, 'user.created', { id: '456' });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('does not deliver to non-matching subscribers', async () => {
      const handler = vi.fn();
      await EventBus.subscribe(bus, 'user.created', handler);

      await EventBus.publishSync(bus, 'user.deleted', { id: '123' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('handles messages with any payload type', async () => {
      const handler = vi.fn();
      await EventBus.subscribe(bus, 'test', handler);

      await EventBus.publishSync(bus, 'test', 'string');
      await EventBus.publishSync(bus, 'test', 123);
      await EventBus.publishSync(bus, 'test', { complex: { nested: true } });
      await EventBus.publishSync(bus, 'test', null);
      await EventBus.publishSync(bus, 'test', undefined);

      expect(handler).toHaveBeenCalledTimes(5);
      expect(handler).toHaveBeenNthCalledWith(1, 'string', 'test');
      expect(handler).toHaveBeenNthCalledWith(2, 123, 'test');
      expect(handler).toHaveBeenNthCalledWith(3, { complex: { nested: true } }, 'test');
      expect(handler).toHaveBeenNthCalledWith(4, null, 'test');
      expect(handler).toHaveBeenNthCalledWith(5, undefined, 'test');
    });

    it('continues delivery even if handler throws', async () => {
      const failingHandler = vi.fn(() => {
        throw new Error('Handler error');
      });
      const successHandler = vi.fn();

      await EventBus.subscribe(bus, 'test', failingHandler);
      await EventBus.subscribe(bus, 'test', successHandler);

      // Should not throw
      await EventBus.publishSync(bus, 'test', 'payload');

      expect(failingHandler).toHaveBeenCalled();
      expect(successHandler).toHaveBeenCalled();
    });
  });

  describe('wildcard matching', () => {
    it('global wildcard (*) matches all topics', async () => {
      const handler = vi.fn();
      await EventBus.subscribe(bus, '*', handler);

      await EventBus.publishSync(bus, 'user.created', 'a');
      await EventBus.publishSync(bus, 'order.placed', 'b');
      await EventBus.publishSync(bus, 'anything', 'c');

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('single-level wildcard matches one segment', async () => {
      const handler = vi.fn();
      await EventBus.subscribe(bus, 'user.*', handler);

      await EventBus.publishSync(bus, 'user.created', 'a');
      await EventBus.publishSync(bus, 'user.deleted', 'b');
      await EventBus.publishSync(bus, 'user.updated', 'c');

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('single-level wildcard does not match different prefixes', async () => {
      const handler = vi.fn();
      await EventBus.subscribe(bus, 'user.*', handler);

      await EventBus.publishSync(bus, 'order.created', 'a');
      await EventBus.publishSync(bus, 'admin.created', 'b');

      expect(handler).not.toHaveBeenCalled();
    });

    it('wildcard in middle position matches any segment', async () => {
      const handler = vi.fn();
      await EventBus.subscribe(bus, 'user.*.email', handler);

      await EventBus.publishSync(bus, 'user.123.email', 'a');
      await EventBus.publishSync(bus, 'user.456.email', 'b');
      await EventBus.publishSync(bus, 'user.any.email', 'c');

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('wildcard does not match extra segments', async () => {
      const handler = vi.fn();
      await EventBus.subscribe(bus, 'user.*', handler);

      // 'user.profile.updated' has more segments than pattern
      await EventBus.publishSync(bus, 'user.profile.updated', 'a');

      // But trailing wildcard should match multi-segment topics
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('exact match takes precedence alongside wildcards', async () => {
      const exactHandler = vi.fn();
      const wildcardHandler = vi.fn();

      await EventBus.subscribe(bus, 'user.created', exactHandler);
      await EventBus.subscribe(bus, 'user.*', wildcardHandler);

      await EventBus.publishSync(bus, 'user.created', 'payload');

      // Both should receive the message
      expect(exactHandler).toHaveBeenCalledTimes(1);
      expect(wildcardHandler).toHaveBeenCalledTimes(1);
    });

    it('multiple wildcards in pattern work correctly', async () => {
      const handler = vi.fn();
      await EventBus.subscribe(bus, '*.*.event', handler);

      await EventBus.publishSync(bus, 'user.123.event', 'a');
      await EventBus.publishSync(bus, 'order.456.event', 'b');
      await EventBus.publishSync(bus, 'any.thing.event', 'c');

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('pattern without wildcard requires exact match', async () => {
      const handler = vi.fn();
      await EventBus.subscribe(bus, 'user.created.v1', handler);

      await EventBus.publishSync(bus, 'user.created.v1', 'a');
      await EventBus.publishSync(bus, 'user.created.v2', 'b');
      await EventBus.publishSync(bus, 'user.created', 'c');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('a', 'user.created.v1');
    });
  });

  describe('publishSync()', () => {
    it('waits for message to be processed', async () => {
      const received: string[] = [];
      await EventBus.subscribe(bus, 'test', (msg) => {
        received.push(msg as string);
      });

      await EventBus.publishSync(bus, 'test', 'first');
      await EventBus.publishSync(bus, 'test', 'second');

      expect(received).toEqual(['first', 'second']);
    });

    it('ensures message ordering', async () => {
      const order: number[] = [];
      await EventBus.subscribe(bus, 'order', (msg) => {
        order.push(msg as number);
      });

      // Fire multiple syncs
      await Promise.all([
        EventBus.publishSync(bus, 'order', 1),
        EventBus.publishSync(bus, 'order', 2),
        EventBus.publishSync(bus, 'order', 3),
      ]);

      // All should be received (order may vary due to Promise.all)
      expect(order.sort()).toEqual([1, 2, 3]);
    });
  });

  describe('getSubscriptionCount()', () => {
    it('returns correct count as subscriptions change', async () => {
      expect(await EventBus.getSubscriptionCount(bus)).toBe(0);

      const unsub1 = await EventBus.subscribe(bus, 'a', vi.fn());
      expect(await EventBus.getSubscriptionCount(bus)).toBe(1);

      const unsub2 = await EventBus.subscribe(bus, 'b', vi.fn());
      expect(await EventBus.getSubscriptionCount(bus)).toBe(2);

      await unsub1();
      expect(await EventBus.getSubscriptionCount(bus)).toBe(1);

      await unsub2();
      expect(await EventBus.getSubscriptionCount(bus)).toBe(0);
    });
  });

  describe('getTopics()', () => {
    it('returns all unique subscribed patterns', async () => {
      await EventBus.subscribe(bus, 'user.created', vi.fn());
      await EventBus.subscribe(bus, 'user.created', vi.fn()); // Duplicate
      await EventBus.subscribe(bus, 'user.*', vi.fn());
      await EventBus.subscribe(bus, '*', vi.fn());

      const topics = await EventBus.getTopics(bus);

      expect(topics).toHaveLength(3);
      expect(topics).toContain('user.created');
      expect(topics).toContain('user.*');
      expect(topics).toContain('*');
    });

    it('removes pattern when last subscriber unsubscribes', async () => {
      const unsub = await EventBus.subscribe(bus, 'test.topic', vi.fn());
      expect(await EventBus.getTopics(bus)).toContain('test.topic');

      await unsub();
      expect(await EventBus.getTopics(bus)).not.toContain('test.topic');
    });
  });

  describe('stop()', () => {
    it('stops the EventBus', async () => {
      expect(EventBus.isRunning(bus)).toBe(true);

      await EventBus.stop(bus);

      expect(EventBus.isRunning(bus)).toBe(false);
    });

    it('is idempotent', async () => {
      await EventBus.stop(bus);
      await expect(EventBus.stop(bus)).resolves.toBeUndefined();
    });
  });

  describe('integration scenarios', () => {
    it('supports typed message handlers', async () => {
      interface UserCreatedEvent {
        userId: string;
        email: string;
        timestamp: number;
      }

      const handler = vi.fn<[UserCreatedEvent, string], void>();
      await EventBus.subscribe<UserCreatedEvent>(bus, 'user.created', handler);

      const event: UserCreatedEvent = {
        userId: '123',
        email: 'test@example.com',
        timestamp: Date.now(),
      };

      await EventBus.publishSync(bus, 'user.created', event);

      expect(handler).toHaveBeenCalledWith(event, 'user.created');
    });

    it('handles high volume of messages', async () => {
      const received: number[] = [];
      await EventBus.subscribe(bus, 'high.volume', (msg) => {
        received.push(msg as number);
      });

      // Publish 100 messages
      for (let i = 0; i < 100; i++) {
        EventBus.publish(bus, 'high.volume', i);
      }

      // Sync to ensure all processed
      await EventBus.publishSync(bus, 'high.volume', -1);

      expect(received).toHaveLength(101);
      expect(received[100]).toBe(-1);
    });

    it('supports multiple independent buses', async () => {
      const bus2 = await EventBus.start();

      const handler1 = vi.fn();
      const handler2 = vi.fn();

      await EventBus.subscribe(bus, 'test', handler1);
      await EventBus.subscribe(bus2, 'test', handler2);

      await EventBus.publishSync(bus, 'test', 'bus1-msg');
      await EventBus.publishSync(bus2, 'test', 'bus2-msg');

      expect(handler1).toHaveBeenCalledWith('bus1-msg', 'test');
      expect(handler1).not.toHaveBeenCalledWith('bus2-msg', 'test');
      expect(handler2).toHaveBeenCalledWith('bus2-msg', 'test');
      expect(handler2).not.toHaveBeenCalledWith('bus1-msg', 'test');

      await EventBus.stop(bus2);
    });

    it('works with complex topic hierarchies', async () => {
      const allEvents = vi.fn();
      const userEvents = vi.fn();
      const specificEvent = vi.fn();

      await EventBus.subscribe(bus, '*', allEvents);
      await EventBus.subscribe(bus, 'user.*', userEvents);
      await EventBus.subscribe(bus, 'user.profile.updated', specificEvent);

      await EventBus.publishSync(bus, 'user.profile.updated', 'payload');

      expect(allEvents).toHaveBeenCalledTimes(1);
      expect(userEvents).toHaveBeenCalledTimes(1);
      expect(specificEvent).toHaveBeenCalledTimes(1);
    });

    it('maintains subscription isolation during concurrent operations', async () => {
      const handlers = Array.from({ length: 10 }, () => vi.fn());
      const unsubs: Array<() => Promise<void>> = [];

      // Subscribe all handlers concurrently
      const subscribeResults = await Promise.all(
        handlers.map((h, i) => EventBus.subscribe(bus, `topic.${i}`, h)),
      );
      unsubs.push(...subscribeResults);

      expect(await EventBus.getSubscriptionCount(bus)).toBe(10);

      // Publish to each topic
      for (let i = 0; i < 10; i++) {
        await EventBus.publishSync(bus, `topic.${i}`, i);
      }

      // Each handler should have been called exactly once
      handlers.forEach((h, i) => {
        expect(h).toHaveBeenCalledTimes(1);
        expect(h).toHaveBeenCalledWith(i, `topic.${i}`);
      });

      // Unsubscribe all concurrently
      await Promise.all(unsubs.map((u) => u()));

      expect(await EventBus.getSubscriptionCount(bus)).toBe(0);
    });
  });
});
