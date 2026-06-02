/**
 * `EventTarget` / `Event` / `CustomEvent` globals.
 *
 * libp2p (and its dependencies) rely on these Web APIs at import time. The
 * NativeScript runtime provides them only partially. `event-target-polyfill`
 * installs spec-complete `EventTarget` + `Event` (handling `once`, capture, and
 * AbortSignal-based removal) but does NOT include `CustomEvent`, which libp2p's
 * `safeDispatchEvent` uses internally — so add a minimal shim on top. Ported
 * from packages/reference-app-rn/polyfills/event.js.
 */

import 'event-target-polyfill';
import { markPolyfilled } from './registry';

if (typeof (globalThis as { CustomEvent?: unknown }).CustomEvent === 'undefined') {
	class CustomEventPolyfill<T = unknown> extends Event {
		readonly detail: T | null;
		constructor(type: string, params?: { detail?: T } & EventInit) {
			super(type, params);
			this.detail = params?.detail ?? null;
		}
	}
	(globalThis as { CustomEvent?: unknown }).CustomEvent =
		CustomEventPolyfill as unknown as typeof CustomEvent;
	markPolyfilled('CustomEvent');
}
