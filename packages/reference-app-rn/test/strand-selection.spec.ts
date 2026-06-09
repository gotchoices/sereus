import { describe, it, expect } from 'vitest';
import { pickActiveStrandId } from '../src/strand-selection';

describe('pickActiveStrandId', () => {
  it('empty set → null', () => {
    expect(pickActiveStrandId([], null)).toBeNull();
    expect(pickActiveStrandId([], 'anything')).toBeNull();
  });

  it('explicit selection present → returns it even when not the smallest', () => {
    expect(pickActiveStrandId(['a', 'b', 'c'], 'c')).toBe('c');
  });

  it('explicit selection null → smallest lexicographic id', () => {
    expect(pickActiveStrandId(['b', 'a', 'c'], null)).toBe('a');
  });

  it('explicit selection not in the set → smallest lexicographic id (fallback)', () => {
    expect(pickActiveStrandId(['b', 'c'], 'a')).toBe('b');
  });

  it('single strand, selection null → that strand', () => {
    expect(pickActiveStrandId(['only'], null)).toBe('only');
  });

  it('order independence: same ids in two orders → identical result', () => {
    const forward = pickActiveStrandId(['x', 'y', 'z'], null);
    const reversed = pickActiveStrandId(['z', 'y', 'x'], null);
    expect(forward).toBe(reversed);
    expect(forward).toBe('x');
  });

  it('order independence holds for an explicit selection too', () => {
    expect(pickActiveStrandId(['m', 'a', 'z'], 'z')).toBe('z');
    expect(pickActiveStrandId(['z', 'a', 'm'], 'z')).toBe('z');
  });
});
