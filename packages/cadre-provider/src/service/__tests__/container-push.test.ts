import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContainerService, resolveTenantPush } from '../container-service.js';
import { MemoryStore } from '../store.js';
import type { Orchestrator, OrchestratorCreateRequest, OrchestratorCreateResult } from '../orchestrator.js';
import type { Container, CreateContainerRequest } from '../../types.js';
import type { ProviderPushConfig } from '../../config/types.js';

type ProvisionInternal = {
  provisionContainer(container: Container, request: CreateContainerRequest): Promise<void>;
};

const CREDS_A = { fcm: { projectId: 'A', clientEmail: 'a@a', privateKey: 'A-SECRET' } };
const CREDS_B = { apns: { keyId: 'B', teamId: 'B', bundleId: 'com.b', privateKey: 'B-SECRET' } };
const DEFAULT_CREDS = { fcm: { projectId: 'D', clientEmail: 'd@d', privateKey: 'D-SECRET' } };

const createResult: OrchestratorCreateResult = {
  dockerId: 'docker-xyz',
  healthEndpoint: 'http://localhost:18080/health',
  metricsEndpoint: 'http://localhost:19090/metrics',
  seedEndpoint: 'http://localhost:18080/seed',
  seedToken: 'seed-token',
  p2pPort: 14001,
};

function capturingOrchestrator(): { orchestrator: Orchestrator; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async (_req: OrchestratorCreateRequest) => createResult);
  const orchestrator = {
    createContainer: create,
    removeContainer: vi.fn(async () => {}),
    stopContainer: vi.fn(async () => {}),
    getStats: vi.fn(),
    isRunning: vi.fn(async () => true),
    getLogs: vi.fn(async () => ''),
  } as unknown as Orchestrator;
  return { orchestrator, create };
}

function container(customerId: string): Container {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id: `ctr_${customerId}`,
    customerId,
    partyId: `party-${customerId}`,
    profile: 'storage',
    status: 'pending',
    resources: {},
    tags: {},
    createdAt: now,
    updatedAt: now,
  };
}

function request(customerId: string): CreateContainerRequest {
  return { customerId, partyId: `party-${customerId}`, bootstrapNodes: [], profile: 'storage' };
}

const pushConfig: ProviderPushConfig = {
  default: DEFAULT_CREDS,
  tenants: { 'cust-a': CREDS_A, 'cust-b': CREDS_B },
};

const originalFetch = globalThis.fetch;
beforeEach(() => {
  // Make waitForEnrollment's health poll succeed on the first iteration so
  // provisionContainer resolves immediately instead of polling for 60s.
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ status: 'healthy' }),
  })) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('resolveTenantPush', () => {
  it('returns the per-tenant override when present', () => {
    expect(resolveTenantPush(pushConfig, 'cust-a')).toEqual(CREDS_A);
    expect(resolveTenantPush(pushConfig, 'cust-b')).toEqual(CREDS_B);
  });

  it('falls back to the default when the tenant has no override', () => {
    expect(resolveTenantPush(pushConfig, 'cust-z')).toEqual(DEFAULT_CREDS);
  });

  it('returns undefined when there is no push config', () => {
    expect(resolveTenantPush(undefined, 'cust-a')).toBeUndefined();
  });

  it('returns undefined when neither override nor default applies', () => {
    expect(resolveTenantPush({ tenants: { 'cust-a': CREDS_A } }, 'cust-z')).toBeUndefined();
  });
});

describe('ContainerService push injection', () => {
  it('injects the launching tenant credentials into the orchestrator request', async () => {
    const store = new MemoryStore();
    const { orchestrator, create } = capturingOrchestrator();
    const service = new ContainerService({ store, orchestrator, push: pushConfig });

    const c = container('cust-a');
    await store.saveContainer(c);
    await (service as unknown as ProvisionInternal).provisionContainer(c, request('cust-a'));

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].push).toEqual(CREDS_A);
  });

  it('NEVER leaks another tenant credentials into a tenant node (cross-tenant isolation)', async () => {
    const store = new MemoryStore();
    const { orchestrator, create } = capturingOrchestrator();
    const service = new ContainerService({ store, orchestrator, push: pushConfig });

    const c = container('cust-b');
    await store.saveContainer(c);
    await (service as unknown as ProvisionInternal).provisionContainer(c, request('cust-b'));

    const injected = create.mock.calls[0]![0].push;
    expect(injected).toEqual(CREDS_B);
    // The serialized request for tenant B must not contain tenant A's (or the default's) secret.
    const serialized = JSON.stringify(create.mock.calls[0]![0]);
    expect(serialized).not.toContain('A-SECRET');
    expect(serialized).not.toContain('D-SECRET');
    expect(serialized).toContain('B-SECRET');
  });

  it('falls back to the provider default for a tenant with no override', async () => {
    const store = new MemoryStore();
    const { orchestrator, create } = capturingOrchestrator();
    const service = new ContainerService({ store, orchestrator, push: pushConfig });

    const c = container('cust-z');
    await store.saveContainer(c);
    await (service as unknown as ProvisionInternal).provisionContainer(c, request('cust-z'));

    expect(create.mock.calls[0]![0].push).toEqual(DEFAULT_CREDS);
  });

  it('omits push entirely when no push config is supplied', async () => {
    const store = new MemoryStore();
    const { orchestrator, create } = capturingOrchestrator();
    const service = new ContainerService({ store, orchestrator });

    const c = container('cust-a');
    await store.saveContainer(c);
    await (service as unknown as ProvisionInternal).provisionContainer(c, request('cust-a'));

    expect(create.mock.calls[0]![0].push).toBeUndefined();
  });
});
