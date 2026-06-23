/**
 * Global `AbortController` / `AbortSignal` for the NativeScript runtime.
 *
 * Unlike Hermes (react-native) and browsers, the NativeScript V8/JSC runtime
 * ships NO global `AbortController`/`AbortSignal`. The at-boot audit confirms it:
 * `AbortSignal.prototype.throwIfAborted` reports MISSING because the base object
 * is absent — which is also why the RN-derived `throwIfAborted` patch in
 * hermes.ts (guarded on `typeof AbortSignal !== 'undefined'`) short-circuited.
 * libp2p, @libp2p/utils, circuit-relay-v2, it-pushable, any-signal, p-retry and
 * most of the cadre stack use AbortSignal pervasively, so provide a spec-faithful
 * implementation built on the (polyfilled) EventTarget/Event.
 *
 * MUST be imported AFTER ./event, which installs EventTarget + Event via
 * event-target-polyfill.
 */

import { markPolyfilled } from './registry';

/** `DOMException` is not guaranteed on NS either; fall back to a named Error. */
function abortError(message: string, name: string): Error {
	if (typeof DOMException !== 'undefined') return new DOMException(message, name);
	const err = new Error(message);
	err.name = name;
	return err;
}

// Module-private trigger so `_abort` is not exposed on the public AbortSignal API.
const ABORT = Symbol('abort');

class AbortSignalPolyfill extends EventTarget {
	aborted = false;
	reason: unknown = undefined;
	onabort: ((this: AbortSignal, ev: Event) => unknown) | null = null;

	throwIfAborted(): void {
		if (this.aborted) throw this.reason;
	}

	[ABORT](reason: unknown): void {
		if (this.aborted) return;
		this.aborted = true;
		this.reason = reason ?? abortError('signal is aborted without reason', 'AbortError');
		const event = new Event('abort');
		if (typeof this.onabort === 'function') {
			this.onabort.call(this as unknown as AbortSignal, event);
		}
		this.dispatchEvent(event);
	}

	static abort(reason?: unknown): AbortSignalPolyfill {
		const signal = new AbortSignalPolyfill();
		signal[ABORT](reason);
		return signal;
	}

	static timeout(ms: number): AbortSignalPolyfill {
		const signal = new AbortSignalPolyfill();
		setTimeout(() => signal[ABORT](abortError('signal timed out', 'TimeoutError')), ms);
		return signal;
	}

	static any(signals: Iterable<AbortSignalPolyfill>): AbortSignalPolyfill {
		const combined = new AbortSignalPolyfill();
		for (const source of signals) {
			if (source.aborted) {
				combined[ABORT](source.reason);
				break;
			}
			source.addEventListener('abort', () => combined[ABORT](source.reason), { once: true });
		}
		return combined;
	}
}

class AbortControllerPolyfill {
	readonly signal: AbortSignalPolyfill = new AbortSignalPolyfill();

	abort(reason?: unknown): void {
		this.signal[ABORT](reason);
	}
}

const g = globalThis as typeof globalThis & {
	AbortController?: typeof AbortController;
	AbortSignal?: typeof AbortSignal;
};

if (typeof g.AbortSignal === 'undefined' || typeof g.AbortController === 'undefined') {
	g.AbortSignal = AbortSignalPolyfill as unknown as typeof AbortSignal;
	g.AbortController = AbortControllerPolyfill as unknown as typeof AbortController;
	markPolyfilled('AbortController');
}
