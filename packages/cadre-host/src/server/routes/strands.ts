/**
 * Strand HTTP routes — thin adapters around `StrandHandlers`
 * (`createStrandHandlers(service)`).
 *
 * Mount path: `/api/strands` — a UI-only surface with no CLI contract to
 * preserve. (The `/auth/*` and `/nat/*` mounts sit outside `/api` only because
 * the existing CLI already targets those URLs.) Envelope form therefore follows
 * the other `/api/*` routes: `{ ok: true, data }`.
 *
 * A removal that actually issued a delete publishes `strands-changed` so other
 * open tabs refresh. A call that found no row publishes nothing — nothing changed.
 */

import type { FastifyInstance } from 'fastify';

import type { StrandHandlers } from '../../strands/types.js';
import type { EventBus } from '../events/bus.js';

export interface StrandRoutesOptions {
  handlers: StrandHandlers;
  events: EventBus;
}

/**
 * The only accepted `confirm` values — the same strict pair the admin channel
 * accepts. Not a general truthiness parser: `yes`, `on` and an empty value all
 * count as NOT confirmed, because a guessy parser here would turn a typo into a
 * destroyed membership key.
 */
const CONFIRM_VALUES = new Set(['1', 'true']);

export function registerStrandRoutes(app: FastifyInstance, opts: StrandRoutesOptions): void {
  const { handlers, events } = opts;

  app.get('/api/strands', async () => {
    return { ok: true, data: await handlers.listStrands() };
  });

  app.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>(
    '/api/strands/:id',
    async (request) => {
      const confirm = typeof request.query.confirm === 'string' && CONFIRM_VALUES.has(request.query.confirm);
      const result = await handlers.removeStrand(request.params.id, { confirm });
      if (result.removed) {
        events.publish({ type: 'strands-changed', kind: 'removed' });
      }
      return { ok: true, data: result };
    },
  );
}
