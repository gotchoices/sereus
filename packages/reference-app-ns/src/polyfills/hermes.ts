/**
 * Runtime globals the libp2p / Optimystic stack expects, re-audited for the
 * NativeScript V8/JSC engine. Must be imported before any library code.
 *
 * NativeScript 8.8+ already provides `crypto.getRandomValues`, `crypto.randomUUID`,
 * `crypto.subtle.generateKey/sign/verify`, `btoa`/`atob`, and `TextEncoder` — so
 * those are NOT polyfilled here (unlike the RN/Hermes port). Every patch below is
 * guarded by a `typeof` check, so it no-ops where the runtime already has the API.
 *
 * Ported and trimmed from packages/cadre-rn/polyfills/hermes.js. See the
 * V8/JSC re-audit table in tickets/.../reference-app-ns-runtime.
 */

import { sha256, sha512 } from '@noble/hashes/sha2.js';
import structuredCloneImpl from '@ungap/structured-clone';
import * as webStreams from 'web-streams-polyfill';
import { markPolyfilled } from './registry';
import { TextDecoderPolyfill } from './text-decoder';

// ── crypto.subtle.digest ─────────────────────────────────────────────────────
// NativeScript 8.8 ships crypto.subtle with generateKey/sign/verify but NOT
// digest, which multiformats/hashes/sha2-browser requires. Add ONLY digest;
// preserve the native subtle and its other methods.

type DigestFn = (algorithm: AlgorithmIdentifier, data: BufferSource) => Promise<ArrayBuffer>;

function toBytes(data: BufferSource): Uint8Array {
	if (data instanceof Uint8Array) return data;
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	return new Uint8Array(data);
}

const digestFns: Record<string, (input: Uint8Array) => Uint8Array> = {
	'SHA-256': sha256,
	'SHA-512': sha512,
};

const digestShim: DigestFn = (algorithm, data) => {
	const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
	const fn = digestFns[name];
	if (!fn) return Promise.reject(new Error(`Unsupported digest algorithm: ${name}`));
	return Promise.resolve(fn(toBytes(data)).buffer as ArrayBuffer);
};

{
	const cryptoObj = globalThis.crypto as unknown as
		| { subtle?: { digest?: DigestFn } }
		| undefined;
	if (cryptoObj) {
		if (!cryptoObj.subtle) {
			cryptoObj.subtle = { digest: digestShim };
			markPolyfilled('crypto.subtle.digest');
		} else if (typeof cryptoObj.subtle.digest !== 'function') {
			cryptoObj.subtle.digest = digestShim;
			markPolyfilled('crypto.subtle.digest');
		}
	}
}

// ── TextDecoder (UTF-8 only) ─────────────────────────────────────────────────
// Not guaranteed on NativeScript V8/JSC. `uint8arrays` (pulled in by libp2p /
// multiformats / yamux) does `new TextDecoder('utf8')` at module scope, so
// without this yamux's default export resolves to undefined and start fails.
// The decoder itself is in ./text-decoder.

if (typeof globalThis.TextDecoder === 'undefined') {
	globalThis.TextDecoder = TextDecoderPolyfill as unknown as typeof TextDecoder;
	markPolyfilled('TextDecoder');
}

// ── structuredClone ──────────────────────────────────────────────────────────
// Required by @optimystic/db-core (transform tracker, cache-source, coordinator).
// NOTE: every clone goes through @ungap/structured-clone; cadre-rn's
// polyfills/hermes.js copies plain data directly because ungap was several times
// slower on Hermes (gotchoices/sereus#51). If a NativeScript profile shows ungap
// taking real time, port that path.

if (typeof globalThis.structuredClone !== 'function') {
	globalThis.structuredClone = (<T>(value: T): T =>
		structuredCloneImpl(value) as T) as typeof globalThis.structuredClone;
	markPolyfilled('structuredClone');
}

// ── Symbol.asyncIterator ─────────────────────────────────────────────────────
// Some engines omit this, breaking `for await...of` on custom iterables. Use the
// global registry so independent polyfills converge on the same symbol identity.

if (typeof Symbol !== 'undefined' && typeof Symbol.asyncIterator === 'undefined') {
	try {
		Object.defineProperty(Symbol, 'asyncIterator', {
			value: Symbol.for('Symbol.asyncIterator'),
			configurable: false,
			enumerable: false,
			writable: false,
		});
	} catch {
		(Symbol as { asyncIterator?: symbol }).asyncIterator = Symbol.for('Symbol.asyncIterator');
	}
	markPolyfilled('Symbol.asyncIterator');
}

// ── Web Streams API ──────────────────────────────────────────────────────────
// Not guaranteed on NativeScript V8/JSC; used by streaming-oriented libraries.

if (typeof globalThis.ReadableStream === 'undefined') {
	globalThis.ReadableStream = webStreams.ReadableStream as unknown as typeof ReadableStream;
	globalThis.WritableStream = webStreams.WritableStream as unknown as typeof WritableStream;
	globalThis.TransformStream = webStreams.TransformStream as unknown as typeof TransformStream;
	markPolyfilled('ReadableStream');
}

// ── Promise.withResolvers ────────────────────────────────────────────────────
// ES2024 — version-dependent on V8/JSC. Required by @libp2p/utils, yamux,
// it-queue, mortice, abort-error.

if (typeof Promise.withResolvers !== 'function') {
	Promise.withResolvers = function withResolvers<T>(): PromiseWithResolvers<T> {
		let resolve!: (value: T | PromiseLike<T>) => void;
		let reject!: (reason?: unknown) => void;
		const promise = new Promise<T>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	};
	markPolyfilled('Promise.withResolvers');
}

// AbortController / AbortSignal (and throwIfAborted) are provided in full by
// ./abort — the NativeScript V8/JSC runtime ships no base AbortSignal at all, so
// they cannot be patched onto an existing global the way Hermes/browsers allow.

// ── Timer .ref() / .unref() ──────────────────────────────────────────────────
// Node timers return objects with .ref()/.unref(); NativeScript returns numbers.
// Required by @optimystic/db-p2p (cluster-repo), undici, libp2p internals. Also
// patches clear{Timeout,Interval} to unwrap, since the native clears expect the
// raw numeric id. Ported from reference-app-web/src/polyfills.ts.

interface TimerHandle {
	_id: number;
	ref(): TimerHandle;
	unref(): TimerHandle;
	[Symbol.toPrimitive](): number;
}

function wrapTimer(id: number | TimerHandle): TimerHandle {
	if (typeof id === 'object' && id !== null) return id;
	return {
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
}

function unwrapTimer(handle: unknown): number | undefined {
	if (handle && typeof handle === 'object' && '_id' in (handle as TimerHandle)) {
		return (handle as TimerHandle)._id;
	}
	return handle as number | undefined;
}

{
	const _setTimeout = globalThis.setTimeout;
	const _setInterval = globalThis.setInterval;
	const _clearTimeout = globalThis.clearTimeout;
	const _clearInterval = globalThis.clearInterval;

	const probe = _setTimeout(() => undefined, 0);
	const needsWrap = !(
		probe &&
		typeof probe === 'object' &&
		typeof (probe as { unref?: unknown }).unref === 'function'
	);
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
		markPolyfilled('timers.ref/unref');
	}
}
