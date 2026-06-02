/**
 * Polyfill barrel — import this FIRST in app/app.ts, before
 * @valor/nativescript-websockets and any cadre/libp2p code.
 *
 * Order matters: the Buffer global and runtime shims (crypto.subtle.digest,
 * TextDecoder, structuredClone, streams, Promise.withResolvers, …) must exist
 * before libp2p's dependency graph evaluates at import time.
 *
 *   buffer-global  → globalThis.Buffer
 *   hermes         → crypto.subtle.digest, TextDecoder, structuredClone,
 *                    web streams, Promise.withResolvers, AbortSignal, timers
 *   intl-pluralrules → Intl.PluralRules (moat-maker)
 *   event          → EventTarget / Event / CustomEvent
 */

import './buffer-global';
import './hermes';
import './intl-pluralrules';
import './event';
