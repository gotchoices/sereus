import { describe, it, expect, afterEach } from 'vitest';
import type { PushCredentials } from '@serfab/cadre-core';
import { applyEnvironmentOverrides } from '../src/config/loader.js';
import type { CliConfigFile } from '../src/config/types.js';

const baseConfig: CliConfigFile = {
  controlNetwork: { partyId: 'party-1', bootstrapNodes: [] },
  profile: 'storage',
};

const FCM = { projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: 'PEMKEY' };
const APNS = { keyId: 'KID', teamId: 'TEAM', bundleId: 'com.example', privateKey: 'P8KEY', production: false };

/** Round-trip a raw CADRE_PUSH env value through the merge path. */
function resolveFromEnv(value: string): PushCredentials | undefined {
  process.env.CADRE_PUSH = value;
  return applyEnvironmentOverrides({ ...baseConfig }).push;
}

describe('push config', () => {
  afterEach(() => {
    delete process.env.CADRE_PUSH;
  });

  it('passes a file-config push block through unchanged', () => {
    const merged = applyEnvironmentOverrides({ ...baseConfig, push: { fcm: FCM, apns: APNS, cooldownMs: 1000 } });
    expect(merged.push).toEqual({ fcm: FCM, apns: APNS, cooldownMs: 1000 });
  });

  it('parses a JSON CADRE_PUSH env var into the push block', () => {
    expect(resolveFromEnv(JSON.stringify({ fcm: FCM }))).toEqual({ fcm: FCM });
    expect(resolveFromEnv(JSON.stringify({ apns: APNS }))).toEqual({ apns: APNS });
  });

  it('lets CADRE_PUSH override a file-config push block', () => {
    process.env.CADRE_PUSH = JSON.stringify({ apns: APNS });
    const merged = applyEnvironmentOverrides({ ...baseConfig, push: { fcm: FCM } });
    expect(merged.push).toEqual({ apns: APNS });
  });

  it('treats an empty CADRE_PUSH (compose default) as undefined', () => {
    expect(resolveFromEnv('')).toBeUndefined();
    expect(resolveFromEnv('   ')).toBeUndefined();
  });

  it('throws on malformed CADRE_PUSH rather than silently dropping push', () => {
    expect(() => resolveFromEnv('{"fcm":')).toThrow(/CADRE_PUSH/);
  });

  it('throws when CADRE_PUSH is a JSON scalar/array, not an object', () => {
    expect(() => resolveFromEnv('42')).toThrow(/CADRE_PUSH/);
    expect(() => resolveFromEnv('["x"]')).toThrow(/CADRE_PUSH/);
  });
});
