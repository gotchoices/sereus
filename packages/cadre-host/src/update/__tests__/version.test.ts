import { describe, expect, it } from 'vitest';

import { compareVersions, parseVersion } from '../version.js';

describe('compareVersions', () => {
  it('orders releases by major/minor/patch', () => {
    expect(compareVersions('0.6.0', '0.7.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
  });

  it('puts prereleases below their associated release (semver §11)', () => {
    expect(compareVersions('0.7.0-rc1', '0.7.0')).toBeLessThan(0);
    expect(compareVersions('0.7.0', '0.7.0-rc1')).toBeGreaterThan(0);
  });

  it('compares prereleases by identifier with numeric < alphanumeric', () => {
    expect(compareVersions('0.7.0-alpha', '0.7.0-beta')).toBeLessThan(0);
    expect(compareVersions('0.7.0-rc.1', '0.7.0-rc.2')).toBeLessThan(0);
    expect(compareVersions('0.7.0-rc.2', '0.7.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('0.7.0-1', '0.7.0-rc')).toBeLessThan(0);
  });

  it('rejects ill-formed input', () => {
    expect(() => parseVersion('not a version')).toThrow(/Invalid version/);
    expect(() => parseVersion('1.2')).toThrow(/Invalid version/);
    expect(() => parseVersion('1.2.3+build')).toThrow(/Invalid version/);
    expect(() => compareVersions('1.2.3', '1.x.0')).toThrow(/Invalid version/);
  });
});
