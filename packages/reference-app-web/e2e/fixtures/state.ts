import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tier-2 (live formation→convergence) availability gate.
 *
 * This is a coarse on/off flag, NOT a transport for the responder's data. The
 * formation responder (`formation-responder.ts`) boots **in the Playwright worker
 * process** (the spec's `beforeAll`), not in `global-setup` — Playwright runs
 * `global-setup`/`global-teardown` in the main runner process and spec files in
 * separate worker child processes, which do NOT share `globalThis` or memory. The
 * responder's live methods (`readFormationUsage`, `readStrandMessages`,
 * `seedMessage`) read in-memory state, so they only work in the process that booted
 * the node. The spec therefore boots the responder itself and reads `encoded`,
 * `strandId`, `strandMultiaddrs`, `seededMessage`, etc. directly off the live handle
 * — none of that needs to cross the process boundary through this file.
 *
 * `global-setup` writes this gate so the spec can skip cleanly when the tier is
 * disabled (`FORMATION_E2E_DISABLED`); the spec's `beforeAll` additionally degrades
 * to a skip if the in-worker responder boot throws (the real fail-soft).
 */
export interface FixtureStateAvailable {
	available: true;
}

export interface FixtureStateUnavailable {
	available: false;
	reason: string;
}

export type FixtureState = FixtureStateAvailable | FixtureStateUnavailable;

const here = dirname(fileURLToPath(import.meta.url));
export const STATE_PATH = resolve(here, '..', '.fixture-state.json');

export function writeFixtureState(state: FixtureState): void {
	writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

export function readFixtureState(): FixtureState {
	if (!existsSync(STATE_PATH)) {
		return { available: false, reason: `no fixture state at ${STATE_PATH}` };
	}
	try {
		const raw = readFileSync(STATE_PATH, 'utf8');
		return JSON.parse(raw) as FixtureState;
	} catch (err) {
		return {
			available: false,
			reason: `failed to read fixture state: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

export function clearFixtureState(): void {
	if (existsSync(STATE_PATH)) {
		try {
			unlinkSync(STATE_PATH);
		} catch {
			// ignore — not fatal
		}
	}
}
