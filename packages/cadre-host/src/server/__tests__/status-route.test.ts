import Fastify from 'fastify';
import { describe, it, expect, afterEach } from 'vitest';

import { registerErrorHandler } from '../error-handler.js';
import { registerStatusRoute } from '../routes/status.js';
import type { HostProcessOrchestrator } from '../../orchestrator/index.js';
import type { ManagedNodeInfo } from '../../orchestrator/types.js';
import type { NatService } from '../../nat/index.js';
import type { NatStatusSnapshot } from '../../nat/types.js';
import type { UpdateService } from '../../update/index.js';
import type { UpdateState } from '../../update/types.js';
import { SAMPLE_CONNECTIVITY } from './fakes.js';

function fakeOrchestrator(nodes: ManagedNodeInfo[]): HostProcessOrchestrator {
  return { listNodes: () => nodes } as unknown as HostProcessOrchestrator;
}
function fakeNat(snap: NatStatusSnapshot): NatService {
  return { getStatus: () => snap } as unknown as NatService;
}
function fakeUpdate(state: UpdateState): UpdateService {
  return { getState: async () => state } as unknown as UpdateService;
}

describe('GET /api/status', () => {
  let app: ReturnType<typeof Fastify>;

  afterEach(async () => { await app.close(); });

  it('returns aggregated status without update service', async () => {
    app = Fastify();
    registerErrorHandler(app);
    registerStatusRoute(app, {
      role: 'founder',
      orchestrator: fakeOrchestrator([
        {
          id: 'alice',
          dockerId: '1234:abc',
          partyId: 'party-alice',
          profile: 'storage',
          status: 'running',
          spawnedAt: '2025-01-01T00:00:00Z',
          workdir: '/tmp/alice',
          ports: { health: 1, metrics: 2, p2p: 3, admin: 4, ws: 5 },
          announcedAddrs: [],
        },
      ]),
      nat: fakeNat(SAMPLE_CONNECTIVITY),
    });

    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      service: { name: string; version: string; uptimeSeconds: number };
      role: string;
      nodes: Array<{ id: string; status: string }>;
      connectivity: { directReachability: string };
      update?: { available?: string };
    };
    expect(body.service.name).toBe('cadre-host');
    expect(body.role).toBe('founder');
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0]).toMatchObject({ id: 'alice', status: 'running' });
    expect(body.connectivity.directReachability).toBe('reachable');
    expect(body.update).toBeUndefined();
  });

  it('includes connectivity in the donor role too (every role maps its nodes)', async () => {
    app = Fastify();
    registerErrorHandler(app);
    registerStatusRoute(app, {
      role: 'donor',
      orchestrator: fakeOrchestrator([]),
      nat: fakeNat(SAMPLE_CONNECTIVITY),
    });

    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      service: { name: string };
      role: string;
      nodes: unknown[];
      connectivity: { directReachability: string };
    };
    expect(body.service.name).toBe('cadre-host');
    expect(body.role).toBe('donor');
    expect(body.nodes).toEqual([]);
    expect(body.connectivity.directReachability).toBe('reachable');
  });

  it('includes update info when service is present', async () => {
    app = Fastify();
    registerErrorHandler(app);
    registerStatusRoute(app, {
      role: 'founder',
      orchestrator: fakeOrchestrator([]),
      nat: fakeNat(SAMPLE_CONNECTIVITY),
      update: fakeUpdate({
        version: 1,
        lastChecked: '2025-06-01T00:00:00Z',
        available: { version: '0.7.0', publishedAt: '2025-06-01T00:00:00Z' },
      }),
    });

    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { update?: { available?: string; lastChecked?: string } };
    expect(body.update).toEqual({ available: '0.7.0', lastChecked: '2025-06-01T00:00:00Z' });
  });
});
