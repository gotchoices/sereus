/**
 * Browser polyfills for the libp2p / Optimystic stack.
 *
 * Modern browsers already cover the bulk of what `@serfab/cadre-rn`'s
 * `polyfills/hermes.js` patches (crypto.subtle, EventTarget, ReadableStream,
 * structuredClone, Promise.withResolvers, AbortSignal.throwIfAborted,
 * TextEncoder/Decoder). The list below is the residue.
 *
 * Import this file FIRST in `main.ts`.
 */

import { Buffer } from 'buffer';

// ── globalThis.Buffer ───────────────────────────────────────────────────────
// Some libp2p transitive deps reach for the Node `Buffer` global. Vite aliases
// `buffer` to the npm `buffer` package but does not register a global.

{
	const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
	if (typeof g.Buffer === 'undefined') {
		g.Buffer = Buffer;
	}
}

// ── Timer .ref() / .unref() ────────────────────────────────────────────────
// `setTimeout` / `setInterval` return Node `Timeout` objects in Node (with
// `.ref()` / `.unref()`) and plain numbers in browsers. Libraries authored
// for both runtimes (db-p2p's ClusterMember, undici, libp2p internals) call
// `.unref()` to keep timers from holding the event loop open. In browsers
// `.unref()` is conceptually a no-op — the event loop is owned by the host.
//
// Wrap the returned handle so it carries no-op `ref` / `unref` methods and
// still passes through `clear{Timeout,Interval}` and primitive coercion.
// Patch the clear functions to unwrap before forwarding.

const _setTimeout = globalThis.setTimeout;
const _setInterval = globalThis.setInterval;
const _clearTimeout = globalThis.clearTimeout;
const _clearInterval = globalThis.clearInterval;

interface TimerHandle {
	_id: number;
	ref(): TimerHandle;
	unref(): TimerHandle;
	[Symbol.toPrimitive](): number;
}

function wrapTimer(id: number | TimerHandle): TimerHandle {
	if (typeof id === 'object' && id !== null) return id;
	const handle: TimerHandle = {
		_id: id as number,
		ref() {
			return this;
		},
		unref() {
			return this;
		},
		[Symbol.toPrimitive]() {
			return this._id;
		},
	};
	return handle;
}

function unwrapTimer(handle: unknown): number | undefined {
	if (handle && typeof handle === 'object' && '_id' in (handle as TimerHandle)) {
		return (handle as TimerHandle)._id;
	}
	return handle as number | undefined;
}

// Detect existing .unref support; if present (e.g. some bundlers polyfill), skip.
const probe = _setTimeout(() => undefined, 0);
const needsWrap = !(probe && typeof probe === 'object' && typeof (probe as { unref?: unknown }).unref === 'function');
_clearTimeout(probe as Parameters<typeof clearTimeout>[0]);

if (needsWrap) {
	globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) =>
		wrapTimer(_setTimeout(...args) as unknown as number)) as unknown as typeof setTimeout;
	globalThis.setInterval = ((...args: Parameters<typeof setInterval>) =>
		wrapTimer(_setInterval(...args) as unknown as number)) as unknown as typeof setInterval;
	globalThis.clearTimeout = ((handle: unknown) =>
		_clearTimeout(unwrapTimer(handle) as Parameters<typeof clearTimeout>[0])) as typeof clearTimeout;
	globalThis.clearInterval = ((handle: unknown) =>
		_clearInterval(unwrapTimer(handle) as Parameters<typeof clearInterval>[0])) as typeof clearInterval;
}
