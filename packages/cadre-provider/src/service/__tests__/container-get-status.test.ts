import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContainerService } from '../container-service.js';
import { MemoryStore } from '../store.js';
import { MockOrchestrator } from '../orchestrator.js';
import type { Container } from '../../types.js';

/** A fetch Response stand-in carrying a JSON body. */
function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

function runningContainer(overrides: Partial<Container> = {}): Container {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id: 'ctr_1',
    customerId: 'cust-1',
    partyId: 'party-1',
    profile: 'transaction',
    status: 'running',
    dockerId: 'docker-1',
    healthEndpoint: 'http://localhost:8080/health',
    resources: {},
    tags: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Build a ContainerService over a MemoryStore seeded with the given container. */
async function makeService(container: Container): Promise<{ service: ContainerService; store: MemoryStore }> {
  const store = new MemoryStore();
  await store.saveContainer(container);
  const service = new ContainerService({ store, orchestrator: new MockOrchestrator() });
  return { service, store };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('ContainerService.getContainerStatus health shape', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('parses the live /status payload into the wire-accurate node.strands shape', async () => {
    const { service } = await makeService(runningContainer());

    // Real HealthStatus body: strands live under node.strands, NOT top-level.
    globalThis.fetch = vi.fn(async () => jsonResponse({
      status: 'healthy',
      uptime: 42,
      node: { strands: { total: 5, active: 3, idle: 1, hibernating: 1 } },
    })) as typeof globalThis.fetch;

    const result = await service.getContainerStatus('ctr_1');

    // The declared type is now honest: counts are reachable under node.strands.
    expect(result?.health?.status).toBe('healthy');
    expect(result?.health?.node?.strands?.active).toBe(3);
    expect(result?.health?.node?.strands?.total).toBe(5);
  });

  it('hits the derived /status URL (not /health)', async () => {
    const { service } = await makeService(runningContainer());
    const fetchMock = vi.fn(async () => jsonResponse({
      status: 'healthy', uptime: 1, node: { strands: { total: 0, active: 0, idle: 0, hibernating: 0 } },
    }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await service.getContainerStatus('ctr_1');

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8080/status');
  });

  it('leaves health undefined when the container is not running', async () => {
    const { service } = await makeService(runningContainer({ status: 'enrolling' }));
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await service.getContainerStatus('ctr_1');

    expect(result?.container.id).toBe('ctr_1');
    expect(result?.health).toBeUndefined();
    // No live fetch attempted for a non-running container.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves health undefined when the /status fetch fails', async () => {
    const { service } = await makeService(runningContainer());
    globalThis.fetch = vi.fn(async () => { throw new Error('connection refused'); }) as typeof globalThis.fetch;

    const result = await service.getContainerStatus('ctr_1');

    expect(result?.health).toBeUndefined();
  });

  it('leaves health undefined when /status responds non-OK', async () => {
    const { service } = await makeService(runningContainer());
    globalThis.fetch = vi.fn(async () => jsonResponse({
      status: 'unhealthy', uptime: 0, node: { strands: { total: 0, active: 0, idle: 0, hibernating: 0 } },
    }, false)) as typeof globalThis.fetch;

    const result = await service.getContainerStatus('ctr_1');

    expect(result?.health).toBeUndefined();
  });

  it('returns undefined for an unknown container id', async () => {
    const { service } = await makeService(runningContainer());
    globalThis.fetch = vi.fn() as typeof globalThis.fetch;

    const result = await service.getContainerStatus('ctr_missing');

    expect(result).toBeUndefined();
  });
});
