/**
 * Comprehensive tests for RateLimiter service.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter, RateLimitExceededError, type RateLimiterRef, GenServer } from '../../src/index.js';

describe('RateLimiter', () => {
  let limiter: RateLimiterRef;

  beforeEach(async () => {
    GenServer._clearLifecycleHandlers();
    GenServer._resetIdCounter();
    limiter = await RateLimiter.start({
      maxRequests: 10,
      windowMs: 1000,
    });
  });

  afterEach(async () => {
    if (RateLimiter.isRunning(limiter)) {
      await RateLimiter.stop(limiter);
    }
    GenServer._clearLifecycleHandlers();
    vi.useRealTimers();
  });

  describe('start()', () => {
    it('starts a RateLimiter instance', async () => {
      expect(limiter).toBeDefined();
      expect(RateLimiter.isRunning(limiter)).toBe(true);
    });

    it('starts with no tracked keys', async () => {
      const keys = await RateLimiter.getKeys(limiter);
      expect(keys).toEqual([]);
    });

    it('supports named instances', async () => {
      const namedLimiter = await RateLimiter.start({
        maxRequests: 10,
        windowMs: 1000,
        name: 'my-limiter',
      });
      expect(RateLimiter.isRunning(namedLimiter)).toBe(true);
      await RateLimiter.stop(namedLimiter);
    });
  });

  describe('check()', () => {
    it('returns allowed for fresh key', async () => {
      const result = await RateLimiter.check(limiter, 'user:123');

      expect(result.allowed).toBe(true);
      expect(result.current).toBe(0);
      expect(result.limit).toBe(10);
      expect(result.remaining).toBe(10);
      expect(result.retryAfterMs).toBe(0);
    });

    it('does not consume quota', async () => {
      await RateLimiter.check(limiter, 'user:123');
      await RateLimiter.check(limiter, 'user:123');
      await RateLimiter.check(limiter, 'user:123');

      const result = await RateLimiter.check(limiter, 'user:123');
      expect(result.current).toBe(0);
      expect(result.remaining).toBe(10);
    });

    it('supports cost parameter', async () => {
      const result = await RateLimiter.check(limiter, 'user:123', 5);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(10); // Check doesn't consume
    });

    it('reports not allowed when cost exceeds remaining', async () => {
      // Consume 8 requests
      for (let i = 0; i < 8; i++) {
        await RateLimiter.consume(limiter, 'user:123');
      }

      // Check if 5 more would be allowed
      const result = await RateLimiter.check(limiter, 'user:123', 5);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });
  });

  describe('consume()', () => {
    it('consumes quota and returns result', async () => {
      const result = await RateLimiter.consume(limiter, 'user:123');

      expect(result.allowed).toBe(true);
      expect(result.current).toBe(0); // Before consumption
      expect(result.remaining).toBe(9); // After consumption
    });

    it('tracks consumption correctly', async () => {
      for (let i = 0; i < 5; i++) {
        await RateLimiter.consume(limiter, 'user:123');
      }

      const status = await RateLimiter.getStatus(limiter, 'user:123');
      expect(status.current).toBe(5);
      expect(status.remaining).toBe(5);
    });

    it('throws RateLimitExceededError when limit exceeded', async () => {
      // Consume all 10 requests
      for (let i = 0; i < 10; i++) {
        await RateLimiter.consume(limiter, 'user:123');
      }

      // 11th should throw
      await expect(RateLimiter.consume(limiter, 'user:123')).rejects.toThrow(
        RateLimitExceededError,
      );
    });

    it('RateLimitExceededError contains correct info', async () => {
      for (let i = 0; i < 10; i++) {
        await RateLimiter.consume(limiter, 'user:123');
      }

      try {
        await RateLimiter.consume(limiter, 'user:123');
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(RateLimitExceededError);
        const error = e as RateLimitExceededError;
        expect(error.key).toBe('user:123');
        expect(error.retryAfterMs).toBeGreaterThan(0);
        expect(error.retryAfterMs).toBeLessThanOrEqual(1000);
      }
    });

    it('supports cost parameter', async () => {
      await RateLimiter.consume(limiter, 'user:123', 5);

      const status = await RateLimiter.getStatus(limiter, 'user:123');
      expect(status.current).toBe(5);
      expect(status.remaining).toBe(5);
    });

    it('rejects when cost exceeds remaining', async () => {
      await RateLimiter.consume(limiter, 'user:123', 8);

      await expect(RateLimiter.consume(limiter, 'user:123', 5)).rejects.toThrow(
        RateLimitExceededError,
      );
    });
  });

  describe('sliding window behavior', () => {
    it('allows requests after window expires', async () => {
      vi.useFakeTimers();

      // Consume all requests
      for (let i = 0; i < 10; i++) {
        await RateLimiter.consume(limiter, 'user:123');
      }

      // Should be rate limited
      await expect(RateLimiter.consume(limiter, 'user:123')).rejects.toThrow();

      // Advance past window
      vi.advanceTimersByTime(1100);

      // Should be allowed again
      const result = await RateLimiter.consume(limiter, 'user:123');
      expect(result.allowed).toBe(true);
    });

    it('sliding window uses log-based counting', async () => {
      vi.useFakeTimers();

      // Make 10 requests at the start
      for (let i = 0; i < 10; i++) {
        await RateLimiter.consume(limiter, 'user:123');
      }

      // Advance 50% through the window - requests still count
      vi.advanceTimersByTime(500);

      // All 10 requests are still within the window
      const status = await RateLimiter.getStatus(limiter, 'user:123');
      expect(status.current).toBe(10);
      expect(status.allowed).toBe(false);

      // After full window expires, should be allowed again
      vi.advanceTimersByTime(600); // Now at 1100ms
      const newStatus = await RateLimiter.getStatus(limiter, 'user:123');
      expect(newStatus.current).toBe(0);
      expect(newStatus.allowed).toBe(true);
    });

    it('resetMs reflects time until window resets', async () => {
      vi.useFakeTimers();

      await RateLimiter.consume(limiter, 'user:123');

      vi.advanceTimersByTime(300);

      const status = await RateLimiter.getStatus(limiter, 'user:123');
      expect(status.resetMs).toBeCloseTo(700, -2);
    });
  });

  describe('per-key isolation', () => {
    it('tracks keys independently', async () => {
      for (let i = 0; i < 10; i++) {
        await RateLimiter.consume(limiter, 'user:1');
      }

      // User 1 is rate limited
      await expect(RateLimiter.consume(limiter, 'user:1')).rejects.toThrow();

      // User 2 should be fine
      const result = await RateLimiter.consume(limiter, 'user:2');
      expect(result.allowed).toBe(true);
    });

    it('getKeys returns all tracked keys', async () => {
      await RateLimiter.consume(limiter, 'user:1');
      await RateLimiter.consume(limiter, 'user:2');
      await RateLimiter.consume(limiter, 'api:endpoint');

      const keys = await RateLimiter.getKeys(limiter);
      expect(keys).toHaveLength(3);
      expect(keys).toContain('user:1');
      expect(keys).toContain('user:2');
      expect(keys).toContain('api:endpoint');
    });
  });

  describe('getStatus()', () => {
    it('returns status for tracked key', async () => {
      await RateLimiter.consume(limiter, 'user:123');
      await RateLimiter.consume(limiter, 'user:123');
      await RateLimiter.consume(limiter, 'user:123');

      const status = await RateLimiter.getStatus(limiter, 'user:123');

      expect(status.current).toBe(3);
      expect(status.limit).toBe(10);
      expect(status.remaining).toBe(7);
      expect(status.allowed).toBe(true);
    });

    it('returns default status for untracked key', async () => {
      const status = await RateLimiter.getStatus(limiter, 'unknown');

      expect(status.current).toBe(0);
      expect(status.limit).toBe(10);
      expect(status.remaining).toBe(10);
      expect(status.allowed).toBe(true);
    });

    it('reflects rate limited status', async () => {
      for (let i = 0; i < 10; i++) {
        await RateLimiter.consume(limiter, 'user:123');
      }

      const status = await RateLimiter.getStatus(limiter, 'user:123');
      expect(status.allowed).toBe(false);
      expect(status.remaining).toBe(0);
    });
  });

  describe('reset()', () => {
    it('resets rate limit for a key', async () => {
      for (let i = 0; i < 10; i++) {
        await RateLimiter.consume(limiter, 'user:123');
      }

      await expect(RateLimiter.consume(limiter, 'user:123')).rejects.toThrow();

      await RateLimiter.reset(limiter, 'user:123');

      const result = await RateLimiter.consume(limiter, 'user:123');
      expect(result.allowed).toBe(true);
    });

    it('returns true if key existed', async () => {
      await RateLimiter.consume(limiter, 'user:123');
      const result = await RateLimiter.reset(limiter, 'user:123');
      expect(result).toBe(true);
    });

    it('returns false if key did not exist', async () => {
      const result = await RateLimiter.reset(limiter, 'unknown');
      expect(result).toBe(false);
    });

    it('does not affect other keys', async () => {
      await RateLimiter.consume(limiter, 'user:1');
      await RateLimiter.consume(limiter, 'user:2');

      await RateLimiter.reset(limiter, 'user:1');

      const status1 = await RateLimiter.getStatus(limiter, 'user:1');
      const status2 = await RateLimiter.getStatus(limiter, 'user:2');

      expect(status1.current).toBe(0);
      expect(status2.current).toBe(1);
    });
  });

  describe('cleanup()', () => {
    it('removes stale entries', async () => {
      vi.useFakeTimers();

      await RateLimiter.consume(limiter, 'user:old');

      // Advance past 2 windows
      vi.advanceTimersByTime(2100);

      RateLimiter.cleanup(limiter);
      // Sync with a call
      await RateLimiter.getKeys(limiter);

      const keys = await RateLimiter.getKeys(limiter);
      expect(keys).not.toContain('user:old');
    });

    it('keeps active entries', async () => {
      vi.useFakeTimers();

      await RateLimiter.consume(limiter, 'user:old');

      vi.advanceTimersByTime(2100);

      await RateLimiter.consume(limiter, 'user:new');

      RateLimiter.cleanup(limiter);
      await RateLimiter.getKeys(limiter);

      const keys = await RateLimiter.getKeys(limiter);
      expect(keys).toContain('user:new');
    });
  });

  describe('stop()', () => {
    it('stops the RateLimiter', async () => {
      expect(RateLimiter.isRunning(limiter)).toBe(true);
      await RateLimiter.stop(limiter);
      expect(RateLimiter.isRunning(limiter)).toBe(false);
    });

    it('is idempotent', async () => {
      await RateLimiter.stop(limiter);
      await expect(RateLimiter.stop(limiter)).resolves.toBeUndefined();
    });
  });

  describe('integration scenarios', () => {
    it('handles burst followed by steady traffic', async () => {
      vi.useFakeTimers();

      // Burst: 8 requests
      for (let i = 0; i < 8; i++) {
        await RateLimiter.consume(limiter, 'user:123');
      }

      // 2 more allowed
      await RateLimiter.consume(limiter, 'user:123');
      await RateLimiter.consume(limiter, 'user:123');

      // Now limited
      await expect(RateLimiter.consume(limiter, 'user:123')).rejects.toThrow();

      // Wait for full window to expire
      vi.advanceTimersByTime(1100);

      // Should have capacity again
      const status = await RateLimiter.getStatus(limiter, 'user:123');
      expect(status.allowed).toBe(true);
      expect(status.current).toBe(0);
    });

    it('supports multiple independent limiters', async () => {
      const strictLimiter = await RateLimiter.start({
        maxRequests: 2,
        windowMs: 1000,
      });

      await RateLimiter.consume(limiter, 'user:123');
      await RateLimiter.consume(strictLimiter, 'user:123');
      await RateLimiter.consume(strictLimiter, 'user:123');

      // Main limiter still has capacity
      const mainStatus = await RateLimiter.getStatus(limiter, 'user:123');
      expect(mainStatus.remaining).toBe(9);

      // Strict limiter is exhausted
      await expect(RateLimiter.consume(strictLimiter, 'user:123')).rejects.toThrow();

      await RateLimiter.stop(strictLimiter);
    });

    it('handles high concurrency', async () => {
      const promises: Promise<void>[] = [];

      for (let i = 0; i < 100; i++) {
        const key = `user:${i % 10}`;
        promises.push(
          RateLimiter.consume(limiter, key)
            .then(() => {})
            .catch(() => {}),
        );
      }

      await Promise.all(promises);

      // Each of 10 users should have 10 requests
      for (let i = 0; i < 10; i++) {
        const status = await RateLimiter.getStatus(limiter, `user:${i}`);
        expect(status.current).toBe(10);
      }
    });

    it('provides accurate retry timing', async () => {
      vi.useFakeTimers();

      // Consume all at once
      for (let i = 0; i < 10; i++) {
        await RateLimiter.consume(limiter, 'user:123');
      }

      try {
        await RateLimiter.consume(limiter, 'user:123');
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(RateLimitExceededError);
        const error = e as RateLimitExceededError;

        // retryAfterMs should be close to windowMs (1000ms)
        expect(error.retryAfterMs).toBeGreaterThan(0);
        expect(error.retryAfterMs).toBeLessThanOrEqual(1000);

        // Wait for the suggested retry time + small buffer
        vi.advanceTimersByTime(error.retryAfterMs + 10);

        // Should be able to make a request now
        const result = await RateLimiter.consume(limiter, 'user:123');
        expect(result.allowed).toBe(true);
      }
    });

    it('handles API rate limiting use case', async () => {
      vi.useFakeTimers();

      // Simulate API rate limiting: 100 requests per minute
      const apiLimiter = await RateLimiter.start({
        maxRequests: 100,
        windowMs: 60000,
      });

      // Simulate 50 requests from user
      for (let i = 0; i < 50; i++) {
        const result = await RateLimiter.consume(apiLimiter, 'api-key:abc123');
        expect(result.allowed).toBe(true);
      }

      const status = await RateLimiter.getStatus(apiLimiter, 'api-key:abc123');
      expect(status.remaining).toBe(50);
      expect(status.limit).toBe(100);

      await RateLimiter.stop(apiLimiter);
    });

    it('handles IP-based rate limiting', async () => {
      // Common pattern: limit by IP address
      const ips = ['192.168.1.1', '10.0.0.1', '172.16.0.1'];

      for (const ip of ips) {
        for (let i = 0; i < 5; i++) {
          await RateLimiter.consume(limiter, `ip:${ip}`);
        }
      }

      // Each IP should have 5 requests
      for (const ip of ips) {
        const status = await RateLimiter.getStatus(limiter, `ip:${ip}`);
        expect(status.current).toBe(5);
        expect(status.remaining).toBe(5);
      }
    });
  });
});
