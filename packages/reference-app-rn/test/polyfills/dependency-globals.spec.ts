/**
 * Drift guard: catches the NEXT missing global, rather than the three
 * `polyfills/hermes.js` already covers.
 *
 * Every API in that file was found the same way — by hitting it on a phone, usually as
 * a timeout or an undefined somewhere unrelated. A dependency upgrade can introduce the
 * next one silently. This spec reads a listed set of dependency `dist` trees as text,
 * looks for a fixed set of global names, and fails when a name that nothing currently
 * reads starts appearing — at which point someone has to decide whether Hermes has it.
 *
 * ## What this is NOT
 *
 * It is a substring search over a hand-listed set of packages, not a walk of Metro's
 * module graph:
 *
 *  - A dependency nobody listed is invisible to it.
 *  - A global reached through a computed property name (`globalThis[name]`) is invisible
 *    to it.
 *  - It reads comments and string literals too, and cannot tell them from code. Several
 *    names were left off the watch list below for exactly that reason — `localStorage`,
 *    `Object.groupBy`, `SharedArrayBuffer` and `atob` all appear in the scanned trees
 *    only inside prose. Nothing here strips comments first: a regex comment-stripper
 *    over minified-adjacent JavaScript is the kind of half-parser that silently
 *    corrupts, and a false alarm costs one reader one minute.
 *  - It says nothing about which file variant Metro resolves. `mortice` is the standing
 *    example: its `browser` build needs `BroadcastChannel` and its `react-native` build
 *    does not, and only the allowlist entry below records which one the phone gets.
 *
 * It narrows the window; it does not close it. The on-device boot audit
 * (`polyfills/audit.js`) is what checks the real runtime.
 *
 * Bundled `*.min.js` builds and `dist/test` trees are skipped — Metro loads neither, and
 * a package's own minified bundle contains every name in the package at once, which
 * makes every result meaningless.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { appDir, resolvePackageDir } from './metro-resolution';

/**
 * The dependency trees worth watching: the libp2p stack the polyfills exist to serve,
 * the packages that stack pulls for cancellation and byte handling, and the three
 * first-party packages the phone runs.
 */
const SCANNED_PACKAGES = [
	'libp2p',
	'@libp2p/websockets',
	'@libp2p/circuit-relay-v2',
	'@libp2p/webrtc',
	'@libp2p/utils',
	'@libp2p/crypto',
	'@libp2p/peer-store',
	'@libp2p/identify',
	'@libp2p/interface',
	'@libp2p/keychain',
	'@chainsafe/libp2p-noise',
	'@chainsafe/libp2p-yamux',
	'mortice',
	'any-signal',
	'race-signal',
	'p-wait-for',
	'p-retry',
	'it-pushable',
	'uint8arrays',
	'multiformats',
	'@optimystic/db-p2p',
	'@optimystic/db-core',
	'@quereus/quereus',
	'@serfab/cadre-core',
];

/** Where a global that the scanned trees DO read comes from on the phone. */
type Provision =
	/** React Native's own startup installs it (Libraries/Core/*). */
	| { by: 'react-native'; why: string }
	/** One of `polyfills/*.js` installs it, and marks the given registry key. */
	| { by: 'polyfill'; file: string; key: string }
	/** Neither, and that is fine — with the reason it is fine. */
	| { by: 'allowlist'; why: string };

/**
 * Every global in the scanned trees that Hermes might not have, and its provision.
 *
 * The `allowlist` entries are the 2026-09-16 audit's "not gaps" findings: each one was
 * read out of installed sources, and each says what would have to change for it to
 * become a gap again.
 */
