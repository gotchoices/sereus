import { describe, it, expect } from 'vitest';
import { loadConfig } from '../loader.js';
import { validatePushConfig, redactPushConfig } from '../validate.js';
import type { ProviderPushConfig } from '../types.js';

const FCM = { projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: 'FCM-PEM' };
const APNS = { keyId: 'KID', teamId: 'TEAM', bundleId: 'com.example', privateKey: 'P8-PEM', production: false };

describe('validatePushConfig', () => {
  it('accepts an undefined / empty push config', () => {
    expect(() => validatePushConfig(undefined)).not.toThrow();
    expect(() => validatePushConfig({})).not.toThrow();
  });

  it('accepts a complete default + per-tenant config', () => {
    const push: ProviderPushConfig = {
      default: { fcm: FCM },
      tenants: { 'cust-a': { apns: APNS }, 'cust-b': { fcm: FCM, apns: APNS } },
    };
    expect(() => validatePushConfig(push)).not.toThrow();
  });

  it('rejects a partial default credential set', () => {
    expect(() => validatePushConfig({ default: { fcm: { ...FCM, privateKey: '' } } }))
      .toThrow(/push\.default\.fcm\.privateKey/);
  });

  it('rejects a partial per-tenant credential set (APNs keyId without privateKey)', () => {
    const push = { tenants: { 'cust-x': { apns: { keyId: 'KID', teamId: '', bundleId: '', privateKey: '' } } } } as ProviderPushConfig;
    expect(() => validatePushConfig(push)).toThrow(/push\.tenants\.cust-x\.apns\.privateKey/);
  });

  it('is wired into loadConfig (fails provider start on a partial set)', () => {
    expect(() => loadConfig({ overrides: { push: { default: { apns: { keyId: 'K', teamId: 'T', bundleId: '', privateKey: 'P' } } } } }))
      .toThrow(/push\.default\.apns\.bundleId/);
  });

  it('loadConfig accepts a complete push config', () => {
    const config = loadConfig({ overrides: { push: { tenants: { 'cust-a': { fcm: FCM } } } } });
    expect(config.push?.tenants?.['cust-a']).toEqual({ fcm: FCM });
  });
});

describe('redactPushConfig', () => {
  it('replaces every private key but keeps identifiers', () => {
    const redacted = redactPushConfig({ default: { fcm: FCM }, tenants: { a: { apns: APNS } } });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('FCM-PEM');
    expect(serialized).not.toContain('P8-PEM');
    expect(redacted.default?.fcm?.projectId).toBe('proj');
    expect(redacted.tenants?.a?.apns?.bundleId).toBe('com.example');
  });
});
