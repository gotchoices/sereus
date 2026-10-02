import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PushCredentials } from '@serfab/cadre-core';
import { applyEnvironmentOverrides, resolveConfig, validateConfig } from '../src/config/index.js';
import type { CliConfigFile } from '../src/config/types.js';

const baseConfig: CliConfigFile = {
  controlNetwork: { partyId: 'party-1', bootstrapNodes: [] },
  profile: 'storage',
};

const FCM = { projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: 'PEMKEY' };
const APNS = { keyId: 'KID', teamId: 'TEAM', bundleId: 'com.example', privateKey: 'P8KEY', production: false };

/** The startup merge: `env` written over `file`, validated, and the push block handed back. */
function mergePush(file: CliConfigFile, env: NodeJS.ProcessEnv): PushCredentials | undefined {
  const { tree, provenance } = applyEnvironmentOverrides(file, env);
  return validateConfig(tree, provenance, 'cadre.yaml').push;
}

/** Round-trip a raw CADRE_PUSH env value through the merge path. */
function resolveFromEnv(value: string): PushCredentials | undefined {
  return mergePush({ ...baseConfig }, { CADRE_PUSH: value });
}

describe('push config', () => {
  it('passes a file-config push block through unchanged', () => {
    const merged = mergePush({ ...baseConfig, push: { fcm: FCM, apns: APNS, cooldownMs: 1000 } }, {});
    expect(merged).toEqual({ fcm: FCM, apns: APNS, cooldownMs: 1000 });
  });

  it('parses a JSON CADRE_PUSH env var into the push block', () => {
    expect(resolveFromEnv(JSON.stringify({ fcm: FCM }))).toEqual({ fcm: FCM });
    expect(resolveFromEnv(JSON.stringify({ apns: APNS }))).toEqual({ apns: APNS });
  });

  it('lets CADRE_PUSH override a file-config push block', () => {
    const merged = mergePush({ ...baseConfig, push: { fcm: FCM } }, { CADRE_PUSH: JSON.stringify({ apns: APNS }) });
    expect(merged).toEqual({ apns: APNS });
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

  /** Write a cadre.json carrying `push` and resolve it under `env`. */
  async function resolveWith(push: unknown, env: NodeJS.ProcessEnv = {}): Promise<PushCredentials | undefined> {
    const cfgPath = join(dir, 'cadre.json');
    writeFileSync(cfgPath, JSON.stringify({ ...baseConfig, push }), 'utf8');
    return (await resolveConfig(cfgPath, env)).push;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cadre-cli-push-'));
  });

  afterEach(() => {
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
    const partial = JSON.stringify({ apns: { keyId: 'KID', teamId: 'TEAM', bundleId: '', privateKey: 'P8' } });
    await expect(resolveWith(undefined, { CADRE_PUSH: partial })).rejects.toThrow(/push\.apns\.bundleId/);
  });
});
