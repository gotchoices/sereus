/**
 * Guards `polyfills/hermes.js` — the web APIs libp2p reads that the phone's runtime
 * does not provide.
 *
 * Nothing else in the repo fails if those patches are deleted. The failures they
 * prevent are phone-only, and the worst of them is silent: `@libp2p/websockets` reads
 * `websocket.bufferedAmount` before every write, React Native's WebSocket defines it
 * neither on the instance nor on the prototype, and `undefined < 4194304` is `false` —
 * so the transport concludes the socket is full, waits for a drain event that can never
 * arrive, and the dial dies ten seconds later as `AbortError: The operation was
 * aborted` with nothing pointing at the cause. A device session on 2026-09-16 spent
 * hours arriving at that. This spec reproduces it in Node in milliseconds.
 *
 * ## How the polyfill is evaluated
 *
 * It cannot simply be imported: it `require`s `react-native-get-random-values` (which
 * pulls `react-native` at module scope), it reads `__DEV__` (a Metro prelude global),
 * and it assigns to bare `Promise`, `AbortSignal` and `Symbol` — importing it in-process
 * would patch this runner's own globals and every assertion below would prove nothing.
 *
 * So it is read as text and evaluated in a controlled scope, the way
 * test/metro-babel/async-generator-cleanup.spec.ts builds its probe: a `new Function`
 * whose parameters supply every free name the file reads. `globalThis` is a fake surface
 * that looks like Hermes plus React Native's startup, and `setTimeout` and friends are
 * forwarders onto that object rather than fixed bindings — the polyfill replaces
 * `globalThis.setTimeout` at the bottom of the file and then calls the bare identifier
 * from `AbortSignal.timeout`, which in a real bundle resolves to the replacement, and
 * here has to as well.
 *
 * `AbortController` / `AbortSignal` are the real ones the phone gets: React Native's
 * `Libraries/Core/setUpXHR.js` installs `abort-controller@3.0.0` over whatever the
 * engine had, so this requires that same module and injects it. Evaluating the polyfill
 * patches those classes — which is the point — and that mutation is visible to anything
 * else in this Vitest worker that requires `abort-controller`. Nothing else does.
 *
 * `DOMException` is injected as `undefined` and left off the fake `globalThis`, because
 * Hermes has none (a device boot audit confirmed it on 2026-09-16). The polyfill installs
 * its stand-in on `globalThis`, and `abortReason` reads it from there, so abort reasons
 * are that stand-in exactly as on the phone. The bare `DOMException` identifier stays
 * `undefined` inside the evaluated source; in a real bundle it and `globalThis.DOMException`
 * are the same binding.
 *
 * Its own Vitest project (`polyfills`) with no `globalSetup`: it runs none of the `node`
 * project's stale-build guard over sibling `dist` output, so `vitest run --project
 * polyfills` stays runnable while a sibling is unbuilt.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appDir, resolvePackageDir } from './metro-resolution';

// ── Shapes of the injected and imported values ──────────────────────────────

/** The part of an AbortSignal these assertions touch. */
interface SignalLike {
	readonly aborted: boolean;
	readonly reason?: { name?: string; message?: string; code?: number };
	addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
	removeEventListener(type: string, listener: () => void): void;
	throwIfAborted?(): void;
}

interface ControllerLike {
	readonly signal: SignalLike;
	abort(reason?: unknown): void;
}

interface AbortControllerCtor {
	new(): ControllerLike;
}

/** The statics the polyfill installs, plus the prototype it patches. */
interface AbortSignalCtor {
	prototype: SignalLike;
	timeout?(ms: number): SignalLike;
	any?(signals: Iterable<SignalLike>): SignalLike;
}

/** The `DOMException` stand-in, as far as callers use it. */
interface DOMExceptionLike extends Error {
	readonly code: number;
}

interface DOMExceptionCtor {
	new(message?: string, name?: string): DOMExceptionLike;
}

