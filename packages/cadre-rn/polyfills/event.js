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

const { markPolyfilled } = require('./registry');

// The package installs EventTarget only where the runtime has none, and records nothing
// itself, so the check has to happen before it loads — hence `require`, which runs in
// place, rather than a hoisted `import`. Neither Hermes nor React Native 0.79 / Expo 53
// provides EventTarget, so on the phone the audit should read `polyfilled`.
const hadEventTarget = typeof globalThis.EventTarget !== 'undefined';
require('event-target-polyfill');
if (!hadEventTarget) markPolyfilled('EventTarget');

if (typeof globalThis.CustomEvent === 'undefined') {
	globalThis.CustomEvent = class CustomEvent extends Event {
		constructor(type, params) {
			super(type, params);
			this.detail = params?.detail ?? null;
		}
	};
	markPolyfilled('CustomEvent');
}
