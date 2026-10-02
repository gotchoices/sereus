import { describe, it, expect } from 'vitest';
import { applyEnvironmentOverrides, parseStrandFilter, validateConfig } from '../src/config/index.js';
import type { CliConfig, CliConfigFile } from '../src/config/types.js';

const baseConfig: CliConfigFile = {
  controlNetwork: { partyId: 'party-1', bootstrapNodes: [] },
  profile: 'storage',
};

const FCM = { projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: 'PEMKEY' };

/** The startup merge: `env` written over `file`, then validated, as `resolveConfig` does it. */
function merge(file: CliConfigFile, env: NodeJS.ProcessEnv): CliConfig {
  const { tree, provenance } = applyEnvironmentOverrides(file, env);
  return validateConfig(tree, provenance, 'cadre.yaml');
}

describe('environment override: empty value means unspecified', () => {
  it('leaves a config-file boolean untouched when the env var is empty (docker-compose default)', () => {
    const merged = merge({ ...baseConfig, network: { enableRelay: true } }, { CADRE_ENABLE_RELAY: '' });
    expect(merged.network?.enableRelay).toBe(true);
  });

  it('does not invent network.enableRelay when unset in the file and the env var is empty', () => {
    const merged = merge({ ...baseConfig }, { CADRE_ENABLE_RELAY: '' });
    expect(merged.network?.enableRelay).toBeUndefined();
  });

  it('treats a whitespace-only value the same as empty', () => {
    const merged = merge({ ...baseConfig, network: { enableRelay: true } }, { CADRE_ENABLE_RELAY: '   ' });
    expect(merged.network?.enableRelay).toBe(true);
  });

  it('leaves a config-file listenAddrs list untouched when the env var is empty', () => {
    const merged = merge(
      { ...baseConfig, network: { listenAddrs: ['/ip4/0.0.0.0/tcp/4001'] } },
      { CADRE_LISTEN_ADDRS: '' },
    );
    expect(merged.network?.listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/4001']);
  });

  it('leaves a config-file strandFilter untouched when the env var is empty', () => {
    const merged = merge({ ...baseConfig, strandFilter: { sAppId: 'myapp' } }, { CADRE_STRAND_FILTER: '' });
    expect(parseStrandFilter(merged.strandFilter)).toEqual({ mode: 'sAppId', sAppId: 'myapp' });
  });

  it('leaves a config-file push block untouched when the env var is empty', () => {
    const merged = merge({ ...baseConfig, push: { fcm: FCM } }, { CADRE_PUSH: '' });
    expect(merged.push).toEqual({ fcm: FCM });
  });

  it('does not mutate the caller config when an override writes a nested path', () => {
    const input: CliConfigFile = { ...baseConfig, network: { enableRelay: true } };
    const merged = merge(input, { CADRE_ENABLE_RELAY: 'false', CADRE_PARTY_ID: 'party-2' });

    expect(merged.network?.enableRelay).toBe(false);
    expect(input.network?.enableRelay).toBe(true);
    expect(merged.controlNetwork.partyId).toBe('party-2');
    expect(baseConfig.controlNetwork?.partyId).toBe('party-1');
  });

  it('still applies a non-empty override', () => {
    const merged = merge({ ...baseConfig, network: { enableRelay: true } }, { CADRE_ENABLE_RELAY: 'false' });
    expect(merged.network?.enableRelay).toBe(false);

    const merged2 = merge(
      { ...baseConfig, storage: { type: 'file', path: '/data' } },
      { CADRE_STORAGE_TYPE: 'memory' },
    );
    expect(merged2.storage?.type).toBe('memory');
  });
});
