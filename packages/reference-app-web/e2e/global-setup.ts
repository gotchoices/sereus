import type { FullConfig } from '@playwright/test';
import { detectOptimysticCli } from './fixtures/optimystic-detect.js';
import { spawnReferenceMesh, type ReferenceMeshHandle } from './fixtures/reference-peer.js';
import { writeFixtureState, clearFixtureState } from './fixtures/state.js';

const BOOTSTRAP_WS_PORT = 9191;
const SERVICE_WS_PORTS = [9192, 9193];
const ENV_OVERRIDE = 'OPTIMYSTIC_WS_BOOTSTRAP';

// Stash the live handle on globalThis so global-teardown can find it. We
// can't return a value from global-setup that teardown receives, so a side
// channel is the cleanest approach.
declare global {
	 
	var __referencePeer: ReferenceMeshHandle | undefined;
}

/**
 * Tier-2 convergence deferral (still on).
 *
 * The legacy distributed suite (`e2e/distributed/*`) asserts *membership-free*
 * Optimystic convergence on a shared network — obsolete now that chat data lives
 * inside a cadre **strand** cohort. The Phase-2 cadre analogue is two parties
 * sharing a **closed** strand via the consent/invitation formation flow, then a
 * message written by one converging to the other through the cohort.
 *
 * That live path is not yet runnable in this fixture because it needs all of:
 *   1. a circuit-relay reservation so both browser tabs are dialable
 *      (the relay is deployment infra — see `relay-config.ts` / `ops/`), and
 *   2. the DB-backed consent wiring (`FormationInvite` / `FormationUsage` inserts)
 *      that `formationinvite-fix-curve-and-wire-consent` lands in cadre-core, and
 *   3. a dialable second cadre (a second relayed tab, or a headless cadre
 *      responder fixture — `cadre-cli` has no formation command today).
 *
 * Until a relay fixture + responder land, every distributed spec skips with this
 * reason. The solo-tier `formation-rbac.spec.ts` covers what a single tab can
 * prove (formation panel, dialability/invalid-invitation guards, the authority
 * gate, and the authorization surface). Flip to `false` and add the relay/
 * responder fixture below to re-establish live convergence.
 */
const TIER2_CONVERGENCE_DEFERRED = true;

export default async function globalSetup(_config: FullConfig): Promise<void> {
	clearFixtureState();

	if (TIER2_CONVERGENCE_DEFERRED) {
		writeFixtureState({
			available: false,
			reason:
				'Tier-2 cross-party convergence needs a circuit-relay reservation + a ' +
				'dialable second cadre + the cadre-core consent DB wiring; deferred to a ' +
				'relay/responder fixture (see global-setup.ts).',
		});
		console.log('[e2e] Tier 2 convergence deferred (needs relay + responder fixture)');
		return;
	}

	const override = process.env[ENV_OVERRIDE];
	if (override && override.trim() !== '') {
		writeFixtureState({
			available: true,
			multiaddr: override.trim(),
			serviceMultiaddrs: [],
			source: 'env',
			pid: null,
		});
		console.log(
			`[e2e] Tier 2: using ${ENV_OVERRIDE} bootstrap = ${override.trim()}`,
		);
		return;
	}

	const detect = detectOptimysticCli();
	if (!detect.available) {
		writeFixtureState({ available: false, reason: detect.reason });
		console.log(`[e2e] Tier 2 disabled: ${detect.reason}`);
		return;
	}

	console.log(
		`[e2e] spawning reference-peer mesh on ws ports ${BOOTSTRAP_WS_PORT} (bootstrap) + ${SERVICE_WS_PORTS.join(', ')} (service)…`,
	);
	try {
		const handle = await spawnReferenceMesh({
			cliPath: detect.cliPath,
			bootstrapWsPort: BOOTSTRAP_WS_PORT,
			serviceWsPorts: SERVICE_WS_PORTS,
		});
		globalThis.__referencePeer = handle;
		writeFixtureState({
			available: true,
			multiaddr: handle.bootstrapMultiaddr,
			serviceMultiaddrs: handle.serviceMultiaddrs,
			source: 'spawned',
			pid: null,
		});
		console.log(`[e2e] reference-peer mesh ready:`);
		console.log(`[e2e]   bootstrap: ${handle.bootstrapMultiaddr}`);
		for (const addr of handle.serviceMultiaddrs) {
			console.log(`[e2e]   service:   ${addr}`);
		}
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		writeFixtureState({
			available: false,
			reason: `failed to spawn reference-peer mesh: ${reason}`,
		});
		console.warn(`[e2e] Tier 2 disabled: ${reason}`);
	}
}
