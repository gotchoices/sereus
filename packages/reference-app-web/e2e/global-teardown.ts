import { clearFixtureState } from './fixtures/state.js';

/**
 * Tier-2 teardown. The formation responder boots and stops in the spec's
 * `beforeAll`/`afterAll` (the worker process), so there is no responder handle to
 * stop here — `global-teardown` runs in the main runner process and never sees it.
 * The responder also listens on an ephemeral `/ws` port and dies with the worker,
 * so nothing leaks across runs. This hook only removes the availability gate file.
 */
export default async function globalTeardown(): Promise<void> {
	clearFixtureState();
}
