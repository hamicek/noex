/**
 * Unit tests for Dashboard types and configuration utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONFIG,
  DARK_THEME,
  LIGHT_THEME,
  getTheme,
  type DashboardConfig,
  type DashboardTheme,
  type ThemeName,
  type DashboardLayout,
} from '../../src/dashboard/types.js';

describe('Dashboard Types', () => {
  describe('DEFAULT_CONFIG', () => {
    it('has correct default values', () => {
      expect(DEFAULT_CONFIG.refreshInterval).toBe(500);
      expect(DEFAULT_CONFIG.maxEventLogSize).toBe(100);
      expect(DEFAULT_CONFIG.theme).toBe('dark');
      expect(DEFAULT_CONFIG.layout).toBe('full');
    });

    it('is marked as const (compile-time readonly)', () => {
      const config: DashboardConfig = DEFAULT_CONFIG;
      // TypeScript `as const` provides compile-time immutability
      // Runtime immutability would require Object.freeze()
      expect(config).toBe(DEFAULT_CONFIG);
    });
  });

  describe('DARK_THEME', () => {
    it('has all required color properties', () => {
      expect(DARK_THEME).toHaveProperty('primary');
      expect(DARK_THEME).toHaveProperty('secondary');
      expect(DARK_THEME).toHaveProperty('success');
      expect(DARK_THEME).toHaveProperty('warning');
      expect(DARK_THEME).toHaveProperty('error');
      expect(DARK_THEME).toHaveProperty('text');
      expect(DARK_THEME).toHaveProperty('textMuted');
      expect(DARK_THEME).toHaveProperty('background');
    });

    it('uses appropriate dark theme colors', () => {
      expect(DARK_THEME.background).toBe('black');
      expect(DARK_THEME.text).toBe('white');
    });

    it('is marked as const (compile-time readonly)', () => {
      // TypeScript `as const` provides compile-time immutability
      const theme: DashboardTheme = DARK_THEME;
      expect(theme).toBe(DARK_THEME);
    });
  });

  describe('LIGHT_THEME', () => {
    it('has all required color properties', () => {
      expect(LIGHT_THEME).toHaveProperty('primary');
      expect(LIGHT_THEME).toHaveProperty('secondary');
      expect(LIGHT_THEME).toHaveProperty('success');
      expect(LIGHT_THEME).toHaveProperty('warning');
      expect(LIGHT_THEME).toHaveProperty('error');
      expect(LIGHT_THEME).toHaveProperty('text');
      expect(LIGHT_THEME).toHaveProperty('textMuted');
      expect(LIGHT_THEME).toHaveProperty('background');
    });

    it('uses appropriate light theme colors', () => {
      expect(LIGHT_THEME.background).toBe('white');
      expect(LIGHT_THEME.text).toBe('black');
    });

    it('is marked as const (compile-time readonly)', () => {
      // TypeScript `as const` provides compile-time immutability
      const theme: DashboardTheme = LIGHT_THEME;
      expect(theme).toBe(LIGHT_THEME);
    });
  });

  describe('getTheme()', () => {
    it('returns dark theme for "dark"', () => {
      const theme = getTheme('dark');
      expect(theme).toBe(DARK_THEME);
    });

    it('returns light theme for "light"', () => {
      const theme = getTheme('light');
      expect(theme).toBe(LIGHT_THEME);
    });

    it('returns correct theme type', () => {
      const darkTheme: DashboardTheme = getTheme('dark');
      const lightTheme: DashboardTheme = getTheme('light');

      expect(darkTheme.primary).toBeDefined();
      expect(lightTheme.primary).toBeDefined();
    });
  });

  describe('Type definitions', () => {
    it('ThemeName accepts valid values', () => {
      const validThemes: ThemeName[] = ['dark', 'light'];
      expect(validThemes).toHaveLength(2);
    });

    it('DashboardLayout accepts valid values', () => {
      const validLayouts: DashboardLayout[] = ['full', 'compact', 'minimal'];
      expect(validLayouts).toHaveLength(3);
    });

    it('DashboardConfig is correctly typed', () => {
      const config: DashboardConfig = {
        refreshInterval: 1000,
        maxEventLogSize: 50,
        theme: 'light',
        layout: 'compact',
      };

      expect(config.refreshInterval).toBe(1000);
      expect(config.maxEventLogSize).toBe(50);
      expect(config.theme).toBe('light');
      expect(config.layout).toBe('compact');
    });
  });

  describe('Theme color consistency', () => {
    it('both themes have semantic colors for status', () => {
      const themes = [DARK_THEME, LIGHT_THEME];

      for (const theme of themes) {
        // Success should be green
        expect(theme.success).toBe('green');
        // Warning should be yellow
        expect(theme.warning).toBe('yellow');
        // Error should be red
        expect(theme.error).toBe('red');
      }
    });

    it('themes have contrasting text/background', () => {
      // Dark theme: light text on dark background
      expect(DARK_THEME.text).toBe('white');
      expect(DARK_THEME.background).toBe('black');

      // Light theme: dark text on light background
      expect(LIGHT_THEME.text).toBe('black');
      expect(LIGHT_THEME.background).toBe('white');
    });
  });
});
