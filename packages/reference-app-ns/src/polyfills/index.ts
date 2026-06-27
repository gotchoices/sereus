/**
 * Polyfill barrel — import this FIRST in app/app.ts, before
 * @valor/nativescript-websockets and any cadre/libp2p code.
 *
 * Order matters: the `process` global, the Buffer global, and runtime shims
 * (crypto.subtle.digest, TextDecoder, structuredClone, streams,
 * Promise.withResolvers, …) must exist before libp2p's dependency graph evaluates
 * at import time. `abort` is last because it builds AbortSignal on the
 * EventTarget/Event that `event` installs.
 *
 *   process        → globalThis.process (env/nextTick — `debug` reads env at load)
 *   buffer-global  → globalThis.Buffer
 *   hermes         → crypto.subtle.digest, TextDecoder, structuredClone,
 *                    web streams, Promise.withResolvers, timers
 *   intl-pluralrules → Intl.PluralRules (moat-maker); also creates the Intl ns
 *   intl-datetimeformat → Intl.DateTimeFormat/NumberFormat/Locale + IANA tz data
 *                    (Quereus temporal-polyfill); needs the Intl ns above
 *   event          → EventTarget / Event / CustomEvent
 *   abort          → AbortController / AbortSignal (needs EventTarget/Event)
 *   broadcast-channel → BroadcastChannel (mortice peer-store write lock)
 */

import './process';
import './buffer-global';
import './hermes';
import './intl-pluralrules';
import './intl-datetimeformat';
import './event';
import './abort';
import './broadcast-channel';
