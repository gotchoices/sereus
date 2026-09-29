import { describe, expect, it } from 'vitest';

import { PortAllocator } from '../port-allocator.js';

describe('PortAllocator', () => {
  it('allocates sequentially, releases, and reuses', () => {
    const a = new PortAllocator(100, 102);
    expect(a.allocate()).toBe(100);
    expect(a.allocate()).toBe(101);
    expect(a.allocate()).toBe(102);
    expect(() => a.allocate()).toThrow(/No available ports/);
    a.release(101);
    expect(a.allocate()).toBe(101);
  });

  it('markUsed reserves ports without allocating', () => {
    const a = new PortAllocator(100, 102);
    a.markUsed(101);
    expect(a.allocate()).toBe(100);
    expect(a.allocate()).toBe(102);
    expect(() => a.allocate()).toThrow();
  });

  // Without the integer check, `undefined` and NaN pass both range comparisons (each
  // is false) and land in the used-set, as would an in-range fraction.
  it('markUsed ignores a non-integer', () => {
    const a = new PortAllocator(100, 101);
    for (const junk of [undefined as unknown as number, Number.NaN, 100.5]) {
      a.markUsed(junk);
      expect(a.has(junk)).toBe(false);
    }
  });
});
