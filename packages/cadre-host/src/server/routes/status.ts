/**
 * GET /api/status — aggregated health snapshot used by the SPA's dashboard.
 *
 * All inputs are in-memory subsystem state — no disk reads on each call.
 * The response budget is < 5 ms; favour `getStatus()` over `testReachability()`.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

import type { HostProcessOrchestrator } from '../../orchestrator/index.js';
import type { ManagedNodeInfo } from '../../orchestrator/types.js';
import type { TrustCircleService } from '../../auth/index.js';
import type { NatService } from '../../nat/index.js';
import type { NatStatusSnapshot } from '../../nat/types.js';
import type { UpdateService } from '../../update/index.js';

const PROCESS_STARTED_AT = process.hrtime.bigint();

export interface StatusRouteOptions {
  orchestrator: HostProcessOrchestrator;
  /** Present only when the host runs its own personal cadre (`ownCadre.enabled`). */
  trustCircle?: TrustCircleService;
  /** Present only when the host runs its own personal cadre (`ownCadre.enabled`). */
  nat?: NatService;
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
  /** Omitted in donor-only mode (no host-own trust circle). */
  trustCircle?: { members: number; pending: number };
  /** Omitted in donor-only mode (no NAT service). */
  connectivity?: NatStatusSnapshot;
  update?: { available?: string; lastChecked?: string };
}

export function registerStatusRoute(app: FastifyInstance, opts: StatusRouteOptions): void {
  const version = readPackageVersion();

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
        version,
        uptimeSeconds: secondsSince(PROCESS_STARTED_AT),
      },
      nodes,
    };

    // Trust-circle + connectivity exist only when the host runs its own
    // personal cadre; donor-only mode omits both.
    if (opts.trustCircle) {
      const tc = await opts.trustCircle.list();
      response.trustCircle = { members: tc.members.length, pending: tc.pending.length };
    }
    if (opts.nat) {
      response.connectivity = opts.nat.getStatus();
    }

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

let cachedVersion: string | null = null;
function readPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    // dist/server/routes/status.js -> ../../../package.json
    // src/server/routes/status.ts  -> ../../../package.json (vitest)
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, '..', '..', '..', 'package.json'),
      resolve(here, '..', '..', 'package.json'),
    ];
    for (const p of candidates) {
      try {
        const parsed = JSON.parse(readFileSync(p, 'utf8')) as { version?: string };
        if (parsed.version) {
          cachedVersion = parsed.version;
          return cachedVersion;
        }
      } catch { /* try next */ }
    }
  } catch { /* ignore */ }
  cachedVersion = '0.0.0-unknown';
  return cachedVersion;
}
