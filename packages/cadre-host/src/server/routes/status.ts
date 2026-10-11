/**
 * GET /api/status — aggregated health snapshot used by the SPA's dashboard.
 *
 * All inputs are in-memory subsystem state — no disk reads on each call.
 * The response budget is < 5 ms; favour `getStatus()` over `testReachability()`.
 */

import type { FastifyInstance } from 'fastify';

import type { HostProcessOrchestrator } from '../../orchestrator/index.js';
import type { ManagedNodeInfo } from '../../orchestrator/types.js';
import type { NatService } from '../../nat/index.js';
import type { NatStatusSnapshot } from '../../nat/types.js';
import type { UpdateService } from '../../update/index.js';
import { packageVersion } from '../../package-version.js';

const PROCESS_STARTED_AT = process.hrtime.bigint();

export interface StatusRouteOptions {
  orchestrator: HostProcessOrchestrator;
  nat: NatService;
  update?: UpdateService;
}

export interface StatusResponse {
  service: { name: 'cadre-host'; version: string; uptimeSeconds: number };
  nodes: Array<{
    id: string;
    partyId: string;
    status: ManagedNodeInfo['status'];
    profile: ManagedNodeInfo['profile'];
  }>;
  connectivity: NatStatusSnapshot;
  update?: { available?: string; lastChecked?: string };
}

export function registerStatusRoute(app: FastifyInstance, opts: StatusRouteOptions): void {

  app.get('/api/status', async (): Promise<StatusResponse> => {
    const nodes = opts.orchestrator.listNodes().map((n) => ({
      id: n.id,
      partyId: n.partyId,
      status: n.status,
      profile: n.profile,
    }));

    const response: StatusResponse = {
      service: {
        name: 'cadre-host',
        version: packageVersion,
        uptimeSeconds: secondsSince(PROCESS_STARTED_AT),
      },
      nodes,
      connectivity: opts.nat.getStatus(),
    };

    if (opts.update) {
      const state = await opts.update.getState();
      const update: { available?: string; lastChecked?: string } = {};
      if (state.available?.version) update.available = state.available.version;
      if (state.lastChecked) update.lastChecked = state.lastChecked;
      response.update = update;
    }

    return response;
  });
}

function secondsSince(start: bigint): number {
  const now = process.hrtime.bigint();
  const elapsedNs = now - start;
  return Number(elapsedNs / 1_000_000_000n);
}
