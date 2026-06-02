import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import { buildManifest, derivePublicKeyBase64, signAndSelfVerify, type ManifestFields } from '../sign.js';
import { verifyManifest } from '../manifest.js';

function freshKeypair(): { privateKey: KeyObject; publicRawB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicRawB64: Buffer.from(spki.subarray(12)).toString('base64') };
}

const validFields: ManifestFields = {
  version: '0.7.0',
  package: '@serfab/cadre-host',
  tag: 'latest',
  publishedAt: '2026-05-15T18:00:00.000Z',
  releaseNotesUrl: 'https://example.com/notes',
  minPreviousVersion: '0.6.0',
};

describe('buildManifest', () => {
  it('constructs a well-formed manifest from flat fields', () => {
    expect(buildManifest(validFields)).toEqual({
      v: 1,
      version: '0.7.0',
      publishedAt: '2026-05-15T18:00:00.000Z',
      channels: { npm: { package: '@serfab/cadre-host', tag: 'latest' } },
      releaseNotesUrl: 'https://example.com/notes',
      minPreviousVersion: '0.6.0',
    });
  });

  it('omits optional fields when not provided', () => {
    const m = buildManifest({ version: '1.0.0', package: 'pkg', tag: 'latest', publishedAt: '2026-01-01T00:00:00.000Z' });
    expect(m.releaseNotesUrl).toBeUndefined();
    expect(m.minPreviousVersion).toBeUndefined();
  });

  it('rejects a bad semver version', () => {
    expect(() => buildManifest({ ...validFields, version: 'not-semver' })).toThrow(/not a valid semver/i);
  });

  it('rejects a bad npm package name', () => {
    expect(() => buildManifest({ ...validFields, package: 'BAD CHARS!' })).toThrow(/not a valid npm package name/i);
  });

  it('rejects a non-ISO publishedAt', () => {
    expect(() => buildManifest({ ...validFields, publishedAt: 'last tuesday' })).toThrow(/ISO-8601/i);
  });

  it('rejects a bad minPreviousVersion', () => {
    expect(() => buildManifest({ ...validFields, minPreviousVersion: '0.6' })).toThrow(/minPreviousVersion.*not a valid semver/i);
  });
});

describe('signAndSelfVerify', () => {
  afterEach(() => { delete process.env.CADRE_HOST_UPDATE_DEV_KEY; });

  it('produces an envelope that verifies against the derived public key', () => {
    const kp = freshKeypair();
    const manifest = buildManifest(validFields);
    const envelope = signAndSelfVerify(manifest, kp.privateKey);
    // derivePublicKeyBase64 must agree with the independently-extracted raw key.
    expect(derivePublicKeyBase64(kp.privateKey)).toBe(kp.publicRawB64);
    // Independent verification against the derived key round-trips the manifest.
    process.env.CADRE_HOST_UPDATE_DEV_KEY = kp.publicRawB64;
    expect(verifyManifest(envelope)).toEqual(manifest);
  });

  it('the self-verify rejects verification against a different key', () => {
    const kp = freshKeypair();
    const other = freshKeypair();
    const envelope = signAndSelfVerify(buildManifest(validFields), kp.privateKey);
    process.env.CADRE_HOST_UPDATE_DEV_KEY = other.publicRawB64;
    expect(() => verifyManifest(envelope)).toThrow(/signature/i);
  });
});
