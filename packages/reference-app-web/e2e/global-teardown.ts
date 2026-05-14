import { clearFixtureState } from './fixtures/state.js';

export default async function globalTeardown(): Promise<void> {
	const handle = globalThis.__referencePeer;
	if (handle) {
		try {
			await handle.stop();
		} catch (err) {
			console.warn('[e2e] failed to stop reference-peer:', err);
		}
		globalThis.__referencePeer = undefined;
	}
	clearFixtureState();
}
