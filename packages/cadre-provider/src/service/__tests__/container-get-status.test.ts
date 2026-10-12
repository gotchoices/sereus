import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContainerService } from '../container-service.js';
import { MemoryStore } from '../store.js';
import { MockOrchestrator } from '../orchestrator.js';
import { UNCLAIMED_PARTY_ID, type Container } from '../../types.js';

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

/** A `/status` body with the given `node` fields, healthy and with a peer id. */
function statusWith(node: Record<string, unknown>): Record<string, unknown> {
  return { status: 'healthy', uptime: 1, peerId: '12D3KooWPeer', multiaddrs: [], node };
}

describe('ContainerService.readStatus folds the join state into the record', () => {
  it('a claimed node patches partyId, ownerKey and joinState', async () => {
    const { service, store } = await makeService(runningContainer({
      partyId: UNCLAIMED_PARTY_ID,
      join: { kind: 'claim', secret: 'secret' },
      joinState: { kind: 'claim', state: 'awaiting' },
    }));
    globalThis.fetch = vi.fn(async () => jsonResponse(statusWith({
      claim: 'claimed', claimedBy: 'owner-b64', partyId: 'party-real',
    }))) as typeof globalThis.fetch;

    const result = await service.getContainerStatus('ctr_1');

    const expected = {
      partyId: 'party-real',
      ownerKey: 'owner-b64',
      joinState: { kind: 'claim', state: 'claimed', ownerKey: 'owner-b64', partyId: 'party-real' },
    };
    expect(await store.getContainer('ctr_1')).toMatchObject(expected);
    // The response carries the same record, already folded.
    expect(result?.container).toMatchObject(expected);
  });

  it('a claim reported before the node restarted into its party stays awaiting, with the record party unchanged', async () => {
    const { service, store } = await makeService(runningContainer({
      partyId: UNCLAIMED_PARTY_ID,
      join: { kind: 'claim', secret: 'secret' },
    }));
    // cadre-cli flips `claim` the moment it records the claim, then restarts in-process;
    // until that finishes `partyId` is still the placeholder.
    globalThis.fetch = vi.fn(async () => jsonResponse(statusWith({
      claim: 'claimed', claimedBy: 'owner-b64', partyId: UNCLAIMED_PARTY_ID,
    }))) as typeof globalThis.fetch;

    await service.getContainerStatus('ctr_1');

    const stored = await store.getContainer('ctr_1');
    expect(stored?.joinState).toEqual({ kind: 'claim', state: 'awaiting' });
    expect(stored?.partyId).toBe(UNCLAIMED_PARTY_ID);
    expect(stored?.ownerKey).toBeUndefined();
  });

  it('a failed invitation records the error and whether a retry may help', async () => {
    const { service, store } = await makeService(runningContainer({
      partyId: 'party-invited',
      join: { kind: 'invitation', invitation: 'sereus-invite:1.abc' },
      joinState: { kind: 'invitation', state: 'pending' },
    }));
    globalThis.fetch = vi.fn(async () => jsonResponse(statusWith({
      invitation: { state: 'failed', error: 'member refused the invitation (invite-spent)', retryable: false },
    }))) as typeof globalThis.fetch;

    await service.getContainerStatus('ctr_1');

    expect((await store.getContainer('ctr_1'))?.joinState).toEqual({
      kind: 'invitation',
      state: 'failed',
      error: 'member refused the invitation (invite-spent)',
      retryable: false,
    });
  });

  it('saves the record only when the folded state differs from the stored one', async () => {
    const { service, store } = await makeService(runningContainer({
      partyId: UNCLAIMED_PARTY_ID,
      join: { kind: 'claim', secret: 'secret' },
    }));
    globalThis.fetch = vi.fn(async () => jsonResponse(statusWith({ claim: 'awaiting' }))) as typeof globalThis.fetch;
    const save = vi.spyOn(store, 'saveContainer');

    await service.getContainerStatus('ctr_1');
    await service.getContainerStatus('ctr_1');

    expect(save).toHaveBeenCalledTimes(1);
    expect((await store.getContainer('ctr_1'))?.joinState).toEqual({ kind: 'claim', state: 'awaiting' });
  });

  it('writes nothing for a seed-path container, whatever /status says about claims', async () => {
    const { service, store } = await makeService(runningContainer());
    globalThis.fetch = vi.fn(async () => jsonResponse(statusWith({ claim: 'none' }))) as typeof globalThis.fetch;
    const save = vi.spyOn(store, 'saveContainer');

    await service.getContainerStatus('ctr_1');

    expect(save).not.toHaveBeenCalled();
    expect((await store.getContainer('ctr_1'))?.joinState).toBeUndefined();
  });
});
