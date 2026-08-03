/**
 * Grantee-facing `/grants` route tests — the bearer-gated provisioning surface.
 *
 * Uses a fake orchestrator (no real children) so the focus is the HTTP contract:
 * bearer auth, request validation, per-grant ownership isolation, the quota gate,
 * and seedToken redaction. The live-node round-trips (peer/seed) are covered by
 * the cross-package integration scenario.
 */

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Orchestrator,
  OrchestratorCreateRequest,
  OrchestratorCreateResult,
  OrchestratorStats,
} from '@serfab/cadre-provider';

import { registerErrorHandler } from '../error-handler.js';
import { registerGrantsRoutes } from '../routes/grants.js';
import { DonationService } from '../../donation/donation-service.js';
import { DonationStore } from '../../donation/donation-store.js';
import { GrantService } from '../../donation/grant-service.js';
import { GrantStore } from '../../donation/grant-store.js';

class FakeOrchestrator implements Orchestrator {
  stopped: string[] = [];
  removed: string[] = [];
  private counter = 0;
  async createContainer(_request: OrchestratorCreateRequest): Promise<OrchestratorCreateResult> {
    const n = ++this.counter;
    return {
      dockerId: `dock_${n}`,
      healthEndpoint: `http://127.0.0.1:${9000 + n}/health`,
      metricsEndpoint: `http://127.0.0.1:${9000 + n}/metrics`,
      seedEndpoint: `http://127.0.0.1:${9000 + n}/seed`,
      seedToken: `seed-token-${n}`,
      p2pPort: 4000 + n,
    };
  }
  async stopContainer(id: string): Promise<void> { this.stopped.push(id); }
  async removeContainer(id: string): Promise<void> { this.removed.push(id); }
  async getStats(): Promise<OrchestratorStats> {
    return { cpuPercent: 0, memoryBytes: 0, networkRxBytes: 0, networkTxBytes: 0 };
  }
  async isRunning(): Promise<boolean> { return true; }
  async getLogs(): Promise<string> { return ''; }
}

let tmpRoot: string;
let app: ReturnType<typeof Fastify>;
let grants: GrantService;
let store: DonationStore;
let token: string;
const originalFetch = globalThis.fetch;

/**
 * A well-formed 32-byte base64url owner key. `DonationService.provision`
 * shape-checks the pins, so a placeholder string is a 400 rather than a fixture.
 */
const OWNER_KEY = Buffer.alloc(32, 7).toString('base64url');

