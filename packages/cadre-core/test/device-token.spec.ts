import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { digest, sign } from '@optimystic/quereus-plugin-crypto';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import {
  deviceTokenSignedPayload,
  signDeviceTokenRecord,
  verifyDeviceTokenSignature,
  isPushPlatform
} from '../src/device-token.js';
import type { DeviceTokenRecord, PushPlatform } from '../src/types.js';

/** Build a self-consistent record (peerId + sig from one Ed25519 key). */
async function makeRecord(
  platform: PushPlatform,
  token: string,
  updatedAt: number
): Promise<{ record: DeviceTokenRecord; privateKeyB64: string; publicKeyB64: string; peerId: string }> {
  const libp2pKey = await generateKeyPair('Ed25519');
  const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(libp2pKey);
  const peerId = peerIdFromPrivateKey(libp2pKey).toString();
  const record = signDeviceTokenRecord({ peerId, platform, token, updatedAt }, privateKeyB64);
  return { record, privateKeyB64, publicKeyB64, peerId };
}

describe('device-token signed payload', () => {
  it('is the base64url sha256 of the domain-tagged field vector (mirrors the SQL constraint)', () => {
    const peerId = '12D3KooWExamplePeer';
    const platform: PushPlatform = 'fcm';
    const token = 'fcm-device-token-abc123';
    const updatedAt = 1700000000000;

    const expected = digest(
      ['CadreControl.DeviceToken', 'publish', peerId, platform, token, String(updatedAt)],
      'sha256',
      'base64url'
    ) as string;
    expect(deviceTokenSignedPayload({ peerId, platform, token, updatedAt })).toBe(expected);
  });

  it('is deterministic and changes when any field changes', () => {
    const base = { peerId: 'p', platform: 'fcm' as PushPlatform, token: 't', updatedAt: 5 };
    const a = deviceTokenSignedPayload(base);
    expect(deviceTokenSignedPayload(base)).toBe(a);
    expect(deviceTokenSignedPayload({ ...base, platform: 'apns' })).not.toBe(a);
    expect(deviceTokenSignedPayload({ ...base, token: 't2' })).not.toBe(a);
    expect(deviceTokenSignedPayload({ ...base, updatedAt: 6 })).not.toBe(a);
    expect(deviceTokenSignedPayload({ ...base, peerId: 'q' })).not.toBe(a);
  });
});

describe('signDeviceTokenRecord / verifyDeviceTokenSignature', () => {
  it('round-trips a self-signed record against the signing key', async () => {
    const { record, publicKeyB64 } = await makeRecord('fcm', 'tok-1', 1700000000000);
    expect(verifyDeviceTokenSignature(record, publicKeyB64)).toBe(true);
  });

  it('rejects a record verified against a different key', async () => {
    const { record } = await makeRecord('apns', 'tok-2', 10);
    const other = await generateKeyPair('Ed25519');
    const { publicKeyB64: otherPub } = ed25519KeyPairFromLibp2p(other);
    expect(verifyDeviceTokenSignature(record, otherPub)).toBe(false);
  });

  it('rejects a record whose sig was made by a different key', async () => {
    const { record, publicKeyB64 } = await makeRecord('fcm', 'tok-3', 10);
    const otherKey = await generateKeyPair('Ed25519');
    const { privateKeyB64: otherPriv } = ed25519KeyPairFromLibp2p(otherKey);
    const forgedSig = sign(
      deviceTokenSignedPayload(record),
      otherPriv, 'ed25519', 'base64url', 'base64url', 'base64url'
    ) as string;
    expect(verifyDeviceTokenSignature({ ...record, sig: forgedSig }, publicKeyB64)).toBe(false);
  });

  it('rejects a record with tampered platform / token / updatedAt', async () => {
    const { record, publicKeyB64 } = await makeRecord('fcm', 'tok-4', 10);
    expect(verifyDeviceTokenSignature({ ...record, platform: 'apns' }, publicKeyB64)).toBe(false);
    expect(verifyDeviceTokenSignature({ ...record, token: 'evil' }, publicKeyB64)).toBe(false);
    expect(verifyDeviceTokenSignature({ ...record, updatedAt: record.updatedAt + 1 }, publicKeyB64)).toBe(false);
  });

  it('rejects a record missing key or sig', async () => {
    const { record, publicKeyB64 } = await makeRecord('fcm', 'tok-5', 10);
    expect(verifyDeviceTokenSignature(record, '')).toBe(false);
    expect(verifyDeviceTokenSignature({ ...record, sig: '' }, publicKeyB64)).toBe(false);
  });
});

describe('isPushPlatform', () => {
  it('accepts the known platforms and rejects others', () => {
    expect(isPushPlatform('fcm')).toBe(true);
    expect(isPushPlatform('apns')).toBe(true);
    expect(isPushPlatform('gcm')).toBe(false);
    expect(isPushPlatform('')).toBe(false);
    expect(isPushPlatform('FCM')).toBe(false);
  });
});
