/**
 * At-boot polyfill audit.
 *
 * Logs which globals the libp2p / Optimystic stack needs and whether each is
 * `native`, `polyfilled` (patched by src/polyfills/*), or `MISSING`. Run this
 * from app/app.ts AFTER the polyfills + @valor/nativescript-websockets imports
 * and BEFORE any cadre/libp2p code, so the real V8/JSC surface is visible and
 * a regression (an API silently going missing) surfaces loudly at startup.
 */

import { wasPolyfilled } from './registry';

interface Probe {
	/** Dotted global path, resolved against globalThis. */
	readonly path: string;
	/** registry key set by the owning polyfill (markPolyfilled), if any. */
	readonly key?: string;
}

const PROBES: readonly Probe[] = [
	{ path: 'process.env', key: 'process' },
	{ path: 'crypto.getRandomValues' },
	{ path: 'crypto.randomUUID' },
	{ path: 'crypto.subtle.generateKey' },
	{ path: 'crypto.subtle.digest', key: 'crypto.subtle.digest' },
	{ path: 'TextEncoder' },
	{ path: 'TextDecoder', key: 'TextDecoder' },
	{ path: 'structuredClone', key: 'structuredClone' },
	{ path: 'WebSocket' },
	{ path: 'ReadableStream', key: 'ReadableStream' },
	{ path: 'WritableStream', key: 'ReadableStream' },
	{ path: 'TransformStream', key: 'ReadableStream' },
	{ path: 'Promise.withResolvers', key: 'Promise.withResolvers' },
	{ path: 'AbortController', key: 'AbortController' },
	{ path: 'AbortSignal.prototype.throwIfAborted', key: 'AbortController' },
	{ path: 'EventTarget' },
	{ path: 'CustomEvent', key: 'CustomEvent' },
	{ path: 'Intl.PluralRules', key: 'Intl.PluralRules' },
	{ path: 'Intl.DateTimeFormat', key: 'Intl.DateTimeFormat' },
	{ path: 'Buffer', key: 'Buffer' },
	{ path: 'btoa' },
	{ path: 'Symbol.asyncIterator', key: 'Symbol.asyncIterator' },
	{ path: 'BroadcastChannel', key: 'BroadcastChannel' },
];

function resolve(path: string): unknown {
	let obj: unknown = globalThis;
	for (const part of path.split('.')) {
		if (obj == null) return undefined;
		obj = (obj as Record<string, unknown>)[part];
	}
	return obj;
}

function statusOf(probe: Probe): 'native' | 'polyfilled' | 'MISSING' {
	if (resolve(probe.path) == null) return 'MISSING';
	if (probe.key && wasPolyfilled(probe.key)) return 'polyfilled';
	return 'native';
}

export function runPolyfillAudit(): void {
	const rows = PROBES.map((p) => {
		const status = statusOf(p);
		const mark = status === 'MISSING' ? '✗' : status === 'polyfilled' ? '∙' : '✓';
		return `  ${mark} ${p.path.padEnd(40)} ${status}`;
	});
	const missing = PROBES.filter((p) => statusOf(p) === 'MISSING');
	console.log(
		`[reference-app-ns] polyfill audit (✓ native · ∙ polyfilled · ✗ missing):\n${rows.join('\n')}`,
	);
	if (missing.length > 0) {
		console.warn(
			`[reference-app-ns] MISSING globals before libp2p load: ${missing
				.map((p) => p.path)
				.join(', ')} — the stack will likely fail to boot.`,
		);
	}
}
