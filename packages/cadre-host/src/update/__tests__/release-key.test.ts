import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

import { isPlaceholderReleaseKey } from '../release-key.js';

function freshPublicRawB64(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return Buffer.from(raw).toString('base64');
}

describe('isPlaceholderReleaseKey', () => {
  afterEach(() => { delete process.env.CADRE_HOST_UPDATE_DEV_KEY; });

  it('is true for the default all-zeros placeholder (no override)', () => {
    delete process.env.CADRE_HOST_UPDATE_DEV_KEY;
    expect(isPlaceholderReleaseKey()).toBe(true);
  });

  it('is false when a real key overrides via CADRE_HOST_UPDATE_DEV_KEY', () => {
    process.env.CADRE_HOST_UPDATE_DEV_KEY = freshPublicRawB64();
    expect(isPlaceholderReleaseKey()).toBe(false);
  });

  it('honors an explicit env argument over process.env', () => {
    expect(isPlaceholderReleaseKey({ CADRE_HOST_UPDATE_DEV_KEY: freshPublicRawB64() })).toBe(false);
    expect(isPlaceholderReleaseKey({})).toBe(true);
  });
});
