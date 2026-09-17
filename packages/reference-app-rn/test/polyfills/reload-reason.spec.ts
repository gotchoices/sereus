/**
 * Guards `polyfills/reload-reason.js` — the development-build wrap that logs
 * `[reload] <reason>` before `DevSettings.reload` runs.
 *
 * React Native's own callers (`setUpReactRefresh.js`, `HMRClient.js`) hold the shared
 * `DevSettings` object and look `reload` up on it at call time, so calling through a
 * fake object here is the same path they take. `react-native` itself is replaced by
 * that fake: its Flow sources cannot load in Node. Each case re-evaluates the polyfill
 * (`vi.resetModules` + `import()`) because what it installs depends on `__DEV__` at
 * evaluation time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeDevSettings {
	reload(reason?: string): void;
}

// One object for the whole file: Vitest caches the mock factory's result across
// `vi.resetModules`, so each case swaps `reload` on it rather than replacing it.
const h = vi.hoisted(() => ({
	devSettings: { reload: () => undefined } as FakeDevSettings,
	events: [] as string[],
}));

vi.mock('react-native', () => ({ DevSettings: h.devSettings }));

async function evaluatePolyfill(dev: boolean): Promise<void> {
	vi.stubGlobal('__DEV__', dev);
	vi.resetModules();
	await import('../../polyfills/reload-reason.js');
}

describe('reload-reason polyfill', () => {
	let originalReload: FakeDevSettings['reload'];

	beforeEach(() => {
		h.events = [];
		originalReload = vi.fn(function (this: unknown, reason?: string) {
			h.events.push(`reload:${String(reason)}:${this === h.devSettings ? 'bound' : 'unbound'}`);
		});
		h.devSettings.reload = originalReload;
		vi.spyOn(console, 'warn').mockImplementation((message: string) => {
			h.events.push(`warn:${message}`);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('logs the reason, then reloads with it, in a development build', async () => {
		await evaluatePolyfill(true);

		h.devSettings.reload('No root boundary');

		expect(h.events).toEqual([
			'warn:[reload] No root boundary',
			'reload:No root boundary:bound',
		]);
	});

	it('still logs a line when no reason is passed', async () => {
		await evaluatePolyfill(true);

		h.devSettings.reload();

		expect(h.events).toEqual([
			'warn:[reload] (no reason given)',
			'reload:undefined:bound',
		]);
	});

	it('leaves DevSettings.reload untouched in a release build', async () => {
		await evaluatePolyfill(false);

		expect(h.devSettings.reload).toBe(originalReload);
	});
});
