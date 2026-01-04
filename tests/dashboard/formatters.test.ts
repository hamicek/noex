/**
 * Unit tests for dashboard formatting utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  formatNumber,
  formatUptime,
  formatTime,
  truncate,
  calculatePercent,
  formatReason,
  TreeChars,
} from '../../src/dashboard/utils/formatters.js';

describe('formatNumber', () => {
  it('returns plain number for values under 1000', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(42)).toBe('42');
    expect(formatNumber(999)).toBe('999');
  });

  it('formats thousands with K suffix', () => {
    expect(formatNumber(1000)).toBe('1.0K');
    expect(formatNumber(1500)).toBe('1.5K');
    expect(formatNumber(12345)).toBe('12.3K');
    expect(formatNumber(999999)).toBe('1000.0K');
  });

  it('formats millions with M suffix', () => {
    expect(formatNumber(1000000)).toBe('1.0M');
    expect(formatNumber(1500000)).toBe('1.5M');
    expect(formatNumber(12345678)).toBe('12.3M');
  });

  it('formats billions with B suffix', () => {
    expect(formatNumber(1000000000)).toBe('1.0B');
    expect(formatNumber(1500000000)).toBe('1.5B');
  });

  it('supports custom precision', () => {
    expect(formatNumber(1234, 0)).toBe('1K');
    expect(formatNumber(1234, 2)).toBe('1.23K');
  });
});

describe('formatUptime', () => {
  it('formats zero correctly', () => {
    expect(formatUptime(0)).toBe('00:00:00');
  });

  it('formats seconds correctly', () => {
    expect(formatUptime(1000)).toBe('00:00:01');
    expect(formatUptime(59000)).toBe('00:00:59');
  });

  it('formats minutes correctly', () => {
    expect(formatUptime(60000)).toBe('00:01:00');
    expect(formatUptime(61000)).toBe('00:01:01');
    expect(formatUptime(3599000)).toBe('00:59:59');
  });

  it('formats hours correctly', () => {
    expect(formatUptime(3600000)).toBe('01:00:00');
    expect(formatUptime(3661000)).toBe('01:01:01');
    expect(formatUptime(36000000)).toBe('10:00:00');
  });

  it('handles large values', () => {
    expect(formatUptime(86400000)).toBe('24:00:00');
    expect(formatUptime(90061000)).toBe('25:01:01');
  });
});

describe('formatTime', () => {
  it('formats timestamp to HH:MM:SS', () => {
    const result = formatTime(Date.now());
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('uses 24-hour format', () => {
    // Create a timestamp for 14:30:45
    const date = new Date();
    date.setHours(14, 30, 45);
    const result = formatTime(date.getTime());
    expect(result).toBe('14:30:45');
  });
});

describe('truncate', () => {
  it('returns original string if shorter than max', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('test', 4)).toBe('test');
  });

  it('truncates long strings with ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello w\u2026');
    expect(truncate('abcdefgh', 5)).toBe('abcd\u2026');
  });

  it('handles edge cases', () => {
    expect(truncate('', 5)).toBe('');
    expect(truncate('a', 1)).toBe('a');
  });
});

describe('calculatePercent', () => {
  it('calculates percentage correctly', () => {
    expect(calculatePercent(50, 100)).toBe(50);
    expect(calculatePercent(25, 100)).toBe(25);
    expect(calculatePercent(100, 100)).toBe(100);
  });

  it('rounds to nearest integer', () => {
    expect(calculatePercent(33, 100)).toBe(33);
    expect(calculatePercent(1, 3)).toBe(33);
  });

  it('clamps values to 0-100 range', () => {
    expect(calculatePercent(150, 100)).toBe(100);
    expect(calculatePercent(-10, 100)).toBe(0);
  });

  it('handles zero total', () => {
    expect(calculatePercent(50, 0)).toBe(0);
  });

  it('handles negative total', () => {
    expect(calculatePercent(50, -100)).toBe(0);
  });
});

describe('formatReason', () => {
  it('formats normal reason', () => {
    expect(formatReason('normal')).toBe('normal');
  });

  it('formats shutdown reason', () => {
    expect(formatReason('shutdown')).toBe('shutdown');
  });

  it('formats error reason', () => {
    const error = new Error('Something went wrong');
    expect(formatReason({ error })).toBe('error: Something went wrong');
  });
});

describe('TreeChars', () => {
  it('has all required characters', () => {
    expect(TreeChars.VERTICAL).toBe('\u2502');
    expect(TreeChars.BRANCH).toBe('\u251C');
    expect(TreeChars.LAST_BRANCH).toBe('\u2514');
    expect(TreeChars.HORIZONTAL).toBe('\u2500');
    expect(TreeChars.FILLED_CIRCLE).toBe('\u25CF');
    expect(TreeChars.HOLLOW_CIRCLE).toBe('\u25CB');
    expect(TreeChars.DOWN_ARROW).toBe('\u25BC');
  });
});
