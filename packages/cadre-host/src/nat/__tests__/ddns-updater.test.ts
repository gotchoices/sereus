import { describe, expect, it } from 'vitest';

import { DdnsUpdater } from '../ddns/updater.js';
import type { DdnsProvider } from '../ddns/index.js';
import type { SecretsStore } from '../secrets/index.js';
import { ddnsAccount } from '../secrets/index.js';
import { NatError, type NatDdnsSettings } from '../types.js';

function makeSecrets(seed: Record<string, string> = {}): SecretsStore {
  const map = new Map(Object.entries(seed));
  return {
    async set(a, v) { map.set(a, v); },
    async get(a) { return map.has(a) ? map.get(a)! : null; },
    async delete(a) { return map.delete(a); },
    async list() { return Array.from(map.keys()); },
  };
}

function makeProvider(overrides: Partial<DdnsProvider> = {}): DdnsProvider & {
  calls: Array<{ hostname: string; ip: string; config: Record<string, string> }>;
  shouldThrow: Error | null;
} {
  const calls: Array<{ hostname: string; ip: string; config: Record<string, string> }> = [];
  let shouldThrow: Error | null = null;
  return {
    id: 'duckdns',
    displayName: 'DuckDNS',
    configFields: [{ key: 'token', label: 'DuckDNS token', secret: true }],
    async update(config, hostname, ip) {
      calls.push({ hostname, ip, config });
      if (shouldThrow) throw shouldThrow;
    },
    ...overrides,
    get calls() { return calls; },
    get shouldThrow() { return shouldThrow; },
    set shouldThrow(e: Error | null) { shouldThrow = e; },
  } as DdnsProvider & {
    calls: Array<{ hostname: string; ip: string; config: Record<string, string> }>;
    shouldThrow: Error | null;
  };
}

function fakeIntervalTimers(): {
  setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval: (h: NodeJS.Timeout) => void;
  fire(): Promise<void>;
  cleared: number;
} {
  let cb: (() => void) | null = null;
  let cleared = 0;
  return {
    setInterval: (fn) => { cb = fn; return { _id: 1 } as unknown as NodeJS.Timeout; },
    clearInterval: () => { cb = null; cleared++; },
    async fire() { const f = cb; if (f) { f(); await new Promise((r) => setTimeout(r, 0)); } },
    get cleared() { return cleared; },
  };
}

const baseSettings: NatDdnsSettings = {
  providerId: 'duckdns',
  hostname: 'foo.duckdns.org',
  externallyManaged: false,
  intervalMs: 60_000,
};

