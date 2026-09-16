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
		// NOTE: the timer always runs its full `ms` — only it can abort this signal, and no
		// API tells a signal its caller is finished. Nothing to clear on abort: the timer
		// firing is what caused the abort in the first place.
		setTimeout(() => signal[ABORT](abortError('signal timed out', 'TimeoutError')), ms);
		return signal;
	}

	// The listeners this attaches come back off the inputs once the combined signal
	// settles. A combination whose inputs never abort keeps its listeners for as long as
	// the inputs live — the DOM holds dependent signals weakly, and this runtime gives no
	// hook to do the same. Optimystic's repo client
	// (../optimystic/packages/db-p2p/src/repo/client.ts) hits this on every RPC that
	// succeeds — its deadline controller is cleared, not aborted — see backlog ticket
	// bug-abortsignal-any-leaks-listeners-on-hermes.
	static any(signals: Iterable<AbortSignalPolyfill>): AbortSignalPolyfill {
		const combined = new AbortSignalPolyfill();
		const list = Array.from(signals);
		// An input that has already aborted settles the result before anything is
		// registered, so there is nothing to detach.
		for (const source of list) {
			if (source.aborted) {
				combined[ABORT](source.reason);
				return combined;
			}
		}
		// Pairs, not a Map keyed by signal: the same signal may legitimately appear twice
		// in `signals`, and a Map would collapse the two registrations and leave one
		// attached.
		const attached: Array<[AbortSignalPolyfill, () => void]> = [];
		for (const source of list) {
			const listener = (): void => {
				if (combined.aborted) return;
				combined[ABORT](source.reason);
			};
			attached.push([source, listener]);
			source.addEventListener('abort', listener, { once: true });
		}
		combined.addEventListener('abort', () => {
			for (const [source, listener] of attached) {
				source.removeEventListener('abort', listener);
			}
			attached.length = 0;
		}, { once: true });
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
