/**
 * EventTarget / Event / CustomEvent globals for Hermes.
 *
 * libp2p (and its dependencies) rely on these Web APIs at import time.
 *
 * Uses the `event-target-polyfill` npm package for EventTarget + Event — it
 * is more spec-complete than a hand-rolled minimal class (handles `once`,
 * capture options, and AbortSignal-based listener removal correctly).  The
 * package does not include CustomEvent, which libp2p's `safeDispatchEvent`
 * uses internally, so we add a minimal shim for it on top.
 */

import 'event-target-polyfill';
import { markPolyfilled } from './registry';

if (typeof globalThis.CustomEvent === 'undefined') {
	globalThis.CustomEvent = class CustomEvent extends Event {
		constructor(type, params) {
			super(type, params);
			this.detail = params?.detail ?? null;
		}
	};
	markPolyfilled('CustomEvent');
}
