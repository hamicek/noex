/**
 * EventBus - Pub/Sub messaging service built on GenServer.
 *
 * Provides topic-based message routing with wildcard support:
 * - Exact match: 'user.created' matches only 'user.created'
 * - Single wildcard: 'user.*' matches 'user.created', 'user.deleted'
 * - Global wildcard: '*' matches all topics
 *
 * @example
 * ```typescript
 * const bus = await EventBus.start();
 *
 * // Subscribe to specific topic
 * const unsub = await EventBus.subscribe(bus, 'user.created', (msg) => {
 *   console.log('User created:', msg);
 * });
 *
 * // Subscribe to all user events
 * await EventBus.subscribe(bus, 'user.*', (msg) => {
 *   console.log('User event:', msg);
 * });
 *
 * // Publish event
 * await EventBus.publish(bus, 'user.created', { id: '123', name: 'John' });
 *
 * // Cleanup
 * unsub();
 * await EventBus.stop(bus);
 * ```
 */

import { GenServer, type GenServerRef, type GenServerBehavior } from '../index.js';

/**
 * Subscription ID for tracking individual subscriptions.
 */
type SubscriptionId = string & { readonly __brand: 'SubscriptionId' };

/**
 * Topic pattern for subscription matching.
 * Supports exact match, single-level wildcard (*), and multi-level wildcard (#).
 */
type TopicPattern = string;

/**
 * Handler function called when a matching message is published.
 */
type MessageHandler<T = unknown> = (message: T, topic: string) => void;

/**
 * Internal subscription record.
 */
interface Subscription {
  readonly id: SubscriptionId;
  readonly pattern: TopicPattern;
  readonly handler: MessageHandler;
}

/**
 * EventBus internal state.
 */
interface EventBusState {
  readonly subscriptions: Map<SubscriptionId, Subscription>;
  readonly patternIndex: Map<TopicPattern, Set<SubscriptionId>>;
  nextSubscriptionId: number;
}

/**
 * Call messages for EventBus.
 */
type EventBusCallMsg =
  | { readonly type: 'subscribe'; readonly pattern: TopicPattern; readonly handler: MessageHandler }
  | { readonly type: 'unsubscribe'; readonly subscriptionId: SubscriptionId }
  | { readonly type: 'getSubscriptionCount' }
  | { readonly type: 'getTopics' };

/**
 * Cast messages for EventBus.
 */
type EventBusCastMsg = {
  readonly type: 'publish';
  readonly topic: string;
  readonly message: unknown;
};

/**
 * Reply types for EventBus calls.
 */
type EventBusCallReply =
  | SubscriptionId
  | boolean
  | number
  | readonly string[];

/**
 * EventBus reference type.
 */
export type EventBusRef = GenServerRef<
  EventBusState,
  EventBusCallMsg,
  EventBusCastMsg,
  EventBusCallReply
>;

/**
 * Options for EventBus.start()
 */
export interface EventBusOptions {
  /**
   * Optional name for registry registration.
   */
  readonly name?: string;
}

/**
 * Matches a topic against a pattern with wildcard support.
 *
 * Pattern syntax:
 * - Exact: 'user.created' matches only 'user.created'
 * - Single wildcard: 'user.*' matches 'user.created', 'user.deleted' (one segment)
 * - Global: '*' matches everything
 *
 * @param pattern - The subscription pattern
 * @param topic - The topic to match against
 * @returns true if the topic matches the pattern
 */
function matchesTopic(pattern: TopicPattern, topic: string): boolean {
  // Global wildcard matches everything
  if (pattern === '*') {
    return true;
  }

  // Exact match
  if (pattern === topic) {
    return true;
  }

  // Pattern-based matching
  const patternParts = pattern.split('.');
  const topicParts = topic.split('.');

  // Different segment counts means no match (unless pattern ends with *)
  if (patternParts.length !== topicParts.length) {
    // Check if pattern ends with '*' and has fewer parts
    if (patternParts[patternParts.length - 1] === '*' && patternParts.length <= topicParts.length) {
      // Match all parts before the wildcard
      for (let i = 0; i < patternParts.length - 1; i++) {
        if (patternParts[i] !== topicParts[i]) {
          return false;
        }
      }
      return true;
    }
    return false;
  }

  // Match segment by segment
  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    const topicPart = topicParts[i];

    // Wildcard matches any single segment
    if (patternPart === '*') {
      continue;
    }

    // Exact segment match required
    if (patternPart !== topicPart) {
      return false;
    }
  }

  return true;
}

/**
 * Generates a unique subscription ID.
 */
function generateSubscriptionId(counter: number): SubscriptionId {
  return `sub_${counter}_${Date.now().toString(36)}` as SubscriptionId;
}

/**
 * Creates the EventBus behavior implementation.
 */
function createEventBusBehavior(): GenServerBehavior<
  EventBusState,
  EventBusCallMsg,
  EventBusCastMsg,
  EventBusCallReply
