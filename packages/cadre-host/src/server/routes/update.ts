/**
 * Update-flow HTTP routes — thin adapters around `UpdateHandlers`
 * (`createUpdateHandlers(service)`). The /update/apply route publishes
 * `update-available` for the post-apply state when the new version
 * differs from the running one.
 *
 * Mount path: `/update/*` (matches docs/cadre-host.md).
 */

import type { FastifyInstance } from 'fastify';

import type { UpdateHandlers } from '../../update/index.js';
import type { EventBus } from '../events/bus.js';

export interface UpdateRoutesOptions {
  handlers: UpdateHandlers;
  events: EventBus;
}

export function registerUpdateRoutes(app: FastifyInstance, opts: UpdateRoutesOptions): void {
  const { handlers, events } = opts;

  app.get('/update', async () => handlers.getState());

  app.post('/update/apply', async () => {
    const result = await handlers.postApply();
    // Apply succeeded — the still-running binary is the *old* one; the new
    // one becomes live after the service-host restarts. Surface the version
    // we just applied so the UI can prompt the user to refresh.
    events.publish({
      type: 'update-available',
      version: result.toVersion,
    });
    return result;
  });

  app.get('/update/settings', async () => handlers.getSettings());

  app.put('/update/settings', async (request) => {
    const body = (request.body ?? {}) as { autoApply?: boolean; manifestUrl?: string };
    return handlers.putSettings(body);
  });
}
