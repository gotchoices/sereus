import { describe, it, expect, afterEach } from 'vitest';
import { applyEnvironmentOverrides } from '../src/config/loader.js';
import type { CliConfigFile } from '../src/config/types.js';

const baseConfig: CliConfigFile = {
  controlNetwork: { partyId: 'party-1', bootstrapNodes: [] },
  profile: 'storage',
};

describe('environment override: empty value means unspecified', () => {
  afterEach(() => {
    delete process.env.CADRE_ENABLE_RELAY;
    delete process.env.CADRE_LISTEN_ADDRS;
    delete process.env.CADRE_STORAGE_TYPE;
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

  it('still applies a non-empty override', () => {
    process.env.CADRE_ENABLE_RELAY = 'false';
    const merged = applyEnvironmentOverrides({ ...baseConfig, network: { enableRelay: true } });
    expect(merged.network?.enableRelay).toBe(false);

    process.env.CADRE_STORAGE_TYPE = 'memory';
    const merged2 = applyEnvironmentOverrides({ ...baseConfig, storage: { type: 'file' } });
    expect(merged2.storage?.type).toBe('memory');
  });
});