/** `crypto.subtle` as the polyfill builds it — digest only. */
interface SubtleLike {
	digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

/** `@libp2p/websockets`' `sendData` contract; `canSendMore: false` is the outage. */
interface SendResult {
	sentBytes: number;
	canSendMore: boolean;
}

interface MultiaddrConnectionLike {
	sendData(data: Iterable<Uint8Array> & { byteLength: number }): SendResult;
}

type WebSocketToMaConn = (init: {
	websocket: unknown;
	remoteAddr: unknown;
	log: unknown;
}) => MultiaddrConnectionLike;

type ModuleRequire = (id: string) => unknown;

// ── The fake runtime ────────────────────────────────────────────────────────

/**
 * React Native's WebSocket, reduced to what `webSocketToMaConn` touches — and, the
 * point of the whole exercise, with no `bufferedAmount` on the instance or the
 * prototype (verified against `react-native/Libraries/WebSocket/WebSocket.js`, which
 * defines neither).
 *
 * A factory, not a class declaration, because the polyfill patches
 * `globalThis.WebSocket.prototype` in place: the control case needs a class that was
 * never handed to it.
 */
function makeReactNativeWebSocketClass() {
	return class ReactNativeWebSocket {
		readonly sent: Uint8Array[] = [];
		addEventListener(_type: string, _listener: (evt: unknown) => void): void {
			// The connection registers 'close' and 'message'; nothing here dispatches.
		}

		removeEventListener(_type: string, _listener: (evt: unknown) => void): void {
			// Present because the connection may detach on close.
		}

		send(data: Uint8Array): void {
			this.sent.push(data);
		}

		close(_code?: number): void {
			// Nothing to tear down.
		}
	};
}

type WebSocketCtor = ReturnType<typeof makeReactNativeWebSocketClass>;

/** ES2024's `Promise.withResolvers`, taken away again — Hermes does not have it. */
function makeHermesPromiseClass(): PromiseConstructor {
	class HermesPromise<T> extends Promise<T> { }
	Object.defineProperty(HermesPromise, 'withResolvers', {
		value: undefined,
		writable: true,
		configurable: true,
	});
	return HermesPromise as unknown as PromiseConstructor;
}

/** What one evaluation of the polyfill produced, for the assertions to read. */
interface PolyfillRun {
	globals: Record<string, unknown>;
	WebSocket: WebSocketCtor;
	AbortController: AbortControllerCtor;
	AbortSignal: AbortSignalCtor;
	Promise: PromiseConstructor;
	env: Record<string, string | undefined>;
	/** registry keys the polyfill reported through `markPolyfilled`. */
	marked: string[];
}

const appRequire = createRequire(join(appDir, 'package.json'));

/**
 * Evaluates `polyfills/hermes.js` against a fresh fake runtime and returns it.
 *
 * `require` is the app's own, so the polyfill loads the same `@ungap/structured-clone`,
 * `web-streams-polyfill` and `@noble/hashes` a bundle would — with two substitutions:
 * `react-native-get-random-values` (a native module, absent in Node) becomes an empty
 * object, and `./registry` records what was marked instead of accumulating into the
 * real module.
 */
function evaluatePolyfill(): PolyfillRun {
	const source = readFileSync(join(appDir, 'polyfills', 'hermes.js'), 'utf8');
	const marked: string[] = [];
	const abortControllerModule = appRequire('abort-controller/dist/abort-controller') as {
		AbortController: AbortControllerCtor;
		AbortSignal: AbortSignalCtor;
	};
	const WebSocket = makeReactNativeWebSocketClass();
	const HermesPromise = makeHermesPromiseClass();
	const env: Record<string, string | undefined> = {};

	// React Native's surface as the entry module sees it: TextEncoder but no
	// TextDecoder, no structuredClone, no web streams, a WebSocket without
	// bufferedAmount, `crypto` carrying only what react-native-get-random-values
	// installed, and timers that return numeric ids. Node's own timers return
	// objects that already have ref()/unref(), which the wrapper passes through
	// untouched, so they are coerced to their numeric id here — Node's clear
	// functions accept that id back.
	const globals: Record<string, unknown> = {
		WebSocket,
		TextEncoder,
		crypto: { getRandomValues: (array: Uint8Array) => array },
		setTimeout: (...args: Parameters<typeof setTimeout>) => Number(setTimeout(...args)),
		setInterval: (...args: Parameters<typeof setInterval>) => Number(setInterval(...args)),
		clearTimeout: (id: number) => clearTimeout(id),
		clearInterval: (id: number) => clearInterval(id),
	};

	const moduleRequire: ModuleRequire = (id) => {
		if (id === 'react-native-get-random-values') return {};
		if (id === './registry') {
			return {
				markPolyfilled: (name: string) => marked.push(name),
				wasPolyfilled: (name: string) => marked.includes(name),
			};
		}
		return appRequire(id);
	};

	const polyfillModule: { exports: Record<string, unknown> } = { exports: {} };
	const factory = new Function(
		'require', 'module', 'exports', 'globalThis',
		'Promise', 'AbortSignal', 'AbortController', 'Symbol', 'DOMException',
		'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
		'process', 'console', '__DEV__',
		source,
	) as (...args: unknown[]) => void;

	factory(
		moduleRequire, polyfillModule, polyfillModule.exports, globals,
		HermesPromise, abortControllerModule.AbortSignal, abortControllerModule.AbortController,
		Symbol, undefined,
		// Forwarders, not fixed bindings: the polyfill replaces globalThis.setTimeout at
		// the bottom of the file and then calls the bare identifier from
		// AbortSignal.timeout. On the phone that lookup finds the replacement.
		(...args: unknown[]) => (globals.setTimeout as (...a: unknown[]) => unknown)(...args),
		(...args: unknown[]) => (globals.setInterval as (...a: unknown[]) => unknown)(...args),
		(...args: unknown[]) => (globals.clearTimeout as (...a: unknown[]) => unknown)(...args),
		(...args: unknown[]) => (globals.clearInterval as (...a: unknown[]) => unknown)(...args),
		{ env }, console, true,
	);

	return {
		globals,
		WebSocket,
		AbortController: abortControllerModule.AbortController,
		AbortSignal: abortControllerModule.AbortSignal,
		Promise: HermesPromise,
		env,
		marked,
	};
}

/** `@libp2p/websockets` does not export this module, so it is read by path. */
async function loadWebSocketToMaConn(): Promise<WebSocketToMaConn> {
	const dir = resolvePackageDir('@libp2p/websockets');
	const file = join(dir, 'dist', 'src', 'websocket-to-conn.js');
	const module = await import(pathToFileURL(file).href) as { webSocketToMaConn: WebSocketToMaConn };
	return module.webSocketToMaConn;
}

/** `@libp2p/logger`'s shape, reduced to the three call sites the connection uses. */
function silentLogger(): unknown {
	const log = (): void => { };
	return Object.assign(log, { error: log, trace: log });
}

/** A `Uint8ArrayList` as `sendData` consumes it: iterable chunks plus a total length. */
function chunk(bytes: Uint8Array): Iterable<Uint8Array> & { byteLength: number } {
	return {
		byteLength: bytes.byteLength,
		*[Symbol.iterator]() {
			yield bytes;
		},
	};
}

/** Resolves when `signal` aborts, or rejects if it has not within `ms`. */
async function aborted(signal: SignalLike, ms: number): Promise<void> {
	if (signal.aborted) return;
	await new Promise<void>((resolve, reject) => {
		const deadline = setTimeout(() => reject(new Error(`signal did not abort within ${ms} ms`)), ms);
		signal.addEventListener('abort', () => {
			clearTimeout(deadline);
			resolve();
		}, { once: true });
	});
}

/**
 * Shadows a signal's listener methods with recording forwarders, so a test can see
 * whether `AbortSignal.any` took its listener back off.
 *
 * `{ once: true }` auto-removal does not route through `removeEventListener`, so this
 * only tells the truth about a signal that did NOT fire — which is the one that matters.
 */
function recordListeners(signal: SignalLike): Set<() => void> {
	const attached = new Set<() => void>();
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	Object.assign(signal, {
		addEventListener(type: string, listener: () => void, options?: { once?: boolean }) {
			if (type === 'abort') attached.add(listener);
			add(type, listener, options);
		},
		removeEventListener(type: string, listener: () => void) {
			if (type === 'abort') attached.delete(listener);
			remove(type, listener);
		},
	});
	return attached;
}

// ── Assertions ──────────────────────────────────────────────────────────────

/**
 * Every key the fake surface forces the polyfill to install. `Symbol.asyncIterator` is
 * deliberately not here: this runner's `Symbol` already has it, so that arm is skipped —
 * the only way to exercise it would be to inject a counterfeit `Symbol`, which is a
 * worse trade than leaving one arm to the boot audit on the device.
 */
const REQUIRED_MARKS = [
	'crypto.subtle.digest',
	'TextDecoder',
	'structuredClone',
	'ReadableStream',
	'Promise.withResolvers',
	'DOMException',
	'AbortSignal.reason',
	'AbortSignal.prototype.throwIfAborted',
	'AbortSignal.timeout',
	'AbortSignal.any',
	'WebSocket.prototype.bufferedAmount',
	'setTimeout.ref',
];

describe('polyfills/hermes.js under a fake Hermes + React Native runtime', () => {
	let run: PolyfillRun;

	beforeAll(() => {
		run = evaluatePolyfill();
	});

	it('installs every patch the runtime is missing', () => {
		expect(run.marked).toEqual(expect.arrayContaining(REQUIRED_MARKS));
	});

	it('enables the cadre timing debug namespace in development builds', () => {
		expect(run.env.DEBUG).toBe('sereus:cadre:timing');
	});

	describe('WebSocket.bufferedAmount — the 2026-09-16 dial outage', () => {
		let webSocketToMaConn: WebSocketToMaConn;

		beforeAll(async () => {
			webSocketToMaConn = await loadWebSocketToMaConn();
		});

		// A connection that believes its socket is full starts a repeating poll task
		// waiting for a drain. Under real timers that task outlives the test and keeps the
		// worker alive; the fake clock is never advanced and is discarded afterwards.
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		function connect(SocketClass: WebSocketCtor): { socket: InstanceType<WebSocketCtor>; result: SendResult } {
			const socket = new SocketClass();
			const conn = webSocketToMaConn({
				websocket: socket,
				remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/4002/ws' },
				log: silentLogger(),
			});
			return { socket, result: conn.sendData(chunk(new Uint8Array([1, 2, 3]))) };
		}

		it('lets @libp2p/websockets keep sending', () => {
			const { socket, result } = connect(run.WebSocket);
			expect(result).toEqual({ sentBytes: 3, canSendMore: true });
			expect(socket.sent).toHaveLength(1);
		});

		it('without the getter the same connection stalls — which is what the phone did', () => {
			// The control: a WebSocket class the polyfill never saw. If this ever reports
			// canSendMore: true, the assertion above has stopped proving anything, either
			// because @libp2p/websockets changed how it reads the property or because
			// React Native started providing it.
			const { result } = connect(makeReactNativeWebSocketClass());
			expect(result.canSendMore).toBe(false);
		});

		it('reports zero buffered bytes on an instance', () => {
			// The getter lands on the prototype at runtime, so the class type does not carry it.
			const socket = new run.WebSocket() as unknown as { bufferedAmount: number };
			expect(socket.bufferedAmount).toBe(0);
		});
	});

	describe('AbortSignal.timeout', () => {
		it('aborts within its deadline, with a TimeoutError reason', async () => {
			const signal = run.AbortSignal.timeout!(20);
			expect(signal.aborted).toBe(false);
			await aborted(signal, 2_000);
			expect(signal.reason?.name).toBe('TimeoutError');
		});

		it('throwIfAborted rethrows that reason rather than a generic AbortError', async () => {
			const signal = run.AbortSignal.timeout!(20);
			await aborted(signal, 2_000);
			expect(() => signal.throwIfAborted!()).toThrow(
				expect.objectContaining({ name: 'TimeoutError' }),
			);
		});
	});

	describe('AbortSignal.any', () => {
		it('aborts with the reason of the input that fired', () => {
			const first = new run.AbortController();
			const second = new run.AbortController();
			const combined = run.AbortSignal.any!([first.signal, second.signal]);
			expect(combined.aborted).toBe(false);

			const reason = new Error('remote block request deadline');
			first.abort(reason);
			expect(combined.aborted).toBe(true);
			expect(combined.reason?.message).toBe('remote block request deadline');
		});

		it('returns an already-aborted signal when an input is already aborted', () => {
			const already = new run.AbortController();
			already.abort(new Error('shutting down'));
			const fresh = new run.AbortController();

			const combined = run.AbortSignal.any!([already.signal, fresh.signal]);
			expect(combined.aborted).toBe(true);
			expect(combined.reason?.message).toBe('shutting down');
		});

		it('detaches from the inputs that did not fire', () => {
			// The leak this guards: Optimystic's repo client combines a long-lived caller
			// signal with a fresh per-request deadline on every remote block RPC, and
			// `p-wait-for` does the same. `{ once: true }` only removes the listener that
			// actually fired, so without the detach one listener per call accumulates on
			// the long-lived signal for as long as the phone runs.
			const longLived = new run.AbortController();
			const perRequest = new run.AbortController();
			const onLongLived = recordListeners(longLived.signal);

			run.AbortSignal.any!([longLived.signal, perRequest.signal]);
			expect(onLongLived.size).toBe(1);

			perRequest.abort(new Error('request finished'));
			expect(onLongLived.size).toBe(0);
		});

		it('registers nothing when an input is already aborted', () => {
			const already = new run.AbortController();
			already.abort(new Error('shutting down'));
			const longLived = new run.AbortController();
			const onLongLived = recordListeners(longLived.signal);

			run.AbortSignal.any!([already.signal, longLived.signal]);
			expect(onLongLived.size).toBe(0);
		});
	});

	it('carries abort reasons, which React Native\'s AbortController drops', () => {
		// abort-controller@3.0.0 — what Libraries/Core/setUpXHR.js installs — predates the
		// DOM's `reason`: its abort() takes no argument. Without the patch every
		// controller.abort(err) in libp2p loses its error, which is why a failed dial
		// reported only "AbortError: The operation was aborted".
		const controller = new run.AbortController();
		controller.abort(new Error('dial cancelled by caller'));
		expect(controller.signal.reason?.message).toBe('dial cancelled by caller');
	});

	it('defaults a bare abort() to a named AbortError', () => {
		const controller = new run.AbortController();
		controller.abort();
		expect(controller.signal.reason?.name).toBe('AbortError');
	});

	describe('DOMException, which Hermes does not have', () => {
		let DOMExceptionPolyfill: DOMExceptionCtor;

		beforeAll(() => {
			DOMExceptionPolyfill = run.globals.DOMException as DOMExceptionCtor;
		});

		it('is installed on globalThis', () => {
			expect(typeof DOMExceptionPolyfill).toBe('function');
			// web-streams-polyfill only adopts a global DOMException whose constructor is
			// named 'DOMException', as the real one is.
			expect(DOMExceptionPolyfill.name).toBe('DOMException');
		});

		it('is what a bare abort() aborts with', () => {
			const controller = new run.AbortController();
			controller.abort();
			const reason = controller.signal.reason;
			expect(reason).toBeInstanceOf(DOMExceptionPolyfill);
			expect(reason).toBeInstanceOf(Error);
			expect(reason).toMatchObject({ name: 'AbortError', message: 'The operation was aborted.', code: 20 });
			expect(String(reason)).toBe('AbortError: The operation was aborted.');
		});

		it('is what AbortSignal.timeout aborts with', async () => {
			const signal = run.AbortSignal.timeout!(20);
			await aborted(signal, 2_000);
			expect(signal.reason).toBeInstanceOf(DOMExceptionPolyfill);
			expect(signal.reason).toMatchObject({ name: 'TimeoutError', code: 23 });
		});

		it('takes the spec\'s defaults, and code 0 for a name outside the legacy table', () => {
			// whatwg-fetch probes the global with exactly this argument-less construction.
			expect(new DOMExceptionPolyfill()).toMatchObject({ name: 'Error', message: '', code: 0 });
			expect(new DOMExceptionPolyfill('no such key', 'NotReadableError').code).toBe(0);
			// react-native-webrtc's event-target-shim raises this one.
			expect(new DOMExceptionPolyfill('already dispatching', 'InvalidStateError').code).toBe(11);
		});
	});

	it('digests through @noble/hashes at the subpath Metro will resolve', async () => {
		// The `.js` in `require('@noble/hashes/sha2.js')` is load-bearing: @noble/hashes 2.x
		// lists only "./sha2.js" in its exports map, and Metro enforces it.
		const subtle = (run.globals.crypto as { subtle: SubtleLike }).subtle;
		const input = new TextEncoder().encode('abc');
		const digest = await subtle.digest('SHA-256', input);
		expect(Buffer.from(digest).toString('hex')).toBe(createHash('sha256').update(input).digest('hex'));
	});

	it('decodes UTF-8 without a TextDecoder', () => {
		const TextDecoderPolyfill = run.globals.TextDecoder as new () => { decode(input: Uint8Array): string };
		expect(new TextDecoderPolyfill().decode(new TextEncoder().encode('héllo'))).toBe('héllo');
	});

	it('gives Promise.withResolvers back', async () => {
		const { promise, resolve } = run.Promise.withResolvers<string>();
		resolve('ok');
		await expect(promise).resolves.toBe('ok');
	});

	it('returns timer handles that answer to ref() and unref(), and clears them', async () => {
		const set = run.globals.setTimeout as (fn: () => void, ms: number) => { ref(): unknown; unref(): unknown };
		const clear = run.globals.clearTimeout as (handle: unknown) => void;
		let fired = false;
		const handle = set(() => { fired = true; }, 10);
		expect(typeof handle).toBe('object');
		expect(handle.unref()).toBe(handle);
		// The wrapper wraps a number; clearTimeout has to unwrap it again or React
		// Native's native clear silently does nothing.
		clear(handle);
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(fired).toBe(false);
	});
});
