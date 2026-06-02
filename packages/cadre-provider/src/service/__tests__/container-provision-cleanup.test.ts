import { describe, it, expect, vi, afterEach } from 'vitest';
import { ContainerService } from '../container-service.js';
import { MemoryStore } from '../store.js';
import type { Orchestrator, OrchestratorCreateResult } from '../orchestrator.js';
import type { Container, CreateContainerRequest } from '../../types.js';

/** Private surface of ContainerService we drive directly in tests. */
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
  p2pPort: 14001,
};

/** Stub orchestrator with spies; createContainer resolves to a fixed result by default. */
function stubOrchestrator(overrides: Partial<Orchestrator> = {}): {
  orchestrator: Orchestrator;
  createContainer: ReturnType<typeof vi.fn>;
  removeContainer: ReturnType<typeof vi.fn>;
} {
  const createContainer = vi.fn(async () => createResult);
  const removeContainer = vi.fn(async () => {});
  const orchestrator = {
    createContainer,
    removeContainer,
    stopContainer: vi.fn(async () => {}),
    getStats: vi.fn(),
    isRunning: vi.fn(async () => false),
    getLogs: vi.fn(async () => ''),
    ...overrides,
  } as unknown as Orchestrator;
  return { orchestrator, createContainer, removeContainer };
}

/** MemoryStore that throws on the Nth saveContainer call (0 = never). */
class SaveFailsStore extends MemoryStore {
  failOnSave = 0;
  saves = 0;
  override async saveContainer(container: Container): Promise<void> {
    this.saves++;
    if (this.saves === this.failOnSave) throw new Error('save failed');
    return super.saveContainer(container);
  }
}

/** MemoryStore where getContainer returns undefined after the Nth call. */
class VanishingStore extends MemoryStore {
  vanishAfter = Infinity;
  getCalls = 0;
  override async getContainer(id: string): Promise<Container | undefined> {
    this.getCalls++;
    if (this.getCalls > this.vanishAfter) return undefined;
    return super.getContainer(id);
  }
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('ContainerService.provisionContainer orchestrator cleanup', () => {
  it('reclaims the created container when a post-create step fails', async () => {
    const store = new SaveFailsStore();
    const container = pendingContainer();
    await store.saveContainer(container);   // seed (save #1)
    store.failOnSave = 3;                    // creating-save ok (#2); enrolling-save throws (#3)

    const { orchestrator, createContainer, removeContainer } = stubOrchestrator();
    const service = new ContainerService({ store, orchestrator });

    await (service as unknown as ProvisionInternal).provisionContainer(container, provisionRequest);

    // Container was created, then a later step threw — its resources must be reclaimed.
    expect(createContainer).toHaveBeenCalledTimes(1);
    expect(removeContainer).toHaveBeenCalledWith('docker-xyz');

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('error');
    expect(stored?.error).toBe('save failed');
  });

  it('reclaims the created container when the record vanishes after create', async () => {
    const store = new VanishingStore();
    const container = pendingContainer();
    await store.saveContainer(container);   // seeding does not call getContainer
    store.vanishAfter = 1;                   // real on the 'creating' read, gone afterwards

    const { orchestrator, createContainer, removeContainer } = stubOrchestrator();
    const service = new ContainerService({ store, orchestrator });

    await (service as unknown as ProvisionInternal).provisionContainer(container, provisionRequest);

    expect(createContainer).toHaveBeenCalledTimes(1);
    // Record gone after a successful create → reclaim so the ports are not orphaned.
    expect(removeContainer).toHaveBeenCalledWith('docker-xyz');
  });

  it('does not reclaim when the orchestrator create itself fails', async () => {
    const store = new MemoryStore();
    const container = pendingContainer();
    await store.saveContainer(container);

    const { orchestrator, createContainer, removeContainer } = stubOrchestrator();
    createContainer.mockImplementation(async () => { throw new Error('create failed'); });
    const service = new ContainerService({ store, orchestrator });

    await (service as unknown as ProvisionInternal).provisionContainer(container, provisionRequest);

    expect(createContainer).toHaveBeenCalledTimes(1);
    // No dockerId was produced — the orchestrator self-cleans internally, so the
    // service must not call removeContainer with an undefined id.
    expect(removeContainer).not.toHaveBeenCalled();

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('error');
    expect(stored?.error).toBe('create failed');
  });

  it('does not reclaim on a successful provision', async () => {
    const store = new MemoryStore();
    const container = pendingContainer();
    await store.saveContainer(container);

    const { orchestrator, createContainer, removeContainer } = stubOrchestrator();
    const service = new ContainerService({ store, orchestrator });

    // /health responds healthy so waitForEnrollment resolves to 'running'.
    globalThis.fetch = vi.fn(async () =>
      ({ ok: true, json: async () => ({ status: 'healthy' }) }) as unknown as Response,
    ) as typeof globalThis.fetch;

    await (service as unknown as ProvisionInternal).provisionContainer(container, provisionRequest);

    expect(createContainer).toHaveBeenCalledTimes(1);
    expect(removeContainer).not.toHaveBeenCalled();

    const stored = await store.getContainer('ctr_1');
    expect(stored?.dockerId).toBe('docker-xyz');
    expect(stored?.status).toBe('running');
  });
});
