import type { FullConfig } from '@playwright/test';
import { detectOptimysticCli } from './fixtures/optimystic-detect.js';
import { spawnReferencePeer, type ReferencePeerHandle } from './fixtures/reference-peer.js';
import { writeFixtureState, clearFixtureState } from './fixtures/state.js';

const WS_PORT = 9191;
const ENV_OVERRIDE = 'OPTIMYSTIC_WS_BOOTSTRAP';

// Stash the live handle on globalThis so global-teardown can find it. We
// can't return a value from global-setup that teardown receives, so a side
// channel is the cleanest approach.
declare global {
	// eslint-disable-next-line no-var
	var __referencePeer: ReferencePeerHandle | undefined;
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
	clearFixtureState();

	const override = process.env[ENV_OVERRIDE];
	if (override && override.trim() !== '') {
		writeFixtureState({
			available: true,
			multiaddr: override.trim(),
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

	console.log(`[e2e] spawning reference-peer fixture on ws port ${WS_PORT}…`);
	try {
		const handle = await spawnReferencePeer({
			cliPath: detect.cliPath,
			wsPort: WS_PORT,
		});
		globalThis.__referencePeer = handle;
		writeFixtureState({
			available: true,
			multiaddr: handle.multiaddr,
			source: 'spawned',
			pid: null,
		});
		console.log(`[e2e] reference-peer ready: ${handle.multiaddr}`);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		writeFixtureState({
			available: false,
			reason: `failed to spawn reference-peer: ${reason}`,
		});
		console.warn(`[e2e] Tier 2 disabled: ${reason}`);
	}
}
