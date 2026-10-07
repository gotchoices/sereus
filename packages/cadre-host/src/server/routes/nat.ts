/**
 * NAT/DDNS HTTP routes — thin adapters around `NatHandlers`
 * (`createNatHandlers(service)`). Side-effects (settings change, reachability
 * re-test, DDNS reconfiguration, a manual forward) emit a `connectivity-changed`
 * bus event. The service's own change listener covers the changes that happen
 * on their own (a mapping completing after a spawn, an IP change) — see
 * `server/index.ts`.
 *
 * Mount path: `/nat/*` — matches the existing CLI (cadre-host nat ...).
 */

import type { FastifyInstance } from 'fastify';

import type { ManualForwardPatch, NatHandlers, NatSettingsFile, NatStatusSnapshot } from '../../nat/types.js';
import type { EventBus } from '../events/bus.js';

export interface NatRoutesOptions {
  handlers: NatHandlers;
  events: EventBus;
}

export function registerNatRoutes(app: FastifyInstance, opts: NatRoutesOptions): void {
  const { handlers, events } = opts;

  app.get('/nat/status', async () => handlers.getStatus());

  app.post('/nat/test', async () => {
    const snap = await handlers.testReachability();
    publishConnectivity(events, snap);
    return snap;
  });

  app.get('/nat/providers', async () => handlers.listDdnsProviders());

  app.put('/nat/ddns', async (request) => {
    const body = (request.body ?? {}) as {
      providerId?: string;
      hostname?: string;
      config?: Record<string, string>;
      externallyManaged?: boolean;
    };
    const snap = await handlers.putDdns({
      providerId: body.providerId ?? '',
      hostname: body.hostname ?? '',
      config: body.config ?? {},
      externallyManaged: body.externallyManaged ?? false,
    });
    publishConnectivity(events, snap);
    return snap;
  });

  app.put('/nat/settings', async (request) => {
    const body = (request.body ?? {}) as Partial<Omit<NatSettingsFile, 'version' | 'forwards'>>;
    const snap = await handlers.putSettings(body);
    publishConnectivity(events, snap);
    return snap;
  });

  // The ports the user forwarded on their router for one node. `null` clears a
  // port; both cleared removes the entry. Unknown node → 404 unknown_node; a
  // port outside 1–65535 → 400 invalid_config (both from the service).
  app.put<{ Params: { nodeId: string } }>('/nat/nodes/:nodeId/forward', async (request) => {
    const body = (request.body ?? {}) as ManualForwardPatch;
    const patch: ManualForwardPatch = {};
    if ('tcp' in body) patch.tcp = body.tcp;
    if ('ws' in body) patch.ws = body.ws;
    const snap = await handlers.putForward(request.params.nodeId, patch);
    publishConnectivity(events, snap);
    return snap;
  });
}

export function publishConnectivity(events: EventBus, snap: NatStatusSnapshot): void {
  events.publish({
    type: 'connectivity-changed',
    directReachability: snap.directReachability,
  });
}
