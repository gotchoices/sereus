/**
 * `Intl.DateTimeFormat` (+ `Locale` / `getCanonicalLocales` / `NumberFormat`)
 * polyfill, with full IANA timezone data.
 *
 * NativeScript's Android V8 is compiled with `v8_enable_i18n_support=false`
 * (see NativeScript/android-v8 → scripts/build.android.sh), so the entire `Intl`
 * namespace ships without DateTimeFormat/NumberFormat/Locale — there is NO
 * app-level gradle/runtime toggle to enable it (unlike RN, whose Hermes bridges
 * to Android's native ICU). Quereus's `temporal-polyfill` captures
 * `Intl.DateTimeFormat` at module scope (`RawDateTimeFormat = Intl.DateTimeFormat`,
 * then `new RawDateTimeFormat(...)`), and Quereus relies on `Temporal.ZonedDateTime`
 * with real named zones — so a UTC-only stub would silently corrupt results.
 * Use the official @formatjs polyfills (ICU-equivalent), loaded in dependency
 * order with all-tz + `en` locale data, before the cadre/Quereus graph evaluates.
 *
 * Must be imported AFTER ./intl-pluralrules (which creates the `Intl` namespace
 * object these polyfills extend) and before any cadre/libp2p/Quereus code.
 */

// Explicit `.js` suffixes: @formatjs's package `exports` map only lists the
// subpaths with extensions (e.g. `./polyfill.js`, `./add-all-tz.js`), so the
// bare specifiers don't resolve under our `conditionNames`.
import '@formatjs/intl-getcanonicallocales/polyfill.js';
import '@formatjs/intl-locale/polyfill.js';
import '@formatjs/intl-numberformat/polyfill.js';
import '@formatjs/intl-numberformat/locale-data/en.js';
import '@formatjs/intl-datetimeformat/polyfill.js';
import '@formatjs/intl-datetimeformat/add-all-tz.js';
import '@formatjs/intl-datetimeformat/locale-data/en.js';

import { markPolyfilled } from './registry';

// The @formatjs DateTimeFormat polyfill cannot detect the host's local zone and
// defaults the "system" timezone to UTC. On Android, NativeScript exposes the
// platform SDK as globals, so read the real default zone and register it — this
// makes `new Intl.DateTimeFormat().resolvedOptions().timeZone` (and hence
// temporal-polyfill's `Temporal.Now` system zone) correct. Named zones already
// work via add-all-tz; this only fixes the *implicit local* zone. Best-effort:
// any other platform (iOS, web) simply stays UTC.
interface JavaTimeZone {
	getID(): string;
}
interface AndroidJavaGlobal {
	util?: { TimeZone?: { getDefault(): JavaTimeZone } };
}

function detectAndroidTimeZone(): string | undefined {
	try {
		const java = (globalThis as { java?: AndroidJavaGlobal }).java;
		const id = java?.util?.TimeZone?.getDefault().getID();
		return typeof id === 'string' && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

const setDefaultTimeZone = (
	Intl.DateTimeFormat as unknown as { __setDefaultTimeZone?: (tz: string) => void }
).__setDefaultTimeZone;

if (typeof setDefaultTimeZone === 'function') {
	const tz = detectAndroidTimeZone();
	if (tz) setDefaultTimeZone(tz);
}

markPolyfilled('Intl.DateTimeFormat');
