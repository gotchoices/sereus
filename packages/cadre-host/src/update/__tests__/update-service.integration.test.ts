import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import { signManifestForTesting } from '../manifest.js';
import { UpdateService } from '../index.js';
import type { UpdateManifest } from '../types.js';

function freshKeypair(): { privateKey: KeyObject; publicRawB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicRawB64: Buffer.from(spki.subarray(12)).toString('base64') };
}

function manifest(version: string, opts: Partial<UpdateManifest> = {}): UpdateManifest {
  return {
    v: 1,
    version,
    publishedAt: '2026-05-15T18:00:00.000Z',
    channels: { npm: { package: '@serfab/cadre-host', tag: 'latest' } },
    ...opts,
  };
}

function fakeFetch(envelope: unknown): typeof fetch {
  return (async (_url: string, _init?: RequestInit) => {
    return {
      ok: true,
      status: 200,
      json: async () => envelope,
    } as Response;
  }) as typeof fetch;
}

describe('UpdateService', () => {
  let tmp: string;
  let kp: ReturnType<typeof freshKeypair>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cadre-update-svc-'));
    kp = freshKeypair();
    process.env.CADRE_HOST_UPDATE_DEV_KEY = kp.publicRawB64;
  });

  afterEach(() => {
    delete process.env.CADRE_HOST_UPDATE_DEV_KEY;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('check(): records an available update when manifest > current', async () => {
    const envelope = signManifestForTesting(manifest('0.7.0', { releaseNotesUrl: 'https://x' }), kp.privateKey);
    const svc = new UpdateService({
      dataDir: tmp,
      currentVersion: '0.6.0',
      fetcher: fakeFetch(envelope),
      manifestUrl: 'https://example.com/m',
    });
    await svc.check();
    const state = await svc.getState();
    expect(state.available).toEqual({
      version: '0.7.0',
      publishedAt: '2026-05-15T18:00:00.000Z',
      releaseNotesUrl: 'https://x',
    });
    expect(state.lastChecked).toBeDefined();
    expect(state.lastError).toBeUndefined();
  });

  it('check(): clears stale available when up-to-date', async () => {
    const envelope = signManifestForTesting(manifest('0.6.0'), kp.privateKey);
    const svc = new UpdateService({
      dataDir: tmp,
      currentVersion: '0.7.0',
      fetcher: fakeFetch(envelope),
      manifestUrl: 'https://example.com/m',
    });
    await svc.check();
    const state = await svc.getState();
    expect(state.available).toBeUndefined();
    expect(state.lastChecked).toBeDefined();
  });

  it('check(): silent on network failure', async () => {
    const svc = new UpdateService({
      dataDir: tmp,
      currentVersion: '0.6.0',
      fetcher: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch,
      manifestUrl: 'https://example.com/m',
    });
    await svc.check();
    const state = await svc.getState();
    expect(state.lastChecked).toBeUndefined();
    expect(state.lastError).toBeUndefined();
  });

  it('check(): records signature_invalid as lastError', async () => {
    const envelope = signManifestForTesting(manifest('0.7.0'), kp.privateKey);
    // Swap the trusted key after signing.
    const other = freshKeypair();
    process.env.CADRE_HOST_UPDATE_DEV_KEY = other.publicRawB64;
    const svc = new UpdateService({
      dataDir: tmp,
      currentVersion: '0.6.0',
      fetcher: fakeFetch(envelope),
      manifestUrl: 'https://example.com/m',
    });
    await svc.check();
    const state = await svc.getState();
    expect(state.lastError?.code).toBe('signature_invalid');
    expect(state.available).toBeUndefined();
  });

  it('apply(): records applyInProgress, calls npm + restart, clears on success', async () => {
    const envelope = signManifestForTesting(manifest('0.7.0'), kp.privateKey);
    const calls: string[][] = [];
    const svc = new UpdateService({
      dataDir: tmp,
      currentVersion: '0.6.0',
      fetcher: fakeFetch(envelope),
      manifestUrl: 'https://example.com/m',
      npmExecutor: async (args) => { calls.push(args); return { exitCode: 0, stdout: '', stderr: '' }; },
      restart: async () => undefined,
    });
    const result = await svc.apply();
    expect(result).toMatchObject({ fromVersion: '0.6.0', toVersion: '0.7.0', restarted: true });
    expect(calls).toEqual([['install', '-g', '@serfab/cadre-host@0.7.0']]);
    const state = await svc.getState();
    expect(state.applyInProgress).toBeUndefined();
    expect(state.lastError).toBeUndefined();
  });

  it('apply(): rejects when current is below minPreviousVersion', async () => {
    const envelope = signManifestForTesting(manifest('0.8.0', { minPreviousVersion: '0.7.0' }), kp.privateKey);
    const svc = new UpdateService({
      dataDir: tmp,
      currentVersion: '0.6.0',
      fetcher: fakeFetch(envelope),
      manifestUrl: 'https://example.com/m',
    });
    await expect(svc.apply()).rejects.toMatchObject({ code: 'min_previous_version' });
  });

  it('apply(): rejects when current >= latest', async () => {
    const envelope = signManifestForTesting(manifest('0.6.0'), kp.privateKey);
    const svc = new UpdateService({
      dataDir: tmp,
      currentVersion: '0.7.0',
      fetcher: fakeFetch(envelope),
      manifestUrl: 'https://example.com/m',
    });
    await expect(svc.apply()).rejects.toMatchObject({ code: 'no_update_available' });
  });

  it('apply(): records lastError + clears applyInProgress when npm install fails', async () => {
    const envelope = signManifestForTesting(manifest('0.7.0'), kp.privateKey);
    let installCount = 0;
    const svc = new UpdateService({
      dataDir: tmp,
      currentVersion: '0.6.0',
      fetcher: fakeFetch(envelope),
      manifestUrl: 'https://example.com/m',
      npmExecutor: async () => {
        installCount++;
        return { exitCode: installCount === 1 ? 1 : 0, stdout: '', stderr: installCount === 1 ? 'EACCES' : '' };
      },
    });
    await expect(svc.apply()).rejects.toMatchObject({ code: 'apply_failed' });
    const state = await svc.getState();
    expect(state.applyInProgress).toBeUndefined();
    expect(state.lastError?.code).toBe('apply_failed');
  });

  it('settings: onSettingsChanged fires when putSettings mutates state', async () => {
    const svc = new UpdateService({
      dataDir: tmp,
      currentVersion: '0.6.0',
      fetcher: fakeFetch({}),
      manifestUrl: 'https://example.com/m',
      settings: { autoApply: false },
    });
    let observed: { autoApply: boolean } | null = null;
    svc.onSettingsChanged((next) => { observed = { autoApply: next.autoApply }; });
    await svc.putSettings({ autoApply: true });
    expect(observed).toEqual({ autoApply: true });
    expect(svc.getSettings().autoApply).toBe(true);
  });

  it('autoApply: check() triggers apply when settings.autoApply is true', async () => {
    const envelope = signManifestForTesting(manifest('0.7.0'), kp.privateKey);
    const calls: string[][] = [];
    const svc = new UpdateService({
      dataDir: tmp,
      currentVersion: '0.6.0',
      fetcher: fakeFetch(envelope),
      manifestUrl: 'https://example.com/m',
      settings: { autoApply: true },
      npmExecutor: async (args) => { calls.push(args); return { exitCode: 0, stdout: '', stderr: '' }; },
      restart: async () => undefined,
    });
    await svc.check();
    expect(calls.some((c) => c[2] === '@serfab/cadre-host@0.7.0')).toBe(true);
  });

  it('start()/stop(): timer can be armed and cleared', async () => {
    const svc = new UpdateService({
      dataDir: tmp,
      currentVersion: '0.6.0',
      fetcher: (async () => { throw new Error('no'); }) as typeof fetch,
      manifestUrl: 'https://example.com/m',
      checkIntervalMs: 1_000_000,
    });
    svc.start();
    // Calling start a second time is a no-op (no thrown error).
    svc.start();
    svc.stop();
    // Calling stop without an active timer is safe.
    svc.stop();
  });
});
