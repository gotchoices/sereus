import { describe, it, expect } from 'vitest';
import { Scope, hasPermission } from '../permissions.js';

describe('hasPermission', () => {
  it('global wildcard grants every scope', () => {
    expect(hasPermission(['*'], Scope.ContainersRead)).toBe(true);
    expect(hasPermission(['*'], Scope.ContainersCreate)).toBe(true);
    expect(hasPermission(['*'], Scope.BillingRead)).toBe(true);
    expect(hasPermission(['*'], 'anything:at:all')).toBe(true);
  });

  it('per-resource wildcard grants only that resource', () => {
    expect(hasPermission(['containers:*'], Scope.ContainersRead)).toBe(true);
    expect(hasPermission(['containers:*'], Scope.ContainersCreate)).toBe(true);
    expect(hasPermission(['containers:*'], Scope.ContainersDelete)).toBe(true);
    expect(hasPermission(['containers:*'], Scope.ContainersSeed)).toBe(true);
    // …but not a different resource.
    expect(hasPermission(['containers:*'], Scope.BillingRead)).toBe(false);
  });

  it('exact match grants only that scope', () => {
    expect(hasPermission(['containers:read'], Scope.ContainersRead)).toBe(true);
    expect(hasPermission(['containers:read'], Scope.ContainersCreate)).toBe(false);
    expect(hasPermission(['billing:read'], Scope.BillingRead)).toBe(true);
  });

  it('empty permissions array grants nothing', () => {
    expect(hasPermission([], Scope.ContainersRead)).toBe(false);
    expect(hasPermission([], Scope.BillingRead)).toBe(false);
    expect(hasPermission([], '*')).toBe(false);
  });

  it('honors any matching entry among several', () => {
    expect(hasPermission(['billing:read', 'containers:read'], Scope.ContainersRead)).toBe(true);
    expect(hasPermission(['billing:read', 'containers:read'], Scope.ContainersCreate)).toBe(false);
  });

  it('a per-resource wildcard does not leak across a prefix boundary', () => {
    // 'containers:*' must not satisfy a scope for a different (but prefix-ish) resource.
    expect(hasPermission(['containers:*'], 'containersx:read')).toBe(false);
  });
});
