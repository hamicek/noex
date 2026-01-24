import { describe, it, expect } from 'vitest';
import { globToRegExp } from '../../src/core/glob-utils.js';

describe('globToRegExp', () => {
  describe('literal matching', () => {
    it('matches exact string', () => {
      const regex = globToRegExp('hello');
      expect(regex.test('hello')).toBe(true);
      expect(regex.test('world')).toBe(false);
      expect(regex.test('hello!')).toBe(false);
    });

    it('does not match partial strings', () => {
      const regex = globToRegExp('foo');
      expect(regex.test('foobar')).toBe(false);
      expect(regex.test('barfoo')).toBe(false);
    });
  });

  describe('single wildcard (*)', () => {
    it('matches any characters except separator', () => {
      const regex = globToRegExp('user:*');
      expect(regex.test('user:alice')).toBe(true);
      expect(regex.test('user:bob')).toBe(true);
      expect(regex.test('user:')).toBe(true);
      expect(regex.test('admin:alice')).toBe(false);
    });

    it('does not cross path separator boundary', () => {
      const regex = globToRegExp('src/*');
      expect(regex.test('src/file')).toBe(true);
      expect(regex.test('src/dir/file')).toBe(false);
    });

    it('works in the middle of pattern', () => {
      const regex = globToRegExp('pre-*-suf');
      expect(regex.test('pre-mid-suf')).toBe(true);
      expect(regex.test('pre--suf')).toBe(true);
      expect(regex.test('pre-a/b-suf')).toBe(false);
    });

    it('supports multiple wildcards', () => {
      const regex = globToRegExp('*:*');
      expect(regex.test('key:value')).toBe(true);
      expect(regex.test(':')).toBe(true);
      expect(regex.test('key:val/ue')).toBe(false);
    });
  });

  describe('double wildcard (**)', () => {
    it('matches any characters including separator', () => {
      const regex = globToRegExp('src/**');
      expect(regex.test('src/file.ts')).toBe(true);
      expect(regex.test('src/dir/file.ts')).toBe(true);
      expect(regex.test('src/')).toBe(true);
    });

    it('matches deeply nested paths', () => {
      const regex = globToRegExp('**');
      expect(regex.test('a/b/c/d')).toBe(true);
      expect(regex.test('')).toBe(true);
    });

    it('works with prefix and suffix', () => {
      const regex = globToRegExp('a/**/z');
      expect(regex.test('a/b/c/z')).toBe(true);
      expect(regex.test('a//z')).toBe(true);
      expect(regex.test('a/z')).toBe(false); // literal slashes require content between them
    });
  });

  describe('question mark (?)', () => {
    it('matches exactly one character', () => {
      const regex = globToRegExp('file?.txt');
      expect(regex.test('file1.txt')).toBe(true);
      expect(regex.test('fileA.txt')).toBe(true);
      expect(regex.test('file.txt')).toBe(false);
      expect(regex.test('file12.txt')).toBe(false);
    });

    it('supports multiple question marks', () => {
      const regex = globToRegExp('??');
      expect(regex.test('ab')).toBe(true);
      expect(regex.test('a')).toBe(false);
      expect(regex.test('abc')).toBe(false);
    });
  });

  describe('special character escaping', () => {
    it('escapes regex metacharacters', () => {
      const regex = globToRegExp('file.txt');
      expect(regex.test('file.txt')).toBe(true);
      expect(regex.test('filextxt')).toBe(false);
    });

    it('escapes parentheses', () => {
      const regex = globToRegExp('fn(x)');
      expect(regex.test('fn(x)')).toBe(true);
      expect(regex.test('fnx')).toBe(false);
    });

    it('escapes brackets', () => {
      const regex = globToRegExp('arr[0]');
      expect(regex.test('arr[0]')).toBe(true);
      expect(regex.test('arr0')).toBe(false);
    });

    it('escapes plus and caret', () => {
      const regex = globToRegExp('a+b^c');
      expect(regex.test('a+b^c')).toBe(true);
      expect(regex.test('aab^c')).toBe(false);
    });

    it('escapes pipe', () => {
      const regex = globToRegExp('a|b');
      expect(regex.test('a|b')).toBe(true);
      expect(regex.test('a')).toBe(false);
      expect(regex.test('b')).toBe(false);
    });

    it('escapes backslash', () => {
      const regex = globToRegExp('a\\b');
      expect(regex.test('a\\b')).toBe(true);
    });

    it('escapes dollar sign', () => {
      const regex = globToRegExp('$var');
      expect(regex.test('$var')).toBe(true);
    });

    it('escapes curly braces', () => {
      const regex = globToRegExp('{key}');
      expect(regex.test('{key}')).toBe(true);
    });
  });

  describe('combined patterns', () => {
    it('handles complex glob patterns', () => {
      const regex = globToRegExp('user:*:session:?');
      expect(regex.test('user:alice:session:1')).toBe(true);
      expect(regex.test('user:bob:session:A')).toBe(true);
      expect(regex.test('user:alice:session:12')).toBe(false);
    });

    it('anchors pattern to full string', () => {
      const regex = globToRegExp('test');
      expect(regex.test('test')).toBe(true);
      expect(regex.test('testing')).toBe(false);
      expect(regex.test('a test')).toBe(false);
    });
  });
});