const PROVIDED: Record<string, Provision> = {
	'AbortSignal.timeout': { by: 'polyfill', file: 'hermes.js', key: 'AbortSignal.timeout' },
	'AbortSignal.any': { by: 'polyfill', file: 'hermes.js', key: 'AbortSignal.any' },
	throwIfAborted: { by: 'polyfill', file: 'hermes.js', key: 'AbortSignal.prototype.throwIfAborted' },
	bufferedAmount: { by: 'polyfill', file: 'hermes.js', key: 'WebSocket.prototype.bufferedAmount' },
	'Promise.withResolvers': { by: 'polyfill', file: 'hermes.js', key: 'Promise.withResolvers' },
	structuredClone: { by: 'polyfill', file: 'hermes.js', key: 'structuredClone' },
	TextDecoder: { by: 'polyfill', file: 'hermes.js', key: 'TextDecoder' },
	'Symbol.asyncIterator': { by: 'polyfill', file: 'hermes.js', key: 'Symbol.asyncIterator' },
	ReadableStream: { by: 'polyfill', file: 'hermes.js', key: 'ReadableStream' },
	CustomEvent: { by: 'polyfill', file: 'event.js', key: 'CustomEvent' },
	'Intl.PluralRules': { by: 'polyfill', file: 'intl-pluralrules.js', key: 'Intl.PluralRules' },
	RTCPeerConnection: { by: 'polyfill', file: 'webrtc.js', key: 'RTCPeerConnection' },

	queueMicrotask: { by: 'react-native', why: 'installed by Libraries/Core/setUpTimers.js' },
	'performance.now': { by: 'react-native', why: 'installed by Libraries/Core/setUpPerformance.js' },
	WebSocket: { by: 'react-native', why: 'installed by Libraries/Core/setUpXHR.js' },
	Blob: { by: 'react-native', why: 'installed by Libraries/Core/setUpXHR.js' },
	EventTarget: { by: 'react-native', why: 'Hermes provides it; polyfills/event.js backfills older engines' },
	TextEncoder: { by: 'react-native', why: 'Hermes ships TextEncoder (it is TextDecoder that is missing)' },
	'crypto.getRandomValues': { by: 'react-native', why: 'installed by the react-native-get-random-values native module' },

	BroadcastChannel: {
		by: 'allowlist',
		why: 'only mortice\'s browser build needs it; mortice declares a react-native field pointing at a '
			+ 'variant with no channel at all, and Metro puts react-native first in resolverMainFields. '
			+ 'The 2026-07-27 Android export carries no BroadcastChannel string.',
	},
	'navigator.userAgent': {
		by: 'allowlist',
		why: 'only libp2p\'s user-agent.browser.js reads it, and libp2p\'s react-native field points at '
			+ 'user-agent.react-native.js instead, which uses Platform.OS. The 2026-07-27 Android export '
			+ 'contains "react-native/" and no "browser/".',
	},
	'crypto.subtle': {
		by: 'allowlist',
		why: 'the polyfill provides digest only. importKey/exportKey and the AES-GCM surface are absent, '
			+ 'and the phone reaches neither: it uses Ed25519 (pure noble) and no libp2p keychain. '
			+ 'Documented in docs/reference-app-rn.md § Key Dependencies.',
	},
	AggregateError: {
		by: 'allowlist',
		why: 'libp2p throws it when every address for a peer fails. Whether Hermes provides it cannot be '
			+ 'determined from this repo — there is no Hermes VM here, only hermesc — so the boot audit '
			+ 'in polyfills/audit.js probes it on the device.',
	},
	'crypto.randomUUID': {
		by: 'allowlist',
		why: 'appears only in a cadre-core comment explaining that randomBytes is used instead.',
	},
};

/**
 * Globals Hermes does not have that NOTHING in the scanned trees reads today. Each is a
 * plausible thing for one of these packages to start using; if one appears, someone has
 * to check whether the phone has it. The value is the reason it is worth watching.
 */
const WATCHED: Record<string, string> = {
	WebAssembly: 'noise resolves its pure-JS crypto through a browser-field rewrite; if that ever slips, '
		+ '@chainsafe/as-sha256 and as-chacha20poly1305 come back and Hermes has no WebAssembly',
	'AbortSignal.abort': 'the third AbortSignal static, and the polyfill installs only timeout and any',
	'Array.fromAsync': 'ES2024, and it-* packages are the kind of code that would adopt it',
	'Symbol.dispose': 'explicit resource management — `using` in a dependency needs this symbol',
	FinalizationRegistry: 'Hermes support is not established, and cleanup-on-GC is a tempting pattern for '
		+ 'connection and lock bookkeeping',
	CompressionStream: 'a stream transform Hermes has no equivalent of',
	DecompressionStream: 'a stream transform Hermes has no equivalent of',
	TextDecoderStream: 'the streaming decoder — the polyfill provides only the one-shot TextDecoder',
	MessageChannel: 'worker plumbing; mortice reaches for it in its browser build',
	MessagePort: 'worker plumbing; mortice reaches for it in its browser build',
	sessionStorage: 'no web storage under React Native',
	indexedDB: 'no web storage under React Native',
	'navigator.locks': 'the Web Locks API is the natural replacement for mortice\'s channel locking',
	URLPattern: 'not in Hermes and not in React Native',
	requestIdleCallback: 'not in Hermes and not in React Native',
	reportError: 'not in Hermes and not in React Native',
	Atomics: 'needs SharedArrayBuffer, which Hermes does not have',
};

/**
 * Names that must be found, or the scan itself has broken — a resolution change or a
 * path mistake would otherwise leave every assertion above passing over nothing.
 */
