import { describe, it, expect, vi } from 'vitest';
import type Docker from 'dockerode';
import { buildNodeEnv } from '../container-env.js';
import { DockerOrchestrator } from '../docker-orchestrator.js';
import type { DockerConfig } from '../../config/types.js';
import type { OrchestratorCreateRequest } from '../orchestrator.js';
import { UNCLAIMED_PARTY_ID } from '../../types.js';
import { daemonStubs } from './fake-docker.js';

const base: OrchestratorCreateRequest = {
  containerId: 'ctr_1',
  partyId: 'party-1',
  profile: 'storage',
};

describe('buildNodeEnv', () => {
  it('emits exactly the five vars of a minimal request, no empty entries', () => {
    const env = buildNodeEnv({ request: base });

    expect(env).toEqual([
      'CADRE_PARTY_ID=party-1',
      'CADRE_PROFILE=storage',
      'CADRE_HEALTH_PORT=8080',
      'CADRE_METRICS_PORT=9090',
      'CADRE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/4001,/ip4/0.0.0.0/tcp/4002/ws',
    ]);
  });

  it('substitutes custom ports into CADRE_HEALTH_PORT / CADRE_METRICS_PORT / CADRE_LISTEN_ADDRS', () => {
    const env = buildNodeEnv({
      request: base,
      ports: { health: 18080, metrics: 19090, p2p: 14001, ws: 14002 },
    });

    expect(env).toContain('CADRE_HEALTH_PORT=18080');
    expect(env).toContain('CADRE_METRICS_PORT=19090');
    expect(env).toContain('CADRE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/14001,/ip4/0.0.0.0/tcp/14002/ws');
  });
});

describe('buildNodeEnv join', () => {
  it('a claim emits CADRE_CLAIM_SECRET and the placeholder party', () => {
    const env = buildNodeEnv({
      request: { ...base, partyId: UNCLAIMED_PARTY_ID, join: { kind: 'claim', secret: 's3cret' } },
    });

    expect(env).toContain('CADRE_CLAIM_SECRET=s3cret');
    expect(env).toContain(`CADRE_PARTY_ID=${UNCLAIMED_PARTY_ID}`);
    expect(env.some(e => e.startsWith('CADRE_INVITATION='))).toBe(false);
  });

  it('an invitation emits CADRE_INVITATION with the bundle verbatim and the bundle\'s party', () => {
    const env = buildNodeEnv({
      request: { ...base, partyId: 'party-invited', join: { kind: 'invitation', invitation: 'sereus-invite:1.abc' } },
    });

    expect(env).toContain('CADRE_INVITATION=sereus-invite:1.abc');
    expect(env).toContain('CADRE_PARTY_ID=party-invited');
    expect(env.some(e => e.startsWith('CADRE_CLAIM_SECRET='))).toBe(false);
  });
});

/** Drive a real `DockerOrchestrator` against a fake dockerode, capturing the `Env` it sends. */
async function captureOrchestratorEnv(
  request: OrchestratorCreateRequest,
  config: DockerConfig
): Promise<string[]> {
  let env: string[] = [];
  const fakeDocker = {
    createContainer: vi.fn(async (opts: { Env: string[] }) => {
      env = opts.Env;
      return { id: 'cid', start: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
    }),
    getContainer: vi.fn(),
    ...daemonStubs(),
  } as unknown as Docker;

  await new DockerOrchestrator(config, fakeDocker).createContainer(request);
  return env;
}

const dockerConfig: DockerConfig = { image: 'test-image', portRange: { start: 15000, end: 15099 } };

describe('buildNodeEnv matches what DockerOrchestrator actually sends', () => {
  it('produces the exact Env array DockerOrchestrator passes to docker.createContainer', async () => {
    const request: OrchestratorCreateRequest = {
      ...base,
      strandFilter: 'strand-a',
      resources: { storageQuotaBytes: 1024 },
      push: { fcm: { projectId: 'p', clientEmail: 'e', privateKey: 'k' }, cooldownMs: 10 },
      join: { kind: 'claim', secret: 's3cret' },
    };

    const env = await captureOrchestratorEnv(request, dockerConfig);

    expect(env).toEqual(buildNodeEnv({ request, resources: request.resources }));
  });

  it('carries the config default resources when the request omits its own', async () => {
    const config: DockerConfig = { ...dockerConfig, defaultResources: { storageQuotaBytes: 4096 } };

    const env = await captureOrchestratorEnv(base, config);

    expect(env).toContain('CADRE_STORAGE_QUOTA=4096');
    expect(env).toEqual(buildNodeEnv({ request: base, resources: config.defaultResources }));
  });

  it('lets the request resources override the config default', async () => {
    const config: DockerConfig = { ...dockerConfig, defaultResources: { storageQuotaBytes: 4096 } };
    const request: OrchestratorCreateRequest = { ...base, resources: { storageQuotaBytes: 1024 } };

    const env = await captureOrchestratorEnv(request, config);

    expect(env).toContain('CADRE_STORAGE_QUOTA=1024');
    expect(env.some(e => e === 'CADRE_STORAGE_QUOTA=4096')).toBe(false);
  });
});
