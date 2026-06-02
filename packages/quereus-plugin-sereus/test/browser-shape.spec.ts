// @vitest-environment jsdom

/**
 * Module-shape test for the prebuilt browser bundle.
 *
 * Imports `dist/plugin-browser.js` in a jsdom environment with
 * `fake-indexeddb` installed globally. Asserts that:
 *  - the default export is a function,
 *  - invoking it with a stub `Database` reaches the IndexedDB open call.
 *
 * We do not exercise networking — calling `createLibp2pNode` from a Node test
 * environment is unsupported (browser WebSockets transport, no DOM listen
 * sockets). The point is to prove the module instantiates cleanly under DOM
 * globals and reaches the storage layer before failing on the libp2p side.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const bundlePath = resolve(pkgRoot, 'dist', 'plugin-browser.js');

beforeAll(() => {
	if (!existsSync(bundlePath)) {
		const r = spawnSync('node', ['scripts/build-browser.mjs'], {
			cwd: pkgRoot,
			stdio: 'inherit',
		});
		if (r.status !== 0) {
			throw new Error('build-browser.mjs failed');
		}
	}
});

function stubDatabase() {
	const calls = {
		registerModule: [] as unknown[],
		registerFunction: [] as unknown[],
		registerCollation: [] as unknown[],
		setDefaultVtabName: [] as unknown[],
		setDefaultVtabArgs: [] as unknown[],
		exec: [] as unknown[],
	};
	return {
		registerModule: (...a: unknown[]) => { calls.registerModule.push(a); },
		registerFunction: (...a: unknown[]) => { calls.registerFunction.push(a); },
		registerCollation: (...a: unknown[]) => { calls.registerCollation.push(a); },
		setDefaultVtabName: (...a: unknown[]) => { calls.setDefaultVtabName.push(a); },
		setDefaultVtabArgs: (...a: unknown[]) => { calls.setDefaultVtabArgs.push(a); },
		setDefaultVtabArgsFromJson: (...a: unknown[]) => { calls.setDefaultVtabArgs.push(a); },
		exec: async (...a: unknown[]) => { calls.exec.push(a); },
		eval: () => ({ async *[Symbol.asyncIterator]() {} }),
		close: () => {},
		_calls: calls,
	};
}

describe('browser bundle module shape', () => {
	// 2.5 MiB ESM parses in roughly 1-5s on a cold cache; give it headroom.
	it('default export is a function', { timeout: 30_000 }, async () => {
		const mod: any = await import(pathToFileURL(bundlePath).href);
		expect(typeof mod.default).toBe('function');
	});

	it('invoking default reaches IndexedDB open before failing on libp2p', { timeout: 30_000 }, async () => {
		const mod: any = await import(pathToFileURL(bundlePath).href);
		const db = stubDatabase();

		let caught: unknown;
		try {
			await mod.default(db as any, { strand_id: 'shape-test' });
		} catch (err) {
			caught = err;
		}

		// Crypto + optimystic registrations land synchronously before any libp2p
		// dial. If module instantiation broke (e.g. a missing global at import
		// time) we'd see zero registrations.
		expect(db._calls.registerFunction.length).toBeGreaterThan(0);
		expect(db._calls.registerModule.length).toBeGreaterThan(0);

		// Confirm IndexedDB was actually touched. `fake-indexeddb/auto` installs
		// `indexedDB` on the global. The bundle calls `openOptimysticWebDb(...)`
		// which goes through `idb` → `indexedDB.open(...)`. After that, depending
		// on jsdom/libp2p quirks, the libp2p creation may or may not fail; either
		// outcome is fine for this smoke test.
		const dbs = await (globalThis as any).indexedDB.databases?.() ?? [];
		const names = dbs.map((d: { name?: string }) => d.name);
		expect(names).toContain('sereus-strand-shape-test');

		// If we did catch an error, surface it for debugging but don't fail.
		if (caught) {
			 
			console.log('expected post-storage failure:', (caught as Error).message);
		}
	});
});
