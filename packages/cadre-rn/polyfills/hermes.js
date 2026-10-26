// Hermes runtime polyfills for APIs that libp2p and its dependencies expect.
// The first module `@serfab/cadre-rn/polyfills` loads (see index.js), which the app
// imports before any library code.
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

// Which patches below actually fired, for the at-boot audit in audit.js.
// Reading `typeof X === 'undefined'` at audit time cannot tell a native API from one
// of ours; this can.
const { markPolyfilled } = require('./registry');

// Native CSPRNG — must be the very first import so globalThis.crypto.getRandomValues
// is available before any library code. No-op if the native API already exists.
// NOTE: requires native rebuild (EAS Build or local native build), and the app must
// list it as its own dependency: React Native autolinks only an app's direct
// dependencies. This is a hard dependency; without it any libp2p key generation or
// @noble/hashes call is unsafe, so we deliberately do NOT provide a Math.random fallback.
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
	// Tagged so `@serfab/cadre-rn/native-digest` can recognise this fallback and replace it
	// with a native hash once react-native-quick-crypto has loaded (noise-crypto does).
	globalThis.crypto.subtle.digest[Symbol.for('@serfab/cadre-rn/js-digest')] = true;
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
//
// Output is built a chunk of code units at a time, never a character at a time:
// `str += …` per character is slow on Hermes, and Optimystic decodes every block,
// transform and metadata record it reads from storage (gotchoices/sereus#51).
if (typeof globalThis.TextDecoder === 'undefined') {
	const CHUNK = 4096;
	// One slot past CHUNK: the flush check runs before each byte, and a surrogate pair
	// begun at CHUNK - 1 ends at CHUNK. Shared by every decoder, which is safe because
	// decode is synchronous and never re-entered.
	const units = new Uint16Array(CHUNK + 1);

	/** Appends `codeUnits` (at most CHUNK of them, far inside Hermes's argument limit) as a string. */
	function pushString(parts, codeUnits) {
		parts.push(String.fromCharCode.apply(null, codeUnits));
	}

	/** Appends the run of ASCII from `start` straight from the input, and returns where it ends. */
	function pushAsciiRun(bytes, start, parts) {
		let end = start;
		while (end < bytes.length && bytes[end] < 0x80) end++;
		for (let s = start; s < end; s += CHUNK) {
			pushString(parts, bytes.subarray(s, Math.min(end, s + CHUNK)));
		}
		return end;
	}

	/**
	 * The Encoding Standard's UTF-8 decoder with replacement, from `start` to the end:
	 * each maximal invalid subpart becomes one U+FFFD, and so does a sequence the input
	 * ends inside. The bounds on the next continuation byte are what reject overlong
	 * forms, surrogates and code points above U+10FFFF.
	 */
	function pushDecoded(bytes, start, parts) {
		let pos = 0;
		let codePoint = 0;
		let needed = 0;
		let seen = 0;
		let lower = 0x80;
		let upper = 0xBF;
		let i = start;
		while (i < bytes.length) {
			if (pos >= CHUNK) {
				pushString(parts, units.subarray(0, pos));
				pos = 0;
			}
			const byte = bytes[i];
			if (needed === 0) {
				i++;
				if (byte < 0x80) {
					units[pos++] = byte;
				} else if (byte >= 0xC2 && byte <= 0xDF) {
					needed = 1;
					codePoint = byte & 0x1F;
				} else if (byte >= 0xE0 && byte <= 0xEF) {
					if (byte === 0xE0) lower = 0xA0;
					else if (byte === 0xED) upper = 0x9F;
					needed = 2;
					codePoint = byte & 0x0F;
				} else if (byte >= 0xF0 && byte <= 0xF4) {
					if (byte === 0xF0) lower = 0x90;
					else if (byte === 0xF4) upper = 0x8F;
					needed = 3;
					codePoint = byte & 0x07;
				} else {
					units[pos++] = 0xFFFD;
				}
			} else if (byte < lower || byte > upper) {
				// The bytes so far are one invalid subpart. This byte is not consumed: it is
				// read again as the start of whatever follows.
				units[pos++] = 0xFFFD;
				needed = 0;
				seen = 0;
				lower = 0x80;
				upper = 0xBF;
			} else {
				i++;
				lower = 0x80;
				upper = 0xBF;
				codePoint = (codePoint << 6) | (byte & 0x3F);
				if (++seen === needed) {
					if (codePoint > 0xFFFF) {
						codePoint -= 0x10000;
						units[pos++] = 0xD800 + (codePoint >> 10);
						units[pos++] = 0xDC00 + (codePoint & 0x3FF);
					} else {
						units[pos++] = codePoint;
					}
					needed = 0;
					seen = 0;
				}
			}
		}
		if (needed !== 0) units[pos++] = 0xFFFD;
		if (pos > 0) pushString(parts, units.subarray(0, pos));
	}

	function decodeUtf8(bytes, ignoreBOM) {
		const start = !ignoreBOM && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0;
		const parts = [];
		const asciiEnd = pushAsciiRun(bytes, start, parts);
		if (asciiEnd < bytes.length) pushDecoded(bytes, asciiEnd, parts);
		return parts.length === 1 ? parts[0] : parts.join('');
	}

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
			return decodeUtf8(bytes, this.ignoreBOM);
		}
	}
	globalThis.TextDecoder = TextDecoderPolyfill;
	markPolyfilled('TextDecoder');
}

