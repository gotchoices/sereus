import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PushCredentials } from '@serfab/cadre-core';
import { applyEnvironmentOverrides, resolveConfig } from '../src/config/loader.js';
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

  it('leaves push unset when CADRE_PUSH is empty (compose default) and the file sets none', () => {
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

describe('resolveConfig push validation', () => {
  let dir: string;

  /** Write a cadre.json and resolve it. */
  async function resolveWith(push: unknown): Promise<PushCredentials | undefined> {
    const cfgPath = join(dir, 'cadre.json');
    writeFileSync(cfgPath, JSON.stringify({ ...baseConfig, push }), 'utf8');
    return (await resolveConfig(cfgPath)).push;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cadre-cli-push-'));
  });

  afterEach(() => {
    delete process.env.CADRE_PUSH;
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a complete file-config push block', async () => {
    expect(await resolveWith({ fcm: FCM, apns: APNS })).toEqual({ fcm: FCM, apns: APNS });
  });

  it('accepts a config with no push block', async () => {
    expect(await resolveWith(undefined)).toBeUndefined();
  });

  it('rejects a partial file-config push block (fail fast at start)', async () => {
    await expect(resolveWith({ fcm: { ...FCM, privateKey: '' } })).rejects.toThrow(/push\.fcm\.privateKey/);
  });

  it('rejects a partial block injected via CADRE_PUSH', async () => {
    process.env.CADRE_PUSH = JSON.stringify({ apns: { keyId: 'KID', teamId: 'TEAM', bundleId: '', privateKey: 'P8' } });
    await expect(resolveWith(undefined)).rejects.toThrow(/push\.apns\.bundleId/);
  });
});
