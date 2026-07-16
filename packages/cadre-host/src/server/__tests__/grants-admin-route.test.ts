import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerErrorHandler } from '../error-handler.js';
import { registerGrantsAdminRoutes } from '../routes/grants-admin.js';
import { GrantService, GrantStore, createGrantAdminHandlers } from '../../donation/index.js';
import type { Grant } from '../../donation/index.js';

let tmpRoot: string;
let app: ReturnType<typeof Fastify>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-grants-route-'));
  const service = new GrantService({ store: new GrantStore(tmpRoot) });
  app = Fastify();
  registerErrorHandler(app);
  registerGrantsAdminRoutes(app, { handlers: createGrantAdminHandlers(service) });
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
