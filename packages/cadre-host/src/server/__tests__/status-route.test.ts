import Fastify from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { registerErrorHandler } from '../error-handler.js';
import { registerStatusRoute } from '../routes/status.js';
import type { HostProcessOrchestrator } from '../../orchestrator/index.js';
import type { ManagedNodeInfo } from '../../orchestrator/types.js';
import type { TrustCircleService } from '../../auth/index.js';
import type { TrustCircleSnapshot } from '../../auth/types.js';
import type { NatService } from '../../nat/index.js';
import type { NatStatusSnapshot } from '../../nat/types.js';
import type { UpdateService } from '../../update/index.js';
import type { UpdateState } from '../../update/types.js';

function fakeOrchestrator(nodes: ManagedNodeInfo[]): HostProcessOrchestrator {
  return { listNodes: () => nodes } as unknown as HostProcessOrchestrator;
}
function fakeTrustCircle(snap: TrustCircleSnapshot): TrustCircleService {
  return { list: async () => snap } as unknown as TrustCircleService;
}
function fakeNat(snap: NatStatusSnapshot): NatService {
  return { getStatus: () => snap } as unknown as NatService;
}
function fakeUpdate(state: UpdateState): UpdateService {
  return { getState: async () => state } as unknown as UpdateService;
}

const SAMPLE_CONNECTIVITY: NatStatusSnapshot = {
  portMode: 'auto-upnp',
  externalPort: 4001,
  internalPort: 4001,
  routerExternalIp: '203.0.113.5',
  mappingLeaseExpiresAt: null,
  externalIp: '203.0.113.5',
  externalIpDetectedAt: null,
  cgnatDetected: false,
  directReachability: 'reachable',
  lastTestedAt: null,
  ddns: {
    providerId: null,
    hostname: null,
    externallyManaged: false,
    lastUpdateAt: null,
    lastUpdateOk: null,
    lastError: null,
  },
};

describe('GET /api/status', () => {
  let app: ReturnType<typeof Fastify>;

  afterEach(async () => { await app.close(); });

  it('returns aggregated status without update service', async () => {
    app = Fastify();
    registerErrorHandler(app);
    registerStatusRoute(app, {
      orchestrator: fakeOrchestrator([
        {
          id: 'alice',
          dockerId: '1234:abc',
          partyId: 'party-alice',
          profile: 'storage',
          status: 'running',
          spawnedAt: '2025-01-01T00:00:00Z',
          workdir: '/tmp/alice',
          ports: { health: 1, metrics: 2, p2p: 3 },
        },
      ]),
      trustCircle: fakeTrustCircle({
        members: [{ peerId: 'p1', label: 'Self', addedAt: '2025-01-01T00:00:00Z', self: true }],
        pending: [],
      }),
      nat: fakeNat(SAMPLE_CONNECTIVITY),
    });

    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      service: { name: string; version: string; uptimeSeconds: number };
      nodes: Array<{ id: string; status: string }>;
      trustCircle: { members: number; pending: number };
      connectivity: { portMode: string };
      update?: { available?: string };
    };
    expect(body.service.name).toBe('cadre-host');
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0]).toMatchObject({ id: 'alice', status: 'running' });
    expect(body.trustCircle).toEqual({ members: 1, pending: 0 });
    expect(body.connectivity.portMode).toBe('auto-upnp');
    expect(body.update).toBeUndefined();
  });

  it('includes update info when service is present', async () => {
    app = Fastify();
    registerErrorHandler(app);
    registerStatusRoute(app, {
      orchestrator: fakeOrchestrator([]),
      trustCircle: fakeTrustCircle({ members: [], pending: [] }),
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
