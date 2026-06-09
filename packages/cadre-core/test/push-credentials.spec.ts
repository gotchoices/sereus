import { describe, it, expect } from 'vitest';
import {
  validatePushCredentials,
  redactPushCredentials,
  REDACTED,
  type PushCredentials,
} from '../src/index.js';

const FCM = { projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----' };
const APNS = { keyId: 'KID', teamId: 'TEAM', bundleId: 'com.example.app', privateKey: '-----BEGIN PRIVATE KEY-----\nP8\n-----END PRIVATE KEY-----', production: false };

describe('validatePushCredentials', () => {
  it('accepts an empty bundle (push is opt-in)', () => {
    expect(validatePushCredentials({})).toEqual([]);
  });

  it('accepts a complete FCM-only bundle', () => {
    expect(validatePushCredentials({ fcm: FCM })).toEqual([]);
  });

  it('accepts a complete APNs-only bundle', () => {
    expect(validatePushCredentials({ apns: APNS })).toEqual([]);
  });

  it('accepts both platforms together', () => {
    expect(validatePushCredentials({ fcm: FCM, apns: APNS })).toEqual([]);
  });

  it('rejects a partial FCM block (missing privateKey)', () => {
    const errors = validatePushCredentials({ fcm: { ...FCM, privateKey: '' } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/push\.fcm\.privateKey/);
  });

  it('rejects a partial APNs block (keyId without privateKey)', () => {
    const partial = { keyId: 'KID', teamId: '', bundleId: '', privateKey: '' } as PushCredentials['apns'];
    const errors = validatePushCredentials({ apns: partial });
    // teamId, bundleId, privateKey all missing.
    expect(errors).toHaveLength(3);
    expect(errors.join('\n')).toMatch(/push\.apns\.privateKey/);
  });

  it('treats whitespace-only fields as missing', () => {
    const errors = validatePushCredentials({ fcm: { ...FCM, projectId: '   ' } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/push\.fcm\.projectId/);
  });
});

describe('redactPushCredentials', () => {
  it('replaces private keys with the redaction marker but keeps identifiers', () => {
    const redacted = redactPushCredentials({ fcm: FCM, apns: APNS, cooldownMs: 1000, debounceMs: 50 });
    expect(redacted).toEqual({
      fcm: { projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: REDACTED },
      apns: { keyId: 'KID', teamId: 'TEAM', bundleId: 'com.example.app', production: false, privateKey: REDACTED },
      cooldownMs: 1000,
      debounceMs: 50,
    });
  });

  it('never exposes a raw private key in the serialized form', () => {
    const serialized = JSON.stringify(redactPushCredentials({ fcm: FCM, apns: APNS }));
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');
    expect(serialized).toContain(REDACTED);
  });

  it('omits an absent platform', () => {
    expect(redactPushCredentials({ fcm: FCM })).toEqual({
      fcm: { projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: REDACTED },
    });
  });
});
