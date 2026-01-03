import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/index.js';

describe('Project setup', () => {
  it('exports VERSION constant', () => {
    expect(VERSION).toBe('0.1.0');
  });

  it('VERSION is a readonly string literal type', () => {
    // TypeScript compile-time check: VERSION should be '0.1.0', not string
    const version: '0.1.0' = VERSION;
    expect(version).toBe('0.1.0');
  });
});
