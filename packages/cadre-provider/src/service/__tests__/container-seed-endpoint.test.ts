import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContainerService } from '../container-service.js';
import { MemoryStore } from '../store.js';
import { MockOrchestrator } from '../orchestrator.js';
import type { Container, CreateContainerRequest } from '../../types.js';

/** Private surface of ContainerService we drive directly in tests. */
type ProvisionInternal = {
  provisionContainer(container: Container, request: CreateContainerRequest): Promise<void>;
};

/** A fetch Response stand-in carrying a JSON body. */
function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

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

/** Build a ContainerService over a MemoryStore seeded with the given container. */
async function makeService(container: Container): Promise<{ service: ContainerService; store: MemoryStore }> {
  const store = new MemoryStore();
  await store.saveContainer(container);
  const service = new ContainerService({ store, orchestrator: new MockOrchestrator() });
  return { service, store };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('ContainerService seed endpoint provisioning', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('persists a /seed endpoint on the health server port after provisioning', async () => {
    const container = pendingContainer();
    const { service, store } = await makeService(container);

    // /health responds healthy so waitForEnrollment resolves immediately.
    globalThis.fetch = vi.fn(async () => jsonResponse({ status: 'healthy' })) as typeof globalThis.fetch;

    await (service as unknown as ProvisionInternal).provisionContainer(container, provisionRequest);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.seedEndpoint).toBeDefined();
    expect(stored?.seedEndpoint).toMatch(/\/seed$/);
    // Seed API shares the health server's host/port — only the path differs.
    expect(stored?.seedEndpoint).toBe(stored?.healthEndpoint?.replace('/health', '/seed'));
  });

  it('applySeed POSTs { seed } to the seed endpoint and returns the node result', async () => {
    const container = pendingContainer();
    const { service } = await makeService(container);

    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/seed')) return jsonResponse({ success: true, peersAdded: 2 });
      return jsonResponse({ status: 'healthy' }); // /health during enrollment
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await (service as unknown as ProvisionInternal).provisionContainer(container, provisionRequest);

    const result = await service.applySeed('ctr_1', 'encoded-seed-xyz');

    expect(result).toEqual({ success: true, peersAdded: 2 });

    const seedCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/seed'));
    expect(seedCall).toBeDefined();
    const [seedUrl, init] = seedCall!;
    expect(String(seedUrl)).toMatch(/\/seed$/);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ seed: 'encoded-seed-xyz' });
    // The container gates POST /seed behind a bearer token; the MockOrchestrator
    // hands back `mock-seed-token-1` for the first container, so applySeed must
    // present it verbatim.
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer mock-seed-token-1');
  });

  it('applySeed sends the persisted seed token as a bearer header', async () => {
    const { service } = await makeService(pendingContainer({
      status: 'running',
      seedEndpoint: 'http://localhost:8081/seed',
      seedToken: 'secret-token-abc',
    }));
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({ success: true, peersAdded: 1 }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await service.applySeed('ctr_1', 'encoded-seed-xyz');

    expect(result).toEqual({ success: true, peersAdded: 1 });
    const init = fetchMock.mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token-abc');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('applySeed fails with a clear error when the container has no seed token', async () => {
    // An endpoint but no token (e.g. a legacy record provisioned before token
    // injection) can never authenticate — fail loudly rather than hit a 401.
    const { service } = await makeService(pendingContainer({
      status: 'running',
      seedEndpoint: 'http://localhost:8081/seed',
      seedToken: undefined,
    }));
    globalThis.fetch = vi.fn() as typeof globalThis.fetch;

    const result = await service.applySeed('ctr_1', 'encoded-seed-xyz');

    expect(result).toEqual({ success: false, error: 'Container does not have a seed token' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('applySeed still guards containers that were never provisioned with a seed endpoint', async () => {
    // A running container with no seedEndpoint (e.g. legacy record) must fail the guard.
    const { service } = await makeService(pendingContainer({ status: 'running', seedEndpoint: undefined }));
    globalThis.fetch = vi.fn() as typeof globalThis.fetch;

    const result = await service.applySeed('ctr_1', 'encoded-seed-xyz');

    expect(result).toEqual({ success: false, error: 'Container does not have a seed endpoint' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('applySeed forwards while the container is still enrolling (cold-start flow)', async () => {
    // docs/architecture.md Provider Flow steps 6-8 forward the seed during
    // enrollment, before the node is fully running — the guard allows 'enrolling'.
    const { service } = await makeService(pendingContainer({
      status: 'enrolling',
      seedEndpoint: 'http://localhost:8081/seed',
      seedToken: 'enrolling-token',
    }));
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse({ success: true, peersAdded: 1 }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await service.applySeed('ctr_1', 'encoded-seed-xyz');

    expect(result).toEqual({ success: true, peersAdded: 1 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://localhost:8081/seed');
  });

  it('applySeed surfaces a non-OK node response as an error', async () => {
    const { service } = await makeService(pendingContainer({
      status: 'running',
      seedEndpoint: 'http://localhost:8081/seed',
      seedToken: 'running-token',
    }));
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: 'bad seed' }, false)) as typeof globalThis.fetch;

    const result = await service.applySeed('ctr_1', 'encoded-seed-xyz');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Seed endpoint returned 500:/);
  });
});
