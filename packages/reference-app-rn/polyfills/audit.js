/**
 * At-boot polyfill audit (development builds only).
 *
 * Lists the globals the libp2p / Optimystic stack reads and reports each as
 * `native`, `polyfilled` (one of polyfills/* patched it — see registry.js), `gap`
 * (known absent, documented, nothing on the phone's paths reaches it), or `MISSING`
 * (absent and unexplained). Anything MISSING gets a loud warning, because that is
 * the shape of every runtime defect this directory exists to prevent: an API the
 * bundle assumes, silently undefined, surfacing minutes later as an unrelated
 * timeout.
 *
 * index.js imports this module between the polyfills and `expo-router/entry`, so
 * the table prints before the router evaluates the app tree (cadre-phone.ts →
 * @libp2p/*). A call placed in index.js's own module body would run after those
 * imports had already evaluated — and an import-time crash from a missing global
 * would beat it to the log.
 *
 * The probe list is deliberately NOT shared with
 * packages/reference-app-ns/src/polyfills/audit.ts. The two runtimes have genuinely
 * different surfaces — that one probes `AbortController` itself, which React Native
 * provides and NativeScript does not, and it probes `BroadcastChannel`, which the
 * NativeScript app needs and this one provably never loads (see
 * docs/reference-app-rn.md § Key Dependencies). A shared list would be a list of
 * per-runtime exceptions and harder to read than two short ones.
 *
 * Logs go to console.log / console.warn, which logcat shows as `I/ReactNativeJS`
 * and `W/ReactNativeJS`.
 */

import { wasPolyfilled } from './registry';

/**
 * @typedef {object} Probe
 * @property {string} path Dotted global path, resolved against globalThis.
 * @property {string} [key] registry key the owning polyfill passes to markPolyfilled.
 * @property {string} [gap] Why this one is expected to be absent. Reported as `gap`
 *   rather than MISSING, and left out of the warning.
 */

/** @type {readonly Probe[]} */
const PROBES = [
	// React Native's own startup (Libraries/Core/*) is expected to provide these.
	{ path: 'process.env' },
	{ path: 'queueMicrotask' },
	{ path: 'performance.now' },
	// polyfills/event.js imports event-target-polyfill, which installs EventTarget when
	// absent without marking the registry, so `native` here cannot rule that out.
	{ path: 'EventTarget' },
	{ path: 'WebSocket' },
	{ path: 'AbortController' },
	{ path: 'TextEncoder' },
	{ path: 'crypto.getRandomValues' },
	// Native in this Hermes: a device run on 2026-09-16 found it, with `errors` intact.
	// libp2p's dial queue throws it when every address for a peer fails.
	{ path: 'AggregateError' },

	// Installed by this directory.
	{ path: 'setTimeout', key: 'setTimeout.ref' },
	{ path: 'crypto.subtle.digest', key: 'crypto.subtle.digest' },
	{ path: 'TextDecoder', key: 'TextDecoder' },
	{ path: 'structuredClone', key: 'structuredClone' },
	{ path: 'ReadableStream', key: 'ReadableStream' },
	{ path: 'WritableStream', key: 'ReadableStream' },
	{ path: 'TransformStream', key: 'ReadableStream' },
	{ path: 'Promise.withResolvers', key: 'Promise.withResolvers' },
	{ path: 'Symbol.asyncIterator', key: 'Symbol.asyncIterator' },
	{ path: 'AbortSignal.prototype.throwIfAborted', key: 'AbortSignal.prototype.throwIfAborted' },
	{ path: 'AbortSignal.timeout', key: 'AbortSignal.timeout' },
	{ path: 'AbortSignal.any', key: 'AbortSignal.any' },
	{ path: 'WebSocket.prototype.bufferedAmount', key: 'WebSocket.prototype.bufferedAmount' },
	{ path: 'CustomEvent', key: 'CustomEvent' },
	{ path: 'Intl.PluralRules', key: 'Intl.PluralRules' },
	{ path: 'RTCPeerConnection', key: 'RTCPeerConnection' },
	{ path: 'DOMException', key: 'DOMException' },

	// Known gaps — documented in docs/reference-app-rn.md § Key Dependencies.
	{
		path: 'crypto.subtle.importKey',
		gap: 'WebCrypto beyond digest is absent; the phone uses Ed25519 (pure noble) and no libp2p keychain',
	},
	{
		path: 'crypto.subtle.encrypt',
		gap: 'AES-GCM is only reached through @libp2p/keychain, which this app does not use',
	},
];

/**
 * Whether a dotted global path resolves to something.
 *
 * The last segment is read inside a try: `WebSocket.prototype.bufferedAmount` is read
 * off the prototype, not an instance, and a native accessor there may throw an
 * illegal-invocation error. That is exactly the upgrade this audit is meant to
 * notice, so a throwing getter counts as present instead of crashing boot.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isPresent(path) {
	const parts = path.split('.');
	const last = /** @type {string} */ (parts.pop());
	let obj = /** @type {unknown} */ (globalThis);
	for (const part of parts) {
		if (obj == null) return false;
		obj = /** @type {Record<string, unknown>} */ (obj)[part];
	}
	if (obj == null) return false;
	try {
		return /** @type {Record<string, unknown>} */ (obj)[last] != null;
	} catch {
		return last in Object(obj);
	}
}

/**
 * @param {Probe} probe
 * @returns {'native' | 'polyfilled' | 'gap' | 'MISSING'}
 */
function statusOf(probe) {
	if (!isPresent(probe.path)) return probe.gap ? 'gap' : 'MISSING';
	if (probe.key && wasPolyfilled(probe.key)) return 'polyfilled';
	return 'native';
}

const MARKS = { native: '✓', polyfilled: '∙', gap: '·', MISSING: '✗' };

export function runPolyfillAudit() {
	const rows = PROBES.map((p) => {
		const status = statusOf(p);
		const why = status === 'gap' ? ` — ${p.gap}` : '';
		return `  ${MARKS[status]} ${p.path.padEnd(38)} ${status}${why}`;
	});
	console.log(
		`[reference-app-rn] polyfill audit (✓ native · ∙ polyfilled · · known gap · ✗ missing):\n${rows.join('\n')}`,
	);
	const missing = PROBES.filter((p) => statusOf(p) === 'MISSING').map((p) => p.path);
	if (missing.length > 0) {
		console.warn(
			`[reference-app-rn] MISSING globals before libp2p load: ${missing.join(', ')} — `
			+ 'something in the stack will read one of these and get undefined. Add it to polyfills/hermes.js, '
			+ 'or record it as a known gap in polyfills/audit.js and docs/reference-app-rn.md.',
		);
	}
}

/* global __DEV__ */
if (typeof __DEV__ !== 'undefined' && __DEV__) {
	runPolyfillAudit();
}
