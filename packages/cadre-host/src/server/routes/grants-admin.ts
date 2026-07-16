/**
 * Donation grant **admin** HTTP routes — thin adapters around
 * `GrantAdminHandlers` (`createGrantAdminHandlers(service)`).
 *
 * Mount path: `/grants-admin` — the admin surface the `cadre-host grant` CLI
 * targets. It is **loopback, no bearer**: same-machine admin, matching
 * cadre-host's local-UI "no login" posture (see docs/cadre-host.md §
 * Security posture). This is distinct from the grantee-facing `/grants`
 * provisioning surface that carries the bearer gate — that arrives in the
 * `2-donation-service` ticket.
 */

import type { FastifyInstance } from 'fastify';

import type { GrantAdminHandlers } from '../../donation/types.js';

export interface GrantsAdminRoutesOptions {
  handlers: GrantAdminHandlers;
}

export function registerGrantsAdminRoutes(app: FastifyInstance, opts: GrantsAdminRoutesOptions): void {
  const { handlers } = opts;

  app.get('/grants-admin', async () => {
    return handlers.listGrants();
  });

  app.post('/grants-admin', async (request) => {
    const body = (request.body ?? {}) as { label?: unknown; maxNodes?: unknown; ttlMs?: unknown };
    const label = typeof body.label === 'string' ? body.label : '';
    const args: { label: string; maxNodes?: number; ttlMs?: number } = { label };
    if (typeof body.maxNodes === 'number') args.maxNodes = body.maxNodes;
    if (typeof body.ttlMs === 'number') args.ttlMs = body.ttlMs;
    return handlers.postGrant(args);
  });

  app.delete<{ Params: { token: string } }>('/grants-admin/:token', async (request) => {
    await handlers.deleteGrant(request.params.token);
    return { ok: true };
  });
}