const body = {
  partyId: 'party-P',
  bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooReq'],
  ownerKeys: [OWNER_KEY],
};

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-grants-svc-route-'));
  grants = new GrantService({ store: new GrantStore(join(tmpRoot, 'grants')) });
  token = grants.issue({ label: 'Alice', maxNodes: 2 }).token;
  store = new DonationStore(join(tmpRoot, 'donations'));
  const donations = new DonationService({ orchestrator: new FakeOrchestrator(), grants, store });
  app = Fastify();
  registerErrorHandler(app);
  registerGrantsRoutes(app, { donations, grants });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await app.close();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('POST /grants', () => {
  it('provisions a donated node → 201, awaiting_seed, seedToken redacted', async () => {
    const res = await app.inject({ method: 'POST', url: '/grants', headers: bearer(token), payload: body });
    expect(res.statusCode).toBe(201);
    const donation = (res.json() as { data: { donation: Record<string, unknown> } }).data.donation;
    expect(donation.status).toBe('awaiting_seed');
    expect(donation.partyId).toBe('party-P');
    expect(donation.seedToken).toBeUndefined();
    expect(donation.seedEndpoint).toBeUndefined();
  });

  it('rejects a missing bearer → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/grants', payload: body });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('unauthorized');
  });

  it('rejects an unknown bearer → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/grants', headers: bearer('nope'), payload: body });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing partyId → 400 invalid_request', async () => {
    const res = await app.inject({
      method: 'POST', url: '/grants', headers: bearer(token),
      payload: { bootstrapNodes: body.bootstrapNodes, ownerKeys: body.ownerKeys },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('rejects empty ownerKeys → 400 invalid_request', async () => {
    const res = await app.inject({
      method: 'POST', url: '/grants', headers: bearer(token),
      payload: { ...body, ownerKeys: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  // A typo'd pin used to be answered 201 and only fail when the spawned child
  // tried to decode it at boot — by which point the caller had no way to act on it.
  it('rejects a malformed ownerKeys entry → 400 invalid_request, naming the bad key', async () => {
    const res = await app.inject({
      method: 'POST', url: '/grants', headers: bearer(token),
      payload: { ...body, ownerKeys: [OWNER_KEY, 'this-is-not-a-key'] },
    });
    expect(res.statusCode).toBe(400);
    const error = (res.json() as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('this-is-not-a-key');
  });

  it('enforces the grant quota → 429 quota_exceeded once maxNodes is reached', async () => {
    const g = grants.issue({ label: 'Bob', maxNodes: 1 }).token;
    const first = await app.inject({ method: 'POST', url: '/grants', headers: bearer(g), payload: body });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/grants', headers: bearer(g), payload: body });
    expect(second.statusCode).toBe(429);
    expect((second.json() as { error: { code: string } }).error.code).toBe('quota_exceeded');
  });
});

describe('GET /grants auth', () => {
  it('rejects an unknown bearer → 401 unauthorized (code matches the status)', async () => {
    const res = await app.inject({ method: 'GET', url: '/grants', headers: bearer('nope') });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('unauthorized');
  });
});

describe('GET /grants (ownership isolation)', () => {
  it('lists only the donations the presented grant authorized', async () => {
    const other = grants.issue({ label: 'Carol' }).token;
    await app.inject({ method: 'POST', url: '/grants', headers: bearer(token), payload: body });
    await app.inject({ method: 'POST', url: '/grants', headers: bearer(other), payload: body });

    const mine = await app.inject({ method: 'GET', url: '/grants', headers: bearer(token) });
    const donations = (mine.json() as { data: { donations: Array<{ grantToken: string }> } }).data.donations;
    expect(donations).toHaveLength(1);
    expect(donations[0].grantToken).toBe(token);
  });

  it('a foreign grant cannot read another grant’s donation → 404', async () => {
    const other = grants.issue({ label: 'Carol' }).token;
    const created = await app.inject({ method: 'POST', url: '/grants', headers: bearer(token), payload: body });
    const id = (created.json() as { data: { donation: { id: string } } }).data.donation.id;

    const mine = await app.inject({ method: 'GET', url: `/grants/${id}`, headers: bearer(token) });
    expect(mine.statusCode).toBe(200);

    const foreign = await app.inject({ method: 'GET', url: `/grants/${id}`, headers: bearer(other) });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('PUT /grants/:id/seed validation', () => {
  it('rejects a missing seed body → 400 invalid_request', async () => {
    const created = await app.inject({ method: 'POST', url: '/grants', headers: bearer(token), payload: body });
    const id = (created.json() as { data: { donation: { id: string } } }).data.donation.id;
    const res = await app.inject({ method: 'PUT', url: `/grants/${id}/seed`, headers: bearer(token), payload: {} });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('answers 409 invalid_state when the loan ends while the seed is in flight', async () => {
    const created = await app.inject({ method: 'POST', url: '/grants', headers: bearer(token), payload: body });
    const id = (created.json() as { data: { donation: { id: string } } }).data.donation.id;

    // The borrower's DELETE lands inside the seed window: the node accepts the
    // seed, but by the time it answers the loan is over. The ending wins, so the
    // route must NOT report a 200 that implies a live, freshly seeded node.
    globalThis.fetch = (async () => {
      await app.inject({ method: 'DELETE', url: `/grants/${id}`, headers: bearer(token) });
      return { ok: true, json: async () => ({ success: true, peersAdded: 2 }) } as unknown as Response;
    }) as typeof globalThis.fetch;

    const res = await app.inject({
      method: 'PUT', url: `/grants/${id}/seed`, headers: bearer(token), payload: { seed: 'encoded-seed' },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_state');
    const after = await app.inject({ method: 'GET', url: `/grants/${id}`, headers: bearer(token) });
    expect((after.json() as { data: { donation: { status: string } } }).data.donation.status)
      .toBe('terminated');
  });

  it('answers 404 not_found when the record vanishes while the seed is in flight', async () => {
    const created = await app.inject({ method: 'POST', url: '/grants', headers: bearer(token), payload: body });
    const id = (created.json() as { data: { donation: { id: string } } }).data.donation.id;

    // The row is gone by the time the node answers — the other half of the
    // abandon mapping, which has no status to report.
    globalThis.fetch = (async () => {
      store.remove(id);
      return { ok: true, json: async () => ({ success: true, peersAdded: 2 }) } as unknown as Response;
    }) as typeof globalThis.fetch;

    const res = await app.inject({
      method: 'PUT', url: `/grants/${id}/seed`, headers: bearer(token), payload: { seed: 'encoded-seed' },
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('not_found');
  });
});

describe('DELETE /grants/:id', () => {
  it('terminates a donation and drops it from the live tally', async () => {
    const created = await app.inject({ method: 'POST', url: '/grants', headers: bearer(token), payload: body });
    const id = (created.json() as { data: { donation: { id: string } } }).data.donation.id;

    const del = await app.inject({ method: 'DELETE', url: `/grants/${id}`, headers: bearer(token) });
    expect(del.statusCode).toBe(200);

    const one = await app.inject({ method: 'GET', url: `/grants/${id}`, headers: bearer(token) });
    expect((one.json() as { data: { donation: { status: string } } }).data.donation.status).toBe('terminated');
  });
});
