import { expect, type Page, type TestInfo } from '@playwright/test';
import {
	readFixtureState,
	type FixtureState,
	type FixtureStateAvailable,
} from '../fixtures/state.js';

export function loadFixtureState(): FixtureState {
	return readFixtureState();
}

/**
 * Returns the multiaddr if Tier 2 is available; otherwise skips the calling
 * test. Tests in distributed/* call this in a `test.beforeAll` so the skip
 * shows up clearly per spec.
 */
export function requireFixture(state: FixtureState, testInfo: TestInfo): FixtureStateAvailable {
	if (!state.available) {
		testInfo.skip(true, `Tier 2 fixture unavailable: ${state.reason}`);
		// Unreachable — testInfo.skip throws — but the type narrowing helps callers.
		throw new Error('unreachable');
	}
	return state;
}

export function extractPeerIdFromMultiaddr(multiaddr: string): string {
	const match = multiaddr.match(/\/p2p\/([A-Za-z0-9]+)/);
	if (!match) throw new Error(`no /p2p/ component in multiaddr: ${multiaddr}`);
	return match[1];
}

/**
 * All bootstrap multiaddrs from the fixture — the primary multiaddr plus any
 * service-peer addresses spawned alongside it. Browsers paste the full
 * newline-separated list into the bootstrap textarea so libp2p dials all
 * mesh members up front, without waiting on FRET propagation.
 */
export function collectBootstrapMultiaddrs(fixture: FixtureStateAvailable): string[] {
	const extras = fixture.serviceMultiaddrs ?? [];
	return [fixture.multiaddr, ...extras];
}

/**
 * If `OPTIMYSTIC_E2E_DEBUG=1`, enable `localStorage.debug` so optimystic /
 * libp2p emit console traces — useful for inspecting quorum / dial paths
 * via Playwright's trace viewer. No-op otherwise.
 */
export async function maybeEnableBrowserDebug(page: Page): Promise<void> {
	if (process.env.OPTIMYSTIC_E2E_DEBUG !== '1') return;
	await page.addInitScript(() => {
		try {
			// The optimystic logger uses the namespace `optimystic:db-p2p:*`
			// (see `optimystic/packages/db-p2p/src/logger.ts`). Capture libp2p
			// dial + circuit-relay debug too so we can see who's reachable.
			window.localStorage.setItem('debug', 'optimystic:*,libp2p:dial*,libp2p:circuit*,libp2p:identify*,libp2p:registrar*');
		} catch {
			// localStorage may be unavailable in some test contexts; ignore.
		}
	});
	page.on('console', (msg) => {
		// `msg.text()` returns the RAW `debug`-library format string (e.g.
		// `dial:fail peer=%s ... code=%s msg=%s`) because the browser console
		// does `%s` substitution lazily in its own formatter — so the rich
		// `code=`/`msg=` fields never land in the captured text. Resolve the
		// JSHandle args ourselves and re-run the printf substitution so the
		// interpolated values are recoverable from the test log.
		const text = msg.text();
		if (!text.includes('optimystic:') && !text.includes('libp2p:')) return;
		void (async () => {
			let line: string;
			try {
				const args = await Promise.all(msg.args().map((h) => h.jsonValue()));
				line = args.length > 0 && typeof args[0] === 'string'
					? formatConsoleArgs(args[0], args.slice(1))
					: text;
			} catch {
				// JSHandle may be disposed if the page closed mid-resolve; fall
				// back to the raw (un-substituted) text rather than losing the line.
				line = text;
			}
			// Strip ANSI / %c colour controls for readable test output.
			const clean = line.replace(/%c|color: [^;]+;?/g, '').replace(/\s+/g, ' ').trim();
			console.log(`[browser ${msg.type()}] ${clean}`);
		})();
	});
}

/**
 * Re-implements the subset of `console.log` printf substitution the `debug`
 * library relies on (`%s %d %i %f %j %o %O %c %%`). The browser does this
 * lazily, so to recover the interpolated `dial:fail code=/msg=` fields we must
 * apply it ourselves against the resolved JSHandle arg values. `%c` consumes a
 * styling arg but emits nothing.
 */
function formatConsoleArgs(format: string, args: unknown[]): string {
	let i = 0;
	const substituted = format.replace(/%([sdifjoOc%])/g, (_match, spec: string) => {
		if (spec === '%') return '%';
		const value = args[i++];
		switch (spec) {
			case 'c': return '';
			case 'd':
			case 'i': return String(Number.parseInt(String(value), 10));
			case 'f': return String(Number.parseFloat(String(value)));
			case 'j': return JSON.stringify(value);
			case 'o':
			case 'O': return typeof value === 'object' ? JSON.stringify(value) : String(value);
			default: return String(value);
		}
	});
	// Any args beyond the format placeholders are appended space-separated, as
	// the browser console does.
	const trailing = args.slice(i).map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)));
	return trailing.length > 0 ? `${substituted} ${trailing.join(' ')}` : substituted;
}

/**
 * Wait for the node to be `running` (solo, fresh boot), paste the bootstrap
 * multiaddrs, click Connect, and wait for the mode badge to flip to
 * `distributed`. Used by every Tier 2 spec. Callers build the list via
 * {@link collectBootstrapMultiaddrs}, which always returns at least the
 * primary bootstrap (env-override path returns a single-element array).
 */
export async function connectToBootstrap(page: Page, multiaddrs: string[]): Promise<void> {
	if (multiaddrs.length === 0) throw new Error('connectToBootstrap: no multiaddrs provided');
	const textareaValue = multiaddrs.join('\n');
	await maybeEnableBrowserDebug(page);
	await page.goto('/');
	await expect(page.getByTestId('home-status')).toHaveText('running', {
		timeout: 30_000,
	});
	await page.getByTestId('bootstrap-input').fill(textareaValue);
	await page.getByTestId('btn-connect').click();
	await expect(page.getByTestId('mode-badge')).toHaveText('distributed', {
		timeout: 60_000,
	});
	await expect(page.getByTestId('home-status')).toHaveText('running', {
		timeout: 60_000,
	});
	// Wait for the libp2p bootstrap dial to actually land. The mode badge
	// flips as soon as the node restarts with bootstrap args; it does NOT
	// imply a live connection yet — bootstrap discovery + noise handshake +
	// identify can take a few seconds. Poll Diagnostics for ≥ 1 connection.
	await page.goto('/#/diag');
	await expect(page.getByTestId('diag-transports')).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(
			async () => page.locator('[data-testid="diag-connection-row"]').count(),
			{ timeout: 60_000, intervals: [1000, 2000, 3000] },
		)
		.toBeGreaterThanOrEqual(1);
	// Wait for the circuit-relay reservation to land. browsers can't form direct
	// listens, so the only way other peers (including ourselves elsewhere in the
	// cluster keyspace) can dial us is through a service-peer relay. The
	// reservation handshake is asynchronous and races the test budget; gate the
	// helper on a `/p2p-circuit/p2p/<self>` multiaddr being advertised so the
	// downstream NetworkTransactor calls actually find a dialable peer.
	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					const hook = (window as unknown as {
						__optimystic?: { getMultiaddrs: () => string[] };
					}).__optimystic;
					if (!hook) return [];
					return hook.getMultiaddrs();
				}),
			{ timeout: 60_000, intervals: [500, 1000, 2000, 3000] },
		)
		.toEqual(
			expect.arrayContaining([expect.stringMatching(/\/p2p-circuit\/p2p\//)]),
		);
	// Go back to home so subsequent tests can use the network panel.
	await page.goto('/#/');
}
