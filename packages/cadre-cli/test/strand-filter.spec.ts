import { describe, it, expect, afterEach } from 'vitest';
import type { StrandFilter } from '@serfab/cadre-core';
import { applyEnvironmentOverrides, parseStrandFilter } from '../src/config/loader.js';
import type { CliConfigFile } from '../src/config/types.js';

const baseConfig: CliConfigFile = {
  controlNetwork: { partyId: 'party-1', bootstrapNodes: [] },
  profile: 'storage',
};

/**
 * Round-trip a raw env value through the real startup path:
 * `applyEnvironmentOverrides` (env → merged config) then `parseStrandFilter`
 * (merged config → StrandFilter). This mirrors what `resolveConfig` does and is
 * the path the container/systemd deployment exercises.
 */
function resolveFromEnv(value: string): StrandFilter {
  process.env.CADRE_STRAND_FILTER = value;
  const merged = applyEnvironmentOverrides({ ...baseConfig });
  return parseStrandFilter(merged.strandFilter);
}

describe('parseStrandFilter', () => {
  it('treats undefined / null / "all" as mode all', () => {
    expect(parseStrandFilter(undefined)).toEqual({ mode: 'all' });
    expect(parseStrandFilter(null)).toEqual({ mode: 'all' });
    expect(parseStrandFilter('all')).toEqual({ mode: 'all' });
  });

  it('maps "none" to mode none', () => {
    expect(parseStrandFilter('none')).toEqual({ mode: 'none' });
  });

  it('accepts a { sAppId } object (file-config form)', () => {
    expect(parseStrandFilter({ sAppId: 'myapp' })).toEqual({ mode: 'sAppId', sAppId: 'myapp' });
  });

  it('accepts a { strandId } object (file-config form)', () => {
    expect(parseStrandFilter({ strandId: 'strand-xyz' })).toEqual({ mode: 'strandId', strandId: 'strand-xyz' });
  });

  it('throws on an unrecognized scalar instead of silently defaulting to all', () => {
    expect(() => parseStrandFilter('garbage')).toThrow(/Invalid strandFilter/);
  });

  it('throws on an empty-string filter', () => {
    expect(() => parseStrandFilter('')).toThrow(/Invalid strandFilter/);
  });

  it('throws when the discriminant is missing', () => {
    expect(() => parseStrandFilter({})).toThrow(/Invalid strandFilter/);
    expect(() => parseStrandFilter({ other: 'x' })).toThrow(/Invalid strandFilter/);
  });

  it('throws when the discriminant value is empty or non-string', () => {
    expect(() => parseStrandFilter({ sAppId: '' })).toThrow(/Invalid strandFilter/);
    expect(() => parseStrandFilter({ strandId: 42 })).toThrow(/Invalid strandFilter/);
  });

  it('rejects an object carrying both sAppId and strandId', () => {
    expect(() => parseStrandFilter({ sAppId: 'a', strandId: 'b' })).toThrow(/Invalid strandFilter/);
  });
});

describe('CADRE_STRAND_FILTER env override', () => {
  afterEach(() => {
    delete process.env.CADRE_STRAND_FILTER;
  });

  it('keeps bare "all" / "none" scalars (case-insensitive)', () => {
    expect(resolveFromEnv('all')).toEqual({ mode: 'all' });
    expect(resolveFromEnv('none')).toEqual({ mode: 'none' });
    expect(resolveFromEnv('  ALL  ')).toEqual({ mode: 'all' });
    expect(resolveFromEnv('None')).toEqual({ mode: 'none' });
  });

  it('falls back to all when the value is empty (compose default) and the file sets no filter', () => {
    expect(resolveFromEnv('')).toEqual({ mode: 'all' });
  });

  it('reaches the sAppId object form via JSON', () => {
    expect(resolveFromEnv('{"sAppId":"myapp"}')).toEqual({ mode: 'sAppId', sAppId: 'myapp' });
  });

  it('reaches the strandId object form via JSON', () => {
    expect(resolveFromEnv('{"strandId":"strand-xyz"}')).toEqual({ mode: 'strandId', strandId: 'strand-xyz' });
  });

  it('throws on malformed JSON rather than degrading to all', () => {
    expect(() => resolveFromEnv('{"sAppId":')).toThrow(/CADRE_STRAND_FILTER/);
  });

  it('throws on an unrecognized scalar rather than degrading to all', () => {
    expect(() => resolveFromEnv('myapp')).toThrow(/Invalid strandFilter/);
  });

  it('throws on a JSON object with no recognized discriminant', () => {
    expect(() => resolveFromEnv('{"foo":"bar"}')).toThrow(/Invalid strandFilter/);
  });

  it('throws on a JSON scalar/array that is not a recognized filter', () => {
    // A bare number or array is valid JSON but not a strand filter; it must fail
    // loudly rather than slip through as a truthy override.
    expect(() => resolveFromEnv('42')).toThrow(/Invalid strandFilter/);
    expect(() => resolveFromEnv('["x"]')).toThrow(/Invalid strandFilter/);
  });
});
