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
	// eslint-disable-next-line no-var
	var __referencePeer: ReferenceMeshHandle | undefined;
}

/**
 * Phase 1 deferral. The Tier-2 distributed suite asserts membership-free
 * Optimystic convergence on a shared network — which no longer holds now that
 * chat data lives inside a cadre **strand** cohort. Re-establishing cross-node /
 * cross-party convergence requires control-network membership or strand
 * formation, which is Phase 2 (`reference-app-web-strand-formation-consent-rbac`).
 * Until then every distributed spec skips with this reason. Flip to `false` (and
 * rewire the distributed specs onto the cadre model) when Phase 2 lands.
 */
const TIER2_DEFERRED_TO_PHASE2 = true;

export default async function globalSetup(_config: FullConfig): Promise<void> {
	clearFixtureState();

	if (TIER2_DEFERRED_TO_PHASE2) {
		writeFixtureState({
			available: false,
			reason:
				'Phase 1: chat data now lives in a cadre strand cohort; distributed ' +
				'convergence is re-established in Phase 2 (strand formation / RBAC).',
		});
		console.log('[e2e] Tier 2 deferred to Phase 2 (cadre strand model)');
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
