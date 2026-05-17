/**
 * Trust-circle HTTP routes — thin adapters around `TrustCircleHandlers`
 * (`createTrustCircleHandlers(service)`). Side-effects (invite issued,
 * pending revoked, member removed) emit a `trust-circle-changed` bus
 * event so the SPA can refresh without polling.
 *
 * Mount path: `/auth/*` — the existing CLI (cadre-host invite / trust)
 * already targets these URLs; do not change them.
 */

import type { FastifyInstance } from 'fastify';

import type { TrustCircleHandlers } from '../../auth/types.js';
import type { EventBus } from '../events/bus.js';

export interface TrustCircleRoutesOptions {
  handlers: TrustCircleHandlers;
  events: EventBus;
}

export function registerTrustCircleRoutes(app: FastifyInstance, opts: TrustCircleRoutesOptions): void {
  const { handlers, events } = opts;

  app.get('/auth/trust-circle', async () => {
    return handlers.listTrustCircle();
  });

  app.post('/auth/invites', async (request) => {
    const body = (request.body ?? {}) as { label?: unknown; ttlMs?: unknown };
    const label = typeof body.label === 'string' ? body.label : '';
    const ttlMs = typeof body.ttlMs === 'number' ? body.ttlMs : undefined;
    const args = ttlMs !== undefined ? { label, ttlMs } : { label };
    const result = await handlers.postInvite(args);
    events.publish({ type: 'trust-circle-changed', kind: 'invited' });
    return result;
  });

  app.delete<{ Params: { token: string } }>('/auth/invites/:token', async (request) => {
    await handlers.deleteInvite(request.params.token);
    events.publish({ type: 'trust-circle-changed', kind: 'revoked' });
    return { ok: true };
  });

  app.delete<{ Params: { peerId: string } }>('/auth/members/:peerId', async (request) => {
    await handlers.deleteMember(request.params.peerId);
    events.publish({ type: 'trust-circle-changed', kind: 'revoked' });
    return { ok: true };
  });
}
