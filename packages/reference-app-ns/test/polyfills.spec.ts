/**
 * Guards two NativeScript polyfills whose failures are phone-only:
 *
 * - `src/polyfills/websocket.ts` — `@valor/nativescript-websockets` never assigns
 *   `bufferedAmount`, and `@libp2p/websockets` stops sending when it reads
 *   `undefined`, so every outbound dial dies on the dial timeout.
 * - `src/polyfills/abort.ts` — `AbortSignal.any` must take its listeners back off
 *   long-lived inputs once the combined signal aborts.
 *
 * Node already has `AbortSignal`, and the polyfills only install over a missing
 * global, so each test removes the global, re-evaluates the module in a fresh
 * module registry, captures what it installed, and restores Node's own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Globals = Record<string, unknown>;
const g = globalThis as unknown as Globals;

function withoutGlobals(names: readonly string[]): () => void {
	const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(g, name)] as const);
	for (const name of names) delete g[name];
	return () => {
		for (const [name, descriptor] of saved) {
			delete g[name];
			if (descriptor) Object.defineProperty(g, name, descriptor);
		}
	};
}

describe('websocket polyfill', () => {
	class FakeWebSocket {}
	let restore: () => void;

	beforeEach(() => {
		restore = withoutGlobals(['WebSocket']);
		vi.resetModules();
		vi.doMock('@valor/nativescript-websockets', () => {
			g.WebSocket = FakeWebSocket;
			return {};
		});
	});

	afterEach(() => {
		vi.doUnmock('@valor/nativescript-websockets');
		delete (FakeWebSocket.prototype as unknown as Globals).bufferedAmount;
		restore();
	});

	it('patches bufferedAmount after the plugin installs the global', async () => {
		await import('../src/polyfills/websocket');
		const { wasPolyfilled } = await import('../src/polyfills/registry');
		expect((new FakeWebSocket() as unknown as { bufferedAmount: unknown }).bufferedAmount).toBe(0);
		expect(wasPolyfilled('WebSocket.prototype.bufferedAmount')).toBe(true);
	});

	it('leaves an existing bufferedAmount alone', async () => {
		Object.defineProperty(FakeWebSocket.prototype, 'bufferedAmount', { value: 7, configurable: true });
		await import('../src/polyfills/websocket');
		const { wasPolyfilled } = await import('../src/polyfills/registry');
		expect((new FakeWebSocket() as unknown as { bufferedAmount: unknown }).bufferedAmount).toBe(7);
		expect(wasPolyfilled('WebSocket.prototype.bufferedAmount')).toBe(false);
	});
});

describe('abort polyfill — AbortSignal.any', () => {
	const nativeController = globalThis.AbortController;
	let Controller: typeof AbortController;
	let Signal: typeof AbortSignal;
	let restore: () => void;

	beforeEach(async () => {
		restore = withoutGlobals(['AbortController', 'AbortSignal']);
		vi.resetModules();
		await import('../src/polyfills/abort');
		Controller = g.AbortController as typeof AbortController;
		Signal = g.AbortSignal as typeof AbortSignal;
	});

	afterEach(() => restore());

	it('installs the polyfill over a missing global', () => {
		expect(Controller).not.toBe(nativeController);
		expect(new Controller().signal).toBeInstanceOf(Signal);
	});

	it('aborts with the reason of the input that fired', () => {
		const first = new Controller();
		const second = new Controller();
		const combined = Signal.any([first.signal, second.signal]);
		second.abort('second');
		expect(combined.aborted).toBe(true);
		expect(combined.reason).toBe('second');
		first.abort('first');
		expect(combined.reason).toBe('second');
	});

	it('detaches from the inputs that did not fire', () => {
		const longLived = new Controller();
		const perRequest = new Controller();
		const remove = vi.spyOn(longLived.signal, 'removeEventListener');
		Signal.any([longLived.signal, perRequest.signal]);
		perRequest.abort();
		expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
	});

	it('detaches both registrations when the same signal appears twice', () => {
		const repeated = new Controller();
		const other = new Controller();
		const add = vi.spyOn(repeated.signal, 'addEventListener');
		const remove = vi.spyOn(repeated.signal, 'removeEventListener');
		Signal.any([repeated.signal, repeated.signal, other.signal]);
		other.abort();
		expect(add).toHaveBeenCalledTimes(2);
		expect(remove).toHaveBeenCalledTimes(2);
	});

	it('registers nothing when an input is already aborted', () => {
		const already = new Controller();
		already.abort('done');
		const longLived = new Controller();
		const add = vi.spyOn(longLived.signal, 'addEventListener');
		const combined = Signal.any([already.signal, longLived.signal]);
		expect(combined.aborted).toBe(true);
		expect(combined.reason).toBe('done');
		expect(add).not.toHaveBeenCalled();
	});
});
