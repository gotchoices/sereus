import { describe, it, expect } from 'vitest';

import type { SecretsStore } from '../../nat/secrets/index.js';
import type { PushSettings } from '../../installer/config.js';
import {
  resolvePushCredentials,
  setFcmSecret,
  setApnsSecret,
  clearPushSecret,
  pushAccount,
  pushStatus,
} from '../index.js';

/** In-memory SecretsStore for tests. */
function fakeStore(): SecretsStore {
  const map = new Map<string, string>();
  return {
    async set(account, value) { map.set(account, value); },
    async get(account) { return map.get(account) ?? null; },
    async delete(account) { return map.delete(account); },
    async list() { return [...map.keys()]; },
  };
}

const FCM = { projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: 'FCM-PEM' };
const APNS = { keyId: 'KID', teamId: 'TEAM', privateKey: 'P8-PEM' };

describe('resolvePushCredentials', () => {
  it('returns undefined when no platform is configured (opt-in default)', async () => {
    const store = fakeStore();
    expect(await resolvePushCredentials(store, undefined)).toBeUndefined();
  });

  it('resolves an FCM-only bundle from the secret store', async () => {
    const store = fakeStore();
    await setFcmSecret(store, FCM);
    const push = await resolvePushCredentials(store, undefined);
    expect(push).toEqual({ fcm: FCM });
  });

  it('merges the APNs secret with non-secret bundleId/production from settings', async () => {
    const store = fakeStore();
    await setApnsSecret(store, APNS);
    const settings: PushSettings = { apns: { bundleId: 'com.example.app', production: true }, cooldownMs: 1000, debounceMs: 50 };
    const push = await resolvePushCredentials(store, settings);
    expect(push).toEqual({
      apns: { keyId: 'KID', teamId: 'TEAM', bundleId: 'com.example.app', privateKey: 'P8-PEM', production: true },
      cooldownMs: 1000,
      debounceMs: 50,
    });
  });

  it('combines both platforms when both secrets are present', async () => {
    const store = fakeStore();
    await setFcmSecret(store, FCM);
    await setApnsSecret(store, APNS);
    const push = await resolvePushCredentials(store, { apns: { bundleId: 'com.example.app' } });
    expect(push?.fcm).toEqual(FCM);
    expect(push?.apns?.bundleId).toBe('com.example.app');
  });

  it('throws on a partial APNs config (secret present but bundleId unset)', async () => {
    const store = fakeStore();
    await setApnsSecret(store, APNS);
    // No settings.apns.bundleId → bundleId resolves to '' → validation rejects.
    await expect(resolvePushCredentials(store, undefined)).rejects.toThrow(/push\.apns\.bundleId/);
  });

  it('keeps the FCM private key out of the secret-store account name', async () => {
    const store = fakeStore();
    await setFcmSecret(store, FCM);
    const accounts = await store.list();
    expect(accounts).toContain(pushAccount('fcm'));
    expect(accounts.join()).not.toContain('FCM-PEM');
  });
});

describe('clearPushSecret / pushStatus', () => {
  it('reports configured platforms and clears them', async () => {
    const store = fakeStore();
    await setFcmSecret(store, FCM);
    await setApnsSecret(store, APNS);
    expect(await pushStatus(store)).toEqual({ fcm: true, apns: true });

    expect(await clearPushSecret(store, 'fcm')).toBe(true);
    expect(await pushStatus(store)).toEqual({ fcm: false, apns: true });

    expect(await clearPushSecret(store, 'fcm')).toBe(false);
  });
});
