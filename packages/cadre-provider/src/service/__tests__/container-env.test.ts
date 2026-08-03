import { describe, it, expect, vi } from 'vitest';
import type Docker from 'dockerode';
import { buildNodeEnv } from '../container-env.js';
import { DockerOrchestrator } from '../docker-orchestrator.js';
import type { DockerConfig } from '../../config/types.js';
import type { OrchestratorCreateRequest } from '../orchestrator.js';
import { volumeStubs } from './fake-docker.js';

const base: OrchestratorCreateRequest = {
  containerId: 'ctr_1',
  partyId: 'party-1',
  bootstrapNodes: ['/ip4/1.2.3.4/tcp/4001/p2p/peer1'],
  profile: 'storage',
};

describe('buildNodeEnv', () => {
  it('emits exactly the seven always-present vars for a minimal request, no empty entries', () => {
    const env = buildNodeEnv({ request: base, seedToken: 'tok' });

    expect(env).toEqual([
      'CADRE_PARTY_ID=party-1',
      'CADRE_BOOTSTRAP_NODES=/ip4/1.2.3.4/tcp/4001/p2p/peer1',
      'CADRE_PROFILE=storage',
      'CADRE_HEALTH_PORT=8080',
      'CADRE_METRICS_PORT=9090',
      'CADRE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/4001',
      'CADRE_SEED_TOKEN=tok',
    ]);
  });

  it('includes CADRE_OWNER_KEYS joined when pinnedOwnerKeys is non-empty', () => {
    const env = buildNodeEnv({ request: { ...base, pinnedOwnerKeys: ['a', 'b'] }, seedToken: 'tok' });
    expect(env).toContain('CADRE_OWNER_KEYS=a,b');
  });

  it('omits CADRE_OWNER_KEYS entirely for an empty array', () => {
    const env = buildNodeEnv({ request: { ...base, pinnedOwnerKeys: [] }, seedToken: 'tok' });
    expect(env.some(e => e.startsWith('CADRE_OWNER_KEYS='))).toBe(false);
  });

  it('omits CADRE_OWNER_KEYS entirely when undefined', () => {
    const env = buildNodeEnv({ request: base, seedToken: 'tok' });
    expect(env.some(e => e.startsWith('CADRE_OWNER_KEYS='))).toBe(false);
  });

  it('substitutes custom ports into CADRE_HEALTH_PORT / CADRE_METRICS_PORT / CADRE_LISTEN_ADDRS', () => {
    const env = buildNodeEnv({
      request: base,
      seedToken: 'tok',
      ports: { health: 18080, metrics: 19090, p2p: 14001 },
    });

    expect(env).toContain('CADRE_HEALTH_PORT=18080');
    expect(env).toContain('CADRE_METRICS_PORT=19090');
    expect(env).toContain('CADRE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/14001');
  });
});

describe('buildNodeEnv matches what DockerOrchestrator actually sends', () => {
  it('produces the exact Env array DockerOrchestrator passes to docker.createContainer', async () => {
    let capturedEnv: string[] = [];
    const fakeDocker = {
      createContainer: vi.fn(async (opts: { Env: string[] }) => {
        capturedEnv = opts.Env;
        return { id: 'cid', start: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
      }),
      getContainer: vi.fn(),
      ...volumeStubs(),
    } as unknown as Docker;

    const config: DockerConfig = { image: 'test-image', portRange: { start: 15000, end: 15099 } };
    const orch = new DockerOrchestrator(config, fakeDocker);

    const request: OrchestratorCreateRequest = {
      ...base,
      strandFilter: 'strand-a',
      resources: { storageQuotaBytes: 1024 },
      push: { fcm: { projectId: 'p', clientEmail: 'e', privateKey: 'k' }, cooldownMs: 10 },
      pinnedOwnerKeys: ['owner-a'],
    };

    const result = await orch.createContainer(request);

    expect(capturedEnv).toEqual(buildNodeEnv({ request, seedToken: result.seedToken, resources: request.resources }));
  });
});
