import { describe, it, expect, afterEach } from 'vitest';
import { applyEnvironmentOverrides, parseStrandFilter } from '../src/config/loader.js';
import type { CliConfigFile } from '../src/config/types.js';

const baseConfig: CliConfigFile = {
  controlNetwork: { partyId: 'party-1', bootstrapNodes: [] },
  profile: 'storage',
};

const FCM = { projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: 'PEMKEY' };

describe('environment override: empty value means unspecified', () => {
  afterEach(() => {
    delete process.env.CADRE_ENABLE_RELAY;
    delete process.env.CADRE_LISTEN_ADDRS;
    delete process.env.CADRE_STORAGE_TYPE;
    delete process.env.CADRE_STRAND_FILTER;
    delete process.env.CADRE_PUSH;
    delete process.env.CADRE_PARTY_ID;
  });

  it('leaves a config-file boolean untouched when the env var is empty (docker-compose default)', () => {
    process.env.CADRE_ENABLE_RELAY = '';
    const merged = applyEnvironmentOverrides({ ...baseConfig, network: { enableRelay: true } });
    expect(merged.network?.enableRelay).toBe(true);
  });

  it('does not invent network.enableRelay when unset in the file and the env var is empty', () => {
    process.env.CADRE_ENABLE_RELAY = '';
    const merged = applyEnvironmentOverrides({ ...baseConfig });
    expect(merged.network?.enableRelay).toBeUndefined();
  });

  it('treats a whitespace-only value the same as empty', () => {
    process.env.CADRE_ENABLE_RELAY = '   ';
    const merged = applyEnvironmentOverrides({ ...baseConfig, network: { enableRelay: true } });
    expect(merged.network?.enableRelay).toBe(true);
  });

  it('leaves a config-file listenAddrs list untouched when the env var is empty', () => {
    process.env.CADRE_LISTEN_ADDRS = '';
    const merged = applyEnvironmentOverrides({ ...baseConfig, network: { listenAddrs: ['/ip4/0.0.0.0/tcp/4001'] } });
    expect(merged.network?.listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/4001']);
  });

  it('leaves a config-file strandFilter untouched when the env var is empty', () => {
    process.env.CADRE_STRAND_FILTER = '';
    const merged = applyEnvironmentOverrides({ ...baseConfig, strandFilter: { sAppId: 'myapp' } });
    expect(parseStrandFilter(merged.strandFilter)).toEqual({ mode: 'sAppId', sAppId: 'myapp' });
  });

  it('leaves a config-file push block untouched when the env var is empty', () => {
    process.env.CADRE_PUSH = '';
    const merged = applyEnvironmentOverrides({ ...baseConfig, push: { fcm: FCM } });
    expect(merged.push).toEqual({ fcm: FCM });
  });

  it('does not mutate the caller config when an override writes a nested path', () => {
    process.env.CADRE_ENABLE_RELAY = 'false';
    process.env.CADRE_PARTY_ID = 'party-2';
    const input: CliConfigFile = { ...baseConfig, network: { enableRelay: true } };
    const merged = applyEnvironmentOverrides(input);

    expect(merged.network?.enableRelay).toBe(false);
    expect(input.network?.enableRelay).toBe(true);
    expect(merged.controlNetwork.partyId).toBe('party-2');
    expect(baseConfig.controlNetwork.partyId).toBe('party-1');
  });

  it('still applies a non-empty override', () => {
    process.env.CADRE_ENABLE_RELAY = 'false';
    const merged = applyEnvironmentOverrides({ ...baseConfig, network: { enableRelay: true } });
    expect(merged.network?.enableRelay).toBe(false);

    process.env.CADRE_STORAGE_TYPE = 'memory';
    const merged2 = applyEnvironmentOverrides({ ...baseConfig, storage: { type: 'file' } });
    expect(merged2.storage?.type).toBe('memory');
  });
});
