/**
 * Entry point. Polyfills and the global WebSocket MUST load before any
 * cadre/libp2p code — libp2p and its dependencies reference Web APIs at import
 * time. The heavy cadre/db-p2p graph is pulled in lazily by the Chat / Settings
 * pages (via cadre-vm → cadre-phone) on navigation, after the audit below runs.
 */

// Runtime globals (Buffer, crypto.subtle.digest, TextDecoder, streams, AbortSignal,
// WebSocket via @valor/nativescript-websockets, …).
import '../src/polyfills';

import { Application } from '@nativescript/core';
import { runPolyfillAudit } from '../src/polyfills/audit';

// Make the real V8/JSC surface visible (native vs polyfilled) before libp2p loads.
runPolyfillAudit();

Application.run({ moduleName: 'app-root' });

/*
Do not place any code after the application has been started as it will not
be executed on iOS.
*/