// ── structuredClone ─────────────────────────────────────────────────────────
// Not yet supported by Hermes.
// Required by: @optimystic/db-core (transform tracker, cache-source, coordinator), which
// clones each block it reads or updates.
//
// The JSON-shaped values db-core clones are copied directly, following the HTML
// structured-clone algorithm for the types `cloneValue` lists: shared references and
// cycles are kept, and objects come back as plain objects carrying their own enumerable
// string keys. A graph holding any other value goes, whole, to @ungap/structured-clone,
// whose serialize-then-deserialize covers more types but is several times slower
// (gotchoices/sereus#51).

if (typeof globalThis.structuredClone !== 'function') {
	// Loaded before globalThis.structuredClone is assigned: ungap's default export calls
	// the global structuredClone when one exists at load time, which would be this one.
	const ungapClone = require('@ungap/structured-clone').default;
	const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
	/** What the copiers return when the graph holds a value they do not copy. */
	const UNSUPPORTED = Symbol('structuredClone: unsupported');

	/**
	 * A copy of `value`, or UNSUPPORTED. `memo` maps each source object already met to its
	 * copy, which keeps shared references shared and closes cycles.
	 */
	function cloneValue(value, memo) {
		if (typeof value !== 'object' || value === null) {
			return typeof value === 'function' || typeof value === 'symbol' ? UNSUPPORTED : value;
		}
		const prior = memo.get(value);
		if (prior !== undefined) return prior;
		// Exact prototypes only, so a subclass instance (a class, a Node Buffer) is not copied here.
		const proto = Object.getPrototypeOf(value);
		if (proto === Object.prototype || proto === null) return clonePlainObject(value, memo);
		if (proto === Array.prototype) return cloneArray(value, memo);
		if (Object.getPrototypeOf(proto) === TypedArrayPrototype) {
			return cloneView(value, proto.constructor, value.length, memo);
		}
		if (proto === ArrayBuffer.prototype) return remember(memo, value, value.slice(0));
		if (proto === DataView.prototype) return cloneView(value, DataView, value.byteLength, memo);
		if (proto === Date.prototype) return remember(memo, value, new Date(value.getTime()));
		if (proto === RegExp.prototype) return remember(memo, value, new RegExp(value.source, value.flags));
		if (proto === Map.prototype) return cloneMap(value, memo);
		if (proto === Set.prototype) return cloneSet(value, memo);
		return UNSUPPORTED;
	}

	function remember(memo, source, copy) {
		memo.set(source, copy);
		return copy;
	}

	function clonePlainObject(source, memo) {
		const copy = remember(memo, source, {});
		const keys = Object.keys(source);
		for (let k = 0; k < keys.length; k++) {
			const key = keys[k];
			const value = cloneValue(source[key], memo);
			if (value === UNSUPPORTED) return UNSUPPORTED;
			if (key === '__proto__') {
				// Assigning would set the copy's prototype; the algorithm makes an own property,
				// which is also what JSON.parse makes of this key.
				Object.defineProperty(copy, key, { value, writable: true, enumerable: true, configurable: true });
			} else {
				copy[key] = value;
			}
		}
		return copy;
	}

	// NOTE: copies indices only. The algorithm also copies an array's other own enumerable
	// properties (`arr.label = …`); no caller sets any, and ungap dropped them too. If one
	// ever does, iterate Object.keys here instead.
	function cloneArray(source, memo) {
		const length = source.length;
		const copy = remember(memo, source, new Array(length));
		for (let k = 0; k < length; k++) {
			if (!(k in source)) continue; // a hole stays a hole
			const value = cloneValue(source[k], memo);
			if (value === UNSUPPORTED) return UNSUPPORTED;
			copy[k] = value;
		}
		return copy;
	}

	/** A typed array or DataView, over a copy of its buffer made once however many views share it. */
	function cloneView(source, View, size, memo) {
		const buffer = cloneValue(source.buffer, memo);
		if (buffer === UNSUPPORTED) return UNSUPPORTED;
		return remember(memo, source, new View(buffer, source.byteOffset, size));
	}

	function cloneMap(source, memo) {
		const copy = remember(memo, source, new Map());
		for (const [key, value] of source) {
			const keyCopy = cloneValue(key, memo);
			if (keyCopy === UNSUPPORTED) return UNSUPPORTED;
			const valueCopy = cloneValue(value, memo);
			if (valueCopy === UNSUPPORTED) return UNSUPPORTED;
			copy.set(keyCopy, valueCopy);
		}
		return copy;
	}

	function cloneSet(source, memo) {
		const copy = remember(memo, source, new Set());
		for (const value of source) {
			const valueCopy = cloneValue(value, memo);
			if (valueCopy === UNSUPPORTED) return UNSUPPORTED;
			copy.add(valueCopy);
		}
		return copy;
	}

	// NOTE: a graph that gives up pays for the partial walk and then for ungap. db-core's
	// blocks are plain data, so nothing hot gives up today; if a profile shows a caller that
	// does, give that type a copier rather than detecting it up front.
	globalThis.structuredClone = function structuredClone(value, options) {
		// A call with options (a transfer list, which neither path honours) is left exactly
		// as it was: ungap, with the options dropped.
		if (options === undefined) {
			const copy = cloneValue(value, new Map());
			if (copy !== UNSUPPORTED) return copy;
		}
		return ungapClone(value);
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

// ── DOMException ────────────────────────────────────────────────────────────
// Hermes has none: the boot audit on a device (Expo SDK 53 dev client, 2026-09-16) found
// `typeof DOMException === 'undefined'`.
// Required by: p-timeout 7 (via p-queue, p-event), which constructs one unchecked and
// would otherwise throw `ReferenceError: DOMException is not defined`; `abortReason`
// below. Modules that feature-detect the global (react-native-webrtc's event-target-shim,
// whatwg-fetch, expo/virtual/streams.js) only change which class they use — see
// docs/reference-app-rn.md § The web APIs the phone's connectivity depends on.
//
// A named Error subclass rather than the `domexception` npm package, a full WebIDL
// implementation that drags in webidl-conversions. It covers `name`, `message`, the
// legacy `code` and `instanceof Error`; it has no static code constants
// (`DOMException.ABORT_ERR`), and structuredClone copies it as a plain `Error`.

if (typeof globalThis.DOMException === 'undefined') {
	/** The DOM's legacy numeric codes, by error name; names not listed have code 0. */
	const LEGACY_CODES = {
		IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5,
		NoModificationAllowedError: 7, NotFoundError: 8, NotSupportedError: 9, InUseAttributeError: 10,
		InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13, NamespaceError: 14,
		InvalidAccessError: 15, TypeMismatchError: 17, SecurityError: 18, NetworkError: 19,
		AbortError: 20, URLMismatchError: 21, QuotaExceededError: 22, TimeoutError: 23,
		InvalidNodeTypeError: 24, DataCloneError: 25,
	};
	// Named `DOMException`, as the real constructor is: web-streams-polyfill, for one, only
	// adopts a global DOMException whose constructor `name` says so.
	// NOTE: Metro's Babel lowers this through `_wrapNativeSuper`; that form was checked in Node
	// only, and the spec evaluates the unlowered source. If the device audit ever shows a
	// wrong `instanceof` or `name`, compile hermes.js in the reference app's metro-babel
	// test project.
	class DOMException extends Error {
		constructor(message = '', name = 'Error') {
			super(message);
			// An own property: callers branch on `err.name`, and Error.prototype.toString
			// reads it to print `AbortError: …`.
			this.name = String(name);
		}
		get code() {
			return LEGACY_CODES[this.name] ?? 0;
		}
	}
	globalThis.DOMException = DOMException;
	markPolyfilled('DOMException');
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
// The abort reasons are `DOMException`s, which the arm above supplies on Hermes. The
// fallback to a plain Error carrying the spec's `name` (what callers branch on) only
// matters if that arm is ever removed. It reads `globalThis.DOMException` rather than
// the bare name so test/polyfills/hermes-polyfills.spec.ts, which injects the bare name
// as `undefined`, sees what the arm above installed; in a bundle the two are the same.

function abortReason(message, name) {
	try {
		return new globalThis.DOMException(message, name);
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
// long-lived signal with a short-lived one — `p-wait-for` (shipped code reaches it only
// through @libp2p/webrtc's private-to-public listener; libp2p, @libp2p/websockets,
// @libp2p/circuit-relay-v2 and @libp2p/tcp list it as a devDependency, so it is absent from
// their dist) pairs the caller's signal with an `AbortSignal.timeout`, which always fires.
//
// NOTE: a combination whose inputs ALL fail to abort keeps its listeners for as long as
// the inputs live: the DOM holds dependent signals weakly, and Hermes gives this no hook
// to do the same. No caller does that today — `p-wait-for` is the only dependency that
// calls `AbortSignal.any`, and it always pairs with an `AbortSignal.timeout`. If one ever
// does, fix it at that call site — an explicit combination it can release, as optimystic's
// repo client and quereus's `combineAbortSignals` do — not here: this has no way to learn
// a combination is finished. First-party source is kept off `AbortSignal.any` by
// `PHONE_RUNTIME_GUARD` in eslint.config.mjs.

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
