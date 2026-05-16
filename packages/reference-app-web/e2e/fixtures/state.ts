import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FixtureStateAvailable {
	available: true;
	multiaddr: string;
	/**
	 * Additional bootstrap multiaddrs (currently the headless `service` peers
	 * spawned alongside the primary `--offline` bootstrap to give the cluster
	 * a real 3-node quorum). Empty when the fixture is `env`-sourced — the
	 * caller is responsible for managing their own mesh.
	 */
	serviceMultiaddrs?: string[];
	pid?: number | null;
	source: 'spawned' | 'env';
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
