import { describe, it, expect, vi, afterEach } from 'vitest';
import { ContainerService } from '../container-service.js';
import { MemoryStore } from '../store.js';
import type { Orchestrator, OrchestratorCreateResult } from '../orchestrator.js';
import type { Container, CreateContainerRequest } from '../../types.js';

type ProvisionInternal = {
  provisionContainer(container: Container, request: CreateContainerRequest): Promise<void>;
};

function pendingContainer(overrides: Partial<Container> = {}): Container {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id: 'ctr_1',
    customerId: 'cust-1',
    partyId: 'party-1',
    profile: 'transaction',
    status: 'pending',
    resources: {},
    tags: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const provisionRequest: CreateContainerRequest = {
  customerId: 'cust-1',
  partyId: 'party-1',
  bootstrapNodes: [],
  profile: 'transaction',
};

const createResult: OrchestratorCreateResult = {
  dockerId: 'docker-xyz',
  healthEndpoint: 'http://localhost:18080/health',
  metricsEndpoint: 'http://localhost:19090/metrics',
  seedEndpoint: 'http://localhost:18080/seed',
  seedToken: 'seed-token-xyz',
  p2pPort: 14001,
};

function stubOrchestrator(): { orchestrator: Orchestrator; createContainer: ReturnType<typeof vi.fn> } {
  const createContainer = vi.fn(async () => createResult);
  const orchestrator = {
    createContainer,
    removeContainer: vi.fn(async () => {}),
    stopContainer: vi.fn(async () => {}),
    getStats: vi.fn(),
    isRunning: vi.fn(async () => false),
    getLogs: vi.fn(async () => ''),
  } as unknown as Orchestrator;
  return { orchestrator, createContainer };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('ContainerService.provisionContainer peerId recording', () => {
  it('stamps peerId on the record and reaches running when /status reports healthy with a peerId', async () => {
    const store = new MemoryStore();
    const container = pendingContainer();
    await store.saveContainer(container);
    const { orchestrator } = stubOrchestrator();
    const service = new ContainerService({ store, orchestrator });

    globalThis.fetch = vi.fn(async () =>
      ({ ok: true, json: async () => ({ status: 'healthy', peerId: '12D3KooWabc' }) }) as unknown as Response,
    ) as typeof globalThis.fetch;

    await (service as unknown as ProvisionInternal).provisionContainer(container, provisionRequest);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('running');
    expect(stored?.peerId).toBe('12D3KooWabc');
  });

  it('reaches running with peerId left unset when /status reports healthy but peerId is null', async () => {
    const store = new MemoryStore();
    const container = pendingContainer();
    await store.saveContainer(container);
    const { orchestrator } = stubOrchestrator();
    const service = new ContainerService({ store, orchestrator });

    globalThis.fetch = vi.fn(async () =>
      ({ ok: true, json: async () => ({ status: 'healthy', peerId: null }) }) as unknown as Response,
    ) as typeof globalThis.fetch;

    await (service as unknown as ProvisionInternal).provisionContainer(container, provisionRequest);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('running');
    expect(stored?.peerId).toBeUndefined();
  });

  it('polls the derived /status URL, not /health', async () => {
    const store = new MemoryStore();
    const container = pendingContainer();
    await store.saveContainer(container);
    const { orchestrator } = stubOrchestrator();
    const service = new ContainerService({ store, orchestrator });

    const fetchMock = vi.fn(async () =>
      ({ ok: true, json: async () => ({ status: 'healthy', peerId: '12D3KooWxyz' }) }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await (service as unknown as ProvisionInternal).provisionContainer(container, provisionRequest);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:18080/status');
  });
});
