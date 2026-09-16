/**
 * Global `WebSocket` for @libp2p/websockets, plus the `bufferedAmount` it needs.
 *
 * NativeScript has no native WebSocket; `@valor/nativescript-websockets` installs
 * one (`global.WebSocket = WebSocket`) when imported. Importing the plugin here,
 * rather than from app.ts, guarantees the global exists before the patch below
 * evaluates — a patch that ran first would silently no-op.
 */

import '@valor/nativescript-websockets';
import { markPolyfilled } from './registry';

// ── WebSocket.bufferedAmount ─────────────────────────────────────────────────
// The plugin declares `bufferedAmount?: number` on its `WebSocket` class
// (websocket.d.ts) but never assigns it — no `.js` in the installed package
// mentions the name — so at runtime it reads `undefined`. Required by
// @libp2p/websockets: `websocket-to-conn.js` gates sending on
// `websocket.bufferedAmount < maxBufferedAmount` — `undefined < n` is false, so it
// stops sending — then waits for a poll to see `bufferedAmount === 0`, which never
// happens. The socket opens, the handshake is never written, and every outbound
// dial dies on the dial timeout.
//
// Same gap fixed for React Native in packages/reference-app-rn/polyfills/hermes.js
// (commit 7a0fd6c); ported here from source inspection, not a device run.
//
// Reporting 0 is honest: the plugin hands each frame to the native socket on
// `send()` and keeps no JS-side queue, so nothing is ever pending from JS's view.

if (typeof globalThis.WebSocket === 'function'
	&& globalThis.WebSocket.prototype != null
	&& !('bufferedAmount' in globalThis.WebSocket.prototype)) {
	Object.defineProperty(globalThis.WebSocket.prototype, 'bufferedAmount', {
		get() { return 0; },
		configurable: true,
	});
	markPolyfilled('WebSocket.prototype.bufferedAmount');
}
