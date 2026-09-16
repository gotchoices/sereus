// Hermes runtime polyfills for APIs that libp2p and its dependencies expect.
// Must be imported before any library code.
//
// React Native 0.76+ with New Architecture should provide crypto.getRandomValues
// natively. These polyfills are fallbacks for environments where it is still missing.

// ── Debug namespaces (development builds only) ──────────────────────────────
// cadre-core logs bring-up and strand-founding phase timings under the `debug`
// namespace `sereus:cadre:timing`. `debug`'s browser build decides what is enabled
// once, when each copy of the module loads, and with no localStorage under RN it
// reads `process.env.DEBUG`. The bundle carries several copies of `debug` (seven in a
// 2026-09-15 export: the repo root's, quereus's, react-native-webrtc's and four under
// ../optimystic), so calling `enable()` on one copy would miss the others; setting the
// variable before any library module loads reaches all of them, which is why this is
// the first statement of the first polyfill.
// `process.env` already exists here — react-native's InitializeCore
// (Libraries/Core/setUpGlobals.js) runs before the entry module and creates it — and
// `__DEV__` is a Metro prelude global. The lines go to `console.debug`, which logcat
// shows as `D/ReactNativeJS`. A DEBUG value that is already set is left alone.
/* global __DEV__ */
if (__DEV__ && !process.env.DEBUG) {
	process.env.DEBUG = 'sereus:cadre:timing';
}

// Which patches below actually fired, for the at-boot audit in polyfills/audit.js.
// Reading `typeof X === 'undefined'` at audit time cannot tell a native API from one
// of ours; this can.
const { markPolyfilled } = require('./registry');

// Native CSPRNG — must be the very first import so globalThis.crypto.getRandomValues
// is available before any library code. No-op if the native API already exists.
// NOTE: requires native rebuild (EAS Build or local native build).  This is a
// hard dependency; without it any libp2p key generation or @noble/hashes call
// is unsafe, so we deliberately do NOT provide a Math.random fallback.
require('react-native-get-random-values');

// ── crypto.getRandomValues ──────────────────────────────────────────────────
// Required by: @noble/hashes (via @libp2p/crypto, @noble/curves)

if (typeof globalThis.crypto === 'undefined') {
	globalThis.crypto = /** @type {any} */ ({});
}

// ── crypto.subtle.digest ──────────────────────────────────────────────────
// Required by: multiformats/hashes/sha2-browser (used when Metro picks the
// browser variant via the package.json "browser" field).

if (!globalThis.crypto.subtle) {
	const _hashCache = {};
	function getHash(name) {
		if (_hashCache[name]) return _hashCache[name];
		// The `.js` suffix matters: @noble/hashes 2.x lists only "./sha2.js" in its
		// package.json `exports`, and Expo SDK 52+ turns on Metro's
		// `unstable_enablePackageExports`. A bare '@noble/hashes/sha2' is not an exported
		// subpath — Metro still resolves it, by falling back to file-based resolution and
		// logging a warning on every bundle, but that fallback is explicitly a transition
		// aid and the exported path costs nothing.
		const mod = require('@noble/hashes/sha2.js');
		_hashCache['SHA-256'] = mod.sha256;
		_hashCache['SHA-512'] = mod.sha512;
		return _hashCache[name];
	}
	globalThis.crypto.subtle = {
		digest(algorithm, data) {
			const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
			const fn = getHash(name);
			if (!fn) return Promise.reject(new Error('Unsupported digest algorithm: ' + name));
			return Promise.resolve(fn(new Uint8Array(data)).buffer);
		},
	};
	markPolyfilled('crypto.subtle.digest');
}

