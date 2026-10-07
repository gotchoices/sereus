/**
 * `/api/hosted-nodes` route tests: the status code each outcome maps to, driven
 * against a stub service so no child spawns. The service's own behaviour is
 * `hosted/__tests__/hosted-node-service.test.ts`.
 */

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HostedNodeService } from '../../hosted/hosted-node-service.js';
import { HostedNodeError, type HostedNodeView } from '../../hosted/types.js';
import { registerErrorHandler } from '../error-handler.js';
import { registerHostedNodesRoutes } from '../routes/hosted-nodes.js';

const UNCLAIMED: HostedNodeView = {
  id: 'hn_a', join: { kind: 'claim' }, partyId: 'unclaimed', profile: 'storage', status: 'unclaimed',
  dockerId: '1:a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
const JOINED: HostedNodeView = { ...UNCLAIMED, id: 'hn_b', status: 'joined', partyId: 'party-P', ownerKey: 'owner' };

/** A service with two nodes, answering as the real one would for each. */
function stubService(): HostedNodeService & { removed: string[] } {
  const nodes = new Map([[UNCLAIMED.id, UNCLAIMED], [JOINED.id, JOINED]]);
  const removed: string[] = [];
  const require = (id: string): HostedNodeView => {
    const node = nodes.get(id);
    if (!node) throw new HostedNodeError('not_found', `No such hosted node: ${id}`);
    return node;
  };
  return {
    removed,
    list: () => [...nodes.values()],
    get: (id: string) => nodes.get(id),
    join: async () => ({ ...UNCLAIMED, id: 'hn_new' }),
    claimDetails: async (id: string) => {
      const node = require(id);
      if (node.status !== 'unclaimed') throw new HostedNodeError('invalid_state', `Hosted node ${id} is ${node.status}`);
      if (id === 'hn_starting') throw new HostedNodeError('node_unavailable', 'not yet');
      return { payload: 'sereus-join:1.x', peerId: '12D3KooW', multiaddrs: ['/ip4/192.168.1.20/tcp/1/ws/p2p/12D3KooW'], reachability: null };
    },
    remove: async (id: string) => { require(id); removed.push(id); },
    reset: async (id: string) => { require(id); return { ...UNCLAIMED, id: 'hn_reset' }; },
  } as unknown as HostedNodeService & { removed: string[] };
}

describe('/api/hosted-nodes routes', () => {
  let app: ReturnType<typeof Fastify>;
  let service: ReturnType<typeof stubService>;

  beforeEach(() => {
    app = Fastify();
    registerErrorHandler(app);
    service = stubService();
    registerHostedNodesRoutes(app, { hostedNodes: service });
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers each outcome with its status code', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/hosted-nodes' })).json()).toEqual({ ok: true, data: { nodes: [UNCLAIMED, JOINED] } });

    const created = await app.inject({ method: 'POST', url: '/api/hosted-nodes' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ ok: true, data: { node: { id: 'hn_new', status: 'unclaimed' } } });

    expect((await app.inject({ method: 'GET', url: '/api/hosted-nodes/hn_a' })).json()).toEqual({ ok: true, data: { node: UNCLAIMED } });
    const missing = await app.inject({ method: 'GET', url: '/api/hosted-nodes/hn_nobody' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ ok: false, error: { code: 'not_found' } });

    const claim = await app.inject({ method: 'GET', url: '/api/hosted-nodes/hn_a/claim' });
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({ ok: true, data: { payload: 'sereus-join:1.x', peerId: '12D3KooW' } });

    const removed = await app.inject({ method: 'DELETE', url: '/api/hosted-nodes/hn_b' });
    expect(removed.statusCode).toBe(204);
    expect(service.removed).toEqual(['hn_b']);
    expect((await app.inject({ method: 'DELETE', url: '/api/hosted-nodes/hn_nobody' })).statusCode).toBe(404);

    const reset = await app.inject({ method: 'POST', url: '/api/hosted-nodes/hn_a/reset' });
    expect(reset.statusCode).toBe(201);
    expect(reset.json()).toMatchObject({ ok: true, data: { node: { id: 'hn_reset' } } });
  });

  it('answers 409 for the claim details of a joined node', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/hosted-nodes/hn_b/claim' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'invalid_state' } });
  });
});
