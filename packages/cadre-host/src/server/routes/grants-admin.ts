/**
 * Donation grant **admin** HTTP routes — thin adapters around
 * `GrantAdminHandlers` (`createGrantAdminHandlers(service, donations)`).
 *
 * Mount path: `/grants-admin` — the admin surface the `cadre-host grant` CLI
 * targets. It is **loopback, no bearer**: same-machine admin, matching
 * cadre-host's local-UI "no login" posture (see docs/cadre-host.md §
 * Security posture). This is distinct from the grantee-facing `/grants`
 * provisioning surface (`routes/grants.ts`), which carries the bearer gate.
 *
 * Clients: the `cadre-host grant` CLI and the local UI's Grants page. The list
 * reports each grant's live-node count and the donations a revoke would end.
 *
 * Revoking a grant also terminates the nodes donated under it unless the
 * caller passes `?keepNodes=true`; `DELETE /grants-admin/donations/:id` ends a
 * single donated node. Those are the host's only teardown paths once a grant is
 * revoked — the grantee's own `DELETE /grants/:id` is refused from then on.
 *
 * Each successful mutation publishes a `grants-changed` bus event, so an open
 * Grants page refreshes when the CLI acts.
 */

import type { FastifyInstance } from 'fastify';

import type { GrantAdminHandlers } from '../../donation/types.js';
import type { EventBus } from '../events/bus.js';

export interface GrantsAdminRoutesOptions {
  handlers: GrantAdminHandlers;
  events: EventBus;
}

export function registerGrantsAdminRoutes(app: FastifyInstance, opts: GrantsAdminRoutesOptions): void {
  const { handlers, events } = opts;

  app.get('/grants-admin', async () => {
    return handlers.listGrants();
  });

  app.post('/grants-admin', async (request) => {
    const body = (request.body ?? {}) as { label?: unknown; maxNodes?: unknown; ttlMs?: unknown };
    const label = typeof body.label === 'string' ? body.label : '';
    const args: { label: string; maxNodes?: number; ttlMs?: number } = { label };
    if (typeof body.maxNodes === 'number') args.maxNodes = body.maxNodes;
    if (typeof body.ttlMs === 'number') args.ttlMs = body.ttlMs;
    const result = await handlers.postGrant(args);
    events.publish({ type: 'grants-changed', kind: 'issued' });
    return result;
  });

  app.delete<{ Params: { token: string }; Querystring: { keepNodes?: string } }>(
    '/grants-admin/:token',
    async (request) => {
      const keepNodes = isTrueFlag(request.query.keepNodes);
      const { terminated } = await handlers.deleteGrant(request.params.token, { keepNodes });
      events.publish({ type: 'grants-changed', kind: 'revoked' });
      return { ok: true, terminated };
    },
  );

  // Two path segments past `/grants-admin`, so it never collides with `/:token`.
  const { terminateDonation } = handlers;
  if (terminateDonation) {
    app.delete<{ Params: { id: string } }>('/grants-admin/donations/:id', async (request) => {
      await terminateDonation(request.params.id);
      events.publish({ type: 'grants-changed', kind: 'terminated' });
      return { ok: true };
    });
  }
}

function isTrueFlag(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}