// ── TextDecoder (UTF-8 only) ───────────────────────────────────────────────
// Expo SDK 52+ Hermes provides TextDecoder natively — this block is a no-op
// there.  Bare RN 0.85 Hermes ships TextEncoder but NOT TextDecoder; the
// `uint8arrays` package (pulled in by libp2p / multiformats / yamux) does
// `const decoder = new TextDecoder('utf8')` at module scope, so without this
// polyfill yamux's default export resolves to `undefined` and CadreNode.start
// fails with "Cannot read property 'Yamux' of undefined".
//
// Kept UTF-8-only to avoid pulling in a full text-encoding polyfill; throws a
// clear RangeError if anything asks for another encoding.
if (typeof globalThis.TextDecoder === 'undefined') {
	class TextDecoderPolyfill {
		constructor(label = 'utf-8') {
			const enc = String(label).toLowerCase().replace('_', '-');
			if (enc !== 'utf-8' && enc !== 'utf8') {
				throw new RangeError(`TextDecoder polyfill only supports UTF-8 (got "${label}")`);
			}
			this.encoding = 'utf-8';
			this.fatal = false;
			this.ignoreBOM = false;
		}
		decode(input) {
			if (input == null) return '';
			const bytes = input instanceof Uint8Array
				? input
				: ArrayBuffer.isView(input)
					? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
					: new Uint8Array(input);
			if (bytes.length === 0) return '';
			let i = 0;
			let str = '';
			if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) i = 3;
			while (i < bytes.length) {
				const b = bytes[i++];
				if (b < 0x80) {
					str += String.fromCharCode(b);
				} else if (b < 0xC0) {
					str += '\uFFFD';
				} else if (b < 0xE0) {
					str += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i++] & 0x3F));
				} else if (b < 0xF0) {
					str += String.fromCharCode(
						((b & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F),
					);
				} else {
					let cp = ((b & 0x07) << 18)
						| ((bytes[i++] & 0x3F) << 12)
						| ((bytes[i++] & 0x3F) << 6)
						| (bytes[i++] & 0x3F);
					cp -= 0x10000;
					str += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
				}
			}
			return str;
		}
	}
	globalThis.TextDecoder = TextDecoderPolyfill;
	markPolyfilled('TextDecoder');
}

// ── structuredClone ─────────────────────────────────────────────────────────
// Not yet supported by Hermes.
// Required by: @optimystic/db-core (transform tracker, cache-source, coordinator)

if (typeof globalThis.structuredClone !== 'function') {
	const _structuredClone = require('@ungap/structured-clone').default;
	globalThis.structuredClone = function structuredClone(value) {
		return _structuredClone(value);
	};
	markPolyfilled('structuredClone');
}

// ── Symbol.asyncIterator ───────────────────────────────────────────────────
// Some Hermes versions omit this, breaking `for await...of` on custom iterables.
//
// Use the global symbol registry (Symbol.for) so independent polyfills running
// across packages converge on the same symbol — a fresh `Symbol(...)` would
// create a new identity each time and miss any code already using
// `Symbol.for('Symbol.asyncIterator')`.

if (typeof Symbol !== 'undefined' && typeof Symbol.asyncIterator === 'undefined') {
	try {
		Object.defineProperty(Symbol, 'asyncIterator', {
			value: Symbol.for('Symbol.asyncIterator'),
			configurable: false,
			enumerable: false,
			writable: false,
		});
	} catch {
		// Best-effort fallback for runtimes that disallow defineProperty on Symbol.
		Symbol.asyncIterator = Symbol.for('Symbol.asyncIterator');
	}
	markPolyfilled('Symbol.asyncIterator');
}

// ── Web Streams API ────────────────────────────────────────────────────────
// Required by: Vercel AI SDK, streaming-oriented libraries
// Not yet supported by Hermes.

if (typeof globalThis.ReadableStream === 'undefined') {
	const webStreams = require('web-streams-polyfill');
	globalThis.ReadableStream = webStreams.ReadableStream;
	globalThis.WritableStream = webStreams.WritableStream;
	globalThis.TransformStream = webStreams.TransformStream;
	markPolyfilled('ReadableStream');
}

// ── Promise.withResolvers ───────────────────────────────────────────────────
// ES2024 — not yet supported by Hermes.
// Required by: @libp2p/utils, @libp2p/ping, @chainsafe/libp2p-yamux,
//              it-queue, mortice, abort-error

if (typeof Promise.withResolvers !== 'function') {
	Promise.withResolvers = function withResolvers() {
		let resolve, reject;
		const promise = new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	};
	markPolyfilled('Promise.withResolvers');
}

// ── AbortSignal.prototype.throwIfAborted ────────────────────────────────────
// DOM spec addition — not yet in Hermes.
// Required by: libp2p, @libp2p/utils, @libp2p/circuit-relay-v2,
//              @chainsafe/libp2p-yamux, it-pushable, p-retry, p-event, etc.

