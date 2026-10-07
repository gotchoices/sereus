import { describe, expect, it } from 'vitest';

import { parseDuration } from '../duration.js';

describe('parseDuration', () => {
  it('parses common units', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(5 * 60 * 1000);
    expect(parseDuration('24h')).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDuration('2w')).toBe(2 * 7 * 24 * 60 * 60 * 1000);
  });

  it('treats bare numbers as milliseconds', () => {
    expect(parseDuration('1234')).toBe(1234);
  });

  it('accepts whitespace and decimals', () => {
    expect(parseDuration('  1.5h  ')).toBe(Math.round(1.5 * 60 * 60 * 1000));
  });

  it('throws on garbage input', () => {
    expect(() => parseDuration('abc')).toThrow();
    expect(() => parseDuration('1y')).toThrow();
    expect(() => parseDuration('')).toThrow();
  });
});
