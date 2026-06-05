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

describe('ContainerService.getPeerInfo', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns peerId/multiaddrs from the live /status payload', async () => {
    const { service } = await makeService(runningContainer());
    globalThis.fetch = vi.fn(async () => jsonResponse({
      status: 'healthy', uptime: 1,
      peerId: '12D3KooWPeer', multiaddrs: ['/ip4/10.0.0.1/tcp/4001'],
      node: { strands: { total: 0, active: 0, idle: 0, hibernating: 0 } },
    })) as typeof globalThis.fetch;

    const result = await service.getPeerInfo('ctr_1');

    expect(result).toEqual({ peerId: '12D3KooWPeer', multiaddrs: ['/ip4/10.0.0.1/tcp/4001'] });
  });

  it('hits the derived /status URL (not /health)', async () => {
    const { service } = await makeService(runningContainer());
    const fetchMock = vi.fn(async () => jsonResponse({
      status: 'healthy', uptime: 1,
      peerId: '12D3KooWPeer', multiaddrs: ['/ip4/10.0.0.1/tcp/4001'],
    }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await service.getPeerInfo('ctr_1');

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8080/status');
  });

  it('re-fetches live every call, reflecting peer info that changed after a restart', async () => {
    const { service } = await makeService(runningContainer());
    // Simulate a restart re-keying identity / remapping multiaddrs between calls.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        status: 'healthy', uptime: 1,
        peerId: '12D3KooWOld', multiaddrs: ['/ip4/10.0.0.1/tcp/4001'],
      }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'healthy', uptime: 1,
        peerId: '12D3KooWNew', multiaddrs: ['/ip4/10.0.0.2/tcp/5002'],
      }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const first = await service.getPeerInfo('ctr_1');
    const second = await service.getPeerInfo('ctr_1');

    expect(first).toEqual({ peerId: '12D3KooWOld', multiaddrs: ['/ip4/10.0.0.1/tcp/4001'] });
    expect(second).toEqual({ peerId: '12D3KooWNew', multiaddrs: ['/ip4/10.0.0.2/tcp/5002'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns undefined when /status reports a null peerId (node still starting)', async () => {
    const { service } = await makeService(runningContainer());
    globalThis.fetch = vi.fn(async () => jsonResponse({
      status: 'starting', uptime: 0, peerId: null, multiaddrs: [],
    })) as typeof globalThis.fetch;

    const result = await service.getPeerInfo('ctr_1');

    expect(result).toBeUndefined();
  });

  it('returns undefined when /status has a peerId but no multiaddrs', async () => {
    const { service } = await makeService(runningContainer());
    globalThis.fetch = vi.fn(async () => jsonResponse({
      status: 'healthy', uptime: 1, peerId: '12D3KooWPeer', multiaddrs: [],
    })) as typeof globalThis.fetch;

    const result = await service.getPeerInfo('ctr_1');

    expect(result).toBeUndefined();
  });

  it('returns undefined when the /status response is not OK', async () => {
    const { service } = await makeService(runningContainer());
    globalThis.fetch = vi.fn(async () => jsonResponse({
      status: 'unhealthy', uptime: 1, peerId: '12D3KooWPeer', multiaddrs: ['/ip4/10.0.0.1/tcp/4001'],
    }, false)) as typeof globalThis.fetch;

    const result = await service.getPeerInfo('ctr_1');

    expect(result).toBeUndefined();
  });

  it('returns undefined when /status omits peer fields entirely', async () => {
    const { service } = await makeService(runningContainer());
    globalThis.fetch = vi.fn(async () => jsonResponse({
      status: 'healthy', uptime: 1,
      node: { strands: { total: 0, active: 0, idle: 0, hibernating: 0 } },
    })) as typeof globalThis.fetch;

    const result = await service.getPeerInfo('ctr_1');

    expect(result).toBeUndefined();
  });

  it('returns undefined when the /status fetch fails', async () => {
    const { service } = await makeService(runningContainer());
    globalThis.fetch = vi.fn(async () => { throw new Error('connection refused'); }) as typeof globalThis.fetch;

    const result = await service.getPeerInfo('ctr_1');

    expect(result).toBeUndefined();
  });

  it('returns undefined for an unknown container id', async () => {
    const { service } = await makeService(runningContainer());
    globalThis.fetch = vi.fn() as typeof globalThis.fetch;

    const result = await service.getPeerInfo('ctr_missing');

    expect(result).toBeUndefined();
  });
});