describe('DdnsUpdater', () => {
  it('no-op when externallyManaged', async () => {
    const provider = makeProvider();
    const secrets = makeSecrets({ [ddnsAccount('duckdns', 'token')]: 'T' });
    const ip: string | null = '1.2.3.4';
    const u = new DdnsUpdater({
      settings: { ...baseSettings, externallyManaged: true },
      secrets,
      getExternalIp: () => ip,
      resolveProvider: () => provider,
      ...fakeIntervalTimers(),
    });
    await u.start();
    expect(provider.calls).toHaveLength(0);
  });

  it('no-op when providerId is null', async () => {
    const provider = makeProvider();
    const u = new DdnsUpdater({
      settings: { ...baseSettings, providerId: null },
      secrets: makeSecrets(),
      getExternalIp: () => '1.2.3.4',
      resolveProvider: () => provider,
      ...fakeIntervalTimers(),
    });
    await u.start();
    expect(provider.calls).toHaveLength(0);
  });

  it('pushes the IP on start, records lastUpdateOk=true', async () => {
    const provider = makeProvider();
    const secrets = makeSecrets({ [ddnsAccount('duckdns', 'token')]: 'T' });
    const u = new DdnsUpdater({
      settings: baseSettings,
      secrets,
      getExternalIp: () => '1.2.3.4',
      resolveProvider: () => provider,
      ...fakeIntervalTimers(),
    });
    const outcome = await u.start();
    expect(outcome.ok).toBe(true);
    expect(outcome.ip).toBe('1.2.3.4');
    expect(provider.calls).toEqual([
      { hostname: 'foo.duckdns.org', ip: '1.2.3.4', config: { token: 'T' } },
    ]);
    const status = u.getStatus();
    expect(status.lastUpdateOk).toBe(true);
    expect(status.lastError).toBeNull();
  });

  it('does not re-push when IP is unchanged', async () => {
    const provider = makeProvider();
    const secrets = makeSecrets({ [ddnsAccount('duckdns', 'token')]: 'T' });
    const timers = fakeIntervalTimers();
    let ip = '1.2.3.4';
    const u = new DdnsUpdater({
      settings: baseSettings,
      secrets,
      getExternalIp: () => ip,
      resolveProvider: () => provider,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    await u.start();
    expect(provider.calls).toHaveLength(1);

    await timers.fire();
    expect(provider.calls).toHaveLength(1);

    // Change the IP — next tick should call.
    ip = '5.6.7.8';
    await timers.fire();
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.ip).toBe('5.6.7.8');
  });

  it('records error but keeps timer running on provider throw', async () => {
    const provider = makeProvider();
    const secrets = makeSecrets({ [ddnsAccount('duckdns', 'token')]: 'T' });
    const timers = fakeIntervalTimers();
    let ip = '1.2.3.4';

    provider.shouldThrow = new NatError('ddns_update_failed', 'boom');

    const u = new DdnsUpdater({
      settings: baseSettings,
      secrets,
      getExternalIp: () => ip,
      resolveProvider: () => provider,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    await u.start();
    expect(u.getStatus().lastUpdateOk).toBe(false);
    expect(u.getStatus().lastError).toContain('boom');

    // Provider stops throwing — next change → success
    provider.shouldThrow = null;
    ip = '5.6.7.8';
    await timers.fire();

    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    expect(u.getStatus().lastUpdateOk).toBe(true);
    expect(u.getStatus().lastError).toBeNull();
  });

  it('reports ddns_credentials_missing when secrets are empty', async () => {
    const provider = makeProvider();
    const u = new DdnsUpdater({
      settings: baseSettings,
      secrets: makeSecrets(),
      getExternalIp: () => '1.2.3.4',
      resolveProvider: () => provider,
      ...fakeIntervalTimers(),
    });
    const outcome = await u.start();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/credential/i);
    expect(provider.calls).toHaveLength(0);
  });

  it('forceUpdate ignores unchanged-IP shortcut', async () => {
    const provider = makeProvider();
    const secrets = makeSecrets({ [ddnsAccount('duckdns', 'token')]: 'T' });
    const u = new DdnsUpdater({
      settings: baseSettings,
      secrets,
      getExternalIp: () => '1.2.3.4',
      resolveProvider: () => provider,
      ...fakeIntervalTimers(),
    });
    await u.start();
    await u.forceUpdate();
    expect(provider.calls).toHaveLength(2);
  });

  it('stop() clears the timer; idempotent', async () => {
    const provider = makeProvider();
    const secrets = makeSecrets({ [ddnsAccount('duckdns', 'token')]: 'T' });
    const timers = fakeIntervalTimers();
    const u = new DdnsUpdater({
      settings: baseSettings,
      secrets,
      getExternalIp: () => '1.2.3.4',
      resolveProvider: () => provider,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    await u.start();
    u.stop();
    u.stop();
    expect(timers.cleared).toBe(1);
  });

  it('updateSettings restarts with new config', async () => {
    const provider = makeProvider();
    const secrets = makeSecrets({ [ddnsAccount('duckdns', 'token')]: 'T' });
    const u = new DdnsUpdater({
      settings: baseSettings,
      secrets,
      getExternalIp: () => '1.2.3.4',
      resolveProvider: () => provider,
      ...fakeIntervalTimers(),
    });
    await u.start();
    expect(provider.calls).toHaveLength(1);

    await u.updateSettings({ ...baseSettings, hostname: 'bar.duckdns.org' });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.hostname).toBe('bar.duckdns.org');
  });

  it('records "external IP unknown" when getExternalIp returns null', async () => {
    const provider = makeProvider();
    const u = new DdnsUpdater({
      settings: baseSettings,
      secrets: makeSecrets({ [ddnsAccount('duckdns', 'token')]: 'T' }),
      getExternalIp: () => null,
      resolveProvider: () => provider,
      ...fakeIntervalTimers(),
    });
    const outcome = await u.start();
    expect(outcome.attempted).toBe(false);
    expect(outcome.error).toMatch(/unknown/i);
    expect(provider.calls).toHaveLength(0);
  });
});
