/**
 * Seed-trust anchors flowing from a tenant's create request into that tenant's
 * container and nowhere else.
 *
 * A provider-hosted node starts with an empty node-local trusted-owner store, so
 * the pinned keys handed to the orchestrator are the only reason the first seed
 * the provider delivers is honoured. The isolation property mirrors push
 * credentials: one tenant in, one tenant out — but with no provider-level
 * default tier at all, since a shared pin would let one tenant's owner seed
 * another tenant's node.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContainerService } from '../container-service.js';
import { MemoryStore } from '../store.js';
import type { Orchestrator, OrchestratorCreateRequest, OrchestratorCreateResult } from '../orchestrator.js';
import type { Container, CreateContainerRequest } from '../../types.js';

type ProvisionInternal = {
  provisionContainer(container: Container, request: CreateContainerRequest): Promise<void>;
};

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

function request(customerId: string, pinnedOwnerKeys?: string[]): CreateContainerRequest {
  return {
    customerId,
    partyId: `party-${customerId}`,
    bootstrapNodes: [],
    profile: 'storage',
    ...(pinnedOwnerKeys ? { pinnedOwnerKeys } : {}),
  };
}

/** Let the fire-and-forget provisioning kicked off by createContainer settle. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 10));
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  // Health poll succeeds on the first iteration so provisionContainer resolves
  // immediately rather than polling for 60s.
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ status: 'healthy' }),
  })) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('ContainerService pinned owner keys', () => {
  it('records the keys on the container it creates', async () => {
    const store = new MemoryStore();
    const { orchestrator } = capturingOrchestrator();
    const service = new ContainerService({ store, orchestrator });

    const created = await service.createContainer(request('cust-a', ['owner-a']));

    expect(created.pinnedOwnerKeys).toEqual(['owner-a']);
    expect((await store.getContainer(created.id))?.pinnedOwnerKeys).toEqual(['owner-a']);
  });

  it('copies the caller array so a later mutation cannot rewrite the record', async () => {
    const store = new MemoryStore();
    const { orchestrator } = capturingOrchestrator();
    const service = new ContainerService({ store, orchestrator });

    const keys = ['owner-a'];
    const created = await service.createContainer(request('cust-a', keys));
    keys.push('owner-sneaky');

    expect((await store.getContainer(created.id))?.pinnedOwnerKeys).toEqual(['owner-a']);
  });

  it('forwards exactly the keys it was given to the orchestrator', async () => {
    const store = new MemoryStore();
    const { orchestrator, create } = capturingOrchestrator();
    const service = new ContainerService({ store, orchestrator });

    const req = request('cust-a', ['owner-a', 'owner-a2']);
    const c: Container = {
      id: 'ctr_a', customerId: 'cust-a', partyId: req.partyId, profile: 'storage',
      status: 'pending', resources: {}, tags: {},
      createdAt: new Date('2026-06-01T00:00:00.000Z'), updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    await store.saveContainer(c);
    await (service as unknown as ProvisionInternal).provisionContainer(c, req);

    expect(create.mock.calls[0]![0].pinnedOwnerKeys).toEqual(['owner-a', 'owner-a2']);
  });

  it('omits pinnedOwnerKeys entirely when the request carries none (no provider default)', async () => {
    const store = new MemoryStore();
    const { orchestrator, create } = capturingOrchestrator();
    const service = new ContainerService({ store, orchestrator });

    const req = request('cust-a');
    const c: Container = {
      id: 'ctr_b', customerId: 'cust-a', partyId: req.partyId, profile: 'storage',
      status: 'pending', resources: {}, tags: {},
      createdAt: new Date('2026-06-01T00:00:00.000Z'), updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    await store.saveContainer(c);
    await (service as unknown as ProvisionInternal).provisionContainer(c, req);

    expect(create.mock.calls[0]![0].pinnedOwnerKeys).toBeUndefined();
  });

  it('never carries one tenant keys into another tenant container', async () => {
    const store = new MemoryStore();
    const { orchestrator, create } = capturingOrchestrator();
    const service = new ContainerService({ store, orchestrator });

    const a = await service.createContainer(request('cust-a', ['owner-a']));
    const b = await service.createContainer(request('cust-b', ['owner-b']));
    await flush();

    // Both provisions run through the same service instance; each orchestrator
    // request must reflect only its own tenant's keys.
    const byContainer = new Map(
      create.mock.calls.map(call => [call[0].containerId as string, call[0].pinnedOwnerKeys as string[] | undefined]),
    );
    expect(byContainer.get(a.id)).toEqual(['owner-a']);
    expect(byContainer.get(b.id)).toEqual(['owner-b']);
  });
});
