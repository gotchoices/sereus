import { describe, it, expect, vi } from 'vitest';
import type Docker from 'dockerode';
import { DockerOrchestrator } from '../docker-orchestrator.js';
import type { DockerConfig } from '../../config/types.js';
import type { OrchestratorCreateRequest } from '../orchestrator.js';
import { volumeStubs } from './fake-docker.js';

const PUSH = {
  fcm: { projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----' },
  cooldownMs: 1000,
};

function config(): DockerConfig {
  return { image: 'test-image', portRange: { start: 12000, end: 12099 } };
}

/** Fake docker that records the Env passed to createContainer. */
function captureDocker(): { docker: Docker; lastEnv: () => string[] } {
  let env: string[] = [];
  const docker = {
    createContainer: vi.fn(async (spec: { Env: string[] }) => {
      env = spec.Env;
      return { id: 'cid', start: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
    }),
    getContainer: vi.fn(),
    ...volumeStubs(),
  } as unknown as Docker;
  return { docker, lastEnv: () => env };
}

const base: OrchestratorCreateRequest = {
  containerId: 'ctr_1',
  partyId: 'party-1',
  bootstrapNodes: [],
  profile: 'storage',
};

describe('DockerOrchestrator CADRE_PUSH injection', () => {
  it('serializes the request push block into a single CADRE_PUSH env var', async () => {
    const { docker, lastEnv } = captureDocker();
    const orch = new DockerOrchestrator(config(), docker);

    await orch.createContainer({ ...base, push: PUSH });

    const pushEnv = lastEnv().find((e) => e.startsWith('CADRE_PUSH='));
    expect(pushEnv).toBeDefined();
    const json = pushEnv!.slice('CADRE_PUSH='.length);
    expect(JSON.parse(json)).toEqual(PUSH);
    // The PEM newlines survive JSON encoding (no bare newline in the env entry).
    expect(pushEnv).not.toContain('\n');
  });

  it('omits CADRE_PUSH when the request carries no push block', async () => {
    const { docker, lastEnv } = captureDocker();
    const orch = new DockerOrchestrator(config(), docker);

    await orch.createContainer(base);

    expect(lastEnv().some((e) => e.startsWith('CADRE_PUSH='))).toBe(false);
  });
});

describe('DockerOrchestrator CADRE_OWNER_KEYS injection', () => {
  it('joins the pinned owner keys into one comma-separated env var', async () => {
    const { docker, lastEnv } = captureDocker();
    const orch = new DockerOrchestrator(config(), docker);

    await orch.createContainer({ ...base, pinnedOwnerKeys: ['key-a', 'key-b'] });

    expect(lastEnv()).toContain('CADRE_OWNER_KEYS=key-a,key-b');
  });

  it('injects a single key without a trailing separator', async () => {
    const { docker, lastEnv } = captureDocker();
    const orch = new DockerOrchestrator(config(), docker);

    await orch.createContainer({ ...base, pinnedOwnerKeys: ['only-key'] });

    expect(lastEnv()).toContain('CADRE_OWNER_KEYS=only-key');
  });

  it('omits CADRE_OWNER_KEYS when the request carries no pinned keys', async () => {
    const { docker, lastEnv } = captureDocker();
    const orch = new DockerOrchestrator(config(), docker);

    await orch.createContainer(base);

    expect(lastEnv().some((e) => e.startsWith('CADRE_OWNER_KEYS='))).toBe(false);
  });

  it('omits CADRE_OWNER_KEYS for an empty pinned-key array (never a bare var)', async () => {
    const { docker, lastEnv } = captureDocker();
    const orch = new DockerOrchestrator(config(), docker);

    await orch.createContainer({ ...base, pinnedOwnerKeys: [] });

    expect(lastEnv().some((e) => e.startsWith('CADRE_OWNER_KEYS='))).toBe(false);
  });
});
