import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerErrorHandler } from '../error-handler.js';
import { EventBus } from '../events/bus.js';
import { registerGrantsAdminRoutes } from '../routes/grants-admin.js';
import {
  DonationService,
  DonationStore,
  GrantService,
  GrantStore,
  createGrantAdminHandlers,
} from '../../donation/index.js';
import type { DonationView, Grant, GrantListing } from '../../donation/index.js';
import { FakeOrchestrator } from '../../donation/__tests__/fake-orchestrator.js';

/** A well-formed 32-byte base64url owner key, which `provision` requires. */
const OWNER_KEY = Buffer.alloc(32, 7).toString('base64url');

let tmpRoot: string;
let app: ReturnType<typeof Fastify>;
let grants: GrantService;
let donations: DonationService;
let donationStore: DonationStore;
let orch: FakeOrchestrator;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-grants-route-'));
  grants = new GrantService({ store: new GrantStore(tmpRoot) });
  orch = new FakeOrchestrator();
  donationStore = new DonationStore(tmpRoot);
  donations = new DonationService({ orchestrator: orch, grants, store: donationStore });
  app = Fastify();
  registerErrorHandler(app);
  registerGrantsAdminRoutes(app, { handlers: createGrantAdminHandlers(grants, donations), events: new EventBus() });
});

afterEach(async () => {
  await app.close();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('/grants-admin routes', () => {
  it('POST issues a grant, GET lists it, DELETE revokes it', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/grants-admin',
      payload: { label: "Alice's cadre", maxNodes: 2 },
    });
    expect(post.statusCode).toBe(200);
    const created = (post.json() as { grant: Grant }).grant;
    expect(created.token).toBeTruthy();
    expect(created.maxNodes).toBe(2);

    const list = await app.inject({ method: 'GET', url: '/grants-admin' });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { grants: Grant[] }).grants.map(g => g.token)).toContain(created.token);

    const del = await app.inject({
      method: 'DELETE',
      url: `/grants-admin/${encodeURIComponent(created.token)}`,
    });
    expect(del.statusCode).toBe(200);

    // Revoked → still listed, now carries revokedAt.
    const after = await app.inject({ method: 'GET', url: '/grants-admin' });
    const row = (after.json() as { grants: Grant[] }).grants.find(g => g.token === created.token);
    expect(row?.revokedAt).toBeTruthy();
  });

  it('POST with an empty label → 400 invalid_label', async () => {
    const res = await app.inject({ method: 'POST', url: '/grants-admin', payload: { label: '  ' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_label');
  });

  it('POST with a bad maxNodes → 400 invalid_max_nodes', async () => {
    const res = await app.inject({ method: 'POST', url: '/grants-admin', payload: { label: 'X', maxNodes: 0 } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_max_nodes');
  });

  it('DELETE of an unknown token → 404 not_found', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/grants-admin/nope' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('not_found');
  });
});

function provisionUnder(token: string): Promise<DonationView> {
  return donations.provision({ grantToken: token, partyId: 'party-P', bootstrapNodes: [], ownerKeys: [OWNER_KEY] });
}

describe('/grants-admin listing', () => {
  it("GET reports each grant's live nodes and the donations a revoke would end", async () => {
    const a = grants.issue({ label: 'A', maxNodes: 3 });
    const b = grants.issue({ label: 'B' });
    const seeded = await provisionUnder(a.token);
    const failed = await provisionUnder(a.token);
    const ended = await provisionUnder(a.token);
    const other = await provisionUnder(b.token);
    donationStore.put({ ...donationStore.get(seeded.id)!, status: 'seeded' });
    donationStore.put({ ...donationStore.get(failed.id)!, status: 'error', error: 'respawn gave up' });
    await donations.terminate(ended.id);

    const res = await app.inject({ method: 'GET', url: '/grants-admin' });

    const listed = (res.json() as { grants: GrantListing[] }).grants;
    const rowA = listed.find(g => g.token === a.token);
    const rowB = listed.find(g => g.token === b.token);
    // `error` is not live, but a revoke still tears it down; `terminated` is neither.
    expect(rowA?.liveNodes).toBe(1);
    expect(rowA?.donations).toEqual(expect.arrayContaining([
      { id: seeded.id, status: 'seeded' },
      { id: failed.id, status: 'error' },
    ]));
    expect(rowA?.donations).toHaveLength(2);
    expect(rowB?.liveNodes).toBe(1);
    expect(rowB?.donations).toEqual([{ id: other.id, status: 'awaiting_seed' }]);
  });
});

describe('/grants-admin donated-node teardown', () => {
  it('DELETE /grants-admin/:token terminates the nodes donated under the grant', async () => {
    const { token } = grants.issue({ label: 'Alice' });
    const donation = await provisionUnder(token);

    const res = await app.inject({ method: 'DELETE', url: `/grants-admin/${encodeURIComponent(token)}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, terminated: [donation.id] });
    expect(donations.get(donation.id)?.status).toBe('terminated');
    expect(orch.removed).toEqual(['dock_1']);
  });

  it('?keepNodes=true revokes the grant but leaves its nodes running', async () => {
    const { token } = grants.issue({ label: 'Alice' });
    const donation = await provisionUnder(token);

    const res = await app.inject({
      method: 'DELETE',
      url: `/grants-admin/${encodeURIComponent(token)}?keepNodes=true`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, terminated: [] });
    expect(grants.validate(token).reason).toBe('revoked');
    expect(donations.get(donation.id)?.status).toBe('awaiting_seed');
    expect(orch.stopped).toEqual([]);
  });

  it('DELETE /grants-admin/donations/:id ends one node under a revoked grant; an unknown id 404s', async () => {
    const { token } = grants.issue({ label: 'Alice', maxNodes: 2 });
    const kept = await provisionUnder(token);
    const ended = await provisionUnder(token);
    grants.revoke(token);

    const res = await app.inject({ method: 'DELETE', url: `/grants-admin/donations/${ended.id}` });

    expect(res.statusCode).toBe(200);
    expect(donations.get(ended.id)?.status).toBe('terminated');
    expect(donations.get(kept.id)?.status).toBe('awaiting_seed');

    const unknown = await app.inject({ method: 'DELETE', url: '/grants-admin/donations/grn_nope' });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe('not_found');
  });
});