const SENTINELS = ['AbortSignal.timeout', 'bufferedAmount', 'Promise.withResolvers', 'queueMicrotask'];

interface ScanResult {
	/** Name → the files that mention it, capped so a failure message stays readable. */
	hits: Map<string, string[]>;
	fileCount: number;
}

const MAX_REPORTED_HITS = 5;

/** Collects every `.js` Metro could load from a package's `dist`, as absolute paths. */
function distFiles(packageDir: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			// An unbuilt portaled sibling has no dist. The sentinel check below is what
			// notices if that ever hollows out the scan.
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== 'node_modules' && entry.name !== 'test') walk(full);
			} else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
				found.push(full);
			}
		}
	};
	walk(join(packageDir, 'dist'));
	return found;
}

function scan(names: readonly string[]): ScanResult {
	const hits = new Map<string, string[]>(names.map((name) => [name, []]));
	let fileCount = 0;
	for (const packageName of SCANNED_PACKAGES) {
		const packageDir = resolvePackageDir(packageName);
		for (const file of distFiles(packageDir)) {
			fileCount++;
			const source = readFileSync(file, 'utf8');
			for (const name of names) {
				if (!source.includes(name)) continue;
				const where = hits.get(name)!;
				if (where.length < MAX_REPORTED_HITS) {
					where.push(`${packageName}/${file.slice(packageDir.length + 1).split(/[\\/]/).join('/')}`);
				}
			}
		}
	}
	return { hits, fileCount };
}

describe('globals our dependencies read', () => {
	let result: ScanResult;

	beforeAll(() => {
		result = scan([...Object.keys(PROVIDED), ...Object.keys(WATCHED), ...SENTINELS]);
	});

	it('scans something', () => {
		expect(result.fileCount).toBeGreaterThan(0);
	});

	it('still finds the globals the phone is known to need', () => {
		// Vacuity guard: if package resolution or the walk breaks, every other assertion
		// here passes over an empty scan.
		for (const name of SENTINELS) {
			expect(result.hits.get(name), `${name} was not found in any scanned dist — the scan is broken, `
				+ 'not the dependencies').not.toHaveLength(0);
		}
	});

	it('has not started reading a global nothing provides', () => {
		const appeared = Object.keys(WATCHED)
			.filter((name) => (result.hits.get(name) ?? []).length > 0)
			.map((name) => `  ${name} — ${WATCHED[name]}\n    seen in: ${result.hits.get(name)!.join(', ')}`);
		expect(appeared, appeared.length === 0 ? '' : (
			'A dependency now mentions a global Hermes does not provide:\n'
			+ `${appeared.join('\n')}\n`
			+ 'Check whether the mention is real code or just a comment or string — this is a substring '
			+ 'search. If it is real, either polyfill it in polyfills/hermes.js and move it to PROVIDED, '
			+ 'or move it to PROVIDED as an allowlist entry saying why the phone never reaches it.'
		)).toEqual([]);
	});

	it('still installs every global it claims to polyfill', () => {
		// Deleting a polyfill arm is the failure this catches: the dependency still reads
		// the global, and nothing else in the repo notices it stopped being installed.
		for (const [name, provision] of Object.entries(PROVIDED)) {
			if (provision.by !== 'polyfill') continue;
			const source = readFileSync(join(appDir, 'polyfills', provision.file), 'utf8');
			expect(source, `${name} is listed as installed by polyfills/${provision.file}, but that file no `
				+ `longer marks '${provision.key}'`).toContain(`markPolyfilled('${provision.key}')`);
		}
	});

	it('gives the boot audit registry keys that something actually marks', () => {
		// A typo in a `key:` in audit.js silently downgrades that row from `polyfilled` to
		// `native`, which is the one distinction the audit exists to make.
		const auditSource = readFileSync(join(appDir, 'polyfills', 'audit.js'), 'utf8');
		const auditKeys = [...auditSource.matchAll(/key: '([^']+)'/g)].map((match) => match[1]);
		expect(auditKeys.length).toBeGreaterThan(0);

		const marks = new Set(
			readdirSync(join(appDir, 'polyfills'))
				.filter((name) => name.endsWith('.js'))
				.flatMap((name) => [
					...readFileSync(join(appDir, 'polyfills', name), 'utf8').matchAll(/markPolyfilled\('([^']+)'\)/g),
				])
				.map((match) => match[1]),
		);
		for (const key of auditKeys) {
			expect(marks, `polyfills/audit.js probes registry key '${key}', which no polyfill marks`)
				.toContain(key);
		}
	});
});
