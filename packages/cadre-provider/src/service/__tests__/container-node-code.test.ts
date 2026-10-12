/**
 * `ContainerService.nodeCode`: the code a phone claims a container with, and each
 * reason there is none. The code is decoded here by hand against the shape cadre-core's
 * `decodeNodeClaimPayload` reads (`node-code.ts` says why the encoder is a copy).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ContainerService } from '../container-service.js';
import { MemoryStore } from '../store.js';
import { MockOrchestrator } from '../orchestrator.js';
import { NODE_CODE_PREFIX } from '../node-code.js';
import { UNCLAIMED_PARTY_ID, type Container } from '../../types.js';

const PEER = '12D3KooWA9hbnKrRnPRSPTRkzXqTHzGE8YpJ3JHZmQ5tGwLRTMmp';
const SECRET = Buffer.alloc(32, 7).toString('base64url');
const PUBLIC_HOST = 'cadre.example';

/** A fetch Response stand-in carrying a JSON body. */
function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

function claimContainer(overrides: Partial<Container> = {}): Container {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id: 'ctr_1',
    customerId: 'cust-1',
    partyId: UNCLAIMED_PARTY_ID,
    profile: 'storage',
    status: 'running',
    dockerId: 'docker-1',
    healthEndpoint: 'http://localhost:8080/health',
    resources: {},
    tags: {},
    createdAt: now,
    updatedAt: now,
    join: { kind: 'claim', secret: SECRET },
    ...overrides,
  };
}

async function makeService(container: Container): Promise<{ service: ContainerService; store: MemoryStore }> {
  const store = new MemoryStore();
  await store.saveContainer(container);
  const service = new ContainerService({ store, orchestrator: new MockOrchestrator(), publicHost: PUBLIC_HOST });
  return { service, store };
}

function stubStatus(payload: Record<string, unknown>): void {
  globalThis.fetch = vi.fn(async () => jsonResponse({ status: 'healthy', uptime: 1, ...payload })) as typeof globalThis.fetch;
}

/** The inverse of `encodeNodeCode`, written out so the test does not trust the encoder about itself. */
function decodeCode(code: string): { json: string; payload: Record<string, unknown> } {
  expect(code.startsWith(NODE_CODE_PREFIX)).toBe(true);
  const json = Buffer.from(code.slice(NODE_CODE_PREFIX.length), 'base64url').toString('utf8');
  return { json, payload: JSON.parse(json) as Record<string, unknown> };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('ContainerService.nodeCode', () => {
  it('is not-ready while the node reports no peer id, and while it announces no WebSocket address at the public host', async () => {
    const { service } = await makeService(claimContainer());

    stubStatus({ status: 'starting', peerId: null, multiaddrs: [], node: { claim: 'awaiting' } });
    expect(await service.nodeCode('ctr_1')).toEqual({ refusal: 'not-ready' });

    // In-container addresses only: the announced pair is not up yet.
    stubStatus({ peerId: PEER, multiaddrs: [`/ip4/172.17.0.2/tcp/4002/ws/p2p/${PEER}`], node: { claim: 'awaiting' } });
    expect(await service.nodeCode('ctr_1')).toEqual({ refusal: 'not-ready' });
  });

  it('encodes the record\'s secret with only the announced WebSocket address, each ending in /p2p/<peerId>, as canonical JSON', async () => {
    const { service } = await makeService(claimContainer());
    stubStatus({
      peerId: PEER,
      multiaddrs: [
        `/ip4/172.17.0.2/tcp/4001/p2p/${PEER}`,
        `/ip4/172.17.0.2/tcp/4002/ws/p2p/${PEER}`,
        `/dns4/${PUBLIC_HOST}/tcp/12003/p2p/${PEER}`,
        `/dns4/${PUBLIC_HOST}/tcp/12004/ws`,
      ],
      node: { claim: 'awaiting' },
    });

    const result = await service.nodeCode('ctr_1');
    if (!result || 'refusal' in result) throw new Error(`expected a code, got ${JSON.stringify(result)}`);

    const wsAddr = `/dns4/${PUBLIC_HOST}/tcp/12004/ws/p2p/${PEER}`;
    expect(result.peerId).toBe(PEER);
    expect(result.multiaddrs).toEqual([wsAddr]);
    const { json, payload } = decodeCode(result.code);
    expect(payload).toEqual({ multiaddrs: [wsAddr], peerId: PEER, secret: SECRET });
    // Sorted keys, no whitespace: what cadre-core's canonical JSON emits for the same payload.
    expect(json).toBe(`{"multiaddrs":["${wsAddr}"],"peerId":"${PEER}","secret":"${SECRET}"}`);
  });

  it('is already-claimed once a live read folds the claim, and the record carries the claimed party and owner', async () => {
    const { service, store } = await makeService(claimContainer());
    stubStatus({
      peerId: PEER,
      multiaddrs: [`/dns4/${PUBLIC_HOST}/tcp/12004/ws/p2p/${PEER}`],
      node: { claim: 'claimed', claimedBy: 'owner-key-b64', partyId: 'party-real' },
    });

    expect(await service.nodeCode('ctr_1')).toEqual({ refusal: 'already-claimed' });
    const stored = await store.getContainer('ctr_1');
    expect(stored).toMatchObject({
      partyId: 'party-real',
      ownerKey: 'owner-key-b64',
      joinState: { kind: 'claim', state: 'claimed', ownerKey: 'owner-key-b64', partyId: 'party-real' },
    });
  });

  it.each([
    ['not-claimable', claimContainer({ join: undefined, partyId: 'party-1', pinnedOwnerKeys: ['k'] })],
    ['not-claimable', claimContainer({ join: { kind: 'invitation', invitation: 'sereus-invite:1.x' } })],
    ['gone', claimContainer({ status: 'stopped' })],
    ['gone', claimContainer({ status: 'error', error: 'boom' })],
  ])('refuses %s without reading the node', async (refusal, container) => {
    const { service } = await makeService(container);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    expect(await service.nodeCode('ctr_1')).toEqual({ refusal });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
