import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import { canonicalJson, signManifestForTesting, verifyManifest } from '../manifest.js';
import type { UpdateManifest } from '../types.js';

/** Generate a fresh Ed25519 keypair and surface the raw 32-byte public key. */
function freshKeypair(): { publicKey: KeyObject; privateKey: KeyObject; publicRawB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // Extract the raw 32-byte public key from SPKI DER (strip the 12-byte header).
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const raw = spki.subarray(12);
  return { publicKey, privateKey, publicRawB64: Buffer.from(raw).toString('base64') };
}

const sampleManifest: UpdateManifest = {
  v: 1,
  version: '0.7.0',
  publishedAt: '2026-05-15T18:00:00.000Z',
  channels: { npm: { package: '@serfab/cadre-host', tag: 'latest' } },
  releaseNotesUrl: 'https://example.com/notes',
  minPreviousVersion: '0.6.0',
};

describe('canonicalJson', () => {
  it('sorts keys deterministically and omits whitespace', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ outer: { z: 1, a: 2 }, top: true })).toBe('{"outer":{"a":2,"z":1},"top":true}');
    expect(canonicalJson([3, 2, 1])).toBe('[3,2,1]');
  });

  it('omits undefined fields', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('verifyManifest', () => {
  let kp: ReturnType<typeof freshKeypair>;

  beforeEach(() => {
    kp = freshKeypair();
    process.env.CADRE_HOST_UPDATE_DEV_KEY = kp.publicRawB64;
  });

  afterEach(() => {
    delete process.env.CADRE_HOST_UPDATE_DEV_KEY;
  });

  it('round-trips: sign + verify', () => {
    const envelope = signManifestForTesting(sampleManifest, kp.privateKey);
    const out = verifyManifest(envelope);
    expect(out).toEqual(sampleManifest);
  });

  it('rejects a mutated payload (signature_invalid)', () => {
    const envelope = signManifestForTesting(sampleManifest, kp.privateKey);
    const tampered = { ...envelope, manifest: { ...envelope.manifest, version: '99.0.0' } };
    expect(() => verifyManifest(tampered)).toThrow(/signature/i);
  });

  it('rejects a mutated signature (signature_invalid)', () => {
    const envelope = signManifestForTesting(sampleManifest, kp.privateKey);
    const sigBytes = Buffer.from(envelope.sig.slice('ed25519:'.length), 'base64');
    sigBytes[0] ^= 0xff;
    const tampered = { ...envelope, sig: `ed25519:${sigBytes.toString('base64')}` };
    expect(() => verifyManifest(tampered)).toThrow(/signature/i);
  });

  it('rejects an envelope signed by a different key (signature_invalid)', () => {
    const envelope = signManifestForTesting(sampleManifest, kp.privateKey);
    // Swap the env-configured public key to a different fresh one.
    const other = freshKeypair();
    process.env.CADRE_HOST_UPDATE_DEV_KEY = other.publicRawB64;
    expect(() => verifyManifest(envelope)).toThrow(/signature/i);
  });

  it('rejects malformed envelopes (manifest_invalid)', () => {
    expect(() => verifyManifest(null)).toThrow(/malformed/);
    expect(() => verifyManifest({})).toThrow(/malformed/);
    expect(() => verifyManifest({ manifest: 'nope', sig: 'ed25519:AAAA' })).toThrow(/malformed/);
  });

  it('rejects manifests missing required fields (manifest_invalid)', () => {
    const bad = { manifest: { v: 1, version: '0.7.0' }, sig: 'ed25519:AAAA' };
    expect(() => verifyManifest(bad)).toThrow(/missing required fields/);
  });

  it('rejects unsupported signature schemes', () => {
    const envelope = signManifestForTesting(sampleManifest, kp.privateKey);
    const tampered = { ...envelope, sig: envelope.sig.replace('ed25519:', 'rsa:') };
    expect(() => verifyManifest(tampered)).toThrow(/unsupported signature scheme/);
  });
});
