import type { FullConfig } from '@playwright/test';
import { writeFixtureState, clearFixtureState } from './fixtures/state.js';

/** Env opt-out: set this (to any non-empty value) to disable the live tier. */
const DISABLE_ENV = 'FORMATION_E2E_DISABLED';

/**
 * Tier-2 live formation→convergence setup.
 *
 * Unlike the retired bootstrap-mesh tier, this setup spawns **nothing**: the
 * second party is the in-process `formation-responder.ts` cadre, and it boots in
 * the spec's `beforeAll` (the Playwright **worker** process), not here. Playwright
 * runs `global-setup` in the main runner process and spec files in separate worker
 * child processes that do NOT share `globalThis`/memory, so a responder booted here
 * would be unreachable from the spec's assertions (`readFormationUsage`,
 * `readStrandMessages`, `seedMessage` all read in-memory node state). See
 * `fixtures/state.ts` for the full rationale.
 *
 * So this hook just writes the availability gate the spec reads: `available:true`
 * normally, or `available:false` when the tier is opted out via `FORMATION_E2E_DISABLED`
 * (e.g. to run only the solo tier). The real fail-soft — degrade to skip if the
 * responder fails to boot — lives in the spec's `beforeAll`, since that is where
 * the boot happens.
 */
export default async function globalSetup(_config: FullConfig): Promise<void> {
	clearFixtureState();

	const disabled = process.env[DISABLE_ENV];
	if (disabled && disabled.trim() !== '') {
		writeFixtureState({
			available: false,
			reason: `formation tier disabled via ${DISABLE_ENV}`,
		});
		console.log(`[e2e] formation→convergence tier disabled via ${DISABLE_ENV}`);
		return;
	}

	writeFixtureState({ available: true });
	console.log('[e2e] formation→convergence tier enabled (responder boots in-worker)');
}
