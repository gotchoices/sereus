/**
 * NAT/DDNS HTTP routes — thin adapters around `NatHandlers`
 * (`createNatHandlers(service)`). Side-effects (settings change, reachability
 * re-test, DDNS reconfiguration) emit a `connectivity-changed` bus event.
 *
 * Mount path: `/nat/*` — matches the existing CLI (cadre-host nat ...).
 */

import type { FastifyInstance } from 'fastify';

import type { NatHandlers, NatSettingsFile, NatStatusSnapshot } from '../../nat/types.js';
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
    const body = (request.body ?? {}) as Partial<Omit<NatSettingsFile, 'version'>>;
    const snap = await handlers.putSettings(body);
    publishConnectivity(events, snap);
    return snap;
  });
}

export function publishConnectivity(events: EventBus, snap: NatStatusSnapshot): void {
  events.publish({
    type: 'connectivity-changed',
    portMode: snap.portMode,
    directReachability: snap.directReachability,
  });
}