> {
  return {
    init(): EventBusState {
      return {
        subscriptions: new Map(),
        patternIndex: new Map(),
        nextSubscriptionId: 0,
      };
    },

    handleCall(
      msg: EventBusCallMsg,
      state: EventBusState,
    ): readonly [EventBusCallReply, EventBusState] {
      switch (msg.type) {
        case 'subscribe': {
          const id = generateSubscriptionId(state.nextSubscriptionId);
          const subscription: Subscription = {
            id,
            pattern: msg.pattern,
            handler: msg.handler,
          };

          const newSubscriptions = new Map(state.subscriptions);
          newSubscriptions.set(id, subscription);

          const newPatternIndex = new Map(state.patternIndex);
          const existingIds = newPatternIndex.get(msg.pattern) ?? new Set();
          const newIds = new Set(existingIds);
          newIds.add(id);
          newPatternIndex.set(msg.pattern, newIds);

          return [
            id,
            {
              subscriptions: newSubscriptions,
              patternIndex: newPatternIndex,
              nextSubscriptionId: state.nextSubscriptionId + 1,
            },
          ];
        }

        case 'unsubscribe': {
          const subscription = state.subscriptions.get(msg.subscriptionId);
          if (!subscription) {
            return [false, state];
          }

          const newSubscriptions = new Map(state.subscriptions);
          newSubscriptions.delete(msg.subscriptionId);

          const newPatternIndex = new Map(state.patternIndex);
          const existingIds = newPatternIndex.get(subscription.pattern);
          if (existingIds) {
            const newIds = new Set(existingIds);
            newIds.delete(msg.subscriptionId);
            if (newIds.size === 0) {
              newPatternIndex.delete(subscription.pattern);
            } else {
              newPatternIndex.set(subscription.pattern, newIds);
            }
          }

          return [
            true,
            {
              ...state,
              subscriptions: newSubscriptions,
              patternIndex: newPatternIndex,
            },
          ];
        }

        case 'getSubscriptionCount': {
          return [state.subscriptions.size, state];
        }

        case 'getTopics': {
          return [Array.from(state.patternIndex.keys()), state];
        }
      }
    },

    handleCast(msg: EventBusCastMsg, state: EventBusState): EventBusState {
      if (msg.type === 'publish') {
        // Find all matching subscriptions and invoke handlers
        for (const subscription of state.subscriptions.values()) {
          if (matchesTopic(subscription.pattern, msg.topic)) {
            // Invoke handler in a try-catch to prevent one failing handler
            // from breaking others
            try {
              subscription.handler(msg.message, msg.topic);
            } catch {
              // Handlers should not throw, but if they do, we continue
              // In production, this could be logged or emitted as an event
            }
          }
        }
      }

      return state;
    },
  };
}

/**
 * EventBus provides pub/sub messaging between components.
 *
 * Built on GenServer, it provides:
 * - Topic-based message routing
 * - Wildcard pattern matching for subscriptions
 * - Fire-and-forget publishing (non-blocking)
 * - Automatic cleanup on stop
 */
export const EventBus = {
  /**
   * Starts a new EventBus instance.
   *
   * @param options - Optional configuration
   * @returns Reference to the started EventBus
   */
  async start(options: EventBusOptions = {}): Promise<EventBusRef> {
    const behavior = createEventBusBehavior();
    const startOptions = options.name !== undefined ? { name: options.name } : {};
    return GenServer.start(behavior, startOptions);
  },

  /**
   * Subscribes to messages matching a topic pattern.
   *
   * Pattern examples:
   * - 'user.created' - exact match
   * - 'user.*' - matches any user event (one segment)
   * - '*' - matches all topics
   *
   * @param ref - EventBus reference
   * @param pattern - Topic pattern to subscribe to
   * @param handler - Function called when matching message is published
   * @returns Unsubscribe function
   */
  async subscribe<T = unknown>(
    ref: EventBusRef,
    pattern: TopicPattern,
    handler: MessageHandler<T>,
  ): Promise<() => Promise<void>> {
    const subscriptionId = await GenServer.call(ref, {
      type: 'subscribe',
      pattern,
      handler: handler as MessageHandler,
    }) as SubscriptionId;

    // Return unsubscribe function
    return async () => {
      if (GenServer.isRunning(ref)) {
        await GenServer.call(ref, {
          type: 'unsubscribe',
          subscriptionId,
        });
      }
    };
  },

  /**
   * Publishes a message to a topic.
   *
   * This is a fire-and-forget operation - it returns immediately
   * without waiting for handlers to complete.
   *
   * @param ref - EventBus reference
   * @param topic - Topic to publish to
   * @param message - Message payload
   */
  publish<T = unknown>(ref: EventBusRef, topic: string, message: T): void {
    GenServer.cast(ref, {
      type: 'publish',
      topic,
      message,
    });
  },

  /**
   * Publishes a message and waits for all handlers to be invoked.
   *
   * Unlike `publish`, this waits for the message to be processed.
   * Useful for testing or when ordering guarantees are needed.
   *
   * @param ref - EventBus reference
   * @param topic - Topic to publish to
   * @param message - Message payload
   */
  async publishSync<T = unknown>(
    ref: EventBusRef,
    topic: string,
    message: T,
  ): Promise<void> {
    // Cast for publish, then call for synchronization
    GenServer.cast(ref, {
      type: 'publish',
      topic,
      message,
    });

    // Use a call to ensure the cast has been processed
    // (calls are processed after any pending casts in queue)
    await GenServer.call(ref, { type: 'getSubscriptionCount' });
  },

  /**
   * Returns the number of active subscriptions.
   *
   * @param ref - EventBus reference
   * @returns Number of subscriptions
   */
  async getSubscriptionCount(ref: EventBusRef): Promise<number> {
    return GenServer.call(ref, { type: 'getSubscriptionCount' }) as Promise<number>;
  },

  /**
   * Returns all subscribed topic patterns.
   *
   * @param ref - EventBus reference
   * @returns Array of subscribed patterns
   */
  async getTopics(ref: EventBusRef): Promise<readonly string[]> {
    return GenServer.call(ref, { type: 'getTopics' }) as Promise<readonly string[]>;
  },

  /**
   * Checks if the EventBus is running.
   *
   * @param ref - EventBus reference
   * @returns true if running
   */
  isRunning(ref: EventBusRef): boolean {
    return GenServer.isRunning(ref);
  },

  /**
   * Gracefully stops the EventBus.
   *
   * @param ref - EventBus reference
   */
  async stop(ref: EventBusRef): Promise<void> {
    await GenServer.stop(ref);
  },
} as const;