if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.prototype.throwIfAborted !== 'function') {
	AbortSignal.prototype.throwIfAborted = function throwIfAborted() {
		if (this.aborted) {
			throw this.reason ?? abortReason('The operation was aborted.', 'AbortError');
		}
	};
	markPolyfilled('AbortSignal.prototype.throwIfAborted');
}

// ── AbortSignal.timeout / AbortSignal.any ──────────────────────────────────
// Static DOM additions Hermes does not implement.
// Required by: libp2p itself — `connection-manager/dial-queue.js` does
// `signal: options.signal ?? AbortSignal.timeout(this.dialTimeout)`, so WITHOUT this
// every dial that does not carry its own signal throws
// `TypeError: AbortSignal.timeout is not a function` and the phone cannot dial anyone.
// Also used by @libp2p/circuit-relay-v2 (reservations — i.e. whether the phone is
// invitable at all), @libp2p/websockets, @libp2p/identify and libp2p's connection,
// registrar and pruner paths. Found on the device 2026-09-16: Settings → Dial Peer
// reported it, and it is why borrowing a node from a cadre-host failed at "connecting".
//
// `DOMException` is not guaranteed here, so the abort reason falls back to a plain
// Error carrying the spec's `name`, which is what callers branch on.

function abortReason(message, name) {
	try {
		return new DOMException(message, name);
	} catch {
		const err = new Error(message);
		err.name = name;
		return err;
	}
}

// ── AbortController abort reasons ──────────────────────────────────────────
// React Native installs `abort-controller` 3.0.0 as AbortController/AbortSignal
// (Libraries/Core/setUpXHR.js, via polyfillGlobal — it replaces whatever the engine
// had). That release predates the DOM's `reason`: its `abort()` takes no argument and
// nothing ever defines `signal.reason`, so every `controller.abort(err)` anywhere in
// the bundle silently drops its error and `throwIfAborted` above falls back to a
// generic AbortError. That is why a failed dial on the phone reported only
// "AbortError: The operation was aborted" with no cause, and it would equally hide the
// TimeoutError that `AbortSignal.timeout` below aborts with.
//
// Record the reason on the signal, then delegate. `AbortSignal.prototype` defines only
// `aborted`, and signals are ordinary extensible objects, so a plain own property is
// all this needs.

if (typeof AbortController === 'function'
	&& typeof AbortSignal !== 'undefined'
	&& !('reason' in AbortSignal.prototype)) {
	const _origAbort = AbortController.prototype.abort;
	AbortController.prototype.abort = function abort(reason) {
		const signal = this.signal;
		if (!signal.aborted) {
			signal.reason = reason ?? abortReason('The operation was aborted.', 'AbortError');
		}
		return _origAbort.call(this);
	};
	markPolyfilled('AbortSignal.reason');
}

if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
	AbortSignal.timeout = function timeout(ms) {
		const controller = new AbortController();
		// NOTE: the timer always runs its full `ms` — only it can abort this signal, and no
		// API tells a signal its caller is finished — holding the controller and its
		// listeners until then. Bounded (10 s for a dial); if long timeouts are created at a
		// high rate, have those callers use a controller they can clear.
		setTimeout(() => {
			controller.abort(abortReason('The operation timed out.', 'TimeoutError'));
		}, ms);
		return controller.signal;
	};
	markPolyfilled('AbortSignal.timeout');
}

// The listeners this attaches come back off the inputs when the combined signal aborts.
// `{ once: true }` only removes the listener that actually fired, and callers combine a
// long-lived signal with a short-lived one — `p-wait-for` (pulled in by libp2p,
// @libp2p/websockets, @libp2p/circuit-relay-v2, @libp2p/webrtc and @libp2p/tcp) pairs
// the caller's signal with an `AbortSignal.timeout`, which always fires.
//
// A combination whose inputs NEVER abort keeps its listeners for as long as the inputs
// live: the DOM holds dependent signals weakly, and Hermes gives this no hook to do the
// same. Optimystic's repo client (../optimystic/packages/db-p2p/src/repo/client.ts)
// hits this on every RPC that succeeds — its deadline controller is cleared, not
// aborted — see backlog ticket bug-abortsignal-any-leaks-listeners-on-hermes.

if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
	AbortSignal.any = function any(signals) {
		const controller = new AbortController();
		const list = Array.from(signals);
		const reasonOf = (signal) => signal.reason ?? abortReason('The operation was aborted.', 'AbortError');
		// An input that has already aborted settles the result before anything is
		// registered, so there is nothing to detach.
		for (const signal of list) {
			if (signal.aborted) {
				controller.abort(reasonOf(signal));
				return controller.signal;
			}
		}
		// Pairs, not a Map keyed by signal: the same signal may legitimately appear
		// twice in `signals`, and a Map would collapse the two registrations and leave
		// one attached.
		const attached = [];
		for (const signal of list) {
			const listener = () => {
				if (controller.signal.aborted) return;
				controller.abort(reasonOf(signal));
			};
			attached.push([signal, listener]);
			signal.addEventListener('abort', listener, { once: true });
		}
		controller.signal.addEventListener('abort', () => {
			for (const [signal, listener] of attached) {
				signal.removeEventListener('abort', listener);
			}
			attached.length = 0;
		}, { once: true });
		return controller.signal;
	};
	markPolyfilled('AbortSignal.any');
}

// ── WebSocket.bufferedAmount ───────────────────────────────────────────────
// React Native's WebSocket implements neither the property nor a prototype accessor
// (verified on device: absent from the instance AND from WebSocket.prototype).
// Required by: @libp2p/websockets. `websocket-to-conn.js` gates sending on
// `websocket.bufferedAmount < maxBufferedAmount` — `undefined < n` is false, so it
// stops sending — and then waits for a poll to see `bufferedAmount === 0`, which never
// happens. The socket opens, the handshake is never written, and every outbound dial
// dies on the dial timeout instead.
//
// Found on the device 2026-09-16: the phone could not dial a lent cadre-host node over
// WebSocket, while the same address dialled from the PC in 37 ms; the phone's libp2p log
// showed "buffered amount now undefined" repeating until the 10 s abort.
//
// Reporting 0 is the honest answer here: React Native hands each frame to the native
// socket on `send()` and keeps no JS-side queue to report, so from the caller's point of
// view nothing is ever pending.

if (typeof globalThis.WebSocket === 'function'
	&& globalThis.WebSocket.prototype != null
	&& !('bufferedAmount' in globalThis.WebSocket.prototype)) {
	Object.defineProperty(globalThis.WebSocket.prototype, 'bufferedAmount', {
		get() { return 0; },
		configurable: true,
	});
	markPolyfilled('WebSocket.prototype.bufferedAmount');
}

// ── Timer .ref() / .unref() ────────────────────────────────────────────────
// Node.js timers return objects with .ref()/.unref(); Hermes returns numbers.
// Required by: @optimystic/db-p2p (cluster-repo), undici, libp2p internals
//
// We also patch clearTimeout/clearInterval to unwrap, since RN's native
// clear functions expect the raw numeric ID (the `promise` package's
// rejection-tracking stores timer handles and passes them to clearTimeout).

const _origSetTimeout = globalThis.setTimeout;
const _origSetInterval = globalThis.setInterval;
const _origClearTimeout = globalThis.clearTimeout;
const _origClearInterval = globalThis.clearInterval;

function unwrapTimer(handle) {
	return (handle && typeof handle === 'object' && '_id' in handle)
		? handle._id
		: handle;
}

function wrapTimer(id) {
	if (typeof id === 'object' && id !== null) return id;
	return {
		_id: id,
		ref() { return this; },
		unref() { return this; },
		[Symbol.toPrimitive]() { return this._id; },
	};
}

globalThis.setTimeout = function patchedSetTimeout(...args) {
	return wrapTimer(_origSetTimeout.apply(this, args));
};
Object.assign(globalThis.setTimeout, _origSetTimeout);

globalThis.setInterval = function patchedSetInterval(...args) {
	return wrapTimer(_origSetInterval.apply(this, args));
};
Object.assign(globalThis.setInterval, _origSetInterval);

globalThis.clearTimeout = function patchedClearTimeout(handle) {
	return _origClearTimeout.call(this, unwrapTimer(handle));
};

globalThis.clearInterval = function patchedClearInterval(handle) {
	return _origClearInterval.call(this, unwrapTimer(handle));
};

markPolyfilled('setTimeout.ref');
